// Request bodies, path params and query shapes for identity & access. Every
// body is built with clientInputSchema: the tenant comes from the domain or
// token, never from the body (TEN-02); an outlet comes from the device token
// or the object being acted on, never from the client.

import {
  clientInputSchema,
  cursorPageQuerySchema,
  idrSchema,
  outletIdSchema,
  userIdSchema,
  z,
} from "../core/index.ts";
import {
  approvalActionTypeSchema,
  approvalSourceSchema,
  roleAssignmentIdSchema,
  roleIdSchema,
  upsertApprovalPolicySchema,
} from "../access/index.ts";
import { pushSubscriptionIdSchema } from "../notification/schemas.ts";
import {
  approvalRequestIdSchema,
  loginChallengeIdSchema,
  mfaFactorIdSchema,
  sessionIdSchema,
  userIdentityIdSchema,
} from "./ids.ts";
import {
  approvalRequestStatusSchema,
  magicLinkTokenSchema,
  mfaFactorTypeSchema,
  objectIdSchema,
  objectTypeSchema,
  returnPathSchema,
  staffPinPattern,
} from "./schemas.ts";
import { isStrongStaffPin } from "./machines.ts";

// ------------------------------------------------------------ sign-in flow

/** Mobile/desktop WhatsApp login. No body fields: tenant and brand are the domain. */
export const createWhatsAppLoginChallengeSchema = clientInputSchema({
  returnTo: returnPathSchema.optional(),
  /** Card w8dfz.1: show the masked sender and wait for a confirm. */
  requireConfirm: z.boolean().optional(),
});
export type CreateWhatsAppLoginChallengeInput = z.infer<
  typeof createWhatsAppLoginChallengeSchema
>;

/** Magic link email. The answer never reveals whether the address exists. */
export const createMagicLinkChallengeSchema = clientInputSchema({
  email: z.email().max(254),
  returnTo: returnPathSchema.optional(),
});
export type CreateMagicLinkChallengeInput = z.infer<
  typeof createMagicLinkChallengeSchema
>;

export const loginChallengeParamsSchema = z.strictObject({
  challengeId: loginChallengeIdSchema,
});

/** The clicked email link carries the one-time token in the query. */
export const magicLinkQuerySchema = z.strictObject({
  token: magicLinkTokenSchema,
});

export const googleStartQuerySchema = z.strictObject({
  returnTo: returnPathSchema.optional(),
});

/** Google's callback is a browser redirect; the API sets the cookie and redirects. */
export const googleCallbackQuerySchema = z.strictObject({
  code: z.string().min(8).max(512),
  state: magicLinkTokenSchema,
});

// --------------------------------------------------------------------- MFA

export const mfaEnrollSchema = clientInputSchema({
  type: mfaFactorTypeSchema,
});
export type MfaEnrollInput = z.infer<typeof mfaEnrollSchema>;

export const mfaFactorParamsSchema = z.strictObject({
  factorId: mfaFactorIdSchema,
});

/**
 * Path of the audited WhatsApp unlink (legend-7wzy). The outlet is the one the
 * acting staff works in (authorization), the customer is the account that
 * holds the identity; the tenant always comes from the Host (TEN-02).
 */
export const unlinkWhatsAppIdentityParamsSchema = z.strictObject({
  outletId: outletIdSchema,
  userId: userIdSchema,
  identityId: userIdentityIdSchema,
});

/**
 * Body of the audited WhatsApp unlink (legend-7wzy): why the staff member
 * clears the link. Stored on the audit row.
 */
export const unlinkWhatsAppIdentityBodySchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
});
export type UnlinkWhatsAppIdentityBody = z.infer<
  typeof unlinkWhatsAppIdentityBodySchema
>;

const base64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "Expected base64url")
  .max(16384);
const credentialIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "Expected base64url")
  .max(1024);

/**
 * WebAuthn JSON responses (W3C WebAuthn L3 `toJSON()` shapes, the same fields
 * @simplewebauthn/server reads). The envelope is strict; `response` stays loose
 * because newer browsers add fields (publicKey, publicKeyAlgorithm, ...) the
 * server does not read.
 */
const passkeyEnvelope = {
  id: credentialIdSchema,
  rawId: credentialIdSchema,
  type: z.literal("public-key"),
  authenticatorAttachment: z.string().max(32).nullish(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
};

/** Passkey sign-in proof (`navigator.credentials.get()` result as JSON). */
export const passkeyAssertionSchema = z.strictObject({
  ...passkeyEnvelope,
  response: z.looseObject({
    clientDataJSON: base64UrlSchema,
    authenticatorData: base64UrlSchema,
    signature: base64UrlSchema,
    userHandle: base64UrlSchema.nullish(),
  }),
});
export type PasskeyAssertion = z.infer<typeof passkeyAssertionSchema>;

/** Passkey creation result (`navigator.credentials.create()` as JSON). */
export const passkeyAttestationSchema = z.strictObject({
  ...passkeyEnvelope,
  response: z.looseObject({
    clientDataJSON: base64UrlSchema,
    attestationObject: base64UrlSchema,
    transports: z.array(z.string().max(32)).max(10).optional(),
  }),
});
export type PasskeyAttestation = z.infer<typeof passkeyAttestationSchema>;

/**
 * One of: a six-digit TOTP code, a passkey assertion (verifies the session),
 * or a passkey attestation (finishes passkey enrollment). Exactly one; each
 * shape is strict, so mixing them or adding a tenant key fails.
 */
export const mfaVerifySchema = z.union([
  clientInputSchema({
    factorId: mfaFactorIdSchema,
    code: z.string().regex(/^\d{6}$/, "Expected a 6-digit code"),
  }),
  clientInputSchema({
    factorId: mfaFactorIdSchema,
    assertion: passkeyAssertionSchema,
  }),
  clientInputSchema({
    factorId: mfaFactorIdSchema,
    attestation: passkeyAttestationSchema,
  }),
]);
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

/** Recovery code as typed by a person: `XXXXX-XXXXX`, dash optional, any case. */
export const MFA_RECOVERY_CODE_INPUT_PATTERN =
  /^[0-9A-Za-z]{5}-?[0-9A-Za-z]{5}$/;

export const mfaRecoveryVerifySchema = clientInputSchema({
  code: z
    .string()
    .trim()
    .regex(MFA_RECOVERY_CODE_INPUT_PATTERN, "Expected a recovery code"),
});
export type MfaRecoveryVerifyInput = z.infer<typeof mfaRecoveryVerifySchema>;

// ---------------------------------------------------------------- sessions

export const sessionParamsSchema = z.strictObject({
  sessionId: sessionIdSchema,
});

/** legend-gchkf: the push subscription id of a registered alarm device. */
export const pushDeviceParamsSchema = z.strictObject({
  id: pushSubscriptionIdSchema,
});

// -------------------------------------------------------------- staff pins

/** Six digits; strength is asserted separately (WEAK_STAFF_PIN). */
export const staffPinInputSchema = z
  .string()
  .regex(staffPinPattern, "Expected a 6-digit pin");
export type StaffPinInput = z.infer<typeof staffPinInputSchema>;

/**
 * The device token already names the outlet (TEN-02). The staff tile picked on
 * the device names the user so a miss is counted per staff (lock after 5, AUTH-06).
 */
export const verifyStaffPinSchema = clientInputSchema({
  userId: userIdSchema,
  pin: staffPinInputSchema,
});
export type VerifyStaffPinInput = z.infer<typeof verifyStaffPinSchema>;

export const staffPinParamsSchema = z.strictObject({
  outletId: outletIdSchema,
  userId: userIdSchema,
});

/** An outlet manager or supervisor sets or resets a staff pin (device.registry.manage). */
export const setStaffPinSchema = clientInputSchema({
  // A new pin must not be one a stranger tries first (assertStrongStaffPin).
  pin: staffPinInputSchema.refine(isStrongStaffPin, {
    message: "Pin terlalu mudah ditebak (angka sama atau berurutan).",
  }),
});
export type SetStaffPinInput = z.infer<typeof setStaffPinSchema>;

// --------------------------------------------------------- approval requests

/**
 * A user asks for approval. `requestedBy`, `source` (user here) and the outlet
 * come from the session and the object; AI/MCP requests are created by the
 * server, never by this body (PRD §4 Q).
 */
export const createApprovalRequestSchema = clientInputSchema({
  actionType: approvalActionTypeSchema,
  objectType: objectTypeSchema,
  objectId: objectIdSchema,
  amountIdr: idrSchema
    .refine((value) => value >= 0, "amountIdr must be >= 0")
    .optional(),
  requestReason: z.string().trim().min(3).max(500),
  payload: z.record(z.string(), z.json()).default({}),
  /**
   * Outlet the action belongs to (legend-y5q). The service checks that the
   * requester's own assignments reach it; omitted = a tenant-wide request,
   * which needs a tenant-wide requester (TEN-03).
   */
  outletId: outletIdSchema.optional(),
});
export type CreateApprovalRequestInput = z.infer<
  typeof createApprovalRequestSchema
>;

export const approvalRequestParamsSchema = z.strictObject({
  requestId: approvalRequestIdSchema,
});

/** F7 "Kotak Approval": approve or reject with a reason. */
export const approvalDecisionInputSchema = clientInputSchema({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(3).max(500),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionInputSchema>;

/** Inbox filters; the caller's role scope narrows the outlets further (TEN-03). */
export const approvalInboxQuerySchema = cursorPageQuerySchema.extend({
  status: approvalRequestStatusSchema.optional(),
  actionType: approvalActionTypeSchema.optional(),
  source: approvalSourceSchema.optional(),
  outletId: outletIdSchema.optional(),
});
export type ApprovalInboxQuery = z.infer<typeof approvalInboxQuerySchema>;

// ------------------------------------------------------- roles & the matrix

export const roleParamsSchema = z.strictObject({ roleId: roleIdSchema });
export const roleAssignmentParamsSchema = z.strictObject({
  assignmentId: roleAssignmentIdSchema,
});

/** The matrix editor saves the whole matrix; ids are assigned by the service. */
export const replaceApprovalMatrixSchema = clientInputSchema({
  policies: z.array(upsertApprovalPolicySchema).min(1).max(200),
});
export type ReplaceApprovalMatrixInput = z.infer<
  typeof replaceApprovalMatrixSchema
>;
