// 539-U4 row E (legend-ydf2): supervisor queue logic. Pure module, so no fakes:
// search, which decisions need a reason (reject, HR-05 override), who may decide
// which kind, and the message key of a failed decision. Runs in the root
// node:test suite (apps/web has no vitest setup).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const {
  canDecideKind,
  complianceIssueKey,
  filterQueue,
  isNetworkFailure,
  isQueueKind,
  needsOverride,
  planDecision,
  queueErrorKey,
  requestReason,
  statusLabelKey,
  statusTone,
} =
  await import("../apps/web/src/features/hris-requests/components/queue-model.ts");

const issue = { code: "insufficient_rest" };
const swapWithIssue = { kind: "swap", complianceIssues: [issue] };
const cleanSwap = { kind: "swap", complianceIssues: [] };
const leave = { kind: "leave" };

describe("filterQueue", () => {
  const items = [
    { employeeName: "Ayu Wulandari" },
    { employeeName: "Maya Anggraini" },
  ];
  test("blank term keeps everything", () => {
    assert.equal(filterQueue(items, "   ").length, 2);
  });
  test("matches the name case-insensitively", () => {
    assert.deepEqual(filterQueue(items, " MAYA "), [items[1]]);
  });
  test("no match returns an empty list", () => {
    assert.equal(filterQueue(items, "zzz").length, 0);
  });
});

describe("planDecision", () => {
  test("reject asks no reason and sends none (the API stores none)", () => {
    assert.deepEqual(planDecision(leave, "reject", "   "), {
      ok: true,
      reason: undefined,
    });
    assert.deepEqual(planDecision(swapWithIssue, "reject", "Jadwal penuh"), {
      ok: true,
      reason: undefined,
    });
  });
  test("plain approval needs no reason and sends none", () => {
    assert.deepEqual(planDecision(leave, "approve", "ignored"), {
      ok: true,
      reason: undefined,
    });
    assert.deepEqual(planDecision(cleanSwap, "approve", ""), {
      ok: true,
      reason: undefined,
    });
  });
  test("a swap that breaks the rules cannot be approved without an override reason", () => {
    assert.deepEqual(planDecision(swapWithIssue, "approve", " "), {
      ok: false,
      error: "overrideRequired",
    });
    assert.deepEqual(planDecision(swapWithIssue, "approve", "Darurat"), {
      ok: true,
      reason: "Darurat",
    });
  });
});

describe("needsOverride", () => {
  test("only swap and cover with issues", () => {
    assert.equal(needsOverride(swapWithIssue), true);
    assert.equal(
      needsOverride({ kind: "cover", complianceIssues: [issue] }),
      true,
    );
    assert.equal(needsOverride(cleanSwap), false);
    assert.equal(needsOverride({ kind: "swap" }), false);
    assert.equal(
      needsOverride({ kind: "leave", complianceIssues: [issue] }),
      false,
    );
  });
});

describe("permissions and kinds", () => {
  test("each kind needs its own right", () => {
    assert.equal(canDecideKind("swap", ["hr.schedule.manage"]), true);
    assert.equal(canDecideKind("cover", ["hr.schedule.manage"]), true);
    assert.equal(canDecideKind("leave", ["hr.schedule.manage"]), false);
    assert.equal(canDecideKind("leave", ["hr.leave.approve"]), true);
    assert.equal(canDecideKind("overtime", ["hr.leave.approve"]), false);
    assert.equal(canDecideKind("overtime", ["hr.overtime.approve"]), true);
    assert.equal(canDecideKind("swap", []), false);
  });
  test("route kind is validated", () => {
    assert.equal(isQueueKind("leave"), true);
    assert.equal(isQueueKind("payroll"), false);
  });
});

describe("labels and errors", () => {
  test("status labels and tones", () => {
    assert.equal(
      statusLabelKey("approved"),
      "hrisRequestsQueue.status.approved",
    );
    assert.equal(statusLabelKey("weird"), "hrisRequestsQueue.status.pending");
    assert.equal(statusTone("pending"), "warning");
    assert.equal(statusTone("approved"), "success");
    assert.equal(statusTone("rejected"), "danger");
  });
  test("compliance codes map to a message, unknown to none", () => {
    assert.equal(
      complianceIssueKey("overlapping_shift"),
      "hrisRequestsQueue.compliance.overlapping_shift",
    );
    assert.equal(complianceIssueKey("nope"), null);
  });
  test("reason of the request comes from raw", () => {
    assert.equal(
      requestReason({ reason: "Keperluan keluarga" }),
      "Keperluan keluarga",
    );
    assert.equal(requestReason({ reason: "  " }), null);
    assert.equal(requestReason({}), null);
    assert.equal(requestReason(null), null);
  });
  test("network failure is separate from refusals", () => {
    assert.equal(isNetworkFailure({ status: 0, code: "X" }), true);
    assert.equal(
      isNetworkFailure({ status: 500, code: "NETWORK_ERROR" }),
      true,
    );
    assert.equal(isNetworkFailure({ status: 403, code: "FORBIDDEN" }), false);
    assert.equal(isNetworkFailure(new Error("x")), false);
  });
  test("error keys follow the status", () => {
    assert.equal(
      queueErrorKey({ status: 403 }),
      "hrisRequestsQueue.errors.forbidden",
    );
    assert.equal(
      queueErrorKey({ status: 404 }),
      "hrisRequestsQueue.errors.notFound",
    );
    assert.equal(
      queueErrorKey({ status: 409 }),
      "hrisRequestsQueue.errors.conflict",
    );
    assert.equal(
      queueErrorKey(new Error("x")),
      "hrisRequestsQueue.errors.unknown",
    );
  });
});
