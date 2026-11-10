import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakePrinterTransport,
  PrintTransportError,
  createNetworkTransport,
  createUsbTransport,
  defaultTransportFactory,
} from "../edge/print/transport.ts";
import type { PrinterConfig } from "../edge/print/types.ts";

const servers: net.Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          (
            server as net.Server & { closeAllConnections?: () => void }
          ).closeAllConnections?.();
        }),
    ),
  );
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function listen(
  onConnection: (socket: net.Socket) => void,
): Promise<number> {
  const server = net.createServer(onConnection);
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return (server.address() as net.AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "print-transport-"));
  dirs.push(dir);
  return dir;
}

describe("network transport", () => {
  it("delivers the exact bytes to the printer port", async () => {
    const received: Buffer[] = [];
    let resolveDone: (bytes: Buffer) => void = () => undefined;
    const done = new Promise<Buffer>((resolve) => {
      resolveDone = resolve;
    });
    const port = await listen((socket) => {
      socket.on("data", (chunk: Buffer) => received.push(chunk));
      socket.on("end", () => resolveDone(Buffer.concat(received)));
    });
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    const transport = createNetworkTransport({
      host: "127.0.0.1",
      port,
    });
    await transport.send(bytes);
    expect(Uint8Array.from(await done)).toEqual(bytes);
  });

  it("rejects with phase connect when nothing listens on the port", async () => {
    const transport = createNetworkTransport({
      host: "127.0.0.1",
      port: await closedPort(),
    });
    const error = await transport
      .send(new Uint8Array([0x1b, 0x40]))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrintTransportError);
    expect((error as PrintTransportError).phase).toBe("connect");
  });

  it("rejects with phase write when the printer drops the connection mid-send", async () => {
    const port = await listen((socket) => {
      // The printer stops reading, so the write cannot flush; it then resets.
      socket.pause();
      setTimeout(() => socket.resetAndDestroy(), 100);
    });
    const transport = createNetworkTransport({
      host: "127.0.0.1",
      port,
      timeoutMs: 5000,
    });
    // Larger than any loopback socket buffer, so the flush never completes
    // before the reset.
    const error = await transport
      .send(new Uint8Array(64_000_000))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrintTransportError);
    expect((error as PrintTransportError).phase).toBe("write");
  });

  it("resolves once the write is flushed even if the printer never closes", async () => {
    const received: Buffer[] = [];
    let resolveGot: () => void = () => undefined;
    const got = new Promise<void>((resolve) => {
      resolveGot = resolve;
    });
    const port = await listen((socket) => {
      // Reads everything, never ends or closes its side.
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk);
        if (Buffer.concat(received).length >= 4) resolveGot();
      });
    });
    const transport = createNetworkTransport({
      host: "127.0.0.1",
      port,
      timeoutMs: 200,
    });
    await transport.send(new Uint8Array([1, 2, 3, 4]));
    await got;
    // The idle timeout after the flush must not turn into a rejection.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(Uint8Array.from(Buffer.concat(received))).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it("probe is true for a listening port and false for a closed one", async () => {
    const port = await listen((socket) => socket.end());
    expect(
      await createNetworkTransport({ host: "127.0.0.1", port }).probe(),
    ).toBe(true);
    expect(
      await createNetworkTransport({
        host: "127.0.0.1",
        port: await closedPort(),
      }).probe(),
    ).toBe(false);
  });

  it("probe is false when the connect attempt times out", async () => {
    // 192.0.2.0/24 (TEST-NET-1) is unroutable; connect either hangs or fails.
    const transport = createNetworkTransport({
      host: "192.0.2.1",
      port: 9100,
      probeTimeoutMs: 100,
    });
    expect(await transport.probe()).toBe(false);
  });
});

describe("usb transport", () => {
  it("writes the bytes to the device file", async () => {
    const devicePath = join(await tempDir(), "lp0");
    await writeFile(devicePath, "");
    const transport = createUsbTransport({ devicePath });
    const bytes = new Uint8Array([0x1b, 0x40, 0x41, 0x0a, 0x1d, 0x56, 0x42, 3]);
    await transport.send(bytes);
    expect(Uint8Array.from(await readFile(devicePath))).toEqual(bytes);
    expect(await transport.probe()).toBe(true);
  });

  it("rejects with phase connect when the device cannot be opened", async () => {
    const transport = createUsbTransport({
      devicePath: join(await tempDir(), "missing", "lp0"),
    });
    const error = await transport
      .send(new Uint8Array([1]))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrintTransportError);
    expect((error as PrintTransportError).phase).toBe("connect");
    expect(await transport.probe()).toBe(false);
  });
});

describe("defaultTransportFactory", () => {
  const base: Omit<PrinterConfig, "transport"> = {
    id: "p1",
    tenantId: "t",
    outletId: "o",
    label: "Kasir",
    role: "receipt",
    stationId: null,
    paperWidth: 48,
    fallbackPrinterId: null,
    status: "unknown",
    lastSeenAt: null,
    offlineSince: null,
  };

  it("picks the network transport by kind", async () => {
    const port = await listen((socket) => socket.end());
    const transport = defaultTransportFactory({
      ...base,
      transport: { kind: "network", host: "127.0.0.1", port },
    });
    expect(await transport.probe()).toBe(true);
  });

  it("picks the usb transport by kind", async () => {
    const transport = defaultTransportFactory({
      ...base,
      transport: { kind: "usb", devicePath: "/nonexistent/lp0" },
    });
    expect(await transport.probe()).toBe(false);
  });
});

describe("FakePrinterTransport", () => {
  it("records printed bytes and probes online", async () => {
    const fake = new FakePrinterTransport();
    await fake.send(new Uint8Array([1, 2]));
    expect(fake.printed).toEqual([new Uint8Array([1, 2])]);
    expect(await fake.probe()).toBe(true);
  });

  it("fails with a connect error while offline", async () => {
    const fake = new FakePrinterTransport();
    fake.online = false;
    expect(await fake.probe()).toBe(false);
    const error = await fake.send(new Uint8Array([1])).catch((e: unknown) => e);
    expect((error as PrintTransportError).phase).toBe("connect");
    expect(fake.printed).toHaveLength(0);
  });

  it("failNextSend fails once in the requested phase, then recovers", async () => {
    const fake = new FakePrinterTransport();
    fake.failNextSend = "write";
    const error = await fake.send(new Uint8Array([1])).catch((e: unknown) => e);
    expect((error as PrintTransportError).phase).toBe("write");
    expect(fake.printed).toHaveLength(0);
    await fake.send(new Uint8Array([2]));
    expect(fake.printed).toEqual([new Uint8Array([2])]);
  });
});
