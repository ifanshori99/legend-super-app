// Edge side of the catalog down-sync (bead legend-97p; PRD v1.7 §3 F8 Master
// Menu & Harga, §3 F16 Resep & BOM). Pulls `GET /api/edge-sync/catalog` stream
// by stream (shared `CATALOG_SYNC_STREAMS`, parents before children), applies
// each page with `applyCatalogRecords` and moves that stream's checkpoint in
// `edge_pull_checkpoints` (stream key `catalog:<stream>`) in the SAME
// transaction as the apply:
//
// - A failed page (fetch error, bad shape, apply error) leaves the checkpoint
//   where the last applied page put it; the next pull resumes from there.
//   Streams are isolated: the error is caught, recorded in
//   `streams[stream].error` and the next stream still runs.
// - menu_categories: parent links the apply had to write null (parent not local
//   yet) are collected in memory; after the stream was read in full ONE repair
//   pass (one transaction) sets them where the parent now exists.
// - The pull starts `CATALOG_SYNC_OVERLAP_MS` before the stored checkpoint
//   (commit lag behind `updated_at`); apply is idempotent and never lets an
//   older record over a newer row.
// - A cursor the cloud refuses on the first request of a stream (HTTP 400 or
//   the cursor error): one more pull of that stream from the start.
// - Read only: nothing here writes to the cloud. Errors carry codes, never
//   record data.
import {
  CATALOG_SYNC_STREAMS,
  catalogSyncPageSchema,
  type CatalogSyncStream,
} from "@starter/shared/edge";
import { CoreError, type ScopedTenantContext } from "@starter/shared/core";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { edgeNodes, edgePullCheckpoints } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";
import {
  CATALOG_SYNC_OVERLAP_MS,
  isCatalogSyncCursorError,
  rewindCatalogCursor,
} from "../services/edge-catalog-sync.ts";
import {
  applyCatalogRecords,
  CatalogMissingRefError,
  repairCategoryParents,
  type CatalogApplyResult,
  type DeferredCategoryParent,
} from "../services/edge-catalog-apply.ts";
import { EdgeCloudHttpError } from "./cloud-http.ts";

type Database = typeof db;

const DEFAULT_MAX_PAGES = 1_000;

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
  /** Safety stop per stream against a misbehaving cloud; default 1000. */
  readonly maxPages?: number;
  /** Default `CATALOG_SYNC_OVERLAP_MS`; 0 = resume exactly at the checkpoint. */
  readonly overlapMs?: number;
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

/** No row yet (first boot) is null. */
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
  return row?.watermark ?? null;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Upsert inside the apply transaction; the node row must exist. */
async function saveCatalogCheckpoint(
  tx: Tx,
  edgeNodeId: string,
  stream: CatalogSyncStream,
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
      stream: catalogCheckpointStream(stream),
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
  const overlapMs = options.overlapMs ?? CATALOG_SYNC_OVERLAP_MS;
  const tenantId = options.context.tenant.tenantId;

  let since: string | null = stored;
  if (stored !== null && overlapMs > 0) {
    try {
      since = rewindCatalogCursor(stream, stored, overlapMs);
    } catch (error) {
      // A corrupt stored cursor: start this stream over (idempotent).
      if (!isCatalogSyncCursorError(error)) throw error;
      since = null;
    }
  }
  let watermark = stored;
  progress.watermark = stored;
  const deferredParents: DeferredCategoryParent[] = [];
  let first = true;

  for (;;) {
    if (progress.pages >= maxPages)
      throw new CoreError(
        "CONFLICT",
        "Sinkronisasi katalog melebihi batas halaman.",
      );
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
      const outcome = await applyCatalogRecords(tx, {
        tenantId,
        stream,
        records: page.records,
      });
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
    deferredParents.push(...result.deferredParents);

    if (!page.hasMore) break;
    if (page.nextCursor === null || page.nextCursor === since)
      throw new CoreError(
        "CONFLICT",
        "Cursor sinkronisasi katalog tidak maju.",
      );
    since = page.nextCursor;
  }

  // One repair pass per pull, after every page of the stream was read.
  if (stream === "menu_categories" && deferredParents.length > 0)
    progress.repairedParents = await withTenant(
      database,
      options.context,
      (tx) => repairCategoryParents(tx, { tenantId, pairs: deferredParents }),
    );
}

/** Code and message that are safe to report: no record data, no SQL detail. */
function describeError(error: unknown): CatalogStreamError {
  if (
    error instanceof CatalogMissingRefError ||
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
  };
  for (const stream of streams) {
    const progress: StreamProgress = {
      applied: 0,
      skipped: 0,
      deleted: 0,
      nulledRefs: 0,
      repairedParents: 0,
      pages: 0,
      watermark: null,
    };
    let error: CatalogStreamError | undefined;
    try {
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
    results[stream] = error ? { ...progress, error } : { ...progress };
    total.applied += progress.applied;
    total.skipped += progress.skipped;
    total.deleted += progress.deleted;
    total.nulledRefs += progress.nulledRefs;
    total.repairedParents += progress.repairedParents;
    total.pages += progress.pages;
  }
  return { streams: results, ...total };
}
