// Audit write port (PRD v1.7 §3.7 "Pemberian Role ... tercatat di audit log",
// §6 B audit_logs). The audit service and its append-only table are bead
// legend-4sc (in progress, not on main yet). Until it merges, this port is the
// only seam: the RBAC service calls `recordAudit` inside the same
// `withTenant` transaction, and the default writer fails closed, so a missing
// audit implementation can never let a role/approval change pass silently.
//
// Wiring legend-4sc: call `setAuditWriter` in the API bootstrap with a writer
// that inserts `audit_logs` on the caller's transaction. Do not replace the
// default with a no-op.

export type AuditActorType = "user" | "ai" | "mcp_client" | "system" | "device";

/** One append-only audit row, without the ULID/createdAt the writer assigns. */
export type AuditEntry = {
  readonly tenantId: string;
  readonly outletId: string | null;
  readonly actorType: AuditActorType;
  /** UUID for every actor kind except `system`. */
  readonly actorId: string | null;
  readonly deviceId: string | null;
  /** Dotted lowercase action, same vocabulary as the domain events. */
  readonly action: string;
  /** One snake_case word (`role`, `role_assignment`, `approval_policy`). */
  readonly objectType: string;
  readonly objectId: string | null;
  readonly reason: string | null;
  /** Masked snapshots only; never raw PII (see @starter/shared/audit masking). */
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly sensitiveAccess: boolean;
};

export type AuditWriter = {
  record(entry: AuditEntry): Promise<void>;
};

export class AuditUnavailableError extends Error {
  constructor() {
    super(
      "The audit log is not available; refusing a sensitive change (PRD §3.7, §6 B audit_logs)",
    );
    this.name = "AuditUnavailableError";
  }
}

let writer: AuditWriter | null = null;

/** Installed once by the API bootstrap when legend-4sc lands. */
export function setAuditWriter(next: AuditWriter | null): void {
  writer = next;
}

/**
 * Fail closed: with no writer every sensitive change is refused. The caller
 * awaits this inside its transaction, so a write failure rolls back the
 * domain change together with the audit row.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  if (writer === null) throw new AuditUnavailableError();
  await writer.record(entry);
}
