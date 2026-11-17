// `approval.resolved` consumer for cash outs held for approval (bead
// legend-4qowr; founder Q7, PRD v1.7 §3.19 Kas & Bank, §3.7 Matriks Approval).
// Wired in worker-main.ts next to the manual journal consumer.
//
// The approval service never writes another module's tables: it appends
// `approval.resolved` and the source module applies the effect in its own
// transaction. This consumer only reacts to chains this module opened
// (sourceModule `accounting`, objectType `cash_bank_entry`) and delegates to
// `settleCashBankEntryForApproval`, which re-reads the chain outcome and the
// final approver from the database under the entry's row lock and posts the
// journal through the same code as the direct approve endpoint (key
// `cb:<entryId>`). The event payload is a trigger, never the authority: a
// forged or stale "approved" event cannot approve a chain the database still
// has pending.
//
// - Other event names, source modules and object types: ignored (not ours).
// - Another tenant's scope, or a chain whose request row is missing (opening
//   transaction rolled back): ignored. A chain that names another entry:
//   refused, nothing is written.
// - Replay: settling an entry that is no longer pending returns it unchanged,
//   so a redelivered event never posts a second journal.

import { approvalResolvedEvent } from "@starter/shared/identity";
import {
  CoreError,
  ulidSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { approvalRequests } from "../db/schema/platform-approval.ts";
import { withTenant } from "../db/tenant.ts";
import {
  CASH_BANK_APPROVAL_SOURCE_MODULE,
  CASH_BANK_ENTRY_OBJECT_TYPE,
  settleCashBankEntryForApproval,
} from "./accounting-cash-bank-entries.service.ts";

/** Envelope as the worker hands it to `deliverEvent`. */
export type DomainEvent = EventEnvelope;

function payloadField(event: DomainEvent, key: string): unknown {
  const payload: unknown = event.payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;
}

/** ULID or UUID spelling of one id, compared in its stored (uuid) form. */
function storedId(id: string): string {
  return ulidSchema.safeParse(id).success
    ? ulidToUuid(id).toLowerCase()
    : id.toLowerCase();
}

/**
 * Settles the cash out that owns the resolved chain. Idempotent and replay
 * safe; ignores events that are not ours; throws (no write) on a foreign or
 * malformed event of ours, so the outbox retries and finally dead-letters it.
 */
export async function handleCashBankApprovalResolved(
  context: ScopedTenantContext,
  event: DomainEvent,
  now: Date = new Date(),
): Promise<void> {
  if (event.name !== approvalResolvedEvent.name) return;
  if (payloadField(event, "sourceModule") !== CASH_BANK_APPROVAL_SOURCE_MODULE)
    return;
  if (payloadField(event, "objectType") !== CASH_BANK_ENTRY_OBJECT_TYPE) return;

  const parsed = approvalResolvedEvent.envelopeSchema.safeParse(event);
  if (!parsed.success)
    throw new CoreError(
      "VALIDATION_ERROR",
      "approval.resolved for cash out has an unknown shape",
    );
  const { tenantId } = context.tenant;
  // Another tenant's worker scope never applies this event (not authority).
  if (parsed.data.tenantId.toLowerCase() !== tenantId.toLowerCase()) return;
  const { chainId, objectId } = parsed.data.payload;

  await withTenant(db, context, async (tx) => {
    // The entry comes from the chain row in the database, and must be the one
    // the event names: a mismatch is corrupt or forged input.
    const [head] = await tx
      .select({
        objectId: approvalRequests.objectId,
        sourceModule: approvalRequests.sourceModule,
        objectType: approvalRequests.objectType,
        actionType: approvalRequests.actionType,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, tenantId),
          eq(approvalRequests.chainId, chainId),
        ),
      )
      .limit(1);
    if (!head) return;
    if (
      head.sourceModule !== CASH_BANK_APPROVAL_SOURCE_MODULE ||
      head.objectType !== CASH_BANK_ENTRY_OBJECT_TYPE ||
      head.actionType !== "cash_out"
    )
      return;
    if (storedId(head.objectId) !== storedId(objectId))
      throw new CoreError(
        "VALIDATION_ERROR",
        "approval.resolved chain belongs to another cash entry",
      );
    await settleCashBankEntryForApproval(tx, context, head.objectId, now);
  });
}
