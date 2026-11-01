import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { auditEventSchema, maskAuditChanges } from "@starter/shared/audit";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type * as schema from "../db/schema/index.ts";
import { auditLogs } from "../db/schema/core-audit.ts";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Append in the same tenant transaction as the operation being audited. */
export async function recordAudit(
  tx: Transaction,
  context: ScopedTenantContext,
  input: unknown,
  safeFields: readonly string[] = [],
) {
  assertTrustedScopedContext(context);
  const event = auditEventSchema.parse(input);
  if (event.tenantId !== context.tenant.tenantId)
    throw new Error("Audit tenant does not match context");
  if (event.outletId) assertOutletInScope(context.outletScope, event.outletId);
  else if (context.outletScope.kind !== "tenant")
    throw new Error("Tenant-wide audit requires tenant scope");
  const maskedEvent = {
    ...event,
    maskedChanges: {
      before: maskAuditChanges(event.maskedChanges.before, safeFields),
      after: maskAuditChanges(event.maskedChanges.after, safeFields),
    },
  };
  await tx.insert(auditLogs).values({
    tenantId: event.tenantId,
    id: ulidToUuid(event.id),
    outletId: event.outletId,
    event: maskedEvent,
    retentionClass: event.retentionClass,
  });
}
