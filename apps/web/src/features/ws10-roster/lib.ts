// Pure helpers of the weekly roster (bead legend-299s; PRD v1.7 §3 Kelompok D
// 28, F26, HR-05, AI-13). No React, no fetching. Every business rule that
// already exists in the contract is imported, never re-implemented:
// `weekStartOf`, `addBusinessDays`, `evaluateShiftCompliance`,
// `isRosterPublished`, `shiftTemplateCrossesMidnight`, `workedMinutes`.
import { businessDateOf } from "@starter/shared/core";
import {
  addBusinessDays,
  evaluateShiftCompliance,
  isRosterPublished,
  shiftAssignmentSchema,
  weekStartOf,
  workedMinutes,
  type Employee,
  type RosterPublication,
  type ShiftAssignment,
  type ShiftComplianceIssue,
  type ShiftTemplate,
} from "@starter/shared/hris";
import type { MessageKey } from "@starter/shared/i18n";
import { newIdempotencyKey } from "@/lib/idempotency";
import {
  ROSTER_COMPLIANCE_POLICY,
  ROSTER_TENANT_ID,
} from "./fixtures";
import {
  ROSTER_OUTLET_ID,
  ROSTER_TIME_ZONE,
  ROSTER_UTC_OFFSET,
} from "./outlet";

const DAY_FORMAT = new Intl.DateTimeFormat("id-ID", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const DAY_MONTH_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const LONG_DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const TIME_FORMAT = new Intl.DateTimeFormat("id-ID", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: ROSTER_TIME_ZONE,
});
const PUBLISHED_AT_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: ROSTER_TIME_ZONE,
});

/** The outlet's business date; the server derives published rows itself. */
export function todayBusinessDate(): string {
  return businessDateOf(new Date().toISOString(), ROSTER_TIME_ZONE);
}

export function currentWeekStart(): string {
  return weekStartOf(todayBusinessDate());
}

/** `?week=` (any day) → that ISO week's Monday; absent → the current week. */
export function normalizeWeekStart(value: string | undefined): string {
  return weekStartOf(value ?? todayBusinessDate());
}

/** Seven business dates, Monday first. */
export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, index) =>
    addBusinessDays(weekStart, index),
  );
}

export function weekEnd(weekStart: string): string {
  return addBusinessDays(weekStart, 6);
}

/** True for `?mock=empty|slow|error|offline`; a loader then stays client-side. */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}

/** "Sen, 26 Okt" — the grid column and menu labels. */
export function formatDayLabel(date: string): string {
  return DAY_FORMAT.format(new Date(`${date}T00:00:00.000Z`));
}

/** "26 Okt 2026". */
export function formatDateLabel(date: string): string {
  return LONG_DATE_FORMAT.format(new Date(`${date}T00:00:00.000Z`));
}

/** "26 Okt – 1 Nov 2026". */
export function formatWeekRange(weekStart: string): string {
  const end = weekEnd(weekStart);
  return `${DAY_MONTH_FORMAT.format(new Date(`${weekStart}T00:00:00.000Z`))} – ${LONG_DATE_FORMAT.format(new Date(`${end}T00:00:00.000Z`))}`;
}

/** "Diterbitkan 1 Nov 2026 09.00" (outlet time). */
export function formatPublishedAt(instant: string): string {
  return PUBLISHED_AT_FORMAT.format(new Date(instant));
}

/** "08.00" in the outlet time zone. */
export function formatTimeOfDay(instant: string): string {
  return TIME_FORMAT.format(new Date(instant));
}

/** First start → last end of an assignment's segments. */
export function formatShiftRange(
  assignment: Pick<ShiftAssignment, "segments">,
): string {
  const sorted = [...assignment.segments].sort(
    (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt),
  );
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return "";
  return `${formatTimeOfDay(first.startsAt)}–${formatTimeOfDay(last.endsAt)}`;
}

/** Template wall-clock text: "08.00–16.00" or "10.00–14.00, 17.00–21.00". */
export function formatTemplateSegments(
  template: Pick<ShiftTemplate, "segments">,
): string {
  return template.segments
    .map(
      (segment) =>
        `${segment.startTime.replace(":", ".")}–${segment.endTime.replace(":", ".")}`,
    )
    .join(", ");
}

function instantFor(date: string, time: string): string {
  return `${date}T${time}:00${ROSTER_UTC_OFFSET}`;
}

/**
 * A local draft assignment built from a template (PRD F28 "Template Shift" →
 * "Roster Mingguan"). The contract has no assignment write endpoint, so this
 * row never leaves the browser until it is published; the shape is the
 * contract's, validated here so the grid and compliance math see real data.
 */
export function draftFromTemplate(
  template: ShiftTemplate,
  employeeId: string,
  businessDate: string,
): ShiftAssignment {
  const segments = template.segments.map((segment) => {
    const crossesMidnight = segment.endTime <= segment.startTime;
    return {
      startsAt: instantFor(businessDate, segment.startTime),
      endsAt: instantFor(
        crossesMidnight ? addBusinessDays(businessDate, 1) : businessDate,
        segment.endTime,
      ),
    };
  });
  return shiftAssignmentSchema.parse({
    id: newIdempotencyKey(),
    tenantId: ROSTER_TENANT_ID,
    outletId: ROSTER_OUTLET_ID,
    employeeId,
    shiftTemplateId: template.id,
    stationId: template.stationId,
    businessDate,
    segments,
    breakMinutes: template.breakMinutes,
    status: "draft",
    source: "user",
    publishedBy: null,
    publishedAt: null,
  });
}

const WEEK_MS = 7 * 86_400_000;

/**
 * "Salin minggu lalu": copies a previous week's assignments one week forward as
 * drafts. Ids are new (the copied rows are new records); segment instants keep
 * their wall-clock time by absolute +7 days (Asia/Jakarta has no DST).
 */
export function copyWeekDrafts(
  previous: readonly ShiftAssignment[],
): ShiftAssignment[] {
  return previous
    .filter((assignment) => assignment.status !== "cancelled")
    .map((assignment) =>
      shiftAssignmentSchema.parse({
        ...assignment,
        id: newIdempotencyKey(),
        businessDate: addBusinessDays(assignment.businessDate, 7),
        segments: assignment.segments.map((segment) => ({
          startsAt: new Date(
            Date.parse(segment.startsAt) + WEEK_MS,
          ).toISOString(),
          endsAt: new Date(Date.parse(segment.endsAt) + WEEK_MS).toISOString(),
        })),
        status: "draft",
        source: "user",
        publishedBy: null,
        publishedAt: null,
      }),
    );
}

/**
 * The rows the grid shows: the published week when the local store has one
 * (the mock does not mutate the read model), otherwise the contract's
 * assignments, always with this device's drafts on top.
 */
export function mergeWeekRows(input: {
  base: readonly ShiftAssignment[];
  publication: RosterPublication | null;
  drafts: readonly ShiftAssignment[];
}): ShiftAssignment[] {
  const published = input.publication?.assignments ?? input.base;
  const draftIds = new Set(input.drafts.map((draft) => draft.id));
  const rows = published.filter(
    (assignment) =>
      assignment.status !== "cancelled" && !draftIds.has(assignment.id),
  );
  return [...rows, ...input.drafts].sort(
    (left, right) =>
      left.businessDate.localeCompare(right.businessDate) ||
      (left.segments[0]?.startsAt ?? "").localeCompare(
        right.segments[0]?.startsAt ?? "",
      ) ||
      left.id.localeCompare(right.id),
  );
}

export type WeekStatus = "empty" | "draft" | "published";

export function weekStatusOf(rows: readonly ShiftAssignment[]): WeekStatus {
  if (rows.length === 0) return "empty";
  if (rows.some((row) => row.status === "draft")) return "draft";
  return isRosterPublished(rows) ? "published" : "draft";
}

export type WeekCompliance = {
  issues: ShiftComplianceIssue[];
  byAssignment: Map<string, ShiftComplianceIssue[]>;
  total: number;
};

/**
 * F26 compliance warnings for the week, evaluated by the contract. The
 * previous week's rows are included so a late Sunday shift is measured against
 * Monday's rest; only issues on this week's assignments surface in the grid.
 */
export function evaluateWeekCompliance(
  rows: readonly ShiftAssignment[],
  previousRows: readonly ShiftAssignment[] = [],
): WeekCompliance {
  const currentIds = new Set(rows.map((row) => row.id));
  const issues = evaluateShiftCompliance(
    [...previousRows, ...rows],
    ROSTER_COMPLIANCE_POLICY,
  ).filter((issue) => currentIds.has(issue.assignmentId));
  const byAssignment = new Map<string, ShiftComplianceIssue[]>();
  for (const issue of issues) {
    const list = byAssignment.get(issue.assignmentId) ?? [];
    list.push(issue);
    byAssignment.set(issue.assignmentId, list);
  }
  return { issues, byAssignment, total: issues.length };
}

export function complianceMessageKey(
  code: ShiftComplianceIssue["code"],
): MessageKey {
  switch (code) {
    case "shift_too_long":
      return "roster.compliance.shift_too_long";
    case "daily_limit_exceeded":
      return "roster.compliance.daily_limit_exceeded";
    case "weekly_limit_exceeded":
      return "roster.compliance.weekly_limit_exceeded";
    case "insufficient_rest":
      return "roster.compliance.insufficient_rest";
    case "overlapping_shift":
      return "roster.compliance.overlapping_shift";
    case "too_many_consecutive_days":
      return "roster.compliance.too_many_consecutive_days";
  }
}

export function totalWorkedMinutes(
  rows: readonly Pick<ShiftAssignment, "segments" | "breakMinutes">[],
): number {
  return rows.reduce((sum, row) => sum + workedMinutes(row), 0);
}

// ---- AI-13 staffing suggestions ------------------------------------------

export type RosterSuggestion = {
  /** Deterministic: date + employee + template. */
  id: string;
  businessDate: string;
  employeeId: string;
  templateId: string | null;
  /** Employees still missing against the busiest day's headcount. */
  missing: number;
  /** Headcount of the busiest day this week. */
  target: number;
};

const MAX_SUGGESTIONS_PER_DAY = 3;
const MAX_SUGGESTIONS = 6;

/**
 * PRD §3 Kelompok D 28 "Saran Jadwal (AI-13)" wants a roster suggestion from
 * the covers forecast, skills, preferences and labour-cost target. None of
 * those inputs has an endpoint yet, so this is a deterministic coverage-gap
 * heuristic instead: the busiest day's headcount is the target, and each
 * thinner day gets the least-scheduled active employees (same-position people
 * first) with the template they already work. It is labelled as a suggestion
 * in the panel and never assigns automatically.
 */
export function staffingSuggestions(input: {
  weekStart: string;
  assignments: readonly ShiftAssignment[];
  employees: readonly Employee[];
  templates: readonly ShiftTemplate[];
}): RosterSuggestion[] {
  const activeEmployees = input.employees.filter(
    (employee) => employee.status === "active",
  );
  const templates = input.templates.filter((template) => template.isActive);
  const rows = input.assignments.filter(
    (assignment) => assignment.status !== "cancelled",
  );
  if (activeEmployees.length === 0 || rows.length === 0) return [];

  const days = weekDays(input.weekStart);
  const byDate = new Map<string, ShiftAssignment[]>();
  for (const row of rows) {
    const list = byDate.get(row.businessDate) ?? [];
    list.push(row);
    byDate.set(row.businessDate, list);
  }
  const busiest = Math.max(
    ...days.map(
      (day) => new Set((byDate.get(day) ?? []).map((row) => row.employeeId)).size,
    ),
  );
  if (busiest === 0) return [];

  const shiftsPerEmployee = new Map<string, number>();
  for (const row of rows)
    shiftsPerEmployee.set(
      row.employeeId,
      (shiftsPerEmployee.get(row.employeeId) ?? 0) + 1,
    );

  const templateCounts = new Map<string, number>();
  const employeeTemplates = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (row.shiftTemplateId === null) continue;
    templateCounts.set(
      row.shiftTemplateId,
      (templateCounts.get(row.shiftTemplateId) ?? 0) + 1,
    );
    const perEmployee =
      employeeTemplates.get(row.employeeId) ?? new Map<string, number>();
    perEmployee.set(
      row.shiftTemplateId,
      (perEmployee.get(row.shiftTemplateId) ?? 0) + 1,
    );
    employeeTemplates.set(row.employeeId, perEmployee);
  }
  const mostUsed = (counts: Map<string, number> | undefined): string | null => {
    if (!counts) return null;
    let bestId: string | null = null;
    let bestCount = -1;
    for (const [id, count] of counts)
      if (
        count > bestCount ||
        (count === bestCount && (bestId === null || id < bestId))
      ) {
        bestId = id;
        bestCount = count;
      }
    return bestId;
  };
  const overallTemplate = mostUsed(templateCounts) ?? templates[0]?.id ?? null;

  const suggestions: RosterSuggestion[] = [];
  for (const day of days) {
    if (suggestions.length >= MAX_SUGGESTIONS) break;
    const dayRows = byDate.get(day) ?? [];
    const scheduled = new Set(dayRows.map((row) => row.employeeId));
    const scheduledPositions = new Set<string>();
    for (const row of dayRows) {
      const employee = activeEmployees.find(
        (candidate) => candidate.id === row.employeeId,
      );
      if (employee?.positionId) scheduledPositions.add(employee.positionId);
    }
    const missing = busiest - scheduled.size;
    if (missing <= 0) continue;
    const candidates = activeEmployees
      .filter((employee) => !scheduled.has(employee.id))
      .sort((left, right) => {
        const leftSame =
          left.positionId !== null && scheduledPositions.has(left.positionId);
        const rightSame =
          right.positionId !== null && scheduledPositions.has(right.positionId);
        if (leftSame !== rightSame) return leftSame ? -1 : 1;
        const byShifts =
          (shiftsPerEmployee.get(left.id) ?? 0) -
          (shiftsPerEmployee.get(right.id) ?? 0);
        if (byShifts !== 0) return byShifts;
        return left.employeeNo.localeCompare(right.employeeNo);
      })
      .slice(0, Math.min(missing, MAX_SUGGESTIONS_PER_DAY));
    for (const employee of candidates) {
      const templateId =
        mostUsed(employeeTemplates.get(employee.id)) ?? overallTemplate;
      suggestions.push({
        id: `${day}|${employee.id}|${templateId ?? "none"}`,
        businessDate: day,
        employeeId: employee.id,
        templateId,
        missing,
        target: busiest,
      });
    }
  }
  return suggestions;
}
