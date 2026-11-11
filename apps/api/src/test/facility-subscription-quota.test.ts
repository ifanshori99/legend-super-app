// legend-9f1p3 (FAC-07, P1 money): the facility quota of a recurring
// subscription (`entitlement_ledger`, source `subscription`) follows the access
// decision of recurring billing with an EXPLICIT per-outlet `graceDays`.
// Written from the design (scratchpad design-9f1p3.md, T1-T11) and PRD FAC-07,
// not from an implementation.
//
// Seam under test (services/facility-subscription-quota.ts):
//   syncSubscriptionQuota(tx, context, { subscriptionId, now })
//     -> Promise<{ issued: LedgerRow[]; cancelled: number }>
//
// Rule (design): one quota per plan interval ("slice") per subscription.
//  - Paid slice: grant G2 = quota - used(G1), expires at Jakarta midnight of the
//    slice end.
//  - Grace day (unpaid, inside the outlet grace): grant G1 =
//    min(quota, graceDays * (maxPerDay ?? 1)), expires at Jakarta midnight of
//    slice start + graceDays.
//  - When the slice is paid later, the remaining G1 is cancelled and G2 tops up,
//    so grants - cancel - expire per slice never exceed the quota.
//  - No access (grace 0 after the end, past grace, past_due, paused, cancelled,
//    provisioning) or no / ambiguous / interval-mismatched facility plan: nothing.
//
// Assumptions:
// - Business dates are Asia/Jakarta; noon Jakarta (05:00Z) stands for "a day".
// - Grace window is `end <= day < end + graceDays` (design: with grace 3 and
//   end D, days D, D+1, D+2 have access, D+3 not).
// - Interval 'month' is a calendar month (D = 2026-10-20 -> 2026-11-20).
// - A late `invoice.paid` leaves the row `active` with the new period
//   [D, D+1 month) (round-4 REC-46); the test writes that state directly.
// - The recurring<->facility plan link is provider_plan_id only (design).
// - Seeding bypasses the DOIT integration FK with session_replication_role =
//   replica (RLS stays on).
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  markOverdueSubscriptionsPastDue,
  subscriptionAccessPeriod,
  subscriptionHasAccess,
} from "../services/payment-recurring.service.ts";
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

/** Runs the real overdue sweep on a subscription due on D (open invoice for the next period). */
async function markPastDue(fixture: Fixture, at: Date): Promise<void> {
  await asTenant(fixture.world.tenantId, (client) =>
    client.query(
      `INSERT INTO subscription_invoices (id, tenant_id, outlet_id, subscription_id, provider_invoice_id, period_start, period_end,
              amount_idr, hosted_url, status, source_event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 150000, $8, 'open', $9)`,
      [
        randomUUID(),
        fixture.world.tenantId,
        fixture.outletId,
        fixture.subscriptionId,
        `inv_${randomUUID().slice(0, 8)}`,
        D,
        addMonths(D, 1),
        "https://pay.doit.example/invoices/test",
        randomUUID(),
      ],
    ),
  );
  await markOverdueSubscriptionsPastDue(fixture.world.context, at);
}

async function statusOf(fixture: Fixture): Promise<string> {
  return asTenant(fixture.world.tenantId, async (client) => {
    const { rows } = await client.query<{ status: string }>(
      "SELECT status FROM payment_recurring_subscriptions WHERE id = $1",
      [fixture.subscriptionId],
    );
    return rows[0]!.status;
  });
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

describe("FAC-07 pure access decision: graceDays is explicit", () => {
  const sub = {
    status: "active",
    currentPeriodStart: addMonths(D, -1),
    currentPeriodEnd: D,
    nextPeriodStart: null,
    nextPeriodEnd: null,
  } as never;

  it("FAC-07 grace 0: the last paid day (D-1) has access, D and later have none", () => {
    expect(subscriptionHasAccess(sub, day(-1), 0)).toBe(true);
    expect(subscriptionHasAccess(sub, day(0), 0)).toBe(false);
    expect(subscriptionHasAccess(sub, day(1), 0)).toBe(false);
    expect(subscriptionAccessPeriod(sub, day(0), 0)).toBeNull();
  });

  it("FAC-07 grace 3: D, D+1 and D+2 have access, D+3 and later have none", () => {
    for (const offset of [0, 1, 2])
      expect(subscriptionHasAccess(sub, day(offset), 3), `D+${offset}`).toBe(
        true,
      );
    for (const offset of [3, 4, 10])
      expect(subscriptionHasAccess(sub, day(offset), 3), `D+${offset}`).toBe(
        false,
      );
  });

  it("FAC-07 grace 7 is honoured and also ends", () => {
    expect(subscriptionHasAccess(sub, day(6), 7)).toBe(true);
    expect(subscriptionHasAccess(sub, day(7), 7)).toBe(false);
  });
});

describe("FAC-07 T1 grace 0: nothing after the paid period", () => {
  it("FAC-07 T1 quota in the paid period, nothing on the due day, redeem refused", async () => {
    const fixture = await setup({ grace: 0 });
    const result = await sync(fixture, day(-1));
    expect(result.issued).toHaveLength(1);
    const [grant] = await grants(fixture);
    expect(grant).toMatchObject({
      sessions: QUOTA,
      facility_id: fixture.facilityId,
      customer_profile_id: fixture.customerProfileId,
    });
    expect(grant!.expires_at?.getTime()).toBe(jakartaMidnight(D).getTime());

    const before = await rows(fixture);
    const unpaid = await sync(fixture, day(0));
    expect(unpaid).toEqual({ issued: [], cancelled: 0 });
    expect(await rows(fixture)).toHaveLength(before.length);
    expect(await rejectionCode(redeem(fixture, day(0)))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-07 T1 the last paid day still redeems with grace 0", async () => {
    const fixture = await setup({ grace: 0 });
    await sync(fixture, day(-1));
    await redeem(fixture, day(-1));
    expect(await ofType(fixture, "redeem")).toHaveLength(1);
  });
});

describe("FAC-07 T2 grace 3: grace quota is capped and ends", () => {
  it("FAC-07 T2 first grace day gives maxPerDay (default 1) sessions that expire at D+1 00:00 Jakarta", async () => {
    const fixture = await setup({ grace: 3 });
    const result = await sync(fixture, day(0));
    expect(result.issued).toHaveLength(1);
    const [grant] = await grants(fixture);
    expect(grant!.sessions).toBe(1);
    expect(grant!.expires_at?.getTime()).toBe(
      jakartaMidnight(addDays(D, 1)).getTime(),
    );

    await redeem(fixture, day(0));
    expect(await ofType(fixture, "redeem")).toHaveLength(1);

    // D+3: the grace is over, nothing is usable and no new row is written.
    expect(await rejectionCode(redeem(fixture, day(3)))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
    const before = await rows(fixture);
    expect(await sync(fixture, day(3))).toEqual({ issued: [], cancelled: 0 });
    expect(await rows(fixture)).toHaveLength(before.length);
  });

  it("FAC-07 T2 each grace day gives the daily limit and never exceeds the quota", async () => {
    const perDay = await setup({ grace: 3, maxPerDay: 2 });
    await sync(perDay, day(1));
    expect((await grants(perDay))[0]!.sessions).toBe(2);

    const big = await setup({ grace: 3, maxPerDay: 5 });
    await sync(big, day(1));
    expect((await grants(big))[0]!.sessions).toBe(5);

    const small = await setup({ grace: 3, maxPerDay: 5, quota: 3 });
    await sync(small, day(1));
    expect((await grants(small))[0]!.sessions).toBe(3);
  });

  it("FAC-07 T2 the last grace day (D+2) still issues, grace 7 stretches the window", async () => {
    const three = await setup({ grace: 3 });
    expect((await sync(three, day(2))).issued).toHaveLength(1);
    const seven = await setup({ grace: 7 });
    expect((await sync(seven, day(6))).issued).toHaveLength(1);
    const outside = await setup({ grace: 7 });
    expect((await sync(outside, day(7))).issued).toHaveLength(0);
  });
});

describe("FAC-07 T3 past grace and unpaid", () => {
  it("FAC-07 T3 after the overdue sweep (past_due) nothing is issued and nothing is usable", async () => {
    const fixture = await setup({ grace: 3 });
    await markPastDue(fixture, day(4));
    expect(await statusOf(fixture)).toBe("past_due");
    expect(await sync(fixture, day(4))).toEqual({ issued: [], cancelled: 0 });
    expect(await grants(fixture)).toHaveLength(0);
    expect(await rejectionCode(redeem(fixture, day(4)))).toBe(
      "ENTITLEMENT_INSUFFICIENT",
    );
  });

  it("FAC-07 T3 a still-active row past the grace gives nothing either", async () => {
    for (const offset of [3, 10, 60]) {
      const fixture = await setup({ grace: 3 });
      expect(await sync(fixture, day(offset)), `D+${offset}`).toEqual({
        issued: [],
        cancelled: 0,
      });
      expect(await grants(fixture), `D+${offset}`).toHaveLength(0);
    }
  });
});

describe("FAC-07 T4 late payment inside the grace", () => {
  it("FAC-07 T4 remaining grace quota is cancelled and the new quota tops up to exactly the quota", async () => {
    const fixture = await setup({ grace: 3 });
    // One grace grant per day (each expires at the next Jakarta midnight):
    // D and D+1 are used, the D+2 grant is still live and unused.
    await sync(fixture, day(0));
    await redeem(fixture, day(0));
    await sync(fixture, day(1));
    await redeem(fixture, day(1));
    await sync(fixture, day(2));
    await payLate(fixture);

    const result = await sync(fixture, day(2));
    expect(result.cancelled).toBe(1);

    const grantRows = await grants(fixture);
    expect(grantRows.map((row) => row.sessions).sort()).toEqual([1, 1, 1, 8]);
    const cancels = await ofType(fixture, "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.sessions).toBe(1);
    const paid = grantRows.find((row) => row.sessions === 8)!;
    expect(paid.expires_at?.getTime()).toBe(
      jakartaMidnight(addMonths(D, 1)).getTime(),
    );
    expect(await netGranted(fixture)).toBe(QUOTA);
  });

  it("FAC-07 T4 paying late without any grace use gives exactly one full quota", async () => {
    const fixture = await setup({ grace: 3 });
    await payLate(fixture);
    expect((await sync(fixture, day(1))).issued).toHaveLength(1);
    expect(await sync(fixture, day(5))).toEqual({ issued: [], cancelled: 0 });
    const list = await grants(fixture);
    expect(list).toHaveLength(1);
    expect(list[0]!.sessions).toBe(QUOTA);
  });
});

describe("FAC-07 T5 late payment after the grace", () => {
  it("FAC-07 T5 used grace sessions count: the new quota is quota - used, total stays at the quota", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    await sync(fixture, day(1));
    await redeem(fixture, day(1));
    await sync(fixture, day(2));
    // Grace lapses: the 2 unused grace sessions (D and D+2) expire.
    await entitlementsOf(fixture.world).expire(day(4));
    await markPastDue(fixture, day(4));
    expect(await statusOf(fixture)).toBe("past_due");

    // invoice.paid: past_due -> active on the new period.
    await payLate(fixture);
    await sync(fixture, day(5));

    const grantRows = await grants(fixture);
    expect(grantRows.map((row) => row.sessions).sort()).toEqual([1, 1, 1, 9]);
    expect(await netGranted(fixture)).toBe(QUOTA);
  });
});

describe("FAC-07 T6 idempotency", () => {
  it("FAC-07 T6 repeated and concurrent syncs write one G1, one cancel and one G2", async () => {
    const fixture = await setup({ grace: 3 });
    await Promise.all([sync(fixture, day(0)), sync(fixture, day(0))]);
    await sync(fixture, day(0));
    expect(await grants(fixture)).toHaveLength(1);

    // The D grant expired at D+1 00:00 (unswept, unused); D+1 has its own grant.
    await sync(fixture, day(1));
    await redeem(fixture, day(1));
    await payLate(fixture);
    await Promise.all([sync(fixture, day(1)), sync(fixture, day(1))]);
    const after = await rows(fixture);

    expect(await grants(fixture)).toHaveLength(3);
    expect(await ofType(fixture, "cancel")).toHaveLength(1);

    const replay = await sync(fixture, day(1));
    expect(replay).toEqual({ issued: [], cancelled: 0 });
    expect(await rows(fixture)).toHaveLength(after.length);
    expect(await netGranted(fixture)).toBe(QUOTA);
  });
});

describe("FAC-07 T7 per-outlet grace", () => {
  it("FAC-07 T7 the outlet's own grace decides: grace 0 gets nothing, grace 3 gets the grace quota", async () => {
    const world = await createWorld();
    const a = await setup({ world, outletId: world.outletA, grace: 0 });
    const b = await setup({ world, outletId: world.outletB, grace: 3 });
    expect(await sync(a, day(0))).toEqual({ issued: [], cancelled: 0 });
    expect((await sync(b, day(0))).issued).toHaveLength(1);
    expect(await grants(a)).toHaveLength(0);
    expect(await grants(b)).toHaveLength(1);
  });

  it("FAC-07 T7 an outlet without a settings row uses the default 3", async () => {
    const fixture = await setup();
    expect((await sync(fixture, day(0))).issued).toHaveLength(1);
  });
});

describe("FAC-07 T8 facility plan link", () => {
  it("FAC-07 T8 exactly one matching facility plan gives the quota (control)", async () => {
    const fixture = await setup({ grace: 3 });
    expect((await sync(fixture, day(-1))).issued).toHaveLength(1);
  });

  it("FAC-07 T8 no matching facility plan gives nothing", async () => {
    const fixture = await setup({ grace: 3, facilityPlans: 0 });
    expect(await sync(fixture, day(-1))).toEqual({ issued: [], cancelled: 0 });
    expect(await grants(fixture)).toHaveLength(0);
  });

  it("FAC-07 T8 two matching facility plans (ambiguous) give nothing", async () => {
    const fixture = await setup({ grace: 3, facilityPlans: 2 });
    expect(await sync(fixture, day(-1))).toEqual({ issued: [], cancelled: 0 });
    expect(await grants(fixture)).toHaveLength(0);
  });

  it("FAC-07 T8 an interval mismatch (recurring week, facility month) gives nothing", async () => {
    const fixture = await setup({ grace: 3, planInterval: "week" });
    expect(await sync(fixture, day(-1))).toEqual({ issued: [], cancelled: 0 });
    expect(await grants(fixture)).toHaveLength(0);
  });
});

describe("FAC-07 T9 early-paid window of two months", () => {
  it("FAC-07 T9 month 1 and month 2 each get one quota, no third", async () => {
    const fixture = await setup({
      grace: 3,
      periodStart: addMonths(D, -1),
      periodEnd: D,
      nextStart: D,
      nextEnd: addMonths(D, 2),
    });
    // Month 1 of the new window.
    expect((await sync(fixture, noon(addDays(D, 5)))).issued).toHaveLength(1);
    expect(await sync(fixture, noon(addDays(D, 6)))).toEqual({
      issued: [],
      cancelled: 0,
    });
    // Month 2.
    const month2 = addMonths(D, 1);
    expect((await sync(fixture, noon(addDays(month2, 3)))).issued).toHaveLength(
      1,
    );
    expect(await sync(fixture, noon(addDays(month2, 5)))).toEqual({
      issued: [],
      cancelled: 0,
    });

    const list = await grants(fixture);
    expect(list).toHaveLength(2);
    expect(list.map((row) => row.sessions)).toEqual([QUOTA, QUOTA]);
    expect(new Set(list.map((row) => row.source_ref)).size).toBe(2);
    expect(list.map((row) => row.expires_at?.getTime())).toEqual([
      jakartaMidnight(month2).getTime(),
      jakartaMidnight(addMonths(D, 2)).getTime(),
    ]);
  });
});

describe("FAC-07 T10 statuses without access", () => {
  it("FAC-07 T10 paused, cancelled, provisioning and pending subscriptions get nothing", async () => {
    for (const status of [
      "paused",
      "cancelled",
      "provisioning",
      "pending_first_payment",
    ] as const) {
      const fixture = await setup({ status, grace: 3 });
      for (const offset of [-1, 1])
        expect(
          await sync(fixture, day(offset)),
          `${status} D${offset}`,
        ).toEqual({ issued: [], cancelled: 0 });
      expect(await grants(fixture), status).toHaveLength(0);
    }
  });
});

describe("FAC-07 T11 grace quota fully used, then paid", () => {
  it("FAC-07 T11 used = cap: the paid quota is quota - cap and the total never exceeds the quota", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    await redeem(fixture, day(0));
    await payLate(fixture);
    await sync(fixture, day(1));

    const grantRows = await grants(fixture);
    expect(grantRows.map((row) => row.sessions).sort()).toEqual([1, 9]);
    expect(sum(grantRows)).toBe(QUOTA);
    expect(await netGranted(fixture)).toBe(QUOTA);
    expect(sum(await ofType(fixture, "cancel"))).toBe(0);
  });
});

describe("FAC-07 T12 facility plan price differs from the recurring amount", () => {
  it("FAC-07 T12 price mismatch grants nothing, in grace and when paid", async () => {
    // Customer pays 150000; the facility plan sells 100 sessions for 1.000.000.
    const fixture = await setup({
      grace: 3,
      quota: 100,
      facilityPriceIdr: 1_000_000,
    });
    expect(await sync(fixture, day(-1))).toEqual({ issued: [], cancelled: 0 });
    expect(await sync(fixture, day(0))).toEqual({ issued: [], cancelled: 0 });
    await payLate(fixture);
    expect(await sync(fixture, day(1))).toEqual({ issued: [], cancelled: 0 });
    expect(await grants(fixture)).toHaveLength(0);
  });
});

describe("FAC-07 T13 plan re-pointed to another facility mid-grace", () => {
  it("FAC-07 T13 the slice total stays <= quota across facilities", async () => {
    const fixture = await setup({ grace: 3 });
    await sync(fixture, day(0));
    await redeem(fixture, day(0));

    // The operator moves the facility plan to another facility of the outlet.
    const otherFacilityId = await seedFacility(fixture.world, fixture.outletId);
    await asTenant(fixture.world.tenantId, (client) =>
      client.query(
        "UPDATE facility_subscription_plans SET facility_id = $2 WHERE tenant_id = $1 AND outlet_id = $3",
        [fixture.world.tenantId, otherFacilityId, fixture.outletId],
      ),
    );
    await payLate(fixture);
    await sync(fixture, day(1));

    const grantRows = await grants(fixture);
    expect(grantRows.map((row) => row.sessions).sort()).toEqual([1, 9]);
    expect(await netGranted(fixture)).toBeLessThanOrEqual(QUOTA);
    expect(await netGranted(fixture)).toBe(QUOTA);
  });
});
