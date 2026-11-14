// Payout GL posting (bead legend-658 card wnkep.5; design
// docs/design/payroll-disbursement.md 4.6, 6 R9/R10, 7.7-7.9, 8; context
// docs/briefs/658-payout-gl-context.md). Written fail-first from the design,
// not from the implementation: none of the interfaces below exist yet.
//
// Rules proven here (money: nobody is paid twice, the PT does not lose):
// - R10 the ledger is credited exactly once: the sum of credits to the source
//   account equals the sum of net pay of the paid slips; a double or concurrent
//   confirmation, and any replay of settle, posts nothing more.
// - R9 the bank fee is borne by the PT: it is only Dr bank charges / Cr the
//   source account, never subtracted from the salary journal.
// - A return reverses exactly once, keyed by the item.
// - `payroll.paid` with `settledPerItem: true` posts nothing at run level; a
//   legacy `payroll.paid` (run without batches) still posts as before.
// - Another tenant is untouched.
//
// Interfaces under test (names chosen here, the engineer may rename them in
// this file and in payroll-payout-fixtures.ts only):
//   services/payroll-payout-gl.service.ts
//     settleBatchPayouts(tx, actor, batchId)
//       Settles every `succeeded` item of the batch whose gl_posting_id is NULL
//       under the batch advisory lock; idempotent. Confirm, cash handover and
//       return call it themselves; it is also exported for replay.
//   services/payroll-payout-manual.service.ts
//     returnManualItems(tx, actor, batchId,
//       { itemIds, evidenceKey, note })
//       Funds came back after success (7.8). Same two-person rule as
//       resolveManualItems: two different non-requesters with the same outcome
//       and evidence; the second call moves the item `succeeded -> returned`
//       and posts the return journal.
//   table payroll_payout_gl_postings (migration 0348), columns: id, tenant_id,
//     batch_id, kind ('settle' | 'settle_skipped' | 'return' | 'overpaid'),
//     item_set_hash, journal_key, total_encrypted, posted_at;
//     payroll_disbursement_items.gl_posting_id.
//   journal keys: settle `payroll-payout:<item_set_hash>` (journal_key equals
//     journal_entries.idempotency_key), fee `payroll-payout-fee:<item_set_hash>`,
//     return `payroll-payout-return:<itemId>`.
//   GL accounts (standard chart): salaries_payable 2103, manual source bank
//     account 1103, petty cash 1102, role `bank_charges` -> 8101.
//   event payroll.paid payload gets `settledPerItem: boolean` (optional,
//     absent = false).
//
// Assumptions (design silent, stated so they can be contested):
// - The manual-channel fee is Rp5.000 per item (founder Q15, "PT tanggung
//   Rp5.000"), stored per item at export and journaled for `succeeded` items
//   only.
// - Run `paid_by` is the last approver of the batch (CTO 14 Nov); the person
//   who confirmed is stored in items.confirmed_by.
// - A failed settle rolls everything back, so only the visible end state is
//   asserted (no half journal).
// - The consumer answers a `settledPerItem: true` event with any status other
//   than "posted" (skipped or ignored); only "no entry posted" is asserted.
// - The existing assertion in payroll-payout-manual.test.ts that no
//   `payroll.paid` leaves the outbox ("belongs to card .5") must be inverted by
//   the engineer: this card emits it.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { settleBatchPayouts } from "../services/payroll-payout-gl.service.ts";
import {
  confirmManualItems,
  returnManualItems,
} from "../services/payroll-payout-manual.service.ts";
import {
  ANDI,
  APP,
  APP2,
  APP3,
  BUDI,
  CASHIER,
  REQ,
  SITI,
  actorOf,
  bank,
  cash,
  uploadEvidence,
  installPayoutWorld,
  netOf,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("gl");

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const FEE = 5_000;
const slipsOf = () => [
  bank(BUDI, BUDI_NET),
  bank(SITI, SITI_NET),
  bank(ANDI, ANDI_NET),
];

const settle = (batchId: string, by = APP2) =>
  W.inTx((tx) => settleBatchPayouts(tx, actorOf(by), batchId));
const returnItems = (batchId: string, itemIds: string[], by: string) =>
  W.inTx((tx) =>
    returnManualItems(
      tx,
      actorOf(by),
      batchId,
      {
        itemIds,
        evidenceKey: uploadEvidence(batchId, "dana-kembali.pdf"),
        note: "Bank mengembalikan dana, rekening tujuan ditutup",
      } as never,
      W.proofs(),
    ),
  );
const idOf = (row: Row) => row.id as string;

/** A locked run with an exported manual batch, ready to confirm. */
async function exportedRun(
  slips = slipsOf(),
  options: { lockedJournal?: boolean } = {},
) {
  const runId = await W.seedRun(slips);
  if (options.lockedJournal !== false) await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  return { runId, batchId, items, slips };
}

/** The settle journal of a posting row, summed by GL code. */
async function settleJournal(posting: Row) {
  expect(posting.kind).toBe("settle");
  expect(posting.journal_key).toBe(`payroll-payout:${posting.item_set_hash}`);
  const journal = await W.journalByKey(posting.journal_key as string);
  expect(journal, "the settle journal exists").toBeDefined();
  return journal!;
}

describe("settle: the ledger is credited exactly once (R10)", () => {
  it("[settle-sum] confirming every item posts one journal: Dr 2103 = Cr 1103 = sum of net pay, items linked to it", async () => {
    const { batchId, items, slips } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items));

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    const posting = postings[0]!;
    expect(posting.item_set_hash).toMatch(/^[0-9a-f]{64}$/);
    const journal = await settleJournal(posting);
    expect(netOf(slips)).toBe(12_350_501);
    expect(journal).toEqual({
      "2103": { debit: netOf(slips), credit: 0 },
      "1103": { debit: 0, credit: netOf(slips) },
    });

    const linked = await W.itemsOf(batchId);
    expect(linked.filter((i) => i.status === "succeeded")).toHaveLength(3);
    for (const item of linked)
      expect(item.gl_posting_id, "every paid item points at the journal").toBe(
        posting.id,
      );
  });

  it("[settle-run-paid-by] the run turns paid with paid_by = the batch approver; the confirmer stays on the items", async () => {
    const { runId, batchId, items } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items), APP2);
    const run = await W.runRow(runId);
    expect(run.status).toBe("paid");
    expect(run.paid_at).not.toBeNull();
    expect(run.paid_by).toBe(APP);
    for (const item of await W.itemsOf(batchId))
      expect(item.confirmed_by).toBe(APP2);
  });

  it("[settle-paid-event] payroll.paid leaves the outbox once, with settledPerItem true, only when the run is fully paid", async () => {
    const { runId, batchId, items } = await exportedRun();
    const [first, ...rest] = items;
    await W.confirm(batchId, W.succeedItems(batchId, [first!]));
    expect(await W.runRow(runId)).toMatchObject({ status: "locked" });
    expect(await W.paidEventsOf(runId)).toHaveLength(0);

    await W.confirm(batchId, W.succeedItems(batchId, rest));
    expect((await W.runRow(runId)).status).toBe("paid");
    const events = await W.paidEventsOf(runId);
    expect(events).toHaveLength(1);
    const envelope = events[0]!.event as {
      payload: { settledPerItem?: boolean; netIdr: number };
    };
    expect(envelope.payload.settledPerItem).toBe(true);
    expect(envelope.payload.netIdr).toBe(12_350_501);
  });

  it("[settle-partial] items confirmed in two steps post two journals that add up to the net pay, each item once", async () => {
    const { batchId, items } = await exportedRun();
    const budi = items.find((i) => i.employee_id === BUDI.id)!;
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    const andi = items.find((i) => i.employee_id === ANDI.id)!;

    await W.confirm(batchId, W.succeedItems(batchId, [budi, siti]));
    let postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(await settleJournal(postings[0]!)).toEqual({
      "2103": { debit: BUDI_NET + SITI_NET, credit: 0 },
      "1103": { debit: 0, credit: BUDI_NET + SITI_NET },
    });

    await W.confirm(batchId, W.succeedItems(batchId, [andi]));
    postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(2);
    expect(postings[0]!.journal_key).not.toBe(postings[1]!.journal_key);
    expect(await settleJournal(postings[1]!)).toEqual({
      "2103": { debit: ANDI_NET, credit: 0 },
      "1103": { debit: 0, credit: ANDI_NET },
    });
    let credited = 0;
    for (const posting of postings)
      credited += (await settleJournal(posting))["1103"]!.credit;
    expect(credited).toBe(BUDI_NET + SITI_NET + ANDI_NET);

    const linked = await W.itemsOf(batchId);
    expect(linked.map((i) => i.gl_posting_id).sort()).toEqual(
      [postings[0]!.id, postings[0]!.id, postings[1]!.id].sort(),
    );
  });

  it("[settle-cash] a cash handover credits petty cash 1102, never the bank", async () => {
    const slips = [cash(CASHIER, 1_500_000)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const batchId = await W.approvedBatch(runId, "cash");
    const items = await W.itemsOf(batchId);
    await W.handover(batchId, items.map(idOf), APP2);

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(await settleJournal(postings[0]!)).toEqual({
      "2103": { debit: 1_500_000, credit: 0 },
      "1102": { debit: 0, credit: 1_500_000 },
    });
  });
});

describe("replay and double confirmation never double the journal (R10)", () => {
  it("[replay-double-confirm] confirming the same items again is refused and posts nothing", async () => {
    const { batchId, items } = await exportedRun();
    const results = W.succeedItems(batchId, items);
    await W.confirm(batchId, results);
    const before = await W.postingsOf(batchId);
    expect(before).toHaveLength(1);

    await W.expectRefused(W.confirm(batchId, results));
    await W.expectRefused(W.confirm(batchId, results, APP3));

    const after = await W.postingsOf(batchId);
    expect(after.map(idOf)).toEqual(before.map(idOf));
    expect(await settleJournal(after[0]!)).toMatchObject({
      "1103": { credit: 12_350_501 },
    });
  });

  it("[replay-concurrent-confirm] two simultaneous confirmations of the same items: one wins, one posting, one journal", async () => {
    const { batchId, items } = await exportedRun();
    const results = W.succeedItems(batchId, items);
    const outcomes = await Promise.allSettled([
      W.confirm(batchId, results, APP2),
      W.confirm(batchId, results, APP3),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(await settleJournal(postings[0]!)).toEqual({
      "2103": { debit: 12_350_501, credit: 0 },
      "1103": { debit: 0, credit: 12_350_501 },
    });
  });

  it("[replay-settle] calling settle again, one after the other or at the same time, posts nothing new", async () => {
    const { batchId, items } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items));
    const before = await W.postingsOf(batchId);

    await settle(batchId);
    await settle(batchId, APP3);
    await Promise.all([settle(batchId), settle(batchId, APP3)]);

    const after = await W.postingsOf(batchId);
    expect(after.map(idOf)).toEqual(before.map(idOf));
    expect(after).toHaveLength(1);
    expect(await W.countJournals(String(after[0]!.journal_key))).toBe(1);
  });
});

describe("the bank fee is borne by the PT, not the employee (R9)", () => {
  it("[fee-expense-only] the fee of each paid item is Dr bank charges 8101 / Cr 1103 in its own journal; the salary journal and the net pay stay whole", async () => {
    const { batchId, items } = await exportedRun();
    const budi = items.find((i) => i.employee_id === BUDI.id)!;
    const siti = items.find((i) => i.employee_id === SITI.id)!;
    const andi = items.find((i) => i.employee_id === ANDI.id)!;
    // Siti's transfer fails (two people decide): no money left, so no fee.
    await W.confirm(batchId, W.succeedItems(batchId, [budi, andi]));
    await W.resolve(batchId, [idOf(siti)], "failed", APP);
    await W.resolve(batchId, [idOf(siti)], "failed", APP3);

    const [posting] = await W.postingsOf(batchId);
    expect(await settleJournal(posting!)).toEqual({
      "2103": { debit: BUDI_NET + ANDI_NET, credit: 0 },
      "1103": { debit: 0, credit: BUDI_NET + ANDI_NET },
    });
    const fee = await W.journalByKey(
      `payroll-payout-fee:${posting!.item_set_hash}`,
    );
    expect(fee, "a fee journal exists for the paid items").toBeDefined();
    expect(fee).toEqual({
      "8101": { debit: 2 * FEE, credit: 0 },
      "1103": { debit: 0, credit: 2 * FEE },
    });
    expect(fee).not.toHaveProperty("2103");
    expect(
      (await W.itemOfPerson(batchId, SITI)).status,
      "no fee for the failed item",
    ).toBe("failed");
  });

  it("[fee-not-reposted] a replay of settle does not post the fee again", async () => {
    const { batchId, items } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items));
    const [posting] = await W.postingsOf(batchId);
    const key = `payroll-payout-fee:${posting!.item_set_hash}`;
    expect(await W.journalByKey(key)).toEqual({
      "8101": { debit: 3 * FEE, credit: 0 },
      "1103": { debit: 0, credit: 3 * FEE },
    });
    await settle(batchId);
    await settle(batchId, APP3);
    expect(await W.countJournals(key)).toBe(1);
  });
});

describe("a return reverses exactly once (7.8, 8)", () => {
  it("[return-once] Dr 1103 / Cr 2103 for the returned item under its own key; repeating it, or settling again, posts nothing; the run stays paid", async () => {
    const { runId, batchId, items } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items));
    const budi = await W.itemOfPerson(batchId, BUDI);

    await returnItems(batchId, [idOf(budi)], APP);
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("succeeded");
    expect(await W.journalByKey(`payroll-payout-return:${idOf(budi)}`)).toBe(
      undefined,
    );
    await returnItems(batchId, [idOf(budi)], APP3);

    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
    const key = `payroll-payout-return:${idOf(budi)}`;
    expect(await W.journalByKey(key)).toEqual({
      "1103": { debit: BUDI_NET, credit: 0 },
      "2103": { debit: 0, credit: BUDI_NET },
    });

    // Once more, by anyone: the item is no longer `succeeded`.
    await W.expectRefused(returnItems(batchId, [idOf(budi)], APP));
    await W.expectRefused(returnItems(batchId, [idOf(budi)], APP3));
    await settle(batchId);
    await Promise.all([settle(batchId), settle(batchId, APP3)]);
    expect(await W.countJournals(key)).toBe(1);
    // The other two items are untouched and the settle journal stays whole.
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    expect(
      (await W.itemOfPerson(batchId, SITI)).status,
      "other items stay paid",
    ).toBe("succeeded");
    expect((await W.runRow(runId)).status).toBe("paid");
  });

  it("[return-source-account] the return credits the account the settle journal used, even when the config points at another bank account by then", async () => {
    const { batchId, items } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items));
    const budi = await W.itemOfPerson(batchId, BUDI);

    // After the payout, finance moves the source to another bank account
    // whose GL account is 1101 instead of 1103.
    const [config] = await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [W.tenantId, W.entityId()],
    );
    const oldSource = config!.id as string;
    const [newBank] = await W.rowsOf(
      `INSERT INTO bank_accounts
         (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
          account_number_hmac, account_number_last4, account_number_key_version,
          gl_account_id, created_by)
       SELECT $1, $2, 'BCA', 'Rekening Baru', '\\x00', $3, '1111', 1, id, 'payout-gl-test'
         FROM chart_of_accounts
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1101'
       RETURNING id`,
      [W.tenantId, W.entityId(), "d".repeat(64)],
    );
    const setSource = (id: string) =>
      W.asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_payout_configs SET manual_source_bank_account_id = $3
              WHERE tenant_id = $1 AND legal_entity_id = $2`,
            [W.tenantId, W.entityId(), id],
          ),
        true,
      );
    await setSource(newBank!.id as string);
    try {
      await returnItems(batchId, [idOf(budi)], APP);
      await returnItems(batchId, [idOf(budi)], APP3);
    } finally {
      await setSource(oldSource);
    }

    const key = `payroll-payout-return:${idOf(budi)}`;
    expect(await W.journalByKey(key)).toEqual({
      "1103": { debit: BUDI_NET, credit: 0 },
      "2103": { debit: 0, credit: BUDI_NET },
    });
  });

  it("[return-needs-two-people] one person alone (or the requester) cannot return a paid item and nothing is posted", async () => {
    const { batchId, items } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items));
    const siti = await W.itemOfPerson(batchId, SITI);

    await returnItems(batchId, [idOf(siti)], APP);
    await W.expectRefused(returnItems(batchId, [idOf(siti)], APP));
    // The requester of the batch is never one of the two.
    await W.expectRefused(returnItems(batchId, [idOf(siti)], REQ));
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
    expect(await W.countJournals(`payroll-payout-return:${idOf(siti)}`)).toBe(
      0,
    );
  });
});

describe("run-level payroll.paid posts nothing when settled per item (R10)", () => {
  it("[paid-settled-per-item] payroll.paid with settledPerItem true leaves the ledger as the per-item journals made it", async () => {
    const { runId, batchId, items, slips } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items));
    const [posting] = await W.postingsOf(batchId);

    const event = W.paidEnvelope(runId, slips, { settledPerItem: true });
    const first = await W.deliverGl(event);
    const second = await W.deliverGl(event);
    expect(first.status).not.toBe("posted");
    expect(second.status).not.toBe("posted");

    expect(await W.journalByKey(`payroll-gl:paid:${runId}`)).toBe(undefined);
    // Credits to the source account: the settle journal only, Σ net exactly.
    const settled = await settleJournal(posting!);
    expect(settled["1103"]!.credit).toBe(netOf(slips));
    expect(await W.postingsOf(batchId)).toHaveLength(1);
  });

  it("[paid-legacy-still-posts] control: a run without batches keeps the old rule, Dr 2103 / Cr 1103 for the net", async () => {
    const slips = [bank(BUDI, 2_000_000), bank(SITI, 1_000_000)];
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const result = await W.deliverGl(W.paidEnvelope(runId, slips));
    expect(result.status).toBe("posted");
    expect(await W.journalByKey(`payroll-gl:paid:${runId}`)).toEqual({
      "2103": { debit: 3_000_000, credit: 0 },
      "1103": { debit: 0, credit: 3_000_000 },
    });
  });

  it("[settle-skipped] a run without a locked journal (accounting switched on after the lock): items are linked to a settle_skipped posting, no journal, and settle never retries", async () => {
    const { runId, batchId, items } = await exportedRun(slipsOf(), {
      lockedJournal: false,
    });
    await W.confirm(batchId, W.succeedItems(batchId, items));

    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle_skipped");
    expect(await W.journalByKey(postings[0]!.journal_key as string)).toBe(
      undefined,
    );
    for (const item of await W.itemsOf(batchId))
      expect(item.gl_posting_id).toBe(postings[0]!.id);

    await settle(batchId);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    expect((await W.runRow(runId)).status).toBe("paid");
    expect(await W.journalByKey(`payroll-gl:paid:${runId}`)).toBe(undefined);
  });

  it("[settle-skipped-fee] the bank fee is still posted automatically (Dr 8101 / Cr 1103) for a settle without a salary journal, once and only for what was paid", async () => {
    const { batchId, items } = await exportedRun(slipsOf(), {
      lockedJournal: false,
    });
    await W.confirm(batchId, W.succeedItems(batchId, items));

    const [posting] = await W.postingsOf(batchId);
    expect(posting!.kind).toBe("settle_skipped");
    expect(await W.journalByKey(posting!.journal_key as string)).toBe(
      undefined,
    );
    const key = `payroll-payout-fee:${posting!.item_set_hash}`;
    expect(await W.journalByKey(key)).toEqual({
      "8101": { debit: 3 * FEE, credit: 0 },
      "1103": { debit: 0, credit: 3 * FEE },
    });

    await settle(batchId);
    await settle(batchId, APP3);
    expect(await W.countJournals(key)).toBe(1);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
  });

  it("[settle-skipped-fee-no-mapping] without a bank charges mapping the confirmation still succeeds on a settle without a salary journal: no fee journal, nothing blocked", async () => {
    const { runId, batchId, items } = await exportedRun(slipsOf(), {
      lockedJournal: false,
    });
    const mappingWhere = `tenant_id = $1 AND legal_entity_id = $2 AND role = 'bank_charges'`;
    const [mapping] = await W.rowsOf(
      `SELECT account_id FROM account_mappings WHERE ${mappingWhere}`,
      [W.tenantId, W.entityId()],
    );
    expect(mapping, "premise: the fixture maps bank charges").toBeDefined();
    await W.asTenant(
      (c) =>
        c.query(`DELETE FROM account_mappings WHERE ${mappingWhere}`, [
          W.tenantId,
          W.entityId(),
        ]),
      true,
    );
    try {
      await W.confirm(batchId, W.succeedItems(batchId, items));
    } finally {
      await W.asTenant(
        (c) =>
          c.query(
            `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
             VALUES ($1, $2, 'bank_charges', $3)`,
            [W.tenantId, W.entityId(), mapping!.account_id],
          ),
        true,
      );
    }

    const [posting] = await W.postingsOf(batchId);
    expect(posting!.kind).toBe("settle_skipped");
    expect(
      await W.journalByKey(`payroll-payout-fee:${posting!.item_set_hash}`),
    ).toBe(undefined);
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("succeeded");
    expect((await W.runRow(runId)).status).toBe("paid");
  });
});

describe("another tenant is untouched", () => {
  const owner = new Pool({
    connectionString: process.env.STARTER_TEST_DATABASE_URL,
    max: 2,
  });
  const otherTenantId = randomUUID();
  const otherScope = () =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(otherTenantId),
        brandId: null,
        source: "domain",
      }),
      { kind: "tenant" },
    );

  beforeAll(async () => {
    await owner.query(
      `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
       VALUES ($1, $2, 'Uji Payout Tenant Lain', 'lengkap', 'active', 'shared', $3, $4, $5)`,
      [
        otherTenantId,
        `uji-payout-lain-${otherTenantId.slice(0, 8)}`,
        JSON.stringify({ modules: ["accounting"], integrationProviders: [] }),
        JSON.stringify({
          maxOutlets: 50,
          maxActiveEmployees: 10,
          maxDevices: 1,
          aiRequestsPerMonth: 0,
          whatsappCostCapIdr: 0,
          aiCostCapIdr: 0,
          emailCostCapIdr: 0,
        }),
        randomUUID(),
      ],
    );
  });
  afterAll(async () => {
    await owner.end();
  });

  /** Row counts the other tenant can see in the payout and ledger tables. */
  async function visibleToOther(batchId: string) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      // The owner connection bypasses RLS; count as the runtime role.
      await client.query("SET LOCAL ROLE legend_app");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [otherTenantId],
      );
      const count = async (sql: string, params: unknown[] = []) =>
        Number((await client.query(sql, params)).rows[0].n);
      const seen = {
        postings: await count(
          "SELECT count(*)::int AS n FROM payroll_payout_gl_postings",
        ),
        batches: await count(
          "SELECT count(*)::int AS n FROM payroll_disbursement_batches WHERE id = $1",
          [batchId],
        ),
        items: await count(
          "SELECT count(*)::int AS n FROM payroll_disbursement_items WHERE batch_id = $1",
          [batchId],
        ),
        journals: await count(
          "SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key LIKE 'payroll-payout%'",
        ),
      };
      await client.query("ROLLBACK");
      return seen;
    } finally {
      client.release();
    }
  }

  it("[tenant-isolation] settling or confirming a batch id from another tenant is refused, creates nothing for that tenant and changes nothing of ours", async () => {
    const { batchId, items } = await exportedRun();
    const results = W.succeedItems(batchId, items);

    await W.expectRefused(
      withTenant(db, otherScope(), (tx) =>
        settleBatchPayouts(
          tx,
          { tenantId: otherTenantId, userId: APP2 },
          batchId,
        ),
      ),
    );
    await W.expectRefused(
      withTenant(db, otherScope(), (tx) =>
        confirmManualItems(
          tx,
          { tenantId: otherTenantId, userId: APP2 },
          batchId,
          { results } as never,
          W.proofs(),
        ),
      ),
    );

    // Ours is untouched: still exported, nothing posted.
    expect(await W.postingsOf(batchId)).toHaveLength(0);
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("exported");

    // Now we confirm for real; the other tenant still sees none of it.
    await W.confirm(batchId, results);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    expect(await visibleToOther(batchId)).toEqual({
      postings: 0,
      batches: 0,
      items: 0,
      journals: 0,
    });
  });
});
