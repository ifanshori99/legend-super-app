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
  retainedOwnerKey,
} from "../apps/web/src/lib/retained-attempt-key.ts";
import { publishAttemptPayload } from "../apps/web/src/features/ws10-roster/publish-key.ts";

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
  const first = retainedAttempt("refund.create", "").keyFor(payload);
  // Dialog closed after a lost response, then opened again: same request.
  assert.equal(
    retainedAttempt("refund.create", "").keyFor({ ...payload }),
    first,
  );
  // A changed request is a new attempt; other scopes never share a key.
  assert.notEqual(
    retainedAttempt("refund.create", "").keyFor({ ...payload, amount: 6000 }),
    first,
  );
  assert.notEqual(retainedAttempt("refund.approve", "").keyFor(payload), first);
  retainedAttempt("refund.create", "").settle();
  assert.notEqual(retainedAttempt("refund.create", "").keyFor(payload), first);
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
  assert.match(roster, /useRetainedAttempt\("roster\.publish"\)/);
  assert.doesNotMatch(roster, /publishKey/);
});

// Gelombang 3 H2.
test("retained attempts are scoped by tenant, user and outlet reach", () => {
  clearRetainedAttempt();
  const payload = { paymentId: "p1" };
  const a = retainedOwnerKey({
    tenant: "t1",
    userId: "u1",
    outletIds: ["o2", "o1"],
  });
  const same = retainedOwnerKey({
    tenant: "t1",
    userId: "u1",
    outletIds: ["o1", "o2"],
  });
  assert.equal(a, same);
  const key = retainedAttempt("refund.create", a).keyFor(payload);
  assert.equal(retainedAttempt("refund.create", same).keyFor(payload), key);
  for (const other of [
    { tenant: "t2", userId: "u1", outletIds: ["o1", "o2"] },
    { tenant: "t1", userId: "u2", outletIds: ["o1", "o2"] },
    { tenant: "t1", userId: "u1", outletIds: ["o1"] },
  ]) {
    assert.notEqual(
      retainedAttempt("refund.create", retainedOwnerKey(other)).keyFor(payload),
      key,
    );
  }
  clearRetainedAttempt();
  assert.notEqual(retainedAttempt("refund.create", a).keyFor(payload), key);
});

test("the roster publish key follows the sorted draft content", () => {
  const draft = (id, over = {}) => ({
    id,
    status: "draft",
    employeeId: "e1",
    businessDate: "2026-11-23",
    shiftTemplateId: "s1",
    segments: [{ startsAt: "08:00", endsAt: "16:00" }],
    ...over,
  });
  const base = { outletId: "o1", weekStart: "2026-11-23" };
  const one = publishAttemptPayload({
    ...base,
    rows: [draft("a"), draft("b")],
  });
  assert.equal(
    JSON.stringify(one),
    JSON.stringify(
      publishAttemptPayload({ ...base, rows: [draft("b"), draft("a")] }),
    ),
  );
  const edited = publishAttemptPayload({
    ...base,
    rows: [draft("a", { shiftTemplateId: "s2" }), draft("b")],
  });
  assert.notEqual(JSON.stringify(edited), JSON.stringify(one));
  // Published rows are not part of what this publish sends.
  const withPublished = publishAttemptPayload({
    ...base,
    rows: [draft("a"), draft("b"), draft("c", { status: "published" })],
  });
  assert.equal(JSON.stringify(withPublished), JSON.stringify(one));
});

test("H2 wiring: owner-scoped keys, per-payment refund scope, per-refund mutation key, sign-out clears", () => {
  const read = (path) => readFileSync("apps/web/src/" + path, "utf8");
  const refunds = read(
    "features/ws05-payment-admin/components/refunds-panel.tsx",
  );
  assert.match(refunds, /refund\.create\.\$\{/);
  assert.doesNotMatch(refunds, /"refund\.create"/);
  const followup = read(
    "features/ws05-payment-admin/components/refund-followup-dialog.tsx",
  );
  assert.doesNotMatch(followup, /useIsMutating\(\)/);
  assert.match(followup, /useIsMutating\(\{\s*mutationKey:/);
  assert.match(
    read("components/sign-out-button.tsx"),
    /clearRetainedAttempt\(\)/,
  );
  const roster = read("features/ws10-roster/components/roster-page.tsx");
  assert.match(roster, /publishAttemptPayload\(/);
  assert.doesNotMatch(roster, /keyFor\(\{ outletId, weekStart \}\)/);
});
