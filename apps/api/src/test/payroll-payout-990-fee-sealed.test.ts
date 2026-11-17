// Payout 990 phase 5, part B (bead legend-w9od2): the night recon compares the
// fee of an overpaid posting with the sealed fee of its item. Written fail-first
// from the brief (docs/briefs/990/phase5.md "Kontrak B"), NOT from the
// implementation.
//
// Rules proven (founder: the GL matches the money that moved; a forged fee
// never lowers or raises what is booked):
// - An overpaid posting whose fee_idr differs from the fee sealed on its item
//   (payroll_disbursement_items.fee_idr_encrypted) is flagged
//   `fee_sealed_mismatch` on that item, and the flag holds the payslip. Also
//   when the sealed fee cannot be read (fail closed).
// - A fee journal `payroll-payout-overpaid-fee:<item>` whose total debit is not
//   the posting's fee_idr is flagged `fee_journal_amount`.
// - The legit flow (same fee, same journal) is not flagged for either reason.
// - Another tenant is not flagged by this tenant's run.
//
// Assumptions (the brief leaves them open, stated so they can be contested):
// - The forgeries are made by the table owner with guards off (the same way the
//   990 fee-commit test forges): payroll_payout_gl_postings.fee_idr, the lines
//   of the fee journal, or the sealed fee bytes of the item. The world is a real
//   overpaid item built through the services (fee Rp5.000).
// - Asserted: the exception reason CONTAINS the new reason and its item_id is
//   the overpaid item; the kind is not asserted. "Held" = the SQL helper
//   app.payout_payslip_held_by_recon(tenant, payslip) is true for the flag's
//   payslip (it is false in the legit control).
// - Other flags the recon may raise for a forged posting (e.g. both reasons
//   when the posting fee is raised) are allowed; only the named reason matters,
//   and where one reason must NOT appear (journal amount forged, posting fee
//   untouched) that is asserted.
// - Recon entry point: same adapter as the 990 fee-commit test.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as glService from "../services/payroll-payout-gl.service.ts";
import {
  APP,
  APP3,
  BUDI,
  SITI,
  ANDI,
  actorOf,
  bank,
  installPayoutWorld,
  uploadEvidence,
  type Row,
} from "./payroll-payout-fixtures.ts";

const W = installPayoutWorld("990feesealed");
const FEE = 5_000;
const BUDI_NET = 4_250_000;
const SITI_NET = 3_100_500;
const ANDI_NET = 5_000_001;
const NOTE = "Mutasi bank menunjukkan transfer kedua untuk slip yang sama";
const EXCEPTIONS = "payroll_payout_recon_exceptions";
const FEE_PREFIX = "payroll-payout-overpaid-fee:";
const SEALED = "fee_sealed_mismatch";
const JOURNAL_AMOUNT = "fee_journal_amount";

type Tx = Parameters<Parameters<typeof W.inTx>[0]>[0];
const foreignTenants: string[] = [];

beforeAll(() => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
});

afterEach(async () => {
  await W.asTenant(async (c) => {
    await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [
      W.tenantId,
    ]);
    for (const id of foreignTenants.splice(0)) {
      await c.query(`DELETE FROM ${EXCEPTIONS} WHERE tenant_id = $1`, [id]);
      await c.query(
        `DELETE FROM payroll_disbursement_items WHERE tenant_id = $1`,
        [id],
      );
      await c.query(
        `DELETE FROM payroll_payout_gl_postings WHERE tenant_id = $1`,
        [id],
      );
      await c.query(`DELETE FROM tenants WHERE id = $1`, [id]);
    }
  }, true);
});

// ---- Worlds (patterns of the 990 fee-commit test) -------------------------------------

const idOf = (row: Row) => row.id as string;

async function exportedRun(withLockedJournal = true) {
  const slips = [
    bank(BUDI, BUDI_NET),
    bank(SITI, SITI_NET),
    bank(ANDI, ANDI_NET),
  ];
  const runId = await W.seedRun(slips);
  if (withLockedJournal) await W.postLockedJournal(runId, slips);
  const batchId = await W.exportedBatch(runId);
  const items = (await W.itemsOf(batchId)).filter(
    (i) => i.status === "exported",
  );
  return { runId, batchId, items };
}

/** Budi's first transfer failed (two people), a follow-up paid him: a double payment candidate. */
async function lateDoublePayment(withLockedJournal = true) {
  const { runId, batchId, items } = await exportedRun(withLockedJournal);
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
  expect(followItems, "premise: one follow-up attempt").toHaveLength(1);
  await W.confirm(followUp, W.succeedItems(followUp, followItems));
  return { runId, batchId, followUp, itemId: idOf(budiFirst) };
}

const recordOverpaidItem = async (itemId: string, batchId: string) => {
  await W.proposeOverpaid(
    batchId,
    itemId,
    uploadEvidence(batchId, "mutasi-bank.pdf"),
    NOTE,
    APP,
  );
  return W.inTx((tx: Tx) =>
    (
      glService as unknown as {
        recordOverpaidItem: (...args: unknown[]) => Promise<unknown>;
      }
    ).recordOverpaidItem(
      tx,
      actorOf(APP),
      itemId,
      { evidenceKey: uploadEvidence(batchId, "mutasi-bank.pdf"), note: NOTE },
      W.proofs(),
    ),
  );
};

const tenantFlags = async () =>
  (
    await W.owner.query(
      "SELECT feature_flags AS flags FROM tenants WHERE id = $1",
      [W.tenantId],
    )
  ).rows[0]!.flags as { modules: string[] } & Record<string, unknown>;
const setFlags = (flags: unknown) =>
  W.owner.query("UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1", [
    W.tenantId,
    JSON.stringify(flags),
  ]);
/** Runs `work` with the accounting module off, always restoring the flags. */
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

/**
 * An overpaid item recorded with accounting off and no locked journal: the
 * service journals nothing, so the posting carries fee_idr 0 while the item
 * still seals Rp5.000 (the legit "accounting off" case).
 */
async function unjournaledOverpaidWorld() {
  const w = await withAccountingOff(async () => {
    const made = await lateDoublePayment(false);
    await recordOverpaidItem(made.itemId, made.batchId);
    return made;
  });
  const [item] = await W.rowsOf(
    `SELECT status, gl_posting_id, payslip_id FROM payroll_disbursement_items
      WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, w.itemId],
  );
  expect(item?.status, "premise: overpaid").toBe("overpaid");
  const postingId = item!.gl_posting_id as string;
  const [posting] = await W.rowsOf(
    `SELECT fee_idr::text AS fee FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, postingId],
  );
  expect(Number(posting?.fee), "premise: nothing was journaled").toBe(0);
  expect(
    await W.countJournals(`${FEE_PREFIX}${w.itemId}`),
    "premise: no fee journal",
  ).toBe(0);
  return { ...w, postingId, payslipId: item!.payslip_id as string };
}

/** An overpaid item recorded through the services, with a posting of fee Rp5.000 and its fee journal. */
async function overpaidWorld() {
  const w = await lateDoublePayment();
  await recordOverpaidItem(w.itemId, w.batchId);
  const [item] = await W.rowsOf(
    `SELECT status, gl_posting_id, payslip_id FROM payroll_disbursement_items
      WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, w.itemId],
  );
  expect(item?.status, "premise: overpaid").toBe("overpaid");
  const postingId = item!.gl_posting_id as string;
  expect(postingId, "premise: the item links its posting").toBeTruthy();
  const [posting] = await W.rowsOf(
    `SELECT kind, fee_idr::text AS fee FROM payroll_payout_gl_postings
      WHERE tenant_id = $1 AND id = $2`,
    [W.tenantId, postingId],
  );
  expect(posting?.kind, "premise: an overpaid posting").toBe("overpaid");
  expect(Number(posting?.fee), "premise: the stored fee is Rp5.000").toBe(FEE);
  expect(
    await W.journalByKey(`${FEE_PREFIX}${w.itemId}`),
    "premise: the fee journal is Dr 8101 / Cr 1103 of Rp5.000",
  ).toEqual({
    "8101": { debit: FEE, credit: 0 },
    "1103": { debit: 0, credit: FEE },
  });
  return { ...w, postingId, payslipId: item!.payslip_id as string };
}

// ---- Forgeries (owner, guards off) ----------------------------------------------------

const setPostingFee = (postingId: string, fee: number) =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE payroll_payout_gl_postings SET fee_idr = $3 WHERE tenant_id = $1 AND id = $2`,
        [W.tenantId, postingId, fee],
      ),
    true,
  );

/** Both sides of the fee journal move to `amount`: still balanced, no longer the posting's fee. */
const setFeeJournalAmount = (itemId: string, amount: number) =>
  W.asTenant(
    (c) =>
      c.query(
        `UPDATE journal_lines
            SET debit_idr = CASE WHEN debit_idr > 0 THEN $3::bigint ELSE 0 END,
                credit_idr = CASE WHEN credit_idr > 0 THEN $3::bigint ELSE 0 END
          WHERE tenant_id = $1
            AND entry_id IN (SELECT id FROM journal_entries
                              WHERE tenant_id = $1 AND idempotency_key = $2)`,
        [W.tenantId, `${FEE_PREFIX}${itemId}`, amount],
      ),
    true,
  );

// ---- The recon (adapter of the 905 recon test: one page per call) ---------------------

async function runRecon() {
  const mod =
    (await import("../services/payroll-payout-recon.service.ts")) as Record<
      string,
      unknown
    >;
  const name = [
    "reconcileTrustedPayouts",
    "runTrustedPayoutRecon",
    "runPayoutRecon",
  ].find((n) => typeof mod[n] === "function");
  expect(
    name,
    `payroll-payout-recon.service.ts must export the night run; it exports: ${Object.keys(mod).join(", ")}`,
  ).toBeDefined();
  const { storage } = W.proofs();
  const run = mod[name!] as (
    context: unknown,
    options: unknown,
  ) => Promise<{ operations: number; last: string | null }>;
  let after: string | null = null;
  for (let page = 0; page < 1000; page += 1) {
    const result = await run(W.scope(), { storage, after });
    if (result.last === null || result.operations === 0) return;
    after = result.last;
  }
  throw new Error("recon did not finish");
}

const exceptionsOf = (itemId: string) =>
  W.rowsOf(
    `SELECT * FROM ${EXCEPTIONS} WHERE tenant_id = $1 AND item_id = $2`,
    [W.tenantId, itemId],
  );
const reasonsOf = async (itemId: string) =>
  (await exceptionsOf(itemId)).map((r) => String(r.reason));
const hasReason = async (itemId: string, reason: string) =>
  (await reasonsOf(itemId)).some((r) => r.includes(reason));

/** The item carries a flag with this reason and the payslip of the flag is held. */
async function expectFlaggedAndHeld(
  itemId: string,
  payslipId: string,
  reason: string,
  label: string,
) {
  const rows = await exceptionsOf(itemId);
  expect(
    rows.some((r) => String(r.reason).includes(reason)),
    `${label}: a flag with reason ${reason} on the item; got ${JSON.stringify(rows.map((r) => r.reason))}`,
  ).toBe(true);
  const [held] = await W.rowsOf(
    `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
    [W.tenantId, payslipId],
  );
  expect(held!.held, `${label}: the flag holds the payslip`).toBe(true);
}

// =========================================================================
// B: the fee of the posting against the sealed fee of the item
// =========================================================================

describe("990 phase 5 B: the recon compares the posting fee with the sealed fee", () => {
  it("[legend-w9od2-fee-zero-forged] a posting with fee_idr 0 while the item's sealed fee is Rp5.000: flagged fee_sealed_mismatch on the item, the payslip is held", async () => {
    const w = await overpaidWorld();
    await setPostingFee(w.postingId, 0);

    await runRecon();
    await expectFlaggedAndHeld(
      w.itemId,
      w.payslipId,
      SEALED,
      "fee forged down to 0",
    );
  });

  it("[legend-w9od2-fee-raised-forged] a posting fee higher than the sealed fee (Rp7.500 against Rp5.000): flagged fee_sealed_mismatch on the item, the payslip is held", async () => {
    const w = await overpaidWorld();
    await setPostingFee(w.postingId, 7_500);

    await runRecon();
    await expectFlaggedAndHeld(w.itemId, w.payslipId, SEALED, "fee forged up");
  });

  it("[legend-w9od2-sealed-unreadable] a sealed fee that cannot be decrypted while the posting says Rp5.000: flagged fee_sealed_mismatch (fail closed), the payslip is held", async () => {
    const w = await overpaidWorld();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_disbursement_items SET fee_idr_encrypted = '\\x00112233445566778899'::bytea
            WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, w.itemId],
        ),
      true,
    );

    await runRecon();
    await expectFlaggedAndHeld(
      w.itemId,
      w.payslipId,
      SEALED,
      "sealed fee unreadable",
    );
  });
});

describe("990 phase 6 P2-1: a posted fee of 0 against a sealed fee above 0", () => {
  it("[legend-w9od2-zero-legit-accounting-off] fee 0, no overpaid journal and accounting off: not flagged fee_sealed_mismatch", async () => {
    const w = await unjournaledOverpaidWorld();

    await withAccountingOff(runRecon);
    expect(await hasReason(w.itemId, SEALED)).toBe(false);
  });

  it("[legend-w9od2-zero-forged-accounting-on] the same fee 0 with no journal while accounting is on: flagged fee_sealed_mismatch, the payslip is held", async () => {
    const w = await unjournaledOverpaidWorld();

    await runRecon();
    await expectFlaggedAndHeld(
      w.itemId,
      w.payslipId,
      SEALED,
      "fee 0 with accounting on",
    );
  });

  it("[legend-w9od2-null-fee-fail-closed] a posting with fee_idr NULL: flagged fee_sealed_mismatch, the payslip is held", async () => {
    const w = await overpaidWorld();
    await W.asTenant(
      (c) =>
        c.query(
          `UPDATE payroll_payout_gl_postings SET fee_idr = NULL WHERE tenant_id = $1 AND id = $2`,
          [W.tenantId, w.postingId],
        ),
      true,
    );

    await runRecon();
    await expectFlaggedAndHeld(
      w.itemId,
      w.payslipId,
      SEALED,
      "posting fee NULL",
    );
  });
});

describe("990 phase 5 B: the recon compares the fee journal with the posting fee", () => {
  it("[legend-w9od2-journal-amount-forged] a fee journal of Rp4.000 against a posting fee of Rp5.000: flagged fee_journal_amount on the item, the payslip is held; the sealed fee is fine so no fee_sealed_mismatch", async () => {
    const w = await overpaidWorld();
    await setFeeJournalAmount(w.itemId, 4_000);
    expect(
      await W.journalByKey(`${FEE_PREFIX}${w.itemId}`),
      "premise: the fee journal was changed",
    ).toEqual({
      "8101": { debit: 4_000, credit: 0 },
      "1103": { debit: 0, credit: 4_000 },
    });

    await runRecon();
    await expectFlaggedAndHeld(
      w.itemId,
      w.payslipId,
      JOURNAL_AMOUNT,
      "fee journal amount forged",
    );
    expect(
      await hasReason(w.itemId, SEALED),
      "the posting fee equals the sealed fee",
    ).toBe(false);
  });
});

describe("990 phase 5 B: the legit flow and other tenants", () => {
  it("[legend-w9od2-legit-not-flagged] control: same fee in posting, item and journal: no fee flag, the payslip is not held", async () => {
    const w = await overpaidWorld();

    await runRecon();
    expect(
      await reasonsOf(w.itemId),
      "no flag of any kind for a legit overpaid item",
    ).toEqual([]);
    const [held] = await W.rowsOf(
      `SELECT app.payout_payslip_held_by_recon($1::uuid, $2::uuid) AS held`,
      [W.tenantId, w.payslipId],
    );
    expect(held!.held).toBe(false);
  });

  it("[legend-w9od2-other-tenant-untouched] a forged fee in this tenant is flagged; a copy of the same forged item and posting in another tenant gets no fee flag from this tenant's run", async () => {
    const w = await overpaidWorld();
    await setPostingFee(w.postingId, 0);

    // A copy of the forged item and posting under another tenant (FKs are off with guards off).
    const foreignTenant = randomUUID();
    const foreignItem = randomUUID();
    const foreignPosting = randomUUID();
    foreignTenants.push(foreignTenant);
    await W.asTenant(async (c) => {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan, status, deployment_mode, feature_flags, limits, created_by)
         SELECT $1, $2, 'Payout 990 fee tenant B', plan, status, deployment_mode, feature_flags, limits, created_by
           FROM tenants WHERE id = $3`,
        [foreignTenant, `payout-990f-${foreignTenant.slice(0, 8)}`, W.tenantId],
      );
      await c.query(
        `INSERT INTO payroll_payout_gl_postings
         SELECT (jsonb_populate_record(NULL::payroll_payout_gl_postings,
                  to_jsonb(p) || jsonb_build_object('id', $1::text, 'tenant_id', $2::text))).*
           FROM payroll_payout_gl_postings p WHERE p.tenant_id = $3 AND p.id = $4`,
        [foreignPosting, foreignTenant, W.tenantId, w.postingId],
      );
      await c.query(
        `INSERT INTO payroll_disbursement_items
         SELECT (jsonb_populate_record(NULL::payroll_disbursement_items,
                  to_jsonb(i) || jsonb_build_object('id', $1::text, 'tenant_id', $2::text,
                                                    'gl_posting_id', $5::text))).*
           FROM payroll_disbursement_items i WHERE i.tenant_id = $3 AND i.id = $4`,
        [foreignItem, foreignTenant, W.tenantId, w.itemId, foreignPosting],
      );
    }, true);

    await runRecon();
    await expectFlaggedAndHeld(
      w.itemId,
      w.payslipId,
      SEALED,
      "this tenant's forged fee",
    );
    const foreign = await W.owner.query(
      `SELECT reason FROM ${EXCEPTIONS} WHERE tenant_id = $1`,
      [foreignTenant],
    );
    expect(
      foreign.rows,
      "this tenant's run raised nothing in the other tenant",
    ).toEqual([]);
  });
});
