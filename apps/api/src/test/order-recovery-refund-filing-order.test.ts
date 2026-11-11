// legend-ti19m (Codex 423 P1): the predecessor of a replay must be chosen by a
// MONOTONIC filing order, not by `payment_refunds.created_at`. Written FIRST: the
// clock-skew and tie cases below fail on 326bfbfa and pass once the filing
// sequence lands.
//
// Why created_at is not enough: it is the "fact time" of the filing, which is only
// `>= max(completed_at)`. A host clock that steps back, or a timestamp tie, makes a
// later filing look older than an earlier one. Then: A fails finally, B is filed
// (replays A) and is `rejected`, and C picks A (not B) as predecessor and opens the
// refund again, so a `rejected` amount is paid.
//
// Cases:
// - S1 clock skew: B's refund `created_at` is OLDER than A's, B is `rejected`; C must
//   end `nothing_left` (predecessor B), and no refund is opened for C (pay-first and
//   open bill).
// - S2 timestamp tie (regression guard): A and B have the SAME `created_at`; once
//   with B's refund id below A's and once above; C must still pick B. The old code
//   broke ties on the ISSUE id, which these tests do not force, so S2 is not a
//   fail-first proof (S1 and S4a are).
// - S3 other direction (regression guard): B's `created_at` is older than A's and B
//   fails finally for a non-rejected reason; C replays the chain with B's exact
//   amount and split. B itself replayed A, and the chain stores its ROOT, so
//   `replayOfIssueId` of C is A (same as order-recovery-refund-promo-final-failure).
// - S4 legacy data: filings WITHOUT a sequence rank below every filing with one, and
//   among themselves keep the old order. Covered as (a) A legacy + B sequenced with B
//   older by created_at -> B wins, (b) all legacy in normal time -> old behaviour.
// - S5 regression: the plain chain A -> B -> C (no skew) still replays the latest.
// - S6 the sequence itself: strictly increasing per order across lines, stored in the
//   `order-recovery-refund:<issueId>` idempotency response and in the
//   `order_issue.refund_requested` audit row.
//
// Assumptions where the brief is not exact:
// - The T3 order case of pbwzq stays in order-recovery-refund-codex422.test.ts.
// - The brief's "A rejected, then B final non-rejected, then C replays B" cannot be
//   made through the API (a rejected line answers nothing_left and gets no refund
//   row, see pbwzq T2). S3 therefore uses A `provider_declined` and B `cap_exceeded`
//   with B's clock older than A's; what it pins is the same: the latest FILED issue is
//   the predecessor.
// - The skew and the tie are forced by SQL on `payment_refunds.created_at` (and on
//   the refund `id` for the tie) under `session_replication_role = replica`, after
//   the filing. A sequence stored at filing time is unaffected by this, which is the
//   point. The tie-break the old code used (refund id or issue id) is not known to
//   the tests: S2 runs both id orders, so on the old code at least the skew cases
//   (S1, S3, S4a) fail deterministically and S2 may pass by luck of the tie-break.
// - The stored key is `filingSeq` (idempotency response and audit), as the brief
//   names it. Its first value is not fixed; S6 only asserts integers that strictly
//   increase in filing order.
// - Money: amounts are Rp1.003 items (x1,155 with service and PBJT). The amount of
//   the first filing is read from the DB and compared exactly with later filings; the
//   "owed money" assertions are exact (0 rows for a blocked C, exactly that amount
//   for a replay).

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { orderRefundedPayloadSchema } from "@starter/shared/pos";
import { and, eq } from "drizzle-orm";
import { originHeader } from "./helpers.ts";
import { db } from "../db/index.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { withTenant } from "../db/tenant.ts";
import {
  deliverOrderRecoveryRefundEvent,
  refileRecoveryRefundAfterFailure,
} from "../services/order-recovery-refund.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import {
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

// Each case builds a paid order through the HTTP flow; allow for a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

let w: World;
/** Rp1.003 items and a Rp20.000 item, all in no promotion. */
const bulatA = randomUUID();
const bulatB = randomUUID();
const besar = randomUUID();
const BULAT_PRICE = 1_003;
const BESAR_PRICE = 20_000;

beforeAll(async () => {
  w = await createWorld();
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    for (const [id, name, price] of [
      [bulatA, "Kue Bulat A", BULAT_PRICE],
      [bulatB, "Kue Bulat B", BULAT_PRICE],
      [besar, "Nasi Besar", BESAR_PRICE],
    ] as const) {
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [
          id,
          w.tenant.tenantId,
          w.tenant.brandId,
          w.ids.category,
          name,
          randomUUID(),
        ],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), w.tenant.tenantId, w.ids.priceList, id, price],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const REASON = "Pelanggan menolak ganti menu dan voucher";

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toUuid = (id: string) => (UUID.test(id) ? id : ulidToUuid(id));

async function deliver(event: EventEnvelope) {
  const context = contextOf(w.tenant.tenantId);
  return withTenant(db, context, (tx) =>
    deliverOrderRecoveryRefundEvent(context, event, tx),
  );
}

/** The verified webhook settles the intent; its payment.paid reaches the order. */
async function payVerified(intentId: string, amountIdr: number) {
  const context = contextOf(w.tenant.tenantId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [w.tenant.tenantId, intentId],
  );
  const event = eventEnvelopeSchema.parse(rows[0]!.event);
  return withTenant(db, context, (tx) =>
    deliverQrOrderPaymentEvent(context, event, event.id, tx),
  );
}

type PaidOrder = {
  order: { id: string; items: { id: string; menuItemId: string }[] };
  line: (menuItemId: string) => { id: string; menuItemId: string };
};

/** Seats a guest, adds one of each item, checks out. */
async function placeLines(
  mode: "pay_first" | "open_bill",
  menuItemIds: string[],
) {
  const guest = await w.seat(mode);
  if (mode === "open_bill") {
    // The first order of an open-bill session waits for a waiter's confirmation.
    const confirmed = await w.floorStaff.client
      .post(`/api/table-sessions/${guest.sessionId}/confirm`)
      .set(w.headers)
      .set(originHeader);
    expect(confirmed.status).toBe(200);
  }
  let version = 0;
  for (const menuItemId of menuItemIds) {
    const added = await w
      .as(guest)
      .add({ menuItemId, quantity: 1, expectedCartVersion: version });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    version = added.body.data.cart.version as number;
  }
  const placed = await w.as(guest).checkout({
    expectedCartVersion: version,
    idempotencyKey: randomUUID(),
  });
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const order = placed.body.data.order as PaidOrder["order"];
  const { rows } = await owner.query<{ outlet_id: string; total_idr: number }>(
    "SELECT outlet_id, total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, toUuid(order.id)],
  );
  return {
    guest,
    order,
    outletId: rows[0]!.outlet_id,
    total: rows[0]!.total_idr,
    line: (menuItemId: string) =>
      order.items.find((item) => item.menuItemId === menuItemId)!,
  };
}

/**
 * A PAID order of the given items. Pay-first: the guest pays through the API and
 * the verified webhook settles it. Open bill: the bill is settled by a paid intent
 * with evidence (rows inserted directly, as the cashier flow leaves it).
 */
async function paidOrder(
  mode: "pay_first" | "open_bill",
  menuItemIds: string[],
): Promise<PaidOrder> {
  const placed = await placeLines(mode, menuItemIds);
  if (mode === "pay_first") {
    const payment = await w
      .as(placed.guest)
      .pay({ kind: "order", orderId: placed.order.id });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    expect(await payVerified(payment.body.data.id, placed.total)).toBe(true);
    return placed;
  }
  const orderId = toUuid(placed.order.id);
  const linkId = randomUUID();
  const intentId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'ti19m-test')`,
    [
      linkId,
      w.tenant.tenantId,
      placed.outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `OB-${linkId.slice(0, 8)}`,
      placed.total,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, order_id, method, provider,
        amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, $5, 'qris', 'doit', $6, $7, 'paid',
             '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}',
             now() + interval '1 hour', now())`,
    [
      intentId,
      w.tenant.tenantId,
      placed.outletId,
      linkId,
      orderId,
      placed.total,
      `ob-${intentId}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [
      w.tenant.tenantId,
      placed.outletId,
      intentId,
      `evidence-${intentId}`,
      placed.total,
    ],
  );
  await owner.query(
    "UPDATE orders SET payment_intent_id = $3 WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, orderId, intentId],
  );
  return placed;
}

/** Resolves an open issue `manual_refund` with an approved approval; returns the event. */
async function resolveForRefund(issueId: string, amountIdr: number) {
  const approvalId = await w.insertApproval({
    actionType: "refund",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "manual_refund",
      approvalRequestId: approvalId,
      reason: REASON,
    },
  );
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  const rows = await w.outboxRows(
    "order_issue.manual_refund_approved",
    issueId,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.event;
}

/** Reports one line as failed and resolves it with an approved ORD-09 refund. */
async function approvedRefund(itemId: string, amountIdr: number) {
  const reported = await w.report(itemId);
  expect(reported.status, JSON.stringify(reported.body)).toBe(201);
  const issueId = reported.body.data.id as string;
  return { issueId, event: await resolveForRefund(issueId, amountIdr) };
}

type RefundRow = {
  id: string;
  amount_idr: number;
  status: string;
  failure_reason: string | null;
  created_at: Date;
};

async function issueRefunds(issueId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id, amount_idr::int AS amount_idr, status, failure_reason, created_at
       FROM payment_refunds
      WHERE tenant_id = $1 AND order_issue_id = $2 ORDER BY created_at, id`,
    [w.tenant.tenantId, issueId],
  );
  return rows;
}

/** Money still owed through these issues: every refund that is not `failed`. */
async function liveRefundTotal(issueIds: string[]): Promise<number> {
  const { rows } = await owner.query<{ total: number }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::int AS total FROM payment_refunds
      WHERE tenant_id = $1 AND order_issue_id = ANY($2::uuid[]) AND status <> 'failed'`,
    [w.tenant.tenantId, issueIds],
  );
  return rows[0]!.total;
}

async function auditRows(objectIds: string[], action: string) {
  const { rows } = await owner.query<{ event: Record<string, unknown> }>(
    `SELECT event FROM audit_logs
     WHERE tenant_id = $1 AND event->>'action' = $2 AND event->>'objectId' = ANY($3::text[])`,
    [w.tenant.tenantId, action, objectIds],
  );
  return rows.map((row) => row.event);
}

async function refundedEvents(orderId: string) {
  return (await w.outboxRows("order.refunded", orderId)).map((row) =>
    orderRefundedPayloadSchema.parse(row.event.payload),
  );
}

const SPLIT_FIELDS = [
  "amountIdr",
  "grossSalesIdr",
  "discountIdr",
  "serviceChargeIdr",
  "pbjtIdr",
] as const;

async function filingResponse(
  issueId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM payment_admin_idempotency
      WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
  );
  expect(rows, "filing idempotency row").toHaveLength(1);
  return rows[0]!.response;
}

/** The issue a filing replayed (`replayOfIssueId` of its idempotency response). */
async function replayOf(issueId: string): Promise<unknown> {
  return (await filingResponse(issueId)).replayOfIssueId;
}

async function filingSeqOf(issueId: string): Promise<number> {
  const seq = (await filingResponse(issueId)).filingSeq;
  expect(typeof seq, `filingSeq of ${issueId}`).toBe("number");
  return seq as number;
}

/** Runs the failure hook on a refund row as `failRefund` does. */
async function runHook(refundId: string) {
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentRefunds)
      .where(
        and(
          eq(paymentRefunds.tenantId, context.tenant.tenantId),
          eq(paymentRefunds.id, refundId),
        ),
      );
    await refileRecoveryRefundAfterFailure(tx, context, row!, new Date());
  });
}

async function failFinally(refundId: string, reason: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = $3, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, refundId, reason],
  );
  await runHook(refundId);
}

/** Files the refund of one line and returns the issue and its single refund row. */
async function filedRefund(itemId: string, amountIdr: number) {
  const made = await approvedRefund(itemId, amountIdr);
  await deliver(made.event);
  const refunds = await issueRefunds(made.issueId);
  expect(refunds, "first filing makes one refund").toHaveLength(1);
  return { ...made, refund: refunds[0]! };
}

/** Reports the line again and delivers the approved refund: this is "C". */
async function reportAgain(itemId: string) {
  const again = await approvedRefund(itemId, BULAT_PRICE);
  await deliver(again.event);
  return again;
}

/**
 * Rewrites columns of a refund row by SQL, like a host clock that stepped back.
 * `replica` mode keeps immutability triggers and FK checks out of the way.
 */
async function forceRefund(
  refundId: string,
  set: { createdAt?: Date; newId?: string },
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [w.tenant.tenantId],
    );
    if (set.createdAt) {
      await client.query(
        "UPDATE payment_refunds SET created_at = $3 WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, refundId, set.createdAt],
      );
    }
    if (set.newId) {
      await client.query(
        "UPDATE payment_refunds SET id = $3 WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, refundId, set.newId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** A failed (final) and B filed as its replay; both have exactly one refund row. */
async function failedThenReplayed(itemId: string) {
  const a = await filedRefund(itemId, BULAT_PRICE);
  await failFinally(a.refund.id, "provider_declined");
  const b = await filedRefund(itemId, BULAT_PRICE);
  // Setup check (true on the old code too): B really replayed A.
  expect(await replayOf(b.issueId), "B replays A").toBe(a.issueId);
  expect(b.refund.amount_idr).toBe(a.refund.amount_idr);
  return { a, b };
}

const HOUR_MS = 3_600_000;

function expectBlocked(blocked: Record<string, unknown>[]) {
  expect(blocked).toHaveLength(1);
  expect(JSON.stringify(blocked[0])).toContain("nothing_left");
}

/** C must be blocked: no refund row, an audit `nothing_left`, no money owed for A, B or C. */
async function expectNothingLeft(
  orderId: string,
  a: { issueId: string },
  b: { issueId: string },
  c: { issueId: string },
) {
  expect(await issueRefunds(c.issueId)).toEqual([]);
  expectBlocked(await auditRows([c.issueId], "order_issue.refund_blocked"));
  expect(await liveRefundTotal([a.issueId, b.issueId, c.issueId])).toBe(0);
  expect(
    (await refundedEvents(orderId)).map((event) => event.refundId).sort(),
  ).toEqual([a.issueId, b.issueId].sort());
}

// ---- S1: clock skew -----------------------------------------------------------

describe("legend-ti19m S1 jam mundur: refund B lebih tua dari A menurut created_at, B ditolak", () => {
  it("pay-first: C berakhir nothing_left (pendahulu B), bukan replay A; tidak ada uang terutang", async () => {
    const paid = await paidOrder("pay_first", [bulatA, besar]);
    const { a, b } = await failedThenReplayed(paid.line(bulatA).id);
    await forceRefund(b.refund.id, {
      createdAt: new Date(a.refund.created_at.getTime() - HOUR_MS),
    });
    await failFinally(b.refund.id, "rejected");

    const c = await reportAgain(paid.line(bulatA).id);

    await expectNothingLeft(paid.order.id, a, b, c);
  });

  it("open bill: C berakhir nothing_left (pendahulu B), tidak ada refund baru", async () => {
    const paid = await paidOrder("open_bill", [bulatA, besar]);
    const { a, b } = await failedThenReplayed(paid.line(bulatA).id);
    await forceRefund(b.refund.id, {
      createdAt: new Date(a.refund.created_at.getTime() - HOUR_MS),
    });
    await failFinally(b.refund.id, "rejected");

    const c = await reportAgain(paid.line(bulatA).id);

    expect(await issueRefunds(c.issueId)).toEqual([]);
    expectBlocked(await auditRows([c.issueId], "order_issue.refund_blocked"));
    expect(await liveRefundTotal([a.issueId, b.issueId, c.issueId])).toBe(0);
  });
});

// ---- S2: timestamp tie --------------------------------------------------------

describe("legend-ti19m S2 timestamp seri: refund A dan B created_at sama persis", () => {
  it.each([
    ["id refund B di bawah id A", "00000000"],
    ["id refund B di atas id A", "ffffffff"],
  ])(
    "%s: C tetap memilih B (diajukan belakangan), nothing_left",
    async (_, prefix) => {
      const paid = await paidOrder("pay_first", [bulatA, besar]);
      const { a, b } = await failedThenReplayed(paid.line(bulatA).id);
      const bRefundId = `${prefix}${randomUUID().slice(8)}`;
      await forceRefund(b.refund.id, {
        createdAt: a.refund.created_at,
        newId: bRefundId,
      });
      const [bRefund] = await issueRefunds(b.issueId);
      expect(bRefund!.id).toBe(bRefundId);
      expect(bRefund!.created_at.getTime()).toBe(a.refund.created_at.getTime());
      await failFinally(bRefund!.id, "rejected");

      const c = await reportAgain(paid.line(bulatA).id);

      await expectNothingLeft(paid.order.id, a, b, c);
    },
  );
});

// ---- S3: the other direction --------------------------------------------------

describe("legend-ti19m S3 arah sebaliknya: B gagal final bukan rejected, jamnya lebih tua dari A", () => {
  it("C me-replay rantai B (akar A) dengan jumlah dan split B yang persis", async () => {
    const paid = await paidOrder("pay_first", [bulatA, besar]);
    const { a, b } = await failedThenReplayed(paid.line(bulatA).id);
    await forceRefund(b.refund.id, {
      createdAt: new Date(a.refund.created_at.getTime() - HOUR_MS),
    });
    await failFinally(b.refund.id, "cap_exceeded");

    const c = await reportAgain(paid.line(bulatA).id);

    // The chain stores its root: B replayed A, so C records A.
    expect(await replayOf(c.issueId)).toBe(a.issueId);
    expect(
      (await issueRefunds(c.issueId)).map((row) => row.amount_idr),
    ).toEqual([a.refund.amount_idr]);
    expect(await auditRows([c.issueId], "order_issue.refund_blocked")).toEqual(
      [],
    );
    // Only C's refund is live: exactly the failed amount, never twice.
    expect(await liveRefundTotal([a.issueId, b.issueId, c.issueId])).toBe(
      a.refund.amount_idr,
    );
    const events = await refundedEvents(paid.order.id);
    expect(events).toHaveLength(3);
    const first = events.find((event) => event.refundId === b.issueId)!;
    const replay = events.find((event) => event.refundId === c.issueId)!;
    for (const field of SPLIT_FIELDS)
      expect(replay[field], field).toBe(first[field]);
  });
});

// ---- S4: legacy filings without a sequence ------------------------------------

/** Removes the sequence from a filing, as a row written before this fix. */
async function stripSeq(issueId: string) {
  const { rowCount } = await owner.query(
    `UPDATE payment_admin_idempotency SET response = response - 'filingSeq'
      WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
  );
  expect(rowCount).toBe(1);
}

describe("legend-ti19m S4 data lama tanpa filingSeq", () => {
  it("A lama (tanpa seq), B ber-seq tetapi created_at lebih tua: B menang, C nothing_left", async () => {
    const paid = await paidOrder("pay_first", [bulatA, besar]);
    const a = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);
    await failFinally(a.refund.id, "provider_declined");
    await stripSeq(a.issueId);
    const b = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);
    expect(await replayOf(b.issueId), "B replays A").toBe(a.issueId);
    await forceRefund(b.refund.id, {
      createdAt: new Date(a.refund.created_at.getTime() - HOUR_MS),
    });
    await failFinally(b.refund.id, "rejected");

    const c = await reportAgain(paid.line(bulatA).id);

    await expectNothingLeft(paid.order.id, a, b, c);
  });

  it("semua lama, waktu normal: urutan lama (created_at lalu id) tetap, C nothing_left", async () => {
    const paid = await paidOrder("pay_first", [bulatA, besar]);
    const { a, b } = await failedThenReplayed(paid.line(bulatA).id);
    await stripSeq(a.issueId);
    await stripSeq(b.issueId);
    await failFinally(b.refund.id, "rejected");

    const c = await reportAgain(paid.line(bulatA).id);

    await expectNothingLeft(paid.order.id, a, b, c);
  });
});

// ---- S5: regression, the plain chain ------------------------------------------

describe("legend-ti19m S5 regresi: rantai A -> B -> C tanpa jam miring", () => {
  it("B gagal final non-rejected: C me-replay B dengan jumlah yang sama", async () => {
    const paid = await paidOrder("pay_first", [bulatA, besar]);
    const { a, b } = await failedThenReplayed(paid.line(bulatA).id);
    await failFinally(b.refund.id, "provider_declined");

    const c = await reportAgain(paid.line(bulatA).id);

    // The chain stores its root: B replayed A, so C records A.
    expect(await replayOf(c.issueId)).toBe(a.issueId);
    expect(
      (await issueRefunds(c.issueId)).map((row) => row.amount_idr),
    ).toEqual([a.refund.amount_idr]);
    expect(await liveRefundTotal([a.issueId, b.issueId, c.issueId])).toBe(
      a.refund.amount_idr,
    );
  });

  it("B ditolak: C nothing_left", async () => {
    const paid = await paidOrder("pay_first", [bulatA, besar]);
    const { a, b } = await failedThenReplayed(paid.line(bulatA).id);
    await failFinally(b.refund.id, "rejected");

    const c = await reportAgain(paid.line(bulatA).id);

    await expectNothingLeft(paid.order.id, a, b, c);
  });
});

// ---- S6: the sequence itself --------------------------------------------------

describe("legend-ti19m S6 nomor urut filing", () => {
  it("naik tegas menurut urutan pengajuan per pesanan, di respons idempotensi dan audit refund_requested", async () => {
    const paid = await paidOrder("pay_first", [bulatA, bulatB, besar]);
    const a = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);
    await failFinally(a.refund.id, "provider_declined");
    const other = await filedRefund(paid.line(bulatB).id, BULAT_PRICE);
    const b = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);

    const seqA = await filingSeqOf(a.issueId);
    const seqOther = await filingSeqOf(other.issueId);
    const seqB = await filingSeqOf(b.issueId);
    expect(Number.isInteger(seqA)).toBe(true);
    expect(seqOther).toBeGreaterThan(seqA);
    expect(seqB).toBeGreaterThan(seqOther);

    for (const [issueId, seq] of [
      [a.issueId, seqA],
      [other.issueId, seqOther],
      [b.issueId, seqB],
    ] as const) {
      const requested = await auditRows(
        [issueId],
        "order_issue.refund_requested",
      );
      expect(requested, issueId).toHaveLength(1);
      expect(JSON.stringify(requested[0])).toContain(`"filingSeq":${seq}`);
    }
  });
});
