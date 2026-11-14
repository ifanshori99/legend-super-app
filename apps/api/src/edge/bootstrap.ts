// Edge bootstrap, edge side (bead legend-khu5; PRD v1.7 §3 F5 "Server
// Lokal", TEN-02). A freshly installed edge node has an empty local
// database, so ensureLocalEdgeNode would fail on the tenant/outlet foreign
// keys. Before that, `bootstrapEdgeNodeIfNeeded` fetches the signed bundle
// from GET /api/edge-sync/bootstrap and inserts the rows it names.
//
// - Tenant AND outlet already present locally -> no network call, unless the
//   outlet has no local stock_locations or the tenant has no uoms (a node
//   bootstrapped before the master sync, bead legend-9ppw): then one
//   best-effort `syncEdgeMasters` (5 s timeout). A failure is logged (code
//   only; CLOUD_* as warn, anything else as error) and the node still boots
//   ("present"). That sync goes through the same data import guard as the
//   fresh path (legend-8izz): a refusal is logged as DATA_IMPORT_BLOCKED,
//   with no cloud call and nothing written.
// - The signature is checked over the bundle exactly as received (constant
//   time, key = the credential's own digest), then its shape, then that its
//   tenant/outlet are the credential's claims. Anything else -> EdgeBootError
//   and the node stays down, as it did before this bead.
//   The signature is an integrity check against corruption and misrouting,
//   not proof of origin: see "What the signature does NOT prove" in
//   packages/shared/src/edge/bootstrap.ts. Authenticity comes from TLS
//   (config.ts requires wss:// outside development; cloud-http.ts fetches
//   over https://). Not a pattern for cloud->edge commands (those need an
//   Ed25519 cloud key pinned on the edge).
// - Fresh node: the bundle AND the master snapshot (master-sync.ts: uoms,
//   stock locations, chart of accounts, account mappings) are fetched and
//   verified BEFORE anything is written; the snapshot must name the bundle's
//   legal entity. Then ONE transaction, FK order tenant -> legal entity ->
//   brand -> outlet (`onConflictDoNothing`: an existing row is never
//   overwritten), then the masters. Masters are REQUIRED: without the cloud's
//   ids the cloud rejects this node's `stock.moved` events. Any failure rolls
//   everything back, so the next boot is a fresh bootstrap again. A masters
//   failure is an EdgeBootError "MASTERS <code>".
//
// Never log the credential: errors carry a code only.
import { and, eq } from "drizzle-orm";
import {
  EDGE_BOOTSTRAP_PATH,
  edgeBootstrapBundleSchema,
  type EdgeBootstrapBundle,
} from "@starter/shared/edge";
import type {
  FeatureFlags,
  Geofence,
  OpeningHours,
  TenantLimits,
} from "@starter/shared/platform";
import { db } from "../db/index.ts";
import { stockLocations, uoms } from "../db/schema/inventory.ts";
import {
  brands,
  legalEntities,
  outlets,
  tenants,
} from "../db/schema/platform-org.ts";
import { guardDataImport } from "../config/data-import.ts";
import { withTenant } from "../db/tenant.ts";
import { logger } from "../lib/logger.ts";
import { edgeBootstrapSignatureMatches } from "../services/edge-bootstrap.service.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import { cloudGetJson, EdgeCloudHttpError } from "./cloud-http.ts";
import type { EdgeRuntimeConfig } from "./config.ts";
import { parseEdgeCredential } from "./credential.ts";
import {
  applyEdgeMasterSnapshotInTransaction,
  EdgeMasterSyncError,
  fetchVerifiedMasterSnapshot,
  syncEdgeMasters,
} from "./master-sync.ts";
import { EdgeBootError } from "./runtime.ts";

export type EdgeBootstrapConfig = Pick<
  Extract<EdgeRuntimeConfig, { edgeMode: true }>,
  "cloudUrl" | "credential"
>;

export type EdgeBootstrapOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type EdgeBootstrapResult = "present" | "bootstrapped";

type Claims = NonNullable<ReturnType<typeof parseEdgeCredential>>;
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

const PRESENT_SYNC_TIMEOUT_MS = 5_000;

async function localRowsPresent(claims: Claims): Promise<boolean> {
  return withTenant(db, edgeNodeContext(claims), async (tx) => {
    const [tenant] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, claims.tenantId))
      .limit(1);
    const [outlet] = await tx
      .select({ id: outlets.id })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, claims.tenantId),
          eq(outlets.id, claims.outletId),
        ),
      )
      .limit(1);
    return tenant !== undefined && outlet !== undefined;
  });
}

/** Zero local locations for the outlet, or zero uoms for the tenant. */
async function mastersMissing(claims: Claims): Promise<boolean> {
  return withTenant(db, edgeNodeContext(claims), async (tx) => {
    const [location] = await tx
      .select({ id: stockLocations.id })
      .from(stockLocations)
      .where(
        and(
          eq(stockLocations.tenantId, claims.tenantId),
          eq(stockLocations.outletId, claims.outletId),
        ),
      )
      .limit(1);
    const [uom] = await tx
      .select({ id: uoms.id })
      .from(uoms)
      .where(eq(uoms.tenantId, claims.tenantId))
      .limit(1);
    return location === undefined || uom === undefined;
  });
}

function masterSyncCode(error: unknown): string {
  return error instanceof EdgeMasterSyncError ? error.code : "UNKNOWN";
}

function bootError(reason: string): EdgeBootError {
  return new EdgeBootError(
    `Data awal edge node tidak dapat dipasang (${reason}). / The edge node bootstrap failed (${reason}).`,
  );
}

async function fetchVerifiedBundle(
  config: EdgeBootstrapConfig,
  claims: Claims,
  options: EdgeBootstrapOptions,
): Promise<EdgeBootstrapBundle> {
  let body: unknown;
  try {
    body = await cloudGetJson({
      cloudUrl: config.cloudUrl,
      credential: config.credential,
      path: EDGE_BOOTSTRAP_PATH,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    throw bootError(
      error instanceof EdgeCloudHttpError
        ? `cloud ${error.code}`
        : "cloud request",
    );
  }
  if (body === null || typeof body !== "object")
    throw bootError("BAD_RESPONSE");
  const { bundle, signature } = body as {
    bundle?: unknown;
    signature?: unknown;
  };
  if (!edgeBootstrapSignatureMatches(bundle, signature, claims.hash))
    throw bootError("BAD_SIGNATURE");
  const parsed = edgeBootstrapBundleSchema.safeParse(bundle);
  if (!parsed.success) throw bootError("BAD_BUNDLE");
  if (
    parsed.data.tenant.id.toLowerCase() !== claims.tenantId.toLowerCase() ||
    parsed.data.outlet.id.toLowerCase() !== claims.outletId.toLowerCase()
  )
    throw bootError("SCOPE_MISMATCH");
  return parsed.data;
}

async function insertBundleRows(
  tx: Tx,
  bundle: EdgeBootstrapBundle,
): Promise<void> {
  const { tenant, legalEntity, outlet } = bundle;
  await tx
    .insert(tenants)
    .values({
      ...tenant,
      // JSONB copied as the cloud stores it (see the shared contract).
      featureFlags: tenant.featureFlags as FeatureFlags,
      limits: tenant.limits as TenantLimits,
      createdAt: new Date(tenant.createdAt),
    })
    .onConflictDoNothing();
  await tx
    .insert(legalEntities)
    .values({
      ...legalEntity,
      npwpEncrypted: null,
      npwpLast4: null,
      npwpHash: null,
      createdAt: new Date(legalEntity.createdAt),
    })
    .onConflictDoNothing();
  await tx
    .insert(brands)
    .values(
      bundle.brands.map((brand) => ({
        ...brand,
        createdAt: new Date(brand.createdAt),
      })),
    )
    .onConflictDoNothing();
  await tx
    .insert(outlets)
    .values({
      ...outlet,
      geofence: outlet.geofence as Geofence | null,
      openingHours: outlet.openingHours as OpeningHours,
      regionId: null,
      createdAt: new Date(outlet.createdAt),
    })
    .onConflictDoNothing();
}

/**
 * Boot of a node that was already bootstrapped (legend-2uqcd): the stored
 * masters may predate the all-tenant brands, and the catalog `recipes` stream
 * needs those brands (FK (tenant_id, brand_id)); menu_items and item_variants
 * wait for recipes. So the runtime syncs the masters once before the first
 * catalog pull instead of leaving the menu stale until the next periodic tick.
 * Best effort: never throws (an offline or failed sync is only logged, and the
 * catalog pull then retries as before). Returns whether the masters synced.
 */
export async function syncEdgeMastersBeforeCatalog(
  config: EdgeBootstrapConfig,
  options: EdgeBootstrapOptions = {},
): Promise<boolean> {
  try {
    await syncEdgeMasters(config, {
      timeoutMs: PRESENT_SYNC_TIMEOUT_MS,
      ...options,
    });
    return true;
  } catch (error) {
    const code = masterSyncCode(error);
    if (code.startsWith("CLOUD_"))
      logger.warn({ code }, "Edge master sync skipped before catalog start");
    else logger.error({ code }, "Edge master sync failed before catalog start");
    return false;
  }
}

/**
 * Starts `start` (the master sync loop with its first catalog pull) after the
 * boot-time master sync, without blocking the caller. `syncMasters` false (a
 * node bootstrapped in this very boot already applied the current snapshot)
 * starts right away. `stop` aborts a master sync still in flight and prevents
 * a start that has not happened yet. A requested run before the loop starts is
 * coalesced and forwarded once it is ready.
 */
export function startAfterBootMasters(input: {
  config: EdgeBootstrapConfig;
  syncMasters: boolean;
  options?: EdgeBootstrapOptions;
  start: () => { requestRun?(): void; stop(): Promise<void> };
}): { requestRun(): void; stop(): Promise<void> } {
  const abort = new AbortController();
  let stopped = false;
  let started: ReturnType<typeof input.start> | null = null;
  let wakePending = false;
  const ready = (
    input.syncMasters
      ? syncEdgeMastersBeforeCatalog(input.config, {
          ...input.options,
          signal: abort.signal,
        })
      : Promise.resolve(true)
  )
    .then(() => {
      if (!stopped) {
        started = input.start();
        if (wakePending) {
          wakePending = false;
          started.requestRun?.();
        }
      }
    })
    .catch((error) =>
      logger.error(
        { code: error instanceof Error ? error.name : "UNKNOWN" },
        "Edge master sync loop did not start",
      ),
    );
  return {
    requestRun() {
      if (stopped) return;
      if (started) started.requestRun?.();
      else wakePending = true;
    },
    async stop() {
      stopped = true;
      abort.abort();
      await ready;
      await started?.stop();
    },
  };
}

/**
 * Edge boot, before ensureLocalEdgeNode: make sure the credential's tenant
 * and outlet rows exist locally. Throws EdgeBootError when they are missing
 * and cannot be fetched, verified or inserted.
 */
export async function bootstrapEdgeNodeIfNeeded(
  config: EdgeBootstrapConfig,
  options: EdgeBootstrapOptions = {},
): Promise<EdgeBootstrapResult> {
  const claims = parseEdgeCredential(config.credential);
  if (!claims) throw bootError("EDGE_NODE_CREDENTIAL");
  if (await localRowsPresent(claims)) {
    // Node bootstrapped before the master sync: fetch the masters once,
    // best-effort (the node must still boot offline).
    if (await mastersMissing(claims)) {
      try {
        await syncEdgeMasters(config, {
          ...options,
          timeoutMs: PRESENT_SYNC_TIMEOUT_MS,
        });
      } catch (error) {
        const code = masterSyncCode(error);
        if (code.startsWith("CLOUD_"))
          logger.warn({ code }, "Edge master sync skipped at boot");
        else logger.error({ code }, "Edge master sync failed at boot");
      }
    }
    return "present";
  }
  // Data import guard (legend-v4ld/legend-rhwb): this node's own deployment
  // policy must allow the rows (real data only in production). It does not
  // compare the cloud's environment with the node's: the bundle does not
  // declare one (follow-up bead). Report the reason as a boot code.
  try {
    guardDataImport("edge.bootstrap");
  } catch {
    throw bootError("DATA_IMPORT_BLOCKED");
  }

  const bundle = await fetchVerifiedBundle(config, claims, options);
  let snapshot: Awaited<ReturnType<typeof fetchVerifiedMasterSnapshot>>;
  try {
    snapshot = await fetchVerifiedMasterSnapshot(config, options);
  } catch (error) {
    throw bootError(`MASTERS ${masterSyncCode(error)}`);
  }
  if (
    snapshot.legalEntityId.toLowerCase() !==
    bundle.outlet.legalEntityId.toLowerCase()
  )
    throw bootError("MASTERS SCOPE_MISMATCH");
  try {
    // One transaction: a failure leaves nothing behind, so the next boot is
    // a fresh bootstrap again.
    await withTenant(db, edgeNodeContext(claims), async (tx) => {
      try {
        await insertBundleRows(tx, bundle);
      } catch {
        // Driver errors can carry SQL parameters: report a code only.
        throw bootError("LOCAL_INSERT");
      }
      // An existing conflicting row (e.g. same outlet code, other id) skips
      // the insert silently: report that, not a masters scope error.
      const [outlet] = await tx
        .select({ id: outlets.id })
        .from(outlets)
        .where(
          and(
            eq(outlets.tenantId, claims.tenantId),
            eq(outlets.id, claims.outletId),
          ),
        )
        .limit(1);
      if (outlet === undefined) throw bootError("LOCAL_CONFLICT");
      try {
        await applyEdgeMasterSnapshotInTransaction(tx, claims, snapshot);
      } catch (error) {
        // Driver errors can carry SQL parameters: report a code only.
        throw bootError(
          `MASTERS ${error instanceof EdgeMasterSyncError ? error.code : "LOCAL_WRITE"}`,
        );
      }
    });
  } catch (error) {
    if (error instanceof EdgeBootError) throw error;
    throw bootError("LOCAL_INSERT");
  }
  // An existing conflicting row (e.g. same outlet code, other id) skips the
  // insert silently; the outlet must be there now or the node stays down.
  if (!(await localRowsPresent(claims))) throw bootError("LOCAL_CONFLICT");
  logger.info(
    { tenantId: claims.tenantId, outletId: claims.outletId },
    "Edge bootstrap bundle applied",
  );
  return "bootstrapped";
}
