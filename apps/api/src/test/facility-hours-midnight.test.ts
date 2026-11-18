// Facility hours that run past midnight on the day an hours version changes
// (bead legend-13j7i, card 993, follow-up of legend-4us1a / card 987; PRD F22
// "Konfigurasi Legend" operating hours, FAC-02, FAC-06; TEN-01..03).
//
// Contract (brief-993 section legend-13j7i, not the implementation):
//  - Hours versions (`facility_operating_hours_versions`) are keyed by BUSINESS
//    date. A business date is the outlet-local calendar date of
//    (instant - business_day_cutoff), default cutoff 04:00 (owner Q39,
//    `packages/shared/src/core/time.ts`): 01:30 after a late close still
//    belongs to the day before.
//  - A slot that starts (or ends) after midnight but before the cutoff must be
//    checked against the version of the PREVIOUS calendar date, not the
//    version of its own calendar date. Wrong today on the day a version
//    changes: the slot is checked against the new version.
//  - The 04:00 boundary is respected: a slot from 04:00 on belongs to its own
//    calendar date and uses that date's version.
//  - Slots are not doubled and not lost at the midnight boundary.
//
// Facility hours cannot be overnight in one entry (`closesAt` must be after
// `opensAt`), so a facility open "18:00-02:00" is written as two entries:
// 18:00-23:59 and 00:00-02:00 on every weekday.
//
// Assumptions: the seeded Cafe Legend outlet A runs in Asia/Jakarta with the
// default business day cutoff 04:00. All hours use every weekday so the
// weekday of the version date never matters. Sessions are 20 min + 10 min
// cleaning. The hold `now` is a fixed instant, 2030-01-15 10:00 Jakarta, so no
// slot is in the past. For the availability grid the test does not assume
// whether a slot after midnight is listed under the business date or under
// its calendar date; it only asserts the union of two consecutive dates has
// every slot exactly once and none lost.

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getFacilityAvailability,
  holdFacilitySlot,
  type HoldSlotInput,
} from "../services/facility-slots.service.ts";
import { owner, seededOutletA, seededTenantId } from "./floor-test-helpers.ts";

const tenantId = seededTenantId;
const outletA = outletIdSchema.parse(seededOutletA);
const operator = randomUUID();

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
type Hours = { daysOfWeek: number[]; opensAt: string; closesAt: string }[];
const range = (opensAt: string, closesAt: string) => ({
  daysOfWeek: ALL_DAYS,
  opensAt,
  closesAt,
});

/** 2030-01-15 10:00 in Asia/Jakarta (UTC+7). */
const NOW = new Date("2030-01-15T03:00:00.000Z");
/** Last day of the old version, and the first day of the new one. */
const OLD_DAY = "2030-01-16";
const NEW_DAY = "2030-01-17";
/** Instant of a Jakarta wall clock time, as ISO. */
const jk = (date: string, time: string) =>
  new Date(Date.parse(`${date}T${time}:00+07:00`)).toISOString();

const scope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletA] },
  );
const tenantScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
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

type Seeded = { facilityId: string; areaId: string };
const seeded: string[] = [];

/**
 * One facility (session 20 + cleaning 10, 5 units) whose hours are `before`
 * up to OLD_DAY and `after` from NEW_DAY. A baseline version at 1970-01-01
 * mirrors what the create endpoint seeds.
 */
async function seedFacility(
  label: string,
  before: Hours,
  after: Hours,
): Promise<Seeded> {
  const facilityId = randomUUID();
  const areaId = randomUUID();
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, $4, 'shower', 20, 10, 10, $5, $6, $7)`,
      [
        facilityId,
        tenantId,
        outletA,
        `Shower fhm ${label} ${facilityId.slice(0, 8)}`,
        JSON.stringify(before),
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
    seeded.push(facilityId);
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area', 0)`,
      [areaId, tenantId, outletA, facilityId],
    );
    for (const code of ["P1", "P2", "P3", "P4", "P5"])
      await client.query(
        `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, 'available', 0)`,
        [randomUUID(), tenantId, outletA, facilityId, areaId, code],
      );
    for (const [effectiveFrom, hours] of [
      ["1970-01-01", before],
      [NEW_DAY, after],
    ] as const)
      await client.query(
        `INSERT INTO facility_operating_hours_versions
           (tenant_id, outlet_id, facility_id, effective_from, operating_hours)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, outletA, facilityId, effectiveFrom, JSON.stringify(hours)],
      );
  });
  return { facilityId, areaId };
}

const hold = (f: Seeded, startsAt: string) => {
  const input: HoldSlotInput = {
    facilityId: f.facilityId,
    areaId: f.areaId,
    timing: { kind: "slot", startsAt },
    productId: randomUUID(),
    customerProfileId: randomUUID(),
    source: "purchase",
    idempotencyKey: `fhm-${randomUUID()}`,
  };
  const ctx = scope();
  return withTenant(db, ctx, (tx) => holdFacilitySlot(tx, ctx, input, NOW));
};

const closed = { code: "FACILITY_CLOSED" };

// Overnight hours: open 18:00-02:00, written as two entries.
const OVERNIGHT_TO_02: Hours = [
  range("18:00", "23:59"),
  range("00:00", "02:00"),
];
const EVENING_ONLY_FROM_20: Hours = [range("20:00", "23:59")];
const EVENING_ONLY_FROM_18: Hours = [range("18:00", "23:59")];

// A: open past midnight until the change, evening only after it.
let narrowing: Seeded;
// B: evening only until the change, open past midnight after it.
let widening: Seeded;
// C: open until 06:00 before the change, until 03:00 after it (cutoff 04:00 edge).
let edge: Seeded;
// D: same hours as A, only read by the availability grid (no holds).
let grid: Seeded;

beforeAll(async () => {
  narrowing = await seedFacility("A", OVERNIGHT_TO_02, EVENING_ONLY_FROM_20);
  widening = await seedFacility("B", EVENING_ONLY_FROM_18, OVERNIGHT_TO_02);
  edge = await seedFacility(
    "C",
    [range("18:00", "23:59"), range("00:00", "06:00")],
    [range("18:00", "23:59"), range("00:00", "03:00")],
  );
  grid = await seedFacility("D", OVERNIGHT_TO_02, EVENING_ONLY_FROM_20);
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Facility Midnight', $2)`,
    [operator, `${operator}@example.test`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Facility test fhm ${roleId.slice(0, 8)}`,
      JSON.stringify(["facility.booth.operate"]),
      JSON.stringify(["tenant"]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenantId, operator, roleId],
  );
});

afterAll(async () => {
  await asOwner(async (client) => {
    for (const table of [
      "access_tickets",
      "facility_units",
      "facility_areas",
      "facility_operating_hours_versions",
    ])
      await client.query(
        `DELETE FROM ${table} WHERE tenant_id = $1 AND facility_id = ANY($2)`,
        [tenantId, seeded],
      );
    await client.query(
      "DELETE FROM facilities WHERE tenant_id = $1 AND id = ANY($2)",
      [tenantId, seeded],
    );
  });
  await owner.query("DELETE FROM role_assignments WHERE user_id = $1", [
    operator,
  ]);
  await owner.query(
    "DELETE FROM roles WHERE name LIKE 'Facility test fhm %' AND tenant_id = $1",
    [tenantId],
  );
  await owner.query('DELETE FROM "user" WHERE id = $1', [operator]);
  await owner.end();
});

describe("legend-13j7i slot after midnight on the day the hours version changes", () => {
  it("a slot after midnight uses the version of the business day before, not the new version", async () => {
    // 2030-01-17 00:30 Jakarta belongs to business day 2030-01-16, whose hours
    // are 18:00-02:00. The new version (evening only from 20:00) starts on the
    // business day 2030-01-17 and must not close this slot.
    await expect(hold(narrowing, jk(NEW_DAY, "00:30"))).resolves.toBeDefined();
    await expect(hold(narrowing, jk(NEW_DAY, "01:30"))).resolves.toBeDefined();
  });

  it("a slot that runs across midnight is checked by one version end to end", async () => {
    // 2030-01-16 23:50 -> 2030-01-17 00:10 (+10 min cleaning): the whole slot
    // is business day 2030-01-16, so the old overnight hours cover it. Its
    // end at 00:09 must not be judged by the new version.
    await expect(hold(narrowing, jk(OLD_DAY, "23:50"))).resolves.toBeDefined();
  });

  it("the old version still closes what it closes after midnight", async () => {
    // Old hours end at 02:00: a 01:50 slot would end 02:10 and cannot fit.
    await expect(hold(narrowing, jk(NEW_DAY, "01:50"))).rejects.toMatchObject(
      closed,
    );
    // 03:00 is still business day 2030-01-16 (before the 04:00 cutoff), where
    // the facility is closed from 02:00.
    await expect(hold(narrowing, jk(NEW_DAY, "03:00"))).rejects.toMatchObject(
      closed,
    );
  });

  it("the new version rules from its own business day on", async () => {
    // 2030-01-17 18:30: business day 2030-01-17, evening hours start at 20:00.
    await expect(hold(narrowing, jk(NEW_DAY, "18:30"))).rejects.toMatchObject(
      closed,
    );
    await expect(hold(narrowing, jk(NEW_DAY, "20:30"))).resolves.toBeDefined();
    // 2030-01-18 00:30 is business day 2030-01-17: no after-midnight hours.
    await expect(
      hold(narrowing, jk("2030-01-18", "00:30")),
    ).rejects.toMatchObject(closed);
  });

  it("a newer version that opens after midnight does not open the previous business day", async () => {
    // Old hours (until the business day 2030-01-16): evening only. The new
    // version opens past midnight, but 2030-01-17 01:00 is still business day
    // 2030-01-16 and must stay closed.
    await expect(hold(widening, jk(NEW_DAY, "01:00"))).rejects.toMatchObject(
      closed,
    );
    // The evening of the old day is open as always.
    await expect(hold(widening, jk(OLD_DAY, "19:00"))).resolves.toBeDefined();
    // From the new business day on, after-midnight hours apply:
    // 2030-01-18 01:00 is business day 2030-01-17.
    await expect(
      hold(widening, jk("2030-01-18", "01:00")),
    ).resolves.toBeDefined();
  });

  it("respects the 04:00 business day cutoff on the day of the change", async () => {
    // Old hours reach 06:00, new hours only 03:00 after midnight.
    // 03:30 is before the cutoff: business day 2030-01-16, old hours, open.
    await expect(hold(edge, jk(NEW_DAY, "03:30"))).resolves.toBeDefined();
    // 04:30 is after the cutoff: business day 2030-01-17, new hours, closed.
    await expect(hold(edge, jk(NEW_DAY, "04:30"))).rejects.toMatchObject(
      closed,
    );
  });
});

describe("legend-13j7i availability at the midnight boundary", () => {
  type Slot = { startsAt: string; endsAt: string; available: boolean };
  type UnitSlots = { unitId: string; slots: Slot[] };

  /** Slots of one date, flattened per unit. */
  async function slotsOf(f: Seeded, date: string): Promise<UnitSlots[]> {
    const availability = await getFacilityAvailability(
      tenantScope(),
      operator,
      { facilityId: f.facilityId, date },
      NOW,
    );
    return availability.areas.flatMap((area) =>
      area.units.map((unit) => ({ unitId: unit.unitId, slots: unit.slots })),
    );
  }

  it("lists every slot after midnight exactly once across the two consecutive dates", async () => {
    const days = [
      ...(await slotsOf(grid, OLD_DAY)),
      ...(await slotsOf(grid, NEW_DAY)),
    ];
    const keys = days.flatMap((unit) =>
      unit.slots.map((slot) => `${unit.unitId}|${slot.startsAt}`),
    );
    // Nothing doubled at the boundary, whichever date lists it.
    expect(new Set(keys).size).toBe(keys.length);

    const afterMidnight = days.flatMap((unit) =>
      unit.slots.filter(
        (slot) =>
          slot.available &&
          Date.parse(slot.startsAt) >= Date.parse(jk(NEW_DAY, "00:00")) &&
          Date.parse(slot.startsAt) < Date.parse(jk(NEW_DAY, "04:00")),
      ),
    );
    // Not lost: the old overnight hours (until 02:00) still offer slots after
    // midnight. The new version is evening only and must not take them away.
    expect(afterMidnight.length).toBeGreaterThan(0);
    // None of them runs past the old closing time of 02:00.
    for (const slot of afterMidnight)
      expect(Date.parse(slot.endsAt)).toBeLessThanOrEqual(
        Date.parse(jk(NEW_DAY, "02:00")),
      );
  });

  it("offers the evening of the old day from 18:00 and of the new day only from 20:00", async () => {
    const oldDay = await slotsOf(grid, OLD_DAY);
    const newDay = await slotsOf(grid, NEW_DAY);
    const availableStarts = (units: UnitSlots[]) =>
      units.flatMap((unit) =>
        unit.slots
          .filter((slot) => slot.available)
          .map((slot) => slot.startsAt),
      );
    expect(availableStarts(oldDay)).toContain(jk(OLD_DAY, "18:00"));
    const newEvening = availableStarts(newDay).filter(
      (startsAt) => Date.parse(startsAt) >= Date.parse(jk(NEW_DAY, "04:00")),
    );
    expect(newEvening.length).toBeGreaterThan(0);
    // Every available slot of the new day starts at 20:00 or later.
    for (const startsAt of newEvening)
      expect(Date.parse(startsAt)).toBeGreaterThanOrEqual(
        Date.parse(jk(NEW_DAY, "20:00")),
      );
  });
});
