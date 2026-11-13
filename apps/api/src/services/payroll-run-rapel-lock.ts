// Rapel inputs of the general payroll run lock (simulate and lock). The month
// advisory lock is taken by the caller first (design 0.4); these helpers add
// the component locks, the rapel allocation read and the result check.
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  type BusinessDate,
  type Idr,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import type { PayrollRunId, PayslipId } from "@starter/shared/hris/payroll";
import { employees } from "../db/schema/hris.ts";
import { employeePayComponents } from "../db/schema/payroll.ts";
import {
  payrollRapelFinalizations,
  payrollRapels,
} from "../db/schema/payroll-rapel.ts";
import { outlets } from "../db/schema/platform-org.ts";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./hris-access.ts";
import { toDto } from "./payroll-rapel.service.ts";

export type RunRapelAllocation = {
  reservedPayslipId: PayslipId;
  revision: number;
  lines: { sourceId: string; amountIdr: Idr }[];
};

const resultStale = () =>
  new HttpError(
    409,
    "PAYROLL_RUN_RESULT_STALE",
    "Alokasi rapel berubah sejak simulasi. Simulasikan ulang sebelum mengunci.",
  );

const runMismatch = () =>
  new HttpError(
    409,
    "PAYROLL_PPH21_RUN_MISMATCH",
    "Tanggal bayar atau badan hukum payroll tidak sesuai dengan data payroll yang tersimpan.",
  );

/**
 * Call after the run row `FOR UPDATE`: the legal entity and pay date must still
 * be the ones `lockPayrollRunMonth` locked the month for, else 409
 * PAYROLL_PPH21_RUN_MISMATCH (the run was edited while waiting for the lock).
 */
export function assertRunUnchanged(
  runRow: { legalEntityId: string; payDate: string },
  expected: { legalEntityId: string; payDate: string },
): void {
  if (
    runRow.legalEntityId !== expected.legalEntityId ||
    runRow.payDate !== expected.payDate
  )
    throw runMismatch();
}

/**
 * Component advisory locks (same key as the rapel finalize) for the employees
 * that have a rapel allocated to this run, taken in one statement ordered by
 * employee then component. Then those employees and their outlets FOR SHARE,
 * sorted. `run` comes from `lockPayrollRunMonth`. Call it after the month lock
 * and before the run row lock.
 */
export async function lockRapelInputsForRun(
  tx: Tx,
  context: ScopedTenantContext,
  run: { runId: PayrollRunId; legalEntityId: string; payDate: BusinessDate },
): Promise<void> {
  const tenantId = context.tenant.tenantId;
  const allocatedEmployees = tx
    .select({ employeeId: payrollRapels.employeeId })
    .from(payrollRapels)
    .where(
      and(
        eq(payrollRapels.tenantId, tenantId),
        eq(payrollRapels.payrollRunId, run.runId),
        eq(payrollRapels.status, "allocated"),
      ),
    );
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      'payroll:emp-component:' || ${tenantId}::text || ':' || pairs.employee_id::text || ':' || pairs.component_id::text, 0))
    FROM (
      SELECT DISTINCT ${employeePayComponents.employeeId} AS employee_id,
        ${employeePayComponents.componentId} AS component_id
      FROM ${employeePayComponents}
      WHERE ${employeePayComponents.tenantId} = ${tenantId}
        AND ${employeePayComponents.employeeId} IN (
          SELECT ${payrollRapels.employeeId} FROM ${payrollRapels}
          WHERE ${payrollRapels.tenantId} = ${tenantId}
            AND ${payrollRapels.payrollRunId} = ${run.runId}
            AND ${payrollRapels.status} = 'allocated')
      ORDER BY employee_id, component_id
    ) AS pairs`);
  const members = await tx
    .select({ id: employees.id, homeOutletId: employees.homeOutletId })
    .from(employees)
    .where(
      and(
        eq(employees.tenantId, tenantId),
        inArray(employees.id, allocatedEmployees),
      ),
    )
    .orderBy(asc(employees.id))
    .for("share");
  const outletIds = [
    ...new Set(members.map((member) => member.homeOutletId)),
  ].sort();
  if (outletIds.length)
    await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(eq(outlets.tenantId, tenantId), inArray(outlets.id, outletIds)),
      )
      .orderBy(asc(outlets.id))
      .for("share");
}

/**
 * Every employee with an allocated rapel in this run must have a stored result,
 * else the rapel would be left unpaid. 409 PAYROLL_RUN_RESULT_STALE.
 */
export function assertAllAllocationsCovered(
  allocations: ReadonlyMap<string, RunRapelAllocation>,
  resultEmployeeIds: ReadonlySet<string>,
): void {
  for (const employeeId of allocations.keys())
    if (!resultEmployeeIds.has(employeeId)) throw resultStale();
}

/**
 * The allocated rapels of the run, grouped by employee. Revision is the number
 * of allocated rapels (the same count the gross calculation reports). A split
 * reserved payslip id inside one employee fails closed with 409 STALE.
 */
export async function loadRunRapelAllocations(
  tx: Tx,
  context: ScopedTenantContext,
  runId: PayrollRunId,
): Promise<Map<string, RunRapelAllocation>> {
  const tenantId = context.tenant.tenantId;
  const rows = await tx
    .select()
    .from(payrollRapels)
    .where(
      and(
        eq(payrollRapels.tenantId, tenantId),
        eq(payrollRapels.payrollRunId, runId),
        eq(payrollRapels.status, "allocated"),
      ),
    )
    .orderBy(asc(payrollRapels.employeeId), asc(payrollRapels.id));
  const result = new Map<string, RunRapelAllocation>();
  for (const row of rows) {
    if (!row.reservedPayslipId) throw resultStale();
    const dto = await toDto(tx, context, row);
    const entry = result.get(row.employeeId) ?? {
      reservedPayslipId: row.reservedPayslipId as PayslipId,
      revision: 0,
      lines: [],
    };
    if (entry.reservedPayslipId !== row.reservedPayslipId) throw resultStale();
    entry.revision += 1;
    entry.lines.push({ sourceId: row.id, amountIdr: dto.totalIdr });
    result.set(row.employeeId, entry);
  }
  return result;
}

/**
 * The stored simulation result must match the live allocations exactly: same
 * reserved payslip id, same revision, same multiset of RAPEL lines. An employee
 * without an allocation must carry no RAPEL line. Else 409 STALE.
 */
export function assertRapelResultMatches(
  allocation: RunRapelAllocation | undefined,
  result: {
    payslipId: string;
    rapelAllocationRevision: number | null | undefined;
    calculation: {
      lines: readonly {
        componentCode: string;
        sourceId: string | null;
        amountIdr: number;
      }[];
    };
  },
): void {
  const stored = result.calculation.lines
    .filter((line) => line.componentCode === "RAPEL")
    .map((line) => `${line.sourceId ?? ""}:${line.amountIdr}`)
    .sort();
  if (!allocation) {
    if (stored.length || (result.rapelAllocationRevision ?? 0) !== 0)
      throw resultStale();
    return;
  }
  const expected = allocation.lines
    .map((line) => `${line.sourceId}:${line.amountIdr}`)
    .sort();
  if (
    result.payslipId !== allocation.reservedPayslipId ||
    result.rapelAllocationRevision !== allocation.revision ||
    stored.length !== expected.length ||
    stored.some((entry, index) => entry !== expected[index])
  )
    throw resultStale();
}

/**
 * The finalization receipt the DB v1 rapel guard requires in the same
 * transaction as the payslip INSERT. Call it after the run status is `locked`
 * and before the payslip insert, in the same tx. `sealed` is the exact ciphertext the
 * payslip row stores; its sha256 is the receipt digest.
 */
export async function insertRapelReceipt(
  tx: Tx,
  tenantId: TenantId,
  input: {
    payslipId: PayslipId;
    employeeId: string;
    runId: PayrollRunId;
    revision: number;
    sealed: Buffer;
    keyVersion: number;
    actorId: string;
    now: Date;
  },
): Promise<void> {
  await tx.insert(payrollRapelFinalizations).values({
    tenantId,
    payslipId: input.payslipId,
    employeeId: input.employeeId,
    payrollRunId: input.runId,
    allocationRevision: input.revision,
    calculationSha256: createHash("sha256").update(input.sealed).digest("hex"),
    piiKeyVersion: input.keyVersion,
    createdBy: input.actorId,
    createdAt: input.now,
  });
}
