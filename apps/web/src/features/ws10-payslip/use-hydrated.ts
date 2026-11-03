// Client-only reads for the employee PWA money screens (bead legend-23nc).
//
// The karyawan area is a noindex PWA behind a guard, and mock mode reads its
// scenario from the browser's localStorage/query string; the server render
// cannot know either, so every query starts after hydration and the SSR output
// is the screen's skeleton (same pattern as features/ws10-hris-employee).
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
