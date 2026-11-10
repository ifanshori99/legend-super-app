// DP refund guard (bead legend-e7zj, tier K / money): a reservation DP that is
// seated on a table session credits the bill (RSV-02), and an admin refund
// (PAY-04) may only take the DP that is neither already applied by an order of
// that session nor already reserved by another refund.
//
// Real Express app, Better Auth, services and PostgreSQL. Seeds the same way as
// reservation-seating-db.test.ts (paid DP intent, seatReservation) and requests
// refunds over HTTP like payment-refund-review-fix.test.ts.
//
// Assumptions where the brief is not exact:
// - A "POS/QR order applies DP" is stood in for by inserting a live `orders`
//   row on the seated session with `deposit_applied_idr` (no menu/checkout
//   fixtures needed); the guard only reads those rows.
// - The refund cap is the DP intent's unused part: held after non-failed
//   refunds minus DP applied by non-voided orders. A refund above it answers
//   409 REFUND_DEPOSIT_IN_USE (case 1). Once the unused part is fully reserved,
//   case 2 only asserts "refused with 409", not the exact code.
// - A pending refund already lowers the session credit (case 3); a failed
//   refund releases it.
// - Race (case 4): the waits are observed in pg_locks (advisory, not granted,
//   blocked by the holder's pid, via pg_blocking_pids). Reverse order holds the
//   refund's transaction open with a temporary BEFORE INSERT trigger on
//   payment_refunds (restricted to this test's intent) that waits on an
//   advisory lock this test holds; dropped in a finally.
// - Tenant isolation (case 5): tenant B owns no reservations here; the check is
//   that tenant B's context sees credit 0 for tenant A's session, cannot refund
//   tenant A's intent (rejected, no row written), and tenant A is unchanged.
// - List (case 6): the refundable list shows refundableAmountIdr net of DP in
//   use, and paidAmountIdr (net of DP in use) = refunded + refundable.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createReservationInputSchema,
  seatReservationInputSchema,
} from "@starter/shared/reservation";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { createRefund } from "../services/payment-admin.service.ts";
import { createReservation } from "../services/reservation-booking.ts";
import {
  depositCreditForSession,
  seatReservation,
} from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import {
  setReservationDepositPort,
  type ReservationDepositPort,
} from "../services/reservation-ports.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers";
import { FakeRefundGateway } from "./refund-fake-gateway";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  dropFloorRows,
  dropIsolatedTenant,
  issueQr,
  owner,
  seededOutletA,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers";

const ADMIN = "/api/payments/admin";
const outletA = outletIdSchema.parse(seededOutletA);
const tenantA = tenantIdSchema.parse(seededTenantId);

const scopeOf = (tenantId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const app = createApp();
let staff: Staff;
let approver: ReturnType<typeof agent>; // finance + outlet supervisor, never the requester
const approverUserIds: string[] = [];
let savedPolicies: Record<string, unknown>[] = [];
let tenantB: IsolatedTenant;
let staffB: Staff;
const zoneIds: string[] = [];
const tableIds: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const orderIds: string[] = [];

const depositPort: ReservationDepositPort = {
  async assertReady() {},
  async openDeposit(input) {
    const expiresAt = new Date(
      input.now.getTime() + input.expiresInMinutes * 60_000,
    );
    const linkId = randomUUID();
    await asOwner(async (client) => {
      await client.query(
        `INSERT INTO payment_links
           (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'reservation-test')`,
        [
          linkId,
          seededTenantId,
          input.outletId,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          `RSV-${linkId.slice(0, 8)}`,
          input.amountIdr,
        ],
      );
    });
    linkIds.push(linkId);
    return {
      paymentLinkId: linkId,
      paymentPath: `/bayar/${linkId}`,
      expiresAt: expiresAt.toISOString(),
    };
  },
};

async function setPolicy(requirement: "none" | "required", amount = 0) {
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, 'guard-1', $3, $4, 60, 24, 0, 0, 0, 90, 30, true)`,
      [seededTenantId, seededOutletA, requirement, amount],
    );
  });
}

const key = (prefix = "guard") => `${prefix}-${randomUUID()}`;
let dayCounter = 0;
const nextDate = () => `2027-07-${String(++dayCounter).padStart(2, "0")}`;

/** Books a reservation in `zoneId` whose DP intent is paid (with evidence). */
async function bookPaid(zoneId: string, amountIdr: number) {
  await setPolicy("required", amountIdr);
  const created = await createReservation(
    scopeOf(seededTenantId),
    outletA,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(
        nextDate(),
        "19:00",
        "Asia/Jakarta",
      ).toISOString(),
      pax: 2,
      zoneId,
      guestName: "Tamu Guard",
      contactPhone: "081234567890",
    }),
    key("book"),
  );
  const intentId = randomUUID();
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, reservation_id, method, provider, amount_idr,
          idempotency_key, status, instructions, expires_at, paid_at)
       VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid',
               '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}', now() + interval '1 hour', now())`,
      [
        intentId,
        seededTenantId,
        outletA,
        created.deposit!.paymentLinkId,
        created.reservation.id,
        amountIdr,
        `guard-pay-${intentId}`,
      ],
    );
    await client.query(
      "UPDATE payment_links SET paid_idr = total_idr WHERE id = $1",
      [created.deposit!.paymentLinkId],
    );
    await client.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [seededTenantId, outletA, intentId, `evidence-${intentId}`, amountIdr],
    );
  });
  intentIds.push(intentId);
  return { reservationId: created.reservation.id as string, intentId };
}

/** Books, pays (paid intent + evidence) and seats a reservation with a DP. */
async function seatedWithDeposit(amountIdr = 160_000) {
  const zone = await createZone(staff.client);
  zoneIds.push(zone.id);
  const table = await createTable(staff.client, { zoneId: zone.id });
  tableIds.push(table.id);
  await issueQr(staff.client, table.id);
  const booked = await bookPaid(zone.id, amountIdr);
  const seated = await seatReservation(
    scopeOf(seededTenantId),
    staff.userId,
    outletA,
    booked.reservationId,
    seatReservationInputSchema.parse({ tableIds: [table.id] }),
    key("seat"),
  );
  return {
    intentId: booked.intentId,
    sessionId: seated.tableSessionId,
    zoneId: zone.id as string,
    amountIdr,
  };
}

/** A live order on the session that applied `depositIdr` of the DP. */
async function applyDepositOnOrder(
  sessionId: string,
  depositIdr: number,
  status = "sent",
  // Default: the order's total equals the DP it applied (the DP covers it).
  totalIdr = Math.max(depositIdr, 1),
) {
  const id = randomUUID();
  orderIds.push(id);
  await asOwner((client) =>
    client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         deposit_applied_idr, status, business_date, placed_at, table_session_id)
       VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $8, 0, 0, 0, 0, $8,
         $5, $6, '2026-11-09', now(), $7)`,
      [
        id,
        seededTenantId,
        outletA,
        `G-${randomUUID().slice(0, 8)}`,
        depositIdr,
        status,
        sessionId,
        totalIdr,
      ],
    ),
  );
  return id;
}

const creditOf = (sessionId: string, tenantId = seededTenantId) =>
  withTenant(db, scopeOf(tenantId), (tx) =>
    depositCreditForSession(tx, tenantIdSchema.parse(tenantId), sessionId),
  );

const requestRefund = (intentId: string, amountIdr: number) =>
  staff.client
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian DP uji",
    });

async function refundRows(intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: string;
  }>(
    "SELECT id, status, amount_idr::text AS amount FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2 ORDER BY created_at",
    [seededTenantId, intentId],
  );
  return rows;
}

async function refundablePayment(intentId: string) {
  const response = await staff.client.get(
    `${ADMIN}/refunds/refundable?outletId=${outletA}`,
  );
  expect(response.status).toBe(200);
  return response.body.data.payments.find(
    (p: { paymentIntentId: string }) => p.paymentIntentId === intentId,
  ) as
    | {
        paidAmountIdr: number;
        refundedAmountIdr: number;
        refundableAmountIdr: number;
      }
    | undefined;
}

/**
 * Polls pg_locks until some backend waits, not granted, on an advisory lock
 * held by `holderPid`; returns that waiter's pid. Bounded so a bug cannot hang.
 */
async function waitForAdvisoryWaiterBlockedBy(
  holderPid: number,
): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { rows } = await owner.query<{ pid: number }>(
      `SELECT pid FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted
         AND $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1`,
      [holderPid],
    );
    if (rows[0]) return rows[0].pid;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No advisory lock waiter blocked by backend ${holderPid}`);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  staff = await staffWithRole(app, {
    template: "owner",
    label: "Guard Owner",
  });
  await verifySessionMfa(staff.email);
  approver = agent(app);
  const approverEmail = await signUp(approver, "Guard Finance");
  const approverSession = await approver.get("/api/auth/get-session");
  const approverId = approverSession.body.user.id as string;
  approverUserIds.push(approverId);
  await verifySessionMfa(approverEmail);
  const roleId = async (templateKey: string) =>
    (
      await owner.query<{ id: string }>(
        "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
        [seededTenantId, templateKey],
      )
    ).rows[0]!.id;
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 hour', $2)`,
    [seededTenantId, approverId, await roleId("finance")],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
    [seededTenantId, approverId, await roleId("supervisor"), seededOutletA],
  );
  // One tier for every amount: Finance (with outlet supervisor authority)
  // decides in a single level.
  savedPolicies = (
    await owner.query(
      "SELECT * FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
      [seededTenantId],
    )
  ).rows;
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [seededTenantId],
  );
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [seededTenantId, await roleId("finance")],
  );
  tenantB = await createIsolatedTenant(`guard-${randomUUID().slice(0, 6)}`);
  staffB = await staffOfIsolatedTenant(app, tenantB);
  setReservationDepositPort(depositPort);
  await setPolicy("required", 160_000);
});

afterAll(async () => {
  setReservationDepositPort(null);
  const { rows: refunds } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM approval_requests WHERE object_type = 'payment_refund' AND object_id = ANY($1::text[])",
    [refunds.map((r) => r.id)],
  );
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  // Final (voided) orders are immutable: test cleanup skips user triggers, in
  // its own transaction so the rest of the cleanup keeps FK checks.
  await asOwner(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of ["pos_order_tenders", "pos_orders"])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
        [seededTenantId, orderIds],
      );
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderIds,
    ]);
    await client.query(
      `DELETE FROM orders WHERE tenant_id = $1 AND table_session_id IN
         (SELECT id FROM table_sessions WHERE tenant_id = $1 AND table_id = ANY($2::uuid[]))`,
      [seededTenantId, tableIds],
    );
  });
  await asOwner(async (client) => {
    const rsv = `(SELECT id FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2))`;
    for (const table of [
      "reservation_deposit_allocations",
      "reservation_tables",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND reservation_id IN ${rsv}`,
        [seededTenantId, zoneIds],
      );
    await client.query(
      `DELETE FROM reservation_idempotency WHERE tenant_id = $1 AND (reservation_id IN ${rsv} OR reservation_id IS NULL)`,
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservations WHERE tenant_id = $1 AND zone_id = ANY($2)",
      [seededTenantId, zoneIds],
    );
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [seededTenantId, seededOutletA],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, intentIds],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, linkIds],
    );
  });
  await owner.query(
    "DELETE FROM approval_policies WHERE tenant_id = $1 AND action_type = 'refund'",
    [seededTenantId],
  );
  for (const row of savedPolicies)
    await owner.query(
      `INSERT INTO approval_policies (id, tenant_id, action_type, threshold_idr, approver_role_id, levels, requires_distinct_actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        row.id,
        row.tenant_id,
        row.action_type,
        row.threshold_idr,
        row.approver_role_id,
        row.levels,
        row.requires_distinct_actor,
      ],
    );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [seededTenantId, approverUserIds],
  );
  await dropFloorRows({ tenantId: seededTenantId, zoneIds, tableIds });
  await dropIsolatedTenant(tenantB);
  await owner.end();
});

describe("RSV-02 PAY-04 DP in use by the session's orders cannot be refunded", () => {
  it.each([110_000, 160_000])(
    "RSV-02 PAY-04 a %i refund of a DP with 110000 applied on the bill is refused with REFUND_DEPOSIT_IN_USE and stores nothing",
    async (amountIdr) => {
      const dp = await seatedWithDeposit(160_000);
      await applyDepositOnOrder(dp.sessionId, 110_000);

      const response = await requestRefund(dp.intentId, amountIdr);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("REFUND_DEPOSIT_IN_USE");
      expect(await refundRows(dp.intentId)).toHaveLength(0);
      expect(await creditOf(dp.sessionId)).toBe(160_000);
    },
  );

  it("RSV-02 PAY-04 the unused 50000 can be refunded (pending); then even 1 more is refused", async () => {
    const dp = await seatedWithDeposit(160_000);
    await applyDepositOnOrder(dp.sessionId, 110_000);

    const created = await requestRefund(dp.intentId, 50_000);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.status).toBe("pending");

    const more = await requestRefund(dp.intentId, 1);
    expect(more.status).toBe(409);
    expect(await refundRows(dp.intentId)).toEqual([
      expect.objectContaining({ status: "pending", amount: "50000" }),
    ]);
  });

  it("RSV-02 PAY-04 an order that was voided no longer holds the DP: the whole DP can be refunded", async () => {
    const dp = await seatedWithDeposit(160_000);
    await applyDepositOnOrder(dp.sessionId, 110_000, "voided");

    const created = await requestRefund(dp.intentId, 160_000);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });
});

describe("RSV-02 PAY-04 gross DP in use, several reservations, refunds filed before the guard", () => {
  it("PAY-04 a pending refund filed before the guard cannot be paid once an order applied the DP: it ends failed with cap_exceeded", async () => {
    const dp = await seatedWithDeposit(100_000);
    await applyDepositOnOrder(dp.sessionId, 100_000);
    const refundId = randomUUID();
    await owner.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 100000, 'Diajukan sebelum penjaga', 'pending', $5)`,
      [refundId, seededTenantId, outletA, dp.intentId, staff.userId],
    );
    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      const response = await approver
        .post(`${ADMIN}/refunds/${refundId}/approve`)
        .set(originHeader)
        .send({ idempotencyKey: key("apr") });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      const { rows } = await owner.query<{
        status: string;
        failure_reason: string | null;
      }>(
        "SELECT status, failure_reason FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
        [seededTenantId, refundId],
      );
      expect(rows[0], JSON.stringify(response.body)).toMatchObject({
        status: "failed",
        failure_reason: "cap_exceeded",
      });
      expect(fake.calls).toHaveLength(0);
    } finally {
      setPaymentRefundGateway(null);
    }
  });

  it("RSV-02 PAY-04 two reservations' DPs on one session: 50000 applied by an order, A refunds, B is refused", async () => {
    // Assumption: reservation A was allocated first, B (inserted below) after;
    // the 50000 the order applied is attributed to B, so only A is refundable.
    const a = await seatedWithDeposit(50_000);
    const b = await bookPaid(a.zoneId, 50_000);
    await owner.query(
      `INSERT INTO reservation_deposit_allocations
         (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr, allocated_at)
       VALUES ($1, $2, $3, $4, $5, 50000, now() + interval '1 second')`,
      [seededTenantId, outletA, b.reservationId, a.sessionId, b.intentId],
    );
    expect(await creditOf(a.sessionId)).toBe(100_000);
    await applyDepositOnOrder(a.sessionId, 50_000);

    const first = await requestRefund(a.intentId, 50_000);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await requestRefund(b.intentId, 50_000);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("REFUND_DEPOSIT_IN_USE");
    expect(await refundRows(b.intentId)).toHaveLength(0);
  });
});

describe("RSV-02 PAY-04 open-bill: an unpaid order total also holds the DP", () => {
  it("PAY-04 an open order of 100000 (no DP applied yet, no payment link) holds a 100000 DP: refunding it is refused", async () => {
    const dp = await seatedWithDeposit(100_000);
    await applyDepositOnOrder(dp.sessionId, 0, "sent", 100_000);

    const response = await requestRefund(dp.intentId, 100_000);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("REFUND_DEPOSIT_IN_USE");
    expect(await refundRows(dp.intentId)).toHaveLength(0);
  });

  it("PAY-04 an open order of 60000 holds 60000 of a 100000 DP: 41000 is refused, 40000 is created", async () => {
    const dp = await seatedWithDeposit(100_000);
    await applyDepositOnOrder(dp.sessionId, 0, "sent", 60_000);

    const over = await requestRefund(dp.intentId, 41_000);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("REFUND_DEPOSIT_IN_USE");
    expect(await refundRows(dp.intentId)).toHaveLength(0);

    const ok = await requestRefund(dp.intentId, 40_000);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.status).toBe("pending");
  });
});

describe("PAY-04 POS tenders and concurrent refunds of two DPs on one session", () => {
  it("PAY-04 a POS order paid by DP 60000 plus a captured cash tender 240000 leaves 40000 of the DP refundable: approving it succeeds", async () => {
    const dp = await seatedWithDeposit(100_000);
    const orderId = await applyDepositOnOrder(
      dp.sessionId,
      60_000,
      "sent",
      300_000,
    );
    await owner.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel) VALUES ($1, $2, $3, 'pos')`,
      [orderId, seededTenantId, outletA],
    );
    await owner.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider, amount_idr,
          received_idr, change_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', 240000, 240000, 0, 'captured', now(), now())`,
      [seededTenantId, outletA, orderId],
    );
    const created = await requestRefund(dp.intentId, 40_000);
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    setPaymentRefundGateway(new FakeRefundGateway());
    try {
      const response = await approver
        .post(`${ADMIN}/refunds/${created.body.data.id}/approve`)
        .set(originHeader)
        .send({ idempotencyKey: key("apr") });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.status).toBe("completed");
    } finally {
      setPaymentRefundGateway(null);
    }
  });

  it("RSV-02 PAY-04 refunds of A and B filed at the same time with 50000 applied: exactly one is created, the other waits on the lock and gets 409 REFUND_DEPOSIT_IN_USE", async () => {
    const a = await seatedWithDeposit(50_000);
    const b = await bookPaid(a.zoneId, 50_000);
    await owner.query(
      `INSERT INTO reservation_deposit_allocations
         (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr, allocated_at)
       VALUES ($1, $2, $3, $4, $5, 50000, now() + interval '1 second')`,
      [seededTenantId, outletA, b.reservationId, a.sessionId, b.intentId],
    );
    await applyDepositOnOrder(a.sessionId, 50_000);

    const hold = 9_700_732; // test-owned advisory key
    const blocker = await owner.connect();
    const triggerName = `e7zj_hold_${a.intentId.replaceAll("-", "")}`;
    let refundA: Promise<Awaited<ReturnType<typeof requestRefund>>> | undefined;
    let refundB: Promise<Awaited<ReturnType<typeof requestRefund>>> | undefined;
    try {
      const { rows } = await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const blockerPid = rows[0]!.pid;
      await blocker.query("SELECT pg_advisory_lock($1)", [hold]);
      // Keep refund A's transaction open (after its cap check) until released.
      await owner.query(`
        CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN PERFORM pg_advisory_xact_lock(${hold}); RETURN NEW; END $f$`);
      await owner.query(`
        CREATE TRIGGER ${triggerName} BEFORE INSERT ON payment_refunds
        FOR EACH ROW WHEN (NEW.payment_intent_id = '${a.intentId}')
        EXECUTE FUNCTION ${triggerName}()`);

      refundA = requestRefund(a.intentId, 50_000).then((r) => r);
      const refundAPid = await waitForAdvisoryWaiterBlockedBy(blockerPid);
      refundB = requestRefund(b.intentId, 50_000).then((r) => r);
      // B must queue behind A's DP locks, not run past them.
      const waiterPid = await waitForAdvisoryWaiterBlockedBy(refundAPid);
      expect(waiterPid).not.toBe(refundAPid);
      expect(await refundRows(b.intentId)).toHaveLength(0);

      await blocker.query("SELECT pg_advisory_unlock($1)", [hold]);
      const results = [await refundA, await refundB];
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const refused = results.find((r) => r.status === 409)!;
      expect(refused.body.error.code).toBe("REFUND_DEPOSIT_IN_USE");
      const total =
        (await refundRows(a.intentId)).length +
        (await refundRows(b.intentId)).length;
      expect(total).toBe(1);
    } finally {
      await blocker
        .query("SELECT pg_advisory_unlock_all()")
        .catch(() => undefined);
      await refundA?.catch(() => undefined);
      await refundB?.catch(() => undefined);
      await owner
        .query(`DROP TRIGGER IF EXISTS ${triggerName} ON payment_refunds`)
        .catch(() => undefined);
      await owner
        .query(`DROP FUNCTION IF EXISTS ${triggerName}()`)
        .catch(() => undefined);
      blocker.release();
    }
  });
});

describe("RSV-02 the session credit follows refunds on the DP", () => {
  it("RSV-02 a pending refund lowers the credit at once, a failed one gives it back, a full refund leaves 0", async () => {
    const dp = await seatedWithDeposit(160_000);
    expect(await creditOf(dp.sessionId)).toBe(160_000);

    const first = await requestRefund(dp.intentId, 60_000);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(await creditOf(dp.sessionId)).toBe(100_000);

    await owner.query(
      "UPDATE payment_refunds SET status = 'failed', failure_reason = 'rejected' WHERE tenant_id = $1 AND id = $2",
      [seededTenantId, first.body.data.id],
    );
    expect(await creditOf(dp.sessionId)).toBe(160_000);

    const full = await requestRefund(dp.intentId, 160_000);
    expect(full.status, JSON.stringify(full.body)).toBe(201);
    expect(await creditOf(dp.sessionId)).toBe(0);
  });
});

describe("RSV-02 PAY-04 refund and bill credit are serialized per DP", () => {
  it("RSV-02 PAY-04 a refund waits for an open credit lookup; once the sale commits it is refused", async () => {
    const dp = await seatedWithDeposit(160_000);
    const held = deferred<number>();
    const release = deferred();
    let holderPid = 0;

    // Transaction A: the bill reads the credit, applies 110000, and stays open.
    const sale = withTenant(db, scopeOf(seededTenantId), async (tx) => {
      const credit = await depositCreditForSession(tx, tenantA, dp.sessionId);
      const pid = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      holderPid = Number((pid.rows[0] as { pid: number }).pid);
      held.resolve(credit);
      await release.promise;
      await tx.execute(sql`
        INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
          subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
          deposit_applied_idr, status, business_date, placed_at, table_session_id)
        VALUES (${randomUUID()}::uuid, ${seededTenantId}, ${outletA}, ${`G-${randomUUID().slice(0, 8)}`},
          'pos', 'dine_in', 'pay_first', 110000, 0, 0, 0, 0, 110000,
          110000, 'sent', '2026-11-09', now(), ${dp.sessionId}::uuid)
      `);
      return credit;
    });
    sale.catch(() => release.resolve());

    try {
      expect(await held.promise).toBe(160_000);
      // Transaction B: a refund of the whole DP, started while A is open.
      // supertest requests are lazy: .then() sends it now.
      const refund = requestRefund(dp.intentId, 160_000).then((r) => r);
      await waitForAdvisoryWaiterBlockedBy(holderPid);
      expect(await refundRows(dp.intentId)).toHaveLength(0);

      release.resolve();
      await sale;
      const response = await refund;
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("REFUND_DEPOSIT_IN_USE");
      expect(await refundRows(dp.intentId)).toHaveLength(0);
    } finally {
      release.resolve();
      await sale.catch(() => undefined);
    }
    // Orders of the test are removed in afterAll by session; track via DB.
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM orders WHERE tenant_id = $1 AND table_session_id = $2",
      [seededTenantId, dp.sessionId],
    );
    orderIds.push(...rows.map((r) => r.id));
    expect(rows).toHaveLength(1);
  });

  it("RSV-02 PAY-04 a credit lookup waits for a refund in flight and then sees it", async () => {
    const dp = await seatedWithDeposit(160_000);
    const hold = 9_700_731; // test-owned advisory key
    const blocker = await owner.connect();
    const triggerName = `e7zj_hold_${dp.intentId.replaceAll("-", "")}`;
    let refund: Promise<Awaited<ReturnType<typeof requestRefund>>> | undefined;
    let lookup: Promise<number> | undefined;
    try {
      const { rows } = await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const blockerPid = rows[0]!.pid;
      await blocker.query("SELECT pg_advisory_lock($1)", [hold]);
      // The refund inserts its row only after it took the DP lock; this trigger
      // keeps that transaction open until the test releases `hold`.
      await owner.query(`
        CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN PERFORM pg_advisory_xact_lock(${hold}); RETURN NEW; END $f$`);
      await owner.query(`
        CREATE TRIGGER ${triggerName} BEFORE INSERT ON payment_refunds
        FOR EACH ROW WHEN (NEW.payment_intent_id = '${dp.intentId}')
        EXECUTE FUNCTION ${triggerName}()`);

      refund = requestRefund(dp.intentId, 60_000).then((r) => r);
      const refundPid = await waitForAdvisoryWaiterBlockedBy(blockerPid);

      lookup = creditOf(dp.sessionId);
      const lookupPid = await waitForAdvisoryWaiterBlockedBy(refundPid);
      expect(lookupPid).not.toBe(refundPid);

      await blocker.query("SELECT pg_advisory_unlock($1)", [hold]);
      const response = await refund;
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      // The lookup ran after the refund committed: it sees the pending 60000.
      expect(await lookup).toBe(100_000);
    } finally {
      await blocker
        .query("SELECT pg_advisory_unlock_all()")
        .catch(() => undefined);
      await refund?.catch(() => undefined);
      await lookup?.catch(() => undefined);
      await owner
        .query(`DROP TRIGGER IF EXISTS ${triggerName} ON payment_refunds`)
        .catch(() => undefined);
      await owner
        .query(`DROP FUNCTION IF EXISTS ${triggerName}()`)
        .catch(() => undefined);
      blocker.release();
    }
  });
});

describe("TEN-01 RSV-02 PAY-04 DP credit and refund cap are tenant-scoped", () => {
  it("TEN-01 another tenant sees no credit for this tenant's session and cannot refund its DP", async () => {
    const dp = await seatedWithDeposit(160_000);
    await applyDepositOnOrder(dp.sessionId, 110_000);

    expect(await creditOf(dp.sessionId, tenantB.tenantId)).toBe(0);
    expect(await creditOf(dp.sessionId)).toBe(160_000);

    await expect(
      createRefund(
        scopeOf(tenantB.tenantId),
        staffB.userId,
        {
          idempotencyKey: key("b"),
          paymentIntentId: dp.intentId,
          amountIdr: 10_000,
          reason: "Lintas tenant",
        } as never,
        key("b"),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await refundRows(dp.intentId)).toHaveLength(0);

    // Tenant A's cap is untouched by tenant B's attempt: exactly the unused 50000.
    expect((await requestRefund(dp.intentId, 50_001)).status).toBe(409);
    const ok = await requestRefund(dp.intentId, 50_000);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

describe("PAY-04 the refundable list is net of DP in use", () => {
  it("PAY-04 refundableAmountIdr excludes the DP applied on the bill and shows pending refunds", async () => {
    const dp = await seatedWithDeposit(160_000);
    await applyDepositOnOrder(dp.sessionId, 110_000);

    const before = await refundablePayment(dp.intentId);
    expect(before).toMatchObject({
      refundedAmountIdr: 0,
      refundableAmountIdr: 50_000,
    });

    expect((await requestRefund(dp.intentId, 20_000)).status).toBe(201);
    const after = await refundablePayment(dp.intentId);
    expect(after).toMatchObject({
      refundedAmountIdr: 20_000,
      refundableAmountIdr: 30_000,
    });
    // paid (net of DP in use) = refunded + refundable.
    expect(after!.refundedAmountIdr + after!.refundableAmountIdr).toBe(
      after!.paidAmountIdr,
    );
  });

  it("PAY-04 a DP with nothing applied lists its full amount as refundable", async () => {
    const dp = await seatedWithDeposit(160_000);
    expect(await refundablePayment(dp.intentId)).toMatchObject({
      paidAmountIdr: 160_000,
      refundedAmountIdr: 0,
      refundableAmountIdr: 160_000,
    });
  });
});
