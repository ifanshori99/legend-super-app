// Wire DTOs for identity & access (PRD v1.7 §3 F6 "Autentikasi & Identitas",
// §3 F7 "RBAC, Organisasi & Matriks Approval", §6 B). One strict schema per
// table/aggregate the API exchanges; request bodies live in `inputs.ts`, HTTP
// contracts in `endpoints.ts`.
//
// Conventions (docs/plan/contracts.md): branded ids, ISO instants with offset,
// camelCase keys, money in whole rupiah (*Idr). Rows marked (global) in §6 B
// (users, user_identities, login_challenges, sessions, mfa_factors) carry no
// tenantId unless §6 gives one; tenant rows (staff_pins, approval_requests)
// carry tenant_id and outlet_id where the action is outlet-owned.
//
// Secrets never appear in a wire DTO: a code, magic-link token, browser
// binding, session token, TOTP secret, passkey key or staff pin is stored and
// compared as a keyed digest (`identityDigestSchema`) or ciphertext
// (`identityCiphertextSchema`), shown once at issue, and never logged, audited
// or put in an event. The server-side records are the API's insert types, not
// part of the wire surface.
//
// RBAC rows (roles, role_assignments, approval_policies) are owned by the
// access contract (`@starter/shared/access`, bead legend-0mc) and are imported,
// never redefined here.

import {
  brandIdSchema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  ulidSchema,
  userIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import {
  APPROVAL_MAX_LEVELS,
  approvalActionTypeSchema,
  approvalSourceSchema,
  SELF_APPROVABLE_ACTION_TYPES,
} from "../access/index.ts";
import {
  approvalRequestIdSchema,
  loginChallengeIdSchema,
  mfaFactorIdSchema,
  staffPinIdSchema,
  sessionIdSchema,
  userIdentityIdSchema,
} from "./ids.ts";
import { LOGIN_CODE_PATTERN } from "./login-code.ts";
import { MAX_STAFF_PIN_ATTEMPTS, STAFF_PIN_LENGTH } from "./limits.ts";

/**
 * A keyed digest (HMAC-SHA-256, lowercase hex): code_hash,
 * browser_binding_hash, sessions.token_hash, staff_pins.pin_hash,
 * user_identities.value_hash and login_challenges.ip_hash (§6 B VARCHAR(64)).
 * A keyed digest, never a bare hash: phone numbers and 6-digit pins are
 * enumerable in milliseconds otherwise.
 */
export const IDENTITY_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const identityDigestSchema = z
  .string()
  .regex(
    IDENTITY_DIGEST_PATTERN,
    "Expected a 64-character lowercase hex digest",
  );
export type IdentityDigest = z.infer<typeof identityDigestSchema>;

/** AES-GCM ciphertext (base64) for a stored identity value or TOTP secret. */
export const identityCiphertextSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Expected base64 ciphertext")
  .min(16)
  .max(1024);

// ---------------------------------------------------------------- accounts

/** §6 B `users` (global). One account, staff or customer or both. */
export const USER_KINDS = ["customer", "staff", "both"] as const;
export const userKindSchema = z.enum(USER_KINDS);
export type UserKind = z.infer<typeof userKindSchema>;

export const USER_STATUSES = [
  "active",
  "locked",
  "disabled",
  "deleted",
] as const;
export const userStatusSchema = z.enum(USER_STATUSES);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const userSchema = z.strictObject({
  id: userIdSchema,
  displayName: z.string().trim().min(1).max(150),
  kind: userKindSchema,
  status: userStatusSchema,
  /** Set automatically for the roles §3 F6 says must use MFA. */
  mfaRequired: z.boolean(),
  lastLoginAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type User = z.infer<typeof userSchema>;

// ------------------------------------------------------- identity graph

/** §6 B `user_identities.type`. */
export const USER_IDENTITY_TYPES = ["whatsapp", "email", "google"] as const;
export const userIdentityTypeSchema = z.enum(USER_IDENTITY_TYPES);
export type UserIdentityType = z.infer<typeof userIdentityTypeSchema>;

/**
 * One identity on the wire (§3 F6 "Graf Identitas Pelanggan"). The raw value
 * and its digest are server-side; the UI sees the mask only. A verified
 * WhatsApp identity is the customer profile key per tenant (AUTH-07).
 */
export const userIdentitySchema = z.strictObject({
  id: userIdentityIdSchema,
  userId: userIdSchema,
  type: userIdentityTypeSchema,
  valueMasked: z.string().min(3).max(150),
  isPrimary: z.boolean(),
  verifiedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type UserIdentity = z.infer<typeof userIdentitySchema>;

/** Canonical WhatsApp number (digits, no plus), see normalizeWhatsAppNumber. */
export const whatsAppNumberSchema = z
  .string()
  .regex(/^[1-9]\d{7,14}$/, "Expected a WhatsApp number in digits");

/**
 * Where the user goes after signing in: a path on this app, never another
 * origin. Browsers turn `\` into `/` and drop tab/CR/LF inside URLs, so
 * `/\evil.example` and `/<TAB>/evil.example` both become `//evil.example`
 * (open redirect); backslashes and whitespace are refused like
 * notification `inAppLinkSchema`.
 */
export const returnPathSchema = z
  .string()
  .max(300)
  .regex(/^\/(?!\/)[^\s\\]*$/, "Expected a path on this app");

/** A server-built URL the browser navigates to: https only (no `javascript:`). */
const httpsUrlSchema = z.url({ protocol: /^https$/ });

// ------------------------------------------------------- login challenges

/** §6 B `login_challenges.channel`. */
export const LOGIN_CHANNELS = [
  "whatsapp_inbound",
  "email_magic_link",
  "google",
] as const;
export const loginChannelSchema = z.enum(LOGIN_CHANNELS);
export type LoginChannel = z.infer<typeof loginChannelSchema>;

/** §6 B `login_challenges.status`. */
export const LOGIN_CHALLENGE_STATUSES = [
  "pending",
  "completed",
  "expired",
  "cancelled",
] as const;
export const loginChallengeStatusSchema = z.enum(LOGIN_CHALLENGE_STATUSES);
export type LoginChallengeStatus = z.infer<typeof loginChallengeStatusSchema>;

/**
 * §6 B `login_challenges` as the browser may see it. Hashes, IP and user agent
 * stay server-side; `matchedUserId`/`completedAt` exist only on a completed
 * challenge. `tenantId` is null for a platform (Super Admin) login, which has
 * no tenant context yet (TEN-02).
 */
export const loginChallengeSchema = z
  .strictObject({
    id: loginChallengeIdSchema,
    tenantId: tenantIdSchema.nullable(),
    brandId: brandIdSchema.nullable(),
    channel: loginChannelSchema,
    status: loginChallengeStatusSchema,
    expiresAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable(),
    matchedUserId: userIdSchema.nullable(),
    createdAt: isoDateTimeSchema,
  })
  .superRefine((challenge, ctx) => {
    const add = (path: string[], message: string, invalid: boolean) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    add(
      ["brandId"],
      "A brand context needs its tenant",
      challenge.brandId !== null && challenge.tenantId === null,
    );
    add(
      ["expiresAt"],
      "A challenge must expire after it is created",
      Date.parse(challenge.expiresAt) <= Date.parse(challenge.createdAt),
    );
    const completed = challenge.status === "completed";
    add(
      ["completedAt"],
      "Only a completed challenge records when it completed",
      completed !== (challenge.completedAt !== null),
    );
    add(
      ["matchedUserId"],
      "Only a completed challenge records the matched user",
      completed !== (challenge.matchedUserId !== null),
    );
  });
export type LoginChallenge = z.infer<typeof loginChallengeSchema>;

/** One-time magic-link token: 32 random bytes, base64url (43 chars). */
export const magicLinkTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Expected a base64url token");

/** Secret browser-binding cookie set when a challenge is created (AUTH-01). */
export const browserBindingTokenSchema = magicLinkTokenSchema;

/** The code to display once: canonical alphabet, no separators. */
export const loginCodeSchema = z.string().regex(LOGIN_CODE_PATTERN);

/**
 * A freshly created WhatsApp challenge: the code and deep link are shown in the
 * requesting browser and never again (AUTH-01). No message is sent to the
 * guest (AUTH-03); the phone is only where they send the filled-in message.
 */
export const loginChallengeIssuedSchema = z.strictObject({
  challenge: loginChallengeSchema,
  code: loginCodeSchema,
  codeFormatted: z.string().min(9).max(9),
  whatsAppDeepLink: httpsUrlSchema,
});
export type LoginChallengeIssued = z.infer<typeof loginChallengeIssuedSchema>;

/**
 * The answer to an email request is identical whether the address exists
 * (account enumeration). The link itself arrives by email.
 */
export const magicLinkRequestedSchema = z.strictObject({
  sent: z.literal(true),
  expiresAt: isoDateTimeSchema,
});
export type MagicLinkRequested = z.infer<typeof magicLinkRequestedSchema>;

// legend-k2l: body of POST /api/auth/login-challenges/email/verify. The token
// comes from the link's URL fragment (it never reaches a server log), so the
// page posts it instead of the API reading a query string.
export const magicLinkVerifyBodySchema = z.strictObject({
  token: magicLinkTokenSchema,
});
export type MagicLinkVerifyBody = z.infer<typeof magicLinkVerifyBodySchema>;

// legend-fy5y: body of POST /api/auth/login-challenges/invitation. The link is
// on the platform origin (a new tenant has no domain yet), so the tenant id
// travels in the fragment next to the token. It is client input: the service
// only ever uses it to find the row whose token digest also matches.
export const invitationAcceptBodySchema = z.strictObject({
  token: magicLinkTokenSchema,
  tenantId: tenantIdSchema,
});
export type InvitationAcceptBody = z.infer<typeof invitationAcceptBodySchema>;

/** The accept marks the email verified; it issues no session. */
export const invitationAcceptedSchema = z.strictObject({
  verified: z.literal(true),
});
export type InvitationAccepted = z.infer<typeof invitationAcceptedSchema>;

// legend-k2l: what a verified magic link yields. The session itself travels in
// the Set-Cookie header; `crossDevice` tells the page the link was opened in
// another browser than the one that asked (design ws08 M2: such a session may
// not start a WhatsApp link without a fresh proof).
export const magicLinkVerifiedSchema = z.strictObject({
  userId: userIdSchema,
  crossDevice: z.boolean(),
});
export type MagicLinkVerified = z.infer<typeof magicLinkVerifiedSchema>;

/** Google OAuth start: the API builds the URL including its state (browser-bound). */
export const googleLoginStartSchema = z.strictObject({
  authorizationUrl: httpsUrlSchema,
});

// ---------------------------------------------------------------- sessions

/** §3 F6: customer sessions 90 days, management sessions end after 30 idle minutes. */
export const SESSION_KINDS = ["customer", "management"] as const;
export const sessionKindSchema = z.enum(SESSION_KINDS);
export type SessionKind = z.infer<typeof sessionKindSchema>;

/** Why a session ended early; also the `session.revoked` payload. */
export const SESSION_REVOCATION_REASONS = [
  "signed_out",
  "revoked_by_user",
  "revoked_by_admin",
  "account_locked",
  "merged",
] as const;
export const sessionRevocationReasonSchema = z.enum(SESSION_REVOCATION_REASONS);
export type SessionRevocationReason = z.infer<
  typeof sessionRevocationReasonSchema
>;

/**
 * §6 B `sessions` as the owner sees it (device list). `tenantId` is null for a
 * platform session. `mfaVerifiedAt` is when the second factor was verified in
 * this session (AUTH-05); a management session without it is `mfa_required`.
 */
export const sessionSchema = z
  .strictObject({
    id: sessionIdSchema,
    userId: userIdSchema,
    tenantId: tenantIdSchema.nullable(),
    kind: sessionKindSchema,
    deviceLabel: z.string().trim().min(1).max(120),
    createdAt: isoDateTimeSchema,
    lastSeenAt: isoDateTimeSchema,
    expiresAt: isoDateTimeSchema,
    revokedAt: isoDateTimeSchema.nullable(),
    mfaVerifiedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((session, ctx) => {
    const add = (path: string[], message: string, invalid: boolean) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    add(
      ["lastSeenAt"],
      "lastSeenAt cannot precede createdAt",
      Date.parse(session.lastSeenAt) < Date.parse(session.createdAt),
    );
    add(
      ["expiresAt"],
      "A session must expire after it is created",
      Date.parse(session.expiresAt) <= Date.parse(session.createdAt),
    );
    add(
      ["revokedAt"],
      "revokedAt cannot precede createdAt",
      session.revokedAt !== null &&
        Date.parse(session.revokedAt) < Date.parse(session.createdAt),
    );
    add(
      ["mfaVerifiedAt"],
      "mfaVerifiedAt cannot precede createdAt",
      session.mfaVerifiedAt !== null &&
        Date.parse(session.mfaVerifiedAt) < Date.parse(session.createdAt),
    );
  });
export type Session = z.infer<typeof sessionSchema>;

/** One row of the device list; `current` marks the session making the request. */
export const sessionViewSchema = z.strictObject({
  session: sessionSchema,
  current: z.boolean(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

/**
 * legend-gchkf: one browser registered for panic-alarm web push by the
 * caller. Listed even when its login session has expired (`sessionActive`
 * false), so a lost phone can still be revoked. Never carries the push
 * endpoint, keys, ciphertext or hash.
 */
export const pushDeviceSchema = z.strictObject({
  id: uuidSchema,
  deviceLabel: z.string().nullable(),
  registeredAt: isoDateTimeSchema,
  sessionActive: z.boolean(),
  /** True when the device was registered by the caller's current login session. */
  current: z.boolean(),
});
export type PushDevice = z.infer<typeof pushDeviceSchema>;

/** What a completed login yields: the session cookie plus MFA next steps. */
export const loginResultSchema = z.strictObject({
  session: sessionSchema,
  mfaRequired: z.boolean(),
  mfaEnrollmentRequired: z.boolean(),
});
export type LoginResult = z.infer<typeof loginResultSchema>;

// --------------------------------------------------------------------- MFA

/** §6 B `mfa_factors.type`; TOTP or passkey (PRD §3 F6 "Staf — Login Web"). */
export const MFA_FACTOR_TYPES = ["totp", "passkey"] as const;
export const mfaFactorTypeSchema = z.enum(MFA_FACTOR_TYPES);
export type MfaFactorType = z.infer<typeof mfaFactorTypeSchema>;

export const mfaFactorSchema = z.strictObject({
  id: mfaFactorIdSchema,
  userId: userIdSchema,
  type: mfaFactorTypeSchema,
  createdAt: isoDateTimeSchema,
});
export type MfaFactor = z.infer<typeof mfaFactorSchema>;

/** Base32 TOTP secret (160 bits); shown once at enrollment, never stored raw. */
export const TOTP_SECRET_PATTERN = /^[A-Z2-7]{32}$/;

export const totpEnrollmentSchema = z.strictObject({
  type: z.literal("totp"),
  factorId: mfaFactorIdSchema,
  secretBase32: z.string().regex(TOTP_SECRET_PATTERN),
  otpauthUri: z.string().startsWith("otpauth://totp/"),
  expiresAt: isoDateTimeSchema,
});
export type TotpEnrollment = z.infer<typeof totpEnrollmentSchema>;

export const passkeyEnrollmentSchema = z.strictObject({
  type: z.literal("passkey"),
  factorId: mfaFactorIdSchema,
  /** WebAuthn PublicKeyCredentialCreationOptions, JSON-safe. */
  publicKeyOptions: z.json(),
});
export type PasskeyEnrollment = z.infer<typeof passkeyEnrollmentSchema>;

/** Authentication options for an enrolled passkey (one challenge per session). */
export const mfaChallengeSchema = z.strictObject({
  factorId: mfaFactorIdSchema,
  /** WebAuthn PublicKeyCredentialRequestOptions, JSON-safe. */
  publicKeyOptions: z.json(),
});
export type MfaChallenge = z.infer<typeof mfaChallengeSchema>;

export const mfaEnrollmentSchema = z.discriminatedUnion("type", [
  totpEnrollmentSchema,
  passkeyEnrollmentSchema,
]);
export type MfaEnrollment = z.infer<typeof mfaEnrollmentSchema>;

export const mfaVerificationResultSchema = z.strictObject({
  factorId: mfaFactorIdSchema,
  verifiedAt: isoDateTimeSchema,
});
export type MfaVerificationResult = z.infer<typeof mfaVerificationResultSchema>;

/** Staff MFA recovery codes: a set of 10 single-use codes per user. */
export const MFA_RECOVERY_CODE_COUNT = 10;
/** Crockford base32 (no I, L, O, U), shown as `XXXXX-XXXXX`. */
export const MFA_RECOVERY_CODE_PATTERN =
  /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;

/** Plaintext codes appear once, in the generate response only. */
export const mfaRecoveryCodesSchema = z.strictObject({
  codes: z
    .array(z.string().regex(MFA_RECOVERY_CODE_PATTERN))
    .length(MFA_RECOVERY_CODE_COUNT),
  generatedAt: isoDateTimeSchema,
});
export type MfaRecoveryCodes = z.infer<typeof mfaRecoveryCodesSchema>;

export const mfaRecoveryStatusSchema = z.strictObject({
  remaining: z.number().int().min(0).max(MFA_RECOVERY_CODE_COUNT),
  generatedAt: isoDateTimeSchema.nullable(),
});
export type MfaRecoveryStatus = z.infer<typeof mfaRecoveryStatusSchema>;

export const mfaRecoveryVerificationResultSchema = z.strictObject({
  verifiedAt: isoDateTimeSchema,
  remaining: z.number().int().min(0).max(MFA_RECOVERY_CODE_COUNT),
});
export type MfaRecoveryVerificationResult = z.infer<
  typeof mfaRecoveryVerificationResultSchema
>;

/** Poll result of the requesting browser; the session appears once completed. */
export const loginChallengeViewSchema = z.strictObject({
  challenge: loginChallengeSchema,
  session: sessionSchema.nullable(),
  mfaRequired: z.boolean(),
  mfaEnrollmentRequired: z.boolean(),
  /** Card w8dfz.1: masked sender ("+62 812-****-7890"), only while awaiting. */
  senderMasked: z.string().max(40).optional(),
  /** Card w8dfz.1: the message landed; no session until the person confirms. */
  awaitingConfirmation: z.boolean().optional(),
});
export type LoginChallengeView = z.infer<typeof loginChallengeViewSchema>;

/** GET /api/auth/me: everything the shell needs to render identity state. */
export const currentAuthViewSchema = z.strictObject({
  user: userSchema,
  identities: z.array(userIdentitySchema),
  mfaFactors: z.array(mfaFactorSchema),
  session: sessionSchema,
  mfaRequired: z.boolean(),
  mfaEnrollmentRequired: z.boolean(),
  whatsAppVerified: z.boolean(),
});
export type CurrentAuthView = z.infer<typeof currentAuthViewSchema>;

// -------------------------------------------------------------- staff pins

/** Six digits; the PRD fixes 6 (§3 F6 "Staf — PIN Perangkat"). */
export const staffPinPattern = new RegExp(`^\\d{${STAFF_PIN_LENGTH}}$`);

/**
 * §6 B `staff_pins` (tenant + outlet row) as the device may see it. The hash
 * stays server-side; the device only needs the lock state.
 */
export const staffPinStatusSchema = z.strictObject({
  id: staffPinIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  userId: userIdSchema,
  failedAttempts: z.number().int().min(0).max(MAX_STAFF_PIN_ATTEMPTS),
  lockedUntil: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type StaffPinStatus = z.infer<typeof staffPinStatusSchema>;

/** Result of a successful pin switch on a registered outlet device. */
export const staffPinSwitchSchema = z.strictObject({
  user: userSchema,
  outletId: outletIdSchema,
  verifiedAt: isoDateTimeSchema,
  /** Only when the verify asked for `purpose: "attendance_clock"` (legend-u7g9w). */
  proof: z
    .strictObject({
      token: z.string().min(1).max(100),
      expiresAt: isoDateTimeSchema,
    })
    .optional(),
});
export type StaffPinSwitch = z.infer<typeof staffPinSwitchSchema>;

// --------------------------------------------------------- approval requests

/**
 * §6 B `approval_requests.status`. One row is one level's decision (§3 F7
 * "Matriks Approval": payroll is "HR lalu Finance atau Owner"), because §6
 * gives a single decided_by/decided_at/reason. The service creates the next
 * level's row when the previous level approves; a rejection or expiry ends the
 * chain.
 */
export const APPROVAL_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
] as const;
export const approvalRequestStatusSchema = z.enum(APPROVAL_REQUEST_STATUSES);
export type ApprovalRequestStatus = z.infer<typeof approvalRequestStatusSchema>;

/** Polymorphic object type: one snake_case word (§6 note, service-checked). */
export const objectTypeSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
    "objectType is one snake_case word (e.g. order, menu_item)",
  );

/** A polymorphic object reference: §6 note — integrity is a service concern. */
export const objectIdSchema = z.union([uuidSchema, ulidSchema]);

/**
 * One `approval_requests` row (§6 B) — one level of one request.
 *
 * `requestReason` is the requester's justification, required by AUTH-06 for an
 * override ("alasan") and shown on the inbox card; `reason` is the approver's
 * decision note (the §6 column next to decided_by/decided_at, F7 "approve/
 * reject with reason"). `amountIdr` is the value the matrix tiered on; null
 * when the action has no amount. `payload` is the action's data snapshot; AI
 * and MCP sources carry the human they act for in `requestedBy` (PRD §4 Q).
 */
export const approvalRequestSchema = z
  .strictObject({
    id: approvalRequestIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema.nullable(),
    actionType: approvalActionTypeSchema,
    objectType: objectTypeSchema,
    objectId: objectIdSchema,
    payload: z.record(z.string(), z.json()),
    requestedBy: userIdSchema,
    source: approvalSourceSchema,
    /** 1-based level this row decides; levels must be contiguous from 1. */
    level: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
    /** Levels the matrix asked for when the request was created. */
    requiredLevels: z.number().int().min(1).max(APPROVAL_MAX_LEVELS),
    amountIdr: idrSchema.refine((value) => value >= 0).nullable(),
    status: approvalRequestStatusSchema,
    requestReason: z.string().trim().min(3).max(500),
    decidedBy: userIdSchema.nullable(),
    decidedAt: isoDateTimeSchema.nullable(),
    reason: z.string().trim().min(3).max(500).nullable(),
    deadlineAt: isoDateTimeSchema,
    createdAt: isoDateTimeSchema,
    /** true when the caller may approve its own request (sole Owner, legend-b8y6l); absent = false */
    selfApprovalAllowed: z.boolean().optional(),
  })
  .superRefine((request, ctx) => {
    const add = (path: string[], message: string, invalid: boolean) => {
      if (invalid) ctx.addIssue({ code: "custom", path, message });
    };
    add(
      ["level"],
      "A level cannot exceed requiredLevels",
      request.level > request.requiredLevels,
    );
    add(
      ["deadlineAt"],
      "The deadline must be after createdAt",
      Date.parse(request.deadlineAt) <= Date.parse(request.createdAt),
    );
    const decided =
      request.status === "approved" || request.status === "rejected";
    const hasDecision =
      request.decidedBy !== null ||
      request.decidedAt !== null ||
      request.reason !== null;
    add(
      ["status"],
      "A decided request records decidedBy, decidedAt and reason (F7)",
      decided && !(request.decidedBy !== null && request.decidedAt !== null),
    );
    add(
      ["status"],
      "Only an approved or rejected request carries a decision",
      !decided && hasDecision,
    );
    add(
      ["decidedBy"],
      "The approver is never the requester (AUTH-06, §3 F7)",
      request.decidedBy !== null &&
        request.decidedBy.toLowerCase() === request.requestedBy.toLowerCase() &&
        // legend-b8y6l: a sole Owner may approve its own shareholder_version request.
        !(
          request.status === "approved" &&
          SELF_APPROVABLE_ACTION_TYPES.has(request.actionType)
        ),
    );
    add(
      ["decidedAt"],
      "decidedAt cannot precede createdAt",
      request.decidedAt !== null &&
        Date.parse(request.decidedAt) < Date.parse(request.createdAt),
    );
  });
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

/**
 * AUTH-03 login-reply policy (tenant settings row). Default off; while on, a
 * reply is sent only while the provider's free monthly quota lasts. The
 * counter resets with the calendar month.
 */
export const loginReplyPolicySchema = z.strictObject({
  enabled: z.boolean(),
  freeMonthlyQuota: z.number().int().min(0),
  repliesThisMonth: z.number().int().min(0),
});
export type LoginReplyPolicy = z.infer<typeof loginReplyPolicySchema>;

// ------------------------------------------------------------- verdicts

/** Result of checking a session against a guarded surface (`sessionGate`). */
export const SESSION_GATES = [
  "ok",
  "revoked",
  "expired",
  "mfa_required",
] as const;
export const sessionGateSchema = z.enum(SESSION_GATES);
export type SessionGate = z.infer<typeof sessionGateSchema>;
