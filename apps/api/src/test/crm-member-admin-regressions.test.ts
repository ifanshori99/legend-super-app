// legend-fn7ur: concurrent nightly checks report a discrepancy once per day.
// The gate waits for actual PostgreSQL blockers, so the before-fix race is
// exercised without relying on a sleep or on the machine's scheduling speed.
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "../db/index.ts";
import { runLoyaltyBalanceCheck } from "../worker/loyalty-balance-check.job.ts";
import {
  asTenant,
  createWorld,
  owner,
  seedProfile,
} from "./member-loyalty-helpers.ts";

const NOW = new Date("2026-11-12T12:00:00.000Z");
const TOMORROW = new Date("2026-11-13T12:00:00.000Z");

async function mismatches(tenantId: string, profileId: string) {
  return asTenant(tenantId, async (client) => {
    const result = await client.query<{
      tenant_id: string;
      customer_profile_id: string;
      business_date: string;
      details: { pointsBalance: number; ledgerSum: number };
    }>(
      `SELECT tenant_id, customer_profile_id, business_date::text, details
         FROM loyalty_anomalies
        WHERE tenant_id = $1 AND customer_profile_id = $2
          AND kind = 'balance_mismatch'
        ORDER BY business_date`,
      [tenantId, profileId],
    );
    return result.rows;
  });
}

afterAll(async () => {
  await owner.end();
});

describe("legend-fn7ur balance mismatch concurrency", () => {
  it("FN7UR-BAL-01 two workers record one anomaly per member/day and leave balances and other tenants unchanged", async () => {
    const world = await createWorld();
    const other = await createWorld();
    const profile = await seedProfile(world.tenantId);
    const foreign = await seedProfile(other.tenantId);
    // Simulate historical balance corruption as the migration owner. The job
    // must report it and must never manufacture ledger entries to repair it.
    for (const [tenantId, profileId] of [
      [world.tenantId, profile.id],
      [other.tenantId, foreign.id],
    ] as const) {
      await asTenant(tenantId, (client) =>
        client.query(
          "UPDATE customer_profiles SET points_balance = 50 WHERE tenant_id = $1 AND id = $2",
          [tenantId, profileId],
        ),
      );
    }
    expect(await mismatches(world.tenantId, profile.id)).toEqual([]);
    expect(await mismatches(other.tenantId, foreign.id)).toEqual([]);

    const holder = await owner.connect();
    let pending:
      | ReturnType<
          typeof Promise.all<
            Awaited<ReturnType<typeof runLoyaltyBalanceCheck>>[]
          >
        >
      | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE loyalty_anomalies IN SHARE MODE");
      const result = await holder.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const holderPid = result.rows[0]!.pid;
      pending = Promise.all([
        runLoyaltyBalanceCheck(db, world.context, NOW),
        runLoyaltyBalanceCheck(db, world.context, NOW),
      ]);
      // Before the fix both INSERTs wait on the table; after the fix the
      // second job waits on the first job's advisory lock. Count both chains.
      await vi.waitFor(
        async () => {
          const waiting = await owner.query<{ count: number }>(
            `WITH direct AS (
               SELECT pid FROM pg_stat_activity
                WHERE datname = current_database()
                  AND $1::int = ANY(pg_blocking_pids(pid))
             )
             SELECT count(*)::int AS count FROM pg_stat_activity a
              WHERE a.datname = current_database()
                AND (a.pid IN (SELECT pid FROM direct)
                  OR EXISTS (SELECT 1 FROM direct d
                              WHERE d.pid = ANY(pg_blocking_pids(a.pid))))`,
            [holderPid],
          );
          expect(waiting.rows[0]!.count).toBeGreaterThanOrEqual(2);
        },
        { timeout: 15_000, interval: 25 },
      );
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }

    const results = await pending!;
    expect(results.reduce((sum, result) => sum + result.recorded, 0)).toBe(1);
    expect(await mismatches(world.tenantId, profile.id)).toEqual([
      {
        tenant_id: world.tenantId,
        customer_profile_id: profile.id,
        business_date: "2026-11-12",
        details: { pointsBalance: 50, ledgerSum: 0 },
      },
    ]);
    expect(await mismatches(other.tenantId, foreign.id)).toEqual([]);

    expect(
      (await runLoyaltyBalanceCheck(db, world.context, NOW)).recorded,
    ).toBe(0);
    expect(
      (await runLoyaltyBalanceCheck(db, world.context, TOMORROW)).recorded,
    ).toBe(1);
    expect(
      (await mismatches(world.tenantId, profile.id)).map(
        (row) => row.business_date,
      ),
    ).toEqual(["2026-11-12", "2026-11-13"]);
    const balance = await asTenant(world.tenantId, (client) =>
      client.query(
        `SELECT p.points_balance,
                (SELECT count(*)::int FROM point_ledger l
                  WHERE l.tenant_id = p.tenant_id
                    AND l.customer_profile_id = p.id) AS ledger_rows
           FROM customer_profiles p WHERE tenant_id = $1 AND id = $2`,
        [world.tenantId, profile.id],
      ),
    );
    expect(balance.rows).toEqual([{ points_balance: "50", ledger_rows: 0 }]);
  });
});
