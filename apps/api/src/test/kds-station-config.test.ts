// Kitchen station config (beads legend-bopi2; PRD v1.7 §6 `stations`, F12
// "Konfigurasi stasiun dapur"). Contract: @starter/shared/kitchen
// `listKitchenStations` + `updateKitchenStations`, brief
// docs/briefs/sub-kds-station-save.md.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS in two fresh
// isolated tenants. Written against the contract and the brief, never against
// the service.
//
// Assumptions where the brief is silent:
// - Both routes are guarded by the outlet permission `kds.station.manage`;
//   `kds.ticket.process` alone (a cook) is refused.
// - A station the PUT does not name keeps its order and flags.
// - A station of another outlet/tenant, an unknown or a deleted station is
//   refused with 404 or 422 and nothing is saved (the brief allows both).
// - "No active station" is judged on the final merged state: a PUT that names
//   only some stations still fails when every other station is already off.
// - A station created before the config exists is active, has no fallback
//   print and the list shows it by `display_order` (ties are never relied on).
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as kitchen from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const short = () => randomUUID().slice(0, 6);

type Member = { client: ReturnType<typeof agent>; userId: string };
type Row = {
  stationId: string;
  displayOrder: number;
  isActive: boolean;
  autoPrintFallback: boolean;
};
type StationState = {
  id: string;
  display_order: number;
  is_active: boolean;
  auto_print_fallback: boolean;
};

const roleIds = {
  manage: randomUUID(),
  cook: randomUUID(),
  manageB: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let headersB: { Host: string };
let manager: Member; // kds.station.manage, tenant scope
let cook: Member; // kds.ticket.process only
let tenantBManager: Member;
let otherOutletId: string; // second outlet of tenant A
let otherOutletManager: Member; // kds.station.manage on that outlet only

async function member(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" | "outlet" | "station"; id: string | null },
  label: string,
): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId, scope.type, scope.id],
  );
  return { client, userId };
}

async function insertRole(
  tenantId: string,
  id: string,
  name: string,
  permissions: string[],
  scopes: string[],
) {
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, $5)`,
    [id, tenantId, name, JSON.stringify(permissions), JSON.stringify(scopes)],
  );
}

/** A fresh outlet of tenant A, so every scenario owns its stations. */
async function makeOutlet(label: string): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $1, tenant_id, brand_id, legal_entity_id, $2, $3, 'Jl. Uji 3', timezone, opening_hours, 'active'
     FROM outlets WHERE tenant_id = $4 AND id = $5`,
    [
      id,
      `ST-${short()}`.toUpperCase(),
      `Outlet ${label}`,
      tenant.tenantId,
      tenant.outletId,
    ],
  );
  return id;
}

async function makeStation(
  forTenant: IsolatedTenant,
  outletId: string,
  name: string,
  opts: { deleted?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO stations (id, tenant_id, outlet_id, name, type, deleted_at)
     VALUES ($1, $2, $3, $4, 'hot_kitchen', $5)`,
    [
      id,
      forTenant.tenantId,
      outletId,
      `${name} ${short()}`,
      opts.deleted ? new Date() : null,
    ],
  );
  return id;
}

/** Outlet with n live stations, in insertion order. */
async function seedOutlet(label: string, n: number) {
  const outletId = await makeOutlet(label);
  const stationIds: string[] = [];
  for (let i = 0; i < n; i++)
    stationIds.push(await makeStation(tenant, outletId, `${label}${i + 1}`));
  return { outletId, stationIds };
}

/** Raw display_order/flags of stations, as the owner connection sees them. */
async function stored(stationIds: string[]): Promise<StationState[]> {
  const { rows } = await owner.query<StationState>(
    `SELECT id, display_order, is_active, auto_print_fallback
     FROM stations WHERE id = ANY($1::uuid[]) ORDER BY array_position($1::uuid[], id)`,
    [stationIds],
  );
  return rows;
}

async function setState(
  stationId: string,
  patch: { order?: number; active?: boolean; fallback?: boolean },
) {
  await owner.query(
    `UPDATE stations SET display_order = COALESCE($2, display_order),
       is_active = COALESCE($3, is_active),
       auto_print_fallback = COALESCE($4, auto_print_fallback)
     WHERE id = $1`,
    [
      stationId,
      patch.order ?? null,
      patch.active ?? null,
      patch.fallback ?? null,
    ],
  );
}

function row(stationId: string, patch: Partial<Row> = {}): Row {
  return {
    stationId,
    displayOrder: 0,
    isActive: true,
    autoPrintFallback: false,
    ...patch,
  };
}

function api(
  who: Member | null,
  outletId: string,
  forHeaders: { Host: string } = headers,
) {
  const client = who?.client ?? agent(app);
  const path = `/api/outlets/${outletId}/kitchen/stations`;
  return {
    list: () => client.get(path).set(forHeaders).set(originHeader),
    save: (body: unknown) =>
      client
        .put(path)
        .set(forHeaders)
        .set(originHeader)
        .send(body as object),
  };
}

const listed = (body: { data: { stationId: string }[] }) =>
  body.data.map((r) => r.stationId);

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  tenant = await createIsolatedTenant(`stc-${short()}`);
  tenantB = await createIsolatedTenant(`stcb-${short()}`);
  headers = { Host: tenant.hostname };
  headersB = { Host: tenantB.hostname };

  await insertRole(
    tenant.tenantId,
    roleIds.manage,
    "Pengelola Stasiun",
    ["kds.station.manage"],
    ["tenant", "outlet"],
  );
  await insertRole(
    tenant.tenantId,
    roleIds.cook,
    "Koki Saja",
    ["kds.ticket.process"],
    ["tenant", "outlet", "station"],
  );
  await insertRole(
    tenantB.tenantId,
    roleIds.manageB,
    "Pengelola Stasiun B",
    ["kds.station.manage"],
    ["tenant"],
  );

  otherOutletId = await makeOutlet("Lain");
  manager = await member(
    tenant,
    roleIds.manage,
    { type: "tenant", id: null },
    "Pengelola Stasiun",
  );
  cook = await member(
    tenant,
    roleIds.cook,
    { type: "tenant", id: null },
    "Koki Stasiun",
  );
  otherOutletManager = await member(
    tenant,
    roleIds.manage,
    { type: "outlet", id: otherOutletId },
    "Pengelola Outlet Lain",
  );
  tenantBManager = await member(
    tenantB,
    roleIds.manageB,
    { type: "tenant", id: null },
    "Pengelola Tenant B",
  );
});

afterAll(async () => {
  // Rows stay in the disposable database, like the other KDS tests.
});

describe("contract", () => {
  it("serves the contract paths", () => {
    expect(kitchen.listKitchenStations.path).toBe(
      "/api/outlets/:outletId/kitchen/stations",
    );
    // The PUT moved from the web app's contract-gap into @starter/shared.
    expect(kitchen.updateKitchenStations?.method).toBe("PUT");
    expect(kitchen.updateKitchenStations?.path).toBe(
      "/api/outlets/:outletId/kitchen/stations",
    );
  });
});

describe("GET kitchen/stations", () => {
  it("lists the stations in display_order, with contract fields", async () => {
    const { outletId, stationIds } = await seedOutlet("G1", 3);
    const [a, b, c] = stationIds as [string, string, string];
    await setState(a, { order: 2 });
    await setState(b, { order: 0, fallback: true });
    await setState(c, { order: 1, active: false });

    const res = await api(manager, outletId).list();
    expect(res.status).toBe(200);
    const rows = kitchen.listKitchenStations.response.parse(res.body).data;
    expect(rows.map((r) => r.stationId)).toEqual([b, c, a]);
    expect(rows.map((r) => r.displayOrder)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.isActive)).toEqual([true, false, true]);
    expect(rows.map((r) => r.autoPrintFallback)).toEqual([true, false, false]);
    for (const r of rows) {
      expect(r.tenantId).toBe(tenant.tenantId);
      expect(r.outletId).toBe(outletId);
    }
    // Same answer on every call.
    expect((await api(manager, outletId).list()).body).toEqual(res.body);
  });

  it("shows a station without config as active, without fallback print", async () => {
    const { outletId, stationIds } = await seedOutlet("G2", 1);
    const res = await api(manager, outletId).list();
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      stationId: stationIds[0],
      isActive: true,
      autoPrintFallback: false,
    });
  });

  it("never lists a deleted station or one of another outlet or tenant", async () => {
    const { outletId, stationIds } = await seedOutlet("G3", 2);
    const deleted = await makeStation(tenant, outletId, "Hapus", {
      deleted: true,
    });
    const elsewhere = await seedOutlet("G3x", 1);
    const foreign = await makeStation(tenantB, tenantB.outletId, "Asing");

    const ids = listed((await api(manager, outletId).list()).body);
    expect(new Set(ids)).toEqual(new Set(stationIds));
    expect(ids).not.toContain(deleted);
    expect(ids).not.toContain(elsewhere.stationIds[0]);
    expect(ids).not.toContain(foreign);

    const theirs = await api(tenantBManager, tenantB.outletId, headersB).list();
    expect(theirs.status).toBe(200);
    expect(listed(theirs.body)).toContain(foreign);
    expect(listed(theirs.body)).not.toContain(stationIds[0]);
  });

  it("returns an empty list for an outlet without stations", async () => {
    const outletId = await makeOutlet("G4");
    const res = await api(manager, outletId).list();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("answers 401 without a session", async () => {
    expect((await api(null, tenant.outletId).list()).status).toBe(401);
  });

  it("lets a cook with kds.ticket.process only read the tabs of their reach", async () => {
    const { outletId, stationIds } = await seedOutlet("G6", 3);
    // Tenant-wide cook reaches every station of the outlet.
    const wide = await api(cook, outletId).list();
    expect(wide.status).toBe(200);
    expect(new Set(listed(wide.body))).toEqual(new Set(stationIds));
    // A station-scoped cook gets only their own station.
    const mine = stationIds[1]!;
    const stationCook = await member(
      tenant,
      roleIds.cook,
      { type: "station", id: mine },
      `Koki Satu Stasiun ${short()}`,
    );
    const narrow = await api(stationCook, outletId).list();
    expect(narrow.status).toBe(200);
    expect(listed(narrow.body)).toEqual([mine]);
    expect(
      kitchen.listKitchenStations.response.parse(narrow.body).data[0],
    ).toMatchObject({ stationId: mine, outletId, isActive: true });
    // Another outlet of the same tenant is out of their reach.
    const other = await seedOutlet("G6x", 1);
    const out = await api(stationCook, other.outletId).list();
    expect([403, 404]).toContain(out.status);
  });

  it("never lists a deleted station to a cook", async () => {
    const { outletId, stationIds } = await seedOutlet("G7", 1);
    const deleted = await makeStation(tenant, outletId, "Hapus", {
      deleted: true,
    });
    const ids = listed((await api(cook, outletId).list()).body);
    expect(ids).toEqual(stationIds);
    expect(ids).not.toContain(deleted);
  });

  it("still refuses a cook the save (403)", async () => {
    const { outletId, stationIds } = await seedOutlet("G8", 1);
    const before = await stored(stationIds);
    const res = await api(cook, outletId).save({
      stations: [row(stationIds[0]!, { displayOrder: 4 })],
    });
    expect(res.status).toBe(403);
    expect(await stored(stationIds)).toEqual(before);
  });

  it("answers 403 for a manager of another outlet", async () => {
    const { outletId } = await seedOutlet("G5", 1);
    expect((await api(otherOutletManager, outletId).list()).status).toBe(403);
  });

  it("serves an outlet-scoped manager their own outlet", async () => {
    const res = await api(otherOutletManager, otherOutletId).list();
    expect(res.status).toBe(200);
  });

  it("answers 403 or 404 for another tenant's outlet", async () => {
    const res = await api(tenantBManager, tenant.outletId, headersB).list();
    expect([403, 404]).toContain(res.status);
  });
});

describe("PUT kitchen/stations", () => {
  it("saves order, active flag and fallback print, and answers with the contract rows", async () => {
    const { outletId, stationIds } = await seedOutlet("P1", 3);
    const [a, b, c] = stationIds as [string, string, string];
    const res = await api(manager, outletId).save({
      stations: [
        row(a, { displayOrder: 2 }),
        row(b, { displayOrder: 0, autoPrintFallback: true }),
        row(c, { displayOrder: 1, isActive: false }),
      ],
    });
    expect(res.status).toBe(200);
    const rows = kitchen.updateKitchenStations.response.parse(res.body).data;
    // Answer is in the new display order, with the saved values.
    expect(rows.map((r) => r.stationId)).toEqual([b, c, a]);
    expect(rows.map((r) => r.displayOrder)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.isActive)).toEqual([true, false, true]);
    expect(rows.map((r) => r.autoPrintFallback)).toEqual([true, false, false]);
    for (const r of rows) {
      expect(r.tenantId).toBe(tenant.tenantId);
      expect(r.outletId).toBe(outletId);
    }
    // Stored, and a later GET returns exactly what the PUT answered.
    expect(
      (await stored([a, b, c])).map((s) => [
        s.display_order,
        s.is_active,
        s.auto_print_fallback,
      ]),
    ).toEqual([
      [2, true, false],
      [0, true, true],
      [1, false, false],
    ]);
    expect((await api(manager, outletId).list()).body.data).toEqual(
      res.body.data,
    );
  });

  it("can turn fallback print and a station back off", async () => {
    const { outletId, stationIds } = await seedOutlet("P2", 2);
    const [a, b] = stationIds as [string, string];
    await api(manager, outletId).save({
      stations: [
        row(a, { displayOrder: 0, autoPrintFallback: true }),
        row(b, { displayOrder: 1, isActive: false }),
      ],
    });
    const res = await api(manager, outletId).save({
      stations: [
        row(a, { displayOrder: 0, autoPrintFallback: false }),
        row(b, { displayOrder: 1, isActive: true }),
      ],
    });
    expect(res.status).toBe(200);
    expect(
      (await stored([a, b])).map((s) => [s.is_active, s.auto_print_fallback]),
    ).toEqual([
      [true, false],
      [true, false],
    ]);
  });

  it("leaves a station the body does not name as it was", async () => {
    const { outletId, stationIds } = await seedOutlet("P3", 3);
    const [a, b, c] = stationIds as [string, string, string];
    await setState(c, { order: 7, fallback: true });
    const res = await api(manager, outletId).save({
      stations: [
        row(a, { displayOrder: 1, isActive: false }),
        row(b, { displayOrder: 0 }),
      ],
    });
    expect(res.status).toBe(200);
    const untouched = (await stored([c]))[0]!;
    expect(untouched).toMatchObject({
      display_order: 7,
      is_active: true,
      auto_print_fallback: true,
    });
    expect(listed(res.body)).toContain(c);
  });

  it("is idempotent for the same list", async () => {
    const { outletId, stationIds } = await seedOutlet("P4", 2);
    const [a, b] = stationIds as [string, string];
    const body = {
      stations: [
        row(a, { displayOrder: 1 }),
        row(b, { displayOrder: 0, autoPrintFallback: true }),
      ],
    };
    const first = await api(manager, outletId).save(body);
    const second = await api(manager, outletId).save(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
  });

  it("accepts a single active station when the rest are switched off", async () => {
    const { outletId, stationIds } = await seedOutlet("P5", 2);
    const [a, b] = stationIds as [string, string];
    const res = await api(manager, outletId).save({
      stations: [
        row(a, { displayOrder: 0 }),
        row(b, { displayOrder: 1, isActive: false }),
      ],
    });
    expect(res.status).toBe(200);
  });

  it("accepts an outlet-scoped manager for that outlet", async () => {
    const id = await makeStation(tenant, otherOutletId, "Lokal");
    const res = await api(otherOutletManager, otherOutletId).save({
      stations: [row(id, { displayOrder: 3 })],
    });
    expect(res.status).toBe(200);
  });

  describe("no active station", () => {
    it("refuses a body that switches every station off and keeps the old state", async () => {
      const { outletId, stationIds } = await seedOutlet("N1", 2);
      const before = await stored(stationIds);
      const res = await api(manager, outletId).save({
        stations: stationIds.map((id, i) =>
          row(id, { displayOrder: i + 5, isActive: false }),
        ),
      });
      expect([400, 422]).toContain(res.status);
      expect(res.body.error).toBeDefined();
      expect(await stored(stationIds)).toEqual(before);
    });

    it("judges the merged result: naming one station is not enough to escape", async () => {
      const { outletId, stationIds } = await seedOutlet("N2", 3);
      const [a, b, c] = stationIds as [string, string, string];
      await setState(a, { active: false });
      await setState(b, { active: false });
      const before = await stored(stationIds);
      // Only c is active; the body switches c off and does not name a or b.
      const res = await api(manager, outletId).save({
        stations: [row(c, { displayOrder: 0, isActive: false })],
      });
      expect([400, 422]).toContain(res.status);
      expect(await stored(stationIds)).toEqual(before);
    });

    it("counts a station the body leaves out as active", async () => {
      const { outletId, stationIds } = await seedOutlet("N3", 2);
      const [a, b] = stationIds as [string, string];
      // b is not named and stays active, so switching a off is fine.
      const res = await api(manager, outletId).save({
        stations: [row(a, { displayOrder: 0, isActive: false })],
      });
      expect(res.status).toBe(200);
      expect((await stored([a, b])).map((s) => s.is_active)).toEqual([
        false,
        true,
      ]);
    });

    it("does not count a deleted station as active", async () => {
      const outletId = await makeOutlet("N4");
      const live = await makeStation(tenant, outletId, "Hidup");
      await makeStation(tenant, outletId, "Hapus", { deleted: true });
      const res = await api(manager, outletId).save({
        stations: [row(live, { isActive: false })],
      });
      expect([400, 422]).toContain(res.status);
      expect((await stored([live]))[0]!.is_active).toBe(true);
    });
  });

  describe("station ids", () => {
    it("refuses a duplicate station id and saves nothing", async () => {
      const { outletId, stationIds } = await seedOutlet("D1", 2);
      const [a, b] = stationIds as [string, string];
      const before = await stored(stationIds);
      const res = await api(manager, outletId).save({
        stations: [
          row(a, { displayOrder: 3 }),
          row(b, { displayOrder: 4 }),
          row(a, { displayOrder: 5 }),
        ],
      });
      expect(res.status).toBe(422);
      expect(await stored(stationIds)).toEqual(before);
    });

    it("refuses a station of another outlet of the same tenant, saving nothing", async () => {
      const mine = await seedOutlet("D2", 2);
      const theirs = await seedOutlet("D2x", 1);
      const before = await stored([...mine.stationIds, ...theirs.stationIds]);
      const res = await api(manager, mine.outletId).save({
        stations: [
          row(mine.stationIds[0]!, { displayOrder: 9 }),
          row(theirs.stationIds[0]!, { displayOrder: 9 }),
        ],
      });
      expect([404, 422]).toContain(res.status);
      expect(await stored([...mine.stationIds, ...theirs.stationIds])).toEqual(
        before,
      );
    });

    it("refuses a station of another tenant, saving nothing", async () => {
      const mine = await seedOutlet("D3", 2);
      const foreign = await makeStation(tenantB, tenantB.outletId, "Asing");
      const before = await stored([...mine.stationIds, foreign]);
      const res = await api(manager, mine.outletId).save({
        stations: [
          row(mine.stationIds[0]!, { displayOrder: 9 }),
          row(foreign, { displayOrder: 9 }),
        ],
      });
      expect([404, 422]).toContain(res.status);
      // The answer does not say the id exists in another tenant.
      expect(JSON.stringify(res.body)).not.toContain(tenantB.tenantId);
      expect(await stored([...mine.stationIds, foreign])).toEqual(before);
    });

    it("refuses an unknown station id", async () => {
      const { outletId, stationIds } = await seedOutlet("D4", 2);
      const before = await stored(stationIds);
      const res = await api(manager, outletId).save({
        stations: [row(stationIds[0]!, { displayOrder: 9 }), row(randomUUID())],
      });
      expect([404, 422]).toContain(res.status);
      expect(await stored(stationIds)).toEqual(before);
    });

    it("refuses a deleted station", async () => {
      const { outletId, stationIds } = await seedOutlet("D5", 1);
      const deleted = await makeStation(tenant, outletId, "Hapus", {
        deleted: true,
      });
      const before = await stored([...stationIds, deleted]);
      const res = await api(manager, outletId).save({
        stations: [row(stationIds[0]!), row(deleted, { displayOrder: 9 })],
      });
      expect([404, 422]).toContain(res.status);
      expect(await stored([...stationIds, deleted])).toEqual(before);
    });
  });

  describe("body validation (strict)", () => {
    const sid = () => randomUUID();
    const bad: [string, unknown][] = [
      ["an empty list", { stations: [] }],
      ["a missing list", {}],
      ["an unknown key on the body", { stations: [row(sid())], extra: 1 }],
      [
        "a tenant id on the body",
        { stations: [row(sid())], tenantId: randomUUID() },
      ],
      [
        "an unknown key on a station",
        { stations: [{ ...row(sid()), name: "x" }] },
      ],
      [
        "a negative display order",
        { stations: [row(sid(), { displayOrder: -1 })] },
      ],
      [
        "a display order above 1000",
        { stations: [row(sid(), { displayOrder: 3000000000 })] },
      ],
      [
        "a fractional display order",
        { stations: [row(sid(), { displayOrder: 1.5 })] },
      ],
      [
        "a non-boolean active flag",
        { stations: [{ ...row(sid()), isActive: "yes" }] },
      ],
      [
        "a missing fallback flag",
        {
          stations: [{ stationId: sid(), displayOrder: 0, isActive: true }],
        },
      ],
      ["a station id that is not an id", { stations: [row("bukan-id")] }],
      [
        "more than 100 stations",
        { stations: Array.from({ length: 101 }, () => row(sid())) },
      ],
    ];
    it.each(bad)("rejects %s with 422", async (_label, body) => {
      const { outletId, stationIds } = await seedOutlet(`V${short()}`, 1);
      const before = await stored(stationIds);
      const res = await api(manager, outletId).save(body);
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe("VALIDATION_ERROR");
      expect(await stored(stationIds)).toEqual(before);
    });
  });

  describe("authorization and isolation", () => {
    it("answers 401 without a session", async () => {
      const { outletId, stationIds } = await seedOutlet("A1", 1);
      const before = await stored(stationIds);
      const res = await api(null, outletId).save({
        stations: [row(stationIds[0]!, { displayOrder: 4 })],
      });
      expect(res.status).toBe(401);
      expect(await stored(stationIds)).toEqual(before);
    });

    it("answers 403 for a role without kds.station.manage", async () => {
      const { outletId, stationIds } = await seedOutlet("A2", 1);
      const before = await stored(stationIds);
      const res = await api(cook, outletId).save({
        stations: [row(stationIds[0]!, { displayOrder: 4 })],
      });
      expect(res.status).toBe(403);
      expect(await stored(stationIds)).toEqual(before);
    });

    it("answers 403 for a manager of another outlet", async () => {
      const { outletId, stationIds } = await seedOutlet("A3", 1);
      const before = await stored(stationIds);
      const res = await api(otherOutletManager, outletId).save({
        stations: [row(stationIds[0]!, { displayOrder: 4 })],
      });
      expect(res.status).toBe(403);
      expect(await stored(stationIds)).toEqual(before);
    });

    it("never reaches another tenant's outlet or stations", async () => {
      const { outletId, stationIds } = await seedOutlet("A4", 1);
      const theirs = await makeStation(tenantB, tenantB.outletId, "Asing");
      const before = await stored([...stationIds, theirs]);
      // Tenant B's manager names tenant A's outlet.
      const cross = await api(tenantBManager, outletId, headersB).save({
        stations: [row(stationIds[0]!, { displayOrder: 4 })],
      });
      expect([403, 404]).toContain(cross.status);
      // Tenant A's manager on tenant B's host.
      const host = await api(manager, tenantB.outletId, headersB).save({
        stations: [row(theirs, { displayOrder: 4 })],
      });
      expect([401, 403, 404]).toContain(host.status);
      expect(await stored([...stationIds, theirs])).toEqual(before);
    });
  });
});
