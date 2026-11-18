// Facility slots against PostgreSQL (PRD v1.7 §3 F22 "Pemesanan", §6 K
// access_tickets exclusion; FAC-02, FAC-06; TEN-01..03; bead legend-nm4f).
// Runs the real services with the restricted app role (RLS enforced). Each
// test seeds its own facility with the owner connection, so tests never see
// each other's units, and `now` is a fixed instant so hours never flake.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema, ulidToUuid } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  holdFacilitySlot,
  cancelFacilitySlotHold,
  getFacilityAvailability,
  releaseExpiredSlotHolds,
  type HoldSlotInput,
} from "../services/facility-slots.service.ts";
import { updateFacilityUnit } from "../services/facility-units.service.ts";
import {
  getCurrentFacilityQueueEntry,
  joinFacilityQueue,
  leaveFacilityQueue,
} from "../services/facility-queue.service.ts";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);
const outletB = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[1].id);
const otherTenant = randomUUID();
const otherBrand = randomUUID();
const otherEntity = randomUUID();
const otherOutlet = randomUUID();
const operator = randomUUID();
const outletBOperator = randomUUID();

/** 2030-01-15 10:00 in Asia/Jakarta (UTC+7), a Tuesday. */
const NOW = new Date("2030-01-15T03:00:00.000Z");
const at = (minutes: number) =>
  new Date(NOW.getTime() + minutes * 60_000).toISOString();

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
const tenantScope = () =>
  establishScopedTenantContext(base(), { kind: "tenant" });
const outletScope = (outletId: string) =>
  establishScopedTenantContext(base(), {
    kind: "outlets",
    outletIds: [outletIdSchema.parse(outletId)],
  });

/** Owner connection with the tenant settings FORCE RLS requires. */
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

/** One facility (session 20 + cleaning 10), one area, N clean units. */
async function seedFacility(
  options: {
    tenant?: string;
    outletId?: string;
    units?: number;
    hours?: { opensAt: string; closesAt: string };
  } = {},
): Promise<Seeded> {
  const tenant = options.tenant ?? tenantId;
  const outletId = options.outletId ?? outletA;
  const facilityId = randomUUID();
  const areaId = randomUUID();
  const unitIds = Array.from({ length: options.units ?? 2 }, () =>
    randomUUID(),
  );
  const hours = options.hours ?? { opensAt: "00:00", closesAt: "23:59" };
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
        JSON.stringify([{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], ...hours }]),
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

const setUnitStatus = (f: Seeded, unitId: string, status: string) =>
  asOwner(f.tenant, (client) =>
    client.query(
      "UPDATE facility_units SET status = $3 WHERE tenant_id = $1 AND id = $2",
      [f.tenant, unitId, status],
    ),
  );

const holdInput = (
  f: Seeded,
  overrides: Partial<HoldSlotInput> = {},
): HoldSlotInput => ({
  facilityId: f.facilityId,
  areaId: f.areaId,
  timing: { kind: "slot", startsAt: at(0) },
  productId: randomUUID(),
  customerProfileId: randomUUID(),
  source: "purchase",
  idempotencyKey: `hold-${randomUUID()}`,
  ...overrides,
});

const hold = (
  f: Seeded,
  overrides: Partial<HoldSlotInput> = {},
  context = outletScope(f.outletId),
) =>
  withTenant(db, context, (tx) =>
    holdFacilitySlot(tx, context, holdInput(f, overrides), NOW),
  );

const code = (reason: unknown) =>
  (reason as { code?: string } | undefined)?.code;
const rejections = (results: PromiseSettledResult<unknown>[]) =>
  results.flatMap((result) =>
    result.status === "rejected" ? [code(result.reason)] : [],
  );

async function insertTicketRaw(
  f: Seeded,
  unitId: string,
  startsAt: string,
  status = "pending_payment",
) {
  const start = Date.parse(startsAt);
  return asOwner(f.tenant, (client) =>
    client.query(
      `INSERT INTO access_tickets (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id,
                                   product_id, source, starts_at, ends_at, cleaning_ends_at, grace_minutes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'purchase', $9, $10, $11, 10, $12)`,
      [
        randomUUID(),
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
      ],
    ),
  );
}

async function seedActor(
  id: string,
  permissions: string[],
  scope: { type: "tenant" } | { type: "outlet"; id: string },
) {
  const roleId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Facility DB', $2)`,
    [id, `${id}@example.test`],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, permissions, allowed_scope_types)
     VALUES ($1, $2, $3, false, $4, $5)`,
    [
      roleId,
      tenantId,
      `Facility test ${roleId.slice(0, 8)}`,
      JSON.stringify(permissions),
      JSON.stringify([scope.type]),
    ],
  );
  await owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      tenantId,
      id,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.id : null,
    ],
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  await seedActor(
    operator,
    ["facility.booth.operate", "facility.config.manage"],
    { type: "tenant" },
  );
  await seedActor(outletBOperator, ["facility.booth.operate"], {
    type: "outlet",
    id: outletB,
  });
  await owner.query(
    `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
     SELECT $1, $2, 'Facility RLS tenant', plan, status, deployment_mode, feature_flags, limits, created_by
       FROM tenants WHERE id = $3`,
    [otherTenant, `facility-rls-${otherTenant.slice(0, 8)}`, tenantId],
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
  await owner.query("DELETE FROM role_assignments WHERE user_id = ANY($1)", [
    [operator, outletBOperator],
  ]);
  await owner.query(
    "DELETE FROM roles WHERE name LIKE 'Facility test %' AND tenant_id = $1",
    [tenantId],
  );
  await owner.query('DELETE FROM "user" WHERE id = ANY($1)', [
    [operator, outletBOperator],
  ]);
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
  await owner.end();
});

describe("FAC-02 no overlapping slot on one unit, cleaning buffer included", () => {
  it("[FAC-02] a hold occupies session + cleaning buffer; the next slot may start exactly when the buffer ends", async () => {
    const f = await seedFacility({ units: 1 });
    const unitId = f.unitIds[0];
    const slotAt = (minute: number) => ({
      unitId,
      timing: { kind: "slot" as const, startsAt: at(minute) },
    });
    const first = await hold(f, slotAt(60));
    expect(first.ticket.status).toBe("pending_payment");
    expect(first.ticket.slot).toEqual({
      startsAt: at(60),
      endsAt: at(80),
      cleaningEndsAt: at(90),
    });
    // Starts while the session or the cleaning buffer still runs: refused.
    for (const minute of [45, 60, 79, 80, 89])
      await expect(hold(f, slotAt(minute)), `+${minute}`).rejects.toMatchObject(
        { code: "SLOT_UNAVAILABLE", status: 409 },
      );
    // Ends exactly when the first starts (its buffer included): no overlap.
    const before = await hold(f, slotAt(30));
    expect(before.ticket.slot.cleaningEndsAt).toBe(at(60));
    // Back-to-back right after the buffer.
    const after = await hold(f, slotAt(90));
    expect(after.ticket.unitId).toBe(unitId);
  });

  it("[FAC-02] CONCURRENCY: six simultaneous holds of the same unit and slot, exactly one wins", async () => {
    const f = await seedFacility({ units: 1 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => hold(f, { unitId: f.unitIds[0] })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rejections(results)).toEqual(Array(5).fill("SLOT_UNAVAILABLE"));
    const rows = await asOwner(f.tenant, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM access_tickets WHERE tenant_id = $1 AND unit_id = $2",
        [f.tenant, f.unitIds[0]],
      ),
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("[FAC-02] CONCURRENCY: simultaneous holds that only overlap through the cleaning buffer, exactly one wins", async () => {
    const f = await seedFacility({ units: 1 });
    const starts = [0, 15, 20, 25, 29];
    const results = await Promise.allSettled(
      starts.map((minute) =>
        hold(f, {
          unitId: f.unitIds[0],
          timing: { kind: "slot", startsAt: at(minute) },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(new Set(rejections(results))).toEqual(new Set(["SLOT_UNAVAILABLE"]));
  });

  it("[FAC-02] CONCURRENCY: without a unit preference, N guests on a 2-unit area get exactly 2 distinct units", async () => {
    const f = await seedFacility({ units: 2 });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => hold(f)),
    );
    const won = results.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    expect(won).toHaveLength(2);
    expect(new Set(won.map((entry) => entry.ticket.unitId)).size).toBe(2);
    expect(rejections(results)).toEqual(Array(3).fill("SLOT_UNAVAILABLE"));
  });

  it("[FAC-02] the database exclusion constraint alone refuses a concurrent overlap (no service lock)", async () => {
    const f = await seedFacility({ units: 1 });
    const unitId = f.unitIds[0];
    const results = await Promise.allSettled([
      insertTicketRaw(f, unitId, at(0)),
      insertTicketRaw(f, unitId, at(10)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as
      PromiseRejectedResult | undefined;
    expect((failed?.reason as { code?: string }).code).toBe("23P01");
    // Back-to-back is legal for the constraint too.
    await insertTicketRaw(f, unitId, at(30));
  });

  it("[FAC-02] cancelled, refunded and no_show tickets release the range; pending, issued, in_use and completed keep it", async () => {
    const f = await seedFacility({ units: 1 });
    const unitId = f.unitIds[0];
    for (const [index, status] of [
      "cancelled",
      "refunded",
      "no_show",
    ].entries())
      await insertTicketRaw(f, unitId, at(index * 40), status);
    // The same range as all three released tickets is free again.
    await insertTicketRaw(f, unitId, at(0));
    for (const status of ["pending_payment", "issued", "in_use", "completed"]) {
      const g = await seedFacility({ units: 1 });
      await insertTicketRaw(g, g.unitIds[0], at(0), status);
      await expect(
        insertTicketRaw(g, g.unitIds[0], at(5)),
        status,
      ).rejects.toMatchObject({ code: "23P01" });
    }
  });

  it("[FAC-02] releasing a hold frees the slot for another guest", async () => {
    const f = await seedFacility({ units: 1 });
    const unitId = f.unitIds[0];
    const first = await hold(f, { unitId });
    await expect(hold(f, { unitId })).rejects.toMatchObject({
      code: "SLOT_UNAVAILABLE",
    });
    const context = outletScope(f.outletId);
    const released = await withTenant(db, context, (tx) =>
      cancelFacilitySlotHold(tx, context, first.ticket.id, null, NOW),
    );
    expect(released.status).toBe("cancelled");
    await expect(
      withTenant(db, context, (tx) =>
        cancelFacilitySlotHold(tx, context, first.ticket.id, null, NOW),
      ),
    ).rejects.toMatchObject({ code: "TICKET_TRANSITION_INVALID" });
    await expect(hold(f, { unitId })).resolves.toBeDefined();
  });

  it("[FAC-02] unpaid holds expire: the sweeper frees the unit after the hold TTL", async () => {
    const f = await seedFacility({ units: 1 });
    const unitId = f.unitIds[0];
    const first = await hold(f, { unitId });
    const context = outletScope(f.outletId);
    expect(
      await withTenant(db, context, (tx) =>
        releaseExpiredSlotHolds(
          tx,
          context,
          new Date(NOW.getTime() + 5 * 60_000),
        ),
      ),
    ).not.toContain(first.ticket.id);
    const released = await withTenant(db, context, (tx) =>
      releaseExpiredSlotHolds(
        tx,
        context,
        new Date(NOW.getTime() + 11 * 60_000),
      ),
    );
    expect(released).toContain(first.ticket.id);
    await expect(hold(f, { unitId })).resolves.toBeDefined();
  });

  it("[FAC-02] a new hold releases this facility's lapsed holds itself, without waiting for the sweeper", async () => {
    const f = await seedFacility({ units: 1 });
    const unitId = f.unitIds[0];
    const first = await hold(f, {
      unitId,
      timing: { kind: "slot", startsAt: at(60) },
    });
    const context = outletScope(f.outletId);
    const later = new Date(NOW.getTime() + 11 * 60_000);
    const second = await withTenant(db, context, (tx) =>
      holdFacilitySlot(
        tx,
        context,
        holdInput(f, { unitId, timing: { kind: "slot", startsAt: at(60) } }),
        later,
      ),
    );
    expect(second.ticket.unitId).toBe(unitId);
    expect(second.ticket.id).not.toBe(first.ticket.id);
    const { rows } = await asOwner(f.tenant, (client) =>
      client.query(
        "SELECT id, status FROM access_tickets WHERE unit_id = $1 AND id = ANY($2::uuid[])",
        [unitId, [first.ticket.id, second.ticket.id].map(ulidToUuid)],
      ),
    );
    // By ticket id, not created_at: that default follows the DB clock.
    const statusOf = (id: string) =>
      rows.find((r: { id: string }) => r.id === ulidToUuid(id))?.status;
    expect(rows).toHaveLength(2);
    expect(statusOf(first.ticket.id)).toBe("cancelled");
    expect(statusOf(second.ticket.id)).toBe("pending_payment");
  });

  it("[FAC-02] the idempotency key is bound to its request: same request replays, a different one is refused", async () => {
    const f = await seedFacility({ units: 2 });
    const input = holdInput(f, { unitId: f.unitIds[0] });
    const context = outletScope(f.outletId);
    const run = (override: Partial<HoldSlotInput> = {}) =>
      withTenant(db, context, (tx) =>
        holdFacilitySlot(tx, context, { ...input, ...override }, NOW),
      );
    const first = await run();
    const again = await run();
    expect(again.replayed).toBe(true);
    expect(again.ticket.id).toBe(first.ticket.id);
    await expect(
      run({ timing: { kind: "slot", startsAt: at(60) } }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", status: 409 });
    // Two identical requests at the same instant create one ticket.
    const racing = holdInput(f, { unitId: f.unitIds[1] });
    const both = await Promise.all([
      withTenant(db, context, (tx) =>
        holdFacilitySlot(tx, context, racing, NOW),
      ),
      withTenant(db, context, (tx) =>
        holdFacilitySlot(tx, context, racing, NOW),
      ),
    ]);
    expect(both[0].ticket.id).toBe(both[1].ticket.id);
  });

  it("[FAC-02] a slot in the past is refused; a session that runs past closing is FACILITY_CLOSED (FAC-06 hours)", async () => {
    const f = await seedFacility({ units: 1 });
    await expect(
      hold(f, { timing: { kind: "slot", startsAt: at(-5) } }),
    ).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
    // Hours 06:00-10:00 Jakarta; NOW is 10:00 sharp, so "now" is already closed.
    const closed = await seedFacility({
      units: 1,
      hours: { opensAt: "06:00", closesAt: "10:00" },
    });
    await expect(
      hold(closed, { timing: { kind: "now" } }),
    ).rejects.toMatchObject({ code: "FACILITY_CLOSED" });
    // Next day: 09:30 fits before the 10:00 close, 09:45 would end after it.
    await expect(
      hold(closed, { timing: { kind: "slot", startsAt: at(24 * 60 - 30) } }),
    ).resolves.toBeDefined();
    await expect(
      hold(closed, { timing: { kind: "slot", startsAt: at(24 * 60 - 15) } }),
    ).rejects.toMatchObject({ code: "FACILITY_CLOSED" });
  });
});

describe("FAC-06 unclean and maintenance units cannot be held", () => {
  it("[FAC-06] needs_cleaning, cleaning and maintenance units are refused with UNIT_NOT_BOOKABLE", async () => {
    for (const status of ["needs_cleaning", "cleaning", "maintenance"]) {
      const f = await seedFacility({ units: 1 });
      await setUnitStatus(f, f.unitIds[0], status);
      await expect(
        hold(f, { unitId: f.unitIds[0] }),
        status,
      ).rejects.toMatchObject({ code: "UNIT_NOT_BOOKABLE", status: 409 });
      // Whichever slot is asked for, "now" or a later one.
      await expect(
        hold(f, { timing: { kind: "slot", startsAt: at(120) } }),
        status,
      ).rejects.toMatchObject({ code: "UNIT_NOT_BOOKABLE" });
      await expect(
        hold(f, { timing: { kind: "now" } }),
        status,
      ).rejects.toMatchObject({ code: "UNIT_NOT_BOOKABLE" });
    }
  });

  it("[FAC-06] auto-assign skips a unit under maintenance and takes the clean one", async () => {
    const f = await seedFacility({ units: 2 });
    await setUnitStatus(f, f.unitIds[0], "maintenance");
    const result = await hold(f);
    expect(result.ticket.unitId).toBe(f.unitIds[1]);
    await expect(hold(f)).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
  });

  it("[FAC-06] CONCURRENCY: after a maintenance flag, simultaneous holds are all refused as UNIT_NOT_BOOKABLE", async () => {
    const f = await seedFacility({ units: 1 });
    const context = tenantScope();
    await updateFacilityUnit(
      context,
      operator,
      f.unitIds[0],
      { action: "flag_maintenance" },
      NOW,
    );
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => hold(f)),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(new Set(rejections(results))).toEqual(
      new Set(["UNIT_NOT_BOOKABLE"]),
    );
  });

  it("[FAC-06] release_maintenance returns the unit as needs_cleaning, still not bookable until cleaned", async () => {
    const f = await seedFacility({ units: 1 });
    const context = tenantScope();
    const flagged = await updateFacilityUnit(
      context,
      operator,
      f.unitIds[0],
      { action: "flag_maintenance" },
      NOW,
    );
    expect(flagged.status).toBe("maintenance");
    const released = await updateFacilityUnit(
      context,
      operator,
      f.unitIds[0],
      { action: "release_maintenance" },
      NOW,
    );
    expect(released.status).toBe("needs_cleaning");
    await expect(hold(f)).rejects.toMatchObject({ code: "UNIT_NOT_BOOKABLE" });
    await expect(
      updateFacilityUnit(
        context,
        operator,
        f.unitIds[0],
        { action: "release_maintenance" },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const audit = await asOwner(tenantId, (client) =>
      client.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND event->>'objectId' = $2",
        [tenantId, f.unitIds[0]],
      ),
    );
    expect(audit.rows[0].n).toBe(2);
  });

  it("[FAC-06] availability marks unclean/maintenance units not bookable and offers no slot on them", async () => {
    const f = await seedFacility({ units: 3 });
    await setUnitStatus(f, f.unitIds[0], "needs_cleaning");
    await setUnitStatus(f, f.unitIds[1], "maintenance");
    const availability = await getFacilityAvailability(
      tenantScope(),
      operator,
      { facilityId: f.facilityId, date: "2030-01-15" },
      NOW,
    );
    const units = availability.areas[0].units;
    expect(units.map((u) => [u.status, u.bookable])).toEqual([
      ["needs_cleaning", false],
      ["maintenance", false],
      ["available", true],
    ]);
    expect(units[0].slots.some((slot) => slot.available)).toBe(false);
    expect(units[1].slots.some((slot) => slot.available)).toBe(false);
    // Slot grid: 30-minute steps (20 session + 10 cleaning) inside operating hours.
    expect(units[2].slots[0].startsAt).toBe("2030-01-14T17:00:00.000Z");
    expect(
      units[2].slots.every(
        (slot) =>
          Date.parse(slot.cleaningEndsAt) - Date.parse(slot.startsAt) ===
          30 * 60_000,
      ),
    ).toBe(true);
    // Past slots are not offered; later ones on the clean unit are.
    expect(
      units[2].slots.find((slot) => slot.startsAt === at(-30))?.available,
    ).toBe(false);
    expect(
      units[2].slots.find((slot) => slot.startsAt === at(30))?.available,
    ).toBe(true);
  });

  it("[FAC-06] availability shows a held slot as taken for its whole cleaning buffer", async () => {
    const f = await seedFacility({ units: 1 });
    await hold(f, {
      unitId: f.unitIds[0],
      timing: { kind: "slot", startsAt: at(30) },
    });
    const availability = await getFacilityAvailability(
      tenantScope(),
      operator,
      { facilityId: f.facilityId, date: "2030-01-15", areaId: f.areaId },
      NOW,
    );
    const slots = availability.areas[0].units[0].slots;
    const byStart = (minute: number) =>
      slots.find((slot) => slot.startsAt === at(minute))?.available;
    expect(byStart(0)).toBe(true);
    expect(byStart(30)).toBe(false);
    expect(byStart(60)).toBe(true);
  });
});

describe("enter-now, queue and wait estimate", () => {
  it("[FAC-02] enter-now takes a free unit, then fails once every unit is taken", async () => {
    const f = await seedFacility({ units: 2 });
    const a = await hold(f, { timing: { kind: "now" } });
    const b = await hold(f, { timing: { kind: "now" } });
    expect(new Set([a.ticket.unitId, b.ticket.unitId]).size).toBe(2);
    expect(a.ticket.slot.startsAt).toBe(NOW.toISOString());
    await expect(hold(f, { timing: { kind: "now" } })).rejects.toMatchObject({
      code: "SLOT_UNAVAILABLE",
    });
  });

  it("[FAC-02] wait estimate: a free unit means 0 minutes; all units busy means the soonest release plus the queue", async () => {
    const f = await seedFacility({ units: 2 });
    const free = await getFacilityAvailability(
      tenantScope(),
      operator,
      { facilityId: f.facilityId, date: "2030-01-15" },
      NOW,
    );
    expect(free.waitEstimate).toEqual({
      queueLength: 0,
      freeUnitsNow: 2,
      estimatedWaitMinutes: 0,
    });
    await hold(f, { timing: { kind: "now" } });
    await hold(f, { timing: { kind: "now" } });
    const guest = randomUUID();
    await joinFacilityQueue(
      tenantScope(),
      operator,
      guest,
      { facilityId: f.facilityId, areaId: f.areaId },
      NOW,
    );
    const busy = await getFacilityAvailability(
      tenantScope(),
      operator,
      { facilityId: f.facilityId, date: "2030-01-15" },
      NOW,
    );
    // Soonest unit is free after session + cleaning (30); one guest waits, two
    // units serve: ceil(1 / 2) * 20 more minutes.
    expect(busy.waitEstimate).toEqual({
      queueLength: 1,
      freeUnitsNow: 0,
      estimatedWaitMinutes: 30 + 20,
    });
  });

  it("[FAC-02] queue is first come first served: a guest cannot jump a waiting guest for the last free unit", async () => {
    const f = await seedFacility({ units: 1 });
    const blocker = await hold(f, { timing: { kind: "now" } });
    const first = randomUUID();
    const second = randomUUID();
    const join = (customer: string, minute: number) =>
      joinFacilityQueue(
        tenantScope(),
        operator,
        customer,
        { facilityId: f.facilityId, areaId: f.areaId },
        new Date(NOW.getTime() + minute * 1000),
      );
    const firstEntry = await join(first, 1);
    await join(second, 2);
    await expect(join(first, 3)).rejects.toMatchObject({
      code: "ALREADY_QUEUED",
      status: 409,
    });
    // The blocker leaves; the unit is free but guest `first` was there first.
    const context = outletScope(f.outletId);
    await withTenant(db, context, (tx) =>
      cancelFacilitySlotHold(tx, context, blocker.ticket.id, null, NOW),
    );
    const entryNow = await getCurrentFacilityQueueEntry(
      tenantScope(),
      operator,
      first,
      { facilityId: f.facilityId },
    );
    expect(entryNow?.id).toBe(firstEntry.id);
    expect(entryNow?.status).toBe("notified");
    await expect(
      hold(f, { timing: { kind: "now" }, customerProfileId: second }),
    ).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
    const mine = await hold(f, {
      timing: { kind: "now" },
      customerProfileId: first,
    });
    expect(mine.ticket.customerProfileId).toBe(first);
    expect(
      await getCurrentFacilityQueueEntry(tenantScope(), operator, first, {
        facilityId: f.facilityId,
      }),
    ).toBeNull();
  });

  it("[FAC-02] CONCURRENCY: two guests join the queue at once and the same guest joining twice gets one place", async () => {
    const f = await seedFacility({ units: 1 });
    const guest = randomUUID();
    const join = (customer: string) =>
      joinFacilityQueue(
        tenantScope(),
        operator,
        customer,
        { facilityId: f.facilityId, areaId: f.areaId },
        NOW,
      );
    const results = await Promise.allSettled([
      join(guest),
      join(guest),
      join(randomUUID()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(rejections(results)).toEqual(["ALREADY_QUEUED"]);
  });

  it("[FAC-02] leaving the queue frees the place; someone else's entry looks missing", async () => {
    const f = await seedFacility({ units: 1 });
    const guest = randomUUID();
    const entry = await joinFacilityQueue(
      tenantScope(),
      operator,
      guest,
      { facilityId: f.facilityId, areaId: f.areaId },
      NOW,
    );
    await expect(
      leaveFacilityQueue(tenantScope(), operator, randomUUID(), entry.id, NOW),
    ).rejects.toMatchObject({ status: 404 });
    await leaveFacilityQueue(tenantScope(), operator, guest, entry.id, NOW);
    expect(
      await getCurrentFacilityQueueEntry(tenantScope(), operator, guest, {
        facilityId: f.facilityId,
      }),
    ).toBeNull();
    await expect(
      joinFacilityQueue(
        tenantScope(),
        operator,
        guest,
        { facilityId: f.facilityId, areaId: f.areaId },
        NOW,
      ),
    ).resolves.toMatchObject({ status: "waiting" });
  });
});

describe("TEN-01..03 isolation", () => {
  it("[TEN-01] another tenant's facility is invisible: reads, availability and holds fail as not found", async () => {
    const theirs = await seedFacility({
      tenant: otherTenant,
      outletId: otherOutlet,
      units: 1,
    });
    const visible = await withTenant(db, tenantScope(), (tx) =>
      tx.execute(
        sql`SELECT id FROM facilities WHERE id = ${theirs.facilityId}`,
      ),
    );
    expect(visible.rows).toHaveLength(0);
    await expect(
      getFacilityAvailability(
        tenantScope(),
        operator,
        { facilityId: theirs.facilityId, date: "2030-01-15" },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      withTenant(db, tenantScope(), (tx) =>
        holdFacilitySlot(
          tx,
          tenantScope(),
          holdInput(theirs, { unitId: theirs.unitIds[0] }),
          NOW,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("[TEN-02] a ticket row naming another tenant is refused by RLS", async () => {
    const f = await seedFacility({ units: 1 });
    await expect(
      withTenant(db, tenantScope(), (tx) =>
        tx.execute(sql`
          INSERT INTO access_tickets (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id,
                                      product_id, source, starts_at, ends_at, cleaning_ends_at, grace_minutes, status)
          VALUES (${randomUUID()}, ${otherTenant}, ${otherOutlet}, ${f.facilityId}, ${f.areaId}, ${f.unitIds[0]},
                  ${randomUUID()}, ${randomUUID()}, 'purchase', now(), now() + interval '20 minutes',
                  now() + interval '30 minutes', 10, 'pending_payment')`),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "42501" }),
    });
  });

  it("[TEN-03] a context that only reaches outlet B cannot see, hold or configure outlet A's facility", async () => {
    const f = await seedFacility({ units: 1 });
    const scopeB = outletScope(outletB);
    const seen = await withTenant(db, scopeB, (tx) =>
      tx.execute(
        sql`SELECT id FROM facility_units WHERE facility_id = ${f.facilityId}`,
      ),
    );
    expect(seen.rows).toHaveLength(0);
    await expect(hold(f, {}, scopeB)).rejects.toMatchObject({ status: 404 });
    await expect(
      getFacilityAvailability(
        scopeB,
        outletBOperator,
        { facilityId: f.facilityId, date: "2030-01-15" },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateFacilityUnit(scopeB, outletBOperator, f.unitIds[0], {
        action: "flag_maintenance",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("[TEN-03] a tenant-wide context with an actor who only holds outlet B is refused at outlet A (403)", async () => {
    const f = await seedFacility({ units: 1 });
    await expect(
      getFacilityAvailability(
        tenantScope(),
        outletBOperator,
        { facilityId: f.facilityId, date: "2030-01-15" },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      updateFacilityUnit(tenantScope(), outletBOperator, f.unitIds[0], {
        action: "flag_maintenance",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      joinFacilityQueue(
        tenantScope(),
        outletBOperator,
        randomUUID(),
        { facilityId: f.facilityId, areaId: f.areaId },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("[TEN-03] a unit cannot sit in a different outlet than its facility (composite FK)", async () => {
    const f = await seedFacility({ units: 1 });
    await expect(
      asOwner(f.tenant, (client) =>
        client.query(
          `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status)
           VALUES ($1, $2, $3, $4, $5, 'X1', 'available')`,
          [randomUUID(), f.tenant, outletB, f.facilityId, f.areaId],
        ),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
