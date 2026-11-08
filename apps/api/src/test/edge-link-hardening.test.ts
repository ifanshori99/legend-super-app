// Link transport hardening (beads legend-zinn, legend-wg5t items 1, 6, 8a):
// frame-flood backpressure, heartbeat write throttling, client refusal only on
// the explicit credential header, and the upgrade rate limit. No database:
// real ws on an ephemeral http server plus an in-memory empty store.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import { mintEdgeCredential } from "../edge/credential.ts";
import { expressClientAddress } from "../lib/client-address.ts";
import { createEdgeLinkClient } from "../edge/link-client.ts";
import {
  createLinkPeer,
  type LinkScope,
  type LinkStore,
} from "../edge/link-peer.ts";
import { createEdgeLinkServer } from "../edge/link-server.ts";
import {
  LINK_CLOSE,
  LINK_REFUSED_CREDENTIAL,
  LINK_REFUSED_HEADER,
  encodeFrame,
} from "../edge/protocol.ts";

const scope: LinkScope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};

/** A store with nothing queued; enough for hello and heartbeat traffic. */
function emptyStore(): LinkStore {
  return {
    outboundHead: async () => 0,
    lastAckedOutbound: async () => 0,
    readOutbound: async () => [],
    ackOutbound: async () => undefined,
    lastReceivedInbound: async () => 0,
    applyInbound: async () => undefined,
  };
}

async function settle(until: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!until()) {
    if (Date.now() > end) throw new Error("Did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const heartbeat = () =>
  encodeFrame({
    type: "heartbeat",
    version: "edge",
    occurredAt: new Date().toISOString(),
  });

describe("legend-wg5t #1a frame backpressure", () => {
  function peerWithGate(maxPendingFrames: number) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const closes: { code: number; reason: string }[] = [];
    const store = {
      ...emptyStore(),
      lastReceivedInbound: () => gate.then(() => 0),
    };
    const peer = createLinkPeer({
      scope,
      outboundDirection: "cloud_to_edge",
      store,
      version: "cloud",
      maxPendingFrames,
      transport: {
        send: () => undefined,
        close: (code, reason) => closes.push({ code, reason }),
      },
    });
    return { peer, release, closes };
  }

  it("closes 1013 once more frames are waiting than the bound", async () => {
    const { peer, closes } = peerWithGate(4);
    peer.start(); // holds the chain on the gated store read
    for (let i = 0; i < 4; i += 1) peer.receive(heartbeat());
    expect(closes).toEqual([]);
    peer.receive(heartbeat());
    expect(closes).toHaveLength(1);
    expect(closes[0]?.code).toBe(LINK_CLOSE.overloaded);
    expect(LINK_CLOSE.overloaded).toBe(1013);
  });

  it("does not close a peer whose frames keep being processed", async () => {
    const { peer, release, closes } = peerWithGate(4);
    peer.start();
    for (let i = 0; i < 4; i += 1) peer.receive(heartbeat());
    release();
    await peer.idle();
    for (let i = 0; i < 4; i += 1) peer.receive(heartbeat());
    await peer.idle();
    expect(closes).toEqual([]);
  });
});

describe("legend-wg5t link server over real ws", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = undefined;
  });

  async function listen(created: Server): Promise<string> {
    server = created;
    await new Promise<void>((resolve) =>
      created.listen(0, "127.0.0.1", resolve),
    );
    const port = (created.address() as AddressInfo).port;
    return `ws://127.0.0.1:${port}/api/edge-link`;
  }

  /** One upgrade attempt; resolves with the refusal status and headers. */
  function probe(url: string, token: string) {
    return new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
    }>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      ws.on("unexpected-response", (_request, response) => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
        });
        ws.terminate();
      });
      ws.on("open", () => {
        resolve({ status: 101, headers: {} });
        ws.terminate();
      });
      ws.on("error", () => undefined);
      ws.on("close", () => reject(new Error("closed without a response")));
    });
  }

  it("legend-wg5t #1b writes at most one heartbeat per interval per link", async () => {
    const { token } = mintEdgeCredential(scope);
    let at = 1_000_000;
    let writes = 0;
    const live = createServer();
    const throttled = createEdgeLinkServer(live, {
      version: "cloud",
      now: () => at,
      heartbeatWriteIntervalMs: 60_000,
      authenticate: async (presented) =>
        presented === token ? { scope } : null,
      isActive: async () => true,
      storeFor: () => emptyStore(),
      onHeartbeat: async () => {
        writes += 1;
      },
    });
    const url = await listen(live);
    const client = createEdgeLinkClient({
      url,
      credential: token,
      scope,
      store: emptyStore(),
      version: "edge",
      heartbeatIntervalMs: 15,
    });
    await settle(() => writes === 1);
    await sleep(200); // ~13 more heartbeats arrive and are dropped
    expect(writes).toBe(1);
    at += 60_000;
    await settle(() => writes === 2);
    await sleep(100);
    expect(writes).toBe(2);
    await client.stop();
    await throttled.close();
  });

  describe("client refusal (legend-wg5t #6)", () => {
    /** Upgrade endpoint that always refuses; counts attempts. */
    async function refusingServer(status: 401 | 403, header?: string) {
      const attempts = { count: 0 };
      const created = createServer();
      created.on("upgrade", (_request, socket) => {
        attempts.count += 1;
        const extra = header ? `${LINK_REFUSED_HEADER}: ${header}\r\n` : "";
        socket.write(
          `HTTP/1.1 ${status} Refused\r\n${extra}Connection: close\r\n\r\n`,
        );
        socket.destroy();
      });
      return { attempts, url: await listen(created) };
    }

    for (const status of [401, 403] as const) {
      it(`keeps retrying a bare ${status} (WAF or proxy)`, async () => {
        const { attempts, url } = await refusingServer(status);
        const client = createEdgeLinkClient({
          url,
          credential: "edg1.x",
          scope,
          store: emptyStore(),
          version: "edge",
          random: () => 0, // 500 ms floor between attempts
        });
        await settle(() => attempts.count >= 2, 4000);
        expect(client.state().refused).toBe(false);
        await client.stop();
      });

      it(`stops on ${status} with the credential refusal header`, async () => {
        const { attempts, url } = await refusingServer(
          status,
          LINK_REFUSED_CREDENTIAL,
        );
        const client = createEdgeLinkClient({
          url,
          credential: "edg1.x",
          scope,
          store: emptyStore(),
          version: "edge",
          random: () => 0,
        });
        await settle(() => client.state().refused);
        await sleep(900); // longer than the 500 ms retry floor
        expect(attempts.count).toBe(1);
        await client.stop();
      });
    }

    it("stops on close code 4403", async () => {
      const created = createServer();
      const wss = new WebSocketServer({ server: created });
      let connections = 0;
      wss.on("connection", (ws) => {
        connections += 1;
        ws.close(LINK_CLOSE.revoked, "Edge node revoked");
      });
      const url = await listen(created);
      const client = createEdgeLinkClient({
        url,
        credential: "edg1.x",
        scope,
        store: emptyStore(),
        version: "edge",
        random: () => 0,
      });
      await settle(() => client.state().refused);
      await sleep(900);
      expect(connections).toBe(1);
      await client.stop();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });

    it("the real server marks a refused credential with the header", async () => {
      const live = createServer();
      const linkServer = createEdgeLinkServer(live, {
        version: "cloud",
        authenticate: async () => null,
        isActive: async () => true,
        storeFor: () => emptyStore(),
      });
      const url = await listen(live);
      const { token } = mintEdgeCredential(scope);
      const refused = await probe(url, token);
      expect(refused.status).toBe(401);
      expect(refused.headers[LINK_REFUSED_HEADER]).toBe(
        LINK_REFUSED_CREDENTIAL,
      );
      await linkServer.close();
    });
  });

  describe("upgrade rate limit (legend-wg5t #8a)", () => {
    function node() {
      return mintEdgeCredential({ ...scope, edgeNodeId: randomUUID() }).token;
    }

    async function limited(
      limits: { perAddress?: number; perNode?: number },
      authenticate: () => Promise<null> = async () => null,
    ) {
      const live = createServer();
      const linkServer = createEdgeLinkServer(live, {
        version: "cloud",
        now: () => 1_000_000,
        upgradeRateLimit: { windowMs: 60_000, ...limits },
        authenticate,
        isActive: async () => true,
        storeFor: () => emptyStore(),
      });
      return { linkServer, url: await listen(live) };
    }

    it("429s a node over its budget and leaves other nodes alone", async () => {
      let authenticated = 0;
      const { linkServer, url } = await limited(
        { perAddress: 1000, perNode: 2 },
        async () => {
          authenticated += 1;
          return null;
        },
      );
      const a = node();
      const b = node();
      expect((await probe(url, a)).status).toBe(401);
      expect((await probe(url, a)).status).toBe(401);
      const over = await probe(url, a);
      expect(over.status).toBe(429);
      expect(Number(over.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(over.headers["cache-control"]).toBe("no-store");
      expect(JSON.stringify(over.headers)).not.toContain(a);
      expect(authenticated).toBe(2); // the 429 never reached the DB lookup
      expect((await probe(url, b)).status).toBe(401);
      await linkServer.close();
    });

    it("a forged credential for a node's id cannot spend the real node's budget", async () => {
      const { linkServer, url } = await limited({
        perAddress: 1000,
        perNode: 2,
      });
      const victim = { ...scope, edgeNodeId: randomUUID() };
      const real = mintEdgeCredential(victim).token;
      // Same tenant, outlet and node id, wrong secret: a different bucket.
      for (let i = 0; i < 5; i += 1)
        expect(
          (await probe(url, mintEdgeCredential(victim).token)).status,
        ).toBe(401);
      expect((await probe(url, real)).status).toBe(401);
      expect((await probe(url, real)).status).toBe(401);
      expect((await probe(url, real)).status).toBe(429);
      await linkServer.close();
    });

    it("429s an address over its budget before any lookup", async () => {
      let authenticated = 0;
      const { linkServer, url } = await limited(
        { perAddress: 3, perNode: 1000 },
        async () => {
          authenticated += 1;
          return null;
        },
      );
      for (let i = 0; i < 3; i += 1)
        expect((await probe(url, node())).status).toBe(401);
      expect((await probe(url, node())).status).toBe(429);
      expect((await probe(url, "not-a-credential")).status).toBe(429);
      expect(authenticated).toBe(3);
      await linkServer.close();
    });

    it("behind a trusted proxy, the address bucket is the real client's, not the proxy's", async () => {
      const proxied = express();
      proxied.set("trust proxy", 1);
      const live = createServer();
      const linkServer = createEdgeLinkServer(live, {
        version: "cloud",
        now: () => 1_000_000,
        upgradeRateLimit: { windowMs: 60_000, perAddress: 2, perNode: 1000 },
        clientAddress: expressClientAddress(proxied),
        authenticate: async () => null,
        isActive: async () => true,
        storeFor: () => emptyStore(),
      });
      const url = await listen(live);
      const from = (client: string) =>
        new Promise<number>((resolve) => {
          const ws = new WebSocket(url, {
            headers: {
              authorization: `Bearer ${node()}`,
              "x-forwarded-for": client,
            },
          });
          ws.on("unexpected-response", (_request, response) => {
            resolve(response.statusCode ?? 0);
            ws.terminate();
          });
          ws.on("error", () => undefined);
        });
      // All requests share the proxy's socket address (127.0.0.1).
      expect(await from("203.0.113.1")).toBe(401);
      expect(await from("203.0.113.1")).toBe(401);
      expect(await from("203.0.113.1")).toBe(429);
      expect(await from("203.0.113.2")).toBe(401);
      await linkServer.close();
    });

    it("the client backs off on 429 instead of giving up", async () => {
      const { linkServer, url } = await limited({ perNode: 0 });
      let upgrades = 0;
      server!.on("upgrade", () => (upgrades += 1));
      const client = createEdgeLinkClient({
        url,
        credential: node(),
        scope,
        store: emptyStore(),
        version: "edge",
        random: () => 0,
      });
      await settle(() => upgrades >= 2, 4000);
      expect(client.state().refused).toBe(false);
      await client.stop();
      await linkServer.close();
    });
  });
});
