// Identity state machines and decision rules (PRD v1.7 §3 F6/F7; AUTH-01..07).
// Pure functions: the API loads the row, passes `now`, and persists the
// returned value. No database, no clock, no crypto — the server hashes,
// compares digests in constant time and writes rows; this module decides.
//
// What the PRD asks for, and where it lands:
// - AUTH-01  code entropy/lifetime/single use/browser binding -> loginChallengeExpiry,
//            completeLoginChallenge, assertChallengeCompletable.
// - AUTH-04  5 challenges per device/IP per 15 min, 10 messages per number per
//            hour -> assertChallengeRateLimit, assertLoginMessageRateLimit.
// - AUTH-05  an MFA role cannot open a guarded surface without a second factor
//            -> loginMfaState, sessionGate (access owns the per-action check).
// - AUTH-06  an override records requester, approver, reason and value, and the
//            approver is never the requester -> assertApprovalRequestDecidable,
//            recordApprovalDecision (the POS override record itself is
//            access.posOverrideSchema).
// - AUTH-07  points need a verified WhatsApp number -> assertWhatsAppVerifiedForLoyalty.
// - §3 F6    sessions 90 days / 30 idle minutes -> newSessionExpiry,
//            recordSessionActivity, sessionGate, isSessionIdleWarning.
// - §3 F6    pin locked after 5 misses -> recordStaffPinAttempt.
// - §3 F7    approval deadlines and one decision per level -> approvalDeadlineAt,
//            recordApprovalDecision, expireApprovalRequest, nextApprovalLevel.
// - §3 F6    identity graph and merge -> assertIdentityLinkable,
//            planIdentityMerge, challengeCompletionAction.

import { CoreError, toIsoDateTime, type UserId } from "../core/index.ts";
import { AccessError } from "../access/index.ts";
import { IdentityError } from "./errors.ts";
import type { UserIdentityId } from "./ids.ts";
import {
  APPROVAL_DEADLINE_MINUTES,
  CHALLENGE_RATE_LIMIT,
  CHALLENGE_RATE_WINDOW_MINUTES,
  CUSTOMER_SESSION_DAYS,
  DAY_MS,
  GOOGLE_CHALLENGE_TTL_MINUTES,
  LOGIN_CODE_TTL_MINUTES,
  LOGIN_MESSAGE_RATE_LIMIT,
  LOGIN_MESSAGE_RATE_WINDOW_MINUTES,
  MAGIC_LINK_TTL_MINUTES,
  MANAGEMENT_IDLE_MINUTES,
  MAX_STAFF_PIN_ATTEMPTS,
  MINUTE_MS,
  SESSION_ACTIVITY_WRITE_SECONDS,
  SESSION_IDLE_WARNING_MINUTES,
  STAFF_PIN_LOCK_MINUTES,
} from "./limits.ts";
import type {
  ApprovalRequest,
  LoginChallenge,
  LoginChannel,
  LoginReplyPolicy,
  Session,
  SessionGate,
  SessionKind,
  StaffPinStatus,
  UserIdentity,
  UserIdentityType,
  UserStatus as UserStatusValue,
  User,
} from "./schemas.ts";
import { staffPinPattern, USER_STATUSES } from "./schemas.ts";

// ------------------------------------------------------- login challenges

/** AUTH-01: 5 minutes for a WhatsApp code; the email and Google windows differ. */
export function loginChallengeExpiry(
  channel: LoginChannel,
  issuedAt: Date,
): Date {
  const minutes =
    channel === "whatsapp_inbound"
      ? LOGIN_CODE_TTL_MINUTES
      : channel === "email_magic_link"
        ? MAGIC_LINK_TTL_MINUTES
        : GOOGLE_CHALLENGE_TTL_MINUTES;
  return new Date(issuedAt.getTime() + minutes * MINUTE_MS);
}

export function isLoginChallengeExpired(
  challenge: Pick<LoginChallenge, "expiresAt">,
  now: Date,
): boolean {
  return now.getTime() >= Date.parse(challenge.expiresAt);
}

/**
 * AUTH-01: pending and unexpired. Throws the identity error the login screen
 * maps; the code itself is matched by the server against the stored digest,
 * never here.
 *
 * Browser binding, per channel:
 * - `google`: the callback lands in a browser, so the binding (OAuth
 *   state cookie) is checked here, at completion.
 * - `whatsapp_inbound`: completion happens in the KirimDev webhook, which has
 *   no browser, so `browserBindingMatches` is ignored here. The binding is
 *   enforced when the polling browser collects the session
 *   (`claimLoginChallengeSession`) — the code alone never yields a session.
 * - `email_magic_link`: deliberately exempt. The guest clicks the link in
 *   whichever browser the mail app opens; the single-use 256-bit token is the
 *   proof and the session is set in that browser.
 */
export function assertChallengeCompletable(input: {
  readonly challenge: LoginChallenge;
  readonly browserBindingMatches: boolean;
  readonly now: Date;
}): void {
  if (input.challenge.status !== "pending")
    throw new IdentityError("CHALLENGE_NOT_PENDING");
  if (isLoginChallengeExpired(input.challenge, input.now))
    throw new IdentityError("CHALLENGE_EXPIRED");
  if (input.challenge.channel === "google" && !input.browserBindingMatches)
    throw new IdentityError("CHALLENGE_BROWSER_MISMATCH");
}

/**
 * AUTH-01 single use + browser binding for the WhatsApp code: the session of a
 * completed challenge is handed out once, and only to the browser holding the
 * binding cookie set when the challenge was created. A poll before completion
 * just shows `pending`; the service must not call this for it. Email and
 * Google set the session in their own completion request.
 */
export function assertLoginChallengeSessionClaimable(input: {
  readonly challenge: LoginChallenge;
  readonly browserBindingMatches: boolean;
  /** True once a session was issued for this challenge (stored server-side). */
  readonly sessionAlreadyIssued: boolean;
}): void {
  if (input.challenge.channel !== "whatsapp_inbound")
    throw new IdentityError("CHALLENGE_NOT_PENDING");
  if (!input.browserBindingMatches)
    throw new IdentityError("CHALLENGE_BROWSER_MISMATCH");
  if (input.challenge.status !== "completed" || input.sessionAlreadyIssued)
    throw new IdentityError("CHALLENGE_NOT_PENDING");
}

/**
 * Completes a challenge exactly once (AUTH-01: single use). The caller supplies
 * the account the sending number resolved to; a duplicate webhook therefore
 * hits a completed challenge and is rejected, never creating a second session.
 */
export function completeLoginChallenge(input: {
  readonly challenge: LoginChallenge;
  readonly browserBindingMatches: boolean;
  readonly matchedUserId: UserId;
  readonly completedAt: Date;
}): LoginChallenge {
  assertChallengeCompletable({ ...input, now: input.completedAt });
  return {
    ...input.challenge,
    status: "completed",
    matchedUserId: input.matchedUserId,
    completedAt: toIsoDateTime(input.completedAt),
  };
}

/** The sweep: a pending challenge past `expiresAt` becomes expired. Idempotent. */
export function expireLoginChallenge(
  challenge: LoginChallenge,
  now: Date,
): LoginChallenge {
  if (
    challenge.status !== "pending" ||
    !isLoginChallengeExpired(challenge, now)
  )
    return challenge;
  return { ...challenge, status: "expired" };
}

/** "Bukan saya": the user cancels the challenge from the same browser. */
export function cancelChallenge(challenge: LoginChallenge): LoginChallenge {
  if (challenge.status !== "pending") return challenge;
  return { ...challenge, status: "cancelled" };
}

/**
 * What completing the challenge means (§3 F6 "Penautan WhatsApp" + "Graf
 * Identitas Pelanggan"):
 * - no signed-in browser: sign in (create or match the account);
 * - signed in, number unknown: link it to the signed-in account;
 * - signed in, number belongs to this account: sign in again;
 * - signed in, number belongs to another account: merge the two accounts with
 *   their history intact — never a second session for the other account.
 */
export function challengeCompletionAction(input: {
  readonly authenticatedUserId: UserId | null;
  readonly resolvedUserId: UserId;
  /** Whether the sending number already had an account. */
  readonly identityKnown: boolean;
}): "sign_in" | "link" | "merge_required" {
  if (input.authenticatedUserId === null) return "sign_in";
  // A signed-in browser completes a challenge to link a new number to itself,
  // never to create a second account for that number.
  if (!input.identityKnown) return "link";
  const same =
    input.authenticatedUserId.toLowerCase() ===
    input.resolvedUserId.toLowerCase();
  return same ? "sign_in" : "merge_required";
}

/**
 * AUTH-04: at most 5 active challenges per device or IP in 15 minutes. The
 * caller passes the open challenges it counted for that device/IP.
 */
export function assertChallengeRateLimit(input: {
  readonly openChallengeOpenedAt: readonly Date[];
  readonly now: Date;
}): void {
  const windowStart =
    input.now.getTime() - CHALLENGE_RATE_WINDOW_MINUTES * MINUTE_MS;
  const open = input.openChallengeOpenedAt.filter(
    (openedAt) => openedAt.getTime() > windowStart,
  ).length;
  if (open >= CHALLENGE_RATE_LIMIT)
    throw new CoreError(
      "RATE_LIMITED",
      "Terlalu banyak permintaan masuk. Coba lagi dalam beberapa menit.",
    );
}

/** AUTH-04: at most 10 login messages per WhatsApp number per hour. */
export function assertLoginMessageRateLimit(input: {
  readonly messagesReceivedAt: readonly Date[];
  readonly now: Date;
}): void {
  const windowStart =
    input.now.getTime() - LOGIN_MESSAGE_RATE_WINDOW_MINUTES * MINUTE_MS;
  const received = input.messagesReceivedAt.filter(
    (receivedAt) => receivedAt.getTime() > windowStart,
  ).length;
  if (received >= LOGIN_MESSAGE_RATE_LIMIT)
    throw new CoreError(
      "RATE_LIMITED",
      "Terlalu banyak pesan masuk dari nomor ini. Coba lagi nanti.",
    );
}

/**
 * AUTH-03: no WhatsApp reply is sent by default. When a tenant enables replies,
 * one is sent only while the free monthly quota lasts; at the cap the login
 * still completes in the browser, the guest just gets no reply.
 */
export function shouldSendLoginReply(policy: LoginReplyPolicy): boolean {
  return policy.enabled && policy.repliesThisMonth < policy.freeMonthlyQuota;
}

export function recordLoginReply(policy: LoginReplyPolicy): {
  readonly policy: LoginReplyPolicy;
  readonly sent: boolean;
} {
  if (!shouldSendLoginReply(policy)) return { policy, sent: false };
  return {
    policy: { ...policy, repliesThisMonth: policy.repliesThisMonth + 1 },
    sent: true,
  };
}

// -------------------------------------------------------------- sessions

/** §3 F6: customer 90 days absolute; management starts with its idle window. */
export function newSessionExpiry(kind: SessionKind, createdAt: Date): Date {
  const lifetime =
    kind === "customer"
      ? CUSTOMER_SESSION_DAYS * DAY_MS
      : MANAGEMENT_IDLE_MINUTES * MINUTE_MS;
  return new Date(createdAt.getTime() + lifetime);
}

/**
 * AUTH-05 and §3 F6: why a session may not use the app right now. "expired"
 * covers both the 90-day customer end and the 30-minute management idle end
 * (expiresAt is the idle deadline and is pushed by user activity).
 */
export function sessionGate(input: {
  readonly session: Session;
  readonly mfaRequired: boolean;
  readonly now: Date;
}): SessionGate {
  if (input.session.revokedAt !== null) return "revoked";
  if (input.now.getTime() >= Date.parse(input.session.expiresAt))
    return "expired";
  if (input.mfaRequired && input.session.mfaVerifiedAt === null)
    return "mfa_required";
  return "ok";
}

/**
 * Activity ticks: a background poll never keeps a session alive, and a user
 * activity writes at most once a minute. A management session's idle deadline
 * moves; a customer session keeps its 90-day end.
 */
export function recordSessionActivity(input: {
  readonly session: Session;
  readonly now: Date;
  readonly kind: "user" | "background";
}): { readonly session: Session; readonly write: boolean } {
  const unchanged = { session: input.session, write: false };
  if (input.session.revokedAt !== null) return unchanged;
  if (input.now.getTime() >= Date.parse(input.session.expiresAt))
    return unchanged;
  if (input.kind === "background") return unchanged;
  if (
    input.now.getTime() - Date.parse(input.session.lastSeenAt) <
    SESSION_ACTIVITY_WRITE_SECONDS * 1000
  )
    return unchanged;
  const renewed = input.now.getTime() + MANAGEMENT_IDLE_MINUTES * MINUTE_MS;
  const expiresAt =
    input.session.kind === "management"
      ? new Date(
          Math.max(renewed, Date.parse(input.session.expiresAt)),
        ).toISOString()
      : input.session.expiresAt;
  return {
    session: {
      ...input.session,
      lastSeenAt: toIsoDateTime(input.now),
      expiresAt,
    },
    write: true,
  };
}

/** Show "Sesi akan berakhir" this close to the end. */
export function isSessionIdleWarning(input: {
  readonly session: Session;
  readonly now: Date;
}): boolean {
  if (input.session.kind !== "management") return false;
  if (input.session.revokedAt !== null) return false;
  const left = Date.parse(input.session.expiresAt) - input.now.getTime();
  return left > 0 && left <= SESSION_IDLE_WARNING_MINUTES * MINUTE_MS;
}

/**
 * AUTH-05: what the login result must tell the client. A guarded role with no
 * factor enrolled must enroll before it can verify.
 */
export function loginMfaState(input: {
  readonly mfaRequired: boolean;
  readonly factorCount: number;
}): { readonly mfaRequired: boolean; readonly enrollmentRequired: boolean } {
  return {
    mfaRequired: input.mfaRequired,
    enrollmentRequired: input.mfaRequired && input.factorCount === 0,
  };
}

// --------------------------------------------------------- identity graph

/**
 * Linking an identity to a user (§3 F6). The server looks the value up by its
 * digest; when it already belongs to a different account the flow is merge,
 * not link (IDENTITY_ALREADY_LINKED). Linking to the same account is a no-op.
 */
export function assertIdentityLinkable(input: {
  readonly ownerUserId: UserId | null;
  readonly userId: UserId;
}): void {
  if (
    input.ownerUserId !== null &&
    input.ownerUserId.toLowerCase() !== input.userId.toLowerCase()
  )
    throw new IdentityError("IDENTITY_ALREADY_LINKED");
}

/** AUTH-07: no verified WhatsApp number, no points. */
export function assertWhatsAppVerifiedForLoyalty(input: {
  readonly identities: readonly UserIdentity[];
}): void {
  const verified = input.identities.some(
    (identity) => identity.type === "whatsapp" && identity.verifiedAt !== null,
  );
  if (!verified) throw new IdentityError("WHATSAPP_VERIFICATION_REQUIRED");
}

/** The verified identity of one type, if any (UI: show its masked value). */
export function verifiedIdentityOf(
  identities: readonly UserIdentity[],
  type: UserIdentityType,
): UserIdentity | null {
  return (
    identities.find(
      (identity) => identity.type === type && identity.verifiedAt !== null,
    ) ?? null
  );
}

export type IdentityMergePlan = {
  /** The account that stays (§3 F6: history intact, older account survives). */
  readonly survivorId: UserId;
  /** The account folded into the survivor; the service disables/deletes it. */
  readonly mergedId: UserId;
  readonly movedIdentityIds: readonly UserIdentityId[];
  /** The verified WhatsApp identity that proves the merge, when one moved. */
  readonly verifiedWhatsAppIdentityId: UserIdentityId | null;
};

/**
 * "Bila dua akun terbukti memiliki nomor yang sama, keduanya digabung dengan
 * riwayat yang utuh." The older account survives (ties: smaller id), the other
 * account's identities move, and the verified WhatsApp number travels with
 * them. Orders, points and roles are re-pointed by the service in one
 * transaction — this plan only says which rows move.
 */
export function planIdentityMerge(input: {
  readonly a: Pick<User, "id" | "createdAt">;
  readonly b: Pick<User, "id" | "createdAt">;
  readonly identities: readonly UserIdentity[];
}): IdentityMergePlan {
  if (input.a.id.toLowerCase() === input.b.id.toLowerCase())
    throw new RangeError("A merge needs two different accounts");
  const aOlder =
    Date.parse(input.a.createdAt) < Date.parse(input.b.createdAt) ||
    (Date.parse(input.a.createdAt) === Date.parse(input.b.createdAt) &&
      input.a.id.toLowerCase() < input.b.id.toLowerCase());
  const survivor = aOlder ? input.a : input.b;
  const merged = aOlder ? input.b : input.a;
  const moved = input.identities.filter(
    (identity) => identity.userId.toLowerCase() === merged.id.toLowerCase(),
  );
  const verifiedWhatsApp =
    moved.find(
      (identity) =>
        identity.type === "whatsapp" && identity.verifiedAt !== null,
    ) ?? null;
  return {
    survivorId: survivor.id,
    mergedId: merged.id,
    movedIdentityIds: moved.map((identity) => identity.id),
    verifiedWhatsAppIdentityId: verifiedWhatsApp?.id ?? null,
  };
}

// -------------------------------------------------------------- user status

/** Allowed account status changes (§6 B users.status). Deleted is final. */
export const USER_STATUS_TRANSITIONS: Record<
  UserStatusValue,
  readonly UserStatusValue[]
> = {
  active: ["locked", "disabled", "deleted"],
  locked: ["active", "disabled", "deleted"],
  disabled: ["active", "deleted"],
  deleted: [],
};

export function assertUserStatusTransition(
  from: UserStatusValue,
  to: UserStatusValue,
): void {
  if (from === to) return;
  if (
    !USER_STATUSES.includes(to) ||
    !USER_STATUS_TRANSITIONS[from].includes(to)
  )
    throw new IdentityError("USER_STATUS_TRANSITION");
}

// -------------------------------------------------------------- staff pins

export type StaffPinAttemptState = Pick<
  StaffPinStatus,
  "failedAttempts" | "lockedUntil"
>;

export function isStaffPinLocked(
  state: StaffPinAttemptState,
  now: Date,
): boolean {
  return (
    state.lockedUntil !== null && Date.parse(state.lockedUntil) > now.getTime()
  );
}

export function assertStaffPinNotLocked(
  state: StaffPinAttemptState,
  now: Date,
): void {
  if (isStaffPinLocked(state, now)) throw new IdentityError("PIN_LOCKED");
}

/**
 * §3 F6 "PIN dikunci setelah 5 kali salah": the fifth miss locks for 15 minutes
 * (PRD names no release; a supervisor override clears it at once). A correct
 * pin clears the counter; a lock that has run out starts a fresh count.
 */
export function recordStaffPinAttempt(input: {
  readonly state: StaffPinAttemptState;
  readonly correct: boolean;
  readonly now: Date;
}): StaffPinAttemptState {
  assertStaffPinNotLocked(input.state, input.now);
  if (input.correct) return { failedAttempts: 0, lockedUntil: null };
  const lockRanOut =
    input.state.lockedUntil !== null &&
    Date.parse(input.state.lockedUntil) <= input.now.getTime();
  const failedAttempts = (lockRanOut ? 0 : input.state.failedAttempts) + 1;
  if (failedAttempts >= MAX_STAFF_PIN_ATTEMPTS)
    return {
      failedAttempts: MAX_STAFF_PIN_ATTEMPTS,
      lockedUntil: new Date(
        input.now.getTime() + STAFF_PIN_LOCK_MINUTES * MINUTE_MS,
      ).toISOString(),
    };
  return { failedAttempts, lockedUntil: null };
}

/** A supervisor override (AUTH-06) clears the lock immediately. */
export function resetStaffPinAttempts(): StaffPinAttemptState {
  return { failedAttempts: 0, lockedUntil: null };
}

/**
 * Reject pins a stranger guesses first: all one digit, or a straight run up or
 * down (123456, 654321). The PRD asks for 6 digits only; this is the safest
 * reading of "PIN pribadi" and is reported as a PRD-silent decision.
 */
export function isStrongStaffPin(pin: string): boolean {
  if (!staffPinPattern.test(pin)) return false;
  const digits = [...pin].map(Number);
  const first = digits[0] as number;
  if (digits.every((digit) => digit === first)) return false;
  const ascending = digits.every(
    (digit, index) =>
      index === 0 || digit === (digits[index - 1] as number) + 1,
  );
  const descending = digits.every(
    (digit, index) =>
      index === 0 || digit === (digits[index - 1] as number) - 1,
  );
  return !ascending && !descending;
}

export function assertStrongStaffPin(pin: string): void {
  if (!isStrongStaffPin(pin)) throw new IdentityError("WEAK_STAFF_PIN");
}

// -------------------------------------------------------- approval requests

/** §3 F7 "Kotak Approval ... dengan batas waktu": service-stamped deadline. */
export function approvalDeadlineAt(
  createdAt: Date,
  minutes: number = APPROVAL_DEADLINE_MINUTES,
): Date {
  return new Date(createdAt.getTime() + minutes * MINUTE_MS);
}

export function isApprovalRequestExpired(
  request: Pick<ApprovalRequest, "status" | "deadlineAt">,
  now: Date,
): boolean {
  return (
    request.status === "pending" &&
    now.getTime() >= Date.parse(request.deadlineAt)
  );
}

/**
 * Who may decide this row: it must still be pending, inside its deadline, and
 * the approver is never the requester (AUTH-06; §3 F7 "Penyetuju selalu
 * berbeda dari pemohon"). The approver's role and scope are checked by
 * access.assertApprovalDecisionAllowed with the matrix; this function is the
 * request lifecycle half.
 */
export function assertApprovalRequestDecidable(input: {
  readonly request: ApprovalRequest;
  readonly decidedBy: UserId;
  /**
   * Approvers of the earlier levels of the same chain (§6 approval_policies
   * requires_distinct_actor): HR then Finance are two people. Passed even when
   * access.assertApprovalDecisionAllowed already ran, so this lifecycle step
   * fails closed on its own.
   */
  readonly priorApproverIds: readonly UserId[];
  readonly now: Date;
}): void {
  if (input.request.status !== "pending")
    throw new IdentityError("APPROVAL_REQUEST_NOT_PENDING");
  if (isApprovalRequestExpired(input.request, input.now))
    throw new IdentityError("APPROVAL_REQUEST_EXPIRED");
  if (input.decidedBy.toLowerCase() === input.request.requestedBy.toLowerCase())
    throw new AccessError("APPROVER_IS_REQUESTER");
  if (
    input.priorApproverIds.some(
      (id) => id.toLowerCase() === input.decidedBy.toLowerCase(),
    )
  )
    throw new AccessError("APPROVER_ALREADY_DECIDED");
}

/**
 * Records the decision on this level's row. A rejection ends the chain; an
 * approval is followed by `nextApprovalLevel` creating the next row.
 */
export function recordApprovalDecision(input: {
  readonly request: ApprovalRequest;
  readonly decision: "approved" | "rejected";
  readonly decidedBy: UserId;
  readonly priorApproverIds: readonly UserId[];
  readonly reason: string;
  readonly now: Date;
}): ApprovalRequest {
  assertApprovalRequestDecidable(input);
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500)
    throw new RangeError("A decision reason is 3 to 500 characters");
  return {
    ...input.request,
    status: input.decision,
    decidedBy: input.decidedBy,
    decidedAt: toIsoDateTime(input.now),
    reason,
  };
}

/** The deadline sweep: a pending request past its deadline expires (fail closed). */
export function expireApprovalRequest(
  request: ApprovalRequest,
  now: Date,
): ApprovalRequest {
  if (!isApprovalRequestExpired(request, now)) return request;
  return { ...request, status: "expired" };
}

/** After an approved level, the level to open next; null when the chain is done. */
export function nextApprovalLevel(request: ApprovalRequest): number | null {
  if (request.status !== "approved") return null;
  if (request.level >= request.requiredLevels) return null;
  return request.level + 1;
}

/** The inbox shows pending, unexpired rows; expired rows wait for the sweep. */
export function approvalRequestIsOpen(
  request: ApprovalRequest,
  now: Date,
): boolean {
  return (
    request.status === "pending" && !isApprovalRequestExpired(request, now)
  );
}
