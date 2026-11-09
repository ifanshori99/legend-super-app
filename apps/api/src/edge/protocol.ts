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
export const LINK_PATH = "/api/edge-link";

export const linkCursorSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,15})$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

const text = z.string().min(1).max(255);

export const linkFrameSchema = z.discriminatedUnion("type", [
  /** First frame of each side: where this side's inbound stream resumes. */
  z.strictObject({
    type: z.literal("hello"),
    version: text,
    inboundCursor: linkCursorSchema,
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
