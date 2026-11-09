// Runtime wiring of the edge mode (bead legend-2pi; PRD v1.7 §3 F5 "Server
// Lokal", §4 Alur F, §5 Edge Node). The API bootstrap calls exactly one of:
//
//   - `startEdgeRuntime()` on every process start. On the cloud
//     (EDGE_MODE=false) it is a no-op. On the edge it runs the boot guards
//     (edge settings valid, local migrations applied, the node's own row
//     present and active), then opens the persistent link to the cloud with
//     reconnect + backoff, keeps the cloud link state for /api/edge/status,
//     and starts the periodic device-registry pull (legend-2lp.7; EDG-02:
//     revocations reach the edge only through this pull, so a stale replica
//     is reported in /api/edge/status and /api/edge/health, never hidden). The edge's local PostgreSQL is migrated by the same
//     migrator as the cloud (`node dist/migrate.js` / `pnpm db:migrate` with
//     DATABASE_URL pointing at the local database) before the API starts.
//   - `registerEdgeLink(server)` on the cloud only: accepts edge links on
//     /api/edge-link. Refuses to run with EDGE_MODE=true. It LISTENs on
//     EDGE_NODE_REVOKED_CHANNEL so a revocation on another API instance closes
//     this instance's link at once (legend-x3lv).
//
// Both prune acknowledged queue rows every hour (legend-x3lv,
// `pruneAckedEdgeQueue`).
//
// Errors from the link are logged by name/code only: driver errors can carry
// SQL parameters (event payloads), and the credential must never be logged.
import type { IncomingMessage, Server } from "node:http";
import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { parseEdgeHardeningEnv } from "@starter/shared/env";
import type { ScopedTenantContext } from "@starter/shared/core";
import { db, pool } from "../db/index.ts";
import { env } from "../config/env.ts";
import { logger } from "../lib/logger.ts";
import {
  authenticateEdgeCredential,
  EDGE_NODE_REVOKED_CHANNEL,
  ensureLocalEdgeNode,
  isEdgeNodeActive,
  onEdgeNodeRevoked,
  recordEdgeHeartbeat,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  isDeviceSyncCursorError,
  pullDeviceRegistry,
} from "../services/edge-device-sync.ts";
import {
  loadDeviceRegistryCheckpoint,
  saveDeviceRegistryCheckpoint,
} from "../services/edge-device-sync-store.ts";
import {
  EDGE_LINK_WAKE_CHANNEL,
  EDGE_QUEUE_PRUNE_INTERVAL_MS,
  pruneAckedEdgeQueue,
} from "../services/edge-queue.service.ts";
import { bootstrapEdgeNodeIfNeeded } from "./bootstrap.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "./deferred-event-applier.ts";
import { registerQrOrderEdgeApplier } from "./qr-order-applier.ts";
import { registerStockMovedEdgeApplier } from "./stock-moved-applier.ts";
import {
  createDeviceRecordsFetcher,
  EdgeCloudHttpError,
} from "./cloud-http.ts";
import { parseEdgeRuntimeConfig } from "./config.ts";
import { createDbLinkStore } from "./db-link-store.ts";
import {
  createEdgeLinkClient,
  type EdgeLinkClientState,
} from "./link-client.ts";
import type { LinkScope } from "./link-peer.ts";
import { createEdgeLinkServer } from "./link-server.ts";
import {
  createDeviceRegistryPuller,
  pullWithCursorRecovery,
  type DeviceRegistryPuller,
  type DeviceRegistrySyncState,
} from "./device-registry-puller.ts";

/** Tables the edge runtime needs; missing ones mean migrations did not run. */
export const EDGE_REQUIRED_TABLES = [
  "tenants",
  "outlets",
  "edge_nodes",
  "sync_cursors",
  "edge_outbound_queue",
  "edge_inbound_events",
  "edge_sync_conflicts",
  "edge_pull_checkpoints",
] as const;

/** Missed-wakeup fallback: how often an idle link re-checks its queue. */
const SWEEP_INTERVAL_MS = 5_000;

/** The cloud answered 400 to the first request of a pull (its cursor). */
class StoredCursorRefusedError extends Error {
  constructor() {
    super("The cloud refused the stored device-registry cursor");
    this.name = "StoredCursorRefusedError";
  }
}

/**
 * The stored device-registry cursor was refused: malformed on the edge, or a
 * 400 on the pull's first request. A bad record is not a cursor problem and
 * is not retried from the start.
 */
function isRejectedCursor(error: unknown): boolean {
  return (
    error instanceof StoredCursorRefusedError || isDeviceSyncCursorError(error)
  );
}

/** Longest wait between device-registry pulls while the cloud is failing. */
const MIN_MAX_PULL_BACKOFF_MS = 300_000;

export class EdgeBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeBootError";
  }
}

export type EdgeRuntimeState = {
  readonly edgeMode: boolean;
  /** The node this process serves (edge only). */
  readonly identity: {
    readonly context: ScopedTenantContext;
    readonly scope: LinkScope;
  } | null;
  readonly link: EdgeLinkClientState;
};

const disconnected: EdgeLinkClientState = {
  cloudLink: "disconnected",
  refused: false,
  lastConnectedAt: null,
};
let state: EdgeRuntimeState = {
  edgeMode: false,
  identity: null,
  link: disconnected,
};

export function getEdgeRuntimeState(): EdgeRuntimeState {
  return state;
}

let registryPuller: DeviceRegistryPuller | null = null;

/** Device-registry pull state (edge only); null on the cloud or before boot. */
export function getDeviceRegistrySyncState(): DeviceRegistrySyncState | null {
  return registryPuller?.getState() ?? null;
}

/** Test seam: install a runtime state without starting a link. */
export function setEdgeRuntimeStateForTests(next: EdgeRuntimeState): void {
  state = next;
}

function safeError(error: unknown) {
  const candidate = error as { name?: unknown; code?: unknown };
  return {
    errName: typeof candidate?.name === "string" ? candidate.name : "Error",
    code: typeof candidate?.code === "string" ? candidate.code : undefined,
  };
}

const wakeSchema = z.strictObject({
  tenantId: z.uuid(),
  edgeNodeId: z.uuid(),
});

/**
 * LISTEN on one channel, reconnecting after a connection error. `onPayload`
 * gets the raw payload; notifications are hints, so callers keep a fallback.
 */
async function listenPgChannel(
  source: Pool,
  channel: string,
  onPayload: (payload: string) => void,
): Promise<() => Promise<void>> {
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  const schedule = () => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      void connect().catch(schedule);
    }, 5_000);
    retry.unref();
  };
  const connect = async () => {
    const client = await source.connect();
    if (closed) {
      client.release();
      return;
    }
    let released = false;
    const onNotification = (message: { channel: string; payload?: string }) => {
      if (message.channel !== channel || !message.payload) return;
      onPayload(message.payload);
    };
    const release = (destroy: boolean) => {
      if (released) return;
      released = true;
      client.removeListener("notification", onNotification);
      client.release(destroy);
    };
    client.on("error", () => {
      release(true);
      schedule();
    });
    client.on("notification", onNotification);
    try {
      await client.query(`LISTEN ${channel}`);
    } catch (error) {
      release(true);
      throw error;
    }
    cleanup = async () => {
      if (released) return;
      try {
        await client.query(`UNLISTEN ${channel}`);
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

/** LISTEN for queue wakeups (ids only). Hints: the sweep covers misses. */
function listenEdgeLinkWakeups(
  source: Pool,
  onWake: (signal: z.infer<typeof wakeSchema>) => void,
): Promise<() => Promise<void>> {
  return listenPgChannel(source, EDGE_LINK_WAKE_CHANNEL, (payload) => {
    try {
      const signal = wakeSchema.safeParse(JSON.parse(payload));
      if (signal.success) onWake(signal.data);
    } catch {
      /* Invalid hint: ignored. */
    }
  });
}

/**
 * LISTEN for revocations from any API instance (legend-x3lv). The payload is
 * the node id; the periodic re-check covers a missed notification.
 */
function listenEdgeNodeRevocations(
  source: Pool,
  onRevoked: (edgeNodeId: string) => void,
): Promise<() => Promise<void>> {
  return listenPgChannel(source, EDGE_NODE_REVOKED_CHANNEL, (payload) => {
    const id = z.uuid().safeParse(payload);
    if (id.success) onRevoked(id.data);
  });
}

/**
 * Hourly prune of acknowledged queue rows (legend-x3lv). Never overlaps
 * itself; failures are logged by name only and retried next hour.
 */
function startAckedQueuePrune(retentionDays: number): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    pruneAckedEdgeQueue({ retentionDays })
      .then((result) => {
        if (result.failedTenants > 0)
          logger.warn(
            { failedTenants: result.failedTenants },
            "Edge queue prune failed for some tenants",
          );
      })
      .catch((error: unknown) =>
        logger.warn(safeError(error), "Edge queue prune failed"),
      )
      .finally(() => {
        running = false;
      });
  }, EDGE_QUEUE_PRUNE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Boot guard: the local database carries the edge schema. */
export async function assertEdgeSchemaReady(): Promise<void> {
  const result = await db.execute(
    sql`SELECT name FROM unnest(${`{${EDGE_REQUIRED_TABLES.join(",")}}`}::text[]) AS name WHERE to_regclass('public.' || name) IS NULL`,
  );
  if (result.rows.length > 0)
    throw new EdgeBootError(
      `The local database is missing ${result.rows.map((row) => String(row.name)).join(", ")}; run the migrator against the edge PostgreSQL before starting the API.`,
    );
}

export type EdgeRuntimeHandle = { stop(): Promise<void> };

/**
 * Call once at API start. Cloud: no-op. Edge: boot guards, then the link.
 * Throws EdgeBootError for a misconfigured or unprovisioned node; the caller
 * logs it and exits non-zero.
 */
export async function startEdgeRuntime(
  source: Record<string, string | undefined> = process.env,
): Promise<EdgeRuntimeHandle> {
  const parsed = parseEdgeRuntimeConfig(source);
  if (!parsed.ok)
    throw new EdgeBootError(
      `Invalid edge settings:\n${parsed.problems.map((p) => `  ${p}`).join("\n")}`,
    );
  const config = parsed.config;
  if (!config.edgeMode) {
    state = { edgeMode: false, identity: null, link: disconnected };
    registryPuller = null;
    return { stop: async () => {} };
  }
  await assertEdgeSchemaReady();
  // legend-s4r6: cloud -> edge appliers, before the link can deliver.
  registerQrOrderEdgeApplier();
  // Section D (legend-khu5): first boot provisions the node from its bundle.
  await bootstrapEdgeNodeIfNeeded(config);
  let local: Awaited<ReturnType<typeof ensureLocalEdgeNode>>;
  try {
    local = await ensureLocalEdgeNode(config.credential, {
      role: config.role,
      version: config.version,
    });
  } catch (error) {
    throw new EdgeBootError(
      error instanceof Error && !("code" in error)
        ? error.message
        : "The edge node could not be provisioned locally (tenant and outlet rows must be seeded first).",
    );
  }
  const identity = { context: local.context, scope: local.scope };
  state = { edgeMode: true, identity, link: disconnected };
  const client = createEdgeLinkClient({
    url: config.cloudUrl,
    credential: config.credential,
    scope: local.scope,
    version: config.version,
    store: createDbLinkStore({
      database: db,
      context: local.context,
      node: local.scope,
      outboundDirection: "edge_to_cloud",
    }),
    onState: (link) => {
      const wasConnected = state.link.cloudLink === "connected";
      state = { ...state, link };
      if (wasConnected !== (link.cloudLink === "connected"))
        logger.info({ cloudLink: link.cloudLink }, "Edge cloud link changed");
      if (link.refused)
        logger.error(
          "The cloud refused this edge node's credential (revoked?)",
        );
    },
    onError: (error) => logger.warn(safeError(error), "Edge link error"),
  });
  const stopWakeups = await listenEdgeLinkWakeups(pool, (signal) => {
    if (signal.edgeNodeId === local.scope.edgeNodeId) client.notify();
  });
  const sweep = setInterval(() => client.notify(), SWEEP_INTERVAL_MS);
  sweep.unref();
  const stopPrune = startAckedQueuePrune(
    parseEdgeHardeningEnv(source).EDGE_QUEUE_ACKED_RETENTION_DAYS,
  );
  const fetchDeviceRecords = createDeviceRecordsFetcher({
    cloudUrl: config.cloudUrl,
    credential: config.credential,
  });
  const puller = createDeviceRegistryPuller({
    pull: (since, signal) =>
      pullWithCursorRecovery(
        (from) => {
          let first = true;
          return pullDeviceRegistry({
            context: local.context,
            since: from,
            fetchPage: async (cursor) => {
              const isFirst = first;
              first = false;
              try {
                return await fetchDeviceRecords(cursor, signal);
              } catch (error) {
                if (
                  isFirst &&
                  error instanceof EdgeCloudHttpError &&
                  error.code === "HTTP_400"
                )
                  throw new StoredCursorRefusedError();
                throw error;
              }
            },
          });
        },
        since,
        isRejectedCursor,
        () =>
          logger.warn(
            "Edge device registry cursor refused; pulling from the start",
          ),
      ),
    load: () =>
      loadDeviceRegistryCheckpoint(local.context, local.scope.edgeNodeId),
    save: (input) =>
      saveDeviceRegistryCheckpoint(
        local.context,
        local.scope.edgeNodeId,
        input,
      ),
    intervalMs: config.deviceSyncIntervalMs,
    staleAfterMs: config.deviceSyncStaleAfterMs,
    maxBackoffMs: Math.max(
      config.deviceSyncIntervalMs,
      MIN_MAX_PULL_BACKOFF_MS,
    ),
    onStaleChange: (stale) => {
      if (stale)
        logger.error(
          "Edge device registry replica is stale; device revocations may be missing",
        );
      else logger.info("Edge device registry replica is fresh again");
    },
    onError: (error) =>
      logger.warn(safeError(error), "Edge device registry pull failed"),
  });
  registryPuller = puller;
  // Not awaited: boot never waits for, or fails on, the cloud.
  puller.start();
  return {
    async stop() {
      clearInterval(sweep);
      stopPrune();
      // Torn down together: a pull stuck in a slow local write must not hold
      // the link and the wakeup listener open during shutdown.
      await Promise.all([puller.stop(), stopWakeups(), client.stop()]);
      if (registryPuller === puller) registryPuller = null;
      state = { ...state, link: disconnected };
    },
  };
}

export type EdgeLinkHandle = {
  notify(edgeNodeId: string): void;
  isConnected(edgeNodeId: string): boolean;
  close(): Promise<void>;
};

/** Cloud only: accept edge links on /api/edge-link. */
export async function registerEdgeLink(
  server: Server,
  options: {
    /** Client address for the upgrade rate limit (TRUST_PROXY-aware). */
    clientAddress?: (request: IncomingMessage) => string;
  } = {},
): Promise<EdgeLinkHandle> {
  if (env.EDGE_MODE)
    throw new EdgeBootError("registerEdgeLink runs on the cloud only");
  // legend-s4r6: edge -> cloud appliers, before any edge can connect.
  registerStockMovedEdgeApplier();
  // legend-9fhs: POS (WS-04) events parked in edge_deferred_events (no stall).
  registerPosDeferredEdgeApplier();
  // Last: anything still unregistered is parked as unclassified, not a stall.
  registerEdgeDeferredFallback();
  const version = env.EDGE_NODE_VERSION;
  const hardening = parseEdgeHardeningEnv(process.env);
  const linkServer = createEdgeLinkServer<AuthenticatedEdgeNode>(server, {
    version,
    clientAddress: options.clientAddress,
    authFailureLimit: {
      limit: hardening.EDGE_LINK_AUTH_FAILURE_LIMIT,
      windowMs: hardening.EDGE_LINK_AUTH_FAILURE_WINDOW_SECONDS * 1000,
    },
    authenticate: (token) => authenticateEdgeCredential(token),
    isActive: (identity) => isEdgeNodeActive(identity),
    storeFor: (identity) =>
      createDbLinkStore({
        database: db,
        context: identity.context,
        node: identity.scope,
        outboundDirection: "cloud_to_edge",
      }),
    onHeartbeat: (identity, frame) =>
      recordEdgeHeartbeat(
        identity.context,
        identity.scope.edgeNodeId,
        frame.version,
      ),
    onConnectionChange: (identity, connected) =>
      logger.info(
        { edgeNodeId: identity.scope.edgeNodeId, connected },
        "Edge link connection changed",
      ),
    onError: (error) => logger.warn(safeError(error), "Edge link error"),
  });
  const offRevoked = onEdgeNodeRevoked((edgeNodeId) =>
    linkServer.disconnect(edgeNodeId),
  );
  const stopRevocations = await listenEdgeNodeRevocations(pool, (edgeNodeId) =>
    linkServer.disconnect(edgeNodeId),
  );
  const stopWakeups = await listenEdgeLinkWakeups(pool, (signal) =>
    linkServer.notify(signal.edgeNodeId),
  );
  const sweep = setInterval(() => linkServer.notifyAll(), SWEEP_INTERVAL_MS);
  sweep.unref();
  const stopPrune = startAckedQueuePrune(
    hardening.EDGE_QUEUE_ACKED_RETENTION_DAYS,
  );
  return {
    notify: (edgeNodeId) => linkServer.notify(edgeNodeId),
    isConnected: (edgeNodeId) => linkServer.isConnected(edgeNodeId),
    async close() {
      clearInterval(sweep);
      stopPrune();
      offRevoked();
      await Promise.all([stopRevocations(), stopWakeups()]);
      await linkServer.close();
    },
  };
}
