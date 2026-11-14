// legend-tmar2 (848 design, docs/briefs/848-design.md): a restored edge can
// reuse link slots (acked, N] with different events while the cloud's resume
// cursor N stays <= the edge head. The edge must prove the WHOLE range
// (acked, N] against a cloud digest before it acks; otherwise unsent events
// (panic alerts) are marked acked without ever being sent.
//
// Pure unit tests on the link peer with in-memory stores (same rules as the
// MemoryStore of edge-link.test.ts). The stores implement the contract's
// optional methods `outboundProof` (edge) and `inboundProof` (cloud) with a
// local reference digest, so the tests fail only for missing link-peer
// behavior (ack without proof check), not for missing store code.
//
// Assumptions where the brief is silent:
// - A mismatch closes the link with 1008 and a reason containing
//   "Restore proof mismatch" (design section 5).
// - A hello carrying a proof whose range the edge cannot fully read (rows
//   missing) is a mismatch (design: "ATAU baris kurang").
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
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
import * as protocol from "../edge/protocol.ts";
import { decodeFrame } from "../edge/protocol.ts";

const scope: LinkScope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};

type Proof = { count: number; sha256: string };
type HelloProof = Proof & { from: number };

/** Reference digest from the contract: sha256 of `uuidLowercase + "\n"` each. */
function refProof(uuids: readonly string[]): Proof {
  const hash = createHash("sha256");
  for (const id of uuids) hash.update(`${id.toLowerCase()}\n`);
  return { count: uuids.length, sha256: hash.digest("hex") };
}

/** Hello proof over `items`, announced as the range after `from`. */
const withFrom = (
  from: number,
  items: readonly EventEnvelope[],
): HelloProof => ({
  from,
  ...refProof(items.map(uuidOf)),
});

let clock = Date.parse("2026-11-15T00:00:00.000Z");
function event(name = "order.item_added"): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: scope.tenantId as EventEnvelope["tenantId"],
    outletId: scope.outletId as EventEnvelope["outletId"],
    name,
    version: 1,
    aggregateType: name.startsWith("panic") ? "panic_alert" : "order",
    aggregateId: randomUUID(),
    sequence: 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `restore-proof-${clock}`,
    payloadSchemaRef: `${name}.v1`,
    payload: {},
  } as EventEnvelope;
}
const panic = () => event("panic_alert.raised");
const uuidOf = (item: EventEnvelope) => ulidToUuid(item.id);

/** Edge side: durable outbound queue, rows stay after ack (status only). */
class EdgeStore implements LinkStore {
  readonly outbound: SyncDirection = "edge_to_cloud";
  slots = new Map<
    number,
    { event: EventEnvelope; status: "pending" | "acked" }
  >();
  acked = 0;
  ackCalls: number[] = [];
  received = 0;
  constructor(events: readonly EventEnvelope[], acked = 0) {
    events.forEach((item, index) =>
      this.slots.set(index + 1, { event: item, status: "pending" }),
    );
    this.acked = acked;
    for (let seq = 1; seq <= acked; seq++)
      this.slots.get(seq)!.status = "acked";
  }
  statusOf(item: EventEnvelope) {
    for (const slot of this.slots.values())
      if (slot.event.id === item.id) return slot.status;
    return undefined;
  }
  async outboundHead() {
    return Math.max(0, ...this.slots.keys());
  }
  async lastAckedOutbound() {
    return this.acked;
  }
  async readOutbound(after: number, limit: number): Promise<QueuedEdgeEvent[]> {
    return [...this.slots.entries()]
      .filter(([seq]) => seq > after)
      .sort(([a], [b]) => a - b)
      .slice(0, limit)
      .map(([linkSeq, slot]) => ({ linkSeq, event: slot.event }));
  }
  async ackOutbound(upto: number) {
    this.ackCalls.push(upto);
    this.acked = Math.max(this.acked, upto);
    for (const [seq, slot] of this.slots)
      if (seq <= upto) slot.status = "acked";
  }
  async lastReceivedInbound() {
    return this.received;
  }
  async applyInbound(input: { toSeq: number }) {
    this.received = input.toSeq;
  }
  /** Edge numbering, rows present in (from, to], ascending link_seq. */
  async outboundProof(fromSeq: number, toSeq: number): Promise<Proof> {
    const rows = [...this.slots.entries()]
      .filter(([seq]) => seq > fromSeq && seq <= toSeq)
      .sort(([a], [b]) => a - b)
      .map(([, slot]) => uuidOf(slot.event));
    return refProof(rows);
  }
}

/** Cloud side: receipts of edge_to_cloud events by edge link number. */
class CloudStore implements LinkStore {
  readonly outbound: SyncDirection = "cloud_to_edge";
  received: number;
  applied: string[] = [];
  readonly inboundProofCalls: [number, number][] = [];
  /** R2: the cloud cannot prove the range (gap in receipts, range too large). */
  unprovable = false;
  constructor(readonly receipts: readonly string[]) {
    this.received = receipts.length;
  }
  async outboundHead() {
    return 0;
  }
  async lastAckedOutbound() {
    return 0;
  }
  async readOutbound(): Promise<QueuedEdgeEvent[]> {
    return [];
  }
  async ackOutbound() {}
  async lastReceivedInbound() {
    return this.received;
  }
  async applyInbound(input: {
    fromSeq: number;
    toSeq: number;
    events: readonly QueuedEdgeEvent[];
  }) {
    if (input.fromSeq !== this.received) throw new Error("cursor moved");
    for (const { event: item } of input.events) this.applied.push(item.id);
    this.received = input.toSeq;
  }
  /** Edge numbering; the real store adds peer_seq_offset itself. */
  async inboundProof(fromSeq: number, toSeq: number): Promise<Proof | null> {
    this.inboundProofCalls.push([fromSeq, toSeq]);
    if (this.unprovable) return null;
    return refProof(this.receipts.slice(fromSeq, toSeq));
  }
}

const peers: LinkPeer[] = [];
afterEach(() => {
  for (const peer of peers.splice(0)) peer.stop();
});

function helloFrame(cursor: number, proof?: unknown) {
  return JSON.stringify({
    type: "hello",
    version: "cloud",
    inboundCursor: String(cursor),
    ...(proof === undefined ? {} : { inboundProof: proof }),
  });
}

/** One edge peer fed hand-made hello frames. */
function lone(store: EdgeStore) {
  const send = vi.fn();
  const close = vi.fn();
  const peer = createLinkPeer({
    scope,
    outboundDirection: "edge_to_cloud",
    store,
    version: "edge",
    ackTimeoutMs: 20,
    transport: { send, close },
  });
  peers.push(peer);
  return { peer, send, close };
}

async function settle(until: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!until()) {
    if (Date.now() > end) throw new Error("Link did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Real cloud peer + real edge peer joined by an in-memory transport. */
function connect(
  cloud: CloudStore,
  edge: EdgeStore,
  restoreProofAcked?: number,
) {
  let open = true;
  const closes: { who: string; code: number; reason?: string }[] = [];
  const peerPair = {} as { cloud: LinkPeer; edge: LinkPeer };
  const deliver = (target: () => LinkPeer, data: string) =>
    queueMicrotask(() => {
      if (open) target().receive(data);
    });
  const cloudOptions: LinkPeerOptions & { restoreProofAcked?: number } = {
    scope,
    outboundDirection: "cloud_to_edge",
    store: cloud,
    version: "cloud",
    ackTimeoutMs: 20,
    ...(restoreProofAcked === undefined ? {} : { restoreProofAcked }),
    transport: {
      send: (data) => deliver(() => peerPair.edge, data),
      close: (code, reason) => {
        closes.push({ who: "cloud", code, reason });
        open = false;
      },
    },
  };
  peerPair.cloud = createLinkPeer(cloudOptions);
  peerPair.edge = createLinkPeer({
    scope,
    outboundDirection: "edge_to_cloud",
    store: edge,
    version: "edge",
    ackTimeoutMs: 20,
    transport: {
      send: (data) => deliver(() => peerPair.cloud, data),
      close: (code, reason) => {
        closes.push({ who: "edge", code, reason });
        open = false;
      },
    },
  });
  peers.push(peerPair.cloud, peerPair.edge);
  peerPair.cloud.start();
  peerPair.edge.start();
  return { closes };
}

describe("legend-tmar2 protocol contract", () => {
  it("restoreProofOf is the SHA-256 of lowercase uuid + newline per event, in order", () => {
    const a = "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b";
    const b = "ffffffff-0000-4000-8000-000000000001";
    const restoreProofOf = (protocol as Record<string, unknown>)
      .restoreProofOf as ((ids: Iterable<string>) => Proof) | undefined;
    expect(typeof restoreProofOf).toBe("function");
    expect(restoreProofOf!([a, b])).toEqual(refProof([a, b]));
    expect(restoreProofOf!([b, a])).not.toEqual(refProof([a, b]));
    expect(restoreProofOf!([a.toUpperCase(), b])).toEqual(refProof([a, b]));
    expect(restoreProofOf!([])).toEqual({
      count: 0,
      sha256: createHash("sha256").digest("hex"),
    });
  });

  it("restoreProofAckedFromHeader accepts one decimal cursor and nothing else", () => {
    const parse = (protocol as Record<string, unknown>)
      .restoreProofAckedFromHeader as
      ((value: string | string[] | undefined) => number | null) | undefined;
    expect(typeof parse).toBe("function");
    expect(parse!("0")).toBe(0);
    expect(parse!("12")).toBe(12);
    expect(parse!(undefined)).toBeNull();
    expect(parse!("")).toBeNull();
    expect(parse!("abc")).toBeNull();
    expect(parse!("-1")).toBeNull();
    expect(parse!("1.5")).toBeNull();
    // Assumption: a repeated header is ambiguous, so it is rejected.
    expect(parse!(["1", "2"])).toBeNull();
    expect(
      typeof (protocol as Record<string, unknown>).LINK_RESTORE_PROOF_HEADER,
    ).toBe("string");
    expect(
      (protocol as Record<string, unknown>).LINK_RESTORE_PROOF_HEADER,
    ).toBe("x-edge-restore-proof");
  });
});

describe("legend-tmar2 hello frame stays strict", () => {
  const proof = {
    from: 2,
    ...refProof(["0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b"]),
  };
  const base = { type: "hello", version: "cloud", inboundCursor: "3" };

  it("f. accepts an optional well-formed inboundProof and still decodes a legacy hello", () => {
    expect(decodeFrame(JSON.stringify(base))).not.toBeNull();
    expect(
      decodeFrame(JSON.stringify({ ...base, inboundProof: proof })),
    ).toMatchObject({ type: "hello", inboundProof: proof });
  });

  it.each([
    ["unknown top-level field", { ...base, extra: 1 }],
    [
      "unknown field inside the proof",
      { ...base, inboundProof: { ...proof, extra: 1 } },
    ],
    ["missing sha256", { ...base, inboundProof: { from: 2, count: 1 } }],
    [
      "missing count",
      { ...base, inboundProof: { from: 2, sha256: proof.sha256 } },
    ],
    [
      "missing from",
      {
        ...base,
        inboundProof: { count: proof.count, sha256: proof.sha256 },
      },
    ],
    ["negative from", { ...base, inboundProof: { ...proof, from: -1 } }],
    ["fractional from", { ...base, inboundProof: { ...proof, from: 1.5 } }],
    ["from as string", { ...base, inboundProof: { ...proof, from: "2" } }],
    [
      "negative count",
      { ...base, inboundProof: { from: 2, count: -1, sha256: proof.sha256 } },
    ],
    [
      "fractional count",
      { ...base, inboundProof: { from: 2, count: 1.5, sha256: proof.sha256 } },
    ],
    [
      "sha256 not hex",
      { ...base, inboundProof: { from: 2, count: 1, sha256: "z".repeat(64) } },
    ],
    [
      "sha256 too short",
      {
        ...base,
        inboundProof: { from: 2, count: 1, sha256: proof.sha256.slice(1) },
      },
    ],
  ])("f. rejects %s", (_name, frame) => {
    expect(decodeFrame(JSON.stringify(frame))).toBeNull();
  });
});

describe("legend-tmar2 edge verifies the whole range before ack", () => {
  // Edge acked 2, head 6; cloud resume cursor 5 -> range (2,5] = slots 3,4,5.
  const original = Array.from({ length: 6 }, () => event());

  it("d. a matching range is acked normally (digest matches)", async () => {
    const store = new EdgeStore(original, 2);
    const { peer, close } = lone(store);
    peer.receive(helloFrame(5, withFrom(2, original.slice(2, 5))));
    await peer.idle();
    expect(close).not.toHaveBeenCalled();
    expect(store.ackCalls).toEqual([5]);
    expect(store.acked).toBe(5);
  });

  it("c. a hello without proof (old cloud) still acks as before", async () => {
    const store = new EdgeStore(original, 2);
    const { peer, close } = lone(store);
    peer.receive(helloFrame(5));
    await peer.idle();
    expect(close).not.toHaveBeenCalled();
    expect(store.ackCalls).toEqual([5]);
  });

  const restored = (mutate: (events: EventEnvelope[]) => EventEnvelope[]) =>
    mutate(original.slice());
  it.each([
    [
      "a. the last event of the range differs",
      (events: EventEnvelope[]) => {
        events[4] = event();
        return events;
      },
    ],
    [
      "e. only a middle event differs (last id still equal)",
      (events: EventEnvelope[]) => {
        events[3] = event();
        return events;
      },
    ],
    [
      "e. only the first event of the range differs",
      (events: EventEnvelope[]) => {
        events[2] = event();
        return events;
      },
    ],
    [
      "events reordered with the same set",
      (events: EventEnvelope[]) => {
        [events[2], events[3]] = [events[3]!, events[2]!];
        return events;
      },
    ],
  ])(
    "%s: refuses before ack, nothing acked, nothing sent",
    async (_n, mutate) => {
      // The cloud saw `original` at slots 1..5; the edge DB was restored with
      // different events in those slots.
      const store = new EdgeStore(restored(mutate), 2);
      const { peer, send, close } = lone(store);
      peer.receive(helloFrame(5, withFrom(2, original.slice(2, 5))));
      await peer.idle();
      expect(close).toHaveBeenCalledWith(
        1008,
        expect.stringMatching(/Restore proof mismatch/),
      );
      expect(store.ackCalls).toEqual([]);
      expect(store.acked).toBe(2);
      for (let seq = 3; seq <= 6; seq++)
        expect(store.slots.get(seq)!.status).toBe("pending");
      expect(
        send.mock.calls.filter(([raw]) => decodeFrame(raw)?.type === "batch"),
      ).toEqual([]);
    },
  );

  it("refuses when the cloud proof counts more events than the edge holds", async () => {
    const store = new EdgeStore(original, 2);
    const { peer, close } = lone(store);
    const longer = [...original.slice(2, 5), event()].map(uuidOf);
    peer.receive(helloFrame(5, { from: 2, ...refProof(longer) }));
    await peer.idle();
    expect(close).toHaveBeenCalledWith(
      1008,
      expect.stringMatching(/Restore proof mismatch/),
    );
    expect(store.ackCalls).toEqual([]);
  });

  it("refuses when rows of the range are missing on the edge", async () => {
    const store = new EdgeStore(original, 2);
    store.slots.delete(4);
    const { peer, close } = lone(store);
    peer.receive(helloFrame(5, withFrom(2, original.slice(2, 5))));
    await peer.idle();
    expect(close).toHaveBeenCalledWith(
      1008,
      expect.stringMatching(/Restore proof mismatch/),
    );
    expect(store.ackCalls).toEqual([]);
    expect(store.acked).toBe(2);
  });
});

describe("legend-tmar2 end to end: cloud peer proves, edge peer verifies", () => {
  // Cloud received slots 1..5 before the backup was restored on the edge.
  const cloudSaw = Array.from({ length: 5 }, () => event());

  it("b. an unsent panic alert in a reused slot is never acked or lost", async () => {
    // Restored edge: slots 1,2 identical (acked = 2), slot 3 now holds a NEW
    // panic alert, slots 4,5 equal what the cloud saw (last id equal too).
    const newPanic = panic();
    const edge = new EdgeStore(
      [cloudSaw[0]!, cloudSaw[1]!, newPanic, cloudSaw[3]!, cloudSaw[4]!],
      2,
    );
    const cloud = new CloudStore(cloudSaw.map(uuidOf));
    const link = connect(cloud, edge, 2);
    await settle(() => link.closes.length > 0);
    expect(link.closes[0]).toMatchObject({
      code: 1008,
      reason: expect.stringMatching(/Restore proof mismatch/),
    });
    expect(edge.statusOf(newPanic)).toBe("pending");
    expect(edge.acked).toBe(2);
    expect(edge.ackCalls).toEqual([]);
    // Never ack-without-send: the panic did not reach the cloud either, the
    // link was refused so the operator can restore/rebase deliberately.
    expect(cloud.applied).not.toContain(newPanic.id);
    expect(cloud.inboundProofCalls).toEqual([[2, 5]]);
  });

  it("a. same instance, edge DB restored with different events in (acked, N]: link refused, acked unchanged", async () => {
    const edge = new EdgeStore(
      [cloudSaw[0]!, cloudSaw[1]!, event(), event(), event(), event()],
      2,
    );
    const cloud = new CloudStore(cloudSaw.map(uuidOf));
    const link = connect(cloud, edge, 2);
    await settle(() => link.closes.length > 0);
    expect(link.closes[0]).toMatchObject({
      code: 1008,
      reason: expect.stringMatching(/Restore proof mismatch/),
    });
    expect(edge.acked).toBe(2);
    expect(edge.ackCalls).toEqual([]);
    for (let seq = 3; seq <= 6; seq++)
      expect(edge.slots.get(seq)!.status).toBe("pending");
    expect(cloud.applied).toEqual([]);
  });

  it("e. a different MIDDLE event is refused although the last event id matches", async () => {
    const edge = new EdgeStore(
      [cloudSaw[0]!, cloudSaw[1]!, cloudSaw[2]!, event(), cloudSaw[4]!],
      2,
    );
    const cloud = new CloudStore(cloudSaw.map(uuidOf));
    const link = connect(cloud, edge, 2);
    await settle(() => link.closes.length > 0);
    expect(link.closes[0]).toMatchObject({
      code: 1008,
      reason: expect.stringMatching(/Restore proof mismatch/),
    });
    expect(edge.acked).toBe(2);
  });

  it("d. a matching range acks normally and later events still flow", async () => {
    const later = [event(), event()];
    const edge = new EdgeStore([...cloudSaw, ...later], 2);
    const cloud = new CloudStore(cloudSaw.map(uuidOf));
    const link = connect(cloud, edge, 2);
    await settle(() => edge.acked === 7 || link.closes.length > 0);
    expect(link.closes).toEqual([]);
    expect(edge.acked).toBe(7);
    expect(edge.ackCalls[0]).toBe(5);
    expect(cloud.applied).toEqual(later.map((item) => item.id));
    expect(cloud.inboundProofCalls).toEqual([[2, 5]]);
  });

  it("c. an old edge (no restore header, so no restoreProofAcked): cloud hello has no proof and the link works", async () => {
    // Same wrong slots as scenario a: legacy behavior is preserved exactly
    // (ack at the cursor), compatibility only, not protection.
    const edge = new EdgeStore(
      [cloudSaw[0]!, cloudSaw[1]!, event(), event(), event(), event()],
      2,
    );
    const cloud = new CloudStore(cloudSaw.map(uuidOf));
    const sent: string[] = [];
    const original = cloud.inboundProof.bind(cloud);
    cloud.inboundProof = async (from, to) => {
      sent.push("inboundProof");
      return original(from, to);
    };
    const link = connect(cloud, edge);
    await settle(() => edge.acked >= 5);
    expect(link.closes).toEqual([]);
    expect(sent).toEqual([]);
    expect(cloud.inboundProofCalls).toEqual([]);
  });

  it.each([
    ["N equals A", 5],
    ["N below A", 7],
  ])(
    "cloud hello carries no proof when %s (nothing to ack)",
    async (_name, acked) => {
      const edge = new EdgeStore(
        [...cloudSaw, event(), event(), event()],
        Math.min(acked, 8),
      );
      const cloud = new CloudStore(cloudSaw.map(uuidOf));
      const frames: string[] = [];
      const send = vi.fn((data: string) => frames.push(data));
      const peer = createLinkPeer({
        scope,
        outboundDirection: "cloud_to_edge",
        store: cloud,
        version: "cloud",
        ackTimeoutMs: 20,
        restoreProofAcked: acked,
        transport: { send, close: vi.fn() },
      } as LinkPeerOptions);
      peers.push(peer);
      peer.start();
      await peer.idle();
      const hello = decodeFrame(frames[0]!);
      expect(hello).toMatchObject({ type: "hello", inboundCursor: "5" });
      expect(hello).not.toHaveProperty("inboundProof");
      expect(cloud.inboundProofCalls).toEqual([]);
      expect(edge.ackCalls).toEqual([]);
    },
  );

  it("cloud hello digest covers exactly (A, N] and is attached only when N > A", async () => {
    const cloud = new CloudStore(cloudSaw.map(uuidOf));
    const frames: string[] = [];
    const peer = createLinkPeer({
      scope,
      outboundDirection: "cloud_to_edge",
      store: cloud,
      version: "cloud",
      ackTimeoutMs: 20,
      restoreProofAcked: 2,
      transport: { send: (data: string) => frames.push(data), close: vi.fn() },
    } as LinkPeerOptions);
    peers.push(peer);
    peer.start();
    await peer.idle();
    expect(decodeFrame(frames[0]!)).toMatchObject({
      type: "hello",
      inboundCursor: "5",
      inboundProof: withFrom(2, cloudSaw.slice(2, 5)),
    });
  });
});

describe("legend-tmar2 revision 1 (R1, R2, R4)", () => {
  const original = Array.from({ length: 6 }, () => event());

  it("R1. a from below the current acked is still verified over (from, cursor]", async () => {
    // The header was read at A = 2, then an ack finished: acked is 4 now.
    const matching = new EdgeStore(original, 4);
    const ok = lone(matching);
    ok.peer.receive(helloFrame(5, withFrom(2, original.slice(2, 5))));
    await ok.peer.idle();
    expect(ok.close).not.toHaveBeenCalled();
    expect(matching.ackCalls).toEqual([5]);

    // Slot 3 is <= acked now, yet it differs: the proof from 2 still refuses.
    const events = original.slice();
    events[2] = event();
    const differing = new EdgeStore(events, 4);
    const bad = lone(differing);
    bad.peer.receive(helloFrame(5, withFrom(2, original.slice(2, 5))));
    await bad.peer.idle();
    expect(bad.close).toHaveBeenCalledWith(
      1008,
      expect.stringMatching(/Restore proof mismatch/),
    );
    expect(differing.ackCalls).toEqual([]);
    expect(differing.acked).toBe(4);
  });

  it("R1. a from beyond the edge's acked cursor is refused before any ack", async () => {
    const store = new EdgeStore(original, 2);
    const { peer, close } = lone(store);
    peer.receive(helloFrame(5, withFrom(4, original.slice(4, 5))));
    await peer.idle();
    expect(close).toHaveBeenCalledWith(
      1008,
      expect.stringMatching(/^Restore proof/),
    );
    expect(store.ackCalls).toEqual([]);
    expect(store.acked).toBe(2);
  });

  it("R2. inboundProof null: the cloud hello carries no proof", async () => {
    const cloud = new CloudStore([...original.slice(0, 5)].map(uuidOf));
    cloud.unprovable = true;
    const frames: string[] = [];
    const peer = createLinkPeer({
      scope,
      outboundDirection: "cloud_to_edge",
      store: cloud,
      version: "cloud",
      ackTimeoutMs: 20,
      restoreProofAcked: 2,
      transport: { send: (data: string) => frames.push(data), close: vi.fn() },
    });
    peers.push(peer);
    peer.start();
    await peer.idle();
    expect(cloud.inboundProofCalls).toEqual([[2, 5]]);
    const hello = decodeFrame(frames[0]!);
    expect(hello).toMatchObject({ type: "hello", inboundCursor: "5" });
    expect(hello).not.toHaveProperty("inboundProof");
  });

  it("R4. a refused restore proof does not reset the reconnect backoff", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server, path: "/api/edge-link" });
    const wrong = {
      from: 2,
      count: 3,
      sha256: "a".repeat(64),
    };
    sockets.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "hello",
          version: "cloud",
          inboundCursor: "5",
          inboundProof: wrong,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/edge-link`;
    // Backoff waits are shortened, but recorded: with random() = 1 the delay
    // is the ceiling base * 2^attempt (1000, 2000, 4000, ...).
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
    const base = new EdgeStore(original, 2);
    const store: LinkStore = {
      outboundHead: () => base.outboundHead(),
      lastAckedOutbound: () => base.lastAckedOutbound(),
      readOutbound: (after, limit) => base.readOutbound(after, limit),
      ackOutbound: (upto) => base.ackOutbound(upto),
      lastReceivedInbound: () => base.lastReceivedInbound(),
      applyInbound: (input) => base.applyInbound(input),
      outboundProof: (from, to) => base.outboundProof(from, to),
    };
    const client = createEdgeLinkClient({
      url,
      credential: mintEdgeCredential(scope).token,
      scope,
      store,
      version: "edge",
      random: () => 1,
    });
    try {
      const end = Date.now() + 10_000;
      while (waits.length < 3) {
        if (Date.now() > end) throw new Error("Backoff did not repeat");
        await new Promise((resolve) => realSetTimeout(resolve, 10));
      }
      expect(waits.slice(0, 3)).toEqual([1000, 2000, 4000]);
      expect(base.ackCalls).toEqual([]);
    } finally {
      spy.mockRestore();
      await client.stop();
      await new Promise<void>((resolve) =>
        sockets.close(() => server.close(() => resolve())),
      );
    }
  }, 15_000);
});
