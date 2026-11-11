// HTTP contracts for identity & access (PRD v1.7 §3 F6/F7, §6 B). The API
// validates with these objects and the web app's typed client + mock runtime
// read the same ones (docs/frontend.md "Typed endpoints and mock mode"), so the
// FE beads (customer login, staff login/MFA, device pin, approval inbox, RBAC
// admin) build against fixtures before the API exists.
//
// Authorization is not part of the endpoint object; it lives in the service:
// - Public: the four sign-in endpoints and the Google start.
// - A signed-in user: /api/auth/me, MFA enrollment/verify, the device list and
//   revoking their own sessions.
// - A registered outlet device token: the staff pin verify.
// - `device.registry.manage` on the outlet: setting another user's pin.
// - `approval.inbox.view` / `approval.request.decide` (+ the matrix role and
//   AUTH-06 distinct actor): the approval inbox.
// - `access.role.view|manage|assign` and `access.approval_policy.manage`: RBAC
//   admin, with the re-authentication rule of access.assertCanGrantRole.
// Tenant and outlet always come from the domain, session or device token,
// never from the path or body (TEN-02).

import { cursorPageSchema, dataResponseSchema, z } from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import {
  approvalPolicySchema,
  createCustomRoleSchema,
  endRoleAssignmentSchema,
  grantRoleSchema,
  listRoleAssignmentsQuerySchema,
  roleAssignmentSchema,
  roleSchema,
  updateCustomRoleSchema,
} from "../access/index.ts";
import {
  approvalDecisionInputSchema,
  approvalInboxQuerySchema,
  approvalRequestParamsSchema,
  createApprovalRequestSchema,
  createMagicLinkChallengeSchema,
  createWhatsAppLoginChallengeSchema,
  googleCallbackQuerySchema,
  googleStartQuerySchema,
  loginChallengeParamsSchema,
  magicLinkQuerySchema,
  mfaEnrollSchema,
  mfaFactorParamsSchema,
  mfaRecoveryVerifySchema,
  mfaVerifySchema,
  replaceApprovalMatrixSchema,
  roleAssignmentParamsSchema,
  roleParamsSchema,
  sessionParamsSchema,
  setStaffPinSchema,
  staffPinParamsSchema,
  verifyStaffPinSchema,
} from "./inputs.ts";
import {
  approvalRequestSchema,
  currentAuthViewSchema,
  googleLoginStartSchema,
  loginChallengeIssuedSchema,
  loginChallengeViewSchema,
  loginResultSchema,
  magicLinkRequestedSchema,
  // legend-k2l
  magicLinkVerifiedSchema,
  magicLinkVerifyBodySchema,
  invitationAcceptBodySchema,
  invitationAcceptedSchema,
  mfaEnrollmentSchema,
  mfaFactorSchema,
  mfaRecoveryCodesSchema,
  mfaRecoveryStatusSchema,
  mfaRecoveryVerificationResultSchema,
  mfaVerificationResultSchema,
  sessionViewSchema,
  staffPinSwitchSchema,
} from "./schemas.ts";

// ------------------------------------------------------------ sign-in flow

/** Mobile deep link / desktop QR: issues a code bound to this browser (AUTH-01). */
export const requestWhatsAppLoginChallenge = defineEndpoint({
  method: "POST",
  path: "/api/auth/login-challenges/whatsapp",
  body: createWhatsAppLoginChallengeSchema,
  response: dataResponseSchema(loginChallengeIssuedSchema),
});

/** Magic link email; identical answer whether the address exists. */
export const requestMagicLink = defineEndpoint({
  method: "POST",
  path: "/api/auth/login-challenges/email",
  body: createMagicLinkChallengeSchema,
  response: dataResponseSchema(magicLinkRequestedSchema),
});

// legend-k2l: the clicked email link opens a page that posts the token from its
// URL fragment; the API sets the session cookie and answers with the user id.
export const verifyMagicLinkEmail = defineEndpoint({
  method: "POST",
  path: "/api/auth/login-challenges/email/verify",
  body: magicLinkVerifyBodySchema,
  response: dataResponseSchema(magicLinkVerifiedSchema),
});

// legend-fy5y: the first-admin invitation page posts the token and tenant id
// from its URL fragment. Platform level (no tenant domain needed) and no
// session: it only marks the email verified.
export const acceptTenantInvitation = defineEndpoint({
  method: "POST",
  path: "/api/auth/login-challenges/invitation",
  body: invitationAcceptBodySchema,
  response: dataResponseSchema(invitationAcceptedSchema),
});

/** The requesting browser polls; the session appears once the message lands. */
export const getLoginChallenge = defineEndpoint({
  method: "GET",
  path: "/api/auth/login-challenges/:challengeId",
  params: loginChallengeParamsSchema,
  response: dataResponseSchema(loginChallengeViewSchema),
});

/** "Bukan saya": cancel from the same browser. */
export const cancelLoginChallenge = defineEndpoint({
  method: "POST",
  path: "/api/auth/login-challenges/:challengeId/cancel",
  params: loginChallengeParamsSchema,
});

/** The clicked email link; the API sets the session cookie and answers with it. */
export const completeMagicLink = defineEndpoint({
  method: "GET",
  path: "/api/auth/magic-link",
  query: magicLinkQuerySchema,
  response: dataResponseSchema(loginResultSchema),
});

/** Google OAuth start: the API returns the provider URL including its state. */
export const startGoogleLogin = defineEndpoint({
  method: "GET",
  path: "/api/auth/google/start",
  query: googleStartQuerySchema,
  response: dataResponseSchema(googleLoginStartSchema),
});

/**
 * Google's redirect target: verifies state + code, sets the cookie, then
 * answers 302 to `returnTo`. No JSON body on purpose (the browser navigates).
 */
export const completeGoogleLogin = defineEndpoint({
  method: "GET",
  path: "/api/auth/google/callback",
  query: googleCallbackQuerySchema,
});

/** Everything the shell needs after sign-in (AUTH-05/07 state included). */
export const getCurrentAuth = defineEndpoint({
  method: "GET",
  path: "/api/auth/me",
  response: dataResponseSchema(currentAuthViewSchema),
});

// --------------------------------------------------------------------- MFA

export const listMfaFactors = defineEndpoint({
  method: "GET",
  path: "/api/auth/mfa/factors",
  response: dataResponseSchema(z.array(mfaFactorSchema)),
});

/** Starts enrollment: a TOTP secret+QR once, or WebAuthn creation options. */
export const enrollMfaFactor = defineEndpoint({
  method: "POST",
  path: "/api/auth/mfa/factors",
  body: mfaEnrollSchema,
  response: dataResponseSchema(mfaEnrollmentSchema),
});

/** Verifies the second factor for this session (AUTH-05) or finishes enrollment. */
export const verifyMfaFactor = defineEndpoint({
  method: "POST",
  path: "/api/auth/mfa/verify",
  body: mfaVerifySchema,
  response: dataResponseSchema(mfaVerificationResultSchema),
});

export const deleteMfaFactor = defineEndpoint({
  method: "DELETE",
  path: "/api/auth/mfa/factors/:factorId",
  params: mfaFactorParamsSchema,
});

/** Remaining recovery codes; never the codes themselves. */
export const getMfaRecoveryStatus = defineEndpoint({
  method: "GET",
  path: "/api/auth/mfa/recovery-codes",
  response: dataResponseSchema(mfaRecoveryStatusSchema),
});

/** Needs an MFA-verified session. Replaces the whole set; plaintext shown once. */
export const generateMfaRecoveryCodes = defineEndpoint({
  method: "POST",
  path: "/api/auth/mfa/recovery-codes",
  response: dataResponseSchema(mfaRecoveryCodesSchema),
});

/** Spends one recovery code and marks this session MFA-verified. */
export const verifyMfaRecoveryCode = defineEndpoint({
  method: "POST",
  path: "/api/auth/mfa/recovery",
  body: mfaRecoveryVerifySchema,
  response: dataResponseSchema(mfaRecoveryVerificationResultSchema),
});

// ---------------------------------------------------------------- sessions

/** Explicit staff activity extends an active idle session (AUTH-05). */
export const extendCurrentSession = defineEndpoint({
  method: "POST",
  path: "/api/auth/sessions/current/activity",
});

/** The owner's device list; `current` marks this session. */
export const listSessions = defineEndpoint({
  method: "GET",
  path: "/api/auth/sessions",
  response: dataResponseSchema(z.array(sessionViewSchema)),
});

/** Revoke one device's session (PRD §3 F6 "Sesi disimpan di server ... dicabut per perangkat"). */
export const revokeSession = defineEndpoint({
  method: "DELETE",
  path: "/api/auth/sessions/:sessionId",
  params: sessionParamsSchema,
});

// -------------------------------------------------------------- staff pins

/** Switch user on a registered outlet device with a personal 6-digit pin. */
export const verifyStaffPin = defineEndpoint({
  method: "POST",
  path: "/api/staff-pins/verify",
  body: verifyStaffPinSchema,
  response: dataResponseSchema(staffPinSwitchSchema),
});

/** A supervisor/manager sets or resets a staff pin for the outlet. */
export const setStaffPin = defineEndpoint({
  method: "PUT",
  path: "/api/staff-pins/:outletId/:userId",
  params: staffPinParamsSchema,
  body: setStaffPinSchema,
});

// --------------------------------------------------------- approval requests

export const listApprovalRequests = defineEndpoint({
  method: "GET",
  path: "/api/approvals",
  query: approvalInboxQuerySchema,
  response: cursorPageSchema(approvalRequestSchema),
});

/** A user asks for approval (POS void/discount/refund, expense, stock, ...). */
export const createApprovalRequest = defineEndpoint({
  method: "POST",
  path: "/api/approvals",
  body: createApprovalRequestSchema,
  response: dataResponseSchema(approvalRequestSchema),
});

export const getApprovalRequest = defineEndpoint({
  method: "GET",
  path: "/api/approvals/:requestId",
  params: approvalRequestParamsSchema,
  response: dataResponseSchema(approvalRequestSchema),
});

/** Approve or reject with a reason; the matrix role decides who may (F7). */
export const decideApprovalRequest = defineEndpoint({
  method: "POST",
  path: "/api/approvals/:requestId/decisions",
  params: approvalRequestParamsSchema,
  body: approvalDecisionInputSchema,
  response: dataResponseSchema(approvalRequestSchema),
});

// ------------------------------------------------------- roles & the matrix

export const listRoles = defineEndpoint({
  method: "GET",
  path: "/api/access/roles",
  response: dataResponseSchema(z.array(roleSchema)),
});

/** A custom role built from the permission catalog (§3 F7 "Custom Role"). */
export const createCustomRole = defineEndpoint({
  method: "POST",
  path: "/api/access/roles",
  body: createCustomRoleSchema,
  response: dataResponseSchema(roleSchema),
});

export const updateCustomRole = defineEndpoint({
  method: "PATCH",
  path: "/api/access/roles/:roleId",
  params: roleParamsSchema,
  body: updateCustomRoleSchema,
  response: dataResponseSchema(roleSchema),
});

export const listRoleAssignments = defineEndpoint({
  method: "GET",
  path: "/api/access/role-assignments",
  query: listRoleAssignmentsQuerySchema,
  response: cursorPageSchema(roleAssignmentSchema),
});

/** Grant a role: re-auth required, never to yourself (§3 F7 "Pemberian Role"). */
export const grantRole = defineEndpoint({
  method: "POST",
  path: "/api/access/role-assignments",
  body: grantRoleSchema,
  response: dataResponseSchema(roleAssignmentSchema),
});

export const endRoleAssignment = defineEndpoint({
  method: "POST",
  path: "/api/access/role-assignments/:assignmentId/end",
  params: roleAssignmentParamsSchema,
  body: endRoleAssignmentSchema,
  response: dataResponseSchema(roleAssignmentSchema),
});

export const getApprovalMatrix = defineEndpoint({
  method: "GET",
  path: "/api/access/approval-policies",
  response: dataResponseSchema(z.array(approvalPolicySchema)),
});

/** Save the whole matrix; the service validates tiers/levels (approvalMatrixSchema). */
export const replaceApprovalMatrix = defineEndpoint({
  method: "PUT",
  path: "/api/access/approval-policies",
  body: replaceApprovalMatrixSchema,
  response: dataResponseSchema(z.array(approvalPolicySchema)),
});
