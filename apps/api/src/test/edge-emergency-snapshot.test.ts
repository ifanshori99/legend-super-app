// Emergency mappings remain local while offline and only a validated snapshot
// from this node's scope can change them.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { mintEdgeCredential } from "../edge/credential.ts";
import { cloudGetJson } from "../edge/cloud-http.ts";
import { pullFacilitySnapshotOnce } from "../edge/facility-snapshot-pull.ts";
vi.mock("../edge/cloud-http.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../edge/cloud-http.ts")>()),
  cloudGetJson: vi.fn(),
}));
const { tenant, outlets } = cafeLegendPlatformFixtures;
const [outlet, other] = outlets;
const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const facilityId = randomUUID(),
  areaId = randomUUID(),
  unitId = randomUUID(),
  deviceId = randomUUID();
const credential = mintEdgeCredential({
  tenantId: tenant.id,
  outletId: outlet.id,
  edgeNodeId: randomUUID(),
}).token;
const config = { cloudUrl: "wss://example.test/api/edge-link", credential };
const stamp = new Date().toISOString();
const snapshot = {
  tenantId: tenant.id,
  outletId: outlet.id,
  facilities: [
    {
      id: facilityId,
      tenantId: tenant.id,
      outletId: outlet.id,
      name: "Snapshot",
      type: "shower",
      sessionMinutes: 20,
      cleaningMinutes: 10,
      arrivalGraceMinutes: 10,
      operatingHours: [
        {
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          opensAt: "00:00",
          closesAt: "23:59",
        },
      ],
      overtimePolicy: {
        graceMinutes: 5,
        blockMinutes: 15,
        feePerBlockIdr: 5000,
      },
      cancellationPolicy: {
        freeCancelMinutesBefore: 30,
        lateCancelResolution: "no_refund",
        lateCancelFeeIdr: 0,
        noShowResolution: "no_refund",
      },
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  areas: [
    {
      id: areaId,
      tenantId: tenant.id,
      outletId: outlet.id,
      facilityId,
      name: "Area",
      entranceLockDeviceId: null,
      sortOrder: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
  units: [
    {
      id: unitId,
      tenantId: tenant.id,
      outletId: outlet.id,
      facilityId,
      areaId,
      code: "P1",
      lockDeviceId: null,
      panicDeviceId: deviceId,
      status: "available",
      sortOrder: 0,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ],
};
async function scoped<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.tenant_id',$1,true), set_config('app.outlet_ids','*',true)",
      [tenant.id],
    );
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function mapping() {
  const r = await scoped((c) =>
    c.query(
      "SELECT panic_device_id FROM facility_units WHERE tenant_id=$1 AND id=$2",
      [tenant.id, unitId],
    ),
  );
  return r.rows[0]?.panic_device_id;
}
beforeAll(async () => {
  await scoped((c) =>
    c.query(
      "INSERT INTO devices (id,tenant_id,outlet_id,type,label) VALUES ($1,$2,$3,'panic_button','Snapshot device')",
      [deviceId, tenant.id, outlet.id],
    ),
  );
});
afterAll(async () => {
  await scoped(async (c) => {
    await c.query("DELETE FROM facility_units WHERE tenant_id=$1 AND id=$2", [
      tenant.id,
      unitId,
    ]);
    await c.query("DELETE FROM facility_areas WHERE tenant_id=$1 AND id=$2", [
      tenant.id,
      areaId,
    ]);
    await c.query("DELETE FROM facilities WHERE tenant_id=$1 AND id=$2", [
      tenant.id,
      facilityId,
    ]);
    await c.query("DELETE FROM devices WHERE tenant_id=$1 AND id=$2", [
      tenant.id,
      deviceId,
    ]);
  });
  await pool.end();
});
describe("edge facility snapshot", () => {
  it("retains last mapping if offline or a snapshot has a different outlet or duplicate device", async () => {
    vi.mocked(cloudGetJson).mockResolvedValueOnce(snapshot);
    await pullFacilitySnapshotOnce(config);
    expect(await mapping()).toBe(deviceId);
    vi.mocked(cloudGetJson).mockRejectedValueOnce(new Error("offline"));
    await expect(pullFacilitySnapshotOnce(config)).rejects.toThrow();
    expect(await mapping()).toBe(deviceId);
    vi.mocked(cloudGetJson).mockResolvedValueOnce({
      ...snapshot,
      outletId: other.id,
    });
    await expect(pullFacilitySnapshotOnce(config)).rejects.toThrow();
    expect(await mapping()).toBe(deviceId);
    vi.mocked(cloudGetJson).mockResolvedValueOnce({
      ...snapshot,
      units: [
        ...snapshot.units,
        { ...snapshot.units[0], id: randomUUID(), code: "P2" },
      ],
    });
    await expect(pullFacilitySnapshotOnce(config)).rejects.toThrow();
    expect(await mapping()).toBe(deviceId);
  });
  it("detaches a removed mapping without deleting the historical unit", async () => {
    vi.mocked(cloudGetJson).mockResolvedValueOnce({ ...snapshot, units: [] });
    await pullFacilitySnapshotOnce(config);
    expect(await mapping()).toBeNull();
  });
});
