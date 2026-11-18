// Brief payout GL 877, items A and D (legend-1t65x #1, legend-vvzij).
//
// A: the SECOND batch of a run that becomes `settle_pending` while accounting
// is switched off (the run already has a pending settle, round 2 R1 of 870)
// carries a bank fee. The fee must be journaled exactly once when the pending
// settle resolves through the GL consumer: Dr 8101 / Cr bank (1103), the bank
// is credited net + fee in total, salaries payable (2103) is net zero, and
// replays add nothing. Without a `bank_charges` mapping at resolve time the
// consumer must not throw: the settle still resolves, the fee stays unposted
// (`fee_posted = false`, listed for finance) and the existing re-post path books
// it exactly once later.
//
// D: a handover/confirmation recorded as the final `settle_skipped` (accounting
// off, no lock journal, no locked event waiting). When the `payroll.locked`
// event is then consumed with accounting on, the lock journal posts and the
// skipped settle (real money that left) must become `settle` so 2103 does not
// stay open: the source is credited exactly the net, once, replays are safe.
// Cash without a usable petty_cash account (mapping gone, or account inactive)
// stays `settle_skipped` and the consumer must not throw or stall.
//
// Assumptions (spec silent, taken from the CTO decision in the brief):
// - "Accounting off, lock event not consumed yet" is modelled like in
//   payroll-payout-870-gl-pending.test.ts: tenant feature flag without
//   "accounting" for the confirmation, and the `payroll.locked` outbox row is
//   queued AFTER the settlement (D) or BEFORE it (A, via the mixed run).
// - The bank fee of one BCA ("014") transfer is Rp5.000 (as in the 870 tests).
// - A is modelled with a MIXED run (cash batch A pending, bank batch B
//   confirmed with accounting off) because the fixtures make one batch per
//   channel; the rule is per run.
// - Whether the fee is journaled or only marked at the pending stage is not
//   asserted; only the invariant "fee_posted = true implies a fee journal
//   exists" and the final outcome (exactly one fee journal) are.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import * as glService from "../services/payroll-payout-gl.service.ts";
import { returnManualItems } from "../services/payroll-payout-manual.service.ts";
import {
  APP,
  APP2,
  APP3,
  BUDI,
  CASHIER,
  SITI,
  actorOf,
  bank,
  cash,
  installPayoutWorld,
  runTotals,
  uploadEvidence,
  type Row,
  type Slip,
} from "./payroll-payout-fixtures.ts";

// Bank reference of a return claim: unique per claim (evidence key), identical
// on both steps of the same claim.
const bankRefOf = (evidenceKey: string) =>
  `TRX${createHash("sha256").update(evidenceKey).digest("hex").slice(0, 8)}`;

type Tx = Parameters<Parameters<typeof W.inTx>[0]>[0];

const { settleBatchPayouts } = glService;

const W = installPayoutWorld("877gl");
const tenantId = () => W.tenantId;

const FEE = 5_000;
const NET_BANK = 2_000_000;
const NET_CASH = 1_000_000;
const CONSUME_NOW = new Date("2026-11-30T03:00:00Z");

const settle = (batchId: string, by = APP2) =>
  W.inTx((tx) => settleBatchPayouts(tx, actorOf(by), batchId));

const repostSkippedFees = (batchId: string, by = APP) =>
  W.inTx((tx: Tx) =>
    (
      glService as unknown as {
        repostSkippedFees: (
          tx: Tx,
          actor: unknown,
          batchId: string,
        ) => Promise<unknown>;
      }
    ).repostSkippedFees(tx, actorOf(by), batchId),
  );

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

async function queueLockedViaOutbox(runId: string, slips: Slip[]) {
  // Setup: the fixtures never queue the lock event, so a settlement made BEFORE
  // this call (D) has already stored its own `payroll.paid` event as sequence 1
  // of the run's aggregate. Outbox rows are immutable and the consumer demands
  // sequence = last + 1 per aggregate, so in that case the lock event goes on
  // its own aggregate (sequence 1); the GL consumer reads the run from the
  // payload (`payrollRunId`). When nothing was stored yet (A, queued before the
  // handover so the settlement sees it waiting) it stays on the run's aggregate.
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
  const consumed = await consumeOutbox(db, W.scope(), {
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
        CONSUME_NOW,
      )) as { status: string };
    },
  });
  return { consumed, result };
}

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
const journalCountOfEntity = async () =>
  Number(
    (
      await W.rowsOf(
        `SELECT count(*)::int AS n FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenantId(), W.entityId()],
      )
    )[0]!.n,
  );

/** Debit/credit totals and net balance (credit - debit) of a GL account of the PT, all journals. */
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
async function snapshot() {
  return {
    cash: await account("1102"),
    bank: await account("1103"),
    fee: await account("8101"),
    payable: await account("2103"),
  };
}

const feeKey = (posting: Row) => `payroll-payout-fee:${posting.item_set_hash}`;
const feeJournal = {
  "8101": { debit: FEE, credit: 0 },
  "1103": { debit: 0, credit: FEE },
};

/** Removes a role mapping of the PT; returns the function that puts it back. */
async function removeMapping(role: string) {
  const where = `tenant_id = $1 AND legal_entity_id = $2 AND role = '${role}'`;
  const [mapping] = await W.rowsOf(
    `SELECT account_id FROM account_mappings WHERE ${where}`,
    [tenantId(), W.entityId()],
  );
  expect(mapping, `premise: the fixture maps ${role}`).toBeDefined();
  await W.asTenant(
    (c) =>
      c.query(`DELETE FROM account_mappings WHERE ${where}`, [
        tenantId(),
        W.entityId(),
      ]),
    true,
  );
  return () =>
    W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
           VALUES ($1, $2, $3, $4)`,
          [tenantId(), W.entityId(), role, mapping!.account_id],
        ),
      true,
    );
}

/** Account `code` becomes inactive. Returns the restore. */
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

/** The petty_cash/bank role now points at the GL account `code` (instead of its mapped one). Returns the restore. */
async function remapMapping(role: string, code: string) {
  const where = `tenant_id = $1 AND legal_entity_id = $2 AND role = '${role}'`;
  const [mapping] = await W.rowsOf(
    `SELECT account_id FROM account_mappings WHERE ${where}`,
    [tenantId(), W.entityId()],
  );
  expect(mapping, `premise: the fixture maps ${role}`).toBeDefined();
  const set = (accountId: string | null) =>
    W.asTenant(
      (c) =>
        c.query(
          accountId === null
            ? `UPDATE account_mappings SET account_id = (
                 SELECT id FROM chart_of_accounts
                  WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3)
               WHERE ${where}`
            : `UPDATE account_mappings SET account_id = $3 WHERE ${where}`,
          [tenantId(), W.entityId(), accountId ?? code],
        ),
      true,
    );
  await set(null);
  return () => set(mapping!.account_id as string);
}

const returnItems = (batchId: string, itemIds: string[], by: string) => {
  const evidenceKey = uploadEvidence(batchId, "dana-kembali.pdf");
  return W.inTx((tx) =>
    returnManualItems(
      tx,
      actorOf(by),
      batchId,
      {
        itemIds,
        evidenceKey,
        bankRef: bankRefOf(evidenceKey),
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      } as never,
      W.proofs(),
    ),
  );
};

// ---------------------------------------------------------------------------
// A. Fee of a second batch that became pending while accounting was off.
// ---------------------------------------------------------------------------

/** Mixed run: cash batch A handed over while the lock is queued (pending); bank batch B approved and exported. */
async function pendingCashThenExportedBank() {
  const slips = [cash(CASHIER, NET_CASH), bank(BUDI, NET_BANK)];
  const runId = await W.seedRun(slips);
  const { outboxId, event } = await queueLockedViaOutbox(runId, slips);
  // 1102 is funded by the caller before its `before` snapshot (the funding
  // journal credits 1103, which these tests measure as the bank).
  const batchA = await W.approvedBatch(runId, "cash");
  const itemsA = await W.itemsOf(batchA);
  await W.handover(
    batchA,
    itemsA.map((i) => i.id as string),
    APP2,
  );
  expect(
    (await W.postingsOf(batchA))[0]!.kind,
    "premise: A stored as pending",
  ).toBe("settle_pending");
  const batchB = await W.exportedBatch(runId);
  return { runId, slips, outboxId, event, batchA, batchB };
}

/** B is confirmed with accounting off; asserts it waits (pending) and never claims a fee that was not journaled. */
async function confirmBWithAccountingOff(batchB: string) {
  const itemsB = await W.itemsOf(batchB);
  await withAccountingOff(() =>
    W.confirm(batchB, W.succeedItems(batchB, itemsB)),
  );
  const [pendingB] = await W.postingsOf(batchB);
  expect(pendingB!.kind, "premise: B is pending, not skipped").toBe(
    "settle_pending",
  );
  if (pendingB!.fee_posted)
    expect(
      await W.journalByKey(feeKey(pendingB!)),
      "fee_posted = true must never be recorded without a fee journal",
    ).toBeDefined();
}

describe("A (legend-1t65x): fee of a second batch that was pending while accounting was off", () => {
  it("[a-pending-second-batch-fee-posted-once] A pending, accounting off, B (with bank fee) confirmed: when the consumer resolves both, the fee is journaled exactly once (Dr 8101 / Cr 1103), the bank is credited net + fee, 2103 is net zero, and replays add nothing", async () => {
    // Setup (legend-rvao9): the cash approve guard needs 1102 to cover batch A.
    await W.fundPettyCash(1_000_000_000);
    const before = await snapshot();
    const { runId, slips, outboxId, event, batchA, batchB } =
      await pendingCashThenExportedBank();
    await confirmBWithAccountingOff(batchB);

    const outcome = await consumeLocked(outboxId);
    expect(outcome.result?.status).toBe("posted");
    await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

    const [postingA] = await W.postingsOf(batchA);
    const [postingB] = await W.postingsOf(batchB);
    expect(postingA!.kind).toBe("settle");
    expect(postingB!.kind).toBe("settle");
    expect(postingB!.fee_posted, "fee marked as posted").toBe(true);
    expect(await W.journalByKey(postingB!.journal_key as string)).toEqual({
      "2103": { debit: NET_BANK, credit: 0 },
      "1103": { debit: 0, credit: NET_BANK },
    });
    expect(await W.journalByKey(feeKey(postingB!))).toEqual(feeJournal);
    expect(await W.countJournals(feeKey(postingB!))).toBe(1);

    const after = await snapshot();
    expect(
      after.bank.credit - before.bank.credit,
      "bank credited the net plus the fee, once",
    ).toBe(NET_BANK + FEE);
    expect(after.fee.debit - before.fee.debit).toBe(FEE);
    expect(
      after.payable.balance - before.payable.balance,
      "2103 is net zero for the run (the fee never touches it)",
    ).toBe(0);

    // Replays: the same event again, the paid event, settle again (also at once).
    const journals = await journalCountOfEntity();
    await consumeLocked(outboxId);
    await W.deliverGl(event);
    await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));
    await settle(batchB);
    await Promise.all([settle(batchB), settle(batchB, APP3)]);
    expect(await journalCountOfEntity(), "replay adds no journal").toBe(
      journals,
    );
    expect(await W.countJournals(feeKey(postingB!))).toBe(1);
    expect(await W.postingsOf(batchB)).toHaveLength(1);
    const replayed = await snapshot();
    expect(replayed.bank.credit - before.bank.credit).toBe(NET_BANK + FEE);
    expect(replayed.payable.balance - before.payable.balance).toBe(0);
  });

  it("[a-pending-second-batch-fee-mapping-missing] the bank_charges mapping is gone when the consumer resolves B: the consumer does not throw, B still settles (net journal, 2103 net zero), the fee stays unposted (fee_posted = false, no fee journal) and finance re-posts it exactly once later", async () => {
    // Setup (legend-rvao9): the cash approve guard needs 1102 to cover batch A.
    await W.fundPettyCash(1_000_000_000);
    const before = await snapshot();
    const { runId, slips, outboxId, batchB } =
      await pendingCashThenExportedBank();
    await confirmBWithAccountingOff(batchB);

    const restore = await removeMapping("bank_charges");
    let restored = false;
    const restoreOnce = async () => {
      if (!restored) {
        restored = true;
        await restore();
      }
    };
    try {
      const outcome = await consumeLocked(outboxId);
      expect(
        outcome.result?.status,
        "the consumer must not throw or stall on a missing fee mapping",
      ).toBe("posted");
      await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

      const [postingB] = await W.postingsOf(batchB);
      expect(postingB!.kind, "the net still settles").toBe("settle");
      expect(postingB!.fee_posted).toBe(false);
      expect(await W.journalByKey(feeKey(postingB!))).toBe(undefined);
      expect(await W.journalByKey(postingB!.journal_key as string)).toEqual({
        "2103": { debit: NET_BANK, credit: 0 },
        "1103": { debit: 0, credit: NET_BANK },
      });
      const mid = await snapshot();
      expect(mid.bank.credit - before.bank.credit).toBe(NET_BANK);
      expect(mid.fee.debit - before.fee.debit).toBe(0);
      expect(mid.payable.balance - before.payable.balance).toBe(0);

      await restoreOnce();
      await repostSkippedFees(batchB);
      await repostSkippedFees(batchB).catch(() => undefined);
      expect(await W.journalByKey(feeKey(postingB!))).toEqual(feeJournal);
      expect(await W.countJournals(feeKey(postingB!))).toBe(1);
      expect((await W.postingsOf(batchB))[0]!.fee_posted).toBe(true);
      const end = await snapshot();
      expect(end.bank.credit - before.bank.credit).toBe(NET_BANK + FEE);
      expect(end.payable.balance - before.payable.balance).toBe(0);
    } finally {
      await restoreOnce();
    }
  });
});

// ---------------------------------------------------------------------------
// D. A final settle_skipped becomes settle once the lock journal is posted.
// ---------------------------------------------------------------------------

/** Cash handed over with accounting off and no locked event waiting: final settle_skipped. */
async function cashSkipped(
  net = NET_CASH,
  beforeHandover?: () => Promise<void>,
) {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  // Setup (legend-rvao9): the cash approve guard needs 1102 to cover the batch.
  await W.fundPettyCash(1_000_000_000);
  const batchId = await W.approvedBatch(runId, "cash");
  await beforeHandover?.();
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await withAccountingOff(() => W.handover(batchId, itemIds, APP2));
  const postings = await W.postingsOf(batchId);
  expect(postings, "premise: one posting").toHaveLength(1);
  expect(postings[0]!.kind, "premise: final settle_skipped").toBe(
    "settle_skipped",
  );
  return { runId, batchId, slips, net };
}

describe("D (legend-vvzij): settle_skipped becomes settle when the lock journal is posted later", () => {
  it("[d-cash-skipped-becomes-settle] cash handed over with accounting off, then accounting on and the locked event consumed: the posting becomes settle, cash is credited exactly the net once, 2103 ends at 0, replays add nothing", async () => {
    const before = await snapshot();
    const { runId, batchId, slips, net } = await cashSkipped();
    const { outboxId, event } = await queueLockedViaOutbox(runId, slips);

    const outcome = await consumeLocked(outboxId);
    expect(outcome.result?.status).toBe("posted");
    await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind, "skipped resolved to settle").toBe("settle");
    expect(await W.journalByKey(postings[0]!.journal_key as string)).toEqual({
      "2103": { debit: net, credit: 0 },
      "1102": { debit: 0, credit: net },
    });
    for (const item of await W.itemsOf(batchId))
      expect(item.gl_posting_id).toBe(postings[0]!.id);
    const after = await snapshot();
    expect(after.cash.credit - before.cash.credit).toBe(net);
    expect(
      after.payable.balance - before.payable.balance,
      "salaries payable is not left open",
    ).toBe(0);

    // Replays.
    const journals = await journalCountOfEntity();
    await consumeLocked(outboxId);
    await W.deliverGl(event);
    await settle(batchId);
    await Promise.all([settle(batchId), settle(batchId, APP3)]);
    expect(await journalCountOfEntity()).toBe(journals);
    expect(await W.countJournals(postings[0]!.journal_key as string)).toBe(1);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    const replayed = await snapshot();
    expect(replayed.cash.credit - before.cash.credit).toBe(net);
    expect(replayed.payable.balance - before.payable.balance).toBe(0);
  });

  it("[d-bank-skipped-becomes-settle] bank transfers confirmed with accounting off (settle_skipped), then the locked event is consumed: posting becomes settle, the bank is credited net + fee exactly once, 2103 ends at 0, replays add nothing", async () => {
    const before = await snapshot();
    const slips = [bank(BUDI, NET_BANK)];
    const runId = await W.seedRun(slips);
    const batchId = await W.exportedBatch(runId);
    const items = await W.itemsOf(batchId);
    await withAccountingOff(() =>
      W.confirm(batchId, W.succeedItems(batchId, items)),
    );
    const [skipped] = await W.postingsOf(batchId);
    expect(skipped!.kind, "premise: final settle_skipped").toBe(
      "settle_skipped",
    );
    const { outboxId, event } = await queueLockedViaOutbox(runId, slips);

    const outcome = await consumeLocked(outboxId);
    expect(outcome.result?.status).toBe("posted");
    await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle");
    expect(postings[0]!.fee_posted).toBe(true);
    expect(await W.journalByKey(postings[0]!.journal_key as string)).toEqual({
      "2103": { debit: NET_BANK, credit: 0 },
      "1103": { debit: 0, credit: NET_BANK },
    });
    expect(await W.journalByKey(feeKey(postings[0]!))).toEqual(feeJournal);
    expect(await W.countJournals(feeKey(postings[0]!))).toBe(1);
    const after = await snapshot();
    expect(after.bank.credit - before.bank.credit).toBe(NET_BANK + FEE);
    expect(after.payable.balance - before.payable.balance).toBe(0);

    const journals = await journalCountOfEntity();
    await consumeLocked(outboxId);
    await W.deliverGl(event);
    await settle(batchId);
    expect(await journalCountOfEntity()).toBe(journals);
    expect(await W.countJournals(feeKey(postings[0]!))).toBe(1);
    const replayed = await snapshot();
    expect(replayed.bank.credit - before.bank.credit).toBe(NET_BANK + FEE);
    expect(replayed.payable.balance - before.payable.balance).toBe(0);
  });

  // Assumption: a settle_skipped bank posting with a fee > 0 only becomes a
  // settle when the bank_charges mapping exists (the fee must then be journaled
  // too). While the mapping is missing the posting stays settle_skipped, nothing
  // is journaled for the settle or the fee, fee_posted stays false (legend-pfk3q) and
  // neither the consumer nor a resolve throws. Once the mapping is back, the
  // pending-settle resolve turns it into settle, journaling net and fee once.
  async function bankSkippedWithLockQueued() {
    const slips = [bank(BUDI, NET_BANK)];
    const runId = await W.seedRun(slips);
    const batchId = await W.exportedBatch(runId);
    const items = await W.itemsOf(batchId);
    await withAccountingOff(() =>
      W.confirm(batchId, W.succeedItems(batchId, items)),
    );
    const [skipped] = await W.postingsOf(batchId);
    expect(skipped!.kind, "premise: final settle_skipped").toBe(
      "settle_skipped",
    );
    expect(skipped!.fee_posted, "premise: fee not yet journaled").toBe(false);
    const { outboxId, event } = await queueLockedViaOutbox(runId, slips);
    return { slips, runId, batchId, outboxId, event };
  }
  const resolveSettles = (runId: string) =>
    W.inTx((tx: Tx) =>
      (
        glService as unknown as {
          resolvePendingSettles: (
            tx: Tx,
            tenantId: string,
            runId: string,
          ) => Promise<unknown>;
        }
      ).resolvePendingSettles(tx, tenantId(), runId),
    );

  it("[d-bank-skipped-fee-mapping-missing] bank confirmed with accounting off (settle_skipped, fee > 0, fee_posted false), then the bank_charges mapping is removed and the locked event is consumed: the consumer does not throw, the lock is journaled, the posting stays settle_skipped without settle or fee journal, fee_posted stays false and the bank is not credited; with the mapping back the resolve makes it settle: net and fee credited to the bank once, 2103 net zero, replays add nothing", async () => {
    const before = await snapshot();
    const { slips, runId, batchId, outboxId, event } =
      await bankSkippedWithLockQueued();

    const restore = await removeMapping("bank_charges");
    let skippedKey = "";
    let skippedFeeKey = "";
    try {
      const outcome = await consumeLocked(outboxId);
      expect(
        outcome.result?.status,
        "the consumer must not throw or stall on a missing fee mapping",
      ).toBe("posted");
      await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

      const postings = await W.postingsOf(batchId);
      expect(postings).toHaveLength(1);
      expect(postings[0]!.kind, "stays settle_skipped").toBe("settle_skipped");
      expect(postings[0]!.fee_posted, "fee_posted untouched").toBe(false);
      skippedKey = postings[0]!.journal_key as string;
      skippedFeeKey = feeKey(postings[0]!);
      expect(await W.journalByKey(skippedKey)).toBe(undefined);
      expect(await W.journalByKey(skippedFeeKey)).toBe(undefined);
      const mid = await snapshot();
      expect(
        mid.payable.credit - before.payable.credit,
        "the lock journal is posted (2103 credited the run's net)",
      ).toBe(NET_BANK);
      expect(mid.bank.credit - before.bank.credit, "bank not credited").toBe(0);
      expect(mid.fee.debit - before.fee.debit).toBe(0);
    } finally {
      await restore();
    }

    await resolveSettles(runId);
    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind, "resolved to settle").toBe("settle");
    expect(postings[0]!.fee_posted).toBe(true);
    expect(await W.journalByKey(postings[0]!.journal_key as string)).toEqual({
      "2103": { debit: NET_BANK, credit: 0 },
      "1103": { debit: 0, credit: NET_BANK },
    });
    expect(await W.journalByKey(feeKey(postings[0]!))).toEqual(feeJournal);
    expect(await W.countJournals(feeKey(postings[0]!))).toBe(1);
    const after = await snapshot();
    expect(after.bank.credit - before.bank.credit).toBe(NET_BANK + FEE);
    expect(after.fee.debit - before.fee.debit).toBe(FEE);
    expect(after.payable.balance - before.payable.balance).toBe(0);

    // Replays add nothing.
    const journals = await journalCountOfEntity();
    await resolveSettles(runId);
    await consumeLocked(outboxId);
    await W.deliverGl(event);
    expect(await journalCountOfEntity(), "replay adds no journal").toBe(
      journals,
    );
    expect(await W.countJournals(postings[0]!.journal_key as string)).toBe(1);
    expect(await W.countJournals(feeKey(postings[0]!))).toBe(1);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    const replayed = await snapshot();
    expect(replayed.bank.credit - before.bank.credit).toBe(NET_BANK + FEE);
    expect(replayed.payable.balance - before.payable.balance).toBe(0);
  });

  it("[d-bank-skipped-fee-mapping-missing-repeat-resolve] bank_charges mapping missing: the lock is consumed and the resolve is repeated without the mapping: nothing throws, the posting stays settle_skipped and no settle or fee journal appears", async () => {
    const before = await snapshot();
    const { runId, batchId, outboxId } = await bankSkippedWithLockQueued();

    const restore = await removeMapping("bank_charges");
    try {
      const outcome = await consumeLocked(outboxId);
      expect(outcome.result?.status).toBe("posted");
      const journals = await journalCountOfEntity();
      await resolveSettles(runId);
      await resolveSettles(runId);
      await Promise.all([resolveSettles(runId), resolveSettles(runId)]);

      const postings = await W.postingsOf(batchId);
      expect(postings).toHaveLength(1);
      expect(postings[0]!.kind).toBe("settle_skipped");
      expect(postings[0]!.fee_posted).toBe(false);
      expect(await W.journalByKey(postings[0]!.journal_key as string)).toBe(
        undefined,
      );
      expect(await W.journalByKey(feeKey(postings[0]!))).toBe(undefined);
      expect(await journalCountOfEntity(), "no journal added").toBe(journals);
      const after = await snapshot();
      expect(after.bank.credit - before.bank.credit).toBe(0);
      expect(after.fee.debit - before.fee.debit).toBe(0);
    } finally {
      await restore();
    }
  });

  it("[d-cash-skipped-no-petty-cash-mapping-stays] no petty_cash mapping at the handover and none when the locked event is consumed (nothing frozen, nothing to fall back on): the consumer does not throw, the lock journal still posts, the posting stays settle_skipped and cash is not credited", async () => {
    const before = await snapshot();
    // Setup (legend-rvao9): approving a cash batch with accounting on needs the
    // petty_cash mapping, so it is removed after the approve, right before the
    // handover (the premise of this test is "no mapping at the handover").
    let restore: () => Promise<unknown> = async () => {};
    let batchId = "";
    try {
      const skipped = await cashSkipped(NET_CASH, async () => {
        restore = await removeMapping("petty_cash");
      });
      batchId = skipped.batchId;
      const { outboxId } = await queueLockedViaOutbox(
        skipped.runId,
        skipped.slips,
      );
      const outcome = await consumeLocked(outboxId);
      expect(
        outcome.result?.status,
        "the consumer must not throw or stall without a cash account",
      ).toBe("posted");
    } finally {
      await restore();
    }

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle_skipped");
    expect(await W.journalByKey(postings[0]!.journal_key as string)).toBe(
      undefined,
    );
    expect(
      (await account("1102")).credit - before.cash.credit,
      "no cash account is guessed",
    ).toBe(0);
  });

  it("[d-cash-skipped-inactive-cash-account-stays] the mapped cash account (1102) is inactive when the locked event is consumed: the consumer does not throw, the posting stays settle_skipped and cash is not credited", async () => {
    const before = await snapshot();
    const { runId, batchId, slips } = await cashSkipped();
    const { outboxId } = await queueLockedViaOutbox(runId, slips);

    const restore = await deactivateGlAccount("1102");
    try {
      const outcome = await consumeLocked(outboxId);
      expect(outcome.result?.status).toBe("posted");
    } finally {
      await restore();
    }

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle_skipped");
    expect((await account("1102")).credit - before.cash.credit).toBe(0);
  });

  // Review additions (items D, round 3). Assumptions:
  // - "frozen bank GL account" = the GL account (1103) of the bank account the
  //   confirmation used; it is made inactive AFTER the confirmation and before
  //   the locked event is consumed.
  // - "lock journaled" is observed as 2103 credited the run's total net (the
  //   lock journal is the only credit to 2103 in these runs).
  // - "Cash source frozen at handover": the account the cash handover used
  //   (1102) is the one credited later even if the petty_cash mapping moves
  //   to another account (1101) before the lock is consumed.
  it("[d-bank-skipped-inactive-gl-stays] the GL account of the bank (1103) is inactive when the locked event is consumed: the consumer does not throw, the lock journal is posted, the posting stays settle_skipped and the bank is not credited", async () => {
    const before = await snapshot();
    const slips = [bank(BUDI, NET_BANK)];
    const runId = await W.seedRun(slips);
    const batchId = await W.exportedBatch(runId);
    const items = await W.itemsOf(batchId);
    await withAccountingOff(() =>
      W.confirm(batchId, W.succeedItems(batchId, items)),
    );
    expect((await W.postingsOf(batchId))[0]!.kind, "premise").toBe(
      "settle_skipped",
    );
    const { outboxId } = await queueLockedViaOutbox(runId, slips);

    const restore = await deactivateGlAccount("1103");
    try {
      const outcome = await consumeLocked(outboxId);
      expect(
        outcome.result?.status,
        "the consumer must not throw or stall on an inactive bank GL account",
      ).toBe("posted");
    } finally {
      await restore();
    }

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle_skipped");
    expect(await W.journalByKey(postings[0]!.journal_key as string)).toBe(
      undefined,
    );
    const after = await snapshot();
    expect(
      after.payable.credit - before.payable.credit,
      "the lock journal is posted (2103 credited the run's net)",
    ).toBe(NET_BANK);
    expect(after.bank.credit - before.bank.credit, "no bank credit").toBe(0);
  });

  it("[d-cash-skipped-remapped-uses-frozen] cash handed over with accounting off while petty_cash maps to 1102, then the mapping moves to 1101 before the lock is consumed: the settle credits 1102 (the account at handover), 1101 is untouched, 2103 ends at 0, once", async () => {
    const before = await snapshot();
    const before1101 = await account("1101");
    const { runId, batchId, slips, net } = await cashSkipped();
    const { outboxId } = await queueLockedViaOutbox(runId, slips);

    const restore = await remapMapping("petty_cash", "1101");
    try {
      const outcome = await consumeLocked(outboxId);
      expect(outcome.result?.status).toBe("posted");
      await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));
    } finally {
      await restore();
    }

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle");
    expect(await W.journalByKey(postings[0]!.journal_key as string)).toEqual({
      "2103": { debit: net, credit: 0 },
      "1102": { debit: 0, credit: net },
    });
    expect((await account("1102")).credit - before.cash.credit).toBe(net);
    expect(
      (await account("1101")).credit - before1101.credit,
      "today's mapping never paid this money",
    ).toBe(0);
    expect((await account("2103")).balance - before.payable.balance).toBe(0);
    expect(await W.countJournals(postings[0]!.journal_key as string)).toBe(1);
  });

  // Assumptions for the returned item (spec silent):
  // - Two bank items (BUDI, SITI); SITI is returned (two approvers, as in
  //   payroll-payout-gl.test.ts) while accounting is still off and before the
  //   locked event is consumed.
  // - The brief says "2103 = 0". By double entry that cannot hold when the bank
  //   is credited net minus the return: the lock credits 2103 the full net, the
  //   settle debits what left the bank, so what stays open in 2103 is exactly
  //   the returned item (the employee is still owed). The test asserts that.
  // - How the return is journaled is not asserted (settle excluding the item,
  //   or settle plus a return journal): only the end balances, "settle
  //   journaled once" and "the return journal at most once".
  it("[d-skipped-with-returned-item] bank items confirmed with accounting off, one returned before the lock: when the locked event is consumed the bank is credited net minus the return (plus the fee), 2103 keeps only the returned amount open, the settle and the fee are journaled once, replays add nothing", async () => {
    const before = await snapshot();
    const NET_SITI = 1_500_000;
    const slips = [bank(BUDI, NET_BANK), bank(SITI, NET_SITI)];
    const runId = await W.seedRun(slips);
    const batchId = await W.exportedBatch(runId);
    const items = await W.itemsOf(batchId);
    const siti = await W.itemOfPerson(batchId, SITI);
    await withAccountingOff(async () => {
      await W.confirm(batchId, W.succeedItems(batchId, items));
      await returnItems(batchId, [siti.id as string], APP);
      await returnItems(batchId, [siti.id as string], APP3);
    });
    expect((await W.itemOfPerson(batchId, SITI)).status, "premise").toBe(
      "returned",
    );
    expect(
      (await W.postingsOf(batchId)).some((p) => p.kind === "settle_skipped"),
      "premise: skipped, nothing resolved yet",
    ).toBe(true);
    const { outboxId, event } = await queueLockedViaOutbox(runId, slips);

    const outcome = await consumeLocked(outboxId);
    expect(outcome.result?.status).toBe("posted");
    await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

    const postings = await W.postingsOf(batchId);
    expect(
      postings.some(
        (p) => p.kind === "settle_skipped" || p.kind === "settle_pending",
      ),
      "nothing stays skipped or pending",
    ).toBe(false);
    const settled = postings.filter((p) => p.kind === "settle");
    expect(settled, "one settle posting").toHaveLength(1);
    expect(await W.countJournals(settled[0]!.journal_key as string)).toBe(1);
    expect(await W.countJournals(feeKey(settled[0]!))).toBe(1);
    expect(
      await W.countJournals(`payroll-payout-return:${siti.id as string}`),
      "the return is journaled at most once",
    ).toBeLessThanOrEqual(1);

    const check = async () => {
      const after = await snapshot();
      const feeDelta = after.fee.debit - before.fee.debit;
      expect(feeDelta, "bank fee booked").toBeGreaterThan(0);
      expect(
        after.bank.credit -
          after.bank.debit -
          (before.bank.credit - before.bank.debit),
        "bank out = net paid and not returned + fee",
      ).toBe(NET_BANK + feeDelta);
      expect(
        after.payable.balance - before.payable.balance,
        "only the returned item stays open in 2103",
      ).toBe(NET_SITI);
    };
    await check();

    const journals = await journalCountOfEntity();
    await consumeLocked(outboxId);
    await W.deliverGl(event);
    await settle(batchId);
    await Promise.all([settle(batchId), settle(batchId, APP3)]);
    expect(await journalCountOfEntity(), "replay adds no journal").toBe(
      journals,
    );
    await check();
  });
});
