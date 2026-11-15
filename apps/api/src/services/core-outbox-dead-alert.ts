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

export const BLOCKED_ALERT_BATCH_SIZE = 100;
// A fixed upper bound makes each cycle finite even while new heads arrive.
// Failed heads are retried on the next cycle; later heads still get a turn.
// This is an optimization, so losing the cursor on restart is safe.
type SweepCursor = { afterId: string; throughId: string };
const sweepCursors = new Map<string, SweepCursor>();
const MAX_SWEEP_CURSORS = 1000;

/** Heads that are dead and actually hold at least one later event. */
function blockedHeadsQuery(
  context: ScopedTenantContext,
  options: Options,
  select: "rows" | "count" | "last",
  afterId?: string,
  throughId?: string,
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
  // Node PostgreSQL returns bigint sequence as a string. Construct exactly the
  // JSON used by the original SHA-256 alert ID so existing markers still match.
  const alertId = sql`substring(encode(sha256(convert_to(
    '["edge_outbox.blocked",' || to_json(o.tenant_id::text)::text || ',' ||
    to_json(o.destination)::text || ',' || to_json(o.aggregate_type)::text || ',' ||
    to_json(o.aggregate_id::text)::text || ',' || to_json(o.sequence::text)::text || ',' ||
    o.dispatch_generation::text || ']', 'UTF8')), 'hex') from 1 for 32)::uuid`;
  const pendingOnly =
    select !== "count"
      ? sql`AND NOT EXISTS (
    SELECT 1 FROM notification_outbox n
    WHERE n.tenant_id = o.tenant_id AND n.source_event_id = ${alertId}
  )`
      : sql``;
  const cursorFilter = afterId ? sql`AND o.id > ${afterId}::uuid` : sql``;
  const endFilter = throughId ? sql`AND o.id <= ${throughId}::uuid` : sql``;
  const batch =
    select === "count"
      ? sql``
      : select === "last"
        ? sql`ORDER BY o.id DESC LIMIT 1`
        : sql`ORDER BY o.id LIMIT ${BLOCKED_ALERT_BATCH_SIZE}`;
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
        ${pendingOnly}
        ${cursorFilter}
        ${endFilter}
      ${batch}
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
  const cursorKey = JSON.stringify([
    context.tenant.tenantId,
    context.outletScope,
    options.destinations,
  ]);
  const cursor = sweepCursors.get(cursorKey);
  const { heads, throughId } = await withTenant(
    database,
    context,
    async (tx) => {
      if (cursor) {
        const page = (
          await tx.execute(
            blockedHeadsQuery(
              context,
              options,
              "rows",
              cursor.afterId,
              cursor.throughId,
            ),
          )
        ).rows;
        if (page.length) return { heads: page, throughId: cursor.throughId };
      }
      const last = (
        await tx.execute(blockedHeadsQuery(context, options, "last"))
      ).rows[0];
      if (!last) return { heads: [], throughId: undefined };
      const endId = String(last.id);
      const page = (
        await tx.execute(
          blockedHeadsQuery(context, options, "rows", undefined, endId),
        )
      ).rows;
      return { heads: page, throughId: endId };
    },
  );
  if (heads.length && throughId) {
    if (
      !sweepCursors.has(cursorKey) &&
      sweepCursors.size >= MAX_SWEEP_CURSORS
    ) {
      const oldest = sweepCursors.keys().next().value;
      if (oldest !== undefined) sweepCursors.delete(oldest);
    }
    sweepCursors.set(cursorKey, {
      afterId: String(heads[heads.length - 1]?.id),
      throughId,
    });
  } else {
    sweepCursors.delete(cursorKey);
  }
  for (const head of heads) {
    try {
      const destination = String(head.destination);
      const aggregateType = String(head.aggregate_type);
      const aggregateId = String(head.aggregate_id);
      const outboxId = uuidToUlid(String(head.id));
      // The selected head may have been processed by a concurrent sweep.
      const alertKey = JSON.stringify([
        "edge_outbox.blocked",
        context.tenant.tenantId,
        destination,
        aggregateType,
        aggregateId,
        head.sequence,
        head.dispatch_generation,
      ]);
      const hex = createHash("sha256")
        .update(alertKey)
        .digest("hex")
        .slice(0, 32);
      const alertUuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const alertId = uuidToUlid(alertUuid);
      await withTenant(database, context, async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.tenant.tenantId}:${alertUuid}`}, 0))`,
        );
        const existing = await tx.execute(
          sql`SELECT 1 FROM notification_outbox WHERE tenant_id = ${context.tenant.tenantId}::uuid AND source_event_id = ${alertUuid}::uuid LIMIT 1`,
        );
        if (existing.rows.length) return;
        const delivered = await notifyOutletSupervisors(
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
            recordEmpty: true,
          },
          new Date(),
        );
        if (!delivered) {
          // Log before the marker commits: a crash must not silently suppress
          // the alert. A later rollback may cause the log to repeat on retry.
          logger.error(
            { tenantId: context.tenant.tenantId, outboxId },
            "Edge outbox blocked aggregate has no alert recipients",
          );
        }
      });
    } catch (err) {
      logger.warn({ err }, "Edge outbox blocked aggregate notification failed");
    }
  }
  return heads.length;
}
