// Typed endpoint callers for the device PIN and approval flows. Components
// use the hooks in ./hooks.ts.
import {
  createApprovalRequest,
  getApprovalRequest,
  verifyStaffPin,
  type CreateApprovalRequestInput,
  type VerifyStaffPinInput,
} from "@starter/shared/identity";
import { defineEndpoint } from "@starter/shared/api";
import { dataResponseSchema } from "@starter/shared/core";
import {
  posSessionRequestSchema,
  posSessionResponseSchema,
  type PosSessionResponse,
} from "@starter/shared/pos/acting-staff";
import { callEndpoint } from "@/lib/api/endpoint";
import { clearActingStaffToken, writeActingStaffToken } from "./storage.ts";

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
    clearActingStaffToken();
  }
}

export const createApprovalRequestCall = (body: CreateApprovalRequestInput) =>
  callEndpoint(createApprovalRequest, { body });

export const getApprovalRequestCall = (
  requestId: string,
  signal?: AbortSignal,
) => callEndpoint(getApprovalRequest, { params: { requestId } }, { signal });
