// EDG-01 foundation (bead legend-2pi): the cloud <-> edge link protocol,
// offline queue drain, conflict rules, credential, edge settings and the
// EDGE_MODE route split. Pure unit tests: an in-memory LinkStore that follows
// the Postgres store's rules and an in-memory transport that can drop,
// duplicate and disconnect. No database (the Postgres store, RLS and
// registry are covered by edge-db.test.ts).
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import type { EventEnvelope, SyncDirection } from "@starter/shared/events";
import { decideInbound, queueOrderViolation } from "../edge/conflict.ts";
import {
  bearerToken,
  edgeCredentialMatches,
  mintEdgeCredential,
  parseEdgeCredential,
} from "../edge/credential.ts";
import { parseEdgeRuntimeConfig } from "../edge/config.ts";
import {
  createLinkPeer,
  type LinkPeer,
  type LinkScope,
  type LinkStore,
  type QueuedEdgeEvent,
} from "../edge/link-peer.ts";
import { createEdgeLinkClient, reconnectDelayMs } from "../edge/link-client.ts";
import {
  createEdgeLinkServer,
  type EdgeLinkIdentity,
} from "../edge/link-server.ts";
import { classifyApiPath, edgeRouteGuard } from "../edge/mode.ts";
import { decodeFrame, oppositeDirection } from "../edge/protocol.ts";
import type { EdgeEventKind } from "../db/schema/edge-node.ts";

const scope: LinkScope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};

let clock = Date.parse("2026-11-03T10:00:00.000Z");
function event(
  sequence: number,
  aggregateId = "44444444-4444-4444-8444-444444444444",
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: scope.tenantId as EventEnvelope["tenantId"],
    outletId: scope.outletId as EventEnvelope["outletId"],
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `key-${clock}-${sequence}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: {},
    ...overrides,
  };
}

describe("cloud-to-edge frame compatibility", () => {
  it("strips future frame, batch, envelope, and actor fields only at the edge", () => {
    const original = event(1);
    const frame = {
      type: "batch",
      futureFrame: true,
      batch: {
        tenantId: scope.tenantId,
        outletId: scope.outletId,
        id: createUlid(),
        peerId: scope.edgeNodeId,
        direction: "cloud_to_edge",
        fromCursor: "0",
        toCursor: "1",
        futureBatch: true,
        events: [
          {
            ...original,
            futureEnvelope: true,
            actor: { ...original.actor, futureActor: true },
          },
        ],
      },
    };
    const parsed = decodeFrame(JSON.stringify(frame), true);
    expect(parsed).toEqual({
      type: "batch",
      batch: {
        tenantId: scope.tenantId,
        outletId: scope.outletId,
        id: frame.batch.id,
        peerId: scope.edgeNodeId,
        direction: "cloud_to_edge",
        fromCursor: "0",
        toCursor: "1",
        events: [original],
      },
    });
    expect(decodeFrame(JSON.stringify(frame))).toBeNull();
    expect(
      decodeFrame(
        JSON.stringify({
          ...frame,
          batch: { ...frame.batch, events: [{ ...original, sequence: "1" }] },
        }),
        true,
      ),
    ).toBeNull();
  });
});

/** Same rules as db-link-store.ts, kept in memory. */
class MemoryStore implements LinkStore {
  queue: { linkSeq: number; event: EventEnvelope; kind: EdgeEventKind }[] = [];
  acked = 0;
  received = 0;
  receipts = new Map<string, "applied" | "superseded" | "conflict">();
  conflicts: { eventId: string; reason: string }[] = [];
  applied: EventEnvelope[] = [];
  failApply = 0;
  constructor(
    readonly outbound: SyncDirection,
    readonly classify: (event: EventEnvelope) => EdgeEventKind = () =>
      "transaction_event",
  ) {}
  enqueue(item: EventEnvelope, kind: EdgeEventKind = "transaction_event") {
    if (this.queue.some((q) => q.event.id === item.id)) return;
    const queued = this.queue.filter(
      (q) =>
        q.event.aggregateType === item.aggregateType &&
        q.event.aggregateId === item.aggregateId,
    );
    const violation = queueOrderViolation({
      kind,
      direction: this.outbound,
      lastQueued: queued.length
        ? Math.max(...queued.map((q) => q.event.sequence))
        : null,
      sequence: item.sequence,
    });
    if (violation) throw new Error(violation);
    this.queue.push({ linkSeq: this.queue.length + 1, event: item, kind });
  }
  async outboundHead() {
    return this.queue.length;
  }
  async lastAckedOutbound() {
    return this.acked;
  }
  async readOutbound(after: number, limit: number): Promise<QueuedEdgeEvent[]> {
    return this.queue
      .filter((q) => q.linkSeq > after)
      .slice(0, limit)
      .map(({ linkSeq, event }) => ({ linkSeq, event }));
  }
  async ackOutbound(upto: number) {
    if (upto > this.queue.length) throw new Error("beyond queue");
    this.acked = Math.max(this.acked, upto);
  }
  async lastReceivedInbound() {
    return this.received;
  }
  async applyInbound(input: {
    fromSeq: number;
    toSeq: number;
    events: readonly QueuedEdgeEvent[];
  }) {
    if (input.fromSeq !== this.received) throw new Error("cursor moved");
    if (this.failApply > 0) {
      this.failApply -= 1;
      throw new Error("applier unavailable");
    }
    const receipts = new Map(this.receipts);
    const applied: EventEnvelope[] = [];
    const conflicts: { eventId: string; reason: string }[] = [];
    const direction = oppositeDirection(this.outbound);
    for (const { event: item } of input.events) {
      const kind = this.classify(item);
      const last = Math.max(
        0,
        ...[...this.applied, ...applied]
          .filter(
            (a) =>
              a.aggregateType === item.aggregateType &&
              a.aggregateId === item.aggregateId,
          )
          .map((a) => a.sequence),
      );
      const decision = decideInbound({
        direction,
        kind,
        alreadyReceived: receipts.has(item.id),
        lastSequence: last,
        event: item,
      });
      if (decision.action === "skip" && decision.reason === "already_received")
        continue;
      if (decision.action === "apply") {
        applied.push(item);
        receipts.set(item.id, "applied");
      } else if (decision.action === "skip")
        receipts.set(item.id, "superseded");
      else {
        conflicts.push({ eventId: item.id, reason: decision.reason });
        receipts.set(item.id, "conflict");
      }
    }
    // Commit atomically.
    this.receipts = receipts;
    this.applied.push(...applied);
    this.conflicts.push(...conflicts);
    this.received = input.toSeq;
  }
}

/** Two connected in-memory transports with fault injection. */
function connect(
  cloud: MemoryStore,
  edge: MemoryStore,
  faults: {
    dropToEdge?: (frame: string, index: number) => boolean;
    dropToCloud?: (frame: string, index: number) => boolean;
    duplicate?: boolean;
  } = {},
) {
  let open = true;
  const sent = { toEdge: 0, toCloud: 0 };
  const closes: number[] = [];
  const peers = {} as { cloud: LinkPeer; edge: LinkPeer };
  const deliver = (target: () => LinkPeer, data: string) => {
    queueMicrotask(() => {
      if (!open) return;
      target().receive(data);
      if (faults.duplicate) target().receive(data);
    });
  };
  peers.cloud = createLinkPeer({
    scope,
    outboundDirection: "cloud_to_edge",
    store: cloud,
    version: "cloud-test",
    ackTimeoutMs: 20,
    transport: {
      send: (data) => {
        const index = sent.toEdge++;
        if (faults.dropToEdge?.(data, index)) return;
        deliver(() => peers.edge, data);
      },
      close: (code) => {
        closes.push(code);
        open = false;
      },
    },
  });
  peers.edge = createLinkPeer({
    scope,
    outboundDirection: "edge_to_cloud",
    store: edge,
    version: "edge-test",
    ackTimeoutMs: 20,
    transport: {
      send: (data) => {
        const index = sent.toCloud++;
        if (faults.dropToCloud?.(data, index)) return;
        deliver(() => peers.cloud, data);
      },
      close: (code) => {
        closes.push(code);
        open = false;
      },
    },
  });
  peers.cloud.start();
  peers.edge.start();
  return {
    cloudPeer: peers.cloud,
    edgePeer: peers.edge,
    closes,
    disconnect() {
      open = false;
      peers.cloud.stop();
      peers.edge.stop();
    },
  };
}

async function settle(until: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!until()) {
    if (Date.now() > end) throw new Error("Link did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const isBatch = (frame: string) => decodeFrame(frame)?.type === "batch";

describe("EDG-01 edge link resync (in-memory transport)", () => {
  it("EDG-01 delivers both directions in order, exactly once, and acks", async () => {
    const cloud = new MemoryStore("cloud_to_edge");
    const edge = new MemoryStore("edge_to_cloud");
    for (let i = 1; i <= 5; i++) edge.enqueue(event(i));
    cloud.enqueue(event(1, randomUUID()));
    const link = connect(cloud, edge);
    await settle(() => edge.acked === 5 && cloud.acked === 1);
    expect(cloud.applied.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(edge.applied).toHaveLength(1);
    expect(cloud.received).toBe(5);
    link.disconnect();
  });

  it("EDG-01 offline queue is durable and drains on reconnect, ordered per aggregate", async () => {
    const cloud = new MemoryStore("cloud_to_edge");
    const edge = new MemoryStore("edge_to_cloud");
    edge.enqueue(event(1));
    const first = connect(cloud, edge);
    await settle(() => edge.acked === 1);
    first.disconnect();
    // Internet down: the edge keeps writing (§4 Alur F).
    const other = randomUUID();
    for (let i = 2; i <= 150; i++) edge.enqueue(event(i));
    for (let i = 1; i <= 30; i++) edge.enqueue(event(i, other));
    expect(edge.acked).toBe(1);
    const second = connect(cloud, edge);
    await settle(() => edge.acked === 180);
    const order = cloud.applied.filter((e) => e.aggregateId !== other);
    expect(order.map((e) => e.sequence)).toEqual(
      Array.from({ length: 150 }, (_, i) => i + 1),
    );
    expect(cloud.applied.filter((e) => e.aggregateId === other)).toHaveLength(
      30,
    );
    expect(cloud.conflicts).toEqual([]);
    second.disconnect();
  });

  it("EDG-01 a lost batch is resent after the ack timeout with no loss and no duplicate", async () => {
    const cloud = new MemoryStore("cloud_to_edge");
    const edge = new MemoryStore("edge_to_cloud");
    for (let i = 1; i <= 3; i++) edge.enqueue(event(i));
    let dropped = false;
    const link = connect(cloud, edge, {
      dropToCloud: (frame) => {
        if (!dropped && isBatch(frame)) return (dropped = true);
        return false;
      },
    });
    await settle(() => edge.acked === 3);
    expect(dropped).toBe(true);
    expect(cloud.applied.map((e) => e.sequence)).toEqual([1, 2, 3]);
    link.disconnect();
  });

  it("EDG-01 lost acks and duplicated frames never apply an event twice", async () => {
    const cloud = new MemoryStore("cloud_to_edge");
    const edge = new MemoryStore("edge_to_cloud");
    for (let i = 1; i <= 4; i++) edge.enqueue(event(i));
    let ackDrops = 2;
    const link = connect(cloud, edge, {
      duplicate: true,
      dropToEdge: (frame) =>
        decodeFrame(frame)?.type === "ack" && ackDrops-- > 0,
    });
    await settle(() => edge.acked === 4);
    expect(cloud.applied.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(cloud.receipts.size).toBe(4);
    link.disconnect();
  });

  it("EDG-01 a receiver gap asks for a resend from its cursor", async () => {
    const cloud = new MemoryStore("cloud_to_edge");
    const sent: string[] = [];
    const probe = createLinkPeer({
      scope,
      outboundDirection: "cloud_to_edge",
      store: cloud,
      version: "probe",
      transport: { send: (data) => sent.push(data), close: () => {} },
    });
    probe.receive(
      JSON.stringify({ type: "hello", version: "edge", inboundCursor: "0" }),
    );
    // A batch that starts beyond the cloud's cursor: the first one was lost.
    probe.receive(
      JSON.stringify({
        type: "batch",
        batch: {
          tenantId: scope.tenantId,
          outletId: scope.outletId,
          id: createUlid(),
          peerId: scope.edgeNodeId,
          direction: "edge_to_cloud",
          fromCursor: "1",
          toCursor: "3",
          events: [event(2), event(3)],
        },
      }),
    );
    await probe.idle();
    const resend = sent
      .map((raw) => decodeFrame(raw))
      .find((f) => f?.type === "resend");
    expect(resend).toEqual({
      type: "resend",
      direction: "edge_to_cloud",
      fromCursor: "0",
    });
    expect(cloud.applied).toEqual([]);
    expect(cloud.received).toBe(0);
  });

  it("EDG-01 a failing applier acknowledges nothing and the batch is retried", async () => {
    const cloud = new MemoryStore("cloud_to_edge");
    const edge = new MemoryStore("edge_to_cloud");
    cloud.failApply = 2;
    edge.enqueue(event(1));
    edge.enqueue(event(2));
    const link = connect(cloud, edge);
    await settle(() => edge.acked === 2);
    expect(cloud.applied.map((e) => e.sequence)).toEqual([1, 2]);
    link.disconnect();
  });

  it("EDG-01 refuses to resume when the peer cursor is ahead of the queue (restored snapshot)", async () => {
    const cloud = new MemoryStore("cloud_to_edge");
    const edge = new MemoryStore("edge_to_cloud");
    cloud.received = 7; // cloud holds more than the edge ever queued
    edge.enqueue(event(1));
    const link = connect(cloud, edge);
    await settle(() => link.closes.length > 0);
    expect(link.closes).toContain(1008);
    expect(cloud.applied).toEqual([]);
  });

  it("EDG-01 a frame outside the link scope closes the connection", async () => {
    const store = new MemoryStore("cloud_to_edge");
    const closes: number[] = [];
    const peer = createLinkPeer({
      scope,
      outboundDirection: "cloud_to_edge",
      store,
      version: "t",
      transport: { send: () => {}, close: (code) => closes.push(code) },
    });
    peer.receive(
      JSON.stringify({ type: "hello", version: "e", inboundCursor: "0" }),
    );
    peer.receive(
      JSON.stringify({
        type: "batch",
        batch: {
          tenantId: randomUUID(),
          outletId: scope.outletId,
          id: createUlid(),
          peerId: scope.edgeNodeId,
          direction: "edge_to_cloud",
          fromCursor: "0",
          toCursor: "1",
          events: [{ ...event(1) }],
        },
      }),
    );
    await peer.idle();
    expect(closes).toEqual([1008]);
    peer.receive("not json");
    expect(store.applied).toEqual([]);
  });
});

describe("EDG-01 conflict rules (PRD §3 F5: cloud wins master data, transactions never overwritten)", () => {
  it("EDG-01 master data from an edge is refused, cloud wins", () => {
    expect(
      decideInbound({
        direction: "edge_to_cloud",
        kind: "master_data",
        alreadyReceived: false,
        lastSequence: 0,
        event: { sequence: 1 },
      }),
    ).toEqual({
      action: "conflict",
      reason: "edge_master_data",
      resolution: "cloud_wins",
    });
  });

  it("EDG-01 newer master data applies across a gap, older is superseded", () => {
    const base = {
      direction: "cloud_to_edge" as const,
      kind: "master_data" as const,
      alreadyReceived: false,
      lastSequence: 4,
    };
    expect(decideInbound({ ...base, event: { sequence: 9 } })).toEqual({
      action: "apply",
    });
    expect(decideInbound({ ...base, event: { sequence: 4 } })).toEqual({
      action: "skip",
      reason: "superseded",
    });
  });

  it("EDG-01 transaction sequence collisions and gaps are recorded, never applied", () => {
    const base = {
      direction: "edge_to_cloud" as const,
      kind: "transaction_event" as const,
      alreadyReceived: false,
      lastSequence: 3,
    };
    expect(decideInbound({ ...base, event: { sequence: 4 } })).toEqual({
      action: "apply",
    });
    expect(decideInbound({ ...base, event: { sequence: 3 } })).toMatchObject({
      action: "conflict",
      reason: "sequence_collision",
      resolution: "append_only",
    });
    expect(decideInbound({ ...base, event: { sequence: 6 } })).toMatchObject({
      action: "conflict",
      reason: "sequence_gap",
    });
    expect(
      decideInbound({ ...base, alreadyReceived: true, event: { sequence: 4 } }),
    ).toEqual({ action: "skip", reason: "already_received" });
  });

  it("EDG-01 the offline queue enforces per-aggregate order and master data direction", () => {
    const edge = new MemoryStore("edge_to_cloud");
    edge.enqueue(event(1));
    expect(() => edge.enqueue(event(3))).toThrow(/aggregate sequence order/);
    expect(() => edge.enqueue(event(1, randomUUID()), "master_data")).toThrow(
      /owned by the cloud/,
    );
    expect(
      queueOrderViolation({
        kind: "master_data",
        direction: "cloud_to_edge",
        lastQueued: 2,
        sequence: 5,
      }),
    ).toBeNull();
  });

  it("EDG-01 recorded conflicts keep the event (no loss) and the link moves on", async () => {
    const cloud = new MemoryStore("cloud_to_edge");
    const edge = new MemoryStore("edge_to_cloud");
    cloud.applied.push(event(1)); // cloud already holds seq 1 of this order
    const collision = event(1);
    edge.enqueue(collision);
    edge.enqueue(event(2));
    const link = connect(cloud, edge);
    await settle(() => edge.acked === 2);
    expect(cloud.conflicts).toEqual([
      { eventId: collision.id, reason: "sequence_collision" },
    ]);
    expect(cloud.applied.map((e) => e.sequence)).toEqual([1, 2]);
    link.disconnect();
  });
});

describe("EDG-01 credential, settings and reconnect", () => {
  it("EDG-01 credential is bound to tenant, outlet and node and only its digest is stored", () => {
    const { token, hash } = mintEdgeCredential(scope);
    expect(token).not.toContain(hash);
    const parsed = parseEdgeCredential(token);
    expect(parsed).toMatchObject(scope);
    expect(edgeCredentialMatches(parsed!.hash, hash)).toBe(true);
    const otherNode = token.replace(scope.edgeNodeId, randomUUID());
    expect(
      edgeCredentialMatches(parseEdgeCredential(otherNode)!.hash, hash),
    ).toBe(false);
    expect(parseEdgeCredential("edg1.bad")).toBeNull();
    expect(parseEdgeCredential(`${token}x`)).toBeNull();
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(token)).toBeNull();
  });

  it("EDG-01 edge settings require a wss cloud URL and a valid credential", () => {
    const { token } = mintEdgeCredential(scope);
    expect(parseEdgeRuntimeConfig({})).toEqual({
      ok: true,
      config: { edgeMode: false },
    });
    const bad = parseEdgeRuntimeConfig({
      EDGE_MODE: "true",
      DEPLOYMENT_MODE: "production",
      EDGE_CLOUD_URL: "ws://cloud.example.com/api/edge-link",
      EDGE_NODE_CREDENTIAL: "secret-value-that-must-not-echo",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problems.join("\n")).toMatch(/EDGE_CLOUD_URL/);
      expect(bad.problems.join("\n")).toMatch(/EDGE_NODE_CREDENTIAL/);
      expect(bad.problems.join("\n")).not.toContain("secret-value");
    }
    const good = parseEdgeRuntimeConfig({
      EDGE_MODE: "true",
      DEPLOYMENT_MODE: "production",
      DATA_CLASSIFICATION: "real",
      EDGE_CLOUD_URL: "wss://cloud.example.com/api/edge-link",
      EDGE_NODE_CREDENTIAL: token,
      EDGE_NODE_ROLE: "standby",
    });
    expect(good).toMatchObject({
      ok: true,
      config: { edgeMode: true, role: "standby", version: "dev" },
    });
  });

  it("EDG-01 reconnect backoff is exponential, jittered and capped", () => {
    expect(reconnectDelayMs(0, () => 0.999)).toBeLessThanOrEqual(1000);
    expect(reconnectDelayMs(3, () => 0.999)).toBeLessThanOrEqual(8000);
    expect(reconnectDelayMs(30, () => 0.999)).toBeLessThanOrEqual(30_000);
    expect(reconnectDelayMs(30, () => 0)).toBeGreaterThanOrEqual(500);
  });
});

describe("EDG-01 EDGE_MODE route split", () => {
  function app(edgeMode: boolean) {
    const server = express();
    server.use(edgeRouteGuard({ edgeMode }));
    server.use((_req, res) => {
      res.json({ ok: true });
    });
    server.use(
      (
        error: { status?: number; code?: string },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        void _next;
        res.status(error.status ?? 500).json({ code: error.code });
      },
    );
    return server;
  }

  it("EDG-01 classifies paths on segment boundaries", () => {
    expect(classifyApiPath("/api/edge/status")).toBe("edge_only");
    expect(classifyApiPath("/api/edge-nodes")).toBe("cloud_only");
    expect(classifyApiPath("/api/edge-sync/staff-pin-records")).toBe(
      "cloud_only",
    );
    expect(classifyApiPath("/api/table-sessions/x")).toBe("edge_and_cloud");
    expect(classifyApiPath("/api/platform/tenants")).toBe("cloud_only");
  });

  it("EDG-01 the cloud refuses edge-only routes", async () => {
    const res = await request(app(false)).get("/api/edge/status");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("EDGE_ONLY_ROUTE");
    expect((await request(app(false)).get("/api/edge-nodes")).status).toBe(200);
  });

  it("EDG-01 the edge refuses cloud-only routes and serves operational ones", async () => {
    const edge = app(true);
    const platform = await request(edge).get("/api/platform/tenants");
    expect(platform.status).toBe(404);
    expect(platform.body.code).toBe("CLOUD_ONLY_ROUTE");
    expect((await request(edge).get("/api/webhooks/whatsapp")).status).toBe(
      404,
    );
    expect((await request(edge).get("/api/edge/status")).status).toBe(200);
    expect((await request(edge).get("/api/table-sessions/abc")).status).toBe(
      200,
    );
    expect((await request(edge).get("/pos")).status).toBe(200);
  });

  it("EDG-01 an absolute-form request target cannot skip the route split", async () => {
    // GET http://edge/api/platform/tenants HTTP/1.1: Express still routes the
    // pathname, so the guard must refuse it instead of passing it on.
    const httpServer = createServer(app(true));
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    try {
      const port = (httpServer.address() as AddressInfo).port;
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "GET",
            path: "http://edge.invalid/api/platform/tenants",
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(400);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    // Case and duplicate slashes are normalised before the prefix check.
    const edge = app(true);
    expect((await request(edge).get("/API/Platform/tenants")).status).toBe(404);
    expect((await request(edge).get("/api//platform/tenants")).status).toBe(
      404,
    );
  });
});

describe("EDG-01 WebSocket link (real ws, in-memory stores)", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) =>
      server ? server.close(() => resolve()) : resolve(),
    );
    server = undefined;
  });

  it("EDG-01 authenticates the edge, syncs both ways, and stops on revocation", async () => {
    const { token } = mintEdgeCredential(scope);
    const cloud = new MemoryStore("cloud_to_edge");
    const edge = new MemoryStore("edge_to_cloud");
    cloud.enqueue(event(1, randomUUID()));
    edge.enqueue(event(1));
    let active = true;
    server = createServer();
    const linkServer = createEdgeLinkServer(server, {
      version: "cloud",
      reverifyIntervalMs: 50,
      authenticate: async (presented) =>
        presented === token ? { scope } : null,
      isActive: async () => active,
      storeFor: () => cloud,
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}/api/edge-link`;

    const refused = createEdgeLinkClient({
      url,
      credential: "edg1.wrong",
      scope,
      store: new MemoryStore("edge_to_cloud"),
      version: "edge",
    });
    await settle(() => refused.state().refused);
    await refused.stop();

    const client = createEdgeLinkClient({
      url,
      credential: token,
      scope,
      store: edge,
      version: "edge",
      ackTimeoutMs: 50,
    });
    await settle(() => edge.acked === 1 && cloud.acked === 1);
    expect(client.state().cloudLink).toBe("connected");
    expect(linkServer.isConnected(scope.edgeNodeId)).toBe(true);
    edge.enqueue(event(2));
    client.notify();
    await settle(() => edge.acked === 2);
    expect(cloud.applied.map((e) => e.sequence)).toEqual([1, 2]);

    active = false; // EDG-03: revoked on the cloud
    await settle(() => client.state().refused);
    expect(client.state().cloudLink).toBe("disconnected");
    await client.stop();
    await linkServer.close();
  });

  it("legend-o839h sends the instance id header and the cloud carries it on the identity; missing or invalid means null", async () => {
    const { token } = mintEdgeCredential(scope);
    const seen: (string | null | undefined)[] = [];
    server = createServer();
    const linkServer = createEdgeLinkServer<EdgeLinkIdentity>(server, {
      version: "cloud",
      authenticate: async (presented) =>
        presented === token ? { scope } : null,
      isActive: async () => true,
      storeFor: (identity) => {
        seen.push(identity.edgeInstanceId);
        return new MemoryStore("cloud_to_edge");
      },
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const url = `ws://127.0.0.1:${port}/api/edge-link`;
    const connect = async (instanceId?: string | null) => {
      const client = createEdgeLinkClient({
        url,
        credential: token,
        instanceId,
        scope,
        store: new MemoryStore("edge_to_cloud"),
        version: "edge",
      });
      await settle(() => client.state().cloudLink === "connected");
      expect(client.state().refused).toBe(false);
      await client.stop();
      await settle(() => !linkServer.isConnected(scope.edgeNodeId));
    };

    const instance = randomUUID();
    await connect(instance);
    await connect(); // old edge: no header
    await connect("not-a-uuid"); // malformed: connection still accepted
    expect(seen).toEqual([instance, null, null]);
    await linkServer.close();
  });

  it("EDG-01 a cloud-side failure while authenticating is retried, not treated as a refusal", async () => {
    const { token } = mintEdgeCredential(scope);
    let failures = 2;
    const errors: unknown[] = [];
    server = createServer();
    const linkServer = createEdgeLinkServer(server, {
      version: "cloud",
      authenticate: async (presented) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("database unavailable");
        }
        return presented === token ? { scope } : null;
      },
      isActive: async () => true,
      storeFor: () => new MemoryStore("cloud_to_edge"),
      onError: (error) => errors.push(error),
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const client = createEdgeLinkClient({
      url: `ws://127.0.0.1:${port}/api/edge-link`,
      credential: token,
      scope,
      store: new MemoryStore("edge_to_cloud"),
      version: "edge",
      random: () => 0,
    });
    await settle(() => client.state().cloudLink === "connected", 6000);
    expect(client.state().refused).toBe(false);
    expect(errors.length).toBe(2);
    await client.stop();
    await linkServer.close();
  });
});
