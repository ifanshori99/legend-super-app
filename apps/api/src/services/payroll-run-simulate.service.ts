// Payroll run SIMULATE step (bead legend-c2yca; PRD PAYR-01, PAYR-02; design
// docs/briefs/sub-payroll-followups-design.md §2). Trusted in-transaction
// writer: the caller owns the tenant transaction (`withTenant`). The server
// computes every employee's payslip and stores it sealed in
// `payroll_run_results`; the lock (`payroll-run-lock.service.ts`) reads those
// rows, never numbers from the caller.
//
//  1. permission `payroll.run`;
//  2. LOCK ORDER (design §0.4): month advisory lock, rapel component locks +
//     employees/outlets FOR SHARE, then the run row FOR UPDATE, then the
//     prior runs FOR SHARE (`loadTaxYearPriors`), then the receivable reads,
//     then the loans FOR UPDATE in id order (`payroll-run-loans.ts`), then
//     reads, then writes. Never lock a run row after a loan row;
//  3. population: employees of the run's legal entity (own, else the home
//     outlet's), in the policy's employment types, employed during the period
//     (THR runs: also THR-eligible and in the schedule's list);
//  4. per employee: gross (RAPEL included), BPJS capped at the gross's net,
//     tax facts from the employee row, tax-year priors;
//  5. PPh 21 for all employees in one call, then the pure composer;
//  6. writes: run row (reducer `simulate`), old results deleted, new results
//     inserted, the run's kasbon rows replaced (one per LOAN line: a
//     reservation, the loan balance only drops at lock; legend-8tfvr), audit
//     with counts only. No payslip, no outbox event (PAYR-01).
//
// Decided O7 (legend-0ytbu): population = employees whose legal entity (own,
// else the home outlet's) is the run's, whose employment type is one of the
// policy's, and whose employment overlaps the period inclusively:
// joinDate <= periodEnd AND (endDate IS NULL OR endDate >= periodStart).
// Decided O8 (legend-0ytbu): `partialYearTaxSubject` is false for every
// employee. Only a foreign national staying under 183 days is a partial-year
// subject and no such field exists; false never under-withholds.
// OPEN O1: payment method = bank_transfer when a bank account is on file.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  businessDateSchema,
  createUlid,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  sumIdr,
  type BusinessDate,
  type Idr,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { employeeIdSchema, ptkpStatusSchema } from "@starter/shared/hris";
import {
  BPJS_TABLE_TYPES,
  PayrollError,
  applyPayrollRunCommand,
  employeeGroupSchema,
  jkkRiskClassSchema,
  payrollConfigSnapshotSchema,
  payrollRunIdSchema,
  payrollRunSchema,
  payslipCalculationSchema,
  payslipIdSchema,
  payslipLineSchema,
  statutoryTableVersionSchema,
  statutoryVersionsForRun,
  sumPayrollRunTotals,
  taxSchemeSchema,
  type BpjsTableType,
  type EmployeeLoanId,
  type PayrollRun,
  type PayrollRunId,
  type PayslipCalculation,
  type PayslipId,
  type PayslipLine,
  type PayslipPaymentMethod,
  type Pph21Tables,
  type StatutoryTableType,
  type StatutoryTableVersion,
  type TaxScheme,
} from "@starter/shared/hris/payroll";
import {
  employees,
  employmentContracts,
  positions,
} from "../db/schema/hris.ts";
import {
  payComponents,
  payrollLoanPolicies,
  payrollPolicies,
  payrollRunResults,
  payrollRuns,
  statutoryRates,
  thrSchedules,
} from "../db/schema/payroll.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { HttpError } from "../lib/http-error.ts";
import {
  PAYROLL_SEAL_KEY_VERSION,
  openPayrollValue,
  sealPayrollValue,
} from "../lib/payroll-sealed.ts";
import { recordAudit } from "./core-audit.ts";
import { assertPayrollTenantCan } from "./payroll-access.ts";
import { computeEmployeeGrossInTransaction } from "./payroll-components.service.ts";
import {
  bpjsLinesOf,
  composePayslipCalculation,
  payslipTaxFactsOf,
  type PlannableLoan,
} from "./payroll-run-compose.ts";
import {
  calculatePayrollRunTax,
  loadPph21ReceivableBalances,
  loadTaxYearPriors,
  lockPayrollRunMonth,
  type PayrollRunTaxEmployee,
} from "./payroll-run-pph21.service.ts";
import {
  assertRunUnchanged,
  loadRunRapelAllocations,
  lockRapelInputsForRun,
} from "./payroll-run-rapel-lock.ts";
import {
  replaceRunLoanDeductions,
  lockLoansForRunSimulation,
} from "./payroll-run-loans.ts";
import {
  calculatePayrollRunStatutory,
  captureStatutoryForLock,
  type PayrollRunStatutoryEmployee,
} from "./payroll-statutory-calc.service.ts";
import type { Tx } from "./permission-resolver.ts";

// ---- Stored result (sealed per employee) ----------------------------------

const storedTaxInputSchema = z.strictObject({
  ptkpStatus: ptkpStatusSchema,
  hasTaxId: z.boolean(),
  lastTaxPeriod: z.boolean(),
  monthsWorked: z.number().int().min(1).max(12),
  partialYearTaxSubject: z.boolean(),
  earnings: z
    .array(
      z.strictObject({
        amountIdr: idrSchema,
        taxable: z.boolean(),
        taxScheme: taxSchemeSchema,
      }),
    )
    .max(200),
  employerBenefitIdr: idrSchema,
  contractTaxScheme: taxSchemeSchema,
  employeeDeductibleIdr: idrSchema,
  employeeWithholdingCapIdr: idrSchema,
});

const monthBasisSchema = z.strictObject({
  priorGrossIdr: z.number().int().safe(),
  priorTaxIdr: z.number().int().safe(),
  priorEmployeeTaxIdr: z.number().int().safe(),
});

/**
 * One employee's simulation result, sealed in `payroll_run_results`. The lock
 * re-proves `calculation.tax` from `taxInput` + fresh priors and refuses when
 * `priorPayslipIds` (sorted) or `monthBasis` changed.
 */
export const storedRunResultSchema = z.strictObject({
  calculation: payslipCalculationSchema,
  taxInput: storedTaxInputSchema,
  /** Employee dates the population and tax period used; the lock re-reads them. */
  joinDate: businessDateSchema,
  endDate: businessDateSchema.nullable(),
  /** Month basis the tax was computed against; null in the last tax period. */
  monthBasis: monthBasisSchema.nullable(),
  priorPayslipIds: z
    .array(z.uuid())
    .max(1000)
    .refine(
      (ids) => ids.every((id, i) => i === 0 || ids[i - 1]! < id),
      "priorPayslipIds must be sorted and unique",
    ),
  /** Allocated rapels in the gross (0 = none); null when not reported. */
  rapelAllocationRevision: z.number().int().min(0).nullable(),
});
export type StoredRunResult = z.infer<typeof storedRunResultSchema>;

function resultBinding(tenantId: string, payslipId: string) {
  return {
    tenantId,
    table: "payroll_run_results",
    rowId: payslipId,
    field: "result",
  } as const;
}

/** Seals a result for its row (binding: tenant, table, payslip id, field). */
export function sealRunResult(
  tenantId: string,
  payslipId: string,
  result: StoredRunResult,
  keyVersion: number = PAYROLL_SEAL_KEY_VERSION,
): Buffer {
  return sealPayrollValue(
    JSON.stringify(storedRunResultSchema.parse(result)),
    resultBinding(tenantId, payslipId),
    keyVersion,
  );
}

/** Opens a stored result; throws (without echoing values) when unreadable. */
export function openRunResult(
  sealed: Buffer | Uint8Array,
  tenantId: string,
  payslipId: string,
  keyVersion: number,
): StoredRunResult {
  return storedRunResultSchema.parse(
    JSON.parse(
      openPayrollValue(sealed, resultBinding(tenantId, payslipId), keyVersion),
    ),
  );
}

// ---- Errors -----------------------------------------------------------------

const simulateUnsupported = () =>
  new HttpError(
    422,
    "PAYROLL_RUN_SIMULATE_UNSUPPORTED",
    "Payroll ini memuat jenis run, pinjaman, reimbursement, service charge, atau rapel yang belum didukung simulasi.",
  );

const runEmpty = () =>
  new HttpError(
    422,
    "PAYROLL_RUN_EMPTY",
    "Tidak ada karyawan yang masuk payroll ini.",
  );

/** Employee ids only: never a name or an amount. */
const inputMissing = (
  employeeIds: readonly string[],
  what = "Status PTKP belum diisi",
) =>
  new HttpError(
    422,
    "PAYROLL_SIMULATION_INPUT_MISSING",
    `${what} untuk karyawan: ${employeeIds.join(", ")}.`,
  );

/** Employee ids only: never a name or an amount. */
const taxSchemeMismatch = (employeeIds: readonly string[]) =>
  new HttpError(
    422,
    "PAYROLL_TAX_SCHEME_MISMATCH",
    `Skema pajak kontrak kerja tidak sama dengan skema pajak komponen gaji untuk karyawan: ${employeeIds.join(", ")}. Samakan skema pajak di kontrak kerja karyawan dengan skema pajak komponen gajinya (Pengaturan payroll, komponen), lalu simulasikan ulang.`,
  );

// ---- Helpers ----------------------------------------------------------------

const PPH21_TABLE_TYPES = ["ptkp", "pph21_ter", "pph21_annual"] as const;

/** Maps a stored `payroll_runs` row to the contract run (dates as ISO strings). */
function toRun(row: typeof payrollRuns.$inferSelect): PayrollRun {
  const iso = (value: Date | null) => (value ? value.toISOString() : null);
  const parsed = payrollRunSchema.safeParse({
    id: row.id,
    tenantId: row.tenantId,
    legalEntityId: row.legalEntityId,
    payrollPolicyId: row.payrollPolicyId,
    runType: row.runType,
    thrScheduleId: row.thrScheduleId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    payDate: row.payDate,
    status: row.status,
    simulationCount: row.simulationCount,
    lastSimulatedAt: iso(row.lastSimulatedAt),
    totals: row.totals,
    configSnapshot: row.configSnapshot,
    approvedByHr: row.approvedByHr,
    approvedByHrAt: iso(row.approvedByHrAt),
    approvedByFinance: row.approvedByFinance,
    approvedByFinanceAt: iso(row.approvedByFinanceAt),
    lockedBy: row.lockedBy,
    lockedAt: iso(row.lockedAt),
    paidBy: row.paidBy,
    paidAt: iso(row.paidAt),
    reversal: row.reversal,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  // Never echo the parse error: it may carry payroll values.
  if (!parsed.success) throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  return parsed.data;
}

/** Published statutory versions of the tenant (unreadable rows are skipped). */
async function loadPublishedStatutory(
  tx: Tx,
  tenantId: TenantId,
): Promise<StatutoryTableVersion[]> {
  const rows = await tx
    .select()
    .from(statutoryRates)
    .where(
      and(
        eq(statutoryRates.tenantId, tenantId),
        eq(statutoryRates.status, "published"),
      ),
    );
  const versions: StatutoryTableVersion[] = [];
  for (const row of rows) {
    const parsed = statutoryTableVersionSchema.safeParse({
      id: row.id,
      tenantId: row.tenantId,
      type: row.type,
      version: row.version,
      effectiveFrom: row.effectiveFrom,
      status: row.status,
      legalBasis: row.legalBasis,
      parameters: row.parameters,
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
      publishedBy: row.publishedBy,
      createdAt: row.createdAt.toISOString(),
    });
    // An unreadable row counts as missing: the in-force lookup then refuses.
    if (parsed.success) versions.push(parsed.data);
  }
  return versions;
}

/** Months at the employer in the pay date's tax year (fixtures.ts monthsWorkedIn). */
function monthsWorkedIn(joinDate: string, payDate: string): number {
  const joinYear = Number(joinDate.slice(0, 4));
  const joinMonth = Number(joinDate.slice(5, 7));
  const payYear = Number(payDate.slice(0, 4));
  const payMonth = Number(payDate.slice(5, 7));
  const months = joinYear < payYear ? payMonth : payMonth - joinMonth + 1;
  return Math.min(12, Math.max(1, months));
}

/** True when the period is exactly the 1st to the last day of one month. */
function isOneCalendarMonth(periodStart: string, periodEnd: string): boolean {
  if (periodStart.slice(0, 7) !== periodEnd.slice(0, 7)) return false;
  if (periodStart.slice(8, 10) !== "01") return false;
  const lastDay = new Date(
    Date.UTC(Number(periodEnd.slice(0, 4)), Number(periodEnd.slice(5, 7)), 0),
  ).getUTCDate();
  return Number(periodEnd.slice(8, 10)) === lastDay;
}

type ComponentFacts = {
  isActive: boolean;
  id: string;
  code: string;
  name: string;
  category: string;
  taxable: boolean;
  taxScheme: TaxScheme;
  bpjsBase: boolean;
  overtimeBase: boolean;
  thrBase: boolean;
  displayOrder: number;
};

// ---- Service ----------------------------------------------------------------

/**
 * Simulates a draft or simulated run inside the caller's tenant transaction
 * (see the header) and returns the updated run. Repeatable: each simulation
 * replaces the stored results.
 */
export async function simulatePayrollRunInTransaction(
  tx: Tx,
  context: ScopedTenantContext,
  actorUserId: string,
  payrollRunId: PayrollRunId,
  now = new Date(),
): Promise<PayrollRun> {
  const actor = await assertPayrollTenantCan(
    tx,
    context,
    actorUserId,
    "payroll.run",
  );
  const tenantId = context.tenant.tenantId;
  const runId = payrollRunIdSchema.parse(payrollRunId);

  // LOCK 1: month. LOCK 2: rapel components, employees, outlets. LOCK 3: run.
  const month = await lockPayrollRunMonth(tx, tenantId, runId);
  await lockRapelInputsForRun(tx, context, {
    runId,
    legalEntityId: month.legalEntityId,
    payDate: month.payDate,
  });
  const [row] = await tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)))
    .limit(1)
    .for("update");
  if (!row)
    throw new HttpError(
      404,
      "PAYROLL_RUN_NOT_FOUND",
      "Payroll tidak ditemukan.",
    );
  assertRunUnchanged(row, {
    legalEntityId: month.legalEntityId,
    payDate: month.payDate,
  });
  const run = toRun(row);
  if (run.status !== "draft" && run.status !== "simulated")
    throw new HttpError(
      409,
      "PAYROLL_RUN_INVALID_TRANSITION",
      "Payroll ini tidak bisa disimulasikan pada status sekarang.",
    );
  if (run.runType === "off_cycle") throw simulateUnsupported();
  const isThr = run.runType === "thr";

  // Policy, THR schedule, components, statutory tables.
  const [policyRow] = await tx
    .select()
    .from(payrollPolicies)
    .where(
      and(
        eq(payrollPolicies.tenantId, tenantId),
        eq(payrollPolicies.id, run.payrollPolicyId),
      ),
    )
    .limit(1);
  if (!policyRow) throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  const employmentTypes = employeeGroupSchema.parse(
    policyRow.employeeGroup,
  ).employmentTypes;
  const policyProgrammes = BPJS_TABLE_TYPES.filter((type) =>
    policyRow.bpjsProgrammes.includes(type),
  );

  let thrAsOfDate: BusinessDate | null = null;
  let thrEmployeeIds: ReadonlySet<string> | null = null;
  if (isThr) {
    if (run.thrScheduleId === null) throw simulateUnsupported();
    // Fail closed: the THR wage and tenure read one calendar month.
    if (!isOneCalendarMonth(run.periodStart, run.periodEnd))
      throw simulateUnsupported();
    const [schedule] = await tx
      .select({
        tenureAsOfDate: thrSchedules.tenureAsOfDate,
        employeeIds: thrSchedules.employeeIds,
      })
      .from(thrSchedules)
      .where(
        and(
          eq(thrSchedules.tenantId, tenantId),
          eq(thrSchedules.id, run.thrScheduleId),
        ),
      )
      .limit(1);
    if (!schedule) throw simulateUnsupported();
    thrAsOfDate = schedule.tenureAsOfDate as BusinessDate;
    thrEmployeeIds =
      schedule.employeeIds === null ? null : new Set(schedule.employeeIds);
  }

  const componentRows = await tx
    .select()
    .from(payComponents)
    .where(eq(payComponents.tenantId, tenantId))
    .orderBy(asc(payComponents.displayOrder), asc(payComponents.code));
  const components = new Map<string, ComponentFacts>();
  for (const c of componentRows)
    components.set(c.code, {
      isActive: c.isActive,
      id: c.id,
      code: c.code,
      name: c.name,
      category: c.category,
      taxable: c.taxable,
      taxScheme: taxSchemeSchema.parse(c.taxScheme),
      bpjsBase: c.bpjsBase,
      overtimeBase: c.overtimeBase,
      thrBase: c.thrBase,
      displayOrder: c.displayOrder,
    });
  // OPEN: lines without a tenant component (LEMBUR, RAPEL) are taxed under
  // the gross scheme (the employee bears the tax; never pays an allowance).
  const taxSchemeOf = (line: PayslipLine): TaxScheme =>
    components.get(line.componentCode)?.taxScheme ?? "gross";

  const programmes: readonly BpjsTableType[] = isThr ? [] : policyProgrammes;
  const tableTypes: StatutoryTableType[] = [
    ...PPH21_TABLE_TYPES,
    ...programmes,
    ...(isThr ? (["thr"] as const) : []),
  ];
  const published = await loadPublishedStatutory(tx, tenantId);
  const inForce = statutoryVersionsForRun(
    { status: "draft", payDate: run.payDate, configSnapshot: null },
    published,
    PPH21_TABLE_TYPES,
  );
  const ptkp = inForce.get("ptkp");
  const ter = inForce.get("pph21_ter");
  const annual = inForce.get("pph21_annual");
  if (
    ptkp?.type !== "ptkp" ||
    ter?.type !== "pph21_ter" ||
    annual?.type !== "pph21_annual"
  )
    throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  const tables: Pph21Tables = {
    ptkp: ptkp.parameters,
    ter: ter.parameters,
    annual: annual.parameters,
  };
  const captured = captureStatutoryForLock({
    tables: published,
    payDate: run.payDate,
    types: tableTypes,
  });

  // Population (decided O7, see header), ordered by id.
  const memberRows = await tx
    .select({
      id: employees.id,
      employeeNo: employees.employeeNo,
      fullName: employees.fullName,
      positionName: positions.name,
      homeOutletId: employees.homeOutletId,
      joinDate: employees.joinDate,
      endDate: employees.endDate,
      ptkpStatus: employees.ptkpStatus,
      npwpHmac: employees.npwpHmac,
      nikHmac: employees.nikHmac,
      bankAccountHmac: employees.bankAccountHmac,
    })
    .from(employees)
    .innerJoin(
      outlets,
      and(
        eq(outlets.tenantId, employees.tenantId),
        eq(outlets.id, employees.homeOutletId),
      ),
    )
    .leftJoin(
      positions,
      and(
        eq(positions.tenantId, employees.tenantId),
        eq(positions.id, employees.positionId),
      ),
    )
    .where(
      and(
        eq(employees.tenantId, tenantId),
        sql`COALESCE(${employees.legalEntityId}, ${outlets.legalEntityId}) = ${run.legalEntityId}`,
        inArray(employees.employmentType, [...employmentTypes]),
        lte(employees.joinDate, run.periodEnd),
        or(isNull(employees.endDate), gte(employees.endDate, run.periodStart)),
      ),
    )
    .orderBy(asc(employees.id));
  const listed = thrEmployeeIds;
  const candidates =
    listed === null ? memberRows : memberRows.filter((m) => listed.has(m.id));

  const allocations = await loadRunRapelAllocations(tx, context, runId);

  // Gross per employee (RAPEL lines included), then BPJS / THR in one call.
  const grossById = new Map<
    string,
    {
      payslipId: PayslipId;
      earnings: PayslipLine[];
      deductions: PayslipLine[];
      netIdr: Idr;
      rapelAllocationRevision: number | null;
    }
  >();
  const statutoryEmployees: PayrollRunStatutoryEmployee[] = [];
  for (const member of candidates) {
    const payslipId =
      allocations.get(member.id)?.reservedPayslipId ??
      payslipIdSchema.parse(randomUUID());
    const gross = await computeEmployeeGrossInTransaction(
      tx,
      context,
      actorUserId,
      {
        employeeId: member.id,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        payslipId,
        // Rapel allocates only to regular runs; the rapel loader refuses any
        // other run type, so a THR run reads no RAPEL lines.
        ...(run.runType === "regular" ? { payrollRunId: runId } : {}),
      },
    );
    // Only the loan writer may produce a loan line (design D5): a tenant
    // component of that category would have no loan behind it.
    if (gross.lines.some((l) => l.category === "loan_installment"))
      throw simulateUnsupported();
    const earnings = gross.lines.filter((l) => l.kind === "earning");
    const sumFlag = (flag: "bpjsBase" | "thrBase") =>
      sumIdr(
        earnings
          .filter((l) => components.get(l.componentCode)?.[flag] === true)
          .map((l) => l.amountIdr),
      );
    grossById.set(member.id, {
      payslipId,
      earnings,
      deductions: gross.lines.filter((l) => l.kind === "deduction"),
      netIdr: gross.netIdr,
      rapelAllocationRevision: gross.rapelAllocationRevision ?? null,
    });
    statutoryEmployees.push({
      employeeId: member.id,
      joinDate: member.joinDate as BusinessDate,
      bpjsWageBaseIdr: sumFlag("bpjsBase"),
      // OPEN: one month of THR wage = the thrBase lines of this run's period.
      thrWageIdr: sumFlag("thrBase"),
      payableWageIdr: gross.netIdr,
      jkkRiskClass: jkkRiskClassSchema.parse(policyRow.jkkRiskClass),
      bpjsProgrammes: programmes,
    });
  }
  const statutory = calculatePayrollRunStatutory({
    run: { status: "draft", payDate: run.payDate, configSnapshot: null },
    tables: published,
    employees: statutoryEmployees,
    thrAsOfDate,
  });
  const statutoryById = new Map(
    statutory.lines.map((line) => [line.employeeId, line]),
  );

  // THR runs pay only the THR (plus any rapel allocated to the run): never
  // the month's salary a second time, and no BPJS on THR.
  const thrComponent = [...components.values()].find(
    (c) => c.category === "thr" && c.isActive,
  );
  const population = candidates.filter((member) => {
    if (!isThr) return true;
    const thr = statutoryById.get(member.id)?.thr;
    return thr !== null && thr !== undefined && thr.amountIdr > 0;
  });
  // A rapel allocated to this run for someone outside it would stay unpaid.
  const inPopulation = new Set(population.map((m) => m.id));
  for (const employeeId of allocations.keys())
    if (!inPopulation.has(employeeId)) throw simulateUnsupported();
  if (population.length === 0) throw runEmpty();

  const missing = population
    .filter((m) => m.ptkpStatus === null)
    .map((m) => m.id);
  if (missing.length > 0) throw inputMissing(missing);

  // The contract's PPh 21 scheme: the latest non-draft agreement that started
  // on or before the pay date (pay with no taxable line follows it).
  const contractRows = await tx
    .select({
      employeeId: employmentContracts.employeeId,
      taxScheme: employmentContracts.taxScheme,
    })
    .from(employmentContracts)
    .where(
      and(
        eq(employmentContracts.tenantId, tenantId),
        inArray(
          employmentContracts.employeeId,
          population.map((m) => m.id),
        ),
        lte(employmentContracts.startDate, run.payDate),
        sql`${employmentContracts.status} <> 'draft'`,
      ),
    )
    .orderBy(desc(employmentContracts.startDate), desc(employmentContracts.id));
  const contractSchemeById = new Map<string, TaxScheme>();
  for (const row of contractRows)
    if (!contractSchemeById.has(row.employeeId))
      contractSchemeById.set(row.employeeId, row.taxScheme);
  const noContract = population
    .filter((m) => !contractSchemeById.has(m.id))
    .map((m) => m.id);
  if (noContract.length > 0)
    throw inputMissing(noContract, "Kontrak kerja belum ada");

  // Fail closed (founder Q9 + CTO, 13 Nov 2026): a THR run follows the contract
  // scheme, the monthly pay follows the component scheme. When they differ the
  // company would bear the THR tax but not the salary tax (or the reverse), so
  // the run is refused instead of guessing. Ids only: never a name or amount.
  if (isThr) {
    const mismatched = population
      .filter((m) => {
        const contractScheme = contractSchemeById.get(m.id)!;
        return grossById
          .get(m.id)!
          .earnings.some(
            (l) =>
              l.taxable &&
              components.get(l.componentCode)?.thrBase === true &&
              taxSchemeOf(l) !== contractScheme,
          );
      })
      .map((m) => m.id);
    if (mismatched.length > 0) throw taxSchemeMismatch(mismatched);
  }

  // Open PPh 21 receivable to collect on this run's payslips (fail closed on
  // unreadable or inconsistent earlier payslips).
  const receivableBalances = await loadPph21ReceivableBalances(
    tx,
    {
      tenantId,
      legalEntityId: run.legalEntityId,
      runId,
      payDate: run.payDate,
      employeeIds: population.map((m) => m.id),
    },
    simulateUnsupported,
  );
  const openReceivableById = receivableBalances.open;

  const lastTaxPeriodOf = (endDate: string | null) =>
    run.payDate.slice(5, 7) === "12" ||
    (endDate !== null && endDate.slice(0, 7) <= run.payDate.slice(0, 7));
  const priors = await loadTaxYearPriors(
    tx,
    tenantId,
    runId,
    population.map((m) => ({
      employeeId: m.id,
      joinDate: m.joinDate as BusinessDate,
      lastTaxPeriod: lastTaxPeriodOf(m.endDate),
    })),
  );

  // Kasbon (legend-8tfvr): only regular runs deduct loans. Loans lock after
  // the priors (design §2); no policy row means bp 0, so nothing is deducted.
  const [loanPolicy] = await tx
    .select({ bp: payrollLoanPolicies.maxDeductionOfNetPayBp })
    .from(payrollLoanPolicies)
    .where(eq(payrollLoanPolicies.tenantId, tenantId))
    .limit(1);
  const loansByEmployee = isThr
    ? new Map<string, PlannableLoan[]>()
    : await lockLoansForRunSimulation(tx, tenantId, {
        runId,
        employeeIds: population.map((m) => m.id),
        periodEnd: run.periodEnd,
      });

  type Prepared = {
    member: (typeof population)[number];
    payslipId: PayslipId;
    earnings: PayslipLine[];
    deductions: PayslipLine[];
    bpjs: ReturnType<typeof bpjsLinesOf>;
    taxInput: z.infer<typeof storedTaxInputSchema>;
    priorPayslipIds: string[];
    rapelAllocationRevision: number | null;
    paymentMethod: PayslipPaymentMethod;
  };
  const prepared: Prepared[] = [];
  const taxEmployees: PayrollRunTaxEmployee[] = [];
  for (const member of population) {
    const gross = grossById.get(member.id)!;
    const statutoryLine = statutoryById.get(member.id)!;
    let earnings = gross.earnings;
    let deductions = gross.deductions;
    let bpjs = bpjsLinesOf(statutoryLine.contributions);
    if (isThr) {
      const thrIdr = statutoryLine.thr!.amountIdr;
      // OPEN: tenant without a THR component gets a taxable "THR" line.
      const thrLine = payslipLineSchema.parse({
        componentCode: thrComponent?.code ?? "THR",
        name: thrComponent?.name ?? "THR",
        category: "thr",
        kind: "earning",
        amountIdr: thrIdr,
        taxable: thrComponent?.taxable ?? true,
        quantity: null,
        sourceId: null,
      });
      earnings = [
        thrLine,
        ...gross.earnings.filter((l) => l.componentCode === "RAPEL"),
      ];
      deductions = [];
      bpjs = [];
    }
    const facts = payslipTaxFactsOf({
      earnings,
      grossDeductions: deductions,
      bpjs,
      // THR runs only (a THR-category line in a regular run keeps its
      // component scheme). Founder Q9 (13 Nov 2026, legend-x7jas): the THR tax follows the
      // employee's contract scheme. Only a gross_up employee gets the company
      // paid tax allowance; every other scheme (net, gross, or a tenant THR
      // component set to gross_up/net) is withheld from the THR (never pays
      // more than the rule, the outlet bears no tax of a non-gross-up employee).
      taxSchemeOf: (line) =>
        isThr && line.category === "thr"
          ? contractSchemeById.get(member.id) === "gross_up"
            ? "gross_up"
            : "gross"
          : taxSchemeOf(line),
    });
    const taxInput = storedTaxInputSchema.parse({
      ptkpStatus: member.ptkpStatus,
      hasTaxId: member.npwpHmac !== null || member.nikHmac !== null,
      lastTaxPeriod: lastTaxPeriodOf(member.endDate),
      monthsWorked: monthsWorkedIn(member.joinDate, run.payDate),
      // Decided O8: always false (see header).
      partialYearTaxSubject: false,
      earnings: facts.earnings,
      employerBenefitIdr: facts.employerBenefitIdr,
      contractTaxScheme: contractSchemeById.get(member.id)!,
      employeeDeductibleIdr: facts.employeeDeductibleIdr,
      employeeWithholdingCapIdr: facts.employeeWithholdingCapIdr,
    });
    const prior = priors.get(member.id) ?? {
      periods: [],
      lastPeriodEarlier: [],
      payslipIds: [],
      runIds: [],
    };
    taxEmployees.push({
      ...taxInput,
      employeeId: member.id,
      priorPeriods: prior.periods,
      lastPeriodEarlier: prior.lastPeriodEarlier,
    });
    prepared.push({
      member,
      payslipId: gross.payslipId,
      earnings,
      deductions,
      bpjs,
      taxInput,
      priorPayslipIds: [...new Set(prior.payslipIds)].sort(),
      rapelAllocationRevision: gross.rapelAllocationRevision,
      // OPEN O1.
      paymentMethod: member.bankAccountHmac !== null ? "bank_transfer" : "cash",
    });
  }

  const tax = await calculatePayrollRunTax(
    context,
    {
      run: { status: run.status, payDate: run.payDate, configSnapshot: null },
      tables,
      employees: taxEmployees,
      monthScope: { runId },
    },
    tx,
  );
  const taxById = new Map(tax.payslips.map((p) => [p.employeeId, p]));

  const results: { entry: Prepared; stored: StoredRunResult }[] = [];
  for (const entry of prepared) {
    const computed = taxById.get(entry.member.id);
    if (!computed) throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
    const calculation: PayslipCalculation = composePayslipCalculation({
      employee: {
        employeeId: employeeIdSchema.parse(entry.member.id),
        employeeNo: entry.member.employeeNo,
        employeeName: entry.member.fullName,
        positionName: entry.member.positionName ?? null,
        outletId: outletIdSchema.parse(entry.member.homeOutletId),
      },
      period: {
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        payDate: run.payDate,
      },
      earnings: entry.earnings,
      grossDeductions: entry.deductions,
      bpjs: entry.bpjs,
      tax: computed.tax,
      paymentMethod: entry.paymentMethod,
      openReceivableIdr: openReceivableById.get(entry.member.id) ?? 0,
      totalOpenReceivableIdr:
        receivableBalances.total.get(entry.member.id) ?? 0,
      loans: loansByEmployee.get(entry.member.id) ?? [],
      loanMaxDeductionOfNetPayBp: loanPolicy?.bp ?? 0,
    });
    results.push({
      entry,
      stored: storedRunResultSchema.parse({
        calculation,
        joinDate: entry.member.joinDate,
        endDate: entry.member.endDate ?? null,
        taxInput: entry.taxInput,
        monthBasis: computed.monthBasis ?? null,
        priorPayslipIds: entry.priorPayslipIds,
        rapelAllocationRevision: entry.rapelAllocationRevision,
      }),
    });
  }

  const totals = sumPayrollRunTotals(results.map((r) => r.stored.calculation));
  // Side effects simulate does not compose: refuse, never pay more.
  if (totals.reimbursementIdr > 0 || totals.serviceChargeIdr > 0)
    throw simulateUnsupported();

  const at = isoDateTimeSchema.parse(now.toISOString());
  const snapshot = payrollConfigSnapshotSchema.safeParse({
    statutoryVersions: captured.statutoryVersions,
    policy: {
      id: policyRow.id,
      cycle: policyRow.cycle,
      payDateAdjustment: policyRow.payDateAdjustment,
      jkkRiskClass: policyRow.jkkRiskClass,
      bpjsProgrammes: policyProgrammes,
    },
    // Line flags above read every component; the snapshot keeps the active ones.
    components: [...components.values()]
      .filter((c) => c.isActive)
      .map((c) => ({
        id: c.id,
        code: c.code,
        category: c.category,
        taxable: c.taxable,
        taxScheme: c.taxScheme,
        bpjsBase: c.bpjsBase,
        overtimeBase: c.overtimeBase,
        thrBase: c.thrBase,
      })),
    // The policy share of net pay kasbon may take; 0 (no policy) = none.
    loanMaxDeductionOfNetPayBp: loanPolicy?.bp ?? 0,
    pph21Policy: tax.pph21Policy,
    capturedAt: at,
  });
  if (!snapshot.success) throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");

  const next = applyPayrollRunCommand(run, {
    action: "simulate",
    at,
    totals,
    configSnapshot: snapshot.data,
  });

  // Writes: run first (the results trigger checks simulation_no against it).
  const [updated] = await tx
    .update(payrollRuns)
    .set({
      status: next.status,
      simulationCount: next.simulationCount,
      lastSimulatedAt: now,
      totals: next.totals,
      configSnapshot: next.configSnapshot,
      updatedAt: now,
    })
    .where(and(eq(payrollRuns.tenantId, tenantId), eq(payrollRuns.id, runId)))
    .returning();
  if (!updated) throw new Error("Payroll run was not updated");
  await tx
    .delete(payrollRunResults)
    .where(
      and(
        eq(payrollRunResults.tenantId, tenantId),
        eq(payrollRunResults.payrollRunId, runId),
      ),
    );
  await tx.insert(payrollRunResults).values(
    results.map(({ entry, stored }) => ({
      tenantId,
      payrollRunId: runId,
      employeeId: employeeIdSchema.parse(entry.member.id),
      payslipId: entry.payslipId,
      simulationNo: next.simulationCount,
      paymentMethod: entry.paymentMethod,
      resultEncrypted: sealRunResult(tenantId, entry.payslipId, stored),
      piiKeyVersion: PAYROLL_SEAL_KEY_VERSION,
      createdAt: now,
    })),
  );
  // One kasbon row per LOAN line (a reservation until the run locks).
  await replaceRunLoanDeductions(
    tx,
    tenantId,
    runId,
    results.flatMap(({ entry, stored }) =>
      stored.calculation.lines
        .filter((l) => l.category === "loan_installment")
        .map((l) => ({
          employeeId: employeeIdSchema.parse(entry.member.id),
          loanId: l.sourceId as EmployeeLoanId,
          amountIdr: l.amountIdr,
        })),
    ),
  );

  await recordAudit(
    tx,
    context,
    {
      id: createUlid(now.getTime()),
      tenantId,
      outletId: null,
      actorType: "user",
      actorId: actor,
      deviceId: null,
      action: "payroll.run.simulated",
      objectType: "payroll_run",
      objectId: runId,
      reason: null,
      maskedChanges: {
        before: null,
        after: {
          employeeCount: results.length,
          simulationCount: next.simulationCount,
        },
      },
      ipHash: null,
      sensitiveAccess: false,
      retentionClass: "audit_2y",
      createdAt: now.toISOString(),
    },
    ["employeeCount", "simulationCount"],
  );

  return toRun(updated);
}
