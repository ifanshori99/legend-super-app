// Cafe Legend payroll fixtures (FE mock mode + contract tests).
// Statutory tables, pay components, policies, kasbon, reimbursement, service
// charge, three payroll runs (October 2026 paid, November 2026 simulated,
// December 2026 draft), the October payslips and bank file, and event
// envelopes. Employees come from the HRIS fixture; people, dates and amounts
// are synthetic, not the owner's real payroll.
//
// Every row is parsed through its schema at module load, and every amount a
// helper of the contract can produce (BPJS, TER, overtime, service charge
// split, loan deduction, run totals) is produced by that helper, never typed
// by hand. Payroll rows use ids 5000+ so they never collide with HRIS ids.

import {
  cafeLegendFixtures,
  idr,
  decimal4,
  sumIdr,
  z,
} from "../../core/index.ts";
import type { Decimal4, Idr } from "../../core/index.ts";
import { userIdSchema } from "../../core/index.ts";
import { cafeLegendHrisFixtures } from "../fixtures.ts";
import { ptkpStatusSchema } from "../organization.ts";
import type { Employee, PtkpStatus } from "../organization.ts";
import {
  employeePayComponentSchema,
  payComponentKindOf,
  payComponentSchema,
} from "./components.ts";
import { payrollLocked, payrollPaid, payslipCreated } from "./events.ts";
import {
  employeeLoanSchema,
  loanInstallmentFor,
  loanPolicySchema,
  planLoanDeductions,
} from "./loans.ts";
import { computePayslipTax, payslipWithholdingCap } from "./payslip-tax.ts";
import { planPph21ReceivableCollection } from "./pph21-receivable.ts";
import {
  adjustPayDate,
  payrollPeriodFor,
  payrollPolicySchema,
  thrScheduleSchema,
} from "./policies.ts";
import {
  reimbursementCategorySchema,
  reimbursementSchema,
} from "./reimbursements.ts";
import {
  payrollConfigSnapshotSchema,
  payrollRunSchema,
  statutoryVersionRef,
} from "./run.ts";
import {
  assertBankFileMatchesRun,
  bankTransferFileSchema,
  payrollRunEmployeeResultSchema,
  payslipBpjsLineSchema,
  payslipCalculationSchema,
  payslipLineSchema,
  payslipSchema,
  sumPayrollRunTotals,
} from "./payslips.ts";
import type { PayslipBpjsLine, PayslipLine } from "./payslips.ts";
import { DEFAULT_PPH21_POLICY } from "./pph21-policy.ts";
import type { Pph21Tables } from "./pph21.ts";
import {
  distributeServiceChargePool,
  serviceChargeAllocationSchema,
  serviceChargePoolSchema,
} from "./service-charge.ts";
import type { ServiceChargeParticipant } from "./service-charge.ts";
import {
  BPJS_TABLE_TYPES,
  STATUTORY_TABLE_TYPES,
  bpjsRateOf,
  computeBpjsContribution,
  computeOvertimePay,
  resolveStatutoryTable,
  statutoryTableVersionSchema,
} from "./statutory.ts";
import type {
  StatutoryTableType,
  StatutoryTableVersion,
  StatutoryTableVersionOf,
} from "./statutory.ts";

const { tenant, outlets } = cafeLegendFixtures;
const outletA = outlets[0].id;
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ulid = (n: number) =>
  `01JBQ7Z8K3M4N5P6Q7R8S9T${String(n).padStart(3, "0")}`;
const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === undefined || value === null)
    throw new TypeError(`Payroll fixture: ${what}`);
  return value;
};
const now = "2026-11-01T02:00:00.000Z";
const positionOf = (employee: Employee) =>
  must(
    positionById.get(must(employee.positionId, "employee position")),
    `position of ${employee.employeeNo}`,
  );

const hrApprover = userIdSchema.parse(cafeLegendHrisFixtures.userIds.hrAdmin);
// Michael Tanoto, Finance Staff in the HRIS fixture: the second approver.
const financeApprover = userIdSchema.parse(id(1025));
const outletManagerUser = userIdSchema.parse(
  cafeLegendHrisFixtures.userIds.outletManager,
);

// Run creator: a third person, so creator, HR approver and final approver differ (PAYR-01).
const runCreator = userIdSchema.parse(
  cafeLegendHrisFixtures.userIds.outletManager,
);

const hrisEmployees = cafeLegendHrisFixtures.employees;
const positionById = new Map(
  cafeLegendHrisFixtures.positions.map((position) => [position.id, position]),
);
const legalEntityId = must(hrisEmployees[0], "no employees").legalEntityId;

// ---- Statutory tables -------------------------------------------------------
//
// ILLUSTRATIVE VALUES — not the regulation in force; Finance enters real numbers
//
// Every number below (BPJS rates and caps, PTKP amounts, TER brackets, Pasal 17
// brackets, overtime tiers, THR tenure) is a placeholder so the engine, the
// simulation and the screens have something to compute with. The production
// tables are entered by Finance from the regulation in force and published
// through the versioned-table panel (PAYR-02). Each legalBasis says so.

const ILLUSTRATIVE = "ILUSTRASI: ";
const statutoryPublishedAt = "2025-12-20T03:00:00.000Z";
const statutoryCreatedAt = "2025-12-15T03:00:00.000Z";

const publishedMeta = (n: number, legalBasis: string) => ({
  id: id(n),
  tenantId: tenant.id,
  version: 1,
  effectiveFrom: "2026-01-01",
  status: "published" as const,
  legalBasis: `${ILLUSTRATIVE}${legalBasis}`,
  publishedAt: statutoryPublishedAt,
  publishedBy: financeApprover,
  createdAt: statutoryCreatedAt,
});

function parseVersion<T extends StatutoryTableType>(
  type: T,
  row: unknown,
): StatutoryTableVersionOf<T> {
  const version = statutoryTableVersionSchema.parse(row);
  if (version.type !== type)
    throw new TypeError(`Expected a ${type} table, got ${version.type}`);
  return version as StatutoryTableVersionOf<T>;
}

const bpjsParameters = (
  employerRateBp: number,
  employeeRateBp: number,
  wageCapIdr: number | null,
) => ({
  employerRateBp,
  employeeRateBp,
  wageCapIdr,
  wageFloorIdr: null,
  roundingMode: "half_up" as const,
});

const bpjsKes = parseVersion("bpjs_kes", {
  ...publishedMeta(5001, "Tarif BPJS Kesehatan (contoh angka)"),
  type: "bpjs_kes",
  parameters: bpjsParameters(400, 100, 12_000_000),
});
const bpjsJht = parseVersion("jht", {
  ...publishedMeta(5002, "Tarif JHT BPJS Ketenagakerjaan (contoh angka)"),
  type: "jht",
  parameters: bpjsParameters(370, 200, null),
});
const bpjsJkk = parseVersion("jkk", {
  ...publishedMeta(5003, "Tarif JKK per kelas risiko (contoh angka)"),
  type: "jkk",
  parameters: {
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
  },
});
const bpjsJkm = parseVersion("jkm", {
  ...publishedMeta(5004, "Tarif JKM BPJS Ketenagakerjaan (contoh angka)"),
  type: "jkm",
  parameters: bpjsParameters(30, 0, null),
});
const bpjsJp = parseVersion("jp", {
  ...publishedMeta(5005, "Tarif JP dan batas upah (contoh angka)"),
  type: "jp",
  parameters: bpjsParameters(200, 100, 10_547_400),
});

/** TK/0 54,000,000; +4,500,000 per dependent; K +4,500,000; K/I +54,000,000. */
const ptkpAnnualAmountFor = (status: PtkpStatus): number => {
  const parts = status.split("/");
  const kind = parts[0];
  const combined = parts[1] === "I";
  const dependents = Number(parts[parts.length - 1]);
  return (
    54_000_000 +
    (kind === "K" ? 4_500_000 : 0) +
    (combined ? 54_000_000 : 0) +
    4_500_000 * dependents
  );
};
const ptkp = parseVersion("ptkp", {
  ...publishedMeta(5006, "Penghasilan tidak kena pajak per status (contoh)"),
  type: "ptkp",
  parameters: {
    annualAmountIdrByStatus: Object.fromEntries(
      ptkpStatusSchema.options.map((status) => [
        status,
        ptkpAnnualAmountFor(status),
      ]),
    ),
  },
});

const terCategoryOf = (status: PtkpStatus): "A" | "B" | "C" => {
  const base = status.replace("K/I/", "K/");
  if (base === "TK/0" || base === "TK/1" || base === "K/0") return "A";
  if (base === "K/3") return "C";
  return "B";
};
const bracket = (upToIdr: number | null, rateBp: number) => ({
  upToIdr,
  rateBp,
});
const ter = parseVersion("pph21_ter", {
  ...publishedMeta(
    5007,
    "Tarif efektif rata-rata bulanan PP 58/2023 Lampiran A, B, C",
  ),
  type: "pph21_ter",
  parameters: {
    categoryByPtkpStatus: Object.fromEntries(
      ptkpStatusSchema.options.map((status) => [status, terCategoryOf(status)]),
    ),
    bracketsByCategory: {
      A: [
        bracket(5_400_000, 0),
        bracket(5_650_000, 25),
        bracket(5_950_000, 50),
        bracket(6_300_000, 75),
        bracket(6_750_000, 100),
        bracket(7_500_000, 125),
        bracket(8_550_000, 150),
        bracket(9_650_000, 175),
        bracket(10_050_000, 200),
        bracket(10_350_000, 225),
        bracket(10_700_000, 250),
        bracket(11_050_000, 300),
        bracket(11_600_000, 350),
        bracket(12_500_000, 400),
        bracket(13_750_000, 500),
        bracket(15_100_000, 600),
        bracket(16_950_000, 700),
        bracket(19_750_000, 800),
        bracket(24_150_000, 900),
        bracket(26_450_000, 1000),
        bracket(28_000_000, 1100),
        bracket(30_050_000, 1200),
        bracket(32_400_000, 1300),
        bracket(35_400_000, 1400),
        bracket(39_100_000, 1500),
        bracket(43_850_000, 1600),
        bracket(47_800_000, 1700),
        bracket(51_400_000, 1800),
        bracket(56_300_000, 1900),
        bracket(62_200_000, 2000),
        bracket(68_600_000, 2100),
        bracket(77_500_000, 2200),
        bracket(89_000_000, 2300),
        bracket(103_000_000, 2400),
        bracket(125_000_000, 2500),
        bracket(157_000_000, 2600),
        bracket(206_000_000, 2700),
        bracket(337_000_000, 2800),
        bracket(454_000_000, 2900),
        bracket(550_000_000, 3000),
        bracket(695_000_000, 3100),
        bracket(910_000_000, 3200),
        bracket(1_400_000_000, 3300),
        bracket(null, 3400),
      ],
      B: [
        bracket(6_200_000, 0),
        bracket(6_500_000, 25),
        bracket(6_850_000, 50),
        bracket(7_300_000, 75),
        bracket(9_200_000, 100),
        bracket(10_750_000, 150),
        bracket(11_250_000, 200),
        bracket(11_600_000, 250),
        bracket(12_600_000, 300),
        bracket(13_600_000, 400),
        bracket(14_950_000, 500),
        bracket(16_400_000, 600),
        bracket(18_450_000, 700),
        bracket(21_850_000, 800),
        bracket(26_000_000, 900),
        bracket(27_700_000, 1000),
        bracket(29_350_000, 1100),
        bracket(31_450_000, 1200),
        bracket(33_950_000, 1300),
        bracket(37_100_000, 1400),
        bracket(41_100_000, 1500),
        bracket(45_800_000, 1600),
        bracket(49_500_000, 1700),
        bracket(53_800_000, 1800),
        bracket(58_500_000, 1900),
        bracket(64_000_000, 2000),
        bracket(71_000_000, 2100),
        bracket(80_000_000, 2200),
        bracket(93_000_000, 2300),
        bracket(109_000_000, 2400),
        bracket(129_000_000, 2500),
        bracket(163_000_000, 2600),
        bracket(211_000_000, 2700),
        bracket(374_000_000, 2800),
        bracket(459_000_000, 2900),
        bracket(555_000_000, 3000),
        bracket(704_000_000, 3100),
        bracket(957_000_000, 3200),
        bracket(1_405_000_000, 3300),
        bracket(null, 3400),
      ],
      C: [
        bracket(6_600_000, 0),
        bracket(6_950_000, 25),
        bracket(7_350_000, 50),
        bracket(7_800_000, 75),
        bracket(8_850_000, 100),
        bracket(9_800_000, 125),
        bracket(10_950_000, 150),
        bracket(11_200_000, 175),
        bracket(12_050_000, 200),
        bracket(12_950_000, 300),
        bracket(14_150_000, 400),
        bracket(15_550_000, 500),
        bracket(17_050_000, 600),
        bracket(19_500_000, 700),
        bracket(22_700_000, 800),
        bracket(26_600_000, 900),
        bracket(28_100_000, 1000),
        bracket(30_100_000, 1100),
        bracket(32_600_000, 1200),
        bracket(35_400_000, 1300),
        bracket(38_900_000, 1400),
        bracket(43_000_000, 1500),
        bracket(47_400_000, 1600),
        bracket(51_200_000, 1700),
        bracket(55_800_000, 1800),
        bracket(60_400_000, 1900),
        bracket(66_700_000, 2000),
        bracket(74_500_000, 2100),
        bracket(83_200_000, 2200),
        bracket(95_600_000, 2300),
        bracket(110_000_000, 2400),
        bracket(134_000_000, 2500),
        bracket(169_000_000, 2600),
        bracket(221_000_000, 2700),
        bracket(390_000_000, 2800),
        bracket(463_000_000, 2900),
        bracket(561_000_000, 3000),
        bracket(709_000_000, 3100),
        bracket(965_000_000, 3200),
        bracket(1_419_000_000, 3300),
        bracket(null, 3400),
      ],
    },
    roundingMode: "down",
  },
});
const pph21Annual = parseVersion("pph21_annual", {
  ...publishedMeta(5008, "Lapisan tarif Pasal 17 dan biaya jabatan (contoh)"),
  type: "pph21_annual",
  parameters: {
    brackets: [
      bracket(60_000_000, 500),
      bracket(250_000_000, 1500),
      bracket(500_000_000, 2500),
      bracket(5_000_000_000, 3000),
      bracket(null, 3500),
    ],
    occupationalCostRateBp: 500,
    occupationalCostAnnualCapIdr: 6_000_000,
    taxableIncomeRoundDownToIdr: 1000,
    noTaxIdSurchargeBp: 2000,
    roundingMode: "down",
  },
});
const overtimeTier = (
  fromHour: number,
  toHour: number | null,
  multiplier: string,
) => ({ fromHour, toHour, multiplier });
const overtime = parseVersion("overtime", {
  ...publishedMeta(5009, "Rumus lembur dan pengali (contoh angka)"),
  type: "overtime",
  parameters: {
    monthlyHoursDivisor: 173,
    tiersByDayType: {
      workday: [overtimeTier(0, 1, "1.5000"), overtimeTier(1, null, "2.0000")],
      rest_day_6_day_week: [
        overtimeTier(0, 7, "2.0000"),
        overtimeTier(7, 8, "3.0000"),
        overtimeTier(8, null, "4.0000"),
      ],
      rest_day_5_day_week: [
        overtimeTier(0, 8, "2.0000"),
        overtimeTier(8, 9, "3.0000"),
        overtimeTier(9, null, "4.0000"),
      ],
    },
    roundingMode: "half_up",
  },
});
const thr = parseVersion("thr", {
  ...publishedMeta(5010, "Aturan THR menurut masa kerja (contoh)"),
  type: "thr",
  parameters: {
    minTenureMonths: 1,
    fullTenureMonths: 12,
    roundingMode: "half_up",
  },
});
/** Draft for next year: not in force, ignored by every resolver. */
const bpjsKesNextYearDraft = parseVersion("bpjs_kes", {
  id: id(5011),
  tenantId: tenant.id,
  version: 2,
  effectiveFrom: "2027-01-01",
  status: "draft",
  legalBasis: `${ILLUSTRATIVE}Draf batas upah BPJS Kesehatan 2027 (contoh)`,
  publishedAt: null,
  publishedBy: null,
  createdAt: "2026-10-15T03:00:00.000Z",
  type: "bpjs_kes",
  parameters: bpjsParameters(400, 100, 13_000_000),
});

const statutoryTables: StatutoryTableVersion[] = [
  bpjsKes,
  bpjsJht,
  bpjsJkk,
  bpjsJkm,
  bpjsJp,
  ptkp,
  ter,
  pph21Annual,
  overtime,
  thr,
  bpjsKesNextYearDraft,
];

// ---- Pay components ---------------------------------------------------------

type ComponentTuple = readonly [
  n: number,
  code: string,
  name: string,
  category: z.infer<typeof payComponentSchema>["category"],
  recurrence: "fixed" | "variable",
  taxable: boolean,
  base: boolean,
  displayOrder: number,
];

const componentTuples: readonly ComponentTuple[] = [
  [5021, "BASIC", "Gaji Pokok", "base_salary", "fixed", true, true, 10],
  [
    5022,
    "POSITION_ALLOWANCE",
    "Tunjangan Jabatan",
    "fixed_allowance",
    "fixed",
    true,
    true,
    20,
  ],
  [5023, "MEAL", "Uang Makan", "meal_allowance", "variable", true, false, 30],
  [
    5024,
    "TRANSPORT",
    "Uang Transport",
    "transport_allowance",
    "variable",
    true,
    false,
    40,
  ],
  [5025, "OVERTIME", "Lembur", "overtime", "variable", true, false, 50],
  [
    5026,
    "SERVICE_CHARGE",
    "Service Charge",
    "service_charge",
    "variable",
    true,
    false,
    60,
  ],
  [5027, "THR", "Tunjangan Hari Raya", "thr", "variable", true, false, 70],
  [
    5028,
    "REIMBURSEMENT",
    "Penggantian Biaya",
    "reimbursement",
    "variable",
    false,
    false,
    80,
  ],
  [
    5029,
    "LATE",
    "Potongan Keterlambatan",
    "late_deduction",
    "variable",
    false,
    false,
    110,
  ],
  [
    5030,
    "LOAN",
    "Cicilan Kasbon",
    "loan_installment",
    "variable",
    false,
    false,
    120,
  ],
  [
    5031,
    "BPJS_EMP",
    "Iuran BPJS Karyawan",
    "bpjs_employee",
    "variable",
    false,
    false,
    130,
  ],
  [5032, "PPH21", "PPh 21", "pph21", "variable", false, false, 140],
  [
    5033,
    "TAX_ALLOWANCE",
    "Tunjangan PPh 21",
    "tax_allowance",
    "variable",
    false,
    false,
    90,
  ],
  [
    5034,
    "PPH21_REFUND",
    "Pengembalian PPh 21",
    "custom_earning",
    "variable",
    false,
    false,
    100,
  ],
  [
    5035,
    "PPH21_RECEIVABLE",
    "Penagihan Kekurangan PPh 21",
    "pph21_receivable",
    "variable",
    false,
    false,
    115,
  ],
];

const payComponents = componentTuples.map(
  ([n, code, name, category, recurrence, taxable, base, displayOrder]) =>
    payComponentSchema.parse({
      id: id(n),
      tenantId: tenant.id,
      code,
      name,
      category,
      recurrence,
      taxable,
      taxScheme: "gross",
      bpjsBase: base,
      overtimeBase: base,
      thrBase: base,
      displayOrder,
      kind: payComponentKindOf(category),
      isSystem: true,
      isActive: true,
      createdAt: "2025-12-15T03:00:00.000Z",
      updatedAt: "2025-12-15T03:00:00.000Z",
    }),
);
const componentByCode = (code: string) =>
  must(
    payComponents.find((component) => component.code === code),
    `unknown component ${code}`,
  );

// ---- Policies, employees and pay amounts -------------------------------------

const monthlyPolicy = payrollPolicySchema.parse({
  id: id(5101),
  tenantId: tenant.id,
  legalEntityId,
  name: "Payroll Bulanan Cafe Legend",
  employeeGroup: {
    code: "MONTHLY",
    name: "Karyawan Bulanan",
    employmentTypes: ["pkwtt", "pkwt"],
  },
  cycle: { frequency: "monthly", cutoffDay: 25, payDay: 28, payMonthOffset: 0 },
  payDateAdjustment: "previous_working_day",
  jkkRiskClass: "low",
  bpjsProgrammes: [...BPJS_TABLE_TYPES],
  isActive: true,
  createdAt: "2025-12-15T03:00:00.000Z",
  updatedAt: "2025-12-15T03:00:00.000Z",
});
const dailyPolicy = payrollPolicySchema.parse({
  id: id(5102),
  tenantId: tenant.id,
  legalEntityId,
  name: "Payroll Harian Cafe Legend",
  employeeGroup: {
    code: "DAILY",
    name: "Pekerja Harian",
    employmentTypes: ["daily"],
  },
  cycle: { frequency: "daily", payDaysAfterPeriodEnd: 1 },
  payDateAdjustment: "none",
  jkkRiskClass: "low",
  bpjsProgrammes: ["jkk", "jkm"],
  isActive: true,
  createdAt: "2025-12-15T03:00:00.000Z",
  updatedAt: "2025-12-15T03:00:00.000Z",
});
const payrollPolicies = [monthlyPolicy, dailyPolicy];

/** First eight active monthly employees of the HRIS fixture. */
const payrollEmployees: Employee[] = hrisEmployees
  .filter(
    (employee) =>
      employee.status === "active" &&
      (employee.employmentType === "pkwtt" ||
        employee.employmentType === "pkwt"),
  )
  .slice(0, 8);
if (payrollEmployees.length !== 8)
  throw new TypeError("Payroll fixture: expected 8 monthly employees");

const compensation: Record<string, { basic: number; allowance: number }> = {
  "CL-1001": { basic: 12_000_000, allowance: 1_500_000 },
  "CL-1002": { basic: 9_000_000, allowance: 1_000_000 },
  "CL-1003": { basic: 6_500_000, allowance: 500_000 },
  "CL-1004": { basic: 4_500_000, allowance: 0 },
  "CL-1005": { basic: 4_800_000, allowance: 0 },
  "CL-1006": { basic: 4_500_000, allowance: 0 },
  "CL-1007": { basic: 8_000_000, allowance: 750_000 },
  "CL-1008": { basic: 5_000_000, allowance: 0 },
};
const compensationOf = (employee: Employee) =>
  must(compensation[employee.employeeNo], `pay for ${employee.employeeNo}`);

const employeePayComponents = payrollEmployees.flatMap((employee, index) => {
  const pay = compensationOf(employee);
  const row = (n: number, code: string, amountIdr: number) =>
    employeePayComponentSchema.parse({
      id: id(n),
      tenantId: tenant.id,
      employeeId: employee.id,
      componentId: componentByCode(code).id,
      amountIdr,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      createdAt: "2025-12-20T03:00:00.000Z",
    });
  return [
    row(5041 + index, "BASIC", pay.basic),
    ...(pay.allowance > 0
      ? [row(5061 + index, "POSITION_ALLOWANCE", pay.allowance)]
      : []),
  ];
});

const thrSchedules = [
  thrScheduleSchema.parse({
    id: id(5301),
    tenantId: tenant.id,
    legalEntityId,
    name: "THR Idul Fitri 2027",
    holidayName: "Idul Fitri",
    holidayDate: "2027-03-10",
    tenureAsOfDate: "2027-03-10",
    payDate: "2027-03-03",
    employeeIds: null,
    status: "scheduled",
    createdAt: "2026-10-20T03:00:00.000Z",
  }),
];

// ---- Kasbon -----------------------------------------------------------------

const loanPolicy = loanPolicySchema.parse({
  maxPrincipalIdr: 5_000_000,
  maxPrincipalOfBaseSalaryBp: 10_000,
  maxTotalOpenIdr: 5_000_000,
  maxInstallments: 6,
  maxDeductionOfNetPayBp: 5000,
  singleOpenLoan: true,
});

const employeeByNo = (employeeNo: string) =>
  must(
    payrollEmployees.find((employee) => employee.employeeNo === employeeNo),
    `unknown employee ${employeeNo}`,
  );

const pendingLoan = employeeLoanSchema.parse({
  id: id(5401),
  tenantId: tenant.id,
  employeeId: employeeByNo("CL-1004").id,
  principalIdr: 2_000_000,
  installmentIdr: loanInstallmentFor(idr(2_000_000), 4),
  installmentCount: 4,
  outstandingIdr: 2_000_000,
  firstDeductionPeriod: "2026-11-25",
  reason: "Biaya sekolah anak",
  status: "pending",
  requestedAt: "2026-10-30T04:00:00.000Z",
  decidedBy: null,
  decidedAt: null,
  disbursedAt: null,
  settledAt: null,
});
const LOAN_PRINCIPAL = idr(3_000_000);
const disbursedLoanDraft = {
  id: id(5402),
  tenantId: tenant.id,
  employeeId: employeeByNo("CL-1006").id,
  principalIdr: LOAN_PRINCIPAL,
  installmentIdr: loanInstallmentFor(LOAN_PRINCIPAL, 3),
  installmentCount: 3,
  firstDeductionPeriod: "2026-10-25",
  reason: "Biaya kontrakan",
  status: "disbursed" as const,
  requestedAt: "2026-09-24T04:00:00.000Z",
  decidedBy: hrApprover,
  decidedAt: "2026-09-25T04:00:00.000Z",
  disbursedAt: "2026-09-26T03:00:00.000Z",
  settledAt: null,
};
/** The loan as the October run found it, before its first installment. */
const disbursedLoanBeforeOctober = employeeLoanSchema.parse({
  ...disbursedLoanDraft,
  outstandingIdr: LOAN_PRINCIPAL,
});
const settledLoan = employeeLoanSchema.parse({
  id: id(5403),
  tenantId: tenant.id,
  employeeId: employeeByNo("CL-1008").id,
  principalIdr: 1_500_000,
  installmentIdr: loanInstallmentFor(idr(1_500_000), 3),
  installmentCount: 3,
  outstandingIdr: 0,
  firstDeductionPeriod: "2026-07-25",
  reason: "Biaya berobat",
  status: "settled",
  requestedAt: "2026-06-20T04:00:00.000Z",
  decidedBy: hrApprover,
  decidedAt: "2026-06-21T04:00:00.000Z",
  disbursedAt: "2026-06-22T03:00:00.000Z",
  settledAt: "2026-09-25T10:00:00.000Z",
});

// ---- Statutory versions in force on the pay dates ---------------------------

const versionsInForce = (payDate: string) =>
  STATUTORY_TABLE_TYPES.map((type) =>
    resolveStatutoryTable(statutoryTables, type, payDate),
  );

// ---- Period arithmetic via the contract ------------------------------------

const isWeekend = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};
const periodFor = (referenceDate: string) => {
  const period = payrollPeriodFor(monthlyPolicy.cycle, referenceDate);
  return {
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    payDate: adjustPayDate(
      period.payDate,
      monthlyPolicy.payDateAdjustment,
      isWeekend,
    ),
  };
};
const octoberPeriod = periodFor("2026-10-10");
const novemberPeriod = periodFor("2026-11-10");
const decemberPeriod = periodFor("2026-12-10");
if (
  octoberPeriod.periodStart !== "2026-09-26" ||
  octoberPeriod.periodEnd !== "2026-10-25" ||
  octoberPeriod.payDate !== "2026-10-28"
)
  throw new TypeError(
    "Payroll fixture: October period drifted from the policy",
  );

const octoberRunId = id(5201);
const novemberRunId = id(5202);
const decemberRunId = id(5203);

// ---- Service charge ---------------------------------------------------------

const serviceChargeRule = {
  method: "points_x_attendance" as const,
  minAttendanceDays: 10,
  eligibleEmploymentTypes: ["pkwtt", "pkwt", "daily"] as Array<
    "pkwtt" | "pkwt" | "daily"
  >,
};
const octoberAttendanceDays = [26, 25, 24, 22, 20, 19, 18, 23];
const novemberAttendanceDays = [24, 26, 25, 21, 22, 20, 19, 23];

const splitServiceCharge = (
  poolId: string,
  firstAllocationNumber: number,
  amountIdr: Idr,
  attendanceDays: readonly number[],
) => {
  const participants: ServiceChargeParticipant[] = payrollEmployees.map(
    (employee, index) => ({
      employeeId: employee.id,
      employmentType: employee.employmentType,
      points: positionOf(employee).serviceChargePoints,
      attendanceDays: must(attendanceDays[index], "attendance days"),
    }),
  );
  const shares = distributeServiceChargePool(
    amountIdr,
    serviceChargeRule,
    participants,
  );
  const allocated = sumIdr(shares.map((share) => share.amountIdr));
  if (allocated !== amountIdr)
    throw new TypeError(
      `Payroll fixture: service charge split ${allocated} != pool ${amountIdr}`,
    );
  const allocations = shares.map((share, index) =>
    serviceChargeAllocationSchema.parse({
      id: id(firstAllocationNumber + index),
      tenantId: tenant.id,
      poolId,
      employeeId: share.employeeId,
      points: share.points,
      attendanceDays: share.attendanceDays,
      weight: share.weight,
      amountIdr: share.amountIdr,
    }),
  );
  return { shares, allocations };
};

const octoberPoolId = id(5601);
const novemberPoolId = id(5602);
const OCTOBER_POOL_IDR = idr(9_876_543);
const NOVEMBER_POOL_IDR = idr(8_450_000);
const octoberSplit = splitServiceCharge(
  octoberPoolId,
  5611,
  OCTOBER_POOL_IDR,
  octoberAttendanceDays,
);
const novemberSplit = splitServiceCharge(
  novemberPoolId,
  5621,
  NOVEMBER_POOL_IDR,
  novemberAttendanceDays,
);

const serviceChargePools = [
  serviceChargePoolSchema.parse({
    id: octoberPoolId,
    tenantId: tenant.id,
    outletId: outletA,
    periodStart: octoberPeriod.periodStart,
    periodEnd: octoberPeriod.periodEnd,
    amountIdr: OCTOBER_POOL_IDR,
    rule: serviceChargeRule,
    status: "distributed",
    payrollRunId: octoberRunId,
    approvedBy: financeApprover,
    approvedAt: "2026-10-26T06:00:00.000Z",
    createdAt: "2026-10-26T01:00:00.000Z",
  }),
  serviceChargePoolSchema.parse({
    id: novemberPoolId,
    tenantId: tenant.id,
    outletId: outletA,
    periodStart: novemberPeriod.periodStart,
    periodEnd: novemberPeriod.periodEnd,
    amountIdr: NOVEMBER_POOL_IDR,
    rule: serviceChargeRule,
    status: "calculated",
    payrollRunId: null,
    approvedBy: null,
    approvedAt: null,
    createdAt: "2026-11-01T01:00:00.000Z",
  }),
];
const serviceChargeAllocations = [
  ...octoberSplit.allocations,
  ...novemberSplit.allocations,
];

// ---- Reimbursement ----------------------------------------------------------

const transportCategoryId = id(5501);
const emergencyCategoryId = id(5502);
const reimbursementCategories = [
  reimbursementCategorySchema.parse({
    id: transportCategoryId,
    tenantId: tenant.id,
    name: "Transport dinas",
    receiptRequired: true,
    limits: [
      {
        positionId: null,
        perClaimLimitIdr: 500_000,
        perMonthLimitIdr: 1_000_000,
      },
      {
        positionId: id(308),
        perClaimLimitIdr: 1_000_000,
        perMonthLimitIdr: 3_000_000,
      },
    ],
    isActive: true,
  }),
  reimbursementCategorySchema.parse({
    id: emergencyCategoryId,
    tenantId: tenant.id,
    name: "Pembelian darurat outlet",
    receiptRequired: true,
    limits: [
      {
        positionId: null,
        perClaimLimitIdr: 750_000,
        perMonthLimitIdr: 1_500_000,
      },
      {
        positionId: id(308),
        perClaimLimitIdr: 2_000_000,
        perMonthLimitIdr: 5_000_000,
      },
    ],
    isActive: true,
  }),
];

const receipt = (n: number) =>
  `https://files.legend.example/signed/receipt-${n}?sig=demo`;
const claim = (row: Record<string, unknown>) =>
  reimbursementSchema.parse({ tenantId: tenant.id, ...row });

const payrollPaidClaim = claim({
  id: id(5513),
  employeeId: employeeByNo("CL-1005").id,
  categoryId: transportCategoryId,
  expenseDate: "2026-10-12",
  amountIdr: 350_000,
  approvedAmountIdr: 350_000,
  description: "Transport ke pelatihan barista di outlet partner",
  receiptUrl: receipt(3),
  payout: "payroll",
  status: "paid",
  payrollRunId: octoberRunId,
  submittedAt: "2026-10-13T03:00:00.000Z",
  decidedBy: outletManagerUser,
  decidedAt: "2026-10-14T03:00:00.000Z",
  paidAt: "2026-10-27T04:00:00.000Z",
});
const approvedClaim = claim({
  id: id(5512),
  employeeId: employeeByNo("CL-1007").id,
  categoryId: emergencyCategoryId,
  expenseDate: "2026-10-28",
  amountIdr: 250_000,
  approvedAmountIdr: 250_000,
  description: "Pembelian tabung gas darurat",
  receiptUrl: receipt(2),
  payout: "payroll",
  status: "approved",
  payrollRunId: null,
  submittedAt: "2026-10-29T03:00:00.000Z",
  decidedBy: outletManagerUser,
  decidedAt: "2026-10-30T03:00:00.000Z",
  paidAt: null,
});
const reimbursements = [
  claim({
    id: id(5511),
    employeeId: employeeByNo("CL-1004").id,
    categoryId: transportCategoryId,
    expenseDate: "2026-10-29",
    amountIdr: 180_000,
    approvedAmountIdr: null,
    description: "Transport antar bahan ke outlet kedua",
    receiptUrl: receipt(1),
    payout: "payroll",
    status: "submitted",
    payrollRunId: null,
    submittedAt: "2026-10-31T03:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    paidAt: null,
  }),
  approvedClaim,
  payrollPaidClaim,
  claim({
    id: id(5514),
    employeeId: employeeByNo("CL-1008").id,
    categoryId: emergencyCategoryId,
    expenseDate: "2026-10-15",
    amountIdr: 120_000,
    approvedAmountIdr: 120_000,
    description: "Beli sarung tangan dapur pengganti",
    receiptUrl: null,
    payout: "cash",
    status: "paid",
    payrollRunId: null,
    submittedAt: "2026-10-15T08:00:00.000Z",
    decidedBy: outletManagerUser,
    decidedAt: "2026-10-15T09:00:00.000Z",
    paidAt: "2026-10-15T10:00:00.000Z",
  }),
  claim({
    id: id(5515),
    employeeId: employeeByNo("CL-1006").id,
    categoryId: transportCategoryId,
    expenseDate: "2026-10-18",
    amountIdr: 900_000,
    approvedAmountIdr: null,
    description: "Transport pribadi ke luar kota",
    receiptUrl: receipt(5),
    payout: "payroll",
    status: "rejected",
    payrollRunId: null,
    submittedAt: "2026-10-19T03:00:00.000Z",
    decidedBy: outletManagerUser,
    decidedAt: "2026-10-20T03:00:00.000Z",
    paidAt: null,
  }),
];

// ---- Payslip calculation -----------------------------------------------------

type CalculationInput = {
  employee: Employee;
  period: { periodStart: string; periodEnd: string; payDate: string };
  overtimeHours: string | null;
  serviceCharge: { amountIdr: Idr; points: Decimal4; poolId: string };
  reimbursement: { amountIdr: number; id: string } | null;
  loan: Pick<
    z.infer<typeof employeeLoanSchema>,
    "id" | "status" | "installmentIdr" | "outstandingIdr" | "disbursedAt"
  > | null;
  lateIdr: number;
  /** Open PPh 21 receivable from earlier payslips (default 0). */
  pph21ReceivableOpenIdr?: number;
  paymentMethod: "bank_transfer" | "cash";
};

// Published fixture versions as the PPh 21 engine takes them. The mock months
// are plain TER months (never a last tax period), under the default policy.
const pph21Tables: Pph21Tables = {
  ptkp: ptkp.parameters,
  ter: ter.parameters,
  annual: pph21Annual.parameters,
};
const hasTaxIdOf = (employee: Employee) => {
  const pii = must(
    cafeLegendHrisFixtures.employeePii.find(
      (row) => row.employeeId === employee.id,
    ),
    `PII of ${employee.employeeNo}`,
  ).pii;
  return pii.npwp !== null || pii.nik !== null;
};
/** Months at the employer in the pay date's tax year, this one included. */
const monthsWorkedIn = (employee: Employee, payDate: string) => {
  const joinYear = Number(employee.joinDate.slice(0, 4));
  const joinMonth = Number(employee.joinDate.slice(5, 7));
  const payYear = Number(payDate.slice(0, 4));
  const payMonth = Number(payDate.slice(5, 7));
  const months = joinYear < payYear ? payMonth : payMonth - joinMonth + 1;
  return Math.min(12, Math.max(1, months));
};

const MEAL_DAYS = 25;
const MEAL_RATE_IDR = 30_000;

function calculate(input: CalculationInput) {
  const { employee } = input;
  const pay = compensationOf(employee);
  const ptkpStatus = must(
    employee.ptkpStatus,
    `PTKP of ${employee.employeeNo}`,
  );
  const position = positionOf(employee);
  const monthlyBase = idr(pay.basic + pay.allowance);

  const line = (
    code: string,
    amountIdr: number,
    extra: { quantity?: string; sourceId?: string } = {},
  ): PayslipLine => {
    const component = componentByCode(code);
    return payslipLineSchema.parse({
      componentCode: component.code,
      name: component.name,
      category: component.category,
      kind: component.kind,
      amountIdr,
      taxable: component.taxable,
      quantity: extra.quantity === undefined ? null : decimal4(extra.quantity),
      sourceId: extra.sourceId ?? null,
    });
  };

  const earnings: PayslipLine[] = [line("BASIC", pay.basic)];
  if (pay.allowance > 0)
    earnings.push(line("POSITION_ALLOWANCE", pay.allowance));
  earnings.push(
    line("MEAL", MEAL_DAYS * MEAL_RATE_IDR, {
      quantity: `${MEAL_DAYS}.0000`,
    }),
  );
  if (input.overtimeHours !== null)
    earnings.push(
      line(
        "OVERTIME",
        computeOvertimePay(
          overtime.parameters,
          "workday",
          decimal4(input.overtimeHours),
          monthlyBase,
        ),
        { quantity: input.overtimeHours },
      ),
    );
  const share = must(input.serviceCharge, "service charge share");
  earnings.push(
    line("SERVICE_CHARGE", share.amountIdr, {
      quantity: share.points,
      sourceId: share.poolId,
    }),
  );
  if (input.reimbursement !== null)
    earnings.push(
      line("REIMBURSEMENT", input.reimbursement.amountIdr, {
        sourceId: input.reimbursement.id,
      }),
    );

  const bpjs: PayslipBpjsLine[] = monthlyPolicy.bpjsProgrammes.map((type) => {
    const version = {
      kes: bpjsKes,
      bpjs_kes: bpjsKes,
      jht: bpjsJht,
      jkk: bpjsJkk,
      jkm: bpjsJkm,
      jp: bpjsJp,
    }[type === "bpjs_kes" ? "kes" : type];
    return payslipBpjsLineSchema.parse(
      computeBpjsContribution(
        bpjsRateOf(version, monthlyPolicy.jkkRiskClass),
        monthlyBase,
      ),
    );
  });
  const bpjsEmployeeIdr = sumIdr(bpjs.map((b) => b.employeeIdr));
  const bpjsCompanyIdr = sumIdr(bpjs.map((b) => b.employerIdr));

  // Gross scheme: taxable gross = taxable earnings + the employer's JKK, JKM
  // and BPJS Kesehatan shares (benefit in kind), as the PRD tax step does.
  const employerBenefitIdr = sumIdr(
    bpjs
      .filter(
        (b) => b.type === "jkk" || b.type === "jkm" || b.type === "bpjs_kes",
      )
      .map((b) => b.employerIdr),
  );
  const employeeDeductibleIdr = sumIdr(
    bpjs
      .filter((b) => b.type === "jht" || b.type === "jp")
      .map((b) => b.employeeIdr),
  );
  const { tax } = computePayslipTax({
    tables: pph21Tables,
    policy: DEFAULT_PPH21_POLICY,
    ptkpStatus,
    hasTaxId: hasTaxIdOf(employee),
    lastTaxPeriod: false,
    monthsWorked: monthsWorkedIn(employee, input.period.payDate),
    earnings: earnings.map((earning) => ({
      amountIdr: earning.amountIdr,
      taxable: earning.taxable,
      taxScheme: componentByCode(earning.componentCode).taxScheme,
    })),
    employerBenefitIdr,
    employeeDeductibleIdr,
    employeeWithholdingCapIdr: payslipWithholdingCap({
      cashEarningsIdr: sumIdr(earnings.map((l) => l.amountIdr)),
      bpjsEmployeeIdr,
      preNetDeductionsIdr: input.lateIdr,
    }),
    prior: {
      taxableGrossIdr: 0,
      employeeDeductibleIdr: 0,
      pph21WithheldIdr: 0,
      pph21EmployerBorneIdr: 0,
    },
  });
  const pph21Idr = tax.pph21Idr;
  // Extra earnings of the tax step: gross-up allowance and lebih potong refund.
  if (tax.taxAllowanceIdr > 0)
    earnings.push(line("TAX_ALLOWANCE", tax.taxAllowanceIdr));
  if (tax.pph21RefundIdr > 0)
    earnings.push(line("PPH21_REFUND", tax.pph21RefundIdr));

  const grossIdr = sumIdr(earnings.map((l) => l.amountIdr));
  const netBeforeLoansIdr = idr(
    grossIdr - bpjsEmployeeIdr - tax.pph21WithheldIdr - input.lateIdr,
  );
  // Order of deductions: BPJS_EMP, PPH21, LATE, PPH21_RECEIVABLE, LOAN. The
  // receivable raised on this payslip (tax.pph21ReceivableIdr) is collected
  // from the next one; loans take what the collection leaves.
  const receivableCollection = planPph21ReceivableCollection({
    openIdr: input.pph21ReceivableOpenIdr ?? 0,
    roomIdr: netBeforeLoansIdr,
  });
  const loanPlan =
    input.loan === null
      ? []
      : planLoanDeductions(
          [input.loan],
          idr(netBeforeLoansIdr - receivableCollection.collectedIdr),
          loanPolicy.maxDeductionOfNetPayBp,
        );
  const loanDeductedIdr = sumIdr(loanPlan.map((plan) => plan.deductedIdr));

  const deductions: PayslipLine[] = [
    line("BPJS_EMP", bpjsEmployeeIdr),
    line("PPH21", tax.pph21WithheldIdr),
  ];
  if (input.lateIdr > 0) deductions.push(line("LATE", input.lateIdr));
  if (receivableCollection.collectedIdr > 0)
    deductions.push(
      line("PPH21_RECEIVABLE", receivableCollection.collectedIdr),
    );
  const loanPlanned = loanPlan[0];
  if (loanPlanned !== undefined && loanDeductedIdr > 0)
    deductions.push(
      line("LOAN", loanDeductedIdr, { sourceId: loanPlanned.loanId }),
    );

  const lines = [...earnings, ...deductions];
  const deductionsIdr = sumIdr(deductions.map((l) => l.amountIdr));
  const sumOf = (category: PayslipLine["category"]) =>
    sumIdr(
      lines.filter((l) => l.category === category).map((l) => l.amountIdr),
    );

  const calculation = payslipCalculationSchema.parse({
    employeeId: employee.id,
    employeeNo: employee.employeeNo,
    employeeName: employee.fullName,
    positionName: position.name,
    outletId: employee.homeOutletId,
    ...input.period,
    grossIdr,
    deductionsIdr,
    netIdr: idr(grossIdr - deductionsIdr),
    pph21Idr,
    bpjsEmployeeIdr,
    bpjsCompanyIdr,
    serviceChargeIdr: sumOf("service_charge"),
    overtimeIdr: sumOf("overtime"),
    lines,
    bpjs,
    tax,
    paymentMethod: input.paymentMethod,
  });
  return { calculation, loanPlan };
}

/** The mock payslip builder, exported for the deduction-order unit tests. */
export const calculateFixturePayslip = calculate;
export type FixturePayslipInput = CalculationInput;

// ---- October payslips ---------------------------------------------------------

const octoberScenario = {
  overtime: {
    "CL-1004": "3.5000",
    "CL-1005": "2.0000",
    "CL-1008": "5.0000",
  } as Record<string, string>,
  late: { "CL-1004": 50_000 } as Record<string, number>,
  cash: ["CL-1006"],
};

const serviceChargeShareOf = (
  split: typeof octoberSplit,
  poolId: string,
  employee: Employee,
) => {
  const share = must(
    split.shares.find((s) => s.employeeId === employee.id),
    `service charge share of ${employee.employeeNo}`,
  );
  return { amountIdr: share.amountIdr, points: share.points, poolId };
};

const octoberCalculations = payrollEmployees.map((employee) =>
  calculate({
    employee,
    period: octoberPeriod,
    overtimeHours: octoberScenario.overtime[employee.employeeNo] ?? null,
    serviceCharge: serviceChargeShareOf(octoberSplit, octoberPoolId, employee),
    reimbursement:
      employee.id === payrollPaidClaim.employeeId
        ? { amountIdr: payrollPaidClaim.amountIdr, id: payrollPaidClaim.id }
        : null,
    loan:
      employee.id === disbursedLoanBeforeOctober.employeeId
        ? disbursedLoanBeforeOctober
        : null,
    lateIdr: octoberScenario.late[employee.employeeNo] ?? 0,
    paymentMethod: octoberScenario.cash.includes(employee.employeeNo)
      ? "cash"
      : "bank_transfer",
  }),
);

// The October installment brings the disbursed loan to its stored balance.
const octoberLoanPlan = must(
  octoberCalculations.flatMap((result) => result.loanPlan)[0],
  "October loan deduction",
);
const employeeLoans = [
  pendingLoan,
  employeeLoanSchema.parse({
    ...disbursedLoanDraft,
    outstandingIdr: octoberLoanPlan.outstandingAfterIdr,
  }),
  settledLoan,
];
if (octoberLoanPlan.outstandingAfterIdr !== 2_000_000)
  throw new TypeError("Payroll fixture: loan balance after October drifted");

const payslipCreatedAt = "2026-10-27T04:00:00.000Z";
const payslips = octoberCalculations.map(({ calculation }, index) =>
  payslipSchema.parse({
    id: id(5701 + index),
    tenantId: tenant.id,
    payrollRunId: octoberRunId,
    ...calculation,
    fileUrl:
      index < payrollEmployees.length - 1
        ? `https://files.legend.example/signed/payslip-${5701 + index}.pdf?sig=demo`
        : null,
    viewedAt: index < 4 ? "2026-10-28T03:30:00.000Z" : null,
    createdAt: payslipCreatedAt,
  }),
);
const octoberTotals = sumPayrollRunTotals(payslips);

// ---- November simulation -------------------------------------------------------

const novemberScenario = {
  overtime: {
    "CL-1003": "4.0000",
    "CL-1004": "1.5000",
    "CL-1007": "6.0000",
  } as Record<string, string>,
  late: { "CL-1008": 40_000 } as Record<string, number>,
  cash: ["CL-1006"],
};
const loanAfterOctober = must(employeeLoans[1], "disbursed loan");

const employeeResults = payrollEmployees.map((employee) => {
  const { calculation } = calculate({
    employee,
    period: novemberPeriod,
    overtimeHours: novemberScenario.overtime[employee.employeeNo] ?? null,
    serviceCharge: serviceChargeShareOf(
      novemberSplit,
      novemberPoolId,
      employee,
    ),
    reimbursement:
      employee.id === approvedClaim.employeeId
        ? { amountIdr: approvedClaim.amountIdr, id: approvedClaim.id }
        : null,
    loan: employee.id === loanAfterOctober.employeeId ? loanAfterOctober : null,
    lateIdr: novemberScenario.late[employee.employeeNo] ?? 0,
    paymentMethod: novemberScenario.cash.includes(employee.employeeNo)
      ? "cash"
      : "bank_transfer",
  });
  const previous = must(
    payslips.find((slip) => slip.employeeId === employee.id),
    `October payslip of ${employee.employeeNo}`,
  );
  const netChangeIdr = calculation.netIdr - previous.netIdr;
  return payrollRunEmployeeResultSchema.parse({
    ...calculation,
    previousNetIdr: previous.netIdr,
    netChangeIdr,
    flags:
      Math.abs(netChangeIdr) * 100 >= previous.netIdr * 15
        ? ["net_change_over_threshold"]
        : [],
  });
});
const novemberTotals = sumPayrollRunTotals(employeeResults);

// ---- Payroll runs ---------------------------------------------------------------

const snapshotFor = (capturedAt: string, payDate: string) =>
  payrollConfigSnapshotSchema.parse({
    statutoryVersions: versionsInForce(payDate).map(statutoryVersionRef),
    policy: {
      id: monthlyPolicy.id,
      cycle: monthlyPolicy.cycle,
      payDateAdjustment: monthlyPolicy.payDateAdjustment,
      jkkRiskClass: monthlyPolicy.jkkRiskClass,
      bpjsProgrammes: monthlyPolicy.bpjsProgrammes,
    },
    components: payComponents.map((component) => ({
      id: component.id,
      code: component.code,
      category: component.category,
      taxable: component.taxable,
      taxScheme: component.taxScheme,
      bpjsBase: component.bpjsBase,
      overtimeBase: component.overtimeBase,
      thrBase: component.thrBase,
    })),
    loanMaxDeductionOfNetPayBp: loanPolicy.maxDeductionOfNetPayBp,
    pph21Policy: null,
    capturedAt,
  });

const runBase = {
  tenantId: tenant.id,
  legalEntityId,
  payrollPolicyId: monthlyPolicy.id,
  runType: "regular" as const,
  thrScheduleId: null,
  reversal: null,
  createdBy: runCreator,
};

const octoberRun = payrollRunSchema.parse({
  ...runBase,
  id: octoberRunId,
  ...octoberPeriod,
  status: "paid",
  simulationCount: 2,
  lastSimulatedAt: "2026-10-26T03:00:00.000Z",
  totals: octoberTotals,
  configSnapshot: snapshotFor(
    "2026-10-26T03:00:00.000Z",
    octoberPeriod.payDate,
  ),
  approvedByHr: hrApprover,
  approvedByHrAt: "2026-10-26T08:00:00.000Z",
  approvedByFinance: financeApprover,
  approvedByFinanceAt: "2026-10-27T03:00:00.000Z",
  lockedBy: financeApprover,
  lockedAt: payslipCreatedAt,
  paidBy: financeApprover,
  paidAt: "2026-10-28T02:00:00.000Z",
  createdAt: "2026-10-26T01:00:00.000Z",
  updatedAt: "2026-10-28T02:00:00.000Z",
});
const novemberRun = payrollRunSchema.parse({
  ...runBase,
  id: novemberRunId,
  ...novemberPeriod,
  status: "simulated",
  simulationCount: 1,
  lastSimulatedAt: "2026-11-01T01:30:00.000Z",
  totals: novemberTotals,
  configSnapshot: snapshotFor(
    "2026-11-01T01:30:00.000Z",
    novemberPeriod.payDate,
  ),
  approvedByHr: null,
  approvedByHrAt: null,
  approvedByFinance: null,
  approvedByFinanceAt: null,
  lockedBy: null,
  lockedAt: null,
  paidBy: null,
  paidAt: null,
  createdAt: "2026-11-01T01:00:00.000Z",
  updatedAt: "2026-11-01T01:30:00.000Z",
});
const decemberRun = payrollRunSchema.parse({
  ...runBase,
  id: decemberRunId,
  ...decemberPeriod,
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
  createdAt: "2026-11-01T01:10:00.000Z",
  updatedAt: "2026-11-01T01:10:00.000Z",
});

// ---- Bank transfer file ------------------------------------------------------------

const bankSlips = payslips.filter(
  (slip) => slip.paymentMethod === "bank_transfer",
);
// PAYR-04 at load: the file rows are exactly the run's bank-transfer payslips.
assertBankFileMatchesRun(
  bankSlips.map((slip) => ({
    employeeId: slip.employeeId,
    amountIdr: slip.netIdr,
  })),
  payslips,
  octoberTotals,
);
const bankTransferFiles = [
  bankTransferFileSchema.parse({
    id: id(5801),
    tenantId: tenant.id,
    payrollRunId: octoberRunId,
    format: "generic_csv",
    rowCount: bankSlips.length,
    totalIdr: octoberTotals.bankTransferIdr,
    checksumSha256:
      "5b1f0e7c9a3d4e62b8f1c07a9d2e4b6c8f0a1d3e5b7c9a2f4e6d8b0c1a3e5f79",
    fileUrl:
      "https://files.legend.example/signed/payroll-2026-10-generic.csv?sig=demo",
    createdBy: financeApprover,
    createdAt: "2026-10-27T04:30:00.000Z",
  }),
];

// ---- Events ----------------------------------------------------------------------------

const runRef = {
  payrollRunId: octoberRunId,
  legalEntityId,
  runType: "regular",
  ...octoberPeriod,
};
const financeActor = { type: "user" as const, id: financeApprover };
const lockedAt = must(octoberRun.lockedAt, "October lockedAt");
const paidAt = must(octoberRun.paidAt, "October paidAt");

const payrollLockedEvent = payrollLocked.envelopeSchema.parse({
  id: ulid(51),
  tenantId: tenant.id,
  outletId: null,
  name: "payroll.locked",
  version: 1,
  aggregateType: "payroll",
  aggregateId: octoberRunId,
  sequence: 1,
  occurredAt: lockedAt,
  actor: financeActor,
  deviceId: null,
  idempotencyKey: `payroll-locked-${octoberRunId}`,
  payloadSchemaRef: "payroll.locked.v1",
  payload: {
    ...runRef,
    totals: octoberTotals,
    lockedBy: financeApprover,
    lockedAt,
  },
});
const payrollPaidEvent = payrollPaid.envelopeSchema.parse({
  id: ulid(52),
  tenantId: tenant.id,
  outletId: null,
  name: "payroll.paid",
  version: 1,
  aggregateType: "payroll",
  aggregateId: octoberRunId,
  sequence: 2,
  occurredAt: paidAt,
  actor: financeActor,
  deviceId: null,
  idempotencyKey: `payroll-paid-${octoberRunId}`,
  payloadSchemaRef: "payroll.paid.v1",
  payload: {
    ...runRef,
    netIdr: octoberTotals.netIdr,
    bankTransferIdr: octoberTotals.bankTransferIdr,
    cashIdr: octoberTotals.cashIdr,
    bankTransferFileId: must(bankTransferFiles[0], "bank file").id,
    paidBy: financeApprover,
    paidAt,
  },
});
const firstPayslip = must(payslips[0], "first payslip");
const payslipCreatedEvent = payslipCreated.envelopeSchema.parse({
  id: ulid(53),
  tenantId: tenant.id,
  outletId: firstPayslip.outletId,
  name: "payslip.created",
  version: 1,
  aggregateType: "payslip",
  aggregateId: firstPayslip.id,
  sequence: 1,
  occurredAt: lockedAt,
  actor: financeActor,
  deviceId: null,
  idempotencyKey: `payslip-created-${firstPayslip.id}`,
  payloadSchemaRef: "payslip.created.v1",
  payload: {
    payslipId: firstPayslip.id,
    payrollRunId: octoberRunId,
    employeeId: firstPayslip.employeeId,
    payDate: firstPayslip.payDate,
  },
});

// ---- Whole-fixture schema -----------------------------------------------------------------

export const payrollFixtureSchema = z.strictObject({
  statutoryTables: z.array(statutoryTableVersionSchema),
  payComponents: z.array(payComponentSchema),
  employeePayComponents: z.array(employeePayComponentSchema),
  payrollPolicies: z.array(payrollPolicySchema),
  thrSchedules: z.array(thrScheduleSchema),
  loanPolicy: loanPolicySchema,
  employeeLoans: z.array(employeeLoanSchema),
  reimbursementCategories: z.array(reimbursementCategorySchema),
  reimbursements: z.array(reimbursementSchema),
  serviceChargePools: z.array(serviceChargePoolSchema),
  serviceChargeAllocations: z.array(serviceChargeAllocationSchema),
  payrollRuns: z.strictObject({
    october: payrollRunSchema,
    november: payrollRunSchema,
    december: payrollRunSchema,
  }),
  payslips: z.array(payslipSchema),
  employeeResults: z.array(payrollRunEmployeeResultSchema),
  bankTransferFiles: z.array(bankTransferFileSchema),
  events: z.strictObject({
    payrollLocked: payrollLocked.envelopeSchema,
    payrollPaid: payrollPaid.envelopeSchema,
    payslipCreated: payslipCreated.envelopeSchema,
  }),
});
export type PayrollFixture = z.infer<typeof payrollFixtureSchema>;

export const cafeLegendPayrollFixtures = {
  tenant,
  outlets,
  /** Server-resolved "now" the fixtures were authored against. */
  now,
  legalEntityId,
  statutoryTables,
  payComponents,
  employeePayComponents,
  payrollPolicies,
  thrSchedules,
  loanPolicy,
  employeeLoans,
  reimbursementCategories,
  reimbursements,
  serviceChargePools,
  serviceChargeAllocations,
  payrollRuns: {
    october: octoberRun,
    november: novemberRun,
    december: decemberRun,
  },
  payslips,
  employeeResults,
  bankTransferFiles,
  events: {
    payrollLocked: payrollLockedEvent,
    payrollPaid: payrollPaidEvent,
    payslipCreated: payslipCreatedEvent,
  },
  userIds: {
    hrApprover,
    financeApprover,
    runCreator,
  },
} as const;
