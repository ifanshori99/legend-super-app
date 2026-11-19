// One rule for "Dikunci platform", shared by the ChatGPT badge and the service
// order row so they never disagree. Only a ChatGPT that is not connected reads
// as locked: a saved connection keeps its own status visible under the lock.
import type { ChatgptLoginStatus } from "@starter/shared/ai";

export function showsPlatformLock(
  state: ChatgptLoginStatus["state"],
  tenantLocked: boolean,
  platformDisabled: boolean,
): boolean {
  return state === "disconnected" && (tenantLocked || platformDisabled);
}
