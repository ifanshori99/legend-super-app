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
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
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
import {
  pendingEdgePosIngests,
  redriveEdgePosIngest,
} from "../edge/shift-day-applier.ts";
import { sourceIdToDb } from "../services/inventory.service.ts";

type Database = NodePgDatabase<typeof schema>;

export const EDGE_ORDER_REDRIVE_BATCH = 200;
export const EDGE_ORDER_REDRIVE_LOCK_TIMEOUT_MS = 5_000;
const VOID_REFUSED_PREFIX = "void_refused:";

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
      if (state === "ingested") result.recovered += 1;
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
      if (voided) result.recovered += 1;
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

/** Waiting edge shifts and Tutup Hari (1269 E3) per run, oldest first. */
export const EDGE_POS_REDRIVE_BATCH = 50;

/** 1269 E3: one more try of each waiting edge shift and Tutup Hari. */
async function redrivePosIngests(
  database: Database,
  context: ScopedTenantContext,
  lockTimeoutMs: number,
  log: Pick<Console, "error">,
): Promise<EdgeOrderRedriveResult> {
  const tenantId = context.tenant.tenantId;
  const result = emptyResult();
  const rows = await withTenant(database, context, (tx) =>
    pendingEdgePosIngests(tx, context, {
      before: new Date(),
      limit: EDGE_POS_REDRIVE_BATCH,
    }),
  );
  for (const row of rows) {
    result.attempted += 1;
    try {
      const done = await inOrderTx(database, context, lockTimeoutMs, (tx) =>
        redriveEdgePosIngest(tx, context, row),
      );
      if (done) result.recovered += 1;
    } catch (error) {
      result.failed += 1;
      log.error(
        `Edge POS redrive failed for a ${row.kind} of tenant ${tenantId}: ${
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
  // After the orders: a waiting Tutup Hari compares against them.
  addTo(total, await redrivePosIngests(database, context, lockTimeoutMs, log));
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
