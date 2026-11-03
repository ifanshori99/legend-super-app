// One-second client clock for lock and approval countdowns. Returns null until
// hydration so the server render never prints a time.
import { useSyncExternalStore } from "react";

let nowMs: number | null = null;
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(onChange: () => void) {
  if (listeners.size === 0) {
    nowMs = Date.now();
    timer = window.setInterval(() => {
      nowMs = Date.now();
      listeners.forEach((listener) => listener());
    }, 1000);
  }
  listeners.add(onChange);
  onChange();
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) window.clearInterval(timer);
  };
}

export function useClockMs(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => nowMs,
    () => null,
  );
}
