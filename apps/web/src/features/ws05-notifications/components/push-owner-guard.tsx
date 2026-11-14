import { useEffect } from "react";
import {
  forgetSubscriptionId,
  readOwnerEndpoint,
  readOwnerGeneration,
  readPushOwner,
  unsubscribeThisBrowser,
} from "../push";

/**
 * Keeps one account per browser push endpoint. When the signed-in user is not
 * the one who registered this browser's subscription, the subscription is
 * dropped (the next registration creates a fresh endpoint). Signed out: left
 * alone, an idle phone keeps receiving. A run overtaken by a newer
 * registration (owner generation changed) is abandoned, like revoke.ts: it
 * must not unsubscribe or forget what the next account just saved. Renders
 * nothing.
 */
export function PushOwnerGuard({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (!userId) return;
    const owner = readPushOwner();
    if (owner === null || owner === userId) return;
    const generation = readOwnerGeneration();
    // Only the previous owner's endpoint: the next account may already hold
    // a fresh one that is still being saved.
    const endpoint = readOwnerEndpoint();
    const cancelled = () => readOwnerGeneration() !== generation;
    void (async () => {
      if (cancelled()) return;
      await unsubscribeThisBrowser(endpoint);
      if (cancelled()) return;
      forgetSubscriptionId();
    })();
  }, [userId]);
  return null;
}
