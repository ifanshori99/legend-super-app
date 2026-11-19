// Heartbeat compatibility between edge and cloud releases (bead legend-n6mkr,
// hardening 1190 piece D, with the architect addendum). Written from
// docs/briefs/sub-1190-edge-catalog-hardening.md, not from the implementation.
// Fail-first: today the cloud's heartbeat frame is strict and the edge never
// holds `catalogStale` back.
//
// Contract under test:
//  - Cloud: a heartbeat with unknown fields is accepted (unknown fields are
//    stripped, the link stays up). Known fields stay strictly validated
//    (`version`, `occurredAt`, `auditRetentionDisabled`, `catalogStale` and its
//    items). Other frames (hello) are unchanged.
//  - Edge: when the link is closed with code 1008 AND reason "Invalid frame"
//    within 10 seconds of a heartbeat that carried `catalogStale` (an older
//    cloud refusing the field), the edge leaves `catalogStale` out of
//    heartbeats for 1 hour and then probes again. The next connection does not
//    drop again. Any other close does not hold: 1008 with another reason, a
//    close later than 10 seconds, a close after heartbeats without extras.
//
// Assumptions (the brief is silent), each easy to change:
//  - The clock seam is `createEdgeLinkClient({ now })` (epoch ms), which also
//    stamps the hold; the 10 second and 1 hour windows are measured on it.
//  - "Probes again after 1 hour" means the first heartbeat sent at or after
//    1 hour (+1 ms) on that clock carries `catalogStale` again.
//  - Reconnect uses the client's 500 ms floor (`random: () => 0`).
// No database: real ws on ephemeral http servers and an in-memory empty store.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { mintEdgeCredential } from "../edge/credential.ts";
import { createEdgeLinkClient } from "../edge/link-client.ts";
import type { LinkScope, LinkStore } from "../edge/link-peer.ts";
import { createEdgeLinkServer } from "../edge/link-server.ts";
import {
  LINK_CLOSE,
  decodeFrame,
  encodeFrame,
  type CatalogStale,
} from "../edge/protocol.ts";

const scope: LinkScope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};
const HOUR = 60 * 60 * 1000;
const STALE: CatalogStale = [
  {
    stream: "price_lists",
    staleSince: "2026-11-11T03:05:00.000Z",
    reason: "HTTP_500",
  },
];
const base = {
  type: "heartbeat",
  version: "1.0.0",
  occurredAt: "2026-11-11T04:00:00.000Z",
} as const;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("Did not settle");
    await sleep(5);
  }
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
  servers = [];
});
async function listen(created: Server): Promise<string> {
  servers.push(created);
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  return `ws://127.0.0.1:${(created.address() as AddressInfo).port}/api/edge-link`;
}

// ------------------------------------------------------------------ cloud

describe("n6mkr cloud: the heartbeat frame tolerates unknown fields", () => {
  it("decodes a heartbeat with an unknown field, strips it and keeps the known ones", () => {
    const frame = decodeFrame(
      JSON.stringify({ ...base, catalogStale: STALE, futureField: { a: 1 } }),
    );
    expect(frame).not.toBeNull();
    expect(frame).toMatchObject({ ...base, catalogStale: STALE });
    expect(frame).not.toHaveProperty("futureField");
  });

  it.each([
    ["version is not a string", { version: 5 }],
    ["version is empty", { version: "" }],
    ["occurredAt is not a date", { occurredAt: "yesterday" }],
    [
      "auditRetentionDisabled is not a boolean",
      { auditRetentionDisabled: "yes" },
    ],
    ["catalogStale is not an array", { catalogStale: "x" }],
    [
      "a catalogStale item has an unknown field",
      { catalogStale: [{ ...STALE[0], extra: 1 }] },
    ],
    [
      "a catalogStale item has a bad date",
      { catalogStale: [{ ...STALE[0], staleSince: "soon" }] },
    ],
  ])("still refuses a heartbeat when %s", (_label, override) => {
    expect(decodeFrame(JSON.stringify({ ...base, ...override }))).toBeNull();
  });

  it("other frames stay strict: a hello with an unknown field is refused", () => {
    const hello = JSON.parse(
      encodeFrame({ type: "hello", version: "1.0.0", inboundCursor: "0" }),
    );
    expect(decodeFrame(JSON.stringify(hello))).not.toBeNull();
    expect(
      decodeFrame(JSON.stringify({ ...hello, futureField: 1 })),
    ).toBeNull();
  });

  it("a plain heartbeat from an older edge still decodes", () => {
    expect(decodeFrame(JSON.stringify(base))).toEqual(base);
  });
});

describe("n6mkr cloud over a real link: unknown heartbeat fields keep the link up", () => {
  async function startCloud() {
    const { token } = mintEdgeCredential(scope);
    const seen: unknown[] = [];
    const live = createServer();
    const cloud = createEdgeLinkServer(live, {
      version: "cloud",
      authenticate: async (presented) =>
        presented === token ? { scope } : null,
      isActive: async () => true,
      storeFor: () => emptyStore(),
      onHeartbeat: async (_identity, frame) => {
        seen.push(frame);
      },
    });
    const url = await listen(live);
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    const closes: { code: number; reason: string }[] = [];
    socket.on("close", (code, reason) =>
      closes.push({ code, reason: reason.toString("utf8") }),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    socket.send(
      encodeFrame({ type: "hello", version: "1.0.0", inboundCursor: "0" }),
    );
    return { cloud, socket, seen, closes };
  }

  it("a heartbeat with an unknown field reaches the handler without it and the link stays open", async () => {
    const { cloud, socket, seen, closes } = await startCloud();
    socket.send(
      JSON.stringify({ ...base, catalogStale: STALE, futureField: "x" }),
    );
    await until(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ ...base, catalogStale: STALE });
    expect(seen[0]).not.toHaveProperty("futureField");
    await sleep(150);
    expect(closes).toEqual([]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
    await cloud.close();
  });

  it("a heartbeat with a known field of the wrong type closes 1008 Invalid frame", async () => {
    const { cloud, socket, seen, closes } = await startCloud();
    socket.send(JSON.stringify({ ...base, version: 5, futureField: "x" }));
    await until(() => closes.length === 1);
    expect(closes[0]).toEqual({
      code: LINK_CLOSE.protocol,
      reason: "Invalid frame",
    });
    expect(seen).toEqual([]);
    await cloud.close();
  });
});

// ------------------------------------------------------------------- edge

type Beat = { conn: number; stale: boolean; raw: Record<string, unknown> };

/**
 * An "older cloud": records every heartbeat per connection and closes the
 * link as `rule` says (1008 with a reason, like the strict frame did).
 */
async function olderCloud(
  rule: (beat: Beat) => { code: number; reason: string } | null,
) {
  const beats: Beat[] = [];
  let connections = 0;
  const sockets: WebSocket[] = [];
  const created = createServer();
  const wss = new WebSocketServer({ server: created });
  wss.on("connection", (ws) => {
    connections += 1;
    const conn = connections;
    sockets.push(ws);
    ws.on("message", (data) => {
      const raw = JSON.parse(data.toString()) as Record<string, unknown>;
      if (raw.type !== "heartbeat") return;
      const beat: Beat = { conn, stale: "catalogStale" in raw, raw };
      beats.push(beat);
      const close = rule(beat);
      if (close) ws.close(close.code, close.reason);
    });
  });
  const url = await listen(created);
  return {
    url,
    beats,
    connections: () => connections,
    closeAll: (code: number, reason: string) =>
      sockets.forEach((ws) => ws.close(code, reason)),
  };
}

function edgeClient(
  url: string,
  options: {
    clock: { now: number };
    stale: () => CatalogStale;
    heartbeatIntervalMs?: number;
  },
) {
  return createEdgeLinkClient({
    url,
    credential: "edg1.x",
    scope,
    store: emptyStore(),
    version: "1.0.0",
    random: () => 0, // 500 ms floor between attempts
    ackTimeoutMs: 60_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 25,
    catalogStale: options.stale,
    now: () => options.clock.now,
  });
}

const refuseStale = (beat: Beat) =>
  beat.stale ? { code: LINK_CLOSE.protocol, reason: "Invalid frame" } : null;

describe("n6mkr edge: holds catalogStale back from a cloud that refuses it", () => {
  it("after 1008 Invalid frame within 10 seconds the next connection sends no catalogStale and the link stays up", async () => {
    const clock = { now: 1_000_000 };
    const cloud = await olderCloud(refuseStale);
    const client = edgeClient(cloud.url, { clock, stale: () => STALE });

    await until(() => cloud.connections() >= 2);
    await until(() => cloud.beats.filter((b) => b.conn === 2).length >= 3);
    expect(cloud.beats[0]).toMatchObject({ conn: 1, stale: true });
    expect(
      cloud.beats.filter((b) => b.conn === 2).every((b) => !b.stale),
      "the second connection carries no catalogStale",
    ).toBe(true);
    await sleep(700); // longer than the 500 ms reconnect floor
    expect(cloud.connections(), "no connect/disconnect loop").toBe(2);
    expect(client.state().cloudLink).toBe("connected");
    await client.stop();
  }, 30_000);

  it("keeps the other heartbeat fields while held", async () => {
    const clock = { now: 1_000_000 };
    const cloud = await olderCloud(refuseStale);
    const client = edgeClient(cloud.url, { clock, stale: () => STALE });
    await until(() => cloud.beats.filter((b) => b.conn === 2).length >= 1);
    expect(cloud.beats.find((b) => b.conn === 2)?.raw).toMatchObject({
      type: "heartbeat",
      version: "1.0.0",
    });
    await client.stop();
  }, 30_000);

  it("sends catalogStale again after one hour", async () => {
    const clock = { now: 1_000_000 };
    const cloud = await olderCloud(refuseStale);
    const client = edgeClient(cloud.url, { clock, stale: () => STALE });
    await until(() => cloud.beats.filter((b) => b.conn === 2).length >= 2);

    clock.now += HOUR - 1; // still held
    const held = cloud.beats.length;
    await until(() => cloud.beats.length >= held + 3);
    expect(cloud.beats.slice(held).every((b) => !b.stale)).toBe(true);

    clock.now += 2; // an hour has passed
    await until(() => cloud.beats.some((b, i) => i >= held && b.stale));
    await client.stop();
  }, 30_000);

  it("1008 with another reason does not hold: the next connection still sends catalogStale", async () => {
    const clock = { now: 1_000_000 };
    const cloud = await olderCloud((beat) =>
      beat.conn === 1
        ? { code: LINK_CLOSE.protocol, reason: "Frame too large" }
        : null,
    );
    const client = edgeClient(cloud.url, {
      clock,
      stale: () => STALE,
      heartbeatIntervalMs: 600_000,
    });
    await until(() => cloud.beats.some((b) => b.conn === 2));
    expect(cloud.beats.find((b) => b.conn === 2)?.stale).toBe(true);
    await client.stop();
  }, 30_000);

  it("a close later than 10 seconds after the heartbeat does not hold", async () => {
    const clock = { now: 1_000_000 };
    const cloud = await olderCloud(() => null);
    const client = edgeClient(cloud.url, {
      clock,
      stale: () => STALE,
      heartbeatIntervalMs: 600_000, // only the heartbeat sent on open
    });
    await until(() => cloud.beats.length === 1);
    clock.now += 11_000;
    cloud.closeAll(LINK_CLOSE.protocol, "Invalid frame");
    await until(() => cloud.beats.some((b) => b.conn === 2));
    expect(cloud.beats.find((b) => b.conn === 2)?.stale).toBe(true);
    await client.stop();
  }, 30_000);

  it("a 1008 Invalid frame after heartbeats without catalogStale changes nothing", async () => {
    const clock = { now: 1_000_000 };
    let stale: CatalogStale = [];
    const cloud = await olderCloud((beat) =>
      beat.conn === 1
        ? { code: LINK_CLOSE.protocol, reason: "Invalid frame" }
        : null,
    );
    const client = edgeClient(cloud.url, { clock, stale: () => stale });
    await until(() => cloud.connections() >= 2);
    expect(cloud.beats[0]).toMatchObject({ conn: 1, stale: false });
    // The alarm starts later: it is sent at once, not held for an hour.
    stale = STALE;
    await until(() => cloud.beats.some((b) => b.conn === 2 && b.stale));
    await client.stop();
  }, 30_000);
});
