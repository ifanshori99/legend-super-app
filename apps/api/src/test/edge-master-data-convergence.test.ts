import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  CATALOG_PROTOCOL_VERSION,
  catalogSyncQuerySchema,
  type CatalogSyncStream,
} from "@starter/shared/edge";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { pullCatalog } from "../edge/catalog-puller.ts";
import { startEdgeMasterSyncLoop } from "../edge/master-sync.ts";
import { registerMasterDataEdgeApplier } from "../edge/master-data-applier.ts";
import { listCatalogRecordsSince } from "../services/edge-catalog-sync.ts";
import { buildEdgeMasterSnapshot } from "../services/edge-master-sync.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { publishCatalogForNode } from "../services/edge-master-data-publisher.ts";
import { createWorld, owner, type World } from "./member-loyalty-helpers.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import {
  createEdgeDatabase,
  type EdgeDatabase,
} from "./helpers/edge-database.ts";

let world: World;
let edge: EdgeDatabase;
let credential: string;
let node: NonNullable<Awaited<ReturnType<typeof authenticateEdgeCredential>>>;

beforeAll(async () => {
  world = await createWorld();
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId: world.outletA,
    role: "primary",
    label: "Convergence test",
  });
  credential = registered.credential;
  const authenticated = await authenticateEdgeCredential(credential);
  if (!authenticated) throw new Error("Node authentication failed");
  node = authenticated;
  edge = await createEdgeDatabase({
    tenantId: world.tenantId,
    outletId: world.outletA,
  });
  const row = await owner.query(
    "SELECT row_to_json(n) AS row FROM edge_nodes n WHERE id = $1",
    [node.scope.edgeNodeId],
  );
  const client = await edge.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "INSERT INTO edge_nodes SELECT * FROM json_populate_record(NULL::edge_nodes, $1::json)",
      [JSON.stringify(row.rows[0].row)],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  resetEdgeApplierRegistryForTests();
  registerMasterDataEdgeApplier();
}, 120_000);

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  await edge?.cleanup();
  await owner.end();
});

const tenantId = () => tenantIdSchema.parse(world.tenantId);
const outletId = () => outletIdSchema.parse(world.outletA);
const publisher = (
  stream: "inventory_items" | "menu_categories" | "menu_items",
) =>
  publishCatalogForNode(db, {
    tenantId: tenantId(),
    outletId: outletId(),
    edgeNodeId: node.scope.edgeNodeId,
    stream,
  });
const link = (onDeferred?: (streams: CatalogSyncStream[]) => void) =>
  createDbLinkStore({
    database: edge.database,
    context: node.context,
    node: node.scope,
    outboundDirection: "edge_to_cloud",
    onDeferred,
  });

async function deliverNew(onDeferred?: (streams: CatalogSyncStream[]) => void) {
  const store = link(onDeferred);
  const fromSeq = await store.lastReceivedInbound();
  const rows = await owner.query<{ link_seq: string; event: unknown }>(
    "SELECT link_seq, event FROM edge_outbound_queue WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' AND link_seq > $2 ORDER BY link_seq",
    [node.scope.edgeNodeId, fromSeq],
  );
  if (!rows.rows.length) return;
  const events = rows.rows.map((row) => ({
    linkSeq: Number(row.link_seq),
    event: eventEnvelopeSchema.parse(row.event),
  }));
  await store.applyInbound({ fromSeq, toSeq: events.at(-1)!.linkSeq, events });
}

async function pull(
  streams: ("inventory_items" | "menu_categories" | "menu_items")[],
) {
  return pullCatalog({
    database: edge.database,
    context: node.context,
    edgeNodeId: node.scope.edgeNodeId,
    streams,
    fetchPage: (stream, since) =>
      listCatalogRecordsSince(db, {
        tenantId: tenantId(),
        outletId: outletId(),
        query: catalogSyncQuerySchema.parse({
          stream,
          limit: 100,
          protocolVersion: CATALOG_PROTOCOL_VERSION,
          ...(since ? { since } : {}),
        }),
      }),
  });
}

describe("master event recovery with separate cloud and edge", () => {
  it("defers inventory with missing UOM and recovers after importing masters and pulling catalog", async () => {
    const uom = randomUUID();
    const item = randomUUID();
    await owner.query(
      "INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Recovery UOM')",
      [uom, world.tenantId, `u${uom.slice(0, 8)}`],
    );
    await owner.query(
      "INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id) VALUES ($1,$2,'Recovery item','Bahan','raw_material',$3)",
      [item, world.tenantId, uom],
    );
    await settleCloud(owner);
    await publisher("inventory_items");
    const verified = await verifyEdgeNodeCredential({ credential });
    if (!verified) throw new Error("Credential verification failed");
    const signedSnapshot = await buildEdgeMasterSnapshot(verified, credential);
    const requests: string[] = [];
    const errors: unknown[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.pathname.endsWith("/bootstrap/masters")) {
        requests.push("masters");
        return Response.json(signedSnapshot);
      }
      if (url.pathname.endsWith("/catalog")) {
        const stream = url.searchParams.get("stream");
        requests.push(`catalog:${stream}`);
        const page = await listCatalogRecordsSince(db, {
          tenantId: tenantId(),
          outletId: outletId(),
          query: catalogSyncQuerySchema.parse({
            stream,
            limit: 100,
            protocolVersion: CATALOG_PROTOCOL_VERSION,
            ...(url.searchParams.has("since")
              ? { since: url.searchParams.get("since") }
              : {}),
          }),
        });
        return Response.json(page);
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    };
    const worker = startEdgeMasterSyncLoop({
      database: edge.database,
      config: {
        cloudUrl: "wss://cloud.example.test/api/edge-link",
        credential,
      },
      intervalMs: 300_000,
      options: { fetchImpl },
      onError: (error) => errors.push(error),
    });
    const wake = vi.fn(() => worker.requestRun());
    try {
      await deliverNew(wake);
      expect(wake).toHaveBeenCalledTimes(1);
      expect(
        await edge.rows(
          "SELECT outcome FROM edge_inbound_events WHERE kind = 'master_data' ORDER BY link_seq",
        ),
      ).toContainEqual({ outcome: "deferred" });
      expect(
        await edge.rows("SELECT id FROM inventory_items WHERE id = $1", [item]),
      ).toEqual([]);
      await vi.waitFor(
        async () => {
          expect(
            await edge.rows(
              "SELECT base_uom_id FROM inventory_items WHERE id = $1",
              [item],
            ),
          ).toEqual([{ base_uom_id: uom }]);
        },
        { timeout: 50_000, interval: 200 },
      );
      expect(requests[0]).toBe("masters");
      expect(requests).toContain("catalog:inventory_items");
      expect(errors).toEqual([]);
    } finally {
      await worker.stop();
    }
  }, 120_000);

  it("converges after a parent moves above xmin while parallel publishers enqueue its earlier child", async () => {
    const category = randomUUID();
    const item = randomUUID();
    await owner.query(
      "INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1,$2,$3,'Earlier')",
      [category, world.tenantId, world.brandId],
    );
    await owner.query(
      "INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name) VALUES ($1,$2,$3,$4,'Race item')",
      [item, world.tenantId, world.brandId, category],
    );
    await settleCloud(owner);
    const holding = await owner.connect();
    try {
      await holding.query("BEGIN");
      await holding.query("SELECT pg_current_xact_id()");
      await owner.query(
        "UPDATE menu_categories SET name = 'Later' WHERE id = $1",
        [category],
      );
      await Promise.all([
        publisher("menu_categories"),
        publisher("menu_items"),
      ]);
      await deliverNew();
      expect(
        await edge.rows(
          "SELECT outcome FROM edge_inbound_events WHERE outcome = 'deferred' AND kind = 'master_data'",
        ),
      ).not.toEqual([]);
      await holding.query("COMMIT");
    } finally {
      await holding.query("ROLLBACK").catch(() => undefined);
      holding.release();
    }
    await settleCloud(owner);
    const result = await pull(["menu_categories", "menu_items"]);
    expect(result.streams.menu_categories?.error).toBeUndefined();
    expect(result.streams.menu_items?.error).toBeUndefined();
    expect(
      await edge.rows("SELECT name FROM menu_categories WHERE id = $1", [
        category,
      ]),
    ).toEqual([{ name: "Later" }]);
    expect(
      await edge.rows("SELECT category_id FROM menu_items WHERE id = $1", [
        item,
      ]),
    ).toEqual([{ category_id: category }]);
  }, 120_000);
});
