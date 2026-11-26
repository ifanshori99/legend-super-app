// EDC transaction events -> outbox (bead legend-apt, EDC-02/03).
//
// `emitEdcTransactionEvent` appends one catalogued event in the CALLER's
// tenant transaction, so the event commits (or rolls back) together with the
// ledger status change it describes. Modeled on `appendPaymentEvent`
// (services/payment-support.ts): same per-aggregate sequence rule, destination
// `cloud-sync`, idempotency key `${name}:${aggregateId}:${sequence}`.
//
// The payload is built from the ledger row here, so no caller can leak a field
// (a full PAN cannot be expressed: only `masked_pan` is read).

import { and, eq, sql } from "drizzle-orm";
import { createUlid, type ScopedTenantContext } from "@starter/shared/core";
import {
  EDC_TRANSACTION_EVENTS,
  edcEventRrnSchema,
  type EdcTransactionEventName,
  type EdcTransactionEventPayload,
} from "@starter/shared/edc/events";
import { domainEventOutbox } from "../../db/schema/index.ts";
import type { edcTransactions } from "../../db/schema/index.ts";
import { appendOutbox } from "../../services/core-outbox.ts";
import { EVENT_DESTINATION } from "../../services/payment-support.ts";
import type { Tx } from "../../services/permission-resolver.ts";

export type EdcTransactionRow = typeof edcTransactions.$inferSelect;

const AGGREGATE_TYPE = "edc_transaction";

async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, AGGREGATE_TYPE),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

function payloadOf(row: EdcTransactionRow): EdcTransactionEventPayload {
  return {
    transactionId: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    terminalId: row.terminalId,
    bank: row.bank as EdcTransactionEventPayload["bank"],
    reference: row.reference,
    amountIdr: row.amountIdr,
    status: row.status as EdcTransactionEventPayload["status"],
    trace: row.trace ?? null,
    approvalCode: row.approvalCode ?? null,
    maskedPan: row.maskedPan ?? null,
    needsReconciliation: row.needsReconciliation,
    method: row.method as NonNullable<EdcTransactionEventPayload["method"]>,
    type: row.type as NonNullable<EdcTransactionEventPayload["type"]>,
    mode: row.mode as NonNullable<EdcTransactionEventPayload["mode"]>,
    // Dropped, never thrown: a strange terminal RRN must not roll back the
    // ledger write of a charge the terminal already made.
    rrn:
      row.rrn !== null && edcEventRrnSchema.safeParse(row.rrn).success
        ? row.rrn
        : null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/**
 * Appends one `edc_transaction.*` event for `row` (its state AFTER the change)
 * inside the caller's `withTenant` transaction. Actor is always `system`: the
 * agent, not a user, moves the ledger. Throws if the payload breaks the strict
 * event schema (for example a raw PAN), which rolls back the ledger write too.
 */
export async function emitEdcTransactionEvent(
  tx: Tx,
  ctx: ScopedTenantContext,
  input: {
    name: EdcTransactionEventName;
    row: EdcTransactionRow;
    now: Date;
  },
): Promise<void> {
  const definition = EDC_TRANSACTION_EVENTS.find((e) => e.name === input.name);
  if (!definition) throw new Error(`Unknown EDC event ${input.name}`);
  const { row, now } = input;
  const sequence = await nextSequence(tx, ctx.tenant.tenantId, row.id);
  const event = definition.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId: ctx.tenant.tenantId,
    outletId: row.outletId,
    name: input.name,
    version: definition.version,
    aggregateType: AGGREGATE_TYPE,
    aggregateId: row.id,
    sequence,
    occurredAt: now.toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${input.name}:${row.id}:${sequence}`.slice(0, 100),
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: payloadOf(row),
  });
  await appendOutbox(tx, ctx, {
    id: createUlid(now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}
