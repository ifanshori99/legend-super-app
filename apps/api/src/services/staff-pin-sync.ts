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
// - Keyset paging on (updated_at, id), opaque cursor. `since` is the edge's
//   stored watermark; the edge follows `meta.nextCursor` while it is non-null,
//   applies each page durably, then stores `meta.watermark` (EDG-02: the
//   checkpoint advances only after durable, idempotent application).
// - Settle window: rows updated in the last STAFF_PIN_SYNC_SETTLE_MS are held
//   back, so a transaction that took its `updated_at` before a concurrent one
//   but commits after it is not skipped by an already-advanced watermark.
//   The cutoff is `now() - window` evaluated by the database, never the app
//   clock, so app/DB clock skew cannot release unsettled rows (legend-wg5t).
//   Residual risk: a writer whose commit lags its `updated_at` by more than the
//   window (follow-up: a commit-ordered sync version column).
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
// Apply (edge, `applyStaffPinRecords`): idempotent, version monotonic, cloud
// wins. Runs on the edge's own database, on the outlet-scoped context of the
// edge node. One transaction for the whole page, so a failure applies nothing
// and the watermark does not move. On the edge copy `created_at` holds the
// cloud version (`updatedAt`) of the pin generation currently stored, and
// `updated_at` the cloud version of the last lock-state write (or a newer
// local attempt):
// - unknown (outlet, user)        -> insert;
// - other hash material (a reset) -> replace when the record is newer than the
//   stored generation (`created_at`). A newer local failed attempt cannot
//   block a cloud reset; an older generation replayed late never wins;
// - same hash material            -> merge lock state (higher counter, later
//   lock) when the record is newer than `updated_at`; equal or older is a
//   replay and changes nothing.
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
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.ts";
import { staffPins } from "../db/schema/device-pin.ts";
import { outlets, tenants } from "../db/schema/platform-org.ts";
import { withTenant } from "../db/tenant.ts";
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

/** Rows younger than this are held back (see "Settle window" above). */
export const STAFF_PIN_SYNC_SETTLE_MS = 5_000;
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

const CURSOR_TAG = "spin1";
const VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type Watermark = { readonly version: string; readonly id: string };

function parseWatermark(cursor: string | undefined): Watermark | null {
  if (cursor === undefined) return null;
  let keys: unknown[];
  try {
    keys = decodeCursor(cursor);
  } catch {
    throw new CoreError("VALIDATION_ERROR", "Cursor sinkronisasi tidak valid.");
  }
  const [tag, version, id, extra] = keys;
  if (
    tag !== CURSOR_TAG ||
    typeof version !== "string" ||
    !VERSION_PATTERN.test(version) ||
    !uuidSchema.safeParse(id).success ||
    extra !== undefined
  )
    throw new CoreError("VALIDATION_ERROR", "Cursor sinkronisasi tidak valid.");
  return { version, id: String(id) };
}

function encodeWatermark(mark: Watermark): string {
  return encodeCursor([CURSOR_TAG, mark.version, mark.id]);
}

/** Exact (microsecond, UTC) text of `updated_at`: the keyset version. */
const versionOf = sql<string>`to_char(${staffPins.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export type ListStaffPinRecordsOptions = {
  /**
   * Explicit clock override for tests only. Production leaves it unset: the
   * settle cutoff is then computed from the DATABASE clock (legend-wg5t item 5),
   * the same clock that stamped `updated_at`.
   */
  readonly now?: Date;
  /** Override the settle window (tests); never negative. */
  readonly settleMs?: number;
};

/**
 * One page of the edge node's outlet staff pins changed after `since`, in
 * (updated_at, id) order. Tenant and outlet come only from `node`.
 */
export async function listStaffPinRecordsSince(
  node: VerifiedEdgeNode,
  query: StaffPinSyncQuery,
  options: ListStaffPinRecordsOptions = {},
): Promise<StaffPinSyncPage> {
  const verified = verifiedEdgeNodeSchema.parse(node);
  const { limit } = staffPinSyncQuerySchema.parse(query);
  const since = parseWatermark(query.since);
  const settleMs = Math.max(0, options.settleMs ?? STAFF_PIN_SYNC_SETTLE_MS);
  // legend-wg5t item 5: `updated_at` comes from the database, so the cutoff
  // must too. An app clock ahead of the DB would release rows that are still
  // inside the settle window and let the edge's watermark skip a late commit.
  const cutoff =
    options.now === undefined
      ? sql`now() - (${settleMs}::double precision * interval '1 millisecond')`
      : new Date(options.now.getTime() - settleMs);
  const tenant = establishTenantContext({
    tenantId: verified.tenantId,
    brandId: null,
    source: "device",
  });
  const context = outletContext(tenant, verified.outletId);

  const rows = await withTenant(db, context, async (tx) => {
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
    return tx
      .select({ row: staffPins, version: versionOf })
      .from(staffPins)
      .where(
        and(
          eq(staffPins.tenantId, verified.tenantId),
          eq(staffPins.outletId, verified.outletId),
          lte(staffPins.updatedAt, cutoff),
          since === null
            ? undefined
            : sql`(${staffPins.updatedAt}, ${staffPins.id}) > (${since.version}::timestamptz, ${since.id}::uuid)`,
        ),
      )
      .orderBy(asc(staffPins.updatedAt), asc(staffPins.id))
      .limit(limit + 1);
  });

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const lastMark = last
    ? encodeWatermark({ version: last.version, id: last.row.id })
    : null;
  return staffPinSyncPageSchema.parse({
    data: page.map(({ row }) =>
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
      }),
    ),
    meta: {
      limit,
      nextCursor: rows.length > limit ? lastMark : null,
      watermark: lastMark ?? query.since ?? null,
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
 * Edge side: ingests one page of cloud records (idempotent, version monotonic,
 * cloud wins; see the header). Every record must be of `context`'s tenant and
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
  const ordered = [...parsed].sort(
    (a, b) =>
      Date.parse(a.updatedAt) - Date.parse(b.updatedAt) ||
      a.id.localeCompare(b.id),
  );

  return withTenant(db, context, async (tx) => {
    let applied = 0;
    for (const record of ordered) {
      const version = new Date(record.updatedAt);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`staff-pin-sync:${tenantId}:${record.outletId}:${record.userId}`.toLowerCase()}, 0))`,
      );
      const [local] = await tx
        .select()
        .from(staffPins)
        .where(
          and(
            eq(staffPins.tenantId, record.tenantId),
            eq(staffPins.outletId, record.outletId),
            eq(staffPins.userId, record.userId),
          ),
        )
        .for("update");
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
        await tx.insert(staffPins).values({
          id: record.id,
          tenantId: record.tenantId,
          outletId: record.outletId,
          userId: record.userId,
          ...material,
          // The record does not carry who set it; the owner is the closest
          // non-secret, existing user reference.
          setBy: record.userId,
          createdAt: version,
          updatedAt: version,
        });
        applied += 1;
        continue;
      }
      if (!sameMaterial(local, record)) {
        // A pin set or reset on the cloud: newer generation wins.
        if (version.getTime() <= local.createdAt.getTime()) continue;
        await tx
          .update(staffPins)
          .set({ ...material, createdAt: version, updatedAt: version })
          .where(eq(staffPins.id, local.id));
        applied += 1;
        continue;
      }
      // Same pin generation: lock state of a newer version, merged so it
      // never weakens the edge (legend-kyie review K F2): the cloud adopting
      // an edge pin writes a cleared counter, and copying that back would
      // briefly unlock the edge. Nothing on the cloud clears a lock while
      // keeping the hash (a reset brings new material, handled above). A
      // correct PIN entered on the cloud does clear the cloud counter with the
      // same hash; the edge keeps its higher counter (accepted: it never
      // weakens the edge, at worst it locks one guess earlier).
      if (version.getTime() <= local.updatedAt.getTime()) continue;
      await tx
        .update(staffPins)
        .set({
          failedAttempts: sql`GREATEST(${staffPins.failedAttempts}, ${material.failedAttempts})`,
          lockedUntil:
            material.lockedUntil === null
              ? sql`${staffPins.lockedUntil}`
              : sql`GREATEST(${staffPins.lockedUntil}, ${material.lockedUntil.toISOString()}::timestamptz)`,
          updatedAt: version,
        })
        .where(eq(staffPins.id, local.id));
      applied += 1;
    }
    return { applied, skipped: ordered.length - applied };
  });
}
