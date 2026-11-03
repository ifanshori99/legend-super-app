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
  /**
   * The staff member whose PIN is being verified. Per-staff PIN verify
   * (legend-dxb) needs an explicit person; null fails closed with a prompt to
   * pick one, so a device never guesses whose PIN it just checked.
   */
  userId: string | null;
};

export function usePinSession({
  onVerified,
  accept,
  userId,
}: UsePinSessionOptions) {
  const t = useT();
  const lock = usePinLock();
  const verify = useVerifyStaffPin();
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
      // Fail closed: a PIN belongs to a named staff member, so a device that
      // has not picked one cannot verify anything.
      if (userId === null) {
        fail(t("devicePin.error.pickStaff"));
        return;
      }
      verify.mutate(
        { userId, pin },
        {
          // Forget the PIN as soon as the answer is in: the mutation keeps its
          // variables until reset (no PIN in the query client, ever).
          onSettled: () => verify.reset(),
          onSuccess: ({ data }) => {
            const refusal = accept?.(data) ?? null;
            if (refusal) {
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
    [verify, accept, fail, lock, onVerified, userId, t],
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
