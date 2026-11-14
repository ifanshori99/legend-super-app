// legend-n2d3g (brief 861): a receipt run versus an oversized order event that
// the edge dead-lettered (legend-btx4d). The cloud never gets such an event, so
// the receipt of its order can never merge and held every later chunk of the
// same prefix; on the edge the reporter never released a receipt whose
// `order.paid` was dead-lettered. Target (docs/briefs/861-receipt-run-n2d3g.md):
//
//   1. Cloud: a receipt of an order whose `order.paid` or `order.placed` was
//      recorded as a `link_event_dead_lettered` conflict (the notice reached the
//      cloud) is SKIPPED with reason `link_dead_lettered` in edge_receipt_skips;
//      the other receipts of the run merge and later chunks of the prefix go
//      through.
//   2. Edge reporter: a receipt whose `order.paid` is dead-lettered is reported
//      once its notice (edge_link.dead_lettered in edge_outbound_queue) is
//      acked or pruned, and holds while the notice is not acked. A dead-lettered
//      `order.voided` always holds (fail closed).
//   3. Alarm: a receipt held for good by a dead-lettered event shows in the
//      result as `held` and alerts the outlet supervisors once per
//      (tenant, order, event), not on every pass. An ordinary delay does not.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/edge-receipt-run-deadletter-861.test.ts" heavy pnpm test
//
// Assumptions (the brief does not fix them):
//  - `held` is the number of receipts the reporter holds because of a
//    dead-lettered event it will never release (here: one receipt, one void),
//    and is absent or 0 when nothing is held that way. It is read through a
//    cast because the result type has no `held` yet.
//  - The brief's point 3 is ambiguous about a dead-lettered `order.paid` whose
//    notice is not acked yet (ordinary delay or alarm?). The tests assert the
//    alarm only for a dead-lettered `order.voided`, which is permanent in both
//    readings, and assert nothing on the alarm for the pending-notice paid case.
//  - The alarm is observed as new rows in notification_outbox / notifications
//    of the tenant for an outlet supervisor (the channel of the supervisor
//    alerts in edge-sync-conflicts.test.ts).
//  - Skipped number stays recorded: no pos_receipts row for the skipped order,
//    the sequence still advances past its number (as in n1fzg).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  uuidToUlid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  EDGE_LINK_AGGREGATE,
  EDGE_LINK_DEAD_LETTERED_EVENT,
  edgeLinkDeadLetteredEvent,
} from "@starter/shared/edge";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import {
  formatReceiptNumber,
  RECEIPT_RUN_AGGREGATE,
  RECEIPT_RUN_REPORTED_EVENT,
} from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import { registerEdgeLinkDeadLetterApplier } from "../edge/link-dead-letter-applier.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
import { registerReceiptRunEdgeApplier } from "../edge/receipt-run-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { reportEdgeReceiptRuns } from "../services/edge-receipt-run-reporter.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { setPosReceiptPort } from "../services/pos-order-ports.ts";
import {
  createPosReceiptPort,
  provisionReceiptSequence,
} from "../services/pos-receipt.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const OUTLET_NAME = "Cafe Legend Senopati";
const OUTLET_ADDRESS = "Jl. Kopi Legenda No. 12, Jakarta Selatan";
const SNAPSHOT = {
  outletName: OUTLET_NAME,
  outletAddress: OUTLET_ADDRESS,
  legalName: null,
  npwpLast4: null,
};
const EDGE_INSTANCE = randomUUID();
const actor = randomUUID();
const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };

// ---- Fixtures -----------------------------------------------------------------

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function scopeOf(tenantId: string, outletIds?: string[]): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    outletIds
      ? {
          kind: "outlets",
          outletIds: outletIds.map((id) => outletIdSchema.parse(id)),
        }
      : { kind: "tenant" },
  );
}

const nodes = new Map<string, Promise<AuthenticatedEdgeNode>>();
function edgeNodeFor(outletId: string): Promise<AuthenticatedEdgeNode> {
  let node = nodes.get(outletId);
  if (!node) {
    node = (async () => {
      const registered = await registerEdgeNode(
        scopeOf(tenant.tenantId, [outletId]),
        actor,
        { outletId, role: "primary", label: "Utama Struk" },
      );
      const authenticated = await authenticateEdgeCredential(
        registered.credential,
      );
      if (!authenticated) throw new Error("Edge node did not authenticate");
      return authenticated;
    })();
    nodes.set(outletId, node);
  }
  return node;
}

async function freshOutlet(): Promise<string> {
  const outletId = randomUUID();
  const priceListId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Asia/Jakarta', $8, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `R${outletId.slice(0, 8)}`.toUpperCase(),
      OUTLET_NAME,
      OUTLET_ADDRESS,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceListId, tenant.tenantId, outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, priceListId, ids.kopi, KOPI_IDR],
    );
  });
  return outletId;
}

async function draftOrder(outletId: string): Promise<string> {
  const created = await cashier.client
    .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/orders`)
    .set(headers)
    .set(originHeader)
    .send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

/** Merge-ready orders: owned by `deviceId`, completed, no receipt yet. */
async function deviceOrders(
  outletId: string,
  deviceId: string,
  count: number,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) out.push(await draftOrder(outletId));
  await asOwnerTenant(tenant.tenantId, async (client) => {
    for (const orderId of out) {
      await client.query(
        `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
        [tenant.tenantId, ulidToUuid(orderId), deviceId],
      );
      await client.query(
        `UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2::uuid`,
        [tenant.tenantId, ulidToUuid(orderId)],
      );
    }
  });
  return out;
}

function provision(outletId: string, deviceId: string, prefix: string) {
  const context = scopeOf(tenant.tenantId);
  return withTenant(db, context, (tx) =>
    provisionReceiptSequence(
      tx as Parameters<typeof provisionReceiptSequence>[0],
      context,
      { outletId, deviceId, prefix },
    ),
  );
}

async function scenario(count: number) {
  const outletId = await freshOutlet();
  const device = randomUUID();
  const orders = await deviceOrders(outletId, device, count);
  await provision(outletId, device, "OFF1");
  const node = await edgeNodeFor(outletId);
  return { outletId, device, orders, node };
}

type ReceiptRow = { number: string; order_id: string };

async function receiptRows(outletId: string): Promise<ReceiptRow[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT number, order_id::text AS order_id FROM pos_receipts
       WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY number`,
      [tenant.tenantId, outletId],
    );
    return result.rows as ReceiptRow[];
  });
}

async function lastNumber(outletId: string): Promise<number | undefined> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT last_number FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenant.tenantId, outletId],
    );
    return (result.rows[0] as { last_number: number } | undefined)?.last_number;
  });
}

async function cloudOrderExists(orderUlid: string): Promise<boolean> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT 1 FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderUlid)],
    );
    return result.rowCount === 1;
  });
}

type SkipRow = { receipt_number: string; reason: string };

async function skipRows(
  outletId: string,
  orderUlid: string,
): Promise<SkipRow[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT receipt_number, reason FROM edge_receipt_skips
       WHERE tenant_id = $1 AND outlet_id = $2 AND order_id = $3::uuid`,
      [tenant.tenantId, outletId, ulidToUuid(orderUlid)],
    );
    return result.rows as SkipRow[];
  });
}

async function skipRowCount(outletId: string): Promise<number> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM edge_receipt_skips WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenant.tenantId, outletId],
    );
    return (result.rows[0] as { n: number }).n;
  });
}

// ---- Cloud side: event construction -------------------------------------------

let clock = Date.parse("2026-11-15T08:00:00.000Z");
const aggregateSequences = new Map<string, number>();

function runEvent(input: {
  outletId: string;
  deviceId: string;
  prefix: string;
  lastNumber: number;
  receipts: [string, number][];
}): EventEnvelope {
  clock += 1_000;
  const at = new Date(clock).toISOString();
  const entries = input.receipts.map(([orderId, ordinal]) => ({
    receipt: {
      id: randomUUID(),
      tenantId: tenant.tenantId,
      outletId: input.outletId,
      orderId,
      deviceId: input.deviceId,
      number: formatReceiptNumber(input.prefix, ordinal),
      sequenceNumber: ordinal,
      status: "issued",
      issuedAt: at,
      voidedAt: null,
      voidReason: null,
      voidedBy: null,
      reprintCount: 0,
    },
    outletSnapshot: SNAPSHOT,
  }));
  const sequence = (aggregateSequences.get(input.deviceId) ?? 0) + 1;
  aggregateSequences.set(input.deviceId, sequence);
  return eventEnvelopeSchema.parse({
    id: createUlid(clock),
    tenantId: tenant.tenantId,
    outletId: input.outletId,
    name: RECEIPT_RUN_REPORTED_EVENT,
    version: 1,
    aggregateType: RECEIPT_RUN_AGGREGATE,
    aggregateId: input.deviceId,
    sequence,
    occurredAt: at,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${RECEIPT_RUN_REPORTED_EVENT}:${input.deviceId}:${sequence}`,
    payloadSchemaRef: `${RECEIPT_RUN_REPORTED_EVENT}.v1`,
    payload: {
      sequence: {
        tenantId: tenant.tenantId,
        outletId: input.outletId,
        deviceId: input.deviceId,
        prefix: input.prefix,
        lastNumber: input.lastNumber,
      },
      receipts: entries,
    },
  });
}

function applyEvent(event: EventEnvelope, node: AuthenticatedEdgeNode) {
  const meta: EdgeApplyMeta = {
    edgeNodeId: node.scope.edgeNodeId,
    direction: "edge_to_cloud",
    kind: "transaction_event",
    context: node.context,
  };
  return withTenant(db, node.context, (tx) =>
    edgeEventApplier("edge_to_cloud").apply(tx, event, meta),
  );
}

/**
 * The `edge_link.dead_lettered` notice for the order event `eventName` of
 * `orderUlid`, delivered through the link exactly as the edge sends it (it
 * takes the dead event's slot). The cloud records the conflict
 * `link_event_dead_lettered` for it.
 */
async function deliverDeadLetterNotice(
  node: AuthenticatedEdgeNode,
  outletId: string,
  orderUlid: string,
  eventName: "order.paid" | "order.placed",
): Promise<void> {
  const link = createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
  const from = await link.lastReceivedInbound();
  clock += 1_000;
  const deadEventId = createUlid(clock);
  clock += 1_000;
  const notice = edgeLinkDeadLetteredEvent.envelopeSchema.parse({
    id: createUlid(clock),
    tenantId: tenant.tenantId,
    outletId,
    name: EDGE_LINK_DEAD_LETTERED_EVENT,
    version: 1,
    aggregateType: EDGE_LINK_AGGREGATE,
    aggregateId: deadEventId,
    sequence: 1,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${EDGE_LINK_DEAD_LETTERED_EVENT}:${deadEventId}`,
    payloadSchemaRef: `${EDGE_LINK_DEAD_LETTERED_EVENT}.v1`,
    payload: {
      eventId: deadEventId,
      eventName,
      aggregateType: "order",
      aggregateId: orderUlid,
      aggregateSequence: eventName === "order.placed" ? 1 : 2,
      linkSeq: from + 1,
      bytes: 5 * 1024 * 1024,
      reason: "frame_too_large",
    },
  }) as EventEnvelope;
  await link.applyInbound({
    fromSeq: from,
    toSeq: from + 1,
    events: [{ linkSeq: from + 1, event: notice }],
  });
}

async function linkDeadLetterConflicts(orderUlid: string): Promise<number> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM edge_sync_conflicts
        WHERE tenant_id = $1 AND reason = 'link_event_dead_lettered' AND aggregate_id = $2`,
      [tenant.tenantId, orderUlid],
    );
    return (result.rows[0] as { n: number }).n;
  });
}

// ---- Edge side: reporter fixtures ---------------------------------------------

type Delivery = "acked" | "queued";
type OrderEventName = "order.paid" | "order.voided";
type NoticeState = "acked" | "pending" | "pruned";

async function putOrderEvent(
  run: { outletId: string; node: AuthenticatedEdgeNode },
  orderId: string,
  name: OrderEventName,
  delivery: Delivery,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const eventId = ulidToUuid(createUlid());
    const aggregateId = ulidToUuid(orderId);
    const aggregateSequence = name === "order.paid" ? 1 : 2;
    const stored = JSON.stringify({
      name,
      tenantId: tenant.tenantId,
      outletId: run.outletId,
      aggregateType: "order",
      sequence: aggregateSequence,
    });
    await client.query(
      `INSERT INTO domain_event_outbox
         (tenant_id, id, outlet_id, event_id, aggregate_type, aggregate_id, sequence, event, destination, status, delivered_at)
       VALUES ($1, $2, $3, $4, 'order', $5, $6, $7::jsonb, 'cloud-sync', 'delivered', now())`,
      [
        tenant.tenantId,
        randomUUID(),
        run.outletId,
        eventId,
        aggregateId,
        aggregateSequence,
        stored,
      ],
    );
    const seq = await client.query(
      `SELECT coalesce(max(link_seq), 0) + 1 AS next FROM edge_outbound_queue
        WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'`,
      [tenant.tenantId, run.node.scope.edgeNodeId],
    );
    await client.query(
      `INSERT INTO edge_outbound_queue
         (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id, aggregate_type, aggregate_id,
          aggregate_sequence, kind, event, status, acked_at)
       VALUES ($1, $2, $3, 'edge_to_cloud', $4, $5, 'order', $6, $7, 'transaction_event', $8::jsonb, $9::varchar,
               CASE WHEN $9::text = 'acked' THEN now() END)`,
      [
        tenant.tenantId,
        run.outletId,
        run.node.scope.edgeNodeId,
        seq.rows[0].next,
        eventId,
        aggregateId,
        aggregateSequence,
        stored,
        delivery === "acked" ? "acked" : "pending",
      ],
    );
  });
}

/**
 * The queued order event was oversized (legend-btx4d). The edge's own link
 * store dead-letters it, exactly as the link peer does: the event moves to
 * edge_link_dead_letters and a notice (`edge_link` aggregate, aggregate id =
 * the dead event id) takes its slot in edge_outbound_queue. `notice` is the
 * state the notice is left in: `pending` (not acked), `acked`, or `pruned`
 * (acked and already cleaned from the queue).
 */
async function deadLetterOrderEvent(
  run: { outletId: string; node: AuthenticatedEdgeNode },
  orderId: string,
  name: OrderEventName,
  notice: NoticeState,
): Promise<void> {
  const row = await asOwnerTenant(tenant.tenantId, async (client) => {
    const found = await client.query(
      `SELECT event_id::text AS event_id, link_seq, aggregate_sequence FROM edge_outbound_queue
        WHERE tenant_id = $1 AND status = 'pending' AND event_id IN (
          SELECT event_id FROM domain_event_outbox
           WHERE tenant_id = $1 AND aggregate_id = $2::uuid AND event ->> 'name' = $3)`,
      [tenant.tenantId, ulidToUuid(orderId), name],
    );
    expect(found.rows).toHaveLength(1);
    return found.rows[0] as {
      event_id: string;
      link_seq: number;
      aggregate_sequence: string | number;
    };
  });
  const dead = eventEnvelopeSchema.parse({
    id: uuidToUlid(row.event_id),
    tenantId: tenant.tenantId,
    outletId: run.outletId,
    name,
    version: 1,
    aggregateType: "order",
    aggregateId: orderId,
    sequence: Number(row.aggregate_sequence),
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `dl861-${row.event_id}`,
    payloadSchemaRef: `${name}.v1`,
    payload: {},
  });
  const store = createDbLinkStore({
    database: db,
    context: run.node.context,
    node: run.node.scope,
    outboundDirection: "edge_to_cloud",
    classify: () => "transaction_event" as const,
  }) as ReturnType<typeof createDbLinkStore> & {
    deadLetterOutbound: (entry: {
      linkSeq: number;
      event: EventEnvelope;
      bytes: number;
      reason: "frame_too_large";
    }) => Promise<void>;
  };
  await store.deadLetterOutbound({
    linkSeq: Number(row.link_seq),
    event: dead,
    bytes: 5 * 1024 * 1024,
    reason: "frame_too_large",
  });
  if (notice === "pending") return;
  await ackNotices(run.outletId);
  if (notice === "acked") return;
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `DELETE FROM edge_outbound_queue WHERE tenant_id = $1 AND outlet_id = $2 AND aggregate_type = $3`,
      [tenant.tenantId, run.outletId, EDGE_LINK_AGGREGATE],
    );
  });
}

/** The cloud acknowledges the notices of this outlet (link ack). */
async function ackNotices(outletId: string): Promise<void> {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE edge_outbound_queue SET status = 'acked', acked_at = now()
        WHERE tenant_id = $1 AND outlet_id = $2 AND aggregate_type = $3`,
      [tenant.tenantId, outletId, EDGE_LINK_AGGREGATE],
    );
  });
}

/** An edge database's device run: `orders` numbered locally 1.. under OFF1. */
async function bindEdgeRun(
  run: { outletId: string; device: string; node: AuthenticatedEdgeNode },
  orders: string[],
  delivery: Delivery[],
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const existing = await client.query(
      "SELECT id FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3 AND prefix = 'OFF1'",
      [tenant.tenantId, run.outletId, run.device],
    );
    const sequenceId = existing.rows[0].id as string;
    await client.query(
      `UPDATE receipt_sequences SET last_number = $2, edge_node_id = $3, edge_instance_id = $4 WHERE id = $1`,
      [sequenceId, orders.length, run.node.scope.edgeNodeId, EDGE_INSTANCE],
    );
    for (const [index, orderId] of orders.entries())
      await client.query(
        `INSERT INTO pos_receipts
           (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
        [
          tenant.tenantId,
          run.outletId,
          ulidToUuid(orderId),
          sequenceId,
          run.device,
          formatReceiptNumber("OFF1", index + 1),
          index + 1,
          JSON.stringify(SNAPSHOT),
        ],
      );
  });
  for (const [index, orderId] of orders.entries())
    await putOrderEvent(run, orderId, "order.paid", delivery[index] ?? "acked");
}

async function edgeRun(count: number, delivery: Delivery[] = []) {
  const run = await scenario(count);
  await bindEdgeRun(run, run.orders, delivery);
  return run;
}

type EdgeRun = Awaited<ReturnType<typeof edgeRun>>;

type ReportResult = Awaited<ReturnType<typeof reportEdgeReceiptRuns>>;

function report(run: EdgeRun): Promise<ReportResult> {
  return reportEdgeReceiptRuns(scopeOf(tenant.tenantId, [run.outletId]), {
    outletId: run.outletId,
    edgeNodeId: run.node.scope.edgeNodeId,
    edgeInstanceId: EDGE_INSTANCE,
  });
}

/** `held` is not in the result type yet (see assumptions). */
function heldOf(result: ReportResult): number {
  return (result as { held?: number }).held ?? 0;
}

async function reportedShapes(deviceId: string) {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = 'cloud-sync' AND aggregate_type = $2 AND aggregate_id = $3::uuid
        ORDER BY sequence`,
      [tenant.tenantId, RECEIPT_RUN_AGGREGATE, deviceId],
    );
    return result.rows.map((row: { event: unknown }) => {
      const event = eventEnvelopeSchema.parse(row.event);
      const payload = event.payload as {
        sequence: { prefix: string; lastNumber: number };
        receipts: { receipt: { sequenceNumber: number } }[];
      };
      return [
        payload.sequence.prefix,
        payload.sequence.lastNumber,
        payload.receipts.map((entry) => String(entry.receipt.sequenceNumber)),
      ];
    });
  });
}

async function voidEdgeReceipt(
  run: EdgeRun,
  ordinal: number,
  delivery: Delivery,
): Promise<string> {
  const orderId = await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const result = await client.query(
      `UPDATE pos_receipts SET status = 'voided', voided_at = now(), void_reason = 'wrong_order', voided_by = $4
        WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3 AND number = $5
        RETURNING order_id`,
      [
        tenant.tenantId,
        run.outletId,
        run.device,
        cashier.userId,
        formatReceiptNumber("OFF1", ordinal),
      ],
    );
    return uuidToUlid(result.rows[0].order_id as string);
  });
  await putOrderEvent(run, orderId, "order.voided", delivery);
  return orderId;
}

/** A supervisor of the outlet: the person the alarm is for. */
let supervisorRoleId: string | null = null;
async function addSupervisor(outletId: string): Promise<string> {
  if (!supervisorRoleId) {
    supervisorRoleId = await copySupervisorRole();
  }
  const roleId = supervisorRoleId;
  const client = agent(app);
  await signUp(client, `Supervisor ${outletId.slice(0, 6)}`);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId, outletId],
  );
  return userId;
}

async function copySupervisorRole(): Promise<string> {
  const roleId = randomUUID();
  const copied = await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     SELECT $1, $2, name, is_template, template_key, permissions, mfa_required, allowed_scope_types
       FROM roles WHERE tenant_id = $3 AND template_key = 'supervisor'`,
    [roleId, tenant.tenantId, fixtures.tenant.id],
  );
  if (copied.rowCount !== 1) throw new Error("No supervisor role template");
  return roleId;
}

/** Alerts raised so far for the tenant (outbox rows plus in-app rows). */
async function alertCount(): Promise<number> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const outbox = await client.query(
      "SELECT count(*)::int AS n FROM notification_outbox WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    const inApp = await client.query(
      "SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    return (
      (outbox.rows[0] as { n: number }).n + (inApp.rows[0] as { n: number }).n
    );
  });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  setPosReceiptPort(createPosReceiptPort());
  tenant = await createIsolatedTenant(`rdl-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `UPDATE tenants t SET plan = s.plan, deployment_mode = s.deployment_mode, feature_flags = s.feature_flags
       FROM tenants s WHERE s.id = $2 AND t.id = $1`,
    [tenant.tenantId, seededTenantId],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Dead Letter Kasir', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify(["order.view", "pos.sale.create"]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Dead Letter Kasir");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  cashier = { client, userId };
  await asOwnerTenant(tenant.tenantId, async (pg) => {
    await pg.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Dead Letter Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await pg.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await pg.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
    await pg.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-RDL', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerReceiptRunEdgeApplier();
  registerEdgeLinkDeadLetterApplier();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setPosReceiptPort(null);
  setAuditWriter(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- 1. Cloud: skip a receipt of a dead-lettered order -------------------------

describe("legend-n2d3g cloud skips receipts of orders whose event was dead-lettered", () => {
  it("legend-n2d3g a dead-lettered order.paid: the receipt is skipped as link_dead_lettered, the others merge, the next chunk of the prefix goes through", async () => {
    const { outletId, orders, node, device } = await scenario(3);
    const [o1, o3, o4] = orders;
    const dead = createUlid(); // the cloud never got this order
    await deliverDeadLetterNotice(node, outletId, dead, "order.paid");
    expect(await linkDeadLetterConflicts(dead)).toBe(1);

    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 3,
        receipts: [
          [o1!, 1],
          [dead, 2],
          [o3!, 3],
        ],
      }),
      node,
    );

    const merged = await receiptRows(outletId);
    expect(merged.map((row) => row.order_id).sort()).toEqual(
      [ulidToUuid(o1!), ulidToUuid(o3!)].sort(),
    );
    expect(await lastNumber(outletId)).toBe(3);
    const skips = await skipRows(outletId, dead);
    expect(skips).toHaveLength(1);
    expect(skips[0]!.receipt_number).toBe("OFF1-000002");
    expect(skips[0]!.reason).toBe("link_dead_lettered");

    // The next chunk of the same prefix is not held by the hole.
    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 4,
        receipts: [[o4!, 4]],
      }),
      node,
    );
    expect(
      (await receiptRows(outletId)).map((row) => row.order_id).sort(),
    ).toEqual([ulidToUuid(o1!), ulidToUuid(o3!), ulidToUuid(o4!)].sort());
    expect(await lastNumber(outletId)).toBe(4);

    // No revenue for the skipped order.
    expect(await cloudOrderExists(dead)).toBe(false);
  });

  it("legend-n2d3g a dead-lettered order.placed is skipped the same way", async () => {
    const { outletId, orders, node, device } = await scenario(2);
    const [o1, o3] = orders;
    const dead = createUlid();
    await deliverDeadLetterNotice(node, outletId, dead, "order.placed");

    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 3,
        receipts: [
          [o1!, 1],
          [dead, 2],
          [o3!, 3],
        ],
      }),
      node,
    );

    expect(await receiptRows(outletId)).toHaveLength(2);
    expect(await lastNumber(outletId)).toBe(3);
    const skips = await skipRows(outletId, dead);
    expect(skips.map((s) => s.reason)).toEqual(["link_dead_lettered"]);
    expect(await cloudOrderExists(dead)).toBe(false);
  });

  it("legend-n2d3g the skip is recorded once: a redelivery and a re-sent run add no second row", async () => {
    const { outletId, orders, node, device } = await scenario(2);
    const [o1, o3] = orders;
    const dead = createUlid();
    await deliverDeadLetterNotice(node, outletId, dead, "order.paid");
    const run = {
      outletId,
      deviceId: device,
      prefix: "OFF1",
      lastNumber: 3,
      receipts: [
        [o1!, 1],
        [dead, 2],
        [o3!, 3],
      ] as [string, number][],
    };
    const first = runEvent(run);
    await applyEvent(first, node);
    await applyEvent(first, node);
    await applyEvent(runEvent(run), node);

    expect(await skipRows(outletId, dead)).toHaveLength(1);
    expect(await skipRowCount(outletId)).toBe(1);
    expect(await receiptRows(outletId)).toHaveLength(2);
    expect(await lastNumber(outletId)).toBe(3);
  });

  it("legend-n2d3g no notice, no skip: a receipt of an order the cloud never got stays refused and nothing is recorded", async () => {
    const { outletId, orders, node, device } = await scenario(1);
    const [o1] = orders;
    const unknown = createUlid();
    // A notice for ANOTHER order does not release this one.
    await deliverDeadLetterNotice(node, outletId, createUlid(), "order.paid");

    await expect(
      applyEvent(
        runEvent({
          outletId,
          deviceId: device,
          prefix: "OFF1",
          lastNumber: 2,
          receipts: [
            [o1!, 1],
            [unknown, 2],
          ],
        }),
        node,
      ),
    ).rejects.toBeDefined();
    expect(await skipRowCount(outletId)).toBe(0);
    expect(await receiptRows(outletId)).toHaveLength(0);
  });
});

// ---- 2. Edge reporter: release a receipt whose paid event was dead-lettered ----

describe("legend-n2d3g edge reporter and a dead-lettered order.paid", () => {
  it("legend-n2d3g the notice was acked: the receipt is reported with the run, and the later receipts too", async () => {
    const run = await edgeRun(3, ["acked", "queued", "acked"]);
    await deadLetterOrderEvent(run, run.orders[1]!, "order.paid", "acked");
    expect(await report(run)).toMatchObject({ reported: 1 });
    expect(await reportedShapes(run.device)).toEqual([
      ["OFF1", 3, ["1", "2", "3"]],
    ]);
    expect(await report(run)).toMatchObject({ reported: 0 });
  });

  it("legend-n2d3g the notice was acked and already pruned from the queue: the receipt is reported", async () => {
    const run = await edgeRun(3, ["acked", "queued", "acked"]);
    await deadLetterOrderEvent(run, run.orders[1]!, "order.paid", "pruned");
    expect(await report(run)).toMatchObject({ reported: 1 });
    expect(await reportedShapes(run.device)).toEqual([
      ["OFF1", 3, ["1", "2", "3"]],
    ]);
  });

  it("legend-n2d3g the notice is not acked yet: the receipt and the run behind it wait, and go once the notice is acked", async () => {
    const run = await edgeRun(3, ["acked", "queued", "acked"]);
    await deadLetterOrderEvent(run, run.orders[1]!, "order.paid", "pending");
    expect(await report(run)).toMatchObject({ reported: 1 });
    expect(await reportedShapes(run.device)).toEqual([["OFF1", 1, ["1"]]]);
    expect(await report(run)).toMatchObject({ reported: 0 });

    await ackNotices(run.outletId);
    expect(await report(run)).toMatchObject({ reported: 1 });
    expect(await reportedShapes(run.device)).toEqual([
      ["OFF1", 1, ["1"]],
      ["OFF1", 3, ["2", "3"]],
    ]);
  });

  it("legend-n2d3g a dead-lettered order.voided always holds the void, even when its notice is acked", async () => {
    const run = await edgeRun(2);
    await report(run);
    const orderId = await voidEdgeReceipt(run, 1, "queued");
    await deadLetterOrderEvent(run, orderId, "order.voided", "acked");
    expect(await report(run)).toMatchObject({ reported: 0 });
    expect(await reportedShapes(run.device)).toEqual([["OFF1", 2, ["1", "2"]]]);
  });
});

// ---- 3. Alarm: a receipt held for good is not silent ---------------------------

describe("legend-n2d3g held receipts raise an alarm once", () => {
  it("legend-n2d3g a receipt held by a dead-lettered order.voided shows as held and alerts the supervisor once, not on every pass", async () => {
    const run = await edgeRun(2);
    await addSupervisor(run.outletId);
    await report(run);
    const orderId = await voidEdgeReceipt(run, 1, "queued");
    await deadLetterOrderEvent(run, orderId, "order.voided", "acked");

    const before = await alertCount();
    const first = await report(run);
    expect(heldOf(first)).toBe(1);
    const afterFirst = await alertCount();
    expect(afterFirst, "the supervisor is alerted").toBeGreaterThan(before);

    // Later passes still see the receipt held, but do not alert again.
    const second = await report(run);
    expect(heldOf(second)).toBe(1);
    const third = await report(run);
    expect(heldOf(third)).toBe(1);
    expect(await alertCount()).toBe(afterFirst);
  });

  it("legend-n2d3g a not yet reported receipt voided by a dead-lettered order.voided is held and alerts once", async () => {
    const run = await edgeRun(2);
    await addSupervisor(run.outletId);
    const orderId = await voidEdgeReceipt(run, 2, "queued");
    await deadLetterOrderEvent(run, orderId, "order.voided", "acked");

    const before = await alertCount();
    const first = await report(run);
    expect(heldOf(first)).toBeGreaterThanOrEqual(1);
    const afterFirst = await alertCount();
    expect(afterFirst, "the supervisor is alerted").toBeGreaterThan(before);

    await report(run);
    expect(await alertCount()).toBe(afterFirst);
  });

  it("legend-n2d3g an ordinary delay (event queued, not dead-lettered) is neither held nor alarmed", async () => {
    const run = await edgeRun(2, ["acked", "queued"]);
    await addSupervisor(run.outletId);
    const before = await alertCount();
    const result = await report(run);
    expect(result).toMatchObject({ reported: 1 });
    expect(heldOf(result)).toBe(0);
    expect(await alertCount()).toBe(before);
  });

  it("legend-n2d3g a dead-lettered order.paid whose notice is acked is released, so nothing is held or alarmed", async () => {
    const run = await edgeRun(2, ["acked", "queued"]);
    await addSupervisor(run.outletId);
    await deadLetterOrderEvent(run, run.orders[1]!, "order.paid", "acked");
    const before = await alertCount();
    const result = await report(run);
    expect(result).toMatchObject({ reported: 1 });
    expect(heldOf(result)).toBe(0);
    expect(await alertCount()).toBe(before);
  });
});
