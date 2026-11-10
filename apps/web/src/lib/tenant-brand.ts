// Pure mapping from the API's brand context to the theme the root renders
// (legend-1v1g). No framework imports so the root contract test can load it.
import type { BrandContext } from "@starter/shared/platform";
import type { TenantThemeConfig } from "@starter/shared/theme";

/**
 * The host-resolved brand's active theme as a TenantThemeConfig, or null when
 * the brand has no active theme (or the host resolved no tenant): the Base
 * Theme then stays. The slug is the `data-tenant` value (D43 whitelabel).
 */
export function brandContextToThemeConfig(
  context: BrandContext | null,
): TenantThemeConfig | null {
  if (!context?.theme) return null;
  return {
    id: context.brand.slug,
    name: context.brand.name,
    colors: context.theme.tokens,
    font: context.theme.fontFamily,
    corners: context.theme.corners,
    logoUrl: null,
  };
}
