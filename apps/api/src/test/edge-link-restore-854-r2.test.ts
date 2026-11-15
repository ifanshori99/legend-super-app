// legend-tmar2 / 854 "Revisi 2" R2.1 (docs/briefs/854-edge-proof-fail-closed.md):
// an edge 854 (it sends x-edge-restore-proof-v2 and can verify proofs) must
// never ack the cloud cursor without proof.
//
// - cloud 854 (link-server) echoes `x-edge-restore-proof-v2: 1` in the upgrade
//   response, only when the request carried v2;
// - link-client (edge) reads that header; LinkPeerOptions gets
//   `requireRestoreProof` and `peerEchoesRestoreProof`;
// - link-peer onHello (edge): cursor > acked + hello WITHOUT proof +
//   requireRestoreProof -> LinkProtocolError "Restore proof ..." (no ack). Two
//   messages: cloud does not echo ("... upgrade cloud first") versus echoes but
//   sent no proof (a violation);
// - the refusal is a proofRefused close: the reconnect backoff keeps growing;
// - cursor <= acked: no refusal. requireRestoreProof unset: old behavior.
//
// Assumptions where the brief is silent:
// - The "no echo" refusal reason contains "upgrade cloud" (brief quotes
//   "cloud does not support restore proof; upgrade cloud first"); the
//   "echoes but no proof" reason starts with "Restore proof" and does NOT
//   contain "upgrade cloud".
// - The echoed header value is "1" and a request without v2 gets no header.
// - The refused edge closes the socket with 1008 (existing refusal code).
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUlid, ulidToUuid } from "@starter/shared/core";
import type { EventEnvelope, SyncDirection } from "@starter/shared/events";
import { mintEdgeCredential } from "../edge/credential.ts";
import { createEdgeLinkClient } from "../edge/link-client.ts";
import {
  createLinkPeer,
  type LinkPeer,
  type LinkPeerOptions,
  type LinkScope,
  type LinkStore,
  type QueuedEdgeEvent,
} from "../edge/link-peer.ts";
import { createEdgeLinkServer } from "../edge/link-server.ts";
import { decodeFrame } from "../edge/protocol.ts";

const scope: LinkScope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};
const V1 = "x-edge-restore-proof";
const V2 = "x-edge-restore-proof-v2";

type Proof = { count: number; sha256: string };
function refProof(uuids: readonly string[]): Proof {
  const hash = createHash("sha256");
  for (const id of uuids) hash.update(`${id.toLowerCase()}\n`);
  return { count: uuids.length, sha256: hash.digest("hex") };
}

let clock = Date.parse("2026-11-15T01:00:00.000Z");
function event(): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: scope.tenantId as EventEnvelope["tenantId"],
    outletId: scope.outletId as EventEnvelope["outletId"],
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId: randomUUID(),
    sequence: 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `restore-854-r2-${clock}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: {},
  } as EventEnvelope;
}
const uuidOf = (item: EventEnvelope) => ulidToUuid(item.id);
const seen = Array.from({ length: 5 }, () => event());

/** Edge store: 5 durable slots, the first `acked` already acked. */
class EdgeStore implements LinkStore {
  readonly outbound: SyncDirection = "edge_to_cloud";
  acked: number;
  ackCalls: number[] = [];
  constructor(acked = 2) {
    this.acked = acked;
  }
  async outboundHead() {
    return seen.length;
  }
  async lastAckedOutbound() {
    return this.acked;
  }
  async readOutbound(after: number, limit: number): Promise<QueuedEdgeEvent[]> {
    return seen
      .map((item, index) => ({ linkSeq: index + 1, event: item }))
      .filter((slot) => slot.linkSeq > after)
      .slice(0, limit);
  }
  async ackOutbound(upto: number) {
    this.ackCalls.push(upto);
    this.acked = Math.max(this.acked, upto);
  }
  async lastReceivedInbound() {
    return 0;
  }
  async applyInbound() {}
  async outboundProof(fromSeq: number, toSeq: number): Promise<Proof> {
    return refProof(seen.slice(fromSeq, toSeq).map(uuidOf));
  }
}

const cleanup: (() => Promise<unknown>)[] = [];
const peers: LinkPeer[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.stop();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function helloFrame(cursor: number, proof?: unknown) {
  return JSON.stringify({
    type: "hello",
    version: "cloud",
    inboundCursor: String(cursor),
    ...(proof === undefined ? {} : { inboundProof: proof }),
  });
}

function lone(store: EdgeStore, extra: Record<string, unknown> = {}) {
  const send = vi.fn();
  const close = vi.fn();
  const peer = createLinkPeer({
    scope,
    outboundDirection: "edge_to_cloud",
    store,
    version: "edge",
    ackTimeoutMs: 20,
    transport: { send, close },
    ...extra,
  } as LinkPeerOptions);
  peers.push(peer);
  return { peer, close, send };
}

async function until(check: () => boolean, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/edge-link`;
}

describe("legend-tmar2 854 R2.1 edge peer: no ack without proof when proof is required", () => {
  it("R2.1 cursor > acked, hello without proof, cloud does not echo v2: refused as 'upgrade cloud first', nothing acked", async () => {
    const store = new EdgeStore(2);
    const { peer, close } = lone(store, { requireRestoreProof: true });
    peer.receive(helloFrame(5));
    await peer.idle();
    expect(close).toHaveBeenCalledWith(
      1008,
      expect.stringMatching(/^Restore proof.*upgrade cloud/i),
    );
    expect(store.ackCalls).toEqual([]);
    expect(store.acked).toBe(2);
  });

  it("R2.1 cursor > acked, hello without proof, cloud echoed v2: refused as a violation (different message), nothing acked", async () => {
    const store = new EdgeStore(2);
    const { peer, close } = lone(store, {
      requireRestoreProof: true,
      peerEchoesRestoreProof: true,
    });
    peer.receive(helloFrame(5));
    await peer.idle();
    expect(close).toHaveBeenCalledWith(
      1008,
      expect.stringMatching(/^Restore proof/i),
    );
    const reason = String(close.mock.calls[0]?.[1] ?? "");
    expect(reason).not.toMatch(/upgrade cloud/i);
    expect(store.ackCalls).toEqual([]);
  });

  it("R2.1 cursor <= acked: no refusal even without proof (nothing to ack)", async () => {
    for (const cursor of [2, 1, 0]) {
      const store = new EdgeStore(2);
      const { peer, close } = lone(store, { requireRestoreProof: true });
      peer.receive(helloFrame(cursor));
      await peer.idle();
      expect(close).not.toHaveBeenCalled();
      expect(store.ackCalls).toEqual([]);
    }
  });

  it("R2.1 with a matching proof the edge acks as before, whether or not the cloud echoed v2", async () => {
    for (const echo of [false, true]) {
      const store = new EdgeStore(2);
      const { peer, close } = lone(store, {
        requireRestoreProof: true,
        peerEchoesRestoreProof: echo,
      });
      peer.receive(
        helloFrame(5, { from: 2, ...refProof(seen.slice(2, 5).map(uuidOf)) }),
      );
      await peer.idle();
      expect(close).not.toHaveBeenCalled();
      expect(store.ackCalls).toEqual([5]);
    }
  });

  it("R2.1 requireRestoreProof not set (other contexts, old peers): the old behavior, ack the cursor", async () => {
    const store = new EdgeStore(2);
    const { peer, close } = lone(store);
    peer.receive(helloFrame(5));
    await peer.idle();
    expect(close).not.toHaveBeenCalled();
    expect(store.ackCalls).toEqual([5]);
  });
});

describe("legend-tmar2 854 R2.1 link-client: fake cloud 848 (no echo) or a violating cloud", () => {
  /** A fake cloud: hello without proof; optionally echoes v2 in the upgrade. */
  async function fakeCloud(echo: boolean, hello: string) {
    const server = createServer();
    const sockets = new WebSocketServer({ server, path: "/api/edge-link" });
    if (echo)
      sockets.on("headers", (headers) => {
        headers.push(`${V2}: 1`);
      });
    const connections: { v1?: string; v2?: string }[] = [];
    const closes: { code: number; reason: string }[] = [];
    const frames: string[] = [];
    sockets.on("connection", (socket, request) => {
      connections.push({
        v1: request.headers[V1] as string | undefined,
        v2: request.headers[V2] as string | undefined,
      });
      socket.on("message", (raw) => frames.push(String(raw)));
      socket.on("close", (code, reason) =>
        closes.push({ code, reason: reason.toString() }),
      );
      socket.send(hello);
    });
    cleanup.push(
      () => new Promise<void>((resolve) => sockets.close(() => resolve())),
    );
    const url = await listen(server);
    return { url, connections, closes, frames };
  }

  function startClient(url: string, store: EdgeStore, random = () => 0) {
    const client = createEdgeLinkClient({
      url,
      credential: mintEdgeCredential(scope).token,
      scope,
      store,
      version: "edge",
      random,
    });
    cleanup.push(() => client.stop());
    return client;
  }

  it("R2.1 cloud 848 (no echo) sends a hello without proof: the edge closes 1008 'upgrade cloud first' and acks nothing", async () => {
    const cloud = await fakeCloud(false, helloFrame(5));
    const store = new EdgeStore(2);
    startClient(cloud.url, store);
    await until(() => cloud.closes.length > 0, "the edge refuses the hello");
    expect(cloud.connections[0]).toEqual({ v1: "2", v2: "1" });
    expect(cloud.closes[0]!.code).toBe(1008);
    expect(cloud.closes[0]!.reason).toMatch(/^Restore proof.*upgrade cloud/i);
    expect(store.ackCalls).toEqual([]);
    expect(store.acked).toBe(2);
  }, 15_000);

  it("R2.1 cloud echoes v2 but sends no proof: the edge closes 1008 (violation), acks nothing", async () => {
    const cloud = await fakeCloud(true, helloFrame(5));
    const store = new EdgeStore(2);
    startClient(cloud.url, store);
    await until(() => cloud.closes.length > 0, "the edge refuses the hello");
    expect(cloud.closes[0]!.code).toBe(1008);
    expect(cloud.closes[0]!.reason).toMatch(/^Restore proof/i);
    expect(cloud.closes[0]!.reason).not.toMatch(/upgrade cloud/i);
    expect(store.ackCalls).toEqual([]);
  }, 15_000);

  it("R2.1 cloud echoes v2 and sends a matching proof: the edge acks the cursor and stays connected", async () => {
    const cloud = await fakeCloud(
      true,
      helloFrame(5, { from: 2, ...refProof(seen.slice(2, 5).map(uuidOf)) }),
    );
    const store = new EdgeStore(2);
    startClient(cloud.url, store);
    await until(() => store.acked === 5, "the edge acks slot 5");
    expect(store.ackCalls[0]).toBe(5);
    expect(cloud.closes).toEqual([]);
  }, 15_000);

  it("R2.1 the refusal keeps the reconnect backoff growing (1000, 2000, 4000), no fast loop", async () => {
    const cloud = await fakeCloud(false, helloFrame(5));
    const waits: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const backoff = [1000, 2000, 4000, 8000].includes(ms ?? -1);
      if (backoff) waits.push(ms!);
      return (realSetTimeout as (...a: unknown[]) => unknown)(
        fn,
        backoff ? 5 : ms,
        ...args,
      );
    }) as unknown as typeof setTimeout);
    const store = new EdgeStore(2);
    startClient(cloud.url, store, () => 1);
    try {
      const end = Date.now() + 15_000;
      while (waits.length < 3) {
        if (Date.now() > end) throw new Error("Backoff did not repeat");
        await new Promise((resolve) => realSetTimeout(resolve, 10));
      }
      expect(waits.slice(0, 3)).toEqual([1000, 2000, 4000]);
      expect(store.ackCalls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }, 20_000);
});

describe("legend-tmar2 854 R2.1 cloud link-server: echo of x-edge-restore-proof-v2", () => {
  const digest = refProof(["a"]);

  /** Real link server with a fake store; returns the upgrade headers and hello. */
  async function connectTo(
    requestHeaders: Record<string, string>,
    proof: { to: number } & Proof,
    cursor = 5,
  ) {
    const server = createServer();
    const token = mintEdgeCredential(scope).token;
    const cloud: LinkStore = {
      outboundHead: async () => 0,
      lastAckedOutbound: async () => 0,
      readOutbound: async () => [],
      ackOutbound: async () => {},
      lastReceivedInbound: async () => cursor,
      applyInbound: async () => {},
      inboundProof: async () => proof,
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
      headers: { Authorization: `Bearer ${token}`, ...requestHeaders },
    });
    cleanup.push(async () => {
      socket.terminate();
    });
    const upgraded = once(socket, "upgrade");
    const message = once(socket, "message");
    const [response] = (await upgraded) as [
      { headers: Record<string, string | string[] | undefined> },
    ];
    const [raw] = await message;
    return {
      headers: response.headers,
      hello: JSON.parse(String(raw)) as Record<string, unknown>,
    };
  }

  it("R2.1 request with v1 + v2: the response carries x-edge-restore-proof-v2: 1", async () => {
    const { headers } = await connectTo(
      { [V1]: "2", [V2]: "1" },
      {
        to: 5,
        ...digest,
      },
    );
    expect(headers[V2]).toBe("1");
  });

  it("R2.1 request with v1 only (edge 848): no v2 header in the response", async () => {
    const { headers } = await connectTo({ [V1]: "2" }, { to: 5, ...digest });
    expect(headers[V2]).toBeUndefined();
  });

  it("R2.1 request without any restore header (old edge): no v2 header in the response", async () => {
    const { headers } = await connectTo({}, { to: 5, ...digest });
    expect(headers[V2]).toBeUndefined();
  });

  it("R2.1 strict (v1 + v2): a partial proof carries `to`, an empty proof carries to = from; a complete proof has no `to`", async () => {
    const partial = await connectTo(
      { [V1]: "2", [V2]: "1" },
      {
        to: 3,
        ...digest,
      },
    );
    expect(partial.hello.inboundProof).toMatchObject({ from: 2, to: "3" });
    const empty = await connectTo(
      { [V1]: "2", [V2]: "1" },
      {
        to: 2,
        ...refProof([]),
      },
    );
    expect(empty.hello.inboundProof).toMatchObject({
      from: 2,
      to: "2",
      count: 0,
    });
    const full = await connectTo(
      { [V1]: "2", [V2]: "1" },
      {
        to: 5,
        ...digest,
      },
    );
    expect(full.hello.inboundProof).toMatchObject({ from: 2 });
    expect(full.hello.inboundProof).not.toHaveProperty("to");
  });

  it("R2.1 edge 848 (v1 only): a partial proof gives a hello without proof, as in 848", async () => {
    const { hello } = await connectTo({ [V1]: "2" }, { to: 3, ...digest });
    expect(hello).not.toHaveProperty("inboundProof");
  });
});

// Keeps decodeFrame in use: the unit frames above must stay valid hello frames.
describe("legend-tmar2 854 R2.1 helper sanity", () => {
  it("the hello frames used by these tests are valid frames", () => {
    expect(decodeFrame(helloFrame(5))).not.toBeNull();
    expect(
      decodeFrame(
        helloFrame(5, { from: 2, ...refProof(seen.slice(2, 5).map(uuidOf)) }),
      ),
    ).not.toBeNull();
  });
});
