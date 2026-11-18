// Wire DTOs and client inputs for roles, assignments and the approval matrix
// (PRD v1.7 §6 B roles / permissions / role_assignments / approval_policies).
// Requests are built with clientInputSchema: the tenant comes from the domain
// or token, never from the body (TEN-02).

import { z } from "zod";
import {
  businessDayCutoffSchema,
  clientInputSchema,
  cursorPageQuerySchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  timeZoneSchema,
  userIdSchema,
} from "../core/index.ts";
import {
  APPROVAL_MAX_LEVELS,
  approvalActionTypeSchema,
  approvalPolicySchema,
} from "./approval.ts";
import { roleIdSchema, stationIdSchema } from "./ids.ts";
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
 * GET /api/access/users (bead legend-i6ff): the staff directory the role
 * assignment picker reads. Staff only (a user with at least one role
 * assignment in the tenant); no email, phone, image or PIN data.
 */
export const ACCESS_USER_KINDS = ["staff"] as const;
export const ACCESS_USER_STATUSES = ["active", "inactive"] as const;

export const accessUserSchema = z.strictObject({
  userId: userIdSchema,
  displayName: z.string().trim().min(1).max(150),
  kind: z.enum(ACCESS_USER_KINDS),
  /** "active": not banned and holds an assignment valid now. */
  status: z.enum(ACCESS_USER_STATUSES),
});
export type AccessUser = z.infer<typeof accessUserSchema>;

export const listAccessUsersQuerySchema = cursorPageQuerySchema.extend({
  /** Name search, case-insensitive; `%` and `_` match themselves. */
  q: z.string().trim().max(100).optional(),
});
export type ListAccessUsersQuery = z.infer<typeof listAccessUsersQuerySchema>;

export const myOutletSchema = z.strictObject({
  id: outletIdSchema,
  name: z.string().min(1).max(150),
  timeZone: timeZoneSchema,
  /** Owner Q39: the business day starts here ("HH:mm"). */
  businessDayCutoff: businessDayCutoffSchema,
});
export type MyOutlet = z.infer<typeof myOutletSchema>;

/**
 * GET /api/me/access (bead legend-t4y7): the signed-in account's effective
 * permissions in the resolved tenant, plus `users.mfa_required` (§6 B) and
 * whether this session passed a second factor (AUTH-05). Presentation and
 * route-guard data only; the API authorizes every request again.
 *
 * `stations` (legend-fsb7) is the station reach of those assignments: the
 * stations the caller may work on for at least one permission they hold. A
 * station-scoped account gets only its own station(s), a wider scope every
 * station it reaches. The same list the API enforces with
 * `stationReachOf`, so a KDS client can avoid polling a board it may not read.
 */
export const myAccessViewSchema = z.strictObject({
  permissions: z.array(tenantPermissionCodeSchema),
  mfaRequired: z.boolean(),
  mfaVerified: z.boolean(),
  stations: z.array(stationIdSchema),
  /**
   * Outlets assigned to the caller (legend-ebt9f): reached through an active
   * tenant, brand, outlet or station assignment, never closed, sorted by name.
   * Empty for an account with no assignment. The web app builds the staff
   * outlet context and picker from it. Presentation only: every request is
   * authorized again against its own outlet.
   */
  outlets: z.array(myOutletSchema),
  /**
   * The outlet the outlet-less staff routes (/api/floor, zones, tables,
   * layout) work on (legend-6vgv): the outlet this session pinned with
   * PUT /api/me/active-outlet while it is still assigned, else the only
   * assigned outlet, else null (several outlets and no valid pin, or none
   * assigned). Always one of `outlets` or null. Presentation only: every
   * request is authorized again against its outlet.
   */
  activeOutletId: outletIdSchema.nullable(),
  /**
   * Set only while the request runs in a support session (a platform admin
   * impersonating a tenant user under an active support access grant); null
   * for every normal session. The web app uses it to show the notice and to
   * make the screens read-only. Presentation only: the API enforces the mode.
   */
  supportSession: z
    .strictObject({
      accessMode: z.enum(["read_only", "read_write"]),
      expiresAt: z.string(),
    })
    .nullable(),
  /**
   * True when the caller's assignments can ever pass PATCH
   * /employees/:id/manager: HR (`hr.employee.manage`) or a GM whose
   * `hr.attendance.manage` comes from a brand/tenant assignment. An outlet
   * manager or supervisor holds the permission but is always refused, so the
   * web hides "Ubah atasan" for them. Presentation only: the API checks again.
   * Defaults to false so an older server's view still parses.
   */
  canChangeEmployeeManager: z.boolean().default(false),
  /**
   * True when the caller holds `menu.item.manage` at tenant scope or at (or
   * through a brand over) some outlet, i.e. may rename, retype or delete a
   * kitchen station (PATCH name/type and DELETE /api/menu/stations/:id need
   * the outlet permission, legend-cot3). A grant held only at station scope
   * keeps target time and printer but gets false, so the web hides the name,
   * type and delete controls. Presentation only: the API checks again and
   * answers 403 PERMISSION_DENIED. Defaults to false so an older server's view
   * still parses (fail closed).
   */
  canManageStationConfig: z.boolean().default(false),
});
export type MyAccessView = z.infer<typeof myAccessViewSchema>;

/**
 * Pin the outlet for outlet-less staff routes (legend-6vgv). The tenant comes
 * from the domain or token (TEN-02), never from this body.
 */
export const setActiveOutletInputSchema = clientInputSchema({
  outletId: outletIdSchema,
});
export type SetActiveOutletInput = z.infer<typeof setActiveOutletInputSchema>;

export const activeOutletSchema = z.strictObject({
  activeOutletId: outletIdSchema,
});
export type ActiveOutlet = z.infer<typeof activeOutletSchema>;

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
