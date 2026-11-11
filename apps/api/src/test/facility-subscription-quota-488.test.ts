// legend-488 findings 2, 3, 7 (FAC-07, P1/P2 money): fail-first tests for
// services/facility-subscription-quota.ts. Written from the CTO decisions in
// docs/briefs/488-findings-fixes.md, not from an implementation.
//
// Seam (unchanged): syncSubscriptionQuota(tx, context, { subscriptionId, now })
//   -> Promise<{ issued: LedgerRow[]; cancelled: number }>
//   `cancelled` = number of grant rows cancelled by this call.
//
// Decisions under test:
//  (2) dedup + lock per (subscription, period) ACROSS facilities, incl. grace.
//      Moving the facility plan A -> B inside one period never yields a second
//      quota.
//  (3) pause / cancel / grace lowered below today: the UNUSED part of live
//      grace grants is cancelled atomically (one `cancel` row per grant, for
//      the grant's own facility); used sessions and the paid grant stay.
//  (7) grace is issued PER DAY: each grace day gets one grant of
//      `maxPerDay ?? 1` sessions valid that day only (expires at the next
//      Jakarta midnight), capped so the slice never exceeds the quota.
//
// Assumptions (ambiguous in the brief):
// - Same sync entry point revokes: callers run syncSubscriptionQuota after the
//   status/grace change; no new function is needed.
// - A grace day is issued only for the day of `now` (no back-fill of skipped days).
// - "grace lowered" is tested where the lowered grace removes access today
//   (grace 3 -> 0 on D, 3 -> 1 on D+1); lowering that still grants access today
//   (3 -> 2 on D+1) keeps today's grant (control).
// - A paid grant (source slice paid) is never revoked by pause/cancel.
// - Late payment: G2 = quota - sessions used from per-day grace grants; unused
//   live grace grants are cancelled (as in the base test T4/T5).
// - Business dates Asia/Jakarta, noon = 05:00Z; seeding as the base test file.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { syncSubscriptionQuota } from "../services/facility-subscription-quota.ts";
import {
  asTenant,
  createWorld,
  owner,
  seedMember,
  type World,
} from "./member-loyalty-helpers.ts";
import {
  entitlementsOf,
  ledgerRows,
  rejectionCode,
  seedFacility,
  type LedgerDbRow,
} from "./facility-entitlement-helpers.ts";

afterAll(async () => {
  await owner.end();
});

const QUOTA = 10;
/** Period end of the paid period in every test. */
const D = "2026-10-20";

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}
/** Noon in Jakarta on a business date. */
const noon = (date: string) => new Date(`${date}T05:00:00Z`);
/** Noon in Jakarta of D+offset. */
const day = (offset: number) => noon(addDays(D, offset));
/** Midnight at the start of a Jakarta business date. */
const jakartaMidnight = (date: string) => new Date(`${date}T00:00:00+07:00`);

type SubStatus =
  | "active"
  | "past_due"
  | "paused"
  | "cancelled"
  | "provisioning"
  | "pending_first_payment";

type Options = {
  world?: World;
  outletId?: string;
  status?: SubStatus;
  /** Outlet grace; undefined = no settings row. */
  grace?: number;
  quota?: number;
  maxPerDay?: number | null;
  planInterval?: "month" | "week";
  /** Facility plans linked by provider_plan_id (default 1). */
  facilityPlans?: number;
  /** Facility plan price; default equals the recurring plan amount. */
  facilityPriceIdr?: number;
  periodStart?: string;
  periodEnd?: string;
  nextStart?: string | null;
  nextEnd?: string | null;
};

type Fixture = {
  world: World;
  outletId: string;
  facilityId: string;
  customerProfileId: string;
  subscriptionId: string;
};

/**
 * Seeds an outlet facility, its facility plan, a member and a recurring
 * subscription whose paid period is [D-1 month, D) with an unpaid invoice for
 * the next period (nothing stored in next_period_* unless given).
 */
async function setup(options: Options = {}): Promise<Fixture> {
  const world = options.world ?? (await createWorld());
  const outletId = options.outletId ?? world.outletA;
  const facilityId = await seedFacility(world, outletId);
  const member = await seedMember(world.tenantId);
  const recurringPlanId = randomUUID();
  const subscriptionId = randomUUID();
  const providerPlanId = `plan_${recurringPlanId.slice(0, 8)}`;
  await asTenant(world.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO payment_recurring_plans (id, tenant_id, outlet_id, provider, provider_plan_id, name, amount_idr, interval, status, gateway_integration_id)
       VALUES ($1, $2, $3, 'doit', $4, 'Paket Bulanan', 150000, $5, 'active', $6)`,
      [
        recurringPlanId,
        world.tenantId,
        outletId,
        providerPlanId,
        options.planInterval ?? "month",
        randomUUID(),
      ],
    );
    await client.query(
      `INSERT INTO payment_recurring_subscriptions (id, tenant_id, outlet_id, plan_id, customer_profile_id, provider_subscription_id, status,
              current_period_start, current_period_end, next_period_start, next_period_end, activated_at, gateway_integration_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::varchar, $8, $9, $10, $11, now() - interval '90 days', $12)`,
      [
        subscriptionId,
        world.tenantId,
        outletId,
        recurringPlanId,
        member.id,
        `sub_${subscriptionId.slice(0, 8)}`,
        options.status ?? "active",
        options.periodStart ?? addMonths(D, -1),
        options.periodEnd ?? D,
        options.nextStart ?? null,
        options.nextEnd ?? null,
        randomUUID(),
      ],
    );
    for (let i = 0; i < (options.facilityPlans ?? 1); i += 1)
      await client.query(
        `INSERT INTO facility_subscription_plans (id, tenant_id, outlet_id, facility_id, name, price_idr, quota_per_period, interval, max_per_day, provider_plan_id, is_active)
         VALUES ($1, $2, $3, $4, $5, $9, $6, 'month', $7, $8, true)`,
        [
          randomUUID(),
          world.tenantId,
          outletId,
          facilityId,
          `Langganan ${i}`,
          options.quota ?? QUOTA,
          options.maxPerDay ?? null,
          providerPlanId,
          options.facilityPriceIdr ?? 150000,
        ],
      );
    if (options.grace !== undefined)
      await client.query(
        `INSERT INTO payment_recurring_outlet_settings (tenant_id, outlet_id, grace_days)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, outlet_id) DO UPDATE SET grace_days = EXCLUDED.grace_days`,
        [world.tenantId, outletId, options.grace],
      );
  });
  return {
    world,
    outletId,
    facilityId,
    customerProfileId: member.id,
    subscriptionId,
  };
}

/** Late payment as recurring billing stores it (invoice.paid for [D, D+1 month)). */
async function payLate(fixture: Fixture): Promise<void> {
  await asTenant(fixture.world.tenantId, (client) =>
    client.query(
      `UPDATE payment_recurring_subscriptions
          SET status = 'active', current_period_start = $2, current_period_end = $3,
              next_period_start = NULL, next_period_end = NULL
        WHERE id = $1`,
      [fixture.subscriptionId, D, addMonths(D, 1)],
    ),
  );
}

function sync(fixture: Fixture, at: Date) {
  return withTenant(db, fixture.world.context, (tx) =>
    syncSubscriptionQuota(tx, fixture.world.context, {
      subscriptionId: fixture.subscriptionId,
      now: at,
    }),
  );
}

function redeem(fixture: Fixture, at: Date) {
  return entitlementsOf(fixture.world).redeem({
    facilityId: fixture.facilityId,
    customerProfileId: fixture.customerProfileId,
    at,
  });
}

async function rows(fixture: Fixture): Promise<LedgerDbRow[]> {
  return ledgerRows(fixture.world.tenantId, {
    customerProfileId: fixture.customerProfileId,
  });
}
const grants = async (fixture: Fixture) =>
  (await rows(fixture)).filter(
    (row) => row.type === "grant" && row.source_type === "subscription",
  );
const ofType = async (fixture: Fixture, type: LedgerDbRow["type"]) =>
  (await rows(fixture)).filter((row) => row.type === type);
const sum = (list: LedgerDbRow[]) =>
  list.reduce((total, row) => total + row.sessions, 0);
/** grants - cancel - expire: what the customer was ever entitled to. */
async function netGranted(fixture: Fixture): Promise<number> {
  return (
    sum(await grants(fixture)) -
    sum(await ofType(fixture, "cancel")) -
    sum(await ofType(fixture, "expire"))
  );
}

async function setStatus(fixture: Fixture, status: SubStatus): Promise<void> {
  await asTenant(fixture.world.tenantId, (client) =>
    client.query(
      "UPDATE payment_recurring_subscriptions SET status = $2 WHERE id = $1",
      [fixture.subscriptionId, status],
    ),
  );
}
async function setGrace(fixture: Fixture, grace: number): Promise<void> {
  await asTenant(fixture.world.tenantId, (client) =>
    client.query(
      "UPDATE payment_recurring_outlet_settings SET grace_days = $3 WHERE tenant_id = $1 AND outlet_id = $2",
      [fixture.world.tenantId, fixture.outletId, grace],
    ),
  );
}
/** The operator moves the facility plan to another facility of the outlet. */
async function movePlan(fixture: Fixture): Promise<string> {
  const otherFacilityId = await seedFacility(fixture.world, fixture.outletId);
  await asTenant(fixture.world.tenantId, (client) =>
    client.query(
      "UPDATE facility_subscription_plans SET facility_id = $2 WHERE tenant_id = $1 AND outlet_id = $3",
      [fixture.world.tenantId, otherFacilityId, fixture.outletId],
    ),
  );
  return otherFacilityId;
}
const graceDayGrants = async (fixture: Fixture) =>
  (await grants(fixture)).filter((row) => row.expires_at !== null);

describe("FAC-07 488-2 dedup per (subscription, period) across facilities", () => {
  it("FAC-07 488-2 paid period: moving the plan A -> B after the grant gives no second quota", async () => {
    const fixture = await setup({ grace: 3 });
    expect((await sync(fixture, day(-2))).issued).toHaveLength(1);
    await redeem(fixture, day(-2));
    const otherFacilityId = await movePlan(fixture);

    expect(await sync(fixture, day(-1))).toEqual({ issued: [], cancelled: 0 });
    const list = await grants(fixture);
    expect(list).toHaveLength(1);
    expect(list[0]!.facility_id).toBe(fixture.facilityId);
    expect(list[0]!.facility_id).not.toBe(otherFacilityId);
    expect(await netGranted(fixture)).toBe(QUOTA);
  });

  it("FAC-07 488-2 grace day: moving the plan A -> B the same day gives no second grace grant", async () => {
    const fixture = await setup({ grace: 3 });
    expect((await sync(fixture, day(0))).issued).toHaveLength(1);
    await movePlan(fixture);

    expect(await sync(fixture, day(0))).toEqual({ issued: [], cancelled: 0 });
    expect(await grants(fixture)).toHaveLength(1);
  });

  it("FAC-07 488-2 concurrent syncs after the move still write nothing extra", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(-1));
    await movePlan(fixture);
    await Promise.all([
      sync(fixture, day(-1)),
      sync(fixture, day(-1)),
      sync(fixture, day(-1)),
    ]);
    expect(await grants(fixture)).toHaveLength(1);
    expect(await netGranted(fixture)).toBe(QUOTA);
  });

  it("FAC-07 488-2 concurrent first syncs with a move in between write exactly one grant", async () => {
    const fixture = await setup({ grace: 3 });
    await Promise.all([
      sync(fixture, day(-1)),
      movePlan(fixture).then(() => sync(fixture, day(-1))),
    ]);
    expect(await grants(fixture)).toHaveLength(1);
    expect(await netGranted(fixture)).toBe(QUOTA);
  });

  it("FAC-07 488-2 late payment after a move: unused grace is cancelled on its own facility, total stays at the quota", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    const otherFacilityId = await movePlan(fixture);
    await payLate(fixture);
    await sync(fixture, day(0));

    const cancels = await ofType(fixture, "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.facility_id).toBe(fixture.facilityId);
    expect(await netGranted(fixture)).toBe(QUOTA);
    const paid = (await grants(fixture)).find(
      (row) => row.facility_id === otherFacilityId,
    );
    expect(paid?.sessions).toBe(QUOTA);
  });

  it("FAC-07 488-2 early-paid second month is a new period: it still gets its own quota after a move", async () => {
    const fixture = await setup({
      grace: 3,
      nextStart: D,
      nextEnd: addMonths(D, 2),
    });
    await sync(fixture, day(5));
    await movePlan(fixture);
    const month2 = addMonths(D, 1);
    expect((await sync(fixture, noon(addDays(month2, 3)))).issued).toHaveLength(
      1,
    );
    expect(await grants(fixture)).toHaveLength(2);
  });
});

describe("FAC-07 488-3 revoke unused grace grants", () => {
  it("FAC-07 488-3 pause cancels the unused grace grant and blocks redeem", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    await setStatus(fixture, "paused");

    const result = await sync(fixture, day(0));
    expect(result).toMatchObject({ issued: [], cancelled: 1 });
    const cancels = await ofType(fixture, "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.sessions).toBe(1);
    expect(cancels[0]!.facility_id).toBe(fixture.facilityId);
    expect(await netGranted(fixture)).toBe(0);
    expect(await rejectionCode(redeem(fixture, day(0)))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-07 488-3 cancel cancels only the UNUSED part of a multi-session grace grant", async () => {
    const fixture = await setup({ grace: 3, maxPerDay: 3 });
    await sync(fixture, day(0));
    expect((await graceDayGrants(fixture))[0]!.sessions).toBe(3);
    await redeem(fixture, day(0));
    await setStatus(fixture, "cancelled");

    expect(await sync(fixture, day(0))).toMatchObject({
      issued: [],
      cancelled: 1,
    });
    expect(sum(await ofType(fixture, "cancel"))).toBe(2);
    expect(await ofType(fixture, "redeem")).toHaveLength(1);
    expect(await rejectionCode(redeem(fixture, day(0)))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-07 488-3 grace lowered 3 -> 0 on the due day cancels the unused grace grant", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    await setGrace(fixture, 0);

    expect(await sync(fixture, day(0))).toMatchObject({
      issued: [],
      cancelled: 1,
    });
    expect(await netGranted(fixture)).toBe(0);
    expect(await rejectionCode(redeem(fixture, day(0)))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-07 488-3 grace lowered 3 -> 1 on D+1 cancels today's grant; yesterday's used session stays", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    await redeem(fixture, day(0));
    await sync(fixture, day(1));
    await setGrace(fixture, 1);

    expect(await sync(fixture, day(1))).toMatchObject({
      issued: [],
      cancelled: 1,
    });
    expect(await ofType(fixture, "redeem")).toHaveLength(1);
    expect(sum(await ofType(fixture, "cancel"))).toBe(1);
    expect(await rejectionCode(redeem(fixture, day(1)))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-07 488-3 control: grace lowered but still covering today keeps today's grant", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(1));
    await setGrace(fixture, 2);

    expect(await sync(fixture, day(1))).toEqual({ issued: [], cancelled: 0 });
    expect(await ofType(fixture, "cancel")).toHaveLength(0);
    await redeem(fixture, day(1));
    expect(await ofType(fixture, "redeem")).toHaveLength(1);
  });

  it("FAC-07 488-3 the paid grant is not revoked by pause", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(-1));
    await setStatus(fixture, "paused");

    expect(await sync(fixture, day(-1))).toEqual({ issued: [], cancelled: 0 });
    expect(await ofType(fixture, "cancel")).toHaveLength(0);
    expect(await netGranted(fixture)).toBe(QUOTA);
  });

  it("FAC-07 488-3 revoke is idempotent: repeated and concurrent syncs write one cancel", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    await setStatus(fixture, "paused");
    await Promise.all([sync(fixture, day(0)), sync(fixture, day(0))]);
    expect(await ofType(fixture, "cancel")).toHaveLength(1);
    expect(await sync(fixture, day(0))).toEqual({ issued: [], cancelled: 0 });
    expect(await ofType(fixture, "cancel")).toHaveLength(1);
  });

  it("FAC-07 488-3 a worker racing the pause never leaves usable grace behind", async () => {
    // The worker re-reads the status under the lock: whichever order the pause
    // and the sync run in, after one more sync nothing grace-related is usable.
    for (let i = 0; i < 3; i += 1) {
      const fixture = await setup({ grace: 3 });
      await Promise.all([
        sync(fixture, day(0)),
        setStatus(fixture, "paused"),
        sync(fixture, day(0)),
      ]);
      await sync(fixture, day(0));
      expect(await netGranted(fixture), `run ${i}`).toBe(0);
      expect(await rejectionCode(redeem(fixture, day(0)))).toBe(
        "ENTITLEMENT_INSUFFICIENT",
      );
    }
  });

  it("FAC-07 488-3 revoke after a plan move cancels on the grant's own facility", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    await movePlan(fixture);
    await setStatus(fixture, "paused");
    await sync(fixture, day(0));
    const cancels = await ofType(fixture, "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.facility_id).toBe(fixture.facilityId);
  });
});

describe("FAC-07 488-7 grace is issued per day and honours maxPerDay", () => {
  it("FAC-07 488-7 day 1 of grace gives maxPerDay (default 1), valid until the next Jakarta midnight only", async () => {
    const fixture = await setup({ grace: 3 });
    const result = await sync(fixture, day(0));
    expect(result.issued).toHaveLength(1);
    const [grant] = await grants(fixture);
    expect(grant!.sessions).toBe(1);
    expect(grant!.expires_at?.getTime()).toBe(
      jakartaMidnight(addDays(D, 1)).getTime(),
    );
  });

  it("FAC-07 488-7 the daily limit is enforced: a second redeem on the same grace day is refused", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    await redeem(fixture, day(0));
    expect(await rejectionCode(redeem(fixture, day(0)))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
    // A repeat sync the same day does not top the day up.
    expect(await sync(fixture, day(0))).toEqual({ issued: [], cancelled: 0 });
    expect(await rejectionCode(redeem(fixture, day(0)))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-07 488-7 a new day issues a new daily grant; the old one does not carry over", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    expect((await sync(fixture, day(1))).issued).toHaveLength(1);
    expect((await sync(fixture, day(2))).issued).toHaveLength(1);
    expect(await sync(fixture, day(2))).toEqual({ issued: [], cancelled: 0 });
    // The grace ends after D+2: no D+3 grant.
    expect(await sync(fixture, day(3))).toEqual({ issued: [], cancelled: 0 });

    const list = await grants(fixture);
    expect(list.map((row) => row.sessions)).toEqual([1, 1, 1]);
    expect(list.map((row) => row.expires_at?.getTime())).toEqual([
      jakartaMidnight(addDays(D, 1)).getTime(),
      jakartaMidnight(addDays(D, 2)).getTime(),
      jakartaMidnight(addDays(D, 3)).getTime(),
    ]);
    expect(new Set(list.map((row) => row.source_ref)).size).toBe(3);
  });

  it("FAC-07 488-7 maxPerDay 2 gives 2 sessions per grace day", async () => {
    const fixture = await setup({ grace: 3, maxPerDay: 2 });
    await sync(fixture, day(0));
    await sync(fixture, day(1));
    expect((await grants(fixture)).map((row) => row.sessions)).toEqual([2, 2]);
  });

  it("FAC-07 488-7 skipped days are not back-filled: syncing first on D+2 gives only that day", async () => {
    const fixture = await setup({ grace: 3 });
    expect((await sync(fixture, day(2))).issued).toHaveLength(1);
    expect(await sync(fixture, day(2))).toEqual({ issued: [], cancelled: 0 });
    const list = await grants(fixture);
    expect(list).toHaveLength(1);
    expect(list[0]!.expires_at?.getTime()).toBe(
      jakartaMidnight(addDays(D, 3)).getTime(),
    );
  });

  it("FAC-07 488-7 total grace over the slice never exceeds the quota", async () => {
    const fixture = await setup({ grace: 7, quota: 5, maxPerDay: 2 });
    for (let offset = 0; offset < 7; offset += 1)
      await sync(fixture, day(offset));
    const list = await grants(fixture);
    expect(sum(list)).toBeLessThanOrEqual(5);
    expect(list.map((row) => row.sessions)).toEqual([2, 2, 1]);
  });

  it("FAC-07 488-7 concurrent syncs on one grace day write one grant", async () => {
    const fixture = await setup({ grace: 3 });
    await Promise.all([
      sync(fixture, day(1)),
      sync(fixture, day(1)),
      sync(fixture, day(1)),
    ]);
    expect(await grants(fixture)).toHaveLength(1);
  });

  it("FAC-07 488-7 late payment after per-day grace: unused grants cancelled, new quota = quota - used", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    await redeem(fixture, day(0));
    await sync(fixture, day(1));
    await payLate(fixture);

    const result = await sync(fixture, day(1));
    expect(result.cancelled).toBe(1);
    expect(sum(await ofType(fixture, "cancel"))).toBe(1);
    const paid = (await grants(fixture)).find((row) => row.sessions > 1);
    expect(paid?.sessions).toBe(QUOTA - 1);
    expect(await netGranted(fixture)).toBe(QUOTA);
  });
});
