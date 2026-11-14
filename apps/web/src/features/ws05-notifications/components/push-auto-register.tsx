import { useEffect } from "react";
import { API_MOCK } from "@/lib/api/mock-flag";
import { usePushRegistration } from "../hooks";

// Module scope, not a ref: an area switch remounts the frame, but the check
// still runs only once per user per page load. Effects never run during SSR.
let checkedFor: string | null = null;

/**
 * Renews this browser's push registration after login (bead legend-xdlxa).
 * A browser that still holds a subscription may be unknown to the server
 * (registered_at empty or older than 30 days), which silently stops its
 * notifications. Once per signed-in user per page load the server's device
 * list is checked and the registration renewed when it is missing. A failure
 * is not retried here; the notification card offers a manual retry. It never
 * asks for permission: only an already subscribed browser is touched.
 * Renders nothing.
 */
export function PushAutoRegister({ userId }: { userId: string | null }) {
  const pushRegistration = usePushRegistration();

  useEffect(() => {
    if (API_MOCK || !userId || checkedFor === userId) return;
    checkedFor = userId;
    void pushRegistration.sync(userId).catch(() => {
      // Nothing to report from here; the card shows the state on demand.
    });
    // Runs once per user: the registration helper changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
  return null;
}
