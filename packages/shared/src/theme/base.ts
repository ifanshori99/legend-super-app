// Base Theme: the neutral platform theme every tenant starts from (PRD
// Kelompok A, "Base Theme"). These values are mirrored in
// apps/web/src/styles/tokens.css; tests/design-system.test.mjs fails when the
// two drift apart, so change both together.
//
// Type-only imports keep this file loadable by Node type stripping in tests.

import type {
  ColorPalette,
  ColorMode,
  ColorToken,
  ThemePalettes,
} from "./types";

const light: ColorPalette = {
  background: "#ffffff",
  foreground: "#1c1b19",
  card: "#ffffff",
  "surface-2": "#f7f6f4",
  "surface-3": "#f1efec",
  muted: "#f5f4f2",
  "muted-foreground": "#5f5b55",
  secondary: "#f0eeeb",
  accent: "#efedea",
  border: "#e3e0dc",
  input: "#8a857d",
  ring: "#1f5fbf",
  primary: "#0f5e68",
  "primary-foreground": "#ffffff",
  brand: "#3d3a35",
  "brand-foreground": "#ffffff",
  "brand-subtle": "#f3f1ee",
  success: "#18794e",
  "success-foreground": "#ffffff",
  "success-subtle": "#e9f5ee",
  warning: "#9a5b06",
  "warning-foreground": "#ffffff",
  "warning-subtle": "#fdf3e2",
  danger: "#b42318",
  "danger-foreground": "#ffffff",
  "danger-subtle": "#fdecea",
  info: "#1f5fbf",
  "info-foreground": "#ffffff",
  "info-subtle": "#eaf1fc",
};

const dark: ColorPalette = {
  background: "#0f0e0d",
  foreground: "#f3f1ee",
  card: "#1b1a18",
  "surface-2": "#161513",
  "surface-3": "#242220",
  muted: "#211f1d",
  "muted-foreground": "#aaa59d",
  secondary: "#2a2825",
  accent: "#2c2a27",
  border: "#2f2c29",
  input: "#7c776f",
  ring: "#7aaaf0",
  primary: "#5ec2cc",
  "primary-foreground": "#04262a",
  brand: "#d9d5cf",
  "brand-foreground": "#1c1b19",
  "brand-subtle": "#262421",
  success: "#4cc38a",
  "success-foreground": "#05251a",
  "success-subtle": "#132a1f",
  warning: "#eea64a",
  "warning-foreground": "#2a1803",
  "warning-subtle": "#2e2312",
  danger: "#f47b70",
  "danger-foreground": "#2b0805",
  "danger-subtle": "#341815",
  info: "#7aaaf0",
  "info-foreground": "#0a1a33",
  "info-subtle": "#15223a",
};

export const basePalettes: ThemePalettes = { light, dark };

/**
 * Kontras Tinggi (POS, KDS, expo, pickup, papan bilik) tightens the neutrals:
 * stronger lines and hint text in light; near-black "dark kitchen" in dark.
 */
export const kontrasOverrides: Record<
  ColorMode,
  Partial<Record<ColorToken, string>>
> = {
  light: {
    foreground: "#000000",
    "muted-foreground": "#3d3a35",
    border: "#8a857d",
    input: "#3d3a35",
  },
  dark: {
    background: "#000000",
    foreground: "#ffffff",
    card: "#121110",
    "surface-2": "#0b0a0a",
    "surface-3": "#1c1b19",
    muted: "#1c1b19",
    "muted-foreground": "#d0cbc3",
    secondary: "#23211f",
    accent: "#2a2825",
    border: "#5c5852",
    input: "#a8a39b",
  },
};

export function kontrasPalettes(
  base: ThemePalettes = basePalettes,
): ThemePalettes {
  return {
    light: { ...base.light, ...kontrasOverrides.light },
    dark: { ...base.dark, ...kontrasOverrides.dark },
  };
}
