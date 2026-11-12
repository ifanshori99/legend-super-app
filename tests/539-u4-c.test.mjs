// 539-U4 row C (legend-ydf2): employee request form rules. The logic module is
// pure (no React, no hooks), so it loads directly with Node type stripping.
// Also checks that every catalog key the form files mention exists.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

const dir = "apps/web/src/features/hris-requests/components/";
const logic = await import(`../${dir}request-form-logic.ts`);
const { hrisRequestsEmployeeMessages } =
  await import("../packages/shared/src/i18n/messages/hris-requests-employee.ts");

const A1 = { id: "a1", outletId: "o1" };

describe("rowsOf", () => {
  test("accepts array, data page and infinite pages", () => {
    assert.deepEqual(logic.rowsOf([1, 2]), [1, 2]);
    assert.deepEqual(logic.rowsOf({ data: [1] }), [1]);
    assert.deepEqual(logic.rowsOf({ pages: [{ data: [1] }, { data: [2] }] }), [1, 2]);
    assert.deepEqual(logic.rowsOf(undefined), []);
  });
});

describe("isNetworkFailure", () => {
  test("offline browser or NETWORK_ERROR code", () => {
    assert.equal(logic.isNetworkFailure(new Error("x"), false), true);
    assert.equal(logic.isNetworkFailure({ code: "NETWORK_ERROR", status: 0 }), true);
    assert.equal(logic.isNetworkFailure({ code: "X", status: 422 }), false);
    assert.equal(logic.isNetworkFailure(undefined), false);
  });
});

describe("validateSwap", () => {
  test("swap needs shift, peer and peer shift", () => {
    const { errors, payload } = logic.validateSwap(
      { kind: "swap", fromAssignmentId: "", toEmployeeId: "", toAssignmentId: "" },
      [A1],
    );
    assert.equal(payload, null);
    assert.ok(errors.fromAssignmentId && errors.toEmployeeId && errors.toAssignmentId);
  });
  test("swap sends the peer shift, outlet from my shift", () => {
    const { payload } = logic.validateSwap(
      { kind: "swap", fromAssignmentId: "a1", toEmployeeId: "e2", toAssignmentId: "a2" },
      [A1],
    );
    assert.deepEqual(payload, {
      outletId: "o1",
      fromAssignmentId: "a1",
      toEmployeeId: "e2",
      toAssignmentId: "a2",
    });
  });
  test("cover sends toAssignmentId null and ignores a stale peer shift", () => {
    const { errors, payload } = logic.validateSwap(
      { kind: "cover", fromAssignmentId: "a1", toEmployeeId: "e2", toAssignmentId: "a2" },
      [A1],
    );
    assert.deepEqual(errors, {});
    assert.equal(payload.toAssignmentId, null);
  });
  test("a shift that is not mine is refused", () => {
    const { payload } = logic.validateSwap(
      { kind: "cover", fromAssignmentId: "zz", toEmployeeId: "e2", toAssignmentId: "" },
      [A1],
    );
    assert.equal(payload, null);
  });
});

describe("leave", () => {
  const ok = { leaveTypeId: "t1", startDate: "2026-11-18", endDate: "2026-11-19", reason: " Keperluan " };
  test("counts calendar days inclusive", () => {
    assert.equal(logic.leaveDayCount("2026-11-18", "2026-11-19"), 2);
    assert.equal(logic.leaveDayCount("2026-11-18", "2026-11-18"), 1);
    assert.equal(logic.leaveDayCount("2026-11-19", "2026-11-18"), null);
    assert.equal(logic.leaveDayCount("2026-02-30", "2026-03-01"), null);
  });
  test("valid input becomes a trimmed payload without attachment", () => {
    const { payload } = logic.validateLeave(ok);
    assert.deepEqual(payload, {
      leaveTypeId: "t1",
      startDate: "2026-11-18",
      endDate: "2026-11-19",
      reason: "Keperluan",
    });
    assert.equal("attachmentUploadRef" in payload, false);
  });
  test("reports each missing field", () => {
    const { errors, payload } = logic.validateLeave({
      leaveTypeId: "",
      startDate: "",
      endDate: "",
      reason: "  ",
    });
    assert.equal(payload, null);
    assert.deepEqual(Object.keys(errors).sort(), ["endDate", "leaveTypeId", "reason", "startDate"]);
  });
  test("end before start and reason over 500 chars", () => {
    assert.ok(logic.validateLeave({ ...ok, endDate: "2026-11-17" }).errors.endDate);
    assert.ok(logic.validateLeave({ ...ok, reason: "x".repeat(501) }).errors.reason);
  });
  test("remaining days = entitled + carried - used - pending, per type and year", () => {
    const balances = [
      { leaveTypeId: "t1", periodYear: 2026, entitledDays: "12.0000", carriedOverDays: "1.0000", usedDays: "4.0000", pendingDays: "1.5000" },
      { leaveTypeId: "t1", periodYear: 2025, entitledDays: "12.0000", carriedOverDays: "0.0000", usedDays: "0.0000", pendingDays: "0.0000" },
    ];
    assert.equal(logic.remainingLeaveDays(balances, "t1", 2026), 7.5);
    assert.equal(logic.remainingLeaveDays(balances, "t2", 2026), null);
    assert.equal(logic.formatDays(7.5), "7,5");
    assert.equal(logic.formatDays(8), "8");
  });
});

describe("leave attachment hold", () => {
  const ok = { leaveTypeId: "t1", startDate: "2026-11-18", endDate: "2026-11-18", reason: "Sakit" };
  test("a type that requires an attachment is not sent", () => {
    const held = logic.validateLeave(ok, { requiresAttachment: true });
    assert.equal(held.payload, null);
    assert.equal(held.errors.leaveTypeId, "hrisRequestsEmployee.leave.errors.attachmentBlocked");
    assert.ok(logic.validateLeave(ok, { requiresAttachment: false }).payload);
  });
});

describe("tabs by permission", () => {
  test("only tabs the account may use, in order", () => {
    assert.deepEqual(logic.allowedTabs(["self.leave.request"]), ["leave"]);
    assert.deepEqual(
      logic.allowedTabs(["self.shift_swap.request", "self.leave.request", "self.profile.view"]),
      ["swap", "leave", "overtime"],
    );
    assert.deepEqual(logic.allowedTabs([]), []);
  });
  test("a wanted tab without permission falls back to the first allowed", () => {
    assert.equal(logic.pickTab("swap", ["leave"]), "leave");
    assert.equal(logic.pickTab("leave", ["swap", "leave"]), "leave");
    assert.equal(logic.pickTab("swap", []), null);
  });
});

describe("overtime", () => {
  const ok = { date: "2026-11-18", startTime: "16:00", endTime: "18:00", reason: "Acara outlet" };
  test("minutes between times, end must be after start", () => {
    assert.equal(logic.overtimeMinutes("16:00", "18:30"), 150);
    assert.equal(logic.overtimeMinutes("18:00", "16:00"), null);
    assert.equal(logic.overtimeMinutes("", "16:00"), null);
  });
  test("payload carries minutes and outlet", () => {
    const { payload } = logic.validateOvertime(ok, "o1");
    assert.deepEqual(payload, { outletId: "o1", date: "2026-11-18", minutes: 120, reason: "Acara outlet" });
  });
  test("no outlet means no payload", () => {
    assert.equal(logic.validateOvertime(ok, undefined).payload, null);
  });
  test("more than 12 hours and reversed times are refused", () => {
    assert.ok(logic.validateOvertime({ ...ok, startTime: "06:00", endTime: "19:00" }, "o1").errors.endTime);
    assert.ok(logic.validateOvertime({ ...ok, endTime: "15:00" }, "o1").errors.endTime);
    assert.ok(logic.validateOvertime({ ...ok, reason: "" }, "o1").errors.reason);
  });
});

describe("shift label", () => {
  test("formats in the outlet zone", () => {
    const label = logic.shiftOptionLabel(
      {
        businessDate: "2026-11-18",
        segments: [{ startsAt: "2026-11-18T01:00:00.000Z", endsAt: "2026-11-18T09:00:00.000Z" }],
      },
      "Asia/Jakarta",
    );
    assert.match(label, /18 November 2026/);
    assert.match(label, /08\.00–16\.00/);
  });
});

describe("keyForDraft", () => {
  test("same draft keeps its key, changed draft or kind gets a new one", () => {
    let n = 0;
    const make = () => `k${++n}`;
    const first = logic.keyForDraft(null, "leave", { a: 1 }, make);
    const retry = logic.keyForDraft(first, "leave", { a: 1 }, make);
    assert.equal(retry.key, first.key);
    assert.notEqual(logic.keyForDraft(retry, "leave", { a: 2 }, make).key, first.key);
    assert.notEqual(logic.keyForDraft(retry, "swap", { a: 1 }, make).key, first.key);
    assert.notEqual(logic.keyForDraft(null, "leave", { a: 1 }, make).key, first.key);
  });
});

describe("catalog keys", () => {
  function has(path) {
    let node = hrisRequestsEmployeeMessages;
    for (const part of path.split(".")) {
      if (typeof node !== "object" || node === null || !(part in node)) return false;
      node = node[part];
    }
    return typeof node === "string";
  }
  test("every hrisRequestsEmployee key used in the form files exists", () => {
    const files = readdirSync(dir).filter((name) => name.startsWith("request-form-"));
    assert.ok(files.length >= 6);
    for (const file of files) {
      const source = readFileSync(dir + file, "utf8");
      for (const match of source.matchAll(/hrisRequestsEmployee\.([A-Za-z.]+)/g)) {
        assert.ok(has(match[1]), `${file}: missing key ${match[1]}`);
      }
    }
  });
});
