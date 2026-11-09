// Commission reconciliation of the delivery channel framework (bead
// legend-5bn3, slice D5; PRD v1.7 §3.23 "Rekonsiliasi Komisi"). Expected net
// per order is gross - commission (machines.ts `deliveryNetIdr`); a platform
// statement line is compared with it by `reconcileDeliveryLine`. The statement
// import is an internal service function (adapter/CSV feeds call it later); no
// public endpoint writes settlement lines. No money moves through our gateway:
// the platform pays us, this only checks that the amounts agree.
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  createUlid,
  idr,
  type OutletId,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  deliveryEvents,
  deliveryReconciliationSummaryOf,
  DeliveryError,
  reconcileDeliveryLine,
  type DeliveryPlatform,
  type DeliveryReconciliation,
  type DeliveryReconciliationQuery,
  type DeliverySettlementLine,
} from "@starter/shared/delivery";
import { db } from "../db/index.ts";
import {
  deliveryChannelOrders,
  deliveryChannels,
  deliverySettlementLines,
} from "../db/schema/delivery.ts";
import { domainEventOutbox } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { recordAudit } from "./core-audit.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  findByExternalId,
  toDeliveryChannelOrder,
  toDeliverySettlementLine,
} from "./delivery-store.ts";
import type { Tx } from "./permission-resolver.ts";

const EVENT_DESTINATION = "cloud-sync";

/** One statement line as the platform reports it. */
export type DeliveryStatementLineInput = {
  externalOrderId: string;
  grossIdr: number;
  commissionIdr: number;
  /** Money actually received from the platform for this order. */
  settledNetIdr: number;
  /** Business date (YYYY-MM-DD) of the statement. */
  settledOn: string;
};

export type DeliveryStatementImportInput = {
  outletId: OutletId;
  platform: DeliveryPlatform;
  lines: readonly DeliveryStatementLineInput[];
  /** User id behind a manual import; null = system feed (adapter/CSV job). */
  actorUserId: string | null;
  now: Date;
};

export type DeliveryStatementImportResult = {
  lines: DeliverySettlementLine[];
  /** Lines that were new or changed; a replay of the same statement is 0. */
  appliedCount: number;
  /** Lines refused without a write (see `DeliveryStatementRejection`). */
  rejected: DeliveryStatementRejection[];
};

/**
 * A line that was not imported. OUTLET_MISMATCH: the stored line for the same
 * tenant + platform + external id + date belongs to another outlet; it is never
 * overwritten (the unique key has no outlet).
 */
export type DeliveryStatementRejection = {
  externalOrderId: string;
  settledOn: string;
  code: "OUTLET_MISMATCH";
};

/**
 * Reconciliation of one outlet, platform and period: the stored settlement
 * lines (status and variance were computed at import) plus their totals.
 * DELIVERY_CHANNEL_UNKNOWN when the platform is not connected for the outlet.
 */
export async function getDeliveryReconciliation(
  context: ScopedTenantContext,
  outletId: OutletId,
  query: DeliveryReconciliationQuery,
): Promise<DeliveryReconciliation> {
  return withTenant(db, context, (tx) =>
    readDeliveryReconciliation(tx, context.tenant.tenantId, outletId, query),
  );
}

/** The read inside the caller's tenant transaction (also used by tests). */
export async function readDeliveryReconciliation(
  tx: Tx,
  tenantId: TenantId,
  outletId: OutletId,
  query: DeliveryReconciliationQuery,
): Promise<DeliveryReconciliation> {
  const [channel] = await tx
    .select({ platform: deliveryChannels.platform })
    .from(deliveryChannels)
    .where(
      and(
        eq(deliveryChannels.tenantId, tenantId),
        eq(deliveryChannels.outletId, outletId),
        eq(deliveryChannels.platform, query.platform),
      ),
    )
    .limit(1);
  if (!channel) throw new DeliveryError("DELIVERY_CHANNEL_UNKNOWN");

  const rows = await tx
    .select()
    .from(deliverySettlementLines)
    .where(
      and(
        eq(deliverySettlementLines.tenantId, tenantId),
        eq(deliverySettlementLines.outletId, outletId),
        eq(deliverySettlementLines.platform, query.platform),
        gte(deliverySettlementLines.settledOn, query.periodStart),
        lte(deliverySettlementLines.settledOn, query.periodEnd),
      ),
    )
    .orderBy(
      asc(deliverySettlementLines.settledOn),
      asc(deliverySettlementLines.externalOrderId),
    );
  const lines = rows.map(toDeliverySettlementLine);
  return {
    tenantId,
    outletId,
    platform: query.platform,
    periodStart: query.periodStart,
    periodEnd: query.periodEnd,
    lines,
    summary: deliveryReconciliationSummaryOf(lines),
  };
}

/**
 * Import a platform statement for one outlet inside the caller's tenant
 * transaction. Each line is matched to the internal order of the same platform
 * and outlet by external id: matched / variance record the received amount on
 * the order, an unknown external id becomes `unknown_order`. A statement
 * imported twice is the same line (unique tenant + platform + external id +
 * date): identical replays change nothing, a corrected line updates in place.
 */
export async function importDeliveryStatement(
  tx: Tx,
  context: ScopedTenantContext,
  input: DeliveryStatementImportInput,
): Promise<DeliveryStatementImportResult> {
  const tenantId = context.tenant.tenantId;
  const results: DeliverySettlementLine[] = [];
  const rejected: DeliveryStatementRejection[] = [];
  let appliedCount = 0;

  for (const line of input.lines) {
    const orderRow = await findByExternalId(
      tx,
      tenantId,
      input.platform,
      line.externalOrderId,
      { lock: true },
    );
    // An order of another outlet is not this outlet's order: unknown here.
    const order =
      orderRow && orderRow.outletId === input.outletId
        ? toDeliveryChannelOrder(orderRow)
        : null;
    const { status, varianceIdr } = reconcileDeliveryLine(order, {
      settledNetIdr: idr(line.settledNetIdr),
    });

    const [existing] = await tx
      .select()
      .from(deliverySettlementLines)
      .where(
        and(
          eq(deliverySettlementLines.tenantId, tenantId),
          eq(deliverySettlementLines.platform, input.platform),
          eq(deliverySettlementLines.externalOrderId, line.externalOrderId),
          eq(deliverySettlementLines.settledOn, line.settledOn),
        ),
      )
      .limit(1)
      .for("update");

    if (existing && existing.outletId !== input.outletId) {
      rejected.push({
        externalOrderId: line.externalOrderId,
        settledOn: line.settledOn,
        code: "OUTLET_MISMATCH",
      });
      continue;
    }

    const values = {
      outletId: input.outletId,
      grossIdr: idr(line.grossIdr),
      commissionIdr: idr(line.commissionIdr),
      settledNetIdr: idr(line.settledNetIdr),
      deliveryChannelOrderId: order?.id ?? null,
      status,
      varianceIdr,
    };
    const unchanged =
      existing !== undefined &&
      existing.outletId === values.outletId &&
      existing.grossIdr === line.grossIdr &&
      existing.commissionIdr === line.commissionIdr &&
      existing.settledNetIdr === line.settledNetIdr &&
      existing.deliveryChannelOrderId === values.deliveryChannelOrderId &&
      existing.status === status &&
      existing.varianceIdr === varianceIdr;
    if (unchanged) {
      results.push(toDeliverySettlementLine(existing));
      continue;
    }

    const [row] = existing
      ? await tx
          .update(deliverySettlementLines)
          .set(values)
          .where(
            and(
              eq(deliverySettlementLines.tenantId, tenantId),
              eq(deliverySettlementLines.id, existing.id),
            ),
          )
          .returning()
      : await tx
          .insert(deliverySettlementLines)
          .values({
            tenantId,
            platform: input.platform,
            externalOrderId: line.externalOrderId,
            settledOn: line.settledOn,
            ...values,
          })
          .returning();
    const saved = toDeliverySettlementLine(row);
    results.push(saved);
    appliedCount += 1;

    // A line that moved off its previous order leaves that order's sum.
    if (
      existing?.deliveryChannelOrderId &&
      existing.deliveryChannelOrderId !== order?.id
    )
      await recomputeOrderSettlement(
        tx,
        tenantId,
        existing.deliveryChannelOrderId,
        input.now,
      );
    if (order) {
      await recomputeOrderSettlement(tx, tenantId, order.id, input.now);
      await appendSettledEvent(tx, context, input, order.id, saved);
    }
    await recordAudit(tx, context, {
      id: createUlid(input.now.getTime()),
      tenantId,
      outletId: input.outletId,
      actorType: input.actorUserId ? "user" : "system",
      actorId: input.actorUserId,
      deviceId: null,
      action: "delivery_settlement.recorded",
      objectType: "delivery_settlement_line",
      objectId: saved.id,
      reason: null,
      maskedChanges: {
        before: existing
          ? { status: existing.status, varianceIdr: existing.varianceIdr }
          : null,
        after: {
          platform: input.platform,
          status: saved.status,
          varianceIdr: saved.varianceIdr,
          settledNetIdr: saved.settledNetIdr,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: input.now.toISOString(),
    });
  }
  return { lines: results, appliedCount, rejected };
}

/**
 * The order's received money is the sum of its matched lines (one per
 * statement date). No matched line left: unsettled. Settled at / net always
 * go together (delivery_channel_orders_settled_check).
 */
export async function recomputeOrderSettlement(
  tx: Tx,
  tenantId: TenantId,
  orderId: string,
  now: Date,
): Promise<void> {
  const [total] = await tx
    .select({
      count: sql<number>`count(*)`,
      net: sql<number>`coalesce(sum(${deliverySettlementLines.settledNetIdr}), 0)`,
    })
    .from(deliverySettlementLines)
    .where(
      and(
        eq(deliverySettlementLines.tenantId, tenantId),
        eq(deliverySettlementLines.deliveryChannelOrderId, orderId),
        inArray(deliverySettlementLines.status, ["matched", "variance"]),
      ),
    );
  const hasLines = Number(total?.count ?? 0) > 0;
  await tx
    .update(deliveryChannelOrders)
    .set(
      hasLines
        ? { settledAt: now, settledNetIdr: idr(Number(total.net)) }
        : { settledAt: null, settledNetIdr: null },
    )
    .where(
      and(
        eq(deliveryChannelOrders.tenantId, tenantId),
        eq(deliveryChannelOrders.id, orderId),
      ),
    );
}

/** Convenience wrapper: its own tenant transaction around the import. */
export async function importDeliveryStatementInTenant(
  context: ScopedTenantContext,
  input: DeliveryStatementImportInput,
): Promise<DeliveryStatementImportResult> {
  return withTenant(db, context, (tx) =>
    importDeliveryStatement(tx, context, input),
  );
}

async function appendSettledEvent(
  tx: Tx,
  context: ScopedTenantContext,
  input: DeliveryStatementImportInput,
  deliveryOrderId: string,
  line: DeliverySettlementLine,
): Promise<void> {
  const definition = deliveryEvents["delivery_order.settled"];
  const tenantId: TenantId = context.tenant.tenantId;
  const [last] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, definition.entry.aggregateType),
        eq(domainEventOutbox.aggregateId, deliveryOrderId),
      ),
    );
  const sequence = Number(last?.last ?? 0) + 1;
  const event = definition.envelopeSchema.parse({
    id: createUlid(input.now.getTime()),
    tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: deliveryOrderId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor: input.actorUserId
      ? { type: "user", id: input.actorUserId }
      : { type: "system" },
    deviceId: null,
    idempotencyKey: `${definition.name}:${deliveryOrderId}:${sequence}`.slice(
      0,
      100,
    ),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: {
      deliveryChannelOrderId: deliveryOrderId,
      platform: line.platform,
      externalOrderId: line.externalOrderId,
      grossIdr: line.grossIdr,
      commissionIdr: line.commissionIdr,
      settledNetIdr: line.settledNetIdr,
      varianceIdr: line.varianceIdr,
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}
