// Facility unit retirement and stale in_use ticket sweep (PRD v1.7 §3 F22;
// FAC-02, FAC-06; bead legend-etawy, card 993). Fail-first: neither behavior
// exists yet. Same harness as facility-queue-expiry.test.ts (real services,
// restricted app role so RLS is enforced, fixed `now`).
//
// CONTRACT ASSUMED (the card gives no exact names; written from the card plus
// the existing facility services, not from an implementation):
//  1. Column `facility_units.retired_at timestamptz NULL` (migration 0485).
//     NULL = active, set = retired. There is no API to retire a unit yet, so
//     the tests set it with an owner-role UPDATE. A retired unit is never
//     deleted, so its tickets (history) keep their `unit_id`.
//  2. Retired units are NOT offered: `getFacilityAvailability` leaves them out
//     of `areas[].units` and out of `waitEstimate.freeUnitsNow`;
//     `holdFacilitySlot` never auto-picks them and rejects an explicit
//     `unitId` that is retired with `UNIT_NOT_BOOKABLE` (same family as
//     maintenance, FAC-06). Existing tickets on a retired unit are untouched.
//  3. Sweep: `releaseStaleInUseTickets(tx, context, now?)` exported from
//     services/facility-slots.service.ts (sibling of `releaseExpiredSlotHolds`),
//     returns the ids it released. Constant `IN_USE_STALE_AFTER_MINUTES`
//     exported from the same file: an `in_use` ticket is stale once `now` is
//     MORE than that many minutes after its scheduled `ends_at`.
//  4. Releasing a stale ticket = the normal "end" outcome without charging:
//     ticket `completed` with `ended_at` set; its unit `in_use` ->
//     `needs_cleaning` (contract unit machine `end_session`); overtime stays
//     0 / 0 IDR and no `facility_linked_orders` row is created ("tanpa
//     menagih ulang"). Idempotent: a second run releases nothing and changes
//     nothing. The sweep honors the context scope (RLS): other outlet or
//     other tenant is never touched.
// The sweep symbols are read through the module namespace so a missing export
// fails with a clear message instead of breaking typecheck.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import * as slots from "../services/facility-slots.service.ts";
import {
  getFacilityAvailability,
  holdFacilitySlot,
  type HoldSlotInput,
} from "../services/facility-slots.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();
const operator = randomUUID();

/** 2030-01-15 10:00 in Asia/Jakarta (UTC+7), a Tuesday. */
const NOW = new Date("2030-01-15T03:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 6,
});

const base = (tenant: string = tenantId) =>
  establishTenantContext({
    tenantId: tenant,
    brandId: null,
    source: "session",
  });
const tenantScope = (tenant: string = tenantId) =>
  establishScopedTenantContext(base(tenant), { kind: "tenant" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

async function asOwner<T>(
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant],
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

type Seeded = {
  tenant: string;
  outletId: string;
  facilityId: string;
  areaId: string;
  unitIds: string[];
};
const seeded: Seeded[] = [];

/** One facility (session 20 + cleaning 10), one area, N clean units P1..PN. */
async function seedFacility(
  options: { tenant?: string; outletId?: string; units?: number } = {},
): Promise<Seeded> {
  const tenant = options.tenant ?? tenantId;
  const outletId = options.outletId ?? outletA;
  const facilityId = randomUUID();
  const areaId = randomUUID();
  const unitIds = Array.from({ length: options.units ?? 2 }, () =>
    randomUUID(),
  );
  await asOwner(tenant, async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, $4, 'shower', 20, 10, 10, $5, $6, $7)`,
      [
        facilityId,
        tenant,
        outletId,
        `Shower ${facilityId.slice(0, 8)}`,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "00:00",
            closesAt: "23:59",
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
       VALUES ($1, $2, $3, $4, 'Area Pria', 0)`,
      [areaId, tenant, outletId, facilityId],
    );
    for (const [index, unitId] of unitIds.entries())
      await client.query(
        `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, 'available', $7)`,
        [unitId, tenant, outletId, facilityId, areaId, `P${index + 1}`, index],
      );
  });
  const entry = { tenant, outletId, facilityId, areaId, unitIds };
  seeded.push(entry);
  return entry;
}

async function retireUnit(f: Seeded, unitId: string, when = NOW) {
  await asOwner(f.tenant, (client) =>
    client.query(
      "UPDATE facility_units SET retired_at = $3 WHERE tenant_id = $1 AND id = $2",
      [f.tenant, unitId, when.toISOString()],
    ),
  );
}

/** A ticket straight into the table; `minutes` is the start relative to NOW. */
async function insertTicket(
  f: Seeded,
  unitId: string,
  minutes: number,
  status: "in_use" | "issued" | "completed",
) {
  const id = randomUUID();
  const start = at(minutes).getTime();
  await asOwner(f.tenant, async (client) => {
    await client.query(
      `INSERT INTO access_tickets (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id,
                                   product_id, source, starts_at, ends_at, cleaning_ends_at, grace_minutes, status,
                                   first_opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'purchase', $9, $10, $11, 10, $12, $13)`,
      [
        id,
        f.tenant,
        f.outletId,
        f.facilityId,
        f.areaId,
        unitId,
        randomUUID(),
        randomUUID(),
        new Date(start).toISOString(),
        new Date(start + 20 * 60_000).toISOString(),
        new Date(start + 30 * 60_000).toISOString(),
        status,
        status === "issued" ? null : new Date(start).toISOString(),
      ],
    );
    if (status === "in_use")
      await client.query(
        "UPDATE facility_units SET status = 'in_use' WHERE tenant_id = $1 AND id = $2",
        [f.tenant, unitId],
      );
  });
  return id;
}

const readTicket = (f: Seeded, ticketId: string) =>
  asOwner(f.tenant, async (client) => {
    const { rows } = await client.query(
      `SELECT status, ended_at, overtime_minutes, overtime_fee_idr, unit_id
         FROM access_tickets WHERE tenant_id = $1 AND id = $2`,
      [f.tenant, ticketId],
    );
    return rows[0] as
      | {
          status: string;
          ended_at: Date | null;
          overtime_minutes: number;
          overtime_fee_idr: number | string;
          unit_id: string;
        }
      | undefined;
  });

const readUnitStatus = (f: Seeded, unitId: string) =>
  asOwner(f.tenant, async (client) => {
    const { rows } = await client.query(
      "SELECT status FROM facility_units WHERE tenant_id = $1 AND id = $2",
      [f.tenant, unitId],
    );
    return rows[0]?.status as string | undefined;
  });

const linkedOrderCount = (f: Seeded) =>
  asOwner(f.tenant, async (client) => {
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM facility_linked_orders WHERE tenant_id = $1 AND facility_id = $2",
      [f.tenant, f.facilityId],
    );
    return rows[0].n as number;
  });

async function seedActor(id: string) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Facility Retire', $2)`,
    [id, `${id}@example.test`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Facility test ${roleId.slice(0, 8)}`,
      JSON.stringify(["facility.booth.operate", "facility.config.manage"]),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, id, roleId],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await seedActor(operator);
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Facility retire tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `facility-ret-${otherTenant.slice(0, 8)}`, tenantId],
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
});

afterAll(async () => {
  for (const f of seeded)
    await asOwner(f.tenant, async (client) => {
      for (const table of [
        "facility_linked_orders",
        "facility_operating_hours_versions",
        "access_tickets",
        "facility_queue_entries",
        "facility_units",
        "facility_areas",
        "facilities",
      ])
        await client.query(
          `DELETE FROM ${table} WHERE tenant_id = $1 AND ${
            table === "facilities" ? "id" : "facility_id"
          } = $2`,
          [f.tenant, f.facilityId],
        );
    });
  await owner.query("DELETE FROM role_assignments WHERE user_id = $1", [
    operator,
  ]);
  await owner.query(
    "DELETE FROM roles WHERE name LIKE 'Facility test %' AND tenant_id = $1",
    [tenantId],
  );
  await owner.query('DELETE FROM "user" WHERE id = $1', [operator]);
  // audit_logs rows (append-only) may still reference the second tenant's
  // outlet; the database is disposable, so a refused cleanup is not a failure.
  try {
    await asOwner(otherTenant, async (client) => {
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
  } catch {
    // leave the throwaway tenant behind
  }
  await owner.end();
});

// ---- Helpers over the services ---------------------------------------------------

const holdInput = (
  f: Seeded,
  overrides: Partial<HoldSlotInput> = {},
): HoldSlotInput => ({
  facilityId: f.facilityId,
  areaId: f.areaId,
  timing: { kind: "slot", startsAt: at(0).toISOString() },
  productId: randomUUID(),
  customerProfileId: randomUUID(),
  source: "purchase",
  idempotencyKey: `hold-${randomUUID()}`,
  ...overrides,
});

const hold = (f: Seeded, overrides: Partial<HoldSlotInput> = {}) => {
  const context = outletScope(f.outletId);
  return withTenant(db, context, (tx) =>
    holdFacilitySlot(tx, context, holdInput(f, overrides), NOW),
  );
};

const availability = (f: Seeded) =>
  getFacilityAvailability(
    tenantScope(),
    operator,
    { facilityId: f.facilityId, date: "2030-01-15" },
    NOW,
  );

function staleAfterMinutes(): number {
  const value = (slots as Record<string, unknown>).IN_USE_STALE_AFTER_MINUTES;
  if (typeof value !== "number" || value <= 0)
    throw new Error(
      "facility-slots.service must export IN_USE_STALE_AFTER_MINUTES (> 0)",
    );
  return value;
}

/** Runs the stale in_use sweep at `NOW + minute` and returns the released ids. */
async function sweep(context = tenantScope(), minute = 0): Promise<string[]> {
  const fn = (slots as Record<string, unknown>).releaseStaleInUseTickets as
    | undefined
    | ((tx: unknown, context: unknown, now: Date) => Promise<string[]>);
  if (typeof fn !== "function")
    throw new Error(
      "facility-slots.service must export releaseStaleInUseTickets(tx, context, now)",
    );
  // The service speaks ULID (ulidInUuid); the raw-SQL seeds here use the uuid form.
  const released = await withTenant(db, context, (tx) =>
    fn(tx, context, at(minute)),
  );
  return released.map((id) => ulidToUuid(id));
}

// ---- Retired units ------------------------------------------------------------------

describe("[legend-etawy] a retired unit is not offered for new tickets or slots", () => {
  it("availability lists only active units and counts only them as free", async () => {
    const f = await seedFacility({ units: 2 });
    const [first, second] = f.unitIds;
    expect((await availability(f)).areas[0].units.map((u) => u.unitId)).toEqual(
      [first, second],
    );

    await retireUnit(f, first);

    const result = await availability(f);
    const listed = result.areas.flatMap((a) => a.units.map((u) => u.unitId));
    expect(listed).toEqual([second]);
    expect(result.waitEstimate.freeUnitsNow).toBe(1);
  });

  it("a new hold skips a retired unit even when it comes first in the sort order", async () => {
    const f = await seedFacility({ units: 2 });
    const [first, second] = f.unitIds;
    await retireUnit(f, first);

    const { ticket } = await hold(f);

    expect(ticket.unitId).toBe(second);
  });

  it("holding the retired unit explicitly is refused with UNIT_NOT_BOOKABLE", async () => {
    const f = await seedFacility({ units: 2 });
    const [first] = f.unitIds;
    await retireUnit(f, first);

    await expect(hold(f, { unitId: first })).rejects.toMatchObject({
      code: "UNIT_NOT_BOOKABLE",
    });
  });

  it("when every unit of the area is retired nothing can be held", async () => {
    const f = await seedFacility({ units: 2 });
    for (const unitId of f.unitIds) await retireUnit(f, unitId);

    await expect(hold(f)).rejects.toMatchObject({ code: "UNIT_NOT_BOOKABLE" });
    await expect(hold(f, { timing: { kind: "now" } })).rejects.toMatchObject({
      code: "UNIT_NOT_BOOKABLE",
    });
    const listed = (await availability(f)).areas.flatMap((a) => a.units);
    expect(listed).toEqual([]);
  });

  it("history stays: tickets on the retired unit are kept as they were and the unit row remains", async () => {
    const f = await seedFacility({ units: 2 });
    const [first] = f.unitIds;
    const done = await insertTicket(f, first, -240, "completed");
    const upcoming = await insertTicket(f, first, 120, "issued");

    await retireUnit(f, first);

    expect(await readTicket(f, done)).toMatchObject({
      status: "completed",
      unit_id: first,
    });
    expect(await readTicket(f, upcoming)).toMatchObject({
      status: "issued",
      unit_id: first,
    });
    const unitRow = await asOwner(f.tenant, (client) =>
      client.query(
        "SELECT retired_at FROM facility_units WHERE tenant_id = $1 AND id = $2",
        [f.tenant, first],
      ),
    );
    expect(unitRow.rows).toHaveLength(1);
    expect(unitRow.rows[0].retired_at).not.toBeNull();
  });

  it("a unit that was never retired keeps being offered (retired_at is null by default)", async () => {
    const f = await seedFacility({ units: 1 });
    const unitRow = await asOwner(f.tenant, (client) =>
      client.query(
        "SELECT retired_at FROM facility_units WHERE tenant_id = $1 AND id = $2",
        [f.tenant, f.unitIds[0]],
      ),
    );
    expect(unitRow.rows[0].retired_at).toBeNull();
    expect((await hold(f)).ticket.unitId).toBe(f.unitIds[0]);
  });
});

// ---- Stale in_use tickets -----------------------------------------------------------

describe("[legend-etawy] a stale in_use ticket is released by the sweep, without charging again", () => {
  it("releases a ticket left in_use far past its scheduled end: completed, unit to needs_cleaning, no charge", async () => {
    const f = await seedFacility({ units: 1 });
    const [unitId] = f.unitIds;
    const ticketId = await insertTicket(f, unitId, 0, "in_use"); // ends at +20
    const ordersBefore = await linkedOrderCount(f);

    const released = await sweep(tenantScope(), 20 + staleAfterMinutes() + 60);

    expect(released).toEqual([ticketId]);
    const ticket = await readTicket(f, ticketId);
    expect(ticket?.status).toBe("completed");
    expect(ticket?.ended_at).not.toBeNull();
    expect(ticket?.overtime_minutes).toBe(0);
    expect(Number(ticket?.overtime_fee_idr)).toBe(0);
    expect(await readUnitStatus(f, unitId)).toBe("needs_cleaning");
    expect(await linkedOrderCount(f)).toBe(ordersBefore);
  });

  it("respects the stale boundary: not released inside it, released after it", async () => {
    const f = await seedFacility({ units: 1 });
    const [unitId] = f.unitIds;
    const ticketId = await insertTicket(f, unitId, 0, "in_use"); // ends at +20
    const stale = staleAfterMinutes();

    expect(await sweep(tenantScope(), 20 + stale - 1)).toEqual([]);
    expect((await readTicket(f, ticketId))?.status).toBe("in_use");
    expect(await readUnitStatus(f, unitId)).toBe("in_use");

    expect(await sweep(tenantScope(), 20 + stale + 1)).toEqual([ticketId]);
    expect((await readTicket(f, ticketId))?.status).toBe("completed");
  });

  it("leaves a session that is still running (and one just over time) alone", async () => {
    const f = await seedFacility({ units: 2 });
    const [running, justOver] = f.unitIds;
    const runningId = await insertTicket(f, running, -5, "in_use"); // ends +15
    const overId = await insertTicket(f, justOver, -25, "in_use"); // ended -5

    expect(await sweep(tenantScope(), 0)).toEqual([]);

    expect((await readTicket(f, runningId))?.status).toBe("in_use");
    expect((await readTicket(f, overId))?.status).toBe("in_use");
    expect(await readUnitStatus(f, running)).toBe("in_use");
  });

  it("only touches in_use tickets: an old issued or completed ticket is not changed", async () => {
    const f = await seedFacility({ units: 2 });
    const [a, b] = f.unitIds;
    const issuedId = await insertTicket(f, a, -600, "issued");
    const doneId = await insertTicket(f, b, -600, "completed");

    // The tenant is shared with earlier tests, so assert on these two ids only.
    const released = await sweep(tenantScope(), 20 + staleAfterMinutes() + 60);
    expect(released).not.toContain(issuedId);
    expect(released).not.toContain(doneId);

    expect((await readTicket(f, issuedId))?.status).toBe("issued");
    expect((await readTicket(f, doneId))?.status).toBe("completed");
  });

  it("is idempotent: a second run releases nothing and changes nothing", async () => {
    const f = await seedFacility({ units: 1 });
    const [unitId] = f.unitIds;
    const ticketId = await insertTicket(f, unitId, 0, "in_use");
    const later = 20 + staleAfterMinutes() + 60;

    expect(await sweep(tenantScope(), later)).toEqual([ticketId]);
    const afterFirst = await readTicket(f, ticketId);
    const ordersAfterFirst = await linkedOrderCount(f);

    expect(await sweep(tenantScope(), later + 5)).toEqual([]);

    const afterSecond = await readTicket(f, ticketId);
    expect(afterSecond?.status).toBe("completed");
    expect(afterSecond?.ended_at?.toISOString()).toBe(
      afterFirst?.ended_at?.toISOString(),
    );
    expect(Number(afterSecond?.overtime_fee_idr)).toBe(0);
    expect(await readUnitStatus(f, unitId)).toBe("needs_cleaning");
    expect(await linkedOrderCount(f)).toBe(ordersAfterFirst);
  });

  it("does not cross outlets: a sweep scoped to outlet A leaves outlet B's stale ticket alone", async () => {
    const fa = await seedFacility({ units: 1, outletId: outletA });
    const fb = await seedFacility({ units: 1, outletId: outletB });
    const ticketA = await insertTicket(fa, fa.unitIds[0], 0, "in_use");
    const ticketB = await insertTicket(fb, fb.unitIds[0], 0, "in_use");
    const later = 20 + staleAfterMinutes() + 60;

    const released = await sweep(outletScope(outletA), later);

    expect(released).toContain(ticketA);
    expect(released).not.toContain(ticketB);
    expect((await readTicket(fa, ticketA))?.status).toBe("completed");
    expect((await readTicket(fb, ticketB))?.status).toBe("in_use");
    expect(await readUnitStatus(fb, fb.unitIds[0])).toBe("in_use");
  });

  it("does not cross tenants: a sweep for this tenant leaves another tenant's stale ticket alone", async () => {
    const mine = await seedFacility({ units: 1 });
    const theirs = await seedFacility({
      units: 1,
      tenant: otherTenant,
      outletId: otherOutlet,
    });
    const mineId = await insertTicket(mine, mine.unitIds[0], 0, "in_use");
    const theirId = await insertTicket(theirs, theirs.unitIds[0], 0, "in_use");
    const later = 20 + staleAfterMinutes() + 60;

    const released = await sweep(tenantScope(), later);

    expect(released).toContain(mineId);
    expect(released).not.toContain(theirId);
    expect((await readTicket(theirs, theirId))?.status).toBe("in_use");
    expect(await readUnitStatus(theirs, theirs.unitIds[0])).toBe("in_use");

    // The other tenant's own sweep releases its ticket (nothing is lost).
    expect(await sweep(tenantScope(otherTenant), later)).toEqual([theirId]);
    expect((await readTicket(theirs, theirId))?.status).toBe("completed");
  });
});
