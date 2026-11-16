// Payout 905, card legend-kjht5 (the two residual P2 of docs/briefs/905/so-900.md,
// lines 13 and 14). Written fail-first from the second-opinion findings and the
// brief (docs/briefs/905/brief.md, card 2), not from the implementation.
// Everything runs as the app role (`SET LOCAL ROLE legend_app`) with a REAL
// COMMIT (never a ROLLBACK that hides a deferred check), so the database is what
// is proven, not the service.
//
// Rules proven here (founder: the GL matches the money that moved; when in
// doubt, limit the payment):
// - P2 insert. A payout GL posting inserted straight into the table must show
//   its journals at COMMIT: `kind='settle'` needs the principal journal and
//   `fee_posted=true` needs the fee journal of the right amount. Without them
//   the COMMIT fails (23514) and nothing stays. The only explicit exception is a
//   zero fee. The control with both correct journals commits once, a replay adds
//   nothing.
// - P2 historical source. On a historical cash posting whose source account is
//   unknown (NULL), the app role cannot fill an account it cannot prove is the
//   origin cash account (B instead of A) and then settle through it.
//
// Assumptions (the findings leave them open):
// - A refusal is guard code 23514 (a check/trigger failure), at the statement or
//   at COMMIT; I assert the code and the end state, not the phase.
// - A `settle_pending` (held) posting without journals stays legal at insert:
//   the service stores it that way until the lock journal exists (870).
// - "Fee zero" means `fee_idr = 0`; such a posting with `fee_posted=true` needs
//   no fee journal, only the principal journal.
// - Cash origin account A is the account frozen on the posting by the service
//   (petty cash 1102 here). The legitimate control is the service path (cash
//   handover with the lock journal present): it credits A once. I do not
//   prescribe whether finance later records another source through a trusted
//   function, so the raw "fill A as legend_app" case is not asserted either way.
// - The fill-only attempt (no journal, no flip) may be refused or ignored
//   ("ditahan"); what must hold is that B does not become the stored source.
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import {
  APP2,
  BUDI,
  CASHIER,
  bank,
  cash,
  installPayoutWorld,
  runTotals,
  type Row,
  type Slip,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("905gli");
const tenantId = () => W.tenantId;
const GUARD_CODE = "23514";
const NET = 1_000_000;
const NET_CASH = 750_000;

let periodId = "";
let bankChargesId = "";
let salariesPayableId = "";
let otherBankId = "";
let pettyCashId = "";

beforeAll(async () => {
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
  otherBankId = await idOfCode("1101"); // an active bank account, not the cash origin
  pettyCashId = await idOfCode("1102");
  periodId = (
    await W.rowsOf(
      `SELECT id FROM fiscal_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId(), W.entityId()],
    )
  )[0]!.id as string;
});

// ---- Helpers (patterns of payroll-payout-900-gl-commit.test.ts) --------------

type Line = { accountId: string; debit: number; credit: number };
type Header = { sourceType: string; sourceId: string | null };

/** A legend_app transaction with a real COMMIT; the first error, from a statement or the commit. */
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

async function insertEntry(
  client: PoolClient,
  key: string,
  header: Header,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, '2026-10-15', $3, $4, $5, 'Payout 905 insert guard test',
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
/** One statement, so every line exists when per-row triggers run. */
async function addLines(
  client: PoolClient,
  entryId: string,
  lines: Line[],
  firstNo = 1,
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

const postingRowsByHash = (hash: string) =>
  W.rowsOf(
    `SELECT id, kind, fee_posted FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND item_set_hash = $2`,
    [tenantId(), hash],
  );

// =========================================================================
// P2: a directly inserted posting is checked in its end state at COMMIT
// =========================================================================

const FEE_KEY = (hash: string) => `payroll-payout-fee:${hash}`;
const SETTLE_KEY = (hash: string) => `payroll-payout:${hash}`;

/** A normally settled bank posting (fee posted by the service): the template to copy. */
async function settledBank() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  await W.confirm(
    batchId,
    W.succeedItems(batchId, await W.itemsOf(batchId)),
    APP2,
  );
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.kind, "premise: settled").toBe("settle");
  expect(posting!.fee_posted, "premise: fee posted by the service").toBe(true);
  const fee = Number(posting!.fee_idr);
  expect(fee, "premise: a bank fee exists").toBeGreaterThan(0);
  expect(Number(posting!.settle_net_idr), "premise: net").toBe(NET);
  const [entry] = await W.rowsOf(
    `SELECT source_type, source_id FROM journal_entries
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3`,
    [tenantId(), W.entityId(), posting!.journal_key],
  );
  expect(entry, "premise: the real settle journal exists").toBeDefined();
  return {
    posting: posting!,
    batchId,
    fee,
    source: await sourceGlOf(batchId),
    header: {
      sourceType: entry!.source_type as string,
      sourceId: (entry!.source_id as string | null) ?? null,
    } as Header,
  };
}

type CopyOptions = { kind: string; feePosted: boolean; feeIdr?: number };
/** Insert, as the app role, a copy of `templateId` with a new hash and key. */
async function insertPostingCopy(
  client: PoolClient,
  templateId: string,
  hash: string,
  options: CopyOptions,
) {
  const columns = (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payroll_payout_gl_postings'
          AND is_generated = 'NEVER' ORDER BY ordinal_position`,
    )
  ).rows.map((r) => r.column_name);
  const values: Record<string, string> = {
    id: "gen_random_uuid()",
    item_set_hash: `'${hash}'`,
    journal_key: `'${SETTLE_KEY(hash)}'`,
    kind: `'${options.kind}'`,
    fee_posted: options.feePosted ? "true" : "false",
  };
  if (options.feeIdr !== undefined) values.fee_idr = String(options.feeIdr);
  await client.query(
    `INSERT INTO payroll_payout_gl_postings (${columns.map((c) => `"${c}"`).join(", ")})
     SELECT ${columns.map((c) => values[c] ?? `"${c}"`).join(", ")}
       FROM payroll_payout_gl_postings WHERE id = $1`,
    [templateId],
  );
}

type Journals = {
  principal?: number; // Dr 2103 / Cr source
  fee?: number; // Dr 8101 / Cr source
};
async function addJournals(
  client: PoolClient,
  ctx: Awaited<ReturnType<typeof settledBank>>,
  hash: string,
  journals: Journals,
) {
  if (journals.principal !== undefined) {
    const entry = await insertEntry(client, SETTLE_KEY(hash), ctx.header);
    await addLines(client, entry, [
      { accountId: salariesPayableId, debit: journals.principal, credit: 0 },
      { accountId: ctx.source, debit: 0, credit: journals.principal },
    ]);
  }
  if (journals.fee !== undefined) {
    const entry = await insertEntry(client, FEE_KEY(hash), ctx.header);
    await addLines(client, entry, [
      { accountId: bankChargesId, debit: journals.fee, credit: 0 },
      { accountId: ctx.source, debit: 0, credit: journals.fee },
    ]);
  }
}

/** Posting insert first, then the journals, one app transaction, real COMMIT. */
async function insertPosting(
  ctx: Awaited<ReturnType<typeof settledBank>>,
  options: CopyOptions & Journals,
  hash = randomBytes(32).toString("hex"),
) {
  const outcome = await appTx(async (client) => {
    await insertPostingCopy(client, ctx.posting.id as string, hash, options);
    await addJournals(client, ctx, hash, options);
  });
  return { hash, ...outcome };
}

async function expectNothingStays(hash: string) {
  expect(await postingRowsByHash(hash), "no posting row stays").toHaveLength(0);
  expect(await W.countJournals(SETTLE_KEY(hash))).toBe(0);
  expect(await W.countJournals(FEE_KEY(hash))).toBe(0);
}

describe("905 a posting inserted by the app role is checked at COMMIT (P2 insert)", () => {
  it("[905-insert-settle-fee-posted-no-journal] INSERT kind='settle', fee_posted=true as legend_app with no journal at all: the COMMIT fails (23514) and the posting does not stay", async () => {
    const ctx = await settledBank();
    const result = await insertPosting(ctx, {
      kind: "settle",
      feePosted: true,
    });
    expect(result.code, "a settle posting without a journal is refused").toBe(
      GUARD_CODE,
    );
    await expectNothingStays(result.hash);
  });

  it("[905-insert-settle-no-principal-journal] INSERT kind='settle', fee_posted=false and no principal journal: the COMMIT fails (23514), nothing stays", async () => {
    const ctx = await settledBank();
    const result = await insertPosting(ctx, {
      kind: "settle",
      feePosted: false,
    });
    expect(result.code).toBe(GUARD_CODE);
    await expectNothingStays(result.hash);
  });

  it("[905-insert-fee-claimed-no-fee-journal] a correct principal journal but fee_posted=true without the fee journal (fee Rp > 0): the COMMIT fails (23514), the principal journal does not stay", async () => {
    const ctx = await settledBank();
    const result = await insertPosting(ctx, {
      kind: "settle",
      feePosted: true,
      principal: NET,
    });
    expect(result.code, "the fee is claimed but not journaled").toBe(
      GUARD_CODE,
    );
    await expectNothingStays(result.hash);
  });

  it("[905-insert-fee-journal-no-principal] a correct fee journal and fee_posted=true but no principal journal for kind='settle': the COMMIT fails (23514), nothing stays", async () => {
    const ctx = await settledBank();
    const result = await insertPosting(ctx, {
      kind: "settle",
      feePosted: true,
      fee: ctx.fee,
    });
    expect(result.code).toBe(GUARD_CODE);
    await expectNothingStays(result.hash);
  });

  it("[905-insert-wrong-amounts] a principal one rupiah short, or a fee of Rp1 against the posted fee: each COMMIT fails (23514), nothing stays", async () => {
    const ctx = await settledBank();
    const shortPrincipal = await insertPosting(ctx, {
      kind: "settle",
      feePosted: true,
      principal: NET - 1,
      fee: ctx.fee,
    });
    expect(shortPrincipal.code, "principal Rp1 short").toBe(GUARD_CODE);
    await expectNothingStays(shortPrincipal.hash);

    const shortFee = await insertPosting(ctx, {
      kind: "settle",
      feePosted: true,
      principal: NET,
      fee: 1,
    });
    expect(shortFee.code, "fee Rp1 against the posted fee").toBe(GUARD_CODE);
    await expectNothingStays(shortFee.hash);
  });

  it("[905-insert-control-commits-once] control: the posting with the correct principal and fee journals commits; replaying the same posting and keys adds nothing", async () => {
    const ctx = await settledBank();
    const first = await insertPosting(ctx, {
      kind: "settle",
      feePosted: true,
      principal: NET,
      fee: ctx.fee,
    });
    expect(first.code, first.message).toBeUndefined();
    expect(await postingRowsByHash(first.hash)).toHaveLength(1);
    expect(await W.countJournals(SETTLE_KEY(first.hash))).toBe(1);
    expect(await W.countJournals(FEE_KEY(first.hash))).toBe(1);
    expect(await W.journalByKey(FEE_KEY(first.hash))).toEqual({
      "8101": { debit: ctx.fee, credit: 0 },
      "1103": { debit: 0, credit: ctx.fee },
    });

    const replay = await insertPosting(
      ctx,
      { kind: "settle", feePosted: true, principal: NET, fee: ctx.fee },
      first.hash,
    );
    expect(replay.code, "same keys are refused").toBeDefined();
    expect(await postingRowsByHash(first.hash)).toHaveLength(1);
    expect(await W.countJournals(SETTLE_KEY(first.hash))).toBe(1);
    expect(await W.countJournals(FEE_KEY(first.hash))).toBe(1);
  });

  it("[905-insert-zero-fee-exception] explicit exception: fee_idr=0 with fee_posted=true needs no fee journal, only the principal journal; the same without the principal journal is refused", async () => {
    const ctx = await settledBank();
    const withPrincipal = await insertPosting(ctx, {
      kind: "settle",
      feePosted: true,
      feeIdr: 0,
      principal: NET,
    });
    expect(withPrincipal.code, withPrincipal.message).toBeUndefined();
    expect(await postingRowsByHash(withPrincipal.hash)).toHaveLength(1);
    expect(await W.countJournals(SETTLE_KEY(withPrincipal.hash))).toBe(1);
    expect(await W.countJournals(FEE_KEY(withPrincipal.hash))).toBe(0);

    const without = await insertPosting(ctx, {
      kind: "settle",
      feePosted: true,
      feeIdr: 0,
    });
    expect(without.code, "zero fee does not excuse the principal").toBe(
      GUARD_CODE,
    );
    await expectNothingStays(without.hash);
  });

  it("[905-insert-pending-stays-legal] control: a held settle_pending posting with fee_posted=false and no journal still commits (the service stores it until the lock journal exists)", async () => {
    const ctx = await settledBank();
    const result = await insertPosting(ctx, {
      kind: "settle_pending",
      feePosted: false,
    });
    try {
      expect(result.code, result.message).toBeUndefined();
      expect(await postingRowsByHash(result.hash)).toHaveLength(1);
    } finally {
      await W.asTenant(
        (c) =>
          c.query(
            `DELETE FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND item_set_hash = $2`,
            [tenantId(), result.hash],
          ),
        true,
      );
    }
  });
});

// =========================================================================
// P2: a historical cash source cannot be filled with an unproven account
// =========================================================================

/** The `payroll.locked` envelope the lock would have produced (as in 870). */
function lockedEnvelope(runId: string, slips: Slip[]) {
  const lockedAt = "2026-10-26T05:00:00.000Z";
  return payrollLocked.envelopeSchema.parse({
    id: createUlid(),
    tenantId: tenantId(),
    outletId: null,
    name: "payroll.locked",
    version: 1,
    aggregateType: "payroll",
    aggregateId: runId,
    sequence: 1,
    occurredAt: lockedAt,
    actor: { type: "user", id: randomUUID() },
    deviceId: null,
    idempotencyKey: `payroll.locked-${runId}-${randomUUID()}`,
    payloadSchemaRef: "payroll.locked.v1",
    payload: {
      payrollRunId: runId,
      legalEntityId: W.entityId(),
      runType: "regular",
      periodStart: "2026-09-26",
      periodEnd: "2026-10-25",
      payDate: "2026-10-27",
      totals: runTotals(slips),
      lockedBy: randomUUID(),
      lockedAt,
    },
  });
}
async function queueLockedEvent(runId: string, slips: Slip[]) {
  const event = lockedEnvelope(runId, slips);
  await W.asTenant(
    (c) =>
      c.query(
        `INSERT INTO domain_event_outbox
           (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination)
         VALUES ($1, $2, NULL, $3, 'payroll', $4, 1, $5, 'cloud-sync')`,
        [tenantId(), randomUUID(), randomUUID(), runId, JSON.stringify(event)],
      ),
    true,
  );
}

const postingRow = async (id: string) =>
  (
    await W.rowsOf(
      `SELECT kind, source_gl_account_id, salaries_payable_account_id
         FROM payroll_payout_gl_postings WHERE id = $1`,
      [id],
    )
  )[0]!;

/**
 * A historical cash posting: handed over while the lock event is still queued
 * (settle_pending), then, as the owner with triggers off (a row from before the
 * source was frozen), its source is cleared and its salaries payable account is
 * set so the settle journal is checkable.
 */
async function historicalCashPending() {
  const slips = [cash(CASHIER, NET_CASH)];
  const runId = await W.seedRun(slips);
  await queueLockedEvent(runId, slips);
  const batchId = await W.approvedBatch(runId, "cash");
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await W.handover(batchId, itemIds, APP2);
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.kind, "premise: stored as pending").toBe("settle_pending");
  expect(
    Number(posting!.settle_net_idr),
    "premise: the principal is the net",
  ).toBe(NET_CASH);
  expect(
    posting!.source_gl_account_id,
    "premise: the service froze cash origin A (petty cash)",
  ).toBe(pettyCashId);
  await W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_gl_postings
            SET source_gl_account_id = NULL, salaries_payable_account_id = $2
          WHERE id = $1`,
        [posting!.id, salariesPayableId],
      ),
    true,
  );
  return { runId, batchId, posting: posting! };
}

describe("905 a historical cash source is not filled with an unproven account (P2 source)", () => {
  it("[905-source-fill-unproven-refused] historical cash posting, source NULL: legend_app fills account B (1101, not the origin cash A), journals Dr 2103 / Cr B for the net and flips to settle: the COMMIT fails (23514); the posting stays pending with no source and no journal", async () => {
    const ctx = await historicalCashPending();
    const id = ctx.posting.id as string;
    const key = ctx.posting.journal_key as string;
    expect(otherBankId, "premise: B is not A").not.toBe(pettyCashId);

    const result = await appTx(async (client) => {
      await client.query(
        `UPDATE payroll_payout_gl_postings SET source_gl_account_id = $2 WHERE id = $1`,
        [id, otherBankId],
      );
      const entry = await insertEntry(client, key, {
        sourceType: "payroll",
        sourceId: ctx.runId,
      });
      await addLines(client, entry, [
        { accountId: salariesPayableId, debit: NET_CASH, credit: 0 },
        { accountId: otherBankId, debit: 0, credit: NET_CASH },
      ]);
      await client.query(
        `UPDATE payroll_payout_gl_postings SET kind = 'settle' WHERE id = $1`,
        [id],
      );
    });
    expect(result.code, "an unproven source cannot settle").toBe(GUARD_CODE);
    expect(await postingRow(id)).toMatchObject({
      kind: "settle_pending",
      source_gl_account_id: null,
    });
    expect(await W.journalByKey(key), "no journal stays").toBeUndefined();
  });

  it("[905-source-fill-only-not-stored] filling B alone (no journal, no flip) must not leave B as the stored source: it is refused or ignored", async () => {
    const ctx = await historicalCashPending();
    const id = ctx.posting.id as string;
    await appTx(async (client) => {
      await client.query(
        `UPDATE payroll_payout_gl_postings SET source_gl_account_id = $2 WHERE id = $1`,
        [id, otherBankId],
      );
    });
    expect(
      (await postingRow(id)).source_gl_account_id,
      "B is not accepted as the origin of the cash",
    ).not.toBe(otherBankId);
  });

  it("[905-source-control-journals-once] control: a cash handover with the lock journal present settles from the cash origin A: the posting is settle with source 1102, the journal is Dr 2103 / Cr 1102 for the net, once", async () => {
    const slips = [cash(CASHIER, NET_CASH)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.approvedBatch(runId, "cash");
    const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
    await W.handover(batchId, itemIds, APP2);

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    const posting = postings[0] as Row;
    expect(posting.kind).toBe("settle");
    expect(posting.source_gl_account_id).toBe(pettyCashId);
    expect(await W.countJournals(posting.journal_key as string)).toBe(1);
    expect(await W.journalByKey(posting.journal_key as string)).toEqual({
      "2103": { debit: NET_CASH, credit: 0 },
      "1102": { debit: 0, credit: NET_CASH },
    });
    for (const item of await W.itemsOf(batchId))
      expect(item.gl_posting_id).toBe(posting.id);
  });
});
