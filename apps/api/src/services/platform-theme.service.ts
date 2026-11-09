// Tenant Theme storage and activation (PRD v1.7 §3 F4 "Whitelabel", §6 A
// `tenant_themes`, TEN-10).
//
// TEN-10: a theme below WCAG 2.2 AA cannot be activated. The check re-runs on
// the server at activation time, on the Base Theme merged with the tenant
// tokens in BOTH light and dark mode; `contrast_check_passed` on the row is an
// editor cache and is never trusted. The contrast logic is the shared contract
// (`checkThemeTokens`), not a second implementation.
//
// Concurrency: draft creation and activation of one brand serialise on a
// transaction-level advisory lock, and the partial unique index
// `tenant_themes_active_brand_key` is the database backstop for "one active
// theme per brand".

import { and, desc, eq, sql } from "drizzle-orm";
import type { ApiErrorDetail, ScopedTenantContext } from "@starter/shared/core";
import { AccessError } from "@starter/shared/access";
import { createUlid } from "@starter/shared/core";
import {
  checkThemeTokens,
  tenantThemeSchema,
  type CreateThemeDraftInput,
  type TenantTheme,
  type ThemeTokens,
} from "@starter/shared/platform";
import { formatFailure } from "@starter/shared/theme";
import { db } from "../db/index.ts";
import { brands, tenantThemes } from "../db/schema/index.ts";
import { withTenant } from "../db/tenant.ts";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./core-audit.ts";
import { assertTenantMedia } from "./tenant-media.ts";

type ThemeRow = typeof tenantThemes.$inferSelect;
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** TEN-10: carries the failing pairs so the editor can show them. */
export class ThemeContrastError extends HttpError {
  constructor(readonly details: ApiErrorDetail[]) {
    super(
      422,
      "THEME_CONTRAST_FAILED",
      "Tema belum memenuhi kontras minimum WCAG 2.2 AA sehingga tidak dapat diaktifkan.",
    );
  }
}

function toTheme(row: ThemeRow): TenantTheme {
  return tenantThemeSchema.parse({
    id: row.id,
    tenantId: row.tenantId,
    brandId: row.brandId,
    version: row.version,
    tokens: row.tokens,
    logoMediaId: row.logoMediaId,
    fontFamily: row.fontFamily,
    corners: row.corners,
    contrastCheckPassed: row.contrastCheckPassed,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
  });
}

/** Themes are tenant configuration: only a tenant-wide scope may change them. */
function assertTenantWide(context: ScopedTenantContext): void {
  if (context.outletScope.kind !== "tenant")
    throw new AccessError(
      "PERMISSION_DENIED",
      "Your account cannot perform this action in this tenant.",
    );
}

/** Serialises writers of one brand's theme versions for this transaction. */
async function lockBrandThemes(tx: Tx, tenantId: string, brandId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant_themes:${tenantId}:${brandId}`}, 0))`,
  );
}

/**
 * Contrast preview for the editor (TEN-10). Pure: nothing is stored. Returned
 * as computed: failures may name derived tokens (e.g. primary-hover), which the
 * contract's `themeCheckResultSchema` enum (set tokens only) does not list.
 */
export function checkTheme(tokens: ThemeTokens) {
  return checkThemeTokens(tokens);
}

export async function listThemes(
  context: ScopedTenantContext,
  brandId: string,
): Promise<{ data: TenantTheme[] }> {
  assertTenantWide(context);
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select()
      .from(tenantThemes)
      .where(
        and(
          eq(tenantThemes.tenantId, context.tenant.tenantId),
          eq(tenantThemes.brandId, brandId),
        ),
      )
      .orderBy(desc(tenantThemes.version));
    return { data: rows.map(toTheme) };
  });
}

export async function createThemeDraft(
  context: ScopedTenantContext,
  input: CreateThemeDraftInput,
  actorUserId: string,
): Promise<TenantTheme> {
  assertTenantWide(context);
  const check = checkThemeTokens(input.tokens);
  return withTenant(db, context, async (tx) => {
    const tenantId = context.tenant.tenantId;
    const [brand] = await tx
      .select({ id: brands.id })
      .from(brands)
      .where(and(eq(brands.tenantId, tenantId), eq(brands.id, input.brandId)))
      .limit(1);
    if (!brand) throw new HttpError(404, "NOT_FOUND", "Brand not found.");
    // legend-iiqx (TEN-10): the logo must be in this tenant's media library.
    await assertTenantMedia(tx, tenantId, input.logoMediaId, "Logo");
    await lockBrandThemes(tx, tenantId, input.brandId);
    const [latest] = await tx
      .select({ version: tenantThemes.version })
      .from(tenantThemes)
      .where(
        and(
          eq(tenantThemes.tenantId, tenantId),
          eq(tenantThemes.brandId, input.brandId),
        ),
      )
      .orderBy(desc(tenantThemes.version))
      .limit(1);
    const [row] = await tx
      .insert(tenantThemes)
      .values({
        tenantId,
        brandId: input.brandId,
        version: (latest?.version ?? 0) + 1,
        tokens: input.tokens,
        logoMediaId: input.logoMediaId,
        fontFamily: input.fontFamily,
        corners: input.corners,
        contrastCheckPassed: check.ok,
        status: "draft",
        createdBy: actorUserId,
      })
      .returning();
    if (!row) throw new Error("Theme draft was not created");
    return toTheme(row);
  });
}

/**
 * TEN-10: activates a draft. Re-validates contrast (light AND dark) on the
 * server, archives the brand's previous active version and pins the brand to
 * the new theme, all in one transaction. Failing contrast throws
 * `ThemeContrastError` with the failures list and changes nothing.
 */
export async function activateTheme(
  context: ScopedTenantContext,
  themeId: string,
  actorUserId: string,
): Promise<TenantTheme> {
  assertTenantWide(context);
  const tenantId = context.tenant.tenantId;
  return withTenant(db, context, async (tx) => {
    const [found] = await tx
      .select({ brandId: tenantThemes.brandId })
      .from(tenantThemes)
      .where(
        and(eq(tenantThemes.tenantId, tenantId), eq(tenantThemes.id, themeId)),
      )
      .limit(1);
    if (!found) throw new HttpError(404, "NOT_FOUND", "Theme not found.");
    await lockBrandThemes(tx, tenantId, found.brandId);

    // Re-read under the lock: the status may have changed while we waited.
    const [target] = await tx
      .select()
      .from(tenantThemes)
      .where(
        and(eq(tenantThemes.tenantId, tenantId), eq(tenantThemes.id, themeId)),
      )
      .limit(1)
      .for("update");
    if (!target) throw new HttpError(404, "NOT_FOUND", "Theme not found.");
    if (target.status !== "draft")
      throw new HttpError(
        409,
        "INVALID_TRANSITION",
        "Perubahan status ini tidak diizinkan.",
      );

    const check = checkThemeTokens(target.tokens);
    if (!check.ok)
      throw new ThemeContrastError([
        ...check.failures.map((failure) => ({
          field: `${failure.mode}.${failure.fg}/${failure.bg}`,
          message: formatFailure(failure),
        })),
        ...check.invalid.map((entry) => ({
          field: entry.split(":")[0] ?? "tokens",
          message: `Invalid color value (${entry})`,
        })),
      ]);

    const [previous] = await tx
      .select()
      .from(tenantThemes)
      .where(
        and(
          eq(tenantThemes.tenantId, tenantId),
          eq(tenantThemes.brandId, target.brandId),
          eq(tenantThemes.status, "active"),
        ),
      )
      .limit(1)
      .for("update");
    // Archive first so the partial unique index never sees two active rows.
    if (previous)
      await tx
        .update(tenantThemes)
        .set({ status: "archived" })
        .where(
          and(
            eq(tenantThemes.tenantId, tenantId),
            eq(tenantThemes.id, previous.id),
          ),
        );
    const [row] = await tx
      .update(tenantThemes)
      .set({
        status: "active",
        contrastCheckPassed: true,
        activatedAt: new Date(),
      })
      .where(
        and(eq(tenantThemes.tenantId, tenantId), eq(tenantThemes.id, themeId)),
      )
      .returning();
    if (!row) throw new Error("Theme was not activated");
    await tx
      .update(brands)
      .set({ themeId: row.id })
      .where(and(eq(brands.tenantId, tenantId), eq(brands.id, row.brandId)));

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
        action: "tenant_theme.activated",
        objectType: "tenant_theme",
        objectId: row.id,
        reason: null,
        maskedChanges: {
          before: previous
            ? { themeId: previous.id, version: previous.version }
            : null,
          after: { themeId: row.id, version: row.version },
        },
        ipHash: null,
        sensitiveAccess: false,
        retentionClass: "audit_2y",
        createdAt: new Date().toISOString(),
      },
      ["themeId", "version"],
    );
    return toTheme(row);
  });
}
