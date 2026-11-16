// Payout 900 (card legend-p2v4s; design scratchpad b900/design.md F3, F4 and F5;
// findings "fee guard is checked before the journal is complete", "source
// account of a fee is not bound to the frozen bank account" and "a historical
// posting without fee_idr flips on a Rp1 journal" in
// docs/qa/second-opinion-payout-897.md). Written fail-first from the findings
// and the CTO decisions, not from the implementation. Everything runs as the
// app role (`legend_app`) with a REAL commit, or as the table owner, so the
// database guard is what is proven, not the service.
//
// Rules proven here (founder: the GL matches the money that moved):
// - F3 deferred check. Journal lines added to the same entry AFTER the flip
//   (fee_posted false -> true, or settle_pending -> settle) are counted: the
//   COMMIT is refused (23514, PAYOUT-37) and nothing stays. Also when the
//   caller runs `SET CONSTRAINTS ALL IMMEDIATE`: the late line itself is
//   refused. The correct journal plus flip still commits, once.
// - F4 source. The credited account of a fee is the account frozen on the
//   batch; the posting's source account must equal it. NULL or another account
//   is refused for the insert, the fill and the fee flip.
// - F5 historical NULL fee. A posting whose fee_idr is NULL never flips (not
//   on Rp1, not on Rp5.000); it stays on the recovery list with reason
//   `fee_amount_unverified`; repostSkippedFees answers 409 and posts nothing.
//
// Assumptions (the design names them, stated so they can be contested):
// - A refusal is guard code 23514; the commit-time refusal names PAYOUT-37.
// - A settle_pending -> settle transition is built in one app-role transaction
//   as the service would do it: a copy of a settled posting is inserted as
//   `settle_pending`, the settle journal (Dr 2103 / Cr frozen source, the net,
//   header copied from the real settle journal) is created, then the posting
//   flips to `settle`.
// - 897 test `[897-historical-null-still-flips]` is replaced by
//   `[900-historical-null-fee-never-flips]` (CTO: historical NULL fees are
//   listed, never accepted).
// - Recovery list row: `listPayoutRecovery(tx, tenantId)`, found by
//   `postingId`, field `reason`. A skipped repost answers HttpError 409 with
//   code PAYOUT_FEE_AMOUNT_UNVERIFIED.
import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import * as glService from "../services/payroll-payout-gl.service.ts";
import { __resetRecoveryCursorsForTest } from "../worker/payout-gl-recovery.job.ts";
import {
  APP,
  APP2,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("900glc");
const tenantId = () => W.tenantId;
const GUARD_CODE = "23514";
const FEE = 5_000;
const NET = 1_000_000;

let periodId = "";
let bankChargesId = "";
let salariesPayableId = "";
let otherBankId = "";

beforeAll(async () => {
  __resetRecoveryCursorsForTest();
  const idOfCode = async (code: string) =>
    (
      await W.rowsOf(
        `SELECT id FROM chart_of_accounts
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
        [tenantId(), W.entityId(), code],
      )
    )[0]!.id as string;
  bankChargesId = await idOfCode("8101");
  salariesPayableId = await idOfCode("2103");
  otherBankId = await idOfCode("1101"); // an active bank account that is NOT the frozen one
  periodId = (
    await W.rowsOf(
      `SELECT id FROM fiscal_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId(), W.entityId()],
    )
  )[0]!.id as string;
});

// ---- Helpers (patterns of payroll-payout-897-gl-fee-net.test.ts) ------------------

const feeKey = (posting: Row) => `payroll-payout-fee:${posting.item_set_hash}`;
type Line = { accountId: string; debit: number; credit: number };
type Header = { sourceType: string; sourceId: string | null };

async function deactivateGlAccount(code: string) {
  const setActive = (active: boolean) =>
    W.asTenant(
      (c) =>
        c.query(
          `UPDATE chart_of_accounts SET is_active = $3
            WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $4`,
          [tenantId(), W.entityId(), active, code],
        ),
      true,
    );
  await setActive(false);
  return () => setActive(true);
}

async function sourceGlOf(batchId: string) {
  return (
    await W.rowsOf(
      `SELECT ba.gl_account_id FROM payroll_disbursement_batches b
         JOIN bank_accounts ba ON ba.tenant_id = b.tenant_id AND ba.id = b.source_bank_account_id
        WHERE b.tenant_id = $1 AND b.id = $2`,
      [tenantId(), batchId],
    )
  )[0]!.gl_account_id as string;
}

/** Bank batch confirmed while 8101 is inactive: settle journaled, fee deferred. */
async function bankSettledFeeDeferred() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = await W.itemsOf(batchId);
  const restore = await deactivateGlAccount("8101");
  try {
    await W.confirm(batchId, W.succeedItems(batchId, items), APP2);
  } finally {
    await restore();
  }
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.kind, "premise: settle journaled").toBe("settle");
  expect(posting!.fee_posted, "premise: fee deferred").toBe(false);
  return { runId, batchId, posting: posting! };
}

/** Header (source type and id) of a normal settlement's journal with `key`, mapped onto `target`. */
async function realHeader(
  keyOf: (posting: Row) => string,
  target: { runId: string; batchId: string },
): Promise<Header & { posting: Row }> {
  const slips = [bank(SITI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  await W.confirm(
    batchId,
    W.succeedItems(batchId, await W.itemsOf(batchId)),
    APP2,
  );
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.fee_posted, "premise: normal settle posts its fee").toBe(
    true,
  );
  const [entry] = await W.rowsOf(
    `SELECT source_type, source_id FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3`,
    [tenantId(), W.entityId(), keyOf(posting!)],
  );
  expect(entry, "premise: the real journal exists").toBeDefined();
  const sourceId =
    entry!.source_id === runId
      ? target.runId
      : entry!.source_id === batchId
        ? target.batchId
        : ((entry!.source_id as string | null) ?? null);
  return {
    sourceType: entry!.source_type as string,
    sourceId,
    posting: posting!,
  };
}

async function insertEntry(
  client: PoolClient,
  key: string,
  header: Header,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, '2026-10-15', $3, $4, $5, 'Payout 900 commit guard test',
             NULL, $6, $7)
     RETURNING id`,
    [
      tenantId(),
      W.entityId(),
      periodId,
      header.sourceType,
      header.sourceId,
      key,
      randomBytes(32).toString("hex"),
    ],
  );
  return rows[0]!.id;
}
/** One statement, so both lines exist when per-row triggers run. */
async function addLines(
  client: PoolClient,
  entryId: string,
  lines: Line[],
  firstNo: number,
) {
  const values = lines
    .map(
      (_, i) =>
        `($1, $2, $${i * 3 + 3}, ${firstNo + i}, $${i * 3 + 4}, $${i * 3 + 5}, NULL)`,
    )
    .join(", ");
  await client.query(
    `INSERT INTO journal_lines
       (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
     VALUES ${values}`,
    [
      tenantId(),
      entryId,
      ...lines.flatMap((l) => [l.accountId, l.debit, l.credit]),
    ],
  );
}

/**
 * A legend_app transaction with a real COMMIT. `work` runs inside; returns the
 * code (and message) of the first error, from a statement or from the commit.
 */
async function appTx(work: (client: PoolClient) => Promise<void>) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId()],
    );
    try {
      await work(client);
      await client.query("COMMIT");
      return { code: undefined as string | undefined, message: "" };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      await client.query("ROLLBACK").catch(() => undefined);
      return { code: e.code ?? "unknown", message: e.message ?? "" };
    }
  } finally {
    client.release();
  }
}
/** The same, always rolled back (for checks that must not stay). */
async function appTxRolledBack(work: (client: PoolClient) => Promise<void>) {
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE legend_app");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId()],
    );
    try {
      await work(client);
      return undefined as string | undefined;
    } catch (error) {
      return (error as { code?: string }).code ?? "unknown";
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

const flipFee = (client: PoolClient, id: string) =>
  client.query(
    `UPDATE payroll_payout_gl_postings SET fee_posted = true WHERE id = $1`,
    [id],
  );
const committedRow = async (id: string) =>
  (
    await W.rowsOf(
      `SELECT kind, fee_posted, source_gl_account_id FROM payroll_payout_gl_postings WHERE id = $1`,
      [id],
    )
  )[0]!;

async function feeContext() {
  const ctx = await bankSettledFeeDeferred();
  const source = await sourceGlOf(ctx.batchId);
  const header = await realHeader(feeKey, ctx);
  return { ...ctx, source, header: header as Header };
}
const correctFeeLines = (source: string): Line[] => [
  { accountId: bankChargesId, debit: FEE, credit: 0 },
  { accountId: source, debit: 0, credit: FEE },
];

// =========================================================================
// F3: the check runs at commit, so late lines count
// =========================================================================

describe("900 the fee and settle guards are checked at commit (F3)", () => {
  it("[900-fee-late-lines-refused] a correct Rp5.000 fee journal and the flip, then more lines on the same entry (Dr bank 4.999 / Cr bank charges 4.999): COMMIT is refused (23514, PAYOUT-37), the flag stays false and no entry stays; with SET CONSTRAINTS ALL IMMEDIATE the late line itself is refused", async () => {
    const ctx = await feeContext();
    const late = (): Line[] => [
      { accountId: ctx.source, debit: 4_999, credit: 0 },
      { accountId: bankChargesId, debit: 0, credit: 4_999 },
    ];

    const deferred = await appTx(async (client) => {
      const entry = await insertEntry(client, feeKey(ctx.posting), ctx.header);
      await addLines(client, entry, correctFeeLines(ctx.source), 1);
      await flipFee(client, ctx.posting.id as string);
      await addLines(client, entry, late(), 3);
    });
    expect(deferred.code, "late lines are counted at commit").toBe(GUARD_CODE);
    expect(deferred.message).toContain("PAYOUT-37");
    expect((await committedRow(ctx.posting.id as string)).fee_posted).toBe(
      false,
    );
    expect(await W.journalByKey(feeKey(ctx.posting))).toBeUndefined();

    const immediate = await appTx(async (client) => {
      const entry = await insertEntry(client, feeKey(ctx.posting), ctx.header);
      await addLines(client, entry, correctFeeLines(ctx.source), 1);
      await flipFee(client, ctx.posting.id as string);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      await addLines(client, entry, late(), 3);
    });
    expect(immediate.code, "refused at the late line").toBe(GUARD_CODE);
    expect((await committedRow(ctx.posting.id as string)).fee_posted).toBe(
      false,
    );
    expect(await W.journalByKey(feeKey(ctx.posting))).toBeUndefined();
  });

  it("[900-settle-late-lines-refused] the same for the settle_pending -> settle flip: extra lines on the settle journal make the COMMIT fail (23514, PAYOUT-37), the posting stays settle_pending and no journal stays", async () => {
    const base = await bankSettledFeeDeferred();
    const source = await sourceGlOf(base.batchId);
    const header = await realHeader((p) => p.journal_key as string, base);
    const copyKey = `payroll-payout:${randomBytes(32).toString("hex")}`;
    const copyHash = randomBytes(32).toString("hex");
    const copyId = { value: "" };

    const buildPending = async (client: PoolClient) => {
      const columns = (
        await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'payroll_payout_gl_postings'
              AND is_generated = 'NEVER' ORDER BY ordinal_position`,
        )
      ).rows.map((r) => r.column_name);
      const values: Record<string, string> = {
        id: "gen_random_uuid()",
        item_set_hash: `'${copyHash}'`,
        journal_key: `'${copyKey}'`,
        kind: "'settle_pending'",
        fee_posted: "true", // the fee is out of the way: only the settle is tested
      };
      const res = await client.query<{ id: string }>(
        `INSERT INTO payroll_payout_gl_postings (${columns.map((c) => `"${c}"`).join(", ")})
         SELECT ${columns.map((c) => values[c] ?? `"${c}"`).join(", ")}
           FROM payroll_payout_gl_postings WHERE id = $1
         RETURNING id`,
        [base.posting.id],
      );
      copyId.value = res.rows[0]!.id;
    };
    const settleLines = (): Line[] => [
      { accountId: salariesPayableId, debit: NET, credit: 0 },
      { accountId: source, debit: 0, credit: NET },
    ];
    const flipSettle = (client: PoolClient) =>
      client.query(
        `UPDATE payroll_payout_gl_postings SET kind = 'settle' WHERE id = $1`,
        [copyId.value],
      );

    const refused = await appTx(async (client) => {
      await buildPending(client);
      const entry = await insertEntry(client, copyKey, header);
      await addLines(client, entry, settleLines(), 1);
      await flipSettle(client);
      await addLines(
        client,
        entry,
        [
          { accountId: bankChargesId, debit: 4_999, credit: 0 },
          { accountId: source, debit: 0, credit: 4_999 },
        ],
        3,
      );
    });
    expect(refused.code, "late lines on the settle journal").toBe(GUARD_CODE);
    expect(refused.message).toContain("PAYOUT-37");
    expect(await W.countJournals(copyKey)).toBe(0);
    expect(
      await W.rowsOf(`SELECT 1 FROM payroll_payout_gl_postings WHERE id = $1`, [
        copyId.value,
      ]),
      "the pending copy did not stay",
    ).toHaveLength(0);
  });

  it("[900-fee-control-commits-once] the correct fee journal plus the flip commit; a second attempt changes nothing and books no second fee", async () => {
    const ctx = await feeContext();

    const first = await appTx(async (client) => {
      const entry = await insertEntry(client, feeKey(ctx.posting), ctx.header);
      await addLines(client, entry, correctFeeLines(ctx.source), 1);
      await flipFee(client, ctx.posting.id as string);
    });
    expect(first.code, first.message).toBeUndefined();
    expect((await committedRow(ctx.posting.id as string)).fee_posted).toBe(
      true,
    );
    expect(await W.countJournals(feeKey(ctx.posting))).toBe(1);

    const second = await appTx(async (client) => {
      const entry = await insertEntry(client, feeKey(ctx.posting), ctx.header);
      await addLines(client, entry, correctFeeLines(ctx.source), 1);
      await flipFee(client, ctx.posting.id as string);
    });
    expect(second.code, "a second journal with the same key is refused").toBe(
      "23505",
    );
    expect(await W.countJournals(feeKey(ctx.posting))).toBe(1);
    expect(await W.journalByKey(feeKey(ctx.posting))).toEqual({
      "8101": { debit: FEE, credit: 0 },
      "1103": { debit: 0, credit: FEE },
    });
  });
});

// =========================================================================
// F4: the source account is the frozen one, nothing else
// =========================================================================

describe("900 a fee is credited to the frozen bank account only (F4)", () => {
  it("[900-source-frozen-only] account A is frozen on the batch, B is another active bank account: a posting insert with source NULL or B is refused, NULL -> B is refused and NULL -> A accepted, a fee credit on B plus the flip is refused and on A accepted once", async () => {
    const ctx = await feeContext();
    const id = ctx.posting.id as string;
    const A = ctx.source;
    const B = otherBankId;
    expect(B, "premise: B is another account").not.toBe(A);
    expect(
      (await committedRow(id)).source_gl_account_id,
      "premise: the service posting carries A",
    ).toBe(A);

    // Insert guard: a copy of the posting with another source.
    const copy = (source: string) => async (client: PoolClient) => {
      const columns = (
        await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'payroll_payout_gl_postings'
              AND is_generated = 'NEVER' ORDER BY ordinal_position`,
        )
      ).rows.map((r) => r.column_name);
      const hex = randomBytes(32).toString("hex");
      const values: Record<string, string> = {
        id: "gen_random_uuid()",
        item_set_hash: `'${hex}'`,
        journal_key: `'payroll-payout:${hex}'`,
        source_gl_account_id: source,
      };
      await client.query(
        `INSERT INTO payroll_payout_gl_postings (${columns.map((c) => `"${c}"`).join(", ")})
         SELECT ${columns.map((c) => values[c] ?? `"${c}"`).join(", ")}
           FROM payroll_payout_gl_postings WHERE id = $1`,
        [id],
      );
    };
    expect(
      await appTxRolledBack(copy(`'${A}'`)),
      "control: a copy on A",
    ).toBeUndefined();
    expect(await appTxRolledBack(copy("NULL"))).toBe(GUARD_CODE);
    expect(await appTxRolledBack(copy(`'${B}'`))).toBe(GUARD_CODE);

    // Fill guard: the posting has no source (history), then NULL -> value.
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET source_gl_account_id = NULL WHERE id = $1`,
          [id],
        ),
      true,
    );
    const fill = (target: string) => (client: PoolClient) =>
      client
        .query(
          `UPDATE payroll_payout_gl_postings SET source_gl_account_id = $2 WHERE id = $1`,
          [id, target],
        )
        .then(() => undefined);
    expect(await appTxRolledBack(fill(B)), "NULL -> B").toBe(GUARD_CODE);
    expect(await appTxRolledBack(fill(A)), "NULL -> A").toBeUndefined();

    // Fee guard: the credit account must be the frozen A.
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET source_gl_account_id = $2 WHERE id = $1`,
          [id, A],
        ),
      true,
    );
    const onB = await appTx(async (client) => {
      const entry = await insertEntry(client, feeKey(ctx.posting), ctx.header);
      await addLines(client, entry, correctFeeLines(B), 1);
      await flipFee(client, id);
    });
    expect(onB.code, "fee credited to B").toBe(GUARD_CODE);
    expect((await committedRow(id)).fee_posted).toBe(false);
    expect(await W.journalByKey(feeKey(ctx.posting))).toBeUndefined();

    const onA = await appTx(async (client) => {
      const entry = await insertEntry(client, feeKey(ctx.posting), ctx.header);
      await addLines(client, entry, correctFeeLines(A), 1);
      await flipFee(client, id);
    });
    expect(onA.code, onA.message).toBeUndefined();
    expect((await committedRow(id)).fee_posted).toBe(true);
    expect(await W.countJournals(feeKey(ctx.posting))).toBe(1);
  });
});

// =========================================================================
// F5: a historical posting without fee_idr never flips
// =========================================================================

const listedRow = async (postingId: string) =>
  (await W.inTx((tx) => glService.listPayoutRecovery(tx, tenantId()))).find(
    (row) => (row as Row).postingId === postingId,
  ) as Row | undefined;

describe("900 a historical posting without fee_idr is listed and never flips (F5)", () => {
  it("[900-historical-null-fee-never-flips] fee_idr NULL (owner, triggers off): a Rp1 and a Rp5.000 fee journal plus the flip are both refused (23514); the recovery list shows reason fee_amount_unverified; repostSkippedFees answers 409 and posts no journal", async () => {
    const ctx = await feeContext();
    const id = ctx.posting.id as string;
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET fee_idr = NULL WHERE id = $1`,
          [id],
        ),
      true,
    );

    for (const amount of [1, FEE]) {
      const result = await appTx(async (client) => {
        const entry = await insertEntry(
          client,
          feeKey(ctx.posting),
          ctx.header,
        );
        await addLines(
          client,
          entry,
          [
            { accountId: bankChargesId, debit: amount, credit: 0 },
            { accountId: ctx.source, debit: 0, credit: amount },
          ],
          1,
        );
        await flipFee(client, id);
      });
      expect(result.code, `Rp${amount} on a NULL fee`).toBe(GUARD_CODE);
    }
    expect((await committedRow(id)).fee_posted).toBe(false);
    expect(await W.journalByKey(feeKey(ctx.posting))).toBeUndefined();

    const listed = await listedRow(id);
    expect(listed, "finance sees the posting").toBeDefined();
    expect(listed!.reason).toBe("fee_amount_unverified");

    const error = await W.httpFailure(
      W.inTx((tx) =>
        (
          glService as unknown as {
            repostSkippedFees: (
              tx: unknown,
              actor: unknown,
              batchId: string,
            ) => Promise<unknown>;
          }
        ).repostSkippedFees(tx, actorOf(APP), ctx.batchId),
      ),
    );
    expect(error, "the repost is refused").not.toBeNull();
    expect(error!.status).toBe(409);
    expect(error!.code).toBe("PAYOUT_FEE_AMOUNT_UNVERIFIED");
    expect(await W.countJournals(feeKey(ctx.posting))).toBe(0);
    expect((await committedRow(id)).fee_posted).toBe(false);
  });
});
