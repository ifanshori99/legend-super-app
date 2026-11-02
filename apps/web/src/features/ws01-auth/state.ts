// Pure decisions behind the staff security screens (bead legend-9bh, AUTH-05).
// No React and no framework imports, so the shared rules can be tested with
// node:test in tests/ws01-staff-auth.test.mjs. Components read these instead of
// re-deriving policy, and the numbers come from the identity contract
// (@starter/shared/identity) rather than from literals in the UI.
import {
  isSessionIdleWarning,
  loginMfaState,
  returnPathSchema,
  sessionGate,
  type CurrentAuthView,
  type MfaFactor,
  type Session,
  type SessionGate,
  type SessionView,
  type UserIdentity,
} from "@starter/shared/identity";

/** AUTH-05 state of the signed-in session on a guarded surface. */
export type SecondFactorState = {
  /** users.mfa_required: the role must use a second factor (PRD §3 F6). */
  readonly required: boolean;
  /** This session already verified a factor. */
  readonly verified: boolean;
  /** No factor enrolled yet: the user must enroll before verifying. */
  readonly enrollmentRequired: boolean;
  /** AUTH-05: guarded surfaces must refuse this session right now. */
  readonly blocked: boolean;
  /** The session is revoked or past its idle end; sign in again. */
  readonly ended: boolean;
  readonly gate: SessionGate;
};

/**
 * AUTH-05 and §3 F6 in one place: may this session use a guarded surface?
 * `sessionGate` is the contract's own verdict (revoked, expired, mfa_required,
 * ok); enrollment comes from `loginMfaState`.
 */
export function secondFactorState(
  auth: Pick<CurrentAuthView, "mfaRequired" | "session" | "mfaFactors">,
  now: Date,
): SecondFactorState {
  const gate = sessionGate({
    session: auth.session,
    mfaRequired: auth.mfaRequired,
    now,
  });
  return {
    required: auth.mfaRequired,
    verified: auth.session.mfaVerifiedAt !== null,
    enrollmentRequired: loginMfaState({
      mfaRequired: auth.mfaRequired,
      factorCount: auth.mfaFactors.length,
    }).enrollmentRequired,
    blocked: gate === "mfa_required",
    ended: gate === "revoked" || gate === "expired",
    gate,
  };
}

/**
 * AUTH-05: an MFA role must keep at least one factor, or the account can never
 * open the back office again. Removing the last one is refused in the UI; the
 * API enforces the same rule.
 */
export function canRemoveFactor(input: {
  readonly factors: readonly MfaFactor[];
  readonly mfaRequired: boolean;
}): boolean {
  return !(input.mfaRequired && input.factors.length <= 1);
}

/** Why a device row looks the way it does; "current" is a separate badge. */
export type SessionRowStatus = "ending" | "mfa_pending" | "active";

export function sessionRowStatus(input: {
  readonly view: SessionView;
  readonly mfaRequired: boolean;
  readonly now: Date;
}): SessionRowStatus {
  const { session } = input.view;
  // "Sesi akan berakhir" comes from the contract, not from a UI guess.
  if (isSessionIdleWarning({ session, now: input.now })) return "ending";
  if (
    input.mfaRequired &&
    session.kind === "management" &&
    session.mfaVerifiedAt === null
  )
    return "mfa_pending";
  return "active";
}

/** Whole minutes left before the idle end, never negative. */
export function minutesUntilExpiry(session: Session, now: Date): number {
  return Math.max(
    0,
    Math.ceil((Date.parse(session.expiresAt) - now.getTime()) / 60_000),
  );
}

/**
 * Show the idle dialog once per session end: dismissing it hides the warning
 * until the session's expiry moves (a later activity pushes it, so a new
 * warning is warranted then).
 *
 * The dismissal key is safe against the real API (legend-dw4d): a refetch
 * either returns the same deadline (GET /api/auth/me is not activity), or a
 * recorded activity (`touchSession`) moved it to now + 30 idle minutes — far
 * outside the 2-minute warning window — so a changed value inside the window
 * cannot occur. A mock that recomputed a near deadline per fetch broke that.
 */
export function idleWarningVisible(input: {
  readonly session: Session;
  readonly now: Date;
  /** The expiresAt value the user dismissed the dialog for, if any. */
  readonly dismissedFor: string | null;
}): boolean {
  if (!isSessionIdleWarning({ session: input.session, now: input.now }))
    return false;
  return input.dismissedFor !== input.session.expiresAt;
}

const LOGIN_PATH_PREFIXES = [
  "/masuk",
  "/sign-in",
  "/sign-up",
  "/verifikasi",
] as const;

/**
 * Where to go after a successful second factor. Only a path on this app
 * (contract `returnPathSchema`), and never back into the login or verification
 * flow, which would loop.
 */
export function safeReturnTo(
  value: string | undefined,
  fallback = "/kelola",
): string {
  const parsed = returnPathSchema.safeParse(value);
  if (!parsed.success) return fallback;
  if (LOGIN_PATH_PREFIXES.some((prefix) => parsed.data.startsWith(prefix)))
    return fallback;
  return parsed.data;
}

/** Six digits, separators ("123 456") tolerated; anything else is dropped. */
export function normalizeTotpCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

export function isTotpCodeComplete(value: string): boolean {
  return /^\d{6}$/.test(normalizeTotpCode(value));
}

/**
 * `safeReturnTo` already proved the path is on this app; the router's typed
 * `to` only knows the routes it generated, so this narrows for the call site.
 * The runtime value is the path itself.
 */
export function asAppPath(path: string): "/kelola" {
  return path as "/kelola";
}

/** The identity shown as "masuk sebagai" (primary first, masked by contract). */
export function primaryIdentity(
  identities: readonly UserIdentity[],
): UserIdentity | null {
  return (
    identities.find((identity) => identity.isPrimary) ?? identities[0] ?? null
  );
}
