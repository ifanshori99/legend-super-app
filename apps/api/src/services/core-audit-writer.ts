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
