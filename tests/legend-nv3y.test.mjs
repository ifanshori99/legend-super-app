// WS-10 employee PWA: attendance clock and correction requests (bead
// legend-nv3y; PRD v1.7 §3 Kelompok D 33 "HRIS Self-Service Karyawan", F25,
// §4 Alur L, HR-02). Runs with the root node:test suite, no database.
//
// It loads the shared HRIS contract, the web app's mock runtime and the
// feature's own helpers with Node type stripping. The screens are exercised in
// e2e/legend-nv3y.mock.spec.ts; this file proves the decisions the screens
// render and the HR-02 policy paths the fixture tenant configures.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import * as hris from "../packages/shared/src/hris/index.ts";
import { createUlid } from "../packages/shared/src/core/index.ts";
import { isMessageKey } from "../packages/shared/src/i18n/index.ts";
import { resetMocks, dispatchMock } from "../apps/web/src/lib/mock/runtime.ts";
import {
  MOCK_OUTLET_POINT,
  distanceMetres,
  hrisAttendanceMockControl,
  qrTokenAt,
} from "../apps/web/src/features/ws10-hris-employee/mock.ts";
import {
  businessDateIn,
  correctionStatusKey,
  dayStatus,
  formatBusinessDate,
  formatShiftRange,
  formatTime,
  groupLogsByDate,
  methodLabelKey,
  possibleCauses,
  primaryClockType,
  reasonFixKey,
  reasonLabelKey,
  secondaryClockType,
  shiftForDate,
  submissionHeadlineKey,
  typeLabelKey,
  validityLabelKey,
  validityStatus,
} from "../apps/web/src/features/ws10-hris-employee/state.ts";
import {
  CORRECTION_QUEUE_KEY,
  enqueueCorrection,
  readCorrectionQueue,
  removeQueuedCorrection,
} from "../apps/web/src/features/ws10-hris-employee/queue.ts";

const fixtures = hris.cafeLegendHrisFixtures;
const outlet = fixtures.outlets[0];
const timeZone = outlet.timeZone;
const BOUND_DEVICE = "b".repeat(64);

afterEach(resetMocks);

async function get(path, query = {}) {
  return dispatchMock({ method: "GET", path, query });
}

async function post(path, body) {
  return dispatchMock({ method: "POST", path, body });
}

function clockBody(overrides = {}) {
  return {
    type: "in",
    method: "selfie_geo",
    occurredAt: new Date().toISOString(),
    location: { ...MOCK_OUTLET_POINT, accuracyM: 8 },
    deviceIdHash: BOUND_DEVICE,
    photoUploadRef: "mock-selfie/test-frame",
    qrToken: null,
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

/** Fresh ids for the first four fixture logs (CL-1003's day). */
function myFixtureLogs() {
  return fixtures.attendanceLogs
    .slice(0, 4)
    .map((log) =>
      hris.attendanceLogSchema.parse({ ...log, id: createUlid(Date.now()) }),
    );
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, String(value));
    },
  };
}

test("HR-02 a submitted selfie + GPS inside the fence from a bound device is valid", async () => {
  hrisAttendanceMockControl.bindDevice(BOUND_DEVICE);
  const response = await post("/api/hris/attendance/clock", clockBody());
  assert.equal(response.data.validity, "valid");
  assert.equal(response.data.method, "selfie_geo");
  assert.equal(
    response.data.employeeId,
    fixtures.employees.find((employee) => employee.employeeNo === "CL-1003").id,
  );
  assert.ok(response.data.geoDistanceM <= 5);
  assert.equal(response.data.deviceIdHash, BOUND_DEVICE);
});

test("HR-02 an unbound device outside the geofence is flagged, never silently accepted", async () => {
  // ~13 km west of the outlet: outside the fixture policy's 150 m fence.
  const response = await post(
    "/api/hris/attendance/clock",
    clockBody({
      location: { latitude: -6.9175, longitude: 107.44, accuracyM: 12 },
      deviceIdHash: "c".repeat(64),
    }),
  );
  assert.equal(response.data.validity, "flagged");
  assert.ok(response.data.geoDistanceM > 150);

  // The screen tells the employee what a flag means and what to fix, without
  // inventing a decision the API did not make.
  const causes = possibleCauses("flagged", {
    method: "selfie_geo",
    selfie: true,
  });
  assert.deepEqual(causes, ["outside_geofence", "device_not_bound"]);
});

test("HR-02 a missing selfie is always a rejection, and a rejected log is not presence", async () => {
  const response = await post(
    "/api/hris/attendance/clock",
    clockBody({ photoUploadRef: null }),
  );
  assert.equal(response.data.validity, "rejected");
  assert.equal(response.data.photoUrl, null);
  assert.equal(dayStatus([response.data]), "not_started");
  assert.equal(primaryClockType(dayStatus([response.data])), "in");
});

test("HR-02 the rotating outlet QR is accepted only inside its 30-second window", async () => {
  hrisAttendanceMockControl.bindDevice(BOUND_DEVICE);
  const fresh = await post(
    "/api/hris/attendance/clock",
    clockBody({
      method: "rotating_qr",
      location: null,
      qrToken: qrTokenAt(),
      occurredAt: new Date().toISOString(),
    }),
  );
  assert.equal(fresh.data.validity, "valid");
  assert.equal(fresh.data.geoDistanceM, null);

  const stale = await post(
    "/api/hris/attendance/clock",
    clockBody({
      method: "rotating_qr",
      location: null,
      qrToken: qrTokenAt(Date.now() - 60_000),
    }),
  );
  assert.equal(stale.data.validity, "rejected");
  assert.equal(dayStatus([stale.data]), "not_started");

  // A QR clock-in can only be *flagged* for the device binding; a stale code
  // is a rejection, so it is not offered as a possible flag cause.
  assert.deepEqual(
    possibleCauses("flagged", { method: "rotating_qr", selfie: true }),
    ["device_not_bound"],
  );
});

test("HR-02 every cause and status has catalog text with a fix hint", () => {
  for (const reason of hris.attendanceFlagReasonSchema.options) {
    assert.ok(isMessageKey(reasonLabelKey(reason)), reason);
    assert.ok(isMessageKey(reasonFixKey(reason)), reason);
  }
  for (const validity of hris.attendanceValiditySchema.options) {
    assert.ok(isMessageKey(validityLabelKey(validity)), validity);
    assert.ok(isMessageKey(submissionHeadlineKey(validity)), validity);
    assert.ok(
      ["success", "warning", "danger"].includes(validityStatus(validity)),
    );
  }
  for (const type of hris.attendanceTypeSchema.options)
    assert.ok(isMessageKey(typeLabelKey(type)), type);
  for (const method of hris.attendanceMethodSchema.options)
    assert.ok(isMessageKey(methodLabelKey(method)), method);
  for (const status of hris.attendanceCorrectionStatusSchema.options)
    assert.ok(isMessageKey(correctionStatusKey(status)), status);
});

test("Alur L the next clock action follows today's own log stream", () => {
  const logs = fixtures.attendanceLogs.filter(
    (log) =>
      log.occurredAt.startsWith("2026-10-26T") &&
      log.employeeId === fixtures.attendanceLogs[0].employeeId,
  );
  assert.equal(logs.length, 4);

  assert.equal(dayStatus([]), "not_started");
  assert.equal(primaryClockType("not_started"), "in");
  assert.equal(secondaryClockType("not_started"), null);

  assert.equal(dayStatus(logs.slice(0, 1)), "working");
  assert.equal(primaryClockType("working"), "out");
  assert.equal(secondaryClockType("working"), "break_start");

  assert.equal(dayStatus(logs.slice(0, 2)), "on_break");
  assert.equal(primaryClockType("on_break"), "break_end");
  assert.equal(secondaryClockType("on_break"), null);

  assert.equal(dayStatus(logs.slice(0, 3)), "working");
  assert.equal(dayStatus(logs), "finished");
  // A second shift on the same business date starts with clock-in again.
  assert.equal(primaryClockType("finished"), "in");
});

test("Alur L a flagged log still counts as presence (review, not rejection)", () => {
  const flagged = fixtures.attendanceLogs.find(
    (log) => log.validity === "flagged",
  );
  assert.ok(flagged);
  assert.equal(dayStatus([flagged]), "working");
});

test("Alur L logs group by the outlet's business date, newest day first", () => {
  const base = myFixtureLogs()[0];
  const lateNight = hris.attendanceLogSchema.parse({
    ...base,
    id: createUlid(Date.now()),
    occurredAt: "2026-11-01T16:59:00.000Z", // 23:59 WIB, still 1 Nov
  });
  const afterMidnight = hris.attendanceLogSchema.parse({
    ...base,
    id: createUlid(Date.now() + 1),
    occurredAt: "2026-11-01T17:01:00.000Z", // 00:01 WIB, 2 Nov
  });
  const groups = groupLogsByDate([lateNight, afterMidnight], timeZone);
  assert.deepEqual(
    groups.map((group) => group.businessDate),
    ["2026-11-02", "2026-11-01"],
  );
  assert.equal(formatBusinessDate("2026-11-01", timeZone), "Min, 1 Nov 2026");
  assert.equal(
    businessDateIn(timeZone, new Date("2026-11-01T17:01:00.000Z")),
    "2026-11-02",
  );
});

test("Alur L the Beranda reads today's shift in the outlet's time zone", () => {
  const businessDate = "2026-11-01";
  const shift = shiftForDate(fixtures.shiftAssignments, businessDate);
  assert.ok(shift, "the fixture roster publishes a shift on the fixture date");
  assert.equal(formatShiftRange(shift, timeZone), "08.00–16.00");
  assert.equal(formatTime(shift.segments[0].startsAt, timeZone), "08.00");
  // A draft assignment is not a shift the employee can see.
  const drafts = fixtures.shiftAssignments.filter(
    (assignment) => assignment.status === "draft",
  );
  assert.ok(drafts.length > 0);
  assert.equal(shiftForDate(drafts, "2026-10-26"), null);
});

test("HR-02 correction requests are idempotent and land in the pending list", async () => {
  const body = {
    outletId: outlet.id,
    attendanceLogId: null,
    requestedType: "out",
    requestedOccurredAt: "2026-10-31T09:10:00.000Z",
    reason: "Lupa absen pulang setelah shift malam.",
    idempotencyKey: randomUUID(),
  };
  const first = await post("/api/hris/attendance/corrections", body);
  const replay = await post("/api/hris/attendance/corrections", body);
  assert.equal(first.data.id, replay.data.id);
  assert.equal(first.data.status, "pending");
  assert.equal(first.data.attendanceLogId, null);

  const list = await get("/api/hris/attendance/corrections", {
    limit: 10,
    status: "pending",
  });
  const mine = list.data.filter((row) => row.id === first.data.id);
  assert.equal(mine.length, 1);
});

test("the offline correction queue keeps one entry per attempt and replays it", () => {
  const storage = memoryStorage();
  const body = {
    outletId: outlet.id,
    attendanceLogId: null,
    requestedType: "in",
    requestedOccurredAt: "2026-10-31T00:55:00.000Z",
    reason: "Ponsel kehabisan baterai.",
    idempotencyKey: randomUUID(),
  };
  enqueueCorrection(body, storage);
  enqueueCorrection(body, storage);
  const queued = readCorrectionQueue(storage);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].key, body.idempotencyKey);

  enqueueCorrection({ ...body, idempotencyKey: randomUUID() }, storage);
  assert.equal(readCorrectionQueue(storage).length, 2);

  removeQueuedCorrection(queued[0].key, storage);
  const rest = readCorrectionQueue(storage);
  assert.equal(rest.length, 1);
  assert.notEqual(rest[0].key, queued[0].key);
  assert.equal(
    storage.getItem(CORRECTION_QUEUE_KEY).includes(rest[0].key),
    true,
  );
});

test("the mock outlet point and distance match the fixture tenant's 150 m fence", () => {
  // Directly on the point; ~1.1 km north (0.01° latitude).
  assert.equal(distanceMetres(MOCK_OUTLET_POINT, MOCK_OUTLET_POINT), 0);
  const north = {
    latitude: MOCK_OUTLET_POINT.latitude + 0.01,
    longitude: MOCK_OUTLET_POINT.longitude,
  };
  const distance = distanceMetres(MOCK_OUTLET_POINT, north);
  assert.ok(distance > 1_000 && distance < 1_200, `got ${distance}`);
  assert.ok(
    hris.cafeLegendHrisFixtures.attendancePolicy.geofenceRadiusM <= distance,
  );
});
