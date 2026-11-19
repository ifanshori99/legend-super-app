// Minimal tenant / brand / outlet references every module embeds. Split out of
// fixtures.ts so the light sample (./sample.ts) can use the schemas without
// building the order-line fixtures. Re-exported by ./fixtures.ts, so the
// `@starter/shared/core` barrel is unchanged.
import { z } from "zod";
import { brandIdSchema, outletIdSchema, tenantIdSchema } from "./ids.ts";
import {
  DEFAULT_BUSINESS_DAY_CUTOFF,
  businessDayCutoffSchema,
  timeZoneSchema,
} from "./time.ts";

export const tenantRefSchema = z.object({
  id: tenantIdSchema,
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  name: z.string().min(1).max(150),
});
export const brandRefSchema = z.object({
  id: brandIdSchema,
  tenantId: tenantIdSchema,
  slug: z.string().regex(/^[a-z0-9-]{2,60}$/),
  name: z.string().min(1).max(150),
});
export const outletRefSchema = z.object({
  id: outletIdSchema,
  tenantId: tenantIdSchema,
  brandId: brandIdSchema,
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(150),
  timeZone: timeZoneSchema,
  /** Owner Q39 business-day start; older producers omit it (default 04:00). */
  businessDayCutoff: businessDayCutoffSchema.default(
    DEFAULT_BUSINESS_DAY_CUTOFF,
  ),
  status: z.enum(["preopening", "active", "closed"]),
});
export type TenantRef = z.infer<typeof tenantRefSchema>;
export type BrandRef = z.infer<typeof brandRefSchema>;
export type OutletRef = z.infer<typeof outletRefSchema>;
