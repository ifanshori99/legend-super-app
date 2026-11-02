// Shared HRIS read models for mock mode (WS-10, PRD v1.7 §3 Kelompok D).
//
// Several WS-10 screens read the same fixtures: the employee master shows the
// directory and org structure, the roster needs every shift, the attendance
// review needs the outlet's logs, the KPI/announcement screens need the same
// announcements the employee PWA card shows, and the payroll screens need the
// employee directory for pickers. `registerMock` allows one owner per endpoint,
// so those reads live here instead of in one feature's `mock.ts`; features
// import the store/helpers below when they mutate the same rows.
//
// The employee PWA (legend-nv3y) keeps ownership of the self-scoped endpoints
// (`getMyHrisProfile` moved here, so the payslip screens can resolve "me"),
// the clock, and the correction flow; it imports the store so a clocked log
// still lands in the shared attendance read model.
import {
  cafeLegendHrisFixtures,
  getEmployee,
  getEmployeePii,
  getEmploymentContract,
  getMyHrisProfile,
  listAnnouncements,
  listAttendanceLogs,
  listEmployeeDocuments,
  listEmployees,
  listEmploymentContracts,
  listHolidays,
  listOrgUnits,
  listPositionGrades,
  listPositions,
  listShiftAssignments,
  type Announcement,
  type AttendanceCorrection,
  type AttendanceLog,
  type EmployeePii,
} from "@starter/shared/hris";
import { localDateOf } from "@starter/shared/core";
import { ApiError } from "../../api/errors.ts";
import { paginateFixture } from "../paginate.ts";
import { registerMock } from "../registry.ts";
import { createMockStore } from "../store.ts";

const { tenant, outlets, employees, employeePii } = cafeLegendHrisFixtures;
export const MOCK_OUTLET = outlets[0];

/**
 * The mock's signed-in employee (HR-01): CL-1003, the fixture row that has
 * published shifts and a full day of attendance logs to render.
 */
export const MOCK_ME =
  employees.find((employee) => employee.employeeNo === "CL-1003") ??
  employees[0];

type Replay = { fingerprint: string; id: string };

export type HrisMockState = {
  logs: AttendanceLog[];
  corrections: AttendanceCorrection[];
  /**
   * Idempotency key → (request fingerprint, row id), so a replay never creates
   * a second row and a reused key with a different body fails like the API
   * (`IDEMPOTENCY_KEY_REUSED`, docs/plan/contracts.md "Idempotent mutations").
   */
  correctionReplays: Record<string, Replay>;
  clockReplays: Record<string, Replay>;
  /** Per-device binding hashes a supervisor has registered (F25). */
  boundDevices: string[];
};

function seed(): HrisMockState {
  return {
    logs: [...cafeLegendHrisFixtures.attendanceLogs],
    corrections: [...cafeLegendHrisFixtures.attendanceCorrections],
    correctionReplays: {},
    clockReplays: {},
    // Fixture logs record their own device hashes; they are bound devices.
    boundDevices: [
      ...new Set(
        cafeLegendHrisFixtures.attendanceLogs
          .filter((log) => log.employeeId === MOCK_ME.id)
          .map((log) => log.deviceIdHash)
          .filter((hash): hash is string => hash !== null),
      ),
    ],
  };
}

/** Shared mutable state: the clock writes logs the review screen then sees. */
export const hrisMockStore = createMockStore<HrisMockState>(seed);

/** Every attendance log in the mock, newest first. */
export function hrisMockLogs(): AttendanceLog[] {
  return hrisMockStore
    .get()
    .logs.slice()
    .sort(
      (left, right) =>
        Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
    );
}

/** One employee's logs, newest first. */
export function hrisMockLogsFor(employeeId: string): AttendanceLog[] {
  return hrisMockLogs().filter((log) => log.employeeId === employeeId);
}

/** One employee's correction requests, newest first. */
export function hrisMockCorrectionsFor(
  employeeId: string,
): AttendanceCorrection[] {
  return hrisMockStore
    .get()
    .corrections.filter((row) => row.employeeId === employeeId)
    .sort(
      (left, right) =>
        Date.parse(right.requestedAt) - Date.parse(left.requestedAt),
    );
}

/** The outlet's logs for one business date (the supervisor review screen). */
export function hrisMockLogsForOutletDate(
  outletId: string,
  businessDate: string,
): AttendanceLog[] {
  return hrisMockLogs().filter(
    (log) =>
      log.outletId === outletId &&
      localDateOf(log.occurredAt, MOCK_OUTLET.timeZone) === businessDate,
  );
}

registerMock(getMyHrisProfile, ({ scenario }) => {
  // The profile is required to render anything; `?mock=empty` empties the
  // lists around it, not the signed-in employee.
  void scenario;
  return { data: { employee: MOCK_ME, outlet: MOCK_OUTLET } };
});

registerMock(listEmployees, ({ query, scenario }) => {
  const rows = employees
    .filter(
      (employee) =>
        query.status === undefined || employee.status === query.status,
    )
    .filter(
      (employee) =>
        query.outletId === undefined ||
        employee.homeOutletId === query.outletId,
    )
    .filter(
      (employee) =>
        query.positionId === undefined ||
        employee.positionId === query.positionId,
    )
    .slice()
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
  return paginateFixture(rows, query, (employee) => employee.id, scenario);
});

registerMock(getEmployee, ({ params }) => {
  const employee = employees.find((row) => row.id === params.employeeId);
  if (!employee)
    throw new ApiError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");
  return { data: employee };
});

/**
 * Masked PII per employee, mutable so the employee-master screen's edit flow
 * (HR-03, write-only input) shows the new masked value on refetch.
 */
export const hrisMockPiiStore = createMockStore<Record<string, EmployeePii>>(
  () =>
    Object.fromEntries(
      employeePii.map((entry) => [entry.employeeId, entry.pii]),
    ),
);

/** Replaces one employee's masked PII values (the mock's encrypt-and-store). */
export function setHrisMockPii(
  employeeId: string,
  patch: Partial<EmployeePii>,
): EmployeePii {
  const state = hrisMockPiiStore.get();
  const current = state[employeeId];
  if (!current)
    throw new ApiError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");
  const next = { ...current, ...patch };
  hrisMockPiiStore.set({ ...state, [employeeId]: next });
  return next;
}

registerMock(getEmployeePii, ({ params }) => {
  const pii = hrisMockPiiStore.get()[params.employeeId];
  if (!pii) throw new ApiError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");
  // HR-03: the mock serves the same masked shape the API does. The role-based
  // visibility gate is a permission check on the API; a role without
  // `hr.employee.view` gets 403 there (the screen shows the locked state).
  return { data: pii };
});

registerMock(listOrgUnits, ({ query, scenario }) =>
  paginateFixture(
    cafeLegendHrisFixtures.orgUnits,
    query,
    (unit) => unit.id,
    scenario,
  ),
);

registerMock(listPositionGrades, ({ query, scenario }) =>
  paginateFixture(
    cafeLegendHrisFixtures.grades,
    query,
    (grade) => grade.id,
    scenario,
  ),
);

registerMock(listPositions, ({ query }) => {
  const rows = cafeLegendHrisFixtures.positions.filter(
    (position) =>
      query.orgUnitId === undefined || position.orgUnitId === query.orgUnitId,
  );
  // Reference data for a label, not a list the employee screens: keep it
  // when `?mock=empty` empties the day's logs and roster.
  return paginateFixture(rows, query, (position) => position.id);
});

registerMock(listEmploymentContracts, ({ query, scenario }) => {
  const rows = cafeLegendHrisFixtures.contracts
    .filter(
      (contract) =>
        query.employeeId === undefined ||
        contract.employeeId === query.employeeId,
    )
    .filter(
      (contract) =>
        query.status === undefined || contract.status === query.status,
    )
    .filter(
      (contract) =>
        query.expiringBefore === undefined ||
        (contract.endDate !== null && contract.endDate <= query.expiringBefore),
    );
  return paginateFixture(rows, query, (contract) => contract.id, scenario);
});

registerMock(getEmploymentContract, ({ params }) => {
  const contract = cafeLegendHrisFixtures.contracts.find(
    (row) => row.id === params.contractId,
  );
  if (!contract)
    throw new ApiError(404, "NOT_FOUND", "Kontrak tidak ditemukan.");
  return { data: contract };
});

registerMock(listEmployeeDocuments, ({ params, query, scenario }) => {
  const rows = cafeLegendHrisFixtures.documents.filter(
    (document) => document.employeeId === params.employeeId,
  );
  return paginateFixture(rows, query, (document) => document.id, scenario);
});

registerMock(listShiftAssignments, ({ query, scenario }) => {
  const rows = cafeLegendHrisFixtures.shiftAssignments
    .filter(
      (assignment) =>
        query.employeeId === undefined ||
        assignment.employeeId === query.employeeId,
    )
    .filter(
      (assignment) =>
        query.outletId === undefined || assignment.outletId === query.outletId,
    )
    .filter(
      (assignment) =>
        query.from === undefined || assignment.businessDate >= query.from,
    )
    .filter(
      (assignment) =>
        query.to === undefined || assignment.businessDate <= query.to,
    )
    .slice()
    .sort(
      (left, right) =>
        left.businessDate.localeCompare(right.businessDate) ||
        (left.segments[0]?.startsAt ?? "").localeCompare(
          right.segments[0]?.startsAt ?? "",
        ),
    );
  return paginateFixture(rows, query, (assignment) => assignment.id, scenario);
});

registerMock(listAttendanceLogs, ({ query, scenario }) => {
  const rows = hrisMockLogs()
    .filter(
      (log) =>
        query.employeeId === undefined || log.employeeId === query.employeeId,
    )
    .filter(
      (log) =>
        query.businessDate === undefined ||
        localDateOf(log.occurredAt, MOCK_OUTLET.timeZone) ===
          query.businessDate,
    );
  return paginateFixture(rows, query, (log) => log.id, scenario);
});

registerMock(listAnnouncements, ({ query, scenario }) => {
  const rows: Announcement[] = cafeLegendHrisFixtures.announcements
    .slice()
    .sort(
      (left, right) =>
        Date.parse(right.publishedAt) - Date.parse(left.publishedAt),
    );
  return paginateFixture(
    rows,
    query,
    (announcement) => announcement.id,
    scenario,
  );
});

registerMock(listHolidays, ({ query, scenario }) => {
  const rows = cafeLegendHrisFixtures.holidays.filter(
    (holiday) =>
      query.year === undefined || holiday.date.startsWith(`${query.year}-`),
  );
  return paginateFixture(rows, query, (holiday) => holiday.id, scenario);
});

// Referenced by the fixtures' tenant for parity with the API mocks; keeps the
// unused-import check honest while the directory itself is tenant-scoped by
// the API, not by the mock.
void tenant;
