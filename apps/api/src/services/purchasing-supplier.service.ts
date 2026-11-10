// Suppliers, supplier contacts and the supplier price catalog (PRD v1.7 §3.18
// Supplier, §6.E suppliers / supplier_prices; bead legend-9yz slice C).
//
// - Suppliers and their price history are tenant-level master data. Writes
//   need `purchasing.supplier.manage` over the whole tenant; reads need any of
//   the purchasing permissions (deny by default, re-checked here on top of the
//   route gate).
// - `supplier_prices` is append-only: a new quote is a new row, and the row
//   with the latest `effectiveFrom` (then `createdAt`) supersedes older ones
//   (`supplierPriceOnDate` in the shared contract). Nothing edits a price.
// - Every create is bound to its request fingerprint through
//   `purchasing_idempotency`; a PATCH is guarded by `expectedUpdatedAt`.
// - Slice D prices a purchase request with `activeSupplierPricesOn`.

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { AccessError, type PermissionCode } from "@starter/shared/access";
import {
  businessDateOf,
  CoreError,
  DEFAULT_BUSINESS_DAY_CLOCK,
  encodeCursor,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  PurchasingError,
  supplierCatalogItemSchema,
  supplierContactSchema,
  supplierDetailSchema,
  supplierSchema,
  type createSupplierCatalogItemInputSchema,
  type createSupplierContactInputSchema,
  type createSupplierInputSchema,
  type Supplier,
  type SupplierCatalogItem,
  type SupplierContact,
  type SupplierDetail,
  type supplierPriceHistoryQuerySchema,
  type supplierQuerySchema,
  type updateSupplierInputSchema,
} from "@starter/shared/inventory";
import type { z } from "zod";
import { db } from "../db/index.ts";
import { inventoryItems, uoms } from "../db/schema/inventory.ts";
import {
  purchasingIdempotency,
  supplierContacts,
  supplierPrices,
  suppliers,
} from "../db/schema/purchasing.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { auditSetupChange } from "./inventory-setup.service.ts";
import { translatePurchasingError } from "./purchasing-flow.shared.ts";
import {
  cursorKeys,
  cursorUuid,
  requestFingerprint,
  type CursorPage,
  type Tx,
} from "./inventory-ops.shared.ts";
import { accessSnapshotInTransaction } from "./permission-resolver.ts";

export type CreateSupplierInput = z.infer<typeof createSupplierInputSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierInputSchema>;
export type CreateSupplierContactInput = z.infer<
  typeof createSupplierContactInputSchema
>;
export type CreateSupplierCatalogItemInput = z.infer<
  typeof createSupplierCatalogItemInputSchema
>;
export type SupplierListQuery = z.infer<typeof supplierQuerySchema>;
export type SupplierPriceHistoryQuery = z.infer<
  typeof supplierPriceHistoryQuerySchema
>;
type CatalogPageQuery = { cursor?: string | undefined; limit: number };

export const SUPPLIER_WRITE_PERMISSION: PermissionCode =
  "purchasing.supplier.manage";
/** Any of these may read the supplier list, contacts and prices. */
export const SUPPLIER_READ_PERMISSIONS: readonly PermissionCode[] = [
  "purchasing.supplier.manage",
  "purchasing.request.create",
  "purchasing.order.create",
  "purchasing.order.approve",
];

const SUPPLIER_AUDIT_FIELDS = [
  "isActive",
  "paymentTermsDays",
  "rating",
] as const;
const CONTACT_AUDIT_FIELDS = ["supplierId", "isPrimary"] as const;
const PRICE_AUDIT_FIELDS = [
  "supplierId",
  "inventoryItemId",
  "purchaseUomId",
  "priceIdr",
  "effectiveFrom",
] as const;

type SupplierRow = typeof suppliers.$inferSelect;
type ContactRow = typeof supplierContacts.$inferSelect;
type PriceRow = typeof supplierPrices.$inferSelect;

// ------------------------------------------------------------------ mappers

function toSupplier(row: SupplierRow): Supplier {
  return supplierSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    legalName: row.legalName,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    paymentTermsDays: row.paymentTermsDays,
    rating: row.rating,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

function toContact(row: ContactRow): SupplierContact {
  return supplierContactSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    supplierId: row.supplierId,
    name: row.name,
    role: row.role,
    phone: row.phone,
    email: row.email,
    isPrimary: row.isPrimary,
  });
}

function toPrice(row: PriceRow): SupplierCatalogItem {
  return supplierCatalogItemSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    supplierId: row.supplierId,
    inventoryItemId: row.inventoryItemId,
    purchaseUomId: row.purchaseUomId,
    priceIdr: row.priceIdr,
    effectiveFrom: row.effectiveFrom,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  });
}

// ------------------------------------------------------------------- errors

const notFound = (what: string) =>
  new HttpError(404, "NOT_FOUND", `${what} not found.`);

/** PostgreSQL unique violation, directly or wrapped by drizzle's cause chain. */
function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

/** A unique constraint is the backstop of the pre-checks: same 409. */
async function insertOrConflict<T>(
  insert: () => Promise<T>,
  conflict: () => unknown,
): Promise<T> {
  try {
    return await insert();
  } catch (error) {
    if (uniqueViolation(error)) throw conflict();
    throw error;
  }
}

const nameTaken = () =>
  translatePurchasingError(
    new PurchasingError(
      "SUPPLIER_NAME_TAKEN",
      "A supplier with that name already exists.",
    ),
  );

// ------------------------------------------------------------------- access

async function requireSupplierWrite(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<void> {
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    new Date(),
  );
  if (!snapshot.allows(SUPPLIER_WRITE_PERMISSION, { type: "tenant" }))
    throw new AccessError("PERMISSION_DENIED");
}

/**
 * Suppliers are tenant-level, so an outlet-assigned buyer or approver reads
 * them too: a read permission that applies at the tenant or at an outlet in
 * the request reach. A station-only grant never passes.
 */
async function requireSupplierRead(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
): Promise<void> {
  const snapshot = await accessSnapshotInTransaction(
    tx,
    context,
    actorUserId,
    new Date(),
  );
  // The snapshot is a flat union over every scope, so a read permission held
  // at a station must not pass. Each permission is tested against the real
  // target: the tenant, or an outlet this request reaches.
  const outletIds =
    context.outletScope.kind === "tenant" ? [] : context.outletScope.outletIds;
  const allowed = SUPPLIER_READ_PERMISSIONS.some(
    (permission) =>
      snapshot.allows(permission, { type: "tenant" }) ||
      outletIds.some((id) =>
        snapshot.allows(permission, { type: "outlet", id }),
      ),
  );
  if (!allowed) throw new AccessError("PERMISSION_DENIED");
}

// -------------------------------------------------------------- idempotency

type Claim = {
  operation: string;
  key: string;
  fingerprint: string;
};

async function findClaim(tx: Tx, context: ScopedTenantContext, claim: Claim) {
  const [row] = await tx
    .select()
    .from(purchasingIdempotency)
    .where(
      and(
        eq(purchasingIdempotency.tenantId, context.tenant.tenantId),
        eq(purchasingIdempotency.operation, claim.operation),
        eq(purchasingIdempotency.idempotencyKey, claim.key),
      ),
    );
  return row ?? null;
}

function replayOf(
  row: { requestFingerprint: string; response: unknown },
  claim: Claim,
): { replay: unknown } {
  if (row.requestFingerprint !== claim.fingerprint || row.response === null)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was used for a different request.",
    );
  return { replay: row.response };
}

/**
 * Claims the key inside the caller's transaction (tenant level, no outlet).
 * Returns the stored response for a replay, throws IDEMPOTENCY_KEY_REUSED for
 * a different request, or null when this transaction now owns the key.
 */
export async function claimPurchasingIdempotency(
  tx: Tx,
  context: ScopedTenantContext,
  claim: Claim,
): Promise<{ replay: unknown } | null> {
  const existing = await findClaim(tx, context, claim);
  if (existing) return replayOf(existing, claim);
  const inserted = await tx
    .insert(purchasingIdempotency)
    .values({
      tenantId: context.tenant.tenantId,
      outletId: null,
      operation: claim.operation,
      idempotencyKey: claim.key,
      requestFingerprint: claim.fingerprint,
      response: null,
    })
    .onConflictDoNothing()
    .returning({ key: purchasingIdempotency.idempotencyKey });
  if (inserted.length > 0) return null;
  const winner = await findClaim(tx, context, claim);
  if (!winner)
    throw new CoreError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was used for a different request.",
    );
  return replayOf(winner, claim);
}

export async function completePurchasingIdempotency(
  tx: Tx,
  context: ScopedTenantContext,
  claim: Claim,
  response: unknown,
): Promise<void> {
  await tx
    .update(purchasingIdempotency)
    .set({ response })
    .where(
      and(
        eq(purchasingIdempotency.tenantId, context.tenant.tenantId),
        eq(purchasingIdempotency.operation, claim.operation),
        eq(purchasingIdempotency.idempotencyKey, claim.key),
      ),
    );
}

// ---------------------------------------------------------------- suppliers

async function assertNameFree(
  tx: Tx,
  name: string,
  exceptId?: string,
): Promise<void> {
  const filters: SQL[] = [sql`lower(${suppliers.name}) = lower(${name})`];
  if (exceptId) filters.push(ne(suppliers.id, exceptId));
  const [clash] = await tx
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(...filters));
  if (clash) throw nameTaken();
}

async function loadSupplier(
  tx: Tx,
  supplierId: string,
  lock = false,
): Promise<SupplierRow> {
  const query = tx.select().from(suppliers).where(eq(suppliers.id, supplierId));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("Supplier");
  return row;
}

/** POST supplier. Needs `purchasing.supplier.manage` over the tenant. */
export async function createSupplier(
  context: ScopedTenantContext,
  actorUserId: string,
  input: CreateSupplierInput,
): Promise<Supplier> {
  const operation = "supplier.create";
  const { idempotencyKey, ...fields } = input;
  const claim = {
    operation,
    key: idempotencyKey,
    fingerprint: requestFingerprint(operation, actorUserId, {
      name: fields.name,
      legalName: fields.legalName ?? null,
      contactName: fields.contactName ?? null,
      phone: fields.phone ?? null,
      email: fields.email ?? null,
      address: fields.address ?? null,
      paymentTermsDays: fields.paymentTermsDays,
      rating: fields.rating ?? null,
    }),
  };
  return withTenant(db, context, async (tx) => {
    await requireSupplierWrite(tx, context, actorUserId);
    const replay = await claimPurchasingIdempotency(tx, context, claim);
    if (replay) return supplierSchema.parse(replay.replay);

    await assertNameFree(tx, fields.name);
    const [row] = await insertOrConflict(
      () =>
        tx
          .insert(suppliers)
          .values({
            id: randomUUID(),
            tenantId: context.tenant.tenantId,
            name: fields.name,
            legalName: fields.legalName ?? null,
            contactName: fields.contactName ?? null,
            phone: fields.phone ?? null,
            email: fields.email ?? null,
            address: fields.address ?? null,
            paymentTermsDays: fields.paymentTermsDays,
            rating: fields.rating ?? null,
            isActive: true,
            createdBy: actorUserId,
          })
          .returning(),
      nameTaken,
    );
    const supplier = toSupplier(row!);
    await auditSetupChange(tx, context, actorUserId, {
      action: "purchasing.supplier_created",
      objectType: "supplier",
      objectId: supplier.id,
      outletId: null,
      before: null,
      after: supplier,
      safeFields: SUPPLIER_AUDIT_FIELDS,
    });
    await completePurchasingIdempotency(tx, context, claim, supplier);
    return supplier;
  });
}

/** GET suppliers, name order (case-insensitive), cursor paginated. */
export async function listSuppliers(
  context: ScopedTenantContext,
  actorUserId: string,
  query: SupplierListQuery,
): Promise<CursorPage<Supplier>> {
  return withTenant(db, context, async (tx) => {
    await requireSupplierRead(tx, context, actorUserId);
    const filters: SQL[] = [];
    if (query.isActive !== undefined)
      filters.push(eq(suppliers.isActive, query.isActive === "true"));
    const [lowerName, id] = cursorKeys(query.cursor, 2);
    if (lowerName !== undefined && id !== undefined)
      filters.push(
        sql`(lower(${suppliers.name}), ${suppliers.id}) > (${lowerName}, ${cursorUuid(id)}::uuid)`,
      );
    const rows = await tx
      .select({
        supplier: suppliers,
        sortName: sql<string>`lower(${suppliers.name})`,
      })
      .from(suppliers)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(sql`lower(${suppliers.name})`, asc(suppliers.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => toSupplier(row.supplier)),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.sortName, last.supplier.id])
            : null,
      },
    };
  });
}

/** GET one supplier with its contacts (primary first). */
export async function getSupplierDetail(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierId: string,
): Promise<SupplierDetail> {
  return withTenant(db, context, async (tx) => {
    await requireSupplierRead(tx, context, actorUserId);
    const row = await loadSupplier(tx, supplierId);
    const contacts = await tx
      .select()
      .from(supplierContacts)
      .where(eq(supplierContacts.supplierId, supplierId))
      .orderBy(
        desc(supplierContacts.isPrimary),
        asc(supplierContacts.createdAt),
        asc(supplierContacts.id),
      );
    return supplierDetailSchema.parse({
      supplier: toSupplier(row),
      contacts: contacts.map(toContact),
    });
  });
}

/**
 * PATCH supplier. `undefined` keeps a field, `null` clears a nullable one.
 * A stale `expectedUpdatedAt` is CORE PRECONDITION_FAILED.
 */
export async function updateSupplier(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierId: string,
  input: UpdateSupplierInput,
): Promise<Supplier> {
  return withTenant(db, context, async (tx) => {
    await requireSupplierWrite(tx, context, actorUserId);
    const current = await loadSupplier(tx, supplierId, true);
    if (current.updatedAt.getTime() !== Date.parse(input.expectedUpdatedAt))
      throw new CoreError(
        "PRECONDITION_FAILED",
        "The supplier changed since you loaded it. Reload and try again.",
      );
    const patch: Partial<typeof suppliers.$inferInsert> = {};
    for (const [key, value] of Object.entries(input))
      if (key !== "expectedUpdatedAt" && value !== undefined)
        (patch as Record<string, unknown>)[key] = value;
    if (Object.keys(patch).length === 0) return toSupplier(current);
    if (input.name !== undefined && input.name !== current.name)
      await assertNameFree(tx, input.name, current.id);
    const [row] = await insertOrConflict(
      () =>
        tx
          .update(suppliers)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(suppliers.id, supplierId))
          .returning(),
      nameTaken,
    );
    const before = toSupplier(current);
    const after = toSupplier(row!);
    await auditSetupChange(tx, context, actorUserId, {
      action: "purchasing.supplier_updated",
      objectType: "supplier",
      objectId: after.id,
      outletId: null,
      before,
      after,
      safeFields: SUPPLIER_AUDIT_FIELDS,
    });
    return after;
  });
}

// ----------------------------------------------------------------- contacts

/** POST contact. A new primary contact demotes the previous one. */
export async function createSupplierContact(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierId: string,
  input: CreateSupplierContactInput,
): Promise<SupplierContact> {
  const operation = "supplier.contact.create";
  const claim = {
    operation,
    key: input.idempotencyKey,
    fingerprint: requestFingerprint(operation, actorUserId, {
      supplierId,
      name: input.name,
      role: input.role ?? null,
      phone: input.phone,
      email: input.email ?? null,
      isPrimary: input.isPrimary,
    }),
  };
  return withTenant(db, context, async (tx) => {
    await requireSupplierWrite(tx, context, actorUserId);
    const replay = await claimPurchasingIdempotency(tx, context, claim);
    if (replay) return supplierContactSchema.parse(replay.replay);

    await loadSupplier(tx, supplierId, true);
    if (input.isPrimary)
      await tx
        .update(supplierContacts)
        .set({ isPrimary: false })
        .where(
          and(
            eq(supplierContacts.supplierId, supplierId),
            eq(supplierContacts.isPrimary, true),
          ),
        );
    const [row] = await insertOrConflict(
      () =>
        tx
          .insert(supplierContacts)
          .values({
            id: randomUUID(),
            tenantId: context.tenant.tenantId,
            supplierId,
            name: input.name,
            role: input.role ?? null,
            phone: input.phone,
            email: input.email ?? null,
            isPrimary: input.isPrimary,
          })
          .returning(),
      () =>
        new HttpError(
          409,
          "CONFLICT",
          "This supplier already has a primary contact.",
        ),
    );
    const contact = toContact(row!);
    await auditSetupChange(tx, context, actorUserId, {
      action: "purchasing.supplier_contact_created",
      objectType: "supplier_contact",
      objectId: contact.id,
      outletId: null,
      before: null,
      after: contact,
      safeFields: CONTACT_AUDIT_FIELDS,
    });
    await completePurchasingIdempotency(tx, context, claim, contact);
    return contact;
  });
}

// ------------------------------------------------------------------ catalog

/** POST a new catalog price row (append-only; supersedes by `effectiveFrom`). */
export async function createSupplierCatalogItem(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierId: string,
  input: CreateSupplierCatalogItemInput,
): Promise<SupplierCatalogItem> {
  const operation = "supplier.catalog.create";
  const claim = {
    operation,
    key: input.idempotencyKey,
    fingerprint: requestFingerprint(operation, actorUserId, {
      supplierId,
      inventoryItemId: input.inventoryItemId,
      purchaseUomId: input.purchaseUomId,
      priceIdr: input.priceIdr,
      effectiveFrom: input.effectiveFrom,
    }),
  };
  return withTenant(db, context, async (tx) => {
    await requireSupplierWrite(tx, context, actorUserId);
    const replay = await claimPurchasingIdempotency(tx, context, claim);
    if (replay) return supplierCatalogItemSchema.parse(replay.replay);

    const supplier = await loadSupplier(tx, supplierId, true);
    if (!supplier.isActive)
      throw translatePurchasingError(
        new PurchasingError(
          "SUPPLIER_INACTIVE",
          "This supplier is inactive. Activate it before adding prices.",
        ),
      );
    const [item] = await tx
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, input.inventoryItemId));
    if (!item) throw notFound("Inventory item");
    const [uom] = await tx
      .select({ id: uoms.id })
      .from(uoms)
      .where(eq(uoms.id, input.purchaseUomId));
    if (!uom) throw notFound("Unit of measure");

    const [row] = await tx
      .insert(supplierPrices)
      .values({
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        supplierId,
        inventoryItemId: input.inventoryItemId,
        purchaseUomId: input.purchaseUomId,
        priceIdr: input.priceIdr,
        effectiveFrom: input.effectiveFrom,
        isActive: true,
        createdBy: actorUserId,
      })
      .returning();
    const price = toPrice(row!);
    await auditSetupChange(tx, context, actorUserId, {
      action: "purchasing.supplier_price_created",
      objectType: "supplier_price",
      objectId: price.id,
      outletId: null,
      before: null,
      after: price,
      safeFields: PRICE_AUDIT_FIELDS,
    });
    await completePurchasingIdempotency(tx, context, claim, price);
    return price;
  });
}

/**
 * GET the supplier catalog: the active price in force today (business date)
 * for each item and purchase unit, ordered by item then unit. Future-dated
 * quotes show once their date arrives; history has its own endpoint.
 */
export async function listSupplierCatalog(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierId: string,
  query: CatalogPageQuery,
): Promise<CursorPage<SupplierCatalogItem>> {
  return withTenant(db, context, async (tx) => {
    await requireSupplierRead(tx, context, actorUserId);
    await loadSupplier(tx, supplierId);
    const today = businessDateOf(new Date(), DEFAULT_BUSINESS_DAY_CLOCK);
    const filters: SQL[] = [
      eq(supplierPrices.supplierId, supplierId),
      eq(supplierPrices.isActive, true),
      sql`${supplierPrices.effectiveFrom} <= ${today}::date`,
    ];
    const [itemId, uomId] = cursorKeys(query.cursor, 2);
    if (itemId !== undefined && uomId !== undefined)
      filters.push(
        sql`(${supplierPrices.inventoryItemId}, ${supplierPrices.purchaseUomId}) > (${cursorUuid(itemId)}::uuid, ${cursorUuid(uomId)}::uuid)`,
      );
    const rows = await tx
      .selectDistinctOn([
        supplierPrices.inventoryItemId,
        supplierPrices.purchaseUomId,
      ])
      .from(supplierPrices)
      .where(and(...filters))
      .orderBy(
        asc(supplierPrices.inventoryItemId),
        asc(supplierPrices.purchaseUomId),
        desc(supplierPrices.effectiveFrom),
        desc(supplierPrices.createdAt),
        desc(supplierPrices.id),
      )
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toPrice),
      meta: {
        limit: query.limit,
        nextCursor:
          rows.length > query.limit && last
            ? encodeCursor([last.inventoryItemId, last.purchaseUomId])
            : null,
      },
    };
  });
}

/**
 * GET the full price history of one item at one supplier, newest first
 * (`supplierPriceHistory` order: effectiveFrom, then createdAt, descending).
 */
export async function getSupplierPriceHistory(
  context: ScopedTenantContext,
  actorUserId: string,
  supplierId: string,
  query: SupplierPriceHistoryQuery,
): Promise<SupplierCatalogItem[]> {
  return withTenant(db, context, async (tx) => {
    await requireSupplierRead(tx, context, actorUserId);
    await loadSupplier(tx, supplierId);
    const rows = await tx
      .select()
      .from(supplierPrices)
      .where(
        and(
          eq(supplierPrices.supplierId, supplierId),
          eq(supplierPrices.inventoryItemId, query.inventoryItemId),
        ),
      )
      .orderBy(
        desc(supplierPrices.effectiveFrom),
        desc(supplierPrices.createdAt),
        desc(supplierPrices.id),
      );
    return rows.map(toPrice);
  });
}

/**
 * Helper for the purchase request estimate (slice D): the active price in
 * force on `onDate` for every (supplier, item, purchase unit) of `itemIds`.
 * `supplierId` null spans all ACTIVE suppliers; a given supplier is used as is.
 * Runs inside the caller's tenant transaction (RLS scopes the tenant); the
 * caller has already authorized the request.
 */
export async function activeSupplierPricesOn(
  tx: Tx,
  context: ScopedTenantContext,
  supplierId: string | null,
  itemIds: readonly string[],
  onDate: string,
): Promise<SupplierCatalogItem[]> {
  if (itemIds.length === 0) return [];
  const filters: SQL[] = [
    eq(supplierPrices.tenantId, context.tenant.tenantId),
    inArray(supplierPrices.inventoryItemId, [...new Set(itemIds)]),
    eq(supplierPrices.isActive, true),
    sql`${supplierPrices.effectiveFrom} <= ${onDate}::date`,
  ];
  if (supplierId !== null)
    filters.push(eq(supplierPrices.supplierId, supplierId));
  else
    filters.push(
      sql`${supplierPrices.supplierId} IN (SELECT ${suppliers.id} FROM ${suppliers} WHERE ${suppliers.isActive})`,
    );
  const rows = await tx
    .selectDistinctOn([
      supplierPrices.supplierId,
      supplierPrices.inventoryItemId,
      supplierPrices.purchaseUomId,
    ])
    .from(supplierPrices)
    .where(and(...filters))
    .orderBy(
      asc(supplierPrices.supplierId),
      asc(supplierPrices.inventoryItemId),
      asc(supplierPrices.purchaseUomId),
      desc(supplierPrices.effectiveFrom),
      desc(supplierPrices.createdAt),
      desc(supplierPrices.id),
    );
  return rows.map(toPrice);
}
