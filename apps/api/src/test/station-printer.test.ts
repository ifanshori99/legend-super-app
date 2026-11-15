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
import { agent, originHeader, signUp } from "./helpers";
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

// Every station of this file carries runTag in its name, so afterAll removes
// them by outlet even when a should-be-refused test created one by mistake.
const runTag = randomUUID().slice(0, 8);
const stationName = () => `Uji ${runTag} ${randomUUID().slice(0, 8)}`;
const createdStationIds: string[] = [];
const createdUserIds: string[] = [];
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
      [tenantId, outletA, stationName(), printerDeviceId],
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

async function stationStamp(stationId: string) {
  const { rows } = await asOwnerTenant(tenantId, (client) =>
    client.query<{ updated_at: Date }>(
      "SELECT updated_at FROM stations WHERE id = $1",
      [stationId],
    ),
  );
  return rows[0].updated_at.toISOString();
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

const STALE = {
  status: 409,
  code: "CONFLICT",
  message: "Stasiun sudah diubah orang lain. Muat ulang lalu coba lagi.",
};

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
  if (createdUserIds.length > 0)
    await ownerPool.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  await asOwnerTenant(tenantId, (client) =>
    client.query(
      `DELETE FROM stations
        WHERE id = ANY($1::uuid[])
           OR (outlet_id = ANY($2::uuid[]) AND name LIKE $3)`,
      [createdStationIds, [outletA, outletB], `Uji ${runTag} %`],
    ),
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

/** Signed-in client holding the role at one station only. */
async function stationClient(stationId: string) {
  const client = agent(app);
  await signUp(client, "Station Printer Cook");
  const session = await client.get("/api/auth/get-session");
  const cookId = session.body.user.id as string;
  createdUserIds.push(cookId);
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'station', $4, now() - interval '1 minute', $2)`,
    [tenantId, cookId, roleId, stationId],
  );
  return client;
}

describe("legend-e087 station printerDeviceId", () => {
  it("accepts an active printer of the station's outlet on create and update", async () => {
    const printer = await seedDevice(tenantId, outletA, "printer");
    const created = await createStation(tenantContext(), userId, {
      outletId: outletA,
      name: stationName(),
      type: "hot_kitchen",
      printerDeviceId: printer,
    });
    createdStationIds.push(created.id);
    expect(created.printerDeviceId).toBe(printer);

    const stationId = await insertStation();
    const updated = await updateStation(tenantContext(), userId, stationId, {
      printerDeviceId: printer,
      expectedUpdatedAt: await stationStamp(stationId),
    });
    expect(updated.printerDeviceId).toBe(printer);
  });

  it("rejects every invalid printer with one identical error", async () => {
    const stationId = await insertStation();
    const expectedUpdatedAt = await stationStamp(stationId);
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
        updateStation(tenantContext(), userId, stationId, {
          printerDeviceId,
          expectedUpdatedAt,
        }),
        `update: ${label}`,
      ).rejects.toMatchObject(INVALID);
      await expect(
        createStation(tenantContext(), userId, {
          outletId: outletA,
          name: stationName(),
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
      expectedUpdatedAt: await stationStamp(stationId),
    });
    expect(updated.targetSeconds).toBe(321);
    expect(updated.printerDeviceId).toBe(printer);
  });

  it("null unbinds", async () => {
    const printer = await seedDevice(tenantId, outletA, "printer");
    const stationId = await insertStation(printer);
    const updated = await updateStation(tenantContext(), userId, stationId, {
      printerDeviceId: null,
      expectedUpdatedAt: await stationStamp(stationId),
    });
    expect(updated.printerDeviceId).toBeNull();
    expect(await boundPrinter(stationId)).toBeNull();
  });

  it("a station-scoped caller binds a printer of its own outlet but not another outlet's", async () => {
    const own = await seedDevice(tenantId, outletA, "printer");
    const foreign = await seedDevice(tenantId, outletB, "printer");
    const stationId = await insertStation();
    const cook = await stationClient(stationId);
    const url = `/api/menu/stations/${stationId}`;

    const ok = await cook
      .patch(url)
      .set(originHeader)
      .send({
        printerDeviceId: own,
        expectedUpdatedAt: await stationStamp(stationId),
      });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await boundPrinter(stationId)).toBe(own);

    const refused = await cook
      .patch(url)
      .set(originHeader)
      .send({
        printerDeviceId: foreign,
        expectedUpdatedAt: await stationStamp(stationId),
      });
    expect(refused.status).toBe(INVALID.status);
    expect(refused.body.error).toMatchObject({
      code: INVALID.code,
      message: INVALID.message,
    });
    expect(await boundPrinter(stationId)).toBe(own);
  });

  it("an echo of a revoked stored printer is refused (409) over a concurrent change", async () => {
    const pOld = await seedDevice(tenantId, outletA, "printer");
    const pNew = await seedDevice(tenantId, outletA, "printer");
    const stationId = await insertStation(pOld);
    await revoke(pOld);
    const staleStamp = await stationStamp(stationId);

    // A manager's change to pNew is in flight (row locked, not committed).
    const manager = await ownerPool.connect();
    let echo: ReturnType<typeof updateStation>;
    try {
      await manager.query("BEGIN");
      await manager.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenantId],
      );
      await manager.query(
        "UPDATE stations SET printer_device_id = $2, updated_at = now() WHERE id = $1",
        [stationId, pNew],
      );
      // The cook's stale form still shows pOld. The service reads pOld, then
      // its write waits on the manager's row lock.
      echo = updateStation(tenantContext(), userId, stationId, {
        printerDeviceId: pOld,
        targetSeconds: 123,
        expectedUpdatedAt: staleStamp,
      });
      echo.catch(() => undefined);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        const { rows } = await ownerPool.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query ILIKE 'update "stations"%'`,
        );
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting, "echo write is waiting on the row lock").toBe(true);
      await manager.query("COMMIT");
    } catch (error) {
      await manager.query("ROLLBACK");
      throw error;
    } finally {
      manager.release();
    }

    await expect(echo).rejects.toMatchObject(STALE);
    expect(await boundPrinter(stationId)).toBe(pNew);
  });

  it("differently cased echo of the stored printer is unchanged, not revalidated", async () => {
    const printer = await seedDevice(tenantId, outletA, "printer");
    const stationId = await insertStation(printer);
    await revoke(printer);
    const updated = await updateStation(tenantContext(), userId, stationId, {
      printerDeviceId: printer.toUpperCase(),
      targetSeconds: 77,
      expectedUpdatedAt: await stationStamp(stationId),
    });
    expect(updated.targetSeconds).toBe(77);
    expect(await boundPrinter(stationId)).toBe(printer);
  });

  // legend-4xai finding 2: a stale form must not write over a newer change.
  it("a stale form (old printer + target time) gets 409 and leaves the newer printer", async () => {
    const p = await seedDevice(tenantId, outletA, "printer");
    const q = await seedDevice(tenantId, outletA, "printer");
    const stationId = await insertStation(p);
    const t0 = await stationStamp(stationId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const byManager = await updateStation(tenantContext(), userId, stationId, {
      printerDeviceId: q,
      expectedUpdatedAt: t0,
    });
    expect(byManager.printerDeviceId).toBe(q);
    expect(byManager.updatedAt).not.toBe(t0);

    await expect(
      updateStation(tenantContext(), userId, stationId, {
        printerDeviceId: p,
        targetSeconds: 999,
        expectedUpdatedAt: t0,
      }),
    ).rejects.toMatchObject(STALE);
    expect(await boundPrinter(stationId)).toBe(q);
    const { rows } = await asOwnerTenant(tenantId, (client) =>
      client.query<{ target_seconds: number | null }>(
        "SELECT target_seconds FROM stations WHERE id = $1",
        [stationId],
      ),
    );
    expect(rows[0].target_seconds).not.toBe(999);
  });

  it("printerDeviceId without expectedUpdatedAt is a 400 VALIDATION_ERROR, null included", async () => {
    const printer = await seedDevice(tenantId, outletA, "printer");
    const stationId = await insertStation(printer);
    for (const printerDeviceId of [printer, null])
      await expect(
        updateStation(tenantContext(), userId, stationId, {
          printerDeviceId,
        }),
      ).rejects.toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    const cook = await stationClient(stationId);
    const res = await cook
      .patch(`/api/menu/stations/${stationId}`)
      .set(originHeader)
      .send({ printerDeviceId: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await boundPrinter(stationId)).toBe(printer);
  });

  it("a fresh expectedUpdatedAt saves and returns a new updatedAt; target time alone needs none", async () => {
    const printer = await seedDevice(tenantId, outletA, "printer");
    const stationId = await insertStation();
    const t0 = await stationStamp(stationId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const saved = await updateStation(tenantContext(), userId, stationId, {
      printerDeviceId: printer,
      expectedUpdatedAt: t0,
    });
    expect(saved.printerDeviceId).toBe(printer);
    expect(saved.updatedAt).toBe(await stationStamp(stationId));
    expect(saved.updatedAt).not.toBe(t0);
    const plain = await updateStation(tenantContext(), userId, stationId, {
      targetSeconds: 45,
    });
    expect(plain.targetSeconds).toBe(45);
  });

  // legend-4xai finding 2 at the HTTP layer: the route answers 409 CONFLICT.
  it("PATCH with a stale expectedUpdatedAt answers 409 CONFLICT and changes nothing", async () => {
    const p = await seedDevice(tenantId, outletA, "printer");
    const q = await seedDevice(tenantId, outletA, "printer");
    const stationId = await insertStation(p);
    const cook = await stationClient(stationId);
    await asOwnerTenant(tenantId, (client) =>
      client.query("UPDATE stations SET updated_at = $1 WHERE id = $2", [
        new Date("2000-01-01T00:00:00.000Z"),
        stationId,
      ]),
    );
    const t0 = await stationStamp(stationId);
    await updateStation(tenantContext(), userId, stationId, {
      printerDeviceId: q,
      expectedUpdatedAt: t0,
    });
    const t1 = await stationStamp(stationId);
    expect(t1).not.toBe(t0);

    const res = await cook
      .patch(`/api/menu/stations/${stationId}`)
      .set(originHeader)
      .send({ printerDeviceId: p, targetSeconds: 555, expectedUpdatedAt: t0 });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
    expect(await boundPrinter(stationId)).toBe(q);
    expect(await stationStamp(stationId)).toBe(t1);
    const { rows } = await asOwnerTenant(tenantId, (client) =>
      client.query<{ target_seconds: number | null }>(
        "SELECT target_seconds FROM stations WHERE id = $1",
        [stationId],
      ),
    );
    expect(rows[0].target_seconds).not.toBe(555);
  });
});
