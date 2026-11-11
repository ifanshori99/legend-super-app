import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertTrustedScopedContext,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type { OutboxGap } from "@starter/shared/platform";
import type * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { HttpError } from "../lib/http-error.ts";
import { recordAudit } from "./audit-writer.ts";

type Database = NodePgDatabase<typeof schema>;

type GapRow = {
  id: string;
  outlet_id: string | null;
  destination: string;
  aggregate_type: string;
  aggregate_id: string;
  missing_sequence: string | number;
  request_count: number;
  first_requested_at: Date | string;
  last_requested_at: Date | string;
};

const iso = (value: Date | string) => new Date(value).toISOString();

/** Open (unresolved) gap records of the context's tenant, oldest first. */
export async function listOpenOutboxGaps(
  database: Database,
  context: ScopedTenantContext,
  limit = 50,
): Promise<OutboxGap[]> {
  assertTrustedScopedContext(context);
  return withTenant(database, context, async (tx) => {
    const result = await tx.execute(
      sql`SELECT id, destination, aggregate_type, aggregate_id, missing_sequence, request_count, first_requested_at, last_requested_at FROM domain_event_gap_requests WHERE tenant_id = ${context.tenant.tenantId}::uuid AND resolved_at IS NULL ORDER BY first_requested_at, id LIMIT ${limit}`,
    );
    return (result.rows as GapRow[]).map((row) => ({
      id: row.id,
      destination: row.destination,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      missingSequence: Number(row.missing_sequence),
      requestCount: Number(row.request_count),
      firstRequestedAt: iso(row.first_requested_at),
      lastRequestedAt: iso(row.last_requested_at),
    }));
  });
}

/**
 * Operator action: skip one open gap. Moves the consumer offset to the missing
 * sequence so the aggregate's next event can flow, marks the gap resolved and
 * writes `outbox_gap.skipped` with the reason in the same tenant transaction.
 *
 * Refused (409) when the gap is already resolved, when it is not the very next
 * sequence the consumer waits for (skipping a later one would lose events
 * silently), or when the event is in the outbox after all (nothing to skip:
 * the relay delivers it and `resolveFilledOutboxGaps` closes the gap).
 * A skipped event is never delivered to that destination.
 */
export async function skipOutboxGap(
  database: Database,
  context: ScopedTenantContext,
  gapId: string,
  input: { reason: string },
  actorUserId: string,
): Promise<OutboxGap> {
  assertTrustedScopedContext(context);
  const id = uuidSchema.parse(gapId);
  const reason = input.reason.trim();
  if (reason.length < 10)
    throw new HttpError(422, "VALIDATION_ERROR", "Give a reason.");
  return withTenant(database, context, async (tx) => {
    const found = await tx.execute(
      sql`SELECT id, outlet_id, destination, aggregate_type, aggregate_id, missing_sequence, request_count, first_requested_at, last_requested_at, resolved_at FROM domain_event_gap_requests WHERE tenant_id = ${context.tenant.tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`,
    );
    const row = found.rows[0] as
      (GapRow & { resolved_at: unknown }) | undefined;
    if (!row) throw new HttpError(404, "NOT_FOUND", "Gap not found.");
    if (row.resolved_at)
      throw new HttpError(409, "CONFLICT", "This gap is already resolved.");
    const missing = Number(row.missing_sequence);

    await tx.execute(
      sql`INSERT INTO domain_event_offsets (tenant_id, outlet_id, consumer, aggregate_type, aggregate_id) VALUES (${context.tenant.tenantId}::uuid, ${row.outlet_id}::uuid, ${row.destination}, ${row.aggregate_type}, ${row.aggregate_id}::uuid) ON CONFLICT DO NOTHING`,
    );
    const offset = await tx.execute(
      sql`SELECT last_sequence FROM domain_event_offsets WHERE tenant_id = ${context.tenant.tenantId}::uuid AND consumer = ${row.destination} AND aggregate_type = ${row.aggregate_type} AND aggregate_id = ${row.aggregate_id}::uuid FOR UPDATE`,
    );
    const previous = Number(
      (offset.rows[0] as { last_sequence: string | number }).last_sequence,
    );
    if (previous + 1 !== missing)
      throw new HttpError(
        409,
        "CONFLICT",
        "Only the next missing sequence can be skipped.",
      );
    const present = await tx.execute(
      sql`SELECT 1 FROM domain_event_outbox WHERE tenant_id = ${context.tenant.tenantId}::uuid AND destination = ${row.destination} AND aggregate_type = ${row.aggregate_type} AND aggregate_id = ${row.aggregate_id}::uuid AND sequence = ${missing} LIMIT 1`,
    );
    if (present.rows.length)
      throw new HttpError(
        409,
        "CONFLICT",
        "The event exists in the outbox; nothing to skip.",
      );

    await tx.execute(
      sql`UPDATE domain_event_offsets SET last_sequence = ${missing}, updated_at = now() WHERE tenant_id = ${context.tenant.tenantId}::uuid AND consumer = ${row.destination} AND aggregate_type = ${row.aggregate_type} AND aggregate_id = ${row.aggregate_id}::uuid`,
    );
    await tx.execute(
      sql`UPDATE domain_event_gap_requests SET resolved_at = now() WHERE tenant_id = ${context.tenant.tenantId}::uuid AND id = ${id}::uuid`,
    );
    await recordAudit(
      {
        tenantId: context.tenant.tenantId,
        outletId: row.outlet_id,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: "outbox_gap.skipped",
        objectType: "outbox_gap",
        objectId: id,
        reason,
        before: {
          destination: row.destination,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          missingSequence: missing,
          previousSequence: previous,
          requestCount: Number(row.request_count),
        },
        after: {
          destination: row.destination,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          missingSequence: missing,
          previousSequence: missing,
          requestCount: Number(row.request_count),
        },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return {
      id,
      destination: row.destination,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      missingSequence: missing,
      requestCount: Number(row.request_count),
      firstRequestedAt: iso(row.first_requested_at),
      lastRequestedAt: iso(row.last_requested_at),
    };
  });
}
