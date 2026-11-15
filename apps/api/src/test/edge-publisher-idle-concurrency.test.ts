import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { publishCatalogForNode } from "../services/edge-master-data-publisher.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import { createWorld, owner } from "./member-loyalty-helpers.ts";

afterAll(async () => owner.end());

it("does not create or update a queue cursor when a publisher stream is empty", async () => {
  const world = await createWorld();
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId: world.outletA,
    role: "primary",
    label: "Idle publisher",
  });
  const input = {
    tenantId: tenantIdSchema.parse(world.tenantId),
    outletId: outletIdSchema.parse(world.outletA),
    edgeNodeId: registered.edgeNode.id,
    stream: "stations" as const,
  };
  const empty = await owner.query(
    `SELECT 1 FROM sync_cursors WHERE edge_node_id = $1 AND direction = 'cloud_to_edge'`,
    [input.edgeNodeId],
  );
  expect(empty.rows).toHaveLength(0);
  await expect(publishCatalogForNode(db, input)).resolves.toBe(0);
  const after = await owner.query(
    `SELECT 1 FROM sync_cursors WHERE edge_node_id = $1 AND direction = 'cloud_to_edge'`,
    [input.edgeNodeId],
  );
  expect(after.rows).toHaveLength(0);
  const checkpoint = await owner.query(
    `SELECT watermark, updated_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1 AND stream = 'stations'`,
    [input.edgeNodeId],
  );
  await expect(publishCatalogForNode(db, input)).resolves.toBe(0);
  const repeated = await owner.query(
    `SELECT watermark, updated_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1 AND stream = 'stations'`,
    [input.edgeNodeId],
  );
  expect(repeated.rows).toEqual(checkpoint.rows);
});

it("allows updating a node while a publisher waits to enqueue its records", async () => {
  const world = await createWorld();
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId: world.outletA,
    role: "primary",
    label: "Concurrent publisher",
  });
  const input = {
    tenantId: tenantIdSchema.parse(world.tenantId),
    outletId: outletIdSchema.parse(world.outletA),
    edgeNodeId: registered.edgeNode.id,
    stream: "menu_categories" as const,
  };
  await owner.query(
    `INSERT INTO sync_cursors (tenant_id, outlet_id, edge_node_id, direction) VALUES ($1, $2, $3, 'cloud_to_edge') ON CONFLICT DO NOTHING`,
    [world.tenantId, world.outletA, input.edgeNodeId],
  );
  await owner.query(
    `INSERT INTO menu_categories (tenant_id, brand_id, name) VALUES ($1, $2, 'Pending category')`,
    [world.tenantId, world.brandId],
  );
  await settleCloud(owner);
  const blocker = await owner.connect();
  const updater = await owner.connect();
  let publication: Promise<number> | undefined;
  try {
    await blocker.query("BEGIN");
    const pid = (
      await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    await blocker.query(
      `SELECT 1 FROM sync_cursors WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' FOR UPDATE`,
      [input.edgeNodeId],
    );
    publication = publishCatalogForNode(db, input);
    let observed = false;
    for (let n = 0; n < 200 && !observed; n++) {
      const waiting = await owner.query(
        `SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [pid],
      );
      observed = waiting.rowCount! > 0;
      if (!observed) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(observed).toBe(true);
    await updater.query("BEGIN");
    await updater.query("SET LOCAL lock_timeout = '1s'");
    await expect(
      updater.query(
        `UPDATE edge_nodes SET last_sync_cursor = '42' WHERE id = $1`,
        [input.edgeNodeId],
      ),
    ).resolves.toBeDefined();
    await updater.query("COMMIT");
    await blocker.query("COMMIT");
    await publication;
    publication = undefined;
    const node = await owner.query(
      `SELECT last_sync_cursor FROM edge_nodes WHERE id = $1`,
      [input.edgeNodeId],
    );
    expect(node.rows[0].last_sync_cursor).toBe("42");
  } finally {
    await updater.query("ROLLBACK").catch(() => undefined);
    updater.release();
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await publication?.catch(() => undefined);
  }
}, 20_000);
