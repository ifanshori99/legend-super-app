// Accepted legacy edge refund envelopes are payout facts even while the POS
// mirror is deferred. Validate the entire fact before using it as money; an
// unreadable history cannot authorize another payout.
import { ulidSchema, ulidToUuid, uuidToUlid } from "@starter/shared/core";
import {
  posEvents,
  orderRefundedPayloadSchema,
  orderVoidedPayloadSchema,
} from "@starter/shared/pos";
import { sql } from "drizzle-orm";
import { HttpError } from "../lib/http-error.ts";
import type { Tx } from "./permission-resolver.ts";

export type DeferredRefundCommitment = {
  refundId: string;
  orderId: string;
  amountIdr: number;
};

const unverified = () =>
  new HttpError(
    409,
    "REFUND_HISTORY_UNVERIFIED",
    "Riwayat refund pesanan belum dapat diverifikasi; lakukan rekonsiliasi sebelum refund berikutnya.",
  );

function canonicalOrderId(value: string): string {
  // Orders store all 128 ULID bits in PostgreSQL uuid columns; those bits
  // need not satisfy the version/variant restrictions of an RFC UUID.
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
    return value.toLowerCase();
  const ulid = ulidSchema.safeParse(value);
  if (ulid.success) return ulidToUuid(ulid.data);
  throw unverified();
}

/**
 * A parked edge `order.voided` that closed the final sale paid its cash out of
 * a drawer, but nothing materializes it into pos_order_voids yet. Until a void
 * row exists for the order, a second cash payout (cloud void or refund) would
 * pay the same money twice, so refuse with the same reconcile error as parked
 * refunds. Validated fail-closed like the refund facts; an open-order void
 * (voidedFinalOrder false) paid nothing and is ignored.
 */
async function assertNoParkedFinalVoid(
  tx: Tx,
  input: {
    tenantId: string;
    outletId: string;
    approvedBefore?: Date;
  },
  orderIds: ReadonlySet<string>,
  identifiers: ReturnType<typeof sql.join>,
): Promise<void> {
  const { rows } = await tx.execute<{
    tenant_id: string;
    outlet_id: string;
    event_id: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_sequence: string;
    event_name: string;
    envelope: unknown;
  }>(sql`
    SELECT tenant_id::text, outlet_id::text, event_id::text,
           aggregate_type, aggregate_id, aggregate_sequence::text,
           event_name, envelope
      FROM edge_deferred_events
     WHERE tenant_id = ${input.tenantId}
       AND (event_name = 'order.voided' OR envelope->>'name' = 'order.voided')
       AND (
         (aggregate_type = 'order' AND lower(aggregate_id) IN (${identifiers}))
         OR lower(envelope->>'aggregateId') IN (${identifiers})
         OR lower(envelope->'payload'->>'orderId') IN (${identifiers})
       )
  `);
  const parked = new Map<string, number>();
  for (const row of rows) {
    const parsed = posEvents["order.voided"].envelopeSchema.safeParse(
      row.envelope,
    );
    if (!parsed.success) throw unverified();
    const event = parsed.data;
    const parsedPayload = orderVoidedPayloadSchema.safeParse(event.payload);
    if (!parsedPayload.success) throw unverified();
    const payload = parsedPayload.data;
    const orderId = canonicalOrderId(payload.orderId);
    if (
      row.tenant_id !== input.tenantId ||
      row.outlet_id !== input.outletId ||
      event.tenantId !== input.tenantId ||
      event.outletId !== input.outletId ||
      payload.outletId !== input.outletId ||
      row.event_name !== "order.voided" ||
      row.aggregate_type !== "order" ||
      row.event_id !== ulidToUuid(event.id) ||
      Number(row.aggregate_sequence) !== event.sequence ||
      canonicalOrderId(row.aggregate_id) !== orderId ||
      canonicalOrderId(event.aggregateId) !== orderId ||
      !orderIds.has(orderId)
    )
      throw unverified();
    if (!payload.voidedFinalOrder) continue;
    const voidedAt = Date.parse(payload.voidedAt);
    // Same rule as refund facts: a later void cannot invalidate an earlier
    // approval being revalidated.
    if (
      input.approvedBefore !== undefined &&
      voidedAt > input.approvedBefore.getTime()
    )
      continue;
    parked.set(orderId, voidedAt);
  }
  if (parked.size === 0) return;
  const ids = sql.join(
    [...parked.keys()].map((id) => sql`${id}`),
    sql`, `,
  );
  const materialized = await tx.execute<{ order_id: string }>(sql`
    SELECT DISTINCT order_id::text AS order_id FROM pos_order_voids
     WHERE tenant_id = ${input.tenantId} AND order_id::text IN (${ids})
  `);
  const done = new Set(materialized.rows.map((row) => row.order_id));
  if ([...parked.keys()].some((orderId) => !done.has(orderId)))
    throw unverified();
}

/**
 * Count a refund once across replayed event IDs and nodes. The caller merges
 * these identities with native POS rows and excludes their gateway mirrors.
 * A connected edge link alone does not prove that no other history exists;
 * new edge refunds remain disabled at the POS service boundary.
 */
export async function loadDeferredRefundCommitments(
  tx: Tx,
  input: {
    tenantId: string;
    outletId: string;
    orderIds: readonly string[];
    approvedBefore?: Date;
    /** Source identities proven by the current gateway mirror's durable key. */
    retainRefundIds?: readonly string[];
  },
): Promise<DeferredRefundCommitment[]> {
  if (input.orderIds.length === 0) return [];
  const retained = new Set(
    (input.retainRefundIds ?? []).map((refundId) => refundId.toLowerCase()),
  );
  const orderIds = new Set(input.orderIds.map(canonicalOrderId));
  const aliases = [...orderIds].flatMap((id) => [
    id,
    uuidToUlid(id).toLowerCase(),
  ]);
  const identifiers = sql.join(
    aliases.map((id) => sql`${id}`),
    sql`, `,
  );
  await assertNoParkedFinalVoid(tx, input, orderIds, identifiers);
  const { rows } = await tx.execute<{
    tenant_id: string;
    outlet_id: string;
    event_id: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_sequence: string;
    event_name: string;
    envelope: unknown;
  }>(sql`
    SELECT tenant_id::text, outlet_id::text, event_id::text,
           aggregate_type, aggregate_id, aggregate_sequence::text,
           event_name, envelope
      FROM edge_deferred_events
     WHERE tenant_id = ${input.tenantId}
       AND (event_name = 'order.refunded' OR envelope->>'name' = 'order.refunded')
       AND (
         (aggregate_type = 'order' AND lower(aggregate_id) IN (${identifiers}))
         OR lower(envelope->>'aggregateId') IN (${identifiers})
         OR lower(envelope->'payload'->>'orderId') IN (${identifiers})
       )
  `);
  const byRefund = new Map<
    string,
    DeferredRefundCommitment & { refundedAt: number }
  >();
  for (const row of rows) {
    const parsed = posEvents["order.refunded"].envelopeSchema.safeParse(
      row.envelope,
    );
    if (!parsed.success) throw unverified();
    const event = parsed.data;
    const parsedPayload = orderRefundedPayloadSchema.safeParse(event.payload);
    if (!parsedPayload.success) throw unverified();
    const payload = parsedPayload.data;
    const orderId = canonicalOrderId(payload.orderId);
    if (
      row.tenant_id !== input.tenantId ||
      row.outlet_id !== input.outletId ||
      event.tenantId !== input.tenantId ||
      event.outletId !== input.outletId ||
      payload.outletId !== input.outletId ||
      row.event_name !== "order.refunded" ||
      row.aggregate_type !== "order" ||
      row.event_id !== ulidToUuid(event.id) ||
      Number(row.aggregate_sequence) !== event.sequence ||
      canonicalOrderId(row.aggregate_id) !== orderId ||
      canonicalOrderId(event.aggregateId) !== orderId ||
      !orderIds.has(orderId)
    )
      throw unverified();
    const fact = {
      refundId: payload.refundId.toLowerCase(),
      orderId,
      amountIdr: Number(payload.amountIdr),
      refundedAt: Date.parse(payload.refundedAt),
    };
    const previous = byRefund.get(fact.refundId);
    if (
      previous &&
      (previous.orderId !== fact.orderId ||
        previous.amountIdr !== fact.amountIdr)
    )
      throw unverified();
    byRefund.set(fact.refundId, {
      ...fact,
      // A duplicate cannot move an already committed payout into the future.
      refundedAt: Math.min(
        previous?.refundedAt ?? fact.refundedAt,
        fact.refundedAt,
      ),
    });
  }
  return [...byRefund.values()]
    .filter(
      (fact) =>
        input.approvedBefore === undefined ||
        fact.refundedAt <= input.approvedBefore.getTime() ||
        retained.has(fact.refundId),
    )
    .map(({ refundId, orderId, amountIdr }) => ({
      refundId,
      orderId,
      amountIdr,
    }));
}

export type ParkedEdgeRefundFact =
  | {
      readable: true;
      refundId: string;
      orderId: string;
      outletId: string;
      amountIdr: number;
      receivedAt: Date;
    }
  | {
      readable: false;
      /** Order uuid when the row's aggregate id is one, else the raw id. */
      aggregateId: string;
      outletId: string;
      receivedAt: Date;
    };

/**
 * Every parked edge `order.refunded` of a tenant (optionally limited to
 * outlets), for the finance exception list (brief 1244 r2). Same envelope and
 * payload rules as `loadDeferredRefundCommitments`, but a row that fails them
 * is returned as `readable: false` instead of throwing, and a refund id seen
 * twice with another order or amount turns both orders unreadable. Counts a
 * refund once across replayed event IDs and nodes. Read-only.
 */
export async function listParkedEdgeRefundFacts(
  tx: Tx,
  input: { tenantId: string; outletIds: readonly string[] | null },
): Promise<ParkedEdgeRefundFact[]> {
  const outletFilter =
    input.outletIds === null
      ? sql`TRUE`
      : sql`outlet_id IN (${sql.join(
          input.outletIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
  const { rows } = await tx.execute<{
    tenant_id: string;
    outlet_id: string;
    event_id: string;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_sequence: string;
    event_name: string;
    envelope: unknown;
    received_at: string | Date;
  }>(sql`
    SELECT tenant_id::text, outlet_id::text, event_id::text,
           aggregate_type, aggregate_id, aggregate_sequence::text,
           event_name, envelope, received_at
      FROM edge_deferred_events
     WHERE tenant_id = ${input.tenantId}
       AND (event_name = 'order.refunded' OR envelope->>'name' = 'order.refunded')
       AND ${outletFilter}
     ORDER BY received_at, event_id
  `);
  const byRefund = new Map<
    string,
    Extract<ParkedEdgeRefundFact, { readable: true }>
  >();
  const conflicted = new Set<string>();
  const unreadable: Extract<ParkedEdgeRefundFact, { readable: false }>[] = [];
  const markUnreadable = (
    aggregateId: string,
    outletId: string,
    receivedAt: Date,
  ) => {
    let id = aggregateId;
    try {
      id = canonicalOrderId(aggregateId);
    } catch {
      // Not an order id: keep the raw value as the reference.
    }
    unreadable.push({ readable: false, aggregateId: id, outletId, receivedAt });
  };
  for (const row of rows) {
    const receivedAt = new Date(row.received_at);
    try {
      const parsed = posEvents["order.refunded"].envelopeSchema.safeParse(
        row.envelope,
      );
      if (!parsed.success) throw unverified();
      const event = parsed.data;
      const parsedPayload = orderRefundedPayloadSchema.safeParse(event.payload);
      if (!parsedPayload.success) throw unverified();
      const payload = parsedPayload.data;
      const orderId = canonicalOrderId(payload.orderId);
      if (
        row.tenant_id !== input.tenantId ||
        event.tenantId !== input.tenantId ||
        event.outletId !== row.outlet_id ||
        payload.outletId !== row.outlet_id ||
        row.event_name !== "order.refunded" ||
        row.aggregate_type !== "order" ||
        row.event_id !== ulidToUuid(event.id) ||
        Number(row.aggregate_sequence) !== event.sequence ||
        canonicalOrderId(row.aggregate_id) !== orderId ||
        canonicalOrderId(event.aggregateId) !== orderId
      )
        throw unverified();
      const fact = {
        readable: true as const,
        refundId: payload.refundId.toLowerCase(),
        orderId,
        outletId: row.outlet_id,
        amountIdr: Number(payload.amountIdr),
        receivedAt,
      };
      if (!Number.isSafeInteger(fact.amountIdr)) throw unverified();
      const previous = byRefund.get(fact.refundId);
      if (
        conflicted.has(fact.refundId) ||
        (previous &&
          (previous.orderId !== fact.orderId ||
            previous.amountIdr !== fact.amountIdr))
      ) {
        conflicted.add(fact.refundId);
        if (previous) {
          markUnreadable(
            previous.orderId,
            previous.outletId,
            previous.receivedAt,
          );
          byRefund.delete(fact.refundId);
        }
        markUnreadable(orderId, fact.outletId, receivedAt);
        continue;
      }
      byRefund.set(fact.refundId, {
        ...fact,
        receivedAt:
          previous && previous.receivedAt > receivedAt
            ? previous.receivedAt
            : receivedAt,
      });
    } catch {
      markUnreadable(row.aggregate_id, row.outlet_id, receivedAt);
    }
  }
  return [...byRefund.values(), ...unreadable];
}

/**
 * True when any `order.refunded` is parked for the order, readable or not (an
 * unreadable fact may still be a payout). Used by the edge void ingest: the
 * guest was already paid back from the drawer, so a void row (and a full
 * gateway refund it would allow) could pay the same money twice. Read-only.
 */
export async function hasParkedEdgeRefund(
  tx: Tx,
  input: { tenantId: string; orderId: string },
): Promise<boolean> {
  const uuid = canonicalOrderId(input.orderId);
  const ids = sql.join(
    [uuid, uuidToUlid(uuid).toLowerCase()].map((id) => sql`${id}`),
    sql`, `,
  );
  const { rows } = await tx.execute<{ found: number }>(sql`
    SELECT 1 AS found FROM edge_deferred_events
     WHERE tenant_id = ${input.tenantId}
       AND (event_name = 'order.refunded' OR envelope->>'name' = 'order.refunded')
       AND (
         lower(aggregate_id) IN (${ids})
         OR lower(envelope->>'aggregateId') IN (${ids})
         OR lower(envelope->'payload'->>'orderId') IN (${ids})
       )
     LIMIT 1
  `);
  return rows.length > 0;
}

/**
 * Money a parked legacy edge refund already paid out for the orders an intent
 * paid (brief 1244 r2). An edge void ingested first holds nothing of the sale,
 * so a full gateway refund would pay the guest a second time once the edge
 * refund is parked later. The admin refund cap is reduced by that value;
 * `null` means a fact is unreadable or conflicting: the caller must hold the
 * whole cap. Only orders of an outlet that has (or had) an edge node are checked (a
 * cloud QR order forwarded to an edge may have no ingest row), so outlets
 * without an edge never scan the parked events. Facts that already have a native row of the same id are not
 * counted (the sale accounting holds them). Read-only.
 */
export async function parkedEdgeRefundHoldOfIntent(
  tx: Tx,
  input: { tenantId: string; intentId: string; orderId: string | null },
): Promise<bigint | null> {
  const { rows: orders } = await tx.execute<{
    order_id: string;
    outlet_id: string;
  }>(sql`
    SELECT DISTINCT t.order_id::text AS order_id, t.outlet_id::text AS outlet_id
      FROM pos_order_tenders t
     WHERE t.tenant_id = ${input.tenantId}
       AND t.payment_intent_id = ${input.intentId}::uuid
       AND EXISTS (SELECT 1 FROM edge_nodes n
                    WHERE n.tenant_id = t.tenant_id AND n.outlet_id = t.outlet_id)
    UNION
    SELECT o.id::text, o.outlet_id::text FROM orders o
     WHERE o.tenant_id = ${input.tenantId}
       AND o.id = ${input.orderId}::uuid
       AND EXISTS (SELECT 1 FROM edge_nodes n
                    WHERE n.tenant_id = o.tenant_id AND n.outlet_id = o.outlet_id)
  `);
  let hold = 0n;
  for (const order of orders) {
    try {
      if (
        !(await hasParkedEdgeRefund(tx, {
          tenantId: input.tenantId,
          orderId: order.order_id,
        }))
      )
        continue;
      const facts = await loadDeferredRefundCommitments(tx, {
        tenantId: input.tenantId,
        outletId: order.outlet_id,
        orderIds: [order.order_id],
      });
      const { rows: native } = await tx.execute<{ id: string }>(sql`
        SELECT id::text AS id FROM pos_order_refunds
         WHERE tenant_id = ${input.tenantId} AND order_id = ${order.order_id}::uuid
      `);
      const done = new Set(native.map((row) => row.id.toLowerCase()));
      for (const fact of facts)
        if (!done.has(fact.refundId)) hold += BigInt(fact.amountIdr);
    } catch (error) {
      // Only an unverifiable history holds the cap; a database or code error
      // must surface, not silently freeze or free money.
      if (
        error instanceof HttpError &&
        error.code === "REFUND_HISTORY_UNVERIFIED"
      )
        return null;
      throw error;
    }
  }
  return hold;
}
