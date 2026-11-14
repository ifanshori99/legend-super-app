// Wire frames of the persistent cloud <-> edge link (bead legend-2pi; PRD
// v1.7 §3 F5 "Sinkronisasi", §7 realtime "koneksi persisten"). Batches and
// acknowledgements are the shared EDG-02 contract (`syncBatchSchema`,
// `syncAckSchema` in @starter/shared/edge); this file only adds the link
// control frames around them. Every frame is strict JSON, validated on
// receipt; an invalid frame closes the connection (1008).
//
// Cursors are decimal link sequence numbers. Each direction of a link has its
// own gap-free sequence (sync_cursors.next_out_seq), so a batch whose
// `fromCursor` is N carries link sequences N+1 .. toCursor, one per event.
import { createHash } from "node:crypto";
import { z, isoDateTimeSchema } from "@starter/shared/core";
import {
  syncDirectionSchema,
  type SyncDirection,
} from "@starter/shared/events";
import { syncAckSchema, syncBatchSchema } from "@starter/shared/edge";

/** Max events per batch frame; bounds frame size and apply transaction size. */
export const LINK_BATCH_SIZE = 100;
/** Max encoded frame; the ws server's maxPayload uses the same bound. */
export const LINK_MAX_FRAME_BYTES = 4 * 1024 * 1024;
/**
 * Max encoded bytes of the events in one batch frame: the frame cap minus 1 MiB
 * of headroom for the batch fields and the framing. A batch always carries at
 * least one event; a single event above this bound is not sent (link-peer.ts).
 */
export const LINK_BATCH_MAX_BYTES = LINK_MAX_FRAME_BYTES - 1024 * 1024;
export const LINK_PATH = "/api/edge-link";

export const linkCursorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

const text = z.string().min(1).max(255);

/**
 * Critical catalog streams stale for over 30 minutes while the edge reaches
 * the cloud (legend-10nex). `staleSince` is the last successful pull (the
 * first failure when there never was one): stable for the whole episode, so
 * the cloud derives one notification per edge, stream and episode from it.
 */
export const catalogStaleSchema = z
  .array(
    z.strictObject({
      stream: text,
      staleSince: isoDateTimeSchema,
      reason: text,
    }),
  )
  .max(16);
export type CatalogStale = z.infer<typeof catalogStaleSchema>;

const restoreProofSchema = z.strictObject({
  /** The edge's acked cursor A the proof starts after (cloud echoes the header). */
  from: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /**
   * Last slot the proof covers. Omitted when it equals the hello's
   * inboundCursor (the whole range, the shape an older edge accepts); only a
   * partial or empty proof carries it.
   */
  to: linkCursorSchema.optional(),
  count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const linkFrameSchema = z.discriminatedUnion("type", [
  /** First frame of each side: where this side's inbound stream resumes. */
  z.strictObject({
    type: z.literal("hello"),
    version: text,
    inboundCursor: linkCursorSchema,
    /**
     * Optional, cloud -> edge only, and only when the edge sent
     * LINK_RESTORE_PROOF_HEADER (legend-tmar2): proof of the events in
     * (from, inboundCursor], `from` being the edge's acked cursor. Release order: cloud first
     * (an older edge never sends the header, so never receives the field).
     */
    inboundProof: restoreProofSchema.optional(),
  }),
  z.strictObject({ type: z.literal("batch"), batch: syncBatchSchema }),
  z.strictObject({ type: z.literal("ack"), ack: syncAckSchema }),
  /** Receiver saw a gap: resend `direction` from (exclusive) this cursor. */
  z.strictObject({
    type: z.literal("resend"),
    direction: syncDirectionSchema,
    fromCursor: linkCursorSchema,
  }),
  /** Edge -> cloud liveness and reported version (PRD §3 F5 heartbeat). */
  z.strictObject({
    type: z.literal("heartbeat"),
    version: text,
    occurredAt: isoDateTimeSchema,
    /**
     * Optional and omitted when empty: an older edge never sends it. Release
     * order: cloud first, then edge (the frame is strict, an older cloud
     * refuses the field; the edge holds it back while its catalog pull says
     * the cloud is outdated).
     */
    catalogStale: catalogStaleSchema.optional(),
    /** Missing local maintenance configuration; roll out cloud before edge. */
    auditRetentionDisabled: z.boolean().optional(),
  }),
]);
export type LinkFrame = z.infer<typeof linkFrameSchema>;

export function encodeFrame(frame: LinkFrame): string {
  return JSON.stringify(linkFrameSchema.parse(frame));
}

/** Null for anything that is not a valid frame (caller closes 1008). */
export function decodeFrame(raw: string): LinkFrame | null {
  if (raw.length > LINK_MAX_FRAME_BYTES) return null;
  try {
    const parsed = linkFrameSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function oppositeDirection(direction: SyncDirection): SyncDirection {
  return direction === "edge_to_cloud" ? "cloud_to_edge" : "edge_to_cloud";
}

/** WebSocket close codes used by the link (4000-4999 are application codes). */
export const LINK_CLOSE = {
  /** Invalid frame or protocol violation. */
  protocol: 1008,
  /** Credential refused or node revoked (EDG-03): the edge must not retry. */
  revoked: 4403,
  /** A newer connection of the same node replaced this one. */
  replaced: 4409,
  /** Server shutting down; retry with backoff. */
  shutdown: 1001,
  /**
   * The peer sent frames faster than they could be processed (legend-wg5t #1).
   * 1013 is "Try Again Later": the edge reconnects with backoff.
   */
  overloaded: 1013,
} as const;

/**
 * Header on an upgrade refusal that says the CREDENTIAL itself was refused
 * (legend-wg5t #6). Only this explicit signal stops the edge client from
 * retrying: a bare 401/403 can come from a WAF, proxy or captive portal in
 * front of the cloud and must not kill the outlet's sync for good.
 */
export const LINK_REFUSED_HEADER = "x-edge-link-refused";
export const LINK_REFUSED_CREDENTIAL = "credential";
/**
 * Upgrade header carrying the sending edge database's `edge_nodes.instance_id`
 * (legend-o839h). Informational: the cloud ignores a missing or malformed
 * value and never refuses the connection for it.
 */
export const LINK_INSTANCE_HEADER = "x-edge-instance";
/**
 * Upgrade header carrying the edge's `acked_out_seq` (decimal, edge numbering):
 * the point up to which the cloud has acknowledged the edge's outbound events.
 * With it the cloud proves in its hello which events fill the slots
 * (acked, inboundCursor] (`inboundProof`), so a database restored to the same
 * instance with different events in those slots is refused instead of acked
 * (legend-tmar2). A missing or malformed value means the old behaviour: no
 * proof, the edge acks the hello cursor as before.
 */
export const LINK_RESTORE_PROOF_HEADER = "x-edge-restore-proof";

/**
 * Sent next to LINK_RESTORE_PROOF_HEADER (value "1") by an edge that
 * understands a partial proof (`to`), checks replayed batches and keeps its
 * reconnect backoff after a refusal (legend-tmar2 854). The 848 edge sends only
 * the header above and gets the 848 behaviour: a hello proof only when it
 * covers the whole range (fail-open otherwise), no `to`, no replay check.
 */
export const LINK_RESTORE_PROOF_V2_HEADER = "x-edge-restore-proof-v2";

/**
 * Prefix of every close reason where the edge refuses a restore proof
 * (mismatch or invalid `from`). The edge client keeps its reconnect backoff
 * growing for such a refusal instead of resetting it on the open socket.
 */
export const LINK_RESTORE_PROOF_REFUSAL = "Restore proof";

/**
 * Proof over a run of event ids: the count and the SHA-256 (hex) of every id
 * as lowercase UUID followed by "\n", in link_seq order. Covers the whole
 * range, not only its last id.
 */
export function restoreProofOf(eventIds: Iterable<string>): {
  count: number;
  sha256: string;
} {
  const hash = createHash("sha256");
  let count = 0;
  for (const eventId of eventIds) {
    hash.update(`${eventId.toLowerCase()}\n`);
    count += 1;
  }
  return { count, sha256: hash.digest("hex") };
}

/** The acked cursor in the restore-proof header; null when absent or malformed. */
export function restoreProofAckedFromHeader(
  value: string | string[] | undefined,
): number | null {
  if (typeof value !== "string") return null;
  const parsed = linkCursorSchema.safeParse(value);
  return parsed.success ? Number(parsed.data) : null;
}
