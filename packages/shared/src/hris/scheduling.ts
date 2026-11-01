// Shift templates, the weekly roster, compliance warnings and shift swaps
// (PRD v1.7 §3 Kelompok D 28 "Penjadwalan Shift", §6 H `shift_templates`,
// `shift_assignments`, `shift_swap_requests`; F26, HR-05).
//
// - A template has one segment (pagi/siang/malam) or two (split shift, PRD F26
//   "split shift"). An assignment snapshots its concrete segments and break
//   minutes, so a later template edit never changes a published roster.
// - A roster week is published as a whole: every draft assignment of the week
//   becomes `published` and `shift.published` events are emitted per
//   assignment (see events.ts).
// - `evaluateShiftCompliance` implements the PRD warnings: shift too long,
//   daily/weekly limit, insufficient rest between shifts, overlapping shifts,
//   too many consecutive work days. Limits are tenant configuration.
// - HR-05: a swap or cover that would create a compliance violation can only
//   be approved with an explicit override (`approve_with_override` plus a
//   reason); a plain approval is refused. `evaluateShiftSwapCompliance` diffs
//   the proposed roster against the current one, so pre-existing warnings do
//   not block an otherwise clean swap.

import {
  z,
  tenantIdSchema,
  outletIdSchema,
  userIdSchema,
  isoDateTimeSchema,
  businessDateSchema,
  timeOfDaySchema,
  CoreError,
} from "../core/index.ts";
import {
  employeeIdSchema,
  shiftTemplateIdSchema,
  shiftAssignmentIdSchema,
  shiftSwapRequestIdSchema,
  stationIdSchema,
  positionIdSchema,
} from "./ids.ts";
import type { EmployeeId, ShiftAssignmentId } from "./ids.ts";

/** One working interval of a template; end <= start crosses midnight. */
export const shiftTemplateSegmentSchema = z
  .strictObject({
    startTime: timeOfDaySchema,
    endTime: timeOfDaySchema,
  })
  .superRefine((segment, ctx) => {
    if (segment.startTime === segment.endTime)
      ctx.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "A shift segment must have a non-zero duration",
      });
  });
export type ShiftTemplateSegment = z.infer<typeof shiftTemplateSegmentSchema>;

export const shiftTemplateSchema = z
  .strictObject({
    id: shiftTemplateIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    name: z.string().min(1).max(100),
    /** One segment (pagi/siang/malam) or two (split shift). */
    segments: z.array(shiftTemplateSegmentSchema).min(1).max(2),
    /** Total break for the whole shift, split across segments by the roster UI. */
    breakMinutes: z.number().int().min(0).max(240),
    stationId: stationIdSchema.nullable(),
    positionId: positionIdSchema.nullable(),
    isActive: z.boolean(),
  })
  .superRefine((template, ctx) => {
    if (template.segments.length === 2) {
      const [first, second] = template.segments;
      if (second.startTime < first.endTime)
        ctx.addIssue({
          code: "custom",
          path: ["segments"],
          message: "Split-shift segments must be ordered and not overlap",
        });
    }
    const crossesMidnight = template.segments.some(
      (segment) => segment.endTime <= segment.startTime,
    );
    if (crossesMidnight && template.segments.length > 1)
      ctx.addIssue({
        code: "custom",
        path: ["segments"],
        message: "Only a single-segment shift can cross midnight",
      });
  });
export type ShiftTemplate = z.infer<typeof shiftTemplateSchema>;

/** True when any segment ends on the following calendar day (malam shift). */
export function shiftTemplateCrossesMidnight(
  template: Pick<ShiftTemplate, "segments">,
): boolean {
  return template.segments.some(
    (segment) => segment.endTime <= segment.startTime,
  );
}

export const shiftAssignmentStatusSchema = z.enum([
  "draft",
  "published",
  "swapped",
  "cancelled",
]);
export type ShiftAssignmentStatus = z.infer<typeof shiftAssignmentStatusSchema>;

export const shiftAssignmentSourceSchema = z.enum(["user", "ai", "mcp"]);
export type ShiftAssignmentSource = z.infer<typeof shiftAssignmentSourceSchema>;

/** Concrete interval of a published assignment (snapshot of a template segment). */
export const shiftAssignmentSegmentSchema = z
  .strictObject({ startsAt: isoDateTimeSchema, endsAt: isoDateTimeSchema })
  .superRefine((segment, ctx) => {
    if (Date.parse(segment.endsAt) <= Date.parse(segment.startsAt))
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "A shift segment must end after it starts",
      });
  });
export type ShiftAssignmentSegment = z.infer<
  typeof shiftAssignmentSegmentSchema
>;

/**
 * PRD §6 H `shift_assignments` row. `businessDate` is the outlet-local day the
 * shift belongs to (a 22:00–06:00 shift belongs to the day it starts); the
 * server derives it with the outlet time zone, so compliance math never depends
 * on the device clock. `breakMinutes` is snapshotted from the template.
 */
export const shiftAssignmentSchema = z
  .strictObject({
    id: shiftAssignmentIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    employeeId: employeeIdSchema,
    shiftTemplateId: shiftTemplateIdSchema.nullable(),
    stationId: stationIdSchema.nullable(),
    businessDate: businessDateSchema,
    segments: z.array(shiftAssignmentSegmentSchema).min(1).max(2),
    breakMinutes: z.number().int().min(0).max(240),
    status: shiftAssignmentStatusSchema,
    source: shiftAssignmentSourceSchema,
    publishedBy: userIdSchema.nullable(),
    publishedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((assignment, ctx) => {
    const sorted = [...assignment.segments].sort(
      (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt),
    );
    let duration = 0;
    for (const [index, segment] of sorted.entries()) {
      duration +=
        (Date.parse(segment.endsAt) - Date.parse(segment.startsAt)) / 60_000;
      const next = sorted[index + 1];
      if (next && Date.parse(next.startsAt) < Date.parse(segment.endsAt))
        ctx.addIssue({
          code: "custom",
          path: ["segments"],
          message: "Shift segments overlap",
        });
    }
    if (duration - assignment.breakMinutes <= 0)
      ctx.addIssue({
        code: "custom",
        path: ["breakMinutes"],
        message: "The break must leave working time",
      });
    if ((assignment.publishedBy === null) !== (assignment.publishedAt === null))
      ctx.addIssue({
        code: "custom",
        message: "Publication needs both actor and time",
      });
    if (
      (assignment.status === "published" || assignment.status === "swapped") &&
      assignment.publishedAt === null
    )
      ctx.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "A visible shift must be published",
      });
    if (assignment.status === "draft" && assignment.publishedAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message: "A draft shift has not been published",
      });
  });
export type ShiftAssignment = z.infer<typeof shiftAssignmentSchema>;

const assignmentTransitions: Partial<
  Record<
    ShiftAssignmentStatus,
    Partial<Record<"publish" | "swap" | "cancel", ShiftAssignmentStatus>>
  >
> = {
  draft: { publish: "published", cancel: "cancelled" },
  published: { swap: "swapped", cancel: "cancelled" },
  swapped: { cancel: "cancelled" },
};
export type ShiftAssignmentAction = "publish" | "swap" | "cancel";

/** Draft → published; published → swapped or cancelled; swapped → cancelled. */
export function transitionShiftAssignment(
  status: ShiftAssignmentStatus,
  action: ShiftAssignmentAction,
): ShiftAssignmentStatus {
  const next = assignmentTransitions[status]?.[action];
  if (!next)
    throw new CoreError(
      "CONFLICT",
      `Transisi jadwal shift tidak valid: ${status} → ${action}.`,
    );
  return next;
}

// ---- Compliance (F26 "Kepatuhan", HR-05) ---------------------------------

/**
 * Working-time limits. Every value is tenant configuration (PRD F26 "dengan
 * aturan yang dapat dikonfigurasi"); `outletId: null` is the tenant default.
 */
export const shiftCompliancePolicySchema = z
  .strictObject({
    tenantId: tenantIdSchema,
    outletId: outletIdSchema.nullable(),
    maxShiftMinutes: z.number().int().min(60).max(1_440),
    maxDailyMinutes: z.number().int().min(60).max(2_880),
    maxWeeklyMinutes: z.number().int().min(60).max(10_080),
    minRestMinutesBetweenShifts: z.number().int().min(0).max(1_440),
    maxConsecutiveWorkDays: z.number().int().min(1).max(31),
  })
  .superRefine((policy, ctx) => {
    if (policy.maxDailyMinutes < policy.maxShiftMinutes)
      ctx.addIssue({
        code: "custom",
        path: ["maxDailyMinutes"],
        message: "The daily limit cannot be lower than one shift",
      });
    if (policy.maxWeeklyMinutes < policy.maxDailyMinutes)
      ctx.addIssue({
        code: "custom",
        path: ["maxWeeklyMinutes"],
        message: "The weekly limit cannot be lower than one day",
      });
  });
export type ShiftCompliancePolicy = z.infer<typeof shiftCompliancePolicySchema>;

export const shiftComplianceIssueCodeSchema = z.enum([
  "shift_too_long",
  "daily_limit_exceeded",
  "weekly_limit_exceeded",
  "insufficient_rest",
  "overlapping_shift",
  "too_many_consecutive_days",
]);
export type ShiftComplianceIssueCode = z.infer<
  typeof shiftComplianceIssueCodeSchema
>;

export const shiftComplianceIssueSchema = z.strictObject({
  code: shiftComplianceIssueCodeSchema,
  employeeId: employeeIdSchema,
  assignmentId: shiftAssignmentIdSchema,
  /** The other shift involved (rest or overlap), when there is one. */
  relatedAssignmentId: shiftAssignmentIdSchema.nullable(),
  /** Limit that was exceeded, in the unit of the code. */
  limit: z.number().int().nonnegative().safe(),
  actual: z.number().int().nonnegative().safe(),
});
export type ShiftComplianceIssue = z.infer<typeof shiftComplianceIssueSchema>;

const MINUTE_MS = 60_000;

function minutesBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / MINUTE_MS);
}

/** Worked minutes of one assignment (all segments minus the snapshotted break). */
export function workedMinutes(
  assignment: Pick<ShiftAssignment, "segments" | "breakMinutes">,
): number {
  const total = assignment.segments.reduce(
    (sum, segment) => sum + minutesBetween(segment.startsAt, segment.endsAt),
    0,
  );
  return total - assignment.breakMinutes;
}

/** First start and last end of an assignment's segments. */
function span(assignment: Pick<ShiftAssignment, "segments">): {
  startsAt: string;
  endsAt: string;
} {
  const sorted = [...assignment.segments].sort(
    (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt),
  );
  return {
    startsAt: sorted[0].startsAt,
    endsAt: sorted[sorted.length - 1].endsAt,
  };
}

/** `YYYY-MM-DD` arithmetic on the calendar date, never on device time. */
export function addBusinessDays(
  date: string,
  days: number,
): z.infer<typeof businessDateSchema> {
  if (!Number.isInteger(days)) throw new RangeError("days must be an integer");
  const base = Date.parse(`${businessDateSchema.parse(date)}T00:00:00.000Z`);
  const shifted = new Date(base + days * 86_400_000).toISOString().slice(0, 10);
  return businessDateSchema.parse(shifted);
}

/** Monday of the ISO week containing `date`. */
export function weekStartOf(date: string): z.infer<typeof businessDateSchema> {
  const parsed = businessDateSchema.parse(date);
  const weekday = new Date(`${parsed}T00:00:00.000Z`).getUTCDay();
  return addBusinessDays(parsed, -((weekday + 6) % 7));
}

function issueKey(issue: ShiftComplianceIssue): string {
  return [
    issue.code,
    issue.assignmentId,
    issue.relatedAssignmentId ?? "",
    issue.actual,
    issue.limit,
  ].join("|");
}

/**
 * F26 compliance warnings for a set of assignments (cancelled rows ignored).
 * Deterministic order, so a published roster reads the same everywhere.
 */
export function evaluateShiftCompliance(
  assignments: readonly ShiftAssignment[],
  policy: Pick<
    ShiftCompliancePolicy,
    | "maxShiftMinutes"
    | "maxDailyMinutes"
    | "maxWeeklyMinutes"
    | "minRestMinutesBetweenShifts"
    | "maxConsecutiveWorkDays"
  >,
): ShiftComplianceIssue[] {
  const active = assignments.filter(
    (assignment) => assignment.status !== "cancelled",
  );
  const issues: ShiftComplianceIssue[] = [];
  const byEmployee = new Map<EmployeeId, ShiftAssignment[]>();
  for (const assignment of active) {
    const list = byEmployee.get(assignment.employeeId) ?? [];
    list.push(assignment);
    byEmployee.set(assignment.employeeId, list);
  }

  for (const [employeeId, list] of byEmployee) {
    const sorted = [...list].sort(
      (left, right) =>
        Date.parse(span(left).startsAt) - Date.parse(span(right).startsAt) ||
        left.id.localeCompare(right.id),
    );

    for (const assignment of sorted) {
      const worked = workedMinutes(assignment);
      if (worked > policy.maxShiftMinutes)
        issues.push({
          code: "shift_too_long",
          employeeId: assignment.employeeId,
          assignmentId: assignment.id,
          relatedAssignmentId: null,
          limit: policy.maxShiftMinutes,
          actual: worked,
        });
    }

    // Compare each shift with the one that ends latest so far, not only the
    // previous start: a long shift can overlap several later ones.
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted
        .slice(0, index)
        .reduce((latest, candidate) =>
          Date.parse(span(candidate).endsAt) > Date.parse(span(latest).endsAt)
            ? candidate
            : latest,
        );
      const current = sorted[index];
      const gap = minutesBetween(span(previous).endsAt, span(current).startsAt);
      if (gap < 0)
        issues.push({
          code: "overlapping_shift",
          employeeId: current.employeeId,
          assignmentId: current.id,
          relatedAssignmentId: previous.id,
          limit: 0,
          actual: Math.abs(gap),
        });
      else if (gap < policy.minRestMinutesBetweenShifts)
        issues.push({
          code: "insufficient_rest",
          employeeId: current.employeeId,
          assignmentId: current.id,
          relatedAssignmentId: previous.id,
          limit: policy.minRestMinutesBetweenShifts,
          actual: gap,
        });
    }

    const byDate = new Map<string, ShiftAssignment[]>();
    for (const assignment of sorted) {
      const day = byDate.get(assignment.businessDate) ?? [];
      day.push(assignment);
      byDate.set(assignment.businessDate, day);
    }
    for (const day of byDate.values()) {
      const total = day.reduce(
        (sum, assignment) => sum + workedMinutes(assignment),
        0,
      );
      if (total > policy.maxDailyMinutes) {
        const last = day[day.length - 1];
        issues.push({
          code: "daily_limit_exceeded",
          employeeId: last.employeeId,
          assignmentId: last.id,
          relatedAssignmentId: null,
          limit: policy.maxDailyMinutes,
          actual: total,
        });
      }
    }

    const byWeek = new Map<string, ShiftAssignment[]>();
    for (const assignment of sorted) {
      const week = weekStartOf(assignment.businessDate);
      const rows = byWeek.get(week) ?? [];
      rows.push(assignment);
      byWeek.set(week, rows);
    }
    for (const rows of byWeek.values()) {
      const total = rows.reduce(
        (sum, assignment) => sum + workedMinutes(assignment),
        0,
      );
      if (total > policy.maxWeeklyMinutes) {
        const last = rows[rows.length - 1];
        issues.push({
          code: "weekly_limit_exceeded",
          employeeId: last.employeeId,
          assignmentId: last.id,
          relatedAssignmentId: null,
          limit: policy.maxWeeklyMinutes,
          actual: total,
        });
      }
    }

    const firstAssignmentOfDay = new Map<string, ShiftAssignment>();
    for (const assignment of sorted)
      if (!firstAssignmentOfDay.has(assignment.businessDate))
        firstAssignmentOfDay.set(assignment.businessDate, assignment);
    const days = [...firstAssignmentOfDay.keys()].sort();
    let run = 0;
    let previousDay: string | null = null;
    for (const day of days) {
      run =
        previousDay !== null && addBusinessDays(previousDay, 1) === day
          ? run + 1
          : 1;
      previousDay = day;
      if (run > policy.maxConsecutiveWorkDays) {
        const assignment = firstAssignmentOfDay.get(day);
        if (assignment)
          issues.push({
            code: "too_many_consecutive_days",
            employeeId,
            assignmentId: assignment.id,
            relatedAssignmentId: null,
            limit: policy.maxConsecutiveWorkDays,
            actual: run,
          });
      }
    }
  }

  return issues.sort(
    (left, right) =>
      left.employeeId.localeCompare(right.employeeId) ||
      left.code.localeCompare(right.code) ||
      left.assignmentId.localeCompare(right.assignmentId) ||
      issueKey(left).localeCompare(issueKey(right)),
  );
}

// ---- Shift swaps and covers (F26, HR-05) ---------------------------------

export const shiftSwapStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "expired",
]);
export type ShiftSwapStatus = z.infer<typeof shiftSwapStatusSchema>;

/**
 * A swap exchanges two assignments; a cover (`toAssignmentId: null`) hands one
 * assignment to another employee. `complianceIssues` is the diff computed by
 * `evaluateShiftSwapCompliance` at request time and frozen onto the row, so the
 * approver sees exactly what the override is for.
 */
export const shiftSwapRequestSchema = z
  .strictObject({
    id: shiftSwapRequestIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    fromAssignmentId: shiftAssignmentIdSchema,
    /** Assignment surrendered by the target in a true swap; null = cover. */
    toAssignmentId: shiftAssignmentIdSchema.nullable(),
    requestedBy: employeeIdSchema,
    toEmployeeId: employeeIdSchema,
    status: shiftSwapStatusSchema,
    complianceIssues: z.array(shiftComplianceIssueSchema),
    overrideReason: z.string().min(1).max(500).nullable(),
    approvedBy: userIdSchema.nullable(),
    requestedAt: isoDateTimeSchema,
    decidedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((request, ctx) => {
    if (request.requestedBy === request.toEmployeeId)
      ctx.addIssue({
        code: "custom",
        path: ["toEmployeeId"],
        message: "A swap needs another employee",
      });
    if ((request.approvedBy === null) !== (request.decidedAt === null))
      ctx.addIssue({
        code: "custom",
        message: "A decision needs both actor and time",
      });
    if (request.status === "approved" && request.complianceIssues.length > 0) {
      if (request.overrideReason === null)
        ctx.addIssue({
          code: "custom",
          path: ["overrideReason"],
          message:
            "An approved swap with compliance issues needs an explicit override reason (HR-05)",
        });
    } else if (request.overrideReason !== null)
      ctx.addIssue({
        code: "custom",
        path: ["overrideReason"],
        message: "An override reason is only valid with a compliance exception",
      });
    if (request.status === "pending" && request.decidedAt !== null)
      ctx.addIssue({
        code: "custom",
        path: ["decidedAt"],
        message: "A pending request has no decision",
      });
  });
export type ShiftSwapRequest = z.infer<typeof shiftSwapRequestSchema>;

/**
 * HR-05 approval rule: `approve` is refused while the proposed roster creates
 * a violation; `approve_with_override` is the only way through, and it needs a
 * non-blank reason. Both are checked here so no route can skip them.
 */
export function transitionShiftSwap(
  status: ShiftSwapStatus,
  action: "approve" | "approve_with_override" | "reject" | "cancel" | "expire",
  options: {
    complianceIssues?: readonly ShiftComplianceIssue[];
    overrideReason?: string | null;
  } = {},
): ShiftSwapStatus {
  if (status !== "pending")
    throw new CoreError("CONFLICT", `Permintaan tukar shift sudah ${status}.`);
  // Fail closed (HR-05): an approval must state the compliance diff the
  // service recomputed against the roster as it is now (the copy frozen on the
  // request may be stale). Omitting it is never read as "no violations".
  if (
    (action === "approve" || action === "approve_with_override") &&
    options.complianceIssues === undefined
  )
    throw new CoreError(
      "CONFLICT",
      "Kepatuhan jadwal harus dihitung ulang sebelum persetujuan (HR-05).",
    );
  const issues = options.complianceIssues ?? [];
  switch (action) {
    case "approve":
      if (issues.length > 0)
        throw new CoreError(
          "CONFLICT",
          "Tukar shift melanggar aturan jam kerja; perlu override eksplisit (HR-05).",
        );
      return "approved";
    case "approve_with_override":
      if (issues.length === 0)
        throw new CoreError(
          "CONFLICT",
          "Tidak ada pelanggaran yang perlu di-override.",
        );
      if (!options.overrideReason || options.overrideReason.trim().length === 0)
        throw new CoreError(
          "CONFLICT",
          "Override tukar shift memerlukan alasan (HR-05).",
        );
      return "approved";
    case "reject":
      return "rejected";
    case "cancel":
      return "cancelled";
    case "expire":
      return "expired";
  }
}

/**
 * Applies a swap or cover to a roster without mutating the input. For a cover
 * the surrendered assignment moves to the target employee; for a swap the two
 * assignments exchange employees. Throws CONFLICT for an unknown assignment.
 */
export function proposeShiftSwapAssignments(
  assignments: readonly ShiftAssignment[],
  input: {
    fromAssignmentId: ShiftAssignmentId | string;
    toEmployeeId: EmployeeId;
    toAssignmentId?: ShiftAssignmentId | string | null;
  },
): ShiftAssignment[] {
  const from = assignments.find(
    (assignment) =>
      assignment.id.toLowerCase() === input.fromAssignmentId.toLowerCase(),
  );
  if (!from) throw new CoreError("CONFLICT", "Shift asal tidak ditemukan.");
  const result = assignments.map((assignment) => ({ ...assignment }));
  const fromRow = result.find((assignment) => assignment.id === from.id)!;
  if (input.toAssignmentId === undefined || input.toAssignmentId === null) {
    fromRow.employeeId = input.toEmployeeId;
    fromRow.status = "swapped";
    return result;
  }
  const to = result.find(
    (assignment) =>
      assignment.id.toLowerCase() === input.toAssignmentId!.toLowerCase(),
  );
  if (!to) throw new CoreError("CONFLICT", "Shift tujuan tidak ditemukan.");
  const targetEmployeeId = to.employeeId;
  to.employeeId = from.employeeId;
  fromRow.employeeId = targetEmployeeId;
  to.status = "swapped";
  fromRow.status = "swapped";
  return result;
}

/**
 * HR-05: the new compliance issues a swap would introduce, comparing the
 * proposed roster with the current one (so unrelated existing warnings do not
 * block the request).
 */
export function evaluateShiftSwapCompliance(input: {
  assignments: readonly ShiftAssignment[];
  fromAssignmentId: ShiftAssignmentId | string;
  toEmployeeId: EmployeeId;
  toAssignmentId?: ShiftAssignmentId | string | null;
  policy: Parameters<typeof evaluateShiftCompliance>[1];
}): ShiftComplianceIssue[] {
  const baseline = new Set(
    evaluateShiftCompliance(input.assignments, input.policy).map(issueKey),
  );
  const proposed = evaluateShiftCompliance(
    proposeShiftSwapAssignments(input.assignments, {
      fromAssignmentId: input.fromAssignmentId,
      toEmployeeId: input.toEmployeeId,
      toAssignmentId: input.toAssignmentId ?? null,
    }),
    input.policy,
  );
  return proposed.filter((issue) => !baseline.has(issueKey(issue)));
}

/** Published roster for one outlet-week, with its compliance warnings. */
export const rosterPublicationSchema = z.strictObject({
  outletId: outletIdSchema,
  weekStart: businessDateSchema,
  assignments: z.array(shiftAssignmentSchema).min(1),
  complianceIssues: z.array(shiftComplianceIssueSchema),
  publishedBy: userIdSchema,
  publishedAt: isoDateTimeSchema,
});
export type RosterPublication = z.infer<typeof rosterPublicationSchema>;

/** True when every assignment of a week is published or swapped. */
export function isRosterPublished(
  assignments: readonly Pick<ShiftAssignment, "status">[],
): boolean {
  return (
    assignments.length > 0 &&
    assignments.every(
      (assignment) =>
        assignment.status === "published" || assignment.status === "swapped",
    )
  );
}
