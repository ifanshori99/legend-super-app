import net from "node:net";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger";
import type { MalwareScanner } from "./core-image";

/** clamd client over TCP (legend-w9hwh, design media-transport D-6). */
export interface ClamdScannerOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

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

export class ClamdMalwareScanner implements MalwareScanner {
  readonly acceptsDocuments = true;
  readonly failOpenForImages = true;

  constructor(private readonly options: ClamdScannerOptions) {}

  /**
   * Sends one command to clamd and returns its reply (without the trailing
   * NUL/newline). Rejects with a plain Error on connect failure, a socket
   * closed without a reply, or timeout. The socket is always destroyed.
   */
  private exchange(
    write: (socket: net.Socket) => void,
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
      const finish = (error: Error | null, reply?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
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
      write(socket);
    });
  }

  async scan(bytes: Uint8Array): Promise<void> {
    let reply: string;
    try {
      reply = await this.exchange((socket) => {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
          const part = bytes.subarray(offset, offset + CHUNK_BYTES);
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(part.byteLength, 0);
          socket.write(length);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      }, this.options.timeoutMs);
    } catch {
      throw unavailable();
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
        (socket) => {
          socket.write("zPING\0");
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
