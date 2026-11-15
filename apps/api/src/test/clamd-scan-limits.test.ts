import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClamdMalwareScanner } from "../services/clamd-scanner";
import { HttpError } from "../lib/http-error";
import {
  startFakeClamd,
  unusedPort,
  type FakeClamd,
  type FakeClamdBehavior,
} from "./helpers/fake-clamd";

// legend-1rtm1: bounded clamd concurrency + backpressure. Contract: brief
// section "Desain ditetapkan" (global maxConcurrent 4 / per-tenant
// maxPerTenant 2 / global waiting queue maxQueued 8; overflow is rejected at
// once with HttpError 503 SCANNER_OVERLOADED without opening a socket; the
// wait in the queue counts inside the total scan timeout; a slot always comes
// back; socket.write() false waits for 'drain'; the queue is FIFO).
//
// Assumptions (the brief leaves them open):
//  - The size of a per-tenant waiting queue is not specified, so tests only
//    pin the per-tenant RUNNING cap and that a flooding tenant never blocks a
//    different tenant while a global slot is free.
//  - A queued scan that outlives the total timeout fails with HTTP 503 (the
//    exact code is not pinned, only the status).

/** Server-side view of one gated clamd connection. */
interface GatedConnection {
  socket: net.Socket;
  /** First byte of the streamed payload, set once the stream is terminated. */
  tag: number | null;
  terminated: boolean;
}

interface GatedClamd {
  port: number;
  /** Connections ever accepted. */
  accepted: () => number;
  /** Highest number of simultaneously open connections ever seen. */
  peakOpen: () => number;
  open: () => number;
  /** Connections that finished streaming and wait for an answer, oldest first. */
  pending: () => GatedConnection[];
  /** Order in which payload tags finished streaming. */
  streamedTags: () => number[];
  /** Answers the oldest pending connection. */
  releaseOldest: (reply?: string) => void;
  /** Pause reading so the client's write() backs up. */
  pauseReading: () => void;
  resumeReading: () => void;
  receivedBytes: () => number;
  close: () => Promise<void>;
}

/**
 * clamd that reads a whole zINSTREAM and then holds the answer until the test
 * releases it. Built on node:net like helpers/fake-clamd.ts, which answers at
 * once and so cannot hold slots.
 */
async function startGatedClamd(): Promise<GatedClamd> {
  const sockets = new Set<net.Socket>();
  // Connections still holding a scanner slot: not yet answered and not closed.
  // (A released connection closes a moment later; counting that tail would
  // flag a slot handed over correctly as an overshoot.)
  const live = new Set<GatedConnection>();
  const connections: GatedConnection[] = [];
  const waiting: GatedConnection[] = [];
  const tags: number[] = [];
  let accepted = 0;
  let peak = 0;
  let paused = false;
  let received = 0;

  const server = net.createServer((socket) => {
    accepted += 1;
    sockets.add(socket);
    const connection: GatedConnection = {
      socket,
      tag: null,
      terminated: false,
    };
    live.add(connection);
    peak = Math.max(peak, live.size);
    connections.push(connection);
    if (paused) socket.pause();
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      live.delete(connection);
      const at = waiting.indexOf(connection);
      if (at !== -1) waiting.splice(at, 1);
    });

    let buffer = Buffer.alloc(0);
    let phase: "command" | "stream" | "done" = "command";
    let firstByte: number | null = null;
    socket.on("data", (data) => {
      received += data.length;
      buffer = Buffer.concat([buffer, data]);
      if (phase === "command") {
        const nul = buffer.indexOf(0);
        if (nul === -1) return;
        buffer = buffer.subarray(nul + 1);
        phase = "stream";
      }
      while (phase === "stream" && buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          phase = "done";
          connection.terminated = true;
          connection.tag = firstByte;
          if (firstByte !== null) tags.push(firstByte);
          waiting.push(connection);
          return;
        }
        if (buffer.length < 4 + length) return;
        if (firstByte === null) firstByte = buffer[4]!;
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );

  return {
    port: (server.address() as net.AddressInfo).port,
    accepted: () => accepted,
    peakOpen: () => peak,
    open: () => live.size,
    pending: () => [...waiting],
    streamedTags: () => [...tags],
    releaseOldest: (reply = "stream: OK\0") => {
      const next = waiting.shift();
      if (!next) throw new Error("no pending connection to release");
      live.delete(next);
      next.socket.end(reply);
    },
    pauseReading: () => {
      paused = true;
      for (const socket of sockets) socket.pause();
    },
    resumeReading: () => {
      paused = false;
      for (const socket of sockets) socket.resume();
    },
    receivedBytes: () => received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const gated: GatedClamd[] = [];
const fakes: FakeClamd[] = [];
async function gate() {
  const server = await startGatedClamd();
  gated.push(server);
  return server;
}
async function fake(behavior: FakeClamdBehavior) {
  const server = await startFakeClamd(behavior);
  fakes.push(server);
  return server;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    ...gated.splice(0).map((server) => server.close()),
    ...fakes.splice(0).map((server) => server.close()),
  ]);
});

/** Polls until the condition holds; fails the test with a clear message. */
async function until(condition: () => boolean, what: string, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** Lets a wrongly-eager implementation show itself before asserting a ceiling. */
const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));

type Outcome = { ok: true } | { ok: false; error: unknown };
/** Starts a scan and records the outcome so it never goes unhandled. */
function track(promise: Promise<unknown>) {
  const state: { outcome: Outcome | null; at: number | null } = {
    outcome: null,
    at: null,
  };
  const done = promise.then(
    () => {
      state.outcome = { ok: true };
      state.at = Date.now();
    },
    (error: unknown) => {
      state.outcome = { ok: false, error };
      state.at = Date.now();
    },
  );
  return { state, done };
}

const payload = (tag: number, size = 64) => new Uint8Array(size).fill(tag);

const scannerFor = (
  port: number,
  options: {
    timeoutMs?: number;
    maxConcurrent?: number;
    maxPerTenant?: number;
    maxQueued?: number;
  } = {},
) =>
  new ClamdMalwareScanner({
    host: "127.0.0.1",
    port,
    timeoutMs: 5000,
    ...options,
  });

function expectOverloaded(outcome: Outcome | null) {
  expect(outcome).not.toBeNull();
  expect(outcome!.ok).toBe(false);
  const error = (outcome as { error: unknown }).error;
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(503);
  expect((error as HttpError).code).toBe("SCANNER_OVERLOADED");
}

/** Releases connections one by one until every tracked scan has finished. */
async function drain(
  server: GatedClamd,
  scans: Array<{ done: Promise<void> }>,
) {
  let finished = false;
  const all = Promise.all(scans.map((scan) => scan.done)).then(() => {
    finished = true;
  });
  while (!finished) {
    if (server.pending().length > 0) server.releaseOldest();
    else await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await all;
}

describe("legend-1rtm1 global concurrency cap", () => {
  it("never has more than maxConcurrent sockets open to a slow clamd", async () => {
    const server = await gate();
    const scanner = scannerFor(server.port, {
      maxConcurrent: 2,
      maxPerTenant: 2,
      maxQueued: 8,
    });
    const scans = Array.from({ length: 6 }, (_, i) =>
      track(scanner.scan(payload(i + 1))),
    );

    await until(() => server.pending().length >= 2, "two scans in flight");
    await settle();
    expect(server.accepted()).toBe(2);
    expect(server.open()).toBe(2);

    // Finishing one scan lets exactly one waiting scan through.
    server.releaseOldest();
    await until(() => server.accepted() >= 3, "a waiting scan to start");
    await settle();
    expect(server.accepted()).toBe(3);

    await drain(server, scans);
    expect(server.peakOpen()).toBeLessThanOrEqual(2);
    expect(server.accepted()).toBe(6);
    for (const scan of scans) expect(scan.state.outcome).toEqual({ ok: true });
  });

  it("defaults to 4 concurrent scans and 8 waiting, then rejects the rest", async () => {
    const server = await gate();
    const scanner = scannerFor(server.port);
    const scans = Array.from({ length: 14 }, (_, i) =>
      track(scanner.scan(payload(i + 1))),
    );

    await until(() => server.pending().length >= 4, "four scans in flight");
    await settle();
    expect(server.accepted()).toBe(4);
    // 4 running + 8 waiting = 12 accepted; the last two are turned away now.
    await until(
      () => scans.filter((scan) => scan.state.outcome !== null).length === 2,
      "two immediate rejections",
    );
    const rejected = scans.filter((scan) => scan.state.outcome !== null);
    for (const scan of rejected) expectOverloaded(scan.state.outcome);

    await drain(
      server,
      scans.filter((scan) => scan.state.outcome === null),
    );
    expect(server.peakOpen()).toBeLessThanOrEqual(4);
    expect(server.accepted()).toBe(12);
  });
});

describe("legend-1rtm1 per-tenant cap", () => {
  it("runs at most maxPerTenant scans of one tenant at once", async () => {
    const server = await gate();
    const scanner = scannerFor(server.port, {
      maxConcurrent: 4,
      maxPerTenant: 1,
      maxQueued: 8,
    });
    const scans = [1, 2, 3].map((tag) =>
      track(scanner.scan(payload(tag), { tenantKey: "tenant-a" })),
    );

    await until(() => server.pending().length >= 1, "tenant A's first scan");
    await settle();
    expect(server.accepted()).toBe(1);

    server.releaseOldest();
    await until(() => server.accepted() >= 2, "tenant A's second scan");
    await settle();
    expect(server.accepted()).toBe(2);

    await drain(server, scans);
    expect(server.peakOpen()).toBe(1);
  });

  it("defaults to 2 concurrent scans per tenant", async () => {
    const server = await gate();
    const scanner = scannerFor(server.port); // maxConcurrent 4 by default
    const scans = [1, 2, 3, 4].map((tag) =>
      track(scanner.scan(payload(tag), { tenantKey: "tenant-a" })),
    );

    await until(() => server.pending().length >= 2, "two scans in flight");
    await settle();
    expect(server.accepted()).toBe(2);

    await drain(server, scans);
    expect(server.peakOpen()).toBeLessThanOrEqual(2);
  });

  it("does not let one tenant's flood block or reject another tenant", async () => {
    const server = await gate();
    const scanner = scannerFor(server.port, {
      maxConcurrent: 2,
      maxPerTenant: 1,
      maxQueued: 4,
    });
    const flood = Array.from({ length: 10 }, (_, i) =>
      track(scanner.scan(payload(i + 1), { tenantKey: "tenant-a" })),
    );
    await until(() => server.pending().length >= 1, "tenant A's running scan");

    // A global slot is still free, so tenant B starts at once, not rejected.
    const other = track(scanner.scan(payload(200), { tenantKey: "tenant-b" }));
    await until(() => server.accepted() >= 2, "tenant B to be scanned");
    await settle();
    expect(other.state.outcome).toBeNull();
    expect(server.accepted()).toBe(2);
    expect(server.peakOpen()).toBeLessThanOrEqual(2);

    const settledFlood = flood.filter((scan) => scan.state.outcome !== null);
    for (const scan of settledFlood) expectOverloaded(scan.state.outcome);

    await drain(
      server,
      [other, ...flood].filter((scan) => scan.state.outcome === null),
    );
    expect(other.state.outcome).toEqual({ ok: true });
  });
});

describe("legend-1rtm1 overload is rejected fast", () => {
  it("turns away a scan beyond the queue with 503 SCANNER_OVERLOADED, without opening a socket or waiting for the timeout", async () => {
    const server = await gate();
    const timeoutMs = 5000;
    const scanner = scannerFor(server.port, {
      timeoutMs,
      maxConcurrent: 1,
      maxPerTenant: 1,
      maxQueued: 1,
    });
    const running = track(scanner.scan(payload(1)));
    await until(() => server.pending().length >= 1, "the running scan");
    const waiting = track(scanner.scan(payload(2)));
    await settle();

    const startedAt = Date.now();
    const over = track(scanner.scan(payload(3)));
    await over.done;
    expect(Date.now() - startedAt).toBeLessThan(timeoutMs / 2);
    expectOverloaded(over.state.outcome);

    await settle();
    expect(server.accepted()).toBe(1);

    // The rejection did not disturb the scans that were accepted.
    await drain(server, [running, waiting]);
    expect(running.state.outcome).toEqual({ ok: true });
    expect(waiting.state.outcome).toEqual({ ok: true });
    expect(server.accepted()).toBe(2);
  });

  it("uses a message that does not leak the scanner address", async () => {
    const server = await gate();
    const scanner = scannerFor(server.port, {
      maxConcurrent: 1,
      maxPerTenant: 1,
      maxQueued: 0,
    });
    const running = track(scanner.scan(payload(1)));
    await until(() => server.pending().length >= 1, "the running scan");

    const over = track(scanner.scan(payload(2)));
    await over.done;
    expectOverloaded(over.state.outcome);
    const message = (
      (over.state.outcome as { error: HttpError }).error as HttpError
    ).message;
    expect(message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|localhost/);

    await drain(server, [running]);
  });
});

describe("legend-1rtm1 queue order and timeout", () => {
  it("serves waiting scans first in, first out", async () => {
    const server = await gate();
    const scanner = scannerFor(server.port, {
      maxConcurrent: 1,
      maxPerTenant: 1,
      maxQueued: 8,
    });
    const scans = [1, 2, 3, 4, 5].map((tag) =>
      track(scanner.scan(payload(tag))),
    );

    await drain(server, scans);
    expect(server.streamedTags()).toEqual([1, 2, 3, 4, 5]);
    for (const scan of scans) expect(scan.state.outcome).toEqual({ ok: true });
  });

  it("counts the time spent waiting in the queue inside the total timeout", async () => {
    const server = await gate();
    const timeoutMs = 800;
    const scanner = scannerFor(server.port, {
      timeoutMs,
      maxConcurrent: 1,
      maxPerTenant: 1,
      maxQueued: 4,
    });
    const startedAt = Date.now();
    const holder = track(scanner.scan(payload(1))); // never answered
    await until(() => server.pending().length >= 1, "the holding scan");
    const waiting = track(scanner.scan(payload(2)));

    await waiting.done;
    const waited = Date.now() - startedAt;
    expect(waiting.state.outcome?.ok).toBe(false);
    const error = (waiting.state.outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    // One shared budget: well under queue wait + a second full timeout.
    expect(waited).toBeLessThan(timeoutMs * 1.6);

    await holder.done;
    expect(holder.state.outcome?.ok).toBe(false);
  });
});

describe("legend-1rtm1 backpressure", () => {
  it("stops writing while the socket is full and resumes after 'drain'", async () => {
    const server = await gate();
    server.pauseReading(); // clamd that is slow to read
    const scanner = scannerFor(server.port, { timeoutMs: 30_000 });

    const size = 48 * 1024 * 1024;
    const input = new Uint8Array(size).fill(7);

    let handedToSocket = 0;
    const original = net.Socket.prototype.write;
    vi.spyOn(net.Socket.prototype, "write").mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      // Client sockets only: server-side sockets have localPort === port, and a
      // client socket has no remotePort yet while its connect is pending.
      if (this.localPort !== server.port) {
        const chunk = args[0];
        if (typeof chunk === "string")
          handedToSocket += Buffer.byteLength(chunk);
        else if (chunk instanceof Uint8Array) handedToSocket += chunk.length;
      }
      return (original as (...a: unknown[]) => boolean).apply(this, args);
    } as never);

    const scan = track(scanner.scan(input));
    await until(() => server.accepted() === 1, "the connection");
    await settle(500);

    // Without backpressure the whole 48 MiB is queued in memory at once.
    expect(handedToSocket).toBeLessThan(size / 2);
    expect(scan.state.outcome).toBeNull();

    server.resumeReading();
    await until(() => server.pending().length >= 1, "the full stream", 20_000);
    expect(server.receivedBytes()).toBeGreaterThanOrEqual(size);
    // Control: the spy does see the writes, so the ceiling above was real.
    expect(handedToSocket).toBeGreaterThanOrEqual(size);
    server.releaseOldest();
    await scan.done;
    expect(scan.state.outcome).toEqual({ ok: true });
  }, 60_000);

  it("fails with 503 when drain never comes before the timeout, and frees the slot", async () => {
    const server = await gate();
    server.pauseReading();
    const scanner = scannerFor(server.port, {
      timeoutMs: 600,
      maxConcurrent: 1,
      maxPerTenant: 1,
      maxQueued: 1,
    });
    const stuck = track(scanner.scan(new Uint8Array(48 * 1024 * 1024).fill(1)));
    await stuck.done;
    expect(stuck.state.outcome?.ok).toBe(false);
    expect((stuck.state.outcome as { error: HttpError }).error).toMatchObject({
      status: 503,
    });

    // The slot is back: a later scan reaches the (now readable) clamd. The
    // aborted scan never finished streaming, so it is not pending.
    server.resumeReading();
    const next = track(scanner.scan(payload(9)));
    await until(
      () => server.pending().some((c) => c.tag === 9),
      "the follow-up scan",
    );
    server.releaseOldest();
    await next.done;
    expect(next.state.outcome).toEqual({ ok: true });
  }, 60_000);
});

describe("legend-1rtm1 the slot always comes back", () => {
  // One slot and almost no queue: any leaked slot turns the next scan into
  // SCANNER_OVERLOADED or a timeout.
  const oneSlot = (port: number, timeoutMs = 1500) =>
    scannerFor(port, {
      timeoutMs,
      maxConcurrent: 1,
      maxPerTenant: 1,
      maxQueued: 1,
    });

  it("after successful scans", async () => {
    const server = await fake({ kind: "reply", reply: "stream: OK\0" });
    const scanner = oneSlot(server.port);
    for (let i = 0; i < 4; i += 1) {
      await expect(scanner.scan(payload(i + 1))).resolves.toBeUndefined();
    }
    expect(server.sessions).toHaveLength(4);
  });

  it("after a detection (FOUND) and after a clamd ERROR", async () => {
    const server = await fake({
      kind: "reply",
      reply: "stream: Eicar-Test-Signature FOUND\0",
    });
    const scanner = oneSlot(server.port);
    for (let i = 0; i < 2; i += 1) {
      await expect(scanner.scan(payload(1))).rejects.toMatchObject({
        status: 422,
      });
    }
    server.setBehavior({ kind: "reply", reply: "stream: ERROR\0" });
    await expect(scanner.scan(payload(1))).rejects.toMatchObject({
      status: 503,
      code: "SCANNER_UNAVAILABLE",
    });
    server.setBehavior({ kind: "reply", reply: "stream: OK\0" });
    await expect(scanner.scan(payload(1))).resolves.toBeUndefined();
  });

  it("after clamd closes without a reply", async () => {
    const server = await fake({ kind: "close" });
    const scanner = oneSlot(server.port);
    for (let i = 0; i < 3; i += 1) {
      await expect(scanner.scan(payload(1))).rejects.toMatchObject({
        status: 503,
        code: "SCANNER_UNAVAILABLE",
      });
    }
    server.setBehavior({ kind: "reply", reply: "stream: OK\0" });
    await expect(scanner.scan(payload(1))).resolves.toBeUndefined();
  });

  it("after a refused connection", async () => {
    const scanner = oneSlot(await unusedPort());
    for (let i = 0; i < 3; i += 1) {
      await expect(scanner.scan(payload(1))).rejects.toMatchObject({
        status: 503,
        code: "SCANNER_UNAVAILABLE",
      });
    }
  });

  it("after a timeout", async () => {
    const server = await fake({ kind: "silent" });
    const scanner = oneSlot(server.port, 400);
    for (let i = 0; i < 2; i += 1) {
      await expect(scanner.scan(payload(1))).rejects.toMatchObject({
        status: 503,
      });
    }
    server.setBehavior({ kind: "reply", reply: "stream: OK\0" });
    await expect(scanner.scan(payload(1))).resolves.toBeUndefined();
  });

  it("per-tenant slots come back too", async () => {
    const server = await fake({ kind: "close" });
    const scanner = oneSlot(server.port);
    for (let i = 0; i < 3; i += 1) {
      await expect(
        scanner.scan(payload(1), { tenantKey: "tenant-a" }),
      ).rejects.toMatchObject({ status: 503, code: "SCANNER_UNAVAILABLE" });
    }
    server.setBehavior({ kind: "reply", reply: "stream: OK\0" });
    await expect(
      scanner.scan(payload(1), { tenantKey: "tenant-a" }),
    ).resolves.toBeUndefined();
  });
});
