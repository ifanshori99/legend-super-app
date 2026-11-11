// Closed fiscal months are sealed by the database itself (bead legend-brq1;
// PRD v1.7 §3.19 "Tutup Periode"; ACC-01, ACC-02). Today only the service
// layer (accounting-period-close / journal services) refuses a post into a
// closed month; a raw INSERT, a seed script or a reversal written straight
// into journal_entries/journal_lines can still change the journal after the
// period snapshot was taken. These tests write SQL directly, so they prove the
// guard holds on every path, not just through the service.
//
// Assumptions (the brief does not pin these down):
// - The trigger error message carries the code PERIOD_CLOSED, the same code the
//   services use and the style of the existing DB errors (PERIOD_MISMATCH,
//   ACCOUNT_INACTIVE in accounting-db.test.ts).
// - A raw entry dated in a closed month is the one that points at the closed
//   fiscal_periods row (entry date and period must agree: PERIOD_MISMATCH).
// - Another legal entity's same month and a later open month stay writable;
//   a reopened month accepts postings again.
// - "Balanced" means: per entry, and per closed month, sum(debit) = sum(credit)
//   and the journal still equals the close snapshot.
//
// Every test owns a fresh legal entity; months are in the past (2025-01/02).

import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  businessDateSchema,
  idr,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { accountIdSchema } from "@starter/shared/accounting";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalInTransaction } from "../services/accounting-journal.service";
import {
  approvePeriodReopen,
  closeFiscalPeriod,
  getPeriodSnapshot,
  requestPeriodReopen,
} from "../services/accounting-period-close.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(4).toString("hex");

const closer = randomUUID();
const requester = randomUUID();
const approver = randomUUID();
let usersReady: Promise<void> | undefined;

function ensureUsers(): Promise<void> {
  usersReady ??= (async () => {
    for (const id of [closer, requester, approver])
      await owner.query(
        'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)',
        [id, "Closed month trigger test", `${id}@example.com`],
      );
  })();
  return usersReady;
}

afterAll(async () => {
  await owner.end();
});

function scopedContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

type Fx = {
  entity: string;
  cash: string;
  revenue: string;
  jan: string; // period ids
  feb: string;
};

async function makeFixture(): Promise<Fx> {
  await ensureUsers();
  const entity = randomUUID();
  const cash = randomUUID();
  const revenue = randomUUID();
  const jan = randomUUID();
  const feb = randomUUID();
  await owner.query(
    "INSERT INTO legal_entities (id, tenant_id, name) VALUES ($1, $2, $3)",
    [entity, tenantId, `Closed month trigger ${unique()}`],
  );
  await owner.query(
    `INSERT INTO chart_of_accounts (id, tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $3, $4, '1101', 'Kas', 'asset', 'cash_and_equivalents'),
            ($2, $3, $4, '4101', 'Penjualan', 'revenue', 'revenue')`,
    [cash, revenue, tenantId, entity],
  );
  await owner.query(
    `INSERT INTO fiscal_periods (id, tenant_id, legal_entity_id, period)
     VALUES ($1, $3, $4, '2025-01'), ($2, $3, $4, '2025-02')`,
    [jan, feb, tenantId, entity],
  );
  return { entity, cash, revenue, jan, feb };
}

/** Posts through the service (open month), so January has real content. */
async function postViaService(fx: Fx, date: string, amount: number) {
  const context = scopedContext();
  const line = (accountId: string, debit: number, credit: number) => ({
    accountId: accountIdSchema.parse(accountId),
    debitIdr: idr(debit),
    creditIdr: idr(credit),
    outletId: null,
    costCenter: null,
  });
  await withTenant(db, context, (tx) =>
    postJournalInTransaction(tx, context, {
      legalEntityId: fx.entity,
      outletId: null,
      entryDate: businessDateSchema.parse(date),
      sourceType: "sale" as const,
      sourceId: randomUUID(),
      description: "Penjualan tunai (closed month trigger test)",
      lines: [line(fx.cash, amount, 0), line(fx.revenue, 0, amount)],
      postedBy: null,
      idempotencyKey: `post-${randomUUID()}`,
    }),
  );
}

async function closeMonth(periodId: string) {
  return closeFiscalPeriod(
    scopedContext(),
    periodId,
    { expectedVersion: 1, idempotencyKey: `close-${randomUUID()}` },
    userIdSchema.parse(closer),
  );
}

/** A fixture whose January holds one 40k sale and is closed. */
async function closedJanuary(): Promise<Fx> {
  const fx = await makeFixture();
  await postViaService(fx, "2025-01-10", 40_000);
  const closed = await closeMonth(fx.jan);
  expect(closed.status).toBe("closed");
  return fx;
}

// ---- Raw SQL writers --------------------------------------------------------

type RawEntry = {
  periodId: string;
  date: string;
  amount: number;
  reversalOf?: string;
  sourceType?: string;
  /** Skip the lines: an entry with no lines must be refused too. */
  withLines?: boolean;
};

async function rawInsertEntry(
  client: PoolClient,
  fx: Fx,
  input: RawEntry,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, $5, NULL, 'Raw insert into closed month', $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      fx.entity,
      input.date,
      input.periodId,
      input.sourceType ?? "sale",
      input.reversalOf ?? null,
      `raw-${randomUUID()}`,
      randomBytes(32).toString("hex"),
    ],
  );
  const entryId = rows[0]!.id;
  if (input.withLines === false) return entryId;
  await client.query(
    `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
     VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
    [tenantId, entryId, fx.cash, fx.revenue, input.amount],
  );
  return entryId;
}

/** One balanced raw entry as the migration owner (seed script / psql path). */
async function ownerInsert(fx: Fx, input: RawEntry): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    const id = await rawInsertEntry(client, fx, input);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** One balanced raw entry as the application database role (the API's path). */
async function appRoleInsert(fx: Fx, input: RawEntry): Promise<string> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const id = await rawInsertEntry(client, fx, input);
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---- Journal readers --------------------------------------------------------

async function entryCount(fx: Fx, periodId: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM journal_entries WHERE legal_entity_id = $1 AND fiscal_period_id = $2",
    [fx.entity, periodId],
  );
  return Number(rows[0]!.n);
}

/** Debit and credit totals of every line posted in a period. */
async function totals(fx: Fx, periodId: string) {
  const { rows } = await owner.query<{ d: string; c: string }>(
    `SELECT COALESCE(sum(l.debit_idr), 0)::text AS d, COALESCE(sum(l.credit_idr), 0)::text AS c
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
      WHERE e.legal_entity_id = $1 AND e.fiscal_period_id = $2`,
    [fx.entity, periodId],
  );
  return { debit: Number(rows[0]!.d), credit: Number(rows[0]!.c) };
}

async function unbalancedEntries(fx: Fx): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM (
       SELECT e.id FROM journal_entries e
         LEFT JOIN journal_lines l ON l.entry_id = e.id AND l.tenant_id = e.tenant_id
        WHERE e.legal_entity_id = $1
        GROUP BY e.id
       HAVING COALESCE(sum(l.debit_idr), 0) <> COALESCE(sum(l.credit_idr), 0)
     ) bad`,
    [fx.entity],
  );
  return Number(rows[0]!.n);
}

// ---- Tests ------------------------------------------------------------------

describe("legend-brq1 closed fiscal month is sealed by a database trigger", () => {
  it("ACC-02 a raw insert as the migration owner into a closed month is refused with PERIOD_CLOSED", async () => {
    const fx = await closedJanuary();
    await expect(
      ownerInsert(fx, { periodId: fx.jan, date: "2025-01-20", amount: 5_000 }),
    ).rejects.toThrow(/PERIOD_CLOSED/);
    expect(await entryCount(fx, fx.jan)).toBe(1);
  });

  it("ACC-02 a raw insert as the application role (the API's own database role) is refused too", async () => {
    const fx = await closedJanuary();
    await expect(
      appRoleInsert(fx, {
        periodId: fx.jan,
        date: "2025-01-31",
        amount: 5_000,
      }),
    ).rejects.toThrow(/PERIOD_CLOSED/);
    expect(await entryCount(fx, fx.jan)).toBe(1);
  });

  it("ACC-02 a raw reversal dated in the closed month is refused (reversals do not bypass the seal)", async () => {
    const fx = await closedJanuary();
    const { rows } = await owner.query<{ id: string }>(
      "SELECT id FROM journal_entries WHERE legal_entity_id = $1 AND fiscal_period_id = $2",
      [fx.entity, fx.jan],
    );
    await expect(
      ownerInsert(fx, {
        periodId: fx.jan,
        date: "2025-01-25",
        amount: 40_000,
        reversalOf: rows[0]!.id,
        sourceType: "reversal",
      }),
    ).rejects.toThrow(/PERIOD_CLOSED/);
    expect(await entryCount(fx, fx.jan)).toBe(1);
  });

  it("ACC-02 an entry without lines is refused in a closed month as well", async () => {
    const fx = await closedJanuary();
    // The closed-month guard must fire on the entry itself, before any line.
    await expect(
      ownerInsert(fx, {
        periodId: fx.jan,
        date: "2025-01-15",
        amount: 0,
        withLines: false,
      }),
    ).rejects.toThrow(/PERIOD_CLOSED/);
    expect(await entryCount(fx, fx.jan)).toBe(1);
  });

  it("ACC-01 the journal stays balanced and equal to the close snapshot after refused writes", async () => {
    const fx = await closedJanuary();
    const snapshot = await getPeriodSnapshot(scopedContext(), fx.jan);

    // A raw insert that the closed month must reject; if the database accepts
    // it the journal drifts away from the snapshot (the bug this card fixes).
    await ownerInsert(fx, {
      periodId: fx.jan,
      date: "2025-01-20",
      amount: 7_000,
    }).catch(() => undefined);

    const journal = await totals(fx, fx.jan);
    expect(journal.debit).toBe(journal.credit);
    const snapshotDebit = snapshot.balances.reduce(
      (sum, row) => sum + Number(row.debitIdr),
      0,
    );
    const snapshotCredit = snapshot.balances.reduce(
      (sum, row) => sum + Number(row.creditIdr),
      0,
    );
    expect(snapshotDebit).toBe(snapshotCredit);
    expect(journal).toEqual({ debit: snapshotDebit, credit: snapshotCredit });
    expect(await unbalancedEntries(fx)).toBe(0);
  });

  it("ACC-01 an unbalanced raw entry in an open month is still refused (the balance rule is not weakened)", async () => {
    const fx = await closedJanuary();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      const entryId = await rawInsertEntry(client, fx, {
        periodId: fx.feb,
        date: "2025-02-05",
        amount: 9_000,
        withLines: false,
      });
      await client.query(
        `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
         VALUES ($1, $2, $3, 1, 9000, 0), ($1, $2, $4, 2, 0, 8000)`,
        [tenantId, entryId, fx.cash, fx.revenue],
      );
      await expect(client.query("COMMIT")).rejects.toThrow(/unbalanced/);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    expect(await unbalancedEntries(fx)).toBe(0);
  });

  it("ACC-02 does not over-block: an open month of the same entity accepts a raw insert", async () => {
    const fx = await closedJanuary();
    await ownerInsert(fx, {
      periodId: fx.feb,
      date: "2025-02-10",
      amount: 3_000,
    });
    expect(await entryCount(fx, fx.feb)).toBe(1);
    expect(await totals(fx, fx.feb)).toEqual({ debit: 3_000, credit: 3_000 });
  });

  it("ACC-02 does not over-block: another legal entity's same month stays writable", async () => {
    const closed = await closedJanuary();
    const other = await makeFixture();
    await ownerInsert(other, {
      periodId: other.jan,
      date: "2025-01-20",
      amount: 2_000,
    });
    expect(await entryCount(other, other.jan)).toBe(1);
    expect(await entryCount(closed, closed.jan)).toBe(1);
  });

  it("ACC-02 a reopened month accepts a raw insert again", async () => {
    const fx = await closedJanuary();
    const request = await requestPeriodReopen(
      scopedContext(),
      fx.jan,
      { reason: "Koreksi kas Januari (closed month trigger test)" },
      userIdSchema.parse(requester),
    );
    await approvePeriodReopen(
      scopedContext(),
      request.id,
      { note: null },
      userIdSchema.parse(approver),
    );
    await ownerInsert(fx, {
      periodId: fx.jan,
      date: "2025-01-21",
      amount: 1_000,
    });
    expect(await entryCount(fx, fx.jan)).toBe(2);
  });
});
