// Pure helpers of the WS-10 lifecycle screens (bead legend-u3x3; PRD v1.7 §3
// Kelompok D 26 "Onboarding"/"Offboarding", §4 Alur M): the derived checklist
// views, the template that applies to a position, and the fixture-only
// final-settlement estimate (payroll contract math only) and the work
// certificate preview. No React, no fetching.
//
// The contract owns the task lifecycle: `transitionChecklistTask` decides which
// action is legal and `isChecklistComplete` decides when a checklist closes, so
// this file never re-implements either rule.
import {
  cafeLegendFixtures,
  idr,
  type BusinessDate,
  type Idr,
} from "@starter/shared/core";
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
import {
  PayrollError,
  computeThr,
  resolveStatutoryTable,
  type EmployeePayComponent,
  type PayComponent,
  type Reimbursement,
  type StatutoryTableVersion,
  type StatutoryTableVersionOf,
} from "@starter/shared/hris/payroll";
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

// ---- Exit clearance ----------------------------------------------------------

/**
 * The tasks that still hold up an exit: every offboarding task that is not
 * done or waived, except the work certificate's own task — the certificate is
 * what clearance unlocks, so it cannot also be what blocks it.
 */
export function clearanceBlockers(
  tasks: readonly ChecklistTask[],
): ChecklistTask[] {
  return tasks.filter(
    (task) =>
      task.category !== "work_certificate" && !isChecklistComplete([task]),
  );
}

export type ExitClearance = {
  /** Clearance tasks (all but the certificate task) still open or blocked. */
  blockers: ChecklistTask[];
  /** True when there is at least one clearance task and none blocks. */
  cleared: boolean;
};

export function exitClearance(tasks: readonly ChecklistTask[]): ExitClearance {
  const blockers = clearanceBlockers(tasks);
  const clearanceTasks = tasks.filter(
    (task) => task.category !== "work_certificate",
  );
  return {
    blockers,
    cleared: clearanceTasks.length > 0 && blockers.length === 0,
  };
}

/**
 * Why the certificate cannot be issued yet, or null when it can: the employee
 * must have left (resigned/terminated with an exit date) and the exit
 * clearance must be complete (PRD §3 D26 "exit clearance ... dan surat
 * keterangan kerja").
 */
export function certificateLock(
  employee: Employee,
  clearance: ExitClearance,
): "notLeaving" | "clearanceOpen" | null {
  if (
    (employee.status !== "resigned" && employee.status !== "terminated") ||
    employee.endDate === null
  )
    return "notLeaving";
  if (!clearance.cleared) return "clearanceOpen";
  return null;
}

// ---- Final settlement (estimate from the payroll contract) ---------------

/**
 * The THR wage on one date: the sum of the employee's pay components in force
 * that day whose component counts toward the THR wage (`thrBase`, payroll
 * contract components.ts). Null when no such component is recorded.
 */
export function thrWageOn(
  rows: readonly EmployeePayComponent[],
  components: readonly PayComponent[],
  onDate: BusinessDate,
): Idr | null {
  const thrBase = new Set(
    components.filter((component) => component.thrBase).map((c) => c.id),
  );
  const inForce = rows.filter(
    (row) =>
      thrBase.has(row.componentId) &&
      row.effectiveFrom <= onDate &&
      (row.effectiveTo === null || row.effectiveTo >= onDate),
  );
  if (inForce.length === 0) return null;
  return idr(inForce.reduce((sum, row) => sum + row.amountIdr, 0));
}

export type ThrEstimate =
  | { kind: "ok"; tenureMonths: number; amountIdr: Idr; wageIdr: Idr }
  | { kind: "noExitDate" }
  | { kind: "noWage" }
  | { kind: "noTable" };

/** The published THR table in force on a date; null when none applies. */
function thrTableOn(
  tables: readonly StatutoryTableVersion[],
  onDate: BusinessDate,
): StatutoryTableVersionOf<"thr"> | null {
  try {
    return resolveStatutoryTable(tables, "thr", onDate);
  } catch (error) {
    if (error instanceof PayrollError) return null;
    throw error;
  }
}

/**
 * THR pro rata up to the exit date, computed only by the payroll contract:
 * `resolveStatutoryTable` picks the published THR table in force on the exit
 * date and `computeThr` counts tenure by exact date (31 Jan → 28 Feb = 0
 * months). It is an estimate: the payroll run that pays it is the source of
 * truth once locked.
 */
export function thrEstimate(input: {
  employee: Employee;
  tables: readonly StatutoryTableVersion[];
  rows: readonly EmployeePayComponent[];
  components: readonly PayComponent[];
}): ThrEstimate {
  const { employee } = input;
  if (employee.endDate === null) return { kind: "noExitDate" };
  const wage = thrWageOn(input.rows, input.components, employee.endDate);
  if (wage === null) return { kind: "noWage" };
  const table = thrTableOn(input.tables, employee.endDate);
  if (table === null) return { kind: "noTable" };
  const result = computeThr(table.parameters, {
    joinDate: employee.joinDate,
    asOfDate: employee.endDate,
    thrWageIdr: wage,
  });
  return { kind: "ok", ...result, wageIdr: wage };
}

/** Approved reimbursements not paid out yet (owed to the employee). */
export function unpaidReimbursements(claims: readonly Reimbursement[]): {
  count: number;
  amountIdr: Idr;
  /** Claims still waiting for a decision: not money owed yet. */
  pendingCount: number;
} {
  const approved = claims.filter((claim) => claim.status === "approved");
  return {
    count: approved.length,
    amountIdr: idr(
      approved.reduce(
        (sum, claim) => sum + (claim.approvedAmountIdr ?? claim.amountIdr),
        0,
      ),
    ),
    pendingCount: claims.filter((claim) => claim.status === "submitted").length,
  };
}

// ---- Work certificate (local preview) -------------------------------------

export type CertificateInput = {
  employee: Employee;
  positionName: string;
  outletName: string;
  managerName: string | null;
  company: string;
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
  };
}

/** Loading/empty/error screenshots: ?mock=<scenario> must skip SSR loaders. */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}

/**
 * The offboarding the settlement summary belongs to, named by the employee's
 * checklist tasks. A cancelled offboarding waives its open tasks but keeps
 * its done ones, and a new offboarding may follow, so an id counts only when
 * it is the one with open/blocked work, or the only one left on a non-waived
 * task. Two candidates and no open work: unknown (null), never a guess.
 */
export function liveOffboardingId(
  tasks: readonly {
    offboardingId: string | null;
    status: string;
  }[],
): string | null {
  const open = new Set<string>();
  const kept = new Set<string>();
  for (const task of tasks) {
    if (task.offboardingId === null || task.status === "waived") continue;
    kept.add(task.offboardingId);
    if (task.status === "open" || task.status === "blocked")
      open.add(task.offboardingId);
  }
  const pool = open.size > 0 ? open : kept;
  return pool.size === 1 ? ([...pool][0] ?? null) : null;
}
