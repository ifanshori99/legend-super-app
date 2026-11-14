// One side of the cloud <-> edge link (bead legend-2pi; PRD v1.7 §3 F5
// "Sinkronisasi": per-direction outbox, unique ULID event ids, idempotent,
// ordered per aggregate, resumable after a disconnect; EDG-02 contract).
//
// Transport-agnostic: the WebSocket server (cloud) and client (edge) both
// wrap a socket in a LinkTransport and feed it frames; tests use an
// in-memory pair. Durable state lives behind LinkStore (Postgres in
// production, db-link-store.ts).
//
// Protocol (per direction; each side is sender of one and receiver of the
// other):
//   - On connect each side sends `hello` with the cursor its INBOUND stream
//     resumes from (highest contiguous link_seq durably applied).
//   - The sender treats the peer's hello cursor as a cumulative ack, then
//     sends queued events from there, one batch in flight at a time
//     (stop-and-wait keeps strict order with a trivial window).
//   - The receiver applies a batch only when it starts exactly at its cursor:
//     a batch beyond the cursor is a gap -> `resend` from the cursor; a batch
//     wholly at or below it is a duplicate -> re-acknowledged, not re-applied;
//     an overlapping one is applied from the cursor on. Applying, receipts
//     and the cursor advance commit in one transaction, then `ack`.
//   - A lost batch or ack is resent after `ackTimeoutMs` (go-back to the last
//     ack). Duplicates that result are absorbed by the cursor and by the event
//     id receipts, so delivery is exactly-once in effect: no loss, no dup.
//   - A peer cursor ahead of everything this side ever queued (a restored
//     snapshot) would make new events look like duplicates and silently drop
//     them, so it closes the link (fail closed) for operator recovery.
import { createUlid } from "@starter/shared/core";
import type { EventEnvelope, SyncDirection } from "@starter/shared/events";
import {
  EDGE_LINK_PLACEHOLDER_MIN_VERSION,
  type SyncAck,
  type SyncBatch,
} from "@starter/shared/edge";
import { logger } from "../lib/logger.ts";
import {
  LINK_BATCH_MAX_BYTES,
  LINK_BATCH_SIZE,
  LINK_CLOSE,
  LINK_RESTORE_PROOF_REFUSAL,
  decodeFrame,
  encodeFrame,
  oppositeDirection,
  type LinkFrame,
} from "./protocol.ts";

/**
 * Frames received but not yet processed before the peer is closed with
 * LINK_CLOSE.overloaded (legend-wg5t #1). Stop-and-wait means a well-behaved
 * peer has about one batch plus a few acks, resends and heartbeats in flight.
 */
export const LINK_MAX_PENDING_FRAMES = 32;

const PLAIN_SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/**
 * True when `version` is plain semver (x.y.z, -prerelease/+build ignored) and
 * lower than `min`. Unparseable versions (dev, test labels) are never below.
 */
export function isEdgeVersionBelow(version: string, min: string): boolean {
  const v = PLAIN_SEMVER.exec(version);
  const m = PLAIN_SEMVER.exec(min);
  if (!v || !m) return false;
  for (let i = 1; i <= 3; i += 1) {
    const a = Number(v[i]);
    const b = Number(m[i]);
    if (a !== b) return a < b;
  }
  return false;
}

export type LinkPeerWarning = {
  readonly message: string;
  readonly peerVersion: string;
  readonly minVersion: string;
  readonly tenantId: string;
  readonly outletId: string;
  readonly edgeNodeId: string;
};

export type QueuedEdgeEvent = {
  readonly linkSeq: number;
  readonly event: EventEnvelope;
};

/**
 * An outbound event that can never be delivered (legend-btx4d): kept whole,
 * with its size and the sequence it had, so nothing is lost when it leaves the
 * queue.
 */
export type DeadLetterEntry = {
  readonly linkSeq: number;
  readonly event: EventEnvelope;
  /** Encoded size in bytes. */
  readonly bytes: number;
  readonly reason: "frame_too_large";
};

/** Durable state of one node's link on this side. */
export type LinkStore = {
  /** Highest link_seq ever assigned in the outbound direction. */
  outboundHead(): Promise<number>;
  lastAckedOutbound(): Promise<number>;
  /** Queued events with link_seq > afterSeq (acked or not), ascending. */
  readOutbound(afterSeq: number, limit: number): Promise<QueuedEdgeEvent[]>;
  /**
   * Optional (legend-btx4d): moves the queue's HEAD event (the next one to
   * send; nothing behind it was ever sent) out of the queue into the
   * dead-letter store, whole and recorded once per event, and renumbers the
   * events behind it so readOutbound stays contiguous (link_seq - 1). Replay
   * of an event already dead-lettered is a no-op. Without it, an event above
   * the frame cap only raises onError and holds the queue.
   */
  deadLetterOutbound?(entry: DeadLetterEntry): Promise<void>;
  /** Cumulative: every event up to `uptoSeq` is durably applied by the peer. */
  ackOutbound(uptoSeq: number): Promise<void>;
  lastReceivedInbound(): Promise<number>;
  /**
   * Applies `events` (link sequences fromSeq+1 .. toSeq) with the conflict
   * rules, records receipts and advances the inbound cursor to toSeq in ONE
   * transaction. Must throw and change nothing if the stored cursor is not
   * fromSeq or any apply fails.
   */
  applyInbound(input: {
    fromSeq: number;
    toSeq: number;
    events: readonly QueuedEdgeEvent[];
  }): Promise<void>;
  /**
   * Optional (legend-nd3cu): settles both directions' numbering from the
   * peer's hello cursor before any cursor is used, e.g. the cloud rebasing
   * onto a rebuilt edge database. When present, this side's own hello waits
   * for the peer's (the peer sends its hello unconditionally on connect), so
   * the cursor it announces is already settled. Throw LinkProtocolError to
   * refuse the link.
   */
  onPeerHello?(peerCursor: number): Promise<void>;
  /**
   * Optional, edge (legend-tmar2): proof over the outbound events with
   * link_seq in (fromSeq, toSeq], ascending (acked rows included), computed
   * with `restoreProofOf` in this side's own numbering. Rows missing from the
   * range show up as a lower count.
   */
  outboundProof?(fromSeq: number, toSeq: number): Promise<RestoreProof>;
  /**
   * Optional, cloud (legend-tmar2): proof over the receipts
   * of events the edge sent with link_seq in (fromSeq, toSeq] in the EDGE's
   * numbering (the store adds the peer offset), ascending. The store proves
   * the longest complete prefix of the range (slots fromSeq+1..fromSeq+k, k
   * may be 0, capped by its own limit) and returns where it ends in `to`.
   * Null only when toSeq < fromSeq. The hello always carries the result:
   * a hole or an oversized range yields a shorter proof, never none.
   */
  inboundProof?(
    fromSeq: number,
    toSeq: number,
  ): Promise<(RestoreProof & { to: number }) | null>;
  /**
   * Optional, cloud (legend-tmar2 854): checks the part of an edge batch that
   * lies at or below the cloud's received cursor (a replay) against the
   * receipts, in the edge's numbering. Resolves when every slot holds the
   * same event (a missing receipt of a registered event is filled in).
   * Throws LinkProtocolError (reason starting with LINK_RESTORE_PROOF_REFUSAL)
   * when a slot holds a different or unknown event: nothing is acknowledged.
   */
  reconcileReplay?(input: {
    events: readonly { linkSeq: number; event: EventEnvelope }[];
  }): Promise<void>;
};

export type RestoreProof = { count: number; sha256: string };
type HelloProof = RestoreProof & { from: number; to?: string };

export type LinkTransport = {
  send(data: string): void;
  close(code: number, reason: string): void;
};

export type LinkScope = {
  readonly tenantId: string;
  readonly outletId: string;
  /** The edge node this link belongs to (batch/ack `peerId` on both sides). */
  readonly edgeNodeId: string;
};

export type LinkPeerOptions = {
  scope: LinkScope;
  /** Direction this side SENDS: edge -> `edge_to_cloud`, cloud -> `cloud_to_edge`. */
  outboundDirection: SyncDirection;
  store: LinkStore;
  transport: LinkTransport;
  version: string;
  batchSize?: number;
  ackTimeoutMs?: number;
  /** Backpressure bound on unprocessed received frames (legend-wg5t #1). */
  maxPendingFrames?: number;
  now?: () => Date;
  /**
   * Cloud only (legend-tmar2): the edge's acked_out_seq A from the upgrade
   * header. When set (a modern edge) and the cloud's inbound cursor N is above
   * it, the hello carries `inboundProof` from `store.inboundProof`, with
   * `from` = A and `to` only when the proof stops short of N (strict only, see
   * `restoreProofStrict`; replayed batches are then checked by
   * `store.reconcileReplay`).
   */
  restoreProofAcked?: number;
  /**
   * Cloud only (legend-tmar2 854), valid only with `restoreProofAcked`: the
   * edge sent `x-edge-restore-proof-v2`, so it takes a partial or empty proof
   * (`to`) and the cloud checks replayed batches. Without it (an 848 edge) the
   * hello carries a proof only when it covers the whole range (to == cursor),
   * else none, and replays are not checked: the 848 behaviour.
   */
  restoreProofStrict?: boolean;
  /**
   * Edge only (legend-tmar2 854): the edge sent the restore proof headers, so a
   * hello that would ack (cursor above the acked cursor) must carry a proof.
   * Without one nothing is acked and the link is refused (reason starting with
   * LINK_RESTORE_PROOF_REFUSAL). Unset: the old behaviour (ack the cursor).
   */
  requireRestoreProof?: boolean;
  /**
   * Edge only, with `requireRestoreProof`: the upgrade response echoed
   * `x-edge-restore-proof-v2`, so the cloud supports the proof. Only changes
   * the refusal message (old cloud vs. a cloud that broke the contract).
   */
  peerEchoesRestoreProof?: boolean;
  /** Store/apply failures (no secrets in the error). The link stays up. */
  onError?: (error: unknown) => void;
  /** After an event was moved to the dead-letter store (once per event). */
  onDeadLetter?: (entry: DeadLetterEntry) => void;
  onHeartbeat?: (frame: Extract<LinkFrame, { type: "heartbeat" }>) => void;
  /** After the peer acknowledged up to `cursor` (for status/notifications). */
  onAcked?: (cursor: number) => void;
  /**
   * Cloud side only: the edge's hello reports a version below the first one
   * with the brand-move placeholder applier. Never rejects the link; defaults
   * to logger.warn.
   */
  onWarning?: (info: LinkPeerWarning) => void;
};

export class LinkProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkProtocolError";
  }
}

export type LinkPeer = {
  /** Send hello; call once the transport is open. */
  start(): void;
  /** Feed one raw frame received from the transport. */
  receive(raw: string): void;
  /** New events were queued: send them if the link is idle. */
  notify(): void;
  /** Transport closed or shutting down: stop timers, ignore later frames. */
  stop(): void;
  /** Resolves when every frame handled so far has been processed (tests). */
  idle(): Promise<void>;
};

export function createLinkPeer(options: LinkPeerOptions): LinkPeer {
  const { scope, store, transport } = options;
  const outbound = options.outboundDirection;
  const inbound = oppositeDirection(outbound);
  const batchSize = Math.min(
    options.batchSize ?? LINK_BATCH_SIZE,
    LINK_BATCH_SIZE,
  );
  const ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
  const maxPendingFrames = options.maxPendingFrames ?? LINK_MAX_PENDING_FRAMES;
  const now = options.now ?? (() => new Date());
  let pendingFrames = 0;
  let ready = false;
  let stopped = false;
  let sentUpTo = 0;
  let ackedUpTo = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const send = (frame: LinkFrame) => {
    if (!stopped) transport.send(encodeFrame(frame));
  };

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function stop() {
    stopped = true;
    ready = false;
    clearTimer();
  }

  function enqueue(work: () => Promise<void>) {
    chain = chain.then(async () => {
      if (stopped) return;
      try {
        await work();
      } catch (error) {
        if (error instanceof LinkProtocolError) {
          stop();
          transport.close(LINK_CLOSE.protocol, error.message);
          return;
        }
        options.onError?.(error);
      }
    });
  }

  function assertScope(
    frame: {
      tenantId: string;
      outletId: string;
      peerId: string;
      direction: SyncDirection;
    },
    direction: SyncDirection,
  ) {
    if (
      frame.tenantId !== scope.tenantId ||
      frame.outletId !== scope.outletId ||
      frame.peerId !== scope.edgeNodeId ||
      frame.direction !== direction
    )
      throw new LinkProtocolError("Frame outside the link scope");
  }

  function armTimer() {
    clearTimer();
    timer = setTimeout(() => {
      enqueue(async () => {
        // Go-back: resend everything after the last acknowledgement. The
        // receiver's cursor absorbs whatever had in fact arrived.
        if (sentUpTo > ackedUpTo) {
          sentUpTo = ackedUpTo;
          await pump();
        }
      });
    }, ackTimeoutMs);
    timer.unref?.();
  }

  async function pump() {
    if (!ready || stopped || sentUpTo > ackedUpTo) return;
    let queued: QueuedEdgeEvent[] = [];
    for (;;) {
      const read = await store.readOutbound(sentUpTo, batchSize);
      if (read.length === 0) return;
      read.forEach((item, index) => {
        if (item.linkSeq !== sentUpTo + 1 + index)
          throw new LinkProtocolError("Outbound queue is not contiguous");
      });
      // A batch frame must stay under the peer's frame cap, or the peer closes
      // the link and the same batch is resent forever, blocking every later
      // event. Take events while the encoded bytes fit, at least one.
      queued = [];
      let bytes = 0;
      for (const item of read) {
        const size = Buffer.byteLength(JSON.stringify(item.event));
        if (queued.length > 0 && bytes + size > LINK_BATCH_MAX_BYTES) break;
        queued.push(item);
        bytes += size;
      }
      if (bytes <= LINK_BATCH_MAX_BYTES) break;
      // One event alone above the bound can never be delivered (the peer
      // would close the link on every attempt). It is the head of the queue,
      // so nothing behind it was sent: move it whole to the dead-letter store
      // and alarm once (legend-btx4d); the store renumbers the queue behind
      // it, then the loop reads again. Never dropped: a sale or a payment
      // stays readable there. A store without dead-lettering keeps the old
      // behavior: fail loud, send nothing, the queue waits in order.
      const head = queued[0]!;
      if (!store.deadLetterOutbound) {
        options.onError?.(
          new LinkProtocolError("Outbound event exceeds the link frame limit"),
        );
        return;
      }
      const entry: DeadLetterEntry = {
        linkSeq: head.linkSeq,
        event: head.event,
        bytes,
        reason: "frame_too_large",
      };
      await store.deadLetterOutbound(entry);
      options.onDeadLetter?.(entry);
    }
    const toSeq = sentUpTo + queued.length;
    const batch: SyncBatch = {
      tenantId: scope.tenantId as SyncBatch["tenantId"],
      outletId: scope.outletId as SyncBatch["outletId"],
      id: createUlid(now().getTime()),
      peerId: scope.edgeNodeId,
      direction: outbound,
      fromCursor: String(sentUpTo),
      toCursor: String(toSeq),
      events: queued.map((item) => item.event),
    };
    send({ type: "batch", batch });
    sentUpTo = toSeq;
    armTimer();
  }

  function sendAck(batch: SyncBatch, cursor: number) {
    const last = batch.events.at(-1);
    if (!last) return;
    const ack: SyncAck = {
      tenantId: batch.tenantId,
      outletId: batch.outletId,
      batchId: batch.id,
      peerId: batch.peerId,
      direction: batch.direction,
      cursor: String(cursor),
      lastEventId: last.id,
      acknowledgedAt: now().toISOString(),
    };
    send({ type: "ack", ack });
  }

  let helloSent = false;
  async function sendHello() {
    const cursor = await store.lastReceivedInbound();
    // Cloud only: the edge announced its acked cursor A (upgrade header), so
    // when our inbound cursor N is beyond it, prove which events fill (A, N].
    // Strict (854 edge): the longest complete prefix, possibly empty, never
    // omitted. Not strict (848 edge): only a proof of the whole range, else the
    // hello carries none (the 848 fail-open for incomplete history).
    const proofAcked = options.restoreProofAcked;
    const strict = options.restoreProofStrict === true;
    const found =
      proofAcked !== undefined && cursor > proofAcked && store.inboundProof
        ? await store.inboundProof(proofAcked, cursor)
        : null;
    const proof = found && (strict || found.to === cursor) ? found : null;
    helloSent = true;
    send({
      type: "hello",
      version: options.version,
      inboundCursor: String(cursor),
      ...(proof && proofAcked !== undefined
        ? {
            inboundProof: {
              from: proofAcked,
              // Omitted for the whole range so an 848 edge still
              // accepts it; only a partial or empty proof says where it ends.
              ...(proof.to !== cursor ? { to: String(proof.to) } : {}),
              count: proof.count,
              sha256: proof.sha256,
            },
          }
        : {}),
    });
  }

  function warnIfEdgeTooOld(peerVersion: unknown) {
    if (outbound !== "cloud_to_edge" || typeof peerVersion !== "string") return;
    if (!isEdgeVersionBelow(peerVersion, EDGE_LINK_PLACEHOLDER_MIN_VERSION))
      return;
    const info: LinkPeerWarning = {
      message:
        "Edge below placeholder version; a brand move can stall panic alerts until it is upgraded",
      peerVersion,
      minVersion: EDGE_LINK_PLACEHOLDER_MIN_VERSION,
      tenantId: scope.tenantId,
      outletId: scope.outletId,
      edgeNodeId: scope.edgeNodeId,
    };
    try {
      if (options.onWarning) options.onWarning(info);
      else {
        const { message, ...fields } = info;
        logger.warn(fields, message);
      }
    } catch {
      // A warning must never affect the link.
    }
  }

  async function onHello(
    cursor: number,
    proof?: HelloProof,
    peerVersion?: unknown,
  ) {
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new LinkProtocolError("Hello cursor is not a sequence");
    warnIfEdgeTooOld(peerVersion);
    if (store.onPeerHello) {
      try {
        await store.onPeerHello(cursor);
        if (!helloSent) await sendHello();
      } catch (error) {
        if (error instanceof LinkProtocolError) throw error;
        // A transient failure (database blip) before our hello would leave
        // the peer waiting on an open socket forever: close so it retries.
        options.onError?.(error);
        stop();
        transport.close(LINK_CLOSE.overloaded, "Link not ready; retry");
        return;
      }
    }
    const head = await store.outboundHead();
    if (cursor > head)
      throw new LinkProtocolError(
        "Peer cursor is ahead of this side's queue; refusing to resume",
      );
    const acked = await store.lastAckedOutbound();
    // Highest slot the peer's hello may count as acknowledged: the whole
    // cursor, or the end of a partial proof (the rest is sent again).
    let ackTo = cursor;
    if (cursor > acked) {
      // Restore proof (legend-tmar2): the cursor may only count as an ack when
      // the events in (acked, cursor] are the ones the peer holds. Checked
      // before ackOutbound: a mismatch acks nothing and reports nothing.
      // The range starts at the proof's own `from` (the acked cursor the edge
      // announced), not at the current acked: an ack that finished after the
      // header was read must not cause a false refusal.
      if (proof && store.outboundProof) {
        const proofTo = proof.to === undefined ? cursor : Number(proof.to);
        if (proof.from > acked)
          throw new LinkProtocolError(
            `${LINK_RESTORE_PROOF_REFUSAL} from ${proof.from} is beyond the acknowledged cursor; refusing to resume`,
          );
        if (proofTo < proof.from || proofTo > cursor)
          throw new LinkProtocolError(
            `${LINK_RESTORE_PROOF_REFUSAL} to ${proofTo} is outside the proven range; refusing to resume`,
          );
        const local = await store.outboundProof(proof.from, proofTo);
        if (local.count !== proof.count || local.sha256 !== proof.sha256)
          throw new LinkProtocolError(
            `${LINK_RESTORE_PROOF_REFUSAL} mismatch: events in the acknowledged range differ from the peer's; refusing to resume`,
          );
        ackTo = proofTo;
      } else if (options.requireRestoreProof) {
        // No proof, nothing acked: an old cloud cannot prove the range and a
        // modern one must. Thrown before ackOutbound/onAcked.
        throw new LinkProtocolError(
          options.peerEchoesRestoreProof
            ? `${LINK_RESTORE_PROOF_REFUSAL} missing: the cloud supports it but sent none; refusing to resume`
            : `${LINK_RESTORE_PROOF_REFUSAL} unsupported: cloud does not support restore proof; upgrade cloud first`,
        );
      }
      if (ackTo > acked) {
        await store.ackOutbound(ackTo);
        options.onAcked?.(ackTo);
      }
    }
    // A cursor below our ack means the peer restored older state: resend
    // from where it is (the rows are still queued unless pruned). A partial
    // proof acks only up to ackTo, so (ackTo, cursor] is sent again.
    sentUpTo = ackTo;
    ackedUpTo = ackTo;
    ready = true;
    await pump();
  }

  async function onBatch(batch: SyncBatch) {
    assertScope(batch, inbound);
    const fromSeq = Number(batch.fromCursor ?? "0");
    const toSeq = Number(batch.toCursor);
    if (
      !Number.isSafeInteger(fromSeq) ||
      !Number.isSafeInteger(toSeq) ||
      toSeq - fromSeq !== batch.events.length
    )
      throw new LinkProtocolError("Batch cursors do not match its events");
    const last = await store.lastReceivedInbound();
    if (fromSeq > last) {
      // Gap: something before this batch never arrived.
      send({ type: "resend", direction: inbound, fromCursor: String(last) });
      return;
    }
    // A strict edge (854, restore proof v2 header): the part of the batch at or below
    // our cursor may hold slots whose receipt never closed or whose event is
    // not the one we hold, so check it before acknowledging anything.
    const replayEnd = Math.min(last, toSeq);
    if (
      options.restoreProofAcked !== undefined &&
      options.restoreProofStrict === true &&
      store.reconcileReplay &&
      replayEnd > fromSeq
    ) {
      await store.reconcileReplay({
        events: batch.events
          .slice(0, replayEnd - fromSeq)
          .map((event, index) => ({ linkSeq: fromSeq + 1 + index, event })),
      });
    }
    if (toSeq <= last) {
      // Duplicate: already applied; acknowledge again, never re-apply.
      sendAck(batch, toSeq);
      return;
    }
    const skip = last - fromSeq;
    const events = batch.events
      .slice(skip)
      .map((event, index) => ({ linkSeq: last + 1 + index, event }));
    await store.applyInbound({ fromSeq: last, toSeq, events });
    sendAck(batch, toSeq);
  }

  async function onAck(ack: SyncAck) {
    assertScope(ack, outbound);
    const cursor = Number(ack.cursor);
    if (cursor <= ackedUpTo) return; // stale or repeated acknowledgement
    if (cursor > sentUpTo)
      throw new LinkProtocolError("Acknowledgement beyond what was sent");
    await store.ackOutbound(cursor);
    ackedUpTo = cursor;
    options.onAcked?.(cursor);
    if (ackedUpTo === sentUpTo) clearTimer();
    await pump();
  }

  async function onResend(direction: SyncDirection, from: number) {
    if (direction !== outbound)
      throw new LinkProtocolError("Resend for the wrong direction");
    if (from > sentUpTo)
      throw new LinkProtocolError("Resend beyond what was sent");
    sentUpTo = from;
    if (from < ackedUpTo) ackedUpTo = from;
    await pump();
  }

  async function handle(frame: LinkFrame) {
    switch (frame.type) {
      case "hello":
        return onHello(
          Number(frame.inboundCursor),
          frame.inboundProof,
          frame.version,
        );
      case "batch":
        if (!ready) throw new LinkProtocolError("Batch before hello");
        return onBatch(frame.batch);
      case "ack":
        if (!ready) throw new LinkProtocolError("Ack before hello");
        return onAck(frame.ack);
      case "resend":
        if (!ready) throw new LinkProtocolError("Resend before hello");
        return onResend(frame.direction, Number(frame.fromCursor));
      case "heartbeat":
        options.onHeartbeat?.(frame);
        return;
    }
  }

  return {
    start() {
      // With onPeerHello the hello goes out from onHello instead.
      if (!store.onPeerHello) enqueue(sendHello);
    },
    receive(raw) {
      const frame = decodeFrame(raw, outbound === "edge_to_cloud");
      if (!frame) {
        stop();
        transport.close(LINK_CLOSE.protocol, "Invalid frame");
        return;
      }
      // The chain processes one frame at a time, so a flood would otherwise
      // pile up in memory (and in store/DB work) without bound (legend-wg5t #1).
      if (pendingFrames >= maxPendingFrames) {
        stop();
        transport.close(LINK_CLOSE.overloaded, "Too many pending frames");
        return;
      }
      pendingFrames += 1;
      enqueue(async () => {
        try {
          await handle(frame);
        } finally {
          pendingFrames -= 1;
        }
      });
    },
    notify() {
      enqueue(pump);
    },
    stop,
    idle: () => chain,
  };
}
