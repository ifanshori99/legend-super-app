// legend-3k41y: readOutbound checks "is this node refused?" (cursor blocked_at
// set, or the cursor's brand differs from the outlet's brand) while holding
// an outlet SHARE lock through queue selection. A healthy node does not take the cloud_to_edge
// cursor lock at all; a refused node takes the lock, re-checks under it, and
// only then replaces its pending catalog rows with placeholders.
//
// Written from the brief (fixtures mirror edge-brand-move-placeholder.test.ts),
// not from the implementation. The cursor lock is held from the test with a
// plain `SELECT ... FOR UPDATE` on the node's cloud_to_edge sync_cursors row in
// an open transaction (the same row lock the queue read takes).
//
// Assumptions:
//  - "Without waiting" (test 1) means: readOutbound settles within 5 s while
//    the lock is held elsewhere. Today it blocks until the lock is released,
//    so the race times out (the failure is the blocking, not a flake).
//  - "Waiting" (tests 2, 3) is proven by pg_stat_activity: a backend is in a
//    Lock wait, then the read promise is asserted not yet settled.
//  - Queue before the move: c >= 2 catalog_record rows then one panic row.
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { registerEdgeLinkPlaceholderApplier } from "../edge/link-dead-letter-applier.ts";
import { registerMasterDataEdgeApplier } from "../edge/master-data-applier.ts";
import { registerPanicAlertEdgeApplier } from "../edge/panic-alert-applier.ts";
import { publishCatalogForNode } from "../services/edge-master-data-publisher.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
} from "../services/edge-node.service.ts";
import { resolveEmergencyAlert } from "../services/panic-alert-cloud.service.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import { asTenant, createWorld, owner } from "./member-loyalty-helpers.ts";

afterAll(async () => owner.end());

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerMasterDataEdgeApplier();
  registerPanicAlertEdgeApplier();
  registerEdgeLinkPlaceholderApplier();
});
afterEach(() => resetEdgeApplierRegistryForTests());

type Authenticated = NonNullable<
  Awaited<ReturnType<typeof authenticateEdgeCredential>>
>;
type World = Awaited<ReturnType<typeof createWorld>>;

async function provision(world: World, outletId: string) {
  const registered = await registerEdgeNode(world.context, randomUUID(), {
    outletId,
    role: "primary",
    label: "Unlocked check",
  });
  const node = await authenticateEdgeCredential(registered.credential);
  if (!node) throw new Error("Node authentication failed");
  return node;
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

const outletScope = (world: World, outletId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(world.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

async function resolvePanicAlert(world: World) {
  const deviceId = randomUUID();
  const alertId = randomUUID();
  await asTenant(world.tenantId, async (client) => {
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'panic_button', 'Perangkat uji', now())`,
      [deviceId, world.tenantId, world.outletA],
    );
    await client.query(
      `INSERT INTO panic_alerts (id, tenant_id, outlet_id, device_id, first_device_event_id,
                                 unit_code_snapshot, facility_name_snapshot, device_label_snapshot, received_at)
       VALUES ($1, $2, $3, $4, $5, 'P1', 'Fasilitas uji', 'Tombol uji', now())`,
      [alertId, world.tenantId, world.outletA, deviceId, `evt-${alertId}`],
    );
  });
  await resolveEmergencyAlert(
    outletScope(world, world.outletA),
    world.outletA,
    alertId,
    randomUUID(),
    "Aman, tamu sudah dibantu",
  );
  return alertId;
}

type QueueRow = {
  link_seq: number;
  event_id: string;
  status: string;
  aggregate_type: string;
  event: EventEnvelope;
};

async function queueRows(nodeId: string): Promise<QueueRow[]> {
  const res = await owner.query(
    `SELECT link_seq::text, event_id::text, status, aggregate_type, event
       FROM edge_outbound_queue
      WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' ORDER BY link_seq`,
    [nodeId],
  );
  return res.rows.map((row) => ({ ...row, link_seq: Number(row.link_seq) }));
}

async function deadLetterRows(nodeId: string) {
  const res = await owner.query<{ link_seq: string; reason: string }>(
    `SELECT link_seq::text, reason FROM edge_link_dead_letters
      WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' ORDER BY link_seq`,
    [nodeId],
  );
  return res.rows.map((row) => ({ ...row, link_seq: Number(row.link_seq) }));
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Outlet A (brand A) with an offline node: catalog rows 1..c, then a panic. */
async function setup() {
  const world = await createWorld();
  const brandB = randomUUID();
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B')`,
    [brandB, world.tenantId, `brand-${brandB}`],
  );
  const node = await provision(world, world.outletA);
  for (let i = 0; i < 3; i += 1)
    await owner.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), world.tenantId, world.brandId, `Brand A before move ${i}`],
    );
  await settleCloud(owner);
  await publish(world, world.outletA, node);
  const alertId = await resolvePanicAlert(world);

  const before = await queueRows(node.scope.edgeNodeId);
  const c = before.filter((r) => r.aggregate_type === "catalog_record").length;
  expect(c).toBeGreaterThanOrEqual(2);
  expect(before.map((r) => r.link_seq)).toEqual(range(1, c + 1));
  expect(before[c]!.event.aggregateId).toBe(alertId);
  return {
    world,
    brandB,
    node,
    nodeId: node.scope.edgeNodeId,
    before,
    c,
    panicSeq: c + 1,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;

/** The outlet moves to brand B (committed). `block` lets the publisher notice. */
async function moveBrand(f: Fixture, options: { block: boolean }) {
  await owner.query(`UPDATE outlets SET brand_id = $1 WHERE id = $2`, [
    f.brandB,
    f.world.outletA,
  ]);
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Brand B')`,
    [randomUUID(), f.world.tenantId, f.brandB],
  );
  await settleCloud(owner);
  if (options.block) {
    await publish(f.world, f.world.outletA, f.node);
    const state = await owner.query(
      `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
      [f.nodeId],
    );
    expect(state.rows.length).toBeGreaterThan(0);
    expect(state.rows.every((row) => row.blocked_at !== null)).toBe(true);
  }
}

/** Holds the node's cloud_to_edge cursor row lock in an open transaction. */
async function holdCursorLock(nodeId: string) {
  const client = await owner.connect();
  let open = true;
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT 1 FROM sync_cursors
        WHERE edge_node_id = $1 AND direction = 'cloud_to_edge' FOR UPDATE`,
      [nodeId],
    );
    expect(locked.rowCount).toBe(1);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw error;
  }
  return {
    async release() {
      if (!open) return;
      open = false;
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
  };
}

/** Waits until some backend is blocked on a lock (the read is queued behind ours). */
async function untilALockWaiter() {
  await vi.waitFor(
    async () => {
      const res = await owner.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'`,
      );
      expect(Number(res.rows[0]!.n)).toBeGreaterThan(0);
    },
    { timeout: 10_000, interval: 25 },
  );
}

const SETTLE_TIMEOUT_MS = 5_000;

type ReadResult = Awaited<
  ReturnType<ReturnType<typeof cloudStore>["readOutbound"]>
>;

/** Starts a read and tracks whether it has settled. */
function startRead(f: Fixture) {
  const state = { settled: false };
  const promise: Promise<ReadResult> = cloudStore(f.node)
    .readOutbound(0, 1000)
    .finally(() => {
      state.settled = true;
    });
  // Avoid an unhandled rejection if the test fails before awaiting it.
  promise.catch(() => undefined);
  return { state, promise };
}

describe("legend-3k41y unlocked refusal check in readOutbound", () => {
  it("legend-3k41y healthy node: readOutbound completes without waiting for the cursor lock held elsewhere", async () => {
    const f = await setup();
    const lock = await holdCursorLock(f.nodeId);
    const { state, promise } = startRead(f);
    try {
      const outcome = await Promise.race([
        promise.then(() => "done" as const),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), SETTLE_TIMEOUT_MS),
        ),
      ]);
      // Today the read queues behind the lock: the race ends "blocked".
      expect(outcome, "readOutbound blocked on the cursor lock").toBe("done");
      expect(state.settled).toBe(true);
    } finally {
      await lock.release();
      await promise.catch(() => undefined);
    }

    const read = await promise;
    expect(read.map((q) => q.linkSeq)).toEqual(range(1, f.panicSeq));
    expect(
      read.filter((q) => q.event.aggregateType === "catalog_record"),
    ).toHaveLength(f.c);
    // Healthy: nothing replaced, nothing dead-lettered.
    expect(await queueRows(f.nodeId)).toEqual(f.before);
    expect(await deadLetterRows(f.nodeId)).toEqual([]);
  }, 60_000);

  it("legend-3k41y refused node: readOutbound waits for the cursor lock, then replaces and returns no catalog_record, no hole", async () => {
    const f = await setup();
    await moveBrand(f, { block: false });
    const lock = await holdCursorLock(f.nodeId);
    const { state, promise } = startRead(f);
    try {
      await untilALockWaiter();
      // Refused: the read must still be queued behind the lock.
      expect(state.settled).toBe(false);
    } finally {
      await lock.release();
    }

    const read = await promise;
    expect(read.some((q) => q.event.aggregateType === "catalog_record")).toBe(
      false,
    );
    expect(read.map((q) => q.linkSeq)).toEqual(range(1, f.panicSeq));
    const rows = await queueRows(f.nodeId);
    expect(rows.map((r) => r.link_seq)).toEqual(range(1, f.panicSeq));
    expect(
      rows
        .slice(0, f.c)
        .some((r) => r.event.aggregateType === "catalog_record"),
    ).toBe(false);
    expect(rows[f.c]).toMatchObject({ event: f.before[f.c]!.event });
    expect((await deadLetterRows(f.nodeId)).map((d) => d.link_seq)).toEqual(
      range(1, f.c),
    );
  }, 60_000);

  it("legend-3k41y refusal cleared while waiting for the lock: nothing is dead-lettered and the catalog rows stay", async () => {
    const f = await setup();
    await owner.query(
      "UPDATE edge_catalog_publisher_cursors SET blocked_at=now() WHERE edge_node_id=$1",
      [f.nodeId],
    );
    const lock = await holdCursorLock(f.nodeId);
    const { promise } = startRead(f);
    try {
      // The read saw the refusal and is queued behind our lock ...
      await untilALockWaiter();
      // ... and the publisher block clears before it gets in. Changing the
      // outlet brand here would wait on the reader's SHARE lock; the new
      // second-opinion race test verifies that required serialization.
      await owner.query(
        "UPDATE edge_catalog_publisher_cursors SET blocked_at=NULL WHERE edge_node_id=$1",
        [f.nodeId],
      );
    } finally {
      await lock.release();
    }

    const read = await promise;
    expect(read.map((q) => q.linkSeq)).toEqual(range(1, f.panicSeq));
    expect(
      read.filter((q) => q.event.aggregateType === "catalog_record"),
    ).toHaveLength(f.c);
    expect(await queueRows(f.nodeId)).toEqual(f.before);
    expect(await deadLetterRows(f.nodeId)).toEqual([]);
  }, 60_000);

  it.each([
    { label: "brand changed, publisher never ran", block: false },
    { label: "node blocked by the publisher", block: true },
  ])(
    "legend-3k41y brand move committed right before the read ($label): caught and replaced as before",
    async ({ block }) => {
      const f = await setup();
      await moveBrand(f, { block });

      const read = await cloudStore(f.node).readOutbound(0, 1000);

      expect(read.map((q) => q.linkSeq)).toEqual(range(1, f.panicSeq));
      expect(read.some((q) => q.event.aggregateType === "catalog_record")).toBe(
        false,
      );
      const rows = await queueRows(f.nodeId);
      expect(rows.map((r) => r.link_seq)).toEqual(range(1, f.panicSeq));
      expect(
        rows
          .slice(0, f.c)
          .some((r) => r.event.aggregateType === "catalog_record"),
      ).toBe(false);
      expect(rows[f.c]).toMatchObject({ event: f.before[f.c]!.event });
      const dead = await deadLetterRows(f.nodeId);
      expect(dead.map((d) => d.link_seq)).toEqual(range(1, f.c));
      expect(dead.every((d) => d.reason === "brand_moved")).toBe(true);
    },
    60_000,
  );
});
