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
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { parseEdgeHardeningEnv } from "@starter/shared/env";
import {
  outletIdSchema,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishScopedTenantContext } from "@starter/shared/core/server";
import type { ReceiptRunRefusalReport } from "@starter/shared/edge";
import { db, pool } from "../db/index.ts";
import { env } from "../config/env.ts";
import { logger } from "../lib/logger.ts";
import { isEdgeNode } from "./mode.ts";
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
  loadStaffPinCheckpoint,
  saveDeviceRegistryCheckpoint,
  saveStaffPinCheckpoint,
} from "../services/edge-device-sync-store.ts";
import {
  EDGE_LINK_WAKE_CHANNEL,
  EDGE_QUEUE_PRUNE_INTERVAL_MS,
  pruneAckedEdgeQueue,
} from "../services/edge-queue.service.ts";
import { startEdgeReceiptRunReporter } from "../services/edge-receipt-run-reporter.ts";
import { buildEdgeTxnDigestBounded } from "../services/edge-txn-ledger.service.ts";
import { createEdgeReconciliationSender } from "./reconciliation-sender.ts";
import {
  bootstrapEdgeNodeIfNeeded,
  startAfterBootMasters,
} from "./bootstrap.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "./deferred-event-applier.ts";
import { registerQrOrderEdgeApplier } from "./qr-order-applier.ts";
import { registerAttendanceLoggedEdgeApplier } from "./attendance-logged-applier.ts";
import { registerWifiQuotaEdgeApplier } from "./wifi-quota-applier.ts";
import { registerMasterDataEdgeApplier } from "./master-data-applier.ts";
import {
  startWifiQuotaQueueWorker,
  type WifiQuotaWorkerHandle,
} from "./wifi-quota-queue-worker.ts";
import { registerOrderEdgeApplier } from "./order-edge-applier.ts";
import { registerReceiptRunEdgeApplier } from "./receipt-run-applier.ts";
import {
  registerEdgeLinkDeadLetterApplier,
  registerEdgeLinkPlaceholderApplier,
} from "./link-dead-letter-applier.ts";
import { registerStockMovedEdgeApplier } from "./stock-moved-applier.ts";
import { registerAccessEdgeApplier } from "./access-applier.ts";
import { registerPanicAlertEdgeApplier } from "./panic-alert-applier.ts";
import { registerPrintAlertEdgeApplier } from "./print/alert-applier.ts";
import {
  createNodeAlarmEmitter,
  registerNodeAlarmEdgeApplier,
} from "./node-alarm.ts";
import { registerStaffPinAlertEdgeApplier } from "./staff-pin-alert-applier.ts";
import { resendMateriallessStaffPinSets } from "./staff-pin-resend.ts";
import {
  WIFI_RECONCILE_INTERVAL_MS,
  createWifiAgent,
  type WifiAgent,
} from "../services/edge-wifi-agent.service.ts";
import { purgeExpiredWifiGrants } from "../services/edge-wifi-retention.service.ts";
import {
  createDeviceRecordsFetcher,
  createStaffPinRecordsFetcher,
  EdgeCloudHttpError,
} from "./cloud-http.ts";
import { createStaffPinPull } from "./staff-pin-pull.ts";
import {
  activateEdgePepperRegistry,
  edgeStaffPinPepperVersionsHeld,
  installEdgeStaffPinPeppers,
} from "./staff-pin-pepper-registry.ts";
import {
  deriveEdgePepperSealKey,
  loadEdgePeppers,
  saveEdgePeppers,
} from "./staff-pin-pepper-store.ts";
import { createPeopleSnapshotPuller } from "./people-snapshot-pull.ts";
import { CATALOG_GATE_PERSIST_MS, startCatalogGate } from "./catalog-gate.ts";
import { openCatalogAlarmQueue } from "./catalog-alarm-queue.ts";
import { startPromoGate } from "./promo-gate-runtime.ts";
import {
  closeCatalogOverrides,
  loadActiveCatalogOverride,
  setCatalogOverrideClock,
  setCatalogOverrideListener,
} from "./catalog-override.ts";
import {
  seedCatalogFreshness,
  startEdgeMasterSyncLoop,
} from "./master-sync.ts";
import {
  CATALOG_CLOUD_OUTDATED_REASON,
  catalogStaleForHeartbeat,
  type CatalogFreshnessTracker,
} from "./catalog-freshness.ts";
import { withTenant } from "../db/tenant.ts";
import {
  notifyEdgeCatalogStale,
  notifyEdgeDeviceRegistryHardStale,
  notifyOutletSupervisors,
} from "../services/edge-sync-conflict-alert.ts";
import { parseEdgeRuntimeConfig } from "./config.ts";
import { createDbLinkStore } from "./db-link-store.ts";
import type { DeadLetterEntry } from "./link-peer.ts";
import {
  createEdgeLinkClient,
  type EdgeLinkClientState,
} from "./link-client.ts";
import type { LinkScope } from "./link-peer.ts";
import { LINK_CLOSE, type CatalogStale } from "./protocol.ts";
import { recordUploaderRejection } from "./selfie-health.ts";
import { startEdgeSelfieSweep } from "./selfie-retention.ts";
import type { TrustedClock } from "./trusted-clock.ts";
import {
  startEdgeAuditRetention,
  resolveEdgeAuditRetentionUrl,
  type EdgeAuditRetentionHandle,
} from "./audit-retention.ts";
import { createEdgeSelfieUploader } from "./selfie-uploader.ts";
import { createEdgeLinkServer, type EdgeLinkIdentity } from "./link-server.ts";
import { installWifiAgent, wifiEnforcement } from "./wifi/port.ts";
import { createDefaultWifiProvider } from "./wifi/registry.ts";
import {
  createDeviceRegistryPuller,
  pullWithCursorRecovery,
  type DeviceRegistryPuller,
  type DeviceRegistrySyncState,
} from "./device-registry-puller.ts";

/** Episodes already alerted by this process; the notification tables dedupe too. */
const catalogStaleAlerted = new Set<string>();

/**
 * legend-btx4d: an event above the link frame cap was moved to the dead-letter
 * store (cloud side, cloud_to_edge). Ops and owners hear it once: the id is
 * derived from the node and the event, so a replay never alerts twice, and
 * the queue behind the event keeps flowing. The event itself stays whole in
 * edge_link_dead_letters. A failure here is logged by the caller, never
 * thrown into the link.
 */
export async function reportEdgeLinkDeadLetter(
  identity: { context: ScopedTenantContext; scope: LinkScope },
  entry: DeadLetterEntry,
  now: Date = new Date(),
): Promise<void> {
  const hex = createHash("sha256")
    .update(
      `edge_link.dead_letter\0${identity.scope.edgeNodeId}\0${entry.event.id}`,
    )
    .digest("hex")
    .slice(0, 32);
  const id = uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  await withTenant(db, identity.context, (tx) =>
    notifyOutletSupervisors(
      tx,
      identity.context,
      {
        tenantId: identity.context.tenant.tenantId,
        outletId: outletIdSchema.parse(identity.scope.outletId),
        alsoOwners: true,
        id,
        eventName: "edge_link.dead_letter",
        aggregateType: "edge_link_dead_letter",
        aggregateId: uuidToUlid(identity.scope.edgeNodeId),
        payload: {
          edgeNodeId: identity.scope.edgeNodeId,
          eventId: entry.event.id,
          linkSeq: String(entry.linkSeq),
          bytes: String(entry.bytes),
          reason: entry.reason,
        },
        title: "Satu data sinkron terlalu besar",
        body: "Satu data ke server lokal melebihi batas kirim dan disimpan terpisah. Data lain tetap terkirim. Hubungi teknisi untuk memeriksanya.",
      },
      now,
    ),
  );
}

export async function reportEdgeAuditRetentionStatus(
  identity: { context: ScopedTenantContext; scope: LinkScope },
  disabled: boolean,
  now: Date = new Date(),
): Promise<void> {
  if (!disabled) return;
  // The day comes from the cloud clock. A deterministic source event id lets
  // notification_outbox dedupe heartbeat retries, concurrent requests and
  // process restarts, with at most one owner alarm per node per UTC day.
  const day = now.toISOString().slice(0, 10);
  const hex = createHash("sha256")
    .update(
      `edge_audit_retention.disabled\0${identity.scope.edgeNodeId}\0${day}`,
    )
    .digest("hex")
    .slice(0, 32);
  const id = uuidToUlid(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
  await withTenant(db, identity.context, (tx) =>
    notifyOutletSupervisors(
      tx,
      identity.context,
      {
        tenantId: identity.context.tenant.tenantId,
        outletId: outletIdSchema.parse(identity.scope.outletId),
        alsoOwners: true,
        id,
        eventName: "edge_audit_retention.disabled",
        aggregateType: "edge_audit_retention",
        aggregateId: uuidToUlid(identity.scope.edgeNodeId),
        payload: {
          edgeNodeId: identity.scope.edgeNodeId,
          reason: "maintenance_database_url_missing",
          day,
        },
        title: "Pembersihan audit edge belum aktif",
        body: "Server lokal belum memiliki koneksi pemeliharaan audit. Penjualan tetap berjalan; minta teknisi mengatur MAINTENANCE_DATABASE_URL untuk database lokal.",
      },
      now,
    ),
  );
}

/**
 * legend-10nex: the edge says critical catalog streams are stale for over 30
 * minutes while it reaches the cloud. Notify the outlet's supervisors and
 * owners once per edge, stream and episode (stable alert id).
 */
async function notifyCatalogStale(
  identity: AuthenticatedEdgeNode & EdgeLinkIdentity,
  stale: CatalogStale | undefined,
): Promise<void> {
  if (!stale || stale.length === 0) return;
  const outletId = outletIdSchema.parse(identity.scope.outletId);
  for (const entry of stale) {
    const key = `${identity.scope.edgeNodeId}:${entry.stream}:${entry.staleSince}`;
    if (catalogStaleAlerted.has(key)) continue;
    await withTenant(db, identity.context, (tx) =>
      notifyEdgeCatalogStale(tx, identity.context, {
        tenantId: identity.context.tenant.tenantId,
        outletId,
        edgeNodeId: identity.scope.edgeNodeId,
        stream: entry.stream,
        staleSince: entry.staleSince,
        reason: entry.reason,
      }),
    );
    if (catalogStaleAlerted.size >= 1000) catalogStaleAlerted.clear();
    catalogStaleAlerted.add(key);
  }
}

/** Tables the edge runtime needs; missing ones mean migrations did not run. */
export const EDGE_REQUIRED_TABLES = [
  "tenants",
  "outlets",
  "edge_nodes",
  "sync_cursors",
  "edge_outbound_queue",
  "edge_link_slots",
  "edge_inbound_events",
  "edge_sync_conflicts",
  "edge_pull_checkpoints",
  "wifi_device_grants",
  "wifi_quota_apply_queue",
  // legend-hwn02: the edge QR display reads the day keys; a missing table must
  // refuse boot (assertEdgeSchemaReady) instead of failing each request.
  "edge_attendance_qr_keys",
] as const;

/** Missed-wakeup fallback: how often an idle link re-checks its queue. */
const SWEEP_INTERVAL_MS = 5_000;
/** legend-zy43: how often the edge looks for a changed receipt run. */
const RECEIPT_RUN_REPORT_INTERVAL_MS = 60_000;

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
// How long boot waits for the first people snapshot before it carries on (the
// pull keeps running in the background; an offline node never blocks boot).
const BOOT_PEOPLE_SNAPSHOT_WAIT_MS = 10_000;

// legend-6xcy: how often the edge re-pulls the cloud masters.
const EDGE_MASTER_SYNC_INTERVAL_MS = 5 * 60_000;

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

/**
 * legend-2lgu: this edge's device-registry replica passed the hard limit, so
 * new device sessions are refused. False on the cloud and before boot.
 */
export function isDeviceRegistryHardStale(now: Date = new Date()): boolean {
  return getDeviceRegistryStatus(now) === "stale";
}

/**
 * The replica's age verdict for admitting device sessions. Cloud: "fresh".
 * Edge (EDGE_MODE or an installed edge state): "not_ready" without the node
 * identity or until the local checkpoint is loaded (never waits for the
 * cloud), then "stale" past the hard limit, else "fresh".
 */
export function getDeviceRegistryStatus(
  now: Date = new Date(),
): "not_ready" | "fresh" | "stale" {
  if (!state.edgeMode && !isEdgeNode()) return "fresh";
  // An edge process without its node identity cannot judge its replica.
  if (!state.identity) return "not_ready";
  if (!registryPuller?.isCheckpointLoaded()) return "not_ready";
  return registryPuller.isHardStale(now) ? "stale" : "fresh";
}

let hardStaleAlertedKey: string | null = null;

/**
 * legend-2lgu: tell the outlet's supervisors and owners the replica is hard
 * stale. Called on the puller's transition and on every refused new session;
 * once per outlet and UTC day here (and by the alert's stable id in the
 * database). Never throws: a failed alert must not change the 503.
 */
export async function reportDeviceRegistryHardStale(
  now: Date = new Date(),
): Promise<void> {
  const identity = state.identity;
  const puller = registryPuller;
  if (!state.edgeMode || !identity || !puller) return;
  const key = `${identity.scope.outletId}:${now.toISOString().slice(0, 10)}`;
  if (hardStaleAlertedKey === key) return;
  hardStaleAlertedKey = key;
  const registry = puller.getState();
  try {
    await withTenant(db, identity.context, (tx) =>
      notifyEdgeDeviceRegistryHardStale(
        tx,
        identity.context,
        {
          tenantId: identity.context.tenant.tenantId,
          outletId: outletIdSchema.parse(identity.scope.outletId),
          edgeNodeId: identity.scope.edgeNodeId,
          maxStaleSeconds: registry.maxStaleSeconds,
          lastPulledAt: registry.lastSuccessAt,
        },
        now,
      ),
    );
  } catch (error) {
    // Try again on the next refusal or transition.
    hardStaleAlertedKey = null;
    logger.warn(safeError(error), "Edge device registry alert failed");
  }
}

let catalogFreshness: CatalogFreshnessTracker | null = null;

/** Critical catalog stream freshness (edge only); null on the cloud or before boot. */
export function getCatalogFreshness(): CatalogFreshnessTracker | null {
  return catalogFreshness;
}

/** Test seam: install a runtime state without starting a link. */
export function setEdgeRuntimeStateForTests(next: EdgeRuntimeState): void {
  state = next;
}

/**
 * Test seam: install a device-registry puller with a loaded checkpoint (fresh
 * unless `hardStale`), or clear it with `null`. For tests that fake an edge
 * with setEdgeRuntimeStateForTests and still need device sessions admitted.
 */
export function setDeviceRegistryReadyForTests(
  ready: { readonly hardStale?: boolean } | null,
): void {
  registryPuller = ready
    ? ({
        start: () => undefined,
        runOnce: async () => true,
        stop: async () => undefined,
        getState: () => ({}) as DeviceRegistrySyncState,
        isHardStale: () => ready.hardStale ?? false,
        isCheckpointLoaded: () => true,
      } satisfies DeviceRegistryPuller)
    : null;
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

/**
 * Boot guard (legend-3kdd): modifiers.recipe_id has no FK on an edge database
 * (recipes sync later than modifiers). The FK appears when the migrator ran
 * without EDGE_MODE / legend.edge_mode=on. Never dropped automatically.
 */
export async function assertNoModifierRecipeFk(): Promise<void> {
  const result = await db.execute(
    sql`SELECT 1 FROM pg_constraint WHERE conname = 'modifiers_recipe_fk' AND conrelid = to_regclass('public.modifiers')`,
  );
  if (result.rows.length > 0)
    throw new EdgeBootError(
      "The FK modifiers_recipe_fk must not exist on an edge database: the migrations were probably run without EDGE_MODE / legend.edge_mode=on. Re-provision the edge database with the migrator in edge mode; the API does not drop the constraint automatically.",
    );
}

export type EdgeRuntimeHandle = { stop(): Promise<void> };

export type WifiAgentHandle = { stop(): Promise<void> };

/** Expired Wi-Fi grants are purged this often while the agent holds its lock. */
export const WIFI_RETENTION_INTERVAL_MS = 3_600_000;

/** Default lock retry backoff: 1 s, doubling, capped at 30 s. */
export function defaultWifiLockRetryDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
}

/**
 * Wi-Fi agent (bead legend-hsk, plan section 5). Primary node only: a standby
 * never talks to the venue controller. Starts nothing, and installs nothing
 * (the port stays fail-closed, 503), when there is no provider for this
 * environment. One owner per outlet: a session-level advisory lock on a
 * dedicated connection, like the EDC agent. While another process owns the
 * lock, or the connection could not be opened, the agent is not installed and
 * the acquisition is retried with backoff (an exiting process frees the lock
 * for us); if the connection dies later the lock is gone, the agent is
 * uninstalled and the acquisition starts over. Without that retry a node would
 * stop renewing grants for good and cut every guest within hours. stop() ends
 * the retries cleanly. The errors are logged by name/code only.
 */
export async function startWifiAgent(options: {
  context: ScopedTenantContext;
  scope: LinkScope;
  role: "primary" | "standby";
  /** Defaults to `NODE_ENV === "production"` (as the provider registry). */
  production?: boolean;
  /** Defaults to WIFI_RECONCILE_INTERVAL_MS. */
  intervalMs?: number;
  /** Defaults to WIFI_RETENTION_INTERVAL_MS. */
  retentionIntervalMs?: number;
  /** Test seam: use this agent instead of building one from the registry. */
  agent?: WifiAgent;
  /** Test seam: replaces purgeExpiredWifiGrants. */
  purge?: (context: ScopedTenantContext, now: Date) => Promise<number>;
  /** Test seam: delay before retry number `attempt` (0-based), in ms. */
  retryDelayMs?: (attempt: number) => number;
  /** Test seam: the dedicated lock connection. Defaults to `pool.connect()`. */
  connect?: () => Promise<PoolClient>;
}): Promise<WifiAgentHandle | null> {
  if (options.role !== "primary") return null;
  const { context, scope } = options;
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  let agent = options.agent;
  if (!agent) {
    const provider = createDefaultWifiProvider({
      simulator: !production,
      production,
    });
    if (provider === null) {
      logger.warn("No Wi-Fi controller adapter registered: Wi-Fi agent off");
      return null;
    }
    agent = createWifiAgent({
      provider,
      contextFor: (outletId) => {
        if (outletId !== scope.outletId)
          throw new EdgeBootError("The Wi-Fi agent serves its own outlet only");
        return establishScopedTenantContext(context.tenant, {
          kind: "outlets",
          outletIds: [outletIdSchema.parse(outletId)],
        });
      },
    });
  }
  const active = agent;
  const lockName = `wifi-agent:${scope.tenantId}:${scope.outletId}`;
  const connect = options.connect ?? (() => pool.connect());
  const retryDelayMs = options.retryDelayMs ?? defaultWifiLockRetryDelayMs;
  const uninstall = () => {
    if (wifiEnforcement() === active) installWifiAgent(null);
  };

  type Owned = {
    client: PoolClient;
    timer?: ReturnType<typeof setInterval>;
    purgeTimer?: ReturnType<typeof setInterval>;
    inflight: Promise<void>;
    purgeInflight: Promise<void>;
    released: boolean;
    ended: boolean;
    lost(): void;
  };
  let stopped = false;
  let owned: Owned | null = null;
  let acquiring: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let loggedBusy = false;

  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      acquiring = acquire();
    }, retryDelayMs(attempt++));
    retryTimer.unref();
  };

  const release = (session: Owned, destroy: boolean) => {
    if (session.released) return;
    session.released = true;
    session.client.removeListener("error", session.lost);
    session.client.removeListener("end", session.lost);
    session.client.release(destroy);
  };

  async function acquire(): Promise<void> {
    if (stopped) return;
    let client: PoolClient;
    try {
      client = await connect();
    } catch (error) {
      logger.warn(
        safeError(error),
        "Wi-Fi agent could not open its connection",
      );
      scheduleRetry();
      return;
    }
    const session: Owned = {
      client,
      inflight: Promise.resolve(),
      purgeInflight: Promise.resolve(),
      released: false,
      ended: false,
      lost: () => {
        if (session.ended) return;
        session.ended = true;
        if (session.timer) clearInterval(session.timer);
        if (session.purgeTimer) clearInterval(session.purgeTimer);
        if (owned === session) owned = null;
        uninstall();
        release(session, true);
        if (stopped) return;
        logger.error(
          "Wi-Fi agent lost its database connection: agent uninstalled, retrying",
        );
        attempt = 0;
        scheduleRetry();
      },
    };
    client.on("error", session.lost);
    client.on("end", session.lost);
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [lockName],
      );
      if (result.rows[0]?.locked !== true) {
        if (!loggedBusy)
          logger.warn("Another process owns the Wi-Fi agent of this outlet");
        loggedBusy = true;
        session.ended = true;
        release(session, false);
        scheduleRetry();
        return;
      }
    } catch (error) {
      logger.warn(safeError(error), "Wi-Fi agent could not take its lock");
      session.ended = true;
      release(session, true);
      scheduleRetry();
      return;
    }
    if (session.ended) return;
    if (stopped) {
      // stop() ran while the lock was being taken: give it back at once.
      session.ended = true;
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [lockName],
        );
        release(session, false);
      } catch {
        release(session, true);
      }
      return;
    }
    loggedBusy = false;
    attempt = 0;
    owned = session;
    installWifiAgent(active);
    let busy = false;
    session.timer = setInterval(() => {
      if (busy || stopped || session.ended) return;
      busy = true;
      session.inflight = active
        .reconcile(context, outletIdSchema.parse(scope.outletId))
        .then(
          () => undefined,
          (error: unknown) =>
            logger.warn(safeError(error), "Wi-Fi reconcile failed"),
        )
        .finally(() => {
          busy = false;
        });
    }, options.intervalMs ?? WIFI_RECONCILE_INTERVAL_MS);
    session.timer.unref();
    const purge =
      options.purge ??
      ((purgeContext: ScopedTenantContext, at: Date) =>
        purgeExpiredWifiGrants(db, purgeContext, at));
    let purging = false;
    const runPurge = () => {
      if (purging || stopped || session.ended) return;
      purging = true;
      session.purgeInflight = purge(context, new Date())
        .then(
          (count) => {
            if (count > 0)
              logger.info({ count }, "Expired Wi-Fi grants purged");
          },
          (error: unknown) =>
            logger.warn(safeError(error), "Wi-Fi grant purge failed"),
        )
        .finally(() => {
          purging = false;
        });
    };
    // One purge right after the lock is taken (a node that restarts often
    // would otherwise never reach the first hourly tick), then on the interval.
    runPurge();
    session.purgeTimer = setInterval(
      runPurge,
      options.retentionIntervalMs ?? WIFI_RETENTION_INTERVAL_MS,
    );
    session.purgeTimer.unref();
  }

  acquiring = acquire();
  await acquiring;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      await acquiring;
      const session = owned as Owned | null;
      owned = null;
      if (!session) return;
      session.ended = true;
      if (session.timer) clearInterval(session.timer);
      if (session.purgeTimer) clearInterval(session.purgeTimer);
      uninstall();
      await session.inflight;
      await session.purgeInflight;
      let broken = false;
      try {
        await session.client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [lockName],
        );
      } catch {
        // Destroying the connection drops the session lock all the same.
        broken = true;
      }
      release(session, broken);
    },
  };
}

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
  // legend-ideif: the root pepper must never be on an edge box (a stolen box
  // would derive every tenant's pepper). config/env.ts refuses it too; this
  // guard covers a `source` that is not process.env. Names only, no value.
  if (source.STAFF_PIN_PEPPER !== undefined && source.STAFF_PIN_PEPPER !== "")
    throw new EdgeBootError(
      "STAFF_PIN_PEPPER (the root pepper) must not be set on an edge node: remove it from the edge environment; the cloud delivers the outlet pepper over the sync.",
    );
  // Validate the configured URL before any database work, component or timer
  // starts. A missing URL skips only the purge; the heartbeat alarms owners.
  // Connection credentials/role are probed later with runtime cleanup on error.
  const auditRetentionDisabled = resolveEdgeAuditRetentionUrl(source) === null;
  await assertEdgeSchemaReady();
  await assertNoModifierRecipeFk();
  // legend-s4r6: cloud -> edge appliers, before the link can deliver.
  registerQrOrderEdgeApplier();
  registerWifiQuotaEdgeApplier();
  registerMasterDataEdgeApplier();
  // legend-3k41y: no-op placeholder of a catalog row the cloud withheld.
  registerEdgeLinkPlaceholderApplier();
  // Section D (legend-khu5): first boot provisions the node from its bundle.
  const bootstrapResult = await bootstrapEdgeNodeIfNeeded(config);
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
  hardStaleAlertedKey = null;
  // legend-ideif: from here on pin hashing uses only the outlet peppers the
  // cloud sent (none yet = fail closed). Restore the sealed ones from the
  // database so a restart verifies pins offline; rows sealed under a rotated
  // credential do not open and are fetched again on the next sync.
  const pepperSealKey = deriveEdgePepperSealKey(
    config.credential.split(".")[4] ?? "",
  );
  activateEdgePepperRegistry(local.scope.tenantId, local.scope.outletId);
  installEdgeStaffPinPeppers(
    local.scope.tenantId,
    local.scope.outletId,
    [
      ...(
        await loadEdgePeppers(
          local.context,
          local.scope.edgeNodeId,
          pepperSealKey,
        )
      ).entries(),
    ].map(([version, pepper]) => ({ version, pepper })),
  );
  const reportCatalogAlarmError = (error: unknown): void => {
    try {
      logger.warn(safeError(error), "Edge catalog alarm persistence failed");
    } catch {
      // Reporting a disk failure must not turn it into a sales outage.
    }
  };
  // 533 A2: the cloud's HTTP Date (link upgrade or catalog pull) proves the
  // device clock after an offline restart. The link can come up before the
  // catalog gate exists, so keep the last server time with a monotonic stamp and
  // apply it later.
  let catalogClock: {
    now(): Date;
    proveWithServerTime(serverTime: Date): void;
    elapsedTimeUnproven(): boolean;
  } | null = null;
  // Clock for the alarm queue only. It is set as soon as the gate builds the
  // trusted clock (before the boot alarm), while `catalogClock` stays null until
  // the freshness tracker exists, so applyServerTime keeps its old timing.
  let queueClock: Pick<TrustedClock, "now" | "purgeSafeNow"> | null = null;
  // legend-4sesc: retention sweeps start before the gate builds the clock.
  // Until it exists there is no safe purge time, so a sweep waits for the
  // next interval instead of running on the box clock.
  const retentionClock: Pick<TrustedClock, "purgeSafeNow"> = {
    purgeSafeNow: () => (queueClock ? queueClock.purgeSafeNow() : null),
  };
  // Wall time of this boot, taken before the gate: alarms of this boot have a
  // staleSince at or after it, alarms of earlier boots are older.
  const bootAt = new Date();
  const catalogAlarmQueue = await openCatalogAlarmQueue({
    // 533 A5: its own state directory, not the selfie store.
    directory: join(env.EDGE_STATE_DIR, "catalog-alarms"),
    // Alarms queued by the previous build are imported once from here.
    legacyDirectory: join(env.EDGE_SELFIE_DIR, "catalog-alarms"),
    edgeNodeId: local.scope.edgeNodeId,
    // 533b: the 7 day expiry runs on the trusted clock once it exists, so a
    // wall clock set forward cannot age an alarm out.
    now: () => (queueClock ? queueClock.now() : new Date()),
    onError: reportCatalogAlarmError,
  });
  let lastServerTime: { serverTime: Date; receivedMono: number } | null = null;
  const applyServerTime = (): void => {
    if (!catalogClock || !lastServerTime) return;
    const wasUnproven = catalogClock.elapsedTimeUnproven();
    // Age the stamp by the monotonic time since it was received.
    catalogClock.proveWithServerTime(
      new Date(
        lastServerTime.serverTime.getTime() +
          (performance.now() - lastServerTime.receivedMono),
      ),
    );
    if (!wasUnproven || catalogClock.elapsedTimeUnproven()) return;
    // Proven: the unproven-time state and this boot's queued owner alarms are
    // moot. Alarms of earlier boots stay: the owner may not have received them.
    catalogFreshness?.clockProven();
    void catalogAlarmQueue
      .clearReason("CLOCK_ELAPSED_UNPROVEN", bootAt)
      .catch(reportCatalogAlarmError);
  };
  const recordServerTime = (serverTime: Date): void => {
    lastServerTime = { serverTime, receivedMono: performance.now() };
    applyServerTime();
  };
  // The link connects before the master loop is ready. Retain an early
  // deferred receipt until the loop can schedule its recovery pull.
  let requestMasterSync: (() => void) | null = null;
  let earlyDeferred = false;
  const client = createEdgeLinkClient({
    url: config.cloudUrl,
    credential: config.credential,
    instanceId: local.instanceId,
    scope: local.scope,
    version: config.version,
    store: createDbLinkStore({
      database: db,
      context: local.context,
      node: local.scope,
      outboundDirection: "edge_to_cloud",
      onDeferred: () => {
        if (requestMasterSync) requestMasterSync();
        else earlyDeferred = true;
      },
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
    // legend-btx4d: the edge has no staff to notify; the dead letter is kept
    // whole in edge_link_dead_letters and this one error line (a fixed code,
    // ids and sizes only, no payload) is the ops alarm.
    onDeadLetter: (entry) =>
      logger.error(
        {
          code: "EDGE_LINK_DEAD_LETTER",
          eventId: entry.event.id,
          linkSeq: entry.linkSeq,
          bytes: entry.bytes,
          reason: entry.reason,
        },
        "Edge event above the link frame limit moved to the dead-letter store",
      ),
    onServerTime: recordServerTime,
    // legend-10nex: stale prices/product status reach the owner through the
    // cloud, which only hears the edge while this link is up.
    catalogStale: () => {
      const snapshot = catalogFreshness?.snapshot();
      // Older clouds reject this heartbeat field: preserve the queue until
      // a compatible cloud is available, just like live freshness alarms.
      if (
        !snapshot ||
        Object.values(snapshot.streams).some(
          (stream) => stream.failureReason === CATALOG_CLOUD_OUTDATED_REASON,
        )
      )
        return catalogAlarmQueue.heartbeat(null);
      return catalogAlarmQueue.heartbeat(catalogStaleForHeartbeat(snapshot));
    },
    auditRetentionDisabled: () => auditRetentionDisabled,
    // A protocol refusal (1008) carries a fixed reason from the link code, no
    // payload; it tells the operator why the link keeps dropping (legend-a9iby:
    // a restored or cloned database). See docs/deployment.md, item 5.
    onClose: (code, reason) => {
      if (code === LINK_CLOSE.protocol)
        logger.warn(
          { code, reason: reason.slice(0, 123) },
          "Edge link refused by protocol",
        );
    },
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
    edgeInstanceId: local.instanceId,
  });
  // legend-hfq3z: clash refusals of the previous pull, reported on the next.
  let receiptRunRefusals: ReceiptRunRefusalReport = new Map();
  // legend-0cjzz: the hard-stale alarm travels on the event stream; boot time
  // is the age base while the replica never pulled (as in the puller).
  const registryBootAt = new Date();
  const nodeAlarm = createNodeAlarmEmitter({
    database: db,
    context: local.context,
    tenantId: local.context.tenant.tenantId,
    outletId: outletIdSchema.parse(local.scope.outletId),
    edgeNodeId: local.scope.edgeNodeId,
    getDeviceRegistryState: () => {
      const registry = puller.getState();
      return {
        hardStale: registry.hardStale,
        lastPulledAt: registry.lastSuccessAt
          ? new Date(registry.lastSuccessAt)
          : null,
        startedAt: registryBootAt,
      };
    },
    maxStaleSeconds: Math.floor(config.deviceRegistryMaxStaleMs / 1000),
  });
  // Not before the local checkpoint is loaded: until then the puller cannot
  // judge its age and would read as fresh, clearing an alarm that is still on.
  const reconcileNodeAlarm = () => {
    if (!puller.isCheckpointLoaded()) return;
    void nodeAlarm
      .reconcile()
      .catch((error) =>
        logger.warn(safeError(error), "Edge node alarm enqueue failed"),
      );
  };
  const puller = createDeviceRegistryPuller({
    pull: (since, signal) =>
      pullWithCursorRecovery(
        async (from) => {
          let first = true;
          const result = await pullDeviceRegistry({
            context: local.context,
            // S-K1 (legend-3yqy): a standby never applies receipt sequences.
            role: config.role,
            // legend-zsdd: the sequences this database may number.
            binding: {
              edgeNodeId: local.scope.edgeNodeId,
              edgeInstanceId: local.instanceId,
            },
            since: from,
            refusals: receiptRunRefusals,
            fetchPage: async (cursor, receiptRuns, refusals) => {
              const isFirst = first;
              first = false;
              try {
                return await fetchDeviceRecords(
                  cursor,
                  signal,
                  receiptRuns,
                  refusals,
                );
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
          receiptRunRefusals = result.receiptRunRefusals;
          return result;
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
    hardStaleAfterMs: config.deviceRegistryMaxStaleMs,
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
    onHardStaleChange: (hardStale) => {
      if (hardStale) {
        logger.error(
          "Edge device registry replica is past its hard limit; new device sessions are refused",
        );
        void reportDeviceRegistryHardStale();
      } else logger.info("Edge device registry replica is within its limit");
      reconcileNodeAlarm();
    },
    onError: (error) =>
      logger.warn(safeError(error), "Edge device registry pull failed"),
  });
  registryPuller = puller;
  // Not awaited: boot never waits for, or fails on, the cloud.
  puller.start();
  // People snapshot (users, roles, employees, shifts; design
  // hris-edge-replication.md 3.1). Started BEFORE the staff PIN pull: a PIN
  // record needs its user row. A standby pulls too. Boot waits a bounded time
  // for the first pull so the PINs find their users; offline, it moves on.
  const peoplePuller = createPeopleSnapshotPuller({
    config: { cloudUrl: config.cloudUrl, credential: config.credential },
    intervalMs: config.peopleSyncIntervalMs,
    staleAfterMs: Math.max(
      config.deviceSyncStaleAfterMs,
      2 * config.peopleSyncIntervalMs,
    ),
    maxBackoffMs: Math.max(
      config.peopleSyncIntervalMs,
      MIN_MAX_PULL_BACKOFF_MS,
    ),
    onStaleChange: (stale) => {
      if (stale)
        logger.error(
          "Edge people snapshot is stale; staff changes may be missing",
        );
      else logger.info("Edge people snapshot is fresh again");
    },
    // Code only: the snapshot holds personal data.
    onError: (error) =>
      logger.warn(safeError(error), "Edge people snapshot pull failed"),
  });
  peoplePuller.start();
  let bootWait: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    peoplePuller.runOnce(),
    new Promise<void>((resolve) => {
      bootWait = setTimeout(resolve, BOOT_PEOPLE_SNAPSHOT_WAIT_MS);
      bootWait.unref();
    }),
  ]);
  clearTimeout(bootWait);
  // legend-yvhw8: staff PINs down-sync. Same schedule, backoff and staleness
  // as the registry, its own checkpoint. A standby pulls too: it needs the
  // PINs to take over for a failed primary. Stale PINs are not fatal (the
  // edge keeps verifying the last ones), so staleness is logged, not acted on.
  const pinPuller = createDeviceRegistryPuller({
    pull: createStaffPinPull({
      context: local.context,
      fetchPage: createStaffPinRecordsFetcher({
        cloudUrl: config.cloudUrl,
        credential: config.credential,
        pepperHave: edgeStaffPinPepperVersionsHeld,
      }),
      onPeppers: async (peppers) => {
        const decoded = peppers.map(({ version, pepper }) => ({
          version,
          pepper: Buffer.from(pepper, "base64"),
        }));
        // Sealed in the database first, then live: a crash in between only
        // costs one more delivery.
        await saveEdgePeppers(
          local.context,
          local.scope.edgeNodeId,
          pepperSealKey,
          decoded,
        );
        installEdgeStaffPinPeppers(
          local.scope.tenantId,
          local.scope.outletId,
          decoded,
        );
        logger.info(
          { versions: decoded.map((entry) => entry.version) },
          "Edge staff pin peppers updated",
        );
      },
      onRestart: () =>
        logger.warn("Edge staff pin cursor refused; pulling from the start"),
    }),
    load: () => loadStaffPinCheckpoint(local.context, local.scope.edgeNodeId),
    save: (input) =>
      saveStaffPinCheckpoint(local.context, local.scope.edgeNodeId, input),
    intervalMs: config.deviceSyncIntervalMs,
    staleAfterMs: config.deviceSyncStaleAfterMs,
    maxBackoffMs: Math.max(
      config.deviceSyncIntervalMs,
      MIN_MAX_PULL_BACKOFF_MS,
    ),
    onStaleChange: (stale) => {
      if (stale)
        logger.error(
          "Edge staff pin replica is stale; PIN resets may be missing",
        );
      else logger.info("Edge staff pin replica is fresh again");
    },
    // Class only: a record (hash, salt) must never reach a log line.
    onError: (error) =>
      logger.warn(safeError(error), "Edge staff pin pull failed"),
  });
  pinPuller.start();
  // legend-hubzo: sealed selfies go up to the cloud, one file at a time. Both
  // roles run it: a node with no rows is idle, and the cloud answers 200 for a
  // file it already holds. Failures are logged by class only; a selfie never
  // reaches a log line.
  const selfieUploader = createEdgeSelfieUploader({
    context: local.context,
    cloudUrl: config.cloudUrl,
    credential: config.credential,
    intervalMs: env.EDGE_SELFIE_UPLOAD_INTERVAL_MS,
    maxBackoffMs: Math.max(
      env.EDGE_SELFIE_UPLOAD_INTERVAL_MS,
      MIN_MAX_PULL_BACKOFF_MS,
    ),
    onRejected: () => recordUploaderRejection(),
    onError: (error) =>
      logger.warn(safeError(error), "Edge selfie upload failed"),
  });
  selfieUploader.start();
  const selfieSweep = startEdgeSelfieSweep({
    context: local.context,
    dir: env.EDGE_SELFIE_DIR,
    maxAgeDays: env.EDGE_SELFIE_MAX_AGE_DAYS,
    clock: retentionClock,
  });
  // legend-6xcy (legend-9ppw): re-pull stock locations, UOMs and the chart of
  // accounts. No master tick at start: a fresh bootstrap (or missing masters)
  // syncs at boot, a restarted node first refreshes one interval later.
  // legend-24318: each tick then pulls the catalog (menu, prices, recipes,
  // stations, inventory items); one catalog-only run starts at boot without
  // blocking it. A failure is logged by class only and the loop keeps its
  // schedule.
  // legend-10nex: prices and product status. While a critical stream failed
  // since its last success the cashier sees the warning on /api/edge/status;
  // a reachable-cloud failure that lasts alarms the owner through the cloud
  // (the link heartbeat carries the stale streams as `catalogStale`, a local
  // notification would never reach the cloud). Founder Q57: no successful
  // sync of a critical stream for over 24 hours holds sales until an owner
  // allows them (edge/sales-gate.ts). Ages use a trusted clock that a wall
  // clock set backwards cannot shrink, persisted across restarts.
  const catalogGate = await startCatalogGate({
    context: local.context,
    scope: {
      tenantId: local.scope.tenantId,
      outletId: local.scope.outletId,
      edgeNodeId: local.scope.edgeNodeId,
    },
    overrides: {
      load: (now) =>
        loadActiveCatalogOverride(
          { context: local.context, outletId: local.scope.outletId },
          { edgeNodeId: local.scope.edgeNodeId, now },
        ),
      close: async (now, reason, onlyId) => {
        await closeCatalogOverrides(
          { context: local.context, outletId: local.scope.outletId },
          { edgeNodeId: local.scope.edgeNodeId, now, reason, onlyId },
        );
      },
    },
    onOwnerAlarm: async (alarm) => {
      logger.warn(
        { streams: alarm.streams.map((entry) => entry.stream) },
        "Edge catalog freshness needs owner attention",
      );
      const unproven = alarm.streams.filter(
        (entry) => entry.reason === "CLOCK_ELAPSED_UNPROVEN",
      );
      if (unproven.length)
        await catalogAlarmQueue
          .enqueue(
            unproven.map((entry) => ({
              stream: entry.stream,
              staleSince: entry.staleSince.toISOString(),
              reason: entry.reason,
            })),
          )
          .catch((error: unknown) => {
            reportCatalogAlarmError(error);
            throw error;
          });
    },
    // A restart must not hide a stale catalog: start from the checkpoint's
    // last success (none on a new edge). A read failure leaves the tracker
    // unseeded; unseeded streams age from the persisted tracking start.
    seed: (tracker) =>
      seedCatalogFreshness(tracker, local.context, local.scope.edgeNodeId),
    // Before seed and the boot alarm: the alarm queue stamps enqueuedAt with
    // the trusted clock, never a raw wall clock that may be dead (RTC 1970).
    onClock: (clock) => {
      queueClock = clock;
    },
    onError: (error) =>
      logger.warn(safeError(error), "Edge catalog sales gate step failed"),
    onClockRegressed: ({ wallNow, highWater }) =>
      logger.warn(
        {
          wallNow: wallNow.toISOString(),
          highWater: highWater.toISOString(),
        },
        "Edge wall clock is behind the saved high water; sales are held (CLOCK_REGRESSED) until it catches up or an owner allows them",
      ),
  });
  // Freshness evaluates its boot alarm synchronously; await its disk write
  // before startup completes so an immediate restart cannot lose the alarm.
  await catalogAlarmQueue.flush().catch(reportCatalogAlarmError);
  // A failed write stays dirty even if no second alarm is emitted; retry in
  // the background without holding Q62 sales or waiting for a reconnect.
  const catalogAlarmRetry = setInterval(() => {
    void catalogAlarmQueue.flush().catch(reportCatalogAlarmError);
    // legend-0cjzz: retries a failed alarm enqueue and covers a clear missed
    // by a crash.
    reconcileNodeAlarm();
  }, CATALOG_GATE_PERSIST_MS);
  catalogAlarmRetry.unref();
  const freshness = catalogGate.freshness;
  catalogFreshness = freshness;
  catalogClock = catalogGate.clock;
  // The link may have connected before the gate existed.
  applyServerTime();
  // The owner grants an override on the edge API: the provider must see it now.
  setCatalogOverrideClock(() => catalogGate.clock.now());
  setCatalogOverrideListener((change) =>
    catalogGate.applyOverrideChange(
      change.kind === "granted" ? change.override : null,
    ),
  );
  // A grant committed between the gate's boot load and the listener above
  // would be missed: load the active override once more.
  await catalogGate.refreshOverride();
  // Promos and vouchers switch off (sales go on at the normal price) when
  // their data is over 24 hours old; the owner override does not open them.
  const promoGate = startPromoGate({
    context: local.context,
    edgeNodeId: local.scope.edgeNodeId,
    clock: catalogGate.clock,
    onError: (error) =>
      logger.warn(safeError(error), "Edge promo freshness step failed"),
  });
  // legend-2uqcd: a node bootstrapped before the all-tenant brands has no
  // brand rows for other brands' recipes, and the catalog waits on recipes.
  // Sync the masters once first (best effort, not awaited), then start the
  // loop and its first catalog pull. A node bootstrapped in this very boot
  // has just applied the current snapshot.
  const masterSync = startAfterBootMasters({
    config,
    syncMasters: bootstrapResult === "present",
    start: () =>
      startEdgeMasterSyncLoop({
        config,
        intervalMs: EDGE_MASTER_SYNC_INTERVAL_MS,
        catalog: {
          context: local.context,
          edgeNodeId: local.scope.edgeNodeId,
          freshness,
          // 533b: the Date header of each catalog page is more proof of the clock.
          onServerTime: recordServerTime,
        },
        catalogOnStart: true,
        onError: (error) =>
          logger.warn(safeError(error), "Edge master sync failed"),
      }),
  });
  requestMasterSync = () => masterSync.requestRun();
  if (earlyDeferred) {
    earlyDeferred = false;
    requestMasterSync();
  }
  // legend-zclb: one-shot, not awaited. A failure is logged by class only
  // (the error can quote hash material) and never stops the runtime.
  resendMateriallessStaffPinSets(local.context.tenant, local.scope.outletId)
    .then(({ resent }) => {
      if (resent > 0)
        logger.info({ resent }, "Edge staff pin sets re-sent with material");
    })
    .catch((error) =>
      logger.warn(safeError(error), "Edge staff pin re-send failed"),
    );
  let wifi: WifiAgentHandle | null = null;
  try {
    wifi = await startWifiAgent({
      context: local.context,
      scope: local.scope,
      role: config.role,
    });
  } catch (error) {
    // A Wi-Fi problem must not take down POS or the link: the port stays
    // fail-closed (503) and the cause is logged by name/code only.
    logger.error(safeError(error), "Wi-Fi agent failed to start");
  }
  // legend-oeqme: pushes the queued cloud quota changes to the controller,
  // outside the link receive transaction. Every role prunes the queue; only
  // the primary drains it, like the agent: a standby never talks to the
  // controller.
  const wifiQuotaWorker: WifiQuotaWorkerHandle = startWifiQuotaQueueWorker({
    context: local.context,
    edgeNodeId: local.scope.edgeNodeId,
    drain: config.role === "primary",
  });
  let auditRetention: EdgeAuditRetentionHandle | null = null;
  // legend-zy43: reports the receipt runs this database numbered. Only the
  // primary numbers receipts (a standby holds no bound run).
  const stopReceiptRunReporter =
    config.role === "primary"
      ? startEdgeReceiptRunReporter({
          context: local.context,
          outletId: local.scope.outletId,
          edgeNodeId: local.scope.edgeNodeId,
          edgeInstanceId: local.instanceId,
          intervalMs: RECEIPT_RUN_REPORT_INTERVAL_MS,
          onReported: () => client.notify(),
          onError: (error) =>
            logger.warn(safeError(error), "Edge receipt run report failed"),
        })
      : () => undefined;
  // Only the primary reports: a standby has no edge_to_cloud drain, so its
  // digest would always look behind/stale (legend-9z10p). The snapshot
  // transaction commits before POSTing, and a failed report retries without
  // holding the cursor.
  const reconciliationSender = createEdgeReconciliationSender({
    role: config.role,
    cloudUrl: config.cloudUrl,
    credential: config.credential,
    edgeNodeId: local.scope.edgeNodeId,
    buildDigest: (signal) =>
      buildEdgeTxnDigestBounded(db, local.context, local.scope, { signal }),
    onError: (error) =>
      logger.warn(
        safeError(error),
        "Edge transaction reconciliation report failed",
      ),
  });
  reconciliationSender.start();
  const handle: EdgeRuntimeHandle = {
    async stop() {
      stopReceiptRunReporter();
      clearInterval(sweep);
      clearInterval(catalogAlarmRetry);
      await wifiQuotaWorker.stop();
      await wifi?.stop();
      stopPrune();
      // Torn down together: a pull stuck in a slow local write must not hold
      // the link and the wakeup listener open during shutdown.
      await Promise.all([
        reconciliationSender.stop(),
        puller.stop(),
        peoplePuller.stop(),
        pinPuller.stop(),
        masterSync.stop(),
        selfieUploader.stop(),
        selfieSweep.stop(),
        auditRetention?.stop(),
        stopWakeups(),
        client.stop(),
      ]);
      setCatalogOverrideListener(null);
      setCatalogOverrideClock(null);
      promoGate.stop();
      await catalogGate.stop();
      await catalogAlarmQueue.flush().catch(reportCatalogAlarmError);
      if (registryPuller === puller) registryPuller = null;
      if (catalogFreshness === freshness) catalogFreshness = null;
      state = { ...state, link: disconnected };
    },
  };
  // legend-0cqql: activate audit retention only after runtime initialization.
  // A refused maintenance login closes every already-started component.
  try {
    auditRetention = await startEdgeAuditRetention({
      source,
      clock: retentionClock,
    });
  } catch (error) {
    await handle
      .stop()
      .catch((stopError: unknown) =>
        logger.error(safeError(stopError), "Edge runtime cleanup failed"),
      );
    throw error;
  }
  return handle;
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
  // legend-wh71: offline attendance.logged (WS-10) recorded idempotently.
  registerAttendanceLoggedEdgeApplier();
  // legend-9fhs: POS (WS-04) events parked in edge_deferred_events (no stall).
  registerPosDeferredEdgeApplier();
  // legend-pd9t: order.paid cost snapshot from the order's edge stock rows.
  registerOrderEdgeApplier();
  // legend-zy43: receipt_run.reported merged with mergeDeviceReceiptRun. Its
  // aggregate is excluded from posDeferredAggregates (one handler per event).
  registerReceiptRunEdgeApplier();
  // legend-btx4d: edge_link.dead_lettered notice (an oversized event the edge
  // parked) recorded as a conflict; its aggregate sequence counts as used.
  registerEdgeLinkDeadLetterApplier();
  // legend-kyie: pos_override.* / staff_pin.* applied (and parked ones drained).
  registerAccessEdgeApplier();
  // legend-bod.5: emergency button alerts (panic_alert.*) mirrored idempotently.
  registerPanicAlertEdgeApplier();
  registerPrintAlertEdgeApplier();
  registerNodeAlarmEdgeApplier();
  // legend-62jtd: staff_pin.device_throttled raised on an edge reaches the
  // outlet's supervisors in the cloud.
  registerStaffPinAlertEdgeApplier();
  // Last: anything still unregistered is parked as unclassified, not a stall.
  registerEdgeDeferredFallback();
  const version = env.EDGE_NODE_VERSION;
  const hardening = parseEdgeHardeningEnv(process.env);
  // The server adds the `x-edge-instance` header value (legend-o839h).
  const linkServer = createEdgeLinkServer<
    AuthenticatedEdgeNode & EdgeLinkIdentity
  >(server, {
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
        edgeInstanceId: identity.edgeInstanceId,
        outboundDirection: "cloud_to_edge",
      }),
    onHeartbeat: async (identity, frame) => {
      await recordEdgeHeartbeat(
        identity.context,
        identity.scope.edgeNodeId,
        frame.version,
      );
      // legend-10nex: a failure here never fails the heartbeat; the edge
      // repeats `catalogStale` with every heartbeat while it lasts.
      await notifyCatalogStale(identity, frame.catalogStale).catch((error) =>
        logger.warn(safeError(error), "Edge catalog stale alert failed"),
      );
      if (frame.auditRetentionDisabled === true)
        await reportEdgeAuditRetentionStatus(identity, true).catch((error) =>
          logger.warn(
            safeError(error),
            "Edge audit retention owner alert failed",
          ),
        );
    },
    onDeadLetter: (identity, entry) => {
      logger.error(
        {
          code: "EDGE_LINK_DEAD_LETTER",
          edgeNodeId: identity.scope.edgeNodeId,
          eventId: entry.event.id,
          linkSeq: entry.linkSeq,
          bytes: entry.bytes,
          reason: entry.reason,
        },
        "Cloud event above the link frame limit moved to the dead-letter store",
      );
      void reportEdgeLinkDeadLetter(identity, entry).catch((error) =>
        logger.warn(safeError(error), "Edge link dead-letter alert failed"),
      );
    },
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
