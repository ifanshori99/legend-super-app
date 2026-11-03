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
  hrisPiiVisibility,
  type Announcement,
  type AttendanceCorrection,
  type AttendanceLog,
  type Employee,
  type EmployeeDocument,
  type EmployeePii,
  type EmploymentContract,
  type HrisPiiClass,
  type HrisViewer,
  type HrisViewerKind,
} from "@starter/shared/hris";
import { localDateOf } from "@starter/shared/core";
import {
  accessForMockRole,
  MOCK_ROLE_COOKIE,
  parseMockRole,
  type MockRole,
} from "../../areas/access.ts";
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

// ---- Who is asking (HR-01 / HR-03) ----------------------------------------
//
// The API resolves an `HrisViewer` from the session; the mock resolves it from
// the same `legend-mock-role` cookie the route guards read, so a role without
// the PII read right gets what the API would give it (`hidden` → null), never
// the stored masked value. Off the browser (SSR loaders) there is no cookie to
// read: the viewer is `null` and every PII-bearing read fails closed, which is
// why the profile loader does not prefetch PII, contracts or documents.

/** Role template → the viewer kind the API resolves (pii.ts HRIS_VIEWER_KINDS). */
function viewerKindFor(role: Exclude<MockRole, "none">): HrisViewerKind {
  switch (role) {
    // "all" is the dev default (every permission): review as HR.
    case "all":
    case "hr":
      return "hr";
    case "finance":
      return "payroll";
    case "owner":
    case "shareholder":
      return "owner";
    case "employee":
      return "self";
    default:
      // GM, outlet manager, supervisor, leads and everyone else: the
      // contract's most restrictive non-owner column.
      return "supervisor";
  }
}

/** The mock's signed-in HRIS viewer, or null when it cannot be known. */
export function mockHrisViewer(): HrisViewer | null {
  if (typeof document === "undefined") return null;
  const prefix = `${MOCK_ROLE_COOKIE}=`;
  const cookie = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(prefix));
  const role = parseMockRole(
    cookie === undefined
      ? undefined
      : decodeURIComponent(cookie.slice(prefix.length)),
  );
  if (role === "none") return null;
  const kind = viewerKindFor(role);
  return {
    kind,
    // Only the employee role is a person with a row in the fixtures; a back
    // office account has none, so `self` can never match someone else.
    employeeId: kind === "self" ? MOCK_ME.id : null,
    permissions: accessForMockRole(role).permissions,
  };
}

/** HR-01: a `self` viewer reaching another employee gets a 404, like the API. */
function assertCanViewEmployee(
  viewer: HrisViewer | null,
  employeeId: string,
): asserts viewer is HrisViewer {
  if (viewer === null)
    throw new ApiError(401, "UNAUTHENTICATED", "Masuk terlebih dahulu.");
  if (viewer.kind === "self" && viewer.employeeId !== employeeId)
    throw new ApiError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");
}

/** The PII class of each masked wire field (pii.ts HRIS_PII_FIELDS). */
const EMPLOYEE_PII_CLASS: Record<keyof EmployeePii, HrisPiiClass> = {
  nik: "identity",
  npwp: "tax",
  bpjsKesNo: "social_security",
  bpjsTkNo: "social_security",
  bankAccount: "bank",
  emergencyContactName: "emergency_contact",
  emergencyContactPhone: "emergency_contact",
};

/** `hidden` serialises as null; `full` and `masked` both stay masked on the wire. */
function visibleFor<T>(
  viewer: HrisViewer | null,
  employeeId: string,
  piiClass: HrisPiiClass,
  value: T | null,
): T | null {
  if (viewer === null) return null;
  return hrisPiiVisibility(viewer, employeeId, piiClass) === "hidden"
    ? null
    : value;
}

/** HR-03: the viewer's view of one employee's masked PII. */
export function redactEmployeePii(
  viewer: HrisViewer | null,
  employeeId: string,
  pii: EmployeePii,
): EmployeePii {
  const out = { ...pii };
  for (const field of Object.keys(EMPLOYEE_PII_CLASS) as (keyof EmployeePii)[])
    out[field] = visibleFor(
      viewer,
      employeeId,
      EMPLOYEE_PII_CLASS[field],
      pii[field],
    );
  return out;
}

/** HR-03: salary snapshot and contract file follow the salary/document classes. */
function redactContract(
  viewer: HrisViewer | null,
  contract: EmploymentContract,
): EmploymentContract {
  return {
    ...contract,
    salarySnapshot: visibleFor(
      viewer,
      contract.employeeId,
      "salary",
      contract.salarySnapshot,
    ),
  };
}

/** HR-03: a document's signed URL follows the `document` class. */
function redactDocument(
  viewer: HrisViewer | null,
  document: EmployeeDocument,
): EmployeeDocument {
  return {
    ...document,
    downloadUrl: visibleFor(
      viewer,
      document.employeeId,
      "document",
      document.downloadUrl,
    ),
  };
}

/** HR-01: a `self` viewer lists only their own row. */
function inViewerScope(viewer: HrisViewer | null, employee: Employee) {
  return viewer?.kind !== "self" || employee.id === viewer.employeeId;
}

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
  // HR-01: an employee lists their own row only. Master data carries no PII,
  // so a back-office viewer (or the SSR loader, viewer unknown) gets the list.
  const viewer = mockHrisViewer();
  const rows = employees
    .filter((employee) => inViewerScope(viewer, employee))
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
  const viewer = mockHrisViewer();
  if (viewer?.kind === "self" && viewer.employeeId !== params.employeeId)
    throw new ApiError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");
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
  const viewer = mockHrisViewer();
  assertCanViewEmployee(viewer, params.employeeId);
  const pii = hrisMockPiiStore.get()[params.employeeId];
  if (!pii) throw new ApiError(404, "NOT_FOUND", "Karyawan tidak ditemukan.");
  // HR-03: the stored values are already masked (ciphertext never leaves the
  // API); each field then follows the contract's visibility for this viewer,
  // so an owner, GM or supervisor gets null for NIK/NPWP/BPJS/bank/emergency
  // contact even though they hold hr.employee.view.
  // A viewer who may see none of these classes is refused outright (403),
  // decided on visibility, not on values: an HR read of an empty row is 200.
  const anyVisible = Object.values(EMPLOYEE_PII_CLASS).some(
    (piiClass) =>
      hrisPiiVisibility(viewer, params.employeeId, piiClass) !== "hidden",
  );
  if (!anyVisible)
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Peran Anda tidak boleh melihat data pribadi karyawan ini.",
    );
  return { data: redactEmployeePii(viewer, params.employeeId, pii) };
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
  const viewer = mockHrisViewer();
  const rows = cafeLegendHrisFixtures.contracts
    // HR-01: an employee reads their own contracts only.
    .filter(
      (contract) =>
        viewer?.kind !== "self" || contract.employeeId === viewer.employeeId,
    )
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
    )
    .map((contract) => redactContract(viewer, contract));
  return paginateFixture(rows, query, (contract) => contract.id, scenario);
});

registerMock(getEmploymentContract, ({ params }) => {
  const contract = cafeLegendHrisFixtures.contracts.find(
    (row) => row.id === params.contractId,
  );
  const viewer = mockHrisViewer();
  if (
    !contract ||
    (viewer?.kind === "self" && contract.employeeId !== viewer.employeeId)
  )
    throw new ApiError(404, "NOT_FOUND", "Kontrak tidak ditemukan.");
  return { data: redactContract(viewer, contract) };
});

registerMock(listEmployeeDocuments, ({ params, query, scenario }) => {
  const viewer = mockHrisViewer();
  assertCanViewEmployee(viewer, params.employeeId);
  const rows = cafeLegendHrisFixtures.documents
    .filter((document) => document.employeeId === params.employeeId)
    .map((document) => redactDocument(viewer, document));
  return paginateFixture(rows, query, (document) => document.id, scenario);
});

registerMock(listShiftAssignments, ({ query, scenario }) => {
  // HR-01 self-scope: naming another employee answers nothing, never that
  // employee's rows. The outlet-wide read (no employeeId) is the roster screen,
  // which the API guards with `hr.schedule.manage`.
  const requestedShiftEmployee = query.employeeId;
  const rows = cafeLegendHrisFixtures.shiftAssignments
    .filter(
      (assignment) =>
        requestedShiftEmployee === undefined ||
        (requestedShiftEmployee === MOCK_ME.id &&
          assignment.employeeId === MOCK_ME.id),
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
  // HR-01 self-scope, like the API: naming another employee answers nothing,
  // never that employee's rows. The outlet-wide call (no employeeId) is the
  // supervisor review.
  const requestedLogEmployee = query.employeeId;
  const rows = hrisMockLogs()
    .filter(
      (log) =>
        requestedLogEmployee === undefined ||
        (requestedLogEmployee === MOCK_ME.id && log.employeeId === MOCK_ME.id),
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
