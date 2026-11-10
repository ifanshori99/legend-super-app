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
import { businessDateSchema, idr, localDateOf } from "@starter/shared/core";
import type {
  EmployeeLoan,
  EmployeeLoanStatus,
  PayrollErrorCode,
  Payslip,
  PayslipPinStatus,
  Reimbursement,
} from "@starter/shared/hris/payroll";
import {
  assertLoanWithinPolicy,
  assertReimbursementWithinLimit,
  cafeLegendPayrollFixtures as fixtures,
  createMyLoan,
  createMyReimbursement,
  employeeLoanSchema,
  getMyPayslipPinStatus,
  listMyLoans,
  listMyPayslips,
  listMyReimbursements,
  listReimbursementCategories,
  loanInstallmentFor,
  PayrollError,
  payrollErrorHttpStatus,
  PAYSLIP_PIN_LOCK_MINUTES,
  PAYSLIP_PIN_OTP_MAX_ATTEMPTS,
  PAYSLIP_PIN_OTP_TTL_MINUTES,
  payrollPeriodFor,
  reimbursementLimitFor,
  reimbursementSchema,
  requestMyPayslipPinResetOtp,
  setMyPayslipPin,
  verifyMyPayslipPinResetOtp,
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
import { PAYSLIP_PIN_MAX_ATTEMPTS } from "./pin-state.ts";

/** The demo employee's payslip PIN (mock only; the API mints the real one). */
export const DEMO_PAYSLIP_PIN = "123456";
/** The WhatsApp code the mock accepts in the "otp-ok" scenario. */
export const DEMO_PAYSLIP_OTP = "482916";

const PIN_LOCK_MS = PAYSLIP_PIN_LOCK_MINUTES * 60_000;
const OTP_TTL_MS = PAYSLIP_PIN_OTP_TTL_MINUTES * 60_000;
const OTP_REQUESTS_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

/**
 * WhatsApp reset scenarios. The default is what production does before an
 * adapter exists: the request answers 503 "belum tersedia". `?mock=otp-ok`
 * sends and accepts `DEMO_PAYSLIP_OTP`; `?mock=otp-rate-limited` answers 429.
 * Read here, not from the shared scenario list, so the feature owns them.
 */
export type PayslipOtpMockMode = "unavailable" | "ok" | "rate_limited";
const OTP_MODE_PARAMS: Record<string, PayslipOtpMockMode> = {
  "otp-ok": "ok",
  "otp-rate-limited": "rate_limited",
};
let otpMode: PayslipOtpMockMode = "unavailable";

export function setPayslipOtpMockMode(mode: PayslipOtpMockMode) {
  otpMode = mode;
}

/** The `?mock=` value of the page URL, or null (also outside a browser). */
function mockParam(): string | null {
  const scope = globalThis as unknown as {
    window?: { location?: { search?: string } };
  };
  return new URLSearchParams(scope.window?.location?.search ?? "").get("mock");
}

function currentOtpMode(): PayslipOtpMockMode {
  const param = mockParam();
  if (param !== null && param in OTP_MODE_PARAMS)
    otpMode = OTP_MODE_PARAMS[param];
  return otpMode;
}

type Replay<T> = { fingerprint: string; value: T };
/** A failed PIN check, kept so a replay answers exactly like the first call. */
type PinFailure = {
  code: Extract<
    PayrollErrorCode,
    "PAYSLIP_PIN_INVALID" | "PAYSLIP_PIN_LOCKED" | "PAYSLIP_PIN_NOT_SET"
  >;
  remainingAttempts?: number;
  lockedUntil?: string;
};
type PinReplay = {
  fingerprint: string;
  failure: PinFailure | null;
  /** Set for a payslip view; null for set / verify. */
  payslipId: string | null;
  status: PayslipPinStatus | null;
};
type OtpChallenge = { expiresAt: string; attempts: number };

export type PayslipMockState = {
  payslips: Payslip[];
  loans: EmployeeLoan[];
  reimbursements: Reimbursement[];
  loanReplays: Record<string, Replay<EmployeeLoan>>;
  reimbursementReplays: Record<string, Replay<Reimbursement>>;
  /** Idempotency key → the same answer, so a retry burns no second PIN try. */
  pinReplays: Record<string, PinReplay>;
  /** The signed-in demo employee's PIN; null until they create one. */
  pin: string | null;
  pinAttempts: number;
  pinLockedUntil: string | null;
  otp: OtpChallenge | null;
  /** The `?mock=pin-*` scenario already applied, so it seeds the PIN once. */
  pinScenario: string | null;
  /** ISO times of the WhatsApp codes asked for, for the 3-per-hour cap. */
  otpRequests: string[];
};

function seed(): PayslipMockState {
  return {
    payslips: structuredClone(fixtures.payslips),
    loans: structuredClone(fixtures.employeeLoans),
    reimbursements: structuredClone(fixtures.reimbursements),
    loanReplays: {},
    reimbursementReplays: {},
    pinReplays: {},
    pin: DEMO_PAYSLIP_PIN,
    pinAttempts: 0,
    pinLockedUntil: null,
    otp: null,
    pinScenario: null,
    otpRequests: [],
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
function payrollApiError(
  code: PayrollErrorCode,
  extra?: { remainingAttempts?: number; lockedUntil?: string },
): ApiError {
  const error = new PayrollError(code);
  return new ApiError(
    payrollErrorHttpStatus[code],
    code,
    error.message,
    undefined,
    extra,
  );
}

function failureError(failure: PinFailure): ApiError {
  return payrollApiError(failure.code, {
    remainingAttempts: failure.remainingAttempts,
    lockedUntil: failure.lockedUntil,
  });
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
  const today = localDateOf(new Date(), outlet.timeZone);
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

// ---- Payslip PIN ----------------------------------------------------------

/** The state with an ended lock cleared (the API clears it on the next call). */
function withExpiredLockCleared(state: PayslipMockState): PayslipMockState {
  if (
    state.pinLockedUntil !== null &&
    Date.parse(state.pinLockedUntil) <= Date.now()
  )
    return { ...state, pinLockedUntil: null, pinAttempts: 0 };
  return state;
}

/**
 * `?mock=pin-not-set` starts without a PIN (view answers 409 until a PUT sets
 * one); `?mock=pin-locked` starts locked for 15 minutes (view answers 423).
 * Applied once per scenario, so a later PUT or OTP reset is not undone.
 */
function applyPinScenario(): void {
  const param = mockParam();
  const state = payslipMockStore.get();
  if (param === state.pinScenario) return;
  if (param === "pin-not-set")
    payslipMockStore.set({
      ...state,
      pinScenario: param,
      pin: null,
      pinAttempts: 0,
      pinLockedUntil: null,
    });
  else if (param === "pin-locked")
    payslipMockStore.set({
      ...state,
      pinScenario: param,
      pin: state.pin ?? DEMO_PAYSLIP_PIN,
      pinAttempts: PAYSLIP_PIN_MAX_ATTEMPTS,
      pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS).toISOString(),
    });
}

function statusOf(state: PayslipMockState): PayslipPinStatus {
  const live = withExpiredLockCleared(state);
  if (live.pin === null) return { status: "not_set", lockedUntil: null };
  if (live.pinLockedUntil !== null)
    return { status: "locked", lockedUntil: live.pinLockedUntil };
  return { status: "active", lockedUntil: null };
}

type PinAttempt = { next: PayslipMockState; failure: PinFailure | null };

/** One PIN try: wrong ones count, the fifth locks for 15 minutes. */
function attemptPin(current: PayslipMockState, pin: string): PinAttempt {
  const state = withExpiredLockCleared(current);
  if (state.pin === null)
    return { next: state, failure: { code: "PAYSLIP_PIN_NOT_SET" } };
  if (state.pinLockedUntil !== null)
    return {
      next: state,
      failure: {
        code: "PAYSLIP_PIN_LOCKED",
        lockedUntil: state.pinLockedUntil,
      },
    };
  if (pin === state.pin)
    return { next: { ...state, pinAttempts: 0 }, failure: null };
  const attempts = state.pinAttempts + 1;
  if (attempts >= PAYSLIP_PIN_MAX_ATTEMPTS) {
    const lockedUntil = new Date(Date.now() + PIN_LOCK_MS).toISOString();
    return {
      next: { ...state, pinAttempts: attempts, pinLockedUntil: lockedUntil },
      failure: { code: "PAYSLIP_PIN_LOCKED", lockedUntil },
    };
  }
  return {
    next: { ...state, pinAttempts: attempts },
    failure: {
      code: "PAYSLIP_PIN_INVALID",
      remainingAttempts: PAYSLIP_PIN_MAX_ATTEMPTS - attempts,
    },
  };
}

function rememberPin(
  state: PayslipMockState,
  key: string,
  replay: PinReplay,
): PayslipMockState {
  return { ...state, pinReplays: { ...state.pinReplays, [key]: replay } };
}

/** The earlier answer for a key, or a conflict if the request changed. */
function replayOf(
  state: PayslipMockState,
  key: string,
  fingerprint: string,
): PinReplay | null {
  const replay = state.pinReplays[key];
  if (!replay) return null;
  if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
  return replay;
}

registerMock(getMyPayslipPinStatus, () => {
  applyPinScenario();
  return { data: statusOf(payslipMockStore.get()) };
});

registerMock(viewMyPayslip, ({ params, body }) => {
  applyPinScenario();
  const state = payslipMockStore.get();
  // The payslip id is part of the request: a reused key on another slip is a
  // conflict, never a replay of the first slip's answer.
  const fingerprint = `${params.payslipId}|${fingerprintOf(body)}`;
  const replay = replayOf(state, body.idempotencyKey, fingerprint);
  if (replay) {
    if (replay.failure) throw failureError(replay.failure);
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

  const { next, failure } = attemptPin(state, body.pin);
  if (failure) {
    payslipMockStore.set(
      rememberPin(next, body.idempotencyKey, {
        fingerprint,
        failure,
        payslipId: slip.id,
        status: null,
      }),
    );
    throw failureError(failure);
  }

  const viewed: Payslip = { ...slip, viewedAt: new Date().toISOString() };
  payslipMockStore.set(
    rememberPin(
      {
        ...next,
        payslips: next.payslips.map((candidate) =>
          candidate.id === slip.id ? viewed : candidate,
        ),
      },
      body.idempotencyKey,
      { fingerprint, failure: null, payslipId: slip.id, status: null },
    ),
  );
  return { data: viewed };
});

registerMock(setMyPayslipPin, ({ body }) => {
  applyPinScenario();
  const state = payslipMockStore.get();
  const fingerprint = fingerprintOf(body);
  const replay = replayOf(state, body.idempotencyKey, fingerprint);
  if (replay) {
    if (replay.failure) throw failureError(replay.failure);
    return { data: replay.status ?? statusOf(state) };
  }

  let working = withExpiredLockCleared(state);
  if (working.pin !== null) {
    // A change needs the current PIN, and a wrong one counts like at opening.
    if (body.currentPin === undefined)
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "PIN saat ini wajib diisi untuk mengganti PIN slip gaji.",
      );
    const { next, failure } = attemptPin(working, body.currentPin);
    if (failure) {
      payslipMockStore.set(
        rememberPin(next, body.idempotencyKey, {
          fingerprint,
          failure,
          payslipId: null,
          status: null,
        }),
      );
      throw failureError(failure);
    }
    working = next;
  }

  const updated: PayslipMockState = {
    ...working,
    pin: body.pin,
    pinAttempts: 0,
    pinLockedUntil: null,
  };
  const status = statusOf(updated);
  payslipMockStore.set(
    rememberPin(updated, body.idempotencyKey, {
      fingerprint,
      failure: null,
      payslipId: null,
      status,
    }),
  );
  return { data: status };
});

registerMock(requestMyPayslipPinResetOtp, () => {
  const mode = currentOtpMode();
  // Default: no WhatsApp sender is set up yet.
  if (mode === "unavailable")
    throw new ApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "Kode WhatsApp belum tersedia.",
    );
  const state = payslipMockStore.get();
  const now = Date.now();
  const recent = state.otpRequests.filter(
    (at) => now - Date.parse(at) < HOUR_MS,
  );
  if (mode === "rate_limited" || recent.length >= OTP_REQUESTS_PER_HOUR)
    throw new ApiError(
      429,
      "RATE_LIMITED",
      "Terlalu banyak permintaan kode. Coba lagi dalam satu jam atau hubungi HR.",
    );
  const expiresAt = new Date(now + OTP_TTL_MS).toISOString();
  payslipMockStore.set({
    ...state,
    otp: { expiresAt, attempts: 0 },
    otpRequests: [...recent, new Date(now).toISOString()],
  });
  return { data: { expiresAt } };
});

registerMock(verifyMyPayslipPinResetOtp, ({ body }) => {
  if (currentOtpMode() === "unavailable")
    throw new ApiError(
      503,
      "SERVICE_UNAVAILABLE",
      "Kode WhatsApp belum tersedia.",
    );
  const state = payslipMockStore.get();
  const fingerprint = fingerprintOf(body);
  const replay = replayOf(state, body.idempotencyKey, fingerprint);
  if (replay) {
    if (replay.failure) throw failureError(replay.failure);
    return { data: replay.status ?? statusOf(state) };
  }

  const challenge = state.otp;
  const live =
    challenge !== null && Date.parse(challenge.expiresAt) > Date.now();
  if (!live || challenge === null) {
    // Unknown, expired or used: answers like a wrong code, counts nothing.
    const failure: PinFailure = { code: "PAYSLIP_PIN_INVALID" };
    payslipMockStore.set(
      rememberPin(state, body.idempotencyKey, {
        fingerprint,
        failure,
        payslipId: null,
        status: null,
      }),
    );
    throw failureError(failure);
  }

  if (body.code !== DEMO_PAYSLIP_OTP) {
    const attempts = challenge.attempts + 1;
    let failure: PinFailure;
    let next: PayslipMockState;
    if (attempts >= PAYSLIP_PIN_OTP_MAX_ATTEMPTS) {
      // The fifth wrong code burns the challenge and locks the PIN.
      const lockedUntil = new Date(Date.now() + PIN_LOCK_MS).toISOString();
      failure = { code: "PAYSLIP_PIN_LOCKED", lockedUntil };
      next = { ...state, otp: null, pinLockedUntil: lockedUntil };
    } else {
      failure = {
        code: "PAYSLIP_PIN_INVALID",
        remainingAttempts: PAYSLIP_PIN_OTP_MAX_ATTEMPTS - attempts,
      };
      next = { ...state, otp: { ...challenge, attempts } };
    }
    payslipMockStore.set(
      rememberPin(next, body.idempotencyKey, {
        fingerprint,
        failure,
        payslipId: null,
        status: null,
      }),
    );
    throw failureError(failure);
  }

  const updated: PayslipMockState = {
    ...state,
    pin: body.pin,
    pinAttempts: 0,
    pinLockedUntil: null,
    otp: null,
  };
  const status = statusOf(updated);
  payslipMockStore.set(
    rememberPin(updated, body.idempotencyKey, {
      fingerprint,
      failure: null,
      payslipId: null,
      status,
    }),
  );
  return { data: status };
});

/**
 * HR reset (`resetEmployeePayslipPin`, registered by the employee master mock):
 * clears the demo employee's PIN and lock so the next visit shows "buat PIN".
 */
export function resetMockPayslipPin(employeeId: string): PayslipPinStatus {
  if (employeeId === me.id) {
    payslipMockStore.set({
      ...payslipMockStore.get(),
      pin: null,
      pinAttempts: 0,
      pinLockedUntil: null,
      otp: null,
    });
  }
  return { status: "not_set", lockedUntil: null };
}

// ---- Kasbon request -------------------------------------------------------

registerMock(createMyLoan, ({ body }) => {
  const state = payslipMockStore.get();
  const fingerprint = fingerprintOf(body);
  const replay = state.loanReplays[body.idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
    return { data: replay.value };
  }

  const openLoans = myLoans().filter((loan) =>
    OPEN_LOAN_STATUSES.includes(loan.status),
  );
  const openLoanCount = openLoans.length;
  const openOutstandingIdr = idr(
    openLoans.reduce((sum, loan) => sum + loan.outstandingIdr, 0),
  );
  try {
    assertLoanWithinPolicy(fixtures.loanPolicy, {
      principalIdr: body.principalIdr,
      installmentCount: body.installmentCount,
      monthlyBaseSalaryIdr: monthlyBaseSalaryIdr(),
      openLoanCount,
      openOutstandingIdr,
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
