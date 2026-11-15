// Typed endpoint callers for the device PIN and approval flows. Components
// use the hooks in ./hooks.ts.
import {
  createApprovalRequest,
  verifyStaffPin,
  type CreateApprovalRequestInput,
  type VerifyStaffPinInput,
} from "@starter/shared/identity";
import {
  cancelPosOverrideApproval,
  createPosOverride,
  getPosOverride,
  getPosOverrideApproval,
  type CreatePosOverrideInput,
} from "@starter/shared/access/override";
import { defineEndpoint } from "@starter/shared/api";
import { z } from "zod";
import {
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
} from "@starter/shared/core";
import { panicSessionBodySchema } from "@starter/shared/facility";
import {
  posSessionRequestSchema,
  posSessionResponseSchema,
  type PosSessionResponse,
} from "@starter/shared/pos/acting-staff";
import { callEndpoint } from "@/lib/api/endpoint";
import { releaseActingStaffToken, writeActingStaffToken } from "./storage.ts";

// The API owns these two routes (apps/api/src/routes/pos-acting-staff.routes.ts);
// the shared package only exports their schemas, so the web client defines the
// endpoints here (also what the mock registry keys on).
export const startPosSession = defineEndpoint({
  method: "POST",
  path: "/api/staff-pins/pos-session",
  body: posSessionRequestSchema,
  response: dataResponseSchema(posSessionResponseSchema),
});

export const endPosSession = defineEndpoint({
  method: "POST",
  path: "/api/staff-pins/pos-session/end",
});

export const startEmergencySession = defineEndpoint({
  method: "POST",
  path: "/api/emergency/sessions",
  body: panicSessionBodySchema,
  response: dataResponseSchema(
    z.strictObject({
      outletId: outletIdSchema,
      expiresAt: isoDateTimeSchema,
      user: z.strictObject({ id: userIdSchema, displayName: z.string() }),
    }),
  ),
});

export const endEmergencySession = defineEndpoint({
  method: "DELETE",
  path: "/api/emergency/sessions/current",
});

/** The API sets an HttpOnly receiver cookie; never start a cashier session. */
export const startEmergencySessionCall = (input: VerifyStaffPinInput) =>
  callEndpoint(startEmergencySession, {
    body: { staffUserId: input.userId, pin: input.pin },
  });

export const endEmergencySessionCall = () => callEndpoint(endEmergencySession);

export const verifyStaffPinCall = (input: VerifyStaffPinInput) =>
  callEndpoint(verifyStaffPin, { body: input });

/**
 * Verifies the PIN and makes this staff member the device's active cashier.
 * Keeps the token for the X-Acting-Staff header; the PIN is not kept.
 */
export async function startPosSessionCall(
  input: VerifyStaffPinInput, // same { userId, pin } body
): Promise<{ data: PosSessionResponse }> {
  const answer = await callEndpoint(startPosSession, { body: input });
  writeActingStaffToken({
    token: answer.data.token,
    expiresAt: answer.data.expiresAt,
  });
  return answer;
}

/** Ends the active cashier on this device; the token is forgotten either way. */
export async function endPosSessionCall(): Promise<void> {
  try {
    await callEndpoint(endPosSession);
  } finally {
    releaseActingStaffToken();
  }
}

export const createApprovalRequestCall = (body: CreateApprovalRequestInput) =>
  callEndpoint(createApprovalRequest, { body });

/**
 * The phone override's approval request, read on the POS path (device +
 * X-Acting-Staff): the active cashier is the requester, and the back-office
 * GET /api/approvals/:id would read as the session owner behind its MFA gate.
 */
export const getApprovalRequestCall = (
  requestId: string,
  signal?: AbortSignal,
) =>
  callEndpoint(getPosOverrideApproval, { params: { requestId } }, { signal });

/**
 * The settled override behind a phone approval (POS path). The approval
 * request alone does not allow the action: only an override that reads
 * "approved" here does (legend-495 G3).
 */
export const getPosOverrideCall = (overrideId: string, signal?: AbortSignal) =>
  callEndpoint(getPosOverride, { params: { overrideId } }, { signal });

/**
 * Supervisor override approved on this device: the approver's PIN travels in
 * the body (method supervisor_pin) and the server verifies it (AUTH-06).
 * The caller owns the Idempotency-Key: one key per override intent, reused on
 * every retry of it (legend-495 G4), so a retry never opens a second request.
 */
export const createPosOverrideCall = (
  body: CreatePosOverrideInput,
  idempotencyKey: string,
) =>
  callEndpoint(
    createPosOverride,
    { body },
    { headers: { "Idempotency-Key": idempotencyKey } },
  );

/**
 * "Berhenti menunggu": the active cashier withdraws their own pending request
 * through the POS path (device + X-Acting-Staff, no back-office MFA), so the
 * button never fails on a missing second factor.
 */
export const cancelApprovalRequestCall = (requestId: string) =>
  callEndpoint(
    cancelPosOverrideApproval,
    { params: { requestId } },
    { headers: { "Idempotency-Key": crypto.randomUUID() } },
  );
