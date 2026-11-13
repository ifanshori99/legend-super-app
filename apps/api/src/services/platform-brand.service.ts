// Whitelabel brand context for SSR (PRD v1.7 §3 F4 "Whitelabel", D43, TEN-08).
//
// The tenant comes from the request's host or device token (TEN-02), never
// from the request. Everything read here is tenant configuration: the brand
// row, its active Tenant Theme and the tenant's feature flags. The DTO carries
// no platform name, logo or link (TEN-08), and no field the UI could use to
// reach another tenant.
import { and, asc, desc, eq } from "drizzle-orm";
import { AccessError } from "@starter/shared/access";
import {
  createUlid,
  type ScopedTenantContext,
  type TenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import {
  brandContextSchema,
  brandLogoSchema,
  isModuleEnabled,
  MODULE_KEYS,
  type BrandContext,
  type BrandLogo,
  type SetBrandLogoInput,
} from "@starter/shared/platform";
import { db } from "../db";
import { brands, tenantThemes, tenants } from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error";
import { recordAudit } from "./core-audit";
import { getPublicTextOverrides } from "./text-override.service";
import { assertTenantMedia } from "./tenant-media";

/**
 * Brand of the tenant the request resolved to. When the source pins a brand
 * (a brand custom domain, a device token) that brand is used and a mismatch is
 * a 404 — never a silent fallback to a sibling brand. Without a pinned brand,
 * the tenant's oldest brand is the default.
 */
export async function getBrandContext(
  tenant: TenantContext,
): Promise<BrandContext> {
  const scoped = establishScopedTenantContext(tenant, { kind: "tenant" });
  const context = await withTenant(db, scoped, async (tx) => {
    const [tenantRow] = await tx
      .select({ featureFlags: tenants.featureFlags })
      .from(tenants)
      .where(eq(tenants.id, tenant.tenantId))
      .limit(1);
    const flags = tenantRow?.featureFlags ?? null;

    const brandsOfTenant = and(
      eq(brands.tenantId, tenant.tenantId),
      ...(tenant.brandId ? [eq(brands.id, tenant.brandId)] : []),
    );
    const [brand] = await tx
      .select()
      .from(brands)
      .where(brandsOfTenant)
      .orderBy(asc(brands.createdAt), asc(brands.id))
      .limit(1);
    if (!brand)
      throw new HttpError(
        404,
        "BRAND_NOT_FOUND",
        "This address has no brand yet.",
      );

    // The brand pin points at the active theme; a brand created before any
    // activation falls back to the newest active version of its own theme.
    const themeWhere = brand.themeId
      ? and(
          eq(tenantThemes.tenantId, tenant.tenantId),
          eq(tenantThemes.id, brand.themeId),
          eq(tenantThemes.status, "active"),
        )
      : and(
          eq(tenantThemes.tenantId, tenant.tenantId),
          eq(tenantThemes.brandId, brand.id),
          eq(tenantThemes.status, "active"),
        );
    const [theme] = await tx
      .select()
      .from(tenantThemes)
      .where(themeWhere)
      .orderBy(desc(tenantThemes.version))
      .limit(1);

    return {
      brand: {
        id: brand.id,
        slug: brand.slug,
        name: brand.name,
        logoMediaId: brand.logoMediaId,
      },
      theme: theme
        ? {
            tokens: theme.tokens,
            fontFamily: theme.fontFamily,
            corners: theme.corners,
          }
        : null,
      // Same gate as requireModuleEnabled: anything absent is off (TEN-05).
      enabledModules: MODULE_KEYS.filter((key) => isModuleEnabled(flags, key)),
    };
  });
  // Public `terms.*` overrides ride along so SSR makes one call, not two.
  return brandContextSchema.parse({
    ...context,
    textOverrides: await getPublicTextOverrides(tenant),
  });
}

/**
 * Attaches an uploaded `brand_logo` object to a brand (legend-bkdmc, TEN-10).
 * Only a tenant-wide scope may change brand configuration. The media must be in
 * this tenant's library (another tenant's id and an unknown id both answer 422),
 * and the brand must be this tenant's (404 otherwise). null clears the logo.
 */
export async function setBrandLogo(
  context: ScopedTenantContext,
  brandId: string,
  input: SetBrandLogoInput,
  actorUserId: string,
): Promise<BrandLogo> {
  if (context.outletScope.kind !== "tenant")
    throw new AccessError(
      "PERMISSION_DENIED",
      "Your account cannot perform this action in this tenant.",
    );
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [brand] = await tx
      .select({ id: brands.id, logoMediaId: brands.logoMediaId })
      .from(brands)
      .where(and(eq(brands.tenantId, tenantId), eq(brands.id, brandId)))
      .limit(1)
      .for("update");
    if (!brand) throw new HttpError(404, "NOT_FOUND", "Brand not found.");
    await assertTenantMedia(
      tx,
      tenantId,
      input.logoMediaId,
      "Logo",
      "brand_logo",
    );
    const [row] = await tx
      .update(brands)
      .set({ logoMediaId: input.logoMediaId })
      .where(and(eq(brands.tenantId, tenantId), eq(brands.id, brandId)))
      .returning({ id: brands.id, logoMediaId: brands.logoMediaId });
    if (!row) throw new Error("Brand logo was not saved");
    await recordAudit(
      tx,
      context,
      {
        id: createUlid(),
        tenantId,
        outletId: null,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "brand.logo_set",
        objectType: "brand",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: { logoMediaId: brand.logoMediaId },
          after: { logoMediaId: row.logoMediaId },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: new Date().toISOString(),
      },
      ["logoMediaId"],
    );
    return brandLogoSchema.parse({
      id: row.id,
      logoMediaId: row.logoMediaId,
    });
  });
}
