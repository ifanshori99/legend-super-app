// legend-do1o / OPS-03 / A24: prep expiry comes from an operations-owned
// per-item, per-outlet shelf life. Exercise real HTTP, permissions and DB.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app";
import { agent, originHeader, signUp } from "./helpers";

const app = createApp();
const tenant = cafeLegendPlatformFixtures.tenant;
const [outletA, outletB] = cafeLegendPlatformFixtures.outlets;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const users: string[] = [];
const roles: string[] = [];
const items: string[] = [];
const batches: string[] = [];
const locations: string[] = [];
const uoms: string[] = [];
const key = () => `legend-do1o-${randomUUID()}`;
const producedAt = "2030-01-14T17:30:00.000Z"; // 00:30 Asia/Jakarta.
const settingsPath = (itemId = "") =>
  `/api/operations/prep-item-settings${itemId ? `/${itemId}` : ""}`;

async function asTenant<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.id],
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

async function manager(outletId?: string) {
  const client = agent(app);
  await signUp(client, "Prep Shelf Life Manager");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  users.push(userId);
  if (outletId) {
    const roleId = randomUUID();
    roles.push(roleId);
    await asTenant(async (connection) => {
      await connection.query(
        `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
         VALUES ($1, $2, $3, false, '["ops.prep.manage"]', '["outlet"]')`,
        [roleId, tenant.id, `Prep test ${roleId.slice(0, 8)}`],
      );
      await connection.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
         VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
        [tenant.id, userId, roleId, outletId],
      );
    });
  } else {
    await asTenant((connection) =>
      connection.query(
        `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
         SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
         WHERE tenant_id = $1 AND template_key = 'owner'`,
        [tenant.id, userId],
      ),
    );
  }
  return { client, userId };
}

async function itemAndBatch(outletId: string, existingItemId?: string) {
  const itemId = existingItemId ?? randomUUID();
  const batchId = randomUUID();
  const locationId = randomUUID();
  batches.push(batchId);
  locations.push(locationId);
  await asTenant(async (connection) => {
    if (!existingItemId) {
      const uomId = randomUUID();
      items.push(itemId);
      uoms.push(uomId);
      await connection.query(
        "INSERT INTO uoms (id, tenant_id, code, name) VALUES ($1, $2, $3, 'Unit prep test')",
        [uomId, tenant.id, `D${uomId.slice(0, 8)}`],
      );
      await connection.query(
        `INSERT INTO inventory_items (id, tenant_id, name, category, type, base_uom_id)
         VALUES ($1, $2, $3, 'Bahan Baku', 'raw_material', $4)`,
        [itemId, tenant.id, `Prep ${itemId.slice(0, 8)}`, uomId],
      );
    }
    await connection.query(
      `INSERT INTO stock_locations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Prep chiller test', 'chiller')`,
      [locationId, tenant.id, outletId],
    );
    await connection.query(
      `INSERT INTO stock_batches (id, tenant_id, outlet_id, location_id, inventory_item_id, batch_code, expires_on)
       VALUES ($1, $2, $3, $4, $5, $6, '2030-12-31')`,
      [
        batchId,
        tenant.id,
        outletId,
        locationId,
        itemId,
        `D${batchId.slice(0, 8)}`,
      ],
    );
  });
  return { itemId, batchId };
}

type Manager = Awaited<ReturnType<typeof manager>>;
let actor: Manager;
beforeAll(async () => {
  actor = await manager();
});

afterAll(async () => {
  await asTenant(async (connection) => {
    await connection.query(
      "DELETE FROM prep_labels WHERE tenant_id = $1 AND inventory_item_id = ANY($2::uuid[])",
      [tenant.id, items],
    );
    const table = await connection.query<{ name: string | null }>(
      "SELECT to_regclass('public.prep_item_settings')::text AS name",
    );
    if (table.rows[0]?.name)
      await connection.query(
        "DELETE FROM prep_item_settings WHERE tenant_id = $1 AND inventory_item_id = ANY($2::uuid[])",
        [tenant.id, items],
      );
    await connection.query(
      "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE 'legend-do1o-%'",
      [tenant.id],
    );
    for (const [tableName, ids] of [
      ["stock_batches", batches],
      ["stock_locations", locations],
      ["inventory_items", items],
      ["uoms", uoms],
    ] as const)
      await connection.query(
        `DELETE FROM ${tableName} WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenant.id, ids],
      );
    await connection.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = ANY($2::text[])",
      [tenant.id, users],
    );
    await connection.query(
      "DELETE FROM roles WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenant.id, roles],
    );
  });
  await owner.query('DELETE FROM "user" WHERE id = ANY($1::text[])', [users]);
  await owner.end();
});

async function configure(
  itemId: string,
  shelfLifeMinutes: number,
  outletId = outletA.id,
  idempotencyKey = key(),
) {
  return actor.client
    .put(settingsPath(itemId))
    .set(originHeader)
    .send({ outletId, shelfLifeMinutes, idempotencyKey });
}

async function label(
  itemId: string,
  batchId: string,
  input: Record<string, unknown> = {},
) {
  return actor.client
    .post("/api/operations/prep-labels")
    .set(originHeader)
    .send({
      outletId: outletA.id,
      inventoryItemId: itemId,
      batchId,
      producedAt,
      idempotencyKey: key(),
      ...input,
    });
}

describe("legend-do1o OPS-03 prep shelf life", () => {
  it("[A24] computes distinct per-item use-by instants across outlet midnight instead of borrowing batch expiry", async () => {
    for (const [minutes, expectedUseBy] of [
      [90, "2030-01-14T19:00:00.000Z"],
      [240, "2030-01-14T21:30:00.000Z"],
    ] as const) {
      const { itemId, batchId } = await itemAndBatch(outletA.id);
      const configured = await configure(itemId, minutes);
      expect(configured.status, JSON.stringify(configured.body)).toBe(200);
      expect(configured.body.data).toMatchObject({
        tenantId: tenant.id,
        outletId: outletA.id,
        inventoryItemId: itemId,
        shelfLifeMinutes: minutes,
        updatedBy: actor.userId,
      });
      const created = await label(itemId, batchId);
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(created.body.data.useBy).toBe(expectedUseBy);
      const persisted = await asTenant((connection) =>
        connection.query<{ use_by: Date }>(
          "SELECT use_by FROM prep_labels WHERE tenant_id = $1 AND id = $2",
          [tenant.id, created.body.data.id],
        ),
      );
      expect(persisted.rows[0]!.use_by.toISOString()).toBe(expectedUseBy);
    }
  });

  it("[A24] refuses missing settings, invalid durations and a caller-supplied expiry that exceeds shelf life", async () => {
    const { itemId, batchId } = await itemAndBatch(outletA.id);
    const missing = await label(itemId, batchId, {
      useBy: "2030-12-31T17:30:00.000Z",
    });
    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
    expect(missing.body.error.code).toBe("PREP_SHELF_LIFE_REQUIRED");
    for (const value of [0, -1, 1.5, 2_147_483_648]) {
      const invalid = await configure(itemId, value);
      expect(invalid.status, JSON.stringify(invalid.body)).toBe(422);
    }
    const configured = await configure(itemId, 90);
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);
    const override = await label(itemId, batchId, {
      useBy: "2030-12-31T17:30:00.000Z",
    });
    expect(override.status, JSON.stringify(override.body)).toBe(422);
    expect(override.body.error.code).toBe("VALIDATION_ERROR");
    const persisted = await asTenant((connection) =>
      connection.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM prep_labels WHERE tenant_id = $1 AND batch_id = $2",
        [tenant.id, batchId],
      ),
    );
    expect(persisted.rows[0]!.n).toBe(0);
  });

  it("[TEN-03] scopes settings and derived expiry to the label outlet before replay", async () => {
    const itemA = await itemAndBatch(outletA.id);
    const itemB = await itemAndBatch(outletB.id, itemA.itemId);
    const settingKey = key();
    const a = await configure(itemA.itemId, 60, outletA.id, settingKey);
    const b = await configure(itemB.itemId, 180, outletB.id);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const labelA = await label(itemA.itemId, itemA.batchId);
    const labelB = await label(itemB.itemId, itemB.batchId, {
      outletId: outletB.id,
    });
    expect(labelA.status, JSON.stringify(labelA.body)).toBe(201);
    expect(labelB.status, JSON.stringify(labelB.body)).toBe(201);
    expect(labelA.body.data.useBy).toBe("2030-01-14T18:30:00.000Z");
    expect(labelB.body.data.useBy).toBe("2030-01-14T20:30:00.000Z");

    const outsider = await manager(outletB.id);
    const read = await outsider.client.get(
      `${settingsPath()}?outletId=${outletA.id}&limit=100`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(403);
    const replay = await outsider.client
      .put(settingsPath(itemA.itemId))
      .set(originHeader)
      .send({
        outletId: outletA.id,
        shelfLifeMinutes: 60,
        idempotencyKey: settingKey,
      });
    expect(replay.status, JSON.stringify(replay.body)).toBe(403);
    const own = await outsider.client.get(
      `${settingsPath()}?outletId=${outletB.id}&limit=100`,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(
      own.body.data.find(
        (row: { inventoryItemId: string }) =>
          row.inventoryItemId === itemB.itemId,
      ),
    ).toMatchObject({ outletId: outletB.id, shelfLifeMinutes: 180 });
  });

  it("[D-CORE-5] settings replay is idempotent and configuration changes never extend an existing label", async () => {
    const { itemId, batchId } = await itemAndBatch(outletA.id);
    const settingKey = key();
    const setting = await configure(itemId, 90, outletA.id, settingKey);
    expect(setting.status, JSON.stringify(setting.body)).toBe(200);
    const settingReplay = await configure(itemId, 90, outletA.id, settingKey);
    expect(settingReplay.status, JSON.stringify(settingReplay.body)).toBe(200);
    expect(settingReplay.body.data).toEqual(setting.body.data);
    const reused = await configure(itemId, 180, outletA.id, settingKey);
    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const labelKey = key();
    const first = await label(itemId, batchId, { idempotencyKey: labelKey });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const updated = await configure(itemId, 240);
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const replay = await label(itemId, batchId, { idempotencyKey: labelKey });
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    expect(replay.body.data.useBy).toBe("2030-01-14T19:00:00.000Z");
    const changed = await label(itemId, batchId, {
      idempotencyKey: labelKey,
      producedAt: "2030-01-14T18:30:00.000Z",
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const listed = await actor.client.get(
      `/api/operations/prep-labels?outletId=${outletA.id}&inventoryItemId=${itemId}&limit=100`,
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.data[0].useBy).toBe(first.body.data.useBy);
  });
});
