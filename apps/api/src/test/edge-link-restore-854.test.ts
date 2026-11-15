// legend-tmar2 / 854 (docs/briefs/854-edge-proof-fail-closed.md, "Desain 854"
// + "Revisi 1"): a strict peer (cloud peer options restoreProofAcked AND
// restoreProofStrict, i.e. an edge sending x-edge-restore-proof-v2) never acks
// without proof. An edge 848 (header v1 only, no strict) keeps the exact 848
// behavior: proof only when complete, otherwise a hello without proof, no
// reconcileReplay, old duplicate ack. The cloud proves a PREFIX of (A, N] (at most 20000 slots, `to` in the
// hello when partial or empty), the edge acks only that proven prefix and
// resends the rest; the cloud checks replayed slots through
// `store.reconcileReplay` before it acks them.
//
// Unit tests on the link peer with in-memory stores, written from the design
// (point numbers refer to "Kontrak (tetap)"). The stores implement the
// contract's optional methods (`outboundProof`, `inboundProof`,
// `reconcileReplay`) with a local reference digest, so tests fail only for
// missing link-peer / protocol / link-client behavior.
//
// Assumptions where the design is silent:
// - Wire format of `inboundProof.to` is a decimal cursor STRING like
//   `inboundCursor` (design: `linkCursorSchema`). A JSON number is rejected.
// - A refusal closes with 1008 and a reason starting with "Restore proof"
//   (the existing LINK_RESTORE_PROOF_REFUSAL).
// - The 20000 cap is the store's job (design point 2); the fake cloud store
//   implements the cap itself, so the 20000-slot scenario checks what the
//   peers do with a partial proof.
// - Old-peer duplicate batch: the exact ack cursor of the old behavior is not
//   pinned; only "an ack frame, nothing applied, reconcileReplay untouched".
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
  LinkProtocolError,
  type LinkPeer,
  type LinkPeerOptions,
  type LinkScope,
  type LinkStore,
  type QueuedEdgeEvent,
} from "../edge/link-peer.ts";
import { decodeFrame, LINK_RESTORE_PROOF_REFUSAL } from "../edge/protocol.ts";

const scope: LinkScope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};

const CAP = 20_000;

type Proof = { count: number; sha256: string };
type PartialProof = Proof & { to: number };

/** Reference digest from the contract: sha256 of `uuidLowercase + "\n"` each. */
function refProof(uuids: readonly string[]): Proof {
  const hash = createHash("sha256");
  for (const id of uuids) hash.update(`${id.toLowerCase()}\n`);
  return { count: uuids.length, sha256: hash.digest("hex") };
}

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
    idempotencyKey: `restore-854-${clock}`,
    payloadSchemaRef: `${name}.v1`,
    payload: {},
  } as EventEnvelope;
}
const panic = () => event("panic_alert.raised");
const uuidOf = (item: EventEnvelope) => ulidToUuid(item.id);

/** Hello proof over `items` (the slots after `from`), optionally with `to`. */
const helloProof = (
  from: number,
  items: readonly EventEnvelope[],
  to?: number,
) => ({
  from,
  ...(to === undefined ? {} : { to: String(to) }),
  ...refProof(items.map(uuidOf)),
});

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
    return this.slots.size;
  }
  async lastAckedOutbound() {
    return this.acked;
  }
  async readOutbound(after: number, limit: number): Promise<QueuedEdgeEvent[]> {
    const out: QueuedEdgeEvent[] = [];
    for (let seq = after + 1; out.length < limit; seq++) {
      const slot = this.slots.get(seq);
      if (!slot) break;
      out.push({ linkSeq: seq, event: slot.event });
    }
    return out;
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
  async outboundProof(fromSeq: number, toSeq: number): Promise<Proof> {
    const rows: string[] = [];
    for (let seq = fromSeq + 1; seq <= toSeq; seq++) {
      const slot = this.slots.get(seq);
      if (slot) rows.push(uuidOf(slot.event));
    }
    return refProof(rows);
  }
}

/**
 * Cloud side: one receipt per edge link slot (event uuid, or none = hole) and
 * the set of event ids the cloud knows (edge_received_events).
 */
class CloudStore implements LinkStore {
  readonly outbound: SyncDirection = "cloud_to_edge";
  received: number;
  applied: string[] = [];
  readonly receipts = new Map<number, string>();
  readonly registered = new Set<string>();
  readonly inboundProofCalls: [number, number][] = [];
  readonly reconcileCalls: number[][] = [];
  /** edge.ackCalls length at the moment of each reconcileReplay call. */
  readonly ackCallsSeen: number[] = [];
  edge?: EdgeStore;
  constructor(
    slots: readonly (EventEnvelope | undefined)[],
    received?: number,
  ) {
    slots.forEach((item, index) => {
      if (!item) return;
      this.registered.add(uuidOf(item));
      this.receipts.set(index + 1, uuidOf(item));
    });
    this.received = received ?? slots.length;
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
    for (const { linkSeq, event: item } of input.events) {
      this.applied.push(item.id);
      this.registered.add(uuidOf(item));
      this.receipts.set(linkSeq, uuidOf(item));
    }
    this.received = input.toSeq;
  }
  /** Contract point 2: longest complete prefix of (from, min(to, from+CAP)]. */
  async inboundProof(
    fromSeq: number,
    toSeq: number,
  ): Promise<PartialProof | null> {
    this.inboundProofCalls.push([fromSeq, toSeq]);
    if (toSeq < fromSeq) return null;
    const limit = Math.min(toSeq, fromSeq + CAP);
    const ids: string[] = [];
    for (let seq = fromSeq + 1; seq <= limit; seq++) {
      const id = this.receipts.get(seq);
      if (id === undefined) break;
      ids.push(id);
    }
    return { to: fromSeq + ids.length, ...refProof(ids) };
  }
  /** Contract point 6, for edge_to_cloud. */
  async reconcileReplay(input: {
    events: readonly { linkSeq: number; event: EventEnvelope }[];
  }) {
    this.reconcileCalls.push(input.events.map((item) => item.linkSeq));
    this.ackCallsSeen.push(this.edge?.ackCalls.length ?? 0);
    for (const { linkSeq, event: item } of input.events) {
      const id = uuidOf(item);
      const receipt = this.receipts.get(linkSeq);
      if (receipt === id) continue;
      if (receipt === undefined && this.registered.has(id)) {
        this.receipts.set(linkSeq, id);
        continue;
      }
      throw new LinkProtocolError(
        `${LINK_RESTORE_PROOF_REFUSAL} replayed slot ${linkSeq} holds a different event; refusing to resume`,
      );
    }
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
  const batches = () =>
    send.mock.calls
      .map(([raw]) => decodeFrame(raw as string))
      .flatMap((frame) => (frame?.type === "batch" ? [frame.batch] : []));
  return { peer, send, close, batches };
}

async function settle(until: () => boolean, ms = 8000) {
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
  strict = false,
) {
  cloud.edge = edge;
  let open = true;
  const closes: { who: string; code: number; reason?: string }[] = [];
  const pair = {} as { cloud: LinkPeer; edge: LinkPeer };
  const deliver = (target: () => LinkPeer, data: string) =>
    queueMicrotask(() => {
      if (open) target().receive(data);
    });
  const cloudOptions: LinkPeerOptions & {
    restoreProofAcked?: number;
    restoreProofStrict?: boolean;
  } = {
    scope,
    outboundDirection: "cloud_to_edge",
    store: cloud,
    version: "cloud",
    ackTimeoutMs: 20,
    ...(restoreProofAcked === undefined ? {} : { restoreProofAcked }),
    ...(strict ? { restoreProofStrict: true } : {}),
    transport: {
      send: (data) => deliver(() => pair.edge, data),
      close: (code, reason) => {
        closes.push({ who: "cloud", code, reason });
        open = false;
      },
    },
  };
  pair.cloud = createLinkPeer(cloudOptions);
  pair.edge = createLinkPeer({
    scope,
    outboundDirection: "edge_to_cloud",
    store: edge,
    version: "edge",
    ackTimeoutMs: 20,
    transport: {
      send: (data) => deliver(() => pair.cloud, data),
      close: (code, reason) => {
        closes.push({ who: "edge", code, reason });
        open = false;
      },
    },
  });
  peers.push(pair.cloud, pair.edge);
  pair.cloud.start();
  pair.edge.start();
  return { closes };
}

/** A cloud peer whose hello frame is captured. */
async function cloudHello(
  store: CloudStore,
  restoreProofAcked: number,
  strict = false,
) {
  const frames: string[] = [];
  const peer = createLinkPeer({
    scope,
    outboundDirection: "cloud_to_edge",
    store,
    version: "cloud",
    ackTimeoutMs: 20,
    restoreProofAcked,
    ...(strict ? { restoreProofStrict: true } : {}),
    transport: { send: (data: string) => frames.push(data), close: vi.fn() },
  } as LinkPeerOptions);
  peers.push(peer);
  peer.start();
  await peer.idle();
  return decodeFrame(frames[0]!);
}

const seen = Array.from({ length: 6 }, () => event());

describe("legend-tmar2 854 a. partial proof: ack only the proven prefix, resend the rest", () => {
  it("a. N - A above 20000: only (A, A+20000] is acked, the unsent panic alert beyond it stays pending and is resent", async () => {
    const A = 2;
    const N = A + CAP + 8; // 20010
    const original = Array.from({ length: N }, () => event());
    // Restored edge: same events everywhere, except an unsent panic alert in a
    // slot beyond the first proven 20000 slots (slot 20005).
    const newPanic = panic();
    const restored = original.slice();
    restored[A + CAP + 2] = newPanic; // slot 20005
    const edge = new EdgeStore(restored, A);
    const cloud = new CloudStore(original);
    const link = connect(cloud, edge, A, true);
    await settle(() => link.closes.length > 0);

    // The cloud proved (A, A+20000] only; the edge acked exactly that.
    expect(cloud.inboundProofCalls).toEqual([[A, N]]);
    expect(edge.ackCalls).toEqual([A + CAP]);
    expect(edge.acked).toBe(A + CAP);
    expect(edge.statusOf(newPanic)).toBe("pending");
    // sentUpTo went back to the proven prefix: slot A+CAP+1 comes again, and
    // the slot of the panic alert is checked by the cloud, not skipped.
    expect(cloud.reconcileCalls[0]![0]).toBe(A + CAP + 1);
    expect(cloud.reconcileCalls[0]).toContain(A + CAP + 3);
    // The cloud refuses the replayed slot holding another event.
    expect(link.closes[0]).toMatchObject({
      code: 1008,
      reason: expect.stringMatching(/^Restore proof/),
    });
    expect(cloud.applied).toEqual([]);
    expect(edge.acked).toBe(A + CAP);
  }, 20_000);

  it("a. N - A above 20000 with identical events: the next round continues and everything ends acked", async () => {
    const A = 2;
    const N = A + CAP + 8;
    const original = Array.from({ length: N }, () => event());
    const edge = new EdgeStore(original, A);
    const cloud = new CloudStore(original);
    const link = connect(cloud, edge, A, true);
    await settle(() => edge.acked === N || link.closes.length > 0);
    expect(link.closes).toEqual([]);
    expect(edge.ackCalls[0]).toBe(A + CAP);
    expect(edge.acked).toBe(N);
    expect(cloud.applied).toEqual([]);
  }, 20_000);

  it("a. edge: hello with a partial proof acks only `to`, never the cursor, and resends from `to`", async () => {
    const edgeEvents = [...seen.slice(0, 4), panic(), seen[5]!];
    const store = new EdgeStore(edgeEvents, 2);
    const { peer, close, batches } = lone(store);
    // Cloud cursor 6, proof covers (2, 4] only.
    peer.receive(helloFrame(6, helloProof(2, seen.slice(2, 4), 4)));
    await peer.idle();
    expect(close).not.toHaveBeenCalled();
    expect(store.ackCalls).toEqual([4]);
    expect(store.acked).toBe(4);
    expect(store.statusOf(edgeEvents[4]!)).toBe("pending");
    expect(store.statusOf(edgeEvents[5]!)).toBe("pending");
    const first = batches()[0]!;
    expect(first.fromCursor).toBe("4");
    expect(first.events.map((item) => item.id)).toEqual([
      edgeEvents[4]!.id,
      edgeEvents[5]!.id,
    ]);
  });

  it("a. edge: a partial proof whose digest differs is refused, nothing acked", async () => {
    const store = new EdgeStore(
      [seen[0]!, seen[1]!, event(), seen[3]!, seen[4]!, seen[5]!],
      2,
    );
    const { peer, close } = lone(store);
    peer.receive(helloFrame(6, helloProof(2, seen.slice(2, 4), 4)));
    await peer.idle();
    expect(close).toHaveBeenCalledWith(
      1008,
      expect.stringMatching(/^Restore proof/),
    );
    expect(store.ackCalls).toEqual([]);
  });

  it.each([
    ["to beyond the cursor", { from: 2, to: 7 }],
    ["to below from", { from: 3, to: 2 }],
  ])("a. edge: %s is refused before any ack", async (_name, range) => {
    const store = new EdgeStore(seen, 3);
    const { peer, close } = lone(store);
    peer.receive(
      helloFrame(6, {
        from: range.from,
        to: String(range.to),
        ...refProof([]),
      }),
    );
    await peer.idle();
    expect(close).toHaveBeenCalledWith(
      1008,
      expect.stringMatching(/^Restore proof/),
    );
    expect(store.ackCalls).toEqual([]);
    expect(store.acked).toBe(3);
  });

  it("a. cloud hello: a complete proof has no `to`, a partial and an empty proof carry `to`", async () => {
    // Full: receipts for 1..5, A=2, N=5.
    const full = await cloudHello(new CloudStore(seen.slice(0, 5)), 2, true);
    expect(full).toMatchObject({
      type: "hello",
      inboundCursor: "5",
      inboundProof: {
        from: 2,
        ...refProof(seen.slice(2, 5).map(uuidOf)),
      },
    });
    expect((full as { inboundProof: object }).inboundProof).not.toHaveProperty(
      "to",
    );
    // Partial: hole at slot 5 -> prefix (2, 4].
    const partial = await cloudHello(
      new CloudStore([...seen.slice(0, 4), undefined], 5),
      2,
      true,
    );
    expect(partial).toMatchObject({
      inboundCursor: "5",
      inboundProof: {
        from: 2,
        to: "4",
        ...refProof(seen.slice(2, 4).map(uuidOf)),
      },
    });
    // Empty: hole at slot 3 -> nothing provable, to = from.
    const empty = await cloudHello(
      new CloudStore([seen[0]!, seen[1]!, undefined, seen[3]!, seen[4]!], 5),
      2,
      true,
    );
    expect(empty).toMatchObject({
      inboundCursor: "5",
      inboundProof: { from: 2, to: "2", ...refProof([]) },
    });
  });
});

describe("legend-tmar2 854 b. empty proof (hole at A+1)", () => {
  it("b. no ack before the replay; the edge resends from A; the hole closes and the link stays up", async () => {
    // Cloud saw slots 1..5 but has no receipt for slot 3 (its event is known,
    // e.g. a skipped duplicate). The edge holds the same events + one new one.
    const later = event();
    const edge = new EdgeStore([...seen.slice(0, 5), later], 2);
    const cloud = new CloudStore(
      [seen[0]!, seen[1]!, undefined, seen[3]!, seen[4]!],
      5,
    );
    cloud.registered.add(uuidOf(seen[2]!));
    const link = connect(cloud, edge, 2, true);
    await settle(() => edge.acked === 6 || link.closes.length > 0);
    expect(link.closes).toEqual([]);
    // The hello proof was empty: no ack happened before the replay check.
    expect(cloud.inboundProofCalls).toEqual([[2, 5]]);
    expect(cloud.ackCallsSeen[0]).toBe(0);
    expect(cloud.reconcileCalls[0]![0]).toBe(3);
    // The hole is closed by the replay, the later event flows normally.
    expect(cloud.receipts.get(3)).toBe(uuidOf(seen[2]!));
    expect(cloud.applied).toEqual([later.id]);
    expect(edge.acked).toBe(6);
  });

  it("b. edge: an empty proof (to = from) acks nothing and resends from A", async () => {
    const store = new EdgeStore(seen.slice(0, 5), 2);
    const { peer, close, batches } = lone(store);
    peer.receive(helloFrame(5, helloProof(2, [], 2)));
    await peer.idle();
    expect(close).not.toHaveBeenCalled();
    expect(store.ackCalls).toEqual([]);
    expect(store.acked).toBe(2);
    expect(batches()[0]).toMatchObject({ fromCursor: "2" });
    expect(batches()[0]!.events.map((item) => item.id)).toEqual(
      seen.slice(2, 5).map((item) => item.id),
    );
  });

  it("b. a hole whose slot now holds an UNKNOWN event (unsent panic alert): never acked, link refused", async () => {
    const newPanic = panic();
    const edge = new EdgeStore(
      [seen[0]!, seen[1]!, newPanic, seen[3]!, seen[4]!],
      2,
    );
    const cloud = new CloudStore(
      [seen[0]!, seen[1]!, undefined, seen[3]!, seen[4]!],
      5,
    );
    cloud.registered.add(uuidOf(seen[2]!));
    const link = connect(cloud, edge, 2, true);
    await settle(() => link.closes.length > 0);
    expect(link.closes[0]).toMatchObject({
      code: 1008,
      reason: expect.stringMatching(/^Restore proof/),
    });
    expect(edge.ackCalls).toEqual([]);
    expect(edge.acked).toBe(2);
    expect(edge.statusOf(newPanic)).toBe("pending");
    expect(cloud.receipts.has(3)).toBe(false);
  });
});

describe("legend-tmar2 854 d. a replayed slot holding another event is never acked (peer level)", () => {
  it("d. new event in a slot <= cursor where a receipt exists: refused, nothing acked or applied", async () => {
    // A strict peer (restoreProofStrict set) receives a replayed batch: slot 3
    // is the event the cloud holds, slot 4 is a new event.
    const sent: string[] = [];
    const store = new CloudStore(seen.slice(0, 5));
    const close = vi.fn();
    const replaying = createLinkPeer({
      scope,
      outboundDirection: "cloud_to_edge",
      store,
      version: "cloud",
      ackTimeoutMs: 20,
      restoreProofAcked: 5,
      restoreProofStrict: true,
      transport: { send: (data: string) => sent.push(data), close },
    } as LinkPeerOptions);
    peers.push(replaying);
    replaying.receive(
      JSON.stringify({ type: "hello", version: "edge", inboundCursor: "0" }),
    );
    const intruder = panic();
    replaying.receive(
      JSON.stringify({
        type: "batch",
        batch: {
          tenantId: scope.tenantId,
          outletId: scope.outletId,
          id: createUlid(),
          peerId: scope.edgeNodeId,
          direction: "edge_to_cloud",
          fromCursor: "2",
          toCursor: "4",
          events: [seen[2], intruder],
        },
      }),
    );
    await replaying.idle();
    expect(close).toHaveBeenCalledWith(
      1008,
      expect.stringMatching(/^Restore proof/),
    );
    expect(store.applied).toEqual([]);
    expect(store.received).toBe(5);
    expect(
      sent.map((raw) => decodeFrame(raw)?.type).filter((t) => t === "ack"),
    ).toEqual([]);
  });
});

describe("legend-tmar2 854 e. old peers keep the old behavior exactly", () => {
  it("e. old edge (no restore header): cloud hello has no proof, store.inboundProof is not called", async () => {
    const store = new CloudStore(seen.slice(0, 5));
    const frames: string[] = [];
    const peer = createLinkPeer({
      scope,
      outboundDirection: "cloud_to_edge",
      store,
      version: "cloud",
      ackTimeoutMs: 20,
      transport: { send: (data: string) => frames.push(data), close: vi.fn() },
    });
    peers.push(peer);
    peer.start();
    await peer.idle();
    expect(decodeFrame(frames[0]!)).toMatchObject({
      type: "hello",
      inboundCursor: "5",
    });
    expect(decodeFrame(frames[0]!)).not.toHaveProperty("inboundProof");
    expect(store.inboundProofCalls).toEqual([]);
  });

  it("e. old edge: a duplicate batch (slots <= cursor) is only acked, reconcileReplay is not called", async () => {
    const store = new CloudStore(seen.slice(0, 5));
    const sent: string[] = [];
    const peer = createLinkPeer({
      scope,
      outboundDirection: "cloud_to_edge",
      store,
      version: "cloud",
      ackTimeoutMs: 20,
      transport: { send: (data: string) => sent.push(data), close: vi.fn() },
    });
    peers.push(peer);
    peer.receive(
      JSON.stringify({ type: "hello", version: "edge", inboundCursor: "0" }),
    );
    peer.receive(
      JSON.stringify({
        type: "batch",
        batch: {
          tenantId: scope.tenantId,
          outletId: scope.outletId,
          id: createUlid(),
          peerId: scope.edgeNodeId,
          direction: "edge_to_cloud",
          fromCursor: "2",
          toCursor: "4",
          // Even an unknown event in an old slot is just acked for an old peer.
          events: [seen[2], panic()],
        },
      }),
    );
    await peer.idle();
    expect(store.reconcileCalls).toEqual([]);
    expect(store.applied).toEqual([]);
    expect(
      sent.map((raw) => decodeFrame(raw)?.type).filter((t) => t === "ack")
        .length,
    ).toBeGreaterThan(0);
  });

  it("e. old cloud (hello without proof): the edge acks the cursor as before", async () => {
    const store = new EdgeStore(
      [seen[0]!, seen[1]!, event(), event(), event(), event()],
      2,
    );
    const { peer, close, batches } = lone(store);
    peer.receive(helloFrame(5));
    await peer.idle();
    expect(close).not.toHaveBeenCalled();
    expect(store.ackCalls).toEqual([5]);
    expect(batches()[0]).toMatchObject({ fromCursor: "5" });
  });

  it("e. hello proof without `to` means to = cursor (the 848 shape): acked up to the cursor", async () => {
    const store = new EdgeStore(seen, 2);
    const { peer, close, batches } = lone(store);
    peer.receive(helloFrame(5, helloProof(2, seen.slice(2, 5))));
    await peer.idle();
    expect(close).not.toHaveBeenCalled();
    expect(store.ackCalls).toEqual([5]);
    expect(batches()[0]).toMatchObject({ fromCursor: "5" });
  });

  it("e. `to` equal to the cursor behaves like a missing `to`", async () => {
    const store = new EdgeStore(seen, 2);
    const { peer, close } = lone(store);
    peer.receive(helloFrame(5, helloProof(2, seen.slice(2, 5), 5)));
    await peer.idle();
    expect(close).not.toHaveBeenCalled();
    expect(store.ackCalls).toEqual([5]);
  });

  it("e. an old edge connected to a modern cloud peer without proof header still works end to end", async () => {
    const edge = new EdgeStore(
      [seen[0]!, seen[1]!, event(), event(), event()],
      2,
    );
    const cloud = new CloudStore(seen.slice(0, 5));
    const link = connect(cloud, edge);
    await settle(() => edge.acked >= 5 || link.closes.length > 0);
    expect(link.closes).toEqual([]);
    expect(cloud.inboundProofCalls).toEqual([]);
    expect(cloud.reconcileCalls).toEqual([]);
    expect(edge.ackCalls[0]).toBe(5);
  });
});

describe("legend-tmar2 854 R2. an edge 848 (restoreProofAcked without strict) keeps the 848 behavior", () => {
  it("R2. complete range: hello carries the proof without `to`", async () => {
    const hello = await cloudHello(new CloudStore(seen.slice(0, 5)), 2);
    expect(hello).toMatchObject({
      inboundCursor: "5",
      inboundProof: {
        from: 2,
        ...refProof(seen.slice(2, 5).map(uuidOf)),
      },
    });
    expect((hello as { inboundProof: object }).inboundProof).not.toHaveProperty(
      "to",
    );
  });

  it.each([
    ["partial (hole at slot 5)", [0, 1, 2, 3, undefined]],
    ["empty (hole at slot 3)", [0, 1, undefined, 3, 4]],
  ])("R2. %s range: hello has no proof (848 fail-open)", async (_n, layout) => {
    const store = new CloudStore(
      layout.map((index) => (index === undefined ? undefined : seen[index])),
      5,
    );
    const hello = await cloudHello(store, 2);
    expect(hello).toMatchObject({ type: "hello", inboundCursor: "5" });
    expect(hello).not.toHaveProperty("inboundProof");
  });

  it("R2. end to end with a hole: the edge acks the cursor as in 848, no reconcileReplay, link up", async () => {
    const edge = new EdgeStore(
      [seen[0]!, seen[1]!, event(), seen[3]!, seen[4]!],
      2,
    );
    const cloud = new CloudStore(
      [seen[0]!, seen[1]!, undefined, seen[3]!, seen[4]!],
      5,
    );
    const link = connect(cloud, edge, 2);
    await settle(() => edge.acked >= 5 || link.closes.length > 0);
    expect(link.closes).toEqual([]);
    expect(edge.ackCalls[0]).toBe(5);
    expect(cloud.reconcileCalls).toEqual([]);
    expect(cloud.applied).toEqual([]);
  });

  it("R2. a complete range with matching events acks normally; differing events are still refused", async () => {
    const okEdge = new EdgeStore(seen.slice(0, 5), 2);
    const ok = connect(new CloudStore(seen.slice(0, 5)), okEdge, 2);
    await settle(() => okEdge.acked >= 5 || ok.closes.length > 0);
    expect(ok.closes).toEqual([]);
    expect(okEdge.ackCalls[0]).toBe(5);

    const badEdge = new EdgeStore(
      [seen[0]!, seen[1]!, event(), event(), event()],
      2,
    );
    const bad = connect(new CloudStore(seen.slice(0, 5)), badEdge, 2);
    await settle(() => bad.closes.length > 0);
    expect(bad.closes[0]).toMatchObject({
      code: 1008,
      reason: expect.stringMatching(/^Restore proof/),
    });
    expect(badEdge.ackCalls).toEqual([]);
  });

  it("R2. a duplicate batch from a non-strict peer is only acked, reconcileReplay is not called", async () => {
    const store = new CloudStore(seen.slice(0, 5));
    const sent: string[] = [];
    const peer = createLinkPeer({
      scope,
      outboundDirection: "cloud_to_edge",
      store,
      version: "cloud",
      ackTimeoutMs: 20,
      restoreProofAcked: 2,
      transport: { send: (data: string) => sent.push(data), close: vi.fn() },
    } as LinkPeerOptions);
    peers.push(peer);
    peer.receive(
      JSON.stringify({ type: "hello", version: "edge", inboundCursor: "0" }),
    );
    peer.receive(
      JSON.stringify({
        type: "batch",
        batch: {
          tenantId: scope.tenantId,
          outletId: scope.outletId,
          id: createUlid(),
          peerId: scope.edgeNodeId,
          direction: "edge_to_cloud",
          fromCursor: "2",
          toCursor: "4",
          events: [seen[2], panic()],
        },
      }),
    );
    await peer.idle();
    expect(store.reconcileCalls).toEqual([]);
    expect(store.applied).toEqual([]);
    expect(
      sent.map((raw) => decodeFrame(raw)?.type).filter((t) => t === "ack")
        .length,
    ).toBeGreaterThan(0);
  });
});

describe("legend-tmar2 854 R1. the edge client announces strict support", () => {
  it("R1. link-client sends x-edge-restore-proof (A) and x-edge-restore-proof-v2 (1) when the store can prove", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server, path: "/api/edge-link" });
    const headers: Record<string, string | string[] | undefined>[] = [];
    sockets.on("connection", (_socket, request) => {
      headers.push({
        v1: request.headers["x-edge-restore-proof"],
        v2: request.headers["x-edge-restore-proof-v2"],
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/edge-link`;
    const base = new EdgeStore(seen, 2);
    const client = createEdgeLinkClient({
      url,
      credential: mintEdgeCredential(scope).token,
      scope,
      store: {
        outboundHead: () => base.outboundHead(),
        lastAckedOutbound: () => base.lastAckedOutbound(),
        readOutbound: (after, limit) => base.readOutbound(after, limit),
        ackOutbound: (upto) => base.ackOutbound(upto),
        lastReceivedInbound: () => base.lastReceivedInbound(),
        applyInbound: (input) => base.applyInbound(input),
        outboundProof: (from, to) => base.outboundProof(from, to),
      },
      version: "edge",
    });
    try {
      await settle(() => headers.length > 0, 10_000);
      expect(headers[0]).toEqual({ v1: "2", v2: "1" });
    } finally {
      await client.stop();
      await new Promise<void>((resolve) =>
        sockets.close(() => server.close(() => resolve())),
      );
    }
  }, 15_000);
});

describe("legend-tmar2 854 f. a refusal from the cloud does not reset the reconnect backoff", () => {
  it("f. close reason 'Restore proof ...' from the cloud keeps the backoff growing", async () => {
    const server = createServer();
    const sockets = new WebSocketServer({ server, path: "/api/edge-link" });
    sockets.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "hello",
          version: "cloud",
          inboundCursor: "0",
        }),
      );
      // The cloud refuses a replayed slot (design point 5/6).
      setTimeout(
        () =>
          socket.close(
            1008,
            `${LINK_RESTORE_PROOF_REFUSAL} replayed slot 3 holds a different event; refusing to resume`,
          ),
        20,
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
    const base = new EdgeStore(seen, 2);
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
      const end = Date.now() + 15_000;
      while (waits.length < 3) {
        if (Date.now() > end) throw new Error("Backoff did not repeat");
        await new Promise((resolve) => realSetTimeout(resolve, 10));
      }
      expect(waits.slice(0, 3)).toEqual([1000, 2000, 4000]);
    } finally {
      spy.mockRestore();
      await client.stop();
      await new Promise<void>((resolve) =>
        sockets.close(() => server.close(() => resolve())),
      );
    }
  }, 20_000);
});

describe("legend-tmar2 854 g. hello frame stays strict with `to`", () => {
  const base = { type: "hello", version: "cloud", inboundCursor: "5" };
  const proof = {
    from: 2,
    to: "4",
    ...refProof(["0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b"]),
  };

  it("g. accepts a well-formed `to` and still accepts a proof without it", () => {
    expect(
      decodeFrame(JSON.stringify({ ...base, inboundProof: proof })),
    ).toMatchObject({ type: "hello", inboundProof: proof });
    const withoutTo = {
      from: proof.from,
      count: proof.count,
      sha256: proof.sha256,
    };
    expect(
      decodeFrame(JSON.stringify({ ...base, inboundProof: withoutTo })),
    ).not.toBeNull();
    expect(
      decodeFrame(
        JSON.stringify({ ...base, inboundProof: { ...proof, to: "0" } }),
      ),
    ).not.toBeNull();
  });

  it.each([
    ["unknown top-level field", { ...base, extra: 1 }],
    [
      "unknown field inside the proof next to `to`",
      { ...base, inboundProof: { ...proof, extra: 1 } },
    ],
    [
      "negative `to` (string)",
      { ...base, inboundProof: { ...proof, to: "-1" } },
    ],
    ["negative `to` (number)", { ...base, inboundProof: { ...proof, to: -1 } }],
    ["fractional `to`", { ...base, inboundProof: { ...proof, to: "1.5" } }],
    ["non-numeric `to`", { ...base, inboundProof: { ...proof, to: "abc" } }],
    ["empty `to`", { ...base, inboundProof: { ...proof, to: "" } }],
    ["`to` null", { ...base, inboundProof: { ...proof, to: null } }],
    [
      "`to` with leading zero",
      { ...base, inboundProof: { ...proof, to: "04" } },
    ],
  ])("g. rejects %s", (_name, frame) => {
    expect(decodeFrame(JSON.stringify(frame))).toBeNull();
  });
});
