import { deletePushSubscription } from "./api";
import {
  forgetSubscriptionId,
  readOwnerEndpoint,
  readOwnerGeneration,
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
 * than REVOKE_TIMEOUT_MS. A run that lost to the timeout is abandoned, and so
 * is a run overtaken by a newer registration (owner generation changed): it
 * must not unsubscribe or forget what the next account just saved.
 */
export async function revokePushOnSignOut(): Promise<void> {
  let abandoned = false;
  const generation = readOwnerGeneration();
  const endpoint = readOwnerEndpoint();
  const cancelled = () => abandoned || readOwnerGeneration() !== generation;
  const run = async () => {
    const id = readStoredSubscriptionId();
    try {
      if (id !== null) await deletePushSubscription(id);
    } catch {
      // The API drops the row with the session anyway.
    }
    if (cancelled()) return;
    await unsubscribeThisBrowser(endpoint);
    if (cancelled()) return;
    forgetSubscriptionId();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      abandoned = true;
      resolve();
    }, REVOKE_TIMEOUT_MS);
  });
  try {
    await Promise.race([run(), timeout]);
  } catch {
    // Sign-out goes on regardless.
  } finally {
    clearTimeout(timer);
  }
}
