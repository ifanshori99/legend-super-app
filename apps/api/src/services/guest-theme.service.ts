// Tenant theme on the guest QR menu (legend-8qri, D43 / TEN-10): the brand's
// active Tenant Theme and its logo URL, so the table journey wears the
// tenant's colors, font, corners and logo. Read-only and public: it carries
// design tokens and a public logo URL, nothing else.

import { and, desc, eq } from "drizzle-orm";
import type { ObjectStorage } from "@starter/shared/adapters";
import {
  outletIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { qrMenuThemeSchema, type QrMenuTheme } from "@starter/shared/qr-order";
import { coreStorageObjects, tenantThemes } from "../db/schema";
import type { Tx } from "./menu-internals";

/**
 * Resolves the public URL of a brand logo inside the caller's transaction (no
 * second connection while it is held). A brand logo has no outlet
 * (`brand_logo` storage purpose); the outlet policy lets an outlet-scoped read
 * see such tenant-level rows, and the lookup filters the tenant itself. The
 * provider call uses a tenant-level scope built from the host's tenant.
 * Null when there is no provider, no such logo, or the provider refuses.
 */
export type BrandLogoUrl = (
  tx: Tx,
  context: ScopedTenantContext,
  mediaId: string,
) => Promise<string | null>;

export const noBrandLogoUrl: BrandLogoUrl = async () => null;

export function createBrandLogoUrl(
  storage: ObjectStorage | null,
): BrandLogoUrl {
  if (!storage) return noBrandLogoUrl;
  return async (tx, context, mediaId) => {
    const tenantContext = establishScopedTenantContext(context.tenant, {
      kind: "tenant",
    });
    const [row] = await tx
      .select({
        id: coreStorageObjects.id,
        outletId: coreStorageObjects.outletId,
        objectKey: coreStorageObjects.objectKey,
        purpose: coreStorageObjects.purpose,
      })
      .from(coreStorageObjects)
      .where(
        and(
          eq(coreStorageObjects.tenantId, context.tenant.tenantId),
          eq(coreStorageObjects.id, mediaId),
        ),
      )
      .limit(1);
    if (!row || row.purpose !== "brand_logo") return null;
    try {
      return await storage.publicUrl(tenantContext, {
        tenantId: context.tenant.tenantId,
        outletId: row.outletId ? outletIdSchema.parse(row.outletId) : null,
        reference: row.id,
        key: row.objectKey,
        visibility: "public",
      });
    } catch {
      return null;
    }
  };
}

/**
 * The brand's active theme in guest shape. The brand pin (`themeId`) wins; a
 * brand created before any activation falls back to the newest active version
 * of its own theme (same rule as the public brand context). Null when the
 * brand has no active theme, or its stored theme fails the guest contract:
 * the screen keeps the Base Theme.
 */
export async function readGuestTheme(
  tx: Tx,
  context: ScopedTenantContext,
  brand: { id: string; themeId: string | null },
  resolveLogoUrl: BrandLogoUrl,
): Promise<QrMenuTheme | null> {
  const tenantId: TenantId = context.tenant.tenantId;
  const where = brand.themeId
    ? and(
        eq(tenantThemes.tenantId, tenantId),
        eq(tenantThemes.id, brand.themeId),
        eq(tenantThemes.status, "active"),
      )
    : and(
        eq(tenantThemes.tenantId, tenantId),
        eq(tenantThemes.brandId, brand.id),
        eq(tenantThemes.status, "active"),
      );
  const [theme] = await tx
    .select()
    .from(tenantThemes)
    .where(where)
    .orderBy(desc(tenantThemes.version))
    .limit(1);
  if (!theme) return null;
  const parsed = qrMenuThemeSchema.safeParse({
    tokens: theme.tokens,
    fontFamily: theme.fontFamily,
    corners: theme.corners,
    logoUrl: theme.logoMediaId
      ? await resolveLogoUrl(tx, context, theme.logoMediaId)
      : null,
  });
  // A row the contract rejects (unknown font or corner style) keeps the Base
  // Theme instead of failing the whole menu.
  return parsed.success ? parsed.data : null;
}
