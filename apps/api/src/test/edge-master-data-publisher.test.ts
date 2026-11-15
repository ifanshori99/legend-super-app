import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db, pool } from "../db/index.ts";
import { logger } from "../lib/logger.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import {
  publishCatalogForNode,
  startCatalogPublisherWorker,
  sweepCatalogPublisher,
} from "../services/edge-master-data-publisher.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import { createWorld, owner, type World } from "./member-loyalty-helpers.ts";

// The real worker scans every active node, so unrelated suites must not add
// work to its timed discovery assertion or hold back its commit-safe boundary.
const cloud = await vi.hoisted(async () => {
  const { createCatalogCloud } = await import("./helpers/catalog-database.ts");
  return createCatalogCloud();
});

let world: World;
let foreign: World;
let otherBrandOutlet: string;
let nodeA: string;
let nodeB: string;
let nodeOtherBrand: string;
let nodeForeign: string;

async function node(w: World, outletId: string) {
  const result = await registerEdgeNode(w.context, randomUUID(), {
    outletId,
    role: "primary",
    label: "Master publisher test",
  });
  return result.edgeNode.id;
}

async function publish(
  w: World,
  outletId: string,
  edgeNodeId: string,
  stream: "stations" | "menu_categories" | "printers",
) {
  return publishCatalogForNode(db, {
    tenantId: tenantIdSchema.parse(w.tenantId),
    outletId: outletIdSchema.parse(outletId),
    edgeNodeId,
    stream,
  });
}

async function events(edgeNodeId: string) {
  const rows = await owner.query<{ event: unknown }>(
    `SELECT event FROM edge_outbound_queue WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' ORDER BY link_seq`,
    [edgeNodeId],
  );
  return rows.rows.map(({ event }) => eventEnvelopeSchema.parse(event));
}

function trackPool(connectionPool: typeof owner) {
  // pg-pool can resolve end() after removing idle clients from its list but
  // before their sockets close. The public remove event follows client.end's
  // callback. Track identities before the first query, including clients
  // already being removed when end() starts, before dropping the database.
  const clients = new Set<PoolClient>();
  let onEmpty: (() => void) | undefined;
  const onConnect = (client: PoolClient) => clients.add(client);
  const onRemove = (client: PoolClient) => {
    clients.delete(client);
    if (clients.size === 0) onEmpty?.();
  };
  connectionPool.on("connect", onConnect);
  connectionPool.on("remove", onRemove);
  return async () => {
    try {
      await connectionPool.end();
      if (clients.size > 0)
        await new Promise<void>((resolve) => {
          onEmpty = resolve;
        });
    } finally {
      connectionPool.off("connect", onConnect);
      connectionPool.off("remove", onRemove);
    }
  };
}

const closeOwnerPool = trackPool(owner);
const closeAppPool = trackPool(pool);

beforeAll(async () => {
  world = await createWorld();
  foreign = await createWorld();
  const brand = randomUUID();
  otherBrandOutlet = randomUUID();
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'other', 'Other')`,
    [brand, world.tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
    SELECT $1, tenant_id, $2, legal_entity_id, 'OTHER', 'Other', address, timezone, opening_hours, 'active' FROM outlets WHERE id = $3`,
    [otherBrandOutlet, brand, world.outletA],
  );
  nodeA = await node(world, world.outletA);
  nodeB = await node(world, world.outletB);
  nodeOtherBrand = await node(world, otherBrandOutlet);
  nodeForeign = await node(foreign, foreign.outletA);
});

afterAll(async () => {
  await closeOwnerPool();
  await closeAppPool();
  await cloud.cleanup();
});

describe("legend-3k41y master-data publication", () => {
  it("isolates the worker sweep from other catalog suites", async () => {
    const result = await owner.query("SELECT current_database() AS name");
    const appResult = await pool.query("SELECT current_database() AS name");
    expect(result.rows[0].name).toBe(cloud.name);
    expect(appResult.rows[0].name).toBe(cloud.name);
    expect(`/${cloud.name}`).not.toBe(cloud.parentDatabaseName);
  });

  it("blocks a changed brand once while allowing another node and a reprovisioned node", async () => {
    const local = await createWorld();
    const oldNode = await node(local, local.outletA);
    const otherNode = await node(local, local.outletB);
    const newBrand = randomUUID();
    await owner.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'New brand')`,
      [newBrand, local.tenantId, `brand-${newBrand}`],
    );
    await publish(local, local.outletA, oldNode, "menu_categories");
    await owner.query(`UPDATE outlets SET brand_id = $1 WHERE id = $2`, [
      newBrand,
      local.outletA,
    ]);
    const category = randomUUID();
    await owner.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'New brand category')`,
      [category, local.tenantId, newBrand],
    );
    await settleCloud(owner);
    const warning = vi.spyOn(logger, "warn");
    try {
      await publish(local, local.outletA, oldNode, "menu_categories");
      await publish(local, local.outletA, oldNode, "menu_categories");
      const state = await owner.query(
        `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
        [oldNode],
      );
      expect(state.rows.length).toBeGreaterThan(0);
      expect(state.rows.every((row) => row.blocked_at !== null)).toBe(true);
      expect(
        warning.mock.calls.filter((args) =>
          String(args[1]).includes("Catalog publisher blocked"),
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(await events(oldNode))).not.toContain(category);
      await expect(
        publish(local, local.outletB, otherNode, "menu_categories"),
      ).resolves.toBeDefined();
      await owner.query(
        `UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = $1`,
        [oldNode],
      );
      const replacement = await node(local, local.outletA);
      await publish(local, local.outletA, replacement, "menu_categories");
      expect(JSON.stringify(await events(replacement))).toContain(category);
    } finally {
      warning.mockRestore();
    }
  });
  it("can rescan after a cursor reset without enqueueing old versions", async () => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Reset cursor')`,
      [id, world.tenantId, world.brandId],
    );
    await settleCloud(owner);
    await publish(world, world.outletA, nodeA, "menu_categories");
    const before = (await events(nodeA)).filter((event) =>
      JSON.stringify(event.payload).includes(id),
    );
    expect(before).toHaveLength(1);
    await owner.query(
      `UPDATE edge_catalog_publisher_cursors SET watermark = NULL WHERE edge_node_id = $1 AND stream = 'menu_categories'`,
      [nodeA],
    );
    await expect(
      publish(world, world.outletA, nodeA, "menu_categories"),
    ).resolves.toBeDefined();
    expect(
      (await events(nodeA)).filter((event) =>
        JSON.stringify(event.payload).includes(id),
      ),
    ).toHaveLength(1);
  });
  it("does not stack overlapping sweeps and waits for the active sweep on stop", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const sweep = vi.fn(async () => blocked);
    const worker = startCatalogPublisherWorker(db, 10, sweep);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(sweep).toHaveBeenCalledTimes(1);
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish();
      await stopping;
      await vi.advanceTimersByTimeAsync(100);
      expect(sweep).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(true);
    } finally {
      finish();
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it("fans brand records to both matching outlets only, with full state and sparse versions", async () => {
    const category = randomUUID();
    await owner.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Before')`,
      [category, world.tenantId, world.brandId],
    );
    await settleCloud(owner);
    for (const [outlet, edge] of [
      [world.outletA, nodeA],
      [world.outletB, nodeB],
      [otherBrandOutlet, nodeOtherBrand],
    ] as const)
      await publish(world, outlet, edge, "menu_categories");
    await publish(foreign, foreign.outletA, nodeForeign, "menu_categories");
    for (const edge of [nodeA, nodeB]) {
      const event = (await events(edge)).find(
        (e) =>
          e.payload &&
          (e.payload as { record?: { id?: string } }).record?.id === category,
      );
      expect(event).toMatchObject({
        name: "catalog_record.updated",
        aggregateType: "catalog_record",
        tenantId: world.tenantId,
        payload: {
          stream: "menu_categories",
          record: { id: category, name: "Before" },
        },
      });
      const record = (event!.payload as { record: { syncTxid: string } })
        .record;
      expect(event!.sequence).toBe(Number(record.syncTxid));
      expect(event!.sequence).toBeGreaterThan(1);
    }
    expect(JSON.stringify(await events(nodeOtherBrand))).not.toContain(
      category,
    );
    expect(JSON.stringify(await events(nodeForeign))).not.toContain(category);
    await owner.query(
      `UPDATE menu_categories SET name = 'After' WHERE id = $1`,
      [category],
    );
    await settleCloud(owner);
    await publish(world, world.outletA, nodeA, "menu_categories");
    const own = (await events(nodeA)).filter((e) =>
      JSON.stringify(e.payload).includes(category),
    );
    expect(own).toHaveLength(2);
    expect(own[1]!.payload).toMatchObject({
      record: { id: category, name: "After" },
    });
    expect(own[1]!.sequence).toBeGreaterThan(own[0]!.sequence);
    await publish(world, world.outletA, nodeA, "menu_categories");
    expect(
      (await events(nodeA)).filter((e) =>
        JSON.stringify(e.payload).includes(category),
      ),
    ).toHaveLength(2);
  });

  it("sends a printer only to its outlet, including deletion tombstone", async () => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO edge_printers (id, tenant_id, outlet_id, label, role, transport, host, port, paper_width) VALUES ($1, $2, $3, 'Printer', 'receipt', 'network', '192.168.1.50', 9100, 48)`,
      [id, world.tenantId, world.outletA],
    );
    await settleCloud(owner);
    await publish(world, world.outletA, nodeA, "printers");
    await publish(world, world.outletB, nodeB, "printers");
    expect(JSON.stringify(await events(nodeA))).toContain(id);
    expect(JSON.stringify(await events(nodeB))).not.toContain(id);
    await owner.query(`DELETE FROM edge_printers WHERE id = $1`, [id]);
    await settleCloud(owner);
    await publish(world, world.outletA, nodeA, "printers");
    const matching = (await events(nodeA)).filter((event) =>
      JSON.stringify(event.payload).includes(id),
    );
    expect(matching).toHaveLength(2);
    expect(matching[1]!.payload).toMatchObject({
      record: { id, deletedAt: expect.any(String) },
    });
  });

  it("rejects a node paired with another tenant or outlet", async () => {
    await expect(
      publish(world, world.outletB, nodeA, "stations"),
    ).rejects.toThrow();
    await expect(
      publish(foreign, foreign.outletA, nodeA, "stations"),
    ).rejects.toThrow();
  });

  it("worker discovers a committed master change without an explicit publish call", async () => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Automatic', 'coffee_bar')`,
      [id, world.tenantId, world.outletA],
    );
    await settleCloud(owner);
    const worker = startCatalogPublisherWorker(db, 100);
    try {
      await vi.waitFor(
        async () => {
          expect(JSON.stringify(await events(nodeA))).toContain(id);
        },
        { timeout: 30_000, interval: 100 },
      );
      expect(JSON.stringify(await events(nodeB))).not.toContain(id);
      expect(JSON.stringify(await events(nodeForeign))).not.toContain(id);
    } finally {
      await worker.stop();
    }
  }, 45_000);

  it("publishes all category pages before an item that depends on the last page", async () => {
    const fixture = await createWorld();
    const edge = await node(fixture, fixture.outletA);
    const categories = Array.from({ length: 101 }, () => randomUUID()).sort();
    const item = randomUUID();
    await owner.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name)
       SELECT id, $2, $3, 'Category' FROM unnest($1::uuid[]) AS id`,
      [categories, fixture.tenantId, fixture.brandId],
    );
    await owner.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active)
       VALUES ($1, $2, $3, $4, 'Item', true)`,
      [item, fixture.tenantId, fixture.brandId, categories[100]],
    );
    await settleCloud(owner);
    await sweepCatalogPublisher(db);
    const queued = await events(edge);
    const categoryIndexes = queued.flatMap((event, index) =>
      event.payload.stream === "menu_categories" ? [index] : [],
    );
    const itemIndex = queued.findIndex(
      (event) =>
        event.payload.stream === "menu_items" &&
        (event.payload.record as { id?: string }).id === item,
    );
    expect(categoryIndexes).toHaveLength(101);
    expect(itemIndex).toBeGreaterThan(Math.max(...categoryIndexes));
    expect(JSON.stringify(queued[categoryIndexes[100]!]?.payload)).toContain(
      categories[100],
    );
  }, 45_000);
});
