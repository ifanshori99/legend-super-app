// WS-08 CRM squad front ends (beads legend-i026, legend-hbad, legend-e8oa,
// legend-xm4y): the pure helpers behind the screens and the copy they show.
// Runs with the root node:test suite (Node type stripping, no browser); the
// screens themselves are covered by the e2e/legend-*.mock.spec.ts files.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  depositToken,
  submitProblemOf,
} from "../apps/web/src/features/ws08-reservation-customer/lib.ts";
import { sendStatusCounts } from "../apps/web/src/features/ws08-crm-campaigns/lib.ts";
import { crm360Messages } from "../packages/shared/src/i18n/messages/ws08-crm-360.ts";
import { crmCampaignsMessages } from "../packages/shared/src/i18n/messages/ws08-crm-campaigns.ts";
import { deliveryOpsMessages } from "../packages/shared/src/i18n/messages/ws08-delivery.ts";
import { reservationBookingMessages } from "../packages/shared/src/i18n/messages/ws08-reservation-customer.ts";

function strings(value, path = "") {
  if (typeof value === "string") return [[path, value]];
  return Object.entries(value).flatMap(([key, child]) =>
    strings(child, path ? `${path}.${key}` : key),
  );
}

describe("legend-xm4y guest booking", () => {
  test("RSV-02 the DP handoff only accepts an app-local /bayar/<token> path", () => {
    assert.equal(depositToken("/bayar/pl_pending_7b6d"), "pl_pending_7b6d");
    for (const path of [
      "https://evil.example/bayar/x",
      "//evil.example/bayar/x",
      "/bayar/x/../../masuk",
      "/bayar/",
      "/bayar/a?next=//evil",
    ])
      assert.equal(depositToken(path), null, path);
  });

  test("RSV-01 a 409 the guest cannot fix by resending gets its own problem", () => {
    const error = (code) => Object.assign(new Error(code), { code });
    assert.equal(submitProblemOf(error("RESERVATION_SLOT_TAKEN")), "slot");
    assert.equal(
      submitProblemOf(error("RESERVATION_SLOT_UNAVAILABLE")),
      "slot",
    );
    assert.equal(
      submitProblemOf(error("RESERVATION_PACKAGE_UNAVAILABLE")),
      "package",
    );
    assert.equal(
      submitProblemOf(error("WAITLIST_DUPLICATE_ENTRY")),
      "duplicate",
    );
    assert.equal(submitProblemOf(error("RATE_LIMITED")), "rateLimited");
    // Network or server trouble is retryable with the same Idempotency-Key.
    assert.equal(submitProblemOf(error("SERVICE_UNAVAILABLE")), "retry");
    assert.equal(submitProblemOf(new TypeError("fetch failed")), "retry");
    assert.equal(submitProblemOf(null), "retry");
  });
});

describe("legend-hbad campaign results", () => {
  test("LOY-04 the send-status rows add back up to the campaign recipients", () => {
    const results = {
      recipients: 400,
      sent: 330,
      delivered: 321,
      failed: 9,
      skippedNoConsent: 12,
    };
    const counts = sendStatusCounts(results);
    assert.deepEqual(counts, {
      queued: 58,
      sent: 0,
      delivered: 321,
      failed: 9,
      skipped_no_consent: 12,
    });
    assert.equal(
      Object.values(counts).reduce((total, n) => total + n, 0),
      results.recipients,
    );
  });
});

describe("WS-08 squad copy", () => {
  test("user-facing text carries no internal ids, permission codes or brand names", () => {
    const catalogs = {
      crm360: crm360Messages,
      crmCampaigns: crmCampaignsMessages,
      deliveryOps: deliveryOpsMessages,
      reservationBooking: reservationBookingMessages,
    };
    // PRD acceptance ids (LOY-04, AI-11, RSV-02), decision ids (D12),
    // permission codes (review.respond, crm.segment.manage) and the demo
    // tenant's brand (TEN-08) belong in code comments, never in the UI.
    const internal =
      /\b(?:LOY|AI|RSV|ORD|TEN)-\d+\b|\(D\d+\)|\b[a-z]+\.[a-z_]+(?:\.[a-z_]+)?\b|Cafe Legend/;
    const leaks = Object.entries(catalogs).flatMap(([name, catalog]) =>
      strings(catalog, name).filter(([, text]) => internal.test(text)),
    );
    assert.deepEqual(leaks, []);
  });

  test("the review summary is not labelled as AI output (no AI service yet)", () => {
    assert.doesNotMatch(crm360Messages.ai.title, /AI/);
    assert.doesNotMatch(crm360Messages.ai.badge, /AI/);
  });
});
