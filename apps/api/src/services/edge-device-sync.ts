// Device registry replication cloud -> outlet edge (bead legend-165; PRD v1.7
// §3 F5 Registri Perangkat, §6 `devices` "(T, E)", §5 Sinkronisasi "cloud
// wins" for master data, EDG-02, EDG-03, TEN-02/TEN-03).
//
// Export (cloud only, `GET /api/edge-sync/device-records`; not under /api/edge,
// which the EDGE_MODE guard serves only on an edge node). Same contract as the
// staff pin export (services/staff-pin-sync.ts): the caller is an edge node
// authenticated by its own credential; tenant and outlet come only from the
// verified credential, never from the query. Records include revoked devices
// (that is how a revocation reaches the edge) and carry no secret: no token,
// only the `tokenIssuedAt` floor the edge needs to rotate old tokens out.
// Keyset paging on (updated_at, id), opaque cursor, settle window for rows
// whose commit lags their `updated_at`.
//
// Apply (edge only): upserts into the local `devices` table, which
// `findActiveDeviceForToken` reads, so a revoked device is rejected on the edge
// with no cloud call once the revocation record is applied.
// - The context must be exactly one outlet. Records of another tenant or
//   another outlet refuse the whole page (a poisoned page changes nothing).
// - Revocation is terminal: a local revoked row is never touched, whatever
//   arrives (an older "active" record replayed late cannot revive it). An
//   incoming revoked record revokes a local active row.
// - Cloud wins for master data (label, station, training mode, status). The
//   token floor (`tokenIssuedAt`) only moves forward: the larger of local and
//   incoming, null never overwrites a value. Telemetry (version, capabilities, last_seen_at) is only taken
//   when the record saw the device later than the local row did, because the
//   edge also receives heartbeats from its own devices.
// - `station_id` is stored only if that station exists locally; otherwise null
//   until a later record finds it (the FK would refuse the row, and a missing
//   station must not stop a revocation from landing).
// - Idempotent: replaying a page produces the same rows. No audit or outbox
//   from apply: it mirrors cloud state and an event would echo back.
// - Receipt sequences (legend-3yqy): each page also carries the outlet's
//   device receipt sequences in full; see `applyDeviceReceiptSequences`.
//   S-K1: only when the edge asks (`?receiptSequences=1`), so an older edge
//   whose strict page schema predates the field keeps pulling (and keeps
//   receiving revocations). The edge parses the sequences apart from the
//   page: a sequence error is counted and logged, never stops the device
//   records or later pages. A standby edge never applies them.
// - Receipt number write-offs (legend-jcby0): created only on the cloud, copied
//   to the edge so its gap check (Tutup Hari) counts them; see
//   `applyDeviceReceiptWriteoffs`. Only when the edge asks
//   (`?receiptWriteoffs=1`), parsed apart from the page like the sequences.
import {
  deviceReceiptSequenceSyncSchema,
  deviceReceiptWriteoffSyncSchema,
  deviceSyncCloudPageSchema,
  deviceSyncPageSchema,
  deviceSyncRecordSchema,
  decodeReceiptRunReport,
  decodeReceiptRunRefusals,
  RECEIPT_WRITEOFF_SYNC_MAX,
  receiptRunReportQuerySchema,
  receiptRunRefusalQuerySchema,
  type DeviceReceiptSequenceBinding,
  type DeviceReceiptSequenceSync,
  type DeviceReceiptWriteoffSync,
  type DeviceSyncPage,
  type DeviceSyncRecord,
  type ReceiptRunRefusalReason,
  type ReceiptRunRefusalReport,
  type ReceiptRunReport,
} from "@starter/shared/edge";
import {
  CoreError,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  PAGE_LIMIT_MAX,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { stations } from "../db/schema/menu.ts";
import { edgeNodes } from "../db/schema/edge-node.ts";
import { posReceipts, receiptSequences } from "../db/schema/pos-receipt.ts";
import { receiptNumberWriteoffs } from "../db/schema/pos-receipt-writeoff.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import { logger } from "../lib/logger.ts";
import { toDevice } from "./device.service.ts";
import {
  applyCloudDeviceReceiptSequence,
  retireUnlistedDeviceReceiptSequences,
  backfillDeviceReceiptSequences,
  claimDeviceReceiptSequencesForEdge,
  listDeviceReceiptSequences,
  localReceiptRunReport,
} from "./pos-receipt.service.ts";
import type { VerifiedEdgeNode } from "./staff-pin-sync.ts";
import { verifiedEdgeNodeSchema } from "./staff-pin-sync.ts";

// ------------------------------------------------------------------- export

/**
 * `pullDeviceRegistry` restarts this far before the stored watermark. A row's
 * commit can lag its `updated_at` by more than the settle window (long
 * transactions, DB clock), so a record may land behind a watermark already
 * handed out. Re-reading the overlap is safe: apply is idempotent.
 */
export const DEVICE_SYNC_OVERLAP_MS = 10 * 60 * 1000;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Rows younger than this are held back (see staff-pin-sync "Settle window"). */
export const DEVICE_SYNC_SETTLE_MS = 5_000;
export const DEVICE_SYNC_LIMIT_DEFAULT = PAGE_LIMIT_MAX;

export const deviceSyncQuerySchema = z.strictObject({
  since: cursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(DEVICE_SYNC_LIMIT_DEFAULT),
  /** S-K1 (legend-3yqy): `1` adds the outlet's device receipt sequences. */
  receiptSequences: z.literal("1").optional(),
  /** legend-zsdd: the edge's database id; sequences bind to (node, instance). */
  edgeInstance: uuidSchema.optional(),
  /**
   * legend-yd0h8: the edge's local counter of every current local run
   * (`P1:150,P3:7`, `""` = none). Absent = an old edge: no restore check.
   */
  receiptRuns: receiptRunReportQuerySchema.optional(),
  /**
   * legend-hfq3z: the pulled runs this edge refused for a prefix or id clash
   * (`<id>:prefix_used,<id>:id_used`). Only meaningful with
   * `receiptSequences=1`; absent = an old edge (no self-heal).
   */
  receiptRefused: receiptRunRefusalQuerySchema.optional(),
  /**
   * legend-jcby0: `1` adds the outlet's receipt number write-offs (to a
   * primary edge with a binding, like the sequences). Absent = an old edge.
   */
  receiptWriteoffs: z.literal("1").optional(),
});
export type DeviceSyncQuery = z.infer<typeof deviceSyncQuerySchema>;

const CURSOR_TAG = "dev1";
const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type Watermark = { readonly version: string; readonly id: string };

const CURSOR_INVALID_MESSAGE = "Cursor sinkronisasi tidak valid.";

/** True when `error` is the refusal of a malformed sync cursor (not a record). */
export function isDeviceSyncCursorError(error: unknown): boolean {
  return (
    error instanceof CoreError &&
    error.code === "VALIDATION_ERROR" &&
    error.message === CURSOR_INVALID_MESSAGE
  );
}

function parseWatermark(cursor: string | undefined): Watermark | null {
  if (cursor === undefined) return null;
  let keys: unknown[];
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new CoreError("VALIDATION_ERROR", CURSOR_INVALID_MESSAGE);
  }
  const [tag, version, id, extra] = keys;
  if (
    tag !== CURSOR_TAG ||
    typeof version !== "string" ||
    !VERSION_PATTERN.test(version) ||
    !uuidSchema.safeParse(id).success ||
    extra !== undefined
  )
    throw new CoreError("VALIDATION_ERROR", CURSOR_INVALID_MESSAGE);
  return { version, id: String(id) };
}

/** The cursor moved back by `ms` (microsecond digits kept, id reset). */
function rewindWatermark(cursor: string, ms: number): string {
  const mark = parseWatermark(cursor);
  if (mark === null) return cursor;
  const base = Date.parse(`${mark.version.slice(0, 23)}Z`);
  const earlier = new Date(base - ms).toISOString().slice(0, 23);
  return encodeWatermark({
    version: `${earlier}${mark.version.slice(23, 26)}Z`,
    id: NIL_UUID,
  });
}

function encodeWatermark(mark: Watermark): string {
  return encodeCursor([CURSOR_TAG, mark.version, mark.id]);
}

/** Exact (microsecond, UTC) text of `updated_at`: the keyset version. */
const versionOf = sql<string>`to_char(${devices.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type ListDeviceRecordsOptions = {
  readonly now?: Date;
  /** Override the settle window (tests); never negative. */
  readonly settleMs?: number;
};

/**
 * One page of the edge node's outlet devices changed after `since` (revoked
 * ones included), in (updated_at, id) order. Tenant and outlet come only from
 * `node`.
 */
export async function listDeviceRecordsSince(
  node: VerifiedEdgeNode,
  query: DeviceSyncQuery,
  options: ListDeviceRecordsOptions = {},
): Promise<DeviceSyncPage> {
  const verified = verifiedEdgeNodeSchema.parse(node);
  const {
    limit,
    receiptSequences: withSequences,
    edgeInstance,
    receiptRuns,
    receiptRefused,
    receiptWriteoffs: withWriteoffs,
  } = deviceSyncQuerySchema.parse(query);
  const since = parseWatermark(query.since);
  const now = options.now ?? new Date();
  const settleMs = Math.max(0, options.settleMs ?? DEVICE_SYNC_SETTLE_MS);
  const cutoff = new Date(now.getTime() - settleMs);
  const tenant = establishTenantContext({
    tenantId: verified.tenantId,
    brandId: null,
    source: "device",
  });
  const context = outletContext(tenant, verified.outletId);

  const result = await withTenant(db, context, async (tx) => {
    // Fail closed: an inactive tenant or a closed / unknown outlet syncs nothing.
    const [tenantRow] = await tx
      .select({ status: tenants.status })
      .from(tenants)
      .where(eq(tenants.id, verified.tenantId))
      .limit(1);
    const [outletRow] = await tx
      .select({ status: outlets.status })
      .from(outlets)
      .where(
        and(
          eq(outlets.tenantId, verified.tenantId),
          eq(outlets.id, verified.outletId),
        ),
      )
      .limit(1);
    if (
      tenantRow?.status !== "active" ||
      !outletRow ||
      outletRow.status === "closed"
    )
      throw new CoreError(
        "FORBIDDEN",
        "Edge node tidak dapat menyinkronkan outlet ini.",
      );
    // legend-3yqy: a read path that writes. Order-taking devices enrolled
    // before sequences were provisioned at enroll get theirs here, so the edge
    // can number their sales offline. Safe on a read: provisioning is
    // idempotent (an existing row is returned unchanged), outlet-locked, and
    // runs in this same tenant/outlet-scoped transaction. Only for an edge
    // that asked for the sequences (S-K1).
    // legend-zsdd: the claim (bind / rotate to this edge database) runs only
    // for an active primary node that sent its instance id; a standby, a
    // non-active node or an edge without an instance claims and gets nothing.
    let binding: DeviceReceiptSequenceBinding | null = null;
    let alert = false;
    if (withSequences === "1") {
      const [nodeRow] = await tx
        .select({ role: edgeNodes.role, status: edgeNodes.status })
        .from(edgeNodes)
        .where(
          and(
            eq(edgeNodes.tenantId, verified.tenantId),
            eq(edgeNodes.outletId, verified.outletId),
            eq(edgeNodes.id, verified.edgeNodeId),
          ),
        )
        .limit(1);
      if (
        nodeRow?.role === "primary" &&
        nodeRow.status === "active" &&
        edgeInstance !== undefined
      ) {
        binding = {
          edgeNodeId: verified.edgeNodeId,
          edgeInstanceId: edgeInstance,
        };
        await backfillDeviceReceiptSequences(tx, context, verified.outletId);
        const claim = await claimDeviceReceiptSequencesForEdge(tx, context, {
          outletId: verified.outletId,
          ...binding,
          // Validated by the query schema, so it decodes (null never here).
          report:
            receiptRuns === undefined
              ? undefined
              : (decodeReceiptRunReport(receiptRuns) ?? undefined),
          // legend-yd0h8: cloud arrival time orders reports (not the edge
          // clock). The route passes `now` taken before its credential check,
          // so pool and outlet lock waits do not make an old report look new.
          // Network / load balancer delay is not covered: the puller only
          // retries after its 15 s timeout.
          reportedAt: receiptRuns === undefined ? undefined : now,
          // legend-hfq3z: clash refusals of the previous pull (validated by
          // the query schema, so it decodes).
          refusals:
            receiptRefused === undefined
              ? undefined
              : (decodeReceiptRunRefusals(receiptRefused) ?? undefined),
        });
        alert = claim.alert;
        // legend-zsdd: a repeated rotation means two databases pull with one
        // node id. Counts only, no ids.
        if (claim.rotated > 0)
          logger.warn(
            { rotated: claim.rotated, claimed: claim.claimed },
            "device receipt sequences rotated for an edge pull",
          );
        // legend-yd0h8: a restored or cloned edge database. Counts only.
        if (
          claim.regressed > 0 ||
          claim.throttled > 0 ||
          claim.stale > 0 ||
          claim.alert
        )
          logger.warn(
            {
              edgeNodeId: verified.edgeNodeId,
              regressed: claim.regressed,
              throttled: claim.throttled,
              stale: claim.stale,
              alert: claim.alert,
            },
            "edge receipt runs regressed (restored or cloned edge database)",
          );
        // legend-hfq3z: runs the edge refused for a clash and rotated. Counts
        // only, no ids.
        if (claim.refusedRotated > 0)
          logger.warn(
            {
              edgeNodeId: verified.edgeNodeId,
              refusedRotated: claim.refusedRotated,
            },
            "refused receipt runs rotated for an edge pull (legend-hfq3z)",
          );
        // legend-hfq3z: the throttle held runs back, a device is left without
        // a receipt run. Counts only.
        if (claim.refusedThrottled > 0)
          logger.error(
            {
              edgeNodeId: verified.edgeNodeId,
              refusedThrottled: claim.refusedThrottled,
            },
            "refused receipt runs throttled: device left without a receipt run (legend-hfq3z)",
          );
      }
    }
    const found = await tx
      .select({ row: devices, version: versionOf })
      .from(devices)
      .where(
        and(
          eq(devices.tenantId, verified.tenantId),
          eq(devices.outletId, verified.outletId),
          lte(devices.updatedAt, cutoff),
          since === null
            ? undefined
            : sql`(${devices.updatedAt}, ${devices.id}) > (${since.version}::timestamptz, ${since.id}::uuid)`,
        ),
      )
      .orderBy(asc(devices.updatedAt), asc(devices.id))
      .limit(limit + 1);
    // The full list on every page (a handful per outlet): no cursor to keep.
    const sequences =
      withSequences !== "1"
        ? undefined
        : binding === null
          ? []
          : await listDeviceReceiptSequences(
              tx,
              context,
              verified.outletId,
              binding,
            );
    // legend-jcby0: the outlet's write-offs, in the same transaction as the
    // sequences. Outlet data, not bound to an edge database: sent on request;
    // the edge applies them only as a primary with a binding. Read in a
    // savepoint: a failed read leaves the field out of the page (the edge then
    // applies nothing: fail closed) and never costs the device records or the
    // sequences of the page.
    let writeoffs: DeviceReceiptWriteoffSync[] | undefined;
    if (withWriteoffs === "1") {
      try {
        // Newest first so that past the cap the newest still arrive (older rows
        // are already on the edge and never removed).
        const listed = await tx.transaction(async (savepoint) =>
          savepoint
            .select()
            .from(receiptNumberWriteoffs)
            .where(
              and(
                eq(receiptNumberWriteoffs.tenantId, verified.tenantId),
                eq(receiptNumberWriteoffs.outletId, verified.outletId),
              ),
            )
            .orderBy(
              desc(receiptNumberWriteoffs.createdAt),
              desc(receiptNumberWriteoffs.id),
            )
            .limit(RECEIPT_WRITEOFF_SYNC_MAX + 1),
        );
        // Counts only, never the reason text.
        if (listed.length > RECEIPT_WRITEOFF_SYNC_MAX)
          logger.warn(
            {
              edgeNodeId: verified.edgeNodeId,
              max: RECEIPT_WRITEOFF_SYNC_MAX,
            },
            "receipt write-offs past the sync limit: the newest are sent, the oldest are left to the edge's copy (legend-jcby0)",
          );
        // Back to oldest first (`created_at, id`) for the page.
        writeoffs = listed
          .slice(0, RECEIPT_WRITEOFF_SYNC_MAX)
          .reverse()
          .map((row) => ({
            id: row.id,
            outletId: row.outletId,
            sequenceId: row.sequenceId,
            prefix: row.prefix,
            sequenceNumber: row.sequenceNumber,
            reason: row.reason,
            writtenOffBy: row.writtenOffBy,
            createdAt: row.createdAt.toISOString(),
          })) as DeviceReceiptWriteoffSync[];
      } catch {
        // Counts only: no error text, no row data.
        logger.error(
          { edgeNodeId: verified.edgeNodeId },
          "receipt write-offs not read for an edge pull: left out of the page (legend-jcby0)",
        );
      }
    }
    return { found, sequences, alert, writeoffs };
  });
  const { found: rows, sequences, alert, writeoffs } = result;

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const lastMark = last
    ? encodeWatermark({ version: last.version, id: last.row.id })
    : null;
  return deviceSyncCloudPageSchema.parse({
    data: page.map(({ row }) => ({
      ...toDevice(row),
      tokenIssuedAt: row.tokenIssuedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    })),
    ...(sequences === undefined ? {} : { receiptSequences: sequences }),
    ...(writeoffs === undefined ? {} : { receiptWriteoffs: writeoffs }),
    // legend-yd0h8: only to an edge that sent `receiptRuns` (old edges parse
    // pages strictly).
    ...(receiptRuns !== undefined && alert ? { receiptRunAlert: true } : {}),
    meta: {
      limit,
      nextCursor: rows.length > limit ? lastMark : null,
      watermark: lastMark ?? query.since ?? null,
    },
  });
}

// -------------------------------------------------------------------- apply

export type DeviceApplyResult = {
  readonly applied: number;
  readonly skipped: number;
};

function refuse(message: string): never {
  throw new CoreError("VALIDATION_ERROR", message);
}

/**
 * Edge side: ingests one page of cloud records (see the header). Every record
 * must be of `context`'s tenant and inside its outlet scope; one bad record
 * refuses the whole page.
 */
export async function applyDeviceRecords(
  context: ScopedTenantContext,
  records: readonly unknown[],
): Promise<DeviceApplyResult> {
  const tenantId = context.tenant.tenantId.toLowerCase();
  // The replica holds one outlet: the context must be exactly that outlet, not
  // tenant-wide and not several outlets.
  if (
    context.outletScope.kind !== "outlets" ||
    context.outletScope.outletIds.length !== 1
  )
    refuse("Device sync needs a context of exactly one outlet.");
  const outletId = context.outletScope.outletIds[0]!.toLowerCase();
  const parsed: DeviceSyncRecord[] = records.map((raw) => {
    const result = deviceSyncRecordSchema.safeParse(raw);
    if (!result.success) refuse("Device record has an unknown shape.");
    return result.data;
  });
  const seen = new Set<string>();
  for (const record of parsed) {
    if (record.tenantId.toLowerCase() !== tenantId)
      refuse("Device record belongs to another tenant.");
    if (record.outletId.toLowerCase() !== outletId)
      refuse("Device record belongs to another outlet.");
    const id = record.id.toLowerCase();
    if (seen.has(id)) refuse("Device page repeats a record.");
    seen.add(id);
  }
  const ordered = [...parsed].sort(
    (a, b) =>
      Date.parse(a.updatedAt) - Date.parse(b.updatedAt) ||
      a.id.localeCompare(b.id),
  );

  return withTenant(db, context, async (tx) => {
    let applied = 0;
    for (const record of ordered) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`device-sync:${tenantId}:${record.id}`.toLowerCase()}, 0))`,
      );
      const [local] = await tx
        .select()
        .from(devices)
        .where(
          and(eq(devices.tenantId, record.tenantId), eq(devices.id, record.id)),
        )
        .for("update");

      // Revocation is terminal: never touch a revoked replica row.
      if (local?.status === "revoked") continue;
      if (
        local &&
        (local.outletId !== record.outletId || local.type !== record.type)
      )
        throw new CoreError(
          "CONFLICT",
          "Device record does not match the stored device identity.",
        );

      let stationId = record.stationId;
      if (stationId !== null) {
        const [station] = await tx
          .select({ id: stations.id })
          .from(stations)
          .where(
            and(
              eq(stations.tenantId, record.tenantId),
              eq(stations.id, stationId),
            ),
          )
          .limit(1);
        if (!station) stationId = null;
      }
      const version = new Date(record.updatedAt);
      const lastSeenAt =
        record.lastSeenAt === null ? null : new Date(record.lastSeenAt);
      const revokedAt =
        record.revokedAt === null ? null : new Date(record.revokedAt);
      const tokenIssuedAt =
        record.tokenIssuedAt === null ? null : new Date(record.tokenIssuedAt);
      // The floor only moves forward: an out-of-order older record must not
      // let a rotated-out token verify again, and null never clears it.
      const floorOf = (local: Date | null): Date | null =>
        local === null ||
        (tokenIssuedAt !== null && tokenIssuedAt.getTime() > local.getTime())
          ? tokenIssuedAt
          : local;

      if (!local) {
        await tx.insert(devices).values({
          id: record.id,
          tenantId: record.tenantId,
          outletId: record.outletId,
          type: record.type,
          stationId,
          label: record.label,
          version: record.version,
          capabilities: record.capabilities,
          trainingMode: record.trainingMode,
          // Shared mode exists only on POS devices; the cloud cannot produce
          // it for another type, so deny when in doubt.
          sharedMode: record.type === "pos" && (record.sharedMode ?? false),
          lastSeenAt,
          status: record.status,
          revokedAt,
          tokenIssuedAt,
          createdAt: version,
          updatedAt: version,
        });
        applied += 1;
        continue;
      }
      const newerTelemetry =
        lastSeenAt !== null &&
        (local.lastSeenAt === null ||
          lastSeenAt.getTime() > local.lastSeenAt.getTime());
      // Cloud wins for the mode flags and the version: no updatedAt
      // comparison. The edge's own heartbeats write `updated_at` with the edge
      // clock, so a local `updated_at` says nothing about whether the cloud
      // record is older, and comparing would let a fast edge clock freeze
      // the flags (e.g. a shared-device guard never switching off or on).
      await tx
        .update(devices)
        .set({
          stationId,
          label: record.label,
          status: record.status,
          revokedAt,
          tokenIssuedAt: floorOf(local.tokenIssuedAt),
          trainingMode: record.trainingMode,
          // A record without the field keeps the local flag; it must never
          // switch the shared-device guard off by omission. Shared mode exists
          // only on POS devices; the cloud cannot produce it for another type,
          // so deny when in doubt.
          ...(record.type !== "pos"
            ? { sharedMode: false }
            : record.sharedMode === undefined
              ? {}
              : { sharedMode: record.sharedMode }),
          updatedAt: version,
          ...(newerTelemetry
            ? {
                version: record.version,
                capabilities: record.capabilities,
                lastSeenAt,
              }
            : {}),
        })
        .where(eq(devices.id, local.id));
      applied += 1;
    }
    return { applied, skipped: ordered.length - applied };
  });
}

// ------------------------------------------------- receipt sequences apply

export type ReceiptSequenceApplyResult = {
  readonly inserted: number;
  readonly kept: number;
  /** legend-zsdd: a local current run retired, the pulled one inserted. */
  readonly replaced: number;
  /** Skipped: not our binding, prefix mismatch or advanced cloud run (see below). */
  readonly refused: number;
  /**
   * legend-sduiq: local current runs retired because the cloud's full list no
   * longer has them (the cloud retired them; see
   * `retireUnlistedDeviceReceiptSequences`).
   */
  readonly retired: number;
  /**
   * legend-hfq3z: id -> reason of this list's clash refusals (`prefix_used`,
   * `id_used`; they also count in `refused`). The next pull reports them.
   */
  readonly refusals: ReceiptRunRefusalReport;
};

/**
 * Edge side (legend-3yqy): the outlet's device receipt sequences from a pull
 * page. A sequence of another tenant or outlet refuses the whole list (a
 * poisoned page changes nothing; `pullDeviceRegistry` catches and counts it).
 * Each one is inserted when absent and the cloud's lastNumber is 0 (cloud id
 * and prefix, at 0) and never touched when present. A prefix mismatch (two
 * numbering namespaces) or an absent row whose cloud run is already past 0
 * (S-K1) skips only that sequence and is logged without device data: failing
 * the pull would also stop revocations from landing.
 * legend-zsdd: `own` is this edge's binding (node id, instance id). A sequence
 * bound to another database is refused; a pulled sequence with a new id or
 * prefix for a device replaces the local current run (`replaced`).
 * legend-sduiq: then every local current run usable here that the (non-empty)
 * list does not contain is retired (`retired`), so a refused replacement never
 * leaves the device numbering a run the cloud retired.
 */
export async function applyDeviceReceiptSequences(
  context: ScopedTenantContext,
  sequences: readonly unknown[],
  own: DeviceReceiptSequenceBinding,
  options: {
    /**
     * legend-sduiq: `sequences` is the cloud's FULL list for `own` (a pull
     * page). Only then are local runs missing from it retired; any other
     * caller (a partial list) must leave this off.
     */
    readonly complete?: boolean;
  } = {},
): Promise<ReceiptSequenceApplyResult> {
  // The tenant comes from `context` only (records carry none; RLS scopes the
  // writes to it).
  if (
    context.outletScope.kind !== "outlets" ||
    context.outletScope.outletIds.length !== 1
  )
    refuse("Device sync needs a context of exactly one outlet.");
  const outletId = context.outletScope.outletIds[0]!.toLowerCase();
  const parsed: DeviceReceiptSequenceSync[] = sequences.map((raw) => {
    const result = deviceReceiptSequenceSyncSchema.safeParse(raw);
    if (!result.success) refuse("Receipt sequence has an unknown shape.");
    return result.data;
  });
  for (const sequence of parsed)
    if (sequence.outletId.toLowerCase() !== outletId)
      refuse("Receipt sequence belongs to another outlet.");
  if (parsed.length === 0)
    return {
      inserted: 0,
      kept: 0,
      replaced: 0,
      refused: 0,
      retired: 0,
      refusals: new Map(),
    };
  const result = await withTenant(db, context, async (tx) => {
    let inserted = 0;
    let kept = 0;
    let replaced = 0;
    let refused = 0;
    const refusals = new Map<string, ReceiptRunRefusalReason>();
    for (const sequence of parsed) {
      const outcome = await applyCloudDeviceReceiptSequence(
        tx,
        context,
        sequence,
        own,
      );
      if (outcome === "inserted") inserted += 1;
      else if (outcome === "kept") kept += 1;
      else if (outcome === "replaced") replaced += 1;
      else {
        refused += 1;
        // legend-hfq3z: only the two clash refusals are reported to the cloud.
        if (outcome === "refused_prefix_used")
          refusals.set(sequence.id.toLowerCase(), "prefix_used");
        else if (outcome === "refused_id_used")
          refusals.set(sequence.id.toLowerCase(), "id_used");
      }
    }
    // legend-sduiq: only entries bound to `own` say what this database may
    // number; a list with none of them (e.g. a node id mismatch) retires
    // nothing, like an empty list.
    const listedIds = parsed
      .filter(
        (sequence) =>
          sequence.edgeNodeId === own.edgeNodeId &&
          sequence.edgeInstanceId === own.edgeInstanceId,
      )
      .map((sequence) => sequence.id);
    const retired =
      options.complete === true
        ? await retireUnlistedDeviceReceiptSequences(
            tx,
            context,
            outletId,
            listedIds,
            own,
          )
        : 0;
    return { inserted, kept, replaced, refused, retired, refusals };
  });
  if (result.refused > 0)
    logger.error(
      { refused: result.refused },
      "Edge receipt sequence refused (other binding, prefix mismatch or advanced cloud run): sequence skipped",
    );
  if (result.replaced > 0)
    logger.warn(
      { replaced: result.replaced },
      "Edge receipt sequence replaced by a new prefix from the cloud (legend-zsdd)",
    );
  if (result.retired > 0)
    logger.warn(
      { retired: result.retired },
      "Edge receipt sequence retired: the cloud no longer lists it (legend-sduiq)",
    );
  return result;
}

// ------------------------------------------------ receipt write-offs apply

export type ReceiptWriteoffApplyResult = {
  /** Rows copied into the edge's `receipt_number_writeoffs`. */
  readonly inserted: number;
  /**
   * Not copied, the row stays out on purpose: the run is not held here (or
   * not as named), the number is above the local counter, a local receipt
   * carries the number, the trigger refused it, or it is already present.
   */
  readonly skipped: number;
  /** The whole list refused (another outlet, bad shape or a failed apply). */
  readonly refused: number;
};

/** True when a PostgreSQL error (or its drizzle cause chain) has `code`. */
function hasPgCode(error: unknown, code: string, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; cause?: unknown };
  return candidate.code === code || hasPgCode(candidate.cause, code, depth + 1);
}

/**
 * Edge side (legend-jcby0): copies the cloud's receipt number write-offs of
 * the outlet into the local `receipt_number_writeoffs`, so the edge's own gap
 * check counts them (write-offs are created only on the cloud). One
 * transaction; the context must be exactly one outlet and a row of another
 * outlet refuses the whole list. A row is copied (cloud id, idempotent) only
 * when this database holds the named run (same tenant, outlet and prefix) with
 * `last_number >= sequenceNumber` and no local receipt carries the number (a
 * late receipt cancels the write-off); else it is skipped (fail closed). Rows
 * already present, for a run this database does not hold, or for a late receipt
 * are skipped without noise; a held run with another prefix or a lower counter,
 * or a trigger refusal (23514), is skipped and logged as missed. Any other
 * error refuses the whole list. Throws only for a bad context, shape or foreign outlet; apply failures
 * are counted in `refused`. Logged with counts only (never the reason text).
 */
export async function applyDeviceReceiptWriteoffs(
  context: ScopedTenantContext,
  writeoffs: readonly unknown[],
): Promise<ReceiptWriteoffApplyResult> {
  if (
    context.outletScope.kind !== "outlets" ||
    context.outletScope.outletIds.length !== 1
  )
    refuse("Device sync needs a context of exactly one outlet.");
  const ownOutletId = context.outletScope.outletIds[0]!;
  const outletId = ownOutletId.toLowerCase();
  const parsed: DeviceReceiptWriteoffSync[] = writeoffs.map((raw) => {
    const result = deviceReceiptWriteoffSyncSchema.safeParse(raw);
    if (!result.success) refuse("Receipt write-off has an unknown shape.");
    return result.data;
  });
  for (const writeoff of parsed)
    if (writeoff.outletId.toLowerCase() !== outletId)
      refuse("Receipt write-off belongs to another outlet.");
  if (parsed.length === 0) return { inserted: 0, skipped: 0, refused: 0 };
  const tenantId = context.tenant.tenantId;
  let result: { inserted: number; skipped: number; missed: number };
  try {
    result = await withTenant(db, context, async (tx) => {
      // One query first: write-offs this outlet already holds are skipped
      // silently (repeat pulls), with no further queries for them.
      const present = new Set(
        (
          await tx
            .select({ id: receiptNumberWriteoffs.id })
            .from(receiptNumberWriteoffs)
            .where(
              and(
                eq(receiptNumberWriteoffs.tenantId, tenantId),
                eq(receiptNumberWriteoffs.outletId, ownOutletId),
                inArray(
                  receiptNumberWriteoffs.id,
                  parsed.map((writeoff) => writeoff.id),
                ),
              ),
            )
        ).map((row) => row.id),
      );
      const runs = await tx
        .select({
          id: receiptSequences.id,
          prefix: receiptSequences.prefix,
          lastNumber: receiptSequences.lastNumber,
        })
        .from(receiptSequences)
        .where(
          and(
            eq(receiptSequences.tenantId, tenantId),
            eq(receiptSequences.outletId, ownOutletId),
          ),
        );
      const runById = new Map(runs.map((run) => [run.id, run]));
      let inserted = 0;
      let skipped = 0;
      // Worth a warn: a run held but not matching, or a trigger refusal. Not
      // counted: already present, run not held here, late receipt.
      let missed = 0;
      for (const writeoff of parsed) {
        if (present.has(writeoff.id)) {
          skipped += 1;
          continue;
        }
        const run = runById.get(writeoff.sequenceId);
        if (!run) {
          // This database does not hold the run (not its own, not yet).
          skipped += 1;
          continue;
        }
        if (
          run.prefix !== writeoff.prefix ||
          run.lastNumber < writeoff.sequenceNumber
        ) {
          skipped += 1;
          missed += 1;
          continue;
        }
        const [receipt] = await tx
          .select({ id: posReceipts.id })
          .from(posReceipts)
          .where(
            and(
              eq(posReceipts.tenantId, tenantId),
              eq(posReceipts.sequenceId, writeoff.sequenceId),
              eq(posReceipts.sequenceNumber, writeoff.sequenceNumber),
            ),
          )
          .limit(1);
        if (receipt) {
          // A late receipt holds the number: the gap check counts the receipt.
          skipped += 1;
          continue;
        }
        try {
          const rows = await tx.transaction(async (savepoint) =>
            savepoint
              .insert(receiptNumberWriteoffs)
              .values({
                id: writeoff.id,
                tenantId,
                outletId: ownOutletId,
                sequenceId: writeoff.sequenceId,
                prefix: writeoff.prefix,
                sequenceNumber: writeoff.sequenceNumber,
                reason: writeoff.reason,
                writtenOffBy: writeoff.writtenOffBy,
                createdAt: new Date(writeoff.createdAt),
              })
              .onConflictDoNothing()
              .returning({ id: receiptNumberWriteoffs.id }),
          );
          if (rows.length > 0) inserted += 1;
          else skipped += 1;
        } catch (error) {
          // The 0156 trigger refused this one row (backstop of the checks
          // above); anything else fails the whole list.
          if (!hasPgCode(error, "23514")) throw error;
          skipped += 1;
          missed += 1;
        }
      }
      return { inserted, skipped, missed };
    });
  } catch {
    logger.error(
      { refused: parsed.length },
      "Edge receipt write-offs refused (legend-jcby0)",
    );
    return { inserted: 0, skipped: 0, refused: parsed.length };
  }
  if (result.inserted > 0)
    logger.info(
      { inserted: result.inserted, skipped: result.skipped },
      "Edge receipt write-offs copied from the cloud (legend-jcby0)",
    );
  if (result.missed > 0)
    logger.warn(
      { missed: result.missed },
      "Edge receipt write-offs not copied: run mismatch or trigger refusal (legend-jcby0)",
    );
  return {
    inserted: result.inserted,
    skipped: result.skipped,
    refused: 0,
  };
}

// --------------------------------------------------------------------- pull

export type PullDeviceRegistryOptions = {
  /** The edge node's own scope (same as the context used to apply). */
  readonly context: ScopedTenantContext;
  /**
   * S-K1 (legend-3yqy): the node's role. Only a primary applies pulled receipt
   * sequences (a standby does not sell, and two edges must not both own a
   * device run). Omitted = not applied (fail closed).
   */
  readonly role?: "primary" | "standby";
  /**
   * legend-zsdd: this edge's own binding (node id, instance id). Pulled
   * sequences are applied only with a binding AND role primary (fail closed).
   */
  readonly binding?: DeviceReceiptSequenceBinding;
  /**
   * Stored watermark from the previous pull; null = first pull. The pull starts
   * `DEVICE_SYNC_OVERLAP_MS` before it.
   */
  readonly since?: string | null;
  /** Fetches one page from the cloud (`GET /api/edge-sync/device-records`). */
  readonly fetchPage: (
    since: string | null,
    receiptRuns?: ReceiptRunReport,
    refusals?: ReceiptRunRefusalReport,
  ) => Promise<unknown>;
  /**
   * legend-hfq3z: the clash refusals of the previous pull
   * (`PullDeviceRegistryResult.receiptRunRefusals`); sent with the first page
   * so the cloud can rotate those runs. Omitted = none.
   */
  readonly refusals?: ReceiptRunRefusalReport;
  /** Safety stop against a misbehaving cloud; default 1000 pages. */
  readonly maxPages?: number;
};

export type PullDeviceRegistryResult = DeviceApplyResult & {
  readonly pages: number;
  /**
   * legend-3yqy: pulled receipt sequences not applied (prefix mismatch, cloud
   * run already advanced, or a refused list: S-K1).
   */
  readonly receiptSequencesRefused: number;
  /** legend-zsdd: local runs replaced by a new prefix from the cloud. */
  readonly receiptSequencesReplaced: number;
  /** legend-sduiq: local runs retired because the cloud no longer lists them. */
  readonly receiptSequencesRetired: number;
  /** legend-jcby0: write-offs copied into the edge's own table. */
  readonly receiptWriteoffsInserted: number;
  /** legend-jcby0: write-offs left out (see `ReceiptWriteoffApplyResult`). */
  readonly receiptWriteoffsSkipped: number;
  /** legend-jcby0: write-offs of a refused list (whole list counted). */
  readonly receiptWriteoffsRefused: number;
  /**
   * legend-yd0h8: the cloud flagged a restored or cloned edge database (some
   * page carried `receiptRunAlert: true`).
   */
  readonly receiptRunAlert: boolean;
  /**
   * legend-hfq3z: id -> reason of the clash refusals of the last applied page
   * (empty when the last page carried no sequences). Pass it as `refusals` to
   * the next pull.
   */
  readonly receiptRunRefusals: ReceiptRunRefusalReport;
  /** Store only after this function returned: every page was applied. */
  readonly watermark: string | null;
};

/**
 * S-K1 (legend-3yqy): the page's `receiptSequences` applied apart from its
 * device records. Any error (shape, another outlet, apply failure) is caught
 * here and counted: the whole list of the page counts as refused (1 when it
 * is not even a list). Logged with counts only.
 */
async function applyPageReceiptSequences(
  context: ScopedTenantContext,
  raw: unknown,
  own: DeviceReceiptSequenceBinding,
): Promise<{
  refused: number;
  replaced: number;
  retired: number;
  refusals: ReceiptRunRefusalReport;
}> {
  const count = Array.isArray(raw) ? raw.length : 1;
  try {
    if (!Array.isArray(raw)) refuse("Receipt sequences are not a list.");
    // A pull page carries the cloud's full list (legend-sduiq).
    const result = await applyDeviceReceiptSequences(context, raw, own, {
      complete: true,
    });
    return {
      refused: result.refused,
      replaced: result.replaced,
      retired: result.retired,
      refusals: result.refusals,
    };
  } catch {
    logger.error(
      { refused: count },
      "Edge receipt sequences of a device page refused",
    );
    return { refused: count, replaced: 0, retired: 0, refusals: new Map() };
  }
}

/**
 * legend-jcby0: the page's `receiptWriteoffs` applied apart from its device
 * records. A list that is not an array, or any apply error, is caught and
 * counted as refused (never throws out of the pull).
 */
async function applyPageReceiptWriteoffs(
  context: ScopedTenantContext,
  raw: unknown,
): Promise<ReceiptWriteoffApplyResult> {
  const count = Array.isArray(raw) ? raw.length : 1;
  try {
    if (!Array.isArray(raw)) refuse("Receipt write-offs are not a list.");
    return await applyDeviceReceiptWriteoffs(context, raw);
  } catch {
    logger.error(
      { refused: count },
      "Edge receipt write-offs of a device page refused (legend-jcby0)",
    );
    return { inserted: 0, skipped: 0, refused: count };
  }
}

/** Splits `receiptSequences` off a raw page (parsed apart, see above). */
function splitPage(raw: unknown): {
  page: unknown;
  sequences: unknown;
  writeoffs: unknown;
  alert: unknown;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return {
      page: raw,
      sequences: undefined,
      writeoffs: undefined,
      alert: undefined,
    };
  // legend-yd0h8: `receiptRunAlert` is split off too, never refusing the page.
  // legend-jcby0: so is `receiptWriteoffs`.
  const { receiptSequences, receiptWriteoffs, receiptRunAlert, ...page } =
    raw as Record<string, unknown>;
  return {
    page,
    sequences: receiptSequences,
    writeoffs: receiptWriteoffs,
    alert: receiptRunAlert,
  };
}

/**
 * legend-yd0h8: this primary edge database's report for a pull: the local
 * counter of every current local run, read in its own short transaction.
 */
async function reportLocalRuns(
  context: ScopedTenantContext,
): Promise<ReceiptRunReport> {
  if (
    context.outletScope.kind !== "outlets" ||
    context.outletScope.outletIds.length !== 1
  )
    refuse("Device sync needs a context of exactly one outlet.");
  const outletId = context.outletScope.outletIds[0]!.toLowerCase();
  return withTenant(db, context, (tx) =>
    localReceiptRunReport(tx, context, outletId),
  );
}

/**
 * Follows `nextCursor` page by page, applying each page durably before asking
 * for the next. The checkpoint (`watermark`) is only returned after the last
 * page was applied (EDG-02). Wiring a periodic pull into the edge runtime is a
 * follow-up; this is the unit it will call.
 */
export async function pullDeviceRegistry(
  options: PullDeviceRegistryOptions,
): Promise<PullDeviceRegistryResult> {
  const maxPages = options.maxPages ?? 1_000;
  const stored = options.since ?? null;
  let since =
    stored === null ? null : rewindWatermark(stored, DEVICE_SYNC_OVERLAP_MS);
  let watermark = stored;
  let applied = 0;
  let skipped = 0;
  let pages = 0;
  let receiptSequencesRefused = 0;
  let receiptSequencesReplaced = 0;
  let receiptSequencesRetired = 0;
  let receiptWriteoffsInserted = 0;
  let receiptWriteoffsSkipped = 0;
  let receiptWriteoffsRefused = 0;
  let receiptRunAlert = false;
  // legend-jcby0: the list is the same on every page; applied once per pull.
  let writeoffsApplied = false;
  // legend-hfq3z: clash refusals to report with the next request: the previous
  // pull's first, then those of the page just applied.
  let pending: ReceiptRunRefusalReport = options.refusals ?? new Map();
  for (;;) {
    if (pages >= maxPages)
      throw new CoreError(
        "CONFLICT",
        "Sinkronisasi registri perangkat melebihi batas halaman.",
      );
    // legend-yd0h8: a primary with a binding reports its local counters before
    // each page; anything else sends no report (no check).
    const report =
      options.role === "primary" && options.binding !== undefined
        ? await reportLocalRuns(options.context).catch(() => {
            // legend-yd0h8: a failed report never stops the pull (device
            // records, revocations); the page goes without the check.
            logger.error("Edge receipt run report failed; pulling without it");
            return undefined;
          })
        : undefined;
    const raw = splitPage(
      await options.fetchPage(
        since,
        report,
        report !== undefined && pending.size > 0 ? pending : undefined,
      ),
    );
    if (raw.alert === true) receiptRunAlert = true;
    const page = deviceSyncPageSchema.parse(raw.page);
    pages += 1;
    const result = await applyDeviceRecords(options.context, page.data);
    applied += result.applied;
    skipped += result.skipped;
    // legend-3yqy: after the device records, so a revocation on the same page
    // has landed whatever happens to the sequences. S-K1: primary only, and a
    // sequence error never throws out of the pull. legend-zsdd: and only
    // with the edge's own binding.
    if (
      raw.sequences !== undefined &&
      options.role === "primary" &&
      options.binding !== undefined
    ) {
      const counts = await applyPageReceiptSequences(
        options.context,
        raw.sequences,
        options.binding,
      );
      receiptSequencesRefused += counts.refused;
      receiptSequencesReplaced += counts.replaced;
      receiptSequencesRetired += counts.retired;
      pending = counts.refusals;
    } else {
      // A cloud that sends no sequences cannot use the report.
      pending = new Map();
    }
    // legend-jcby0: after the page's sequences (a new run is there first);
    // primary with a binding only, never throws out of the pull.
    if (
      !writeoffsApplied &&
      raw.writeoffs !== undefined &&
      options.role === "primary" &&
      options.binding !== undefined
    ) {
      writeoffsApplied = true;
      const counts = await applyPageReceiptWriteoffs(
        options.context,
        raw.writeoffs,
      );
      receiptWriteoffsInserted += counts.inserted;
      receiptWriteoffsSkipped += counts.skipped;
      receiptWriteoffsRefused += counts.refused;
    }
    // An empty page echoes the rewound cursor: keep the stored one instead.
    if (page.data.length > 0) watermark = page.meta.watermark ?? watermark;
    if (page.meta.nextCursor === null) break;
    if (page.meta.nextCursor === since)
      throw new CoreError(
        "CONFLICT",
        "Cursor sinkronisasi registri perangkat tidak maju.",
      );
    since = page.meta.nextCursor;
  }
  return {
    applied,
    skipped,
    pages,
    watermark,
    receiptSequencesRefused,
    receiptSequencesReplaced,
    receiptSequencesRetired,
    receiptWriteoffsInserted,
    receiptWriteoffsSkipped,
    receiptWriteoffsRefused,
    receiptRunAlert,
    receiptRunRefusals: pending,
  };
}
