import net from "node:net";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger";
import type { MalwareScanner, ScanContext } from "./core-image";

/** clamd client over TCP (legend-w9hwh, design media-transport D-6). */
export interface ClamdScannerOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** Scans running at once across all tenants (default 4). */
  maxConcurrent?: number;
  /** Scans running at once for one tenantKey (default 2). */
  maxPerTenant?: number;
  /** Scans waiting for a slot; more are refused at once (default 8). */
  maxQueued?: number;
}

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MAX_PER_TENANT = 2;
const DEFAULT_MAX_QUEUED = 8;

export type ScannerHealth = "ok" | "unavailable" | "disabled";

/** clamd's default StreamMaxLength allows chunks up to this size comfortably. */
const CHUNK_BYTES = 64 * 1024;
const PING_TIMEOUT_MS = 2000;
/** A genuine clamd reply is a short line; anything longer is not clamd. */
const MAX_REPLY_BYTES = 4 * 1024;

function unavailable(): HttpError {
  return new HttpError(
    503,
    "SCANNER_UNAVAILABLE",
    "File scanning is temporarily unavailable.",
  );
}

function overloaded(): HttpError {
  return new HttpError(
    503,
    "SCANNER_OVERLOADED",
    "File scanning is busy. Try again shortly.",
  );
}

interface Waiter {
  tenantKey: string | undefined;
  grant: () => void;
}

export class ClamdMalwareScanner implements MalwareScanner {
  readonly acceptsDocuments = true;
  readonly failOpenForImages = true;

  private readonly maxConcurrent: number;
  private readonly maxPerTenant: number;
  private readonly maxQueued: number;
  private active = 0;
  /** Running plus waiting scans per tenantKey. */
  private readonly activeByTenant = new Map<string, number>();
  /** Running scans per tenantKey. */
  private readonly runningByTenant = new Map<string, number>();
  private readonly queue: Waiter[] = [];

  constructor(private readonly options: ClamdScannerOptions) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxPerTenant = options.maxPerTenant ?? DEFAULT_MAX_PER_TENANT;
    this.maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
  }

  private canRun(tenantKey: string | undefined): boolean {
    if (this.active >= this.maxConcurrent) return false;
    if (tenantKey === undefined) return true;
    return (this.runningByTenant.get(tenantKey) ?? 0) < this.maxPerTenant;
  }

  private bump(map: Map<string, number>, key: string, delta: number): void {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  private start(tenantKey: string | undefined): void {
    this.active += 1;
    if (tenantKey !== undefined) this.bump(this.runningByTenant, tenantKey, 1);
  }

  private release(tenantKey: string | undefined): void {
    this.active -= 1;
    if (tenantKey !== undefined) {
      this.bump(this.runningByTenant, tenantKey, -1);
      this.bump(this.activeByTenant, tenantKey, -1);
    }
    // FIFO among the waiters that may run now (one may be tenant-blocked).
    for (let i = 0; i < this.queue.length;) {
      if (this.active >= this.maxConcurrent) break;
      const waiter = this.queue[i]!;
      if (!this.canRun(waiter.tenantKey)) {
        i += 1;
        continue;
      }
      this.queue.splice(i, 1);
      this.start(waiter.tenantKey);
      waiter.grant();
    }
  }

  /**
   * Takes a scan slot, waiting in a bounded FIFO queue when none is free.
   * Refuses at once (SCANNER_OVERLOADED, no socket) when the queue or the
   * tenant's share is full. A wait longer than `timeoutMs` leaves the queue
   * with SCANNER_UNAVAILABLE. Returns the release function.
   */
  private acquire(
    tenantKey: string | undefined,
    timeoutMs: number,
  ): Promise<() => void> {
    if (
      tenantKey !== undefined &&
      (this.activeByTenant.get(tenantKey) ?? 0) >= this.maxPerTenant * 2
    )
      return Promise.reject(overloaded());
    if (this.canRun(tenantKey)) {
      this.start(tenantKey);
      if (tenantKey !== undefined) this.bump(this.activeByTenant, tenantKey, 1);
      return Promise.resolve(this.releaser(tenantKey));
    }
    if (this.queue.length >= this.maxQueued)
      return Promise.reject(overloaded());
    if (tenantKey !== undefined) this.bump(this.activeByTenant, tenantKey, 1);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        tenantKey,
        grant: () => {
          clearTimeout(timer);
          resolve(this.releaser(tenantKey));
        },
      };
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index === -1) return;
        this.queue.splice(index, 1);
        if (tenantKey !== undefined)
          this.bump(this.activeByTenant, tenantKey, -1);
        // A scan that never got a slot is overload, not an outage: an image
        // must not fail open on it (when in doubt, refuse).
        reject(overloaded());
      }, timeoutMs);
      this.queue.push(waiter);
    });
  }

  private releaser(tenantKey: string | undefined): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(tenantKey);
    };
  }

  /**
   * Sends one command to clamd and returns its reply (without the trailing
   * NUL/newline). Rejects with a plain Error on connect failure, a socket
   * closed without a reply, or timeout. The socket is always destroyed.
   * `send` writes through `write`, which waits for 'drain' when the socket
   * buffer is full and resolves false once the exchange has ended (stop).
   */
  private exchange(
    send: (
      write: (data: string | Uint8Array) => Promise<boolean>,
    ) => Promise<void>,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({
        host: this.options.host,
        port: this.options.port,
      });
      const received: Buffer[] = [];
      let receivedBytes = 0;
      let settled = false;
      let pendingDrain: (() => void) | null = null;
      const finish = (error: Error | null, reply?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        pendingDrain?.();
        if (error) reject(error);
        else resolve(reply ?? "");
      };
      const replyOrFail = (error: Error) => {
        // clamd may answer (e.g. size limit) and close while we still write.
        const text = Buffer.concat(received).toString("utf8");
        if (text.length > 0) finish(null, text.replace(/[\0\n\s]+$/, ""));
        else finish(error);
      };
      const timer = setTimeout(
        () => finish(new Error("clamd timeout")),
        timeoutMs,
      );
      socket.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > MAX_REPLY_BYTES) {
          finish(new Error("clamd reply too long"));
          return;
        }
        received.push(chunk);
        if (chunk.includes(0) || chunk.includes(10))
          replyOrFail(new Error("clamd empty reply"));
      });
      socket.on("end", () => replyOrFail(new Error("clamd closed")));
      socket.on("close", () => replyOrFail(new Error("clamd closed")));
      socket.on("error", (error) => replyOrFail(error));
      const write = (data: string | Uint8Array): Promise<boolean> => {
        if (settled) return Promise.resolve(false);
        if (socket.write(data)) return Promise.resolve(true);
        return new Promise((resolveWrite) => {
          const wake = () => {
            socket.off("drain", wake);
            pendingDrain = null;
            resolveWrite(!settled);
          };
          pendingDrain = wake;
          socket.once("drain", wake);
        });
      };
      send(write).catch((error: unknown) =>
        finish(
          error instanceof Error ? error : new Error("clamd write failed"),
        ),
      );
    });
  }

  async scan(bytes: Uint8Array, context?: ScanContext): Promise<void> {
    const startedAt = Date.now();
    const release = await this.acquire(
      context?.tenantKey,
      this.options.timeoutMs,
    );
    let reply: string;
    try {
      // Queue wait counts toward the one scan timeout.
      const remainingMs = this.options.timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw new Error("clamd timeout");
      reply = await this.exchange(async (write) => {
        if (!(await write("zINSTREAM\0"))) return;
        for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
          const part = bytes.subarray(offset, offset + CHUNK_BYTES);
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(part.byteLength, 0);
          if (!(await write(length))) return;
          if (!(await write(part))) return;
        }
        await write(Buffer.alloc(4));
      }, remainingMs);
    } catch {
      throw unavailable();
    } finally {
      release();
    }
    if (reply === "stream: OK") return;
    const found = /^stream: (.+) FOUND$/.exec(reply);
    if (found) {
      // The signature name stays in the server log, never in the response.
      logger.warn({ virus: found[1] }, "Malware scanner rejected an upload");
      throw new HttpError(
        422,
        "UPLOAD_REJECTED",
        "Berkas ditolak pemindai malware.",
      );
    }
    logger.warn({}, "Malware scanner gave an unexpected reply");
    throw unavailable();
  }

  async ping(): Promise<boolean> {
    try {
      // Short on purpose: GET /api/health awaits this, and a hung clamd must
      // not stall a liveness probe for the full scan timeout.
      const reply = await this.exchange(
        async (write) => {
          await write("zPING\0");
        },
        Math.min(this.options.timeoutMs, PING_TIMEOUT_MS),
      );
      return reply === "PONG";
    } catch {
      return false;
    }
  }
}

/**
 * Readiness probe for `GET /api/health`. No scanner (or one without `ping`)
 * is "disabled". The result is cached for `ttlMs` (30 s) and concurrent calls
 * share one PING, so probes cannot hammer clamd.
 */
export function createScannerHealthCheck(
  scanner: MalwareScanner | null,
  options: { ttlMs?: number; now?: () => number } = {},
): () => Promise<ScannerHealth> {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const ping = scanner?.ping?.bind(scanner);
  if (!ping) return async () => "disabled";
  let cached: { value: ScannerHealth; at: number } | null = null;
  let inFlight: Promise<ScannerHealth> | null = null;
  return () => {
    if (cached && now() - cached.at < ttlMs)
      return Promise.resolve(cached.value);
    inFlight ??= ping()
      .catch(() => false)
      .then((alive): ScannerHealth => (alive ? "ok" : "unavailable"))
      .then((value) => {
        cached = { value, at: now() };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
