import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  outletIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import type * as schema from "../db/schema";
import { withTenant } from "../db/tenant";
import { logger } from "../lib/logger";
import { notifyOutletSupervisors } from "./edge-sync-conflict-alert";

type Database = NodePgDatabase<typeof schema>;
type Options = { destinations?: readonly string[] };

/** Heads that are dead and actually hold at least one later event. */
function blockedHeadsQuery(
  context: ScopedTenantContext,
  options: Options,
  select: "rows" | "count",
) {
  const outletFilter =
    context.outletScope.kind === "tenant"
      ? sql`TRUE`
      : sql`o.outlet_id = ANY(${`{${context.outletScope.outletIds.join(",")}}`}::uuid[])`;
  const destinationFilter = options.destinations
    ? sql`o.destination = ANY(${`{${options.destinations.join(",")}}`}::text[])`
    : sql`TRUE`;
  const columns =
    select === "count"
      ? sql`count(*)::int AS blocked_count`
      : sql`o.id, o.destination, o.aggregate_type, o.aggregate_id, o.outlet_id, o.sequence, o.dispatch_generation`;
  return sql`
      SELECT ${columns}
      FROM domain_event_outbox o
      LEFT JOIN domain_event_offsets x ON x.tenant_id = o.tenant_id AND x.consumer = o.destination
        AND x.aggregate_type = o.aggregate_type AND x.aggregate_id = o.aggregate_id
      WHERE o.tenant_id = ${context.tenant.tenantId}::uuid AND ${outletFilter} AND ${destinationFilter}
        AND o.dispatch_state = 'dead' AND o.status <> 'delivered'
        AND o.sequence = COALESCE(x.last_sequence, 0) + 1
        AND EXISTS (SELECT 1 FROM domain_event_outbox later
          WHERE later.tenant_id = o.tenant_id AND later.destination = o.destination
            AND later.aggregate_type = o.aggregate_type AND later.aggregate_id = o.aggregate_id
            AND later.sequence > o.sequence AND later.status <> 'delivered')
    `;
}

/** Current gauge, computed from durable state rather than process-local counters. */
export async function countBlockedOutboxAggregates(
  database: Database,
  context: ScopedTenantContext,
  options: Options = {},
): Promise<number> {
  return withTenant(database, context, async (tx) => {
    const result = await tx.execute(
      blockedHeadsQuery(context, options, "count"),
    );
    return Number(result.rows[0]?.blocked_count ?? 0);
  });
}

/** One stable notification per tenant, destination and aggregate. */
export async function alertBlockedOutboxAggregates(
  database: Database,
  context: ScopedTenantContext,
  options: Options = {},
): Promise<number> {
  const heads = await withTenant(
    database,
    context,
    async (tx) =>
      (await tx.execute(blockedHeadsQuery(context, options, "rows"))).rows,
  );
  for (const head of heads) {
    try {
      const destination = String(head.destination);
      const aggregateType = String(head.aggregate_type);
      const aggregateId = String(head.aggregate_id);
      const outboxId = uuidToUlid(String(head.id));
      const hex = createHash("sha256")
        .update(
          JSON.stringify([
            "edge_outbox.blocked",
            context.tenant.tenantId,
            destination,
            aggregateType,
            aggregateId,
            head.sequence,
            head.dispatch_generation,
          ]),
        )
        .digest("hex")
        .slice(0, 32);
      const alertId = uuidToUlid(
        `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
      );
      await withTenant(database, context, (tx) =>
        notifyOutletSupervisors(
          tx,
          context,
          {
            tenantId: context.tenant.tenantId,
            outletId:
              head.outlet_id == null
                ? null
                : outletIdSchema.parse(head.outlet_id),
            id: alertId,
            eventName: "edge_outbox.blocked",
            aggregateType: "edge_outbox",
            aggregateId: alertId,
            payload: { destination, aggregateType, aggregateId, outboxId },
            title: "Sinkronisasi tertahan",
            body: `Event ${outboxId} gagal dan menahan sinkronisasi berikutnya. Periksa antrean event.`,
          },
          new Date(),
        ),
      );
    } catch (err) {
      logger.warn({ err }, "Edge outbox blocked aggregate notification failed");
    }
  }
  return heads.length;
}
