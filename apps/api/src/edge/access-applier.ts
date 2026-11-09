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
import { recordAudit } from "../services/audit-writer.ts";
import { STAFF_PIN_PEPPER_VERSION } from "../services/device-pin-pepper.ts";
import type { EdgeTx } from "../services/edge-queue.service.ts";
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
import { redactEdgeEnvelopeSecrets } from "./envelope-secrets.ts";
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
  // Old event or a cloud-shaped one: nothing to adopt. Another pepper
  // generation would never verify here.
  if (!material || material.pepperVersion !== STAFF_PIN_PEPPER_VERSION)
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
    // Commit-time clock, not the batch transaction's start (review K F5):
    // the edge export pages by updated_at behind a settle window.
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
  const update = async (id: string) => {
    // Strictly newer generation and other material only: a tie keeps the
    // cloud pin, identical material changes nothing.
    const written = await tx
      .update(staffPins)
      .set({ ...values, pinSetAt, pinGenerationAt })
      .where(
        and(
          eq(staffPins.tenantId, tenantId),
          eq(staffPins.id, id),
          sql`${staffPins.pinGenerationAt} < ${pinGenerationAt}`,
          // Same material is the same pin (legend-zclb: the edge re-sends a
          // set the cloud may already hold, or one the edge mirrored from the
          // cloud). Writing it would clear a live lock and the attempt count
          // for nothing, so it is not an adoption.
          sql`(${staffPins.pinHash}, ${staffPins.pinSalt}, ${staffPins.kdfN}, ${staffPins.kdfR}, ${staffPins.kdfP}, ${staffPins.pepperVersion}) IS DISTINCT FROM (${material.pinHash}, ${material.salt}, ${material.params.N}, ${material.params.r}, ${material.params.p}, ${material.pepperVersion})`,
        ),
      )
      .returning({ id: staffPins.id });
    return written.length > 0 ? "applied" : "not_applicable";
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
    if (existing) return update(existing.id);
    if (await insert(payload.staffPinId)) return "applied";
    const raced = await ownRow();
    if (raced) return update(raced.id);
    if (await insert(randomUUID())) return "applied";
    const last = await ownRow();
    if (last) return update(last.id);
    throw new CoreError("CONFLICT", "Staff pin row could not be written");
  });
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
          // Same clock as an edge set's order key (both edge time).
          sql`${staffPins.pinGenerationAt} < ${event.occurredAt}::timestamptz`,
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
 * Applies up to `limit` still-parked access rows (staff_pin / pos_override,
 * either parked reason) of `outletId`, oldest first, and marks each one with
 * its outcome. Each row has its own savepoint (a refusal undoes only that
 * row and marks it `refused`); any other failure abandons the whole drain
 * (its own savepoint) and never fails the caller. Returns the rows marked.
 */
export async function drainParkedAccessEvents(
  tx: EdgeTx,
  meta: EdgeApplyMeta,
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
        // The parked row's own node (primary or standby of this outlet).
        const rowMeta: EdgeApplyMeta = { ...meta, edgeNodeId: row.edgeNodeId };
        let outcome: EdgeDeferredApplyOutcome;
        try {
          outcome = await drain.transaction((savepoint) =>
            applyParked(savepoint, row.envelope, rowMeta),
          );
        } catch (error) {
          // Any failure (review K F3): the row savepoint is already rolled
          // back, so the row is marked and the drain goes on.
          outcome = "refused";
          refusedClasses.add(errorClassOf(error));
        }
        await drain
          .update(edgeDeferredEvents)
          .set({
            appliedAt: sql`now()`,
            applyOutcome: outcome,
            // Rows parked by an older cloud may still hold pin hash
            // material (review K F7).
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
          { drained: rows.length, errorClasses: [...refusedClasses] },
          "Parked edge access events refused during drain",
        );
      return rows.length;
    });
  } catch {
    // Intentionally silent: the rows stay parked for the next access event;
    // no payload or ids in logs (ports.ts rule).
    return 0;
  }
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
    await drainParkedAccessEvents(tx, meta, outletId);
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
