// Uploads the edge's sealed selfies to the cloud, one file at a time (design
// docs/design/hris-edge-replication.md section 5, 9 T7). The edge keeps the
// sealed .lss file until the cloud has it; the cloud answer decides the row:
//
//   201 / 200            uploaded (committed first), then the file is deleted.
//                        A crash between the two leaves an `uploaded` row that
//                        is never retried; the hourly sweep removes the file.
//   409 403 413 422 400  rejected: final, the file stays for an operator.
//   5xx, 401, network,   stay pending: attempts + 1, next try after a capped
//   timeout              exponential backoff with jitter.
//   file gone (ENOENT)   expired: nothing left to send.
//   file hash != row     rejected (FILE_HASH_MISMATCH): the file changed on disk.
//
// Selfie bytes, the sealed meta and cloud response bodies are never logged or
// stored; logs and `last_error` carry an error class and the object id only.
// The loop shape follows device-registry-puller.ts: injected clock, random and
// timers, no overlapping runs, stop() aborts the PUT in flight.

import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { and, asc, eq, lte } from "drizzle-orm";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  SEALED_SHA256_HEADER,
  edgeSelfieAttendanceSelfiePath,
} from "@starter/shared/edge";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { edgeSelfieUploads } from "../db/schema/edge-hris.ts";
import { logger } from "../lib/logger.ts";
import { cloudHttpBaseUrl } from "./cloud-http.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
/** Cloud answers that are final for this file (the edge must not retry). */
const REJECTED_STATUSES: ReadonlySet<number> = new Set([
  400, 403, 409, 413, 422,
]);

// Node's fetch honours `cache`, but the Node typings omit it from RequestInit.
type EdgeRequestInit = RequestInit & { cache: "no-store" };

export type EdgeSelfieUploadOutcome =
  | "idle" // nothing due
  | "uploaded"
  | "rejected"
  | "expired"
  | "retry" // stays pending, backed off
  | "aborted" // stop() cut the PUT short; the row is untouched
  | "error"; // unexpected failure (database, disk); reported through onError

export type EdgeSelfieRejection = {
  objectId: string;
  /** Error class only: HTTP_<status> or FILE_HASH_MISMATCH. */
  reason: string;
};

export type EdgeSelfieUploadOptions = {
  context: ScopedTenantContext;
  cloudUrl: string;
  credential: string;
  fetchImpl?: typeof fetch;
  /** Idle poll interval and the base of the per-file backoff. */
  intervalMs: number;
  maxBackoffMs: number;
  /** PUT timeout (default 60 s). */
  timeoutMs?: number;
  now?: () => Date;
  random?: () => number;
  /** Alert hook for a rejected file; the uploader also logs it. */
  onRejected?: (rejection: EdgeSelfieRejection) => void;
};

export type EdgeSelfieUploaderOptions = EdgeSelfieUploadOptions & {
  /** Default: setTimeout + unref. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
};

export type EdgeSelfieUploader = {
  /** Runs one upload attempt immediately, then self-schedules. Idempotent. */
  start(): void;
  /** One file (the oldest due). While one is in flight, returns that promise. */
  runOnce(): Promise<EdgeSelfieUploadOutcome>;
  /** Clears the timer, aborts the PUT in flight and awaits it. Idempotent. */
  stop(): Promise<void>;
};

/** Error name/code only: messages may carry data. */
function errorLabel(error: unknown): string {
  const candidate = error as { name?: unknown; code?: unknown };
  if (typeof candidate?.code === "string") return candidate.code;
  if (typeof candidate?.name === "string") return candidate.name;
  return "Error";
}

/** Capped exponential delay with jitter: floor(d / 2 + random * d / 2). */
function backoffDelayMs(
  failures: number,
  options: Pick<EdgeSelfieUploadOptions, "intervalMs" | "maxBackoffMs">,
  random: () => number,
): number {
  const exponent = Math.min(Math.max(failures, 1) - 1, 30);
  const delay = Math.min(
    options.maxBackoffMs,
    options.intervalMs * 2 ** exponent,
  );
  return Math.floor(delay / 2 + random() * (delay / 2));
}

type PendingUpload = {
  objectId: string;
  filePath: string;
  sealedSha256: Buffer;
  attempts: number;
};

type PutResult =
  | { kind: "status"; status: number }
  | { kind: "failed"; reason: "TIMEOUT" | "NETWORK" }
  | { kind: "aborted" };

async function putSealedFile(
  options: EdgeSelfieUploadOptions,
  objectId: string,
  sealed: Buffer,
  sha256Hex: string,
  signal: AbortSignal,
): Promise<PutResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${cloudHttpBaseUrl(options.cloudUrl)}${edgeSelfieAttendanceSelfiePath(objectId)}`;
  const request = new AbortController();
  let timedOut = false;
  const onAbort = () => request.abort();
  if (signal.aborted) request.abort();
  else signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    request.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const init: EdgeRequestInit = {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${options.credential}`,
        "Content-Type": "application/octet-stream",
        [SEALED_SHA256_HEADER]: sha256Hex,
      },
      body: sealed,
      redirect: "error",
      cache: "no-store",
      signal: request.signal,
    };
    const response = await fetchImpl(url, init);
    // The answer body is never read: only the status matters.
    await response.body?.cancel().catch(() => undefined);
    return { kind: "status", status: response.status };
  } catch {
    if (signal.aborted) return { kind: "aborted" };
    return { kind: "failed", reason: timedOut ? "TIMEOUT" : "NETWORK" };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Uploads the oldest due pending selfie, if any. Never throws for a cloud or
 * file problem (those become row states); database failures propagate.
 */
export async function uploadNextSelfie(
  options: EdgeSelfieUploadOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<EdgeSelfieUploadOutcome> {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const tenantId = options.context.tenant.tenantId;
  const rowKey = (objectId: string) =>
    and(
      eq(edgeSelfieUploads.tenantId, tenantId),
      eq(edgeSelfieUploads.objectId, objectId),
      // A finished row (uploaded by a parallel run, rejected) never changes.
      eq(edgeSelfieUploads.state, "pending"),
    );
  // The retention sweep can finish a pending row while its PUT is in flight.
  // The cloud's answer stands then: log the class only and carry on.
  const update = async (
    objectId: string,
    set: Partial<typeof edgeSelfieUploads.$inferInsert>,
  ): Promise<void> => {
    const changed = await withTenant(db, options.context, (tx) =>
      tx
        .update(edgeSelfieUploads)
        .set(set)
        .where(rowKey(objectId))
        .returning({ objectId: edgeSelfieUploads.objectId }),
    );
    if (changed.length === 0)
      logger.warn(
        { objectId, reason: "ROW_NOT_PENDING" },
        "Edge selfie row was no longer pending when its state was saved",
      );
  };

  const [row]: PendingUpload[] = await withTenant(db, options.context, (tx) =>
    tx
      .select({
        objectId: edgeSelfieUploads.objectId,
        filePath: edgeSelfieUploads.filePath,
        sealedSha256: edgeSelfieUploads.sealedSha256,
        attempts: edgeSelfieUploads.attempts,
      })
      .from(edgeSelfieUploads)
      .where(
        and(
          eq(edgeSelfieUploads.tenantId, tenantId),
          eq(edgeSelfieUploads.state, "pending"),
          lte(edgeSelfieUploads.nextAttemptAt, now()),
        ),
      )
      .orderBy(
        asc(edgeSelfieUploads.nextAttemptAt),
        asc(edgeSelfieUploads.createdAt),
      )
      .limit(1),
  );
  if (!row) return "idle";
  if (signal.aborted) return "aborted";

  const reject = async (reason: string): Promise<EdgeSelfieUploadOutcome> => {
    await update(row.objectId, { state: "rejected", lastError: reason });
    // Alert: object id and error class only, never the body or the meta.
    logger.warn(
      { objectId: row.objectId, reason },
      "Edge selfie upload rejected; the sealed file is kept",
    );
    try {
      options.onRejected?.({ objectId: row.objectId, reason });
    } catch {
      // A broken alert hook must not stop the queue.
    }
    return "rejected";
  };
  const retryLater = async (
    reason: string,
  ): Promise<EdgeSelfieUploadOutcome> => {
    const attempts = row.attempts + 1;
    const delay = backoffDelayMs(attempts, options, random);
    await update(row.objectId, {
      attempts,
      lastError: reason,
      nextAttemptAt: new Date(now().getTime() + delay),
    });
    return "retry";
  };

  let sealed: Buffer;
  try {
    sealed = await readFile(row.filePath);
  } catch (error) {
    const label = errorLabel(error);
    if (label === "ENOENT") {
      await update(row.objectId, { state: "expired", lastError: "ENOENT" });
      return "expired";
    }
    return retryLater(label);
  }

  const digest = createHash("sha256").update(sealed).digest();
  if (!digest.equals(Buffer.from(row.sealedSha256)))
    return reject("FILE_HASH_MISMATCH");

  const result = await putSealedFile(
    options,
    row.objectId,
    sealed,
    digest.toString("hex"),
    signal,
  );
  if (result.kind === "aborted") return "aborted";
  if (result.kind === "failed") return retryLater(result.reason);

  const { status } = result;
  if (status === 200 || status === 201) {
    // Commit first, delete second: a crash in between must never re-upload.
    await update(row.objectId, {
      state: "uploaded",
      uploadedAt: now(),
      lastError: null,
    });
    await unlink(row.filePath).catch((error: unknown) => {
      // Left for the hourly sweep; the row is already final.
      if (errorLabel(error) !== "ENOENT")
        logger.warn(
          { objectId: row.objectId, reason: errorLabel(error) },
          "Edge selfie uploaded but the local file could not be deleted",
        );
    });
    return "uploaded";
  }
  if (REJECTED_STATUSES.has(status)) return reject(`HTTP_${status}`);
  // 401 (credential problem), 5xx and anything unexpected: try again later.
  return retryLater(`HTTP_${status}`);
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export function createEdgeSelfieUploader(
  options: EdgeSelfieUploaderOptions,
): EdgeSelfieUploader {
  // Fail fast on a bad URL when the uploader is built.
  cloudHttpBaseUrl(options.cloudUrl);
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;

  let started = false;
  let stopped = false;
  let timer: unknown = null;
  let inFlight: Promise<EdgeSelfieUploadOutcome> | null = null;
  let controller: AbortController | null = null;
  let consecutiveFailures = 0;

  function cancelTimer(): void {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  /** A finished file means more may be due: go on at once. */
  function nextDelayMs(outcome: EdgeSelfieUploadOutcome): number {
    if (outcome === "error")
      return backoffDelayMs(consecutiveFailures, options, random);
    if (
      outcome === "uploaded" ||
      outcome === "rejected" ||
      outcome === "expired"
    )
      return 0;
    return options.intervalMs;
  }

  function schedule(outcome: EdgeSelfieUploadOutcome): void {
    cancelTimer();
    if (stopped || !started) return;
    timer = setTimer(() => {
      timer = null;
      void runOnce();
    }, nextDelayMs(outcome));
  }

  async function execute(
    signal: AbortSignal,
  ): Promise<EdgeSelfieUploadOutcome> {
    let outcome: EdgeSelfieUploadOutcome;
    try {
      outcome = await uploadNextSelfie(options, signal);
      consecutiveFailures = 0;
    } catch (error) {
      outcome = "error";
      // A run cut short by stop() is not a failure.
      if (signal.aborted) outcome = "aborted";
      else {
        consecutiveFailures += 1;
        try {
          options.onError?.(error);
        } catch {
          // A broken logger must not break the schedule.
        }
      }
    }
    if (!stopped) schedule(outcome);
    return outcome;
  }

  function runOnce(): Promise<EdgeSelfieUploadOutcome> {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve("idle");
    cancelTimer();
    const run = new AbortController();
    controller = run;
    const promise = execute(run.signal).finally(() => {
      if (inFlight === promise) inFlight = null;
      if (controller === run) controller = null;
    });
    inFlight = promise;
    return promise;
  }

  return {
    start() {
      if (started || stopped) return;
      started = true;
      void runOnce();
    },
    runOnce,
    async stop() {
      stopped = true;
      cancelTimer();
      controller?.abort();
      if (inFlight) await inFlight;
    },
  };
}
