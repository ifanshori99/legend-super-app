// legend 1118 (second opinion kas ronde 7, P1-1): a cash kasbon must never
// release the 1102 reserve without lowering GL 1102. Written from the brief
// (docs/briefs/1118-fix-kas-ronde7-mapping.md, the SO scenario), the founder
// rule "GL 1102 never goes negative, nobody is paid when the cash is not
// there" and the public HTTP / consumer surface, NOT from the service code.
//
// Scenario: GL and cash 1102 Rp100.000, no other reserve, two kasbon of
// Rp100.000. employee_receivable is pointed at the account of petty_cash, so
// the kasbon journal Dr 1102 / Cr 1102 nets to zero.
//
// Error codes asserted:
// - PUT mapping: 422 VALIDATION_ERROR whose body names CASH_ACCOUNT_SHARED.
// - Disbursement with a shared mapping: 409 LOAN_CASH_ACCOUNT_SHARED, before
//   any event, journal or money.
// - Cash guard: 422 PETTY_CASH_GL_INSUFFICIENT.
//
// Assumptions (stated so they can be contested):
// - The mapping PUT is the full list (replace); the test reads the current
//   list, changes only employee_receivable and sends everything back.
// - "Consumer refuses to post" is: the consumer throws, or answers a status
//   other than posted / ignored / skipped; in both cases no journal exists and
//   the outbox event is not delivered.
// - A supplier retry is exercised through the same 1102 guard by a cash batch
//   approval of Rp1 (409/422) and by a second kasbon, not through the supplier
//   payment flow (that needs a second world; covered by cash-1102-supplier-retry).
// - Legacy data is simulated by writing the mapping as the database owner.
import { afterEach, describe, expect, it } from "vitest";
import {
  expectGlRefusal,
  installLoanCashWorld,
} from "./helpers/cash-1118-world.ts";

const AMOUNT = 100_000;
const H = installLoanCashWorld("1118");

afterEach(async () => {
  // Never leave a shared mapping behind for the next test.
  await H.setReceivable("1204");
});

/** Free cash of Rp100.000 in 1102; returns the GL balance (relative checks, order-independent). */
async function funded() {
  await H.drain();
  await H.W.fundPettyCash(AMOUNT);
  return H.glBalance();
}

describe("1118 mapping endpoint refuses employee_receivable on the petty cash account", () => {
  it("[1118-mapping-put-refused] PUT mapping employee_receivable -> the 1102 account of petty_cash is refused 422 VALIDATION_ERROR naming CASH_ACCOUNT_SHARED; the mapping is unchanged", async () => {
    const before = await H.listMappings();
    const petty = before.find((m) => m.role === "petty_cash")!;
    expect(petty, "premise: petty_cash is mapped").toBeDefined();
    expect(
      before.find((m) => m.role === "employee_receivable")!.accountId,
      "premise: receivable is on its own account",
    ).not.toBe(petty.accountId);

    const res = await H.putMappings(
      before.map((m) => ({
        role: m.role,
        accountId:
          m.role === "employee_receivable" ? petty.accountId : m.accountId,
      })),
    );

    const detail = JSON.stringify(res.body);
    expect(res.status, detail).toBe(422);
    expect(res.body.error?.code, detail).toBe("VALIDATION_ERROR");
    expect(detail).toContain("CASH_ACCOUNT_SHARED");
    expect(await H.listMappings(), "mapping unchanged").toEqual(before);
  });

  it.each(["cash_on_hand", "bank"] as const)(
    "[1118-mapping-put-refused-%s] PUT mapping employee_receivable -> the same account as that cash role is refused 422 CASH_ACCOUNT_SHARED",
    async (role) => {
      const before = await H.listMappings();
      const cashRole = before.find((m) => m.role === role);
      expect(cashRole, `premise: ${role} is mapped`).toBeDefined();

      const res = await H.putMappings(
        before.map((m) => ({
          role: m.role,
          accountId:
            m.role === "employee_receivable"
              ? cashRole!.accountId
              : m.accountId,
        })),
      );

      const detail = JSON.stringify(res.body);
      expect(res.status, detail).toBe(422);
      expect(detail).toContain("CASH_ACCOUNT_SHARED");
      expect(await H.listMappings()).toEqual(before);
    },
  );

  it("[1118-mapping-put-distinct-ok] control: the unchanged standard mapping is accepted (200)", async () => {
    const before = await H.listMappings();
    const res = await H.putMappings(before);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe("1118 legacy shared mapping: disbursement refused before money moves", () => {
  it("[1118-disburse-refused-shared-mapping] with employee_receivable on the 1102 account (old data) a Rp100.000 kasbon is refused 409 LOAN_CASH_ACCOUNT_SHARED: still approved, no event, no journal, GL and cash untouched", async () => {
    try {
      await funded();
      await H.setReceivable("1102");
      const loan = await H.seedLoan(AMOUNT);
      const journals = await H.journalCount();
      const gl = await H.glBalance();

      const res = await H.disburse(loan, AMOUNT);

      const detail = JSON.stringify(res.body);
      expect(res.status, detail).toBe(409);
      expect(res.body.error?.code, detail).toBe("LOAN_CASH_ACCOUNT_SHARED");
      expect(String(res.body.error?.message ?? ""), "a message").not.toBe("");
      expect(await H.loanState(loan)).toEqual({
        status: "approved",
        disbursed: false,
        events: 0,
      });
      expect(await H.journalCount(), "no journal").toBe(journals);
      expect(await H.glBalance()).toBe(gl);
      await H.setReceivable("1204");
      await H.drain(); // nothing is reserved: the whole cash can still be committed
    } finally {
      await H.setReceivable("1204");
      await H.restoreBaseline();
    }
  }, 120_000);

  it.each(["cash_on_hand", "bank"] as const)(
    "[1118-disburse-refused-shared-%s] employee_receivable on the same account as that cash role is refused 409 LOAN_CASH_ACCOUNT_SHARED before any event",
    async (role) => {
      try {
        await funded();
        await H.setReceivableToRoleAccount(role);
        const loan = await H.seedLoan(AMOUNT);

        const res = await H.disburse(loan, AMOUNT);

        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.error?.code).toBe("LOAN_CASH_ACCOUNT_SHARED");
        expect((await H.loanState(loan)).events, "no event").toBe(0);
        await H.setReceivable("1204");
        await H.drain();
      } finally {
        await H.setReceivable("1204");
        await H.restoreBaseline();
      }
    },
    120_000,
  );
});

describe("1118 mapping changed between disbursement and consumption (SO chain)", () => {
  it("[1118-consume-refused-keeps-reserve] kasbon paid with a good mapping, mapping then shared before the consumer runs: the consumer refuses to post (no journal, event not delivered), available stays Rp0, a second kasbon and a cash batch are refused; once the mapping is fixed the same event posts once", async () => {
    try {
      const gl0 = await funded();
      const first = await H.seedLoan(AMOUNT);
      const paid = await H.disburse(first, AMOUNT);
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      const event = await H.loanEvent(first);
      const journals = await H.journalCount();

      await H.setReceivable("1102"); // old, wrong mapping appears before consume
      const outcome = await H.deliver(event);

      H.expectRefused(outcome);
      expect(await H.W.countJournals(`payroll-gl:loan:${first}`)).toBe(0);
      expect(await H.journalCount(), "nothing posted").toBe(journals);
      expect(await H.glBalance(), "GL unchanged").toBe(gl0);
      expect(await H.eventStatus(first), "event not delivered").not.toBe(
        "delivered",
      );
      // The SO end state: the second kasbon and any other spend are refused.
      const second = await H.seedLoan(AMOUNT);
      const secondRes = await H.disburse(second, AMOUNT);
      expect([409, 422], JSON.stringify(secondRes.body)).toContain(
        secondRes.status,
      );
      expect((await H.loanState(second)).events, "no second event").toBe(0);
      await H.expectNoCashAvailable();

      // Retry after the mapping is repaired: posted exactly once, GL falls.
      await H.setReceivable("1204");
      const retried = await H.deliver(event);
      expect(retried.status, JSON.stringify(retried)).toBe("posted");
      expect(await H.W.countJournals(`payroll-gl:loan:${first}`)).toBe(1);
      expect(await H.glBalance()).toBe(gl0 - AMOUNT);
      await H.markDelivered(first);
    } finally {
      await H.setReceivable("1204");
      await H.restoreBaseline();
    }
  }, 180_000);

  it("[1118-legacy-net-zero-journal-keeps-reserve] legacy state: the kasbon event is delivered but its journal is Dr 1102 / Cr 1102 (net zero): available stays Rp0, the second kasbon is refused 422 PETTY_CASH_GL_INSUFFICIENT even with the mapping repaired, and a cash batch is refused", async () => {
    try {
      const gl0 = await funded();
      const first = await H.seedLoan(AMOUNT);
      expect((await H.disburse(first, AMOUNT)).status).toBe(200);
      await H.seedLoanJournal(first, AMOUNT);
      await H.markDelivered(first);
      H.markStuck(first); // the reserve must stay: model it for hygiene
      expect(await H.glBalance(), "GL never fell").toBe(gl0);

      const second = await H.seedLoan(AMOUNT);
      const res = await H.disburse(second, AMOUNT);

      expectGlRefusal(res);
      expect((await H.loanState(second)).events).toBe(0);
      await H.expectNoCashAvailable();
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);
});

describe("1118 controls: a distinct mapping keeps working", () => {
  it("[1118-control-distinct-mapping] kasbon Rp100.000 with employee_receivable on its own account: disbursed, consumer posts Dr 1204 / Cr 1102, GL 1102 falls by the principal, available is Rp0 and the second kasbon is refused 422 PETTY_CASH_GL_INSUFFICIENT", async () => {
    try {
      const gl0 = await funded();
      const first = await H.seedLoan(AMOUNT);
      expect((await H.disburse(first, AMOUNT)).status).toBe(200);
      const event = await H.loanEvent(first);

      const posted = await H.deliver(event);
      await H.markDelivered(first);

      expect(posted.status, JSON.stringify(posted)).toBe("posted");
      expect(await H.W.journalByKey(`payroll-gl:loan:${first}`)).toEqual({
        "1204": { debit: AMOUNT, credit: 0 },
        "1102": { debit: 0, credit: AMOUNT },
      });
      expect(await H.glBalance(), "GL fell by the principal").toBe(
        gl0 - AMOUNT,
      );
      const second = await H.seedLoan(AMOUNT);
      expectGlRefusal(await H.disburse(second, AMOUNT));
      await H.expectNoCashAvailable();
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);

  it("[1118-control-replay-no-double-journal] delivering the consumed event again posts nothing new: one journal, GL unchanged", async () => {
    try {
      await funded();
      const loan = await H.seedLoan(AMOUNT);
      expect((await H.disburse(loan, AMOUNT)).status).toBe(200);
      const event = await H.loanEvent(loan);
      const first = await H.deliver(event);
      await H.markDelivered(loan);
      expect(first.status).toBe("posted");
      const journals = await H.journalCount();
      const gl = await H.glBalance();

      const replay = await H.deliver(event);

      expect(replay.error, "a replay is not an error").toBeUndefined();
      expect(await H.W.countJournals(`payroll-gl:loan:${loan}`)).toBe(1);
      expect(await H.journalCount()).toBe(journals);
      expect(await H.glBalance()).toBe(gl);
    } finally {
      await H.restoreBaseline();
    }
  }, 120_000);
});
