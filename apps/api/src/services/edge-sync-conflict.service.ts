// Sync conflict review + replay (bead legend-wqc6; PRD v1.7 §3 F5
// "Sinkronisasi", EDG-02).
//
// `edge_sync_conflicts` rows (written by db-link-store.applyInbound) are
// append-only evidence. A supervisor reviews them here and either replays the
// refused envelope through the installed applier or dismisses it; each
// decision is a NEW `edge_sync_conflict_resolutions` row. "Open" means no
// resolution with outcome `applied` or `dismissed` exists, so a failed replay
// leaves the conflict open for another try.
//
// - list/get: tenant + outlet scoped (RLS plus explicit filters), keyset
//   newest first.
// - resolve: the conflict is locked FOR UPDATE, so two supervisors cannot
//   resolve it at once; an already-resolved conflict is returned unchanged.
//   A replay runs the applier in a savepoint: if it throws, only the
//   applier's writes roll back and the failure is recorded (outcome `failed`).
// The alert for a NEW conflict lives in edge-sync-conflict-alert.ts (no
// database singleton, so the link store can import it).
//
// Only conflicts stored in this database are handled: the cloud reviews the
// edge_to_cloud conflicts of its own database.
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  assertOutletInScope,
  assertTrustedScopedContext,
  CoreError,
  createUlid,
  decodeCursor,
  encodeCursor,
  toIsoDateTime,
  ulidToUuid,
  uuidSchema,
  outletIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  edgeSyncConflictDetailSchema,
  edgeSyncConflictResolutionSchema,
  edgeSyncConflictSummarySchema,
  type EdgeSyncConflictDetail,
  type EdgeSyncConflictListQuery,
  type EdgeSyncConflictResolution,
  type EdgeSyncConflictSummary,
  type ResolveEdgeSyncConflictBody,
} from "@starter/shared/edge";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { edgeNodes, edgeSyncConflicts } from "../db/schema/edge-node.ts";
import { edgeSyncConflictResolutions } from "../db/schema/edge-sync-conflict.ts";
import { withTenant } from "../db/tenant.ts";
import { decideInbound } from "../edge/conflict.ts";
import { defaultLastSequence } from "../edge/db-link-store.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
import { recordAudit } from "./audit-writer.ts";
import { lockSyncCursor, type EdgeTx } from "./edge-queue.service.ts";

type ConflictRow = typeof edgeSyncConflicts.$inferSelect;
type ResolutionRow = typeof edgeSyncConflictResolutions.$inferSelect;

/** Resolutions with these outcomes close a conflict. */
const CLOSING_OUTCOMES = ["applied", "dismissed"] as const;
const ERROR_MAX_LENGTH = 1000;
/** ULIDs stored as uuid bytes are not RFC-versioned, so check the shape only. */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `created_at::text` keeps the microseconds a JS Date would drop. */
const CURSOR_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[ T][0-9:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

const notFound = () =>
  new CoreError("NOT_FOUND", "Konflik sinkronisasi tidak ditemukan.");

function toResolution(row: ResolutionRow): EdgeSyncConflictResolution {
  return edgeSyncConflictResolutionSchema.parse({
    id: row.id,
    conflictId: row.conflictId,
    action: row.action,
    outcome: row.outcome,
    error: row.error,
    note: row.note,
    resolvedBy: row.resolvedBy,
    resolvedAt: toIsoDateTime(row.resolvedAt),
  });
}

const isClosing = (resolution: { outcome: string }) =>
  (CLOSING_OUTCOMES as readonly string[]).includes(resolution.outcome);

function summaryFields(row: ConflictRow, resolutions: ResolutionRow[]) {
  const last = resolutions.at(-1);
  return {
    id: row.id,
    tenantId: row.tenantId,
    outletId: row.outletId,
    edgeNodeId: row.edgeNodeId,
    direction: row.direction,
    eventId: row.eventId,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    aggregateSequence: row.aggregateSequence,
    kind: row.kind,
    reason: row.reason,
    detail: row.detail,
    resolution: row.resolution,
    existingSequence: row.existingSequence,
    status: resolutions.some(isClosing) ? "resolved" : "open",
    createdAt: toIsoDateTime(row.createdAt),
    lastResolution: last ? toResolution(last) : null,
  };
}

function toSummary(
  row: ConflictRow,
  resolutions: ResolutionRow[],
): EdgeSyncConflictSummary {
  return edgeSyncConflictSummarySchema.parse(summaryFields(row, resolutions));
}

function toDetail(
  row: ConflictRow,
  resolutions: ResolutionRow[],
): EdgeSyncConflictDetail {
  return edgeSyncConflictDetailSchema.parse({
    ...summaryFields(row, resolutions),
    event: row.event,
    resolutions: resolutions.map(toResolution),
  });
}

async function resolutionsOf(
  tx: EdgeTx,
  tenantId: TenantId,
  conflictIds: string[],
): Promise<Map<string, ResolutionRow[]>> {
  const byConflict = new Map<string, ResolutionRow[]>();
  if (conflictIds.length === 0) return byConflict;
  const rows = await tx
    .select()
    .from(edgeSyncConflictResolutions)
    .where(
      and(
        eq(edgeSyncConflictResolutions.tenantId, tenantId),
        inArray(edgeSyncConflictResolutions.conflictId, conflictIds),
      ),
    )
    .orderBy(
      asc(edgeSyncConflictResolutions.resolvedAt),
      asc(edgeSyncConflictResolutions.id),
    );
  for (const row of rows) {
    const list = byConflict.get(row.conflictId) ?? [];
    list.push(row);
    byConflict.set(row.conflictId, list);
  }
  return byConflict;
}

/**
 * Keyset page, newest first: `{ items, nextCursor }`. The route requires the
 * outlet filter; the service also accepts a tenant-wide caller without one.
 */
export async function listEdgeSyncConflicts(
  context: ScopedTenantContext,
  query: Pick<EdgeSyncConflictListQuery, "limit" | "status"> & {
    outletId?: string;
    edgeNodeId?: string;
    cursor?: string;
  },
): Promise<{
  items: EdgeSyncConflictSummary[];
  nextCursor: string | null;
}> {
  assertTrustedScopedContext(context);
  const outletId = query.outletId
    ? outletIdSchema.parse(query.outletId)
    : undefined;
  if (outletId) assertOutletInScope(context.outletScope, outletId);
  let after: [string, string] | null = null;
  if (query.cursor) {
    let keys;
    try {
      keys = decodeCursor(query.cursor);
    } catch {
      throw new CoreError("VALIDATION_ERROR", "Kursor tidak valid.");
    }
    if (
      keys.length !== 2 ||
      typeof keys[0] !== "string" ||
      typeof keys[1] !== "string" ||
      !CURSOR_TIMESTAMP.test(keys[0]) ||
      !UUID_SHAPE.test(keys[1])
    )
      throw new CoreError("VALIDATION_ERROR", "Kursor tidak valid.");
    after = [keys[0], keys[1]];
  }
  const tenantId = context.tenant.tenantId;
  const closed = sql`EXISTS (SELECT 1 FROM edge_sync_conflict_resolutions r WHERE r.tenant_id = ${edgeSyncConflicts.tenantId} AND r.conflict_id = ${edgeSyncConflicts.id} AND r.outcome IN ('applied', 'dismissed'))`;
  const conditions = [
    eq(edgeSyncConflicts.tenantId, tenantId),
    outletId ? eq(edgeSyncConflicts.outletId, outletId) : undefined,
    // A caller reaching only some outlets never sees the others (RLS also
    // enforces it; this keeps the intent explicit).
    context.outletScope.kind === "outlets"
      ? inArray(edgeSyncConflicts.outletId, [...context.outletScope.outletIds])
      : undefined,
    query.edgeNodeId
      ? eq(edgeSyncConflicts.edgeNodeId, query.edgeNodeId)
      : undefined,
    query.status === "open"
      ? sql`NOT ${closed}`
      : query.status === "resolved"
        ? closed
        : undefined,
    after
      ? sql`(${edgeSyncConflicts.createdAt}, ${edgeSyncConflicts.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)`
      : undefined,
  ];
  return withTenant(db, context, async (tx) => {
    const rows = await tx
      .select({
        conflict: edgeSyncConflicts,
        cursorAt: sql<string>`${edgeSyncConflicts.createdAt}::text`,
      })
      .from(edgeSyncConflicts)
      .where(and(...conditions))
      .orderBy(desc(edgeSyncConflicts.createdAt), desc(edgeSyncConflicts.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const byConflict = await resolutionsOf(
      tx,
      tenantId,
      page.map((entry) => entry.conflict.id),
    );
    const last = page.at(-1);
    return {
      items: page.map((entry) =>
        toSummary(entry.conflict, byConflict.get(entry.conflict.id) ?? []),
      ),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor([last.cursorAt, ulidToUuid(last.conflict.id)])
          : null,
    };
  });
}

/** One conflict with its envelope and every resolution. 404 outside scope. */
export async function getEdgeSyncConflict(
  context: ScopedTenantContext,
  id: string,
): Promise<EdgeSyncConflictDetail> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select()
      .from(edgeSyncConflicts)
      .where(
        and(
          eq(edgeSyncConflicts.tenantId, context.tenant.tenantId),
          eq(edgeSyncConflicts.id, id),
        ),
      );
    if (!row) throw notFound();
    assertOutletInScope(context.outletScope, row.outletId);
    const byConflict = await resolutionsOf(tx, row.tenantId, [row.id]);
    return toDetail(row, byConflict.get(row.id) ?? []);
  });
}

/**
 * The conflict's outlet, for the route's permission check. The caller passes a
 * tenant-wide context minted from the verified request; only the outlet id is
 * returned, null when the conflict does not exist in this tenant.
 */
export async function getEdgeSyncConflictOutletId(
  context: ScopedTenantContext,
  id: string,
): Promise<string | null> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const [row] = await tx
      .select({ outletId: edgeSyncConflicts.outletId })
      .from(edgeSyncConflicts)
      .where(
        and(
          eq(edgeSyncConflicts.tenantId, context.tenant.tenantId),
          eq(edgeSyncConflicts.id, id),
        ),
      );
    return row?.outletId ?? null;
  });
}

/** JSON with sorted keys, so jsonb key order cannot make equal events differ. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/**
 * Re-checks the append-only rule against the CURRENT state before a replay
 * (the state moved since the link refused the event). Returns true when the
 * identical event is already held (nothing to apply), throws a 409 CoreError
 * when the sequence is taken by a different event, and returns false when the
 * applier may run. A `sequence_gap` replay is allowed on purpose: the
 * supervisor accepts the hole. Master data (`edge_master_data`) is an explicit
 * override of "cloud wins" and is not sequence checked.
 */
async function guardReplay(
  tx: EdgeTx,
  row: ConflictRow,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<boolean> {
  if (row.kind !== "transaction_event") return false;
  const applier = edgeEventApplier(row.direction);
  const aggregate = {
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    sequence: event.sequence,
  };
  const lastSequence =
    (await applier.lastSequence?.(tx, aggregate, meta)) ??
    (await defaultLastSequence(
      tx,
      row.edgeNodeId,
      row.direction,
      row.kind,
      event,
    ));
  const decision = decideInbound({
    direction: row.direction,
    kind: row.kind,
    alreadyReceived: false,
    lastSequence,
    event,
  });
  if (
    decision.action !== "conflict" ||
    decision.reason !== "sequence_collision"
  )
    return false;
  const held = await tx
    .select({ event: domainEventOutbox.event })
    .from(domainEventOutbox)
    .where(
      and(
        eq(domainEventOutbox.tenantId, row.tenantId),
        eq(domainEventOutbox.aggregateType, event.aggregateType),
        eq(
          domainEventOutbox.aggregateId,
          uuidSchema.safeParse(event.aggregateId).success
            ? event.aggregateId
            : ulidToUuid(event.aggregateId),
        ),
        eq(domainEventOutbox.sequence, event.sequence),
      ),
    );
  const same = (other: EventEnvelope) =>
    stableJson([other.name, other.version, other.payload]) ===
    stableJson([event.name, event.version, event.payload]);
  if (held.some((entry) => same(entry.event))) return true;
  throw new CoreError(
    "CONFLICT",
    "Urutan transaksi ini sudah terisi oleh event lain; tidak dapat diulang.",
  );
}

/**
 * Replay preconditions beyond the sequence rule (guardReplay): a revoked
 * node's data is never applied, and a conflict is replayed only after the
 * open conflicts before it on the same aggregate, so the order of the
 * aggregate's events is kept. Dismissing has neither limit. Both refuse with
 * a 409 and record nothing.
 */
async function assertReplayAllowed(tx: EdgeTx, row: ConflictRow) {
  const [node] = await tx
    .select({ status: edgeNodes.status })
    .from(edgeNodes)
    .where(
      and(
        eq(edgeNodes.tenantId, row.tenantId),
        eq(edgeNodes.id, row.edgeNodeId),
      ),
    );
  if (node?.status === "revoked")
    throw new CoreError(
      "CONFLICT",
      "Edge node sudah dicabut; konflik hanya dapat diabaikan, tidak diulang.",
    );
  const lower = await tx.execute(
    sql`SELECT 1 FROM edge_sync_conflicts c WHERE c.tenant_id = ${row.tenantId}::uuid AND c.edge_node_id = ${row.edgeNodeId}::uuid AND c.direction = ${row.direction} AND c.aggregate_type = ${row.aggregateType} AND c.aggregate_id = ${row.aggregateId} AND c.aggregate_sequence < ${row.aggregateSequence} AND NOT EXISTS (SELECT 1 FROM edge_sync_conflict_resolutions r WHERE r.tenant_id = c.tenant_id AND r.conflict_id = c.id AND r.outcome IN ('applied', 'dismissed')) LIMIT 1`,
  );
  if (lower.rows.length > 0)
    throw new CoreError(
      "CONFLICT",
      "Ada konflik dengan urutan lebih rendah yang masih terbuka; selesaikan itu lebih dulu.",
    );
}

/**
 * Replay or dismiss one conflict. Idempotent: a conflict that already has an
 * `applied` or `dismissed` resolution is returned unchanged. A throwing
 * applier is NOT an HTTP error: the failure is recorded, the conflict stays
 * open and the caller sees it in `lastResolution`.
 */
export async function resolveEdgeSyncConflict(
  context: ScopedTenantContext,
  actorUserId: string,
  id: string,
  input: ResolveEdgeSyncConflictBody,
  now: Date = new Date(),
): Promise<EdgeSyncConflictDetail> {
  assertTrustedScopedContext(context);
  return withTenant(db, context, async (tx) => {
    const where = and(
      eq(edgeSyncConflicts.tenantId, context.tenant.tenantId),
      eq(edgeSyncConflicts.id, id),
    );
    // Lock order = applyInbound's: sync cursor first, then the conflict row.
    // A replay can then not interleave with the live link on the same node
    // and direction, so two events never take the same aggregate sequence.
    // The cursor's node and direction come from an unlocked read; they are
    // immutable on the append-only conflict row.
    const [peek] = await tx.select().from(edgeSyncConflicts).where(where);
    if (!peek) throw notFound();
    assertOutletInScope(context.outletScope, peek.outletId);
    if (input.action === "replay")
      await lockSyncCursor(
        tx,
        {
          tenantId: peek.tenantId,
          outletId: peek.outletId,
          edgeNodeId: peek.edgeNodeId,
        },
        peek.direction,
      );
    const [row] = await tx
      .select()
      .from(edgeSyncConflicts)
      .where(where)
      .for("update");
    if (!row) throw notFound();
    assertOutletInScope(context.outletScope, row.outletId);
    const existing =
      (await resolutionsOf(tx, row.tenantId, [row.id])).get(row.id) ?? [];
    if (existing.some(isClosing)) return toDetail(row, existing);

    let outcome: ResolutionRow["outcome"] = "dismissed";
    let error: string | null = null;
    if (input.action === "replay") {
      const event = eventEnvelopeSchema.parse(row.event);
      // legend-fgd9b: a stored link_seq is the peer's linkSeq + peer_seq_offset
      // of this node's cursor row, exactly as applyInbound derives it.
      const offsetResult = await tx.execute(
        sql`SELECT peer_seq_offset FROM sync_cursors WHERE edge_node_id = ${row.edgeNodeId}::uuid AND direction = ${row.direction}`,
      );
      const meta: EdgeApplyMeta = {
        edgeNodeId: row.edgeNodeId,
        direction: row.direction,
        kind: row.kind,
        peerSeqOffset: Number(offsetResult.rows[0]?.peer_seq_offset ?? 0),
        context,
      };
      // A refused replay (409) throws here: nothing is recorded, the
      // conflict stays open.
      await assertReplayAllowed(tx, row);
      const alreadyHeld = await guardReplay(tx, row, event, meta);
      try {
        // Savepoint: a failing applier undoes only its own writes.
        if (!alreadyHeld)
          await tx.transaction(async (savepoint) => {
            await edgeEventApplier(row.direction).apply(savepoint, event, meta);
          });
        outcome = "applied";
      } catch (cause) {
        outcome = "failed";
        error = (cause instanceof Error ? cause.message : String(cause)).slice(
          0,
          ERROR_MAX_LENGTH,
        );
      }
    }

    const action = input.action === "replay" ? "replayed" : "dismissed";
    const [inserted] = await tx
      .insert(edgeSyncConflictResolutions)
      .values({
        id: createUlid(now.getTime()),
        tenantId: row.tenantId,
        outletId: row.outletId,
        conflictId: row.id,
        action,
        outcome,
        error,
        note: input.note,
        resolvedBy: actorUserId,
        resolvedAt: now,
      })
      .returning();
    if (!inserted)
      throw new CoreError("CONFLICT", "Konflik gagal diselesaikan, coba lagi.");

    await recordAudit(
      {
        tenantId: row.tenantId,
        outletId: row.outletId,
        actorType: "user",
        actorId: actorUserId,
        deviceId: null,
        action: `edge_sync_conflict.${action}`,
        objectType: "edge_sync_conflict",
        objectId: row.id,
        reason: input.note,
        before: { status: "open" },
        after: { status: outcome === "failed" ? "open" : "resolved", outcome },
        sensitiveAccess: false,
      },
      { tx, context },
    );
    return toDetail(row, [...existing, inserted]);
  });
}
