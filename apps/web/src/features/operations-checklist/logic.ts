// Pure helpers for the checklist board, execution screen and template builder.
// Every rule that already exists in the contract is imported, never copied:
// `isChecklistRunOverdue`, `checklistAlertDeadline` (OPS-01, PRD v1.7 §3 F41),
// `checklistCompletionStatus`, `checklistItemResultIssues`. No React and no
// fetching, so the screens stay thin and the rules stay testable by name.
import { decimal4Schema } from "@starter/shared/core";
import type { MessageKey, Translate } from "@starter/shared/i18n";
import {
  checklistAlertDeadline,
  checklistCompletionStatus,
  checklistItemResultIssues,
  isChecklistRunOverdue,
  type ChecklistEvidenceKind,
  type ChecklistItem,
  type ChecklistItemResult,
  type ChecklistRun,
  type ChecklistRunStatus,
  type ChecklistTemplate,
  type ChecklistTemplateType,
} from "@starter/shared/operations";
import { ApiError } from "@/lib/api/errors";

/** Filter value meaning "no restriction". */
export const ALL = "all";

export type RunFilter = {
  shiftTemplateId: string;
  stationId: string;
  zoneId: string;
};

export const EMPTY_FILTER: RunFilter = {
  shiftTemplateId: ALL,
  stationId: ALL,
  zoneId: ALL,
};

/** Shift/station/zone a run works in. The run snapshots items, not the
 *  schedule, so the scope comes from the template the run was created from. */
export type RunScope = {
  shiftTemplateId: string | null;
  stationId: string | null;
  zoneId: string | null;
};

export function runScope(
  run: Pick<ChecklistRun, "shiftTemplateId">,
  template: ChecklistTemplate | undefined,
): RunScope {
  return {
    shiftTemplateId:
      run.shiftTemplateId ?? template?.schedule.shiftTemplateId ?? null,
    stationId: template?.schedule.stationId ?? null,
    zoneId: template?.schedule.zoneId ?? null,
  };
}

export type RunRow = {
  run: ChecklistRun;
  template: ChecklistTemplate | undefined;
  scope: RunScope;
};

export function runProgress(run: ChecklistRun): {
  done: number;
  failed: number;
  total: number;
} {
  const finished = run.results.filter((result) => result.status !== "pending");
  return {
    done: finished.length,
    failed: finished.filter((result) => result.status === "failed").length,
    total: run.items.length,
  };
}

export function resultOf(
  run: ChecklistRun,
  itemId: string,
): ChecklistItemResult | undefined {
  return run.results.find((result) => result.itemId === itemId);
}

export type ChecklistEscalation = "none" | "grace" | "reported";

/**
 * OPS-01 (PRD v1.7 §6 acceptance): a missed or failed checklist is reported to
 * the supervisor; a run still open past its deadline gets 15 minutes
 * (`CHECKLIST_ALERT_GRACE_MINUTES`) before the report is shown as sent.
 */
export function escalationOf(
  run: Pick<ChecklistRun, "dueAt" | "status">,
  nowMs: number,
): ChecklistEscalation {
  if (run.status === "missed" || run.status === "failed") return "reported";
  if (!isChecklistRunOverdue(run, new Date(nowMs))) return "none";
  return nowMs > Date.parse(checklistAlertDeadline(run.dueAt))
    ? "reported"
    : "grace";
}

/** The board's "Perlu tindakan" definition: overdue, missed or with a failed
 *  item (OPS-01 covers both missed and failed checklists). */
export function needsAction(
  run: Pick<ChecklistRun, "dueAt" | "status" | "results">,
  nowMs: number,
): boolean {
  if (run.results.some((result) => result.status === "failed")) return true;
  return escalationOf(run, nowMs) !== "none";
}

/** The contract rule for "past its deadline while still unfinished". */
export function isOverdueNow(
  run: Pick<ChecklistRun, "dueAt" | "status">,
  nowMs: number,
): boolean {
  return isChecklistRunOverdue(run, new Date(nowMs));
}

export function remainingMs(run: Pick<ChecklistRun, "dueAt">, nowMs: number) {
  return Date.parse(run.dueAt) - nowMs;
}

/** "Sisa 2 j 5 mnt" / "Terlambat 45 mnt" from a duration in milliseconds. */
export function formatDuration(durationMs: number, t: Translate): string {
  const minutes = Math.floor(Math.abs(durationMs) / 60_000);
  if (minutes < 1) return t("opsChecklist.runs.durationLessThanMinute");
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return t("opsChecklist.runs.durationMinutes", { minutes });
  return t("opsChecklist.runs.durationHoursMinutes", {
    hours,
    minutes: minutes % 60,
  });
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(
  cache: Map<string, Intl.DateTimeFormat>,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const existing = cache.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat("id-ID", {
    ...options,
    timeZone,
  });
  cache.set(timeZone, created);
  return created;
}

/** Outlet-local date and time, e.g. "1 Nov 2026, 23.15" (D-CORE-6). */
export function formatDateTime(iso: string, timeZone: string): string {
  return formatterFor(dateTimeFormatters, timeZone, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Needs-action rows first, then the nearest deadline; closed rows last. */
export function sortRuns(rows: readonly RunRow[], nowMs: number): RunRow[] {
  return [...rows].sort((left, right) => {
    const leftAction = needsAction(left.run, nowMs) ? 0 : 1;
    const rightAction = needsAction(right.run, nowMs) ? 0 : 1;
    if (leftAction !== rightAction) return leftAction - rightAction;
    return Date.parse(left.run.dueAt) - Date.parse(right.run.dueAt);
  });
}

export function filterRows(
  rows: readonly RunRow[],
  filter: RunFilter,
): RunRow[] {
  return rows.filter(({ scope }) => {
    if (
      filter.shiftTemplateId !== ALL &&
      scope.shiftTemplateId !== filter.shiftTemplateId
    )
      return false;
    if (filter.stationId !== ALL && scope.stationId !== filter.stationId)
      return false;
    if (filter.zoneId !== ALL && scope.zoneId !== filter.zoneId) return false;
    return true;
  });
}

export function countBy(
  rows: readonly RunRow[],
  keyOf: (scope: RunScope) => string | null,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { scope } of rows) {
    const key = keyOf(scope);
    if (key === null) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Distinct non-null values in first-seen order. */
export function distinctValues(
  rows: readonly RunRow[],
  keyOf: (scope: RunScope) => string | null,
): string[] {
  const seen = new Set<string>();
  for (const { scope } of rows) {
    const key = keyOf(scope);
    if (key !== null) seen.add(key);
  }
  return [...seen];
}

export type RunOutcome = {
  ready: boolean;
  outcome: "completed" | "failed" | null;
};

/**
 * Contract gate before the close button: every snapshot item needs a finished
 * result with its required evidence (`checklistCompletionStatus` in
 * machines.ts). A failed item makes the run fail, so the button says so.
 */
export function runOutcome(run: ChecklistRun): RunOutcome {
  const finished = run.items.every((item) => {
    const result = resultOf(run, item.id);
    return (
      result !== undefined &&
      result.status !== "pending" &&
      checklistItemResultIssues(item, result).length === 0
    );
  });
  if (!finished) return { ready: false, outcome: null };
  try {
    return {
      ready: true,
      outcome: checklistCompletionStatus(run.items, run.results),
    };
  } catch {
    return { ready: false, outcome: null };
  }
}

/** Evidence labels in contract order, joined for one item. */
export function evidenceSummary(item: ChecklistItem, t: Translate): string {
  if (item.requiredEvidence.length === 0)
    return t("opsChecklist.run.evidenceNone");
  return [...item.requiredEvidence]
    .map((kind) => t(evidenceLabelKey(kind)))
    .join(", ");
}

export function evidenceLabelKey(kind: ChecklistEvidenceKind): MessageKey {
  switch (kind) {
    case "photo":
      return "opsChecklist.run.evidence.photo";
    case "number":
      return "opsChecklist.run.evidence.number";
    case "signature":
      return "opsChecklist.run.evidence.signature";
  }
}

export function statusLabelKey(status: ChecklistRunStatus): MessageKey {
  switch (status) {
    case "pending":
      return "opsChecklist.runs.status.pending";
    case "in_progress":
      return "opsChecklist.runs.status.in_progress";
    case "completed":
      return "opsChecklist.runs.status.completed";
    case "missed":
      return "opsChecklist.runs.status.missed";
    case "failed":
      return "opsChecklist.runs.status.failed";
  }
}

export function statusPillKind(
  status: ChecklistRunStatus,
): "info" | "success" | "warning" | "danger" {
  switch (status) {
    case "pending":
      // The design system has no plain-neutral StatusPill; `info` is the
      // quietest tone (same choice as ws10-payroll-run).
      return "info";
    case "in_progress":
      return "info";
    case "completed":
      return "success";
    case "missed":
      return "warning";
    case "failed":
      return "danger";
  }
}

export function typeLabelKey(type: ChecklistTemplateType): MessageKey {
  switch (type) {
    case "opening":
      return "opsChecklist.runs.type.opening";
    case "closing":
      return "opsChecklist.runs.type.closing";
    case "cleaning":
      return "opsChecklist.runs.type.cleaning";
    case "shift":
      return "opsChecklist.runs.type.shift";
  }
}

/** Indonesian decimal separator is a comma; the contract takes a dot. Empty
 *  input is `null`, an invalid number also `null` (callers tell them apart by
 *  the raw value). */
export function normalizeDecimalInput(input: string): string | null {
  const cleaned = input.trim().replace(",", ".");
  if (cleaned === "") return null;
  return decimal4Schema.safeParse(cleaned).success ? cleaned : null;
}

/** Error text for a failed write; contract codes map to catalog copy. */
export function runErrorMessageKey(
  error: unknown,
  fallback: MessageKey,
): MessageKey {
  const code = error instanceof ApiError ? error.code : "";
  switch (code) {
    case "CHECKLIST_ITEM_INCOMPLETE":
      return "opsChecklist.run.item.evidenceMissing";
    case "CHECKLIST_TRANSITION_INVALID":
      return "opsChecklist.run.transitionFailed";
    case "CHECKLIST_ITEM_NOT_IN_RUN":
      return "opsChecklist.run.item.saveFailed";
    default:
      return fallback;
  }
}
