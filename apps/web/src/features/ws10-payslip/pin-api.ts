// Typed calls for the payslip PIN lifecycle (bead legend-ilzrj; PRD v1.7 §3
// D.30). One function per endpoint; responses are unwrapped so hooks and
// components never see the `{ data }` envelope. The PIN only ever travels in a
// request body. Opening a payslip with the PIN stays in ./api.ts.
//
// HR-01: every `/api/hris/me/*` route resolves the employee from the session
// and takes no employee id.
import type { z } from "zod";
import type {
  PayslipPinResetOtpRequested,
  PayslipPinStatus,
} from "@starter/shared/hris/payroll";
import {
  getMyPayslipPinStatus,
  requestMyPayslipPinResetOtp,
  setMyPayslipPin,
  verifyMyPayslipPinResetOtp,
} from "@starter/shared/hris/payroll";
import { callEndpoint } from "@/lib/api/endpoint";

export type SetPayslipPinInput = z.input<typeof setMyPayslipPin.body>;
export type RequestPayslipPinOtpInput = z.input<
  typeof requestMyPayslipPinResetOtp.body
>;
export type VerifyPayslipPinOtpInput = z.input<
  typeof verifyMyPayslipPinResetOtp.body
>;

export async function fetchPayslipPinStatus(
  signal?: AbortSignal,
): Promise<PayslipPinStatus> {
  const response = await callEndpoint(getMyPayslipPinStatus, {}, { signal });
  return response.data;
}

/** First set (no `currentPin`) or change (`currentPin` required). */
export async function submitPayslipPin(
  body: SetPayslipPinInput,
): Promise<PayslipPinStatus> {
  const response = await callEndpoint(setMyPayslipPin, { body });
  return response.data;
}

/** Sends a WhatsApp code; 503 when no sender is set up, 429 over the limit. */
export async function requestPayslipPinOtp(
  body: RequestPayslipPinOtpInput,
): Promise<PayslipPinResetOtpRequested> {
  const response = await callEndpoint(requestMyPayslipPinResetOtp, { body });
  return response.data;
}

/** A correct code sets the new PIN and clears the lock. */
export async function verifyPayslipPinOtp(
  body: VerifyPayslipPinOtpInput,
): Promise<PayslipPinStatus> {
  const response = await callEndpoint(verifyMyPayslipPinResetOtp, { body });
  return response.data;
}
