// `approval.resolved` consumer for manual and recurring journals (PRD v1.7
// §3.19; AUTH-06; bead legend-vmyg). Wired in worker-main.ts next to the POS
// override consumer, mirroring staff-override-consumers.
//
// The approval service never writes another module's tables: it appends
// `approval.resolved` and the source module applies the effect in its own
// transaction. This consumer only reacts to chains this module opened
// (sourceModule `accounting`, objectType manual_journal / recurring_journal)
// and delegates to the settle functions, which re-read the chain outcome and
// the final approver from the database under the row lock. The event payload
// is a trigger, never the authority: a forged or stale "approved" event cannot
// approve a chain the database still has pending.
//
// - Other event names, source modules and object types: ignored (not ours).
// - A chain no journal row owns: ignored (opening transaction rolled back).
// - Replay: settling a non-pending row returns it unchanged.

import { approvalResolvedEvent } from "@starter/shared/identity";
import type { ScopedTenantContext } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  manualJournals,
  recurringJournals,
} from "../db/schema/accounting-journal-requests.ts";
import { withTenant } from "../db/tenant.ts";
import { settleManualJournalForApproval } from "./accounting-journal-manual.service.ts";
import {
  JOURNAL_APPROVAL_SOURCE_MODULE,
  MANUAL_JOURNAL_OBJECT_TYPE,
  RECURRING_JOURNAL_OBJECT_TYPE,
} from "./accounting-journal-period-gate.ts";
import { settleRecurringJournalForApproval } from "./accounting-journal-recurring.service.ts";

/** Envelope as the worker hands it to `deliverEvent`. */
export type DomainEvent = EventEnvelope;

function payloadField(event: DomainEvent, key: string): unknown {
  const payload: unknown = event.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Settles the manual or recurring journal that owns the resolved chain.
 * Idempotent and replay safe; ignores events that are not ours.
 */
export async function handleJournalApprovalResolved(
  context: ScopedTenantContext,
  event: DomainEvent,
  now: Date = new Date(),
): Promise<void> {
  if (event.name !== approvalResolvedEvent.name) return;
  if (payloadField(event, "sourceModule") !== JOURNAL_APPROVAL_SOURCE_MODULE)
    return;
  const objectType = payloadField(event, "objectType");
  if (
    objectType !== MANUAL_JOURNAL_OBJECT_TYPE &&
    objectType !== RECURRING_JOURNAL_OBJECT_TYPE
  )
    return;

  const parsed = approvalResolvedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success) return;
  const { tenantId } = context.tenant;
  if (parsed.data.tenantId.toLowerCase() !== tenantId.toLowerCase()) return;
  const chainId = parsed.data.payload.chainId;

  await withTenant(db, context, async (tx) => {
    if (objectType === MANUAL_JOURNAL_OBJECT_TYPE) {
      const [row] = await tx
        .select({ id: manualJournals.id })
        .from(manualJournals)
        .where(
          and(
            eq(manualJournals.tenantId, tenantId),
            eq(manualJournals.approvalChainId, chainId),
          ),
        )
        .limit(1);
      if (row) await settleManualJournalForApproval(tx, context, row.id, now);
      return;
    }
    const [row] = await tx
      .select({ id: recurringJournals.id })
      .from(recurringJournals)
      .where(
        and(
          eq(recurringJournals.tenantId, tenantId),
          eq(recurringJournals.approvalChainId, chainId),
        ),
      )
      .limit(1);
    if (row) await settleRecurringJournalForApproval(tx, context, row.id, now);
  });
}
