// 539-U4 row F (legend-8r77t): the Owner's read_write support access request
// screen. Pure rules (sectioning, expiry, decision guard, error mapping) and
// the catalog/hook wiring of the screen files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import * as logic from "../apps/web/src/features/ws01-support-access/components/owner-logic.ts";
import { messagesId } from "../packages/shared/src/i18n/index.ts";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

const REQUESTED = "2026-11-11T02:15:00.000Z";
const DEADLINE = "2026-11-12T02:15:00.000Z"; // +24 hours
const at = (iso) => Date.parse(iso);

const request = (overrides = {}) => ({
  id: "req-1",
  superAdminUserId: "11111111-aaaa-bbbb-cccc-222222222222",
  reason: "Memperbaiki pengaturan integrasi yang gagal tersimpan.",
  accessMode: "read_write",
  durationMinutes: 30,
  requestedAt: REQUESTED,
  approvalExpiresAt: DEADLINE,
  status: "pending",
  decidedAt: null,
  decidedBy: null,
  grantId: null,
  ...overrides,
});

const grant = (overrides = {}) => ({
  id: "grant-1",
  startedAt: "2026-11-11T02:20:00.000Z",
  expiresAt: "2026-11-11T02:50:00.000Z",
  endedAt: null,
  ...overrides,
});

describe("539-U4-F owner support access requests", () => {
  test("a pending request is shown expired once its 24 hour window passes", () => {
    const pending = request();
    assert.equal(
      logic.displayRequestStatus(pending, at("2026-11-12T02:14:59.000Z")),
      "pending",
    );
    assert.equal(logic.displayRequestStatus(pending, at(DEADLINE)), "expired");
    assert.equal(
      logic.displayRequestStatus(
        request({ status: "rejected" }),
        at("2026-11-11T03:00:00.000Z"),
      ),
      "rejected",
    );
  });

  test("sections: pending, running grant, and history", () => {
    const now = at("2026-11-11T02:30:00.000Z");
    const rows = [
      request({ id: "p" }),
      request({
        id: "a",
        status: "approved",
        grantId: "grant-1",
        requestedAt: "2026-11-11T01:00:00.000Z",
        approvalExpiresAt: "2026-11-12T01:00:00.000Z",
      }),
      request({
        id: "r",
        status: "rejected",
        requestedAt: "2026-11-10T01:00:00.000Z",
        approvalExpiresAt: "2026-11-11T01:00:00.000Z",
      }),
      request({
        id: "x",
        requestedAt: "2026-11-09T01:00:00.000Z",
        approvalExpiresAt: "2026-11-10T01:00:00.000Z",
      }),
    ];
    const sections = logic.sectionRequests(rows, [grant()], now);
    assert.deepEqual(
      sections.pending.map((row) => row.id),
      ["p"],
    );
    assert.deepEqual(
      sections.active.map((entry) => entry.request.id),
      ["a"],
    );
    assert.deepEqual(
      sections.history.map((row) => [row.request.id, row.status]),
      [
        ["r", "rejected"],
        ["x", "expired"],
      ],
    );
  });

  test("an approved request whose grant ended or ran out is history, never active", () => {
    const approved = request({ status: "approved", grantId: "grant-1" });
    const later = at("2026-11-11T02:50:00.000Z");
    assert.equal(
      logic.sectionRequests([approved], [grant()], later).active.length,
      0,
    );
    const revoked = grant({ endedAt: "2026-11-11T02:25:00.000Z" });
    const sections = logic.sectionRequests(
      [approved],
      [revoked],
      at("2026-11-11T02:26:00.000Z"),
    );
    assert.equal(sections.active.length, 0);
    assert.equal(sections.history[0].status, "approved");
    // Grants not loaded (no match): fail closed, nothing offered for revoke.
    assert.equal(
      logic.sectionRequests([approved], [], at("2026-11-11T02:26:00.000Z"))
        .active.length,
      0,
    );
  });

  test("decisions stay off while impersonating, without 2FA, as a non-owner or offline", () => {
    const ok = { canDecide: true, reason: null };
    assert.equal(logic.decisionBlock(ok, true), null);
    assert.equal(logic.decisionBlock(ok, false), "offline");
    for (const reason of ["impersonating", "mfa_required", "not_owner"]) {
      assert.equal(
        logic.decisionBlock({ canDecide: false, reason }, true),
        reason,
      );
      assert.equal(
        logic.decisionBlock({ canDecide: false, reason }, false),
        reason,
      );
    }
    assert.equal(
      logic.decisionBlock({ canDecide: false, reason: null }, true),
      "not_owner",
    );
  });

  test("API refusals map to the matching explanation", () => {
    const err = (status, code) => ({ status, code });
    assert.equal(
      logic.decisionErrorKind(err(403, "IMPERSONATION_NOT_ALLOWED")),
      "impersonating",
    );
    assert.equal(logic.decisionErrorKind(err(403, "MFA_REQUIRED")), "mfa");
    assert.equal(logic.decisionErrorKind(err(0, "NETWORK_ERROR")), "offline");
    assert.equal(logic.decisionErrorKind(err(403, "SOMETHING")), "forbidden");
    assert.equal(logic.decisionErrorKind(err(409, "CONFLICT")), "conflict");
    assert.equal(logic.decisionErrorKind(new Error("boom")), "generic");
    assert.equal(logic.decisionErrorKind(undefined), "generic");
  });

  test("a refused revoke gets the clear 'not available for Owner' message", () => {
    assert.equal(
      logic.revokeErrorKind({ status: 403, code: "FORBIDDEN" }),
      "revokeUnavailable",
    );
    assert.equal(
      logic.revokeErrorKind({ status: 404, code: "NOT_FOUND" }),
      "revokeUnavailable",
    );
    assert.equal(
      logic.revokeErrorKind({ status: 0, code: "NETWORK_ERROR" }),
      "offline",
    );
    assert.equal(logic.revokeErrorKind(new Error("x")), "generic");
  });

  test("the list result is read from a cursor page or a bare array", () => {
    const rows = [request()];
    assert.equal(logic.requestsFromResult({ data: rows }).length, 1);
    assert.equal(logic.requestsFromResult(rows).length, 1);
    assert.equal(logic.requestsFromResult(undefined).length, 0);
  });

  test("every catalog key the screen files use exists in the catalog", () => {
    const files = [
      "owner-requests-page.tsx",
      "owner-request-card.tsx",
      "owner-active-card.tsx",
    ];
    const has = (key) =>
      key.split(".").reduce((node, part) => node?.[part], messagesId) !==
      undefined;
    for (const file of files) {
      const source = read(
        `../apps/web/src/features/ws01-support-access/components/${file}`,
      );
      for (const [, key] of source.matchAll(/"(supportAccessOwner\.[\w.]+)"/g))
        assert.ok(has(key), `${file}: missing ${key}`);
    }
  });

  test("the screen uses the shared hooks, offline guard and no raw colors", () => {
    const page = read(
      "../apps/web/src/features/ws01-support-access/components/owner-requests-page.tsx",
    );
    for (const name of [
      "useSupportAccessRequests",
      "useApproveSupportAccessRequest",
      "useRejectSupportAccessRequest",
      "useSupportDecisionGuard",
      "useEndSupportAccess",
      "useOnline",
    ])
      assert.match(page, new RegExp(name));
    for (const file of [
      "owner-requests-page.tsx",
      "owner-request-card.tsx",
      "owner-active-card.tsx",
    ]) {
      const source = read(
        `../apps/web/src/features/ws01-support-access/components/${file}`,
      );
      assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|\b(?:red|green|amber|gray|slate)-\d{2,3}\b/);
    }
  });
});
