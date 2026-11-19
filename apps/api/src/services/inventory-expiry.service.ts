// Batch & expiry: FEFO stock consumption, the live expiry alert list and the
// deduped expiry alert evaluation (PRD v1.7 §3 F16 "Batch & Kedaluwarsa":
// "peringatan menjelang kedaluwarsa, dan saran FEFO"; §6 E `stock_batches`;
// bead legend-ugo).
//
// Batch stock is derived from the append-only ledger: a batch holds the sum of
// the ledger rows that carry its id. Not every outflow names a batch (a sale
// deducted by recipe does not), so the batch sums can exceed the location's
// balance. The FEFO assumption resolves that: what left without a batch left
// from the earliest-expiring batches, so the on-hand balance is attributed to
// the LATEST batches first (`fefoAvailability`). Consumption then draws the
// EARLIEST-expiring available batches first (`allocateFefo`), batches without
// an expiry after dated ones, and unbatched stock last.

import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  addBusinessDays,
  businessDateOf,
  formatDecimal4,
  parseDecimal4,
  z,
  type BusinessDate,
  type Decimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  batchExpiryStatus,
  DEFAULT_EXPIRY_WARNING_DAYS,
  fefoSort,
  stockBatchSchema,
  type StockBatch,
  type StockBatchId,
  type StockMovementType,
  type StockSourceType,
  expiryAlertQuerySchema,
  expiryAlertSchema,
  type ExpiryAlert,
} from "@starter/shared/inventory";
import { db } from "../db/index.ts";
import {
  stockBalances,
  stockBatches,
  stockLedger,
  stockLocations,
} from "../db/schema/inventory.ts";
import { inventoryStockAlerts } from "../db/schema/inventory-ops.ts";
import { inventorySettings } from "../db/schema/inventory-setup.ts";
import { withTenant } from "../db/tenant.ts";
import {
  assertOutlet,
  blindCountLocked,
  insufficientStock,
  loadOutletClock,
  lockLocations,
  requireOpsPermission,
  type Tx,
} from "./inventory-ops.shared.ts";
import {
  blindCountHiddenFilter,
  isBlindCountCounterOfPair,
} from "./inventory-count.visibility.ts";
import { recordStockMovementInTransaction } from "./inventory.service.ts";

// ---- Response contract (proposed for packages/shared/src/inventory) -------

/**
 * One batch that needs attention: expired or inside the tenant's warning
 * window, with the quantity the FEFO attribution says is still on hand.
 * `fefoRank` 1 is the batch to use first for its location + item.
 */

// ---- Pure FEFO helpers ----------------------------------------------------

export type BatchStock = { batch: StockBatch; remaining: Decimal4 };
export type BatchAvailability = { batch: StockBatch; available: Decimal4 };

/**
 * Attributes the on-hand balance to batches, latest expiry first (FEFO: the
 * stock that already left was the earliest-expiring). Returns the batches in
 * FEFO order with their available quantity (zero rows dropped) and the
 * unbatched remainder. A negative balance attributes nothing.
 */
export function fefoAvailability(
  batches: readonly BatchStock[],
  onHand: Decimal4,
): { batches: BatchAvailability[]; unbatched: Decimal4 } {
  const remaining = new Map(
    batches.map((row) => [row.batch.id, parseDecimal4(row.remaining)]),
  );
  const ordered = fefoSort(batches.map((row) => row.batch));
  let left = parseDecimal4(onHand);
  if (left < 0n) left = 0n;
  const available = new Map<string, bigint>();
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const batch = ordered[index]!;
    const own = remaining.get(batch.id) ?? 0n;
    const take = own <= 0n ? 0n : own < left ? own : left;
    available.set(batch.id, take);
    left -= take;
  }
  return {
    batches: ordered
      .filter((batch) => (available.get(batch.id) ?? 0n) > 0n)
      .map((batch) => ({
        batch,
        available: formatDecimal4(available.get(batch.id)!),
      })),
    unbatched: formatDecimal4(left),
  };
}

export type FefoAllocation = { batch: StockBatch | null; quantity: Decimal4 };

/**
 * Draws `quantity` earliest-expiry first, unbatched stock last. Throws when
 * the availability cannot cover it (the caller already checked the balance,
 * so this only fires on a broken invariant).
 */
export function allocateFefo(
  availability: { batches: readonly BatchAvailability[]; unbatched: Decimal4 },
  quantity: Decimal4,
): FefoAllocation[] {
  let left = parseDecimal4(quantity);
  const allocations: FefoAllocation[] = [];
  for (const row of availability.batches) {
    if (left <= 0n) break;
    const own = parseDecimal4(row.available);
    const take = own < left ? own : left;
    if (take > 0n) {
      allocations.push({ batch: row.batch, quantity: formatDecimal4(take) });
      left -= take;
    }
  }
  if (left > 0n) {
    const unbatched = parseDecimal4(availability.unbatched);
    if (unbatched < left) throw new Error("FEFO allocation exceeds stock");
    allocations.push({ batch: null, quantity: formatDecimal4(left) });
  }
  return allocations;
}

function daysBetween(from: BusinessDate, to: string): number {
  const utc = (value: string) => {
    const [year, month, day] = value.split("-").map(Number) as [
      number,
      number,
      number,
    ];
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

// ---- Batch stock queries --------------------------------------------------

type BatchRow = typeof stockBatches.$inferSelect;

function toBatch(row: BatchRow): StockBatch {
  return stockBatchSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    locationId: row.locationId,
    inventoryItemId: row.inventoryItemId,
    batchCode: row.batchCode,
    expiresOn: row.expiresOn,
    receivedAt: row.receivedAt.toISOString(),
  });
}

/** Batches with a positive ledger remainder, matching `filters`. */
async function loadBatchStock(tx: Tx, filters: SQL[]): Promise<BatchStock[]> {
  const rows = await tx
    .select({
      batch: stockBatches,
      remaining: sql<string>`coalesce(sum(${stockLedger.quantity}), 0)::numeric(14,4)::text`,
    })
    .from(stockBatches)
    .leftJoin(
      stockLedger,
      and(
        eq(stockLedger.tenantId, stockBatches.tenantId),
        eq(stockLedger.batchId, stockBatches.id),
      ),
    )
    .where(and(...filters))
    .groupBy(stockBatches.id)
    .having(sql`coalesce(sum(${stockLedger.quantity}), 0) > 0`);
  return rows.map((row) => ({
    batch: toBatch(row.batch),
    remaining: formatDecimal4(parseDecimal4(row.remaining)),
  }));
}

const pairKey = (locationId: string, itemId: string) =>
  `${locationId}:${itemId}`;

/**
 * FEFO availability for a set of location/item pairs, from the balances and
 * every batch with stock of those pairs (not only the expiring ones: later
 * batches absorb the on-hand balance first).
 */
async function availabilityForPairs(
  tx: Tx,
  outletId: string,
  pairs: readonly { locationId: string; inventoryItemId: string }[],
): Promise<Map<string, ReturnType<typeof fefoAvailability>>> {
  const result = new Map<string, ReturnType<typeof fefoAvailability>>();
  if (pairs.length === 0) return result;
  const locationIds = [...new Set(pairs.map((pair) => pair.locationId))];
  const itemIds = [...new Set(pairs.map((pair) => pair.inventoryItemId))];
  const wanted = new Set(
    pairs.map((pair) => pairKey(pair.locationId, pair.inventoryItemId)),
  );
  const batches = await loadBatchStock(tx, [
    eq(stockBatches.outletId, outletId),
    inArray(stockBatches.locationId, locationIds),
    inArray(stockBatches.inventoryItemId, itemIds),
  ]);
  const balances = await tx
    .select()
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.outletId, outletId),
        inArray(stockBalances.locationId, locationIds),
        inArray(stockBalances.inventoryItemId, itemIds),
      ),
    );
  const onHand = new Map(
    balances.map((row) => [
      pairKey(row.locationId, row.inventoryItemId),
      row.quantity,
    ]),
  );
  const grouped = new Map<string, BatchStock[]>();
  for (const row of batches) {
    const key = pairKey(row.batch.locationId, row.batch.inventoryItemId);
    if (!wanted.has(key)) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  for (const key of wanted)
    result.set(
      key,
      fefoAvailability(
        grouped.get(key) ?? [],
        onHand.get(key) ?? formatDecimal4(0n),
      ),
    );
  return result;
}

// ---- FEFO consumption ------------------------------------------------------

export type FefoConsumption = {
  allocations: FefoAllocation[];
  /** Moving-average unit cost of the location when the stock left. */
  unitCostIdr: Decimal4;
  /** Σ quantity x unit cost at 10^8 scale (round once at the document). */
  scaledCost: bigint;
};

/**
 * Takes `quantity` (positive, base unit) of one item out of one location in
 * FEFO order, one ledger row per batch drawn, valued at the location's moving
 * average (PRD §16 "Metode Biaya"). Serialised by the location advisory lock
 * and the balance row lock taken BEFORE the balance is read, so two
 * concurrent consumers can never both pass the stock check (no oversell, no
 * negative-stock bypass). Must run inside the caller's tenant transaction.
 */
export async function consumeStockFefo(
  tx: Tx,
  context: ScopedTenantContext,
  input: {
    outletId: string;
    locationId: string;
    inventoryItemId: string;
    quantity: Decimal4;
    movementType: Extract<
      StockMovementType,
      "waste" | "production_out" | "transfer_out"
    >;
    sourceType: StockSourceType;
    sourceId: string;
    actorUserId: string;
  },
): Promise<FefoConsumption> {
  assertOutlet(context, input.outletId);
  const wanted = parseDecimal4(input.quantity);
  if (wanted <= 0n)
    throw new Error("FEFO consumption needs a positive quantity");
  await lockLocations(tx, context.tenant.tenantId, [input.locationId]);
  // A counter of an open blind count must not learn the hidden quantity from
  // a stock-out that succeeds or fails on it: refuse BEFORE the stock check.
  if (
    await isBlindCountCounterOfPair(tx, {
      locationId: input.locationId,
      inventoryItemId: input.inventoryItemId,
      userId: input.actorUserId,
    })
  )
    throw blindCountLocked();
  const [balance] = await tx
    .select()
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.locationId, input.locationId),
        eq(stockBalances.inventoryItemId, input.inventoryItemId),
        eq(stockBalances.outletId, input.outletId),
      ),
    )
    .for("update");
  if (!balance || parseDecimal4(balance.quantity) < wanted)
    throw insufficientStock(input.inventoryItemId);
  const batches = await loadBatchStock(tx, [
    eq(stockBatches.outletId, input.outletId),
    eq(stockBatches.locationId, input.locationId),
    eq(stockBatches.inventoryItemId, input.inventoryItemId),
  ]);
  const allocations = allocateFefo(
    fefoAvailability(batches, balance.quantity),
    input.quantity,
  );
  const unitCostIdr = balance.avgCostIdr;
  let scaledCost = 0n;
  for (const allocation of allocations) {
    await recordStockMovementInTransaction(tx, context, {
      outletId: input.outletId,
      locationId: input.locationId,
      inventoryItemId: input.inventoryItemId,
      movementType: input.movementType,
      quantity: formatDecimal4(-parseDecimal4(allocation.quantity)),
      unitCostIdr,
      batchId: allocation.batch?.id ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      actor: { type: "user", id: input.actorUserId },
    });
    scaledCost +=
      parseDecimal4(allocation.quantity) * parseDecimal4(unitCostIdr);
  }
  return { allocations, unitCostIdr, scaledCost };
}

// ---- Expiry window ----------------------------------------------------------

/** Tenant warning window (legend-gjmk settings), contract default otherwise. */
export async function expiryWarningDays(
  tx: Tx,
  context: ScopedTenantContext,
): Promise<number> {
  const [row] = await tx
    .select({ days: inventorySettings.expiryWarningDays })
    .from(inventorySettings)
    .where(eq(inventorySettings.tenantId, context.tenant.tenantId));
  return row?.days ?? DEFAULT_EXPIRY_WARNING_DAYS;
}

type ExpiringBatch = {
  batch: StockBatch;
  status: "expired" | "expiring_soon";
  daysUntilExpiry: number;
  availableQty: Decimal4;
  fefoRank: number;
};

/**
 * Batches of one outlet that are expired or inside the warning window on the
 * outlet business date `asOf` (D-CORE-6) and still hold stock after the FEFO
 * attribution, in FEFO order.
 */
async function expiringBatches(
  tx: Tx,
  outletId: string,
  asOf: BusinessDate,
  warnDays: number,
  filter: {
    locationId?: string;
    inventoryItemId?: string;
    /** Set by user reads: drops the pairs of open blind counts. */
    hideBlind?: boolean;
  } = {},
): Promise<ExpiringBatch[]> {
  const horizon = addBusinessDays(asOf, warnDays);
  const filters: SQL[] = [
    eq(stockBatches.outletId, outletId),
    lte(stockBatches.expiresOn, horizon),
  ];
  if (filter.locationId)
    filters.push(eq(stockBatches.locationId, filter.locationId));
  if (filter.inventoryItemId)
    filters.push(eq(stockBatches.inventoryItemId, filter.inventoryItemId));
  if (filter.hideBlind) filters.push(blindCountHiddenFilter(stockBatches));
  const candidates = await loadBatchStock(tx, filters);
  if (candidates.length === 0) return [];
  const availability = await availabilityForPairs(
    tx,
    outletId,
    candidates.map((row) => ({
      locationId: row.batch.locationId,
      inventoryItemId: row.batch.inventoryItemId,
    })),
  );
  const result: ExpiringBatch[] = [];
  for (const candidate of candidates) {
    const key = pairKey(
      candidate.batch.locationId,
      candidate.batch.inventoryItemId,
    );
    const pair = availability.get(key);
    const index =
      pair?.batches.findIndex((row) => row.batch.id === candidate.batch.id) ??
      -1;
    if (!pair || index < 0) continue;
    const status = batchExpiryStatus(candidate.batch, asOf, warnDays);
    if (status !== "expired" && status !== "expiring_soon") continue;
    result.push({
      batch: candidate.batch,
      status,
      daysUntilExpiry: daysBetween(asOf, candidate.batch.expiresOn!),
      availableQty: pair.batches[index]!.available,
      fefoRank: index + 1,
    });
  }
  const order = new Map(
    fefoSort(result.map((row) => row.batch)).map((batch, index) => [
      batch.id,
      index,
    ]),
  );
  return result.sort(
    (left, right) => order.get(left.batch.id)! - order.get(right.batch.id)!,
  );
}

/**
 * GET expiry alerts: the live "use first" list of one outlet (PRD §16 "saran
 * FEFO"). Needs `inventory.stock.view` on the outlet.
 */
export async function listExpiryAlerts(
  context: ScopedTenantContext,
  actorUserId: string,
  query: z.infer<typeof expiryAlertQuerySchema>,
): Promise<ExpiryAlert[]> {
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
    const clock = await loadOutletClock(tx, query.outletId);
    const asOf = businessDateOf(new Date(), clock);
    const warnDays = await expiryWarningDays(tx, context);
    const rows = await expiringBatches(tx, query.outletId, asOf, warnDays, {
      locationId: query.locationId,
      inventoryItemId: query.inventoryItemId,
      hideBlind: true,
    });
    return rows.map((row) =>
      expiryAlertSchema.parse({ ...row, asOf, warnDays }),
    );
  });
}

// ---- Deduped expiry alert evaluation (job) ---------------------------------

export type AlertEvaluationResult = { raised: number; resolved: number };

/**
 * Raises one OPEN alert per batch and stage (`expiring_soon`, then `expired`)
 * and resolves it once the batch is used up, wasted, or moves to the next
 * stage. Re-running never repeats an open alert (partial unique index + ON
 * CONFLICT DO NOTHING). Holds the outlet's location locks so the evaluation
 * sees the same stock a concurrent movement would. System job: the caller
 * passes a trusted tenant context (worker), no user permission applies.
 */
export async function evaluateExpiryAlertsForOutlet(
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
  const clock = await loadOutletClock(tx, outletId);
  const asOf = businessDateOf(now, clock);
  const warnDays = await expiryWarningDays(tx, context);
  const desired = new Map(
    (await expiringBatches(tx, outletId, asOf, warnDays)).map((row) => [
      row.batch.id,
      row,
    ]),
  );
  const open = await tx
    .select()
    .from(inventoryStockAlerts)
    .where(
      and(
        eq(inventoryStockAlerts.outletId, outletId),
        isNull(inventoryStockAlerts.resolvedAt),
        or(
          eq(inventoryStockAlerts.kind, "expiring_soon"),
          eq(inventoryStockAlerts.kind, "expired"),
        ),
      ),
    )
    .orderBy(asc(inventoryStockAlerts.raisedAt));
  let resolved = 0;
  const stillOpen = new Set<string>();
  for (const alert of open) {
    const want = alert.batchId
      ? desired.get(alert.batchId as StockBatchId)
      : undefined;
    if (want && want.status === alert.kind) {
      stillOpen.add(`${alert.batchId}:${alert.kind}`);
      continue;
    }
    const updated = await tx
      .update(inventoryStockAlerts)
      .set({ resolvedAt: now })
      .where(
        and(
          eq(inventoryStockAlerts.id, alert.id),
          isNull(inventoryStockAlerts.resolvedAt),
        ),
      )
      .returning({ id: inventoryStockAlerts.id });
    resolved += updated.length;
  }
  let raised = 0;
  for (const row of desired.values()) {
    if (stillOpen.has(`${row.batch.id}:${row.status}`)) continue;
    const inserted = await tx
      .insert(inventoryStockAlerts)
      .values({
        tenantId: context.tenant.tenantId,
        outletId,
        locationId: row.batch.locationId,
        inventoryItemId: row.batch.inventoryItemId,
        batchId: row.batch.id,
        kind: row.status,
        quantity: row.availableQty,
        parMin: null,
        expiresOn: row.batch.expiresOn,
        raisedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: inventoryStockAlerts.id });
    raised += inserted.length;
  }
  return { raised, resolved };
}
