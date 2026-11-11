// Payroll run maker-checker proof (money area, PAYR-01). PRD §3 Matriks
// Approval: "Penyetuju selalu berbeda dari pemohon"; payroll approval is two
// levels (HR, then Finance/Owner). Rule under test (CTO decision 2026-11-11,
// doubt = restrict): NEITHER approver may be the run's creator, and the two
// approvers differ from each other, so one person can never create a run and
// release its money alone.
//
// The shared Cafe Legend fixture run is created by a third user
// (`userIds.runCreator`), distinct from the HR and Finance approvers.
// Written from the contract and the shared validators, not from the
// reducer's implementation.
import { describe, expect, it } from "vitest";
import { userIdSchema } from "@starter/shared/core";
import {
  applyPayrollRunCommand,
  cafeLegendPayrollFixtures,
  PayrollError,
  payrollRunSchema,
} from "@starter/shared/hris/payroll";
import type { PayrollRun } from "@starter/shared/hris/payroll";

const { hrApprover, financeApprover, runCreator } =
  cafeLegendPayrollFixtures.userIds;
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
    // Creator = run creator; HR approval by a different person; then the
    // creator tries to give the final approval.
    const run = hrApprovedRun(runCreator, hrApprover);
    expect(run.status).toBe("hr_approved");
    expect(run.createdBy).toBe(runCreator);
    expect(run.approvedByHr).toBe(hrApprover);
    const error = thrown(() =>
      applyPayrollRunCommand(run, {
        action: "approve_final",
        actorId: runCreator,
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
    const run = hrApprovedRun(runCreator, hrApprover);
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

  it("refuses the first-level HR approval by the run's creator with PAYROLL_APPROVER_NOT_DISTINCT", () => {
    // Flipped from the earlier rule (HR approval by the creator was allowed).
    // Creator is the HR approver user, so this fails for the right reason
    // (missing behavior) even before the fixture creator is rebased.
    const run = simulatedBy(hrApprover);
    expect(run.status).toBe("simulated");
    const error = thrown(() =>
      applyPayrollRunCommand(run, {
        action: "approve_hr",
        actorId: hrApprover,
        at: HR_AT,
      }),
    );
    expect(error).toBeInstanceOf(PayrollError);
    expect((error as PayrollError).code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
    // Refused approval leaves the run untouched.
    expect(run.status).toBe("simulated");
    expect(run.approvedByHr).toBeNull();
  });

  it("refuses the HR approval by the fixture run creator (runCreator)", () => {
    const run = simulatedBy(runCreator);
    const error = thrown(() =>
      applyPayrollRunCommand(run, {
        action: "approve_hr",
        actorId: runCreator,
        at: HR_AT,
      }),
    );
    expect(error).toBeInstanceOf(PayrollError);
    expect((error as PayrollError).code).toBe("PAYROLL_APPROVER_NOT_DISTINCT");
  });

  it("accepts the HR approval by someone other than the creator", () => {
    const approved = hrApprovedRun(runCreator, hrApprover);
    expect(approved.status).toBe("hr_approved");
    expect(approved.createdBy).toBe(runCreator);
    expect(approved.approvedByHr).toBe(hrApprover);
  });

  it("accepts the final approval by a distinct Finance user (creator, HR and Finance all differ)", () => {
    // The shared fixture shape: run creator creates, HR approves, Finance
    // gives the final approval.
    const run = hrApprovedRun(runCreator, hrApprover);
    const approved = applyPayrollRunCommand(run, {
      action: "approve_final",
      actorId: financeApprover,
      at: FINAL_AT,
    });
    expect(approved.status).toBe("approved");
    expect(approved.approvedByFinance).toBe(financeApprover);
  });

  it("keeps the existing rule: the final approver cannot be the HR approver", () => {
    const run = hrApprovedRun(runCreator, hrApprover);
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

  it("rejects an approved run whose HR approver is its creator (issue on approvedByHr)", () => {
    // Flipped: this shape (creator === HR approver) used to be valid.
    const parsed = payrollRunSchema.safeParse(approvedRun(hrApprover));
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path[0])).toContain(
      "approvedByHr",
    );
  });

  it("rejects an HR-approved run whose HR approver is its creator, even before final approval", () => {
    const hrApproved = hrApprovedRun(thirdApprover, hrApprover);
    const parsed = payrollRunSchema.safeParse({
      ...hrApproved,
      createdBy: hrApprover,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path[0])).toContain(
      "approvedByHr",
    );
  });

  it("accepts an approved run whose creator differs from both approvers", () => {
    expect(payrollRunSchema.safeParse(approvedRun(runCreator)).success).toBe(
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

  it("applies the HR-creator rule to a paid run too", () => {
    const parsed = payrollRunSchema.safeParse({
      ...october,
      createdBy: hrApprover,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path[0])).toContain(
      "approvedByHr",
    );
  });

  it("accepts the fixture paid October run (creator, HR and Finance all differ)", () => {
    expect(october.createdBy).toBe(runCreator);
    expect(payrollRunSchema.safeParse(october).success).toBe(true);
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
    // HR-approved run created by a third user stays valid.
    expect(
      payrollRunSchema.safeParse(hrApprovedRun(runCreator, hrApprover)).success,
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

  it("refuses to lock a run whose HR approver is its creator", () => {
    const run = approvedBy(hrApprover);
    expect(run.approvedByHr).toBe(hrApprover);
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
    const locked = applyPayrollRunCommand(approvedBy(runCreator), {
      action: "lock",
      actorId: thirdApprover,
      at: FINAL_AT,
    });
    expect(locked.status).toBe("locked");
  });

  it("locks a run created by yet another user (both approvers differ from the creator)", () => {
    const locked = applyPayrollRunCommand(approvedBy(thirdApprover), {
      action: "lock",
      actorId: thirdApprover,
      at: FINAL_AT,
    });
    expect(locked.status).toBe("locked");
  });
});
