// Edge people snapshot (design docs/design/hris-edge-replication.md 3.2).
// `GET /api/edge-sync/people-snapshot` ships the people an outlet needs to clock
// offline: a read-only projection. Unknown fields are discarded on receipt so
// newer cloud versions remain compatible and extra PII is not retained.
//
// - `users`: only id/name/banned/timestamps; `email` is `<id>@edge.invalid` and
//   `emailVerified` is false.
// - `role_assignments.assignedBy` is the assignee (the assigning admin is not shipped).
// - `employees`: userId non-null; no legal entity, position, org unit, manager,
//   PTKP or encrypted column.
// - `shift_assignments`: `shiftTemplateId` and `stationId` are always null.
// - QR day keys: 32 bytes, base64; the seed is never sent.
// The ETag (SHA-256 of the data sections) and `If-None-Match` carry the cache.

import {
  isoDateTimeSchema,
  tenantIdSchema,
  userIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { roleSchema } from "../access/schemas.ts";
import {
  assignmentScopeSchema,
  roleAssignmentSchema,
} from "../access/scope.ts";
import {
  attendancePolicySchema,
  attendanceSamplingConfigSchema,
} from "../hris/attendance.ts";
import { employeeShape } from "../hris/organization.ts";
import { shiftAssignmentIdSchema } from "../hris/ids.ts";
import {
  shiftAssignmentSegmentSchema,
  shiftAssignmentSourceSchema,
} from "../hris/scheduling.ts";

export const EDGE_PEOPLE_SNAPSHOT_PATH = "/api/edge-sync/people-snapshot";
export const EDGE_PEOPLE_SNAPSHOT_ETAG_HEADER = "ETag";
export const EDGE_PEOPLE_SNAPSHOT_IF_NONE_MATCH_HEADER = "If-None-Match";
/**
 * Generation time travels in this response header, never in the body: the
 * ETag hashes the data sections only (design 3.1), so a per-request value in
 * the body would defeat 304.
 */
export const EDGE_PEOPLE_SNAPSHOT_GENERATED_AT_HEADER =
  "X-Legend-Snapshot-Generated-At";

/** Domain of the placeholder email that replaces a real address on the edge. */
export const EDGE_PEOPLE_SNAPSHOT_EMAIL_DOMAIN = "edge.invalid";

export const EDGE_PEOPLE_SNAPSHOT_USER_KEYS = [
  "id",
  "name",
  "banned",
  "createdAt",
  "updatedAt",
  "email",
  "emailVerified",
] as const;

export const EDGE_PEOPLE_SNAPSHOT_EMPLOYEE_KEYS = [
  "id",
  "tenantId",
  "userId",
  "employeeNo",
  "fullName",
  "homeOutletId",
  "employmentType",
  "joinDate",
  "endDate",
  "status",
] as const;

export const EDGE_PEOPLE_SNAPSHOT_SHIFT_ASSIGNMENT_KEYS = [
  "id",
  "tenantId",
  "outletId",
  "employeeId",
  "shiftTemplateId",
  "stationId",
  "businessDate",
  "segments",
  "breakMinutes",
  "status",
  "source",
  "publishedAt",
  "createdBy",
] as const;

export const EDGE_PEOPLE_SNAPSHOT_ROLE_KEYS = [
  "id",
  "tenantId",
  "name",
  "isTemplate",
  "templateKey",
  "permissions",
  "mfaRequired",
  "allowedScopeTypes",
  "createdAt",
  "updatedAt",
] as const;

export const EDGE_PEOPLE_SNAPSHOT_ROLE_ASSIGNMENT_KEYS = [
  "id",
  "tenantId",
  "userId",
  "roleId",
  "scope",
  "validFrom",
  "validUntil",
  "assignedBy",
  "assignedAt",
] as const;

export const EDGE_PEOPLE_SNAPSHOT_ATTENDANCE_POLICY_KEYS = [
  "id",
  "tenantId",
  "outletId",
  "policy",
  "sampling",
  "updatedBy",
  "createdAt",
  "updatedAt",
] as const;

export const edgePeopleSnapshotUserSchema = z
  .object({
    id: userIdSchema,
    name: z.string().min(1).max(200),
    banned: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    email: z.string().max(100),
    emailVerified: z.literal(false),
  })
  .refine(
    (user) => user.email === `${user.id}@${EDGE_PEOPLE_SNAPSHOT_EMAIL_DOMAIN}`,
    {
      message: "The edge user email is the placeholder <id>@edge.invalid",
      path: ["email"],
    },
  );
export type EdgePeopleSnapshotUser = z.infer<
  typeof edgePeopleSnapshotUserSchema
>;

export const edgePeopleSnapshotRoleAssignmentSchema = roleAssignmentSchema
  .safeExtend({
    scope: z.discriminatedUnion("type", [
      assignmentScopeSchema.options[0].strip(),
      assignmentScopeSchema.options[1].strip(),
      assignmentScopeSchema.options[2].strip(),
      assignmentScopeSchema.options[3].strip(),
    ]),
  })
  .strip()
  .refine((row) => row.assignedBy === row.userId, {
    message: "On the edge assignedBy is the assignee",
    path: ["assignedBy"],
  })
  .refine((row) => row.scope.type !== "station", {
    message: "Station-scoped assignments are never sent to the edge (3.5)",
    path: ["scope"],
  });

export const edgePeopleSnapshotEmployeeSchema = z.object({
  id: employeeShape.id,
  tenantId: employeeShape.tenantId,
  userId: userIdSchema,
  employeeNo: employeeShape.employeeNo,
  fullName: employeeShape.fullName,
  homeOutletId: employeeShape.homeOutletId,
  employmentType: employeeShape.employmentType,
  joinDate: employeeShape.joinDate,
  endDate: employeeShape.endDate,
  /** Only `onboarding` and `active` employees are sent (design 3.2). */
  status: z.enum(["onboarding", "active"]),
});
export type EdgePeopleSnapshotEmployee = z.infer<
  typeof edgePeopleSnapshotEmployeeSchema
>;

export const edgePeopleSnapshotShiftAssignmentSchema = z.object({
  id: shiftAssignmentIdSchema,
  tenantId: tenantIdSchema,
  outletId: employeeShape.homeOutletId,
  employeeId: employeeShape.id,
  shiftTemplateId: z.null(),
  stationId: z.null(),
  businessDate: employeeShape.joinDate,
  segments: z.array(shiftAssignmentSegmentSchema.strip()).min(1).max(2),
  breakMinutes: z.number().int().min(0).max(240),
  /** Only `published` and `swapped` shifts are sent (design 3.2). */
  status: z.enum(["published", "swapped"]),
  source: shiftAssignmentSourceSchema,
  publishedAt: isoDateTimeSchema.nullable(),
  /** Opaque user id (no FK on the edge). */
  createdBy: z.string().min(1).max(100),
});

export const edgePeopleSnapshotAttendancePolicySchema = z.object({
  id: uuidSchema,
  tenantId: tenantIdSchema,
  outletId: employeeShape.homeOutletId.nullable(),
  policy: attendancePolicySchema.strip(),
  sampling: attendanceSamplingConfigSchema.strip(),
  updatedBy: z.string().min(1).max(100),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** Base64 of exactly 32 bytes: 43 canonical characters and one `=`. */
export const EDGE_QR_KEY_BASE64_PATTERN =
  /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

export const edgePeopleSnapshotQrKeySchema = z.object({
  dayIndex: z.number().int().nonnegative().safe(),
  key: z
    .string()
    .regex(EDGE_QR_KEY_BASE64_PATTERN, "A QR day key is base64 of 32 bytes"),
});

export const edgePeopleSnapshotSelfieSealKeySchema = z.object({
  kid: z.string().min(1).max(64),
  publicKeyPem: z
    .string()
    .min(1)
    .max(4096)
    .startsWith("-----BEGIN PUBLIC KEY-----"),
});

export const edgePeopleSnapshotSchema = z.object({
  users: z.array(edgePeopleSnapshotUserSchema),
  roles: z.array(roleSchema.strip()),
  roleAssignments: z.array(edgePeopleSnapshotRoleAssignmentSchema),
  employees: z.array(edgePeopleSnapshotEmployeeSchema),
  shiftAssignments: z.array(edgePeopleSnapshotShiftAssignmentSchema),
  attendancePolicies: z.array(edgePeopleSnapshotAttendancePolicySchema),
  qrKeys: z.array(edgePeopleSnapshotQrKeySchema),
  selfieSealKey: edgePeopleSnapshotSelfieSealKeySchema.nullable(),
});

/** Cloud-side output validation detects accidental disclosure of extra fields. */
export const edgePeopleSnapshotCloudSchema = z.strictObject({
  users: z.array(edgePeopleSnapshotUserSchema.strict()),
  roles: z.array(roleSchema),
  roleAssignments: z.array(
    edgePeopleSnapshotRoleAssignmentSchema
      .safeExtend({
        scope: assignmentScopeSchema,
      })
      .strict(),
  ),
  employees: z.array(edgePeopleSnapshotEmployeeSchema.strict()),
  shiftAssignments: z.array(
    edgePeopleSnapshotShiftAssignmentSchema
      .extend({ segments: z.array(shiftAssignmentSegmentSchema).min(1).max(2) })
      .strict(),
  ),
  attendancePolicies: z.array(
    edgePeopleSnapshotAttendancePolicySchema
      .extend({
        policy: attendancePolicySchema,
        sampling: attendanceSamplingConfigSchema,
      })
      .strict(),
  ),
  qrKeys: z.array(edgePeopleSnapshotQrKeySchema.strict()),
  selfieSealKey: edgePeopleSnapshotSelfieSealKeySchema.strict().nullable(),
});
export type EdgePeopleSnapshot = z.infer<typeof edgePeopleSnapshotSchema>;
