// legend-1095 shared world (no tests here): a paid QR order of the recovery tests that
// can be turned into a completed POS cash sale, so one order can meet every money lane
// at once: apology / swap voucher (legend-5g9sn), ORD-09 recovery refund (payment_refunds
// with order_issue_id), cashier refund (pos_order_refunds), cloud void (pos_order_voids)
// and a parked edge `order.voided` (edge_deferred_events).
//
// Written from docs/briefs/sub-1095.md and the existing recovery / 980 fixtures, never
// from the implementation. The world, `payVerified`, `becomePosSale` and the refund
// input follow 3f5c50aed (pos-refund-voucher-cap.test.ts).
//
// Money in the plain order (kopi 25.000 + roti 18.000, no promo, 5% service + 10% PBJT,
// factor 1,155): kopi paid 28.875, roti paid 20.790, order paid 49.665.

import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";
import {
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { PosReceipt } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderRecoveryRefundEvent } from "../services/order-recovery-refund.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { deliverQrOrderPaymentEvent } from "../services/qr-order-payment.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  refundPosOrder,
  voidPosOrderCorrection,
} from "../services/pos-order-corrections.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { agent, signUp } from "./helpers.ts";
import { createWorld, type World } from "./order-recovery-helpers.ts";
import { createIsolatedTenant, owner } from "./floor-test-helpers.ts";

export const ORDER_PAID = 49_665;
export const KOPI_PAID = 28_875;
export const ROTI_PAID = 20_790;
/** ORD-09 approval amount is the list price of the line; the refund filed is the paid value. */
export const ROTI_PRICE = 18_000;
/** Swap voucher kopi -> air without promo: the list difference. */
export const SWAP_VOUCHER = 20_000;
const AIR_PRICE = 5_000;
export const REASON = "Pelanggan menolak ganti menu dan voucher";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const toUuid = (id: string) =>
  UUID.test(id) ? id : ulidToUuid(id as never);
export const toUlid = (id: string) => (UUID.test(id) ? uuidToUlid(id) : id);
export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

export type PaidOrder = {
  orderId: string;
  outletId: string;
  kopiLine: string;
  rotiLine: string;
};

export type PosWorld = Awaited<ReturnType<typeof createPosWorld>>;

export async function createPosWorld() {
  const w: World = await createWorld();
  const airItem = randomUUID();
  const tillDevice = randomUUID();
  const gate = { cashierId: "" };

  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === w.tenant.tenantId && deviceId === tillDevice
      ? w.tenant.outletId
      : null,
  );

  // The recovery staff cannot operate a till: the cashier is a separate member.
  const cashierRole = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Satu Jalur', false, NULL, $3, false, '["tenant"]')`,
    [
      cashierRole,
      w.tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.refund.request",
        "pos.void.request",
        "shift.cash.operate",
      ]),
    ],
  );
  const cashierClient = agent(w.app);
  await signUp(cashierClient, "Kasir Satu Jalur 1095");
  const session = await cashierClient.get("/api/auth/get-session");
  gate.cashierId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [w.tenant.tenantId, gate.cashierId, cashierRole],
  );
  await openPosShift(
    contextOf(w.tenant.tenantId),
    { userId: userIdSchema.parse(gate.cashierId), deviceId: tillDevice },
    outletIdSchema.parse(w.tenant.outletId),
    { openingFloatIdr: idr(500_000), idempotencyKey: randomUUID() },
  );
  await owner.query(
    `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
     VALUES ($1, $2, $3, $4, 'Air Mineral Swap', true, $5)`,
    [airItem, w.tenant.tenantId, w.tenant.brandId, w.ids.category, randomUUID()],
  );
  await owner.query(
    `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), w.tenant.tenantId, w.ids.priceList, airItem, AIR_PRICE],
  );
  setPosReceiptPort(memoryReceiptPort(w.tenant.tenantId, w.tenant.outletId, tillDevice));

  // ---- recovery side (QR order) ---------------------------------------------------

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

  /** A PAID plain order (kopi + roti, no promo): paid 49.665. */
  async function paidPlainOrder(): Promise<PaidOrder> {
    const guest = await w.seat("pay_first");
    let version = 0;
    for (const menuItemId of [w.ids.kopi, w.ids.roti]) {
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
    const { rows } = await owner.query<{
      outlet_id: string;
      total_idr: number;
    }>(
      "SELECT outlet_id, total_idr::int FROM orders WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, toUuid(order.id)],
    );
    expect(rows[0]!.total_idr, "plain order total").toBe(ORDER_PAID);
    const payment = await w
      .as(guest)
      .pay({ kind: "order", orderId: order.id });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    expect(await payVerified(payment.body.data.id, ORDER_PAID)).toBe(true);
    const line = (menuItemId: string) =>
      order.items.find((item) => item.menuItemId === menuItemId)!.id;
    return {
      orderId: order.id,
      outletId: rows[0]!.outlet_id,
      kopiLine: line(w.ids.kopi),
      rotiLine: line(w.ids.roti),
    };
  }

  async function reportLine(lineId: string) {
    const reported = await w.report(lineId);
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    return reported.body.data.id as string;
  }

  /** Kopi swapped to the air item: the swap voucher (20.000) is minted. Returns the issue. */
  async function swapKopiToAir(paid: PaidOrder) {
    const issueId = await reportLine(paid.kopiLine);
    const swapped = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issueId}/resolve`,
      { resolution: "swap", replacementItemId: airItem },
    );
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
    const resolved = await w.outboxRows("order_issue.resolved", issueId);
    expect(resolved).toHaveLength(1);
    const context = contextOf(w.tenant.tenantId);
    await withTenant(db, context, (tx) =>
      deliverSwapKitchenEvent(context, resolved[0]!.event, tx),
    );
    expect(await voucherValues(issueId), "swap voucher").toEqual([
      SWAP_VOUCHER,
    ]);
    return issueId;
  }

  /** Staff apology voucher request (no expectation on the answer). */
  async function apologyVoucherRequest(lineId: string, valueIdr: number) {
    const issueId = await reportLine(lineId);
    const issued = await w.staffPost(w.supervisor, "/api/apology-vouchers", {
      valueIdr,
      reason: "Item gagal, mohon maaf",
      orderIssueId: issueId,
    });
    return { issueId, issued };
  }

  /** Staff apology voucher of `valueIdr` tied to a fresh issue of `lineId`. Returns the issue. */
  async function apologyVoucherFor(lineId: string, valueIdr: number) {
    const { issueId, issued } = await apologyVoucherRequest(lineId, valueIdr);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const resolved = await w.staffPost(
      w.supervisor,
      `/api/order-issues/${issueId}/resolve`,
      { resolution: "voucher", voucherId: issued.body.data.id as string },
    );
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    expect(await voucherValues(issueId), "apology voucher").toEqual([
      valueIdr,
    ]);
    return issueId;
  }

  /** A failed line reported and its ORD-09 refund approved; not resolved yet. */
  async function prepareOrd09(lineId: string, approvedIdr: number) {
    const issueId = await reportLine(lineId);
    const approvalId = await w.insertApproval({
      actionType: "refund",
      objectType: "order_issue",
      objectId: issueId,
      amountIdr: approvedIdr,
      status: "approved",
      requestedBy: w.floorStaff.userId,
    });
    return { issueId, approvalId };
  }

  /** The supervisor's resolve call (route answer returned, nothing asserted). */
  function resolveOrd09(issueId: string, approvalId: string) {
    return w.staffPost(w.supervisor, `/api/order-issues/${issueId}/resolve`, {
      resolution: "manual_refund",
      approvalRequestId: approvalId,
      reason: REASON,
    });
  }

  async function ord09Event(issueId: string) {
    const rows = await w.outboxRows(
      "order_issue.manual_refund_approved",
      issueId,
    );
    return rows.length > 0 ? rows[0]!.event : null;
  }

  /** The worker step: deliver the ORD-09 event in a tenant transaction. */
  async function deliverOrd09(
    event: NonNullable<Awaited<ReturnType<typeof ord09Event>>>,
  ) {
    const context = contextOf(w.tenant.tenantId);
    return withTenant(db, context, (tx) =>
      deliverOrderRecoveryRefundEvent(context, event, tx),
    );
  }

  /** Resolve + deliver, expecting the ORD-09 refund to be filed. Returns the issue. */
  async function recoveryRefundFor(
    lineId: string,
    approvedIdr: number,
    amountIdr: number,
  ) {
    const { issueId, approvalId } = await prepareOrd09(lineId, approvedIdr);
    const resolved = await resolveOrd09(issueId, approvalId);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    const event = await ord09Event(issueId);
    expect(event, "manual_refund_approved event").not.toBeNull();
    await deliverOrd09(event!);
    expect(await ord09Rows([issueId]), "ORD-09 refund filed").toHaveLength(1);
    expect(await recoveryRefundTotal([issueId])).toBe(amountIdr);
    return issueId;
  }

  /**
   * The ORD-09 refund must not be paid for an order that is already voided /
   * cashier-refunded. Brief: the refund is refused with 409. The brief does not say
   * whether that is the resolve route or the event consumer, so both are accepted:
   * the route answers 409, or it answers 200 and delivering the event opens NO
   * refund (a thrown 409 counts). Either way: no live payment_refunds row for the issue.
   */
  async function expectOrd09Refused(issueId: string, approvalId: string) {
    const resolved = await resolveOrd09(issueId, approvalId);
    if (resolved.status !== 409) {
      expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
      const event = await ord09Event(issueId);
      if (event) {
        try {
          await deliverOrd09(event);
        } catch (error) {
          expect((error as { status?: number }).status).toBe(409);
        }
      }
    }
    expect(await ord09Rows([issueId]), "no ORD-09 refund opened").toEqual([]);
  }

  async function voucherValues(issueId: string): Promise<number[]> {
    const { rows } = await owner.query<{ value_idr: string }>(
      `SELECT v.value_idr FROM vouchers v
       JOIN apology_vouchers a ON a.voucher_id = v.id AND a.tenant_id = v.tenant_id
       WHERE a.tenant_id = $1 AND a.order_issue_id = $2`,
      [w.tenant.tenantId, issueId],
    );
    return rows.map((row) => Number(row.value_idr));
  }

  async function voucherTotal(issueIds: string[]) {
    return sum((await Promise.all(issueIds.map(voucherValues))).flat());
  }

  /** Live ORD-09 refund rows (any status except failed) of the given issues. */
  async function ord09Rows(issueIds: string[]) {
    const { rows } = await owner.query<{ amount_idr: string; status: string }>(
      `SELECT amount_idr, status FROM payment_refunds
        WHERE tenant_id = $1 AND order_issue_id = ANY($2::uuid[])
          AND status <> 'failed'`,
      [w.tenant.tenantId, issueIds.map(toUuid)],
    );
    return rows.map((row) => ({
      amountIdr: Number(row.amount_idr),
      status: row.status,
    }));
  }

  async function recoveryRefundTotal(issueIds: string[]) {
    return sum((await ord09Rows(issueIds)).map((row) => row.amountIdr));
  }

  // ---- POS side -------------------------------------------------------------------

  /** The paid QR order becomes a completed POS sale paid in cash (setup, written directly). */
  async function becomePosSale(paid: PaidOrder, paidIdr = ORDER_PAID) {
    const uuid = toUuid(paid.orderId);
    await owner.query(
      "UPDATE orders SET channel = 'pos', status = 'completed' WHERE tenant_id = $1 AND id = $2",
      [w.tenant.tenantId, uuid],
    );
    await owner.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, submitted_at)
       VALUES ($1, $2, $3, 'pos', now())`,
      [uuid, w.tenant.tenantId, paid.outletId],
    );
    await owner.query(
      `INSERT INTO pos_order_tenders (tenant_id, outlet_id, order_id, method, provider,
          amount_idr, received_idr, change_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'cash', 'manual', $4, $4, 0, 'captured',
               now() - interval '1 minute', now())`,
      [w.tenant.tenantId, paid.outletId, uuid, paidIdr],
    );
  }

  type RefundInput = Parameters<typeof refundPosOrder>[4];
  type VoidInput = Parameters<typeof voidPosOrderCorrection>[4];

  /** An approved supervisor-PIN override row for `action` on the whole order. */
  async function approvedOverride(
    orderId: string,
    action: "refund" | "void",
    valueIdr: number,
  ) {
    const overrideId = toUlid(randomUUID());
    await owner.query(
      `INSERT INTO pos_overrides
         (id, tenant_id, outlet_id, action, method, status, requested_by, approved_by,
          reason, value_idr, object_type, object_id, request_fingerprint, created_at, resolved_at)
       VALUES ($1, $2, $3, $9, 'supervisor_pin', 'approved', $4, $5,
               'Pelanggan salah pesan', $6, 'order', $7, $8, now(), now())`,
      [
        ulidToUuid(overrideId as never),
        w.tenant.tenantId,
        w.tenant.outletId,
        gate.cashierId,
        w.supervisor.userId,
        valueIdr,
        toUlid(orderId),
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        action,
      ],
    );
    return { overrideId, approvedBy: w.supervisor.userId };
  }

  /** A POS refund input with an approved override; reuse one to replay. */
  async function refundInput(
    orderId: string,
    amountIdr: number,
    items?: { itemId: string; quantity: number }[],
  ) {
    return {
      reason: "quality_complaint",
      reasonNote: "Refund POS uji 1095",
      amountIdr,
      ...(items ? { items } : {}),
      idempotencyKey: randomUUID(),
      ...(await approvedOverride(orderId, "refund", amountIdr)),
    } as unknown as RefundInput;
  }

  const caller = () => ({
    userId: userIdSchema.parse(gate.cashierId),
    deviceId: tillDevice,
    expectedVersion: null,
  });

  /** Calls `refundPosOrder`; a refusal is returned, not thrown. */
  async function posRefund(
    orderId: string,
    input: RefundInput,
    tenantId = w.tenant.tenantId,
  ) {
    try {
      const result = await refundPosOrder(
        contextOf(tenantId),
        caller(),
        outletIdSchema.parse(w.tenant.outletId),
        toUlid(orderId) as never,
        input,
      );
      return { ok: true as const, result };
    } catch (error) {
      return { ok: false as const, error: error as ErrorLike };
    }
  }

  /** Cash void of the whole sale; a refusal is returned, not thrown. */
  async function cloudVoid(orderId: string) {
    const input = {
      idempotencyKey: randomUUID(),
      reason: "customer_cancelled",
      reasonNote: "Void uji 1095",
      ...(await approvedOverride(orderId, "void", ORDER_PAID)),
    } as unknown as VoidInput;
    try {
      const result = await voidPosOrderCorrection(
        contextOf(w.tenant.tenantId),
        caller(),
        outletIdSchema.parse(w.tenant.outletId),
        toUlid(orderId) as never,
        input,
      );
      return { ok: true as const, result };
    } catch (error) {
      return { ok: false as const, error: error as ErrorLike };
    }
  }

  async function posRefundRows(orderId: string) {
    const { rows } = await owner.query<{ amount_idr: string }>(
      `SELECT amount_idr FROM pos_order_refunds
        WHERE tenant_id = $1 AND order_id = $2 ORDER BY refunded_at, id`,
      [w.tenant.tenantId, toUuid(orderId)],
    );
    return rows.map((row) => Number(row.amount_idr));
  }

  async function voidCount(orderId: string) {
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pos_order_voids WHERE tenant_id = $1 AND order_id = $2",
      [w.tenant.tenantId, toUuid(orderId)],
    );
    return rows[0]!.n;
  }

  /**
   * Money that left for the guest: POS refunds + live ORD-09 refunds + the void
   * amount (a void returns the whole order) + vouchers.
   */
  async function returnedTotal(orderId: string, issueIds: string[]) {
    return (
      sum(await posRefundRows(orderId)) +
      (await recoveryRefundTotal(issueIds)) +
      (await voucherTotal(issueIds)) +
      (await voidCount(orderId)) * ORDER_PAID
    );
  }

  /** The founder rule: nobody gets back more than the guest paid. */
  async function expectWithinPaid(
    orderId: string,
    issueIds: string[],
    paidIdr = ORDER_PAID,
  ) {
    expect(
      await returnedTotal(orderId, issueIds),
      "vouchers + ORD-09 refunds + POS refunds + void",
    ).toBeLessThanOrEqual(paidIdr);
  }

  return {
    w,
    tillDevice,
    cashierId: () => gate.cashierId,
    paidPlainOrder,
    swapKopiToAir,
    apologyVoucherFor,
    apologyVoucherRequest,
    prepareOrd09,
    resolveOrd09,
    ord09Event,
    deliverOrd09,
    recoveryRefundFor,
    expectOrd09Refused,
    reportLine,
    voucherTotal,
    ord09Rows,
    recoveryRefundTotal,
    becomePosSale,
    refundInput,
    posRefund,
    cloudVoid,
    posRefundRows,
    voidCount,
    returnedTotal,
    expectWithinPaid,
    async teardown() {
      setPosReceiptPort(null);
      setDeviceOutletResolver(null);
      await w.teardown();
    },
  };
}

export type ErrorLike = { status?: number; code?: string; message?: string };

/** `code status message` of a refusal, for loose matching without pinning the shape. */
export const errorText = (error: ErrorLike | undefined) =>
  `${error?.code ?? ""} ${error?.status ?? ""} ${error?.message ?? ""}`;

/** Another tenant (own outlet), for isolation cases. */
export async function otherTenant() {
  return createIsolatedTenant(`pvx-${randomUUID().slice(0, 6)}`);
}

/** Issues a receipt for any order on demand, like the real allocator would have at sale time. */
function memoryReceiptPort(
  tenantId: string,
  fallbackOutletId: string,
  deviceId: string,
): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let sequence = 0;
  const issue = (orderId: string, outletId: string, at: Date) => {
    const existing = byOrder.get(orderId);
    if (existing) return existing;
    sequence += 1;
    const receipt = {
      id: randomUUID(),
      tenantId,
      outletId,
      orderId,
      deviceId,
      number: `S1095-${String(sequence).padStart(6, "0")}`,
      sequenceNumber: sequence,
      status: "issued",
      issuedAt: at.toISOString(),
      voidedAt: null,
      voidReason: null,
      voidedBy: null,
      reprintCount: 0,
    } as unknown as PosReceipt;
    byOrder.set(orderId, receipt);
    return receipt;
  };
  return {
    async issueForSale(_tx, _context, input) {
      return issue(input.orderId, input.outletId, input.at);
    },
    async findForOrder(_tx, _context, orderId) {
      return issue(orderId, fallbackOutletId, new Date());
    },
    async voidForOrder(_tx, _context, input) {
      const found = issue(input.orderId, fallbackOutletId, input.at);
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}
