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
// Failed authentications (legend-x3lv) are counted per client address only;
// once an address has used up EDGE_LINK_AUTH_FAILURE_LIMIT in its window,
// upgrades from it are refused with 429 BEFORE `authenticate` runs, until the
// window ends. There is no per-node lockout: anyone who knows a node id could
// otherwise lock the real node out, and the 32-byte secret makes per-node
// guessing pointless. A success never resets a counter.
//
// Shared address (outlet Wi-Fi, carrier NAT): junk upgrades from a neighbour
// must not lock the real edge out. Each credential that authenticated
// successfully is remembered by digest (bounded, TTL
// LINK_KNOWN_CREDENTIAL_TTL_MS); presenting it skips the address lockout. It
// is still subject to the per-credential upgrade limit and is still
// authenticated (and forgotten if refused).
//
// Every dependency is injected (runtime.ts wires the Postgres ones), so this
// module has no database or env import.
import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import {
  createLinkPeer,
  type DeadLetterEntry,
  type LinkPeer,
  type LinkScope,
  type LinkStore,
} from "./link-peer.ts";
import { bearerToken, parseEdgeCredential } from "./credential.ts";
import { createFixedWindowCounter } from "../lib/fixed-window-counter.ts";
import {
  LINK_CLOSE,
  LINK_INSTANCE_HEADER,
  LINK_MAX_FRAME_BYTES,
  LINK_PATH,
  LINK_REFUSED_CREDENTIAL,
  LINK_REFUSED_HEADER,
  LINK_RESTORE_PROOF_HEADER,
  LINK_RESTORE_PROOF_V2_HEADER,
  restoreProofAckedFromHeader,
  type LinkFrame,
} from "./protocol.ts";

/**
 * Upgrade budgets, charged BEFORE the credential lookup (a database read) so
 * a flood of upgrades cannot become a flood of queries (legend-wg5t #8a). The
 * address is the client's as resolved through TRUST_PROXY (`clientAddress`),
 * never the proxy's own socket address, so a flood from one client cannot
 * spend every edge's budget; it stays generous for outlets behind one NAT.
 * The per-credential limit is tight because a healthy node reconnects with
 * backoff, a few times a minute at most.
 */
export const LINK_UPGRADE_PER_ADDRESS = 120;
export const LINK_UPGRADE_PER_NODE = 12;
const LINK_UPGRADE_WINDOW_MS = 60_000;
const LINK_UPGRADE_CAPACITY = 10_000;
/** Failed authentications per client address per window (legend-x3lv). */
export const LINK_AUTH_FAILURE_LIMIT = 10;
export const LINK_AUTH_FAILURE_WINDOW_MS = 300_000;
/** How long a successfully used credential skips the address lockout. */
export const LINK_KNOWN_CREDENTIAL_TTL_MS = 24 * 3_600_000;
const LINK_KNOWN_CREDENTIAL_CAPACITY = 10_000;
/** Heartbeat DB writes per link: the client sends one every 15 s. */
export const LINK_HEARTBEAT_WRITE_INTERVAL_MS = 10_000;

export type EdgeLinkIdentity = {
  readonly scope: LinkScope;
  /** From the `x-edge-instance` upgrade header (valid uuid), else null. */
  readonly edgeInstanceId?: string | null;
  /**
   * From the `x-edge-restore-proof` upgrade header (legend-tmar2): the edge's
   * acknowledged cursor, so the hello can prove the slots it would ack. Null
   * = absent or malformed (old edge; hello carries no proof).
   */
  readonly restoreProofAcked?: number | null;
  /**
   * From the `x-edge-restore-proof-v2` upgrade header (legend-tmar2 854): the
   * edge understands partial proofs and replay checks. Absent for an 848 edge.
   */
  readonly restoreProofStrict?: boolean;
};

const INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A single well-formed uuid header, lowercased; anything else is null. */
function instanceIdFromHeader(value: string | string[] | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return INSTANCE_ID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

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
  /** An outbound event above the frame cap moved to the dead-letter store (legend-btx4d). */
  onDeadLetter?(identity: Identity, entry: DeadLetterEntry): void;
  version: string;
  reverifyIntervalMs?: number;
  ackTimeoutMs?: number;
  /** Minimum gap between `onHeartbeat` calls (DB writes) per link. */
  heartbeatWriteIntervalMs?: number;
  /** Upgrade rate limits (legend-wg5t #8a); injectable for tests. */
  upgradeRateLimit?: {
    perAddress?: number;
    perNode?: number;
    windowMs?: number;
  };
  /** Failed-authentication lockout (legend-x3lv); injectable for tests. */
  authFailureLimit?: {
    limit?: number;
    windowMs?: number;
    /** TTL of the known-good credential bypass. */
    knownCredentialTtlMs?: number;
  };
  /**
   * The client address for the per-address upgrade limit. Production passes
   * Express's trust-proxy resolution (lib/client-address.ts); the default is
   * the socket address (no proxy in front).
   */
  clientAddress?: (request: IncomingMessage) => string;
  /** Test seam: clock in epoch ms for heartbeat throttling and rate limits. */
  now?: () => number;
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

function refuse(
  socket: Duplex,
  status: 400 | 401 | 403 | 429 | 503,
  headers: Record<string, string> = {},
) {
  const text = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    429: "Too Many Requests",
    503: "Service Unavailable",
  }[status];
  const extra = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\n${extra}Connection: close\r\n\r\n`,
  );
  socket.destroy();
}

/** 401 that tells the edge client the credential itself was refused. */
function refuseCredential(socket: Duplex) {
  refuse(socket, 401, { [LINK_REFUSED_HEADER]: LINK_REFUSED_CREDENTIAL });
}

export function createEdgeLinkServer<Identity extends EdgeLinkIdentity>(
  server: Server,
  deps: EdgeLinkServerDeps<Identity>,
): EdgeLinkServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LINK_MAX_FRAME_BYTES,
  });
  // Restore proof v2 (legend-tmar2 854): echo the header in the upgrade
  // response so a 854 edge knows this cloud can send a proof. A cloud without
  // this echo (848) never proves a partial range, so the edge must not ack on
  // a hello without proof.
  wss.on("headers", (headers, request) => {
    if (request.headers[LINK_RESTORE_PROOF_V2_HEADER] === "1")
      headers.push(`${LINK_RESTORE_PROOF_V2_HEADER}: 1`);
  });
  const now = deps.now ?? Date.now;
  const heartbeatWriteIntervalMs =
    deps.heartbeatWriteIntervalMs ?? LINK_HEARTBEAT_WRITE_INTERVAL_MS;
  const windowMs = deps.upgradeRateLimit?.windowMs ?? LINK_UPGRADE_WINDOW_MS;
  const perAddress = createFixedWindowCounter({
    limit: deps.upgradeRateLimit?.perAddress ?? LINK_UPGRADE_PER_ADDRESS,
    windowMs,
    capacity: LINK_UPGRADE_CAPACITY,
  });
  const perNode = createFixedWindowCounter({
    limit: deps.upgradeRateLimit?.perNode ?? LINK_UPGRADE_PER_NODE,
    windowMs,
    capacity: LINK_UPGRADE_CAPACITY,
  });
  const failures = createFixedWindowCounter({
    limit: deps.authFailureLimit?.limit ?? LINK_AUTH_FAILURE_LIMIT,
    windowMs: deps.authFailureLimit?.windowMs ?? LINK_AUTH_FAILURE_WINDOW_MS,
    capacity: LINK_UPGRADE_CAPACITY,
  });
  // Digest of a credential that authenticated -> expiry (epoch ms). Insertion
  // order doubles as LRU: a refreshed key moves to the end.
  const knownCredentials = new Map<string, number>();
  const knownTtlMs =
    deps.authFailureLimit?.knownCredentialTtlMs ?? LINK_KNOWN_CREDENTIAL_TTL_MS;
  const isKnownCredential = (key: string | null, at: number) => {
    if (!key) return false;
    const expiresAt = knownCredentials.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt > at) return true;
    knownCredentials.delete(key);
    return false;
  };
  const rememberCredential = (key: string | null, at: number) => {
    if (!key) return;
    knownCredentials.delete(key);
    if (knownCredentials.size >= LINK_KNOWN_CREDENTIAL_CAPACITY) {
      const oldest = knownCredentials.keys().next().value;
      if (oldest !== undefined) knownCredentials.delete(oldest);
    }
    knownCredentials.set(key, at + knownTtlMs);
  };
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
    // Heartbeats arrive every 15 s but each one is a DB write; persist at most
    // one per interval per link and drop the rest (legend-wg5t #1b).
    let lastHeartbeatWrite = Number.NEGATIVE_INFINITY;
    const peer = createLinkPeer({
      scope: identity.scope,
      outboundDirection: "cloud_to_edge",
      store: deps.storeFor(identity),
      ...(identity.restoreProofAcked != null
        ? {
            restoreProofAcked: identity.restoreProofAcked,
            ...(identity.restoreProofStrict
              ? { restoreProofStrict: true }
              : {}),
          }
        : {}),
      version: deps.version,
      ackTimeoutMs: deps.ackTimeoutMs,
      onError: deps.onError,
      onDeadLetter: (entry) => deps.onDeadLetter?.(identity, entry),
      onHeartbeat: (frame) => {
        const at = now();
        if (at - lastHeartbeatWrite < heartbeatWriteIntervalMs) return;
        lastHeartbeatWrite = at;
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
        // Charge before authenticate (a DB read; legend-wg5t #8a). The second
        // bucket is per presented credential (a digest of the whole token,
        // only for well-formed ones, no DB): a node stuck in a reconnect loop
        // is capped, while someone who knows a node's id but not its secret
        // lands in another bucket and cannot lock the real node out.
        const at = now();
        const address = deps.clientAddress
          ? deps.clientAddress(request)
          : (request.socket.remoteAddress ?? "unknown");
        const token = bearerToken(request.headers.authorization);
        const credentialKey =
          token && parseEdgeCredential(token)
            ? `credential:${createHash("sha256").update(token).digest("base64url")}`
            : null;
        const retryAfter =
          perAddress.take(`ip:${address}`, at) ??
          (credentialKey ? perNode.take(credentialKey, at) : null);
        if (retryAfter !== null)
          return refuse(socket, 429, {
            "retry-after": String(retryAfter),
            "cache-control": "no-store",
          });
        // Per-address failure lockout, checked before authenticate
        // (legend-x3lv).
        // A credential that authenticated before skips it (shared address).
        // An unknown credential reserves its failure slot now, before the
        // authenticate await: a peek here only sees failures already counted,
        // so a parallel burst would all pass it (legend-12ku). The slot is
        // handed back when authentication succeeds.
        const failureKey = `ip:${address}`;
        const known = isKnownCredential(credentialKey, at);
        const slot = known ? null : failures.reserve(failureKey, at);
        if (slot && slot.retryAfter !== null) {
          // A refused reserve is not a failure: hand its count back so only
          // real failures and in-flight attempts count. Otherwise a reconnect
          // burst behind one venue NAT (after a cloud restart) would lock the
          // address out for the whole window (legend-12ku).
          slot.release();
          return refuse(socket, 429, {
            "retry-after": String(slot.retryAfter),
            "cache-control": "no-store",
          });
        }
        const failed = () => {
          if (credentialKey) knownCredentials.delete(credentialKey);
          // A reserved slot already counts this failure; take only otherwise.
          if (!slot) failures.take(failureKey, now());
          refuseCredential(socket);
        };
        if (!token) return failed();
        let identity: Identity | null;
        try {
          identity = await deps.authenticate(token);
        } catch (error) {
          // A cloud-side failure is not a bad credential: do not charge it.
          slot?.release();
          throw error;
        }
        if (!identity) return failed();
        slot?.release();
        rememberCredential(credentialKey, now());
        if (socket.destroyed) return;
        const authenticated: Identity = {
          ...identity,
          edgeInstanceId: instanceIdFromHeader(
            request.headers[LINK_INSTANCE_HEADER],
          ),
          restoreProofAcked: restoreProofAckedFromHeader(
            request.headers[LINK_RESTORE_PROOF_HEADER],
          ),
          restoreProofStrict:
            request.headers[LINK_RESTORE_PROOF_V2_HEADER] === "1",
        };
        wss.handleUpgrade(request, socket, head, (ws) =>
          attach(ws, authenticated),
        );
      } catch (error) {
        deps.onError?.(error);
        // A cloud-side failure (database blip, pool exhausted) is transient:
        // 503 keeps the edge retrying. Only a refused credential is 401 with
        // the refusal header, which the edge client treats as final (review
        // fix, legend-wg5t #6).
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
