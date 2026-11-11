// HR review of clock-ins on approved leave days: data layer (bead legend-3jem1).
// Runs with the root node:test suite, no database. It loads the feature's pure
// enrichment (enrich.ts), its mock handlers and the web mock runtime with Node
// type stripping. The screens are exercised in e2e/legend-3jem1.mock.spec.ts.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { dispatchMock, resetMocks } from "../apps/web/src/lib/mock/runtime.ts";
import "../apps/web/src/features/hr-leave-clockin-review/mock.ts";
import {
  applyDecidedItem,
  buildLeaveClockinCase,
  businessDateOfLog,
  compareLeaveClockinCases,
  decisionOfAction,
  decisionOfReviewStatus,
  findClockOut,
  findCoveringLeave,
  isLeaveClockinItem,
  keepDecidedLeave,
  leaveClockinKind,
  resolveBusinessDate,
} from "../apps/web/src/features/hr-leave-clockin-review/enrich.ts";

const ZONE = "Asia/Jakarta";
const OUTLET = "10000000-0000-4000-8000-000000000001";

function log(overrides = {}) {
  return {
    id: "01JBQ7Z8K3M4N5P6Q7R8S9T900",
    tenantId: "t",
    employeeId: "e1",
    outletId: OUTLET,
    type: "in",
    method: "rotating_qr",
    occurredAt: "2026-10-26T01:50:00.000Z",
    ...overrides,
  };
}

function leave(overrides = {}) {
  return {
    id: "l1",
    employeeId: "e1",
    leaveTypeId: "lt1",
    startDate: "2026-10-26",
    endDate: "2026-10-26",
    status: "approved",
    decidedAt: "2026-10-20T02:00:00.000Z",
    ...overrides,
  };
}

function item(overrides = {}) {
  return {
    log: log(),
    source: "flagged",
    flagReasons: ["leave_approved"],
    reviewStatus: "pending",
    reviewedBy: null,
    reviewedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  globalThis.document = { cookie: "" };
});
afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
  resetMocks();
});

test("business date is the outlet-zone calendar date of the clock-in", () => {
  assert.equal(
    businessDateOfLog("2026-10-26T01:50:00.000Z", ZONE),
    "2026-10-26",
  );
  // 17:00Z is 00:00 WIB the next day; 16:59Z is still the 25th.
  assert.equal(
    businessDateOfLog("2026-10-25T17:00:00.000Z", ZONE),
    "2026-10-26",
  );
  assert.equal(
    businessDateOfLog("2026-10-25T16:59:59.000Z", ZONE),
    "2026-10-25",
  );
});

test("only queue items with the leave_approved flag belong to the feature", () => {
  assert.equal(isLeaveClockinItem(item()), true);
  assert.equal(
    isLeaveClockinItem(item({ flagReasons: ["outside_geofence"] })),
    false,
  );
  assert.equal(isLeaveClockinItem(item({ flagReasons: [] })), false);
});

test("review status maps to the decision; rejected means kept leave, never rejected", () => {
  assert.equal(decisionOfReviewStatus("pending"), "pending");
  assert.equal(decisionOfReviewStatus("none"), "pending");
  assert.equal(decisionOfReviewStatus("rejected"), "kept_leave");
  assert.equal(decisionOfReviewStatus("accepted"), "cancelled_leave");
  assert.equal(decisionOfAction("keep_leave"), "kept_leave");
  assert.equal(decisionOfAction("cancel_leave"), "cancelled_leave");
});

test("covering leave: inclusive bounds, approved only, latest decision wins", () => {
  const multi = leave({
    id: "m",
    startDate: "2026-10-25",
    endDate: "2026-10-27",
  });
  assert.equal(findCoveringLeave([multi], "2026-10-25")?.id, "m");
  assert.equal(findCoveringLeave([multi], "2026-10-27")?.id, "m");
  assert.equal(findCoveringLeave([multi], "2026-10-28"), null);
  assert.equal(findCoveringLeave([multi], "2026-10-24"), null);
  assert.equal(
    findCoveringLeave(
      [leave({ status: "pending" }), leave({ status: "rejected" })],
      "2026-10-26",
    ),
    null,
  );
  const older = leave({ id: "old", decidedAt: "2026-10-01T00:00:00.000Z" });
  const newer = leave({ id: "new", decidedAt: "2026-10-25T00:00:00.000Z" });
  assert.equal(findCoveringLeave([newer, older], "2026-10-26")?.id, "new");
  assert.equal(findCoveringLeave([], "2026-10-26"), null);
});

test("clock-out: first out after the clock-in, own employee only, else null", () => {
  const logs = [
    log({ id: "a", type: "out", occurredAt: "2026-10-26T01:00:00.000Z" }), // before the in
    log({ id: "b", type: "out", occurredAt: "2026-10-26T08:00:00.000Z" }),
    log({ id: "c", type: "out", occurredAt: "2026-10-26T09:05:00.000Z" }),
    log({
      id: "d",
      type: "break_start",
      occurredAt: "2026-10-26T10:00:00.000Z",
    }),
    log({
      id: "e",
      employeeId: "e2",
      type: "out",
      occurredAt: "2026-10-26T11:00:00.000Z",
    }),
  ];
  assert.equal(
    findClockOut(logs, "e1", "2026-10-26T01:50:00.000Z"),
    "2026-10-26T08:00:00.000Z",
  );
  assert.equal(
    findClockOut(logs.slice(0, 1), "e1", "2026-10-26T01:50:00.000Z"),
    null,
  );
  assert.equal(findClockOut([], "e1", "2026-10-26T01:50:00.000Z"), null);
});

test("clock-out: a split day stops at the next in; a rejected out is skipped", () => {
  const split = [
    log({ id: "o1", type: "out", occurredAt: "2026-10-26T05:00:00.000Z" }),
    log({ id: "i2", type: "in", occurredAt: "2026-10-26T07:00:00.000Z" }),
    log({ id: "o2", type: "out", occurredAt: "2026-10-26T10:00:00.000Z" }),
  ];
  assert.equal(
    findClockOut(split, "e1", "2026-10-26T01:50:00.000Z"),
    "2026-10-26T05:00:00.000Z",
  );
  // The second session's clock-in gets the second out, not the first.
  assert.equal(
    findClockOut(split, "e1", "2026-10-26T07:00:00.000Z"),
    "2026-10-26T10:00:00.000Z",
  );
  // No out between the clock-in and the next in: still "belum absen keluar".
  assert.equal(
    findClockOut(split.slice(1), "e1", "2026-10-26T01:50:00.000Z"),
    null,
  );
  const rejected = [
    log({
      id: "r",
      type: "out",
      validity: "rejected",
      occurredAt: "2026-10-26T05:00:00.000Z",
    }),
    log({ id: "v", type: "out", occurredAt: "2026-10-26T09:00:00.000Z" }),
  ];
  assert.equal(
    findClockOut(rejected, "e1", "2026-10-26T01:50:00.000Z"),
    "2026-10-26T09:00:00.000Z",
  );
  assert.equal(
    findClockOut(rejected.slice(0, 1), "e1", "2026-10-26T01:50:00.000Z"),
    null,
  );
});

test("business date: a shift log takes the day list that holds it (night shift = D-1)", () => {
  // 00:30 Jakarta on 27 Oct, inside the night shift that began on 26 Oct.
  const night = log({
    id: "night",
    occurredAt: "2026-10-26T17:30:00.000Z",
    shiftAssignmentId: "s1",
  });
  const lists = {
    "2026-10-26": [{ id: "night" }],
    "2026-10-27": [{ id: "other" }],
  };
  const of = (date) => lists[date];
  assert.equal(resolveBusinessDate(night, ZONE, of), "2026-10-26");
  // Listed under its own calendar date: that date wins.
  assert.equal(
    resolveBusinessDate(night, ZONE, (date) =>
      date === "2026-10-27" ? [{ id: "night" }] : [],
    ),
    "2026-10-27",
  );
  // No list read (failed lookup): the pure calendar date.
  assert.equal(
    resolveBusinessDate(night, ZONE, () => null),
    "2026-10-27",
  );
  // No shift: never looks at the lists.
  assert.equal(
    resolveBusinessDate({ ...night, shiftAssignmentId: null }, ZONE, of),
    "2026-10-27",
  );
  const built = buildLeaveClockinCase(item({ log: night }), ZONE, {
    employees: null,
    leaveTypes: null,
    leaves: [leave()],
    dayLogs: null,
    businessDate: "2026-10-26",
  });
  assert.equal(built.businessDate, "2026-10-26");
  assert.equal(built.leave?.leaveRequestId, "l1");
  assert.equal(built.timeZone, ZONE);
});

test("a decided case keeps its leave when a refetch no longer finds it approved", () => {
  const lookups = {
    employees: null,
    leaveTypes: [{ id: "lt1", name: "Cuti Tahunan" }],
    leaves: [leave()],
    dayLogs: null,
  };
  const before = applyDecidedItem(
    buildLeaveClockinCase(item({ flagReasons: ["leave_approved"] }), ZONE, {
      ...lookups,
      leaves: [leave({ decidedAt: "2026-10-26T04:30:00.000Z" })],
    }),
    item({ reviewStatus: "accepted" }),
    "cancel_leave",
  );
  assert.equal(before.kind, "re_review");
  const refetched = buildLeaveClockinCase(
    item({ reviewStatus: "accepted" }),
    ZONE,
    { ...lookups, leaves: [] },
  );
  assert.equal(refetched.leave, null);
  const kept = keepDecidedLeave(before, refetched);
  assert.equal(kept?.leave?.leaveRequestId, "l1");
  assert.equal(kept?.kind, "re_review");
  // Pending refetch, or no cached leave: nothing is merged.
  assert.equal(
    keepDecidedLeave(before, { ...refetched, decision: "pending" })?.leave,
    null,
  );
  assert.equal(keepDecidedLeave(null, refetched), refetched);
  // A deep link to a cancelled case reads the leave from the cancelled rows.
  const deepLink = buildLeaveClockinCase(
    item({ reviewStatus: "accepted" }),
    ZONE,
    {
      ...lookups,
      leaves: [],
      cancelledLeaves: [leave({ status: "cancelled" })],
    },
  );
  assert.equal(deepLink.leave?.leaveRequestId, "l1");
  assert.equal(deepLink.kind, "clock_in_on_leave");
  // ...but only for a cancelled decision.
  const pending = buildLeaveClockinCase(item(), ZONE, {
    ...lookups,
    leaves: [],
    cancelledLeaves: [leave({ status: "cancelled" })],
  });
  assert.equal(pending.leave, null);
});

test("kind: manual correction wins, later-approved leave is a re-review", () => {
  assert.equal(leaveClockinKind(log(), leave()), "clock_in_on_leave");
  assert.equal(
    leaveClockinKind(log({ method: "manual_correction" }), leave()),
    "manual_correction",
  );
  assert.equal(
    leaveClockinKind(log(), leave({ decidedAt: "2026-10-26T04:30:00.000Z" })),
    "re_review",
  );
  assert.equal(
    leaveClockinKind(
      log({ method: "manual_correction" }),
      leave({ decidedAt: "2026-10-26T04:30:00.000Z" }),
    ),
    "manual_correction",
  );
  assert.equal(leaveClockinKind(log(), null), "clock_in_on_leave");
});

test("a failed lookup blanks only its own field", () => {
  const lookups = {
    employees: [{ id: "e1", fullName: "Dewi Lestari" }],
    leaveTypes: [{ id: "lt1", name: "Cuti Tahunan" }],
    leaves: [leave({ startDate: "2026-10-25", endDate: "2026-10-27" })],
    dayLogs: [
      log({ id: "o", type: "out", occurredAt: "2026-10-26T09:05:00.000Z" }),
    ],
  };
  const full = buildLeaveClockinCase(item(), ZONE, lookups);
  assert.equal(full.employeeName, "Dewi Lestari");
  assert.equal(full.leave?.typeName, "Cuti Tahunan");
  assert.equal(full.leave?.multiDay, true);
  assert.equal(full.clockOutAt, "2026-10-26T09:05:00.000Z");
  assert.equal(full.businessDate, "2026-10-26");
  assert.equal(full.decision, "pending");

  const blank = buildLeaveClockinCase(item(), ZONE, {
    employees: null,
    leaveTypes: null,
    leaves: null,
    dayLogs: null,
  });
  assert.equal(blank.employeeName, null);
  assert.equal(blank.leave, null);
  assert.equal(blank.clockOutAt, null);
  assert.equal(blank.logId, log().id);

  const noType = buildLeaveClockinCase(item(), ZONE, {
    ...lookups,
    leaveTypes: null,
  });
  assert.equal(noType.leave?.typeName, null);
  assert.equal(noType.leave?.leaveRequestId, "l1");
});

test("the decision follows the confirmed action, not a lagging item status", () => {
  const base = buildLeaveClockinCase(item(), ZONE, {
    employees: null,
    leaveTypes: null,
    leaves: null,
    dayLogs: null,
  });
  const stillPending = item({ reviewStatus: "pending" });
  assert.equal(
    applyDecidedItem(base, stillPending, "keep_leave").decision,
    "kept_leave",
  );
  assert.equal(
    applyDecidedItem(base, stillPending, "cancel_leave").decision,
    "cancelled_leave",
  );
  assert.equal(
    applyDecidedItem(base, stillPending, "keep_leave").kind,
    base.kind,
  );
});

test("queue order: newest date first, then latest clock-in", () => {
  const make = (logId, businessDate, clockInAt) => ({
    logId,
    businessDate,
    clockInAt,
  });
  const sorted = [
    make("a", "2026-10-25", "2026-10-25T05:00:00.000Z"),
    make("b", "2026-10-26", "2026-10-26T01:00:00.000Z"),
    make("c", "2026-10-26", "2026-10-26T02:00:00.000Z"),
  ].sort(compareLeaveClockinCases);
  assert.deepEqual(
    sorted.map((row) => row.logId),
    ["c", "b", "a"],
  );
});

// ---- Mock handlers + enrichment end to end ---------------------------------

async function get(path, query = {}) {
  return dispatchMock({ method: "GET", path, query });
}

async function buildMockCases(status = "pending") {
  const queue = await get("/api/hris/attendance/review-queue", {
    reviewStatus: status,
    limit: 100,
  });
  const employees = (await get("/api/hris/employees", { limit: 100 })).data;
  const leaveTypes = (await get("/api/hris/leave/types", { limit: 100 })).data;
  const cases = [];
  for (const row of queue.data) {
    const leaves = (
      await get("/api/hris/leave/requests", {
        employeeId: row.log.employeeId,
        status: "approved",
        limit: 100,
      })
    ).data;
    const dayLogs = (
      await get("/api/hris/attendance/logs", {
        outletId: row.log.outletId,
        businessDate: businessDateOfLog(row.log.occurredAt, ZONE),
        limit: 100,
      })
    ).data;
    cases.push(
      buildLeaveClockinCase(row, ZONE, {
        employees,
        leaveTypes,
        leaves,
        dayLogs,
      }),
    );
  }
  return cases;
}

test("mock fixtures yield the four documented cases", async () => {
  const cases = await buildMockCases();
  assert.equal(cases.length, 4);
  const byName = Object.fromEntries(
    cases.map((row) => [row.employeeName, row]),
  );

  const dewi = byName["Dewi Lestari"];
  assert.equal(dewi.kind, "clock_in_on_leave");
  assert.equal(dewi.leave.multiDay, true);
  assert.equal(dewi.leave.typeName, "Cuti Tahunan");
  assert.notEqual(dewi.clockOutAt, null);

  const ayu = byName["Ayu Wulandari"];
  assert.equal(ayu.kind, "clock_in_on_leave");
  assert.equal(ayu.leave.multiDay, false);
  assert.equal(ayu.clockOutAt, null);

  assert.equal(byName["Agus Setiawan"].kind, "re_review");
  assert.equal(byName["Maya Anggraini"].kind, "manual_correction");
  assert.ok(cases.every((row) => row.businessDate === "2026-10-26"));
  assert.ok(cases.every((row) => row.decision === "pending"));
});

test("mock: empty scenario gives an empty queue", async () => {
  const { setScenario } = await import("../apps/web/src/lib/mock/control.ts");
  setScenario("empty");
  const queue = await get("/api/hris/attendance/review-queue", { limit: 100 });
  assert.deepEqual(queue.data, []);
});

async function decide(logId, action, idempotencyKey) {
  return dispatchMock({
    method: "POST",
    path: `/api/hris/attendance/logs/${logId}/review`,
    body: { action, idempotencyKey },
  });
}

test("mock: keep_leave and cancel_leave move the case out of pending", async () => {
  const [first, second] = await buildMockCases();
  const kept = await decide(first.logId, "keep_leave", "key-keep-0001");
  assert.equal(kept.data.reviewStatus, "rejected");
  const cancelled = await decide(
    second.logId,
    "cancel_leave",
    "key-cancel-001",
  );
  assert.equal(cancelled.data.reviewStatus, "accepted");

  assert.equal((await buildMockCases("pending")).length, 2);
  const rejected = await buildMockCases("rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].decision, "kept_leave");
  assert.equal(
    (await buildMockCases("accepted"))[0].decision,
    "cancelled_leave",
  );
});

test("mock: the same key replays the result, another decision is a 409", async () => {
  const [first] = await buildMockCases();
  const one = await decide(first.logId, "keep_leave", "key-replay-001");
  const again = await decide(first.logId, "keep_leave", "key-replay-001");
  assert.deepEqual(again, one);
  await assert.rejects(
    decide(first.logId, "cancel_leave", "key-replay-002"),
    (error) =>
      error.status === 409 &&
      error.code === "ATTENDANCE_LEAVE_DECISION_NOT_ALLOWED",
  );
  await assert.rejects(
    decide(first.logId, "cancel_leave", "key-replay-001"),
    (error) => error.status === 409 && error.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("mock: without the right to cancel leave only keep_leave works", async () => {
  const store = new Map();
  globalThis.window = {
    location: { search: "?leaveRights=keep-only" },
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    },
  };
  const [first, second] = await buildMockCases();
  await assert.rejects(
    decide(first.logId, "cancel_leave", "key-denied-001"),
    (error) => error.status === 403,
  );
  const kept = await decide(second.logId, "keep_leave", "key-denied-002");
  assert.equal(kept.data.reviewStatus, "rejected");
});
