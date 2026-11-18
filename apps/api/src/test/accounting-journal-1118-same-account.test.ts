// legend 1118 D2: the posting-rule path refuses an entry that debits AND
// credits the same account (fail closed, nothing posted). Written from the
// brief (docs/briefs/1118-fix-kas-ronde7-mapping.md, decision 2), not from the
// poster code.
//
// Setup: a fresh legal entity; the kasbon rule `employee_loan.disbursed`
// (Dr employee_receivable / Cr petty_cash, both asset roles) is posted with
// both roles mapped to ONE account (old data written straight into
// account_mappings as the database owner, bypassing the validation of D1).
//
// Assertions:
// - the poster rejects with AccountingError code JOURNAL_SAME_ACCOUNT_DEBIT_CREDIT;
// - no journal entry and no line exists for the idempotency key, also on a retry;
// - controls: the same rule with two distinct accounts posts Dr/Cr normally,
//   and the order.paid rule on distinct accounts still posts.
//
// Assumptions:
// - Scope is the posting-rule path only (manual journals are not asserted).
// - Employee loan amounts take only `principalIdr` (base rule, no variant).
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { userIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import { db } from "../db";
import { withTenant } from "../db/tenant";
import { postJournalFromRuleInTransaction } from "../services/accounting-journal.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletId = cafeLegendPlatformFixtures.outlets[0].id;
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const unique = () => randomBytes(4).toString("hex");

function scopedContext(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({ tenantId, brandId: null, source: "session" }),
    { kind: "tenant" },
  );
}

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});
afterAll(async () => {
  await owner.end();
});

type World = {
  entity: string;
  cash: string;
  receivable: string;
  revenue: string;
  userId: string;
};

async function makeWorld(): Promise<World> {
  const entity = (
    await owner.query<{ id: string }>(
      "INSERT INTO legal_entities (tenant_id, name) VALUES ($1, $2) RETURNING id",
      [tenantId, `Entitas 1118 ${unique()}`],
    )
  ).rows[0]!.id;
  const account = async (code: string, type: string, group: string) =>
    (
      await owner.query<{ id: string }>(
        `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [tenantId, entity, code, `Akun ${code}`, type, group],
      )
    ).rows[0]!.id;
  const cash = await account("1102", "asset", "cash_and_equivalents");
  const receivable = await account("1204", "asset", "current_asset");
  const revenue = await account("4101", "revenue", "revenue");
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
     VALUES ($1, $2, '2026-11') ON CONFLICT DO NOTHING`,
    [tenantId, entity],
  );
  const userId = randomUUID();
  await owner.query(
    `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`,
    [userId, "Poster 1118", `${userId}@poster-1118.test`],
  );
  return { entity, cash, receivable, revenue, userId };
}

async function mapRole(w: World, role: string, accountId: string) {
  await owner.query(
    `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, legal_entity_id, role) DO UPDATE SET account_id = EXCLUDED.account_id`,
    [tenantId, w.entity, role, accountId],
  );
}

function postLoan(w: World, loanId: string, key = `payroll-gl:loan:${loanId}`) {
  const context = scopedContext();
  return withTenant(db, context, (tx) =>
    postJournalFromRuleInTransaction(tx, context, {
      eventName: "employee_loan.disbursed",
      amounts: { principalIdr: 100_000 },
      legalEntityId: w.entity,
      outletId,
      entryDate: "2026-11-02",
      sourceId: loanId,
      postedBy: userIdSchema.parse(w.userId),
      idempotencyKey: key,
    } as never),
  );
}

async function entriesFor(w: World, key: string) {
  const { rows } = await owner.query<{ n: string; lines: string }>(
    `SELECT count(DISTINCT e.id)::text AS n, count(l.id)::text AS lines
       FROM journal_entries e
       LEFT JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2 AND e.idempotency_key = $3`,
    [tenantId, w.entity, key],
  );
  return { entries: Number(rows[0]!.n), lines: Number(rows[0]!.lines) };
}

describe("1118 poster refuses Dr and Cr on the same account", () => {
  it("[1118-poster-same-account-refused] kasbon rule with employee_receivable and petty_cash on one account: rejected JOURNAL_SAME_ACCOUNT_DEBIT_CREDIT, no entry, no lines, still refused on retry", async () => {
    const w = await makeWorld();
    await mapRole(w, "petty_cash", w.cash);
    await mapRole(w, "employee_receivable", w.cash); // old, wrong mapping
    const loanId = randomUUID();
    const key = `payroll-gl:loan:${loanId}`;

    await expect(postLoan(w, loanId)).rejects.toMatchObject({
      code: "JOURNAL_SAME_ACCOUNT_DEBIT_CREDIT",
    });
    expect(await entriesFor(w, key)).toEqual({ entries: 0, lines: 0 });

    await expect(postLoan(w, loanId)).rejects.toMatchObject({
      code: "JOURNAL_SAME_ACCOUNT_DEBIT_CREDIT",
    });
    expect(await entriesFor(w, key)).toEqual({ entries: 0, lines: 0 });
  }, 60_000);

  it("[1118-poster-distinct-accounts-ok] control: the same kasbon rule with employee_receivable on 1204 posts Dr 1204 / Cr 1102 and a replay returns the same entry", async () => {
    const w = await makeWorld();
    await mapRole(w, "petty_cash", w.cash);
    await mapRole(w, "employee_receivable", w.receivable);
    const loanId = randomUUID();

    const entry = await postLoan(w, loanId);
    const replay = await postLoan(w, loanId);

    expect(entry.lines).toHaveLength(2);
    const byAccount = new Map(
      entry.lines.map((l) => [l.accountId as string, l]),
    );
    expect(byAccount.get(w.receivable)).toMatchObject({
      debitIdr: 100_000,
      creditIdr: 0,
    });
    expect(byAccount.get(w.cash)).toMatchObject({
      debitIdr: 0,
      creditIdr: 100_000,
    });
    expect(replay.id).toBe(entry.id);
    expect(await entriesFor(w, `payroll-gl:loan:${loanId}`)).toEqual({
      entries: 1,
      lines: 2,
    });
  }, 60_000);

  it("[1118-poster-legit-rule-still-posts] control: order.paid (Dr cash_on_hand / Cr sales_revenue) on distinct accounts still posts", async () => {
    const w = await makeWorld();
    await mapRole(w, "cash_on_hand", w.cash);
    await mapRole(w, "sales_revenue", w.revenue);
    const context = scopedContext();
    const orderId = randomUUID();

    const entry = await withTenant(db, context, (tx) =>
      postJournalFromRuleInTransaction(tx, context, {
        eventName: "order.paid",
        amounts: {
          paidCashIdr: 88_000,
          paidGatewayIntentIdr: 0,
          paidDepositIdr: 0,
          paidGatewayIdr: 0,
          paidEdcIdr: 0,
          paidPointsIdr: 0,
          discountIdr: 0,
          grossSalesIdr: 88_000,
          serviceChargeIdr: 0,
          pbjtIdr: 0,
          roundingIdr: 0,
        },
        legalEntityId: w.entity,
        outletId,
        entryDate: "2026-11-02",
        sourceId: orderId,
        postedBy: userIdSchema.parse(w.userId),
        idempotencyKey: `order.paid:${orderId}`,
      } as never),
    );

    expect(entry.lines).toHaveLength(2);
    expect(entry.lines.map((l) => l.accountId).sort()).toEqual(
      [w.cash, w.revenue].sort(),
    );
  }, 60_000);
});
