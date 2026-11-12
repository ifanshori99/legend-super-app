// "Streaming-like" reveal of an answer that already arrived whole: the text
// types in, the person can stop it, and reduced motion skips the animation.
import { useEffect, useState } from "react";
import { nextRevealLength } from "./logic";

const TICK_MS = 30;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type RevealState = { key: string | null; shown: number; stopped: boolean };

/**
 * `key` identifies the answer being revealed (its message id); a new key
 * restarts the reveal, `null` means nothing is revealing.
 */
export function useProgressiveReveal(text: string | null, key: string | null) {
  const [state, setState] = useState<RevealState>({
    key: null,
    shown: 0,
    stopped: false,
  });
  if (state.key !== key)
    setState({
      key,
      shown:
        key !== null && text !== null && prefersReducedMotion()
          ? text.length
          : 0,
      stopped: false,
    });

  const length = text?.length ?? 0;
  const shown = state.key === key ? Math.min(state.shown, length) : 0;
  const running = key !== null && !state.stopped && shown < length;

  useEffect(() => {
    if (!running || text === null) return;
    const timer = setInterval(() => {
      setState((current) =>
        current.key !== key || current.stopped
          ? current
          : { ...current, shown: nextRevealLength(text, current.shown) },
      );
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [running, key, text]);

  return {
    /** Characters of the answer to show now. */
    shown,
    running,
    /** The person pressed "Hentikan" before the end. */
    stopped: key !== null && state.stopped && shown < length,
    stop: () => setState((current) => ({ ...current, stopped: true })),
    showAll: () =>
      setState((current) => ({ ...current, shown: length, stopped: false })),
  };
}
