// legend-6qu47 (FAC-07, P1 money): the quota SWEEP runs one transaction per
// subscription. Written from the brief (docs of the card), the existing quota
// tests and public seams only, not from the implementation.
//
// Seams used:
//   syncSubscriptionQuotas(context, now)           tenant sweep (quota)
//   markOverdueSubscriptionsPastDue(context, at)   overdue sweep (billing)
//
// Properties under test:
//  (a) one failing subscription neither rolls back nor blocks the others;
//      the failed one is picked up by the next sweep, once.
//  (b) the sweep never holds a row lock on subscription A while it waits on
//      subscription B (locks are not held across subscriptions).
//  (c) MONEY: running the sweep twice, concurrently, or while a subscription
//      row is locked never issues a double grant and never leaves a paid
//      active period without its grant (no double, no missed).
//
// Assumptions (ambiguous in the brief):
// - The sweep may resolve or reject when one subscription fails; the tests
//   accept both and only assert on the persisted state.
// - A failure is injected with a BEFORE INSERT trigger on entitlement_ledger
//   scoped to one customer_profile_id (test-only, dropped in finally).
// - Order of subscriptions inside the sweep is unspecified: tests never rely
//   on it.
// - (b) for markOverdueSubscriptionsPastDue assumes it must not hold other
//   subscriptions' row locks while waiting on a locked one either; a single
//   set-based UPDATE would fail that test and is to be treated as a finding.
// - Business dates Asia/Jakarta, noon = 05:00Z; seeding as the 488 test file.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { markOverdueSubscriptionsPastDue } from "../services/payment-recurring.service.ts";
import {
  syncSubscriptionQuota,
  syncSubscriptionQuotas,
} from "../services/facility-subscription-quota.ts";
import {
  asTenant,
  createWorld,
  owner,
  seedMember,
  type World,
} from "./member-loyalty-helpers.ts";
import {
  ledgerRows,
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

const sweep = (world: World, at: Date) =>
  syncSubscriptionQuotas(world.context, at);
/** Sweep that is allowed to reject (one failing subscription); state is asserted separately. */
const sweepSettled = (world: World, at: Date) =>
  sweep(world, at).then(
    () => "resolved" as const,
    () => "rejected" as const,
  );
const paidGrants = async (fixture: Fixture) =>
  (await grants(fixture)).filter(
    (row) => row.expires_at === null || row.sessions > 1,
  );

async function statusOf(fixture: Fixture): Promise<string> {
  return asTenant(fixture.world.tenantId, async (client) => {
    const { rows: found } = await client.query<{ status: string }>(
      "SELECT status FROM payment_recurring_subscriptions WHERE id = $1",
      [fixture.subscriptionId],
    );
    return found[0]!.status;
  });
}

/** Open invoice for the next period, as the overdue sweep expects. */
async function addOpenInvoice(fixture: Fixture): Promise<void> {
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
}

/** Holds FOR UPDATE on the subscription row in an open transaction until released. */
async function holdRowLock(
  fixture: Fixture,
): Promise<{ release: () => Promise<void> }> {
  let locked!: () => void;
  const taken = new Promise<void>((resolve) => (locked = resolve));
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const holder = asTenant(fixture.world.tenantId, async (client) => {
    await client.query(
      "SELECT id FROM payment_recurring_subscriptions WHERE id = $1 FOR UPDATE",
      [fixture.subscriptionId],
    );
    locked();
    await gate;
  });
  await Promise.race([taken, holder]);
  return {
    release: async () => {
      open();
      await holder;
    },
  };
}

/** True when someone else holds the row lock (probe uses NOWAIT, never waits). */
async function isRowLocked(fixture: Fixture): Promise<boolean> {
  try {
    await asTenant(fixture.world.tenantId, (client) =>
      client.query(
        "SELECT id FROM payment_recurring_subscriptions WHERE id = $1 FOR UPDATE NOWAIT",
        [fixture.subscriptionId],
      ),
    );
    return false;
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return true;
    throw error;
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Test-only: every ledger insert for this customer fails. Returns the undo. */
async function failLedgerInsertsFor(
  customerProfileId: string,
): Promise<() => Promise<void>> {
  const name = `t_fail_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await owner.query(
    `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected ledger failure'; END $$`,
  );
  await owner.query(
    `CREATE TRIGGER ${name} BEFORE INSERT ON entitlement_ledger FOR EACH ROW
       WHEN (NEW.customer_profile_id = '${customerProfileId}') EXECUTE FUNCTION ${name}()`,
  );
  return async () => {
    await owner.query(`DROP TRIGGER IF EXISTS ${name} ON entitlement_ledger`);
    await owner.query(`DROP FUNCTION IF EXISTS ${name}()`);
  };
}

async function setupMany(world: World, count: number, options: Options = {}) {
  const list: Fixture[] = [];
  for (let i = 0; i < count; i += 1)
    list.push(await setup({ world, ...options }));
  return list;
}

async function expectOnePaidGrant(fixture: Fixture, label: string) {
  expect(
    (await grants(fixture)).map((row) => row.sessions),
    label,
  ).toEqual([QUOTA]);
  expect(await ofType(fixture, "cancel"), label).toHaveLength(0);
  expect(await netGranted(fixture), label).toBe(QUOTA);
}

describe("FAC-07 6qu47 one transaction per subscription: isolation", () => {
  it("FAC-07 6qu47 a failing subscription does not roll back or block the others; it is picked up once by the next sweep", async () => {
    const world = await createWorld();
    const [a, b, c] = await setupMany(world, 3, { grace: 3 });
    const undo = await failLedgerInsertsFor(b!.customerProfileId);
    try {
      await sweepSettled(world, day(-1));
      await expectOnePaidGrant(a!, "A after failing sweep");
      await expectOnePaidGrant(c!, "C after failing sweep");
      expect(await grants(b!), "B failed, nothing persisted").toHaveLength(0);
    } finally {
      await undo();
    }

    await sweep(world, day(-1));
    await expectOnePaidGrant(b!, "B after recovery sweep");
    await expectOnePaidGrant(a!, "A not doubled by recovery sweep");
    await expectOnePaidGrant(c!, "C not doubled by recovery sweep");
  });

  it("FAC-07 6qu47 while the sweep waits on a locked subscription it holds no lock on the others", async () => {
    const world = await createWorld();
    const [a, b, c, locked] = await setupMany(world, 4, { grace: 3 });
    const hold = await holdRowLock(locked!);
    let released = false;
    try {
      const running = sweep(world, day(-1));
      // Let the sweep reach the locked row (or finish the others first).
      await pause(1000);
      for (const [name, fixture] of [
        ["A", a!],
        ["B", b!],
        ["C", c!],
      ] as const)
        expect(
          await isRowLocked(fixture),
          `${name} must not stay locked while the sweep waits on another subscription`,
        ).toBe(false);
      released = true;
      await hold.release();
      await running;
    } finally {
      if (!released) await hold.release();
    }
    for (const fixture of [a!, b!, c!, locked!])
      await expectOnePaidGrant(fixture, "after release");
  });

  it("FAC-07 6qu47 overdue sweep: a locked subscription does not keep the other subscriptions locked, all end past_due once released", async () => {
    const world = await createWorld();
    const list = await setupMany(world, 4, { grace: 3 });
    for (const fixture of list) await addOpenInvoice(fixture);
    const [a, b, c, locked] = list;
    const hold = await holdRowLock(locked!);
    let released = false;
    try {
      const running = markOverdueSubscriptionsPastDue(world.context, day(4));
      await pause(1000);
      for (const [name, fixture] of [
        ["A", a!],
        ["B", b!],
        ["C", c!],
      ] as const)
        expect(
          await isRowLocked(fixture),
          `${name} must not stay locked while the overdue sweep waits on another subscription`,
        ).toBe(false);
      released = true;
      await hold.release();
      await running;
    } finally {
      if (!released) await hold.release();
    }
    for (const fixture of list) {
      expect(await statusOf(fixture)).toBe("past_due");
      // Past grace and unpaid: nothing is granted.
      expect(await grants(fixture)).toHaveLength(0);
    }
    // Replay: nothing changes, nothing is granted.
    await markOverdueSubscriptionsPastDue(world.context, day(4));
    for (const fixture of list) {
      expect(await statusOf(fixture)).toBe("past_due");
      expect(await grants(fixture)).toHaveLength(0);
    }
  });
});

describe("FAC-07 6qu47 MONEY: sweep never doubles and never misses a paid grant", () => {
  it("FAC-07 6qu47 sweep run twice in a row: one paid grant per subscription", async () => {
    const world = await createWorld();
    const list = await setupMany(world, 4, { grace: 3 });
    await sweep(world, day(-1));
    await sweep(world, day(-1));
    for (const [i, fixture] of list.entries())
      await expectOnePaidGrant(fixture, `subscription ${i}`);
  });

  it("FAC-07 6qu47 three concurrent sweeps: one paid grant per subscription, no rejection", async () => {
    const world = await createWorld();
    const list = await setupMany(world, 4, { grace: 3 });
    const results = await Promise.allSettled([
      sweep(world, day(-1)),
      sweep(world, day(-1)),
      sweep(world, day(-1)),
    ]);
    expect(
      results.filter((r) => r.status === "rejected").map((r) => String(r)),
    ).toEqual([]);
    for (const [i, fixture] of list.entries())
      await expectOnePaidGrant(fixture, `subscription ${i}`);
  });

  it("FAC-07 6qu47 two sweeps paused behind a locked subscription: after release no double and none missed", async () => {
    const world = await createWorld();
    const list = await setupMany(world, 4, { grace: 3 });
    const hold = await holdRowLock(list[0]!);
    const results: PromiseSettledResult<unknown>[] = [];
    let running: Promise<unknown> | undefined;
    try {
      running = Promise.allSettled([
        sweep(world, day(-1)),
        sweep(world, day(-1)),
      ]).then((r) => results.push(...r));
      await pause(1000);
    } finally {
      await hold.release();
    }
    await running;
    expect(
      results.filter((r) => r.status === "rejected").map((r) => String(r)),
    ).toEqual([]);
    for (const [i, fixture] of list.entries())
      await expectOnePaidGrant(fixture, `subscription ${i}`);
    // A third sweep afterwards still changes nothing.
    await sweep(world, day(-1));
    for (const [i, fixture] of list.entries())
      await expectOnePaidGrant(fixture, `subscription ${i} after extra sweep`);
  });

  it("FAC-07 6qu47 grace day: repeated and concurrent sweeps give each subscription one grace grant", async () => {
    const world = await createWorld();
    const list = await setupMany(world, 3, { grace: 3 });
    await Promise.all([sweep(world, day(0)), sweep(world, day(0))]);
    await sweep(world, day(0));
    for (const [i, fixture] of list.entries()) {
      const list2 = await grants(fixture);
      expect(
        list2.map((row) => row.sessions),
        `subscription ${i}`,
      ).toEqual([1]);
    }
  });

  it("FAC-07 6qu47 late payment: sweeps (twice, concurrent) keep the total at exactly the quota, one paid grant", async () => {
    const world = await createWorld();
    const list = await setupMany(world, 3, { grace: 3 });
    for (const fixture of list) {
      await sync(fixture, day(0));
      await payLate(fixture);
    }
    await Promise.all([sweep(world, day(1)), sweep(world, day(1))]);
    await sweep(world, day(1));
    for (const [i, fixture] of list.entries()) {
      expect(await netGranted(fixture), `subscription ${i}`).toBe(QUOTA);
      expect(
        (await paidGrants(fixture)).map((row) => row.sessions),
        `subscription ${i}`,
      ).toEqual([QUOTA]);
      // The unused grace grant is cancelled exactly once.
      expect(await ofType(fixture, "cancel"), `subscription ${i}`).toHaveLength(
        1,
      );
    }
  });

  it("FAC-07 6qu47 a failing subscription mid-sweep never double-grants the others on the retry sweep", async () => {
    const world = await createWorld();
    const list = await setupMany(world, 4, { grace: 3 });
    const undo = await failLedgerInsertsFor(list[1]!.customerProfileId);
    try {
      await Promise.all([
        sweepSettled(world, day(-1)),
        sweepSettled(world, day(-1)),
      ]);
    } finally {
      await undo();
    }
    await sweep(world, day(-1));
    for (const [i, fixture] of list.entries())
      await expectOnePaidGrant(fixture, `subscription ${i}`);
  });
});
