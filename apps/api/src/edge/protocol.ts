// Wire frames of the persistent cloud <-> edge link (bead legend-2pi; PRD
// v1.7 §3 F5 "Sinkronisasi", §7 realtime "koneksi persisten"). Batches and
// acknowledgements are the shared EDG-02 contract (`syncBatchSchema`,
// `syncAckSchema` in @starter/shared/edge); this file only adds the link
// control frames around them. The cloud validates strict frames; the edge
// discards unknown fields from incoming cloud frames. Invalid known fields
// close the connection (1008).
//
// Cursors are decimal link sequence numbers. Each direction of a link has its
// own gap-free sequence (sync_cursors.next_out_seq), so a batch whose
// `fromCursor` is N carries link sequences N+1 .. toCursor, one per event.
import { z, isoDateTimeSchema } from "@starter/shared/core";
import {
  syncDirectionSchema,
  eventActorSchema,
  eventEnvelopeBaseSchema,
  checkEnvelopeRules,
  type SyncDirection,
} from "@starter/shared/events";
import { syncAckSchema, syncBatchSchema } from "@starter/shared/edge";
import { hasUnsafeSnapshotFields } from "@starter/shared/edge/snapshot-safety";

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
// Only the edge's inbound decoder discards fields introduced by a newer cloud.
// The common wire contract stays strict for frames received by the cloud.
const edgeInboundActorSchema = z.discriminatedUnion("type", [
  eventActorSchema.options[0].strip(),
  eventActorSchema.options[1].strip(),
  eventActorSchema.options[2].strip(),
  eventActorSchema.options[3].strip(),
  eventActorSchema.options[4].strip(),
]);
const edgeInboundEventSchema = eventEnvelopeBaseSchema
  .strip()
  .extend({ actor: edgeInboundActorSchema })
  .superRefine(checkEnvelopeRules);
const edgeInboundBatchSchema = syncBatchSchema.strip().safeExtend({
  events: z.array(edgeInboundEventSchema).min(1),
});
const edgeInboundFrameSchema = z.discriminatedUnion("type", [
  linkFrameSchema.options[0].strip(),
  linkFrameSchema.options[1].strip().extend({ batch: edgeInboundBatchSchema }),
  linkFrameSchema.options[2].strip().extend({ ack: syncAckSchema.strip() }),
  linkFrameSchema.options[3].strip(),
  linkFrameSchema.options[4].strip().extend({
    catalogStale: z
      .array(
        z.object({
          stream: text,
          staleSince: isoDateTimeSchema,
          reason: text,
        }),
      )
      .max(16)
      .optional(),
  }),
]);

// Only unknown control-frame fields are stripped. Known event payloads are
// domain data and may legitimately contain names such as tokenIssuedAt.
function unsafeExtraFields(value: unknown, known: readonly string[]): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const extras = Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.includes(key)),
  );
  return hasUnsafeSnapshotFields(extras);
}

function unsafeInboundFrame(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const frame = value as Record<string, unknown>;
  const schema = edgeInboundFrameSchema.options.find(
    (option) => option.shape.type.value === frame.type,
  );
  if (!schema) return false;
  if (unsafeExtraFields(frame, Object.keys(schema.shape))) return true;
  if (
    frame.type === "batch" &&
    frame.batch &&
    typeof frame.batch === "object" &&
    !Array.isArray(frame.batch)
  ) {
    const batch = frame.batch as Record<string, unknown>;
    if (unsafeExtraFields(batch, Object.keys(edgeInboundBatchSchema.shape)))
      return true;
    if (Array.isArray(batch.events)) {
      for (const event of batch.events) {
        if (unsafeExtraFields(event, Object.keys(edgeInboundEventSchema.shape)))
          return true;
        if (event && typeof event === "object" && !Array.isArray(event)) {
          const actor = (event as Record<string, unknown>).actor;
          if (actor && typeof actor === "object" && !Array.isArray(actor)) {
            const actorType = (actor as Record<string, unknown>).type;
            const actorSchema = edgeInboundActorSchema.options.find(
              (option) => option.shape.type.value === actorType,
            );
            if (
              actorSchema &&
              unsafeExtraFields(actor, Object.keys(actorSchema.shape))
            )
              return true;
          }
        }
      }
    }
  }
  if (
    frame.type === "ack" &&
    unsafeExtraFields(frame.ack, Object.keys(syncAckSchema.shape))
  )
    return true;
  if (frame.type === "heartbeat" && Array.isArray(frame.catalogStale)) {
    for (const stale of frame.catalogStale) {
      if (unsafeExtraFields(stale, ["stream", "staleSince", "reason"]))
        return true;
    }
  }
  return false;
}

export type LinkFrame = z.infer<typeof linkFrameSchema>;

export function encodeFrame(frame: LinkFrame): string {
  return JSON.stringify(linkFrameSchema.parse(frame));
}

/** Null for anything that is not a valid frame (caller closes 1008). */
export function decodeFrame(
  raw: string,
  inboundAtEdge = false,
): LinkFrame | null {
  if (raw.length > LINK_MAX_FRAME_BYTES) return null;
  try {
    const schema = inboundAtEdge ? edgeInboundFrameSchema : linkFrameSchema;
    const value: unknown = JSON.parse(raw);
    if (inboundAtEdge && unsafeInboundFrame(value)) return null;
    const parsed = schema.safeParse(value);
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
