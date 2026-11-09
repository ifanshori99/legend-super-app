// Staff pin replication cloud -> outlet edge (bead legend-obh5, from
// legend-dxb; PRD v1.7 §3 F6 "Staf — PIN Perangkat", §6 B staff_pins "(T, E)",
// §5 Sinkronisasi "cloud wins" for master data, EDG-02, TEN-02/TEN-03).
//
// Export (cloud only, `GET /api/edge-sync/staff-pin-records`; not under
// /api/edge, which legend-2pi's EDGE_MODE guard serves only on the edge node):
// - The caller is an edge node, authenticated by its own credential through
//   the `EdgeCredentialVerifier` port. The edge registry (edge_nodes, binding
//   a node — primary or standby — to one tenant and one outlet) is legend-2pi;
//   until it installs a verifier every request is refused (fail closed). The
//   tenant and outlet come only from the verified credential, never from the
//   query or a header the client chose (TEN-02).
// - Records are the hash-only `staffPinEdgeRecordSchema`: hash, salt, scrypt
//   cost, pepper version and lock state. Never the pin, never the pepper.
// - Keyset paging on (sync_xid, id), opaque cursor
//   `[spin2, epoch, sync_xid, id]`. `sync_xid` is the id of the transaction
//   that last wrote the row (column default on insert, trigger on update;
//   migration 0147). A row is exported only when its `sync_xid` is below
//   `pg_snapshot_xmin(pg_current_snapshot())`: every older transaction has
//   finished, so a watermark can never pass a writer that commits late. No
//   clock and no settle window are involved, the order is the commit horizon.
//   `since` is the edge's stored watermark; the edge follows `meta.nextCursor`
//   while it is non-null, applies each page durably, then stores
//   `meta.watermark` (EDG-02: the checkpoint advances only after durable,
//   idempotent application).
// - Restarts (a full resync from the beginning, idempotent on the edge): a
//   `spin1` cursor (the old (updated_at, id) one), a `spin2` cursor without
//   an epoch (the first 3-key form), a cursor whose epoch differs from this
//   database's, and a cursor whose xid is not yet assigned here
//   (`>= pg_snapshot_xmax(pg_current_snapshot())`, "from the future").
//   Transaction ids are only ordered within one database history: a
//   point-in-time restore or an async standby promoted after losing commits
//   hands out xids again that the edge already passed, and the export would
//   skip those writes forever. The epoch is
//   `pg_control_system().system_identifier` (changes on initdb, so on a
//   dump/restore into a new cluster) + ":" + `pg_control_checkpoint().
//   timeline_id` (changes on PITR and promotion, once the first checkpoint
//   on the new timeline is written; until then the future-xid check is the
//   guard) + ":" + `pg_postmaster_start_time()` in microseconds (review K
//   round 2): a restore from a disk or managed snapshot that ends in crash
//   recovery keeps the identifier and the timeline but always starts a new
//   postmaster. A promotion starts a new postmaster too, so it changes the
//   epoch at once, also before the first checkpoint of the new timeline
//   (an immediate failover). The cost is one idempotent full resync per outlet after any
//   database restart. All three functions are executable by PUBLIC, so the
//   restricted app role reads them.
// - Runbook, dump/restore: restored rows keep their old `sync_xid`, which may
//   lie above the new cluster's counter and stay invisible to the export
//   until the counter passes it. After such a restore, restamp every row with
//   an UPDATE that touches each one (e.g. `UPDATE staff_pins SET
//   sync_xid = sync_xid`, run with FORCE RLS lifted as in migration 0141); the
//   trigger stamps the current xid.
// - Runbook, durability: the cloud database must run with
//   `synchronous_commit = on` and `fsync = on`. A commit that was exported and
//   then lost in a crash would hand its xid out again, and the edge, already
//   past it, would skip the new write.
// - Long transactions (infra, review K F3): an open write transaction
//   anywhere in the cluster holds `pg_snapshot_xmin` back, so it delays the
//   export (never loses a row) until it ends. Set
//   `idle_in_transaction_session_timeout` for the app and worker roles and
//   alert when the export horizon lags (legend-4z2ch, ops).
// - Each record carries `pinGenerationAt`, the exact microsecond order key of
//   the pin generation (`staff_pins.pin_generation_at`, legend-kyie).
//
// Pepper provisioning (out of band, never in this payload). The edge verifies
// offline with `record + pepper`. The pepper is installed on the edge box by
// the operator, through the deployment's secret store, as the environment
// variable STAFF_PIN_PEPPER — the same value the cloud uses, so
// `staffPinPepper(tenantId)` (HKDF per tenant, device-pin-pepper.ts) derives
// the same per-tenant pepper there. It is never sent over HTTP, logged,
// audited, put in an event or in this response. Rotation follows
// docs/deployment.md "Staff device pins" (bump the pepper version, staff set
// new pins; old rows stop verifying on the edge as on the cloud). Follow-up:
// provision only the tenant-derived pepper to an edge box instead of the root
// secret, so a stolen edge box cannot derive other tenants' peppers.
//
// Apply (edge, `applyStaffPinRecords`): idempotent, cloud wins. Runs on the
// edge's own database, on the outlet-scoped context of the edge node. One
// transaction for the whole page, so a failure applies nothing and the
// watermark does not move. Generations are ordered by the generation key
// (`pinGenerationAt`) only, never by a clock of this node: the cloud `updatedAt`
// is a cloud clock and the local `created_at` / `updated_at` may come from an
// edge clock that ran behind, so comparing them let an older cloud row (e.g. an
// attempt bump of the old pin) replace a newer pin set on the edge.
// - unknown (outlet, user)        -> insert; the record key is stored as
//   `pin_generation_at` and `pin_set_at`;
// - other hash material (a reset) -> replace when `record key >= local key`
//   (a tie goes to the cloud, the same rule as the cloud's own set); a newer
//   local failed attempt cannot block a cloud reset, an older generation
//   replayed late never wins;
// - same hash material            -> raise the counter / lock to the record's
//   only when the record is above the last cloud values this edge received
//   (`cloud_failed_attempts`, `cloud_locked_until`; legend-7vv8h: a full
//   resync replays old values the edge may have cleared), never lower it, keep
//   the later key; nothing to change writes nothing.
// Every insert, replace and merge also raises `cloud_generation_at` to the
// record key (the highest cloud key this edge has seen). The next edge set is
// stamped `GREATEST(edge now, LEAST(key, GREATEST(edge now,
// cloud_generation_at) + 5 min) + 1 ms)` (device-pin.service.ts), so it lands
// after the cloud generation it replaced even when the edge clock runs far
// behind a recent cloud reset, and the cloud adopts it.
// No audit or outbox from apply: it mirrors cloud state, and an event here
// would echo back to the cloud.

import {
  STAFF_PIN_HASH_ALGORITHM,
  staffPinEdgeRecordSchema,
  type StaffPinEdgeRecord,
} from "@starter/shared/access/override";
import {
  assertOutletInScope,
  CoreError,
  cursorSchema,
  decodeCursor,
  encodeCursor,
  outletIdSchema,
  PAGE_LIMIT_MAX,
  tenantIdSchema,
  uuidSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.ts";
import { staffPins } from "../db/schema/device-pin.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
import { withoutSecretErrorDetail } from "../edge/envelope-secrets.ts";
import { outletContext } from "./device-pin-support.ts";

// ------------------------------------------------------- edge credential port

/**
 * An edge node presents its credential as `Authorization: Bearer <token>`
 * (the same `edg1.` link credential legend-2pi mints; opaque here). The URL
 * never carries it. Returns null for an absent or malformed header.
 */
export function edgeCredentialFromAuthorization(
  header: string | undefined,
): string | null {
  if (header === undefined) return null;
  const match = /^Bearer ([\x21-\x7e]+)$/.exec(header);
  return match?.[1] ?? null;
}

/** What a verified edge credential names: one node of one outlet of one tenant. */
export const verifiedEdgeNodeSchema = z.strictObject({
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  edgeNodeId: uuidSchema,
});
export type VerifiedEdgeNode = z.infer<typeof verifiedEdgeNodeSchema>;

/**
 * Verifies an edge node credential server-side (legend-2pi: edge_nodes
 * registry, active node, tenant active, outlet binding). Returns null for an
 * absent, malformed, revoked or foreign credential.
 */
export type EdgeCredentialVerifier = (input: {
  readonly credential: string;
  readonly now: Date;
}) => Promise<VerifiedEdgeNode | null>;

const denyAllEdgeNodes: EdgeCredentialVerifier = async () => null;
let edgeCredentialVerifier: EdgeCredentialVerifier = denyAllEdgeNodes;

/** Installs the edge registry verifier; null restores deny-all. */
export function setEdgeCredentialVerifier(
  next: EdgeCredentialVerifier | null,
): void {
  edgeCredentialVerifier = next ?? denyAllEdgeNodes;
}

const credentialSchema = z
  .string()
  .min(16)
  .max(2048)
  .regex(/^[\x21-\x7e]+$/);

/**
 * The verified edge node, or null. Never throws and never logs the
 * credential: a verifier error or an answer of the wrong shape is "denied".
 */
export async function verifyEdgeCredential(
  credential: string | null | undefined,
  now: Date = new Date(),
): Promise<VerifiedEdgeNode | null> {
  const parsed = credentialSchema.safeParse(credential);
  if (!parsed.success) return null;
  let answer: unknown;
  try {
    answer = await edgeCredentialVerifier({ credential: parsed.data, now });
  } catch {
    return null;
  }
  const node = verifiedEdgeNodeSchema.safeParse(answer);
  return node.success ? node.data : null;
}

// ------------------------------------------------------------------- export

export const STAFF_PIN_SYNC_LIMIT_DEFAULT = PAGE_LIMIT_MAX;

export const staffPinSyncQuerySchema = z.strictObject({
  since: cursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PAGE_LIMIT_MAX)
    .default(STAFF_PIN_SYNC_LIMIT_DEFAULT),
});
export type StaffPinSyncQuery = z.infer<typeof staffPinSyncQuerySchema>;

export const staffPinSyncPageSchema = z.strictObject({
  data: z.array(staffPinEdgeRecordSchema),
  meta: z.strictObject({
    limit: z.number().int().min(1).max(PAGE_LIMIT_MAX),
    /** Non-null while more rows follow: request again with `since` = this. */
    nextCursor: cursorSchema.nullable(),
    /** Store after applying the page; null = nothing replicated yet. */
    watermark: cursorSchema.nullable(),
  }),
});
export type StaffPinSyncPage = z.infer<typeof staffPinSyncPageSchema>;

const CURSOR_TAG = "spin2";
/** The old (updated_at, id) cursor: restarts from the beginning (see header). */
const LEGACY_CURSOR_TAG = "spin1";
const XID_PATTERN = /^\d{1,20}$/;
const XID8_MAX = 18446744073709551615n;
/** A decimal xid8: 20 digits can exceed 64 bits, and the cast would fail. */
function isXid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    XID_PATTERN.test(value) &&
    BigInt(value) <= XID8_MAX
  );
}
/** `<system_identifier>:<timeline_id>:<postmaster start, µs>` (see header). */
const EPOCH_PATTERN = /^\d{1,20}:\d{1,10}:\d{1,20}$/;

type Watermark = {
  readonly epoch: string;
  readonly xid: string;
  readonly id: string;
};

function invalidCursor(): never {
  throw new CoreError("VALIDATION_ERROR", "Cursor sinkronisasi tidak valid.");
}

/**
 * The stored watermark, or null to restart from the beginning (no cursor, a
 * `spin1` cursor, or a 3-key `spin2` cursor from before the epoch existed).
 * A malformed cursor is a validation error. The epoch and the "from the
 * future" checks need the database and run in `listStaffPinRecordsSince`.
 */
function parseWatermark(cursor: string | undefined): Watermark | null {
  if (cursor === undefined) return null;
  let keys: unknown[];
  try {
    keys = decodeCursor(cursor);
  } catch {
    invalidCursor();
  }
  const [tag] = keys;
  if (tag === LEGACY_CURSOR_TAG) return null;
  if (tag !== CURSOR_TAG) invalidCursor();
  if (keys.length === 3) {
    const [, xid, id] = keys;
    if (!isXid(xid) || !uuidSchema.safeParse(id).success) invalidCursor();
    // No epoch: it cannot be proven to come from this database history.
    return null;
  }
  const [, epoch, xid, id, extra] = keys;
  if (
    keys.length !== 4 ||
    typeof epoch !== "string" ||
    !EPOCH_PATTERN.test(epoch) ||
    !isXid(xid) ||
    !uuidSchema.safeParse(id).success ||
    extra !== undefined
  )
    invalidCursor();
  return { epoch, xid, id: String(id) };
}

function encodeWatermark(mark: Watermark): string {
  return encodeCursor([CURSOR_TAG, mark.epoch, mark.xid, mark.id]);
}

/** Exact (microsecond, UTC) ISO text of a timestamptz column. */
const microsecondText = (column: typeof staffPins.pinGenerationAt) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * One page of the edge node's outlet staff pins changed after `since`, in
 * commit order ((sync_xid, id)), only rows every older transaction of which
 * has finished. Tenant and outlet come only from `node`.
 */
export async function listStaffPinRecordsSince(
  node: VerifiedEdgeNode,
  query: StaffPinSyncQuery,
): Promise<StaffPinSyncPage> {
  const verified = verifiedEdgeNodeSchema.parse(node);
  const { limit } = staffPinSyncQuerySchema.parse(query);
  const stored = parseWatermark(query.since);
  const tenant = establishTenantContext({
    tenantId: verified.tenantId,
    brandId: null,
    source: "device",
  });
  const context = outletContext(tenant, verified.outletId);

  const { rows, epoch, since } = await withTenant(db, context, async (tx) => {
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
    // The database epoch, and whether the stored xid is not yet assigned
    // here (a cursor "from the future"). Either mismatch means the cursor
    // comes from another database history (restore, promoted standby), whose
    // xids may be reused: restart from the beginning (see header).
    const horizon = await tx.execute<{ epoch: string; future: boolean }>(
      sql`SELECT (SELECT system_identifier::text FROM pg_control_system()) || ':' ||
                 (SELECT timeline_id::text FROM pg_control_checkpoint()) || ':' ||
                 ((extract(epoch FROM pg_postmaster_start_time()) * 1000000)::bigint)::text AS epoch,
                 ${stored === null ? sql`false` : sql`${stored.xid}::xid8 >= pg_snapshot_xmax(pg_current_snapshot())`} AS future`,
    );
    const current = horizon.rows[0]!;
    const since =
      stored !== null && stored.epoch === current.epoch && !current.future
        ? stored
        : null;
    const found = await tx
      .select({
        row: staffPins,
        xid: sql<string>`${staffPins.syncXid}::text`,
        generation: microsecondText(staffPins.pinGenerationAt),
      })
      .from(staffPins)
      .where(
        and(
          eq(staffPins.tenantId, verified.tenantId),
          eq(staffPins.outletId, verified.outletId),
          // Every writer older than this snapshot has finished (see header).
          sql`${staffPins.syncXid} < pg_snapshot_xmin(pg_current_snapshot())`,
          since === null
            ? undefined
            : sql`(${staffPins.syncXid}, ${staffPins.id}) > (${since.xid}::xid8, ${since.id}::uuid)`,
        ),
      )
      .orderBy(asc(staffPins.syncXid), asc(staffPins.id))
      .limit(limit + 1);
    return { rows: found, epoch: current.epoch, since };
  });

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const lastMark = last
    ? encodeWatermark({ epoch, xid: last.xid, id: last.row.id })
    : null;
  return staffPinSyncPageSchema.parse({
    data: page.map(({ row, generation }) =>
      staffPinEdgeRecordSchema.parse({
        id: row.id,
        tenantId: row.tenantId,
        outletId: row.outletId,
        userId: row.userId,
        algorithm: STAFF_PIN_HASH_ALGORITHM,
        salt: row.pinSalt,
        pinHash: row.pinHash,
        params: { N: row.kdfN, r: row.kdfR, p: row.kdfP, keyLength: 32 },
        pepperVersion: row.pepperVersion,
        failedAttempts: row.failedAttempts,
        lockedUntil: row.lockedUntil?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
        pinGenerationAt: generation,
      }),
    ),
    meta: {
      limit,
      nextCursor: rows.length > limit ? lastMark : null,
      // A legacy, foreign-epoch or future cursor is not carried over: the
      // edge restarts from the beginning.
      watermark: lastMark ?? (since === null ? null : encodeWatermark(since)),
    },
  });
}

// -------------------------------------------------------------------- apply

export type StaffPinApplyResult = {
  readonly applied: number;
  readonly skipped: number;
};

type LocalRow = typeof staffPins.$inferSelect;

function sameMaterial(local: LocalRow, record: StaffPinEdgeRecord): boolean {
  return (
    local.pinHash === record.pinHash &&
    local.pinSalt === record.salt &&
    local.kdfN === record.params.N &&
    local.kdfR === record.params.r &&
    local.kdfP === record.params.p &&
    local.pepperVersion === record.pepperVersion
  );
}

function refuse(message: string): never {
  throw new CoreError("VALIDATION_ERROR", message);
}

/**
 * Edge side: ingests one page of cloud records (idempotent, ordered by the
 * generation key, cloud wins; see the header). Every record must be of `context`'s tenant and
 * inside its outlet scope; one bad record refuses the whole page.
 */
export async function applyStaffPinRecords(
  context: ScopedTenantContext,
  records: readonly unknown[],
): Promise<StaffPinApplyResult> {
  const tenantId = context.tenant.tenantId.toLowerCase();
  const parsed: StaffPinEdgeRecord[] = records.map((raw) => {
    const result = staffPinEdgeRecordSchema.safeParse(raw);
    if (!result.success) refuse("Staff pin record has an unknown shape.");
    return result.data;
  });
  const seen = new Set<string>();
  for (const record of parsed) {
    if (record.tenantId.toLowerCase() !== tenantId)
      refuse("Staff pin record belongs to another tenant.");
    assertOutletInScope(context.outletScope, record.outletId);
    const key = `${record.outletId}:${record.userId}`.toLowerCase();
    const id = record.id.toLowerCase();
    if (seen.has(key) || seen.has(id))
      refuse("Staff pin page repeats a record.");
    seen.add(key);
    seen.add(id);
  }
  // Same order on every node, so two concurrent pages lock users the same way.
  const ordered = [...parsed].sort((a, b) => a.id.localeCompare(b.id));

  return withTenant(db, context, async (tx) => {
    let applied = 0;
    for (const record of ordered) {
      const version = new Date(record.updatedAt);
      // Exact microsecond key, compared and stored by the database: a JS Date
      // would cut it to milliseconds and turn a tie into a false "newer".
      const key = sql`${record.pinGenerationAt}::timestamptz`;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-pin-sync:${tenantId}:${record.outletId}:${record.userId}`.toLowerCase()}, 0))`,
      );
      const [found] = await tx
        .select({
          row: staffPins,
          // 1 = the record key is later, 0 = equal, -1 = earlier.
          keyOrder: sql<number>`CASE WHEN ${key} > ${staffPins.pinGenerationAt} THEN 1 WHEN ${key} = ${staffPins.pinGenerationAt} THEN 0 ELSE -1 END`,
          // The record key is above the last cloud key this edge stored.
          cloudKeyLater: sql<boolean>`${staffPins.cloudGenerationAt} IS NULL OR ${key} > ${staffPins.cloudGenerationAt}`,
        })
        .from(staffPins)
        .where(
          and(
            eq(staffPins.tenantId, record.tenantId),
            eq(staffPins.outletId, record.outletId),
            eq(staffPins.userId, record.userId),
          ),
        )
        .for("update");
      const local = found?.row;
      const material = {
        pinHash: record.pinHash,
        pinSalt: record.salt,
        kdfN: record.params.N,
        kdfR: record.params.r,
        kdfP: record.params.p,
        pepperVersion: record.pepperVersion,
        failedAttempts: record.failedAttempts,
        lockedUntil:
          record.lockedUntil === null ? null : new Date(record.lockedUntil),
      };
      if (!local) {
        const [clash] = await tx
          .select({ id: staffPins.id })
          .from(staffPins)
          .where(
            and(
              eq(staffPins.tenantId, record.tenantId),
              eq(staffPins.id, record.id),
            ),
          );
        if (clash)
          throw new CoreError(
            "CONFLICT",
            "Staff pin record id is used by another staff pin.",
          );
        // A failed write can quote the hash and salt in a driver error
        // (legend-kyie round 3 R3): rethrown without them.
        await withoutSecretErrorDetail("Staff pin sync write failed", () =>
          tx.insert(staffPins).values({
            id: record.id,
            tenantId: record.tenantId,
            outletId: record.outletId,
            userId: record.userId,
            ...material,
            // The record does not carry who set it; the owner is the closest
            // non-secret, existing user reference.
            setBy: record.userId,
            // The cloud key orders this generation; the edge's own next set
            // is stamped after it (see header).
            pinGenerationAt: key,
            pinSetAt: key,
            cloudGenerationAt: key,
            cloudFailedAttempts: record.failedAttempts,
            cloudLockedUntil: material.lockedUntil,
            createdAt: version,
            updatedAt: version,
          }),
        );
        applied += 1;
        continue;
      }
      if (!sameMaterial(local, record)) {
        // A pin set or reset on the cloud: a tie or a later key wins. An
        // earlier key is an older generation replayed late.
        if (found!.keyOrder < 0) continue;
        await withoutSecretErrorDetail("Staff pin sync write failed", () =>
          tx
            .update(staffPins)
            .set({
              ...material,
              pinGenerationAt: key,
              pinSetAt: key,
              cloudGenerationAt: sql`GREATEST(${staffPins.cloudGenerationAt}, ${key})`,
              // The record's lock state is also the new local one (material),
              // so it is the baseline of the next same-material merge.
              cloudFailedAttempts: record.failedAttempts,
              cloudLockedUntil: material.lockedUntil,
              updatedAt: version,
            })
            .where(eq(staffPins.id, local.id)),
        );
        applied += 1;
        continue;
      }
      // Same pin material: merge the lock state whatever the clocks say, so
      // it never weakens the edge (legend-kyie review K F2): the cloud
      // adopting an edge pin writes a cleared counter, and copying that back
      // would briefly unlock the edge. Nothing on the cloud clears a lock while
      // keeping the hash (a reset brings new material, handled above). A
      // correct PIN entered on the cloud does clear the cloud counter with the
      // same hash; the edge keeps its higher counter (accepted: it never
      // weakens the edge, at worst it locks one guess earlier).
      // The merge only follows the cloud's own movement (legend-7vv8h): the
      // cloud epoch changes on every cloud restart and the edge then replays
      // the full export, so a record whose counter or lock equals the last
      // one this edge received (`cloud_failed_attempts`,
      // `cloud_locked_until`) is a replay, not a new failure. Without that,
      // GREATEST against the raw cloud values restored a counter or lock the
      // edge had already cleared (a correct PIN, AUTH-06). "Differs", not
      // "above": the cloud counter can go down too (a correct PIN on the
      // cloud resets it to 0), so a new cloud failure may sit below the
      // stored baseline and must still count. The raise is still only taken
      // when it is above the local value. A null baseline (a row from before
      // the columns existed, or a new pin) treats the record as new. The
      // record's values always become the new baseline.
      const recordLock = material.lockedUntil;
      const counterRaised =
        record.failedAttempts !== (local.cloudFailedAttempts ?? -1) &&
        record.failedAttempts > local.failedAttempts;
      const lockRaised =
        recordLock !== null &&
        (local.cloudLockedUntil === null ||
          recordLock.getTime() !== local.cloudLockedUntil.getTime()) &&
        (local.lockedUntil === null ||
          recordLock.getTime() > local.lockedUntil.getTime());
      const baselineMoved =
        local.cloudFailedAttempts !== record.failedAttempts ||
        (local.cloudLockedUntil?.getTime() ?? null) !==
          (recordLock?.getTime() ?? null);
      const changed =
        found!.keyOrder > 0 ||
        found!.cloudKeyLater ||
        counterRaised ||
        lockRaised;
      if (!changed && !baselineMoved) continue;
      await tx
        .update(staffPins)
        .set({
          ...(counterRaised ? { failedAttempts: record.failedAttempts } : {}),
          ...(lockRaised ? { lockedUntil: recordLock } : {}),
          cloudFailedAttempts: record.failedAttempts,
          cloudLockedUntil: recordLock,
          pinGenerationAt: sql`GREATEST(${staffPins.pinGenerationAt}, ${key})`,
          cloudGenerationAt: sql`GREATEST(${staffPins.cloudGenerationAt}, ${key})`,
        })
        .where(eq(staffPins.id, local.id));
      // A baseline-only write changes nothing the edge acts on: not "applied".
      if (!changed) continue;
      applied += 1;
    }
    return { applied, skipped: ordered.length - applied };
  });
}
