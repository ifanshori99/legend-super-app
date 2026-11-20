// Cloud side of the edge -> cloud `receipt_run.reported` event (bead
// legend-zy43): an edge node reports one offline device receipt run and the
// cloud merges it with mergeDeviceReceiptRun (pos-receipt.service.ts) in the
// apply transaction. The merge is idempotent (a replay inserts nothing), so a
// redelivered event is safe.
//
// Fail closed like the other appliers: a wrong direction, tenant, outlet or
// node, a payload that does not parse, or a run that names another tenant,
// outlet or device throws a CoreError (4xx); the link records an
// `applier_refused` conflict (db-link-store.ts) instead of stalling the node.
// A merge refusal (PosError 4xx: RECEIPT_SEQUENCE_GAP, RECEIPT_SEQUENCE_NOT_
// PROVISIONED, prefix mismatch, regression, unmatched void) is refused the
// same way, never retried: the merge writes nothing on a refusal, and the
// device resends the full run (a later event) once the hole or the
// provisioning is fixed. Anything else (database failure) aborts the batch so
// the sender keeps it queued. The cloud apply writes no outbox event (it would
// echo back to the edge). Never logs payloads.
//
// legend-n1fzg: a receipt of an order the cloud permanently refused to ingest
// (edge_order_ingests state 'refused', reason `order_exists` / `legacy_payload`)
// can never merge: there is no cloud order for it. Left in the run it would
// refuse every chunk holding it and leave a hole that holds every later chunk.
// The applier SKIPS it before the merge (no revenue, no receipt row), records
// it once per (tenant, order) as an `edge_sync_conflicts` row finance sees
// (number, order, reason) and lets the merge treat its number as accounted for,
// also in later chunks. Review of n1fzg: the skips live in `edge_receipt_skips`
// (one row per tenant, outlet, order, receipt number, reason; the unique key
// makes a redelivery idempotent), not in a conflict detail, which holds 500
// chars and refused the run whole past ~5 skips. The event gets ONE compact
// conflict (skip count, no list). Other refusals (transient `db_error:*`, ...)
// are never skipped.
//
// legend-n2d3g: an order whose `order.paid` event the edge dead-lettered (frame
// too large, legend-btx4d) never reaches the cloud either (the cloud creates an
// order only from `order.paid`, so a dead `order.placed` alone skips nothing).
// The `edge_link.dead_lettered` notice arrives before any later event of the
// link and records a `link_event_dead_lettered` conflict on the dead event's
// order aggregate; its receipts are skipped the same way (reason
// `link_dead_lettered`). Only for the notice's own outlet, and never for an
// order the cloud already holds (ingested/voided/cancelled or a pos_orders row).
//
// legend-gdjpu (SO 1111 P2): the link acknowledges `order.paid` /
// `order.voided` even when their ingest was refused for a TRANSIENT reason
// (lock timeout, deadlock; R1 in order-ingest.ts: the ingest never throws), and
// the redrive sweep heals the order later. The edge reporter takes that ack as
// "the cloud holds the order/void" and sends the run. A merge refusal of such a
// run (RECEIPT_VOID_UNMATCHED, prefix mismatch, ...) must not become a
// conflict: the link would acknowledge it and the edge never resends it, so
// the receipts would stay missing in the cloud. While an order of the run has a
// transient refusal on its ledger row, a merge refusal is a plain Error: the
// batch aborts, nothing is recorded, the edge keeps the run queued and retries
// the SAME event; once the sweep heals the order the retry merges. A refusal
// the sweep turns final ends the hold (the run is then refused as before), and
// so does a hold older than RECEIPT_RUN_INGEST_HOLD_MS (conflict + manager
// alert), so a refusal that never heals cannot stall the node's sync forever.
// No money moves on this path.
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  CoreError,
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
} from "@starter/shared/core";
import { conflictResolution } from "@starter/shared/edge";
import type { EventEnvelope } from "@starter/shared/events";
import {
  PosError,
  RECEIPT_RUN_AGGREGATE,
  RECEIPT_RUN_REPORTED_EVENT,
  receiptRunReportedPayloadSchema,
} from "@starter/shared/pos";
import { edgeOrderIngests } from "../db/schema/edge-order-ingest.ts";
import { edgeReceiptSkips } from "../db/schema/edge-receipt-skip.ts";
import { notifyEdgeSyncConflictRecorded } from "../services/edge-sync-conflict-alert.ts";
import { sourceIdToDb } from "../services/inventory.service.ts";
import { mergeDeviceReceiptRun } from "../services/pos-receipt.service.ts";
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
import {
  ORDER_AGGREGATE,
  assertEdgeEventScope,
} from "./deferred-event-applier.ts";
import { redactEdgeEnvelopeSecrets } from "./envelope-secrets.ts";
import { TRANSIENT_REFUSAL_REASONS } from "./order-ingest.ts";
import { LINK_EVENT_DEAD_LETTERED_REASON } from "./link-dead-letter-applier.ts";
import type { EdgeApplyMeta } from "./ports.ts";

/** Conflict reason of a receipt skipped for a permanently refused order. */
export const RECEIPT_SKIPPED_REFUSED_ORDER_REASON =
  "receipt_skipped_refused_order";
/** Skip reason of a receipt whose order event the edge dead-lettered. */
export const RECEIPT_SKIP_LINK_DEAD_LETTERED = "link_dead_lettered";
/** The dead-lettered order event that leaves the cloud without the order. */
const ORDER_CREATING_EVENT = "order.paid";
/** Ingest refusals that never heal: the cloud will never hold the order. */
const PERMANENT_INGEST_REFUSALS: ReadonlySet<string> = new Set([
  "order_exists",
  "legacy_payload",
]);

/**
 * Each report is a self-contained run (the device resends the full range), so
 * the link accepts any aggregate sequence, like the access applier does.
 */
const acceptIncomingSequence: EdgeLastSequenceHook = async (_tx, aggregate) =>
  aggregate.sequence === undefined ? null : aggregate.sequence - 1;

/** A merge refusal becomes a 4xx CoreError (a conflict row, not a stall). */
function refuseMerge(error: unknown): never {
  if (error instanceof PosError && error.status >= 400 && error.status < 500)
    throw new CoreError(
      error.status === 409 ? "CONFLICT" : "VALIDATION_ERROR",
      error.message,
    );
  throw error;
}

/** Ledger reasons of an order whose ingest the redrive sweep will retry. */
const RETRIED_INGEST_REASONS: readonly string[] = [
  ...TRANSIENT_REFUSAL_REASONS,
  ...TRANSIENT_REFUSAL_REASONS.map((reason) => `void_refused:${reason}`),
];

/**
 * Longest a transient ingest refusal holds a run (legend-gdjpu bound): counted
 * from when the cloud parked the refused event (cloud clock). The redrive sweep
 * retries on every relay tick, so this is many attempts. Past it the refusal is
 * treated like a permanent one: the run is refused, the link records a conflict
 * and alerts the managers (db-link-store.ts), and the node's sync moves on.
 */
export const RECEIPT_RUN_INGEST_HOLD_MS = 30 * 60_000;

/** Conflict detail prefix when the hold ran out (finance and support filter on it). */
export const INGEST_HOLD_EXPIRED_PREFIX = "ingest_hold_expired:";

/**
 * `hold` when an order of the run waits on a transient ingest refusal whose
 * refused event (`order.paid`, or `order.voided` for `void_refused:*`) was
 * parked less than RECEIPT_RUN_INGEST_HOLD_MS ago; `expired` when such a
 * refusal exists but every refused event is older; `none` otherwise. An event
 * parked in THIS transaction (received_at = now()) never counts: the edge
 * reporter sends a run only after the cloud acknowledged the order event it
 * depends on (edge-receipt-run-reporter.ts), so a same-batch park is not that
 * dependency, and the hold never rolls back the batch that parked it.
 */
async function hasRetriedIngest(
  tx: EdgeTx,
  tenantId: string,
  orderIds: string[],
): Promise<"none" | "hold" | "expired"> {
  if (orderIds.length === 0) return "none";
  const tenant = tenantIdSchema.parse(tenantId);
  const rows = await tx
    .select({
      orderId: edgeOrderIngests.orderId,
      paidEventId: edgeOrderIngests.paidEventId,
      reason: edgeOrderIngests.reason,
    })
    .from(edgeOrderIngests)
    .where(
      and(
        eq(edgeOrderIngests.tenantId, tenant),
        inArray(edgeOrderIngests.orderId, orderIds),
        inArray(edgeOrderIngests.reason, [...RETRIED_INGEST_REASONS]),
      ),
    );
  if (rows.length === 0) return "none";
  const paidEvents = rows
    .filter((row) => !row.reason?.startsWith("void_refused:"))
    .map((row) => sql`${ulidToUuid(row.paidEventId)}::uuid`);
  const voidForms = rows
    .filter((row) => row.reason?.startsWith("void_refused:"))
    .flatMap((row) => {
      const uuid = sourceIdToDb(row.orderId);
      return [row.orderId, uuid, uuidToUlid(uuid)].map(
        (form) => sql`${form.toLowerCase()}`,
      );
    });
  const refused = [
    ...(paidEvents.length > 0
      ? [
          sql`(event_name = 'order.paid' AND event_id IN (${sql.join(paidEvents, sql`, `)}))`,
        ]
      : []),
    ...(voidForms.length > 0
      ? [
          sql`(event_name = 'order.voided' AND aggregate_type = ${ORDER_AGGREGATE}
               AND lower(aggregate_id) IN (${sql.join(voidForms, sql`, `)}))`,
        ]
      : []),
  ];
  const fresh = await tx.execute(
    sql`SELECT 1 FROM edge_deferred_events
        WHERE tenant_id = ${tenant}::uuid
          AND received_at < now()
          AND received_at > now() - make_interval(secs => ${RECEIPT_RUN_INGEST_HOLD_MS / 1000}::double precision)
          AND (${sql.join(refused, sql` OR `)})
        LIMIT 1`,
  );
  return fresh.rows.length > 0 ? "hold" : "expired";
}

/** order id -> permanent refusal reason, for the given orders of this tenant. */
async function permanentlyRefusedOrders(
  tx: EdgeTx,
  tenantId: string,
  outletId: string,
  orderIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (orderIds.length === 0) return out;
  const rows = await tx
    .select({
      orderId: edgeOrderIngests.orderId,
      reason: edgeOrderIngests.reason,
    })
    .from(edgeOrderIngests)
    .where(
      and(
        eq(edgeOrderIngests.tenantId, tenantIdSchema.parse(tenantId)),
        eq(edgeOrderIngests.state, "refused"),
        inArray(edgeOrderIngests.orderId, orderIds),
      ),
    );
  for (const row of rows)
    if (row.reason !== null && PERMANENT_INGEST_REFUSALS.has(row.reason))
      out.set(row.orderId, row.reason);
  // Second source: the order's paid event is dead-lettered on the edge.
  // The conflict keeps the order aggregate id as the edge sent it (ULID or
  // UUID), so match both forms.
  const pending = orderIds.filter((id) => !out.has(id));
  if (pending.length === 0) return out;
  const byForm = new Map<string, string>();
  for (const id of pending) {
    const uuid = sourceIdToDb(id);
    for (const form of [id, uuid, uuidToUlid(uuid)])
      byForm.set(form.toLowerCase(), id);
  }
  const dead = await tx.execute(
    sql`SELECT DISTINCT lower(aggregate_id) AS id FROM edge_sync_conflicts
        WHERE tenant_id = ${tenantIdSchema.parse(tenantId)}::uuid
          AND reason = ${LINK_EVENT_DEAD_LETTERED_REASON}
          AND outlet_id = ${outletIdSchema.parse(outletId)}::uuid
          AND aggregate_type = ${ORDER_AGGREGATE}
          AND lower(aggregate_id) IN (${sql.join(
            [...byForm.keys()].map((form) => sql`${form}`),
            sql`, `,
          )})
          AND event -> 'payload' ->> 'eventName' = ${ORDER_CREATING_EVENT}`,
  );
  const deadOrders = new Map<string, string>();
  for (const row of dead.rows as { id: string }[]) {
    const orderId = byForm.get(row.id);
    if (orderId !== undefined) deadOrders.set(orderId, sourceIdToDb(orderId));
  }
  if (deadOrders.size === 0) return out;
  // Fail closed: an order the cloud already holds (a later or redelivered
  // paid event got through) is never skipped; its receipt merges normally.
  const held = await tx.execute(
    sql`SELECT order_id::text AS id FROM edge_order_ingests
        WHERE tenant_id = ${tenantIdSchema.parse(tenantId)}::uuid
          AND state IN ('ingested', 'voided', 'cancelled')
          AND order_id IN (${sql.join(
            [...deadOrders.values()].map((uuid) => sql`${uuid}::uuid`),
            sql`, `,
          )})
        UNION
        SELECT order_id::text AS id FROM pos_orders
        WHERE tenant_id = ${tenantIdSchema.parse(tenantId)}::uuid
          AND order_id IN (${sql.join(
            [...deadOrders.values()].map((uuid) => sql`${uuid}::uuid`),
            sql`, `,
          )})`,
  );
  const known = new Set(
    (held.rows as { id: string }[]).map((row) => row.id.toLowerCase()),
  );
  for (const [orderId, uuid] of deadOrders)
    if (!known.has(uuid.toLowerCase()))
      out.set(orderId, RECEIPT_SKIP_LINK_DEAD_LETTERED);
  return out;
}

/** Skips already recorded for the outlet: the receipt numbers and the orders. */
async function recordedSkips(
  tx: EdgeTx,
  tenantId: string,
  outletId: string,
): Promise<{ numbers: Set<string>; orders: Set<string> }> {
  const rows = await tx
    .select({
      number: edgeReceiptSkips.receiptNumber,
      orderId: edgeReceiptSkips.orderId,
    })
    .from(edgeReceiptSkips)
    .where(
      and(
        eq(edgeReceiptSkips.tenantId, tenantIdSchema.parse(tenantId)),
        eq(edgeReceiptSkips.outletId, outletIdSchema.parse(outletId)),
      ),
    );
  return {
    numbers: new Set(rows.map((row) => row.number)),
    orders: new Set(rows.map((row) => row.orderId)),
  };
}

function ordinalOf(number: string, prefix: string): number | null {
  const match = /^(.+)-(\d+)$/.exec(number);
  return match && match[1] === prefix ? Number(match[2]) : null;
}

/**
 * Records the new skips of one event: one `edge_receipt_skips` row each
 * (idempotent: the unique key keeps what is already held) and ONE compact
 * conflict row for the event (skip count only; it is unique per event).
 */
async function recordSkips(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
  outletId: string,
  skips: { number: string; orderId: string; reason: string }[],
): Promise<void> {
  if (skips.length === 0) return;
  const stored = await tx
    .insert(edgeReceiptSkips)
    .values(
      skips.map((skip) => ({
        tenantId: tenantIdSchema.parse(meta.context.tenant.tenantId),
        outletId: outletIdSchema.parse(outletId),
        orderId: skip.orderId,
        receiptNumber: skip.number,
        reason: skip.reason,
        eventId: event.id,
      })),
    )
    .onConflictDoNothing()
    .returning({ orderId: edgeReceiptSkips.orderId });
  if (stored.length === 0) return;
  const detail = `skipped ${stored.length} receipt${stored.length === 1 ? "" : "s"} of refused orders (see edge_receipt_skips)`;
  const conflictId = createUlid();
  const inserted = await tx.execute(
    sql`INSERT INTO edge_sync_conflicts (id, tenant_id, outlet_id, edge_node_id, direction, event_id, aggregate_type, aggregate_id, aggregate_sequence, kind, reason, resolution, existing_sequence, detail, event) VALUES (${ulidToUuid(conflictId)}::uuid, ${meta.context.tenant.tenantId}::uuid, ${outletId}::uuid, ${meta.edgeNodeId}::uuid, ${meta.direction}, ${ulidToUuid(event.id)}::uuid, ${event.aggregateType}, ${event.aggregateId}, ${event.sequence}, ${meta.kind}, ${RECEIPT_SKIPPED_REFUSED_ORDER_REASON}, ${conflictResolution(meta.kind)}, ${Math.max(0, event.sequence - 1)}, ${detail}, ${JSON.stringify(redactEdgeEnvelopeSecrets(event))}::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
  );
  if (inserted.rows.length === 0) return;
  // Supervisor alert in a savepoint: never fails the batch (the row is the
  // durable evidence), as in db-link-store.ts.
  try {
    await tx.transaction((savepoint) =>
      notifyEdgeSyncConflictRecorded(savepoint, meta.context, {
        id: conflictId,
        tenantId: tenantIdSchema.parse(meta.context.tenant.tenantId),
        outletId: outletIdSchema.parse(outletId),
        edgeNodeId: meta.edgeNodeId,
        aggregateType: event.aggregateType,
        reason: RECEIPT_SKIPPED_REFUSED_ORDER_REASON,
      }),
    );
  } catch {
    // Intentionally silent: no payload or ids in logs (ports.ts rule).
  }
}

async function applyReceiptRunReported(
  tx: EdgeTx,
  event: EventEnvelope,
  meta: EdgeApplyMeta,
): Promise<void> {
  const outletId = await assertEdgeEventScope(tx, event, meta);
  const parsed = receiptRunReportedPayloadSchema.safeParse(event.payload);
  if (!parsed.success)
    throw new CoreError("VALIDATION_ERROR", `Invalid ${event.name} payload`);
  const { sequence, receipts } = parsed.data;
  const tenantId = meta.context.tenant.tenantId;
  // The run must belong to the event's own tenant, outlet and device (the
  // aggregate id is the device id); nothing a payload says widens the scope.
  if (
    event.aggregateType !== RECEIPT_RUN_AGGREGATE ||
    event.aggregateId.toLowerCase() !== sequence.deviceId.toLowerCase() ||
    sequence.tenantId !== tenantId ||
    sequence.outletId !== outletId ||
    receipts.some(
      ({ receipt }) =>
        receipt.tenantId !== tenantId ||
        receipt.outletId !== outletId ||
        receipt.deviceId !== sequence.deviceId,
    )
  )
    throw new CoreError(
      "VALIDATION_ERROR",
      "Receipt run does not match its event scope",
    );
  const permanent = await permanentlyRefusedOrders(
    tx,
    tenantId,
    outletId,
    receipts.map(({ receipt }) => receipt.orderId),
  );
  const skipped = receipts.filter(({ receipt }) =>
    permanent.has(receipt.orderId),
  );
  const kept = receipts.filter(
    ({ receipt }) => !permanent.has(receipt.orderId),
  );
  const skippedOrdinals = new Set<number>(
    skipped.map(({ receipt }) => receipt.sequenceNumber),
  );
  const recorded = await recordedSkips(tx, tenantId, outletId);
  for (const number of recorded.numbers) {
    const ordinal = ordinalOf(number, sequence.prefix);
    if (ordinal !== null) skippedOrdinals.add(ordinal);
  }
  await recordSkips(
    tx,
    event,
    meta,
    outletId,
    skipped
      .filter(({ receipt }) => !recorded.orders.has(receipt.orderId))
      .map(({ receipt }) => ({
        number: receipt.number,
        orderId: receipt.orderId,
        reason: permanent.get(receipt.orderId) ?? "",
      })),
  );
  // Read before the merge: a refused merge may leave the savepoint unusable.
  const ingestHold = await hasRetriedIngest(
    tx,
    tenantId,
    kept.map(({ receipt }) => receipt.orderId),
  );
  try {
    await mergeDeviceReceiptRun(tx, meta.context, {
      sequence: {
        outletId: sequence.outletId,
        deviceId: sequence.deviceId,
        prefix: sequence.prefix,
        lastNumber: sequence.lastNumber,
      },
      receipts: kept.map(({ receipt, outletSnapshot }) => ({
        ...receipt,
        outletSnapshot,
      })),
      skippedOrdinals,
    });
  } catch (error) {
    if (
      ingestHold !== "none" &&
      error instanceof PosError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      if (ingestHold === "hold")
        throw new Error(
          "Receipt run waits on a transient order ingest refusal; retry later",
        );
      refuseMerge(
        new PosError(
          error.code,
          `${INGEST_HOLD_EXPIRED_PREFIX}${error.message}`,
        ),
      );
    }
    refuseMerge(error);
  }
}

// Stable identity: the registry treats a different handler as a wiring bug.
const handleReceiptRunReported: EdgeEventHandler = applyReceiptRunReported;

/**
 * Cloud boot (registerEdgeLink): applies `receipt_run.reported` from an edge
 * and classifies the `receipt_run` aggregate as append-only transaction
 * events. Idempotent.
 */
export function registerReceiptRunEdgeApplier(): void {
  registerEdgeEventHandler(
    "edge_to_cloud",
    RECEIPT_RUN_REPORTED_EVENT,
    handleReceiptRunReported,
  );
  registerEdgeAggregateKind(RECEIPT_RUN_AGGREGATE, "transaction_event");
  registerEdgeAggregateLastSequence(
    "edge_to_cloud",
    RECEIPT_RUN_AGGREGATE,
    acceptIncomingSequence,
  );
}
