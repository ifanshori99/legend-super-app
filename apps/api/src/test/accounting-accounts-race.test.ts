// Concurrent chart-of-accounts writes (bead legend-bqup; PRD §3.19 CoA per
// entity). The parent-cycle trigger only sees committed rows, so two
// concurrent parent edits (A.parent=B, B.parent=A) both passed. The chart
// writers take the per-(tenant, legal entity) advisory lock, which makes the
// second edit read the first one's result and refuse the cycle.
//
// Deterministic interleave, no sleeps: a helper client holds the chart
// advisory lock, both writers are started, and the test waits until both are
// parked on that lock (racy code never parks, so the wait times out and the
// test fails). Releasing the helper lets them run one after the other.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { TenantId, UserId } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  createAccount,
  updateAccount,
} from "../services/accounting-accounts.service.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const tenantId = cafeLegendPlatformFixtures.tenant.id;
const userId = randomUUID() as UserId;
const context = establishScopedTenantContext(
  establishTenantContext({
    tenantId: tenantId as TenantId,
    brandId: null,
    source: "session",
  }),
  { kind: "tenant" },
);

afterAll(async () => {
  await owner.end();
});

async function seedEntity(codes: string[]) {
  const entityId = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [entityId, tenantId, `Chart race ${randomBytes(4).toString("hex")}`],
  );
  const ids: string[] = [];
  for (const code of codes) {
    const id = randomUUID();
    ids.push(id);
    await owner.query(
      `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, 'asset', 'cash_and_equivalents')`,
      [id, tenantId, entityId, code, `Akun ${code}`],
    );
  }
  return { entityId, ids };
}

async function advisoryStates(key: string): Promise<boolean[]> {
  const { rows } = await owner.query<{ granted: boolean }>(
    `SELECT granted FROM pg_locks
      WHERE locktype = 'advisory'
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
    [key],
  );
  return rows.map((row) => row.granted);
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Starts both writers while a helper holds the chart lock; releases after both park on it. */
async function raceBehindChartLock<A, B>(
  entityId: string,
  first: () => Promise<A>,
  second: () => Promise<B>,
) {
  const key = `chart_of_accounts:${tenantId}:${entityId}`;
  const helper: PoolClient = await owner.connect();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      await helper.query("COMMIT");
    } finally {
      helper.release();
    }
  };
  try {
    await helper.query("BEGIN");
    await helper.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );
    const a = Promise.allSettled([first()]);
    const b = Promise.allSettled([second()]);
    await waitFor(
      async () =>
        (await advisoryStates(key)).filter((granted) => !granted).length >= 2,
    );
    await release();
    const [[resultA], [resultB]] = await Promise.all([a, b]);
    return { resultA: resultA!, resultB: resultB! };
  } finally {
    await release();
  }
}

describe("legend-bqup chart writes are serialized per legal entity", () => {
  it("two concurrent parent edits that would form a cycle: exactly one wins, no cycle is committed", async () => {
    const { entityId, ids } = await seedEntity(["1101", "1102"]);
    const [a, b] = ids as [string, string];

    const { resultA, resultB } = await raceBehindChartLock(
      entityId,
      () => updateAccount(context, a, { parentId: b }, userId),
      () => updateAccount(context, b, { parentId: a }, userId),
    );

    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
    const { rows } = await owner.query<{
      id: string;
      parent_id: string | null;
    }>(
      "SELECT id, parent_id FROM chart_of_accounts WHERE legal_entity_id = $1",
      [entityId],
    );
    const parents = new Map(rows.map((row) => [row.id, row.parent_id]));
    expect(parents.get(a) === b && parents.get(b) === a).toBe(false);
  });

  it("two concurrent creates of the same code: exactly one wins", async () => {
    const { entityId } = await seedEntity([]);
    const input = {
      code: "9100",
      name: "Akun Sama",
      type: "asset" as const,
      reportGroup: "cash_and_equivalents" as const,
      parentId: null,
    };

    const { resultA, resultB } = await raceBehindChartLock(
      entityId,
      () => createAccount(context, entityId, input, userId),
      () => createAccount(context, entityId, input, userId),
    );

    expect([resultA.status, resultB.status].sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const { rows } = await owner.query(
      "SELECT 1 FROM chart_of_accounts WHERE legal_entity_id = $1 AND code = '9100'",
      [entityId],
    );
    expect(rows).toHaveLength(1);
  });
});
