// Payout second-opinion fixes (beads legend-hkh57 = T1, legend-ijhe3 = T2,
// legend-l1a7p = T3; brief scratchpad "payout SO fixes"). Written fail-first
// from the CTO decisions in the brief and the existing payout tests, not from
// the implementation.
//
// Rules proven here (money: nobody is paid twice, the PT credits the right
// bank, a confirmation is never lost):
// - T1: the source bank account is FROZEN on the batch at approve/export. A
//   later change of the config source never changes an old batch; the overpaid
//   journal of a transfer of that old batch always credits the batch's frozen
//   account (even when no item of that batch was ever settled, so there is no
//   settle posting to copy the account from), and is refused fail-closed (409
//   PAYOUT_SOURCE_ACCOUNT_MISSING) while that frozen account is inactive.
// - T2: with accounting on but no locked journal, an inactive source account
//   is still refused at confirm (409 PAYOUT_SOURCE_ACCOUNT_MISSING), not
//   silently turned into `settle_skipped`. Nothing is paid, nothing posted.
// - T3: the bank-charges mapping is only "ready" when the mapped account (8101)
//   is active AND postable. Approve/export are refused otherwise. If 8101
//   goes inactive AFTER the file was exported, the confirmation is still
//   recorded (the money has left), the fee is deferred through the 8codi
//   marker (fee_posted = false, listed for finance) and posts exactly once
//   when finance re-posts it after the account is usable again.
//
// Names this test EXPECTS from the implementation (none exist yet):
// - column `payroll_disbursement_batches.source_bank_account_id` (uuid): the
//   id of the bank account frozen on the batch, set by the time the batch is
//   approved/exported (this file reads it after export).
//
// Assumptions (the brief is silent, stated so they can be contested):
// - T3 refusal code at approve/export for an inactive or non-postable 8101 is
//   the existing `PAYOUT_BANK_CHARGES_MAPPING_MISSING` (HTTP 409): the
//   mapping is "not ready", same as a missing one.
// - "Postable" means the DB rule of the chart: a header account (one that has a
//   child account) is not postable.
// - A fee re-post while 8101 is still inactive is refused with a 4xx (409 here),
//   never a 500, and posts nothing.
// - Frozen-account inactive at overpaid uses the existing code
//   `PAYOUT_SOURCE_ACCOUNT_MISSING`.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { originHeader } from "./helpers.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
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

const W = installPayoutWorld("so-fixes");
const FEE_REPOST_LIST = "/api/hris/payroll/payout-fee-reposts";
const BASE = "/api/hris/payroll/disbursement-batches";

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const FEE = 5_000;
const SOURCE_CODE = "PAYOUT_SOURCE_ACCOUNT_MISSING";
const MAPPING_CODE = "PAYOUT_BANK_CHARGES_MAPPING_MISSING";
const slipsOf = () => [
  bank(BUDI, BUDI_NET),
  bank(SITI, SITI_NET),
  bank(ANDI, ANDI_NET),
];
const idOf = (row: Row) => row.id as string;

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

// ---- Existing service functions, looked up by name -------------------------
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
const recordOverpaidItem = (itemId: string, batchId: string, by = APP) =>
  W.inTx((tx: Tx) =>
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

// ---- Setup helpers ---------------------------------------------------------

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

const currentSourceBank = async () =>
  (
    await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [W.tenantId, W.entityId()],
    )
  )[0]!.id as string;
const setSourceBank = (id: string) =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_configs SET manual_source_bank_account_id = $3
          WHERE tenant_id = $1 AND legal_entity_id = $2`,
        [W.tenantId, W.entityId(), id],
      ),
    true,
  );
const setBankActive = (id: string, active: boolean) =>
  W.asTenant(
    (c) =>
      c.query(`UPDATE bank_accounts SET is_active = $2 WHERE id = $1`, [
        id,
        active,
      ]),
    true,
  );

/** Another bank account whose GL account is 1101 instead of 1103. */
async function otherBankAccount() {
  const [existing] = await W.rowsOf(
    `SELECT id FROM bank_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND account_number_hmac = $3`,
    [W.tenantId, W.entityId(), "e".repeat(64)],
  );
  if (existing) return existing.id as string;
  const [row] = await W.rowsOf(
    `INSERT INTO bank_accounts
       (tenant_id, legal_entity_id, bank, account_name, account_number_encrypted,
        account_number_hmac, account_number_last4, account_number_key_version,
        gl_account_id, created_by)
     SELECT $1, $2, 'BCA', 'Rekening Baru', '\\x00', $3, '1111', 1, id, 'payout-so-fixes-test'
       FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1101'
     RETURNING id`,
    [W.tenantId, W.entityId(), "e".repeat(64)],
  );
  return row!.id as string;
}

/** The source bank account is deactivated. Returns the restore. */
async function deactivateSource() {
  const id = await currentSourceBank();
  await setBankActive(id, false);
  return () => setBankActive(id, true);
}

/** Account 8101 (the mapped bank charges account) becomes inactive. Returns the restore. */
async function deactivateBankCharges() {
  const setActive = (active: boolean) =>
    W.asTenant(
      (c) =>
        c.query(
          `UPDATE chart_of_accounts SET is_active = $3
            WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '8101'`,
          [W.tenantId, W.entityId(), active],
        ),
      true,
    );
  await setActive(false);
  return () => setActive(true);
}

/** 8101 becomes a header account (it gets a child). Returns the restore. */
async function makeBankChargesHeader() {
  const [child] = await W.rowsOf(
    `INSERT INTO chart_of_accounts
       (tenant_id, legal_entity_id, code, name, type, report_group, parent_id)
     SELECT tenant_id, legal_entity_id, '81011', 'Biaya Bank Anak', type, report_group, id
       FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '8101'
     RETURNING id`,
    [W.tenantId, W.entityId()],
  );
  return () =>
    W.asTenant(
      (c) =>
        c.query(`DELETE FROM chart_of_accounts WHERE id = $1`, [child!.id]),
      true,
    );
}

/** Account `code` becomes inactive or a header (it gets a child). Returns the restore. */
async function breakGlAccount(code: string, how: "inactive" | "header") {
  if (how === "inactive") {
    const setActive = (active: boolean) =>
      W.asTenant(
        (c) =>
          c.query(
            `UPDATE chart_of_accounts SET is_active = $3
              WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = $4`,
            [W.tenantId, W.entityId(), active, code],
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
    [W.tenantId, W.entityId(), code],
  );
  return () =>
    W.asTenant(
      (c) =>
        c.query(`DELETE FROM chart_of_accounts WHERE id = $1`, [child!.id]),
      true,
    );
}

/** A batch from before the freeze: the frozen account is cleared (triggers off). */
const clearFrozenSource = (batchId: string) =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_disbursement_batches SET source_bank_account_id = NULL WHERE id = $1`,
        [batchId],
      ),
    true,
  );

/** The backfill statements of migration 0355 (the ones that read the configs). */
function backfillStatements() {
  const sql = readFileSync(
    new URL(
      "../../drizzle/0355_payout_source_bank_frozen.sql",
      import.meta.url,
    ),
    "utf8",
  );
  return sql
    .split("--> statement-breakpoint")
    .filter((statement) => statement.includes("payroll_payout_configs"));
}

/**
 * Journal lines booked under any idempotency key that carries this item id,
 * summed by GL code, plus how many distinct entries debit 8101.
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
  return byCode;
}

// ---- HTTP finance person (same shape as payroll-payout-hardening) ----------

const PASSWORD_NOTE = "enrollment is the second factor";
async function financeClient(label: string) {
  const { client, userId } = await W.signedInClient(`SoFixes ${label}`);
  await W.grantRole(userId, ["payroll.view", "payroll.disburse.approve"]);
  const enrolled = await client
    .post("/api/auth/mfa/factors")
    .set(originHeader)
    .send({ type: "totp" });
  expect(
    enrolled.status,
    `${PASSWORD_NOTE} ${JSON.stringify(enrolled.body)}`,
  ).toBe(201);
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
  return { client, userId };
}

// =========================================================================
// T1 (legend-hkh57): the source account is frozen per batch
// =========================================================================

describe("T1: the source bank account is frozen on the batch (hkh57)", () => {
  /**
   * All three transfers of batch 1 are resolved `failed` (two people) so batch
   * 1 NEVER has a settle posting. Finance then moves the config source to B
   * (GL 1101, active) and a follow-up batch pays everybody from B. Then the
   * first transfer of Budi turns out to have reached him after all.
   */
  async function failedBatchThenSourceMoved() {
    const slips = slipsOf();
    const runId = await W.seedRun(slips);
    await W.postLockedJournal(runId, slips);
    const sourceA = await currentSourceBank();
    const batch1 = await W.exportedBatch(runId);
    const first = (await W.itemsOf(batch1)).filter(
      (i) => i.status === "exported",
    );
    const ids = first.map(idOf);
    await W.resolve(batch1, ids, "failed", APP);
    await W.resolve(batch1, ids, "failed", APP3);

    const sourceB = await otherBankAccount();
    await setSourceBank(sourceB);
    const batch2 = await W.exportedBatch(runId);
    const second = (await W.itemsOf(batch2)).filter(
      (i) => i.status === "exported",
    );
    expect(second, "premise: the follow-up batch pays all three").toHaveLength(
      3,
    );
    await W.confirm(batch2, W.succeedItems(batch2, second));
    expect(
      await W.rowsOf(
        `SELECT id FROM payroll_payout_gl_postings WHERE tenant_id = $1 AND batch_id = $2`,
        [W.tenantId, batch1],
      ),
      "premise: batch 1 has no settle posting to copy the account from",
    ).toHaveLength(0);
    const budiFirst = first.find((i) => i.employee_id === BUDI.id)!;
    return { runId, batch1, batch2, sourceA, sourceB, budiFirst };
  }

  it("[source-frozen-on-batch] the batch stores the bank account it was approved/exported with, and a later config change does not touch an old batch", async () => {
    const slips = slipsOf();
    const runId = await W.seedRun(slips);
    const sourceA = await currentSourceBank();
    const batch1 = await W.exportedBatch(runId);
    expect(
      (await W.batchById(batch1)).source_bank_account_id,
      "batch.source_bank_account_id = the account of the config at approve/export",
    ).toBe(sourceA);

    const sourceB = await otherBankAccount();
    await setSourceBank(sourceB);
    try {
      expect(
        (await W.batchById(batch1)).source_bank_account_id,
        "changing the config must not rewrite the old batch",
      ).toBe(sourceA);
      const runId2 = await W.seedRun(slipsOf());
      const batch2 = await W.exportedBatch(runId2);
      expect((await W.batchById(batch2)).source_bank_account_id).toBe(sourceB);
      expect((await W.batchById(batch1)).source_bank_account_id).toBe(sourceA);
    } finally {
      await setSourceBank(sourceA);
    }
  });

  it("[overpaid-credits-frozen-source] after the source moved to B, the overpaid journal of batch 1's late transfer credits batch 1's frozen account (1103), never B (1101); no new payment, batch or item is created", async () => {
    const { runId, batch1, batch2, sourceA, budiFirst } =
      await failedBatchThenSourceMoved();
    try {
      const batchesBefore = await W.rowsOf(
        `SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND payroll_run_id = $2`,
        [W.tenantId, runId],
      );
      const itemsBefore =
        (await W.itemsOf(batch1)).length + (await W.itemsOf(batch2)).length;

      await recordOverpaidItem(idOf(budiFirst), batch1);

      expect((await W.itemOfPerson(batch1, BUDI)).status).toBe("overpaid");
      const byCode = await ledgerOfItem(idOf(budiFirst));
      expect(
        byCode["1101"],
        "the new source (B) must not be credited for an old batch's transfer",
      ).toBeUndefined();
      expect(
        byCode["1103"],
        "batch 1's frozen source credited net pay + fee",
      ).toEqual({
        debit: 0,
        credit: BUDI_NET + FEE,
      });
      expect(byCode["1204"]).toEqual({ debit: BUDI_NET, credit: 0 });
      expect(byCode["8101"]).toEqual({ debit: FEE, credit: 0 });
      expect(Object.keys(byCode).sort()).toEqual(["1103", "1204", "8101"]);

      // Nobody is paid again: same batches, same items, frozen id unchanged.
      expect(
        await W.rowsOf(
          `SELECT id FROM payroll_disbursement_batches WHERE tenant_id = $1 AND payroll_run_id = $2`,
          [W.tenantId, runId],
        ),
      ).toHaveLength(batchesBefore.length);
      expect(
        (await W.itemsOf(batch1)).length + (await W.itemsOf(batch2)).length,
      ).toBe(itemsBefore);
      expect((await W.batchById(batch1)).source_bank_account_id).toBe(sourceA);
    } finally {
      await setSourceBank(sourceA);
    }
  });

  it("[overpaid-frozen-source-inactive] the frozen account of the old batch is inactive while the new source B is active: recording the overpaid item is refused 409 (it must not fall back to B): the item stays failed, no journal; once A is active again it credits A", async () => {
    const { batch1, sourceA, budiFirst } = await failedBatchThenSourceMoved();
    const itemId = idOf(budiFirst);
    try {
      await setBankActive(sourceA, false);
      try {
        await W.expectRefused(recordOverpaidItem(itemId, batch1), {
          status: 409,
          code: SOURCE_CODE,
        });
        expect((await W.itemOfPerson(batch1, BUDI)).status).toBe("failed");
        expect(
          Object.keys(await ledgerOfItem(itemId)),
          "no journal at all, neither on A nor on B",
        ).toEqual([]);
      } finally {
        await setBankActive(sourceA, true);
      }

      await recordOverpaidItem(itemId, batch1);
      const byCode = await ledgerOfItem(itemId);
      expect(byCode["1103"]).toEqual({ debit: 0, credit: BUDI_NET + FEE });
      expect(byCode["1101"]).toBeUndefined();
    } finally {
      await setSourceBank(sourceA);
    }
  });
  it("[overpaid-old-batch-no-frozen-no-settle] an old batch without a frozen account and without a settle journal refuses the overpaid record 409 even though the config source is active (no fallback to today's config); nothing is booked", async () => {
    const { batch1, sourceA, budiFirst } = await failedBatchThenSourceMoved();
    try {
      await clearFrozenSource(batch1);
      await W.expectRefused(recordOverpaidItem(idOf(budiFirst), batch1), {
        status: 409,
        code: SOURCE_CODE,
      });
      expect((await W.itemOfPerson(batch1, BUDI)).status).toBe("failed");
      expect(Object.keys(await ledgerOfItem(idOf(budiFirst)))).toEqual([]);
    } finally {
      await setSourceBank(sourceA);
    }
  });
});

// =========================================================================
// T2 (legend-ijhe3): inactive source is refused before the journal branch
// =========================================================================

describe("T2: confirm refuses an inactive source even without a locked journal (ijhe3)", () => {
  it("[settle-no-locked-journal-inactive-source] accounting on, no locked journal, source inactive: confirm is refused 409 PAYOUT_SOURCE_ACCOUNT_MISSING, not turned into settle_skipped; nothing is paid or posted; once active it settles (settle_skipped) exactly once", async () => {
    const { runId, batchId, items } = await exportedRun({
      lockedJournal: false,
    });
    const restore = await deactivateSource();
    try {
      await W.expectRefused(
        W.confirm(batchId, W.succeedItems(batchId, items)),
        { status: 409, code: SOURCE_CODE },
      );
      expect(
        await W.postingsOf(batchId),
        "no posting, not even skipped",
      ).toHaveLength(0);
      for (const item of await W.itemsOf(batchId)) {
        expect(item.status, "no confirmation was recorded").toBe("exported");
        expect(item.gl_posting_id).toBeNull();
      }
      expect((await W.runRow(runId)).status).toBe("locked");
      expect(await W.paidEventsOf(runId)).toHaveLength(0);
    } finally {
      await restore();
    }

    await W.confirm(batchId, W.succeedItems(batchId, items));
    const postings = await W.postingsOf(batchId);
    expect(postings).toHaveLength(1);
    expect(postings[0]!.kind).toBe("settle_skipped");
    expect((await W.runRow(runId)).status).toBe("paid");
    expect(await W.paidEventsOf(runId)).toHaveLength(1);
    for (const item of await W.itemsOf(batchId))
      expect(item.status).toBe("succeeded");
  });
});

// =========================================================================
// T3 (legend-l1a7p): the bank charges account must be active and postable
// =========================================================================

describe("T3: the bank charges mapping needs an active, postable account (l1a7p)", () => {
  const breakers = {
    inactive: deactivateBankCharges,
    header: makeBankChargesHeader,
  } as const;

  for (const [label, breakIt] of Object.entries(breakers)) {
    it(`[approve-bank-charges-${label}] approving while 8101 is ${label === "inactive" ? "inactive" : "a header account"} is refused 409 ${MAPPING_CODE}; the batch stays pending, and works once fixed`, async () => {
      const runId = await W.seedRun(slipsOf());
      const batchId = await W.createBatch(runId);
      await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
      const hash = (await W.batchById(batchId)).content_hash as string;
      const sourceBankAccountId = await currentSourceBank();
      const approve = () =>
        W.inTx((tx) =>
          approveDisbursementBatch(tx, actorOf(APP), batchId, {
            contentHash: hash,
            sourceBankAccountId,
          }),
        );
      const restore = await breakIt();
      try {
        await W.expectRefused(approve(), { status: 409, code: MAPPING_CODE });
        const batch = await W.batchById(batchId);
        expect(batch.status).toBe("pending_approval");
        expect(batch.approved_by).toBeNull();
        for (const item of await W.itemsOf(batchId))
          expect(item.status).toBe("prepared");
      } finally {
        await restore();
      }
      await approve();
      expect((await W.batchById(batchId)).status).toBe("approved");
    });
  }

  it("[export-bank-charges-inactive] downloading the bank file while 8101 is inactive is refused 409; the one download is not spent and works once fixed", async () => {
    const runId = await W.seedRun(slipsOf());
    const batchId = await W.approvedBatch(runId);
    const exportFile = () =>
      W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));
    const restore = await deactivateBankCharges();
    try {
      await W.expectRefused(exportFile(), { status: 409, code: MAPPING_CODE });
      const batch = await W.batchById(batchId);
      expect(batch.status).toBe("approved");
      expect(batch.exported_at).toBeNull();
      for (const item of await W.itemsOf(batchId))
        expect(item.status).toBe("approved");
    } finally {
      await restore();
    }
    await exportFile();
    expect((await W.batchById(batchId)).status).toBe("exported");
  });

  it("[confirm-bank-charges-inactive-after-export] 8101 goes inactive after the export: the confirmation is still recorded (items succeeded, run paid, salary journal posted), the fee is deferred (fee_posted = false, no fee journal) and listed for finance; re-posting is refused while inactive and posts exactly once after", async () => {
    const { runId, batchId, items } = await exportedRun();
    const restore = await deactivateBankCharges();
    let posting: Row;
    try {
      await W.confirm(batchId, W.succeedItems(batchId, items));

      for (const item of await W.itemsOf(batchId))
        expect(item.status, "the money left: the confirmation stays").toBe(
          "succeeded",
        );
      expect((await W.runRow(runId)).status).toBe("paid");
      [posting] = (await W.postingsOf(batchId)) as [Row];
      expect(await W.postingsOf(batchId)).toHaveLength(1);
      expect(posting.kind).toBe("settle");
      expect(posting.fee_posted, "fee deferred through the 8codi marker").toBe(
        false,
      );
      const feeKey = `payroll-payout-fee:${posting.item_set_hash}`;
      expect(await W.journalByKey(feeKey)).toBeUndefined();
      // The salary payable is settled against the source bank, whole.
      expect(
        await W.journalByKey(`payroll-payout:${posting.item_set_hash}`),
      ).toEqual({
        "2103": { debit: BUDI_NET + SITI_NET + ANDI_NET, credit: 0 },
        "1103": { debit: 0, credit: BUDI_NET + SITI_NET + ANDI_NET },
      });

      // Finance sees it in the deferred-fee list.
      const finance = await financeClient("Deferred Fee");
      const list = await finance.client.get(FEE_REPOST_LIST);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(
        (list.body.data as Row[]).find((row) => row.postingId === posting.id),
        "the deferred fee is listed",
      ).toMatchObject({ batchId, feeIdr: 3 * FEE });

      // Still inactive: the re-post is refused (4xx, not 500) and posts nothing.
      const early = await finance.client
        .post(`${BASE}/${batchId}/repost-fees`)
        .set(originHeader)
        .send({});
      expect(early.status, JSON.stringify(early.body)).toBe(409);
      expect(await W.journalByKey(feeKey)).toBeUndefined();
      expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(false);
    } finally {
      await restore();
    }

    await repostSkippedFees(batchId);
    await repostSkippedFees(batchId).catch(() => undefined);
    const feeKey = `payroll-payout-fee:${posting.item_set_hash}`;
    expect(await W.journalByKey(feeKey)).toEqual({
      "8101": { debit: 3 * FEE, credit: 0 },
      "1103": { debit: 0, credit: 3 * FEE },
    });
    expect(await W.countJournals(feeKey), "fee posted exactly once").toBe(1);
    expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(true);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
  });
});

// =========================================================================
// Architect findings: backfill of running batches, no config fallback for old
// batches, and the source GL account itself must be active and postable
// =========================================================================

describe("Architect findings on the frozen source", () => {
  it("[backfill-running-batches] migration 0355 freezes the config account on approved/exported manual_bank batches only; a finished old batch stays empty", async () => {
    const sourceA = await currentSourceBank();
    const approvedRun = await W.seedRun(slipsOf());
    const approved = await W.approvedBatch(approvedRun);
    const { batchId: exported, items } = await exportedRun();
    const finishedRun = await W.seedRun(slipsOf());
    const finished = await W.exportedBatch(finishedRun);
    await W.confirm(
      finished,
      W.succeedItems(
        finished,
        (await W.itemsOf(finished)).filter((i) => i.status === "exported"),
      ),
    );
    expect(items.length).toBeGreaterThan(0);
    const finishedStatus = (await W.batchById(finished)).status;
    expect(["approved", "exported"]).not.toContain(finishedStatus);

    for (const id of [approved, exported, finished])
      await clearFrozenSource(id);
    // Raw: the freeze trigger does not exist yet when the migration runs.
    await W.asTenant(async (c) => {
      for (const statement of backfillStatements()) await c.query(statement);
    }, true);

    expect((await W.batchById(approved)).source_bank_account_id).toBe(sourceA);
    expect((await W.batchById(exported)).source_bank_account_id).toBe(sourceA);
    expect(
      (await W.batchById(finished)).source_bank_account_id,
      "never guess the account of a finished batch from today's config",
    ).toBeNull();
  });

  it("[fee-repost-old-batch-no-frozen] a deferred fee of an old batch without a frozen account is refused 409 instead of using today's config; nothing is posted", async () => {
    const { batchId, items } = await exportedRun({ lockedJournal: false });
    const restoreCharges = await deactivateBankCharges();
    try {
      await W.confirm(batchId, W.succeedItems(batchId, items));
    } finally {
      await restoreCharges();
    }
    const [posting] = await W.postingsOf(batchId);
    expect(posting!.kind).toBe("settle_skipped");
    expect(posting!.fee_posted).toBe(false);
    await clearFrozenSource(batchId);
    // A posting from before the freeze carries no source either; since 900 F4
    // the service records the frozen account on every new posting, so the
    // fixture clears it too (triggers off) to stay a faithful old row.
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET source_gl_account_id = NULL WHERE id = $1`,
          [posting!.id],
        ),
      true,
    );
    await W.expectRefused(repostSkippedFees(batchId), {
      status: 409,
      code: SOURCE_CODE,
    });
    expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(false);
    expect(
      await W.journalByKey(`payroll-payout-fee:${posting!.item_set_hash}`),
    ).toBeUndefined();
  });

  for (const how of ["inactive", "header"] as const) {
    it(`[source-gl-${how}] a source bank account whose GL account (1103) is ${how} is refused 409 ${SOURCE_CODE} at approve and at confirm; works once fixed`, async () => {
      const runId = await W.seedRun(slipsOf());
      const batchId = await W.createBatch(runId);
      await W.inTx((tx) => submitDisbursementBatch(tx, actorOf(REQ), batchId));
      const hash = (await W.batchById(batchId)).content_hash as string;
      const sourceBankAccountId = await currentSourceBank();
      const approve = () =>
        W.inTx((tx) =>
          approveDisbursementBatch(tx, actorOf(APP), batchId, {
            contentHash: hash,
            sourceBankAccountId,
          }),
        );
      const restoreApprove = await breakGlAccount("1103", how);
      try {
        await W.expectRefused(approve(), { status: 409, code: SOURCE_CODE });
        expect((await W.batchById(batchId)).status).toBe("pending_approval");
      } finally {
        await restoreApprove();
      }
      await approve();

      const { batchId: running, items } = await exportedRun();
      const restoreConfirm = await breakGlAccount("1103", how);
      try {
        await W.expectRefused(
          W.confirm(running, W.succeedItems(running, items)),
          { status: 409, code: SOURCE_CODE },
        );
        for (const item of await W.itemsOf(running))
          expect(item.status, "no confirmation was recorded").toBe("exported");
        expect(await W.postingsOf(running)).toHaveLength(0);
      } finally {
        await restoreConfirm();
      }
      await W.confirm(running, W.succeedItems(running, items));
      expect((await W.postingsOf(running))[0]!.kind).toBe("settle");
    });
  }
});

void SITI;
void ANDI;
