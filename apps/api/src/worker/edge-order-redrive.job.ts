// Edge order ingest redrive sweep (bead legend-132mw, design
// docs/briefs/656-edge-sales-gl-design.md item 6). An `order.paid` or
// `order.voided` parked from an edge is ingested inside the link's receive
// transaction. When the ingest is refused for a transient reason (lock_failed,
// or SQLSTATE 40P01 / 55P03 / 40001, see `isTransientReason`) the ledger keeps
// a `refused` row, and the link never redelivers an event it already recorded.
// This sweep reads the parked envelope again and runs the same ingest entry
// point, so a sale stuck on a lock timeout becomes a cloud order without an
// operator touching SQL.
//
// Safe to run any number of times: the ingest is idempotent per order (ledger
// row plus consumer idempotency keys). A retry that fails again records its
// new reason on the ledger row (order-ingest.ts); a final reason (23505,
// legacy_payload, ...) is never selected. Each order runs in its own tenant
// transaction with a bounded `lock_timeout`, so one busy order never stalls
// the others. Log lines carry counts and tenant ids only, never payloads.
//
// Tenant-scoped like the other cloud sweeps; worker-main.ts runs it on the
// relay tick of every tenant, cloud only (never on an edge node).

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  assertTrustedScopedContext,
  createUlid,
  uuidToUlid,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import {
  RECEIPT_RUN_AGGREGATE,
  RECEIPT_RUN_REPORTED_EVENT,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import type * as schema from "../db/schema/index.ts";
import { edgeDeferredEvents } from "../db/schema/edge-deferred-event.ts";
import { edgeOrderIngests } from "../db/schema/edge-order-ingest.ts";
import { withTenant } from "../db/tenant.ts";
import {
  ingestEdgeOrderPaid,
  ingestEdgeOrderVoided,
  TRANSIENT_REFUSAL_REASONS,
} from "../edge/order-ingest.ts";
import type { EdgeApplyMeta } from "../edge/ports.ts";
import { sourceIdToDb } from "../services/inventory.service.ts";
import { applyReceiptRunReported } from "../edge/receipt-run-applier.ts";

type Database = NodePgDatabase<typeof schema>;

export const EDGE_ORDER_REDRIVE_BATCH = 200;
export const EDGE_ORDER_REDRIVE_LOCK_TIMEOUT_MS = 5_000;
const VOID_REFUSED_PREFIX = "void_refused:";
/** Most refused receipt run events re-applied for one recovered void. */
const RECEIPT_RUN_REAPPLY_LIMIT = 100;
/** `resolved_by` of the resolution row the redrive writes for a healed run. */
const REAPPLY_RESOLVED_BY = "system:edge-order-redrive";

export type EdgeOrderRedriveDeps = {
  database?: Database;
  log?: Pick<Console, "error">;
  /** Per-order `lock_timeout`; a lock held longer is a fresh `lock_failed`. */
  lockTimeoutMs?: number;
  /** Test hook; defaults to the active tenant registry. */
  listTenantIds?: () => Promise<string[]>;
};

export type EdgeOrderRedriveResult = {
  /** Orders whose parked event was run through the ingest again. */
  attempted: number;
  /** Of those, orders that are now ingested (paid) or voided (void). */
  recovered: number;
  /** Orders whose redrive threw outside the ingest (the next run retries). */
  failed: number;
};

const emptyResult = (): EdgeOrderRedriveResult => ({
  attempted: 0,
  recovered: 0,
  failed: 0,
});

function addTo(total: EdgeOrderRedriveResult, part: EdgeOrderRedriveResult) {
  total.attempted += part.attempted;
  total.recovered += part.recovered;
  total.failed += part.failed;
}

async function activeTenantIds(database: Database): Promise<string[]> {
  const result = await database.execute(
    sql`SELECT id FROM app.active_tenant_registry`,
  );
  return result.rows.map((row) => String(row.id));
}

function jobContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "job" }),
    { kind: "tenant" },
  );
}

type ParkedRow = {
  orderId: string;
  edgeNodeId: string;
  envelope: (typeof edgeDeferredEvents.$inferSelect)["envelope"];
};

const metaOf = (
  context: ScopedTenantContext,
  edgeNodeId: string,
): EdgeApplyMeta => ({
  edgeNodeId,
  direction: "edge_to_cloud",
  kind: "transaction_event",
  context,
});

/** Runs `work` in one tenant transaction that never waits long for a lock. */
function inOrderTx<T>(
  database: Database,
  context: ScopedTenantContext,
  lockTimeoutMs: number,
  work: (tx: OrderTx) => Promise<T>,
): Promise<T> {
  return withTenant(database, context, async (tx) => {
    await tx.execute(
      sql`SELECT set_config('lock_timeout', ${`${Math.max(1, Math.floor(lockTimeoutMs))}ms`}, true)`,
    );
    return work(tx);
  });
}

/** Parked `order.paid` of the refused-transient ledger rows. */
async function paidCandidates(
  database: Database,
  context: ScopedTenantContext,
): Promise<ParkedRow[]> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, (tx) =>
    tx
      .select({
        orderId: edgeOrderIngests.orderId,
        edgeNodeId: edgeDeferredEvents.edgeNodeId,
        envelope: edgeDeferredEvents.envelope,
      })
      .from(edgeOrderIngests)
      .innerJoin(
        edgeDeferredEvents,
        and(
          eq(edgeDeferredEvents.tenantId, edgeOrderIngests.tenantId),
          eq(edgeDeferredEvents.eventId, edgeOrderIngests.paidEventId),
          eq(edgeDeferredEvents.eventName, "order.paid"),
        ),
      )
      .where(
        and(
          eq(edgeOrderIngests.tenantId, tenantId),
          eq(edgeOrderIngests.state, "refused"),
          inArray(edgeOrderIngests.reason, [...TRANSIENT_REFUSAL_REASONS]),
        ),
      )
      .orderBy(asc(edgeOrderIngests.updatedAt))
      .limit(EDGE_ORDER_REDRIVE_BATCH),
  );
}

async function redrivePaid(
  database: Database,
  context: ScopedTenantContext,
  lockTimeoutMs: number,
  log: Pick<Console, "error">,
): Promise<EdgeOrderRedriveResult> {
  const tenantId = context.tenant.tenantId;
  const result = emptyResult();
  for (const row of await paidCandidates(database, context)) {
    result.attempted += 1;
    try {
      const state = await inOrderTx(
        database,
        context,
        lockTimeoutMs,
        async (tx) => {
          await ingestEdgeOrderPaid(
            tx,
            row.envelope,
            metaOf(context, row.edgeNodeId),
          );
          const [ledger] = await tx
            .select({ state: edgeOrderIngests.state })
            .from(edgeOrderIngests)
            .where(
              and(
                eq(edgeOrderIngests.tenantId, tenantId),
                eq(edgeOrderIngests.orderId, row.orderId),
              ),
            );
          // A void that hit order_not_ingested while the paid was refused left
          // no trace but the parked event: ingest it now, or the outlet keeps
          // the PBJT and points of a voided sale.
          if (ledger?.state === "ingested")
            await ingestParkedVoids(tx, context, row.orderId);
          return ledger?.state;
        },
      );
      if (state === "ingested") {
        result.recovered += 1;
        // legend-gdjpu: a run refused earlier (the sale was not in the cloud
        // yet) can apply now. After the commit, never part of the recovery.
        await reapplyRefusedReceiptRuns(
          database,
          context,
          lockTimeoutMs,
          log,
          row.orderId,
        );
      }
    } catch (error) {
      result.failed += 1;
      log.error(
        `Edge order redrive failed for an order of tenant ${tenantId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  return result;
}

type OrderTx = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * legend-gdjpu: the edge reporter sends a receipt run once `order.voided` is
 * ACKed, and the ACK only proves the transport. A run that reached the cloud
 * before the void (or the sale) was recovered was refused and stored as an
 * `applier_refused` conflict; the sender never requeues it. Once the order is
 * recovered, the refused run events of the devices that reported this order
 * are applied again, in event order, through the receipt run applier.
 *
 * Runs AFTER the recovery committed, one transaction per run, and never
 * throws: a failed re-apply (lock timeout, a hole still open, anything) can
 * not undo or block the recovered void or sale. Its conflict stays open (no
 * resolution), so a supervisor can still replay it by hand. A
 * conflict that already has a resolution row (a supervisor decision, or an
 * earlier heal) is never touched. A healed run gets an `applied` resolution
 * in the same transaction as its apply, so it is not picked again. The merge
 * is idempotent (numbers fixed, nothing inserted twice, no journal of its
 * own), so this never double reverses or issues a number twice.
 */
async function reapplyRefusedReceiptRuns(
  database: Database,
  context: ScopedTenantContext,
  lockTimeoutMs: number,
  log: Pick<Console, "error">,
  orderId: string,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  try {
    const dbId = sourceIdToDb(orderId);
    const forms = [...new Set([orderId, dbId, uuidToUlid(dbId)])];
    const mentions = sql.join(
      forms.map(
        (form) =>
          sql`event -> 'payload' -> 'receipts' @> ${JSON.stringify([{ receipt: { orderId: form } }])}::jsonb`,
      ),
      sql` OR `,
    );
    const found = await withTenant(database, context, (tx) =>
      tx.execute(
        sql`SELECT id::text AS conflict_id, outlet_id::text AS outlet_id, edge_node_id::text AS edge_node_id, event
        FROM edge_sync_conflicts
        WHERE tenant_id = ${tenantId}::uuid
          AND direction = 'edge_to_cloud'
          AND reason = 'applier_refused'
          AND aggregate_type = ${RECEIPT_RUN_AGGREGATE}
          AND event ->> 'name' = ${RECEIPT_RUN_REPORTED_EVENT}
          AND NOT EXISTS (
            SELECT 1 FROM edge_sync_conflict_resolutions r
            WHERE r.tenant_id = edge_sync_conflicts.tenant_id
              AND r.conflict_id = edge_sync_conflicts.id)
          AND aggregate_id IN (
            SELECT aggregate_id FROM edge_sync_conflicts
            WHERE tenant_id = ${tenantId}::uuid
              AND direction = 'edge_to_cloud'
              AND reason = 'applier_refused'
              AND aggregate_type = ${RECEIPT_RUN_AGGREGATE}
              AND event ->> 'name' = ${RECEIPT_RUN_REPORTED_EVENT}
              AND (${mentions}))
        ORDER BY event_id
        LIMIT ${RECEIPT_RUN_REAPPLY_LIMIT}`,
      ),
    );
    for (const row of found.rows as {
      conflict_id: string;
      outlet_id: string;
      edge_node_id: string;
      event: unknown;
    }[]) {
      const parsed = eventEnvelopeSchema.safeParse(row.event);
      if (!parsed.success) continue;
      const event: EventEnvelope = parsed.data;
      try {
        await inOrderTx(database, context, lockTimeoutMs, async (tx) => {
          // Lock the conflict and re-check: a supervisor may have decided it
          // since the list was read.
          const open = await tx.execute(
            sql`SELECT 1 FROM edge_sync_conflicts c
                WHERE c.tenant_id = ${tenantId}::uuid
                  AND c.id = ${row.conflict_id}::uuid
                  AND NOT EXISTS (
                    SELECT 1 FROM edge_sync_conflict_resolutions r
                    WHERE r.tenant_id = c.tenant_id AND r.conflict_id = c.id)
                FOR UPDATE OF c`,
          );
          if (open.rows.length === 0) return;
          // A refusal (still a hole, ...) throws and rolls back this run only.
          await applyReceiptRunReported(
            tx,
            event,
            metaOf(context, row.edge_node_id),
          );
          await tx.execute(
            sql`INSERT INTO edge_sync_conflict_resolutions (id, tenant_id, outlet_id, conflict_id, action, outcome, note, resolved_by)
                VALUES (${ulidToUuid(createUlid())}::uuid, ${tenantId}::uuid, ${row.outlet_id}::uuid, ${row.conflict_id}::uuid, 'replayed', 'applied', ${"Receipt run applied again after the order was recovered"}, ${REAPPLY_RESOLVED_BY})`,
          );
        });
      } catch (error) {
        // Counts and ids only: a payload never reaches the log.
        log.error(
          `Edge receipt run re-apply failed for conflict ${row.conflict_id} of tenant ${tenantId}: ${
            error instanceof Error ? error.name : "unknown error"
          }`,
        );
      }
    }
  } catch (error) {
    log.error(
      `Edge receipt run re-apply failed for an order of tenant ${tenantId}: ${
        error instanceof Error ? error.name : "unknown error"
      }`,
    );
  }
}

/**
 * Runs the parked `order.voided` events of one order through the ingest, in
 * sequence order. True once the order is voided; the stale refusal note on
 * the ledger row is then cleared.
 */
async function ingestParkedVoids(
  tx: OrderTx,
  context: ScopedTenantContext,
  orderId: string,
): Promise<boolean> {
  const tenantId = context.tenant.tenantId;
  const dbId = sourceIdToDb(orderId);
  const parked = await tx
    .select({
      edgeNodeId: edgeDeferredEvents.edgeNodeId,
      envelope: edgeDeferredEvents.envelope,
    })
    .from(edgeDeferredEvents)
    .where(
      and(
        eq(edgeDeferredEvents.tenantId, tenantId),
        eq(edgeDeferredEvents.aggregateType, "order"),
        eq(edgeDeferredEvents.eventName, "order.voided"),
        inArray(edgeDeferredEvents.aggregateId, [
          ...new Set([orderId, dbId, uuidToUlid(dbId)]),
        ]),
      ),
    )
    .orderBy(asc(edgeDeferredEvents.aggregateSequence));
  for (const event of parked) {
    await ingestEdgeOrderVoided(
      tx,
      event.envelope,
      metaOf(context, event.edgeNodeId),
    );
    const [ledger] = await tx
      .select({ state: edgeOrderIngests.state })
      .from(edgeOrderIngests)
      .where(
        and(
          eq(edgeOrderIngests.tenantId, tenantId),
          eq(edgeOrderIngests.orderId, orderId),
        ),
      );
    if (ledger?.state === "voided") {
      // The void went through: the old refusal note is stale.
      await tx
        .update(edgeOrderIngests)
        .set({ reason: null, updatedAt: new Date() })
        .where(
          and(
            eq(edgeOrderIngests.tenantId, tenantId),
            eq(edgeOrderIngests.orderId, orderId),
          ),
        );
      return true;
    }
  }
  return false;
}

/**
 * Ledger rows whose void was refused for a transient reason. The transient
 * filter is in SQL so old final rows (`void_refused:already_voided`, ...)
 * never fill the batch and starve the rows that can still recover.
 */
async function voidCandidates(
  database: Database,
  context: ScopedTenantContext,
): Promise<{ orderId: string }[]> {
  const tenantId = context.tenant.tenantId;
  return withTenant(database, context, (tx) =>
    tx
      .select({ orderId: edgeOrderIngests.orderId })
      .from(edgeOrderIngests)
      .where(
        and(
          eq(edgeOrderIngests.tenantId, tenantId),
          eq(edgeOrderIngests.state, "ingested"),
          inArray(
            edgeOrderIngests.reason,
            TRANSIENT_REFUSAL_REASONS.map(
              (reason) => `${VOID_REFUSED_PREFIX}${reason}`,
            ),
          ),
        ),
      )
      .orderBy(asc(edgeOrderIngests.updatedAt))
      .limit(EDGE_ORDER_REDRIVE_BATCH),
  );
}

async function redriveVoided(
  database: Database,
  context: ScopedTenantContext,
  lockTimeoutMs: number,
  log: Pick<Console, "error">,
): Promise<EdgeOrderRedriveResult> {
  const tenantId = context.tenant.tenantId;
  const result = emptyResult();
  for (const { orderId } of await voidCandidates(database, context)) {
    result.attempted += 1;
    try {
      const voided = await inOrderTx(database, context, lockTimeoutMs, (tx) =>
        ingestParkedVoids(tx, context, orderId),
      );
      if (voided) {
        result.recovered += 1;
        // After the void committed: a failed re-apply never undoes it.
        await reapplyRefusedReceiptRuns(
          database,
          context,
          lockTimeoutMs,
          log,
          orderId,
        );
      }
    } catch (error) {
      result.failed += 1;
      log.error(
        `Edge order void redrive failed for an order of tenant ${tenantId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  return result;
}

/** Redrives the transient-refused edge orders and voids of one tenant. */
export async function redriveEdgeOrderRefusalsForTenant(
  context: ScopedTenantContext,
  deps: Omit<EdgeOrderRedriveDeps, "listTenantIds"> = {},
): Promise<EdgeOrderRedriveResult> {
  assertTrustedScopedContext(context);
  const database = deps.database ?? db;
  const log = deps.log ?? console;
  const lockTimeoutMs =
    deps.lockTimeoutMs ?? EDGE_ORDER_REDRIVE_LOCK_TIMEOUT_MS;
  const total = emptyResult();
  addTo(total, await redrivePaid(database, context, lockTimeoutMs, log));
  addTo(total, await redriveVoided(database, context, lockTimeoutMs, log));
  return total;
}

/** Redrives every active tenant. One tenant's failure never stops the others. */
export async function redriveEdgeOrderRefusals(
  deps: EdgeOrderRedriveDeps = {},
): Promise<EdgeOrderRedriveResult> {
  const database = deps.database ?? db;
  const log = deps.log ?? console;
  const tenantIds = await (
    deps.listTenantIds ?? (() => activeTenantIds(database))
  )();
  const total = emptyResult();
  for (const tenantId of tenantIds) {
    try {
      addTo(
        total,
        await redriveEdgeOrderRefusalsForTenant(jobContext(tenantId), {
          ...deps,
          database,
          log,
        }),
      );
    } catch (error) {
      total.failed += 1;
      log.error(
        `Edge order redrive failed for tenant ${tenantId}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  }
  return total;
}
