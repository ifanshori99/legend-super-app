// Edge side of the catalog down-sync (bead legend-97p, legend-24318; PRD v1.7
// §3 F8 Master Menu & Harga, §3 F16 Resep & BOM). Pulls
// `GET /api/edge-sync/catalog` stream by stream (shared `CATALOG_SYNC_STREAMS`,
// parents before children), applies each page with `applyCatalogRecords` and
// moves that stream's checkpoint in `edge_pull_checkpoints` (stream key
// `catalog:<stream>`) in the SAME transaction as the apply:
//
// - A failed page (fetch error, bad shape, apply error) leaves the checkpoint
//   where the last applied page put it; the next pull resumes from there.
//   Streams are isolated: the error is caught, recorded in
//   `streams[stream].error` and the next stream still runs.
// - The cursor is `cat2` (`["cat2", "<sync_txid>", ...keys]`). The cloud only
//   sends rows older than every open transaction, so there is no overlap and
//   no rewind: the pull resumes exactly at the checkpoint. A stored cursor of
//   another tag (`cat1`) or a corrupt one counts as no checkpoint (the stream
//   is pulled from the start again; applying is idempotent and never lets an
//   older record over a newer row). That full pull first zeroes the stream's
//   local `sync_txid` stamps (in the first page's transaction): stamps written
//   by local transactions are not comparable with the cloud's.
// - A stream whose rows another stream's rows point at (stations for
//   menu_items and modifiers, inventory_items for recipes) that failed in this
//   pull makes those streams skip the pull (error `CATALOG_PARENT_FAILED`,
//   checkpoint untouched); a reference to a row not local yet is refused as
//   transient (`CATALOG_MISSING_REF`) by the apply anyway.
// - menu_categories: parent links the apply had to write null (parent not local
//   yet) are saved in the same transaction as the page, in the checkpoint row
//   `catalog:menu_categories:parents` (JSON, small), so a restart loses
//   nothing. After the stream was read ONE repair pass (one transaction) sets
//   the parents that now exist and keeps the rest for a later pull.
// - A pull reads at most `maxPages` pages per stream (default 1000). The
//   checkpoint is saved page by page, so a bigger backlog just continues from
//   the last page: the stream reports `backlog: true` and the next pull
//   goes on (no error, no repeated page).
// - A cursor the cloud refuses on the first request of a stream (HTTP 400 or
//   the cursor error): one more pull of that stream from the start.
// - Read only: nothing here writes to the cloud. Errors carry codes, never
//   record data.
import {
  CATALOG_SYNC_STREAMS,
  catalogSyncPageSchema,
  type CatalogSyncStream,
} from "@starter/shared/edge";
import {
  CoreError,
  decodeCursor,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { edgeNodes, edgePullCheckpoints } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";
import { isCatalogSyncCursorError } from "../services/edge-catalog-sync.ts";
import {
  applyCatalogRecords,
  CatalogMissingRefError,
  repairCategoryParents,
  resetCatalogSyncTxid,
  unresolvedCategoryParents,
  type CatalogApplyResult,
  type DeferredCategoryParent,
} from "../services/edge-catalog-apply.ts";
import { EdgeCloudHttpError } from "./cloud-http.ts";

type Database = typeof db;

const DEFAULT_MAX_PAGES = 1_000;
/** The only cursor tag this edge understands (see the header). */
const CATALOG_CURSOR_TAG = "cat2";

/** Pending category parents live in a checkpoint row of their own. */
const PARENTS_CHECKPOINT = "catalog:menu_categories:parents";

/** Streams that must have pulled cleanly before the listed ones run. */
const PARENT_STREAMS: Readonly<
  Partial<Record<CatalogSyncStream, readonly CatalogSyncStream[]>>
> = {
  menu_items: ["stations"],
  modifiers: ["stations"],
  recipes: ["inventory_items"],
};

/** Key of a stream's row in `edge_pull_checkpoints` (varchar(40)). */
export function catalogCheckpointStream(
  stream: CatalogSyncStream,
): `catalog:${CatalogSyncStream}` {
  return `catalog:${stream}`;
}

export type PullCatalogOptions = {
  /** The edge node's own scope (exactly one outlet): where records land. */
  readonly context: ScopedTenantContext;
  /** This node's `edge_nodes.id` (the checkpoint rows belong to it). */
  readonly edgeNodeId: string;
  /**
   * One page of `stream` from the cloud for `since` (null = from the start);
   * the raw JSON body. Throws on any transport or HTTP failure.
   */
  readonly fetchPage: (
    stream: CatalogSyncStream,
    since: string | null,
  ) => Promise<unknown>;
  /** Default: all streams in `CATALOG_SYNC_STREAMS` order. */
  readonly streams?: readonly CatalogSyncStream[];
  /** Pages read per stream in one pull; more is a backlog for the next pull. Default 1000. */
  readonly maxPages?: number;
  readonly now?: () => Date;
  /** Default: the shared pool. Injected by tests that run a second database. */
  readonly database?: Database;
};

/** Why a stream stopped; never carries record data. */
export type CatalogStreamError = {
  /** `CATALOG_MISSING_REF` (transient), a CoreError / `HTTP_nnn` code, or `CATALOG_PULL_FAILED`. */
  readonly code: string;
  readonly message: string;
};

export type CatalogStreamPullResult = Omit<
  CatalogApplyResult,
  "deferredParents"
> & {
  readonly pages: number;
  /** Checkpoint after this stream (null = the cloud had no record yet). */
  readonly watermark: string | null;
  /** menu_categories: parent links set by the repair pass. */
  readonly repairedParents: number;
  /** The cloud had more pages left when `maxPages` was reached. */
  readonly backlog: boolean;
  /** Set when the stream stopped early; its checkpoint is the last applied page. */
  readonly error?: CatalogStreamError;
};

export type PullCatalogResult = {
  readonly streams: Readonly<
    Partial<Record<CatalogSyncStream, CatalogStreamPullResult>>
  >;
  readonly applied: number;
  readonly skipped: number;
  readonly deleted: number;
  readonly nulledRefs: number;
  readonly repairedParents: number;
  readonly pages: number;
  /** Some stream stopped at `maxPages` with pages left: pull again soon. */
  readonly backlog: boolean;
};

function oneOutlet(context: ScopedTenantContext): void {
  if (
    context.outletScope.kind !== "outlets" ||
    context.outletScope.outletIds.length !== 1
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Catalog sync needs a context of exactly one outlet.",
    );
}

/** A cursor of the current tag; anything else (old `cat1`, corrupt) is not one. */
function isCurrentCursor(cursor: string): boolean {
  try {
    return decodeCursor(cursor)[0] === CATALOG_CURSOR_TAG;
  } catch {
    return false;
  }
}

/** No row yet (first boot) or a cursor of another tag is null: pull from the start. */
async function loadCatalogCheckpoint(
  database: Database,
  context: ScopedTenantContext,
  edgeNodeId: string,
  stream: CatalogSyncStream,
): Promise<string | null> {
  const [row] = await withTenant(database, context, (tx) =>
    tx
      .select({ watermark: edgePullCheckpoints.watermark })
      .from(edgePullCheckpoints)
      .where(
        and(
          eq(edgePullCheckpoints.edgeNodeId, edgeNodeId),
          eq(edgePullCheckpoints.stream, catalogCheckpointStream(stream)),
        ),
      )
      .limit(1),
  );
  const watermark = row?.watermark ?? null;
  return watermark !== null && isCurrentCursor(watermark) ? watermark : null;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Upsert inside the apply transaction; the node row must exist. */
async function saveCheckpointRow(
  tx: Tx,
  edgeNodeId: string,
  stream: typeof edgePullCheckpoints.$inferInsert.stream,
  watermark: string | null,
  succeededAt: Date,
): Promise<void> {
  const [node] = await tx
    .select({ tenantId: edgeNodes.tenantId, outletId: edgeNodes.outletId })
    .from(edgeNodes)
    .where(eq(edgeNodes.id, edgeNodeId))
    .limit(1);
  if (!node) throw new Error("Edge node not found for checkpoint");
  await tx
    .insert(edgePullCheckpoints)
    .values({
      tenantId: node.tenantId,
      outletId: node.outletId,
      edgeNodeId,
      stream,
      watermark,
      lastSuccessAt: succeededAt,
    })
    .onConflictDoUpdate({
      target: [
        edgePullCheckpoints.tenantId,
        edgePullCheckpoints.edgeNodeId,
        edgePullCheckpoints.stream,
      ],
      set: { watermark, lastSuccessAt: succeededAt, updatedAt: new Date() },
    });
}

function saveCatalogCheckpoint(
  tx: Tx,
  edgeNodeId: string,
  stream: CatalogSyncStream,
  watermark: string | null,
  succeededAt: Date,
): Promise<void> {
  return saveCheckpointRow(
    tx,
    edgeNodeId,
    catalogCheckpointStream(stream),
    watermark,
    succeededAt,
  );
}

/** Pending category parents (JSON in the watermark); unreadable = none. */
async function loadPendingParents(
  tx: Tx,
  edgeNodeId: string,
): Promise<DeferredCategoryParent[]> {
  const [row] = await tx
    .select({ watermark: edgePullCheckpoints.watermark })
    .from(edgePullCheckpoints)
    .where(
      and(
        eq(edgePullCheckpoints.edgeNodeId, edgeNodeId),
        eq(edgePullCheckpoints.stream, PARENTS_CHECKPOINT),
      ),
    )
    .limit(1);
  if (!row?.watermark) return [];
  try {
    const raw: unknown = JSON.parse(row.watermark);
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry: unknown) => {
      if (!Array.isArray(entry)) return [];
      const [id, parentId, syncTxid] = entry as unknown[];
      return typeof id === "string" &&
        typeof parentId === "string" &&
        typeof syncTxid === "string" &&
        /^\d+$/.test(syncTxid)
        ? [{ id, parentId, syncTxid }]
        : [];
    });
  } catch {
    return [];
  }
}

function savePendingParents(
  tx: Tx,
  edgeNodeId: string,
  pairs: readonly DeferredCategoryParent[],
  at: Date,
): Promise<void> {
  return saveCheckpointRow(
    tx,
    edgeNodeId,
    PARENTS_CHECKPOINT,
    pairs.length === 0
      ? null
      : JSON.stringify(pairs.map((p) => [p.id, p.parentId, p.syncTxid])),
    at,
  );
}

/** The cloud no longer understands the stored cursor (HTTP 400 / cursor error). */
function isRejectedCursor(error: unknown): boolean {
  return (
    isCatalogSyncCursorError(error) ||
    (error instanceof EdgeCloudHttpError && error.code === "HTTP_400")
  );
}

type StreamProgress = {
  applied: number;
  skipped: number;
  deleted: number;
  nulledRefs: number;
  repairedParents: number;
  pages: number;
  watermark: string | null;
  backlog: boolean;
};

async function pullStream(
  options: PullCatalogOptions,
  stream: CatalogSyncStream,
  stored: string | null,
  progress: StreamProgress,
): Promise<void> {
  const database = options.database ?? db;
  const now = options.now ?? (() => new Date());
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const tenantId = options.context.tenant.tenantId;

  // No overlap: the cloud only sends committed-safe rows, resume exactly here.
  let since: string | null = stored;
  let watermark = stored;
  progress.watermark = stored;
  let first = true;

  for (;;) {
    if (progress.pages >= maxPages) {
      // The checkpoint is saved page by page: the next pull goes on from it.
      progress.backlog = true;
      break;
    }
    let raw: unknown;
    try {
      raw = await options.fetchPage(stream, since);
    } catch (error) {
      if (first && since !== null && isRejectedCursor(error)) {
        // Applying is idempotent: start this stream over once.
        since = null;
        watermark = null;
        first = false;
        continue;
      }
      throw error;
    }
    first = false;
    // safeParse: no parser detail travels in the error.
    const parsed = catalogSyncPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Catalog page has an unknown shape");
    const page = parsed.data;
    if (page.stream !== stream)
      throw new Error("Catalog page is of another stream");
    progress.pages += 1;

    if (page.records.length > 0 && page.nextCursor !== null)
      watermark = page.nextCursor;
    const succeededAt = now();
    const checkpoint = watermark;
    // Apply and checkpoint together: both land, or neither does.
    const result = await withTenant(database, options.context, async (tx) => {
      // A full pull (no checkpoint): local stamps are not the cloud's, so they
      // are zeroed first and every cloud record wins (same commit as the page).
      if (since === null) await resetCatalogSyncTxid(tx, tenantId, stream);
      const outcome = await applyCatalogRecords(tx, {
        tenantId,
        stream,
        records: page.records,
      });
      // Parent links written null go to the durable list in the same commit.
      if (stream === "menu_categories" && outcome.deferredParents.length > 0) {
        const kept = (await loadPendingParents(tx, options.edgeNodeId)).filter(
          (pair) =>
            !outcome.deferredParents.some((fresh) => fresh.id === pair.id),
        );
        await savePendingParents(
          tx,
          options.edgeNodeId,
          [...kept, ...outcome.deferredParents],
          succeededAt,
        );
      }
      await saveCatalogCheckpoint(
        tx,
        options.edgeNodeId,
        stream,
        checkpoint,
        succeededAt,
      );
      return outcome;
    });
    // The page is committed: only now does the stream's progress move.
    progress.watermark = checkpoint;
    progress.applied += result.applied;
    progress.skipped += result.skipped;
    progress.deleted += result.deleted;
    progress.nulledRefs += result.nulledRefs;

    if (!page.hasMore) break;
    if (page.nextCursor === null || page.nextCursor === since)
      throw new CoreError(
        "CONFLICT",
        "Cursor sinkronisasi katalog tidak maju.",
      );
    since = page.nextCursor;
  }

  // One repair pass per pull, after the stream was read: parents that arrived
  // since (this pull or an earlier one, also before a restart) are set.
  if (stream === "menu_categories")
    progress.repairedParents = await withTenant(
      database,
      options.context,
      async (tx) => {
        const pending = await loadPendingParents(tx, options.edgeNodeId);
        if (pending.length === 0) return 0;
        const repaired = await repairCategoryParents(tx, {
          tenantId,
          pairs: pending,
        });
        const remaining = await unresolvedCategoryParents(tx, {
          tenantId,
          pairs: pending,
        });
        if (remaining.length !== pending.length)
          await savePendingParents(tx, options.edgeNodeId, remaining, now());
        return repaired;
      },
    );
}

/** The stream this one depends on failed in the same pull. */
class CatalogParentFailedError extends Error {
  readonly code = "CATALOG_PARENT_FAILED";

  constructor(parent: CatalogSyncStream) {
    super(`Catalog stream skipped: ${parent} failed in this pull.`);
    this.name = "CatalogParentFailedError";
  }
}

/** Code and message that are safe to report: no record data, no SQL detail. */
function describeError(error: unknown): CatalogStreamError {
  if (
    error instanceof CatalogMissingRefError ||
    error instanceof CatalogParentFailedError ||
    error instanceof CoreError ||
    error instanceof EdgeCloudHttpError
  )
    return { code: error.code, message: error.message };
  return {
    code: "CATALOG_PULL_FAILED",
    message: "Catalog stream could not be pulled.",
  };
}

/**
 * One full catalog pull: every stream in turn from its own checkpoint. A stream
 * that fails (connection lost, bad page, missing reference, apply error) stops
 * there with its checkpoint at the last applied page and `error` set on its
 * result; the other streams still run. Only a bad context throws.
 */
export async function pullCatalog(
  options: PullCatalogOptions,
): Promise<PullCatalogResult> {
  oneOutlet(options.context);
  const database = options.database ?? db;
  const streams = options.streams ?? CATALOG_SYNC_STREAMS;
  const results: Partial<Record<CatalogSyncStream, CatalogStreamPullResult>> =
    {};
  const total = {
    applied: 0,
    skipped: 0,
    deleted: 0,
    nulledRefs: 0,
    repairedParents: 0,
    pages: 0,
    backlog: false,
  };
  const failed = new Set<CatalogSyncStream>();
  for (const stream of streams) {
    const progress: StreamProgress = {
      applied: 0,
      skipped: 0,
      deleted: 0,
      nulledRefs: 0,
      repairedParents: 0,
      pages: 0,
      watermark: null,
      backlog: false,
    };
    let error: CatalogStreamError | undefined;
    const blockedBy = (PARENT_STREAMS[stream] ?? []).find((parent) =>
      failed.has(parent),
    );
    try {
      if (blockedBy !== undefined)
        throw new CatalogParentFailedError(blockedBy);
      const stored = await loadCatalogCheckpoint(
        database,
        options.context,
        options.edgeNodeId,
        stream,
      );
      await pullStream(options, stream, stored, progress);
    } catch (caught) {
      error = describeError(caught);
    }
    if (error) failed.add(stream);
    results[stream] = error ? { ...progress, error } : { ...progress };
    total.applied += progress.applied;
    total.skipped += progress.skipped;
    total.deleted += progress.deleted;
    total.nulledRefs += progress.nulledRefs;
    total.repairedParents += progress.repairedParents;
    total.pages += progress.pages;
    total.backlog = total.backlog || progress.backlog;
  }
  return { streams: results, ...total };
}
