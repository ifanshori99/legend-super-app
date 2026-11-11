// Tenant organisation services (PRD v1.7 §3 F4 "Hierarki Organisasi", §6 A;
// TEN-02/03/06). Brands, legal entities, outlets and host names of ONE tenant.
//
// Every function takes the server-minted ScopedTenantContext and runs inside
// `withTenant`, so Postgres RLS applies (`app.tenant_id`) on top of the explicit
// tenant_id filters. The tenant is never read from a request body (TEN-02), and
// an outlet-scoped context only reaches its own outlets (TEN-03).
//
// Creating a brand/outlet here is how TEN-06 holds at the tenant level: the
// panel/tenant-admin API writes rows, no deploy.

import { randomBytes, randomUUID } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import {
  checkCountQuota,
  tenantUsageSchema,
  PlatformError,
  type Brand,
  type CreateBrandInput,
  type CreateLegalEntityInput,
  type CreateOutletInput,
  type FeatureFlags,
  type LegalEntity,
  type Outlet,
  type SetOutletStatusInput,
  type TenantDomain,
  type TenantLimits,
  type TenantUsage,
  type UpdateBrandInput,
  type UpdateLegalEntityInput,
  type UpdateOutletInput,
  type AddDomainInput,
} from "@starter/shared/platform";
import {
  brandSchema,
  legalEntitySchema,
  outletRestoreStatusSchema,
  outletSchema,
  canTransitionOutlet,
  isReservedHostname,
} from "@starter/shared/platform";
import {
  assertOutletInScope,
  createUlid,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { db } from "../db";
import {
  brands,
  itemAvailability,
  legalEntities,
  menuItems,
  outlets,
  tenantDomains,
  tenants,
} from "../db/schema";
import { withTenant } from "../db/tenant";
import { provisionStandardChart } from "./accounting-provisioning.service";
import { recordAudit } from "./core-audit";
import { markHppStale } from "./hpp-invalidate";
import {
  provisionOutletStockLocations,
  provisionStandardUoms,
} from "./inventory-provisioning.service";
import { toTenantDomain } from "./org-resolve.service";
import { provisionDefaultServiceChargeRule } from "./tax-provisioning.service";
import { env } from "../config/env";
import { HttpError } from "../lib/http-error";
import { assertTenantMedia } from "./tenant-media";
import { blindIndex, sealSecret } from "../lib/secrets";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** PostgreSQL unique violation, directly or wrapped by drizzle's cause chain. */
function uniqueViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" || uniqueViolation(candidate.cause, depth + 1)
  );
}

/** Unique violation of one named constraint or index. */
function uniqueViolationOn(
  error: unknown,
  constraint: string,
  depth = 0,
): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: unknown;
  };
  return (
    (candidate.code === "23505" && candidate.constraint === constraint) ||
    uniqueViolationOn(candidate.cause, constraint, depth + 1)
  );
}

type DomainRow = typeof tenantDomains.$inferSelect;

function primaryHostname(
  brandId: string,
  domains: Pick<DomainRow, "brandId" | "hostname" | "kind" | "verifiedAt">[],
): string | null {
  const own = domains.filter((domain) => domain.brandId === brandId);
  return (
    own.find((domain) => domain.kind === "platform_subdomain")?.hostname ??
    own.find((domain) => domain.verifiedAt !== null)?.hostname ??
    null
  );
}

function toBrand(
  row: typeof brands.$inferSelect,
  domains: Pick<DomainRow, "brandId" | "hostname" | "kind" | "verifiedAt">[],
): Brand {
  return brandSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    logoMediaId: row.logoMediaId,
    themeId: row.themeId,
    primaryHostname: primaryHostname(row.id, domains),
    createdAt: row.createdAt.toISOString(),
  });
}

export function toOutlet(row: typeof outlets.$inferSelect): Outlet {
  return outletSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    brandId: row.brandId,
    legalEntityId: row.legalEntityId,
    code: row.code,
    name: row.name,
    address: row.address,
    regionId: row.regionId,
    geofence: row.geofence,
    timeZone: row.timezone,
    businessDayCutoff: row.businessDayCutoff,
    openingHours: row.openingHours,
    edgeNodeId: row.edgeNodeId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });
}

function toLegalEntity(row: typeof legalEntities.$inferSelect): LegalEntity {
  return legalEntitySchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    npwpLast4: row.npwpLast4,
    isPkp: row.isPkp,
    address: row.address,
    // Bank accounts are the accounting contract's rows keyed by this entity
    // (WS-07 bead); until that table exists a new entity has none.
    bankAccountIds: [],
    createdAt: row.createdAt.toISOString(),
  });
}

/** Explicit tenant filter on top of RLS: tenant_domains is readable for host
 * resolution and must never leak another tenant's rows into a list (TEN-01). */
async function domainsOfTenant(
  tx: Tx,
  tenantId: string,
): Promise<(typeof tenantDomains.$inferSelect)[]> {
  return tx
    .select()
    .from(tenantDomains)
    .where(eq(tenantDomains.tenantId, tenantId));
}

async function tenantLimits(tx: Tx, tenantId: string): Promise<TenantLimits> {
  const [row] = await tx
    .select({ limits: tenants.limits })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  return row.limits;
}

async function requireBrand(tx: Tx, brandId: string) {
  const [row] = await tx
    .select({ id: brands.id })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Brand not found.");
  return row;
}

async function requireLegalEntity(tx: Tx, legalEntityId: string) {
  const [row] = await tx
    .select({ id: legalEntities.id })
    .from(legalEntities)
    .where(eq(legalEntities.id, legalEntityId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Legal entity not found.");
  return row;
}

// ------------------------------------------------------------------- brands

export async function listBrands(
  context: ScopedTenantContext,
): Promise<{ data: Brand[] }> {
  return withTenant(db, context, async (tx) => {
    const [rows, domains] = await Promise.all([
      tx.select().from(brands).orderBy(asc(brands.name), asc(brands.id)),
      domainsOfTenant(tx, context.tenant.tenantId),
    ]);
    return { data: rows.map((row) => toBrand(row, domains)) };
  });
}

export async function createBrand(
  context: ScopedTenantContext,
  input: CreateBrandInput,
): Promise<Brand> {
  return withTenant(db, context, async (tx) => {
    // legend-ja7i7 (TEN-10): the logo must be in this tenant's media library.
    await assertTenantMedia(
      tx,
      context.tenant.tenantId,
      input.logoMediaId,
      "Logo",
    );
    try {
      const [row] = await tx
        .insert(brands)
        .values({
          tenantId: context.tenant.tenantId,
          slug: input.slug,
          name: input.name,
          logoMediaId: input.logoMediaId,
        })
        .returning();
      return toBrand(row, []);
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(409, "CONFLICT", "That brand slug is taken.");
      throw error;
    }
  });
}

export async function updateBrand(
  context: ScopedTenantContext,
  brandId: string,
  input: UpdateBrandInput,
): Promise<Brand> {
  return withTenant(db, context, async (tx) => {
    // legend-ja7i7 (TEN-10): same rule as createBrand; null clears the logo.
    await assertTenantMedia(
      tx,
      context.tenant.tenantId,
      input.logoMediaId,
      "Logo",
    );
    const changes = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.logoMediaId === undefined
        ? {}
        : { logoMediaId: input.logoMediaId }),
    };
    const domains = await domainsOfTenant(tx, context.tenant.tenantId);
    // An empty patch is a read: return the current row instead of an UPDATE
    // with no columns, which Postgres rejects.
    if (Object.keys(changes).length === 0) {
      const [current] = await tx
        .select()
        .from(brands)
        .where(eq(brands.id, brandId))
        .limit(1);
      if (!current) throw new HttpError(404, "NOT_FOUND", "Brand not found.");
      return toBrand(current, domains);
    }
    const [row] = await tx
      .update(brands)
      .set(changes)
      .where(eq(brands.id, brandId))
      .returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "Brand not found.");
    return toBrand(row, domains);
  });
}

// ------------------------------------------------------------ legal entities

export async function listLegalEntities(
  context: ScopedTenantContext,
): Promise<{ data: LegalEntity[] }> {
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(legalEntities)
      .orderBy(asc(legalEntities.name), asc(legalEntities.id));
    return { data: rows.map(toLegalEntity) };
  });
}

function npwpColumns(tenantId: string, npwp: string | null) {
  if (npwp === null)
    return { npwpEncrypted: null, npwpLast4: null, npwpHash: null };
  return {
    npwpEncrypted: sealSecret(npwp, `legal_entity:${tenantId}`),
    npwpLast4: npwp.slice(-4),
    npwpHash: blindIndex(npwp, `legal_entity-npwp:${tenantId}`),
  };
}

export async function createLegalEntity(
  context: ScopedTenantContext,
  input: CreateLegalEntityInput,
): Promise<LegalEntity> {
  const id = randomUUID();
  return withTenant(db, context, async (tx) => {
    let inserted: typeof legalEntities.$inferSelect;
    try {
      const [row] = await tx
        .insert(legalEntities)
        .values({
          id,
          tenantId: context.tenant.tenantId,
          name: input.name,
          ...npwpColumns(context.tenant.tenantId, input.npwp),
          isPkp: input.isPkp,
          address: input.address,
        })
        .returning();
      inserted = row;
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(
          409,
          "CONFLICT",
          "That NPWP is already registered for another legal entity.",
        );
      throw error;
    }
    // Outside the NPWP catch, same transaction: a provisioning failure rolls
    // the entity back instead of being read as a duplicate NPWP (PRD v1.7
    // §3.19, legend-a7x7).
    await provisionStandardChart(tx, context, inserted.id, null);
    return toLegalEntity(inserted);
  });
}

export async function updateLegalEntity(
  context: ScopedTenantContext,
  legalEntityId: string,
  input: UpdateLegalEntityInput,
): Promise<LegalEntity> {
  return withTenant(db, context, async (tx) => {
    const changes = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.npwp === undefined
        ? {}
        : npwpColumns(context.tenant.tenantId, input.npwp)),
      ...(input.isPkp === undefined ? {} : { isPkp: input.isPkp }),
      ...(input.address === undefined ? {} : { address: input.address }),
    };
    if (Object.keys(changes).length === 0) {
      const [current] = await tx
        .select()
        .from(legalEntities)
        .where(eq(legalEntities.id, legalEntityId))
        .limit(1);
      if (!current)
        throw new HttpError(404, "NOT_FOUND", "Legal entity not found.");
      return toLegalEntity(current);
    }
    try {
      const [row] = await tx
        .update(legalEntities)
        .set(changes)
        .where(eq(legalEntities.id, legalEntityId))
        .returning();
      if (!row)
        throw new HttpError(404, "NOT_FOUND", "Legal entity not found.");
      return toLegalEntity(row);
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(
          409,
          "CONFLICT",
          "That NPWP is already registered for another legal entity.",
        );
      throw error;
    }
  });
}

// ------------------------------------------------------------------ outlets

function outletScopeFilter(context: ScopedTenantContext): SQL | undefined {
  return context.outletScope.kind === "tenant"
    ? undefined
    : inArray(outlets.id, context.outletScope.outletIds);
}

export async function listOutlets(
  context: ScopedTenantContext,
  query: { limit: number; cursor?: string; brandId?: string },
): Promise<{
  data: Outlet[];
  meta: { limit: number; nextCursor: string | null };
}> {
  return withTenant(db, context, async (tx) => {
    const filters: SQL[] = [];
    const scope = outletScopeFilter(context);
    if (scope) filters.push(scope);
    if (query.brandId) filters.push(eq(outlets.brandId, query.brandId));
    if (query.cursor) {
      const [code, id] = decodeCursor(query.cursor);
      if (typeof code !== "string" || typeof id !== "string")
        throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
      const cursorFilter = or(
        gt(outlets.code, code),
        and(eq(outlets.code, code), gt(outlets.id, id)),
      );
      if (cursorFilter) filters.push(cursorFilter);
    }
    const rows = await tx
      .select()
      .from(outlets)
      .where(and(...filters))
      .orderBy(asc(outlets.code), asc(outlets.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      data: page.map(toOutlet),
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

/** The outlet being changed must be inside the caller's outlet scope (TEN-03). */
function assertOutletWritable(
  context: ScopedTenantContext,
  outletId: string,
): void {
  if (context.outletScope.kind === "tenant") return;
  assertOutletInScope(context.outletScope, outletId);
}

export async function createOutlet(
  context: ScopedTenantContext,
  input: CreateOutletInput,
  actorUserId: string | null = null,
): Promise<Outlet> {
  return withTenant(db, context, async (tx) => {
    await requireBrand(tx, input.brandId);
    await requireLegalEntity(tx, input.legalEntityId);
    let inserted: typeof outlets.$inferSelect;
    const [count] = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(outlets);
    const limits = await tenantLimits(tx, context.tenant.tenantId);
    // Only the outlet count is needed here; employee/device/AI usage comes
    // with their own tables (WS-10, WS-02, WS-12).
    const usage: TenantUsage = tenantUsageSchema.parse({
      month: new Date().toISOString().slice(0, 7),
      outlets: count?.value ?? 0,
      activeEmployees: 0,
      devices: 0,
      aiRequests: 0,
      whatsappCostIdr: 0,
      aiCostIdr: 0,
      emailCostIdr: 0,
    });
    if (!checkCountQuota(limits, usage, "outlets").allowed)
      throw new PlatformError("QUOTA_EXCEEDED");
    try {
      const [row] = await tx
        .insert(outlets)
        .values({
          tenantId: context.tenant.tenantId,
          brandId: input.brandId,
          legalEntityId: input.legalEntityId,
          code: input.code,
          name: input.name,
          address: input.address,
          regionId: input.regionId,
          geofence: input.geofence,
          timezone: input.timeZone,
          businessDayCutoff: input.businessDayCutoff,
          openingHours: input.openingHours,
        })
        .returning();
      inserted = row;
      // legend-2nb9: a new outlet starts with an availability row for every
      // existing item of its brand, so its 86 screen lists them on day one
      // (the item-create path seeds only the outlets that exist then).
      const items = await tx
        .select({ id: menuItems.id })
        .from(menuItems)
        .where(
          and(
            eq(menuItems.tenantId, context.tenant.tenantId),
            eq(menuItems.brandId, input.brandId),
            isNull(menuItems.deletedAt),
          ),
        );
      if (items.length > 0) {
        const now = new Date();
        await tx
          .insert(itemAvailability)
          .values(
            items.map((item) => ({
              tenantId: context.tenant.tenantId,
              outletId: row.id,
              menuItemId: item.id,
              schedule: [],
              status: "available" as const,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .onConflictDoNothing();
      }
    } catch (error) {
      if (uniqueViolation(error))
        throw new HttpError(409, "CONFLICT", "That outlet code is taken.");
      throw error;
    }
    // Same transaction (PRD v1.7 §3.19, §16 Lokasi Stok, legend-4ryw): older
    // tenants without UOMs get them here too; both calls are idempotent.
    await provisionStandardUoms(tx, context, null);
    await provisionOutletStockLocations(tx, context, inserted.id, null);
    // A new outlet has no menu_costs rows yet: the next job tick rebuilds it.
    await markHppStale(tx, {
      tenantId: context.tenant.tenantId,
      outletId: inserted.id,
    });
    // Default 5% dine-in service charge for this outlet only (legend-2qz7, Q25).
    const actor = userIdSchema.safeParse(actorUserId);
    await provisionDefaultServiceChargeRule(
      tx,
      context,
      actor.success ? actor.data : null,
      outletIdSchema.parse(inserted.id),
    );
    return toOutlet(inserted);
  });
}

export async function updateOutlet(
  context: ScopedTenantContext,
  outletId: string,
  input: UpdateOutletInput,
  actorUserId: string,
): Promise<Outlet> {
  assertOutletWritable(context, outletId);
  return withTenant(db, context, async (tx) => {
    if (input.legalEntityId !== undefined)
      await requireLegalEntity(tx, input.legalEntityId);
    const changes = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.legalEntityId === undefined
        ? {}
        : { legalEntityId: input.legalEntityId }),
      ...(input.address === undefined ? {} : { address: input.address }),
      ...(input.regionId === undefined ? {} : { regionId: input.regionId }),
      ...(input.geofence === undefined ? {} : { geofence: input.geofence }),
      ...(input.businessDayCutoff === undefined
        ? {}
        : { businessDayCutoff: input.businessDayCutoff }),
      ...(input.openingHours === undefined
        ? {}
        : { openingHours: input.openingHours }),
    };
    if (Object.keys(changes).length === 0) {
      const [current] = await tx
        .select()
        .from(outlets)
        .where(eq(outlets.id, outletId))
        .limit(1);
      if (!current) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
      return toOutlet(current);
    }
    const [before] = await tx
      .select({ businessDayCutoff: outlets.businessDayCutoff })
      .from(outlets)
      .where(eq(outlets.id, outletId))
      .limit(1)
      .for("update");
    if (!before) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
    const [row] = await tx
      .update(outlets)
      .set(changes)
      .where(eq(outlets.id, outletId))
      .returning();
    if (!row) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
    // Owner Q39: moving the cutoff moves which business date future trade
    // lands on (daily limits, tax and sales reports), so the change is audited.
    if (before.businessDayCutoff !== row.businessDayCutoff)
      await recordAudit(
        tx,
        context,
        {
          id: createUlid(),
          tenantId: context.tenant.tenantId,
          outletId: row.id,
          actorType: "user",
          actorId: actorUserId,
          deviceId: null,
          action: "outlet.business_day_cutoff.updated",
          objectType: "outlet",
          objectId: row.id,
          reason: null,
          maskedChanges: {
            before: { businessDayCutoff: before.businessDayCutoff },
            after: { businessDayCutoff: row.businessDayCutoff },
          },
          ipHash: null,
          sensitiveAccess: false,
          retentionClass: "audit_2y",
          createdAt: new Date().toISOString(),
        },
        ["businessDayCutoff"],
      );
    return toOutlet(row);
  });
}

export async function setOutletStatus(
  context: ScopedTenantContext,
  outletId: string,
  input: SetOutletStatusInput,
): Promise<Outlet> {
  assertOutletWritable(context, outletId);
  return withTenant(db, context, async (tx) => {
    const [current] = await tx
      .select()
      .from(outlets)
      .where(eq(outlets.id, outletId))
      .limit(1)
      .for("update");
    if (!current) throw new HttpError(404, "NOT_FOUND", "Outlet not found.");
    if (current.status === input.status) return toOutlet(current);
    if (!canTransitionOutlet(current.status, input.status))
      throw new PlatformError("INVALID_TRANSITION");
    // Q40 (legend-umzos): closing starts the 30-day platform restore window.
    const closing =
      input.status === "closed"
        ? {
            closedAt: new Date(),
            statusBeforeClose: outletRestoreStatusSchema.parse(current.status),
          }
        : {};
    const [row] = await tx
      .update(outlets)
      .set({ status: input.status, ...closing })
      .where(eq(outlets.id, outletId))
      .returning();
    return toOutlet(row);
  });
}

// ------------------------------------------------------------------ domains

export async function listDomains(
  context: ScopedTenantContext,
): Promise<{ data: TenantDomain[] }> {
  return withTenant(db, context, async (tx) => {
    const rows = await domainsOfTenant(tx, context.tenant.tenantId);
    return {
      data: rows
        .sort((a, b) => a.hostname.localeCompare(b.hostname))
        .map(toTenantDomain),
    };
  });
}

export async function addDomain(
  context: ScopedTenantContext,
  input: AddDomainInput,
): Promise<TenantDomain> {
  if (isReservedHostname(input.hostname, env.reservedDomains))
    throw new PlatformError("DOMAIN_RESERVED");
  return withTenant(db, context, async (tx) => {
    await requireBrand(tx, input.brandId);
    try {
      const [row] = await tx
        .insert(tenantDomains)
        .values({
          tenantId: context.tenant.tenantId,
          brandId: input.brandId,
          hostname: input.hostname,
          kind: "custom",
          verificationToken: randomBytes(32).toString("hex"),
        })
        .returning();
      return toTenantDomain(row);
    } catch (error) {
      if (uniqueViolationOn(error, "tenant_domains_tenant_hostname_key"))
        throw new PlatformError("DOMAIN_TAKEN");
      throw error;
    }
  });
}

/** Reads the TXT records at a name; each record is its chunk list. */
export type DomainTxtResolver = (name: string) => Promise<string[][]>;

let txtResolver: DomainTxtResolver = resolveTxt;

/** Test seam: replace the DNS lookup; `null` restores the real resolver. */
export function setDomainTxtResolver(resolver: DomainTxtResolver | null): void {
  txtResolver = resolver ?? resolveTxt;
}

/** True when a TXT record at the verification name carries the exact value.
 * Any lookup failure (ENODATA, ENOTFOUND, ESERVFAIL, timeout) is "not proven". */
async function txtProvesOwnership(record: {
  name: string;
  value: string;
}): Promise<boolean> {
  try {
    const records = await txtResolver(record.name);
    return records.some((chunks) => chunks.join("") === record.value);
  } catch {
    return false;
  }
}

export async function verifyDomain(
  context: ScopedTenantContext,
  domainId: string,
): Promise<TenantDomain> {
  // Reads through the caller's own transaction, so the race path below never
  // asks the pool for a second connection while holding one.
  const loadIn = async (tx: Tx) => {
    const [row] = await tx
      .select()
      .from(tenantDomains)
      .where(
        and(
          eq(tenantDomains.id, domainId),
          eq(tenantDomains.tenantId, context.tenant.tenantId),
        ),
      )
      .limit(1);
    if (!row) throw new HttpError(404, "NOT_FOUND", "Domain not found.");
    return row;
  };
  const current = await withTenant(db, context, loadIn);
  if (current.verifiedAt !== null) return toTenantDomain(current);
  const record = toTenantDomain(current).verification;
  // The lookup runs outside the transaction: DNS can be slow.
  if (record === null || !(await txtProvesOwnership(record)))
    throw new PlatformError("DOMAIN_VERIFICATION_FAILED");
  return withTenant(db, context, async (tx) => {
    try {
      const [row] = await tx
        .update(tenantDomains)
        .set({ verifiedAt: sql`now()` })
        .where(
          and(
            eq(tenantDomains.id, domainId),
            eq(tenantDomains.tenantId, context.tenant.tenantId),
            isNull(tenantDomains.verifiedAt),
          ),
        )
        .returning();
      // Verified by a concurrent request in the meantime: return it as is.
      return toTenantDomain(row ?? (await loadIn(tx)));
    } catch (error) {
      if (uniqueViolationOn(error, "tenant_domains_verified_hostname_key"))
        throw new PlatformError("DOMAIN_TAKEN");
      throw error;
    }
  });
}

export async function removeDomain(
  context: ScopedTenantContext,
  domainId: string,
): Promise<void> {
  await withTenant(db, context, async (tx) => {
    const [row] = await tx
      .delete(tenantDomains)
      .where(
        and(
          eq(tenantDomains.id, domainId),
          eq(tenantDomains.tenantId, context.tenant.tenantId),
        ),
      )
      .returning({ id: tenantDomains.id });
    if (!row) throw new HttpError(404, "NOT_FOUND", "Domain not found.");
  });
}

/** Tenant feature flags for the panel's module list (read-only). */
export async function getFeatureFlags(
  context: ScopedTenantContext,
): Promise<FeatureFlags> {
  const [row] = await db
    .select({ featureFlags: tenants.featureFlags })
    .from(tenants)
    .where(eq(tenants.id, context.tenant.tenantId))
    .limit(1);
  if (!row) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
  return row.featureFlags;
}
