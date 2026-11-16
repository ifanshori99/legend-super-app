// Device registry on the cloud (bead legend-165; PRD v1.7 §3 F5 "Registri
// Perangkat" + "Mode Latihan", EDG-03, §6 `devices` (T, E)). Written from the
// brief's contracts, not from the implementation.
//
// Assumed service contract (apps/api/src/services/device.service.ts), same
// shape as edge-node.service.ts `(context, actorUserId, input)`:
//   enrollDevice(ctx, actor, {outletId,type,label,stationId,idempotencyKey})
//     -> {device, token}
//   issueDeviceToken(ctx, actor, {deviceId}) -> {device, token}
//   revokeDevice(ctx, actor, {deviceId, reason}) -> device
// (idempotency keys are handled by the route, not the service)
//   setDeviceTrainingMode(ctx, actor, {deviceId, trainingMode}) -> device
//   listOfflineDevices(ctx, outletId, now) -> devices
// Heartbeats are driven over HTTP (POST /api/devices/heartbeat with the
// x-device-token header) so the credential path is exercised end to end.
// Fixtures run as the migration owner; raw policy checks as legend_app.
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { Pool, type PoolClient } from "pg";
import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendFixtures,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  DEVICE_OFFLINE_AFTER_SECONDS,
  DEVICE_HEARTBEAT_INTERVAL_SECONDS,
  deviceSchema,
  isDeviceOffline,
} from "@starter/shared/edge";
import {
  DEVICE_TOKEN_HEADER,
  cafeLegendPlatformFixtures,
} from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken, verifyDeviceToken } from "../lib/device-token.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  enrollDevice,
  issueDeviceToken,
  listOfflineDevices,
  listOutletDevices,
  revokeDevice,
  setDeviceTrainingMode,
} from "../services/device.service.ts";
import {
  isDeviceInTrainingAt,
  reportableActivity,
} from "../services/device-training.ts";
import { deviceTenantCredential } from "../services/platform-tenant.service.ts";

const app = createApp();
const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const actor = randomUUID();
const platform = cafeLegendPlatformFixtures;

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const tenantBase = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const outletScope = (outletId: string): ScopedTenantContext =>
  establishScopedTenantContext(tenantBase(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asAppRole<T>(
  settings: { tenant: string; outlets: string },
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', $2, true)",
      [settings.tenant, settings.outlets],
    );
    return await run(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/** Migration owner with the tenant settings, committed. */
async function asOwner(text: string, params: unknown[] = []) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await client.query(text, params);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const deviceRow = async (id: string) =>
  (await asOwner("SELECT * FROM devices WHERE id = $1", [id])).rows[0];

async function enroll(
  outletId: string = outletA,
  overrides: Record<string, unknown> = {},
) {
  return enrollDevice(outletScope(outletId), actor, {
    outletId,
    type: "pos",
    label: `Kasir ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
    ...overrides,
  });
}

/** What the tenant middleware hands the credential check. */
function credentialOf(token: string) {
  const req = {
    get: (name: string) =>
      name.toLowerCase() === DEVICE_TOKEN_HEADER ? token : undefined,
  } as unknown as Request;
  return deviceTenantCredential(req);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function heartbeat(token: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/devices/heartbeat")
    .set(DEVICE_TOKEN_HEADER, token)
    .send({
      version: "1.0.0",
      capabilities: ["print"],
      occurredAt: new Date().toISOString(),
      ...body,
    });
}

const lastSeen = async (id: string) => {
  const row = await deviceRow(id);
  return row.last_seen_at as Date | null;
};

let otherTenantId = "";
const slug = (prefix: string) =>
  `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  // A second, active tenant: a token naming it must never open our devices.
  otherTenantId = randomUUID();
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     VALUES ($1, $2, 'Tenant lain', 'lengkap', 'active', 'shared', '{"modules":[],"integrationProviders":[]}', $3, $4)`,
    [
      otherTenantId,
      slug("uji-dev"),
      JSON.stringify(platform.packages[0].defaultLimits),
      randomUUID(),
    ],
  );
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenantId]);
  await owner.end();
});

describe("F5 device registry: enrollment and token", () => {
  it("F5 enroll returns an active device and a signed token for it", async () => {
    const { device, token } = await enroll(outletA, {
      type: "kds",
      label: "KDS Bar",
    });
    expect(deviceSchema.safeParse(device).success).toBe(true);
    expect(device).toMatchObject({
      tenantId,
      outletId: outletA,
      type: "kds",
      label: "KDS Bar",
      status: "active",
      revokedAt: null,
      lastSeenAt: null,
      trainingMode: false,
      stationId: null,
    });
    const payload = verifyDeviceToken(token);
    expect(payload).toMatchObject({ tenantId, deviceId: device.id });
    expect(Number.isInteger(payload?.issuedAt)).toBe(true);
    expect(await credentialOf(token)).toMatchObject({
      tenantId,
      source: "device",
    });
  });

  it("F5 the token is returned once: it is not stored on the device row", async () => {
    const { device, token } = await enroll();
    const dump = await asOwner(
      "SELECT row_to_json(d)::text AS text FROM devices d WHERE d.id = $1",
      [device.id],
    );
    expect(dump.rows[0].text).not.toContain(token);
    expect(dump.rows[0].text).not.toContain(token.split(".")[2]);
  });

  it("F5 enrolling for an outlet outside the caller's scope is refused and creates nothing", async () => {
    const label = `Bukan outlet saya ${randomUUID()}`;
    await expect(
      enrollDevice(outletScope(outletB), actor, {
        outletId: outletA,
        type: "pos",
        label,
        stationId: null,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    const found = await asOwner("SELECT 1 FROM devices WHERE label = $1", [
      label,
    ]);
    expect(found.rowCount).toBe(0);
  });

  it("F5 a device type outside the list is refused by the database", async () => {
    await expect(
      asOwner(
        `INSERT INTO devices (tenant_id, outlet_id, type, label)
         VALUES ($1, $2, 'toaster', 'Bukan perangkat')`,
        [tenantId, outletA],
      ),
    ).rejects.toThrow();
  });
});

describe("F5 enrollment replay (security review)", () => {
  // Assumption: enrollDevice with the same idempotencyKey and same input is a
  // replay. A replay that mints must write a `device.enrolled` audit event
  // marked as a replay (the brief says "mark replay"; the test looks for the
  // word "replay" anywhere in the event, not a particular field).
  const enrollInput = (outletId: string = outletA) => ({
    outletId,
    type: "pos" as const,
    label: `Kasir ulang ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  const enrolledEvents = async (deviceId: string) =>
    (
      await owner.query<{ event: Record<string, unknown> }>(
        `SELECT event FROM audit_logs
         WHERE tenant_id = $1 AND event->>'objectId' = $2
           AND event->>'action' = 'device.enrolled'
         ORDER BY event->>'createdAt', id`,
        [tenantId, deviceId],
      )
    ).rows;

  it("F5 replaying an enrollment before any reissue returns the same device with a working token, and is audited", async () => {
    const input = enrollInput();
    const first = await enrollDevice(outletScope(outletA), actor, input);
    expect(await enrolledEvents(first.device.id)).toHaveLength(1);

    const replay = await enrollDevice(outletScope(outletA), actor, input);
    expect(replay.device.id).toBe(first.device.id);
    expect(verifyDeviceToken(replay.token)).toMatchObject({
      tenantId,
      deviceId: first.device.id,
    });
    expect(await credentialOf(replay.token)).toMatchObject({
      tenantId,
      source: "device",
    });
    expect(
      (await asOwner("SELECT 1 FROM devices WHERE id = $1", [first.device.id]))
        .rowCount,
    ).toBe(1);

    const events = await enrolledEvents(first.device.id);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events[1]!.event).toLowerCase()).toContain("replay");
  });

  it("EDG-03 replaying an enrollment after a reissue is a conflict and mints no token", async () => {
    const input = enrollInput();
    const first = await enrollDevice(outletScope(outletA), actor, input);
    const reissued = await issueDeviceToken(
      outletScope(outletA),
      actor,
      { deviceId: first.device.id },
      new Date(Date.now() + 60_000),
    );
    const floorBefore = (await deviceRow(first.device.id)).token_issued_at;

    const replay = enrollDevice(outletScope(outletA), actor, input);
    await expect(replay).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(replay).rejects.not.toHaveProperty("token");

    // Nothing changed: the floor is still the reissue's, the reissued token
    // works, the first one stays rotated out, and no enrollment was audited.
    expect((await deviceRow(first.device.id)).token_issued_at).toEqual(
      floorBefore,
    );
    expect(await credentialOf(reissued.token)).not.toBeNull();
    expect(await credentialOf(first.token)).toBeNull();
    expect(await enrolledEvents(first.device.id)).toHaveLength(1);
  });

  it("EDG-03 replaying an enrollment more than 24 hours after it was created is a conflict even without a reissue", async () => {
    const input = enrollInput();
    const first = await enrollDevice(outletScope(outletA), actor, input);
    await asOwner(
      `UPDATE devices SET created_at = created_at - interval '25 hours',
         token_issued_at = token_issued_at - interval '25 hours'
       WHERE id = $1`,
      [first.device.id],
    );
    await expect(
      enrollDevice(outletScope(outletA), actor, input),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await enrolledEvents(first.device.id)).toHaveLength(1);
  });

  it("EDG-03 replaying the enrollment of a revoked device is a conflict and mints no token", async () => {
    const input = enrollInput();
    const first = await enrollDevice(outletScope(outletA), actor, input);
    await revokeDevice(outletScope(outletA), actor, {
      deviceId: first.device.id,
      reason: "Dicabut",
    });
    await expect(
      enrollDevice(outletScope(outletA), actor, input),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("F5 reusing an enrollment key for a different device is still refused", async () => {
    const input = enrollInput();
    await enrollDevice(outletScope(outletA), actor, input);
    await expect(
      enrollDevice(outletScope(outletA), actor, { ...input, label: "Lain" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
});

describe("F5 heartbeat and offline detection", () => {
  it("F5 a heartbeat sets last_seen_at, version and capabilities", async () => {
    const { device, token } = await enroll();
    expect(await lastSeen(device.id)).toBeNull();
    const response = await heartbeat(token, {
      version: "2.4.1",
      capabilities: ["print", "scan"],
    });
    expect(response.status).toBe(200);
    expect(response.body.data.deviceId).toBe(device.id);
    expect(Number.isNaN(Date.parse(response.body.data.serverTime))).toBe(false);
    const row = await deviceRow(device.id);
    expect(row.last_seen_at).not.toBeNull();
    expect(row.version).toBe("2.4.1");
    expect(row.capabilities).toEqual(["print", "scan"]);
  });

  it("F5 the reported time never moves last_seen_at backwards or into the future", async () => {
    const { device, token } = await enroll();
    const hourMs = 60 * 60 * 1000;
    expect(
      (
        await heartbeat(token, {
          occurredAt: new Date(Date.now() - 10_000).toISOString(),
        })
      ).status,
    ).toBe(200);
    const first = await lastSeen(device.id);
    expect(first).not.toBeNull();

    // A stale (replayed) heartbeat does not rewind the clock.
    await heartbeat(token, {
      occurredAt: new Date(Date.now() - hourMs).toISOString(),
    });
    expect((await lastSeen(device.id))?.getTime()).toBe(first!.getTime());

    // Compare against this heartbeat's application clock, also returned to the
    // device; PostgreSQL's clock may differ from the Node process clock.
    const future = await heartbeat(token, {
      occurredAt: new Date(Date.now() + hourMs).toISOString(),
    });
    expect(future.status).toBe(200);
    const serverTime = new Date(future.body.data.serverTime);
    expect(Number.isNaN(serverTime.getTime())).toBe(false);
    const capped = await asOwner(
      "SELECT last_seen_at <= $3 AS capped, last_seen_at >= $2 AS forward FROM devices WHERE id = $1",
      [device.id, first, serverTime],
    );
    expect(capped.rows[0]).toEqual({ capped: true, forward: true });
  });

  it("F5 the device id comes from the token only: a body naming another device is refused", async () => {
    const mine = await enroll();
    const other = await enroll();
    const response = await heartbeat(mine.token, { deviceId: other.device.id });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await lastSeen(other.device.id)).toBeNull();
    expect(await lastSeen(mine.device.id)).toBeNull();
  });

  it("F5 a heartbeat without a device token is refused", async () => {
    const response = await request(app).post("/api/devices/heartbeat").send({
      version: "1.0.0",
      capabilities: [],
      occurredAt: new Date().toISOString(),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it("TEN-02 a brand-pinned domain with a brand-bearing token still gets a heartbeat through", async () => {
    const { device, token } = await enroll();
    // The enrolled token carries the outlet's brand, and the fixture host is
    // pinned to that brand, so the tenant resolver picks the domain context.
    expect(verifyDeviceToken(token)?.brandId).not.toBeNull();
    const response = await heartbeat(token).set(
      "Host",
      "pesan.cafelegend.example",
    );
    expect(response.status).toBe(200);
    expect(response.body.data.deviceId).toBe(device.id);
    expect(await lastSeen(device.id)).not.toBeNull();
  });

  it("TEN-02 a heartbeat on another tenant's domain is refused", async () => {
    const { device, token } = await enroll();
    const otherBrandId = randomUUID();
    const domainId = randomUUID();
    const hostname = `${slug("other")}.contoh.example`;
    await owner.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, 'Brand lain')`,
      [otherBrandId, otherTenantId, slug("brand")],
    );
    await owner.query(
      `INSERT INTO tenant_domains (id, tenant_id, brand_id, hostname, kind, tls_status, verified_at)
       VALUES ($1, $2, $3, $4, 'custom', 'active', now())`,
      [domainId, otherTenantId, otherBrandId, hostname],
    );
    try {
      const response = await heartbeat(token).set("Host", hostname);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(await lastSeen(device.id)).toBeNull();
    } finally {
      await owner.query("DELETE FROM tenant_domains WHERE id = $1", [domainId]);
      await owner.query("DELETE FROM brands WHERE id = $1", [otherBrandId]);
    }
  });

  it("F5 intervals: heartbeat every 30 s, offline after 120 s without one", () => {
    expect(DEVICE_HEARTBEAT_INTERVAL_SECONDS).toBe(30);
    expect(DEVICE_OFFLINE_AFTER_SECONDS).toBe(120);
    const now = new Date("2026-11-08T10:00:00.000Z");
    const at = (secondsAgo: number) =>
      new Date(now.getTime() - secondsAgo * 1000).toISOString();
    expect(
      isDeviceOffline({ status: "active", lastSeenAt: at(119) }, now),
    ).toBe(false);
    // Exactly 120 s is still online: offline means MORE than 120 s.
    expect(
      isDeviceOffline({ status: "active", lastSeenAt: at(120) }, now),
    ).toBe(false);
    expect(
      isDeviceOffline({ status: "active", lastSeenAt: at(121) }, now),
    ).toBe(true);
    // Never seen counts as offline; a revoked device is not "offline".
    expect(isDeviceOffline({ status: "active", lastSeenAt: null }, now)).toBe(
      true,
    );
    expect(isDeviceOffline({ status: "revoked", lastSeenAt: null }, now)).toBe(
      false,
    );
    expect(
      isDeviceOffline({ status: "revoked", lastSeenAt: at(9999) }, now),
    ).toBe(false);
  });

  it("F5 listOfflineDevices uses a pinned clock: stale and never-seen devices only, revoked excluded", async () => {
    // The outlet-A list is shared with other tests, so check our own ids.
    const fresh = await enroll();
    const stale = await enroll();
    const never = await enroll();
    const gone = await enroll();
    const seenAt = new Date();
    await asOwner("UPDATE devices SET last_seen_at = $2 WHERE id = $1", [
      fresh.device.id,
      new Date(seenAt.getTime() - 60_000),
    ]);
    await asOwner("UPDATE devices SET last_seen_at = $2 WHERE id = $1", [
      stale.device.id,
      new Date(seenAt.getTime() - 130_000),
    ]);
    await asOwner("UPDATE devices SET last_seen_at = $2 WHERE id = $1", [
      gone.device.id,
      new Date(seenAt.getTime() - 130_000),
    ]);
    await revokeDevice(outletScope(outletA), actor, {
      deviceId: gone.device.id,
      reason: "Dicuri",
    });
    const ids = (
      await listOfflineDevices(outletScope(outletA), outletA, seenAt)
    ).map((d) => d.id);
    expect(ids).toContain(stale.device.id);
    expect(ids).toContain(never.device.id);
    expect(ids).not.toContain(fresh.device.id);
    expect(ids).not.toContain(gone.device.id);

    // Move the clock 70 s forward: the 60 s old device crosses 120 s too.
    const later = new Date(seenAt.getTime() + 70_000);
    const laterIds = (
      await listOfflineDevices(outletScope(outletA), outletA, later)
    ).map((d) => d.id);
    expect(laterIds).toContain(fresh.device.id);
  });

  it("F5 another outlet's scope neither lists nor sees our devices", async () => {
    const mine = await enroll(outletA);
    const own = await listOfflineDevices(
      outletScope(outletB),
      outletB,
      new Date(),
    );
    expect(own.map((d) => d.id)).not.toContain(mine.device.id);
    await expect(
      listOfflineDevices(outletScope(outletB), outletA, new Date()),
    ).rejects.toThrow();
  });

  it("F5 the registry list filters by type and status and is scoped to the outlet", async () => {
    const kds = await enroll(outletA, { type: "kds" });
    const pos = await enroll(outletA, { type: "pos" });
    await revokeDevice(outletScope(outletA), actor, {
      deviceId: pos.device.id,
      reason: "Rusak",
    });
    const list = (query: Record<string, unknown>) =>
      listOutletDevices(outletScope(outletA), {
        outletId: outletA,
        limit: 100,
        ...query,
      });
    const kdsIds = (await list({ type: "kds" })).data.map((d) => d.id);
    expect(kdsIds).toContain(kds.device.id);
    expect(kdsIds).not.toContain(pos.device.id);
    const revokedIds = (await list({ status: "revoked" })).data.map(
      (d) => d.id,
    );
    expect(revokedIds).toContain(pos.device.id);
    expect(revokedIds).not.toContain(kds.device.id);
    const activeIds = (await list({ status: "active" })).data.map((d) => d.id);
    expect(activeIds).toContain(kds.device.id);
    expect(activeIds).not.toContain(pos.device.id);
    // Revoked devices stay listed (never deleted) and the page parses.
    expect((await list({})).data.map((d) => d.id)).toContain(pos.device.id);
    await expect(
      listOutletDevices(outletScope(outletB), {
        outletId: outletA,
        limit: 10,
      }),
    ).rejects.toThrow();
    expect(
      (
        await listOutletDevices(outletScope(outletB), {
          outletId: outletB,
          limit: 100,
        })
      ).data.map((d) => d.id),
    ).not.toContain(kds.device.id);
  });
});

describe("EDG-03 revocation and token rotation", () => {
  it("EDG-03 a revoked device cannot get a new token and its token stops working", async () => {
    const { device, token } = await enroll();
    expect(await credentialOf(token)).not.toBeNull();
    const revoked = await revokeDevice(outletScope(outletA), actor, {
      deviceId: device.id,
      reason: "Perangkat hilang",
    });
    expect(revoked).toMatchObject({ id: device.id, status: "revoked" });
    expect(revoked.revokedAt).not.toBeNull();
    const row = await deviceRow(device.id);
    expect(row.revoked_by).toBe(actor);
    expect(row.revoke_reason).toBe("Perangkat hilang");

    await expect(
      issueDeviceToken(outletScope(outletA), actor, {
        deviceId: device.id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await credentialOf(token)).toBeNull();

    const response = await heartbeat(token);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await lastSeen(device.id)).toBeNull();
  });

  it("EDG-03 revoking twice changes nothing: the first revocation record stays and the device stays revoked", async () => {
    // Assumption (revokeDevice is idempotent, returns the revoked device): the
    // PRD only says revocation is terminal, so a repeat call must neither fail
    // nor restamp who revoked it, when, or why.
    const { device } = await enroll();
    const first = await revokeDevice(outletScope(outletA), actor, {
      deviceId: device.id,
      reason: "Rusak",
    });
    const before = await deviceRow(device.id);
    const again = await revokeDevice(outletScope(outletA), randomUUID(), {
      deviceId: device.id,
      reason: "Alasan lain",
    });
    expect(again).toMatchObject({ id: device.id, status: "revoked" });
    expect(again.revokedAt).toBe(first.revokedAt);
    const after = await deviceRow(device.id);
    expect(after).toMatchObject({
      status: "revoked",
      revoked_by: actor,
      revoke_reason: "Rusak",
    });
    expect(after.revoked_at).toEqual(before.revoked_at);
  });

  it("EDG-03 a revoked device cannot be put into training mode", async () => {
    const { device } = await enroll();
    await revokeDevice(outletScope(outletA), actor, {
      deviceId: device.id,
      reason: "Rusak",
    });
    await expect(
      setDeviceTrainingMode(outletScope(outletA), actor, {
        deviceId: device.id,
        trainingMode: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("EDG-03 a user scoped to another outlet cannot revoke the device", async () => {
    const { device, token } = await enroll(outletA);
    await expect(
      revokeDevice(outletScope(outletB), actor, {
        deviceId: device.id,
        reason: "Bukan outlet saya",
      }),
    ).rejects.toThrow();
    expect((await deviceRow(device.id)).status).toBe("active");
    expect(await credentialOf(token)).not.toBeNull();
  });

  it("EDG-03 reissuing a token rotates the old one out; the new one works", async () => {
    const { device } = await enroll();
    // The old token is minted by the test one minute in the past and the
    // floor is placed before it, so the check never depends on the second
    // boundary the two tokens are minted in.
    const old = signDeviceToken({
      version: 1,
      tenantId,
      brandId: null,
      deviceId: device.id,
      issuedAt: nowSeconds() - 60,
    });
    await asOwner(
      "UPDATE devices SET token_issued_at = now() - interval '5 minutes' WHERE id = $1",
      [device.id],
    );
    expect(await credentialOf(old)).not.toBeNull();

    const reissued = await issueDeviceToken(outletScope(outletA), actor, {
      deviceId: device.id,
    });
    expect(reissued.device.id).toBe(device.id);
    expect(verifyDeviceToken(reissued.token)).toMatchObject({
      deviceId: device.id,
    });
    expect(await credentialOf(old)).toBeNull();
    expect(await credentialOf(reissued.token)).not.toBeNull();
    expect((await heartbeat(old)).status).toBeGreaterThanOrEqual(400);
    expect((await heartbeat(reissued.token)).status).toBe(200);
  });

  it("EDG-03 a token minted before the device's floor is refused even if the signature and expiry are fine", async () => {
    const { device } = await enroll();
    const forged = signDeviceToken({
      version: 1,
      tenantId,
      brandId: null,
      deviceId: device.id,
      issuedAt: nowSeconds() - 3600,
    });
    await asOwner(
      "UPDATE devices SET token_issued_at = now() - interval '10 minutes' WHERE id = $1",
      [device.id],
    );
    expect(await credentialOf(forged)).toBeNull();
  });

  it("TEN-02 a token naming another tenant is refused for our device", async () => {
    const { device } = await enroll();
    const foreign = signDeviceToken({
      version: 1,
      tenantId: otherTenantId,
      brandId: null,
      deviceId: device.id,
      issuedAt: nowSeconds(),
    });
    expect(await credentialOf(foreign)).toBeNull();
    expect((await heartbeat(foreign)).status).toBeGreaterThanOrEqual(400);
    expect(await lastSeen(device.id)).toBeNull();
  });

  it("EDG-03 a correctly signed token for an unknown device is refused", async () => {
    const unknown = signDeviceToken({
      version: 1,
      tenantId,
      brandId: null,
      deviceId: randomUUID(),
      issuedAt: nowSeconds(),
    });
    expect(await credentialOf(unknown)).toBeNull();
    const response = await heartbeat(unknown);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe("F5 Mode Latihan (training mode)", () => {
  const periodsOf = async (deviceId: string) =>
    (
      await asOwner(
        "SELECT started_at, ended_at, started_by, ended_by FROM device_training_periods WHERE device_id = $1 ORDER BY started_at",
        [deviceId],
      )
    ).rows;
  const reportable = (deviceId: string, at: Date) =>
    withTenant(db, outletScope(outletA), async (tx) => {
      const result = await tx.execute(
        sql`SELECT 1 AS ok WHERE ${reportableActivity(
          sql`${deviceId}::uuid`,
          sql`${at.toISOString()}::timestamptz`,
        )}`,
      );
      return result.rows.length === 1;
    });

  it("F5 turning training on opens one period and turning it off closes it", async () => {
    const { device } = await enroll();
    const on = await setDeviceTrainingMode(outletScope(outletA), actor, {
      deviceId: device.id,
      trainingMode: true,
    });
    expect(on.trainingMode).toBe(true);
    let periods = await periodsOf(device.id);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ ended_at: null, started_by: actor });
    expect((await deviceRow(device.id)).training_mode).toBe(true);

    const off = await setDeviceTrainingMode(outletScope(outletA), actor, {
      deviceId: device.id,
      trainingMode: false,
    });
    expect(off.trainingMode).toBe(false);
    periods = await periodsOf(device.id);
    expect(periods).toHaveLength(1);
    expect(periods[0].ended_at).not.toBeNull();
    expect(periods[0].ended_by).toBe(actor);
    expect((await deviceRow(device.id)).training_mode).toBe(false);
  });

  it("F5 activity inside a training period is excluded from reports; before, after and other devices count", async () => {
    const trained = await enroll();
    const normal = await enroll();
    await setDeviceTrainingMode(outletScope(outletA), actor, {
      deviceId: trained.device.id,
      trainingMode: true,
    });
    await setDeviceTrainingMode(outletScope(outletA), actor, {
      deviceId: trained.device.id,
      trainingMode: false,
    });
    // Pin the closed period to a known window: 2 h ago to 1 h ago.
    await asOwner(
      `UPDATE device_training_periods
         SET started_at = now() - interval '2 hours', ended_at = now() - interval '1 hour'
       WHERE device_id = $1`,
      [trained.device.id],
    );
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    expect(await reportable(trained.device.id, minutesAgo(90))).toBe(false);
    expect(await reportable(trained.device.id, minutesAgo(180))).toBe(true);
    expect(await reportable(trained.device.id, minutesAgo(30))).toBe(true);
    // The same moment on a device that never trained still counts.
    expect(await reportable(normal.device.id, minutesAgo(90))).toBe(true);

    await withTenant(db, outletScope(outletA), async (tx) => {
      expect(
        await isDeviceInTrainingAt(tx, trained.device.id, minutesAgo(90)),
      ).toBe(true);
      expect(
        await isDeviceInTrainingAt(tx, trained.device.id, minutesAgo(30)),
      ).toBe(false);
      expect(
        await isDeviceInTrainingAt(tx, normal.device.id, minutesAgo(90)),
      ).toBe(false);
    });
  });

  it("F5 an open training period excludes activity from its start until it is closed", async () => {
    const { device } = await enroll();
    await setDeviceTrainingMode(outletScope(outletA), actor, {
      deviceId: device.id,
      trainingMode: true,
    });
    await asOwner(
      "UPDATE device_training_periods SET started_at = now() - interval '1 hour' WHERE device_id = $1",
      [device.id],
    );
    expect(await reportable(device.id, new Date())).toBe(false);
    expect(
      await reportable(device.id, new Date(Date.now() - 2 * 3600_000)),
    ).toBe(true);
  });

  it("F5 revoking a device in training closes its open period", async () => {
    const { device } = await enroll();
    await setDeviceTrainingMode(outletScope(outletA), actor, {
      deviceId: device.id,
      trainingMode: true,
    });
    await revokeDevice(outletScope(outletA), actor, {
      deviceId: device.id,
      reason: "Dipensiunkan",
    });
    const periods = await periodsOf(device.id);
    expect(periods).toHaveLength(1);
    expect(periods[0].ended_at).not.toBeNull();
  });

  it("F5 only one open training period per device at the database", async () => {
    const { device } = await enroll();
    const insert = () =>
      asOwner(
        `INSERT INTO device_training_periods (tenant_id, outlet_id, device_id, started_at)
         VALUES ($1, $2, $3, now())`,
        [tenantId, outletA, device.id],
      );
    await insert();
    await expect(insert()).rejects.toThrow();
    await expect(
      asOwner(
        `INSERT INTO device_training_periods (tenant_id, outlet_id, device_id, started_at, ended_at)
         VALUES ($1, $2, $3, now(), now() - interval '1 minute')`,
        [tenantId, outletA, device.id],
      ),
    ).rejects.toThrow();
  });

  it("F5 another outlet's user cannot switch the device's training mode", async () => {
    const { device } = await enroll(outletA);
    await expect(
      setDeviceTrainingMode(outletScope(outletB), actor, {
        deviceId: device.id,
        trainingMode: true,
      }),
    ).rejects.toThrow();
    expect((await deviceRow(device.id)).training_mode).toBe(false);
    expect(await periodsOf(device.id)).toHaveLength(0);
  });
});

describe("TEN-01 TEN-03 database guarantees", () => {
  it("TEN-01 device tables have forced restrictive tenant and outlet policies", async () => {
    const names = ["device_training_periods", "devices"];
    const result = await owner.query(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS tenant,
              EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid
                AND p.polname = 'outlet_isolation' AND NOT p.polpermissive) AS outlet
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[]) ORDER BY c.relname`,
      [names],
    );
    expect(result.rows).toEqual(
      names.map((name) => ({
        name,
        enabled: true,
        forced: true,
        tenant: true,
        outlet: true,
      })),
    );
  });

  it("TEN-01 TEN-03 another tenant and another outlet see no devices or training periods", async () => {
    const { device } = await enroll(outletA);
    await setDeviceTrainingMode(outletScope(outletA), actor, {
      deviceId: device.id,
      trainingMode: true,
    });
    const visible = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletA]) },
      async (c) => ({
        devices: (
          await c.query("SELECT id FROM devices WHERE id = $1", [device.id])
        ).rowCount,
        periods: (
          await c.query(
            "SELECT id FROM device_training_periods WHERE device_id = $1",
            [device.id],
          )
        ).rowCount,
      }),
    );
    expect(visible).toEqual({ devices: 1, periods: 1 });

    const otherTenant = await asAppRole(
      { tenant: otherTenantId, outlets: "*" },
      async (c) => ({
        devices: (await c.query("SELECT id FROM devices")).rows,
        periods: (await c.query("SELECT id FROM device_training_periods")).rows,
      }),
    );
    expect(otherTenant).toEqual({ devices: [], periods: [] });

    const otherOutlet = await asAppRole(
      { tenant: tenantId, outlets: JSON.stringify([outletB]) },
      async (c) => ({
        devices: (
          await c.query("SELECT id FROM devices WHERE id = $1", [device.id])
        ).rows,
        periods: (
          await c.query(
            "SELECT id FROM device_training_periods WHERE device_id = $1",
            [device.id],
          )
        ).rows,
      }),
    );
    expect(otherOutlet).toEqual({ devices: [], periods: [] });
  });

  it("TEN-01 TEN-03 writing a device for another tenant or an outlet outside the scope is blocked", async () => {
    const insert = (c: PoolClient, outletId: string) =>
      c.query(
        `INSERT INTO devices (tenant_id, outlet_id, type, label)
         VALUES ($1, $2, 'pos', 'Tembus RLS')`,
        [tenantId, outletId],
      );
    await expect(
      asAppRole({ tenant: otherTenantId, outlets: "*" }, (c) =>
        insert(c, outletA),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asAppRole({ tenant: tenantId, outlets: JSON.stringify([outletB]) }, (c) =>
        insert(c, outletA),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("EDG-03 the database refuses to reactivate a revoked device or to alter its revocation record", async () => {
    const { device } = await enroll();
    await revokeDevice(outletScope(outletA), actor, {
      deviceId: device.id,
      reason: "Terminal",
    });
    await expect(
      asOwner(
        "UPDATE devices SET status = 'active', revoked_at = NULL WHERE id = $1",
        [device.id],
      ),
    ).rejects.toThrow(/cannot be reactivated/);
    await expect(
      asOwner("UPDATE devices SET revoke_reason = 'diubah' WHERE id = $1", [
        device.id,
      ]),
    ).rejects.toThrow(/cannot be reactivated/);
    await expect(
      asOwner("UPDATE devices SET token_issued_at = now() WHERE id = $1", [
        device.id,
      ]),
    ).rejects.toThrow(/cannot be reactivated/);
    expect((await deviceRow(device.id)).status).toBe("revoked");
  });

  it("EDG-03 status and revoked_at must agree", async () => {
    const { device } = await enroll();
    await expect(
      asOwner("UPDATE devices SET status = 'revoked' WHERE id = $1", [
        device.id,
      ]),
    ).rejects.toThrow();
    await expect(
      asOwner("UPDATE devices SET revoked_at = now() WHERE id = $1", [
        device.id,
      ]),
    ).rejects.toThrow();
  });

  it("TEN-01 a device keeps its tenant, outlet, id and type for life", async () => {
    const { device } = await enroll(outletA);
    for (const change of [
      ["outlet_id", outletB],
      ["type", "kds"],
      ["id", randomUUID()],
      ["tenant_id", otherTenantId],
    ] as const) {
      await expect(
        asOwner(`UPDATE devices SET ${change[0]} = $2 WHERE id = $1`, [
          device.id,
          change[1],
        ]),
      ).rejects.toThrow();
    }
    const row = await deviceRow(device.id);
    expect(row).toMatchObject({
      outlet_id: outletA,
      type: "pos",
      tenant_id: tenantId,
    });
  });
});
