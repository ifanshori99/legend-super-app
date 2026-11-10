// Payslip PIN UI pure logic (bead legend-ilzrj, docs/briefs/sub-payslip-pin-ui.md
// "Pure logic module"). Loaded with native Node type stripping, like the sources.
//
// Assumptions where the brief is silent:
// - "Digit" means ASCII 0-9 only (other Unicode digits are dropped).
// - "Straight sequence" means each digit is previous +1 or -1 with no wrap-around
//   (012345, 123456, 456789, 987654, 543210 are weak; 567890 is not tested).
// - A locked status with null lockedUntil is still "locked"; an unparsable
//   lockedUntil string classifies to lockedUntil null.
// - minutesUntil at exactly `now` is 0; pinStatusView with lockedUntil === now is "enter".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import {
  PAYSLIP_PIN_LENGTH,
  PAYSLIP_PIN_MAX_ATTEMPTS,
  classifyPinError,
  isCompletePin,
  minutesUntil,
  pinStatusView,
  sanitizePinInput,
  validateNewPin,
} from "../apps/web/src/features/ws10-payslip/pin-state.ts";

const MODULE_PATH = new URL(
  "../apps/web/src/features/ws10-payslip/pin-state.ts",
  import.meta.url,
);
const now = new Date("2026-11-10T10:00:00.000Z");
const at = (iso) => new Date(iso).toISOString();
// Contract: remainingAttempts / lockedUntil are top-level fields on the ApiError
// (not inside `details`).
const err = (status, code, extra) =>
  Object.assign(new ApiError(status, code, `${code} message`), extra);

describe("pin-state module", () => {
  test("has no framework imports", () => {
    const source = readFileSync(MODULE_PATH, "utf8");
    assert.doesNotMatch(source, /from\s+["'](react|@tanstack|next|vite)/);
    assert.doesNotMatch(source, /from\s+["']react/);
  });

  test("constants match the contract", () => {
    assert.equal(PAYSLIP_PIN_LENGTH, 6);
    assert.equal(PAYSLIP_PIN_MAX_ATTEMPTS, 5);
  });
});

describe("sanitizePinInput", () => {
  test("keeps digits only", () => {
    assert.equal(sanitizePinInput("12ab34-56"), "123456");
    assert.equal(sanitizePinInput(" 1 2 3 "), "123");
    assert.equal(sanitizePinInput("abc"), "");
    assert.equal(sanitizePinInput(""), "");
  });

  test("caps at 6 digits after stripping", () => {
    assert.equal(sanitizePinInput("1234567890"), "123456");
    assert.equal(sanitizePinInput("a1b2c3d4e5f6g7"), "123456");
  });

  test("leaves a valid PIN and leading zeros untouched", () => {
    assert.equal(sanitizePinInput("123456"), "123456");
    assert.equal(sanitizePinInput("000123"), "000123");
  });

  test("drops non-ASCII digits", () => {
    assert.equal(sanitizePinInput("١٢٣"), "");
  });
});

describe("isCompletePin", () => {
  test("true only for exactly 6 digits", () => {
    assert.equal(isCompletePin("123456"), true);
    assert.equal(isCompletePin("000000"), true);
    assert.equal(isCompletePin("12345"), false);
    assert.equal(isCompletePin("1234567"), false);
    assert.equal(isCompletePin(""), false);
  });

  test("false when any character is not a digit", () => {
    assert.equal(isCompletePin("12345a"), false);
    assert.equal(isCompletePin("12 345"), false);
    assert.equal(isCompletePin("12345-"), false);
  });
});

describe("validateNewPin", () => {
  test("accepts a strong PIN that matches its confirmation", () => {
    assert.deepEqual(validateNewPin("482915", "482915"), { ok: true });
    assert.deepEqual(validateNewPin("121212", "121212"), { ok: true });
    assert.deepEqual(validateNewPin("123457", "123457"), { ok: true });
    assert.deepEqual(validateNewPin("112233", "112233"), { ok: true });
  });

  test("incomplete PIN or non-digit PIN", () => {
    assert.deepEqual(validateNewPin("", ""), {
      ok: false,
      reason: "incomplete",
    });
    assert.deepEqual(validateNewPin("48291", "48291"), {
      ok: false,
      reason: "incomplete",
    });
    assert.deepEqual(validateNewPin("48291a", "48291a"), {
      ok: false,
      reason: "incomplete",
    });
  });

  test("weak: same digit repeated", () => {
    for (const pin of ["111111", "000000", "999999"]) {
      assert.deepEqual(validateNewPin(pin, pin), { ok: false, reason: "weak" });
    }
  });

  test("weak: ascending and descending straight sequences", () => {
    for (const pin of ["123456", "234567", "012345", "456789"]) {
      assert.deepEqual(validateNewPin(pin, pin), { ok: false, reason: "weak" });
    }
    for (const pin of ["654321", "987654", "543210"]) {
      assert.deepEqual(validateNewPin(pin, pin), { ok: false, reason: "weak" });
    }
  });

  test("mismatch when the confirmation differs", () => {
    assert.deepEqual(validateNewPin("482915", "482916"), {
      ok: false,
      reason: "mismatch",
    });
    assert.deepEqual(validateNewPin("482915", ""), {
      ok: false,
      reason: "mismatch",
    });
    assert.deepEqual(validateNewPin("482915", "48291"), {
      ok: false,
      reason: "mismatch",
    });
  });

  test("order: incomplete beats weak and mismatch", () => {
    assert.deepEqual(validateNewPin("11111", "22222"), {
      ok: false,
      reason: "incomplete",
    });
    assert.deepEqual(validateNewPin("12345", "123456"), {
      ok: false,
      reason: "incomplete",
    });
  });

  test("order: weak beats mismatch", () => {
    assert.deepEqual(validateNewPin("111111", "222222"), {
      ok: false,
      reason: "weak",
    });
    assert.deepEqual(validateNewPin("123456", ""), {
      ok: false,
      reason: "weak",
    });
  });
});

describe("classifyPinError", () => {
  test("403 PAYSLIP_PIN_INVALID carries remainingAttempts", () => {
    assert.deepEqual(
      classifyPinError(
        err(403, "PAYSLIP_PIN_INVALID", { remainingAttempts: 3 }),
      ),
      { kind: "invalid", remainingAttempts: 3 },
    );
    assert.deepEqual(
      classifyPinError(
        err(403, "PAYSLIP_PIN_INVALID", { remainingAttempts: 0 }),
      ),
      { kind: "invalid", remainingAttempts: 0 },
    );
  });

  test("invalid with missing or malformed field gives null attempts", () => {
    const expected = { kind: "invalid", remainingAttempts: null };
    assert.deepEqual(
      classifyPinError(err(403, "PAYSLIP_PIN_INVALID")),
      expected,
    );
    assert.deepEqual(
      classifyPinError(err(403, "PAYSLIP_PIN_INVALID", {})),
      expected,
    );
    for (const bad of [
      "3",
      null,
      -1,
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      assert.deepEqual(
        classifyPinError(
          err(403, "PAYSLIP_PIN_INVALID", { remainingAttempts: bad }),
        ),
        expected,
        `remainingAttempts ${String(bad)}`,
      );
    }
  });

  test("423 PAYSLIP_PIN_LOCKED carries lockedUntil", () => {
    const until = at("2026-11-10T10:15:00Z");
    assert.deepEqual(
      classifyPinError(err(423, "PAYSLIP_PIN_LOCKED", { lockedUntil: until })),
      { kind: "locked", lockedUntil: until },
    );
  });

  test("locked with missing or non-string lockedUntil gives null", () => {
    const expected = { kind: "locked", lockedUntil: null };
    assert.deepEqual(
      classifyPinError(err(423, "PAYSLIP_PIN_LOCKED")),
      expected,
    );
    assert.deepEqual(
      classifyPinError(err(423, "PAYSLIP_PIN_LOCKED", {})),
      expected,
    );
    assert.deepEqual(
      classifyPinError(err(423, "PAYSLIP_PIN_LOCKED", { lockedUntil: 12345 })),
      expected,
    );
    assert.deepEqual(
      classifyPinError(
        err(423, "PAYSLIP_PIN_LOCKED", { lockedUntil: "not a date" }),
      ),
      expected,
    );
  });

  test("409 PAYSLIP_PIN_NOT_SET", () => {
    assert.deepEqual(classifyPinError(err(409, "PAYSLIP_PIN_NOT_SET")), {
      kind: "not_set",
    });
  });

  test("429 RATE_LIMITED", () => {
    assert.deepEqual(classifyPinError(err(429, "RATE_LIMITED")), {
      kind: "rate_limited",
    });
  });

  test("503 SERVICE_UNAVAILABLE", () => {
    assert.deepEqual(classifyPinError(err(503, "SERVICE_UNAVAILABLE")), {
      kind: "unavailable",
    });
  });

  test("404 NOT_FOUND", () => {
    assert.deepEqual(classifyPinError(err(404, "NOT_FOUND")), {
      kind: "not_found",
    });
  });

  test("wrong, expired or used WhatsApp code is 403 PAYSLIP_PIN_INVALID", () => {
    // The API answers these exactly like a wrong PIN; there is no separate OTP kind.
    assert.deepEqual(
      classifyPinError(
        err(403, "PAYSLIP_PIN_INVALID", { remainingAttempts: 2 }),
      ),
      { kind: "invalid", remainingAttempts: 2 },
    );
  });

  test("network: non-ApiError values and status 0", () => {
    const network = { kind: "network" };
    assert.deepEqual(
      classifyPinError(new TypeError("Failed to fetch")),
      network,
    );
    assert.deepEqual(classifyPinError(new Error("boom")), network);
    assert.deepEqual(classifyPinError(undefined), network);
    assert.deepEqual(classifyPinError(null), network);
    assert.deepEqual(classifyPinError("oops"), network);
    assert.deepEqual(classifyPinError(err(0, "NETWORK_ERROR")), network);
  });

  test("unknown: other statuses and codes", () => {
    const unknown = { kind: "unknown" };
    assert.deepEqual(classifyPinError(err(500, "INTERNAL_ERROR")), unknown);
    assert.deepEqual(classifyPinError(err(403, "FORBIDDEN")), unknown);
    assert.deepEqual(classifyPinError(err(422, "VALIDATION_ERROR")), unknown);
  });

  test("duck-typed: plain objects with status, code and top-level fields", () => {
    assert.deepEqual(
      classifyPinError({
        status: 403,
        code: "PAYSLIP_PIN_INVALID",
        remainingAttempts: 4,
      }),
      { kind: "invalid", remainingAttempts: 4 },
    );
    assert.deepEqual(classifyPinError({ status: 429, code: "RATE_LIMITED" }), {
      kind: "rate_limited",
    });
  });
});

describe("minutesUntil", () => {
  test("rounds partial minutes up", () => {
    assert.equal(minutesUntil(at("2026-11-10T10:15:00Z"), now), 15);
    assert.equal(minutesUntil(at("2026-11-10T10:14:30Z"), now), 15);
    assert.equal(minutesUntil(at("2026-11-10T10:14:00Z"), now), 14);
    assert.equal(minutesUntil(at("2026-11-10T10:00:01Z"), now), 1);
  });

  test("never negative", () => {
    assert.equal(minutesUntil(at("2026-11-10T10:00:00Z"), now), 0);
    assert.equal(minutesUntil(at("2026-11-10T09:59:00Z"), now), 0);
    assert.equal(minutesUntil(at("2026-11-09T10:00:00Z"), now), 0);
  });

  test("null for null or an unparsable date", () => {
    assert.equal(minutesUntil(null, now), null);
    assert.equal(minutesUntil("", now), null);
    assert.equal(minutesUntil("not a date", now), null);
  });
});

describe("pinStatusView", () => {
  test("not_set shows create", () => {
    assert.equal(
      pinStatusView({ status: "not_set", lockedUntil: null }, now),
      "create",
    );
  });

  test("active shows enter", () => {
    assert.equal(
      pinStatusView({ status: "active", lockedUntil: null }, now),
      "enter",
    );
  });

  test("locked in the future shows locked", () => {
    assert.equal(
      pinStatusView(
        { status: "locked", lockedUntil: at("2026-11-10T10:15:00Z") },
        now,
      ),
      "locked",
    );
    assert.equal(
      pinStatusView(
        { status: "locked", lockedUntil: at("2026-11-10T10:00:01Z") },
        now,
      ),
      "locked",
    );
  });

  test("locked with no lockedUntil stays locked", () => {
    assert.equal(
      pinStatusView({ status: "locked", lockedUntil: null }, now),
      "locked",
    );
  });

  test("locked but the lock already ended shows enter", () => {
    assert.equal(
      pinStatusView(
        { status: "locked", lockedUntil: at("2026-11-10T09:59:59Z") },
        now,
      ),
      "enter",
    );
    assert.equal(
      pinStatusView(
        { status: "locked", lockedUntil: at("2026-11-10T10:00:00Z") },
        now,
      ),
      "enter",
    );
  });
});
