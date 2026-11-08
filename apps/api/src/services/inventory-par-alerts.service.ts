// Par levels: critical-stock alert evaluation and the open-alert list (PRD
// v1.7 §3 F16 "Par Level & Saran Pembelian": "Batas minimum dan maksimum per
// lokasi, peringatan stok kritis"; §3 "Notifikasi Operasional ... stok
// kritis"; bead legend-ugo). Par level CRUD belongs to legend-gjmk; this module
// only reads `par_levels`.
//
// Effective par (contract `effectiveParLevel`): a per-location `par_levels`
// row wins; otherwise the item defaults (`inventory_items.par_min/par_max`)
// apply to locations that hold a balance row for the item (same basis as the
// web purchase suggestions, legend-vxj). A pair is critical while its on-hand
// quantity is below `parMin` (`parStatus` = below_min).
//
// Dedupe: at most one OPEN `par_critical` alert per location/item (partial
// unique index). A new alert, and its `stock.critical` outbox event, is raised
// only when none is open; the alert is resolved once the stock is back at or
// above parMin (or the par is removed), so the next breach alerts again.

import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  createUlid,
  encodeCursor,
  formatDecimal4,
  parseDecimal4,
  z,
  type Decimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  effectiveParLevel,
  inventoryEvents,
  parStatus,
  stockAlertQuerySchema,
  stockAlertSchema,
  type StockAlert,
} from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import {
  inventoryItems,
  stockBalances,
  stockLocations,
} from "../db/schema/inventory.ts";
import {
  inventoryStockAlerts,
  type InventoryStockAlertKind,
} from "../db/schema/inventory-ops.ts";
import { parLevels } from "../db/schema/inventory-setup.ts";
import { withTenant } from "../db/tenant.ts";
import { appendOutbox } from "./core-outbox.ts";
import {
  assertOutlet,
  cursorInstant,
  cursorKeys,
  cursorUuid,
  EVENT_DESTINATION,
  lockLocations,
  requireOpsPermission,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { blindCountHiddenFilter } from "./inventory-count.visibility.ts";
import type { AlertEvaluationResult } from "./inventory-expiry.service.ts";

// ---- Response contract (proposed for packages/shared/src/inventory) -------

type AlertRow = typeof inventoryStockAlerts.$inferSelect;

function toAlert(row: AlertRow): StockAlert {
  return stockAlertSchema.parse({
    id: row.id,
    outletId: row.outletId,
    locationId: row.locationId,
    inventoryItemId: row.inventoryItemId,
    batchId: row.batchId,
    kind: row.kind,
    quantity: row.quantity,
    parMin: row.parMin,
    expiresOn: row.expiresOn,
    raisedAt: row.raisedAt.toISOString(),
  });
}

// ---- Evaluation -------------------------------------------------------------

export type StockPair = { locationId: string; inventoryItemId: string };

const pairKey = (locationId: string, itemId: string) =>
  `${locationId}:${itemId}`;

/**
 * The effective par and on-hand quantity of every location/item pair of an
 * outlet that has a par (or an open alert), narrowed to `pairs` when given.
 * Shared with the purchase suggestions (AI-08), so both read one basis.
 */
export async function parPositions(
  tx: Tx,
  outletId: string,
  pairs?: readonly StockPair[],
): Promise<
  Map<
    string,
    StockPair & {
      onHand: Decimal4;
      par: { parMin: Decimal4; parMax: Decimal4 } | null;
      parSource: "location" | "item_default" | null;
    }
  >
> {
  const wanted = pairs
    ? new Set(
        pairs.map((pair) => pairKey(pair.locationId, pair.inventoryItemId)),
      )
    : null;
  const locationIds = pairs
    ? [...new Set(pairs.map((pair) => pair.locationId))]
    : null;
  const itemFilterIds = pairs
    ? [...new Set(pairs.map((pair) => pair.inventoryItemId))]
    : null;
  const result = new Map<
    string,
    StockPair & {
      onHand: Decimal4;
      par: { parMin: Decimal4; parMax: Decimal4 } | null;
      parSource: "location" | "item_default" | null;
    }
  >();
  if (pairs && pairs.length === 0) return result;

  const balanceFilters: SQL[] = [eq(stockBalances.outletId, outletId)];
  const overrideFilters: SQL[] = [eq(parLevels.outletId, outletId)];
  if (locationIds && itemFilterIds) {
    balanceFilters.push(
      inArray(stockBalances.locationId, locationIds),
      inArray(stockBalances.inventoryItemId, itemFilterIds),
    );
    overrideFilters.push(
      inArray(parLevels.locationId, locationIds),
      inArray(parLevels.inventoryItemId, itemFilterIds),
    );
  }
  const balances = await tx
    .select()
    .from(stockBalances)
    .where(and(...balanceFilters));
  const overrides = await tx
    .select()
    .from(parLevels)
    .where(and(...overrideFilters));
  const itemIds = [
    ...new Set([
      ...balances.map((row) => row.inventoryItemId),
      ...overrides.map((row) => row.inventoryItemId),
    ]),
  ];
  const items =
    itemIds.length === 0
      ? []
      : await tx
          .select({
            id: inventoryItems.id,
            parMin: inventoryItems.parMin,
            parMax: inventoryItems.parMax,
            isActive: inventoryItems.isActive,
          })
          .from(inventoryItems)
          .where(inArray(inventoryItems.id, itemIds));
  const itemById = new Map(items.map((item) => [item.id, item]));
  const overrideByPair = new Map(
    overrides.map((row) => [pairKey(row.locationId, row.inventoryItemId), row]),
  );
  const balanceByPair = new Map(
    balances.map((row) => [pairKey(row.locationId, row.inventoryItemId), row]),
  );
  const keys = new Set([...balanceByPair.keys(), ...overrideByPair.keys()]);
  for (const key of keys) {
    if (wanted && !wanted.has(key)) continue;
    const balance = balanceByPair.get(key);
    const override = overrideByPair.get(key);
    const locationId = (balance ?? override)!.locationId;
    const inventoryItemId = (balance ?? override)!.inventoryItemId;
    const item = itemById.get(inventoryItemId);
    // An inactive item no longer raises alerts or suggestions.
    const par =
      item && item.isActive
        ? effectiveParLevel(
            { parMin: item.parMin, parMax: item.parMax },
            override ?? null,
          )
        : null;
    result.set(key, {
      locationId,
      inventoryItemId,
      onHand: balance?.quantity ?? formatDecimal4(0n),
      par,
      parSource: par === null ? null : override ? "location" : "item_default",
    });
  }
  return result;
}

async function appendStockCriticalEvent(
  tx: Tx,
  context: ScopedTenantContext,
  alert: AlertRow,
): Promise<void> {
  const occurredAt = alert.raisedAt.toISOString();
  const event = inventoryEvents["stock.critical"].envelopeSchema.parse({
    id: createUlid(alert.raisedAt.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: alert.outletId,
    name: "stock.critical",
    version: 1,
    // The envelope requires the aggregate type to match the name prefix.
    aggregateType: "stock",
    // One aggregate per alert row: sequence 1, a re-raise is a new alert.
    aggregateId: alert.id,
    sequence: 1,
    occurredAt,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `stock.critical:${alert.id}`,
    payloadSchemaRef: "stock.critical.v1",
    payload: {
      inventoryItemId: alert.inventoryItemId,
      locationId: alert.locationId,
      quantity: alert.quantity,
      parMin: alert.parMin,
      detectedAt: occurredAt,
    },
  });
  await appendOutbox(tx, context, {
    id: createUlid(),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * Re-evaluates the par status of an outlet (or of the `pairs` a write just
 * moved) inside the caller's transaction: raises a deduped alert + one
 * `stock.critical` event per new breach, resolves alerts whose stock
 * recovered. Writers call it after posting, while they still hold the
 * location locks, so the evaluation sees exactly their result.
 */
export async function evaluateParAlertsInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  options: { pairs?: readonly StockPair[]; now?: Date } = {},
): Promise<AlertEvaluationResult> {
  assertOutlet(context, outletId);
  const now = options.now ?? new Date();
  const positions = await parPositions(tx, outletId, options.pairs);
  const openFilters: SQL[] = [
    eq(inventoryStockAlerts.outletId, outletId),
    eq(inventoryStockAlerts.kind, "par_critical"),
    isNull(inventoryStockAlerts.resolvedAt),
  ];
  if (options.pairs) {
    if (options.pairs.length === 0) return { raised: 0, resolved: 0 };
    openFilters.push(
      inArray(inventoryStockAlerts.locationId, [
        ...new Set(options.pairs.map((pair) => pair.locationId)),
      ]),
      inArray(inventoryStockAlerts.inventoryItemId, [
        ...new Set(options.pairs.map((pair) => pair.inventoryItemId)),
      ]),
    );
  }
  const wanted = options.pairs
    ? new Set(
        options.pairs.map((pair) =>
          pairKey(pair.locationId, pair.inventoryItemId),
        ),
      )
    : null;
  const open = (
    await tx
      .select()
      .from(inventoryStockAlerts)
      .where(and(...openFilters))
  ).filter(
    (row) =>
      !wanted || wanted.has(pairKey(row.locationId, row.inventoryItemId)),
  );
  const openByPair = new Map(
    open.map((row) => [pairKey(row.locationId, row.inventoryItemId), row]),
  );

  let raised = 0;
  let resolved = 0;
  for (const [key, position] of positions) {
    const critical =
      position.par !== null &&
      parStatus(position.onHand, position.par) === "below_min";
    const existing = openByPair.get(key);
    if (critical && !existing) {
      const [alert] = await tx
        .insert(inventoryStockAlerts)
        .values({
          tenantId: context.tenant.tenantId,
          outletId,
          locationId: position.locationId,
          inventoryItemId: position.inventoryItemId,
          batchId: null,
          kind: "par_critical" satisfies InventoryStockAlertKind,
          quantity: position.onHand,
          parMin: position.par!.parMin,
          expiresOn: null,
          raisedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      // A concurrent evaluation that already opened it wins; no second event.
      if (alert) {
        raised += 1;
        await appendStockCriticalEvent(tx, context, alert);
      }
    }
    if (!critical && existing) {
      resolved += await resolveAlert(tx, existing.id, now);
    }
  }
  // An open alert whose pair no longer has a par (override removed, item
  // deactivated or never stocked) is resolved too.
  for (const [key, alert] of openByPair)
    if (!positions.has(key)) resolved += await resolveAlert(tx, alert.id, now);
  return { raised, resolved };
}

async function resolveAlert(tx: Tx, id: string, now: Date): Promise<number> {
  const updated = await tx
    .update(inventoryStockAlerts)
    .set({ resolvedAt: now })
    .where(
      and(
        eq(inventoryStockAlerts.id, id),
        isNull(inventoryStockAlerts.resolvedAt),
      ),
    )
    .returning({ id: inventoryStockAlerts.id });
  return updated.length;
}

/**
 * Job entry for one outlet: holds every location lock of the outlet (ascending)
 * so no movement commits between reading the balances and writing the alerts.
 */
export async function evaluateParAlertsForOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  outletId: string,
  now: Date = new Date(),
): Promise<AlertEvaluationResult> {
  assertOutlet(context, outletId);
  const locations = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(eq(stockLocations.outletId, outletId));
  await lockLocations(
    tx,
    context.tenant.tenantId,
    locations.map((row) => row.id),
  );
  return evaluateParAlertsInTransaction(tx, context, outletId, { now });
}

// ---- Open alert list ----------------------------------------------------------

/**
 * GET stock alerts: the OPEN alerts of one outlet, newest first (PRD §16
 * "peringatan stok kritis", "peringatan menjelang kedaluwarsa"). Needs
 * `inventory.stock.view` on the outlet.
 */
export async function listStockAlerts(
  context: ScopedTenantContext,
  actorUserId: string,
  query: z.infer<typeof stockAlertQuerySchema>,
): Promise<CursorPage<StockAlert>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    await requireOpsPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      query.outletId,
    );
    // Open blind counts hide their pairs from everyone (stock opname T1).
    const filters: SQL[] = [
      eq(inventoryStockAlerts.outletId, query.outletId),
      isNull(inventoryStockAlerts.resolvedAt),
      blindCountHiddenFilter(inventoryStockAlerts),
    ];
    if (query.kind) filters.push(eq(inventoryStockAlerts.kind, query.kind));
    if (query.locationId)
      filters.push(eq(inventoryStockAlerts.locationId, query.locationId));
    const [raisedAt, id] = cursorKeys(query.cursor, 2);
    if (raisedAt !== undefined && id !== undefined) {
      const at = cursorInstant(raisedAt);
      filters.push(
        or(
          lt(inventoryStockAlerts.raisedAt, at),
          and(
            eq(inventoryStockAlerts.raisedAt, at),
            sql`${inventoryStockAlerts.id} < ${cursorUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(inventoryStockAlerts)
      .where(and(...filters))
      .orderBy(
        desc(inventoryStockAlerts.raisedAt),
        desc(inventoryStockAlerts.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toAlert),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.raisedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

/** Helper for the suggestions ranking: onHand / parMin without floats. */
export function shortfallRatioCompare(
  left: { onHand: Decimal4; parMin: Decimal4 },
  right: { onHand: Decimal4; parMin: Decimal4 },
): number {
  const a = parseDecimal4(left.onHand) * parseDecimal4(right.parMin);
  const b = parseDecimal4(right.onHand) * parseDecimal4(left.parMin);
  return a < b ? -1 : a > b ? 1 : 0;
}
