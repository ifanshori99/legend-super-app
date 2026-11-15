// Custom hooks of the WhatsApp PIN reset (inbound proof): the only way
// components touch the reset-wa endpoints. A mutation keeps its variables (the
// PIN) until it is reset: gcTime 0 only evicts them once the screen unmounts,
// so screens call `.reset()` as soon as the PIN is no longer needed.
import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PayslipPinStatus } from "@starter/shared/hris/payroll";
import { ApiError } from "@/lib/api/errors";
import { newIdempotencyKey } from "@/lib/idempotency";
import { payslipPinKeys } from "./pin-queries.ts";
import { payslipKeys } from "./queries.ts";
import {
  cancelWaReset,
  getWaResetStatus,
  startWaReset,
  submitWaResetPin,
} from "./wa-reset-api.ts";

/** How often the browser asks whether the message has landed. */
export const WA_RESET_POLL_MS = 2000;

export const waResetKeys = {
  all: [...payslipKeys.all, "wa-reset"] as const,
  status: (challengeId: string) =>
    [...waResetKeys.all, "status", challengeId] as const,
};

/** Why the reset cannot start or go on; each kind is one screen in `WaResetBlocked`. */
export type WaResetBlockedKind =
  | "expired"
  | "mismatch"
  | "rate-limited"
  | "no-wa"
  | "needs-update"
  | "too-new"
  | "unavailable-generic"
  | "service-unavailable";

/**
 * Maps a failed start to a blocked screen, or null when it is something else
 * (network, PIN not set) that the caller shows as a plain error. The API does
 * tell "no WhatsApp", "linked under 3 days" and "number needs an update" with a
 * marker in `details` (`{field:"whatsapp", message:"identity_missing"|
 * "identity_too_new"|"identity_needs_update"}`); without it the generic screen
 * names the first two.
 */
export function classifyWaResetError(
  error: unknown,
): WaResetBlockedKind | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 429 || error.code === "RATE_LIMITED")
    return "rate-limited";
  if (error.status === 503 || error.code === "SERVICE_UNAVAILABLE")
    return "service-unavailable";
  if (error.code === "PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE") {
    const marker = error.details?.find(
      (detail) => detail.field === "whatsapp",
    )?.message;
    if (marker === "identity_too_new") return "too-new";
    if (marker === "identity_missing") return "no-wa";
    if (marker === "identity_needs_update") return "needs-update";
    return "unavailable-generic";
  }
  return null;
}

/**
 * Seconds the 429 asks the employee to wait, for the `rate-limited` screen's
 * countdown; undefined when the API gave none (the screen then says "Coba
 * lagi nanti" without a number).
 */
export function waResetRetryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.status !== 429 && error.code !== "RATE_LIMITED") return undefined;
  return error.retryAfterSeconds;
}

/** What `WaResetNewPin` shows when saving the new PIN failed. */
export type WaResetPinFailure = "proof-invalid" | "format" | "generic";

export function classifyWaResetPinError(error: unknown): WaResetPinFailure {
  if (error instanceof ApiError) {
    if (
      error.code === "PAYSLIP_PIN_RESET_PROOF_INVALID" ||
      error.status === 404
    )
      return "proof-invalid";
    if (error.status === 400 || error.status === 422) return "format";
  }
  return "generic";
}

/** POST .../reset-wa: the code, the wa.me link and when it expires. */
export function useStartWaReset() {
  return useMutation({ mutationFn: () => startWaReset(), gcTime: 0 });
}

/**
 * GET .../reset-wa/:id every 2 s. A final status, a 404 and the passing of
 * `expiresAt` stop the poll; a missing view or a passing error (network, 5xx)
 * does not: the next tick tries again. The caller makes one closing refetch
 * once the code has expired.
 */
export function useWaResetStatus(
  challengeId: string | null,
  expiresAt?: string,
) {
  return useQuery({
    queryKey: waResetKeys.status(challengeId ?? ""),
    queryFn: ({ signal }) => getWaResetStatus(challengeId ?? "", signal),
    enabled: challengeId !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) => {
      const error = query.state.error;
      if (error instanceof ApiError && error.status === 404) return false;
      const view = query.state.data;
      if (view && view.status !== "pending") return false;
      const until = Date.parse(view?.expiresAt ?? expiresAt ?? "");
      if (Number.isFinite(until) && until <= Date.now()) return false;
      return WA_RESET_POLL_MS;
    },
  });
}

/**
 * POST .../reset-wa/:id/pin. A retry of the same PIN reuses its idempotency key
 * (a dropped response does not save twice); a different PIN gets a new one.
 */
export function useSubmitWaResetPin(challengeId: string | null) {
  const queryClient = useQueryClient();
  const lastKey = useRef<{
    challengeId: string | null;
    pin: string;
    key: string;
  } | null>(null);
  return useMutation({
    mutationFn: (pin: string) => {
      if (challengeId === null)
        throw new ApiError(404, "NOT_FOUND", "Permintaan tidak ditemukan.");
      const previous = lastKey.current;
      // A key never carries over to another challenge.
      const key =
        previous?.challengeId === challengeId && previous.pin === pin
          ? previous.key
          : newIdempotencyKey();
      lastKey.current = { challengeId, pin, key };
      return submitWaResetPin(challengeId, { pin, idempotencyKey: key });
    },
    gcTime: 0,
    onSuccess: (result) => {
      lastKey.current = null;
      const status: PayslipPinStatus = {
        status: result.status,
        lockedUntil: result.lockedUntil,
      };
      queryClient.setQueryData(payslipPinKeys.status(), status);
    },
  });
}

/** POST .../reset-wa/:id/cancel: the old code stops working. */
export function useCancelWaReset(challengeId: string | null) {
  return useMutation({
    mutationFn: async () => {
      if (challengeId !== null) await cancelWaReset(challengeId);
    },
    gcTime: 0,
  });
}
