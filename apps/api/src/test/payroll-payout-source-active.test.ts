// Payout source account must be ACTIVE on every path (bead legend-s7roi).
// Written fail-first from the bead spec and the existing payout tests, not from
// the implementation.
//
// Rules proven here (money: nobody is paid twice, the PT does not lose):
// - ONE active-source-account rule is used by approve, export download, settle
//   (confirm), fee re-post and overpaid: a bank account with is_active = false
//   is refused fail-closed, HTTP 409 PAYOUT_SOURCE_ACCOUNT_MISSING, nothing
//   moves, and the same call works once the account is active again.
// - The re-post refusal carries a clear message for finance (not a bare code).
// - The transfer fee of an overpaid (late, duplicate) transfer is borne by the
//   PT: Dr bank charges 8101 / Cr the source bank account, exactly once, while
//   the employee receivable (net pay) stays whole and retries post nothing more.
//
// Assumptions (spec silent, stated so they can be contested):
// - The refusal code for an inactive source is the existing
//   `PAYOUT_SOURCE_ACCOUNT_MISSING` (HTTP 409), same as a missing account.
// - Settle is refused too (spec: "ALL paths"): confirming while the source is
//   inactive fails closed and rolls back, items stay `exported`.
// - "Clear finance message" for the re-post is asserted loosely: a non-empty
//   human sentence (>= 20 chars) that is not just the error code.
// - The overpaid fee is the Rp5.000 stored per item at export (founder Q15);
//   its journal key is not specified, so it is found by the item id inside the
//   idempotency key (any journal, same entry as the receivable or its own).
//   Asserted: total Dr 8101 = Rp5.000 in exactly one entry; total Cr 1103 =
//   net pay + fee; Dr 1204 = net pay.
// - Approve and export already refuse a deactivated source today (payout-
//   hardening); they are kept here as regression guards for the shared helper.
import { afterAll, describe, expect, it } from "vitest";
import * as glService from "../services/payroll-payout-gl.service.ts";
import {
  approveDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import { exportManualBatch } from "../services/payroll-payout-manual.service.ts";
import {
  ANDI,
  APP,
  APP3,
  BUDI,
  REQ,
  SITI,
  actorOf,
  bank,
  uploadEvidence,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("source-active");

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const FEE = 5_000;
const CODE = "PAYOUT_SOURCE_ACCOUNT_MISSING";
const slipsOf = () => [
  bank(BUDI, BUDI_NET),
  bank(SITI, SITI_NET),
  bank(ANDI, ANDI_NET),
];
const idOf = (row: Row) => row.id as string;

afterAll(() => undefined);

// ---- NEW service functions, looked up by name -----------------------------
type Tx = Parameters<Parameters<typeof W.inTx>[0]>[0];
function glFn<T extends (...args: never[]) => unknown>(name: string): T {
  const fn = (glService as Record<string, unknown>)[name];
  if (typeof fn !== "function")
    throw new Error(
      `services/payroll-payout-gl.service.ts must export ${name}`,
    );
  return fn as T;
}
const repostSkippedFees = (batchId: string, by = APP) =>
  W.inTx((tx: Tx) =>
    glFn<(tx: Tx, actor: unknown, batchId: string) => Promise<unknown>>(
      "repostSkippedFees",
    )(tx, actorOf(by), batchId),
  );
const recordOverpaidItem = async (
  itemId: string,
  batchId: string,
  by = APP,
) => {
  // 905: the second step needs the first step of another person (W.proposeOverpaid).
  await W.proposeOverpaid(
    batchId,
    itemId,
    uploadEvidence(batchId, "mutasi-bank.pdf"),
    "Mutasi bank menunjukkan transfer kedua untuk slip yang sama",
    by,
  );
  return W.inTx((tx: Tx) =>
    glFn<
      (
        tx: Tx,
        actor: unknown,
        itemId: string,
        input: { evidenceKey: string; note: string },
        proofs: unknown,
      ) => Promise<unknown>
    >("recordOverpaidItem")(
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
};

const failureOf = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: unknown) =>
      error as { status?: number; code?: string; message?: string },
  );

// ---- Setup helpers --------------------------------------------------------

async function exportedRun(options: { lockedJournal?: boolean } = {}) {
  const slips = slipsOf();
  const runId = await W.seedRun(slips);
  if (options.lockedJournal !== false) await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  return { runId, batchId, items };
}

const MAPPING_WHERE = `tenant_id = $1 AND legal_entity_id = $2 AND role = 'bank_charges'`;
/** Removes the bank_charges mapping; returns the function that puts it back. */
async function breakMapping() {
  const [mapping] = await W.rowsOf(
    `SELECT account_id FROM account_mappings WHERE ${MAPPING_WHERE}`,
    [W.tenantId, W.entityId()],
  );
  expect(mapping, "premise: the fixture maps bank charges").toBeDefined();
  await W.asTenant(
    (c) =>
      c.query(`DELETE FROM account_mappings WHERE ${MAPPING_WHERE}`, [
        W.tenantId,
        W.entityId(),
      ]),
    true,
  );
  return () =>
    W.asTenant(
      (c) =>
        c.query(
          `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
           VALUES ($1, $2, 'bank_charges', $3)`,
          [W.tenantId, W.entityId(), mapping!.account_id],
        ),
      true,
    );
}

/** The source bank account is deactivated (is_active = false). Returns the restore. */
async function deactivateSource() {
  const [config] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [W.tenantId, W.entityId()],
  );
  const id = config!.id as string;
  expect(id, "premise: the fixture has a source bank account").toBeTruthy();
  const setActive = (active: boolean) =>
    W.asTenant(
      (c) =>
        c.query(`UPDATE bank_accounts SET is_active = $2 WHERE id = $1`, [
          id,
          active,
        ]),
      true,
    );
  await setActive(false);
  return () => setActive(true);
}

/**
 * Settled from account A, then the config moves to account B (active) and A is
 * deactivated. Runs `work` in that state and always restores (A active, config
 * back on A). B has its own GL account (1101) so a posting to A would be visible.
 */
async function withSettledSourceDeactivated<T>(work: () => Promise<T>) {
  const [config] = await W.rowsOf(
    `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
      WHERE tenant_id = $1 AND legal_entity_id = $2`,
    [W.tenantId, W.entityId()],
  );
  const a = config!.id as string;
  const [existing] = await W.rowsOf(
    `SELECT id FROM bank_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND account_number_hmac = $3`,
    [W.tenantId, W.entityId(), "e".repeat(64)],
  );
  const b =
    (existing?.id as string | undefined) ??
    ((
      await W.rowsOf(
        `INSERT INTO bank_accounts
           (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
            account_number_hmac, account_number_last4, account_number_key_version,
            gl_account_id, created_by)
         SELECT $1, $2, 'BCA', 'Rekening Baru', '\\x00', $3, '1111', 1, id, 'payout-source-active-test'
           FROM chart_of_accounts
          WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1101'
         RETURNING id`,
        [W.tenantId, W.entityId(), "e".repeat(64)],
      )
    )[0]!.id as string);
  const apply = (sourceId: string, aActive: boolean) =>
    W.asTenant(async (c) => {
      await c.query(
        `UPDATE payroll_payout_configs SET manual_source_bank_account_id = $3
          WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [W.tenantId, W.entityId(), sourceId],
      );
      await c.query(`UPDATE bank_accounts SET is_active = $2 WHERE id = $1`, [
        a,
        aActive,
      ]);
    }, true);
  await apply(b, false);
  try {
    return await work();
  } finally {
    await apply(a, true);
  }
}

/**
 * Journal lines booked under any idempotency key that carries this item id,
 * summed by GL code, plus how many distinct entries touch 8101.
 */
async function ledgerOfItem(itemId: string) {
  const lines = await W.rowsOf(
    `SELECT a.code, sum(l.debit_idr)::text AS debit, sum(l.credit_idr)::text AS credit
       FROM journal_entries e
       JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2
        AND e.idempotency_key LIKE '%' || $3 || '%'
      GROUP BY a.code`,
    [W.tenantId, W.entityId(), itemId],
  );
  const byCode: Record<string, { debit: number; credit: number }> = {};
  for (const line of lines)
    byCode[line.code as string] = {
      debit: Number(line.debit),
      credit: Number(line.credit),
    };
  const [fees] = await W.rowsOf(
    `SELECT count(DISTINCT e.id)::int AS n
       FROM journal_entries e
       JOIN journal_lines l ON l.tenant_id = e.tenant_id AND l.entry_id = e.id
       JOIN chart_of_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
      WHERE e.tenant_id = $1 AND e.legal_entity_id = $2
        AND e.idempotency_key LIKE '%' || $3 || '%'
        AND a.code = '8101' AND l.debit_idr > 0`,
    [W.tenantId, W.entityId(), itemId],
  );
  return { byCode, feeEntries: fees!.n as number };
}

// =========================================================================
// approve and export: the shared helper (regression guards, pass today)
// =========================================================================

describe("approve and export refuse an inactive source account", () => {
  it("[approve-inactive-source] approving without an active source account is refused 409; the batch stays pending, and works once the account is active again", async () => {
    const runId = await W.seedRun(slipsOf());
    const batchId = await W.createBatch(runId);
    await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
    const hash = (await W.batchById(batchId)).content_hash as string;
    const [config] = await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [W.tenantId, W.entityId()],
    );
    const sourceBankAccountId = config!.id as string;
    const approve = () =>
      W.inTx((tx) =>
        approveDisbursementBatch(tx, actorOf(APP), batchId, {
          contentHash: hash,
          sourceBankAccountId,
        }),
      );
    const restore = await deactivateSource();
    try {
      await W.expectRefused(approve(), { status: 409, code: CODE });
      const batch = await W.batchById(batchId);
      expect(batch.status).toBe("pending_approval");
      expect(batch.approved_by).toBeNull();
    } finally {
      await restore();
    }
    await approve();
    expect((await W.batchById(batchId)).status).toBe("approved");
  });

  it("[export-inactive-source] downloading the bank file without an active source account is refused 409; the one download is not spent", async () => {
    const runId = await W.seedRun(slipsOf());
    const batchId = await W.approvedBatch(runId);
    const exportFile = () =>
      W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));
    const restore = await deactivateSource();
    try {
      await W.expectRefused(exportFile(), { status: 409, code: CODE });
      const batch = await W.batchById(batchId);
      expect(batch.status).toBe("approved");
      expect(batch.exported_at).toBeNull();
    } finally {
      await restore();
    }
    await exportFile();
    expect((await W.batchById(batchId)).status).toBe("exported");
  });
});

// =========================================================================
// settle (confirm): fail closed
// =========================================================================

describe("settle refuses an inactive source account", () => {
  it("[settle-inactive-source] confirming while the source account is inactive is refused 409: no item is paid, no journal, no posting, the run stays locked; confirming works once the account is active again", async () => {
    const { runId, batchId, items } = await exportedRun();
    const restore = await deactivateSource();
    try {
      await W.expectRefused(
        W.confirm(batchId, W.succeedItems(batchId, items)),
        { status: 409, code: CODE },
      );
      expect(await W.postingsOf(batchId), "no posting").toHaveLength(0);
      for (const item of await W.itemsOf(batchId)) {
        expect(item.status, "nothing was marked paid").toBe("exported");
        expect(item.gl_posting_id).toBeNull();
      }
      expect((await W.runRow(runId)).status).toBe("locked");
      expect(await W.paidEventsOf(runId)).toHaveLength(0);
    } finally {
      await restore();
    }

    await W.confirm(batchId, W.succeedItems(batchId, items));
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    expect((await W.runRow(runId)).status).toBe("paid");
  });
});

// =========================================================================
// fee repost: fail closed with a clear message
// =========================================================================

describe("fee re-post refuses an inactive source account", () => {
  it("[fee-repost-inactive-source] re-posting a skipped fee while the source account is inactive is refused 409 with a clear message for finance; no fee journal, fee_posted stays false; once active the fee posts exactly once", async () => {
    const { batchId, items } = await exportedRun();
    const restoreMapping = await breakMapping();
    try {
      await W.confirm(batchId, W.succeedItems(batchId, items));
    } finally {
      await restoreMapping();
    }
    const [posting] = await W.postingsOf(batchId);
    expect(posting!.fee_posted, "premise: the fee was skipped").toBe(false);
    const feeKey = `payroll-payout-fee:${posting!.item_set_hash}`;

    const restore = await deactivateSource();
    try {
      const error = await failureOf(repostSkippedFees(batchId));
      expect(error, "the re-post must be refused").not.toBeNull();
      expect(error!.status).toBe(409);
      expect(error!.code).toBe(CODE);
      expect(
        (error!.message ?? "").length,
        "a message finance can act on, not a bare code",
      ).toBeGreaterThanOrEqual(20);
      expect(error!.message).not.toBe(CODE);
      expect(await W.journalByKey(feeKey)).toBe(undefined);
      expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(false);
    } finally {
      await restore();
    }

    await repostSkippedFees(batchId);
    await repostSkippedFees(batchId).catch(() => undefined);
    expect(await W.journalByKey(feeKey)).toEqual({
      "8101": { debit: 3 * FEE, credit: 0 },
      "1103": { debit: 0, credit: 3 * FEE },
    });
    expect(await W.countJournals(feeKey)).toBe(1);
    expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(true);
  });

  it("[fee-repost-settled-account-inactive] fee skipped at settle from account A, config moved to B, A deactivated: re-posting the fee is refused 409 (it would credit the inactive A): no fee journal, fee_posted stays false", async () => {
    const { batchId, items } = await exportedRun();
    const restoreMapping = await breakMapping();
    try {
      await W.confirm(batchId, W.succeedItems(batchId, items));
    } finally {
      await restoreMapping();
    }
    const [posting] = await W.postingsOf(batchId);
    expect(posting!.fee_posted, "premise: the fee was skipped").toBe(false);
    const feeKey = `payroll-payout-fee:${posting!.item_set_hash}`;

    await withSettledSourceDeactivated(async () => {
      const error = await failureOf(repostSkippedFees(batchId));
      expect(error, "the re-post must be refused").not.toBeNull();
      expect(error!.status).toBe(409);
      expect(error!.code).toBe(CODE);
    });
    expect(await W.journalByKey(feeKey)).toBe(undefined);
    expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(false);
  });
});

// =========================================================================
// overpaid: active source, and the fee is borne by the PT exactly once
// =========================================================================

describe("overpaid uses the active source account and books its fee once", () => {
  /**
   * Budi's first transfer is resolved `failed` (two people), the others are
   * paid, a follow-up batch pays Budi. Then the first transfer turns out to
   * have reached Budi after all (same fixture shape as payout-hardening).
   */
  async function lateDoublePayment(options: { lockedJournal?: boolean } = {}) {
    const { runId, batchId, items } = await exportedRun(options);
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
    expect(followItems).toHaveLength(1);
    await W.confirm(followUp, W.succeedItems(followUp, followItems));
    return { runId, batchId, followUp, budiFirst };
  }

  it("[overpaid-inactive-source] recording an overpaid item while the source account is inactive is refused 409: the item stays failed, no journal; once active it is recorded and the fee is booked exactly once", async () => {
    const { batchId, budiFirst } = await lateDoublePayment();
    const itemId = idOf(budiFirst);

    const restore = await deactivateSource();
    try {
      await W.expectRefused(recordOverpaidItem(itemId, batchId), {
        status: 409,
        code: CODE,
      });
      expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("failed");
      expect(await W.countJournals(`%${itemId}%`)).toBe(0);
    } finally {
      await restore();
    }

    await recordOverpaidItem(itemId, batchId);
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("overpaid");
    const { byCode, feeEntries } = await ledgerOfItem(itemId);
    expect(byCode["8101"]?.debit, "the refused attempt left no half fee").toBe(
      FEE,
    );
    expect(feeEntries).toBe(1);
  });

  it("[overpaid-fee-journaled-once] the overpaid transfer fee is Dr 8101 bank charges / Cr source bank 1103 exactly once; the employee receivable stays the net pay; retries and concurrent reports post nothing more", async () => {
    const { batchId, budiFirst } = await lateDoublePayment();
    const itemId = idOf(budiFirst);

    await recordOverpaidItem(itemId, batchId);

    const ledger = async () => (await ledgerOfItem(itemId)).byCode;
    let { byCode, feeEntries } = await ledgerOfItem(itemId);
    // Net pay unchanged: the receivable is still exactly what was paid twice.
    expect(byCode["1204"], "employee receivable = net pay").toEqual({
      debit: BUDI_NET,
      credit: 0,
    });
    // The fee: expense for the PT, paid out of the source bank account.
    expect(byCode["8101"], "bank charges expense = Rp5.000").toEqual({
      debit: FEE,
      credit: 0,
    });
    expect(feeEntries, "one fee entry").toBe(1);
    expect(byCode["1103"], "source bank credited net pay + fee").toEqual({
      debit: 0,
      credit: BUDI_NET + FEE,
    });
    // No other account is touched (the salary payable is not re-opened).
    expect(Object.keys(byCode).sort()).toEqual(["1103", "1204", "8101"]);

    // Retries: refused (the item is no longer `failed`), nothing more posted.
    await W.expectRefused(recordOverpaidItem(itemId, batchId));
    const outcomes = await Promise.allSettled([
      recordOverpaidItem(itemId, batchId),
      recordOverpaidItem(itemId, batchId, APP3),
    ]);
    expect(outcomes.every((o) => o.status === "rejected")).toBe(true);
    ({ byCode, feeEntries } = await ledgerOfItem(itemId));
    expect(byCode).toEqual(await ledger());
    expect(byCode["8101"]!.debit).toBe(FEE);
    expect(feeEntries).toBe(1);
  });

  it("[overpaid-settled-account-inactive] settled from account A, config moved to B, A deactivated: recording an overpaid item is refused 409 (the journal would credit the inactive A): the item stays failed, no journal at all", async () => {
    const { batchId, budiFirst } = await lateDoublePayment();
    const itemId = idOf(budiFirst);
    await withSettledSourceDeactivated(async () => {
      await W.expectRefused(recordOverpaidItem(itemId, batchId), {
        status: 409,
        code: CODE,
      });
    });
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("failed");
    expect(await W.countJournals(`%${itemId}%`), "no journal").toBe(0);
    const overpaidPostings = await W.rowsOf(
      `SELECT id FROM payroll_payout_gl_postings
        WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'overpaid'`,
      [W.tenantId, batchId],
    );
    expect(overpaidPostings, "no overpaid posting").toHaveLength(0);
  });

  it("[overpaid-fee-no-locked-journal] an overpaid item of a run without a locked journal but with accounting on: the fee is booked exactly once (Dr 8101 / Cr source bank), fee_posted is true, no receivable without a salary journal", async () => {
    // Assumption: same rule as settle (a run without a locked journal still
    // books the fee when accounting is on), so overpaid must not lose the fee.
    const { batchId, budiFirst } = await lateDoublePayment({
      lockedJournal: false,
    });
    const itemId = idOf(budiFirst);
    await recordOverpaidItem(itemId, batchId);

    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("overpaid");
    const { byCode, feeEntries } = await ledgerOfItem(itemId);
    expect(byCode["8101"], "bank charges expense = Rp5.000").toEqual({
      debit: FEE,
      credit: 0,
    });
    expect(feeEntries, "one fee entry").toBe(1);
    // No locked journal: payroll is not in the GL, so no employee receivable
    // is booked; only the bank's fee is.
    expect(byCode["1204"], "no receivable without a salary journal").toBe(
      undefined,
    );
    expect(byCode["1103"], "source credited the fee only").toEqual({
      debit: 0,
      credit: FEE,
    });
    const [posting] = await W.rowsOf(
      `SELECT fee_posted FROM payroll_payout_gl_postings
        WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'overpaid'`,
      [W.tenantId, batchId],
    );
    expect(posting, "an overpaid posting row").toBeDefined();
    expect(posting!.fee_posted).toBe(true);

    // Replays post nothing more.
    await W.expectRefused(recordOverpaidItem(itemId, batchId));
    expect((await ledgerOfItem(itemId)).feeEntries).toBe(1);
  });

  it("[overpaid-fee-concurrent] two simultaneous first reports book the fee once", async () => {
    const { batchId, budiFirst } = await lateDoublePayment();
    const itemId = idOf(budiFirst);
    const outcomes = await Promise.allSettled([
      recordOverpaidItem(itemId, batchId),
      recordOverpaidItem(itemId, batchId, APP3),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const { byCode, feeEntries } = await ledgerOfItem(itemId);
    expect(byCode["8101"]?.debit).toBe(FEE);
    expect(feeEntries).toBe(1);
  });
});

void SITI;
void ANDI_NET;
void SITI_NET;
