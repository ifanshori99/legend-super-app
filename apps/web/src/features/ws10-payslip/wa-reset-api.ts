// Typed calls for resetting the payslip PIN with a WhatsApp message sent TO
// the service (inbound proof, not a code typed into the web). One function per
// endpoint; responses are unwrapped so hooks and components never see the
// `{ data }` envelope. The PIN only ever travels in a request body.
//
// The reset-wa endpoints are built on the API branch and are not in
// `@starter/shared` yet, so they are defined here with the same shape the
// shared definitions use (`defineEndpoint` + zod). Move them to the shared
// contract once it ships and delete this block.
//
// HR-01: every `/api/hris/me/*` route resolves the employee from the session
// and takes no employee id.
import { defineEndpoint } from "@starter/shared/api";
import {
  dataResponseSchema,
  idempotencyKeySchema,
  z,
} from "@starter/shared/core";
import { payslipPinSchema } from "@starter/shared/hris/payroll";
import { callEndpoint } from "@/lib/api/endpoint";

/** What the API answers while the message has not been checked yet or after. */
export const waResetStatusSchema = z.enum([
  "pending",
  "verified",
  "expired",
  "cancelled",
  "used",
]);
export type WaResetStatus = z.infer<typeof waResetStatusSchema>;

/** Statuses that never change again: polling stops on them. */
export function isFinalWaResetStatus(status: WaResetStatus): boolean {
  return status !== "pending" && status !== "verified";
}

/** The only link shape the screen opens or turns into a QR. */
const WA_ME_LINK = /^https:\/\/wa\.me\/\d+(\?|$)/;
export function isWaMeLink(link: string): boolean {
  return WA_ME_LINK.test(link);
}

const waResetChallengeSchema = z.object({
  challengeId: z.string().min(1),
  /** Recovery code shown on screen and put in the message, e.g. K7Q4-M2XD. */
  code: z.string().min(1),
  /** wa.me link with the message already filled in. */
  waLink: z.string().regex(WA_ME_LINK, "Tautan WhatsApp tidak valid."),
  /** Last four digits of the registered number. */
  senderHint: z.string().min(1),
  expiresAt: z.string().min(1),
});
export type WaResetChallenge = z.infer<typeof waResetChallengeSchema>;

const waResetStatusViewSchema = z.object({
  status: waResetStatusSchema,
  expiresAt: z.string().min(1),
  /** Until when the verified proof may still save a PIN; null before that. */
  grantExpiresAt: z.string().nullable(),
});
export type WaResetStatusView = z.infer<typeof waResetStatusViewSchema>;

const waResetParamsSchema = z.object({ challengeId: z.string().min(1) });

const waResetPinInputSchema = z.object({
  pin: payslipPinSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type SubmitWaResetPinInput = z.input<typeof waResetPinInputSchema>;

const waResetPinResultSchema = z.object({
  status: z.literal("active"),
  lockedUntil: z.null(),
});
export type WaResetPinResult = z.infer<typeof waResetPinResultSchema>;

/** 201; 409 PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE / PAYSLIP_PIN_NOT_SET, 429, 503. */
export const startMyPayslipPinResetWa = defineEndpoint({
  method: "POST",
  path: "/api/hris/me/payslip-pin/reset-wa",
  body: z.object({}),
  response: dataResponseSchema(waResetChallengeSchema),
});

/** Polled every 2 s; 404 when the challenge is unknown or not this browser's. */
export const getMyPayslipPinResetWa = defineEndpoint({
  method: "GET",
  path: "/api/hris/me/payslip-pin/reset-wa/:challengeId",
  params: waResetParamsSchema,
  response: dataResponseSchema(waResetStatusViewSchema),
});

/** 200; 403 PAYSLIP_PIN_RESET_PROOF_INVALID when the proof is missing or used. */
export const submitMyPayslipPinResetWaPin = defineEndpoint({
  method: "POST",
  path: "/api/hris/me/payslip-pin/reset-wa/:challengeId/pin",
  params: waResetParamsSchema,
  body: waResetPinInputSchema,
  response: dataResponseSchema(waResetPinResultSchema),
});

/** 204. */
export const cancelMyPayslipPinResetWa = defineEndpoint({
  method: "POST",
  path: "/api/hris/me/payslip-pin/reset-wa/:challengeId/cancel",
  params: waResetParamsSchema,
});

/** Starts a challenge: the code, the wa.me link and when it stops working. */
export async function startWaReset(): Promise<WaResetChallenge> {
  const response = await callEndpoint(startMyPayslipPinResetWa, { body: {} });
  return response.data;
}

export async function getWaResetStatus(
  challengeId: string,
  signal?: AbortSignal,
): Promise<WaResetStatusView> {
  const response = await callEndpoint(
    getMyPayslipPinResetWa,
    { params: { challengeId } },
    { signal },
  );
  return response.data;
}

/** Only works after the message was verified; the same key replays safely. */
export async function submitWaResetPin(
  challengeId: string,
  body: SubmitWaResetPinInput,
): Promise<WaResetPinResult> {
  const response = await callEndpoint(submitMyPayslipPinResetWaPin, {
    params: { challengeId },
    body,
  });
  return response.data;
}

export async function cancelWaReset(challengeId: string): Promise<void> {
  await callEndpoint(cancelMyPayslipPinResetWa, { params: { challengeId } });
}
