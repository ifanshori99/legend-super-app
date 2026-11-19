// legend 1140 (second opinion kas ronde 8, P2-2): a delivered cash kasbon or
// reimbursement event whose amount cannot be trusted (NULL, key missing, zero
// or negative) must never slip through quietly.
//
// Written from the brief (docs/briefs/1140-fix-so-kas-ronde8.md, decision 3)
// and the second opinion report, not from the service code:
// - the release gate (scripts/preflight/1118-shared-cash-mapping.sql) must
//   return a blocking row, decided BEFORE the net filter, because `0 < NULL`
//   is UNKNOWN and used to drop the row;
// - the petty cash reserve must stay held (observed only through the real cash
//   guard over HTTP: a second kasbon / claim above the free cash is refused
//   422 PETTY_CASH_GL_INSUFFICIENT).
//
// Assumptions (the brief leaves them open):
// - "A blocking row" for the gate = any row, from any statement of the script,
//   that mentions the kasbon / claim id (statement 2 shows source_id, statement
//   3 the idempotency key). An error or extra statement is not required here.
// - Fixture of the report: current mapping clean; event delivered with the
//   right source and entity; journal Dr 1101 / Cr 1102 of Rp100.000 whose
//   snapshot names both cash accounts, so the combined cash net is Rp0 and
//   statements 1 and 3 are empty.
// - Helper: the journal is net zero (Dr 1102 / Cr 1102), the amount of the
//   event is unreadable; the reserve must stay, so a second Rp100.000 payment
//   is refused. How much is held is not asserted beyond "enough to refuse".
// - Reversal (architect finding): a reversal journal (source_type 'reversal',
//   reversal_of = the original) that debits the cash back means the money never
//   left the till; the net credit then counts it, so the gate lists the event
//   and the reserve stays held.
// - A JSON string amount ("100000") is unreadable: only a JSON number counts.
//   Its fixtures use a healthy journal, because on the pre-fix script a string
//   is cast to numeric and a net-zero journal would be caught anyway.
// - LEGEND_GATE_SQL (optional) points at another copy of the gate script, used
//   only to prove the tests fail against the pre-fix script.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { tenantId } from "./helpers/cash-bank-world.ts";
import {
  expectGlRefusal,
  installLoanCashWorld,
} from "./helpers/cash-1118-world.ts";

const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 1,
});
afterAll(async () => {
  await owner.end();
});

const script = readFileSync(
  process.env.LEGEND_GATE_SQL ??
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
const NEW_HOLDS = statements[1] as string;

const AMOUNT = 100_000;
const H = installLoanCashWorld("1140amt");

type Mode = "null" | "missing" | "zero" | "negative";
const MODES: Mode[] = ["null", "missing", "zero", "negative"];
const REWRITE: Record<Mode, string> = {
  null: "jsonb_set(event, $3::text[], 'null'::jsonb)",
  missing: "event #- $3::text[]",
  zero: "jsonb_set(event, $3::text[], '0'::jsonb)",
  negative: "jsonb_set(event, $3::text[], '-100000'::jsonb)",
};

const STRING_AMOUNT = "jsonb_set(event, $3::text[], '\"100000\"'::jsonb)";

const KASBON = {
  event: "employee_loan.disbursed",
  key: "principalIdr",
} as const;
const CLAIM = { event: "reimbursement.paid", key: "amountIdr" } as const;

/** Setup only: rewrites the amount inside the outbox payload of one kasbon / claim. */
async function rewriteAmount(
  id: string,
  kind: typeof KASBON | typeof CLAIM,
  mode: Mode | "string",
) {
  const path = `{payload,${kind.key}}`;
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const before = await client.query<{ amount: unknown }>(
      `SELECT event #> $3::text[] AS amount FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = $2
          AND event::text LIKE '%' || $4 || '%'`,
      [tenantId, kind.event, path, id],
    );
    expect(before.rows, "premise: exactly one event").toHaveLength(1);
    expect(
      Number(before.rows[0]!.amount),
      `premise: the event carries a positive ${kind.key}`,
    ).toBeGreaterThan(0);
    const updated = await client.query(
      `UPDATE domain_event_outbox SET event = ${mode === "string" ? STRING_AMOUNT : REWRITE[mode]}
        WHERE tenant_id = $1 AND event->>'name' = $2
          AND event::text LIKE '%' || $4 || '%'`,
      [tenantId, kind.event, path, id],
    );
    expect(updated.rowCount).toBe(1);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Every row, from every statement of the gate, that mentions the id. */
async function blockingRows(id: string) {
  const found: { statement: number; row: Record<string, unknown> }[] = [];
  for (const [statement, sql] of statements.entries()) {
    const result = await owner.query<Record<string, unknown>>(sql);
    for (const row of result.rows) {
      if (JSON.stringify(row).includes(id)) found.push({ statement, row });
    }
  }
  return found;
}

async function cashSnapshot() {
  return {
    petty_cash: await H.accountId("1102"),
    cash_on_hand: await H.accountId("1101"),
  };
}

/** Kasbon of Rp100.000 paid over HTTP, journal Dr 1101 / Cr 1102 (both cash in the snapshot), event delivered. */
async function deliveredKasbonOnTwoCashAccounts() {
  await H.drain();
  await H.W.fundPettyCash(AMOUNT);
  const loan = await H.seedLoan(AMOUNT);
  const paid = await H.disburse(loan, AMOUNT);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  await H.seedLoanJournal(loan, AMOUNT, 0, {
    debitAccountId: await H.accountId("1101"),
    snapshot: await cashSnapshot(),
  });
  await H.markDelivered(loan);
  return loan;
}

async function deliveredClaimOnTwoCashAccounts() {
  await H.drain();
  await H.W.fundPettyCash(AMOUNT);
  const claim = await H.seedClaim(AMOUNT);
  const paid = await H.payClaim(claim, AMOUNT);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  await H.seedReimbursementJournal(claim, AMOUNT, 0, {
    debitAccountId: await H.accountId("1101"),
    snapshot: await cashSnapshot(),
  });
  await H.markDelivered(claim);
  return claim;
}

describe("1140 release gate: an unreadable amount blocks", () => {
  for (const mode of MODES) {
    it(`[1140-gate-kasbon-amount-${mode}] a delivered kasbon event with principalIdr ${mode} and a Dr 1101 / Cr 1102 journal of Rp100.000 returns a blocking row`, async () => {
      let loan: string | null = null;
      try {
        loan = await deliveredKasbonOnTwoCashAccounts();
        await rewriteAmount(loan, KASBON, mode);
        const rows = await blockingRows(loan);
        expect(
          rows,
          "the gate must block: an amount that cannot be read is not a pass",
        ).not.toHaveLength(0);
      } finally {
        if (loan) await H.forget(loan);
        await H.restoreBaseline();
      }
    }, 180_000);

    it(`[1140-gate-reimbursement-amount-${mode}] a delivered reimbursement event with amountIdr ${mode} and a Dr 1101 / Cr 1102 journal of Rp100.000 returns a blocking row`, async () => {
      let claim: string | null = null;
      try {
        claim = await deliveredClaimOnTwoCashAccounts();
        await rewriteAmount(claim, CLAIM, mode);
        const rows = await blockingRows(claim);
        expect(
          rows,
          "the gate must block: an amount that cannot be read is not a pass",
        ).not.toHaveLength(0);
      } finally {
        if (claim) await H.forget(claim);
        await H.restoreBaseline();
      }
    }, 180_000);
  }

  it("[1140-gate-control-readable-amount] control: the same journal with a readable principalIdr of Rp100.000 is caught by statement 2 (net credit 0 < 100.000)", async () => {
    let loan: string | null = null;
    try {
      loan = await deliveredKasbonOnTwoCashAccounts();
      const result = await owner.query<{
        source_id: string;
        principal_idr: string;
        net_credit_idr: string;
      }>(NEW_HOLDS);
      const hit = result.rows.find((row) => row.source_id === loan);
      expect(hit, "statement 2 must list the kasbon").toBeDefined();
      expect(Number(hit!.principal_idr)).toBe(AMOUNT);
      expect(Number(hit!.net_credit_idr)).toBe(0);
    } finally {
      if (loan) await H.forget(loan);
      await H.restoreBaseline();
    }
  }, 180_000);

  it("[1140-gate-healthy-journal-passes] a healthy journal (Dr 1204 / Cr 1102 of the full Rp100.000) with a readable amount returns no row", async () => {
    let loan: string | null = null;
    try {
      await H.drain();
      await H.W.fundPettyCash(AMOUNT);
      loan = await H.seedLoan(AMOUNT);
      const paid = await H.disburse(loan, AMOUNT);
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      await H.seedLoanJournal(loan, AMOUNT, AMOUNT, {
        snapshot: await cashSnapshot(),
      });
      await H.markDelivered(loan);
      expect(await blockingRows(loan)).toHaveLength(0);
    } finally {
      if (loan) await H.forget(loan);
      await H.restoreBaseline();
    }
  }, 180_000);
});

describe("1140 petty cash reserve: an unreadable amount keeps the reserve held", () => {
  for (const mode of MODES) {
    it(`[1140-reserve-kasbon-amount-${mode}] delivered kasbon event with principalIdr ${mode} on a net-zero Dr 1102 / Cr 1102 journal: a second Rp100.000 kasbon is refused 422 PETTY_CASH_GL_INSUFFICIENT`, async () => {
      try {
        await H.drain();
        await H.W.fundPettyCash(AMOUNT);
        const loan = await H.seedLoan(AMOUNT);
        const paid = await H.disburse(loan, AMOUNT);
        expect(paid.status, JSON.stringify(paid.body)).toBe(200);
        await H.seedLoanJournal(loan, AMOUNT); // net zero on 1102
        await H.markDelivered(loan);
        H.markStuck(loan);
        await rewriteAmount(loan, KASBON, mode);

        const second = await H.seedLoan(AMOUNT);
        expectGlRefusal(await H.disburse(second, AMOUNT));
        expect((await H.loanState(second)).events).toBe(0);
      } finally {
        await H.restoreBaseline();
      }
    }, 180_000);

    it(`[1140-reserve-reimbursement-amount-${mode}] delivered reimbursement event with amountIdr ${mode} on a net-zero Dr 1102 / Cr 1102 journal: a second Rp100.000 claim is refused 422 PETTY_CASH_GL_INSUFFICIENT`, async () => {
      try {
        await H.drain();
        await H.W.fundPettyCash(AMOUNT);
        const claim = await H.seedClaim(AMOUNT);
        const paid = await H.payClaim(claim, AMOUNT);
        expect(paid.status, JSON.stringify(paid.body)).toBe(200);
        await H.seedReimbursementJournal(claim, AMOUNT); // net zero on 1102
        await H.markDelivered(claim);
        H.markStuck(claim);
        await rewriteAmount(claim, CLAIM, mode);

        const second = await H.seedClaim(AMOUNT);
        expectGlRefusal(await H.payClaim(second, AMOUNT));
        expect(await H.claimEvents(second)).toBe(0);
      } finally {
        await H.restoreBaseline();
      }
    }, 180_000);
  }
});

/**
 * Setup only: a reversal journal of the journal found under `originalKey`,
 * with the lines swapped (Dr 1102 / Cr <other>), so the cash comes back.
 */
async function insertReversal(
  originalKey: string,
  cashAccountId: string,
  otherAccountId: string,
  amount: number,
) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const original = (
      await client.query<{
        id: string;
        entry_date: string;
        fiscal_period_id: string;
        posting_account_snapshot: unknown;
      }>(
        `SELECT id, entry_date::text, fiscal_period_id, posting_account_snapshot
           FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, originalKey],
      )
    ).rows[0];
    expect(original, "premise: the original journal exists").toBeDefined();
    const entry = (
      await client.query<{ id: string }>(
        `INSERT INTO journal_entries
           (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
            reversal_of, description, idempotency_key, request_fingerprint,
            posting_account_snapshot)
         VALUES ($1, $2, $3, $4, 'reversal', $5, 'Pembalikan (uji 1140)', $6, $7, $8)
         RETURNING id`,
        [
          tenantId,
          H.W.entityId(),
          original!.entry_date,
          original!.fiscal_period_id,
          original!.id,
          `reversal-1140:${randomUUID()}`,
          randomBytes(32).toString("hex"),
          original!.posting_account_snapshot === null
            ? null
            : JSON.stringify(original!.posting_account_snapshot),
        ],
      )
    ).rows[0]!.id;
    await client.query(
      `INSERT INTO journal_lines (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr)
       VALUES ($1, $2, $3, 1, $5, 0), ($1, $2, $4, 2, 0, $5)`,
      [tenantId, entry, cashAccountId, otherAccountId, amount],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function healthyKasbon() {
  await H.drain();
  await H.W.fundPettyCash(AMOUNT);
  const loan = await H.seedLoan(AMOUNT);
  const paid = await H.disburse(loan, AMOUNT);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  await H.seedLoanJournal(loan, AMOUNT, AMOUNT, {
    snapshot: await cashSnapshot(),
  }); // Dr 1204 / Cr 1102
  await H.markDelivered(loan);
  return loan;
}

async function healthyClaim() {
  await H.drain();
  await H.W.fundPettyCash(AMOUNT);
  const claim = await H.seedClaim(AMOUNT);
  const paid = await H.payClaim(claim, AMOUNT);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  await H.seedReimbursementJournal(claim, AMOUNT, AMOUNT, {
    snapshot: await cashSnapshot(),
  }); // Dr 6110 / Cr 1102
  await H.markDelivered(claim);
  return claim;
}

describe("1140 release gate: a reversed cash credit blocks", () => {
  it("[1140-gate-reversed-kasbon] kasbon journal Dr 1204 / Cr 1102 of Rp100.000 whose reversal puts the cash back: statement 2 lists the kasbon (net credit 0 < 100.000)", async () => {
    let loan: string | null = null;
    try {
      loan = await healthyKasbon();
      expect(await blockingRows(loan), "premise: healthy before").toHaveLength(
        0,
      );
      await insertReversal(
        `payroll-gl:loan:${loan}`,
        await H.accountId("1102"),
        await H.accountId("1204"),
        AMOUNT,
      );
      const result = await owner.query<{
        source_id: string;
        net_credit_idr: string;
      }>(NEW_HOLDS);
      const hit = result.rows.find((row) => row.source_id === loan);
      expect(hit, "the gate must block: the cash came back").toBeDefined();
      expect(Number(hit!.net_credit_idr)).toBe(0);
    } finally {
      if (loan) await H.forget(loan);
      await H.restoreBaseline();
    }
  }, 180_000);

  it("[1140-gate-reversed-reimbursement] reimbursement journal Dr 6110 / Cr 1102 of Rp100.000 whose reversal puts the cash back: statement 2 lists the claim", async () => {
    let claim: string | null = null;
    try {
      claim = await healthyClaim();
      expect(await blockingRows(claim), "premise: healthy before").toHaveLength(
        0,
      );
      await insertReversal(
        `payroll-gl:reimbursement:${claim}`,
        await H.accountId("1102"),
        await H.accountId("6110"),
        AMOUNT,
      );
      const result = await owner.query<{
        source_id: string;
        net_credit_idr: string;
      }>(NEW_HOLDS);
      const hit = result.rows.find((row) => row.source_id === claim);
      expect(hit, "the gate must block: the cash came back").toBeDefined();
      expect(Number(hit!.net_credit_idr)).toBe(0);
    } finally {
      if (claim) await H.forget(claim);
      await H.restoreBaseline();
    }
  }, 180_000);
});

describe("1140 release gate: a JSON string amount blocks", () => {
  it('[1140-gate-kasbon-amount-string] healthy journal, principalIdr is the JSON string "100000": blocking row', async () => {
    let loan: string | null = null;
    try {
      loan = await healthyKasbon();
      await rewriteAmount(loan, KASBON, "string");
      expect(
        await blockingRows(loan),
        "only a JSON number is a readable amount",
      ).not.toHaveLength(0);
    } finally {
      if (loan) await H.forget(loan);
      await H.restoreBaseline();
    }
  }, 180_000);

  it('[1140-gate-reimbursement-amount-string] healthy journal, amountIdr is the JSON string "100000": blocking row', async () => {
    let claim: string | null = null;
    try {
      claim = await healthyClaim();
      await rewriteAmount(claim, CLAIM, "string");
      expect(
        await blockingRows(claim),
        "only a JSON number is a readable amount",
      ).not.toHaveLength(0);
    } finally {
      if (claim) await H.forget(claim);
      await H.restoreBaseline();
    }
  }, 180_000);
});

describe("1140 petty cash reserve: reversed credit and string amount stay held", () => {
  it("[1140-reserve-kasbon-reversed] delivered kasbon whose Dr 1204 / Cr 1102 journal was reversed (cash back on 1102): the reserve stays, a second Rp100.000 kasbon is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    try {
      const loan = await healthyKasbon();
      await insertReversal(
        `payroll-gl:loan:${loan}`,
        await H.accountId("1102"),
        await H.accountId("1204"),
        AMOUNT,
      );
      H.markStuck(loan);

      const second = await H.seedLoan(AMOUNT);
      expectGlRefusal(await H.disburse(second, AMOUNT));
      expect((await H.loanState(second)).events).toBe(0);
    } finally {
      await H.restoreBaseline();
    }
  }, 180_000);

  it("[1140-reserve-reimbursement-reversed] delivered reimbursement whose Dr 6110 / Cr 1102 journal was reversed (cash back on 1102): the reserve stays, a second Rp100.000 claim is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    try {
      const claim = await healthyClaim();
      await insertReversal(
        `payroll-gl:reimbursement:${claim}`,
        await H.accountId("1102"),
        await H.accountId("6110"),
        AMOUNT,
      );
      H.markStuck(claim);

      const second = await H.seedClaim(AMOUNT);
      expectGlRefusal(await H.payClaim(second, AMOUNT));
      expect(await H.claimEvents(second)).toBe(0);
    } finally {
      await H.restoreBaseline();
    }
  }, 180_000);

  it('[1140-reserve-kasbon-amount-string] delivered kasbon with principalIdr the JSON string "100000" on a healthy journal: the reserve stays held, a second Rp100.000 kasbon is refused even with Rp100.000 of new cash', async () => {
    try {
      const loan = await healthyKasbon();
      await rewriteAmount(loan, KASBON, "string");
      H.markStuck(loan);
      await H.W.fundPettyCash(AMOUNT); // new cash; only the held reserve can refuse

      const second = await H.seedLoan(AMOUNT);
      expectGlRefusal(await H.disburse(second, AMOUNT));
      expect((await H.loanState(second)).events).toBe(0);
    } finally {
      await H.restoreBaseline();
    }
  }, 180_000);

  it('[1140-reserve-reimbursement-amount-string] delivered reimbursement with amountIdr the JSON string "100000" on a healthy journal: the reserve stays held, a second Rp100.000 claim is refused even with Rp100.000 of new cash', async () => {
    try {
      const claim = await healthyClaim();
      await rewriteAmount(claim, CLAIM, "string");
      H.markStuck(claim);
      await H.W.fundPettyCash(AMOUNT);

      const second = await H.seedClaim(AMOUNT);
      expectGlRefusal(await H.payClaim(second, AMOUNT));
      expect(await H.claimEvents(second)).toBe(0);
    } finally {
      await H.restoreBaseline();
    }
  }, 180_000);
});
