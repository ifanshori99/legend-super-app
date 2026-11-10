// Verifies a typed PIN and turns the answer into pad state. mode "verify"
// (default) calls POST /api/staff-pins/verify (supervisor approvals); mode
// "pos-session" calls POST /api/staff-pins/pos-session instead and keeps the
// acting-staff token (POS switch; one call per PIN, never both). Pad state: shake + attempts left on PIN_INVALID, the lockout
// window on PIN_LOCKED, a network hint when the edge node is unreachable.
import { useCallback, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type {
  StaffPinSwitch,
  VerifyStaffPinInput,
} from "@starter/shared/identity";
import { userIdSchema } from "@starter/shared/core";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import {
  endPosSessionCall,
  startPosSessionCall,
  verifyStaffPinCall,
} from "./api.ts";
import { usePinLock } from "./use-pin-lock.ts";

export type PinSessionMode = "verify" | "pos-session";
/** What a POS switch knows about the staff member who is now active. */
export type PosSessionStaff = {
  user: { id: string; displayName: string };
  outletId: string;
};
type PinResult<M extends PinSessionMode> = M extends "pos-session"
  ? PosSessionStaff
  : StaffPinSwitch;

export type UsePinSessionOptions<M extends PinSessionMode = "verify"> = {
  mode?: M;
  /** The staff member whose PIN is being typed: the API counts misses per staff. */
  userId: string | null;
  onVerified: (result: PinResult<M>) => void;
  /** Return an error text to refuse a correct PIN (wrong person, same approver). */
  accept?: (result: PinResult<M>) => string | null;
};

export function usePinSession<M extends PinSessionMode = "verify">({
  mode,
  userId,
  onVerified,
  accept,
}: UsePinSessionOptions<M>) {
  const t = useT();
  const lock = usePinLock();
  // gcTime 0: a settled call (its variables are the PIN) leaves the cache at
  // once; the reset on settle below drops it from the mutation too.
  const verify = useMutation({
    mutationFn: async (input: VerifyStaffPinInput) => {
      if (mode !== "pos-session") return verifyStaffPinCall(input);
      const { data } = await startPosSessionCall(input);
      // The token is already stored; the screen only needs who and where.
      return {
        data: { user: data.staff, outletId: data.outletId },
      };
    },
    gcTime: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [clearSignal, setClearSignal] = useState(0);
  const [shakeSignal, setShakeSignal] = useState(0);

  // The pad empties itself when it hands a PIN over, so a failure does not
  // clear it: digits typed during the check are the next try (legend-6ew).
  const fail = useCallback((message: string) => {
    setError(message);
    setShakeSignal((n) => n + 1);
  }, []);

  const submit = useCallback(
    (pin: string) => {
      setError(null);
      // Fail closed: without a valid picked staff the API cannot count the
      // attempt (AUTH-06 per-staff lockout), so the PIN is not sent at all.
      const pickedUserId = userIdSchema.safeParse(userId);
      if (!pickedUserId.success) {
        fail(t("devicePin.error.pickStaff"));
        return;
      }
      verify.mutate(
        { userId: pickedUserId.data, pin },
        {
          // Forget the PIN as soon as the answer is in: the mutation keeps its
          // variables until reset (no PIN in the query client, ever).
          onSettled: () => verify.reset(),
          onSuccess: ({ data: answer }) => {
            const data = answer as PinResult<M>;
            const refusal = accept?.(data) ?? null;
            if (refusal) {
              // The API already made this person the active cashier; undo it.
              if (mode === "pos-session")
                void endPosSessionCall().catch(() => {});
              fail(refusal);
              return;
            }
            lock.recordSuccess();
            // Drop anything typed while the right PIN was being checked.
            setClearSignal((n) => n + 1);
            onVerified(data);
          },
          onError: (cause) => {
            if (cause instanceof ApiError && cause.code === "PIN_LOCKED") {
              lock.recordServerLocked();
              fail(t("devicePin.lockout.title"));
            } else if (
              cause instanceof ApiError &&
              cause.code === "PIN_INVALID"
            ) {
              lock.recordInvalid();
              fail(t("devicePin.error.invalid"));
            } else if (
              !(cause instanceof ApiError) ||
              cause.status === 0 ||
              cause.status >= 502
            ) {
              fail(t("devicePin.error.network"));
            } else {
              fail(t("devicePin.error.generic"));
            }
          },
        },
      );
    },
    [userId, verify, mode, accept, fail, lock, onVerified, t],
  );

  const clear = useCallback(() => setClearSignal((n) => n + 1), []);

  return {
    lock,
    submit,
    clear,
    padProps: {
      onComplete: submit,
      disabled: lock.locked,
      pending: verify.isPending,
      clearSignal,
      shakeSignal,
      error: lock.locked ? null : error,
      status: verify.isPending
        ? t("devicePin.pad.verifying")
        : lock.failedAttempts > 0 && !lock.locked
          ? t("devicePin.pad.attemptsLeft", { remaining: lock.attemptsLeft })
          : null,
    },
  };
}
