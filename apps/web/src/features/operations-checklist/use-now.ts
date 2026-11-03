// Client-only clock for deadline and remaining-time text. Times are data:
// the server cannot know the client's minute, so the hook returns null before
// hydration and the screens skip ticking text instead of guessing (no
// hydration drift). Ticks every 30 s, enough for minute-level deadlines.
import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;

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

export function useNowMs(): number | null {
  return useSyncExternalStore(
    subscribeTick,
    () => nowMs,
    () => null,
  );
}
