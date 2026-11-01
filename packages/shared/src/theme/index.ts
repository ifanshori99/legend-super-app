// Design System Platform theme contract (PRD Kelompok A, D42). Shared by the
// web app (rendering), future Super Admin theme editor, and tests.

export * from "./types";
export * from "./contrast";
export { basePalettes, kontrasOverrides, kontrasPalettes } from "./base";
export { buildTenantThemeCss, type TenantThemeResult } from "./css";
export { cafeLegendTheme } from "./tenants/cafe-legend";
export { failingThemeExample } from "./tenants/failing-example";

/** localStorage key for the persisted light/dark/system preference. */
export const THEME_STORAGE_KEY = "legend-theme";
