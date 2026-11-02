// Audit write port (PRD v1.7 §3.7 "Pemberian Role ... tercatat di audit log",
// §6 B audit_logs). The RBAC service calls `recordAudit` inside the same
// `withTenant` transaction that performs the change, and the default writer
// fails closed, so a missing audit implementation can never let a
// role/approval change pass silently.
//
// Wiring (bead legend-wt33): `apps/api/src/services/core-audit-writer.ts` maps
// this entry to the audit contract and appends it on the caller's transaction.
// `app.ts` installs it at bootstrap. Do not replace it with a no-op.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ScopedTenantContext } from "@starter/shared/core";
import type * as schema from "../db/schema/index.ts";

type Database = NodePgDatabase<typeof schema>;
/** The tenant transaction the audited change runs on. */
export type AuditTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

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

/** Where the audit row must land: the caller's transaction and tenant scope. */
export type AuditWriteScope = {
  readonly tx: AuditTransaction;
  readonly context: ScopedTenantContext;
};

export type AuditWriter = {
  record(entry: AuditEntry, scope: AuditWriteScope): Promise<void>;
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

/** Installed once by the API bootstrap (app.ts). */
export function setAuditWriter(next: AuditWriter | null): void {
  writer = next;
}

/**
 * Fail closed: with no writer every sensitive change is refused. The caller
 * awaits this inside its transaction, so a write failure rolls back the
 * domain change together with the audit row.
 */
export async function recordAudit(
  entry: AuditEntry,
  scope: AuditWriteScope,
): Promise<void> {
  if (writer === null) throw new AuditUnavailableError();
  await writer.record(entry, scope);
}
