// Core audit writer (bead legend-vbws/legend-wt33; PRD v1.7 §3.7 "Pemberian
// Role ... tercatat di audit log", §6 B audit_logs).
//
// Maps the RBAC audit port's AuditEntry to the audit contract's AuditEvent and
// appends it with `core-audit.recordAudit` on the caller's tenant transaction,
// so the change and its audit row commit (or roll back) together and RLS keeps
// the row inside the tenant. Field values are masked by default: only the
// allow-listed keys below keep their value; role names and anything unknown
// become [REDACTED].
//
// `maskAuditChanges` must run before the event is parsed: auditEventSchema
// rejects a sensitive-named key that still holds a raw value.

import { auditEventSchema, maskAuditChanges } from "@starter/shared/audit";
import { createUlid } from "@starter/shared/core";
import { recordAudit as appendAudit } from "./core-audit.ts";
import type { AuditEntry, AuditWriter } from "./audit-writer.ts";

/**
 * Non-PII fields the audit reader needs to understand an RBAC change. Keys
 * match the entry snapshots the RBAC service writes; a new action starts with
 * an empty list (fully redacted) until it is added here deliberately.
 */
const SAFE_FIELDS_BY_ACTION: Readonly<Record<string, readonly string[]>> = {
  "pos_override.recorded": [
    "action",
    "method",
    "requestedBy",
    "approvedBy",
    "valueIdr",
    "expectedIdr",
    "countedIdr",
    "varianceIdr",
    "reasonCode",
    "objectType",
    "objectId",
    "approvalRequestId",
  ],
  "tenant.created": [
    "slug",
    "plan",
    "deploymentMode",
    "modules",
    "firstAdminUserId",
    "adminProvisioning",
  ],
  "tenant.status_changed": ["status"],
  "tenant.package_changed": [
    "plan",
    "modules",
    "maxOutlets",
    "maxActiveEmployees",
    "maxDevices",
    "aiRequestsPerMonth",
    "aiCostCapIdr",
    "emailCostCapIdr",
  ],
  "support_access.granted": [
    "accessMode",
    "durationMinutes",
    "startedAt",
    "expiresAt",
  ],
  "support_access.ended": ["status", "endedAt", "superAdminUserId"],
  "support_access.expired": ["status", "expiresAt", "superAdminUserId"],
  "support_access.denied": ["cause", "accessMode", "durationMinutes"],
  "support_access.impersonation_started": [
    "impersonatedUserId",
    "impersonationId",
    "accessMode",
    "impersonationEndsAt",
    "grantExpiresAt",
  ],
  "support_access.impersonation_ended": [
    "impersonatedUserId",
    "impersonationId",
    "accessMode",
    "cause",
    "grantExpiresAt",
  ],

  "tenant_owner.assigned": [
    "userId",
    "assignmentId",
    "replacedAssignmentId",
    "account",
  ],
  "tenant_owner.replaced": [
    "userId",
    "assignmentId",
    "replacedAssignmentId",
    "account",
  ],
  "tenant_owner.denied": ["cause", "impersonatedBy"],
  "tenant_owner.notify_failed": ["assignmentId", "kind", "error"],
  "platform.access.denied": [
    "cause",
    "code",
    "impersonatedBy",
    "impersonatedUserId",
    "method",
    "route",
  ],
  "integration.created": ["provider", "outletId", "status", "configKeys"],
  "integration.config.updated": [
    "provider",
    "outletId",
    "status",
    "configKeys",
  ],
  "integration.credentials.replaced": [
    "provider",
    "outletId",
    "status",
    "configKeys",
  ],
  "integration.status.changed": [
    "provider",
    "outletId",
    "status",
    "configKeys",
  ],
  "integration.credentials.rotated": [
    "provider",
    "outletId",
    "status",
    "configKeys",
  ],
  "outbox.replayed": ["dispatchState", "generation"],
  "role.created": ["permissions", "mfaRequired", "allowedScopeTypes"],
  "role.updated": ["permissions", "mfaRequired", "allowedScopeTypes"],
  "role_assignment.granted": [
    "userId",
    "roleId",
    "type",
    "id",
    "validFrom",
    "validUntil",
  ],
  "role_assignment.ended": ["userId", "roleId", "validFrom", "validUntil"],
  "approval_policy.changed": [
    "policies",
    "id",
    "actionType",
    "thresholdIdr",
    "approverRoleId",
    "levels",
    "requiresDistinctActor",
  ],
};

export const coreAuditWriter: AuditWriter = {
  async record(entry: AuditEntry, scope): Promise<void> {
    const now = new Date();
    const safeFields = SAFE_FIELDS_BY_ACTION[entry.action] ?? [];
    const event = auditEventSchema.parse({
      id: createUlid(now.getTime()),
      tenantId: entry.tenantId,
      outletId: entry.outletId,
      actorType: entry.actorType,
      actorId: entry.actorId,
      deviceId: entry.deviceId,
      action: entry.action,
      objectType: entry.objectType,
      objectId: entry.objectId,
      reason: entry.reason,
      maskedChanges: {
        before: maskAuditChanges(entry.before, safeFields),
        after: maskAuditChanges(entry.after, safeFields),
      },
      ipHash: null,
      sensitiveAccess: entry.sensitiveAccess,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    });
    await appendAudit(scope.tx, scope.context, event, safeFields);
  },
};
