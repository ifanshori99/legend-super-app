// Sound for the pickup display (PRD §3 F12 "Pickup Display ... dengan notifikasi
// suara"). Speech synthesis is the one announcement channel every outlet tablet
// and TV box already has, so the display speaks through the device's own
// speaker; no extra hardware or vendor. Sound is never the only signal — the
// number is always on screen too (WCAG 1.1.1).
import type { PickupCall } from "@starter/shared/kitchen";

const SOUND_STORAGE_KEY = "legend-pickup-sound";

/** Whether this browser can speak. False on the server and on devices without TTS. */
export function pickupSpeechSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

/** The operator's choice, remembered per device (a wall display is set once). */
export function readPickupSoundEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SOUND_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writePickupSoundEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(SOUND_STORAGE_KEY, "on");
    else window.localStorage.removeItem(SOUND_STORAGE_KEY);
  } catch {
    // Storage can be blocked; the choice still applies for this page.
  }
}

/**
 * Speaks one announcement in Indonesian. Returns false when the device cannot
 * speak, so the screen can say so instead of pretending.
 */
export function announcePickupNumber(text: string): boolean {
  if (!pickupSpeechSupported()) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "id-ID";
  window.speechSynthesis.speak(utterance);
  return true;
}

// The preference is a browser store, not React state: the wall display reads it
// with useSyncExternalStore (so the first client render after hydration is the
// stored choice, with no setState in an effect) and this module keeps it for
// the session.
let savedSound: boolean | null = null;
const soundListeners = new Set<() => void>();

export function subscribePickupSound(listener: () => void): () => void {
  soundListeners.add(listener);
  return () => {
    soundListeners.delete(listener);
  };
}

export function getPickupSoundSnapshot(): boolean {
  savedSound ??= readPickupSoundEnabled();
  return savedSound;
}

/** The server cannot know the device; the display starts silent. */
export function getPickupSoundServerSnapshot(): boolean {
  return false;
}

export function setPickupSoundEnabled(enabled: boolean): void {
  savedSound = enabled;
  writePickupSoundEnabled(enabled);
  for (const listener of soundListeners) listener();
}

let speechSupport: boolean | null = null;

/** Speech support cannot change mid-session; ask the browser once. */
export function getPickupSpeechSnapshot(): boolean {
  speechSupport ??= pickupSpeechSupported();
  return speechSupport;
}

/** Assume the device speaks until the browser says otherwise (no flash on load). */
export function getPickupSpeechServerSnapshot(): boolean {
  return true;
}

/** Speech support never changes, so nothing ever notifies. */
export function subscribeNever(): () => void {
  return () => {};
}

/**
 * Calls that were announced since the previous snapshot: `calledAt` appeared
 * between the two reads. The first snapshot announces nothing (a screen that
 * just opened must not read out every number of the day), and a number that
 * was already called is not repeated here.
 */
export function newlyCalledCalls(
  previous: readonly PickupCall[] | null,
  next: readonly PickupCall[],
): PickupCall[] {
  if (previous === null) return [];
  const alreadyCalled = new Set(
    previous.filter((call) => call.calledAt !== null).map((call) => call.id),
  );
  return (
    next
      .filter((call) => call.calledAt !== null && !alreadyCalled.has(call.id))
      // Announce in the order the numbers were called (calledAt), number as tie-break.
      .sort(
        (left, right) =>
          (left.calledAt ?? "").localeCompare(right.calledAt ?? "") ||
          left.number - right.number,
      )
  );
}
