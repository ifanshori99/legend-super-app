// Run-level BPJS and THR calculation with versioned statutory tables (bead
// legend-sko14; PRD v1.7 §3 D.30 "BPJS: batas upah, porsi perusahaan maupun
// karyawan" and "THR by masa kerja"; PAYR-02: a locked run keeps the table
// versions it was calculated with). FAIL-FIRST: the service
// `payroll-statutory-calc.service.ts` does not exist yet.
//
// Money rules under test (tier K, "jangan sampai rugi"):
//   - the employee's BPJS deduction never exceeds the wage it is taken from;
//   - THR never exceeds the employee's THR wage (one month of THR wage);
//   - the rates a run was locked with never change when a newer version is
//     published, and a tampered or missing pinned version fails closed.
//
// Service contract chosen for this test (the brief lets the test decide the
// names; both functions are PURE, no database, same inputs -> same output):
//
//   captureStatutoryForLock({ tables, payDate, types })
//     -> { statutoryVersions: StatutoryVersionRef[], statutoryParametersHash }
//        Pins, by id, the published version of each type in force on payDate,
//        plus a sha-256 hex hash over those versions' parameters.
//
//   calculatePayrollRunStatutory({ run, tables, employees, thrAsOfDate })
//     -> { statutoryVersions, statutoryParametersHash, lines[] }
//        run = { status, payDate, configSnapshot } where configSnapshot is
//        null or { statutoryVersions, statutoryParametersHash }.
//        Before lock: published versions in force on the pay date. From lock
//        on: exactly the pinned versions (statutoryVersionsForRun semantics),
//        and a pinned hash that no longer matches the pinned parameters ->
//        PAYROLL_SNAPSHOT_MISMATCH. thrAsOfDate null = no THR computed.
//        Each line: { employeeId, contributions[], employerBpjsIdr,
//        employeeBpjsDeductionIdr, deductionCapped, thr }.
//
// Assumptions where the spec is silent (reported to the CTO):
//   A1. "Upah" for the deduction cap is `payableWageIdr` on the employee input
//       (wage left to take deductions from); the caller derives it.
//   A2. When the cap bites, the employer shares stay as computed (the
//       company still owes them); only the employee's shares shrink, and
//       `contributions[].employeeIdr` carry the post-cap amounts that sum to
//       `employeeBpjsDeductionIdr`. Which programme absorbs the cut is not
//       asserted.
//   A3. The calculation covers only the programmes listed per employee and the
//       THR table only when thrAsOfDate is given.
//
// Every expected value was computed BY HAND (exact integer arithmetic, rate
// bp / 10 000, "down" rounding) from the fixture tables below; none is copied
// from the engine. Integer IDR.
//
//   Tables v1 (effective 2026-01-01, rounding down):
//     bpjs_kes employer 400 bp, employee 100 bp, cap 12.000.000
//     jht      employer 370 bp, employee 200 bp, no cap
//     jp       employer 200 bp, employee 100 bp, cap 10.000.000
//     jkk      employer very_low 24, low 54, medium 89, high 127, very_high
//              174 bp, employee 0; jkm employer 30 bp, employee 0
//     thr      min tenure 1 month, full from 12 months
//   bpjs_kes v2 (effective 2026-11-20): employee 200 bp, rest as v1.
//
//   A  wage 8.000.000: kes 320.000 / 80.000, jht 296.000 / 160.000,
//      jp 160.000 / 80.000 -> employer 776.000, employee 320.000.
//      With kes v2: employee kes 160.000 -> employee total 400.000.
//   B  wage 15.000.000: kes base capped 12.000.000 -> 480.000 / 120.000;
//      jht 555.000 / 300.000; jp base capped 10.000.000 -> 200.000 / 100.000
//      -> employer 1.235.000, employee 520.000.
//   R  wage 8.000.333, jht only: employer 8.000.333 x 370 / 10^4 = 296.012,321
//      -> 296.012; employee x 200 / 10^4 = 160.006,66 -> 160.006 (down).
//   D  wage 5.000.000, jkk + jkm: high 127 bp -> 63.500, low 54 bp -> 27.000;
//      jkm 30 bp -> 15.000; employee 0.
//   THR as of 2027-03-10, wage 6.000.000, full 12 months:
//      join 2026-06-15 -> 8 completed months -> 6.000.000 x 8 / 12 = 4.000.000
//      join 2025-01-01 -> 26 months (>= 12)  -> 6.000.000 (the wage, the cap)
//      join 2027-02-10 -> 1 month (= min)    -> 500.000
//      join 2027-02-20 -> 0 months           -> 0
//      join 2026-08-10, wage 1.000.001 -> 7 months -> 7.000.007 / 12 =
//      583.334,08 -> 583.334.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { businessDateSchema, idr } from "@starter/shared/core";
import {
  statutoryTableVersionSchema,
  type StatutoryTableVersion,
  type StatutoryTableType,
} from "@starter/shared/hris/payroll";
import {
  calculatePayrollRunStatutory,
  captureStatutoryForLock,
  type PayrollRunStatutoryEmployee,
  type PayrollRunStatutoryRun,
} from "../services/payroll-statutory-calc.service.ts";

const date = (value: string) => businessDateSchema.parse(value);
const TENANT = randomUUID();
const PUBLISHER = randomUUID();
const PAY_DATE = date("2026-11-28");
const THR_AS_OF = date("2027-03-10");
const AT = "2026-01-01T00:00:00.000Z";

const BPJS = {
  wageFloorIdr: null,
  roundingMode: "down",
} as const;

function version(
  type: StatutoryTableType,
  parameters: unknown,
  fields: {
    version?: number;
    effectiveFrom?: string;
    status?: "draft" | "published";
  } = {},
): StatutoryTableVersion {
  const status = fields.status ?? "published";
  return statutoryTableVersionSchema.parse({
    id: randomUUID(),
    tenantId: TENANT,
    type,
    version: fields.version ?? 1,
    effectiveFrom: fields.effectiveFrom ?? "2026-01-01",
    status,
    legalBasis: "ILUSTRASI test sko14",
    publishedAt: status === "published" ? AT : null,
    publishedBy: status === "published" ? PUBLISHER : null,
    createdAt: AT,
    parameters,
  });
}

const kesParams = (employeeRateBp: number) => ({
  employerRateBp: 400,
  employeeRateBp,
  wageCapIdr: 12_000_000,
  ...BPJS,
});

const KES_V1 = version("bpjs_kes", kesParams(100));
const JHT = version("jht", {
  employerRateBp: 370,
  employeeRateBp: 200,
  wageCapIdr: null,
  ...BPJS,
});
const JP = version("jp", {
  employerRateBp: 200,
  employeeRateBp: 100,
  wageCapIdr: 10_000_000,
  ...BPJS,
});
const JKK = version("jkk", {
  employerRateBpByRiskClass: {
    very_low: 24,
    low: 54,
    medium: 89,
    high: 127,
    very_high: 174,
  },
  employeeRateBp: 0,
  wageCapIdr: null,
  ...BPJS,
});
const JKM = version("jkm", {
  employerRateBp: 30,
  employeeRateBp: 0,
  wageCapIdr: null,
  ...BPJS,
});
const THR = version("thr", {
  minTenureMonths: 1,
  fullTenureMonths: 12,
  roundingMode: "down",
});

const TABLES_V1: StatutoryTableVersion[] = [KES_V1, JHT, JP, JKK, JKM, THR];
const LOCK_TYPES: StatutoryTableType[] = [
  "bpjs_kes",
  "jht",
  "jp",
  "jkk",
  "jkm",
  "thr",
];

const employee = (
  employeeId: string,
  fields: Partial<PayrollRunStatutoryEmployee> = {},
): PayrollRunStatutoryEmployee => ({
  employeeId,
  joinDate: date("2020-01-01"),
  bpjsWageBaseIdr: idr(8_000_000),
  thrWageIdr: idr(6_000_000),
  payableWageIdr: idr(8_000_000),
  jkkRiskClass: "low",
  bpjsProgrammes: ["bpjs_kes", "jht", "jp"],
  ...fields,
});

const EMP_A = employee("A");
const EMP_B = employee("B", {
  bpjsWageBaseIdr: idr(15_000_000),
  payableWageIdr: idr(15_000_000),
});

const draftRun = (payDate = PAY_DATE): PayrollRunStatutoryRun => ({
  status: "draft",
  payDate,
  configSnapshot: null,
});

const calc = (
  run: PayrollRunStatutoryRun,
  tables: readonly StatutoryTableVersion[],
  employees: PayrollRunStatutoryEmployee[],
  thrAsOfDate: ReturnType<typeof date> | null = null,
) => calculatePayrollRunStatutory({ run, tables, employees, thrAsOfDate });

async function failureCode(fn: () => unknown) {
  try {
    await fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error("Expected the call to fail");
}

type Line = ReturnType<typeof calculatePayrollRunStatutory>["lines"][number];
const lineOf = (
  result: ReturnType<typeof calculatePayrollRunStatutory>,
  id: string,
): Line => {
  const line = result.lines.find((l) => l.employeeId === id);
  if (!line) throw new Error(`No line for ${id}`);
  return line;
};
const programme = (line: Line, type: string) => {
  const found = line.contributions.find((c) => c.type === type);
  if (!found) throw new Error(`No ${type} contribution`);
  return found;
};
const typesOf = (versions: { type: string }[]) =>
  versions.map((v) => v.type).sort();

describe("BPJS per employee: floor/cap base, both shares, whole rupiah", () => {
  it("computes the employer and employee share of each programme", async () => {
    const result = await calc(draftRun(), TABLES_V1, [EMP_A]);
    const a = lineOf(result, "A");
    expect(programme(a, "bpjs_kes")).toMatchObject({
      baseIdr: 8_000_000,
      capped: false,
      employerIdr: 320_000,
      employeeIdr: 80_000,
    });
    expect(programme(a, "jht")).toMatchObject({
      baseIdr: 8_000_000,
      employerIdr: 296_000,
      employeeIdr: 160_000,
    });
    expect(programme(a, "jp")).toMatchObject({
      baseIdr: 8_000_000,
      employerIdr: 160_000,
      employeeIdr: 80_000,
    });
    expect(a.employerBpjsIdr).toBe(776_000);
    expect(a.employeeBpjsDeductionIdr).toBe(320_000);
    expect(a.deductionCapped).toBe(false);
  });

  it("clamps the wage base at the programme's cap and says so", async () => {
    const b = lineOf(await calc(draftRun(), TABLES_V1, [EMP_B]), "B");
    expect(programme(b, "bpjs_kes")).toMatchObject({
      baseIdr: 12_000_000,
      capped: true,
      employerIdr: 480_000,
      employeeIdr: 120_000,
    });
    expect(programme(b, "jht")).toMatchObject({
      baseIdr: 15_000_000,
      capped: false,
      employerIdr: 555_000,
      employeeIdr: 300_000,
    });
    expect(programme(b, "jp")).toMatchObject({
      baseIdr: 10_000_000,
      capped: true,
      employerIdr: 200_000,
      employeeIdr: 100_000,
    });
    expect(b.employerBpjsIdr).toBe(1_235_000);
    expect(b.employeeBpjsDeductionIdr).toBe(520_000);
  });

  it("rounds each share down to whole rupiah with the table's mode", async () => {
    const r = employee("R", {
      bpjsWageBaseIdr: idr(8_000_333),
      payableWageIdr: idr(8_000_333),
      bpjsProgrammes: ["jht"],
    });
    const line = lineOf(await calc(draftRun(), TABLES_V1, [r]), "R");
    expect(programme(line, "jht")).toMatchObject({
      employerIdr: 296_012,
      employeeIdr: 160_006,
    });
    expect(Number.isInteger(line.employerBpjsIdr)).toBe(true);
    expect(Number.isInteger(line.employeeBpjsDeductionIdr)).toBe(true);
  });

  it("applies the JKK employer rate of the employee's risk class (employee share 0)", async () => {
    const d = (jkkRiskClass: "high" | "low") =>
      employee("D", {
        bpjsWageBaseIdr: idr(5_000_000),
        payableWageIdr: idr(5_000_000),
        bpjsProgrammes: ["jkk", "jkm"],
        jkkRiskClass,
      });
    const high = lineOf(await calc(draftRun(), TABLES_V1, [d("high")]), "D");
    expect(programme(high, "jkk").employerIdr).toBe(63_500);
    expect(programme(high, "jkm").employerIdr).toBe(15_000);
    expect(high.employerBpjsIdr).toBe(78_500);
    expect(high.employeeBpjsDeductionIdr).toBe(0);
    const low = lineOf(await calc(draftRun(), TABLES_V1, [d("low")]), "D");
    expect(programme(low, "jkk").employerIdr).toBe(27_000);
    expect(low.employerBpjsIdr).toBe(42_000);
  });

  it("owes nothing on a zero wage base and returns no lines for no employees", async () => {
    const zero = employee("Z", {
      bpjsWageBaseIdr: idr(0),
      payableWageIdr: idr(0),
    });
    const line = lineOf(await calc(draftRun(), TABLES_V1, [zero]), "Z");
    expect(line.employerBpjsIdr).toBe(0);
    expect(line.employeeBpjsDeductionIdr).toBe(0);
    expect((await calc(draftRun(), TABLES_V1, [])).lines).toEqual([]);
  });
});

describe("the employee's BPJS deduction never exceeds the wage (cap)", () => {
  it("cuts the employee shares down to the payable wage, employer shares stay", async () => {
    const c = employee("C", {
      bpjsWageBaseIdr: idr(15_000_000),
      payableWageIdr: idr(300_000),
    });
    const line = lineOf(await calc(draftRun(), TABLES_V1, [c]), "C");
    expect(line.employeeBpjsDeductionIdr).toBe(300_000);
    expect(line.deductionCapped).toBe(true);
    expect(line.contributions.reduce((s, p) => s + p.employeeIdr, 0)).toBe(
      300_000,
    );
    // No programme is charged more than its uncapped share (B above).
    expect(programme(line, "bpjs_kes").employeeIdr).toBeLessThanOrEqual(
      120_000,
    );
    expect(programme(line, "jht").employeeIdr).toBeLessThanOrEqual(300_000);
    expect(programme(line, "jp").employeeIdr).toBeLessThanOrEqual(100_000);
    expect(line.employerBpjsIdr).toBe(1_235_000);
  });

  it("deducts nothing when there is no payable wage", async () => {
    const c = employee("C", {
      bpjsWageBaseIdr: idr(15_000_000),
      payableWageIdr: idr(0),
    });
    const line = lineOf(await calc(draftRun(), TABLES_V1, [c]), "C");
    expect(line.employeeBpjsDeductionIdr).toBe(0);
    expect(line.deductionCapped).toBe(true);
    expect(line.contributions.every((p) => p.employeeIdr === 0)).toBe(true);
  });

  it("is not capped when the deduction equals the payable wage exactly", async () => {
    const exact = employee("B", {
      bpjsWageBaseIdr: idr(15_000_000),
      payableWageIdr: idr(520_000),
    });
    const line = lineOf(await calc(draftRun(), TABLES_V1, [exact]), "B");
    expect(line.employeeBpjsDeductionIdr).toBe(520_000);
    expect(line.deductionCapped).toBe(false);
  });

  it("never deducts more than the payable wage across a sweep of wages", async () => {
    for (const payable of [
      0, 1, 99_999, 319_999, 320_000, 320_001, 8_000_000,
    ]) {
      const e = employee("A", { payableWageIdr: idr(payable) });
      const line = lineOf(await calc(draftRun(), TABLES_V1, [e]), "A");
      expect(line.employeeBpjsDeductionIdr).toBeLessThanOrEqual(payable);
      expect(line.employeeBpjsDeductionIdr).toBe(Math.min(320_000, payable));
      expect(line.contributions.reduce((s, p) => s + p.employeeIdr, 0)).toBe(
        line.employeeBpjsDeductionIdr,
      );
    }
  });

  it("rejects a negative wage instead of computing a negative deduction", async () => {
    const bad = employee("A", { bpjsWageBaseIdr: -1 as never });
    await expect(
      (async () => calc(draftRun(), TABLES_V1, [bad]))(),
    ).rejects.toThrow();
  });

  it("rejects a duplicate employeeId instead of charging the employee twice", async () => {
    await expect(
      (async () => calc(draftRun(), TABLES_V1, [EMP_A, EMP_B, EMP_A]))(),
    ).rejects.toThrow(/Duplicate employeeId.*A/);
  });
});

describe("THR by tenure: pro rata, never above the THR wage", () => {
  const thrOf = async (
    fields: Partial<PayrollRunStatutoryEmployee>,
    asOf = THR_AS_OF,
  ) => {
    const e = employee("T", { bpjsProgrammes: [], ...fields });
    const line = lineOf(await calc(draftRun(), TABLES_V1, [e], asOf), "T");
    if (line.thr === null) throw new Error("Expected THR on a THR run");
    return line.thr;
  };

  it("pays pro rata by completed months below the full tenure", async () => {
    const thr = await thrOf({ joinDate: date("2026-06-15") });
    expect(thr.tenureMonths).toBe(8);
    expect(thr.amountIdr).toBe(4_000_000);
  });

  it("pays exactly the THR wage from the full tenure on, never more", async () => {
    const thr = await thrOf({ joinDate: date("2025-01-01") });
    expect(thr.tenureMonths).toBe(26);
    expect(thr.amountIdr).toBe(6_000_000);
  });

  it("pays at the minimum tenure and nothing below it", async () => {
    expect((await thrOf({ joinDate: date("2027-02-10") })).amountIdr).toBe(
      500_000,
    );
    const none = await thrOf({ joinDate: date("2027-02-20") });
    expect(none.tenureMonths).toBe(0);
    expect(none.amountIdr).toBe(0);
  });

  it("rounds the pro rata amount down to whole rupiah", async () => {
    const thr = await thrOf({
      joinDate: date("2026-08-10"),
      thrWageIdr: idr(1_000_001),
    });
    expect(thr.tenureMonths).toBe(7);
    // 1_000_001 * 7 / 12 = 583_333.58: floor, never the rounded-up 583_334.
    expect(thr.amountIdr).toBe(583_333);
  });

  it("stays at or below the THR wage for every tenure and never shrinks with tenure", async () => {
    let previous = 0;
    for (let months = 0; months <= 30; months++) {
      const y = 2027 - Math.floor((months + 2) / 12);
      const m = 3 - (months % 12);
      const joinMonth = m <= 0 ? m + 12 : m;
      const joinYear = m <= 0 ? y - 1 : y;
      const join = date(`${joinYear}-${String(joinMonth).padStart(2, "0")}-01`);
      const thr = await thrOf({ joinDate: join, thrWageIdr: idr(7_777_777) });
      expect(thr.amountIdr).toBeLessThanOrEqual(7_777_777);
      expect(thr.amountIdr).toBeGreaterThanOrEqual(previous);
      previous = thr.amountIdr;
    }
    expect(previous).toBe(7_777_777);
  });

  it("computes no THR on a run without a THR as-of date, and needs no THR table", async () => {
    const withoutThr = TABLES_V1.filter((t) => t.type !== "thr");
    const line = lineOf(await calc(draftRun(), withoutThr, [EMP_A]), "A");
    expect(line.thr).toBeNull();
  });

  it("fails closed when a THR run has no published THR table", async () => {
    const withoutThr = TABLES_V1.filter((t) => t.type !== "thr");
    expect(
      await failureCode(() => calc(draftRun(), withoutThr, [EMP_A], THR_AS_OF)),
    ).toBe("PAYROLL_STATUTORY_TABLE_NOT_FOUND");
  });
});

describe("table versions: resolved by pay date before lock, never a guessed rate", () => {
  it("fails closed when a programme has no published version on the pay date", async () => {
    const noJp = TABLES_V1.filter((t) => t.type !== "jp");
    expect(await failureCode(() => calc(draftRun(), noJp, [EMP_A]))).toBe(
      "PAYROLL_STATUTORY_TABLE_NOT_FOUND",
    );
    // Published only after the pay date: not in force yet.
    const late = version(
      "jp",
      { ...JP.parameters },
      {
        effectiveFrom: "2026-12-01",
      },
    );
    expect(
      await failureCode(() => calc(draftRun(), [...noJp, late], [EMP_A])),
    ).toBe("PAYROLL_STATUTORY_TABLE_NOT_FOUND");
  });

  it("ignores draft versions", async () => {
    const draftKes = version("bpjs_kes", kesParams(900), {
      version: 2,
      effectiveFrom: "2026-11-25",
      status: "draft",
    });
    const line = lineOf(
      await calc(draftRun(), [...TABLES_V1, draftKes], [EMP_A]),
      "A",
    );
    expect(programme(line, "bpjs_kes").employeeIdr).toBe(80_000);
  });

  it("reports the versions used, one per table type the run needs", async () => {
    const result = await calc(draftRun(), TABLES_V1, [EMP_A]);
    expect(typesOf(result.statutoryVersions)).toEqual([
      "bpjs_kes",
      "jht",
      "jp",
    ]);
    expect(result.statutoryVersions.find((v) => v.type === "bpjs_kes")).toEqual(
      {
        type: "bpjs_kes",
        versionId: KES_V1.id,
        version: 1,
        effectiveFrom: "2026-01-01",
      },
    );
    expect(result.statutoryParametersHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("snapshot at lock: the rates never change after lock", () => {
  const KES_V2 = version("bpjs_kes", kesParams(200), {
    version: 2,
    effectiveFrom: "2026-11-20",
  });
  const TABLES_V2: StatutoryTableVersion[] = [...TABLES_V1, KES_V2];

  const lockedWith = (
    snapshot: Awaited<ReturnType<typeof captureStatutoryForLock>>,
    status: PayrollRunStatutoryRun["status"] = "locked",
  ): PayrollRunStatutoryRun => ({
    status,
    payDate: PAY_DATE,
    configSnapshot: snapshot,
  });

  it("captures the versions in force on the pay date, by id, with a hash", async () => {
    const snapshot = await captureStatutoryForLock({
      tables: TABLES_V1,
      payDate: PAY_DATE,
      types: LOCK_TYPES,
    });
    expect(typesOf(snapshot.statutoryVersions)).toEqual([...LOCK_TYPES].sort());
    expect(
      snapshot.statutoryVersions.find((v) => v.type === "bpjs_kes"),
    ).toEqual({
      type: "bpjs_kes",
      versionId: KES_V1.id,
      version: 1,
      effectiveFrom: "2026-01-01",
    });
    expect(snapshot.statutoryParametersHash).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic, and a different set of parameters hashes differently.
    expect(
      (
        await captureStatutoryForLock({
          tables: TABLES_V1,
          payDate: PAY_DATE,
          types: LOCK_TYPES,
        })
      ).statutoryParametersHash,
    ).toBe(snapshot.statutoryParametersHash);
    expect(
      (
        await captureStatutoryForLock({
          tables: TABLES_V2,
          payDate: PAY_DATE,
          types: LOCK_TYPES,
        })
      ).statutoryParametersHash,
    ).not.toBe(snapshot.statutoryParametersHash);
  });

  it("keeps a locked run on v1 after v2 is published; a draft copy uses v2", async () => {
    const snapshot = await captureStatutoryForLock({
      tables: TABLES_V1,
      payDate: PAY_DATE,
      types: LOCK_TYPES,
    });
    const before = lineOf(
      await calc(lockedWith(snapshot), TABLES_V1, [EMP_A, EMP_B]),
      "A",
    );
    expect(before.employeeBpjsDeductionIdr).toBe(320_000);

    // v2 (employee kes 200 bp) is published after the lock.
    const lockedAfter = await calc(lockedWith(snapshot), TABLES_V2, [
      EMP_A,
      EMP_B,
    ]);
    expect(lineOf(lockedAfter, "A")).toEqual(before);
    expect(programme(lineOf(lockedAfter, "A"), "bpjs_kes").employeeIdr).toBe(
      80_000,
    );
    expect(lineOf(lockedAfter, "B").employeeBpjsDeductionIdr).toBe(520_000);
    expect(
      lockedAfter.statutoryVersions.find((v) => v.type === "bpjs_kes")
        ?.versionId,
    ).toBe(KES_V1.id);
    // Paid and reversed runs are frozen the same way.
    for (const status of ["paid", "reversed"] as const) {
      const frozen = await calc(lockedWith(snapshot, status), TABLES_V2, [
        EMP_A,
      ]);
      expect(lineOf(frozen, "A")).toEqual(before);
    }

    // A draft copy of the same run, same pay date, uses v2.
    const draft = lineOf(await calc(draftRun(), TABLES_V2, [EMP_A]), "A");
    expect(programme(draft, "bpjs_kes").employeeIdr).toBe(160_000);
    expect(draft.employeeBpjsDeductionIdr).toBe(400_000);
    // The next lock would pin v2.
    const next = await captureStatutoryForLock({
      tables: TABLES_V2,
      payDate: PAY_DATE,
      types: LOCK_TYPES,
    });
    expect(
      next.statutoryVersions.find((v) => v.type === "bpjs_kes")?.versionId,
    ).toBe(KES_V2.id);
  });

  it("does not modify the snapshot or the tables it reads", async () => {
    const snapshot = await captureStatutoryForLock({
      tables: TABLES_V2,
      payDate: PAY_DATE,
      types: LOCK_TYPES,
    });
    const snapshotBefore = structuredClone(snapshot);
    const tablesBefore = structuredClone(TABLES_V2);
    await calc(lockedWith(snapshot), TABLES_V2, [EMP_A, EMP_B]);
    expect(snapshot).toEqual(snapshotBefore);
    expect(TABLES_V2).toEqual(tablesBefore);
  });

  it("refuses a tampered or incomplete snapshot with PAYROLL_SNAPSHOT_MISMATCH", async () => {
    const snapshot = await captureStatutoryForLock({
      tables: TABLES_V1,
      payDate: PAY_DATE,
      types: LOCK_TYPES,
    });
    const run = (patch: Partial<typeof snapshot>) =>
      lockedWith({ ...snapshot, ...patch });
    const refsWith = (
      type: string,
      patch: Record<string, unknown>,
    ): typeof snapshot.statutoryVersions =>
      snapshot.statutoryVersions.map((ref) =>
        ref.type === type ? ({ ...ref, ...patch } as typeof ref) : ref,
      );

    // A frozen run without any snapshot.
    expect(
      await failureCode(() =>
        calc(
          { status: "locked", payDate: PAY_DATE, configSnapshot: null },
          TABLES_V1,
          [EMP_A],
        ),
      ),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    // Wrong version number, wrong effective date, unknown version id.
    for (const patch of [
      { version: 2 },
      { effectiveFrom: "2026-02-01" },
      { versionId: randomUUID() },
    ])
      expect(
        await failureCode(() =>
          calc(
            run({ statutoryVersions: refsWith("bpjs_kes", patch) }),
            TABLES_V1,
            [EMP_A],
          ),
        ),
      ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    // A type the run needs but the snapshot never pinned.
    expect(
      await failureCode(() =>
        calc(
          run({
            statutoryVersions: snapshot.statutoryVersions.filter(
              (v) => v.type !== "jp",
            ),
          }),
          TABLES_V1,
          [EMP_A],
        ),
      ),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    // The pinned version is gone from the tables.
    expect(
      await failureCode(() =>
        calc(
          lockedWith(snapshot),
          TABLES_V1.filter((t) => t.id !== KES_V1.id),
          [EMP_A],
        ),
      ),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
  });

  it("refuses a pinned version whose parameters changed behind the snapshot", async () => {
    const snapshot = await captureStatutoryForLock({
      tables: TABLES_V1,
      payDate: PAY_DATE,
      types: LOCK_TYPES,
    });
    // Same id, version and date, but the employee rate was edited in place.
    const edited = { ...KES_V1, parameters: kesParams(50) };
    const tables = TABLES_V1.map((t) => (t.id === KES_V1.id ? edited : t));
    expect(
      await failureCode(() =>
        calc(lockedWith(snapshot), tables as StatutoryTableVersion[], [EMP_A]),
      ),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
    // A forged hash is refused too.
    expect(
      await failureCode(() =>
        calc(
          lockedWith({ ...snapshot, statutoryParametersHash: "0".repeat(64) }),
          TABLES_V1,
          [EMP_A],
        ),
      ),
    ).toBe("PAYROLL_SNAPSHOT_MISMATCH");
  });

  it("keeps THR on the pinned THR table after a newer one is published", async () => {
    const snapshot = await captureStatutoryForLock({
      tables: TABLES_V1,
      payDate: PAY_DATE,
      types: LOCK_TYPES,
    });
    // A newer rule that would pay everyone the full wage from month 1.
    const thrV2 = version(
      "thr",
      { minTenureMonths: 0, fullTenureMonths: 1, roundingMode: "down" },
      { version: 2, effectiveFrom: "2026-11-20" },
    );
    const e = employee("T", {
      bpjsProgrammes: [],
      joinDate: date("2026-06-15"),
    });
    const locked = lineOf(
      await calc(lockedWith(snapshot), [...TABLES_V1, thrV2], [e], THR_AS_OF),
      "T",
    );
    expect(locked.thr?.amountIdr).toBe(4_000_000);
    const draft = lineOf(
      await calc(draftRun(), [...TABLES_V1, thrV2], [e], THR_AS_OF),
      "T",
    );
    expect(draft.thr?.amountIdr).toBe(6_000_000);
    expect(draft.thr?.amountIdr).toBeLessThanOrEqual(6_000_000);
  });
});
