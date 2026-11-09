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
import {
  deviceReceiptSequenceSyncSchema,
  deviceSyncPageSchema,
  deviceSyncRecordSchema,
  type DeviceReceiptSequenceSync,
  type DeviceSyncPage,
  type DeviceSyncRecord,
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
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.ts";
import { devices } from "../db/schema/device.ts";
import { stations } from "../db/schema/menu.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { outletContext } from "./device-pin-support.ts";
import { logger } from "../lib/logger.ts";
import { toDevice } from "./device.service.ts";
import {
  applyCloudDeviceReceiptSequence,
  backfillDeviceReceiptSequences,
  listDeviceReceiptSequences,
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
  const { limit, receiptSequences: withSequences } =
    deviceSyncQuerySchema.parse(query);
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
    if (withSequences === "1")
      await backfillDeviceReceiptSequences(tx, context, verified.outletId);
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
      withSequences === "1"
        ? await listDeviceReceiptSequences(tx, context, verified.outletId)
        : undefined;
    return { found, sequences };
  });
  const { found: rows, sequences } = result;

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const lastMark = last
    ? encodeWatermark({ version: last.version, id: last.row.id })
    : null;
  return deviceSyncPageSchema.parse({
    data: page.map(({ row }) =>
      deviceSyncRecordSchema.parse({
        ...toDevice(row),
        tokenIssuedAt: row.tokenIssuedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      }),
    ),
    ...(sequences === undefined ? {} : { receiptSequences: sequences }),
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
      await tx
        .update(devices)
        .set({
          stationId,
          label: record.label,
          trainingMode: record.trainingMode,
          status: record.status,
          revokedAt,
          tokenIssuedAt: floorOf(local.tokenIssuedAt),
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
  /** Skipped: prefix mismatch or cloud run already advanced (see below). */
  readonly refused: number;
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
 */
export async function applyDeviceReceiptSequences(
  context: ScopedTenantContext,
  sequences: readonly unknown[],
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
  if (parsed.length === 0) return { inserted: 0, kept: 0, refused: 0 };
  const result = await withTenant(db, context, async (tx) => {
    let inserted = 0;
    let kept = 0;
    let refused = 0;
    for (const sequence of parsed) {
      const outcome = await applyCloudDeviceReceiptSequence(
        tx,
        context,
        sequence,
      );
      if (outcome === "inserted") inserted += 1;
      else if (outcome === "kept") kept += 1;
      else refused += 1;
    }
    return { inserted, kept, refused };
  });
  if (result.refused > 0)
    logger.error(
      { refused: result.refused },
      "Edge receipt sequence refused (prefix mismatch or advanced cloud run): sequence skipped",
    );
  return result;
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
   * Stored watermark from the previous pull; null = first pull. The pull starts
   * `DEVICE_SYNC_OVERLAP_MS` before it.
   */
  readonly since?: string | null;
  /** Fetches one page from the cloud (`GET /api/edge-sync/device-records`). */
  readonly fetchPage: (since: string | null) => Promise<unknown>;
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
): Promise<number> {
  const count = Array.isArray(raw) ? raw.length : 1;
  try {
    if (!Array.isArray(raw)) refuse("Receipt sequences are not a list.");
    return (await applyDeviceReceiptSequences(context, raw)).refused;
  } catch {
    logger.error(
      { refused: count },
      "Edge receipt sequences of a device page refused",
    );
    return count;
  }
}

/** Splits `receiptSequences` off a raw page (parsed apart, see above). */
function splitPage(raw: unknown): { page: unknown; sequences: unknown } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { page: raw, sequences: undefined };
  const { receiptSequences, ...page } = raw as Record<string, unknown>;
  return { page, sequences: receiptSequences };
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
  for (;;) {
    if (pages >= maxPages)
      throw new CoreError(
        "CONFLICT",
        "Sinkronisasi registri perangkat melebihi batas halaman.",
      );
    const raw = splitPage(await options.fetchPage(since));
    const page = deviceSyncPageSchema.parse(raw.page);
    pages += 1;
    const result = await applyDeviceRecords(options.context, page.data);
    applied += result.applied;
    skipped += result.skipped;
    // legend-3yqy: after the device records, so a revocation on the same page
    // has landed whatever happens to the sequences. S-K1: primary only, and a
    // sequence error never throws out of the pull.
    if (raw.sequences !== undefined && options.role === "primary")
      receiptSequencesRefused += await applyPageReceiptSequences(
        options.context,
        raw.sequences,
      );
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
  return { applied, skipped, pages, watermark, receiptSequencesRefused };
}
