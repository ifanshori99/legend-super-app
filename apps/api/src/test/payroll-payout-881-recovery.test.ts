// Brief payout GL 881, item P1-a (legend-pfk3q): a settlement that cannot be
// journaled yet is a DURABLE recovery obligation, not a silent loss.
//
// Rules proven here (founder: nobody is paid twice, the PT is not short, 2103
// is right, the source is credited exactly once):
// - A bank settlement confirmed while accounting is off, with a bank fee > 0,
//   is stored as `settle_skipped` with `fee_posted = false`. `fee_posted` is
//   never true while no fee journal exists.
// - When the `payroll.locked` outbox event is consumed (real consumer), the
//   event is delivered and the lock journal is posted EVEN IF the settlement
//   cannot be journaled yet (bank_charges mapping missing, frozen source
//   account not postable). The consumer does not throw and the outbox is not
//   held. The posting stays `settle_skipped` and is listed for finance with a
//   reason (`GET /api/hris/payroll/payout-fee-reposts`).
// - The periodic worker sweep (`runPayoutGlRecoverySweep`) repairs it once the
//   configuration is fixed: kind becomes `settle`, the source is credited
//   net + fee exactly once, 2103 is net zero, one fee journal, `fee_posted`
//   true, gone from the list. Re-running the sweep, also in parallel, adds no
//   journal. While the cause persists the sweep changes nothing and does not
//   throw. Before the lock journal exists the sweep never journals the settle.
//
// Names this test EXPECTS (from brief 881; none exist yet):
// - `apps/api/src/worker/payout-gl-recovery.job.ts` exports
//   `runPayoutGlRecoverySweep(context: ScopedTenantContext, now: Date)`.
// - the list rows (`GET /api/hris/payroll/payout-fee-reposts`, `data[]`) carry
//   `{ postingId, batchId, feeIdr, netIdr, kind, reason }` with reason one of
//   bank_charges_missing | accounting_disabled | source_account_unknown |
//   source_account_inactive | awaiting_resolve.
//
// Assumptions (spec silent):
// - Fee of one BCA ("014") transfer is Rp5.000; net Rp1.000.000 as in the brief.
// - The outbox lock event is queued like in the 877 tests (own aggregate when
//   the run already stored a `payroll.paid` event, because outbox sequences
//   are per aggregate).
// - The sweep return value is not asserted (only that it does not throw).
// - The strict endpoint `POST .../repost-fees` stays 409 while the bank_charges
//   mapping is missing (existing behavior of the 8codi hardening tests).
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import {
  __resetRecoveryCursorsForTest,
  runPayoutGlRecoverySweep,
} from "../worker/payout-gl-recovery.job.ts";
import { openPayrollValue, sealPayrollValue } from "../lib/payroll-sealed.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import { originHeader } from "./helpers.ts";
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

const W = installPayoutWorld("881rec");
const tenantId = () => W.tenantId;

const LIST = "/api/hris/payroll/payout-fee-reposts";
const BASE = "/api/hris/payroll/disbursement-batches";
const FEE = 5_000;
const NET = 1_000_000;
const NOW = new Date("2026-11-30T03:00:00Z");

const sweep = () => runPayoutGlRecoverySweep(W.scope(), NOW);
/** One tick that handles at most one batch (the fairness cursor decides which). */
const tickOne = () =>
  runPayoutGlRecoverySweep(W.scope(), NOW, { batchLimit: 1 });

// The fairness cursor is in-memory per tenant; every test starts from the top.
beforeEach(() => {
  __resetRecoveryCursorsForTest();
});

// ---- Finance client (permission + MFA, as the other payout HTTP tests) -------
const mfaOwner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const enrolledUsers: string[] = [];
afterAll(async () => {
  if (enrolledUsers.length > 0)
    await mfaOwner.query(
      "DELETE FROM mfa_factors WHERE user_id = ANY($1::uuid[])",
      [enrolledUsers],
    );
  await mfaOwner.end();
});
let financePromise: ReturnType<typeof makeFinance> | undefined;
async function makeFinance() {
  const { client, userId } = await W.signedInClient("Recovery881 Finance");
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  const enrolled = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
  const { factorId, secretBase32 } = enrolled.body.data as {
    factorId: string;
    secretBase32: string;
  };
  enrolledUsers.push(userId);
  const verified = await client
    .post("/api/auth/mfa/verify")
    .set(originHeader)
    .send({ factorId, code: totpCode(secretBase32, totpStep(new Date())) });
  expect(verified.status, JSON.stringify(verified.body)).toBe(200);
  return client;
}
const finance = () => (financePromise ??= makeFinance());

/** The row of this posting in the finance recovery list, or undefined. */
async function listedRow(postingId: string) {
  const res = await (await finance()).get(LIST);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.data as Row[]).find((row) => row.postingId === postingId);
}

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
  return { eventId: event.id as string, outboxId };
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
async function outboxState(eventId: string) {
  const [row] = await W.rowsOf(
    `SELECT status, delivered_at FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'id' = $2`,
    [tenantId(), eventId],
  );
  return row!;
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
  let restored = false;
  return async () => {
    if (restored) return;
    restored = true;
    await W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
           VALUES ($1, $2, $3, $4)`,
          [tenantId(), W.entityId(), role, mapping!.account_id],
        ),
      true,
    );
  };
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
const netJournal = {
  "2103": { debit: NET, credit: 0 },
  "1103": { debit: 0, credit: NET },
};

/** Bank batch confirmed while accounting is off, with a fee owed; the lock event is queued, not consumed. */
async function bankSkippedFeeOwed() {
  const slips = [bank(BUDI, NET)];
  const runId = await W.seedRun(slips);
  const batchId = await W.exportedBatch(runId);
  const items = await W.itemsOf(batchId);
  await withAccountingOff(() =>
    W.confirm(batchId, W.succeedItems(batchId, items), APP2),
  );
  const postings = await W.postingsOf(batchId);
  expect(postings, "premise: one posting").toHaveLength(1);
  const posting = postings[0]!;
  expect(posting.kind, "premise: final settle_skipped").toBe("settle_skipped");
  expect(
    posting.fee_posted,
    "fee_posted must not be true while no fee journal exists",
  ).toBe(false);
  expect(await W.journalByKey(feeKey(posting))).toBeUndefined();
  expect(await W.journalByKey(posting.journal_key as string)).toBeUndefined();
  const { eventId, outboxId } = await queueLockedViaOutbox(runId, slips);
  return { slips, runId, batchId, posting, eventId, outboxId };
}

/** Consumes the lock event and checks that the outbox was released and the lock journal is posted. */
async function consumeAndExpectDelivered(
  eventId: string,
  outboxId: string,
  before: Awaited<ReturnType<typeof snapshot>>,
) {
  const result = await consumeLocked(outboxId);
  expect(
    result?.status,
    "the consumer must not throw or stall on an unrecoverable settlement",
  ).toBe("posted");
  const state = await outboxState(eventId);
  expect(state.status, "outbox event delivered").toBe("delivered");
  expect(state.delivered_at).not.toBeNull();
  const now = await snapshot();
  expect(
    now.payable.credit - before.payable.credit,
    "the lock journal is posted (2103 credited the run's net)",
  ).toBe(NET);
}

describe("pfk3q: unjournalable settlements are recovered by the worker sweep", () => {
  it("[pfk3q-bank-fee-mapping-missing-sweep-recovers] bank confirmed with accounting off (fee_posted false), mapping bank_charges missing when the lock is consumed: event delivered, lock journal posted, posting stays settle_skipped and is listed (bank_charges_missing); after the mapping is back the sweep makes it settle: bank credited 1.005.000 once, 2103 net zero, one fee journal, fee_posted true, delisted; repeated and parallel sweeps add nothing", async () => {
    const before = await snapshot();
    const { batchId, posting, eventId, outboxId } = await bankSkippedFeeOwed();

    const restore = await removeMapping("bank_charges");
    try {
      await consumeAndExpectDelivered(eventId, outboxId, before);

      const [stored] = await W.postingsOf(batchId);
      expect(stored!.kind, "still settle_skipped").toBe("settle_skipped");
      expect(stored!.fee_posted).toBe(false);
      expect(await W.journalByKey(posting.journal_key as string)).toBe(
        undefined,
      );
      expect(await W.journalByKey(feeKey(posting))).toBe(undefined);
      const mid = await snapshot();
      expect(mid.bank.credit - before.bank.credit, "bank untouched").toBe(0);
      expect(mid.fee.debit - before.fee.debit).toBe(0);

      expect(
        await listedRow(posting.id as string),
        "finance sees the obligation with its reason",
      ).toMatchObject({
        postingId: posting.id,
        batchId,
        feeIdr: FEE,
        netIdr: NET,
        kind: "settle_skipped",
        reason: "bank_charges_missing",
      });

      // The strict endpoint is refused while the mapping is missing.
      const early = await (
        await finance()
      )
        .post(`${BASE}/${batchId}/repost-fees`)
        .set(originHeader)
        .send({});
      expect(early.status, JSON.stringify(early.body)).toBe(409);

      // The sweep with the cause still present: no throw, no change.
      const journals = await journalCountOfEntity();
      await sweep();
      await sweep();
      expect(await journalCountOfEntity(), "nothing journaled").toBe(journals);
      expect((await W.postingsOf(batchId))[0]!.kind).toBe("settle_skipped");
      expect(await listedRow(posting.id as string)).toMatchObject({
        reason: "bank_charges_missing",
      });
    } finally {
      await restore();
    }

    await sweep();
    const [done] = await W.postingsOf(batchId);
    expect(done!.kind, "recovered to settle").toBe("settle");
    expect(done!.fee_posted).toBe(true);
    expect(await W.journalByKey(done!.journal_key as string)).toEqual(
      netJournal,
    );
    expect(await W.journalByKey(feeKey(done!))).toEqual(feeJournal);
    expect(await W.countJournals(done!.journal_key as string)).toBe(1);
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    const after = await snapshot();
    expect(
      after.bank.credit - before.bank.credit,
      "source credited net + fee exactly once",
    ).toBe(NET + FEE);
    expect(after.fee.debit - before.fee.debit).toBe(FEE);
    expect(
      after.payable.balance - before.payable.balance,
      "2103 is net zero",
    ).toBe(0);
    expect(
      await listedRow(posting.id as string),
      "gone from the list",
    ).toBeUndefined();

    // Repeated and parallel sweeps, the replayed event and settle add nothing.
    const journals = await journalCountOfEntity();
    await sweep();
    await Promise.all([sweep(), sweep(), sweep()]);
    await consumeLocked(outboxId).catch(() => undefined);
    expect(await journalCountOfEntity(), "replay adds no journal").toBe(
      journals,
    );
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    const replayed = await snapshot();
    expect(replayed.bank.credit - before.bank.credit).toBe(NET + FEE);
    expect(replayed.payable.balance - before.payable.balance).toBe(0);
  });

  it("[pfk3q-parallel-first-sweeps-once] two sweeps racing on the first recovery journal the settle and the fee exactly once", async () => {
    const before = await snapshot();
    const { batchId, posting, eventId, outboxId } = await bankSkippedFeeOwed();
    const restore = await removeMapping("bank_charges");
    try {
      await consumeAndExpectDelivered(eventId, outboxId, before);
    } finally {
      await restore();
    }

    await Promise.all([sweep(), sweep()]);

    const [done] = await W.postingsOf(batchId);
    expect(done!.kind).toBe("settle");
    expect(done!.fee_posted).toBe(true);
    expect(await W.countJournals(posting.journal_key as string)).toBe(1);
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    const after = await snapshot();
    expect(after.bank.credit - before.bank.credit).toBe(NET + FEE);
    expect(after.payable.balance - before.payable.balance).toBe(0);
  });

  it("[pfk3q-frozen-source-inactive-sweep-recovers] the frozen bank GL account (1103) is not postable when the lock is consumed: consumer does not throw, posting stays settle_skipped and is listed (source_account_inactive); once 1103 is active again the sweep makes it settle: bank credited net + fee once, 2103 net zero, delisted", async () => {
    const before = await snapshot();
    const { batchId, posting, eventId, outboxId } = await bankSkippedFeeOwed();

    const reactivate = await deactivateGlAccount("1103");
    let reactivated = false;
    try {
      await consumeAndExpectDelivered(eventId, outboxId, before);

      const [stored] = await W.postingsOf(batchId);
      expect(stored!.kind).toBe("settle_skipped");
      expect(await W.journalByKey(posting.journal_key as string)).toBe(
        undefined,
      );
      expect((await snapshot()).bank.credit - before.bank.credit).toBe(0);
      expect(await listedRow(posting.id as string)).toMatchObject({
        batchId,
        kind: "settle_skipped",
        reason: "source_account_inactive",
      });

      // Sweep while the account is still inactive: no throw, no journal.
      const journals = await journalCountOfEntity();
      await sweep();
      expect(await journalCountOfEntity()).toBe(journals);
      expect((await W.postingsOf(batchId))[0]!.kind).toBe("settle_skipped");

      await reactivate();
      reactivated = true;
    } finally {
      if (!reactivated) await reactivate();
    }

    await sweep();
    const [done] = await W.postingsOf(batchId);
    expect(done!.kind).toBe("settle");
    expect(done!.fee_posted).toBe(true);
    expect(await W.journalByKey(done!.journal_key as string)).toEqual(
      netJournal,
    );
    expect(await W.journalByKey(feeKey(done!))).toEqual(feeJournal);
    expect(await W.countJournals(done!.journal_key as string)).toBe(1);
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    const after = await snapshot();
    expect(after.bank.credit - before.bank.credit).toBe(NET + FEE);
    expect(after.payable.balance - before.payable.balance).toBe(0);
    expect(await listedRow(posting.id as string)).toBeUndefined();

    const journals = await journalCountOfEntity();
    await Promise.all([sweep(), sweep()]);
    expect(await journalCountOfEntity()).toBe(journals);
    expect((await snapshot()).bank.credit - before.bank.credit).toBe(NET + FEE);
  });

  it("[pfk3q-sweep-before-lock-journal] the lock event is not consumed yet: the sweep never journals the settle (2103 is not debited before it was credited); when the lock is consumed afterwards the bank ends credited net + fee exactly once", async () => {
    const before = await snapshot();
    const { batchId, posting, outboxId } = await bankSkippedFeeOwed();

    await sweep();
    await sweep();
    const [early] = await W.postingsOf(batchId);
    expect(early!.kind, "settle waits for the lock journal").toBe(
      "settle_skipped",
    );
    expect(await W.journalByKey(posting.journal_key as string)).toBe(undefined);
    const mid = await snapshot();
    expect(
      mid.payable.debit - before.payable.debit,
      "2103 is never debited before the lock credited it",
    ).toBe(0);

    const result = await consumeLocked(outboxId);
    expect(result?.status).toBe("posted");
    await sweep();

    const [done] = await W.postingsOf(batchId);
    expect(done!.kind).toBe("settle");
    expect(done!.fee_posted).toBe(true);
    expect(await W.countJournals(done!.journal_key as string)).toBe(1);
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    const after = await snapshot();
    expect(after.bank.credit - before.bank.credit).toBe(NET + FEE);
    expect(after.payable.balance - before.payable.balance).toBe(0);
  });

  it("[pfk3q-cash-skipped-needs-no-fee] cash handed over with accounting off: no bank fee exists, so fee_posted is true and nothing is owed for it; the consumed lock settles it once from the cash account and the sweep adds nothing", async () => {
    const before = await snapshot();
    const slips = [cash(CASHIER, NET)];
    const runId = await W.seedRun(slips);
    // Setup (legend-rvao9): the cash approve guard needs 1102 to cover the batch.
    await W.fundPettyCash(1_000_000_000);
    const batchId = await W.approvedBatch(runId, "cash");
    const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
    await withAccountingOff(() => W.handover(batchId, itemIds, APP2));
    const [skipped] = await W.postingsOf(batchId);
    expect(skipped!.kind, "premise").toBe("settle_skipped");
    expect(skipped!.fee_posted, "no fee to post for cash").toBe(true);
    const { outboxId } = await queueLockedViaOutbox(runId, slips);

    const result = await consumeLocked(outboxId);
    expect(result?.status).toBe("posted");
    await sweep();
    await Promise.all([sweep(), sweep()]);

    const [done] = await W.postingsOf(batchId);
    expect(done!.kind).toBe("settle");
    expect(await W.journalByKey(done!.journal_key as string)).toEqual({
      "2103": { debit: NET, credit: 0 },
      "1102": { debit: 0, credit: NET },
    });
    expect(await W.countJournals(done!.journal_key as string)).toBe(1);
    const after = await snapshot();
    expect(after.cash.credit - before.cash.credit).toBe(NET);
    expect(after.payable.balance - before.payable.balance).toBe(0);
    expect(await listedRow(done!.id as string)).toBeUndefined();
  });
});

// =========================================================================
// Brief 881b (architect findings F1, F3, F2)
//
// Assumptions (spec silent):
// - F1: "no lock journal" is the state of `bankSkippedFeeOwed()` (accounting off
//   at the confirmation, the locked event queued and NOT consumed, accounting on
//   again). The bank balance may already hold the fee, so only finance decides:
//   the sweep never journals that fee, the list says `accounting_was_off`, the
//   strict endpoint `POST .../repost-fees` still posts it (200).
// - F3: "the config source is switched off after the handover" is modelled as the
//   batch's frozen source bank account row set inactive (bank_accounts.is_active);
//   the frozen GL account (1103) stays active, so the fee is still postable.
// - F2: an AccountingError is triggered with a CLOSED fiscal period (2026-11, the
//   month of the sweep clock). Whether a second posting of the same sweep still
//   recovers is not testable here (all fixtures post in the same month).
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
  return { runId, batchId, posting: posting!, slips };
}

async function setFiscalPeriodStatus(
  period: string,
  status: "open" | "closed",
) {
  // fiscal_periods_closed_check / fiscal_periods_reopened_check tie the
  // closed_* and reopened_* columns to the status.
  const set =
    status === "closed"
      ? `status = 'closed', closed_by = 'test', closed_at = now()`
      : `status = 'open', closed_by = NULL, closed_at = NULL,
         reopened_reason = 'test', reopened_by = 'test', reopened_at = now()`;
  const updated = await W.asTenant(
    (c) =>
      c.query(
        `UPDATE fiscal_periods SET ${set}
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND period = $3`,
        [tenantId(), W.entityId(), period],
      ),
    true,
  );
  expect(updated.rowCount, `fiscal period ${period} exists`).toBe(1);
}
async function closePeriod(period: string) {
  await setFiscalPeriodStatus(period, "closed");
  let reopened = false;
  return async () => {
    if (reopened) return;
    reopened = true;
    await setFiscalPeriodStatus(period, "open");
  };
}

describe("881b F1: the automatic sweep never journals the fee of a skipped posting whose run has no lock journal", () => {
  it("[f1-skipped-no-lock-journal-fee-not-auto-posted] skipped bank posting with a fee, accounting on again, lock never consumed: repeated and parallel sweeps journal nothing (fee_posted stays false), finance sees it with reason accounting_was_off; the strict repost-fees endpoint still posts the fee exactly once; later lock + sweep credit the bank net + fee in total, once", async () => {
    const before = await snapshot();
    const { batchId, posting, outboxId } = await bankSkippedFeeOwed();

    const journals = await journalCountOfEntity();
    await sweep();
    await sweep();
    await Promise.all([sweep(), sweep()]);
    expect(await journalCountOfEntity(), "the sweep journals nothing").toBe(
      journals,
    );
    const [held] = await W.postingsOf(batchId);
    expect(held!.kind).toBe("settle_skipped");
    expect(held!.fee_posted, "the fee is not auto posted").toBe(false);
    expect(await W.journalByKey(feeKey(posting))).toBeUndefined();
    const mid = await snapshot();
    expect(mid.fee.debit - before.fee.debit, "8101 untouched").toBe(0);
    expect(mid.bank.credit - before.bank.credit, "bank untouched").toBe(0);
    expect(await listedRow(posting.id as string)).toMatchObject({
      postingId: posting.id,
      batchId,
      feeIdr: FEE,
      kind: "settle_skipped",
      reason: "accounting_was_off",
    });

    // Finance decides: the strict endpoint posts the fee, once.
    const repost = await (
      await finance()
    )
      .post(`${BASE}/${batchId}/repost-fees`)
      .set(originHeader)
      .send({});
    expect(repost.status, JSON.stringify(repost.body)).toBe(200);
    expect(await W.journalByKey(feeKey(posting))).toEqual(feeJournal);
    expect(await W.countJournals(feeKey(posting))).toBe(1);
    expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(true);
    expect(await listedRow(posting.id as string)).toBeUndefined();
    const afterRepost = await snapshot();
    expect(afterRepost.fee.debit - before.fee.debit).toBe(FEE);
    expect(afterRepost.bank.credit - before.bank.credit).toBe(FEE);

    // The lock arrives later: the settle follows, the fee is not journaled twice.
    expect((await consumeLocked(outboxId))?.status).toBe("posted");
    await sweep();
    const [done] = await W.postingsOf(batchId);
    expect(done!.kind).toBe("settle");
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    expect(await W.countJournals(done!.journal_key as string)).toBe(1);
    const after = await snapshot();
    expect(after.bank.credit - before.bank.credit).toBe(NET + FEE);
    expect(after.fee.debit - before.fee.debit).toBe(FEE);
    expect(after.payable.balance - before.payable.balance).toBe(0);
  });
});

describe("881b F3: the soft fee repost uses the frozen source, not today's configuration", () => {
  it("[f3-fee-recovers-from-frozen-source-after-config-off] settled bank posting with a deferred fee, then the payout config moves to another active bank account (GL 1101): the sweep still posts the fee once from the account the settle credited (bank 1103 credited the fee, 1101 untouched), delisted", async () => {
    const before = await snapshot();
    const otherBefore = await account("1101");
    const { batchId, posting } = await bankSettledFeeDeferred();

    const [config] = await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [tenantId(), W.entityId()],
    );
    const original = config!.id as string;
    expect(original, "premise: a configured source").toBeTruthy();
    const [existing] = await W.rowsOf(
      `SELECT id FROM bank_accounts
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND account_number_hmac = $3`,
      [tenantId(), W.entityId(), "f".repeat(64)],
    );
    const other =
      (existing?.id as string | undefined) ??
      ((
        await W.rowsOf(
          `INSERT INTO bank_accounts
             (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
              account_number_hmac, account_number_last4, account_number_key_version,
              gl_account_id, created_by)
           SELECT $1, $2, 'BCA', 'Rekening Lain', '\\x00', $3, '2222', 1, id, 'payout-881-test'
             FROM chart_of_accounts
            WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1101'
           RETURNING id`,
          [tenantId(), W.entityId(), "f".repeat(64)],
        )
      )[0]!.id as string);
    const setConfigSource = (id: string) =>
      W.asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_payout_configs SET manual_source_bank_account_id = $3
              WHERE tenant_id = $1 AND legal_entity_id = $2`,
            [tenantId(), W.entityId(), id],
          ),
        true,
      );

    await setConfigSource(other);
    try {
      expect(await listedRow(posting.id as string)).toMatchObject({
        batchId,
        feeIdr: FEE,
      });
      await sweep();
      await Promise.all([sweep(), sweep()]);
    } finally {
      await setConfigSource(original);
    }

    const [done] = await W.postingsOf(batchId);
    expect(done!.fee_posted, "fee recovered from the settled source").toBe(
      true,
    );
    expect(await W.journalByKey(feeKey(done!))).toEqual(feeJournal);
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    const after = await snapshot();
    expect(after.bank.credit - before.bank.credit).toBe(NET + FEE);
    expect(after.fee.debit - before.fee.debit).toBe(FEE);
    expect(after.payable.balance - before.payable.balance).toBe(0);
    expect(
      (await account("1101")).credit - otherBefore.credit,
      "today's configured account is not credited",
    ).toBe(0);
    expect(await listedRow(posting.id as string)).toBeUndefined();
  });

  it("[f3-fee-only-row-reports-source-reason] settled bank posting with a deferred fee whose frozen GL account (1103) is inactive: the list gives source_account_inactive for the fee-only row, the sweep posts nothing; once 1103 is active the sweep posts the fee once", async () => {
    const before = await snapshot();
    const { batchId, posting } = await bankSettledFeeDeferred();

    const reactivate = await deactivateGlAccount("1103");
    let reactivated = false;
    try {
      expect(await listedRow(posting.id as string)).toMatchObject({
        batchId,
        feeIdr: FEE,
        reason: "source_account_inactive",
      });
      const journals = await journalCountOfEntity();
      await sweep();
      expect(await journalCountOfEntity(), "nothing journaled").toBe(journals);
      expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(false);
      await reactivate();
      reactivated = true;
    } finally {
      if (!reactivated) await reactivate();
    }

    expect(
      (await listedRow(posting.id as string))?.reason,
      "awaiting_resolve only when every condition is in place",
    ).toBe("awaiting_resolve");
    await sweep();
    const [done] = await W.postingsOf(batchId);
    expect(done!.fee_posted).toBe(true);
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    expect((await snapshot()).bank.credit - before.bank.credit).toBe(NET + FEE);
    expect(await listedRow(posting.id as string)).toBeUndefined();
  });
});

describe("881b F2: an accounting error (closed period) holds the posting, it does not break the run", () => {
  it("[f2-closed-period-fee-skipped-then-recovers] deferred fee while the fiscal period of the sweep is closed: the sweep does not throw, journals nothing and the posting stays listed; after the period is open again the sweep posts the fee once", async () => {
    const before = await snapshot();
    const { batchId, posting } = await bankSettledFeeDeferred();

    const reopen = await closePeriod("2026-11");
    try {
      const journals = await journalCountOfEntity();
      await expect(sweep()).resolves.not.toThrow();
      await expect(Promise.all([sweep(), sweep()])).resolves.toBeDefined();
      expect(await journalCountOfEntity()).toBe(journals);
      expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(false);
      expect(await listedRow(posting.id as string)).toMatchObject({
        batchId,
        feeIdr: FEE,
      });
    } finally {
      await reopen();
    }

    await sweep();
    const [done] = await W.postingsOf(batchId);
    expect(done!.fee_posted).toBe(true);
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    expect((await snapshot()).bank.credit - before.bank.credit).toBe(NET + FEE);
  });

  it("[f2-closed-period-resolve-held-then-settles] the lock is consumed while the settlement is blocked (bank_charges unmapped), then the mapping is back but the fiscal period is closed: the sweep does not throw and the posting stays settle_skipped; after the period is open the sweep makes it settle once", async () => {
    const before = await snapshot();
    const { batchId, posting, eventId, outboxId } = await bankSkippedFeeOwed();

    // The lock journal itself can only be posted into an open period (the
    // consumer retries otherwise), so the period closes after the consume.
    const restoreMapping = await removeMapping("bank_charges");
    try {
      await consumeAndExpectDelivered(eventId, outboxId, before);
    } finally {
      await restoreMapping();
    }
    expect((await W.postingsOf(batchId))[0]!.kind).toBe("settle_skipped");

    const reopen = await closePeriod("2026-11");
    try {
      const journals = await journalCountOfEntity();
      await expect(sweep()).resolves.not.toThrow();
      await expect(Promise.all([sweep(), sweep()])).resolves.toBeDefined();
      expect(await journalCountOfEntity()).toBe(journals);
      const [held] = await W.postingsOf(batchId);
      expect(held!.kind).toBe("settle_skipped");
      expect(await W.journalByKey(posting.journal_key as string)).toBe(
        undefined,
      );
      expect((await snapshot()).bank.credit - before.bank.credit).toBe(0);
    } finally {
      await reopen();
    }

    await sweep();
    const [done] = await W.postingsOf(batchId);
    expect(done!.kind).toBe("settle");
    expect(await W.countJournals(done!.journal_key as string)).toBe(1);
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    const after = await snapshot();
    expect(after.bank.credit - before.bank.credit).toBe(NET + FEE);
    expect(after.payable.balance - before.payable.balance).toBe(0);
  });
});

describe("881c: batches that wait for a human do not use up the sweep", () => {
  it("[c-permanent-batches-do-not-starve-retryable] with a tick cap of one batch, an older accounting_was_off batch is neither recovered nor counted, and the newer recoverable batch (bank_charges mapping restored) is still recovered", async () => {
    const before = await snapshot();
    const older = await bankSkippedFeeOwed();
    const newer = await bankSkippedFeeOwed();

    const restore = await removeMapping("bank_charges");
    try {
      await consumeAndExpectDelivered(newer.eventId, newer.outboxId, before);
    } finally {
      await restore();
    }
    expect(await listedRow(older.posting.id as string)).toMatchObject({
      reason: "accounting_was_off",
    });
    expect(await listedRow(newer.posting.id as string)).toMatchObject({
      reason: "awaiting_resolve",
    });

    const result = await runPayoutGlRecoverySweep(W.scope(), NOW, {
      batchLimit: 1,
    });
    expect(result.batches, "only the retryable batch is looked at").toBe(1);

    const [recovered] = await W.postingsOf(newer.batchId);
    expect(recovered!.kind, "newer batch recovered").toBe("settle");
    expect(recovered!.fee_posted).toBe(true);
    expect(await W.journalByKey(feeKey(recovered!))).toEqual(feeJournal);

    const [untouched] = await W.postingsOf(older.batchId);
    expect(untouched!.kind).toBe("settle_skipped");
    expect(untouched!.fee_posted).toBe(false);
    expect(await W.journalByKey(feeKey(older.posting))).toBeUndefined();
    expect(await listedRow(older.posting.id as string)).toMatchObject({
      reason: "accounting_was_off",
    });
  });
});

// =========================================================================
// Brief 883 (second opinion on 881): la22h (fair sweep), qq68t (historical
// rows), i612a (paged list)
//
// Assumptions (spec silent):
// - la22h: "a batch held for a retryable reason" is a cash batch whose posting
//   is frozen on an INACTIVE GL account (reason source_account_inactive, the
//   sweep retries it every tick). It is modelled by pointing that posting's
//   source_gl_account_id at the inactive account 1101 (owner, triggers off).
//   The ready batch is a cash batch frozen on 1102 whose lock was consumed
//   while 1102 was inactive; 1102 is active again afterwards.
// - la22h: the held batch is the one with the SMALLER batch id (the sweep walks
//   batch ids in ascending order, wrapping around with a per-tenant cursor).
// - la22h: with N retryable batches and a tick cap of C, every batch gets a
//   turn within ceil(N / C) ticks (here N = 2, C = 1: two ticks).
// - qq68t: a historical row is `settle_skipped`, fee > 0, `fee_posted = true`
//   but NO fee journal (written by an older version). It is modelled by setting
//   fee_posted = true on the posting of `bankSkippedFeeOwed()` (owner). The
//   "mark done without journal" (opening balance) choice is a business
//   decision and is NOT tested.
// - i612a: the list is paged with `?after=<opaque cursor>&limit=<1..200>` and
//   answers `{ data, next }` (default limit 100, max 200, next null at the
//   end). Many listed rows are made by cloning one real posting row (new id,
//   hash and journal key; same batch, same sealed amount).
// =========================================================================

async function accountId(code: string) {
  const [row] = await W.rowsOf(
    `SELECT id FROM chart_of_accounts WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3`,
    [tenantId(), W.entityId(), code],
  );
  return row!.id as string;
}

/** Owner, triggers off: point the posting at another source GL account. */
const setPostingSource = (postingId: string, glAccountId: string) =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_gl_postings SET source_gl_account_id = $3
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId(), postingId, glAccountId],
      ),
    true,
  );

/** Owner, triggers off: remove cloned posting rows. */
const deletePostings = (ids: string[]) =>
  W.asTenant(
    (c) =>
      c.query(
        `DELETE FROM payroll_payout_gl_postings
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId(), ids],
      ),
    true,
  );

/** `count` copies of a real posting row (same batch and amount, new id/hash/journal key, total sealed for its own id). */
async function clonePosting(postingId: string, count: number) {
  const columns = await W.rowsOf(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = ANY (current_schemas(false))
        AND table_name = 'payroll_payout_gl_postings'
        AND is_generated = 'NEVER' AND identity_generation IS NULL
      ORDER BY ordinal_position`,
  );
  const names = columns.map((c) => c.column_name as string);
  const target = names.map((n) => `"${n}"`).join(", ");
  const source = names
    .map((n) =>
      n === "id"
        ? "$3::uuid"
        : n === "item_set_hash"
          ? "$4::text"
          : n === "journal_key"
            ? "$5::text"
            : n === "total_encrypted"
              ? "$6::bytea"
              : `p."${n}"`,
    )
    .join(", ");
  const bindingOf = (rowId: string) => ({
    tenantId: tenantId(),
    table: "payroll_payout_gl_postings" as const,
    rowId,
    field: "total" as const,
  });
  const [original] = await W.rowsOf(
    `SELECT total_encrypted, pii_key_version FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId(), postingId],
  );
  const plain = openPayrollValue(
    original!.total_encrypted as Buffer,
    bindingOf(postingId),
    Number(original!.pii_key_version),
  );
  return W.asTenant(async (c) => {
    const ids: string[] = [];
    for (let g = 1; g <= count; g += 1) {
      const id = randomUUID();
      const hash = createHash("sha256")
        .update(`${postingId}:${g}:${randomUUID()}`)
        .digest("hex");
      await c.query(
        `INSERT INTO payroll_payout_gl_postings (${target})
         SELECT ${source}
           FROM payroll_payout_gl_postings p
          WHERE p.tenant_id = $1 AND p.id = $2`,
        [
          tenantId(),
          postingId,
          id,
          hash,
          `payroll-payout:${hash}`,
          sealPayrollValue(
            plain,
            bindingOf(id),
            Number(original!.pii_key_version),
          ),
        ],
      );
      ids.push(id);
    }
    return ids;
    // 905: the clones are history copies with a source; the insert guard (PAYOUT-70)
    // would refuse a source on a new row, so triggers are off (replica) as in 881-guard.
  }, true);
}

/** Cash handed over with accounting off, lock event queued and not yet consumed. */
async function cashSkippedWithLock() {
  const slips = [cash(CASHIER, NET)];
  const runId = await W.seedRun(slips);
  // Setup (legend-rvao9): the cash approve guard needs 1102 to cover the batch.
  await W.fundPettyCash(1_000_000_000);
  const batchId = await W.approvedBatch(runId, "cash");
  const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);
  await withAccountingOff(() => W.handover(batchId, itemIds, APP2));
  const [posting] = await W.postingsOf(batchId);
  expect(posting!.kind, "premise: final settle_skipped").toBe("settle_skipped");
  const { outboxId } = await queueLockedViaOutbox(runId, slips);
  return { runId, batchId, posting: posting!, outboxId };
}

/**
 * Two cash batches with their lock journals posted and both settlements held:
 * `held` (the smaller batch id, first in the sweep order) waits for an
 * inactive source (1101, source_account_inactive) and stays held; `ready` (the
 * larger id) was only held while 1102 was inactive and is recoverable now.
 * The caller must run `reactivate1101` when done.
 */
async function heldAndReadyCash() {
  const first = await cashSkippedWithLock();
  const second = await cashSkippedWithLock();
  const [held, ready] =
    first.batchId < second.batchId ? [first, second] : [second, first];
  const originalSource = held.posting.source_gl_account_id as string;
  expect(originalSource, "premise: the frozen source is recorded").toBeTruthy();
  const reactivate1101 = await deactivateGlAccount("1101");
  const reactivate1102 = await deactivateGlAccount("1102");
  let ok = false;
  try {
    await setPostingSource(held.posting.id as string, await accountId("1101"));
    expect((await consumeLocked(held.outboxId))?.status).toBe("posted");
    expect((await consumeLocked(ready.outboxId))?.status).toBe("posted");
    ok = true;
  } finally {
    await reactivate1102();
    if (!ok) await reactivate1101();
  }
  for (const side of [held, ready]) {
    const [stored] = await W.postingsOf(side.batchId);
    expect(stored!.kind, "premise: still settle_skipped").toBe(
      "settle_skipped",
    );
    expect(await W.journalByKey(stored!.journal_key as string)).toBeUndefined();
  }
  expect(await listedRow(held.posting.id as string)).toMatchObject({
    batchId: held.batchId,
    reason: "source_account_inactive",
  });
  expect(await listedRow(ready.posting.id as string)).toMatchObject({
    batchId: ready.batchId,
    reason: "awaiting_resolve",
  });
  return { held, ready, originalSource, reactivate1101 };
}

const cashJournal = {
  "2103": { debit: NET, credit: 0 },
  "1102": { debit: 0, credit: NET },
};

describe("la22h: the sweep gives every retryable batch a turn", () => {
  it("[la22h-held-batch-in-front-does-not-starve-next] tick cap of one batch, the first batch (smaller id) stays held on an inactive source, the second is ready: within two ticks the second is settled exactly once (more and parallel ticks add nothing), the held one is untouched until its source is fixed and is then settled once too", async () => {
    const before = await snapshot();
    const beforeOther = await account("1101");
    const { held, ready, originalSource, reactivate1101 } =
      await heldAndReadyCash();
    try {
      await tickOne();
      await tickOne();

      const [done] = await W.postingsOf(ready.batchId);
      expect(done!.kind, "the ready batch got its turn").toBe("settle");
      expect(await W.journalByKey(done!.journal_key as string)).toEqual(
        cashJournal,
      );
      expect(await W.countJournals(done!.journal_key as string)).toBe(1);
      const [stillHeld] = await W.postingsOf(held.batchId);
      expect(stillHeld!.kind).toBe("settle_skipped");
      expect(
        await W.journalByKey(stillHeld!.journal_key as string),
      ).toBeUndefined();
      expect(await listedRow(held.posting.id as string)).toMatchObject({
        reason: "source_account_inactive",
      });
      expect(await listedRow(ready.posting.id as string)).toBeUndefined();

      // More ticks, also parallel ones: nothing is journaled twice.
      const journals = await journalCountOfEntity();
      await tickOne();
      await tickOne();
      await Promise.all([tickOne(), tickOne()]);
      expect(await journalCountOfEntity(), "no further journal").toBe(journals);
      expect(await W.countJournals(done!.journal_key as string)).toBe(1);
      const mid = await snapshot();
      expect(mid.cash.credit - before.cash.credit, "1102 credited once").toBe(
        NET,
      );
      expect(
        (await account("1101")).credit - beforeOther.credit,
        "the inactive source is not credited",
      ).toBe(0);

      // The held batch's source is fixed: it is settled by the next ticks, once.
      await setPostingSource(held.posting.id as string, originalSource);
      await tickOne();
      await tickOne();
      const [fixed] = await W.postingsOf(held.batchId);
      expect(fixed!.kind).toBe("settle");
      expect(await W.journalByKey(fixed!.journal_key as string)).toEqual(
        cashJournal,
      );
      expect(await W.countJournals(fixed!.journal_key as string)).toBe(1);
      await Promise.all([tickOne(), tickOne()]);
      expect(await W.countJournals(fixed!.journal_key as string)).toBe(1);
      expect(await W.countJournals(done!.journal_key as string)).toBe(1);
      const after = await snapshot();
      expect(after.cash.credit - before.cash.credit).toBe(2 * NET);
      expect(after.payable.balance - before.payable.balance).toBe(0);
      expect(await listedRow(held.posting.id as string)).toBeUndefined();
    } finally {
      await reactivate1101();
    }
  });

  it("[la22h-held-batch-with-over-500-postings-does-not-monopolize] the first batch (smaller id) is held and has 501 postings, the second batch is ready: one normal sweep still settles the second batch exactly once and leaves all 501 held postings untouched", async () => {
    const before = await snapshot();
    const { held, ready, originalSource, reactivate1101 } =
      await heldAndReadyCash();
    let clones: string[] = [];
    try {
      clones = await clonePosting(held.posting.id as string, 500);
      expect(clones).toHaveLength(500);
      const heldCount = async () =>
        Number(
          (
            await W.rowsOf(
              `SELECT count(*)::int AS n FROM payroll_payout_gl_postings
                WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'settle_skipped'`,
              [tenantId(), held.batchId],
            )
          )[0]!.n,
        );
      expect(await heldCount(), "premise: 501 held postings").toBe(501);

      await sweep();

      const [done] = await W.postingsOf(ready.batchId);
      expect(done!.kind, "the ready batch is not starved").toBe("settle");
      expect(await W.journalByKey(done!.journal_key as string)).toEqual(
        cashJournal,
      );
      expect(await W.countJournals(done!.journal_key as string)).toBe(1);
      expect(await heldCount(), "held postings untouched").toBe(501);
      expect(
        (await snapshot()).cash.credit - before.cash.credit,
        "1102 credited once",
      ).toBe(NET);

      await sweep();
      await Promise.all([sweep(), sweep()]);
      expect(await W.countJournals(done!.journal_key as string)).toBe(1);
      expect(await heldCount()).toBe(501);
    } finally {
      await deletePostings(clones);
      await setPostingSource(held.posting.id as string, originalSource);
      await reactivate1101();
    }

    // Cleanup proof: with the clones gone and the source fixed, the held batch settles once.
    await sweep();
    const [fixed] = await W.postingsOf(held.batchId);
    expect(fixed!.kind).toBe("settle");
    expect(await W.countJournals(fixed!.journal_key as string)).toBe(1);
    expect((await snapshot()).cash.credit - before.cash.credit).toBe(2 * NET);
  });
});

describe("qq68t: historical skipped rows with fee_posted = true but no fee journal", () => {
  it("[qq68t-historical-fee-flag-without-journal-visible-never-journaled] a settle_skipped bank posting from an older version (fee_posted true, no fee journal) is listed as accounting_was_off, neither the worker nor the batch repost-fees journals its fee (it stays listed); only the owed settlement resolving after the lock brings its fee, once", async () => {
    const before = await snapshot();
    const { batchId, posting, outboxId } = await bankSkippedFeeOwed();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET fee_posted = true
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId(), posting.id],
        ),
      true,
    );
    expect(
      (await W.postingsOf(batchId))[0]!.fee_posted,
      "premise: historical flag",
    ).toBe(true);
    expect(await W.journalByKey(feeKey(posting))).toBeUndefined();

    // Visible to finance although the flag claims the fee is done.
    expect(await listedRow(posting.id as string)).toMatchObject({
      postingId: posting.id,
      batchId,
      feeIdr: FEE,
      netIdr: NET,
      kind: "settle_skipped",
      reason: "accounting_was_off",
    });

    // The worker does not decide on it.
    const journals = await journalCountOfEntity();
    await sweep();
    await Promise.all([sweep(), sweep()]);
    expect(await journalCountOfEntity(), "the sweep journals nothing").toBe(
      journals,
    );
    expect(await W.journalByKey(feeKey(posting))).toBeUndefined();
    expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(true);
    expect(await listedRow(posting.id as string)).toBeDefined();

    // The batch repost does not journal it either (a double expense risk).
    const repost = await (
      await finance()
    )
      .post(`${BASE}/${batchId}/repost-fees`)
      .set(originHeader)
      .send({});
    expect(repost.status, JSON.stringify(repost.body)).toBe(200);
    expect(repost.body.data.reposted).toBe(0);
    expect(await W.journalByKey(feeKey(posting))).toBeUndefined();
    expect(await W.countJournals(feeKey(posting))).toBe(0);
    expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(true);
    expect((await snapshot()).fee.debit - before.fee.debit).toBe(0);
    expect(
      await listedRow(posting.id as string),
      "still listed after the repost",
    ).toMatchObject({ reason: "accounting_was_off" });

    // The lock arrives later: the owed settlement resolves and its fee follows
    // it (the resolver, once, same key); that is the settle path, not the repost.
    expect((await consumeLocked(outboxId))?.status).toBe("posted");
    await sweep();
    const [done] = await W.postingsOf(batchId);
    expect(done!.kind).toBe("settle");
    expect(await W.countJournals(feeKey(done!))).toBe(1);
    expect(await W.countJournals(done!.journal_key as string)).toBe(1);
    const after = await snapshot();
    expect(after.fee.debit - before.fee.debit).toBe(FEE);
    expect(after.payable.balance - before.payable.balance).toBe(0);
  });

  it("[qq68t-batch-repost-journals-only-the-current-fee] one batch holds a current unposted fee (fee_posted false) and a historical one (fee_posted true, no journal): one repost-fees journals only the current fee, once", async () => {
    const before = await snapshot();
    const { batchId, posting } = await bankSkippedFeeOwed();
    const [clone] = await clonePosting(posting.id as string, 1);
    try {
      await W.asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_payout_gl_postings SET fee_posted = true
              WHERE tenant_id = $1 AND id = $2`,
            [tenantId(), posting.id],
          ),
        true,
      );
      const postings = await W.postingsOf(batchId);
      const current = postings.find((p) => p.id === clone)!;
      const historical = postings.find((p) => p.id === posting.id)!;
      expect(current.fee_posted, "premise: current").toBe(false);
      expect(historical.fee_posted, "premise: historical").toBe(true);

      const repost = await (
        await finance()
      )
        .post(`${BASE}/${batchId}/repost-fees`)
        .set(originHeader)
        .send({});
      expect(repost.status, JSON.stringify(repost.body)).toBe(200);
      expect(repost.body.data.reposted).toBe(1);
      expect(await W.countJournals(feeKey(current))).toBe(1);
      expect(await W.countJournals(feeKey(historical))).toBe(0);
      const after = await snapshot();
      expect(after.fee.debit - before.fee.debit).toBe(FEE);
      expect(after.bank.credit - before.bank.credit).toBe(FEE);

      // Repeating adds nothing.
      await (
        await finance()
      )
        .post(`${BASE}/${batchId}/repost-fees`)
        .set(originHeader)
        .send({});
      expect(await W.countJournals(feeKey(current))).toBe(1);
      expect(await W.countJournals(feeKey(historical))).toBe(0);
      expect(
        await listedRow(posting.id as string),
        "the historical row stays listed",
      ).toMatchObject({ reason: "accounting_was_off" });
    } finally {
      await deletePostings([clone!]);
    }
  });

  it("[qq68t-cash-skipped-not-listed-or-scanned] a cash settle_skipped posting (accounting off, no fee) is not listed and the sweep journals nothing for it before its lock", async () => {
    const { batchId, posting } = await cashSkippedWithLock();
    expect(await listedRow(posting.id as string)).toBeUndefined();
    const journals = await journalCountOfEntity();
    await sweep();
    expect(await journalCountOfEntity()).toBe(journals);
    const [stored] = await W.postingsOf(batchId);
    expect(stored!.kind).toBe("settle_skipped");
    expect(await listedRow(posting.id as string)).toBeUndefined();
  });
});

describe("i612a: cursor validation", () => {
  it("[i612a-impossible-date-cursor-422] an `after` cursor with an impossible date answers 422, not 500", async () => {
    const encode = (postedAt: string) =>
      Buffer.from(JSON.stringify([postedAt, randomUUID()]), "utf8").toString(
        "base64url",
      );
    const client = await finance();
    for (const bad of [
      "2026-13-01 10:00:00+00",
      "2026-02-30 10:00:00+00",
      "2026-11-15 25:00:00+00",
      "2026-11-15 10:61:00+00",
    ]) {
      const res = await client.get(
        `${LIST}?after=${encodeURIComponent(encode(bad))}`,
      );
      expect(res.status, `${bad}: ${JSON.stringify(res.body)}`).toBe(422);
    }
    const ok = await client.get(
      `${LIST}?after=${encodeURIComponent(encode("2026-11-15 10:00:00.123456+00"))}`,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe("i612a: the recovery list is paged and every row is reachable", () => {
  it("[i612a-501-cases-reachable-with-cursor] 501 listed cases: following `next` with limit 200 reaches every one exactly once, the default page holds at most 100 rows with a next cursor, `data` is an array and `next` is null on the last page, limits outside 1..200 are refused", async () => {
    const { posting } = await bankSkippedFeeOwed();
    const original = posting.id as string;
    const clones = await clonePosting(original, 500);
    try {
      expect(clones).toHaveLength(500);
      const expected = [original, ...clones];
      const client = await finance();

      const first = await client.get(LIST);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(Array.isArray(first.body.data)).toBe(true);
      expect(
        (first.body.data as Row[]).length,
        "default page size",
      ).toBeLessThanOrEqual(100);
      expect(first.body.next, "more rows follow").toEqual(expect.any(String));

      const seen: string[] = [];
      let after: string | null = null;
      let pages = 0;
      do {
        const url: string =
          after === null
            ? `${LIST}?limit=200`
            : `${LIST}?limit=200&after=${encodeURIComponent(after)}`;
        const res = await client.get(url);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const rows = res.body.data as Row[];
        expect(Array.isArray(rows)).toBe(true);
        expect(rows.length).toBeLessThanOrEqual(200);
        seen.push(...rows.map((row) => row.postingId as string));
        after = (res.body.next ?? null) as string | null;
        pages += 1;
        expect(pages, "the cursor terminates").toBeLessThan(50);
      } while (after !== null);

      expect(new Set(seen).size, "no row twice").toBe(seen.length);
      expect(seen.length).toBeGreaterThanOrEqual(501);
      expect(
        expected.filter((id) => !seen.includes(id)),
        "every one of the 501 cases is reachable",
      ).toEqual([]);

      for (const bad of ["0", "201", "-1", "abc"]) {
        const res = await client.get(`${LIST}?limit=${bad}`);
        expect(res.status, `limit=${bad}`).toBeGreaterThanOrEqual(400);
        expect(res.status, `limit=${bad}`).toBeLessThan(500);
      }
    } finally {
      await deletePostings(clones);
    }
  });
});
