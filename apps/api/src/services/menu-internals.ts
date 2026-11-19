// Shared internals of the menu services (legend-lmk): authority checks, brand
// and outlet scope resolution, the transactional event helper, keyset
// pagination and the media-URL port. Not a public service surface — the
// routers call menu.service.ts and menu-pricing.service.ts.

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  AccessError,
  outletReachOf,
  type PermissionCode,
} from "@starter/shared/access";
import {
  assertOutletInScope,
  createUlid,
  decodeCursor,
  encodeCursor,
  CoreError,
  userIdSchema,
  type CursorKey,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type * as schema from "../db/schema";
import {
  brands,
  coreStorageObjects,
  domainEventOutbox,
  menuItems,
  outlets,
} from "../db/schema";
import { HttpError } from "../lib/http-error";
import { appendOutbox } from "./core-outbox";
import {
  accessSnapshotInTransaction,
  loadTenantAccessInTransaction,
  resolveAccessSnapshot,
  type AccessSnapshot,
} from "./permission-resolver";

export type Database = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type AccessTarget = Parameters<AccessSnapshot["allows"]>[1];

/** Consumers receive menu events through the cloud sync stream. */
export const EVENT_DESTINATION = "cloud-sync";
export const MENU_ITEM_PERMISSION = "menu.item.manage" as const;
export const MENU_VIEW_PERMISSION = "menu.item.view" as const;
export const MENU_PRICE_MANAGE_PERMISSION = "menu.price.manage" as const;

// ---------------------------------------------------------------- authority

/**
 * Service-side permission check against a concrete target, on the caller's
 * transaction so the write and the authorization see one snapshot.
 */
export async function accessSnapshot(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  now: Date,
): Promise<AccessSnapshot> {
  return accessSnapshotInTransaction(tx, context, actorUserId, now);
}

export async function assertPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  target: AccessTarget,
  now: Date,
): Promise<void> {
  const snapshot = await accessSnapshot(tx, context, actorUserId, now);
  if (!snapshot.allows(permission, target))
    throw new AccessError(
      "PERMISSION_DENIED",
      "Anda tidak memiliki izin untuk mengelola menu ini.",
    );
}

/**
 * Read access to brand-owned master data. `menu.item.view` is held by
 * outlet-scoped roles (cashier, waiter, outlet manager, supervisor, kitchen
 * lead), so a read is allowed when the caller reaches the tenant, the brand, or
 * any outlet of that brand (TEN-03). Writes still require the brand target.
 */
export async function assertBrandReadPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  brandId: string,
  now: Date,
): Promise<void> {
  const snapshot = await accessSnapshot(tx, context, actorUserId, now);
  if (
    snapshot.allows(permission, { type: "tenant" }) ||
    snapshot.allows(permission, { type: "brand", id: brandId })
  )
    return;
  const rows = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        eq(outlets.brandId, brandId),
      ),
    );
  for (const row of rows)
    if (snapshot.allows(permission, { type: "outlet", id: row.id })) return;
  throw new AccessError(
    "PERMISSION_DENIED",
    "Anda tidak memiliki izin untuk melihat menu ini.",
  );
}

/**
 * Permission held at the tenant or at some outlet (a brand grant reaches its
 * outlets). Modifier groups and modifiers are shared per tenant (the PRD gives
 * them no brand column), so there is no narrower target to judge; data stays
 * inside the tenant. A station-only grant is denied: it reaches one station,
 * not the menu. Reads may use this reach check; writes must use
 * assertSharedMasterDataPermission.
 */
export async function assertAnyPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  now: Date,
): Promise<void> {
  const snapshot = await accessSnapshot(tx, context, actorUserId, now);
  // The flat union also holds station grants, which reach one station only:
  // require the tenant target, or some outlet of the tenant (legend-dak5).
  if (snapshot.allows(permission, { type: "tenant" })) return;
  const rows = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(eq(outlets.tenantId, context.tenant.tenantId));
  for (const row of rows)
    if (snapshot.allows(permission, { type: "outlet", id: row.id })) return;
  throw new AccessError(
    "PERMISSION_DENIED",
    "Anda tidak memiliki izin untuk mengelola menu ini.",
  );
}

/**
 * Writes to tenant-shared master data. Modifier groups and modifiers carry no
 * brand or outlet column (PRD v1.7 §6 C schema), so one change reaches every
 * outlet of the tenant: the permission must be held at tenant scope. A brand
 * grant would rewrite another brand's menu, and its event could not enter the
 * tenant-level outbox stream (a narrower context may not emit tenant-wide
 * events), so both are refused fail closed.
 */
export async function assertSharedMasterDataPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  now: Date,
): Promise<void> {
  const snapshot = await accessSnapshot(tx, context, actorUserId, now);
  if (snapshot.allows(permission, { type: "tenant" })) return;
  throw new AccessError(
    "PERMISSION_DENIED",
    "Data menu bersama hanya dapat diubah pada cakupan tenant.",
  );
}

/**
 * Brands a caller may read for `permission`: "all" for a tenant-wide grant,
 * otherwise the brands of the outlets their assignments reach. An empty result
 * denies (fail closed).
 */
export async function menuReadBrandScope(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  now: Date,
): Promise<"all" | string[]> {
  const data = await loadTenantAccessInTransaction(tx, context, actorUserId);
  const snapshot = resolveAccessSnapshot({
    tenant: context.tenant,
    userId: actorUserId,
    ...data,
    mfaVerified: false,
    now,
  });
  if (snapshot.allows(permission, { type: "tenant" })) return "all";
  const reach = outletReachOf({
    principal: {
      tenantId: context.tenant.tenantId,
      userId: userIdSchema.parse(actorUserId),
      assignments: data.assignments,
    },
    roles: data.roles,
    org: data.org,
    now: data.clock ?? now,
    permission,
  });
  if (reach === null || reach.kind === "tenant") return "all";
  if (reach.outletIds.length === 0) throw new AccessError("PERMISSION_DENIED");
  const rows = await tx
    .select({ brandId: outlets.brandId })
    .from(outlets)
    .where(
      and(
        eq(outlets.tenantId, context.tenant.tenantId),
        inArray(outlets.id, [...reach.outletIds]),
      ),
    );
  const brands = [
    ...new Set(
      rows
        .map((row) => row.brandId)
        .filter(
          (brand) =>
            context.tenant.brandId === null ||
            brand.toLowerCase() === context.tenant.brandId.toLowerCase(),
        ),
    ),
  ];
  if (brands.length === 0) throw new AccessError("PERMISSION_DENIED");
  return brands;
}

/** Brand-owned records: permission on the owning brand. */
export async function assertBrandPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  brandId: string,
  now: Date,
): Promise<void> {
  await assertPermission(
    tx,
    context,
    actorUserId,
    permission,
    { type: "brand", id: brandId },
    now,
  );
}

/** Outlet-owned records: permission on the owning outlet (TEN-03). */
export async function assertOutletPermission(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  outletId: string,
  now: Date,
): Promise<void> {
  await assertPermission(
    tx,
    context,
    actorUserId,
    permission,
    { type: "outlet", id: outletId },
    now,
  );
}

// ---------------------------------------------------------------- scope

/**
 * The brand a brand-owned record belongs to. `requested` may only narrow the
 * server context, never widen it (TEN-02): a domain-pinned brand wins, and a
 * different submitted brand is refused.
 */
export async function resolveBrand(
  tx: Tx,
  context: ScopedTenantContext,
  requested?: string | null,
): Promise<string> {
  if (context.tenant.brandId !== null) {
    if (
      requested !== undefined &&
      requested !== null &&
      requested.toLowerCase() !== context.tenant.brandId.toLowerCase()
    )
      throw new CoreError(
        "OUTLET_OUT_OF_SCOPE",
        "Anda tidak memiliki akses ke brand ini.",
      );
    return context.tenant.brandId;
  }
  if (requested !== undefined && requested !== null) {
    const [row] = await tx
      .select({ id: brands.id })
      .from(brands)
      .where(
        and(
          eq(brands.tenantId, context.tenant.tenantId),
          eq(brands.id, requested),
        ),
      );
    if (!row) throw new CoreError("NOT_FOUND", "Brand tidak ditemukan.");
    return row.id;
  }
  const rows = await tx
    .select({ id: brands.id })
    .from(brands)
    .where(eq(brands.tenantId, context.tenant.tenantId))
    .orderBy(asc(brands.createdAt), asc(brands.id));
  if (rows.length === 0)
    throw new CoreError("NOT_FOUND", "Brand belum tersedia.");
  if (rows.length === 1) return rows[0].id;
  throw new HttpError(422, "VALIDATION_ERROR", "Pilih brand terlebih dahulu.");
}

/** The outlet of an outlet-owned record; a multi-outlet caller must name one. */
export async function resolveOutlet(
  tx: Tx,
  context: ScopedTenantContext,
  requested?: string | null,
): Promise<string> {
  if (requested !== undefined && requested !== null) {
    assertOutletInScope(context.outletScope, requested);
    const [row] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, context.tenant.tenantId),
          eq(outlets.id, requested),
        ),
      );
    if (!row) throw new CoreError("NOT_FOUND", "Outlet tidak ditemukan.");
    return row.id;
  }
  if (context.outletScope.kind === "outlets") {
    if (context.outletScope.outletIds.length === 1)
      return context.outletScope.outletIds[0];
    throw new HttpError(
      422,
      "VALIDATION_ERROR",
      "Pilih outlet terlebih dahulu.",
    );
  }
  const rows = await tx
    .select({ id: outlets.id })
    .from(outlets)
    .where(eq(outlets.tenantId, context.tenant.tenantId))
    .orderBy(asc(outlets.createdAt), asc(outlets.id));
  if (rows.length === 0)
    throw new CoreError("NOT_FOUND", "Outlet belum tersedia.");
  if (rows.length === 1) return rows[0].id;
  throw new HttpError(422, "VALIDATION_ERROR", "Pilih outlet terlebih dahulu.");
}

/** Outlet ids of a caller's RLS scope, for list filters. */
export function scopedOutletIds(
  context: ScopedTenantContext,
  requested?: string,
): { kind: "all" } | { kind: "outlets"; outletIds: readonly string[] } {
  if (requested !== undefined) {
    assertOutletInScope(context.outletScope, requested);
    return { kind: "outlets", outletIds: [requested] };
  }
  return context.outletScope.kind === "tenant"
    ? { kind: "all" }
    : { kind: "outlets", outletIds: context.outletScope.outletIds };
}

/**
 * Brand ids a list may show, for a read permission:
 * - requested brand: only when it is inside the caller's read scope;
 * - otherwise the whole reachable set, or null (no filter) for a tenant-wide
 *   grant without a domain-pinned brand.
 */
export async function readBrandFilter(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  permission: PermissionCode,
  requestedBrandId: string | undefined,
  now: Date,
): Promise<string[] | null> {
  const requested =
    requestedBrandId !== undefined
      ? await resolveBrand(tx, context, requestedBrandId)
      : null;
  const scope = await menuReadBrandScope(
    tx,
    context,
    actorUserId,
    permission,
    now,
  );
  if (requested !== null) {
    if (scope !== "all" && !scope.includes(requested))
      throw new AccessError(
        "PERMISSION_DENIED",
        "Anda tidak memiliki izin untuk melihat menu brand ini.",
      );
    return [requested];
  }
  if (scope === "all")
    return context.tenant.brandId !== null ? [context.tenant.brandId] : null;
  return scope;
}

// ---------------------------------------------------------------- events

export async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  // Serialize the max+1 read for one aggregate: two concurrent changes of the
  // same record would otherwise read the same maximum and collide on the
  // outbox's (tenant, aggregate, sequence) unique key. The lock is released at
  // commit, so it never outlives the transaction that reads it.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`menu-outbox:${tenantId}:${aggregateType}:${aggregateId}`}))`,
  );
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/**
 * The record a change affects, and therefore the outlet stream its event must
 * join:
 * - `outlet`: outlet-owned data (station, price list, availability);
 * - `brand`: brand-owned data (category, item, variant, combo, item↔group
 *   link), which concerns every outlet of that brand;
 * - `shared`: tenant-shared data without a brand column (modifier groups,
 *   modifiers), which concerns the whole tenant.
 *
 * Routing follows the affected record, not the actor: a tenant-wide caller that
 * edits one outlet's row must not broadcast a tenant-level event.
 */
export type MenuEventAffects =
  | { readonly kind: "outlet"; readonly outletId: string }
  | { readonly kind: "brand"; readonly brandId: string }
  | { readonly kind: "shared" };

/**
 * The one outlet stream an aggregate's events join. The outbox requires every
 * event of an aggregate to share an outlet (`app.enforce_outbox_aggregate_outlet`),
 * so routing is anchored, not fanned out:
 * - an aggregate that already has events keeps the outlet of its first event,
 *   whatever scope the current writer holds (this is what keeps sequence and
 *   consumption consistent across actors);
 * - a new aggregate starts at the affected record's outlet: its own outlet, or
 *   the brand's first outlet for brand-owned data (all brand outlets share the
 *   change; one deterministic stream keeps the invariant);
 * - tenant-shared data uses the tenant-level stream, which only a tenant-scoped
 *   context may write.
 */
async function eventTargetsFor(
  tx: Tx,
  context: ScopedTenantContext,
  aggregateType: string,
  aggregateId: string,
  affects: MenuEventAffects,
): Promise<readonly (string | null)[]> {
  const [prior] = await tx
    .select({ outletId: domainEventOutbox.outletId })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, context.tenant.tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    )
    .limit(1);
  if (prior) {
    if (prior.outletId === null) {
      if (context.outletScope.kind !== "tenant")
        throw new AccessError(
          "PERMISSION_DENIED",
          "Event ini hanya dapat ditulis pada cakupan tenant.",
        );
      return [null];
    }
    return [prior.outletId];
  }
  switch (affects.kind) {
    case "outlet":
      return [affects.outletId];
    case "brand": {
      const [first] = await tx
        .select({ id: outlets.id })
        .from(outlets)
        .where(
          and(
            eq(outlets.tenantId, context.tenant.tenantId),
            eq(outlets.brandId, affects.brandId),
          ),
        )
        .orderBy(asc(outlets.createdAt), asc(outlets.id))
        .limit(1);
      if (first) return [first.id];
      // A brand without outlets has no edge node: a tenant-wide caller still
      // records the change tenant-wide, a narrower caller has nowhere to send.
      return context.outletScope.kind === "tenant" ? [null] : [];
    }
    case "shared":
      if (context.outletScope.kind !== "tenant")
        throw new AccessError(
          "PERMISSION_DENIED",
          "Data menu bersama hanya dapat diubah pada cakupan tenant.",
        );
      return [null];
  }
}

/**
 * Appends one master-data event to the aggregate's outlet stream. The outbox
 * refuses an outlet outside the caller's scope and a tenant-wide event from a
 * narrower scope, so a narrower caller only ever addresses outlets inside its
 * own reach.
 */
export async function appendMenuEvent(
  tx: Tx,
  context: ScopedTenantContext,
  definition: {
    readonly name: string;
    readonly version: number;
    readonly payloadSchemaRef: string;
    readonly entry: { readonly aggregateType: string };
    readonly envelopeSchema: { parse(value: unknown): unknown };
  },
  input: {
    aggregateId: string;
    /** `null` is the system actor (worker sweeps with no signed-in user). */
    actorUserId: string | null;
    payload: Record<string, unknown>;
    affects: MenuEventAffects;
    now: Date;
  },
): Promise<void> {
  const targets = await eventTargetsFor(
    tx,
    context,
    definition.entry.aggregateType,
    input.aggregateId,
    input.affects,
  );
  for (const outletId of targets) {
    const sequence = await nextSequence(
      tx,
      context.tenant.tenantId,
      definition.entry.aggregateType,
      input.aggregateId,
    );
    const eventId = createUlid(input.now.getTime());
    const event = definition.envelopeSchema.parse({
      id: eventId,
      tenantId: context.tenant.tenantId,
      outletId,
      name: definition.name,
      version: definition.version,
      aggregateType: definition.entry.aggregateType,
      aggregateId: input.aggregateId,
      sequence,
      occurredAt: input.now.toISOString(),
      actor:
        input.actorUserId === null
          ? { type: "system" }
          : { type: "user", id: input.actorUserId },
      deviceId: null,
      // Unique per event; a client-supplied 86 key overrides this.
      idempotencyKey: eventId,
      payloadSchemaRef: definition.payloadSchemaRef,
      payload: input.payload,
    });
    await appendOutbox(tx, context, {
      id: createUlid(input.now.getTime()),
      event,
      destination: EVENT_DESTINATION,
      direction: null,
      peerId: null,
    });
  }
}

// ---------------------------------------------------------------- pagination

/**
 * Keyset condition for an ascending (or descending) multi-column sort. The
 * cursor holds exactly the sort tuple of the last returned row (D-CORE-5).
 */
export function keysetCondition(
  columns: readonly AnyPgColumn[],
  values: readonly CursorKey[],
  direction: "asc" | "desc" = "asc",
): SQL | undefined {
  if (values.length !== columns.length) throw new RangeError("Invalid cursor");
  const parts: SQL[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const equals = columns
      .slice(0, index)
      .map((column, position) => sql`${column} = ${values[position]}`);
    const compare =
      direction === "asc"
        ? sql`${columns[index]} > ${values[index]}`
        : sql`${columns[index]} < ${values[index]}`;
    parts.push(sql`(${sql.join([...equals, compare], sql` AND `)})`);
  }
  return or(...parts);
}

export function cursorOf(query: { cursor?: string }): CursorKey[] | undefined {
  return query.cursor ? decodeCursor(query.cursor) : undefined;
}

export function pageOf<Row, Dto>(
  rows: Row[],
  limit: number,
  keyOf: (row: Row) => CursorKey[],
  toDto: (row: Row) => Dto,
): { data: Dto[]; meta: { limit: number; nextCursor: string | null } } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeCursor(keyOf(last))
      : null;
  return {
    data: page.map(toDto),
    meta: { limit, nextCursor },
  };
}

/** Escape LIKE wildcards so a search term matches literally. */
export function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

// ---------------------------------------------------------------- guest reads

/**
 * Q23 (legend-qf0i): the SQL form of `menuItemVisibleToGuests` — a guest read
 * only sees an active row that carries a photo. Legacy rows created before the
 * rule stay in the back office (which does not use this condition) and never
 * reach a public payload: QR order menu, POS item picker, website online menu.
 */
export function guestMenuItemCondition(): SQL {
  return and(eq(menuItems.isActive, true), isNotNull(menuItems.mediaId)) as SQL;
}

// ---------------------------------------------------------------- media

/**
 * Resolves a public URL for a menu photo. Storage is fused by the WS-00 bead;
 * until then (and in tests) the router can inject an `ObjectStorage` whose
 * `publicUrl` is used. With no provider the URL is null — the media id still
 * round-trips, so the screen keeps its data.
 */
export type MenuMediaUrls = (
  context: ScopedTenantContext,
  mediaIds: readonly string[],
) => Promise<Map<string, string>>;

export const noMediaUrls: MenuMediaUrls = async () => new Map();

export async function loadMediaUrls(
  tx: Tx,
  context: ScopedTenantContext,
  mediaIds: readonly string[],
  resolveMediaUrls: MenuMediaUrls,
): Promise<Map<string, string>> {
  const ids = [...new Set(mediaIds.filter((id) => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: coreStorageObjects.id })
    .from(coreStorageObjects)
    .where(
      and(
        eq(coreStorageObjects.tenantId, context.tenant.tenantId),
        inArray(coreStorageObjects.id, ids),
        eq(coreStorageObjects.purpose, "menu_photo"),
      ),
    );
  if (rows.length === 0) return new Map();
  return resolveMediaUrls(
    context,
    rows.map((row) => row.id),
  );
}
