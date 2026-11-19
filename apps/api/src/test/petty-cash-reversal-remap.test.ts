// legend 1140 / second opinion 1138 finding P1-1 (docs/qa/second-opinion-kas-ronde8-1138.md,
// brief docs/briefs/1140-fix-so-kas-ronde8.md decision 1): a manual reversal of
// the journal of a kasbon / cash reimbursement that is still `disbursed` / paid,
// done while the petty_cash mapping points at ANOTHER account, must not bring
// cash back. Written from the brief, the SO scenario and the founder rule "GL
// 1102 never goes negative, nobody is paid when the cash is not there", and
// observed only over HTTP (mapping endpoint, disburse / pay, reversal endpoint)
// plus the real GL consumer, not from the service code.
//
// Chain (SO scenario): fund the petty cash account A with Rp100.000, pay one
// kasbon of Rp100.000 over HTTP, consume its outbox event so the journal
// (Dr 1204 / Cr A) is posted and the event is delivered: GL A and available
// cash are Rp0. Remap petty_cash A -> B (another active cash account of the
// same entity, through PUT account-mappings), finance reverses the kasbon
// journal, remap petty_cash B -> A, then a second kasbon of Rp100.000 is paid.
// Expected after the fix (CTO decision 1): the reversal is refused 409 (the
// source is still paid; judged on the journal's own accounts, not on today's
// mapping), GL A stays Rp0, and the second kasbon is refused 422
// PETTY_CASH_GL_INSUFFICIENT. Same chain for a cash reimbursement claim.
//
// Two tests per source:
// - "pinned": the reversal itself must be 409 (CTO decision 1);
// - "invariant": whatever the reversal answers, after remap B -> A no cash is
//   available and a second payment is refused (SO: "reversal 409, or available
//   stays Rp0 and the second payout is refused").
//
// Assumptions (stated so they can be contested):
// - Only the status 409 of the reversal is pinned, not the error code (the SO
//   and the brief name none; the sibling 1089 lock uses CASH_OUT_JOURNAL_LOCKED).
// - Remaps go through PUT /api/accounting/legal-entities/:id/account-mappings as
//   finance (valid per the SO: both remaps pass the endpoint validation).
// - The second payment is refused with the same 422 PETTY_CASH_GL_INSUFFICIENT
//   for a claim as for a kasbon (same cash guard).
// - A reversal request body is { entryDate, reason, idempotencyKey }.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { reimbursementPaid } from "@starter/shared/hris/payroll";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverPayrollGlEvent } from "../services/payroll-gl-consumer.ts";
import { originHeader } from "./helpers.ts";
import {
  daysAgo,
  key,
  owner,
  signedIn,
  tenantId,
  type Session,
} from "./helpers/cash-bank-world.ts";
import {
  expectGlRefusal,
  installLoanCashWorld,
  type Res,
} from "./helpers/cash-1118-world.ts";

const AMOUNT = 100_000;
const app = createApp();
const H = installLoanCashWorld("1140rv");
let finance: Session;
/** Sources paid by a test only because the fix is missing: dropped in cleanup. */
const leaked: string[] = [];
/** Reversal journals created by a (wrongly) accepted reversal. */
const reversalIds: string[] = [];

beforeAll(async () => {
  finance = await signedIn(app, "1140rv finance", [
    { role: "finance", outletId: null },
  ]);
});

afterEach(async () => {
  // Never leave a remap or a leaked pending reserve behind, then restore 1102.
  await H.setPettyCashAccount(await H.accountId("1102"));
  while (leaked.length > 0) await H.forget(leaked.pop()!);
  await dropReversalJournals();
  await H.setReceivable("1204");
  await H.restoreBaseline();
});

/**
 * Setup hygiene only: a test that fails because the reversal was accepted
 * leaves a reversal journal behind (cash back in GL, reserve still held).
 * Remove it so the next test starts from the same state a passing test leaves.
 */
async function dropReversalJournals() {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM journal_entries
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenantId, reversalIds],
    );
    const ids = rows.map((row) => row.id);
    await client.query(
      "DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id = ANY($2::uuid[])",
      [tenantId, ids],
    );
    await client.query(
      "DELETE FROM journal_entries WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
      [tenantId, ids],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  reversalIds.length = 0;
}

/**
 * Remaps petty_cash straight in the database. Since legend 1147 the mapping
 * endpoint refuses a cash role on an account that already has journal lines, so
 * the remap these tests guard against only exists as legacy data (mapped before
 * the rule, or by a direct write): simulate it the way old data looks.
 */
async function remapPettyCash(accountId: string) {
  await H.setPettyCashAccount(accountId);
}

/**
 * Account B of the remap: another active, postable asset account of the same
 * entity that is NOT in the cash report group (SO: "akun asset detail aktif
 * lain"), so a guard that recognises cash by group or by today's mapping alone
 * does not see it. Setup only.
 */
async function createAssetAccount(code: string) {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
     VALUES ($1, $2, $3, 'Akun aset pindahan uji 1140', 'asset', 'current_asset')
     ON CONFLICT (tenant_id, legal_entity_id, code) DO UPDATE SET name = excluded.name
     RETURNING id`,
    [tenantId, H.W.entityId(), code],
  );
  return rows[0]!.id;
}

/** Legacy journal shape: no posting_account_snapshot (posted before migration 0296). Setup only. */
async function stripSnapshot(journalId: string) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "UPDATE journal_entries SET posting_account_snapshot = NULL WHERE tenant_id = $1 AND id = $2",
      [tenantId, journalId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function journalIdOf(idempotencyKey: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1 AND legal_entity_id = $2 AND idempotency_key = $3",
    [tenantId, H.W.entityId(), idempotencyKey],
  );
  expect(rows, `premise: one journal under ${idempotencyKey}`).toHaveLength(1);
  return rows[0]!.id;
}

async function reverse(journalId: string): Promise<Res> {
  const res = (await finance.client
    .post(`/api/accounting/journals/${journalId}/reversal`)
    .set(originHeader)
    .send({
      entryDate: daysAgo(0),
      reason: "Koreksi uji 1140 P1-1",
      idempotencyKey: key(),
    })) as Res;
  const created = (res.body.data as { id?: string } | undefined)?.id;
  if (res.status < 300 && created) reversalIds.push(created);
  return res;
}

type Booked = {
  journalId: string;
  journalKey: string;
  petty: string;
  other: string;
};

/** The chain up to the remap A -> B: paid, consumed, delivered, GL A and available Rp0. */
async function bookedThenRemapped(
  pay: () => Promise<{ id: string; journalKey: string }>,
  code: string,
  legacy = false,
): Promise<Booked> {
  await H.drain();
  await H.W.fundPettyCash(AMOUNT);
  const { journalKey } = await pay();
  expect(await H.glBalance(), "premise: petty cash account is empty").toBe(0);
  expect(await H.available(), "premise: nothing available").toBe(0);
  if (legacy) await stripSnapshot(await journalIdOf(journalKey));
  const petty = await H.mappedAccountId("petty_cash");
  const other = await createAssetAccount(code);
  await remapPettyCash(other);
  return { journalId: await journalIdOf(journalKey), journalKey, petty, other };
}

/** Kasbon: disburse over HTTP, run the real GL consumer, mark delivered. */
async function payLoanAndBook() {
  const loan = await H.seedLoan(AMOUNT);
  const paid = await H.disburse(loan, AMOUNT);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  const posted = await H.deliver(await H.loanEvent(loan));
  await H.markDelivered(loan);
  expect(posted.status, "premise: the journal is posted").toBe("posted");
  return { id: loan, journalKey: `payroll-gl:loan:${loan}` };
}

/** Cash reimbursement: pay over HTTP, run the real GL consumer, mark delivered. */
async function payClaimAndBook() {
  const claim = await H.seedClaim(AMOUNT);
  const paid = await H.payClaim(claim, AMOUNT);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'reimbursement.paid'
        AND event::text LIKE '%' || $2 || '%'`,
    [tenantId, claim],
  );
  expect(rows, "exactly one reimbursement.paid event").toHaveLength(1);
  const event = reimbursementPaid.envelopeSchema.parse(rows[0]!.event);
  const posted = await withTenant(db, H.W.scope(), (tx) =>
    deliverPayrollGlEvent(H.W.scope(), event, tx, new Date()),
  );
  await H.markDelivered(claim);
  expect(posted.status, "premise: the journal is posted").toBe("posted");
  return { id: claim, journalKey: `payroll-gl:reimbursement:${claim}` };
}

describe("1140 P1-1 reversal of a still-paid kasbon journal after a petty_cash remap", () => {
  it("[1140-reversal-remap-loan-409] cash kasbon delivered, petty_cash remapped A->B, reversal of the kasbon journal is refused 409 (no reversal journal, GL A stays Rp0); after remap B->A a second Rp100.000 kasbon is refused 422 PETTY_CASH_GL_INSUFFICIENT and no cash is available", async () => {
    const { journalId, petty } = await bookedThenRemapped(
      payLoanAndBook,
      "1195",
    );
    const journals = await H.journalCount();

    const reversal = await reverse(journalId);

    expect(
      reversal.status,
      `the kasbon is still disbursed, the reversal must be refused: ${JSON.stringify(reversal.body)}`,
    ).toBe(409);
    expect(await H.journalCount(), "no reversal journal").toBe(journals);
    expect(await H.glBalance(), "GL A stays Rp0").toBe(0);

    await remapPettyCash(petty);
    const second = await H.seedLoan(AMOUNT);
    const res = await H.disburse(second, AMOUNT);
    if (res.status === 200) leaked.push(second);
    expectGlRefusal(res);
    expect((await H.loanState(second)).events).toBe(0);
    await H.expectNoCashAvailable();
  }, 120_000);

  it("[1140-reversal-remap-loan-no-cash-back] whatever the reversal answers, after remap A->B, reversal, remap B->A the petty cash is still Rp0 for a second Rp100.000 kasbon: refused 422 PETTY_CASH_GL_INSUFFICIENT, no event, no cash available", async () => {
    const { journalId, petty } = await bookedThenRemapped(
      payLoanAndBook,
      "1194",
    );

    await reverse(journalId); // 409 or not: the invariant below is what counts
    await remapPettyCash(petty);

    const second = await H.seedLoan(AMOUNT);
    const res = await H.disburse(second, AMOUNT);
    if (res.status === 200) leaked.push(second);
    expectGlRefusal(res);
    expect((await H.loanState(second)).events).toBe(0);
    await H.expectNoCashAvailable();
  }, 120_000);
  it("[1140-reversal-remap-loan-legacy-journal-409] same chain for a kasbon journal posted before migration 0296 (no posting_account_snapshot): the reversal after remap A->B is still refused 409 (judged on the source and the journal's own accounts), GL A stays Rp0, and after remap B->A a second kasbon is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    const { journalId, petty } = await bookedThenRemapped(
      payLoanAndBook,
      "1191",
      true,
    );
    const journals = await H.journalCount();

    const reversal = await reverse(journalId);

    expect(
      reversal.status,
      `the kasbon is still disbursed, the reversal must be refused: ${JSON.stringify(reversal.body)}`,
    ).toBe(409);
    expect(await H.journalCount(), "no reversal journal").toBe(journals);
    expect(await H.glBalance(), "GL A stays Rp0").toBe(0);

    await remapPettyCash(petty);
    const second = await H.seedLoan(AMOUNT);
    const res = await H.disburse(second, AMOUNT);
    if (res.status === 200) leaked.push(second);
    expectGlRefusal(res);
    await H.expectNoCashAvailable();
  }, 120_000);
});

describe("1140 P1-1 reversal of a still-paid cash reimbursement journal after a petty_cash remap", () => {
  it("[1140-reversal-remap-reimbursement-409] cash claim paid and delivered, petty_cash remapped A->B, reversal of the claim journal is refused 409 (no reversal journal, GL A stays Rp0); after remap B->A a second Rp100.000 claim is refused 422 PETTY_CASH_GL_INSUFFICIENT and no cash is available", async () => {
    const { journalId, petty } = await bookedThenRemapped(
      payClaimAndBook,
      "1193",
    );
    const journals = await H.journalCount();

    const reversal = await reverse(journalId);

    expect(
      reversal.status,
      `the claim is still paid, the reversal must be refused: ${JSON.stringify(reversal.body)}`,
    ).toBe(409);
    expect(await H.journalCount(), "no reversal journal").toBe(journals);
    expect(await H.glBalance(), "GL A stays Rp0").toBe(0);

    await remapPettyCash(petty);
    const second = await H.seedClaim(AMOUNT);
    const res = await H.payClaim(second, AMOUNT);
    if (res.status === 200) leaked.push(second);
    expectGlRefusal(res);
    expect(await H.claimEvents(second)).toBe(0);
    await H.expectNoCashAvailable();
  }, 120_000);

  it("[1140-reversal-remap-reimbursement-no-cash-back] whatever the reversal answers, after remap A->B, reversal, remap B->A the petty cash is still Rp0 for a second Rp100.000 claim: refused 422 PETTY_CASH_GL_INSUFFICIENT, no event, no cash available", async () => {
    const { journalId, petty } = await bookedThenRemapped(
      payClaimAndBook,
      "1192",
    );

    await reverse(journalId); // 409 or not: the invariant below is what counts
    await remapPettyCash(petty);

    const second = await H.seedClaim(AMOUNT);
    const res = await H.payClaim(second, AMOUNT);
    if (res.status === 200) leaked.push(second);
    expectGlRefusal(res);
    expect(await H.claimEvents(second)).toBe(0);
    await H.expectNoCashAvailable();
  }, 120_000);

  it("[1140-reversal-remap-reimbursement-legacy-journal-409] same chain for a claim journal without posting_account_snapshot: the reversal after remap A->B is refused 409, GL A stays Rp0, and after remap B->A a second claim is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    const { journalId, petty } = await bookedThenRemapped(
      payClaimAndBook,
      "1190",
      true,
    );
    const journals = await H.journalCount();

    const reversal = await reverse(journalId);

    expect(
      reversal.status,
      `the claim is still paid, the reversal must be refused: ${JSON.stringify(reversal.body)}`,
    ).toBe(409);
    expect(await H.journalCount(), "no reversal journal").toBe(journals);
    expect(await H.glBalance(), "GL A stays Rp0").toBe(0);

    await remapPettyCash(petty);
    const second = await H.seedClaim(AMOUNT);
    const res = await H.payClaim(second, AMOUNT);
    if (res.status === 200) leaked.push(second);
    expectGlRefusal(res);
    await H.expectNoCashAvailable();
  }, 120_000);
});

// legend 1142 / second opinion 1142 finding P2-1 (docs/qa/second-opinion-kas-ronde9-1142.md):
// ONE mapping PUT moves employee_receivable C -> D and petty_cash A -> C, i.e.
// petty cash is pointed at the account the old kasbon / claim journal DEBITED.
// Netting the journal's historical credit to A against today's mapping C
// (+100.000 - 100.000) must not make the guard forget the source is still paid:
// the reversal is refused 409 CASH_OUT_JOURNAL_LOCKED whatever the mapping
// says now (CTO decision: judged on the source identity and the journal's own
// account snapshot, apart from today's mapping).

/**
 * Legacy swap (written directly, the endpoint refuses it since legend 1147):
 * employee_receivable C -> D (spare account), petty_cash A -> C.
 */
async function swapReceivableIntoPettyCash(code: string) {
  const receivable = await H.mappedAccountId("employee_receivable");
  const petty = await H.mappedAccountId("petty_cash");
  await createAssetAccount(code);
  await H.setReceivable(code);
  await H.setPettyCashAccount(receivable);
  return { petty };
}

async function claimStatus(claimId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM reimbursements WHERE tenant_id = $1 AND id = $2",
    [tenantId, claimId],
  );
  return rows[0]!.status;
}

describe("1142 P2-1 reversal of a still-paid journal after petty_cash is remapped onto the journal's debit account", () => {
  it("[1142-reversal-swap-loan-409] kasbon delivered (Dr 1204 / Cr A), one PUT moves receivable 1204 -> spare and petty_cash A -> 1204: the reversal is refused 409 CASH_OUT_JOURNAL_LOCKED, no reversal journal, kasbon stays disbursed, GL A stays Rp0, and after remapping back a second kasbon is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    await H.drain();
    await H.W.fundPettyCash(AMOUNT);
    const { id, journalKey } = await payLoanAndBook();
    expect(await H.glBalance(), "premise: petty cash account is empty").toBe(0);
    expect(await H.available(), "premise: nothing available").toBe(0);
    const journalId = await journalIdOf(journalKey);
    const { petty } = await swapReceivableIntoPettyCash("1196");
    const journals = await H.journalCount();

    const reversal = await reverse(journalId);

    expect(
      reversal.status,
      `the kasbon is still disbursed, the reversal must be refused: ${JSON.stringify(reversal.body)}`,
    ).toBe(409);
    expect(reversal.body.error?.code).toBe("CASH_OUT_JOURNAL_LOCKED");
    expect(await H.journalCount(), "no reversal journal").toBe(journals);
    expect(await H.glBalance(), "GL A stays Rp0").toBe(0);
    expect((await H.loanState(id)).status).toBe("disbursed");

    await H.setPettyCashAccount(petty);
    await H.setReceivable("1204");
    const second = await H.seedLoan(AMOUNT);
    const res = await H.disburse(second, AMOUNT);
    if (res.status === 200) leaked.push(second);
    expectGlRefusal(res);
    expect((await H.loanState(second)).events).toBe(0);
    await H.expectNoCashAvailable();
  }, 120_000);

  it("[1142-reversal-swap-loan-legacy-409] same swap for a kasbon journal without posting_account_snapshot (posted before migration 0296): still refused 409, no reversal journal", async () => {
    await H.drain();
    await H.W.fundPettyCash(AMOUNT);
    const { id, journalKey } = await payLoanAndBook();
    const journalId = await journalIdOf(journalKey);
    await stripSnapshot(journalId);
    await swapReceivableIntoPettyCash("1197");
    const journals = await H.journalCount();

    const reversal = await reverse(journalId);

    expect(
      reversal.status,
      `the kasbon is still disbursed, the reversal must be refused: ${JSON.stringify(reversal.body)}`,
    ).toBe(409);
    expect(await H.journalCount(), "no reversal journal").toBe(journals);
    expect((await H.loanState(id)).status).toBe("disbursed");
  }, 120_000);

  it("[1142-reversal-swap-reimbursement-409] cash claim paid and delivered, the same swap: the reversal of the claim journal is refused 409 CASH_OUT_JOURNAL_LOCKED, no reversal journal, claim stays paid, GL A stays Rp0, and after remapping back a second claim is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    await H.drain();
    await H.W.fundPettyCash(AMOUNT);
    const { id, journalKey } = await payClaimAndBook();
    expect(await H.glBalance(), "premise: petty cash account is empty").toBe(0);
    expect(await H.available(), "premise: nothing available").toBe(0);
    const journalId = await journalIdOf(journalKey);
    const { petty } = await swapReceivableIntoPettyCash("1198");
    const journals = await H.journalCount();

    const reversal = await reverse(journalId);

    expect(
      reversal.status,
      `the claim is still paid, the reversal must be refused: ${JSON.stringify(reversal.body)}`,
    ).toBe(409);
    expect(reversal.body.error?.code).toBe("CASH_OUT_JOURNAL_LOCKED");
    expect(await H.journalCount(), "no reversal journal").toBe(journals);
    expect(await H.glBalance(), "GL A stays Rp0").toBe(0);
    expect(await claimStatus(id)).toBe("paid");

    await H.setPettyCashAccount(petty);
    await H.setReceivable("1204");
    const second = await H.seedClaim(AMOUNT);
    const res = await H.payClaim(second, AMOUNT);
    if (res.status === 200) leaked.push(second);
    expectGlRefusal(res);
    expect(await H.claimEvents(second)).toBe(0);
    await H.expectNoCashAvailable();
  }, 120_000);
});
