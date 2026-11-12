// Platform restore screen pure logic (bead legend-nb4iy, Q40; mockup
// design/mockups/platform/restore-nb4iy.html). Loaded with native Node type
// stripping, like the source.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import {
  RESTORE_REASON_MAX,
  RESTORE_REASON_MIN,
  classifyRestoreError,
  formatRestoreDate,
  restoreView,
  validateRestoreReason,
} from "../apps/web/src/features/ws01-platform-tenants/restore-state.ts";

const tenantWindow = (over = {}) => ({
  status: "archived",
  archivedAt: "2026-11-01T03:00:00.000Z",
  restoreTo: "active",
  restorableUntil: "2026-12-01T03:00:00.000Z",
  restorable: true,
  ...over,
});
const outletWindow = (over = {}) => ({
  status: "closed",
  closedAt: "2026-11-01T03:00:00.000Z",
  restoreTo: "preopening",
  restorableUntil: "2026-12-01T03:00:00.000Z",
  restorable: true,
  ...over,
});

describe("restoreView", () => {
  test("archived tenant inside the window can be reviewed", () => {
    assert.deepEqual(restoreView("tenant", tenantWindow()), {
      kind: "restorable",
      restoreTo: "active",
      changedAt: "2026-11-01T03:00:00.000Z",
      restorableUntil: "2026-12-01T03:00:00.000Z",
    });
  });

  test("closed outlet reads closedAt and its own target status", () => {
    const view = restoreView("outlet", outletWindow());
    assert.equal(view.kind, "restorable");
    assert.equal(view.restoreTo, "preopening");
    assert.equal(view.changedAt, "2026-11-01T03:00:00.000Z");
  });

  test("a record that is not archived or closed has nothing to restore", () => {
    assert.equal(
      restoreView(
        "tenant",
        tenantWindow({ status: "active", restorable: false }),
      ).kind,
      "none",
    );
    assert.equal(
      restoreView(
        "outlet",
        outletWindow({ status: "active", restorable: false }),
      ).kind,
      "none",
    );
    // A tenant window never opens for an outlet status and the other way round.
    assert.equal(restoreView("outlet", tenantWindow()).kind, "none");
    assert.equal(restoreView("tenant", outletWindow()).kind, "none");
  });

  test("past 30 days the status is final and the confirm step stays closed", () => {
    const view = restoreView(
      "tenant",
      tenantWindow({
        archivedAt: "2026-10-01T03:00:00.000Z",
        restorableUntil: "2026-10-31T03:00:00.000Z",
        restorable: false,
      }),
    );
    assert.equal(view.kind, "expired");
    assert.equal(view.restorableUntil, "2026-10-31T03:00:00.000Z");
  });

  test("a missing change time keeps legacy rows final", () => {
    const view = restoreView(
      "outlet",
      outletWindow({
        closedAt: null,
        restoreTo: null,
        restorableUntil: null,
        restorable: false,
      }),
    );
    assert.deepEqual(view, {
      kind: "expired",
      changedAt: null,
      restorableUntil: null,
    });
  });

  test("closed outlet of an archived tenant is not final: restore the tenant first", () => {
    // Server answers restorable=false here, inside the outlet's own 30 days.
    const now = new Date("2026-11-12T00:00:00.000Z");
    const view = restoreView(
      "outlet",
      outletWindow({ restorable: false }),
      "archived",
      now,
    );
    assert.deepEqual(view, {
      kind: "parent_archived",
      changedAt: "2026-11-01T03:00:00.000Z",
      restorableUntil: "2026-12-01T03:00:00.000Z",
    });
  });

  test("an outlet past its own deadline stays expired, even under an archived tenant", () => {
    const view = restoreView(
      "outlet",
      outletWindow({
        restorable: false,
        restorableUntil: "2026-10-31T03:00:00.000Z",
      }),
      "archived",
      new Date("2026-11-12T00:00:00.000Z"),
    );
    assert.equal(view.kind, "expired");
  });

  test("parent status changes nothing for a restorable outlet or a tenant", () => {
    assert.equal(
      restoreView("outlet", outletWindow(), "active").kind,
      "restorable",
    );
    assert.equal(
      restoreView("tenant", tenantWindow({ restorable: false }), "archived")
        .kind,
      "expired",
    );
  });

  test("restorable without a target status is final, never a guess", () => {
    assert.equal(
      restoreView("tenant", tenantWindow({ restoreTo: null })).kind,
      "expired",
    );
  });
});

describe("validateRestoreReason", () => {
  test("bounds match the contract", () => {
    assert.equal(RESTORE_REASON_MIN, 10);
    assert.equal(RESTORE_REASON_MAX, 500);
  });

  test("rejects empty, whitespace-only and short reasons", () => {
    for (const text of ["", "   ", "pendek", "123456789", "  123456789  "])
      assert.deepEqual(validateRestoreReason(text), {
        ok: false,
        problem: "required",
      });
  });

  test("accepts 10 to 500 characters after trimming and returns the trimmed text", () => {
    assert.deepEqual(validateRestoreReason("  Salah arsip tenant  "), {
      ok: true,
      value: "Salah arsip tenant",
    });
    assert.equal(validateRestoreReason("a".repeat(10)).ok, true);
    assert.equal(validateRestoreReason("a".repeat(500)).ok, true);
  });

  test("rejects more than 500 characters", () => {
    assert.deepEqual(validateRestoreReason("a".repeat(501)), {
      ok: false,
      problem: "too_long",
    });
  });
});

describe("classifyRestoreError", () => {
  test("window closed while the form was open", () => {
    assert.equal(
      classifyRestoreError(new ApiError(409, "RESTORE_WINDOW_EXPIRED", "x")),
      "expired",
    );
  });

  test("not available: already restored or no longer available", () => {
    assert.equal(
      classifyRestoreError(new ApiError(409, "RESTORE_NOT_AVAILABLE", "x")),
      "not_available",
    );
    assert.equal(
      classifyRestoreError(
        new ApiError(409, "RESTORE_NOT_AVAILABLE", "x"),
        "outlet",
      ),
      "not_available",
    );
    assert.equal(
      classifyRestoreError(new ApiError(409, "INVALID_TRANSITION", "x")),
      "not_available",
    );
  });

  test("outlet INVALID_TRANSITION means the parent tenant is still archived", () => {
    assert.equal(
      classifyRestoreError(
        new ApiError(409, "INVALID_TRANSITION", "x"),
        "outlet",
      ),
      "parent_archived",
    );
  });

  test("only 401 and 403 are the security check", () => {
    for (const error of [
      new ApiError(403, "FORBIDDEN", "x"),
      new ApiError(401, "UNAUTHENTICATED", "x"),
    ])
      assert.equal(classifyRestoreError(error), "blocked");
  });

  test("offline and anything else", () => {
    assert.equal(
      classifyRestoreError(new ApiError(0, "NETWORK_ERROR", "x")),
      "network",
    );
    assert.equal(
      classifyRestoreError(new ApiError(500, "INTERNAL", "x")),
      "unknown",
    );
    assert.equal(classifyRestoreError(undefined), "unknown");
    assert.equal(classifyRestoreError(new Error("boom")), "unknown");
  });
});

describe("formatRestoreDate", () => {
  test("Indonesian short date in Jakarta time", () => {
    assert.equal(formatRestoreDate("2026-11-01T03:00:00.000Z"), "1 Nov 2026");
    assert.equal(formatRestoreDate("2026-12-01T03:00:00.000Z"), "1 Des 2026");
    assert.equal(formatRestoreDate("2026-10-31T03:00:00.000Z"), "31 Okt 2026");
  });

  test("late UTC evening is already the next day in Jakarta", () => {
    assert.equal(formatRestoreDate("2026-10-31T18:00:00.000Z"), "1 Nov 2026");
  });

  test("missing or invalid time shows a dash", () => {
    assert.equal(formatRestoreDate(null), "-");
    assert.equal(formatRestoreDate(undefined), "-");
    assert.equal(formatRestoreDate("bukan tanggal"), "-");
  });
});
