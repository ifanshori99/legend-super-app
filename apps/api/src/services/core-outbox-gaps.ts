import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertTrustedScopedContext,
  ulidToUuid,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import type { GapRequest } from "./core-outbox.ts";

type Database = NodePgDatabase<typeof schema>;

/**
 * Record (idempotently) that a destination is missing an outbox sequence.
 * Never skips the sequence: the record feeds a throttled alert and is resolved
 * by `resolveFilledOutboxGaps` once the consumer offset has passed the gap.
 */
export async function recordOutboxGapRequest(
  database: Database,
  context: ScopedTenantContext,
  gap: GapRequest,
): Promise<{ requestCount: number }> {
  assertTrustedScopedContext(context);
  const aggregateId = uuidSchema.safeParse(gap.aggregateId).success
    ? gap.aggregateId
    : ulidToUuid(gap.aggregateId);
  const requestCount = await withTenant(database, context, async (tx) => {
    const result = await tx.execute(
      sql`INSERT INTO domain_event_gap_requests (tenant_id, outlet_id, destination, aggregate_type, aggregate_id, missing_sequence) VALUES (${context.tenant.tenantId}::uuid, (SELECT o.outlet_id FROM domain_event_outbox o WHERE o.tenant_id = ${context.tenant.tenantId}::uuid AND o.destination = ${gap.destination} AND o.aggregate_type = ${gap.aggregateType} AND o.aggregate_id = ${aggregateId}::uuid ORDER BY o.sequence LIMIT 1), ${gap.destination}, ${gap.aggregateType}, ${aggregateId}::uuid, ${gap.missingSequence}) ON CONFLICT (tenant_id, destination, aggregate_type, aggregate_id, missing_sequence) DO UPDATE SET request_count = domain_event_gap_requests.request_count + 1, last_requested_at = now(), resolved_at = NULL RETURNING request_count`,
    );
    return Number((result.rows[0] as { request_count: number }).request_count);
  });
  // Throttle the alert: first request, then each power of two.
  if ((requestCount & (requestCount - 1)) === 0)
    console.error(
      `Outbox sequence gap: destination=${gap.destination} aggregateType=${gap.aggregateType} missingSequence=${gap.missingSequence} requests=${requestCount}`,
    );
  return { requestCount };
}

/** Mark open gap requests resolved once the consumer offset has passed them. */
export async function resolveFilledOutboxGaps(
  database: Database,
  context: ScopedTenantContext,
): Promise<number> {
  assertTrustedScopedContext(context);
  return withTenant(database, context, async (tx) => {
    const result = await tx.execute(
      sql`UPDATE domain_event_gap_requests g SET resolved_at = now() WHERE g.resolved_at IS NULL AND EXISTS (SELECT 1 FROM domain_event_offsets x WHERE x.tenant_id = g.tenant_id AND x.consumer = g.destination AND x.aggregate_type = g.aggregate_type AND x.aggregate_id = g.aggregate_id AND x.last_sequence >= g.missing_sequence)`,
    );
    return result.rowCount ?? 0;
  });
}
