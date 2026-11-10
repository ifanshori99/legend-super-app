// Custom hooks of the payslip PIN screens (bead legend-ilzrj): the only way
// components touch the PIN endpoints. Every PIN write replaces the cached
// status. A mutation keeps its variables (the PIN or code) until it is reset:
// gcTime 0 only evicts them once the screen unmounts, so screens call
// `.reset()` as soon as the PIN or code is no longer needed.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PayslipPinStatus } from "@starter/shared/hris/payroll";
import type {
  RequestPayslipPinOtpInput,
  SetPayslipPinInput,
  VerifyPayslipPinOtpInput,
} from "./pin-api.ts";
import {
  requestPayslipPinOtp,
  submitPayslipPin,
  verifyPayslipPinOtp,
} from "./pin-api.ts";
import { payslipPinKeys, payslipPinStatusQuery } from "./pin-queries.ts";
import { useHydrated } from "./use-hydrated.ts";

/** GET /api/hris/me/payslip-pin. */
export function usePayslipPinStatus() {
  const hydrated = useHydrated();
  return useQuery({ ...payslipPinStatusQuery(), enabled: hydrated });
}

function useStatusWriter() {
  const queryClient = useQueryClient();
  return (status: PayslipPinStatus) =>
    queryClient.setQueryData(payslipPinKeys.status(), status);
}

/** PUT /api/hris/me/payslip-pin — create, or change with `currentPin`. */
export function useSetPayslipPin() {
  const writeStatus = useStatusWriter();
  return useMutation({
    mutationFn: (body: SetPayslipPinInput) => submitPayslipPin(body),
    gcTime: 0,
    onSuccess: writeStatus,
  });
}

/** POST /api/hris/me/payslip-pin/reset-otp — sends the WhatsApp code. */
export function useRequestPayslipPinOtp() {
  return useMutation({
    mutationFn: (body: RequestPayslipPinOtpInput) => requestPayslipPinOtp(body),
    gcTime: 0,
  });
}

/** POST /api/hris/me/payslip-pin/reset-otp/verify — code + new PIN. */
export function useVerifyPayslipPinOtp() {
  const writeStatus = useStatusWriter();
  return useMutation({
    mutationFn: (body: VerifyPayslipPinOtpInput) => verifyPayslipPinOtp(body),
    gcTime: 0,
    onSuccess: writeStatus,
  });
}
