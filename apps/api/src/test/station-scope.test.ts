// Station-aware query scope (bead legend-cot3). A role assigned at a station
// reaches that station only: not a sibling station of the same outlet, and not
// the outlet-level data (categories, items, devices, print, orders).
// TEN-03 expands a station assignment to its outlet for RLS, so the route
// gates and the service layer must do the narrowing. Real app, Better Auth,
// PostgreSQL and RLS. Every denial has a positive control first.
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { agent, originHeader, signUp } from "./helpers";
import {
  deleteStation,
  listStations,
  updateStation,
} from "../services/menu.service";
import {
  assertStationPermission,
  permittedStationIds,
} from "../services/station-access";

const app = createApp();
const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const STATION_DENIED = "Anda hanya dapat mengakses stasiun yang ditugaskan.";
const ownerPool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});

/** Owner-side writes need the tenant local setting because RLS is FORCED. */
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

const createdUserIds: string[] = [];
const createdRoleIds: string[] = [];
const createdStationIds: string[] = [];

async function createStation(
  outletId: string,
  type = "hot_kitchen",
): Promise<string> {
  const result = await asOwnerTenant(tenantId, (client) =>
    client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, outletId, `Uji ${randomUUID().slice(0, 8)}`, type],
    ),
  );
  const id = result.rows[0].id;
  createdStationIds.push(id);
  return id;
}

async function customRole(
  permissions: readonly string[],
  allowedScopeTypes: readonly string[] = [
    "tenant",
    "brand",
    "outlet",
    "station",
  ],
): Promise<string> {
  const roleId = randomUUID();
  await ownerPool.query(
    `INSERT INTO roles
       (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4::jsonb, false, $5::jsonb)`,
    [
      roleId,
      tenantId,
      `Uji ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(allowedScopeTypes),
    ],
  );
  createdRoleIds.push(roleId);
  return roleId;
}

/** Signed-in client holding one role at one scope (optionally time-boxed). */
async function roleClient(
  roleId: string,
  scope: { type: "tenant" | "outlet" | "station"; id: string | null },
  window: { validFrom?: string; validUntil?: string | null } = {},
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const client = agent(app);
  await signUp(client, "Station Scope User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, valid_until, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - $6::interval, $7::timestamptz, $2)`,
    [
      tenantId,
      userId,
      roleId,
      scope.type,
      scope.id,
      window.validFrom ?? "1 minute",
      window.validUntil ?? null,
    ],
  );
  return { client, userId };
}

const tenantContext = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );

function body(response: { body: unknown }) {
  return response.body as { data?: unknown; error?: Record<string, unknown> };
}

function stationIds(response: { body: unknown }): string[] {
  return (body(response).data as { id: string }[]).map((row) => row.id);
}

async function stationRow(id: string) {
  const { rows } = await asOwnerTenant(tenantId, (client) =>
    client.query<{
      name: string;
      type: string;
      target_seconds: number | null;
      deleted_at: Date | null;
    }>(
      "SELECT name, type, target_seconds, deleted_at FROM stations WHERE id = $1",
      [id],
    ),
  );
  return rows[0];
}

const ROLE_PERMISSIONS = [
  "menu.item.view",
  "menu.item.manage",
  "menu.price.view",
  "kds.ticket.process",
  "device.registry.manage",
  "order.view",
] as const;

let stationA: string;
let stationB: string;
let roleId: string;
let s: Awaited<ReturnType<typeof roleClient>>;
let o: Awaited<ReturnType<typeof roleClient>>;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  stationA = await createStation(outletA, "coffee_bar");
  stationB = await createStation(outletA, "cold_kitchen");
  roleId = await customRole(ROLE_PERMISSIONS);
  s = await roleClient(roleId, { type: "station", id: stationA });
  o = await roleClient(roleId, { type: "outlet", id: outletA });
});

afterAll(async () => {
  if (createdUserIds.length > 0)
    await ownerPool.query(
      "DELETE FROM role_assignments WHERE user_id = ANY($1::text[])",
      [createdUserIds],
    );
  if (createdRoleIds.length > 0)
    await ownerPool.query("DELETE FROM roles WHERE id = ANY($1::uuid[])", [
      createdRoleIds,
    ]);
  if (createdStationIds.length > 0)
    await asOwnerTenant(tenantId, (client) =>
      client.query("DELETE FROM stations WHERE id = ANY($1::uuid[])", [
        createdStationIds,
      ]),
    );
  await ownerPool.end();
});

describe("legend-cot3 station-scoped routes, same outlet", () => {
  it("legend-cot3 the outlet-scoped user lists every station of its outlet (positive control)", async () => {
    const list = await o.client.get("/api/menu/stations?limit=100");
    expect(list.status).toBe(200);
    expect(stationIds(list)).toEqual(
      expect.arrayContaining([stationA, stationB]),
    );
  });

  it("legend-cot3 the station-scoped user lists exactly its own station", async () => {
    const list = await s.client.get("/api/menu/stations?limit=100");
    expect(list.status).toBe(200);
    expect(stationIds(list)).toEqual([stationA]);
    expect(stationIds(list)).not.toContain(stationB);
  });

  it("legend-cot3 the station-scoped user patches A but not B, and B stays unchanged", async () => {
    const own = await s.client
      .patch(`/api/menu/stations/${stationA}`)
      .set(originHeader)
      .send({ targetSeconds: 240 });
    expect(own.status).toBe(200);
    expect((await stationRow(stationA)).target_seconds).toBe(240);

    const before = await stationRow(stationB);
    const patch = await s.client
      .patch(`/api/menu/stations/${stationB}`)
      .set(originHeader)
      .send({ targetSeconds: 999 });
    expect(patch.status).toBe(403);
    expect(body(patch).error).toMatchObject({
      code: "PERMISSION_DENIED",
      message: STATION_DENIED,
    });
    const del = await s.client
      .delete(`/api/menu/stations/${stationB}`)
      .set(originHeader)
      .send();
    expect(del.status).toBe(403);
    expect(body(del).error).toMatchObject({ code: "PERMISSION_DENIED" });
    const after = await stationRow(stationB);
    expect(after.target_seconds).toBe(before.target_seconds);
    expect(after.deleted_at).toBeNull();

    // Positive control: the outlet-scoped user changes the very same B.
    const outletPatch = await o.client
      .patch(`/api/menu/stations/${stationB}`)
      .set(originHeader)
      .send({ targetSeconds: 300 });
    expect(outletPatch.status).toBe(200);
    expect((await stationRow(stationB)).target_seconds).toBe(300);
  });

  // [path, allowed status for the outlet-scoped user]. The print route has no
  // object storage in tests, so it answers 503 only AFTER the permission gate.
  const outletRoutes: [string, string, number][] = [
    ["menu categories", "/api/menu/categories?limit=10", 200],
    ["menu items", "/api/menu/items?limit=10", 200],
    ["devices", `/api/devices?outletId=${outletA}`, 200],
    ["menu print", `/api/menu/print?outletId=${outletA}`, 503],
    ["pos orders", `/api/outlets/${outletA}/pos/orders?limit=10`, 200],
  ];
  for (const [label, path, allowed] of outletRoutes) {
    it(`legend-cot3 outlet-level route ${label}: outlet user passes, station user is denied`, async () => {
      const outletUser = await o.client.get(path);
      expect(outletUser.status).toBe(allowed);

      const stationUser = await s.client.get(path);
      expect(stationUser.status).toBe(403);
      expect(body(stationUser).error).toMatchObject({
        code: "PERMISSION_DENIED",
      });
    });
  }
});

describe("legend-cot3 station-scoped services", () => {
  it("legend-cot3 listStations returns only the assigned station", async () => {
    const outletUser = await listStations(tenantContext(), o.userId, {
      limit: 100,
    });
    expect(outletUser.data.map((row) => row.id)).toEqual(
      expect.arrayContaining([stationA, stationB]),
    );
    const stationUser = await listStations(tenantContext(), s.userId, {
      limit: 100,
    });
    expect(stationUser.data.map((row) => row.id)).toEqual([stationA]);
  });

  it("legend-cot3 updateStation/deleteStation reject another station and resolve on its own", async () => {
    const own = await updateStation(tenantContext(), s.userId, stationA, {
      targetSeconds: 250,
    });
    expect(own.id).toBe(stationA);
    await expect(
      updateStation(tenantContext(), s.userId, stationB, {
        targetSeconds: 1,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      deleteStation(tenantContext(), s.userId, stationB),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect((await stationRow(stationB)).deleted_at).toBeNull();

    // Positive control: the outlet user deletes an unused station...
    const spare = await createStation(outletA, "pastry");
    await expect(
      deleteStation(tenantContext(), o.userId, spare),
    ).resolves.toBeUndefined();
    expect((await stationRow(spare)).deleted_at).not.toBeNull();
    // ...but a station-only grant cannot delete even its own station:
    // removing it reroutes the outlet's KDS tickets (legend-cot3).
    const ownStation = await createStation(outletA, "pastry");
    const ownUser = await roleClient(roleId, {
      type: "station",
      id: ownStation,
    });
    await expect(
      deleteStation(tenantContext(), ownUser.userId, ownStation),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect((await stationRow(ownStation)).deleted_at).toBeNull();
  });

  it("legend-cot3 a station-only grant cannot rename or retype its station (KDS routing is outlet config)", async () => {
    const own = await createStation(outletA, "pastry");
    const other = await createStation(outletA, "hot_kitchen");
    const ownUser = await roleClient(roleId, { type: "station", id: own });
    const before = await stationRow(own);

    // Positive control: its own target time, and an unchanged name/type
    // echoed back by a form, still save.
    await expect(
      updateStation(tenantContext(), ownUser.userId, own, {
        targetSeconds: 210,
        name: before.name,
        type: before.type,
      }),
    ).resolves.toMatchObject({ id: own });

    // Taking another station's type or a name that sorts first would steal
    // that station's tickets: refused, row unchanged.
    for (const change of [
      { type: "hot_kitchen" },
      { name: "0 Pertama" },
    ] as const) {
      await expect(
        updateStation(tenantContext(), ownUser.userId, own, change),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      const response = await ownUser.client
        .patch(`/api/menu/stations/${own}`)
        .set(originHeader)
        .send(change);
      expect(response.status).toBe(403);
    }
    const after = await stationRow(own);
    expect(after.type).toBe("pastry");
    expect(after.name).toBe(before.name);

    // Positive control: the outlet user may rename and retype.
    await expect(
      updateStation(tenantContext(), o.userId, other, {
        name: `${before.name} B`,
        type: "cold_kitchen",
      }),
    ).resolves.toMatchObject({ type: "cold_kitchen" });
  });
});

describe("legend-cot3 deny by default", () => {
  const view = "menu.item.view";

  it("legend-cot3 an expired assignment reaches no station", async () => {
    const station = await createStation(outletA, "pastry");
    const active = await roleClient(roleId, { type: "station", id: station });
    const expired = await roleClient(
      roleId,
      { type: "station", id: station },
      {
        validFrom: "2 hours",
        validUntil: new Date(Date.now() - 3_600_000).toISOString(),
      },
    );
    const now = new Date();
    const check = (userId: string) =>
      withTenant(db, tenantContext(), async (tx) => ({
        ids: await permittedStationIds(tx, tenantContext(), userId, view, now),
        assert: await assertStationPermission(
          tx,
          tenantContext(),
          userId,
          view,
          station,
          now,
        ).then(
          () => "ok",
          (error: { code?: string }) => error.code,
        ),
      }));

    // Positive control: the active assignment reaches the station.
    expect(await check(active.userId)).toEqual({
      ids: [station],
      assert: "ok",
    });
    expect(await check(expired.userId)).toEqual({
      ids: [],
      assert: "PERMISSION_DENIED",
    });
  });

  it("legend-cot3 a role lacking the permission reaches no station", async () => {
    const station = await createStation(outletA, "pastry");
    const priceOnly = await customRole(["menu.price.view"]);
    const holder = await roleClient(roleId, { type: "station", id: station });
    const lacking = await roleClient(priceOnly, {
      type: "station",
      id: station,
    });
    const now = new Date();
    const ids = (userId: string) =>
      withTenant(db, tenantContext(), (tx) =>
        permittedStationIds(tx, tenantContext(), userId, view, now),
      );
    const asserted = (userId: string) =>
      withTenant(db, tenantContext(), (tx) =>
        assertStationPermission(
          tx,
          tenantContext(),
          userId,
          view,
          station,
          now,
        ),
      );

    expect(await ids(holder.userId)).toEqual([station]);
    await expect(asserted(holder.userId)).resolves.toBeUndefined();
    expect(await ids(lacking.userId)).toEqual([]);
    await expect(asserted(lacking.userId)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      message: STATION_DENIED,
    });

    // The route agrees: no list rows, no patch for the lacking account.
    const route = await lacking.client.get("/api/menu/stations?limit=100");
    expect([200, 403]).toContain(route.status);
    if (route.status === 200) expect(stationIds(route)).toEqual([]);
    const patch = await lacking.client
      .patch(`/api/menu/stations/${station}`)
      .set(originHeader)
      .send({ targetSeconds: 120 });
    expect(patch.status).toBe(403);
    expect((await stationRow(station)).target_seconds).toBeNull();
  });
});
