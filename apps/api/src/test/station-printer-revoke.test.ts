// legend-4xai (Codex 159): revoking a printer device clears every station
// binding to it in the same transaction, so no station keeps pointing at a
// revoked printer. Real PostgreSQL and RLS.
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app";
import { agent, signUp } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  type IsolatedTenant,
} from "./floor-test-helpers";
import { revokeDevice } from "../services/device.service";
import { updateStation } from "../services/menu.service";

const app = createApp();
const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 3,
});

async function asOwnerTenant<T>(
  tenantOfRows: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantOfRows],
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

const runTag = randomUUID().slice(0, 8);
const stationName = () => `Uji ${runTag} ${randomUUID().slice(0, 8)}`;
const createdStationIds: { tenantId: string; id: string }[] = [];
const createdDevices: { tenantId: string; id: string }[] = [];
let roleId: string;
let userId: string;
let other: IsolatedTenant;
let client: ReturnType<typeof agent>;

const outletScope = (outletId: string) =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletId as never] },
  );

async function seedPrinter(
  forTenant: string,
  outletId: string,
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(forTenant, (c) =>
    c.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, status)
       VALUES ($1, $2, $3, 'printer', 'Uji printer', 'active')`,
      [id, forTenant, outletId],
    ),
  );
  createdDevices.push({ tenantId: forTenant, id });
  return id;
}

async function insertStation(
  forTenant: string,
  outletId: string,
  printerDeviceId: string | null,
) {
  const result = await asOwnerTenant(forTenant, (c) =>
    c.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type, printer_device_id)
       VALUES ($1, $2, $3, 'hot_kitchen', $4) RETURNING id`,
      [forTenant, outletId, stationName(), printerDeviceId],
    ),
  );
  createdStationIds.push({ tenantId: forTenant, id: result.rows[0].id });
  return result.rows[0].id;
}

async function boundPrinter(forTenant: string, stationId: string) {
  const { rows } = await asOwnerTenant(forTenant, (c) =>
    c.query<{ printer_device_id: string | null }>(
      "SELECT printer_device_id FROM stations WHERE id = $1",
      [stationId],
    ),
  );
  return rows[0].printer_device_id;
}

const tenantContext = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

async function stationStamp(stationId: string) {
  const { rows } = await asOwnerTenant(tenantId, (c) =>
    c.query<{ updated_at: Date }>(
      "SELECT updated_at FROM stations WHERE id = $1",
      [stationId],
    ),
  );
  return rows[0].updated_at.toISOString();
}

async function waitForLockWait(queryPattern: string, label: string) {
  let waiting = false;
  for (let i = 0; i < 100 && !waiting; i++) {
    const { rows } = await ownerPool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE $1`,
      [queryPattern],
    );
    waiting = rows.length > 0;
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(waiting, label).toBe(true);
}

const revoke = (deviceId: string) =>
  revokeDevice(outletScope(outletA), userId, { deviceId, reason: "Uji" });

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  roleId = randomUUID();
  await ownerPool.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, '["tenant","outlet","station"]'::jsonb)`,
    [
      roleId,
      tenantId,
      `Uji ${roleId.slice(0, 8)}`,
      JSON.stringify(["menu.item.view", "menu.item.manage"]),
    ],
  );
  client = agent(app);
  await signUp(client, "Station Revoke User");
  const session = await client.get("/api/auth/get-session");
  userId = session.body.user.id as string;
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  other = await createIsolatedTenant(`revoke-${randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
  for (const station of createdStationIds)
    await asOwnerTenant(station.tenantId, (c) =>
      c.query("DELETE FROM stations WHERE id = $1", [station.id]),
    );
  for (const device of createdDevices)
    await asOwnerTenant(device.tenantId, (c) =>
      c.query("DELETE FROM devices WHERE id = $1", [device.id]),
    );
  await ownerPool.query("DELETE FROM role_assignments WHERE user_id = $1", [
    userId,
  ]);
  await ownerPool.query("DELETE FROM roles WHERE id = $1", [roleId]);
  if (other) await dropIsolatedTenant(other);
  await ownerPool.end();
});

describe("legend-4xai revoking a printer clears station bindings", () => {
  it("a station bound to the revoked printer reads null from the API and the DB", async () => {
    const printer = await seedPrinter(tenantId, outletA);
    const stationId = await insertStation(tenantId, outletA, printer);
    await revoke(printer);

    expect(await boundPrinter(tenantId, stationId)).toBeNull();
    const list = await client.get(
      `/api/menu/stations?outletId=${outletA}&limit=100`,
    );
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const row = (list.body.data as { id: string }[]).find(
      (s) => s.id === stationId,
    ) as { printerDeviceId: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.printerDeviceId).toBeNull();
  });

  it("a revoke that waits behind a create's printer share lock still clears the new binding", async () => {
    const printer = await seedPrinter(tenantId, outletA);
    // The create transaction: device FOR SHARE, then the station insert, not
    // yet committed (same lock order as createStation).
    const creator = await ownerPool.connect();
    let revoking: ReturnType<typeof revoke>;
    let stationId: string;
    try {
      await creator.query("BEGIN");
      await creator.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await creator.query("SELECT id FROM devices WHERE id = $1 FOR SHARE", [
        printer,
      ]);
      const inserted = await creator.query<{ id: string }>(
        `INSERT INTO stations (tenant_id, outlet_id, name, type, printer_device_id)
         VALUES ($1, $2, $3, 'hot_kitchen', $4) RETURNING id`,
        [tenantId, outletA, stationName(), printer],
      );
      stationId = inserted.rows[0].id;
      createdStationIds.push({ tenantId, id: stationId });

      revoking = revoke(printer);
      revoking.catch(() => undefined);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const { rows } = await ownerPool.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE '%from "devices"%for update%'`,
        );
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting, "revoke is waiting on the device lock").toBe(true);
      await creator.query("COMMIT");
    } catch (error) {
      await creator.query("ROLLBACK");
      throw error;
    } finally {
      creator.release();
    }

    await revoking;
    expect(await boundPrinter(tenantId, stationId)).toBeNull();
  });

  it("revoking another printer leaves unrelated bindings intact", async () => {
    const revoked = await seedPrinter(tenantId, outletA);
    const kept = await seedPrinter(tenantId, outletA);
    const boundToKept = await insertStation(tenantId, outletA, kept);
    const unbound = await insertStation(tenantId, outletA, null);
    const boundToRevoked = await insertStation(tenantId, outletA, revoked);
    await revoke(revoked);

    expect(await boundPrinter(tenantId, boundToKept)).toBe(kept);
    expect(await boundPrinter(tenantId, unbound)).toBeNull();
    expect(await boundPrinter(tenantId, boundToRevoked)).toBeNull();
  });

  it("revoking another tenant's device is refused and touches nothing", async () => {
    const foreign = await seedPrinter(other.tenantId, other.outletId);
    const foreignStation = await insertStation(
      other.tenantId,
      other.outletId,
      foreign,
    );
    const own = await seedPrinter(tenantId, outletA);
    const ownStation = await insertStation(tenantId, outletA, own);

    await expect(revoke(foreign)).rejects.toBeDefined();

    expect(await boundPrinter(other.tenantId, foreignStation)).toBe(foreign);
    expect(await boundPrinter(tenantId, ownStation)).toBe(own);
  });

  // legend-4xai (Codex 159): updateStation takes the device FOR SHARE, then
  // writes the station. A revoke of the same printer must wait for that and
  // then clear the binding the update just wrote.
  it("a revoke that waits behind an update's printer share lock still clears the new binding", async () => {
    const printer = await seedPrinter(tenantId, outletA);
    const stationId = await insertStation(tenantId, outletA, null);
    const stamp = await stationStamp(stationId);

    // Holder keeps the station row locked without changing it, so the
    // update below takes its device share lock and then blocks on the
    // station write. Assumption: updateStation locks the device before the
    // station row (same order the create path uses).
    const holder = await ownerPool.connect();
    let updating: ReturnType<typeof updateStation>;
    let revoking: ReturnType<typeof revoke>;
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await holder.query("SELECT id FROM stations WHERE id = $1 FOR UPDATE", [
        stationId,
      ]);

      updating = updateStation(tenantContext(), userId, stationId, {
        printerDeviceId: printer,
        expectedUpdatedAt: stamp,
      });
      updating.catch(() => undefined);
      await waitForLockWait(
        'update "stations"%',
        "update write is waiting on the station row lock",
      );

      revoking = revoke(printer);
      revoking.catch(() => undefined);
      await waitForLockWait(
        '%from "devices"%for update%',
        "revoke is waiting on the device share lock",
      );
      await holder.query("COMMIT");
    } catch (error) {
      await holder.query("ROLLBACK");
      throw error;
    } finally {
      holder.release();
    }

    await updating;
    await revoking;
    expect(await boundPrinter(tenantId, stationId)).toBeNull();
  });
});
