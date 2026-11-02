// Wire DTOs and client inputs for roles, assignments and the approval matrix
// (PRD v1.7 §6 B roles / permissions / role_assignments / approval_policies).
// Requests are built with clientInputSchema: the tenant comes from the domain
// or token, never from the body (TEN-02).

import { z } from "zod";
import {
  clientInputSchema,
  cursorPageQuerySchema,
  idrSchema,
  isoDateTimeSchema,
  tenantIdSchema,
  userIdSchema,
} from "../core/index.ts";
import {
  APPROVAL_MAX_LEVELS,
  approvalActionTypeSchema,
  approvalPolicySchema,
} from "./approval.ts";
import { roleIdSchema } from "./ids.ts";
import { tenantPermissionCodeSchema } from "./permissions.ts";
import { ROLE_TEMPLATE_KEYS } from "./roles.ts";
import {
  assignmentScopeSchema,
  roleAssignmentSchema,
  scopeTypeSchema,
} from "./scope.ts";

export const roleTemplateKeySchema = z.enum(ROLE_TEMPLATE_KEYS);

/** One tenant `roles` row with its permission codes (§6 B). */
export const roleSchema = z.strictObject({
  id: roleIdSchema,
  tenantId: tenantIdSchema,
  name: z.string().trim().min(1).max(100),
  isTemplate: z.boolean(),
  /** Template the row was seeded from; null for a custom role. */
  templateKey: roleTemplateKeySchema.nullable(),
  permissions: z.array(tenantPermissionCodeSchema),
  mfaRequired: z.boolean(),
  allowedScopeTypes: z.array(scopeTypeSchema).min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Role = z.infer<typeof roleSchema>;

export const createCustomRoleSchema = clientInputSchema({
  name: z.string().trim().min(1).max(100),
  permissions: z.array(tenantPermissionCodeSchema).min(1).max(300),
  allowedScopeTypes: z.array(scopeTypeSchema).min(1),
  mfaRequired: z.boolean().optional(),
});
export type CreateCustomRoleInput = z.infer<typeof createCustomRoleSchema>;

export const updateCustomRoleSchema = clientInputSchema({
  name: z.string().trim().min(1).max(100).optional(),
  permissions: z.array(tenantPermissionCodeSchema).min(1).max(300).optional(),
  allowedScopeTypes: z.array(scopeTypeSchema).min(1).optional(),
  mfaRequired: z.boolean().optional(),
});
export type UpdateCustomRoleInput = z.infer<typeof updateCustomRoleSchema>;

/** Grant a role. The grantor is the session user; re-auth is checked server-side. */
export const grantRoleSchema = clientInputSchema({
  userId: userIdSchema,
  roleId: roleIdSchema,
  scope: assignmentScopeSchema,
  validFrom: isoDateTimeSchema.optional(),
  validUntil: isoDateTimeSchema.nullable().optional(),
}).refine(
  (input) =>
    !input.validFrom ||
    !input.validUntil ||
    Date.parse(input.validUntil) > Date.parse(input.validFrom),
  { message: "validUntil must be after validFrom", path: ["validUntil"] },
);
export type GrantRoleInput = z.infer<typeof grantRoleSchema>;

/** End an assignment now or at a later instant (sets valid_until). */
export const endRoleAssignmentSchema = clientInputSchema({
  validUntil: isoDateTimeSchema.optional(),
  reason: z.string().trim().min(3).max(500),
});
export type EndRoleAssignmentInput = z.infer<typeof endRoleAssignmentSchema>;

export const listRoleAssignmentsQuerySchema = cursorPageQuerySchema.extend({
  userId: userIdSchema.optional(),
  roleId: roleIdSchema.optional(),
  activeOnly: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});

export const roleAssignmentListItemSchema = roleAssignmentSchema;

/**
 * GET /api/me/access (bead legend-t4y7): the signed-in account's effective
 * permissions in the resolved tenant, plus `users.mfa_required` (§6 B) and
 * whether this session passed a second factor (AUTH-05). Presentation and
 * route-guard data only; the API authorizes every request again.
 */
export const myAccessViewSchema = z.strictObject({
  permissions: z.array(tenantPermissionCodeSchema),
  mfaRequired: z.boolean(),
  mfaVerified: z.boolean(),
});
export type MyAccessView = z.infer<typeof myAccessViewSchema>;

/** Upsert one matrix row. */
export const upsertApprovalPolicySchema = clientInputSchema({
  actionType: approvalActionTypeSchema,
  thresholdIdr: idrSchema
    .refine((value) => value >= 0, "thresholdIdr must be >= 0")
    .nullable(),
  approverRoleId: roleIdSchema,
  levels: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
});
export type UpsertApprovalPolicyInput = z.infer<
  typeof upsertApprovalPolicySchema
>;

export { approvalPolicySchema, roleAssignmentSchema };
