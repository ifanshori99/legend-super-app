// Turns a Tenant Theme config object into the CSS variable layer that sits on
// top of the Base Theme. The layer is scoped to `[data-tenant="<id>"]`, so it
// works on <html> in production and on preview frames in /design-system.

import { basePalettes } from "./base";
import { checkTenantTheme, type ThemeCheck } from "./contrast";
import type {
  BrandFont,
  CornerStyle,
  TenantThemeConfig,
  ThemePalettes,
} from "./types";

const FONT_STACKS: Record<BrandFont, string> = {
  "plus-jakarta-sans": `"Plus Jakarta Sans Variable", "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif`,
  inter: `"Inter Variable", "Inter", ui-sans-serif, system-ui, sans-serif`,
};

/** Base unit of the radius scale; every radius token is a multiple of it. */
const RADIUS_UNIT: Record<CornerStyle, string> = {
  tegas: "2px",
  lembut: "4px",
  bulat: "6px",
};

const TENANT_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function declarations(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `  --${name}: ${value};`)
    .join("\n");
}

export type TenantThemeResult =
  | { ok: true; css: string; check: ThemeCheck }
  | { ok: false; css: null; check: ThemeCheck; reason: string };

/**
 * Builds the tenant layer, or refuses when the merged theme fails WCAG 2.2 AA
 * (PRD: a failing theme cannot be activated). Callers fall back to the Base
 * Theme on refusal.
 */
export function buildTenantThemeCss(
  tenant: TenantThemeConfig,
  base: ThemePalettes = basePalettes,
): TenantThemeResult {
  const check = checkTenantTheme(base, tenant);
  if (!TENANT_ID.test(tenant.id))
    return { ok: false, css: null, check, reason: "invalid tenant id" };
  if (!check.ok)
    return { ok: false, css: null, check, reason: "contrast check failed" };

  const sel = `[data-tenant="${tenant.id}"]`;
  const shared = declarations({
    "font-brand": tenant.font ? FONT_STACKS[tenant.font] : undefined,
    "radius-unit": tenant.corners ? RADIUS_UNIT[tenant.corners] : undefined,
  });
  const light = declarations(tenant.colors.light ?? {});
  const dark = declarations(tenant.colors.dark ?? {});

  // Selector groups mirror tokens.css: light by default, dark under `.dark`
  // or a `data-theme="dark"` island, and light islands inside dark pages.
  const css = [
    `${sel} {\n${shared}\n${light}\n}`,
    `.dark ${sel}, .dark${sel}, ${sel}[data-theme="dark"], ${sel} [data-theme="dark"] {\n${dark}\n}`,
    `${sel}[data-theme="light"], ${sel} [data-theme="light"] {\n${light}\n}`,
  ].join("\n");
  return { ok: true, css, check };
}
