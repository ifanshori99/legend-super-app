// Edge link hardening, round 2 (bead legend-x3lv; brief sub-ws02-edge section A
// items 1-4). Written from the brief, not from the implementation.
//
//  1. credential rotation (service + route),
//  2. failed-authentication rate limit on the link upgrade,
//  3. acked-queue prune,
//  4. multi-instance revoke broadcast over NOTIFY.
//
// Assumptions (brief ambiguities):
//  - rotateEdgeNodeCredential returns an object that contains the new
//    credential as a string starting with "edg1." (like registerEdgeNode's
//    `credential`); it is located by scanning the result, so its key name is
//    not relied on. `now` is a Date.
//  - The grace period is the default 24 h (EDGE_CREDENTIAL_ROTATION_GRACE_HOURS
//    is not set here). Expiry is driven by passing `now` to the rotation, never
//    by sleeping, except the live-link test which uses a ~3 s grace window.
//  - The failure limit is per client address only (no per-node lockout). The
//    defaults (10 per 300 s) are used unless a test passes authFailureLimit. "Past the limit" = the 11th attempt is refused, before
//    `authenticate` runs. The window is measured from the first failure or
//    aligned to the window size; the test clock is placed so both agree.
//  - pruneAckedEdgeQueue's return value is not asserted; rows are checked in
//    the database. Backdating `acked_at` through the migration owner is allowed.
//  - The hourly prune timer and the in-process revoke listener are not tested
//    here (timer cannot be waited out). The NOTIFY path is isolated by sending
//    pg_notify('edge_node_revoked', <id>) directly.
//  - HTTP: success is 200 or 201; an out-of-scope caller gets 403 or 404.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import express from "express";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendFixtures,
  createUlid,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EventEnvelope } from "@starter/shared/events";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { mintEdgeCredential } from "../edge/credential.ts";
import { createEdgeLinkClient } from "../edge/link-client.ts";
import { createEdgeLinkServer } from "../edge/link-server.ts";
import { createFixedWindowCounter } from "../lib/fixed-window-counter.ts";
import type { LinkScope, LinkStore } from "../edge/link-peer.ts";
import { registerEdgeLink } from "../edge/runtime.ts";
import { expressClientAddress } from "../lib/client-address.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { enrollDevice } from "../services/device.service.ts";
import {
  EDGE_NODE_REVOKED_CHANNEL,
  authenticateEdgeCredential,
  isEdgeNodeActive,
  listEdgeNodes,
  registerEdgeNode,
  revokeEdgeNode,
  rotateEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import {
  enqueueEdgeEvent,
  pruneAckedEdgeQueue,
} from "../services/edge-queue.service.ts";
import { agent, originHeader, verifySessionMfa } from "./helpers";
import { staffWithRole } from "./floor-test-helpers";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const actor = randomUUID();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const audits: Record<string, unknown>[] = [];

type Fixture = { tenantId: string; outletId: string };
const fixtures: Fixture[] = [];
const seededOutlets: string[] = [];

const scopeFor = (tenantId: string, outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
const outletScope = (fixture: Fixture) =>
  scopeFor(fixture.tenantId, fixture.outletId);

/** A disposable tenant with one brand, legal entity and outlet. */
async function createFixture(): Promise<Fixture> {
  const fixture: Fixture = { tenantId: randomUUID(), outletId: randomUUID() };
  const brand = randomUUID();
  const entity = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Tenant Edge Uji 2', plan, 'active', deployment_mode, feature_flags, limits, $3
       FROM tenants WHERE id = $4`,
    [
      fixture.tenantId,
      `edge-uji2-${randomBytes(4).toString("hex")}`,
      actor,
      cafeLegendPlatformFixtures.tenant.id,
    ],
  );
  await owner.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand')`,
    [brand, fixture.tenantId, `edge-uji2-${randomBytes(3).toString("hex")}`],
  );
  await owner.query(
    `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT Uji', false)`,
    [entity, fixture.tenantId],
  );
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, opening_hours, status)
     VALUES ($1, $2, $3, $4, 'UJI-02', 'Outlet Uji', 'Jl. Uji', '{}', 'active')`,
    [fixture.outletId, fixture.tenantId, brand, entity],
  );
  fixtures.push(fixture);
  return fixture;
}

/** A fresh tenant + outlet + active node of the given role. */
async function makeNode(role: "primary" | "standby" = "primary") {
  const fixture = await createFixture();
  const registered = await registerEdgeNode(outletScope(fixture), actor, {
    outletId: fixture.outletId,
    role,
    label: "Node uji",
  });
  return {
    fixture,
    context: outletScope(fixture),
    id: registered.edgeNode.id,
    credential: registered.credential,
    scope: {
      tenantId: fixture.tenantId,
      outletId: fixture.outletId,
      edgeNodeId: registered.edgeNode.id,
    } as LinkScope,
  };
}
type TestNode = Awaited<ReturnType<typeof makeNode>>;

const seeded = cafeLegendFixtures;

/** A private outlet in the seeded tenant (roles for HTTP tests live there). */
async function cloneSeededOutlet(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet uji rotasi', address, timezone, opening_hours, status
       FROM outlets WHERE id = $3`,
    [id, `RT${id.slice(0, 8)}`.toUpperCase(), seeded.outlets[0].id],
  );
  seededOutlets.push(id);
  return id;
}

/** First string in `value` that looks like an edge credential. */
function findCredential(value: unknown): string | null {
  if (typeof value === "string") return /^edg1\./.test(value) ? value : null;
  if (value && typeof value === "object")
    for (const inner of Object.values(value)) {
      const found = findCredential(inner);
      if (found) return found;
    }
  return null;
}

function credentialOf(result: unknown): string {
  const found = findCredential(result);
  if (!found) throw new Error("rotation returned no credential");
  return found;
}

const nodeRow = async (id: string) =>
  (
    await owner.query(
      `SELECT credential_hash, previous_credential_hash, previous_credential_expires_at
         FROM edge_nodes WHERE id = $1`,
      [id],
    )
  ).rows[0] as {
    credential_hash: string;
    previous_credential_hash: string | null;
    previous_credential_expires_at: Date | null;
  };

async function settle(until: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!until()) {
    if (Date.now() > end) throw new Error("Did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function emptyStore(): LinkStore {
  return {
    outboundHead: async () => 0,
    lastAckedOutbound: async () => 0,
    readOutbound: async () => [],
    ackOutbound: async () => undefined,
    lastReceivedInbound: async () => 0,
    applyInbound: async () => undefined,
  };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter({
    record: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
  });
});

afterAll(async () => {
  setAuditWriter(null);
  // Edge rows are append-only; replica mode skips triggers and FK checks so
  // later suites never see these fixtures (same cleanup as edge-db-hardening).
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const tenantIds = fixtures.map((f) => f.tenantId);
    for (const table of [
      "edge_link_slots",
      "edge_inbound_events",
      "edge_received_events",
      "edge_sync_conflicts",
      "edge_outbound_queue",
      "sync_cursors",
      "edge_nodes",
      "devices",
      "outlets",
      "legal_entities",
      "brands",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [
        tenantIds,
      ]);
    await client.query("DELETE FROM tenants WHERE id = ANY($1)", [tenantIds]);
    if (seededOutlets.length > 0) {
      for (const table of [
        "edge_link_slots",
        "edge_inbound_events",
        "edge_received_events",
        "edge_sync_conflicts",
        "edge_outbound_queue",
        "sync_cursors",
        "edge_nodes",
        "devices",
      ])
        await client.query(`DELETE FROM ${table} WHERE outlet_id = ANY($1)`, [
          seededOutlets,
        ]);
      await client.query("DELETE FROM outlets WHERE id = ANY($1)", [
        seededOutlets,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await owner.end();
});

// ---------------------------------------------------------------------------
describe("legend-x3lv #1 credential rotation (service)", () => {
  it("rotation: the old credential works inside the grace window, the new one works, and the old hash is kept with a 24 h expiry", async () => {
    const node = await makeNode();
    const before = await nodeRow(node.id);
    expect(before.previous_credential_hash).toBeNull();
    const now = new Date(Date.now() - 2 * HOUR);

    const rotated = await rotateEdgeNodeCredential(
      node.context,
      actor,
      node.id,
      now,
    );
    const fresh = credentialOf(rotated);

    expect(fresh).not.toBe(node.credential);
    // The grace window (expiry = now + 24 h) is still open in real time.
    expect((await authenticateEdgeCredential(node.credential))?.scope).toEqual(
      node.scope,
    );
    expect((await authenticateEdgeCredential(fresh))?.scope).toEqual(
      node.scope,
    );
    const after = await nodeRow(node.id);
    expect(after.previous_credential_hash).toBe(before.credential_hash);
    expect(after.credential_hash).not.toBe(before.credential_hash);
    expect(fresh).not.toContain(after.credential_hash);
    expect(
      Math.abs(
        after.previous_credential_expires_at!.getTime() - (now.getTime() + DAY),
      ),
    ).toBeLessThan(1000);
  });

  it("rotation: once the grace window has passed the old credential is refused and the new one still works", async () => {
    const node = await makeNode();
    // Rotated 25 h ago: the 24 h grace ended an hour ago.
    const rotated = await rotateEdgeNodeCredential(
      node.context,
      actor,
      node.id,
      new Date(Date.now() - 25 * HOUR),
    );
    expect(await authenticateEdgeCredential(node.credential)).toBeNull();
    const node2 = await authenticateEdgeCredential(credentialOf(rotated));
    expect(node2?.scope).toEqual(node.scope);
    expect(await isEdgeNodeActive(node2!)).toBe(true);
  });

  it("rotation: rotating again replaces the previous credential", async () => {
    const node = await makeNode();
    const second = credentialOf(
      await rotateEdgeNodeCredential(node.context, actor, node.id),
    );
    const third = credentialOf(
      await rotateEdgeNodeCredential(node.context, actor, node.id, new Date(), {
        force: true,
      }),
    );
    // v1 (the registration credential) is no longer the previous one.
    expect(await authenticateEdgeCredential(node.credential)).toBeNull();
    // v2 is now the previous one and still inside its grace window.
    expect(await authenticateEdgeCredential(second)).not.toBeNull();
    expect(await authenticateEdgeCredential(third)).not.toBeNull();
    const row = await nodeRow(node.id);
    expect(row.previous_credential_hash).not.toBeNull();
    expect(new Set([third, second, node.credential]).size).toBe(3);
  });

  it("rotation: a second rotation inside an open grace is refused (409) unless forced, and changes nothing", async () => {
    const node = await makeNode();
    const second = credentialOf(
      await rotateEdgeNodeCredential(node.context, actor, node.id),
    );
    const before = await nodeRow(node.id);
    await expect(
      rotateEdgeNodeCredential(node.context, actor, node.id),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await nodeRow(node.id)).toEqual(before);
    expect(await authenticateEdgeCredential(second)).not.toBeNull();
    expect(await authenticateEdgeCredential(node.credential)).not.toBeNull();
    // Once the grace has ended a plain rotation is allowed again.
    const later = new Date(Date.now() + DAY + HOUR);
    await expect(
      rotateEdgeNodeCredential(node.context, actor, node.id, later),
    ).resolves.toBeTruthy();
  });

  it("rotation: graceHours 0 cuts the old credential off at once; above the env maximum is refused", async () => {
    const node = await makeNode();
    const rotated = await rotateEdgeNodeCredential(
      node.context,
      actor,
      node.id,
      new Date(),
      { graceHours: 0 },
    );
    expect(rotated.previousCredentialExpiresAt).toBeNull();
    expect(await authenticateEdgeCredential(node.credential)).toBeNull();
    expect(
      await authenticateEdgeCredential(credentialOf(rotated)),
    ).not.toBeNull();
    const row = await nodeRow(node.id);
    expect(row.previous_credential_hash).toBeNull();
    // No grace open, so the next rotation needs no force; 25 h > 24 h max.
    await expect(
      rotateEdgeNodeCredential(node.context, actor, node.id, new Date(), {
        graceHours: 25,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const shorter = await rotateEdgeNodeCredential(
      node.context,
      actor,
      node.id,
      new Date(),
      { graceHours: 2 },
    );
    expect(
      Math.abs(
        new Date(shorter.previousCredentialExpiresAt!).getTime() -
          (Date.now() + 2 * HOUR),
      ),
    ).toBeLessThan(5000);
  });

  it("rotation: the credential is returned once and never listed or stored in clear", async () => {
    const node = await makeNode();
    const fresh = credentialOf(
      await rotateEdgeNodeCredential(node.context, actor, node.id),
    );
    const listed = JSON.stringify(await listEdgeNodes(node.context));
    const row = await nodeRow(node.id);
    expect(listed).not.toContain(fresh);
    expect(listed).not.toContain(node.credential);
    expect(listed).not.toContain(row.credential_hash);
    expect(listed).not.toContain(row.previous_credential_hash!);
    expect(JSON.stringify(row)).not.toContain(fresh);
  });

  it("rotation: another tenant cannot rotate a node it does not own, and nothing changes", async () => {
    const node = await makeNode();
    const stranger = await createFixture();
    const before = await nodeRow(node.id);
    await expect(
      rotateEdgeNodeCredential(outletScope(stranger), actor, node.id),
    ).rejects.toThrow();
    await expect(
      rotateEdgeNodeCredential(node.context, actor, randomUUID()),
    ).rejects.toThrow();
    expect(await nodeRow(node.id)).toEqual(before);
    expect(await authenticateEdgeCredential(node.credential)).not.toBeNull();
  });

  it("rotation: only active nodes can be rotated", async () => {
    const node = await makeNode();
    await revokeEdgeNode(node.context, actor, {
      edgeNodeId: node.id,
      reason: "Unit rusak",
    });
    const before = await nodeRow(node.id);
    await expect(
      rotateEdgeNodeCredential(node.context, actor, node.id),
    ).rejects.toThrow();
    expect(await nodeRow(node.id)).toEqual(before);
    expect(await authenticateEdgeCredential(node.credential)).toBeNull();
  });

  it("rotation: is audited like a revocation and the credential never reaches the audit entry", async () => {
    const revoked = await makeNode();
    audits.length = 0;
    await revokeEdgeNode(revoked.context, actor, {
      edgeNodeId: revoked.id,
      reason: "Unit rusak",
    });
    const revokeEntries = audits.splice(0);
    expect(revokeEntries.length).toBeGreaterThan(0);

    const node = await makeNode();
    audits.length = 0;
    const fresh = credentialOf(
      await rotateEdgeNodeCredential(node.context, actor, node.id),
    );
    const rotateEntries = audits.splice(0);
    expect(rotateEntries).toHaveLength(revokeEntries.length);
    expect(Object.keys(rotateEntries[0]!).sort()).toEqual(
      Object.keys(revokeEntries[0]!).sort(),
    );
    const serialised = JSON.stringify(rotateEntries);
    const row = await nodeRow(node.id);
    expect(serialised).not.toContain(fresh);
    expect(serialised).not.toContain(node.credential);
    expect(serialised).not.toContain(row.credential_hash);
    expect(serialised).toContain(node.id);
  });

  it("rotation: a live link on the old credential is closed once the grace window ends", async () => {
    const node = await makeNode();
    // Grace ends ~3 s from now (rotated 24 h - 3 s ago).
    await rotateEdgeNodeCredential(
      node.context,
      actor,
      node.id,
      new Date(Date.now() - DAY + 3000),
    );
    const live = createServer();
    const linkServer = createEdgeLinkServer(live, {
      version: "cloud",
      reverifyIntervalMs: 100,
      authenticate: (presented) => authenticateEdgeCredential(presented),
      isActive: (authenticated) => isEdgeNodeActive(authenticated),
      storeFor: () => emptyStore(),
    });
    await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(live.address() as AddressInfo).port}/api/edge-link`;
    const client = createEdgeLinkClient({
      url,
      credential: node.credential,
      scope: node.scope,
      store: emptyStore(),
      version: "edge",
    });
    try {
      await settle(() => client.state().cloudLink === "connected");
      // Expiry arrives on its own: the link is closed and stays refused.
      await settle(() => client.state().refused);
      expect(client.state().cloudLink).toBe("disconnected");
    } finally {
      await client.stop();
      await linkServer.close();
      await new Promise<void>((resolve) => live.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
describe("legend-x3lv #1 credential rotation (route)", () => {
  const app = createApp();

  async function seededNode() {
    const outletId = await cloneSeededOutlet();
    const context = scopeFor(seeded.tenant.id, outletId);
    const registered = await registerEdgeNode(context, actor, {
      outletId,
      role: "primary",
      label: "Node uji rute",
    });
    return {
      id: registered.edgeNode.id,
      credential: registered.credential,
      outletId,
    };
  }

  const rotate = (client: ReturnType<typeof agent>, id: string) =>
    client
      .post(`/api/edge-nodes/${id}/rotate-credential`)
      .set(originHeader)
      .send({});

  it("rotation: an authorised admin gets the new credential once, uncached", async () => {
    const node = await seededNode();
    const admin = await staffWithRole(app, { template: "owner" });
    await verifySessionMfa(admin.email);
    const response = await rotate(admin.client, node.id);
    expect([200, 201]).toContain(response.status);
    expect(response.headers["cache-control"]).toMatch(/no-store/);
    const fresh = credentialOf(response.body);
    expect((await authenticateEdgeCredential(fresh))?.scope.edgeNodeId).toBe(
      node.id,
    );
    // Grace: the previous credential still works for now.
    expect(await authenticateEdgeCredential(node.credential)).not.toBeNull();
    const row = await nodeRow(node.id);
    expect(JSON.stringify(response.body)).not.toContain(row.credential_hash);
    // Never shown again.
    const listed = JSON.stringify(
      await listEdgeNodes(scopeFor(seeded.tenant.id, node.outletId)),
    );
    expect(listed).not.toContain(fresh);
  });

  it("rotation: the route takes graceHours and force; a retried rotate is 409", async () => {
    const node = await seededNode();
    const admin = await staffWithRole(app, { template: "owner" });
    await verifySessionMfa(admin.email);
    const post = (body: object) =>
      admin.client
        .post(`/api/edge-nodes/${node.id}/rotate-credential`)
        .set(originHeader)
        .send(body);
    const first = await post({});
    expect(first.status).toBe(200);
    expect((await post({})).status).toBe(409);
    expect((await post({ graceHours: 999 })).status).toBeGreaterThanOrEqual(
      400,
    );
    const forced = await post({ force: true, graceHours: 0 });
    expect(forced.status).toBe(200);
    expect(forced.body.data.previousCredentialExpiresAt).toBeNull();
    expect(await authenticateEdgeCredential(node.credential)).toBeNull();
    expect(
      await authenticateEdgeCredential(credentialOf(first.body)),
    ).toBeNull();
    expect(
      await authenticateEdgeCredential(credentialOf(forced.body)),
    ).not.toBeNull();
  });

  it("rotation: anonymous callers get 401", async () => {
    const node = await seededNode();
    const response = await rotate(agent(app), node.id);
    expect(response.status).toBe(401);
    expect(await authenticateEdgeCredential(node.credential)).not.toBeNull();
    expect((await nodeRow(node.id)).previous_credential_hash).toBeNull();
  });

  it("rotation: staff without the revoke permission, or scoped to another outlet, are refused and nothing changes", async () => {
    const node = await seededNode();
    const cashier = await staffWithRole(app, { template: "cashier" });
    await verifySessionMfa(cashier.email);
    const elsewhere = await staffWithRole(app, {
      template: "outlet_manager",
      scopeType: "outlet",
      scopeId: seeded.outlets[1].id,
    });
    await verifySessionMfa(elsewhere.email);
    for (const staff of [cashier, elsewhere]) {
      const response = await rotate(staff.client, node.id);
      expect([403, 404]).toContain(response.status);
      expect(findCredential(response.body)).toBeNull();
    }
    expect((await nodeRow(node.id)).previous_credential_hash).toBeNull();
  });

  it("rotation: a node of another tenant, or an unknown id, is 404", async () => {
    const stranger = await makeNode();
    const admin = await staffWithRole(app, { template: "owner" });
    await verifySessionMfa(admin.email);
    expect((await rotate(admin.client, stranger.id)).status).toBe(404);
    expect((await rotate(admin.client, randomUUID())).status).toBe(404);
    expect((await nodeRow(stranger.id)).previous_credential_hash).toBeNull();
  });

  it("rotation: a revoked node cannot be rotated", async () => {
    const node = await seededNode();
    await revokeEdgeNode(scopeFor(seeded.tenant.id, node.outletId), actor, {
      edgeNodeId: node.id,
      reason: "Unit rusak",
    });
    const admin = await staffWithRole(app, { template: "owner" });
    await verifySessionMfa(admin.email);
    const response = await rotate(admin.client, node.id);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(findCredential(response.body)).toBeNull();
  });
});

describe("legend-saag device registry contract", () => {
  const app = createApp();

  it("lets a cloud registry manager list an outlet's devices with server time", async () => {
    const outletId = await cloneSeededOutlet();
    const device = await enrollDevice(
      scopeFor(seeded.tenant.id, outletId),
      actor,
      {
        outletId,
        type: "pos",
        label: "Kasir saag",
        stationId: null,
        idempotencyKey: randomUUID(),
      },
    );
    const admin = await staffWithRole(app, { template: "owner" });
    await verifySessionMfa(admin.email);
    const before = Date.now();
    const response = await admin.client
      .get("/api/edge/devices")
      .query({ outletId });
    const after = Date.now();
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { id: string }) => row.id)).toContain(
      device.device.id,
    );
    const serverTime = Date.parse(response.body.meta.serverTime);
    expect(Number.isFinite(serverTime)).toBe(true);
    expect(serverTime).toBeGreaterThanOrEqual(before - 1000);
    expect(serverTime).toBeLessThanOrEqual(after + 1000);
  });

  it("does not list another tenant's devices", async () => {
    const stranger = await makeNode();
    const device = await enrollDevice(stranger.context, actor, {
      outletId: stranger.fixture.outletId,
      type: "pos",
      label: "Kasir tenant lain",
      stationId: null,
      idempotencyKey: randomUUID(),
    });
    const admin = await staffWithRole(app, { template: "owner" });
    await verifySessionMfa(admin.email);
    const response = await admin.client
      .get("/api/edge/devices")
      .query({ outletId: stranger.fixture.outletId });
    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain(device.device.id);
  });

  it("does not let a cashier list registry devices", async () => {
    const outletId = await cloneSeededOutlet();
    const device = await enrollDevice(
      scopeFor(seeded.tenant.id, outletId),
      actor,
      {
        outletId,
        type: "pos",
        label: "Kasir privat",
        stationId: null,
        idempotencyKey: randomUUID(),
      },
    );
    const cashier = await staffWithRole(app, { template: "cashier" });
    await verifySessionMfa(cashier.email);
    const response = await cashier.client
      .get("/api/edge/devices")
      .query({ outletId });
    expect([403, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain(device.device.id);
  });

  it("does not let another tenant revoke a device even with a valid reason and idempotency key", async () => {
    const stranger = await makeNode();
    const device = await enrollDevice(stranger.context, actor, {
      outletId: stranger.fixture.outletId,
      type: "pos",
      label: "Kasir tenant lain",
      stationId: null,
      idempotencyKey: randomUUID(),
    });
    const admin = await staffWithRole(app, { template: "owner" });
    await verifySessionMfa(admin.email);
    const response = await admin.client
      .post(`/api/devices/${device.device.id}/revoke`)
      .set(originHeader)
      .send({ reason: "Perangkat hilang", idempotencyKey: randomUUID() });
    expect(response.status).toBe(404);
    const stored = await owner.query(
      "SELECT status FROM devices WHERE id = $1",
      [device.device.id],
    );
    expect(stored.rows[0]?.status).toBe("active");
  });

  it("does not let a cashier revoke a device", async () => {
    const outletId = await cloneSeededOutlet();
    const device = await enrollDevice(
      scopeFor(seeded.tenant.id, outletId),
      actor,
      {
        outletId,
        type: "pos",
        label: "Kasir terlindungi",
        stationId: null,
        idempotencyKey: randomUUID(),
      },
    );
    const cashier = await staffWithRole(app, { template: "cashier" });
    await verifySessionMfa(cashier.email);
    const response = await cashier.client
      .post(`/api/devices/${device.device.id}/revoke`)
      .set(originHeader)
      .send({ reason: "Perangkat hilang", idempotencyKey: randomUUID() });
    expect([403, 404]).toContain(response.status);
    const stored = await owner.query(
      "SELECT status FROM devices WHERE id = $1",
      [device.device.id],
    );
    expect(stored.rows[0]?.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
describe("legend-x3lv #2 failed-authentication rate limit on the link upgrade", () => {
  // Window start sits just after a multiple of the 300 s default window, so a
  // start-anchored and an epoch-aligned counter agree on when it ends.
  const WINDOW_MS = 300_000;
  const BASE = Math.floor(1_700_000_000_000 / WINDOW_MS) * WINDOW_MS + 1000;
  const scope: LinkScope = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    outletId: "22222222-2222-4222-8222-222222222222",
    edgeNodeId: "33333333-3333-4333-8333-333333333333",
  };

  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = undefined;
  });

  /** Link server behind a trusted proxy so the test picks the client address. */
  async function start(
    accepted: ReadonlySet<string>,
    authFailureLimit?: {
      limit?: number;
      windowMs?: number;
      knownCredentialTtlMs?: number;
    },
    // legend-12ku: holds every authenticate call open until released.
    gate?: Promise<void>,
  ) {
    const clock = { at: BASE };
    const calls = { authenticate: 0 };
    const proxied = express();
    proxied.set("trust proxy", 1);
    const live = createServer();
    server = live;
    const linkServer = createEdgeLinkServer(live, {
      version: "cloud",
      now: () => clock.at,
      // The older per-address upgrade budget stays out of the way.
      upgradeRateLimit: {
        windowMs: 60_000,
        perAddress: 100_000,
        perNode: 100_000,
      },
      authFailureLimit,
      clientAddress: expressClientAddress(proxied),
      authenticate: async (presented) => {
        calls.authenticate += 1;
        if (gate) await gate;
        return accepted.has(presented) ? { scope } : null;
      },
      isActive: async () => true,
      storeFor: () => emptyStore(),
    });
    await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", resolve));
    const url = `ws://127.0.0.1:${(live.address() as AddressInfo).port}/api/edge-link`;
    return { clock, calls, linkServer, url };
  }

  /** One upgrade attempt from a given client address; resolves the status. */
  const attempt = (url: string, token: string, address: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${token}`,
          "x-forwarded-for": address,
        },
      });
      ws.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        ws.terminate();
      });
      ws.on("open", () => {
        resolve(101);
        ws.terminate();
      });
      ws.on("error", () => undefined);
    });

  const forged = (edgeNodeId = randomUUID()) =>
    mintEdgeCredential({ ...scope, edgeNodeId }).token;

  it("refuses with 429 once an address passed 10 failures, before authenticate runs, even with a valid credential", async () => {
    const good = mintEdgeCredential(scope).token;
    const { calls, linkServer, url } = await start(new Set([good]));
    for (let i = 0; i < 10; i += 1)
      expect(
        await attempt(
          url,
          i % 2 ? forged() : "not-a-credential",
          "203.0.113.5",
        ),
      ).toBe(401);
    expect(calls.authenticate).toBe(10);
    expect(await attempt(url, forged(), "203.0.113.5")).toBe(429);
    expect(await attempt(url, good, "203.0.113.5")).toBe(429);
    expect(calls.authenticate).toBe(10);
    await linkServer.close();
  });

  it("lets the address back in when the window ends (fake clock)", async () => {
    const good = mintEdgeCredential(scope).token;
    const { clock, calls, linkServer, url } = await start(new Set([good]));
    for (let i = 0; i < 10; i += 1) await attempt(url, forged(), "203.0.113.6");
    expect(await attempt(url, good, "203.0.113.6")).toBe(429);
    clock.at = BASE + 100_000; // still inside the window
    expect(await attempt(url, good, "203.0.113.6")).toBe(429);
    const seen = calls.authenticate;
    clock.at = BASE + WINDOW_MS + 2000; // window over
    expect(await attempt(url, good, "203.0.113.6")).toBe(101);
    expect(calls.authenticate).toBe(seen + 1);
    // The budget starts over: a failure is a plain 401 again.
    expect(await attempt(url, forged(), "203.0.113.6")).toBe(401);
    await linkServer.close();
  });

  it("a successful login from another address does not clear a blocked address, and failures stay per address", async () => {
    const good = mintEdgeCredential(scope).token;
    // Never used successfully, so it gets no known-credential bypass.
    const unseen = mintEdgeCredential(scope).token;
    const { calls, linkServer, url } = await start(new Set([good, unseen]));
    for (let i = 0; i < 10; i += 1) await attempt(url, forged(), "203.0.113.7");
    expect(await attempt(url, good, "203.0.113.8")).toBe(101);
    expect(await attempt(url, forged(), "203.0.113.8")).toBe(401);
    const seen = calls.authenticate;
    expect(await attempt(url, unseen, "203.0.113.7")).toBe(429);
    expect(calls.authenticate).toBe(seen);
    await linkServer.close();
  });

  it("shared address (outlet Wi-Fi / NAT): junk from a neighbour does not lock out an edge whose credential already authenticated", async () => {
    const real = mintEdgeCredential(scope).token;
    const unseen = mintEdgeCredential(scope).token;
    const { calls, linkServer, url } = await start(new Set([real, unseen]));
    const shared = "203.0.113.20";
    expect(await attempt(url, real, shared)).toBe(101);
    for (let i = 0; i < 10; i += 1)
      expect(await attempt(url, forged(), shared)).toBe(401);
    // Locked for everything else from that address...
    expect(await attempt(url, forged(), shared)).toBe(429);
    expect(await attempt(url, unseen, shared)).toBe(429);
    // ...but the known credential still reaches authenticate and connects.
    const seen = calls.authenticate;
    expect(await attempt(url, real, shared)).toBe(101);
    expect(calls.authenticate).toBe(seen + 1);
    await linkServer.close();
  });

  it("the known-credential bypass expires after its TTL and is dropped when the credential is refused", async () => {
    const real = mintEdgeCredential(scope).token;
    const accepted = new Set([real]);
    const { clock, linkServer, url } = await start(accepted, {
      knownCredentialTtlMs: 60_000,
    });
    const shared = "203.0.113.21";
    expect(await attempt(url, real, shared)).toBe(101);
    // TTL over: the same credential is subject to the lockout again.
    clock.at = BASE + 61_000;
    for (let i = 0; i < 10; i += 1) await attempt(url, forged(), shared);
    expect(await attempt(url, real, shared)).toBe(429);

    // A credential that stops authenticating loses the bypass at once.
    const other = "203.0.113.22";
    clock.at = BASE + 400_000;
    expect(await attempt(url, real, other)).toBe(101);
    accepted.delete(real);
    for (let i = 0; i < 9; i += 1) await attempt(url, forged(), other);
    expect(await attempt(url, real, other)).toBe(401);
    expect(await attempt(url, real, other)).toBe(429);
    await linkServer.close();
  });

  it("counts failures per address only: other addresses are not locked, even when aimed at the same node", async () => {
    const victim = randomUUID();
    const real = forged(victim);
    const { calls, linkServer, url } = await start(new Set([real]));
    for (let i = 0; i < 10; i += 1)
      expect(await attempt(url, forged(victim), `198.51.100.${i + 1}`)).toBe(
        401,
      );
    // Ten failures spread over ten addresses lock none of them, nor the node.
    expect(await attempt(url, forged(victim), "198.51.100.50")).toBe(401);
    expect(await attempt(url, real, "198.51.100.51")).toBe(101);
    expect(calls.authenticate).toBe(12);
    await linkServer.close();
  });

  it("takes the limit and window from authFailureLimit", async () => {
    const good = mintEdgeCredential(scope).token;
    const { clock, linkServer, url } = await start(new Set([good]), {
      limit: 2,
      windowMs: 60_000,
    });
    expect(await attempt(url, forged(), "192.0.2.1")).toBe(401);
    expect(await attempt(url, forged(), "192.0.2.1")).toBe(401);
    expect(await attempt(url, good, "192.0.2.1")).toBe(429);
    clock.at = BASE + 61_000;
    expect(await attempt(url, good, "192.0.2.1")).toBe(101);
    await linkServer.close();
  });

  // legend-12ku: the slot is reserved before the authenticate await, so a
  // parallel burst cannot all get past a peek that no failure has moved yet.
  it("legend-12ku: 20 parallel bad credentials reach authenticate at most `limit` times, the rest get 429", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { calls, linkServer, url } = await start(
      new Set(),
      { limit: 10 },
      gate,
    );
    const burst = Array.from({ length: 20 }, () =>
      attempt(url, forged(), "203.0.113.30"),
    );
    // The 429s answer without waiting on the gate; the held ones stay pending.
    const early = await Promise.race([
      Promise.all(burst.map((p, i) => p.then((status) => ({ i, status })))),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
    ]);
    expect(early).toBeNull();
    expect(calls.authenticate).toBeLessThanOrEqual(10);
    open();
    const statuses = await Promise.all(burst);
    expect(statuses.filter((status) => status === 401)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(10);
    expect(calls.authenticate).toBe(10);
    await linkServer.close();
  });

  // legend-12ku B2: a refused reserve must not keep its count, or a reconnect
  // burst behind one venue NAT (after a cloud restart) locks the address out.
  it("legend-12ku: a burst of 25 good credentials over the limit does not lock the address afterwards", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const goods = Array.from(
      { length: 26 },
      () => mintEdgeCredential(scope).token,
    );
    const fresh = goods.pop()!;
    const { calls, linkServer, url } = await start(
      new Set([...goods, fresh]),
      { limit: 10 },
      gate,
    );
    let refused = 0;
    const burst = goods.map((token) =>
      attempt(url, token, "203.0.113.32").then((status) => {
        if (status === 429) refused += 1;
        return status;
      }),
    );
    // Poll instead of sleeping: open the gate only once all 10 in-flight
    // attempts hold a slot and the other 15 were refused, so a slow machine
    // cannot let a late upgrade reserve after a release.
    const deadline = Date.now() + 10_000;
    while (calls.authenticate < 10 || refused < 15) {
      if (Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls.authenticate).toBe(10);
    expect(refused).toBe(15);
    open();
    const statuses = await Promise.all(burst);
    expect(statuses.filter((status) => status === 429)).toHaveLength(15);
    // 15 refused ones must not leave their counts behind. Only real failures count, so the address is not locked out afterwards.
    expect(await attempt(url, fresh, "203.0.113.32")).toBe(101);
    await linkServer.close();
  });

  it("legend-12ku: a credential that authenticates releases its slot, so good logins never use up the budget", async () => {
    const good = mintEdgeCredential(scope).token;
    const { calls, linkServer, url } = await start(new Set([good]), {
      limit: 2,
    });
    for (let i = 0; i < 6; i += 1)
      expect(await attempt(url, good, "203.0.113.31")).toBe(101);
    // Still the full budget of 2 failures left for this address.
    expect(await attempt(url, forged(), "203.0.113.31")).toBe(401);
    expect(await attempt(url, forged(), "203.0.113.31")).toBe(401);
    expect(await attempt(url, forged(), "203.0.113.31")).toBe(429);
    expect(calls.authenticate).toBe(8);
    await linkServer.close();
  });
});

describe("legend-12ku fixed-window counter reserve/release", () => {
  const counter = () =>
    createFixedWindowCounter({ limit: 2, windowMs: 1000, capacity: 10 });

  it("counts like take and release gives the slot back once", () => {
    const c = counter();
    const a = c.reserve("k", 0);
    const b = c.reserve("k", 0);
    expect([a.retryAfter, b.retryAfter]).toEqual([null, null]);
    const over = c.reserve("k", 0);
    expect(over.retryAfter).toBe(1);
    over.release(); // a refused reserve hands its count back (legend-12ku B2)
    a.release();
    a.release(); // second release is a no-op
    // 3 reserved - 2 released = 1 counted: one slot free, then over again.
    expect(c.reserve("k", 0).retryAfter).toBeNull();
    expect(c.reserve("k", 0).retryAfter).toBe(1);
  });

  it("release does nothing once its window was replaced", () => {
    const c = counter();
    const old = c.reserve("k", 0);
    c.reserve("k", 1500); // new window, count 1
    old.release();
    expect(c.reserve("k", 1500).retryAfter).toBeNull(); // count 2
    expect(c.reserve("k", 1500).retryAfter).toBe(1); // count 3, over
  });
});

// ---------------------------------------------------------------------------
describe("legend-x3lv #3 acked-queue prune", () => {
  let clock = Date.now();
  function queueEvent(
    node: TestNode,
    sequence = 1,
    aggregateId: string = randomUUID(),
  ): EventEnvelope {
    clock += 1;
    return {
      id: createUlid(clock),
      tenantId: node.fixture.tenantId as EventEnvelope["tenantId"],
      outletId: node.fixture.outletId as EventEnvelope["outletId"],
      name: "order.item_added",
      version: 1,
      aggregateType: "order",
      aggregateId,
      sequence,
      occurredAt: new Date(clock).toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `prune-${clock}`,
      payloadSchemaRef: "order.item_added.v1",
      payload: {},
    };
  }

  /**
   * Queues one row per entry, all of ONE aggregate in sequence order (1, 2,
   * ...), so every row but the last has a newer row of its aggregate: the
   * prune never deletes an aggregate's newest row. Acked ones get `acked_at`
   * aged by `ageDays`.
   */
  async function seedQueue(
    node: TestNode,
    rows: ({ ageDays: number } | "pending")[],
    aggregateId: string = randomUUID(),
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const [index, row] of rows.entries()) {
      const event = queueEvent(node, index + 1, aggregateId);
      await withTenant(db, node.context, (tx) =>
        enqueueEdgeEvent(tx, node.context, {
          edgeNodeId: node.id,
          direction: "edge_to_cloud",
          kind: "transaction_event",
          event,
        }),
      );
      if (row !== "pending")
        await owner.query(
          `UPDATE edge_outbound_queue SET status = 'acked', acked_at = $3
            WHERE edge_node_id = $1 AND event->>'id' = $2`,
          [node.id, event.id, new Date(Date.now() - row.ageDays * DAY)],
        );
      ids.push(event.id);
    }
    return ids;
  }

  async function remaining(node: TestNode): Promise<string[]> {
    const result = await owner.query(
      `SELECT event->>'id' AS id FROM edge_outbound_queue WHERE edge_node_id = $1`,
      [node.id],
    );
    return result.rows.map((row) => row.id as string).sort();
  }

  it("deletes only acked rows older than the retention, across tenants, and leaves pending rows alone", async () => {
    const one = await makeNode();
    const two = await makeNode();
    const [oneOld, oneFresh, onePending] = await seedQueue(one, [
      { ageDays: 10 },
      { ageDays: 2 },
      "pending",
    ]);
    const [twoOld, twoPending] = await seedQueue(two, [
      { ageDays: 30 },
      "pending",
    ]);

    expect(await remaining(one)).toContain(oneOld);
    expect(await remaining(two)).toContain(twoOld);

    const result = await pruneAckedEdgeQueue({
      now: new Date(),
      retentionDays: 7,
    });
    expect(result.deleted).toBeGreaterThanOrEqual(2);

    expect(await remaining(one)).toEqual([oneFresh, onePending].sort());
    expect(await remaining(two)).toEqual([twoPending]);

    // Running again is a no-op.
    await pruneAckedEdgeQueue({ now: new Date(), retentionDays: 7 });
    expect(await remaining(one)).toEqual([oneFresh, onePending].sort());
    expect(await remaining(two)).toEqual([twoPending]);
  });

  it("keeps deleting in batches until nothing old is left", async () => {
    const node = await makeNode();
    const ids = await seedQueue(node, [
      { ageDays: 9 },
      { ageDays: 9 },
      { ageDays: 9 },
      { ageDays: 9 },
      { ageDays: 9 },
      { ageDays: 1 },
      "pending",
    ]);
    await pruneAckedEdgeQueue({ batchSize: 2, retentionDays: 7 });
    expect(await remaining(node)).toEqual([ids[5]!, ids[6]!].sort());
  });

  it("honours the retention option relative to the given clock", async () => {
    const node = await makeNode();
    const [ten, five, newest] = await seedQueue(node, [
      { ageDays: 10 },
      { ageDays: 5 },
      { ageDays: 1 },
    ]);
    expect(await remaining(node)).toContain(ten);
    await pruneAckedEdgeQueue({ now: new Date(), retentionDays: 7 });
    expect(await remaining(node)).toEqual([five!, newest!].sort());
    // A later clock ages the 5-day row past the same retention.
    await pruneAckedEdgeQueue({
      now: new Date(Date.now() + 3 * DAY),
      retentionDays: 7,
    });
    expect(await remaining(node)).toEqual([newest!]);
  });

  it("defaults to a 7 day retention", async () => {
    const node = await makeNode();
    const [eight, six] = await seedQueue(node, [
      { ageDays: 8 },
      { ageDays: 6 },
    ]);
    expect(await remaining(node)).toContain(eight);
    await pruneAckedEdgeQueue({ now: new Date() });
    expect(await remaining(node)).toEqual([six!]);
  });

  it("never prunes the newest row of an aggregate, however old, so its next event still queues", async () => {
    const node = await makeNode();
    const aggregateId = randomUUID();
    const [older, newest] = await seedQueue(
      node,
      [{ ageDays: 30 }, { ageDays: 20 }],
      aggregateId,
    );
    const [lone] = await seedQueue(node, [{ ageDays: 40 }]);
    await pruneAckedEdgeQueue({ now: new Date(), retentionDays: 7 });
    const left = await remaining(node);
    expect(left).not.toContain(older);
    expect(left).toEqual([newest!, lone!].sort());
    // The kept row still anchors the aggregate order: sequence 3 is accepted,
    // not a false sequence gap.
    const next = queueEvent(node, 3, aggregateId);
    const queued = await withTenant(db, node.context, (tx) =>
      enqueueEdgeEvent(tx, node.context, {
        edgeNodeId: node.id,
        direction: "edge_to_cloud",
        kind: "transaction_event",
        event: next,
      }),
    );
    expect(queued.duplicate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("legend-x3lv #4 multi-instance revoke broadcast", () => {
  type Instance = {
    server: Server;
    url: string;
    upgrades: { count: number };
    close(): Promise<void>;
  };
  const instances: Instance[] = [];
  const clients: { stop(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.stop();
    for (const instance of instances.splice(0)) await instance.close();
  });

  /** One API instance: its own HTTP server and link registration. */
  async function startInstance(): Promise<Instance> {
    const server = createServer();
    const upgrades = { count: 0 };
    server.on("upgrade", () => {
      upgrades.count += 1;
    });
    const handle = await registerEdgeLink(server, {
      clientAddress: expressClientAddress(express()),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/edge-link`;
    const instance: Instance = {
      server,
      url,
      upgrades,
      close: async () => {
        await handle.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
    instances.push(instance);
    return instance;
  }

  async function connect(instance: Instance, node: TestNode) {
    const client = createEdgeLinkClient({
      url: instance.url,
      credential: node.credential,
      scope: node.scope,
      store: emptyStore(),
      version: "edge",
      random: () => 0,
    });
    clients.push(client);
    await settle(() => client.state().cloudLink === "connected");
    return client;
  }

  it("the revoke channel is edge_node_revoked", () => {
    expect(EDGE_NODE_REVOKED_CHANNEL).toBe("edge_node_revoked");
  });

  it("a raw NOTIFY on the revoke channel disconnects only that node's socket", async () => {
    const [a, b] = [await startInstance(), await startInstance()];
    const target = await makeNode();
    const bystander = await makeNode();
    const held = await connect(a, target);
    const other = await connect(b, bystander);
    expect(a.upgrades.count).toBe(1);

    // The node stays active in the database: only the broadcast can drop it.
    // Repeat the signal until the link drops, in case the listener is still
    // attaching; stop as soon as the node has reconnected.
    // The close code is not specified, so a drop is either a reconnect or a
    // link that is no longer connected.
    await settle(() => {
      if (a.upgrades.count >= 2 || held.state().cloudLink !== "connected")
        return true;
      void owner.query("SELECT pg_notify($1, $2)", [
        EDGE_NODE_REVOKED_CHANNEL,
        target.id,
      ]);
      return false;
    });
    expect(other.state().cloudLink).toBe("connected");
    expect(b.upgrades.count).toBe(1);
  });

  it("revoking a node on one instance closes its socket on another, and the revoked credential is refused afterwards", async () => {
    const [a, b] = [await startInstance(), await startInstance()];
    const revoked = await makeNode();
    const bystander = await makeNode("standby");
    const held = await connect(b, revoked); // socket lives on instance B
    const other = await connect(a, bystander);

    // Revocation runs from "instance A's" request path (same process in test).
    await revokeEdgeNode(revoked.context, actor, {
      edgeNodeId: revoked.id,
      reason: "Unit hilang",
    });

    await settle(() => held.state().refused);
    expect(held.state().cloudLink).toBe("disconnected");
    expect(other.state().cloudLink).toBe("connected");
    expect(other.state().refused).toBe(false);
    expect(await authenticateEdgeCredential(revoked.credential)).toBeNull();
  });
});
