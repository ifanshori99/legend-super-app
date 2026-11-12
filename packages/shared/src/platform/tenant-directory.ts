// Platform-only tenant directory (legend-co93l). Email is masked before it
// leaves the API; these DTOs never carry identities, credentials or tokens.
import { roleAssignmentIdSchema } from "../access/ids.ts";
import { isoDateTimeSchema, userIdSchema, z } from "../core/index.ts";
import { tenantSchema } from "./org.ts";

export const tenantAccountSummarySchema = z.strictObject({
  userId: userIdSchema,
  name: z.string(),
  email: z.string().nullable(),
});
export type TenantAccountSummary = z.infer<typeof tenantAccountSummarySchema>;

export const tenantOwnerSummarySchema = tenantAccountSummarySchema.extend({
  assignmentId: roleAssignmentIdSchema,
  assignedAt: isoDateTimeSchema,
});
export type TenantOwnerSummary = z.infer<typeof tenantOwnerSummarySchema>;

export const searchTenantAccountsQuerySchema = z.strictObject({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchTenantAccountsQuery = z.infer<
  typeof searchTenantAccountsQuerySchema
>;

/** Detail reads include current assignments so a reload can replace Owner. */
export const platformTenantDetailSchema = tenantSchema.extend({
  owners: z.array(tenantOwnerSummarySchema).default([]),
});
export type PlatformTenantDetail = z.infer<typeof platformTenantDetailSchema>;
