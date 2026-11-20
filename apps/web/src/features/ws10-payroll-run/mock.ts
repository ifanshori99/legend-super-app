// Mock mode for the payroll-run wizard and service-charge screens (docs/
// frontend.md "Typed endpoints and mock mode"), so every screen works with
// VITE_API_MOCK=true and the Playwright spec runs without an API.
//
// State transitions are NOT re-implemented here: every run action goes through
// the contract's `applyPayrollRunCommand` and every pool action through
// `transitionServiceChargePool`, exactly like the API will. That keeps PAYR-01
// (two approvals by two people before lock) and the reversal separation visible
// in the mock instead of being a UI promise.
//
// The mock's signed-in actor comes from the same `legend-mock-role` cookie the
// area guards read: `finance` and `owner` act as the fixture finance approver,
// every other role acts as the fixture HR approver. The Playwright spec uses
// that to prove the second approval fails for the first approver.
//
// Authorization is enforced here, server-like, not only in the UI: every
// handler checks the role template's permissions per the contract's route
// table (endpoints.ts header; decision legend-t3f5 for reads) and answers 403
// FORBIDDEN otherwise. The final approver must differ from the HR approver
// (contract reducer) AND from the run's requester (PRD §3 Matriks Approval;
// checked here because the reducer does not know the requester rule). During
// SSR there is no cookie to read: only the run/pool reads a route loader
// prefetches are served there (the page guard already checked the visitor);
// everything else fails closed.
//
// Demo simplifications, stated so nobody mistakes them for business rules:
// - salary amounts of a run created in the mock are the fixture simulation with
//   the run's period labels (the API recalculates from attendance);
// - service-charge attendance is 22 days per participant (the API aggregates
//   attendance logs);
// - a pay date is the policy's raw date (the API applies the working-day rule).
import type { PermissionCode } from "@starter/shared/access";
import { ApiError } from "@/lib/api/errors";
import {
  accessForMockRole,
  MOCK_ROLE_COOKIE,
  parseMockRole,
} from "@/lib/areas/access";
import { holdsAny } from "@/lib/areas/guard";
import { paginateFixture } from "@/lib/mock/paginate";
import { registerMock } from "@/lib/mock/registry";
import { createMockStore } from "@/lib/mock/store";
import { decimal4Schema } from "@starter/shared/core";
import { cafeLegendHrisFixtures } from "@starter/shared/hris";
import {
  applyPayrollRunCommand,
  approvePayrollRunFinal,
  approvePayrollRunHr,
  approveServiceChargePool,
  cafeLegendPayrollFixtures,
  calculateServiceChargePool,
  createBankTransferFile,
  createPayrollRun,
  createPayrollTaxExport,
  createServiceChargePool,
  decidePayrollRunReversal,
  distributeServiceChargePool,
  getPayrollRun,
  listBankTransferFiles,
  listPayrollRunEmployeeResults,
  listPayrollRunPayslips,
  listPayrollRuns,
  listServiceChargeAllocations,
  listServiceChargePools,
  lockPayrollRun,
  markPayrollRunPaid,
  PayrollError,
  payrollRunEmployeeResultSchema,
  payrollRunSchema,
  payrollTaxExportSchema,
  payslipSchema,
  payrollPeriodFor,
  requestPayrollRunReversal,
  returnPayrollRunToDraft,
  serviceChargeAllocationSchema,
  serviceChargePoolSchema,
  simulatePayrollRun,
  sumPayrollRunTotals,
  transitionServiceChargePool,
  type BankTransferFile,
  type PayrollRun,
  type PayrollRunCommand,
  type PayrollRunEmployeeResult,
  type PayrollTaxExport,
  type Payslip,
  type ServiceChargeAllocation,
  type ServiceChargeParticipant,
  type ServiceChargePool,
} from "@starter/shared/hris/payroll";
import { newIdempotencyKey } from "../../lib/idempotency.ts";
import {
  PAYROLL_APPROVE_PERMISSION,
  PAYROLL_CANCEL_PERMISSION,
  PAYROLL_LOCK_PERMISSION,
  PAYROLL_RUN_PERMISSION,
  PAYROLL_RUN_READ_PERMISSIONS,
  PAYROLL_SALARY_PERMISSIONS,
  SERVICE_CHARGE_PERMISSIONS,
} from "./guard";

const fixtures = cafeLegendPayrollFixtures;
const hris = cafeLegendHrisFixtures;
const { tenant, userIds } = fixtures;

/** A UUID v4 for rows this mock creates (the API mints them in Postgres). */
const newUuid = () => newIdempotencyKey();

const seedRuns: PayrollRun[] = [
  fixtures.payrollRuns.october,
  fixtures.payrollRuns.november,
  fixtures.payrollRuns.december,
];

/** The October run has payslips but no stored review rows; rebuild them. */
function resultFromPayslip(slip: Payslip): PayrollRunEmployeeResult {
  return payrollRunEmployeeResultSchema.parse({
    employeeId: slip.employeeId,
    employeeNo: slip.employeeNo,
    employeeName: slip.employeeName,
    positionName: slip.positionName,
    outletId: slip.outletId,
    periodStart: slip.periodStart,
    periodEnd: slip.periodEnd,
    payDate: slip.payDate,
    grossIdr: slip.grossIdr,
    deductionsIdr: slip.deductionsIdr,
    netIdr: slip.netIdr,
    pph21Idr: slip.pph21Idr,
    bpjsEmployeeIdr: slip.bpjsEmployeeIdr,
    bpjsCompanyIdr: slip.bpjsCompanyIdr,
    serviceChargeIdr: slip.serviceChargeIdr,
    overtimeIdr: slip.overtimeIdr,
    lines: slip.lines,
    bpjs: slip.bpjs,
    tax: slip.tax,
    paymentMethod: slip.paymentMethod,
    previousNetIdr: null,
    netChangeIdr: null,
    flags: [],
  });
}

function slipFromResult(
  runId: string,
  row: PayrollRunEmployeeResult,
  createdAt: string,
): Payslip {
  return payslipSchema.parse({
    id: newUuid(),
    tenantId: tenant.id,
    payrollRunId: runId,
    employeeId: row.employeeId,
    employeeNo: row.employeeNo,
    employeeName: row.employeeName,
    positionName: row.positionName,
    outletId: row.outletId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    payDate: row.payDate,
    grossIdr: row.grossIdr,
    deductionsIdr: row.deductionsIdr,
    netIdr: row.netIdr,
    pph21Idr: row.pph21Idr,
    bpjsEmployeeIdr: row.bpjsEmployeeIdr,
    bpjsCompanyIdr: row.bpjsCompanyIdr,
    serviceChargeIdr: row.serviceChargeIdr,
    overtimeIdr: row.overtimeIdr,
    lines: row.lines,
    bpjs: row.bpjs,
    tax: row.tax,
    paymentMethod: row.paymentMethod,
    fileUrl: null,
    viewedAt: null,
    createdAt,
  });
}

type PayrollMockState = {
  runs: PayrollRun[];
  /** Review rows per run (the contract has no run id on the row itself). */
  resultsByRun: Record<string, PayrollRunEmployeeResult[]>;
  payslips: Payslip[];
  bankFiles: BankTransferFile[];
  taxExports: PayrollTaxExport[];
  pools: ServiceChargePool[];
  allocations: ServiceChargeAllocation[];
};

function seedState(): PayrollMockState {
  const october = fixtures.payrollRuns.october;
  const november = fixtures.payrollRuns.november;
  const december = fixtures.payrollRuns.december;
  return {
    runs: structuredClone(seedRuns),
    resultsByRun: {
      [october.id]: fixtures.payslips.map(resultFromPayslip),
      [november.id]: structuredClone(fixtures.employeeResults),
      [december.id]: [],
    },
    payslips: structuredClone(fixtures.payslips),
    bankFiles: structuredClone(fixtures.bankTransferFiles),
    taxExports: [],
    pools: structuredClone(fixtures.serviceChargePools),
    allocations: structuredClone(fixtures.serviceChargeAllocations),
  };
}

const store = createMockStore<PayrollMockState>(seedState);
type Replay = { fingerprint: string; value: unknown };
const replays = createMockStore(() => new Map<string, Replay>());

const state = () => store.get();
const now = () => new Date().toISOString();

function notFound(what: string): never {
  throw new ApiError(404, "NOT_FOUND", `${what} tidak ditemukan.`);
}

function invalid(message: string): never {
  throw new ApiError(409, "PAYROLL_RUN_INVALID_TRANSITION", message);
}

/** Runs a contract mutation and lifts `PayrollError` to the API vocabulary. */
function contract<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof PayrollError)
      throw new ApiError(error.status, error.code, error.message);
    throw error;
  }
}

/**
 * Creates once per idempotency key and refuses a reused key with a different
 * body, like the API (docs/plan/contracts.md "Idempotent mutations").
 */
function once<T>(key: string, body: unknown, create: () => T): T {
  const fingerprint = JSON.stringify(body);
  const seen = replays.get().get(key);
  if (seen !== undefined) {
    if (seen.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci idempotensi sudah dipakai untuk permintaan lain.",
      );
    return seen.value as T;
  }
  const value = create();
  replays.get().set(key, { fingerprint, value });
  return value;
}

/** Runs one write once per idempotency key (a retry returns the same row). */
function onceAction<T>(
  key: string,
  runId: string,
  action: string,
  create: () => T,
): T {
  return once(key, { runId, action }, create);
}

/** The raw `legend-mock-role` cookie, or undefined on the server. */
function mockRoleCookie(): string | undefined {
  const row = document.cookie
    .split("; ")
    .find((cookie) => cookie.startsWith(`${MOCK_ROLE_COOKIE}=`));
  return row?.slice(MOCK_ROLE_COOKIE.length + 1);
}

/** `legend-mock-role` → the fixture payroll actor (see the file header). */
function currentActor() {
  if (typeof document === "undefined") return userIds.hrApprover;
  const role = parseMockRole(mockRoleCookie());
  return role === "finance" || role === "owner"
    ? userIds.financeApprover
    : userIds.hrApprover;
}

/**
 * 403 unless the caller's role holds one of `anyOf` (fail closed). On the
 * server only an `ssrRead` (a loader prefetch behind the page guard) passes.
 */
function requirePermission(
  anyOf: readonly PermissionCode[],
  options: { ssrRead?: boolean } = {},
): void {
  if (typeof document === "undefined") {
    if (options.ssrRead) return;
  } else if (
    holdsAny(accessForMockRole(parseMockRole(mockRoleCookie())), anyOf)
  ) {
    return;
  }
  throw new ApiError(
    403,
    "FORBIDDEN",
    "Anda tidak punya izin untuk tindakan payroll ini.",
  );
}

const READ_RUNS = PAYROLL_RUN_READ_PERMISSIONS;
const RUN = [PAYROLL_RUN_PERMISSION] as const;
const APPROVE = [PAYROLL_APPROVE_PERMISSION] as const;
const LOCK = [PAYROLL_LOCK_PERMISSION] as const;
const CANCEL = [PAYROLL_CANCEL_PERMISSION] as const;
const SALARY = PAYROLL_SALARY_PERMISSIONS;
/** Per-employee allocations: salary readers plus the pool approver. */
const ALLOCATIONS = [...PAYROLL_SALARY_PERMISSIONS, PAYROLL_APPROVE_PERMISSION];

function requireRun(runId: string): PayrollRun {
  return (
    state().runs.find((run) => run.id === runId) ?? notFound("Payroll run")
  );
}

function requirePool(poolId: string): ServiceChargePool {
  return (
    state().pools.find((pool) => pool.id === poolId) ??
    notFound("Pool service charge")
  );
}

function replaceRun(next: PayrollRun) {
  store.set({
    ...state(),
    runs: state().runs.map((run) => (run.id === next.id ? next : run)),
  });
}

/** One run action through the contract reducer, then stored. */
function applyRun(run: PayrollRun, command: PayrollRunCommand): PayrollRun {
  const next = contract(() =>
    payrollRunSchema.parse(applyPayrollRunCommand(run, command)),
  );
  replaceRun(next);
  return next;
}

/** The newest snapshot to copy into a run the mock simulates for the first time. */
function templateSnapshot(run: PayrollRun) {
  if (run.configSnapshot) return run.configSnapshot;
  const source = state().runs.find((row) => row.configSnapshot !== null);
  if (!source?.configSnapshot) notFound("Snapshot konfigurasi payroll");
  return structuredClone(source.configSnapshot);
}

/**
 * Review rows of a simulation. The seeded November run keeps its fixture rows;
 * a run the mock created reuses those amounts with its own period labels (the
 * API recalculates — see the file header).
 */
function simulateResults(run: PayrollRun): PayrollRunEmployeeResult[] {
  const own = state().resultsByRun[run.id];
  if (own && own.length > 0) return own;
  const template = Object.values(state().resultsByRun).find(
    (rows) => rows.length > 0,
  );
  if (!template) invalid("Belum ada data karyawan untuk disimulasikan.");
  return template.map((row) =>
    payrollRunEmployeeResultSchema.parse({
      ...row,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      payDate: run.payDate,
    }),
  );
}

// ---- Payroll runs --------------------------------------------------------

registerMock(listPayrollRuns, ({ query, scenario }) => {
  requirePermission(READ_RUNS, { ssrRead: true });
  const rows = [...state().runs]
    .filter((run) => query.status === undefined || run.status === query.status)
    .filter(
      (run) =>
        query.legalEntityId === undefined ||
        run.legalEntityId === query.legalEntityId,
    )
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  return paginateFixture(rows, query, (run) => run.id, scenario);
});

registerMock(getPayrollRun, ({ params }) => {
  requirePermission(READ_RUNS, { ssrRead: true });
  return { data: requireRun(params.payrollRunId) };
});

registerMock(createPayrollRun, ({ body }) => {
  requirePermission(RUN);
  const policy = fixtures.payrollPolicies.find(
    (row) => row.id === body.payrollPolicyId,
  );
  if (!policy) notFound("Kebijakan payroll");
  const period = payrollPeriodFor(policy.cycle, body.referenceDate);
  if (body.runType === "thr" && body.thrScheduleId === null)
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Payroll THR harus menyebut jadwal THR.",
    );
  // A replay of the same key returns the stored run before the duplicate
  // check, so a retry after a lost response is not refused as a conflict.
  const run = once(body.idempotencyKey, body, () => {
    const duplicate = state().runs.find(
      (row) =>
        row.payrollPolicyId === policy.id &&
        row.periodStart === period.periodStart &&
        row.runType === body.runType,
    );
    if (duplicate)
      throw new ApiError(
        409,
        "CONFLICT",
        "Periode ini sudah punya payroll run.",
      );
    return payrollRunSchema.parse({
      id: newUuid(),
      tenantId: tenant.id,
      legalEntityId: policy.legalEntityId,
      payrollPolicyId: policy.id,
      runType: body.runType,
      thrScheduleId: body.thrScheduleId,
      ...period,
      status: "draft",
      simulationCount: 0,
      lastSimulatedAt: null,
      totals: null,
      configSnapshot: null,
      approvedByHr: null,
      approvedByHrAt: null,
      approvedByFinance: null,
      approvedByFinanceAt: null,
      lockedBy: null,
      lockedAt: null,
      paidBy: null,
      paidAt: null,
      reversal: null,
      createdBy: currentActor(),
      createdAt: now(),
      updatedAt: now(),
    });
  });
  if (!state().runs.some((row) => row.id === run.id))
    store.set({
      ...state(),
      runs: [...state().runs, run],
      resultsByRun: { ...state().resultsByRun, [run.id]: [] },
    });
  return { data: run };
});

registerMock(simulatePayrollRun, ({ params, body }) => {
  requirePermission(RUN);
  const run = requireRun(params.payrollRunId);
  const next = onceAction(body.idempotencyKey, run.id, "simulate", () => {
    const rows = simulateResults(run);
    const simulated = applyRun(run, {
      action: "simulate",
      at: now(),
      totals: sumPayrollRunTotals(rows),
      configSnapshot: templateSnapshot(run),
    });
    store.set({
      ...state(),
      resultsByRun: { ...state().resultsByRun, [run.id]: rows },
    });
    return simulated;
  });
  return { data: next };
});

registerMock(listPayrollRunEmployeeResults, ({ params, query, scenario }) => {
  requirePermission(SALARY);
  const run = requireRun(params.payrollRunId);
  const rows = (state().resultsByRun[run.id] ?? []).filter(
    (row) => query.outletId === undefined || row.outletId === query.outletId,
  );
  return paginateFixture(rows, query, (row) => row.employeeId, scenario);
});

registerMock(returnPayrollRunToDraft, ({ params, body }) => {
  requirePermission(RUN);
  const run = requireRun(params.payrollRunId);
  const next = once(
    body.idempotencyKey,
    { runId: run.id, action: "return_to_draft", reason: body.reason },
    () => {
      const drafted = applyRun(run, {
        action: "return_to_draft",
        at: now(),
      });
      store.set({
        ...state(),
        resultsByRun: { ...state().resultsByRun, [run.id]: [] },
      });
      return drafted;
    },
  );
  return { data: next };
});

registerMock(approvePayrollRunHr, ({ params, body }) => {
  requirePermission(RUN);
  const run = requireRun(params.payrollRunId);
  const next = onceAction(body.idempotencyKey, run.id, "approve_hr", () => {
    if (body.expectedSimulationCount !== run.simulationCount)
      throw new ApiError(
        409,
        "PAYROLL_RUN_SIMULATION_STALE",
        "Simulasi payroll sudah berubah sejak Anda membukanya.",
      );
    return applyRun(run, {
      action: "approve_hr",
      actorId: currentActor(),
      at: now(),
    });
  });
  return { data: next };
});

registerMock(approvePayrollRunFinal, ({ params, body }) => {
  requirePermission(APPROVE);
  const run = requireRun(params.payrollRunId);
  const next = onceAction(body.idempotencyKey, run.id, "approve_final", () => {
    const actorId = currentActor();
    // PRD §3 Matriks Approval: the final approver is neither the HR approver
    // (the reducer checks that) nor the person who requested the run.
    if (actorId === run.createdBy)
      throw new ApiError(
        409,
        "PAYROLL_APPROVER_NOT_DISTINCT",
        "Penyetuju final harus berbeda dari pembuat payroll run.",
      );
    return applyRun(run, { action: "approve_final", actorId, at: now() });
  });
  return { data: next };
});

registerMock(lockPayrollRun, ({ params, body }) => {
  requirePermission(LOCK);
  const run = requireRun(params.payrollRunId);
  const next = onceAction(body.idempotencyKey, run.id, "lock", () => {
    const locked = applyRun(run, {
      action: "lock",
      actorId: currentActor(),
      at: now(),
    });
    const createdAt = now();
    const rows = state().resultsByRun[run.id] ?? [];
    const payslips = rows.map((row) => slipFromResult(run.id, row, createdAt));
    // Alur K step 4: locking distributes the approved pools it pays.
    const pools = state().pools.map((pool) => {
      if (
        pool.status !== "approved" ||
        pool.periodStart > run.periodEnd ||
        pool.periodEnd < run.periodStart
      )
        return pool;
      return serviceChargePoolSchema.parse({
        ...pool,
        status: transitionServiceChargePool(pool.status, "distribute"),
        payrollRunId: run.id,
      });
    });
    store.set({
      ...state(),
      runs: state().runs.map((row) => (row.id === run.id ? locked : row)),
      payslips: [
        ...state().payslips.filter((slip) => slip.payrollRunId !== run.id),
        ...payslips,
      ],
      pools,
    });
    return locked;
  });
  return { data: next };
});

registerMock(markPayrollRunPaid, ({ params, body }) => {
  requirePermission(LOCK);
  const run = requireRun(params.payrollRunId);
  if (body.bankTransferFileId !== null) {
    const file = state().bankFiles.find(
      (row) => row.id === body.bankTransferFileId,
    );
    if (!file) notFound("Berkas transfer");
    if (file.payrollRunId !== run.id)
      invalid("Berkas transfer milik payroll lain.");
  }
  const next = once(
    body.idempotencyKey,
    {
      runId: run.id,
      action: "mark_paid",
      bankTransferFileId: body.bankTransferFileId,
    },
    () =>
      applyRun(run, {
        action: "mark_paid",
        actorId: currentActor(),
        at: now(),
      }),
  );
  return { data: next };
});

registerMock(requestPayrollRunReversal, ({ params, body }) => {
  requirePermission(RUN);
  const run = requireRun(params.payrollRunId);
  const next = once(
    body.idempotencyKey,
    { runId: run.id, action: "request_reversal", reason: body.reason },
    () =>
      applyRun(run, {
        action: "request_reversal",
        actorId: currentActor(),
        reason: body.reason,
        at: now(),
      }),
  );
  return { data: next };
});

registerMock(decidePayrollRunReversal, ({ params, body }) => {
  requirePermission(CANCEL);
  const run = requireRun(params.payrollRunId);
  const next = onceAction(
    body.idempotencyKey,
    run.id,
    `decide_reversal_${body.action}`,
    () =>
      applyRun(run, {
        action:
          body.action === "approve" ? "approve_reversal" : "reject_reversal",
        actorId: currentActor(),
        at: now(),
      }),
  );
  if (next.status === "reversed") {
    // PAYR-05: a reversal gives the distributed pools back to `approved`.
    const pools = state().pools.map((pool) =>
      pool.payrollRunId === run.id && pool.status === "distributed"
        ? serviceChargePoolSchema.parse({
            ...pool,
            status: transitionServiceChargePool(pool.status, "restore"),
            payrollRunId: null,
          })
        : pool,
    );
    store.set({ ...state(), pools });
  }
  return { data: next };
});

registerMock(listPayrollRunPayslips, ({ params, query, scenario }) => {
  requirePermission(SALARY);
  const run = requireRun(params.payrollRunId);
  const rows = state().payslips.filter((slip) => slip.payrollRunId === run.id);
  return paginateFixture(rows, query, (slip) => slip.id, scenario);
});

// ---- Exports -------------------------------------------------------------

registerMock(createBankTransferFile, () => {
  // Mirrors the API: the legacy per-run bank file is disabled; payouts go
  // through the disbursement batch.
  throw new ApiError(
    409,
    "LEGACY_BANK_EXPORT_DISABLED",
    "Berkas transfer bank lama dinonaktifkan. Gunakan batch pencairan.",
  );
});

registerMock(listBankTransferFiles, ({ params, query, scenario }) => {
  requirePermission(LOCK);
  const run = requireRun(params.payrollRunId);
  const rows = state().bankFiles.filter((file) => file.payrollRunId === run.id);
  return paginateFixture(rows, query, (file) => file.id, scenario);
});

registerMock(createPayrollTaxExport, ({ body }) => {
  // Tax documents carry NPWP/NIK and income per person: payroll.lock, and only
  // for a tax period a locked (twice-approved) run of that legal entity pays —
  // the same approval gate as the bank file. A reversed run does not count.
  requirePermission(LOCK);
  const covered = state().runs.some(
    (run) =>
      run.legalEntityId === body.legalEntityId &&
      (run.status === "locked" || run.status === "paid") &&
      run.payDate.startsWith(body.taxPeriod),
  );
  if (!covered)
    throw new ApiError(
      409,
      "PAYROLL_TAX_PERIOD_NOT_LOCKED",
      "Dokumen pajak dibuat dari payroll run yang sudah dikunci.",
    );
  const file = once(body.idempotencyKey, body, () =>
    payrollTaxExportSchema.parse({
      id: newUuid(),
      tenantId: tenant.id,
      legalEntityId: body.legalEntityId,
      kind: body.kind,
      taxPeriod: body.taxPeriod,
      status: "ready",
      fileUrl: `https://files.legend.example/signed/tax-${body.taxPeriod}-${body.kind}.csv?sig=demo`,
      createdBy: currentActor(),
      createdAt: now(),
      supersededAt: null,
    }),
  );
  if (!state().taxExports.some((row) => row.id === file.id))
    store.set({ ...state(), taxExports: [...state().taxExports, file] });
  return { data: file };
});

// ---- Service-charge pools ----------------------------------------------

registerMock(listServiceChargePools, ({ query, scenario }) => {
  requirePermission(SERVICE_CHARGE_PERMISSIONS, { ssrRead: true });
  const rows = state()
    .pools.filter(
      (pool) =>
        query.outletId === undefined || pool.outletId === query.outletId,
    )
    .filter(
      (pool) => query.status === undefined || pool.status === query.status,
    )
    .sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  return paginateFixture(rows, query, (pool) => pool.id, scenario);
});

registerMock(createServiceChargePool, ({ body }) => {
  requirePermission(RUN);
  const pool = once(body.idempotencyKey, body, () =>
    serviceChargePoolSchema.parse({
      id: newUuid(),
      tenantId: tenant.id,
      outletId: body.outletId,
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      amountIdr: body.amountIdr,
      rule: body.rule,
      status: "draft",
      payrollRunId: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: now(),
    }),
  );
  if (!state().pools.some((row) => row.id === pool.id))
    store.set({ ...state(), pools: [...state().pools, pool] });
  return { data: pool };
});

registerMock(calculateServiceChargePool, ({ params, body }) => {
  requirePermission(RUN);
  const pool = requirePool(params.poolId);
  const next = once(
    body.idempotencyKey,
    { poolId: pool.id, action: "calculate" },
    () => {
      contract(() => transitionServiceChargePool(pool.status, "calculate"));
      let allocations = state().allocations.filter(
        (row) => row.poolId === pool.id,
      );
      if (allocations.length === 0) {
        // Mock attendance stand-in: the API aggregates the period's attendance
        // logs; the demo splits by position points with plausible days.
        const participants: ServiceChargeParticipant[] = hris.employees
          .filter((employee) => employee.status === "active")
          .map((employee, index) => {
            const position = hris.positions.find(
              (row) => row.id === employee.positionId,
            );
            return {
              employeeId: employee.id,
              employmentType: employee.employmentType,
              points: decimal4Schema.parse(
                position?.serviceChargePoints ?? "1.0000",
              ),
              attendanceDays: 20 + (index % 5),
            };
          });
        const shares = contract(() =>
          distributeServiceChargePool(pool.amountIdr, pool.rule, participants),
        );
        allocations = shares.map((share) =>
          serviceChargeAllocationSchema.parse({
            id: newUuid(),
            tenantId: tenant.id,
            poolId: pool.id,
            employeeId: share.employeeId,
            points: share.points,
            attendanceDays: share.attendanceDays,
            weight: share.weight,
            amountIdr: share.amountIdr,
          }),
        );
      }
      const calculated = serviceChargePoolSchema.parse({
        ...pool,
        status: transitionServiceChargePool(pool.status, "calculate"),
      });
      store.set({
        ...state(),
        pools: state().pools.map((row) =>
          row.id === pool.id ? calculated : row,
        ),
        allocations: [
          ...state().allocations.filter((row) => row.poolId !== pool.id),
          ...allocations,
        ],
      });
      return calculated;
    },
  );
  return { data: next };
});

registerMock(approveServiceChargePool, ({ params, body }) => {
  requirePermission(APPROVE);
  const pool = requirePool(params.poolId);
  const next = once(
    body.idempotencyKey,
    { poolId: pool.id, action: "approve" },
    () => {
      const approved = serviceChargePoolSchema.parse({
        ...pool,
        status: contract(() =>
          transitionServiceChargePool(pool.status, "approve"),
        ),
        approvedBy: currentActor(),
        approvedAt: now(),
      });
      store.set({
        ...state(),
        pools: state().pools.map((row) =>
          row.id === pool.id ? approved : row,
        ),
      });
      return approved;
    },
  );
  return { data: next };
});

registerMock(listServiceChargeAllocations, ({ params, query, scenario }) => {
  requirePermission(ALLOCATIONS);
  requirePool(params.poolId);
  const rows = state().allocations.filter(
    (row) => row.poolId === params.poolId,
  );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});
