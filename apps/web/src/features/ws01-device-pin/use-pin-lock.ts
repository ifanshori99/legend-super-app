// Lockout bookkeeping for the PIN pad (PRD v1.7 §3 F6: locked after 5 wrong
// PINs). The numbers come from @starter/shared/identity; the transition is
// the contract's own recordStaffPinAttempt. The server stays the authority:
// a PIN_LOCKED answer locks this device even when the local count is lower.
import { useCallback } from "react";
import {
  MAX_STAFF_PIN_ATTEMPTS,
  MINUTE_MS,
  STAFF_PIN_LOCK_MINUTES,
  recordStaffPinAttempt,
  resetStaffPinAttempts,
} from "@starter/shared/identity";
import { lockRemainingMs } from "./logic.ts";
import { usePinLockState, writePinLock } from "./storage.ts";
import { useClockMs } from "./use-clock.ts";

export function usePinLock() {
  const nowMs = useClockMs();
  const state = usePinLockState();

  const remainingMs =
    nowMs === null ? 0 : lockRemainingMs(state.lockedUntil, nowMs);
  const locked = remainingMs > 0;
  const lockRanOut = state.lockedUntil !== null && nowMs !== null && !locked;

  const recordInvalid = useCallback(() => {
    if (locked) return;
    writePinLock(
      recordStaffPinAttempt({ state, correct: false, now: new Date() }),
    );
  }, [state, locked]);

  const recordServerLocked = useCallback(() => {
    writePinLock({
      failedAttempts: MAX_STAFF_PIN_ATTEMPTS,
      lockedUntil: new Date(
        Date.now() + STAFF_PIN_LOCK_MINUTES * MINUTE_MS,
      ).toISOString(),
    });
  }, []);

  const recordSuccess = useCallback(
    () => writePinLock(resetStaffPinAttempts()),
    [],
  );

  return {
    // A lock that ran out starts a fresh count (recordStaffPinAttempt does the same).
    failedAttempts: lockRanOut ? 0 : state.failedAttempts,
    attemptsLeft: lockRanOut
      ? MAX_STAFF_PIN_ATTEMPTS
      : Math.max(0, MAX_STAFF_PIN_ATTEMPTS - state.failedAttempts),
    locked,
    remainingMs,
    recordInvalid,
    recordServerLocked,
    recordSuccess,
  };
}
