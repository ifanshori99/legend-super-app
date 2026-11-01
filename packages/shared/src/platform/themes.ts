// Tenant Theme (PRD v1.7 §3 F4 "Whitelabel", Kelompok A Design System
// Platform, §6 A `tenant_themes`, TEN-10). Reuses the theme contract in
// `packages/shared/src/theme` (token list, fonts, corners, WCAG check); this
// file adds the versioned row and its lifecycle.
//
// TEN-10: "Tenant Theme dengan kontras di bawah WCAG 2.2 AA tidak dapat
// diaktifkan". The check runs on the Base Theme merged with the tenant
// overrides in BOTH light and dark mode (`checkTenantTheme`), at activation
// time, on the server. `contrastCheckPassed` stored on the row is a cache
// for the editor, never trusted for activation.

import {
  brandIdSchema,
  clientInputSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  userIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { basePalettes } from "../theme/base.ts";
import {
  checkPalettes,
  isHexColor,
  mergeTenantPalettes,
} from "../theme/contrast.ts";
import type { ThemeCheck } from "../theme/contrast.ts";
import {
  BRAND_FONTS,
  CORNER_STYLES,
  TENANT_COLOR_TOKENS,
} from "../theme/types.ts";
import type {
  ColorMode,
  TenantColorToken,
  ThemePalettes,
} from "../theme/types.ts";
import { PlatformError } from "./errors.ts";
import { tenantThemeIdSchema } from "./ids.ts";
import type { TenantThemeId } from "./ids.ts";

const hex = z
  .string()
  .refine(isHexColor, "Expected #rrggbb")
  .transform((value) => value.toLowerCase());

/** Tenant overrides per mode; only TENANT_COLOR_TOKENS may be set. */
export const themeTokensSchema = z.strictObject({
  light: z.partialRecord(z.enum(TENANT_COLOR_TOKENS), hex),
  dark: z.partialRecord(z.enum(TENANT_COLOR_TOKENS), hex),
});
export type ThemeTokens = {
  light: Partial<Record<TenantColorToken, string>>;
  dark: Partial<Record<TenantColorToken, string>>;
};

export const themeStatusSchema = z.enum(["draft", "active", "archived"]);
export type ThemeStatus = z.infer<typeof themeStatusSchema>;

/** `tenant_themes` (T). One active version per brand. */
export const tenantThemeSchema = z
  .strictObject({
    id: tenantThemeIdSchema,
    tenantId: tenantIdSchema,
    brandId: brandIdSchema,
    version: z.number().int().positive(),
    tokens: themeTokensSchema,
    logoMediaId: uuidSchema.nullable(),
    fontFamily: z.enum(BRAND_FONTS),
    corners: z.enum(CORNER_STYLES),
    contrastCheckPassed: z.boolean(),
    status: themeStatusSchema,
    createdBy: userIdSchema,
    createdAt: isoDateTimeSchema,
    activatedAt: isoDateTimeSchema.nullable(),
  })
  .refine((theme) => theme.status !== "active" || theme.contrastCheckPassed, {
    path: ["contrastCheckPassed"],
    message: "An active theme must pass the contrast check (TEN-10)",
  })
  .refine(
    (theme) => (theme.status === "draft") === (theme.activatedAt === null),
    {
      path: ["activatedAt"],
      message: "Only drafts lack an activation time",
    },
  );
export type TenantTheme = z.infer<typeof tenantThemeSchema>;

/** Draft body; version and contrast result are server-computed. */
export const createThemeDraftInputSchema = clientInputSchema({
  brandId: brandIdSchema,
  tokens: themeTokensSchema,
  logoMediaId: uuidSchema.nullable().default(null),
  fontFamily: z.enum(BRAND_FONTS),
  corners: z.enum(CORNER_STYLES),
});
export type CreateThemeDraftInput = z.infer<typeof createThemeDraftInputSchema>;

/** Base Theme merged with the tenant overrides. */
export function mergedThemePalettes(tokens: ThemeTokens): ThemePalettes {
  return mergeTenantPalettes(basePalettes, {
    colors: tokens as Partial<
      Record<ColorMode, Partial<Record<TenantColorToken, string>>>
    >,
  });
}

/** TEN-10 contrast result for a token set (both modes). */
export function checkThemeTokens(tokens: ThemeTokens): ThemeCheck {
  return checkPalettes(mergedThemePalettes(tokens));
}

/**
 * Activates one draft version for its brand: the draft becomes `active`
 * (re-checked, never trusting the stored flag) and the brand's previous
 * active version becomes `archived`. Throws THEME_CONTRAST_FAILED (TEN-10)
 * or INVALID_TRANSITION. Returns new rows; inputs are not mutated.
 */
export function activateTheme(
  themes: readonly TenantTheme[],
  themeId: TenantThemeId,
  now: string,
): TenantTheme[] {
  const target = themes.find((theme) => theme.id === themeId);
  if (!target || target.status !== "draft")
    throw new PlatformError("INVALID_TRANSITION");
  const check = checkThemeTokens(target.tokens);
  if (!check.ok) throw new PlatformError("THEME_CONTRAST_FAILED");
  return themes.map((theme) => {
    if (theme.id === target.id)
      return {
        ...theme,
        status: "active",
        contrastCheckPassed: true,
        activatedAt: now,
      };
    if (
      theme.brandId === target.brandId &&
      theme.tenantId === target.tenantId &&
      theme.status === "active"
    )
      return { ...theme, status: "archived" };
    return theme;
  });
}
