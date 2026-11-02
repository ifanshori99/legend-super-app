// Mock handlers for the employee payslip, kasbon and reimbursement screens
// (`VITE_API_MOCK=true`), so the PIN gate, the history and both request forms
// work with no API (docs/frontend.md "Typed endpoints and mock mode").
//
// Safety rules are not re-implemented: the kasbon request runs through the
// contract's `assertLoanWithinPolicy` with the fixture policy, the claim runs
// through `reimbursementLimitFor` + `assertReimbursementWithinLimit`, and the
// payslip PIN uses the contract's PAYSLIP_PIN_INVALID / PAYSLIP_PIN_LOCKED
// codes. The demo PIN is fixed for the signed-in fixture employee (CL-1003)
// and is shown on screen only in mock mode.
//
// The employee master reads (`getMyHrisProfile`, employees) are registered in
// lib/mock/handlers/hris-directory.ts; this file imports MOCK_ME/MOCK_OUTLET
// from there instead of registering them again.
import type { Idr } from "@starter/shared/core";
import { businessDateOf, businessDateSchema, idr } from "@starter/shared/core";
import type {
  EmployeeLoan,
  EmployeeLoanStatus,
  PayrollErrorCode,
  Payslip,
  Reimbursement,
} from "@starter/shared/hris/payroll";
import {
  assertLoanWithinPolicy,
  assertReimbursementWithinLimit,
  cafeLegendPayrollFixtures as fixtures,
  createMyLoan,
  createMyReimbursement,
  employeeLoanSchema,
  listMyLoans,
  listMyPayslips,
  listMyReimbursements,
  listReimbursementCategories,
  loanInstallmentFor,
  PayrollError,
  payrollErrorHttpStatus,
  payrollPeriodFor,
  reimbursementLimitFor,
  reimbursementSchema,
  viewMyPayslip,
} from "@starter/shared/hris/payroll";
import { ApiError } from "../../lib/api/errors.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import {
  MOCK_ME as me,
  MOCK_OUTLET as outlet,
} from "../../lib/mock/handlers/hris-directory.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { PAYSLIP_PIN_MAX_ATTEMPTS, isOpenLoan } from "./state.ts";

/** The demo employee's payslip PIN (mock only; the API mints the real one). */
export const DEMO_PAYSLIP_PIN = "123456";

type Replay<T> = { fingerprint: string; value: T };
type PinOutcome = "viewed" | "invalid" | "locked";
type PinReplay = {
  fingerprint: string;
  outcome: PinOutcome;
  payslipId: string;
};

export type PayslipMockState = {
  payslips: Payslip[];
  loans: EmployeeLoan[];
  reimbursements: Reimbursement[];
  loanReplays: Record<string, Replay<EmployeeLoan>>;
  reimbursementReplays: Record<string, Replay<Reimbursement>>;
  /** Idempotency key → the same answer, so a retry burns no second PIN try. */
  pinReplays: Record<string, PinReplay>;
  pinAttempts: number;
  pinLocked: boolean;
};

function seed(): PayslipMockState {
  return {
    payslips: structuredClone(fixtures.payslips),
    loans: structuredClone(fixtures.employeeLoans),
    reimbursements: structuredClone(fixtures.reimbursements),
    loanReplays: {},
    reimbursementReplays: {},
    pinReplays: {},
    pinAttempts: 0,
    pinLocked: false,
  };
}

export const payslipMockStore = createMockStore<PayslipMockState>(seed);

/** The request minus its key: what a replay must repeat exactly. */
function fingerprintOf(body: { idempotencyKey: string }): string {
  const { idempotencyKey, ...rest } = body;
  void idempotencyKey;
  return JSON.stringify(rest);
}

function idempotencyConflict(): ApiError {
  return new ApiError(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "Kunci idempotensi sudah dipakai dengan isi yang berbeda.",
  );
}

/** The contract's error code + HTTP status + safe message, as the API sends it. */
function payrollApiError(code: PayrollErrorCode): ApiError {
  const error = new PayrollError(code);
  return new ApiError(payrollErrorHttpStatus[code], code, error.message);
}

const notFound = (message: string) => new ApiError(404, "NOT_FOUND", message);

function myLoans(): EmployeeLoan[] {
  return payslipMockStore
    .get()
    .loans.filter((loan) => loan.employeeId === me.id)
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));
}

const OPEN_LOAN_STATUSES: readonly EmployeeLoanStatus[] = [
  "pending",
  "approved",
  "disbursed",
];
function monthlyBaseSalaryIdr(): Idr {
  const basic = fixtures.payComponents.find(
    (component) => component.code === "BASIC",
  );
  const row = basic
    ? fixtures.employeePayComponents.find(
        (component) =>
          component.employeeId === me.id && component.componentId === basic.id,
      )
    : undefined;
  return idr(row?.amountIdr ?? 0);
}

/**
 * First payroll period the installment applies to. The API derives this from
 * the tenant payroll calendar; the mock takes the next monthly period so a
 * request is never deducted retroactively.
 */
function nextDeductionPeriodEnd(): string {
  const monthly =
    fixtures.payrollPolicies.find(
      (policy) => policy.cycle.frequency === "monthly",
    ) ?? fixtures.payrollPolicies[0];
  const today = businessDateOf(new Date(), outlet.timeZone);
  const reference = businessDateSchema.parse(
    new Date(Date.parse(`${today}T00:00:00.000Z`) + 40 * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
  return payrollPeriodFor(monthly.cycle, reference).periodEnd;
}

// ---- Reads ----------------------------------------------------------------

registerMock(listMyPayslips, ({ query, scenario }) => {
  const rows = payslipMockStore
    .get()
    .payslips.filter((slip) => slip.employeeId === me.id)
    .sort((left, right) => right.periodStart.localeCompare(left.periodStart))
    // The history row has no amounts: only the PIN-gated view returns them.
    .map((slip) => ({
      id: slip.id,
      payrollRunId: slip.payrollRunId,
      periodStart: slip.periodStart,
      periodEnd: slip.periodEnd,
      payDate: slip.payDate,
      viewedAt: slip.viewedAt,
    }));
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(listMyLoans, ({ query, scenario }) =>
  paginateFixture(myLoans(), query, (loan) => loan.id, scenario),
);

registerMock(listMyReimbursements, ({ query, scenario }) => {
  const rows = payslipMockStore
    .get()
    .reimbursements.filter((claim) => claim.employeeId === me.id)
    .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
  return paginateFixture(rows, query, (claim) => claim.id, scenario);
});

registerMock(listReimbursementCategories, ({ query, scenario }) => {
  const rows = fixtures.reimbursementCategories.filter(
    (category) => category.isActive,
  );
  return paginateFixture(rows, query, (category) => category.id, scenario);
});

// ---- Payslip PIN gate -----------------------------------------------------

registerMock(viewMyPayslip, ({ params, body }) => {
  const state = payslipMockStore.get();
  const fingerprint = fingerprintOf(body);
  const replay = state.pinReplays[body.idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
    if (replay.outcome === "invalid")
      throw payrollApiError("PAYSLIP_PIN_INVALID");
    if (replay.outcome === "locked")
      throw payrollApiError("PAYSLIP_PIN_LOCKED");
    const replayed = state.payslips.find(
      (slip) => slip.id === replay.payslipId,
    );
    if (!replayed) throw notFound("Slip gaji tidak ditemukan.");
    return { data: replayed };
  }

  // HR-01: the mock only ever opens the signed-in employee's own payslip.
  const slip = state.payslips.find(
    (candidate) =>
      candidate.id === params.payslipId && candidate.employeeId === me.id,
  );
  if (!slip) throw notFound("Slip gaji tidak ditemukan.");

  if (state.pinLocked) {
    payslipMockStore.set({
      ...state,
      pinReplays: {
        ...state.pinReplays,
        [body.idempotencyKey]: {
          fingerprint,
          outcome: "locked",
          payslipId: slip.id,
        },
      },
    });
    throw payrollApiError("PAYSLIP_PIN_LOCKED");
  }

  if (body.pin !== DEMO_PAYSLIP_PIN) {
    const attempts = state.pinAttempts + 1;
    const locked = attempts >= PAYSLIP_PIN_MAX_ATTEMPTS;
    payslipMockStore.set({
      ...state,
      pinAttempts: attempts,
      pinLocked: locked,
      pinReplays: {
        ...state.pinReplays,
        [body.idempotencyKey]: {
          fingerprint,
          outcome: locked ? "locked" : "invalid",
          payslipId: slip.id,
        },
      },
    });
    throw payrollApiError(
      locked ? "PAYSLIP_PIN_LOCKED" : "PAYSLIP_PIN_INVALID",
    );
  }

  const viewed: Payslip = { ...slip, viewedAt: new Date().toISOString() };
  payslipMockStore.set({
    ...state,
    // A successful open clears the consecutive-failure counter.
    pinAttempts: 0,
    pinLocked: false,
    payslips: state.payslips.map((candidate) =>
      candidate.id === slip.id ? viewed : candidate,
    ),
    pinReplays: {
      ...state.pinReplays,
      [body.idempotencyKey]: {
        fingerprint,
        outcome: "viewed",
        payslipId: slip.id,
      },
    },
  });
  return { data: viewed };
});

// ---- Kasbon request -------------------------------------------------------

registerMock(createMyLoan, ({ body }) => {
  const state = payslipMockStore.get();
  const fingerprint = fingerprintOf(body);
  const replay = state.loanReplays[body.idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
    return { data: replay.value };
  }

  const openLoanCount = myLoans().filter((loan) =>
    OPEN_LOAN_STATUSES.includes(loan.status),
  ).length;
  try {
    assertLoanWithinPolicy(fixtures.loanPolicy, {
      principalIdr: body.principalIdr,
      installmentCount: body.installmentCount,
      monthlyBaseSalaryIdr: monthlyBaseSalaryIdr(),
      openLoanCount,
    });
  } catch (error) {
    if (error instanceof PayrollError) throw payrollApiError(error.code);
    throw error;
  }

  const loan = employeeLoanSchema.parse({
    id: newIdempotencyKey(),
    tenantId: fixtures.tenant.id,
    employeeId: me.id,
    principalIdr: body.principalIdr,
    installmentIdr: loanInstallmentFor(
      body.principalIdr,
      body.installmentCount,
    ),
    installmentCount: body.installmentCount,
    outstandingIdr: body.principalIdr,
    firstDeductionPeriod: nextDeductionPeriodEnd(),
    reason: body.reason,
    status: "pending",
    requestedAt: new Date().toISOString(),
    decidedBy: null,
    decidedAt: null,
    disbursedAt: null,
    settledAt: null,
  });
  payslipMockStore.set({
    ...state,
    loans: [...state.loans, loan],
    loanReplays: {
      ...state.loanReplays,
      [body.idempotencyKey]: { fingerprint, value: loan },
    },
  });
  return { data: loan };
});

// ---- Reimbursement claim --------------------------------------------------

registerMock(createMyReimbursement, ({ body }) => {
  const state = payslipMockStore.get();
  const fingerprint = fingerprintOf(body);
  const replay = state.reimbursementReplays[body.idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
    return { data: replay.value };
  }

  const category = fixtures.reimbursementCategories.find(
    (candidate) => candidate.id === body.categoryId && candidate.isActive,
  );
  if (!category) throw notFound("Kategori reimburse tidak ditemukan.");
  if (category.receiptRequired && body.receiptUploadRef === null)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Kategori ini mewajibkan foto bukti.",
      [{ field: "receiptUploadRef", message: "Foto bukti wajib diisi." }],
    );
  try {
    assertReimbursementWithinLimit(
      reimbursementLimitFor(category, null),
      body.amountIdr,
      idr(0),
    );
  } catch (error) {
    if (error instanceof PayrollError) throw payrollApiError(error.code);
    throw error;
  }

  // The mock has no private bucket: the browser's object URL stands in for the
  // pre-signed upload reference, so the claim can show its own photo back.
  const receiptUrl =
    body.receiptUploadRef !== null &&
    /^(blob:|data:|https?:)/.test(body.receiptUploadRef)
      ? body.receiptUploadRef
      : null;
  const claim = reimbursementSchema.parse({
    id: newIdempotencyKey(),
    tenantId: fixtures.tenant.id,
    employeeId: me.id,
    categoryId: body.categoryId,
    expenseDate: body.expenseDate,
    amountIdr: body.amountIdr,
    approvedAmountIdr: null,
    description: body.description,
    receiptUrl,
    payout: body.payout,
    status: "submitted",
    payrollRunId: null,
    submittedAt: new Date().toISOString(),
    decidedBy: null,
    decidedAt: null,
    paidAt: null,
  });
  payslipMockStore.set({
    ...state,
    reimbursements: [...state.reimbursements, claim],
    reimbursementReplays: {
      ...state.reimbursementReplays,
      [body.idempotencyKey]: { fingerprint, value: claim },
    },
  });
  return { data: claim };
});
