// legend-ktpc0 (U5b S31): the journal detail screen hides "Setujui dan bukukan"
// from the person who requested the journal (AUTH-06, display only; the API
// decides). Pure helpers in ws07-accounting/lib.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canApproveManualJournal,
  isManualJournalRequester,
} from "../apps/web/src/features/ws07-accounting/lib.ts";

const pending = { status: "pending_approval", requestedBy: "user-finance" };

test("the requester is recognised by user id", () => {
  assert.equal(isManualJournalRequester(pending, "user-finance"), true);
  assert.equal(isManualJournalRequester(pending, "user-owner"), false);
});

test("an unknown viewer is never treated as the requester", () => {
  assert.equal(isManualJournalRequester(pending, undefined), false);
});

test("the requester cannot approve their own pending journal", () => {
  assert.equal(canApproveManualJournal(pending, "user-finance"), false);
});

test("another person can approve a pending journal", () => {
  assert.equal(canApproveManualJournal(pending, "user-owner"), true);
});

test("without a session id the button is not hidden (the API still decides)", () => {
  assert.equal(canApproveManualJournal(pending, undefined), true);
});

test("no one is offered approval outside the pending status", () => {
  for (const status of ["draft", "rejected", "posted", "cancelled"])
    assert.equal(
      canApproveManualJournal(
        { status, requestedBy: "user-finance" },
        "user-owner",
      ),
      false,
      status,
    );
});
