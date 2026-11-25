// Edge master-data sync, edge side (bead legend-9ppw; PRD v1.7 §3 F5 "Server
// Lokal"). Edge `stock.moved` events name stock locations (and post to the
// chart of accounts), and the cloud rejects ids it does not know. So the edge
// copies these masters from the cloud with ids identical to the cloud's:
// `brands` (every brand of the tenant, legend-2uqcd), `uoms` (tenant-wide),
// `stock_locations` (its outlet only), and `chart_of_accounts` +
// `account_mappings` (its outlet's legal entity only).
//
// - brands: bootstrap stores only the outlet's own brand, but the catalog sync
//   delivers the recipes of every brand of the tenant (a recipe of another
//   brand may feed an item or modifier here), and each recipe needs its brand
//   row (FK (tenant_id, brand_id)). Brands are upserted first, by id, never
//   deleted. A local brand with the same slug under another id is a
//   LOCAL_CONFLICT, like uoms.
// - Full snapshot, no cursor: uoms and stock_locations carry no updated_at.
//   GET /api/edge-sync/bootstrap/masters returns `{ snapshot, signature }`.
// - The signature is checked over the snapshot exactly as received (same
//   integrity-only trust as the bootstrap bundle: see bootstrap.ts; authenticity
//   comes from TLS), then its shape, then its tenant/outlet vs the credential.
// - Apply = one transaction under the node's own tenant context, serialised per
//   outlet by `pg_advisory_xact_lock`. Cloud wins: every row is upserted by
//   `id`. A local row with the same natural key (uoms tenant+code, accounts
//   tenant+entity+code) but another id is never overwritten or re-keyed: the
//   whole apply aborts with LOCAL_CONFLICT (ids must never fork), nothing is
//   written.
// - A local chart_of_accounts id of the outlet's entity that the snapshot does
//   not list, but whose code the snapshot holds under another id, is a fork:
//   the standard template provisioned locally before the import
//   (legend-usa4b), or accounts a local migration inserted under random ids
//   (0147, legend-ht6fu). The cloud never hard-deletes accounts, so the cloud's
//   row replaces it: its mappings are deleted, the in-snapshot local accounts
//   that have it as parent are detached (parent_id null; the upsert below sets
//   the cloud parent), then the fork is deleted, all before the natural-key
//   pre-check. A local id outside the snapshot whose code the snapshot does not
//   hold (an empty chart included) is never deleted: a replayed older signed
//   snapshot (the signature carries no version) may simply predate it. That,
//   and a fork that a foreign key still names (journal line, budget, period
//   snapshot), abort the apply with LOCAL_CONFLICT, nothing is written. A
//   replacement logs its count and the legal entity id at info, nothing else.
// - uoms, stock_locations and chart_of_accounts rows missing from the snapshot
//   are never deleted locally when referenced: ledger and stock rows reference
//   them by foreign key (chart_of_accounts: see the fork rule above). A
//   deactivated location or account arrives as `isActive: false`.
//   account_mappings are the exception: the cloud's set per legal entity is
//   authoritative, so local mappings whose role is not in the snapshot are
//   deleted (nothing references a mapping row).
// - A mapping whose role this build does not know (a newer cloud, legend-dhbt1)
//   is dropped before the apply: logged (role names and count only) and
//   counted as `droppedMappings`. The rest of the snapshot is applied, and the
//   mapping replacement above works on the known roles only.
// - The natural-key pre-check assumes uom and account codes are immutable on
//   the cloud (a renamed code would look like a local fork). Stock locations
//   have no natural key, so a location created locally under another id is not
//   detected (known gap).
// - Data import guard (legend-8izz): every master write goes through
//   `guardDataImport("edge.bootstrap")`, the same deployment policy as the
//   bootstrap bundle (real data only in production). `syncEdgeMasters` checks
//   it before the cloud fetch and the apply checks it again before its first
//   write, so no caller (boot, loop, direct apply) can skip it. A refusal is
//   EdgeMasterSyncError("DATA_IMPORT_BLOCKED"); nothing is written.
//
// Never put the credential or SQL parameters in an error: codes only.
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  CATALOG_PROTOCOL_MIN_VERSION,
  CATALOG_PROTOCOL_VERSION,
  CATALOG_TAX_STREAMS,
  isCatalogTaxStream,
  CATALOG_SYNC_LIMIT_DEFAULT,
  EDGE_CATALOG_SYNC_PATH,
  type CatalogSyncStream,
} from "@starter/shared/edge";
import type { ScopedTenantContext } from "@starter/shared/core";
import { hasUnsafeSnapshotFields } from "@starter/shared/edge/snapshot-safety";
import {
  EDGE_MASTER_SNAPSHOT_PATH,
  EDGE_MASTER_SNAPSHOT_VERSION,
  EDGE_MASTER_SNAPSHOT_VERSION_HEADER,
  edgeMasterSnapshotSchema,
  partitionEdgeMasterMappings,
  type EdgeMasterSnapshot,
} from "@starter/shared/edge/master-sync";
import { guardDataImport } from "../config/data-import.ts";
import { db } from "../db/index.ts";
import { accountMappings, chartOfAccounts } from "../db/schema/accounting.ts";
import { stockLocations, uoms } from "../db/schema/inventory.ts";
import { edgePullCheckpoints } from "../db/schema/edge-node.ts";
import { brands, outlets } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import {
  CRITICAL_CATALOG_STREAMS,
  isOfflineFailureCode,
  type CatalogFreshnessTracker,
} from "./catalog-freshness.ts";
import { logger } from "../lib/logger.ts";
import { edgeBootstrapSignatureMatches } from "../services/edge-bootstrap.service.ts";
import { edgeNodeContext } from "../services/edge-node.service.ts";
import {
  lockChartOfAccounts,
  lockOutletStockLocations,
} from "../services/tenant-config-locks.ts";
import type { EdgeBootstrapConfig, EdgeBootstrapOptions } from "./bootstrap.ts";
import { cloudGetJson, EdgeCloudHttpError } from "./cloud-http.ts";
import {
  CATALOG_REWIND_MARK,
  catalogCheckpointStream,
  catalogReplayCheckpoint,
  pullCatalog,
  type PullCatalogOptions,
} from "./catalog-puller.ts";
import { parseEdgeCredential } from "./credential.ts";

type Claims = NonNullable<ReturnType<typeof parseEdgeCredential>>;
type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

const MIN_SYNC_INTERVAL_MS = 60_000;
/** Catalog pulls in one tick while a stream reports a backlog (bounded). */
const MAX_CATALOG_ROUNDS = 20;
/** A corrupt continuation must not keep the master sync running forever. */
const MAX_MASTER_BRAND_PAGES = 1000;

type MasterCapability = {
  version: EdgeMasterSnapshot["version"] | null;
  pending: boolean;
};
// The runtime shares its config between bootstrap and the periodic loop. A
// restart starts conservatively until its boot-time master sync has committed.
const masterCapabilities = new WeakMap<EdgeBootstrapConfig, MasterCapability>();

export function markEdgeMasterSnapshotPending(
  config: EdgeBootstrapConfig,
): void {
  const previous = masterCapabilities.get(config);
  masterCapabilities.set(config, {
    version: previous?.version ?? null,
    pending: true,
  });
}

/** Call only after every signed master page has committed locally. */
export async function recordAppliedMasterSnapshotVersion(
  config: EdgeBootstrapConfig,
  version: EdgeMasterSnapshot["version"],
  database: typeof db = db,
): Promise<void> {
  const previous = masterCapabilities.get(config);
  if (version === 2 && previous?.version !== 2) {
    const claims = parseEdgeCredential(config.credential);
    if (!claims) throw new EdgeMasterSyncError("EDGE_NODE_CREDENTIAL");
    // Protocol 2 may have checkpointed past recipes of other brands. Rewind
    // only its cursor on widening; retain freshness and all stored documents.
    try {
      await withTenant(database, edgeNodeContext(claims), async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edge-catalog-sync:${claims.tenantId}:recipes`.toLowerCase()}, 0))`,
        );
        await tx
          .update(edgePullCheckpoints)
          .set({ watermark: null, updatedAt: new Date() })
          .where(
            and(
              eq(edgePullCheckpoints.tenantId, claims.tenantId),
              eq(edgePullCheckpoints.outletId, claims.outletId),
              eq(edgePullCheckpoints.edgeNodeId, claims.edgeNodeId),
              eq(
                edgePullCheckpoints.stream,
                catalogCheckpointStream("recipes"),
              ),
            ),
          );
      });
    } catch {
      throw new EdgeMasterSyncError("LOCAL_WRITE");
    }
  }
  masterCapabilities.set(config, { version, pending: false });
}

/**
 * legend-10nex: the last success of each critical catalog stream, from its
 * pull checkpoint (`edge_pull_checkpoints.last_success_at`, written by every
 * finished pull). Boot seeds the freshness tracker with it so a restart does
 * not hide a stale catalog. No row (a new edge) = no entry.
 */
export async function loadCatalogLastSuccess(
  context: ScopedTenantContext,
  edgeNodeId: string,
  database: typeof db = db,
): Promise<Map<string, Date>> {
  const keys = CRITICAL_CATALOG_STREAMS.map((stream) =>
    catalogCheckpointStream(stream),
  );
  const rows = await withTenant(database, context, (tx) =>
    tx
      .select({
        stream: edgePullCheckpoints.stream,
        lastSuccessAt: edgePullCheckpoints.lastSuccessAt,
      })
      .from(edgePullCheckpoints)
      .where(
        and(
          eq(edgePullCheckpoints.edgeNodeId, edgeNodeId),
          inArray(edgePullCheckpoints.stream, keys),
        ),
      ),
  );
  const seeded = new Map<string, Date>();
  for (const stream of CRITICAL_CATALOG_STREAMS) {
    const row = rows.find(
      (entry) => entry.stream === catalogCheckpointStream(stream),
    );
    if (row) seeded.set(stream, row.lastSuccessAt);
  }
  return seeded;
}

/**
 * Tax streams whose stored rules are not proven whole: rewound, a replay not
 * confirmed, or a pull cut half way (epoch). Unreadable counts as all of them.
 */
async function loadOpenTaxStreams(
  context: ScopedTenantContext,
  edgeNodeId: string,
  database: typeof db = db,
): Promise<Set<string>> {
  try {
    const rows = await withTenant(database, context, (tx) =>
      tx
        .select({
          stream: edgePullCheckpoints.stream,
          watermark: edgePullCheckpoints.watermark,
          lastSuccessAt: edgePullCheckpoints.lastSuccessAt,
        })
        .from(edgePullCheckpoints)
        .where(
          and(
            eq(edgePullCheckpoints.edgeNodeId, edgeNodeId),
            inArray(
              edgePullCheckpoints.stream,
              CATALOG_TAX_STREAMS.flatMap((stream) => [
                catalogCheckpointStream(stream),
                catalogReplayCheckpoint(stream),
              ]),
            ),
          ),
        ),
    );
    return new Set(
      CATALOG_TAX_STREAMS.filter((stream) =>
        rows.some(
          (row) =>
            row.stream === catalogReplayCheckpoint(stream) ||
            (row.stream === catalogCheckpointStream(stream) &&
              (row.watermark === CATALOG_REWIND_MARK ||
                row.lastSuccessAt.getTime() === 0)),
        ),
      ),
    );
  } catch {
    return new Set(CATALOG_TAX_STREAMS);
  }
}

/**
 * Boot: seed the freshness tracker with each critical stream's last success
 * from the pull checkpoint, so a restart neither hides a stale catalog nor
 * dates it differently from the pull (same `last_success_at` value). A tax
 * stream that is rewound or half read stays held.
 */
export async function seedCatalogFreshness(
  freshness: CatalogFreshnessTracker,
  context: ScopedTenantContext,
  edgeNodeId: string,
  database: typeof db = db,
): Promise<void> {
  for (const [stream, at] of await loadCatalogLastSuccess(
    context,
    edgeNodeId,
    database,
  ))
    freshness.seedLastSuccess(stream, at);
  freshness.setTaxOpen(await loadOpenTaxStreams(context, edgeNodeId, database));
}

export type EdgeMasterSyncCounts = {
  brands: number;
  uoms: number;
  stockLocations: number;
  accounts: number;
  /** Mappings applied (known roles). */
  mappings: number;
  /** Mappings dropped because this build does not know their role. */
  droppedMappings: number;
};

/**
 * code: EDGE_NODE_CREDENTIAL, CLOUD_<code>, BAD_RESPONSE, BAD_SIGNATURE,
 * BAD_SNAPSHOT, SCOPE_MISMATCH, DATA_IMPORT_BLOCKED, LOCAL_CONFLICT or
 * LOCAL_WRITE.
 */
export class EdgeMasterSyncError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Edge master sync failed (${code})`);
    this.name = "EdgeMasterSyncError";
    this.code = code;
  }
}

/**
 * The masters are rows of the node's own deployment, like the bootstrap
 * bundle, so they share its registered import source and policy. The guard's
 * message is dropped: report a code only.
 */
function guardMasterImport(): void {
  try {
    guardDataImport("edge.bootstrap");
  } catch {
    throw new EdgeMasterSyncError("DATA_IMPORT_BLOCKED");
  }
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Cloud fetch + signature + shape + scope check. Nothing is written. */
export async function fetchVerifiedMasterSnapshot(
  config: EdgeBootstrapConfig,
  options: EdgeBootstrapOptions = {},
): Promise<EdgeMasterSnapshot> {
  return fetchVerifiedMasterSnapshotPage(config, options);
}

async function fetchVerifiedMasterSnapshotPage(
  config: EdgeBootstrapConfig,
  options: EdgeBootstrapOptions,
  cursor?: EdgeMasterSnapshot["nextBrandCursor"],
): Promise<EdgeMasterSnapshot> {
  const claims = parseEdgeCredential(config.credential);
  if (!claims) throw new EdgeMasterSyncError("EDGE_NODE_CREDENTIAL");
  const query = new URLSearchParams({
    snapshotVersion: String(EDGE_MASTER_SNAPSHOT_VERSION),
    brandPage: "1",
    // Opt in to `uoms[].isSystem`; the cloud omits it for older edges.
    uomIsSystem: "1",
  });
  if (cursor !== undefined) query.set("brandCursor", cursor);
  let body: unknown;
  try {
    body = await cloudGetJson({
      cloudUrl: config.cloudUrl,
      credential: config.credential,
      path: `${EDGE_MASTER_SNAPSHOT_PATH}?${query.toString()}`,
      // Query negotiation survives stripped headers. A cloud predating both
      // options ignores them and returns version 1, still accepted below.
      headers: {
        [EDGE_MASTER_SNAPSHOT_VERSION_HEADER]: String(
          EDGE_MASTER_SNAPSHOT_VERSION,
        ),
      },
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    throw new EdgeMasterSyncError(
      error instanceof EdgeCloudHttpError
        ? `CLOUD_${error.code}`
        : "CLOUD_REQUEST",
    );
  }
  if (body === null || typeof body !== "object")
    throw new EdgeMasterSyncError("BAD_RESPONSE");
  const extraFields = Object.fromEntries(
    Object.entries(body).filter(
      ([key]) => key !== "snapshot" && key !== "signature",
    ),
  );
  if (hasUnsafeSnapshotFields(extraFields))
    throw new EdgeMasterSyncError("BAD_RESPONSE");
  const { snapshot, signature } = body as {
    snapshot?: unknown;
    signature?: unknown;
  };
  if (!edgeBootstrapSignatureMatches(snapshot, signature, claims.hash))
    throw new EdgeMasterSyncError("BAD_SIGNATURE");
  const parsed = edgeMasterSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new EdgeMasterSyncError("BAD_SNAPSHOT");
  assertScope(claims, parsed.data);
  return parsed.data;
}

/** Bounded memory: validate and apply one signed page before requesting more. */
export async function* fetchVerifiedMasterSnapshotPages(
  config: EdgeBootstrapConfig,
  options: EdgeBootstrapOptions = {},
): AsyncGenerator<EdgeMasterSnapshot> {
  let cursor: EdgeMasterSnapshot["nextBrandCursor"];
  let first: EdgeMasterSnapshot | undefined;
  for (let page = 0; page < MAX_MASTER_BRAND_PAGES; page += 1) {
    const snapshot = await fetchVerifiedMasterSnapshotPage(
      config,
      options,
      cursor,
    );
    if (first === undefined) first = snapshot;
    else if (
      snapshot.version !== first.version ||
      !sameId(snapshot.legalEntityId, first.legalEntityId) ||
      snapshot.brandId !== first.brandId
    )
      throw new EdgeMasterSyncError("SCOPE_MISMATCH");
    const others = (snapshot.brands ?? [])
      .filter((row) => row.id !== snapshot.brandId)
      .map((row) => row.id.toLowerCase());
    const next = snapshot.nextBrandCursor;
    const incomingCursor = cursor?.toLowerCase();
    if (
      (incomingCursor !== undefined &&
        others.some((id) => id <= incomingCursor)) ||
      (next !== undefined &&
        ((incomingCursor !== undefined &&
          next.toLowerCase() <= incomingCursor) ||
          next.toLowerCase() !== others.sort().at(-1)))
    )
      throw new EdgeMasterSyncError("BAD_SNAPSHOT");
    yield snapshot;
    if (next === undefined) return;
    cursor = next;
  }
  throw new EdgeMasterSyncError("MASTER_PAGES_EXCEEDED");
}

function assertScope(claims: Claims, snapshot: EdgeMasterSnapshot): void {
  if (
    !sameId(snapshot.tenantId, claims.tenantId) ||
    !sameId(snapshot.outletId, claims.outletId)
  )
    throw new EdgeMasterSyncError("SCOPE_MISMATCH");
}

type Account = EdgeMasterSnapshot["chartOfAccounts"][number];

/** SQLSTATE 23503, also when drizzle wraps the driver error as `cause`. */
function isForeignKeyViolation(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return (
    candidate.code === "23503" ||
    isForeignKeyViolation(candidate.cause, depth + 1)
  );
}

/** Parents before children. A cycle or a missing parent is a bad snapshot. */
function parentsFirst(accounts: readonly Account[]): Account[] {
  const placed = new Set<string>();
  const ordered: Account[] = [];
  let pending = [...accounts];
  while (pending.length > 0) {
    const next: Account[] = [];
    for (const account of pending) {
      if (account.parentId === null || placed.has(account.parentId)) {
        ordered.push(account);
        placed.add(account.id);
      } else next.push(account);
    }
    if (next.length === pending.length)
      throw new EdgeMasterSyncError("BAD_SNAPSHOT");
    pending = next;
  }
  return ordered;
}

/**
 * Upserts the snapshot (cloud wins, by id) inside the caller's tenant
 * transaction and returns the row counts. Throws EdgeMasterSyncError only; the
 * caller owns the transaction, so any throw rolls everything back. See the
 * header for the conflict and delete rules.
 */
export async function applyEdgeMasterSnapshotInTransaction(
  tx: Tx,
  claims: Claims,
  snapshot: EdgeMasterSnapshot,
): Promise<EdgeMasterSyncCounts> {
  guardMasterImport();
  assertScope(claims, snapshot);
  const accounts = parentsFirst(snapshot.chartOfAccounts);
  const { tenantId, outletId, legalEntityId } = snapshot;
  // Unknown roles (a newer cloud) are dropped, not fatal: see the header.
  const { known: mappings, unknownRoles } = partitionEdgeMasterMappings(
    snapshot.accountMappings,
  );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`edge-master-sync:${tenantId}:${outletId}`}, 0))`,
  );
  // Chart of accounts of the snapshot's legal entity (the only one this apply
  // writes CoA and mappings for; the outlet check below proves it is the
  // outlet's own). Shared with the provisioning backfill and the owner's chart
  // writers (legend-usa4b), taken before the natural-key precheck and every
  // write so the backfill can never see the chart empty while this import is
  // about to commit, and mix the template into a cloud chart.
  // The outlet's stock locations are written here too, so the location lock
  // is shared with the default-location provisioning the same way.
  // Lock order: `edge-master-sync` (above) first, then CoA, then stock
  // locations, as documented in services/tenant-config-locks.ts. No other path
  // takes `edge-master-sync`, so neither lock is held while waiting for it.
  await lockChartOfAccounts(tx, tenantId, legalEntityId);
  await lockOutletStockLocations(tx, tenantId, outletId);

  const [outlet] = await tx
    .select({ legalEntityId: outlets.legalEntityId })
    .from(outlets)
    .where(and(eq(outlets.tenantId, tenantId), eq(outlets.id, outletId)))
    .limit(1);
  if (!outlet || !sameId(outlet.legalEntityId, legalEntityId))
    throw new EdgeMasterSyncError("SCOPE_MISMATCH");

  // A local account id outside the snapshot is replaced only when the snapshot
  // holds its code under another id (a fork, see the header). Any other
  // outside id is refused before any write: it may be a real cloud account
  // that a replayed older snapshot predates. Replacement, inside a savepoint:
  // delete the forked accounts' mappings, detach the in-snapshot local
  // children of a fork (parent_id null; the upsert below sets the cloud
  // parent), then delete the forks in ONE statement (the foreign keys are NO
  // ACTION and checked at statement end, so a forked parent and its forked
  // children go together). A foreign key violation means ledger, budget or
  // period snapshot rows still name a fork, so nothing is written and the
  // apply is refused.
  const snapshotAccountIds = new Set(
    accounts.map((row) => row.id.toLowerCase()),
  );
  const snapshotCodes = new Set(accounts.map((row) => row.code));
  const localAccounts = await tx
    .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.tenantId, tenantId),
        eq(chartOfAccounts.legalEntityId, legalEntityId),
      ),
    );
  const outside = localAccounts.filter(
    (row) => !snapshotAccountIds.has(row.id.toLowerCase()),
  );
  if (outside.some((row) => !snapshotCodes.has(row.code)))
    throw new EdgeMasterSyncError("LOCAL_CONFLICT");
  const forkedIds = outside.map((row) => row.id);
  if (forkedIds.length > 0) {
    try {
      await tx.transaction(async (savepoint) => {
        await savepoint
          .delete(accountMappings)
          .where(
            and(
              eq(accountMappings.tenantId, tenantId),
              eq(accountMappings.legalEntityId, legalEntityId),
              inArray(accountMappings.accountId, forkedIds),
            ),
          );
        await savepoint
          .update(chartOfAccounts)
          .set({ parentId: null })
          .where(
            and(
              eq(chartOfAccounts.tenantId, tenantId),
              eq(chartOfAccounts.legalEntityId, legalEntityId),
              inArray(chartOfAccounts.parentId, forkedIds),
              notInArray(chartOfAccounts.id, forkedIds),
            ),
          );
        await savepoint
          .delete(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.tenantId, tenantId),
              eq(chartOfAccounts.legalEntityId, legalEntityId),
              inArray(chartOfAccounts.id, forkedIds),
            ),
          );
      });
    } catch (error) {
      if (isForeignKeyViolation(error))
        throw new EdgeMasterSyncError("LOCAL_CONFLICT");
      throw error;
    }
    logger.info(
      { legalEntityId, replacedForks: forkedIds.length },
      "Edge master sync replaced forked chart accounts",
    );
  }

  // Natural-key collisions under another id: refuse, never fork ids.
  // Version 1 (an older cloud) carries no brands: nothing to write or delete.
  const snapshotBrands = snapshot.brands ?? [];
  if (snapshotBrands.length > 0) {
    const local = await tx
      .select({ id: brands.id, slug: brands.slug })
      .from(brands)
      .where(
        and(
          eq(brands.tenantId, tenantId),
          inArray(
            brands.slug,
            snapshotBrands.map((row) => row.slug),
          ),
        ),
      );
    const bySlug = new Map(local.map((row) => [row.slug, row.id]));
    for (const row of snapshotBrands) {
      const existing = bySlug.get(row.slug);
      if (existing !== undefined && !sameId(existing, row.id))
        throw new EdgeMasterSyncError("LOCAL_CONFLICT");
    }
  }
  if (snapshot.uoms.length > 0) {
    const local = await tx
      .select({ id: uoms.id, code: uoms.code })
      .from(uoms)
      .where(
        and(
          eq(uoms.tenantId, tenantId),
          inArray(
            uoms.code,
            snapshot.uoms.map((row) => row.code),
          ),
        ),
      );
    const byCode = new Map(local.map((row) => [row.code, row.id]));
    for (const row of snapshot.uoms) {
      const existing = byCode.get(row.code);
      if (existing !== undefined && !sameId(existing, row.id))
        throw new EdgeMasterSyncError("LOCAL_CONFLICT");
    }
  }
  if (accounts.length > 0) {
    const local = await tx
      .select({ id: chartOfAccounts.id, code: chartOfAccounts.code })
      .from(chartOfAccounts)
      .where(
        and(
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
          inArray(
            chartOfAccounts.code,
            accounts.map((row) => row.code),
          ),
        ),
      );
    const byCode = new Map(local.map((row) => [row.code, row.id]));
    for (const row of accounts) {
      const existing = byCode.get(row.code);
      if (existing !== undefined && !sameId(existing, row.id))
        throw new EdgeMasterSyncError("LOCAL_CONFLICT");
    }
  }

  // Brands first: recipes of other brands (catalog stream) need them.
  for (const row of snapshotBrands) {
    const written = await tx
      .insert(brands)
      .values({ ...row, createdAt: new Date(row.createdAt) })
      .onConflictDoUpdate({
        target: brands.id,
        set: {
          slug: row.slug,
          name: row.name,
          logoMediaId: row.logoMediaId,
          themeId: row.themeId,
        },
        setWhere: eq(brands.tenantId, tenantId),
      })
      .returning({ id: brands.id });
    if (written.length === 0) throw new EdgeMasterSyncError("SCOPE_MISMATCH");
  }
  for (const row of snapshot.uoms) {
    await tx
      .insert(uoms)
      .values({ ...row, createdAt: new Date(row.createdAt) })
      .onConflictDoUpdate({
        target: uoms.id,
        set: { code: row.code, name: row.name, isSystem: row.isSystem },
      });
  }
  for (const row of snapshot.stockLocations) {
    const written = await tx
      .insert(stockLocations)
      .values({ ...row, createdAt: new Date(row.createdAt) })
      .onConflictDoUpdate({
        target: stockLocations.id,
        set: { name: row.name, type: row.type, isActive: row.isActive },
        setWhere: and(
          eq(stockLocations.tenantId, tenantId),
          eq(stockLocations.outletId, outletId),
        ),
      })
      .returning({ id: stockLocations.id });
    if (written.length === 0) throw new EdgeMasterSyncError("SCOPE_MISMATCH");
  }
  for (const row of accounts) {
    const written = await tx
      .insert(chartOfAccounts)
      .values({
        ...row,
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      })
      .onConflictDoUpdate({
        target: chartOfAccounts.id,
        set: {
          code: row.code,
          name: row.name,
          type: row.type,
          reportGroup: row.reportGroup,
          parentId: row.parentId,
          isActive: row.isActive,
          updatedAt: new Date(row.updatedAt),
        },
        setWhere: and(
          eq(chartOfAccounts.tenantId, tenantId),
          eq(chartOfAccounts.legalEntityId, legalEntityId),
        ),
      })
      .returning({ id: chartOfAccounts.id });
    if (written.length === 0) throw new EdgeMasterSyncError("SCOPE_MISMATCH");
  }
  for (const row of mappings) {
    await tx
      .insert(accountMappings)
      .values(row)
      .onConflictDoUpdate({
        target: [
          accountMappings.tenantId,
          accountMappings.legalEntityId,
          accountMappings.role,
        ],
        set: { accountId: row.accountId },
      });
  }
  // The cloud's mapping set (known roles) replaces the local one (see the
  // header). An empty set means no role is kept.
  const keptRoles = mappings.map((row) => row.role);
  await tx
    .delete(accountMappings)
    .where(
      and(
        eq(accountMappings.tenantId, tenantId),
        eq(accountMappings.legalEntityId, legalEntityId),
        keptRoles.length > 0
          ? notInArray(accountMappings.role, keptRoles)
          : undefined,
      ),
    );
  // Logged before the caller commits: a later rollback still leaves this line.
  // Repeats on every sync while the cloud is ahead (bounded: 200 x 40 chars).
  if (unknownRoles.length > 0)
    logger.warn(
      { droppedMappings: unknownRoles.length, droppedRoles: unknownRoles },
      "Edge master sync dropped mappings with roles this build does not know",
    );
  return {
    brands: snapshotBrands.length,
    uoms: snapshot.uoms.length,
    stockLocations: snapshot.stockLocations.length,
    accounts: accounts.length,
    mappings: mappings.length,
    droppedMappings: unknownRoles.length,
  };
}

/**
 * Upserts the snapshot into the local database in its own transaction. Driver
 * errors become LOCAL_WRITE. See the header for the conflict and delete rules.
 */
export async function applyEdgeMasterSnapshot(
  claims: Claims,
  snapshot: EdgeMasterSnapshot,
  database: typeof db = db,
): Promise<EdgeMasterSyncCounts> {
  assertScope(claims, snapshot);
  try {
    return await withTenant(database, edgeNodeContext(claims), (tx) =>
      applyEdgeMasterSnapshotInTransaction(tx, claims, snapshot),
    );
  } catch (error) {
    if (error instanceof EdgeMasterSyncError) throw error;
    // Driver errors can carry SQL parameters: report a code only.
    throw new EdgeMasterSyncError("LOCAL_WRITE");
  }
}

/** Fetch, verify and apply the cloud's masters once. */
export async function syncEdgeMasters(
  config: EdgeBootstrapConfig,
  options: EdgeBootstrapOptions = {},
  database: typeof db = db,
): Promise<EdgeMasterSyncCounts> {
  const claims = parseEdgeCredential(config.credential);
  if (!claims) throw new EdgeMasterSyncError("EDGE_NODE_CREDENTIAL");
  guardMasterImport();
  try {
    let counts: EdgeMasterSyncCounts | undefined;
    let version: EdgeMasterSnapshot["version"] | undefined;
    let brandCount = 0;
    for await (const snapshot of fetchVerifiedMasterSnapshotPages(
      config,
      options,
    )) {
      if (version === undefined) {
        version = snapshot.version;
        markEdgeMasterSnapshotPending(config);
      }
      const pageCounts = await applyEdgeMasterSnapshot(
        claims,
        snapshot,
        database,
      );
      // The outlet's own brand repeats on every page to preserve scope checks.
      brandCount += pageCounts.brands - (counts === undefined ? 0 : 1);
      counts = pageCounts;
    }
    if (counts === undefined || version === undefined)
      throw new EdgeMasterSyncError("BAD_SNAPSHOT");
    await recordAppliedMasterSnapshotVersion(config, version, database);
    return { ...counts, brands: brandCount };
  } catch (error) {
    // A failed master refresh must not stop the outlet's catalog. Downgrade
    // until a complete v2 sync can rewind recipes and widen the catalog again.
    masterCapabilities.set(config, { version: null, pending: false });
    throw error;
  }
}

/** A catalog stream stopped early (legend-24318); code only, never record data. */
export class EdgeCatalogSyncError extends Error {
  readonly code: string;
  readonly stream: string;

  constructor(stream: string, code: string) {
    super(`Edge catalog sync failed (${stream}: ${code})`);
    this.name = "EdgeCatalogSyncError";
    this.code = code;
    this.stream = stream;
  }
}

/**
 * Periodic `syncEdgeMasters`, then `pullCatalog` (legend-24318): masters
 * first because inventory items need their uoms. A failure of one does not
 * stop the other; every error goes to `onError`
 * (a catalog stream error as `EdgeCatalogSyncError`). A catalog backlog is
 * pulled on in the same tick, up to 20 rounds. No immediate master run
 * (bootstrap already syncs); with `catalogOnStart` one catalog-only run starts
 * right away without blocking the caller. The timer is unref'd, a tick is
 * skipped while a run is in flight, and `stop` aborts that run's request and
 * waits for it. `intervalMs` must be finite and >= 60 s (RangeError at start).
 * Errors go to `onError`; the loop keeps going.
 */
export function startEdgeMasterSyncLoop(input: {
  config: EdgeBootstrapConfig;
  intervalMs: number;
  onError?: (error: unknown) => void;
  options?: EdgeBootstrapOptions;
  /** Default: local pool; tests can exercise a separate edge database. */
  database?: typeof db;
  /**
   * Optional overrides of the catalog pull. By default the node's scope and
   * `edge_nodes.id` come from the credential, like the masters apply.
   */
  catalog?: {
    /** The node's own scope: where catalog rows land. */
    context?: ScopedTenantContext;
    /** This node's `edge_nodes.id` (the checkpoint rows belong to it). */
    edgeNodeId?: string;
    /** Default `pullCatalog`; tests inject their own. */
    pull?: typeof pullCatalog;
    /**
     * legend-10nex: records, per critical stream, when the last pull
     * succeeded or why it failed. Without it the failures are only reported.
     */
    freshness?: CatalogFreshnessTracker;
    /**
     * 533b: the cloud's server time from the `Date` header of each successful
     * catalog page, offered as evidence for the trusted clock.
     */
    onServerTime?: (serverTime: Date) => void;
  };
  catalogOnStart?: boolean;
}): { requestRun(): void; stop(): Promise<void> } {
  if (
    !Number.isFinite(input.intervalMs) ||
    input.intervalMs < MIN_SYNC_INTERVAL_MS
  )
    throw new RangeError(
      `Edge master sync interval must be a finite number >= ${MIN_SYNC_INTERVAL_MS} ms`,
    );
  const abort = new AbortController();
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let wakePending = false;

  const report = (error: unknown) => {
    // stop() aborts an in-flight fetch: a normal shutdown, not an error.
    if (stopped) return;
    try {
      input.onError?.(error);
    } catch {
      // A broken logger must not stop the schedule.
    }
  };

  const fetchCatalogPage: PullCatalogOptions["fetchPage"] = (stream, since) =>
    cloudGetJson({
      cloudUrl: input.config.cloudUrl,
      credential: input.config.credential,
      path: catalogPath(
        stream,
        since,
        masterCapabilities.get(input.config)?.version === 2
          ? CATALOG_PROTOCOL_VERSION
          : CATALOG_PROTOCOL_MIN_VERSION,
      ),
      fetchImpl: input.options?.fetchImpl,
      timeoutMs: input.options?.timeoutMs,
      signal: abort.signal,
      onServerTime: input.catalog?.onServerTime,
    });

  const pullCatalogRounds = async (): Promise<void> => {
    const claims = parseEdgeCredential(input.config.credential);
    if (!claims) throw new EdgeMasterSyncError("EDGE_NODE_CREDENTIAL");
    const catalog = input.catalog;
    const context = catalog?.context ?? edgeNodeContext(claims);
    const edgeNodeId = catalog?.edgeNodeId ?? claims.edgeNodeId;
    const pull = catalog?.pull ?? pullCatalog;
    const freshness = catalog?.freshness;
    const holdOpenTax = async () =>
      freshness?.setTaxOpen(
        await loadOpenTaxStreams(context, edgeNodeId, input.database),
      );
    // Before anything that can fail: an operator's rewind holds sales even
    // when the cloud cannot be reached.
    if (freshness) await holdOpenTax();
    if (masterCapabilities.get(input.config)?.pending)
      throw new EdgeMasterSyncError("MASTERS_INCOMPLETE");
    guardMasterImport();
    for (let round = 0; round < MAX_CATALOG_ROUNDS && !stopped; round += 1) {
      const result = await pull({
        context,
        edgeNodeId,
        fetchPage: fetchCatalogPage,
        database: input.database,
        // The persisted success stamp must use the same clock as the live
        // freshness tracker; a rolled-back wall clock must not age a fresh
        // catalog immediately, including after the next restart.
        now: freshness ? () => freshness.now() : undefined,
      });
      if (freshness) await holdOpenTax();
      const entries = Object.entries(result.streams);
      // A stream skipped after its parent failed (CATALOG_PARENT_FAILED) is
      // unreachable only when every root failure of the round was.
      const roots = entries.filter(
        ([, outcome]) =>
          outcome?.error && outcome.error.code !== "CATALOG_PARENT_FAILED",
      );
      const cascadeOffline =
        roots.length > 0 &&
        roots.every(([, outcome]) =>
          isOfflineFailureCode(outcome?.error?.code ?? ""),
        );
      for (const [stream, outcome] of entries) {
        if (!outcome) continue;
        if (outcome.error) {
          const code = outcome.error.code;
          if (!stopped)
            freshness?.recordFailure(stream, {
              reason: code,
              cloudReachable: !(code === "CATALOG_PARENT_FAILED"
                ? cascadeOffline
                : isOfflineFailureCode(code)),
            });
          report(new EdgeCatalogSyncError(stream, code));
        } else if (
          !stopped &&
          // Half a tax rule set (a backlog) is not a success.
          !(isCatalogTaxStream(stream) && outcome.lastSuccessAt === null)
        )
          freshness?.recordSuccess(stream, outcome.lastSuccessAt ?? undefined);
      }
      if (!result.backlog) break;
    }
  };

  const runCatalog = async (): Promise<void> => {
    try {
      await pullCatalogRounds();
    } catch (error) {
      // Before or around the pull (credential, import guard, bad context):
      // every critical stream failed this run. The cloud is not implicated.
      // `stop()` aborting the request is a shutdown, not a failure.
      if (!stopped)
        for (const stream of CRITICAL_CATALOG_STREAMS)
          input.catalog?.freshness?.recordFailure(stream, {
            reason:
              error instanceof EdgeMasterSyncError
                ? error.code
                : "CATALOG_PULL_FAILED",
            cloudReachable: true,
          });
      throw error;
    }
  };

  const tick = (withMasters = true) => {
    if (stopped || inFlight) return;
    const run = (async () => {
      if (withMasters)
        try {
          const counts = await syncEdgeMasters(
            input.config,
            { ...input.options, signal: abort.signal },
            input.database,
          );
          logger.debug({ ...counts }, "Edge master sync applied");
        } catch (error) {
          report(error);
        }
      if (stopped) return;
      try {
        await runCatalog();
      } catch (error) {
        report(error);
      }
    })().finally(() => {
      if (inFlight === run) inFlight = null;
      if (!stopped && wakePending) {
        wakePending = false;
        tick();
      }
    });
    inFlight = run;
  };

  const timer = setInterval(() => tick(), input.intervalMs);
  timer.unref();
  if (input.catalogOnStart === true) tick(false);

  return {
    requestRun() {
      if (stopped || wakeTimer || wakePending) return;
      wakeTimer = setTimeout(() => {
        wakeTimer = null;
        if (stopped) return;
        if (inFlight) wakePending = true;
        else tick();
      }, 30_000);
      wakeTimer.unref();
    },
    async stop() {
      stopped = true;
      abort.abort();
      clearInterval(timer);
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = null;
      wakePending = false;
      if (inFlight) await inFlight;
    },
  };
}

function catalogPath(
  stream: CatalogSyncStream,
  since: string | null,
  protocolVersion: number,
): string {
  const query = new URLSearchParams({
    stream,
    limit: String(CATALOG_SYNC_LIMIT_DEFAULT),
    // Tells the cloud this edge reads the page version. A cloud that predates
    // it rejects the unknown parameter (HTTP 400): see catalog-puller.ts.
    protocolVersion: String(protocolVersion),
  });
  if (since !== null) query.set("since", since);
  return `${EDGE_CATALOG_SYNC_PATH}?${query.toString()}`;
}
