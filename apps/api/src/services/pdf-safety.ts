// Structural check for an uploaded PDF before it is scanned or stored
// (legend-851ef, design D-5). Cheap byte checks run here; the parse runs in a
// worker thread with a heap cap and a timeout (`pdf-safety.worker.ts`), so a
// PDF bomb is refused (422) instead of freezing the API. The original bytes
// are kept as they are: active content is refused, never silently removed.
import { Worker } from "node:worker_threads";
import { HttpError } from "../lib/http-error.ts";
import type {
  PdfSafetyRequest,
  PdfSafetyVerdict,
} from "./pdf-safety.worker.ts";

export interface PdfSafetyOptions {
  maxBytes: number;
  /** Worker deadline, from spawn to verdict. Default 5000 ms. */
  timeoutMs?: number;
  /** Worker heap cap. Default 256 MB. */
  maxOldGenerationSizeMb?: number;
}

const MAX_RUNNING = 2;
const MAX_QUEUED = 16;
const EOF_WINDOW = 1024;

// Dev (`tsx watch`) and vitest load this module from its `.ts` source; the
// production bundle (tsup, splitting) emits `dist/pdf-safety.worker.js` beside
// the server chunks, so the same relative URL resolves in all three.
const workerUrl = new URL(
  `./pdf-safety.worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
  import.meta.url,
);

const rejected = () =>
  new HttpError(
    422,
    "UPLOAD_REJECTED",
    "Berkas PDF ditolak: rusak atau berisi konten aktif yang tidak diizinkan.",
  );
const encrypted = () =>
  new HttpError(
    422,
    "UPLOAD_REJECTED",
    "PDF bersandi tidak diterima; simpan ulang tanpa sandi.",
  );
const unavailable = () =>
  new HttpError(
    503,
    "SERVICE_UNAVAILABLE",
    "Pemeriksaan PDF sedang tidak tersedia; coba lagi sebentar.",
  );

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .subarray(start, end)
    .toString("latin1");

function assertPdfBytes(bytes: Uint8Array, maxBytes: number) {
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw rejected();
  // The header must sit at offset 0: a `%PDF-` later in the file (a polyglot)
  // is refused, although readers would accept it.
  const header = ascii(bytes, 0, 7);
  if (header !== "%PDF-1." && header !== "%PDF-2.") throw rejected();
  const tail = ascii(
    bytes,
    Math.max(0, bytes.byteLength - EOF_WINDOW),
    bytes.byteLength,
  );
  if (!tail.includes("%%EOF")) throw rejected();
}

// At most MAX_RUNNING parses at once; MAX_QUEUED more wait, the rest get 503.
let running = 0;
const waiting: Array<() => void> = [];

async function acquire() {
  if (running < MAX_RUNNING) {
    running += 1;
    return;
  }
  if (waiting.length >= MAX_QUEUED) throw unavailable();
  // The releasing caller hands its slot over, so `running` stays the same.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

function runWorker(
  bytes: Uint8Array,
  timeoutMs: number,
  maxOldGenerationSizeMb: number,
): Promise<PdfSafetyVerdict> {
  return new Promise((resolve, reject) => {
    const request: PdfSafetyRequest = { bytes };
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: request,
        resourceLimits: { maxOldGenerationSizeMb },
      });
    } catch {
      reject(unavailable());
      return;
    }
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      outcome();
    };
    const timer = setTimeout(() => finish(() => reject(rejected())), timeoutMs);
    worker.once("message", (verdict: PdfSafetyVerdict) =>
      finish(() => resolve(verdict)),
    );
    worker.once("error", (error: NodeJS.ErrnoException) =>
      finish(() =>
        // The file blew the heap cap: refuse the file. Anything else (worker
        // file or pdf-lib missing) is our fault, not the uploader's.
        reject(
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? rejected()
            : unavailable(),
        ),
      ),
    );
    // Exited without a verdict (killed mid-parse): fail closed on the file.
    worker.once("exit", () => finish(() => reject(rejected())));
  });
}

/** Refuses (422 `UPLOAD_REJECTED`) a PDF that is malformed, truncated, a
 * polyglot, encrypted, outside 1..50 pages, or carries active or embedded
 * content (JavaScript, launch, embedded files, forms that submit, `/AA`, a
 * non-GoTo `/OpenAction`). Plain `/URI` links are allowed. 503
 * `SERVICE_UNAVAILABLE` when the checker is saturated or cannot start. */
export async function assertSafePdf(
  bytes: Uint8Array,
  options: PdfSafetyOptions,
): Promise<{ pageCount: number }> {
  assertPdfBytes(bytes, options.maxBytes);
  await acquire();
  let verdict: PdfSafetyVerdict;
  try {
    verdict = await runWorker(
      bytes,
      options.timeoutMs ?? 5000,
      options.maxOldGenerationSizeMb ?? 256,
    );
  } finally {
    release();
  }
  if (verdict.ok) return { pageCount: verdict.pageCount };
  throw verdict.reason === "encrypted" ? encrypted() : rejected();
}
