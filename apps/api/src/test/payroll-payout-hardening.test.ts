// Payout hardening (beads legend-8codi, legend-qxkm6; brief
// docs/briefs/661-payroll-payout-hardening.md; contract chosen here in
// docs/briefs/661-test-contract.md). Written fail-first from the design
// (docs/design/payroll-disbursement.md 5.2, 7.8, 8, 9) and the CTO decisions in
// the beads, not from the implementation: none of the routes, columns or
// functions marked NEW in the contract file exist yet.
//
// Rules proven here (money: nobody is paid twice, the PT does not lose):
// - Fail closed: approve and export of a manual batch are refused while the
//   `bank_charges` mapping or the source bank account is missing; nothing moves.
// - A fee that was skipped (mapping vanished after the money left) is recorded
//   as `fee_posted = false`, listed for finance, and re-posted exactly once.
// - A return over HTTP needs `payroll.disburse.approve`, step-up (fresh MFA and,
//   after a first enrollment only, the password), and two people who are not
//   the creator; it reverses the journal exactly once to the original account.
// - An `overpaid` item is recorded as a receivable without any new payment.
// - The DB itself refuses `succeeded -> returned` without two distinct people.
//
// Assumptions (design silent, stated so they can be contested):
// - Refusal codes are `PAYOUT_BANK_CHARGES_MAPPING_MISSING` and
//   `PAYOUT_SOURCE_ACCOUNT_MISSING` (HTTP 409), like PAYOUT_CONFIG_BUSY.
// - The same step-up as confirm/resolve applies to the return route.
// - The fee re-post needs no step-up: it only books the stored fee as expense.
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { originHeader } from "./helpers.ts";
import { totpCode, totpStep } from "../lib/totp.ts";
import * as glService from "../services/payroll-payout-gl.service.ts";
import {
  approveDisbursementBatch,
  createDisbursementBatch,
  submitDisbursementBatch,
} from "../services/payroll-payout.service.ts";
import {
  exportManualBatch,
  returnManualItems,
} from "../services/payroll-payout-manual.service.ts";
import {
  ANDI,
  APP,
  APP2,
  APP3,
  BUDI,
  REQ,
  SITI,
  actorOf,
  bank,
  evidenceKeyFor,
  uploadEvidence,
  installPayoutWorld,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("hardening");
const PASSWORD = "Test-password-123!";
const WRONG_PASSWORD = "Salah-password-999!";
const BASE = "/api/hris/payroll/disbursement-batches";
const FEE_REPOST_LIST = "/api/hris/payroll/payout-fee-reposts";

const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const FEE = 5_000;
const slipsOf = () => [
  bank(BUDI, BUDI_NET),
  bank(SITI, SITI_NET),
  bank(ANDI, ANDI_NET),
];
const idOf = (row: Row) => row.id as string;
const errorCodeOf = (body: { error?: { code?: string } }) => body.error?.code;

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

// ---- NEW service functions, looked up by name so a missing one fails the
// test with a clear message instead of breaking the type check ---------------
type Tx = Parameters<Parameters<typeof W.inTx>[0]>[0];
function glFn<T extends (...args: never[]) => unknown>(name: string): T {
  const fn = (glService as Record<string, unknown>)[name];
  if (typeof fn !== "function")
    throw new Error(
      `services/payroll-payout-gl.service.ts must export ${name} (NEW, see docs/briefs/661-test-contract.md)`,
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

// ---- Setup helpers --------------------------------------------------------

/** A locked run with an exported manual batch, ready to confirm. */
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
const currentSourceBank = async () =>
  (
    await W.rowsOf(
      `SELECT manual_source_bank_account_id AS id FROM payroll_payout_configs
        WHERE tenant_id = $1 AND legal_entity_id = $2`,
      [W.tenantId, W.entityId()],
    )
  )[0]!.id as string;
/**
 * The source bank account becomes unusable: deactivated. The config column is
 * NOT NULL, so a deactivated (or deleted) account is the realistic gap.
 * Returns the restore.
 */
async function breakSource() {
  const id = await currentSourceBank();
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
     SELECT $1, $2, 'BCA', 'Rekening Baru', '\\x00', $3, '1111', 1, id, 'payout-hardening-test'
       FROM chart_of_accounts
      WHERE tenant_id = $1 AND legal_entity_id = $2 AND code = '1101'
     RETURNING id`,
    [W.tenantId, W.entityId(), "e".repeat(64)],
  );
  return row!.id as string;
}

// ---- HTTP people ----------------------------------------------------------

/**
 * A staff member with payroll.disburse.approve whose only second-factor proof
 * is the enrollment itself (same helper shape as payroll-payout-evidence).
 */
async function approverClient(label: string) {
  const { client, userId } = await W.signedInClient(`Hardening ${label}`);
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
  return { client, userId };
}
type Approver = Awaited<ReturnType<typeof approverClient>>;

/**
 * A manual batch paid in full, created by a REAL user (so the creator can try
 * the HTTP route too): created by `creator`, approved by APP, exported, then
 * confirmed by APP2. The settle journal and fee journal are posted.
 */
async function paidBatchCreatedBy(creator: Approver) {
  const slips = slipsOf();
  const runId = await W.seedRun(slips);
  await W.postLockedJournal(runId, slips);
  await W.inTx((tx) =>
    createDisbursementBatch(tx, actorOf(creator.userId), {
      payrollRunId: runId,
      channel: "manual_bank",
    } as never),
  );
  const [batch] = await W.rowsOf(
    `SELECT id, content_hash FROM payroll_disbursement_batches
      WHERE tenant_id = $1 AND payroll_run_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [W.tenantId, runId],
  );
  const batchId = batch!.id as string;
  await W.inTx((tx) =>
    submitDisbursementBatch(tx, actorOf(creator.userId), batchId),
  );
  const hash = (await W.batchById(batchId)).content_hash as string;
  const sourceBankAccountId = await currentSourceBank();
  await W.inTx((tx) =>
    approveDisbursementBatch(tx, actorOf(APP), batchId, {
      contentHash: hash,
      sourceBankAccountId,
    }),
  );
  await W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  await W.confirm(batchId, W.succeedItems(batchId, items), APP2);
  return { runId, batchId };
}

const returnBody = (batchId: string, itemId: string, password?: string) => ({
  itemIds: [itemId],
  evidenceKey: uploadEvidence(batchId, "dana-kembali.pdf"),
  note: "Bank mengembalikan dana, rekening tujuan ditutup",
  ...(password === undefined ? {} : { password }),
});
const postReturn = (
  who: Approver,
  batchId: string,
  itemId: string,
  password?: string,
) =>
  who.client
    .post(`${BASE}/${batchId}/return`)
    .set(originHeader)
    .send(returnBody(batchId, itemId, password));

const returnKey = (itemId: string) => `payroll-payout-return:${itemId}`;

// =========================================================================
// legend-8codi (1): approve and export fail closed
// =========================================================================

describe("approve and export are refused without the accounting setup (8codi)", () => {
  const breakers = {
    "bank_charges mapping": {
      break: breakMapping,
      code: "PAYOUT_BANK_CHARGES_MAPPING_MISSING",
    },
    "source bank account": {
      break: breakSource,
      code: "PAYOUT_SOURCE_ACCOUNT_MISSING",
    },
  } as const;

  for (const [label, setup] of Object.entries(breakers)) {
    it(`[approve-no-${label.split(" ")[0]}] approving a submitted batch without the ${label} is refused 409 ${setup.code}; the batch stays pending, and works again once fixed`, async () => {
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

      const restore = await setup.break();
      try {
        await W.expectRefused(approve(), { status: 409, code: setup.code });
        const batch = await W.batchById(batchId);
        expect(batch.status).toBe("pending_approval");
        expect(batch.approved_by).toBeNull();
        for (const item of await W.itemsOf(batchId))
          expect(item.status, "no item moved to approved").toBe("prepared");
      } finally {
        await restore();
      }

      await approve();
      expect((await W.batchById(batchId)).status).toBe("approved");
    });

    it(`[export-no-${label.split(" ")[0]}] downloading the bank file without the ${label} is refused 409 ${setup.code}; no file, items stay approved, and the one download still works once fixed`, async () => {
      const runId = await W.seedRun(slipsOf());
      const batchId = await W.approvedBatch(runId);
      const exportFile = () =>
        W.inTx((tx) => exportManualBatch(tx, actorOf(APP), batchId));

      const restore = await setup.break();
      try {
        await W.expectRefused(exportFile(), { status: 409, code: setup.code });
        const batch = await W.batchById(batchId);
        expect(batch.status).toBe("approved");
        expect(batch.exported_at, "the one download is not spent").toBeNull();
        for (const item of await W.itemsOf(batchId))
          expect(item.status).toBe("approved");
      } finally {
        await restore();
      }

      await exportFile();
      expect((await W.batchById(batchId)).status).toBe("exported");
    });
  }
});

// =========================================================================
// legend-8codi (2): a skipped fee is recorded and re-posted exactly once
// =========================================================================

describe("a skipped bank fee is recorded and re-posted exactly once (8codi)", () => {
  /** Confirms with the mapping gone (it vanished after the file was downloaded). */
  async function confirmedWithoutMapping(
    options: { lockedJournal?: boolean } = {},
  ) {
    const run = await exportedRun(options);
    const restore = await breakMapping();
    try {
      await W.confirm(run.batchId, W.succeedItems(run.batchId, run.items));
    } catch (error) {
      await restore();
      throw error;
    }
    const [posting] = await W.postingsOf(run.batchId);
    return { ...run, posting: posting!, restore };
  }
  const feeKey = (posting: Row) =>
    `payroll-payout-fee:${posting.item_set_hash}`;
  const feeJournal = {
    "8101": { debit: 3 * FEE, credit: 0 },
    "1103": { debit: 0, credit: 3 * FEE },
  };

  it("[fee-posted-flag] control: with the mapping the fee is posted and the posting says fee_posted = true", async () => {
    const { batchId, items } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items));
    const [posting] = await W.postingsOf(batchId);
    expect(posting!.fee_posted).toBe(true);
    expect(await W.journalByKey(feeKey(posting!))).toEqual(feeJournal);
  });

  for (const lockedJournal of [true, false]) {
    const kind = lockedJournal ? "settle" : "settle_skipped";
    it(`[fee-skipped-recorded-${kind}] without the mapping the confirmation still succeeds (the money is gone), no fee journal is posted and the posting says fee_posted = false`, async () => {
      const { runId, batchId, posting, restore } =
        await confirmedWithoutMapping({ lockedJournal });
      await restore();
      expect(posting.kind).toBe(kind);
      expect(posting.fee_posted).toBe(false);
      expect(await W.journalByKey(feeKey(posting))).toBe(undefined);
      for (const item of await W.itemsOf(batchId))
        expect(item.status).toBe("succeeded");
      expect((await W.runRow(runId)).status).toBe("paid");
    });
  }

  it("[fee-repost-once] finance re-posts the skipped fee: Dr 8101 / Cr 1103 once, fee_posted turns true, and repeating it, one after the other or at the same time, posts nothing more", async () => {
    const { batchId, posting, restore } = await confirmedWithoutMapping();
    await restore();
    const salaryBefore = await W.journalByKey(
      `payroll-payout:${posting.item_set_hash}`,
    );

    await repostSkippedFees(batchId);
    expect(await W.journalByKey(feeKey(posting))).toEqual(feeJournal);
    const [after] = await W.postingsOf(batchId);
    expect(after!.fee_posted).toBe(true);

    await repostSkippedFees(batchId).catch(() => undefined);
    await Promise.allSettled([
      repostSkippedFees(batchId),
      repostSkippedFees(batchId, APP3),
    ]);
    expect(await W.countJournals(feeKey(posting))).toBe(1);
    // The salary journal and the postings are untouched by the re-post.
    expect(
      await W.journalByKey(`payroll-payout:${posting.item_set_hash}`),
    ).toEqual(salaryBefore);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
  });

  it("[fee-repost-concurrent] two simultaneous first re-posts: exactly one fee journal", async () => {
    const { batchId, posting, restore } = await confirmedWithoutMapping();
    await restore();
    const outcomes = await Promise.allSettled([
      repostSkippedFees(batchId),
      repostSkippedFees(batchId, APP3),
    ]);
    expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
    expect(await W.countJournals(feeKey(posting))).toBe(1);
    expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(true);
  });

  it("[fee-repost-needs-mapping] re-posting while the mapping is still missing is refused 409 PAYOUT_BANK_CHARGES_MAPPING_MISSING and posts nothing", async () => {
    const { batchId, posting, restore } = await confirmedWithoutMapping();
    try {
      await W.expectRefused(repostSkippedFees(batchId), {
        status: 409,
        code: "PAYOUT_BANK_CHARGES_MAPPING_MISSING",
      });
      expect(await W.journalByKey(feeKey(posting))).toBe(undefined);
      expect((await W.postingsOf(batchId))[0]!.fee_posted).toBe(false);
    } finally {
      await restore();
    }
    await repostSkippedFees(batchId);
    expect(await W.countJournals(feeKey(posting))).toBe(1);
  });

  it("[fee-repost-http] finance sees the skipped fee in the list and re-posts it over HTTP; without payroll.disburse.approve it is 403 and nothing is posted", async () => {
    const { batchId, posting, restore } = await confirmedWithoutMapping();
    await restore();
    const viewer = await W.signedInClient("Hardening Fee Viewer");
    await W.grantRole(viewer.userId, ["payroll.view"]);
    const finance = await approverClient("Fee Finance");

    const list = await finance.client.get(FEE_REPOST_LIST);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const listed = (list.body.data as Row[]).find(
      (row) => row.postingId === posting.id,
    );
    expect(listed, "the skipped fee is listed").toMatchObject({
      batchId,
      feeIdr: 3 * FEE,
    });

    const denied = await viewer.client
      .post(`${BASE}/${batchId}/repost-fees`)
      .set(originHeader)
      .send({});
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(await W.journalByKey(feeKey(posting))).toBe(undefined);

    const ok = await finance.client
      .post(`${BASE}/${batchId}/repost-fees`)
      .set(originHeader)
      .send({});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await W.journalByKey(feeKey(posting))).toEqual(feeJournal);

    const again = await finance.client
      .post(`${BASE}/${batchId}/repost-fees`)
      .set(originHeader)
      .send({});
    expect(again.status).toBeLessThan(500);
    expect(await W.countJournals(feeKey(posting))).toBe(1);
    const after = await finance.client.get(FEE_REPOST_LIST);
    expect(
      (after.body.data as Row[]).some((row) => row.postingId === posting.id),
      "no longer listed once posted",
    ).toBe(false);
  });
});

// =========================================================================
// legend-qxkm6 (3): return over HTTP
// =========================================================================

describe("return of a paid item over HTTP (qxkm6)", () => {
  it("[return-http-permission] without payroll.disburse.approve the return is 403 and changes nothing", async () => {
    const creator = await approverClient("Return Creator Perm");
    const { batchId } = await paidBatchCreatedBy(creator);
    const budi = await W.itemOfPerson(batchId, BUDI);
    const viewer = await W.signedInClient("Hardening Return Viewer");
    await W.grantRole(viewer.userId, ["payroll.view"]);

    const res = await viewer.client
      .post(`${BASE}/${batchId}/return`)
      .set(originHeader)
      .send(returnBody(batchId, idOf(budi), PASSWORD));
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const row = await W.itemOfPerson(batchId, BUDI);
    expect(row.status).toBe("succeeded");
    expect(row.returned_by).toBeNull();
  });

  it("[return-http-stepup] without the password the return is 401 REAUTH_REQUIRED, with a wrong one refused, and nothing is recorded; with the right one only the first step is recorded", async () => {
    const creator = await approverClient("Return Creator Step");
    const { batchId } = await paidBatchCreatedBy(creator);
    const budi = await W.itemOfPerson(batchId, BUDI);
    const first = await approverClient("Return First");

    const without = await postReturn(first, batchId, idOf(budi));
    expect(without.status, JSON.stringify(without.body)).toBe(401);
    expect(errorCodeOf(without.body)).toBe("REAUTH_REQUIRED");
    const wrong = await postReturn(first, batchId, idOf(budi), WRONG_PASSWORD);
    expect([401, 403], JSON.stringify(wrong.body)).toContain(wrong.status);
    let row = await W.itemOfPerson(batchId, BUDI);
    expect(row.status).toBe("succeeded");
    expect(row.returned_by, "no first step recorded").toBeNull();

    const ok = await postReturn(first, batchId, idOf(budi), PASSWORD);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    row = await W.itemOfPerson(batchId, BUDI);
    expect(row.status, "one person is not enough").toBe("succeeded");
    expect(row.returned_by).toBe(first.userId);
    expect(await W.journalByKey(returnKey(idOf(budi)))).toBe(undefined);
  });

  it("[return-http-two-people-once] the creator and the same person twice are refused; a second different person completes it: the journal is reversed once into the account the settle used, even after the source moved", async () => {
    const creator = await approverClient("Return Creator Two");
    const { runId, batchId } = await paidBatchCreatedBy(creator);
    const budi = await W.itemOfPerson(batchId, BUDI);
    const first = await approverClient("Return A");
    const second = await approverClient("Return B");
    const third = await approverClient("Return C");

    // The creator never counts, even with every credential.
    const byCreator = await postReturn(creator, batchId, idOf(budi), PASSWORD);
    expect(
      byCreator.status,
      JSON.stringify(byCreator.body),
    ).toBeGreaterThanOrEqual(400);
    expect(byCreator.status).toBeLessThan(500);
    expect((await W.itemOfPerson(batchId, BUDI)).returned_by).toBeNull();

    expect(
      (await postReturn(first, batchId, idOf(budi), PASSWORD)).status,
    ).toBe(200);
    const same = await postReturn(first, batchId, idOf(budi), PASSWORD);
    expect(same.status, "the same person twice").toBeGreaterThanOrEqual(400);
    expect(same.status).toBeLessThan(500);
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("succeeded");
    expect(await W.countJournals(returnKey(idOf(budi)))).toBe(0);

    // Finance moved the source to another bank account (GL 1101) meanwhile.
    const oldSource = await currentSourceBank();
    await setSourceBank(await otherBankAccount());
    try {
      const done = await postReturn(second, batchId, idOf(budi), PASSWORD);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    } finally {
      await setSourceBank(oldSource);
    }

    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
    expect(await W.journalByKey(returnKey(idOf(budi)))).toEqual({
      "1103": { debit: BUDI_NET, credit: 0 },
      "2103": { debit: 0, credit: BUDI_NET },
    });

    // Once more, by anyone: the item is no longer paid.
    const again = await postReturn(third, batchId, idOf(budi), PASSWORD);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(again.status).toBeLessThan(500);
    expect(await W.countJournals(returnKey(idOf(budi)))).toBe(1);
    expect(await W.postingsOf(batchId)).toHaveLength(1);
    expect((await W.itemOfPerson(batchId, SITI)).status).toBe("succeeded");
    expect((await W.runRow(runId)).status).toBe("paid");
  });

  it("[return-http-concurrent] two different second people at the same moment: one wins, one refused, one reversal journal", async () => {
    const creator = await approverClient("Return Creator Race");
    const { batchId } = await paidBatchCreatedBy(creator);
    const budi = await W.itemOfPerson(batchId, BUDI);
    const first = await approverClient("Race A");
    const second = await approverClient("Race B");
    const third = await approverClient("Race C");
    expect(
      (await postReturn(first, batchId, idOf(budi), PASSWORD)).status,
    ).toBe(200);

    const [b, c] = await Promise.all([
      postReturn(second, batchId, idOf(budi), PASSWORD),
      postReturn(third, batchId, idOf(budi), PASSWORD),
    ]);
    expect([b.status, c.status].filter((s) => s === 200)).toHaveLength(1);
    expect(Math.max(b.status, c.status)).toBeLessThan(500);
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
    expect(await W.countJournals(returnKey(idOf(budi)))).toBe(1);
    expect(await W.journalByKey(returnKey(idOf(budi)))).toEqual({
      "1103": { debit: BUDI_NET, credit: 0 },
      "2103": { debit: 0, credit: BUDI_NET },
    });
  });

  it("[return-evidence-mismatch] the second step with another evidence key than the first is refused 409 PAYOUT_RETURN_EVIDENCE_MISMATCH: item stays succeeded, no journal; the same key passes", async () => {
    const { batchId, items } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items));
    const budi = await W.itemOfPerson(batchId, BUDI);
    const returnWith = (by: string, file: string) =>
      W.inTx((tx: Tx) =>
        returnManualItems(
          tx,
          actorOf(by),
          batchId,
          {
            itemIds: [idOf(budi)],
            evidenceKey: uploadEvidence(batchId, file),
            note: "Bank mengembalikan dana, rekening tujuan ditutup",
          } as never,
          W.proofs(),
        ),
      );

    await returnWith(APP, "dana-kembali.pdf");
    const mismatch = await returnWith(APP3, "lain.pdf").then(
      () => null,
      (error: unknown) => error as { status?: number; code?: string },
    );
    expect(mismatch, "a different evidence key must be refused").not.toBeNull();
    expect(mismatch?.status).toBe(409);
    expect(mismatch?.code).toBe("PAYOUT_RETURN_EVIDENCE_MISMATCH");
    const row = await W.itemOfPerson(batchId, BUDI);
    expect(row.status).toBe("succeeded");
    expect(row.returned_by_2).toBeNull();
    expect(await W.countJournals(returnKey(idOf(budi)))).toBe(0);

    await returnWith(APP3, "dana-kembali.pdf");
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("returned");
    expect(await W.countJournals(returnKey(idOf(budi)))).toBe(1);
  });
});

// =========================================================================
// legend-qxkm6 (4): overpaid is recorded, nothing extra is paid
// =========================================================================

describe("an overpaid item is recorded as a receivable without paying again (qxkm6)", () => {
  /**
   * Budi's first transfer is resolved `failed` (two people), the other two are
   * paid, a follow-up batch pays Budi and is confirmed. Then the first
   * transfer turns out to have reached Budi after all.
   */
  async function lateDoublePayment() {
    const { runId, batchId, items } = await exportedRun();
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

  it("[overpaid-recorded] the late transfer becomes `overpaid`: Dr 1204 employee receivable / Cr 1103 once under its own key, no new attempt or batch is created, the paid journals stay whole, replays post nothing", async () => {
    const { runId, batchId, followUp, budiFirst } = await lateDoublePayment();
    const before = {
      items: (
        await W.rowsOf(
          `SELECT count(*)::int AS n FROM payroll_disbursement_items WHERE payroll_run_id = $1`,
          [runId],
        )
      )[0]!.n,
      batches: (
        await W.rowsOf(
          `SELECT count(*)::int AS n FROM payroll_disbursement_batches WHERE payroll_run_id = $1`,
          [runId],
        )
      )[0]!.n,
      settle: await W.postingsOf(followUp),
    };
    expect(before.batches).toBe(2);

    await recordOverpaidItem(idOf(budiFirst), batchId);

    const key = `payroll-payout-overpaid:${idOf(budiFirst)}`;
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("overpaid");
    expect(await W.journalByKey(key)).toEqual({
      "1204": { debit: BUDI_NET, credit: 0 },
      "1103": { debit: 0, credit: BUDI_NET },
    });
    const overpaidPosting = (
      await W.rowsOf(
        `SELECT * FROM payroll_payout_gl_postings
          WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'overpaid'`,
        [W.tenantId, batchId],
      )
    )[0];
    expect(overpaidPosting, "an overpaid posting row").toBeDefined();
    expect(overpaidPosting!.journal_key).toBe(key);
    expect((await W.itemOfPerson(batchId, BUDI)).gl_posting_id).toBe(
      overpaidPosting!.id,
    );

    // Nothing was paid: no new attempt, no new batch, one live success per slip.
    const after = {
      items: (
        await W.rowsOf(
          `SELECT count(*)::int AS n FROM payroll_disbursement_items WHERE payroll_run_id = $1`,
          [runId],
        )
      )[0]!.n,
      batches: (
        await W.rowsOf(
          `SELECT count(*)::int AS n FROM payroll_disbursement_batches WHERE payroll_run_id = $1`,
          [runId],
        )
      )[0]!.n,
    };
    expect(after.items).toBe(before.items);
    expect(after.batches).toBe(before.batches);
    const [{ n: live }] = (await W.rowsOf(
      `SELECT count(*)::int AS n FROM payroll_disbursement_items
        WHERE payroll_run_id = $1 AND employee_id = $2 AND status = 'succeeded'`,
      [runId, BUDI.id],
    )) as [{ n: number }];
    expect(live).toBe(1);
    expect((await W.postingsOf(followUp)).map(idOf)).toEqual(
      before.settle.map(idOf),
    );
    expect((await W.runRow(runId)).status).toBe("paid");

    // Replays: the item is no longer `failed`.
    await W.expectRefused(recordOverpaidItem(idOf(budiFirst), batchId));
    const outcomes = await Promise.allSettled([
      recordOverpaidItem(idOf(budiFirst), batchId),
      recordOverpaidItem(idOf(budiFirst), batchId, APP3),
    ]);
    expect(outcomes.every((o) => o.status === "rejected")).toBe(true);
    expect(await W.countJournals(key)).toBe(1);
  });

  it("[overpaid-concurrent] two simultaneous first reports: one overpaid journal", async () => {
    const { batchId, budiFirst } = await lateDoublePayment();
    const outcomes = await Promise.allSettled([
      recordOverpaidItem(idOf(budiFirst), batchId),
      recordOverpaidItem(idOf(budiFirst), batchId, APP3),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(
      await W.countJournals(`payroll-payout-overpaid:${idOf(budiFirst)}`),
    ).toBe(1);
  });

  it("[overpaid-needs-a-paid-slip] a failed item whose slip has no other paid attempt is not overpaid: refused, no journal, the item stays failed", async () => {
    const { batchId, items } = await exportedRun();
    const budi = items.find((i) => i.employee_id === BUDI.id)!;
    await W.resolve(batchId, [idOf(budi)], "failed", APP);
    await W.resolve(batchId, [idOf(budi)], "failed", APP3);

    await W.expectRefused(recordOverpaidItem(idOf(budi), batchId));
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("failed");
    expect(await W.countJournals(`payroll-payout-overpaid:${idOf(budi)}`)).toBe(
      0,
    );
  });

  it("[overpaid-settled-account] the receivable is booked against the account the settle used, even after the config source moved", async () => {
    const { batchId, budiFirst } = await lateDoublePayment();
    const oldSource = await currentSourceBank();
    await setSourceBank(await otherBankAccount());
    try {
      await recordOverpaidItem(idOf(budiFirst), batchId);
    } finally {
      await setSourceBank(oldSource);
    }
    expect(
      await W.journalByKey(`payroll-payout-overpaid:${idOf(budiFirst)}`),
    ).toEqual({
      "1204": { debit: BUDI_NET, credit: 0 },
      "1103": { debit: 0, credit: BUDI_NET },
    });
  });

  it("[overpaid-channel] a batch that is not manual_bank (duitku) is refused 409: the item stays failed, no journal", async () => {
    const { batchId, budiFirst } = await lateDoublePayment();
    // A duitku batch carries no bank file: the file columns go and come back.
    const saved = await W.batchById(batchId);
    const setChannel = (channel: string, file: Row) =>
      W.asTenant(
        (c) =>
          c.query(
            `UPDATE payroll_disbursement_batches
                SET channel = $2, bank_format = $3, export_checksum_sha256 = $4,
                    exported_at = $5, exported_by = $6
              WHERE id = $1`,
            [
              batchId,
              channel,
              file.bank_format,
              file.export_checksum_sha256,
              file.exported_at,
              file.exported_by,
            ],
          ),
        true,
      );
    await setChannel("duitku", {
      bank_format: null,
      export_checksum_sha256: null,
      exported_at: null,
      exported_by: null,
    });
    try {
      const error = await recordOverpaidItem(idOf(budiFirst), batchId).then(
        () => null,
        (e: unknown) => e as { status?: number; code?: string },
      );
      expect(error, "a duitku batch must be refused").not.toBeNull();
      expect(error?.status).toBe(409);
      expect(error?.code).toBe("PAYOUT_CHANNEL_MISMATCH");
    } finally {
      await setChannel("manual_bank", saved);
    }
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("failed");
    expect(
      await W.countJournals(`payroll-payout-overpaid:${idOf(budiFirst)}`),
    ).toBe(0);
  });

  it("[overpaid-slip-not-open] a slip with an overpaid item is not open for a new batch, even when the sibling attempt was returned later: nothing new is created for it", async () => {
    const { runId, batchId, followUp, budiFirst } = await lateDoublePayment();
    await recordOverpaidItem(idOf(budiFirst), batchId);
    // The sibling payment comes back from the bank: two people, evidence, note.
    const sibling = await W.itemOfPerson(followUp, BUDI);
    await W.asTenant((c) =>
      c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'returned', returned_at = now(), returned_by = $2,
                returned_by_2 = $3, return_evidence_key = $4,
                return_note = 'Dana kembali dari bank'
          WHERE id = $1`,
        [
          idOf(sibling),
          APP,
          APP3,
          evidenceKeyFor(W.tenantId, followUp, "dana-kembali.pdf"),
        ],
      ),
    );
    expect((await W.itemOfPerson(followUp, BUDI)).status).toBe("returned");
    const countItems = async () =>
      (
        await W.rowsOf(
          `SELECT count(*)::int AS n FROM payroll_disbursement_items
            WHERE payroll_run_id = $1 AND employee_id = $2`,
          [runId, BUDI.id],
        )
      )[0]!.n;
    const before = await countItems();

    // Budi's slip is the only one left unpaid, and it is not open: nothing to pay.
    await W.expectRefused(W.createBatch(runId), {
      status: 409,
      code: "PAYOUT_NOTHING_TO_PAY",
    });
    expect(await countItems()).toBe(before);
  });

  it("[db-overpaid-guard] failed -> overpaid with only the GUC set is rejected by the DB without a posting link and another succeeded attempt of the same slip", async () => {
    const guarded = (itemId: string) =>
      W.asTenant(async (c) => {
        await c.query("SELECT set_config('app.payout_overpaid', 'on', true)");
        await c.query(
          `UPDATE payroll_disbursement_items SET status = 'overpaid' WHERE id = $1`,
          [itemId],
        );
      }).then(
        () => null,
        (error: unknown) => error as { code?: string; message: string },
      );

    // No sibling succeeded, no posting.
    const lone = await exportedRun();
    const loneBudi = lone.items.find((i) => i.employee_id === BUDI.id)!;
    await W.resolve(lone.batchId, [idOf(loneBudi)], "failed", APP);
    await W.resolve(lone.batchId, [idOf(loneBudi)], "failed", APP3);
    expect(
      await guarded(idOf(loneBudi)),
      "no sibling, no posting",
    ).not.toBeNull();
    expect((await W.itemOfPerson(lone.batchId, BUDI)).status).toBe("failed");

    // A succeeded sibling exists, still no posting.
    const { batchId, budiFirst } = await lateDoublePayment();
    const error = await guarded(idOf(budiFirst));
    expect(error, "sibling but no posting").not.toBeNull();
    expect(typeof error?.code).toBe("string");
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("failed");

    // A sibling succeeded and a posting is linked, but it is the settle
    // posting, not this item's own overpaid posting.
    const settle = (
      await W.rowsOf(
        `SELECT id FROM payroll_payout_gl_postings
          WHERE tenant_id = $1 AND batch_id = $2 AND kind = 'settle' LIMIT 1`,
        [W.tenantId, batchId],
      )
    )[0];
    expect(settle, "a settle posting exists").toBeDefined();
    const linked = await W.asTenant(async (c) => {
      await c.query("SELECT set_config('app.payout_overpaid', 'on', true)");
      await c.query(
        `UPDATE payroll_disbursement_items
            SET status = 'overpaid', gl_posting_id = $2 WHERE id = $1`,
        [idOf(budiFirst), settle!.id],
      );
    }).then(
      () => null,
      (e: unknown) => e as { code?: string; message: string },
    );
    expect(linked, "a link to the settle posting is rejected").not.toBeNull();
    expect(typeof linked?.code).toBe("string");
    expect((await W.itemOfPerson(batchId, BUDI)).status).toBe("failed");
  });
});

// =========================================================================
// legend-qxkm6 (5): the DB refuses succeeded -> returned without two people
// =========================================================================

describe("the database guards succeeded -> returned (qxkm6)", () => {
  /** A raw UPDATE as the table owner with triggers ON; the pg error, or null. */
  const rawUpdate = (itemId: string, set: string, params: unknown[] = []) =>
    W.asTenant((c) =>
      c.query(`UPDATE payroll_disbursement_items SET ${set} WHERE id = $1`, [
        itemId,
        ...params,
      ]),
    ).then(
      () => null,
      (error: unknown) => error as { code?: string; message: string },
    );

  async function paidItems() {
    const { batchId, items } = await exportedRun();
    await W.confirm(batchId, W.succeedItems(batchId, items));
    return { batchId, items: await W.itemsOf(batchId) };
  }

  it("[db-return-two-people] succeeded -> returned by plain SQL is rejected unless two different people are recorded on the row; nothing changes on rejection", async () => {
    const { batchId, items } = await paidItems();
    const [none, onlyOne, control] = items as [Row, Row, Row];

    for (const [label, row, set] of [
      ["no resolver", none, `status = 'returned', returned_at = now()`],
      [
        "one resolver",
        onlyOne,
        `status = 'returned', returned_at = now(), returned_by = '${APP}',
         return_evidence_key = 'x', return_note = 'x'`,
      ],
    ] as const) {
      const error = await rawUpdate(idOf(row), set);
      expect(error, `${label}: the DB must reject it`).not.toBeNull();
      expect(
        typeof error?.code,
        `${label}: a database error, not a client one`,
      ).toBe("string");
      const current = (await W.itemsOf(batchId)).find((i) => i.id === row.id)!;
      expect(current.status, `${label}: still paid`).toBe("succeeded");
      expect(current.returned_at).toBeNull();
    }

    // Control: two different people, evidence and note: the same move passes.
    const ok = await rawUpdate(
      idOf(control),
      `status = 'returned', returned_at = now(), returned_by = $2, returned_by_2 = $3,
       return_evidence_key = $4, return_note = 'Dana kembali dari bank'`,
      [APP, APP3, evidenceKeyFor(W.tenantId, batchId, "dana-kembali.pdf")],
    );
    expect(ok, JSON.stringify(ok)).toBeNull();
    expect(
      (await W.itemsOf(batchId)).find((i) => i.id === control.id)!.status,
    ).toBe("returned");
  });
});
