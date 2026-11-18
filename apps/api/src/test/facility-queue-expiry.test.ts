// Facility queue claim expiry and wait estimate against PostgreSQL (PRD v1.7
// §3 F22 "Pemesanan"; FAC-02; beads legend-ke4z, legend-bj5m). Same harness as
// facility-slots-db.test.ts: real services, restricted app role (RLS
// enforced), one seeded facility per test, fixed `now`.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  cancelFacilitySlotHold,
  expireStaleQueueNotifications,
  getFacilityAvailability,
  holdFacilitySlot,
  QUEUE_CLAIM_WINDOW_MINUTES,
  type HoldSlotInput,
} from "../services/facility-slots.service.ts";
import {
  getCurrentFacilityQueueEntry,
  joinFacilityQueue,
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

const at2 = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const join = (f: Seeded, customer: string, minute = 0) =>
  joinFacilityQueue(
    tenantScope(),
    operator,
    customer,
    { facilityId: f.facilityId, areaId: f.areaId },
    at2(minute),
  );

const current = (f: Seeded, customer: string) =>
  getCurrentFacilityQueueEntry(tenantScope(), operator, customer, {
    facilityId: f.facilityId,
  });

const sweep = (context = tenantScope(), minute = 0) =>
  withTenant(db, context, (tx) =>
    expireStaleQueueNotifications(tx, context, at2(minute)),
  );

/** A single-unit facility whose unit is freed, so `first` is notified at NOW. */
async function notifiedQueue() {
  const f = await seedFacility({ units: 1 });
  const blocker = await hold(f, { timing: { kind: "now" } });
  const first = randomUUID();
  const second = randomUUID();
  const firstEntry = await join(f, first, 1);
  const secondEntry = await join(f, second, 2);
  const context = outletScope(f.outletId);
  await withTenant(db, context, (tx) =>
    cancelFacilitySlotHold(tx, context, blocker.ticket.id, null, NOW),
  );
  return { f, first, second, firstEntry, secondEntry };
}

describe("[FAC-02] notified queue entries expire after the claim window (legend-ke4z)", () => {
  it("expires an unclaimed notified entry and notifies the next guest; not before the window", async () => {
    const { f, first, second, firstEntry } = await notifiedQueue();
    expect((await current(f, first))?.status).toBe("notified");
    expect((await current(f, second))?.status).toBe("waiting");

    await sweep(tenantScope(), QUEUE_CLAIM_WINDOW_MINUTES - 1);
    expect((await current(f, first))?.status).toBe("notified");

    const expired = await sweep(tenantScope(), QUEUE_CLAIM_WINDOW_MINUTES + 1);
    expect(expired).toContain(firstEntry.id);
    expect(await current(f, first)).toBeNull();
    const next = await current(f, second);
    expect(next?.status).toBe("notified");
    expect(next?.notifiedAt).toBe(at(QUEUE_CLAIM_WINDOW_MINUTES + 1));

    // Idempotent: the freshly notified guest is inside its own window.
    expect(await sweep(tenantScope(), QUEUE_CLAIM_WINDOW_MINUTES + 2)).toEqual(
      [],
    );
    expect((await current(f, second))?.status).toBe("notified");

    const audit = await owner.query(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE tenant_id = $1 AND event->>'action' = 'facility_queue.claim_expired'
          AND event->>'objectId' = $2`,
      [tenantId, firstEntry.id],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it("a hold attempt itself expires the lapsed claim, so the guest behind is not blocked by it", async () => {
    const { f, first, second } = await notifiedQueue();
    const context = outletScope(f.outletId);
    // `first` never claimed; `second` (promoted by the hold-time expiry) can.
    const later = at2(QUEUE_CLAIM_WINDOW_MINUTES + 1);
    await expect(
      withTenant(db, context, (tx) =>
        holdFacilitySlot(
          tx,
          context,
          holdInput(f, { timing: { kind: "now" }, customerProfileId: first }),
          later,
        ),
      ),
    ).rejects.toMatchObject({ code: "SLOT_UNAVAILABLE" });
    const mine = await withTenant(db, context, (tx) =>
      holdFacilitySlot(
        tx,
        context,
        holdInput(f, { timing: { kind: "now" }, customerProfileId: second }),
        later,
      ),
    );
    expect(mine.ticket.customerProfileId).toBe(second);
  });

  it("a stale notified entry does not inflate the wait estimate before the sweeper runs", async () => {
    const f = await seedFacility({ units: 1 });
    const guest = randomUUID();
    await join(f, guest, 0);
    // One free unit; the guest is notified (as if a unit had just been freed).
    await asOwner(f.tenant, (client) =>
      client.query(
        "UPDATE facility_queue_entries SET status = 'notified', notified_at = $3 WHERE tenant_id = $1 AND facility_id = $2",
        [f.tenant, f.facilityId, NOW.toISOString()],
      ),
    );
    const estimate = (minute: number) =>
      getFacilityAvailability(
        tenantScope(),
        operator,
        { facilityId: f.facilityId, date: "2030-01-15" },
        at2(minute),
      );
    // Inside the window the notified guest uses up the only free unit.
    expect((await estimate(1)).waitEstimate.estimatedWaitMinutes).toBe(0);
    expect((await estimate(1)).waitEstimate.freeUnitsNow).toBe(1);
    // Past the window it no longer does; the queue itself is unchanged.
    const stale = await estimate(QUEUE_CLAIM_WINDOW_MINUTES + 1);
    expect(stale.waitEstimate.freeUnitsNow).toBe(1);
  });

  it("[bj5m] the sweeper in another outlet's scope leaves this outlet's entries alone", async () => {
    const { f, first, firstEntry } = await notifiedQueue();
    const expired = await sweep(
      outletScope(outletB),
      QUEUE_CLAIM_WINDOW_MINUTES + 5,
    );
    expect(expired).not.toContain(firstEntry.id);
    expect((await current(f, first))?.status).toBe("notified");
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("[FAC-02] sweeper and claim cannot interleave (legend-ke4z review)", () => {
  it("the sweep waits for the facility slot lock before expiring entries", async () => {
    const { f, first, firstEntry } = await notifiedQueue();
    let sweepDone = false;
    let sweeping: Promise<string[]> | undefined;
    await asOwner(f.tenant, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`facility-slots:${f.tenant}:${f.facilityId}`],
      );
      sweeping = sweep(tenantScope(), QUEUE_CLAIM_WINDOW_MINUTES + 1).then(
        (ids) => {
          sweepDone = true;
          return ids;
        },
      );
      await sleep(400);
      // A claim in flight owns the lock: the sweep must not have expired it.
      expect(sweepDone).toBe(false);
      expect((await current(f, first))?.status).toBe("notified");
    });
    expect(await sweeping).toContain(firstEntry.id);
    expect(await current(f, first)).toBeNull();
  });

  it("a claim whose entry was expired meanwhile is refused with 409 and leaves no ticket", async () => {
    const { f, first } = await notifiedQueue();
    const context = outletScope(f.outletId);
    let claim: Promise<unknown> | undefined;
    await asOwner(f.tenant, async (client) => {
      // Uncommitted expiry holds the entry's row lock.
      await client.query(
        "UPDATE facility_queue_entries SET status = 'expired' WHERE tenant_id = $1 AND facility_id = $2 AND customer_profile_id = $3",
        [f.tenant, f.facilityId, first],
      );
      claim = withTenant(db, context, (tx) =>
        holdFacilitySlot(
          tx,
          context,
          holdInput(f, { timing: { kind: "now" }, customerProfileId: first }),
          at2(1),
        ),
      ).then(
        () => "claimed",
        (error: unknown) => error,
      );
      await sleep(400);
    });
    expect(await claim).toMatchObject({
      status: 409,
      code: "QUEUE_CLAIM_EXPIRED",
    });
    const tickets = await owner.query(
      "SELECT count(*)::int AS n FROM access_tickets WHERE tenant_id = $1 AND facility_id = $2 AND customer_profile_id = $3",
      [f.tenant, f.facilityId, first],
    );
    expect(tickets.rows[0].n).toBe(0);
  });
});

describe("[FAC-02] wait estimate counts holds that start before the turn ends (legend-ke4z)", () => {
  it("a free unit with a hold starting inside the next turn is not 0 minutes", async () => {
    const f = await seedFacility({ units: 1 });
    // Hold at +15..+35 (+45 with cleaning): overlaps the next 30-minute turn.
    await insertTicketRaw(f, f.unitIds[0], at(15));
    const result = await getFacilityAvailability(
      tenantScope(),
      operator,
      { facilityId: f.facilityId, date: "2030-01-15" },
      NOW,
    );
    expect(result.waitEstimate.freeUnitsNow).toBe(0);
    expect(result.waitEstimate.estimatedWaitMinutes).toBe(45);
  });

  it("a hold that starts after the next turn leaves the unit free (0 minutes)", async () => {
    const f = await seedFacility({ units: 1 });
    await insertTicketRaw(f, f.unitIds[0], at(30));
    const result = await getFacilityAvailability(
      tenantScope(),
      operator,
      { facilityId: f.facilityId, date: "2030-01-15" },
      NOW,
    );
    expect(result.waitEstimate).toEqual({
      queueLength: 0,
      freeUnitsNow: 1,
      estimatedWaitMinutes: 0,
    });
  });
});
