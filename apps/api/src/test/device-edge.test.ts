// Device registry on the edge (bead legend-165; PRD v1.7 §3 F5, EDG-02
// replication "cloud wins", EDG-03 revocation, TEN-01..03). The edge holds a
// replica of the cloud registry for its own outlet and must keep refusing a
// revoked device while the cloud is unreachable. Written from the brief's
// contracts.
//
// In these tests the "edge" database is the same database as the cloud, so
// the apply tests delete the local (cloud) row first, then apply records the
// way a pull would. "Cloud unreachable" is proven by a fetch spy that must
// never be called while the token is checked.
//
// Assumptions: listDeviceRecordsSince(node, {since?, limit}, {now, settleMs})
// answers a page `{data, meta: {limit, nextCursor, watermark}}` like
// staff-pin-sync; applyDeviceRecords(context, records) refuses a whole page if
// one record is for another tenant or outlet; a record carries every shared
// `Device` field plus `updatedAt` and `tokenIssuedAt` (the token floor, so the
// edge replica refuses rotated-out tokens too); pullDeviceRegistry takes
// `{context, since?, fetchPage, maxPages?}`.
// Round 3 (security review): DEVICE_SYNC_OVERLAP_MS (10 min) is exported from
// edge-device-sync.ts; pullDeviceRegistry starts at the stored `since` rewound
// by that overlap (the cursor's version is the microsecond UTC `updated_at`
// text at index 1 of the decoded cursor; read through the public
// `decodeCursor`). applyDeviceRecords needs a context scoped to exactly one
// outlet; a tenant-wide or multi-outlet context is refused with nothing stored.
// A replica's token floor only goes up, and a null floor never replaces one.
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { Pool } from "pg";
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
  cafeLegendFixtures,
  decodeCursor,
  outletIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { deviceSchema, deviceSyncRecordSchema } from "@starter/shared/edge";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { verifyDeviceToken } from "../lib/device-token.ts";
import {
  getEdgeRuntimeState,
  setDeviceRegistryReadyForTests,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  enrollDevice,
  issueDeviceToken,
  revokeDevice,
} from "../services/device.service.ts";
import { findActiveDeviceForToken } from "../services/device-registry-check.ts";
import {
  DEVICE_SYNC_OVERLAP_MS,
  applyDeviceRecords,
  listDeviceRecordsSince,
  pullDeviceRegistry,
} from "../services/edge-device-sync.ts";
import { deviceTenantCredential } from "../services/platform-tenant.service.ts";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const actor = randomUUID();

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const cloudBase = () =>
  establishTenantContext({ tenantId, brandId: null, source: "session" });
const edgeBase = () =>
  establishTenantContext({ tenantId, brandId: null, source: "device" });
const scoped = (
  base: ReturnType<typeof cloudBase>,
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(base, {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });
const cloudScope = (outletId: string) => scoped(cloudBase(), outletId);
const edgeScope = (outletId: string) => scoped(edgeBase(), outletId);

const nodeOf = (outletId: string) => ({
  tenantId,
  outletId: outletIdSchema.parse(outletId),
  edgeNodeId: randomUUID(),
});
// Later than every row, and no settle window: freshly written rows are
// exported at once and a DB clock that runs ahead cannot hide them.
const exportNow = () => ({
  now: new Date(Date.now() + 10 * 60_000),
  settleMs: 0,
});

type Page = {
  data: unknown[];
  meta: { limit: number; nextCursor: string | null; watermark: string | null };
};
type SyncRecord = ReturnType<typeof deviceSyncRecordSchema.parse>;

async function pullAll(
  outletId: string,
  since?: string,
  limit = 100,
): Promise<{ records: SyncRecord[]; watermark: string | undefined }> {
  const records: SyncRecord[] = [];
  let cursor = since;
  let watermark = since;
  for (let page = 0; page < 1000; page++) {
    const result = (await listDeviceRecordsSince(
      nodeOf(outletId),
      { since: cursor, limit },
      exportNow(),
    )) as unknown as Page;
    records.push(...result.data.map((r) => deviceSyncRecordSchema.parse(r)));
    watermark = result.meta.watermark ?? watermark;
    if (result.meta.nextCursor === null) break;
    cursor = result.meta.nextCursor;
  }
  return { records, watermark };
}

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

const rowOf = async (id: string) =>
  (await asOwner("SELECT * FROM devices WHERE id = $1", [id])).rows[0];

/** Drops the local row, the way a fresh edge node has no replica yet. */
async function forgetLocally(...ids: string[]) {
  await asOwner(
    "DELETE FROM device_training_periods WHERE device_id = ANY($1::uuid[])",
    [ids],
  );
  await asOwner("DELETE FROM devices WHERE id = ANY($1::uuid[])", [ids]);
}

async function enroll(outletId: string = outletA, label?: string) {
  return enrollDevice(cloudScope(outletId), actor, {
    outletId,
    type: "pos",
    label: label ?? `Kasir ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
}

async function recordFor(outletId: string, deviceId: string) {
  const { records } = await pullAll(outletId);
  const record = records.find((r) => r.id === deviceId);
  if (!record) throw new Error("device record not exported");
  return record;
}

const isoPlus = (iso: string, ms: number) =>
  new Date(Date.parse(iso) + ms).toISOString();

function credentialOf(token: string) {
  const req = {
    get: (name: string) =>
      name.toLowerCase() === DEVICE_TOKEN_HEADER ? token : undefined,
  } as unknown as Request;
  return deviceTenantCredential(req);
}

/** This process becomes the edge node of `outletId`. */
function actAsEdge(outletId: string) {
  setDeviceRegistryReadyForTests({});
  setEdgeRuntimeStateForTests({
    edgeMode: true,
    identity: {
      context: edgeScope(outletId),
      scope: { tenantId, outletId, edgeNodeId: randomUUID() },
    },
    link: { cloudLink: "disconnected", refused: false, lastConnectedAt: null },
  });
}

const cloudState = getEdgeRuntimeState();

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterEach(() => {
  setEdgeRuntimeStateForTests(cloudState);
  setDeviceRegistryReadyForTests(null);
  vi.restoreAllMocks();
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(cloudState);
  setAuditWriter(null);
  await owner.end();
});

describe("EDG-02 device records exported to an edge node", () => {
  it("EDG-02 TEN-03 a node receives its own outlet's devices, revoked ones included, and nothing else", async () => {
    const live = await enroll(outletA);
    const dead = await enroll(outletA);
    const elsewhere = await enroll(outletB);
    await revokeDevice(cloudScope(outletA), actor, {
      deviceId: dead.device.id,
      reason: "Hilang",
    });
    const { records } = await pullAll(outletA);
    const byId = new Map(records.map((r) => [r.id, r]));
    expect(byId.get(live.device.id)).toMatchObject({
      status: "active",
      revokedAt: null,
      tenantId,
      outletId: outletA,
    });
    expect(byId.get(dead.device.id)).toMatchObject({ status: "revoked" });
    expect(byId.get(dead.device.id)?.revokedAt).not.toBeNull();
    expect(byId.has(elsewhere.device.id)).toBe(false);
    expect(records.every((r) => r.outletId === outletA)).toBe(true);
    expect(
      (await pullAll(outletB)).records.some((r) => r.id === live.device.id),
    ).toBe(false);
  });

  it("EDG-02 a record is the device plus updatedAt and never carries a token or secret", async () => {
    const { device, token } = await enroll(outletA);
    const record = await recordFor(outletA, device.id);
    expect(Object.keys(record).sort()).toEqual(
      [
        ...Object.keys(deviceSchema.parse(device)),
        "updatedAt",
        "tokenIssuedAt",
      ].sort(),
    );
    const text = JSON.stringify(record);
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.split(".")[2]);
  });

  it("EDG-02 watermark paging returns each device once, then only later changes", async () => {
    const first = await enroll(outletA);
    const second = await enroll(outletA);
    const all = await pullAll(outletA, undefined, 1);
    const ids = all.records.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(first.device.id);
    expect(ids).toContain(second.device.id);
    expect(all.watermark).toBeDefined();

    const idle = await pullAll(outletA, all.watermark);
    expect(idle.records).toEqual([]);

    await revokeDevice(cloudScope(outletA), actor, {
      deviceId: second.device.id,
      reason: "Rusak",
    });
    const changed = await pullAll(outletA, all.watermark);
    expect(changed.records.map((r) => r.id)).toEqual([second.device.id]);
    expect(changed.records[0]).toMatchObject({ status: "revoked" });
  });

  it("TEN-01 a node naming another tenant is refused", async () => {
    await expect(
      listDeviceRecordsSince(
        {
          tenantId: randomUUID() as TenantId,
          outletId: outletA,
          edgeNodeId: randomUUID(),
        },
        { limit: 10 },
        exportNow(),
      ),
    ).rejects.toThrow();
  });

  it("EDG-02 a tampered cursor is a validation error", async () => {
    await expect(
      listDeviceRecordsSince(
        nodeOf(outletA),
        { since: "bm90LWEtY3Vyc29y", limit: 10 },
        exportNow(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("EDG-02 EDG-03 the edge replica", () => {
  it("EDG-02 applying records rebuilds the replica row, and applying again changes nothing", async () => {
    const { device } = await enroll(outletA, "Kasir replika");
    const record = await recordFor(outletA, device.id);
    await forgetLocally(device.id);
    expect(await rowOf(device.id)).toBeUndefined();

    await applyDeviceRecords(edgeScope(outletA), [record]);
    const row = await rowOf(device.id);
    expect(row).toMatchObject({
      id: device.id,
      tenant_id: tenantId,
      outlet_id: outletA,
      type: "pos",
      label: "Kasir replika",
      status: "active",
      revoked_at: null,
    });

    await applyDeviceRecords(edgeScope(outletA), [record]);
    const again = await asOwner(
      "SELECT count(*)::int AS n FROM devices WHERE id = $1",
      [device.id],
    );
    expect(again.rows[0].n).toBe(1);
    expect(await rowOf(device.id)).toMatchObject({
      label: "Kasir replika",
      status: "active",
    });
  });

  it("EDG-02 cloud wins: a newer record overwrites the replica's fields", async () => {
    const { device } = await enroll(outletA, "Label lama");
    const record = await recordFor(outletA, device.id);
    await forgetLocally(device.id);
    await applyDeviceRecords(edgeScope(outletA), [record]);
    await applyDeviceRecords(edgeScope(outletA), [
      {
        ...record,
        label: "Label dari cloud",
        version: "9.9.9",
        capabilities: ["print", "scan"],
        updatedAt: isoPlus(record.updatedAt, 60_000),
      },
    ]);
    // Registry fields: cloud wins. Telemetry (version, capabilities) is owned
    // by whoever saw the newest heartbeat; this record carries none, so the
    // replica keeps its own.
    expect(await rowOf(device.id)).toMatchObject({
      label: "Label dari cloud",
      version: record.version,
      capabilities: record.capabilities,
    });

    const seenAt = isoPlus(record.updatedAt, 90_000);
    await applyDeviceRecords(edgeScope(outletA), [
      {
        ...record,
        label: "Label dari cloud",
        version: "9.9.9",
        capabilities: ["print", "scan"],
        lastSeenAt: seenAt,
        updatedAt: isoPlus(record.updatedAt, 120_000),
      },
    ]);
    expect(await rowOf(device.id)).toMatchObject({
      version: "9.9.9",
      capabilities: ["print", "scan"],
    });

    // Older telemetry from the cloud never rolls back a fresher local heartbeat.
    await applyDeviceRecords(edgeScope(outletA), [
      {
        ...record,
        label: "Label dari cloud",
        version: "1.0.0",
        capabilities: [],
        lastSeenAt: isoPlus(record.updatedAt, 30_000),
        updatedAt: isoPlus(record.updatedAt, 150_000),
      },
    ]);
    expect(await rowOf(device.id)).toMatchObject({
      version: "9.9.9",
      capabilities: ["print", "scan"],
    });
  });

  it("EDG-03 after the replica learns of a revocation the edge refuses the token with no call to the cloud", async () => {
    const { device, token } = await enroll(outletA);
    const record = await recordFor(outletA, device.id);
    await forgetLocally(device.id);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    actAsEdge(outletA);

    // Not replicated yet: an unknown device is refused (fail closed).
    expect(await credentialOf(token)).toBeNull();

    await applyDeviceRecords(edgeScope(outletA), [record]);
    expect(await credentialOf(token)).toMatchObject({
      tenantId,
      source: "device",
    });

    const revokedAt = isoPlus(record.updatedAt, 30_000);
    await applyDeviceRecords(edgeScope(outletA), [
      {
        ...record,
        status: "revoked",
        revokedAt,
        updatedAt: revokedAt,
      },
    ]);
    expect((await rowOf(device.id)).status).toBe("revoked");
    expect(await credentialOf(token)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("EDG-03 a revoked replica row never comes back, whatever record arrives later", async () => {
    const { device, token } = await enroll(outletA);
    const record = await recordFor(outletA, device.id);
    await forgetLocally(device.id);
    actAsEdge(outletA);
    const revokedAt = isoPlus(record.updatedAt, 30_000);
    const revoked = {
      ...record,
      status: "revoked" as const,
      revokedAt,
      updatedAt: revokedAt,
    };
    await applyDeviceRecords(edgeScope(outletA), [revoked]);
    expect((await rowOf(device.id)).status).toBe("revoked");

    // An older record (the device was still active then)...
    await applyDeviceRecords(edgeScope(outletA), [record]);
    expect(await rowOf(device.id)).toMatchObject({ status: "revoked" });
    expect((await rowOf(device.id)).revoked_at).not.toBeNull();
    // ...and even a newer one claiming it is active.
    await applyDeviceRecords(edgeScope(outletA), [
      { ...record, updatedAt: isoPlus(revokedAt, 60_000), label: "Hidup lagi" },
    ]);
    expect(await rowOf(device.id)).toMatchObject({ status: "revoked" });
    expect((await rowOf(device.id)).revoked_at).not.toBeNull();
    expect(await credentialOf(token)).toBeNull();
  });

  it("EDG-03 the replica carries the token floor: a reissue on the cloud rotates the old token out on the edge", async () => {
    const { device, token: oldToken } = await enroll(outletA);
    // Reissue one minute "later" so the new floor is a different second.
    const { token: newToken } = await issueDeviceToken(
      cloudScope(outletA),
      actor,
      { deviceId: device.id },
      new Date(Date.now() + 60_000),
    );
    const record = await recordFor(outletA, device.id);
    expect(record.tokenIssuedAt).not.toBeNull();
    await forgetLocally(device.id);
    actAsEdge(outletA);
    await applyDeviceRecords(edgeScope(outletA), [record]);
    expect(await credentialOf(newToken)).toMatchObject({ source: "device" });
    expect(await credentialOf(oldToken)).toBeNull();
  });

  it("EDG-02 pulling stops with an error when the cloud never ends the pages", async () => {
    const { device } = await enroll(outletA);
    const record = await recordFor(outletA, device.id);
    const requested: Array<string | null> = [];
    await expect(
      pullDeviceRegistry({
        context: edgeScope(outletA),
        maxPages: 2,
        fetchPage: async (since: string | null) => {
          requested.push(since);
          return {
            data: [record],
            meta: {
              limit: 1,
              nextCursor: `cursor-${requested.length}`,
              watermark: null,
            },
          };
        },
      }),
    ).rejects.toThrow();
    expect(requested.length).toBeLessThanOrEqual(2);
  });

  it("TEN-03 records for another outlet are refused and nothing is stored", async () => {
    const stray = await newRecord(outletB);
    await expect(
      applyDeviceRecords(edgeScope(outletA), [stray]),
    ).rejects.toThrow();
    expect(await rowOf(stray.id)).toBeUndefined();
  });

  it("TEN-01 records for another tenant are refused and nothing is stored", async () => {
    const stray = {
      ...(await newRecord(outletA)),
      tenantId: randomUUID() as TenantId,
    };
    await expect(
      applyDeviceRecords(edgeScope(outletA), [stray]),
    ).rejects.toThrow();
    expect(await rowOf(stray.id)).toBeUndefined();
  });

  it("TEN-01 TEN-03 one bad record refuses the whole page", async () => {
    const good = await newRecord(outletA);
    const bad = await newRecord(outletB);
    await expect(
      applyDeviceRecords(edgeScope(outletA), [good, bad]),
    ).rejects.toThrow();
    expect(await rowOf(good.id)).toBeUndefined();
    expect(await rowOf(bad.id)).toBeUndefined();
  });

  it("EDG-02 a record with a field outside the contract (a token, say) is refused", async () => {
    const record = {
      ...(await newRecord(outletA)),
      token: "dv1.abc.def",
    };
    await expect(
      applyDeviceRecords(edgeScope(outletA), [record]),
    ).rejects.toThrow();
    expect(await rowOf(record.id)).toBeUndefined();
  });

  it("EDG-02 pulling follows the cursor through every page before returning the watermark", async () => {
    const one = await enroll(outletA, "Tarik 1");
    const two = await enroll(outletA, "Tarik 2");
    // Cloud and edge share one test database: export every page first (the
    // cloud side), then drop the rows (a fresh edge replica) and serve the
    // recorded pages by cursor.
    const pages = new Map<
      string | null,
      Awaited<ReturnType<typeof listDeviceRecordsSince>>
    >();
    let cursor: string | null = null;
    for (let i = 0; i < 10_000; i += 1) {
      const page = await listDeviceRecordsSince(
        nodeOf(outletA),
        { since: cursor ?? undefined, limit: 1 },
        exportNow(),
      );
      pages.set(cursor, page);
      if (page.data.length === 0 || page.meta.nextCursor === null) break;
      cursor = page.meta.nextCursor;
    }
    await forgetLocally(one.device.id, two.device.id);
    const requested: Array<string | null> = [];
    const result = await pullDeviceRegistry({
      context: edgeScope(outletA),
      fetchPage: async (since: string | null) => {
        requested.push(since);
        const page = pages.get(since);
        if (!page) throw new Error(`unexpected cursor ${since}`);
        return page;
      },
    });
    expect(requested[0]).toBeNull();
    expect(requested.length).toBeGreaterThanOrEqual(2);
    expect(result.watermark).not.toBeNull();
    expect(await rowOf(one.device.id)).toMatchObject({ label: "Tarik 1" });
    expect(await rowOf(two.device.id)).toMatchObject({ label: "Tarik 2" });
  });

  /** A well-formed active record for a device id the database has not seen. */
  async function newRecord(outletId: string): Promise<SyncRecord> {
    const now = new Date().toISOString();
    return deviceSyncRecordSchema.parse({
      tenantId,
      outletId,
      id: randomUUID(),
      type: "kds",
      stationId: null,
      label: "Rekaman baru",
      version: "1.0.0",
      capabilities: [],
      lastSeenAt: null,
      revokedAt: null,
      status: "active",
      trainingMode: false,
      updatedAt: now,
      tokenIssuedAt: now,
    });
  }
});

describe("EDG-02 EDG-03 replication hardening (security review)", () => {
  it("EDG-02 pulling rewinds the stored watermark by the overlap and so catches a revoke that committed with an older updated_at", async () => {
    expect(DEVICE_SYNC_OVERLAP_MS).toBe(10 * 60 * 1000);
    const keep = await enroll(outletA, "Overlap tetap");
    const lost = await enroll(outletA, "Overlap hilang");
    const stored = await pullAll(outletA);
    const watermark = stored.watermark!;
    const watermarkVersion = String(decodeCursor(watermark)[1]);
    const activeRecord = await recordFor(outletA, lost.device.id);

    // The revoke commits late: its updated_at falls before the stored
    // watermark, so a pull that starts exactly at the watermark never sees it.
    await revokeDevice(cloudScope(outletA), actor, {
      deviceId: lost.device.id,
      reason: "Hilang",
    });
    await asOwner("UPDATE devices SET updated_at = $2 WHERE id = $1", [
      lost.device.id,
      isoPlus(watermarkVersion, -60_000),
    ]);
    const revokedRecord = await recordFor(outletA, lost.device.id);
    expect(revokedRecord.status).toBe("revoked");
    expect(Date.parse(revokedRecord.updatedAt)).toBeLessThan(
      Date.parse(watermarkVersion),
    );

    // The edge replica is stale: it still holds the device as active.
    await forgetLocally(lost.device.id);
    await applyDeviceRecords(edgeScope(outletA), [activeRecord]);
    expect(await rowOf(lost.device.id)).toMatchObject({ status: "active" });

    // A stand-in cloud: records strictly after the cursor's version.
    const requested: Array<string | null> = [];
    const result = await pullDeviceRegistry({
      context: edgeScope(outletA),
      since: watermark,
      fetchPage: async (since: string | null) => {
        requested.push(since);
        const floor =
          since === null
            ? Number.NEGATIVE_INFINITY
            : Date.parse(String(decodeCursor(since)[1]));
        const data = [revokedRecord].filter(
          (record) => Date.parse(record.updatedAt) > floor,
        );
        return {
          data,
          meta: { limit: 100, nextCursor: null, watermark: since },
        };
      },
    });

    expect(requested[0]).not.toBeNull();
    expect(requested[0]).not.toBe(watermark);
    const askedFrom = Date.parse(String(decodeCursor(requested[0]!)[1]));
    // Allow 1 ms: the cursor keeps microseconds, JS dates keep milliseconds.
    expect(
      Math.abs(
        Date.parse(watermarkVersion) - askedFrom - DEVICE_SYNC_OVERLAP_MS,
      ),
    ).toBeLessThanOrEqual(1);
    expect(result.applied).toBeGreaterThanOrEqual(1);
    expect(await rowOf(lost.device.id)).toMatchObject({ status: "revoked" });
    expect((await rowOf(lost.device.id)).revoked_at).not.toBeNull();
    expect(await rowOf(keep.device.id)).toMatchObject({ status: "active" });
  });

  it("EDG-02 the first pull (no stored watermark) starts from the beginning, not from a rewound cursor", async () => {
    const requested: Array<string | null> = [];
    await pullDeviceRegistry({
      context: edgeScope(outletA),
      fetchPage: async (since: string | null) => {
        requested.push(since);
        return {
          data: [],
          meta: { limit: 100, nextCursor: null, watermark: null },
        };
      },
    });
    expect(requested).toEqual([null]);
  });

  it("EDG-03 an older out-of-order record never lowers the replica's token floor: a rotated-out token stays refused on the edge", async () => {
    const { device, token: oldToken } = await enroll(outletA);
    const before = await recordFor(outletA, device.id);
    const { token: newToken } = await issueDeviceToken(
      cloudScope(outletA),
      actor,
      { deviceId: device.id },
      new Date(Date.now() + 60_000),
    );
    const after = await recordFor(outletA, device.id);
    expect(Date.parse(after.tokenIssuedAt!)).toBeGreaterThan(
      Date.parse(before.tokenIssuedAt!),
    );
    await forgetLocally(device.id);
    actAsEdge(outletA);

    await applyDeviceRecords(edgeScope(outletA), [after]);
    // The page that carried the first (older) state arrives late.
    await applyDeviceRecords(edgeScope(outletA), [before]);

    expect(
      new Date((await rowOf(device.id)).token_issued_at).toISOString(),
    ).toBe(after.tokenIssuedAt);
    expect(await credentialOf(oldToken)).toBeNull();
    expect(await credentialOf(newToken)).toMatchObject({ source: "device" });
  });

  it("EDG-03 a record with no token floor never erases the replica's floor", async () => {
    const { device, token: oldToken } = await enroll(outletA);
    const before = await recordFor(outletA, device.id);
    const { token: newToken } = await issueDeviceToken(
      cloudScope(outletA),
      actor,
      { deviceId: device.id },
      new Date(Date.now() + 60_000),
    );
    const after = await recordFor(outletA, device.id);
    await forgetLocally(device.id);
    actAsEdge(outletA);
    await applyDeviceRecords(edgeScope(outletA), [after]);
    await applyDeviceRecords(edgeScope(outletA), [
      {
        ...before,
        tokenIssuedAt: null,
        updatedAt: isoPlus(after.updatedAt, 60_000),
      },
    ]);
    expect(
      new Date((await rowOf(device.id)).token_issued_at).toISOString(),
    ).toBe(after.tokenIssuedAt);
    expect(await credentialOf(oldToken)).toBeNull();
    expect(await credentialOf(newToken)).toMatchObject({ source: "device" });
  });

  it("EDG-03 a newer record still raises the token floor", async () => {
    const { device, token: oldToken } = await enroll(outletA);
    const before = await recordFor(outletA, device.id);
    const { token: newToken } = await issueDeviceToken(
      cloudScope(outletA),
      actor,
      { deviceId: device.id },
      new Date(Date.now() + 60_000),
    );
    const after = await recordFor(outletA, device.id);
    await forgetLocally(device.id);
    actAsEdge(outletA);
    await applyDeviceRecords(edgeScope(outletA), [before]);
    expect(await credentialOf(oldToken)).toMatchObject({ source: "device" });
    await applyDeviceRecords(edgeScope(outletA), [after]);
    expect(await credentialOf(oldToken)).toBeNull();
    expect(await credentialOf(newToken)).toMatchObject({ source: "device" });
  });

  it("TEN-03 applying with a tenant-wide context is refused and nothing is stored", async () => {
    const record = await newRecord(outletA);
    const tenantWide = establishScopedTenantContext(edgeBase(), {
      kind: "tenant",
    });
    await expect(applyDeviceRecords(tenantWide, [record])).rejects.toThrow();
    expect(await rowOf(record.id)).toBeUndefined();
  });

  it("TEN-03 applying with a context spanning several outlets is refused and nothing is stored", async () => {
    const record = await newRecord(outletA);
    const twoOutlets = establishScopedTenantContext(edgeBase(), {
      kind: "outlets",
      outletIds: [outletIdSchema.parse(outletA), outletIdSchema.parse(outletB)],
    });
    await expect(applyDeviceRecords(twoOutlets, [record])).rejects.toThrow();
    expect(await rowOf(record.id)).toBeUndefined();
  });

  it("TEN-03 pulling with a tenant-wide context applies nothing", async () => {
    const record = await newRecord(outletA);
    const tenantWide = establishScopedTenantContext(edgeBase(), {
      kind: "tenant",
    });
    await expect(
      pullDeviceRegistry({
        context: tenantWide,
        fetchPage: async () => ({
          data: [record],
          meta: { limit: 100, nextCursor: null, watermark: null },
        }),
      }),
    ).rejects.toThrow();
    expect(await rowOf(record.id)).toBeUndefined();
  });

  /** A well-formed active record for a device id the database has not seen. */
  async function newRecord(outletId: string): Promise<SyncRecord> {
    const now = new Date().toISOString();
    return deviceSyncRecordSchema.parse({
      tenantId,
      outletId,
      id: randomUUID(),
      type: "kds",
      stationId: null,
      label: "Rekaman baru",
      version: "1.0.0",
      capabilities: [],
      lastSeenAt: null,
      revokedAt: null,
      status: "active",
      trainingMode: false,
      updatedAt: now,
      tokenIssuedAt: now,
    });
  }
});

describe("EDG-03 token check on the edge", () => {
  it("TEN-03 on an edge node a device of another outlet is refused; the cloud and its own outlet accept it", async () => {
    const { device, token } = await enroll(outletB);
    const payload = verifyDeviceToken(token)!;

    // Cloud (no edge identity): outlet does not restrict.
    expect(await credentialOf(token)).not.toBeNull();

    actAsEdge(outletA);
    expect(await credentialOf(token)).toBeNull();
    expect(await findActiveDeviceForToken(payload, { outletId: outletA })).toBe(
      null,
    );

    actAsEdge(outletB);
    expect(await credentialOf(token)).not.toBeNull();
    expect(
      await findActiveDeviceForToken(payload, { outletId: outletB }),
    ).toMatchObject({ id: device.id });
  });

  it("EDG-03 a device unknown to the edge replica is refused even with a valid signature", async () => {
    const { device, token } = await enroll(outletA);
    const payload = verifyDeviceToken(token)!;
    await forgetLocally(device.id);
    actAsEdge(outletA);
    expect(await credentialOf(token)).toBeNull();
    expect(await findActiveDeviceForToken(payload, { outletId: outletA })).toBe(
      null,
    );
  });

  it("TEN-02 a token whose tenant differs from the device's tenant finds no device", async () => {
    const { token } = await enroll(outletA);
    const payload = verifyDeviceToken(token)!;
    const foreign = { ...payload, tenantId: randomUUID() as TenantId };
    expect(await findActiveDeviceForToken(foreign)).toBeNull();
  });

  it("EDG-03 findActiveDeviceForToken returns the row only while the device is active", async () => {
    const { device, token } = await enroll(outletA);
    const payload = verifyDeviceToken(token)!;
    expect(await findActiveDeviceForToken(payload)).toMatchObject({
      id: device.id,
    });
    await revokeDevice(cloudScope(outletA), actor, {
      deviceId: device.id,
      reason: "Dicabut",
    });
    expect(await findActiveDeviceForToken(payload)).toBeNull();
  });
});
