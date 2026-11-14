// Staff emergency socket (bead legend-bod.4; PRD v1.7 §3 F25 "Keselamatan",
// FAC-08; design docs/design/edge-emergency.md D-03, D-05, D-11).
//
// - Upgrade: `/api/emergency/ws`, subprotocol `legend.emergency.v1`, from a
//   trusted Origin, authenticated by the receiver session cookie only
//   (`authenticateReceiverSession`). guardEdgeUpgrades (edge/mode.ts) applies the
//   route split before this listener runs. The token never appears in a URL.
// - Frames out: `{type:"panic", alertId, outletId, unitId, receivedAt, kind}`,
//   sent by services/panic-relay.service.ts. Frames in: `{type:"received",
//   alertId}` (receipt); anything else closes the socket with 1008.
// - Heartbeat: ping every 10 s; a socket without a pong for 25 s is dropped.
// - Resend loop: every 500 ms the service resends alerts that were last sent 3 s
//   ago and are not confirmed; a socket that connects later gets the open alerts
//   at once.
// - Revocation: a session that ends (logout, replaced, off duty, PIN changed ...)
//   closes its sockets with code 4401; every session is also re-checked every 30 s.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  EMERGENCY_REVOKED_CLOSE_CODE,
  EMERGENCY_WS_PROTOCOL,
  panicReceivedFrameSchema,
  type PanicServerFrame,
} from "@starter/shared/facility";
import { HttpError } from "../lib/http-error.ts";
import { logger } from "../lib/logger.ts";
import { toLoggableError } from "../lib/safe-error.ts";
import {
  recordReceipt,
  resendDue,
  sendOpenAlertsTo,
} from "../services/panic-relay.service.ts";
import {
  authenticateReceiverSession,
  onReceiverSessionRevoked,
  recheckReceiverSession,
} from "../services/panic-receiver-session.ts";
import {
  allSubscribers,
  closeSessionSockets,
  subscribe,
  subscribersOf,
  type HubSubscriber,
} from "./panic-relay-hub.ts";

const PATH = "/api/emergency/ws";
/** Staff phones and screens of one outlet. */
export const MAX_EMERGENCY_SOCKETS_PER_OUTLET = 100;
const PING_INTERVAL_MS = 10_000;
const DEAD_AFTER_MS = 25_000;
const HEARTBEAT_TICK_MS = 5_000;
const RESEND_TICK_MS = 500;
const RECHECK_INTERVAL_MS = 30_000;
const CLOSE_GRACE_MS = 1_000;

type Options = {
  trustedOrigins?: readonly string[];
};

type Client = {
  ws: WebSocket;
  subscriber: HubSubscriber;
  unsubscribe: () => void;
  lastPingAt: number;
  lastPongAt: number;
};

function refuse(socket: Duplex, status: 400 | 401 | 403 | 503) {
  const text = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    503: "Service Unavailable",
  }[status];
  if (socket.destroyed) return;
  socket.once("finish", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

const offersProtocol = (request: IncomingMessage) =>
  String(request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .some((value) => value.trim() === EMERGENCY_WS_PROTOCOL);

export function attachEmergencyRealtime(server: Server, options: Options = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    handleProtocols: (protocols) =>
      protocols.has(EMERGENCY_WS_PROTOCOL) ? EMERGENCY_WS_PROTOCOL : false,
  });
  const clients = new Map<WebSocket, Client>();
  // Upgrades still being checked hold a seat too, so a burst of parallel
  // connects cannot slip past the per-outlet limit.
  const pending = new Map<string, number>();
  const seatKey = (tenantId: string, outletId: string) =>
    `${tenantId.toLowerCase()}:${outletId.toLowerCase()}`;

  const forget = (ws: WebSocket) => {
    clients.get(ws)?.unsubscribe();
    clients.delete(ws);
  };

  /** Closes with a code; a phone that never answers the close is cut after 1 s. */
  const closeWith = (ws: WebSocket, code: number) => {
    forget(ws);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close(code);
      setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
    } else ws.terminate();
  };

  const stopRevoked = onReceiverSessionRevoked((event) => {
    closeSessionSockets(
      event.tenantId,
      event.sessionId,
      EMERGENCY_REVOKED_CLOSE_CODE,
    );
  });

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if ((request.url ?? "").split("?", 1)[0] !== PATH) return;
    void (async () => {
      let seat: string | null = null;
      try {
        const origin = request.headers.origin;
        if (!origin || !options.trustedOrigins?.includes(origin))
          return refuse(socket, 403);
        if (!offersProtocol(request)) return refuse(socket, 400);
        const session = await authenticateReceiverSession(
          request.headers.cookie,
        );
        if (!session) return refuse(socket, 401);
        seat = seatKey(session.tenantId, session.outletId);
        const taken = subscribersOf(session).length + (pending.get(seat) ?? 0);
        if (taken >= MAX_EMERGENCY_SOCKETS_PER_OUTLET)
          return refuse(socket, 503);
        pending.set(seat, (pending.get(seat) ?? 0) + 1);
        if (socket.destroyed) return;
        wss.handleUpgrade(request, socket, head, (ws) => {
          const subscriber: HubSubscriber = {
            session,
            alerts: new Map(),
            send: (frame: PanicServerFrame) => {
              if (ws.readyState !== WebSocket.OPEN) return false;
              ws.send(JSON.stringify(frame));
              return true;
            },
            close: (code) => closeWith(ws, code),
          };
          const now = Date.now();
          const client: Client = {
            ws,
            subscriber,
            unsubscribe: subscribe(subscriber),
            lastPingAt: now,
            lastPongAt: now,
          };
          clients.set(ws, client);
          ws.on("pong", () => {
            client.lastPongAt = Date.now();
          });
          ws.on("message", (data) => {
            let frame: unknown;
            try {
              frame = JSON.parse(String(data));
            } catch {
              return closeWith(ws, 1008);
            }
            const received = panicReceivedFrameSchema.safeParse(frame);
            if (!received.success) return closeWith(ws, 1008);
            void recordReceipt(subscriber, received.data.alertId).catch(
              (error: unknown) =>
                logger.error(
                  { err: toLoggableError(error) },
                  "panic receipt failed",
                ),
            );
          });
          ws.on("close", () => forget(ws));
          ws.on("error", () => {
            forget(ws);
            ws.terminate();
          });
          void sendOpenAlertsTo(subscriber).catch((error: unknown) =>
            logger.error(
              { err: toLoggableError(error) },
              "panic open alerts failed",
            ),
          );
        });
      } catch (error) {
        // The cloud serves no socket for an outlet that has an edge node (F-C).
        if (error instanceof HttpError && error.code === "EDGE_NODE_ACTIVE")
          return refuse(socket, 403);
        logger.error({ err: toLoggableError(error) }, "panic upgrade failed");
        refuse(socket, 401);
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

  function heartbeat() {
    const now = Date.now();
    for (const [ws, client] of clients) {
      if (now - client.lastPongAt > DEAD_AFTER_MS) {
        forget(ws);
        ws.terminate();
        continue;
      }
      if (now - client.lastPingAt >= PING_INTERVAL_MS) {
        client.lastPingAt = now;
        try {
          ws.ping();
        } catch {
          forget(ws);
          ws.terminate();
        }
      }
    }
  }
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_TICK_MS);
  heartbeatTimer.unref();

  let ticking = false;
  const resendTimer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void resendDue()
      .catch((error: unknown) =>
        logger.error({ err: toLoggableError(error) }, "panic resend failed"),
      )
      .finally(() => {
        ticking = false;
      });
  }, RESEND_TICK_MS);
  resendTimer.unref();

  /** Every live session is re-checked on a timer (D-03: at most 60 s of delay). */
  const recheckTimer = setInterval(() => {
    const sessions = new Map(
      allSubscribers().map((sub) => [sub.session.id, sub.session]),
    );
    for (const session of sessions.values())
      void recheckReceiverSession(session).catch((error: unknown) =>
        logger.error(
          { err: toLoggableError(error) },
          "panic session recheck failed",
        ),
      );
  }, RECHECK_INTERVAL_MS);
  recheckTimer.unref();

  return {
    async close() {
      clearInterval(heartbeatTimer);
      clearInterval(resendTimer);
      clearInterval(recheckTimer);
      stopRevoked();
      server.off("upgrade", upgrade);
      for (const [ws] of clients) {
        forget(ws);
        ws.terminate();
      }
      clients.clear();
      await new Promise<void>((done) => wss.close(() => done()));
    },
  };
}
