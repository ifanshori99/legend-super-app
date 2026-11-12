// Pure normalisation of the HRIS request queue (539-U4 / legend-ydf2): swap,
// cover, leave and overtime rows become one `RequestQueueItem` shape, and a
// supervisor decision becomes the contract body. No framework or fetch here, so
// it runs under node:test. UI text comes from the catalog through the injected
// `t`, never from this file.
import type {
  Employee,
  LeaveRequest,
  LeaveRequestStatus,
  LeaveType,
  OvertimeRequest,
  ShiftAssignment,
  ShiftComplianceIssue,
  ShiftSwapRequest,
  ShiftSwapStatus,
} from "@starter/shared/hris";
import type { MessageKey } from "@starter/shared/i18n";

export type RequestKind = "swap" | "cover" | "leave" | "overtime";
/** Swap statuses are a superset of leave and overtime statuses. */
export type RequestQueueStatus = ShiftSwapStatus | LeaveRequestStatus;
export type RequestDecision = "approve" | "reject";

type QueueBase = {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeNameKnown: boolean;
  /** Kind label, or the leave type name for a leave request. */
  title: string;
  /** Date text of what is requested (a day, a range, or the overtime day). */
  period: string;
  submittedAt: string;
  status: RequestQueueStatus;
  /** Swap and cover only: the frozen compliance diff (HR-05). */
  complianceIssues?: readonly ShiftComplianceIssue[];
};

export type RequestQueueItem =
  | (QueueBase & { kind: "swap" | "cover"; raw: ShiftSwapRequest })
  | (QueueBase & { kind: "leave"; raw: LeaveRequest })
  | (QueueBase & { kind: "overtime"; raw: OvertimeRequest });

export type RequestQueueSource = {
  swaps: readonly ShiftSwapRequest[];
  leaves: readonly LeaveRequest[];
  overtimes: readonly OvertimeRequest[];
  employees: readonly Pick<Employee, "id" | "fullName">[];
  leaveTypes: readonly Pick<LeaveType, "id" | "name">[];
  /** Used only to date a swap; a missing row falls back to "unknown". */
  assignments: readonly Pick<ShiftAssignment, "id" | "businessDate">[];
};

export type QueueTranslate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

function rangeText(t: QueueTranslate, from: string, to: string): string {
  return from === to
    ? from
    : t("hrisRequestsCommon.period.range", { from, to });
}

/** The queue, newest submission first, optionally one status only. */
export function normalizeRequestQueue(
  source: RequestQueueSource,
  t: QueueTranslate,
  filter: { status?: RequestQueueStatus } = {},
): RequestQueueItem[] {
  const names = new Map<string, string>(
    source.employees.map((row) => [row.id, row.fullName]),
  );
  const types = new Map<string, string>(
    source.leaveTypes.map((row) => [row.id, row.name]),
  );
  const dates = new Map<string, string>(
    source.assignments.map((row) => [row.id, row.businessDate]),
  );
  const nameOf = (employeeId: string) =>
    names.get(employeeId) ?? t("hrisRequestsCommon.unknownEmployee");

  const items: RequestQueueItem[] = [];
  for (const raw of source.swaps) {
    const kind = raw.toAssignmentId === null ? "cover" : "swap";
    const days = [
      dates.get(raw.fromAssignmentId),
      raw.toAssignmentId === null ? undefined : dates.get(raw.toAssignmentId),
    ]
      .filter((day): day is string => day !== undefined)
      .sort();
    items.push({
      kind,
      id: raw.id,
      employeeId: raw.requestedBy,
      employeeName: nameOf(raw.requestedBy),
      employeeNameKnown: Boolean(names.get(raw.requestedBy)?.trim()),
      title: t(`hrisRequestsCommon.kind.${kind}`),
      period:
        days.length === 0
          ? t("hrisRequestsCommon.period.unknown")
          : rangeText(t, days[0], days[days.length - 1]),
      submittedAt: raw.requestedAt,
      status: raw.status,
      complianceIssues: raw.complianceIssues,
      raw,
    });
  }
  for (const raw of source.leaves)
    items.push({
      kind: "leave",
      id: raw.id,
      employeeId: raw.employeeId,
      employeeName: nameOf(raw.employeeId),
      employeeNameKnown: Boolean(names.get(raw.employeeId)?.trim()),
      title: types.get(raw.leaveTypeId) ?? t("hrisRequestsCommon.kind.leave"),
      period: rangeText(t, raw.startDate, raw.endDate),
      submittedAt: raw.requestedAt,
      status: raw.status,
      raw,
    });
  for (const raw of source.overtimes)
    items.push({
      kind: "overtime",
      id: raw.id,
      employeeId: raw.employeeId,
      employeeName: nameOf(raw.employeeId),
      employeeNameKnown: Boolean(names.get(raw.employeeId)?.trim()),
      title: t("hrisRequestsCommon.kind.overtime"),
      period: t("hrisRequestsCommon.period.overtime", {
        date: raw.date,
        minutes: raw.minutes,
      }),
      submittedAt: raw.requestedAt,
      status: raw.status,
      raw,
    });

  return items
    .filter(
      (item) => filter.status === undefined || item.status === filter.status,
    )
    .sort(
      (left, right) =>
        Date.parse(right.submittedAt) - Date.parse(left.submittedAt) ||
        left.id.localeCompare(right.id),
    );
}

/** HR-05: approving a swap that breaks a work-time rule needs a reason. */
export function needsOverrideReason(item: RequestQueueItem): boolean {
  return (
    (item.kind === "swap" || item.kind === "cover") &&
    (item.complianceIssues?.length ?? 0) > 0
  );
}

/** Thrown when an override approval has no reason; the screen asks for one. */
export class OverrideReasonRequiredError extends Error {
  readonly code = "OVERRIDE_REASON_REQUIRED";
  constructor() {
    super("An override approval needs a reason.");
    this.name = "OverrideReasonRequiredError";
  }
}

export type DecisionPlan =
  | {
      kind: "swap";
      body: {
        action: "approve" | "approve_with_override" | "reject";
        overrideReason: string | null;
        rejectionReason?: string;
      };
    }
  | {
      kind: "leave" | "overtime";
      body: { action: "approve" | "reject"; rejectionReason?: string };
    };

/** Build the contract body, including a rejection or override reason. */
export function planDecision(
  item: RequestQueueItem,
  decision: RequestDecision,
  reason?: string,
): DecisionPlan {
  if (decision === "reject") {
    const trimmed = reason?.trim() ?? "";
    if (trimmed.length < 3) throw new Error("A rejection reason is required.");
    return item.kind === "leave" || item.kind === "overtime"
      ? {
          kind: item.kind,
          body: { action: "reject", rejectionReason: trimmed },
        }
      : {
          kind: "swap",
          body: {
            action: "reject",
            overrideReason: null,
            rejectionReason: trimmed,
          },
        };
  }
  if (item.kind === "leave" || item.kind === "overtime")
    return { kind: item.kind, body: { action: "approve" } };
  if (!needsOverrideReason(item))
    return { kind: "swap", body: { action: "approve", overrideReason: null } };
  const trimmed = reason?.trim() ?? "";
  if (trimmed === "") throw new OverrideReasonRequiredError();
  return {
    kind: "swap",
    body: { action: "approve_with_override", overrideReason: trimmed },
  };
}

/** A colleague who could take a shift, with the shifts they already work. */
export type SwapCandidate = {
  employeeId: Employee["id"];
  employeeName: string;
  /** Their shifts in the read window, earliest first (a swap picks one). */
  assignments: ShiftAssignment[];
};

/**
 * Colleagues of the same outlet who can be asked: everyone except the
 * requester, sorted by name. A colleague without a shift is a cover only; the
 * server still decides eligibility and computes the compliance diff.
 */
export function buildSwapCandidates(input: {
  meId: string;
  employees: readonly Employee[];
  assignments: readonly ShiftAssignment[];
}): SwapCandidate[] {
  const byEmployee = new Map<string, ShiftAssignment[]>();
  for (const assignment of input.assignments) {
    if (assignment.status === "draft") continue;
    const rows = byEmployee.get(assignment.employeeId) ?? [];
    rows.push(assignment);
    byEmployee.set(assignment.employeeId, rows);
  }
  return input.employees
    .filter((row) => row.id !== input.meId && row.status === "active")
    .map((row) => ({
      employeeId: row.id,
      employeeName: row.fullName,
      assignments: (byEmployee.get(row.id) ?? [])
        .slice()
        .sort(
          (left, right) =>
            left.businessDate.localeCompare(right.businessDate) ||
            left.id.localeCompare(right.id),
        ),
    }))
    .sort((left, right) => left.employeeName.localeCompare(right.employeeName));
}

/** Outlet of a new request: the shift's own outlet, else the employee's. */
export function pickOutletId<T extends string>(
  fromPayload: T | undefined,
  fallback: T,
): T {
  return fromPayload === undefined || fromPayload === ""
    ? fallback
    : fromPayload;
}

/**
 * A 4xx answer (409 and the like) is final for that payload, so the stored
 * idempotency key is dropped; network failures (status 0) and 5xx keep it.
 */
export function isFinalClientError(status: number): boolean {
  return status >= 400 && status < 500;
}
