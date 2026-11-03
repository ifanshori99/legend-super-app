// Transactional-outbox emission for daily operations (WS-14). One helper so
// every operations service builds the envelope the same way and the sequence
// allocation is race-safe: a per-aggregate advisory lock serialises the
// max+1 read, exactly like menu-internals.nextSequence, because two concurrent
// changes of the same run/equipment row would otherwise collide on the outbox
// (tenant, aggregate, sequence) unique key.
//
// Destinations: `cloud-sync` is the deployment consumer (domain events);
// `notification` routes the event to the notification consumer, which turns it
// into supervisor alerts (OPS-01 checklist misses).
import { sql } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { createUlid, type ScopedTenantContext } from "@starter/shared/core";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { appendOutbox } from "./core-outbox.ts";
import type { OperationsTx } from "./operations-idempotency.ts";

export const OPERATIONS_EVENT_DESTINATION = "cloud-sync";
export const OPERATIONS_NOTIFICATION_DESTINATION = "notification";

export type OperationsEventActor =
  { type: "user"; id: string } | { type: "system" };

/** The minimal shape of a catalog-bound event definition (`defineDomainEvent`). */
export type OperationsEventDefinition = {
  readonly name: string;
  readonly version: number;
  readonly payloadSchemaRef: string;
  readonly entry: { readonly aggregateType: string };
  readonly envelopeSchema: { parse(value: unknown): unknown };
};

async function nextSequence(
  tx: OperationsTx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`operations-outbox:${tenantId}:${aggregateType}:${aggregateId}`}))`,
  );
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

/** Append one operations event inside the caller's domain transaction. */
export async function emitOperationsEvent(
  tx: OperationsTx,
  context: ScopedTenantContext,
  definition: OperationsEventDefinition,
  input: {
    aggregateId: string;
    outletId: string;
    actor: OperationsEventActor;
    payload: Record<string, unknown>;
    destination?: string;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    input.aggregateId,
  );
  const event = definition.envelopeSchema.parse({
    id: createUlid(now.getTime()),
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: now.toISOString(),
    actor: input.actor,
    deviceId: null,
    idempotencyKey: `${definition.name}:${input.aggregateId}:${sequence}`,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(now.getTime()),
    event,
    destination: input.destination ?? OPERATIONS_EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}
