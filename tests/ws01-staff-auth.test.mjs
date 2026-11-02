// Staff second factor + device sessions (bead legend-9bh; PRD v1.7 §3 F6
// "Staf — Login Web", "Sesi & Perangkat", AUTH-05). Pure logic of
// apps/web/src/features/ws01-auth/state.ts, checked against the identity
// contract and its fixtures. Acceptance ID in every test name: AUTH-05.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, test } from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
        return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const identity = await import("../packages/shared/src/identity/index.ts");
const state = await import("../apps/web/src/features/ws01-auth/state.ts");

const fixtures = identity.cafeLegendIdentityFixtures;
const owner = fixtures.usersByKey.owner;
const ownerFactors = fixtures.mfaFactors.filter((row) => row.userId === owner.id);
const managementSession = fixtures.sessions.find(
  (row) => row.userId === owner.id && row.kind === "management",
);
const nearEndSession = fixtures.sessions.find(
  (row) => row.userId === owner.id && row.deviceLabel === "Chrome di iPhone",
);

const authOf = (overrides = {}) => ({
  mfaRequired: true,
  mfaFactors: ownerFactors,
  session: managementSession,
  ...overrides,
});

describe("AUTH-05 staff second factor", () => {
  test("AUTH-05: a management session without a verified factor stays closed", () => {
    const result = state.secondFactorState(
      authOf({ session: { ...managementSession, mfaVerifiedAt: null } }),
      fixtures.now,
    );
    assert.equal(result.required, true);
    assert.equal(result.verified, false);
    assert.equal(result.enrollmentRequired, false);
    assert.equal(result.blocked, true);
    assert.equal(result.ended, false);
    assert.equal(result.gate, "mfa_required");
  });

  test("AUTH-05: an MFA role with no factor enrolled must enroll before verifying", () => {
    const result = state.secondFactorState(
      authOf({
        mfaFactors: [],
        session: { ...managementSession, mfaVerifiedAt: null },
      }),
      fixtures.now,
    );
    assert.equal(result.enrollmentRequired, true);
    assert.equal(result.blocked, true);
  });

  test("AUTH-05: a verified session opens the guarded surface", () => {
    const result = state.secondFactorState(
      authOf({
        session: {
          ...managementSession,
          mfaVerifiedAt: "2026-11-01T04:50:00.000Z",
        },
      }),
      fixtures.now,
    );
    assert.equal(result.verified, true);
    assert.equal(result.blocked, false);
    assert.equal(result.gate, "ok");
  });

  test("AUTH-05: a role without MFA does not block on a missing factor", () => {
    const cashier = fixtures.usersByKey.cashier;
    const result = state.secondFactorState(
      {
        mfaRequired: cashier.mfaRequired,
        mfaFactors: [],
        session: {
          ...managementSession,
          userId: cashier.id,
          mfaVerifiedAt: null,
        },
      },
      fixtures.now,
    );
    assert.equal(result.required, false);
    assert.equal(result.blocked, false);
    assert.equal(result.enrollmentRequired, false);
  });

  test("AUTH-05: a revoked or idle-expired session is ended, not unverified", () => {
    const revoked = state.secondFactorState(
      authOf({
        session: {
          ...managementSession,
          revokedAt: "2026-11-01T04:55:00.000Z",
        },
      }),
      fixtures.now,
    );
    assert.equal(revoked.ended, true);
    assert.equal(revoked.blocked, false);
    assert.equal(revoked.gate, "revoked");

    const expired = state.secondFactorState(
      authOf({
        session: {
          ...managementSession,
          expiresAt: "2026-11-01T04:00:00.000Z",
        },
      }),
      fixtures.now,
    );
    assert.equal(expired.ended, true);
    assert.equal(expired.gate, "expired");
  });

  test("AUTH-05: the last factor of an MFA role cannot be removed", () => {
    const [totp] = ownerFactors;
    assert.equal(
      state.canRemoveFactor({ factors: [totp], mfaRequired: true }),
      false,
    );
    assert.equal(
      state.canRemoveFactor({ factors: ownerFactors, mfaRequired: true }),
      true,
    );
    // A role that does not require MFA may go back to no factor at all.
    assert.equal(
      state.canRemoveFactor({ factors: [totp], mfaRequired: false }),
      true,
    );
  });
});

describe("AUTH-05 session warning", () => {
  test("AUTH-05: the idle warning starts two minutes before a management session ends", () => {
    const view = { session: nearEndSession, current: false };
    assert.equal(
      state.sessionRowStatus({ view, mfaRequired: true, now: fixtures.now }),
      "ending",
    );
    // 90 seconds left at fixtures.now.
    assert.equal(
      state.minutesUntilExpiry(nearEndSession, fixtures.now),
      2,
    );
    assert.equal(
      state.idleWarningVisible({
        session: nearEndSession,
        now: fixtures.now,
        dismissedFor: null,
      }),
      true,
    );
    // Dismissed for this expiry: stays quiet until the deadline moves.
    assert.equal(
      state.idleWarningVisible({
        session: nearEndSession,
        now: fixtures.now,
        dismissedFor: nearEndSession.expiresAt,
      }),
      false,
    );
  });

  test("AUTH-05: a management session that still owes MFA is marked waiting", () => {
    const view = {
      session: {
        ...managementSession,
        mfaVerifiedAt: null,
        expiresAt: "2026-11-01T05:28:00.000Z",
      },
      current: true,
    };
    assert.equal(
      state.sessionRowStatus({ view, mfaRequired: true, now: fixtures.now }),
      "mfa_pending",
    );
  });
});

describe("AUTH-05 return path and code entry", () => {
  test("AUTH-05: verification only returns to a path on this app", () => {
    assert.equal(state.safeReturnTo("/kelola/menu"), "/kelola/menu");
    assert.equal(state.safeReturnTo("/platform/keamanan"), "/platform/keamanan");
    assert.equal(state.safeReturnTo("https://evil.example"), "/kelola");
    assert.equal(state.safeReturnTo("//evil.example"), "/kelola");
    assert.equal(state.safeReturnTo("/masuk/email"), "/kelola");
    assert.equal(state.safeReturnTo("/sign-in"), "/kelola");
    assert.equal(state.safeReturnTo("/verifikasi"), "/kelola");
    assert.equal(state.safeReturnTo(undefined), "/kelola");
    assert.equal(
      state.safeReturnTo(undefined, "/platform/keamanan"),
      "/platform/keamanan",
    );
  });

  test("AUTH-05: a TOTP code is six digits, separators tolerated", () => {
    assert.equal(state.normalizeTotpCode("12 34-56"), "123456");
    assert.equal(state.normalizeTotpCode("1234567"), "123456");
    assert.equal(state.normalizeTotpCode("12ab34"), "1234");
    assert.equal(state.isTotpCodeComplete("123456"), true);
    assert.equal(state.isTotpCodeComplete("123 456"), true);
    assert.equal(state.isTotpCodeComplete("12345"), false);
    assert.equal(state.isTotpCodeComplete(""), false);
  });
});
