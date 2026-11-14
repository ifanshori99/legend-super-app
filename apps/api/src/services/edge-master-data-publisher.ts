// Durable cloud-to-edge full-state catalog publication. The cursor and the
// link queue advance together; an interrupted pass is retried on restart.
import { and, eq, sql } from "drizzle-orm";
import { CoreError, createUlid, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  CATALOG_SYNC_STREAMS,
  catalogRecordUpdatedEvent,
  type CatalogSyncStream,
} from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { catalogRecordIdFromKeys } from "../lib/edge-catalog-identity.ts";
import { logger } from "../lib/logger.ts";
import { outletContext } from "./device-pin-support.ts";
import { listCatalogRecordsSinceTx } from "./edge-catalog-sync.ts";
import {
  deadLetterPendingCatalogRows,
  enqueueEdgeEvent,
  lockSyncCursor,
} from "./edge-queue.service.ts";
import type { VerifiedEdgeNode } from "./staff-pin-sync.ts";

type Database = typeof db;
type PublisherNode = {
  tenantId: VerifiedEdgeNode["tenantId"];
  outletId: VerifiedEdgeNode["outletId"];
  edgeNodeId: string;
  stream: CatalogSyncStream;
};

class PublisherBrandChanged extends Error {}

/**
 * legend-3k41y: true when the node's catalog publisher is blocked, or when its
 * outlet brand differs from the brand it was published for. Delivery paths
 * (link queue read, HTTP pull) refuse such a node.
 */
export async function isCatalogDeliveryRefused(
  database: Database,
  input: Pick<PublisherNode, "tenantId" | "outletId" | "edgeNodeId">,
): Promise<boolean> {
  const context = outletContext(
    establishTenantContext({
      tenantId: input.tenantId,
      brandId: null,
      source: "job",
    }),
    input.outletId,
  );
  return withTenant(database, context, async (tx) => {
    const refused = await tx.execute(
      sql`SELECT 1 FROM edge_catalog_publisher_cursors c JOIN outlets o ON o.tenant_id = c.tenant_id AND o.id = c.outlet_id WHERE c.tenant_id = ${input.tenantId}::uuid AND c.edge_node_id = ${input.edgeNodeId}::uuid AND (c.blocked_at IS NOT NULL OR c.brand_id <> o.brand_id) LIMIT 1`,
    );
    return refused.rows.length > 0;
  });
}

/** Publish a page; repeated calls progress through a stream without gaps. */
export async function publishCatalogForNode(
  database: Database,
  input: PublisherNode,
): Promise<number> {
  const context = outletContext(
    establishTenantContext({
      tenantId: input.tenantId,
      brandId: null,
      source: "job",
    }),
    input.outletId,
  );
  return withTenant(database, context, async (tx) => {
    // Serialize publisher streams without locking the live node row, which is
    // also updated by the link receiver and node administration.
    const publisherLock = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`edge-catalog-publisher:${input.tenantId}:${input.edgeNodeId}`}, 0)) AS locked`,
    );
    if (publisherLock.rows[0]?.locked !== true) return 0;
    const nodes = await tx.execute(
      sql`SELECT o.brand_id FROM edge_nodes n JOIN outlets o ON o.tenant_id = n.tenant_id AND o.id = n.outlet_id WHERE n.id = ${input.edgeNodeId}::uuid AND n.tenant_id = ${input.tenantId}::uuid AND n.outlet_id = ${input.outletId}::uuid AND n.status = 'active'`,
    );
    const node = nodes.rows[0];
    if (!node)
      throw new CoreError("FORBIDDEN", "Catalog publisher node is unavailable");
    const brandId = String(node.brand_id);
    const blocked = await tx.execute(
      sql`SELECT 1 FROM edge_catalog_publisher_cursors WHERE tenant_id = ${input.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND blocked_at IS NOT NULL LIMIT 1`,
    );
    if (blocked.rows.length) return 0;
    let stored = await tx.execute(
      sql`SELECT brand_id, watermark FROM edge_catalog_publisher_cursors WHERE tenant_id = ${input.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND stream = ${input.stream}`,
    );
    if (!stored.rows[0]) {
      await tx.execute(
        sql`INSERT INTO edge_catalog_publisher_cursors (tenant_id, outlet_id, edge_node_id, brand_id, stream) VALUES (${input.tenantId}::uuid, ${input.outletId}::uuid, ${input.edgeNodeId}::uuid, ${brandId}::uuid, ${input.stream}) ON CONFLICT DO NOTHING`,
      );
      stored = await tx.execute(
        sql`SELECT brand_id, watermark FROM edge_catalog_publisher_cursors WHERE tenant_id = ${input.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND stream = ${input.stream}`,
      );
    }
    const cursor = stored.rows[0];
    if (!cursor) throw new Error("Catalog publisher cursor is unavailable");
    const priorBrands = await tx.execute(
      sql`SELECT 1 FROM edge_catalog_publisher_cursors WHERE tenant_id = ${input.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND brand_id <> ${brandId}::uuid LIMIT 1`,
    );
    try {
      if (priorBrands.rows.length) throw new PublisherBrandChanged();
      return await tx.transaction(async (scanTx) => {
        // Hold the outlet stable through serialization and queue insertion.
        // Comparing only the two reads permits A -> B -> A during the scan.
        const before = await scanTx.execute(
          sql`SELECT brand_id FROM outlets WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.outletId}::uuid FOR SHARE`,
        );
        if (!before.rows[0] || String(before.rows[0].brand_id) !== brandId)
          throw new PublisherBrandChanged();
        const page = await listCatalogRecordsSinceTx(scanTx, {
          tenantId: input.tenantId,
          outletId: input.outletId,
          query: {
            stream: input.stream,
            limit: 100,
            ...(cursor.watermark ? { since: String(cursor.watermark) } : {}),
          },
        });
        // Recheck the brand after the scan; the held lock protects it through commit.
        const after = await scanTx.execute(
          sql`SELECT brand_id FROM outlets WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.outletId}::uuid FOR SHARE`,
        );
        if (!after.rows[0] || String(after.rows[0].brand_id) !== brandId)
          throw new PublisherBrandChanged();
        // Empty pages preserve the watermark, so idle sweeps need no queue
        // cursor creation, row lock, or update.
        if (page.records.length === 0) return 0;
        await lockSyncCursor(scanTx, input, "cloud_to_edge");
        for (const record of page.records) {
          const keys =
            "id" in record ? [record.id] : [record.menuItemId, record.groupId];
          const aggregateId = catalogRecordIdFromKeys(input.stream, keys);
          const last = await scanTx.execute(
            sql`SELECT GREATEST((SELECT MAX(aggregate_sequence) FROM edge_outbound_queue WHERE tenant_id = ${input.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND direction = 'cloud_to_edge' AND aggregate_type = ${catalogRecordUpdatedEvent.entry.aggregateType} AND aggregate_id = ${aggregateId}), (SELECT MAX(aggregate_sequence) FROM edge_link_dead_letters WHERE tenant_id = ${input.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND direction = 'cloud_to_edge' AND aggregate_type = ${catalogRecordUpdatedEvent.entry.aggregateType} AND aggregate_id = ${aggregateId})) AS last`,
          );
          if (Number(last.rows[0]?.last ?? 0) >= Number(record.syncTxid))
            continue;
          const event = catalogRecordUpdatedEvent.envelopeSchema.parse({
            id: createUlid(),
            tenantId: input.tenantId,
            outletId: input.outletId,
            name: catalogRecordUpdatedEvent.name,
            version: catalogRecordUpdatedEvent.version,
            aggregateType: catalogRecordUpdatedEvent.entry.aggregateType,
            aggregateId,
            sequence: Number(record.syncTxid),
            occurredAt: new Date().toISOString(),
            actor: { type: "system" },
            deviceId: null,
            idempotencyKey: `catalog:${aggregateId}:${record.syncTxid}`,
            payloadSchemaRef: catalogRecordUpdatedEvent.payloadSchemaRef,
            payload: { stream: input.stream, record },
          });
          await enqueueEdgeEvent(scanTx, context, {
            edgeNodeId: input.edgeNodeId,
            direction: "cloud_to_edge",
            kind: "master_data",
            event,
          });
        }
        await scanTx.execute(
          sql`UPDATE edge_catalog_publisher_cursors SET watermark = ${page.nextCursor}, updated_at = now() WHERE tenant_id = ${input.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND stream = ${input.stream} AND watermark IS DISTINCT FROM ${page.nextCursor}`,
        );
        return page.records.length;
      });
    } catch (error) {
      if (!(error instanceof PublisherBrandChanged)) throw error;
      const changed = await tx.execute(
        sql`UPDATE edge_catalog_publisher_cursors SET blocked_at = now(), updated_at = now() WHERE tenant_id = ${input.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND blocked_at IS NULL RETURNING edge_node_id`,
      );
      // Same transaction and cursor lock as the block: stale brand catalog rows
      // leave the queue and the rows behind them close the gap.
      await deadLetterPendingCatalogRows(tx, {
        tenantId: input.tenantId,
        outletId: input.outletId,
        edgeNodeId: input.edgeNodeId,
      });
      if (changed.rows.length)
        logger.warn(
          { tenantId: input.tenantId, edgeNodeId: input.edgeNodeId },
          "Catalog publisher blocked: outlet brand changed; reprovision node",
        );
      return 0;
    }
  });
}

/** Drain each stream before dependent streams, isolating failures per node. */
export async function sweepCatalogPublisher(database: Database): Promise<void> {
  const tenantRows = await database
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  for (const { id } of tenantRows) {
    const tenantId = tenantIdSchema.parse(id);
    const context = establishTenantContext({
      tenantId,
      brandId: null,
      source: "job",
    });
    const nodes = await withTenant(
      database,
      establishScopedTenantContext(context, { kind: "tenant" }),
      (tx) =>
        tx
          .select({ id: edgeNodes.id, outletId: edgeNodes.outletId })
          .from(edgeNodes)
          .where(
            and(
              eq(edgeNodes.tenantId, tenantId),
              eq(edgeNodes.status, "active"),
              sql`NOT EXISTS (SELECT 1 FROM edge_catalog_publisher_cursors c WHERE c.tenant_id = ${edgeNodes.tenantId} AND c.edge_node_id = ${edgeNodes.id} AND c.blocked_at IS NOT NULL)`,
            ),
          ),
    ).catch((error: unknown) => {
      logger.warn(
        { errName: error instanceof Error ? error.name : "Error", tenantId },
        "Catalog publisher tenant failed",
      );
      return [];
    });
    for (const node of nodes)
      for (const stream of CATALOG_SYNC_STREAMS) {
        try {
          let count: number;
          do {
            count = await publishCatalogForNode(database, {
              tenantId,
              outletId: node.outletId,
              edgeNodeId: node.id,
              stream,
            });
          } while (count === 100);
        } catch (error) {
          logger.warn(
            {
              errName: error instanceof Error ? error.name : "Error",
              tenantId,
              edgeNodeId: node.id,
              stream,
            },
            "Catalog publisher pass failed",
          );
          break;
        }
      }
  }
}

export function startCatalogPublisherWorker(
  database: Database,
  intervalMs = 5000,
  sweep: (database: Database) => Promise<void> = sweepCatalogPublisher,
): { stop(): Promise<void> } {
  let stopped = false;
  let pending: Promise<void> | null = null;
  const run = () => {
    if (!stopped && !pending)
      pending = Promise.resolve()
        .then(() => sweep(database))
        .catch((error: unknown) => {
          logger.warn(
            { errName: error instanceof Error ? error.name : "Error" },
            "Catalog publisher sweep failed",
          );
        })
        .finally(() => {
          pending = null;
        });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (pending) await pending;
    },
  };
}
