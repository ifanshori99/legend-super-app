// KDS station feed and realtime contract (bead legend-4d5, PRD v1.7 §3 group
// 12 "KDS, Expo & Pickup Display"; KDS-01 ≤ 2 s delivery, KDS-02 no item lost
// or shown twice across a reconnect).
//
// Every change to a ticket on a station appends one row to that station's
// feed with a gapless per-station `sequence` (1, 2, 3 …). A KDS screen:
//
//   1. GET .../stations/:stationId/tickets  -> open tickets + `sequence` cursor
//   2. opens the WebSocket with `?after=<cursor>`; the server replays every
//      change after the cursor, then streams live changes in sequence order
//   3. on reconnect, reopens with `?after=<last applied sequence>` (or calls
//      GET .../feed?after=<cursor>) and applies only `sequence > cursor`
//   4. when the server answers `KDS_RESYNC_REQUIRED` (HTTP 409) or sends a
//      `resync` frame, the cursor cannot be resumed (ahead of the station, too
//      far behind, or its changes were pruned): reload the snapshot from
//      step 1 and reconnect with `after = snapshot.sequence`
//
// Each feed entry carries the ticket's full current state, so applying the
// latest entry per ticket is idempotent: a replayed entry replaces the same
// ticket (never a duplicate) and every change after the cursor is included
// (never a gap). Ordering is by `sequence`, never arrival time or ULID
// (docs/plan/contracts.md "Events, outbox and sync").

import {
  printPaperWidthQuerySchema,
  printPayloadSchema,
} from "../pos/print-payload.ts";
import {
  z,
  clientInputSchema,
  dataResponseSchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  kitchenTicketDetailSchema,
  kitchenTicketIdSchema,
  stationIdSchema,
} from "./schemas.ts";

/** Gapless per-station feed position; 0 means "before the first change". */
export const kitchenFeedSequenceSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

/** Largest number of tickets one feed page or replay frame batch returns. */
export const KITCHEN_FEED_PAGE_LIMIT = 200;

/**
 * Furthest a cursor may trail the station's newest sequence and still resume
 * from the feed. Beyond it the client reloads the snapshot: replaying that
 * much history is slower than the snapshot and old feed rows get pruned.
 */
export const KITCHEN_FEED_MAX_LAG = 2000;

/**
 * Feed rows are pruned only once older than this AND more than
 * KITCHEN_FEED_MAX_LAG behind the newest sequence of their station. The
 * database trigger on kitchen_station_feed enforces the same age.
 */
export const KITCHEN_FEED_RETENTION_HOURS = 24;

/**
 * Stable error code of HTTP 409 on `/feed` when `after` cannot be resumed:
 * `after` is ahead of the station cursor, more than KITCHEN_FEED_MAX_LAG
 * behind it, or the rows after it were pruned.
 */
export const KDS_RESYNC_REQUIRED = "KDS_RESYNC_REQUIRED";

export const kitchenFeedEntrySchema = z.strictObject({
  sequence: kitchenFeedSequenceSchema.refine((n) => n > 0, {
    message: "Feed entries start at sequence 1",
  }),
  ticket: kitchenTicketDetailSchema,
});
export type KitchenFeedEntry = z.infer<typeof kitchenFeedEntrySchema>;

/** Open tickets on one station plus the cursor they are current to. */
export const kitchenStationSnapshotSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  stationId: stationIdSchema,
  sequence: kitchenFeedSequenceSchema,
  generatedAt: isoDateTimeSchema,
  tickets: z.array(kitchenTicketDetailSchema),
});
export type KitchenStationSnapshot = z.infer<
  typeof kitchenStationSnapshotSchema
>;

/**
 * Changes after `afterSequence`, collapsed to the latest entry per ticket and
 * sorted by `sequence`. `toSequence` is the cursor to store after applying;
 * `hasMore` asks for the next page from `toSequence`.
 */
export const kitchenStationFeedSchema = z
  .strictObject({
    stationId: stationIdSchema,
    afterSequence: kitchenFeedSequenceSchema,
    toSequence: kitchenFeedSequenceSchema,
    hasMore: z.boolean(),
    entries: z.array(kitchenFeedEntrySchema).max(KITCHEN_FEED_PAGE_LIMIT),
  })
  .refine((feed) => feed.toSequence >= feed.afterSequence, {
    path: ["toSequence"],
    message: "The feed never moves the cursor backwards",
  })
  .refine(
    (feed) =>
      feed.entries.every(
        (entry, i) =>
          entry.sequence > feed.afterSequence &&
          entry.sequence <= feed.toSequence &&
          (i === 0 || entry.sequence > feed.entries[i - 1]!.sequence),
      ),
    {
      path: ["entries"],
      message: "Entries are after the cursor, ascending, and within toSequence",
    },
  );
export type KitchenStationFeed = z.infer<typeof kitchenStationFeedSchema>;

const stationParams = z.strictObject({
  outletId: outletIdSchema,
  stationId: stationIdSchema,
});

/** KDS-02 step 1: open tickets of one station and the feed cursor. */
export const listKitchenStationTickets = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/stations/:stationId/tickets",
  params: stationParams,
  response: dataResponseSchema(kitchenStationSnapshotSchema),
});

/** KDS-02 resync over HTTP: every change after `after`, one page. */
export const getKitchenStationFeed = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/stations/:stationId/feed",
  params: stationParams,
  query: clientInputSchema({
    after: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
  }),
  response: dataResponseSchema(kitchenStationFeedSchema),
});

/** One ticket with its lines (KDS card detail). */
export const getKitchenTicket = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/tickets/:ticketId",
  params: z.strictObject({
    outletId: outletIdSchema,
    ticketId: kitchenTicketIdSchema,
  }),
  response: dataResponseSchema(kitchenTicketDetailSchema),
});

/** P1: the station ticket as ESC/POS bytes for the KDS tablet's own printer. */
export const getKitchenTicketPrint = defineEndpoint({
  method: "GET",
  path: "/api/outlets/:outletId/kitchen/tickets/:ticketId/print",
  params: z.strictObject({
    outletId: outletIdSchema,
    ticketId: kitchenTicketIdSchema,
  }),
  query: clientInputSchema({ paperWidth: printPaperWidthQuerySchema }),
  response: dataResponseSchema(printPayloadSchema),
});

/* --------------------------------------------------------------- realtime */

/** WebSocket subprotocol; the server answers with this value only. */
export const KITCHEN_REALTIME_PROTOCOL = "legend-kds.v1";

/**
 * Credential carriers for a browser on a shared device (legend-dsbqr). A
 * browser cannot set headers on a WebSocket, so the client offers extra
 * subprotocols `legend-kds-device.<device token>` and
 * `legend-kds-staff.<acting staff token>` next to KITCHEN_REALTIME_PROTOCOL.
 * The server maps them to the x-device-token / x-acting-staff headers (a real
 * header wins), never echoes them back and never reads a query string.
 */
export const KITCHEN_REALTIME_DEVICE_PROTOCOL_PREFIX = "legend-kds-device.";
export const KITCHEN_REALTIME_STAFF_PROTOCOL_PREFIX = "legend-kds-staff.";

/** RFC 6455 subprotocol token characters that our tokens use. */
const PROTOCOL_TOKEN = /^[A-Za-z0-9._~-]+$/;

/**
 * Subprotocol list for `new WebSocket(url, protocols)`. A token with
 * characters a subprotocol cannot carry is left out (the server then denies).
 */
export function kitchenRealtimeProtocols(credentials: {
  deviceToken?: string | null;
  actingStaffToken?: string | null;
}): string[] {
  const protocols: string[] = [KITCHEN_REALTIME_PROTOCOL];
  const { deviceToken, actingStaffToken } = credentials;
  if (deviceToken && PROTOCOL_TOKEN.test(deviceToken))
    protocols.push(`${KITCHEN_REALTIME_DEVICE_PROTOCOL_PREFIX}${deviceToken}`);
  if (actingStaffToken && PROTOCOL_TOKEN.test(actingStaffToken))
    protocols.push(
      `${KITCHEN_REALTIME_STAFF_PROTOCOL_PREFIX}${actingStaffToken}`,
    );
  return protocols;
}

/** `/api/outlets/:outletId/kitchen/stations/:stationId/realtime?after=<n>` */
export const KITCHEN_REALTIME_PATH =
  "/api/outlets/:outletId/kitchen/stations/:stationId/realtime";

/**
 * WebSocket close code that follows a `resync` frame. 4409 mirrors the HTTP
 * 409; the 4000 range is reserved for applications, and 1008 stays "denied".
 */
export const KITCHEN_REALTIME_RESYNC_CLOSE_CODE = 4409;

/** Server-to-client frames. The client never sends data frames. */
export const kitchenRealtimeMessageSchema = z.discriminatedUnion("type", [
  /** First frame: the station's current cursor when the socket opened. */
  z.strictObject({
    type: z.literal("hello"),
    stationId: stationIdSchema,
    sequence: kitchenFeedSequenceSchema,
  }),
  /** One ticket change; apply only when `sequence` > the stored cursor. */
  z.strictObject({
    type: z.literal("ticket"),
    stationId: stationIdSchema,
    entry: kitchenFeedEntrySchema,
  }),
  /**
   * The client's `after` cannot be resumed (same cases as KDS_RESYNC_REQUIRED
   * on HTTP). `sequence` is the station's current cursor. The server closes
   * the socket right after with KITCHEN_REALTIME_RESYNC_CLOSE_CODE; the client
   * reloads the snapshot and reconnects with `after = snapshot.sequence`.
   */
  z.strictObject({
    type: z.literal("resync"),
    stationId: stationIdSchema,
    sequence: kitchenFeedSequenceSchema,
  }),
]);
export type KitchenRealtimeMessage = z.infer<
  typeof kitchenRealtimeMessageSchema
>;
