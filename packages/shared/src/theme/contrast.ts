// WCAG 2.2 contrast checks for Design System Platform themes.
// PRD (Kebutuhan Non-Fungsional, Desain dan aksesibilitas): "Kontras warna
// setiap Tenant Theme diperiksa otomatis terhadap WCAG 2.2 AA; tema yang gagal
// tidak dapat diaktifkan."
//
// This file has no runtime imports on purpose: root tests load it directly
// with Node type stripping and no module resolution hook.

import type {
  ColorMode,
  ColorPalette,
  ColorToken,
  TenantThemeConfig,
  ThemePalettes,
} from "./types";

/**
 * Tokens derived from the palette, never set by hand or by a tenant
 * (owner decision 2026-11-02: the tint ramp follows the tenant primary, no
 * second accent token). Each is an sRGB mix `fg pct% + bg (100-pct)%`,
 * emitted in tokens.css as `color-mix(in srgb, …)` and computed the same way
 * in contrast.ts, so the gate checks exactly what renders.
 */
export const DERIVED_TOKENS = {
  "primary-hover": { from: "primary", pct: 88, into: "background" },
  "primary-tint": { from: "primary", pct: 10, into: "background" },
  "primary-tint-strong": { from: "primary", pct: 18, into: "background" },
  "chart-neutral": { from: "foreground", pct: 55, into: "background" },
  // v3 double-shell card: outer shell between canvas (surface-2) and card.
  shell: { from: "surface-2", pct: 55, into: "card" },
} as const satisfies Record<
  string,
  { from: ColorToken; pct: number; into: ColorToken }
>;

export type DerivedToken = keyof typeof DERIVED_TOKENS;

/** Any token the contrast gate can check: set or derived. */
export type ThemeToken = ColorToken | DerivedToken;

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

/**
 * sRGB mix `pct%` of `a` into `b`, matching CSS
 * `color-mix(in srgb, a pct%, b)` channel for channel.
 */
export function mixHex(a: string, b: string, pct: number): string {
  const ma = HEX.exec(a);
  const mb = HEX.exec(b);
  if (!ma || !mb) throw new Error(`Not a #rrggbb color: ${a} / ${b}`);
  const ia = Number.parseInt(ma[1]!, 16);
  const ib = Number.parseInt(mb[1]!, 16);
  const w = pct / 100;
  let out = "#";
  for (const shift of [16, 8, 0]) {
    const ca = (ia >> shift) & 0xff;
    const cb = (ib >> shift) & 0xff;
    out += Math.round(ca * w + cb * (1 - w))
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

export type FullPalette = Record<ThemeToken, string>;

/** A palette plus its derived tokens (tint ramp, chart neutral). */
export function derivePalette(palette: ColorPalette): FullPalette {
  const derived = {} as Record<DerivedToken, string>;
  for (const [token, rule] of Object.entries(DERIVED_TOKENS) as [
    DerivedToken,
    (typeof DERIVED_TOKENS)[DerivedToken],
  ][])
    derived[token] = mixHex(palette[rule.from], palette[rule.into], rule.pct);
  return { ...palette, ...derived };
}

export type ContrastPair = {
  fg: ThemeToken;
  bg: ThemeToken;
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
  // v2 surface ladder: bands (surface-2) and raised rows/panels (surface-3).
  { fg: "foreground", bg: "surface-2", min: AA_TEXT, use: "text on band" },
  { fg: "foreground", bg: "surface-3", min: AA_TEXT, use: "text on raised" },
  {
    fg: "muted-foreground",
    bg: "surface-2",
    min: AA_TEXT,
    use: "hint on band",
  },
  {
    fg: "muted-foreground",
    bg: "surface-3",
    min: AA_TEXT,
    use: "hint on raised",
  },
  { fg: "primary", bg: "surface-2", min: AA_TEXT, use: "link on band" },
  { fg: "input", bg: "surface-2", min: AA_NON_TEXT, use: "field on band" },
  // v2 tint ramp, derived from primary (DERIVED_TOKENS).
  {
    fg: "primary-foreground",
    bg: "primary-hover",
    min: AA_TEXT,
    use: "primary button hover",
  },
  {
    fg: "foreground",
    bg: "primary-tint",
    min: AA_TEXT,
    use: "text on accent tint",
  },
  {
    fg: "primary",
    bg: "primary-tint",
    min: AA_TEXT,
    use: "active nav / accent badge",
  },
  {
    fg: "muted-foreground",
    bg: "primary-tint",
    min: AA_TEXT,
    use: "hint on accent tint",
  },
  {
    fg: "foreground",
    bg: "primary-tint-strong",
    min: AA_TEXT,
    use: "text on strong tint",
  },
  {
    fg: "primary",
    bg: "primary-tint-strong",
    min: AA_TEXT,
    use: "accent label on strong tint",
  },
  // v3 double-shell card: labels and footers sit on the outer shell.
  { fg: "foreground", bg: "shell", min: AA_TEXT, use: "text on card shell" },
  {
    fg: "muted-foreground",
    bg: "shell",
    min: AA_TEXT,
    use: "hint on card shell",
  },
  { fg: "primary", bg: "shell", min: AA_TEXT, use: "link on card shell" },
  // Charts (WCAG 1.4.11 graphics): accent and neutral series vs the plot.
  {
    fg: "chart-neutral",
    bg: "card",
    min: AA_NON_TEXT,
    use: "neutral chart series",
  },
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
  fg: ThemeToken;
  bg: ThemeToken;
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
  const full = derivePalette(palette);
  for (const pair of REQUIRED_PAIRS) {
    const ratio = contrastRatio(full[pair.fg], full[pair.bg]);
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
