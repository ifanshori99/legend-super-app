import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import { db } from "../db/index.ts";
import { publishCatalogForNode } from "../services/edge-master-data-publisher.ts";
import { registerEdgeNode } from "../services/edge-node.service.ts";
import { createWorld, owner } from "./member-loyalty-helpers.ts";

afterAll(async () => owner.end());

it("rolls back the scan if the outlet brand changes between the two checks", async () => {
  const world = await createWorld();
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId: world.outletA,
    role: "primary",
    label: "Brand race",
  });
  const input = {
    tenantId: tenantIdSchema.parse(world.tenantId),
    outletId: outletIdSchema.parse(world.outletA),
    edgeNodeId: registered.edgeNode.id,
    stream: "menu_categories" as const,
  };
  await publishCatalogForNode(db, input);
  const before = await owner.query(
    `SELECT watermark FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1 AND stream = 'menu_categories'`,
    [input.edgeNodeId],
  );
  const newBrand = randomUUID();
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B')`,
    [newBrand, world.tenantId, `brand-${newBrand}`],
  );
  const newCategory = randomUUID();
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Brand B only')`,
    [newCategory, world.tenantId, newBrand],
  );
  const locked = await owner.connect();
  let pending: Promise<number> | undefined;
  try {
    await locked.query("BEGIN");
    const blocker = await locked.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    await locked.query(
      `SELECT 1 FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1 AND stream = 'menu_categories' FOR UPDATE`,
      [input.edgeNodeId],
    );
    pending = publishCatalogForNode(db, input);
    let observed = false;
    for (let n = 0; n < 100 && !observed; n++) {
      const waiting = await owner.query(
        `SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [blocker.rows[0]!.pid],
      );
      observed = waiting.rowCount! > 0;
      if (!observed) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(observed).toBe(true);
    await owner.query(`UPDATE outlets SET brand_id = $1 WHERE id = $2`, [
      newBrand,
      world.outletA,
    ]);
    await locked.query("COMMIT");
    await pending;
    pending = undefined;
    const after = await owner.query(
      `SELECT watermark, blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1 AND stream = 'menu_categories'`,
      [input.edgeNodeId],
    );
    expect(after.rows[0].watermark).toEqual(before.rows[0].watermark);
    expect(after.rows[0].blocked_at).not.toBeNull();
    const queue = await owner.query(
      `SELECT event FROM edge_outbound_queue WHERE edge_node_id = $1`,
      [input.edgeNodeId],
    );
    expect(JSON.stringify(queue.rows)).not.toContain(newCategory);
  } finally {
    await locked.query("ROLLBACK").catch(() => undefined);
    locked.release();
    await pending?.catch(() => undefined);
  }
}, 15_000);

it("prevents an A to B to A brand switch during publication", async () => {
  const world = await createWorld();
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId: world.outletA,
    role: "primary",
    label: "ABA race",
  });
  const input = {
    tenantId: tenantIdSchema.parse(world.tenantId),
    outletId: outletIdSchema.parse(world.outletA),
    edgeNodeId: registered.edgeNode.id,
    stream: "menu_categories" as const,
  };
  const brandB = randomUUID();
  const bCategory = randomUUID();
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B')`,
    [brandB, world.tenantId, `brand-${brandB}`],
  );
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Brand B only')`,
    [bCategory, world.tenantId, brandB],
  );
  // Ensure the queue cursor exists before holding it on another connection.
  await publishCatalogForNode(db, input);
  const blocker = await owner.connect();
  const changer = await owner.connect();
  let publication: Promise<number> | undefined;
  let update: Promise<unknown> | undefined;
  try {
    await blocker.query("BEGIN");
    const lockPid = (
      await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    await blocker.query(
      `SELECT 1 FROM sync_cursors WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' FOR UPDATE`,
      [input.edgeNodeId],
    );
    publication = publishCatalogForNode(db, input);
    let publicationBlocked = false;
    for (let n = 0; n < 200 && !publicationBlocked; n++) {
      const waiting = await owner.query(
        `SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [lockPid],
      );
      publicationBlocked = waiting.rowCount! > 0;
      if (!publicationBlocked)
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(publicationBlocked).toBe(true);
    await changer.query("BEGIN");
    const changePid = (
      await changer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    update = changer.query(`UPDATE outlets SET brand_id = $1 WHERE id = $2`, [
      brandB,
      world.outletA,
    ]);
    let changeBlocked = false;
    for (let n = 0; n < 200 && !changeBlocked; n++) {
      const waiting = await owner.query(
        `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND cardinality(pg_blocking_pids(pid)) > 0`,
        [changePid],
      );
      changeBlocked = waiting.rowCount! > 0;
      if (!changeBlocked)
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(changeBlocked).toBe(true);
    await blocker.query("COMMIT");
    await publication;
    publication = undefined;
    await update;
    update = undefined;
    await changer.query("COMMIT");
    await owner.query(`UPDATE outlets SET brand_id = $1 WHERE id = $2`, [
      world.brandId,
      world.outletA,
    ]);
    const queue = await owner.query(
      `SELECT event FROM edge_outbound_queue WHERE edge_node_id = $1`,
      [input.edgeNodeId],
    );
    expect(JSON.stringify(queue.rows)).not.toContain(bCategory);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await update?.catch(() => undefined);
    await changer.query("ROLLBACK").catch(() => undefined);
    changer.release();
    await publication?.catch(() => undefined);
  }
}, 20_000);
