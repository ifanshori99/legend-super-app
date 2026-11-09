// KDS cook reads (bead legend-gt7f; PRD v1.7 §3 F12 KDS): a cook or barista who
// holds only `kds.ticket.process` reads the labels of their stations and the
// capacity rules of one station, without `menu.item.view` or
// `kds.station.manage`.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable
// server from `pnpm test`) in fresh isolated tenants.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  stationCapacityRuleSchema,
  stationLabelSchema,
} from "@starter/shared/kitchen";
import { createApp } from "../app.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ids = {
  kdsRole: randomUUID(),
  kdsRoleB: randomUUID(),
  noKdsRole: randomUUID(),
  outletB: randomUUID(),
  // outlet A
  barA: randomUUID(),
  kitchenA: randomUUID(),
  idleA: randomUUID(),
  // outlet B
  barB: randomUUID(),
  // other tenant
  stationX: randomUUID(),
};

type Member = { client: ReturnType<typeof agent>; userId: string };

let app: Express;
let tenant: IsolatedTenant;
let tenantB: IsolatedTenant;
let headers: { Host: string };
let headersB: { Host: string };
let cook: Member; // tenant scope
let barista: Member; // station bar A only
let outletBStaff: Member; // outlet B only
let noKds: Member;
let tenantBCook: Member;

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
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

const labels = (
  who: Member,
  outletId: string,
  host: { Host: string } = headers,
) =>
  who.client
    .get(`/api/outlets/${outletId}/kitchen/station-labels`)
    .set(host)
    .set(originHeader);

const rules = (
  who: Member,
  outletId: string,
  stationId: string,
  host: { Host: string } = headers,
) =>
  who.client
    .get(
      `/api/outlets/${outletId}/kitchen/stations/${stationId}/capacity-rules`,
    )
    .set(host)
    .set(originHeader);

const idsOf = (body: { data: { stationId: string }[] }) =>
  body.data.map((row) => row.stationId).sort();

async function insertRule(
  forTenant: IsolatedTenant,
  outletId: string,
  stationId: string,
  windowMinutes: number,
  points: number,
) {
  await asOwnerTenant(forTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO kitchen_capacity_rules
         (tenant_id, outlet_id, station_id, window_minutes, capacity_points,
          near_capacity_bp, schedule, channel_priority)
       VALUES ($1, $2, $3, $4, $5, 8000, $6::jsonb, $7::jsonb)`,
      [
        forTenant.tenantId,
        outletId,
        stationId,
        windowMinutes,
        points,
        JSON.stringify([
          { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "08:00", end: "22:00" },
        ]),
        JSON.stringify(["dine_in", "takeaway"]),
      ],
    ),
  );
}

beforeAll(async () => {
  app = createApp();
  tenant = await createIsolatedTenant(`kdssum-${randomUUID().slice(0, 6)}`);
  tenantB = await createIsolatedTenant(`kdssumb-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  headersB = { Host: tenantB.hostname };

  await insertRole(
    tenant.tenantId,
    ids.kdsRole,
    "KDS Ringkasan Uji",
    ["kds.ticket.process"],
    ["tenant", "outlet", "station"],
  );
  await insertRole(
    tenant.tenantId,
    ids.noKdsRole,
    "Tanpa KDS Uji",
    ["order.view"],
    ["tenant"],
  );
  await insertRole(
    tenantB.tenantId,
    ids.kdsRoleB,
    "KDS Ringkasan Tenant B",
    ["kds.ticket.process"],
    ["tenant"],
  );

  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       SELECT $1, tenant_id, brand_id, legal_entity_id, $2, 'Outlet Ringkasan B', 'Jl. Uji 2', timezone, opening_hours, 'active'
       FROM outlets WHERE tenant_id = $3 AND id = $4`,
      [
        ids.outletB,
        `SB-${randomUUID().slice(0, 6)}`.toUpperCase(),
        tenant.tenantId,
        tenant.outletId,
      ],
    );
    const stations: [string, string, string, string][] = [
      [ids.barA, tenant.outletId, "Bar A", "beverage_bar"],
      [ids.kitchenA, tenant.outletId, "Dapur A", "hot_kitchen"],
      [ids.idleA, tenant.outletId, "Pastry A", "pastry"],
      [ids.barB, ids.outletB, "Bar B", "beverage_bar"],
    ];
    for (const [id, outletId, name, type] of stations)
      await client.query(
        `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
        [id, tenant.tenantId, outletId, name, type],
      );
  });
  await asOwnerTenant(tenantB.tenantId, async (client) => {
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Bar X', 'beverage_bar')`,
      [ids.stationX, tenantB.tenantId, tenantB.outletId],
    );
  });

  cook = await member(
    tenant,
    ids.kdsRole,
    { type: "tenant", id: null },
    "Sum Koki",
  );
  barista = await member(
    tenant,
    ids.kdsRole,
    { type: "station", id: ids.barA },
    "Sum Barista",
  );
  outletBStaff = await member(
    tenant,
    ids.kdsRole,
    { type: "outlet", id: ids.outletB },
    "Sum Outlet B",
  );
  noKds = await member(
    tenant,
    ids.noKdsRole,
    { type: "tenant", id: null },
    "Sum Tanpa KDS",
  );
  tenantBCook = await member(
    tenantB,
    ids.kdsRoleB,
    { type: "tenant", id: null },
    "Sum Tenant B",
  );

  await insertRule(tenant, tenant.outletId, ids.barA, 30, 20);
  await insertRule(tenant, tenant.outletId, ids.barA, 15, 10);
  await insertRule(tenant, tenant.outletId, ids.kitchenA, 15, 99);
  await insertRule(tenant, ids.outletB, ids.barB, 15, 77);
  await insertRule(tenantB, tenantB.outletId, ids.stationX, 15, 55);
});

afterAll(async () => {
  // Isolated tenants stay in the disposable database; give them a valid
  // creator so the platform tenant list parses (as kds.test.ts does).
  for (const t of [tenant, tenantB])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("legend-gt7f cook reads", () => {
  it("a station-only cook reads the label of their own station and no other", async () => {
    const response = await labels(barista, tenant.outletId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = stationLabelSchema.array().parse(response.body.data);
    expect(rows.map((row) => row.stationId)).toEqual([ids.barA]);
    expect(rows[0]).toMatchObject({ name: "Bar A", type: "beverage_bar" });
    expect(Object.keys(response.body.data[0]).sort()).toEqual([
      "name",
      "stationId",
      "targetSeconds",
      "type",
    ]);
  });

  it("an outlet-wide cook reads every station label of the outlet, by name", async () => {
    const response = await labels(cook, tenant.outletId);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.map((row: { name: string }) => row.name)).toEqual(
      ["Bar A", "Dapur A", "Pastry A"],
    );
  });

  it("a cook reads their station's capacity rules in a slim shape, ordered by window", async () => {
    const response = await rules(barista, tenant.outletId, ids.barA);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const rows = stationCapacityRuleSchema.array().parse(response.body.data);
    expect(rows.map((row) => row.windowMinutes)).toEqual([15, 30]);
    expect(rows.map((row) => row.capacityPoints)).toEqual([10, 20]);
    for (const row of response.body.data)
      expect(Object.keys(row).sort()).toEqual([
        "capacityPoints",
        "channelPriority",
        "nearCapacityBp",
        "schedule",
        "stationId",
        "windowMinutes",
      ]);
    expect(JSON.stringify(response.body)).not.toContain(tenant.tenantId);
  });

  it("a station with no rules answers an empty list", async () => {
    const response = await rules(cook, tenant.outletId, ids.idleA);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual([]);
  });

  it("a cook of station A cannot read the rules of another station of the same outlet", async () => {
    expect((await rules(barista, tenant.outletId, ids.kitchenA)).status).toBe(
      403,
    );
  });

  it("TEN-03 outlet B staff cannot read outlet A labels or rules, and read their own", async () => {
    expect((await labels(outletBStaff, tenant.outletId)).status).toBe(403);
    expect((await rules(outletBStaff, tenant.outletId, ids.barA)).status).toBe(
      403,
    );
    const own = await rules(outletBStaff, ids.outletB, ids.barB);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(
      own.body.data.map(
        (row: { capacityPoints: number }) => row.capacityPoints,
      ),
    ).toEqual([77]);
    const ownLabels = await labels(outletBStaff, ids.outletB);
    expect(idsOf(ownLabels.body)).toEqual([ids.barB]);
  });

  it("TEN-03 a station of outlet A under the outlet B path is not read across", async () => {
    for (const who of [cook, barista]) {
      const response = await rules(who, ids.outletB, ids.barA);
      expect([403, 404]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain('"capacityPoints"');
    }
  });

  it("TEN-01 another tenant's cook cannot read this tenant's labels or rules", async () => {
    for (const host of [headersB, headers]) {
      const l = await labels(tenantBCook, tenant.outletId, host);
      expect([401, 403, 404], String(host.Host)).toContain(l.status);
      const r = await rules(tenantBCook, tenant.outletId, ids.barA, host);
      expect([401, 403, 404], String(host.Host)).toContain(r.status);
    }
    const own = await rules(
      tenantBCook,
      tenantB.outletId,
      ids.stationX,
      headersB,
    );
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data[0].capacityPoints).toBe(55);
  });

  it("a cook cannot replace capacity rules (PUT stays kds.station.manage)", async () => {
    const response = await barista.client
      .put(
        `/api/outlets/${tenant.outletId}/kitchen/stations/${ids.barA}/capacity-rules`,
      )
      .set(headers)
      .set(originHeader)
      .send({ rules: [] });
    expect(response.status).toBe(403);
    const after = await rules(barista, tenant.outletId, ids.barA);
    expect(after.body.data).toHaveLength(2);
  });

  it("staff without kds.ticket.process get 403, anonymous callers 401", async () => {
    expect((await labels(noKds, tenant.outletId)).status).toBe(403);
    expect((await rules(noKds, tenant.outletId, ids.barA)).status).toBe(403);
    const anonymous = await agent(app)
      .get(`/api/outlets/${tenant.outletId}/kitchen/station-labels`)
      .set(headers)
      .set(originHeader);
    expect(anonymous.status).toBe(401);
  });
});
