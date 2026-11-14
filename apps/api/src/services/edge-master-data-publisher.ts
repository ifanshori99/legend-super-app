// Durable cloud-to-edge full-state catalog publication. The cursor and the
// link queue advance together; an interrupted pass is retried on restart.
import { and, eq, sql } from "drizzle-orm";
import { CoreError, createUlid } from "@starter/shared/core";
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
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { catalogRecordIdFromKeys } from "../lib/edge-catalog-identity.ts";
import { logger } from "../lib/logger.ts";
import { outletContext } from "./device-pin-support.ts";
import { listCatalogRecordsSinceTx } from "./edge-catalog-sync.ts";
import { enqueueEdgeEvent } from "./edge-queue.service.ts";
import type { VerifiedEdgeNode } from "./staff-pin-sync.ts";

type Database = typeof db;
type PublisherNode = {
  tenantId: VerifiedEdgeNode["tenantId"];
  outletId: VerifiedEdgeNode["outletId"];
  edgeNodeId: string;
  stream: CatalogSyncStream;
};

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
    const [node] = await tx
      .select({ brandId: outlets.brandId })
      .from(edgeNodes)
      .innerJoin(
        outlets,
        and(
          eq(outlets.tenantId, edgeNodes.tenantId),
          eq(outlets.id, edgeNodes.outletId),
        ),
      )
      .where(
        and(
          eq(edgeNodes.id, input.edgeNodeId),
          eq(edgeNodes.tenantId, input.tenantId),
          eq(edgeNodes.outletId, input.outletId),
          eq(edgeNodes.status, "active"),
        ),
      )
      .limit(1);
    if (!node)
      throw new CoreError("FORBIDDEN", "Catalog publisher node is unavailable");
    await tx.execute(
      sql`INSERT INTO edge_catalog_publisher_cursors (tenant_id, outlet_id, edge_node_id, brand_id, stream) VALUES (${input.tenantId}::uuid, ${input.outletId}::uuid, ${input.edgeNodeId}::uuid, ${node.brandId}::uuid, ${input.stream}) ON CONFLICT DO NOTHING`,
    );
    const locked = await tx.execute(
      sql`SELECT brand_id, watermark FROM edge_catalog_publisher_cursors WHERE tenant_id = ${input.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND stream = ${input.stream} FOR UPDATE`,
    );
    const cursor = locked.rows[0];
    if (!cursor || String(cursor.brand_id) !== node.brandId)
      throw new CoreError(
        "CONFLICT",
        "Catalog publisher requires reprovisioning after outlet brand changes",
      );
    const page = await listCatalogRecordsSinceTx(tx, {
      tenantId: input.tenantId,
      outletId: input.outletId,
      query: {
        stream: input.stream,
        limit: 100,
        ...(cursor.watermark ? { since: String(cursor.watermark) } : {}),
      },
    });
    for (const record of page.records) {
      const keys =
        "id" in record ? [record.id] : [record.menuItemId, record.groupId];
      const aggregateId = catalogRecordIdFromKeys(input.stream, keys);
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
      await enqueueEdgeEvent(tx, context, {
        edgeNodeId: input.edgeNodeId,
        direction: "cloud_to_edge",
        kind: "master_data",
        event,
      });
    }
    await tx.execute(
      sql`UPDATE edge_catalog_publisher_cursors SET watermark = ${page.nextCursor} WHERE tenant_id = ${input.tenantId}::uuid AND edge_node_id = ${input.edgeNodeId}::uuid AND stream = ${input.stream}`,
    );
    return page.records.length;
  });
}

/** Drain each stream before dependent streams, isolating failures per node. */
export async function sweepCatalogPublisher(database: Database): Promise<void> {
  const tenantRows = await database
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  for (const { id: tenantId } of tenantRows) {
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
