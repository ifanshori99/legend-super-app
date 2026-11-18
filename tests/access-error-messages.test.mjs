// Unit tests for the access error → catalog text mapping (bead legend-ddpr).
// Runs with the repo gate (`pnpm test` → root node:test suites) or directly:
//   node --test tests/access-error-messages.test.mjs
// (Node strips TS types natively; imports are relative or package paths, so no
// bundler alias is needed).
//
// Expectations are written against the catalog as it exists at run time: while
// `access.error.<CODE>` is absent the camelCase fallback must render; once
// legend-svza adds the keys, the same assertions check the new text instead,
// so this suite stays green across that merge.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ACCESS_ERROR_CODES } from "../packages/shared/src/access/errors.ts";
import {
  createTranslator,
  isMessageKey,
  messagesId,
} from "../packages/shared/src/i18n/index.ts";
import { ApiError } from "../apps/web/src/lib/api/errors.ts";
import { accessErrorMessage } from "../apps/web/src/features/ws01-access/errors.ts";

const t = createTranslator();
const keyEcho = (key) => key;
const apiError = (code, message = `server said ${code}`, details) =>
  new ApiError(400, code, message, details);

/** New catalog text when it exists, otherwise the fallback the mapper must use. */
function catalogText(code, fallback) {
  const key = `access.error.${code}`;
  return isMessageKey(key) ? t(key) : fallback;
}

/** Catalog text the mapper must use today for codes with a camelCase key. */
const todayText = [
  ["REAUTH_REQUIRED", messagesId.access.errors.reauthRequired],
  ["SELF_ELEVATION_FORBIDDEN", messagesId.access.errors.selfElevation],
  ["ROLE_NOT_ASSIGNABLE", messagesId.access.errors.roleNotAssignable],
  ["ROLE_SCOPE_NOT_ALLOWED", messagesId.access.errors.roleScopeNotAllowed],
  [
    "PERMISSION_NOT_IN_CATALOG",
    messagesId.access.errors.permissionNotInCatalog,
  ],
  ["APPROVER_IS_REQUESTER", messagesId.access.errors.approverIsRequester],
  ["PERMISSION_DENIED", messagesId.access.errors.forbid],
  ["FORBIDDEN", messagesId.access.errors.forbid],
  ["NOT_FOUND", messagesId.access.errors.notFound],
  ["CONFLICT", messagesId.access.errors.conflict],
  ["NETWORK_ERROR", messagesId.access.errors.offline],
];

describe("accessErrorMessage", () => {
  test("FORBIDDEN and PERMISSION_DENIED render the same permission text", () => {
    const forbidden = accessErrorMessage(apiError("FORBIDDEN"), t);
    const denied = accessErrorMessage(apiError("PERMISSION_DENIED"), t);
    assert.equal(
      forbidden,
      catalogText("PERMISSION_DENIED", messagesId.access.errors.forbid),
    );
    assert.equal(denied, forbidden);
  });

  test("FORBIDDEN and PERMISSION_DENIED share one catalog key after svza", () => {
    const known = new Set(
      ACCESS_ERROR_CODES.map((code) => `access.error.${code}`),
    );
    const hasKey = (key) => known.has(key) || isMessageKey(key);
    assert.equal(
      accessErrorMessage(apiError("PERMISSION_DENIED"), keyEcho, hasKey),
      "access.error.PERMISSION_DENIED",
    );
    assert.equal(
      accessErrorMessage(apiError("FORBIDDEN"), keyEcho, hasKey),
      "access.error.PERMISSION_DENIED",
    );
  });

  test("every access-domain code renders a non-empty string and never throws", () => {
    for (const code of ACCESS_ERROR_CODES) {
      let rendered = "";
      assert.doesNotThrow(() => {
        rendered = accessErrorMessage(apiError(code), t);
      }, code);
      assert.ok(rendered.length > 0, `${code} rendered an empty string`);
    }
  });

  test("camelCase catalog texts (or their access.error.* successors) win over the API message", () => {
    for (const [code, fallback] of todayText) {
      const expected = catalogText(
        code === "FORBIDDEN" ? "PERMISSION_DENIED" : code,
        fallback,
      );
      assert.equal(
        accessErrorMessage(apiError(code, "raw server text"), t),
        expected,
        code,
      );
    }
  });

  test("prefers access.error.<CODE> when the catalog has it", () => {
    const known = new Set(
      ACCESS_ERROR_CODES.map((code) => `access.error.${code}`),
    );
    const hasKey = (key) => known.has(key) || isMessageKey(key);
    for (const code of ACCESS_ERROR_CODES) {
      assert.equal(
        accessErrorMessage(apiError(code, "raw server text"), keyEcho, hasKey),
        `access.error.${code}`,
        code,
      );
    }
  });

  test("domain codes without a camelCase key fall back to the API message, then generic", () => {
    const mapped = new Set(todayText.map(([code]) => code));
    const messageOnly = ACCESS_ERROR_CODES.filter((code) => !mapped.has(code));
    assert.deepEqual(
      [...messageOnly].sort(),
      [
        "APPROVAL_LEVEL_OUT_OF_ORDER",
        "APPROVAL_POLICY_MISSING",
        "APPROVER_ALREADY_DECIDED",
        "APPROVER_ROLE_MISMATCH",
        "MFA_REQUIRED",
        "PERMISSION_OWNER_ONLY",
        "SUPPLIER_PAYMENT_BASE_TIER_REQUIRED",
      ],
      "update todayText when an access code gains a camelCase key",
    );
    for (const code of messageOnly) {
      const message = `server said ${code}`;
      assert.equal(
        accessErrorMessage(apiError(code, message), t),
        catalogText(code, message),
        code,
      );
    }
    const blank = "MFA_REQUIRED";
    assert.equal(
      accessErrorMessage(apiError(blank, ""), t),
      catalogText(blank, messagesId.access.errors.generic),
    );
  });

  test("VALIDATION_ERROR prefers the first field detail", () => {
    const details = [{ field: "name", message: "name is required" }];
    assert.equal(
      accessErrorMessage(apiError("VALIDATION_ERROR", "invalid", details), t),
      "name is required",
    );
    assert.equal(
      accessErrorMessage(apiError("VALIDATION_ERROR", "invalid", []), t),
      messagesId.access.errors.invalid,
    );
    assert.equal(
      accessErrorMessage(apiError("VALIDATION_ERROR", "server text"), t),
      messagesId.access.errors.invalid,
    );
  });

  test("an unmapped code falls back to the API message, then generic", () => {
    assert.equal(
      accessErrorMessage(apiError("SOMETHING_NEW", "server said nope"), t),
      "server said nope",
    );
    assert.equal(
      accessErrorMessage(apiError("SOMETHING_NEW", ""), t),
      messagesId.access.errors.generic,
    );
  });

  test("non-ApiError values render the generic text and never throw", () => {
    const values = [
      new Error("boom"),
      "boom",
      42,
      null,
      undefined,
      { code: "FORBIDDEN" },
    ];
    for (const value of values)
      assert.equal(
        accessErrorMessage(value, t),
        messagesId.access.errors.generic,
        String(value),
      );
  });
});
