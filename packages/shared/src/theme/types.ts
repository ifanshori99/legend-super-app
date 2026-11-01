// Design System Platform types (PRD Kelompok A "Design System Platform", D42).
// Color tokens are named by role, never by value, so a Tenant Theme is a swap
// of values, not a rename. Every name here is a CSS custom property
// (`--<token>`) defined in apps/web/src/styles/tokens.css.

export const COLOR_TOKENS = [
  // Neutrals: page, surfaces, text, lines.
  "background",
  "foreground",
  "card",
  "muted",
  "muted-foreground",
  "secondary",
  "accent",
  "border",
  "input",
  "ring",
  // Brand: main action color and the tenant's supporting color.
  "primary",
  "primary-foreground",
  "brand",
  "brand-foreground",
  "brand-subtle",
  // Status: solid fill, text on the fill, and a tinted background.
  "success",
  "success-foreground",
  "success-subtle",
  "warning",
  "warning-foreground",
  "warning-subtle",
  "danger",
  "danger-foreground",
  "danger-subtle",
  "info",
  "info-foreground",
  "info-subtle",
] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

/** One full palette: a hex value (#rrggbb) per color token. */
export type ColorPalette = Record<ColorToken, string>;

export type ColorMode = "light" | "dark";

export type ThemePalettes = Record<ColorMode, ColorPalette>;

/**
 * Tokens a Tenant Theme may override (PRD: "warna utama dan pendukung").
 * Neutrals that carry the white-background default, status colors, and the
 * focus ring stay with the Base Theme so meaning stays the same across tenants.
 */
export const TENANT_COLOR_TOKENS = [
  "primary",
  "primary-foreground",
  "brand",
  "brand-foreground",
  "brand-subtle",
  "muted",
  "secondary",
  "accent",
] as const satisfies readonly ColorToken[];

export type TenantColorToken = (typeof TENANT_COLOR_TOKENS)[number];

/** Brand fonts a tenant may pick (PRD: "font dari daftar pilihan"). */
export const BRAND_FONTS = ["plus-jakarta-sans", "inter"] as const;
export type BrandFont = (typeof BRAND_FONTS)[number];

/** Corner style (PRD: "gaya sudut"). Scales the whole radius scale. */
export const CORNER_STYLES = ["tegas", "lembut", "bulat"] as const;
export type CornerStyle = (typeof CORNER_STYLES)[number];

export type TenantThemeConfig = {
  /** Stable slug, used as the `data-tenant` attribute value. */
  id: string;
  /** Display name shown in the tenant's own UI (whitelabel, D43). */
  name: string;
  /** True while the theme is a stand-in (e.g. Cafe Legend before A1 assets). */
  placeholder?: boolean;
  colors: Partial<Record<ColorMode, Partial<Record<TenantColorToken, string>>>>;
  font?: BrandFont;
  corners?: CornerStyle;
  /** Public URL of the tenant logo; null until brand assets exist. */
  logoUrl?: string | null;
};

/** Densities as data attribute values (PRD: tiga mode kepadatan). */
export const DENSITIES = ["hangat", "kontras", "padat"] as const;
export type Density = (typeof DENSITIES)[number];

export type ThemePreference = "light" | "dark" | "system";
