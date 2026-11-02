// Browser-side holder of the guest session credential (sessionStorage per tab,
// device hash in localStorage). External store so components re-render when the
// guest joins or the session ends; the server snapshot is always "no session",
// so SSR output and the first client render agree.
import { useSyncExternalStore } from "react";
import { registerBearerProvider } from "@/lib/api/credentials";
import {
  clearGuestSession,
  deviceHash,
  readGuestSession,
  sessionTokenFor,
  writeGuestSession,
  type StoredGuestSession,
} from "./lib/guest-session.ts";
import { newIdempotencyKey } from "../../lib/idempotency.ts";

const listeners = new Set<() => void>();
let version = 0;
const cache = new Map<string, StoredGuestSession | null>();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
function persistentStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function emit() {
  version += 1;
  cache.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(qrToken: string): StoredGuestSession | null {
  const key = `${version}:${qrToken}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const store = storage();
  const value = store ? readGuestSession(store, qrToken, Date.now()) : null;
  cache.set(key, value);
  return value;
}

export function useStoredGuestSession(
  qrToken: string,
): StoredGuestSession | null {
  return useSyncExternalStore(
    subscribe,
    () => snapshot(qrToken),
    () => null,
  );
}

export function saveGuestSession(session: StoredGuestSession) {
  const store = storage();
  if (!store) return;
  try {
    writeGuestSession(store, session);
  } catch {
    // Storage full or blocked (private mode): the guest stays signed in for
    // this page view only.
  }
  emit();
}

export function forgetGuestSession(qrToken: string) {
  const store = storage();
  if (!store) return;
  clearGuestSession(store, qrToken);
  emit();
}

/** Bearer credential for table-session calls; used by apiFetch in the browser. */
export function guestSessionTokenForPath(path: string): string | null {
  const match = /^\/api\/table-sessions\/([^/?#]+)/.exec(path);
  const store = storage();
  if (!match || !store) return null;
  return sessionTokenFor(store, decodeURIComponent(match[1]), Date.now());
}

registerBearerProvider((path) => guestSessionTokenForPath(path));

export function currentDeviceHash(): string {
  const store = persistentStorage();
  const random = () => newIdempotencyKey();
  if (!store) return random().replace(/-/g, "").slice(0, 32).toLowerCase();
  try {
    return deviceHash(store, random);
  } catch {
    return random().replace(/-/g, "").slice(0, 32).toLowerCase();
  }
}
