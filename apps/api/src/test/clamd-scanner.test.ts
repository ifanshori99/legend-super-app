import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClamdMalwareScanner,
  createScannerHealthCheck,
} from "../services/clamd-scanner";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";
import {
  startFakeClamd,
  unusedPort,
  type FakeClamd,
  type FakeClamdBehavior,
} from "./helpers/fake-clamd";

// legend-w9hwh (M4), contract: docs/briefs/sub-storage-scanner-pdf.md and
// design D-6. A fake clamd over node:net on an ephemeral port.
//
// Assumption: the virus name is logged through the shared `logger.warn`
// (lib/logger), as the brief says; the response never carries it.

const open: FakeClamd[] = [];
async function fake(behavior: FakeClamdBehavior) {
  const server = await startFakeClamd(behavior);
  open.push(server);
  return server;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((server) => server.close()));
});

const scannerFor = (port: number, timeoutMs = 2000) =>
  new ClamdMalwareScanner({ host: "127.0.0.1", port, timeoutMs });

const SAMPLE = new Uint8Array(Buffer.from("harmless sample bytes"));

async function failure(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

describe("legend-w9hwh ClamdMalwareScanner.scan", () => {
  it("declares it accepts documents and fails open for images", async () => {
    const scanner = scannerFor(1);
    expect(scanner.acceptsDocuments).toBe(true);
    expect(scanner.failOpenForImages).toBe(true);
  });

  it("resolves on `stream: OK` (NUL-terminated, newline-terminated, bare)", async () => {
    for (const reply of ["stream: OK\0", "stream: OK\n", "stream: OK"]) {
      const server = await fake({ kind: "reply", reply });
      await expect(
        scannerFor(server.port).scan(SAMPLE),
      ).resolves.toBeUndefined();
    }
  });

  it("speaks zINSTREAM: command, length-prefixed chunk, zero terminator", async () => {
    const server = await fake({ kind: "reply", reply: "stream: OK\0" });
    await scannerFor(server.port).scan(SAMPLE);
    expect(server.sessions).toHaveLength(1);
    expect(server.sessions[0]!.command).toBe("zINSTREAM");
    expect(server.sessions[0]!.terminated).toBe(true);
    expect(Buffer.concat(server.sessions[0]!.chunks)).toEqual(
      Buffer.from(SAMPLE),
    );
  });

  it("splits input larger than 64 KiB into chunks of at most 64 KiB, losslessly", async () => {
    const size = 64 * 1024 * 2 + 12_345;
    const input = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) input[i] = (i * 31 + 7) & 0xff;

    const server = await fake({ kind: "reply", reply: "stream: OK\0" });
    await scannerFor(server.port).scan(input);

    const [session] = server.sessions;
    expect(session!.terminated).toBe(true);
    expect(session!.chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of session!.chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
    }
    expect(Buffer.concat(session!.chunks).equals(Buffer.from(input))).toBe(
      true,
    );
  });

  it("rejects FOUND with 422 UPLOAD_REJECTED and keeps the virus name out of the error", async () => {
    const warn = vi.spyOn(logger, "warn");
    for (const reply of [
      "stream: Eicar-Test-Signature FOUND\0",
      "stream: Eicar-Test-Signature FOUND\n",
    ]) {
      const server = await fake({ kind: "reply", reply });
      const error = await failure(scannerFor(server.port).scan(SAMPLE));
      expect(error.status).toBe(422);
      expect(error.code).toBe("UPLOAD_REJECTED");
      expect(error.message).toBe("Berkas ditolak pemindai malware.");
      expect(JSON.stringify({ ...error, message: error.message })).not.toMatch(
        /eicar/i,
      );
    }
    // The name is for the server log only.
    expect(JSON.stringify(warn.mock.calls)).toMatch(/Eicar-Test-Signature/);
  });

  it("answers 503 SCANNER_UNAVAILABLE for clamd ERROR and unknown replies", async () => {
    for (const reply of [
      "stream: Can't allocate memory ERROR\0",
      "ERROR\0",
      "something unexpected\0",
    ]) {
      const server = await fake({ kind: "reply", reply });
      const error = await failure(scannerFor(server.port).scan(SAMPLE));
      expect(error.status).toBe(503);
      expect(error.code).toBe("SCANNER_UNAVAILABLE");
      expect(error.message).toBe("File scanning is temporarily unavailable.");
    }
  });

  it("answers 503 when clamd says the stream size limit is exceeded", async () => {
    const server = await fake({
      kind: "reply",
      reply: "INSTREAM size limit exceeded. ERROR\0",
      whenStreamEnds: false,
    });
    const error = await failure(
      scannerFor(server.port).scan(new Uint8Array(512 * 1024)),
    );
    expect(error.status).toBe(503);
    expect(error.code).toBe("SCANNER_UNAVAILABLE");
  });

  it("answers 503 when the socket closes without a reply", async () => {
    const server = await fake({ kind: "close" });
    const error = await failure(scannerFor(server.port).scan(SAMPLE));
    expect(error.status).toBe(503);
    expect(error.code).toBe("SCANNER_UNAVAILABLE");
  });

  it("answers 503 when clamd refuses the connection and does not leak the address", async () => {
    const port = await unusedPort();
    const error = await failure(scannerFor(port).scan(SAMPLE));
    expect(error.status).toBe(503);
    expect(error.code).toBe("SCANNER_UNAVAILABLE");
    expect(error.message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it("times out after timeoutMs with 503 and destroys the socket", async () => {
    const server = await fake({ kind: "silent" });
    const error = await failure(scannerFor(server.port, 300).scan(SAMPLE));
    expect(error.status).toBe(503);
    expect(error.code).toBe("SCANNER_UNAVAILABLE");
    // The client must have closed its end: the server sees the connection end.
    await server.waitForClosed(1);
    expect(server.closedConnections()).toBe(1);
  });

  it("destroys the socket after a normal scan too", async () => {
    const server = await fake({ kind: "reply", reply: "stream: OK\0" });
    await scannerFor(server.port).scan(SAMPLE);
    await server.waitForClosed(1);
    expect(server.closedConnections()).toBe(1);
  });
});

describe("legend-w9hwh ClamdMalwareScanner.ping", () => {
  it("sends zPING and returns true on PONG", async () => {
    const server = await fake({ kind: "reply", reply: "PONG\0" });
    await expect(scannerFor(server.port).ping()).resolves.toBe(true);
    expect(server.sessions[0]!.command).toBe("zPING");
  });

  it("returns false (never throws) on a wrong answer, refusal, close and timeout", async () => {
    const wrong = await fake({ kind: "reply", reply: "NOPE\0" });
    await expect(scannerFor(wrong.port).ping()).resolves.toBe(false);

    await expect(scannerFor(await unusedPort()).ping()).resolves.toBe(false);

    const closing = await fake({ kind: "close" });
    await expect(scannerFor(closing.port).ping()).resolves.toBe(false);

    const silent = await fake({ kind: "silent" });
    await expect(scannerFor(silent.port, 300).ping()).resolves.toBe(false);
  });
});

describe("legend-w9hwh createScannerHealthCheck", () => {
  function pingScanner(results: Array<boolean | Promise<boolean>>) {
    const ping = vi.fn(async () => {
      const next = results.length > 1 ? results.shift()! : results[0]!;
      return next;
    });
    return { scan: async () => {}, ping };
  }

  it('is "disabled" for a null scanner or a scanner without ping()', async () => {
    await expect(createScannerHealthCheck(null)()).resolves.toBe("disabled");
    await expect(
      createScannerHealthCheck({ scan: async () => {} })(),
    ).resolves.toBe("disabled");
  });

  it('maps ping true to "ok" and false to "unavailable"', async () => {
    await expect(createScannerHealthCheck(pingScanner([true]))()).resolves.toBe(
      "ok",
    );
    await expect(
      createScannerHealthCheck(pingScanner([false]))(),
    ).resolves.toBe("unavailable");
  });

  it("caches the result for 30 seconds by default, then pings again", async () => {
    let clock = 1_000_000;
    const scanner = pingScanner([true, false]);
    const check = createScannerHealthCheck(scanner, { now: () => clock });

    await expect(check()).resolves.toBe("ok");
    clock += 29_000;
    await expect(check()).resolves.toBe("ok");
    expect(scanner.ping).toHaveBeenCalledTimes(1);

    clock += 2_000; // 31 s after the first ping
    await expect(check()).resolves.toBe("unavailable");
    expect(scanner.ping).toHaveBeenCalledTimes(2);

    clock += 5_000; // the failure is cached as well
    await expect(check()).resolves.toBe("unavailable");
    expect(scanner.ping).toHaveBeenCalledTimes(2);
  });

  it("honours a custom ttlMs", async () => {
    let clock = 0;
    const scanner = pingScanner([true]);
    const check = createScannerHealthCheck(scanner, {
      ttlMs: 1_000,
      now: () => clock,
    });
    await check();
    clock += 500;
    await check();
    expect(scanner.ping).toHaveBeenCalledTimes(1);
    clock += 1_000;
    await check();
    expect(scanner.ping).toHaveBeenCalledTimes(2);
  });

  it("shares one PING between concurrent calls", async () => {
    let release!: (value: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const scanner = pingScanner([gate]);
    const check = createScannerHealthCheck(scanner, { now: () => 0 });

    const pending = Promise.all([check(), check(), check()]);
    release(true);
    await expect(pending).resolves.toEqual(["ok", "ok", "ok"]);
    expect(scanner.ping).toHaveBeenCalledTimes(1);
  });
});
