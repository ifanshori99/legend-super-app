// Device heartbeat up-sync edge -> cloud (bead legend-2lp.10; PRD v1.7 §3 F5,
// EDG-05). Devices heartbeat to their outlet's edge node
// (POST /api/edge/devices/heartbeat); cloud `devices.last_seen_at` only moved on
// POST /api/devices/heartbeat, so the cloud offline panel
// (isDeviceOffline / listOfflineDevices) showed healthy devices as offline.
// The edge posts the recent `last_seen_at` of its devices to the cloud.
//
// Contract used (from the coordinator's brief, not guessed):
//  - Cloud route `POST /api/edge-sync/device-heartbeats`, same edge credential
//    auth as `GET /api/edge-sync/device-records` (`Authorization: Bearer ...`).
//  - Body (strict): `{ devices: [{ id, lastSeenAt }] }`, 1 to 200 entries.
//    Response `{ applied, ignored }` (read bare or under `data`).
//  - Cloud rules: `last_seen_at` moves forward only and never past the cloud's
//    clock; only active, non-revoked devices of the credential's own tenant and
//    outlet are touched (everything else is `ignored`); `updated_at` is left alone.
//  - Edge side `listRecentDeviceHeartbeats(context, { now })`: active devices of
//    the context's single outlet seen within DEVICE_HEARTBEAT_UPSYNC_WINDOW_MS
//    (15 min), newest first.
//
// Assumptions:
//  - A stale entry (not newer than the stored time) counts as `ignored`, not
//    `applied`. The exact counts are asserted only where the rule is clear.
//  - Written from the contract, not from the implementation. The edge-side
//    timer that posts the batches is not covered here.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  enrollDevice,
  listOfflineDevices,
  revokeDevice,
} from "../services/device.service.ts";
import {
  applyDeviceHeartbeatUpsync,
  DEVICE_HEARTBEAT_UPSYNC_WINDOW_MS,
  listRecentDeviceHeartbeats,
} from "../services/edge-device-sync.ts";
import {
  registerEdgeNode,
  revokeEdgeNode,
  verifyEdgeNodeCredential,
} from "../services/edge-node.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { owner, seedTenantOutlets } from "./floor-test-helpers.ts";

const PATH = "/api/edge-sync/device-heartbeats";
const app = createApp();
const actor = randomUUID();
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const bearer = (credential: string) => `Bearer ${credential}`;

const tenantA = randomUUID();
const tenantB = randomUUID();
const tenantsToFix: string[] = [];
let outletA1 = "";
let outletA2 = "";
let outletB1 = "";
let nodeA1: { id: string; credential: string };
let nodeA2Revoked: { id: string; credential: string };

const scope = (tenantId: string, outletId: string) =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );

/** What the credential check hands the service. */
const verifiedNode = (
  tenantId: string,
  outletId: string,
  edgeNodeId: string,
) => ({
  tenantId: tenantIdSchema.parse(tenantId),
  outletId: outletIdSchema.parse(outletId),
  edgeNodeId,
});

async function asOwner<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

async function enroll(
  tenantId: string,
  outletId: string,
  type: "pos" | "kds" = "pos",
) {
  const { device } = await enrollDevice(scope(tenantId, outletId), actor, {
    outletId,
    type,
    label: `Perangkat ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  return device;
}

type Row = {
  last_seen_at: Date | null;
  updated_at: Date;
  status: string;
};
const deviceRow = async (tenantId: string, id: string) =>
  (
    await asOwner(tenantId, (client) =>
      client.query(
        "SELECT last_seen_at, updated_at, status FROM devices WHERE id = $1",
        [id],
      ),
    )
  ).rows[0] as Row;

const setSeen = (tenantId: string, id: string, at: Date | null) =>
  asOwner(tenantId, (client) =>
    client.query("UPDATE devices SET last_seen_at = $2 WHERE id = $1", [
      id,
      at,
    ]),
  );

const beat = (id: string, lastSeenAt: Date) => ({
  id,
  lastSeenAt: lastSeenAt.toISOString(),
});

const send = (credential: string | null, body: unknown) => {
  let req = request(app).post(PATH);
  if (credential) req = req.set("Authorization", bearer(credential));
  return req.send(body as object);
};

const counts = (body: {
  data?: { applied: number; ignored: number };
  applied?: number;
  ignored?: number;
}) => {
  const inner = body.data ?? body;
  return { applied: inner.applied, ignored: inner.ignored };
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  // server.ts installs the edge registry verifier; createApp() does not.
  setEdgeCredentialVerifier(verifyEdgeNodeCredential);
  const outletsA = await seedTenantOutlets(tenantA, 2);
  outletA1 = outletsA[0]!;
  outletA2 = outletsA[1]!;
  outletB1 = (await seedTenantOutlets(tenantB, 1))[0]!;
  const a1 = await registerEdgeNode(scope(tenantA, outletA1), actor, {
    outletId: outletA1,
    role: "primary",
    label: "Server lokal A1",
  });
  nodeA1 = { id: a1.edgeNode.id, credential: a1.credential };
  const revoked = await registerEdgeNode(scope(tenantA, outletA2), actor, {
    outletId: outletA2,
    role: "primary",
    label: "Server lokal dicabut",
  });
  nodeA2Revoked = { id: revoked.edgeNode.id, credential: revoked.credential };
  await revokeEdgeNode(scope(tenantA, outletA2), actor, {
    edgeNodeId: nodeA2Revoked.id,
    reason: "Uji kredensial dicabut",
  });
}, 120_000);

afterAll(async () => {
  setAuditWriter(null);
  setEdgeCredentialVerifier(null);
  await owner.query(
    "UPDATE tenants SET created_by = $2 WHERE id = ANY($1::uuid[])",
    [[tenantA, tenantB, ...tenantsToFix], randomUUID()],
  );
  await owner.end();
});

describe("legend-2lp.10 POST /api/edge-sync/device-heartbeats: auth", () => {
  it("legend-2lp.10 answers 401 without a credential, even for an invalid body", async () => {
    const device = await enroll(tenantA, outletA1);
    expect(
      (await send(null, { devices: [beat(device.id, new Date())] })).status,
    ).toBe(401);
    expect((await send(null, { nope: true })).status).toBe(401);
    expect((await deviceRow(tenantA, device.id)).last_seen_at).toBeNull();
  });

  it("legend-2lp.10 answers 401 for a garbage credential", async () => {
    const device = await enroll(tenantA, outletA1);
    const res = await send("bukan-kredensial", {
      devices: [beat(device.id, new Date())],
    });
    expect(res.status).toBe(401);
    expect((await deviceRow(tenantA, device.id)).last_seen_at).toBeNull();
  });

  it("legend-2lp.10 answers 401 for a revoked edge credential, before reading the body", async () => {
    const device = await enroll(tenantA, outletA2);
    for (const body of [
      { devices: [beat(device.id, new Date())] },
      { nope: true },
    ]) {
      expect((await send(nodeA2Revoked.credential, body)).status).toBe(401);
    }
    expect((await deviceRow(tenantA, device.id)).last_seen_at).toBeNull();
  });

  it("legend-2lp.10 a device token is not an edge credential", async () => {
    const { token } = await enrollDevice(scope(tenantA, outletA1), actor, {
      outletId: outletA1,
      type: "pos",
      label: "Kasir token",
      stationId: null,
      idempotencyKey: randomUUID(),
    });
    const res = await send(token, {
      devices: [beat(randomUUID(), new Date())],
    });
    expect(res.status).toBe(401);
  });
});

describe("legend-2lp.10 POST /api/edge-sync/device-heartbeats: main flow", () => {
  it("legend-2lp.10 an up-synced heartbeat sets last_seen_at and the device is no longer offline", async () => {
    const device = await enroll(tenantA, outletA1);
    const before = await listOfflineDevices(
      scope(tenantA, outletA1),
      outletA1,
      new Date(),
    );
    // A never-seen active device is offline.
    expect(before.map((d) => d.id)).toContain(device.id);

    const seenAt = new Date(Date.now() - 5_000);
    const res = await send(nodeA1.credential, {
      devices: [beat(device.id, seenAt)],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body)).toEqual({ applied: 1, ignored: 0 });
    const row = await deviceRow(tenantA, device.id);
    expect(row.last_seen_at?.getTime()).toBe(seenAt.getTime());

    const after = await listOfflineDevices(
      scope(tenantA, outletA1),
      outletA1,
      new Date(),
    );
    expect(after.map((d) => d.id)).not.toContain(device.id);
  });

  it("legend-2lp.10 one request updates every device of the batch and leaves updated_at alone", async () => {
    const d1 = await enroll(tenantA, outletA1);
    const d2 = await enroll(tenantA, outletA1, "kds");
    const d3 = await enroll(tenantA, outletA1);
    const updatedBefore = (await deviceRow(tenantA, d1.id)).updated_at;
    const t1 = new Date(Date.now() - 20_000);
    const t2 = new Date(Date.now() - 10_000);
    const res = await send(nodeA1.credential, {
      devices: [beat(d1.id, t1), beat(d2.id, t2)],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body)).toEqual({ applied: 2, ignored: 0 });
    const first = await deviceRow(tenantA, d1.id);
    expect(first.last_seen_at?.getTime()).toBe(t1.getTime());
    // Telemetry must not make the registry feed re-send the row.
    expect(first.updated_at.getTime()).toBe(updatedBefore.getTime());
    expect((await deviceRow(tenantA, d2.id)).last_seen_at?.getTime()).toBe(
      t2.getTime(),
    );
    // A device missing from the batch is untouched.
    expect((await deviceRow(tenantA, d3.id)).last_seen_at).toBeNull();
  });

  it("legend-2lp.10 last_seen_at moves forward only: an older entry changes nothing", async () => {
    const device = await enroll(tenantA, outletA1);
    const stored = new Date(Date.now() - 10_000);
    await setSeen(tenantA, device.id, stored);
    const res = await send(nodeA1.credential, {
      devices: [beat(device.id, new Date(stored.getTime() - HOUR_MS))],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body)).toEqual({ applied: 0, ignored: 1 });
    expect((await deviceRow(tenantA, device.id)).last_seen_at?.getTime()).toBe(
      stored.getTime(),
    );
    // A newer entry does move it.
    const newer = new Date(stored.getTime() + 5_000);
    expect(
      (await send(nodeA1.credential, { devices: [beat(device.id, newer)] }))
        .status,
    ).toBe(200);
    expect((await deviceRow(tenantA, device.id)).last_seen_at?.getTime()).toBe(
      newer.getTime(),
    );
  });

  it("legend-2lp.10 a time from the future is clamped to the cloud clock", async () => {
    const device = await enroll(tenantA, outletA1);
    const now = new Date();
    const result = await applyDeviceHeartbeatUpsync(
      verifiedNode(tenantA, outletA1, nodeA1.id),
      { devices: [beat(device.id, new Date(now.getTime() + HOUR_MS))] },
      { now },
    );
    expect(result).toEqual({ applied: 1, ignored: 0 });
    expect((await deviceRow(tenantA, device.id)).last_seen_at?.getTime()).toBe(
      now.getTime(),
    );
    // Over HTTP too: never more than the cloud's clock (1 min slack for clocks).
    const other = await enroll(tenantA, outletA1);
    const res = await send(nodeA1.credential, {
      devices: [beat(other.id, new Date(Date.now() + HOUR_MS))],
    });
    expect(res.status).toBe(200);
    const seen = (await deviceRow(tenantA, other.id)).last_seen_at!;
    expect(seen.getTime()).toBeLessThanOrEqual(Date.now() + MIN_MS);
  });

  it("legend-2lp.10 accepts a full batch of 200 entries", async () => {
    const device = await enroll(tenantA, outletA1);
    const filler = Array.from({ length: 199 }, () =>
      beat(randomUUID(), new Date()),
    );
    const res = await send(nodeA1.credential, {
      devices: [beat(device.id, new Date(Date.now() - 1_000)), ...filler],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body)).toEqual({ applied: 1, ignored: 199 });
  });
});

describe("legend-2lp.10 POST /api/edge-sync/device-heartbeats: scope and refusals", () => {
  it("legend-2lp.10 a node never touches a device of another outlet or tenant, nor an unknown id", async () => {
    const sameTenantOtherOutlet = await enroll(tenantA, outletA2);
    const otherTenant = await enroll(tenantB, outletB1);
    const res = await send(nodeA1.credential, {
      devices: [
        beat(sameTenantOtherOutlet.id, new Date()),
        beat(otherTenant.id, new Date()),
        beat(randomUUID(), new Date()),
      ],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body)).toEqual({ applied: 0, ignored: 3 });
    expect(
      (await deviceRow(tenantA, sameTenantOtherOutlet.id)).last_seen_at,
    ).toBeNull();
    expect((await deviceRow(tenantB, otherTenant.id)).last_seen_at).toBeNull();
  });

  it("legend-2lp.10 a revoked device stays out of service and its last_seen_at is not touched", async () => {
    const device = await enroll(tenantA, outletA1);
    await revokeDevice(scope(tenantA, outletA1), actor, {
      deviceId: device.id,
      reason: "Dicuri",
    });
    const res = await send(nodeA1.credential, {
      devices: [beat(device.id, new Date())],
    });
    expect(res.status).toBe(200);
    expect(counts(res.body)).toEqual({ applied: 0, ignored: 1 });
    const row = await deviceRow(tenantA, device.id);
    expect(row.status).toBe("revoked");
    expect(row.last_seen_at).toBeNull();
  });

  it("legend-2lp.10 an invalid body is refused with 4xx and changes nothing", async () => {
    const device = await enroll(tenantA, outletA1);
    const good = beat(device.id, new Date());
    const bodies: unknown[] = [
      {},
      { devices: [] },
      { devices: "nope" },
      { devices: [{ id: device.id, lastSeenAt: "kemarin" }] },
      { devices: [{ ...good, extra: true }] },
      { devices: [good], extra: true },
      { devices: [{ id: "bukan-uuid", lastSeenAt: good.lastSeenAt }] },
      { devices: [{ id: device.id }] },
      {
        devices: Array.from({ length: 201 }, () =>
          beat(randomUUID(), new Date()),
        ),
      },
    ];
    for (const body of bodies) {
      const res = await send(nodeA1.credential, body);
      expect(
        res.status,
        JSON.stringify(body).slice(0, 80),
      ).toBeGreaterThanOrEqual(400);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBeLessThan(500);
    }
    expect((await deviceRow(tenantA, device.id)).last_seen_at).toBeNull();
  });
});

describe("legend-2lp.10 edge side: listRecentDeviceHeartbeats", () => {
  it("legend-2lp.10 lists active devices of the outlet seen within the window, newest first", async () => {
    const now = new Date();
    // Own tenant per test: the list is the whole outlet, nothing else may be in it.
    const tenantId = randomUUID();
    tenantsToFix.push(tenantId);
    const outlets = await seedTenantOutlets(tenantId, 2);
    const [outlet, otherOutlet] = [outlets[0]!, outlets[1]!];
    const recent = await enroll(tenantId, outlet);
    const newest = await enroll(tenantId, outlet, "kds");
    const old = await enroll(tenantId, outlet);
    // Active but never seen: not listed.
    await enroll(tenantId, outlet);
    const gone = await enroll(tenantId, outlet);
    const foreign = await enroll(tenantId, otherOutlet);
    await setSeen(tenantId, recent.id, new Date(now.getTime() - 5 * MIN_MS));
    await setSeen(tenantId, newest.id, new Date(now.getTime() - 10_000));
    await setSeen(
      tenantId,
      old.id,
      new Date(now.getTime() - DEVICE_HEARTBEAT_UPSYNC_WINDOW_MS - MIN_MS),
    );
    await setSeen(tenantId, gone.id, new Date(now.getTime() - MIN_MS));
    await revokeDevice(scope(tenantId, outlet), actor, {
      deviceId: gone.id,
      reason: "Dicuri",
    });
    await setSeen(tenantId, foreign.id, new Date(now.getTime() - MIN_MS));

    const list = await listRecentDeviceHeartbeats(scope(tenantId, outlet), {
      now,
    });
    expect(list.map((entry) => entry.id)).toEqual([newest.id, recent.id]);
    expect(list[0]!.lastSeenAt).toBe(
      new Date(now.getTime() - 10_000).toISOString(),
    );
    expect(DEVICE_HEARTBEAT_UPSYNC_WINDOW_MS).toBe(15 * MIN_MS);
  });

  it("legend-2lp.10 an outlet without recent heartbeats gives an empty list", async () => {
    const tenantId = randomUUID();
    tenantsToFix.push(tenantId);
    const outlets = await seedTenantOutlets(tenantId, 1);
    await enroll(tenantId, outlets[0]!);
    expect(
      await listRecentDeviceHeartbeats(scope(tenantId, outlets[0]!), {
        now: new Date(),
      }),
    ).toEqual([]);
  });

  it("legend-2lp.10 refuses a context that is not exactly one outlet", async () => {
    const tenantContext = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenantA),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    await expect(
      listRecentDeviceHeartbeats(tenantContext, { now: new Date() }),
    ).rejects.toThrow();
  });
});
