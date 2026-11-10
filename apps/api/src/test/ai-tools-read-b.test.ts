// WS-12 read tools TL-07, TL-08, TL-10, TL-11, TL-12, TL-20 against PostgreSQL
// (bead legend-ktqc; PRD v1.7 §39 TL table, §40 AIG-01, TEN-01..03). Runs the
// real handlers with the restricted app role (RLS enforced) and an
// AccessSnapshot built from the RBAC fixtures. Seeds go through the owner
// connection; event rows (voids, waste, discounts) are inserted with
// `session_replication_role = replica` so the append-only triggers and the
// order/FK parents of the POS tables do not have to be built for a read test.
//
// TL-09 (get_my_payslip) is not registered (no payslip storage exists), so it
// has no test here. TL-07, TL-08 and TL-12 have no data source yet: they are
// tested for their access rules and the empty contract shape.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cafeLegendAccessFixtures,
  roleAssignmentSchema,
} from "@starter/shared/access";
import { AI_TOOL_IO, TOOL_MAX_ROWS, type AiToolCode } from "@starter/shared/ai";
import { establishTenantContext } from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { readToolsB } from "../services/ai-tools/read-b/index.ts";
import {
  sopQueryTokens,
  sopSnippet,
} from "../services/ai-tools/read-b/tl-10-search-sop.ts";
import type { AiToolContext } from "../services/ai-tools/types.ts";
import { resolveAccessSnapshot } from "../services/permission-resolver.ts";

const fx = cafeLegendAccessFixtures;
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = fx.outletIds.bandung;
const outletB = fx.outletIds.bandung2;
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();
const publisher = randomUUID();
const otherEmployeeUser = randomUUID();
const tenantObject = establishTenantContext({
  tenantId,
  brandId: null,
  source: "session",
});

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
  replica = false,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
    );
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

function ctxFor(
  userKey: keyof typeof fx.users,
  extraAssignments: typeof fx.assignments = [],
): AiToolContext {
  return {
    access: resolveAccessSnapshot({
      tenant: tenantObject,
      userId: fx.users[userKey].id,
      assignments: [...fx.assignments, ...extraAssignments],
      roles: fx.roles,
      org: fx.org,
      mfaVerified: false,
      now: fx.now,
    }),
    channel: "tanya_ai",
    mcpClientId: null,
    now: fx.now,
  };
}

type ToolRow = Record<string, unknown>;
type ToolOut = {
  results: ToolRow[];
  anomalies: ToolRow[];
  rows: ToolRow[];
  sources: ToolRow[];
  shifts: ToolRow[];
  segments: unknown[];
  distributions: unknown[];
  truncated: boolean;
};

/** Calls the registered handler and checks the result against the catalog schema. */
async function call(
  code: AiToolCode,
  userKey: keyof typeof fx.users,
  input: Record<string, unknown>,
) {
  const handler = readToolsB[code];
  if (!handler) throw new Error(`No handler for ${code}`);
  const parsedInput = AI_TOOL_IO[code].input.parse(input);
  const output = await handler(ctxFor(userKey), parsedInput);
  return AI_TOOL_IO[code].output.parse(output) as unknown as ToolOut;
}

const forbidden = { code: "AI_TOOL_FORBIDDEN", status: 403 };

// ---- Seeds -----------------------------------------------------------------

const createdSop: string[] = [];
const createdFacilities: { tenant: string; id: string }[] = [];
let employeeId = "";
let otherEmployeeId = "";
let kitchenLeadEmployeeId = "";
let stationOutletB = "";

async function seedUser(id: string) {
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Read B', $2) ON CONFLICT (id) DO NOTHING`,
    [id, `${id}@example.test`],
  );
}

async function seedEmployee(userId: string, outletId: string): Promise<string> {
  const id = randomUUID();
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employee_no, full_name, home_outlet_id,
                              employment_type, join_date, status)
       VALUES ($1, $2, $3, $4, 'Karyawan Read B', $5, 'pkwtt', '2025-03-01', 'active')`,
      [id, tenantId, userId, `RB-${id.slice(0, 8).toUpperCase()}`, outletId],
    ),
  );
  return id;
}

async function seedSop(options: {
  tenant?: string;
  title: string;
  body: string;
  stationId?: string | null;
  version?: number;
  supersedes?: string;
  lineage?: string;
}): Promise<string> {
  const id = randomUUID();
  const tenant = options.tenant ?? tenantId;
  const version = options.version ?? 1;
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO sop_documents (id, tenant_id, lineage_id, version, supersedes_id, station_id, title, body,
                                  requires_acknowledgement, effective_from, published_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, '2026-01-01', $9)`,
      [
        id,
        tenant,
        options.lineage ?? id,
        version,
        options.supersedes ?? null,
        options.stationId ?? null,
        options.title,
        options.body,
        publisher,
      ],
    ),
  );
  createdSop.push(id);
  return id;
}

type SeededFacility = {
  id: string;
  areaId: string;
  productId: string;
  units: string[];
};

async function seedFacility(options: {
  tenant: string;
  outletId: string;
  name: string;
}): Promise<SeededFacility> {
  const id = randomUUID();
  const areaId = randomUUID();
  const productId = randomUUID();
  const units = [randomUUID(), randomUUID()];
  await asOwner(options.tenant, async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, $4, 'shower', 60, 10, 10, $5, $6, $7)`,
      [
        id,
        options.tenant,
        options.outletId,
        options.name,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "08:00",
            closesAt: "20:00",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    );
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area', 0)`,
      [areaId, options.tenant, options.outletId, id],
    );
    for (const [index, unitId] of units.entries())
      await client.query(
        `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, 'available', $7)`,
        [
          unitId,
          options.tenant,
          options.outletId,
          id,
          areaId,
          `U${index + 1}`,
          index,
        ],
      );
    await client.query(
      `INSERT INTO facility_products (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions)
       VALUES ($1, $2, $3, $4, 'Tiket', 'single', 50000, 1)`,
      [productId, options.tenant, options.outletId, id],
    );
  });
  createdFacilities.push({ tenant: options.tenant, id });
  return { id, areaId, productId, units };
}

async function seedTicket(
  tenant: string,
  outletId: string,
  facility: SeededFacility,
  input: {
    unit: number;
    startsAt: string;
    minutes: number;
    status: string;
    source?: string;
    overtimeFee?: number;
  },
) {
  const start = Date.parse(input.startsAt);
  const end = start + input.minutes * 60_000;
  await asOwner(tenant, (client) =>
    client.query(
      `INSERT INTO access_tickets (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id,
                                   product_id, source, starts_at, ends_at, cleaning_ends_at, grace_minutes,
                                   status, overtime_fee_idr)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 10, $13, $14)`,
      [
        randomUUID(),
        tenant,
        outletId,
        facility.id,
        facility.areaId,
        facility.units[input.unit],
        randomUUID(),
        facility.productId,
        input.source ?? "purchase",
        new Date(start).toISOString(),
        new Date(end).toISOString(),
        new Date(end + 10 * 60_000).toISOString(),
        input.status,
        input.overtimeFee ?? 0,
      ],
    ),
  );
}

async function seedVoids(tenant: string, outletId: string, isoTimes: string[]) {
  await asOwner(
    tenant,
    async (client) => {
      for (const [index, at] of isoTimes.entries())
        await client.query(
          `INSERT INTO pos_order_voids (id, tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason,
                                        reason_note, requested_by, approved_by, approval_request_id, voided_at)
           VALUES ($1, $2, $3, $4, $5, 25000, 'wrong_item', 'salah input', 'kasir-a', 'spv-b', $6, $7)`,
          [
            randomUUID(),
            tenant,
            outletId,
            randomUUID(),
            `RB-${index}-${randomUUID().slice(0, 6)}`,
            randomUUID(),
            at,
          ],
        );
    },
    true,
  );
}

async function seedWaste(
  tenant: string,
  outletId: string,
  isoTimes: string[],
  valueIdr: number,
) {
  await asOwner(
    tenant,
    async (client) => {
      for (const at of isoTimes)
        await client.query(
          `INSERT INTO waste_logs (id, tenant_id, outlet_id, location_id, target_type, target_id, quantity,
                                   reason, value_idr, logged_by, occurred_at)
           VALUES ($1, $2, $3, $4, 'inventory_item', $5, 1, 'spoiled', $6, $7, $8)`,
          [
            randomUUID(),
            tenant,
            outletId,
            randomUUID(),
            randomUUID(),
            valueIdr,
            publisher,
            at,
          ],
        );
    },
    true,
  );
}

async function seedDiscounts(
  tenant: string,
  outletId: string,
  isoTimes: string[],
  amountIdr: number,
) {
  await asOwner(
    tenant,
    async (client) => {
      for (const at of isoTimes)
        await client.query(
          `INSERT INTO pos_order_discounts (id, tenant_id, outlet_id, order_id, source, kind, amount_idr, reason,
                                            reason_note, applied_by, created_at)
           VALUES ($1, $2, $3, $4, 'manual', 'amount', $5, 'loyal', 'pelanggan setia', 'kasir-a', $6)`,
          [randomUUID(), tenant, outletId, randomUUID(), amountIdr, at],
        );
    },
    true,
  );
}

let facilityA: SeededFacility;
const PERIOD = { from: "2026-10-05", to: "2026-10-05" };
const ANOMALY_PERIOD = { from: "2026-09-15", to: "2026-09-21" };

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  expect(fx.tenantId).toBe(tenantId);
  expect(outletA).toBe(cafeLegendPlatformFixtures.outlets[0].id);
  expect(outletB).toBe(cafeLegendPlatformFixtures.outlets[1].id);

  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Read B other tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `read-b-${otherTenant.slice(0, 8)}`, tenantId],
  );
  await asOwner(otherTenant, async (client) => {
    await client.query(
      `INSERT INTO brands (id, tenant_id, slug, name) VALUES ($1, $2, 'b', 'Brand B')`,
      [otherBrand, otherTenant],
    );
    await client.query(
      `INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'PT B', false)`,
      [otherEntity, otherTenant],
    );
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'B-01', 'Outlet B', 'Jl. B', 'Asia/Jakarta',
               '{"mon":{"opens":"08:00","closes":"22:00"}}', 'active')`,
      [otherOutlet, otherTenant, otherBrand, otherEntity],
    );
  });

  for (const id of [
    publisher,
    fx.users.employee.id,
    fx.users.kitchenLead.id,
    otherEmployeeUser,
  ])
    await seedUser(id);
  employeeId = await seedEmployee(fx.users.employee.id, outletA);
  otherEmployeeId = await seedEmployee(otherEmployeeUser, outletA);
  // Manager of outlet A whose own home outlet is B (see the TL-10 two-reach test).
  kitchenLeadEmployeeId = await seedEmployee(fx.users.kitchenLead.id, outletB);

  stationOutletB = randomUUID();
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type)
       VALUES ($1, $2, $3, 'Read B stasiun', 'coffee_bar')`,
      [stationOutletB, tenantId, outletB],
    ),
  );

  // TL-20 data: facility in outlet A (2 units, open 08:00-20:00), one in the
  // other tenant.
  facilityA = await seedFacility({
    tenant: tenantId,
    outletId: outletA,
    name: "Read B Shower",
  });
  // 2026-10-05 10:00 WIB = 03:00Z. Two completed hours on two units, an
  // overtime fee, one cancelled and one hold (neither counts), one package
  // ticket (counts as a session, no price) and one on the next day.
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 0,
    startsAt: "2026-10-05T03:00:00Z",
    minutes: 60,
    status: "completed",
    overtimeFee: 5000,
  });
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 1,
    startsAt: "2026-10-05T03:00:00Z",
    minutes: 60,
    status: "completed",
  });
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 1,
    startsAt: "2026-10-05T06:00:00Z",
    minutes: 60,
    status: "cancelled",
  });
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 0,
    startsAt: "2026-10-05T08:00:00Z",
    minutes: 60,
    status: "pending_payment",
  });
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 0,
    startsAt: "2026-10-05T10:00:00Z",
    minutes: 60,
    status: "issued",
    source: "package",
  });
  await seedTicket(tenantId, outletA, facilityA, {
    unit: 0,
    startsAt: "2026-10-06T03:00:00Z",
    minutes: 60,
    status: "completed",
  });
  const foreign = await seedFacility({
    tenant: otherTenant,
    outletId: otherOutlet,
    name: "Read B Foreign",
  });
  await seedTicket(otherTenant, otherOutlet, foreign, {
    unit: 0,
    startsAt: "2026-10-05T03:00:00Z",
    minutes: 60,
    status: "completed",
  });
  // 201 facilities in outlet B for the row cap.
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       SELECT gen_random_uuid(), $1, $2, 'Read B Cap ' || lpad(n::text, 3, '0'), 'locker', 60, 10, 10, $3::jsonb, $4::jsonb, $5::jsonb
         FROM generate_series(1, 201) n`,
      [
        tenantId,
        outletB,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "08:00",
            closesAt: "20:00",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    ),
  );

  // TL-11 data (period 2026-09-15..21, baseline 2026-09-08..14, WIB days).
  const inPeriod = [
    "2026-09-17T05:00:00Z",
    "2026-09-17T06:00:00Z",
    "2026-09-18T05:00:00Z",
    "2026-09-19T05:00:00Z",
  ];
  await seedVoids(tenantId, outletA, [...inPeriod, "2026-09-10T05:00:00Z"]);
  await seedVoids(tenantId, outletB, inPeriod);
  await seedVoids(otherTenant, otherOutlet, [...inPeriod, ...inPeriod]);
  await seedWaste(tenantId, outletA, inPeriod.slice(0, 3), 100_000);
  await seedWaste(tenantId, outletA, ["2026-09-10T05:00:00Z"], 100_000);
  await seedDiscounts(tenantId, outletA, inPeriod.slice(0, 3), 20_000);
  // Below the minimum event count: never reported.
  await seedVoids(tenantId, outletB, ["2026-09-10T05:00:00Z"]);
});

afterAll(async () => {
  await asOwner(
    tenantId,
    async (client) => {
      for (const table of [
        "pos_order_voids",
        "waste_logs",
        "pos_order_discounts",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND outlet_id = ANY($2)`,
          [tenantId, [outletA, outletB]],
        );
    },
    true,
  );
  await asOwner(
    otherTenant,
    (client) =>
      client.query("DELETE FROM pos_order_voids WHERE tenant_id = $1", [
        otherTenant,
      ]),
    true,
  );
  for (const f of createdFacilities)
    await asOwner(f.tenant, async (client) => {
      for (const table of [
        "access_tickets",
        "facility_products",
        "facility_units",
        "facility_areas",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = $2`,
          [f.tenant, f.id],
        );
      await client.query(
        "DELETE FROM facilities WHERE tenant_id = $1 AND id = $2",
        [f.tenant, f.id],
      );
    });
  await asOwner(tenantId, async (client) => {
    await client.query(
      "DELETE FROM facilities WHERE tenant_id = $1 AND name LIKE 'Read B Cap %'",
      [tenantId],
    );
    await client.query(
      "DELETE FROM sop_documents WHERE tenant_id = $1 AND published_by = $2",
      [tenantId, publisher],
    );
    await client.query(
      "DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, [employeeId, otherEmployeeId, kitchenLeadEmployeeId]],
    );
    await client.query(
      "DELETE FROM stations WHERE tenant_id = $1 AND id = $2",
      [tenantId, stationOutletB],
    );
  });
  await asOwner(otherTenant, async (client) => {
    await client.query("DELETE FROM sop_documents WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM outlets WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM legal_entities WHERE tenant_id = $1", [
      otherTenant,
    ]);
    await client.query("DELETE FROM brands WHERE tenant_id = $1", [
      otherTenant,
    ]);
  });
  await owner.query("DELETE FROM tenants WHERE id = $1", [otherTenant]);
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [
    [publisher, fx.users.employee.id, otherEmployeeUser],
  ]);
  await owner.end();
});

// ---- Registry --------------------------------------------------------------

describe("readToolsB registry", () => {
  it("registers TL-07, 08, 10, 11, 12, 20 and leaves TL-09 to the engineer", () => {
    expect(Object.keys(readToolsB).sort()).toEqual([
      "TL-07",
      "TL-08",
      "TL-10",
      "TL-11",
      "TL-12",
      "TL-20",
    ]);
  });
});

// ---- TL-07 -----------------------------------------------------------------

describe("TL-07 get_customer_segments", () => {
  it("marketing gets an aggregate-only shape with a source", async () => {
    const out = await call("TL-07", "marketing", { segmentBy: "tier" });
    expect(out.segments).toEqual([]);
    expect(out.sources).toHaveLength(1);
    expect(JSON.stringify(out)).not.toMatch(/email|phone|nama/i);
  });

  it("a role without crm.customer.view is forbidden", async () => {
    await expect(
      call("TL-07", "employee", { segmentBy: "tier" }),
    ).rejects.toMatchObject(forbidden);
  });
});

// ---- TL-08 -----------------------------------------------------------------

describe("TL-08 get_shift_schedule", () => {
  const period = { from: "2026-10-05", to: "2026-10-11" };

  it("an employee reads their own schedule (no id, or their own id)", async () => {
    expect((await call("TL-08", "employee", { period })).shifts).toEqual([]);
    expect(
      (await call("TL-08", "employee", { period, employeeId: employeeId }))
        .truncated,
    ).toBe(false);
  });

  it("an employee asking for another employee is forbidden, never rewritten", async () => {
    await expect(
      call("TL-08", "employee", { period, employeeId: otherEmployeeId }),
    ).rejects.toMatchObject(forbidden);
  });

  it("a manager with hr.schedule.manage reads outlets they reach", async () => {
    expect(
      (await call("TL-08", "hr", { period, outletIds: [outletA] })).truncated,
    ).toBe(false);
  });

  it("a role with neither schedule permission is forbidden", async () => {
    await expect(
      call("TL-08", "shareholder", { period }),
    ).rejects.toMatchObject(forbidden);
  });
});

// ---- TL-10 -----------------------------------------------------------------

describe("TL-10 search_sop", () => {
  it("tokenizes safely and builds a snippet around the first match", () => {
    expect(
      sopQueryTokens("Bagaimana cara 'membersihkan' mesin & espresso!? a"),
    ).toEqual(["bagaimana", "cara", "membersihkan", "mesin", "espresso"]);
    expect(
      sopSnippet(
        "x ".repeat(100) + "espresso dibersihkan tiap shift",
        "Judul",
        ["espresso"],
      ),
    ).toContain("espresso");
  });

  it("an employee finds the latest version of a tenant-wide SOP with source and link", async () => {
    const v1 = await seedSop({
      title: "SOP Mesin Espresso",
      body: "Bersihkan mesin espresso setiap tutup shift dengan sabun khusus.",
    });
    const v2 = await seedSop({
      title: "SOP Mesin Espresso",
      body: "Bersihkan mesin espresso setiap shift dengan sabun khusus dan bilas dua kali.",
      version: 2,
      supersedes: v1,
      lineage: v1,
    });
    const out = await call("TL-10", "employee", {
      query: "cara membersihkan mesin espresso",
    });
    expect(out.results.map((r) => r.knowledgeChunkId)).toEqual([v2]);
    expect(out.results[0]).toMatchObject({
      title: "SOP Mesin Espresso",
      sourceVersion: "v2",
      link: `/sop/${v2}`,
    });
    expect(out.results[0].snippet).toContain("espresso");
    expect(out.truncated).toBe(false);
  });

  it("returns nothing when no SOP matches", async () => {
    const out = await call("TL-10", "employee", { query: "zzzxqwv" });
    expect(out.results).toEqual([]);
  });

  it("a station SOP of another outlet is hidden from an employee and an outlet manager but not a wider manager", async () => {
    const id = await seedSop({
      title: "SOP Latte Art Khusus Cabang Dua",
      body: "Prosedur latte art kupuwukapro hanya untuk cabang dua.",
      stationId: stationOutletB,
    });
    const query = { query: "kupuwukapro" };
    expect((await call("TL-10", "employee", query)).results).toEqual([]);
    expect((await call("TL-10", "kitchenLead", query)).results).toEqual([]);
    const wide = await call("TL-10", "generalManager", query);
    expect(wide.results.map((r) => r.knowledgeChunkId)).toEqual([id]);
  });

  it("a manager of outlet A who is an employee of outlet B also finds outlet B station SOPs", async () => {
    const stationB = await seedSop({
      title: "SOP Stasiun Cabang Dua Pegawai",
      body: "Prosedur stasiun duakuwuprokb khusus pegawai cabang dua.",
      stationId: stationOutletB,
    });
    const tenantWide = await seedSop({
      title: "SOP Umum Duakuwuprokb",
      body: "Prosedur umum duakuwuprokb untuk semua cabang.",
    });
    const base = fx.assignments.find((a) => a.userId === fx.users.employee.id);
    if (!base) throw new Error("employee assignment fixture missing");
    const ctx = ctxFor("kitchenLead", [
      roleAssignmentSchema.parse({
        ...base,
        id: randomUUID(),
        userId: fx.users.kitchenLead.id,
        scope: { type: "outlet", id: outletB },
      }),
    ]);
    const handler = readToolsB["TL-10"];
    if (!handler) throw new Error("No handler for TL-10");
    const out = AI_TOOL_IO["TL-10"].output.parse(
      await handler(
        ctx,
        AI_TOOL_IO["TL-10"].input.parse({ query: "duakuwuprokb" }),
      ),
    ) as unknown as ToolOut;
    expect(out.results.map((r) => r.knowledgeChunkId).sort()).toEqual(
      [stationB, tenantWide].sort(),
    );
    // Without the employee assignment the manager (outlet A only) misses it.
    const managerOnly = await call("TL-10", "kitchenLead", {
      query: "duakuwuprokb",
    });
    expect(managerOnly.results.map((r) => r.knowledgeChunkId)).toEqual([
      tenantWide,
    ]);
  });

  it("another tenant's SOP is never returned", async () => {
    const foreignId = await seedSop({
      tenant: otherTenant,
      title: "SOP Rahasia Tenant Lain",
      body: "Prosedur rahasia tenantlain pastikan jangan bocor tenantlain.",
    });
    for (const user of ["owner", "generalManager", "employee"] as const) {
      const out = await call("TL-10", user, { query: "tenantlain rahasia" });
      expect(out.results.map((r) => r.knowledgeChunkId)).not.toContain(
        foreignId,
      );
    }
  });

  it("caps results at the limit and flags truncation", async () => {
    for (let n = 0; n < 3; n += 1)
      await seedSop({
        title: `SOP Kapasitas ${n}`,
        body: "kapasitasuji prosedur harian kapasitasuji.",
      });
    const out = await call("TL-10", "generalManager", {
      query: "kapasitasuji",
      limit: 2,
    });
    expect(out.results).toHaveLength(2);
    expect(out.truncated).toBe(true);
  });

  it("a role that can see no SOP is forbidden", async () => {
    await expect(
      call("TL-10", "shareholder", { query: "espresso" }),
    ).rejects.toMatchObject(forbidden);
  });
});

// ---- TL-11 -----------------------------------------------------------------

describe("TL-11 get_anomalies", () => {
  it("flags a void spike against the previous period, per outlet, with severity", async () => {
    const out = await call("TL-11", "owner", {
      period: ANOMALY_PERIOD,
      types: ["void"],
      outletIds: [outletA, outletB],
    });
    // Outlet A: 4 now vs 1 before (x4 -> high). Outlet B: 4 now vs 1 before (x4 -> high).
    expect(
      out.anomalies
        .map((a) => [
          a.outletId,
          a.type,
          a.observedValue,
          a.baselineValue,
          a.severity,
        ])
        .sort(),
    ).toEqual(
      [
        [outletA, "void", "4.0000", "1.0000", "high"],
        [outletB, "void", "4.0000", "1.0000", "high"],
      ].sort(),
    );
    expect(out.anomalies[0].link).toBe("/laporan/anomali");
    expect(out.sources[0]).toMatchObject({
      finality: "estimate",
      period: ANOMALY_PERIOD,
    });
  });

  it("measures discounts and ingredient waste in rupiah", async () => {
    const out = await call("TL-11", "owner", {
      period: ANOMALY_PERIOD,
      types: ["discount", "ingredient_usage"],
      outletIds: [outletA],
    });
    const byType = Object.fromEntries(out.anomalies.map((a) => [a.type, a]));
    expect(byType.discount).toMatchObject({
      observedValue: "60000.0000",
      baselineValue: "0.0000",
      severity: "high",
    });
    // 300000 now vs 100000 before: x3 -> medium.
    expect(byType.ingredient_usage).toMatchObject({
      observedValue: "300000.0000",
      baselineValue: "100000.0000",
      severity: "medium",
    });
  });

  it("an outlet manager sees only their outlet and is denied another outlet's filter", async () => {
    const own = await call("TL-11", "outletManager", {
      period: ANOMALY_PERIOD,
      types: ["void"],
    });
    expect(own.anomalies.map((a) => a.outletId)).toEqual([outletA]);
    await expect(
      call("TL-11", "outletManager", {
        period: ANOMALY_PERIOD,
        outletIds: [outletB],
      }),
    ).rejects.toMatchObject(forbidden);
  });

  it("never reports another tenant's events and ignores types it cannot measure", async () => {
    const out = await call("TL-11", "owner", { period: ANOMALY_PERIOD });
    expect(out.anomalies.some((a) => a.outletId === otherOutlet)).toBe(false);
    const cash = await call("TL-11", "owner", {
      period: ANOMALY_PERIOD,
      types: ["cash_variance"],
    });
    expect(cash.anomalies).toEqual([]);
  });

  it("does not report a quiet outlet or period", async () => {
    const out = await call("TL-11", "owner", {
      period: { from: "2026-08-01", to: "2026-08-07" },
    });
    expect(out.anomalies).toEqual([]);
  });

  it("a role without report.operational.view is forbidden", async () => {
    await expect(
      call("TL-11", "employee", { period: ANOMALY_PERIOD }),
    ).rejects.toMatchObject(forbidden);
  });
});

// ---- TL-12 -----------------------------------------------------------------

describe("TL-12 get_my_profit_share", () => {
  it("the shareholder gets only their own (here: empty) distributions, finality final", async () => {
    const out = await call("TL-12", "shareholder", { year: 2026 });
    expect(out.distributions).toEqual([]);
    expect(out.sources[0]).toMatchObject({
      finality: "final",
      period: { from: "2026-01-01", to: "2026-12-31" },
    });
  });

  it("has no shareholder id input: an extra key is rejected by the schema", () => {
    expect(() =>
      AI_TOOL_IO["TL-12"].input.parse({ year: 2026, userId: randomUUID() }),
    ).toThrow();
  });

  it("a non-shareholder is forbidden", async () => {
    await expect(call("TL-12", "owner", {})).rejects.toMatchObject(forbidden);
    await expect(call("TL-12", "employee", {})).rejects.toMatchObject(
      forbidden,
    );
  });
});

// ---- TL-20 -----------------------------------------------------------------

describe("TL-20 get_facility_utilization", () => {
  it("counts sessions, utilization of available minutes and revenue", async () => {
    const out = await call("TL-20", "outletManager", {
      period: PERIOD,
      outletIds: [outletA],
    });
    const row = out.rows.find((r) => r.facilityId === facilityA.id);
    // 3 sessions (2 completed + 1 issued package); holds, cancelled and other days do not count.
    // Booked 180 min of 2 units x 720 min = 1440 -> 12.5000 %.
    expect(row).toMatchObject({
      name: "Read B Shower",
      sessions: 3,
      utilizationPct: "12.5000",
    });
    // 2 purchase tickets x 50000 + 5000 overtime; the package ticket has no price.
    expect(row?.revenueIdr).toBe(105_000);
    expect(out.sources[0]).toMatchObject({
      finality: "estimate",
      link: "/laporan/fasilitas",
    });
  });

  it("filters by facility id", async () => {
    const out = await call("TL-20", "owner", {
      period: PERIOD,
      facilityId: facilityA.id,
    });
    expect(out.rows.map((r) => r.facilityId)).toEqual([facilityA.id]);
  });

  it("an outlet manager is denied an outlet outside their scope", async () => {
    await expect(
      call("TL-20", "outletManager", { period: PERIOD, outletIds: [outletB] }),
    ).rejects.toMatchObject(forbidden);
  });

  it("never returns another tenant's facility, even by id", async () => {
    const foreign = createdFacilities.find((f) => f.tenant === otherTenant)!;
    const all = await call("TL-20", "owner", { period: PERIOD });
    expect(all.rows.some((r) => r.facilityId === foreign.id)).toBe(false);
    const byId = await call("TL-20", "owner", {
      period: PERIOD,
      facilityId: foreign.id,
    });
    expect(byId.rows).toEqual([]);
  });

  it("caps rows at 200 and flags truncation", async () => {
    const out = await call("TL-20", "owner", {
      period: PERIOD,
      outletIds: [outletB],
    });
    expect(out.rows).toHaveLength(TOOL_MAX_ROWS);
    expect(out.truncated).toBe(true);
  });

  it("a role without report.operational.view is forbidden", async () => {
    await expect(
      call("TL-20", "employee", { period: PERIOD }),
    ).rejects.toMatchObject(forbidden);
  });
});
