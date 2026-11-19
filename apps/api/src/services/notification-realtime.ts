import type { IncomingMessage, Server } from "node:http";
import type { Pool } from "pg";
import WebSocket, { WebSocketServer } from "ws";
import {
  z,
  assertTrustedScopedContext,
  assertOutletInScope,
  tenantIdSchema,
  ulidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  realtimeNotificationMessageSchema,
  type Notification,
} from "@starter/shared/notification";

/** Only identifiers cross PostgreSQL NOTIFY; row contents remain under RLS. */
export const NOTIFICATION_WAKE_CHANNEL = "legend_notification_wakeup";
const signalSchema = z.strictObject({
  tenantId: tenantIdSchema,
  notificationId: ulidSchema,
});
/** How long one shared-tablet answer is reused for a connected socket. */
const SHARED_RECHECK_WINDOW_MS = 5_000;
type Signal = z.infer<typeof signalSchema>;
type Identity = { userId: string; context: ScopedTenantContext };
type Options = {
  /** Must verify the session and current tenant and outlet assignments each time. */
  resolveConnection?: (request: IncomingMessage) => Promise<Identity | null>;
  /** Reads only rows visible to this context, inside withTenant. */
  lookup?: (
    context: ScopedTenantContext,
    id: string,
  ) => Promise<Notification | null>;
  trustedOrigins?: readonly string[];
  /**
   * legend-iq0jz (founder Q29): true when the request comes from a shared
   * tablet, which never receives notifications. Checked at upgrade and on each
   * recheck (answer reused for 5 s per socket), so a tablet flagged later loses
   * the socket on a wakeup after that window.
   */
  isSharedDevice?: (request: IncomingMessage) => Promise<boolean>;
};

/** The default ports deny every connection until the tenant/RBAC beads wire them. */
export function attachNotificationRealtime(
  server: Server,
  options: Options = {},
) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const clients = new Map<
    WebSocket,
    { request: IncomingMessage; userId: string; tenantId: string }
  >();
  const resolveIdentity = options.resolveConnection ?? (async () => null);
  // The shared-tablet answer is cached per socket request for a short window,
  // so a burst of wakeups costs one session read, not one per wakeup. The
  // upgrade has no entry yet and always asks fresh.
  const sharedAnswers = new WeakMap<
    IncomingMessage,
    { at: number; shared: boolean }
  >();
  const isShared = async (request: IncomingMessage) => {
    if (!options.isSharedDevice) return false;
    const cached = sharedAnswers.get(request);
    if (cached && Date.now() - cached.at < SHARED_RECHECK_WINDOW_MS)
      return cached.shared;
    const shared = await options.isSharedDevice(request);
    sharedAnswers.set(request, { at: Date.now(), shared });
    return shared;
  };
  const resolve = async (request: IncomingMessage) => {
    const identity = await resolveIdentity(request);
    if (identity && (await isShared(request))) return null;
    return identity;
  };
  const lookup = options.lookup ?? (async () => null);
  const upgrade = (
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    if (request.url !== "/api/notifications/realtime") return;
    void (async () => {
      try {
        if (
          !request.headers.origin ||
          !options.trustedOrigins?.includes(request.headers.origin)
        )
          throw new Error("Untrusted origin");
        const identity = await resolve(request);
        if (!identity) throw new Error("Unauthorized");
        assertTrustedScopedContext(identity.context);
        if (socket.destroyed) return;
        wss.handleUpgrade(request, socket, head, (ws) => {
          clients.set(ws, {
            request,
            userId: identity.userId,
            tenantId: identity.context.tenant.tenantId,
          });
          ws.on("close", () => clients.delete(ws));
          // This is a server-to-client stream: ignore incoming data.
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
  async function dispatch(input: unknown) {
    const parsed = signalSchema.safeParse(input);
    if (!parsed.success) return;
    const signal: Signal = parsed.data;
    await Promise.all(
      [...clients].map(async ([ws, initial]) => {
        // Cheap tenant filter first: a signal must not trigger a session
        // re-check for every connected client of every tenant.
        if (initial.tenantId !== signal.tenantId) return;
        try {
          const identity = await resolve(initial.request);
          if (
            !identity ||
            identity.userId !== initial.userId ||
            identity.context.tenant.tenantId !== initial.tenantId
          ) {
            ws.close(1008);
            return;
          }
          assertTrustedScopedContext(identity.context);
          if (identity.context.tenant.tenantId !== signal.tenantId) return;
          const notification = await lookup(
            identity.context,
            signal.notificationId,
          );
          if (
            !notification ||
            notification.id !== signal.notificationId ||
            notification.tenantId !== signal.tenantId ||
            notification.userId !== identity.userId
          )
            return;
          if (notification.outletId)
            assertOutletInScope(
              identity.context.outletScope,
              notification.outletId,
            );
          else if (identity.context.outletScope.kind !== "tenant") return;
          const message = realtimeNotificationMessageSchema.parse({
            type: "notification",
            notification,
          });
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify(message));
        } catch {
          ws.close(1008);
        }
      }),
    );
  }
  return {
    dispatch,
    async close() {
      server.off("upgrade", upgrade);
      for (const ws of clients.keys()) ws.terminate();
      await new Promise<void>((done) => wss.close(() => done()));
    },
  };
}

/** LISTEN sees notifications only after the producing transaction commits. */
export async function listenNotificationWakeups(
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
      if (message.channel !== NOTIFICATION_WAKE_CHANNEL || !message.payload)
        return;
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
      await client.query(`LISTEN ${NOTIFICATION_WAKE_CHANNEL}`);
    } catch (error) {
      release(true);
      throw error;
    }
    cleanup = async () => {
      if (released) return;
      try {
        await client.query(`UNLISTEN ${NOTIFICATION_WAKE_CHANNEL}`);
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
