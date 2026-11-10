// Staff panic stream (bead legend-bod; PRD v1.7 §3 F25 "Keselamatan", FAC-08).
// Same shape as kds-realtime.ts, but there is nothing to replay or catch up:
// a frame is relayed from the in-process hub (panic-relay-hub.ts), so the
// stream works with the internet down and PostgreSQL NOTIFY is not involved.
//
// - Upgrade: `/api/outlets/:outletId/panic/realtime` from a trusted origin
//   with the staff session cookie (`resolveConnection` port; default denies).
//   Any failure answers 403 before the upgrade.
// - Frames: `hello` when the socket opened, then one `panic` frame per press
//   in the outlet (PanicRealtimeFrame). Incoming frames close the socket
//   with 1008.
// - The identity is re-resolved every RECHECK_INTERVAL_MS; a denial or a
//   different user closes the socket with 1008.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  outletIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  PANIC_REALTIME_PROTOCOL,
  type PanicRealtimeHello,
} from "@starter/shared/facility";
import { subscribe } from "./panic-relay-hub.ts";

const PATH = /^\/api\/outlets\/([0-9a-f-]{36})\/panic\/realtime$/;
/** Staff phones and screens of one outlet. */
export const MAX_PANIC_SOCKETS_PER_OUTLET = 100;
const RECHECK_INTERVAL_MS = 60_000;
const PING_INTERVAL_MS = 15_000;

type Identity = { userId: string; context: ScopedTenantContext };

type Options = {
  /**
   * The staff session, scoped for `facility.booth.operate` on the path's
   * outlet. Called on connect and every recheck. Default: deny everything.
   */
  resolveConnection?: (request: IncomingMessage) => Promise<Identity | null>;
  trustedOrigins?: readonly string[];
  recheckIntervalMs?: number;
  /** Ping period; a socket that misses one pong is terminated. Default 15 s. */
  pingIntervalMs?: number;
};

type Client = {
  /** Answered the last ping (true until the next ping goes out). */
  alive: boolean;
  request: IncomingMessage;
  userId: string;
  tenantId: string;
  outletId: string;
  unsubscribe: () => void;
};

/** Outlet id of a panic realtime URL; null when it is not one. */
export function parsePanicRealtimeUrl(url: string | undefined) {
  const match = PATH.exec((url ?? "").split("?", 1)[0] ?? "");
  const outletId = outletIdSchema.safeParse(match?.[1]);
  return outletId.success ? { outletId: outletId.data } : null;
}

export function attachPanicRealtime(server: Server, options: Options = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    handleProtocols: (protocols) =>
      protocols.has(PANIC_REALTIME_PROTOCOL) ? PANIC_REALTIME_PROTOCOL : false,
  });
  const clients = new Map<WebSocket, Client>();
  const resolve = options.resolveConnection ?? (async () => null);
  // Upgrades still being checked hold a seat too, so a burst of parallel
  // connects cannot slip past the per-outlet limit.
  const pending = new Map<string, number>();
  const seatKey = (tenantId: string, outletId: string) =>
    `${tenantId}:${outletId.toLowerCase()}`;
  const socketsOf = (tenantId: string, outletId: string) =>
    [...clients.values()].filter(
      (client) => client.tenantId === tenantId && client.outletId === outletId,
    ).length + (pending.get(seatKey(tenantId, outletId)) ?? 0);

  const drop = (ws: WebSocket, code: number) => {
    const client = clients.get(ws);
    client?.unsubscribe();
    clients.delete(ws);
    if (ws.readyState === WebSocket.OPEN) ws.close(code);
    else ws.terminate();
  };

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!PATH.test((request.url ?? "").split("?", 1)[0] ?? "")) return;
    void (async () => {
      let seat: string | null = null;
      try {
        if (
          !request.headers.origin ||
          !options.trustedOrigins?.includes(request.headers.origin)
        )
          throw new Error("Untrusted origin");
        const target = parsePanicRealtimeUrl(request.url);
        if (!target) throw new Error("Invalid request");
        const identity = await resolve(request);
        if (!identity) throw new Error("Unauthorized");
        assertTrustedScopedContext(identity.context);
        assertOutletInScope(identity.context.outletScope, target.outletId);
        const tenantId = identity.context.tenant.tenantId;
        if (
          socketsOf(tenantId, target.outletId) >= MAX_PANIC_SOCKETS_PER_OUTLET
        )
          throw new Error("Too many sockets");
        seat = seatKey(tenantId, target.outletId);
        pending.set(seat, (pending.get(seat) ?? 0) + 1);
        if (socket.destroyed) return;
        wss.handleUpgrade(request, socket, head, (ws) => {
          const send = (frame: unknown) => {
            if (ws.readyState === WebSocket.OPEN)
              ws.send(JSON.stringify(frame));
          };
          clients.set(ws, {
            request,
            userId: identity.userId,
            tenantId,
            outletId: target.outletId,
            alive: true,
            unsubscribe: subscribe(
              { tenantId, outletId: target.outletId },
              send,
              identity.userId,
            ),
          });
          ws.on("pong", () => {
            const client = clients.get(ws);
            if (client) client.alive = true;
          });
          ws.on("close", () => {
            clients.get(ws)?.unsubscribe();
            clients.delete(ws);
          });
          ws.on("message", () => drop(ws, 1008));
          ws.on("error", () => {
            clients.get(ws)?.unsubscribe();
            clients.delete(ws);
            ws.terminate();
          });
          const hello: PanicRealtimeHello = {
            type: "hello",
            outletId: target.outletId,
          };
          send(hello);
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

  /** Re-resolves every identity; a denial or another user closes the socket. */
  async function recheck() {
    await Promise.all(
      [...clients].map(async ([ws, client]) => {
        try {
          const identity = await resolve(client.request);
          if (
            !identity ||
            identity.userId !== client.userId ||
            identity.context.tenant.tenantId !== client.tenantId
          )
            return drop(ws, 1008);
          assertTrustedScopedContext(identity.context);
          assertOutletInScope(identity.context.outletScope, client.outletId);
        } catch {
          drop(ws, 1008);
        }
      }),
    );
  }

  const timer = setInterval(() => {
    void recheck().catch(() => {});
  }, options.recheckIntervalMs ?? RECHECK_INTERVAL_MS);
  timer.unref();

  /**
   * Dead sockets (a phone that left the Wi-Fi) never send a close frame: ping
   * every socket, and terminate the ones that did not answer the last ping, so
   * they unsubscribe and free their seat.
   */
  function heartbeat() {
    for (const [ws, client] of clients) {
      if (!client.alive) {
        ws.terminate();
        continue;
      }
      client.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }
  const pinger = setInterval(
    heartbeat,
    options.pingIntervalMs ?? PING_INTERVAL_MS,
  );
  pinger.unref();

  return {
    recheck,
    heartbeat,
    async close() {
      clearInterval(timer);
      clearInterval(pinger);
      server.off("upgrade", upgrade);
      for (const [ws, client] of clients) {
        client.unsubscribe();
        ws.terminate();
      }
      clients.clear();
      await new Promise<void>((done) => wss.close(() => done()));
    },
  };
}
