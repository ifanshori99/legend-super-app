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
import {
  approvalRequestIdSchema,
  loginChallengeIdSchema,
  mfaFactorIdSchema,
  sessionIdSchema,
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

export const mfaVerifySchema = clientInputSchema({
  factorId: mfaFactorIdSchema,
  /** Six-digit TOTP code (or the passkey assertion handle from the client). */
  code: z.string().regex(/^\d{6}$/, "Expected a 6-digit code"),
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

// ---------------------------------------------------------------- sessions

export const sessionParamsSchema = z.strictObject({
  sessionId: sessionIdSchema,
});

// -------------------------------------------------------------- staff pins

/** Six digits; strength is asserted separately (WEAK_STAFF_PIN). */
export const staffPinInputSchema = z
  .string()
  .regex(staffPinPattern, "Expected a 6-digit pin");
export type StaffPinInput = z.infer<typeof staffPinInputSchema>;

/** The device token already names the outlet (TEN-02); only the pin is sent. */
export const verifyStaffPinSchema = clientInputSchema({
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
