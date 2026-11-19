// legend-z2kaf: the edge link server (WebSocket upgrade) keys its per-address
// upgrade limit with clientIpKey (lib/client-ip-key.ts, legend-6jgd2). Written
// from the card text and the clientIpKey contract, never from the server
// implementation.
//
// Contract under test:
// - two different client addresses (IPv4, or IPv6 in different /64) do not
//   share the upgrade quota;
// - IPv6 addresses inside one /64, however spelled, share one quota;
// - a forged X-Forwarded-For never moves the key when no proxy is trusted
//   (production passes expressClientAddress(app); TRUST_PROXY stays refused,
//   so an app without `trust proxy` is the realistic setup).
//
// No database: real ws on an ephemeral http server, authentication always
// refuses (401), so an upgrade inside its budget answers 401 and an
// over-budget one answers 429.
//
// Assumptions (spec silent):
// - A constant injected clock keeps every upgrade inside one window.
// - To play many client addresses from one process, the `clientAddress` seam
//   returns the value of an `x-test-peer` header (test scaffolding for the
//   socket address). The forged-header cases use the production resolver
//   expressClientAddress(express()) instead.
// - Every upgrade carries a fresh well-formed credential and the per-node and
//   failure-lockout budgets stay out of the way (at most 4 attempts per
//   address, far below the default failure lockout of 10).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import express from "express";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { mintEdgeCredential } from "../edge/credential.ts";
import { createEdgeLinkServer } from "../edge/link-server.ts";
import type { LinkStore } from "../edge/link-peer.ts";
import { expressClientAddress } from "../lib/client-address.ts";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OUTLET_ID = "22222222-2222-4222-8222-222222222222";

// Addresses inside 2001:db8:0:1::/64, spelled differently.
const SAME_64 = [
  "2001:db8:0:1::1",
  "2001:DB8:0:1:aaaa:bbbb:cccc:dddd",
  "2001:0db8:0000:0001::6",
  "2001:db8:0:1:ffff:ffff:ffff:ffff",
] as const;
const OTHER_64 = "2001:db8:0:2::1";

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

function freshCredential() {
  return mintEdgeCredential({
    tenantId: TENANT_ID,
    outletId: OUTLET_ID,
    edgeNodeId: randomUUID(),
  }).token;
}

describe("legend-z2kaf edge link server upgrade limit keys on the client IP key", () => {
  let server: Server | null = null;
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
    if (server?.listening)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function start(
    perAddress: number,
    clientAddress?: Parameters<typeof createEdgeLinkServer>[1]["clientAddress"],
  ): Promise<string> {
    const live = createServer();
    server = live;
    const linkServer = createEdgeLinkServer(live, {
      version: "cloud",
      now: () => 1_000_000,
      upgradeRateLimit: { windowMs: 60_000, perAddress, perNode: 1_000_000 },
      ...(clientAddress ? { clientAddress } : {}),
      authenticate: async () => null,
      isActive: async () => true,
      storeFor: () => emptyStore(),
    });
    close = () => linkServer.close();
    await new Promise<void>((resolve) => live.listen(0, "127.0.0.1", resolve));
    return `ws://127.0.0.1:${(live.address() as AddressInfo).port}/api/edge-link`;
  }

  /** One upgrade attempt; resolves with the HTTP refusal status. */
  function upgrade(
    url: string,
    headers: { peer?: string; forwardedFor?: string } = {},
  ) {
    return new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          authorization: `Bearer ${freshCredential()}`,
          ...(headers.peer !== undefined
            ? { "x-test-peer": headers.peer }
            : {}),
          ...(headers.forwardedFor !== undefined
            ? { "x-forwarded-for": headers.forwardedFor }
            : {}),
        },
      });
      ws.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        ws.terminate();
      });
      ws.on("open", () => {
        resolve(101);
        ws.terminate();
      });
      ws.on("error", () => undefined);
      ws.on("close", () => reject(new Error("closed without a response")));
    });
  }

  /** Test scaffolding: the "socket address" is whatever the header says. */
  const peerHeader: Parameters<typeof start>[1] = (request) =>
    String(request.headers["x-test-peer"] ?? "unknown");

  it("legend-z2kaf two different IPv4 addresses do not share an upgrade quota", async () => {
    const url = await start(2, peerHeader);
    expect(await upgrade(url, { peer: "203.0.113.10" })).toBe(401);
    expect(await upgrade(url, { peer: "203.0.113.10" })).toBe(401);
    expect(await upgrade(url, { peer: "203.0.113.10" })).toBe(429);
    expect(await upgrade(url, { peer: "203.0.113.11" })).toBe(401);
    expect(await upgrade(url, { peer: "203.0.113.11" })).toBe(401);
    expect(await upgrade(url, { peer: "203.0.113.11" })).toBe(429);
  });

  it("legend-z2kaf two IPv6 addresses in different /64 do not share an upgrade quota", async () => {
    const url = await start(2, peerHeader);
    expect(await upgrade(url, { peer: SAME_64[0] })).toBe(401);
    expect(await upgrade(url, { peer: SAME_64[0] })).toBe(401);
    expect(await upgrade(url, { peer: SAME_64[0] })).toBe(429);
    expect(await upgrade(url, { peer: OTHER_64 })).toBe(401);
    expect(await upgrade(url, { peer: OTHER_64 })).toBe(401);
    expect(await upgrade(url, { peer: OTHER_64 })).toBe(429);
  });

  it("legend-z2kaf IPv6 addresses inside one /64 share one upgrade quota", async () => {
    const url = await start(3, peerHeader);
    expect(await upgrade(url, { peer: SAME_64[0] })).toBe(401);
    expect(await upgrade(url, { peer: SAME_64[1] })).toBe(401);
    expect(await upgrade(url, { peer: SAME_64[2] })).toBe(401);
    expect(await upgrade(url, { peer: SAME_64[3] })).toBe(429);
    expect(await upgrade(url, { peer: "2001:db8:0:1::99" })).toBe(429);
  });

  it("legend-z2kaf a forged X-Forwarded-For does not give a client a fresh upgrade quota (default socket address)", async () => {
    // No clientAddress dep: the socket address is the key.
    const url = await start(2);
    expect(await upgrade(url, { forwardedFor: "198.51.100.1" })).toBe(401);
    expect(await upgrade(url, { forwardedFor: "198.51.100.2" })).toBe(401);
    expect(await upgrade(url, { forwardedFor: "198.51.100.3" })).toBe(429);
    expect(await upgrade(url, { forwardedFor: "2001:db8:0:9::1" })).toBe(429);
  });

  it("legend-z2kaf a forged X-Forwarded-For does not move the key when no proxy is trusted (expressClientAddress)", async () => {
    // express() without `trust proxy`, as in production (TRUST_PROXY refused).
    const url = await start(2, expressClientAddress(express()));
    expect(await upgrade(url, { forwardedFor: "198.51.100.1" })).toBe(401);
    expect(await upgrade(url, { forwardedFor: "198.51.100.2" })).toBe(401);
    expect(await upgrade(url, { forwardedFor: "198.51.100.3" })).toBe(429);
    expect(await upgrade(url, { forwardedFor: "2001:db8:0:9::1" })).toBe(429);
  });
});
