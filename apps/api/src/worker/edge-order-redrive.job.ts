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
/** Open receipt run conflicts of one device read per page. */
const RECEIPT_RUN_REAPPLY_PAGE = 100;
/** Pages of one device per `reapplyDevice` call (a few sweeps drain the rest). */
const RECEIPT_RUN_REAPPLY_MAX_PAGES = 5;
/** Devices with open refused runs the sweep step takes up per tick. */
const RECEIPT_RUN_SWEEP_DEVICES = 50;
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
  blocked: Set<string>,
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
          blocked,
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
 * SQL for "this conflict is an open refused receipt run of a node still in
 * service": no resolution row of any kind (a supervisor decision, or an earlier
 * heal, wins) and the node is not revoked (legend-rzt8s: a revoked node's data
 * is never applied, the same rule as `assertReplayAllowed`).
 */
const openRunConflict = (tenantId: string) => sql`
  c.tenant_id = ${tenantId}::uuid
  AND c.direction = 'edge_to_cloud'
  AND c.reason = 'applier_refused'
  AND c.aggregate_type = ${RECEIPT_RUN_AGGREGATE}
  AND c.event ->> 'name' = ${RECEIPT_RUN_REPORTED_EVENT}
  AND NOT EXISTS (
    SELECT 1 FROM edge_sync_conflict_resolutions r
    WHERE r.tenant_id = c.tenant_id AND r.conflict_id = c.id)
  AND NOT EXISTS (
    SELECT 1 FROM edge_nodes n
    WHERE n.tenant_id = c.tenant_id AND n.id = c.edge_node_id
      AND n.status = 'revoked')`;

type RunRow = {
  conflict_id: string;
  outlet_id: string;
  edge_node_id: string;
  event_id: string;
  seq: string;
  event: unknown;
};

/**
 * legend-gdjpu: the edge reporter sends a receipt run once `order.voided` is
 * ACKed, and the ACK only proves the transport. A run that reached the cloud
 * before the void (or the sale) was recovered was refused and stored as an
 * `applier_refused` conflict; the sender never requeues it. Once the order is
 * recovered, the open refused runs of the devices that reported this order
 * are applied again through the receipt run applier.
 *
 * Runs AFTER the recovery committed and never throws: a failed re-apply can
 * not undo or block the recovered void or sale (see `reapplyDevice`).
 */
async function reapplyRefusedReceiptRuns(
  database: Database,
  context: ScopedTenantContext,
  lockTimeoutMs: number,
  log: Pick<Console, "error">,
  blocked: Set<string>,
  orderId: string,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  try {
    const dbId = sourceIdToDb(orderId);
    const forms = [...new Set([orderId, dbId, uuidToUlid(dbId)])];
    const mentions = sql.join(
      forms.map(
        (form) =>
          sql`c.event -> 'payload' -> 'receipts' @> ${JSON.stringify([{ receipt: { orderId: form } }])}::jsonb`,
      ),
      sql` OR `,
    );
    const found = await withTenant(database, context, (tx) =>
      tx.execute(
        sql`SELECT DISTINCT c.aggregate_id::text AS aggregate_id
        FROM edge_sync_conflicts c
        WHERE ${openRunConflict(tenantId)} AND (${mentions})`,
      ),
    );
    for (const row of found.rows as { aggregate_id: string }[]) {
      // A device that failed in the paid phase is tried again once the void
      // phase has recovered another order of the same tick.
      blocked.delete(row.aggregate_id);
      await reapplyDevice(
        database,
        context,
        lockTimeoutMs,
        log,
        blocked,
        row.aggregate_id,
      );
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
 * legend-rzt8s: sweep step after paid and void. Devices that still have open
 * refused runs (a backlog past one call, a conflict committed after an order
 * trigger read its list, a re-apply that failed on a lock) are picked up here
 * without any order trigger. Up to RECEIPT_RUN_SWEEP_DEVICES devices a tick,
 * random order so devices that keep failing cannot starve the others. A device
 * whose run keeps failing is retried once per tick, bounded (backoff is
 * a separate card). Never throws.
 */
async function reapplyOpenReceiptRuns(
  database: Database,
  context: ScopedTenantContext,
  lockTimeoutMs: number,
  log: Pick<Console, "error">,
  blocked: Set<string>,
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  try {
    const found = await withTenant(database, context, (tx) =>
      tx.execute(
        sql`SELECT c.aggregate_id::text AS aggregate_id
        FROM edge_sync_conflicts c
        WHERE ${openRunConflict(tenantId)}
        GROUP BY c.aggregate_id
        ORDER BY random()
        LIMIT ${RECEIPT_RUN_SWEEP_DEVICES}`,
      ),
    );
    for (const row of found.rows as { aggregate_id: string }[])
      await reapplyDevice(
        database,
        context,
        lockTimeoutMs,
        log,
        blocked,
        row.aggregate_id,
      );
  } catch (error) {
    log.error(
      `Edge receipt run re-apply sweep failed for tenant ${tenantId}: ${
        error instanceof Error ? error.name : "unknown error"
      }`,
    );
  }
}

/**
 * Applies the open refused runs of one device again, in DEVICE SEQUENCE order
 * (`aggregate_sequence`, ties by event id, then conflict id; the event id alone
 * is not a device order). Pages of RECEIPT_RUN_REAPPLY_PAGE, at most
 * RECEIPT_RUN_REAPPLY_MAX_PAGES per call, and STOPS at the first failure: the
 * later runs would only hit the hole. Never throws.
 *
 * One transaction per run: it locks the conflict, then (a separate statement,
 * so Read Committed takes a new snapshot) reads its resolutions, then checks
 * the node. A conflict with ANY resolution is never touched (supervisor wins),
 * nor one of a revoked node. A refusal (still a hole, a lock timeout, ...)
 * rolls back this run only; its conflict stays open (no resolution) so a later
 * sweep or a supervisor can replay it. A healed run gets an `applied`
 * resolution in the same transaction as its apply, so it is not picked again.
 * The merge is idempotent (numbers fixed, nothing inserted twice, no journal of
 * its own), so this never double reverses or issues a number twice.
 */
async function reapplyDevice(
  database: Database,
  context: ScopedTenantContext,
  lockTimeoutMs: number,
  log: Pick<Console, "error">,
  blocked: Set<string>,
  aggregateId: string,
): Promise<void> {
  if (blocked.has(aggregateId)) return;
  const tenantId = context.tenant.tenantId;
  try {
    let after: { seq: string; eventId: string; id: string } | null = null;
    for (let page = 0; page < RECEIPT_RUN_REAPPLY_MAX_PAGES; page += 1) {
      const cursor: { seq: string; eventId: string; id: string } | null = after;
      const found = await withTenant(database, context, (tx) =>
        tx.execute(
          sql`SELECT c.id::text AS conflict_id, c.outlet_id::text AS outlet_id, c.edge_node_id::text AS edge_node_id,
                 c.event_id::text AS event_id, c.aggregate_sequence::text AS seq, c.event
          FROM edge_sync_conflicts c
          WHERE ${openRunConflict(tenantId)}
            AND c.aggregate_id = ${aggregateId}
            ${
              cursor
                ? sql`AND (c.aggregate_sequence, c.event_id, c.id) > (${cursor.seq}::bigint, ${cursor.eventId}::uuid, ${cursor.id}::uuid)`
                : sql``
            }
          ORDER BY c.aggregate_sequence, c.event_id, c.id
          LIMIT ${RECEIPT_RUN_REAPPLY_PAGE}`,
        ),
      );
      const runs = found.rows as RunRow[];
      for (const row of runs) {
        after = { seq: row.seq, eventId: row.event_id, id: row.conflict_id };
        const parsed = eventEnvelopeSchema.safeParse(row.event);
        if (!parsed.success) continue;
        const event: EventEnvelope = parsed.data;
        try {
          await inOrderTx(database, context, lockTimeoutMs, async (tx) => {
            // Lock first, as its own statement ...
            const locked = await tx.execute(
              sql`SELECT 1 FROM edge_sync_conflicts c
                  WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ${row.conflict_id}::uuid
                  FOR UPDATE OF c`,
            );
            if (locked.rows.length === 0) return;
            // ... then read the decisions with a fresh snapshot: a supervisor
            // may have committed one while this waited for the lock.
            const decided = await tx.execute(
              sql`SELECT 1 FROM edge_sync_conflict_resolutions r
                  WHERE r.tenant_id = ${tenantId}::uuid AND r.conflict_id = ${row.conflict_id}::uuid
                  LIMIT 1`,
            );
            if (decided.rows.length > 0) return;
            const node = await tx.execute(
              sql`SELECT status FROM edge_nodes
                  WHERE tenant_id = ${tenantId}::uuid AND id = ${row.edge_node_id}::uuid
                  FOR SHARE`,
            );
            if (node.rows[0]?.status === "revoked") return;
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
          blocked.add(aggregateId);
          return;
        }
      }
      if (runs.length < RECEIPT_RUN_REAPPLY_PAGE) return;
    }
  } catch (error) {
    blocked.add(aggregateId);
    log.error(
      `Edge receipt run re-apply failed for a device of tenant ${tenantId}: ${
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
  blocked: Set<string>,
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
          blocked,
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
  // Devices whose re-apply failed during this tick: not retried again in it.
  const blocked = new Set<string>();
  addTo(
    total,
    await redrivePaid(database, context, lockTimeoutMs, log, blocked),
  );
  addTo(
    total,
    await redriveVoided(database, context, lockTimeoutMs, log, blocked),
  );
  await reapplyOpenReceiptRuns(database, context, lockTimeoutMs, log, blocked);
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
