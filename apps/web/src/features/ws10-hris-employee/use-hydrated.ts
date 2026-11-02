// Client-only clocks (same pattern as features/ws02-edge/use-now.ts): the
// server cannot know the device's business date, so these hooks answer
// "unknown" during SSR instead of guessing and drifting on hydration.
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
