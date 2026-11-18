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
import {
  createTranslator,
  isMessageKey,
} from "../packages/shared/src/i18n/index.ts";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
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
  fromDateTimeLocalValue,
  groupLogsByDate,
  methodLabelKey,
  possibleCauses,
  primaryClockType,
  reasonFixKey,
  reasonLabelKey,
  sameClockCapture,
  secondaryClockType,
  shiftForDate,
  submissionHeadlineKey,
  toDateTimeLocalValue,
  typeLabelKey,
  validityLabelKey,
  validityStatus,
} from "../apps/web/src/features/ws10-hris-employee/state.ts";
import {
  CORRECTION_QUEUE_KEY,
  clearCorrectionRefusal,
  enqueueCorrection,
  isRefused,
  isRetryableReplayError,
  markCorrectionRefused,
  queuedFor,
  readCorrectionQueue,
  removeQueuedCorrection,
  replaceQueuedCorrection,
  replayCorrectionQueue,
  replayQueuedCorrection,
} from "../apps/web/src/features/ws10-hris-employee/queue.ts";

const fixtures = hris.cafeLegendHrisFixtures;
const outlet = fixtures.outlets[0];
const timeZone = outlet.timeZone;
const BOUND_DEVICE = "b".repeat(64);
const ME_ID = fixtures.employees.find(
  (employee) => employee.employeeNo === "CL-1003",
).id;

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
  enqueueCorrection(body, ME_ID, storage);
  enqueueCorrection(body, ME_ID, storage);
  const queued = readCorrectionQueue(storage);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].key, body.idempotencyKey);

  enqueueCorrection({ ...body, idempotencyKey: randomUUID() }, ME_ID, storage);
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

test("HR-01 /api/hris/me takes no employee id and answers only the session employee", async () => {
  // Nothing in the contract lets the client name an employee or a tenant.
  assert.equal(hris.getMyHrisProfile.params, undefined);
  assert.equal(hris.getMyHrisProfile.query, undefined);
  assert.equal(hris.getMyHrisProfile.body, undefined);
  const me = await get("/api/hris/me");
  assert.equal(me.data.employee.id, ME_ID);
  assert.equal(me.data.outlet.timeZone, "Asia/Jakarta");
});

test("HR-01 another employee's logs and log ids stay out of reach", async () => {
  const other = fixtures.attendanceLogs.find((log) => log.employeeId !== ME_ID);
  assert.ok(other, "the fixtures carry another employee's log");

  // Even when the client asks for someone else, the list stays self-scoped.
  const asked = await get("/api/hris/attendance/logs", {
    limit: 50,
    employeeId: other.employeeId,
  });
  assert.equal(asked.data.length, 0);
  const own = await get("/api/hris/attendance/logs", {
    limit: 50,
    employeeId: ME_ID,
  });
  assert.ok(own.data.length > 0);
  assert.ok(own.data.every((log) => log.employeeId === ME_ID));

  // A correction cannot target another employee's log.
  await assert.rejects(
    post("/api/hris/attendance/corrections", {
      outletId: outlet.id,
      attendanceLogId: other.id,
      requestedType: "in",
      requestedOccurredAt: "2026-10-31T01:00:00.000Z",
      reason: "Coba koreksi milik orang lain.",
      idempotencyKey: randomUUID(),
    }),
    (error) => error.status === 404,
  );
});

test("HR-01 the offline queue replays only the filer's own entries", () => {
  const storage = memoryStorage();
  const body = (key) => ({
    outletId: outlet.id,
    attendanceLogId: null,
    requestedType: "out",
    requestedOccurredAt: "2026-10-31T09:00:00.000Z",
    reason: "Lupa absen pulang.",
    idempotencyKey: key,
  });
  const otherId = fixtures.employees.find(
    (employee) => employee.id !== ME_ID,
  ).id;
  enqueueCorrection(body(randomUUID()), ME_ID, storage);
  enqueueCorrection(body(randomUUID()), otherId, storage);
  const queue = readCorrectionQueue(storage);
  assert.equal(queue.length, 2);
  assert.equal(queuedFor(queue, ME_ID).length, 1);
  assert.equal(queuedFor(queue, ME_ID)[0].employeeId, ME_ID);
  assert.deepEqual(queuedFor(queue, null), []);

  // A final 4xx leaves the queue; a lost connection or a 5xx is retried.
  assert.equal(isRetryableReplayError(undefined), true);
  assert.equal(isRetryableReplayError(0), true);
  assert.equal(isRetryableReplayError(503), true);
  assert.equal(isRetryableReplayError(429), true);
  assert.equal(isRetryableReplayError(400), false);
  assert.equal(isRetryableReplayError(404), false);
  assert.equal(isRetryableReplayError(409), false);
});

test("a clock replay with the same key answers the first log; a changed body is refused", async () => {
  hrisAttendanceMockControl.bindDevice(BOUND_DEVICE);
  const body = clockBody();
  const first = await post("/api/hris/attendance/clock", body);
  const replay = await post("/api/hris/attendance/clock", { ...body });
  assert.equal(replay.data.id, first.data.id);
  const day = await get("/api/hris/attendance/logs", { limit: 50 });
  assert.equal(day.data.filter((log) => log.id === first.data.id).length, 1);

  await assert.rejects(
    post("/api/hris/attendance/clock", {
      ...body,
      occurredAt: new Date(Date.now() + 5_000).toISOString(),
    }),
    (error) => error.status === 409 && error.code === "IDEMPOTENCY_KEY_REUSED",
  );

  // The screen reuses a frozen request only while the capture is unchanged.
  const selfie = {};
  const capture = {
    type: "in",
    method: "selfie_geo",
    selfie,
    qrToken: null,
    location: { ...MOCK_OUTLET_POINT, accuracyM: 8 },
    deviceIdHash: BOUND_DEVICE,
  };
  assert.equal(
    sameClockCapture(capture, {
      ...capture,
      location: { ...capture.location },
    }),
    true,
  );
  assert.equal(sameClockCapture(capture, { ...capture, selfie: {} }), false);
  assert.equal(
    sameClockCapture(capture, {
      ...capture,
      location: { ...capture.location, accuracyM: 30 },
    }),
    false,
  );
});

test("a correction key reused with a different body is refused", async () => {
  const body = {
    outletId: outlet.id,
    attendanceLogId: null,
    requestedType: "out",
    requestedOccurredAt: "2026-10-31T09:10:00.000Z",
    reason: "Lupa absen pulang.",
    idempotencyKey: randomUUID(),
  };
  await post("/api/hris/attendance/corrections", body);
  await assert.rejects(
    post("/api/hris/attendance/corrections", { ...body, reason: "Lain." }),
    (error) => error.status === 409,
  );
});

test("the correction form edits the outlet's wall clock, not the phone's", () => {
  const instant = new Date("2026-11-01T01:05:00.000Z");
  assert.equal(
    toDateTimeLocalValue(instant, "Asia/Jakarta"),
    "2026-11-01T08:05",
  );
  assert.equal(
    toDateTimeLocalValue(instant, "Asia/Makassar"),
    "2026-11-01T09:05",
  );
  assert.equal(
    fromDateTimeLocalValue("2026-11-01T08:05", "Asia/Jakarta"),
    "2026-11-01T01:05:00.000Z",
  );
  assert.equal(
    fromDateTimeLocalValue("2026-11-01T09:05", "Asia/Makassar"),
    "2026-11-01T01:05:00.000Z",
  );
  // Just after midnight WIB is still the previous UTC day.
  assert.equal(
    fromDateTimeLocalValue("2026-11-02T00:30", "Asia/Jakarta"),
    "2026-11-01T17:30:00.000Z",
  );
  assert.equal(fromDateTimeLocalValue("", "Asia/Jakarta"), null);
});

// ---- legend-nvc7: a refused offline correction stays visible ---------------
// Decision (review C11): a 4xx-final answer keeps the entry in the queue, marked
// refused with the server's reason, and the employee picks Coba lagi / Ubah /
// Buang. No migration, no API change.

const T = createTranslator();
const REFUSED_AT = new Date("2026-11-01T03:00:00.000Z");

function queuedBody(key = randomUUID(), overrides = {}) {
  return {
    outletId: outlet.id,
    attendanceLogId: null,
    requestedType: "out",
    requestedOccurredAt: "2026-10-31T09:10:00.000Z",
    reason: "Lupa absen pulang setelah shift malam.",
    idempotencyKey: key,
    ...overrides,
  };
}

/** A submit double that answers per call from a script and records bodies. */
function scriptedSubmit(...answers) {
  const calls = [];
  const submit = async (body) => {
    calls.push(body);
    const answer = answers[calls.length - 1] ?? "ok";
    if (answer === "ok") return { data: { id: "server-row" } };
    if (typeof answer === "number")
      throw new ApiError(answer, `HTTP_${answer}`, `Server ${answer}`);
    throw answer;
  };
  return { submit, calls };
}

test("nvc7 a 4xx-final replay keeps the entry, marked refused with the server's reason", async () => {
  const storage = memoryStorage();
  const body = queuedBody();
  enqueueCorrection(body, ME_ID, storage, new Date("2026-11-01T01:00:00.000Z"));
  const [row] = readCorrectionQueue(storage);
  assert.equal(isRefused(row), false);

  const submit = async () => {
    throw new ApiError(
      422,
      "VALIDATION_FAILED",
      "Waktu koreksi di luar periode.",
    );
  };
  const outcome = await replayQueuedCorrection(
    row,
    submit,
    storage,
    REFUSED_AT,
  );
  assert.equal(outcome, "refused");

  const queue = readCorrectionQueue(storage);
  assert.equal(queue.length, 1, "the entry must not be dropped");
  assert.equal(isRefused(queue[0]), true);
  assert.deepEqual(queue[0].refused, {
    status: 422,
    code: "VALIDATION_FAILED",
    reason: "Waktu koreksi di luar periode.",
    at: REFUSED_AT.toISOString(),
  });
  // The filer's data is untouched so Ubah can prefill and Coba lagi can resend.
  assert.equal(queue[0].key, body.idempotencyKey);
  assert.equal(queue[0].employeeId, ME_ID);
  assert.deepEqual(queue[0].body, body);
  assert.equal(queue[0].queuedAt, "2026-11-01T01:00:00.000Z");
});

test("nvc7 every final 4xx status is refused, never retried silently", async () => {
  for (const status of [400, 403, 404, 409, 422]) {
    const storage = memoryStorage();
    enqueueCorrection(queuedBody(), ME_ID, storage);
    const [row] = readCorrectionQueue(storage);
    const { submit, calls } = scriptedSubmit(status);
    const outcome = await replayQueuedCorrection(
      row,
      submit,
      storage,
      REFUSED_AT,
    );
    assert.equal(outcome, "refused", `status ${status}`);
    assert.equal(calls.length, 1);
    const [kept] = readCorrectionQueue(storage);
    assert.equal(kept.refused.status, status);
    assert.equal(kept.refused.code, `HTTP_${status}`);
    assert.equal(kept.refused.reason, `Server ${status}`);
  }
});

test("nvc7 a lost connection, timeout, 429 or 5xx leaves the entry waiting, unmarked", async () => {
  const failures = [
    new ApiError(0, "NETWORK", "Tidak ada koneksi."),
    new ApiError(408, "TIMEOUT", "Waktu habis."),
    new ApiError(429, "RATE_LIMITED", "Terlalu sering."),
    new ApiError(500, "INTERNAL", "Gangguan server."),
    new ApiError(503, "UNAVAILABLE", "Server sibuk."),
    // Not an ApiError: status is undefined, which counts as retryable.
    new TypeError("Failed to fetch"),
  ];
  for (const failure of failures) {
    const storage = memoryStorage();
    enqueueCorrection(queuedBody(), ME_ID, storage);
    const [row] = readCorrectionQueue(storage);
    const { submit } = scriptedSubmit(failure);
    const outcome = await replayQueuedCorrection(
      row,
      submit,
      storage,
      REFUSED_AT,
    );
    assert.equal(outcome, "retryLater", String(failure));
    const queue = readCorrectionQueue(storage);
    assert.equal(queue.length, 1);
    assert.equal(isRefused(queue[0]), false);
    assert.equal(queue[0].refused, undefined);
  }
});

test("nvc7 a successful replay sends the stored body and removes the entry", async () => {
  const storage = memoryStorage();
  const body = queuedBody();
  enqueueCorrection(body, ME_ID, storage);
  const [row] = readCorrectionQueue(storage);
  const { submit, calls } = scriptedSubmit("ok");
  assert.equal(
    await replayQueuedCorrection(row, submit, storage, REFUSED_AT),
    "sent",
  );
  assert.deepEqual(calls, [body]);
  assert.deepEqual(readCorrectionQueue(storage), []);
});

test("nvc7 replaying the queue: a refused entry never blocks the entries behind it", async () => {
  const storage = memoryStorage();
  const [a, b, c] = [queuedBody(), queuedBody(), queuedBody()];
  for (const body of [a, b, c]) enqueueCorrection(body, ME_ID, storage);
  const { submit, calls } = scriptedSubmit("ok", 422, "ok");

  const result = await replayCorrectionQueue(
    readCorrectionQueue(storage),
    submit,
    storage,
    REFUSED_AT,
  );
  assert.deepEqual(result, { sent: 2, refused: 1 });
  assert.equal(calls.length, 3);
  const rest = readCorrectionQueue(storage);
  assert.deepEqual(
    rest.map((row) => row.key),
    [b.idempotencyKey],
  );
  assert.equal(isRefused(rest[0]), true);
});

test("nvc7 replaying the queue skips entries that are already refused", async () => {
  const storage = memoryStorage();
  const refusedBody = queuedBody();
  const waitingBody = queuedBody();
  enqueueCorrection(refusedBody, ME_ID, storage);
  enqueueCorrection(waitingBody, ME_ID, storage);
  markCorrectionRefused(
    refusedBody.idempotencyKey,
    {
      status: 409,
      code: "CONFLICT",
      reason: "Sudah ada pengajuan.",
      at: REFUSED_AT.toISOString(),
    },
    storage,
  );
  const { submit, calls } = scriptedSubmit("ok");
  const result = await replayCorrectionQueue(
    readCorrectionQueue(storage),
    submit,
    storage,
    REFUSED_AT,
  );
  assert.deepEqual(result, { sent: 1, refused: 0 });
  assert.deepEqual(calls, [waitingBody], "the refused entry is not resent");
  const rest = readCorrectionQueue(storage);
  assert.equal(rest.length, 1);
  assert.equal(rest[0].key, refusedBody.idempotencyKey);
  assert.equal(rest[0].refused.reason, "Sudah ada pengajuan.");
});

test("nvc7 replaying the queue stops at the first retry-later entry, as the old loop did", async () => {
  const storage = memoryStorage();
  const bodies = [queuedBody(), queuedBody(), queuedBody()];
  for (const body of bodies) enqueueCorrection(body, ME_ID, storage);
  const { submit, calls } = scriptedSubmit("ok", 503, "ok");
  const result = await replayCorrectionQueue(
    readCorrectionQueue(storage),
    submit,
    storage,
    REFUSED_AT,
  );
  assert.deepEqual(result, { sent: 1, refused: 0 });
  assert.equal(calls.length, 2, "the third entry waits for the next flush");
  const rest = readCorrectionQueue(storage);
  assert.deepEqual(
    rest.map((row) => row.key),
    [bodies[1].idempotencyKey, bodies[2].idempotencyKey],
  );
  assert.ok(rest.every((row) => !isRefused(row)));
});

test("nvc7 Coba lagi clears the mark, then a success removes the entry", async () => {
  const storage = memoryStorage();
  const body = queuedBody();
  enqueueCorrection(body, ME_ID, storage);
  markCorrectionRefused(
    body.idempotencyKey,
    {
      status: 422,
      code: "VALIDATION_FAILED",
      reason: "Waktu salah.",
      at: REFUSED_AT.toISOString(),
    },
    storage,
  );

  const afterClear = clearCorrectionRefusal(body.idempotencyKey, storage);
  assert.equal(afterClear.length, 1);
  assert.equal(isRefused(afterClear[0]), false);
  assert.deepEqual(afterClear[0].body, body);
  assert.equal(isRefused(readCorrectionQueue(storage)[0]), false);

  const [row] = readCorrectionQueue(storage);
  const { submit } = scriptedSubmit("ok");
  assert.equal(
    await replayQueuedCorrection(row, submit, storage, REFUSED_AT),
    "sent",
  );
  assert.deepEqual(readCorrectionQueue(storage), []);
});

test("nvc7 Coba lagi refused again replaces the old reason with the new one", async () => {
  const storage = memoryStorage();
  const body = queuedBody();
  enqueueCorrection(body, ME_ID, storage);
  markCorrectionRefused(
    body.idempotencyKey,
    {
      status: 422,
      code: "OLD",
      reason: "Alasan lama.",
      at: "2026-11-01T01:00:00.000Z",
    },
    storage,
  );
  clearCorrectionRefusal(body.idempotencyKey, storage);
  const [row] = readCorrectionQueue(storage);
  const { submit } = scriptedSubmit(
    new ApiError(409, "CONFLICT", "Alasan baru."),
  );
  assert.equal(
    await replayQueuedCorrection(row, submit, storage, REFUSED_AT),
    "refused",
  );
  const [kept] = readCorrectionQueue(storage);
  assert.deepEqual(kept.refused, {
    status: 409,
    code: "CONFLICT",
    reason: "Alasan baru.",
    at: REFUSED_AT.toISOString(),
  });
});

test("nvc7 Coba lagi with no connection leaves the entry waiting, without a mark", async () => {
  const storage = memoryStorage();
  const body = queuedBody();
  enqueueCorrection(body, ME_ID, storage);
  markCorrectionRefused(
    body.idempotencyKey,
    { status: 422, code: "X", reason: "Lama.", at: REFUSED_AT.toISOString() },
    storage,
  );
  clearCorrectionRefusal(body.idempotencyKey, storage);
  const [row] = readCorrectionQueue(storage);
  const { submit } = scriptedSubmit(new ApiError(0, "NETWORK", "Offline."));
  assert.equal(
    await replayQueuedCorrection(row, submit, storage, REFUSED_AT),
    "retryLater",
  );
  const [kept] = readCorrectionQueue(storage);
  assert.equal(isRefused(kept), false);
});

test("nvc7 marking again overwrites the reason; an unknown key creates nothing", () => {
  const storage = memoryStorage();
  const body = queuedBody();
  enqueueCorrection(body, ME_ID, storage);
  markCorrectionRefused(
    body.idempotencyKey,
    { status: 400, code: "A", reason: "Satu.", at: "2026-11-01T01:00:00.000Z" },
    storage,
  );
  const queue = markCorrectionRefused(
    body.idempotencyKey,
    { status: 404, code: "B", reason: "Dua.", at: "2026-11-01T02:00:00.000Z" },
    storage,
  );
  assert.equal(queue.length, 1);
  assert.equal(queue[0].refused.reason, "Dua.");
  assert.equal(queue[0].refused.status, 404);

  const unknown = markCorrectionRefused(
    "no-such-key",
    {
      status: 400,
      code: "A",
      reason: "Tak ada.",
      at: REFUSED_AT.toISOString(),
    },
    storage,
  );
  assert.equal(unknown.length, 1);
  assert.equal(readCorrectionQueue(storage).length, 1);
});

test("nvc7 Buang removes a refused entry and only that entry", () => {
  const storage = memoryStorage();
  const refusedBody = queuedBody();
  const keptBody = queuedBody();
  enqueueCorrection(refusedBody, ME_ID, storage);
  enqueueCorrection(keptBody, ME_ID, storage);
  markCorrectionRefused(
    refusedBody.idempotencyKey,
    {
      status: 422,
      code: "X",
      reason: "Ditolak.",
      at: REFUSED_AT.toISOString(),
    },
    storage,
  );
  const rest = removeQueuedCorrection(refusedBody.idempotencyKey, storage);
  assert.deepEqual(
    rest.map((row) => row.key),
    [keptBody.idempotencyKey],
  );
  assert.deepEqual(
    readCorrectionQueue(storage).map((row) => row.key),
    [keptBody.idempotencyKey],
  );
});

test("nvc7 Ubah replaces the old entry with a new one under the new key", () => {
  const storage = memoryStorage();
  const oldBody = queuedBody();
  const otherBody = queuedBody();
  enqueueCorrection(oldBody, ME_ID, storage);
  enqueueCorrection(otherBody, ME_ID, storage);
  markCorrectionRefused(
    oldBody.idempotencyKey,
    {
      status: 422,
      code: "X",
      reason: "Ditolak.",
      at: REFUSED_AT.toISOString(),
    },
    storage,
  );

  const fixedBody = queuedBody(randomUUID(), {
    reason: "Lupa absen pulang, sudah diperbaiki.",
  });
  const now = new Date("2026-11-01T04:00:00.000Z");
  const queue = replaceQueuedCorrection(
    oldBody.idempotencyKey,
    fixedBody,
    ME_ID,
    storage,
    now,
  );
  assert.equal(queue.length, 2);
  assert.equal(
    queue.some((row) => row.key === oldBody.idempotencyKey),
    false,
    "the old attempt is gone",
  );
  const created = queue.find((row) => row.key === fixedBody.idempotencyKey);
  assert.ok(created);
  assert.equal(created.employeeId, ME_ID);
  assert.deepEqual(created.body, fixedBody);
  assert.equal(created.queuedAt, now.toISOString());
  assert.equal(
    isRefused(created),
    false,
    "the new attempt is a fresh waiting entry",
  );
  assert.ok(queue.some((row) => row.key === otherBody.idempotencyKey));
  assert.deepEqual(readCorrectionQueue(storage), queue);
});

test("nvc7 the queue rejects a corrupt refusal instead of showing garbage", () => {
  const storage = memoryStorage();
  const good = {
    key: randomUUID(),
    employeeId: ME_ID,
    body: queuedBody(),
    queuedAt: "2026-11-01T01:00:00.000Z",
    refused: {
      status: 422,
      code: "X",
      reason: "Ditolak.",
      at: "2026-11-01T02:00:00.000Z",
    },
  };
  const corrupt = [
    { ...good, key: randomUUID(), refused: "ditolak" },
    { ...good, key: randomUUID(), refused: { ...good.refused, status: "422" } },
    { ...good, key: randomUUID(), refused: { ...good.refused, code: 7 } },
    { ...good, key: randomUUID(), refused: { ...good.refused, reason: null } },
    { ...good, key: randomUUID(), refused: { ...good.refused, at: 12 } },
    { ...good, key: randomUUID(), refused: {} },
  ];
  storage.setItem(CORRECTION_QUEUE_KEY, JSON.stringify([good, ...corrupt]));
  const queue = readCorrectionQueue(storage);
  assert.deepEqual(
    queue.map((row) => row.key),
    [good.key],
  );
  assert.equal(isRefused(queue[0]), true);
  // A legacy entry without any refusal still reads, as waiting.
  const legacy = { ...good };
  delete legacy.refused;
  storage.setItem(CORRECTION_QUEUE_KEY, JSON.stringify([legacy]));
  const [old] = readCorrectionQueue(storage);
  assert.equal(isRefused(old), false);
});

test("nvc7 HR-01 refusing, retrying and replacing never touch another employee's entries", async () => {
  const storage = memoryStorage();
  const otherId = fixtures.employees.find(
    (employee) => employee.id !== ME_ID,
  ).id;
  const mine = queuedBody();
  const theirs = queuedBody();
  enqueueCorrection(mine, ME_ID, storage);
  enqueueCorrection(theirs, otherId, storage);

  // The hook replays only queuedFor(...): the other filer's entry is not sent.
  const { submit, calls } = scriptedSubmit(422);
  const result = await replayCorrectionQueue(
    queuedFor(readCorrectionQueue(storage), ME_ID),
    submit,
    storage,
    REFUSED_AT,
  );
  assert.deepEqual(result, { sent: 0, refused: 1 });
  assert.deepEqual(calls, [mine]);

  let queue = readCorrectionQueue(storage);
  const theirRow = queue.find((row) => row.key === theirs.idempotencyKey);
  assert.equal(theirRow.employeeId, otherId);
  assert.equal(isRefused(theirRow), false);

  // The refused entry is still the filer's; the other account does not see it.
  assert.equal(queuedFor(queue, ME_ID).length, 1);
  assert.equal(isRefused(queuedFor(queue, ME_ID)[0]), true);
  assert.equal(queuedFor(queue, otherId).length, 1);
  assert.equal(isRefused(queuedFor(queue, otherId)[0]), false);

  // Ubah by me leaves theirs as it was.
  const fixed = queuedBody();
  queue = replaceQueuedCorrection(mine.idempotencyKey, fixed, ME_ID, storage);
  assert.deepEqual(
    queue.find((row) => row.key === theirs.idempotencyKey),
    theirRow,
  );
  assert.equal(
    queue.find((row) => row.key === fixed.idempotencyKey).employeeId,
    ME_ID,
  );
});

test("nvc7 the catalog carries the refused-state texts and the new replay toast", () => {
  const keys = [
    "hris.correction.refused",
    "hris.correction.refusedReason",
    "hris.correction.refusedNoReason",
    "hris.correction.retry",
    "hris.correction.edit",
    "hris.correction.discard",
    "hris.correction.editTitle",
    "hris.correction.editHint",
    "hris.correction.replayDropped",
    "hris.correction.queuedTitle",
  ];
  for (const key of keys) assert.ok(isMessageKey(key), key);
  assert.equal(T("hris.correction.refused"), "Ditolak");
  assert.equal(
    T("hris.correction.refusedReason", { reason: "Waktu salah." }),
    "Alasan server: Waktu salah.",
  );
  assert.equal(T("hris.correction.retry"), "Coba lagi");
  assert.equal(T("hris.correction.edit"), "Ubah");
  assert.equal(T("hris.correction.discard"), "Buang");
  assert.equal(
    T("hris.correction.replayDropped", { count: 2 }),
    "2 pengajuan dari antrean ditolak server. Buka Beranda untuk coba lagi, ubah, atau buang.",
  );
});

test("nvc7 a full queue evicts waiting entries before refused ones", () => {
  const storage = memoryStorage();
  const body = () => ({
    outletId: outlet.id,
    attendanceLogId: null,
    requestedType: "in",
    requestedOccurredAt: "2026-10-31T00:55:00.000Z",
    reason: "Ponsel kehabisan baterai.",
    idempotencyKey: randomUUID(),
  });
  const refusedKeys = [];
  for (let i = 0; i < 3; i += 1) {
    const entry = body();
    refusedKeys.push(entry.idempotencyKey);
    enqueueCorrection(entry, ME_ID, storage);
    markCorrectionRefused(
      entry.idempotencyKey,
      {
        status: 400,
        code: "VALIDATION",
        reason: "Ditolak.",
        at: new Date().toISOString(),
      },
      storage,
    );
  }
  for (let i = 0; i < 25; i += 1) enqueueCorrection(body(), ME_ID, storage);
  const queue = readCorrectionQueue(storage);
  assert.equal(queue.length, 20);
  for (const key of refusedKeys)
    assert.equal(
      queue.some((row) => row.key === key && isRefused(row)),
      true,
    );
});

// ---- legend-xzzdq (P1 privacy): a new account never sees the previous one's
// cached profile or offline queue. These import the new modules lazily so each
// test fails on its own while the implementation is missing.

const featureDir = "../apps/web/src/features/ws10-hris-employee";

test("xzzdq the cached profile key carries the session user id", async () => {
  const { hrisKeys } = await import(`${featureDir}/keys.ts`);
  const a = hrisKeys.profile("user-a");
  const b = hrisKeys.profile("user-b");
  assert.notDeepEqual(a, b, "two accounts must not share one profile cache");
  assert.deepEqual(hrisKeys.profile("user-a"), a, "the key is stable per user");
  // Both stay under the root key so one removeQueries(hrisKeys.all) on
  // sign-out / sign-in clears every private entry.
  assert.deepEqual(a.slice(0, hrisKeys.all.length), [...hrisKeys.all]);
  assert.deepEqual(b.slice(0, hrisKeys.all.length), [...hrisKeys.all]);
  assert.ok(a.includes("user-a"));
  assert.ok(b.includes("user-b"));
});

test("xzzdq canActOnQueued is true only for the same non-null employee", async () => {
  const { canActOnQueued } = await import(`${featureDir}/identity.ts`);
  assert.equal(canActOnQueued({ employeeId: "emp-a" }, "emp-a"), true);
  assert.equal(canActOnQueued({ employeeId: "emp-a" }, "emp-b"), false);
  assert.equal(canActOnQueued({ employeeId: "emp-a" }, null), false);
});

test("xzzdq account A's queued corrections and reasons never show for account B", async () => {
  const { canActOnQueued } = await import(`${featureDir}/identity.ts`);
  const storage = memoryStorage();
  const otherId = fixtures.employees.find(
    (employee) => employee.id !== ME_ID,
  ).id;
  const secret = queuedBody(randomUUID(), {
    reason: "Alasan pribadi akun A.",
  });
  enqueueCorrection(secret, ME_ID, storage);
  markCorrectionRefused(
    secret.idempotencyKey,
    {
      status: 422,
      code: "X",
      reason: "Alasan server akun A.",
      at: REFUSED_AT.toISOString(),
    },
    storage,
  );
  const queue = readCorrectionQueue(storage);

  // Account B (or nobody yet) sees nothing of A's queue.
  assert.deepEqual(queuedFor(queue, otherId), []);
  assert.deepEqual(queuedFor(queue, null), []);
  assert.equal(queuedFor(queue, ME_ID).length, 1);

  // And B cannot retry or discard A's row even if it is somehow in hand.
  const [row] = queuedFor(queue, ME_ID);
  assert.equal(canActOnQueued(row, otherId), false);
  assert.equal(canActOnQueued(row, null), false);
  assert.equal(canActOnQueued(row, ME_ID), true);
});

// ---- legend-l5tvy (P2): a full queue never silently drops the new filing, and
// Ubah never loses both the old and the replacement entry.

const MAX_QUEUED = 20;

function refusal(reason = "Ditolak.") {
  return { status: 422, code: "X", reason, at: REFUSED_AT.toISOString() };
}

/** Seed `refused` refused entries then `waiting` waiting ones, oldest first. */
function seedQueue(storage, { refused, waiting = 0 }, employeeId = ME_ID) {
  const refusedKeys = [];
  const waitingKeys = [];
  for (let i = 0; i < refused; i += 1) {
    const body = queuedBody();
    enqueueCorrection(body, employeeId, storage);
    markCorrectionRefused(
      body.idempotencyKey,
      refusal(`Ditolak ${i}.`),
      storage,
    );
    refusedKeys.push(body.idempotencyKey);
  }
  for (let i = 0; i < waiting; i += 1) {
    const body = queuedBody();
    enqueueCorrection(body, employeeId, storage);
    waitingKeys.push(body.idempotencyKey);
  }
  return { refusedKeys, waitingKeys };
}

test("l5tvy a full queue of refused entries refuses the new filing and changes nothing", async () => {
  const { CorrectionQueueFullError } = await import(`${featureDir}/queue.ts`);
  const storage = memoryStorage();
  seedQueue(storage, { refused: MAX_QUEUED });
  const before = readCorrectionQueue(storage);
  assert.equal(before.length, MAX_QUEUED);
  const snapshot = JSON.stringify(before);

  assert.throws(
    () => enqueueCorrection(queuedBody(), ME_ID, storage),
    (error) => error instanceof CorrectionQueueFullError,
  );
  const after = readCorrectionQueue(storage);
  assert.equal(after.length, MAX_QUEUED);
  assert.equal(JSON.stringify(after), snapshot, "no entry dropped or added");
  assert.ok(after.every((row) => isRefused(row)));
});

test("l5tvy 19 refused + 1 waiting + a new filing: the waiting one goes, every refusal stays", () => {
  const storage = memoryStorage();
  const { refusedKeys, waitingKeys } = seedQueue(storage, {
    refused: MAX_QUEUED - 1,
    waiting: 1,
  });
  assert.equal(readCorrectionQueue(storage).length, MAX_QUEUED);

  const fresh = queuedBody();
  enqueueCorrection(fresh, ME_ID, storage);
  const queue = readCorrectionQueue(storage);
  assert.equal(queue.length, MAX_QUEUED);
  assert.equal(
    queue.some((row) => row.key === waitingKeys[0]),
    false,
    "the old waiting entry is the one evicted",
  );
  assert.ok(queue.some((row) => row.key === fresh.idempotencyKey));
  for (const key of refusedKeys)
    assert.equal(
      queue.some((row) => row.key === key && isRefused(row)),
      true,
      "no refusal is dropped for a new filing",
    );
});

test("l5tvy Ubah on a full queue of refused entries swaps one entry and keeps the length", () => {
  const storage = memoryStorage();
  const { refusedKeys } = seedQueue(storage, { refused: MAX_QUEUED });
  const oldKey = refusedKeys[7];
  const fixed = queuedBody(randomUUID(), { reason: "Sudah diperbaiki." });

  const queue = replaceQueuedCorrection(oldKey, fixed, ME_ID, storage);
  assert.equal(queue.length, MAX_QUEUED, "never grows past the limit");
  assert.equal(
    queue.some((row) => row.key === oldKey),
    false,
    "the old attempt is gone",
  );
  const created = queue.find((row) => row.key === fixed.idempotencyKey);
  assert.ok(created, "the replacement is there");
  assert.equal(isRefused(created), false);
  assert.equal(created.employeeId, ME_ID);
  // Every other refusal is untouched.
  for (const key of refusedKeys.filter((k) => k !== oldKey))
    assert.equal(
      queue.some((row) => row.key === key && isRefused(row)),
      true,
    );
  assert.deepEqual(readCorrectionQueue(storage), queue, "one atomic write");
});

test("l5tvy Ubah with an unknown key leaves the queue as it was", async () => {
  const storage = memoryStorage();
  seedQueue(storage, { refused: 3, waiting: 1 });
  const snapshot = JSON.stringify(readCorrectionQueue(storage));
  // Assumption: the brief only fixes the outcome (queue unchanged), not
  // whether the call returns or throws, so both are accepted.
  try {
    replaceQueuedCorrection("no-such-key", queuedBody(), ME_ID, storage);
  } catch {
    // refusing loudly is fine
  }
  assert.equal(JSON.stringify(readCorrectionQueue(storage)), snapshot);

  // Same on a full queue: an unknown key must not turn into an eviction.
  const full = memoryStorage();
  seedQueue(full, { refused: MAX_QUEUED });
  const fullSnapshot = JSON.stringify(readCorrectionQueue(full));
  try {
    replaceQueuedCorrection("no-such-key", queuedBody(), ME_ID, full);
  } catch {
    // refusing loudly is fine
  }
  assert.equal(JSON.stringify(readCorrectionQueue(full)), fullSnapshot);
});

test("l5tvy Ubah never replaces another employee's entry", () => {
  const storage = memoryStorage();
  const otherId = fixtures.employees.find(
    (employee) => employee.id !== ME_ID,
  ).id;
  const theirs = queuedBody();
  enqueueCorrection(theirs, otherId, storage);
  markCorrectionRefused(theirs.idempotencyKey, refusal(), storage);
  seedQueue(storage, { refused: 2 });
  const snapshot = JSON.stringify(readCorrectionQueue(storage));

  try {
    replaceQueuedCorrection(
      theirs.idempotencyKey,
      queuedBody(),
      ME_ID,
      storage,
    );
  } catch {
    // refusing loudly is fine
  }
  assert.equal(JSON.stringify(readCorrectionQueue(storage)), snapshot);
  const row = readCorrectionQueue(storage).find(
    (r) => r.key === theirs.idempotencyKey,
  );
  assert.ok(row, "their entry survives");
  assert.equal(row.employeeId, otherId);
  assert.equal(isRefused(row), true);
});

test("l5tvy the dialog's Ubah order never loses both the old and the new entry", async () => {
  const { CorrectionQueueFullError } = await import(`${featureDir}/queue.ts`);

  // Offline path on a full queue: one atomic replace. Either the swap happened
  // or nothing changed; the filer is never left with neither entry.
  const full = memoryStorage();
  const { refusedKeys } = seedQueue(full, { refused: MAX_QUEUED });
  const oldKey = refusedKeys[0];
  const fixed = queuedBody();
  try {
    replaceQueuedCorrection(oldKey, fixed, ME_ID, full);
  } catch {
    // a failed replace must leave the old entry in place (checked below)
  }
  const afterReplace = readCorrectionQueue(full);
  const hasOld = afterReplace.some((row) => row.key === oldKey);
  const hasNew = afterReplace.some((row) => row.key === fixed.idempotencyKey);
  assert.ok(hasOld || hasNew, "never neither");
  assert.equal(hasOld && hasNew, false, "never both on a full queue");
  assert.ok(afterReplace.length <= MAX_QUEUED);

  // Plain enqueue (what the old dialog did first) on a full refused queue
  // fails loudly and, because the dialog no longer removes the old entry
  // after success, the old entry is still there.
  const stuck = memoryStorage();
  const seeded = seedQueue(stuck, { refused: MAX_QUEUED });
  assert.throws(
    () => enqueueCorrection(queuedBody(), ME_ID, stuck),
    (error) => error instanceof CorrectionQueueFullError,
  );
  assert.ok(
    readCorrectionQueue(stuck).some((row) => row.key === seeded.refusedKeys[0]),
  );
});

test("l5tvy the catalog carries the queue-full text", () => {
  assert.ok(isMessageKey("hris.correction.queueFull"));
  assert.equal(
    T("hris.correction.queueFull"),
    "Antrean penuh oleh pengajuan yang ditolak. Buang atau ubah salah satunya dulu.",
  );
});

test("pl8hc a storage that refuses the write is not reported as queued", async () => {
  const { CorrectionQueueWriteError } = await import(`${featureDir}/queue.ts`);
  const full = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  const body = queuedBody();
  assert.throws(
    () => enqueueCorrection(body, ME_ID, full),
    (error) => error instanceof CorrectionQueueWriteError,
  );
  assert.throws(
    () => enqueueCorrection(body, ME_ID, null),
    (error) => error instanceof CorrectionQueueWriteError,
  );
  assert.deepEqual(readCorrectionQueue(full), []);
  assert.ok(isMessageKey("hris.correction.queueWriteFailed"));
});
