// Accepted legacy edge refund envelopes are payout facts even while the POS
// mirror is deferred. Validate the entire fact before using it as money; an
// unreadable history cannot authorize another payout.
import { ulidSchema, ulidToUuid, uuidToUlid } from "@starter/shared/core";
import { posEvents, orderRefundedPayloadSchema } from "@starter/shared/pos";
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
         lower(aggregate_id) IN (${identifiers})
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
