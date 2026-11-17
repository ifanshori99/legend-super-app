// Review finding F-C (legend-bod, docs/briefs/bod-emergency-impl.md): who serves
// the emergency button of an outlet.
//  (3) Outside edge mode the press, the receiver session, the acknowledge, the
//      fallback and the socket answer 409 EDGE_NODE_ACTIVE (socket: 403) for an
//      outlet that has an active edge node; a cloud-only outlet keeps working.
//      `queuePanicAlertEvent` queues nothing unless the server is an edge node.
//  (4) The POS fallback reads only alerts of the last 24 hours.
//  (6) The fallback is for `pos` devices only.
//
// ASSUMPTIONS: the refusal is 409 with code EDGE_NODE_ACTIVE (HTTP) and 403
// (socket upgrade); the fallback of a non-pos device is 403 NOT_A_POS_DEVICE.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { guardEdgeUpgrades } from "../edge/mode.ts";
import { attachEmergencyRealtime } from "../edge/panic-relay-realtime.ts";
import {
  getEdgeRuntimeState,
  setDeviceRegistryReadyForTests,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { queuePanicAlertEvent } from "../services/panic-alert-outbox.ts";
import { authenticateReceiverSession } from "../services/panic-receiver-session.ts";
import { originHeader, WEB_ORIGIN } from "./helpers.ts";
import {
  PANIC_COOKIE_NAME,
  PANIC_FALLBACK_ROUTE,
  PANIC_ROUTES,
  PANIC_WS_PROTOCOL,
  pressBody,
  sessionBody,
} from "./panic-test-helpers.ts";

const tenant = cafeLegendPlatformFixtures.tenant;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});
const edgeApp = createApp({ edgeMode: true });
const cloudApp = createApp({ edgeMode: false });
const cloudState = getEdgeRuntimeState();
const tenantContext = establishTenantContext({
  tenantId: tenant.id,
  brandId: null,
  source: "session",
});
const outletScope = (id: string) =>
  establishScopedTenantContext(tenantContext, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(id)],
  });

const deviceIds: string[] = [];
const servers: Server[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

async function asTenantOwner<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function actAsEdge(outletId: string) {
  setDeviceRegistryReadyForTests({});
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context: outletScope(outletId),
      scope: {
        tenantId: tenant.id,
        outletId: outletIdSchema.parse(outletId),
        edgeNodeId: randomUUID(),
      },
    },
    link: { cloudLink: "disconnected", refused: false, lastConnectedAt: null },
  });
}

async function seedOutlet(label: string, withEdgeNode: boolean) {
  const id = randomUUID();
  await asTenantOwner(async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'Jl. Darurat', 'Asia/Jakarta', '{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null}', 'active')`,
      [
        id,
        tenant.id,
        cafeLegendPlatformFixtures.brand.id,
        cafeLegendPlatformFixtures.legalEntity.id,
        `FC-${id.slice(0, 8)}`.toUpperCase(),
        label,
      ],
    );
    if (withEdgeNode)
      await client.query(
        `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash)
         VALUES ($1, $2, $3, 'primary', 'active', $4, $5)`,
        [randomUUID(), tenant.id, id, label, "a".repeat(64)],
      );
  });
  return id;
}

async function registerDevice(
  outlet: string,
  type: "panic_button" | "pos" | "waiter_phone",
) {
  const deviceId = randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, $4, 'Perangkat FC', $5)`,
      [deviceId, tenant.id, outlet, type, new Date(issuedAt * 1000)],
    ),
  );
  deviceIds.push(deviceId);
  const token = signDeviceToken({
    version: 1,
    issuedAt,
    tenantId: tenant.id,
    brandId: null,
    deviceId,
  });
  return { deviceId, token };
}

async function insertAlert(
  outlet: string,
  deviceId: string,
  receivedAtSql: string,
) {
  const id = randomUUID();
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO panic_alerts (id, tenant_id, outlet_id, device_id, first_device_event_id,
                                 unit_code_snapshot, facility_name_snapshot, device_label_snapshot, received_at)
       VALUES ($1, $2, $3, $4, $5, 'P1', 'Fasilitas FC', 'Tombol FC', ${receivedAtSql})`,
      [id, tenant.id, outlet, deviceId, `evt-${id}`],
    ),
  );
  return id;
}

/** A live receiver session row with a known cookie; the user needs no account. */
async function insertSession(outlet: string, deviceId: string) {
  const secret = randomBytes(32).toString("base64url");
  await asTenantOwner((client) =>
    client.query(
      `INSERT INTO panic_receiver_sessions (tenant_id, outlet_id, device_id, user_id, token_hash,
                                            pin_generation_at, issued_at, expires_at)
       VALUES ($1, $2, $3, 'user-review-c', $4, now(), now(), now() + interval '1 hour')`,
      [
        tenant.id,
        outlet,
        deviceId,
        createHash("sha256").update(secret).digest(),
      ],
    ),
  );
  return `${PANIC_COOKIE_NAME}=${tenant.id}.${secret}`;
}

const codeOf = (res: { body: { error?: { code?: string }; code?: string } }) =>
  res.body.error?.code ?? res.body.code;

const alertCount = async (outlet: string) =>
  Number(
    (
      await asTenantOwner((c) =>
        c.query<{ n: string }>(
          "SELECT count(*) AS n FROM panic_alerts WHERE tenant_id = $1 AND outlet_id = $2",
          [tenant.id, outlet],
        ),
      )
    ).rows[0].n,
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setDeviceOutletResolver(createDeviceOutletResolver());
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  setEdgeRuntimeStateForTests(cloudState);
  setDeviceRegistryReadyForTests(null);
});

afterAll(async () => {
  try {
    await owner.query(
      "DELETE FROM devices WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, deviceIds],
    );
  } catch {
    // Best effort: every row uses random ids that no other file touches.
  }
  await owner.end();
});

describe("F-C (3) the cloud does not serve an outlet that has an active edge node", () => {
  it("a press on the cloud for an outlet with an edge node is 409 EDGE_NODE_ACTIVE and creates no alert", async () => {
    const outlet = await seedOutlet("FC press edge", true);
    const button = await registerDevice(outlet, "panic_button");
    const res = await request(cloudApp)
      .post(PANIC_ROUTES.press)
      .set(DEVICE_TOKEN_HEADER, button.token)
      .send(pressBody(`evt-${randomUUID()}`));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res)).toBe("EDGE_NODE_ACTIVE");
    expect(await alertCount(outlet)).toBe(0);
  });

  it("a press on the cloud for a cloud-only outlet still works", async () => {
    const outlet = await seedOutlet("FC press cloud only", false);
    const button = await registerDevice(outlet, "panic_button");
    const res = await request(cloudApp)
      .post(PANIC_ROUTES.press)
      .set(DEVICE_TOKEN_HEADER, button.token)
      .send(pressBody(`evt-${randomUUID()}`));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await alertCount(outlet)).toBe(1);
  });

  it("a press on the edge for an outlet with an edge node still works", async () => {
    const outlet = await seedOutlet("FC press on edge", true);
    const button = await registerDevice(outlet, "panic_button");
    actAsEdge(outlet);
    const res = await request(edgeApp)
      .post(PANIC_ROUTES.press)
      .set(DEVICE_TOKEN_HEADER, button.token)
      .send(pressBody(`evt-${randomUUID()}`));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("opening a receiver session on the cloud is 409 before any PIN check", async () => {
    const outlet = await seedOutlet("FC session edge", true);
    const pos = await registerDevice(outlet, "pos");
    const res = await request(cloudApp)
      .post(PANIC_ROUTES.sessions)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, pos.token)
      .send(sessionBody(randomUUID(), "582914"));
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res)).toBe("EDGE_NODE_ACTIVE");
  });

  it("the fallback on the cloud is 409 for an outlet with an edge node", async () => {
    const outlet = await seedOutlet("FC fallback edge", true);
    const pos = await registerDevice(outlet, "pos");
    const res = await request(cloudApp)
      .get(PANIC_FALLBACK_ROUTE)
      .set(DEVICE_TOKEN_HEADER, pos.token);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(codeOf(res)).toBe("EDGE_NODE_ACTIVE");
  });

  it("an acknowledge on the cloud is 409 for an outlet with an edge node, not for a cloud-only outlet", async () => {
    const withEdge = await seedOutlet("FC ack edge", true);
    const cloudOnly = await seedOutlet("FC ack cloud only", false);
    const edgePos = await registerDevice(withEdge, "pos");
    const cloudPos = await registerDevice(cloudOnly, "pos");
    const edgeCookie = await insertSession(withEdge, edgePos.deviceId);
    const cloudCookie = await insertSession(cloudOnly, cloudPos.deviceId);
    const ack = (cookie: string) =>
      request(cloudApp)
        .post(PANIC_ROUTES.ack(randomUUID()))
        .set(originHeader)
        .set("Cookie", cookie)
        .send({});
    const refused = await ack(edgeCookie);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(codeOf(refused)).toBe("EDGE_NODE_ACTIVE");
    // The cloud-only session is not refused for ownership (it fails later: no staff).
    expect(codeOf(await ack(cloudCookie))).not.toBe("EDGE_NODE_ACTIVE");
  });

  it("authenticateReceiverSession refuses a session of an outlet with an edge node on the cloud", async () => {
    const outlet = await seedOutlet("FC auth edge", true);
    const pos = await registerDevice(outlet, "pos");
    const cookie = await insertSession(outlet, pos.deviceId);
    await expect(authenticateReceiverSession(cookie)).rejects.toMatchObject({
      code: "EDGE_NODE_ACTIVE",
    });
  });

  it("the emergency socket on the cloud is refused with 403 for an outlet with an edge node", async () => {
    const outlet = await seedOutlet("FC socket edge", true);
    const pos = await registerDevice(outlet, "pos");
    const cookie = await insertSession(outlet, pos.deviceId);
    const server = createServer((_req, res) => res.end());
    guardEdgeUpgrades(server, { edgeMode: false });
    const realtime = attachEmergencyRealtime(server, {
      trustedOrigins: [WEB_ORIGIN],
    });
    cleanups.push(() => realtime.close());
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}${PANIC_ROUTES.ws}`,
        PANIC_WS_PROTOCOL,
        { headers: { Origin: WEB_ORIGIN, Cookie: cookie } },
      );
      ws.on("open", () => {
        ws.close();
        resolve(101);
      });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", (error) => {
        if (!/Unexpected server response/.test(String(error))) reject(error);
      });
    });
    expect(status).toBe(403);
  });

  it("queuePanicAlertEvent queues nothing when the server is not an edge node", async () => {
    const outlet = await seedOutlet("FC queue cloud", true);
    const button = await registerDevice(outlet, "panic_button");
    const alertId = await insertAlert(outlet, button.deviceId, "now()");
    const context = outletScope(outlet);
    const sequence = await withTenant(db, context, (tx) =>
      queuePanicAlertEvent(tx, context, {
        outletId: outlet,
        alertId,
        // The payload is never read: the cloud returns before validating it.
        event: { key: "delivered", payload: { alertId } } as never,
      }),
    );
    expect(sequence).toBeNull();
  });
});

describe("F-C (4) and (6) the POS fallback", () => {
  it("shows only alerts of the last 24 hours", async () => {
    const outlet = await seedOutlet("FC fallback window", false);
    const pos = await registerDevice(outlet, "pos");
    const button = await registerDevice(outlet, "panic_button");
    const recent = await insertAlert(
      outlet,
      button.deviceId,
      "now() - interval '30 seconds'",
    );
    const old = await insertAlert(
      outlet,
      button.deviceId,
      "now() - interval '25 hours'",
    );
    actAsEdge(outlet);
    const res = await request(edgeApp)
      .get(PANIC_FALLBACK_ROUTE)
      .set(DEVICE_TOKEN_HEADER, pos.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = (res.body.data.alerts as Array<{ alertId: string }>).map(
      (item) => item.alertId,
    );
    expect(ids).toContain(recent);
    expect(ids).not.toContain(old);
  });

  it("is 403 NOT_A_POS_DEVICE for a waiter phone", async () => {
    const outlet = await seedOutlet("FC fallback phone", false);
    const phone = await registerDevice(outlet, "waiter_phone");
    actAsEdge(outlet);
    const res = await request(edgeApp)
      .get(PANIC_FALLBACK_ROUTE)
      .set(DEVICE_TOKEN_HEADER, phone.token);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(codeOf(res)).toBe("NOT_A_POS_DEVICE");
  });
});
