// Inventory & warehouse services (PRD v1.7 §6 E, §16 "Inventori & Gudang",
// §17; bead legend-98t, INV-01). One module for this bead's contract slice:
// items + UOMs, storage locations, the append-only stock ledger, derived
// balances with a moving average per location, batches/expiry and internal
// transfers.
//
// Rules that live here, not in the routes:
// - Every query runs inside `withTenant`, so Postgres RLS scopes rows to the
//   tenant from the server-minted context (TEN-02). A caller's outlet scope is
//   checked again in the service (`assertOutletInScope`, TEN-03), so a route
//   that forgot its middleware still cannot read or write another outlet.
// - Permission + scope is re-checked against stored role assignments
//   (`loadTenantAccessInTransaction`), independent of the route middleware.
// - The stock ledger is append-only (INV-01): this module only inserts rows;
//   corrections are new `adjustment` rows sourced from an approved stock count.
//   `stock_balances` is a cache rebuilt from the ledger; a movement updates it
//   in the same transaction under a `FOR UPDATE` row lock.
// - The moving-average rule is the shared contract's `applyStockMovement`, and
//   a rebuild folds with `foldStockLedger`; neither is re-implemented here.
// - Expected failures are translated to `HttpError` / `CoreError` with documented
//   statuses (the inventory contract defines no HTTP mapping, docs/backend.md).

import { and, asc, desc, eq, gt, lte, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  createUlid,
  CoreError,
  decimal4,
  decodeCursor,
  encodeCursor,
  formatDecimal4,
  parseDecimal4,
  ulidSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  AccessError,
  type AccessTarget,
  type PermissionCode,
} from "@starter/shared/access";
import { maskAuditChanges } from "@starter/shared/audit";
import type { BusinessDate, Decimal4, IsoDateTime } from "@starter/shared/core";
import {
  applyStockMovement,
  createInventoryItemInputSchema,
  foldStockLedger,
  inventoryEvents,
  inventoryItemSchema,
  stockBalanceSchema,
  stockBatchSchema,
  stockLedgerEntrySchema,
  stockLocationSchema,
  stockTransferSchema,
  uomConversionSchema,
  uomSchema,
  updateInventoryItemInputSchema,
  type InventoryItem,
  type StockBatch,
  type StockLedgerEntry,
  type StockMovementType,
  type StockSourceType,
  type StockTransfer,
  type Uom,
  type UomConversion,
} from "@starter/shared/inventory";
import type { z } from "zod";
import type * as schema from "../db/schema";
import {
  inventoryItems,
  stockBalances,
  stockBatches,
  stockLedger,
  stockLocations,
  stockTransferLines,
  stockTransfers,
  uomConversions,
  uoms,
} from "../db/schema";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { appendOutbox } from "./core-outbox";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
} from "./permission-resolver";

type CreateInventoryItemInput = z.infer<typeof createInventoryItemInputSchema>;
type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemInputSchema>;
type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type CursorPage<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

/** Event destination used by the WS-06 outbox writers on this branch. */
const EVENT_DESTINATION = "cloud-sync";
/** Tenant default while the rounding setting (PRD F11/WS-05) is not wired. */
const ROUNDING_MODE = "half_up" as const;
/** Source documents whose ids are ULIDs (D-CORE-1). */
const ULID_SOURCE_TYPES: ReadonlySet<StockSourceType> = new Set([
  "order",
  "stock_transfer",
]);

// --------------------------------------------------------------- guards

/** Server-side permission check, independent of the route middleware. */
async function assertPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  target: AccessTarget,
): Promise<void> {
  const data = await loadTenantAccessInTransaction(tx, context, actorUserId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actorUserId,
    ...data,
    mfaVerified: false,
    now: new Date(),
  });
  if (!snapshot.allows(permission, target))
    throw new AccessError("PERMISSION_DENIED");
}

function outletTarget(outletId: string): AccessTarget {
  return { type: "outlet", id: outletId };
}

/** TEN-03: a requested outlet must be inside the caller's outlet scope. */
function assertOutlet(context: ScopedTenantContext, outletId: string): void {
  assertOutletInScope(context.outletScope, outletId);
}

/** Strict cursor decode; a tampered cursor is a 422, never a 500. */
function cursorKeys(
  cursor: string | undefined,
  size: number,
  message = "Check the cursor.",
): string[] {
  if (!cursor) return [];
  let keys: ReturnType<typeof decodeCursor>;
  try {
    keys = decodeCursor(cursor);
  } catch {
    // A tampered cursor is client input, not a server failure (D-CORE-5).
    throw new HttpError(422, "VALIDATION_ERROR", message);
  }
  if (keys.length !== size || keys.some((key) => typeof key !== "string"))
    throw new HttpError(422, "VALIDATION_ERROR", message);
  return keys as string[];
}

function sourceIdFromDb(type: StockSourceType, value: string): string {
  return ULID_SOURCE_TYPES.has(type) ? uuidToUlid(value) : value;
}

function sourceIdToDb(value: string): string {
  return ulidSchema.safeParse(value).success ? ulidToUuid(value) : value;
}

function negate(quantity: Decimal4): Decimal4 {
  return formatDecimal4(-parseDecimal4(quantity));
}

// ------------------------------------------------------------------ mappers

type ItemRow = typeof inventoryItems.$inferSelect;
type UomRow = typeof uoms.$inferSelect;
type ConversionRow = typeof uomConversions.$inferSelect;
type LocationRow = typeof stockLocations.$inferSelect;
type LedgerRow = typeof stockLedger.$inferSelect;
type BalanceRow = typeof stockBalances.$inferSelect;
type BatchRow = typeof stockBatches.$inferSelect;

function toItem(row: ItemRow): InventoryItem {
  return inventoryItemSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    category: row.category,
    type: row.type,
    baseUomId: row.baseUomId,
    isPerishable: row.isPerishable,
    isActive: row.isActive,
    parMin: row.parMin,
    parMax: row.parMax,
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toUom(row: UomRow): Uom {
  return uomSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    code: row.code,
    name: row.name,
  });
}

function toConversion(row: ConversionRow): UomConversion {
  return uomConversionSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    inventoryItemId: row.inventoryItemId,
    fromUomId: row.fromUomId,
    toUomId: row.toUomId,
    factor: row.factor,
  });
}

function toLocation(row: LocationRow) {
  return stockLocationSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: row.name,
    type: row.type,
    isActive: row.isActive,
  });
}

function toLedgerEntry(row: LedgerRow): StockLedgerEntry {
  return stockLedgerEntrySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    locationId: row.locationId,
    inventoryItemId: row.inventoryItemId,
    movementType: row.movementType,
    quantity: row.quantity,
    unitCostIdr: row.unitCostIdr,
    batchId: row.batchId,
    sourceType: row.sourceType,
    sourceId: sourceIdFromDb(row.sourceType, row.sourceId),
    occurredAt: row.occurredAt.toISOString(),
  });
}

function toBalance(row: BalanceRow) {
  return stockBalanceSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    locationId: row.locationId,
    inventoryItemId: row.inventoryItemId,
    quantity: row.quantity,
    avgCostIdr: row.avgCostIdr,
    updatedAt: row.updatedAt.toISOString(),
  });
}

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

// --------------------------------------------------------------- items

export async function listInventoryItems(
  context: ScopedTenantContext,
  actorUserId: string,
  query: {
    limit: number;
    cursor?: string;
    category?: string;
    type?: string;
  },
): Promise<CursorPage<InventoryItem>> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, "inventory.stock.view", {
      type: "tenant",
    });
    const filters: SQL[] = [];
    if (query.category)
      filters.push(eq(inventoryItems.category, query.category));
    if (query.type)
      filters.push(eq(inventoryItems.type, query.type as ItemRow["type"]));
    const [name, id] = cursorKeys(query.cursor, 2);
    if (name !== undefined && id !== undefined)
      filters.push(
        or(
          gt(inventoryItems.name, name),
          and(eq(inventoryItems.name, name), gt(inventoryItems.id, id)),
        )!,
      );
    const rows = await tx
      .select()
      .from(inventoryItems)
      .where(and(...filters))
      .orderBy(asc(inventoryItems.name), asc(inventoryItems.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toItem),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.name, last.id])
            : null,
      },
    };
  });
}

export async function getInventoryItem(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
): Promise<InventoryItem> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, "inventory.stock.view", {
      type: "tenant",
    });
    const [row] = await tx
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.id, itemId));
    if (!row)
      throw new HttpError(404, "NOT_FOUND", "Inventory item not found.");
    return toItem(row);
  });
}

/**
 * Item master write. The permission catalog has no `inventory.item.manage`
 * code yet, so the receive permission (the operation that introduces an item)
 * gates master-data writes; see the bead report for the follow-up.
 */
export async function createInventoryItem(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateInventoryItemInput,
): Promise<InventoryItem> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.receive",
      { type: "tenant" },
    );
    const [uom] = await tx
      .select()
      .from(uoms)
      .where(eq(uoms.id, input.baseUomId));
    if (!uom)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "baseUomId is not a unit of this tenant.",
      );
    if (input.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(inventoryItems)
        .where(eq(inventoryItems.idempotencyKey, input.idempotencyKey));
      if (existing) return replayItem(existing, input);
    }
    const [row] = await tx
      .insert(inventoryItems)
      .values({
        tenantId: context.tenant.tenantId,
        name: input.name,
        category: input.category,
        type: input.type,
        baseUomId: input.baseUomId,
        isPerishable: input.isPerishable,
        parMin: input.parMin ?? null,
        parMax: input.parMax ?? null,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    const item = toItem(row!);
    await auditItemChange(
      tx,
      context,
      actorUserId,
      "inventory_item.created",
      null,
      item,
    );
    return item;
  });
}

/** Same key + same request returns the first result; a different one is a 409. */
function replayItem(
  row: ItemRow,
  input: CreateInventoryItemInput,
): InventoryItem {
  const item = toItem(row);
  const same =
    item.name === input.name &&
    item.category === input.category &&
    item.type === input.type &&
    item.baseUomId === input.baseUomId &&
    item.isPerishable === input.isPerishable &&
    (item.parMin ?? null) === (input.parMin ?? null) &&
    (item.parMax ?? null) === (input.parMax ?? null);
  if (!same)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was used for a different item.",
    );
  return item;
}

export async function updateInventoryItem(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  input: UpdateInventoryItemInput,
): Promise<InventoryItem> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.receive",
      { type: "tenant" },
    );
    const [existing] = await tx
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.id, itemId));
    if (!existing)
      throw new HttpError(404, "NOT_FOUND", "Inventory item not found.");
    // Optimistic concurrency (contract `expectedUpdatedAt`).
    if (existing.updatedAt.toISOString() !== input.expectedUpdatedAt)
      throw new CoreError(
        "PRECONDITION_FAILED",
        "The item changed since it was read; reload it and try again.",
      );
    const parMin = input.parMin === undefined ? existing.parMin : input.parMin;
    const parMax = input.parMax === undefined ? existing.parMax : input.parMax;
    if (
      parMin !== null &&
      parMax !== null &&
      parseDecimal4(parMax) < parseDecimal4(parMin)
    )
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "parMax must be at least parMin.",
      );
    const [row] = await tx
      .update(inventoryItems)
      .set({
        name: input.name ?? existing.name,
        category: input.category ?? existing.category,
        isPerishable: input.isPerishable ?? existing.isPerishable,
        isActive: input.isActive ?? existing.isActive,
        parMin,
        parMax,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItems.id, itemId))
      .returning();
    const before = toItem(existing);
    const after = toItem(row!);
    await auditItemChange(
      tx,
      context,
      actorUserId,
      "inventory_item.updated",
      before,
      after,
    );
    return after;
  });
}

const ITEM_AUDIT_FIELDS = [
  "category",
  "type",
  "baseUomId",
  "isPerishable",
  "isActive",
  "parMin",
  "parMax",
] as const;

async function auditItemChange(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  action: string,
  before: InventoryItem | null,
  after: InventoryItem,
): Promise<void> {
  const now = new Date();
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: null,
      actorType: "user",
      actorId: actorUserId,
      deviceId: null,
      action,
      objectType: "inventory_item",
      objectId: after.id,
      reason: null,
      // Item names are a sensitive audit key, so pre-mask every change; the
      // audit service masks again with the same safe list.
      maskedChanges: {
        before:
          before === null ? null : maskAuditChanges(before, ITEM_AUDIT_FIELDS),
        after: maskAuditChanges(after, ITEM_AUDIT_FIELDS),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    ITEM_AUDIT_FIELDS,
  );
}

// ---------------------------------------------------------------- UOMs

export async function listUoms(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { limit: number; cursor?: string },
): Promise<CursorPage<Uom>> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, "inventory.stock.view", {
      type: "tenant",
    });
    const filters: SQL[] = [];
    const [code, id] = cursorKeys(query.cursor, 2);
    if (code !== undefined && id !== undefined)
      filters.push(
        or(gt(uoms.code, code), and(eq(uoms.code, code), gt(uoms.id, id)))!,
      );
    const rows = await tx
      .select()
      .from(uoms)
      .where(and(...filters))
      .orderBy(asc(uoms.code), asc(uoms.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toUom),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.code, last.id])
            : null,
      },
    };
  });
}

export async function listUomConversions(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
): Promise<UomConversion[]> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, "inventory.stock.view", {
      type: "tenant",
    });
    const [item] = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, itemId));
    if (!item)
      throw new HttpError(404, "NOT_FOUND", "Inventory item not found.");
    const rows = await tx
      .select()
      .from(uomConversions)
      .where(eq(uomConversions.inventoryItemId, itemId))
      .orderBy(asc(uomConversions.fromUomId), asc(uomConversions.toUomId));
    return rows.map(toConversion);
  });
}

// ----------------------------------------------------------- locations

export async function listStockLocations(
  context: ScopedTenantContext,
  actorUserId: string,
  query: { limit: number; cursor?: string; outletId: string },
): Promise<CursorPage<ReturnType<typeof toLocation>>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      outletTarget(query.outletId),
    );
    const filters: SQL[] = [eq(stockLocations.outletId, query.outletId)];
    const [name, id] = cursorKeys(query.cursor, 2);
    if (name !== undefined && id !== undefined)
      filters.push(
        or(
          gt(stockLocations.name, name),
          and(eq(stockLocations.name, name), gt(stockLocations.id, id)),
        )!,
      );
    const rows = await tx
      .select()
      .from(stockLocations)
      .where(and(...filters))
      .orderBy(asc(stockLocations.name), asc(stockLocations.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toLocation),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.name, last.id])
            : null,
      },
    };
  });
}

// ------------------------------------------------------------- batches

/** Registers a batch for a receipt (PRD §16 "Batch & Kedaluwarsa"). */
export async function createStockBatch(
  context: ScopedTenantContext,
  input: {
    outletId: string;
    locationId: string;
    inventoryItemId: string;
    batchCode: string;
    expiresOn?: BusinessDate | null;
    receivedAt?: IsoDateTime;
  },
): Promise<StockBatch> {
  assertOutlet(context, input.outletId);
  return withTenant(db, context, async (tx) => {
    await requireLocation(tx, input.outletId, input.locationId);
    await requireItem(tx, input.inventoryItemId);
    const [row] = await tx
      .insert(stockBatches)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        locationId: input.locationId,
        inventoryItemId: input.inventoryItemId,
        batchCode: input.batchCode,
        expiresOn: input.expiresOn ?? null,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
      })
      .returning();
    return toBatch(row!);
  });
}

export async function listStockBatches(
  context: ScopedTenantContext,
  actorUserId: string,
  query: {
    limit: number;
    cursor?: string;
    outletId: string;
    locationId?: string;
    inventoryItemId?: string;
    expiresOnOrBefore?: string;
  },
): Promise<CursorPage<StockBatch>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      outletTarget(query.outletId),
    );
    const filters: SQL[] = [eq(stockBatches.outletId, query.outletId)];
    if (query.locationId)
      filters.push(eq(stockBatches.locationId, query.locationId));
    if (query.inventoryItemId)
      filters.push(eq(stockBatches.inventoryItemId, query.inventoryItemId));
    if (query.expiresOnOrBefore)
      filters.push(lte(stockBatches.expiresOn, query.expiresOnOrBefore));
    const [receivedAt, id] = cursorKeys(query.cursor, 2);
    if (receivedAt !== undefined && id !== undefined) {
      const at = new Date(receivedAt);
      if (Number.isNaN(at.getTime()))
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          lte(stockBatches.receivedAt, at),
          and(
            eq(stockBatches.receivedAt, at),
            sql`${stockBatches.id} < ${id}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(stockBatches)
      .where(and(...filters))
      .orderBy(desc(stockBatches.receivedAt), desc(stockBatches.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toBatch),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.receivedAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

// -------------------------------------------------------------- ledger

/**
 * Appends one stock-card row and updates the derived balance. Used by this
 * bead's transfers and by later receipts/sales/production/waste/count beads;
 * those routes own their permission check, while tenant + outlet scope is
 * enforced here. Returns the contract-shaped ledger entry.
 */
export async function recordStockMovement(
  context: ScopedTenantContext,
  input: StockMovementInput,
): Promise<StockLedgerEntry> {
  assertOutlet(context, input.outletId);
  return withTenant(db, context, (tx) =>
    recordStockMovementInTransaction(tx, context, input),
  );
}

export type StockMovementInput = {
  outletId: string;
  locationId: string;
  inventoryItemId: string;
  movementType: StockMovementType;
  /** Signed Decimal4: positive in, negative out (contract direction rules). */
  quantity: Decimal4;
  /** Required for a stock-in; defaults to the location average for an out. */
  unitCostIdr?: Decimal4;
  batchId?: string | null;
  sourceType: StockSourceType;
  sourceId: string;
  occurredAt?: IsoDateTime;
  actor: { type: "user"; id: string } | { type: "system" };
};

export async function recordStockMovementInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  input: StockMovementInput,
): Promise<StockLedgerEntry> {
  assertOutlet(context, input.outletId);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  // The contract schema is the single source of direction/pair/sign rules.
  const candidate = stockLedgerEntrySchema.parse({
    id: createUlid(Date.parse(occurredAt)),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    locationId: input.locationId,
    inventoryItemId: input.inventoryItemId,
    movementType: input.movementType,
    quantity: input.quantity,
    unitCostIdr: input.unitCostIdr ?? decimal4("0.0000"),
    batchId: input.batchId ?? null,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    occurredAt,
  });
  await requireLocation(tx, input.outletId, input.locationId);
  await requireItem(tx, input.inventoryItemId);
  if (candidate.batchId !== null)
    await requireBatch(tx, input.outletId, candidate.batchId, candidate);

  // An outflow without an explicit cost is valued at the location's current
  // moving average (PRD §16 "Metode Biaya"); an inflow must carry its cost.
  let unitCostIdr = input.unitCostIdr;
  if (unitCostIdr === undefined) {
    if (parseDecimal4(candidate.quantity) > 0n)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "A stock-in movement needs its unit cost.",
      );
    const [balance] = await tx
      .select({ avgCostIdr: stockBalances.avgCostIdr })
      .from(stockBalances)
      .where(
        and(
          eq(stockBalances.locationId, candidate.locationId),
          eq(stockBalances.inventoryItemId, candidate.inventoryItemId),
        ),
      );
    unitCostIdr = balance?.avgCostIdr ?? decimal4("0.0000");
  }
  const entry = stockLedgerEntrySchema.parse({
    ...candidate,
    unitCostIdr,
  });

  await tx.insert(stockLedger).values({
    id: entry.id,
    tenantId: context.tenant.tenantId,
    outletId: entry.outletId,
    locationId: entry.locationId,
    inventoryItemId: entry.inventoryItemId,
    movementType: entry.movementType,
    quantity: entry.quantity,
    unitCostIdr: entry.unitCostIdr,
    batchId: entry.batchId,
    sourceType: entry.sourceType,
    sourceId: sourceIdToDb(entry.sourceId),
    occurredAt: new Date(entry.occurredAt),
  });
  await applyMovementToBalance(tx, context, entry);
  await appendStockMovedEvent(tx, context, entry, input.actor);
  return entry;
}

/** Upserts then locks the balance row, so concurrent movements serialise. */
async function applyMovementToBalance(
  tx: Tx,
  context: ScopedTenantContext,
  entry: StockLedgerEntry,
): Promise<void> {
  await tx
    .insert(stockBalances)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: entry.outletId,
      locationId: entry.locationId,
      inventoryItemId: entry.inventoryItemId,
      quantity: decimal4("0.0000"),
      avgCostIdr: decimal4("0.0000"),
      updatedAt: new Date(entry.occurredAt),
    })
    .onConflictDoNothing();
  const [balance] = await tx
    .select()
    .from(stockBalances)
    .where(
      and(
        eq(stockBalances.locationId, entry.locationId),
        eq(stockBalances.inventoryItemId, entry.inventoryItemId),
      ),
    )
    .for("update");
  if (!balance) throw new Error("Stock balance row disappeared");
  const next = applyStockMovement(balance, entry, ROUNDING_MODE);
  await tx
    .update(stockBalances)
    .set({
      quantity: next.quantity,
      avgCostIdr: next.avgCostIdr,
      updatedAt: new Date(entry.occurredAt),
    })
    .where(
      and(
        eq(stockBalances.locationId, entry.locationId),
        eq(stockBalances.inventoryItemId, entry.inventoryItemId),
      ),
    );
}

async function appendStockMovedEvent(
  tx: Tx,
  context: ScopedTenantContext,
  entry: StockLedgerEntry,
  actor: StockMovementInput["actor"],
): Promise<void> {
  const event = inventoryEvents["stock.moved"].envelopeSchema.parse({
    id: createUlid(),
    tenantId: context.tenant.tenantId,
    outletId: entry.outletId,
    name: "stock.moved",
    version: 1,
    aggregateType: "stock",
    // One aggregate per immutable ledger row: sequence 1, no ordering race.
    aggregateId: entry.id,
    sequence: 1,
    occurredAt: entry.occurredAt,
    actor,
    deviceId: null,
    idempotencyKey: `stock.moved:${entry.id}`,
    payloadSchemaRef: "stock.moved.v1",
    payload: {
      ledgerEntryId: entry.id,
      inventoryItemId: entry.inventoryItemId,
      locationId: entry.locationId,
      movementType: entry.movementType,
      quantity: entry.quantity,
      unitCostIdr: entry.unitCostIdr,
      batchId: entry.batchId,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      occurredAt: entry.occurredAt,
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

export async function listStockLedger(
  context: ScopedTenantContext,
  actorUserId: string,
  query: {
    limit: number;
    cursor?: string;
    outletId: string;
    locationId?: string;
    inventoryItemId?: string;
    movementType?: string;
    fromDate?: string;
    toDate?: string;
  },
): Promise<CursorPage<StockLedgerEntry>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      outletTarget(query.outletId),
    );
    const filters: SQL[] = [eq(stockLedger.outletId, query.outletId)];
    if (query.locationId)
      filters.push(eq(stockLedger.locationId, query.locationId));
    if (query.inventoryItemId)
      filters.push(eq(stockLedger.inventoryItemId, query.inventoryItemId));
    if (query.movementType)
      filters.push(
        eq(stockLedger.movementType, query.movementType as StockMovementType),
      );
    if (query.fromDate || query.toDate) {
      // Business dates are outlet-local calendar dates (D-CORE-6).
      const [outlet] = await tx
        .execute<{ timezone: string }>(
          sql`SELECT timezone FROM outlets WHERE id = ${query.outletId}::uuid`,
        )
        .then((result) => result.rows);
      if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
      if (query.fromDate)
        filters.push(
          sql`(${stockLedger.occurredAt} AT TIME ZONE ${outlet.timezone})::date >= ${query.fromDate}::date`,
        );
      if (query.toDate)
        filters.push(
          sql`(${stockLedger.occurredAt} AT TIME ZONE ${outlet.timezone})::date <= ${query.toDate}::date`,
        );
    }
    const [at, id] = cursorKeys(query.cursor, 2);
    if (at !== undefined && id !== undefined) {
      const occurredAt = new Date(at);
      if (Number.isNaN(occurredAt.getTime()))
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      filters.push(
        or(
          sql`${stockLedger.occurredAt} < ${occurredAt.toISOString()}::timestamptz`,
          and(
            eq(stockLedger.occurredAt, occurredAt),
            sql`${stockLedger.id} < ${ulidToUuid(id)}::uuid`,
          ),
        )!,
      );
    }
    const rows = await tx
      .select()
      .from(stockLedger)
      .where(and(...filters))
      .orderBy(desc(stockLedger.occurredAt), desc(stockLedger.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toLedgerEntry),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.occurredAt.toISOString(), last.id])
            : null,
      },
    };
  });
}

// ------------------------------------------------------------ balances

export async function listStockBalances(
  context: ScopedTenantContext,
  actorUserId: string,
  query: {
    limit: number;
    cursor?: string;
    outletId: string;
    locationId?: string;
    inventoryItemId?: string;
  },
): Promise<CursorPage<ReturnType<typeof toBalance>>> {
  assertOutlet(context, query.outletId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.view",
      outletTarget(query.outletId),
    );
    const filters: SQL[] = [eq(stockBalances.outletId, query.outletId)];
    if (query.locationId)
      filters.push(eq(stockBalances.locationId, query.locationId));
    if (query.inventoryItemId)
      filters.push(eq(stockBalances.inventoryItemId, query.inventoryItemId));
    const [locationId, itemId] = cursorKeys(query.cursor, 2);
    if (locationId !== undefined && itemId !== undefined)
      filters.push(
        or(
          gt(stockBalances.locationId, locationId),
          and(
            eq(stockBalances.locationId, locationId),
            gt(stockBalances.inventoryItemId, itemId),
          ),
        )!,
      );
    const rows = await tx
      .select()
      .from(stockBalances)
      .where(and(...filters))
      .orderBy(
        asc(stockBalances.locationId),
        asc(stockBalances.inventoryItemId),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toBalance),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.locationId, last.inventoryItemId])
            : null,
      },
    };
  });
}

/**
 * Recomputes every balance of one outlet from the ledger (INV-01 "saldo
 * diturunkan dari ledger"). The database keeps the materialized rows for
 * reads; this is the repair path and the test oracle. Values come from the
 * shared `foldStockLedger`, never a second implementation.
 */
export async function rebuildStockBalances(
  context: ScopedTenantContext,
  actorUserId: string,
  outletId: string,
): Promise<{ locationsItems: number }> {
  assertOutlet(context, outletId);
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, "inventory.cost.view", {
      type: "tenant",
    });
    const rows = await tx
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.outletId, outletId))
      .orderBy(asc(stockLedger.occurredAt), asc(stockLedger.id));
    const derived = foldStockLedger(rows.map(toLedgerEntry), ROUNDING_MODE);
    await tx.delete(stockBalances).where(eq(stockBalances.outletId, outletId));
    if (derived.length > 0)
      await tx.insert(stockBalances).values(
        derived.map((balance) => ({
          tenantId: context.tenant.tenantId,
          outletId: balance.outletId,
          locationId: balance.locationId,
          inventoryItemId: balance.inventoryItemId,
          quantity: balance.quantity,
          avgCostIdr: balance.avgCostIdr,
          updatedAt: new Date(balance.updatedAt),
        })),
      );
    return { locationsItems: derived.length };
  });
}

// ------------------------------------------------------------- transfers

export type CreateStockTransferInput = {
  outletId: string;
  fromLocationId: string;
  toLocationId: string;
  lines: { inventoryItemId: string; quantity: Decimal4 }[];
  note?: string | null;
  occurredAt?: IsoDateTime;
};

/**
 * Posts one transfer as paired `transfer_out`/`transfer_in` ledger rows at the
 * source location's moving-average cost (PRD §16 "transfer antarlokasi", §6 E).
 * A transfer may not send more than the source location holds: unlike a sale,
 * the movement is explicit and an over-transfer would invent stock at the
 * destination (decision recorded in the bead report; PRD is silent).
 */
export async function recordStockTransfer(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateStockTransferInput,
): Promise<StockTransfer> {
  assertOutlet(context, input.outletId);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const transfer = stockTransferSchema.parse({
    id: createUlid(Date.parse(occurredAt)),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    lines: input.lines,
    movedBy: actorUserId,
    occurredAt,
    note: input.note ?? null,
  });
  return withTenant(db, context, async (tx) => {
    await assertPermission(
      tx,
      context,
      actorUserId,
      "inventory.stock.transfer",
      outletTarget(input.outletId),
    );
    await requireLocation(tx, transfer.outletId, transfer.fromLocationId);
    await requireLocation(tx, transfer.outletId, transfer.toLocationId);
    await tx.insert(stockTransfers).values({
      id: transfer.id,
      tenantId: context.tenant.tenantId,
      outletId: transfer.outletId,
      fromLocationId: transfer.fromLocationId,
      toLocationId: transfer.toLocationId,
      movedBy: actorUserId,
      occurredAt: new Date(transfer.occurredAt),
      note: transfer.note,
    });
    await tx.insert(stockTransferLines).values(
      transfer.lines.map((line) => ({
        tenantId: context.tenant.tenantId,
        outletId: transfer.outletId,
        transferId: transfer.id,
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
      })),
    );
    // Stable order: two concurrent transfers can never lock the same two
    // balance rows in opposite order (deadlock).
    const lines = [...transfer.lines].sort((left, right) =>
      left.inventoryItemId < right.inventoryItemId ? -1 : 1,
    );
    for (const line of lines) {
      const [source] = await tx
        .select()
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.locationId, transfer.fromLocationId),
            eq(stockBalances.inventoryItemId, line.inventoryItemId),
          ),
        )
        .for("update");
      const onHand = source ? parseDecimal4(source.quantity) : 0n;
      if (onHand < parseDecimal4(line.quantity))
        throw new CoreError(
          "CONFLICT",
          "The source location does not hold enough stock for this transfer.",
        );
      const unitCostIdr = source?.avgCostIdr ?? decimal4("0.0000");
      await recordStockMovementInTransaction(tx, context, {
        outletId: transfer.outletId,
        locationId: transfer.fromLocationId,
        inventoryItemId: line.inventoryItemId,
        movementType: "transfer_out",
        quantity: negate(line.quantity),
        unitCostIdr,
        sourceType: "stock_transfer",
        sourceId: transfer.id,
        occurredAt: transfer.occurredAt,
        actor: { type: "user", id: actorUserId },
      });
      await recordStockMovementInTransaction(tx, context, {
        outletId: transfer.outletId,
        locationId: transfer.toLocationId,
        inventoryItemId: line.inventoryItemId,
        movementType: "transfer_in",
        quantity: line.quantity,
        unitCostIdr,
        sourceType: "stock_transfer",
        sourceId: transfer.id,
        occurredAt: transfer.occurredAt,
        actor: { type: "user", id: actorUserId },
      });
    }
    return transfer;
  });
}

// --------------------------------------------------------------- helpers

async function requireLocation(
  tx: Tx,
  outletId: string,
  locationId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.id, locationId),
        eq(stockLocations.outletId, outletId),
      ),
    );
  if (!row) throw new HttpError(404, "NOT_FOUND", "Stock location not found.");
}

async function requireItem(tx: Tx, itemId: string): Promise<void> {
  const [row] = await tx
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(eq(inventoryItems.id, itemId));
  if (!row) throw new HttpError(404, "NOT_FOUND", "Inventory item not found.");
}

async function requireBatch(
  tx: Tx,
  outletId: string,
  batchId: string,
  entry: StockLedgerEntry,
): Promise<void> {
  const [row] = await tx
    .select()
    .from(stockBatches)
    .where(
      and(eq(stockBatches.id, batchId), eq(stockBatches.outletId, outletId)),
    );
  if (!row) throw new HttpError(404, "NOT_FOUND", "Stock batch not found.");
  if (
    row.locationId !== entry.locationId ||
    row.inventoryItemId !== entry.inventoryItemId
  )
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "The batch belongs to another location or item.",
    );
}
