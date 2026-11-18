// Facility entitlement consumer (PRD v1.7 §3 F25, bead legend-fjk5; FAC-04).
// Cloud only, wired in worker-main.ts right after the loyalty earn consumer.
// Runs inside the outbox consumption transaction, one savepoint per event:
//
// - `order.paid`: for the customer attached to the order, every enabled
//   `package` rule of the outlet whose menu item is on the order issues a grant
//   (rule sessions x quantity, capped at 100), and every `min_spend` rule whose
//   threshold the customer's net F&B spend of that business day at that outlet
//   reaches issues one grant per customer, rule and business day. Issue goes
//   through `issueEntitlement` only, so it is idempotent (replay = no-op). A
//   training order (`pos_orders.is_training`) issues nothing and does not count.
// - `order.refunded`: cancels what is left of the `package` grants whose source
//   is that order. A `min_spend` grant of the same customer, outlet and
//   business day is cancelled only when the net spend (see below) fell under
//   its rule's threshold. The payload has no line detail; sessions already
//   redeemed stay.
// - `order.voided` (final void with a void id): cancels what is left of the
//   `package` and `min_spend` grants whose source is that order.
//
// Net spend of a business day = sum of (subtotal - discount) of the completed,
// non-training orders of the customer at the outlet that day, minus their
// POS tender refunds and released DP (read from the tables, not the event). The
// closing time of an `operating_day` grant comes from the facility's operating
// hours (end of the business date when the weekday has none).
//
// A deterministic bad payload is ignored; any other error propagates so the
// relay retries the event.
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  businessDateSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { eqId } from "../db/branded-ids.ts";
import { entitlementRules, facilities } from "../db/schema/facility.ts";
import { entitlementLedger } from "../db/schema/facility-entitlement.ts";
import { posOrderRefunds, posOrders } from "../db/schema/pos-order.ts";
import { orderItems, orders } from "../db/schema/qr-order.ts";
import {
  cancelEntitlementsForSource,
  expiryOfValidity,
  issueEntitlement,
  lockCustomer,
  operatingDayEnd,
  operatingDayEndAfter,
} from "./facility-entitlement.service.ts";
import { outletTimeZone } from "./facility-shared.ts";
import type { Tx } from "./inventory-ops.shared.ts";

const ENTITLEMENT_EVENTS = new Set([
  "order.paid",
  "order.refunded",
  "order.voided",
]);

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
const time = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Not a timestamp");

const orderPaidSchema = z.object({
  orderId: ulid,
  outletId: z.string().uuid(),
  businessDate: businessDateSchema,
  paidAt: time.optional(),
});

const orderRefundedSchema = z.object({
  orderId: ulid,
  outletId: z.string().uuid(),
  refundId: z.string().min(1).max(64).optional(),
});

const orderVoidedSchema = z.object({
  orderId: ulid,
  outletId: z.string().uuid(),
  voidId: z.string().min(1).max(64).nullable(),
  voidedFinalOrder: z.boolean(),
});

type TenantId = ScopedTenantContext["tenant"]["tenantId"];

type Scope = { context: ScopedTenantContext; now: Date };

export async function deliverFacilityEntitlementEvent(
  context: ScopedTenantContext,
  event: EventEnvelope,
  tx: Tx,
  now = new Date(),
): Promise<void> {
  if (!ENTITLEMENT_EVENTS.has(event.name)) return;
  if (event.tenantId !== context.tenant.tenantId) return;
  const scope: Scope = { context, now };
  await tx.transaction(async (savepoint) => {
    if (event.name === "order.paid") {
      const parsed = orderPaidSchema.safeParse(event.payload);
      if (parsed.success)
        await issueForPaidOrder(savepoint, scope, parsed.data);
      return;
    }
    if (event.name === "order.voided") {
      const parsed = orderVoidedSchema.safeParse(event.payload);
      if (!parsed.success) return;
      const { orderId, voidId, voidedFinalOrder } = parsed.data;
      if (!voidedFinalOrder || voidId === null) return;
      await cancelEntitlementsForSource(savepoint, context, {
        sourceRef: orderId,
        sourceTypes: ["package", "min_spend"],
        reason: `Pesanan sumber di-void (${voidId})`,
        occurredAt: scope.now,
      });
      return;
    }
    const parsed = orderRefundedSchema.safeParse(event.payload);
    if (!parsed.success) return;
    await cancelForRefund(savepoint, scope, parsed.data);
  });
}

type DayOrder = { id: string; netIdr: number; counted: boolean };

/** Every order of the customer at the outlet on the business day. */
async function ordersOfDay(
  tx: Tx,
  tenantId: TenantId,
  input: { outletId: string; customerProfileId: string; businessDate: string },
  alsoCounted: string | null,
): Promise<DayOrder[]> {
  const rows = await tx
    .select({
      id: orders.id,
      status: orders.status,
      subtotalIdr: orders.subtotalIdr,
      discountIdr: orders.discountIdr,
      isTraining: posOrders.isTraining,
    })
    .from(orders)
    .leftJoin(
      posOrders,
      and(
        eq(posOrders.tenantId, orders.tenantId),
        eq(posOrders.orderId, orders.id),
      ),
    )
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eqId(orders.outletId, input.outletId),
        eq(orders.customerProfileId, input.customerProfileId),
        eq(orders.businessDate, input.businessDate),
      ),
    )
    .orderBy(asc(orders.id));
  return rows.map((row) => ({
    id: row.id,
    netIdr: Math.max(0, Number(row.subtotalIdr) - Number(row.discountIdr)),
    // The paying order counts from its own row, whatever its status is.
    counted:
      !row.isTraining && (row.status === "completed" || row.id === alsoCounted),
  }));
}

/** Net spend: subtotal - discount - tender refunds - released DP. */
async function netSpend(
  tx: Tx,
  tenantId: TenantId,
  dayOrders: DayOrder[],
): Promise<number> {
  const counted = dayOrders.filter((entry) => entry.counted);
  if (counted.length === 0) return 0;
  const gross = counted.reduce((sum, entry) => sum + entry.netIdr, 0);
  // Keep the correlated outer identifiers explicit: Drizzle removes column
  // qualifiers from a single-table SELECT expression, including its subquery.
  const [refunds] = await tx
    .select({
      total: sql<string>`COALESCE(SUM(${posOrderRefunds.amountIdr} + COALESCE((
        SELECT SUM(d.amount_idr) FROM pos_deposit_refunds d
         WHERE d.tenant_id = "pos_order_refunds"."tenant_id"
           AND d.pos_refund_id = "pos_order_refunds"."id"
      ), 0)), 0)`,
    })
    .from(posOrderRefunds)
    .where(
      and(
        eq(posOrderRefunds.tenantId, tenantId),
        inArray(
          posOrderRefunds.orderId,
          counted.map((entry) => entry.id),
        ),
      ),
    );
  return Math.max(0, gross - Number(refunds?.total ?? 0));
}

const thresholdOf = (condition: unknown): number | null => {
  const value = (condition as { minSpendIdr?: number } | null)?.minSpendIdr;
  return typeof value === "number" ? value : null;
};

async function cancelForRefund(
  tx: Tx,
  scope: Scope,
  refunded: z.infer<typeof orderRefundedSchema>,
): Promise<void> {
  const { context, now } = scope;
  const tenantId = context.tenant.tenantId;
  const reason = refunded.refundId
    ? `Pesanan sumber di-refund (${refunded.refundId})`
    : "Pesanan sumber di-refund";
  // A package grant follows its own order, whatever the refunded amount is.
  await cancelEntitlementsForSource(tx, context, {
    sourceRef: refunded.orderId,
    sourceTypes: ["package"],
    reason,
    occurredAt: now,
  });

  const [order] = await tx
    .select({
      customerProfileId: orders.customerProfileId,
      outletId: orders.outletId,
      businessDate: orders.businessDate,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, refunded.orderId)))
    .limit(1);
  if (!order?.customerProfileId || order.outletId !== refunded.outletId) return;
  const customerProfileId = order.customerProfileId;

  // A min_spend grant of that customer, outlet and day stands while the net
  // spend still reaches the threshold of its rule.
  const dayOrders = await ordersOfDay(
    tx,
    tenantId,
    {
      outletId: refunded.outletId,
      customerProfileId,
      businessDate: order.businessDate,
    },
    null,
  );
  const grants = await tx
    .select({
      sourceRef: entitlementLedger.sourceRef,
      ruleId: entitlementLedger.ruleId,
      facilityId: entitlementLedger.facilityId,
    })
    .from(entitlementLedger)
    .where(
      and(
        eq(entitlementLedger.tenantId, tenantId),
        eq(entitlementLedger.type, "grant"),
        eq(entitlementLedger.sourceType, "min_spend"),
        eq(entitlementLedger.customerProfileId, customerProfileId),
        eqId(entitlementLedger.outletId, refunded.outletId),
        inArray(
          entitlementLedger.sourceRef,
          dayOrders.map((entry) => entry.id),
        ),
      ),
    );
  if (grants.length === 0) return;

  for (const facilityId of [...new Set(grants.map((g) => g.facilityId))].sort())
    await lockCustomer(tx, context, customerProfileId, facilityId);
  const ruleIds = [
    ...new Set(grants.flatMap((g) => (g.ruleId ? [g.ruleId] : []))),
  ];
  if (ruleIds.length === 0) return;
  const rules = await tx
    .select({ id: entitlementRules.id, condition: entitlementRules.condition })
    .from(entitlementRules)
    .where(
      and(
        eq(entitlementRules.tenantId, tenantId),
        inArray(entitlementRules.id, ruleIds),
      ),
    );
  const net = await netSpend(tx, tenantId, dayOrders);
  const fallen = new Set(
    rules
      .filter((rule) => {
        const threshold = thresholdOf(rule.condition);
        return threshold !== null && net < threshold;
      })
      .map((rule) => rule.id),
  );
  const bySource = new Map<string, string[]>();
  for (const grant of grants)
    if (grant.ruleId && fallen.has(grant.ruleId))
      bySource.set(grant.sourceRef, [
        ...(bySource.get(grant.sourceRef) ?? []),
        grant.ruleId,
      ]);
  for (const [sourceRef, fallenRuleIds] of bySource)
    await cancelEntitlementsForSource(tx, context, {
      sourceRef,
      sourceTypes: ["min_spend"],
      ruleIds: fallenRuleIds,
      reason,
      occurredAt: now,
    });
}

async function issueForPaidOrder(
  tx: Tx,
  scope: Scope,
  paid: z.infer<typeof orderPaidSchema>,
): Promise<void> {
  const { context, now } = scope;
  const tenantId = context.tenant.tenantId;
  const [order] = await tx
    .select({
      customerProfileId: orders.customerProfileId,
      outletId: orders.outletId,
    })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, paid.orderId)))
    .limit(1);
  if (!order?.customerProfileId || order.outletId !== paid.outletId) return;
  // Training orders (F2) issue nothing and never count.
  const [training] = await tx
    .select({ orderId: posOrders.orderId })
    .from(posOrders)
    .where(
      and(
        eq(posOrders.tenantId, tenantId),
        eq(posOrders.orderId, paid.orderId),
        eq(posOrders.isTraining, true),
      ),
    )
    .limit(1);
  if (training) return;
  const customerProfileId = order.customerProfileId;

  const rules = await tx
    .select()
    .from(entitlementRules)
    .where(
      and(
        eq(entitlementRules.tenantId, tenantId),
        eqId(entitlementRules.outletId, paid.outletId),
        eq(entitlementRules.isEnabled, true),
        inArray(entitlementRules.type, ["package", "min_spend"]),
      ),
    );
  if (rules.length === 0) return;

  const facilityRows = await tx
    .select({ id: facilities.id, operatingHours: facilities.operatingHours })
    .from(facilities)
    .where(
      and(
        eq(facilities.tenantId, tenantId),
        inArray(facilities.id, [
          ...new Set(rules.map((rule) => rule.facilityId)),
        ]),
      ),
    );
  const hoursOf = new Map(
    facilityRows.map((row) => [row.id, row.operatingHours]),
  );
  const timeZone = await outletTimeZone(tx, context, paid.outletId);
  const paidAt = paid.paidAt ? new Date(paid.paidAt) : now;

  // Quantity of each menu item on the order (voided lines do not count).
  const quantities = new Map<string, number>();
  if (rules.some((rule) => rule.type === "package")) {
    const lines = await tx
      .select({
        menuItemId: orderItems.menuItemId,
        quantity: sql<number>`SUM(${orderItems.quantity})::int`,
      })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.tenantId, tenantId),
          eq(orderItems.orderId, paid.orderId),
          ne(orderItems.status, "voided"),
        ),
      )
      .groupBy(orderItems.menuItemId);
    for (const line of lines)
      quantities.set(line.menuItemId, Number(line.quantity));
  }

  // Same business day net F&B spend of this customer at this outlet, this
  // order included (read from its own row, so event order does not matter).
  let sameDaySpend = 0;
  let dayOrderIds: string[] = [];
  if (rules.some((rule) => rule.type === "min_spend")) {
    const dayOrders = await ordersOfDay(
      tx,
      tenantId,
      {
        outletId: paid.outletId,
        customerProfileId,
        businessDate: paid.businessDate,
      },
      paid.orderId,
    );
    dayOrderIds = dayOrders.map((entry) => entry.id);
    sameDaySpend = await netSpend(tx, tenantId, dayOrders);
  }

  for (const rule of rules) {
    let sessions = 0;
    if (rule.type === "package") {
      const menuItemId = (rule.condition as { menuItemId?: string }).menuItemId;
      const quantity = menuItemId ? (quantities.get(menuItemId) ?? 0) : 0;
      sessions = Math.min(100, rule.sessions * quantity);
    } else if (rule.type === "min_spend") {
      const threshold = Number(
        (rule.condition as { minSpendIdr?: number }).minSpendIdr ??
          Number.POSITIVE_INFINITY,
      );
      if (sameDaySpend >= threshold) {
        // One min-spend grant per customer per business day and rule. Checked
        // under the customer lock so a parallel event sees this one's grant.
        await lockCustomer(tx, context, customerProfileId, rule.facilityId);
        const [existing] = await tx
          .select({ id: entitlementLedger.id })
          .from(entitlementLedger)
          .where(
            and(
              eq(entitlementLedger.tenantId, tenantId),
              eq(entitlementLedger.type, "grant"),
              eq(entitlementLedger.sourceType, "min_spend"),
              eq(entitlementLedger.ruleId, rule.id),
              eq(entitlementLedger.customerProfileId, customerProfileId),
              inArray(entitlementLedger.sourceRef, dayOrderIds),
            ),
          )
          .limit(1);
        if (!existing) sessions = rule.sessions;
      }
    }
    if (sessions < 1) continue;

    const facilityHours = hoursOf.get(rule.facilityId) ?? [];
    const expiresAt = expiryOfValidity(rule.validity, {
      occurredAt: paidAt,
      // Q78: a package bought after closing runs to the next operating day;
      // the min-spend voucher keeps the closing of its own business date.
      operatingDayEndsAt:
        rule.type === "package"
          ? operatingDayEndAfter(
              facilityHours,
              paid.businessDate,
              timeZone,
              paidAt,
            )
          : operatingDayEnd(facilityHours, paid.businessDate, timeZone),
    });
    await issueEntitlement(tx, context, {
      facilityId: rule.facilityId,
      customerProfileId,
      source: rule.type === "package" ? "package" : "min_spend",
      sourceRef: paid.orderId,
      ruleId: rule.id,
      sessions,
      expiresAt,
      paid: true,
      conditionsMet: true,
      reason: null,
      occurredAt: paidAt,
    });
  }
}
