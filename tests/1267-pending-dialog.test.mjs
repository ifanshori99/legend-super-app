// Gelombang 2 F7 (brief 1267): dialogs that submit a request refuse to close
// while it is in flight, and money/schedule dialogs keep their attempt key
// when reopened after a failure.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  blockWhilePending,
  guardOpenChange,
} from "../apps/web/src/components/ui/pending-dialog-logic.ts";
import {
  clearRetainedAttempt,
  retainedAttempt,
} from "../apps/web/src/lib/retained-attempt-key.ts";

test("guardOpenChange ignores close while pending but never blocks open", () => {
  const calls = [];
  const pending = guardOpenChange(true, (open) => calls.push(open));
  pending(false);
  pending(true);
  assert.deepEqual(calls, [true]);
  const idle = guardOpenChange(false, (open) => calls.push(open));
  idle(false);
  assert.deepEqual(calls, [true, false]);
});

test("blockWhilePending cancels Esc and outside click only while pending", () => {
  let prevented = 0;
  let passed = 0;
  const event = { preventDefault: () => prevented++ };
  blockWhilePending(true, () => passed++)(event);
  assert.equal(prevented, 1);
  assert.equal(passed, 0);
  blockWhilePending(false, () => passed++)(event);
  assert.equal(prevented, 1);
  assert.equal(passed, 1);
});

test("a retained attempt key survives closing and reopening until it settles", () => {
  clearRetainedAttempt();
  const payload = { paymentId: "p1", amount: 5000 };
  const first = retainedAttempt("refund.create").keyFor(payload);
  // Dialog closed after a lost response, then opened again: same request.
  assert.equal(retainedAttempt("refund.create").keyFor({ ...payload }), first);
  // A changed request is a new attempt; other scopes never share a key.
  assert.notEqual(
    retainedAttempt("refund.create").keyFor({ ...payload, amount: 6000 }),
    first,
  );
  assert.notEqual(retainedAttempt("refund.approve").keyFor(payload), first);
  retainedAttempt("refund.create").settle();
  assert.notEqual(retainedAttempt("refund.create").keyFor(payload), first);
});

const features = "apps/web/src/features/";
const wired = [
  "ws10-roster/components/publish-dialog.tsx",
  "ws05-payment-admin/components/refunds-panel.tsx",
  "ws05-payment-admin/components/refund-followup-dialog.tsx",
  "ws05-payment-admin/components/reconciliation-panel.tsx",
  "ws05-payment-admin/components/edc-panel.tsx",
  "ws05-payment-admin/components/unallocated-panel.tsx",
  "ws10-payroll-payout/components/freeze-banner.tsx",
  "facility-admin/components/products-tab.tsx",
  "facility-admin/components/addons-tab.tsx",
  "facility-admin/components/subscriptions-tab.tsx",
  "facility-admin/components/areas-tab.tsx",
];
for (const file of wired) {
  test(`${file} uses the pending-aware dialog`, () => {
    const source = readFileSync(features + file, "utf8");
    assert.match(source, /PendingDialogContent/);
    assert.match(source, /<PendingDialog\b[^>]*\bpending=/s);
    assert.doesNotMatch(source, /<Dialog\b/);
  });
}

test("kasbon, reimbursement and roster publish no longer mint a key per click", () => {
  for (const file of [
    "ws10-payslip/components/kasbon-page.tsx",
    "ws10-payslip/components/reimbursement-page.tsx",
  ]) {
    const source = readFileSync(features + file, "utf8");
    assert.match(source, /useAttemptKey\(\)/);
    assert.match(source, /attempt\.keyFor\(body\)/);
    assert.match(source, /attempt\.settle\(\)/);
    assert.doesNotMatch(source, /newIdempotencyKey/);
  }
  const roster = readFileSync(
    features + "ws10-roster/components/roster-page.tsx",
    "utf8",
  );
  assert.match(roster, /retainedAttempt\("roster\.publish"\)/);
  assert.doesNotMatch(roster, /publishKey/);
});
