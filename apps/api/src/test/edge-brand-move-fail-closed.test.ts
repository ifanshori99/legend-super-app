// legend-3k41y, Second opinion Codex finding 1
// (docs/briefs/789-edge-master-sync-ordering.md): an outlet moves from brand A
// to brand B while its edge node is offline. Written from the brief, not from
// the implementation.
//
// Rules under test (CTO decision in the brief):
//  - A node whose publisher cursors are `blocked_at` is refused (fail closed)
//    by BOTH delivery paths: the cloud_to_edge queue read (LinkStore
//    readOutbound, what the link sends) and the HTTP catalog pull.
//  - Events whose brand differs from the outlet's brand at send time are not
//    delivered, so brand A events queued before the move never reach the node.
//  - Marking the block and stopping delivery happen in one transaction.
//
// Assumptions (the brief leaves them open):
//  - "Refused" is either an empty result or a thrown error / 4xx: both are
//    accepted; only delivery of brand A (or any catalog) data fails the test.
//  - A blocked node receives no `catalog_record` event at all and no catalog
//    record on any pulled stream (every stream of the node stops).
//  - The atomicity test samples concurrently: whenever a committed
//    `blocked_at` is visible, the queue read that follows must already be
//    empty. It cannot fail by timing, but can only catch a gap by chance.
//  - Node B1 on a sibling outlet that stays on brand A is a control: it must
//    still receive brand A events through both paths.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { publishCatalogForNode } from "../services/edge-master-data-publisher.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import { createWorld, owner, type World } from "./member-loyalty-helpers.ts";

const app = createApp();
const PULL_PATH = "/api/edge-sync/catalog";
const PULL_STREAMS = ["menu_categories", "menu_items", "stations"] as const;

beforeAll(() => {
  // server.ts installs the edge registry verifier; createApp() does not.
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
});

afterAll(async () => owner.end());

type Authenticated = NonNullable<
  Awaited<ReturnType<typeof authenticateEdgeCredential>>
>;

async function provision(world: World, outletId: string) {
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId,
    role: "primary",
    label: "Brand move fail closed",
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Node authentication failed");
  return { node, credential: registered.credential };
}

const publish = (world: World, outletId: string, node: Authenticated) =>
  publishCatalogForNode(db, {
    tenantId: tenantIdSchema.parse(world.tenantId),
    outletId: outletIdSchema.parse(outletId),
    edgeNodeId: node.scope.edgeNodeId,
    stream: "menu_categories",
  });

const cloudStore = (node: Authenticated) =>
  createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });

/** What the cloud would send over the link; a refusal counts as nothing. */
async function deliveredByQueue(node: Authenticated) {
  const queued = await cloudStore(node)
    .readOutbound(0, 1000)
    .catch(() => []);
  return queued.map((item) => item.event);
}

/** What the node would receive via HTTP pull; a 4xx refusal counts as nothing. */
async function pulled(credential: string) {
  const records: unknown[] = [];
  for (const stream of PULL_STREAMS) {
    const res = await request(app)
      .get(PULL_PATH)
      .set("Authorization", `Bearer ${credential}`)
      .query({ stream, limit: 100 });
    if (res.status === 200) {
      records.push(...((res.body as { records: unknown[] }).records ?? []));
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  }
  return records;
}

/**
 * Outlet A starts on brand A with a node; a brand A category is published and
 * queued; the node stays offline (nothing read). Then the outlet moves to
 * brand B, a brand A category is changed/added and a brand B category exists.
 */
async function offlineBrandMove() {
  const world = await createWorld();
  const brandB = randomUUID();
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B')`,
    [brandB, world.tenantId, `brand-${brandB}`],
  );
  const { node, credential } = await provision(world, world.outletA);
  const sibling = await provision(world, world.outletB);
  const oldCategory = randomUUID();
  const newBrandACategory = randomUUID();
  const brandBCategory = randomUUID();
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Brand A before move')`,
    [oldCategory, world.tenantId, world.brandId],
  );
  await settleCloud(owner);
  await publish(world, world.outletA, node);
  await publish(world, world.outletB, sibling.node);
  // Precondition: the brand A event really sits in the offline node's queue.
  const queued = await owner.query<{ event: unknown }>(
    `SELECT event FROM edge_outbound_queue WHERE edge_node_id = $1 AND direction = 'cloud_to_edge'`,
    [node.scope.edgeNodeId],
  );
  expect(JSON.stringify(queued.rows)).toContain(oldCategory);

  // The move happens while the node is offline.
  await owner.query(`UPDATE outlets SET brand_id = $1 WHERE id = $2`, [
    brandB,
    world.outletA,
  ]);
  await owner.query(`UPDATE menu_categories SET name = $2 WHERE id = $1`, [
    oldCategory,
    "Brand A after move",
  ]);
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $3, $4, 'Brand A new'), ($2, $3, $5, 'Brand B')`,
    [newBrandACategory, brandBCategory, world.tenantId, world.brandId, brandB],
  );
  await settleCloud(owner);
  return {
    world,
    node,
    credential,
    sibling,
    oldCategory,
    newBrandACategory,
    brandBCategory,
  };
}

describe("legend-3k41y brand move while the node is offline (fail closed)", () => {
  it("delivers no brand A event through the cloud_to_edge queue after the node comes back", async () => {
    const f = await offlineBrandMove();
    // The publisher notices the mismatch and blocks the node.
    await publish(f.world, f.world.outletA, f.node);
    const blocked = await owner.query(
      `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
      [f.node.scope.edgeNodeId],
    );
    expect(blocked.rows.length).toBeGreaterThan(0);
    expect(blocked.rows.every((row) => row.blocked_at !== null)).toBe(true);

    // The node reconnects: the link reads its queue.
    const delivered = JSON.stringify(await deliveredByQueue(f.node));
    expect(delivered).not.toContain(f.oldCategory);
    expect(delivered).not.toContain(f.newBrandACategory);
    expect(delivered).not.toContain(f.brandBCategory);
    expect(delivered).not.toContain("catalog_record");
  }, 60_000);

  it("delivers no brand A record through the HTTP pull after the node comes back", async () => {
    const f = await offlineBrandMove();
    await publish(f.world, f.world.outletA, f.node);
    const records = JSON.stringify(await pulled(f.credential));
    expect(records).not.toContain(f.oldCategory);
    expect(records).not.toContain(f.newBrandACategory);
    // Fail closed: a blocked node gets nothing, not even brand B data.
    expect(records).not.toContain(f.brandBCategory);
    expect(JSON.parse(records)).toEqual([]);
  }, 60_000);

  it("refuses the blocked node even if the publisher never ran again after the move", async () => {
    // Delivery must not depend on a later sweep: an old queue entry whose brand
    // no longer matches the outlet's brand at send time is not sent.
    const f = await offlineBrandMove();
    const delivered = JSON.stringify(await deliveredByQueue(f.node));
    expect(delivered).not.toContain(f.oldCategory);
    expect(delivered).not.toContain(f.newBrandACategory);
  }, 60_000);

  it("stops delivery in the same transaction that marks the node blocked", async () => {
    const f = await offlineBrandMove();
    let done = false;
    const publication = publish(f.world, f.world.outletA, f.node).finally(
      () => {
        done = true;
      },
    );
    const violations: string[] = [];
    const sample = async () => {
      // Read the block first: if it is already committed, delivery must
      // already be stopped when the queue is read afterwards.
      const state = await owner.query(
        `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
        [f.node.scope.edgeNodeId],
      );
      const blockedVisible = state.rows.some((row) => row.blocked_at !== null);
      const delivered = JSON.stringify(await deliveredByQueue(f.node));
      if (blockedVisible && delivered.includes(f.oldCategory))
        violations.push(delivered);
    };
    while (!done) await sample();
    await publication;
    await sample();
    expect(violations).toEqual([]);
    const final = await owner.query(
      `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
      [f.node.scope.edgeNodeId],
    );
    expect(final.rows.some((row) => row.blocked_at !== null)).toBe(true);
    expect(JSON.stringify(await deliveredByQueue(f.node))).not.toContain(
      f.oldCategory,
    );
  }, 60_000);

  it("control: a sibling node that stays on brand A still receives brand A events and records", async () => {
    const f = await offlineBrandMove();
    await publish(f.world, f.world.outletA, f.node);
    await publish(f.world, f.world.outletB, f.sibling.node);
    const delivered = JSON.stringify(await deliveredByQueue(f.sibling.node));
    expect(delivered).toContain(f.oldCategory);
    expect(delivered).not.toContain(f.brandBCategory);
    const records = JSON.stringify(await pulled(f.sibling.credential));
    expect(records).toContain(f.oldCategory);
    expect(records).not.toContain(f.brandBCategory);
  }, 60_000);
});
