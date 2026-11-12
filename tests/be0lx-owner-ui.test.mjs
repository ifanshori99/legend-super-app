// Tenant Owner screen pure logic (bead legend-be0lx; mockup
// design/mockups/platform/owner-be0lx.html). Loaded with native Node type
// stripping, like the source. Cites TEN-04 (fresh TOTP per change, reason).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  accountFieldCopy,
  accountLabel,
  buildOwnerBody,
  classifyOwnerError,
  OWNER_COPY,
  ownerDisplay,
  ownerFromResult,
  ownerLine,
  ownerView,
  resolveAccount,
  sanitizeTotp,
  validateOwnerForm,
} from "../apps/web/src/features/ws01-platform-tenants/owner-state.ts";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";

const DEWI = {
  assignmentId: "0192f1c0-0000-7000-8000-00000000a001",
  userId: "0192f1c0-0000-7000-8000-00000000b001",
  name: "Dewi Pratama",
  email: "dewi@example.com",
};
const ANDI = {
  userId: "0192f1c0-0000-7000-8000-00000000b002",
  name: "Andi Saputra",
  email: "andi@example.com",
};
const accounts = [ANDI];
const valid = {
  account: "Andi Saputra · andi@example.com",
  reason: "Perubahan penanggung jawab tenant.",
  code: "123456",
};

describe("account lookup", () => {
  test("empty input asks to pick an account", () => {
    assert.deepEqual(resolveAccount("  ", accounts), {
      ok: false,
      reason: "required",
    });
  });
  test("matches the mockup label, the email or the id of a listed account", () => {
    for (const text of [accountLabel(ANDI), "ANDI@example.com", ANDI.userId]) {
      const found = resolveAccount(text, accounts);
      assert.equal(found.ok && found.userId, ANDI.userId);
      assert.equal(found.ok && found.option, ANDI);
    }
  });
  test("a bare account id works without a list; free text does not", () => {
    const id = "0192F1C0-0000-7000-8000-00000000B009";
    const found = resolveAccount(id, []);
    assert.equal(found.ok && found.userId, id.toLowerCase());
    assert.equal(found.ok && found.option, null);
    assert.deepEqual(resolveAccount("andi", []), {
      ok: false,
      reason: "unknown",
    });
  });
});

describe("form validation", () => {
  test("valid assign form passes and returns the account id", () => {
    const check = validateOwnerForm(valid, { mode: "assign", accounts });
    assert.equal(check.ok && check.userId, ANDI.userId);
  });
  test("empty form shows all three mockup messages", () => {
    const check = validateOwnerForm(
      { account: "", reason: " ", code: "" },
      { mode: "assign", accounts },
    );
    assert.deepEqual(check.ok ? null : check.errors, {
      account: "Pilih akun Owner.",
      reason: "Masukkan alasan perubahan.",
      code: "Masukkan kode terbaru dari aplikasi autentikator.",
    });
  });
  test("TEN-04: the code must be exactly 6 digits", () => {
    for (const code of ["12345", "1234567", "12345a", "123 456"]) {
      const check = validateOwnerForm(
        { ...valid, code },
        { mode: "assign", accounts },
      );
      assert.equal(
        check.ok ? null : check.errors.code,
        "Masukkan 6 digit kode dari aplikasi autentikator.",
      );
    }
  });
  test("reason over 500 characters is refused", () => {
    const check = validateOwnerForm(
      { ...valid, reason: "x".repeat(501) },
      { mode: "assign", accounts },
    );
    assert.equal(
      check.ok ? null : check.errors.reason,
      OWNER_COPY.reasonTooLong,
    );
  });
  test("replace refuses the current Owner as the new Owner", () => {
    const check = validateOwnerForm(
      { ...valid, account: DEWI.userId },
      { mode: "replace", current: DEWI, accounts },
    );
    assert.equal(
      check.ok ? null : check.errors.account,
      OWNER_COPY.accountSame,
    );
  });
  test("unknown account text is refused with its own message", () => {
    const check = validateOwnerForm(
      { ...valid, account: "siapa" },
      { mode: "assign", accounts },
    );
    assert.equal(
      check.ok ? null : check.errors.account,
      OWNER_COPY.accountUnknown,
    );
  });
  test("without an account list the error asks for an account id", () => {
    const check = validateOwnerForm(
      { ...valid, account: "siapa" },
      { mode: "assign", accounts: [] },
    );
    assert.equal(
      check.ok ? null : check.errors.account,
      OWNER_COPY.accountInvalidId,
    );
  });
  test("account field copy is honest: id only when no accounts are listed", () => {
    const byId = accountFieldCopy("assign", false);
    assert.match(byId.label, /ID akun/);
    assert.match(byId.label, /UUID/);
    assert.match(byId.hint, /Pencarian nama atau email menyusul/);
    assert.doesNotMatch(byId.placeholder, /nama atau email/);
    assert.equal(
      accountFieldCopy("replace", false).label,
      OWNER_COPY.accountLabelReplaceById,
    );
    const listed = accountFieldCopy("assign", true);
    assert.equal(listed.label, OWNER_COPY.accountLabelAssign);
    assert.equal(listed.placeholder, OWNER_COPY.accountPlaceholder);
    assert.equal(listed.hint, OWNER_COPY.accountHint);
  });
});

describe("request body", () => {
  test("matches the API contract: account.userId, trimmed reason, 6-digit code", () => {
    assert.deepEqual(
      buildOwnerBody(
        { ...valid, reason: "  alasan  ", code: " 123456 " },
        ANDI.userId,
      ),
      { account: { userId: ANDI.userId }, reason: "alasan", mfaCode: "123456" },
    );
  });
  test("the TOTP input keeps digits only, at most 6", () => {
    assert.equal(sanitizeTotp("12a3 456789"), "123456");
  });
});

describe("API error mapping", () => {
  const err = (status, code, message, details) =>
    new ApiError(status, code, message, details);
  test("TEN-04: a refused or missing MFA code lands on the code field", () => {
    for (const failure of [
      err(
        403,
        "FORBIDDEN",
        "Verifikasi MFA wajib sebelum menunjuk Owner tenant.",
      ),
      err(401, "MFA_INVALID", "x"),
      err(403, "REAUTH_REQUIRED", "x"),
    ]) {
      assert.deepEqual(classifyOwnerError(failure), {
        kind: "field",
        field: "code",
        message: OWNER_COPY.totpRejected,
      });
    }
  });
  test("each 403 cause gets its own banner text", () => {
    const cases = [
      [
        "Sesi impersonasi tidak dapat menunjuk Owner tenant.",
        OWNER_COPY.forbiddenImpersonation,
      ],
      ["Akun ini bukan Super Admin.", OWNER_COPY.forbiddenNotSuperAdmin],
      [
        "Super Admin tidak dapat menunjuk dirinya sendiri sebagai Owner.",
        OWNER_COPY.forbiddenSelf,
      ],
      [
        "Akun Super Admin tidak dapat ditunjuk sebagai Owner lewat Panel Platform.",
        OWNER_COPY.forbiddenSuperAdminTarget,
      ],
      ["Forbidden", OWNER_COPY.forbidden],
    ];
    const seen = new Set();
    for (const [message, copy] of cases) {
      assert.deepEqual(classifyOwnerError(err(403, "FORBIDDEN", message)), {
        kind: "banner",
        message: copy,
      });
      seen.add(copy);
    }
    assert.equal(seen.size, cases.length);
  });
  test("409: an existing Owner is an honest banner; last Owner is another banner", () => {
    const existing = classifyOwnerError(
      err(409, "CONFLICT", "Akun ini sudah menjadi Owner aktif tenant."),
    );
    assert.deepEqual(existing, {
      kind: "banner",
      message: OWNER_COPY.tenantHasOwner,
    });
    assert.doesNotMatch(existing.message, /Akun ini sudah menjadi Owner aktif/);
    assert.match(existing.message, /Tenant ini sudah punya Owner/);
    assert.deepEqual(
      classifyOwnerError(
        err(409, "CONFLICT", "Tenant harus memiliki minimal satu Owner aktif."),
      ),
      { kind: "banner", message: OWNER_COPY.lastOwner },
    );
  });
  test("422: not a tenant member, other account refusal, stale assignment, field details", () => {
    assert.equal(
      classifyOwnerError(
        err(422, "VALIDATION_ERROR", "Akun ini bukan anggota aktif tenant."),
      ).message,
      OWNER_COPY.accountNotMember,
    );
    assert.equal(
      classifyOwnerError(
        err(422, "VALIDATION_ERROR", "This account cannot be given a role."),
      ).message,
      OWNER_COPY.accountRefused,
    );
    assert.deepEqual(
      classifyOwnerError(
        err(422, "VALIDATION_ERROR", "Penugasan Owner ini sudah tidak aktif."),
      ),
      { kind: "banner", message: OWNER_COPY.stale },
    );
    assert.equal(
      classifyOwnerError(
        err(422, "VALIDATION_ERROR", "bad", [
          { field: "mfaCode", message: "x" },
        ]),
      ).kind,
      "field",
    );
  });
  test("404 means the assignment is gone; network and unknown errors keep the form with the mockup banner", () => {
    assert.deepEqual(classifyOwnerError(err(404, "NOT_FOUND", "x")), {
      kind: "banner",
      message: OWNER_COPY.stale,
    });
    for (const failure of [
      err(0, "NETWORK_ERROR", "offline"),
      err(500, "INTERNAL", "x"),
      null,
      "boom",
    ]) {
      assert.deepEqual(classifyOwnerError(failure), {
        kind: "banner",
        message: OWNER_COPY.failedBody,
      });
    }
  });
});

describe("screen state", () => {
  const base = { loading: false, loadFailed: false, owner: null, form: null };
  test("loading and load error come first", () => {
    assert.equal(ownerView({ ...base, loading: true, owner: DEWI }), "loading");
    assert.equal(ownerView({ ...base, loadFailed: true }), "load-error");
  });
  test("no Owner is the empty state; assign opens the form", () => {
    assert.equal(ownerView(base), "empty");
    assert.equal(ownerView({ ...base, form: "assign" }), "assign");
  });
  test("an Owner shows the normal state; replace opens the form", () => {
    assert.equal(ownerView({ ...base, owner: DEWI }), "owner");
    assert.equal(
      ownerView({ ...base, owner: DEWI, form: "replace" }),
      "replace",
    );
  });
  test("replace without a known assignment cannot open (no assignment id to send)", () => {
    assert.equal(ownerView({ ...base, form: "replace" }), "empty");
  });
});

describe("display and result", () => {
  test("shows name and email, falling back to the id", () => {
    assert.deepEqual(ownerDisplay(DEWI), {
      name: "Dewi Pratama",
      account: "dewi@example.com",
    });
    assert.equal(ownerLine(DEWI), "Dewi Pratama · dewi@example.com");
    const bare = { ...DEWI, name: null, email: null };
    assert.equal(ownerDisplay(bare).account, DEWI.userId);
    assert.equal(ownerDisplay(bare).name, "Akun 0192f1c0");
  });
  test("remembers the assignment id from the response with the picked account", () => {
    assert.deepEqual(
      ownerFromResult(
        { assignmentId: DEWI.assignmentId, userId: ANDI.userId },
        ANDI,
      ),
      {
        assignmentId: DEWI.assignmentId,
        userId: ANDI.userId,
        name: "Andi Saputra",
        email: "andi@example.com",
      },
    );
  });
});
