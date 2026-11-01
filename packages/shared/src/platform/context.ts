// Whitelabel brand context (PRD v1.7 §3 F4 "Whitelabel", D43, TEN-08; F46).
//
// The web server asks the API for the brand of the host the visitor used
// (`GET /api/tenant/context`) and renders SSR with it; the browser reads the
// same DTO. The answer carries tenant brand configuration only: TEN-08 says no
// platform name, logo or link may appear in customer or employee space, so the
// DTO has no platform-level field and no identifier beyond the tenant's own
// brand. `enabledModules` is the same TEN-05 flag set the API enforces, so a
// UI route guard hides exactly what the API refuses.

import { brandIdSchema, uuidSchema, z } from "../core/index.ts";
import { BRAND_FONTS, CORNER_STYLES } from "../theme/types.ts";
import { moduleKeySchema } from "./modules.ts";
import { themeTokensSchema } from "./themes.ts";

/** Active Tenant Theme summary for SSR (TEN-10 checked before activation). */
export const brandThemeSchema = z.strictObject({
  tokens: themeTokensSchema,
  fontFamily: z.enum(BRAND_FONTS),
  corners: z.enum(CORNER_STYLES),
});
export type BrandTheme = z.infer<typeof brandThemeSchema>;

export const brandContextSchema = z.strictObject({
  brand: z.strictObject({
    id: brandIdSchema,
    slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/),
    name: z.string().trim().min(1).max(150),
    logoMediaId: uuidSchema.nullable(),
  }),
  /** null until a Tenant Theme is active for the brand (base theme applies). */
  theme: brandThemeSchema.nullable(),
  /** Modules this tenant may use (TEN-05). Anything absent is off. */
  enabledModules: z.array(moduleKeySchema),
});
export type BrandContext = z.infer<typeof brandContextSchema>;
