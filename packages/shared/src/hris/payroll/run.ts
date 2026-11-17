// Payroll run state machine (PRD v1.7 §3 D.30 "Payroll Run: simulasi, review
// per karyawan, approval dua tingkat (HR lalu Finance atau Owner), penguncian,
// dan pembatalan dengan approval"; §6 H `payroll_runs.status` draft /
// simulated / hr_approved / approved / locked / paid / reversed; Alur K;
// PAYR-01, PAYR-02, PAYR-05).
//
//   draft ──simulate──▶ simulated ──approve_hr──▶ hr_approved
//     ▲                  │  ▲ simulate (repeatable, no side effect)
//     └──return_to_draft─┴──┴──────── (from simulated / hr_approved / approved)
//   hr_approved ──approve_final──▶ approved ──lock──▶ locked
//   locked ──mark_paid──▶ paid
//   locked ──approve_reversal──▶ reversed   (after request_reversal; PAYR-05)
//
// Rules:
// - PAYR-01: simulate is repeatable and has no side effect (no payslip,
//   journal, bank file, loan deduction or notification); only a run approved
//   at both levels, by two different people, can be locked.
// - The final approver (Finance or Owner) differs from the HR approver; a
//   reversal approver differs from its requester (PRD §3 Matriks Approval).
// - PAYR-02: from `locked` on, the run is frozen: its config snapshot pins
//   the statutory table versions it was calculated with, so a newer version
//   never changes it.
// - PRD silent on reversing a PAID run. Safest: only `locked` (not yet paid)
//   can be reversed; money already transferred is corrected in a later run.

import {
  z,
  tenantIdSchema,
  userIdSchema,
  businessDateSchema,
  isoDateTimeSchema,
  clientInputSchema,
  idempotencyKeySchema,
  basisPointsSchema,
} from "../../core/index.ts";
import type { BusinessDate, IsoDateTime, UserId } from "../../core/index.ts";
import { legalEntityIdSchema } from "../../accounting/ids.ts";
import { payComponentCategorySchema, taxSchemeSchema } from "./components.ts";
import { employeeIdSchema } from "../ids.ts";
import { PayrollError } from "./errors.ts";
import {
  payComponentIdSchema,
  payrollPolicyIdSchema,
  payrollRunIdSchema,
  statutoryTableVersionIdSchema,
  thrScheduleIdSchema,
} from "./ids.ts";
import { payrollRunTotalsSchema } from "./payslips.ts";
import type { PayrollRunTotals } from "./payslips.ts";
import { payDateAdjustmentSchema, payrollCycleSchema } from "./policies.ts";
import {
  DEFAULT_PPH21_POLICY,
  pph21ParametersHash,
  pph21PolicyVersionIdSchema,
  resolvePph21Policy,
} from "./pph21-policy.ts";
import type {
  Pph21PolicyParameters,
  Pph21PolicyVersion,
} from "./pph21-policy.ts";
import {
  BPJS_TABLE_TYPES,
  jkkRiskClassSchema,
  resolveStatutoryTable,
  statutoryTableTypeSchema,
} from "./statutory.ts";
import type { StatutoryTableType, StatutoryTableVersion } from "./statutory.ts";

export const PAYROLL_RUN_STATUSES = [
  "draft",
  "simulated",
  "hr_approved",
  "approved",
  "locked",
  "paid",
  "reversed",
] as const;
export const payrollRunStatusSchema = z.enum(PAYROLL_RUN_STATUSES);
export type PayrollRunStatus = z.infer<typeof payrollRunStatusSchema>;

/** regular = the policy's cycle; thr = a THR schedule; off_cycle = bonus or
 * correction run. */
export const payrollRunTypeSchema = z.enum(["regular", "thr", "off_cycle"]);
export type PayrollRunType = z.infer<typeof payrollRunTypeSchema>;

export const PAYROLL_RUN_ACTIONS = [
  "simulate",
  "return_to_draft",
  "approve_hr",
  "approve_final",
  "lock",
  "mark_paid",
  "request_reversal",
  "reject_reversal",
  "approve_reversal",
] as const;
export type PayrollRunAction = (typeof PAYROLL_RUN_ACTIONS)[number];

const runTransitions: Record<
  PayrollRunStatus,
  Partial<Record<PayrollRunAction, PayrollRunStatus>>
> = {
  draft: { simulate: "simulated" },
  simulated: {
    simulate: "simulated",
    approve_hr: "hr_approved",
    return_to_draft: "draft",
  },
  hr_approved: { approve_final: "approved", return_to_draft: "draft" },
  approved: { lock: "locked", return_to_draft: "draft" },
  locked: {
    mark_paid: "paid",
    // A reversal request/rejection leaves the run locked.
    request_reversal: "locked",
    reject_reversal: "locked",
    approve_reversal: "reversed",
  },
  paid: {},
  reversed: {},
};

/** Next status, or PAYROLL_RUN_INVALID_TRANSITION. */
export function nextPayrollRunStatus(
  status: PayrollRunStatus,
  action: PayrollRunAction,
): PayrollRunStatus {
  const next = runTransitions[status][action];
  if (!next) throw new PayrollError("PAYROLL_RUN_INVALID_TRANSITION");
  return next;
}

export function canApplyPayrollRunAction(
  status: PayrollRunStatus,
  action: PayrollRunAction,
): boolean {
  return runTransitions[status][action] !== undefined;
}

/** Statuses whose inputs, results and snapshot never change (PAYR-02). */
export const FROZEN_PAYROLL_RUN_STATUSES = [
  "locked",
  "paid",
  "reversed",
] as const satisfies readonly PayrollRunStatus[];

export function isPayrollRunFrozen(status: PayrollRunStatus): boolean {
  return (FROZEN_PAYROLL_RUN_STATUSES as readonly string[]).includes(status);
}

/** Inputs (attendance, components, pools, loans) may change only before lock. */
export function assertPayrollRunEditable(status: PayrollRunStatus): void {
  if (isPayrollRunFrozen(status)) throw new PayrollError("PAYROLL_RUN_FROZEN");
}

/**
 * Side effects each action triggers in the API, in the same transaction via
 * the outbox. PAYR-01: `simulate` has none. Used by the BE bead and the tests
 * as the single list.
 */
export const PAYROLL_RUN_SIDE_EFFECTS = {
  simulate: [],
  return_to_draft: [],
  approve_hr: ["approval_requested"],
  approve_final: [],
  lock: [
    "attendance_period_locked",
    "payslips_created",
    "payroll_journal_posted",
    "loan_installments_deducted",
    "reimbursements_marked_paid",
    "service_charge_pools_distributed",
    "event_payroll_locked",
  ],
  mark_paid: ["event_payroll_paid", "employees_notified"],
  request_reversal: ["approval_requested"],
  reject_reversal: [],
  approve_reversal: [
    "reversing_journal_posted",
    "loan_installments_restored",
    "reimbursements_reopened",
    "service_charge_pools_restored",
    "payslips_voided",
    "event_payroll_reversed",
  ],
} as const satisfies Record<PayrollRunAction, readonly string[]>;

// ---- Config snapshot (PAYR-02) -------------------------------------------

export const statutoryVersionRefSchema = z.strictObject({
  type: statutoryTableTypeSchema,
  versionId: statutoryTableVersionIdSchema,
  version: z.number().int().positive().safe(),
  effectiveFrom: businessDateSchema,
});
export type StatutoryVersionRef = z.infer<typeof statutoryVersionRefSchema>;

/**
 * The tenant PPh 21 policy version a run pinned (bead legend-y4wp). Same
 * fields as a statutory ref minus the table type, plus the hash of the
 * version's parameters (`pph21ParametersHash`): a pinned version whose
 * parameters no longer match is a snapshot mismatch.
 */
export const pph21PolicyRefSchema = z.strictObject({
  versionId: pph21PolicyVersionIdSchema,
  version: z.number().int().min(1).safe(),
  effectiveFrom: businessDateSchema,
  parametersHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Pph21PolicyRef = z.infer<typeof pph21PolicyRefSchema>;

/** PRD §6 H `payroll_runs.config_snapshot`: tariff and rule versions used. */
export const payrollConfigSnapshotSchema = z
  .strictObject({
    statutoryVersions: z.array(statutoryVersionRefSchema).min(1).max(20),
    policy: z.strictObject({
      id: payrollPolicyIdSchema,
      cycle: payrollCycleSchema,
      payDateAdjustment: payDateAdjustmentSchema,
      jkkRiskClass: jkkRiskClassSchema,
      bpjsProgrammes: z.array(z.enum(BPJS_TABLE_TYPES)),
    }),
    components: z
      .array(
        z.strictObject({
          id: payComponentIdSchema,
          code: z.string().min(2).max(30),
          category: payComponentCategorySchema,
          taxable: z.boolean(),
          taxScheme: taxSchemeSchema,
          bpjsBase: z.boolean(),
          overtimeBase: z.boolean(),
          thrBase: z.boolean(),
        }),
      )
      .min(1)
      .max(200),
    loanMaxDeductionOfNetPayBp: basisPointsSchema,
    /**
     * Tenant PPh 21 policy version in force on the pay date at lock. `null` =
     * the tenant had published none, so the default policy applies and keeps
     * applying after lock, whatever the tenant publishes later.
     */
    pph21Policy: pph21PolicyRefSchema.nullable(),
    capturedAt: isoDateTimeSchema,
  })
  .refine(
    (s) =>
      new Set(s.statutoryVersions.map((v) => v.type)).size ===
      s.statutoryVersions.length,
    { path: ["statutoryVersions"], message: "One version per table type" },
  );
export type PayrollConfigSnapshot = z.infer<typeof payrollConfigSnapshotSchema>;

export function statutoryVersionRef(
  version: StatutoryTableVersion,
): StatutoryVersionRef {
  return {
    type: version.type,
    versionId: version.id,
    version: version.version,
    effectiveFrom: version.effectiveFrom,
  };
}

/**
 * The statutory table versions a run computes with. Before lock: the
 * published versions in force on the pay date (PRD silent on which date;
 * the pay date decides the tax period, so one date for every table). From
 * lock on: exactly the versions pinned in the snapshot, by id, whatever was
 * published since (PAYR-02). A pinned version that is missing or changed ->
 * PAYROLL_SNAPSHOT_MISMATCH.
 */
export function statutoryVersionsForRun(
  run: {
    status: PayrollRunStatus;
    payDate: BusinessDate;
    configSnapshot: Pick<PayrollConfigSnapshot, "statutoryVersions"> | null;
  },
  versions: readonly StatutoryTableVersion[],
  types: readonly StatutoryTableType[],
): Map<StatutoryTableType, StatutoryTableVersion> {
  const result = new Map<StatutoryTableType, StatutoryTableVersion>();
  if (!isPayrollRunFrozen(run.status)) {
    for (const type of types)
      result.set(type, resolveStatutoryTable(versions, type, run.payDate));
    return result;
  }
  if (run.configSnapshot === null)
    throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  for (const type of types) {
    const ref = run.configSnapshot.statutoryVersions.find(
      (pinned) => pinned.type === type,
    );
    const version = ref && versions.find((v) => v.id === ref.versionId);
    if (
      !ref ||
      !version ||
      version.type !== type ||
      version.version !== ref.version ||
      version.effectiveFrom !== ref.effectiveFrom ||
      version.status !== "published"
    )
      throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
    result.set(type, version);
  }
  return result;
}

export function pph21PolicyRef(
  version: Pick<
    Pph21PolicyVersion,
    "id" | "version" | "effectiveFrom" | "parameters"
  >,
): Pph21PolicyRef {
  return {
    versionId: version.id,
    version: version.version,
    effectiveFrom: version.effectiveFrom,
    parametersHash: pph21ParametersHash(version.parameters),
  };
}

/** Same pinned version: id, number, date and parameters hash all equal. */
export function isSamePph21PolicyRef(
  a: Pph21PolicyRef | null,
  b: Pph21PolicyRef | null,
): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.versionId === b.versionId &&
    a.version === b.version &&
    a.effectiveFrom === b.effectiveFrom &&
    a.parametersHash === b.parametersHash
  );
}

/**
 * The tenant PPh 21 policy a run computes with. Before lock: the version in
 * force on the pay date (the default when the tenant published none), like
 * the statutory tables. From lock on: exactly the version pinned in the
 * snapshot, by id, whatever was published since (PAYR-02); a pinned `null`
 * keeps the default. A pinned version that is missing or changed, or a
 * frozen run without a snapshot, or pinned parameters that no longer hash to
 * the stored `parametersHash` -> PAYROLL_SNAPSHOT_MISMATCH. `ref` is what
 * the snapshot stores at lock (null = default).
 */
export function pph21PolicyForRun(
  run: {
    status: PayrollRunStatus;
    payDate: BusinessDate;
    configSnapshot: Pick<PayrollConfigSnapshot, "pph21Policy"> | null;
  },
  versions: readonly Pph21PolicyVersion[],
): { parameters: Pph21PolicyParameters; ref: Pph21PolicyRef | null } {
  if (!isPayrollRunFrozen(run.status)) {
    const parameters = resolvePph21Policy(versions, run.payDate);
    // resolvePph21Policy returns the stored object itself, or the default.
    const match = versions.find((v) => v.parameters === parameters);
    return { parameters, ref: match ? pph21PolicyRef(match) : null };
  }
  if (run.configSnapshot === null)
    throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  const ref = run.configSnapshot.pph21Policy;
  if (ref === null) return { parameters: DEFAULT_PPH21_POLICY, ref: null };
  const version = versions.find((v) => v.id === ref.versionId);
  if (
    !version ||
    version.version !== ref.version ||
    version.effectiveFrom !== ref.effectiveFrom ||
    pph21ParametersHash(version.parameters) !== ref.parametersHash
  )
    throw new PayrollError("PAYROLL_SNAPSHOT_MISMATCH");
  return { parameters: version.parameters, ref };
}

// ---- Run row --------------------------------------------------------------

export const payrollRunReversalSchema = z
  .strictObject({
    status: z.enum(["pending", "approved", "rejected"]),
    reason: z.string().trim().min(1).max(500),
    requestedBy: userIdSchema,
    requestedAt: isoDateTimeSchema,
    decidedBy: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((r, ctx) => {
    const decided = r.status !== "pending";
    if (
      (r.decidedBy !== null) !== decided ||
      (r.decidedAt !== null) !== decided
    )
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "decidedBy/decidedAt are set exactly after a decision",
      });
    if (r.decidedBy !== null && r.decidedBy === r.requestedBy)
      ctx.addIssue({
        code: "custom",
        path: ["decidedBy"],
        message: "A reversal is decided by someone other than its requester",
      });
  });
export type PayrollRunReversal = z.infer<typeof payrollRunReversalSchema>;

const STATUS_RANK: Record<PayrollRunStatus, number> = {
  draft: 0,
  simulated: 1,
  hr_approved: 2,
  approved: 3,
  locked: 4,
  paid: 5,
  reversed: 5,
};

/**
 * Why an overtime correction source was held back for an employee. Mirrors
 * the API's `OvertimeCorrectionHeldReason` (payroll-overtime-correction
 * service); keep the two in step.
 */
export const payrollOvertimeCorrectionHeldReasonSchema = z.enum([
  "offboarding",
  "employee_ended",
  "formula_missing",
  "approval_unclear",
  "source_unreadable",
  "overlapping_sources",
  "deduction_exceeds_paid",
]);
export type PayrollOvertimeCorrectionHeldReason = z.infer<
  typeof payrollOvertimeCorrectionHeldReasonSchema
>;

/**
 * One overtime correction source held back for one employee in a simulation:
 * nothing is paid or taken for it. `outstandingIdr` is signed (> 0 owed to the
 * employee, < 0 to the outlet) and null when the source could not be priced.
 */
export const payrollHeldOvertimeCorrectionSchema = z.strictObject({
  employeeId: employeeIdSchema,
  sourceRunId: payrollRunIdSchema,
  reason: payrollOvertimeCorrectionHeldReasonSchema,
  outstandingIdr: z.number().int().nullable(),
});
export type PayrollHeldOvertimeCorrection = z.infer<
  typeof payrollHeldOvertimeCorrectionSchema
>;

export const payrollRunSchema = z
  .strictObject({
    id: payrollRunIdSchema,
    tenantId: tenantIdSchema,
    legalEntityId: legalEntityIdSchema,
    payrollPolicyId: payrollPolicyIdSchema,
    runType: payrollRunTypeSchema,
    thrScheduleId: thrScheduleIdSchema.nullable(),
    periodStart: businessDateSchema,
    periodEnd: businessDateSchema,
    payDate: businessDateSchema,
    status: payrollRunStatusSchema,
    simulationCount: z.number().int().min(0).max(10_000),
    lastSimulatedAt: isoDateTimeSchema.nullable(),
    totals: payrollRunTotalsSchema.nullable(),
    configSnapshot: payrollConfigSnapshotSchema.nullable(),
    approvedByHr: userIdSchema.nullable(),
    approvedByHrAt: isoDateTimeSchema.nullable(),
    approvedByFinance: userIdSchema.nullable(),
    approvedByFinanceAt: isoDateTimeSchema.nullable(),
    lockedBy: userIdSchema.nullable(),
    lockedAt: isoDateTimeSchema.nullable(),
    paidBy: userIdSchema.nullable(),
    paidAt: isoDateTimeSchema.nullable(),
    reversal: payrollRunReversalSchema.nullable(),
    /** Only present on a simulate response; never part of the pay values. */
    heldOvertimeCorrections: z
      .array(payrollHeldOvertimeCorrectionSchema)
      .optional(),
    createdBy: userIdSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((run, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const rank = STATUS_RANK[run.status];
    if (run.periodEnd < run.periodStart)
      issue("periodEnd", "periodEnd cannot precede periodStart");
    if ((run.runType === "thr") !== (run.thrScheduleId !== null))
      issue("thrScheduleId", "A THR run names its schedule, others do not");
    const simulated = rank >= 1;
    if ((run.totals !== null) !== simulated)
      issue("totals", "totals exist exactly once the run is simulated");
    if ((run.configSnapshot !== null) !== simulated)
      issue("configSnapshot", "snapshot exists exactly once simulated");
    if (
      (run.lastSimulatedAt !== null) !== simulated ||
      run.simulationCount > 0 !== simulated
    )
      issue("simulationCount", "simulation markers follow the status");
    const pair = (
      by: unknown,
      at: unknown,
      expected: boolean,
      path: string,
    ) => {
      if ((by !== null) !== expected || (at !== null) !== expected)
        issue(path, `${path} is set exactly when the status requires it`);
    };
    pair(run.approvedByHr, run.approvedByHrAt, rank >= 2, "approvedByHr");
    pair(
      run.approvedByFinance,
      run.approvedByFinanceAt,
      rank >= 3,
      "approvedByFinance",
    );
    pair(run.lockedBy, run.lockedAt, rank >= 4, "lockedAt");
    pair(run.paidBy, run.paidAt, run.status === "paid", "paidAt");
    if (run.approvedByHr !== null && run.approvedByHr === run.approvedByFinance)
      issue(
        "approvedByFinance",
        "The two approvals come from different people",
      );
    if (run.reversal !== null && rank < 4)
      issue("reversal", "Only a locked run can carry a reversal");
    if (run.status === "reversed" && run.reversal?.status !== "approved")
      issue("reversal", "A reversed run has an approved reversal");
    if (run.status === "locked" && run.reversal?.status === "approved")
      issue("reversal", "An approved reversal moves the run to reversed");
    if (run.status === "paid" && run.reversal?.status === "approved")
      issue(
        "reversal",
        "A paid run cannot carry an approved reversal (correct it in a later run)",
      );
  });
export type PayrollRun = z.infer<typeof payrollRunSchema>;

// ---- Reducer ------------------------------------------------------------

export type PayrollRunCommand =
  | {
      action: "simulate";
      at: IsoDateTime;
      totals: PayrollRunTotals;
      configSnapshot: PayrollConfigSnapshot;
    }
  | { action: "return_to_draft"; at: IsoDateTime }
  | { action: "approve_hr"; actorId: UserId; at: IsoDateTime }
  | { action: "approve_final"; actorId: UserId; at: IsoDateTime }
  | { action: "lock"; actorId: UserId; at: IsoDateTime }
  | { action: "mark_paid"; actorId: UserId; at: IsoDateTime }
  | {
      action: "request_reversal";
      actorId: UserId;
      reason: string;
      at: IsoDateTime;
    }
  | { action: "reject_reversal"; actorId: UserId; at: IsoDateTime }
  | { action: "approve_reversal"; actorId: UserId; at: IsoDateTime };

/**
 * Applies one command and returns the next run row (pure). Permission checks
 * (payroll.run / payroll.approve / payroll.lock / payroll.cancel.approve) are
 * the route's job; this enforces order, approvals and distinct approvers.
 */
export function applyPayrollRunCommand(
  run: PayrollRun,
  command: PayrollRunCommand,
): PayrollRun {
  const status = nextPayrollRunStatus(run.status, command.action);
  const base = { ...run, status, updatedAt: command.at };
  switch (command.action) {
    case "simulate":
      return {
        ...base,
        simulationCount: run.simulationCount + 1,
        lastSimulatedAt: command.at,
        totals: command.totals,
        configSnapshot: command.configSnapshot,
      };
    case "return_to_draft":
      return {
        ...base,
        simulationCount: 0,
        lastSimulatedAt: null,
        totals: null,
        configSnapshot: null,
        approvedByHr: null,
        approvedByHrAt: null,
        approvedByFinance: null,
        approvedByFinanceAt: null,
      };
    case "approve_hr":
      return {
        ...base,
        approvedByHr: command.actorId,
        approvedByHrAt: command.at,
      };
    case "approve_final":
      if (run.approvedByHr === null)
        throw new PayrollError("PAYROLL_RUN_NOT_APPROVED");
      if (command.actorId === run.approvedByHr)
        throw new PayrollError("PAYROLL_APPROVER_NOT_DISTINCT");
      return {
        ...base,
        approvedByFinance: command.actorId,
        approvedByFinanceAt: command.at,
      };
    case "lock":
      // PAYR-01: only a run approved at both levels by two people locks.
      if (
        run.approvedByHr === null ||
        run.approvedByFinance === null ||
        run.approvedByHr === run.approvedByFinance ||
        run.totals === null ||
        run.configSnapshot === null
      )
        throw new PayrollError("PAYROLL_RUN_NOT_APPROVED");
      return { ...base, lockedBy: command.actorId, lockedAt: command.at };
    case "mark_paid":
      if (run.reversal?.status === "pending")
        throw new PayrollError("PAYROLL_RUN_INVALID_TRANSITION");
      return { ...base, paidBy: command.actorId, paidAt: command.at };
    case "request_reversal":
      if (run.reversal?.status === "pending")
        throw new PayrollError("PAYROLL_RUN_INVALID_TRANSITION");
      return {
        ...base,
        reversal: {
          status: "pending",
          reason: command.reason,
          requestedBy: command.actorId,
          requestedAt: command.at,
          decidedBy: null,
          decidedAt: null,
        },
      };
    case "reject_reversal":
    case "approve_reversal": {
      const reversal = run.reversal;
      if (reversal?.status !== "pending")
        throw new PayrollError("PAYROLL_RUN_INVALID_TRANSITION");
      if (command.actorId === reversal.requestedBy)
        throw new PayrollError("PAYROLL_APPROVER_NOT_DISTINCT");
      return {
        ...base,
        reversal: {
          ...reversal,
          status:
            command.action === "approve_reversal" ? "approved" : "rejected",
          decidedBy: command.actorId,
          decidedAt: command.at,
        },
      };
    }
  }
}

// ---- Request inputs -----------------------------------------------------

export const createPayrollRunInputSchema = clientInputSchema({
  payrollPolicyId: payrollPolicyIdSchema,
  runType: payrollRunTypeSchema,
  /** Any date inside the wanted period; the server derives the period. */
  referenceDate: businessDateSchema,
  thrScheduleId: thrScheduleIdSchema.nullable(),
  idempotencyKey: idempotencyKeySchema,
});
export type CreatePayrollRunInput = z.infer<typeof createPayrollRunInputSchema>;

/** Body of every run action route; the action is the route itself. */
export const payrollRunActionInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
});

/**
 * HR approval is bound to the simulation HR reviewed: the count must still be
 * the run's `simulationCount`, else PAYROLL_RUN_SIMULATION_STALE (409).
 */
export const approvePayrollRunHrInputSchema = clientInputSchema({
  expectedSimulationCount: z.number().int().min(1).max(10_000),
  idempotencyKey: idempotencyKeySchema,
});

export const requestPayrollRunReversalInputSchema = clientInputSchema({
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: idempotencyKeySchema,
});

export const decidePayrollRunReversalInputSchema = clientInputSchema({
  action: z.enum(["approve", "reject"]),
  idempotencyKey: idempotencyKeySchema,
});
