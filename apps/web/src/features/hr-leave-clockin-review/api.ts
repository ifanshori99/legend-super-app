// Typed calls for the HR review of clock-ins on approved leave days (bead
// legend-3jem1). One function per contract endpoint (@starter/shared/hris);
// responses are unwrapped. `loadLeaveClockinCases` is the enrichment layer:
// the queue item has no employee name, leave or clock-out (API gap
// legend-eps6t), so it fetches those lookups once per screen and builds the
// `LeaveClockinCase` view models with the pure helpers of enrich.ts. A failed
// lookup blanks only its own field (null), never the whole screen.
import type {
  AttendanceLog,
  AttendanceReviewItem,
  AttendanceReviewStatus,
  Employee,
  LeaveRequest,
  LeaveType,
} from "@starter/shared/hris";
import {
  decideAttendanceReview,
  listAttendanceLogs,
  listAttendanceReviewQueue,
  listEmployees,
  listLeaveRequests,
  listLeaveTypes,
} from "@starter/shared/hris";
import type { CursorPage, OutletId } from "@starter/shared/core";
import { callEndpoint } from "@/lib/api/endpoint";
import {
  buildLeaveClockinCase,
  businessDateOfLog,
  compareLeaveClockinCases,
  isLeaveClockinItem,
} from "./enrich.ts";
import type { LeaveClockinAction, LeaveClockinCase } from "./types.ts";

/** Largest page the contract allows (PAGE_LIMIT_MAX). */
export const LEAVE_CLOCKIN_PAGE_LIMIT = 100;
/** Pages read per list: a full outlet-day or queue fits well inside this. */
const MAX_PAGES = 5;

/** Reads up to MAX_PAGES cursor pages of one list. */
async function readPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<CursorPage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await fetchPage(cursor);
    rows.push(...result.data);
    if (result.meta.nextCursor === null) break;
    cursor = result.meta.nextCursor;
  }
  return rows;
}

/** Queue items of one review status that carry the leave flag. */
export async function fetchLeaveReviewItems(
  outletId: OutletId,
  reviewStatus: AttendanceReviewStatus,
  signal?: AbortSignal,
): Promise<AttendanceReviewItem[]> {
  const items = await readPages((cursor) =>
    callEndpoint(
      listAttendanceReviewQueue,
      {
        query: {
          outletId,
          reviewStatus,
          limit: LEAVE_CLOCKIN_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      { signal },
    ),
  );
  return items.filter(isLeaveClockinItem);
}

async function fetchEmployees(signal?: AbortSignal): Promise<Employee[]> {
  return readPages((cursor) =>
    callEndpoint(
      listEmployees,
      {
        query: {
          limit: LEAVE_CLOCKIN_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      { signal },
    ),
  );
}

async function fetchLeaveTypes(signal?: AbortSignal): Promise<LeaveType[]> {
  return readPages((cursor) =>
    callEndpoint(
      listLeaveTypes,
      {
        query: {
          limit: LEAVE_CLOCKIN_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      { signal },
    ),
  );
}

async function fetchApprovedLeaves(
  item: AttendanceReviewItem,
  signal?: AbortSignal,
): Promise<LeaveRequest[]> {
  return readPages((cursor) =>
    callEndpoint(
      listLeaveRequests,
      {
        query: {
          employeeId: item.log.employeeId,
          status: "approved",
          limit: LEAVE_CLOCKIN_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      { signal },
    ),
  );
}

/**
 * The outlet's logs for one day, read outlet-wide and matched to employees in
 * enrich.ts: one call serves every case of that day (no per-employee read).
 */
async function fetchOutletDayLogs(
  outletId: OutletId,
  businessDate: string,
  signal?: AbortSignal,
): Promise<AttendanceLog[]> {
  return readPages((cursor) =>
    callEndpoint(
      listAttendanceLogs,
      {
        query: {
          outletId,
          businessDate,
          limit: LEAVE_CLOCKIN_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      { signal },
    ),
  );
}

/** A failed lookup becomes null so one bad call never fails the screen. */
async function settled<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

/**
 * Builds the case view models of some queue items: lookups run in parallel,
 * once per employee / business date, and the result is sorted for the queue.
 */
export async function loadLeaveClockinCases(
  items: readonly AttendanceReviewItem[],
  outletId: OutletId,
  timeZone: string,
  signal?: AbortSignal,
): Promise<LeaveClockinCase[]> {
  if (items.length === 0) return [];
  const [employees, leaveTypes] = await Promise.all([
    settled(fetchEmployees(signal)),
    settled(fetchLeaveTypes(signal)),
  ]);
  const leavesByEmployee = new Map<string, LeaveRequest[] | null>();
  const logsByDate = new Map<string, AttendanceLog[] | null>();
  const firstItemOf = new Map<string, AttendanceReviewItem>();
  for (const item of items)
    if (!firstItemOf.has(item.log.employeeId))
      firstItemOf.set(item.log.employeeId, item);
  const dateOf = (item: AttendanceReviewItem) =>
    businessDateOfLog(item.log.occurredAt, timeZone);
  await Promise.all([
    ...[...firstItemOf].map(async ([employeeId, item]) => {
      leavesByEmployee.set(
        employeeId,
        await settled(fetchApprovedLeaves(item, signal)),
      );
    }),
    ...[...new Set(items.map(dateOf))].map(async (businessDate) => {
      logsByDate.set(
        businessDate,
        await settled(fetchOutletDayLogs(outletId, businessDate, signal)),
      );
    }),
  ]);
  return items
    .map((item) =>
      buildLeaveClockinCase(item, timeZone, {
        employees,
        leaveTypes,
        leaves: leavesByEmployee.get(item.log.employeeId) ?? null,
        dayLogs: logsByDate.get(dateOf(item)) ?? null,
      }),
    )
    .sort(compareLeaveClockinCases);
}

/** Records the HR decision; `idempotencyKey` is new per confirmation attempt. */
export async function postLeaveClockinDecision(
  item: AttendanceReviewItem,
  action: LeaveClockinAction,
  idempotencyKey: string,
): Promise<AttendanceReviewItem> {
  const response = await callEndpoint(decideAttendanceReview, {
    params: { logId: item.log.id },
    body: { action, idempotencyKey },
  });
  return response.data;
}
