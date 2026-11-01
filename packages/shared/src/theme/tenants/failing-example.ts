// Deliberately failing Tenant Theme: a pale primary under white text. Used by
// /design-system and tests to show that the WCAG 2.2 AA gate refuses it.
// Not a real tenant.

import type { TenantThemeConfig } from "../types";

export const failingThemeExample: TenantThemeConfig = {
  id: "contoh-gagal",
  name: "Contoh gagal",
  colors: { light: { primary: "#f4c95d", "primary-foreground": "#ffffff" } },
};
