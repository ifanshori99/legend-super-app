// Client-only clocks. Heartbeats and print queues are live data: the server
// cannot know them, so these hooks return null until hydration and the
// screens skip time-dependent text instead of guessing (no hydration drift).
import { useSyncExternalStore } from "react";

/** Re-render every 5 seconds; enough for a 30-second offline threshold. */
const TICK_MS = 5_000;

let nowMs: number | null = null;

function subscribeTick(onChange: () => void) {
  nowMs = Date.now();
  onChange();
  const id = window.setInterval(() => {
    nowMs = Date.now();
    onChange();
  }, TICK_MS);
  return () => window.clearInterval(id);
}

function subscribeNever() {
  return () => {};
}

export function useNowMs(): number | null {
  return useSyncExternalStore(
    subscribeTick,
    () => nowMs,
    () => null,
  );
}

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}
