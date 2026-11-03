// Mock handlers for the employee PWA (`VITE_API_MOCK=true`), so the Beranda,
// the attendance clock and the correction flow work with no API (docs/frontend
// .md "Typed endpoints and mock mode").
//
// The safety decisions are not re-implemented here: clock submissions run
// through the contract's own `evaluateAttendanceSubmission` with the fixture
// `AttendancePolicy`, exactly like the API will. HR-02 is therefore visible in
// the mock: an untrusted device or a location outside the fence is flagged or
// rejected according to the tenant policy, and a missing selfie is always a
// rejection.
//
// The mock has no private bucket, so a stored log carries a tiny placeholder
// photo URL instead of a signed selfie link; the screen shows an attachment
// badge, never the fixture URL.
import {
  attendanceCorrectionSchema,
  attendanceLogSchema,
  cafeLegendHrisFixtures,
  clockAttendance,
  evaluateAttendanceSubmission,
  getMyHrisProfile,
  isAnnouncementVisibleTo,
  listAnnouncements,
  listAttendanceCorrections,
  listAttendanceLogs,
  listPositions,
  listShiftAssignments,
  requestAttendanceCorrection,
  type Announcement,
  type AttendanceCorrection,
  type AttendanceLog,
} from "@starter/shared/hris";
import { localDateOf, createUlid } from "@starter/shared/core";
import { ApiError } from "../../lib/api/errors.ts";
import { paginateFixture } from "../../lib/mock/paginate.ts";
import { registerMock } from "../../lib/mock/registry.ts";
import { createMockStore } from "../../lib/mock/store.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const { tenant, outlets, employees, attendancePolicy, shiftAssignments } =
  cafeLegendHrisFixtures;
const outlet = outlets[0];

/**
 * The mock's signed-in employee (HR-01): CL-1003, the fixture row that has
 * published shifts and a full day of attendance logs to render.
 */
const me =
  employees.find((employee) => employee.employeeNo === "CL-1003") ??
  employees[0];

/**
 * Outlet point for the geofence. The HRIS fixtures carry distances, not
 * coordinates (the outlet record owns them in the API), so the mock pins the
 * Bandung outlet at its city-centre coordinate. Screenshots and the Playwright
 * spec use the same point.
 */
export const MOCK_OUTLET_POINT = {
  latitude: -6.9175,
  longitude: 107.6191,
} as const;

/** F25: the outlet screen rotates its QR every 30 seconds. */
const QR_ROTATION_MS = 30_000;
const QR_TOKEN_PREFIX = "QR-BDG01-OUTLET-";

/** The token the outlet screen would show right now (also the scan target). */
export function qrTokenAt(nowMs: number = Date.now()): string {
  const slot = Math.floor(nowMs / QR_ROTATION_MS)
    .toString(36)
    .toUpperCase()
    .padStart(6, "0");
  return `${QR_TOKEN_PREFIX}${slot}`;
}

/** True only inside the current 30-second window (contract `isAttendanceQrValid`). */
function qrTokenIsCurrent(token: string | null, nowMs: number): boolean {
  return token !== null && token === qrTokenAt(nowMs);
}

/** Haversine distance in metres, rounded like the API stores it. */
export function distanceMetres(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const radius = 6_371_000;
  const radians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = radians(to.latitude - from.latitude);
  const deltaLon = radians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(radians(from.latitude)) *
      Math.cos(radians(to.latitude)) *
      Math.sin(deltaLon / 2) ** 2;
  return Math.round(2 * radius * Math.asin(Math.sqrt(a)));
}

/** 1×1 transparent GIF: a stored selfie has a link, never a viewable preview here. */
const MOCK_PHOTO_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

type Replay = { fingerprint: string; id: string };

function idempotencyConflict(): ApiError {
  return new ApiError(
    409,
    "IDEMPOTENCY_KEY_REUSED",
    "Kunci idempotensi sudah dipakai dengan isi yang berbeda.",
  );
}

/** The request minus its key: what a replay must repeat exactly. */
function fingerprintOf(body: { idempotencyKey: string }): string {
  const { idempotencyKey, ...rest } = body;
  void idempotencyKey;
  return JSON.stringify(rest);
}

type MockState = {
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

function seed(): MockState {
  return {
    logs: [...cafeLegendHrisFixtures.attendanceLogs],
    corrections: [...cafeLegendHrisFixtures.attendanceCorrections],
    correctionReplays: {},
    clockReplays: {},
    // Fixture logs record their own device hashes; they are bound devices.
    boundDevices: [
      ...new Set(
        cafeLegendHrisFixtures.attendanceLogs
          .filter((log) => log.employeeId === me.id)
          .map((log) => log.deviceIdHash)
          .filter((hash): hash is string => hash !== null),
      ),
    ],
  };
}

const store = createMockStore<MockState>(seed);

function myLogs(): AttendanceLog[] {
  return store
    .get()
    .logs.filter((log) => log.employeeId === me.id)
    .sort(
      (left, right) =>
        Date.parse(right.occurredAt) - Date.parse(left.occurredAt),
    );
}

function myCorrections(): AttendanceCorrection[] {
  return store
    .get()
    .corrections.filter((row) => row.employeeId === me.id)
    .sort(
      (left, right) =>
        Date.parse(right.requestedAt) - Date.parse(left.requestedAt),
    );
}

/**
 * Mock-only controls for demos and the Playwright spec (the whole mock runtime
 * is compiled out of production builds): binding a device the way a supervisor
 * would, and reading the outlet's current rotating QR for the scan fallback.
 */
export const hrisAttendanceMockControl = {
  bindDevice(deviceIdHash: string) {
    const state = store.get();
    if (state.boundDevices.includes(deviceIdHash)) return;
    store.set({
      ...state,
      boundDevices: [...state.boundDevices, deviceIdHash],
    });
  },
  currentQrToken() {
    return qrTokenAt();
  },
};

type HrisMockWindow = { __legendHrisMock?: typeof hrisAttendanceMockControl };

if (typeof window !== "undefined")
  (window as unknown as HrisMockWindow).__legendHrisMock =
    hrisAttendanceMockControl;

registerMock(getMyHrisProfile, ({ scenario }) => {
  // The profile is required to render anything; `?mock=empty` empties the
  // lists around it, not the signed-in employee.
  void scenario;
  return { data: { employee: me, outlet } };
});

registerMock(listShiftAssignments, ({ query, scenario }) => {
  const rows = shiftAssignments
    .filter((assignment) => assignment.employeeId === me.id)
    .filter(
      (assignment) =>
        query.from === undefined || assignment.businessDate >= query.from,
    )
    .filter(
      (assignment) =>
        query.to === undefined || assignment.businessDate <= query.to,
    )
    .sort((left, right) => left.businessDate.localeCompare(right.businessDate));
  return paginateFixture(rows, query, (assignment) => assignment.id, scenario);
});

registerMock(listPositions, ({ query }) => {
  const rows = cafeLegendHrisFixtures.positions.filter(
    (position) =>
      query.orgUnitId === undefined || position.orgUnitId === query.orgUnitId,
  );
  // Reference data for a label, not a list the employee screens: keep it
  // when `?mock=empty` empties the day's logs and roster.
  return paginateFixture(rows, query, (position) => position.id);
});

registerMock(listAttendanceLogs, ({ query, scenario }) => {
  const rows = myLogs()
    .filter(
      (log) =>
        query.employeeId === undefined || log.employeeId === query.employeeId,
    )
    .filter(
      (log) =>
        query.businessDate === undefined ||
        localDateOf(log.occurredAt, outlet.timeZone) === query.businessDate,
    );
  return paginateFixture(rows, query, (log) => log.id, scenario);
});

registerMock(listAttendanceCorrections, ({ query, scenario }) => {
  const rows = myCorrections()
    .filter(
      (row) =>
        query.employeeId === undefined || row.employeeId === query.employeeId,
    )
    .filter((row) => query.status === undefined || row.status === query.status);
  return paginateFixture(rows, query, (row) => row.id, scenario);
});

registerMock(listAnnouncements, ({ query, scenario }) => {
  const rows: Announcement[] = cafeLegendHrisFixtures.announcements
    .filter((announcement) =>
      isAnnouncementVisibleTo(announcement, {
        employeeId: me.id,
        outletId: outlet.id,
      }),
    )
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

registerMock(clockAttendance, ({ body }) => {
  const state = store.get();
  const fingerprint = fingerprintOf(body);
  const replay = state.clockReplays[body.idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
    const original = state.logs.find((row) => row.id === replay.id);
    if (original) return { data: original };
  }
  const now = new Date();
  const distanceM =
    body.location === null
      ? null
      : distanceMetres(MOCK_OUTLET_POINT, body.location);
  const deviceBound =
    body.deviceIdHash !== null &&
    state.boundDevices.includes(body.deviceIdHash);
  const decision = evaluateAttendanceSubmission({
    policy: attendancePolicy,
    method: body.method,
    geoDistanceM: body.method === "selfie_geo" ? distanceM : null,
    deviceBound,
    selfieProvided: body.photoUploadRef !== null,
    qrValid:
      body.method === "rotating_qr"
        ? qrTokenIsCurrent(body.qrToken, now.getTime())
        : undefined,
  });
  // The API records the log with the decision's validity so the employee and
  // the supervisor review screen can see a flagged or rejected submission
  // (HR-02). Only the decision is authoritative; nothing is trusted from the
  // client beyond the raw capture.
  const log = attendanceLogSchema.parse({
    id: createUlid(now.getTime()),
    tenantId: tenant.id,
    employeeId: me.id,
    outletId: outlet.id,
    type: body.type,
    method: body.method,
    occurredAt: now.toISOString(),
    geoDistanceM: body.method === "selfie_geo" ? distanceM : null,
    deviceIdHash: body.deviceIdHash,
    photoUrl: body.photoUploadRef === null ? null : MOCK_PHOTO_URL,
    validity: decision.validity,
    shiftAssignmentId:
      shiftAssignments.find(
        (assignment) =>
          assignment.employeeId === me.id &&
          assignment.status === "published" &&
          assignment.businessDate === localDateOf(now, outlet.timeZone),
      )?.id ?? null,
  });
  store.set({
    ...state,
    logs: [...state.logs, log],
    clockReplays: {
      ...state.clockReplays,
      [body.idempotencyKey]: { fingerprint, id: log.id },
    },
  });
  return { data: log };
});

registerMock(requestAttendanceCorrection, ({ body }) => {
  const state = store.get();
  const fingerprint = fingerprintOf(body);
  const replay = state.correctionReplays[body.idempotencyKey];
  if (replay) {
    if (replay.fingerprint !== fingerprint) throw idempotencyConflict();
    const replayed = state.corrections.find((row) => row.id === replay.id);
    if (replayed) return { data: replayed };
  }
  if (!outlets.some((candidate) => candidate.id === body.outletId))
    throw new ApiError(404, "NOT_FOUND", "Outlet tidak ditemukan.");
  if (body.attendanceLogId !== null) {
    const log = state.logs.find(
      (candidate) =>
        candidate.id === body.attendanceLogId && candidate.employeeId === me.id,
    );
    if (!log)
      throw new ApiError(
        404,
        "NOT_FOUND",
        "Catatan absensi tidak ditemukan untuk karyawan ini.",
      );
  }
  const correction = attendanceCorrectionSchema.parse({
    id: newIdempotencyKey(),
    tenantId: tenant.id,
    outletId: body.outletId,
    employeeId: me.id,
    attendanceLogId: body.attendanceLogId,
    requestedType: body.requestedType,
    requestedOccurredAt: body.requestedOccurredAt,
    reason: body.reason.trim(),
    status: "pending",
    requestedAt: new Date().toISOString(),
    decidedBy: null,
    decidedAt: null,
  });
  store.set({
    ...state,
    corrections: [...state.corrections, correction],
    correctionReplays: {
      ...state.correctionReplays,
      [body.idempotencyKey]: { fingerprint, id: correction.id },
    },
  });
  return { data: correction };
});
