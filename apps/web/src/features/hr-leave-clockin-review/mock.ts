// Mock handlers for the HR review of clock-ins on approved leave days (bead
// legend-3jem1). Owns `listAttendanceReviewQueue`, `decideAttendanceReview`,
// `listLeaveRequests` and `listLeaveTypes` (no other mock registers them); the
// employee directory and the day's attendance logs stay owned by
// `lib/mock/handlers/hris-directory.ts`, whose fixtures this file reuses so a
// case's employee name and clock-out come out of the real mock reads.
//
// Fixture day 2026-10-26 (WIB, same as legend-0z5k), outlet BDG-01. Four open
// cases:
//   1. Dewi Lestari   - annual leave 25-27 Oct (multi-day), clock-in 08:50, out 16:05
//   2. Ayu Wulandari  - annual leave 26 Oct, clock-in 09:10, NOT clocked out
//   3. Agus Setiawan  - leave approved after the clock-in (re-review), 08:50, out 16:05
//   4. Maya Anggraini - manual correction on leave day, 08:55, out 16:05
// A decision changes the queue item in memory (keep_leave -> `rejected`,
// cancel_leave -> `accepted`, reviewer = Siti Nurhaliza) until the mock resets.
//
// Switches in mock mode (VITE_API_MOCK=true):
//   Empty queue ...... ?mock=empty (also empties employees, leaves, logs)
//   Error ............ ?mock=error (every call 500), ?mock=offline (network)
//   Slow ............. ?mock=slow (3 s loading skeleton)
//   Only queue fails . window.__legendMock.failNext("GET /api/hris/attendance/review-queue",
//                        { status: 500, code: "INTERNAL_ERROR" })
//   Confirm fails .... window.__legendMock.failNext("POST /api/hris/attendance/logs/:logId/review",
//                        { status: 409, code: "ATTENDANCE_LEAVE_NOT_APPROVED" })
//                      (any 409 / 403 code of the contract; the dialog stays open)
//   No right to cancel  ?leaveRights=keep-only (remembered in localStorage;
//                        ?leaveRights=full clears it). The page disables
//                        "Batalkan cuti hari ini"; the mock server also answers
//                        403 FORBIDDEN to cancel_leave. keep_leave keeps working.
//   Role cookie ...... legend-mock-role=supervisor (no hr.attendance.manage)
//                      hides the page (404), like the real guard.
import {
  attendanceLogSchema,
  cafeLegendHrisFixtures,
  decideAttendanceReview,
  leaveRequestSchema,
  listAttendanceReviewQueue,
  listLeaveRequests,
  listLeaveTypes,
  type AttendanceLog,
  type AttendanceReviewItem,
  type AttendanceReviewStatus,
} from "@starter/shared/hris";
import { localDateOf } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import {
  MOCK_OUTLET,
  mockHrisViewer,
} from "../../lib/mock/handlers/hris-directory.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { mockLeaveKeepOnly } from "./mock-switches.ts";

const { tenant, attendanceLogs, leaveTypes } = cafeLegendHrisFixtures;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ulid = (n: number) =>
  `01JBQ7Z8K3M4N5P6Q7R8S9T${String(n).padStart(3, "0")}`;
const annualLeave = leaveTypes.find((type) => type.code === "ANNUAL");
const MOCK_REVIEWER_USER_ID = uuid(1002);

/** A fixture clock-in log of the shared attendance read model. */
function fixtureLog(id: string): AttendanceLog {
  const log = attendanceLogs.find((row) => row.id === id);
  if (!log) throw new Error(`[mock] missing fixture attendance log ${id}`);
  return log;
}

/** A clock-in that is not part of the shared attendance fixtures. */
function extraLog(
  logId: number,
  employeeNo: number,
  occurredAt: string,
  method: AttendanceLog["method"],
): AttendanceLog {
  return attendanceLogSchema.parse({
    id: ulid(logId),
    tenantId: tenant.id,
    employeeId: uuid(employeeNo),
    outletId: MOCK_OUTLET.id,
    type: "in",
    method,
    occurredAt,
    geoDistanceM: null,
    deviceIdHash: null,
    photoUrl: null,
    validity: "valid",
    shiftAssignmentId: null,
  });
}

function leaveRequest(
  n: number,
  employeeNo: number,
  startDate: string,
  endDate: string,
  days: string,
  decidedAt: string,
) {
  return leaveRequestSchema.parse({
    id: uuid(8800 + n),
    tenantId: tenant.id,
    employeeId: uuid(employeeNo),
    leaveTypeId: annualLeave?.id,
    startDate,
    endDate,
    days,
    reason: "Keperluan keluarga.",
    attachmentUrl: null,
    status: "approved",
    requestedAt: "2026-10-18T02:00:00.000Z",
    decidedBy: MOCK_REVIEWER_USER_ID,
    decidedAt,
  });
}

/** Leave rows of the four cases, plus the tenant's own fixture leave. */
const MOCK_LEAVE_REQUESTS = [
  ...cafeLegendHrisFixtures.leaveRequests,
  leaveRequest(
    1,
    1004,
    "2026-10-25",
    "2026-10-27",
    "3.0000",
    "2026-10-20T02:00:00.000Z",
  ),
  leaveRequest(
    2,
    1010,
    "2026-10-26",
    "2026-10-26",
    "1.0000",
    "2026-10-21T02:00:00.000Z",
  ),
  // Approved at 11:30 WIB, after Agus clocked in at 08:50: the log is reopened.
  leaveRequest(
    3,
    1005,
    "2026-10-26",
    "2026-10-26",
    "1.0000",
    "2026-10-26T04:30:00.000Z",
  ),
  leaveRequest(
    4,
    1008,
    "2026-10-26",
    "2026-10-26",
    "1.0000",
    "2026-10-22T02:00:00.000Z",
  ),
];

type Decision = {
  status: Exclude<AttendanceReviewStatus, "none">;
  reviewedAt: string;
};
type MockState = {
  /** logId -> decision recorded in this session. */
  decisions: Record<string, Decision>;
  /** Idempotency key -> what it decided, so a replay returns the same result. */
  replays: Record<string, { fingerprint: string; item: AttendanceReviewItem }>;
};
const store = createMockStore<MockState>(() => ({
  decisions: {},
  replays: {},
}));

function seedItems(): AttendanceReviewItem[] {
  const flagged = (log: AttendanceLog): AttendanceReviewItem => ({
    log,
    source: "flagged",
    flagReasons: ["leave_approved"],
    reviewStatus: "pending",
    reviewedBy: null,
    reviewedAt: null,
  });
  return [
    flagged(fixtureLog(ulid(104))),
    flagged(extraLog(301, 1010, "2026-10-26T02:10:00.000Z", "rotating_qr")),
    flagged(fixtureLog(ulid(108))),
    flagged(
      extraLog(302, 1008, "2026-10-26T01:55:00.000Z", "manual_correction"),
    ),
  ];
}

/** Seed items with this session's decisions applied. */
function currentItems(): AttendanceReviewItem[] {
  const { decisions } = store.get();
  return seedItems().map((item) => {
    const decision = decisions[item.log.id];
    return decision === undefined
      ? item
      : {
          ...item,
          reviewStatus: decision.status,
          reviewedBy: MOCK_REVIEWER_USER_ID,
          reviewedAt: decision.reviewedAt,
        };
  });
}

registerMock(listAttendanceReviewQueue, ({ query, scenario }) => {
  const rows = currentItems()
    .filter(
      (item) =>
        query.outletId === undefined || item.log.outletId === query.outletId,
    )
    .filter(
      (item) =>
        query.reviewStatus === undefined ||
        item.reviewStatus === query.reviewStatus,
    )
    .filter(
      (item) =>
        query.flagReason === undefined ||
        item.flagReasons.includes(query.flagReason),
    )
    .filter(
      (item) =>
        query.businessDate === undefined ||
        localDateOf(item.log.occurredAt, MOCK_OUTLET.timeZone) ===
          query.businessDate,
    )
    .sort(
      (left, right) =>
        Date.parse(right.log.occurredAt) - Date.parse(left.log.occurredAt),
    );
  return paginateFixture(rows, query, (item) => item.log.id, scenario);
});

registerMock(decideAttendanceReview, ({ params, body }) => {
  const viewer = mockHrisViewer();
  const permissions = viewer?.permissions ?? [];
  if (viewer === null || !permissions.includes("hr.attendance.manage"))
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Anda tidak punya akses untuk memutuskan tinjauan ini.",
    );
  if (
    body.action === "cancel_leave" &&
    (!permissions.includes("hr.leave.approve") || mockLeaveKeepOnly())
  )
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Anda tidak punya hak untuk membatalkan cuti.",
    );
  if (body.action !== "keep_leave" && body.action !== "cancel_leave")
    throw new ApiError(
      409,
      "ATTENDANCE_REVIEW_NOT_ALLOWED",
      "Keputusan ini bukan untuk absensi saat cuti.",
    );

  const fingerprint = `${params.logId}:${body.action}`;
  const replay = store.get().replays[body.idempotencyKey];
  if (replay !== undefined) {
    if (replay.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci permintaan sudah dipakai untuk keputusan lain.",
      );
    return { data: replay.item };
  }

  const item = currentItems().find((row) => row.log.id === params.logId);
  if (item === undefined)
    throw new ApiError(404, "NOT_FOUND", "Absensi tidak ditemukan.");
  if (item.reviewStatus !== "pending")
    throw new ApiError(
      409,
      "ATTENDANCE_LEAVE_DECISION_NOT_ALLOWED",
      "Absensi ini sudah diputuskan.",
    );

  const state = store.get();
  const reviewedAt = new Date().toISOString();
  const status = body.action === "keep_leave" ? "rejected" : "accepted";
  state.decisions[item.log.id] = { status, reviewedAt };
  const decided: AttendanceReviewItem = {
    ...item,
    reviewStatus: status,
    reviewedBy: MOCK_REVIEWER_USER_ID,
    reviewedAt,
  };
  state.replays[body.idempotencyKey] = { fingerprint, item: decided };
  return { data: decided };
});

registerMock(listLeaveRequests, ({ query, scenario }) => {
  const rows = MOCK_LEAVE_REQUESTS.filter(
    (row) =>
      query.employeeId === undefined || row.employeeId === query.employeeId,
  ).filter((row) => query.status === undefined || row.status === query.status);
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(listLeaveTypes, ({ query, scenario }) =>
  paginateFixture(leaveTypes, query, (type) => type.id, scenario),
);
