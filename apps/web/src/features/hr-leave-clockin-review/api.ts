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
  getEmployee,
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
  candidateBusinessDates,
  compareLeaveClockinCases,
  isLeaveClockinItem,
  resolveBusinessDate,
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

/**
 * Queue items of one review status that carry the leave flag. The server
 * filters by flag, so every page is read until `nextCursor` is null (no page
 * cap: a leave case must never fall past an arbitrary limit). A cursor seen
 * before (a repeat or a cycle) stops the loop. The client filter stays as defense.
 */
export async function fetchLeaveReviewItems(
  outletId: OutletId,
  reviewStatus: AttendanceReviewStatus,
  signal?: AbortSignal,
): Promise<AttendanceReviewItem[]> {
  const items: AttendanceReviewItem[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const result = await callEndpoint(
      listAttendanceReviewQueue,
      {
        query: {
          outletId,
          reviewStatus,
          flagReason: "leave_approved",
          limit: LEAVE_CLOCKIN_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      { signal },
    );
    items.push(...result.data);
    const next = result.meta.nextCursor;
    if (next === null || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return items.filter(isLeaveClockinItem);
}

/**
 * Employees by directory lookup, never silently capped: the outlet's employees
 * are read first (the endpoint filters by outlet), then every employee the
 * cases need that the list did not return (another home outlet, past the page
 * cap) is read one by one. Null only when nothing could be read at all.
 */
async function fetchEmployees(
  outletId: OutletId,
  employeeIds: readonly string[],
  signal?: AbortSignal,
): Promise<Employee[] | null> {
  const listed = await settled(
    readPages((cursor) =>
      callEndpoint(
        listEmployees,
        {
          query: {
            outletId,
            limit: LEAVE_CLOCKIN_PAGE_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          },
        },
        { signal },
      ),
    ),
  );
  const found = new Set<string>((listed ?? []).map((employee) => employee.id));
  const missing = employeeIds.filter((id) => !found.has(id));
  const extra = await Promise.all(
    missing.map((employeeId) =>
      settled(
        callEndpoint(getEmployee, { params: { employeeId } }, { signal }),
      ),
    ),
  );
  const rows = [
    ...(listed ?? []),
    ...extra.flatMap((response) => (response === null ? [] : [response.data])),
  ];
  return listed === null && rows.length === 0 ? null : rows;
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

async function fetchLeavesOfStatus(
  item: AttendanceReviewItem,
  status: "approved" | "cancelled",
  signal?: AbortSignal,
): Promise<LeaveRequest[]> {
  return readPages((cursor) =>
    callEndpoint(
      listLeaveRequests,
      {
        query: {
          employeeId: item.log.employeeId,
          status,
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
 * A log with a shift can belong to the day before its calendar date (night
 * shift), so both days are read and the one listing the log decides.
 */
export async function loadLeaveClockinCases(
  items: readonly AttendanceReviewItem[],
  outletId: OutletId,
  timeZone: string,
  signal?: AbortSignal,
): Promise<LeaveClockinCase[]> {
  if (items.length === 0) return [];
  const firstItemOf = new Map<string, AttendanceReviewItem>();
  for (const item of items)
    if (!firstItemOf.has(item.log.employeeId))
      firstItemOf.set(item.log.employeeId, item);
  const [employees, leaveTypes] = await Promise.all([
    fetchEmployees(outletId, [...firstItemOf.keys()], signal),
    settled(fetchLeaveTypes(signal)),
  ]);
  const leavesByEmployee = new Map<string, LeaveRequest[] | null>();
  const cancelledByEmployee = new Map<string, LeaveRequest[] | null>();
  const logsByDate = new Map<string, AttendanceLog[] | null>();
  const dates = new Set(
    items.flatMap((item) => candidateBusinessDates(item.log, timeZone)),
  );
  await Promise.all([
    ...[...firstItemOf].map(async ([employeeId, first]) => {
      leavesByEmployee.set(
        employeeId,
        await settled(fetchLeavesOfStatus(first, "approved", signal)),
      );
      // Only a cancelled decision needs the (no longer approved) leave back.
      if (
        items.some(
          (item) =>
            item.log.employeeId === employeeId &&
            item.reviewStatus === "accepted",
        )
      )
        cancelledByEmployee.set(
          employeeId,
          await settled(fetchLeavesOfStatus(first, "cancelled", signal)),
        );
    }),
    ...[...dates].map(async (businessDate) => {
      logsByDate.set(
        businessDate,
        await settled(fetchOutletDayLogs(outletId, businessDate, signal)),
      );
    }),
  ]);
  return items
    .map((item) => {
      const businessDate = resolveBusinessDate(item.log, timeZone, (date) =>
        logsByDate.get(date),
      );
      return buildLeaveClockinCase(item, timeZone, {
        employees,
        leaveTypes,
        leaves: leavesByEmployee.get(item.log.employeeId) ?? null,
        cancelledLeaves: cancelledByEmployee.get(item.log.employeeId) ?? null,
        dayLogs: logsByDate.get(businessDate) ?? null,
        businessDate,
      });
    })
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
