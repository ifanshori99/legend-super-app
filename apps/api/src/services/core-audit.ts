import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { auditEventSchema, maskAuditChanges } from "@starter/shared/audit";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  getRequestActingStaff,
  getRequestSupport,
} from "../lib/request-context.ts";
import type * as schema from "../db/schema/index.ts";
import { auditLogs } from "../db/schema/core-audit.ts";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/*
 * Single attribution point for support sessions (TEN-04, legend-6yfhc).
 * When the request runs on an impersonated session under a grant, every audit
 * row for that grant's tenant is tagged `support`. A row written as the
 * impersonated user is re-attributed to the platform admin, flagged as
 * sensitive access, and carries the grant reason when it has none. System and
 * device rows keep their actor and only get the tag. Rows of other tenants are
 * never touched.
 */
function attributeToSupport(input: unknown): unknown {
  const support = getRequestSupport();
  if (!support || typeof input !== "object" || input === null) return input;
  const row = input as Record<string, unknown>;
  if (row.tenantId !== support.tenantId) return input;
  const tagged: Record<string, unknown> = {
    ...row,
    support: {
      grantId: support.grantId,
      impersonatorUserId: support.impersonatorUserId,
      impersonatedUserId: support.impersonatedUserId,
      accessMode: support.accessMode,
    },
  };
  if (row.actorType === "user" && row.actorId === support.impersonatedUserId) {
    const own = typeof row.reason === "string" ? row.reason : "";
    tagged.actorId = support.impersonatorUserId;
    tagged.sensitiveAccess = true;
    tagged.reason = (own.trim() ? own : support.reason).slice(0, 1000);
  }
  return tagged;
}

/*
 * Active cashier on a shared POS device (DECISIONS 2026-11-10). A row written
 * as the acting staff member keeps them as actor and also names the login
 * session owner and the token. Rows by any other actor are left alone.
 */
function attributeToActingStaff(input: unknown): unknown {
  const acting = getRequestActingStaff();
  if (!acting || typeof input !== "object" || input === null) return input;
  const row = input as Record<string, unknown>;
  if (row.actorType !== "user" || row.actorId !== acting.staffUserId)
    return input;
  return {
    ...row,
    acting: {
      sessionUserId: acting.sessionUserId,
      actingStaffUserId: acting.staffUserId,
      actingTokenId: acting.tokenId,
    },
  };
}

/** Append in the same tenant transaction as the operation being audited. */
export async function recordAudit(
  tx: Transaction,
  context: ScopedTenantContext,
  input: unknown,
  safeFields: readonly string[] = [],
) {
  assertTrustedScopedContext(context);
  const event = auditEventSchema.parse(
    attributeToActingStaff(attributeToSupport(input)),
  );
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
