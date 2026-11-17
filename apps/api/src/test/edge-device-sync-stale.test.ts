// Edge replica: stale records and non-POS shared flags (legend-xrbjv, follow-up of
// legend-f586w / legend-ypwsp). Written from the card brief, not the implementation.
// Spec (revised after the architect review):
//  - A device registry record from the cloud is ALWAYS applied to the replica's
//    `shared_mode` and `training_mode`, even when its `updatedAt` is older than the
//    replica row's `updated_at`: edge heartbeats write `updated_at` with the edge
//    clock, so the local row can be newer than a legitimate cloud record. Cloud
//    wins; the cursor already orders the pages. Equal or newer records apply too.
//  - A record flagged `sharedMode: true` for a device whose type is not `pos`
//    never leaves a flagged replica row (insert or update): `shared_mode` stays
//    false, because the cloud cannot produce that state.
//
// Same arrangement as edge-device-sync-shared-mode.test.ts: the "edge" database is
// the cloud database, so each test deletes the local row, applies a baseline
// record, forces the replica row to a known state with SQL, and applies the
// record under test.
//
// Assumptions:
//  - The local `updated_at` is set explicitly (millisecond precision) so "equal",
//    "older" and "newer" records are exact despite JS dates having no microseconds.
//  - `updated_at` after an older record is not asserted (only the flags are).
//  - Other fields of an older record (label, status, ...) are not asserted.
//  - Training mode is forced by SQL (`training_mode`); no training period row is
//    needed for the replica comparison.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendFixtures,
  outletIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { deviceSyncRecordSchema } from "@starter/shared/edge";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { enrollDevice } from "../services/device.service.ts";
import {
  applyDeviceRecords,
  listDeviceRecordsSince,
} from "../services/edge-device-sync.ts";

const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id as TenantId;
const outletA = outlets[0].id;
const actor = randomUUID();
const created: string[] = [];

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

const scoped = (source: "session" | "device"): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletA)] },
  );
const cloudScope = () => scoped("session");
const edgeScope = () => scoped("device");

const exportNow = () => ({
  now: new Date(Date.now() + 10 * 60_000),
  settleMs: 0,
});

type SyncRecord = ReturnType<typeof deviceSyncRecordSchema.parse>;
type Page = {
  data: unknown[];
  meta: { nextCursor: string | null };
};

async function pullAll(): Promise<SyncRecord[]> {
  const records: SyncRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const result = (await listDeviceRecordsSince(
      {
        tenantId,
        outletId: outletIdSchema.parse(outletA),
        edgeNodeId: randomUUID(),
      },
      { since: cursor, limit: 100 },
      exportNow(),
    )) as unknown as Page;
    records.push(...result.data.map((r) => deviceSyncRecordSchema.parse(r)));
    if (result.meta.nextCursor === null) break;
    cursor = result.meta.nextCursor;
  }
  return records;
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

type Replica = {
  shared_mode: boolean;
  training_mode: boolean;
  updated_at: Date;
};
const replicaOf = async (id: string): Promise<Replica> =>
  (
    await asOwner(
      "SELECT shared_mode, training_mode, updated_at FROM devices WHERE id = $1",
      [id],
    )
  ).rows[0];

async function forgetLocally(id: string) {
  await asOwner("DELETE FROM device_training_periods WHERE device_id = $1", [
    id,
  ]);
  await asOwner("DELETE FROM devices WHERE id = $1", [id]);
}

async function enroll(type: "pos" | "kds" = "pos") {
  const { device } = await enrollDevice(cloudScope(), actor, {
    outletId: outletA,
    type,
    label: `Kasir Basi ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  created.push(device.id);
  return device;
}

async function recordFor(deviceId: string): Promise<SyncRecord> {
  const record = (await pullAll()).find((r) => r.id === deviceId);
  if (!record) throw new Error("device record not exported");
  return record;
}

const isoPlus = (iso: string, ms: number) =>
  new Date(Date.parse(iso) + ms).toISOString();

/**
 * A POS replica row whose flags and `updated_at` are forced to a known state.
 * `updated_at` is the exported record's time plus one minute, in milliseconds.
 */
async function replicaWith(flags: {
  sharedMode: boolean;
  trainingMode: boolean;
}) {
  const device = await enroll("pos");
  const record = await recordFor(device.id);
  await forgetLocally(device.id);
  await applyDeviceRecords(edgeScope(), [
    { ...record, sharedMode: false, trainingMode: false },
  ]);
  const localAt = isoPlus(record.updatedAt, 60_000);
  await asOwner(
    "UPDATE devices SET shared_mode = $2, training_mode = $3, updated_at = $4::timestamptz WHERE id = $1",
    [device.id, flags.sharedMode, flags.trainingMode, localAt],
  );
  const before = await replicaOf(device.id);
  expect(before.shared_mode).toBe(flags.sharedMode);
  expect(before.training_mode).toBe(flags.trainingMode);
  expect(before.updated_at.toISOString()).toBe(localAt);
  return { device, record, localAt };
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  if (created.length > 0) {
    await asOwner(
      "DELETE FROM device_training_periods WHERE device_id = ANY($1::uuid[])",
      [created],
    );
    await asOwner("DELETE FROM devices WHERE id = ANY($1::uuid[])", [created]);
  }
  await owner.end();
});

describe("cloud wins even when the local row is newer: edge heartbeats move updated_at", () => {
  // A heartbeat on the edge writes updated_at with the edge clock, so the local
  // row can be newer than a perfectly valid cloud record. Regression guard: the
  // record is applied anyway (the cursor already orders the pages).
  const heartbeat = (id: string) =>
    asOwner(
      "UPDATE devices SET updated_at = now() + interval '1 hour' WHERE id = $1",
      [id],
    );

  it("an older sharedMode:false clears a local sharedMode:true", async () => {
    const { device, record, localAt } = await replicaWith({
      sharedMode: true,
      trainingMode: false,
    });
    await heartbeat(device.id);
    await applyDeviceRecords(edgeScope(), [
      {
        ...record,
        sharedMode: false,
        trainingMode: false,
        updatedAt: isoPlus(localAt, -1_000),
      },
    ]);
    expect((await replicaOf(device.id)).shared_mode).toBe(false);
  });

  it("an older sharedMode:true sets sharedMode on a local sharedMode:false", async () => {
    const { device, record, localAt } = await replicaWith({
      sharedMode: false,
      trainingMode: false,
    });
    await heartbeat(device.id);
    await applyDeviceRecords(edgeScope(), [
      {
        ...record,
        sharedMode: true,
        trainingMode: false,
        updatedAt: isoPlus(localAt, -1_000),
      },
    ]);
    expect((await replicaOf(device.id)).shared_mode).toBe(true);
  });

  it("an older trainingMode:false switches off a local training mode", async () => {
    const { device, record, localAt } = await replicaWith({
      sharedMode: false,
      trainingMode: true,
    });
    await heartbeat(device.id);
    await applyDeviceRecords(edgeScope(), [
      {
        ...record,
        sharedMode: false,
        trainingMode: false,
        updatedAt: isoPlus(localAt, -60_000),
      },
    ]);
    expect((await replicaOf(device.id)).training_mode).toBe(false);
  });

  it("an older trainingMode:true switches on training mode locally off", async () => {
    const { device, record, localAt } = await replicaWith({
      sharedMode: false,
      trainingMode: false,
    });
    await heartbeat(device.id);
    await applyDeviceRecords(edgeScope(), [
      {
        ...record,
        sharedMode: false,
        trainingMode: true,
        updatedAt: isoPlus(localAt, -3_600_000),
      },
    ]);
    expect((await replicaOf(device.id)).training_mode).toBe(true);
  });
});

describe("a record that is equal or newer applies (cloud wins)", () => {
  it("equal updatedAt applies the record's sharedMode and trainingMode", async () => {
    const { device, record, localAt } = await replicaWith({
      sharedMode: true,
      trainingMode: true,
    });
    await applyDeviceRecords(edgeScope(), [
      {
        ...record,
        sharedMode: false,
        trainingMode: false,
        updatedAt: localAt,
      },
    ]);
    const after = await replicaOf(device.id);
    expect(after.shared_mode).toBe(false);
    expect(after.training_mode).toBe(false);
  });

  it("a newer updatedAt applies the record's sharedMode and trainingMode", async () => {
    const { device, record, localAt } = await replicaWith({
      sharedMode: false,
      trainingMode: false,
    });
    const newer = isoPlus(localAt, 60_000);
    await applyDeviceRecords(edgeScope(), [
      { ...record, sharedMode: true, trainingMode: true, updatedAt: newer },
    ]);
    const after = await replicaOf(device.id);
    expect(after.shared_mode).toBe(true);
    expect(after.training_mode).toBe(true);
    expect(after.updated_at.toISOString()).toBe(newer);
  });
});

describe("a shared flag on a non-POS device never reaches the replica", () => {
  it("insert: a kds record flagged sharedMode:true creates a row with shared_mode false", async () => {
    const device = await enroll("kds");
    const record = await recordFor(device.id);
    expect(record.type).toBe("kds");
    await forgetLocally(device.id);

    await applyDeviceRecords(edgeScope(), [{ ...record, sharedMode: true }]);
    const row = await replicaOf(device.id);
    expect(row).toBeDefined();
    expect(row.shared_mode).toBe(false);
  });

  it("update: a newer kds record flagged sharedMode:true leaves shared_mode false", async () => {
    const device = await enroll("kds");
    const record = await recordFor(device.id);
    await forgetLocally(device.id);
    await applyDeviceRecords(edgeScope(), [{ ...record, sharedMode: false }]);
    expect((await replicaOf(device.id)).shared_mode).toBe(false);

    await applyDeviceRecords(edgeScope(), [
      {
        ...record,
        sharedMode: true,
        updatedAt: isoPlus(record.updatedAt, 60_000),
      },
    ]);
    expect((await replicaOf(device.id)).shared_mode).toBe(false);
  });

  it("a POS record flagged sharedMode:true still sets the flag (control)", async () => {
    const device = await enroll("pos");
    const record = await recordFor(device.id);
    await forgetLocally(device.id);

    await applyDeviceRecords(edgeScope(), [{ ...record, sharedMode: true }]);
    expect((await replicaOf(device.id)).shared_mode).toBe(true);
  });
});
