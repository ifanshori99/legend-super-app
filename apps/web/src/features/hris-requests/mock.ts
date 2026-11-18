// Mock handlers of the HRIS requests feature (539-U4 / legend-ydf2): shift
// swaps and covers, leave balances and requests, overtime. Owns
// `listShiftSwapRequests`, `createShiftSwapRequest`, `cancelShiftSwapRequest`,
// `decideShiftSwapRequest`, `listLeaveBalances`, `createLeaveRequest`,
// `decideLeaveRequest`, `listOvertimeRequests`, `createOvertimeRequest` and
// `decideOvertimeRequest`. Not owned here (registered elsewhere, reused as
// they are): `listLeaveRequests` and `listLeaveTypes`
// (features/hr-leave-clockin-review/mock.ts), `listShiftAssignments`,
// `listEmployees`, `listHolidays` and `getMyHrisProfile`
// (lib/mock/handlers/hris-directory.ts).
//
// Review sample data: a pending and a rejected overtime of CL-1003, relative to today.
//
// Known mock gap: a leave request filed here is stored in this file's state,
// but `listLeaveRequests` belongs to the 3jem1 mock and serves its own rows, so
// the new request does not appear in the employee's leave list until the
// mock is merged. Deciding a leave request only works for rows of the shared
// fixtures (the 3jem1 extra rows answer 404).
//
// The signed-in employee is CL-1003 (MOCK_ME). A swap is checked with the real
// compliance function against the mock roster, so a swap that breaks a rule
// comes back with `complianceIssues` and needs an override on approval (HR-05).
//
// Switches in mock mode (VITE_API_MOCK=true): ?mock=empty (empty lists),
// ?mock=error, ?mock=offline, ?mock=slow; window.__legendMock.failNext(
// "POST /api/hris/shift-swaps", { status: 409, code: "CONFLICT" }) fails one
// write. Seeded rows: swap 7401 pending with compliance issues (CL-1003 ->
// CL-1005), 7402 approved; overtime 8401 pending, 8402 approved.
import {
  cafeLegendHrisFixtures,
  cancelShiftSwapRequest,
  createLeaveRequest,
  createOvertimeRequest,
  createShiftSwapRequest,
  decideLeaveRequest,
  decideOvertimeRequest,
  decideShiftSwapRequest,
  evaluateShiftSwapCompliance,
  leaveDaysRemaining,
  leaveBalanceSchema,
  leaveRequestSchema,
  listLeaveBalances,
  listOvertimeRequests,
  listShiftSwapRequests,
  listShiftSwapCandidates,
  respondShiftSwapRequest,
  overtimeRequestSchema,
  shiftSwapRequestSchema,
  transitionLeaveRequest,
  transitionOvertimeRequest,
  transitionShiftSwap,
  type LeaveBalance,
  type LeaveRequest,
  type OvertimeRequest,
  type ShiftSwapRequest,
  type ShiftAssignment,
} from "@starter/shared/hris";
import {
  addBusinessDays,
  CoreError,
  localDateOf,
  type UserId,
} from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import {
  MOCK_ME,
  MOCK_OUTLET,
  MOCK_SHIFT_ASSIGNMENTS,
} from "../../lib/mock/handlers/hris-directory.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";

const {
  tenant,
  employees,
  leaveTypes,
  shiftCompliancePolicy,
  shiftSwapRequests,
  leaveBalances,
  leaveRequests,
  overtimeRequests,
} = cafeLegendHrisFixtures;

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** The user id the mock supervisor decides as. */
const MOCK_DECIDER_USER_ID = uuid(1002) as UserId;
const FIRST_NEW_ID = 9000;

// ---- Review sample data (relative to today) -----------------------------------
//
// Two overtime requests of CL-1003, dated relative to today in the outlet's
// time zone: one pending, one rejected, so "Pengajuan saya" shows a rejected
// status. The shared roster is not touched (the e2e counts CL-1003's shifts).
const today = localDateOf(new Date(), MOCK_OUTLET.timeZone);

function sampleOvertimes(): OvertimeRequest[] {
  return [
    overtimeRequestSchema.parse({
      id: uuid(8451),
      tenantId: cafeLegendHrisFixtures.tenant.id,
      employeeId: MOCK_ME.id,
      outletId: MOCK_OUTLET.id,
      date: addBusinessDays(today, 2),
      minutes: 60,
      reason: "Menutup outlet setelah acara malam.",
      dayType: "workday",
      formulaId: null,
      status: "pending",
      requestedAt: new Date().toISOString(),
      decidedBy: null,
      decidedAt: null,
    }),
    overtimeRequestSchema.parse({
      id: uuid(8452),
      tenantId: cafeLegendHrisFixtures.tenant.id,
      employeeId: MOCK_ME.id,
      outletId: MOCK_OUTLET.id,
      date: addBusinessDays(today, -3),
      minutes: 90,
      reason: "Membantu stok opname.",
      dayType: "workday",
      formulaId: null,
      status: "rejected",
      requestedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      decidedBy: uuid(1002),
      decidedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    }),
  ];
}

type State = {
  nextId: number;
  swaps: ShiftSwapRequest[];
  leaves: LeaveRequest[];
  balances: LeaveBalance[];
  overtimes: OvertimeRequest[];
  /** idempotencyKey -> fingerprint and answer, so a replay returns the same row. */
  replays: Record<string, { fingerprint: string; row: unknown }>;
};

const store = createMockStore<State>(() => ({
  nextId: FIRST_NEW_ID,
  swaps: shiftSwapRequests.map((row) => ({
    ...row,
    peerAcceptedAt:
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("peer") === "pending"
        ? null
        : (row.peerAcceptedAt ??
          (row.status === "pending" ? row.requestedAt : null)),
  })),
  leaves: [...leaveRequests],
  balances: [...leaveBalances],
  overtimes: [...sampleOvertimes(), ...overtimeRequests],
  replays: {},
}));

function newId(): string {
  const state = store.get();
  state.nextId += 1;
  return uuid(state.nextId);
}

/** Same key + same body = the earlier answer; same key + other body = 409. */
function replay<T>(key: string, body: unknown, create: () => T): T {
  const state = store.get();
  const fingerprint = JSON.stringify(body);
  const known = state.replays[key];
  if (known !== undefined) {
    if (known.fingerprint !== fingerprint)
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Kunci ini sudah dipakai untuk permintaan lain.",
      );
    return known.row as T;
  }
  const row = create();
  state.replays[key] = { fingerprint, row };
  return row;
}

function notFound(message: string): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

/** A contract transition error becomes the API's 409. */
function asConflict(error: unknown): never {
  if (error instanceof CoreError)
    throw new ApiError(409, "CONFLICT", error.message);
  throw error;
}

function newestFirst<T extends { requestedAt: string; id: string }>(
  rows: readonly T[],
): T[] {
  return rows
    .slice()
    .sort(
      (left, right) =>
        Date.parse(right.requestedAt) - Date.parse(left.requestedAt) ||
        left.id.localeCompare(right.id),
    );
}

// ---- Shift swaps and covers -----------------------------------------------

function requestAssignment(row: ShiftAssignment | undefined) {
  return row === undefined
    ? null
    : {
        id: row.id,
        businessDate: row.businessDate,
        segments: row.segments,
        breakMinutes: row.breakMinutes,
      };
}

function withSwapContext(row: ShiftSwapRequest): ShiftSwapRequest {
  return {
    ...row,
    requestedByName:
      employees.find((employee) => employee.id === row.requestedBy)?.fullName ??
      null,
    toEmployeeName:
      employees.find((employee) => employee.id === row.toEmployeeId)
        ?.fullName ?? null,
    fromAssignment: requestAssignment(
      MOCK_SHIFT_ASSIGNMENTS.find(
        (assignment) => assignment.id === row.fromAssignmentId,
      ),
    ),
    toAssignment:
      row.toAssignmentId === null
        ? null
        : requestAssignment(
            MOCK_SHIFT_ASSIGNMENTS.find(
              (assignment) => assignment.id === row.toAssignmentId,
            ),
          ),
  };
}

registerMock(listShiftSwapCandidates, ({ query, scenario }) => {
  const from = MOCK_SHIFT_ASSIGNMENTS.find(
    (row) =>
      row.id === query.fromAssignmentId &&
      row.employeeId === MOCK_ME.id &&
      row.outletId === query.outletId,
  );
  if (!from) throw notFound("Shift tidak ditemukan.");
  return {
    data:
      scenario === "empty"
        ? []
        : employees
            .filter(
              (row) =>
                row.id !== MOCK_ME.id &&
                row.homeOutletId === query.outletId &&
                row.status === "active",
            )
            .map((row) => ({
              id: row.id,
              name: row.fullName,
              assignments: MOCK_SHIFT_ASSIGNMENTS.filter(
                (assignment) =>
                  assignment.employeeId === row.id &&
                  assignment.outletId === query.outletId &&
                  assignment.status === "published" &&
                  assignment.businessDate >= today &&
                  assignment.businessDate <= addBusinessDays(today, 60),
              ).map((assignment) => ({
                id: assignment.id,
                businessDate: assignment.businessDate,
                segments: assignment.segments,
                breakMinutes: assignment.breakMinutes,
              })),
            })),
  };
});

registerMock(respondShiftSwapRequest, ({ params, body }) => ({
  data: replay(body.idempotencyKey, { swapId: params.swapId, ...body }, () => {
    const swap = findSwap(params.swapId);
    if (swap.toEmployeeId !== MOCK_ME.id)
      throw new ApiError(403, "FORBIDDEN", "Bukan permintaan untuk Anda.");
    if (swap.status !== "pending" || swap.peerAcceptedAt !== null)
      throw new ApiError(409, "CONFLICT", "Permintaan sudah diproses.");
    return saveSwap(
      body.action === "accept"
        ? { ...swap, peerAcceptedAt: new Date().toISOString() }
        : {
            ...swap,
            status: "rejected",
            rejectionReason: body.rejectionReason ?? null,
            approvedBy: MOCK_DECIDER_USER_ID,
            decidedAt: new Date().toISOString(),
          },
    );
  }),
}));

registerMock(listShiftSwapRequests, ({ query, scenario }) => {
  const rows = newestFirst(
    store
      .get()
      .swaps.filter(
        (row) =>
          (query.outletId === undefined || row.outletId === query.outletId) &&
          (query.status === undefined || row.status === query.status) &&
          (query.mine !== true ||
            row.requestedBy === MOCK_ME.id ||
            row.toEmployeeId === MOCK_ME.id),
      ),
  );
  return paginateFixture(
    rows.map(withSwapContext),
    query,
    (row) => row.id,
    scenario,
  );
});

registerMock(createShiftSwapRequest, ({ body }) => {
  const { idempotencyKey, ...payload } = body;
  return {
    data: replay(idempotencyKey, payload, () => {
      const state = store.get();
      const from = MOCK_SHIFT_ASSIGNMENTS.find(
        (row) => row.id === body.fromAssignmentId,
      );
      if (from === undefined || from.employeeId !== MOCK_ME.id)
        throw notFound("Shift tidak ditemukan.");
      if (body.toEmployeeId === MOCK_ME.id)
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Pilih rekan lain untuk tukar shift.",
          [{ field: "toEmployeeId", message: "Pilih rekan lain." }],
        );
      if (!employees.some((row) => row.id === body.toEmployeeId))
        throw notFound("Rekan tidak ditemukan.");
      if (body.toAssignmentId !== null) {
        const to = MOCK_SHIFT_ASSIGNMENTS.find(
          (row) => row.id === body.toAssignmentId,
        );
        if (to === undefined || to.employeeId !== body.toEmployeeId)
          throw notFound("Shift rekan tidak ditemukan.");
      }
      if (
        state.swaps.some(
          (row) =>
            row.fromAssignmentId === body.fromAssignmentId &&
            row.status === "pending",
        )
      )
        throw new ApiError(
          409,
          "CONFLICT",
          "Shift ini masih punya permintaan tukar yang menunggu.",
        );
      const swap = shiftSwapRequestSchema.parse({
        id: newId(),
        tenantId: tenant.id,
        outletId: body.outletId,
        fromAssignmentId: body.fromAssignmentId,
        toAssignmentId: body.toAssignmentId,
        requestedBy: MOCK_ME.id,
        toEmployeeId: body.toEmployeeId,
        status: "pending",
        complianceIssues: evaluateShiftSwapCompliance({
          assignments: MOCK_SHIFT_ASSIGNMENTS,
          fromAssignmentId: body.fromAssignmentId,
          toEmployeeId: body.toEmployeeId,
          toAssignmentId: body.toAssignmentId,
          policy: shiftCompliancePolicy,
        }),
        overrideReason: null,
        rejectionReason: null,
        peerAcceptedAt: null,
        approvedBy: null,
        requestedAt: new Date().toISOString(),
        decidedAt: null,
      });
      state.swaps = [swap, ...state.swaps];
      return swap;
    }),
  };
});

function findSwap(id: string): ShiftSwapRequest {
  const swap = store.get().swaps.find((row) => row.id === id);
  if (swap === undefined) throw notFound("Permintaan tidak ditemukan.");
  return swap;
}

function saveSwap(next: ShiftSwapRequest): ShiftSwapRequest {
  const parsed = shiftSwapRequestSchema.parse(next);
  const state = store.get();
  state.swaps = state.swaps.map((row) => (row.id === parsed.id ? parsed : row));
  return parsed;
}

registerMock(cancelShiftSwapRequest, ({ params, body }) => ({
  data: replay(body.idempotencyKey, params.swapId, () => {
    const swap = findSwap(params.swapId);
    if (swap.requestedBy !== MOCK_ME.id)
      throw new ApiError(403, "FORBIDDEN", "Bukan permintaan Anda.");
    try {
      transitionShiftSwap(swap.status, "cancel");
    } catch (error) {
      return asConflict(error);
    }
    return saveSwap({ ...swap, status: "cancelled" });
  }),
}));

registerMock(decideShiftSwapRequest, ({ params, body }) => ({
  data: replay(
    body.idempotencyKey,
    { id: params.swapId, action: body.action, reason: body.overrideReason },
    () => {
      const swap = findSwap(params.swapId);
      if (swap.peerAcceptedAt === null)
        throw new ApiError(409, "CONFLICT", "Menunggu respons rekan.");
      if (
        body.action === "approve_with_override" &&
        (body.overrideReason === null || body.overrideReason.trim() === "")
      )
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "Persetujuan dengan pengecualian wajib beralasan.",
          [{ field: "overrideReason", message: "Alasan wajib diisi." }],
        );
      if (
        body.action === "approve_with_override" &&
        swap.complianceIssues.length === 0
      )
        throw new ApiError(
          409,
          "CONFLICT",
          "Tidak ada pelanggaran aturan jam kerja yang perlu dikecualikan.",
        );
      try {
        transitionShiftSwap(swap.status, body.action, {
          complianceIssues: swap.complianceIssues,
          overrideReason: body.overrideReason,
        });
      } catch (error) {
        return asConflict(error);
      }
      const approved =
        body.action === "approve" || body.action === "approve_with_override";
      return saveSwap({
        ...swap,
        status: approved ? "approved" : "rejected",
        overrideReason:
          body.action === "approve_with_override" ? body.overrideReason : null,
        rejectionReason: approved ? null : (body.rejectionReason ?? null),
        approvedBy: MOCK_DECIDER_USER_ID,
        decidedAt: new Date().toISOString(),
      });
    },
  ),
}));

// ---- Leave ------------------------------------------------------------------

registerMock(listLeaveBalances, ({ query, scenario }) => {
  const rows = store
    .get()
    .balances.filter(
      (row) =>
        (query.employeeId === undefined ||
          row.employeeId === query.employeeId) &&
        (query.year === undefined || row.periodYear === query.year),
    );
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

/** Calendar days of an inclusive range (the mock has no holiday rules). */
function inclusiveDays(startDate: string, endDate: string): number {
  return (
    Math.round(
      (Date.parse(`${endDate}T00:00:00Z`) -
        Date.parse(`${startDate}T00:00:00Z`)) /
        86_400_000,
    ) + 1
  );
}

registerMock(createLeaveRequest, ({ body }) => {
  const { idempotencyKey, ...payload } = body;
  return {
    data: replay(idempotencyKey, payload, () => {
      const state = store.get();
      const type = leaveTypes.find((row) => row.id === body.leaveTypeId);
      if (type === undefined) throw notFound("Jenis cuti tidak ditemukan.");
      if (body.endDate < body.startDate)
        throw new ApiError(400, "VALIDATION_ERROR", "Tanggal tidak valid.", [
          { field: "endDate", message: "Tanggal akhir sebelum tanggal mulai." },
        ]);
      if (type.requiresAttachment && body.attachmentUploadRef === null)
        throw new ApiError(400, "VALIDATION_ERROR", "Lampiran wajib.", [
          { field: "attachmentUploadRef", message: "Lampiran wajib diisi." },
        ]);
      const days = inclusiveDays(body.startDate, body.endDate);
      const year = Number(body.startDate.slice(0, 4));
      const balance = state.balances.find(
        (row) =>
          row.employeeId === MOCK_ME.id &&
          row.leaveTypeId === type.id &&
          row.periodYear === year,
      );
      if (type.policy.tracksBalance && balance !== undefined) {
        const remaining = Number(leaveDaysRemaining(balance));
        if (remaining + Number(type.policy.negativeAllowanceDays) < days)
          throw new ApiError(
            409,
            "CONFLICT",
            "Saldo cuti tidak cukup untuk tanggal ini.",
          );
        state.balances = state.balances.map((row) =>
          row.id === balance.id
            ? leaveBalanceSchema.parse({
                ...row,
                pendingDays: (Number(row.pendingDays) + days).toFixed(4),
              })
            : row,
        );
      }
      const request = leaveRequestSchema.parse({
        id: newId(),
        tenantId: tenant.id,
        employeeId: MOCK_ME.id,
        leaveTypeId: type.id,
        startDate: body.startDate,
        endDate: body.endDate,
        days: days.toFixed(4),
        reason: body.reason,
        attachmentUrl: null,
        status: "pending",
        requestedAt: new Date().toISOString(),
        decidedBy: null,
        decidedAt: null,
      });
      state.leaves = [request, ...state.leaves];
      return request;
    }),
  };
});

registerMock(decideLeaveRequest, ({ params, body }) => ({
  data: replay(
    body.idempotencyKey,
    { id: params.leaveRequestId, action: body.action },
    () => {
      const state = store.get();
      const request = state.leaves.find(
        (row) => row.id === params.leaveRequestId,
      );
      if (request === undefined)
        throw notFound("Pengajuan cuti tidak ditemukan.");
      let status: LeaveRequest["status"];
      try {
        status = transitionLeaveRequest(request.status, body.action);
      } catch (error) {
        return asConflict(error);
      }
      const decided = leaveRequestSchema.parse({
        ...request,
        status,
        decidedBy: MOCK_DECIDER_USER_ID,
        decidedAt: new Date().toISOString(),
      });
      state.leaves = state.leaves.map((row) =>
        row.id === decided.id ? decided : row,
      );
      return decided;
    },
  ),
}));

// ---- Overtime -----------------------------------------------------------------

registerMock(listOvertimeRequests, ({ query, scenario }) => {
  const rows = newestFirst(
    store
      .get()
      .overtimes.filter(
        (row) =>
          (query.employeeId === undefined ||
            row.employeeId === query.employeeId) &&
          (query.status === undefined || row.status === query.status) &&
          (query.from === undefined || row.date >= query.from) &&
          (query.to === undefined || row.date <= query.to),
      ),
  );
  return paginateFixture(
    rows.map((row) => ({
      ...row,
      employeeName:
        employees.find((employee) => employee.id === row.employeeId)
          ?.fullName ?? null,
    })),
    query,
    (row) => row.id,
    scenario,
  );
});

registerMock(createOvertimeRequest, ({ body }) => {
  const { idempotencyKey, ...payload } = body;
  return {
    data: replay(idempotencyKey, payload, () => {
      const state = store.get();
      if (
        state.overtimes.some(
          (row) =>
            row.employeeId === MOCK_ME.id &&
            row.date === body.date &&
            row.status === "pending",
        )
      )
        throw new ApiError(
          409,
          "CONFLICT",
          "Sudah ada pengajuan lembur yang menunggu untuk tanggal ini.",
        );
      const request = overtimeRequestSchema.parse({
        id: newId(),
        tenantId: tenant.id,
        employeeId: MOCK_ME.id,
        outletId: body.outletId,
        date: body.date,
        minutes: body.minutes,
        reason: body.reason,
        dayType: "workday",
        formulaId: null,
        status: "pending",
        requestedAt: new Date().toISOString(),
        decidedBy: null,
        decidedAt: null,
      });
      state.overtimes = [request, ...state.overtimes];
      return request;
    }),
  };
});

registerMock(decideOvertimeRequest, ({ params, body }) => ({
  data: replay(
    body.idempotencyKey,
    { id: params.overtimeRequestId, action: body.action },
    () => {
      const state = store.get();
      const request = state.overtimes.find(
        (row) => row.id === params.overtimeRequestId,
      );
      if (request === undefined)
        throw notFound("Pengajuan lembur tidak ditemukan.");
      let status: OvertimeRequest["status"];
      try {
        status = transitionOvertimeRequest(request.status, body.action);
      } catch (error) {
        return asConflict(error);
      }
      const decided = overtimeRequestSchema.parse({
        ...request,
        status,
        decidedBy: MOCK_DECIDER_USER_ID,
        decidedAt: new Date().toISOString(),
      });
      state.overtimes = state.overtimes.map((row) =>
        row.id === decided.id ? decided : row,
      );
      return decided;
    },
  ),
}));
