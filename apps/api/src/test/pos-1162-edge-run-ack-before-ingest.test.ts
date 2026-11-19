// Card A (beads legend-gdjpu), second opinion 1111 finding P2: a void whose
// transport was ACKed before the cloud ingest succeeded must not lose the
// receipt proof of the run in the cloud.
//
// Scenario (production reporter, real outbox, real link receive path, real
// redrive sweep; this test never builds a replacement run event):
//   1. The cloud ingested the offline sale (`order.paid`) of two orders.
//   2. The cloud receives `order.voided` of order 2 while its order lock is
//      held longer than the lock timeout: the ingest is refused as a transient
//      `void_refused:lock_failed`, the transport still ACKs it.
//   3. The edge reporter (edge-receipt-run-reporter) sees order.voided delivered
//      and acked, so it sends the run chunk that carries the voided receipt.
//      Every event it wrote to the outbox reaches the cloud over the link
//      BEFORE the redrive sweep runs: the cloud has no void yet.
//   4. The lock is released; the redrive sweep ingests the void.
//   5. Sweep and reporter run again (a few rounds). No new run event is made by
//      the test.
//
// Expected (spec of the card): in the end every receipt of the run is in the
// cloud with its number kept (OFF1-000001 issued, OFF1-000002 voided), the
// sequence is at 2 with no gap, exactly one void row and at most one reversing
// journal (as many reversals as sale journals), without any manual run event.
//
// Single-database stand-in: the test database holds both the edge and the
// cloud side. The edge's local receipts are therefore installed for the
// reporter pass and removed again (installEdgeReceipts / removeEdgeReceipts)
// before the events reach the cloud, the same trick resetToCloudState plays in
// edge-receipt-run-applier.test.ts. The edge outbox/queue rows of the order
// events are written the way that file does (putOrderEvent).
//
// Run:
//   LEGEND_TEST_FILES="src/test/pos-1162-edge-run-ack-before-ingest.test.ts" pnpm test
//
// Assumptions (the spec is silent on how the recovery is built; also reported):
//  - The fix may live in the cloud sweep (re-apply the refused run) or in the
//    reporter (resend after the void is recovered). The driver therefore runs
//    reporter + link delivery + sweep for several rounds and asserts only the
//    final cloud state, not which side recovered.
//  - A lock held on the order's ingest advisory lock under a short
//    `lock_timeout` is the transient refusal (same induction as
//    edge-order-redrive.test.ts); the issue's loyalty-lock variant gives the
//    same `void_refused:lock_failed` ledger reason.

import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createUlid,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import {
  RECEIPT_RUN_AGGREGATE,
  RECEIPT_RUN_REPORTED_EVENT,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  applyEdgeDeferredEvent,
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { registerOrderEdgeApplier } from "../edge/order-edge-applier.ts";
import { ingestEdgeOrderVoided } from "../edge/order-ingest.ts";
import type { EdgeApplyMeta } from "../edge/ports.ts";
import { registerReceiptRunEdgeApplier } from "../edge/receipt-run-applier.ts";
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import { reportEdgeReceiptRuns } from "../services/edge-receipt-run-reporter.ts";
import {
  provisionReceiptSequence,
  receiptGapsForOutlet,
} from "../services/pos-receipt.service.ts";
import { redriveEdgeOrderRefusalsForTenant } from "../worker/edge-order-redrive.job.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  seededTenantId,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const OUTLET_NAME = "Cafe Legend Senopati";
const OUTLET_ADDRESS = "Jl. Kopi Legenda No. 12, Jakarta Selatan";
const SNAPSHOT = {
  outletName: OUTLET_NAME,
  outletAddress: OUTLET_ADDRESS,
  legalName: null,
  npwpLast4: null,
};
const BUSINESS_DATE = "2034-01-02";
const PAID_AT = "2034-01-02T03:04:05.000Z";
const VOIDED_AT = "2034-01-02T04:00:00.000Z";
const SALE_TOTAL_IDR = 77_000;
const EDGE_INSTANCE = randomUUID();

const actor = randomUUID();
const cashierId = randomUUID();
const supervisorId = randomUUID();
const categoryId = randomUUID();
const menuItemId = randomUUID();
const taxRuleId = randomUUID();

let tenant: IsolatedTenant;

// ---- Database helpers ------------------------------------------------------------

async function asOwnerTenant<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
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

async function rows<T extends object>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asOwnerTenant(async (client) => {
    const result = await client.query(text, params);
    return result.rows as T[];
  });
}

function scopeOf(outletIds?: string[]): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
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

const jobContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "job",
    }),
    { kind: "tenant" },
  );

async function freshOutlet(): Promise<string> {
  const outletId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Asia/Jakarta', $8, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `G${outletId.slice(0, 8)}`.toUpperCase(),
      OUTLET_NAME,
      OUTLET_ADDRESS,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  return outletId;
}

type ReceiptRow = {
  number: string;
  sequence_number: number;
  status: string;
  void_reason: string | null;
  voided_by: string | null;
};

const receiptRows = (outletId: string) =>
  rows<ReceiptRow>(
    `SELECT number, sequence_number, status, void_reason, voided_by
       FROM pos_receipts WHERE tenant_id = $1 AND outlet_id = $2
      ORDER BY sequence_number`,
    [tenant.tenantId, outletId],
  );

const lastNumberOf = (outletId: string) =>
  rows<{ last_number: number }>(
    `SELECT last_number FROM receipt_sequences
      WHERE tenant_id = $1 AND outlet_id = $2 AND prefix = 'OFF1'`,
    [tenant.tenantId, outletId],
  ).then((r) => r[0]!.last_number);

const voidCount = (outletId: string) =>
  rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM pos_order_voids WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenant.tenantId, outletId],
  ).then((r) => r[0]!.n);

const journalCount = (outletId: string, sourceType: "sale" | "reversal") =>
  rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM journal_entries
      WHERE tenant_id = $1 AND outlet_id = $2 AND source_type = $3`,
    [tenant.tenantId, outletId, sourceType],
  ).then((r) => r[0]!.n);

const ingestOf = (orderId: string) =>
  rows<{ state: string; reason: string | null }>(
    `SELECT state, reason FROM edge_order_ingests
      WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  ).then((r) => r[0]);

// ---- Events ----------------------------------------------------------------------

let clock = Date.parse("2026-11-19T08:00:00.000Z");
let numberSeq = 0;

function envelope(
  name: string,
  outletId: string,
  aggregateId: string,
  sequence: number,
  payload: Record<string, unknown>,
): EventEnvelope {
  clock += 1_000;
  return eventEnvelopeSchema.parse({
    id: createUlid(clock),
    tenantId: tenant.tenantId,
    outletId,
    name,
    version: 1,
    aggregateType: "order",
    aggregateId,
    sequence,
    occurredAt: new Date(clock).toISOString(),
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${name}:${aggregateId}:${sequence}`,
    payloadSchemaRef: `${name}.v1`,
    payload,
  });
}

/** The `order.paid` shape of pos-1096-receipt-edge-offline-void.test.ts (total 77000). */
function paidEvent(
  outletId: string,
  deviceId: string,
  orderId: string,
): EventEnvelope {
  const line = (name: string, qty: number, unit: number, mods: number) => ({
    menuItemId,
    name,
    quantity: qty,
    unitPriceIdr: unit,
    modifiersTotalIdr: mods,
    lineTotalIdr: qty * unit + mods,
    fireStatus: "fired",
    reservedBusinessDate: BUSINESS_DATE,
    status: "served",
  });
  return envelope("order.paid", outletId, orderId, 1, {
    orderId,
    outletId,
    businessDate: BUSINESS_DATE,
    channel: "pos",
    serviceType: "takeaway",
    orderNumber: `G62-${String(++numberSeq).padStart(5, "0")}-${randomBytes(2).toString("hex")}`,
    subtotalIdr: 75_000,
    pricesIncludeTax: false,
    paymentMode: "pay_first",
    isTraining: false,
    grossSalesIdr: 75_000,
    discountIdr: 5_000,
    serviceChargeIdr: 0,
    pbjtIdr: 7_000,
    taxes: [
      {
        taxRuleId,
        code: "PBJT-1162",
        version: 1,
        taxType: "pbjt",
        rateBp: 1000,
        priceIncludesTax: false,
        grossIdr: 70_000,
        taxBaseIdr: 70_000,
        serviceChargeIdr: 0,
        taxIdr: 7_000,
      },
    ],
    roundingIdr: 0,
    totalIdr: SALE_TOTAL_IDR,
    paidCashIdr: 50_000,
    paidGatewayIdr: 0,
    paidEdcIdr: 20_000,
    paidPointsIdr: 7_000,
    paidDepositIdr: 0,
    tenders: [
      { method: "cash", amountIdr: 50_000, receivedIdr: 100_000 },
      { method: "edc_card", amountIdr: 20_000 },
      { method: "points", amountIdr: 7_000, pointsUsed: 70 },
    ],
    shiftId: null,
    cashierId,
    deviceId,
    paidAt: PAID_AT,
    lines: [
      line("Kopi Susu", 2, 25_000, 0),
      line("Roti Bakar", 1, 20_000, 5_000),
      { ...line("Teh Manis", 1, 10_000, 0), status: "voided" },
    ],
  });
}

function voidedEvent(
  outletId: string,
  orderId: string,
  receiptNumber: string,
): EventEnvelope {
  return envelope("order.voided", outletId, orderId, 2, {
    orderId,
    outletId,
    businessDate: BUSINESS_DATE,
    amountIdr: SALE_TOTAL_IDR,
    reason: "customer_cancelled",
    reasonNote: "Pelanggan batal",
    requestedBy: cashierId,
    approvedBy: supervisorId,
    overrideId: createUlid(++clock),
    approvalRequestId: null,
    voidedFinalOrder: true,
    voidId: randomUUID(),
    receiptNumber,
    voidedAt: VOIDED_AT,
  });
}

// ---- Cloud receive paths ---------------------------------------------------------

const nodes = new Map<string, Promise<AuthenticatedEdgeNode>>();
function edgeNodeFor(outletId: string): Promise<AuthenticatedEdgeNode> {
  let node = nodes.get(outletId);
  if (!node) {
    node = (async () => {
      const registered = await registerEdgeNode(scopeOf([outletId]), actor, {
        outletId,
        role: "primary",
        label: "Utama Run Ack",
      });
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

/** Events arrive through the real link receive path (registry dispatcher). */
async function deliver(node: AuthenticatedEdgeNode, events: EventEnvelope[]) {
  if (events.length === 0) return;
  const link = createDbLinkStore({
    database: db,
    context: node.context,
    node: node.scope,
    outboundDirection: "cloud_to_edge",
  });
  const from = await link.lastReceivedInbound();
  await link.applyInbound({
    fromSeq: from,
    toSeq: from + events.length,
    events: events.map((event, index) => ({
      linkSeq: from + index + 1,
      event,
    })),
  });
}

/** Holds the order's ingest advisory lock on another connection. */
async function holdOrderLock(orderId: string) {
  const key =
    `stock-source:${tenant.tenantId}:order:${ulidToUuid(orderId)}`.toLowerCase();
  const client = await owner.connect();
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    key,
  ]);
  return async () => {
    await client.query("ROLLBACK");
    client.release();
  };
}

/**
 * The cloud receives `order.voided` while the lock is held past its timeout:
 * a transient refusal, the way edge-order-redrive.test.ts induces it. The
 * transport ACK is written separately (putOrderEvent "acked").
 */
async function receiveVoidWhileLocked(
  node: AuthenticatedEdgeNode,
  event: EventEnvelope,
) {
  const orderId = (event.payload as { orderId: string }).orderId;
  const release = await holdOrderLock(orderId);
  try {
    const meta: EdgeApplyMeta = {
      edgeNodeId: node.scope.edgeNodeId,
      direction: "edge_to_cloud",
      kind: "transaction_event",
      context: node.context,
    };
    await withTenant(db, node.context, async (tx) => {
      await tx.execute(sql`SELECT set_config('lock_timeout', '300ms', true)`);
      await applyEdgeDeferredEvent(tx, event, meta);
      await ingestEdgeOrderVoided(tx, event, meta);
    });
  } finally {
    await release();
  }
}

const quiet = { error: () => undefined };
const sweep = () =>
  redriveEdgeOrderRefusalsForTenant(jobContext(), {
    log: quiet,
    lockTimeoutMs: 300,
  });

// ---- Edge side (outbox, queue, local receipts) -----------------------------------

type OrderEventName = "order.paid" | "order.voided";

/** An order event the edge appended to its outbox, relayed and ACKed by the cloud. */
async function putAckedOrderEvent(
  outletId: string,
  node: AuthenticatedEdgeNode,
  orderId: string,
  name: OrderEventName,
): Promise<void> {
  await asOwnerTenant(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const eventId = ulidToUuid(createUlid());
    const aggregateId = ulidToUuid(orderId);
    const aggregateSequence = name === "order.paid" ? 1 : 2;
    const stored = JSON.stringify({
      name,
      tenantId: tenant.tenantId,
      outletId,
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
        outletId,
        eventId,
        aggregateId,
        aggregateSequence,
        stored,
      ],
    );
    const seq = await client.query(
      `SELECT coalesce(max(link_seq), 0) + 1 AS next FROM edge_outbound_queue
        WHERE tenant_id = $1 AND edge_node_id = $2 AND direction = 'edge_to_cloud'`,
      [tenant.tenantId, node.scope.edgeNodeId],
    );
    await client.query(
      `INSERT INTO edge_outbound_queue
         (tenant_id, outlet_id, edge_node_id, direction, link_seq, event_id, aggregate_type, aggregate_id,
          aggregate_sequence, kind, event, status, acked_at)
       VALUES ($1, $2, $3, 'edge_to_cloud', $4, $5, 'order', $6, $7, 'transaction_event', $8::jsonb, 'acked', now())`,
      [
        tenant.tenantId,
        outletId,
        node.scope.edgeNodeId,
        seq.rows[0].next,
        eventId,
        aggregateId,
        aggregateSequence,
        stored,
      ],
    );
  });
}

type EdgeReceipt = {
  id: string;
  orderId: string;
  ordinal: number;
  voided: boolean;
};

/**
 * Install the edge's local receipts for a reporter pass (owner SQL, triggers
 * off, as a restored edge database looks). Receipts the cloud already holds
 * are left alone. Returns the ids this call inserted.
 */
async function installEdgeReceipts(
  outletId: string,
  deviceId: string,
  receipts: EdgeReceipt[],
): Promise<{ inserted: string[]; previousLastNumber: number }> {
  return asOwnerTenant(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const seq = await client.query(
      `SELECT id, last_number FROM receipt_sequences
        WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3 AND prefix = 'OFF1'`,
      [tenant.tenantId, outletId, deviceId],
    );
    const sequenceId = seq.rows[0].id as string;
    const previousLastNumber = seq.rows[0].last_number as number;
    await client.query(
      `UPDATE receipt_sequences SET last_number = GREATEST(last_number, $2) WHERE id = $1`,
      [sequenceId, receipts.length],
    );
    const inserted: string[] = [];
    for (const receipt of receipts) {
      const result = await client.query(
        `INSERT INTO pos_receipts
           (id, tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status,
            issued_at, voided_at, void_reason, voided_by, outlet_snapshot)
         VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12, $13, $14::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          receipt.id,
          tenant.tenantId,
          outletId,
          ulidToUuid(receipt.orderId),
          sequenceId,
          deviceId,
          `OFF1-${String(receipt.ordinal).padStart(6, "0")}`,
          receipt.ordinal,
          receipt.voided ? "voided" : "issued",
          PAID_AT,
          receipt.voided ? VOIDED_AT : null,
          receipt.voided ? "customer_cancelled" : null,
          receipt.voided ? cashierId : null,
          JSON.stringify(SNAPSHOT),
        ],
      );
      if (result.rows.length > 0) inserted.push(receipt.id);
    }
    return { inserted, previousLastNumber };
  });
}

/** Back to the cloud's state: only what installEdgeReceipts inserted goes away. */
async function removeEdgeReceipts(
  outletId: string,
  deviceId: string,
  installed: { inserted: string[]; previousLastNumber: number },
): Promise<void> {
  if (installed.inserted.length === 0) return;
  await asOwnerTenant(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `DELETE FROM pos_receipts WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
      [tenant.tenantId, installed.inserted],
    );
    await client.query(
      `UPDATE receipt_sequences SET last_number = $4
        WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3 AND prefix = 'OFF1'`,
      [tenant.tenantId, outletId, deviceId, installed.previousLastNumber],
    );
  });
}

async function reporterEvents(deviceId: string): Promise<EventEnvelope[]> {
  const result = await rows<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND destination = 'cloud-sync' AND aggregate_type = $2 AND aggregate_id = $3::uuid
      ORDER BY sequence`,
    [tenant.tenantId, RECEIPT_RUN_AGGREGATE, deviceId],
  );
  return result.map((row) => eventEnvelopeSchema.parse(row.event));
}

// ---- Setup -----------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  tenant = await createIsolatedTenant(`r1162-${randomUUID().slice(0, 6)}`);
  await owner.query(
    `UPDATE tenants t SET plan = s.plan, deployment_mode = s.deployment_mode, feature_flags = s.feature_flags
       FROM tenants s WHERE s.id = $2 AND t.id = $1`,
    [tenant.tenantId, seededTenantId],
  );
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Kasir Run Ack', $2)`,
    [cashierId, `${cashierId}@example.test`],
  );
  await asOwnerTenant(async (pg) => {
    await pg.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Struk Run Ack Uji', 0)`,
      [categoryId, tenant.tenantId, tenant.brandId],
    );
    await pg.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [menuItemId, tenant.tenantId, tenant.brandId, categoryId, randomUUID()],
    );
    await pg.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-1162', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [taxRuleId, tenant.tenantId, cashierId],
    );
  });
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  // The order of runtime.ts: POS deferred, order ingest, receipt run, fallback.
  registerStockMovedEdgeApplier();
  registerPosDeferredEdgeApplier();
  registerOrderEdgeApplier();
  registerReceiptRunEdgeApplier();
  registerEdgeDeferredFallback();
});

afterAll(async () => {
  resetEdgeApplierRegistryForTests();
  setAuditWriter(null);
  // Receipts and final orders are append-only: the isolated tenant stays in the
  // disposable database; give it a valid creator so the tenant list parses.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Test ------------------------------------------------------------------------

describe("legend-gdjpu edge run ACKed before the void ingest succeeded", () => {
  it("legend-gdjpu the receipts of the run reach the cloud with numbers kept after the void is redriven, one void, no manual run event", async () => {
    const outletId = await freshOutlet();
    const deviceId = randomUUID();
    const node = await edgeNodeFor(outletId);

    // Cloud provisions the device prefix; the edge claim binds it to this node.
    const context = scopeOf();
    await withTenant(db, context, (tx) =>
      provisionReceiptSequence(
        tx as Parameters<typeof provisionReceiptSequence>[0],
        context,
        { outletId, deviceId, prefix: "OFF1" },
      ),
    );
    await asOwnerTenant(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE receipt_sequences SET edge_node_id = $4, edge_instance_id = $5
          WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3 AND prefix = 'OFF1'`,
        [
          tenant.tenantId,
          outletId,
          deviceId,
          node.scope.edgeNodeId,
          EDGE_INSTANCE,
        ],
      );
    });

    // 1. The cloud ingested the offline sales of two orders.
    const orders = [createUlid(++clock), createUlid(++clock)];
    await deliver(
      node,
      orders.map((orderId) => paidEvent(outletId, deviceId, orderId)),
    );
    const [, voidedOrder] = orders;
    expect(await ingestOf(voidedOrder!)).toMatchObject({ state: "ingested" });
    for (const orderId of orders)
      await putAckedOrderEvent(outletId, node, orderId, "order.paid");

    const edgeReceipts: EdgeReceipt[] = orders.map((orderId, index) => ({
      id: randomUUID(),
      orderId,
      ordinal: index + 1,
      voided: index === 1,
    }));

    // 2. The cloud receives order.voided of order 2 under a held lock: a
    // transient refusal. The transport still ACKs the event.
    await receiveVoidWhileLocked(
      node,
      voidedEvent(outletId, voidedOrder!, "OFF1-000002"),
    );
    expect(await ingestOf(voidedOrder!)).toMatchObject({
      reason: "void_refused:lock_failed",
    });
    expect(await voidCount(outletId)).toBe(0);
    await putAckedOrderEvent(outletId, node, voidedOrder!, "order.voided");

    // 3. The production reporter sends the run chunk (void delivered + acked),
    // and everything it wrote reaches the cloud before the sweep runs.
    const delivered = new Set<string>();
    async function reporterRound(): Promise<number> {
      const installed = await installEdgeReceipts(
        outletId,
        deviceId,
        edgeReceipts,
      );
      const result = await reportEdgeReceiptRuns(scopeOf([outletId]), {
        outletId,
        edgeNodeId: node.scope.edgeNodeId,
        edgeInstanceId: EDGE_INSTANCE,
      });
      await removeEdgeReceipts(outletId, deviceId, installed);
      const fresh = (await reporterEvents(deviceId)).filter(
        (event) => !delivered.has(event.id),
      );
      for (const event of fresh) delivered.add(event.id);
      await deliver(node, fresh);
      return result.reported;
    }

    const firstPass = await reporterRound();
    expect(
      firstPass,
      "the reporter must send the run once order.voided is acked",
    ).toBeGreaterThan(0);
    expect(
      (await reporterEvents(deviceId)).every(
        (event) => event.name === RECEIPT_RUN_REPORTED_EVENT,
      ),
    ).toBe(true);
    // The void is still not in the cloud when the run arrived.
    expect(await voidCount(outletId)).toBe(0);

    // 4. The lock is gone: the sweep ingests the void.
    expect(await sweep()).toMatchObject({ recovered: 1, failed: 0 });
    expect(await voidCount(outletId)).toBe(1);
    expect(await ingestOf(voidedOrder!)).toMatchObject({
      state: "voided",
      reason: null,
    });

    // 5. Reporter and sweep keep running; the test builds no run event.
    for (let round = 0; round < 3; round += 1) {
      await reporterRound();
      await sweep();
    }

    // The cloud holds the whole run, numbers kept, voided receipt voided.
    const stored = await receiptRows(outletId);
    expect(
      stored.map((row) => [row.number, row.status]),
      "every receipt of the run must be in the cloud",
    ).toEqual([
      ["OFF1-000001", "issued"],
      ["OFF1-000002", "voided"],
    ]);
    expect(stored[1]).toMatchObject({
      void_reason: "customer_cancelled",
      voided_by: cashierId,
    });
    expect(await lastNumberOf(outletId)).toBe(2);
    const gaps = await withTenant(db, context, (tx) =>
      receiptGapsForOutlet(
        tx as Parameters<typeof receiptGapsForOutlet>[0],
        context,
        outletId,
      ),
    );
    for (const gap of gaps) expect(gap.missing).toEqual([]);

    // One void and its single reversing journal (as many as sale journals).
    expect(await voidCount(outletId)).toBe(1);
    const sales = await journalCount(outletId, "sale");
    expect(sales).toBeLessThanOrEqual(2);
    expect(await journalCount(outletId, "reversal")).toBe(sales > 0 ? 1 : 0);
  });
});
