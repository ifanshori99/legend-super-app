// legend-3k41y, CTO decision after the brand move fail-closed guard
// (edge-brand-move-fail-closed.test.ts): the node-wide block is too wide.
// An outlet does not change when its brand moves, so outlet-scoped
// cloud_to_edge events must still reach a node whose publisher cursors are
// `blocked_at`: the emergency alert (safety), the QR order, the Wi-Fi quota.
// Only brand-dependent traffic stays refused: `catalog_record` events and the
// HTTP catalog pull.
//
// Written from the brief and the existing test fixtures, not from the guard.
//
// Assumptions:
//  - Events are queued the way the services do: the panic event through the
//    real `resolveEmergencyAlert`; the QR order and Wi-Fi quota events through
//    `enqueueEdgeEvent` with a valid envelope (kind `transaction_event`,
//    names `qr_order.placed` / `wifi_quota.updated`). Their payloads are
//    minimal, delivery is what is asserted.
//  - Staff pin events are not covered: pin hash material only travels
//    edge -> cloud, so no cloud_to_edge staff pin event exists.
//  - The events are queued AFTER the node is blocked (the worst case for a
//    guard that looks at the cursor), and the node is also checked for the
//    old catalog_record events queued before the move.
//  - A refusal on the catalog pull is an empty result or a 4xx.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { publishCatalogForNode } from "../services/edge-master-data-publisher.ts";
import { enqueueEdgeEvent } from "../services/edge-queue.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { resolveEmergencyAlert } from "../services/panic-alert-cloud.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { settleCloud } from "./helpers/catalog-cloud.ts";
import {
  asTenant,
  createWorld,
  owner,
  type World,
} from "./member-loyalty-helpers.ts";

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
    label: "Blocked node outlet events",
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

const outletScope = (world: World, outletId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(world.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/** Queues one cloud_to_edge event for the node, like a service transaction. */
async function enqueueForNode(
  world: World,
  node: Authenticated,
  name: string,
  aggregateType: string,
) {
  const event: EventEnvelope = {
    id: createUlid() as EventEnvelope["id"],
    tenantId: world.tenantId as EventEnvelope["tenantId"],
    outletId: world.outletA as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType,
    aggregateId: randomUUID(),
    sequence: 1,
    occurredAt: new Date().toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `blocked-node-${randomUUID()}`,
    payloadSchemaRef: `${name}.v1`,
    payload: {},
  };
  await withTenant(db, node.context, (tx) =>
    enqueueEdgeEvent(tx, node.context, {
      edgeNodeId: node.scope.edgeNodeId,
      direction: "cloud_to_edge",
      kind: "transaction_event",
      event,
    }),
  );
  return event;
}

/** A panic alert of the outlet, resolved by the cloud: the real service queues it. */
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

/**
 * Outlet A starts on brand A with a node; a brand A category is published and
 * queued; the node stays offline. The outlet moves to brand B, the publisher
 * notices and blocks the node. Then outlet-scoped events are queued.
 */
async function blockedNodeWithOutletEvents() {
  const world = await createWorld();
  const brandB = randomUUID();
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand B')`,
    [brandB, world.tenantId, `brand-${brandB}`],
  );
  const { node, credential } = await provision(world, world.outletA);
  const oldCategory = randomUUID();
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Brand A before move')`,
    [oldCategory, world.tenantId, world.brandId],
  );
  await settleCloud(owner);
  await publish(world, world.outletA, node);
  await owner.query(`UPDATE outlets SET brand_id = $1 WHERE id = $2`, [
    brandB,
    world.outletA,
  ]);
  await owner.query(
    `INSERT INTO menu_categories (id, tenant_id, brand_id, name) VALUES ($1, $2, $3, 'Brand B')`,
    [randomUUID(), world.tenantId, brandB],
  );
  await settleCloud(owner);
  await publish(world, world.outletA, node);

  // Precondition: the node really is blocked, so a pass here is not vacuous.
  const blocked = await owner.query(
    `SELECT blocked_at FROM edge_catalog_publisher_cursors WHERE edge_node_id = $1`,
    [node.scope.edgeNodeId],
  );
  expect(blocked.rows.length).toBeGreaterThan(0);
  expect(blocked.rows.every((row) => row.blocked_at !== null)).toBe(true);

  const qr = await enqueueForNode(world, node, "qr_order.placed", "qr_order");
  const wifi = await enqueueForNode(
    world,
    node,
    "wifi_quota.updated",
    "wifi_quota",
  );
  const alertId = await resolvePanicAlert(world);
  return { world, node, credential, oldCategory, qr, wifi, alertId };
}

describe("legend-3k41y a blocked node still receives outlet-scoped events", () => {
  it("delivers the panic alert event to a blocked node", async () => {
    const f = await blockedNodeWithOutletEvents();
    const delivered = await deliveredByQueue(f.node);
    const names = delivered.map((event) => event.name);
    expect(names).toContain("panic_alert.resolved");
    expect(delivered.some((event) => event.aggregateId === f.alertId)).toBe(
      true,
    );
  }, 60_000);

  it("delivers the QR order event to a blocked node", async () => {
    const f = await blockedNodeWithOutletEvents();
    const delivered = await deliveredByQueue(f.node);
    expect(delivered.map((event) => event.id)).toContain(f.qr.id);
  }, 60_000);

  it("delivers the Wi-Fi quota event to a blocked node", async () => {
    const f = await blockedNodeWithOutletEvents();
    const delivered = await deliveredByQueue(f.node);
    expect(delivered.map((event) => event.id)).toContain(f.wifi.id);
  }, 60_000);

  it("still delivers no catalog event through the queue to the blocked node", async () => {
    const f = await blockedNodeWithOutletEvents();
    const delivered = await deliveredByQueue(f.node);
    // Not vacuous: the outlet-scoped events are there ...
    expect(delivered.map((event) => event.id)).toContain(f.qr.id);
    // ... and the brand A catalog event queued before the move is not.
    const text = JSON.stringify(delivered);
    expect(text).not.toContain(f.oldCategory);
    expect(text).not.toContain("catalog_record");
  }, 60_000);

  it("still serves no catalog record through the HTTP pull to the blocked node", async () => {
    const f = await blockedNodeWithOutletEvents();
    const records = await pulled(f.credential);
    expect(records).toEqual([]);
  }, 60_000);
});
