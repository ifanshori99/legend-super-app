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
//   older record over a newer row). Before the first HTTP or event apply, local
//   `sync_txid` stamps are normalized once: local transaction ids are not
//   comparable with the cloud's. A separate durable initialization marker
//   prevents an initial pull from zeroing newer event stamps; held receipts
//   also protect event-backed documents in normal operation.
// - A rewind (the cloud refused the cursor, or the watermark is the operator's
//   `CATALOG_REWIND_MARK`) means the cloud history was restored (legend-7r7q6):
//   in the first page's transaction the node's receipt floor is raised, so
//   receipts from before the rewind stop protecting rows (catalog-receipt-floor.ts),
//   and a durable `catalog:replay:<stream>` marker is set. On the replay's last
//   page the marker pins the cloud's snapshot horizon; a later last page that
//   reports every row up to it visible deactivates the rows the snapshot did
//   not touch (never deleted) in the same transaction and clears the marker.
//   A replay cut at maxPages, or a cloud without the snapshot fields, keeps the
//   marker. A stored `CATALOG_REWIND_MARK` survives a pull that was running
//   when the operator set it.
// - A stream whose rows another stream's rows point at (stations for
//   menu_items and modifiers, inventory_items for recipes, recipes for
//   menu_items and item_variants; modifiers have no recipe key on the edge)
//   that failed in this pull makes those streams skip the pull (error `CATALOG_PARENT_FAILED`,
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
// - A cursor the cloud refuses on the first request of a stream (the cursor
//   error, or HTTP 400 with the `X-Edge-Error: CATALOG_CURSOR_REJECTED` marker,
//   legend-75kly): one more pull of that stream from the start. A 400 without
//   the marker never resets; it is probed once (see pullStream).
// - Read only: nothing here writes to the cloud. Errors carry codes, never
//   record data.
// - Promotions/vouchers fail closed while a pull is incomplete. Their cursor
//   still advances page by page, but freshness is invalidated durably with
//   the first page that has more to come and only restored after a complete
//   stream (including empty), and also when a fetched page is rejected. A
//   transport failure before any page arrives (offline) leaves the last success
//   time alone: uncapped promos live to the 24 h limit.
import {
  CATALOG_PROTOCOL_MIN_VERSION,
  CATALOG_PROTOCOL_VERSION,
  CATALOG_SYNC_STREAMS,
  catalogSyncPageSchema,
  isCatalogTaxStream,
  type CatalogSyncStream,
} from "@starter/shared/edge";
import {
  CoreError,
  decodeCursor,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { edgeNodes, edgePullCheckpoints } from "../db/schema/edge-node.ts";
import { withTenant } from "../db/tenant.ts";
import { deactivateAbsentCatalogRows } from "../services/edge-catalog-restore-membership.ts";
import { isCatalogSyncCursorError } from "../services/edge-catalog-sync.ts";
import {
  applyCatalogRecords,
  CatalogMissingRefError,
  enrichCatalogStationFields,
  filterCatalogRecordsAfterEvents,
  lockCatalogStream,
  repairCategoryParents,
  repairPrinterFallbacks,
  resetCatalogSyncTxid,
  unresolvedCategoryParents,
  unresolvedPrinterFallbacks,
  type CatalogApplyResult,
  type DeferredCategoryParent,
} from "../services/edge-catalog-apply.ts";
import { logger } from "../lib/logger.ts";
import { CATALOG_CURSOR_REJECTED_MARKER } from "./catalog-cursor-marker.ts";
import {
  CATALOG_RECEIPT_FLOOR_CHECKPOINT,
  catalogReceiptFloorValue,
} from "./catalog-receipt-floor.ts";
import { EdgeCloudHttpError } from "./cloud-http.ts";
import {
  completePromoCatalogStream,
  markPromoCatalogStreamPending,
} from "./promo-gate.ts";

type Database = typeof db;

const DEFAULT_MAX_PAGES = 1_000;
/** The only cursor tag this edge understands (see the header). */
const CATALOG_CURSOR_TAG = "cat2";

/** Local catalog shape, independent of the backwards-compatible wire protocol. */
export const CATALOG_SCHEMA_REVISION = 1;
const SCHEMA_REVISION_CHECKPOINT = "catalog:schema-revision";
const SCHEMA_PENDING_CHECKPOINT = "catalog:schema-pending";

/** Pending category parents live in a checkpoint row of their own. */
const PARENTS_CHECKPOINT = "catalog:menu_categories:parents";

/** Pending printers fallback links (same format) live in a row of their own. */
const FALLBACKS_CHECKPOINT = "catalog:printers:fallbacks";

type PendingCheckpoint =
  typeof PARENTS_CHECKPOINT | typeof FALLBACKS_CHECKPOINT;

/** Streams that must have pulled cleanly before the listed ones run. */
const PARENT_STREAMS: Readonly<
  Partial<Record<CatalogSyncStream, readonly CatalogSyncStream[]>>
> = {
  menu_items: ["stations", "recipes"],
  modifiers: ["stations"],
  item_variants: ["recipes"],
  recipes: ["inventory_items"],
  vouchers: ["promotions"],
  tables: ["floor_zones"],
  payment_cashier_defaults: ["payment_edc_terminals"],
  kitchen_capacity_rules: ["stations"],
  kitchen_menu_loads: ["menu_items", "item_variants"],
  item_availability: ["menu_items"],
};

const PROMO_INVALIDATED_AT = new Date(0);
const isPromoStream = (stream: CatalogSyncStream): boolean =>
  stream === "promotions" || stream === "vouchers";

/**
 * Half of a discount or tax stream is not a success: until its last page is
 * applied the checkpoint carries the epoch (legend-osqou.22 for tax, where a
 * restart on half a rule set would charge the wrong tax).
 */
const countsWhenWhole = (stream: CatalogSyncStream): boolean =>
  isPromoStream(stream) || isCatalogTaxStream(stream);

/**
 * Watermark an operator sets on `catalog:<stream>` to rewind that stream after
 * a cloud restore (docs/deployment.md). It is not a cursor, so the stream is
 * pulled from the start, and unlike a cleared watermark it also lifts the
 * protection of link receipts from before the rewind (see catalog-receipt-floor.ts).
 */
export const CATALOG_REWIND_MARK = "rewind";

/** Durable "full replay pending" marker of a rewound stream (legend-7r7q6). */
function catalogReplayCheckpoint(
  stream: CatalogSyncStream,
): `catalog:replay:${CatalogSyncStream}` {
  return `catalog:replay:${stream}`;
}

/** Replay marker row of the promotions stream (read by the promo gate). */
export const CATALOG_PROMO_REPLAY_STREAM =
  catalogReplayCheckpoint("promotions");

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
  "deferredParents" | "deferredFallbacks"
> & {
  readonly pages: number;
  /** Checkpoint after this stream (null = the cloud had no record yet). */
  readonly watermark: string | null;
  /** menu_categories: parent links set by the repair pass. */
  readonly repairedParents: number;
  /** The cloud had more pages left when `maxPages` was reached. */
  readonly backlog: boolean;
  /**
   * When the last page of this pull was stored (the checkpoint's
   * `last_success_at`); null when no page was stored, or when a discount or
   * tax stream has only stored partial pages.
   */
  readonly lastSuccessAt: Date | null;
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

/**
 * No row yet (first boot) or a cursor of another tag gives a null cursor: pull
 * from the start. `unfinished` is true when the row was closed by an earlier
 * promo sync that did not reach its end (epoch success time) or carries the
 * operator's rewind mark.
 */
async function loadCatalogCheckpoint(
  database: Database,
  context: ScopedTenantContext,
  edgeNodeId: string,
  stream: CatalogSyncStream,
): Promise<{ cursor: string | null; unfinished: boolean }> {
  const [row] = await withTenant(database, context, (tx) =>
    tx
      .select({
        watermark: edgePullCheckpoints.watermark,
        lastSuccessAt: edgePullCheckpoints.lastSuccessAt,
      })
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
  return {
    cursor: watermark !== null && isCurrentCursor(watermark) ? watermark : null,
    unfinished:
      isPromoStream(stream) &&
      row !== undefined &&
      // legend-1212: a rewound promo stream is unfinished too, so a pull that
      // fails on transport keeps the pending mark (fail closed).
      (row.watermark === CATALOG_REWIND_MARK ||
        row.lastSuccessAt.getTime() === PROMO_INVALIDATED_AT.getTime()),
  };
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A well-formed `cat2` cursor: its sync txid and keys; anything else is null. */
function parseCatalogMark(
  cursor: string | null,
): { txid: bigint; keys: string[] } | null {
  if (cursor === null) return null;
  try {
    const [tag, txid, ...keys] = decodeCursor(cursor);
    if (
      tag !== CATALOG_CURSOR_TAG ||
      typeof txid !== "string" ||
      !/^\d{1,19}$/.test(txid) ||
      !keys.every((key) => typeof key === "string")
    )
      return null;
    return {
      txid: BigInt(txid),
      keys: keys.map((key) => String(key).toLowerCase()),
    };
  } catch {
    return null;
  }
}

/**
 * True when `next` would move a stored `cat2` cursor BACK: `(txid, keys)` of
 * `next` is below the stored one (or `next` is no cursor at all). Equal is not
 * older. A stored cursor that is not a well-formed `cat2` never blocks.
 */
function isOlderCatalogCursor(next: string | null, stored: string | null) {
  const current = parseCatalogMark(stored);
  if (current === null) return false;
  const mark = parseCatalogMark(next);
  if (mark === null) return true;
  if (mark.txid !== current.txid) return mark.txid < current.txid;
  const length = Math.min(mark.keys.length, current.keys.length);
  for (let i = 0; i < length; i += 1) {
    if (mark.keys[i] !== current.keys[i]) return mark.keys[i] < current.keys[i];
  }
  return false;
}

/**
 * Upsert inside the apply transaction; the node row must exist. `monotonic`
 * (catalog cursors only) keeps a stored cursor that is already ahead: a late
 * pull then only touches `last_success_at`. The write is also guarded in SQL
 * (`setWhere`) by the value it was decided against. `rewindFrom` is the cursor
 * the cloud refused: while the stored value still equals it, the restart's
 * first page may lower the checkpoint (a legitimate rewind).
 */
async function saveCheckpointRow(
  tx: Tx,
  edgeNodeId: string,
  stream: typeof edgePullCheckpoints.$inferInsert.stream,
  watermark: string | null,
  succeededAt: Date,
  monotonic = false,
  rewindFrom: string | null = null,
): Promise<void> {
  const [node] = await tx
    .select({ tenantId: edgeNodes.tenantId, outletId: edgeNodes.outletId })
    .from(edgeNodes)
    .where(eq(edgeNodes.id, edgeNodeId))
    .limit(1);
  if (!node) throw new Error("Edge node not found for checkpoint");
  let stored: string | null = null;
  if (monotonic) {
    const [row] = await tx
      .select({ watermark: edgePullCheckpoints.watermark })
      .from(edgePullCheckpoints)
      .where(
        and(
          eq(edgePullCheckpoints.edgeNodeId, edgeNodeId),
          eq(edgePullCheckpoints.stream, stream),
        ),
      )
      .limit(1);
    stored = row?.watermark ?? null;
  }
  const rewinding = rewindFrom !== null && stored === rewindFrom;
  // The operator's rewind mark set while a pull was running: this pull's later
  // pages must not overwrite it with their cursor (the next pull rewinds).
  const keepsRewindMark =
    monotonic && !rewinding && stored === CATALOG_REWIND_MARK;
  const stale =
    monotonic && !rewinding && isOlderCatalogCursor(watermark, stored);
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
      set: keepsRewindMark
        ? { updatedAt: new Date() }
        : stale
          ? { lastSuccessAt: succeededAt, updatedAt: new Date() }
          : { watermark, lastSuccessAt: succeededAt, updatedAt: new Date() },
      ...(monotonic
        ? {
            setWhere: sql`${edgePullCheckpoints.watermark} is not distinct from ${stored}::text`,
          }
        : {}),
    });
}

function saveCatalogCheckpoint(
  tx: Tx,
  edgeNodeId: string,
  stream: CatalogSyncStream,
  watermark: string | null,
  succeededAt: Date,
  rewindFrom: string | null = null,
): Promise<void> {
  return saveCheckpointRow(
    tx,
    edgeNodeId,
    catalogCheckpointStream(stream),
    watermark,
    succeededAt,
    true,
    rewindFrom,
  );
}

async function lockCatalogSchemaRevision(
  tx: Tx,
  options: PullCatalogOptions,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`edge-catalog-schema:${options.context.tenant.tenantId}:${options.edgeNodeId}`.toLowerCase()}, 0))`,
  );
}

async function loadCatalogSchemaRevision(
  tx: Tx,
  edgeNodeId: string,
  stream: typeof SCHEMA_REVISION_CHECKPOINT | typeof SCHEMA_PENDING_CHECKPOINT,
): Promise<number> {
  const [row] = await tx
    .select({ watermark: edgePullCheckpoints.watermark })
    .from(edgePullCheckpoints)
    .where(
      and(
        eq(edgePullCheckpoints.edgeNodeId, edgeNodeId),
        eq(edgePullCheckpoints.stream, stream),
      ),
    )
    .limit(1);
  const value = row?.watermark;
  if (value === undefined || value === null || !/^\d+$/.test(value)) return 0;
  const revision = Number(value);
  return Number.isSafeInteger(revision) ? revision : 0;
}

/**
 * Reset just the HTTP cursors once per upgrade. The pending marker and resets
 * commit together, so retries and restarts continue their already-applied pages.
 * Initialization, deferred references and held event receipts remain intact.
 */
async function prepareCatalogSchemaRevision(
  options: PullCatalogOptions,
): Promise<boolean> {
  return withTenant(options.database ?? db, options.context, async (tx) => {
    await lockCatalogSchemaRevision(tx, options);
    const applied = await loadCatalogSchemaRevision(
      tx,
      options.edgeNodeId,
      SCHEMA_REVISION_CHECKPOINT,
    );
    if (applied >= CATALOG_SCHEMA_REVISION) return false;
    const pending = await loadCatalogSchemaRevision(
      tx,
      options.edgeNodeId,
      SCHEMA_PENDING_CHECKPOINT,
    );
    if (pending > CATALOG_SCHEMA_REVISION) return false;
    if (pending === CATALOG_SCHEMA_REVISION) return true;
    const now = (options.now ?? (() => new Date()))();
    for (const stream of CATALOG_SYNC_STREAMS) {
      await lockCatalogStream(tx, options.context.tenant.tenantId, stream);
      if (isPromoStream(stream))
        markPromoCatalogStreamPending(catalogCheckpointStream(stream));
      // A stream that has never committed a page must still have no cursor
      // row if its first fetch/apply fails. Only rewind existing checkpoints.
      await tx
        .update(edgePullCheckpoints)
        .set({
          watermark: null,
          lastSuccessAt: PROMO_INVALIDATED_AT,
          updatedAt: now,
        })
        .where(
          and(
            eq(edgePullCheckpoints.edgeNodeId, options.edgeNodeId),
            eq(edgePullCheckpoints.stream, catalogCheckpointStream(stream)),
          ),
        );
    }
    await saveCheckpointRow(
      tx,
      options.edgeNodeId,
      SCHEMA_PENDING_CHECKPOINT,
      String(CATALOG_SCHEMA_REVISION),
      now,
    );
    return true;
  });
}

/** Certify only a complete canonical pull, never a subset, failed page or backlog. */
async function completeCatalogSchemaRevision(
  options: PullCatalogOptions,
): Promise<void> {
  await withTenant(options.database ?? db, options.context, async (tx) => {
    await lockCatalogSchemaRevision(tx, options);
    const applied = await loadCatalogSchemaRevision(
      tx,
      options.edgeNodeId,
      SCHEMA_REVISION_CHECKPOINT,
    );
    const pending = await loadCatalogSchemaRevision(
      tx,
      options.edgeNodeId,
      SCHEMA_PENDING_CHECKPOINT,
    );
    if (
      applied >= CATALOG_SCHEMA_REVISION ||
      pending !== CATALOG_SCHEMA_REVISION
    )
      return;
    await saveCheckpointRow(
      tx,
      options.edgeNodeId,
      SCHEMA_REVISION_CHECKPOINT,
      String(CATALOG_SCHEMA_REVISION),
      (options.now ?? (() => new Date()))(),
    );
    await tx
      .delete(edgePullCheckpoints)
      .where(
        and(
          eq(edgePullCheckpoints.edgeNodeId, options.edgeNodeId),
          eq(edgePullCheckpoints.stream, SCHEMA_PENDING_CHECKPOINT),
        ),
      );
  });
}

/**
 * Normalize local bootstrap stamps once, before either receive path writes
 * cloud versions. Kept separate from the HTTP cursor (including an empty
 * cursor) and freshness. Receipt guards separately protect event-backed
 * documents during an HTTP restore/rewind.
 */
export async function ensureCatalogStreamInitialized(
  tx: Tx,
  input: {
    readonly tenantId: TenantId;
    readonly edgeNodeId: string;
    readonly stream: CatalogSyncStream;
    readonly at: Date;
  },
): Promise<void> {
  const { tenantId, edgeNodeId, stream, at } = input;
  await lockCatalogStream(tx, tenantId, stream);
  const marker = `catalog:init:${stream}` as const;
  const [initialized] = await tx
    .select({ watermark: edgePullCheckpoints.watermark })
    .from(edgePullCheckpoints)
    .where(
      and(
        eq(edgePullCheckpoints.edgeNodeId, edgeNodeId),
        eq(edgePullCheckpoints.stream, marker),
      ),
    )
    .limit(1);
  if (initialized) return;
  const [existing] = await tx
    .select({ watermark: edgePullCheckpoints.watermark })
    .from(edgePullCheckpoints)
    .where(
      and(
        eq(edgePullCheckpoints.edgeNodeId, edgeNodeId),
        eq(edgePullCheckpoints.stream, catalogCheckpointStream(stream)),
      ),
    )
    .limit(1);
  // An upgraded edge with a valid cloud checkpoint already holds cloud stamps.
  if (parseCatalogMark(existing?.watermark ?? null) === null)
    await resetCatalogSyncTxid(tx, tenantId, stream, edgeNodeId);
  await saveCheckpointRow(tx, edgeNodeId, marker, "1", at);
}

/**
 * Raises the node's receipt floor to now (monotonic): receipts received so far
 * stop protecting catalog rows. The ISO text keeps microsecond precision.
 */
async function raiseCatalogReceiptFloor(
  tx: Tx,
  edgeNodeId: string,
  at: Date,
): Promise<void> {
  const result = await tx.execute(
    sql`SELECT to_char(GREATEST(clock_timestamp(), COALESCE(${catalogReceiptFloorValue(edgeNodeId)}, '-infinity'::timestamptz)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS floor`,
  );
  await saveCheckpointRow(
    tx,
    edgeNodeId,
    CATALOG_RECEIPT_FLOOR_CHECKPOINT,
    String(result.rows[0]?.floor),
    at,
  );
}

/** Pending category parents / printer fallbacks (JSON in the watermark); unreadable = none. */
export async function loadPendingParents(
  tx: Tx,
  edgeNodeId: string,
  checkpoint: PendingCheckpoint = PARENTS_CHECKPOINT,
): Promise<DeferredCategoryParent[]> {
  const [row] = await tx
    .select({ watermark: edgePullCheckpoints.watermark })
    .from(edgePullCheckpoints)
    .where(
      and(
        eq(edgePullCheckpoints.edgeNodeId, edgeNodeId),
        eq(edgePullCheckpoints.stream, checkpoint),
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

export function savePendingParents(
  tx: Tx,
  edgeNodeId: string,
  pairs: readonly DeferredCategoryParent[],
  at: Date,
  checkpoint: PendingCheckpoint = PARENTS_CHECKPOINT,
): Promise<void> {
  return saveCheckpointRow(
    tx,
    edgeNodeId,
    checkpoint,
    pairs.length === 0
      ? null
      : JSON.stringify(pairs.map((p) => [p.id, p.parentId, p.syncTxid])),
    at,
  );
}

/**
 * The cloud refused the stored cursor: the cursor error itself, or an HTTP 400
 * carrying the cloud's marker (legend-75kly). A 400 without the marker is
 * ambiguous and must not reset the checkpoint.
 */
function isRejectedCursor(error: unknown): boolean {
  return (
    isCatalogSyncCursorError(error) ||
    (error instanceof EdgeCloudHttpError &&
      error.code === "HTTP_400" &&
      error.reason === CATALOG_CURSOR_REJECTED_MARKER)
  );
}

/** True when a record of the raw page has no `syncTxid` (shape is checked later). */
function isPageWithoutSyncTxid(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const records = (raw as { records?: unknown }).records;
  return (
    Array.isArray(records) &&
    records.some(
      (record: unknown) =>
        typeof record === "object" &&
        record !== null &&
        !("syncTxid" in record),
    )
  );
}

/**
 * Refuses a page whose explicit `protocolVersion` is missing or older than the
 * minimum (cloud too old: CATALOG_CLOUD_OUTDATED), or newer than this edge
 * understands (edge too old: CATALOG_EDGE_OUTDATED). A non-object is left to
 * the shape check.
 */
function assertProtocolVersion(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const version = (raw as { protocolVersion?: unknown }).protocolVersion;
  if (
    typeof version !== "number" ||
    !Number.isFinite(version) ||
    version < CATALOG_PROTOCOL_MIN_VERSION
  )
    throw new CatalogCloudOutdatedError();
  if (version > CATALOG_PROTOCOL_VERSION) throw new CatalogEdgeOutdatedError();
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
  lastSuccessAt: Date | null;
  /**
   * The promotions stream ended its last page while a replay marker still
   * exists (legend-1199 P2-B): the deactivation is not committed yet, so the
   * discount stays closed.
   */
  replayOpen?: boolean;
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
  // Set when the cloud refused the stored cursor and this pull restarted: the
  // first commit of the restart may lower the checkpoint (see saveCheckpointRow).
  let rejectedCursor: string | null = null;

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
        rejectedCursor = since;
        since = null;
        watermark = null;
        first = false;
        continue;
      }
      // No cursor to blame and the cloud still answers 400: the request has
      // only valid parameters except `protocolVersion`, which a cloud older
      // than the version field rejects (strict query).
      if (
        since === null &&
        error instanceof EdgeCloudHttpError &&
        error.code === "HTTP_400"
      )
        throw new CatalogCloudOutdatedError();
      // legend-75kly: a 400 without the cursor marker is ambiguous (an old
      // cloud refusing `protocolVersion`, or any other 400). Never reset the
      // checkpoint on it. Probe once from the start and discard the result:
      // a 400 there too means an outdated cloud; a clean page means the
      // cursor was not the problem, so the original error stands.
      if (
        since !== null &&
        error instanceof EdgeCloudHttpError &&
        error.code === "HTTP_400"
      ) {
        try {
          await options.fetchPage(stream, null);
        } catch (probe) {
          if (probe instanceof EdgeCloudHttpError && probe.code === "HTTP_400")
            throw new CatalogCloudOutdatedError();
          throw probe;
        }
      }
      throw error;
    }
    first = false;
    // Protocol version first, before the page is parsed and before any
    // checkpoint moves: an empty page of an old cloud must not pass either.
    assertProtocolVersion(raw);
    // A cloud that labels its page with a version but still sends records
    // without `syncTxid` (legend-dciax): refuse with a clear reason instead of
    // "unknown shape". Still reachable, so it stays.
    if (isPageWithoutSyncTxid(raw)) throw new CatalogCloudOutdatedError();
    // safeParse: no parser detail travels in the error.
    const parsed = catalogSyncPageSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Catalog page has an unknown shape");
    const page = parsed.data;
    if (page.stream !== stream)
      throw new Error("Catalog page is of another stream");
    progress.pages += 1;

    if (page.nextCursor !== null) watermark = page.nextCursor;
    // Revocations may be on a later page. Until the whole discount stream is
    // applied its cursor may advance, but its freshness must remain closed.
    const succeededAt =
      countsWhenWhole(stream) && page.hasMore ? PROMO_INVALIDATED_AT : now();
    const checkpoint = watermark;
    // Apply and checkpoint together: both land, or neither does.
    const result = await withTenant(database, options.context, async (tx) => {
      // The stream lock comes BEFORE the checkpoint is read, so pages of one
      // stream (this pull's and a concurrent pull's) apply one after another.
      await ensureCatalogStreamInitialized(tx, {
        tenantId,
        edgeNodeId: options.edgeNodeId,
        stream,
        at: succeededAt,
      });
      // A refused HTTP cursor may restore HTTP-only copies to cloud state.
      // Successfully held link versions remain protected during that reset.
      let rewindFrom: string | null = null;
      if (since === null) {
        const [row] = await tx
          .select({ watermark: edgePullCheckpoints.watermark })
          .from(edgePullCheckpoints)
          .where(
            and(
              eq(edgePullCheckpoints.edgeNodeId, options.edgeNodeId),
              eq(edgePullCheckpoints.stream, catalogCheckpointStream(stream)),
            ),
          )
          .limit(1);
        const current = row?.watermark ?? null;
        // A rewind only while the checkpoint is still the refused cursor (or
        // the operator's rewind mark): a concurrent pull that already moved it
        // must not be undone.
        if (rejectedCursor !== null && current === rejectedCursor)
          rewindFrom = rejectedCursor;
        else if (current === CATALOG_REWIND_MARK) rewindFrom = current;
        if (rewindFrom !== null) {
          // The history before the rewind is gone: its link receipts stop
          // protecting rows (before the reset and the receipt filter below),
          // and the full replay that follows decides which items are absent.
          await raiseCatalogReceiptFloor(tx, options.edgeNodeId, succeededAt);
          // Every rewind starts the two-step replay over: an older pinned
          // horizon must not let this replay's own last page deactivate.
          await saveCheckpointRow(
            tx,
            options.edgeNodeId,
            catalogReplayCheckpoint(stream),
            "1",
            succeededAt,
          );
        }
        if (
          rewindFrom !== null ||
          current === null ||
          !isCurrentCursor(current)
        ) {
          await resetCatalogSyncTxid(tx, tenantId, stream, options.edgeNodeId);
          // A reset restarts the replay: a pinned horizon from before it no
          // longer proves anything (only an existing marker is touched).
          if (rewindFrom === null)
            await tx
              .update(edgePullCheckpoints)
              .set({ watermark: "1", updatedAt: new Date() })
              .where(
                and(
                  eq(edgePullCheckpoints.edgeNodeId, options.edgeNodeId),
                  eq(
                    edgePullCheckpoints.stream,
                    catalogReplayCheckpoint(stream),
                  ),
                ),
              );
        }
      }
      // Canonical station events carry the original v3 shape. An equal-version
      // HTTP row can fill only its optional KDS settings before receipt filtering.
      if (stream === "stations")
        await enrichCatalogStationFields(tx, {
          tenantId,
          edgeNodeId: options.edgeNodeId,
          stream,
          records: page.records,
        });
      const records = await filterCatalogRecordsAfterEvents(tx, {
        tenantId,
        edgeNodeId: options.edgeNodeId,
        stream,
        records: page.records,
      });
      const applied = await applyCatalogRecords(tx, {
        tenantId,
        stream,
        records,
      });
      const outcome = {
        ...applied,
        skipped: applied.skipped + page.records.length - records.length,
      };
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
      // Same for printers whose fallback is not on this edge yet.
      if (stream === "printers" && outcome.deferredFallbacks.length > 0) {
        const kept = (
          await loadPendingParents(tx, options.edgeNodeId, FALLBACKS_CHECKPOINT)
        ).filter(
          (pair) =>
            !outcome.deferredFallbacks.some((fresh) => fresh.id === pair.id),
        );
        await savePendingParents(
          tx,
          options.edgeNodeId,
          [...kept, ...outcome.deferredFallbacks],
          succeededAt,
          FALLBACKS_CHECKPOINT,
        );
      }
      // The last page of a rewound stream (legend-7r7q6). The cloud exports
      // only rows below its snapshot xmin, so the replay may have missed rows
      // still in flight there; deactivating on its last page could hide items
      // the cloud still has. The marker therefore moves in two steps: "1" (set
      // at the rewind) becomes `h:<horizon>` (the snapshot xmax of this page);
      // once a later last page reports `visibleBelow >= horizon`, every row
      // that existed at the replay is visible and applied, and the items the
      // snapshot never touched are deactivated (never deleted) in the same
      // commit as the page. A page without the fields (an older cloud) or an
      // incremental pull, a first boot or a replay cut at maxPages (marker
      // stays) deactivates nothing.
      if (!page.hasMore) {
        const [replay] = await tx
          .select({ watermark: edgePullCheckpoints.watermark })
          .from(edgePullCheckpoints)
          .where(
            and(
              eq(edgePullCheckpoints.edgeNodeId, options.edgeNodeId),
              eq(edgePullCheckpoints.stream, catalogReplayCheckpoint(stream)),
            ),
          )
          .limit(1);
        if (
          replay &&
          page.horizon !== undefined &&
          page.visibleBelow !== undefined
        ) {
          const pinned = /^h:([0-9]{1,20})$/.exec(replay.watermark ?? "");
          if (replay.watermark === "1") {
            await saveCheckpointRow(
              tx,
              options.edgeNodeId,
              catalogReplayCheckpoint(stream),
              `h:${page.horizon}`,
              succeededAt,
            );
          } else if (
            pinned !== null &&
            BigInt(page.visibleBelow) >= BigInt(pinned[1] ?? "0")
          ) {
            const deactivated = await deactivateAbsentCatalogRows(tx, {
              tenantId,
              stream,
              at: succeededAt,
            });
            // Count only, per stream: no row ids, names or other PII.
            logger.info(
              { stream, deactivated },
              "edge catalog: replay deactivated rows the restored cloud no longer has",
            );
            await tx
              .delete(edgePullCheckpoints)
              .where(
                and(
                  eq(edgePullCheckpoints.edgeNodeId, options.edgeNodeId),
                  eq(
                    edgePullCheckpoints.stream,
                    catalogReplayCheckpoint(stream),
                  ),
                ),
              );
          }
        }
      }
      // Fail closed (legend-1199 P2-B): while the replay marker of promotions
      // exists, a promo the cloud no longer has may still be on this edge
      // (the cloud withholds its snapshot fields until a restamp is
      // committed), so the stream's freshness stays closed until the
      // deactivation above commits and deletes the marker.
      let replayOpen = false;
      if (stream === "promotions" && !page.hasMore) {
        const [open] = await tx
          .select({ watermark: edgePullCheckpoints.watermark })
          .from(edgePullCheckpoints)
          .where(
            and(
              eq(edgePullCheckpoints.edgeNodeId, options.edgeNodeId),
              eq(edgePullCheckpoints.stream, catalogReplayCheckpoint(stream)),
            ),
          )
          .limit(1);
        replayOpen = open !== undefined;
      }
      await saveCatalogCheckpoint(
        tx,
        options.edgeNodeId,
        stream,
        checkpoint,
        replayOpen ? PROMO_INVALIDATED_AT : succeededAt,
        rewindFrom,
      );
      return { ...outcome, replayOpen };
    });
    // The page is committed: only now does the stream's progress move.
    rejectedCursor = null;
    progress.watermark = checkpoint;
    progress.replayOpen = result.replayOpen;
    progress.lastSuccessAt =
      (countsWhenWhole(stream) && page.hasMore) || result.replayOpen
        ? null
        : succeededAt;
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

  // Same for printer fallbacks: the target may have come on a later page or pull.
  if (stream === "printers")
    await withTenant(database, options.context, async (tx) => {
      const pending = await loadPendingParents(
        tx,
        options.edgeNodeId,
        FALLBACKS_CHECKPOINT,
      );
      if (pending.length === 0) return;
      await repairPrinterFallbacks(tx, { tenantId, pairs: pending });
      const remaining = await unresolvedPrinterFallbacks(tx, {
        tenantId,
        pairs: pending,
      });
      if (remaining.length !== pending.length)
        await savePendingParents(
          tx,
          options.edgeNodeId,
          remaining,
          now(),
          FALLBACKS_CHECKPOINT,
        );
    });
}

/** The stream this one depends on failed in the same pull. */
class CatalogParentFailedError extends Error {
  readonly code = "CATALOG_PARENT_FAILED";

  constructor(parent: CatalogSyncStream) {
    super(`Catalog stream skipped: ${parent} failed in this pull.`);
    this.name = "CatalogParentFailedError";
  }
}

/** The cloud sent no protocol version or an older one: it still runs an old release. */
class CatalogCloudOutdatedError extends Error {
  readonly code = "CATALOG_CLOUD_OUTDATED";

  constructor() {
    super(
      "Cloud belum mendukung syncTxid katalog: deploy cloud dulu, baru edge.",
    );
    this.name = "CatalogCloudOutdatedError";
  }
}

/** The cloud speaks a newer catalog protocol than this edge understands. */
class CatalogEdgeOutdatedError extends Error {
  readonly code = "CATALOG_EDGE_OUTDATED";

  constructor() {
    super("Edge belum mendukung versi protokol katalog cloud: perbarui edge.");
    this.name = "CatalogEdgeOutdatedError";
  }
}

/** Code and message that are safe to report: no record data, no SQL detail. */
function describeError(error: unknown): CatalogStreamError {
  if (
    error instanceof CatalogMissingRefError ||
    error instanceof CatalogParentFailedError ||
    error instanceof CatalogCloudOutdatedError ||
    error instanceof CatalogEdgeOutdatedError ||
    error instanceof CoreError ||
    error instanceof EdgeCloudHttpError
  )
    return { code: error.code, message: error.message };
  return {
    code: "CATALOG_PULL_FAILED",
    message: "Catalog stream could not be pulled.",
  };
}

let catalogPullQueue: Promise<void> = Promise.resolve();

/**
 * One full catalog pull: every stream in turn from its own checkpoint. A stream
 * that fails (connection lost, bad page, missing reference, apply error) stops
 * there with its checkpoint at the last applied page and `error` set on its
 * result; the other streams still run. Only a bad context throws.
 */
export async function pullCatalog(
  options: PullCatalogOptions,
): Promise<PullCatalogResult> {
  // The promo gate is process-wide. Serialize whole attempts before assigning
  // their generations or reading checkpoints: a concurrent offline retry must
  // not reopen the gate using a checkpoint read before another pull went partial.
  // Waiting holds no database connection, and a failed pull still releases its slot.
  const previous = catalogPullQueue;
  let release!: () => void;
  catalogPullQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await runCatalogPull(options);
  } finally {
    release();
  }
}

async function runCatalogPull(
  options: PullCatalogOptions,
): Promise<PullCatalogResult> {
  oneOutlet(options.context);
  const database = options.database ?? db;
  const streams = options.streams ?? CATALOG_SYNC_STREAMS;
  const fullCatalog =
    streams.length === CATALOG_SYNC_STREAMS.length &&
    CATALOG_SYNC_STREAMS.every((stream) => streams.includes(stream));
  const schemaRevisionPending =
    fullCatalog && (await prepareCatalogSchemaRevision(options));
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
    // Runtime freshness caches checkpoint reads. Close it synchronously before
    // a pull can expose a partial discount snapshot; failure keeps it closed.
    const promoGeneration = markPromoCatalogStreamPending(
      catalogCheckpointStream(stream),
    );
    const progress: StreamProgress = {
      applied: 0,
      skipped: 0,
      deleted: 0,
      nulledRefs: 0,
      repairedParents: 0,
      pages: 0,
      watermark: null,
      backlog: false,
      lastSuccessAt: null,
    };
    let error: CatalogStreamError | undefined;
    // True once the cloud answered with a page (before it is validated).
    let pageReceived = false;
    // Proven complete only once the stored checkpoint was read and does not
    // mark an unfinished promo sync; unknown counts as unfinished (fail closed).
    let storedComplete = !isPromoStream(stream);
    const blockedBy = (PARENT_STREAMS[stream] ?? []).find((parent) =>
      failed.has(parent),
    );
    try {
      // No durable invalidation up front (brief 533 B2): a transport failure
      // before any page arrives (offline, HTTP error) changes nothing, so the
      // last successful sync time stays and an uncapped promotion lives until
      // the 24 h limit. A page that arrives and is then rejected closes the
      // checkpoint (catch below); a page with more to come closes it in the
      // same commit as the page (see pullStream).
      const stored = await loadCatalogCheckpoint(
        database,
        options.context,
        options.edgeNodeId,
        stream,
      );
      storedComplete = !stored.unfinished;
      if (blockedBy !== undefined)
        throw new CatalogParentFailedError(blockedBy);
      await pullStream(
        {
          ...options,
          fetchPage: async (fetchStream, since) => {
            const raw = await options.fetchPage(fetchStream, since);
            pageReceived = true;
            return raw;
          },
        },
        stream,
        stored.cursor,
        progress,
      );
      if (!progress.backlog && !progress.replayOpen)
        completePromoCatalogStream(
          catalogCheckpointStream(stream),
          promoGeneration,
        );
    } catch (caught) {
      error = describeError(caught);
      if (!pageReceived) {
        // Transport failure with no page: the stream is as it was, so the
        // in-memory pending mark must not close it (capped promos are refused
        // by the promo engine at an edge regardless). Only when the stored
        // checkpoint is proven complete: an earlier unfinished promo sync (or
        // an unreadable checkpoint) keeps the mark until a sync reaches its end.
        if (storedComplete)
          completePromoCatalogStream(
            catalogCheckpointStream(stream),
            promoGeneration,
          );
      } else if (isPromoStream(stream)) {
        // A page arrived and was rejected or failed to apply: close the
        // checkpoint durably (kept cursor, epoch success time) and keep the
        // in-memory pending mark. A failed write stays closed in memory.
        try {
          await withTenant(database, options.context, async (tx) => {
            await lockCatalogStream(
              tx,
              options.context.tenant.tenantId,
              stream,
            );
            const [row] = await tx
              .select({ watermark: edgePullCheckpoints.watermark })
              .from(edgePullCheckpoints)
              .where(
                and(
                  eq(edgePullCheckpoints.edgeNodeId, options.edgeNodeId),
                  eq(
                    edgePullCheckpoints.stream,
                    catalogCheckpointStream(stream),
                  ),
                ),
              )
              .limit(1);
            await saveCatalogCheckpoint(
              tx,
              options.edgeNodeId,
              stream,
              row?.watermark ?? null,
              PROMO_INVALIDATED_AT,
            );
          });
        } catch {
          // Reported through the stream error below; memory stays closed.
        }
      }
    }
    if (error || (isPromoStream(stream) && progress.backlog))
      failed.add(stream);
    results[stream] = error ? { ...progress, error } : { ...progress };
    total.applied += progress.applied;
    total.skipped += progress.skipped;
    total.deleted += progress.deleted;
    total.nulledRefs += progress.nulledRefs;
    total.repairedParents += progress.repairedParents;
    total.pages += progress.pages;
    total.backlog = total.backlog || progress.backlog;
  }
  if (
    schemaRevisionPending &&
    CATALOG_SYNC_STREAMS.every((stream) => {
      const result = results[stream];
      return (
        result !== undefined && result.error === undefined && !result.backlog
      );
    })
  )
    await completeCatalogSchemaRevision(options);
  return { streams: results, ...total };
}
