// legend-3k41y: the cloud side of a link warns (never rejects) when an edge
// says hello with a version below the first image that carries the
// cloud_to_edge edge_link.dead_lettered no-op applier, so a release-order
// violation ("update all edges before the cloud") is visible.
// Assumptions (from the brief, not the implementation):
// - EDGE_LINK_PLACEHOLDER_MIN_VERSION is "0.2.0", exported from
//   @starter/shared/edge; isEdgeVersionBelow(version, min) is exported from
//   ../edge/link-peer.ts; createLinkPeer takes an optional onWarning(info)
//   with info.peerVersion and info.minVersion.
// - Only the cloud side (outboundDirection "cloud_to_edge") warns, once per
//   hello; unparseable versions ("dev", "edge", "") never warn.
// No database: fake in-memory store and transport.
import { randomUUID } from "node:crypto";
import { createUlid } from "@starter/shared/core";
import { EDGE_LINK_PLACEHOLDER_MIN_VERSION } from "@starter/shared/edge";
import type { EventEnvelope } from "@starter/shared/events";
import { describe, expect, it } from "vitest";
import {
  createLinkPeer,
  isEdgeVersionBelow,
  type LinkPeerOptions,
  type LinkStore,
} from "../edge/link-peer.ts";
import { decodeFrame, encodeFrame } from "../edge/protocol.ts";

const scope = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  outletId: "22222222-2222-4222-8222-222222222222",
  edgeNodeId: "33333333-3333-4333-8333-333333333333",
};

let clock = Date.parse("2026-11-14T12:00:00.000Z");
function makeEvent(sequence: number): EventEnvelope {
  clock += 1;
  return {
    id: createUlid(clock),
    tenantId: scope.tenantId as EventEnvelope["tenantId"],
    outletId: scope.outletId as EventEnvelope["outletId"],
    name: "order.item_added",
    version: 1,
    aggregateType: "order",
    aggregateId: randomUUID(),
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `vw-${clock}-${sequence}`,
    payloadSchemaRef: "order.item_added.v1",
    payload: { marker: `m${sequence}` },
  };
}

function storeWith(events: EventEnvelope[]): LinkStore {
  let acked = 0;
  const queue = events.map((event, i) => ({ linkSeq: i + 1, event }));
  return {
    outboundHead: async () => queue.length,
    lastAckedOutbound: async () => acked,
    readOutbound: async (after: number, limit: number) =>
      queue.filter((q) => q.linkSeq > after).slice(0, limit),
    ackOutbound: async (upto: number) => {
      acked = Math.max(acked, upto);
    },
    lastReceivedInbound: async () => 0,
    applyInbound: async () => undefined,
  } as LinkStore;
}

type Warning = { peerVersion?: string; minVersion?: string };

function startPeer(
  outboundDirection: LinkPeerOptions["outboundDirection"],
  events: EventEnvelope[] = [],
) {
  const frames: string[] = [];
  const closes: number[] = [];
  const warnings: Warning[] = [];
  const errors: unknown[] = [];
  const peer = createLinkPeer({
    scope,
    outboundDirection,
    store: storeWith(events),
    version: outboundDirection === "cloud_to_edge" ? "cloud" : "0.2.0",
    ackTimeoutMs: 60_000,
    transport: {
      send: (data: string) => frames.push(data),
      close: (code: number) => closes.push(code),
    },
    onError: (error: unknown) => errors.push(error),
    onWarning: (info: Warning) => warnings.push(info),
  } as LinkPeerOptions);
  const batches = () =>
    frames
      .map((frame) => decodeFrame(frame))
      .flatMap((frame) => (frame?.type === "batch" ? [frame.batch] : []));
  const hello = async (version: string) => {
    peer.receive(encodeFrame({ type: "hello", version, inboundCursor: "0" }));
    await peer.idle();
  };
  return { peer, frames, closes, warnings, errors, batches, hello };
}

describe("legend-3k41y isEdgeVersionBelow", () => {
  it("exposes the placeholder minimum as 0.2.0", () => {
    expect(EDGE_LINK_PLACEHOLDER_MIN_VERSION).toBe("0.2.0");
  });

  it.each([
    ["0.1.9", "0.2.0", true],
    ["0.1.0", "0.2.0", true],
    ["0.2.0", "0.2.0", false],
    ["0.10.0", "0.2.0", false], // numeric, not lexical, compare
    ["1.0.0", "0.2.0", false],
    ["0.2.0-rc1", "0.2.0", false], // prerelease treated as 0.2.0
    ["0.1.9+build5", "0.2.0", true], // build metadata ignored
    ["dev", "0.2.0", false],
    ["edge", "0.2.0", false],
    ["test", "0.2.0", false],
    ["", "0.2.0", false],
  ])("isEdgeVersionBelow(%j, %j) is %s", (version, min, expected) => {
    expect(isEdgeVersionBelow(version, min)).toBe(expected);
  });
});

describe("legend-3k41y cloud side hello version warning", () => {
  it("warns once with the peer version when the edge is below the minimum", async () => {
    const { hello, warnings, closes } = startPeer("cloud_to_edge");
    await hello("0.1.0");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.peerVersion).toBe("0.1.0");
    expect(warnings[0]?.minVersion).toBe(EDGE_LINK_PLACEHOLDER_MIN_VERSION);
    expect(closes).toEqual([]);
  });

  it("warns once per hello, so a reconnect hello warns again", async () => {
    const { hello, warnings } = startPeer("cloud_to_edge");
    await hello("0.1.9");
    await hello("0.1.9");
    expect(warnings).toHaveLength(2);
  });

  it.each(["0.2.0", "0.10.0", "1.0.0", "0.2.0-rc1", "dev", "edge"])(
    "does not warn for edge version %j",
    async (version) => {
      const { hello, warnings, closes } = startPeer("cloud_to_edge");
      await hello(version);
      expect(warnings).toEqual([]);
      expect(closes).toEqual([]);
    },
  );

  it("never warns on the edge side, whatever the cloud version says", async () => {
    const { hello, warnings, closes } = startPeer("edge_to_cloud");
    await hello("0.1.0");
    expect(warnings).toEqual([]);
    expect(closes).toEqual([]);
  });

  it("keeps the link working after a warned hello: queued events are sent", async () => {
    const event = makeEvent(1);
    const { hello, warnings, batches, closes, errors } = startPeer(
      "cloud_to_edge",
      [event],
    );
    await hello("0.1.0");
    expect(warnings).toHaveLength(1);
    expect(batches()).toHaveLength(1);
    expect(batches()[0]?.events.map((e) => e.id)).toEqual([event.id]);
    expect(closes).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("sends the same batch as for an unwarned hello", async () => {
    const event = makeEvent(1);
    const old = startPeer("cloud_to_edge", [event]);
    const current = startPeer("cloud_to_edge", [event]);
    await old.hello("0.1.0");
    await current.hello("0.2.0");
    expect(old.batches().map((b) => b.events.map((e) => e.id))).toEqual(
      current.batches().map((b) => b.events.map((e) => e.id)),
    );
  });

  it("a throwing onWarning handler does not break or close the link", async () => {
    const event = makeEvent(1);
    const frames: string[] = [];
    const closes: number[] = [];
    const peer = createLinkPeer({
      scope,
      outboundDirection: "cloud_to_edge",
      store: storeWith([event]),
      version: "cloud",
      ackTimeoutMs: 60_000,
      transport: {
        send: (data: string) => frames.push(data),
        close: (code: number) => closes.push(code),
      },
      onError: () => undefined,
      onWarning: () => {
        throw new Error("logging sink down");
      },
    } as LinkPeerOptions);
    peer.receive(
      encodeFrame({ type: "hello", version: "0.1.0", inboundCursor: "0" }),
    );
    await peer.idle();
    expect(closes).toEqual([]);
    expect(
      frames.map((f) => decodeFrame(f)).filter((f) => f?.type === "batch"),
    ).toHaveLength(1);
  });
});
