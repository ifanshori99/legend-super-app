// Inventory setup writes (PRD v1.7 §16 "Lokasi Stok", "Item Bahan & Satuan",
// "Par Level & Saran Pembelian"; bead legend-gjmk): stock locations, item
// alternates, UOM conversions and per-location par levels.
//
// Rules that live here, not in the routes:
// - Every query runs inside `withTenant`, so Postgres RLS scopes rows to the
//   tenant from the server-minted context (TEN-02). Outlet-owned writes check
//   the caller's outlet scope again (`assertOutletInScope`, TEN-03) and the
//   permission against the concrete outlet, independent of the route middleware.
// - Creates take an idempotency key bound to a fingerprint of the request: the
//   same key + same request replays the first resource, a different request
//   under the key is IDEMPOTENCY_KEY_REUSED (409). The key store is
//   `inventory_setup_idempotency` because locations and conversions live in
//   `inventory.ts`.
// - Location, UOM conversion, alternate and par level changes are audited
//   (`recordAudit`). The shared event catalog defines no setup events, so
//   nothing is written to the outbox.
// - Permission codes: the catalog has no `inventory.setup.manage`, so master
//   data writes reuse `inventory.stock.receive` (the same decision as the item
//   master in inventory.service.ts). Decision recorded in the bead report.

import { createHash } from "node:crypto";
import { and, asc, eq, gt, ne, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  formatDecimal4,
  parseDecimal4,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  AccessError,
  type AccessTarget,
  type PermissionCode,
} from "@starter/shared/access";
import { maskAuditChanges } from "@starter/shared/audit";
import {
  createInventoryItemAlternateInputSchema,
  createParLevelInputSchema,
  createStockLocationInputSchema,
  createUomConversionInputSchema,
  inventoryItemAlternateSchema,
  parLevelSchema,
  stockLocationSchema,
  uomConversionSchema,
  updateParLevelInputSchema,
  updateStockLocationInputSchema,
  type InventoryItemAlternate,
  type ParLevel,
  type StockLocation,
  type UomConversion,
} from "@starter/shared/inventory";
import type { z } from "zod";
import type * as schema from "../db/schema";
import {
  inventoryItems,
  stockBalances,
  stockLocations,
  uomConversions,
  uoms,
} from "../db/schema";
import {
  inventoryItemAlternates,
  inventorySetupIdempotency,
  parLevels,
} from "../db/schema/inventory-setup";
import { outlets } from "../db/schema/platform-org";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import {
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
} from "./permission-resolver";

type Database = NodePgDatabase<typeof schema>;
export type SetupTx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type CursorPage<T> = {
  data: T[];
  meta: { limit: number; nextCursor: string | null };
};

export type CreateStockLocationInput = z.infer<
  typeof createStockLocationInputSchema
>;
export type UpdateStockLocationInput = z.infer<
  typeof updateStockLocationInputSchema
>;
export type CreateInventoryItemAlternateInput = z.infer<
  typeof createInventoryItemAlternateInputSchema
>;
export type CreateUomConversionInput = z.infer<
  typeof createUomConversionInputSchema
>;
export type CreateParLevelInput = z.infer<typeof createParLevelInputSchema>;
export type UpdateParLevelInput = z.infer<typeof updateParLevelInputSchema>;

// --------------------------------------------------------------- guards

/** Permission that gates master-data writes (see the file header). */
export const SETUP_WRITE_PERMISSION: PermissionCode = "inventory.stock.receive";
const SETUP_READ_PERMISSION: PermissionCode = "inventory.stock.view";

export async function assertSetupPermission(
  tx: SetupTx,
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

const tenantTarget: AccessTarget = { type: "tenant" };
const outletTarget = (outletId: string): AccessTarget => ({
  type: "outlet",
  id: outletId,
});

function cursorId(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const keys = decodeCursor(cursor);
    if (keys.length === 1 && typeof keys[0] === "string") return keys[0];
  } catch {
    // fall through: a tampered cursor is client input, never a 500.
  }
  throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
}

// ----------------------------------------------------------- idempotency

/** Fingerprint of the request as sent (key excluded), canonical decimals. */
export function setupFingerprint(
  operation: string,
  payload: readonly unknown[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, ...payload]))
    .digest("hex");
}

/** Serialises concurrent retries of one key inside the transaction. */
async function lockIdempotencyKey(
  tx: SetupTx,
  tenantId: string,
  key: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory:setup:idem:${tenantId}:${key}`}, 0))`,
  );
}

/** Resource id of the first request under this key, or null when new. */
export async function findIdempotentResource(
  tx: SetupTx,
  context: ScopedTenantContext,
  key: string,
  operation: string,
  fingerprint: string,
): Promise<string | null> {
  const tenantId = context.tenant.tenantId;
  await lockIdempotencyKey(tx, tenantId, key);
  const [row] = await tx
    .select()
    .from(inventorySetupIdempotency)
    .where(
      and(
        eq(inventorySetupIdempotency.tenantId, tenantId),
        eq(inventorySetupIdempotency.idempotencyKey, key),
      ),
    );
  if (!row) return null;
  if (row.operation !== operation || row.requestFingerprint !== fingerprint)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was used for a different request.",
    );
  return row.resourceId;
}

export async function rememberIdempotentResource(
  tx: SetupTx,
  context: ScopedTenantContext,
  key: string,
  operation: string,
  fingerprint: string,
  resourceId: string,
): Promise<void> {
  await tx.insert(inventorySetupIdempotency).values({
    tenantId: context.tenant.tenantId,
    idempotencyKey: key,
    operation,
    requestFingerprint: fingerprint,
    resourceId,
  });
}

// ----------------------------------------------------------------- audit

export async function auditSetupChange(
  tx: SetupTx,
  context: ScopedTenantContext,
  actorUserId: string,
  change: {
    action: string;
    objectType: string;
    objectId: string;
    outletId: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    /** Fields safe to keep unmasked; everything else is masked. */
    safeFields: readonly string[];
  },
): Promise<void> {
  const now = new Date();
  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId: context.tenant.tenantId,
      outletId: change.outletId,
      actorType: "user",
      actorId: actorUserId,
      deviceId: null,
      action: change.action,
      objectType: change.objectType,
      objectId: change.objectId,
      reason: null,
      maskedChanges: {
        before:
          change.before === null
            ? null
            : maskAuditChanges(change.before, change.safeFields),
        after:
          change.after === null
            ? null
            : maskAuditChanges(change.after, change.safeFields),
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    change.safeFields,
  );
}

// -------------------------------------------------------------- mappers

type LocationRow = typeof stockLocations.$inferSelect;
type ConversionRow = typeof uomConversions.$inferSelect;
type ParLevelRow = typeof parLevels.$inferSelect;
type AlternateRow = typeof inventoryItemAlternates.$inferSelect;

function toLocation(row: LocationRow): StockLocation {
  return stockLocationSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    name: row.name,
    type: row.type,
    isActive: row.isActive,
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

function toParLevel(row: ParLevelRow): ParLevel {
  return parLevelSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    locationId: row.locationId,
    inventoryItemId: row.inventoryItemId,
    parMin: row.parMin,
    parMax: row.parMax,
  });
}

function toAlternate(row: AlternateRow): InventoryItemAlternate {
  return inventoryItemAlternateSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    inventoryItemId: row.inventoryItemId,
    alternateItemId: row.alternateItemId,
    priority: row.priority,
  });
}

const notFound = (what: string) =>
  new HttpError(404, "NOT_FOUND", `${what} not found.`);

async function requireItem(tx: SetupTx, itemId: string) {
  const [row] = await tx
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.id, itemId));
  if (!row) throw notFound("Inventory item");
  return row;
}

// ------------------------------------------------------------- locations

const LOCATION_AUDIT_FIELDS = ["outletId", "type", "isActive"] as const;

function locationAuditView(location: StockLocation) {
  return {
    outletId: location.outletId,
    type: location.type,
    isActive: location.isActive,
  };
}

/** Serialises name checks for one outlet (names are unique per outlet here). */
async function lockOutletLocations(
  tx: SetupTx,
  tenantId: string,
  outletId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory:setup:locations:${tenantId}:${outletId}`}, 0))`,
  );
}

async function assertLocationNameFree(
  tx: SetupTx,
  outletId: string,
  name: string,
  exceptId?: string,
): Promise<void> {
  const filters: SQL[] = [
    eq(stockLocations.outletId, outletId),
    sql`lower(${stockLocations.name}) = lower(${name})`,
  ];
  if (exceptId) filters.push(ne(stockLocations.id, exceptId));
  const [clash] = await tx
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(and(...filters));
  if (clash)
    throw new HttpError(
      409,
      "CONFLICT",
      "This outlet already has a stock location with that name.",
    );
}

/** PRD §16 "Lokasi Stok": a location belongs to one outlet and has a type. */
export async function createStockLocation(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateStockLocationInput,
): Promise<StockLocation> {
  assertOutletInScope(context.outletScope, input.outletId);
  return withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      outletTarget(input.outletId),
    );
    const fingerprint = setupFingerprint("location.create", [
      input.outletId,
      input.name,
      input.type,
    ]);
    const replayId = await findIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "location.create",
      fingerprint,
    );
    if (replayId) {
      const [first] = await tx
        .select()
        .from(stockLocations)
        .where(eq(stockLocations.id, replayId));
      if (!first) throw notFound("Stock location");
      return toLocation(first);
    }
    const [outlet] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(eq(outlets.id, input.outletId));
    if (!outlet) throw notFound("Outlet");
    await lockOutletLocations(tx, context.tenant.tenantId, input.outletId);
    await assertLocationNameFree(tx, input.outletId, input.name);
    const [row] = await tx
      .insert(stockLocations)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        name: input.name,
        type: input.type,
      })
      .returning();
    const location = toLocation(row!);
    await rememberIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "location.create",
      fingerprint,
      location.id,
    );
    await auditSetupChange(tx, context, actorUserId, {
      action: "stock_location.created",
      objectType: "stock_location",
      objectId: location.id,
      outletId: location.outletId,
      before: null,
      after: locationAuditView(location),
      safeFields: LOCATION_AUDIT_FIELDS,
    });
    return location;
  });
}

export async function updateStockLocation(
  context: ScopedTenantContext,
  actorUserId: string,
  locationId: string,
  input: UpdateStockLocationInput,
): Promise<StockLocation> {
  if (
    input.name === undefined &&
    input.type === undefined &&
    input.isActive === undefined
  )
    throw new HttpError(422, "VALIDATION_ERROR", "Nothing to update.");
  return withTenant(db, context, async (tx) => {
    // RLS hides locations outside the caller's outlet scope: a 404, not a 403.
    const [existing] = await tx
      .select()
      .from(stockLocations)
      .where(eq(stockLocations.id, locationId));
    if (!existing) throw notFound("Stock location");
    assertOutletInScope(context.outletScope, existing.outletId);
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      outletTarget(existing.outletId),
    );
    await lockOutletLocations(tx, context.tenant.tenantId, existing.outletId);
    if (input.name !== undefined && input.name !== existing.name)
      await assertLocationNameFree(
        tx,
        existing.outletId,
        input.name,
        existing.id,
      );
    // Deactivating a location that still holds stock would strand it: PRD is
    // silent, safest is to require the stock to be moved or written off first.
    if (input.isActive === false && existing.isActive) {
      const [held] = await tx
        .select({ itemId: stockBalances.inventoryItemId })
        .from(stockBalances)
        .where(
          and(
            eq(stockBalances.locationId, existing.id),
            sql`${stockBalances.quantity} <> 0`,
          ),
        )
        .limit(1);
      if (held)
        throw new HttpError(
          409,
          "CONFLICT",
          "This location still holds stock; transfer or write it off first.",
        );
    }
    const [row] = await tx
      .update(stockLocations)
      .set({
        name: input.name ?? existing.name,
        type: input.type ?? existing.type,
        isActive: input.isActive ?? existing.isActive,
      })
      .where(eq(stockLocations.id, existing.id))
      .returning();
    const before = toLocation(existing);
    const after = toLocation(row!);
    await auditSetupChange(tx, context, actorUserId, {
      action: "stock_location.updated",
      objectType: "stock_location",
      objectId: after.id,
      outletId: after.outletId,
      before: locationAuditView(before),
      after: locationAuditView(after),
      safeFields: LOCATION_AUDIT_FIELDS,
    });
    return after;
  });
}

// ------------------------------------------------------------ alternates

const ALTERNATE_AUDIT_FIELDS = [
  "inventoryItemId",
  "alternateItemId",
  "priority",
] as const;

export async function listInventoryItemAlternates(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
): Promise<InventoryItemAlternate[]> {
  return withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_READ_PERMISSION,
      tenantTarget,
    );
    await requireItem(tx, itemId);
    const rows = await tx
      .select()
      .from(inventoryItemAlternates)
      .where(eq(inventoryItemAlternates.inventoryItemId, itemId))
      .orderBy(
        asc(inventoryItemAlternates.priority),
        asc(inventoryItemAlternates.id),
      );
    return rows.map(toAlternate);
  });
}

/** PRD §16 "Item Bahan & Satuan": "bahan alternatif". Lower priority wins. */
export async function createInventoryItemAlternate(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  input: CreateInventoryItemAlternateInput,
): Promise<InventoryItemAlternate> {
  if (input.alternateItemId === itemId)
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "An item cannot alternate with itself.",
    );
  return withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      tenantTarget,
    );
    const fingerprint = setupFingerprint("alternate.create", [
      itemId,
      input.alternateItemId,
      input.priority,
    ]);
    const replayId = await findIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "alternate.create",
      fingerprint,
    );
    if (replayId) {
      const [first] = await tx
        .select()
        .from(inventoryItemAlternates)
        .where(eq(inventoryItemAlternates.id, replayId));
      if (!first) throw notFound("Alternate");
      return toAlternate(first);
    }
    await requireItem(tx, itemId);
    const alternate = await requireItem(tx, input.alternateItemId);
    if (!alternate.isActive)
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "The alternate item is inactive.",
      );
    const [clash] = await tx
      .select({ id: inventoryItemAlternates.id })
      .from(inventoryItemAlternates)
      .where(
        and(
          eq(inventoryItemAlternates.inventoryItemId, itemId),
          eq(inventoryItemAlternates.alternateItemId, input.alternateItemId),
        ),
      );
    if (clash)
      throw new HttpError(
        409,
        "CONFLICT",
        "This alternate is already set for the item.",
      );
    const [row] = await tx
      .insert(inventoryItemAlternates)
      .values({
        tenantId: context.tenant.tenantId,
        inventoryItemId: itemId,
        alternateItemId: input.alternateItemId,
        priority: input.priority,
      })
      .returning();
    const created = toAlternate(row!);
    await rememberIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "alternate.create",
      fingerprint,
      created.id,
    );
    await auditSetupChange(tx, context, actorUserId, {
      action: "inventory_item_alternate.created",
      objectType: "inventory_item_alternate",
      objectId: created.id,
      outletId: null,
      before: null,
      after: {
        inventoryItemId: created.inventoryItemId,
        alternateItemId: created.alternateItemId,
        priority: created.priority,
      },
      safeFields: ALTERNATE_AUDIT_FIELDS,
    });
    return created;
  });
}

/**
 * Checks that decide whether an alternate is still referenced elsewhere (for
 * example a recipe line that pinned it). Other domains register theirs; with
 * none registered nothing references an alternate yet.
 */
export type SetupReferenceCheck = (
  tx: SetupTx,
  context: ScopedTenantContext,
  subject: { id: string; inventoryItemId: string },
) => Promise<boolean>;
const alternateReferenceChecks: SetupReferenceCheck[] = [];
const conversionReferenceChecks: SetupReferenceCheck[] = [];
export function registerAlternateReferenceCheck(
  check: SetupReferenceCheck,
): void {
  alternateReferenceChecks.push(check);
}
export function registerConversionReferenceCheck(
  check: SetupReferenceCheck,
): void {
  conversionReferenceChecks.push(check);
}

async function isReferenced(
  checks: readonly SetupReferenceCheck[],
  tx: SetupTx,
  context: ScopedTenantContext,
  subject: { id: string; inventoryItemId: string },
): Promise<boolean> {
  for (const check of checks)
    if (await check(tx, context, subject)) return true;
  return false;
}

export async function deleteInventoryItemAlternate(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  alternateId: string,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      tenantTarget,
    );
    const [row] = await tx
      .select()
      .from(inventoryItemAlternates)
      .where(
        and(
          eq(inventoryItemAlternates.id, alternateId),
          eq(inventoryItemAlternates.inventoryItemId, itemId),
        ),
      );
    if (!row) throw notFound("Alternate");
    if (
      await isReferenced(alternateReferenceChecks, tx, context, {
        id: row.id,
        inventoryItemId: row.inventoryItemId,
      })
    )
      throw new HttpError(
        409,
        "CONFLICT",
        "This alternate is still used and cannot be removed.",
      );
    await tx
      .delete(inventoryItemAlternates)
      .where(eq(inventoryItemAlternates.id, row.id));
    const before = toAlternate(row);
    await auditSetupChange(tx, context, actorUserId, {
      action: "inventory_item_alternate.deleted",
      objectType: "inventory_item_alternate",
      objectId: before.id,
      outletId: null,
      before: {
        inventoryItemId: before.inventoryItemId,
        alternateItemId: before.alternateItemId,
        priority: before.priority,
      },
      after: null,
      safeFields: ALTERNATE_AUDIT_FIELDS,
    });
  });
}

// ------------------------------------------------------- UOM conversions

const CONVERSION_AUDIT_FIELDS = [
  "inventoryItemId",
  "fromUomId",
  "toUomId",
  "factor",
] as const;

/**
 * True when `fromUomId` and `toUomId` are already linked for the item, in
 * either direction or through a chain. A conversion is stored purchase -> base
 * and walked both ways (`convertQuantity`), so linking two already-connected
 * units a second time is a duplicate pair or a cycle with an ambiguous factor.
 */
export function conversionLinksConnectedUnits(
  existing: readonly { fromUomId: string; toUomId: string }[],
  fromUomId: string,
  toUomId: string,
): boolean {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
    neighbours.set(b, [...(neighbours.get(b) ?? []), a]);
  };
  for (const edge of existing) link(edge.fromUomId, edge.toUomId);
  const seen = new Set<string>([fromUomId]);
  const queue = [fromUomId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toUomId) return true;
    for (const next of neighbours.get(current) ?? [])
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
  }
  return false;
}

/** PRD §16 "Item Bahan & Satuan": per-item unit conversion (factor > 0). */
export async function createUomConversion(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  input: CreateUomConversionInput,
): Promise<UomConversion> {
  return withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      tenantTarget,
    );
    const factor = formatDecimal4(parseDecimal4(input.factor));
    const fingerprint = setupFingerprint("uom_conversion.create", [
      itemId,
      input.fromUomId,
      input.toUomId,
      factor,
    ]);
    const replayId = await findIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "uom_conversion.create",
      fingerprint,
    );
    if (replayId) {
      const [first] = await tx
        .select()
        .from(uomConversions)
        .where(eq(uomConversions.id, replayId));
      if (!first) throw notFound("UOM conversion");
      return toConversion(first);
    }
    await requireItem(tx, itemId);
    if (parseDecimal4(input.factor) <= 0n)
      throw new HttpError(422, "VALIDATION_ERROR", "factor must be positive.");
    for (const uomId of [input.fromUomId, input.toUomId]) {
      const [uom] = await tx
        .select({ id: uoms.id })
        .from(uoms)
        .where(eq(uoms.id, uomId));
      if (!uom)
        throw new HttpError(
          422,
          "VALIDATION_ERROR",
          "The unit does not belong to this tenant.",
        );
    }
    // Serialise conversion edits per item so the cycle check cannot race.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`inventory:setup:uom:${context.tenant.tenantId}:${itemId}`}, 0))`,
    );
    const existing = await tx
      .select({
        fromUomId: uomConversions.fromUomId,
        toUomId: uomConversions.toUomId,
      })
      .from(uomConversions)
      .where(eq(uomConversions.inventoryItemId, itemId));
    if (conversionLinksConnectedUnits(existing, input.fromUomId, input.toUomId))
      throw new HttpError(
        409,
        "CONFLICT",
        "These units are already linked for this item (duplicate or cycle).",
      );
    const [row] = await tx
      .insert(uomConversions)
      .values({
        tenantId: context.tenant.tenantId,
        inventoryItemId: itemId,
        fromUomId: input.fromUomId,
        toUomId: input.toUomId,
        factor: input.factor,
      })
      .returning();
    const created = toConversion(row!);
    await rememberIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "uom_conversion.create",
      fingerprint,
      created.id,
    );
    await auditSetupChange(tx, context, actorUserId, {
      action: "uom_conversion.created",
      objectType: "uom_conversion",
      objectId: created.id,
      outletId: null,
      before: null,
      after: {
        inventoryItemId: created.inventoryItemId,
        fromUomId: created.fromUomId,
        toUomId: created.toUomId,
        factor: created.factor,
      },
      safeFields: CONVERSION_AUDIT_FIELDS,
    });
    return created;
  });
}

export async function deleteUomConversion(
  context: ScopedTenantContext,
  actorUserId: string,
  itemId: string,
  conversionId: string,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      tenantTarget,
    );
    const [row] = await tx
      .select()
      .from(uomConversions)
      .where(
        and(
          eq(uomConversions.id, conversionId),
          eq(uomConversions.inventoryItemId, itemId),
        ),
      );
    if (!row) throw notFound("UOM conversion");
    if (
      await isReferenced(conversionReferenceChecks, tx, context, {
        id: row.id,
        inventoryItemId: row.inventoryItemId,
      })
    )
      throw new HttpError(
        409,
        "CONFLICT",
        "This conversion is still used by a recipe or purchase line.",
      );
    await tx.delete(uomConversions).where(eq(uomConversions.id, row.id));
    const before = toConversion(row);
    await auditSetupChange(tx, context, actorUserId, {
      action: "uom_conversion.deleted",
      objectType: "uom_conversion",
      objectId: before.id,
      outletId: null,
      before: {
        inventoryItemId: before.inventoryItemId,
        fromUomId: before.fromUomId,
        toUomId: before.toUomId,
        factor: before.factor,
      },
      after: null,
      safeFields: CONVERSION_AUDIT_FIELDS,
    });
  });
}

// ------------------------------------------------------------ par levels

const PAR_AUDIT_FIELDS = [
  "outletId",
  "locationId",
  "inventoryItemId",
  "parMin",
  "parMax",
] as const;

const parAuditView = (par: ParLevel) => ({
  outletId: par.outletId,
  locationId: par.locationId,
  inventoryItemId: par.inventoryItemId,
  parMin: par.parMin,
  parMax: par.parMax,
});

export async function listParLevels(
  context: ScopedTenantContext,
  actorUserId: string,
  query: {
    limit: number;
    cursor?: string;
    outletId: string;
    locationId?: string;
    inventoryItemId?: string;
  },
): Promise<CursorPage<ParLevel>> {
  assertOutletInScope(context.outletScope, query.outletId);
  return withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_READ_PERMISSION,
      outletTarget(query.outletId),
    );
    const filters: SQL[] = [eq(parLevels.outletId, query.outletId)];
    if (query.locationId)
      filters.push(eq(parLevels.locationId, query.locationId));
    if (query.inventoryItemId)
      filters.push(eq(parLevels.inventoryItemId, query.inventoryItemId));
    const after = cursorId(query.cursor);
    if (after !== null) filters.push(gt(parLevels.id, after));
    const rows = await tx
      .select()
      .from(parLevels)
      .where(and(...filters))
      .orderBy(asc(parLevels.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toParLevel),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last ? encodeCursor([last.id]) : null,
      },
    };
  });
}

/** PRD §16 "Par Level & Saran Pembelian": a par level per location and item. */
export async function createParLevel(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateParLevelInput,
): Promise<ParLevel> {
  assertOutletInScope(context.outletScope, input.outletId);
  return withTenant(db, context, async (tx) => {
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      outletTarget(input.outletId),
    );
    const parMin = formatDecimal4(parseDecimal4(input.parMin));
    const parMax = formatDecimal4(parseDecimal4(input.parMax));
    const fingerprint = setupFingerprint("par_level.create", [
      input.outletId,
      input.locationId,
      input.inventoryItemId,
      parMin,
      parMax,
    ]);
    const replayId = await findIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "par_level.create",
      fingerprint,
    );
    if (replayId) {
      const [first] = await tx
        .select()
        .from(parLevels)
        .where(eq(parLevels.id, replayId));
      if (!first) throw notFound("Par level");
      return toParLevel(first);
    }
    if (parseDecimal4(parMax) < parseDecimal4(parMin))
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "parMax must be at least parMin.",
      );
    const [location] = await tx
      .select()
      .from(stockLocations)
      .where(
        and(
          eq(stockLocations.id, input.locationId),
          eq(stockLocations.outletId, input.outletId),
        ),
      );
    if (!location) throw notFound("Stock location");
    if (!location.isActive)
      throw new HttpError(422, "VALIDATION_ERROR", "The location is inactive.");
    const item = await requireItem(tx, input.inventoryItemId);
    if (!item.isActive)
      throw new HttpError(422, "VALIDATION_ERROR", "The item is inactive.");
    const [clash] = await tx
      .select({ id: parLevels.id })
      .from(parLevels)
      .where(
        and(
          eq(parLevels.locationId, input.locationId),
          eq(parLevels.inventoryItemId, input.inventoryItemId),
        ),
      );
    if (clash)
      throw new HttpError(
        409,
        "CONFLICT",
        "A par level already exists for this item in this location.",
      );
    const [row] = await tx
      .insert(parLevels)
      .values({
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        locationId: input.locationId,
        inventoryItemId: input.inventoryItemId,
        parMin: input.parMin,
        parMax: input.parMax,
      })
      .returning();
    const created = toParLevel(row!);
    await rememberIdempotentResource(
      tx,
      context,
      input.idempotencyKey,
      "par_level.create",
      fingerprint,
      created.id,
    );
    await auditSetupChange(tx, context, actorUserId, {
      action: "par_level.created",
      objectType: "par_level",
      objectId: created.id,
      outletId: created.outletId,
      before: null,
      after: parAuditView(created),
      safeFields: PAR_AUDIT_FIELDS,
    });
    return created;
  });
}

export async function updateParLevel(
  context: ScopedTenantContext,
  actorUserId: string,
  parLevelId: string,
  input: UpdateParLevelInput,
): Promise<ParLevel> {
  if (input.parMin === undefined && input.parMax === undefined)
    throw new HttpError(422, "VALIDATION_ERROR", "Nothing to update.");
  return withTenant(db, context, async (tx) => {
    const [existing] = await tx
      .select()
      .from(parLevels)
      .where(eq(parLevels.id, parLevelId));
    if (!existing) throw notFound("Par level");
    assertOutletInScope(context.outletScope, existing.outletId);
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      outletTarget(existing.outletId),
    );
    const parMin = input.parMin ?? existing.parMin;
    const parMax = input.parMax ?? existing.parMax;
    if (parseDecimal4(parMax) < parseDecimal4(parMin))
      throw new HttpError(
        422,
        "VALIDATION_ERROR",
        "parMax must be at least parMin.",
      );
    const [row] = await tx
      .update(parLevels)
      .set({ parMin, parMax, updatedAt: new Date() })
      .where(eq(parLevels.id, existing.id))
      .returning();
    const before = toParLevel(existing);
    const after = toParLevel(row!);
    await auditSetupChange(tx, context, actorUserId, {
      action: "par_level.updated",
      objectType: "par_level",
      objectId: after.id,
      outletId: after.outletId,
      before: parAuditView(before),
      after: parAuditView(after),
      safeFields: PAR_AUDIT_FIELDS,
    });
    return after;
  });
}

/** Removing the override makes the item-level par defaults apply again. */
export async function deleteParLevel(
  context: ScopedTenantContext,
  actorUserId: string,
  parLevelId: string,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const [existing] = await tx
      .select()
      .from(parLevels)
      .where(eq(parLevels.id, parLevelId));
    if (!existing) throw notFound("Par level");
    assertOutletInScope(context.outletScope, existing.outletId);
    await assertSetupPermission(
      tx,
      context,
      actorUserId,
      SETUP_WRITE_PERMISSION,
      outletTarget(existing.outletId),
    );
    await tx.delete(parLevels).where(eq(parLevels.id, existing.id));
    await auditSetupChange(tx, context, actorUserId, {
      action: "par_level.deleted",
      objectType: "par_level",
      objectId: existing.id,
      outletId: existing.outletId,
      before: parAuditView(toParLevel(existing)),
      after: null,
      safeFields: PAR_AUDIT_FIELDS,
    });
  });
}
