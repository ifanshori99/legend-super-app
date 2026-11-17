// Shared-device flag on the edge replica (legend-f586w, legend-ypwsp, round C).
// Spec: the device registry record the cloud replicates to an edge node carries
// `sharedMode` (cloud wins, like every registry field). The edge replica must
// copy it on insert and on update, otherwise an edge node would never guard a
// shared device. Contract: `deviceSyncRecordSchema` (packages/shared/src/edge/
// schemas.ts) gets `sharedMode: z.boolean().optional()`; absent means false, so
// records from older clouds still parse.
//
// Same arrangement as device-edge.test.ts: the "edge" database is the cloud
// database, so apply tests delete the local row first and then apply records
// the way a pull would.
//
// Assumptions:
//  - Exported records always carry an explicit boolean `sharedMode`.
//  - A record without `sharedMode` inserts a replica row with shared_mode false.
//    What an UPDATE does with an absent field is not specified, so it is not
//    asserted here.
//  - A non-boolean `sharedMode` is a contract violation (the record is refused).
//  - Old edge nodes with a strict record schema must be upgraded before the cloud
//    starts sending the field (deployment note, not tested).
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

const sharedModeOf = async (id: string): Promise<boolean | undefined> =>
  (await asOwner("SELECT shared_mode FROM devices WHERE id = $1", [id])).rows[0]
    ?.shared_mode;

async function forgetLocally(id: string) {
  await asOwner("DELETE FROM device_training_periods WHERE device_id = $1", [
    id,
  ]);
  await asOwner("DELETE FROM devices WHERE id = $1", [id]);
}

async function enroll() {
  const { device } = await enrollDevice(cloudScope(), actor, {
    outletId: outletA,
    type: "pos",
    label: `Kasir Bersama ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  return device;
}

async function recordFor(deviceId: string): Promise<SyncRecord> {
  const record = (await pullAll()).find((r) => r.id === deviceId);
  if (!record) throw new Error("device record not exported");
  return record;
}

const isoPlus = (iso: string, ms: number) =>
  new Date(Date.parse(iso) + ms).toISOString();

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setAuditWriter(null);
  await owner.end();
});

describe("shared mode in the device registry record", () => {
  it("the exported record carries sharedMode: false for a new device and true once flagged", async () => {
    const device = await enroll();
    expect((await recordFor(device.id)).sharedMode).toBe(false);

    await asOwner(
      "UPDATE devices SET shared_mode = true, updated_at = clock_timestamp() WHERE id = $1",
      [device.id],
    );
    expect((await recordFor(device.id)).sharedMode).toBe(true);
  });

  it("a record whose sharedMode is not a boolean is refused", async () => {
    const device = await enroll();
    const record = await recordFor(device.id);
    expect(
      deviceSyncRecordSchema.safeParse({ ...record, sharedMode: "yes" })
        .success,
    ).toBe(false);
    expect(
      deviceSyncRecordSchema.safeParse({ ...record, sharedMode: null }).success,
    ).toBe(false);
  });

  it("an exported record with sharedMode removed parses (absent = false)", async () => {
    const device = await enroll();
    const record = await recordFor(device.id);
    const older: Partial<typeof record> = { ...record };
    delete older.sharedMode;
    const parsed = deviceSyncRecordSchema.safeParse(older);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });
});

describe("the edge replica copies sharedMode", () => {
  it("insert: a record flagged shared creates a replica row with shared_mode true", async () => {
    const device = await enroll();
    const record = await recordFor(device.id);
    await forgetLocally(device.id);

    await applyDeviceRecords(edgeScope(), [{ ...record, sharedMode: true }]);
    expect(await sharedModeOf(device.id)).toBe(true);
  });

  it("insert: an unflagged record creates a replica row with shared_mode false", async () => {
    const device = await enroll();
    const record = await recordFor(device.id);
    await forgetLocally(device.id);

    await applyDeviceRecords(edgeScope(), [{ ...record, sharedMode: false }]);
    expect(await sharedModeOf(device.id)).toBe(false);
  });

  it("insert: a record without the field (older cloud) creates the row unflagged", async () => {
    const device = await enroll();
    const record = await recordFor(device.id);
    await forgetLocally(device.id);

    const older: Partial<typeof record> = { ...record };
    delete older.sharedMode;
    await applyDeviceRecords(edgeScope(), [older as typeof record]);
    expect(await sharedModeOf(device.id)).toBe(false);
  });

  it("update: a newer record switches the replica flag on and back off (cloud wins)", async () => {
    const device = await enroll();
    const record = await recordFor(device.id);
    await forgetLocally(device.id);
    await applyDeviceRecords(edgeScope(), [{ ...record, sharedMode: false }]);
    expect(await sharedModeOf(device.id)).toBe(false);

    await applyDeviceRecords(edgeScope(), [
      {
        ...record,
        sharedMode: true,
        updatedAt: isoPlus(record.updatedAt, 60_000),
      },
    ]);
    expect(await sharedModeOf(device.id)).toBe(true);

    await applyDeviceRecords(edgeScope(), [
      {
        ...record,
        sharedMode: false,
        updatedAt: isoPlus(record.updatedAt, 120_000),
      },
    ]);
    expect(await sharedModeOf(device.id)).toBe(false);
  });
});
