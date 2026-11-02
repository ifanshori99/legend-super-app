// Pure helpers of the WS-10 lifecycle screens (bead legend-u3x3; PRD v1.7 §3
// Kelompok D 26 "Onboarding"/"Offboarding", §4 Alur M): the derived checklist
// views, the template that applies to a position, and the fixture-only
// previews of the final settlement and the work certificate. No React, no
// fetching.
//
// The contract owns the task lifecycle: `transitionChecklistTask` decides which
// action is legal and `isChecklistComplete` decides when a checklist closes, so
// this file never re-implements either rule.
import { cafeLegendFixtures } from "@starter/shared/core";
import {
  cafeLegendHrisFixtures,
  checklistCategorySchema,
  isChecklistComplete,
  transitionChecklistTask,
  type ChecklistAction,
  type ChecklistCategory,
  type ChecklistKind,
  type ChecklistTask,
  type ChecklistTaskStatus,
  type ChecklistTemplate,
  type Employee,
  type EmployeeStatus,
} from "@starter/shared/hris";
import { cafeLegendPayrollFixtures } from "@starter/shared/hris/payroll";
import type { MessageKey } from "@starter/shared/i18n";

/** The back office lists the whole directory; screens filter in memory. */
export const LIST_LIMIT = 100;

/** Contract order of the checklist categories (PRD F24). */
export const CATEGORY_ORDER: readonly ChecklistCategory[] =
  checklistCategorySchema.options;

/** Every action of the contract's state machine, in display order. */
export const TASK_ACTIONS: readonly ChecklistAction[] = [
  "complete",
  "block",
  "unblock",
  "waive",
];

export const EMPLOYEE_STATUS_LABEL: Record<EmployeeStatus, MessageKey> = {
  onboarding: "lifecycle.employeeStatus.onboarding",
  active: "lifecycle.employeeStatus.active",
  suspended: "lifecycle.employeeStatus.suspended",
  resigned: "lifecycle.employeeStatus.resigned",
  terminated: "lifecycle.employeeStatus.terminated",
};

export const TASK_STATUS_LABEL: Record<ChecklistTaskStatus, MessageKey> = {
  open: "lifecycle.taskStatus.open",
  done: "lifecycle.taskStatus.done",
  blocked: "lifecycle.taskStatus.blocked",
  waived: "lifecycle.taskStatus.waived",
};

export const CATEGORY_LABEL: Record<ChecklistCategory, MessageKey> = {
  documents: "lifecycle.category.documents",
  uniform: "lifecycle.category.uniform",
  account: "lifecycle.category.account",
  training: "lifecycle.category.training",
  asset: "lifecycle.category.asset",
  access_revocation: "lifecycle.category.access_revocation",
  final_settlement: "lifecycle.category.final_settlement",
  work_certificate: "lifecycle.category.work_certificate",
  other: "lifecycle.category.other",
};

export const ACTION_LABEL: Record<ChecklistAction, MessageKey> = {
  complete: "lifecycle.actions.complete",
  block: "lifecycle.actions.block",
  unblock: "lifecycle.actions.unblock",
  waive: "lifecycle.actions.waive",
};

/** "2026-10-31" → "31 Okt 2026", locale-stable (id-ID, UTC). */
export function formatBusinessDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** An ISO timestamp as a date in the outlet's zone ("1 Nov 2026"). */
export function formatDateTimeDate(value: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

/**
 * The checklist templates of one kind. There is no template endpoint yet, so
 * the screens read the shared fixture (follow-up bead).
 */
export function templatesFor(kind: ChecklistKind): ChecklistTemplate[] {
  return cafeLegendHrisFixtures.checklistTemplates.filter(
    (template) => template.kind === kind,
  );
}

/**
 * The checklist template that applies to one employee: the position's own
 * template first, then the tenant default (positionId null) of the same kind.
 */
export function templateForPosition(
  templates: readonly ChecklistTemplate[],
  kind: ChecklistKind,
  positionId: string | null,
): ChecklistTemplate | null {
  const ofKind = templates.filter((template) => template.kind === kind);
  return (
    (positionId === null
      ? undefined
      : ofKind.find((template) => template.positionId === positionId)) ??
    ofKind.find((template) => template.positionId === null) ??
    null
  );
}

/**
 * Tasks in template order (the template item's `sortOrder`), so a checklist
 * reads the same way the position's template was written. Tasks the template
 * does not name keep their title order at the end.
 */
export function orderedTasks(
  tasks: readonly ChecklistTask[],
  template: ChecklistTemplate | null,
): ChecklistTask[] {
  const order = new Map(
    (template?.items ?? []).map((item) => [item.code, item.sortOrder]),
  );
  return [...tasks].sort(
    (left, right) =>
      (order.get(left.code) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(right.code) ?? Number.MAX_SAFE_INTEGER) ||
      left.title.localeCompare(right.title, "id-ID"),
  );
}

export type ChecklistProgress = {
  total: number;
  done: number;
  waived: number;
  open: number;
  blocked: number;
  /** done + waived: what the contract counts as complete. */
  complete: number;
  /** 0–100, rounded; 0 when there is no task yet. */
  percent: number;
};

export function checklistProgress(
  tasks: readonly ChecklistTask[],
): ChecklistProgress {
  const progress: ChecklistProgress = {
    total: tasks.length,
    done: 0,
    waived: 0,
    open: 0,
    blocked: 0,
    complete: 0,
    percent: 0,
  };
  for (const task of tasks) {
    if (task.status === "done") progress.done += 1;
    else if (task.status === "waived") progress.waived += 1;
    else if (task.status === "blocked") progress.blocked += 1;
    else progress.open += 1;
  }
  progress.complete = progress.done + progress.waived;
  progress.percent =
    progress.total === 0
      ? 0
      : Math.round((progress.complete / progress.total) * 100);
  return progress;
}

/** True when every task is done or waived — the contract's own rule. */
export function clearanceComplete(tasks: readonly ChecklistTask[]): boolean {
  return tasks.length > 0 && isChecklistComplete(tasks);
}

/** Grouped checklist, in the contract's category order, empty groups dropped. */
export function groupTasksByCategory(
  tasks: readonly ChecklistTask[],
  template: ChecklistTemplate | null,
): { category: ChecklistCategory; tasks: ChecklistTask[] }[] {
  const ordered = orderedTasks(tasks, template);
  return CATEGORY_ORDER.map((category) => ({
    category,
    tasks: ordered.filter((task) => task.category === category),
  })).filter((group) => group.tasks.length > 0);
}

/**
 * The actions the contract allows from this status. Asking the state machine
 * itself keeps the buttons and the transition in one place: a new state never
 * offers an action the contract would reject.
 */
export function availableActions(
  status: ChecklistTaskStatus,
): ChecklistAction[] {
  return TASK_ACTIONS.filter((action) => {
    try {
      transitionChecklistTask(status, action);
      return true;
    } catch {
      return false;
    }
  });
}

// ---- Employees ------------------------------------------------------------

/** The position name of an employee, or an em dash when the catalog misses it. */
export function positionName(
  positions: readonly { id: string; name: string }[],
  positionId: string | null,
): string {
  if (positionId === null) return "—";
  return positions.find((position) => position.id === positionId)?.name ?? "—";
}

/** The org unit name of an employee, or an em dash. */
export function orgUnitName(
  orgUnits: readonly { id: string; name: string }[],
  orgUnitId: string | null,
): string {
  if (orgUnitId === null) return "—";
  return orgUnits.find((unit) => unit.id === orgUnitId)?.name ?? "—";
}

/**
 * The outlet name of an employee. The outlet context (session/device) has not
 * landed yet, so the screens read the shared core fixtures — the same two
 * outlets the HRIS fixtures place people in.
 */
export function outletName(outletId: string): string {
  return (
    cafeLegendFixtures.outlets.find((outlet) => outlet.id === outletId)?.name ??
    "—"
  );
}

/** Employees shown on the onboarding list: onboarding, plus active ones. */
export function onboardingCandidates(
  employees: readonly Employee[],
): Employee[] {
  return employees.filter(
    (employee) =>
      employee.status === "onboarding" || employee.status === "active",
  );
}

/**
 * Employees shown on the offboarding list: anyone leaving (resigned or
 * terminated), plus anyone who already has an offboarding task.
 */
export function offboardingCandidates(
  employees: readonly Employee[],
  tasksByEmployee: ReadonlyMap<string, readonly ChecklistTask[]>,
): Employee[] {
  return employees.filter(
    (employee) =>
      employee.status === "resigned" ||
      employee.status === "terminated" ||
      (tasksByEmployee.get(employee.id)?.length ?? 0) > 0,
  );
}

// ---- Final settlement (fixture-only preview) ------------------------------

export type SettlementPreview = {
  lastPayslip: {
    netIdr: number;
    payDate: string;
    periodEnd: string;
  } | null;
  /** Sum of the instalments still owed on approved/disbursed kasbon. */
  loanOutstandingIdr: number | null;
  loanCount: number;
  /** Claims submitted or approved but not paid out yet. */
  reimbursementOutstandingIdr: number | null;
  reimbursementCount: number;
};

/**
 * What the payroll fixtures already know about one employee's exit.
 *
 * There is no final-settlement endpoint (PRD §3 D26 "perhitungan hak akhir"
 * has no contract yet), so this is a read-only preview of the source rows:
 * the last payslip's net, the outstanding kasbon and the unpaid reimbursement.
 * It deliberately adds no total and no formula — the entitlement (pesangon,
 * sisa cuti, potongan) is the API's calculation, not the screen's.
 */
export function finalSettlementPreview(employeeId: string): SettlementPreview {
  const payslips = cafeLegendPayrollFixtures.payslips
    .filter((payslip) => payslip.employeeId === employeeId)
    .sort((left, right) => right.payDate.localeCompare(left.payDate));
  const latest = payslips[0] ?? null;

  const loans = cafeLegendPayrollFixtures.employeeLoans.filter(
    (loan) =>
      loan.employeeId === employeeId &&
      (loan.status === "approved" || loan.status === "disbursed") &&
      loan.outstandingIdr > 0,
  );
  const loanOutstandingIdr = loans.reduce(
    (sum, loan) => sum + loan.outstandingIdr,
    0,
  );

  const claims = cafeLegendPayrollFixtures.reimbursements.filter(
    (claim) =>
      claim.employeeId === employeeId &&
      (claim.status === "submitted" || claim.status === "approved"),
  );
  const reimbursementOutstandingIdr = claims.reduce(
    (sum, claim) => sum + (claim.approvedAmountIdr ?? claim.amountIdr),
    0,
  );

  return {
    lastPayslip:
      latest === null
        ? null
        : {
            netIdr: latest.netIdr,
            payDate: latest.payDate,
            periodEnd: latest.periodEnd,
          },
    loanOutstandingIdr: loans.length === 0 ? null : loanOutstandingIdr,
    loanCount: loans.length,
    reimbursementOutstandingIdr:
      claims.length === 0 ? null : reimbursementOutstandingIdr,
    reimbursementCount: claims.length,
  };
}

// ---- Work certificate (local preview) -------------------------------------

/**
 * Certificate number of the local preview. The API will issue the real number
 * (there is no certificate endpoint yet); deriving it from the employee id
 * keeps the preview stable across renders without inventing a registry.
 */
export function certificateNumber(employeeId: string): string {
  const digits = employeeId.replace(/\D/g, "");
  return `SK-${digits.slice(-4)}`;
}

export type CertificateInput = {
  employee: Employee;
  positionName: string;
  outletName: string;
  managerName: string | null;
  company: string;
  number: string;
};

/** The values the certificate sheet prints, from the employee row. */
export function certificateFor(
  employee: Employee,
  positions: readonly { id: string; name: string }[],
  employees: readonly Employee[],
): CertificateInput {
  const manager =
    employee.managerId === null
      ? null
      : (employees.find((row) => row.id === employee.managerId) ?? null);
  return {
    employee,
    positionName: positionName(positions, employee.positionId),
    outletName: outletName(employee.homeOutletId),
    managerName: manager?.fullName ?? null,
    company: cafeLegendFixtures.legalEntityName,
    number: certificateNumber(employee.id),
  };
}

/** Loading/empty/error screenshots: ?mock=<scenario> must skip SSR loaders. */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}
