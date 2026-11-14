// Link batches are capped by encoded bytes, not only by event count
// (legend-zy43 review): an offline backlog of large events must never produce
// a frame above LINK_MAX_FRAME_BYTES, or the peer closes the link and the same
// batch is resent forever, blocking every later event. Pure unit test: a
// minimal outbound LinkStore and a transport that records frames.
import { describe, expect, it } from "vitest";
import { createUlid } from "@starter/shared/core";
import type { EventEnvelope } from "@starter/shared/events";
import {
  createLinkPeer,
  type LinkStore,
  type QueuedEdgeEvent,
} from "../edge/link-peer.ts";
import {
  decodeFrame,
  encodeFrame,
  LINK_MAX_FRAME_BYTES,
} from "../edge/protocol.ts";

const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};

let clock = Date.parse("2026-11-14T10:00:00.000Z");
function bigEvent(sequence: number, bytes: number): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: scope.tenantId as EventEnvelope["tenantId"],
    outletId: scope.outletId as EventEnvelope["outletId"],
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId: `44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`,
    sequence: 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `key-${clock}-${sequence}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: { filler: "x".repeat(bytes) },
  };
}

function harness(events: EventEnvelope[]) {
  const queue: QueuedEdgeEvent[] = events.map((event, index) => ({
    linkSeq: index + 1,
    event,
  }));
  let acked = 0;
  // legend-btx4d: a dead-lettered event leaves the queue and the events behind
  // it are renumbered down by one. See edge-link-deadletter.test.ts.
  const deadLettered = new Set<number>();
  const store: LinkStore = {
    outboundHead: async () => queue.length,
    lastAckedOutbound: async () => acked,
    readOutbound: async (after, limit) =>
      queue.filter((q) => q.linkSeq > after).slice(0, limit),
    deadLetterOutbound: async (entry) => {
      const at = queue.findIndex((q) => q.event.id === entry.event.id);
      if (at < 0) return;
      deadLettered.add(entry.linkSeq);
      queue.splice(at, 1);
      queue.forEach((q, i) => {
        queue[i] = { ...q, linkSeq: i + 1 };
      });
    },
    ackOutbound: async (upto) => {
      acked = Math.max(acked, upto);
    },
    lastReceivedInbound: async () => 0,
    applyInbound: async () => undefined,
  };
  const frames: string[] = [];
  const closes: number[] = [];
  const errors: unknown[] = [];
  const alarms: unknown[] = [];
  const peer = createLinkPeer({
    scope,
    outboundDirection: "edge_to_cloud",
    store,
    version: "test",
    ackTimeoutMs: 60_000,
    transport: {
      send: (data) => frames.push(data),
      close: (code) => closes.push(code),
    },
    onError: (error) => errors.push(error),
    onDeadLetter: (entry) => alarms.push(entry),
  });
  const batches = () =>
    frames
      .map((frame) => decodeFrame(frame))
      .filter((frame) => frame?.type === "batch");
  async function drain(expectedBatches: number) {
    peer.receive(
      encodeFrame({ type: "hello", version: "cloud", inboundCursor: "0" }),
    );
    await peer.idle();
    for (let guard = 0; guard < 50; guard += 1) {
      const sent = batches();
      if (sent.length >= expectedBatches) return;
      const last = sent.at(-1);
      if (!last || last.type !== "batch") return;
      const batch = last.batch;
      peer.receive(
        encodeFrame({
          type: "ack",
          ack: {
            tenantId: batch.tenantId,
            outletId: batch.outletId,
            batchId: batch.id,
            peerId: batch.peerId,
            direction: batch.direction,
            cursor: batch.toCursor,
            lastEventId: batch.events.at(-1)!.id,
            acknowledgedAt: new Date(clock).toISOString(),
          },
        }),
      );
      await peer.idle();
    }
  }
  return { frames, closes, errors, alarms, deadLettered, batches, drain, peer };
}

describe("edge link batches are bounded by bytes", () => {
  it("legend-zy43 an offline backlog above 4 MB is split into frames under the cap, in order, none lost", async () => {
    // 12 events x 500 KB = 6 MB, all within the 100-event count limit.
    const events = Array.from({ length: 12 }, (_, i) =>
      bigEvent(i + 1, 500_000),
    );
    const h = harness(events);
    await h.drain(99);
    expect(h.closes).toEqual([]);
    for (const frame of h.frames)
      expect(frame.length).toBeLessThanOrEqual(LINK_MAX_FRAME_BYTES);
    const delivered = h
      .batches()
      .flatMap((frame) => (frame?.type === "batch" ? frame.batch.events : []));
    expect(delivered.map((event) => event.id)).toEqual(
      events.map((event) => event.id),
    );
    expect(h.batches().length).toBeGreaterThan(1);
  });

  // legend-btx4d (flipped from legend-zy43): a single event above the frame cap
  // used to stall the queue behind it with only a log line. Now it is moved to
  // the dead-letter store, one alarm goes out, and the queue keeps flowing.
  it("legend-btx4d a single event above the frame cap is dead-lettered, alarmed once, and the queue behind it is delivered", async () => {
    const big = bigEvent(1, 5 * 1024 * 1024);
    const small = bigEvent(2, 100);
    const h = harness([big, small]);
    await h.drain(1);
    expect(h.closes).toEqual([]);
    for (const frame of h.frames)
      expect(frame.length).toBeLessThanOrEqual(LINK_MAX_FRAME_BYTES);
    const delivered = h
      .batches()
      .flatMap((frame) => (frame?.type === "batch" ? frame.batch.events : []));
    expect(delivered.map((event) => event.id)).toEqual([small.id]);
    expect([...h.deadLettered]).toEqual([1]);
    expect(h.alarms).toHaveLength(1);
  });
});
