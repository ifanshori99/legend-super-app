// legend-tmar2 (848 design sections 3-4): the edge announces its durable
// acked_out_seq A in the `x-edge-restore-proof` upgrade header; the cloud
// answers with a digest of (A, N] in hello only for a valid header and N > A.
// No v2 header here (848 edge, not strict): the proof is sent only when the
// store proves the whole range (to == N) and carries no `to` on the wire.
// Header missing or malformed: the legacy hello, byte for byte, so old edges
// keep working. Real WebSocket server/client on loopback, in-memory stores.
//
// Assumptions: the header is sent on every connect, including A = 0 (design:
// "kirim header hanya bila store tersedia"); the client re-reads A from
// store.lastAckedOutbound() on each reconnect.
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintEdgeCredential } from "../edge/credential.ts";
import { createEdgeLinkClient } from "../edge/link-client.ts";
import type { LinkStore } from "../edge/link-peer.ts";
import { createEdgeLinkServer } from "../edge/link-server.ts";

const HEADER = "x-edge-restore-proof";
const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const store = (overrides: Partial<LinkStore> = {}): LinkStore => ({
  outboundHead: async () => 0,
  lastAckedOutbound: async () => 0,
  readOutbound: async () => [],
  ackOutbound: async () => {},
  lastReceivedInbound: async () => 0,
  applyInbound: async () => {},
  ...overrides,
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/edge-link`;
}

const digest = {
  count: 3,
  sha256: createHash("sha256").update("x").digest("hex"),
};

describe("legend-tmar2 cloud hello", () => {
  async function cloudHello(
    cloudCursor: number,
    header: string | undefined,
  ): Promise<{
    hello: Record<string, unknown>;
    inboundProof: ReturnType<typeof vi.fn>;
  }> {
    const server = createServer();
    const token = mintEdgeCredential(scope).token;
    // 854 contract: the store proves the whole range here (to == N).
    const inboundProof = vi.fn(async (_from: number, to: number) => ({
      to,
      ...digest,
    }));
    const cloud: LinkStore = {
      ...store({ lastReceivedInbound: async () => cloudCursor }),
      inboundProof,
    };
    const links = createEdgeLinkServer(server, {
      version: "cloud",
      authenticate: async (presented) =>
        presented === token ? { scope } : null,
      isActive: async () => true,
      storeFor: () => cloud,
    });
    const url = await listen(server);
    cleanup.push(() => links.close());
    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(header === undefined ? {} : { [HEADER]: header }),
      },
    });
    cleanup.push(async () => {
      socket.terminate();
    });
    const [raw] = await once(socket, "message");
    return { hello: JSON.parse(String(raw)), inboundProof };
  }

  it("valid header and N > A: hello carries the digest of (A, N]", async () => {
    const { hello, inboundProof } = await cloudHello(5, "2");
    expect(hello).toMatchObject({
      type: "hello",
      inboundCursor: "5",
      inboundProof: { from: 2, ...digest },
    });
    expect(inboundProof).toHaveBeenCalledWith(2, 5);
  });

  it("A = 0 is a valid header: digest covers (0, N]", async () => {
    const { hello, inboundProof } = await cloudHello(4, "0");
    expect(hello.inboundProof).toEqual({ from: 0, ...digest });
    expect(inboundProof).toHaveBeenCalledWith(0, 4);
  });

  it("c. old edge without the header: legacy hello, no proof, link works", async () => {
    const { hello, inboundProof } = await cloudHello(5, undefined);
    expect(Object.keys(hello).sort()).toEqual([
      "inboundCursor",
      "type",
      "version",
    ]);
    expect(hello.inboundCursor).toBe("5");
    expect(inboundProof).not.toHaveBeenCalled();
  });

  it.each(["abc", "-1", "1.5", "", "01"])(
    "malformed header %j behaves like no header",
    async (value) => {
      const { hello, inboundProof } = await cloudHello(5, value);
      expect(hello).toMatchObject({ type: "hello", inboundCursor: "5" });
      expect(hello).not.toHaveProperty("inboundProof");
      expect(inboundProof).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["N equals A", 5, "5"],
    ["N below A", 5, "9"],
  ])("%s: no proof, nothing to ack", async (_name, cursor, header) => {
    const { hello, inboundProof } = await cloudHello(cursor, header);
    expect(hello).not.toHaveProperty("inboundProof");
    expect(inboundProof).not.toHaveBeenCalled();
  });
});

describe("legend-tmar2 edge client header", () => {
  function fakeCloud() {
    const server = createServer();
    const sockets = new WebSocketServer({ server, path: "/api/edge-link" });
    const headers: (string | string[] | undefined)[] = [];
    const hellos: Record<string, unknown>[] = [];
    sockets.on("connection", (socket, request) => {
      headers.push(request.headers[HEADER]);
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "hello") hellos.push(frame);
      });
      socket.send(
        JSON.stringify({
          type: "hello",
          version: "old-cloud",
          inboundCursor: "0",
        }),
      );
      // First connection only: force a reconnect (not a final close code).
      if (headers.length === 1)
        setTimeout(() => socket.close(1013, "retry"), 50);
    });
    cleanup.push(
      () => new Promise<void>((resolve) => sockets.close(() => resolve())),
    );
    return { server, headers, hellos };
  }

  it("sends A = store.lastAckedOutbound() and re-reads it on every reconnect", async () => {
    const cloud = fakeCloud();
    const url = await listen(cloud.server);
    let acked = 7;
    const client = createEdgeLinkClient({
      url,
      credential: mintEdgeCredential(scope).token,
      scope,
      store: store({
        lastAckedOutbound: async () => acked,
        outboundHead: async () => 20,
        // Contract: the edge store verifies proofs (link-peer stays generic).
        outboundProof: async () => digest,
      }),
      version: "edge",
      random: () => 0,
    });
    cleanup.push(() => client.stop());
    const end = Date.now() + 10_000;
    while (cloud.headers.length < 1) {
      if (Date.now() > end) throw new Error("No first connection");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cloud.headers[0]).toBe("7");
    acked = 12;
    while (cloud.headers.length < 2) {
      if (Date.now() > end) throw new Error("No reconnect");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cloud.headers[1]).toBe("12");
  }, 15_000);

  it("sends no header when the store cannot verify a proof (assumption: header only when the store is capable)", async () => {
    const cloud = fakeCloud();
    const url = await listen(cloud.server);
    const client = createEdgeLinkClient({
      url,
      credential: mintEdgeCredential(scope).token,
      scope,
      store: store({ lastAckedOutbound: async () => 3 }),
      version: "edge",
    });
    cleanup.push(() => client.stop());
    const end = Date.now() + 10_000;
    while (cloud.headers.length < 1) {
      if (Date.now() > end) throw new Error("No connection");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(cloud.headers[0]).toBeUndefined();
  }, 15_000);

  it("keeps its own hello unchanged for an old cloud (strict legacy frame)", async () => {
    const cloud = fakeCloud();
    const url = await listen(cloud.server);
    const client = createEdgeLinkClient({
      url,
      credential: mintEdgeCredential(scope).token,
      scope,
      store: store(),
      version: "edge",
    });
    cleanup.push(() => client.stop());
    const end = Date.now() + 10_000;
    while (cloud.hellos.length < 1) {
      if (Date.now() > end) throw new Error("No hello from the edge");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(Object.keys(cloud.hellos[0]!).sort()).toEqual([
      "inboundCursor",
      "type",
      "version",
    ]);
  }, 15_000);
});
