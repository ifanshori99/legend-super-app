// Client-only one-second clock for countdowns. Returns null until hydration so
// server and client render the same markup (no drift).
import { useSyncExternalStore } from "react";

let nowMs: number | null = null;

function subscribe(onChange: () => void) {
  nowMs = Date.now();
  onChange();
  const id = window.setInterval(() => {
    nowMs = Date.now();
    onChange();
  }, 1000);
  return () => window.clearInterval(id);
}

export function useSecondClock(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => nowMs,
    () => null,
  );
}
