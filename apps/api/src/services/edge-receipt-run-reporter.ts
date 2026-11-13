// Edge producer of `receipt_run.reported` (bead legend-zy43). The edge numbers
// device receipts locally (allocateReceipt); this reporter turns every device
// run bound to THIS edge database into small outbox events, and the cloud
// merges each with mergeDeviceReceiptRun (edge/receipt-run-applier.ts).
//
// Why a periodic reporter and not an event in the sale transaction: the sale
// allocates the receipt before it appends `order.paid`, so an in-transaction
// event would overtake the order in the outbox and the cloud merge (which needs
// the order ingested first) would refuse it for good. The reporter runs
// outside the sale, so every order it reports was appended earlier.
//
// Bounded events (the link frame is capped at 4 MB, so one event must stay
// small): receipts go out in ascending CHUNKS of RECEIPT_RUN_REPORT_CHUNK
// receipts, each chunk starting right after the high-water of what this edge
// already reported FOR THAT PREFIX (the largest `sequence.lastNumber` of its
// earlier chunk events with the same prefix). A chunk's `sequence.lastNumber` is
// its own last ordinal, so the merge sees 1..lastNumber made of the cloud's
// earlier chunks plus this one and advances; no hole means no refusal. A pass
// sends at most RECEIPT_RUN_REPORT_MAX_CHUNKS chunks per run (rate cap: an
// offline backlog drains over several ticks, never as one huge burst).
//
// Order of delivery: the outbox order is NOT the link order (the relay assigns
// `link_seq` per aggregate when it delivers), and the cloud refuses a chunk
// whose order it has not ingested yet (RECEIPT_PREFIX_MISMATCH) or a void it
// has no void row for (RECEIPT_VOID_UNMATCHED), for good. So a receipt is
// reported only after the cloud ACKNOWLEDGED the event it depends on:
// `order.paid` of its order (and `order.voided` when the receipt is voided).
// "Acknowledged" = the outbox row is `delivered` (relayed into the link queue)
// AND its `edge_outbound_queue` row is `acked` (the cloud applied it); a row
// pruned after the ack leaves no pending queue row and counts as acknowledged.
// A chunk ends before the first receipt that is not acknowledged yet, and the
// high-water only moves with a chunk actually appended, so the held receipts go
// out in a later pass. An order with no `order.paid` event at all is never
// reported (fail closed).
//
// Exactly once: a chunk key is `<device>:<prefix>:c:<last ordinal>`; the
// high-water moves in the same transaction as the append (the sequence row is
// locked). A receipt voided after it was reported goes out as its own
// one-receipt event with key `<device>:<prefix>:v:<ordinal>` (at most
// RECEIPT_RUN_REPORT_MAX_VOIDS per pass), once `order.voided` is acknowledged;
// the key makes it once-only and the pass finds the unsent voids with one
// anti-join query (bounded by the limit). The cloud merge is idempotent, so a
// redelivery, an overlap or a void that was already inside a chunk inserts
// nothing. The outbox grows by one event per chunk of receipts and one per
// void; it is never rewritten. A failure on one run does not stop the others.
//
// Known limit (docs/design/edge-order-ingest.md "Receipt-run wiring"): the cloud
// refuses a chunk whose order was refused for good (order_exists, legacy
// payload), and later chunks of that run then hit the same hole.
//
// Scope: only runs bound to this edge node and database instance, never the
// cloud-owned sequence (device id = outlet id), never an empty run. Never logs
// payloads.
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  createUlid,
  outletIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  RECEIPT_RUN_AGGREGATE,
  receiptRunReportedEvent,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { domainEventOutbox } from "../db/schema/core-events.ts";
import { posReceipts, receiptSequences } from "../db/schema/pos-receipt.ts";
import { withTenant } from "../db/tenant.ts";
import { appendOutbox } from "./core-outbox.ts";
import { toPosReceipt } from "./pos-receipt.service.ts";

const EVENT_DESTINATION = "cloud-sync";

/** Receipts per event (~55 KB), far under the 4 MB link frame. */
export const RECEIPT_RUN_REPORT_CHUNK = 100;
/** Chunk events one pass appends per device. */
export const RECEIPT_RUN_REPORT_MAX_CHUNKS = 5;
/** Void events one pass appends per device. */
export const RECEIPT_RUN_REPORT_MAX_VOIDS = 20;

type ReceiptRowOf = typeof posReceipts.$inferSelect;
type ReportTx = Parameters<Parameters<typeof withTenant>[2]>[0];

/**
 * Order aggregate ids (uuid) whose event `name` the cloud acknowledged: the
 * outbox row is delivered and no link queue row of it is still pending.
 */
async function acknowledgedOrders(
  tx: ReportTx,
  tenantId: string,
  orderUuids: string[],
  name: "order.paid" | "order.voided",
): Promise<Set<string>> {
  if (orderUuids.length === 0) return new Set();
  const result = await tx.execute(
    sql`SELECT o.aggregate_id::text AS id FROM domain_event_outbox o
        WHERE o.tenant_id = ${tenantId}::uuid AND o.destination = ${EVENT_DESTINATION}
          AND o.aggregate_id IN (${sql.join(
            orderUuids.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
          AND o.event ->> 'name' = ${name} AND o.status = 'delivered'
          AND NOT EXISTS (
            SELECT 1 FROM edge_outbound_queue q
            WHERE q.tenant_id = o.tenant_id AND q.direction = 'edge_to_cloud'
              AND q.event_id = o.event_id AND q.status <> 'acked')
          AND NOT EXISTS (
            SELECT 1 FROM edge_link_dead_letters d
            WHERE d.tenant_id = o.tenant_id AND d.direction = 'edge_to_cloud'
              AND d.event_id = o.event_id)`,
  );
  return new Set((result.rows as { id: string }[]).map((row) => row.id));
}

function receiptEntry(row: ReceiptRowOf) {
  return {
    receipt: toPosReceipt(row),
    outletSnapshot: {
      outletName: row.outletSnapshot.outletName,
      outletAddress: row.outletSnapshot.outletAddress,
      legalName: row.outletSnapshot.legalName ?? null,
      npwpLast4: row.outletSnapshot.npwpLast4 ?? null,
    },
  };
}

/**
 * Appends the new chunk and void events of every device run of this edge
 * database; returns how many events it appended. Each run is its own
 * transaction (the sequence row is locked, so a sale on that device waits
 * instead of racing).
 */
export async function reportEdgeReceiptRuns(
  context: ScopedTenantContext,
  input: { outletId: string; edgeNodeId: string; edgeInstanceId: string },
  limits: { chunk?: number; maxChunks?: number; maxVoids?: number } = {},
): Promise<{ reported: number; errors?: unknown[] }> {
  const chunkSize = limits.chunk ?? RECEIPT_RUN_REPORT_CHUNK;
  const maxChunks = limits.maxChunks ?? RECEIPT_RUN_REPORT_MAX_CHUNKS;
  const maxVoids = limits.maxVoids ?? RECEIPT_RUN_REPORT_MAX_VOIDS;
  const tenantId = context.tenant.tenantId;
  const outletId = outletIdSchema.parse(input.outletId);
  const candidates = await withTenant(db, context, (tx) =>
    tx
      .select({ id: receiptSequences.id })
      .from(receiptSequences)
      .where(
        and(
          eq(receiptSequences.tenantId, tenantId),
          eq(receiptSequences.outletId, outletId),
          eq(receiptSequences.edgeNodeId, input.edgeNodeId),
          eq(receiptSequences.edgeInstanceId, input.edgeInstanceId),
          sql`${receiptSequences.deviceId} <> ${receiptSequences.outletId}`,
          sql`${receiptSequences.lastNumber} > 0`,
        ),
      )
      .orderBy(asc(receiptSequences.prefix)),
  );
  let reported = 0;
  const errors: unknown[] = [];
  for (const candidate of candidates)
    try {
      reported += await reportRun(candidate.id);
    } catch (error) {
      // One run failing (a receipt the contract cannot encode, a lock timeout)
      // must not stop the other runs of the pass.
      errors.push(error);
    }
  return errors.length > 0 ? { reported, errors } : { reported };

  async function reportRun(sequenceId: string): Promise<number> {
    return withTenant(db, context, async (tx) => {
      const [sequence] = await tx
        .select()
        .from(receiptSequences)
        .where(
          and(
            eq(receiptSequences.tenantId, tenantId),
            eq(receiptSequences.id, sequenceId),
            eq(receiptSequences.edgeNodeId, input.edgeNodeId),
            eq(receiptSequences.edgeInstanceId, input.edgeInstanceId),
          ),
        )
        .for("update");
      if (!sequence || sequence.lastNumber <= 0) return 0;
      const { deviceId, prefix } = sequence;
      const keyOf = (kind: string) =>
        `${receiptRunReportedEvent.name}:${deviceId}:${prefix}:${kind}`;
      const [head] = await tx
        .select({
          last: sql<number>`coalesce(max(${domainEventOutbox.sequence}), 0)`,
          reported: sql<number>`coalesce(max((${domainEventOutbox.event} -> 'payload' -> 'sequence' ->> 'lastNumber')::int) FILTER (WHERE ${domainEventOutbox.event} ->> 'idempotencyKey' LIKE ${keyOf("c:%")}), 0)`,
        })
        .from(domainEventOutbox)
        .where(
          and(
            eq(domainEventOutbox.tenantId, tenantId),
            eq(domainEventOutbox.destination, EVENT_DESTINATION),
            eq(domainEventOutbox.aggregateType, RECEIPT_RUN_AGGREGATE),
            eq(domainEventOutbox.aggregateId, deviceId),
          ),
        );
      let aggregateSequence = Number(head?.last ?? 0);
      let highWater = Number(head?.reported ?? 0);
      let appended = 0;
      const append = async (
        kind: string,
        lastNumber: number,
        rows: ReceiptRowOf[],
      ) => {
        const now = new Date();
        aggregateSequence += 1;
        const event = receiptRunReportedEvent.envelopeSchema.parse({
          id: createUlid(now.getTime()),
          tenantId,
          outletId,
          name: receiptRunReportedEvent.name,
          version: receiptRunReportedEvent.version,
          aggregateType: RECEIPT_RUN_AGGREGATE,
          aggregateId: deviceId,
          sequence: aggregateSequence,
          occurredAt: now.toISOString(),
          actor: { type: "system" },
          deviceId: null,
          idempotencyKey: keyOf(kind),
          payloadSchemaRef: receiptRunReportedEvent.payloadSchemaRef,
          payload: {
            sequence: { tenantId, outletId, deviceId, prefix, lastNumber },
            receipts: rows.map(receiptEntry),
          },
        });
        await appendOutbox(tx, context, {
          id: createUlid(now.getTime()),
          event,
          destination: EVENT_DESTINATION,
          direction: null,
          peerId: null,
        });
        appended += 1;
      };
      for (let chunk = 0; chunk < maxChunks; chunk += 1) {
        const rows = await tx
          .select()
          .from(posReceipts)
          .where(
            and(
              eq(posReceipts.tenantId, tenantId),
              eq(posReceipts.sequenceId, sequence.id),
              gt(posReceipts.sequenceNumber, highWater),
            ),
          )
          .orderBy(asc(posReceipts.sequenceNumber))
          .limit(chunkSize);
        if (rows.length === 0) break;
        // End the chunk before the first receipt the cloud cannot take yet.
        const uuids = rows.map((row) => ulidToUuid(row.orderId));
        const paid = await acknowledgedOrders(
          tx,
          tenantId,
          uuids,
          "order.paid",
        );
        const voidedAck = await acknowledgedOrders(
          tx,
          tenantId,
          rows
            .filter((row) => row.status === "voided")
            .map((row) => ulidToUuid(row.orderId)),
          "order.voided",
        );
        const ready: ReceiptRowOf[] = [];
        for (const row of rows) {
          const orderUuid = ulidToUuid(row.orderId);
          if (!paid.has(orderUuid)) break;
          if (row.status === "voided" && !voidedAck.has(orderUuid)) break;
          ready.push(row);
        }
        const last = ready.at(-1);
        if (!last) break;
        await append(`c:${last.sequenceNumber}`, last.sequenceNumber, ready);
        highWater = last.sequenceNumber;
        if (ready.length < rows.length) break;
      }
      // Receipts voided after they were reported: the unsent ones, found in
      // SQL (bounded by the limit), whose order.voided the cloud acknowledged.
      if (highWater > 0 && maxVoids > 0) {
        const found = await tx.execute(
          sql`SELECT r.id FROM pos_receipts r
              WHERE r.tenant_id = ${tenantId}::uuid AND r.sequence_id = ${sequence.id}::uuid
                AND r.status = 'voided' AND r.sequence_number <= ${highWater}
                AND NOT EXISTS (
                  SELECT 1 FROM domain_event_outbox e
                  WHERE e.tenant_id = r.tenant_id AND e.destination = ${EVENT_DESTINATION}
                    AND e.aggregate_type = ${RECEIPT_RUN_AGGREGATE} AND e.aggregate_id = r.device_id
                    AND e.event ->> 'idempotencyKey' = ${`${receiptRunReportedEvent.name}:${deviceId}:${prefix}:v:`} || r.sequence_number::text)
                AND EXISTS (
                  SELECT 1 FROM domain_event_outbox o
                  WHERE o.tenant_id = r.tenant_id AND o.destination = ${EVENT_DESTINATION}
                    AND o.aggregate_id = r.order_id AND o.event ->> 'name' = 'order.voided'
                    AND o.status = 'delivered'
                    AND NOT EXISTS (
                      SELECT 1 FROM edge_outbound_queue q
                      WHERE q.tenant_id = o.tenant_id AND q.direction = 'edge_to_cloud'
                        AND q.event_id = o.event_id AND q.status <> 'acked')
                    AND NOT EXISTS (
                      SELECT 1 FROM edge_link_dead_letters d
                      WHERE d.tenant_id = o.tenant_id AND d.direction = 'edge_to_cloud'
                        AND d.event_id = o.event_id))
              ORDER BY r.sequence_number LIMIT ${maxVoids}`,
        );
        const ids = (found.rows as { id: string }[]).map((row) => row.id);
        if (ids.length > 0) {
          const voided = await tx
            .select()
            .from(posReceipts)
            .where(
              and(
                eq(posReceipts.tenantId, tenantId),
                inArray(posReceipts.id, ids),
              ),
            )
            .orderBy(asc(posReceipts.sequenceNumber));
          for (const row of voided)
            await append(`v:${row.sequenceNumber}`, highWater, [row]);
        }
      }
      return appended;
    });
  }
}

/**
 * Edge runtime loop: reports on a timer, one pass at a time. `onReported`
 * wakes the sync link. A failed run is reported through `onError` and retried on
 * the next tick (keys and the high-water make a retry safe).
 */
export function startEdgeReceiptRunReporter(options: {
  context: ScopedTenantContext;
  outletId: string;
  edgeNodeId: string;
  edgeInstanceId: string;
  intervalMs: number;
  onReported?: (reported: number) => void;
  onError?: (error: unknown) => void;
}): () => void {
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    reportEdgeReceiptRuns(options.context, options)
      .then(({ reported, errors }) => {
        for (const error of errors ?? []) options.onError?.(error);
        if (reported > 0) options.onReported?.(reported);
      })
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(pass, options.intervalMs);
  timer.unref();
  // First pass soon after boot so a restart reports what was numbered offline.
  const first = setTimeout(pass, 0);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
