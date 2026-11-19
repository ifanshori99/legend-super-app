// One rule for "Dikunci platform", shared by the ChatGPT badge and the service
// order row so they never disagree. A ChatGPT that is not connected and cannot
// start a new login reads as locked (disconnected, failed, expired). Pending and
// connected keep their own status visible under the lock.
import type { ChatgptLoginStatus } from "@starter/shared/ai";

export function showsPlatformLock(
  state: ChatgptLoginStatus["state"],
  tenantLocked: boolean,
  platformDisabled: boolean,
): boolean {
  return (
    (state === "disconnected" || state === "failed" || state === "expired") &&
    (tenantLocked || platformDisabled)
  );
}
