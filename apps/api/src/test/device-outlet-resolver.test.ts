// Production device -> outlet resolver (bead legend-obh5, from legend-dxb;
// PRD v1.7 §3 F5 "Registri Perangkat", §3 F6 "PIN pada perangkat terdaftar",
// TEN-02/TEN-03). Unit tests drive the rules through an injected registry
// lookup; integration tests run the default lookup and the device pin verify
// on the disposable PostgreSQL.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { setAuditWriter } from "../services/audit-writer.ts";
import {
  createDeviceOutletResolver,
  devicesTableLookup,
  type DeviceRegistryEntry,
} from "../services/device-outlet-resolver.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
  verifyStaffPinOnDevice,
} from "../services/device-pin.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const bandung = cafeLegendAccessFixtures.outletIds.bandung;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const createdUserIds: string[] = [];
const PIN = "582914";

function entry(patch: Partial<DeviceRegistryEntry> = {}): DeviceRegistryEntry {
  return {
    tenantId,
    outletId: bandung,
    type: "pos",
    status: "active",
    revokedAt: null,
    outletStatus: "active",
    ...patch,
  };
}

const resolverWith = (entries: readonly DeviceRegistryEntry[]) =>
  createDeviceOutletResolver({ lookup: async () => entries });

beforeAll(() => {
  setAuditWriter({ record: async () => {} });
});

afterAll(async () => {
  setAuditWriter(null);
  setDeviceOutletResolver(null);
  await owner.query(
    `DELETE FROM staff_pins WHERE tenant_id = $1 AND user_id = ANY($2::text[])`,
    [tenantId, createdUserIds],
  );
  await owner.query(
    "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
    [tenantId, createdUserIds],
  );
  await owner.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [
    createdUserIds,
  ]);
  await owner.end();
});

describe("legend-obh5 device outlet resolver rules (fail closed)", () => {
  const deviceId = randomUUID();

  it("legend-obh5 §3 F6 an active, unrevoked staff terminal of this tenant at an open outlet resolves to that outlet", async () => {
    for (const type of ["pos", "kds", "waiter_phone"])
      expect(
        await resolverWith([entry({ type })])({ tenantId, deviceId }),
      ).toBe(bandung);
    expect(
      await resolverWith([entry({ outletStatus: "preopening" })])({
        tenantId,
        deviceId,
      }),
    ).toBe(bandung);
  });

  it("legend-obh5 §3 F5 unknown, revoked, peripheral and ambiguous devices resolve to no outlet", async () => {
    const denied: DeviceRegistryEntry[][] = [
      [],
      [entry({ status: "revoked", revokedAt: new Date() })],
      [entry({ revokedAt: new Date() })],
      [entry({ status: "pending" })],
      [entry({ type: "printer" })],
      [entry({ type: "edc" })],
      [entry({ type: "smart_lock" })],
      [entry({ type: "unknown" })],
      [entry(), entry()],
      [entry({ outletStatus: "closed" })],
      [entry({ outletStatus: null })],
      [entry({ outletId: "not-an-outlet" })],
    ];
    for (const entries of denied)
      expect(await resolverWith(entries)({ tenantId, deviceId })).toBeNull();
  });

  it("legend-obh5 TEN-02 a registry row of another tenant, a malformed id or a failing lookup resolves to no outlet", async () => {
    expect(
      await resolverWith([entry({ tenantId: randomUUID() })])({
        tenantId,
        deviceId,
      }),
    ).toBeNull();
    const lookup = vi.fn(async () => [entry()]);
    const resolver = createDeviceOutletResolver({ lookup });
    expect(await resolver({ tenantId, deviceId: "not-a-uuid" })).toBeNull();
    expect(await resolver({ tenantId: "nope", deviceId })).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    const failing = createDeviceOutletResolver({
      lookup: async () => {
        throw new Error("registry down");
      },
    });
    expect(await failing({ tenantId, deviceId })).toBeNull();
  });
});

describe("legend-obh5 device outlet resolver wiring", () => {
  it("legend-obh5 TEN-02 the default registry lookup knows no unregistered device", async () => {
    expect(
      await devicesTableLookup({ tenantId, deviceId: randomUUID() }),
    ).toEqual([]);
    expect(
      await createDeviceOutletResolver()({ tenantId, deviceId: randomUUID() }),
    ).toBeNull();
  });

  it("legend-obh5 §3 F6 installed with setDeviceOutletResolver, a registered terminal switches user and an unregistered one is refused", async () => {
    const user = randomUUID();
    await owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Staf resolver', $2)`,
      [user, `${user}@example.test`],
    );
    createdUserIds.push(user);
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM roles WHERE tenant_id = $1 AND template_key = 'cashier'",
      [tenantId],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 hour', $2)`,
      [tenantId, user, rows[0]?.id, bandung],
    );
    const tenant = establishTenantContext({
      tenantId,
      brandId: null,
      source: "session",
    });
    await setStaffPin(
      tenant,
      user,
      { outletId: bandung, userId: user },
      { pin: PIN },
    );
    const registered = randomUUID();
    setDeviceOutletResolver(
      createDeviceOutletResolver({
        lookup: async ({ deviceId }) =>
          deviceId === registered ? [entry()] : [],
      }),
    );
    const deviceTenant = establishTenantContext({
      tenantId,
      brandId: null,
      source: "device",
    });
    const result = await verifyStaffPinOnDevice(deviceTenant, {
      deviceId: registered,
      userId: user,
      pin: PIN,
    });
    expect(result).toMatchObject({ outletId: bandung, user: { id: user } });
    await expect(
      verifyStaffPinOnDevice(deviceTenant, {
        deviceId: randomUUID(),
        userId: user,
        pin: PIN,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
