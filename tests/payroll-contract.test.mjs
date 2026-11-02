// Payroll contract tests (bead legend-zjwa).
// Acceptance IDs in test names: PAYR-01 (simulation without side effects; lock
// only after two-level approval), PAYR-02 (versioned BPJS/PTKP/TER/overtime
// tables; changes never alter a locked run), PAYR-04 (bank file total = net),
// PAYR-05 (reversal needs a distinct approver).
// Statutory numbers below are ILLUSTRATIVE test data, not the regulation.
// Run with `pnpm test` (root node:test suite).

import assert from "node:assert/strict";
import { test } from "node:test";
import * as payroll from "../packages/shared/src/hris/payroll/index.ts";
import { bankTransferRowSchema } from "../packages/shared/src/hris/payroll/server.ts";
import { eventCatalogByName } from "../packages/shared/src/events/index.ts";
import { ulidSchema } from "../packages/shared/src/core/index.ts";
import { ptkpStatusSchema } from "../packages/shared/src/hris/index.ts";
import { cafeLegendHrisFixtures } from "../packages/shared/src/hris/fixtures.ts";

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = uuid(1);
const hrUser = uuid(9001);
const financeUser = uuid(9002);
const at = (day, hour = 2) =>
  `2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const throwsCode = (fn, code) =>
  assert.throws(
    fn,
    (error) => error instanceof payroll.PayrollError && error.code === code,
  );

// ---- Illustrative statutory tables ---------------------------------------

const published = (type, n, effectiveFrom, parameters) =>
  payroll.statutoryTableVersionSchema.parse({
    id: uuid(7000 + n),
    tenantId,
    type,
    version: n,
    effectiveFrom,
    status: "published",
    legalBasis: "ILUSTRASI: data uji",
    publishedAt: "2025-12-01T00:00:00.000Z",
    publishedBy: financeUser,
    createdAt: "2025-12-01T00:00:00.000Z",
    parameters,
  });

const bpjs = (employerRateBp, employeeRateBp, wageCapIdr = null) => ({
  employerRateBp,
  employeeRateBp,
  wageCapIdr,
  wageFloorIdr: null,
  roundingMode: "half_up",
});

const ptkpStatuses = ptkpStatusSchema.options;
const terCategoryOf = (status) =>
  status === "K/3" || status === "K/I/3"
    ? "C"
    : ["TK/0", "TK/1", "K/0", "K/I/0"].includes(status)
      ? "A"
      : "B";

const terV1 = published("pph21_ter", 1, "2026-01-01", {
  categoryByPtkpStatus: Object.fromEntries(
    ptkpStatuses.map((s) => [s, terCategoryOf(s)]),
  ),
  bracketsByCategory: {
    A: [
      { upToIdr: 5_400_000, rateBp: 0 },
      { upToIdr: 5_650_000, rateBp: 25 },
      { upToIdr: 10_000_000, rateBp: 200 },
      { upToIdr: null, rateBp: 500 },
    ],
    B: [
      { upToIdr: 6_200_000, rateBp: 0 },
      { upToIdr: 10_000_000, rateBp: 150 },
      { upToIdr: null, rateBp: 400 },
    ],
    C: [
      { upToIdr: 6_600_000, rateBp: 0 },
      { upToIdr: null, rateBp: 300 },
    ],
  },
  roundingMode: "down",
});

const tables = [
  published("bpjs_kes", 1, "2026-01-01", bpjs(400, 100, 12_000_000)),
  published("jht", 2, "2026-01-01", bpjs(370, 200)),
  published("jkk", 3, "2026-01-01", {
    employerRateBpByRiskClass: {
      very_low: 24,
      low: 54,
      medium: 89,
      high: 127,
      very_high: 174,
    },
    employeeRateBp: 0,
    wageCapIdr: null,
    wageFloorIdr: null,
    roundingMode: "half_up",
  }),
  published("jkm", 4, "2026-01-01", bpjs(30, 0)),
  published("jp", 5, "2026-01-01", bpjs(200, 100, 10_000_000)),
  { ...terV1, id: uuid(7006), version: 1 },
];
const ter = tables[5];

// ---- Run helpers ------------------------------------------------------------

const zeroTotals = {
  employeeCount: 1,
  grossIdr: 10_000_000,
  deductionsIdr: 700_000,
  netIdr: 9_300_000,
  bpjsEmployeeIdr: 300_000,
  bpjsCompanyIdr: 600_000,
  pph21Idr: 200_000,
  pph21WithheldIdr: 200_000,
  loanRepaymentIdr: 150_000,
  otherDeductionsIdr: 50_000,
  serviceChargeIdr: 500_000,
  reimbursementIdr: 0,
  bankTransferIdr: 9_300_000,
  cashIdr: 0,
};

const snapshotFor = (versions) => ({
  statutoryVersions: versions.map(payroll.statutoryVersionRef),
  policy: {
    id: uuid(6001),
    cycle: {
      frequency: "monthly",
      cutoffDay: 25,
      payDay: 28,
      payMonthOffset: 0,
    },
    payDateAdjustment: "previous_working_day",
    jkkRiskClass: "low",
    bpjsProgrammes: ["bpjs_kes", "jht", "jkk", "jkm", "jp"],
  },
  components: [
    {
      id: uuid(6101),
      code: "BASIC",
      category: "base_salary",
      taxable: true,
      taxScheme: "gross",
      bpjsBase: true,
      overtimeBase: true,
      thrBase: true,
    },
  ],
  loanMaxDeductionOfNetPayBp: 5000,
  capturedAt: at(26),
});

const draftRun = payroll.payrollRunSchema.parse({
  id: uuid(6201),
  tenantId,
  legalEntityId: uuid(400),
  payrollPolicyId: uuid(6001),
  runType: "regular",
  thrScheduleId: null,
  periodStart: "2026-10-26",
  periodEnd: "2026-11-25",
  payDate: "2026-11-27",
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
  createdBy: hrUser,
  createdAt: at(1),
  updatedAt: at(1),
});

const apply = (run, command) =>
  payroll.payrollRunSchema.parse(payroll.applyPayrollRunCommand(run, command));
const simulate = (run, day = 26) =>
  apply(run, {
    action: "simulate",
    at: at(day),
    totals: zeroTotals,
    configSnapshot: snapshotFor(tables),
  });
const approvedRun = () => {
  const simulated = simulate(draftRun);
  const hr = apply(simulated, {
    action: "approve_hr",
    actorId: hrUser,
    at: at(26, 3),
  });
  return apply(hr, {
    action: "approve_final",
    actorId: financeUser,
    at: at(26, 4),
  });
};
const lockedRun = () =>
  apply(approvedRun(), { action: "lock", actorId: financeUser, at: at(26, 5) });

// ---- PAYR-01 -----------------------------------------------------------------

test("PAYR-01 simulation is repeatable and lists no side effects", () => {
  const once = simulate(draftRun, 26);
  const twice = simulate(once, 27);
  assert.equal(once.status, "simulated");
  assert.equal(twice.status, "simulated");
  assert.equal(twice.simulationCount, 2);
  assert.deepEqual(twice.totals, once.totals);
  assert.deepEqual(payroll.PAYROLL_RUN_SIDE_EFFECTS.simulate, []);
  assert.deepEqual(payroll.PAYROLL_RUN_SIDE_EFFECTS.return_to_draft, []);
  // Everything with money effect happens at lock, never at simulation.
  assert.ok(payroll.PAYROLL_RUN_SIDE_EFFECTS.lock.includes("payslips_created"));
  assert.ok(
    payroll.PAYROLL_RUN_SIDE_EFFECTS.lock.includes(
      "loan_installments_deducted",
    ),
  );
  // Simulating does not move the run past simulated, and never locks it.
  assert.equal(payroll.isPayrollRunFrozen(twice.status), false);
});

test("PAYR-01 only a run approved at both levels by two people can be locked", () => {
  throwsCode(
    () =>
      payroll.applyPayrollRunCommand(draftRun, {
        action: "lock",
        actorId: financeUser,
        at: at(26),
      }),
    "PAYROLL_RUN_INVALID_TRANSITION",
  );
  const simulated = simulate(draftRun);
  throwsCode(
    () =>
      payroll.applyPayrollRunCommand(simulated, {
        action: "lock",
        actorId: financeUser,
        at: at(26),
      }),
    "PAYROLL_RUN_INVALID_TRANSITION",
  );
  // Final approval cannot precede HR approval.
  throwsCode(
    () =>
      payroll.applyPayrollRunCommand(simulated, {
        action: "approve_final",
        actorId: financeUser,
        at: at(26),
      }),
    "PAYROLL_RUN_INVALID_TRANSITION",
  );
  const hr = apply(simulated, {
    action: "approve_hr",
    actorId: hrUser,
    at: at(26, 3),
  });
  throwsCode(
    () =>
      payroll.applyPayrollRunCommand(hr, {
        action: "lock",
        actorId: financeUser,
        at: at(26),
      }),
    "PAYROLL_RUN_INVALID_TRANSITION",
  );
  // Same person cannot give both approvals.
  throwsCode(
    () =>
      payroll.applyPayrollRunCommand(hr, {
        action: "approve_final",
        actorId: hrUser,
        at: at(26, 4),
      }),
    "PAYROLL_APPROVER_NOT_DISTINCT",
  );
  const locked = lockedRun();
  assert.equal(locked.status, "locked");
  assert.equal(locked.approvedByHr, hrUser);
  assert.equal(locked.approvedByFinance, financeUser);
  // A forged "approved" row without both approvals is refused at lock and by the schema.
  const forged = {
    ...approvedRun(),
    approvedByFinance: null,
    approvedByFinanceAt: null,
  };
  throwsCode(
    () =>
      payroll.applyPayrollRunCommand(forged, {
        action: "lock",
        actorId: financeUser,
        at: at(26),
      }),
    "PAYROLL_RUN_NOT_APPROVED",
  );
  assert.equal(payroll.payrollRunSchema.safeParse(forged).success, false);
  const sameApprover = { ...approvedRun(), approvedByFinance: hrUser };
  assert.equal(payroll.payrollRunSchema.safeParse(sameApprover).success, false);
});

test("PAYR-01 state machine: every transition follows the PRD status list", () => {
  assert.deepEqual(payroll.PAYROLL_RUN_STATUSES, [
    "draft",
    "simulated",
    "hr_approved",
    "approved",
    "locked",
    "paid",
    "reversed",
  ]);
  const allowed = {
    draft: ["simulate"],
    simulated: ["simulate", "return_to_draft", "approve_hr"],
    hr_approved: ["return_to_draft", "approve_final"],
    approved: ["return_to_draft", "lock"],
    locked: [
      "mark_paid",
      "request_reversal",
      "reject_reversal",
      "approve_reversal",
    ],
    paid: [],
    reversed: [],
  };
  for (const status of payroll.PAYROLL_RUN_STATUSES)
    for (const action of payroll.PAYROLL_RUN_ACTIONS)
      assert.equal(
        payroll.canApplyPayrollRunAction(status, action),
        allowed[status].includes(action),
        `${status} + ${action}`,
      );
  // Returning to draft clears approvals and results.
  const back = apply(approvedRun(), { action: "return_to_draft", at: at(27) });
  assert.equal(back.status, "draft");
  assert.equal(back.approvedByHr, null);
  assert.equal(back.totals, null);
  // Paid is terminal and frozen.
  const paid = apply(lockedRun(), {
    action: "mark_paid",
    actorId: financeUser,
    at: at(28),
  });
  assert.equal(paid.status, "paid");
  throwsCode(
    () =>
      payroll.applyPayrollRunCommand(paid, {
        action: "request_reversal",
        actorId: hrUser,
        reason: "Salah input",
        at: at(29),
      }),
    "PAYROLL_RUN_INVALID_TRANSITION",
  );
  // A stored paid row cannot carry an approved reversal: approving one moves
  // the run to reversed, and a paid run is corrected in a later run.
  assert.equal(
    payroll.payrollRunSchema.safeParse({
      ...paid,
      reversal: {
        status: "approved",
        reason: "Salah input",
        requestedBy: hrUser,
        requestedAt: at(29),
        decidedBy: financeUser,
        decidedAt: at(29, 3),
      },
    }).success,
    false,
  );
  throwsCode(
    () => payroll.assertPayrollRunEditable(paid.status),
    "PAYROLL_RUN_FROZEN",
  );
});

test("PAYR-05 reversing a locked run needs an approver other than the requester", () => {
  const requested = apply(lockedRun(), {
    action: "request_reversal",
    actorId: hrUser,
    reason: "Komponen lembur salah",
    at: at(27),
  });
  assert.equal(requested.status, "locked");
  assert.equal(requested.reversal.status, "pending");
  // Cannot mark paid while a reversal is pending.
  throwsCode(
    () =>
      payroll.applyPayrollRunCommand(requested, {
        action: "mark_paid",
        actorId: financeUser,
        at: at(27),
      }),
    "PAYROLL_RUN_INVALID_TRANSITION",
  );
  throwsCode(
    () =>
      payroll.applyPayrollRunCommand(requested, {
        action: "approve_reversal",
        actorId: hrUser,
        at: at(27),
      }),
    "PAYROLL_APPROVER_NOT_DISTINCT",
  );
  const reversed = apply(requested, {
    action: "approve_reversal",
    actorId: financeUser,
    at: at(27, 5),
  });
  assert.equal(reversed.status, "reversed");
  assert.ok(
    payroll.PAYROLL_RUN_SIDE_EFFECTS.approve_reversal.includes(
      "reversing_journal_posted",
    ),
  );
  const rejected = apply(requested, {
    action: "reject_reversal",
    actorId: financeUser,
    at: at(27, 5),
  });
  assert.equal(rejected.status, "locked");
  assert.equal(rejected.reversal.status, "rejected");
  // Without a pending request there is nothing to approve.
  throwsCode(
    () =>
      payroll.applyPayrollRunCommand(lockedRun(), {
        action: "approve_reversal",
        actorId: financeUser,
        at: at(27),
      }),
    "PAYROLL_RUN_INVALID_TRANSITION",
  );
});

// ---- PAYR-02 -----------------------------------------------------------------

test("PAYR-02 the version in force is the latest published one on or before the date", () => {
  const v2 = published("bpjs_kes", 9, "2026-12-01", bpjs(400, 100, 15_000_000));
  const draft = {
    ...v2,
    id: uuid(7999),
    version: 10,
    effectiveFrom: "2026-11-01",
    status: "draft",
    publishedAt: null,
    publishedBy: null,
  };
  const all = [...tables, v2, payroll.statutoryTableVersionSchema.parse(draft)];
  assert.equal(
    payroll.resolveStatutoryTable(all, "bpjs_kes", "2026-11-27").version,
    1,
  );
  assert.equal(
    payroll.resolveStatutoryTable(all, "bpjs_kes", "2026-12-01").version,
    9,
  );
  throwsCode(
    () => payroll.resolveStatutoryTable(all, "bpjs_kes", "2025-12-31"),
    "PAYROLL_STATUTORY_TABLE_NOT_FOUND",
  );
  throwsCode(
    () => payroll.resolveStatutoryTable(all, "ptkp", "2026-11-27"),
    "PAYROLL_STATUTORY_TABLE_NOT_FOUND",
  );
  const twin = { ...v2, id: uuid(7998), version: 11 };
  throwsCode(
    () =>
      payroll.resolveStatutoryTable([...all, twin], "bpjs_kes", "2026-12-02"),
    "PAYROLL_STATUTORY_TABLE_AMBIGUOUS",
  );
});

test("PAYR-02 published versions are immutable and never backdated", () => {
  const draft = payroll.statutoryTableVersionSchema.parse({
    ...tables[0],
    id: uuid(7100),
    version: 2,
    effectiveFrom: "2026-12-01",
    status: "draft",
    publishedAt: null,
    publishedBy: null,
  });
  payroll.assertStatutoryVersionEditable(draft.status);
  const live = payroll.publishStatutoryVersion(draft, {
    today: "2026-11-02",
    actorId: financeUser,
    at: at(2),
  });
  assert.equal(
    payroll.statutoryTableVersionSchema.parse(live).status,
    "published",
  );
  throwsCode(
    () => payroll.assertStatutoryVersionEditable(live.status),
    "PAYROLL_STATUTORY_TABLE_IMMUTABLE",
  );
  throwsCode(
    () =>
      payroll.publishStatutoryVersion(live, {
        today: "2026-11-02",
        actorId: financeUser,
        at: at(2),
      }),
    "PAYROLL_STATUTORY_TABLE_IMMUTABLE",
  );
  throwsCode(
    () => payroll.archiveStatutoryVersion(live),
    "PAYROLL_STATUTORY_TABLE_IMMUTABLE",
  );
  throwsCode(
    () =>
      payroll.publishStatutoryVersion(
        { ...draft, effectiveFrom: "2026-11-01" },
        { today: "2026-11-02", actorId: financeUser, at: at(2) },
      ),
    "PAYROLL_STATUTORY_TABLE_BACKDATED",
  );
  // A published row must carry its publisher.
  assert.equal(
    payroll.statutoryTableVersionSchema.safeParse({
      ...live,
      publishedBy: null,
    }).success,
    false,
  );
});

test("PAYR-02 a newer TER/BPJS/overtime version does not change a locked run", () => {
  const locked = lockedRun();
  const terV2 = payroll.statutoryTableVersionSchema.parse({
    ...ter,
    id: uuid(7200),
    version: 2,
    effectiveFrom: "2026-11-01",
    parameters: {
      ...ter.parameters,
      bracketsByCategory: {
        ...ter.parameters.bracketsByCategory,
        A: [{ upToIdr: null, rateBp: 1000 }],
      },
    },
  });
  const later = [...tables, terV2];
  // An open run on the same pay date would pick up the new version...
  const open = payroll.statutoryVersionsForRun(
    { ...draftRun, configSnapshot: null },
    later,
    ["pph21_ter"],
  );
  assert.equal(open.get("pph21_ter").version, 2);
  // ...the locked run keeps exactly the version it was calculated with.
  const pinned = payroll.statutoryVersionsForRun(locked, later, [
    "pph21_ter",
    "bpjs_kes",
  ]);
  assert.equal(pinned.get("pph21_ter").id, ter.id);
  assert.equal(
    payroll.computeTerWithholding(pinned.get("pph21_ter"), "TK/0", 8_000_000),
    payroll.computeTerWithholding(ter, "TK/0", 8_000_000),
  );
  // A pinned version that disappeared or was altered fails closed.
  throwsCode(
    () =>
      payroll.statutoryVersionsForRun(
        locked,
        later.filter((v) => v.id !== ter.id),
        ["pph21_ter"],
      ),
    "PAYROLL_SNAPSHOT_MISMATCH",
  );
  const altered = later.map((v) =>
    v.id === ter.id ? { ...v, version: 7 } : v,
  );
  throwsCode(
    () => payroll.statutoryVersionsForRun(locked, altered, ["pph21_ter"]),
    "PAYROLL_SNAPSHOT_MISMATCH",
  );
  throwsCode(
    () => payroll.statutoryVersionsForRun(locked, later, ["ptkp"]),
    "PAYROLL_SNAPSHOT_MISMATCH",
  );
  // Inputs of a frozen run cannot change.
  throwsCode(
    () => payroll.assertPayrollRunEditable(locked.status),
    "PAYROLL_RUN_FROZEN",
  );
  // The snapshot pins one version per table type.
  const dup = snapshotFor([...tables, terV2]);
  assert.equal(
    payroll.payrollConfigSnapshotSchema.safeParse(dup).success,
    false,
  );
});

test("PAYR-02 overtime formula is a versioned table, computed in whole rupiah", () => {
  const overtime = published("overtime", 20, "2026-01-01", {
    monthlyHoursDivisor: 173,
    tiersByDayType: {
      workday: [
        { fromHour: 0, toHour: 1, multiplier: "1.5000" },
        { fromHour: 1, toHour: null, multiplier: "2.0000" },
      ],
      rest_day_6_day_week: [
        { fromHour: 0, toHour: 7, multiplier: "2.0000" },
        { fromHour: 7, toHour: 8, multiplier: "3.0000" },
        { fromHour: 8, toHour: null, multiplier: "4.0000" },
      ],
      rest_day_5_day_week: [
        { fromHour: 0, toHour: 8, multiplier: "2.0000" },
        { fromHour: 8, toHour: 9, multiplier: "3.0000" },
        { fromHour: 9, toHour: null, multiplier: "4.0000" },
      ],
    },
    roundingMode: "half_up",
  });
  const p = overtime.parameters;
  // 3 workday hours on 5,190,000: (1.5 + 2 + 2) x 30,000 = 165,000.
  assert.equal(
    payroll.computeOvertimePay(p, "workday", "3.0000", 5_190_000),
    165_000,
  );
  // 1.5 h: (1.5 + 0.5 x 2) x 5,000,000 / 173 = 72,254.33... -> 72,254.
  const pay = payroll.computeOvertimePay(p, "workday", "1.5000", 5_000_000);
  assert.equal(pay, 72_254);
  assert.ok(Number.isSafeInteger(pay));
  // 9 h on a 6-day-week rest day: 7x2 + 1x3 + 1x4 = 21 hourly wages.
  assert.equal(
    payroll.computeOvertimePay(p, "rest_day_6_day_week", "9.0000", 5_190_000),
    630_000,
  );
  assert.equal(
    payroll.computeOvertimePay(p, "workday", "0.0000", 5_190_000),
    0,
  );
  // Gaps or overlapping tiers are rejected.
  const broken = {
    ...p,
    tiersByDayType: {
      ...p.tiersByDayType,
      workday: [
        { fromHour: 0, toHour: 1, multiplier: "1.5000" },
        { fromHour: 2, toHour: null, multiplier: "2.0000" },
      ],
    },
  };
  assert.equal(
    payroll.overtimeParametersSchema.safeParse(broken).success,
    false,
  );
});

// ---- Rounding, TER, BPJS ------------------------------------------------------

test("rounding rule: every rate result is whole rupiah with an explicit mode", () => {
  // 4,567,891 x 1.25% = 57,098.6375
  assert.equal(payroll.rupiahAtRate(4_567_891, 125, "half_up"), 57_099);
  assert.equal(payroll.rupiahAtRate(4_567_891, 125, "down"), 57_098);
  assert.equal(payroll.rupiahAtRate(4_567_891, 125, "ceil"), 57_099);
  // Exactly half: 100 x 0.5% = 0.5
  assert.equal(payroll.rupiahAtRate(100, 50, "half_up"), 1);
  assert.equal(payroll.rupiahAtRate(100, 50, "half_even"), 0);
  for (let gross = 1_000_003; gross < 30_000_000; gross += 1_234_567) {
    const tax = payroll.computeTerWithholding(ter, "K/2", gross);
    assert.ok(Number.isSafeInteger(tax) && tax >= 0, `TER ${gross}`);
  }
});

test("TER lookup by PTKP category and monthly gross bracket (inclusive upper bound)", () => {
  assert.deepEqual(payroll.lookupTerRate(ter, "TK/0", 5_400_000), {
    category: "A",
    bracketIndex: 0,
    rateBp: 0,
  });
  assert.deepEqual(payroll.lookupTerRate(ter, "TK/0", 5_400_001), {
    category: "A",
    bracketIndex: 1,
    rateBp: 25,
  });
  assert.deepEqual(payroll.lookupTerRate(ter, "K/1", 8_000_000), {
    category: "B",
    bracketIndex: 1,
    rateBp: 150,
  });
  assert.deepEqual(payroll.lookupTerRate(ter, "K/3", 50_000_000), {
    category: "C",
    bracketIndex: 1,
    rateBp: 300,
  });
  assert.equal(payroll.lookupTerRate(ter, "K/I/0", 1).category, "A");
  assert.deepEqual(payroll.lookupTerRate(ter, "TK/1", 900_000_000), {
    category: "A",
    bracketIndex: 3,
    rateBp: 500,
  });
  // 8,000,000 at 2% (category A, 3rd bracket) = 160,000.
  assert.equal(payroll.computeTerWithholding(ter, "TK/0", 8_000_000), 160_000);
  // Category mapping must cover every PTKP status; brackets must ascend.
  const partial = { ...ter.parameters, categoryByPtkpStatus: { "TK/0": "A" } };
  assert.equal(payroll.terParametersSchema.safeParse(partial).success, false);
  const unsorted = {
    ...ter.parameters,
    bracketsByCategory: {
      ...ter.parameters.bracketsByCategory,
      C: [
        { upToIdr: 9, rateBp: 0 },
        { upToIdr: 5, rateBp: 1 },
        { upToIdr: null, rateBp: 2 },
      ],
    },
  };
  assert.equal(payroll.terParametersSchema.safeParse(unsorted).success, false);
  const noTop = {
    ...ter.parameters,
    bracketsByCategory: {
      ...ter.parameters.bracketsByCategory,
      C: [{ upToIdr: 9, rateBp: 0 }],
    },
  };
  assert.equal(payroll.terParametersSchema.safeParse(noTop).success, false);
});

test("BPJS cap: the contribution base never exceeds the table's wage cap", () => {
  const kes = payroll.bpjsRateOf(tables[0], "low");
  const over = payroll.computeBpjsContribution(kes, 15_000_000);
  assert.deepEqual(over, {
    type: "bpjs_kes",
    baseIdr: 12_000_000,
    capped: true,
    employerIdr: 480_000,
    employeeIdr: 120_000,
  });
  const under = payroll.computeBpjsContribution(kes, 8_000_000);
  assert.equal(under.capped, false);
  assert.equal(under.employeeIdr, 80_000);
  const jht = payroll.computeBpjsContribution(
    payroll.bpjsRateOf(tables[1], "low"),
    15_000_000,
  );
  assert.equal(jht.capped, false);
  assert.equal(jht.employeeIdr, 300_000);
  // JKK rate follows the employer risk class; no class = fail closed.
  const jkk = payroll.bpjsRateOf(tables[2], "medium");
  assert.equal(
    payroll.computeBpjsContribution(jkk, 10_000_000).employerIdr,
    89_000,
  );
  throwsCode(
    () => payroll.bpjsRateOf(tables[2], null),
    "PAYROLL_STATUTORY_TABLE_NOT_FOUND",
  );
  // Floor lifts a low base; zero wage contributes nothing.
  const floored = payroll.computeBpjsContribution(
    { ...kes, wageFloorIdr: 3_000_000 },
    2_000_000,
  );
  assert.equal(floored.baseIdr, 3_000_000);
  assert.equal(payroll.computeBpjsContribution(kes, 0).employerIdr, 0);
  // Odd base rounds each share once: 7,777,777 x 1% = 77,777.77 -> 77,778.
  assert.equal(
    payroll.computeBpjsContribution(kes, 7_777_777).employeeIdr,
    77_778,
  );
  assert.equal(
    payroll.bpjsParametersSchema.safeParse({
      ...bpjs(1, 1, 100),
      wageFloorIdr: 200,
    }).success,
    false,
  );
});

test("PTKP and Pasal 17 annual recalculation are table driven", () => {
  const annual = {
    brackets: [
      { upToIdr: 60_000_000, rateBp: 500 },
      { upToIdr: 250_000_000, rateBp: 1500 },
      { upToIdr: null, rateBp: 2500 },
    ],
    occupationalCostRateBp: 500,
    occupationalCostAnnualCapIdr: 6_000_000,
    taxableIncomeRoundDownToIdr: 1000,
    noTaxIdSurchargeBp: null,
    roundingMode: "down",
  };
  assert.equal(
    payroll.pph21AnnualParametersSchema.safeParse(annual).success,
    true,
  );
  // 100,000,000 PKP: 60M x 5% + 40M x 15% = 9,000,000.
  assert.equal(
    payroll.computeProgressiveTax(annual.brackets, 100_000_000, "down"),
    9_000_000,
  );
  assert.equal(payroll.computeProgressiveTax(annual.brackets, 0, "down"), 0);
  const pkp = payroll.annualTaxableIncome(annual, {
    annualGrossIdr: 150_000_000,
    annualEmployeeDeductibleIdr: 3_600_000,
    ptkpIdr: 54_000_000,
  });
  // 150M - min(7.5M, 6M) - 3.6M - 54M = 86.4M
  assert.equal(pkp, 86_400_000);
  const ptkp = published("ptkp", 30, "2026-01-01", {
    annualAmountIdrByStatus: Object.fromEntries(
      ptkpStatuses.map((s, i) => [s, 54_000_000 + i * 1000]),
    ),
  });
  assert.equal(payroll.ptkpAnnualAmount(ptkp, "TK/0"), 54_000_000);
});

// ---- Kasbon --------------------------------------------------------------------

test("kasbon installment never exceeds net pay nor the policy share of it", () => {
  const loan = (n, installmentIdr, outstandingIdr, disbursedAt) => ({
    id: uuid(8000 + n),
    status: "disbursed",
    installmentIdr,
    outstandingIdr,
    disbursedAt,
  });
  const loans = [
    loan(2, 800_000, 800_000, at(10)),
    loan(1, 1_000_000, 3_000_000, at(1)),
  ];
  const plan = payroll.planLoanDeductions(loans, 1_500_000, 10_000);
  // Oldest disbursal first: 1,000,000 then the rest of the room (500,000).
  assert.deepEqual(
    plan.map((p) => [p.loanId, p.deductedIdr, p.carriedIdr]),
    [
      [uuid(8001), 1_000_000, 0],
      [uuid(8002), 500_000, 300_000],
    ],
  );
  // Policy cap at 50% of net pay.
  const half = payroll.planLoanDeductions(loans, 1_500_000, 5000);
  assert.equal(
    half.reduce((s, p) => s + p.deductedIdr, 0),
    750_000,
  );
  // Zero or negative net pay deducts nothing.
  for (const net of [0, -10_000])
    assert.ok(
      payroll
        .planLoanDeductions(loans, net, 10_000)
        .every((p) => p.deductedIdr === 0),
    );
  // Property: for many nets the total is within [0, net] and per loan within outstanding.
  for (let net = 0; net <= 4_000_000; net += 137_911) {
    const result = payroll.planLoanDeductions(loans, net, 7000);
    const total = result.reduce((s, p) => s + p.deductedIdr, 0);
    assert.ok(total <= net && total >= 0, `net ${net}`);
    for (const p of result) assert.ok(p.outstandingAfterIdr >= 0);
  }
  // Last installment takes only what is outstanding; non-disbursed loans are skipped.
  const last = payroll.planLoanDeductions(
    [
      loan(3, 1_000_000, 250_000, at(1)),
      { ...loan(4, 1, 1, at(1)), status: "approved" },
    ],
    9_000_000,
    10_000,
  );
  assert.deepEqual(
    last.map((p) => p.deductedIdr),
    [250_000],
  );
  assert.equal(payroll.loanInstallmentFor(1_000_000, 3), 333_334);
});

test("kasbon limits and lifecycle fail closed", () => {
  const policy = payroll.loanPolicySchema.parse({
    maxPrincipalIdr: 5_000_000,
    maxPrincipalOfBaseSalaryBp: 10_000,
    maxInstallments: 6,
    maxDeductionOfNetPayBp: 5000,
    singleOpenLoan: true,
  });
  const ok = {
    principalIdr: 3_000_000,
    installmentCount: 3,
    monthlyBaseSalaryIdr: 4_000_000,
    openLoanCount: 0,
  };
  payroll.assertLoanWithinPolicy(policy, ok);
  for (const bad of [
    { ...ok, principalIdr: 6_000_000, monthlyBaseSalaryIdr: 9_000_000 },
    { ...ok, principalIdr: 4_500_000 },
    { ...ok, installmentCount: 7 },
    { ...ok, openLoanCount: 1 },
  ])
    throwsCode(
      () => payroll.assertLoanWithinPolicy(policy, bad),
      "PAYROLL_LOAN_LIMIT_EXCEEDED",
    );
  throwsCode(
    () =>
      payroll.assertLoanWithinPolicy(
        { ...policy, maxPrincipalIdr: null, maxPrincipalOfBaseSalaryBp: null },
        ok,
      ),
    "PAYROLL_LOAN_LIMIT_EXCEEDED",
  );
  assert.equal(
    payroll.transitionEmployeeLoan("pending", "approve"),
    "approved",
  );
  assert.equal(
    payroll.transitionEmployeeLoan("approved", "disburse"),
    "disbursed",
  );
  throwsCode(
    () => payroll.transitionEmployeeLoan("pending", "disburse"),
    "PAYROLL_INVALID_TRANSITION",
  );
  throwsCode(
    () => payroll.transitionEmployeeLoan("disbursed", "cancel"),
    "PAYROLL_INVALID_TRANSITION",
  );
});

// ---- Service charge, THR, reimbursement -----------------------------------------

test("service-charge pool split sums exactly to the pool (ORD-06)", () => {
  const rule = {
    method: "points_x_attendance",
    minAttendanceDays: 10,
    eligibleEmploymentTypes: ["pkwtt", "pkwt", "daily"],
  };
  const people = [
    {
      employeeId: uuid(1001),
      employmentType: "pkwtt",
      points: "2.5000",
      attendanceDays: 22,
    },
    {
      employeeId: uuid(1002),
      employmentType: "pkwt",
      points: "1.0000",
      attendanceDays: 25,
    },
    {
      employeeId: uuid(1003),
      employmentType: "daily",
      points: "1.2500",
      attendanceDays: 13,
    },
    {
      employeeId: uuid(1004),
      employmentType: "pkwtt",
      points: "1.0000",
      attendanceDays: 9,
    },
    {
      employeeId: uuid(1005),
      employmentType: "intern",
      points: "1.0000",
      attendanceDays: 26,
    },
  ];
  const shares = payroll.distributeServiceChargePool(9_876_543, rule, people);
  assert.equal(
    shares.reduce((s, x) => s + x.amountIdr, 0),
    9_876_543,
  );
  assert.equal(shares[3].amountIdr, 0, "below minimum attendance");
  assert.equal(shares[4].amountIdr, 0, "ineligible employment type");
  assert.ok(shares.every((x) => Number.isSafeInteger(x.amountIdr)));
  const equal = payroll.distributeServiceChargePool(
    100,
    { ...rule, method: "equal" },
    people.slice(0, 3),
  );
  assert.deepEqual(
    equal.map((x) => x.amountIdr),
    [34, 33, 33],
  );
  throwsCode(
    () =>
      payroll.distributeServiceChargePool(
        100,
        { ...rule, minAttendanceDays: 31 },
        people,
      ),
    "PAYROLL_INVALID_TRANSITION",
  );
  assert.equal(
    payroll.transitionServiceChargePool("calculated", "calculate"),
    "calculated",
  );
  throwsCode(
    () => payroll.transitionServiceChargePool("distributed", "calculate"),
    "PAYROLL_INVALID_TRANSITION",
  );
});

test("THR follows tenure: none, pro rata, full", () => {
  const params = {
    minTenureMonths: 1,
    fullTenureMonths: 12,
    roundingMode: "half_up",
  };
  const thr = (joinDate) =>
    payroll.computeThr(params, {
      joinDate,
      asOfDate: "2027-03-10",
      thrWageIdr: 6_000_000,
    });
  assert.deepEqual(thr("2027-02-20"), { tenureMonths: 0, amountIdr: 0 });
  assert.deepEqual(thr("2026-12-10"), {
    tenureMonths: 3,
    amountIdr: 1_500_000,
  });
  assert.deepEqual(thr("2026-07-11"), {
    tenureMonths: 7,
    amountIdr: 3_500_000,
  });
  assert.deepEqual(thr("2020-01-01"), {
    tenureMonths: 86,
    amountIdr: 6_000_000,
  });
  assert.equal(payroll.completedMonthsBetween("2026-01-31", "2026-02-28"), 0);
  assert.equal(payroll.completedMonthsBetween("2026-01-31", "2026-03-31"), 2);
});

test("reimbursement limit per position with default fallback", () => {
  const category = {
    limits: [
      {
        positionId: null,
        perClaimLimitIdr: 500_000,
        perMonthLimitIdr: 1_000_000,
      },
      {
        positionId: uuid(308),
        perClaimLimitIdr: 2_000_000,
        perMonthLimitIdr: null,
      },
    ],
  };
  const staff = payroll.reimbursementLimitFor(category, uuid(301));
  payroll.assertReimbursementWithinLimit(staff, 500_000, 500_000);
  throwsCode(
    () => payroll.assertReimbursementWithinLimit(staff, 500_001, 0),
    "PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED",
  );
  throwsCode(
    () => payroll.assertReimbursementWithinLimit(staff, 400_000, 700_000),
    "PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED",
  );
  payroll.assertReimbursementWithinLimit(
    payroll.reimbursementLimitFor(category, uuid(308)),
    1_500_000,
    9_000_000,
  );
  throwsCode(
    () =>
      payroll.reimbursementLimitFor(
        { limits: [category.limits[1]] },
        uuid(301),
      ),
    "PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED",
  );
  assert.equal(payroll.transitionReimbursement("approved", "pay"), "paid");
  throwsCode(
    () => payroll.transitionReimbursement("submitted", "pay"),
    "PAYROLL_INVALID_TRANSITION",
  );
});

// ---- Payslip arithmetic, totals, bank file (PAYR-04) ------------------------------

const line = (category, kind, amountIdr, extra = {}) => ({
  componentCode: category.toUpperCase().slice(0, 30),
  name: category,
  category,
  kind,
  amountIdr,
  taxable: kind === "earning" && category !== "reimbursement",
  quantity: null,
  sourceId: null,
  ...extra,
});
const slip = (employeeNo, base, paymentMethod = "bank_transfer") => {
  const bpjsLines = [
    {
      type: "jht",
      baseIdr: base,
      capped: false,
      employerIdr: (base * 37) / 1000,
      employeeIdr: base / 50,
    },
  ];
  const pph21 = 100_000;
  const lines = [
    line("base_salary", "earning", base),
    line("overtime", "earning", 50_000),
    line("bpjs_employee", "deduction", base / 50),
    line("pph21", "deduction", pph21),
  ];
  const gross = base + 50_000;
  const deductions = base / 50 + pph21;
  return {
    employeeId: uuid(Number(employeeNo.slice(-4))),
    employeeNo,
    employeeName: `Karyawan ${employeeNo}`,
    positionName: "Barista",
    outletId: uuid(2),
    periodStart: "2026-10-26",
    periodEnd: "2026-11-25",
    payDate: "2026-11-27",
    grossIdr: gross,
    deductionsIdr: deductions,
    netIdr: gross - deductions,
    pph21Idr: pph21,
    bpjsEmployeeIdr: base / 50,
    bpjsCompanyIdr: (base * 37) / 1000,
    serviceChargeIdr: 0,
    overtimeIdr: 50_000,
    lines,
    bpjs: bpjsLines,
    tax: {
      ptkpStatus: "TK/0",
      method: "ter",
      terCategory: "A",
      terRateBp: 125,
      taxableGrossIdr: gross,
      pph21Idr: pph21,
      pph21WithheldIdr: pph21,
      noTaxIdSurchargeApplied: false,
    },
    paymentMethod,
  };
};

test("payslip arithmetic: gross, deductions and net must add up", () => {
  const good = slip("EMP-1004", 5_000_000);
  assert.equal(payroll.payslipCalculationSchema.safeParse(good).success, true);
  assert.deepEqual(payroll.payslipTotalsIssues(good), []);
  const badNet = { ...good, netIdr: good.netIdr + 1 };
  assert.equal(
    payroll.payslipCalculationSchema.safeParse(badNet).success,
    false,
  );
  const badGross = {
    ...good,
    grossIdr: good.grossIdr - 1,
    netIdr: good.netIdr - 1,
  };
  assert.equal(
    payroll.payslipCalculationSchema.safeParse(badGross).success,
    false,
  );
  const fractional = {
    ...good,
    lines: good.lines.map((l, i) =>
      i === 0 ? { ...l, amountIdr: 5_000_000.5 } : l,
    ),
  };
  assert.equal(
    payroll.payslipCalculationSchema.safeParse(fractional).success,
    false,
  );
  const taxableDeduction = {
    ...good,
    lines: good.lines.map((l) =>
      l.kind === "deduction" ? { ...l, taxable: true } : l,
    ),
  };
  assert.equal(
    payroll.payslipCalculationSchema.safeParse(taxableDeduction).success,
    false,
  );
  // An earning cannot masquerade as the PPh 21 withholding: gross 5,150,000 =
  // base + overtime + the "tax" earning, so the arithmetic alone adds up.
  const disguisedWithholding = {
    ...good,
    grossIdr: 5_150_000,
    deductionsIdr: 100_000,
    netIdr: 5_050_000,
    lines: good.lines.map((l) =>
      l.category === "pph21" ? { ...l, kind: "earning" } : l,
    ),
  };
  assert.equal(
    payroll.payslipCalculationSchema.safeParse(disguisedWithholding).success,
    false,
  );
  assert.ok(
    payroll
      .payslipTotalsIssues(disguisedWithholding)
      .some((issue) => issue.includes("kind")),
  );
  // A reimbursement repays an expense; it cannot be deducted from salary.
  const deductedReimbursement = {
    ...good,
    lines: [...good.lines, line("reimbursement", "deduction", 10_000)],
    deductionsIdr: good.deductionsIdr + 10_000,
    netIdr: good.netIdr - 10_000,
  };
  assert.equal(
    payroll.payslipCalculationSchema.safeParse(deductedReimbursement).success,
    false,
  );
});

test("PAYR-04 bank transfer file total equals bank-paid net pay", () => {
  const slips = [
    slip("EMP-1004", 5_000_000),
    slip("EMP-1005", 6_000_000),
    slip("EMP-1009", 4_000_000, "cash"),
  ];
  const totals = payroll.sumPayrollRunTotals(slips);
  assert.equal(totals.netIdr, totals.bankTransferIdr + totals.cashIdr);
  assert.equal(totals.cashIdr, slips[2].netIdr);
  const rows = slips
    .slice(0, 2)
    .map((s) => ({ employeeId: s.employeeId, amountIdr: s.netIdr }));
  payroll.assertBankFileMatchesRun(rows, slips, totals);
  throwsCode(
    () => payroll.assertBankFileMatchesRun(rows.slice(0, 1), slips, totals),
    "PAYROLL_BANK_FILE_MISMATCH",
  );
  throwsCode(
    () =>
      payroll.assertBankFileMatchesRun(
        [rows[0], { ...rows[1], amountIdr: rows[1].amountIdr + 1 }],
        slips,
        totals,
      ),
    "PAYROLL_BANK_FILE_MISMATCH",
  );
  // Totals that do not balance are rejected (journal would not balance).
  assert.equal(
    payroll.payrollRunTotalsSchema.safeParse({
      ...totals,
      cashIdr: totals.cashIdr + 1,
    }).success,
    false,
  );
  assert.equal(
    payroll.payrollRunTotalsSchema.safeParse({
      ...totals,
      deductionsIdr: totals.deductionsIdr + 1,
      netIdr: totals.netIdr - 1,
      bankTransferIdr: totals.bankTransferIdr - 1,
    }).success,
    false,
  );
  // The raw bank row is digits-only and positive.
  assert.equal(
    bankTransferRowSchema.safeParse({
      employeeId: uuid(1004),
      employeeNo: "EMP-1004",
      accountHolderName: "Dewi",
      bankCode: "014",
      accountNumber: "12-34",
      amountIdr: 1,
      reference: "GAJI 2026-11",
    }).success,
    false,
  );
});

// ---- Policies, events, endpoints, fixtures -----------------------------------------

test("payroll cycles: monthly cut-off, biweekly anchor, daily; pay date never late", () => {
  const monthly = {
    frequency: "monthly",
    cutoffDay: 25,
    payDay: 28,
    payMonthOffset: 0,
  };
  assert.deepEqual(payroll.payrollPeriodFor(monthly, "2026-11-10"), {
    periodStart: "2026-10-26",
    periodEnd: "2026-11-25",
    payDate: "2026-11-28",
  });
  assert.deepEqual(payroll.payrollPeriodFor(monthly, "2026-12-26"), {
    periodStart: "2026-12-26",
    periodEnd: "2027-01-25",
    payDate: "2027-01-28",
  });
  const calendar = {
    frequency: "monthly",
    cutoffDay: null,
    payDay: null,
    payMonthOffset: 1,
  };
  assert.deepEqual(payroll.payrollPeriodFor(calendar, "2026-12-15"), {
    periodStart: "2026-12-01",
    periodEnd: "2026-12-31",
    payDate: "2027-01-31",
  });
  assert.deepEqual(
    payroll.payrollPeriodFor(
      {
        frequency: "monthly",
        cutoffDay: null,
        payDay: null,
        payMonthOffset: 0,
      },
      "2028-02-10",
    ).payDate,
    "2028-02-29",
  );
  const biweekly = {
    frequency: "biweekly",
    anchorDate: "2026-11-02",
    payDaysAfterPeriodEnd: 2,
  };
  assert.deepEqual(payroll.payrollPeriodFor(biweekly, "2026-11-20"), {
    periodStart: "2026-11-16",
    periodEnd: "2026-11-29",
    payDate: "2026-12-01",
  });
  assert.deepEqual(
    payroll.payrollPeriodFor(biweekly, "2026-11-01").periodStart,
    "2026-10-19",
  );
  assert.deepEqual(
    payroll.payrollPeriodFor(
      { frequency: "daily", payDaysAfterPeriodEnd: 0 },
      "2026-11-03",
    ).payDate,
    "2026-11-03",
  );
  // 2026-11-28 is a Saturday: previous working day is Friday 27th.
  const weekend = (d) =>
    [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay());
  assert.equal(
    payroll.adjustPayDate("2026-11-28", "previous_working_day", weekend),
    "2026-11-27",
  );
  assert.equal(
    payroll.adjustPayDate("2026-11-28", "next_working_day", weekend),
    "2026-11-30",
  );
  assert.equal(
    payroll.adjustPayDate("2026-11-28", "none", weekend),
    "2026-11-28",
  );
  assert.equal(
    payroll.payrollCycleSchema.safeParse({ ...monthly, cutoffDay: 31 }).success,
    false,
  );
});

test("payroll events are catalogued (WS-10) and carry no per-employee salary", () => {
  for (const event of payroll.payrollDomainEvents) {
    const entry = eventCatalogByName.get(event.name);
    assert.ok(entry, event.name);
    assert.equal(entry.workstream, "WS-10");
  }
  assert.ok(payroll.payrollEventNames.includes("payroll.locked"));
  assert.ok(payroll.payrollEventNames.includes("payroll.reversed"));
  const payslipKeys = Object.keys(
    payroll.payslipCreated.envelopeSchema.shape.payload.shape,
  );
  assert.deepEqual(payslipKeys.sort(), [
    "employeeId",
    "payDate",
    "payrollRunId",
    "payslipId",
  ]);
});

test("payroll endpoints: unique ids, strict bodies, tenant id rejected (TEN-02)", () => {
  const ids = payroll.payrollEndpoints.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const endpoint of payroll.payrollEndpoints) {
    assert.ok(endpoint.path.startsWith("/api/hris/"), endpoint.id);
    if (endpoint.body && endpoint.method !== "GET") {
      const shape = endpoint.body.shape ?? endpoint.body.def?.in?.shape;
      if (shape) assert.equal("tenantId" in shape, false, endpoint.id);
    }
  }
  const lock = payroll.lockPayrollRun;
  assert.equal(
    lock.body.safeParse({ idempotencyKey: "lock-2026-11-0001" }).success,
    true,
  );
  assert.equal(
    lock.body.safeParse({
      idempotencyKey: "lock-2026-11-0001",
      tenantId: uuid(1),
    }).success,
    false,
  );
  assert.equal(lock.body.safeParse({}).success, false);
  // Payslip PIN travels in a POST body and is exactly 6 digits.
  assert.equal(payroll.viewMyPayslip.method, "POST");
  assert.equal(
    payroll.viewMyPayslip.body.safeParse({ pin: "12345" }).success,
    false,
  );
  assert.equal(
    payroll.viewMyPayslip.body.safeParse({ pin: "123456" }).success,
    true,
  );
  // The PWA list exposes no amounts before the PIN.
  const summaryKeys = Object.keys(payroll.myPayslipSummarySchema.shape);
  assert.ok(summaryKeys.every((key) => !key.endsWith("Idr")));
  // HR-03: the decrypted account number's schema is not in the client barrel.
  assert.equal("bankTransferRowSchema" in payroll, false);
});

test("payroll fixtures parse and satisfy PAYR-04 invariants", () => {
  const f = payroll.cafeLegendPayrollFixtures;
  assert.ok(f, "fixtures exported");
  const { tenant, outlets, now, legalEntityId, userIds, ...domain } = f;
  assert.ok(tenant && outlets && now && legalEntityId && userIds);
  payroll.payrollFixtureSchema.parse(domain);
  const types = new Set(
    f.statutoryTables
      .filter((t) => t.status === "published")
      .map((t) => t.type),
  );
  assert.equal(types.size, payroll.STATUTORY_TABLE_TYPES.length);
  for (const t of f.statutoryTables)
    assert.ok(
      t.legalBasis.startsWith("ILUSTRASI"),
      "illustrative values are labelled",
    );
  const october = f.payrollRuns.october;
  assert.equal(october.status, "paid");
  assert.notEqual(october.approvedByHr, october.approvedByFinance);
  assert.deepEqual(payroll.sumPayrollRunTotals(f.payslips), october.totals);
  const bankFile = f.bankTransferFiles[0];
  assert.equal(bankFile.totalIdr, october.totals.bankTransferIdr);
  const pool = f.serviceChargePools.find((p) => p.status === "distributed");
  const allocated = f.serviceChargeAllocations.filter(
    (a) => a.poolId === pool.id,
  );
  assert.equal(
    allocated.reduce((s, a) => s + a.amountIdr, 0),
    pool.amountIdr,
  );
  assert.equal(f.payrollRuns.november.status, "simulated");
  assert.equal(f.payrollRuns.december.status, "draft");
  for (const run of Object.values(f.payrollRuns))
    payroll.payrollRunSchema.parse(run);
  payroll.payrollLocked.envelopeSchema.parse(f.events.payrollLocked);
});

test("fixture ids that PRD marks ULID are canonical 26-char ULIDs", () => {
  // attendance_logs.id is ULID (PK) in the HRIS contract; the payroll event
  // envelope id is a ULID too. A 25-char fixture id would be rejected (the
  // hris helper pads to 3 digits, so every call site is 26 chars).
  for (const log of cafeLegendHrisFixtures.attendanceLogs)
    assert.equal(ulidSchema.safeParse(log.id).success, true, log.id);
  for (const event of Object.values(payroll.cafeLegendPayrollFixtures.events))
    assert.equal(ulidSchema.safeParse(event.id).success, true, event.id);
});
