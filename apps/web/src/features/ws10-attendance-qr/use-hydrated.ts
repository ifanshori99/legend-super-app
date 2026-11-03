// Client-only clocks: the server cannot know the outlet's business date or the
// live QR window, so these hooks answer "unknown" during SSR instead of
// guessing and drifting on hydration (same pattern as the employee PWA).
import { useSyncExternalStore } from "react";

function subscribeNever() {
  return () => {};
}

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}
