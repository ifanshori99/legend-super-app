// Browser-side memory of the device: who worked here recently (the picker),
// the PIN lock window (so a reload does not reset it) and the active staff
// member. Storage can be blocked; every access is guarded.
import { useMemo, useSyncExternalStore } from "react";
import { ACTIVE_STAFF_STORAGE_KEY } from "@/lib/api/acting-staff";

// The POS "active cashier" token lives in lib/api/acting-staff.ts (the API
// client reads it); re-exported so POS beads import it from this feature.
export {
  clearActingStaffToken,
  releaseActingStaffToken,
  readActingStaffToken,
  writeActingStaffToken,
} from "@/lib/api/acting-staff";

const ROSTER_KEY = "legend-device-roster";
const LOCK_KEY = "legend-device-pin-lock";
const ACTIVE_KEY = ACTIVE_STAFF_STORAGE_KEY;

export type RosterEntry = { userId: string; displayName: string };
export type PinLockState = {
  failedAttempts: number;
  lockedUntil: string | null;
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The in-memory React state still works for this page.
  }
  listeners.forEach((listener) => listener());
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readRoster(): RosterEntry[] {
  const value = read<unknown>(ROSTER_KEY, []);
  return Array.isArray(value)
    ? value.filter(
        (row): row is RosterEntry =>
          typeof row?.userId === "string" &&
          typeof row?.displayName === "string",
      )
    : [];
}

export function rememberStaff(entry: RosterEntry) {
  const rest = readRoster().filter((row) => row.userId !== entry.userId);
  write(ROSTER_KEY, [entry, ...rest].slice(0, 8));
}

/** Mock only: seeds a device that never had a roster; an explicit "[]" stays empty. */
export function seedRosterIfEmpty(entries: RosterEntry[]) {
  let unset = false;
  try {
    unset = window.localStorage.getItem(ROSTER_KEY) === null;
  } catch {
    unset = false;
  }
  if (unset) write(ROSTER_KEY, entries);
}

export function readPinLock(): PinLockState {
  const value = read<Partial<PinLockState>>(LOCK_KEY, {});
  return {
    failedAttempts:
      typeof value.failedAttempts === "number" ? value.failedAttempts : 0,
    lockedUntil:
      typeof value.lockedUntil === "string" ? value.lockedUntil : null,
  };
}

export function writePinLock(state: PinLockState) {
  write(LOCK_KEY, state);
}

export function clearPinLock() {
  writePinLock({ failedAttempts: 0, lockedUntil: null });
}

let activeCache: { raw: string | null; value: RosterEntry | null } = {
  raw: null,
  value: null,
};

function activeSnapshot(): RosterEntry | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(ACTIVE_KEY);
  } catch {
    raw = null;
  }
  if (raw === activeCache.raw) return activeCache.value;
  let value: RosterEntry | null = null;
  try {
    value = raw === null ? null : (JSON.parse(raw) as RosterEntry);
  } catch {
    value = null;
  }
  activeCache = { raw, value };
  return value;
}

export function setActiveStaff(entry: RosterEntry) {
  write(ACTIVE_KEY, entry);
}

/** The staff member signed in on this device; null on the server render. */
export function useActiveStaff(): RosterEntry | null {
  return useSyncExternalStore(subscribe, activeSnapshot, () => null);
}

function useStoredRaw(key: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null,
  );
}

/** Staff who worked on this device recently; empty on the server render. */
export function useRoster(): RosterEntry[] {
  const raw = useStoredRaw(ROSTER_KEY);
  return useMemo(() => {
    try {
      const value: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(value)
        ? value.filter(
            (row): row is RosterEntry =>
              typeof row?.userId === "string" &&
              typeof row?.displayName === "string",
          )
        : [];
    } catch {
      return [];
    }
  }, [raw]);
}

export function usePinLockState(): PinLockState {
  const raw = useStoredRaw(LOCK_KEY);
  return useMemo(() => {
    try {
      const value = (
        raw === null ? {} : JSON.parse(raw)
      ) as Partial<PinLockState>;
      return {
        failedAttempts:
          typeof value.failedAttempts === "number" ? value.failedAttempts : 0,
        lockedUntil:
          typeof value.lockedUntil === "string" ? value.lockedUntil : null,
      };
    } catch {
      return { failedAttempts: 0, lockedUntil: null };
    }
  }, [raw]);
}
