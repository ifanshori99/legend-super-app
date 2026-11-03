// Promo redemption lock set (bead legend-9w77; PRD v1.7 §3.21; LOY-03).
// redeemPromotions runs inside the POS/QR/website order transaction, so the
// promotion rows it locks stay locked until the order commits. It must lock
// only the promotions that are candidates for THIS bill — in one global id
// order, so concurrent checkouts cannot deadlock — and still re-evaluate with
// the locked counters so quota/budget never over-redeem. Runs against
// PostgreSQL with the restricted app role (RLS enforced), like
// crm-promo-db.test.ts.
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUlid, idr, outletIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type {
  PromoLine,
  PromotionApplicationResult,
} from "@starter/shared/crm";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import {
  redeemPromotions,
  type RedeemPromotionsInput,
} from "../services/crm-promo-engine";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = outletIdSchema.parse(cafeLegendPlatformFixtures.outlets[0].id);

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 5,
});
const createdPromotions: string[] = [];

const context = () =>
  establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "outlets", outletIds: [outletA] },
  );

async function begin(client: PoolClient) {
  await client.query("BEGIN");
  await client.query(
    "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
    [tenantId],
  );
}

/** Owner connection with the tenant settings FORCE RLS requires. */
async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await begin(client);
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

type Seed = {
  percentBp?: number;
  benefit?: unknown;
  extraConditions?: unknown[];
  quotaTotal?: number | null;
  budgetIdr?: number | null;
};

/** An active promotion that applies only to bills holding one of `items`. */
async function seedPromotion(items: string[], seed: Seed = {}) {
  const id = randomUUID();
  createdPromotions.push(id);
  await asOwner((client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
          budget_idr)
       VALUES ($1, $2, $3, '', 'active', NULL, false, now() - interval '1 hour', NULL, $4, $5, $6,
               true, 0, $7, NULL, $8)`,
      [
        id,
        tenantId,
        `Lock test ${id.slice(0, 8)}`,
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: items, minQuantity: 1 },
          ...(seed.extraConditions ?? []),
        ]),
        JSON.stringify(
          seed.benefit ?? {
            kind: "percent_off",
            percentBp: seed.percentBp ?? 1000,
            maxDiscountIdr: null,
          },
        ),
        `g${id.slice(0, 8)}`,
        seed.quotaTotal ?? null,
        seed.budgetIdr ?? null,
      ],
    ),
  );
  return id;
}

async function counters(id: string) {
  const result = await asOwner((client) =>
    client.query(
      "SELECT uses_total, spent_idr FROM promotions WHERE tenant_id = $1 AND id = $2",
      [tenantId, id],
    ),
  );
  return {
    uses: Number(result.rows[0].uses_total),
    spent: Number(result.rows[0].spent_idr),
  };
}

/** "locked" when another transaction holds the promotion row FOR UPDATE. */
async function lockState(id: string): Promise<"locked" | "free"> {
  try {
    await asOwner((client) =>
      client.query(
        "SELECT id FROM promotions WHERE tenant_id = $1 AND id = $2 FOR UPDATE NOWAIT",
        [tenantId, id],
      ),
    );
    return "free";
  } catch (error) {
    if ((error as { code?: string }).code === "55P03") return "locked";
    throw error;
  }
}

/** Waits until some backend is blocked on a promotions row lock. */
async function waitForPromotionLockWait(excludePid: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await owner.query(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE pid <> $1 AND wait_event_type = 'Lock'
          AND query ILIKE '%from "promotions"%' AND query ILIKE '%for update%'`,
      [excludePid],
    );
    if (result.rows[0].waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("redeem never waited on a promotion row lock");
}

const priced = (item: string, unit: number, quantity = 1): PromoLine => ({
  menuItemId: item,
  quantity,
  unitPriceIdr: idr(unit),
  lineTotalIdr: idr(unit * quantity),
});

function redeemInput(lines: PromoLine[]): RedeemPromotionsInput {
  return {
    orderId: createUlid(),
    outletId: outletA,
    channel: "dine_in",
    lines,
    customer: null,
    voucherCode: null,
    at: new Date(),
    actorUserId: null,
  };
}

const redeem = (input: RedeemPromotionsInput) => {
  const scoped = context();
  return withTenant(db, scoped, (tx) => redeemPromotions(tx, scoped, input));
};

const appliedTo = (result: PromotionApplicationResult, promotionId: string) =>
  result.evaluations.some(
    (evaluation) =>
      evaluation.promotionId === promotionId && evaluation.applied,
  );

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  if (createdPromotions.length > 0)
    await asOwner((client) =>
      client.query(
        "UPDATE promotions SET status = 'ended' WHERE tenant_id = $1 AND id = ANY($2)",
        [tenantId, createdPromotions],
      ),
    );
  await owner.end();
});

describe("legend-9w77 redeem locks only the bill's candidate promotions", () => {
  it("[9W77-1] a promotion that cannot apply to the bill stays unlocked during a redeem; an admin edit on it does not wait for the order", async () => {
    const item = randomUUID();
    const applying = await seedPromotion([item]);
    const otherItem = await seedPromotion([randomUUID()]);
    const minSpend = await seedPromotion([item], {
      extraConditions: [{ kind: "min_spend", amountIdr: 5_000_000 }],
    });
    const scoped = context();
    await withTenant(db, scoped, async (tx) => {
      const result = await redeemPromotions(
        tx,
        scoped,
        redeemInput([priced(item, 50_000)]),
      );
      expect(appliedTo(result, applying)).toBe(true);
      // The order transaction is still open here.
      expect(await lockState(applying)).toBe("locked");
      expect(await lockState(otherItem)).toBe("free");
      expect(await lockState(minSpend)).toBe("free");
      // An admin edit on an unrelated promotion commits without blocking.
      const edited = await asOwner(async (client) => {
        await client.query("SET LOCAL lock_timeout = '2s'");
        return client.query(
          "UPDATE promotions SET priority = priority + 1 WHERE tenant_id = $1 AND id = ANY($2) RETURNING id",
          [tenantId, [otherItem, minSpend]],
        );
      });
      expect(edited.rowCount).toBe(2);
    });
    expect((await counters(applying)).uses).toBe(1);
  });

  it("[9W77-2] eligible promotions that lose the stacking pick, or are exhausted right now, are still locked as candidates", async () => {
    const item = randomUUID();
    const winner = await seedPromotion([item], { percentBp: 2000 });
    const runnerUp = await seedPromotion([item], { percentBp: 1000 });
    const exhausted = await seedPromotion([item], {
      percentBp: 3000,
      quotaTotal: 1,
    });
    await asOwner((client) =>
      client.query(
        "UPDATE promotions SET uses_total = 1 WHERE tenant_id = $1 AND id = $2",
        [tenantId, exhausted],
      ),
    );
    const unrelated = await seedPromotion([randomUUID()], { percentBp: 5000 });
    const scoped = context();
    await withTenant(db, scoped, async (tx) => {
      const result = await redeemPromotions(
        tx,
        scoped,
        redeemInput([priced(item, 50_000)]),
      );
      expect(appliedTo(result, winner)).toBe(true);
      expect(result.totalDiscountIdr).toBe(10_000);
      expect(await lockState(winner)).toBe("locked");
      // A runner-up could win if the winner were exhausted under the lock, and
      // an exhausted promotion could be freed by a concurrent void: both are
      // locked so the locked re-evaluation is exact.
      expect(await lockState(runnerUp)).toBe("locked");
      expect(await lockState(exhausted)).toBe("locked");
      expect(await lockState(unrelated)).toBe("free");
    });
  });
});

describe("legend-9w77 candidate set stays race-safe (LOY-03)", () => {
  it("[9W77-3] quota 1 winner under 6 concurrent orders: exactly one gets it, the rest fall back to the runner-up; counters exact", async () => {
    const item = randomUUID();
    const winner = await seedPromotion([item], {
      percentBp: 2000,
      quotaTotal: 1,
    });
    const fallback = await seedPromotion([item], { percentBp: 1000 });
    const unrelated = await seedPromotion([randomUUID()], { quotaTotal: 1 });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        redeem(redeemInput([priced(item, 50_000)])),
      ),
    );
    expect(results.filter((result) => appliedTo(result, winner))).toHaveLength(
      1,
    );
    expect(
      results.filter((result) => appliedTo(result, fallback)),
    ).toHaveLength(5);
    expect(await counters(winner)).toEqual({ uses: 1, spent: 10_000 });
    expect(await counters(fallback)).toEqual({ uses: 5, spent: 25_000 });
    expect(await counters(unrelated)).toEqual({ uses: 0, spent: 0 });
  });

  it("[9W77-3] budget Rp25.000 at Rp10.000 off under 5 concurrent orders: two fit, the rest fall back; spent never passes the budget", async () => {
    const item = randomUUID();
    const capped = await seedPromotion([item], {
      benefit: { kind: "nominal_off", amountIdr: 10_000 },
      budgetIdr: 25_000,
    });
    const fallback = await seedPromotion([item], { percentBp: 1000 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        redeem(redeemInput([priced(item, 60_000)])),
      ),
    );
    expect(results.filter((result) => appliedTo(result, capped))).toHaveLength(
      2,
    );
    expect(
      results.filter((result) => appliedTo(result, fallback)),
    ).toHaveLength(3);
    expect(await counters(capped)).toEqual({ uses: 2, spent: 20_000 });
    expect(await counters(fallback)).toEqual({ uses: 3, spent: 18_000 });
  });

  it("[9W77-3] overlapping candidate sets under concurrency never deadlock and count every use once", async () => {
    const itemA = randomUUID();
    const itemB = randomUUID();
    const onlyA = await seedPromotion([itemA], { percentBp: 1500 });
    const onlyB = await seedPromotion([itemB], { percentBp: 1500 });
    const either = await seedPromotion([itemA, itemB], {
      percentBp: 1000,
      quotaTotal: 3,
    });
    const bills: PromoLine[][] = [];
    for (let index = 0; index < 4; index += 1)
      bills.push(
        [priced(itemA, 40_000)],
        [priced(itemB, 40_000)],
        [priced(itemB, 40_000), priced(itemA, 40_000)],
      );
    const results = await Promise.all(
      bills.map((lines) => redeem(redeemInput(lines))),
    );
    for (const id of [onlyA, onlyB, either]) {
      const applied = results.filter((result) => appliedTo(result, id));
      const discount = applied.reduce(
        (sum, result) =>
          sum +
          result.evaluations.reduce(
            (inner, evaluation) =>
              evaluation.applied && evaluation.promotionId === id
                ? inner + evaluation.discountIdr
                : inner,
            0,
          ),
        0,
      );
      expect(await counters(id)).toEqual({
        uses: applied.length,
        spent: discount,
      });
    }
    expect((await counters(either)).uses).toBeLessThanOrEqual(3);
  });
});

describe("legend-9w77 candidates are locked in ascending id order", () => {
  it("[9W77-4] with the lower-id candidate held elsewhere, redeem waits on it before touching the higher id; with the higher id held, the lower one is already locked", async () => {
    const item = randomUUID();
    const first = await seedPromotion([item], { percentBp: 1000 });
    const second = await seedPromotion([item], { percentBp: 2000 });
    const [low, high] = [first, second].sort();
    if (!low || !high) throw new Error("two promotions expected");

    // Case 1: hold LOW. Ascending order means redeem blocks on LOW first, so
    // HIGH must still be free while it waits.
    const holder = await owner.connect();
    try {
      await begin(holder);
      await holder.query(
        "SELECT id FROM promotions WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantId, low],
      );
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      const pending = redeem(redeemInput([priced(item, 50_000)]));
      await waitForPromotionLockWait(holderPid);
      expect(await lockState(high)).toBe("free");
      await holder.query("ROLLBACK");
      expect((await pending).totalDiscountIdr).toBe(10_000);
    } finally {
      // Never leave the held row locked if an expectation failed.
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }

    // Case 2: hold HIGH. Redeem takes LOW first, then waits on HIGH.
    const holder2 = await owner.connect();
    try {
      await begin(holder2);
      await holder2.query(
        "SELECT id FROM promotions WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenantId, high],
      );
      const holderPid = (await holder2.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid as number;
      const pending = redeem(redeemInput([priced(item, 50_000)]));
      await waitForPromotionLockWait(holderPid);
      expect(await lockState(low)).toBe("locked");
      await holder2.query("ROLLBACK");
      expect((await pending).totalDiscountIdr).toBe(10_000);
    } finally {
      // Never leave the held row locked if an expectation failed.
      await holder2.query("ROLLBACK").catch(() => undefined);
      holder2.release();
    }
  });
});
