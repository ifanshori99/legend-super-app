// Station authorization (bead legend-fsb7; PRD v1.7 §3 F7 "Routing Stasiun",
// §6 B role_assignments, TEN-03).
//
// TEN-03 expands a station assignment to its outlet because the only RLS
// filter the database installs is outlet-level (`app.outlet_ids`). This file
// proves the second half of that decision: every station-bound read/write
// re-asserts the station itself, so a station-scoped account reaches only its
// own station(s) while outlet/brand/tenant scopes keep every station they
// contain. It runs the real Express app, Better Auth, PostgreSQL and RLS.
//
// The KDS board/ticket routes are WS-04 work (legend-4d5); their station
// services use `assertStationPermission` / `permittedStationIds` from
// services/station-access.ts, which this file exercises for those permissions
// against real assignments. The menu station config routes already exist and
// prove the HTTP half (`requireStationPermission`).
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
  assertStationPermission,
  permittedStationIds,
} from "../services/station-access";

const app = createApp();
const { tenant, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
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
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantOfRows,
    ]);
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
const stationName = () => `Uji ${randomUUID().slice(0, 8)}`;

/** One live station of the seeded tenant, written as the owner. */
async function createStation(
  outletId: string,
  type = "hot_kitchen",
): Promise<string> {
  const name = stationName();
  const result = await asOwnerTenant(tenantId, (client) =>
    client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantId, outletId, name, type],
    ),
  );
  const id = result.rows[0].id;
  createdStationIds.push(id);
  return id;
}

/** A tenant-local custom role (no template) for a narrow permission set. */
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

/** Signed-in client holding one role at one scope. */
async function roleClient(
  roleId: string,
  scope: { type: "tenant" | "outlet" | "station"; id: string | null },
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const client = agent(app);
  await signUp(client, "Station User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

/** A tenant-wide context: RLS shows the tenant, the station helper decides. */
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

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
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

describe("legend-fsb7 station authorization", () => {
  it("legend-fsb7 a station-scoped manager configures and lists only its own station", async () => {
    const stationA = await createStation(outletA, "coffee_bar");
    const stationB = await createStation(outletA, "cold_kitchen");
    const roleId = await customRole(["menu.item.view", "menu.item.manage"]);
    const { client } = await roleClient(roleId, {
      type: "station",
      id: stationA,
    });

    // Its own station: allowed through the station target.
    const own = await client
      .patch(`/api/menu/stations/${stationA}`)
      .set(originHeader)
      .send({ targetSeconds: 240 });
    expect(own.status).toBe(200);

    // Another station of the same outlet: denied by the station target, not
    // merely by the outlet (TEN-03 expands station scope to its outlet).
    const other = await client
      .patch(`/api/menu/stations/${stationB}`)
      .set(originHeader)
      .send({ targetSeconds: 240 });
    expect(other.status).toBe(403);
    expect(body(other).error).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(
      (
        await client
          .delete(`/api/menu/stations/${stationB}`)
          .set(originHeader)
          .send()
      ).status,
    ).toBe(403);

    // The station list is station-bound too: only the assigned station, and
    // never another outlet's station.
    const list = await client.get("/api/menu/stations?limit=100");
    expect(list.status).toBe(200);
    expect(stationIds(list)).toEqual([stationA]);
    const stationOfOutletB = await createStation(outletB, "pastry");
    expect(
      (await client.get(`/api/menu/stations?limit=100&outletId=${outletB}`))
        .status,
    ).toBe(403);
    expect(
      (await client.get("/api/menu/stations?limit=100")).body.data.map(
        (row: { id: string }) => row.id,
      ),
    ).not.toContain(stationOfOutletB);
  });

  it("legend-fsb7 an outlet-scoped manager configures every station of its outlet only", async () => {
    const stationA = await createStation(outletA, "coffee_bar");
    const stationB = await createStation(outletA, "hot_kitchen");
    const stationOfOutletB = await createStation(outletB, "pastry");
    const roleId = await customRole(["menu.item.view", "menu.item.manage"]);
    const { client } = await roleClient(roleId, {
      type: "outlet",
      id: outletA,
    });

    for (const stationId of [stationA, stationB]) {
      expect(
        (
          await client
            .patch(`/api/menu/stations/${stationId}`)
            .set(originHeader)
            .send({ targetSeconds: 300 })
        ).status,
      ).toBe(200);
    }
    // Another outlet is out of the assignment's reach.
    expect(
      (
        await client
          .patch(`/api/menu/stations/${stationOfOutletB}`)
          .set(originHeader)
          .send({ targetSeconds: 300 })
      ).status,
    ).toBe(403);
    const list = await client.get("/api/menu/stations?limit=100");
    expect(list.status).toBe(200);
    // The outlet grant reaches every station of the outlet (the list also
    // carries stations earlier tests created), never another outlet's.
    expect(stationIds(list)).toEqual(
      expect.arrayContaining([stationA, stationB]),
    );
    expect(stationIds(list)).not.toContain(stationOfOutletB);
  });

  it("legend-fsb7 a station cook boards and bumps its own station only", async () => {
    const stationA = await createStation(outletA, "coffee_bar");
    const stationB = await createStation(outletA, "hot_kitchen");
    // Barista / Cook holds kds.ticket.process at station scope (§3.8).
    const roleId = await customRole(
      ["kds.ticket.process", "kds.remake_comp.record"],
      ["station"],
    );
    const { userId } = await roleClient(roleId, {
      type: "station",
      id: stationA,
    });
    const context = tenantContext();
    const now = new Date();

    await withTenant(db, context, async (tx) => {
      // The board/selector list this station only.
      expect(
        await permittedStationIds(
          tx,
          context,
          userId,
          "kds.ticket.process",
          now,
        ),
      ).toEqual([stationA]);

      // Board, bump and remake/comp all resolve for its station...
      await expect(
        assertStationPermission(
          tx,
          context,
          userId,
          "kds.ticket.process",
          stationA,
          now,
        ),
      ).resolves.toBeUndefined();
      await expect(
        assertStationPermission(
          tx,
          context,
          userId,
          "kds.remake_comp.record",
          stationA,
          now,
        ),
      ).resolves.toBeUndefined();

      // ...and fail closed for another station of the same outlet.
      for (const permission of [
        "kds.ticket.process",
        "kds.remake_comp.record",
      ] as const)
        await expect(
          assertStationPermission(
            tx,
            context,
            userId,
            permission,
            stationB,
            now,
          ),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
  });

  it("legend-fsb7 an outlet-scoped kitchen lead boards every station of its outlet", async () => {
    const stationA = await createStation(outletA, "coffee_bar");
    const stationB = await createStation(outletA, "hot_kitchen");
    const stationOfOutletB = await createStation(outletB, "pastry");
    const roleId = await customRole(
      ["kds.ticket.process", "kds.expo.operate", "kds.remake_comp.record"],
      ["outlet"],
    );
    const { userId } = await roleClient(roleId, {
      type: "outlet",
      id: outletA,
    });
    const context = tenantContext();
    const now = new Date();

    await withTenant(db, context, async (tx) => {
      const reach = await permittedStationIds(
        tx,
        context,
        userId,
        "kds.ticket.process",
        now,
      );
      // Every station of the outlet (the list also carries stations earlier
      // tests created), never another outlet's.
      expect(reach).toEqual(expect.arrayContaining([stationA, stationB]));
      expect(reach).not.toContain(stationOfOutletB);
      for (const stationId of [stationA, stationB])
        await expect(
          assertStationPermission(
            tx,
            context,
            userId,
            "kds.ticket.process",
            stationId,
            now,
          ),
        ).resolves.toBeUndefined();
      // Another outlet's station is outside the outlet assignment.
      await expect(
        assertStationPermission(
          tx,
          context,
          userId,
          "kds.ticket.process",
          stationOfOutletB,
          now,
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });
  });

  it("legend-fsb7 a station-bound resource without a determinable station is denied", async () => {
    const stationA = await createStation(outletA, "coffee_bar");
    const roleId = await customRole(["kds.ticket.process"], ["station"]);
    const { userId } = await roleClient(roleId, {
      type: "station",
      id: stationA,
    });
    const context = tenantContext();
    const now = new Date();

    await withTenant(db, context, async (tx) => {
      // A ticket with no station, a blank id and a malformed id all deny
      // instead of widening to the outlet (fail closed).
      for (const missing of [null, undefined, "", "not-a-station"]) {
        await expect(
          assertStationPermission(
            tx,
            context,
            userId,
            "kds.ticket.process",
            missing,
            now,
          ),
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      }
      // A station that does not exist in the tenant's org index denies too.
      await expect(
        assertStationPermission(
          tx,
          context,
          userId,
          "kds.ticket.process",
          randomUUID(),
          now,
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    // The HTTP gate refuses a station target the caller does not reach, and a
    // malformed station id is a validation error, never a wildcard.
    const managerRole = await customRole(["menu.item.manage"]);
    const manager = await roleClient(managerRole, {
      type: "station",
      id: stationA,
    });
    expect(
      (
        await manager.client
          .patch(`/api/menu/stations/${randomUUID()}`)
          .set(originHeader)
          .send({ targetSeconds: 300 })
      ).status,
    ).toBe(403);
    expect(
      (
        await manager.client
          .patch("/api/menu/stations/not-a-station")
          .set(originHeader)
          .send({ targetSeconds: 300 })
      ).status,
    ).toBe(422);
  });

  it("legend-fsb7 GET /api/me/access exposes the caller's station reach", async () => {
    const stationA = await createStation(outletA, "coffee_bar");
    await createStation(outletA, "hot_kitchen");
    const roleId = await customRole(
      ["kds.ticket.process", "kds.remake_comp.record"],
      ["station"],
    );
    const { client } = await roleClient(roleId, {
      type: "station",
      id: stationA,
    });

    const access = await client.get("/api/me/access");
    expect(access.status).toBe(200);
    expect(body(access).data).toMatchObject({
      stations: [stationA],
    });

    const managerRole = await customRole(["menu.item.view"]);
    const manager = await roleClient(managerRole, {
      type: "outlet",
      id: outletA,
    });
    const managerAccess = await manager.client.get("/api/me/access");
    expect(managerAccess.status).toBe(200);
    const reach = (body(managerAccess).data as { stations: string[] }).stations;
    expect(reach).toContain(stationA);
  });
});
