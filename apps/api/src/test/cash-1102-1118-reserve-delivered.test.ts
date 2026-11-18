// legend 1118 D3: the reserve of a cash kasbon is released only when the
// delivered event's journal really lowered GL 1102 by the principal. Written
// from the brief (docs/briefs/1118-fix-kas-ronde7-mapping.md, decision 3) and
// the founder rule "GL 1102 never goes negative, nobody is paid when the cash
// is not there", observed only through the real cash guard over HTTP
// (a kasbon above the available cash is refused 422 PETTY_CASH_GL_INSUFFICIENT),
// not by calling the reserve query.
//
// Cases (event already delivered, as old data would be):
// - journal exists but is net zero (Dr 1102 / Cr 1102): reserve stays;
// - journal exists but credits 1102 by less than the principal: reserve stays;
// - journal really credits 1102 by the principal: reserve is released;
// - no journal at all (accounting off at consume time): reserve is released
//   (today's behavior; it must not reserve forever).
//
// Assumptions:
// - The journal is found by the consumer's key `payroll-gl:loan:<loanId>`
//   (brief); the seeded journals use source_type 'payroll' and the loan id as source.
// - Probe: with GL 1102 = G and a delivered kasbon of Rp100.000, a second
//   kasbon is paid only when G - (reserve still held) covers it.
import { describe, expect, it } from "vitest";
import {
  expectGlRefusal,
  installLoanCashWorld,
} from "./helpers/cash-1118-world.ts";

const AMOUNT = 100_000;
const H = installLoanCashWorld("1118r");

/** 1102 holds Rp100.000 of free cash and one Rp100.000 kasbon paid (event pending). */
async function paidKasbon() {
  await H.drain();
  await H.W.fundPettyCash(AMOUNT);
  const loan = await H.seedLoan(AMOUNT);
  const paid = await H.disburse(loan, AMOUNT);
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  // GL 1102 before the journal; relative checks keep the tests order-independent.
  return { loan, gl0: await H.glBalance() };
}

describe("1118 delivered kasbon event: reserve kept or released by the journal", () => {
  it("[1118-reserve-net-zero-journal-kept] delivered event whose journal is Dr 1102 / Cr 1102: the Rp100.000 reserve stays, a second kasbon is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    try {
      const { loan, gl0 } = await paidKasbon();
      await H.seedLoanJournal(loan, AMOUNT); // net zero on 1102
      await H.markDelivered(loan);
      H.markStuck(loan);
      expect(await H.glBalance(), "GL never fell").toBe(gl0);

      const second = await H.seedLoan(AMOUNT);
      expectGlRefusal(await H.disburse(second, AMOUNT));
      expect((await H.loanState(second)).events).toBe(0);
      await H.expectNoCashAvailable();
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);

  it("[1118-reserve-partial-credit-kept] delivered event whose journal credits 1102 by only Rp40.000 of the Rp100.000 principal: the whole principal stays reserved, a Rp50.000 kasbon (GL fell by Rp40.000 only) is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    try {
      const { loan, gl0 } = await paidKasbon();
      await H.seedLoanJournal(loan, 40_000, 40_000); // Dr 1204 / Cr 1102 of 40.000
      await H.markDelivered(loan);
      H.markStuck(loan);
      expect(await H.glBalance(), "GL fell by 40.000 only").toBe(gl0 - 40_000);

      const small = await H.seedLoan(50_000);
      expectGlRefusal(await H.disburse(small, 50_000));
      expect((await H.loanState(small)).events).toBe(0);
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);

  it("[1118-reserve-full-credit-released] delivered event whose journal credits 1102 by the full principal: the reserve is released, with the GL refilled by Rp100.000 a second Rp100.000 kasbon is paid (200)", async () => {
    try {
      const { loan, gl0 } = await paidKasbon();
      await H.seedLoanJournal(loan, AMOUNT, AMOUNT); // Dr 1204 / Cr 1102
      await H.markDelivered(loan);
      expect(await H.glBalance(), "GL fell by the principal").toBe(
        gl0 - AMOUNT,
      );
      await H.W.fundPettyCash(AMOUNT); // new cash, nothing else reserved

      const second = await H.seedLoan(AMOUNT);
      const res = await H.disburse(second, AMOUNT);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await H.loanState(second)).events).toBe(1);
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);

  it("[1118-reserve-no-journal-released] delivered event without any journal (accounting was off at consume time): the reserve is released as before, a second Rp100.000 kasbon is paid (200)", async () => {
    try {
      const { loan } = await paidKasbon();
      expect(await H.W.countJournals(`payroll-gl:loan:${loan}`)).toBe(0);
      await H.markDelivered(loan);

      const second = await H.seedLoan(AMOUNT);
      const res = await H.disburse(second, AMOUNT);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);

  it("[1118-reserve-undelivered-kept] control: an event not yet delivered keeps its reserve (second kasbon refused 422 PETTY_CASH_GL_INSUFFICIENT)", async () => {
    try {
      await paidKasbon();
      const second = await H.seedLoan(AMOUNT);
      expectGlRefusal(await H.disburse(second, AMOUNT));
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);

  // ---- F5(b): the same rule for a cash reimbursement (reimbursement.paid) ----

  /** 1102 holds Rp100.000 of free cash and one Rp100.000 cash claim is paid (event pending). */
  async function paidClaim() {
    await H.drain();
    await H.W.fundPettyCash(AMOUNT);
    const claim = await H.seedClaim(AMOUNT);
    const paid = await H.payClaim(claim, AMOUNT);
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    return claim;
  }

  it("[1118-reimb-net-zero-journal-kept] delivered reimbursement.paid whose journal is Dr 1102 / Cr 1102: the Rp100.000 reserve stays, a second Rp100.000 claim is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    try {
      const claim = await paidClaim();
      await H.seedReimbursementJournal(claim, AMOUNT); // net zero on 1102
      await H.markDelivered(claim);
      H.markStuck(claim);

      const second = await H.seedClaim(AMOUNT);
      expectGlRefusal(await H.payClaim(second, AMOUNT));
      expect(await H.claimEvents(second)).toBe(0);
      await H.expectNoCashAvailable();
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);

  it("[1118-reimb-employee-moved-kept] the claim's employee moved to another legal entity after the payment: the Dr 1102 / Cr 1102 journal still holds the Rp100.000 reserve in the entity of the journal, a second Rp100.000 claim is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    let undo: (() => Promise<void>) | null = null;
    try {
      const claim = await paidClaim();
      await H.seedReimbursementJournal(claim, AMOUNT); // net zero on 1102
      await H.markDelivered(claim);
      H.markStuck(claim);
      undo = await H.moveClaimEmployeeToOtherEntity(claim);

      const second = await H.seedClaim(AMOUNT);
      expectGlRefusal(await H.payClaim(second, AMOUNT));
      expect(await H.claimEvents(second)).toBe(0);
      await H.expectNoCashAvailable();
    } finally {
      await undo?.();
      await H.restoreBaseline();
    }
  }, 120_000);

  it("[1118-reimb-full-credit-released] delivered reimbursement.paid whose journal is Dr 6110 / Cr 1102 of the full amount: the reserve is released, with the GL refilled a second Rp100.000 claim is paid (200)", async () => {
    try {
      const claim = await paidClaim();
      await H.seedReimbursementJournal(claim, AMOUNT, AMOUNT);
      await H.markDelivered(claim);
      await H.W.fundPettyCash(AMOUNT); // new cash, nothing else reserved

      const second = await H.seedClaim(AMOUNT);
      const res = await H.payClaim(second, AMOUNT);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await H.claimEvents(second)).toBe(1);
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);

  it("[1118-reimb-no-journal-released] delivered reimbursement.paid without any journal (accounting was off at consume time): the reserve is released as before, a second Rp100.000 claim is paid (200)", async () => {
    try {
      const claim = await paidClaim();
      expect(await H.W.countJournals(`payroll-gl:reimbursement:${claim}`)).toBe(
        0,
      );
      await H.markDelivered(claim);

      const second = await H.seedClaim(AMOUNT);
      const res = await H.payClaim(second, AMOUNT);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);
});
