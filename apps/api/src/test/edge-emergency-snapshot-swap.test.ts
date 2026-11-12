// Emergency mappings remain local while offline and only a validated snapshot
// from this node's scope can change them.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { mintEdgeCredential } from "../edge/credential.ts";
import { cloudGetJson } from "../edge/cloud-http.ts";
import { pullFacilitySnapshotOnce } from "../edge/facility-snapshot-pull.ts";
vi.mock("../edge/cloud-http.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../edge/cloud-http.ts")>()),
  cloudGetJson: vi.fn(),
}));
const { tenant, outlets } = cafeLegendPlatformFixtures;
const outlet = outlets[1];
const pool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const facilityId = randomUUID(),
  areaId = randomUUID(),
  unitId = randomUUID(),
  deviceId = randomUUID();
const area2 = randomUUID(),
  unit2 = randomUUID(),
  tombstone = randomUUID(),
  incidentId = randomUUID();
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
    await c.query(
      "DELETE FROM facility_incidents WHERE tenant_id=$1 AND id=$2",
      [tenant.id, incidentId],
    );
    await c.query(
      "DELETE FROM facility_units WHERE tenant_id=$1 AND facility_id=$2",
      [tenant.id, facilityId],
    );
    await c.query(
      "DELETE FROM facility_areas WHERE tenant_id=$1 AND facility_id=$2",
      [tenant.id, facilityId],
    );
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
it("applies swapped area names and unit codes, preserving a removed incident unit", async () => {
  const original = {
    ...snapshot,
    areas: [
      snapshot.areas[0],
      { ...snapshot.areas[0], id: area2, name: "Area B" },
    ],
    units: [
      snapshot.units[0],
      {
        ...snapshot.units[0],
        id: unit2,
        areaId: area2,
        code: "P2",
        panicDeviceId: null,
      },
      { ...snapshot.units[0], id: tombstone, code: "P3", panicDeviceId: null },
    ],
  };
  vi.mocked(cloudGetJson).mockResolvedValueOnce(original);
  await pullFacilitySnapshotOnce(config);
  await scoped((c) =>
    c.query(
      "INSERT INTO facility_incidents (id,tenant_id,outlet_id,facility_id,unit_id,type,triggered_at) VALUES ($1,$2,$3,$4,$5,'panic',now())",
      [incidentId, tenant.id, outlet.id, facilityId, tombstone],
    ),
  );
  const swapped = {
    ...original,
    areas: [
      { ...original.areas[0], name: "Area B" },
      { ...original.areas[1], name: "Area" },
    ],
    units: [
      { ...original.units[0], code: "P2", panicDeviceId: null },
      { ...original.units[1], code: "P1", panicDeviceId: deviceId },
    ],
  };
  vi.mocked(cloudGetJson).mockResolvedValueOnce(swapped);
  await pullFacilitySnapshotOnce(config);
  const rows = await scoped((c) =>
    c.query(
      "SELECT id,code,panic_device_id FROM facility_units WHERE tenant_id=$1 AND facility_id=$2",
      [tenant.id, facilityId],
    ),
  );
  expect(rows.rows).toEqual(
    expect.arrayContaining([
      { id: unitId, code: "P2", panic_device_id: null },
      { id: unit2, code: "P1", panic_device_id: deviceId },
    ]),
  );
  expect(rows.rows.some((row) => row.id === tombstone)).toBe(true);
  const areas = await scoped((c) =>
    c.query(
      "SELECT id,name FROM facility_areas WHERE tenant_id=$1 AND facility_id=$2",
      [tenant.id, facilityId],
    ),
  );
  expect(areas.rows).toEqual(
    expect.arrayContaining([
      { id: areaId, name: "Area B" },
      { id: area2, name: "Area" },
    ]),
  );
});
