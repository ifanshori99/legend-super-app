// DP intent lock (beads legend-em6p U4, legend-fsl5 U1; money, tier K).
//
// Invariant: facts on one payment intent (sale completion, refund completion,
// reservation close) are stored in commit order. Every fact writer takes the
// payment_intents row lock FIRST and only then takes its fact time, so a fact
// that commits later never carries an earlier time. Before the fix a sale
// stamped T1 could commit after a refund stamped T2 > T1, and the DP was
// debited twice.
//
// Written from the sub-brief (docs/briefs/sub-dp-intent-lock.md "Design" and
// "Tests"), not from the fix. Real Express app, Better Auth, services and
// PostgreSQL. Fixtures follow reservation-deposit-refund-guard.test.ts
// (paid DP intent, seatReservation, owner.connect() client, temp trigger that
// stalls a transaction on a test advisory key) and pos-order-deposit-lock.test.ts
// (isolated tenant with a dine-in price list; POS order over HTTP).
//
// Assumptions where the brief is not exact:
// - "Tx B = refund completion" is the approve route with the fake provider
//   (refund ends `completed` in the same request). The refund is created
//   (pending) first, then approved by a distinct finance + supervisor user.
// - The HTTP sale cannot take an explicit `now`; its fact time comes from the
//   JS clock, which is earlier than the refund's because the sale starts first.
//   Reservation close takes an explicit `now` (2027, the booking date), which
//   is later than the refund's real clock; that is the "bump" case (T3).
// - "B must be blocked by A" = while A is stalled, B has not settled and some
//   backend waits on a row lock of payment_intents (pg_locks tuple lock) held
//   by A (pg_blocking_pids). The wait is polled, bounded, never slept.
// - Stalling triggers fire on `orders` (sale: status = completed) and on
//   `reservations` (close: status = no_show); both are after the business row
//   lock and, in the fixed code, after the intent lock.
// - The latest committed fact an intent carries includes the reservation's
//   closed_at (T2/T3 depend on it).
// - T4: policy no_show_refund_bp = 5000; the no-show forfeits 50000 and
//   auto-files a 50000 refund. That refund is set to `failed` (as the guard
//   test does) so only the forfeited half stays unavailable.
// - T5: sale/refund share a seated DP; close/refund share an unseated DP (a
//   seated reservation cannot be closed). "No deadlock" = no 40P01, no 5xx.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { PosReceipt } from "@starter/shared/pos";
import {
  createReservationInputSchema,
  markNoShowInputSchema,
  seatReservationInputSchema,
} from "@starter/shared/reservation";
import { createApp } from "../app.ts";
import { createReservation } from "../services/reservation-booking.ts";
import {
  markReservationNoShow,
  seatReservation,
} from "../services/reservation-lifecycle.ts";
import { zonedInstant } from "../services/reservation-plan.ts";
import {
  setReservationDepositPort,
  type ReservationDepositPort,
} from "../services/reservation-ports.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import { runRefundPayout } from "../services/payment-refund.service.ts";
import { agent, originHeader, signUp, verifySessionMfa } from "./helpers.ts";
import { FakeRefundGateway } from "./refund-fake-gateway.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  seededTenantId,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const ADMIN = "/api/payments/admin";
const DP_IDR = 100_000;
/** Kopi x2 = Rp50.000 + PBJT 10% = Rp55.000 (copied from pos-order-deposit-lock). */
const ORDER_TOTAL_IDR = 55_000;
/** What is left of a 100000 DP after a 55000 sale applied it. */
const REFUNDABLE_AFTER_SALE_IDR = DP_IDR - ORDER_TOTAL_IDR;
const KOPI_IDR = 25_000;
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

type Client = ReturnType<typeof agent>;
type Member = { client: Client; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let outletId: ReturnType<typeof outletIdSchema.parse>;
let kopiId: string;
let floor: Staff;
let cashier: Member;
let requester: Member; // files refunds
let approver: Member; // finance + supervisor, never the requester
const receipts = new Map<string, PosReceipt>();

const key = (prefix = "dpl") => `${prefix}-${randomUUID()}`;
const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
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
      [tenant.tenantId],
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

// ---- Fixtures ---------------------------------------------------------------

const RECEIPT_DEVICE_ID = randomUUID();
const receiptPort: PosReceiptPort = {
  async issueForSale(_tx, context, input) {
    const existing = receipts.get(input.orderId);
    if (existing) return existing;
    const sequenceNumber = receipts.size + 1;
    const receipt = {
      id: randomUUID(),
      tenantId: context.tenant.tenantId,
      outletId: input.outletId,
      orderId: input.orderId,
      deviceId: input.deviceId ?? RECEIPT_DEVICE_ID,
      number: `DPL-${String(sequenceNumber).padStart(6, "0")}`,
      sequenceNumber,
      status: "issued",
      issuedAt: input.at.toISOString(),
      voidedAt: null,
      voidReason: null,
      voidedBy: null,
      reprintCount: 0,
    } as unknown as PosReceipt;
    receipts.set(input.orderId, receipt);
    return receipt;
  },
  async findForOrder(_tx, _context, orderId) {
    return receipts.get(orderId) ?? null;
  },
  async voidForOrder() {
    return null;
  },
};

/** Reservation DP port double: only opens a payment link (as the guard test). */
const depositPort: ReservationDepositPort = {
  async assertReady() {},
  async openDeposit(input) {
    const expiresAt = new Date(
      input.now.getTime() + input.expiresInMinutes * 60_000,
    );
    const linkId = randomUUID();
    await asOwner((client) =>
      client.query(
        `INSERT INTO payment_links
           (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 'dp-lock-test')`,
        [
          linkId,
          tenant.tenantId,
          input.outletId,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          `RSV-${linkId.slice(0, 8)}`,
          input.amountIdr,
        ],
      ),
    );
    return {
      paymentLinkId: linkId,
      paymentPath: `/bayar/${linkId}`,
      expiresAt: expiresAt.toISOString(),
    };
  },
};

async function memberWithRoles(
  label: string,
  roles: { roleId: string; scopeType?: "tenant" | "outlet" }[],
  verifyMfa = false,
): Promise<Member> {
  const client = agent(app);
  const email = await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  for (const role of roles)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        tenant.tenantId,
        userId,
        role.roleId,
        role.scopeType ?? "tenant",
        role.scopeType === "outlet" ? tenant.outletId : null,
      ],
    );
  if (verifyMfa) await verifySessionMfa(email);
  return { client, userId };
}

/** A role of the isolated tenant with the permissions of a seeded template. */
async function copyTemplateRole(templateKey: string): Promise<string> {
  const id = randomUUID();
  const { rowCount } = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
     FROM roles WHERE tenant_id = $3 AND template_key = $4`,
    [id, tenant.tenantId, seededTenantId, templateKey],
  );
  if (!rowCount) throw new Error(`No ${templateKey} role template`);
  return id;
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPosReceiptPort(receiptPort);
  setReservationDepositPort(depositPort);
  tenant = await createIsolatedTenant(`dpl-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  outletId = outletIdSchema.parse(tenant.outletId);
  floor = await staffOfIsolatedTenant(app, tenant);

  const ids = {
    category: randomUUID(),
    kopi: randomUUID(),
    priceList: randomUUID(),
    cashierRole: randomUUID(),
  };
  kopiId = ids.kopi;
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Uji', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
      ]),
    ],
  );
  cashier = await memberWithRoles("DPL Kasir", [{ roleId: ids.cashierRole }]);

  const ownerRole = await copyTemplateRole("owner");
  const financeRole = await copyTemplateRole("finance");
  const supervisorRole = await copyTemplateRole("supervisor");
  requester = await memberWithRoles(
    "DPL Requester",
    [{ roleId: ownerRole }],
    true,
  );
  approver = await memberWithRoles(
    "DPL Finance",
    [{ roleId: financeRole }, { roleId: supervisorRole, scopeType: "outlet" }],
    true,
  );
  // One tier for every amount: finance (with supervisor authority) decides.
  await owner.query(
    `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
     VALUES ($1, 'refund', NULL, $2, 1)`,
    [tenant.tenantId, financeRole],
  );

  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'DP Lock Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-DPL', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
});

afterAll(async () => {
  setPaymentRefundGateway(null);
  setReservationDepositPort(null);
  setPosReceiptPort(null);
  // Orders and audit rows are append-only, so the isolated tenant stays in the
  // disposable database; give it a valid creator so the platform tenant list
  // still parses it (as pos-order-deposit-lock.test.ts does).
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

async function setPolicy(noShowRefundBp: number) {
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM reservation_policies WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO reservation_policies
         (tenant_id, outlet_id, version, deposit_requirement, deposit_amount_idr, payment_window_minutes,
          free_cancellation_hours, late_cancellation_refund_bp, no_show_refund_bp, minimum_spend_idr,
          default_duration_minutes, slot_interval_minutes, is_active)
       VALUES ($1, $2, $3, 'required', $4, 60, 24, 0, $5, 0, 90, 30, true)`,
      [
        tenant.tenantId,
        tenant.outletId,
        `dpl-${randomUUID().slice(0, 6)}`,
        DP_IDR,
        noShowRefundBp,
      ],
    );
  });
}

let dayCounter = 0;
const nextDate = () => `2027-09-${String(++dayCounter).padStart(2, "0")}`;
const WIB = "Asia/Jakarta";

type Booked = {
  reservationId: string;
  intentId: string;
  zoneId: string;
  tableId: string;
  date: string;
};

/** Books a reservation whose DP intent (DP_IDR) is paid, with evidence. */
async function bookPaid(noShowRefundBp = 0): Promise<Booked> {
  await setPolicy(noShowRefundBp);
  const zone = await createZone(
    floor.client,
    { paymentMode: "pay_first", serviceChargeBp: 0, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(floor.client, { zoneId: zone.id }, headers);
  await issueQr(floor.client, table.id, headers);
  const date = nextDate();
  const created = await createReservation(
    scope(),
    outletId,
    createReservationInputSchema.parse({
      reservedFor: zonedInstant(date, "19:00", WIB).toISOString(),
      pax: 2,
      zoneId: zone.id,
      guestName: "Tamu DP Lock",
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
        tenant.tenantId,
        tenant.outletId,
        created.deposit!.paymentLinkId,
        created.reservation.id,
        DP_IDR,
        `dpl-pay-${intentId}`,
      ],
    );
    await client.query(
      "UPDATE payment_links SET paid_idr = total_idr WHERE id = $1",
      [created.deposit!.paymentLinkId],
    );
    await client.query(
      `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
       VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
      [
        tenant.tenantId,
        tenant.outletId,
        intentId,
        `evidence-${intentId}`,
        DP_IDR,
      ],
    );
  });
  return {
    reservationId: created.reservation.id as string,
    intentId,
    zoneId: zone.id as string,
    tableId: table.id as string,
    date,
  };
}

/** Books, pays and seats a DP; an open POS order of the session applies it. */
async function seatedSale() {
  const booked = await bookPaid();
  const seated = await seatReservation(
    scope(),
    requester.userId,
    outletId,
    booked.reservationId,
    seatReservationInputSchema.parse({ tableIds: [booked.tableId] }),
    key("seat"),
  );
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    cashier.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID(), ...body });
  const created = await send("", {
    channel: "pos",
    serviceType: "dine_in",
    tableSessionId: seated.tableSessionId,
    items: [{ menuItemId: kopiId, quantity: 2, modifierIds: [] }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.totalIdr).toBe(ORDER_TOTAL_IDR);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await send(`/${orderId}/submit`, {
      expectedStatus: status,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  return {
    ...booked,
    orderId,
    orderUuid: ulidToUuid(orderId) as string,
    /** The sale completes fully by the DP: no tender. Resolves to the response. */
    complete: () =>
      send(`/${orderId}/complete`, { expectedStatus: status }).then((r) => r),
  };
}

const requestRefund = (intentId: string, amountIdr: number) =>
  requester.client
    .post(`${ADMIN}/refunds`)
    .set(headers)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian DP uji",
    });

async function pendingRefund(intentId: string, amountIdr: number) {
  const created = await requestRefund(intentId, amountIdr);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.data.status).toBe("pending");
  return created.body.data.id as string;
}

/** Tx B: approve; with the fake provider the refund completes in the request. */
const approveRefund = (refundId: string) =>
  approver.client
    .post(`${ADMIN}/refunds/${refundId}/approve`)
    .set(headers)
    .set(originHeader)
    .send({ idempotencyKey: key("apr") })
    .then((r) => r);

async function timeOf(sqlText: string, params: unknown[]): Promise<Date> {
  const { rows } = await asOwner((client) =>
    client.query<{ at: Date }>(sqlText, params),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.at).toBeInstanceOf(Date);
  return rows[0]!.at;
}
const refundCompletedAt = (refundId: string) =>
  timeOf("SELECT completed_at AS at FROM payment_refunds WHERE id = $1", [
    refundId,
  ]);
const saleCompletedAt = (orderUuid: string) =>
  timeOf("SELECT completed_at AS at FROM pos_orders WHERE order_id = $1", [
    orderUuid,
  ]);
const reservationClosedAt = (reservationId: string) =>
  timeOf("SELECT closed_at AS at FROM reservations WHERE id = $1", [
    reservationId,
  ]);

// ---- Stall harness (as the e7zj guard test) -----------------------------------

let holdKey = 9_700_740; // test-owned advisory keys, one per stall

/**
 * Stalls the first transaction that updates `table` rows matching `when` until
 * `release()`: a temp BEFORE UPDATE trigger waits on an advisory lock this test
 * holds. `waitForStalled()` returns the stalled backend's pid.
 */
async function stallUpdates(table: "orders" | "reservations", when: string) {
  const hold = holdKey++;
  const blocker = await owner.connect();
  const name = `dpl_stall_${hold}`;
  const { rows } = await blocker.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const blockerPid = rows[0]!.pid;
  await blocker.query("SELECT pg_advisory_lock($1)", [hold]);
  await owner.query(`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN PERFORM pg_advisory_xact_lock(${hold}); RETURN NEW; END $f$`);
  await owner.query(`
    CREATE TRIGGER ${name} BEFORE UPDATE ON ${table}
    FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ${name}()`);
  return {
    async waitForStalled(): Promise<number> {
      for (let attempt = 0; attempt < 400; attempt++) {
        const { rows: waiters } = await owner.query<{ pid: number }>(
          `SELECT pid FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted
             AND $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1`,
          [blockerPid],
        );
        if (waiters[0]) return waiters[0].pid;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("The writer never reached the stalling trigger");
    },
    async release() {
      await blocker
        .query("SELECT pg_advisory_unlock_all()")
        .catch(() => undefined);
    },
    async cleanup() {
      await blocker
        .query("SELECT pg_advisory_unlock_all()")
        .catch(() => undefined);
      await owner
        .query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`)
        .catch(() => undefined);
      await owner
        .query(`DROP FUNCTION IF EXISTS ${name}()`)
        .catch(() => undefined);
      blocker.release();
    },
  };
}

/**
 * While the writer with backend `holderPid` is stalled, which happens first:
 * the competing request settles ("settled") or it waits on a row lock of
 * payment_intents held by the stalled writer ("blocked")? Polled, bounded.
 */
async function raceAgainstStalled(
  holderPid: number,
  competitor: Promise<unknown>,
): Promise<"blocked" | "settled"> {
  let settled = false;
  void competitor.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let attempt = 0; attempt < 600; attempt++) {
    if (settled) return "settled";
    const { rows } = await owner.query(
      `SELECT a.pid FROM pg_stat_activity a
       WHERE a.datname = current_database()
         AND $1::int = ANY(pg_blocking_pids(a.pid))
         AND EXISTS (SELECT 1 FROM pg_locks l
                     WHERE l.pid = a.pid AND l.locktype = 'tuple'
                       AND l.relation = 'payment_intents'::regclass)
       LIMIT 1`,
      [holderPid],
    );
    if (rows[0]) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Competitor neither settled nor waited on the intent lock");
}

// ---- Tests --------------------------------------------------------------------

describe("legend-em6p U4: facts on one DP intent are stored in commit order", () => {
  it("legend-em6p T1 a refund completion waits for a sale in flight on the same DP and is stamped after it", async () => {
    const sale = await seatedSale();
    const refundId = await pendingRefund(
      sale.intentId,
      REFUNDABLE_AFTER_SALE_IDR,
    );
    const stall = await stallUpdates(
      "orders",
      `NEW.id = '${sale.orderUuid}'::uuid AND NEW.status = 'completed'`,
    );
    setPaymentRefundGateway(new FakeRefundGateway());
    let saleRequest: ReturnType<typeof sale.complete> | undefined;
    let refundRequest:
      Promise<Awaited<ReturnType<typeof approveRefund>>> | undefined;
    try {
      saleRequest = sale.complete(); // Tx A, stalled after its completed_at write
      const salePid = await stall.waitForStalled();
      refundRequest = approveRefund(refundId); // Tx B, later clock

      // Tx B must queue behind Tx A on the intent, not commit past it.
      expect(
        await raceAgainstStalled(salePid, refundRequest),
        "refund completion must wait for the sale holding the DP intent",
      ).toBe("blocked");

      await stall.release();
      const [saleResponse, refundResponse] = [
        await saleRequest,
        await refundRequest,
      ];
      expect(saleResponse.status, JSON.stringify(saleResponse.body)).toBe(200);
      expect(refundResponse.status, JSON.stringify(refundResponse.body)).toBe(
        200,
      );
      expect(refundResponse.body.data.status).toBe("completed");
      // The sale committed first, so its time is the smaller one (strict).
      expect((await refundCompletedAt(refundId)).getTime()).toBeGreaterThan(
        (await saleCompletedAt(sale.orderUuid)).getTime(),
      );
    } finally {
      await stall.cleanup();
      setPaymentRefundGateway(null);
      await saleRequest?.catch(() => undefined);
      await refundRequest?.catch(() => undefined);
    }
  });

  it("legend-em6p T2 a refund completion waits for a forfeiting close of the same DP and is stamped after it", async () => {
    const booked = await bookPaid(0); // no-show: no refund, the DP is forfeited
    const refundId = await pendingRefund(booked.intentId, 40_000);
    const stall = await stallUpdates(
      "reservations",
      `NEW.id = '${booked.reservationId}'::uuid AND NEW.status = 'no_show'`,
    );
    setPaymentRefundGateway(new FakeRefundGateway());
    let closeRequest: Promise<unknown> | undefined;
    let refundRequest:
      Promise<Awaited<ReturnType<typeof approveRefund>>> | undefined;
    try {
      // Tx A: the no-show is due 90+ minutes after the 19:00 booking.
      closeRequest = markReservationNoShow(
        scope(),
        requester.userId,
        outletId,
        booked.reservationId,
        markNoShowInputSchema.parse({}),
        key("noshow"),
        zonedInstant(booked.date, "21:00", WIB),
      );
      const closePid = await stall.waitForStalled();
      refundRequest = approveRefund(refundId); // Tx B

      expect(
        await raceAgainstStalled(closePid, refundRequest),
        "refund completion must wait for the close holding the DP intent",
      ).toBe("blocked");

      await stall.release();
      await closeRequest;
      const refundResponse = await refundRequest;
      expect(refundResponse.status, JSON.stringify(refundResponse.body)).toBe(
        200,
      );
      expect(refundResponse.body.data.status).toBe("completed");
      const { rows } = await asOwner((client) =>
        client.query<{ forfeited: string }>(
          "SELECT deposit_forfeited_idr::text AS forfeited FROM reservations WHERE id = $1",
          [booked.reservationId],
        ),
      );
      expect(Number(rows[0]!.forfeited)).toBeGreaterThan(0);
      expect((await refundCompletedAt(refundId)).getTime()).toBeGreaterThan(
        (await reservationClosedAt(booked.reservationId)).getTime(),
      );
    } finally {
      await stall.cleanup();
      setPaymentRefundGateway(null);
      await closeRequest?.catch(() => undefined);
      await refundRequest?.catch(() => undefined);
    }
  });

  it("legend-em6p T2b a refund completion waits for a forfeiting close of a pending_deposit reservation whose paid DP is not yet reconciled", async () => {
    // Assumption: same as T2, but the reservation is still `pending_deposit`
    // with its DP intent already paid and not yet reconciled
    // (deposit_payment_id is null until reconcileDeposit). bookPaid leaves the
    // reservation in that state; it is asserted below, not assumed. The close
    // must still find and lock the paid intent (via the intent's reservation
    // link) before it takes its fact time.
    const booked = await bookPaid(0); // no-show: no refund, the DP is forfeited
    const before = await asOwner((client) =>
      client.query<{ status: string; deposit_payment_id: string | null }>(
        "SELECT status, deposit_payment_id FROM reservations WHERE id = $1",
        [booked.reservationId],
      ),
    );
    expect(before.rows[0]!.status).toBe("pending_deposit");
    expect(before.rows[0]!.deposit_payment_id).toBeNull();

    const refundId = await pendingRefund(booked.intentId, 40_000);
    const stall = await stallUpdates(
      "reservations",
      `NEW.id = '${booked.reservationId}'::uuid AND NEW.status = 'no_show'`,
    );
    setPaymentRefundGateway(new FakeRefundGateway());
    let closeRequest: Promise<unknown> | undefined;
    let refundRequest:
      Promise<Awaited<ReturnType<typeof approveRefund>>> | undefined;
    try {
      closeRequest = markReservationNoShow(
        scope(),
        requester.userId,
        outletId,
        booked.reservationId,
        markNoShowInputSchema.parse({}),
        key("noshow"),
        zonedInstant(booked.date, "21:00", WIB),
      );
      const closePid = await stall.waitForStalled();
      refundRequest = approveRefund(refundId);

      expect(
        await raceAgainstStalled(closePid, refundRequest),
        "refund completion must wait for the close of the unreconciled pending_deposit reservation",
      ).toBe("blocked");

      await stall.release();
      await closeRequest;
      const refundResponse = await refundRequest;
      expect(refundResponse.status, JSON.stringify(refundResponse.body)).toBe(
        200,
      );
      expect(refundResponse.body.data.status).toBe("completed");
      const { rows } = await asOwner((client) =>
        client.query<{ forfeited: string }>(
          "SELECT deposit_forfeited_idr::text AS forfeited FROM reservations WHERE id = $1",
          [booked.reservationId],
        ),
      );
      expect(Number(rows[0]!.forfeited)).toBeGreaterThan(0);
      expect((await refundCompletedAt(refundId)).getTime()).toBeGreaterThan(
        (await reservationClosedAt(booked.reservationId)).getTime(),
      );
    } finally {
      await stall.cleanup();
      setPaymentRefundGateway(null);
      await closeRequest?.catch(() => undefined);
      await refundRequest?.catch(() => undefined);
    }
  });

  it("legend-em6p T3 a refund whose clock is earlier than a committed fact is stamped exactly 1 ms after it", async () => {
    // Assumption: sequential stand-in for "A stalled with the later now, B
    // with the earlier now": once A has committed, B may not carry a time at or
    // before A's. A's now is the 2027 booking day, B's is the real clock.
    const booked = await bookPaid(0);
    const refundId = await pendingRefund(booked.intentId, 40_000);
    const closeNow = zonedInstant(booked.date, "21:00", WIB);
    await markReservationNoShow(
      scope(),
      requester.userId,
      outletId,
      booked.reservationId,
      markNoShowInputSchema.parse({}),
      key("noshow"),
      closeNow,
    );
    const closedAt = await reservationClosedAt(booked.reservationId);
    expect(closedAt.getTime()).toBe(closeNow.getTime());

    setPaymentRefundGateway(new FakeRefundGateway());
    try {
      const response = await approveRefund(refundId);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data.status).toBe("completed");
    } finally {
      setPaymentRefundGateway(null);
    }
    expect((await refundCompletedAt(refundId)).getTime()).toBe(
      closedAt.getTime() + 1,
    );
  });

  // Assumption: with no refund gateway installed, approving leaves the refund
  // `approved` (payout deferred), so the completion path can then be driven
  // through runRefundPayout with a caller-chosen `now`.
  it.each([
    ["one after the other", false],
    ["at the same time", true],
  ])(
    "legend-41li5 two refunds on ONE intent completed with the same now get strictly increasing completed_at (%s)",
    async (_label, concurrent) => {
      const booked = await bookPaid(0);
      const first = await pendingRefund(booked.intentId, 40_000);
      const second = await pendingRefund(booked.intentId, 40_000);
      setPaymentRefundGateway(null);
      for (const id of [first, second]) {
        const approved = await approveRefund(id);
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        expect(approved.body.data.status).toBe("approved");
      }

      const now = new Date(); // the very same Date for both completions
      setPaymentRefundGateway(new FakeRefundGateway());
      try {
        const complete = (id: string) => runRefundPayout(scope(), id, now);
        if (concurrent) {
          await Promise.all([complete(first), complete(second)]);
        } else {
          await complete(first);
          await complete(second);
        }
      } finally {
        setPaymentRefundGateway(null);
      }

      const at = [
        (await refundCompletedAt(first)).getTime(),
        (await refundCompletedAt(second)).getTime(),
      ];
      // Every stamp is at or after the shared now, and none repeats.
      expect(Math.min(...at)).toBeGreaterThanOrEqual(now.getTime());
      expect(at[0]).not.toBe(at[1]);
      // Strictly increasing in completion order (the order is arbitrary when
      // both run at once, so only distinctness is asserted there).
      if (!concurrent) expect(at[1]).toBeGreaterThan(at[0]!);
    },
  );
});

describe("legend-fsl5 U1: a forfeited DP cannot be refunded", () => {
  it("legend-fsl5 T4 the forfeited part is refused with 409 REFUND_DEPOSIT_FORFEITED; the rest can be refunded", async () => {
    const booked = await bookPaid(5_000); // no-show: 50% refund, 50% forfeited
    const closed = await markReservationNoShow(
      scope(),
      requester.userId,
      outletId,
      booked.reservationId,
      markNoShowInputSchema.parse({}),
      key("noshow"),
      zonedInstant(booked.date, "21:00", WIB),
    );
    expect(closed.depositOutcome).toMatchObject({
      refundIdr: 50_000,
      forfeitedIdr: 50_000,
    });
    // Release the refund the close filed, so only the forfeiture holds the rest.
    await asOwner((client) =>
      client.query(
        "UPDATE payment_refunds SET status = 'failed', failure_reason = 'rejected' WHERE payment_intent_id = $1",
        [booked.intentId],
      ),
    );

    const forfeited = await requestRefund(booked.intentId, 51_000);
    expect(forfeited.status).toBe(409);
    expect(forfeited.body.error.code).toBe("REFUND_DEPOSIT_FORFEITED");
    expect(forfeited.body.error.message).toContain("50000");

    const rest = await requestRefund(booked.intentId, 50_000);
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.data.status).toBe("pending");

    // The remainder is now reserved; anything more is still the forfeited part.
    const more = await requestRefund(booked.intentId, 1_000);
    expect(more.status).toBe(409);
    expect(more.body.error.code).toBe("REFUND_DEPOSIT_FORFEITED");
  });

  it("legend-fsl5 T4 a fully forfeited DP refuses any refund with REFUND_DEPOSIT_FORFEITED", async () => {
    const booked = await bookPaid(0);
    await markReservationNoShow(
      scope(),
      requester.userId,
      outletId,
      booked.reservationId,
      markNoShowInputSchema.parse({}),
      key("noshow"),
      zonedInstant(booked.date, "21:00", WIB),
    );
    const response = await requestRefund(booked.intentId, 1_000);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("REFUND_DEPOSIT_FORFEITED");
  });

  it("legend-fsl5 T4 a DP applied on the bill still answers REFUND_DEPOSIT_IN_USE, not FORFEITED", async () => {
    const sale = await seatedSale();
    const over = await requestRefund(
      sale.intentId,
      REFUNDABLE_AFTER_SALE_IDR + 1,
    );
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("REFUND_DEPOSIT_IN_USE");
    const ok = await requestRefund(sale.intentId, REFUNDABLE_AFTER_SALE_IDR);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

describe("legend-em6p T5: sale, refund and close on shared DPs never deadlock", () => {
  it.each([
    ["sale first", false],
    ["close first", true],
  ])(
    "legend-em6p T5 concurrent sale, close and refunds (%s) all finish without 40P01",
    async (_label, closeFirst) => {
      const sale = await seatedSale();
      const saleRefund = await pendingRefund(
        sale.intentId,
        REFUNDABLE_AFTER_SALE_IDR,
      );
      const toClose = await bookPaid(0);
      const closeRefund = await pendingRefund(toClose.intentId, 40_000);

      setPaymentRefundGateway(new FakeRefundGateway());
      try {
        const runSale = () => sale.complete();
        const runSaleRefund = () => approveRefund(saleRefund);
        const runClose = () =>
          markReservationNoShow(
            scope(),
            requester.userId,
            outletId,
            toClose.reservationId,
            markNoShowInputSchema.parse({}),
            key("noshow"),
            zonedInstant(toClose.date, "21:00", WIB),
          );
        const runCloseRefund = () => approveRefund(closeRefund);
        const jobs = closeFirst
          ? [runClose, runCloseRefund, runSaleRefund, runSale]
          : [runSale, runSaleRefund, runCloseRefund, runClose];
        const results = await Promise.allSettled(jobs.map((job) => job()));

        for (const result of results) {
          if (result.status === "rejected")
            expect(
              (result.reason as { code?: string }).code,
              String(result.reason),
            ).not.toBe("40P01");
          expect(
            result.status,
            String((result as { reason?: unknown }).reason),
          ).toBe("fulfilled");
        }
        for (const result of results) {
          const value = (result as PromiseFulfilledResult<unknown>).value as {
            status?: number;
            body?: unknown;
          };
          if (typeof value?.status === "number")
            expect(value.status, JSON.stringify(value.body)).toBe(200);
        }
        // Facts on one intent never share an instant.
        expect((await refundCompletedAt(saleRefund)).getTime()).not.toBe(
          (await saleCompletedAt(sale.orderUuid)).getTime(),
        );
        expect((await refundCompletedAt(closeRefund)).getTime()).not.toBe(
          (await reservationClosedAt(toClose.reservationId)).getTime(),
        );
      } finally {
        setPaymentRefundGateway(null);
      }
    },
  );
});
