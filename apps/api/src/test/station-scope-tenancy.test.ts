// Station scope across tenants and brands (bead legend-cot3, W1-C).
//
// station-auth.test.ts proves a station account stays inside its station of
// one tenant. This file proves the outer edges of the same rule: a station id
// of another tenant is indistinguishable from an unknown id, and a brand
// assignment reaches exactly the stations of the outlets that brand owns
// (a brand with no outlets, or a brand that does not exist, reaches none).
// The last block checks the pure resolver (`authorize`, `stationReachOf`,
// `scopeCovers`) for the same scope shapes without a database.
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  authorize,
  scopeCovers,
  stationReachOf,
  type AccessPrincipal,
  type AccessTarget,
  type AssignmentScope,
  type OrgIndex,
  type PermissionCode,
  type RoleAssignment,
  type RoleGrant,
} from "@starter/shared/access";
import { createApp } from "../app";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { agent, originHeader, signUp } from "./helpers";
import {
  createIsolatedTenant,
  dropIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers";
import {
  assertStationPermission,
  permittedStationIds,
} from "../services/station-access";

const app = createApp();
const { tenant, brand, outlets } = cafeLegendFixtures;
const tenantId = tenant.id;
const brandId = brand.id;
const outletA = outlets[0].id;
const outletB = outlets[1].id;
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
const createdBrandIds: string[] = [];
const createdStations: { tenantId: string; id: string }[] = [];
const stationName = () => `Uji ${randomUUID().slice(0, 8)}`;
let tenantB: IsolatedTenant;

/** One live station, written as the owner, for any tenant/outlet. */
async function createStationIn(
  tenantOfRows: string,
  outletId: string,
  type = "hot_kitchen",
): Promise<string> {
  const result = await asOwnerTenant(tenantOfRows, (client) =>
    client.query<{ id: string }>(
      `INSERT INTO stations (tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [tenantOfRows, outletId, stationName(), type],
    ),
  );
  const id = result.rows[0].id;
  createdStations.push({ tenantId: tenantOfRows, id });
  return id;
}
const createStation = (outletId: string, type?: string) =>
  createStationIn(tenantId, outletId, type);

/** A tenant-local custom role (no template) for a narrow permission set. */
async function customRole(
  permissions: readonly string[],
  tenantOfRole: string = tenantId,
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
      tenantOfRole,
      `Uji ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify(allowedScopeTypes),
    ],
  );
  createdRoleIds.push(roleId);
  return roleId;
}

/** Signed-in client holding one role at one scope of `tenantOfRole`. */
async function roleClient(
  roleId: string,
  scope: { type: "tenant" | "brand" | "outlet" | "station"; id: string | null },
  tenantOfRole: string = tenantId,
): Promise<{ client: ReturnType<typeof agent>; userId: string }> {
  const client = agent(app);
  await signUp(client, "Station Tenancy User");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  createdUserIds.push(userId);
  await ownerPool.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [tenantOfRole, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

/** A brand row of the seeded tenant with no outlets. */
async function createEmptyBrand(): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)`,
    [
      id,
      tenantId,
      `kosong-${id.slice(0, 8)}`,
      `Brand kosong ${id.slice(0, 8)}`,
    ],
  );
  createdBrandIds.push(id);
  return id;
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

/** What a caller can observe of a refusal, minus the per-request id. */
function observed(response: { status: number; body: unknown }) {
  const error = { ...body(response).error };
  delete error.requestId;
  return { status: response.status, error };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  tenantB = await createIsolatedTenant(`scope-${randomUUID().slice(0, 6)}`);
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
  for (const row of createdStations)
    await asOwnerTenant(row.tenantId, (client) =>
      client.query("DELETE FROM stations WHERE id = $1", [row.id]),
    );
  if (createdBrandIds.length > 0)
    await ownerPool.query("DELETE FROM brands WHERE id = ANY($1::uuid[])", [
      createdBrandIds,
    ]);
  if (tenantB) await dropIsolatedTenant(tenantB);
  await owner.end();
  await ownerPool.end();
});

describe("legend-cot3 station scope across tenants", () => {
  it("legend-cot3 a station id of another tenant is refused like an unknown id, over HTTP and the service", async () => {
    const stationA = await createStation(outletA, "coffee_bar");
    const stationOfTenantB = await createStationIn(
      tenantB.tenantId,
      tenantB.outletId,
      "pastry",
    );
    const roleId = await customRole(["menu.item.view", "menu.item.manage"]);
    const stationUser = await roleClient(roleId, {
      type: "station",
      id: stationA,
    });
    const outletManager = await roleClient(roleId, {
      type: "outlet",
      id: outletA,
    });

    for (const [label, who] of [
      ["station user", stationUser],
      ["outlet manager", outletManager],
    ] as const) {
      // Positive control: the same request shape succeeds on an own station.
      const own = await who.client
        .patch(`/api/menu/stations/${stationA}`)
        .set(originHeader)
        .send({ targetSeconds: 240 });
      expect(own.status, `${label} own station`).toBe(200);

      const foreign = await who.client
        .patch(`/api/menu/stations/${stationOfTenantB}`)
        .set(originHeader)
        .send({ targetSeconds: 240 });
      const unknown = await who.client
        .patch(`/api/menu/stations/${randomUUID()}`)
        .set(originHeader)
        .send({ targetSeconds: 240 });
      expect(foreign.status, label).toBe(403);
      expect(body(foreign).error).toMatchObject({
        code: "PERMISSION_DENIED",
        message: STATION_DENIED,
      });
      expect(observed(foreign), label).toEqual(observed(unknown));

      const foreignDelete = await who.client
        .delete(`/api/menu/stations/${stationOfTenantB}`)
        .set(originHeader)
        .send();
      expect(foreignDelete.status, label).toBe(403);

      const list = await who.client.get("/api/menu/stations?limit=100");
      expect(list.status, label).toBe(200);
      expect(stationIds(list), label).toContain(stationA);
      expect(stationIds(list), label).not.toContain(stationOfTenantB);
    }

    // The other tenant's station is untouched.
    const untouched = await asOwnerTenant(tenantB.tenantId, (client) =>
      client.query<{ target_seconds: number | null; deleted_at: Date | null }>(
        "SELECT target_seconds, deleted_at FROM stations WHERE id = $1",
        [stationOfTenantB],
      ),
    );
    expect(untouched.rows).toEqual([
      { target_seconds: null, deleted_at: null },
    ]);

    // Service level: same snapshot, same answer.
    const context = tenantContext();
    const now = new Date();
    for (const userId of [stationUser.userId, outletManager.userId])
      await withTenant(db, context, async (tx) => {
        await expect(
          assertStationPermission(
            tx,
            context,
            userId,
            "menu.item.manage",
            stationA,
            now,
          ),
        ).resolves.toBeUndefined();
        await expect(
          assertStationPermission(
            tx,
            context,
            userId,
            "menu.item.manage",
            stationOfTenantB,
            now,
          ),
        ).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
          message: STATION_DENIED,
        });
        const reach = await permittedStationIds(
          tx,
          context,
          userId,
          "menu.item.view",
          now,
        );
        expect(reach).toContain(stationA);
        expect(reach).not.toContain(stationOfTenantB);
      });
  });

  it("legend-cot3 a tenant B user reaches its own station but not the seeded tenant's station", async () => {
    const stationA = await createStation(outletA, "cold_kitchen");
    const stationOfTenantB = await createStationIn(
      tenantB.tenantId,
      tenantB.outletId,
      "beverage_bar",
    );
    const roleId = await customRole(
      ["menu.item.view", "menu.item.manage"],
      tenantB.tenantId,
      ["tenant"],
    );
    const { client } = await roleClient(
      roleId,
      { type: "tenant", id: null },
      tenantB.tenantId,
    );
    const hostB = { Host: tenantB.hostname };

    // Positive control: tenant B's own station, through tenant B's host.
    const own = await client
      .patch(`/api/menu/stations/${stationOfTenantB}`)
      .set(hostB)
      .set(originHeader)
      .send({ targetSeconds: 180 });
    expect(own.status).toBe(200);
    const list = await client.get("/api/menu/stations?limit=100").set(hostB);
    expect(list.status).toBe(200);
    expect(stationIds(list)).toContain(stationOfTenantB);
    expect(stationIds(list)).not.toContain(stationA);

    // The seeded tenant's station through tenant B's host: same refusal as an
    // unknown id.
    const foreign = await client
      .patch(`/api/menu/stations/${stationA}`)
      .set(hostB)
      .set(originHeader)
      .send({ targetSeconds: 180 });
    const unknown = await client
      .patch(`/api/menu/stations/${randomUUID()}`)
      .set(hostB)
      .set(originHeader)
      .send({ targetSeconds: 180 });
    expect(foreign.status).toBe(403);
    expect(observed(foreign)).toEqual(observed(unknown));
    expect(
      (
        await client
          .delete(`/api/menu/stations/${stationA}`)
          .set(hostB)
          .set(originHeader)
          .send()
      ).status,
    ).toBe(403);

    // And through the seeded tenant's own host: this user holds nothing there.
    const crossHost = await client
      .patch(`/api/menu/stations/${stationA}`)
      .set(originHeader)
      .send({ targetSeconds: 180 });
    expect(crossHost.status).toBe(403);
    expect(observed(crossHost)).toEqual(observed(unknown));

    const untouched = await asOwnerTenant(tenantId, (owned) =>
      owned.query<{ target_seconds: number | null; deleted_at: Date | null }>(
        "SELECT target_seconds, deleted_at FROM stations WHERE id = $1",
        [stationA],
      ),
    );
    expect(untouched.rows).toEqual([
      { target_seconds: null, deleted_at: null },
    ]);
  });
});

describe("legend-cot3 station scope under brand assignments", () => {
  it("legend-cot3 a brand assignment reaches the stations of its outlets only", async () => {
    const stationA = await createStation(outletA, "coffee_bar");
    const stationB = await createStation(outletB, "pastry");
    const stationOfTenantB = await createStationIn(
      tenantB.tenantId,
      tenantB.outletId,
      "hot_kitchen",
    );
    const roleId = await customRole(["menu.item.view", "menu.item.manage"]);
    const { client, userId } = await roleClient(roleId, {
      type: "brand",
      id: brandId,
    });
    const context = tenantContext();
    const now = new Date();

    await withTenant(db, context, async (tx) => {
      const reach = await permittedStationIds(
        tx,
        context,
        userId,
        "menu.item.view",
        now,
      );
      expect(reach).toEqual(expect.arrayContaining([stationA, stationB]));
      expect(reach).not.toContain(stationOfTenantB);
      for (const stationId of [stationA, stationB])
        await expect(
          assertStationPermission(
            tx,
            context,
            userId,
            "menu.item.manage",
            stationId,
            now,
          ),
        ).resolves.toBeUndefined();
      await expect(
        assertStationPermission(
          tx,
          context,
          userId,
          "menu.item.manage",
          stationOfTenantB,
          now,
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    const list = await client.get("/api/menu/stations?limit=100");
    expect(list.status).toBe(200);
    expect(stationIds(list)).toEqual(
      expect.arrayContaining([stationA, stationB]),
    );
    expect(stationIds(list)).not.toContain(stationOfTenantB);
    expect(
      (
        await client
          .patch(`/api/menu/stations/${stationB}`)
          .set(originHeader)
          .send({ targetSeconds: 200 })
      ).status,
    ).toBe(200);
    expect(
      (
        await client
          .patch(`/api/menu/stations/${stationOfTenantB}`)
          .set(originHeader)
          .send({ targetSeconds: 200 })
      ).status,
    ).toBe(403);
  });

  it("legend-cot3 a brand with no outlets and an unknown brand reach no station", async () => {
    const stationA = await createStation(outletA, "coffee_bar");
    const roleId = await customRole(["menu.item.view", "menu.item.manage"]);
    // Positive control: the real brand reaches stationA with this very role.
    const real = await roleClient(roleId, { type: "brand", id: brandId });
    expect(
      (
        await real.client
          .patch(`/api/menu/stations/${stationA}`)
          .set(originHeader)
          .send({ targetSeconds: 150 })
      ).status,
    ).toBe(200);

    const emptyBrandId = await createEmptyBrand();
    const unknownBrandId = randomUUID();
    const context = tenantContext();
    const now = new Date();

    for (const [label, scopeId] of [
      ["empty brand", emptyBrandId],
      ["unknown brand", unknownBrandId],
    ] as const) {
      const { client, userId } = await roleClient(roleId, {
        type: "brand",
        id: scopeId,
      });

      await withTenant(db, context, async (tx) => {
        expect(
          await permittedStationIds(tx, context, userId, "menu.item.view", now),
          label,
        ).toEqual([]);
        await expect(
          assertStationPermission(
            tx,
            context,
            userId,
            "menu.item.manage",
            stationA,
            now,
          ),
          label,
        ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      });

      // The list never shows a station: either refused or empty.
      const list = await client.get("/api/menu/stations?limit=100");
      if (list.status === 200) expect(stationIds(list), label).toEqual([]);
      else expect(list.status, label).toBe(403);

      const patch = await client
        .patch(`/api/menu/stations/${stationA}`)
        .set(originHeader)
        .send({ targetSeconds: 999 });
      expect(patch.status, label).toBe(403);
      expect(body(patch).error, label).toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect(
        (
          await client
            .delete(`/api/menu/stations/${stationA}`)
            .set(originHeader)
            .send()
        ).status,
        label,
      ).toBe(403);
    }

    // stationA kept the positive control's value, not the denied 999.
    const row = await asOwnerTenant(tenantId, (client) =>
      client.query<{ target_seconds: number; deleted_at: Date | null }>(
        "SELECT target_seconds, deleted_at FROM stations WHERE id = $1",
        [stationA],
      ),
    );
    expect(row.rows).toEqual([{ target_seconds: 150, deleted_at: null }]);
  });
});

// ---------------------------------------------------------------- pure checks

describe("legend-cot3 station reach is consistent with authorize()", () => {
  const uuid = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const id = <T>(n: number) => uuid(n) as unknown as T;
  const B1 = uuid(1); // brand with both outlets
  const B2 = uuid(2); // empty brand
  const BX = uuid(3); // not in the org index
  const O1 = uuid(11);
  const O2 = uuid(12);
  const OX = uuid(13); // not in the org index
  const S1 = uuid(21); // O1
  const S2 = uuid(22); // O1
  const S3 = uuid(23); // O2
  const SX = uuid(24); // not in the org index
  const SO = uuid(25); // station whose outlet is not in the org index
  const PERMISSION = "kds.ticket.process" as PermissionCode;
  const now = new Date("2026-11-09T10:00:00.000Z");

  const org = {
    brands: [{ id: id(1) }, { id: id(2) }],
    outlets: [
      { id: id(11), brandId: id(1) },
      { id: id(12), brandId: id(1) },
    ],
    stations: [
      { id: id(21), outletId: id(11) },
      { id: id(22), outletId: id(11) },
      { id: id(23), outletId: id(12) },
      { id: id(25), outletId: id(13) },
    ],
  } as unknown as OrgIndex;
  const roles = [
    { id: id(90), permissions: [PERMISSION], mfaRequired: false },
  ] as unknown as RoleGrant[];

  function principalWith(scope: AssignmentScope): AccessPrincipal {
    const assignment = {
      id: id(91),
      tenantId: id(100),
      userId: id(101),
      roleId: id(90),
      scope,
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: null,
      assignedBy: id(101),
      assignedAt: "2026-01-01T00:00:00.000Z",
    } as unknown as RoleAssignment;
    return {
      tenantId: id(100),
      userId: id(101),
      assignments: [assignment],
    } as AccessPrincipal;
  }

  const scopes: [string, AssignmentScope, string[]][] = [
    ["tenant", { type: "tenant", id: null }, [S1, S2, S3]],
    ["brand", { type: "brand", id: id(1) }, [S1, S2, S3]],
    ["empty brand", { type: "brand", id: id(2) }, []],
    ["unknown brand", { type: "brand", id: id(3) }, []],
    ["outlet", { type: "outlet", id: id(11) }, [S1, S2]],
    ["unknown outlet", { type: "outlet", id: id(13) }, []],
    ["station", { type: "station", id: id(21) }, [S1]],
    ["unknown station", { type: "station", id: id(24) }, []],
  ] as unknown as [string, AssignmentScope, string[]][];

  const stationTargets = [S1, S2, S3, SX, SO];

  it.each(scopes)(
    "legend-cot3 %s scope: stationReachOf equals the stations authorize() allows",
    (_label, scope, expected) => {
      const principal = principalWith(scope);
      const reach = stationReachOf({
        principal,
        roles,
        org,
        now,
        permission: PERMISSION,
      });
      const allowed = stationTargets.filter(
        (stationId) =>
          authorize({
            principal,
            roles,
            org,
            permission: PERMISSION,
            target: { type: "station", id: stationId },
            now,
            surface: "kds",
            mfaVerified: false,
          }).allowed,
      );
      expect([...reach].sort()).toEqual([...allowed].sort());
      // Stations outside the org index (or without a live outlet) never count.
      expect(reach).not.toContain(SX);
      expect(reach).not.toContain(SO);
      expect([...reach].sort()).toEqual([...expected].sort());
    },
  );

  it("legend-cot3 the permission is required: a role without it reaches no station", () => {
    const principal = principalWith({ type: "tenant", id: null });
    expect(
      stationReachOf({
        principal,
        roles,
        org,
        now,
        permission: "menu.item.manage" as PermissionCode,
      }),
    ).toEqual([]);
  });

  it("legend-cot3 a station scope never covers an outlet, brand or tenant target", () => {
    const stationScope = {
      type: "station",
      id: id(21),
    } as unknown as AssignmentScope;
    const principal = principalWith(stationScope);
    const targets: AccessTarget[] = [
      { type: "tenant" },
      { type: "brand", id: B1 },
      { type: "brand", id: B2 },
      { type: "outlet", id: O1 },
      { type: "outlet", id: O2 },
      { type: "outlet", id: OX },
    ];
    for (const target of targets) {
      expect(
        scopeCovers(stationScope, target, org),
        JSON.stringify(target),
      ).toBe(false);
      expect(
        authorize({
          principal,
          roles,
          org,
          permission: PERMISSION,
          target,
          now,
          surface: "kds",
          mfaVerified: false,
        }),
        JSON.stringify(target),
      ).toEqual({ allowed: false, reason: "out_of_scope" });
    }
    // Positive control: the same assignment allows its own station.
    expect(
      authorize({
        principal,
        roles,
        org,
        permission: PERMISSION,
        target: { type: "station", id: S1 },
        now,
        surface: "kds",
        mfaVerified: false,
      }).allowed,
    ).toBe(true);
  });

  it("legend-cot3 an unknown brand target is never covered, whatever the scope", () => {
    for (const [, scope] of scopes)
      expect(scopeCovers(scope, { type: "brand", id: BX }, org)).toBe(false);
    // An empty brand is a real brand: only a brand scope on it covers it.
    expect(
      scopeCovers(
        { type: "brand", id: id(2) } as never,
        { type: "brand", id: B2 },
        org,
      ),
    ).toBe(true);
  });
});
