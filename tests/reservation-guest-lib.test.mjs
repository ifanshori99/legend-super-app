// Guest "kelola reservasi" page helpers (bead legend-g12il, slice T).
// Spec: docs/briefs/sub-reservation-guest.md "Antarmuka bersama" (lib.ts).
// Pure functions only, no DOM, no network. Written before the implementation:
// the module is loaded lazily so every test fails by name while it is missing.
//
// Assumptions where the brief is silent:
// - `readLinkToken` strips ONE leading "#"; anything that is not exactly the
//   43-char base64url token afterwards is null.
// - a `withdrawn` reschedule request is NOT asserted (brief lists only
//   pending/approved/declined).
// - `rescheduleDateBounds().min` is today's date in the outlet zone and `max`
//   is the date of now + 180 days in that zone (both inclusive).
// - with both date and time empty, no assertion on which problem comes first.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import { reservationLinkTokenSchema } from "../packages/shared/src/reservation/self-service.ts";
import { registerWebAlias } from "./helpers/web-alias.mjs";

registerWebAlias();
const loaded =
  await import("../apps/web/src/features/ws08-reservation-guest/lib.ts").then(
    (module) => ({ module }),
    (error) => ({ error }),
  );
function lib() {
  if (loaded.error) throw loaded.error;
  return loaded.module;
}

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde";
assert.equal(TOKEN.length, 43);
assert.ok(reservationLinkTokenSchema.safeParse(TOKEN).success);

// 14 Nov 2026 10.00 WIB.
const NOW = new Date("2026-11-14T03:00:00.000Z");
// 18 Nov 2026 19.00 WIB.
const RESERVED_FOR = "2026-11-18T12:00:00.000Z";

function view(overrides = {}) {
  return {
    reservationId: "11111111-1111-4111-8111-111111111111",
    outletId: "22222222-2222-4222-8222-222222222222",
    outletName: "Cafe Legend · Menteng",
    guestName: "Tamu",
    partySize: 4,
    reservedFor: RESERVED_FOR,
    status: "confirmed",
    note: null,
    deposit: {
      amountIdr: 50000,
      paidIdr: 50000,
      refundIdr: null,
      forfeitedIdr: null,
      refundStatus: null,
    },
    cancellation: {
      allowed: true,
      freeUntil: "2026-11-17T12:00:00.000Z",
      preview: {
        resolution: "refund_full",
        refundIdr: 50000,
        forfeitedIdr: 0,
        policyVersion: 1,
      },
    },
    rescheduleRequest: null,
    linkExpiresAt: "2026-11-19T12:00:00.000Z",
    ...overrides,
  };
}
function request(status) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    reservationId: "11111111-1111-4111-8111-111111111111",
    outletId: "22222222-2222-4222-8222-222222222222",
    requestedFor: "2026-11-20T12:00:00.000Z",
    partySize: null,
    note: null,
    status,
    createdAt: "2026-11-14T02:00:00.000Z",
    resolvedAt: status === "pending" ? null : "2026-11-14T02:30:00.000Z",
  };
}
const latePreview = {
  allowed: true,
  freeUntil: "2026-11-17T12:00:00.000Z",
  preview: {
    resolution: "refund_partial",
    refundIdr: 25000,
    forfeitedIdr: 25000,
    policyVersion: 1,
  },
};

describe("readLinkToken", () => {
  test("accepts a 43-char token with or without the leading #", () => {
    assert.equal(lib().readLinkToken(`#${TOKEN}`), TOKEN);
    assert.equal(lib().readLinkToken(TOKEN), TOKEN);
  });
  test("rejects empty, bare #, wrong length and bad characters", () => {
    for (const hash of [
      "",
      "#",
      `#${TOKEN.slice(1)}`,
      `#${TOKEN}x`,
      `#${TOKEN.slice(0, 42)}+`,
      `#${TOKEN.slice(0, 42)}=`,
      `#${TOKEN.slice(0, 42)} `,
      `#${TOKEN}&x=1`,
      "#invalid",
    ]) {
      assert.equal(lib().readLinkToken(hash), null, JSON.stringify(hash));
    }
  });
});

describe("deriveGuestScreen", () => {
  test("a plain future confirmed booking shows the detail screen", () => {
    assert.equal(lib().deriveGuestScreen(view(), NOW), "detail");
    assert.equal(
      lib().deriveGuestScreen(view({ status: "pending_deposit" }), NOW),
      "detail",
    );
  });
  test("cancelled wins over everything, even a pending request", () => {
    assert.equal(
      lib().deriveGuestScreen(
        view({ status: "cancelled", rescheduleRequest: request("pending") }),
        NOW,
      ),
      "cancelled",
    );
  });
  test("seated, completed and no_show are closed", () => {
    for (const status of ["seated", "completed", "no_show"]) {
      assert.equal(
        lib().deriveGuestScreen(
          view({ status, rescheduleRequest: request("pending") }),
          NOW,
        ),
        "closed",
        status,
      );
    }
  });
  test("pending, approved and declined requests map to their screens", () => {
    const screen = (status) =>
      lib().deriveGuestScreen(
        view({ rescheduleRequest: request(status) }),
        NOW,
      );
    assert.equal(screen("pending"), "pending");
    assert.equal(screen("approved"), "approved");
    assert.equal(screen("declined"), "rejected");
  });
  test("a request outranks late", () => {
    assert.equal(
      lib().deriveGuestScreen(
        view({
          cancellation: latePreview,
          rescheduleRequest: request("pending"),
        }),
        NOW,
      ),
      "pending",
    );
  });
  test("late when cancelling now would forfeit part of the DP", () => {
    assert.equal(
      lib().deriveGuestScreen(view({ cancellation: latePreview }), NOW),
      "late",
    );
  });
  test("late once now reaches reservedFor, detail one moment before", () => {
    const noPreview = {
      allowed: true,
      freeUntil: "2026-11-17T12:00:00.000Z",
      preview: null,
    };
    const reserved = view({ cancellation: noPreview });
    assert.equal(
      lib().deriveGuestScreen(reserved, new Date(RESERVED_FOR)),
      "late",
    );
    assert.equal(
      lib().deriveGuestScreen(reserved, new Date("2026-11-18T12:00:01.000Z")),
      "late",
    );
    assert.equal(
      lib().deriveGuestScreen(reserved, new Date("2026-11-18T11:59:59.000Z")),
      "detail",
    );
  });
  test("a preview with nothing forfeited is not late", () => {
    for (const resolution of ["nothing_paid", "refund_full"]) {
      assert.equal(
        lib().deriveGuestScreen(
          view({
            cancellation: {
              allowed: true,
              freeUntil: "2026-11-17T12:00:00.000Z",
              preview: {
                resolution,
                refundIdr: 0,
                forfeitedIdr: 0,
                policyVersion: 1,
              },
            },
          }),
          NOW,
        ),
        "detail",
        resolution,
      );
    }
  });
});

describe("deriveGuestScreen late vs requests", () => {
  test("late never beats a pending, approved or declined request", () => {
    const expected = {
      pending: "pending",
      approved: "approved",
      declined: "rejected",
    };
    for (const [status, screen] of Object.entries(expected)) {
      assert.equal(
        lib().deriveGuestScreen(
          view({
            cancellation: latePreview,
            rescheduleRequest: request(status),
          }),
          NOW,
        ),
        screen,
        status,
      );
    }
  });
  test("late by time alone (now past reservedFor) also loses to a request", () => {
    const past = new Date("2026-11-18T13:00:00.000Z");
    for (const [status, screen] of [
      ["pending", "pending"],
      ["approved", "approved"],
      ["declined", "rejected"],
    ]) {
      assert.equal(
        lib().deriveGuestScreen(
          view({ rescheduleRequest: request(status) }),
          past,
        ),
        screen,
        status,
      );
    }
  });
});

describe("isLateForReschedule", () => {
  const withPreview = (preview) =>
    view({
      cancellation: {
        allowed: true,
        freeUntil: "2026-11-17T12:00:00.000Z",
        preview,
      },
    });
  test("true when cancelling now would forfeit part of the DP", () => {
    assert.equal(
      lib().isLateForReschedule(view({ cancellation: latePreview }), NOW),
      true,
    );
  });
  test("true once now reaches reservedFor, even with a full-refund preview", () => {
    const reserved = view();
    assert.equal(
      lib().isLateForReschedule(reserved, new Date(RESERVED_FOR)),
      true,
    );
    assert.equal(
      lib().isLateForReschedule(reserved, new Date("2026-11-18T12:00:01.000Z")),
      true,
    );
  });
  test("true with a null preview once the schedule has passed", () => {
    assert.equal(
      lib().isLateForReschedule(withPreview(null), new Date(RESERVED_FOR)),
      true,
    );
  });
  test("false for a refund_full preview before the schedule", () => {
    assert.equal(lib().isLateForReschedule(view(), NOW), false);
    assert.equal(
      lib().isLateForReschedule(view(), new Date("2026-11-18T11:59:59.000Z")),
      false,
    );
  });
  test("false for a null preview before the schedule", () => {
    assert.equal(lib().isLateForReschedule(withPreview(null), NOW), false);
  });
  test("false for nothing_paid with nothing forfeited before the schedule", () => {
    assert.equal(
      lib().isLateForReschedule(
        withPreview({
          resolution: "nothing_paid",
          refundIdr: 0,
          forfeitedIdr: 0,
          policyVersion: 1,
        }),
        NOW,
      ),
      false,
    );
  });
  test("agrees with deriveGuestScreen === late on a plain booking", () => {
    for (const v of [
      view(),
      view({ cancellation: latePreview }),
      withPreview(null),
    ]) {
      for (const now of [NOW, new Date(RESERVED_FOR)]) {
        assert.equal(
          lib().isLateForReschedule(v, now),
          lib().deriveGuestScreen(v, now) === "late",
        );
      }
    }
  });
});

describe("guestErrorKind", () => {
  const kind = (status, code) =>
    lib().guestErrorKind(new ApiError(status, code, "x"));
  test("maps the server codes", () => {
    assert.equal(kind(404, "RESERVATION_LINK_INVALID"), "invalid");
    assert.equal(kind(429, "RATE_LIMITED"), "rate_limited");
    assert.equal(kind(409, "RESERVATION_RESCHEDULE_LATE"), "late");
    assert.equal(kind(409, "RESERVATION_RESCHEDULE_PENDING"), "pending_exists");
    assert.equal(kind(422, "RESERVATION_RESCHEDULE_INVALID"), "invalid_input");
    assert.equal(kind(409, "RESERVATION_TRANSITION_INVALID"), "transition");
  });
  test("status 0, NETWORK_ERROR and 5xx are network", () => {
    assert.equal(kind(0, "NETWORK_ERROR"), "network");
    assert.equal(kind(0, "SOMETHING"), "network");
    assert.equal(kind(500, "INTERNAL_ERROR"), "network");
    assert.equal(kind(502, "BAD_GATEWAY"), "network");
    assert.equal(kind(503, "UNAVAILABLE"), "network");
  });
  test("anything else, including non-ApiError values, is unknown", () => {
    // 400 is left unasserted: the brief does not say whether it is invalid_input.
    assert.equal(kind(403, "SOMETHING_ELSE"), "unknown");
    assert.equal(kind(418, "SOMETHING_ELSE"), "unknown");
    assert.equal(lib().guestErrorKind(new Error("boom")), "unknown");
    assert.equal(lib().guestErrorKind("boom"), "unknown");
    assert.equal(lib().guestErrorKind(null), "unknown");
    assert.equal(lib().guestErrorKind(undefined), "unknown");
  });
});

describe("validateReschedule", () => {
  const WIB = "Asia/Jakarta";
  test("asks for the missing field", () => {
    assert.deepEqual(
      lib().validateReschedule({ date: "", time: "19:00" }, NOW, WIB),
      { ok: false, problem: "missing_date" },
    );
    assert.deepEqual(
      lib().validateReschedule({ date: "2026-11-20", time: "" }, NOW, WIB),
      { ok: false, problem: "missing_time" },
    );
  });
  test("accepts a future slot and returns the UTC instant", () => {
    const result = lib().validateReschedule(
      { date: "2026-11-20", time: "19:00" },
      NOW,
      WIB,
    );
    assert.equal(result.ok, true);
    assert.equal(
      new Date(result.requestedFor).getTime(),
      Date.parse("2026-11-20T12:00:00.000Z"),
    );
    assert.match(result.requestedFor, /Z$/);
  });
  test("reads the wall clock in the outlet zone", () => {
    const at = (timeZone) =>
      Date.parse(
        lib().validateReschedule(
          { date: "2026-11-20", time: "19:00" },
          NOW,
          timeZone,
        ).requestedFor,
      );
    assert.equal(at("Asia/Makassar"), Date.parse("2026-11-20T11:00:00.000Z"));
    assert.equal(at("Asia/Jayapura"), Date.parse("2026-11-20T10:00:00.000Z"));
  });
  test("the time must be after now", () => {
    // NOW is 10.00 WIB on 14 Nov.
    for (const time of ["09:00", "10:00"]) {
      assert.deepEqual(
        lib().validateReschedule({ date: "2026-11-14", time }, NOW, WIB),
        { ok: false, problem: "past" },
        time,
      );
    }
    assert.deepEqual(
      lib().validateReschedule({ date: "2026-11-13", time: "23:00" }, NOW, WIB),
      { ok: false, problem: "past" },
    );
    assert.equal(
      lib().validateReschedule({ date: "2026-11-14", time: "10:30" }, NOW, WIB)
        .ok,
      true,
    );
  });
  test("at most 180 days ahead", () => {
    // NOW + 180 days = 13 May 2027 10.00 WIB.
    assert.equal(
      lib().validateReschedule({ date: "2027-05-13", time: "09:00" }, NOW, WIB)
        .ok,
      true,
    );
    assert.deepEqual(
      lib().validateReschedule({ date: "2027-05-13", time: "11:00" }, NOW, WIB),
      { ok: false, problem: "too_far" },
    );
    assert.deepEqual(
      lib().validateReschedule({ date: "2027-05-14", time: "10:00" }, NOW, WIB),
      { ok: false, problem: "too_far" },
    );
    assert.deepEqual(
      lib().validateReschedule({ date: "2028-01-01", time: "10:00" }, NOW, WIB),
      { ok: false, problem: "too_far" },
    );
  });
});

describe("validateReschedule impossible calendar dates", () => {
  const WIB = "Asia/Jakarta";
  // Assumption: a well-formed but non-existent date (31 Feb) is reported as
  // missing_date, same as an empty date, never rolled over to 3 Mar.
  test("2026-02-31 is missing_date", () => {
    assert.deepEqual(
      lib().validateReschedule({ date: "2026-02-31", time: "19:00" }, NOW, WIB),
      { ok: false, problem: "missing_date" },
    );
  });
});

describe("rescheduleDateBounds", () => {
  test("min is today and max is 180 days ahead, in the outlet zone", () => {
    assert.deepEqual(lib().rescheduleDateBounds(NOW, "Asia/Jakarta"), {
      min: "2026-11-14",
      max: "2027-05-13",
    });
  });
  test("follows the zone across midnight", () => {
    // 20.00 UTC on 14 Nov is already 15 Nov in WIB, WITA and WIT.
    const late = new Date("2026-11-14T20:00:00.000Z");
    assert.equal(
      lib().rescheduleDateBounds(late, "Asia/Jakarta").min,
      "2026-11-15",
    );
    assert.equal(lib().rescheduleDateBounds(late, "UTC").min, "2026-11-14");
  });
  test("the bounds agree with validateReschedule", () => {
    const { max } = lib().rescheduleDateBounds(NOW, "Asia/Jakarta");
    assert.equal(
      lib().validateReschedule(
        { date: max, time: "09:00" },
        NOW,
        "Asia/Jakarta",
      ).ok,
      true,
    );
  });
});

describe("zoneLabel and defaults", () => {
  test("Indonesian zones get their abbreviation", () => {
    assert.equal(lib().zoneLabel("Asia/Jakarta"), "WIB");
    assert.equal(lib().zoneLabel("Asia/Makassar"), "WITA");
    assert.equal(lib().zoneLabel("Asia/Jayapura"), "WIT");
  });
  test("other zones fall back to the zone name", () => {
    assert.equal(lib().zoneLabel("Asia/Singapore"), "Asia/Singapore");
    assert.equal(lib().zoneLabel("UTC"), "UTC");
  });
  test("the default zone is Jakarta", () => {
    assert.equal(lib().GUEST_DEFAULT_TIME_ZONE, "Asia/Jakarta");
  });
});
