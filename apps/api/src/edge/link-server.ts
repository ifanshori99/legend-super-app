// Cloud side of the persistent link (bead legend-2pi; PRD v1.7 §3 F5
// "Pesanan Pelanggan dari Cloud": "cloud meneruskan pesanan ke edge melalui
// koneksi persisten"; §7 realtime). Accepts WebSocket upgrades on
// /api/edge-link from edge nodes that present a valid credential, one
// connection per node (a newer connection replaces the older one), and runs a
// LinkPeer that sends cloud -> edge and receives edge -> cloud.
//
// Authentication is a bearer credential in the Authorization header, checked
// before the upgrade completes (401 otherwise). A request that carries an
// Origin header is refused: the link is server-to-server, so a browser page
// must never be able to open it. The node's status is re-checked on every
// heartbeat interval, so a revocation from another API instance closes the
// link (4403) within `reverifyIntervalMs` (EDG-03); the instance that revoked
// it closes immediately through `disconnect`.
//
// Every dependency is injected (runtime.ts wires the Postgres ones), so this
// module has no database or env import.
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  createLinkPeer,
  type LinkPeer,
  type LinkScope,
  type LinkStore,
} from "./link-peer.ts";
import { bearerToken } from "./credential.ts";
import {
  LINK_CLOSE,
  LINK_MAX_FRAME_BYTES,
  LINK_PATH,
  type LinkFrame,
} from "./protocol.ts";

export type EdgeLinkIdentity = { readonly scope: LinkScope };

export type EdgeLinkServerDeps<Identity extends EdgeLinkIdentity> = {
  /** Verify the bearer credential; null for anything not accepted. */
  authenticate(token: string): Promise<Identity | null>;
  /** The node is still registered and active. */
  isActive(identity: Identity): Promise<boolean>;
  storeFor(identity: Identity): LinkStore;
  onHeartbeat?(
    identity: Identity,
    frame: Extract<LinkFrame, { type: "heartbeat" }>,
  ): Promise<void>;
  onConnectionChange?(identity: Identity, connected: boolean): void;
  onError?(error: unknown): void;
  version: string;
  reverifyIntervalMs?: number;
  ackTimeoutMs?: number;
};

export type EdgeLinkServer = {
  /** Events were queued for this node: push them now if it is connected. */
  notify(edgeNodeId: string): void;
  /** Fallback sweep for missed wakeups: poke every connected node. */
  notifyAll(): void;
  /** Close the node's link (e.g. right after revocation). */
  disconnect(edgeNodeId: string, code?: number): void;
  isConnected(edgeNodeId: string): boolean;
  close(): Promise<void>;
};

function refuse(socket: Duplex, status: 400 | 401 | 403 | 503) {
  const text = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    503: "Service Unavailable",
  }[status];
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function createEdgeLinkServer<Identity extends EdgeLinkIdentity>(
  server: Server,
  deps: EdgeLinkServerDeps<Identity>,
): EdgeLinkServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LINK_MAX_FRAME_BYTES,
  });
  const links = new Map<
    string,
    { ws: WebSocket; peer: LinkPeer; identity: Identity; timer: NodeJS.Timeout }
  >();

  function attach(ws: WebSocket, identity: Identity) {
    const nodeId = identity.scope.edgeNodeId;
    const previous = links.get(nodeId);
    if (previous) {
      // Stop the old peer first so two peers never drive one node's cursors.
      previous.peer.stop();
      clearInterval(previous.timer);
      previous.ws.close(LINK_CLOSE.replaced, "Replaced");
    }
    const peer = createLinkPeer({
      scope: identity.scope,
      outboundDirection: "cloud_to_edge",
      store: deps.storeFor(identity),
      version: deps.version,
      ackTimeoutMs: deps.ackTimeoutMs,
      onError: deps.onError,
      onHeartbeat: (frame) => {
        void deps.onHeartbeat?.(identity, frame).catch(deps.onError);
      },
      transport: {
        send: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        close: (code, reason) => ws.close(code, reason.slice(0, 120)),
      },
    });
    const timer = setInterval(() => {
      deps
        .isActive(identity)
        .then((active) => {
          if (!active) ws.close(LINK_CLOSE.revoked, "Edge node revoked");
        })
        .catch(deps.onError);
    }, deps.reverifyIntervalMs ?? 30_000);
    timer.unref();
    links.set(nodeId, { ws, peer, identity, timer });
    deps.onConnectionChange?.(identity, true);
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(LINK_CLOSE.protocol, "Binary frames are not accepted");
        return;
      }
      peer.receive(data.toString());
    });
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      peer.stop();
      clearInterval(timer);
      if (links.get(nodeId)?.ws === ws) {
        links.delete(nodeId);
        deps.onConnectionChange?.(identity, false);
      }
    });
    peer.start();
  }

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "", "http://edge-link.invalid")
        .pathname;
    } catch {
      return;
    }
    if (pathname !== LINK_PATH) return;
    void (async () => {
      try {
        if (request.headers.origin) return refuse(socket, 403);
        const token = bearerToken(request.headers.authorization);
        if (!token) return refuse(socket, 401);
        const identity = await deps.authenticate(token);
        if (!identity) return refuse(socket, 401);
        if (socket.destroyed) return;
        wss.handleUpgrade(request, socket, head, (ws) => attach(ws, identity));
      } catch (error) {
        deps.onError?.(error);
        // A cloud-side failure (database blip, pool exhausted) is transient:
        // 503 keeps the edge retrying. Only a refused credential is 401, which
        // the edge client treats as final (review fix).
        if (!socket.destroyed) refuse(socket, 503);
      }
    })();
  };
  server.on("upgrade", upgrade);

  return {
    notify(edgeNodeId) {
      links.get(edgeNodeId)?.peer.notify();
    },
    notifyAll() {
      for (const link of links.values()) link.peer.notify();
    },
    disconnect(edgeNodeId, code = LINK_CLOSE.revoked) {
      links.get(edgeNodeId)?.ws.close(code, "Disconnected by the cloud");
    },
    isConnected: (edgeNodeId) => links.has(edgeNodeId),
    async close() {
      server.off("upgrade", upgrade);
      for (const link of links.values()) {
        clearInterval(link.timer);
        link.peer.stop();
        link.ws.close(LINK_CLOSE.shutdown, "Cloud shutting down");
      }
      await new Promise<void>((done) => wss.close(() => done()));
      for (const link of links.values()) link.ws.terminate();
      links.clear();
    },
  };
}
