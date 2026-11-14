// #818 / legend-i8fv3 P1-1: the brand admitted by a delivery guard must stay
// stable until the catalog page / link batch has been read.
import { randomUUID } from "node:crypto";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { createApp } from "../app.ts";
import { db, pool } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import * as publisher from "../services/edge-master-data-publisher.ts";
import * as queue from "../services/edge-queue.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import { createWorld, owner } from "./member-loyalty-helpers.ts";

const cloud = await vi.hoisted(async () => {
  const { createCatalogCloud } = await import("./helpers/catalog-database.ts");
  return createCatalogCloud();
});

const app = createApp();
beforeAll(() => setEdgeCredentialVerifier(verifyEdgeNodeCredential));
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  setEdgeCredentialVerifier(null);
  await owner.end();
  await pool.end();
  await cloud.cleanup();
});

async function fixture() {
  const world = await createWorld();
  const brandB = randomUUID();
  const categoryA = randomUUID();
  const categoryB = randomUUID();
  await owner.query(
    "INSERT INTO brands (id,tenant_id,slug,name) VALUES ($1,$2,$3,'Brand B')",
    [brandB, world.tenantId, `b-${brandB}`],
  );
  await owner.query(
    "INSERT INTO menu_categories (id,tenant_id,brand_id,name) VALUES ($1,$3,$4,'Category A'),($2,$3,$5,'Category B')",
    [categoryA, categoryB, world.tenantId, world.brandId, brandB],
  );
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId: world.outletA,
    role: "primary",
    label: "Second opinion race",
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Missing node fixture");
  const enqueue = async (name: string, aggregateType: string) => {
    const event = eventEnvelopeSchema.parse({
      id: createUlid(),
      tenantId: world.tenantId,
      outletId: world.outletA,
      name,
      version: 1,
      aggregateType,
      aggregateId: randomUUID(),
      sequence: 1,
      occurredAt: new Date().toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: randomUUID(),
      payloadSchemaRef: `${name}.v1`,
      payload: {},
    });
    await withTenant(db, node.context, (tx) =>
      queue.enqueueEdgeEvent(tx, node.context, {
        edgeNodeId: node.scope.edgeNodeId,
        direction: "cloud_to_edge",
        kind: "transaction_event",
        event,
      }),
    );
    return event.id;
  };
  await enqueue("qr_order.placed", "qr_order");
  await settleCloud(owner);
  await publisher.publishCatalogForNode(db, {
    tenantId: tenantIdSchema.parse(world.tenantId),
    outletId: outletIdSchema.parse(world.outletA),
    edgeNodeId: node.scope.edgeNodeId,
    stream: "menu_categories",
  });
  await enqueue("wifi_quota.updated", "wifi_quota");
  await enqueue("panic_alert.resolved", "panic_alert");
  return {
    world,
    brandB,
    categoryA,
    categoryB,
    credential: registered.credential,
    node,
  };
}

describe("#818 P1-1 atomic brand admission and delivery", () => {
  it("retains the outlet lock while the actual HTTP catalog SELECT waits on a table barrier", async () => {
    const f = await fixture();
    const barrier = await owner.connect();
    let pending: Promise<request.Response> | undefined;
    try {
      await barrier.query("BEGIN");
      const blockerPid = (
        await barrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows[0]!.pid;
      await barrier.query(
        "LOCK TABLE menu_categories IN ACCESS EXCLUSIVE MODE",
      );
      pending = request(app)
        .get("/api/edge-sync/catalog")
        .set("Authorization", `Bearer ${f.credential}`)
        .query({ stream: "menu_categories", protocolVersion: 3, limit: 100 })
        .then((response) => response);
      await vi.waitFor(
        async () => {
          const waiting = await owner.query(
            "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE '%menu_categories%' AND query ILIKE '%select%'",
            [blockerPid],
          );
          expect(waiting.rowCount).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 20 },
      );
      const changer = await owner.connect();
      try {
        await changer.query("BEGIN");
        await changer.query("SET LOCAL lock_timeout='200ms'");
        await expect(
          changer.query("UPDATE outlets SET brand_id=$1 WHERE id=$2", [
            f.brandB,
            f.world.outletA,
          ]),
        ).rejects.toMatchObject({ code: "55P03" });
      } finally {
        await changer.query("ROLLBACK");
        changer.release();
      }
      await barrier.query("COMMIT");
      const response = await pending;
      pending = undefined;
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).toContain(f.categoryA);
      expect(JSON.stringify(response.body)).not.toContain(f.categoryB);
      await owner.query("UPDATE outlets SET brand_id=$1 WHERE id=$2", [
        f.brandB,
        f.world.outletA,
      ]);
      const moved = await request(app)
        .get("/api/edge-sync/catalog")
        .set("Authorization", `Bearer ${f.credential}`)
        .query({ stream: "menu_categories", protocolVersion: 3, limit: 100 });
      expect(moved.status).toBe(403);
    } finally {
      await barrier.query("ROLLBACK").catch(() => undefined);
      barrier.release();
      await pending?.catch(() => undefined);
    }
  }, 30_000);

  it("refuses HTTP catalog if the brand move commits after the earlier admission check", async () => {
    const f = await fixture();
    const original = publisher.isCatalogDeliveryRefused;
    let moved = false;
    vi.spyOn(publisher, "isCatalogDeliveryRefused").mockImplementation(
      async (...args) => {
        const refused = await original(...args);
        if (!refused && !moved) {
          await owner.query("UPDATE outlets SET brand_id=$1 WHERE id=$2", [
            f.brandB,
            f.world.outletA,
          ]);
          moved = true;
        }
        return refused;
      },
    );
    const response = await request(app)
      .get("/api/edge-sync/catalog")
      .set("Authorization", `Bearer ${f.credential}`)
      .query({ stream: "menu_categories", protocolVersion: 3, limit: 100 });
    expect(moved).toBe(true);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain(f.categoryB);
  });

  it("holds the outlet brand through link queue selection and preserves outlet event slots after the move", async () => {
    const f = await fixture();
    const store = createDbLinkStore({
      database: db,
      context: f.node.context,
      node: f.node.scope,
      outboundDirection: "cloud_to_edge",
    });
    const before = await owner.query<{
      link_seq: string;
      aggregate_type: string;
      event: { id: string };
    }>(
      "SELECT link_seq,aggregate_type,event FROM edge_outbound_queue WHERE edge_node_id=$1 AND direction='cloud_to_edge' ORDER BY link_seq",
      [f.node.scope.edgeNodeId],
    );
    const original = queue.neutralizeCatalogRowsIfRefused;
    let attempted = false;
    let movedDuringRead = false;
    vi.spyOn(queue, "neutralizeCatalogRowsIfRefused").mockImplementation(
      async (...args) => {
        const result = await original(...args);
        if (!attempted) {
          attempted = true;
          const changer = await owner.connect();
          try {
            await changer.query("BEGIN");
            await changer.query("SET LOCAL lock_timeout='200ms'");
            await changer.query("UPDATE outlets SET brand_id=$1 WHERE id=$2", [
              f.brandB,
              f.world.outletA,
            ]);
            await changer.query("COMMIT");
            movedDuringRead = true;
          } catch (error) {
            await changer.query("ROLLBACK");
            expect(error).toMatchObject({ code: "55P03" });
          } finally {
            changer.release();
          }
        }
        return result;
      },
    );
    const first = await store.readOutbound(0, 1000);
    expect(attempted).toBe(true);
    expect(movedDuringRead).toBe(false);
    expect(JSON.stringify(first)).toContain(f.categoryA);
    await owner.query("UPDATE outlets SET brand_id=$1 WHERE id=$2", [
      f.brandB,
      f.world.outletA,
    ]);
    const after = await store.readOutbound(0, 1000);
    expect(after.map((row) => row.linkSeq)).toEqual(
      before.rows.map((row) => Number(row.link_seq)),
    );
    for (const row of before.rows.filter(
      (row) => row.aggregate_type !== "catalog_record",
    )) {
      expect(
        after.find((event) => event.linkSeq === Number(row.link_seq))?.event.id,
      ).toBe(row.event.id);
    }
    expect(JSON.stringify(after)).not.toContain(f.categoryA);
    expect(JSON.stringify(after)).not.toContain(f.categoryB);
    expect(after).toHaveLength(before.rows.length);
  });
});
