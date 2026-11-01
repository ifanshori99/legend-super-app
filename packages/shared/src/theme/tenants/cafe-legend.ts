// Tenant Theme: Cafe Legend — PLACEHOLDER until A1 brand assets arrive.
// PRD Kelompok A: Cafe Legend's theme is "diturunkan dari aset brand Legend
// (A1) dan diisi oleh Super Admin". No assets exist yet, so these are warm
// neutral stand-ins (roasted copper + toasted caramel) chosen to pass WCAG 2.2
// AA. They copy no other brand's identity. Replace every value once A1 lands;
// see themes/cafe-legend.md.
//
// In production this object comes from tenant configuration (D44: no
// tenant-specific code); it lives here only as the first fixture.

import type { TenantThemeConfig } from "../types";

export const cafeLegendTheme: TenantThemeConfig = {
  id: "cafe-legend",
  name: "Cafe Legend",
  placeholder: true,
  font: "plus-jakarta-sans",
  corners: "lembut",
  logoUrl: null,
  colors: {
    light: {
      primary: "#8a4423",
      "primary-foreground": "#ffffff",
      brand: "#6b4f2a",
      "brand-foreground": "#ffffff",
      "brand-subtle": "#f7efe4",
      muted: "#f7f3ee",
      secondary: "#f2ece4",
      accent: "#f1ebe3",
    },
    dark: {
      primary: "#e8a27a",
      "primary-foreground": "#2a1206",
      brand: "#d6b48a",
      "brand-foreground": "#241707",
      "brand-subtle": "#2a2119",
      muted: "#24201c",
      secondary: "#2c2621",
      accent: "#2e2823",
    },
  },
};
