// `approval.resolved` consumer for payment reconciliation cases (PAY recon,
// PRD §3.7). Wired in worker-main.ts next to the refund consumer.
//
// The approval service never writes another module's tables: it appends
// `approval.resolved` and the source module applies the effect in its own
// transaction. This consumer only reacts to chains a reconciliation case opened
// (sourceModule `payment`, objectType `payment_reconciliation_case`) and
// delegates to `settleReconciliationCaseForApproval`, which re-reads the chain
// outcome and the final approver from the database under the case row lock. The
// event payload is a trigger, never the authority: a forged or stale "approved"
// event cannot close a case whose chain the database still has pending.
//
// - Other event names, source modules and object types: ignored (not ours).
// - A chain no case owns: ignored (opening transaction rolled back).
// - Replay: settling a case that is no longer pending returns it unchanged.

import { approvalResolvedEvent } from "@starter/shared/identity";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  RECONCILIATION_OBJECT_TYPE,
  RECONCILIATION_SOURCE_MODULE,
  settleReconciliationCaseForApproval,
} from "./payment-admin-reconciliation.service.ts";

/** Envelope as the worker hands it to `deliverEvent`. */
export type DomainEvent = EventEnvelope;

function payloadField(event: DomainEvent, key: string): unknown {
  const payload: unknown = event.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Settles the reconciliation case that owns the resolved chain. Idempotent and
 * replay safe; ignores events that are not ours.
 */
export async function handleReconciliationApprovalResolved(
  context: ScopedTenantContext,
  event: DomainEvent,
  now: Date = new Date(),
): Promise<void> {
  if (event.name !== approvalResolvedEvent.name) return;
  if (payloadField(event, "sourceModule") !== RECONCILIATION_SOURCE_MODULE)
    return;
  if (payloadField(event, "objectType") !== RECONCILIATION_OBJECT_TYPE) return;

  const parsed = approvalResolvedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success) return;
  const { tenantId } = context.tenant;
  if (parsed.data.tenantId.toLowerCase() !== tenantId.toLowerCase()) return;
  const chainId = parsed.data.payload.chainId;

  await withTenant(db, context, async (tx) => {
    await settleReconciliationCaseForApproval(tx, context, { chainId }, now);
  });
}
