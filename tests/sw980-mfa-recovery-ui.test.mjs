// MFA recovery code screens (bead legend-sw980; PRD §3 F6, AUTH-05): pure logic
// of apps/web/src/features/ws01-auth/recovery-state.ts, checked against the
// identity contract, plus a check that every copy key the screens use exists
// in the Indonesian catalog. Loaded with native Node type stripping.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  MFA_RECOVERY_CODE_COUNT,
  MFA_RECOVERY_CODE_INPUT_PATTERN,
  MFA_RECOVERY_CODE_PATTERN,
  mfaRecoveryVerifySchema,
} from "../packages/shared/src/identity/index.ts";
import { ws01AuthMessages } from "../packages/shared/src/i18n/messages/ws01-auth.ts";
import {
  RECOVERY_CODE_COUNT,
  RECOVERY_LOW_THRESHOLD,
  canShowRecoveryLogin,
  checkRecoveryCode,
  classifyRecoveryError,
  cleanRecoveryCode,
  formatRecoveryCodeInput,
  isRecoveryCodeComplete,
  recoveryCodesClipboardText,
  recoveryNeedsRegeneration,
  recoveryStatusView,
} from "../apps/web/src/features/ws01-auth/recovery-state.ts";

const dir = "../apps/web/src/features/ws01-auth/";
const read = (name) =>
  readFileSync(new URL(dir + name, import.meta.url), "utf8");
const err = (status, code) => ({ status, code });

describe("recovery-state module", () => {
  test("has no framework or alias imports", () => {
    const source = read("recovery-state.ts");
    assert.doesNotMatch(source, /from\s+["'](react|@tanstack|@\/|next|vite)/);
  });

  test("code count matches the identity contract", () => {
    assert.equal(RECOVERY_CODE_COUNT, MFA_RECOVERY_CODE_COUNT);
  });
});

describe("recovery code input", () => {
  test("cleanRecoveryCode drops separators and symbols, upper-cases, caps at 10", () => {
    assert.equal(cleanRecoveryCode("abcde-12345"), "ABCDE12345");
    assert.equal(cleanRecoveryCode(" abcde 12345 "), "ABCDE12345");
    assert.equal(cleanRecoveryCode("abcde-12345-extra"), "ABCDE12345");
    assert.equal(cleanRecoveryCode("!@#"), "");
  });

  test("formatRecoveryCodeInput inserts the dash after 5 characters", () => {
    assert.equal(formatRecoveryCodeInput("abc"), "ABC");
    assert.equal(formatRecoveryCodeInput("abcde"), "ABCDE");
    assert.equal(formatRecoveryCodeInput("abcdef"), "ABCDE-F");
    assert.equal(formatRecoveryCodeInput("abcde12345"), "ABCDE-12345");
    assert.equal(formatRecoveryCodeInput("ABCDE-12345"), "ABCDE-12345");
  });

  test("isRecoveryCodeComplete needs 10 characters", () => {
    assert.equal(isRecoveryCodeComplete("ABCDE-1234"), false);
    assert.equal(isRecoveryCodeComplete("ABCDE-12345"), true);
    assert.equal(isRecoveryCodeComplete("abcde12345"), true);
    assert.equal(isRecoveryCodeComplete(""), false);
  });

  test("checkRecoveryCode: empty, incomplete, or the value to send", () => {
    assert.deepEqual(checkRecoveryCode(""), { ok: false, reason: "empty" });
    assert.deepEqual(checkRecoveryCode("  - "), { ok: false, reason: "empty" });
    assert.deepEqual(checkRecoveryCode("ABCDE-12"), {
      ok: false,
      reason: "incomplete",
    });
    assert.deepEqual(checkRecoveryCode("abcde12345"), {
      ok: true,
      code: "ABCDE-12345",
    });
  });

  test("a sendable code satisfies the contract's input schema", () => {
    const check = checkRecoveryCode("abcde 12345");
    assert.equal(check.ok, true);
    assert.match(check.code, MFA_RECOVERY_CODE_INPUT_PATTERN);
    assert.equal(
      mfaRecoveryVerifySchema.safeParse({ code: check.code }).success,
      true,
    );
  });

  test("the mockup's sample codes are valid contract codes and sendable", () => {
    for (const sample of ["ABCDE-FGHJK", "MNPQR-STVWX", "23456-789AB"]) {
      assert.match(sample, MFA_RECOVERY_CODE_PATTERN);
      assert.deepEqual(checkRecoveryCode(sample), { ok: true, code: sample });
    }
  });
});

describe("classifyRecoveryError", () => {
  test("wrong, used or unknown code: 401 MFA_RECOVERY_CODE_INVALID", () => {
    assert.equal(
      classifyRecoveryError(err(401, "MFA_RECOVERY_CODE_INVALID")),
      "invalid",
    );
  });

  test("five wrong codes lock: 429 RATE_LIMITED", () => {
    assert.equal(
      classifyRecoveryError(err(429, "RATE_LIMITED")),
      "rate_limited",
    );
    assert.equal(classifyRecoveryError(err(429, "ANYTHING")), "rate_limited");
  });

  test("generating without a verified session or without a factor", () => {
    assert.equal(
      classifyRecoveryError(err(403, "MFA_REQUIRED")),
      "mfa_required",
    );
    assert.equal(classifyRecoveryError(err(409, "CONFLICT")), "no_factor");
  });

  test("ended session, offline, validation and unknown failures", () => {
    assert.equal(
      classifyRecoveryError(err(401, "UNAUTHORIZED")),
      "session_ended",
    );
    assert.equal(classifyRecoveryError(err(0, "NETWORK_ERROR")), "network");
    assert.equal(
      classifyRecoveryError(err(400, "VALIDATION_ERROR")),
      "invalid",
    );
    assert.equal(classifyRecoveryError(err(500, "INTERNAL")), "unknown");
    assert.equal(classifyRecoveryError(null), "unknown");
    assert.equal(classifyRecoveryError(new Error("boom")), "unknown");
  });

  test("a wrong code never reads as session ended", () => {
    assert.notEqual(
      classifyRecoveryError(err(401, "MFA_RECOVERY_CODE_INVALID")),
      "session_ended",
    );
  });
});

describe("recoveryStatusView", () => {
  test("never generated, depleted, low and ok", () => {
    assert.equal(
      recoveryStatusView({ remaining: 0, generatedAt: null }),
      "not_generated",
    );
    const at = "2026-11-10T10:00:00.000Z";
    assert.equal(
      recoveryStatusView({ remaining: 0, generatedAt: at }),
      "depleted",
    );
    assert.equal(recoveryStatusView({ remaining: 1, generatedAt: at }), "low");
    assert.equal(
      recoveryStatusView({
        remaining: RECOVERY_LOW_THRESHOLD,
        generatedAt: at,
      }),
      "low",
    );
    assert.equal(
      recoveryStatusView({
        remaining: RECOVERY_LOW_THRESHOLD + 1,
        generatedAt: at,
      }),
      "ok",
    );
    assert.equal(recoveryStatusView({ remaining: 10, generatedAt: at }), "ok");
  });

  test("only depleted and low ask for a new set", () => {
    assert.equal(recoveryNeedsRegeneration("depleted"), true);
    assert.equal(recoveryNeedsRegeneration("low"), true);
    assert.equal(recoveryNeedsRegeneration("ok"), false);
    assert.equal(recoveryNeedsRegeneration("not_generated"), false);
  });
});

test("clipboard text is one code per line", () => {
  assert.equal(
    recoveryCodesClipboardText(["AAAAA-BBBBB", "CCCCC-DDDDD"]),
    "AAAAA-BBBBB\nCCCCC-DDDDD",
  );
  assert.equal(recoveryCodesClipboardText([]), "");
});

describe("copy catalog", () => {
  const files = [
    "components/recovery-codes-card.tsx",
    "components/recovery-section.tsx",
    "components/recovery-login.tsx",
    "components/totp-enroll.tsx",
    "components/mfa-verify-page.tsx",
    "errors.ts",
  ];
  const lookup = (key) =>
    key.split(".").reduce((node, part) => node?.[part], ws01AuthMessages);

  test("every staffAuth.recovery* key used by the screens exists as text", () => {
    const keys = new Set();
    for (const file of files)
      for (const match of read(file).matchAll(
        /"(staffAuth\.recovery(?:Login)?\.[A-Za-z.]+)"/g,
      ))
        keys.add(match[1]);
    assert.ok(keys.size >= 30, `expected many keys, got ${keys.size}`);
    for (const key of keys)
      assert.equal(typeof lookup(key), "string", `missing copy: ${key}`);
  });

  test("copy follows the mockup", () => {
    const m = ws01AuthMessages.staffAuth;
    assert.equal(m.recovery.saveTitle, "Simpan kode cadangan Anda");
    assert.equal(m.recovery.onceTitle, "Ditampilkan sekali.");
    assert.equal(m.recovery.saved, "Saya sudah menyimpan kode");
    assert.equal(m.recoveryLogin.use, "Pakai kode cadangan");
    assert.equal(m.recoveryLogin.title, "Masukkan kode cadangan");
    assert.equal(
      m.recoveryLogin.invalid,
      "Kode tidak valid atau sudah digunakan. Periksa kode atau gunakan kode lain.",
    );
    assert.equal(m.recoveryLogin.submit, "Verifikasi kode");
  });
});

describe("canShowRecoveryLogin", () => {
  const open = { ended: false, enrollmentRequired: false };

  test("passkey-only person (no TOTP factor) can use a backup code", () => {
    assert.equal(
      canShowRecoveryLogin({ recoveryMode: true, state: open }),
      true,
    );
  });

  test("hidden unless asked, without state, ended or while enrolling", () => {
    assert.equal(
      canShowRecoveryLogin({ recoveryMode: false, state: open }),
      false,
    );
    assert.equal(
      canShowRecoveryLogin({ recoveryMode: true, state: null }),
      false,
    );
    assert.equal(
      canShowRecoveryLogin({
        recoveryMode: true,
        state: { ...open, ended: true },
      }),
      false,
    );
    assert.equal(
      canShowRecoveryLogin({
        recoveryMode: true,
        state: { ...open, enrollmentRequired: true },
      }),
      false,
    );
  });

  test("verify page shows the backup-code link in the passkey-only branch", () => {
    const source = read("components/mfa-verify-page.tsx");
    assert.match(source, /canShowRecoveryLogin\(/);
    assert.equal(source.match(/staffAuth\.recoveryLogin\.use/g).length, 2);
  });
});
