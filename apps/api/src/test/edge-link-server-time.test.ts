// 533 A2: the edge link client reads the cloud's HTTP `Date` header from the
// websocket upgrade response and hands it to a new option
//   onServerTime?: (serverTime: Date) => void
// (the trusted clock uses it to prove elapsed time after an offline restart).
// Link frames carry no server time, so the header is the only source.
// Assumptions: called once per successful upgrade (101), with the header parsed
// to a Date (HTTP dates have 1 second precision); never called for a missing or
// unparseable header; a throwing callback must not break the link.
// 533b P3: the Date header is stored when the upgrade response arrives but only
// delivered to onServerTime once the websocket is actually open, so an upgrade
// that the client then rejects (here: a wrong Sec-WebSocket-Accept) never feeds
// the trusted clock.
// No database: a real ws server on an ephemeral port, an in-memory empty store.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createEdgeLinkClient } from "../edge/link-client.ts";
import type { LinkScope, LinkStore } from "../edge/link-peer.ts";

const scope: LinkScope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};

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

describe("533 A2 link client reports the cloud's server time", () => {
  let http: Server | undefined;
  let wss: WebSocketServer | undefined;
  let stop: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    wss?.close();
    wss = undefined;
    http?.closeAllConnections();
    await new Promise<void>((resolve) =>
      http ? http.close(() => resolve()) : resolve(),
    );
    http = undefined;
  });

  /** A cloud stand-in whose upgrade response carries `dateHeader` (or none). */
  async function cloud(dateHeader: string | null) {
    http = createServer();
    wss = new WebSocketServer({ server: http });
    wss.on("headers", (headers) => {
      // ws writes the 101 response itself, so add the header a proxy would.
      for (let i = headers.length - 1; i >= 0; i -= 1)
        if (/^date:/i.test(headers[i]!)) headers.splice(i, 1);
      if (dateHeader !== null) headers.push(`Date: ${dateHeader}`);
    });
    wss.on("connection", () => undefined);
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as AddressInfo).port;
    return `ws://127.0.0.1:${port}/api/edge-link`;
  }

  function connect(
    url: string,
    onServerTime: (serverTime: Date) => void,
    extra: { random?: () => number } = {},
  ) {
    const client = createEdgeLinkClient({
      url,
      credential: "edg1.x",
      scope,
      store: emptyStore(),
      version: "edge",
      onServerTime,
      ...extra,
    } as Parameters<typeof createEdgeLinkClient>[0]);
    stop = () => client.stop();
    return client;
  }

  it("calls onServerTime with the Date header once the link is upgraded", async () => {
    const serverTime = new Date("2026-11-11T03:05:07.000Z");
    const url = await cloud(serverTime.toUTCString());
    const seen: Date[] = [];
    connect(url, (date) => seen.push(date));
    await settle(() => seen.length >= 1);
    expect(seen[0]).toBeInstanceOf(Date);
    expect(seen[0]!.getTime()).toBe(serverTime.getTime());
  });

  it("reports again after the link reconnects", async () => {
    const url = await cloud(new Date("2026-11-11T03:05:07.000Z").toUTCString());
    const seen: Date[] = [];
    connect(url, (date) => seen.push(date), { random: () => 0 });
    await settle(() => seen.length >= 1);
    // Drop every open socket from the cloud side; the client must reconnect.
    for (const socket of wss!.clients) socket.terminate();
    await settle(() => seen.length >= 2, 6000);
  });

  it("does not call onServerTime when the response has no Date header", async () => {
    const url = await cloud(null);
    const seen: Date[] = [];
    const client = connect(url, (date) => seen.push(date));
    await settle(() => client.state().cloudLink !== "disconnected");
    await sleep(150);
    expect(seen).toEqual([]);
  });

  it("does not call onServerTime for an unparseable Date header", async () => {
    const url = await cloud("not a date");
    const seen: Date[] = [];
    const client = connect(url, (date) => seen.push(date));
    await settle(() => client.state().cloudLink !== "disconnected");
    await sleep(150);
    expect(seen).toEqual([]);
  });

  it("keeps the link up when the onServerTime callback throws", async () => {
    const url = await cloud(new Date("2026-11-11T03:05:07.000Z").toUTCString());
    let calls = 0;
    const client = connect(url, () => {
      calls += 1;
      throw new Error("clock sink failed");
    });
    await settle(() => calls >= 1);
    await settle(() => client.state().cloudLink === "connected");
    expect(client.state().refused).toBe(false);
  });

  it("does not call onServerTime when the upgrade response arrives but the handshake never opens", async () => {
    http = createServer();
    http.on("upgrade", (_request, socket) => {
      // A 101 with a Date header but an invalid Sec-WebSocket-Accept: the client
      // sees the upgrade, then refuses the handshake, so `open` never fires.
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Accept: not-the-right-accept-value",
          `Date: ${new Date("2026-11-11T03:05:07.000Z").toUTCString()}`,
          "",
          "",
        ].join("\r\n"),
      );
      socket.destroy();
    });
    await new Promise<void>((resolve) => http!.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as AddressInfo).port;
    const seen: Date[] = [];
    const client = connect(
      `ws://127.0.0.1:${port}/api/edge-link`,
      (date) => seen.push(date),
      { random: () => 0 },
    );
    expect(client.state().cloudLink).not.toBe("connected");
    await sleep(400);
    expect(seen).toEqual([]);
    expect(client.state().cloudLink).not.toBe("connected");
  });

  it("still delivers the stored Date value when the socket opens normally, once per open", async () => {
    const serverTime = new Date("2026-11-11T03:05:07.000Z");
    const url = await cloud(serverTime.toUTCString());
    const seen: Date[] = [];
    const client = connect(url, (date) => seen.push(date));
    await settle(() => client.state().cloudLink === "connected");
    await settle(() => seen.length >= 1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.getTime()).toBe(serverTime.getTime());
  });
});
