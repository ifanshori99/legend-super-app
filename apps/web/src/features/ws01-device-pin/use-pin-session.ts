// Verifies a typed PIN against POST /api/staff-pins/verify and turns the
// answer into pad state: shake + attempts left on PIN_INVALID, the lockout
// window on PIN_LOCKED, a network hint when the edge node is unreachable.
import { useCallback, useState } from "react";
import type { StaffPinSwitch } from "@starter/shared/identity";
import { useT } from "@/components/i18n";
import { ApiError } from "@/lib/api/errors";
import { useVerifyStaffPin } from "./hooks.ts";
import { usePinLock } from "./use-pin-lock.ts";

export type UsePinSessionOptions = {
  onVerified: (result: StaffPinSwitch) => void;
  /** Return an error text to refuse a correct PIN (wrong person, same approver). */
  accept?: (result: StaffPinSwitch) => string | null;
};

export function usePinSession({ onVerified, accept }: UsePinSessionOptions) {
  const t = useT();
  const lock = usePinLock();
  const verify = useVerifyStaffPin();
  const [error, setError] = useState<string | null>(null);
  const [clearSignal, setClearSignal] = useState(0);
  const [shakeSignal, setShakeSignal] = useState(0);

  const fail = useCallback((message: string) => {
    setError(message);
    setClearSignal((n) => n + 1);
    setShakeSignal((n) => n + 1);
  }, []);

  const submit = useCallback(
    (pin: string) => {
      setError(null);
      verify.mutate(pin, {
        onSuccess: ({ data }) => {
          const refusal = accept?.(data) ?? null;
          if (refusal) {
            fail(refusal);
            return;
          }
          lock.recordSuccess();
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
      });
    },
    [verify, accept, fail, lock, onVerified, t],
  );

  const clear = useCallback(() => setClearSignal((n) => n + 1), []);

  return {
    lock,
    submit,
    clear,
    padProps: {
      onComplete: submit,
      disabled: lock.locked || verify.isPending,
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
