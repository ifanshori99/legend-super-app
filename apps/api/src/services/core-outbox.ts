import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  ulidToUuid,
  uuidSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  eventActorSchema,
  eventEnvelopeSchema,
  outboxRowSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import type * as schema from "../db/schema";
import { domainEventOutbox } from "../db/schema/core-events";
import { withTenant } from "../db/tenant";

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

/** drizzle expands a JS array into separate parameters; pass one Postgres
 * array literal instead. Outlet IDs are schema-validated UUIDs. */
function outletArray(context: ScopedTenantContext) {
  return context.outletScope.kind === "tenant"
    ? "{}"
    : `{${context.outletScope.outletIds.join(",")}}`;
}

export type GapRequest = {
  destination: string;
  aggregateType: string;
  aggregateId: string;
  missingSequence: number;
};

/** pg-boss owns a job for its expiry (120s) plus five exponential retries
 * (about 15 minutes in total); a queued row older than this lease means the job
 * vanished without a dead letter and the aggregate would stay blocked, so the
 * relay re-dispatches it. */
export const QUEUED_DISPATCH_LEASE_SECONDS = 20 * 60;

/** Re-dispatch queued rows whose pg-boss job vanished. The generation advance
 * fences the lost job: a late delivery for the old generation is rejected by
 * consumeOutbox instead of applying twice. The database guard allows this
 * transition only after the queued lease expired (migration 0006). */
export async function recoverExpiredDispatches(
  database: Database,
  context: ScopedTenantContext,
) {
  const outletFilter =
    context.outletScope.kind === "tenant"
      ? sql`TRUE`
      : sql`o.outlet_id = ANY(${outletArray(context)}::uuid[])`;
  return withTenant(database, context, async (tx) => {
    const result = await tx.execute(
      sql`UPDATE domain_event_outbox SET dispatch_state = 'ready', dispatch_generation = dispatch_generation + 1, dispatch_job_id = NULL, dispatch_lease_token = NULL, dispatch_lease_until = NULL, dead_lettered_at = NULL WHERE id IN (SELECT id FROM domain_event_outbox o WHERE dispatch_state = 'queued' AND status <> 'delivered' AND dispatch_lease_until IS NOT NULL AND dispatch_lease_until < now() AND ${outletFilter} ORDER BY dispatch_lease_until, id FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING id, dispatch_generation`,
    );
    return result.rows as { id: string; dispatch_generation: number }[];
  });
}

/** Claim only ready rows; a fenced lease recovers a relay crash. Stable job IDs
 * make an enqueue retried after an uncertain acknowledgement idempotent. */
export async function relayOutbox(
  database: Database,
  context: ScopedTenantContext,
  enqueue: (job: {
    tenantId: string;
    outboxId: string;
    generation: number;
  }) => Promise<string>,
  requestMissing: (gap: GapRequest) => Promise<void> = async () => {},
) {
  // A vanished pg-boss job leaves its row queued; recover it before claiming so
  // this sweep re-enqueues it under the advanced generation.
  await recoverExpiredDispatches(database, context);
  const token = randomUUID();
  const rows = await withTenant(database, context, async (tx) => {
    const outletFilter =
      context.outletScope.kind === "tenant"
        ? sql`TRUE`
        : sql`outlet_id = ANY(${outletArray(context)}::uuid[])`;
    const result = await tx.execute(
      sql`UPDATE domain_event_outbox SET dispatch_lease_token = ${token}::uuid, dispatch_lease_until = now() + interval '60 seconds' WHERE id IN (SELECT id FROM domain_event_outbox o WHERE dispatch_state = 'ready' AND status <> 'delivered' AND available_at <= now() AND (dispatch_lease_until IS NULL OR dispatch_lease_until < now()) AND ${outletFilter} AND sequence = COALESCE((SELECT last_sequence FROM domain_event_offsets x WHERE x.tenant_id = o.tenant_id AND x.consumer = o.destination AND x.aggregate_type = o.aggregate_type AND x.aggregate_id = o.aggregate_id), 0) + 1 ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING id, dispatch_generation`,
    );
    return result.rows as { id: string; dispatch_generation: number }[];
  });
  const gaps = await withTenant(database, context, async (tx) => {
    const outletFilter =
      context.outletScope.kind === "tenant"
        ? sql`TRUE`
        : sql`o.outlet_id = ANY(${outletArray(context)}::uuid[])`;
    const result = await tx.execute(
      sql`SELECT DISTINCT o.destination, o.aggregate_type, o.event->>'aggregateId' AS aggregate_id, COALESCE(x.last_sequence, 0) + 1 AS missing_sequence FROM domain_event_outbox o LEFT JOIN domain_event_offsets x ON x.tenant_id = o.tenant_id AND x.consumer = o.destination AND x.aggregate_type = o.aggregate_type AND x.aggregate_id = o.aggregate_id WHERE ${outletFilter} AND o.status <> 'delivered' AND o.sequence > COALESCE(x.last_sequence, 0) + 1 AND NOT EXISTS (SELECT 1 FROM domain_event_outbox p WHERE p.tenant_id = o.tenant_id AND p.destination = o.destination AND p.aggregate_type = o.aggregate_type AND p.aggregate_id = o.aggregate_id AND p.sequence = COALESCE(x.last_sequence, 0) + 1) LIMIT 100`,
    );
    return result.rows;
  });
  for (const gap of gaps)
    await requestMissing({
      destination: String(gap.destination),
      aggregateType: String(gap.aggregate_type),
      aggregateId: String(gap.aggregate_id),
      missingSequence: Number(gap.missing_sequence),
    });
  let count = 0;
  for (const row of rows) {
    const jobId = uuidSchema.parse(
      await enqueue({
        tenantId: context.tenant.tenantId,
        outboxId: uuidToUlid(row.id),
        generation: row.dispatch_generation,
      }),
    );
    await withTenant(database, context, async (tx) => {
      await tx.execute(
        sql`UPDATE domain_event_outbox SET dispatch_state = 'queued', dispatch_job_id = ${jobId}::uuid, dispatch_lease_token = NULL, dispatch_lease_until = now() + make_interval(secs => ${QUEUED_DISPATCH_LEASE_SECONDS}) WHERE id = ${row.id}::uuid AND dispatch_state = 'ready' AND dispatch_lease_token = ${token}::uuid AND dispatch_generation = ${row.dispatch_generation} AND status <> 'delivered'`,
      );
    });
    count++;
  }
  return count;
}

/** Called only for a dead-letter job, fenced against stale replay generations. */
export async function markOutboxDead(
  database: Database,
  context: ScopedTenantContext,
  input: { outboxId: string; generation: number },
) {
  assertTrustedScopedContext(context);
  if (context.outletScope.kind !== "tenant")
    throw new Error("Worker requires tenant scope");
  await withTenant(database, context, async (tx) => {
    await tx.execute(
      sql`UPDATE domain_event_outbox SET dispatch_state = 'dead', dead_lettered_at = now(), dispatch_lease_token = NULL, dispatch_lease_until = NULL WHERE id = ${ulidToUuid(input.outboxId)}::uuid AND dispatch_generation = ${input.generation} AND dispatch_state IN ('ready', 'queued') AND status <> 'delivered'`,
    );
  });
}

/** A server-side permission check and immutable audit record are required to replay. */
export async function replayOutbox(
  database: Database,
  context: ScopedTenantContext,
  input: {
    outboxId: string;
    actor: unknown;
    reason: string;
    authorize: (event: EventEnvelope) => Promise<boolean>;
  },
) {
  const actor = eventActorSchema.parse(input.actor);
  if (
    actor.type !== "user" ||
    !input.reason.trim() ||
    input.reason.length > 1000
  )
    throw new Error("Replay requires an operator and reason");
  return withTenant(database, context, async (tx) => {
    const result = await tx.execute(
      sql`SELECT * FROM domain_event_outbox WHERE id = ${ulidToUuid(input.outboxId)}::uuid FOR UPDATE`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("Outbox row not found");
    const event = eventEnvelopeSchema.parse(row.event);
    if (event.outletId)
      assertOutletInScope(context.outletScope, event.outletId);
    else if (context.outletScope.kind !== "tenant")
      throw new Error("Tenant-wide event requires tenant scope");
    if (!(await input.authorize(event)))
      throw new Error("Replay permission denied");
    if (row.dispatch_state !== "dead")
      throw new Error("Only dead-lettered events may be replayed");
    const generation = Number(row.dispatch_generation) + 1;
    await tx.execute(
      sql`UPDATE domain_event_outbox SET dispatch_state = 'ready', dispatch_generation = ${generation}, dispatch_job_id = NULL, dead_lettered_at = NULL WHERE id = ${String(row.id)}::uuid`,
    );
    await tx.execute(
      sql`INSERT INTO domain_event_replays (tenant_id, outlet_id, outbox_id, generation, actor, reason) VALUES (${event.tenantId}::uuid, ${event.outletId}::uuid, ${String(row.id)}::uuid, ${generation}, ${JSON.stringify(actor)}::jsonb, ${input.reason.trim()})`,
    );
    return generation;
  });
}

/** Serializes each outbox delivery, applies database effects and consumption in
 * one transaction, and supplies the event ID as the provider idempotency key.
 * Providers must honor that key: their external side effects cannot be rolled back. */
export async function consumeOutbox(
  database: Database,
  context: ScopedTenantContext,
  input: {
    outboxId: string;
    generation?: number;
    authorize: (event: EventEnvelope) => Promise<boolean>;
    deliver: (
      event: EventEnvelope,
      idempotencyKey: string,
      tx: Transaction,
    ) => Promise<void>;
  },
) {
  return withTenant(database, context, async (tx) => {
    const result = await tx.execute(
      sql`SELECT * FROM domain_event_outbox WHERE id = ${ulidToUuid(input.outboxId)}::uuid FOR UPDATE`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("Outbox row not found");
    const event = eventEnvelopeSchema.parse(row.event);
    if (
      Number(row.dispatch_generation) !== (input.generation ?? 0) ||
      row.dispatch_state === "dead"
    )
      throw new Error("Stale or dead-lettered job");
    if (event.tenantId !== context.tenant.tenantId)
      throw new Error("Event tenant does not match context");
    if (event.outletId)
      assertOutletInScope(context.outletScope, event.outletId);
    else if (context.outletScope.kind !== "tenant")
      throw new Error("Tenant-wide event requires tenant scope");
    if (!(await input.authorize(event)))
      throw new Error("Worker permission denied");
    const consumer = String(row.destination);
    const aggregateId = String(row.aggregate_id);
    await tx.execute(
      sql`INSERT INTO domain_event_offsets (tenant_id, outlet_id, consumer, aggregate_type, aggregate_id) VALUES (${event.tenantId}::uuid, ${event.outletId}::uuid, ${consumer}, ${event.aggregateType}, ${aggregateId}::uuid) ON CONFLICT DO NOTHING`,
    );
    const offset = await tx.execute(
      sql`SELECT last_sequence, outlet_id FROM domain_event_offsets WHERE consumer = ${consumer} AND aggregate_type = ${event.aggregateType} AND aggregate_id = ${aggregateId}::uuid FOR UPDATE`,
    );
    if (offset.rows[0]?.outlet_id !== event.outletId)
      throw new Error("Aggregate outlet changed");
    const consumed = await tx.execute(
      sql`SELECT 1 FROM domain_event_consumptions WHERE consumer = ${consumer} AND event_id = ${String(row.event_id)}::uuid`,
    );
    if (consumed.rows.length) return false;
    if (event.sequence !== Number(offset.rows[0]?.last_sequence) + 1)
      throw new Error("Aggregate sequence gap");
    await input.deliver(event, event.id, tx);
    await tx.execute(
      sql`INSERT INTO domain_event_consumptions (tenant_id, outlet_id, consumer, event_id, aggregate_type, aggregate_id, sequence) VALUES (${event.tenantId}::uuid, ${event.outletId}::uuid, ${String(row.destination)}, ${String(row.event_id)}::uuid, ${event.aggregateType}, ${String(row.aggregate_id)}::uuid, ${event.sequence})`,
    );
    await tx.execute(
      sql`UPDATE domain_event_offsets SET last_sequence = ${event.sequence}, updated_at = now() WHERE consumer = ${consumer} AND aggregate_type = ${event.aggregateType} AND aggregate_id = ${aggregateId}::uuid`,
    );
    await tx.execute(
      sql`UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now(), lease_owner = NULL, lease_until = NULL, attempts = attempts + 1 WHERE id = ${String(row.id)}::uuid`,
    );
    // The next sequence of this aggregate is claimable now; wake the relay on
    // commit instead of waiting for the next scheduled sweep.
    await tx.execute(sql`SELECT pg_notify('legend_outbox_wakeup', '')`);
    return true;
  });
}
