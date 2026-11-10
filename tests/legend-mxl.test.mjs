// Approval inbox logic (bead legend-mxl; PRD v1.7 §3 F7 Kotak Approval;
// AUTH-06 distinct actor; MCP-04 UI). Run: node --test <this file>.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const logic = await import("../apps/web/src/features/ws01-approvals/logic.ts");
const { APPROVAL_ACTION_TYPES } =
  await import("../packages/shared/src/access/index.ts");

const NOW = Date.parse("2026-11-03T05:00:00.000Z");
const at = (minutes) => new Date(NOW + minutes * 60_000).toISOString();
const req = (over = {}) => ({
  status: "pending",
  deadlineAt: at(30),
  createdAt: at(-30),
  requestedBy: "11111111-1111-4111-8111-111111111111",
  actionType: "refund",
  ...over,
});
const words = { yes: "Ya", no: "Tidak", none: "-" };

describe("MCP-04 approval inbox logic", () => {
  test("MCP-04 every action type maps to a module", () => {
    for (const type of APPROVAL_ACTION_TYPES)
      assert.ok(logic.APPROVAL_MODULES.includes(logic.moduleOf(type)), type);
    assert.equal(logic.moduleOf("ai_action"), "automation");
    assert.equal(logic.moduleOf("mcp_action"), "automation");
  });

  test("MCP-04 deadline states: open, urgent, overdue, closed", () => {
    assert.equal(logic.deadlineInfo(req(), NOW).state, "open");
    assert.equal(
      logic.deadlineInfo(req({ deadlineAt: at(9) }), NOW).state,
      "urgent",
    );
    const late = logic.deadlineInfo(req({ deadlineAt: at(-12) }), NOW);
    assert.equal(late.state, "overdue");
    assert.equal(
      logic.deadlineLabelKey(late),
      "approvals.deadline.late.minute",
    );
    assert.equal(late.amount, 12);
    assert.equal(
      logic.deadlineInfo(req({ status: "approved" }), NOW).state,
      "closed",
    );
    assert.equal(logic.splitDuration(3 * 3_600_000).unit, "hour");
    assert.equal(logic.splitDuration(3 * 86_400_000).unit, "day");
  });

  test("AUTH-06 the requester cannot decide their own request", () => {
    const base = { request: req(), canDecide: true, now: NOW };
    assert.equal(
      logic.decisionBlock({
        ...base,
        currentUserId: req().requestedBy.toUpperCase(),
      }),
      "own",
    );
    assert.equal(
      logic.decisionBlock({
        ...base,
        currentUserId: "22222222-2222-4222-8222-222222222222",
      }),
      null,
    );
  });

  test("legend-mbhw1 sole Owner own request: approve opens, reject stays shut, false keeps both blocked", () => {
    const own = req().requestedBy;
    const open = {
      request: req({ selfApprovalAllowed: true }),
      currentUserId: own.toUpperCase(),
      canDecide: true,
      now: NOW,
    };
    assert.equal(logic.isSelfApproval(open.request, own), true);
    assert.equal(logic.decisionBlock(open), null);
    assert.equal(logic.rejectBlock(open), "own");
    const closed = { ...open, request: req({ selfApprovalAllowed: false }) };
    assert.equal(logic.isSelfApproval(closed.request, own), false);
    assert.equal(logic.decisionBlock(closed), "own");
    assert.equal(logic.rejectBlock(closed), "own");
    // flag absent (every other chain) behaves as false
    assert.equal(logic.decisionBlock({ ...open, request: req() }), "own");
    // someone else's request is unaffected by the flag
    const other = {
      ...open,
      currentUserId: "22222222-2222-4222-8222-222222222222",
    };
    assert.equal(
      logic.isSelfApproval(open.request, other.currentUserId),
      false,
    );
    assert.equal(logic.decisionBlock(other), null);
    assert.equal(logic.rejectBlock(other), null);
  });

  test("legend-mbhw1 self-approval never overrides the other blocks", () => {
    const own = req().requestedBy;
    const base = { currentUserId: own, canDecide: true, now: NOW };
    const flagged = (over) => req({ selfApprovalAllowed: true, ...over });
    assert.equal(
      logic.decisionBlock({
        ...base,
        request: flagged({ status: "approved" }),
      }),
      "notPending",
    );
    assert.equal(
      logic.decisionBlock({
        ...base,
        request: flagged({ deadlineAt: at(-1) }),
      }),
      "expired",
    );
    assert.equal(
      logic.decisionBlock({ ...base, request: flagged(), canDecide: false }),
      "permission",
    );
    assert.equal(
      logic.decisionBlock({
        ...base,
        request: flagged(),
        mfaEnrollmentRequired: true,
      }),
      "enrollment",
    );
    assert.equal(
      logic.rejectBlock({
        ...base,
        request: flagged(),
        mfaEnrollmentRequired: true,
      }),
      "enrollment",
    );
  });

  test("legend-mbhw1 APPROVAL_PENDING maps to its own message", () => {
    assert.equal(
      logic.errorMessageKey("APPROVAL_PENDING"),
      "approvals.errors.pending",
    );
  });

  test("MCP-04 decisions fail closed: unknown user, no permission, expired, decided", () => {
    const user = "22222222-2222-4222-8222-222222222222";
    assert.equal(
      logic.decisionBlock({
        request: req(),
        currentUserId: null,
        canDecide: true,
        now: NOW,
      }),
      "identity",
    );
    assert.equal(
      logic.decisionBlock({
        request: req(),
        currentUserId: user,
        canDecide: false,
        now: NOW,
      }),
      "permission",
    );
    assert.equal(
      logic.decisionBlock({
        request: req({ deadlineAt: at(-1) }),
        currentUserId: user,
        canDecide: true,
        now: NOW,
      }),
      "expired",
    );
    assert.equal(
      logic.decisionBlock({
        request: req({ status: "rejected" }),
        currentUserId: user,
        canDecide: true,
        now: NOW,
      }),
      "notPending",
    );
    assert.equal(
      logic.decisionBlock({
        request: req(),
        currentUserId: user,
        canDecide: true,
        mfaEnrollmentRequired: true,
        now: NOW,
      }),
      "enrollment",
    );
  });

  test("AUTH-05 step-up is needed while the session owes a second factor", () => {
    assert.equal(
      logic.needsStepUp({
        mfaRequired: true,
        session: { mfaVerifiedAt: null },
      }),
      true,
    );
    assert.equal(
      logic.needsStepUp({
        mfaRequired: true,
        session: { mfaVerifiedAt: at(-1) },
      }),
      false,
    );
    assert.equal(
      logic.needsStepUp({
        mfaRequired: false,
        session: { mfaVerifiedAt: null },
      }),
      false,
    );
  });

  test("MCP-04 reject needs a reason of 3..500 characters", () => {
    assert.equal(logic.reasonProblem("  ab "), "short");
    assert.equal(logic.reasonProblem("Harga salah"), null);
    assert.equal(logic.reasonProblem("x".repeat(501)), "long");
  });

  test("MCP-04 error codes map to catalog keys", () => {
    assert.equal(
      logic.errorMessageKey("APPROVER_IS_REQUESTER"),
      "approvals.errors.approverIsRequester",
    );
    assert.equal(
      logic.errorMessageKey("APPROVAL_REQUEST_EXPIRED"),
      "approvals.errors.expired",
    );
    assert.equal(
      logic.errorMessageKey("MFA_REQUIRED"),
      "approvals.errors.mfaRequired",
    );
    assert.equal(logic.errorMessageKey("???"), "approvals.errors.generic");
    assert.equal(logic.errorMeansStale("APPROVAL_REQUEST_NOT_PENDING"), true);
  });

  test("MCP-04 filters: server query carries status and source, client narrows module and deadline", () => {
    const filters = {
      ...logic.DEFAULT_FILTERS,
      source: "ai",
      module: "automation",
      deadline: "within1h",
    };
    assert.deepEqual(logic.toServerQuery(filters, 50), {
      limit: 50,
      status: "pending",
      source: "ai",
    });
    const rows = [
      req({ actionType: "ai_action", deadlineAt: at(20) }),
      req({ actionType: "refund", deadlineAt: at(20) }),
      req({ actionType: "ai_action", deadlineAt: at(300) }),
    ];
    assert.equal(logic.applyClientFilters(rows, filters, NOW).length, 1);
    assert.equal(
      logic.applyClientFilters(
        rows,
        { ...logic.DEFAULT_FILTERS, deadline: "overdue" },
        NOW,
      ).length,
      0,
    );
  });

  test("MCP-04 sort puts the most urgent pending request first", () => {
    const sorted = logic.sortInbox([
      req({ id: "late", deadlineAt: at(90) }),
      req({ id: "done", status: "approved" }),
      req({ id: "soon", deadlineAt: at(5) }),
    ]);
    assert.deepEqual(
      sorted.map((row) => row.id),
      ["soon", "late", "done"],
    );
  });

  test("MCP-04 diff pairs from/to into a proposed change and lists other facts", () => {
    const rows = logic.diffRows(
      {
        tool: "menu.price.update",
        itemName: "Kopi",
        fromIdr: 28000,
        toIdr: 30000,
      },
      logic.humanizeKey,
      words,
    );
    assert.equal(rows[0].kind, "change");
    assert.match(rows[0].before, /28\.000/);
    assert.match(rows[0].after, /30\.000/);
    assert.deepEqual(
      rows.slice(1).map((row) => row.key),
      ["tool", "itemName"],
    );
    assert.equal(logic.humanizeKey("differenceQty"), "Difference qty");
    assert.equal(logic.previewRow(rows).kind, "change");
  });

  test("MCP-04 badge counts pending and flags more pages", () => {
    assert.deepEqual(
      logic.badgeCount([{ status: "pending" }, { status: "approved" }], true),
      { count: 1, capped: true },
    );
  });

  test("MCP-04 badge equals the inbox default row count (same server query)", () => {
    const rows = [
      req({ deadlineAt: at(20) }),
      req({ deadlineAt: at(-12) }),
      req({ actionType: "ai_action", deadlineAt: at(130) }),
    ];
    const shown = logic.applyClientFilters(
      rows,
      logic.DEFAULT_FILTERS,
      NOW,
    ).length;
    assert.equal(logic.badgeCount(rows, false).count, shown);
    assert.deepEqual(logic.toServerQuery(logic.DEFAULT_FILTERS), {
      limit: logic.INBOX_PAGE_SIZE,
      status: "pending",
    });
  });

  test("F38 AI and MCP requests are agent drafts; user requests are not", () => {
    assert.equal(logic.isAgentDraft("ai"), true);
    assert.equal(logic.isAgentDraft("mcp"), true);
    assert.equal(logic.isAgentDraft("user"), false);
  });

  test("MCP-04 reason bounds come from approvalDecisionInputSchema", () => {
    assert.equal(logic.REASON_MIN, 3);
    assert.equal(logic.REASON_MAX, 500);
    assert.equal(logic.reasonProblem(""), "short");
    assert.equal(logic.reasonProblem("x".repeat(500)), null);
  });

  test("MCP-04 a reused idempotency key maps to its own message", () => {
    assert.equal(
      logic.errorMessageKey("IDEMPOTENCY_KEY_REUSED"),
      "approvals.errors.idempotencyReused",
    );
  });
});
