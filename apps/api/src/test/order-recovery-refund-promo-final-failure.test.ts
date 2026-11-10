// legend-pti5r: a recovery refund (ORD-09) on a promo order that ends in a FINAL
// failure (`provider_declined`, `cap_exceeded`, `source_document`, `refile_limit`)
// must give the promo payout back. The first filing put the goods payout on the
// promo ledger (`promotion_order_applications.refunded_paid_idr`, amount in the
// first filing's `payment_admin_idempotency.response.promoRecordedIdr`). If the
// refund then fails for good, the line is reported again as a NEW issue; without
// the give-back the recompute sees the payout as already paid and answers
// `nothing_left`: the guest's money is stuck.
//
// World = order-recovery-refund-promo.test.ts (promotion "buy 2 of {kopi, teh},
// get 1 roti free"; order total 42.735):
// - kopi refund: 8.085, goods payout (promoRecordedIdr) 7.000;
// - after kopi, roti refund: 20.790, goods payout 18.000 (ledger total 25.000).
//
// Cases:
// - PF-1 final failure (each of three reasons) returns the payout (ledger back to
//   0), writes one `promo_application.payout_returned` audit, and the same line
//   reported again is refunded 8.085 (not `nothing_left`).
// - PF-2 the failure hook run twice gives back once (one idempotency row, one
//   audit, ledger decreased once).
// - PF-3 `rejected` keeps the payout; a re-report still gets nothing_left (as
//   legend-h1dyy decided). A non-final `approval_expired` keeps it as well.
// - PF-4 two issues on one promo order both fail finally, concurrently: each
//   payout returned exactly, ledger ends at 0 (never below).
// - PF-5 tenant isolation of the port.
// - PF-6 port: released application -> 0 without throwing; no application -> 0;
//   same key with another payout -> 409 IDEMPOTENCY_KEY_REUSED; replay gives
//   back once; never returns more than the ledger holds (paid and subtotal).
// - PF-7 (architect review of dbe08344) the give-back also lowers
//   `refunded_subtotal_idr` by the line's share (first filing response
//   `promoRefundedSubtotalIdr`), so a re-report keeps the first filing's
//   `order.refunded` gross and discount; a returned issue's item is not
//   "processed" for another issue's recompute (roti does not absorb the kopi
//   payout); the promo-return key is not a valid client Idempotency-Key.
//
// Assumptions where the brief is not exact:
// - The audit `objectId` of `promo_application.payout_returned` is the order id
//   (ULID form, as the API shows it); the check accepts the uuid form too.
// - The re-reported kopi line (PF-1) is refunded 8.085 again: the kept lines
//   leave out the kopi of both issues (teh + roti kept, goods due 7.000 once the
//   payout is back), same split as the first filing.
// - The port is called with the order id in ULID form (`orderIdSchema`).

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
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
import { idempotencyKeySchema } from "@starter/shared/core";
import { orderRefundedPayloadSchema } from "@starter/shared/pos";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { paymentRefunds } from "../db/schema/payment-admin.ts";
import { withTenant } from "../db/tenant.ts";
import { promoPartialRefundPort } from "../services/crm-promo-refund.ts";
import { orderPromoPartialRefundPort } from "../services/order-promo-refund.ts";
import {
  deliverOrderRecoveryRefundEvent,
  orderRecoveryPromoReturnKey,
  refileRecoveryRefundAfterFailure,
} from "../services/order-recovery-refund.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import {
  asOwnerTenant,
  createWorld,
  type World,
} from "./order-recovery-helpers.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

let w: World;
const freeRotiPromotion = randomUUID();

beforeAll(async () => {
  w = await createWorld();
  // Auto promotion (no code): buy 2 of {kopi, teh}, get 1 roti free.
  await asOwnerTenant(w.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
          budget_idr)
       VALUES ($1, $2, 'Beli 2 minuman gratis roti', '', 'active', NULL, false,
               now() - interval '1 hour', NULL, $3, $4, 'g_pti5r', true, 0, NULL, NULL, NULL)`,
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
    ),
  );
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const REASON = "Pelanggan menolak ganti menu dan voucher";
const ORDER_TOTAL = 42_735;
const KOPI_REFUND = 8_085;
const KOPI_PAYOUT = 7_000;
const ROTI_PAYOUT_AFTER_KOPI = 18_000;
const KOPI_SUBTOTAL = 25_000;

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

/** A paid pay-first order kopi + teh + roti with the live promo applied. */
async function paidPromoOrder() {
  const guest = await w.seat();
  let version = 0;
  for (const menuItemId of [w.ids.kopi, w.ids.teh, w.ids.roti]) {
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
  const order = placed.body.data.order as {
    id: string;
    items: { id: string; menuItemId: string }[];
  };
  const { rows } = await owner.query<{ total_idr: number }>(
    `SELECT total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, toUuid(order.id)],
  );
  expect(rows[0]!.total_idr, "promo order total").toBe(ORDER_TOTAL);
  const payment = await w.as(guest).pay({ kind: "order", orderId: order.id });
  expect(payment.status, JSON.stringify(payment.body)).toBe(201);
  expect(await payVerified(payment.body.data.id, ORDER_TOTAL)).toBe(true);
  const line = (menuItemId: string) =>
    order.items.find((item) => item.menuItemId === menuItemId)!;
  return { order, kopi: line(w.ids.kopi), roti: line(w.ids.roti) };
}

/** Reports one line as failed and resolves it with an approved ORD-09 refund. */
async function approvedRefund(itemId: string, amountIdr: number) {
  const reported = await w.report(itemId);
  expect(reported.status).toBe(201);
  const issueId = reported.body.data.id as string;
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
  expect(resolved.status).toBe(200);
  const rows = await w.outboxRows(
    "order_issue.manual_refund_approved",
    issueId,
  );
  expect(rows).toHaveLength(1);
  return { issueId, event: rows[0]!.event };
}

async function issueRefunds(issueId: string) {
  const { rows } = await owner.query<{
    id: string;
    amount_idr: number;
    status: string;
  }>(
    `SELECT id, amount_idr::int AS amount_idr, status FROM payment_refunds
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

async function paidLedger(
  tenantId: string,
  orderId: string,
): Promise<number | null> {
  const { rows } = await owner.query<{ refunded_paid_idr: number }>(
    `SELECT refunded_paid_idr::int FROM promotion_order_applications
      WHERE tenant_id = $1 AND order_id = $2`,
    [tenantId, toUuid(orderId)],
  );
  return rows[0]?.refunded_paid_idr ?? null;
}

const orderLedger = async (orderId: string) => {
  const value = await paidLedger(w.tenant.tenantId, orderId);
  expect(value, "promo application row").not.toBeNull();
  return value!;
};

async function subtotalLedger(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ refunded_subtotal_idr: number }>(
    `SELECT refunded_subtotal_idr::int FROM promotion_order_applications
      WHERE tenant_id = $1 AND order_id = $2`,
    [w.tenant.tenantId, toUuid(orderId)],
  );
  return rows[0]!.refunded_subtotal_idr;
}

async function firstFilingSubtotal(issueId: string): Promise<number> {
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM payment_admin_idempotency
      WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
  );
  return Number(rows[0]?.response?.promoRefundedSubtotalIdr ?? 0);
}

async function firstFilingPayout(issueId: string): Promise<number> {
  const { rows } = await owner.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM payment_admin_idempotency
      WHERE tenant_id = $1 AND key = $2`,
    [w.tenant.tenantId, `order-recovery-refund:${issueId}`],
  );
  return Number(rows[0]?.response?.promoRecordedIdr ?? 0);
}

async function promoReturnRows(tenantId: string, issueId: string) {
  const { rows } = await owner.query<{ key: string; response: unknown }>(
    `SELECT key, response FROM promo_command_idempotency
      WHERE tenant_id = $1 AND key = $2`,
    [tenantId, orderRecoveryPromoReturnKey(issueId)],
  );
  return rows;
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

async function setFailed(refundId: string, reason: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'failed', failure_reason = $3, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, refundId, reason],
  );
}

/** Files the kopi refund of a fresh promo order (payout 7.000 on the ledger). */
async function kopiRefundFiled() {
  const paid = await paidPromoOrder();
  const kopi = await approvedRefund(paid.kopi.id, 25_000);
  await deliver(kopi.event);
  const refunds = await issueRefunds(kopi.issueId);
  expect(refunds.map((row) => row.amount_idr)).toEqual([KOPI_REFUND]);
  expect(await orderLedger(paid.order.id)).toBe(KOPI_PAYOUT);
  expect(await firstFilingPayout(kopi.issueId)).toBe(KOPI_PAYOUT);
  expect(await firstFilingSubtotal(kopi.issueId)).toBe(KOPI_SUBTOTAL);
  expect(await subtotalLedger(paid.order.id)).toBe(KOPI_SUBTOTAL);
  return { paid, kopi, refundId: refunds[0]!.id };
}

describe("legend-pti5r PF-1 refund gagal final mengembalikan payout promo", () => {
  it.each(["provider_declined", "cap_exceeded", "source_document"])(
    "%s: payout 7.000 kembali ke 0; lapor ulang baris yang sama direfund 8.085 (bukan nothing_left)",
    async (reason) => {
      const { paid, kopi, refundId } = await kopiRefundFiled();

      await setFailed(refundId, reason);
      await runHook(refundId);

      expect(await orderLedger(paid.order.id)).toBe(0);
      expect(await subtotalLedger(paid.order.id)).toBe(0);
      const returned = await auditRows(
        [paid.order.id, toUuid(paid.order.id)],
        "promo_application.payout_returned",
      );
      expect(returned).toHaveLength(1);
      expect(JSON.stringify(returned[0])).toContain(`${KOPI_PAYOUT}`);
      expect(JSON.stringify(returned[0])).toContain(`${KOPI_SUBTOTAL}`);
      expect(
        await promoReturnRows(w.tenant.tenantId, kopi.issueId),
      ).toHaveLength(1);

      // The guest still needs the money: the kitchen reports the line again.
      const again = await approvedRefund(paid.kopi.id, 25_000);
      expect(again.issueId).not.toBe(kopi.issueId);
      await deliver(again.event);
      expect(
        (await issueRefunds(again.issueId)).map((row) => row.amount_idr),
      ).toEqual([KOPI_REFUND]);
      expect(await orderLedger(paid.order.id)).toBe(KOPI_PAYOUT);
      expect(await subtotalLedger(paid.order.id)).toBe(KOPI_SUBTOTAL);
    },
  );
});

describe("legend-pti5r PF-2 idempotent", () => {
  it("hook dijalankan dua kali untuk refund gagal yang sama: dikembalikan sekali", async () => {
    const { paid, kopi, refundId } = await kopiRefundFiled();
    await setFailed(refundId, "provider_declined");

    await runHook(refundId);
    await runHook(refundId);

    expect(await orderLedger(paid.order.id)).toBe(0);
    expect(await subtotalLedger(paid.order.id)).toBe(0);
    expect(await promoReturnRows(w.tenant.tenantId, kopi.issueId)).toHaveLength(
      1,
    );
    expect(
      await auditRows(
        [paid.order.id, toUuid(paid.order.id)],
        "promo_application.payout_returned",
      ),
    ).toHaveLength(1);
  });
});

describe("legend-pti5r PF-3 payout tetap bila uang tidak terutang", () => {
  it("rejected: ledger tidak berubah, tanpa baris idempotensi; lapor ulang tetap nothing_left", async () => {
    const { paid, kopi, refundId } = await kopiRefundFiled();

    await setFailed(refundId, "rejected");
    await runHook(refundId);

    expect(await orderLedger(paid.order.id)).toBe(KOPI_PAYOUT);
    expect(await promoReturnRows(w.tenant.tenantId, kopi.issueId)).toHaveLength(
      0,
    );
    expect(
      await auditRows(
        [paid.order.id, toUuid(paid.order.id)],
        "promo_application.payout_returned",
      ),
    ).toHaveLength(0);

    const again = await approvedRefund(paid.kopi.id, 25_000);
    await deliver(again.event);
    expect(await issueRefunds(again.issueId)).toEqual([]);
    const blocked = await auditRows(
      [again.issueId],
      "order_issue.refund_blocked",
    );
    expect(blocked).toHaveLength(1);
    expect(JSON.stringify(blocked[0])).toContain("nothing_left");
    expect(await orderLedger(paid.order.id)).toBe(KOPI_PAYOUT);
  });

  it("approval_expired (diajukan ulang, bukan final): payout tetap di ledger", async () => {
    const { paid, kopi, refundId } = await kopiRefundFiled();

    await setFailed(refundId, "approval_expired");
    await runHook(refundId);

    expect(await orderLedger(paid.order.id)).toBe(KOPI_PAYOUT);
    expect(await subtotalLedger(paid.order.id)).toBe(KOPI_SUBTOTAL);
    expect(await promoReturnRows(w.tenant.tenantId, kopi.issueId)).toHaveLength(
      0,
    );
  });
});

describe("legend-pti5r PF-4 dua issue pada satu pesanan promo, keduanya gagal final", () => {
  it("bersamaan: tiap payout kembali tepat sekali, total 0, tidak pernah di bawah 0", async () => {
    const paid = await paidPromoOrder();
    const kopi = await approvedRefund(paid.kopi.id, 25_000);
    const roti = await approvedRefund(paid.roti.id, 18_000);
    await deliver(kopi.event);
    await deliver(roti.event);
    const kopiRefund = (await issueRefunds(kopi.issueId))[0]!;
    const rotiRefund = (await issueRefunds(roti.issueId))[0]!;
    expect(await firstFilingPayout(kopi.issueId)).toBe(KOPI_PAYOUT);
    expect(await firstFilingPayout(roti.issueId)).toBe(ROTI_PAYOUT_AFTER_KOPI);
    expect(await orderLedger(paid.order.id)).toBe(
      KOPI_PAYOUT + ROTI_PAYOUT_AFTER_KOPI,
    );

    await setFailed(kopiRefund.id, "provider_declined");
    await setFailed(rotiRefund.id, "cap_exceeded");
    await Promise.all([runHook(kopiRefund.id), runHook(rotiRefund.id)]);

    expect(await orderLedger(paid.order.id)).toBe(0);
    expect(await promoReturnRows(w.tenant.tenantId, kopi.issueId)).toHaveLength(
      1,
    );
    expect(await promoReturnRows(w.tenant.tenantId, roti.issueId)).toHaveLength(
      1,
    );
    const returned = await auditRows(
      [paid.order.id, toUuid(paid.order.id)],
      "promo_application.payout_returned",
    );
    expect(returned).toHaveLength(2);
  });

  it("satu gagal final, satu masih berjalan: hanya payout yang gagal kembali", async () => {
    const paid = await paidPromoOrder();
    const kopi = await approvedRefund(paid.kopi.id, 25_000);
    const roti = await approvedRefund(paid.roti.id, 18_000);
    await deliver(kopi.event);
    await deliver(roti.event);
    const rotiRefund = (await issueRefunds(roti.issueId))[0]!;

    await setFailed(rotiRefund.id, "provider_declined");
    await runHook(rotiRefund.id);

    expect(await orderLedger(paid.order.id)).toBe(KOPI_PAYOUT);
  });
});

// ============================================================================
// Port level (direct rows, no order flow)
// ============================================================================

async function seedApplication(input: {
  tenantId: string;
  outletId: string;
  orderId: string;
  refundedPaidIdr: number;
  refundedSubtotalIdr?: number;
  status?: "applied" | "released";
}) {
  await asOwnerTenant(input.tenantId, (client) =>
    client.query(
      `INSERT INTO promotion_order_applications
         (tenant_id, outlet_id, order_id, request_fingerprint, channel, subtotal_idr,
          total_discount_idr, paid_idr, refunded_paid_idr, refunded_subtotal_idr, result,
          status, released_at, release_reason)
       VALUES ($1, $2, $3, $4, 'dine_in', 50000, 10000, 40000, $5, $9, '{}'::jsonb, $6,
               $7::timestamptz, $8)`,
      [
        input.tenantId,
        input.outletId,
        toUuid(input.orderId),
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        input.refundedPaidIdr,
        input.status ?? "applied",
        input.status === "released" ? new Date().toISOString() : null,
        input.status === "released" ? "order dibatalkan" : null,
        input.refundedSubtotalIdr ?? 0,
      ],
    ),
  );
}

function giveBack(
  tenantId: string,
  input: {
    orderId: string;
    key: string;
    payoutIdr: number;
    refundedSubtotalIdr?: number;
  },
  port: typeof orderPromoPartialRefundPort = orderPromoPartialRefundPort,
) {
  const context = contextOf(tenantId);
  return withTenant(db, context, (tx) =>
    port.returnPartialRefundPayout(tx, context, {
      orderId: input.orderId,
      idempotencyKey: input.key,
      payoutIdr: input.payoutIdr,
      refundedSubtotalIdr: input.refundedSubtotalIdr ?? 0,
      at: new Date(),
    }),
  );
}

describe("legend-pti5r PF-5 isolasi tenant", () => {
  it("port dengan konteks tenant A tidak menyentuh aplikasi promo tenant B", async () => {
    const other = await createIsolatedTenant(
      `pti5r-${randomUUID().slice(0, 6)}`,
    );
    const sharedOrder = createUlid();
    const onlyInB = createUlid();
    await seedApplication({
      tenantId: w.tenant.tenantId,
      outletId: w.tenant.outletId,
      orderId: sharedOrder,
      refundedPaidIdr: 5_000,
    });
    await seedApplication({
      tenantId: other.tenantId,
      outletId: other.outletId,
      orderId: sharedOrder,
      refundedPaidIdr: 5_000,
    });
    await seedApplication({
      tenantId: other.tenantId,
      outletId: other.outletId,
      orderId: onlyInB,
      refundedPaidIdr: 4_000,
    });

    const own = await giveBack(w.tenant.tenantId, {
      orderId: sharedOrder,
      key: `pti5r-iso-${randomUUID()}`,
      payoutIdr: 3_000,
    });
    expect(own.returnedIdr).toBe(3_000);
    expect(await paidLedger(w.tenant.tenantId, sharedOrder)).toBe(2_000);
    expect(await paidLedger(other.tenantId, sharedOrder)).toBe(5_000);

    // Tenant A has no application for this order: nothing is returned and
    // tenant B's row is not reachable.
    const none = await giveBack(w.tenant.tenantId, {
      orderId: onlyInB,
      key: `pti5r-iso-${randomUUID()}`,
      payoutIdr: 4_000,
    });
    expect(none.returnedIdr).toBe(0);
    expect(await paidLedger(other.tenantId, onlyInB)).toBe(4_000);

    // The idempotency rows belong to tenant A only.
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM promo_command_idempotency
        WHERE tenant_id = $1 AND key LIKE 'pti5r-iso-%'`,
      [other.tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe("legend-pti5r PF-6 port returnPartialRefundPayout", () => {
  it("aplikasi dilepas (released): 0 tanpa error, ledger tidak berubah", async () => {
    const orderId = createUlid();
    await seedApplication({
      tenantId: w.tenant.tenantId,
      outletId: w.tenant.outletId,
      orderId,
      refundedPaidIdr: 4_000,
      status: "released",
    });

    const result = await giveBack(w.tenant.tenantId, {
      orderId,
      key: `pti5r-rel-${randomUUID()}`,
      payoutIdr: 4_000,
    });

    expect(result).toEqual({ returnedIdr: 0, returnedSubtotalIdr: 0 });
    expect(await paidLedger(w.tenant.tenantId, orderId)).toBe(4_000);
  });

  it("tanpa aplikasi promo: 0 tanpa error", async () => {
    const result = await giveBack(w.tenant.tenantId, {
      orderId: createUlid(),
      key: `pti5r-none-${randomUUID()}`,
      payoutIdr: 1_000,
    });
    expect(result).toEqual({ returnedIdr: 0, returnedSubtotalIdr: 0 });
  });

  it("kunci sama dengan payout berbeda: 409 IDEMPOTENCY_KEY_REUSED, ledger tidak berubah", async () => {
    const orderId = createUlid();
    const key = `pti5r-reuse-${randomUUID()}`;
    await seedApplication({
      tenantId: w.tenant.tenantId,
      outletId: w.tenant.outletId,
      orderId,
      refundedPaidIdr: 6_000,
    });
    expect(
      await giveBack(w.tenant.tenantId, { orderId, key, payoutIdr: 3_000 }),
    ).toEqual({ returnedIdr: 3_000, returnedSubtotalIdr: 0 });

    await expect(
      giveBack(w.tenant.tenantId, { orderId, key, payoutIdr: 2_000 }),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await paidLedger(w.tenant.tenantId, orderId)).toBe(3_000);
  });

  it("ulang dengan kunci dan payout sama: jawaban tersimpan, tidak dikembalikan dua kali", async () => {
    const orderId = createUlid();
    const key = `pti5r-replay-${randomUUID()}`;
    await seedApplication({
      tenantId: w.tenant.tenantId,
      outletId: w.tenant.outletId,
      orderId,
      refundedPaidIdr: 6_000,
    });

    const first = await giveBack(w.tenant.tenantId, {
      orderId,
      key,
      payoutIdr: 3_000,
    });
    const second = await giveBack(w.tenant.tenantId, {
      orderId,
      key,
      payoutIdr: 3_000,
    });

    expect(first).toEqual({ returnedIdr: 3_000, returnedSubtotalIdr: 0 });
    expect(second).toEqual({ returnedIdr: 3_000, returnedSubtotalIdr: 0 });
    expect(await paidLedger(w.tenant.tenantId, orderId)).toBe(3_000);
  });

  it("tidak mengembalikan lebih dari isi ledger (min), ledger tidak di bawah 0; juga lewat promoPartialRefundPort", async () => {
    const orderId = createUlid();
    await seedApplication({
      tenantId: w.tenant.tenantId,
      outletId: w.tenant.outletId,
      orderId,
      refundedPaidIdr: 2_500,
    });

    const result = await giveBack(
      w.tenant.tenantId,
      { orderId, key: `pti5r-min-${randomUUID()}`, payoutIdr: 9_000 },
      promoPartialRefundPort,
    );

    expect(result).toEqual({ returnedIdr: 2_500, returnedSubtotalIdr: 0 });
    expect(await paidLedger(w.tenant.tenantId, orderId)).toBe(0);
  });
});

describe("legend-pti5r PF-6b port: subtotal yang dikembalikan", () => {
  async function subtotalOf(tenantId: string, orderId: string) {
    const { rows } = await owner.query<{ refunded_subtotal_idr: number }>(
      `SELECT refunded_subtotal_idr::int FROM promotion_order_applications
        WHERE tenant_id = $1 AND order_id = $2`,
      [tenantId, toUuid(orderId)],
    );
    return rows[0]!.refunded_subtotal_idr;
  }

  it("menurunkan refunded_subtotal_idr sebesar min(input, ledger); ulang dengan kunci sama tidak menurunkan lagi", async () => {
    const orderId = createUlid();
    const key = `pti5r-sub-${randomUUID()}`;
    await seedApplication({
      tenantId: w.tenant.tenantId,
      outletId: w.tenant.outletId,
      orderId,
      refundedPaidIdr: 6_000,
      refundedSubtotalIdr: 10_000,
    });
    const input = {
      orderId,
      key,
      payoutIdr: 6_000,
      refundedSubtotalIdr: 25_000,
    };

    const first = await giveBack(w.tenant.tenantId, input);
    const second = await giveBack(w.tenant.tenantId, input);

    expect(first).toEqual({ returnedIdr: 6_000, returnedSubtotalIdr: 10_000 });
    expect(second).toEqual(first);
    expect(await paidLedger(w.tenant.tenantId, orderId)).toBe(0);
    expect(await subtotalOf(w.tenant.tenantId, orderId)).toBe(0);
  });

  it("subtotal saja (payout 0) tetap dikembalikan; kunci sama dengan subtotal lain: 409", async () => {
    const orderId = createUlid();
    const key = `pti5r-subonly-${randomUUID()}`;
    await seedApplication({
      tenantId: w.tenant.tenantId,
      outletId: w.tenant.outletId,
      orderId,
      refundedPaidIdr: 0,
      refundedSubtotalIdr: 12_000,
    });

    expect(
      await giveBack(w.tenant.tenantId, {
        orderId,
        key,
        payoutIdr: 0,
        refundedSubtotalIdr: 5_000,
      }),
    ).toEqual({ returnedIdr: 0, returnedSubtotalIdr: 5_000 });
    expect(await subtotalOf(w.tenant.tenantId, orderId)).toBe(7_000);
    await expect(
      giveBack(w.tenant.tenantId, {
        orderId,
        key,
        payoutIdr: 0,
        refundedSubtotalIdr: 4_000,
      }),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(await subtotalOf(w.tenant.tenantId, orderId)).toBe(7_000);
  });
});

describe("legend-pti5r PF-7 review arsitek", () => {
  it("kunci promo-return ditolak validator Idempotency-Key klien (tidak bisa di-pre-claim)", () => {
    const key = orderRecoveryPromoReturnKey(createUlid());
    expect(key).toMatch(/^order-recovery-refund:.+#promo-return$/);
    expect(idempotencyKeySchema.safeParse(key).success).toBe(false);
    // The first-filing key itself is a plain valid key shape (a different
    // table, payment_admin_idempotency), which is why this one differs.
    expect(
      idempotencyKeySchema.safeParse(`order-recovery-refund:${createUlid()}`)
        .success,
    ).toBe(true);
  });

  it("kopi gagal final lalu lapor ulang: order.refunded kedua punya gross dan diskon yang sama dengan filing pertama; ledger subtotal kembali lalu terisi lagi", async () => {
    const { paid, kopi, refundId } = await kopiRefundFiled();
    await setFailed(refundId, "provider_declined");
    await runHook(refundId);
    expect(await subtotalLedger(paid.order.id)).toBe(0);

    const again = await approvedRefund(paid.kopi.id, 25_000);
    await deliver(again.event);
    expect(
      (await issueRefunds(again.issueId)).map((row) => row.amount_idr),
    ).toEqual([KOPI_REFUND]);
    expect(await firstFilingSubtotal(again.issueId)).toBe(KOPI_SUBTOTAL);
    expect(await subtotalLedger(paid.order.id)).toBe(KOPI_SUBTOTAL);

    const events = (await w.outboxRows("order.refunded", paid.order.id)).map(
      (row) => orderRefundedPayloadSchema.parse(row.event.payload),
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.refundId).toBe(kopi.issueId);
    expect(events[1]!.refundId).toBe(again.issueId);
    expect(events[0]!.grossSalesIdr).toBe(25_000);
    expect(events[0]!.discountIdr).toBe(18_000);
    expect(events[1]!.grossSalesIdr).toBe(events[0]!.grossSalesIdr);
    expect(events[1]!.discountIdr).toBe(events[0]!.discountIdr);
    expect(events[1]!.amountIdr).toBe(events[0]!.amountIdr);
  });

  it("kopi gagal final, lalu roti gratis dilaporkan: roti tidak menyerap uang kopi (nothing_left, bukan kopi+roti); kopi lapor ulang dibayar 28.875", async () => {
    const { paid, refundId } = await kopiRefundFiled();
    await setFailed(refundId, "provider_declined");
    await runHook(refundId);
    expect(await orderLedger(paid.order.id)).toBe(0);

    // Kopi's item is a standing line again for roti's recompute: the free roti
    // owes Rp0.
    const roti = await approvedRefund(paid.roti.id, 18_000);
    await deliver(roti.event);
    expect(await issueRefunds(roti.issueId)).toEqual([]);
    const blocked = await auditRows(
      [roti.issueId],
      "order_issue.refund_blocked",
    );
    expect(blocked).toHaveLength(1);
    expect(JSON.stringify(blocked[0])).toContain("nothing_left");
    expect(await orderLedger(paid.order.id)).toBe(0);

    // Kopi is reported again: roti (nothing_left) is out of the kept lines, so
    // kept = teh only, the same answer as legend-h1dyy H2.
    const again = await approvedRefund(paid.kopi.id, 25_000);
    await deliver(again.event);
    expect(
      (await issueRefunds(again.issueId)).map((row) => row.amount_idr),
    ).toEqual([28_875]);
  });
});
