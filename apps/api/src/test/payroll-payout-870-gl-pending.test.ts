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
import { settleBatchPayouts } from "../services/payroll-payout-gl.service.ts";
import {
  ANDI,
  APP2,
  APP3,
  BUDI,
  CASHIER,
  actorOf,
  bank,
  cash,
  installPayoutWorld,
  netOf,
  runTotals,
  type Slip,
} from "./payroll-payout-fixtures.ts";

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
