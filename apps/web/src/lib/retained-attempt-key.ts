// An idempotency attempt that outlives its dialog. A dialog mounted only while
// open loses its `useState` key on close, so a retry after a lost response
// (close, reopen, submit again) would mint a new key and could repeat the
// money change. Trackers are kept per scope; the same request reuses its key
// until a save succeeds (`settle`) or the request changes.
import {
  createAttemptKeyTracker,
  type AttemptKeyTracker,
} from "../features/ws05-payment-admin/attempt-key.ts";

const trackers = new Map<string, AttemptKeyTracker>();

export function retainedAttempt(scope: string): AttemptKeyTracker {
  let tracker = trackers.get(scope);
  if (!tracker) {
    tracker = createAttemptKeyTracker();
    trackers.set(scope, tracker);
  }
  return tracker;
}

/** Forget every retained attempt (sign-out, tests). */
export function clearRetainedAttempt(): void {
  trackers.clear();
}
