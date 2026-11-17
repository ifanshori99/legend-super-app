// Cloud side of the edge -> cloud access events (bead legend-kyie): an edge
// node's `staff_pin.set`, `staff_pin.locked` and `pos_override.recorded` are
// applied on the cloud instead of being parked in `edge_deferred_events`.
//
// - staff_pin.set: an edge node sends the hash material (never the pin;
//   shared/access/override.ts `staffPinSetMaterialSchema`). The cloud adopts
//   it only when the edge generation is newer than the cloud's (raw `setAt`
//   vs `staff_pins.pin_generation_at`; a tie keeps the cloud pin; the clamped
//   time goes to `pin_set_at`), so an older edge set
//   never overwrites a newer cloud reset and a standby takeover / cloud ->
//   edge sync no longer reverts an edge pin. `updated_at = now()` so the row
//   re-exports to the edges (staff-pin-sync.ts). Matched by (tenant, outlet,
//   user); a different cloud row id is kept. No material (old events, cloud
//   events) or another pepper version: not applicable, nothing written.
//   A later set of the node that gave the current generation is adopted
//   whatever its key (legend-rucdm), and a refused set with other material
//   re-exports the cloud row (legend-kgbw); see applyStaffPinSet.
// - staff_pin.locked: copies an active lock that is newer than the pin
//   generation, bounded by STAFF_PIN_LOCK_MINUTES from now.
// - pos_override.recorded: the cloud audit row (same shape as
//   staff-override.service.ts recordApprovedOverride), once per override.
//   Audit only: the cloud pos_overrides row needs fields and approval links
//   an edge override does not carry.
//
// Parked rows: access events received before this applier existed sit in
// `edge_deferred_events`. Every live access event first drains up to
// DRAIN_LIMIT parked access rows of its outlet (oldest first), each in its own
// savepoint, the whole drain in one more savepoint that never fails the live
// event, and marks every processed row (`applied_at`, `apply_outcome`).
// A refusal drops the envelope's pin material, except a transient one: an
// `AuditUnavailableError` (no audit writer in this process, legend-j88cz) marks
// the row `refused`, keeps the envelope intact and adds
// `envelope.refusal = "audit_unavailable"`, so replayRefusedAccessEvents can
// apply it later (legend-ngyd7); it replays only marked rows.
//
// Fail closed like the other appliers: a wrong direction, tenant, outlet or
// node, a payload that does not parse, an id that does not match its
// aggregate, an unknown user or an override approved by its requester throws
// a CoreError (4xx); the link records an `applier_refused` conflict whose
// stored event has no pin material (db-link-store.ts). The cloud apply writes
// no outbox event (it would echo back to the edge). Never logs payloads,
// hashes or salts.
import { randomUUID } from "node:crypto";
import {
  posOverrideRecordedEvent,
  staffPinLockedEvent,
  staffPinSetEvent,
} from "@starter/shared/access/override";
import {
  CoreError,
  ulidSchema,
  ulidToUuid,
  type OutletId,
} from "@starter/shared/core";
import { eventEnvelopeSchema } from "@starter/shared/events";
import type { EventEnvelope } from "@starter/shared/events";
import {
  MAX_STAFF_PIN_ATTEMPTS,
  STAFF_PIN_LOCK_MINUTES,
} from "@starter/shared/identity";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditLogs } from "../db/schema/core-audit.ts";
import { staffPins } from "../db/schema/device-pin.ts";
import {
  edgeDeferredEvents,
  type EdgeDeferredApplyOutcome,
} from "../db/schema/edge-deferred-event.ts";
import { roleAssignments } from "../db/schema/platform-access.ts";
import { user } from "../db/schema/user.ts";
import {
  AuditUnavailableError,
  recordAudit,
} from "../services/audit-writer.ts";
import { isStaffPinPepperVersionUsable } from "../services/device-pin-pepper.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
import { revokeActingStaffForStaff } from "../services/pos-acting-staff-revoke.ts";
import {
  registerEdgeAggregateKind,
  registerEdgeAggregateLastSequence,
  registerEdgeEventHandler,
} from "./applier-registry.ts";
import type {
  EdgeEventHandler,
  EdgeLastSequenceHook,
} from "./applier-registry.ts";
import { assertEdgeEventScope } from "./deferred-event-applier.ts";
import {
  hasEdgeEnvelopeSecrets,
  redactEdgeEnvelopeSecrets,
} from "./envelope-secrets.ts";
import type { EdgeApplyMeta } from "./ports.ts";
import { logger } from "../lib/logger.ts";

export { redactEdgeEnvelopeSecrets } from "./envelope-secrets.ts";

export const STAFF_PIN_AGGREGATE = "staff_pin";
export const POS_OVERRIDE_AGGREGATE = "pos_override";
export const ACCESS_EDGE_AGGREGATES = [
  STAFF_PIN_AGGREGATE,
  POS_OVERRIDE_AGGREGATE,
] as const;
export const STAFF_PIN_SET_EVENT = "staff_pin.set";
export const STAFF_PIN_LOCKED_EVENT = "staff_pin.locked";
export const POS_OVERRIDE_RECORDED_EVENT = "pos_override.recorded";

/** Parked access rows drained per live access event. */
export const DRAIN_LIMIT = 25;

/**
 * How far an edge clock may run ahead of the cloud (round 3 R1; same window
 * as services/payment-paid-at.ts). A pin set stamped further ahead would
 * freeze the pin against every later edge set, so it is refused; a lock that
 * far ahead is ignored.
 */
const EDGE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const edgeClockLimit = sql`now() + make_interval(secs => ${EDGE_CLOCK_SKEW_MS / 1000})`;

/** What applying one access event did (thrown refusals are not returned). */
export type AccessApplyOutcome = "applied" | "not_applicable";

// ------------------------------------------------------------------ helpers

/** Same normalisation as the outbox (device-pin-support.ts). */
function storedAggregateId(id: string): string {
  return ulidSchema.safeParse(id).success ? ulidToUuid(id) : id.toLowerCase();
}

function assertAggregate(event: EventEnvelope, type: string, id: string) {
  // The outbox stores a ULID id in uuid form; accept the id as sent too.
  const aggregateId = event.aggregateId.toLowerCase();
  if (
    event.aggregateType !== type ||
    (aggregateId !== storedAggregateId(id) && aggregateId !== id.toLowerCase())
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Event does not match its aggregate",
    );
}

function parsePayload<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  event: EventEnvelope,
): T {
  const parsed = schema.safeParse(event.payload);
  if (!parsed.success)
    throw new CoreError("VALIDATION_ERROR", `Invalid ${event.name} payload`);
  return parsed.data;
}

/**
 * The user exists, belongs to the tenant (any role assignment, current or
 * ended) and, with `active`, is not banned. A CoreError otherwise, never a
 * foreign-key failure that would abort the whole link batch.
 */
async function assertTenantUser(
  tx: EdgeTx,
  tenantId: string,
  userId: string,
  options: { readonly active: boolean },
): Promise<void> {
  const [account] = await tx
    .select({ banned: user.banned })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!account || (options.active && account.banned === true))
    throw new CoreError("NOT_FOUND", "Staff member is not known on the cloud");
  const [member] = await tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.tenantId, tenantId),
        eq(roleAssignments.userId, userId),
      ),
    )
    .limit(1);
  if (!member)
    throw new CoreError("NOT_FOUND", "Staff member is not in this tenant");
}

// ------------------------------------------------------------ staff pin set

/**
 * Adopts the pin set on the edge when its generation is newer than the
 * cloud's. One upsert on (tenant, outlet, user), so a concurrent cloud set is
 * ordered by the row lock: the newer `pin_generation_at` wins.
 *
 * The order key is the raw edge `setAt`, never clamped (Codex 160 C1): with
 * an edge clock ahead of the cloud, two sets A then B would both clamp to
 * the cloud clock and B would lose to A. Only `pin_set_at` is clamped.
 *
 * legend-rucdm: a set of the node that gave the current generation
 * (`generation_edge_node_id`) with a higher aggregate sequence is that node's
 * later set, so it is adopted whatever its key: an edge clock stepping back
 * while offline would otherwise make the node's own newer pin lose. The
 * adopted key is GREATEST(setAt, current + 1 ms) so the cloud key never moves
 * back, and the node id and sequence are stored for the next set.
 *
 * legend-o839h: "the node" is the node id and the edge database instance id
 * it reported (`meta.edgeInstanceId`, stored as `generation_edge_instance_id`).
 * A rebuilt edge database of the same node restarts its sequences; its sets
 * compare by key, so they are adopted without registering a new node.
 *
 * legend-kgbw: a refused set with other material (an older or tied key)
 * touches the cloud row, so the export sends the cloud pin again and the edge
 * replaces the pin the cloud refused. No event, no audit.
 */
export async function applyStaffPinSet(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<AccessApplyOutcome> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const tenantId = meta.context.tenant.tenantId;
  const payload = parsePayload(staffPinSetEvent.payloadSchema, event);
  assertAggregate(event, STAFF_PIN_AGGREGATE, payload.staffPinId);
  await assertTenantUser(tx, tenantId, payload.userId, { active: true });
  await assertTenantUser(tx, tenantId, payload.setBy, { active: false });
  const material = payload.material;
  // Old event or a cloud-shaped one: nothing to adopt. A pepper generation
  // above the cloud's current one would never verify here (an edge only holds
  // generations the cloud sent it, so this is a guard, legend-ideif).
  if (!material || !isStaffPinPepperVersionUsable(material.pepperVersion))
    return "not_applicable";

  const { rows: skew } = await tx.execute(
    sql`SELECT (${material.setAt}::timestamptz > ${edgeClockLimit}) AS ahead`,
  );
  if (skew[0]?.ahead === true)
    throw new CoreError(
      "VALIDATION_ERROR",
      "Staff pin set time is too far ahead of the cloud clock",
    );

  const pinSetAt = sql`LEAST(${material.setAt}::timestamptz, now())`;
  const pinGenerationAt = sql`${material.setAt}::timestamptz`;
  const provenance = {
    generationEdgeNodeId: meta.edgeNodeId,
    generationEdgeSequence: event.sequence,
    generationEdgeInstanceId: meta.edgeInstanceId ?? null,
  };
  const ownOrigin = sameGenerationOrigin(meta);
  // An event without its instance (parked drain, conflict replay, old edge)
  // adopted for the same node keeps the stored instance: writing NULL would
  // make the node's next live events (with that instance) lose the sequence
  // rule (review K re-review). Another node's adoption clears it.
  const instanceOnUpdate =
    meta.edgeInstanceId ??
    sql`CASE WHEN ${staffPins.generationEdgeNodeId} IS NOT DISTINCT FROM ${meta.edgeNodeId}::uuid THEN ${staffPins.generationEdgeInstanceId} ELSE NULL END`;
  const values = {
    pinHash: material.pinHash,
    pinSalt: material.salt,
    kdfN: material.params.N,
    kdfR: material.params.r,
    kdfP: material.params.p,
    pepperVersion: material.pepperVersion,
    failedAttempts: 0,
    lockedUntil: null,
    setBy: payload.setBy,
    // Commit-time clock, not the batch transaction's start (review K F5).
    // The edge export now pages by sync_xid (legend-t9ii); updated_at stays
    // an informational version.
    updatedAt: sql`clock_timestamp()`,
  };
  const ownRow = async () => {
    const [row] = await tx
      .select({ id: staffPins.id })
      .from(staffPins)
      .where(
        and(
          eq(staffPins.tenantId, tenantId),
          eq(staffPins.outletId, outletId),
          eq(staffPins.userId, payload.userId),
        ),
      )
      .for("update");
    return row ?? null;
  };
  // Same material is the same pin (legend-zclb: the edge re-sends a set the
  // cloud may already hold, or one the edge mirrored from the cloud). Writing
  // it would clear a live lock and the attempt count for nothing, so it is
  // neither an adoption nor a refusal to answer.
  const otherMaterial = sql`(${staffPins.pinHash}, ${staffPins.pinSalt}, ${staffPins.kdfN}, ${staffPins.kdfR}, ${staffPins.kdfP}, ${staffPins.pepperVersion}) IS DISTINCT FROM (${material.pinHash}, ${material.salt}, ${material.params.N}, ${material.params.r}, ${material.params.p}, ${material.pepperVersion})`;
  const update = async (id: string) => {
    // A strictly newer key, or a later set of the node that gave the current
    // generation (legend-rucdm), and other material only: a tie of another
    // origin keeps the cloud pin. An older set of that same node (lower or
    // equal sequence) never wins through the key branch (review K R2): its
    // later set may already hold a lower key after the clock stepped back. A
    // null generation_edge_node_id (cloud set, older rows) still compares by
    // key only, and so does another edge database of the same node
    // (legend-o839h, `sameGenerationOrigin`).
    const written = await tx
      .update(staffPins)
      .set({
        ...values,
        ...provenance,
        generationEdgeInstanceId: instanceOnUpdate,
        pinSetAt,
        pinGenerationAt: sql`GREATEST(${pinGenerationAt}, ${staffPins.pinGenerationAt} + interval '1 millisecond')`,
      })
      .where(
        and(
          eq(staffPins.tenantId, tenantId),
          eq(staffPins.id, id),
          sql`((${ownOrigin} AND ${staffPins.generationEdgeSequence} < ${event.sequence}) OR (${staffPins.pinGenerationAt} < ${pinGenerationAt} AND NOT (${ownOrigin} AND ${staffPins.generationEdgeSequence} >= ${event.sequence})))`,
          otherMaterial,
        ),
      )
      .returning({ id: staffPins.id });
    if (written.length > 0) return "applied";
    // legend-kgbw: refused with other material. The edge holds a pin the
    // cloud will never take; a write that changes nothing material lets the
    // trigger restamp sync_xid, so the next pull sends the cloud pin back and
    // the edge replaces the refused one (its key is older or tied).
    await tx
      .update(staffPins)
      .set({ updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(staffPins.tenantId, tenantId),
          eq(staffPins.id, id),
          otherMaterial,
        ),
      );
    return "not_applicable";
  };
  // `staff_pins.id` is a global key and RLS hides other tenants' rows, so an
  // insert never relies on a pre-check (review K F8): ON CONFLICT DO NOTHING
  // on any key, then the staff member's own row (a concurrent insert) or a
  // fresh cloud id.
  const insert = async (id: string) => {
    const written = await tx
      .insert(staffPins)
      .values({
        id,
        tenantId,
        outletId,
        userId: payload.userId,
        ...values,
        ...provenance,
        pinSetAt,
        pinGenerationAt,
        createdAt: sql`now()`,
      })
      .onConflictDoNothing()
      .returning({ id: staffPins.id });
    return written.length > 0;
  };

  return guardPinWrite(async (): Promise<AccessApplyOutcome> => {
    // A cloud row of the same staff member keeps its own id.
    const existing = await ownRow();
    const written = await (async (): Promise<AccessApplyOutcome> => {
      if (existing) return update(existing.id);
      if (await insert(payload.staffPinId)) return "applied";
      const raced = await ownRow();
      if (raced) return update(raced.id);
      if (await insert(randomUUID())) return "applied";
      const last = await ownRow();
      if (last) return update(last.id);
      throw new CoreError("CONFLICT", "Staff pin row could not be written");
    })();
    // New PIN material adopted: tokens issued for the old PIN end here, on
    // the same transaction as the write (legend-aruta). A refused or same-
    // material set leaves them alone. `EdgeTx` and `Tx` are both the drizzle
    // transaction type of the shared `db`, so no cast is needed.
    if (written === "applied")
      await revokeActingStaffForStaff(tx, meta.context.tenant, {
        outletId,
        staffUserId: payload.userId,
        reason: "pin_reset",
      });
    return written;
  });
}

/**
 * legend-o839h: the event comes from the edge database that gave the current
 * generation, so its aggregate sequence is comparable with the stored one.
 *
 * - The event names its instance (`meta.edgeInstanceId`, the link's
 *   `x-edge-instance` header): same node id and same stored instance. A
 *   rebuilt edge database keeps the node id but has a new instance id and
 *   restarts its sequences, so its sets compare by key only. A row adopted
 *   before instances were reported (null) also compares by key, so a rebuild
 *   from such a row needs no runbook either. A restored or cloned database
 *   keeps its instance id and still orders by sequence (legend-yd0h8 covers
 *   that case for receipts).
 * - The instance is unknown (an old edge without the header, a parked event
 *   drained later, a conflict replayed by a supervisor): the node-only rule of
 *   legend-rucdm, exactly as before instances existed. Those paths never
 *   recorded the instance, so treating them as another database would let an
 *   older set of the node win by key (review K #2, #3).
 *
 * Never NULL (a cloud row has no node): it is negated in the key branch.
 */
function sameGenerationOrigin(meta: EdgeApplyMeta) {
  const sameNode = sql`${staffPins.generationEdgeNodeId} IS NOT DISTINCT FROM ${meta.edgeNodeId}::uuid`;
  const instanceId = meta.edgeInstanceId ?? null;
  if (instanceId === null) return sql`(${sameNode})`;
  return sql`(${sameNode} AND ${staffPins.generationEdgeInstanceId} IS NOT DISTINCT FROM ${instanceId}::uuid)`;
}

/**
 * Runs a staff_pins write. A database error can quote the row (hash, salt)
 * in its message or parameters, so anything but a domain refusal is
 * rethrown as a generic error (review K F4). Domain refusals pass unchanged.
 */
async function guardPinWrite<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new Error("Staff pin write failed");
  }
}

// --------------------------------------------------------- staff pin locked

/**
 * Copies an edge lock that is newer than the current pin generation and
 * still active; the lock never ends later than STAFF_PIN_LOCK_MINUTES from
 * now and never shortens a longer cloud lock.
 *
 * Review K F1: after an adoption by sequence (legend-rucdm) the cloud key is
 * ahead of that node's clock, so its later locks would all look older than
 * the generation. A lock of the node that gave the generation with a higher
 * aggregate sequence is therefore also newer (same node and same edge
 * database instance, legend-o839h). Set and lock events of one
 * staff pin share one aggregate stream on the edge (`appendDevicePinEvent`,
 * aggregate = the staff pin row), so the sequences are comparable.
 *
 * legend-lhffb: the reverse also holds. A lock of that same node at a lower
 * or equal sequence than the generation set predates it (a reset), even when
 * the edge clock stepped back and its timestamp looks newer, so it is
 * refused before the timestamp comparison, as in the set guard. A null
 * generation node keeps the timestamp-only rule.
 */
export async function applyStaffPinLocked(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<AccessApplyOutcome> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const tenantId = meta.context.tenant.tenantId;
  const payload = parsePayload(staffPinLockedEvent.payloadSchema, event);
  assertAggregate(event, STAFF_PIN_AGGREGATE, payload.staffPinId);
  await assertTenantUser(tx, tenantId, payload.userId, { active: false });
  const lockedUntil = sql`LEAST(${payload.lockedUntil}::timestamptz, now() + make_interval(mins => ${STAFF_PIN_LOCK_MINUTES}))`;
  const written = await guardPinWrite(() =>
    tx
      .update(staffPins)
      .set({
        failedAttempts: MAX_STAFF_PIN_ATTEMPTS,
        lockedUntil: sql`GREATEST(${staffPins.lockedUntil}, ${lockedUntil})`,
        // Commit-time clock (review K F5).
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(staffPins.tenantId, tenantId),
          eq(staffPins.outletId, outletId),
          eq(staffPins.userId, payload.userId),
          // Same clock as an edge set's order key (both edge time), or a
          // later event of the node that gave the generation (F1). Mirrors
          // the set guard: a lock of that same origin (node and edge database
          // instance, legend-o839h) at a lower or equal sequence never passes
          // through the timestamp branch (legend-lhffb).
          sql`((${sameGenerationOrigin(meta)} AND ${staffPins.generationEdgeSequence} < ${event.sequence}) OR (${staffPins.pinGenerationAt} < ${event.occurredAt}::timestamptz AND NOT (${sameGenerationOrigin(meta)} AND ${staffPins.generationEdgeSequence} >= ${event.sequence})))`,
          // An edge clock far ahead (round 3 R1).
          sql`${event.occurredAt}::timestamptz <= ${edgeClockLimit}`,
          sql`${payload.lockedUntil}::timestamptz > now()`,
        ),
      )
      .returning({ id: staffPins.id }),
  );
  return written.length > 0 ? "applied" : "not_applicable";
}

// ---------------------------------------------------- pos override recorded

/**
 * The cloud audit row of an override recorded on the edge (AUTH-06): same
 * action, actor and snapshot as a cloud override. Once per override id.
 */
export async function applyPosOverrideRecorded(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<AccessApplyOutcome> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const tenantId = meta.context.tenant.tenantId;
  const payload = parsePayload(posOverrideRecordedEvent.payloadSchema, event);
  assertAggregate(event, POS_OVERRIDE_AGGREGATE, payload.overrideId);
  if (payload.requestedBy.toLowerCase() === payload.approvedBy.toLowerCase())
    throw new CoreError(
      "VALIDATION_ERROR",
      "An override cannot be approved by its requester",
    );
  await assertTenantUser(tx, tenantId, payload.requestedBy, { active: false });
  await assertTenantUser(tx, tenantId, payload.approvedBy, { active: false });

  const [existing] = await tx
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.tenantId, tenantId),
        // Bounded so the (tenant_id, created_at) index serves it (review K
        // F6): the audit row is written when the event arrives, never before
        // it occurred on the edge. LEAST: an edge clock running ahead must
        // not push the window past an earlier audit row of the same override.
        sql`${auditLogs.createdAt} >= LEAST(${event.occurredAt}::timestamptz, now()) - interval '1 day'`,
        sql`${auditLogs.event}->>'action' = ${POS_OVERRIDE_RECORDED_EVENT}`,
        sql`${auditLogs.event}->>'objectId' = ${payload.overrideId}`,
      ),
    )
    .limit(1);
  if (existing) return "not_applicable";

  // legend-7iti: an edge shift close carries the blind-count figures (its
  // `valueIdr` is null); the audit row gets them and valueIdr = |variance|,
  // like a cloud override's. An old event stays as it was (null).
  const variance = payload.shiftCloseVariance;
  await recordAudit(
    {
      tenantId,
      outletId,
      actorType: "user",
      actorId: payload.approvedBy,
      deviceId: event.deviceId ?? null,
      action: POS_OVERRIDE_RECORDED_EVENT,
      objectType: "pos_override",
      objectId: payload.overrideId,
      reason: payload.reason ?? null,
      before: null,
      after: {
        action: payload.action,
        method: payload.method,
        requestedBy: payload.requestedBy,
        approvedBy: payload.approvedBy,
        valueIdr: variance ? Math.abs(variance.varianceIdr) : payload.valueIdr,
        ...(variance ?? {}),
        reasonCode: payload.reasonCode ?? null,
        objectType: payload.objectType,
        objectId: payload.objectId,
        approvalRequestId: payload.approvalRequestId,
      },
      sensitiveAccess: false,
    },
    { tx, context: meta.context },
  );
  return "applied";
}

// ------------------------------------------------------------------- drain

const APPLY_BY_EVENT: Readonly<
  Record<
    string,
    (
      tx: EdgeTx,
      event: EventEnvelope,
      meta: EdgeApplyMeta,
    ) => Promise<AccessApplyOutcome>
  >
> = {
  [STAFF_PIN_SET_EVENT]: applyStaffPinSet,
  [STAFF_PIN_LOCKED_EVENT]: applyStaffPinLocked,
  [POS_OVERRIDE_RECORDED_EVENT]: applyPosOverrideRecorded,
};

async function applyParked(
  tx: EdgeTx,
  envelope: unknown,
  meta: EdgeApplyMeta,
): Promise<AccessApplyOutcome> {
  const parsed = eventEnvelopeSchema.safeParse(envelope);
  if (!parsed.success)
    throw new CoreError("VALIDATION_ERROR", "Parked event does not parse");
  const apply = APPLY_BY_EVENT[parsed.data.name];
  return apply ? apply(tx, parsed.data, meta) : "not_applicable";
}

/**
 * Envelope key (jsonb, no migration) a drain adds when it refuses a row only
 * for AuditUnavailableError (legend-ngyd7). replayRefusedAccessEvents trusts
 * only rows carrying it; the strict envelope schema rejects the key, so it is
 * stripped before a row is parsed or applied.
 */
const REFUSAL_KEY = "refusal";
const AUDIT_UNAVAILABLE_REFUSAL = "audit_unavailable";

function isAuditUnavailableMarked(envelope: unknown): boolean {
  return (
    envelope !== null &&
    typeof envelope === "object" &&
    (envelope as Record<string, unknown>)[REFUSAL_KEY] ===
      AUDIT_UNAVAILABLE_REFUSAL
  );
}

/** The envelope without the refusal marker; the same object when unmarked. */
function withoutRefusalMarker(envelope: EventEnvelope): EventEnvelope {
  if (!(REFUSAL_KEY in envelope)) return envelope;
  const rest: Record<string, unknown> = { ...envelope };
  delete rest[REFUSAL_KEY];
  return rest as EventEnvelope;
}

type ParkedRow = {
  eventId: string;
  edgeNodeId: string;
  envelope: EventEnvelope;
};

type ParkedRowResult = {
  outcome: EdgeDeferredApplyOutcome;
  /** Refused only because no audit writer was installed: retry later. */
  transient: boolean;
  errorClass: string | null;
};

/**
 * Applies one parked row in its own savepoint. A failure undoes only that
 * row (the savepoint) and comes back as `refused`; it is never thrown.
 */
async function applyParkedRow(
  tx: EdgeTx,
  row: ParkedRow,
  meta: Omit<EdgeApplyMeta, "edgeNodeId">,
): Promise<ParkedRowResult> {
  // The parked row's own node (primary or standby of this outlet). Its
  // edge database instance was never recorded: never borrow the live
  // link's (review K #2), so the node-only rule applies (legend-o839h).
  const rowMeta: EdgeApplyMeta = {
    ...meta,
    edgeNodeId: row.edgeNodeId,
    edgeInstanceId: null,
  };
  try {
    const outcome = await tx.transaction((savepoint) =>
      applyParked(savepoint, row.envelope, rowMeta),
    );
    return { outcome, transient: false, errorClass: null };
  } catch (error) {
    // Any failure (review K F3): the row savepoint is already rolled back.
    return {
      outcome: "refused",
      // Only a missing audit writer is transient (legend-ngyd7): the event
      // itself was fine, so its material must survive for a replay.
      transient: error instanceof AuditUnavailableError,
      errorClass: errorClassOf(error),
    };
  }
}

/**
 * Applies up to `limit` still-parked access rows (staff_pin / pos_override,
 * either parked reason) of `outletId`, oldest first, and marks each one with
 * its outcome. Each row has its own savepoint (a refusal undoes only that
 * row and marks it `refused`); any other failure abandons the whole drain
 * (its own savepoint) and propagates to the caller so background sweeps can
 * count failed outlets. The live handler isolates drain failures. Returns
 * the rows marked.
 *
 * A refused row loses its pin material, except one refused only with
 * `AuditUnavailableError` (transient, legend-ngyd7): it is marked `refused`
 * with its envelope intact plus `envelope.refusal = "audit_unavailable"`, for
 * replayRefusedAccessEvents.
 */
export async function drainParkedAccessEvents(
  tx: EdgeTx,
  meta: Omit<EdgeApplyMeta, "edgeNodeId">,
  outletId: OutletId,
  limit: number = DRAIN_LIMIT,
): Promise<number> {
  const tenantId = meta.context.tenant.tenantId;
  const refusedClasses = new Set<string>();
  try {
    return await tx.transaction(async (drain) => {
      const rows = await drain
        .select({
          eventId: edgeDeferredEvents.eventId,
          edgeNodeId: edgeDeferredEvents.edgeNodeId,
          envelope: edgeDeferredEvents.envelope,
        })
        .from(edgeDeferredEvents)
        .where(
          and(
            eq(edgeDeferredEvents.tenantId, tenantId),
            eq(edgeDeferredEvents.outletId, outletId),
            inArray(edgeDeferredEvents.aggregateType, [
              ...ACCESS_EDGE_AGGREGATES,
            ]),
            isNull(edgeDeferredEvents.appliedAt),
          ),
        )
        .orderBy(
          asc(edgeDeferredEvents.receivedAt),
          asc(edgeDeferredEvents.eventId),
        )
        .limit(limit)
        .for("update", { skipLocked: true });
      for (const row of rows) {
        const result = await applyParkedRow(drain, row, meta);
        if (result.errorClass !== null) refusedClasses.add(result.errorClass);
        await drain
          .update(edgeDeferredEvents)
          .set({
            appliedAt: sql`now()`,
            applyOutcome: result.outcome,
            // Rows parked by an older cloud may still hold pin hash
            // material (review K F7). A transient refusal keeps it and adds
            // the refusal marker: the row waits for
            // replayRefusedAccessEvents (legend-ngyd7).
            envelope: result.transient
              ? ({
                  ...row.envelope,
                  [REFUSAL_KEY]: AUDIT_UNAVAILABLE_REFUSAL,
                } as EventEnvelope)
              : redactEdgeEnvelopeSecrets(row.envelope),
          })
          .where(
            and(
              eq(edgeDeferredEvents.tenantId, tenantId),
              eq(edgeDeferredEvents.eventId, row.eventId),
            ),
          );
      }
      if (refusedClasses.size > 0)
        // Counts and error classes only: no payload or ids (ports.ts rule).
        logger.warn(
          { drained: rows.length, errorClasses: [...refusedClasses] },
          "Parked edge access events refused during drain",
        );
      return rows.length;
    });
  } catch (error) {
    // The drain savepoint rolled back: nothing was marked. No payload,
    // message or ids in logs (ports.ts rule).
    logger.warn(
      { drained: 0, errorClasses: [errorClassOf(error)] },
      "Parked edge access drain failed",
    );
    throw error;
  }
}

export type ReplayRefusedAccessResult = {
  /** Rows selected (`refused`, this outlet, an access aggregate). */
  considered: number;
  applied: number;
  notApplicable: number;
  /** Refused again (a real refusal, or the audit writer is still missing). */
  stillRefused: number;
  /** A `staff_pin.set` without material: nothing to replay, left alone. */
  skippedNoMaterial: number;
  /** Refused without the audit-unavailable marker and not acknowledged. */
  skippedUnmarked: number;
};

/**
 * Replays `refused` parked access rows of `outletId` named by `eventIds`
 * (legend-ngyd7), for rows a past drain refused only because the audit writer
 * was missing. Idempotent and scoped:
 * - only `apply_outcome = 'refused'` rows of this tenant and outlet are
 *   selected (FOR UPDATE); a row already applied, or of another outlet, is
 *   never touched, so a second call finds nothing to do;
 * - only rows a drain marked `envelope.refusal = "audit_unavailable"` are
 *   replayed. An unmarked `refused` row (a real refusal, or a legacy row from
 *   the m1 window) is skipped untouched, unless the operator names it in
 *   `eventIds` and passes `acknowledgeUnmarked: true`;
 * - a `staff_pin.set` whose material was already dropped is skipped
 *   untouched (the pin cannot be rebuilt from it);
 * - each row applies through applyParked in its own savepoint. Success marks
 *   `applied` / `not_applicable` and drops the material. A real refusal
 *   marks nothing new beyond dropping the material; a repeat
 *   `AuditUnavailableError` leaves the row exactly as it was.
 * The appliers are themselves idempotent (same pin material, one audit row
 * per override), so replaying a row whose effect already landed adds nothing.
 */
export async function replayRefusedAccessEvents(
  tx: EdgeTx,
  meta: Omit<EdgeApplyMeta, "edgeNodeId">,
  outletId: OutletId,
  {
    eventIds,
    acknowledgeUnmarked = false,
  }: { eventIds: readonly string[]; acknowledgeUnmarked?: boolean },
): Promise<ReplayRefusedAccessResult> {
  const result: ReplayRefusedAccessResult = {
    considered: 0,
    applied: 0,
    notApplicable: 0,
    stillRefused: 0,
    skippedNoMaterial: 0,
    skippedUnmarked: 0,
  };
  if (eventIds.length === 0) return result;
  const tenantId = meta.context.tenant.tenantId;
  const refusedClasses = new Set<string>();
  const rows = await tx
    .select({
      eventId: edgeDeferredEvents.eventId,
      edgeNodeId: edgeDeferredEvents.edgeNodeId,
      envelope: edgeDeferredEvents.envelope,
    })
    .from(edgeDeferredEvents)
    .where(
      and(
        eq(edgeDeferredEvents.tenantId, tenantId),
        eq(edgeDeferredEvents.outletId, outletId),
        inArray(edgeDeferredEvents.aggregateType, [...ACCESS_EDGE_AGGREGATES]),
        eq(edgeDeferredEvents.applyOutcome, "refused"),
        inArray(edgeDeferredEvents.eventId, [...eventIds]),
      ),
    )
    .orderBy(
      asc(edgeDeferredEvents.receivedAt),
      asc(edgeDeferredEvents.eventId),
    )
    .for("update");
  result.considered = rows.length;
  for (const stored of rows) {
    if (!acknowledgeUnmarked && !isAuditUnavailableMarked(stored.envelope)) {
      result.skippedUnmarked += 1;
      continue;
    }
    const row = { ...stored, envelope: withoutRefusalMarker(stored.envelope) };
    const parsed = eventEnvelopeSchema.safeParse(row.envelope);
    if (
      parsed.success &&
      parsed.data.name === STAFF_PIN_SET_EVENT &&
      !hasEdgeEnvelopeSecrets(parsed.data)
    ) {
      result.skippedNoMaterial += 1;
      continue;
    }
    const applied = await applyParkedRow(tx, row, meta);
    if (applied.errorClass !== null) refusedClasses.add(applied.errorClass);
    if (applied.outcome === "refused") {
      result.stillRefused += 1;
      // Still transient: the row stays exactly as it was.
      if (applied.transient) continue;
    } else if (applied.outcome === "applied") result.applied += 1;
    else result.notApplicable += 1;
    await tx
      .update(edgeDeferredEvents)
      .set({
        appliedAt: sql`now()`,
        applyOutcome: applied.outcome,
        envelope: redactEdgeEnvelopeSecrets(row.envelope),
      })
      .where(
        and(
          eq(edgeDeferredEvents.tenantId, tenantId),
          eq(edgeDeferredEvents.eventId, row.eventId),
        ),
      );
  }
  if (refusedClasses.size > 0)
    // Counts and error classes only: no payload or ids (ports.ts rule).
    logger.warn(
      { considered: result.considered, errorClasses: [...refusedClasses] },
      "Refused edge access events still refused on replay",
    );
  return result;
}

function errorClassOf(error: unknown): string {
  if (error instanceof CoreError) return `CoreError:${error.code}`;
  return error instanceof Error ? error.name : typeof error;
}

// ------------------------------------------------------------ registration

function liveHandler(
  apply: (
    tx: EdgeTx,
    event: EventEnvelope,
    meta: EdgeApplyMeta,
  ) => Promise<AccessApplyOutcome>,
): EdgeEventHandler {
  return async (tx, event, meta) => {
    // Scope first: a drain only ever runs for a legitimate event of the
    // node's own outlet. Older parked events apply before the live one. The
    // drain shares the live event's savepoint: if the live event is refused,
    // the drain is undone too and the rows wait for the next accepted access
    // event (they stay unmarked, nothing is lost).
    const outletId = await assertEdgeEventScope(tx, event, meta);
    try {
      await drainParkedAccessEvents(tx, meta, outletId);
    } catch {
      // A failed drain has already rolled back and logged safe metadata.
      // The live event can still apply; the parked rows wait for a retry.
    }
    await apply(tx, event, meta);
  };
}

/**
 * Review K F1: the link accepts any aggregate sequence of these aggregates.
 * A refused event is never "received", and a standby continues the primary's
 * sequences, so the append-only next-sequence rule would turn every later
 * event into a `sequence_gap` conflict whose stored copy has no pin material
 * (lost, later reverted). The appliers order by `pin_generation_at` / `occurredAt`
 * themselves, and the link still drops a redelivered event id.
 */
const acceptIncomingSequence: EdgeLastSequenceHook = async (_tx, aggregate) =>
  aggregate.sequence === undefined ? null : aggregate.sequence - 1;

// Stable identities: the registry treats a different handler as a wiring bug.
const handleStaffPinSet = liveHandler(applyStaffPinSet);
const handleStaffPinLocked = liveHandler(applyStaffPinLocked);
const handlePosOverrideRecorded = liveHandler(applyPosOverrideRecorded);

/**
 * Cloud boot (registerEdgeLink): applies the edge access events and
 * classifies both aggregates as append-only transaction events. Replaces the
 * former deferred registration. Idempotent.
 */
export function registerAccessEdgeApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    STAFF_PIN_SET_EVENT,
    handleStaffPinSet,
  );
  registerEdgeEventHandler(
    "edge_to_cloud",
    STAFF_PIN_LOCKED_EVENT,
    handleStaffPinLocked,
  );
  registerEdgeEventHandler(
    "edge_to_cloud",
    POS_OVERRIDE_RECORDED_EVENT,
    handlePosOverrideRecorded,
  );
  for (const aggregateType of ACCESS_EDGE_AGGREGATES) {
    registerEdgeAggregateKind(aggregateType, "transaction_event");
    registerEdgeAggregateLastSequence(
      "edge_to_cloud",
      aggregateType,
      acceptIncomingSequence,
    );
  }
}
