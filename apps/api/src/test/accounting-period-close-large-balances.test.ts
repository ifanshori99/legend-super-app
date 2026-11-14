// Card legend-4lft (docs/briefs/ws-finance-followups.md): the period-close
// snapshot sums cumulative balances per account. The contract amount (Idr) is a
// safe integer, so a cumulative balance above 2^53 - 1 (9_007_199_254_740_991)
// cannot be stored exactly. Coordinator decision: GUARD, do not widen the
// contract. A close that would need such a balance fails with HttpError 422
// PERIOD_BALANCE_OVERFLOW, the period stays open, no snapshot or snapshot line
// is written, and the source journal is untouched and still balanced. A balance
// of exactly 2^53 - 1 still closes and is stored exactly.
//
// Assumptions:
// - Amounts are bigint columns, so the test writes lines as the migration owner
//   with decimal strings (a JS number cannot hold 2^53 + 1).
// - The close is called with the service signature
//   `closeFiscalPeriod(context, periodId, { expectedVersion, idempotencyKey }, actorId)`.
// - Exactness is asserted on stored rows read as text.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userIdSchema } from "@starter/shared/core";
import { closeFiscalPeriod } from "../services/accounting-period-close.service";
import {
  closer,
  makeFixture,
  owner,
  rawInsertEntry,
  tenantId,
  tenantScope,
  withOwner,
  type Fx,
} from "./accounting-ledger-guard-test-helpers";

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterAll(async () => {
  await owner.end();
});

/** One balanced sale entry with an exact decimal-string amount. */
async function postBig(fx: Fx, periodId: string, date: string, amount: string) {
  await withOwner(async (client) => {
    const entryId = await rawInsertEntry(client, {
      entity: fx.entity,
      periodId,
      date,
      lines: null,
    });
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [tenantId, entryId, fx.cash, fx.revenue, amount],
    );
  });
}

function close(periodId: string, expectedVersion: number) {
  return closeFiscalPeriod(
    tenantScope(),
    periodId,
    { expectedVersion, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(closer),
  );
}

/** Stored snapshot balances of a period, amounts as exact text. */
async function storedSnapshot(periodId: string) {
  const { rows } = await owner.query<{
    account_id: string;
    d: string;
    c: string;
  }>(
    `SELECT l.account_id, l.debit_idr::text AS d, l.credit_idr::text AS c
       FROM fiscal_period_snapshot_lines l
       JOIN fiscal_period_snapshots s ON s.id = l.snapshot_id AND s.tenant_id = l.tenant_id
      WHERE s.tenant_id = $1 AND s.fiscal_period_id = $2`,
    [tenantId, periodId],
  );
  return new Map(rows.map((row) => [row.account_id, row]));
}

async function refusal(run: Promise<unknown>) {
  try {
    await run;
  } catch (error) {
    return error as { name?: string; status?: number; code?: string };
  }
  throw new Error("close was accepted");
}

async function periodStatus(periodId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM fiscal_periods WHERE id = $1",
    [periodId],
  );
  return rows[0]!.status;
}

async function snapshotCount(periodId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM fiscal_period_snapshots WHERE tenant_id = $1 AND fiscal_period_id = $2",
    [tenantId, periodId],
  );
  return Number(rows[0]!.n);
}

/** Exact total debit and credit of every journal line of the entity. */
async function journalTotals(fx: Fx) {
  const { rows } = await owner.query<{ d: string; c: string }>(
    `SELECT sum(l.debit_idr)::text AS d, sum(l.credit_idr)::text AS c
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2`,
    [tenantId, fx.entity],
  );
  return { debit: rows[0]!.d, credit: rows[0]!.c };
}

describe("legend-4lft period close guards balances above 2^53 - 1", () => {
  it("ACC-02 control: a cumulative balance of exactly 2^53 - 1 closes and is stored exactly", async () => {
    const fx = await makeFixture();
    await postBig(fx, fx.jan, "2025-01-10", "9007199254740991");
    const closed = await close(fx.jan, 1);
    expect(closed.status).toBe("closed");
    const stored = await storedSnapshot(fx.jan);
    expect(stored.get(fx.cash)?.d).toBe("9007199254740991");
    expect(stored.get(fx.revenue)?.c).toBe("9007199254740991");
  });

  it("ACC-02 one journal of 2^53 + 1 is refused with 422 PERIOD_BALANCE_OVERFLOW; the period stays open and nothing is written", async () => {
    const fx = await makeFixture();
    await postBig(fx, fx.jan, "2025-01-10", "9007199254740993");
    const before = await journalTotals(fx);

    const error = await refusal(close(fx.jan, 1));
    expect(error.name).toBe("HttpError");
    expect(error.status).toBe(422);
    expect(error.code).toBe("PERIOD_BALANCE_OVERFLOW");

    expect(await periodStatus(fx.jan)).toBe("open");
    expect(await snapshotCount(fx.jan)).toBe(0);
    expect((await storedSnapshot(fx.jan)).size).toBe(0);
    const after = await journalTotals(fx);
    expect(after).toEqual(before);
    expect(after).toEqual({
      debit: "9007199254740993",
      credit: "9007199254740993",
    });
  });

  it("ACC-02 two journals of 9e15 and 9e15 + 1: the first month closes exactly, the second (cumulative 18000000000000001) is refused and stays open", async () => {
    const fx = await makeFixture();
    await postBig(fx, fx.jan, "2025-01-10", "9000000000000000");
    await postBig(fx, fx.feb, "2025-02-10", "9000000000000001");

    await close(fx.jan, 1);
    expect((await storedSnapshot(fx.jan)).get(fx.cash)?.d).toBe(
      "9000000000000000",
    );
    const before = await journalTotals(fx);

    const error = await refusal(close(fx.feb, 1));
    expect(error.name).toBe("HttpError");
    expect(error.status).toBe(422);
    expect(error.code).toBe("PERIOD_BALANCE_OVERFLOW");

    expect(await periodStatus(fx.feb)).toBe("open");
    expect(await snapshotCount(fx.feb)).toBe(0);
    expect((await storedSnapshot(fx.feb)).size).toBe(0);
    // The first month's snapshot is unchanged.
    expect((await storedSnapshot(fx.jan)).get(fx.cash)?.d).toBe(
      "9000000000000000",
    );
    const after = await journalTotals(fx);
    expect(after).toEqual(before);
    expect(after).toEqual({
      debit: "18000000000000001",
      credit: "18000000000000001",
    });
  });
});
