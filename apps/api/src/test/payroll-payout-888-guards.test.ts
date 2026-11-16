// Payout area final, slice D2 (bead legend-8vcsg; brief scratchpad b888/brief.md,
// findings P2 "guard SQL can hide a fee without a journal", the still partly
// open P2 "guard 0385 does not compare the amount" and P2 "overpaid recorded
// while accounting is off after a settlement was already pending", in
// docs/qa/second-opinion-payout-area-final.md). Written fail-first from the
// brief and the CTO decisions, not from the implementation.
//
// Rules proven here (money: no value is marked done without its journal, the GL
// matches the money that moved, nothing is journaled twice):
// 1. `fee_posted` false -> true on a payout posting is only accepted for the
//    role `legend_app` when the fee journal of that posting exists in the same
//    tenant under the key `payroll-payout-fee:<item_set_hash>`. Without it the
//    flip is refused (database guard, SQLSTATE 23514 like the other guard
//    branches), the case stays in recovery, and the recovery sweep then posts the
//    fee exactly once and sets the flag itself.
// 2. The settle guard (migration 0385) also compares the AMOUNT: the journal
//    that justifies the flip `settle_pending|settle_skipped -> settle` must move
//    exactly the sealed total of the posting (Rp1.000.000 here). Rp1.000 (or any
//    other amount) is refused, the right amount is accepted.
// 3. Overpaid recorded after accounting was switched off, while a settlement is
//    already `settle_pending`: `lockJournalPending` must agree with the lock
//    consumer (which still posts the lock because of the pending settlement).
//    Either the report is refused until the lock journal is posted (409
//    PAYOUT_LOCK_JOURNAL_PENDING, nothing changes), or it is accepted and, after
//    the consumer and the recovery sweep, the receivable, the credit of the
//    source and the fee are in the GL exactly once. Silent loss of the overpaid
//    journal is the failure.
//
// Assumptions (the spec is silent, stated so they can be contested):
// - The refusal of the new fee guard uses SQLSTATE 23514 (check violation), the
//   same as the existing PAYOUT-30 guard branches of migrations 0383-0385.
// - The fee journal of a posting has the same header kind as the settle journal
//   of the same batch (entity, source type, source id). To avoid guessing, the
//   "right" fee journal is built by copying the header of a REAL fee journal
//   produced by a normal settlement of the same world.
// - The fee of one BCA ("014") transfer is Rp5.000 (as in the 881 tests).
// - Rule 3 accepts both designs allowed by the CTO decision (refuse until the
//   lock is posted, or accept and journal everything later); it fixes the end
//   state, not the route taken. In the accepted design the transfer fee of the
//   first (double) transfer is journaled too, as the overpaid route test says.
// - Rule 2 sealed total = the net of the batch items (the principal), without
//   the fee (the fee has its own journal and flag).
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import * as glService from "../services/payroll-payout-gl.service.ts";
import {
  __resetRecoveryCursorsForTest,
  runPayoutGlRecoverySweep,
} from "../worker/payout-gl-recovery.job.ts";
import { withAppRole } from "./accounting-ledger-guard-test-helpers.ts";
import {
  ANDI,
  APP,
  APP2,
  APP3,
  BUDI,
  SITI,
  actorOf,
  bank,
  installPayoutWorld,
  runTotals,
  uploadEvidence,
  type Row,
  type Slip,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("888guards");
const tenantId = () => W.tenantId;

const GUARD_CODE = "23514";
const FEE = 5_000;
const NET = 1_000_000;
const NOW = new Date("2026-11-30T03:00:00Z");

const sweep = () => runPayoutGlRecoverySweep(W.scope(), NOW);

// The fairness cursor of the recovery sweep is in memory; start from the top.
beforeEach(() => {
  __resetRecoveryCursorsForTest();
});

let periodId = "";
let salariesPayableId = "";
let bankChargesId = "";
const foreignTenantIds: string[] = [];

beforeAll(async () => {
  const idOfMapping = async (role: string) =>
    (
      await W.rowsOf(
        `SELECT account_id FROM account_mappings
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND role = $3`,
        [tenantId(), W.entityId(), role],
      )
    )[0]!.account_id as string;
  salariesPayableId = await idOfMapping("salaries_payable");
  bankChargesId = (
    await W.rowsOf(
      `SELECT id FROM chart_of_accounts
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '8101'`,
      [tenantId(), W.entityId()],
    )
  )[0]!.id as string;
  periodId = (
    await W.rowsOf(
      `SELECT id FROM fiscal_periods
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = '2026-10'`,
      [tenantId(), W.entityId()],
    )
  )[0]!.id as string;
});

afterAll(async () => {
  if (foreignTenantIds.length === 0) return;
  const client = await W.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM journal_entries WHERE tenant_id = ANY($1::uuid[])",
      [foreignTenantIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});

// ---- Outbox lock event (real consumer path) ----------------------------------
function lockedEnvelope(runId: string, slips: Slip[], aggregateId = runId) {
  const lockedAt = "2026-10-26T05:00:00.000Z";
  return payrollLocked.envelopeSchema.parse({
    id: createUlid(),
    tenantId: tenantId(),
    outletId: null,
    name: "payroll.locked",
    version: 1,
    aggregateType: "payroll",
    aggregateId,
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

/** The lock happened, the consumer has not run yet: the event sits in the outbox. */
async function queueLockedViaOutbox(runId: string, slips: Slip[]) {
  const [taken] = await W.rowsOf(
    `SELECT count(*)::int AS n FROM domain_event_outbox
      WHERE tenant_id = $1 AND aggregate_id = $2`,
    [tenantId(), runId],
  );
  const event = lockedEnvelope(
    runId,
    slips,
    Number(taken!.n) > 0 ? randomUUID() : runId,
  );
  const outboxId = createUlid();
  await W.inTx((tx) =>
    appendOutbox(tx, W.scope(), {
      id: outboxId,
      event,
      destination: "cloud-sync",
      direction: null,
      peerId: null,
    }),
  );
  return { event, outboxId };
}

/** The real consumer path: consumeOutbox with the payroll GL consumer as the callback. */
async function consumeLocked(outboxId: string) {
  let result: { status: string } | undefined;
  await consumeOutbox(db, W.scope(), {
    outboxId,
    authorize: async () => true,
    deliver: async (
      event: unknown,
      _key: string,
      tx: Parameters<typeof deliverPayrollGlEvent>[2],
    ) => {
      result = (await deliverPayrollGlEvent(
        W.scope(),
        event as Parameters<typeof deliverPayrollGlEvent>[1],
        tx,
        NOW,
      )) as { status: string };
    },
  });
  return result;
}

// ---- Switches ----------------------------------------------------------------
async function tenantFlags() {
  const rows = await W.owner.query(
    "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
    [tenantId()],
  );
  return rows.rows[0]!.flags as { modules: string[] } & Record<string, unknown>;
}
async function setFlags(flags: unknown) {
  await W.owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [tenantId(), JSON.stringify(flags)],
  );
}
/** Runs `work` with the accounting module switched off, always restoring the flags. */
async function withAccountingOff<T>(work: () => Promise<T>) {
  const original = await tenantFlags();
  expect(original.modules, "premise: accounting is on").toContain("accounting");
  await setFlags({
    ...original,
    modules: original.modules.filter((m) => m !== "accounting"),
  });
  try {
    return await work();
  } finally {
    await setFlags(original);
  }
}
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

// ---- Ledger ------------------------------------------------------------------
/** Net balance (credit - debit) and totals of a GL account of the PT, all journals. */
async function account(code: string) {
  const [row] = await W.rowsOf(
    `SELECT COALESCE(sum(l.debit_idr), 0)::text AS debit,
            COALESCE(sum(l.credit_idr), 0)::text AS credit
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE l.tenant_id = $1 AND e.legal_entity_id = $2 AND a.code = $3`,
    [tenantId(), W.entityId(), code],
  );
  const debit = Number(row!.debit);
  const credit = Number(row!.credit);
  return { debit, credit, balance: credit - debit };
}
const journalCountOfEntity = async () =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenantId(), W.entityId()],
      )
    )[0]!.n,
  );
const feeKey = (posting: Row) => `payroll-payout-fee:${posting.item_set_hash}`;
const feeJournal = {
  "8101": { debit: FEE, credit: 0 },
  "1103": { debit: 0, credit: FEE },
};

/** GL account of the bank account frozen on the batch (the source of the money). */
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

// ---- Journals as the app role ----------------------------------------------------
type Line = { accountId: string; debit: number; credit: number };
type Header = { sourceType: string; sourceId: string | null };
type JournalSpec = { key: string; lines: Line[]; header: Header };

/** A balanced journal of the fixture entity inserted by the app role inside `client`. */
async function insertJournal(client: PoolClient, spec: JournalSpec) {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (tenant_id, legal_entity_id, entry_date, fiscal_period_id, source_type,
        source_id, description, reversal_of, idempotency_key, request_fingerprint)
     VALUES ($1, $2, '2026-10-15', $3, $4, $5, 'Payout 888 guard test',
             NULL, $6, $7)
     RETURNING id`,
    [
      tenantId(),
      W.entityId(),
      periodId,
      spec.header.sourceType,
      spec.header.sourceId,
      spec.key,
      randomBytes(32).toString("hex"),
    ],
  );
  const entryId = rows[0]!.id;
  for (const [index, line] of spec.lines.entries())
    await client.query(
      `INSERT INTO journal_lines
         (tenant_id, entry_id, account_id, line_no, debit_idr, credit_idr, outlet_id)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
      [tenantId(), entryId, line.accountId, index + 1, line.debit, line.credit],
    );
}

/** A journal of ANOTHER tenant under `key` (owner, row security bypassed). */
async function insertForeignJournal(key: string) {
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
  row: { kind: string; fee_posted: boolean };
};

/**
 * Runs `UPDATE payroll_payout_gl_postings SET <set> WHERE id = $1` as the app
 * role after inserting `journals` in the same transaction. The UPDATE sits
 * behind a savepoint so a refusal can still be read back.
 */
async function tryUpdate(
  id: string,
  set: string,
  journals: JournalSpec[] = [],
): Promise<Attempt> {
  return withAppRole(async (client) => {
    // The savepoint sits before the journals: a refused flip takes them back
    // too, as the one transaction of the service would.
    await client.query("SAVEPOINT guard_try");
    for (const spec of journals) await insertJournal(client, spec);
    let code: string | undefined;
    try {
      await client.query(
        `UPDATE payroll_payout_gl_postings SET ${set} WHERE id = $1`,
        [id],
      );
    } catch (error) {
      code = (error as { code?: string }).code ?? "unknown";
      await client.query("ROLLBACK TO SAVEPOINT guard_try");
    }
    const { rows } = await client.query(
      `SELECT kind, fee_posted FROM payroll_payout_gl_postings WHERE id = $1`,
      [id],
    );
    return { code, row: rows[0] as Attempt["row"] };
  });
}

/** What the row looks like for everyone else, once the attempt is over. */
async function committedRow(id: string) {
  return (
    await W.rowsOf(
      `SELECT kind, fee_posted FROM payroll_payout_gl_postings WHERE id = $1`,
      [id],
    )
  )[0]!;
}

// =========================================================================
// 1. fee_posted false -> true needs the matching fee journal
// =========================================================================

/** Run with a posted lock journal; bank batch confirmed while 8101 is inactive: settle journaled, fee deferred (fee_posted false). */
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
  expect(await W.journalByKey(feeKey(posting!))).toBeUndefined();
  return { runId, batchId, posting: posting! };
}

/** Header of the REAL fee journal of a normal settlement, mapped onto another run/batch. */
async function realFeeHeaderFor(target: { runId: string; batchId: string }) {
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
    [tenantId(), W.entityId(), feeKey(posting!)],
  );
  expect(entry, "premise: the real fee journal exists").toBeDefined();
  const sourceId =
    entry!.source_id === runId
      ? target.runId
      : entry!.source_id === batchId
        ? target.batchId
        : ((entry!.source_id as string | null) ?? null);
  return { sourceType: entry!.source_type as string, sourceId } as Header;
}

describe("fee_posted false -> true needs the matching fee journal (legend-8vcsg)", () => {
  it("[fee-flip-without-journal-refused] the app role cannot mark the fee posted when no fee journal exists: refused, the flag stays false", async () => {
    const { posting } = await bankSettledFeeDeferred();

    const attempt = await tryUpdate(posting.id as string, "fee_posted = true");

    expect(attempt.code).toBe(GUARD_CODE);
    expect(attempt.row.fee_posted).toBe(false);
    expect((await committedRow(posting.id as string)).fee_posted).toBe(false);
    expect(await W.journalByKey(feeKey(posting))).toBeUndefined();
  });

  it("[fee-flip-other-key-refused] a fee journal under another idempotency key does not justify the flip", async () => {
    const { runId, batchId, posting } = await bankSettledFeeDeferred();
    const header = await realFeeHeaderFor({ runId, batchId });
    const source = await sourceGlOf(batchId);

    const attempt = await tryUpdate(posting.id as string, "fee_posted = true", [
      {
        key: `payroll-payout-fee:${randomBytes(32).toString("hex")}`,
        header,
        lines: [
          { accountId: bankChargesId, debit: FEE, credit: 0 },
          { accountId: source, debit: 0, credit: FEE },
        ],
      },
    ]);

    expect(attempt.code).toBe(GUARD_CODE);
    expect((await committedRow(posting.id as string)).fee_posted).toBe(false);
  });

  it("[fee-flip-foreign-tenant-refused] a fee journal of another tenant under the right key does not justify the flip", async () => {
    const { posting } = await bankSettledFeeDeferred();
    await insertForeignJournal(feeKey(posting));

    const attempt = await tryUpdate(posting.id as string, "fee_posted = true");

    expect(attempt.code).toBe(GUARD_CODE);
    expect((await committedRow(posting.id as string)).fee_posted).toBe(false);
  });

  it("[fee-flip-with-journal-accepted] the exact fee journal (Dr 8101 / Cr frozen source, same tenant and key) created in the same transaction lets the flag turn true; exactly one fee journal exists", async () => {
    const { runId, batchId, posting } = await bankSettledFeeDeferred();
    const header = await realFeeHeaderFor({ runId, batchId });
    const source = await sourceGlOf(batchId);

    const attempt = await tryUpdate(posting.id as string, "fee_posted = true", [
      {
        key: feeKey(posting),
        header,
        lines: [
          { accountId: bankChargesId, debit: FEE, credit: 0 },
          { accountId: source, debit: 0, credit: FEE },
        ],
      },
    ]);

    expect(attempt.code).toBeUndefined();
    expect((await committedRow(posting.id as string)).fee_posted).toBe(true);
    expect(await W.journalByKey(feeKey(posting))).toEqual(feeJournal);
    expect(await W.countJournals(feeKey(posting))).toBe(1);
  });

  it("[fee-flip-refused-stays-in-recovery] after the refused flip the case is still recoverable: the sweep posts the fee exactly once (Dr 8101 / Cr bank), sets the flag itself, and repeated sweeps add nothing", async () => {
    const before = { bank: await account("1103"), fee: await account("8101") };
    const { batchId, posting } = await bankSettledFeeDeferred();
    const refused = await tryUpdate(posting.id as string, "fee_posted = true");
    expect(refused.code).toBe(GUARD_CODE);

    // Still owed: nothing in the GL yet, the flag is still false.
    expect((await account("8101")).debit - before.fee.debit).toBe(0);
    expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(false);

    await sweep();
    await sweep();
    await Promise.all([sweep(), sweep()]);

    const [done] = await W.postingsOf(batchId);
    expect(done!.fee_posted, "the sweep recovered the fee").toBe(true);
    expect(await W.journalByKey(feeKey(done!))).toEqual(feeJournal);
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    // The settle journal of this batch moved NET + the deferred fee (net 1103 credit).
    expect(
      (await account("8101")).debit - before.fee.debit,
    ).toBeGreaterThanOrEqual(FEE);
    const journals = await journalCountOfEntity();
    await sweep();
    expect(await journalCountOfEntity()).toBe(journals);
    expect((await account("1103")).credit).toBeGreaterThanOrEqual(
      before.bank.credit + NET + FEE,
    );
  });
});

// =========================================================================
// 2. guard 0385 compares the amount of the settle journal with the sealed total
// =========================================================================

/** A real bank posting of Rp1.000.000 (real sealed total), pending or skipped, with its batch. */
async function bankPosting(kind: "settle_pending" | "settle_skipped") {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  if (kind === "settle_pending") await queueLockedViaOutbox(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = await W.itemsOf(batchId);
  const confirm = () =>
    W.confirm(batchId, W.succeedItems(batchId, items), APP2);
  if (kind === "settle_pending") await confirm();
  else await withAccountingOff(confirm);
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.kind, "premise: stored as the expected kind").toBe(kind);
  // Migration 0390: the flip is checked against the salaries payable account
  // frozen on the posting; a pending/skipped one has none until its lock
  // journal exists (the service freezes it then). Freeze it as the service
  // would, so only the AMOUNT decides these cases (triggers off: test setup).
  await W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_gl_postings SET salaries_payable_account_id = $3
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), posting!.id, salariesPayableId],
      ),
    true,
  );
  expect(
    (
      await W.rowsOf(
        `SELECT settle_net_idr::text AS n FROM payroll_payout_gl_postings WHERE id = $1`,
        [posting!.id],
      )
    )[0]!.n,
    "premise: the service wrote the principal of the posting",
  ).toBe(String(NET));
  return { runId, batchId, posting: posting! };
}

describe("guard 0385 compares the journal amount with the sealed total (legend-8vcsg)", () => {
  const settleLines = async (batchId: string, amount: number) => {
    const source = await sourceGlOf(batchId);
    return [
      { accountId: salariesPayableId, debit: amount, credit: 0 },
      { accountId: source, debit: 0, credit: amount },
    ] as Line[];
  };

  describe.each(["settle_pending", "settle_skipped"] as const)("%s", (kind) => {
    it.each([
      ["Rp1.000 against Rp1.000.000 sealed", 1_000],
      ["one rupiah less than sealed", NET - 1],
      ["one rupiah more than sealed", NET + 1],
      ["double the sealed total", 2 * NET],
    ] as [string, number][])(
      "refuses the flip to settle when the balanced, right-account journal is %s",
      async (_label, amount) => {
        const { runId, batchId, posting } = await bankPosting(kind);

        const attempt = await tryUpdate(
          posting.id as string,
          "kind = 'settle'",
          [
            {
              key: posting.journal_key as string,
              header: { sourceType: "payroll", sourceId: runId },
              lines: await settleLines(batchId, amount),
            },
          ],
        );

        expect(attempt.code).toBe(GUARD_CODE);
        expect(attempt.row.kind).toBe(kind);
        expect((await committedRow(posting.id as string)).kind).toBe(kind);
        expect(
          await W.journalByKey(posting.journal_key as string),
          "the refused flip leaves no journal behind",
        ).toBeUndefined();
      },
    );

    it("accepts the flip to settle when the journal moves exactly the sealed total (Rp1.000.000)", async () => {
      const { runId, batchId, posting } = await bankPosting(kind);

      const attempt = await tryUpdate(posting.id as string, "kind = 'settle'", [
        {
          key: posting.journal_key as string,
          header: { sourceType: "payroll", sourceId: runId },
          lines: await settleLines(batchId, NET),
        },
      ]);

      expect(attempt.code).toBeUndefined();
      expect(attempt.row.kind).toBe("settle");
      expect((await committedRow(posting.id as string)).kind).toBe("settle");
      expect(await W.journalByKey(posting.journal_key as string)).toEqual({
        "2103": { debit: NET, credit: 0 },
        "1103": { debit: 0, credit: NET },
      });
    });
  });
});

// =========================================================================
// 3. overpaid recorded after accounting was switched off (settlement pending)
// =========================================================================

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const overpaidKey = (itemId: string) => `payroll-payout-overpaid:${itemId}`;
const idOf = (row: Row) => row.id as string;

const recordOverpaid = async (itemId: string, batchId: string) => {
  // 905: the second step needs the first step of another person (W.proposeOverpaid).
  await W.proposeOverpaid(
    batchId,
    itemId,
    uploadEvidence(batchId, "mutasi-bank.pdf"),
    "Mutasi bank menunjukkan transfer kedua untuk slip yang sama",
    APP,
  );
  return W.inTx((tx) =>
    (
      glService as unknown as {
        recordOverpaidItem: (...args: unknown[]) => Promise<unknown>;
      }
    ).recordOverpaidItem(
      tx,
      actorOf(APP),
      itemId,
      {
        evidenceKey: uploadEvidence(batchId, "mutasi-bank.pdf"),
        note: "Mutasi bank menunjukkan transfer kedua untuk slip yang sama",
      },
      W.proofs(),
    ),
  );
};

/**
 * Budi's first transfer is resolved failed (two people), the others are paid,
 * a follow-up batch pays Budi. The payroll.locked event stays queued the whole
 * time (accounting on), so every settlement is `settle_pending`.
 */
async function lateDoublePaymentLockPending() {
  const slips = [
    bank(BUDI, BUDI_NET),
    bank(SITI, SITI_NET),
    bank(ANDI, ANDI_NET),
  ];
  const runId = await W.seedRun(slips);
  const { event, outboxId } = await queueLockedViaOutbox(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  const budiFirst = items.find((i) => i.employee_id === BUDI.id)!;
  await W.confirm(
    batchId,
    W.succeedItems(
      batchId,
      items.filter((i) => i.employee_id !== BUDI.id),
    ),
  );
  await W.resolve(batchId, [idOf(budiFirst)], "failed", APP);
  await W.resolve(batchId, [idOf(budiFirst)], "failed", APP3);
  const followUp = await W.exportedBatch(runId);
  const followItems = (await W.itemsOf(followUp)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(followUp, W.succeedItems(followUp, followItems));
  for (const id of [batchId, followUp])
    for (const posting of await W.postingsOf(id))
      expect(posting.kind, "premise: settlement pending").toBe(
        "settle_pending",
      );
  return { runId, batchId, followUp, budiFirst, event, outboxId, slips };
}

describe("overpaid after accounting was switched off with a pending settlement (legend-8vcsg)", () => {
  it("[overpaid-accounting-off-pending-consistent] the overpaid report is either refused until the lock is posted or fully journaled afterwards: receivable, bank credit and fee exactly once, 2103 net zero, replays add nothing", async () => {
    // Drain fees still owed by postings the guard tests above left behind, so
    // the exact deltas below belong to this scenario only.
    await sweep();
    const before = {
      bank: await account("1103"),
      fee: await account("8101"),
      receivable: await account("1204"),
      payable: await account("2103"),
    };
    const { runId, batchId, budiFirst, event, outboxId, slips } =
      await lateDoublePaymentLockPending();
    const itemId = idOf(budiFirst);

    // Accounting is switched off AFTER the settlements became pending.
    const refusal = await withAccountingOff(() =>
      W.httpFailure(recordOverpaid(itemId, batchId)),
    );

    if (refusal) {
      // Design A: refused until the lock journal is posted; nothing changes.
      expect(refusal.status).toBe(409);
      expect(refusal.code).toBe("PAYOUT_LOCK_JOURNAL_PENDING");
      expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("failed");
      expect(await W.countJournals(overpaidKey(itemId))).toBe(0);
    } else {
      // Design B: accepted. Then nothing may be lost later (checked below).
      expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("overpaid");
    }

    // The consumer still posts the lock because of the pending settlements.
    const consumed = await withAccountingOff(() => consumeLocked(outboxId));
    expect(consumed?.status, "the lock journal is posted").toBe("posted");
    await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

    if (refusal) {
      // Now that the lock is posted the same report must work.
      await recordOverpaid(itemId, batchId);
    }
    await sweep();

    // End state, whichever design: the double transfer is recorded exactly once.
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("overpaid");
    expect(await W.journalByKey(overpaidKey(itemId))).toEqual({
      "1204": { debit: BUDI_NET, credit: 0 },
      "1103": { debit: 0, credit: BUDI_NET },
    });
    expect(await W.countJournals(overpaidKey(itemId))).toBe(1);
    const after = {
      bank: await account("1103"),
      fee: await account("8101"),
      receivable: await account("1204"),
      payable: await account("2103"),
    };
    expect(
      after.receivable.debit - before.receivable.debit,
      "the receivable is exactly the second transfer",
    ).toBe(BUDI_NET);
    expect(
      after.fee.debit - before.fee.debit,
      "bank fee once for each of the 4 transfers (Siti, Andi, Budi follow-up, Budi first)",
    ).toBe(4 * FEE);
    expect(
      after.bank.credit - before.bank.credit,
      "bank credited what left: 3 settled nets + the second Budi transfer + 4 fees",
    ).toBe(SITI_NET + ANDI_NET + BUDI_NET + BUDI_NET + 4 * FEE);
    expect(
      after.payable.balance - before.payable.balance,
      "salaries payable is net zero for the run",
    ).toBe(0);

    // Replays add nothing: consumer, event, sweep.
    const journals = await journalCountOfEntity();
    await consumeLocked(outboxId);
    await W.deliverGl(event);
    await sweep();
    await Promise.all([sweep(), sweep()]);
    expect(await journalCountOfEntity()).toBe(journals);
    expect(await W.countJournals(overpaidKey(itemId))).toBe(1);
    expect((await account("8101")).debit - before.fee.debit).toBe(4 * FEE);
  });

  it("[overpaid-accounting-off-lock-queued-no-pending] accounting off, payroll.locked still queued and NO pending settlement: the report is refused (409 PAYOUT_LOCK_JOURNAL_PENDING), nothing changes; once the lock is posted it is journaled exactly once", async () => {
    const slips = [bank(BUDI, BUDI_NET), bank(SITI, SITI_NET)];
    const runId = await W.seedRun(slips);
    const { outboxId } = await queueLockedViaOutbox(runId, slips);
    const batchId = await W.exportedBatch(runId);
    const items = (await W.itemsOf(batchId)).filter(
      (i) => i.status === "exported",
    );
    const budiFirst = items.find((i) => i.employee_id === BUDI.id)!;
    const itemId = idOf(budiFirst);
    // Everything is confirmed while accounting is off: the settlements are
    // `settle_skipped`, none is `settle_pending`.
    const followUp = await withAccountingOff(async () => {
      await W.confirm(
        batchId,
        W.succeedItems(
          batchId,
          items.filter((i) => i.employee_id !== BUDI.id),
        ),
      );
      await W.resolve(batchId, [itemId], "failed", APP);
      await W.resolve(batchId, [itemId], "failed", APP3);
      const next = await W.exportedBatch(runId);
      const nextItems = (await W.itemsOf(next)).filter(
        (i) => i.status === "exported",
      );
      await W.confirm(next, W.succeedItems(next, nextItems));
      return next;
    });
    for (const id of [batchId, followUp])
      for (const posting of await W.postingsOf(id))
        expect(posting.kind, "premise: no pending settlement").not.toBe(
          "settle_pending",
        );
    const before = await journalCountOfEntity();

    const refusal = await withAccountingOff(() =>
      W.httpFailure(recordOverpaid(itemId, batchId)),
    );

    expect(refusal, "the report must be refused").not.toBeNull();
    expect(refusal!.status).toBe(409);
    expect(refusal!.code).toBe("PAYOUT_LOCK_JOURNAL_PENDING");
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("failed");
    expect(await W.countJournals(overpaidKey(itemId))).toBe(0);
    expect(await journalCountOfEntity()).toBe(before);

    // Accounting is on again: the consumer posts the lock, the report then works.
    const consumed = await consumeLocked(outboxId);
    expect(consumed?.status, "the lock journal is posted").toBe("posted");
    await recordOverpaid(itemId, batchId);
    await sweep();

    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("overpaid");
    expect(await W.journalByKey(overpaidKey(itemId))).toEqual({
      "1204": { debit: BUDI_NET, credit: 0 },
      "1103": { debit: 0, credit: BUDI_NET },
    });
    expect(await W.countJournals(overpaidKey(itemId))).toBe(1);
  });
});
