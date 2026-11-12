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
  type Brand,
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
import { recordAudit, type AuditTransaction } from "./audit-writer.ts";
import { toOutlet } from "./org.service.ts";
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
