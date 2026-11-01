import {
  assertOutletInScope,
  assertTrustedScopedContext,
  ulidToUuid,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { eventEnvelopeSchema, outboxRowSchema } from "@starter/shared/events";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { domainEventOutbox } from "../db/schema/core-events";

type Database = NodePgDatabase<typeof schema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Append inside the caller's domain transaction; no independent commit is possible. */
export async function appendOutbox(
  tx: Transaction,
  context: ScopedTenantContext,
  input: {
    id: string;
    event: unknown;
    destination: string;
    direction: string | null;
    peerId: string | null;
  },
) {
  assertTrustedScopedContext(context);
  const event = eventEnvelopeSchema.parse(input.event);
  if (event.tenantId !== context.tenant.tenantId)
    throw new Error("Event tenant does not match context");
  if (event.outletId) assertOutletInScope(context.outletScope, event.outletId);
  else if (context.outletScope.kind !== "tenant")
    throw new Error("Tenant-wide event requires tenant scope");
  const row = outboxRowSchema.parse({
    ...input,
    event,
    status: "pending",
    attempts: 0,
    availableAt: new Date().toISOString(),
    leaseOwner: null,
    leaseUntil: null,
    deliveredAt: null,
    createdAt: new Date().toISOString(),
  });
  await tx.insert(domainEventOutbox).values({
    tenantId: event.tenantId,
    id: ulidToUuid(row.id),
    outletId: event.outletId,
    eventId: ulidToUuid(event.id),
    aggregateType: event.aggregateType,
    aggregateId: uuidSchema.safeParse(event.aggregateId).success
      ? event.aggregateId
      : ulidToUuid(event.aggregateId),
    sequence: event.sequence,
    event,
    destination: row.destination,
    direction: row.direction,
    peerId: row.peerId,
  });
}

/** Enqueue eligible rows per tenant. Sending before marking is deliberate: a crash
 * may enqueue twice, and the consumer's durable idempotency makes that safe. */
export async function relayOutbox(
  database: Database,
  context: ScopedTenantContext,
  enqueue: (job: { tenantId: string; outboxId: string }) => Promise<unknown>,
) {
  const { withTenant } = await import("../db/tenant");
  const { sql } = await import("drizzle-orm");
  const { uuidToUlid } = await import("@starter/shared/core");
  const rows = await withTenant(database, context, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, outlet_id FROM domain_event_outbox WHERE status <> 'delivered' AND available_at <= now() ORDER BY created_at, id LIMIT 100`,
    );
    return result.rows as { id: string; outlet_id: string | null }[];
  });
  let count = 0;
  for (const row of rows) {
    if (row.outlet_id) assertOutletInScope(context.outletScope, row.outlet_id);
    else if (context.outletScope.kind !== "tenant") continue;
    await enqueue({
      tenantId: context.tenant.tenantId,
      outboxId: uuidToUlid(row.id),
    });
    count++;
  }
  return count;
}

/** Serializes each outbox delivery, applies database effects and consumption in
 * one transaction, and supplies the event ID as the provider idempotency key.
 * Providers must honor that key: their external side effects cannot be rolled back. */
export async function consumeOutbox(
  database: Database,
  context: ScopedTenantContext,
  input: {
    outboxId: string;
    authorize: (
      event: import("@starter/shared/events").EventEnvelope,
    ) => Promise<boolean>;
    deliver: (
      event: import("@starter/shared/events").EventEnvelope,
      idempotencyKey: string,
      tx: Transaction,
    ) => Promise<void>;
  },
) {
  const { withTenant } = await import("../db/tenant");
  const { sql } = await import("drizzle-orm");
  return withTenant(database, context, async (tx) => {
    const result = await tx.execute(
      sql`SELECT * FROM domain_event_outbox WHERE id = ${ulidToUuid(input.outboxId)}::uuid FOR UPDATE`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("Outbox row not found");
    const event = eventEnvelopeSchema.parse(row.event);
    if (event.tenantId !== context.tenant.tenantId)
      throw new Error("Event tenant does not match context");
    if (event.outletId)
      assertOutletInScope(context.outletScope, event.outletId);
    else if (context.outletScope.kind !== "tenant")
      throw new Error("Tenant-wide event requires tenant scope");
    if (!(await input.authorize(event)))
      throw new Error("Worker permission denied");
    if (row.status === "delivered") return false;
    const previous = await tx.execute(
      sql`SELECT 1 FROM domain_event_outbox WHERE destination = ${String(row.destination)} AND aggregate_type = ${String(row.aggregate_type)} AND aggregate_id = ${String(row.aggregate_id)}::uuid AND sequence < ${Number(row.sequence)} AND status <> 'delivered' LIMIT 1`,
    );
    if (previous.rows.length)
      throw new Error("Earlier aggregate event has not been delivered");
    await input.deliver(event, event.id, tx);
    await tx.execute(
      sql`INSERT INTO domain_event_consumptions (tenant_id, outlet_id, consumer, event_id, aggregate_type, aggregate_id, sequence) VALUES (${event.tenantId}::uuid, ${event.outletId}::uuid, ${String(row.destination)}, ${String(row.event_id)}::uuid, ${event.aggregateType}, ${String(row.aggregate_id)}::uuid, ${event.sequence})`,
    );
    await tx.execute(
      sql`UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now(), lease_owner = NULL, lease_until = NULL, attempts = attempts + 1 WHERE id = ${String(row.id)}::uuid`,
    );
    return true;
  });
}
