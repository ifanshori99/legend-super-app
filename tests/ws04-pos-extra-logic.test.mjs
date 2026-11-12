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

// ====================================================================
// Audit fix (brief sub-539-u2-audit-fix, T2). Money rule: no party is paid
// more than was paid in, and an uncertain result is never retried as a new
// request. Tests for E/F target helpers or signatures
// that the E/F fixes add; they were written from the brief, then aligned to
// the signatures the coordinator reported.
// ====================================================================

// ---------------------------------------------------------------- I1 refundableIdr / refundAmountIssue
describe("I1 correction-logic: refundableIdr", () => {
  test("paid minus already refunded", async () => {
    const { refundableIdr } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.equal(refundableIdr({ paidIdr: 100000, refundedIdr: 30000 }), 70000);
    assert.equal(refundableIdr({ paidIdr: 100000, refundedIdr: 0 }), 100000);
  });

  test("fully refunded leaves nothing", async () => {
    const { refundableIdr } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.equal(refundableIdr({ paidIdr: 100000, refundedIdr: 100000 }), 0);
  });

  test("never negative and never above what was paid", async () => {
    const { refundableIdr } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.equal(refundableIdr({ paidIdr: 50000, refundedIdr: 80000 }), 0);
    for (const paidIdr of [0, 1, 50000, 999999]) {
      for (const refundedIdr of [0, 1, 25000, 999999, 2000000]) {
        const r = refundableIdr({ paidIdr, refundedIdr });
        assert.ok(Number.isInteger(r) && r >= 0 && r <= paidIdr);
      }
    }
  });

  test("fractional or negative input throws RangeError", async () => {
    const { refundableIdr } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.throws(
      () => refundableIdr({ paidIdr: 100.5, refundedIdr: 0 }),
      RangeError,
    );
    assert.throws(
      () => refundableIdr({ paidIdr: 100, refundedIdr: -1 }),
      RangeError,
    );
  });
});

describe("I1 correction-logic: refundAmountIssue", () => {
  test("an amount within what is available is allowed (up to the exact limit)", async () => {
    const { refundAmountIssue } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.equal(
      refundAmountIssue({ amountIdr: 50000, availableIdr: 100000 }),
      null,
    );
    assert.equal(
      refundAmountIssue({ amountIdr: 100000, availableIdr: 100000 }),
      null,
    );
  });

  test("one rupiah above what is available is over (never more than total paid)", async () => {
    const { refundAmountIssue } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.equal(
      refundAmountIssue({ amountIdr: 100001, availableIdr: 100000 }),
      "over",
    );
    assert.equal(refundAmountIssue({ amountIdr: 1, availableIdr: 0 }), "over");
  });

  test("empty, zero, negative or fractional amounts are 'empty'", async () => {
    const { refundAmountIssue } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    for (const amountIdr of [null, 0, -5000, 1000.5, Number.NaN]) {
      assert.equal(
        refundAmountIssue({ amountIdr, availableIdr: 100000 }),
        "empty",
        String(amountIdr),
      );
    }
  });

  test("combined with refundableIdr: an amount above the cap is never allowed", async () => {
    const { refundAmountIssue, refundableIdr } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    const availableIdr = refundableIdr({ paidIdr: 100000, refundedIdr: 40000 });
    assert.equal(refundAmountIssue({ amountIdr: 60000, availableIdr }), null);
    assert.equal(refundAmountIssue({ amountIdr: 60001, availableIdr }), "over");
  });
});

// ---------------------------------------------------------------- I1 percent discount / approval
describe("I1 correction-logic: percentDiscountIdr (floor)", () => {
  test("a whole result is exact", async () => {
    const { percentDiscountIdr } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.equal(
      percentDiscountIdr({ subtotalIdr: 200000, percentBp: 1000 }),
      20000,
    );
  });

  test("fractions round DOWN, never up (outlet never gives more than the percent)", async () => {
    const { percentDiscountIdr } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    // 100001 * 10% = 10000.1 -> 10000
    assert.equal(
      percentDiscountIdr({ subtotalIdr: 100001, percentBp: 1000 }),
      10000,
    );
    // 999 * 12.5% = 124.875 -> 124 (not 125)
    assert.equal(
      percentDiscountIdr({ subtotalIdr: 999, percentBp: 1250 }),
      124,
    );
    // 1 * 99.99% = 0.9999 -> 0
    assert.equal(percentDiscountIdr({ subtotalIdr: 1, percentBp: 9999 }), 0);
  });

  test("0 percent gives 0 and 100 percent gives the whole subtotal; above 100 is capped", async () => {
    const { percentDiscountIdr } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.equal(percentDiscountIdr({ subtotalIdr: 50000, percentBp: 0 }), 0);
    assert.equal(
      percentDiscountIdr({ subtotalIdr: 50000, percentBp: 10000 }),
      50000,
    );
    assert.equal(
      percentDiscountIdr({ subtotalIdr: 50000, percentBp: 15000 }),
      50000,
    );
  });

  test("result is an integer between 0 and the subtotal over a grid", async () => {
    const { percentDiscountIdr } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    for (const subtotalIdr of [0, 1, 333, 99999, 123457]) {
      for (const percentBp of [0, 1, 750, 3333, 9999, 10000]) {
        const r = percentDiscountIdr({ subtotalIdr, percentBp });
        assert.ok(Number.isInteger(r) && r >= 0 && r <= subtotalIdr);
        assert.ok(r * 10000 <= subtotalIdr * percentBp, "never rounds up");
      }
    }
  });
});

describe("I1 correction-logic: discountNeedsApproval (cumulative manual discount)", () => {
  // The caller passes existing manual discounts + the new one as discountIdr
  // (the server sums them, per the audit brief E2). Threshold 1000bp of
  // 200000 = 20000.
  test("exactly at the threshold needs no approval; one rupiah above does", async () => {
    const { discountNeedsApproval } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    const base = { subtotalIdr: 200000, thresholdBp: 1000 };
    assert.equal(discountNeedsApproval({ ...base, discountIdr: 20000 }), false);
    assert.equal(discountNeedsApproval({ ...base, discountIdr: 20001 }), true);
  });

  test("two small discounts that add up above the threshold need approval", async () => {
    const { discountNeedsApproval } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    const base = { subtotalIdr: 200000, thresholdBp: 1000 };
    const existingManualIdr = 15000;
    const proposedIdr = 10000;
    assert.equal(
      discountNeedsApproval({ ...base, discountIdr: proposedIdr }),
      false,
      "the new discount alone is under the threshold",
    );
    assert.equal(
      discountNeedsApproval({
        ...base,
        discountIdr: existingManualIdr + proposedIdr,
      }),
      true,
      "cumulative 25000 is above 20000",
    );
  });

  test("zero discount never needs approval; zero threshold needs it for any discount", async () => {
    const { discountNeedsApproval } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.equal(
      discountNeedsApproval({
        subtotalIdr: 200000,
        discountIdr: 0,
        thresholdBp: 1000,
      }),
      false,
    );
    assert.equal(
      discountNeedsApproval({
        subtotalIdr: 200000,
        discountIdr: 1,
        thresholdBp: 0,
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------- I2 chargeFailureKind
describe("I2 charge-logic: chargeFailureKind", () => {
  test("network drop (0), timeout (408), conflict (409) and every 5xx are uncertain", async () => {
    const { chargeFailureKind } = await load(
      "ws04-pos-order-detail/charge-logic.ts",
    );
    for (const status of [0, 408, 409, 500, 502, 503, 504, 599]) {
      assert.equal(chargeFailureKind(status), "unknown", String(status));
    }
  });

  test("a definite refusal (4xx other than 408/409) is a plain failure", async () => {
    const { chargeFailureKind } = await load(
      "ws04-pos-order-detail/charge-logic.ts",
    );
    for (const status of [400, 401, 403, 404, 410, 422, 429]) {
      assert.equal(chargeFailureKind(status), "failed", String(status));
    }
  });
});

// ---------------------------------------------------------------- I1 correction idempotency after an uncertain failure
// Signatures (from the E fix): correctionFailureKind(status) is "uncertain" for
// 0, 408, 409 and >= 500, else "rejected";
// nextIdempotencyKey(prev {fingerprint,key} | null, fingerprint, lastFailure,
// makeKey) keeps prev when the fingerprint is the same or the last failure was
// uncertain, otherwise returns { fingerprint, key: makeKey() }.
describe("I1 correction-logic: correctionFailureKind", () => {
  test("network drop (0), timeout (408), conflict (409) and every 5xx are uncertain", async () => {
    const { correctionFailureKind } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    for (const status of [0, 408, 409, 500, 502, 503, 504, 599]) {
      assert.equal(correctionFailureKind(status), "uncertain", String(status));
    }
  });

  test("a definite 4xx refusal is rejected", async () => {
    const { correctionFailureKind } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    for (const status of [400, 401, 403, 404, 410, 422, 429]) {
      assert.equal(correctionFailureKind(status), "rejected", String(status));
    }
  });
});

describe("I1 correction-logic: nextIdempotencyKey", () => {
  const counter = () => {
    let n = 0;
    return () => `key-${++n}`;
  };

  test("first send makes a new key for the form", async () => {
    const { nextIdempotencyKey } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    assert.deepEqual(nextIdempotencyKey(null, "a", null, counter()), {
      fingerprint: "a",
      key: "key-1",
    });
  });

  test("same form resent keeps its key and does not mint a new one", async () => {
    const { nextIdempotencyKey } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    const prev = { fingerprint: "a", key: "key-0" };
    let minted = 0;
    const makeKey = () => `key-${++minted}`;
    for (const lastFailure of [null, "uncertain", "rejected"]) {
      assert.equal(nextIdempotencyKey(prev, "a", lastFailure, makeKey), prev);
    }
    assert.equal(minted, 0);
  });

  test("after an UNCERTAIN failure an edited form keeps the SAME key (no second refund)", async () => {
    const { nextIdempotencyKey } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    const prev = { fingerprint: "amount=50000;note=a", key: "key-0" };
    const next = nextIdempotencyKey(
      prev,
      "amount=50000;note=edited",
      "uncertain",
      counter(),
    );
    assert.equal(next.key, "key-0");
  });

  test("after a definite rejection an edited form gets a new key", async () => {
    const { nextIdempotencyKey } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    const prev = { fingerprint: "a", key: "key-0" };
    assert.deepEqual(nextIdempotencyKey(prev, "b", "rejected", counter()), {
      fingerprint: "b",
      key: "key-1",
    });
  });

  test("a changed form with no failure yet gets a new key", async () => {
    const { nextIdempotencyKey } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    const prev = { fingerprint: "a", key: "key-0" };
    assert.equal(nextIdempotencyKey(prev, "b", null, counter()).key, "key-1");
  });

  test("end to end: statuses map to the key outcome for an edited resend", async () => {
    const { correctionFailureKind, nextIdempotencyKey } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    const prev = { fingerprint: "a", key: "key-0" };
    for (const status of [0, 408, 409, 500, 503]) {
      const next = nextIdempotencyKey(
        prev,
        "b",
        correctionFailureKind(status),
        counter(),
      );
      assert.equal(next.key, "key-0", `status ${status}`);
    }
    for (const status of [400, 403, 404, 422]) {
      const next = nextIdempotencyKey(
        prev,
        "b",
        correctionFailureKind(status),
        counter(),
      );
      assert.notEqual(next.key, "key-0", `status ${status}`);
    }
  });

  test("the key stays across repeated uncertain failures", async () => {
    const { nextIdempotencyKey } = await load(
      "ws04-pos-correction/correction-logic.ts",
    );
    let intent = nextIdempotencyKey(null, "a", null, counter());
    const first = intent.key;
    for (const fingerprint of ["b", "c", "a", "d"]) {
      intent = nextIdempotencyKey(intent, fingerprint, "uncertain", counter());
    }
    assert.equal(intent.key, first);
  });
});

// ---------------------------------------------------------------- I4 displayBalance
describe("I4 display lib: displayBalance", () => {
  const display = (overrides = {}) => ({
    state: "awaiting_payment",
    totalIdr: "100000",
    qris: null,
    tenders: [],
    ...overrides,
  });

  test("paid: nothing remaining", async () => {
    const { displayBalance } = await load("ws04-display/lib.ts");
    const b = displayBalance(
      display({
        state: "paid",
        tenders: [{ method: "cash", amountIdr: "100000" }],
      }),
    );
    assert.equal(b.remainingIdr, 0);
    assert.equal(b.capturedIdr, 100000);
  });

  test("QRIS amount below the total shows that amount as remaining", async () => {
    const { displayBalance } = await load("ws04-display/lib.ts");
    const b = displayBalance(
      display({ qris: { amountIdr: "40000" }, tenders: [] }),
    );
    assert.equal(b.remainingIdr, 40000);
  });

  test("remaining is never above the total, even if the QRIS amount is", async () => {
    const { displayBalance } = await load("ws04-display/lib.ts");
    const b = displayBalance(display({ qris: { amountIdr: "250000" } }));
    assert.equal(b.remainingIdr, 100000);
  });

  test("remaining is never negative, even for a bad QRIS amount", async () => {
    const { displayBalance } = await load("ws04-display/lib.ts");
    const b = displayBalance(display({ qris: { amountIdr: "-5000" } }));
    assert.ok(b.remainingIdr === null || b.remainingIdr >= 0);
  });

  test("amount not known yet: null, never a guessed smaller number", async () => {
    const { displayBalance } = await load("ws04-display/lib.ts");
    assert.equal(displayBalance(display()).remainingIdr, null);
    assert.equal(
      displayBalance(display({ state: "building" })).remainingIdr,
      null,
    );
  });

  test("captured tenders are summed; deposit is 0 (display has no deposit field)", async () => {
    const { displayBalance } = await load("ws04-display/lib.ts");
    const b = displayBalance(
      display({
        tenders: [
          { method: "cash", amountIdr: "30000" },
          { method: "qris", amountIdr: "20000" },
        ],
      }),
    );
    assert.equal(b.capturedIdr, 50000);
    assert.equal(b.depositIdr, 0);
  });
});

// ---------------------------------------------------------------- sub-539-u2 displayPayMode
// Money rule (founder, 12 Nov): the display QRIS is always the full total, so
// an order with a DP must never show a QR; the customer pays at the cashier.
describe("sub-539-u2 display lib: displayPayMode", () => {
  const TOTAL = 100000;
  const display = (overrides = {}) => ({
    state: "awaiting_payment",
    totalIdr: String(TOTAL),
    qris: null,
    tenders: [],
    ...overrides,
  });
  const qrisPresent = () => ({ amountIdr: String(TOTAL) });
  const known = (depositAppliedIdr) => ({ kind: "known", depositAppliedIdr });

  test("any state other than awaiting_payment is not_paying", async () => {
    const { displayPayMode } = await load("ws04-display/lib.ts");
    for (const state of ["idle", "ordering", "paid"]) {
      for (const deposit of [
        known(0),
        known(50000),
        { kind: "loading" },
        { kind: "unknown" },
      ]) {
        assert.equal(
          displayPayMode(display({ state, qris: qrisPresent() }), deposit),
          "not_paying",
          `${state} / ${deposit.kind}`,
        );
      }
    }
  });

  test("known deposit 0 with a QRIS present shows qris", async () => {
    const { displayPayMode } = await load("ws04-display/lib.ts");
    assert.equal(
      displayPayMode(display({ qris: qrisPresent() }), known(0)),
      "qris",
    );
  });

  test("known deposit 0 without a QRIS yet is loading", async () => {
    const { displayPayMode } = await load("ws04-display/lib.ts");
    assert.equal(displayPayMode(display({ qris: null }), known(0)), "loading");
  });

  test("known deposit above 0 is pay_at_cashier even when a QRIS is present", async () => {
    const { displayPayMode } = await load("ws04-display/lib.ts");
    assert.equal(
      displayPayMode(display({ qris: qrisPresent() }), known(50000)),
      "pay_at_cashier",
    );
    assert.equal(
      displayPayMode(display({ qris: null }), known(50000)),
      "pay_at_cashier",
    );
  });

  test("unknown deposit (order read failed) is pay_at_cashier", async () => {
    const { displayPayMode } = await load("ws04-display/lib.ts");
    assert.equal(
      displayPayMode(display({ qris: qrisPresent() }), { kind: "unknown" }),
      "pay_at_cashier",
    );
    assert.equal(
      displayPayMode(display({ qris: null }), { kind: "unknown" }),
      "pay_at_cashier",
    );
  });

  test("loading deposit is loading, never qris, even with a QRIS present", async () => {
    const { displayPayMode } = await load("ws04-display/lib.ts");
    assert.equal(
      displayPayMode(display({ qris: qrisPresent() }), { kind: "loading" }),
      "loading",
    );
    assert.equal(
      displayPayMode(display({ qris: null }), { kind: "loading" }),
      "loading",
    );
  });

  test("property: every deposit above 0 (or not a number) never yields qris", async () => {
    const { displayPayMode } = await load("ws04-display/lib.ts");
    const deposits = [1, 50000, TOTAL, TOTAL + 1, Number.NaN];
    for (const depositAppliedIdr of deposits) {
      for (const qris of [null, qrisPresent()]) {
        const mode = displayPayMode(
          display({ qris }),
          known(depositAppliedIdr),
        );
        assert.notEqual(mode, "qris", `deposit ${depositAppliedIdr}`);
        assert.equal(mode, "pay_at_cashier", `deposit ${depositAppliedIdr}`);
      }
    }
  });

  test("property: unknown and loading deposits never yield qris", async () => {
    const { displayPayMode } = await load("ws04-display/lib.ts");
    for (const deposit of [{ kind: "unknown" }, { kind: "loading" }]) {
      for (const qris of [null, qrisPresent()]) {
        assert.notEqual(
          displayPayMode(display({ qris }), deposit),
          "qris",
          deposit.kind,
        );
      }
    }
  });

  test("property: deposit 0 with a QRIS is always qris", async () => {
    const { displayPayMode } = await load("ws04-display/lib.ts");
    for (const amountIdr of ["1", "40000", String(TOTAL)]) {
      assert.equal(
        displayPayMode(display({ qris: { amountIdr } }), known(0)),
        "qris",
      );
    }
  });
});

// ---------------------------------------------------------------- I5 bookVarianceIdr
// Booked variance mirrors the API: physical variance + held correction
// (held refund/void cash). Held CASH-OUT expires at close and is never added
// (coordinator note: bookVarianceIdr(physicalVarianceIdr, heldCorrectionIdr)).
describe("I5 shift-extra-logic: bookVarianceIdr", () => {
  test("no held correction: booked variance is the physical variance", async () => {
    const { bookVarianceIdr } = await load(
      "ws04-pos-kasir/shift-extra-logic.ts",
    );
    assert.equal(bookVarianceIdr(-20000, 0), -20000);
    assert.equal(bookVarianceIdr(15000, 0), 15000);
    assert.equal(bookVarianceIdr(0, 0), 0);
  });

  test("held correction is added to the physical variance", async () => {
    const { bookVarianceIdr } = await load(
      "ws04-pos-kasir/shift-extra-logic.ts",
    );
    assert.equal(bookVarianceIdr(-20000, 5000), -15000);
  });

  test("held cash-out is not an input: -20000 with 200000 held cash-out books -20000, not +180000", async () => {
    const { bookVarianceIdr, heldTotalIdr } = await load(
      "ws04-pos-kasir/shift-extra-logic.ts",
    );
    const heldCashOutIdr = heldTotalIdr([{ amountIdr: 200000 }]);
    assert.equal(heldCashOutIdr, 200000);
    // Contract has no held correction yet: it is taken as 0, not the cash-out.
    assert.equal(bookVarianceIdr(-20000, 0), -20000);
    assert.notEqual(bookVarianceIdr(-20000, 0), -20000 + heldCashOutIdr);
  });

  test("a shortage with no held correction stays a shortage", async () => {
    const { bookVarianceIdr } = await load(
      "ws04-pos-kasir/shift-extra-logic.ts",
    );
    assert.ok(bookVarianceIdr(-50000, 0) < 0);
  });

  test("fractional or negative held correction throws RangeError", async () => {
    const { bookVarianceIdr } = await load(
      "ws04-pos-kasir/shift-extra-logic.ts",
    );
    assert.throws(() => bookVarianceIdr(100.5, 0), RangeError);
    assert.throws(() => bookVarianceIdr(100, -1), RangeError);
  });
});

// ---------------------------------------------------------------- I4 sessionFromOrder / printReceipt
// SKIPPED on purpose: `sessionFromOrder` is not exported and `printReceipt`
// lives in ws04-pos-kasir/api.ts, which imports `@/lib/api/*` (path alias) and
// the typed client, so plain Node cannot load it without a bundler/DOM stub.
// The DP arithmetic they use is covered above by remainingToPayIdr and
// isSettledByDeposit ("DP lunas"). "Complete the order only when remaining is
// 0" needs a browser/e2e or vitest-with-alias test, not this suite.
