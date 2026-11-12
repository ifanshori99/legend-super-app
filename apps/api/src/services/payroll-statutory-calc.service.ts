// BPJS and THR step of a payroll run (bead legend-sko14; PRD v1.7 §3 D.30
// "BPJS: batas upah, porsi perusahaan maupun karyawan" and "THR by masa
// kerja"; PAYR-02). Pure: no database. The caller loads the tenant's
// statutory table versions and the run facts and passes them in; the run
// service stores the lines and, at lock, the snapshot from
// `captureStatutoryForLock`.
//
// Versions: before lock the published version in force on the pay date, from
// lock on exactly the pinned versions (`statutoryVersionsForRun`). A pinned
// version whose parameters no longer hash to the snapshot's
// `statutoryParametersHash` is refused (PAYROLL_SNAPSHOT_MISMATCH).
//
// Money rules (tier K): the employee's BPJS deduction never exceeds
// `payableWageIdr`; when it would, the employee shares are cut down in
// programme order and the employer shares stay (the company still owes
// them). THR never exceeds `thrWageIdr`.
//
// `payableWageIdr` MUST be the employee's `netIdr` from `computeEmployeeGross`
// (the wage left after the gross's own deductions), NOT the gross: capping
// against gross would let the BPJS deduction take more than the employee is
// actually paid. Each `employeeId` may appear only once in `employees`
// (a duplicate is refused with a RangeError).

import { idr, type BusinessDate, type Idr } from "@starter/shared/core";
import {
  BPJS_TABLE_TYPES,
  PayrollError,
  bpjsRateOf,
  canonicalJson,
  computeBpjsContribution,
  computeThr,
  isPayrollRunFrozen,
  sha256Hex,
  statutoryVersionRef,
  statutoryVersionsForRun,
  type BpjsContribution,
  type BpjsTableType,
  type JkkRiskClass,
  type PayrollConfigSnapshot,
  type PayrollRunStatus,
  type StatutoryTableType,
  type StatutoryTableVersion,
  type StatutoryTableVersionOf,
  type StatutoryVersionRef,
} from "@starter/shared/hris/payroll";

export type StatutorySnapshot = {
  statutoryVersions: StatutoryVersionRef[];
  statutoryParametersHash: string;
};

export type PayrollRunStatutoryRun = {
  status: PayrollRunStatus;
  payDate: BusinessDate;
  configSnapshot:
    | (Pick<PayrollConfigSnapshot, "statutoryVersions"> & {
        statutoryParametersHash: string;
      })
    | null;
};

export type PayrollRunStatutoryEmployee = {
  employeeId: string;
  joinDate: BusinessDate;
  /** Sum of the employee's bpjsBase components. */
  bpjsWageBaseIdr: Idr;
  /** Sum of the employee's thrBase components (one month of THR wage). */
  thrWageIdr: Idr;
  /** Wage left to take the BPJS deduction from (the deduction cap). */
  payableWageIdr: Idr;
  jkkRiskClass: JkkRiskClass | null;
  bpjsProgrammes: readonly BpjsTableType[];
};

export type PayrollRunStatutoryLine = {
  employeeId: string;
  contributions: BpjsContribution[];
  employerBpjsIdr: Idr;
  /** After the cap; never above `payableWageIdr`. */
  employeeBpjsDeductionIdr: Idr;
  deductionCapped: boolean;
  thr: { tenureMonths: number; amountIdr: Idr } | null;
};

export type PayrollRunStatutoryInput = {
  run: PayrollRunStatutoryRun;
  tables: readonly StatutoryTableVersion[];
  employees: readonly PayrollRunStatutoryEmployee[];
  /** THR reference date; null = this run computes no THR. */
  thrAsOfDate: BusinessDate | null;
};

const byType = (a: { type: string }, b: { type: string }) =>
  a.type < b.type ? -1 : a.type > b.type ? 1 : 0;

/** sha-256 over the pinned versions' identity and parameters, type order. */
function parametersHash(versions: readonly StatutoryTableVersion[]): string {
  return sha256Hex(
    canonicalJson(
      [...versions].sort(byType).map((version) => ({
        type: version.type,
        versionId: version.id,
        version: version.version,
        effectiveFrom: version.effectiveFrom,
        parameters: version.parameters,
      })),
    ),
  );
}

function refsOf(
  versions: ReadonlyMap<StatutoryTableType, StatutoryTableVersion>,
): StatutoryVersionRef[] {
  return [...versions.values()].map(statutoryVersionRef).sort(byType);
}

/**
 * Pins, by id, the published version of each type in force on the pay date,
 * with a hash of their parameters. The run service stores the refs in
 * `config_snapshot.statutoryVersions` and the hash next to them.
 */
export function captureStatutoryForLock(input: {
  tables: readonly StatutoryTableVersion[];
  payDate: BusinessDate;
  types: readonly StatutoryTableType[];
}): StatutorySnapshot {
  const versions = statutoryVersionsForRun(
    { status: "draft", payDate: input.payDate, configSnapshot: null },
    input.tables,
    [...new Set(input.types)],
  );
  return {
    statutoryVersions: refsOf(versions),
    statutoryParametersHash: parametersHash([...versions.values()]),
  };
}

function assertWage(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("Wage must be a non-negative whole rupiah amount");
}

/** Employee shares cut, in programme order, to fit within `payable`. */
function capEmployeeShares(
  contributions: readonly BpjsContribution[],
  payable: Idr,
): { contributions: BpjsContribution[]; total: Idr; capped: boolean } {
  const uncapped = contributions.reduce((sum, c) => sum + c.employeeIdr, 0);
  if (uncapped <= payable)
    return {
      contributions: [...contributions],
      total: idr(uncapped),
      capped: false,
    };
  let remaining: number = payable;
  const cut = contributions.map((c) => {
    const employeeIdr = idr(Math.min(c.employeeIdr, remaining));
    remaining -= employeeIdr;
    return { ...c, employeeIdr };
  });
  return { contributions: cut, total: payable, capped: true };
}

/**
 * BPJS (both shares per programme) and, when `thrAsOfDate` is given, THR for
 * every employee of a run, with the table versions the run is entitled to.
 */
export function calculatePayrollRunStatutory(input: PayrollRunStatutoryInput): {
  statutoryVersions: StatutoryVersionRef[];
  statutoryParametersHash: string;
  lines: PayrollRunStatutoryLine[];
} {
  const { run, tables, employees, thrAsOfDate } = input;
  const seenEmployeeIds = new Set<string>();
  for (const employee of employees) {
    if (seenEmployeeIds.has(employee.employeeId))
      throw new RangeError(
        `Duplicate employeeId in payroll run: ${employee.employeeId}`,
      );
    seenEmployeeIds.add(employee.employeeId);
    assertWage(employee.bpjsWageBaseIdr);
    assertWage(employee.thrWageIdr);
    assertWage(employee.payableWageIdr);
  }

  const needed = new Set<StatutoryTableType>();
  for (const employee of employees)
    for (const programme of employee.bpjsProgrammes) needed.add(programme);
  if (thrAsOfDate !== null) needed.add("thr");

  const frozen = isPayrollRunFrozen(run.status);
  if (frozen && run.configSnapshot === null)
    throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  const versions = statutoryVersionsForRun(run, tables, [...needed]);
  let parametersHashOfRun: string;
  if (!frozen || run.configSnapshot === null) {
    parametersHashOfRun = parametersHash([...versions.values()]);
  } else {
    // Frozen run: the hash covers every version the snapshot pinned, so all
    // of them must still be there and unchanged, used by this run or not.
    const pinned = statutoryVersionsForRun(
      run,
      tables,
      run.configSnapshot.statutoryVersions.map((ref) => ref.type),
    );
    if (
      parametersHash([...pinned.values()]) !==
      run.configSnapshot.statutoryParametersHash
    )
      throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
    parametersHashOfRun = run.configSnapshot.statutoryParametersHash;
  }

  const thrVersion =
    thrAsOfDate === null
      ? null
      : (versions.get("thr") as StatutoryTableVersionOf<"thr">);

  const lines = employees.map((employee): PayrollRunStatutoryLine => {
    const programmes = BPJS_TABLE_TYPES.filter((type) =>
      employee.bpjsProgrammes.includes(type),
    );
    const contributions = programmes.map((type) => {
      const version = versions.get(
        type,
      ) as StatutoryTableVersionOf<BpjsTableType>;
      return computeBpjsContribution(
        bpjsRateOf(version, employee.jkkRiskClass),
        employee.bpjsWageBaseIdr,
      );
    });
    const capped = capEmployeeShares(contributions, employee.payableWageIdr);
    const employerBpjsIdr = idr(
      contributions.reduce((sum, c) => sum + c.employerIdr, 0),
    );

    let thr: PayrollRunStatutoryLine["thr"] = null;
    if (thrVersion !== null && thrAsOfDate !== null) {
      const result = computeThr(thrVersion.parameters, {
        joinDate: employee.joinDate,
        asOfDate: thrAsOfDate,
        thrWageIdr: employee.thrWageIdr,
      });
      thr = {
        tenureMonths: result.tenureMonths,
        amountIdr: idr(Math.min(result.amountIdr, employee.thrWageIdr)),
      };
    }

    return {
      employeeId: employee.employeeId,
      contributions: capped.contributions,
      employerBpjsIdr,
      employeeBpjsDeductionIdr: capped.total,
      deductionCapped: capped.capped,
      thr,
    };
  });

  return {
    statutoryVersions: refsOf(versions),
    statutoryParametersHash: parametersHashOfRun,
    lines,
  };
}
