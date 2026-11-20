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

import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import {
  assertOutletInScope,
  createUlid,
  CoreError,
  businessDayRange,
  decimal4,
  decodeCursor,
  encodeCursor,
  extendCostIdr,
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
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { outletBusinessDayClock } from "./outlet-clock";
import type {
  BusinessDate,
  Decimal4,
  IsoDateTime,
  TenantId,
} from "@starter/shared/core";
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
  type StockMovedEventPayload,
  type StockMovementType,
  type StockSourceType,
  type StockTransfer,
  type Uom,
  type UomConversion,
} from "@starter/shared/inventory";
import type { EventEnvelope } from "@starter/shared/events";
import type { z } from "zod";
import type * as schema from "../db/schema";
import {
  inventoryItems,
  orders,
  productionOrders,
  stockBalances,
  stockBatches,
  stockLedger,
  stockLocations,
  stockTransferLines,
  stockTransfers,
  stockCountLines,
  stockCounts,
  uomConversions,
  uoms,
  wasteLogs,
} from "../db/schema";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { blindCountHiddenFilter } from "./inventory-count.visibility";
import { appendOutbox } from "./core-outbox";
import { enqueueHppRecompute } from "./hpp-recompute.service";
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

/** Access snapshot inside the tenant transaction (permission + outlet scope). */
async function loadAccessSnapshot(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
) {
  const data = await loadTenantAccessInTransaction(tx, context, actorUserId);
  return resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actorUserId,
    ...data,
    mfaVerified: false,
    now: new Date(),
  });
}

/** Server-side permission check, independent of the route middleware. */
async function assertPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  target: AccessTarget,
): Promise<void> {
  const snapshot = await loadAccessSnapshot(tx, context, actorUserId);
  if (!snapshot.allows(permission, target))
    throw new AccessError("PERMISSION_DENIED");
}

/**
 * Catalog read (items, UOMs; legend-1ozj): a tenant-wide `inventory.stock.view`
 * OR the permission on at least one outlet the caller reaches. The catalog is
 * tenant master data with no outlet column, so an outlet-scoped role (warehouse,
 * outlet manager) reads it without widening what it may write or see per outlet.
 */
async function assertCatalogRead(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<void> {
  const snapshot = await loadAccessSnapshot(tx, context, actorUserId);
  if (snapshot.allows("inventory.stock.view", { type: "tenant" })) return;
  const scope = context.outletScope;
  if (
    scope.kind === "outlets" &&
    scope.outletIds.some((id) =>
      snapshot.allows("inventory.stock.view", outletTarget(id)),
    )
  )
    return;
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

export function sourceIdFromDb(type: StockSourceType, value: string): string {
  return ULID_SOURCE_TYPES.has(type) ? uuidToUlid(value) : value;
}

export function sourceIdToDb(value: string): string {
  return ulidSchema.safeParse(value).success ? ulidToUuid(value) : value;
}

function negate(quantity: Decimal4): Decimal4 {
  return formatDecimal4(-parseDecimal4(quantity));
}

/**
 * Advisory-lock key for one tenant+location balance family. Movements and the
 * balance rebuild take the same key, so a rebuild cannot fold a ledger while a
 * movement for that location is in flight (pre-review :1102).
 */
export function inventoryLocationLockKey(
  tenantId: string,
  locationId: string,
): string {
  return `inventory:balance:${tenantId}:${locationId}`;
}

/**
 * Takes the per-location transaction locks in ascending key order. Sorting is
 * what stops two opposing transfers from holding the same two locations in
 * opposite order (pre-review :1190); advisory locks are re-entrant, so nested
 * movement calls on an already locked location do not block themselves.
 */
async function lockInventoryLocations(
  tx: Tx,
  tenantId: string,
  locationIds: readonly string[],
): Promise<void> {
  for (const locationId of [...new Set(locationIds)].sort())
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${inventoryLocationLockKey(tenantId, locationId)}, 0))`,
    );
}

/**
 * Transaction lock on one stock source document (bead legend-ddoy). Two
 * outlets posting the same (tenant, source_type, source_id) hold different
 * location locks, so nothing else serialises them and each would pass the
 * other-outlet check on committed rows only. The second poster blocks here
 * until the first commits, then reads its rows and is refused.
 *
 * Order is source lock first, then location locks. That removes the cycle of
 * one document posted over two locations in one batch (primary and standby of
 * one outlet): both take the same source lock before any location. It does
 * not remove every deadlock: db-link-store applies a batch in one
 * transaction, so a batch that already holds locks from earlier events (a
 * source or a location) can wait on another batch that waits on it.
 * PostgreSQL aborts one of them (40P01), which is not a domain refusal, so
 * that batch rolls back and is resent, and the retry is applied, replayed,
 * or refused with 409.
 */
async function lockStockSource(
  tx: Tx,
  tenantId: string,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  const key =
    `stock-source:${tenantId}:${sourceType}:${sourceIdToDb(sourceId)}`.toLowerCase();
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
  );
}

// ------------------------------------------------------------------ mappers

type ItemRow = typeof inventoryItems.$inferSelect;
type UomRow = typeof uoms.$inferSelect;
type ConversionRow = typeof uomConversions.$inferSelect;
type LocationRow = typeof stockLocations.$inferSelect;
type LedgerRow = typeof stockLedger.$inferSelect;
type BalanceRow = typeof stockBalances.$inferSelect;
type BatchRow = typeof stockBatches.$inferSelect;
type TransferRow = typeof stockTransfers.$inferSelect;
type TransferLineRow = typeof stockTransferLines.$inferSelect;

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
    isSystem: row.isSystem,
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

function toLedgerEntry(row: LedgerRow, withCost = true): StockLedgerEntry {
  return stockLedgerEntrySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    locationId: row.locationId,
    inventoryItemId: row.inventoryItemId,
    movementType: row.movementType,
    quantity: row.quantity,
    // Unit costs are financial data: callers without `inventory.cost.view`
    // get the stock card with the cost masked (pre-review :962).
    unitCostIdr: withCost ? row.unitCostIdr : decimal4("0.0000"),
    batchId: row.batchId,
    sourceType: row.sourceType,
    sourceId: sourceIdFromDb(row.sourceType, row.sourceId),
    occurredAt: row.occurredAt.toISOString(),
  });
}

function toBalance(row: BalanceRow, withCost = true) {
  return stockBalanceSchema.parse({
    tenantId: row.tenantId,
    outletId: row.outletId,
    locationId: row.locationId,
    inventoryItemId: row.inventoryItemId,
    quantity: row.quantity,
    avgCostIdr: withCost ? row.avgCostIdr : decimal4("0.0000"),
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

function toTransfer(
  row: TransferRow,
  lines: readonly TransferLineRow[],
): StockTransfer {
  return stockTransferSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    fromLocationId: row.fromLocationId,
    toLocationId: row.toLocationId,
    lines: lines.map((line) => ({
      inventoryItemId: line.inventoryItemId,
      quantity: line.quantity,
    })),
    movedBy: row.movedBy,
    occurredAt: row.occurredAt.toISOString(),
    note: row.note,
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
    await assertCatalogRead(tx, context, actorUserId);
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
    await assertCatalogRead(tx, context, actorUserId);
    const [row] = await tx
      .select()
      .from(inventoryItems)
      .where(eq(inventoryItems.id, itemId));
    if (!row)
      throw new HttpError(404, "NOT_FOUND", "Inventory item not found.");
    return toItem(row);
  });
}

/** Item master write: needs the tenant-wide `inventory.item.manage` code. */
export async function createInventoryItem(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateInventoryItemInput,
): Promise<InventoryItem> {
  return withTenant(db, context, async (tx) => {
    await assertPermission(tx, context, actorUserId, "inventory.item.manage", {
      type: "tenant",
    });
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
    await assertPermission(tx, context, actorUserId, "inventory.item.manage", {
      type: "tenant",
    });
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
    await assertCatalogRead(tx, context, actorUserId);
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
    await assertCatalogRead(tx, context, actorUserId);
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
    const snapshot = await loadAccessSnapshot(tx, context, actorUserId);
    const target = outletTarget(query.outletId);
    if (!snapshot.allows("inventory.stock.view", target))
      throw new AccessError("PERMISSION_DENIED");
    // Open blind counts hide their pairs from everyone (stock opname T1).
    const filters: SQL[] = [
      eq(stockBatches.outletId, query.outletId),
      blindCountHiddenFilter(stockBatches),
    ];
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
      // Strict keyset on the descending primary key: `receivedAt <= cursor`
      // would return the cursor row again and repeat a page (pre-review :714).
      filters.push(
        or(
          lt(stockBatches.receivedAt, at),
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
  /**
   * Retry guard (pre-review :779). Repeating the same key with the same
   * request returns the first posting; a different request fails
   * IDEMPOTENCY_KEY_REUSED. Callers that retry a document should pass a key.
   */
  idempotencyKey?: string;
  actor: { type: "user"; id: string } | { type: "system" };
};

/**
 * Fingerprint of the request as the caller sent it, not of resolved defaults,
 * so an outflow that omits `unitCostIdr` stays replayable after the average
 * moved. Values are canonicalised at Decimal4 precision.
 */
function movementFingerprint(input: StockMovementInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.outletId,
        input.locationId,
        input.inventoryItemId,
        input.movementType,
        formatDecimal4(parseDecimal4(input.quantity)),
        input.unitCostIdr === undefined
          ? null
          : formatDecimal4(parseDecimal4(input.unitCostIdr)),
        input.batchId ?? null,
        input.sourceType,
        sourceIdToDb(input.sourceId),
        input.occurredAt ?? null,
      ]),
    )
    .digest("hex");
}

async function findMovementByKey(
  tx: Tx,
  tenantId: TenantId,
  idempotencyKey: string,
): Promise<LedgerRow | null> {
  const [row] = await tx
    .select()
    .from(stockLedger)
    .where(
      and(
        eq(stockLedger.tenantId, tenantId),
        eq(stockLedger.idempotencyKey, idempotencyKey),
      ),
    );
  return row ?? null;
}

/** Same key + same request returns the first posting; a different one is a 409. */
function replayMovement(row: LedgerRow, fingerprint: string): StockLedgerEntry {
  if (row.requestFingerprint !== fingerprint)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was used for a different stock posting.",
    );
  return toLedgerEntry(row);
}

export async function recordStockMovementInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  input: StockMovementInput,
): Promise<StockLedgerEntry> {
  assertOutlet(context, input.outletId);
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const fingerprint =
    input.idempotencyKey === undefined ? null : movementFingerprint(input);
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

  if (input.idempotencyKey !== undefined) {
    const replayed = await findMovementByKey(
      tx,
      context.tenant.tenantId,
      input.idempotencyKey,
    );
    if (replayed) return replayMovement(replayed, fingerprint!);
  }

  // Lock before reading: the advisory lock serialises the balance rebuild
  // (pre-review :1102) and the row lock makes the fallback moving-average
  // cost race-free, because it is read from the locked row (pre-review :816).
  await lockInventoryLocations(tx, context.tenant.tenantId, [
    candidate.locationId,
  ]);
  const balance = await lockStockBalance(tx, context, candidate);

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
    unitCostIdr = balance.avgCostIdr;
  }
  const entry = stockLedgerEntrySchema.parse({
    ...candidate,
    unitCostIdr,
  });

  const inserted = await tx
    .insert(stockLedger)
    .values({
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
      idempotencyKey: input.idempotencyKey ?? null,
      requestFingerprint: fingerprint,
      occurredAt: new Date(entry.occurredAt),
    })
    .onConflictDoNothing({
      target: [stockLedger.tenantId, stockLedger.idempotencyKey],
    })
    .returning();
  if (inserted.length === 0) {
    // A concurrent retry won the key while this transaction waited on the
    // unique index; replay its committed row instead of posting twice.
    if (input.idempotencyKey === undefined)
      throw new Error("Stock ledger insert returned no row");
    const replayed = await findMovementByKey(
      tx,
      context.tenant.tenantId,
      input.idempotencyKey,
    );
    if (!replayed) throw new Error("Idempotent stock posting disappeared");
    return replayMovement(replayed, fingerprint!);
  }
  await applyMovementToLockedBalance(tx, balance, entry);
  await appendStockMovedEvent(tx, context, entry, input.actor);
  await absorbIntoPostedCount(tx, context, entry, input.actor);
  return entry;
}

/**
 * SO 1208 P1: a posted stock count is the physical truth at each line's
 * `counted_at`. A POS sale or sales return posted after that count with `occurred_at <=
 * counted_at` (close_of_day deduction, lagging outbox, late edge order,
 * repost) is already inside the counted quantity, so it would count twice.
 * The first such count absorbs it: an opposite `adjustment` on that count
 * (dated at its `counted_at`, same batch; an inflow back at the movement's own
 * cost), so the stock equals the count again and the GL moves the value from
 * the count variance to the movement (e.g. susut -> HPP). Counts not yet
 * posted need nothing here: their posting recomputes the system quantity from
 * the ledger at `counted_at` (inventory-count.service.ts).
 */
async function absorbIntoPostedCount(
  tx: Tx,
  context: ScopedTenantContext,
  entry: StockLedgerEntry,
  actor: StockMovementInput["actor"],
): Promise<void> {
  // Only POS sales and sales returns arrive late with their own date (CTO,
  // 1211 review). A receipt, transfer or manual movement dated before a count
  // is a correction someone made on purpose: never cancelled silently.
  if (
    entry.sourceType !== "order" ||
    (entry.movementType !== "sale" && entry.movementType !== "return")
  )
    return;
  const [anchor] = await tx
    .select({
      countId: stockCounts.id,
      lineId: stockCountLines.id,
      countedAt: stockCountLines.countedAt,
    })
    .from(stockCountLines)
    .innerJoin(
      stockCounts,
      and(
        eq(stockCounts.tenantId, stockCountLines.tenantId),
        eq(stockCounts.id, stockCountLines.stockCountId),
      ),
    )
    .where(
      and(
        eq(stockCountLines.tenantId, context.tenant.tenantId),
        eq(stockCounts.locationId, entry.locationId),
        eq(stockCountLines.inventoryItemId, entry.inventoryItemId),
        eq(stockCounts.status, "posted"),
        gte(stockCountLines.countedAt, new Date(entry.occurredAt)),
      ),
    )
    .orderBy(asc(stockCountLines.countedAt), asc(stockCountLines.id))
    .limit(1);
  if (!anchor?.countedAt) return;
  const quantity = -parseDecimal4(entry.quantity);
  const offset = await recordStockMovementInTransaction(tx, context, {
    outletId: entry.outletId,
    locationId: entry.locationId,
    inventoryItemId: entry.inventoryItemId,
    movementType: "adjustment",
    quantity: formatDecimal4(quantity),
    // An outflow leaves the cost to the moving average, as a count decrease.
    ...(quantity > 0n ? { unitCostIdr: entry.unitCostIdr } : {}),
    batchId: entry.batchId,
    sourceType: "stock_count",
    sourceId: anchor.countId,
    occurredAt: anchor.countedAt.toISOString() as IsoDateTime,
    idempotencyKey: `stock-count-late:${entry.id}`,
    actor,
  });
  await tx
    .update(stockCountLines)
    .set({
      postedValueIdr: sql`COALESCE(${stockCountLines.postedValueIdr}, 0) + ${extendCostIdr(offset.quantity, offset.unitCostIdr, ROUNDING_MODE)}`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(stockCountLines.tenantId, context.tenant.tenantId),
        eq(stockCountLines.id, anchor.lineId),
      ),
    );
}

/** Ensures the balance row exists, then locks it; the caller holds the advisory lock. */
async function lockStockBalance(
  tx: Tx,
  context: ScopedTenantContext,
  entry: StockLedgerEntry,
): Promise<BalanceRow> {
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
  return balance;
}

/** Applies one movement to the already locked balance row. */
async function applyMovementToLockedBalance(
  tx: Tx,
  balance: BalanceRow,
  entry: StockLedgerEntry,
): Promise<void> {
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
        eq(stockBalances.locationId, balance.locationId),
        eq(stockBalances.inventoryItemId, balance.inventoryItemId),
      ),
    );
  // HPP menu costs follow the average cost (legend-2qq): queue the item in
  // this same transaction, only when the average really moved. Receipts post
  // through here too, so one hook covers every stock-in.
  if (next.avgCostIdr !== balance.avgCostIdr)
    await enqueueHppRecompute(tx, {
      tenantId: balance.tenantId,
      outletId: balance.outletId,
      itemIds: [balance.inventoryItemId],
    });
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

/**
 * Stock sources an edge node may post (bead legend-s4r6): the outlet flows the
 * edge runs, all single-outlet: POS / QR sales and sales returns (`order`),
 * waste logs, stock counts, transfers between locations of one outlet and
 * production batches. Purchasing (`goods_receipt`, `purchase_return`) and
 * `duty_meal` have no edge-side producer, so the cloud refuses them.
 */
export const EDGE_STOCK_SOURCE_TYPES: ReadonlySet<StockSourceType> = new Set([
  "order",
  "waste_log",
  "stock_count",
  "stock_transfer",
  "production_order",
]);

/** The columns of a source document's own table that the owner check reads. */
interface SourceDocumentTable {
  table: PgTable;
  tenantId: AnyPgColumn;
  id: AnyPgColumn;
  outletId: AnyPgColumn;
}

function sourceDocumentOf(
  table: PgTable & {
    tenantId: AnyPgColumn;
    id: AnyPgColumn;
    outletId: AnyPgColumn;
  },
): SourceDocumentTable {
  return {
    table,
    tenantId: table.tenantId,
    id: table.id,
    outletId: table.outletId,
  };
}

/**
 * Own table of each source document an edge posts (EDGE_STOCK_SOURCE_TYPES).
 * Typed columns, so a table without `outlet_id` fails tsc instead of throwing
 * at runtime (a throw would be a 503 and the edge batch would retry forever).
 * `stock_transfers` has one `outlet_id`: both its locations are FK-bound to
 * that same outlet (stock_transfers_from/to_location_fk), so there is no
 * separate sending or receiving outlet to choose between.
 */
const EDGE_SOURCE_DOCUMENT_TABLES: Readonly<
  Record<string, SourceDocumentTable>
> = {
  order: sourceDocumentOf(orders),
  waste_log: sourceDocumentOf(wasteLogs),
  stock_count: sourceDocumentOf(stockCounts),
  stock_transfer: sourceDocumentOf(stockTransfers),
  production_order: sourceDocumentOf(productionOrders),
};

/** Any hex 8-4-4-4-12 value; ULID-derived ids are not RFC-versioned uuids. */
const DB_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the source document already belongs to another outlet: either
 * another outlet holds ledger rows of it, or the cloud holds the document
 * itself (bead legend-ddoy) under another outlet, so the check does not
 * depend on a ledger row being posted first. A document the cloud does not
 * hold passes: an edge document never reaches the cloud before its stock does.
 * The node's own context only sees its outlet (outlet RLS), so this reads
 * through a tenant-wide trusted job context in its own short transaction,
 * like the worker jobs. It sees committed rows only, so callers must hold the
 * `lockStockSource` claim first: the claim lasts until the caller's commit,
 * which makes a concurrent posting of the same document by another outlet
 * wait and then see that outlet's committed rows here.
 */
async function sourceBelongsToOtherOutlet(
  entry: StockLedgerEntry,
): Promise<boolean> {
  const tenantWide = establishScopedTenantContext(
    establishTenantContext({
      tenantId: entry.tenantId,
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );
  return withTenant(db, tenantWide, async (tx) => {
    const rows = await tx
      .select({ id: stockLedger.id })
      .from(stockLedger)
      .where(
        and(
          eq(stockLedger.tenantId, entry.tenantId),
          eq(stockLedger.sourceType, entry.sourceType),
          eq(stockLedger.sourceId, sourceIdToDb(entry.sourceId)),
          ne(stockLedger.outletId, entry.outletId),
        ),
      )
      .limit(1);
    if (rows.length > 0) return true;
    const document = EDGE_SOURCE_DOCUMENT_TABLES[entry.sourceType];
    const documentId = sourceIdToDb(entry.sourceId);
    // A malformed id would make the `::uuid` cast throw; it cannot name a
    // cloud document, so there is nothing to compare.
    if (!document || !DB_UUID_PATTERN.test(documentId)) return false;
    const documents = await tx
      .select({ outletId: document.outletId })
      .from(document.table)
      .where(
        and(
          eq(document.tenantId, entry.tenantId),
          // Raw compare: the ULID-in-uuid columns would re-encode a uuid.
          sql`${document.id} = ${documentId}::uuid`,
          ne(document.outletId, entry.outletId),
        ),
      )
      .limit(1);
    return documents.length > 0;
  });
}

/** True when the stored ledger row is exactly the replicated movement. */
function sameReplicatedMovement(
  row: LedgerRow,
  entry: StockLedgerEntry,
): boolean {
  const stored = toLedgerEntry(row);
  const id = (value: string | null) => value?.toLowerCase() ?? null;
  return (
    id(stored.outletId) === id(entry.outletId) &&
    id(stored.locationId) === id(entry.locationId) &&
    id(stored.inventoryItemId) === id(entry.inventoryItemId) &&
    stored.movementType === entry.movementType &&
    parseDecimal4(stored.quantity) === parseDecimal4(entry.quantity) &&
    parseDecimal4(stored.unitCostIdr) === parseDecimal4(entry.unitCostIdr) &&
    id(stored.batchId) === id(entry.batchId) &&
    stored.sourceType === entry.sourceType &&
    id(row.sourceId) === id(sourceIdToDb(entry.sourceId)) &&
    Date.parse(stored.occurredAt) === Date.parse(entry.occurredAt)
  );
}

/**
 * Cloud side of an edge `stock.moved` (bead legend-s4r6, edge/stock-moved-
 * applier.ts): writes the edge's ledger row with its own id, quantity, cost,
 * source and time (the cost is never recomputed), applies it to the cloud
 * balance like the local path and re-emits the same `stock.moved` on the
 * cloud outbox so the GL bridge consumes it. `cloud-sync` is a local sink on
 * the cloud (worker/transport.ts), so the event never goes back to the edge.
 * Returns false and writes nothing when the identical row is already there
 * (replay); a different movement under the same id throws.
 */
export async function recordReplicatedStockMovementInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  event: EventEnvelope,
  payload: StockMovedEventPayload,
): Promise<boolean> {
  if (!event.outletId)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Stock event needs an outlet.",
    );
  assertOutlet(context, event.outletId);
  if (!EDGE_STOCK_SOURCE_TYPES.has(payload.sourceType))
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "An edge node cannot post this stock source.",
    );
  const tenantId = context.tenant.tenantId;
  const parsed = stockLedgerEntrySchema.safeParse({
    id: payload.ledgerEntryId,
    tenantId,
    outletId: event.outletId,
    locationId: payload.locationId,
    inventoryItemId: payload.inventoryItemId,
    movementType: payload.movementType,
    quantity: payload.quantity,
    unitCostIdr: payload.unitCostIdr,
    batchId: payload.batchId,
    sourceType: payload.sourceType,
    sourceId: payload.sourceId,
    occurredAt: payload.occurredAt,
  });
  // A 4xx, not a ZodError: the link records a reviewable conflict instead of
  // stalling the node's sync (db-link-store.ts applyOrRefuse).
  if (!parsed.success)
    throw new HttpError(422, "VALIDATION_ERROR", "Invalid stock movement.");
  const entry = parsed.data;
  await requireLocation(tx, entry.outletId, entry.locationId);
  await requireItem(tx, entry.inventoryItemId);
  if (entry.batchId !== null)
    await requireBatch(tx, entry.outletId, entry.batchId, entry);

  // legend-ddoy: claim the source first, then the location, and only then the
  // cross-outlet read below (lock order is explained on lockStockSource).
  await lockStockSource(tx, tenantId, entry.sourceType, entry.sourceId);
  await lockInventoryLocations(tx, tenantId, [entry.locationId]);
  // The GL bridge re-reads a document's rows by (tenant, sourceType,
  // sourceId) across outlets: a source already posted by another outlet is
  // never extended from this edge.
  if (await sourceBelongsToOtherOutlet(entry))
    throw new HttpError(
      409,
      "CONFLICT",
      "This stock source belongs to another outlet.",
    );
  const inserted = await tx
    .insert(stockLedger)
    .values({
      id: entry.id,
      tenantId,
      outletId: entry.outletId,
      locationId: entry.locationId,
      inventoryItemId: entry.inventoryItemId,
      movementType: entry.movementType,
      quantity: entry.quantity,
      unitCostIdr: entry.unitCostIdr,
      batchId: entry.batchId,
      sourceType: entry.sourceType,
      sourceId: sourceIdToDb(entry.sourceId),
      idempotencyKey: null,
      requestFingerprint: null,
      occurredAt: new Date(entry.occurredAt),
    })
    .onConflictDoNothing({ target: stockLedger.id })
    .returning({ id: stockLedger.id });
  if (inserted.length === 0) {
    // Only an identical row is a replay. A row of another tenant (invisible
    // here) or a different movement under the same id is refused, so the
    // receipt fails and the edge keeps the event instead of losing it.
    const [existing] = await tx
      .select()
      .from(stockLedger)
      .where(
        and(eq(stockLedger.tenantId, tenantId), eq(stockLedger.id, entry.id)),
      );
    if (!existing || !sameReplicatedMovement(existing, entry))
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This stock ledger id was used for a different movement.",
      );
    return false;
  }

  const balance = await lockStockBalance(tx, context, entry);
  await applyMovementToLockedBalance(tx, balance, entry);
  const cloudEvent = inventoryEvents["stock.moved"].envelopeSchema.parse({
    ...event,
    idempotencyKey: `stock.moved:${entry.id}`,
  });
  await appendOutbox(tx, context, {
    id: createUlid(),
    event: cloudEvent,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
  // An edge sale that lands after a count posted on the cloud. Edge counts
  // never reach the cloud's stock_counts (only their ledger rows replicate),
  // so the only counts found here are cloud counts: no double offset with the
  // edge's own absorption.
  await absorbIntoPostedCount(tx, context, entry, { type: "system" });
  return true;
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
    // The stock card is operational data, but unit costs are financial data:
    // callers without `inventory.cost.view` see the movements with costs
    // masked instead of being denied the whole card (pre-review :962).
    const snapshot = await loadAccessSnapshot(tx, context, actorUserId);
    const target = outletTarget(query.outletId);
    if (!snapshot.allows("inventory.stock.view", target))
      throw new AccessError("PERMISSION_DENIED");
    const withCost = snapshot.allows("inventory.cost.view", target);
    // Open blind counts hide their pairs from everyone (stock opname T1).
    const filters: SQL[] = [
      eq(stockLedger.outletId, query.outletId),
      blindCountHiddenFilter(stockLedger),
    ];
    if (query.locationId)
      filters.push(eq(stockLedger.locationId, query.locationId));
    if (query.inventoryItemId)
      filters.push(eq(stockLedger.inventoryItemId, query.inventoryItemId));
    if (query.movementType)
      filters.push(
        eq(stockLedger.movementType, query.movementType as StockMovementType),
      );
    if (query.fromDate || query.toDate) {
      // Business dates follow the outlet clock (D-CORE-6, owner Q39 cutoff):
      // a day is [cutoff, next cutoff) in the outlet time zone.
      const [outlet] = await tx
        .execute<{ timezone: string; business_day_cutoff: string }>(
          sql`SELECT timezone, business_day_cutoff FROM outlets WHERE id = ${query.outletId}::uuid`,
        )
        .then((result) => result.rows);
      if (!outlet) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
      const clock = outletBusinessDayClock({
        timezone: outlet.timezone,
        businessDayCutoff: outlet.business_day_cutoff,
      });
      if (query.fromDate)
        filters.push(
          sql`${stockLedger.occurredAt} >= ${businessDayRange(query.fromDate, clock).start.toISOString()}::timestamptz`,
        );
      if (query.toDate)
        filters.push(
          sql`${stockLedger.occurredAt} < ${businessDayRange(query.toDate, clock).end.toISOString()}::timestamptz`,
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
      data: page.map((row) => toLedgerEntry(row, withCost)),
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
    // Average costs follow the same financial gate as ledger unit costs
    // (pre-review :962): mask them for callers without `inventory.cost.view`.
    const snapshot = await loadAccessSnapshot(tx, context, actorUserId);
    const target = outletTarget(query.outletId);
    if (!snapshot.allows("inventory.stock.view", target))
      throw new AccessError("PERMISSION_DENIED");
    const withCost = snapshot.allows("inventory.cost.view", target);
    // Open blind counts hide their pairs from everyone (stock opname T1).
    const filters: SQL[] = [
      eq(stockBalances.outletId, query.outletId),
      blindCountHiddenFilter(stockBalances),
    ];
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
      data: page.map((row) => toBalance(row, withCost)),
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
    // Hold every location lock of the outlet before folding. A movement for one
    // of these locations has either committed before this snapshot or waits
    // for the rebuild; it can never slip between the fold and the delete/insert
    // of the derived rows (pre-review :1102).
    const locations = await tx
      .select({ id: stockLocations.id })
      .from(stockLocations)
      .where(eq(stockLocations.outletId, outletId));
    await lockInventoryLocations(
      tx,
      context.tenant.tenantId,
      locations.map((location) => location.id),
    );
    const rows = await tx
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.outletId, outletId))
      // Posting order, not occurredAt: live posting applies the moving
      // average in insertion order (legend-bsw9), so the repair must too.
      .orderBy(asc(stockLedger.postingSeq));
    const derived = foldStockLedger(
      rows.map((row) => ({
        ...toLedgerEntry(row),
        postingSeq: row.postingSeq,
      })),
      ROUNDING_MODE,
      "posting",
    );
    const previousAvg = new Map(
      (
        await tx
          .select({
            locationId: stockBalances.locationId,
            inventoryItemId: stockBalances.inventoryItemId,
            avgCostIdr: stockBalances.avgCostIdr,
          })
          .from(stockBalances)
          .where(eq(stockBalances.outletId, outletId))
      ).map((row) => [
        `${row.locationId}:${row.inventoryItemId}`,
        row.avgCostIdr,
      ]),
    );
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
    // The repair can move average costs (legend-2qq): queue every item whose
    // average differs from the row it replaced, or that had no row.
    const changedItems = new Set<string>();
    for (const balance of derived)
      if (
        previousAvg.get(`${balance.locationId}:${balance.inventoryItemId}`) !==
        balance.avgCostIdr
      )
        changedItems.add(balance.inventoryItemId);
    const derivedKeys = new Set(
      derived.map(
        (balance) => `${balance.locationId}:${balance.inventoryItemId}`,
      ),
    );
    for (const key of previousAvg.keys())
      if (!derivedKeys.has(key)) changedItems.add(key.split(":")[1]!);
    await enqueueHppRecompute(tx, {
      tenantId: context.tenant.tenantId,
      outletId,
      itemIds: [...changedItems],
    });
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
  /** Retry guard: the same key replays the first document (pre-review :779). */
  idempotencyKey?: string;
};

/** Canonical line set for idempotency comparisons (order- and scale-free). */
function canonicalTransferLines(
  lines: readonly { inventoryItemId: string; quantity: Decimal4 }[],
): string {
  return JSON.stringify(
    [...lines]
      .map(
        (line) =>
          [
            line.inventoryItemId,
            formatDecimal4(parseDecimal4(line.quantity)),
          ] as const,
      )
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/** Same key + same request returns the stored document; a different one is a 409. */
function replayTransfer(
  row: TransferRow,
  lines: readonly TransferLineRow[],
  requested: StockTransfer,
  requestedOccurredAt: boolean,
): StockTransfer {
  const transfer = toTransfer(row, lines);
  const same =
    transfer.outletId === requested.outletId &&
    transfer.fromLocationId === requested.fromLocationId &&
    transfer.toLocationId === requested.toLocationId &&
    transfer.movedBy === requested.movedBy &&
    transfer.note === requested.note &&
    (!requestedOccurredAt || transfer.occurredAt === requested.occurredAt) &&
    canonicalTransferLines(transfer.lines) ===
      canonicalTransferLines(requested.lines);
  if (!same)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was used for a different stock transfer.",
    );
  return transfer;
}

async function findTransferByKey(
  tx: Tx,
  tenantId: TenantId,
  idempotencyKey: string,
): Promise<{ row: TransferRow; lines: TransferLineRow[] } | null> {
  const [row] = await tx
    .select()
    .from(stockTransfers)
    .where(
      and(
        eq(stockTransfers.tenantId, tenantId),
        eq(stockTransfers.idempotencyKey, idempotencyKey),
      ),
    );
  if (!row) return null;
  const lines = await tx
    .select()
    .from(stockTransferLines)
    .where(eq(stockTransferLines.transferId, row.id));
  return { row, lines };
}

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
  const requestedOccurredAt = input.occurredAt !== undefined;
  if (
    input.idempotencyKey !== undefined &&
    !/^[A-Za-z0-9._:-]{8,100}$/.test(input.idempotencyKey)
  )
    throw new HttpError(422, "VALIDATION_ERROR", "Check the idempotency key.");
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
    if (input.idempotencyKey !== undefined) {
      const existing = await findTransferByKey(
        tx,
        context.tenant.tenantId,
        input.idempotencyKey,
      );
      if (existing)
        return replayTransfer(
          existing.row,
          existing.lines,
          transfer,
          requestedOccurredAt,
        );
    }
    // Fixed lock order across both locations before reading either balance:
    // two opposing transfers can no longer deadlock (pre-review :1190), and a
    // concurrent rebuild waits for the transfer (pre-review :1102).
    await lockInventoryLocations(tx, context.tenant.tenantId, [
      transfer.fromLocationId,
      transfer.toLocationId,
    ]);
    const inserted = await tx
      .insert(stockTransfers)
      .values({
        id: transfer.id,
        tenantId: context.tenant.tenantId,
        outletId: transfer.outletId,
        fromLocationId: transfer.fromLocationId,
        toLocationId: transfer.toLocationId,
        movedBy: actorUserId,
        idempotencyKey: input.idempotencyKey ?? null,
        occurredAt: new Date(transfer.occurredAt),
        note: transfer.note,
      })
      .onConflictDoNothing({
        target: [stockTransfers.tenantId, stockTransfers.idempotencyKey],
      })
      .returning();
    if (inserted.length === 0) {
      // A concurrent retry stored the same key while this transaction waited;
      // replay it instead of posting the stock twice (pre-review :779).
      if (input.idempotencyKey === undefined)
        throw new Error("Stock transfer insert returned no row");
      const existing = await findTransferByKey(
        tx,
        context.tenant.tenantId,
        input.idempotencyKey,
      );
      if (!existing) throw new Error("Idempotent stock transfer disappeared");
      return replayTransfer(
        existing.row,
        existing.lines,
        transfer,
        requestedOccurredAt,
      );
    }
    await tx.insert(stockTransferLines).values(
      transfer.lines.map((line) => ({
        tenantId: context.tenant.tenantId,
        outletId: transfer.outletId,
        transferId: transfer.id,
        inventoryItemId: line.inventoryItemId,
        quantity: line.quantity,
      })),
    );
    // Stable line order plus the location locks taken above keeps concurrent
    // transfers from taking the same rows in opposite order.
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
        idempotencyKey:
          input.idempotencyKey === undefined
            ? undefined
            : `${input.idempotencyKey}:${line.inventoryItemId}:out`,
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
        idempotencyKey:
          input.idempotencyKey === undefined
            ? undefined
            : `${input.idempotencyKey}:${line.inventoryItemId}:in`,
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
