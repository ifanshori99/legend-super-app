// Offline queue for attendance correction requests (PRD F25 "Koreksi Absensi",
// §2 PWA "offline queue"). A correction carries no photo, so it can wait on the
// device: the submission keeps its idempotency key, and the API treats a replay
// as the same request. Clock-in itself is not queued — its selfie cannot reach
// the private bucket while offline — so that screen states the reason instead
// of pretending to succeed (see `attendance-clock.tsx`).
//
// Storage is injectable so the root node test can exercise the queue without a
// browser. Adding an entry (`enqueueCorrection`, `replaceQueuedCorrection`)
// throws `CorrectionQueueWriteError` when the device cannot store it, so the
// employee is never told a request is queued when it is not (legend-pl8hc).
// Bookkeeping writes (remove, refuse, clear) stay best effort.

import type { z } from "zod";
import type { requestAttendanceCorrection } from "@starter/shared/hris";

export type CorrectionSubmission = z.input<
  typeof requestAttendanceCorrection.body
>;

export type QueuedCorrection = {
  /** The request's idempotency key — one entry per attempt. */
  key: string;
  /**
   * The session employee who filed it. A shared outlet phone can switch
   * accounts while offline; a replay must never go out under someone else's
   * session (HR-01), so only the filer's own entries are replayed or shown.
   */
  employeeId: string;
  body: CorrectionSubmission;
  queuedAt: string;
  /**
   * Set when the server gave a final 4xx answer on replay. The entry stays so
   * the employee sees why and can retry, edit or discard it (legend-nvc7).
   */
  refused?: CorrectionRefusal;
};

export type CorrectionRefusal = {
  status: number;
  code: string;
  reason: string;
  at: string;
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

function isRefusal(value: unknown): value is CorrectionRefusal {
  if (typeof value !== "object" || value === null) return false;
  const refusal = value as Partial<CorrectionRefusal>;
  return (
    typeof refusal.status === "number" &&
    typeof refusal.code === "string" &&
    typeof refusal.reason === "string" &&
    typeof refusal.at === "string"
  );
}

/**
 * Thrown when a new entry cannot be stored: the queue is at MAX_QUEUED and
 * every entry in it is refused. A refused entry waits for the employee's
 * decision (Coba lagi / Ubah / Buang), so it is never dropped for a newer one,
 * and the new request is not reported as saved (legend-l5tvy).
 */
export class CorrectionQueueFullError extends Error {
  constructor() {
    super("The correction queue is full of refused requests.");
    this.name = "CorrectionQueueFullError";
  }
}

/**
 * Appends `entry` to `rest`, keeping at most MAX_QUEUED. Only waiting
 * (non-refused) entries are evicted, oldest first; a refused entry is never
 * dropped and neither is the new one. When that is not enough room the queue
 * is left as it was and `CorrectionQueueFullError` is thrown.
 */
function fitQueue(
  rest: QueuedCorrection[],
  entry: QueuedCorrection,
): QueuedCorrection[] {
  const excess = rest.length + 1 - MAX_QUEUED;
  if (excess <= 0) return [...rest, entry];
  const evictable = rest.filter((row) => row.refused === undefined);
  if (evictable.length < excess) throw new CorrectionQueueFullError();
  const dropped = new Set(evictable.slice(0, excess));
  return [...rest.filter((row) => !dropped.has(row)), entry];
}

function isQueued(value: unknown): value is QueuedCorrection {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<QueuedCorrection>;
  return (
    typeof row.key === "string" &&
    row.key.length > 0 &&
    typeof row.employeeId === "string" &&
    row.employeeId.length > 0 &&
    typeof row.queuedAt === "string" &&
    typeof row.body === "object" &&
    row.body !== null &&
    (row.refused === undefined || isRefusal(row.refused))
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

/**
 * Thrown when a new entry could not be written to the device (storage full,
 * blocked or absent). Nothing was queued, so the caller must say the request
 * was not saved instead of reporting "antre" (legend-pl8hc).
 */
export class CorrectionQueueWriteError extends Error {
  constructor() {
    super("The correction could not be saved on this device.");
    this.name = "CorrectionQueueWriteError";
  }
}

/** Writes the queue; returns false when the storage refused or is missing. */
export function writeCorrectionQueue(
  queue: readonly QueuedCorrection[],
  storage: StorageLike | null = browserStorage(),
): boolean {
  let stored = false;
  if (storage) {
    try {
      storage.setItem(CORRECTION_QUEUE_KEY, JSON.stringify(queue));
      stored = true;
    } catch {
      // Quota or blocked storage: reported through the return value.
    }
  }
  notifyQueueChanged();
  return stored;
}

function writeNewEntry(
  queue: readonly QueuedCorrection[],
  storage: StorageLike | null,
): void {
  if (!writeCorrectionQueue(queue, storage))
    throw new CorrectionQueueWriteError();
}

/**
 * Adds one attempt; replaying the same key replaces it (idempotent). Throws
 * `CorrectionQueueFullError` when the queue holds MAX_QUEUED refused entries,
 * and `CorrectionQueueWriteError` when the device cannot store the entry.
 */
export function enqueueCorrection(
  body: CorrectionSubmission,
  employeeId: string,
  storage: StorageLike | null = browserStorage(),
  now: Date = new Date(),
): QueuedCorrection[] {
  const entry: QueuedCorrection = {
    key: body.idempotencyKey,
    employeeId,
    body,
    queuedAt: now.toISOString(),
  };
  const rest = readCorrectionQueue(storage).filter(
    (row) => row.key !== entry.key,
  );
  const queue = fitQueue(rest, entry);
  writeNewEntry(queue, storage);
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

/** The entries one employee filed; everyone else's stay untouched. */
export function queuedFor(
  queue: readonly QueuedCorrection[],
  employeeId: string | null,
): QueuedCorrection[] {
  return employeeId === null
    ? []
    : queue.filter((row) => row.employeeId === employeeId);
}

/**
 * True when replaying again can still succeed: no connection, a timeout, rate
 * limiting or a server fault. A 4xx answer (validation, not found, key reused)
 * is final: the entry stays but is marked refused, so it neither blocks every
 * entry behind it forever nor vanishes without the employee seeing why.
 */
export function isRetryableReplayError(status: number | undefined): boolean {
  if (status === undefined || status === 0) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

export function isRefused(row: QueuedCorrection): boolean {
  return row.refused !== undefined;
}

/** Flags one entry as refused by the server; it stays queued. */
export function markCorrectionRefused(
  key: string,
  refusal: CorrectionRefusal,
  storage: StorageLike | null = browserStorage(),
): QueuedCorrection[] {
  const queue = readCorrectionQueue(storage).map((row) =>
    row.key === key ? { ...row, refused: refusal } : row,
  );
  writeCorrectionQueue(queue, storage);
  return queue;
}

/** "Coba lagi": drops the refusal flag so the entry is waiting again. */
export function clearCorrectionRefusal(
  key: string,
  storage: StorageLike | null = browserStorage(),
): QueuedCorrection[] {
  const queue = readCorrectionQueue(storage).map((row) => {
    if (row.key !== key || row.refused === undefined) return row;
    const cleared: QueuedCorrection = { ...row };
    delete cleared.refused;
    return cleared;
  });
  writeCorrectionQueue(queue, storage);
  return queue;
}

/**
 * "Ubah": the old attempt leaves, the edited one joins under its new key, in
 * one write, so the queue never holds neither and never grows past the limit.
 * Only an entry of the same `employeeId` can be replaced; an unknown key or
 * another employee's entry leaves the queue untouched (nothing is added).
 */
export function replaceQueuedCorrection(
  oldKey: string,
  body: CorrectionSubmission,
  employeeId: string,
  storage: StorageLike | null = browserStorage(),
  now: Date = new Date(),
): QueuedCorrection[] {
  const current = readCorrectionQueue(storage);
  const owned = current.some(
    (row) => row.key === oldKey && row.employeeId === employeeId,
  );
  if (!owned) return current;
  const entry: QueuedCorrection = {
    key: body.idempotencyKey,
    employeeId,
    body,
    queuedAt: now.toISOString(),
  };
  const rest = current.filter(
    (row) => row.key !== oldKey && row.key !== entry.key,
  );
  const queue = fitQueue(rest, entry);
  writeNewEntry(queue, storage);
  return queue;
}

/** True when the queue holds an entry with this key filed by this employee. */
export function hasQueuedCorrection(
  key: string,
  employeeId: string,
  storage: StorageLike | null = browserStorage(),
): boolean {
  return readCorrectionQueue(storage).some(
    (row) => row.key === key && row.employeeId === employeeId,
  );
}

export type ReplayOutcome = "sent" | "refused" | "retryLater";

/**
 * One replay step. The submit function is injected so the hook and the node
 * test share it. Success removes the entry; a retryable failure keeps it
 * untouched; a final 4xx keeps it too, marked with the server's reason. An
 * error that is not an `ApiError` has no status and counts as retryable.
 */
export async function replayQueuedCorrection(
  row: QueuedCorrection,
  submit: (body: CorrectionSubmission) => Promise<unknown>,
  storage: StorageLike | null = browserStorage(),
  now: Date = new Date(),
): Promise<ReplayOutcome> {
  try {
    await submit(row.body);
  } catch (error) {
    const detail = error as { status?: unknown; code?: unknown } | null;
    const status =
      typeof detail?.status === "number" ? detail.status : undefined;
    if (isRetryableReplayError(status) || status === undefined)
      return "retryLater";
    markCorrectionRefused(
      row.key,
      {
        status,
        code: typeof detail?.code === "string" ? detail.code : "",
        reason: error instanceof Error ? error.message : "",
        at: now.toISOString(),
      },
      storage,
    );
    return "refused";
  }
  removeQueuedCorrection(row.key, storage);
  return "sent";
}

/**
 * Replays the given entries in order. Refused entries are skipped; the first
 * "retryLater" stops the run (still offline or server down); a 4xx entry does
 * not block the ones behind it.
 */
export async function replayCorrectionQueue(
  rows: readonly QueuedCorrection[],
  submit: (body: CorrectionSubmission) => Promise<unknown>,
  storage: StorageLike | null = browserStorage(),
  now: Date = new Date(),
): Promise<{ sent: number; refused: number }> {
  let sent = 0;
  let refused = 0;
  for (const row of rows) {
    if (isRefused(row)) continue;
    const outcome = await replayQueuedCorrection(row, submit, storage, now);
    if (outcome === "retryLater") break;
    if (outcome === "sent") sent += 1;
    else refused += 1;
  }
  return { sent, refused };
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
