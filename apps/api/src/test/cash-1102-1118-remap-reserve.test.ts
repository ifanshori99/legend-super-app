// legend 1118 F5(a): the reserve of a delivered cash kasbon is judged on the
// account its journal really credited, not on whatever account petty_cash
// points at TODAY. Written from the brief (docs/briefs/1118-fix-kas-ronde7-mapping.md,
// ADDENDUM F1) and the founder rule "GL 1102 never goes negative, nobody is
// paid when the cash is not there", observed only through the real cash guard
// over HTTP (kasbon above the available cash: 422 PETTY_CASH_GL_INSUFFICIENT),
// not by calling the reserve query.
//
// Cases (event already delivered, as old data would be; setup journals carry a
// `journal_entries.posting_account_snapshot`, role -> account id, as rule
// postings do since migration 0296):
// - good journal Dr 1204 / Cr 1102 (snapshot petty_cash = 1102); the owner then
//   remaps petty_cash to a funded new account: the old kasbon stays released,
//   a new Rp100.000 kasbon is paid and the cash is then exactly used up;
// - old journal Dr 1204 / Cr cash_on_hand (the rule credited cash_on_hand before
//   9 Nov); snapshot lists cash_on_hand: the credit counts, reserve released;
// - net-zero journal Dr 1102 / Cr 1102 (the 1118 bug) whose snapshot names the
//   OLD 1102: a later remap must not excuse it, the reserve stays held.
//
// Assumptions (stated so they can be contested):
// - The snapshot value is the account id (uuid text) under the role name.
// - A journal without a snapshot is judged on the current mapping (existing
//   reserve-delivered test, not repeated here).
// - Remaps are written straight in the database as the owner (legacy shape).
// - Releasing the cash_on_hand case is the CTO's F1 decision (legacy cash left
//   from the account the old rule credited); the test only encodes that.
import { afterEach, describe, expect, it } from "vitest";
import {
  expectGlRefusal,
  installLoanCashWorld,
} from "./helpers/cash-1118-world.ts";

const AMOUNT = 100_000;
const H = installLoanCashWorld("1118m");

afterEach(async () => {
  // Never leave a remap behind, then bring the modelled 1102 back to baseline.
  await H.setPettyCashAccount(await H.accountId("1102"));
  await H.restoreBaseline();
});

/** 1102 holds Rp100.000 of free cash and one Rp100.000 kasbon is paid (event pending). */
async function paidKasbon() {
  await H.drain();
  await H.W.fundPettyCash(AMOUNT);
  const loan = await H.seedLoan(AMOUNT);
  const paid = await H.disburse(loan, AMOUNT);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  return loan;
}

/** Role -> account id of the standard mapping, as a rule posting records it. */
async function snapshotOf(...roles: string[]) {
  const entries = await Promise.all(
    roles.map(async (role) => [role, await H.mappedAccountId(role)] as const),
  );
  return Object.fromEntries(entries);
}

/** A new cash account holding Rp100.000, taking over the petty_cash role. */
async function remapPettyCashToFundedAccount(code: string) {
  const moved = await H.createCashAccount(code);
  await H.fundAccount(moved, AMOUNT);
  await H.setPettyCashAccount(moved);
}

// Order matters: the cash_on_hand case leaves Rp100.000 of unreserved 1102 cash
// behind (its journal credited another account), so it runs last.
describe("1118 petty cash remap does not change the reserve of old delivered kasbon", () => {
  it("[1118-remap-good-loan-stays-released] kasbon with a real Cr 1102 journal, delivered, then petty_cash remapped to a funded account: no reserve is held, a new Rp100.000 kasbon is paid (200) and then Rp1 more is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    const loan = await paidKasbon();
    await H.seedLoanJournal(loan, AMOUNT, AMOUNT, {
      snapshot: await snapshotOf("petty_cash", "employee_receivable"),
    });
    await H.markDelivered(loan);
    await remapPettyCashToFundedAccount("1198");

    const second = await H.seedLoan(AMOUNT);
    const res = await H.disburse(second, AMOUNT);

    expect(
      res.status,
      `the old kasbon must stay released after a remap: ${JSON.stringify(res.body)}`,
    ).toBe(200);
    expect((await H.loanState(second)).events).toBe(1);
    // The new account held exactly Rp100.000: now used up, never negative.
    await H.expectNoCashAvailable();
    await H.forget(second); // its pending reserve must not leak into the next test
  }, 120_000);

  it("[1118-remap-net-zero-stays-held] net-zero journal Dr 1102 / Cr 1102 whose snapshot names the old 1102, delivered, then petty_cash remapped to a funded account: the Rp100.000 stays reserved, a new Rp100.000 kasbon is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    const loan = await paidKasbon();
    const petty = await H.mappedAccountId("petty_cash");
    await H.seedLoanJournal(loan, AMOUNT, 0, {
      snapshot: { petty_cash: petty, employee_receivable: petty },
    });
    await H.markDelivered(loan);
    H.markStuck(loan);
    await remapPettyCashToFundedAccount("1197");

    const second = await H.seedLoan(AMOUNT);
    expectGlRefusal(await H.disburse(second, AMOUNT));

    expect((await H.loanState(second)).events).toBe(0);
    await H.expectNoCashAvailable();
  }, 120_000);

  it("[1118-remap-cash-on-hand-credit-released] old kasbon journal Dr 1204 / Cr cash_on_hand (snapshot lists cash_on_hand), delivered: the reserve is released, a second Rp100.000 kasbon is paid (200)", async () => {
    const loan = await paidKasbon();
    await H.seedLoanJournal(loan, AMOUNT, AMOUNT, {
      creditAccountId: await H.mappedAccountId("cash_on_hand"),
      snapshot: await snapshotOf("cash_on_hand", "employee_receivable"),
    });
    await H.markDelivered(loan);

    const second = await H.seedLoan(AMOUNT);
    const res = await H.disburse(second, AMOUNT);

    expect(
      res.status,
      `a credit on the snapshot's cash_on_hand releases the reserve: ${JSON.stringify(res.body)}`,
    ).toBe(200);
    expect((await H.loanState(second)).events).toBe(1);
  }, 120_000);
});
