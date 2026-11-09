// legend-e087: a station's printerDeviceId must be an active printer device of
// the station's own outlet (same tenant). Unknown id, another outlet, another
// tenant, a non-printer and a revoked device all answer with one identical
// error, so the check is not an existence oracle. Real PostgreSQL and RLS.
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
import { createStation, updateStation } from "../services/menu.service";

const app = createApp();
const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
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

const createdStationIds: string[] = [];
const createdDevices: { tenantId: string; id: string }[] = [];
let roleId: string;
let userId: string;
let other: IsolatedTenant;

async function seedDevice(
  forTenant: string,
  outletId: string,
  type: string,
  revoked = false,
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(forTenant, (client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, status, revoked_at)
       VALUES ($1, $2, $3, $4, 'Uji printer', $5, $6)`,
      [
        id,
        forTenant,
        outletId,
        type,
        revoked ? "revoked" : "active",
        revoked ? new Date() : null,
      ],
    ),
  );
  createdDevices.push({ tenantId: forTenant, id });
  return id;
}

async function revoke(id: string) {
  await asOwnerTenant(tenantId, (client) =>
    client.query(
      "UPDATE devices SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [id],
    ),
  );
}

async function insertStation(printerDeviceId: string | null = null) {
  const result = await asOwnerTenant(tenantId, (client) =>
    client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type, printer_device_id)
       VALUES ($1, $2, $3, 'hot_kitchen', $4) RETURNING id`,
      [tenantId, outletA, `Uji ${randomUUID().slice(0, 8)}`, printerDeviceId],
    ),
  );
  createdStationIds.push(result.rows[0].id);
  return result.rows[0].id;
}

async function boundPrinter(stationId: string) {
  const { rows } = await asOwnerTenant(tenantId, (client) =>
    client.query<{ printer_device_id: string | null }>(
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

const INVALID = {
  status: 422,
  code: "VALIDATION_ERROR",
  message: "Printer tidak valid untuk outlet ini.",
};

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  roleId = randomUUID();
  await ownerPool.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, '["tenant","outlet"]'::jsonb)`,
    [
      roleId,
      tenantId,
      `Uji ${roleId.slice(0, 8)}`,
      JSON.stringify(["menu.item.view", "menu.item.manage"]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Station Printer User");
  const session = await client.get("/api/auth/get-session");
  userId = session.body.user.id as string;
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId],
  );
  other = await createIsolatedTenant(`printer-${randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
  if (createdStationIds.length > 0)
    await asOwnerTenant(tenantId, (client) =>
      client.query("DELETE FROM stations WHERE id = ANY($1::uuid[])", [
        createdStationIds,
      ]),
    );
  for (const device of createdDevices)
    await asOwnerTenant(device.tenantId, (client) =>
      client.query("DELETE FROM devices WHERE id = $1", [device.id]),
    );
  await ownerPool.query("DELETE FROM role_assignments WHERE user_id = $1", [
    userId,
  ]);
  await ownerPool.query("DELETE FROM roles WHERE id = $1", [roleId]);
  if (other) await dropIsolatedTenant(other);
  await ownerPool.end();
});

describe("legend-e087 station printerDeviceId", () => {
  it("accepts an active printer of the station's outlet on create and update", async () => {
    const printer = await seedDevice(tenantId, outletA, "printer");
    const created = await createStation(tenantContext(), userId, {
      outletId: outletA,
      name: `Uji ${randomUUID().slice(0, 8)}`,
      type: "hot_kitchen",
      printerDeviceId: printer,
    });
    createdStationIds.push(created.id);
    expect(created.printerDeviceId).toBe(printer);

    const stationId = await insertStation();
    const updated = await updateStation(tenantContext(), userId, stationId, {
      printerDeviceId: printer,
    });
    expect(updated.printerDeviceId).toBe(printer);
  });

  it("rejects every invalid printer with one identical error", async () => {
    const stationId = await insertStation();
    const invalid: Record<string, string> = {
      "another outlet": await seedDevice(tenantId, outletB, "printer"),
      "another tenant": await seedDevice(
        other.tenantId,
        other.outletId,
        "printer",
      ),
      "non-printer": await seedDevice(tenantId, outletA, "kds"),
      revoked: await seedDevice(tenantId, outletA, "printer", true),
      unknown: randomUUID(),
    };
    for (const [label, printerDeviceId] of Object.entries(invalid)) {
      await expect(
        updateStation(tenantContext(), userId, stationId, { printerDeviceId }),
        `update: ${label}`,
      ).rejects.toMatchObject(INVALID);
      await expect(
        createStation(tenantContext(), userId, {
          outletId: outletA,
          name: `Uji ${randomUUID().slice(0, 8)}`,
          type: "hot_kitchen",
          printerDeviceId,
        }),
        `create: ${label}`,
      ).rejects.toMatchObject(INVALID);
    }
    expect(await boundPrinter(stationId)).toBeNull();
  });

  it("does not re-validate an unchanged printer (echo), so target time still saves", async () => {
    const printer = await seedDevice(tenantId, outletA, "printer");
    const stationId = await insertStation(printer);
    await revoke(printer);
    const updated = await updateStation(tenantContext(), userId, stationId, {
      printerDeviceId: printer,
      targetSeconds: 321,
    });
    expect(updated.targetSeconds).toBe(321);
    expect(updated.printerDeviceId).toBe(printer);
  });

  it("null unbinds", async () => {
    const printer = await seedDevice(tenantId, outletA, "printer");
    const stationId = await insertStation(printer);
    const updated = await updateStation(tenantContext(), userId, stationId, {
      printerDeviceId: null,
    });
    expect(updated.printerDeviceId).toBeNull();
    expect(await boundPrinter(stationId)).toBeNull();
  });
});
