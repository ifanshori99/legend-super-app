// Pure rules of the Tenant Theme editor (PRD v1.7 §3 F4 "Whitelabel", Kelompok
// A Design System Platform; TEN-10: a theme below WCAG 2.2 AA cannot be
// activated). The same check the API runs on activation (`checkThemeTokens`,
// Base Theme merged with the overrides, light AND dark) drives the live
// preview and BLOCKS the save button here. The API stays the authority.
import {
  checkThemeTokens,
  type TenantTheme,
  type ThemeTokens,
} from "@starter/shared/platform";
import {
  BRAND_FONTS,
  CORNER_STYLES,
  TENANT_COLOR_TOKENS,
  basePalettes,
  contrastRatio,
  derivePalette,
  isHexColor,
  AA_NON_TEXT,
  AA_TEXT,
  type BrandFont,
  type ColorMode,
  type ContrastFailure,
  type CornerStyle,
  type TenantColorToken,
} from "@starter/shared/theme";

export { BRAND_FONTS, CORNER_STYLES, TENANT_COLOR_TOKENS };
export type { BrandFont, ColorMode, CornerStyle, TenantColorToken };

export type ThemeDraft = {
  tokens: ThemeTokens;
  fontFamily: BrandFont;
  corners: CornerStyle;
  logoMediaId: string | null;
};

export const BASE_THEME_DRAFT: ThemeDraft = {
  tokens: { light: {}, dark: {} },
  fontFamily: "plus-jakarta-sans",
  corners: "lembut",
  logoMediaId: null,
};

export function draftFromTheme(
  theme:
    | Pick<TenantTheme, "tokens" | "fontFamily" | "corners" | "logoMediaId">
    | null
    | undefined,
): ThemeDraft {
  if (!theme) return BASE_THEME_DRAFT;
  return {
    tokens: {
      light: { ...theme.tokens.light },
      dark: { ...theme.tokens.dark },
    },
    fontFamily: theme.fontFamily,
    corners: theme.corners,
    logoMediaId: theme.logoMediaId,
  };
}

/** "#ABC" / "0F5E68" become "#aabbcc" / "#0f5e68"; anything else is left alone. */
export function normalizeHex(raw: string): string {
  const text = raw.trim().toLowerCase();
  const body = text.startsWith("#") ? text.slice(1) : text;
  if (/^[0-9a-f]{3}$/.test(body))
    return `#${[...body].map((c) => c + c).join("")}`;
  if (/^[0-9a-f]{6}$/.test(body)) return `#${body}`;
  return raw.trim();
}

/** Sets (or, with an empty value, removes) one override. Pure. */
export function setOverride(
  draft: ThemeDraft,
  mode: ColorMode,
  token: TenantColorToken,
  value: string,
): ThemeDraft {
  const next = { ...draft.tokens[mode] };
  if (value.trim() === "") delete next[token];
  else next[token] = value.trim();
  return { ...draft, tokens: { ...draft.tokens, [mode]: next } };
}

/** Value shown in the editor: the override, else the Base Theme value. */
export function effectiveColor(
  draft: ThemeDraft,
  mode: ColorMode,
  token: TenantColorToken,
): string {
  return draft.tokens[mode][token] ?? basePalettes[mode][token];
}

export function isOverridden(
  draft: ThemeDraft,
  mode: ColorMode,
  token: TenantColorToken,
): boolean {
  return draft.tokens[mode][token] !== undefined;
}

export type ThemeEvaluation = {
  ok: boolean;
  failures: ContrastFailure[];
  /** Malformed color values, reported before any ratio. */
  invalid: string[];
  failuresByMode: Record<ColorMode, number>;
};

/** TEN-10 check on the merged theme, both modes. */
export function evaluateTheme(draft: ThemeDraft): ThemeEvaluation {
  const check = checkThemeTokens(draft.tokens);
  const failuresByMode: Record<ColorMode, number> = { light: 0, dark: 0 };
  for (const failure of check.failures) failuresByMode[failure.mode] += 1;
  return {
    ok: check.ok,
    failures: check.failures,
    invalid: check.invalid,
    failuresByMode,
  };
}

export function themeDirty(a: ThemeDraft, b: ThemeDraft): boolean {
  return JSON.stringify(canonical(a)) !== JSON.stringify(canonical(b));
}

function canonical(draft: ThemeDraft) {
  const sorted = (tokens: Partial<Record<string, string>>) =>
    Object.fromEntries(
      Object.entries(tokens).sort(([a], [b]) => a.localeCompare(b)),
    );
  return {
    light: sorted(draft.tokens.light),
    dark: sorted(draft.tokens.dark),
    fontFamily: draft.fontFamily,
    corners: draft.corners,
    logoMediaId: draft.logoMediaId,
  };
}

/** The save button's gate: only a passing, changed, idle draft may be saved. */
export function canSaveTheme(
  evaluation: ThemeEvaluation,
  state: { dirty: boolean; saving: boolean },
): boolean {
  return evaluation.ok && state.dirty && !state.saving;
}

export type HeadlinePair = {
  mode: ColorMode;
  id: "primaryButton" | "link" | "brandFill" | "brandTint";
  ratio: number | null;
  min: number;
  pass: boolean;
};

const HEADLINES: readonly {
  id: HeadlinePair["id"];
  fg: "primary-foreground" | "primary" | "brand-foreground" | "foreground";
  bg: "primary" | "background" | "brand" | "brand-subtle";
  min: number;
}[] = [
  {
    id: "primaryButton",
    fg: "primary-foreground",
    bg: "primary",
    min: AA_TEXT,
  },
  { id: "link", fg: "primary", bg: "background", min: AA_TEXT },
  { id: "brandFill", fg: "brand-foreground", bg: "brand", min: AA_TEXT },
  { id: "brandTint", fg: "foreground", bg: "brand-subtle", min: AA_TEXT },
];

/** The four contrast pairs a tenant most often breaks, per mode, for the summary. */
export function headlinePairs(draft: ThemeDraft): HeadlinePair[] {
  const out: HeadlinePair[] = [];
  for (const mode of ["light", "dark"] as const) {
    const palette = { ...basePalettes[mode], ...draft.tokens[mode] };
    for (const pair of HEADLINES) {
      const fg = palette[pair.fg];
      const bg = palette[pair.bg];
      const valid = isHexColor(fg) && isHexColor(bg);
      const ratio = valid ? contrastRatio(fg, bg) : null;
      out.push({
        mode,
        id: pair.id,
        ratio,
        min: pair.min,
        pass: ratio !== null && ratio >= pair.min,
      });
    }
  }
  return out;
}

export { AA_NON_TEXT, AA_TEXT };

const FONT_STACKS: Record<BrandFont, string> = {
  "plus-jakarta-sans": `"Plus Jakarta Sans Variable", "Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif`,
  inter: `"Inter Variable", "Inter", ui-sans-serif, system-ui, sans-serif`,
};
const RADIUS_UNIT: Record<CornerStyle, string> = {
  tegas: "2px",
  lembut: "4px",
  bulat: "6px",
};

/**
 * Inline custom properties for the preview island. Only well-formed #rrggbb
 * values are emitted, so a half-typed or hostile value can never become CSS.
 * Derived tokens (tint ramp, hover) are set explicitly because tokens.css
 * resolves them at :root and a nested override would not reach them.
 */
export function previewVars(
  draft: ThemeDraft,
  mode: ColorMode,
): Record<string, string> {
  const vars: Record<string, string> = {
    "--font-brand": FONT_STACKS[draft.fontFamily],
    "--radius-unit": RADIUS_UNIT[draft.corners],
  };
  const palette = { ...basePalettes[mode], ...draft.tokens[mode] };
  const allValid = Object.values(palette).every(isHexColor);
  for (const token of TENANT_COLOR_TOKENS) {
    const value = palette[token];
    if (isHexColor(value)) vars[`--${token}`] = value;
  }
  if (allValid) {
    const full = derivePalette(palette);
    for (const token of [
      "primary-hover",
      "primary-tint",
      "primary-tint-strong",
      "chart-neutral",
      "shell",
    ] as const)
      vars[`--${token}`] = full[token];
  }
  return vars;
}
