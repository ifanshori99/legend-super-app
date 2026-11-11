// legend-ykk88 (SO Codex 535 P2), fail-first. Money facts of one bill (tagihan)
// must be monotonic in commit order: a POS refund must be stamped AFTER the
// lock, at a time later than every refund fact already committed on the bill,
// whatever clock the request read before it waited for the lock.
//
// Why it matters (Q63): a later refund's payout is re-validated "as of its
// decision time" (approvedBefore = decided_at), counting only refunds stamped
// at or before that time. A refund stamped with a stale pre-lock clock lands
// BEFORE an earlier-committed refund and is wrongly counted against that
// refund's approver, so a legitimate refund is quarantined. The fix must also
// keep the money rules: nobody is paid more than paid, and over-limit refunds
// stay rejected.
//
// Written from brief docs/briefs/fix-ykk88-c79uy.md section A, the Q63 notes in
// docs/release-notes-pos-refund-ceilings.md and the public exports of the
// refund services; the fixture shapes are copied from pos-refund-ceilings.test.ts.
//
// Assumptions:
// - A refund fact "already on the bill" is a completed admin refund whose
//   decided_at/completed_at lie in the future (+60 s), the state a bumped fact
//   clock leaves behind. The request's own clock (`new Date()`, the default of
//   `now`) is therefore stale against it, exactly as after a lock wait.
// - "Monotonic" means strictly later: the new fact is stamped after the latest
//   fact on the bill and never ties (same rule as lockIntentsForFact).
// - A+ (second opinion Codex on m1): the supervisor's approval of an overpayment
//   refund is simulated by a real, held transaction on the owner pool that
//   locks the bill's pos_orders row, then writes the completed fund refund with
//   decided_at = completed_at = clock_timestamp() (T1) while the POS refund
//   (its clock T0 read before) is queued on that lock. Queued is proven by
//   waitForLockWaiters, never by sleeping. order_events.payload carries the
//   same refundedAt as pos_order_refunds.refunded_at (payload key `refundedAt`).
// - The payout re-validation primitive is `refundApprovalWithinLimit(...,
//   { historical: true, approvedBefore: decidedAt })`, called the way
//   payment-refund.service.ts calls it when it decides to quarantine.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { posOverrideIdSchema } from "@starter/shared/access/override";
import { createApp } from "../app";
import { db } from "../db";
import { paymentRefunds } from "../db/schema/index";
import { withTenant } from "../db/tenant";
import { outletContext } from "../services/device-pin-support";
import { refundApprovalWithinLimit } from "../services/payment-refund-approval-limits";
import { refundPosOrder } from "../services/pos-order-corrections";
import { agent, signUp } from "./helpers";
import {
  owner,
  seededOutletA,
  seededTenantId,
  staffWithRole,
  waitForLockWaiters,
  type Staff,
} from "./floor-test-helpers";
import { pinOverrideFixtureFingerprint } from "./pos-override-fixture";

type Level = "supervisor" | "outlet_manager" | "owner";
type Sale = { orderId: string; intentId: string; paid: number };

const app = createApp();
const approvers = new Map<Level, string>();
const users: string[] = [];
const orderUuids: string[] = [];
const intentIds: string[] = [];
const linkIds: string[] = [];
const overrideUuids: string[] = [];
const fundsToDrop: string[] = [];
let cashier: Staff;

const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asOwner<T>(
  run: (client: PoolClient) => Promise<T>,
  replica = false,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

/** A completed POS sale paid in full by one physical EDC tender (no drawer, no provider). */
async function sale(paid: number): Promise<Sale> {
  const orderId = createUlid();
  const orderUuid = ulidToUuid(orderId);
  const intentId = randomUUID();
  const linkId = randomUUID();
  orderUuids.push(orderUuid);
  intentIds.push(intentId);
  linkIds.push(linkId);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type,
         payment_mode, subtotal_idr, discount_idr, service_charge_idr, tax_idr,
         rounding_idr, total_idr, status, business_date, placed_at)
       VALUES ($1, $2, $3, $4, 'pos', 'takeaway', 'pay_first', $5, 0, 0, 0, 0, $5,
         'completed', '2031-03-16', now())`,
      [orderUuid, seededTenantId, seededOutletA, `YKK-${orderId}`, paid],
    );
    await client.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at, completed_at)
       VALUES ($1, $2, $3, 'pos', now(), now())`,
      [orderUuid, seededTenantId, seededOutletA],
    );
    await client.query(
      `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference,
         subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomBytes(32).toString("hex"),
        `YKK-${linkId}`,
        paid,
        cashier.userId,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id,
         order_id, method, provider, amount_idr, idempotency_key, status, paid_at,
         instructions, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid', now(),
         '{"method":"qris","qrPayload":"test","issuer":null}', now() + interval '1 hour')`,
      [
        intentId,
        seededTenantId,
        seededOutletA,
        linkId,
        orderUuid,
        paid,
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
         amount_idr, status, reference, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'edc_card', 'edc', $4, 'captured', $5, now(), now())`,
      [seededTenantId, seededOutletA, orderUuid, paid, `BANK-${orderId}`],
    );
  });
  return { orderId, intentId, paid };
}

async function approval(bill: Sale, amountIdr: number, approvedBy: string) {
  const overrideId = createUlid();
  overrideUuids.push(ulidToUuid(overrideId));
  const reason = "Pengembalian waktu fakta ykk88";
  await asOwner((client) =>
    client.query(
      `INSERT INTO pos_overrides (id, tenant_id, outlet_id, action, method, status,
       requested_by, approved_by, reason, value_idr, object_type, object_id,
       request_fingerprint, created_at, resolved_at)
     VALUES ($1, $2, $3, 'refund', 'supervisor_pin', 'approved', $4, $5, $6,
       $7, 'order', $8, $9, now(), now())`,
      [
        ulidToUuid(overrideId),
        seededTenantId,
        seededOutletA,
        cashier.userId,
        approvedBy,
        reason,
        amountIdr,
        bill.orderId,
        pinOverrideFixtureFingerprint({
          requestedBy: cashier.userId,
          outletId: seededOutletA,
          action: "refund",
          valueIdr: amountIdr,
          reason,
          objectType: "order",
          objectId: bill.orderId,
          approverUserId: approvedBy,
        }),
      ],
    ),
  );
  return {
    overrideId: posOverrideIdSchema.parse(overrideId),
    approvedBy: userIdSchema.parse(approvedBy),
  };
}

/** `now` is the app clock the request read BEFORE it waited for the lock. */
async function refund(
  bill: Sale,
  amountIdr: number,
  level: Level,
  now?: Date,
) {
  const verified = await approval(bill, amountIdr, approvers.get(level)!);
  return refundPosOrder(
    scope(),
    {
      userId: userIdSchema.parse(cashier.userId),
      deviceId: null,
      expectedVersion: null,
    },
    outletIdSchema.parse(seededOutletA),
    bill.orderId,
    {
      idempotencyKey: randomUUID(),
      amountIdr,
      reason: "quality_complaint",
      reasonNote: "Pengembalian waktu fakta ykk88",
      ...verified,
    },
    now,
  );
}

/**
 * A completed admin refund already committed on the bill. `offsetSeconds` moves
 * its fact time (decided_at = completed_at) relative to the DB clock; a positive
 * offset is a fact the request's own clock has not reached yet.
 */
async function adminRefund(
  bill: Sale,
  amountIdr: number,
  offsetSeconds: number,
  approvedBy: string,
) {
  const id = randomUUID();
  await asOwner((client) =>
    client.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id,
         amount_idr, reason, status, requested_by, approved_by, decided_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'Riwayat refund admin', 'completed', 'ykk88-admin',
         $6, clock_timestamp() + $7::interval, clock_timestamp() + $7::interval)`,
      [
        id,
        seededTenantId,
        seededOutletA,
        bill.intentId,
        amountIdr,
        approvedBy,
        `${offsetSeconds} seconds`,
      ],
    ),
  );
  return id;
}

async function nativeTotal(bill: Sale) {
  const result = await owner.query<{ total: string }>(
    "SELECT coalesce(sum(amount_idr), 0)::text AS total FROM pos_order_refunds WHERE tenant_id = $1 AND order_id = $2",
    [seededTenantId, ulidToUuid(bill.orderId)],
  );
  return Number(result.rows[0]!.total);
}

/** True when the native refund's fact time is strictly after the admin refund's decision and completion. */
async function nativeStampedAfterAdmin(nativeId: string, adminId: string) {
  const result = await owner.query<{ after: boolean }>(
    `SELECT n.refunded_at > r.decided_at AND n.refunded_at > r.completed_at AS after
       FROM pos_order_refunds n, payment_refunds r
      WHERE n.tenant_id = $1 AND n.id = $2 AND r.tenant_id = $1 AND r.id = $3`,
    [seededTenantId, nativeId, adminId],
  );
  return result.rows[0]!.after;
}

/**
 * What the payout step asks before it quarantines `refundId`: is its recorded
 * approver still within the ceiling, counting only refunds stamped up to the
 * refund's own decision time (historical authority)?
 */
async function revalidatesWithinLimit(refundId: string, approver: string) {
  const context = outletContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(seededTenantId),
      brandId: null,
      source: "session",
    }),
    outletIdSchema.parse(seededOutletA),
  );
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, seededTenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    if (!row) throw new Error("Missing refund");
    const decidedAt = row.decidedAt ?? new Date();
    return refundApprovalWithinLimit(tx, context, approver, row, decidedAt, {
      historical: true,
      approvedBefore: decidedAt,
    });
  });
}

beforeAll(async () => {
  cashier = await staffWithRole(app, {
    template: "cashier",
    label: "YKK88 POS cashier",
  });
  users.push(cashier.userId);
  for (const level of ["supervisor", "outlet_manager", "owner"] as const) {
    const client = agent(app);
    await signUp(client, `YKK88 POS ${level}`);
    const session = await client.get("/api/auth/get-session");
    const id = session.body.user.id as string;
    users.push(id);
    approvers.set(level, id);
    const roles = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = $2",
      [seededTenantId, level],
    );
    if (!roles.rows[0]) throw new Error(`Missing role ${level}`);
    const outletScoped = level !== "owner";
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 hour', $2)`,
      [
        seededTenantId,
        id,
        roles.rows[0].id,
        outletScoped ? "outlet" : "tenant",
        outletScoped ? seededOutletA : null,
      ],
    );
  }
});

afterAll(async () => {
  await asOwner(async (client) => {
    for (const table of [
      "pos_order_refunds",
      "pos_order_tenders",
      "pos_order_approval_uses",
      "order_events",
      "pos_orders",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
        [seededTenantId, orderUuids],
      );
    await client.query("DELETE FROM pos_overrides WHERE id = ANY($1::uuid[])", [
      overrideUuids,
    ]);
    await client.query(
      "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query(
      "DELETE FROM payment_unallocated_funds WHERE id = ANY($1::uuid[])",
      [fundsToDrop],
    );
    await client.query(
      "DELETE FROM payment_intents WHERE id = ANY($1::uuid[])",
      [intentIds],
    );
    await client.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
      linkIds,
    ]);
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderUuids,
    ]);
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [seededTenantId, users],
    );
  }, true);
  await owner.end();
});

describe("POS-04 legend-ykk88 refund fact time is monotonic per bill after the lock", () => {
  it("a POS refund is stamped after a refund fact already committed on the bill, even when its own clock is older", async () => {
    const bill = await sale(400_000);
    const earlier = await adminRefund(bill, 50_000, 60, approvers.get("owner")!);
    const result = await refund(bill, 100_000, "owner");
    expect(Number(result.amountIdr)).toBe(100_000);
    expect(await nativeStampedAfterAdmin(result.id, earlier)).toBe(true);
  });

  it("two POS refunds read with the same app clock get strictly increasing fact times", async () => {
    const bill = await sale(400_000);
    const sameClock = new Date();
    const first = await refund(bill, 50_000, "owner", sameClock);
    const second = await refund(bill, 50_000, "owner", sameClock);
    const times = await owner.query<{ later: boolean }>(
      `SELECT b.refunded_at > a.refunded_at AS later
         FROM pos_order_refunds a, pos_order_refunds b
        WHERE a.tenant_id = $1 AND a.id = $2 AND b.tenant_id = $1 AND b.id = $3`,
      [seededTenantId, first.id, second.id],
    );
    expect(times.rows[0]!.later).toBe(true);
  });

  it("a legitimate Rp150000 supervisor refund is not over the ceiling just because a later Rp100000 POS refund carried a stale clock", async () => {
    const bill = await sale(400_000);
    // R: decided first (fact time in the future of this request's clock).
    const first = await adminRefund(bill, 150_000, 60, approvers.get("supervisor")!);
    // P: committed second by an outlet manager (own ceiling Rp1.000.000), legitimate.
    const second = await refund(bill, 100_000, "outlet_manager");
    // P came after R, so R's historical authority must not count P:
    // Rp150000 <= Rp200000 supervisor ceiling, no quarantine.
    expect(await nativeStampedAfterAdmin(second.id, first)).toBe(true);
    expect(
      await revalidatesWithinLimit(first, approvers.get("supervisor")!),
    ).toBe(true);
    expect(await nativeTotal(bill)).toBe(100_000);
  });

  it("control: a refund that really did come before still counts, so a supervisor whose cumulative total passed Rp200000 stays rejected", async () => {
    const bill = await sale(400_000);
    await adminRefund(bill, 150_000, -60, approvers.get("owner")!);
    const later = await adminRefund(bill, 100_000, 0, approvers.get("supervisor")!);
    expect(
      await revalidatesWithinLimit(later, approvers.get("supervisor")!),
    ).toBe(false);
  });

  it("control: a POS refund committed before an admin refund counts against that refund's approver (Rp100000 + Rp150000 > Rp200000)", async () => {
    const bill = await sale(400_000);
    await refund(bill, 100_000, "outlet_manager");
    const later = await adminRefund(bill, 150_000, 5, approvers.get("supervisor")!);
    expect(
      await revalidatesWithinLimit(later, approvers.get("supervisor")!),
    ).toBe(false);
  });

  it("a supervisor POS refund over the ceiling is still rejected when the bill already holds a later-stamped refund; nothing is written", async () => {
    const bill = await sale(400_000);
    await adminRefund(bill, 150_000, 60, approvers.get("owner")!);
    await expect(refund(bill, 100_000, "supervisor")).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await nativeTotal(bill)).toBe(0);
  });

  it("a refund above Rp200000 by a supervisor is still rejected under a future-dated fact", async () => {
    const bill = await sale(400_000);
    await adminRefund(bill, 10_000, 60, approvers.get("owner")!);
    await expect(refund(bill, 200_001, "supervisor")).rejects.toMatchObject({
      code: "REFUND_APPROVAL_LIMIT_EXCEEDED",
    });
    expect(await nativeTotal(bill)).toBe(0);
  });

  it("concurrent owner refunds on a bill with a future-dated fact never pay out more than was paid", async () => {
    const bill = await sale(300_000);
    const earlier = await adminRefund(bill, 50_000, 60, approvers.get("owner")!);
    // 50k admin + 200k + 200k would be 450k on a 300k bill: only one POS refund fits.
    const attempts = await Promise.allSettled([
      refund(bill, 200_000, "owner"),
      refund(bill, 200_000, "owner"),
    ]);
    const done = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof refund>>
      > => attempt.status === "fulfilled",
    );
    expect(done).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected")).toHaveLength(1);
    expect(await nativeTotal(bill)).toBe(200_000);
    expect(50_000 + (await nativeTotal(bill))).toBeLessThanOrEqual(bill.paid);
    expect(await nativeStampedAfterAdmin(done[0]!.value.id, earlier)).toBe(
      true,
    );
  });

  it("the sum of POS refunds never exceeds what was paid: a refund of Rp1 above the balance is rejected", async () => {
    const bill = await sale(300_000);
    await adminRefund(bill, 100_000, 60, approvers.get("owner")!);
    await expect(refund(bill, 200_001, "owner")).rejects.toBeDefined();
    expect(await nativeTotal(bill)).toBe(0);
    const ok = await refund(bill, 200_000, "owner");
    expect(Number(ok.amountIdr)).toBe(200_000);
    await expect(refund(bill, 1, "owner")).rejects.toBeDefined();
    expect(await nativeTotal(bill)).toBe(200_000);
  });
});

/**
 * Two real transactions (A+): the POS refund reads its clock at T0 and queues
 * on the bill's pos_orders row lock held by a competing transaction, which
 * records a supervisor-approved Rp150000 overpayment refund (fact time T1 > T0)
 * and commits. Returns the POS outcome and the competing refund's id.
 */
async function posRefundQueuedBehindOverpaymentApproval(
  bill: Sale,
  level: Level,
  amountIdr: number,
) {
  const fundId = randomUUID();
  const refundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, 150000, 'overpayment')`,
    [fundId, seededTenantId, seededOutletA, bill.intentId],
  );
  const holder = await owner.connect();
  let pending: ReturnType<typeof refund> | undefined;
  try {
    await holder.query("BEGIN");
    await holder.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    await holder.query(
      "SELECT 1 FROM pos_orders WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE",
      [seededTenantId, ulidToUuid(bill.orderId)],
    );
    const t0 = new Date(); // the POS request's clock, read before it waits
    pending = refund(bill, amountIdr, level, t0);
    pending.catch(() => undefined); // surfaced by the await below
    await waitForLockWaiters(1);
    // T1: the supervisor's decision, taken while the POS refund is queued.
    await holder.query(
      `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id,
         amount_idr, reason, status, requested_by, approved_by, decided_at,
         completed_at, unallocated_fund_id)
       VALUES ($1, $2, $3, $4, 150000, 'Kembalikan kelebihan bayar', 'completed',
         'system:test', $5, clock_timestamp(), clock_timestamp(), $6)`,
      [
        refundId,
        seededTenantId,
        seededOutletA,
        bill.intentId,
        approvers.get("supervisor")!,
        fundId,
      ],
    );
    await holder.query("COMMIT");
  } catch (error) {
    await holder.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    holder.release();
  }
  const settled = await Promise.allSettled([pending!]);
  return { outcome: settled[0]!, refundId, fundId };
}

describe("POS-04 legend-ykk88 A+ two real transactions: POS refund queued on the pos_orders lock", () => {
  it("owner Rp100000 refund (clock T0) committing after the supervisor's Rp150000 overpayment refund (T1) is stamped after T1, so the supervisor payout is not quarantined", async () => {
    const bill = await sale(400_000);
    const { outcome, refundId, fundId } =
      await posRefundQueuedBehindOverpaymentApproval(bill, "owner", 100_000);
    fundsToDrop.push(fundId);
    expect(outcome.status).toBe("fulfilled");
    const posRefund = (outcome as PromiseFulfilledResult<{ id: string }>)
      .value;
    // Persistence: refunded_at follows commit order (after T1), never T0.
    expect(await nativeStampedAfterAdmin(posRefund.id, refundId)).toBe(true);
    // Events: order.refunded carries the same fact time as the row.
    const stored = await owner.query<{ at: Date; event_at: string }>(
      `SELECT n.refunded_at AS at, e.payload->>'refundedAt' AS event_at
         FROM pos_order_refunds n
         JOIN order_events e ON e.tenant_id = n.tenant_id
          AND e.order_id = n.order_id AND e.type = 'order.refunded'
        WHERE n.tenant_id = $1 AND n.id = $2`,
      [seededTenantId, posRefund.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(
      Math.abs(
        new Date(stored.rows[0]!.event_at).getTime() -
          stored.rows[0]!.at.getTime(),
      ),
    ).toBeLessThanOrEqual(1);
    // Rp150000 (supervisor, decided first) is within Rp200000: the Rp250000
    // total includes a refund that came after it and must not count against it.
    expect(await revalidatesWithinLimit(refundId, approvers.get("supervisor")!)).toBe(
      true,
    );
    // Money: both refunds together stay within what was paid.
    expect(150_000 + (await nativeTotal(bill))).toBeLessThanOrEqual(bill.paid);
  });

  it("control: a supervisor POS refund Rp100000 queued behind the same Rp150000 approval is rejected after the lock (Rp250000 > Rp200000); nothing is written", async () => {
    const bill = await sale(400_000);
    const { outcome, fundId } = await posRefundQueuedBehindOverpaymentApproval(
      bill,
      "supervisor",
      100_000,
    );
    fundsToDrop.push(fundId);
    expect(outcome).toMatchObject({
      status: "rejected",
      reason: { code: "REFUND_APPROVAL_LIMIT_EXCEEDED" },
    });
    expect(await nativeTotal(bill)).toBe(0);
  });

  it("control: an owner POS refund above what is left of the paid amount is rejected after the lock; the total never exceeds paid", async () => {
    const bill = await sale(100_000);
    // The overpayment refund does not reduce the paid cap, so Rp100000 fits...
    const { outcome, fundId } = await posRefundQueuedBehindOverpaymentApproval(
      bill,
      "owner",
      100_000,
    );
    fundsToDrop.push(fundId);
    expect(outcome.status).toBe("fulfilled");
    // ...but one more rupiah of the bill is never refundable.
    await expect(refund(bill, 1, "owner")).rejects.toBeDefined();
    expect(await nativeTotal(bill)).toBe(100_000);
    expect(await nativeTotal(bill)).toBeLessThanOrEqual(bill.paid);
  });
});
