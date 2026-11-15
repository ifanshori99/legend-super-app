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
import { createUlid, userIdSchema } from "@starter/shared/core";
import { payrollLocked } from "@starter/shared/hris/payroll";
import { db } from "../db/index.ts";
import { replaceAccountMappingsForEntity } from "../services/accounting-accounts.service.ts";
import { appendOutbox, consumeOutbox } from "../services/core-outbox.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
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

// ---------------------------------------------------------------------------
// Second-opinion 870 follow-up, F1 (P1, legend-2aspe): accounting switched off
// between the handover and the lock consumer.
//
// Scenario: accounting is on, the `payroll.locked` outbox event is not consumed
// yet, a cash handover is confirmed => `settle_pending`. THEN the accounting
// module is switched off (tenant feature flags, the same switch
// payroll-gl-consumer.test.ts uses). The REAL consumer path (`consumeOutbox`
// with the GL consumer as callback, like the worker) then handles the locked
// event. Money already left: the lock journal must still post and the pending
// settle must resolve to `settle` (cash credited exactly the net, 2103 net zero
// for the run). Switching accounting on again and consuming/replaying adds no
// journal. The flag still decides NEW payroll: with no pending settlement for
// the run the locked event stays `ignored` and posts nothing (control).
//
// Assumptions: the module switch is `tenants.feature_flags.modules` without
// "accounting"; the flags are restored in `finally`. The outbox row is created
// through `appendOutbox` (destination `cloud-sync`, like the real lock).
// ---------------------------------------------------------------------------

const CONSUME_NOW = new Date("2026-11-30T03:00:00Z");

async function queueLockedViaOutbox(runId: string, slips: Slip[]) {
  const event = lockedEnvelope(runId, slips);
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

describe("second-opinion F1 (legend-2aspe): accounting switched off before the lock consumer runs", () => {
  it("[so-f1-pending-survives-accounting-off] pending settle + accounting switched off + real consumer: lock journal posts, pending resolves to settle, cash credited exactly the net, 2103 net zero; switching on and replaying adds nothing", async () => {
    const before = {
      cash: await account("1102"),
      payable: await account("2103"),
    };
    const slips = [cash(CASHIER, 1_000_000)];
    const runId = await W.seedRun(slips);
    const { outboxId, event } = await queueLockedViaOutbox(runId, slips);
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    await W.handover(
      batchId,
      items.map((i) => i.id as string),
      APP2,
    );
    expect(
      (await W.postingsOf(batchId))[0]!.kind,
      "premise: stored as pending",
    ).toBe("settle_pending");

    const outcome = await withAccountingOff(() => consumeLocked(outboxId));
    expect(
      outcome.result?.status,
      "money already left: the locked event must not be dropped as ignored",
    ).toBe("posted");

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind, "pending resolved").toBe("settle");
    expect((await account("1102")).credit - before.cash.credit).toBe(1_000_000);
    expect(
      (await account("2103")).balance - before.payable.balance,
      "salaries payable is net zero for the run",
    ).toBe(0);

    // Accounting on again: consume and replay add no journal and no posting.
    const journals = await journalCountOfEntity();
    await consumeLocked(outboxId);
    await W.deliverGl(event);
    expect(await journalCountOfEntity()).toBe(journals);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    expect((await account("1102")).credit - before.cash.credit).toBe(1_000_000);
    expect((await account("2103")).balance - before.payable.balance).toBe(0);
  });

  it("[so-f1-control-off-without-pending-ignored] control: accounting off and NO pending settlement for the run: the locked event is ignored and nothing is posted", async () => {
    const slips = [cash(CASHIER, 600_000)];
    const runId = await W.seedRun(slips);
    const { outboxId } = await queueLockedViaOutbox(runId, slips);
    const journals = await journalCountOfEntity();

    const outcome = await withAccountingOff(() => consumeLocked(outboxId));

    expect(outcome.result?.status).toBe("ignored");
    expect(await journalCountOfEntity()).toBe(journals);
  });
});

// ---------------------------------------------------------------------------
// Second-opinion 870 follow-up, F3 (P2, legend-cnpap): a pending cash
// settlement follows the cash account of the moment the money was handed over,
// not a petty_cash mapping changed afterwards.
//
// Scenario: `petty_cash` -> cash account A (1102). Cash handover of Rp1.000.000
// is confirmed while the lock event is still queued => `settle_pending`. Before
// the consumer runs, finance replaces the `petty_cash` mapping with another
// active cash account B. After the lock consumer runs, the credit of exactly
// the net is on A, B has no lines, the posting is `settle`, and a second
// consumer run adds no journal. The mapping is restored in `finally`.
// ---------------------------------------------------------------------------

describe("second-opinion F3 (legend-cnpap): pending cash settlement keeps the cash account of the handover", () => {
  it("[so-f3-pending-cash-keeps-source-account] mapping petty_cash A -> B before the lock consumer: credit lands on A, B untouched, posting settle, a second run adds nothing", async () => {
    const slips = [cash(CASHIER, 1_000_000)];
    const runId = await W.seedRun(slips);
    const { outboxId, event } = await queueLockedViaOutbox(runId, slips);
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    await W.handover(
      batchId,
      items.map((i) => i.id as string),
      APP2,
    );
    expect(
      (await W.postingsOf(batchId))[0]!.kind,
      "premise: stored as pending",
    ).toBe("settle_pending");

    const mappings = (
      await W.rowsOf(
        `SELECT role, account_id FROM account_mappings WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [tenantId(), W.entityId()],
      )
    ).map((m) => ({
      role: m.role as string,
      accountId: m.account_id as string,
    }));
    expect(mappings.some((m) => m.role === "petty_cash")).toBe(true);
    const [b] = await W.rowsOf(
      `INSERT INTO chart_of_accounts
         (tenant_id, legal_entity_id, code, name, type, report_group, parent_id, is_active)
       VALUES ($1, $2, '1109', 'Kas Kecil Baru', 'asset', 'cash_and_equivalents', NULL, true)
       RETURNING id`,
      [tenantId(), W.entityId()],
    );
    const actorId = userIdSchema.parse(randomUUID());
    await W.owner.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Finance 870', $2)`,
      [actorId, `${actorId}@example.test`],
    );
    const replace = (list: { role: string; accountId: string }[]) =>
      replaceAccountMappingsForEntity(
        W.scope(),
        W.entityId(),
        { mappings: list } as Parameters<
          typeof replaceAccountMappingsForEntity
        >[2],
        actorId,
      );
    const beforeA = await account("1102");
    await replace(
      mappings.map((m) =>
        m.role === "petty_cash" ? { ...m, accountId: b!.id as string } : m,
      ),
    );
    try {
      const first = await consumeLocked(outboxId);
      expect(first.result?.status).toBe("posted");
      const journals = await journalCountOfEntity();
      await consumeLocked(outboxId);
      await W.deliverGl(event);
      expect(
        await journalCountOfEntity(),
        "no journal added by the second run",
      ).toBe(journals);
    } finally {
      await replace(mappings);
    }

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle");
    expect(
      (await account("1102")).credit - beforeA.credit,
      "the cash that left (account A) is credited exactly the net",
    ).toBe(1_000_000);
    expect(
      await account("1109"),
      "the new cash account never paid this money",
    ).toEqual({ debit: 0, credit: 0, balance: 0 });
  });
});

// ---------------------------------------------------------------------------
// Architect review round 2 (legend-2aspe follow-up), brief-873-round2.
//
// R1 (P2): the SECOND batch of the same run, handed over after accounting was
// switched off, must also be stored as `settle_pending` while the run already
// has a pending settle (the consumer will post the run's lock journal and
// resolve A; B left open would leave 2103 open and cash overstated). The
// fail-closed source checks still apply to that pending-by-run case.
// R6 (P3): a pending cash settlement needs its frozen source: an inactive or
// header (parent) petty_cash account is refused 409 PAYOUT_SOURCE_ACCOUNT_MISSING
// at handover, nothing recorded.
// R3b (P3): a pending CASH posting whose frozen account is gone (NULL) must not
// fall back to today's mapping: it stays unresolved (fail closed).
//
// Assumptions: "same run, second batch" is modelled with a MIXED run (cash batch
// A, then bank batch B) because the fixtures create one batch per channel;
// the rule is per run, not per channel. Batch B is created and exported while
// accounting is still on (only the confirmation happens with accounting off).
// For R3b the consumer's own error handling is not specified, so the test
// asserts only the outcome: the posting is not resolved to `settle` and the
// cash account is not credited.
// ---------------------------------------------------------------------------

async function currentSourceBankId() {
  const [config] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [tenantId(), W.entityId()],
  );
  return config!.id as string;
}
const setBankActive = (id: string, active: boolean) =>
  W.asTenant(
    (c) =>
      c.query(`UPDATE bank_accounts SET is_active = $2 WHERE id = $1`, [
        id,
        active,
      ]),
    true,
  );

/** Account `code` becomes inactive or a header (it gets a child). Returns the restore. */
async function breakGlAccount(code: string, how: "inactive" | "header") {
  if (how === "inactive") {
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
  const [child] = await W.rowsOf(
    `INSERT INTO chart_of_accounts
       (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
     SELECT tenant_id, legal_entity_id, $3 || '9', 'Anak Uji', type, report_group, id
       FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $3
     RETURNING id`,
    [tenantId(), W.entityId(), code],
  );
  return () =>
    W.asTenant(
      (c) =>
        c.query(`DELETE FROM chart_of_accounts WHERE id = $1`, [child!.id]),
      true,
    );
}

/** Mixed run: cash batch A handed over while the lock is queued (pending); bank batch B approved and exported. */
async function pendingCashThenExportedBank() {
  const slips = [cash(CASHIER, 1_000_000), bank(BUDI, 2_000_000)];
  const runId = await W.seedRun(slips);
  const { outboxId, event } = await queueLockedViaOutbox(runId, slips);
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

describe("round 2 R1: second batch of the run after accounting was switched off", () => {
  it("[r2-r1-second-batch-pending-accounting-off] A pending, accounting off, B confirmed: B is settle_pending (not skipped); the consumer resolves both; cash and bank credited exactly their nets, 2103 net zero", async () => {
    const before = {
      cash: await account("1102"),
      payable: await account("2103"),
    };
    const { runId, slips, outboxId, event, batchA, batchB } =
      await pendingCashThenExportedBank();
    const itemsB = await W.itemsOf(batchB);

    const outcome = await withAccountingOff(async () => {
      await W.confirm(batchB, W.succeedItems(batchB, itemsB));
      const kindOfB = (await W.postingsOf(batchB)).map((p) => p.kind);
      expect(
        kindOfB,
        "B must wait for the run's lock journal like A, not be recorded as skipped",
      ).toEqual(["settle_pending"]);
      return consumeLocked(outboxId);
    });
    expect(outcome.result?.status).toBe("posted");
    await W.deliverGl(W.paidEnvelope(runId, slips, { settledPerItem: true }));

    const [postingA] = await W.postingsOf(batchA);
    const [postingB] = await W.postingsOf(batchB);
    expect(postingA!.kind).toBe("settle");
    expect(postingB!.kind).toBe("settle");
    expect(await W.journalByKey(postingA!.journal_key as string)).toEqual({
      "2103": { debit: 1_000_000, credit: 0 },
      "1102": { debit: 0, credit: 1_000_000 },
    });
    expect(await W.journalByKey(postingB!.journal_key as string)).toEqual({
      "2103": { debit: 2_000_000, credit: 0 },
      "1103": { debit: 0, credit: 2_000_000 },
    });
    expect((await account("1102")).credit - before.cash.credit).toBe(1_000_000);
    expect(
      (await account("2103")).balance - before.payable.balance,
      "2103 is net zero for the run: B is not left open",
    ).toBe(0);

    // Replays add nothing.
    const journals = await journalCountOfEntity();
    await consumeLocked(outboxId);
    await W.deliverGl(event);
    expect(await journalCountOfEntity()).toBe(journals);
  });

  it("[r2-r1-second-batch-source-still-checked] A pending, accounting off, B's source bank account inactive: the confirmation is refused 409 PAYOUT_SOURCE_ACCOUNT_MISSING and nothing is recorded (pending needs its frozen source)", async () => {
    const { batchB } = await pendingCashThenExportedBank();
    const itemsB = await W.itemsOf(batchB);
    const sourceId = await currentSourceBankId();

    await setBankActive(sourceId, false);
    try {
      const error = await withAccountingOff(() =>
        W.httpFailure(W.confirm(batchB, W.succeedItems(batchB, itemsB))),
      );
      expect(error, "the confirmation must be refused").not.toBeNull();
      expect(error!.status).toBe(409);
      expect(error!.code).toBe("PAYOUT_SOURCE_ACCOUNT_MISSING");
    } finally {
      await setBankActive(sourceId, true);
    }
    expect(await W.postingsOf(batchB)).toHaveLength(0);
    for (const item of await W.itemsOf(batchB))
      expect(item.status, "no item was recorded as paid").toBe("exported");
  });
});

describe("round 2 R6: frozen cash account must be active and postable at handover", () => {
  for (const how of ["inactive", "header"] as const) {
    it(`[r2-r6-cash-account-${how}-refused] petty_cash mapped to a ${how} account while the lock is queued: the handover is refused 409 PAYOUT_SOURCE_ACCOUNT_MISSING and nothing is recorded; once fixed it is pending as usual`, async () => {
      const slips = [cash(CASHIER, 800_000)];
      const runId = await W.seedRun(slips);
      await queueLockedEvent(runId, slips);
      const batchId = await W.approvedBatch(runId, "cash");
      const itemIds = (await W.itemsOf(batchId)).map((i) => i.id as string);

      const restore = await breakGlAccount("1102", how);
      try {
        const error = await W.httpFailure(W.handover(batchId, itemIds, APP2));
        expect(error, "the handover must be refused").not.toBeNull();
        expect(error!.status).toBe(409);
        expect(error!.code).toBe("PAYOUT_SOURCE_ACCOUNT_MISSING");
        expect(await W.postingsOf(batchId)).toHaveLength(0);
        for (const item of await W.itemsOf(batchId))
          expect(item.status, "no item was handed over").not.toBe("paid");
      } finally {
        await restore();
      }

      await W.handover(batchId, itemIds, APP2);
      const postings = await W.postingsOf(batchId);
      expect(postings).toHaveLength(1);
      expect(postings[0]!.kind).toBe("settle_pending");
    });
  }
});

describe("round 2 R3b: pending cash posting without a frozen account fails closed", () => {
  it("[r2-r3b-null-frozen-cash-no-mapping-fallback] a pending cash posting whose frozen source account is NULL is not resolved with today's petty_cash mapping: it stays unresolved and cash is not credited", async () => {
    const before = { cash: await account("1102") };
    const slips = [cash(CASHIER, 1_000_000)];
    const runId = await W.seedRun(slips);
    const { outboxId } = await queueLockedViaOutbox(runId, slips);
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    await W.handover(
      batchId,
      items.map((i) => i.id as string),
      APP2,
    );
    const [pending] = await W.postingsOf(batchId);
    expect(pending!.kind, "premise: stored as pending").toBe("settle_pending");
    // A pending posting from before the freeze (or lost account): triggers off.
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET source_gl_account_id = NULL
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId(), pending!.id],
        ),
      true,
    );

    // The consumer may fail or leave it pending; either way it must not settle.
    await consumeLocked(outboxId).catch(() => undefined);

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(
      postings[0]!.kind,
      "no silent fallback to the current petty_cash mapping",
    ).toBe("settle_pending");
    expect(
      (await account("1102")).credit - before.cash.credit,
      "cash is not credited from an account nobody froze",
    ).toBe(0);
  });
});
