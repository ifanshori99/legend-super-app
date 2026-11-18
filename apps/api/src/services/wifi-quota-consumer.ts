// Wi-Fi quota consumer (bead legend-kmd3 slice S2, brief
// docs/briefs/sub-kmd3-wifi-quota.md design 1, 2, 8). Cloud only, wired in
// worker-main.ts next to the loyalty earn consumer. Runs inside the outbox
// consumption transaction, one savepoint per event, under the account lock:
//
// - `order.paid`: the money paid (cash + gateway + EDC, never points or
//   deposit) of an order with a member becomes one `paid` ledger row, then the
//   open sessions of the member for that business date are recomputed.
// - `order.refunded`: the money refunded becomes one `refund` row (keyed by the
//   refund id) against the paid entry of the order, then the same recompute
//   runs for the business date of the PAID entry.
// - `order.voided` of a final order: a full refund. One `refund` row keyed by
//   the void id for what is left of the paid entry (paid minus earlier
//   refunds), then the same recompute. A void that is not final, has no void id
//   or finds nothing left writes nothing.
//
// The unique (tenant, kind, source_id) row is the replay guard: an event that
// already wrote its row stops here. A practice (training) order, an order
// without a member and an order with no money paid never get a row. A
// deterministic bad payload is ignored; any other error propagates so the relay
// retries the event.

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  businessDateSchema,
  idr,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { orders, wifiSpendEntries } from "../db/schema/index.ts";
import { isTrainingOrder } from "./device-training.ts";
import type { Tx } from "./inventory-ops.shared.ts";
import {
  recomputeOpenSessions,
  withWifiAccountLock,
} from "./wifi-quota.service.ts";

const WIFI_EVENTS = new Set(["order.paid", "order.refunded", "order.voided"]);

const amount = z.number().int().nonnegative().safe();
const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i);

const orderPaidSchema = z.object({
  orderId: ulid,
  outletId: z.string().uuid(),
  businessDate: businessDateSchema,
  paidCashIdr: amount,
  paidGatewayIdr: amount,
  paidEdcIdr: amount,
});

const orderRefundedSchema = z.object({
  orderId: ulid,
  outletId: z.string().uuid(),
  businessDate: businessDateSchema,
  refundId: z.string().min(1).max(64),
  refundCashIdr: amount,
  refundGatewayIdr: amount,
  refundEdcIdr: amount,
});

const orderVoidedSchema = z.object({
  orderId: ulid,
  outletId: z.string().uuid(),
  businessDate: businessDateSchema,
  voidId: z.string().min(1).max(64).nullable(),
  voidedFinalOrder: z.boolean(),
});

type Scope = { context: ScopedTenantContext; tenantId: TenantId; now: Date };

export async function deliverWifiQuotaEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<void> {
  if (!WIFI_EVENTS.has(event.name)) return;
  if (event.tenantId !== context.tenant.tenantId) return;
  const scope: Scope = { context, tenantId: context.tenant.tenantId, now };
  await tx.transaction((savepoint) =>
    handleEvent(savepoint, scope, event.name, event.payload),
  );
}

async function handleEvent(
  tx: Tx,
  scope: Scope,
  name: string,
  payload: unknown,
): Promise<void> {
  if (name === "order.paid") {
    const parsed = orderPaidSchema.safeParse(payload);
    if (parsed.success) await spendForPaidOrder(tx, scope, parsed.data);
    return;
  }
  if (name === "order.voided") {
    const parsed = orderVoidedSchema.safeParse(payload);
    if (parsed.success && parsed.data.voidedFinalOrder && parsed.data.voidId)
      await refundForOrder(tx, scope, {
        orderId: parsed.data.orderId,
        businessDate: parsed.data.businessDate,
        refundId: parsed.data.voidId,
        refundedIdr: null,
      });
    return;
  }
  const parsed = orderRefundedSchema.safeParse(payload);
  if (parsed.success)
    await refundForOrder(tx, scope, {
      orderId: parsed.data.orderId,
      businessDate: parsed.data.businessDate,
      refundId: parsed.data.refundId,
      refundedIdr:
        parsed.data.refundCashIdr +
        parsed.data.refundGatewayIdr +
        parsed.data.refundEdcIdr,
    });
}

async function spendForPaidOrder(
  tx: Tx,
  scope: Scope,
  paid: z.infer<typeof orderPaidSchema>,
): Promise<void> {
  const { tenantId, context, now } = scope;
  const spend = paid.paidCashIdr + paid.paidGatewayIdr + paid.paidEdcIdr;
  if (spend <= 0) return;
  // The member comes from the order row, never from the payload.
  const [order] = await tx
    .select({ customerProfileId: orders.customerProfileId })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, paid.orderId)))
    .limit(1);
  if (!order?.customerProfileId) return;
  if (await isTrainingOrder(tx, context.tenant.tenantId, paid.orderId)) return;

  await withWifiAccountLock(tx, tenantId, order.customerProfileId);
  const [created] = await tx
    .insert(wifiSpendEntries)
    .values({
      tenantId,
      outletId: paid.outletId as never,
      customerProfileId: order.customerProfileId,
      businessDate: paid.businessDate,
      orderId: paid.orderId,
      kind: "paid",
      sourceId: paid.orderId,
      amountIdr: idr(spend),
    })
    .onConflictDoNothing()
    .returning({ id: wifiSpendEntries.id });
  // An existing row means this event was already consumed: replay.
  if (!created) return;
  await recomputeOpenSessions(tx, context, {
    customerProfileId: order.customerProfileId,
    businessDate: paid.businessDate,
    now,
    reason: "spend",
  });
}

async function refundForOrder(
  tx: Tx,
  scope: Scope,
  // `refundedIdr` null = a void: refund whatever is left of the paid entry.
  refund: {
    orderId: string;
    businessDate: string;
    refundId: string;
    refundedIdr: number | null;
  },
): Promise<void> {
  const { tenantId, context, now } = scope;
  if (refund.refundedIdr !== null && refund.refundedIdr <= 0) return;
  // No paid entry = a practice order, an order without member or without money:
  // nothing to reverse.
  const [paidEntry] = await tx
    .select({
      customerProfileId: wifiSpendEntries.customerProfileId,
      outletId: wifiSpendEntries.outletId,
      businessDate: wifiSpendEntries.businessDate,
      amountIdr: wifiSpendEntries.amountIdr,
    })
    .from(wifiSpendEntries)
    .where(
      and(
        eq(wifiSpendEntries.tenantId, tenantId),
        eq(wifiSpendEntries.kind, "paid"),
        eq(wifiSpendEntries.sourceId, refund.orderId),
      ),
    )
    .limit(1);
  if (!paidEntry) return;

  await withWifiAccountLock(tx, tenantId, paidEntry.customerProfileId);
  let refunded = refund.refundedIdr ?? 0;
  if (refund.refundedIdr === null) {
    const [earlier] = await tx
      .select({
        total: sql<string>`COALESCE(SUM(${wifiSpendEntries.amountIdr}), 0)`,
      })
      .from(wifiSpendEntries)
      .where(
        and(
          eq(wifiSpendEntries.tenantId, tenantId),
          eq(wifiSpendEntries.kind, "refund"),
          eq(wifiSpendEntries.orderId, refund.orderId),
        ),
      );
    refunded = Number(paidEntry.amountIdr) - Number(earlier?.total ?? 0);
    if (refunded <= 0) return;
  }
  const [created] = await tx
    .insert(wifiSpendEntries)
    .values({
      tenantId,
      outletId: paidEntry.outletId,
      customerProfileId: paidEntry.customerProfileId,
      businessDate: refund.businessDate,
      orderId: refund.orderId,
      kind: "refund",
      sourceId: refund.refundId,
      amountIdr: idr(refunded),
    })
    .onConflictDoNothing()
    .returning({ id: wifiSpendEntries.id });
  if (!created) return;
  // The day the spend counted on, not the day of the refund.
  await recomputeOpenSessions(tx, context, {
    customerProfileId: paidEntry.customerProfileId,
    businessDate: paidEntry.businessDate,
    now,
    reason: "spend",
  });
}
