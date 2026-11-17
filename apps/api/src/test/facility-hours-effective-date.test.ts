// Facility operating hours with an effective date (bead legend-4us1a, card
// 987; PRD F22 "Konfigurasi Legend" operating hours, FAC-02, FAC-06; TEN-01..03).
//
// Contract (brief-987 section legend-4us1a, not the implementation):
//  - Hours of a business date D = the version of `facility_operating_hours_versions`
//    with the latest `effective_from` <= D; no such version falls back to
//    `facilities.operating_hours`. `facilities.operating_hours` = hours valid today.
//  - The facility update (PUT /api/facility/facilities/:id) and create (POST)
//    accept an optional `effectiveFrom` (YYYY-MM-DD, outlet business date),
//    default today. `effectiveFrom` before today is a 422: the past is never
//    rewritten. A change with `effectiveFrom` > today leaves
//    `facilities.operating_hours` alone; <= today also sets it.
//  - Create seeds one version at 1970-01-01.
//  - Exported resolver `resolveOperatingHoursOn(tx, tenantId, facilityId, businessDate)`
//    in `services/facility-hours-versions.service.ts`.
//  - Consumers: the daily available-minutes metric (per day) and the slot
//    check (by the slot's date). Confirmed bookings are never revalidated.
//
// Assumptions: the resolver returns the `FacilityDayHours[]` of the day; for a
// facility the caller cannot see (other tenant) it returns nothing (null,
// undefined or an empty list) or throws, but never another tenant's hours.
// The seeded Cafe Legend outlets run in Asia/Jakarta, so "today" is the
// Jakarta calendar date (tests keep a 1-day margin around today and use dates
// far from it for the cases that must be unambiguous).

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  businessDateSchema,
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createFacility, facilityIdSchema } from "@starter/shared/facility";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resolveOperatingHoursOn } from "../services/facility-hours-versions.service.ts";
import {
  holdFacilitySlot,
  type HoldSlotInput,
} from "../services/facility-slots.service.ts";
import { recomputeMetricsDaily } from "../services/metrics-daily.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  seededOutletA,
  seededTenantId,
} from "./floor-test-helpers.ts";

const app = createApp();
const outletA = outletIdSchema.parse(seededOutletA);

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const hoursOf = (opensAt: string, closesAt: string) => [
  { daysOfWeek: ALL_DAYS, opensAt, closesAt },
];

function context(tenantId: string): ScopedTenantContext {
  const tenant = establishTenantContext({
    tenantId: tenantIdSchema.parse(tenantId),
    brandId: null,
    source: "session",
  });
  return establishScopedTenantContext(tenant, { kind: "tenant" });
}

async function asOwner<T>(
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

const OVERTIME = JSON.stringify({
  graceMinutes: 5,
  blockMinutes: 15,
  feePerBlockIdr: 5000,
});
const CANCELLATION = JSON.stringify({
  freeCancelMinutesBefore: 30,
  lateCancelResolution: "no_refund",
  lateCancelFeeIdr: 0,
  noShowResolution: "no_refund",
});

async function insertFacilityRow(input: {
  tenantId: string;
  outletId: string;
  name: string;
  type?: string;
  sessionMinutes?: number;
  cleaningMinutes?: number;
  hours: ReturnType<typeof hoursOf>;
}): Promise<string> {
  const id = randomUUID();
  await asOwner(input.tenantId, (client) =>
    client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 10, $8, $9, $10)`,
      [
        id,
        input.tenantId,
        input.outletId,
        input.name,
        input.type ?? "shower",
        input.sessionMinutes ?? 60,
        input.cleaningMinutes ?? 10,
        JSON.stringify(input.hours),
        OVERTIME,
        CANCELLATION,
      ],
    ),
  );
  return id;
}

async function insertVersion(
  tenantId: string,
  outletId: string,
  facilityId: string,
  effectiveFrom: string,
  hours: ReturnType<typeof hoursOf>,
) {
  await asOwner(tenantId, (client) =>
    client.query(
      `INSERT INTO facility_operating_hours_versions
         (tenant_id, outlet_id, facility_id, effective_from, operating_hours)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, outletId, facilityId, effectiveFrom, JSON.stringify(hours)],
    ),
  );
}

type VersionRow = { effective_from: string; operating_hours: unknown };
async function versionRows(
  tenantId: string,
  facilityId: string,
): Promise<VersionRow[]> {
  const { rows } = await owner.query<VersionRow>(
    `SELECT effective_from::text AS effective_from, operating_hours
       FROM facility_operating_hours_versions
      WHERE tenant_id = $1 AND facility_id = $2
      ORDER BY effective_from`,
    [tenantId, facilityId],
  );
  return rows;
}

/** Hours of one business date through the exported resolver. */
function resolveOn(tenantId: string, facilityId: string, date: string) {
  return withTenant(db, context(tenantId), (tx) =>
    resolveOperatingHoursOn(
      tx,
      tenantIdSchema.parse(tenantId),
      facilityIdSchema.parse(facilityId),
      businessDateSchema.parse(date),
    ),
  );
}

/** Calendar date (YYYY-MM-DD) in Asia/Jakarta, `offsetDays` from today. */
function jakartaDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

// ---------------------------------------------------------------------------
// Part 1: resolver, daily available minutes, slot check (seeded versions)
// ---------------------------------------------------------------------------

const NOW = new Date("2025-07-20T05:00:00Z");
type World = { tenantId: string; outletId: string; facilityId: string };
let world: World;
let other: World;

async function makeWorld(label: string): Promise<World> {
  const tenant = await createIsolatedTenant(
    `fhe-${label}-${randomUUID().slice(0, 6)}`,
  );
  const facilityId = await insertFacilityRow({
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    name: "Shower",
    hours: hoursOf("08:00", "20:00"),
  });
  const areaId = randomUUID();
  await asOwner(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area', 0)`,
      [areaId, tenant.tenantId, tenant.outletId, facilityId],
    );
    await client.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order, created_at)
       VALUES ($1, $2, $3, $4, $5, 'A1', 'available', 0, '2025-01-01T00:00:00Z')`,
      [randomUUID(), tenant.tenantId, tenant.outletId, facilityId, areaId],
    );
  });
  return {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    facilityId,
  };
}

/** Outlet total of one stored daily metric row (read like ms-facility.test.ts). */
async function storedMinutes(
  w: World,
  date: string,
  code = "shower_available_minutes",
): Promise<number> {
  const { rows } = await owner.query<{ value: string }>(
    `SELECT value_int::text AS value FROM metrics_daily
      WHERE tenant_id = $1 AND outlet_id = $2 AND metric_date = $3
        AND metric_code = $4 AND dimension_key IS NULL`,
    [w.tenantId, w.outletId, date, code],
  );
  expect(rows, `${code} ${date}`).toHaveLength(1);
  return Number(rows[0]!.value);
}

async function recomputeDay(w: World, date: string) {
  await recomputeMetricsDaily(
    context(w.tenantId),
    w.outletId,
    businessDateSchema.parse(date),
    businessDateSchema.parse(date),
    { now: NOW },
  );
}

beforeAll(async () => {
  world = await makeWorld("a");
  other = await makeWorld("b");
  // facilities.operating_hours is 08:00-20:00. Versions: 2025-06-16 -> 08:00-12:00,
  // 2025-06-20 -> 09:00-18:00. Before the first version the facility row is
  // the fallback.
  await insertVersion(
    world.tenantId,
    world.outletId,
    world.facilityId,
    "2025-06-16",
    hoursOf("08:00", "12:00"),
  );
  await insertVersion(
    world.tenantId,
    world.outletId,
    world.facilityId,
    "2025-06-20",
    hoursOf("09:00", "18:00"),
  );
  // Another tenant with its own, different versions: must never show up.
  await insertVersion(
    other.tenantId,
    other.outletId,
    other.facilityId,
    "2025-06-16",
    hoursOf("01:00", "02:00"),
  );
});

afterAll(async () => {
  await owner.end();
});

describe("legend-4us1a resolveOperatingHoursOn", () => {
  it("returns the version with the latest effective_from at or before the date", async () => {
    expect(
      await resolveOn(world.tenantId, world.facilityId, "2025-06-16"),
    ).toEqual(hoursOf("08:00", "12:00"));
    expect(
      await resolveOn(world.tenantId, world.facilityId, "2025-06-19"),
    ).toEqual(hoursOf("08:00", "12:00"));
    expect(
      await resolveOn(world.tenantId, world.facilityId, "2025-06-20"),
    ).toEqual(hoursOf("09:00", "18:00"));
    expect(
      await resolveOn(world.tenantId, world.facilityId, "2030-01-01"),
    ).toEqual(hoursOf("09:00", "18:00"));
  });

  it("falls back to facilities.operating_hours before the first version", async () => {
    expect(
      await resolveOn(world.tenantId, world.facilityId, "2025-06-15"),
    ).toEqual(hoursOf("08:00", "20:00"));
    expect(
      await resolveOn(world.tenantId, world.facilityId, "2020-01-01"),
    ).toEqual(hoursOf("08:00", "20:00"));
  });

  it("never returns another tenant's hours, in either direction", async () => {
    const leaks = async (
      asTenant: World,
      facilityId: string,
      date: string,
      forbidden: unknown,
    ) => {
      const result = await resolveOn(asTenant.tenantId, facilityId, date).then(
        (value) => value,
        () => null,
      );
      expect(result).not.toEqual(forbidden);
      expect(
        result === null ||
          result === undefined ||
          (Array.isArray(result) && result.length === 0),
      ).toBe(true);
    };
    await leaks(
      other,
      world.facilityId,
      "2025-06-17",
      hoursOf("08:00", "12:00"),
    );
    await leaks(
      world,
      other.facilityId,
      "2025-06-17",
      hoursOf("01:00", "02:00"),
    );
  });

  it("keeps the versions table invisible to another tenant (row security)", async () => {
    const count = (asTenant: World, facilityId: string) =>
      withTenant(db, context(asTenant.tenantId), async (tx) => {
        const result = await tx.execute<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM facility_operating_hours_versions WHERE facility_id = ${facilityId}`,
        );
        return result.rows[0]?.n;
      });
    expect(await count(world, world.facilityId)).toBe(2);
    expect(await count(other, world.facilityId)).toBe(0);
    expect(await count(world, other.facilityId)).toBe(0);
  });
});

describe("legend-4us1a available minutes per business day", () => {
  it("counts each day with the hours valid on that day", async () => {
    // One unit: open minutes = hours of that day.
    for (const [date, minutes] of [
      ["2025-06-10", 720], // fallback 08:00-20:00
      ["2025-06-16", 240], // 08:00-12:00
      ["2025-06-19", 240],
      ["2025-06-20", 540], // 09:00-18:00
      ["2025-06-22", 540],
    ] as const) {
      await recomputeDay(world, date);
      expect(await storedMinutes(world, date), date).toBe(minutes);
    }
  });

  it("a later version changes later days only, never a day already computed", async () => {
    await insertVersion(
      world.tenantId,
      world.outletId,
      world.facilityId,
      "2025-06-25",
      hoursOf("08:00", "10:00"),
    );
    // Recomputing past days after the change keeps their minutes.
    await recomputeDay(world, "2025-06-19");
    await recomputeDay(world, "2025-06-20");
    await recomputeDay(world, "2025-06-24");
    await recomputeDay(world, "2025-06-25");
    await recomputeDay(world, "2025-06-26");
    expect(await storedMinutes(world, "2025-06-19")).toBe(240);
    expect(await storedMinutes(world, "2025-06-20")).toBe(540);
    expect(await storedMinutes(world, "2025-06-24")).toBe(540);
    expect(await storedMinutes(world, "2025-06-25")).toBe(120);
    expect(await storedMinutes(world, "2025-06-26")).toBe(120);
  });

  it("a facility without any version behaves as before (facility hours)", async () => {
    const fresh = await makeWorld("c");
    await recomputeDay(fresh, "2025-06-10");
    expect(await storedMinutes(fresh, "2025-06-10")).toBe(720);
  });
});

describe("legend-4us1a slot check by the slot's date", () => {
  // 2030-01-15 10:00 Jakarta (Tuesday). Hours today 00:00-23:59.
  // From 2030-01-16: 06:00-10:00. From 2030-01-20: open all day again.
  const SLOT_NOW = new Date("2030-01-15T03:00:00.000Z");
  const at = (minutes: number) =>
    new Date(SLOT_NOW.getTime() + minutes * 60_000).toISOString();
  const DAY = 24 * 60;
  const seeded: string[] = [];
  let facilityId: string;
  let areaId: string;

  const scope = () =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(seededTenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "outlets", outletIds: [outletA] },
    );

  const hold = (startsAt: string) => {
    const input: HoldSlotInput = {
      facilityId,
      areaId,
      timing: { kind: "slot", startsAt },
      productId: randomUUID(),
      customerProfileId: randomUUID(),
      source: "purchase",
      idempotencyKey: `fhe-${randomUUID()}`,
    };
    const ctx = scope();
    return withTenant(db, ctx, (tx) =>
      holdFacilitySlot(tx, ctx, input, SLOT_NOW),
    );
  };

  beforeAll(async () => {
    facilityId = await insertFacilityRow({
      tenantId: seededTenantId,
      outletId: outletA,
      name: `Shower fhe ${randomUUID().slice(0, 8)}`,
      sessionMinutes: 20,
      cleaningMinutes: 10,
      hours: hoursOf("00:00", "23:59"),
    });
    seeded.push(facilityId);
    areaId = randomUUID();
    await asOwner(seededTenantId, async (client) => {
      await client.query(
        `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
         VALUES ($1, $2, $3, $4, 'Area Pria', 0)`,
        [areaId, seededTenantId, outletA, facilityId],
      );
      for (const code of ["P1", "P2", "P3", "P4", "P5"])
        await client.query(
          `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, 'available', 0)`,
          [randomUUID(), seededTenantId, outletA, facilityId, areaId, code],
        );
    });
    await insertVersion(
      seededTenantId,
      outletA,
      facilityId,
      "2030-01-16",
      hoursOf("06:00", "10:00"),
    );
    await insertVersion(
      seededTenantId,
      outletA,
      facilityId,
      "2030-01-20",
      hoursOf("00:00", "23:59"),
    );
  });

  afterAll(async () => {
    await asOwner(seededTenantId, async (client) => {
      for (const table of [
        "access_tickets",
        "facility_units",
        "facility_areas",
        "facility_operating_hours_versions",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = ANY($2)`,
          [seededTenantId, seeded],
        );
      await client.query(
        "DELETE FROM facilities WHERE tenant_id = $1 AND id = ANY($2)",
        [seededTenantId, seeded],
      );
    });
  });

  it("a slot today still uses today's hours", async () => {
    await expect(hold(at(120))).resolves.toBeDefined(); // 12:00 today
  });

  it("a slot on a date with a narrower version is checked against that version", async () => {
    // 2030-01-16 09:30 + 20 min = 09:50, inside 06:00-10:00.
    await expect(hold(at(DAY - 30))).resolves.toBeDefined();
    // 09:45 + 20 min ends after 10:00.
    await expect(hold(at(DAY - 15))).rejects.toMatchObject({
      code: "FACILITY_CLOSED",
    });
    // 12:00 on 2030-01-16 is past closing (today's wide hours must not apply).
    await expect(hold(at(DAY + 120))).rejects.toMatchObject({
      code: "FACILITY_CLOSED",
    });
    // 2030-01-17 has no newer version: the 2030-01-16 version still applies.
    await expect(hold(at(2 * DAY + 120))).rejects.toMatchObject({
      code: "FACILITY_CLOSED",
    });
  });

  it("a newer version reopens the later date", async () => {
    // 2030-01-20 12:00 Jakarta.
    await expect(hold(at(5 * DAY + 120))).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Part 2: admin API (PUT/POST /api/facility/facilities)
// ---------------------------------------------------------------------------

describe("legend-4us1a facility hours API", () => {
  const tenantId = seededTenantId;
  const createdUsers: string[] = [];
  const apiFacilities: string[] = [];
  const key = () => `fhe-${randomUUID()}`;

  const facilityBody = {
    name: "Ruang Jam Efektif",
    type: "coworking",
    sessionMinutes: 60,
    cleaningMinutes: 10,
    arrivalGraceMinutes: 10,
    operatingHours: hoursOf("08:00", "20:00"),
    overtimePolicy: { graceMinutes: 5, blockMinutes: 15, feePerBlockIdr: 5000 },
    cancellationPolicy: {
      freeCancelMinutesBefore: 30,
      lateCancelResolution: "no_refund",
      lateCancelFeeIdr: 0,
      noShowResolution: "no_refund",
    },
  };

  async function ownerClient() {
    const client = agent(app);
    await signUp(client, "Facility Hours Owner");
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    createdUsers.push(userId);
    await owner.query(
      `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, valid_from, assigned_by)
       SELECT $1, $2, id, 'tenant', now() - interval '1 minute', $2 FROM roles
       WHERE tenant_id = $1 AND template_key = 'owner'`,
      [tenantId, userId],
    );
    return client;
  }

  type Client = Awaited<ReturnType<typeof ownerClient>>;

  /** Creates a facility through the API (seeds the 1970-01-01 version). */
  async function createViaApi(client: Client): Promise<string> {
    const created = await client
      .post("/api/facility/facilities")
      .set(originHeader)
      .send({
        ...facilityBody,
        outletId: seededOutletA,
        idempotencyKey: key(),
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    createFacility.response.parse(created.body);
    const id = created.body.data.id as string;
    apiFacilities.push(id);
    return id;
  }

  async function readFacility(client: Client, id: string) {
    const config = await client.get(`/api/facility/config?facilityId=${id}`);
    expect(config.status, JSON.stringify(config.body)).toBe(200);
    return config.body.data.facility as {
      updatedAt: string;
      operatingHours: unknown;
    };
  }

  async function putHours(
    client: Client,
    id: string,
    operatingHours: unknown,
    effectiveFrom?: string,
  ) {
    const current = await readFacility(client, id);
    return client
      .put(`/api/facility/facilities/${id}`)
      .set(originHeader)
      .send({
        operatingHours,
        ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
        expectedUpdatedAt: current.updatedAt,
      });
  }

  afterAll(async () => {
    await asOwner(tenantId, async (client) => {
      for (const table of [
        "access_tickets",
        "facility_operating_hours_versions",
        "facility_units",
        "facility_areas",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = ANY($2)`,
          [tenantId, apiFacilities],
        );
      await client.query(
        "DELETE FROM operations_idempotency WHERE tenant_id = $1 AND key LIKE 'fhe-%'",
        [tenantId],
      );
      await client.query(
        "DELETE FROM facilities WHERE tenant_id = $1 AND id = ANY($2)",
        [tenantId, apiFacilities],
      );
    });
    if (createdUsers.length > 0) {
      await owner.query(
        "DELETE FROM role_assignments WHERE user_id = ANY($1)",
        [createdUsers],
      );
      await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [
        createdUsers,
      ]);
    }
  });

  it("create seeds one version at 1970-01-01 with the given hours", async () => {
    const client = await ownerClient();
    const id = await createViaApi(client);
    const rows = await versionRows(tenantId, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.effective_from).toBe("1970-01-01");
    expect(rows[0]!.operating_hours).toEqual(hoursOf("08:00", "20:00"));
  });

  it("a change without effectiveFrom applies from today and never rewrites the past", async () => {
    const client = await ownerClient();
    const id = await createViaApi(client);
    const changed = await putHours(client, id, hoursOf("09:00", "17:00"));
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data.operatingHours).toEqual(hoursOf("09:00", "17:00"));
    expect((await readFacility(client, id)).operatingHours).toEqual(
      hoursOf("09:00", "17:00"),
    );
    // A version exists dated today (1 day margin for the business-date edge).
    const rows = await versionRows(tenantId, id);
    const fresh = rows.find((row) => row.effective_from !== "1970-01-01");
    expect(fresh, JSON.stringify(rows)).toBeDefined();
    expect(fresh!.effective_from >= jakartaDate(-1)).toBe(true);
    expect(fresh!.effective_from <= jakartaDate(1)).toBe(true);
    expect(fresh!.operating_hours).toEqual(hoursOf("09:00", "17:00"));
    // Past days keep the old hours, from today on the new ones.
    expect(await resolveOn(tenantId, id, jakartaDate(-5))).toEqual(
      hoursOf("08:00", "20:00"),
    );
    expect(await resolveOn(tenantId, id, "2020-01-01")).toEqual(
      hoursOf("08:00", "20:00"),
    );
    expect(await resolveOn(tenantId, id, jakartaDate(1))).toEqual(
      hoursOf("09:00", "17:00"),
    );
  });

  it("a future effectiveFrom keeps today's hours, applies from that date, and a second change for the same date replaces it", async () => {
    const client = await ownerClient();
    const id = await createViaApi(client);
    const future = jakartaDate(30);
    const first = await putHours(client, id, hoursOf("10:00", "16:00"), future);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    // Hours valid today did not change.
    expect((await readFacility(client, id)).operatingHours).toEqual(
      hoursOf("08:00", "20:00"),
    );
    expect(await resolveOn(tenantId, id, jakartaDate(29))).toEqual(
      hoursOf("08:00", "20:00"),
    );
    expect(await resolveOn(tenantId, id, future)).toEqual(
      hoursOf("10:00", "16:00"),
    );
    expect(await resolveOn(tenantId, id, jakartaDate(35))).toEqual(
      hoursOf("10:00", "16:00"),
    );
    // Same date again: replaces, does not add a second row or fail.
    const second = await putHours(
      client,
      id,
      hoursOf("11:00", "15:00"),
      future,
    );
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const rows = (await versionRows(tenantId, id)).filter(
      (row) => row.effective_from === future,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operating_hours).toEqual(hoursOf("11:00", "15:00"));
    expect(await resolveOn(tenantId, id, future)).toEqual(
      hoursOf("11:00", "15:00"),
    );
    expect((await readFacility(client, id)).operatingHours).toEqual(
      hoursOf("08:00", "20:00"),
    );
  });

  it("refuses an effectiveFrom in the past or a malformed one with 422 and changes nothing", async () => {
    const client = await ownerClient();
    const id = await createViaApi(client);
    // The field itself is accepted (a valid future date works), so the 422
    // below is about the date, not an unknown key.
    const ok = await putHours(
      client,
      id,
      hoursOf("10:00", "16:00"),
      jakartaDate(40),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const before = await versionRows(tenantId, id);
    for (const effectiveFrom of [
      "2020-01-01",
      jakartaDate(-3),
      "2030-13-45",
      "not-a-date",
      "",
    ]) {
      const refused = await putHours(
        client,
        id,
        hoursOf("05:00", "06:00"),
        effectiveFrom,
      );
      expect(
        refused.status,
        `${effectiveFrom}: ${JSON.stringify(refused.body)}`,
      ).toBe(422);
    }
    expect(await versionRows(tenantId, id)).toEqual(before);
    expect((await readFacility(client, id)).operatingHours).toEqual(
      hoursOf("08:00", "20:00"),
    );
  });

  it("an already confirmed ticket outside the new hours survives the change", async () => {
    const client = await ownerClient();
    const id = await createViaApi(client);
    const areaId = randomUUID();
    const unitId = randomUUID();
    const future = jakartaDate(30);
    // 18:00 Jakarta on the effective date, outside the new 10:00-16:00 hours.
    const startsAt = new Date(
      Date.parse(`${future}T18:00:00+07:00`),
    ).toISOString();
    const ticketId = randomUUID();
    await asOwner(tenantId, async (db2) => {
      await db2.query(
        `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
         VALUES ($1, $2, $3, $4, 'Area', 0)`,
        [areaId, tenantId, seededOutletA, id],
      );
      await db2.query(
        `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, 'C1', 'available', 0)`,
        [unitId, tenantId, seededOutletA, id, areaId],
      );
      await db2.query(
        `INSERT INTO access_tickets (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id,
                                     product_id, source, starts_at, ends_at, cleaning_ends_at, grace_minutes, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'purchase', $9, $10, $11, 10, 'issued')`,
        [
          ticketId,
          tenantId,
          seededOutletA,
          id,
          areaId,
          unitId,
          randomUUID(),
          randomUUID(),
          startsAt,
          new Date(Date.parse(startsAt) + 60 * 60_000).toISOString(),
          new Date(Date.parse(startsAt) + 70 * 60_000).toISOString(),
        ],
      );
    });
    const changed = await putHours(
      client,
      id,
      hoursOf("10:00", "16:00"),
      future,
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const { rows } = await owner.query<{ status: string; starts_at: Date }>(
      "SELECT status, starts_at FROM access_tickets WHERE tenant_id = $1 AND id = $2",
      [tenantId, ticketId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("issued");
    expect(rows[0]!.starts_at.toISOString()).toBe(startsAt);
  });

  it("another tenant's facility cannot be changed: 404, no version written", async () => {
    const client = await ownerClient();
    // `other` is an isolated tenant's facility; the Cafe Legend owner must not touch it.
    const before = await versionRows(other.tenantId, other.facilityId);
    const response = await client
      .put(`/api/facility/facilities/${other.facilityId}`)
      .set(originHeader)
      .send({
        operatingHours: hoursOf("05:00", "06:00"),
        effectiveFrom: jakartaDate(30),
        expectedUpdatedAt: new Date().toISOString(),
      });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await versionRows(other.tenantId, other.facilityId)).toEqual(before);
    const { rows } = await owner.query<{ operating_hours: unknown }>(
      "SELECT operating_hours FROM facilities WHERE tenant_id = $1 AND id = $2",
      [other.tenantId, other.facilityId],
    );
    expect(rows[0]!.operating_hours).toEqual(hoursOf("08:00", "20:00"));
  });
});
