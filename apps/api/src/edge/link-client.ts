// Edge side of the persistent link (bead legend-2pi; PRD v1.7 §3 F5,
// §4 Alur F step 1 "Edge node mendeteksi koneksi cloud terputus"). Opens one
// authenticated WebSocket to the cloud, reconnects with capped exponential
// backoff and jitter, and reports the cloud link state for /api/edge/status.
//
// The credential travels in the Authorization header only (never the URL,
// never a log line). A 4403 close (credential refused or node revoked,
// EDG-03) stops reconnecting: a revoked node must not hammer the cloud, and
// keeps serving the outlet offline until it is re-provisioned.
import WebSocket from "ws";
import type { CloudLink } from "@starter/shared/edge";
import {
  createLinkPeer,
  type LinkPeer,
  type LinkScope,
  type LinkStore,
} from "./link-peer.ts";
import {
  LINK_CLOSE,
  LINK_INSTANCE_HEADER,
  LINK_MAX_FRAME_BYTES,
  LINK_REFUSED_CREDENTIAL,
  LINK_REFUSED_HEADER,
  encodeFrame,
  type CatalogStale,
} from "./protocol.ts";

export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Full-jitter exponential backoff: random in [0, min(max, base * 2^attempt)]. */
export function reconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * 2 ** Math.min(Math.max(attempt, 0), 16),
  );
  return Math.max(RECONNECT_BASE_MS / 2, Math.floor(random() * ceiling));
}

export type EdgeLinkClientState = {
  readonly cloudLink: CloudLink;
  /** True after the cloud refused the credential (4403): no more retries. */
  readonly refused: boolean;
  readonly lastConnectedAt: Date | null;
};

export type EdgeLinkClientOptions = {
  /** wss://<cloud>/api/edge-link */
  url: string;
  credential: string;
  /** This edge database's instance id, sent as `x-edge-instance`. */
  instanceId?: string | null;
  scope: LinkScope;
  store: LinkStore;
  version: string;
  onState?: (state: EdgeLinkClientState) => void;
  onError?: (error: unknown) => void;
  /**
   * The link closed with this code and reason (legend-a9iby): the reason of a
   * 1008 refusal is the only place an operator learns why the cloud refuses
   * this database, so the runtime logs it.
   */
  onClose?: (code: number, reason: string) => void;
  /** Test seams. */
  random?: () => number;
  ackTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  /**
   * Catalog streams stale for over 30 minutes while the cloud answers
   * (legend-10nex); sent with every heartbeat while they last, so a lost
   * frame repeats itself. The heartbeat only flows while the link is up: an
   * offline edge never reports.
   */
  catalogStale?: () => CatalogStale;
};

export type EdgeLinkClient = {
  state(): EdgeLinkClientState;
  /** New events were queued locally (offline queue): push if connected. */
  notify(): void;
  stop(): Promise<void>;
};

export function createEdgeLinkClient(
  options: EdgeLinkClientOptions,
): EdgeLinkClient {
  let socket: WebSocket | undefined;
  let peer: LinkPeer | undefined;
  let attempt = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let state: EdgeLinkClientState = {
    cloudLink: "disconnected",
    refused: false,
    lastConnectedAt: null,
  };
  const setState = (next: Partial<EdgeLinkClientState>) => {
    state = { ...state, ...next };
    options.onState?.(state);
  };

  function schedule() {
    if (stopped || state.refused) return;
    const delay = reconnectDelayMs(attempt++, options.random);
    retry = setTimeout(connect, delay);
    retry.unref?.();
  }

  function connect() {
    if (stopped) return;
    const ws = new WebSocket(options.url, {
      headers: {
        authorization: `Bearer ${options.credential}`,
        ...(options.instanceId
          ? { [LINK_INSTANCE_HEADER]: options.instanceId }
          : {}),
      },
      maxPayload: LINK_MAX_FRAME_BYTES,
      handshakeTimeout: 10_000,
    });
    socket = ws;
    const linkPeer = createLinkPeer({
      scope: options.scope,
      outboundDirection: "edge_to_cloud",
      store: options.store,
      version: options.version,
      ackTimeoutMs: options.ackTimeoutMs,
      onError: options.onError,
      transport: {
        send: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        close: (code, reason) => ws.close(code, reason.slice(0, 120)),
      },
    });
    ws.on("open", () => {
      attempt = 0;
      peer = linkPeer;
      setState({ cloudLink: "connected", lastConnectedAt: new Date() });
      linkPeer.start();
      const sendHeartbeat = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        let catalogStale: CatalogStale = [];
        try {
          catalogStale = options.catalogStale?.() ?? [];
        } catch {
          // A broken status source must not stop the heartbeat.
        }
        ws.send(
          encodeFrame({
            type: "heartbeat",
            version: options.version,
            occurredAt: new Date().toISOString(),
            ...(catalogStale.length > 0 ? { catalogStale } : {}),
          }),
        );
      };
      sendHeartbeat();
      heartbeat = setInterval(
        sendHeartbeat,
        options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
      );
      heartbeat.unref?.();
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        ws.close(LINK_CLOSE.protocol, "Binary frames are not accepted");
        return;
      }
      linkPeer.receive(data.toString());
    });
    // A refused upgrade (401/403) arrives as an unexpected response. Only the
    // cloud's explicit credential-refusal header is final: a bare 401/403 can
    // come from a WAF or proxy in front of the cloud, and a 429 or 503 is
    // transient, so those back off and retry (legend-wg5t #6, #8a).
    ws.on("unexpected-response", (_request, response) => {
      if (
        (response.statusCode === 401 || response.statusCode === 403) &&
        response.headers[LINK_REFUSED_HEADER] === LINK_REFUSED_CREDENTIAL
      )
        setState({ refused: true });
      ws.terminate();
    });
    ws.on("error", (error) => {
      options.onError?.(new Error(`Edge link socket error: ${error.message}`));
    });
    ws.on("close", (code, reason) => {
      options.onClose?.(code, reason.toString("utf8"));
      linkPeer.stop();
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      if (peer === linkPeer) peer = undefined;
      if (socket === ws) socket = undefined;
      setState({
        cloudLink: "disconnected",
        refused: state.refused || code === LINK_CLOSE.revoked,
      });
      schedule();
    });
  }

  connect();
  return {
    state: () => state,
    notify() {
      peer?.notify();
    },
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (heartbeat) clearInterval(heartbeat);
      peer?.stop();
      const ws = socket;
      if (!ws || ws.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close(LINK_CLOSE.shutdown, "Edge shutting down");
        setTimeout(() => {
          ws.terminate();
          resolve();
        }, 2_000).unref?.();
      });
    },
  };
}
