import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  createUlid,
  ulidToUuid,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type * as schema from "../db/schema";
import { domainEventOutbox } from "../db/schema/core-events";
import { appendOutbox } from "./core-outbox";

type Database = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const EVENT_DESTINATION = "cloud-sync";

/**
 * Next gapless sequence for one aggregate. The advisory lock serializes two
 * concurrent changes of the same aggregate (both would otherwise read the same
 * maximum and collide on the outbox's (tenant, destination, aggregate,
 * sequence) unique key); it is released at commit, so it never outlives the
 * transaction. The sequence is read from the outbox itself, so it survives a
 * restart and no in-memory counter exists.
 */
async function nextSequence(
  tx: Tx,
  tenantId: string,
  aggregateType: string,
  aggregateId: string,
): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`notification-outbox:${tenantId}:${aggregateType}:${aggregateId}`}))`,
  );
  const [row] = await tx
    .select({
      last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, aggregateType),
        eq(domainEventOutbox.aggregateId, aggregateId),
      ),
    );
  return Number(row?.last ?? 0) + 1;
}

type EventDefinition = {
  readonly name: string;
  readonly version: number;
  readonly payloadSchemaRef: string;
  readonly entry: { readonly aggregateType: string };
  readonly envelopeSchema: { parse(value: unknown): unknown };
};
type EventInput = {
  /** UUID or ULID of the notification, or UUID of the user for preference events. */
  aggregateId: string;
  /** The aggregate's outlet; `null` for tenant-wide (preferences). */
  outletId: string | null;
  /** `null` is the system actor (worker consumer with no signed-in user). */
  actorUserId: string | null;
  payload: Record<string, unknown>;
  now: Date;
};

/** The outbox column is a UUID; the envelope carries a UUID or a ULID (a
 * notification id minted as a ULID is not an RFC UUID), so key by the column. */
const aggregateKeyOf = (aggregateId: string) =>
  uuidSchema.safeParse(aggregateId).success
    ? aggregateId
    : ulidToUuid(aggregateId);

async function appendWithSequence(
  tx: Tx,
  context: ScopedTenantContext,
  definition: EventDefinition,
  input: EventInput,
  sequence: number,
): Promise<void> {
  const eventId = createUlid(input.now.getTime());
  const event = definition.envelopeSchema.parse({
    id: eventId,
    tenantId: context.tenant.tenantId,
    outletId: input.outletId,
    name: definition.name,
    version: definition.version,
    aggregateType: definition.entry.aggregateType,
    aggregateId: input.aggregateId,
    sequence,
    occurredAt: input.now.toISOString(),
    actor:
      input.actorUserId === null
        ? { type: "system" }
        : { type: "user", id: input.actorUserId },
    deviceId: null,
    idempotencyKey: eventId,
    payloadSchemaRef: definition.payloadSchemaRef,
    payload: input.payload,
  });
  await appendOutbox(tx, context, {
    id: createUlid(input.now.getTime()),
    event,
    destination: EVENT_DESTINATION,
    direction: null,
    peerId: null,
  });
}

/**
 * Append one catalogued notification event inside the caller's transaction
 * (PRD §3.15, legend-9p0k). Data change and outbox row commit or roll back
 * together; the outbox refuses an outlet outside the caller's scope.
 */
export async function appendNotificationEvent(
  tx: Tx,
  context: ScopedTenantContext,
  definition: EventDefinition,
  input: EventInput,
): Promise<void> {
  const sequence = await nextSequence(
    tx,
    context.tenant.tenantId,
    definition.entry.aggregateType,
    aggregateKeyOf(input.aggregateId),
  );
  await appendWithSequence(tx, context, definition, input, sequence);
}

/**
 * Append events for many distinct aggregates at once (markAllRead). One
 * `max(sequence)` query for the whole batch and no advisory lock per row: the
 * caller must already hold row locks on every aggregate's source row (its
 * UPDATE ... RETURNING), so no other writer can append to these aggregates
 * before commit. Aggregates must be distinct within one call.
 */
export async function appendNotificationEventsBatch(
  tx: Tx,
  context: ScopedTenantContext,
  definition: EventDefinition,
  inputs: EventInput[],
): Promise<void> {
  if (!inputs.length) return;
  const keys = inputs.map((input) => aggregateKeyOf(input.aggregateId));
  if (new Set(keys).size !== keys.length)
    throw new Error("Batch aggregates must be distinct");
  const last = await tx
    .select({
      aggregateId: domainEventOutbox.aggregateId,
      last: sql<number>`max(${domainEventOutbox.sequence})`,
    })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, context.tenant.tenantId),
        eq(domainEventOutbox.destination, EVENT_DESTINATION),
        eq(domainEventOutbox.aggregateType, definition.entry.aggregateType),
        inArray(domainEventOutbox.aggregateId, keys),
      ),
    )
    .groupBy(domainEventOutbox.aggregateId);
  const lastByAggregate = new Map(
    last.map((row) => [String(row.aggregateId), Number(row.last)]),
  );
  for (const [index, input] of inputs.entries())
    await appendWithSequence(
      tx,
      context,
      definition,
      input,
      (lastByAggregate.get(keys[index]!) ?? 0) + 1,
    );
}
