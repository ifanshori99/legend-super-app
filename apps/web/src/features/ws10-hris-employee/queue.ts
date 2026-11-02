// Offline queue for attendance correction requests (PRD F25 "Koreksi Absensi",
// §2 PWA "offline queue"). A correction carries no photo, so it can wait on the
// device: the submission keeps its idempotency key, and the API treats a replay
// as the same request. Clock-in itself is not queued — its selfie cannot reach
// the private bucket while offline — so that screen states the reason instead
// of pretending to succeed (see `attendance-clock.tsx`).
//
// Storage is injectable so the root node test can exercise the queue without a
// browser. The module never throws on a blocked storage: it degrades to the
// in-memory copy for this page load.

import type { z } from "zod";
import type { requestAttendanceCorrection } from "@starter/shared/hris";

export type CorrectionSubmission = z.input<
  typeof requestAttendanceCorrection.body
>;

export type QueuedCorrection = {
  /** The request's idempotency key — one entry per attempt. */
  key: string;
  body: CorrectionSubmission;
  queuedAt: string;
};

export const CORRECTION_QUEUE_KEY = "legend-hris-corrections-queue";
/** A phone that was offline for days should not grow without bound. */
const MAX_QUEUED = 20;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isQueued(value: unknown): value is QueuedCorrection {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<QueuedCorrection>;
  return (
    typeof row.key === "string" &&
    row.key.length > 0 &&
    typeof row.queuedAt === "string" &&
    typeof row.body === "object" &&
    row.body !== null
  );
}

export function readCorrectionQueue(
  storage: StorageLike | null = browserStorage(),
): QueuedCorrection[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(CORRECTION_QUEUE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isQueued) : [];
  } catch {
    return [];
  }
}

export function writeCorrectionQueue(
  queue: readonly QueuedCorrection[],
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(CORRECTION_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Quota or blocked storage: the in-memory list still reflects the attempt.
  }
  notifyQueueChanged();
}

/** Adds one attempt; replaying the same key replaces it (idempotent). */
export function enqueueCorrection(
  body: CorrectionSubmission,
  storage: StorageLike | null = browserStorage(),
  now: Date = new Date(),
): QueuedCorrection[] {
  const entry: QueuedCorrection = {
    key: body.idempotencyKey,
    body,
    queuedAt: now.toISOString(),
  };
  const rest = readCorrectionQueue(storage).filter(
    (row) => row.key !== entry.key,
  );
  const queue = [...rest, entry].slice(-MAX_QUEUED);
  writeCorrectionQueue(queue, storage);
  return queue;
}

export function removeQueuedCorrection(
  key: string,
  storage: StorageLike | null = browserStorage(),
): QueuedCorrection[] {
  const queue = readCorrectionQueue(storage).filter((row) => row.key !== key);
  writeCorrectionQueue(queue, storage);
  return queue;
}

// ---- Reactivity (this page's submissions, without a full reload) ----------

const listeners = new Set<() => void>();
let cachedSnapshot: QueuedCorrection[] | null = null;

/** Stable snapshot for useSyncExternalStore (a new array each call would loop). */
export function correctionQueueSnapshot(): QueuedCorrection[] {
  if (cachedSnapshot === null) cachedSnapshot = readCorrectionQueue();
  return cachedSnapshot;
}

export function subscribeCorrectionQueue(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === CORRECTION_QUEUE_KEY) notifyQueueChanged();
  };
  if (typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}

function notifyQueueChanged() {
  cachedSnapshot = null;
  for (const listener of listeners) listener();
}

