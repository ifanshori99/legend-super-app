// Platform Super Admin appoints or replaces a tenant Owner (legend-ktc4d,
// founder decision Q44). Tenant actors still grant Owner only through
// assertCanGrantRole (legend-7vsby); this is the platform path that gives a
// new tenant its first Owner. Needs fresh MFA and a reason; always audited.

import { tenantIdSchema, userIdSchema, z } from "../core/index.ts";
import { roleAssignmentIdSchema, roleIdSchema } from "../access/ids.ts";
import { tenantFirstAdminSchema } from "./org.ts";

const reasonSchema = z.string().trim().min(1).max(500);

/** Account to appoint: an existing tenant member, or a person to invite
 * (same fields as `createTenantInputSchema.firstAdmin`). */
export const tenantOwnerAccountSchema = z.union([
  z.strictObject({ userId: userIdSchema }),
  z.strictObject({ invite: tenantFirstAdminSchema }),
]);
export type TenantOwnerAccount = z.infer<typeof tenantOwnerAccountSchema>;

/** `mfaCode` is optional here: a missing code is answered 403 by the
 * service (like support access), not 422. */
export const assignTenantOwnerInputSchema = z.strictObject({
  account: tenantOwnerAccountSchema,
  reason: reasonSchema,
  mfaCode: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type AssignTenantOwnerInput = z.infer<
  typeof assignTenantOwnerInputSchema
>;

/** The assignment being replaced is the `:assignmentId` path parameter. */
export const replaceTenantOwnerInputSchema = assignTenantOwnerInputSchema;
export type ReplaceTenantOwnerInput = AssignTenantOwnerInput;

export const tenantOwnerAssignmentIdSchema = roleAssignmentIdSchema;

export const TENANT_OWNER_ACCOUNT_KINDS = [
  "member",
  "reused",
  "invited",
] as const;

export const tenantOwnerAssignmentSchema = z.strictObject({
  tenantId: tenantIdSchema,
  assignmentId: roleAssignmentIdSchema,
  userId: userIdSchema,
  roleId: roleIdSchema,
  account: z.enum(TENANT_OWNER_ACCOUNT_KINDS),
  replacedAssignmentId: roleAssignmentIdSchema.nullable(),
});
export type TenantOwnerAssignment = z.infer<typeof tenantOwnerAssignmentSchema>;
