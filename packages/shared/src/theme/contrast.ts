// WCAG 2.2 contrast checks for Design System Platform themes.
// PRD (Kebutuhan Non-Fungsional, Desain dan aksesibilitas): "Kontras warna
// setiap Tenant Theme diperiksa otomatis terhadap WCAG 2.2 AA; tema yang gagal
// tidak dapat diaktifkan."
//
// This file has no runtime imports on purpose: the root test suite
// (tests/design-system.test.mjs) loads it directly with Node type stripping.

import type {
  ColorMode,
  ColorPalette,
  ColorToken,
  TenantThemeConfig,
  ThemePalettes,
} from "./types";

/** WCAG 2.2 SC 1.4.3: normal text. */
export const AA_TEXT = 4.5;
/** WCAG 2.2 SC 1.4.11: UI component boundaries and focus indicators. */
export const AA_NON_TEXT = 3;

const HEX = /^#([0-9a-f]{6})$/i;

export function isHexColor(value: string): boolean {
  return HEX.test(value);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance (WCAG definition) of a #rrggbb color. */
export function relativeLuminance(hex: string): number {
  const match = HEX.exec(hex);
  if (!match) throw new Error(`Not a #rrggbb color: ${hex}`);
  const int = Number.parseInt(match[1]!, 16);
  const r = channel((int >> 16) & 0xff);
  const g = channel((int >> 8) & 0xff);
  const b = channel(int & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two #rrggbb colors, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastPair = {
  fg: ColorToken;
  bg: ColorToken;
  min: number;
  /** Where the pair appears, for readable failure messages. */
  use: string;
};

const STATUS = ["success", "warning", "danger", "info"] as const;

/**
 * Every foreground/background combination the component library renders.
 * Adding a component that puts a token on a new surface means adding its
 * pair here, so the check keeps covering what users actually see.
 */
export const REQUIRED_PAIRS: readonly ContrastPair[] = [
  { fg: "foreground", bg: "background", min: AA_TEXT, use: "body text" },
  { fg: "foreground", bg: "card", min: AA_TEXT, use: "text on cards" },
  { fg: "foreground", bg: "muted", min: AA_TEXT, use: "text on muted" },
  { fg: "foreground", bg: "secondary", min: AA_TEXT, use: "secondary button" },
  { fg: "foreground", bg: "accent", min: AA_TEXT, use: "hovered/selected row" },
  { fg: "muted-foreground", bg: "background", min: AA_TEXT, use: "hint text" },
  { fg: "muted-foreground", bg: "card", min: AA_TEXT, use: "hint on cards" },
  { fg: "muted-foreground", bg: "muted", min: AA_TEXT, use: "hint on muted" },
  {
    fg: "primary-foreground",
    bg: "primary",
    min: AA_TEXT,
    use: "primary button",
  },
  { fg: "primary", bg: "background", min: AA_TEXT, use: "link text" },
  { fg: "primary", bg: "card", min: AA_TEXT, use: "link on cards" },
  { fg: "brand-foreground", bg: "brand", min: AA_TEXT, use: "brand fill" },
  { fg: "foreground", bg: "brand-subtle", min: AA_TEXT, use: "brand tint" },
  { fg: "input", bg: "background", min: AA_NON_TEXT, use: "field border" },
  { fg: "input", bg: "card", min: AA_NON_TEXT, use: "field border on cards" },
  { fg: "ring", bg: "background", min: AA_NON_TEXT, use: "focus ring" },
  { fg: "ring", bg: "card", min: AA_NON_TEXT, use: "focus ring on cards" },
  ...STATUS.flatMap((s): ContrastPair[] => [
    { fg: `${s}-foreground`, bg: s, min: AA_TEXT, use: `${s} fill` },
    { fg: s, bg: "background", min: AA_TEXT, use: `${s} text` },
    { fg: s, bg: "card", min: AA_TEXT, use: `${s} text on cards` },
    { fg: s, bg: `${s}-subtle`, min: AA_TEXT, use: `${s} pill` },
    { fg: "foreground", bg: `${s}-subtle`, min: AA_TEXT, use: `${s} banner` },
  ]),
];

export type ContrastFailure = {
  mode: ColorMode;
  fg: ColorToken;
  bg: ColorToken;
  ratio: number;
  min: number;
  use: string;
};

export type ThemeCheck = {
  ok: boolean;
  failures: ContrastFailure[];
  /** Invalid or missing color values, reported before any ratio. */
  invalid: string[];
};

export function checkPalette(
  palette: ColorPalette,
  mode: ColorMode,
): Omit<ThemeCheck, "ok"> {
  const invalid: string[] = [];
  for (const [token, value] of Object.entries(palette))
    if (!isHexColor(value)) invalid.push(`${mode}.${token}: ${String(value)}`);
  const failures: ContrastFailure[] = [];
  if (invalid.length) return { failures, invalid };
  for (const pair of REQUIRED_PAIRS) {
    const ratio = contrastRatio(palette[pair.fg], palette[pair.bg]);
    if (ratio < pair.min) failures.push({ mode, ...pair, ratio });
  }
  return { failures, invalid };
}

export function checkPalettes(palettes: ThemePalettes): ThemeCheck {
  const light = checkPalette(palettes.light, "light");
  const dark = checkPalette(palettes.dark, "dark");
  const failures = [...light.failures, ...dark.failures];
  const invalid = [...light.invalid, ...dark.invalid];
  return {
    ok: failures.length === 0 && invalid.length === 0,
    failures,
    invalid,
  };
}

/** Base palettes with a tenant's overrides applied on top. */
export function mergeTenantPalettes(
  base: ThemePalettes,
  tenant: Pick<TenantThemeConfig, "colors">,
): ThemePalettes {
  return {
    light: { ...base.light, ...tenant.colors.light },
    dark: { ...base.dark, ...tenant.colors.dark },
  };
}

/**
 * Gate for activating a Tenant Theme. The merged result is checked in both
 * modes, so a tenant cannot pass by overriding only one side.
 */
export function checkTenantTheme(
  base: ThemePalettes,
  tenant: TenantThemeConfig,
): ThemeCheck {
  return checkPalettes(mergeTenantPalettes(base, tenant));
}

export function formatFailure(f: ContrastFailure): string {
  return `${f.mode}: ${f.fg} on ${f.bg} (${f.use}) is ${f.ratio.toFixed(2)}:1, needs ${f.min}:1`;
}
