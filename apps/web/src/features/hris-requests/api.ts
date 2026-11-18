// Typed calls of the HRIS requests feature (539-U4 / legend-ydf2). One
// function per contract endpoint (@starter/shared/hris); responses are
// unwrapped and every list is read page by page. Idempotency keys are minted
// by the hooks, never here.
import type {
  Employee,
  EmployeeId,
  Holiday,
  LeaveBalance,
  LeaveRequest,
  LeaveTypeId,
  LeaveType,
  OvertimeRequest,
  ShiftAssignment,
  ShiftAssignmentId,
  ShiftSwapRequest,
  ShiftSwapRequestId,
} from "@starter/shared/hris";
import {
  cancelShiftSwapRequest,
  createLeaveRequest,
  createOvertimeRequest,
  createShiftSwapRequest,
  decideLeaveRequest,
  decideOvertimeRequest,
  decideShiftSwapRequest,
  getMyHrisProfile,
  listEmployees,
  listHolidays,
  listLeaveBalances,
  listLeaveRequests,
  listLeaveTypes,
  listOvertimeRequests,
  listShiftAssignments,
  listShiftSwapRequests,
  listShiftSwapCandidates,
  respondShiftSwapRequest,
} from "@starter/shared/hris";
import type { CursorPage, OutletId } from "@starter/shared/core";
import { callEndpoint } from "@/lib/api/endpoint";
import type {
  DecisionPlan,
  RequestQueueItem,
  RequestQueueSource,
  RequestQueueStatus,
} from "./queue.ts";

const PAGE_LIMIT = 100;
/** A runaway cursor stops here instead of looping. */
const MAX_PAGES = 20;

/** Reads every cursor page of one list; a repeated cursor ends the loop. */
async function readAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    rows.push(...result.data);
    const next = result.meta.nextCursor;
    if (next === null || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return rows;
}

const cursorOf = (cursor: string | undefined) =>
  cursor === undefined ? {} : { cursor };

// ---- Me ----------------------------------------------------------------

/** The signed-in employee and the outlet the requests are filed in. */
export async function fetchMyHris(signal?: AbortSignal) {
  const response = await callEndpoint(getMyHrisProfile, {}, { signal });
  return response.data;
}

// ---- Reads -------------------------------------------------------------

export function fetchSwaps(
  filter: { mine?: boolean; status?: RequestQueueStatus; outletId?: OutletId },
  signal?: AbortSignal,
): Promise<ShiftSwapRequest[]> {
  return readAll((cursor) =>
    callEndpoint(
      listShiftSwapRequests,
      {
        query: {
          limit: PAGE_LIMIT,
          ...(filter.outletId === undefined
            ? {}
            : { outletId: filter.outletId }),
          ...(filter.mine === undefined
            ? {}
            : { mine: filter.mine ? ("true" as const) : ("false" as const) }),
          ...(filter.status === undefined ? {} : { status: filter.status }),
          ...cursorOf(cursor),
        },
      },
      { signal },
    ),
  );
}

export function fetchLeaveRequests(
  filter: { employeeId?: EmployeeId; status?: RequestQueueStatus },
  signal?: AbortSignal,
): Promise<LeaveRequest[]> {
  // `expired` exists for swaps only: no leave row can match it.
  const status = filter.status;
  if (status === "expired") return Promise.resolve([]);
  return readAll((cursor) =>
    callEndpoint(
      listLeaveRequests,
      {
        query: {
          limit: PAGE_LIMIT,
          ...(filter.employeeId === undefined
            ? {}
            : { employeeId: filter.employeeId }),
          ...(status === undefined ? {} : { status }),
          ...cursorOf(cursor),
        },
      },
      { signal },
    ),
  );
}

export function fetchOvertimeRequests(
  filter: { employeeId?: EmployeeId; status?: RequestQueueStatus },
  signal?: AbortSignal,
): Promise<OvertimeRequest[]> {
  const status = filter.status;
  if (status === "expired") return Promise.resolve([]);
  return readAll((cursor) =>
    callEndpoint(
      listOvertimeRequests,
      {
        query: {
          limit: PAGE_LIMIT,
          ...(filter.employeeId === undefined
            ? {}
            : { employeeId: filter.employeeId }),
          ...(status === undefined ? {} : { status }),
          ...cursorOf(cursor),
        },
      },
      { signal },
    ),
  );
}

export function fetchLeaveBalances(
  employeeId: EmployeeId,
  year: number,
  signal?: AbortSignal,
): Promise<LeaveBalance[]> {
  return readAll((cursor) =>
    callEndpoint(
      listLeaveBalances,
      { query: { limit: PAGE_LIMIT, employeeId, year, ...cursorOf(cursor) } },
      { signal },
    ),
  );
}

export function fetchLeaveTypes(signal?: AbortSignal): Promise<LeaveType[]> {
  return readAll((cursor) =>
    callEndpoint(
      listLeaveTypes,
      { query: { limit: PAGE_LIMIT, ...cursorOf(cursor) } },
      { signal },
    ),
  );
}

export function fetchShifts(
  filter: {
    outletId?: OutletId;
    employeeId?: EmployeeId;
    from: string;
    to: string;
  },
  signal?: AbortSignal,
): Promise<ShiftAssignment[]> {
  return readAll((cursor) =>
    callEndpoint(
      listShiftAssignments,
      {
        query: {
          limit: PAGE_LIMIT,
          from: filter.from,
          to: filter.to,
          ...(filter.outletId === undefined
            ? {}
            : { outletId: filter.outletId }),
          ...(filter.employeeId === undefined
            ? {}
            : { employeeId: filter.employeeId }),
          ...cursorOf(cursor),
        },
      },
      { signal },
    ),
  );
}

export function fetchEmployees(
  filter: { outletId?: OutletId; active?: boolean },
  signal?: AbortSignal,
): Promise<Employee[]> {
  return readAll((cursor) =>
    callEndpoint(
      listEmployees,
      {
        query: {
          limit: PAGE_LIMIT,
          ...(filter.outletId === undefined
            ? {}
            : { outletId: filter.outletId }),
          ...(filter.active === true ? { status: "active" as const } : {}),
          ...cursorOf(cursor),
        },
      },
      { signal },
    ),
  );
}

export async function fetchSwapCandidates(
  outletId: OutletId,
  fromAssignmentId: ShiftAssignmentId,
  signal?: AbortSignal,
) {
  return (
    await callEndpoint(
      listShiftSwapCandidates,
      { query: { outletId, fromAssignmentId } },
      { signal },
    )
  ).data;
}

export async function postPeerResponse(
  swapId: ShiftSwapRequestId,
  action: "accept" | "reject",
  rejectionReason: string | undefined,
  idempotencyKey: string,
) {
  return (
    await callEndpoint(respondShiftSwapRequest, {
      params: { swapId },
      body: {
        action,
        ...(rejectionReason ? { rejectionReason } : {}),
        idempotencyKey,
      },
    })
  ).data;
}

/** Holidays of every calendar year the range touches, cut to the range. */
export async function fetchHolidays(
  range: { from: string; to: string },
  signal?: AbortSignal,
): Promise<Holiday[]> {
  const firstYear = Number(range.from.slice(0, 4));
  const lastYear = Number(range.to.slice(0, 4));
  const rows: Holiday[] = [];
  for (let year = firstYear; year <= lastYear; year += 1)
    rows.push(
      ...(await readAll((cursor) =>
        callEndpoint(
          listHolidays,
          { query: { limit: PAGE_LIMIT, year, ...cursorOf(cursor) } },
          { signal },
        ),
      )),
    );
  return rows
    .filter((row) => row.date >= range.from && row.date <= range.to)
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date) || left.id.localeCompare(right.id),
    );
}

/** Everything the supervisor queue needs, fetched together. */
export async function fetchQueueSource(
  filter: {
    status?: RequestQueueStatus;
    outletId?: OutletId;
    shiftsFrom: string;
    shiftsTo: string;
    permissions: readonly string[];
  },
  signal?: AbortSignal,
): Promise<RequestQueueSource> {
  const can = (...codes: string[]) =>
    codes.some((code) => filter.permissions.includes(code));
  const canSwap = can("hr.shift_swap.approve", "hr.schedule.manage");
  const canLeave = can(
    "hr.leave.approve",
    "hr.employee.view",
    "hr.employee.manage",
    "payroll.view",
  );
  const canOvertime = can(
    "hr.overtime.approve",
    "hr.employee.view",
    "hr.employee.manage",
    "payroll.view",
  );
  const [swaps, leaves, overtimes, leaveTypes] = await Promise.all([
    canSwap
      ? fetchSwaps({ status: filter.status, outletId: filter.outletId }, signal)
      : [],
    canLeave ? fetchLeaveRequests({ status: filter.status }, signal) : [],
    canOvertime ? fetchOvertimeRequests({ status: filter.status }, signal) : [],
    canLeave ? fetchLeaveTypes(signal) : [],
  ]);
  return {
    swaps,
    leaves,
    overtimes,
    employees: [],
    leaveTypes,
    assignments: [],
  };
}

// ---- Writes ------------------------------------------------------------

export async function postShiftSwap(
  body: {
    outletId: OutletId;
    fromAssignmentId: ShiftAssignmentId;
    toEmployeeId: EmployeeId;
    /** Set for a true swap; null hands the shift over (a cover). */
    toAssignmentId: ShiftAssignmentId | null;
  },
  idempotencyKey: string,
) {
  const response = await callEndpoint(createShiftSwapRequest, {
    body: { ...body, idempotencyKey },
  });
  return response.data;
}

export async function postCancelShiftSwap(
  swapId: ShiftSwapRequestId,
  idempotencyKey: string,
) {
  const response = await callEndpoint(cancelShiftSwapRequest, {
    params: { swapId },
    body: { idempotencyKey },
  });
  return response.data;
}

export async function postLeaveRequest(
  body: {
    leaveTypeId: LeaveTypeId;
    startDate: string;
    endDate: string;
    reason: string | null;
    attachmentUploadRef: string | null;
  },
  idempotencyKey: string,
) {
  const response = await callEndpoint(createLeaveRequest, {
    body: { ...body, idempotencyKey },
  });
  return response.data;
}

export async function postOvertimeRequest(
  body: {
    outletId: OutletId;
    date: string;
    minutes: number;
    reason: string;
  },
  idempotencyKey: string,
) {
  const response = await callEndpoint(createOvertimeRequest, {
    body: { ...body, idempotencyKey },
  });
  return response.data;
}

/** Sends the decision planned by `planDecision` to the endpoint of its kind. */
export async function postDecision(
  item: RequestQueueItem,
  plan: DecisionPlan,
  idempotencyKey: string,
) {
  if (plan.kind === "swap" && (item.kind === "swap" || item.kind === "cover"))
    return (
      await callEndpoint(decideShiftSwapRequest, {
        params: { swapId: item.raw.id },
        body: { ...plan.body, idempotencyKey },
      })
    ).data;
  if (plan.kind === "leave" && item.kind === "leave")
    return (
      await callEndpoint(decideLeaveRequest, {
        params: { leaveRequestId: item.raw.id },
        body: { ...plan.body, idempotencyKey },
      })
    ).data;
  if (plan.kind === "overtime" && item.kind === "overtime")
    return (
      await callEndpoint(decideOvertimeRequest, {
        params: { overtimeRequestId: item.raw.id },
        body: { ...plan.body, idempotencyKey },
      })
    ).data;
  throw new Error("Decision plan does not match the request kind.");
}
