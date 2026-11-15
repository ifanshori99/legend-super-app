// Brief payout GL 881, P2 (legend-63qhw): migration 0384 tightens the guard
// trigger of `payroll_payout_gl_postings` for the application role.
//
// - The kind flip `settle_pending|settle_skipped -> settle` is only allowed when
//   the settle journal of that posting exists (same tenant, idempotency key =
//   the posting's journal_key). A flip without a journal, with a journal under
//   another key, or with a journal of another tenant is refused (PAYOUT-30,
//   23514), and so is a flip that also changes any other column.
// - `source_gl_account_id` may be recorded once (NULL -> account) on an
//   unresolved settle (pending/skipped) and on no other kind; it can never be
//   replaced or cleared, and it cannot ride along with another column change.
//
// - Migration 0385 (legend-5vb7y) also checks the lines of that journal: debits
//   equal credits and are above zero, every debit is on the salaries payable
//   account (2103) of the entity, every credit is on the source account of the
//   money (the GL account of the bank account frozen on the batch). A journal
//   with the right header but the wrong accounts, or reversed, is refused.
//   Not verifiable in SQL: the principal amount (sealed in the posting), and
//   the `payroll.paid` rule origin (no column marks it). Not covered here: the
//   cash source branch (posting.source_gl_account_id) and an unbalanced
//   journal or one with no lines (the ledger refuses to commit them).
//
// Everything runs as `legend_app` with the tenant context (the role the API
// uses). Postings are seeded by the migration owner (no service involved) on a
// real approved batch of the payout fixtures.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAppRole } from "./accounting-ledger-guard-test-helpers.ts";
import { bank, BUDI, installPayoutWorld } from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("881guard");
const tenantId = () => W.tenantId;

const GUARD_CODE = "23514";
type Kind = "settle" | "settle_pending" | "settle_skipped" | "return";

let batchId = "";
let runId = "";
let periodId = "";
let accountA = "";
let accountB = "";
let salariesPayableId = "";
let sourceGlId = "";
const foreignTenantIds: string[] = [];
const bentJournalKeys: string[] = [];

beforeAll(async () => {
  const slips = [bank(BUDI, 1_000_000)];
  runId = await W.seedRun(slips);
  batchId = await W.approvedBatch(runId);
  const accounts = await W.rowsOf(
    `SELECT id, code FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code IN ('1102', '1103')`,
    [tenantId(), W.entityId()],
  );
  accountA = accounts.find((a) => a.code === "1102")!.id as string;
  accountB = accounts.find((a) => a.code === "1103")!.id as string;
  salariesPayableId = (
    await W.rowsOf(
      `SELECT account_id FROM account_mappings
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = 'salaries_payable'`,
      [tenantId(), W.entityId()],
    )
  )[0]!.account_id as string;
  sourceGlId = (
    await W.rowsOf(
      `SELECT ba.gl_account_id FROM payroll_disbursement_batches b
         JOIN bank_accounts ba ON ba.tenant_id = b.tenant_id AND ba.id = b.source_bank_account_id
        WHERE b.tenant_id = $1 AND b.id = $2`,
      [tenantId(), batchId],
    )
  )[0]!.gl_account_id as string;
  periodId = (
    await W.rowsOf(
      `SELECT id FROM fiscal_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId(), W.entityId()],
    )
  )[0]!.id as string;
});

afterAll(async () => {
  if (foreignTenantIds.length === 0 && bentJournalKeys.length === 0) return;
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM journal_entries WHERE tenant_id = ANY($1::uuid[])",
      [foreignTenantIds],
    );
    await client.query(
      "DELETE FROM journal_entries WHERE tenant_id = $1 AND idempotency_key = ANY($2::text[])",
      [tenantId(), bentJournalKeys],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

type Seeded = { id: string; journalKey: string };

/** One posting row of the fixture batch, inserted as the migration owner. */
async function seedPosting(
  kind: Kind,
  sourceGlAccountId: string | null = null,
): Promise<Seeded> {
  const id = randomUUID();
  const hash = randomBytes(32).toString("hex");
  const journalKey = `payroll-payout:${hash}`;
  await W.asTenant(async (c) => {
    await c.query(
      `INSERT INTO payroll_payout_gl_postings
         (id, tenant_id, batch_id, kind, item_set_hash, journal_key,
          total_encrypted, pii_key_version, fee_posted, source_gl_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, '\\x00', 1, true, $7)`,
      [id, tenantId(), batchId, kind, hash, journalKey, sourceGlAccountId],
    );
  });
  return { id, journalKey };
}

/** Journal fields a test may bend away from the posting's own batch. */
type JournalOverride = {
  legalEntityId?: string;
  sourceType?: string;
  sourceId?: string | null;
};

/**
 * A journal of this tenant whose entity, source type or source id differs
 * from the posting's batch. Inserted by the owner with triggers off (the
 * journal rules would refuse some of these combinations), under the right key.
 */
async function insertBentJournal(
  key: string,
  override: JournalOverride,
): Promise<void> {
  bentJournalKeys.push(key);
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          source_id, description, reversal_of, idempotency_key, request_fingerprint)
       VALUES ($1, $2, '2026-10-15', $3, $4, $5, 'Payout 881 bent journal',
               NULL, $6, $7)`,
      [
        tenantId(),
        override.legalEntityId ?? W.entityId(),
        periodId,
        override.sourceType ?? "payroll",
        override.sourceId === undefined ? runId : override.sourceId,
        key,
        randomBytes(32).toString("hex"),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type Line = { accountId: string; debit: number; credit: number };

/** The journal the payout service posts: Dr salaries payable, Cr source. */
const rightLines = (): Line[] => [
  { accountId: salariesPayableId, debit: 1000, credit: 0 },
  { accountId: sourceGlId, debit: 0, credit: 1000 },
];

/**
 * A balanced settle-like journal as the app role. By default it is a journal
 * the guard accepts: entity and payroll run of the fixture batch, Dr salaries
 * payable (2103) and Cr the frozen source account of the batch.
 */
async function insertJournal(
  client: PoolClient,
  key: string,
  lines: Line[] = rightLines(),
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, '2026-10-15', $3, $4, $5, 'Payout 881 guard test',
             NULL, $6, $7)
     RETURNING id`,
    [
      tenantId(),
      W.entityId(),
      periodId,
      "payroll",
      runId,
      key,
      randomBytes(32).toString("hex"),
    ],
  );
  const entryId = rows[0]!.id;
  for (const [index, line] of lines.entries())
    await client.query(
      `INSERT INTO journal_lines
         (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
      [tenantId(), entryId, line.accountId, index + 1, line.debit, line.credit],
    );
}

/** A journal of ANOTHER tenant under `key` (owner, row security bypassed). */
async function insertForeignJournal(key: string): Promise<void> {
  const foreignTenant = randomUUID();
  foreignTenantIds.push(foreignTenant);
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO journal_entries
         (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
          source_id, description, reversal_of, idempotency_key, request_fingerprint)
       VALUES ($1, $2, '2026-10-15', $3, 'payroll', NULL, 'Foreign tenant journal',
               NULL, $4, $5)`,
      [
        foreignTenant,
        randomUUID(),
        randomUUID(),
        key,
        randomBytes(32).toString("hex"),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

type Attempt = {
  /** Database error code of the UPDATE, undefined when it was accepted. */
  code: string | undefined;
  row: { kind: string; source_gl_account_id: string | null };
};

/**
 * Runs `UPDATE ... SET <set> WHERE id = $1` as the app role, after inserting a
 * journal under each of `journalKeys` in the same transaction. The UPDATE sits
 * behind a savepoint so a refusal can still be read back.
 */
async function tryUpdate(
  id: string,
  set: string,
  params: unknown[] = [],
  journalKeys: string[] = [],
  lines?: Line[],
): Promise<Attempt> {
  return withAppRole(async (client) => {
    for (const key of journalKeys) await insertJournal(client, key, lines);
    await client.query("SAVEPOINT guard_try");
    let code: string | undefined;
    try {
      await client.query(
        `UPDATE payroll_payout_gl_postings SET ${set} WHERE id = $1`,
        [id, ...params],
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? "unknown";
      await client.query("ROLLBACK TO SAVEPOINT guard_try");
    }
    const { rows } = await client.query(
      `SELECT kind, source_gl_account_id FROM payroll_payout_gl_postings WHERE id = $1`,
      [id],
    );
    return { code, row: rows[0] as Attempt["row"] };
  });
}

/** What the row looks like for everyone else, once the attempt is over. */
async function committedRow(id: string) {
  return (
    await W.rowsOf(
      `SELECT kind, source_gl_account_id, total_encrypted
         FROM payroll_payout_gl_postings WHERE id = $1`,
      [id],
    )
  )[0]!;
}

describe("legend-63qhw: kind flip to settle needs the settle journal", () => {
  it.each(["settle_skipped", "settle_pending"] as const)(
    "refuses %s -> settle when no journal exists",
    async (kind) => {
      const posting = await seedPosting(kind);
      const result = await tryUpdate(posting.id, "kind = 'settle'");
      expect(result.code).toBe(GUARD_CODE);
      expect(result.row.kind).toBe(kind);
      expect((await committedRow(posting.id)).kind).toBe(kind);
    },
  );

  it.each(["settle_skipped", "settle_pending"] as const)(
    "accepts %s -> settle when the journal of the same tenant and key is created in the same transaction",
    async (kind) => {
      const posting = await seedPosting(kind);
      const result = await tryUpdate(
        posting.id,
        "kind = 'settle'",
        [],
        [posting.journalKey],
      );
      expect(result.code).toBeUndefined();
      expect(result.row.kind).toBe("settle");
      expect((await committedRow(posting.id)).kind).toBe("settle");
    },
  );

  it("refuses the flip when the only journal has another idempotency key", async () => {
    const posting = await seedPosting("settle_skipped");
    const result = await tryUpdate(
      posting.id,
      "kind = 'settle'",
      [],
      [`payroll-payout:${randomBytes(32).toString("hex")}`],
    );
    expect(result.code).toBe(GUARD_CODE);
    expect(result.row.kind).toBe("settle_skipped");
  });

  it("refuses the flip when the journal under that key belongs to another tenant", async () => {
    const posting = await seedPosting("settle_pending");
    await insertForeignJournal(posting.journalKey);
    const result = await tryUpdate(posting.id, "kind = 'settle'");
    expect(result.code).toBe(GUARD_CODE);
    expect(result.row.kind).toBe("settle_pending");
  });

  it.each([
    ["another legal entity", { legalEntityId: randomUUID() }],
    ["another source type", { sourceType: "depreciation" }],
    ["another source id", { sourceId: randomUUID() }],
    ["no source id", { sourceId: null }],
  ] as [string, JournalOverride][])(
    "refuses the flip when the journal under the right key has %s",
    async (_label, override) => {
      const posting = await seedPosting("settle_skipped");
      await insertBentJournal(posting.journalKey, override);
      const result = await tryUpdate(posting.id, "kind = 'settle'");
      expect(result.code).toBe(GUARD_CODE);
      expect(result.row.kind).toBe("settle_skipped");
      expect((await committedRow(posting.id)).kind).toBe("settle_skipped");
    },
  );

  it("refuses the flip when it also changes another column, even with the journal", async () => {
    const posting = await seedPosting("settle_skipped");
    const before = await committedRow(posting.id);
    const result = await tryUpdate(
      posting.id,
      "kind = 'settle', total_encrypted = '\\x0102'",
      [],
      [posting.journalKey],
    );
    expect(result.code).toBe(GUARD_CODE);
    expect(result.row.kind).toBe("settle_skipped");
    expect((await committedRow(posting.id)).total_encrypted).toEqual(
      before.total_encrypted,
    );
  });

  it("refuses the flip that also records a source account in the same statement", async () => {
    const posting = await seedPosting("settle_pending");
    const result = await tryUpdate(
      posting.id,
      "kind = 'settle', source_gl_account_id = $2",
      [accountA],
      [posting.journalKey],
    );
    expect(result.code).toBe(GUARD_CODE);
    expect(result.row.kind).toBe("settle_pending");
    expect(result.row.source_gl_account_id).toBeNull();
  });

  it.each([
    ["settle_skipped", "return"],
    ["settle_pending", "return"],
    ["settle_skipped", "settle_pending"],
    ["settle_pending", "settle_skipped"],
    ["settle", "settle_skipped"],
    ["settle", "return"],
    ["return", "settle"],
  ] as const)("refuses %s -> %s even with a journal", async (from, to) => {
    const posting = await seedPosting(from);
    const result = await tryUpdate(
      posting.id,
      "kind = $2",
      [to],
      [posting.journalKey],
    );
    expect(result.code).toBe(GUARD_CODE);
    expect(result.row.kind).toBe(from);
  });
});

describe("legend-5vb7y: the lines of the settle journal", () => {
  // Any account of the entity that is neither 2103 nor the frozen source.
  const otherAccountId = () =>
    [accountA, accountB].find((id) => id !== sourceGlId)!;
  const wrongShapes: [string, () => Line[]][] = [
    [
      "debits an account other than salaries payable",
      () => [
        { accountId: otherAccountId(), debit: 1000, credit: 0 },
        { accountId: sourceGlId, debit: 0, credit: 1000 },
      ],
    ],
    [
      "credits an account other than the frozen source",
      () => [
        { accountId: salariesPayableId, debit: 1000, credit: 0 },
        { accountId: otherAccountId(), debit: 0, credit: 1000 },
      ],
    ],
    [
      "is reversed (debit on the source, credit on salaries payable)",
      () => [
        { accountId: sourceGlId, debit: 1000, credit: 0 },
        { accountId: salariesPayableId, debit: 0, credit: 1000 },
      ],
    ],
    [
      "has an extra debit line on another account",
      () => [
        { accountId: salariesPayableId, debit: 600, credit: 0 },
        { accountId: otherAccountId(), debit: 400, credit: 0 },
        { accountId: sourceGlId, debit: 0, credit: 1000 },
      ],
    ],
    [
      "splits the credit over the source and another account",
      () => [
        { accountId: salariesPayableId, debit: 1000, credit: 0 },
        { accountId: sourceGlId, debit: 0, credit: 600 },
        { accountId: otherAccountId(), debit: 0, credit: 400 },
      ],
    ],
  ];

  it.each(["settle_skipped", "settle_pending"] as const)(
    "accepts %s -> settle with Dr salaries payable / Cr frozen source",
    async (kind) => {
      const posting = await seedPosting(kind);
      const result = await tryUpdate(
        posting.id,
        "kind = 'settle'",
        [],
        [posting.journalKey],
        rightLines(),
      );
      expect(result.code).toBeUndefined();
      expect(result.row.kind).toBe("settle");
    },
  );

  it.each(wrongShapes)(
    "refuses the flip when the journal under the right header %s",
    async (_label, shape) => {
      const posting = await seedPosting("settle_skipped");
      const result = await tryUpdate(
        posting.id,
        "kind = 'settle'",
        [],
        [posting.journalKey],
        shape(),
      );
      expect(result.code).toBe(GUARD_CODE);
      expect(result.row.kind).toBe("settle_skipped");
      expect((await committedRow(posting.id)).kind).toBe("settle_skipped");
    },
  );
});

describe("legend-63qhw: source account of an unresolved settle", () => {
  it.each(["settle_skipped", "settle_pending"] as const)(
    "accepts NULL -> account on %s",
    async (kind) => {
      const posting = await seedPosting(kind);
      const result = await tryUpdate(posting.id, "source_gl_account_id = $2", [
        accountA,
      ]);
      expect(result.code).toBeUndefined();
      expect(result.row.source_gl_account_id).toBe(accountA);
      expect(result.row.kind).toBe(kind);
      expect((await committedRow(posting.id)).source_gl_account_id).toBe(
        accountA,
      );
    },
  );

  it.each(["settle_skipped", "settle_pending"] as const)(
    "refuses replacing a recorded source account on %s",
    async (kind) => {
      const posting = await seedPosting(kind, accountA);
      const result = await tryUpdate(posting.id, "source_gl_account_id = $2", [
        accountB,
      ]);
      expect(result.code).toBe(GUARD_CODE);
      expect(result.row.source_gl_account_id).toBe(accountA);
    },
  );

  it.each(["settle_skipped", "settle_pending"] as const)(
    "refuses clearing a recorded source account on %s",
    async (kind) => {
      const posting = await seedPosting(kind, accountA);
      const result = await tryUpdate(posting.id, "source_gl_account_id = NULL");
      expect(result.code).toBe(GUARD_CODE);
      expect(result.row.source_gl_account_id).toBe(accountA);
    },
  );

  it.each(["settle", "return"] as const)(
    "refuses recording a source account on a %s posting",
    async (kind) => {
      const posting = await seedPosting(kind);
      const result = await tryUpdate(posting.id, "source_gl_account_id = $2", [
        accountA,
      ]);
      expect(result.code).toBe(GUARD_CODE);
      expect(result.row.source_gl_account_id).toBeNull();
    },
  );

  it("refuses recording a source account together with another column change", async () => {
    const posting = await seedPosting("settle_skipped");
    const result = await tryUpdate(
      posting.id,
      "source_gl_account_id = $2, total_encrypted = '\\x0102'",
      [accountA],
    );
    expect(result.code).toBe(GUARD_CODE);
    expect(result.row.source_gl_account_id).toBeNull();
  });

  it("refuses recording a source account on a row whose fee flag also changes", async () => {
    const posting = await seedPosting("settle_skipped");
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET fee_posted = false WHERE id = $1`,
          [posting.id],
        ),
      true,
    );
    const result = await tryUpdate(
      posting.id,
      "source_gl_account_id = $2, fee_posted = true",
      [accountA],
    );
    expect(result.code).toBe(GUARD_CODE);
    expect(result.row.source_gl_account_id).toBeNull();
  });

  it("keeps the earlier fee-posted move (false -> true) allowed on its own", async () => {
    const posting = await seedPosting("settle_skipped");
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET fee_posted = false WHERE id = $1`,
          [posting.id],
        ),
      true,
    );
    const result = await tryUpdate(posting.id, "fee_posted = true");
    expect(result.code).toBeUndefined();
  });
});
