// Payroll run maker-checker proof (money area, PAYR-01). PRD §3 Matriks
// Approval: "Penyetuju selalu berbeda dari pemohon"; payroll approval is two
// levels (HR, then Finance/Owner). Rule under test: the FINAL approver must
// differ from the run's creator as well as from the HR approver, so one person
// can never create a run and release its money alone.
//
// ASSUMPTION: the HR (first-level) approval by the run's creator stays allowed
// (the shared Cafe Legend fixture itself has createdBy === HR approver); only
// the final approver is held to "not the creator". Written from the contract
// and the shared validators, not from the reducer's implementation.
import { describe, expect, it } from "vitest";
import { userIdSchema } from "@starter/shared/core";
import {
  applyPayrollRunCommand,
  cafeLegendPayrollFixtures,
  PayrollError,
  payrollRunSchema,
} from "@starter/shared/hris/payroll";
import type { PayrollRun } from "@starter/shared/hris/payroll";

const { hrApprover, financeApprover } = cafeLegendPayrollFixtures.userIds;
const thirdApprover = userIdSchema.parse(
  "00000000-0000-4000-8000-000000009001",
);
const { october, november } = cafeLegendPayrollFixtures.payrollRuns;

const HR_AT = "2026-11-02T03:00:00.000Z";
const FINAL_AT = "2026-11-03T03:00:00.000Z";

/** A simulated run created by `creator` (the fixture's November run). */
const simulatedBy = (creator: typeof hrApprover): PayrollRun =>
  payrollRunSchema.parse({ ...november, createdBy: creator });

/** The same run after HR approval by `hr`. */
const hrApprovedRun = (
  creator: typeof hrApprover,
  hr: typeof hrApprover,
): PayrollRun =>
  applyPayrollRunCommand(simulatedBy(creator), {
    action: "approve_hr",
    actorId: hr,
    at: HR_AT,
  });

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("payroll run approvers (PAYR-01 maker-checker)", () => {
  it("refuses the final approval by the run's creator with PAYROLL_APPROVER_NOT_DISTINCT", () => {
    // Creator = Finance user; HR approval by a different person; then the
    // creator tries to give the final approval.
    const run = hrApprovedRun(financeApprover, hrApprover);
    expect(run.status).toBe("hr_approved");
    expect(run.createdBy).toBe(financeApprover);
    expect(run.approvedByHr).toBe(hrApprover);
    const error = thrown(() =>
      applyPayrollRunCommand(run, {
        action: "approve_final",
        actorId: financeApprover,
        at: FINAL_AT,
      }),
    );
    expect(error).toBeInstanceOf(PayrollError);
    expect((error as PayrollError).code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
    // Refused approval leaves the run untouched.
    expect(run.status).toBe("hr_approved");
    expect(run.approvedByFinance).toBeNull();
  });

  it("accepts the final approval by a third person, distinct from creator and HR approver", () => {
    const run = hrApprovedRun(financeApprover, hrApprover);
    const approved = applyPayrollRunCommand(run, {
      action: "approve_final",
      actorId: thirdApprover,
      at: FINAL_AT,
    });
    expect(approved.status).toBe("approved");
    expect(approved.approvedByFinance).toBe(thirdApprover);
    expect(approved.approvedByFinanceAt).toBe(FINAL_AT);
    // The resulting row is a valid payroll run.
    expect(payrollRunSchema.safeParse(approved).success).toBe(true);
  });

  it("still lets the creator give the first-level HR approval", () => {
    const approved = hrApprovedRun(hrApprover, hrApprover);
    expect(approved.status).toBe("hr_approved");
    expect(approved.createdBy).toBe(hrApprover);
    expect(approved.approvedByHr).toBe(hrApprover);
  });

  it("accepts the final approval by a distinct Finance user when the creator is the HR approver", () => {
    // The shared fixture shape: HR admin creates and HR-approves, Finance
    // gives the final approval.
    const run = hrApprovedRun(hrApprover, hrApprover);
    const approved = applyPayrollRunCommand(run, {
      action: "approve_final",
      actorId: financeApprover,
      at: FINAL_AT,
    });
    expect(approved.status).toBe("approved");
    expect(approved.approvedByFinance).toBe(financeApprover);
  });

  it("keeps the existing rule: the final approver cannot be the HR approver", () => {
    const run = hrApprovedRun(financeApprover, hrApprover);
    const error = thrown(() =>
      applyPayrollRunCommand(run, {
        action: "approve_final",
        actorId: hrApprover,
        at: FINAL_AT,
      }),
    );
    expect(error).toBeInstanceOf(PayrollError);
    expect((error as PayrollError).code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
  });
});

describe("payrollRunSchema approver invariants", () => {
  // An approved (final-approved, not yet locked) run, derived from the paid
  // October fixture so every other field stays consistent.
  const approvedRun = (createdBy: typeof hrApprover) => ({
    ...october,
    status: "approved" as const,
    lockedBy: null,
    lockedAt: null,
    paidBy: null,
    paidAt: null,
    createdBy,
  });

  it("rejects an approved run whose final approver is its creator (issue on approvedByFinance)", () => {
    const parsed = payrollRunSchema.safeParse(approvedRun(financeApprover));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path[0])).toContain(
      "approvedByFinance",
    );
  });

  it("accepts an approved run whose creator differs from the final approver", () => {
    expect(payrollRunSchema.safeParse(approvedRun(hrApprover)).success).toBe(
      true,
    );
    expect(payrollRunSchema.safeParse(approvedRun(thirdApprover)).success).toBe(
      true,
    );
  });

  it("applies the creator rule to later statuses too (a paid run keeps its final approver)", () => {
    const paid = { ...october, createdBy: financeApprover };
    const parsed = payrollRunSchema.safeParse(paid);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path[0])).toContain(
      "approvedByFinance",
    );
  });

  it("keeps the existing rule: HR and final approver cannot be the same person", () => {
    const parsed = payrollRunSchema.safeParse({
      ...approvedRun(thirdApprover),
      approvedByFinance: hrApprover,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path[0])).toContain(
      "approvedByFinance",
    );
  });

  it("does not constrain a run that has no final approval yet", () => {
    // HR-approved run created by the HR approver (fixture shape) stays valid.
    expect(
      payrollRunSchema.safeParse(hrApprovedRun(hrApprover, hrApprover)).success,
    ).toBe(true);
  });
});

describe("payroll run lock keeps the creator rule (defense in depth)", () => {
  // The reducer does not parse its input, so a run row built without the
  // schema (e.g. read straight from the database) must still not lock when its
  // final approver is its own creator.
  const approvedBy = (createdBy: typeof hrApprover) =>
    ({
      ...october,
      status: "approved" as const,
      lockedBy: null,
      lockedAt: null,
      paidBy: null,
      paidAt: null,
      createdBy,
    }) as PayrollRun;

  it("refuses to lock a run whose final approver is its creator", () => {
    const run = approvedBy(financeApprover);
    expect(run.approvedByFinance).toBe(financeApprover);
    const error = thrown(() =>
      applyPayrollRunCommand(run, {
        action: "lock",
        actorId: thirdApprover,
        at: FINAL_AT,
      }),
    );
    expect(error).toBeInstanceOf(PayrollError);
    expect((error as PayrollError).code).toBe("PAYROLL_RUN_NOT_APPROVED");
  });

  it("locks a run approved by two people who both differ from the creator", () => {
    const locked = applyPayrollRunCommand(approvedBy(thirdApprover), {
      action: "lock",
      actorId: thirdApprover,
      at: FINAL_AT,
    });
    expect(locked.status).toBe("locked");
  });
});
