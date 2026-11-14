import { deletePushSubscription } from "./api";
import {
  forgetSubscriptionId,
  readStoredSubscriptionId,
  unsubscribeThisBrowser,
} from "./push";

// Longest sign-out waits for the revoke; a slow network must not keep the
// person logged in.
const REVOKE_TIMEOUT_MS = 2000;

/**
 * Best-effort: removes this browser's push subscription (API row, then the
 * browser's own) before sign-out ends the session. The API row must go while
 * the session still exists, otherwise the next person on this browser would
 * receive the previous user's alarms. Never throws and never waits longer
 * than REVOKE_TIMEOUT_MS.
 */
export async function revokePushOnSignOut(): Promise<void> {
  const run = async () => {
    const id = readStoredSubscriptionId();
    try {
      if (id !== null) await deletePushSubscription(id);
    } catch {
      // The API drops the row with the session anyway.
    }
    await unsubscribeThisBrowser();
    forgetSubscriptionId();
  };
  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, REVOKE_TIMEOUT_MS),
  );
  try {
    await Promise.race([run(), timeout]);
  } catch {
    // Sign-out goes on regardless.
  }
}
