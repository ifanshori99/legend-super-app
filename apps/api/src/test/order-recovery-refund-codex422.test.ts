// legend-pbwzq (Codex 422 fixes on top of legend-pti5r): written FIRST, so the
// cases below fail on 095b4099 and pass once the fixes land.
//
// Fixes covered:
// - T1/T1b (finding 1) the replay of a final-failed recovery refund runs for EVERY
//   order, promo or not, pay-first or open bill: reporting the item again refunds
//   the failed refund's amount and the same `order.refunded` split, and the new
//   filing records which issue it replays (`replayOfIssueId`).
// - T2/T2b (finding 2) a `rejected` refund owes no money (legend-h1dyy): reporting
//   the item again answers `nothing_left` on EVERY order, not only promo orders.
// - T3 (finding 3) the predecessor of a replay is the issue FILED first/last, not
//   the issue CREATED last: issue B created before issue A, A filed and failed
//   finally, then B filed -> B replays A.
// - T5 (finding 5) the failure hook run again for the same failed refund writes
//   nothing new: audit rows per action, outbox events and the issue stamp stay.
// - Tenant isolation: one assertion inside T3 (promo variant).
//
// Assumptions where the brief is not exact:
// - World: one tenant with the promotion of order-recovery-refund-promo-final-
//   failure.test.ts (buy 2 of {kopi, teh}, get 1 roti free) used ONLY by the promo
//   variant of T3. Every "no promo" case orders the items `bulatA`, `bulatB`, `besar`,
//   which are in no promotion, so no promotion application exists for them.
// - Rounding: `bulatA`/`bulatB` cost Rp1.003 each (x1,155 = 1.158,465 with service
//   and PBJT), chosen so a cumulative split can land on 1.158 or 1.159 depending on
//   what was refunded before. Whether the recomputed amount really differs is not
//   fixed by the spec, so the tests read amounts from the first filing and compare,
//   and they ALSO assert the stored `replayOfIssueId` of the new filing (the
//   idempotency response `order-recovery-refund:<issueId>`, as in the pti5r
//   T10 tests), which is the deterministic proof that a replay happened.
// - T1 files an unrelated second line (bulatB) between the failure and the new
//   report, so the recomputation position of the reported line changes.
// - T3 forces issue B by SQL with `created_at` one hour BEFORE issue A (the
//   reporting API replays an open issue for the same line, so two open issues on one
//   line cannot be made through it; order-recovery-rereport.test.ts does the same).
//   B is resolved only after A's refund failed finally (else resolve answers 409).
// - T5: "unknown" is a NULL `failure_reason` (check constraint), as in the pti5r
//   test. The footprint of a hook run is every audit_logs / domain_event_outbox
//   row whose JSON mentions the issue id, the refund id or the order id, grouped
//   by action/name, plus `order_issues.refund_rejected_at`. The refile_limit case is
//   in the LAST describe because it inserts a refund approval policy.

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
import { settleRefundFromChain } from "../services/payment-refund.service.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import {
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

// Each case builds a paid order through the HTTP flow; allow for a loaded machine.
vi.setConfig({ testTimeout: 120_000 });

let w: World;
const freeRotiPromotion = randomUUID();
/** Rp1.003 items and a Rp20.000 item, all in no promotion. */
const bulatA = randomUUID();
const bulatB = randomUUID();
const besar = randomUUID();
const BULAT_PRICE = 1_003;
const BESAR_PRICE = 20_000;

beforeAll(async () => {
  w = await createWorld();
  await asOwnerTenant(w.tenant.tenantId, async (client) => {
    // Auto promotion (no code): buy 2 of {kopi, teh}, get 1 roti free.
    await client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
          budget_idr)
       VALUES ($1, $2, 'Beli 2 minuman gratis roti', '', 'active', NULL, false,
               now() - interval '1 hour', NULL, $3, $4, 'g_pbwzq', true, 0, NULL, NULL, NULL)`,
      [
        freeRotiPromotion,
        w.tenant.tenantId,
        JSON.stringify([
          {
            kind: "item_quantity",
            menuItemIds: [w.ids.kopi, w.ids.teh],
            minQuantity: 2,
          },
        ]),
        JSON.stringify({
          kind: "free_items",
          menuItemIds: [w.ids.roti],
          quantityPerMultiple: 1,
        }),
      ],
    );
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
const KOPI_REFUND = 8_085;
const KOPI_PAYOUT = 7_000;
const KOPI_SUBTOTAL = 25_000;
const FINAL_REASONS = [
  "provider_declined",
  "cap_exceeded",
  "source_document",
  "unknown",
];

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
 * with evidence (rows inserted directly, as the cashier flow leaves it; the guest
 * cannot pay an open bill through the API).
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
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'pbwzq-test')`,
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
  expect(reported.status).toBe(201);
  const issueId = reported.body.data.id as string;
  return { issueId, event: await resolveForRefund(issueId, amountIdr) };
}

type RefundRow = {
  id: string;
  amount_idr: number;
  status: string;
  failure_reason: string | null;
};

async function issueRefunds(issueId: string): Promise<RefundRow[]> {
  const { rows } = await owner.query<RefundRow>(
    `SELECT id, amount_idr::int AS amount_idr, status, failure_reason FROM payment_refunds
      WHERE tenant_id = $1 AND order_issue_id = $2 ORDER BY created_at, id`,
    [w.tenant.tenantId, issueId],
  );
  return rows;
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

/** The idempotency response of a filing: it names the issue a replay re-filed. */
async function replayOf(issueId: string): Promise<unknown> {
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM payment_admin_idempotency
      WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
  );
  expect(rows, "filing idempotency row").toHaveLength(1);
  return rows[0]!.response.replayOfIssueId;
}

async function filingPayout(issueId: string): Promise<number> {
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM payment_admin_idempotency
      WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
  );
  return Number(rows[0]?.response?.promoRecordedIdr ?? 0);
}

async function ledgerOf(
  tenantId: string,
  orderId: string,
): Promise<{ paid: number; subtotal: number } | null> {
  const { rows } = await owner.query<{
    refunded_paid_idr: number;
    refunded_subtotal_idr: number;
  }>(
    `SELECT refunded_paid_idr::int, refunded_subtotal_idr::int
       FROM promotion_order_applications
      WHERE tenant_id = $1 AND order_id = $2`,
    [tenantId, toUuid(orderId)],
  );
  return rows[0]
    ? {
        paid: rows[0].refunded_paid_idr,
        subtotal: rows[0].refunded_subtotal_idr,
      }
    : null;
}

async function rejectedAtOf(issueId: string): Promise<string | null> {
  const { rows } = await owner.query<{ refund_rejected_at: Date | null }>(
    "SELECT refund_rejected_at FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  expect(rows, "issue row").toHaveLength(1);
  return rows[0]!.refund_rejected_at?.toISOString() ?? null;
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

// "unknown" is how the hook reads a NULL failure_reason; the column's check
// constraint does not accept the literal.
async function setFailed(refundId: string, reason: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = NULLIF($3, 'unknown'), decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, refundId, reason],
  );
}

async function failFinally(refundId: string, reason: string) {
  await setFailed(refundId, reason);
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

function expectBlocked(blocked: Record<string, unknown>[]) {
  expect(blocked).toHaveLength(1);
  expect(JSON.stringify(blocked[0])).toContain("nothing_left");
}

// ---- T1 / T1b: replay on orders without promo ---------------------------------

describe("legend-pbwzq T1 pesanan pay-first tanpa promo: lapor ulang setelah gagal final", () => {
  it.each(FINAL_REASONS)(
    "%s: refund baru sama persis dengan yang gagal (jumlah dan split order.refunded); dicatat sebagai replay",
    async (reason) => {
      const paid = await paidOrder("pay_first", [bulatA, bulatB, besar]);
      const a = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);
      await failFinally(a.refund.id, reason);

      // Another line is refunded meanwhile, so a recomputation would stand elsewhere.
      await filedRefund(paid.line(bulatB).id, BULAT_PRICE);

      const again = await approvedRefund(paid.line(bulatA).id, BULAT_PRICE);
      expect(again.issueId).not.toBe(a.issueId);
      await deliver(again.event);

      expect(
        (await issueRefunds(again.issueId)).map((row) => row.amount_idr),
      ).toEqual([a.refund.amount_idr]);
      expect(
        await auditRows([again.issueId], "order_issue.refund_blocked"),
      ).toEqual([]);
      const events = await refundedEvents(paid.order.id);
      expect(events).toHaveLength(3);
      const first = events.find((event) => event.refundId === a.issueId)!;
      const replay = events.find((event) => event.refundId === again.issueId)!;
      for (const field of SPLIT_FIELDS)
        expect(replay[field], field).toBe(first[field]);
      expect(await replayOf(again.issueId)).toBe(a.issueId);
    },
  );
});

describe("legend-pbwzq T1b pesanan open bill tanpa promo: lapor ulang setelah gagal final", () => {
  it("provider_declined: refund baru sama persis dengan yang gagal; dicatat sebagai replay; tanpa order.refunded", async () => {
    const paid = await paidOrder("open_bill", [bulatA, bulatB, besar]);
    const a = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);
    await failFinally(a.refund.id, "provider_declined");
    await filedRefund(paid.line(bulatB).id, BULAT_PRICE);

    const again = await approvedRefund(paid.line(bulatA).id, BULAT_PRICE);
    expect(again.issueId).not.toBe(a.issueId);
    await deliver(again.event);

    expect(
      (await issueRefunds(again.issueId)).map((row) => row.amount_idr),
    ).toEqual([a.refund.amount_idr]);
    expect(
      await auditRows([again.issueId], "order_issue.refund_blocked"),
    ).toEqual([]);
    // Open bill files no split and no order.refunded, replay or not.
    expect(await refundedEvents(paid.order.id)).toHaveLength(0);
    expect(await replayOf(again.issueId)).toBe(a.issueId);
  });
});

// ---- T2 / T2b: rejected refunds owe nothing, on every order -------------------

describe("legend-pbwzq T2 pesanan tanpa promo: refund rejected lalu item dilaporkan ulang", () => {
  it("pay-first: tidak ada refund baru, audit refund_blocked nothing_left, tidak ada order.refunded baru", async () => {
    const paid = await paidOrder("pay_first", [bulatA, besar]);
    const a = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);
    await failFinally(a.refund.id, "rejected");

    const again = await approvedRefund(paid.line(bulatA).id, BULAT_PRICE);
    expect(again.issueId).not.toBe(a.issueId);
    await deliver(again.event);

    expect(await issueRefunds(again.issueId)).toEqual([]);
    expectBlocked(
      await auditRows([again.issueId], "order_issue.refund_blocked"),
    );
    expect(
      (await refundedEvents(paid.order.id)).map((event) => event.refundId),
    ).toEqual([a.issueId]);
  });

  it("open bill: tidak ada refund baru, audit refund_blocked nothing_left", async () => {
    const paid = await paidOrder("open_bill", [bulatA, besar]);
    const a = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);
    await failFinally(a.refund.id, "rejected");

    const again = await approvedRefund(paid.line(bulatA).id, BULAT_PRICE);
    await deliver(again.event);

    expect(await issueRefunds(again.issueId)).toEqual([]);
    expectBlocked(
      await auditRows([again.issueId], "order_issue.refund_blocked"),
    );
  });
});

// ---- T3: predecessor by filing order, not by issue creation order -------------

/**
 * Inserts a second, open issue for the line by SQL (the API would replay), with
 * `created_at` as given. Same recipe as order-recovery-rereport.test.ts.
 */
async function forceOpenIssue(
  orderId: string,
  itemId: string,
  createdAt: Date,
) {
  const issueId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [w.tenant.tenantId],
    );
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, cost_idr, status, idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock', 'Dipaksa lewat SQL',
         $6, 0, 'open', $7, $8)`,
      [
        issueId,
        w.tenant.tenantId,
        w.tenant.outletId,
        toUuid(orderId),
        toUuid(itemId),
        w.supervisor.userId,
        `forced-${randomUUID()}`,
        createdAt,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return issueId;
}

async function createdAtOf(issueId: string): Promise<Date> {
  const { rows } = await owner.query<{ created_at: Date }>(
    "SELECT created_at FROM order_issues WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, issueId],
  );
  return rows[0]!.created_at;
}

/** B is created an hour BEFORE A. A is filed and fails finally; then B is filed. */
async function bBeforeA(
  orderId: string,
  itemId: string,
  amountIdr: number,
  reason: string,
) {
  const a = await filedRefund(itemId, amountIdr);
  const bCreatedAt = new Date(
    (await createdAtOf(a.issueId)).getTime() - 3_600_000,
  );
  const bIssueId = await forceOpenIssue(orderId, itemId, bCreatedAt);
  await failFinally(a.refund.id, reason);
  const bEvent = await resolveForRefund(bIssueId, amountIdr);
  await deliver(bEvent);
  return { a, bIssueId };
}

describe("legend-pbwzq T3 urutan: issue B dibuat sebelum A, A diproses dan gagal final dulu", () => {
  it("tanpa promo (pay-first): B memakai ulang jumlah dan split A", async () => {
    const paid = await paidOrder("pay_first", [bulatA, besar]);

    const { a, bIssueId } = await bBeforeA(
      paid.order.id,
      paid.line(bulatA).id,
      BULAT_PRICE,
      "provider_declined",
    );

    expect((await issueRefunds(bIssueId)).map((row) => row.amount_idr)).toEqual(
      [a.refund.amount_idr],
    );
    expect(await auditRows([bIssueId], "order_issue.refund_blocked")).toEqual(
      [],
    );
    const events = await refundedEvents(paid.order.id);
    const first = events.find((event) => event.refundId === a.issueId)!;
    const replay = events.find((event) => event.refundId === bIssueId)!;
    for (const field of SPLIT_FIELDS)
      expect(replay[field], field).toBe(first[field]);
    expect(await replayOf(bIssueId)).toBe(a.issueId);
  });

  it("dengan promo: B memakai ulang jumlah A (bukan nothing_left); ledger tidak berubah; tenant lain tidak tersentuh", async () => {
    const other = await createIsolatedTenant(
      `pbwzq-${randomUUID().slice(0, 6)}`,
    );
    const paid = await paidPromoOrder();
    // Another tenant's application for the same order id must stay as it is.
    await asOwnerTenant(other.tenantId, (client) =>
      client.query(
        `INSERT INTO promotion_order_applications
           (tenant_id, outlet_id, order_id, request_fingerprint, channel, subtotal_idr,
            total_discount_idr, paid_idr, refunded_paid_idr, refunded_subtotal_idr, result,
            status)
         VALUES ($1, $2, $3, $4, 'dine_in', 50000, 10000, 40000, 5000, 9000, '{}'::jsonb, 'applied')`,
        [
          other.tenantId,
          other.outletId,
          toUuid(paid.order.id),
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
        ],
      ),
    );

    const { a, bIssueId } = await bBeforeA(
      paid.order.id,
      paid.kopi.id,
      KOPI_SUBTOTAL,
      "provider_declined",
    );

    expect(a.refund.amount_idr).toBe(KOPI_REFUND);
    expect((await issueRefunds(bIssueId)).map((row) => row.amount_idr)).toEqual(
      [KOPI_REFUND],
    );
    expect(await auditRows([bIssueId], "order_issue.refund_blocked")).toEqual(
      [],
    );
    expect(await replayOf(bIssueId)).toBe(a.issueId);
    // No second payout on the promo ledger.
    expect(await ledgerOf(w.tenant.tenantId, paid.order.id)).toEqual({
      paid: KOPI_PAYOUT,
      subtotal: KOPI_SUBTOTAL,
    });
    expect(await filingPayout(bIssueId)).toBe(0);
    expect(await ledgerOf(other.tenantId, paid.order.id)).toEqual({
      paid: 5_000,
      subtotal: 9_000,
    });
  });
});

/** A paid pay-first promo order kopi + teh + roti (total 42.735, see pti5r tests). */
async function paidPromoOrder() {
  const paid = await paidOrder("pay_first", [
    w.ids.kopi,
    w.ids.teh,
    w.ids.roti,
  ]);
  const { rows } = await owner.query<{ total_idr: number }>(
    "SELECT total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
    [w.tenant.tenantId, toUuid(paid.order.id)],
  );
  expect(rows[0]!.total_idr, "promo order total").toBe(42_735);
  return { ...paid, kopi: paid.line(w.ids.kopi) };
}

// ---- T5: the failure hook is idempotent --------------------------------------

/** What a hook run may write: audit rows and outbox events about the issue. */
async function footprint(orderId: string, issueId: string, refundId: string) {
  const patterns = [`%${issueId}%`, `%${refundId}%`, `%${orderId}%`];
  const audits = await owner.query<{ action: string; n: number }>(
    `SELECT event->>'action' AS action, count(*)::int AS n FROM audit_logs
      WHERE tenant_id = $1 AND event::text LIKE ANY($2::text[])
      GROUP BY 1 ORDER BY 1`,
    [w.tenant.tenantId, patterns],
  );
  const outbox = await owner.query<{ name: string; n: number }>(
    `SELECT event->>'name' AS name, count(*)::int AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND event::text LIKE ANY($2::text[])
      GROUP BY 1 ORDER BY 1`,
    [w.tenant.tenantId, patterns],
  );
  return {
    audits: audits.rows,
    outbox: outbox.rows,
    stamp: await rejectedAtOf(issueId),
    refunds: (await issueRefunds(issueId)).map((row) => [
      row.id,
      row.status,
      row.amount_idr,
    ]),
  };
}

describe("legend-pbwzq T5 hook kegagalan dipanggil dua kali untuk refund gagal yang sama", () => {
  it.each(["rejected", "provider_declined", "unknown"])(
    "%s: panggilan kedua tidak menambah audit per action, event outbox, refund, maupun stamp",
    async (reason) => {
      const paid = await paidOrder("pay_first", [bulatA, besar]);
      const a = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);
      await setFailed(a.refund.id, reason);

      await runHook(a.refund.id);
      const afterOnce = await footprint(paid.order.id, a.issueId, a.refund.id);
      expect(afterOnce.stamp, "stamped by the first run").not.toBeNull();

      await runHook(a.refund.id);

      expect(await footprint(paid.order.id, a.issueId, a.refund.id)).toEqual(
        afterOnce,
      );
    },
  );
});

// LAST describe of the file: it adds a refund approval policy for the tenant so
// refunds open approval chains (expiring a chain fails the refund; the third
// failure is `refile_limit`).
describe("legend-pbwzq T5 refile_limit: hook diulang setelah batas pengajuan ulang", () => {
  beforeAll(async () => {
    await owner.query(
      `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
       VALUES ($1, 'refund', 0, $2, 1)`,
      [w.tenant.tenantId, w.ids.supervisorRole],
    );
  });

  it("tiga approval kedaluwarsa lalu hook dijalankan lagi dua kali: audit refile_blocked, event, stamp tidak bertambah", async () => {
    const paid = await paidOrder("pay_first", [bulatA, besar]);
    const a = await filedRefund(paid.line(bulatA).id, BULAT_PRICE);
    const context = contextOf(w.tenant.tenantId);
    let currentId = a.refund.id;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await owner.query(
        "UPDATE approval_requests SET status = 'expired' WHERE tenant_id = $1 AND object_type = 'payment_refund' AND object_id = $2",
        [w.tenant.tenantId, currentId],
      );
      const settled = await settleRefundFromChain(context, currentId);
      expect(settled.status).toBe("failed");
      const refunds = await issueRefunds(a.issueId);
      // Failures 1 and 2 re-file; the third is final (no fourth refund).
      expect(refunds, `refunds after failure ${attempt}`).toHaveLength(
        Math.min(attempt + 1, 3),
      );
      if (attempt < 3)
        currentId = refunds.find((row) => row.status === "pending")!.id;
    }
    expect(await rejectedAtOf(a.issueId), "stamped").not.toBeNull();
    const afterSettle = await footprint(paid.order.id, a.issueId, currentId);

    await runHook(currentId);
    await runHook(currentId);

    expect(await footprint(paid.order.id, a.issueId, currentId)).toEqual(
      afterSettle,
    );
  });
});
