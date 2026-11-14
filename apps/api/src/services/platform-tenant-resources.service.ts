// U5a / legend-utnll: minimum organisation metadata for the platform tenant
// panel. Each read is scoped explicitly, runs under RLS and commits its audit
// before data can leave the service. Private legal addresses and bank details
// require tenant support access and are excluded from this read model.
import { and, asc, eq, gt, or, type SQL } from "drizzle-orm";
import {
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  type CursorPage,
  type CursorPageQuery,
} from "@starter/shared/core";
import {
  brandSchema,
  legalEntitySchema,
  PlatformError,
  type Brand,
  type CreateBrandInput,
  type CreateLegalEntityInput,
  type CreateOutletInput,
  type LegalEntity,
  type Outlet,
} from "@starter/shared/platform";
import { db } from "../db/index.ts";
import {
  brands,
  legalEntities,
  outlets,
  tenantDomains,
  tenants,
} from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { lockLoyaltyJournalEntity } from "./accounting-auto-journal-amounts.ts";
import { recordAudit, type AuditTransaction } from "./audit-writer.ts";
import {
  createBrandInTx,
  createLegalEntityInTx,
  createOutletInTx,
  toOutlet,
} from "./org.service.ts";
import { platformTenantScope } from "./platform-org.service.ts";
import { isPlatformAdmin } from "./platform-support.service.ts";

/** Registry standing is checked again for service callers, before tenant IO. */
async function readTenantResourceAny<T extends { data: unknown[] }>(
  tenantId: string,
  actorUserId: string,
  action: string,
  read: (tx: AuditTransaction) => Promise<T>,
): Promise<T> {
  if (!(await isPlatformAdmin(actorUserId)))
    throw new HttpError(403, "FORBIDDEN", "Akun ini bukan Super Admin.");
  const context = platformTenantScope(tenantId);
  return withTenant(db, context, async (tx) => {
    const [tenant] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
    const result = await read(tx);
    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action,
        objectType: "tenant",
        objectId: tenantId,
        reason: "Membaca metadata organisasi tenant melalui panel platform.",
        before: null,
        after: { count: result.data.length },
        sensitiveAccess: true,
      },
      { tx, context },
    );
    return result;
  });
}

/**
 * Platform create: registry standing is checked before the transaction opens.
 * Inside it, the tenant row is share-locked (`FOR SHARE`), must exist and must
 * not be archived; then the write and its audit row share that transaction.
 * `after` carries ids and non-private labels only. The advisory
 * `loyalty-entity` lock is taken before the tenant row lock: that order must
 * match the loyalty/accounting paths (the other way round can deadlock with
 * them), and it serializes every platform org create (brand, outlet, legal
 * entity) with loyalty-entity changes. The FK inserts hold a KEY SHARE on the
 * tenant row until commit, which would otherwise contend with the
 * first-outlet loyalty guard's time-bounded FOR UPDATE lock and potentially
 * cause LOYALTY_ENTITY_BUSY.
 * Advisory xact locks are re-entrant, so createOutletInTx may re-take it.
 */
async function createTenantResourceAny<T>(
  tenantId: string,
  actorUserId: string,
  audit: {
    action: string;
    objectType: string;
    reason: string;
    objectId: (created: T) => string;
    after: (created: T) => Record<string, unknown>;
  },
  create: (
    tx: Parameters<Parameters<typeof withTenant>[2]>[0],
    context: ReturnType<typeof platformTenantScope>,
  ) => Promise<T>,
): Promise<{ data: T }> {
  if (!(await isPlatformAdmin(actorUserId)))
    throw new HttpError(403, "FORBIDDEN", "Akun ini bukan Super Admin.");
  const context = platformTenantScope(tenantId);
  return withTenant(db, context, async (tx) => {
    await lockLoyaltyJournalEntity(tx, context.tenant.tenantId);
    const [tenant] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1)
      .for("share");
    if (!tenant) throw new HttpError(404, "NOT_FOUND", "Tenant not found.");
    if (tenant.status === "archived")
      throw new PlatformError(
        "INVALID_TRANSITION",
        "Pulihkan tenant terlebih dahulu sebelum menambah data organisasi.",
      );
    const created = await create(tx, context);
    await recordAudit(
      {
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: audit.action,
        objectType: audit.objectType,
        objectId: audit.objectId(created),
        reason: audit.reason,
        before: null,
        after: audit.after(created),
        sensitiveAccess: true,
      },
      { tx, context },
    );
    return { data: created };
  });
}

export async function createPlatformTenantBrandAny(
  tenantId: string,
  actorUserId: string,
  input: CreateBrandInput,
): Promise<{ data: Brand }> {
  return createTenantResourceAny<Brand>(
    tenantId,
    actorUserId,
    {
      action: "brand.created",
      objectType: "brand",
      reason: "Super Admin membuat brand untuk tenant melalui panel platform.",
      objectId: (brand) => brand.id,
      after: (brand) => ({ id: brand.id, slug: brand.slug, name: brand.name }),
    },
    (tx, context) => createBrandInTx(tx, context, input),
  );
}

export async function createPlatformTenantOutletAny(
  tenantId: string,
  actorUserId: string,
  input: CreateOutletInput,
): Promise<{ data: Outlet }> {
  return createTenantResourceAny<Outlet>(
    tenantId,
    actorUserId,
    {
      action: "outlet.created",
      objectType: "outlet",
      reason: "Super Admin membuat outlet untuk tenant melalui panel platform.",
      objectId: (outlet) => outlet.id,
      after: (outlet) => ({
        id: outlet.id,
        brandId: outlet.brandId,
        legalEntityId: outlet.legalEntityId,
        code: outlet.code,
        name: outlet.name,
      }),
    },
    (tx, context) => createOutletInTx(tx, context, input, actorUserId),
  );
}

export async function createPlatformTenantLegalEntityAny(
  tenantId: string,
  actorUserId: string,
  input: CreateLegalEntityInput,
): Promise<{ data: LegalEntity }> {
  return createTenantResourceAny<LegalEntity>(
    tenantId,
    actorUserId,
    {
      action: "legal_entity.created",
      objectType: "legal_entity",
      reason:
        "Super Admin membuat badan usaha untuk tenant melalui panel platform.",
      objectId: (entity) => entity.id,
      // No NPWP and no address: only the id, name and PKP flag are recorded.
      after: (entity) => ({
        id: entity.id,
        name: entity.name,
        isPkp: entity.isPkp,
      }),
    },
    (tx, context) => createLegalEntityInTx(tx, context, input),
  );
}

export async function listPlatformTenantBrandsAny(
  tenantId: string,
  actorUserId: string,
): Promise<{ data: Brand[] }> {
  return readTenantResourceAny(
    tenantId,
    actorUserId,
    "platform.tenant_brands.read",
    async (tx) => {
      const rows = await tx
        .select()
        .from(brands)
        .where(eq(brands.tenantId, tenantId))
        .orderBy(asc(brands.name), asc(brands.id));
      // Domains are globally readable for host resolution, so they require
      // the explicit tenant filter even inside an RLS transaction. Exclude
      // verification tokens from the projection entirely.
      const domains = await tx
        .select({
          brandId: tenantDomains.brandId,
          hostname: tenantDomains.hostname,
          kind: tenantDomains.kind,
          verifiedAt: tenantDomains.verifiedAt,
        })
        .from(tenantDomains)
        .where(eq(tenantDomains.tenantId, tenantId))
        .orderBy(asc(tenantDomains.createdAt), asc(tenantDomains.id));
      return {
        data: rows.map((row) => {
          const ownDomains = domains.filter(
            (domain) => domain.brandId === row.id,
          );
          return brandSchema.parse({
            id: row.id,
            tenantId: row.tenantId,
            slug: row.slug,
            name: row.name,
            logoMediaId: row.logoMediaId,
            themeId: row.themeId,
            primaryHostname:
              ownDomains.find((domain) => domain.kind === "platform_subdomain")
                ?.hostname ??
              ownDomains.find((domain) => domain.verifiedAt !== null)
                ?.hostname ??
              null,
            createdAt: row.createdAt.toISOString(),
          });
        }),
      };
    },
  );
}

export async function listPlatformTenantOutletsAny(
  tenantId: string,
  actorUserId: string,
  query: CursorPageQuery & { brandId?: string },
): Promise<CursorPage<Outlet>> {
  return readTenantResourceAny(
    tenantId,
    actorUserId,
    "platform.tenant_outlets.read",
    async (tx) => {
      const filters: SQL[] = [eq(outlets.tenantId, tenantId)];
      if (query.brandId) filters.push(eq(outlets.brandId, query.brandId));
      if (query.cursor) {
        const [code, id] = parseOutletCursor(query.cursor);
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
    },
  );
}

function parseOutletCursor(cursor: string): [string, string] {
  try {
    const keys = decodeCursor(cursor);
    const [code, id] = keys;
    if (
      keys.length === 2 &&
      typeof code === "string" &&
      /^[A-Z0-9][A-Z0-9-]{0,19}$/.test(code) &&
      typeof id === "string" &&
      outletIdSchema.safeParse(id).success
    )
      return [code, id];
  } catch {
    // Both malformed base64/JSON and invalid sort keys are client errors.
  }
  throw new HttpError(422, "VALIDATION_ERROR", "Check the cursor.");
}

export async function listPlatformTenantLegalEntitiesAny(
  tenantId: string,
  actorUserId: string,
): Promise<{ data: LegalEntity[] }> {
  return readTenantResourceAny(
    tenantId,
    actorUserId,
    "platform.tenant_legal_entities.read",
    async (tx) => {
      // Read only the allowlist: no address (which can be a home), sealed NPWP,
      // blind index, bank data or ledger internals enter this read model.
      const rows = await tx
        .select({
          id: legalEntities.id,
          tenantId: legalEntities.tenantId,
          name: legalEntities.name,
          npwpLast4: legalEntities.npwpLast4,
          isPkp: legalEntities.isPkp,
          createdAt: legalEntities.createdAt,
        })
        .from(legalEntities)
        .where(eq(legalEntities.tenantId, tenantId))
        .orderBy(asc(legalEntities.name), asc(legalEntities.id));
      return {
        data: rows.map((row) =>
          legalEntitySchema.parse({
            ...row,
            address: null,
            bankAccountIds: [],
            createdAt: row.createdAt.toISOString(),
          }),
        ),
      };
    },
  );
}
