// legend 1118 D4: the release gate script (scripts/preflight/1118-shared-cash-mapping.sql)
// must stay executable AND must really block. Runs the three read-only statements as
// the database owner (RLS bypass). The shared test DB holds rows of other
// tests, so every positive check filters on the legal entity / loan of its own
// world instead of asserting an empty table.
//
// Gate rule (docs/deployment.md, "Gerbang rilis: akun ganda role kas"):
// - a returned row blocks the release;
// - an ERROR (missing column or table, schema drift) also blocks: the script
//   runs with `psql -v ON_ERROR_STOP=1`, so an error is a non-zero exit, never
//   a silent "zero rows". "N/A" is not an outcome of this gate.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { installLoanCashWorld, type Res } from "./helpers/cash-1118-world.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
afterAll(async () => {
  await owner.end();
});

const script = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../../scripts/preflight/1118-shared-cash-mapping.sql",
  ),
  "utf8",
);
const statements = script
  .split(/;\s*\n/)
  .map((part) => part.trim())
  .filter((part) => /^(--[^\n]*\n)*\s*(SELECT|WITH)\b/m.test(part));
const SHARED_ACCOUNTS = statements[0] as string;
const NEW_HOLDS = statements[1] as string;
const SELF_CASH = statements[2] as string;

const AMOUNT = 100_000;
const H = installLoanCashWorld("1118gate");

afterEach(async () => {
  // Never leave a shared mapping behind for the next test.
  await H.setReceivable("1204");
});

async function entityRows<T extends { legal_entity_id: string }>(
  sql: string,
): Promise<T[]> {
  const result = await owner.query<T>(sql);
  return result.rows.filter((row) => row.legal_entity_id === H.W.entityId());
}

/** A paid cash kasbon (event pending) on free 1102 cash. */
async function paidKasbon() {
  await H.drain();
  await H.W.fundPettyCash(AMOUNT);
  const loan = await H.seedLoan(AMOUNT);
  const paid: Res = await H.disburse(loan, AMOUNT);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  return loan;
}

describe("1118 release gate SQL: executes", () => {
  it("has the three statements", () => {
    expect(statements).toHaveLength(3);
  });

  it.each([0, 1, 2])("statement %i runs read-only", async (index) => {
    const result = await owner.query(statements[index] as string);
    expect(Array.isArray(result.rows)).toBe(true);
  });
});

describe("1118 release gate SQL: blocks on a hit", () => {
  it("[1118-gate-shared-account] statement 1 returns a row for employee_receivable and petty_cash on one account, and none once the mapping is clean", async () => {
    expect(
      await entityRows(SHARED_ACCOUNTS),
      "premise: the world starts clean",
    ).toHaveLength(0);

    await H.setReceivableToRoleAccount("petty_cash");
    const rows = await entityRows<{
      legal_entity_id: string;
      account_id: string;
      roles: string[];
    }>(SHARED_ACCOUNTS);
    expect(rows, "the gate must block").toHaveLength(1);
    expect(rows[0]!.roles).toEqual(["employee_receivable", "petty_cash"]);
    expect(rows[0]!.account_id).toBe(await H.mappedAccountId("petty_cash"));

    await H.setReceivable("1204");
    expect(
      await entityRows(SHARED_ACCOUNTS),
      "clean mapping: gate passes",
    ).toHaveLength(0);
  }, 120_000);

  it("[1118-gate-shared-non-cash-ok] statement 1 ignores a shared pair of roles that are not cash", async () => {
    const receivable = await H.mappedAccountId("employee_receivable");
    const original = await H.mappedAccountId("opening_balance_equity");
    // Two non-cash roles on one account: not what the gate looks for.
    await owner.query(
      `UPDATE account_mappings SET account_id = $3
        WHERE tenant_id = (SELECT tenant_id FROM chart_of_accounts WHERE legal_entity_id = $1 LIMIT 1)
          AND legal_entity_id = $1 AND role = $2`,
      [H.W.entityId(), "opening_balance_equity", receivable],
    );
    try {
      expect(await entityRows(SHARED_ACCOUNTS)).toHaveLength(0);
    } finally {
      await owner.query(
        `UPDATE account_mappings SET account_id = $3
          WHERE tenant_id = (SELECT tenant_id FROM chart_of_accounts WHERE legal_entity_id = $1 LIMIT 1)
            AND legal_entity_id = $1 AND role = $2`,
        [H.W.entityId(), "opening_balance_equity", original],
      );
    }
  }, 120_000);

  it("[1118-gate-new-hold] statement 2 lists a delivered cash kasbon whose journal is Dr 1102 / Cr 1102, and not one that really credited 1102", async () => {
    try {
      const stuck = await paidKasbon();
      await H.seedLoanJournal(stuck, AMOUNT); // net zero on 1102
      await H.markDelivered(stuck);
      H.markStuck(stuck);

      const good = await H.seedLoan(AMOUNT);
      await H.W.fundPettyCash(AMOUNT);
      const paid = await H.disburse(good, AMOUNT);
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      await H.seedLoanJournal(good, AMOUNT, AMOUNT); // Dr 1204 / Cr 1102
      await H.markDelivered(good);

      const rows = await entityRows<{
        legal_entity_id: string;
        source_id: string;
        principal_idr: string;
        net_credit_idr: string;
      }>(NEW_HOLDS);
      const ids = rows.map((row) => row.source_id);
      expect(ids, "the gate must block on the net-zero journal").toContain(
        stuck,
      );
      expect(ids, "a journal that really credited 1102 is fine").not.toContain(
        good,
      );
      const hit = rows.find((row) => row.source_id === stuck)!;
      expect(Number(hit.principal_idr)).toBe(AMOUNT);
      expect(Number(hit.net_credit_idr)).toBe(0);
    } finally {
      await H.restoreBaseline();
    }
  }, 180_000);

  it("[1118-gate-new-hold-moved-employee] statement 2 lists a delivered cash reimbursement of an employee who moved to another entity, under the entity of the journal", async () => {
    let undo: (() => Promise<void>) | null = null;
    try {
      await H.drain();
      await H.W.fundPettyCash(AMOUNT);
      const claim = await H.seedClaim(AMOUNT);
      const paid = await H.payClaim(claim, AMOUNT);
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      await H.seedReimbursementJournal(claim, AMOUNT); // net zero on 1102
      await H.markDelivered(claim);
      H.markStuck(claim);
      undo = await H.moveClaimEmployeeToOtherEntity(claim);

      const rows = await entityRows<{
        legal_entity_id: string;
        event_name: string;
        source_id: string;
        net_credit_idr: string;
      }>(NEW_HOLDS);
      const hit = rows.find((row) => row.source_id === claim);
      expect(
        hit,
        "the gate must block under the journal's entity",
      ).toBeDefined();
      expect(hit!.event_name).toBe("reimbursement.paid");
      expect(Number(hit!.net_credit_idr)).toBe(0);
    } finally {
      await undo?.();
      await H.restoreBaseline();
    }
  }, 180_000);

  describe("statement 3: one cash account debited and credited in one entry", () => {
    type Hit = {
      legal_entity_id: string;
      idempotency_key: string;
      account_id: string;
      debit_idr: string;
      credit_idr: string;
    };

    async function hitsOf(id: string) {
      const rows = await entityRows<Hit>(SELF_CASH);
      return rows.filter((row) => row.idempotency_key.endsWith(id));
    }

    it("[1118-gate-self-cash] returns a row for Dr 1102 / Cr 1102 without a snapshot (today's mapping), whatever the rule key", async () => {
      const id = randomUUID();
      await H.seedLoanJournal(id, AMOUNT); // Dr 1102 / Cr 1102, no snapshot
      const rows = await hitsOf(id);
      expect(rows, "the gate must block").toHaveLength(1);
      expect(rows[0]!.account_id).toBe(await H.accountId("1102"));
      expect(Number(rows[0]!.debit_idr)).toBe(AMOUNT);
      expect(Number(rows[0]!.credit_idr)).toBe(AMOUNT);
    }, 120_000);

    it("[1118-gate-self-cash-snapshot] returns a row when the snapshot names petty_cash, and none when the snapshot points petty_cash at another account", async () => {
      const petty = await H.accountId("1102");
      const blocked = randomUUID();
      await H.seedLoanJournal(blocked, AMOUNT, 0, {
        snapshot: { petty_cash: petty },
      });
      expect(await hitsOf(blocked), "snapshot says 1102 is cash").toHaveLength(
        1,
      );

      const elsewhere = randomUUID();
      await H.seedLoanJournal(elsewhere, AMOUNT, 0, {
        snapshot: { petty_cash: await H.accountId("1204") },
      });
      expect(
        await hitsOf(elsewhere),
        "the snapshot wins over today's mapping: 1102 was not cash then",
      ).toHaveLength(0);
    }, 120_000);

    it("[1118-gate-self-cash-clean] returns no row for Dr 1204 / Cr 1102 (a real cash credit)", async () => {
      const id = randomUUID();
      await H.seedLoanJournal(id, AMOUNT, AMOUNT);
      expect(await hitsOf(id)).toHaveLength(0);
    }, 120_000);

    it("[1118-gate-self-cash-reversal] skips a reversal entry", async () => {
      const id = randomUUID();
      await H.seedLoanJournal(id, AMOUNT);
      expect(await hitsOf(id), "premise: the original is listed").toHaveLength(
        1,
      );
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        // Append-only triggers off for this setup edit only; the check
        // constraint (source_type 'reversal' iff reversal_of) still holds.
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          `UPDATE journal_entries SET source_type = 'reversal', reversal_of = id
            WHERE idempotency_key = $1`,
          [`payroll-gl:loan:${id}`],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      expect(await hitsOf(id)).toHaveLength(0);
    }, 120_000);
  });
});

describe("1118 release gate SQL: fails closed on schema drift", () => {
  // A missing column or table makes Postgres raise an error. With
  // `psql -v ON_ERROR_STOP=1` that is a non-zero exit, which blocks the
  // release. It must never come back as an empty result.
  const drift: {
    name: string;
    statement: string;
    from: string;
    to: string;
    code: string;
  }[] = [
    {
      name: "statement 1, missing column",
      statement: SHARED_ACCOUNTS,
      from: "m.role",
      to: "m.role_gone",
      code: "42703",
    },
    {
      name: "statement 1, missing table",
      statement: SHARED_ACCOUNTS,
      from: "FROM account_mappings m",
      to: "FROM account_mappings_gone m",
      code: "42P01",
    },
    {
      name: "statement 2, missing column",
      statement: NEW_HOLDS,
      from: "posting_account_snapshot",
      to: "posting_account_snapshot_gone",
      code: "42703",
    },
    {
      name: "statement 3, missing column",
      statement: SELF_CASH,
      from: "je.reversal_of",
      to: "je.reversal_of_gone",
      code: "42703",
    },
    {
      name: "statement 3, missing table",
      statement: SELF_CASH,
      from: "JOIN journal_lines l",
      to: "JOIN journal_lines_gone l",
      code: "42P01",
    },
    {
      name: "statement 2, missing table",
      statement: NEW_HOLDS,
      from: "FROM domain_event_outbox o",
      to: "FROM domain_event_outbox_gone o",
      code: "42P01",
    },
  ];

  it.each(drift)("[1118-gate-drift] $name raises an error", async (item) => {
    expect(item.statement.includes(item.from), "premise").toBe(true);
    const broken = item.statement.replaceAll(item.from, item.to);
    await expect(owner.query(broken)).rejects.toMatchObject({
      code: item.code,
    });
  });
});
