// KDS station realtime relay (bead legend-4d5; PRD v1.7 §3 group 12 "KDS,
// Expo & Pickup Display": KDS-01 an item shows on the station ≤ 2 s after
// fire, KDS-02 nothing lost or doubled across a disconnect). Same pattern as
// qr-order-realtime.ts and notification-realtime.ts:
//
// - Only identifiers cross PostgreSQL NOTIFY (`KDS_WAKE_CHANNEL`, written by
//   kds-support.ts `appendStationFeed`), delivered after the producing
//   transaction commits. The ticket contents are re-read from the station
//   feed under the client's own, re-resolved identity (RLS + station check).
// - Upgrade: `/api/outlets/:outletId/kitchen/stations/:stationId/realtime
//   ?after=<n>` from a trusted origin with the staff session cookie
//   (`resolveConnection` port; default denies). The station is checked on
//   connect by the service reads (`kds.ticket.process` on that station); any
//   failure answers 403 before the upgrade.
// - Frames: `hello` with the station cursor when the socket opened, then one
//   `ticket` frame per feed entry, strictly ascending `sequence`. With
//   `after`, every change after it is replayed first. Each client has one
//   promise chain and a cursor, so frames never interleave or repeat and only
//   entries with `sequence` > cursor are sent.
// - `after` is untrusted. When it is ahead of the station, too far behind or
//   its rows were pruned, the server sends `hello`, then `resync` (with the
//   station's current cursor) and closes with 4409
//   (KITCHEN_REALTIME_RESYNC_CLOSE_CODE). The client reloads the snapshot and
//   reconnects with `after = snapshot.sequence`. The same happens when a later
//   catch-up hits the lag limit.
// - Wakeups are coalesced per socket: while a catch-up is queued and has not
//   started, further wakeups add nothing, because that run reads everything
//   up to the moment it starts.
// - The identity is re-resolved on every wakeup for that station and every
//   RECHECK_INTERVAL_MS (which also catches up any missed wakeup); a denial
//   closes the socket with 1008. Incoming frames close it with 1008.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import WebSocket, { WebSocketServer } from "ws";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  outletIdSchema,
  z,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  KITCHEN_REALTIME_PROTOCOL,
  KITCHEN_REALTIME_RESYNC_CLOSE_CODE,
  stationIdSchema,
  type KitchenRealtimeMessage,
} from "@starter/shared/kitchen";
import {
  KDS_WAKE_CHANNEL,
  KdsResyncRequiredError,
  kdsWakeSignalSchema,
} from "./kds-support.ts";
import { listStationTickets, readStationFeed } from "./kds.service.ts";

const PATH =
  /^\/api\/outlets\/([0-9a-f-]{36})\/kitchen\/stations\/([0-9a-f-]{36})\/realtime(\?.*)?$/;
/** One station rarely has more than a few screens (line + expo + spare). */
export const MAX_SOCKETS_PER_STATION = 20;
const RECHECK_INTERVAL_MS = 60_000;

const querySchema = z.strictObject({
  after: z
    .string()
    .regex(/^\d{1,16}$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
    .optional(),
});

type Identity = { userId: string; context: ScopedTenantContext };

type Options = {
  /**
   * The staff session and the request's tenant (as requireAuth +
   * requireTenantContext), scoped for `kds.ticket.process` on the path's
   * outlet and station. Called on connect, every wakeup and every recheck.
   * Default: deny every connection.
   */
  resolveConnection?: (request: IncomingMessage) => Promise<Identity | null>;
  trustedOrigins?: readonly string[];
  recheckIntervalMs?: number;
  /** Lag limit before a cursor must resync; default KITCHEN_FEED_MAX_LAG. */
  maxFeedLag?: number;
};

type Client = {
  request: IncomingMessage;
  userId: string;
  tenantId: string;
  outletId: string;
  stationId: string;
  /** Highest feed sequence already sent (or the hello cursor). */
  cursor: number;
  /** Serialises hello, replay and live frames for this socket. */
  chain: Promise<void>;
  /** A catch-up is queued on `chain` and has not started yet. */
  queued: boolean;
};

/** Outlet + station ids and the optional `after` of a realtime URL. */
export function parseKdsRealtimeUrl(url: string | undefined) {
  const match = PATH.exec(url ?? "");
  if (!match) return null;
  const query = querySchema.safeParse(
    Object.fromEntries(new URLSearchParams(match[3]?.slice(1) ?? "")),
  );
  if (!query.success) return null;
  return {
    outletId: outletIdSchema.parse(match[1]!),
    stationId: stationIdSchema.parse(match[2]!),
    after: query.data.after ?? null,
  };
}

function send(ws: WebSocket, message: KitchenRealtimeMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

/** Every attached instance's "recheck all sockets now" (legend-1024). */
const rechecks = new Set<() => void>();

/**
 * Re-resolve every open KDS socket now instead of at the next interval, so a
 * revoked device or a closed session loses its screen at once (the resolver
 * answers null, the socket closes 1008).
 */
export function recheckKdsSockets(): void {
  for (const recheck of rechecks) recheck();
}

export function attachKdsRealtime(server: Server, options: Options = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    handleProtocols: (protocols) =>
      protocols.has(KITCHEN_REALTIME_PROTOCOL)
        ? KITCHEN_REALTIME_PROTOCOL
        : false,
  });
  const clients = new Map<WebSocket, Client>();
  const resolve = options.resolveConnection ?? (async () => null);
  // Upgrades still being checked hold a seat too, so a burst of parallel
  // connects cannot slip past the per-station limit.
  const pending = new Map<string, number>();
  const seatKey = (tenantId: string, stationId: string) =>
    `${tenantId}:${stationId.toLowerCase()}`;
  const socketsOf = (tenantId: string, stationId: string) =>
    [...clients.values()].filter(
      (client) =>
        client.tenantId === tenantId && client.stationId === stationId,
    ).length + (pending.get(seatKey(tenantId, stationId)) ?? 0);

  const drop = (ws: WebSocket, code: number) => {
    clients.delete(ws);
    if (ws.readyState === WebSocket.OPEN) ws.close(code);
    else ws.terminate();
  };

  /** Resync frame + close for a cursor that cannot resume; else fail closed. */
  function fail(ws: WebSocket, client: Client, error: unknown) {
    if (clients.get(ws) !== client) return;
    if (error instanceof KdsResyncRequiredError) {
      send(ws, {
        type: "resync",
        stationId: client.stationId as Extract<
          KitchenRealtimeMessage,
          { type: "resync" }
        >["stationId"],
        sequence: error.sequence,
      });
      return drop(ws, KITCHEN_REALTIME_RESYNC_CLOSE_CODE);
    }
    drop(ws, 1008);
  }

  /** Sends every feed entry after the client cursor, page by page. */
  async function catchUp(ws: WebSocket, client: Client, identity: Identity) {
    for (;;) {
      if (clients.get(ws) !== client) return;
      const feed = await readStationFeed(
        identity.context,
        { userId: identity.userId, deviceId: null },
        client.outletId,
        client.stationId,
        client.cursor,
        new Date(),
        { maxLag: options.maxFeedLag },
      );
      if (clients.get(ws) !== client) return;
      for (const entry of feed.entries) {
        if (entry.sequence <= client.cursor) continue;
        send(ws, { type: "ticket", stationId: feed.stationId, entry });
        client.cursor = entry.sequence;
      }
      client.cursor = Math.max(client.cursor, feed.toSequence);
      if (!feed.hasMore) return;
    }
  }

  /** The client's identity now; null when it no longer matches the socket. */
  async function reresolve(client: Client): Promise<Identity | null> {
    const identity = await resolve(client.request);
    if (
      !identity ||
      identity.userId !== client.userId ||
      identity.context.tenant.tenantId !== client.tenantId
    )
      return null;
    assertTrustedScopedContext(identity.context);
    assertOutletInScope(identity.context.outletScope, client.outletId);
    return identity;
  }

  /** Queue a fresh-identity catch-up; any failure closes the socket. */
  function enqueue(ws: WebSocket, client: Client) {
    // One pending run is enough: it starts later than every wakeup that
    // found it queued, so it reads their changes too. A wakeup during a
    // running catch-up still queues one more run (its change may be newer
    // than that run's last read).
    if (client.queued) return client.chain;
    client.queued = true;
    client.chain = client.chain.then(async () => {
      client.queued = false;
      if (clients.get(ws) !== client) return;
      try {
        const identity = await reresolve(client);
        if (!identity) return drop(ws, 1008);
        await catchUp(ws, client, identity);
      } catch (error) {
        // Denied (station, outlet, tenant) or unreadable: fail closed. The
        // client reconnects with `after` and loses nothing (KDS-02). A cursor
        // that cannot resume gets a resync frame instead of a bare close.
        fail(ws, client, error);
      }
    });
    return client.chain;
  }

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!PATH.test(request.url ?? "")) return;
    void (async () => {
      let seat: string | null = null;
      try {
        if (
          !request.headers.origin ||
          !options.trustedOrigins?.includes(request.headers.origin)
        )
          throw new Error("Untrusted origin");
        const target = parseKdsRealtimeUrl(request.url);
        if (!target) throw new Error("Invalid request");
        const identity = await resolve(request);
        if (!identity) throw new Error("Unauthorized");
        assertTrustedScopedContext(identity.context);
        assertOutletInScope(identity.context.outletScope, target.outletId);
        const tenantId = identity.context.tenant.tenantId;
        if (socketsOf(tenantId, target.stationId) >= MAX_SOCKETS_PER_STATION)
          throw new Error("Too many sockets");
        seat = seatKey(tenantId, target.stationId);
        pending.set(seat, (pending.get(seat) ?? 0) + 1);
        // Station check (kds.ticket.process) + the hello cursor.
        const snapshot = await listStationTickets(
          identity.context,
          { userId: identity.userId, deviceId: null },
          target.outletId,
          target.stationId,
          new Date(),
        );
        if (socket.destroyed) return;
        wss.handleUpgrade(request, socket, head, (ws) => {
          const client: Client = {
            request,
            userId: identity.userId,
            tenantId,
            outletId: target.outletId,
            stationId: target.stationId,
            cursor: target.after ?? snapshot.sequence,
            chain: Promise.resolve(),
            queued: false,
          };
          clients.set(ws, client);
          ws.on("close", () => clients.delete(ws));
          ws.on("message", () => drop(ws, 1008));
          ws.on("error", () => {
            clients.delete(ws);
            ws.terminate();
          });
          send(ws, {
            type: "hello",
            stationId: target.stationId,
            sequence: snapshot.sequence,
          });
          // Replay after `after`, or close the gap between the snapshot and
          // registration when no `after` was given.
          // A bad `after` fails here with the resync frame, right after hello.
          client.chain = catchUp(ws, client, identity).catch((error) =>
            fail(ws, client, error),
          );
        });
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
      } finally {
        if (seat !== null) {
          const left = (pending.get(seat) ?? 1) - 1;
          if (left > 0) pending.set(seat, left);
          else pending.delete(seat);
        }
      }
    })();
  };
  server.on("upgrade", upgrade);

  async function dispatch(input: unknown) {
    const parsed = kdsWakeSignalSchema.safeParse(input);
    if (!parsed.success) return;
    const signal = parsed.data;
    await Promise.all(
      [...clients].map(([ws, client]) => {
        // Cheap filter first: only this tenant's sockets of this station
        // that have not seen the signalled sequence yet.
        if (
          client.tenantId !== signal.tenantId ||
          client.outletId !== signal.outletId.toLowerCase() ||
          client.stationId !== signal.stationId.toLowerCase() ||
          signal.sequence <= client.cursor
        )
          return;
        return enqueue(ws, client);
      }),
    );
  }

  const recheckAll = () => {
    void Promise.all(
      [...clients].map(([ws, client]) => enqueue(ws, client)),
    ).catch(() => {});
  };
  const timer = setInterval(
    recheckAll,
    options.recheckIntervalMs ?? RECHECK_INTERVAL_MS,
  );
  timer.unref();
  rechecks.add(recheckAll);

  return {
    dispatch,
    async close() {
      clearInterval(timer);
      rechecks.delete(recheckAll);
      server.off("upgrade", upgrade);
      for (const ws of clients.keys()) ws.terminate();
      clients.clear();
      await new Promise<void>((done) => wss.close(() => done()));
    },
  };
}

/** LISTEN on the KDS channel; NOTIFY arrives only after the writer commits. */
export async function listenKdsWakeups(
  pool: Pool,
  dispatch: (signal: unknown) => Promise<void>,
) {
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  const schedule = () => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect().catch(schedule);
    }, 1000);
    retry.unref();
  };
  const connect = async () => {
    const client = await pool.connect();
    if (closed) {
      client.release();
      return;
    }
    let released = false;
    const release = (destroy: boolean) => {
      if (released) return;
      released = true;
      client.removeListener("notification", onNotification);
      client.release(destroy);
    };
    const onNotification = (message: { channel: string; payload?: string }) => {
      if (message.channel !== KDS_WAKE_CHANNEL || !message.payload) return;
      try {
        void dispatch(JSON.parse(message.payload)).catch(() => {});
      } catch {
        /* Invalid signal. */
      }
    };
    client.on("error", () => {
      release(true);
      schedule();
    });
    client.on("notification", onNotification);
    try {
      await client.query(`LISTEN ${KDS_WAKE_CHANNEL}`);
    } catch (error) {
      release(true);
      throw error;
    }
    cleanup = async () => {
      if (released) return;
      try {
        await client.query(`UNLISTEN ${KDS_WAKE_CHANNEL}`);
      } finally {
        release(false);
      }
    };
  };
  await connect().catch(schedule);
  return async () => {
    closed = true;
    if (retry) clearTimeout(retry);
    await cleanup?.();
  };
}
