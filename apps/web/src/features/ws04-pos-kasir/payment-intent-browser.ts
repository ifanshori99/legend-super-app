// The browser side of ./payment-intent-store.ts: localStorage with change
// notices (this tab and other tabs) and the requests this tab is sending now.
import { ApiError } from "@/lib/api/errors";
import {
  INTENT_STORAGE_UNAVAILABLE,
  intentStorageKey,
  type IntentScope,
} from "./payment-intent-store";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function subscribeIntents(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") return () => listeners.delete(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function browserStorage(): Storage {
  try {
    const storage = globalThis.localStorage;
    if (storage) return storage;
  } catch {
    // Blocked storage: reported below.
  }
  throw new ApiError(
    0,
    INTENT_STORAGE_UNAVAILABLE,
    "Peramban tidak bisa menyimpan permintaan pembayaran. Pembayaran belum dikirim.",
  );
}

/** localStorage that tells the screens about every change. */
export function intentStorage(): Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
> {
  const storage = browserStorage();
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      storage.setItem(key, value);
      notify();
    },
    removeItem: (key) => {
      storage.removeItem(key);
      notify();
    },
  };
}

/** Unreadable storage reads as a value no parser accepts, so the bill locks. */
export function rawIntent(scope: IntentScope): string | null {
  try {
    return browserStorage().getItem(intentStorageKey(scope));
  } catch {
    return "unreadable";
  }
}

const sending = new Map<string, number>();

/** This tab is sending this request now: its own panel shows the progress. */
export const isSendingIntent = (scope: IntentScope): boolean =>
  sending.has(intentStorageKey(scope));

export async function whileSending<T>(
  scope: IntentScope,
  run: () => Promise<T>,
): Promise<T> {
  const id = intentStorageKey(scope);
  sending.set(id, (sending.get(id) ?? 0) + 1);
  notify();
  try {
    return await run();
  } finally {
    const left = (sending.get(id) ?? 1) - 1;
    if (left > 0) sending.set(id, left);
    else sending.delete(id);
    notify();
  }
}
