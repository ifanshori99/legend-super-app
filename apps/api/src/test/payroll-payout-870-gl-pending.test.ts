// Second-opinion finding legend-2aspe (P1): a payout settled while the
// `payroll.locked` journal has not been consumed yet must not be dropped.
//
// Decision (final): with accounting active and the `payroll.locked` event
// still waiting in the outbox (the consumer runs separately from the lock), the
// settlement is stored as PENDING (posting kind `settle_pending`), never as the
// final `settle_skipped`. When the locked journal posts through the GL
// consumer the pending settle resolves idempotently: cash/bank is credited
// exactly the net, the salaries-payable account (2103) ends at 0, no duplicate
// journal, and running settle or the consumer again adds nothing.
// `settle_skipped` stays only for a payroll locked with accounting OFF (no
// locked journal and no locked event waiting): that is the existing test
// `[settle-skipped]` in payroll-payout-gl.test.ts, repeated here as a control.
//
// Assumptions (the spec does not say how "accounting active, event pending" is
// told apart from "accounting off"):
// - The fixture world is a legal entity with a provisioned chart (accounting
//   active). "Event pending" is modelled by an unprocessed `payroll.locked`
//   row in `domain_event_outbox` for the run, exactly what the real lock leaves
//   behind. A run with no such row and no locked journal is the accounting-off
//   case.
// - After resolution the posting row is no longer pending; it is asserted only
//   as "not settle_pending / not settle_skipped" through the money outcome,
//   plus the kind check below.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import * as glService from "../services/payroll-payout-gl.service.ts";
import {
  ANDI,
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
  netOf,
  runTotals,
  uploadEvidence,
  type Row,
  type Slip,
} from "./payroll-payout-fixtures.ts";

const { settleBatchPayouts } = glService;

const W = installPayoutWorld("870gl");
const tenantId = () => W.tenantId;

const settle = (batchId: string, by = APP2) =>
  W.inTx((tx) => settleBatchPayouts(tx, actorOf(by), batchId));

/** The `payroll.locked` envelope the lock would have produced (same shape the consumer reads). */
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

/** The lock happened, the consumer has not run yet: the event sits in the outbox. */
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
  return event;
}

/** Net balance (credit - debit) and credit total of a GL account of the PT, all journals. */
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

/** Cash run, approved, handed over before the locked journal exists. */
async function cashHandedOverBeforeLockedJournal(net = 1_000_000) {
  const slips = [cash(CASHIER, net)];
  const runId = await W.seedRun(slips);
  const event = await queueLockedEvent(runId, slips);
  const batchId = await W.approvedBatch(runId, "cash");
  const items = await W.itemsOf(batchId);
  await W.handover(
    batchId,
    items.map((i) => i.id as string),
    APP2,
  );
  return { runId, batchId, slips, event, net };
}

describe("legend-2aspe: settle before the payroll.locked journal is consumed", () => {
  it("[2aspe-pending-stored] cash handed over while the locked event is still queued: the settlement is stored as settle_pending, not final settle_skipped, and no journal exists yet", async () => {
    const { batchId } = await cashHandedOverBeforeLockedJournal();

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle_pending");
    expect(await W.journalByKey(postings[0]!.journal_key as string)).toBe(
      undefined,
    );
  });

  it("[2aspe-pending-resolves] after the locked journal posts, the cash credit is exactly the net, 2103 ends at 0, nothing is posted twice, and replays add nothing", async () => {
    const before = {
      cash: await account("1102"),
      payable: await account("2103"),
    };
    const { runId, batchId, slips, event, net } =
      await cashHandedOverBeforeLockedJournal(1_000_000);

    // The consumer finally runs: the lock journal posts (Dr expense / Cr 2103).
    const locked = await W.deliverGl(event);
    expect(locked.status).toBe("posted");
    // The run-level paid event is skipped by design (settled per item).
    await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

    expect((await account("1102")).credit - before.cash.credit).toBe(net);
    expect(
      (await account("2103")).balance - before.payable.balance,
      "salaries payable is fully paid down (this run's lock credit is cancelled)",
    ).toBe(0);

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle");
    const journal = await W.journalByKey(postings[0]!.journal_key as string);
    expect(journal).toEqual({
      "2103": { debit: net, credit: 0 },
      "1102": { debit: 0, credit: net },
    });
    for (const item of await W.itemsOf(batchId))
      expect(item.gl_posting_id).toBe(postings[0]!.id);

    // Replays: settle again (one by one and together) and the same event again.
    await settle(batchId);
    await Promise.all([settle(batchId), settle(batchId, APP3)]);
    await W.deliverGl(event);
    expect(await W.countJournals(postings[0]!.journal_key as string)).toBe(1);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    expect((await account("1102")).credit - before.cash.credit).toBe(net);
    expect((await account("2103")).balance - before.payable.balance).toBe(0);
  });

  it("[2aspe-pending-resolves-bank] bank transfers confirmed before the locked journal: the source bank is credited exactly the net once the lock posts, and 2103 ends at 0", async () => {
    const before = {
      bank: await account("1103"),
      payable: await account("2103"),
    };
    const slips = [bank(BUDI, 4_250_000), bank(ANDI, 5_000_001)];
    const runId = await W.seedRun(slips);
    const event = await queueLockedEvent(runId, slips);
    const batchId = await W.exportedBatch(runId);
    const items = await W.itemsOf(batchId);
    await W.confirm(batchId, W.succeedItems(batchId, items));

    await W.deliverGl(event);
    await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

    const net = netOf(slips);
    const [posting] = await W.postingsOf(batchId);
    expect(
      await W.journalByKey(`payroll-payout:${posting!.item_set_hash}`),
    ).toEqual({
      "2103": { debit: net, credit: 0 },
      "1103": { debit: 0, credit: net },
    });
    expect((await account("2103")).balance - before.payable.balance).toBe(0);
    // Credits to the bank are the net plus the PT-borne bank fee journal only.
    expect((await account("1103")).credit - before.bank.credit).toBe(
      net + 2 * 5_000,
    );

    await settle(batchId);
    await W.deliverGl(event);
    expect(
      await W.countJournals(`payroll-payout:${posting!.item_set_hash}`),
    ).toBe(1);
    expect((await account("1103")).credit - before.bank.credit).toBe(
      net + 2 * 5_000,
    );
  });

  it("[2aspe-skipped-stays-when-accounting-off] control: no locked journal and no locked event waiting (accounting switched on after the lock) stays the final settle_skipped; nothing resolves it later", async () => {
    const slips = [cash(CASHIER, 700_000)];
    const runId = await W.seedRun(slips);
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    await W.handover(
      batchId,
      items.map((i) => i.id as string),
      APP2,
    );

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle_skipped");
    await settle(batchId);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
  });

  it("[2aspe-control-lock-first] control: the locked journal posted before the confirmation settles immediately as settle, one journal", async () => {
    const slips = [cash(CASHIER, 900_000)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    await W.handover(
      batchId,
      items.map((i) => i.id as string),
      APP2,
    );

    const [posting] = await W.postingsOf(batchId);
    expect(posting!.kind).toBe("settle");
    expect(
      await W.journalByKey(`payroll-payout:${posting!.item_set_hash}`),
    ).toEqual({
      "2103": { debit: 900_000, credit: 0 },
      "1102": { debit: 0, credit: 900_000 },
    });
  });
});

// ---------------------------------------------------------------------------
// Review round 1, F1 (P2): a pending settlement must not stay pending forever.
//
// Scenario: accounting is on, the worker is behind (the `payroll.locked` event
// waits in the outbox), a bank batch is confirmed => `settle_pending`. Finance
// then deactivates the company bank account. When the consumer finally posts
// the lock journal (2103 opens) the pending settle has to resolve with the
// account the money actually left from (the frozen source of the batch), even
// though that account is inactive now and even though the configured source
// moved to another account. Money already left that account: the GL must show
// it, and 2103 must not stay open.
//
// Assumption: "frozen source" = the account the settle used when the batch
// was confirmed (the same one the existing [overpaid-settled-account] and
// [settled-account] tests rely on); here the config is moved to a second
// account (GL 1101) and the first (GL 1103) is deactivated before the
// consumer runs.
// ---------------------------------------------------------------------------

/** Config moves to account B (GL 1101), account A (the settle source) is deactivated. Returns the restore. */
async function moveSourceAndDeactivateA() {
  const [config] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [tenantId(), W.entityId()],
  );
  const a = config!.id as string;
  const [b] = await W.rowsOf(
    `INSERT INTO bank_accounts
       (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
        account_number_hmac, account_number_last4, account_number_key_version,
        gl_account_id, created_by)
     SELECT $1, $2, 'BCA', 'Rekening Baru 870', '\\x00', $3, '1111', 1, id, 'payout-870-gl-pending-test'
       FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1101'
     RETURNING id`,
    [tenantId(), W.entityId(), "d".repeat(64)],
  );
  const apply = (sourceId: string, aActive: boolean) =>
    W.asTenant(async (c) => {
      await c.query(
        `UPDATE payroll_payout_configs SET manual_source_bank_account_id = $3
          WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenantId(), W.entityId(), sourceId],
      );
      await c.query(`UPDATE bank_accounts SET is_active = $2 WHERE id = $1`, [
        a,
        aActive,
      ]);
    }, true);
  await apply(b!.id as string, false);
  return () => apply(a, true);
}

describe("review F1: pending settlement resolves with the frozen source account", () => {
  it("[f1-pending-resolves-with-inactive-frozen-source] bank confirmed while the lock is queued, source account deactivated (config moved), then the consumer posts the lock: the settle still resolves, credit goes to the frozen account (1103), 1101 is untouched, 2103 ends at 0", async () => {
    const before = {
      a: await account("1103"),
      b: await account("1101"),
      payable: await account("2103"),
    };
    const slips = [bank(BUDI, 4_250_000), bank(ANDI, 5_000_001)];
    const runId = await W.seedRun(slips);
    const event = await queueLockedEvent(runId, slips);
    const batchId = await W.exportedBatch(runId);
    const items = await W.itemsOf(batchId);
    await W.confirm(batchId, W.succeedItems(batchId, items));
    const [pending] = await W.postingsOf(batchId);
    expect(pending!.kind, "premise: stored as pending").toBe("settle_pending");

    const restore = await moveSourceAndDeactivateA();
    try {
      await W.deliverGl(event);
      await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));
    } finally {
      await restore();
    }

    const net = netOf(slips);
    const postings = await W.postingsOf(batchId);
    expect(
      postings.some((p) => p.kind === "settle_pending"),
      "no posting stays pending after the lock journal exists",
    ).toBe(false);
    const settle = postings.find((p) => p.kind === "settle");
    expect(settle, "the settle posting resolved").toBeDefined();
    expect(
      await W.journalByKey(`payroll-payout:${settle!.item_set_hash}`),
    ).toEqual({
      "2103": { debit: net, credit: 0 },
      "1103": { debit: 0, credit: net },
    });
    expect(
      (await account("1101")).credit - before.b.credit,
      "the new account never paid this money",
    ).toBe(0);
    expect(
      (await account("2103")).balance - before.payable.balance,
      "salaries payable is not left open",
    ).toBe(0);
    expect(
      (await account("1103")).credit - before.a.credit,
    ).toBeGreaterThanOrEqual(net);
  });
});

// ---------------------------------------------------------------------------
// Review round 1, F2 (P2): overpaid recorded while the lock journal is pending.
//
// Scenario: payroll.locked is still in the outbox (accounting on, no locked
// journal). Recording an overpaid item would journal only the fee, and the
// second transfer's net would never reach the GL (bank overstated). Decision:
// refuse 409 `PAYOUT_LOCK_JOURNAL_PENDING` (Indonesian message) until the lock
// journal is posted; then it works.
// ---------------------------------------------------------------------------

const idOf = (row: Row) => row.id as string;
const recordOverpaid = (itemId: string, batchId: string, by = APP) =>
  W.inTx((tx) =>
    (
      glService as unknown as {
        recordOverpaidItem: (...args: unknown[]) => Promise<unknown>;
      }
    ).recordOverpaidItem(
      tx,
      actorOf(by),
      itemId,
      {
        evidenceKey: uploadEvidence(batchId, "mutasi-bank.pdf"),
        note: "Mutasi bank menunjukkan transfer kedua untuk slip yang sama",
      },
      W.proofs(),
    ),
  );

/**
 * Budi's first transfer is resolved failed, a follow-up batch pays him, then
 * the first one turns out to have arrived (overpaid candidate). The locked
 * event is queued the whole time (never consumed).
 */
async function lateDoublePaymentLockPending() {
  const slips = [
    bank(BUDI, 4_250_000),
    bank(SITI, 3_100_500),
    bank(ANDI, 5_000_001),
  ];
  const runId = await W.seedRun(slips);
  const event = await queueLockedEvent(runId, slips);
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
  return { runId, batchId, budiFirst, event, slips };
}

describe("review F2: overpaid while the lock journal is still pending", () => {
  it("[f2-overpaid-refused-lock-pending] recording an overpaid item while payroll.locked is still queued is refused 409 PAYOUT_LOCK_JOURNAL_PENDING (Indonesian message): the item stays failed and no journal is written", async () => {
    const { batchId, budiFirst } = await lateDoublePaymentLockPending();
    const itemId = idOf(budiFirst);

    const error = await W.httpFailure(recordOverpaid(itemId, batchId));
    expect(error, "the call must be refused").not.toBeNull();
    expect(error!.status).toBe(409);
    expect(error!.code).toBe("PAYOUT_LOCK_JOURNAL_PENDING");
    expect(error!.message).toMatch(/jurnal kunci/i);
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("failed");
    expect(await W.countJournals(`%${itemId}%`)).toBe(0);
  });

  it("[f2-overpaid-after-lock-posted] control: once the lock journal is posted through the consumer, the same overpaid item is recorded", async () => {
    const { runId, batchId, budiFirst, event, slips } =
      await lateDoublePaymentLockPending();
    await W.deliverGl(event);
    await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

    await recordOverpaid(idOf(budiFirst), batchId);

    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("overpaid");
    expect(
      await W.countJournals(`payroll-payout-overpaid:${idOf(budiFirst)}`),
    ).toBe(1);
  });
});
