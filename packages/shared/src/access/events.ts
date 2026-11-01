// Access-domain event payloads (naming `<aggregate>.<past_verb>`, ids ULID —
// docs/plan/contracts.md). The envelope (event id, tenant, actor, occurredAt)
// and the catalog registry belong to the WS-00 event contract (bead
// legend-m59); it registers ACCESS_EVENT_PAYLOADS when it lands. Every event
// here is also an audit-log entry (§3.7 Pemberian Role "tercatat di audit log").

import { z } from "zod";
import { isoDateTimeSchema, userIdSchema } from "../core/index.ts";
import { approvalActionTypeSchema, approvalPolicySchema } from "./approval.ts";
import { roleIdSchema, roleAssignmentIdSchema } from "./ids.ts";
import { tenantPermissionCodeSchema } from "./permissions.ts";
import { assignmentScopeSchema } from "./scope.ts";

export const roleCreatedPayloadSchema = z.strictObject({
  roleId: roleIdSchema,
  name: z.string(),
  isTemplate: z.boolean(),
  permissions: z.array(tenantPermissionCodeSchema),
  mfaRequired: z.boolean(),
});

export const roleUpdatedPayloadSchema = z.strictObject({
  roleId: roleIdSchema,
  addedPermissions: z.array(tenantPermissionCodeSchema),
  removedPermissions: z.array(tenantPermissionCodeSchema),
  mfaRequired: z.boolean(),
});

export const roleAssignmentGrantedPayloadSchema = z.strictObject({
  assignmentId: roleAssignmentIdSchema,
  userId: userIdSchema,
  roleId: roleIdSchema,
  scope: assignmentScopeSchema,
  validFrom: isoDateTimeSchema,
  validUntil: isoDateTimeSchema.nullable(),
  grantedBy: userIdSchema,
  /** When the grantor re-authenticated for this grant. */
  reauthenticatedAt: isoDateTimeSchema,
});

export const roleAssignmentEndedPayloadSchema = z.strictObject({
  assignmentId: roleAssignmentIdSchema,
  userId: userIdSchema,
  roleId: roleIdSchema,
  validUntil: isoDateTimeSchema,
  endedBy: userIdSchema,
  reason: z.string(),
});

export const approvalPolicyChangedPayloadSchema = z.strictObject({
  actionType: approvalActionTypeSchema,
  before: z.array(approvalPolicySchema),
  after: z.array(approvalPolicySchema),
});

export const ACCESS_EVENT_PAYLOADS = {
  "role.created": roleCreatedPayloadSchema,
  "role.updated": roleUpdatedPayloadSchema,
  "role_assignment.granted": roleAssignmentGrantedPayloadSchema,
  "role_assignment.ended": roleAssignmentEndedPayloadSchema,
  "approval_policy.changed": approvalPolicyChangedPayloadSchema,
} as const;
export type AccessEventType = keyof typeof ACCESS_EVENT_PAYLOADS;
export const ACCESS_EVENT_TYPES = Object.keys(
  ACCESS_EVENT_PAYLOADS,
) as AccessEventType[];

// Typed envelopes for the API (bead legend-4f9). `defineDomainEvent` binds each
// payload to its catalogued name/version, so a renamed event fails at import.
import { defineDomainEvent } from "../events/index.ts";

export const roleCreatedEvent = defineDomainEvent({
  name: "role.created",
  payload: roleCreatedPayloadSchema,
});
export const roleUpdatedEvent = defineDomainEvent({
  name: "role.updated",
  payload: roleUpdatedPayloadSchema,
});
export const roleAssignmentGrantedEvent = defineDomainEvent({
  name: "role_assignment.granted",
  payload: roleAssignmentGrantedPayloadSchema,
});
export const roleAssignmentEndedEvent = defineDomainEvent({
  name: "role_assignment.ended",
  payload: roleAssignmentEndedPayloadSchema,
});
export const approvalPolicyChangedEvent = defineDomainEvent({
  name: "approval_policy.changed",
  payload: approvalPolicyChangedPayloadSchema,
});
