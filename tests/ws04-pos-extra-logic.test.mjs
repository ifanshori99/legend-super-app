// POS extra (brief sub-539-u2): the pure money/state logic behind the extra
// cashier cards. Written from the brief's "Logika murni" signatures, the
// mockups and the shared contract (packages/shared/src/payment/admin.ts), not
// from any implementation. Money rule ("jangan sampai rugi"): nobody is paid
// twice and no amount goes negative or above what is owed.
//
// Each module is imported lazily inside its tests so a missing file fails only
// its own cases (fail-first), not the whole suite. Plain Node ESM + type
// stripping like tests/ws04-pos-kasir-mock-engine.test.mjs.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const web = "../apps/web/src/features";
const load = (path) => import(`${web}/${path}`);

// ---------------------------------------------------------------- I4 payment-due
describe("I4 payment-due: remainingToPayIdr", () => {
  test("total minus deposit minus captured", async () => {
    const { remainingToPayIdr } = await load("ws04-pos-kasir/payment-due.ts");
    assert.equal(
      remainingToPayIdr({
        totalIdr: 100000,
        depositAppliedIdr: 0,
        capturedIdr: 0,
      }),
      100000,
    );
    assert.equal(
      remainingToPayIdr({
        totalIdr: 100000,
        depositAppliedIdr: 30000,
        capturedIdr: 0,
      }),
      70000,
    );
    assert.equal(
      remainingToPayIdr({
        totalIdr: 100000,
        depositAppliedIdr: 30000,
        capturedIdr: 20000,
      }),
      50000,
    );
    assert.equal(
      remainingToPayIdr({
        totalIdr: 100000,
        depositAppliedIdr: 0,
        capturedIdr: 100000,
      }),
      0,
    );
  });

  test("deposit equal to the total leaves nothing to pay (DP lunas)", async () => {
    const { remainingToPayIdr } = await load("ws04-pos-kasir/payment-due.ts");
    assert.equal(
      remainingToPayIdr({
        totalIdr: 250000,
        depositAppliedIdr: 250000,
        capturedIdr: 0,
      }),
      0,
    );
  });

  test("never negative: deposit above the total, or deposit plus captured above it", async () => {
    const { remainingToPayIdr } = await load("ws04-pos-kasir/payment-due.ts");
    assert.equal(
      remainingToPayIdr({
        totalIdr: 100000,
        depositAppliedIdr: 150000,
        capturedIdr: 0,
      }),
      0,
    );
    assert.equal(
      remainingToPayIdr({
        totalIdr: 100000,
        depositAppliedIdr: 60000,
        capturedIdr: 60000,
      }),
      0,
    );
    assert.equal(
      remainingToPayIdr({ totalIdr: 0, depositAppliedIdr: 0, capturedIdr: 0 }),
      0,
    );
  });

  test("non-integer input throws RangeError (no fractional rupiah)", async () => {
    const { remainingToPayIdr } = await load("ws04-pos-kasir/payment-due.ts");
    const ok = { totalIdr: 100000, depositAppliedIdr: 0, capturedIdr: 0 };
    for (const field of ["totalIdr", "depositAppliedIdr", "capturedIdr"]) {
      for (const bad of [1000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.throws(
          () => remainingToPayIdr({ ...ok, [field]: bad }),
          RangeError,
          `${field}=${bad}`,
        );
      }
    }
  });

  test("negative input throws RangeError", async () => {
    const { remainingToPayIdr } = await load("ws04-pos-kasir/payment-due.ts");
    const ok = { totalIdr: 100000, depositAppliedIdr: 0, capturedIdr: 0 };
    for (const field of ["totalIdr", "depositAppliedIdr", "capturedIdr"]) {
      assert.throws(
        () => remainingToPayIdr({ ...ok, [field]: -1 }),
        RangeError,
        field,
      );
    }
  });
});

describe("I4 payment-due: isSettledByDeposit", () => {
  test("true when the deposit covers the whole bill", async () => {
    const { isSettledByDeposit } = await load("ws04-pos-kasir/payment-due.ts");
    assert.equal(
      isSettledByDeposit({ totalIdr: 250000, depositAppliedIdr: 250000 }),
      true,
    );
    assert.equal(
      isSettledByDeposit({ totalIdr: 250000, depositAppliedIdr: 300000 }),
      true,
    );
  });

  test("false when the deposit only covers part of the bill", async () => {
    const { isSettledByDeposit } = await load("ws04-pos-kasir/payment-due.ts");
    assert.equal(
      isSettledByDeposit({ totalIdr: 250000, depositAppliedIdr: 249999 }),
      false,
    );
    assert.equal(
      isSettledByDeposit({ totalIdr: 250000, depositAppliedIdr: 0 }),
      false,
    );
  });

  test("an empty bill (total 0) is never 'settled by deposit'", async () => {
    const { isSettledByDeposit } = await load("ws04-pos-kasir/payment-due.ts");
    assert.equal(
      isSettledByDeposit({ totalIdr: 0, depositAppliedIdr: 0 }),
      false,
    );
    assert.equal(
      isSettledByDeposit({ totalIdr: 0, depositAppliedIdr: 50000 }),
      false,
    );
  });

  test("agrees with remainingToPayIdr: settled implies nothing left to pay", async () => {
    const { isSettledByDeposit, remainingToPayIdr } = await load(
      "ws04-pos-kasir/payment-due.ts",
    );
    for (const [totalIdr, depositAppliedIdr] of [
      [100000, 100000],
      [100000, 120000],
      [1, 1],
    ]) {
      assert.equal(isSettledByDeposit({ totalIdr, depositAppliedIdr }), true);
      assert.equal(
        remainingToPayIdr({ totalIdr, depositAppliedIdr, capturedIdr: 0 }),
        0,
      );
    }
  });
});

// ---------------------------------------------------------------- I2 charge-logic
describe("I2 charge-logic: chargeDiffIdr", () => {
  test("replacement dearer than the original charges only the difference", async () => {
    const { chargeDiffIdr } = await load(
      "ws04-pos-order-detail/charge-logic.ts",
    );
    assert.equal(
      chargeDiffIdr({ originalIdr: 40000, replacementIdr: 55000 }),
      15000,
    );
    assert.equal(
      chargeDiffIdr({ originalIdr: 0, replacementIdr: 25000 }),
      25000,
    );
  });

  test("equal price: nothing to charge", async () => {
    const { chargeDiffIdr } = await load(
      "ws04-pos-order-detail/charge-logic.ts",
    );
    assert.equal(
      chargeDiffIdr({ originalIdr: 40000, replacementIdr: 40000 }),
      0,
    );
  });

  test("cheaper replacement never yields a negative charge (no refund here)", async () => {
    const { chargeDiffIdr } = await load(
      "ws04-pos-order-detail/charge-logic.ts",
    );
    assert.equal(
      chargeDiffIdr({ originalIdr: 55000, replacementIdr: 40000 }),
      0,
    );
    assert.equal(chargeDiffIdr({ originalIdr: 55000, replacementIdr: 0 }), 0);
  });

  test("result is always an integer >= 0", async () => {
    const { chargeDiffIdr } = await load(
      "ws04-pos-order-detail/charge-logic.ts",
    );
    for (const original of [0, 1, 999, 40000]) {
      for (const replacement of [0, 1, 999, 40000, 100000]) {
        const diff = chargeDiffIdr({
          originalIdr: original,
          replacementIdr: replacement,
        });
        assert.ok(
          Number.isInteger(diff) && diff >= 0,
          `${original}->${replacement}`,
        );
        assert.equal(diff, Math.max(0, replacement - original));
      }
    }
  });
});

// ---------------------------------------------------------------- I6 refund-actions
// Final rule (coordinator, money rule "never pay twice"): RefundView has no flag
// for these states, so they are read from `lastPayoutError` on an `approved`
// refund. A refund is retryable ONLY when the send provably never left: a
// never-sent code AND payoutAttempts = 0 AND providerRef null. Any attempt or
// provider reference means the provider may already have paid, so only a
// status lookup is safe (unknown_result).
const QUARANTINED_ERROR = "PAYOUT_QUARANTINED";
const RETRYABLE_ERRORS = [
  "PAYOUT_SEND_RIGHT_LOST",
  "PAYOUT_SEND_WINDOW_MISSED",
];
const UNKNOWN_ERRORS = [
  "PROVIDER_UNAVAILABLE", // transient, free code
  "ECONNRESET",
  "PAYOUT_NOT_FOUND_MAYBE_SENT",
  "DOIT_REFUND_IDENTITY_MISMATCH",
  "MANUAL_RECONCILIATION",
];

function refundView(overrides = {}) {
  return {
    id: "0b6a1c1e-4c1f-4a0e-9a53-5a6f3a0d0001",
    tenantId: "0b6a1c1e-4c1f-4a0e-9a53-5a6f3a0d0002",
    createdAt: "2026-11-11T07:10:00.000Z",
    updatedAt: "2026-11-11T07:10:00.000Z",
    paymentIntentId: "0b6a1c1e-4c1f-4a0e-9a53-5a6f3a0d0003",
    amountIdr: 50000,
    reason: "Item tidak tersedia",
    providerRef: null,
    status: "pending",
    approvedBy: null,
    paymentReference: "PAY-0148",
    method: "qris",
    paidAmountIdr: 100000,
    outletName: "Cafe Legend Bandung",
    requestedBy: "0b6a1c1e-4c1f-4a0e-9a53-5a6f3a0d0004",
    requestedByName: "Kasir",
    viewerCanApprove: false,
    approvedByName: null,
    note: null,
    decidedAt: null,
    failureReason: null,
    payoutAttempts: 0,
    lastPayoutError: null,
    escalatedAt: null,
    escalationReason: null,
    completedAt: null,
    ...overrides,
  };
}

const approved = (overrides = {}) =>
  refundView({
    status: "approved",
    approvedBy: "0b6a1c1e-4c1f-4a0e-9a53-5a6f3a0d0005",
    approvedByName: "Manajer",
    decidedAt: "2026-11-11T07:15:00.000Z",
    ...overrides,
  });

const views = {
  pending_approval: () =>
    refundView({ status: "pending", viewerCanApprove: true }),
  approved_processing: () =>
    approved({ payoutAttempts: 1, lastPayoutError: null }),
  unknown_result: () =>
    approved({ payoutAttempts: 1, lastPayoutError: "PROVIDER_UNAVAILABLE" }),
  retryable: () =>
    approved({ payoutAttempts: 0, lastPayoutError: "PAYOUT_SEND_RIGHT_LOST" }),
  quarantined: () =>
    approved({ payoutAttempts: 0, lastPayoutError: QUARANTINED_ERROR }),
  rejected: () => refundView({ status: "failed", failureReason: "rejected" }),
  failed_final: () =>
    approved({
      status: "failed",
      failureReason: "provider_declined",
      payoutAttempts: 1,
      lastPayoutError: "PROVIDER_DECLINED",
    }),
  completed: () =>
    approved({
      status: "completed",
      providerRef: "doit-rf-0022",
      completedAt: "2026-11-11T07:20:00.000Z",
    }),
};

const NO_ACTIONS = {
  approve: false,
  reject: false,
  retry: false,
  checkStatus: false,
  release: false,
  reopen: false,
};

describe("I6 refund-actions: refundUiState", () => {
  test("maps every refund lifecycle state", async () => {
    const { refundUiState } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const [state, make] of Object.entries(views)) {
      assert.equal(refundUiState(make()), state, state);
    }
  });

  test("a rejected refund (failureReason rejected) is not 'failed_final'", async () => {
    const { refundUiState } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    assert.equal(
      refundUiState(
        refundView({ status: "failed", failureReason: "rejected" }),
      ),
      "rejected",
    );
    for (const reason of [
      "provider_declined",
      "cap_exceeded",
      "approval_expired",
      "approver_unauthorized",
      "source_document",
    ]) {
      assert.equal(
        refundUiState(refundView({ status: "failed", failureReason: reason })),
        "failed_final",
        reason,
      );
    }
  });

  test("a legacy failed refund (no failureReason) is final, never retryable", async () => {
    const { refundUiState } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    assert.equal(
      refundUiState(refundView({ status: "failed", failureReason: null })),
      "failed_final",
    );
    assert.equal(
      refundUiState(refundView({ status: "failed", failureReason: undefined })),
      "failed_final",
    );
  });

  test("approved without any error is still processing, regardless of attempts", async () => {
    const { refundUiState } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    assert.equal(
      refundUiState(approved({ payoutAttempts: 0, lastPayoutError: null })),
      "approved_processing",
    );
    assert.equal(
      refundUiState(
        approved({ payoutAttempts: undefined, lastPayoutError: undefined }),
      ),
      "approved_processing",
    );
  });
});

describe("I6 refund-actions: refundActions", () => {
  test("pending: approve and reject follow viewerCanApprove, nothing else", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    assert.deepEqual(refundActions(views.pending_approval()), {
      ...NO_ACTIONS,
      approve: true,
      reject: true,
    });
    // The requester (or anyone the matrix does not allow) cannot decide it.
    assert.deepEqual(
      refundActions(refundView({ status: "pending", viewerCanApprove: false })),
      NO_ACTIONS,
    );
  });

  test("approve and reject are never offered outside the pending state", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const [state, make] of Object.entries(views)) {
      if (state === "pending_approval") continue;
      // Even if a stale viewerCanApprove=true arrives, the guard still holds.
      const actions = refundActions({ ...make(), viewerCanApprove: true });
      assert.equal(actions.approve, false, `${state} approve`);
      assert.equal(actions.reject, false, `${state} reject`);
    }
  });

  test("unknown_result: check status only, retry locked (no double payout)", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    assert.deepEqual(refundActions(views.unknown_result()), {
      ...NO_ACTIONS,
      checkStatus: true,
    });
  });

  test("retryable: retry allowed, no approve/reject, no quarantine actions", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    const actions = refundActions(views.retryable());
    assert.equal(actions.retry, true);
    assert.equal(actions.approve, false);
    assert.equal(actions.reject, false);
    assert.equal(actions.release, false);
    assert.equal(actions.reopen, false);
  });

  test("approved_processing: nothing to retry while the payout is in flight", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    const actions = refundActions(views.approved_processing());
    assert.equal(actions.retry, false);
    assert.equal(actions.approve, false);
    assert.equal(actions.reject, false);
    assert.equal(actions.release, false);
    assert.equal(actions.reopen, false);
  });

  test("quarantined: release and reopen, never retry or approve", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    const actions = refundActions(views.quarantined());
    assert.equal(actions.release, true);
    assert.equal(actions.reopen, true);
    assert.equal(actions.retry, false);
    assert.equal(actions.approve, false);
    assert.equal(actions.reject, false);
  });

  test("quarantine release/reopen are offered only in the quarantined state", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const [state, make] of Object.entries(views)) {
      if (state === "quarantined") continue;
      const actions = refundActions(make());
      assert.equal(actions.release, false, `${state} release`);
      assert.equal(actions.reopen, false, `${state} reopen`);
    }
  });

  test("rejected and failed_final: no actions at all (final, no retry)", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    assert.deepEqual(refundActions(views.rejected()), NO_ACTIONS);
    assert.deepEqual(refundActions(views.failed_final()), NO_ACTIONS);
  });

  test("completed: no actions (money already returned)", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    assert.deepEqual(refundActions(views.completed()), NO_ACTIONS);
  });

  test("money invariant: retry is allowed only for the retryable state", async () => {
    const { refundActions, refundUiState } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const [state, make] of Object.entries(views)) {
      const view = make();
      assert.equal(refundActions(view).retry, state === "retryable", state);
      assert.equal(refundUiState(view), state);
    }
  });

  test("money invariant: retry and checkStatus are never both offered", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const make of Object.values(views)) {
      const actions = refundActions(make());
      assert.ok(!(actions.retry && actions.checkStatus));
    }
  });

  test("a failed refund with a leftover payout error still cannot retry", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    const actions = refundActions(
      refundView({
        status: "failed",
        failureReason: "provider_declined",
        lastPayoutError: "PAYOUT_SEND_RIGHT_LOST",
        payoutAttempts: 3,
      }),
    );
    assert.equal(actions.retry, false);
  });

  test("transient or free-form payout errors are unknown_result: check status, never retry", async () => {
    const { refundActions, refundUiState } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const lastPayoutError of UNKNOWN_ERRORS) {
      for (const payoutAttempts of [1, 3]) {
        const view = approved({ payoutAttempts, lastPayoutError });
        assert.equal(refundUiState(view), "unknown_result", lastPayoutError);
        assert.deepEqual(
          refundActions(view),
          { ...NO_ACTIONS, checkStatus: true },
          lastPayoutError,
        );
      }
    }
  });

  test("PROVIDER_UNAVAILABLE after an attempt does not offer retry", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    const view = approved({
      payoutAttempts: 1,
      lastPayoutError: "PROVIDER_UNAVAILABLE",
    });
    assert.equal(refundActions(view).retry, false);
    assert.equal(refundActions(view).checkStatus, true);
  });

  test("never-sent codes with no attempt and no provider ref are retryable", async () => {
    const { refundActions, refundUiState } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const lastPayoutError of RETRYABLE_ERRORS) {
      for (const payoutAttempts of [0, undefined]) {
        const view = approved({ payoutAttempts, lastPayoutError });
        assert.equal(refundUiState(view), "retryable", lastPayoutError);
        assert.deepEqual(
          refundActions(view),
          { ...NO_ACTIONS, retry: true },
          lastPayoutError,
        );
      }
    }
  });

  test("a never-sent code after an attempt or with a provider ref is unknown_result (lookup only)", async () => {
    const { refundActions, refundUiState } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const lastPayoutError of RETRYABLE_ERRORS) {
      for (const extra of [
        { payoutAttempts: 1 },
        { payoutAttempts: 3 },
        { payoutAttempts: 0, providerRef: "doit-rf-0022" },
      ]) {
        const view = approved({ lastPayoutError, ...extra });
        assert.equal(
          refundUiState(view),
          "unknown_result",
          `${lastPayoutError} ${JSON.stringify(extra)}`,
        );
        assert.deepEqual(refundActions(view), {
          ...NO_ACTIONS,
          checkStatus: true,
        });
      }
    }
  });

  test("EVIDENCE_MAPPING_REQUIRED is still processing: no actions at all", async () => {
    const { refundActions, refundUiState } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const payoutAttempts of [0, 1]) {
      const view = approved({
        payoutAttempts,
        lastPayoutError: "EVIDENCE_MAPPING_REQUIRED",
      });
      assert.equal(refundUiState(view), "approved_processing");
      assert.deepEqual(refundActions(view), NO_ACTIONS);
    }
  });

  test("money invariant: retry is never true with an attempt or a provider ref", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    const errors = [
      null,
      QUARANTINED_ERROR,
      "EVIDENCE_MAPPING_REQUIRED",
      ...RETRYABLE_ERRORS,
      ...UNKNOWN_ERRORS,
    ];
    for (const status of ["approved", "failed", "completed", "pending"]) {
      for (const lastPayoutError of errors) {
        for (const extra of [
          { payoutAttempts: 1 },
          { payoutAttempts: 5 },
          { providerRef: "doit-rf-0022" },
        ]) {
          const view = refundView({
            status,
            viewerCanApprove: true,
            lastPayoutError,
            ...extra,
          });
          assert.equal(
            refundActions(view).retry,
            false,
            `${status} ${lastPayoutError} ${JSON.stringify(extra)}`,
          );
        }
      }
    }
  });

  test("quarantined that may already have been sent (attempt or provider ref): check status only", async () => {
    const { refundActions, refundUiState } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const extra of [
      { payoutAttempts: 1 },
      { payoutAttempts: 0, providerRef: "doit-rf-0022" },
    ]) {
      const view = approved({ lastPayoutError: QUARANTINED_ERROR, ...extra });
      assert.equal(refundUiState(view), "quarantined");
      assert.deepEqual(refundActions(view), {
        ...NO_ACTIONS,
        checkStatus: true,
      });
    }
  });

  test("quarantined and never sent: release and reopen only", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    assert.deepEqual(
      refundActions(
        approved({
          payoutAttempts: 0,
          providerRef: null,
          lastPayoutError: QUARANTINED_ERROR,
        }),
      ),
      { ...NO_ACTIONS, release: true, reopen: true },
    );
  });

  test("returns exactly the six action flags, all booleans", async () => {
    const { refundActions } = await load(
      "ws05-payment-admin/refund-actions.ts",
    );
    for (const make of Object.values(views)) {
      const actions = refundActions(make());
      assert.deepEqual(
        Object.keys(actions).sort(),
        Object.keys(NO_ACTIONS).sort(),
      );
      for (const value of Object.values(actions))
        assert.equal(typeof value, "boolean");
    }
  });
});

// ---------------------------------------------------------------- I7 approval-amount
describe("I7 approval-amount: approvalAmountIdr", () => {
  const shiftClose = (payload, amountIdr = null) => ({
    action: "cash_shift_close",
    amountIdr,
    payload,
  });

  test("cash_shift_close, approver: shows payload.valueIdr when it is an integer", async () => {
    const { approvalAmountIdr } = await load(
      "ws01-approvals/approval-amount.ts",
    );
    assert.equal(
      approvalAmountIdr(shiftClose({ valueIdr: 25000 }), "approver"),
      25000,
    );
    assert.equal(approvalAmountIdr(shiftClose({ valueIdr: 0 }), "approver"), 0);
  });

  test("cash_shift_close, approver: a negative variance (shortage) is kept", async () => {
    const { approvalAmountIdr } = await load(
      "ws01-approvals/approval-amount.ts",
    );
    assert.equal(
      approvalAmountIdr(shiftClose({ valueIdr: -15000 }), "approver"),
      -15000,
    );
  });

  test("cash_shift_close, approver: missing or non-integer valueIdr gives null", async () => {
    const { approvalAmountIdr } = await load(
      "ws01-approvals/approval-amount.ts",
    );
    for (const payload of [
      {},
      { valueIdr: null },
      { valueIdr: undefined },
      { valueIdr: "25000" },
      { valueIdr: 250.5 },
      { valueIdr: Number.NaN },
      { valueIdr: Number.POSITIVE_INFINITY },
      { valueIdr: true },
      { valueIdr: { idr: 1 } },
      { other: 25000 },
    ]) {
      assert.equal(
        approvalAmountIdr(shiftClose(payload), "approver"),
        null,
        JSON.stringify(payload),
      );
    }
  });

  test("cash_shift_close, approver: ignores request.amountIdr and uses the payload", async () => {
    const { approvalAmountIdr } = await load(
      "ws01-approvals/approval-amount.ts",
    );
    assert.equal(
      approvalAmountIdr(shiftClose({ valueIdr: 25000 }, 999), "approver"),
      25000,
    );
    assert.equal(approvalAmountIdr(shiftClose({}, 999), "approver"), null);
  });

  test("cash_shift_close, requester: never sees the amount (blind count)", async () => {
    const { approvalAmountIdr } = await load(
      "ws01-approvals/approval-amount.ts",
    );
    assert.equal(
      approvalAmountIdr(shiftClose({ valueIdr: 25000 }), "requester"),
      null,
    );
    assert.equal(
      approvalAmountIdr(shiftClose({ valueIdr: 25000 }, 25000), "requester"),
      null,
    );
    assert.equal(approvalAmountIdr(shiftClose({}, 999), "requester"), null);
  });

  test("other actions: amountIdr for both viewers", async () => {
    const { approvalAmountIdr } = await load(
      "ws01-approvals/approval-amount.ts",
    );
    const refund = {
      action: "pos_refund",
      amountIdr: 75000,
      payload: { valueIdr: 1 },
    };
    assert.equal(approvalAmountIdr(refund, "approver"), 75000);
    assert.equal(approvalAmountIdr(refund, "requester"), 75000);
    const discount = { action: "pos_discount", amountIdr: 0, payload: {} };
    assert.equal(approvalAmountIdr(discount, "approver"), 0);
    assert.equal(approvalAmountIdr(discount, "requester"), 0);
  });

  test("other actions: null amountIdr stays null", async () => {
    const { approvalAmountIdr } = await load(
      "ws01-approvals/approval-amount.ts",
    );
    const request = {
      action: "pos_void",
      amountIdr: null,
      payload: { valueIdr: 5000 },
    };
    assert.equal(approvalAmountIdr(request, "approver"), null);
    assert.equal(approvalAmountIdr(request, "requester"), null);
  });
});

// ---------------------------------------------------------------- I1 correction-logic
describe("I1 correction-logic: discountPreview", () => {
  test("mockup case: 200000 subtotal, 20000 discount, 10% tax", async () => {
    const { discountPreview } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.deepEqual(
      discountPreview({
        subtotalIdr: 200000,
        discountIdr: 20000,
        taxRateBps: 1000,
      }),
      { discountIdr: 20000, taxIdr: 18000, totalIdr: 198000 },
    );
  });

  test("no discount: tax on the full subtotal", async () => {
    const { discountPreview } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.deepEqual(
      discountPreview({
        subtotalIdr: 200000,
        discountIdr: 0,
        taxRateBps: 1000,
      }),
      { discountIdr: 0, taxIdr: 20000, totalIdr: 220000 },
    );
  });

  test("discount above the subtotal is clamped to the subtotal (total 0, no negative)", async () => {
    const { discountPreview } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.deepEqual(
      discountPreview({
        subtotalIdr: 200000,
        discountIdr: 300000,
        taxRateBps: 1000,
      }),
      { discountIdr: 200000, taxIdr: 0, totalIdr: 0 },
    );
  });

  test("discount equal to the subtotal gives a zero total", async () => {
    const { discountPreview } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.deepEqual(
      discountPreview({
        subtotalIdr: 200000,
        discountIdr: 200000,
        taxRateBps: 1000,
      }),
      { discountIdr: 200000, taxIdr: 0, totalIdr: 0 },
    );
  });

  test("negative discount is clamped to 0 (cannot raise the bill)", async () => {
    const { discountPreview } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.deepEqual(
      discountPreview({
        subtotalIdr: 200000,
        discountIdr: -5000,
        taxRateBps: 1000,
      }),
      { discountIdr: 0, taxIdr: 20000, totalIdr: 220000 },
    );
  });

  test("zero tax rate: total is subtotal minus discount", async () => {
    const { discountPreview } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.deepEqual(
      discountPreview({
        subtotalIdr: 200000,
        discountIdr: 50000,
        taxRateBps: 0,
      }),
      { discountIdr: 50000, taxIdr: 0, totalIdr: 150000 },
    );
  });

  test("tax is rounded to whole rupiah (half rounds up)", async () => {
    const { discountPreview } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    // 5 * 10% = 0.5 -> 1 ; 15 * 10% = 1.5 -> 2 ; 10001 * 10% = 1000.1 -> 1000
    assert.equal(
      discountPreview({ subtotalIdr: 5, discountIdr: 0, taxRateBps: 1000 })
        .taxIdr,
      1,
    );
    assert.equal(
      discountPreview({ subtotalIdr: 15, discountIdr: 0, taxRateBps: 1000 })
        .taxIdr,
      2,
    );
    assert.equal(
      discountPreview({ subtotalIdr: 10001, discountIdr: 0, taxRateBps: 1000 })
        .taxIdr,
      1000,
    );
    // 11% (1100 bps) on 33333 = 3666.63 -> 3667
    assert.equal(
      discountPreview({ subtotalIdr: 33333, discountIdr: 0, taxRateBps: 1100 })
        .taxIdr,
      3667,
    );
  });

  test("empty bill: everything is 0", async () => {
    const { discountPreview } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.deepEqual(
      discountPreview({ subtotalIdr: 0, discountIdr: 0, taxRateBps: 1000 }),
      { discountIdr: 0, taxIdr: 0, totalIdr: 0 },
    );
    assert.deepEqual(
      discountPreview({ subtotalIdr: 0, discountIdr: 5000, taxRateBps: 1000 }),
      { discountIdr: 0, taxIdr: 0, totalIdr: 0 },
    );
  });

  test("invariants over a grid: integers, discount within 0..subtotal, total = subtotal - discount + tax, total never above the undiscounted bill", async () => {
    const { discountPreview } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    for (const subtotalIdr of [0, 1, 7, 999, 33333, 200000]) {
      for (const discountIdr of [-100, 0, 1, 500, 33333, 200000, 999999]) {
        for (const taxRateBps of [0, 1000, 1100, 1250]) {
          const r = discountPreview({ subtotalIdr, discountIdr, taxRateBps });
          const label = JSON.stringify({
            subtotalIdr,
            discountIdr,
            taxRateBps,
          });
          assert.ok(
            Number.isInteger(r.discountIdr) &&
              Number.isInteger(r.taxIdr) &&
              Number.isInteger(r.totalIdr),
            label,
          );
          assert.ok(
            r.discountIdr >= 0 && r.discountIdr <= subtotalIdr,
            `discount ${label}`,
          );
          assert.ok(r.taxIdr >= 0, `tax ${label}`);
          assert.equal(
            r.totalIdr,
            subtotalIdr - r.discountIdr + r.taxIdr,
            `total ${label}`,
          );
          assert.ok(r.totalIdr >= 0, `non-negative ${label}`);
          const undiscounted = discountPreview({
            subtotalIdr,
            discountIdr: 0,
            taxRateBps,
          });
          assert.ok(
            r.totalIdr <= undiscounted.totalIdr,
            `not above undiscounted ${label}`,
          );
        }
      }
    }
  });
});
