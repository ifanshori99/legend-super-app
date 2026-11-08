// Printer transports of the edge Print Agent (bead legend-46p; PRD v1.7 §3 F5
// "Print Agent"). A transport moves raw ESC/POS bytes to one printer: TCP
// port 9100 (network) or a USB device file. Failures carry a phase so the
// agent knows whether anything may have reached the printer:
// - "connect": nothing was sent, a retry is safe.
// - "write": bytes may be partly printed, a retry may print twice.
// Never log or put printer content in an error message.
import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import net from "node:net";
import type { PrinterConfig } from "./types.ts";

export type PrintTransportPhase = "connect" | "write";

export class PrintTransportError extends Error {
  readonly phase: PrintTransportPhase;

  constructor(phase: PrintTransportPhase, message: string) {
    super(message);
    this.name = "PrintTransportError";
    this.phase = phase;
  }
}

export interface PrinterTransport {
  /** Sends all bytes. Rejects with PrintTransportError (phase connect | write). */
  send(bytes: Uint8Array): Promise<void>;
  /** True when the printer is reachable. Never rejects. */
  probe(): Promise<boolean>;
}

export type TransportFactory = (printer: PrinterConfig) => PrinterTransport;

export type NetworkTransportOptions = {
  host: string;
  port: number;
  /** Connect and write timeout. */
  timeoutMs?: number;
  /** Probe (TCP connect) timeout. */
  probeTimeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_PROBE_TIMEOUT_MS = 2000;

export function createNetworkTransport(
  options: NetworkTransportOptions,
): PrinterTransport {
  const { host, port } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return {
    send(bytes) {
      return new Promise<void>((resolve, reject) => {
        let connected = false;
        let settled = false;
        const socket = net.createConnection({ host, port });

        // Failure: reject and drop the socket. Success: resolve once the
        // write is flushed. The socket is not destroyed here (a close right
        // after the flush could cut bytes still in transit); it ends when the
        // printer closes it or the idle timeout fires. Nothing after the
        // settle can reject.
        const fail = (error: PrintTransportError) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          reject(error);
        };
        const flushed = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const phase = (): PrintTransportPhase =>
          connected ? "write" : "connect";

        // Idle timeout: covers the connect attempt and a stalled write.
        socket.setTimeout(timeoutMs);
        socket.once("timeout", () => {
          if (settled) {
            socket.destroy();
            return;
          }
          fail(
            new PrintTransportError(
              phase(),
              connected
                ? "Printer tidak merespons saat mengirim data."
                : "Printer tidak dapat dihubungi (waktu habis).",
            ),
          );
        });
        socket.on("error", () =>
          fail(
            new PrintTransportError(
              phase(),
              connected
                ? "Koneksi ke printer terputus saat mengirim data."
                : "Printer tidak dapat dihubungi.",
            ),
          ),
        );
        socket.once("close", () => {
          // Closed before the write was flushed: the job did not complete.
          fail(
            new PrintTransportError(
              phase(),
              connected
                ? "Koneksi ke printer terputus saat mengirim data."
                : "Printer tidak dapat dihubungi.",
            ),
          );
        });
        socket.once("connect", () => {
          connected = true;
          socket.end(Buffer.from(bytes), (error?: Error | null) => {
            // A failed write is reported by the error/close handlers.
            if (!error) flushed();
          });
        });
      });
    },

    probe() {
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const socket = net.createConnection({ host, port });
        const done = (alive: boolean) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(alive);
        };
        socket.setTimeout(probeTimeoutMs);
        socket.once("connect", () => done(true));
        socket.once("timeout", () => done(false));
        socket.on("error", () => done(false));
        socket.once("close", () => done(false));
      });
    },
  };
}

export type UsbTransportOptions = {
  devicePath: string;
  /** Connect (open) and write timeout. */
  timeoutMs?: number;
};

/** Rejects with `onTimeout()` when `promise` does not settle within `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function createUsbTransport(
  options: UsbTransportOptions,
): PrinterTransport {
  const { devicePath } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async send(bytes) {
      const opening = open(devicePath, "w");
      let handle: Awaited<typeof opening>;
      try {
        handle = await withTimeout(
          opening,
          timeoutMs,
          () => new Error("timeout"),
        );
      } catch {
        // A late open must not leak its file handle.
        opening.then(
          (late) => late.close().catch(() => undefined),
          () => undefined,
        );
        throw new PrintTransportError(
          "connect",
          "Printer USB tidak dapat dibuka.",
        );
      }
      try {
        await withTimeout(
          handle.writeFile(bytes),
          timeoutMs,
          () => new Error("timeout"),
        );
      } catch {
        throw new PrintTransportError(
          "write",
          "Gagal menulis data ke printer USB.",
        );
      } finally {
        await handle.close().catch(() => undefined);
      }
    },

    async probe() {
      try {
        await access(devicePath, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const defaultTransportFactory: TransportFactory = (printer) => {
  const config = printer.transport;
  if (config.kind === "network") {
    return createNetworkTransport({ host: config.host, port: config.port });
  }
  return createUsbTransport({ devicePath: config.devicePath });
};

/** In-memory printer for tests and development. */
export class FakePrinterTransport implements PrinterTransport {
  online = true;
  readonly printed: Uint8Array[] = [];
  /** One-shot: the next send fails in this phase, then the flag clears. */
  failNextSend?: PrintTransportPhase;

  async send(bytes: Uint8Array): Promise<void> {
    if (!this.online) {
      throw new PrintTransportError(
        "connect",
        "Printer tidak dapat dihubungi.",
      );
    }
    if (this.failNextSend) {
      const phase = this.failNextSend;
      this.failNextSend = undefined;
      throw new PrintTransportError(
        phase,
        phase === "connect"
          ? "Printer tidak dapat dihubungi."
          : "Koneksi ke printer terputus saat mengirim data.",
      );
    }
    this.printed.push(new Uint8Array(bytes));
  }

  async probe(): Promise<boolean> {
    return this.online;
  }
}
