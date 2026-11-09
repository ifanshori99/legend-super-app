// Guest realtime relay for the QR shared cart and order status (beads
// legend-x4qy, legend-6ohy; PRD v1.7 §3 F10 "Menu & Keranjang": every phone at
// the table sees the same cart; §4 Alur A: the order moves to the kitchen once
// paid). Same pattern as notification-realtime.ts:
//
// - Only identifiers cross PostgreSQL NOTIFY (qr-order-realtime-signal.ts),
//   delivered after the producing transaction commits. Messages carry the
//   session id plus the cart version or order id/status; the client re-reads
//   the session view under its own credential (no prices, no lines here).
// - Upgrade: `/api/table-sessions/:sessionId/realtime` from a trusted origin.
//   The tenant comes from the request host (TEN-02, `resolveTenant` port, deny
//   by default). The guest credential is the scan's session token, sent as a
//   WebSocket subprotocol (browsers cannot set Authorization on a socket):
//   `new WebSocket(url, ["legend-qr.v1", "bearer.<sessionToken>"])`. The
//   server answers with `legend-qr.v1` only, never echoing the token. A
//   non-browser client may send `Authorization: Bearer <sessionToken>`.
// - The credential is re-verified on every signal for that session and every
//   RECHECK_INTERVAL_MS, so a closed/rotated session (ORD-04) loses its socket.
// - Server-to-client only; any incoming frame closes the socket (1008).

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import WebSocket, { WebSocketServer } from "ws";
import {
  assertTrustedScopedContext,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resolveHostname } from "./org-resolve.service.ts";
import {
  qrRealtimeMessageSchema,
  qrRealtimeSignalSchema,
  type QrRealtimeMessage,
  type QrRealtimeSignal,
} from "@starter/shared/qr-order";
import { QR_CART_WAKE_CHANNEL } from "./qr-order-realtime-signal.ts";
import { lockGuestSessionForPayment } from "./qr-order.service.ts";

export const QR_REALTIME_PROTOCOL = "legend-qr.v1";
const BEARER_PROTOCOL_PREFIX = "bearer.";
const PATH = /^\/api\/table-sessions\/([0-9a-fA-F-]{36})\/realtime$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{20,256}$/;
/** A table seats at most 30 (contract pax); one socket per phone. */
export const MAX_SOCKETS_PER_SESSION = 30;
const RECHECK_INTERVAL_MS = 60_000;

type Options = {
  /** Tenant of the request host (TEN-02). Default: deny every connection. */
  resolveTenant?: (
    request: IncomingMessage,
  ) => Promise<ScopedTenantContext | null>;
  /** True while `credential` opens `sessionId` (active, not rotated). */
  verifyGuest?: (
    context: ScopedTenantContext,
    credential: string,
    sessionId: string,
  ) => Promise<boolean>;
  trustedOrigins?: readonly string[];
  recheckIntervalMs?: number;
};

type Client = {
  context: ScopedTenantContext;
  tenantId: string;
  sessionId: string;
  credential: string;
};

/** Host -> registered tenant domain, tenant-wide guest scope (as the routes). */
export async function resolveGuestTenantFromHost(
  request: IncomingMessage,
): Promise<ScopedTenantContext | null> {
  const host = (request.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (!host) return null;
  const resolution = await resolveHostname(host);
  if (!resolution.ok) return null;
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: resolution.tenantId,
      brandId: resolution.brandId,
      source: "domain",
    }),
    { kind: "tenant" },
  );
}

/** The real guest check: the credential's session, active and unexpired. */
export async function verifyGuestCredential(
  context: ScopedTenantContext,
  credential: string,
  sessionId: string,
): Promise<boolean> {
  try {
    await withTenant(db, context, (tx) =>
      lockGuestSessionForPayment(
        tx,
        context,
        credential,
        sessionId,
        new Date(),
        "none",
      ),
    );
    return true;
  } catch {
    return false;
  }
}

function protocolsOf(request: IncomingMessage): string[] {
  const header = request.headers["sec-websocket-protocol"];
  return (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function credentialOf(request: IncomingMessage): string | null {
  const auth = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "");
  const fromProtocol = protocolsOf(request)
    .find((value) => value.startsWith(BEARER_PROTOCOL_PREFIX))
    ?.slice(BEARER_PROTOCOL_PREFIX.length);
  const credential = auth?.[1] ?? fromProtocol ?? null;
  return credential !== null && CREDENTIAL.test(credential) ? credential : null;
}

function messageOf(signal: QrRealtimeSignal): QrRealtimeMessage {
  return qrRealtimeMessageSchema.parse(
    "version" in signal
      ? {
          type: "cart.updated",
          sessionId: signal.sessionId,
          version: signal.version,
        }
      : {
          type: "order.updated",
          sessionId: signal.sessionId,
          orderId: signal.orderId,
          status: signal.status,
        },
  );
}

export function attachQrOrderRealtime(server: Server, options: Options = {}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    // Select our marker protocol only; the bearer entry is never echoed.
    handleProtocols: (protocols) =>
      protocols.has(QR_REALTIME_PROTOCOL) ? QR_REALTIME_PROTOCOL : false,
  });
  const clients = new Map<WebSocket, Client>();
  const resolveTenant = options.resolveTenant ?? (async () => null);
  const verify = options.verifyGuest ?? verifyGuestCredential;
  const socketsOf = (tenantId: string, sessionId: string) =>
    [...clients.values()].filter(
      (client) =>
        client.tenantId === tenantId && client.sessionId === sessionId,
    ).length;

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = PATH.exec((request.url ?? "").split("?")[0] ?? "");
    if (!match) return;
    void (async () => {
      try {
        if (
          !request.headers.origin ||
          !options.trustedOrigins?.includes(request.headers.origin)
        )
          throw new Error("Untrusted origin");
        const sessionId = uuidSchema.parse(match[1]!.toLowerCase());
        const credential = credentialOf(request);
        if (!credential) throw new Error("Unauthorized");
        const context = await resolveTenant(request);
        if (!context) throw new Error("Unknown tenant");
        assertTrustedScopedContext(context);
        if (!(await verify(context, credential, sessionId)))
          throw new Error("Unauthorized");
        const tenantId = context.tenant.tenantId;
        if (socketsOf(tenantId, sessionId) >= MAX_SOCKETS_PER_SESSION)
          throw new Error("Too many sockets");
        if (socket.destroyed) return;
        wss.handleUpgrade(request, socket, head, (ws) => {
          clients.set(ws, { context, tenantId, sessionId, credential });
          ws.on("close", () => clients.delete(ws));
          ws.on("message", () => ws.close(1008));
          ws.on("error", () => ws.terminate());
        });
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    })();
  };
  server.on("upgrade", upgrade);

  async function recheck(ws: WebSocket, client: Client): Promise<boolean> {
    try {
      if (await verify(client.context, client.credential, client.sessionId))
        return true;
    } catch {
      /* Fail closed below. */
    }
    ws.close(1008);
    clients.delete(ws);
    return false;
  }

  async function dispatch(input: unknown) {
    const parsed = qrRealtimeSignalSchema.safeParse(input);
    if (!parsed.success) return;
    const signal = parsed.data;
    const message = JSON.stringify(messageOf(signal));
    await Promise.all(
      [...clients].map(async ([ws, client]) => {
        // Cheap filter first: only this tenant's sockets of this session.
        if (
          client.tenantId !== signal.tenantId ||
          client.sessionId !== signal.sessionId
        )
          return;
        if (!(await recheck(ws, client))) return;
        if (ws.readyState === WebSocket.OPEN) ws.send(message);
      }),
    );
  }

  const timer = setInterval(() => {
    void Promise.all(
      [...clients].map(([ws, client]) => recheck(ws, client)),
    ).catch(() => {});
  }, options.recheckIntervalMs ?? RECHECK_INTERVAL_MS);
  timer.unref();

  return {
    dispatch,
    async close() {
      clearInterval(timer);
      server.off("upgrade", upgrade);
      for (const ws of clients.keys()) ws.terminate();
      clients.clear();
      await new Promise<void>((done) => wss.close(() => done()));
    },
  };
}

/** LISTEN on the QR channel; NOTIFY arrives only after the writer commits. */
export async function listenQrCartWakeups(
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
      if (message.channel !== QR_CART_WAKE_CHANNEL || !message.payload) return;
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
      await client.query(`LISTEN ${QR_CART_WAKE_CHANNEL}`);
    } catch (error) {
      release(true);
      throw error;
    }
    cleanup = async () => {
      if (released) return;
      try {
        await client.query(`UNLISTEN ${QR_CART_WAKE_CHANNEL}`);
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
