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

/**
 * Who a retained attempt belongs to: tenant, user and outlet reach. Another
 * login on this tab, or the same login with other outlets, never reuses a key.
 */
export function retainedOwnerKey(owner: {
  tenant: string;
  userId: string;
  outletIds: readonly string[];
}): string {
  return JSON.stringify([
    owner.tenant,
    owner.userId,
    [...owner.outletIds].sort(),
  ]);
}

export function retainedAttempt(
  scope: string,
  owner: string,
): AttemptKeyTracker {
  const slot = `${owner}|${scope}`;
  let tracker = trackers.get(slot);
  if (!tracker) {
    tracker = createAttemptKeyTracker();
    trackers.set(slot, tracker);
  }
  return tracker;
}

/** Forget every retained attempt (sign-out, tests). */
export function clearRetainedAttempt(): void {
  trackers.clear();
}
