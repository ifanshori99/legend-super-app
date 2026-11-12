// Local emergency delivery. This socket only serves the node's own outlet;
// no cloud connection is involved. Recheck session, permission and duty at
// each delivery so a stale connection cannot continue receiving incidents.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { fromNodeHeaders } from "better-auth/node";
import WebSocket, { WebSocketServer } from "ws";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import { env } from "../config/env.ts";
import { auth } from "../lib/auth.ts";
import {
  loadTenantAccess,
  resolveAccessSnapshot,
} from "../services/permission-resolver.ts";
import { isEmergencyOnDuty } from "../services/edge-emergency.service.ts";
import { getEdgeRuntimeState } from "./runtime.ts";

export type EmergencySignal = {
  tenantId: string;
  outletId: string;
  incidentId: string;
  unitId: string;
  triggeredAt: string;
};
type Identity = { userId: string; tenantId: string; outletId: string };
type Resolver = (request: IncomingMessage) => Promise<Identity | null>;

async function resolveStaff(
  request: IncomingMessage,
): Promise<Identity | null> {
  try {
    const { identity } = getEdgeRuntimeState();
    if (!identity) return null;
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      query: { disableCookieCache: true },
    });
    if (!session) return null;
    const details = session.session as {
      authMethod?: string | null;
      impersonatedBy?: string | null;
    };
    // Impersonation needs extra grant validation; refuse it on this socket.
    if (details.authMethod !== "password" || details.impersonatedBy)
      return null;
    const { tenantId, outletId } = identity.scope;
    const context = establishScopedTenantContext(identity.context.tenant, {
      kind: "tenant",
    });
    const data = await loadTenantAccess(context, session.user.id);
    const snapshot = resolveAccessSnapshot({
      tenant: identity.context.tenant,
      userId: session.user.id,
      ...data,
      mfaVerified: false,
      now: new Date(),
    });
    if (
      !snapshot.contextFor("facility.access.assist", {
        type: "outlet",
        id: outletId,
      })
    )
      return null;
    if (!(await isEmergencyOnDuty(session.user.id, tenantId, outletId)))
      return null;
    return { userId: session.user.id, tenantId, outletId };
  } catch {
    return null;
  }
}

const streams = new Set<(signal: EmergencySignal) => Promise<number>>();
const closers = new Set<() => void>();

/** Stop upgraded sockets before closing the HTTP server. */
export function closeEmergencyRealtime(): void {
  for (const close of [...closers]) close();
}

/** Number of current on-duty staff sockets the message was queued to. */
export async function publishEmergency(
  signal: EmergencySignal,
): Promise<number> {
  const counts = await Promise.all(
    [...streams].map((dispatch) => dispatch(signal)),
  );
  return counts.reduce((total, count) => total + count, 0);
}

export function attachEmergencyRealtime(
  server: Server,
  options: {
    resolveConnection?: Resolver;
    trustedOrigins?: readonly string[];
  } = {},
) {
  const resolve = options.resolveConnection ?? resolveStaff;
  const origins = options.trustedOrigins ?? env.trustedOrigins;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const clients = new Map<
    WebSocket,
    { request: IncomingMessage; identity: Identity }
  >();
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.url !== "/api/edge/emergency/realtime") return;
    void (async () => {
      try {
        if (
          !request.headers.origin ||
          !origins.includes(request.headers.origin)
        )
          throw new Error("Origin");
        const identity = await resolve(request);
        if (!identity) throw new Error("Unauthorized");
        if (socket.destroyed) return;
        wss.handleUpgrade(request, socket, head, (ws) => {
          clients.set(ws, { request, identity });
          ws.on("close", () => clients.delete(ws));
          ws.on("message", () => ws.close(1008));
          ws.on("error", () => ws.terminate());
        });
      } catch {
        if (!socket.destroyed)
          socket.end(
            "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
      }
    })();
  };
  server.on("upgrade", upgrade);
  const dispatch = async (signal: EmergencySignal): Promise<number> => {
    const sent = await Promise.all(
      [...clients].map(async ([ws, initial]) => {
        if (
          initial.identity.tenantId !== signal.tenantId ||
          initial.identity.outletId !== signal.outletId
        )
          return 0;
        try {
          const identity = await resolve(initial.request);
          if (
            !identity ||
            identity.userId !== initial.identity.userId ||
            identity.tenantId !== signal.tenantId ||
            identity.outletId !== signal.outletId
          ) {
            ws.close(1008);
            return 0;
          }
          if (ws.readyState !== WebSocket.OPEN) return 0;
          ws.send(
            JSON.stringify({
              type: "emergency",
              incidentId: signal.incidentId,
              unitId: signal.unitId,
              triggeredAt: signal.triggeredAt,
            }),
          );
          return 1;
        } catch {
          ws.terminate();
          return 0;
        }
      }),
    );
    return sent.reduce<number>((total, count) => total + count, 0);
  };
  streams.add(dispatch);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closers.delete(close);
    streams.delete(dispatch);
    server.off("upgrade", upgrade);
    server.off("close", close);
    for (const ws of clients.keys()) ws.terminate();
    wss.close();
  };
  closers.add(close);
  server.once("close", close);
  return { dispatch, close };
}
