// Brief 1096, card 2 (beads legend-ain0 + legend-ol6v): proof test that the
// offline receipt run reaches the cloud end to end. Written from the brief and
// the observable contract of the existing edge tests (edge-order-ingest,
// edge-receipt-run-applier, pos-receipt-kfix), not from the service code.
//
// Flow under test (all through the real registry dispatcher and link receive
// path, in a real isolated tenant on PostgreSQL with RLS):
//   offline sale   -> `order.paid` event (the cloud ingests the sale)
//   offline void   -> `order.voided` event (the cloud writes its own void row)
//   numbered run   -> `receipt_run.reported` event (the cloud merges receipts)
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/pos-1096-receipt-edge-offline-void.test.ts" heavy pnpm test
//
// Acceptance (brief):
//   (a) sell offline, then void offline: the void is ingested BEFORE the run is
//       merged, and the merge does not deadlock on RECEIPT_VOID_UNMATCHED. A
//       run applied before its void is refused and writes nothing; once the
//       void is ingested the same run merges. The real edge does NOT resend a
//       refused run (its high-water reporter moves on); what prevents the
//       deadlock there is the reporter rule "a void is reported only after
//       its order.voided is acked", tested in edge-receipt-run-applier.test.ts
//       ("legend-zy43 no void event until order.voided is acked"). This file only proves the cloud side of that rule.
//   (b) a replay (same event twice, or the run resent under a new event id)
//       adds nothing.
//   (c) `receipt_sequences.edge_reported_at` is stamped by the cloud clock when
//       the run merges, and never moves backwards on a replay.
//
// Assumptions (spec/brief silent, also reported):
//  - The refusal of a run whose void is not yet ingested is a CoreError (the
//    node is not stalled) that is RECEIPT_VOID_UNMATCHED (409, "Struk ditandai
//    void tetapi cloud tidak punya void yang cocok."): asserted by that code or
//    that message, since a CoreError may carry it as its code or its message.
//  - The cloud void row carries the receipt number the device printed
//    (`receiptNumber` of `order.voided` = "OFF1-00000N"); the merge matches the
//    device's voided receipt to the cloud void by ORDER id only (not by receipt
//    number) and takes reason / voidedBy from the cloud void, never from what
//    the device claims (same rule as pos-receipt-kfix.test.ts).
//  - `order.paid` ingest stores the payload `deviceId` as the order's device,
//    which the merge needs (an order of another device is refused).
//  - edge_reported_at is compared against the database clock with a 5 s
//    tolerance; a replay may keep it or move it forward, never back or to NULL.

import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CoreError,
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
  formatReceiptNumber,
  RECEIPT_RUN_AGGREGATE,
  RECEIPT_RUN_REPORTED_EVENT,
} from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  registerEdgeDeferredFallback,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { registerOrderEdgeApplier } from "../edge/order-edge-applier.ts";
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
import {
  INGEST_HOLD_EXPIRED_PREFIX,
  RECEIPT_RUN_INGEST_HOLD_MS,
  registerReceiptRunEdgeApplier,
} from "../edge/receipt-run-applier.ts";
import { registerStockMovedEdgeApplier } from "../edge/stock-moved-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { redriveEdgeOrderRefusalsForTenant } from "../worker/edge-order-redrive.job.ts";
import { enrollDevice } from "../services/device.service.ts";
import {
  authenticateEdgeCredential,
  registerEdgeNode,
  type AuthenticatedEdgeNode,
} from "../services/edge-node.service.ts";
import {
  claimDeviceReceiptSequencesForEdge,
  provisionReceiptSequence,
  receiptGapsForOutlet,
} from "../services/pos-receipt.service.ts";
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

const actor = randomUUID();
const cashierId = randomUUID();
const supervisorId = randomUUID();
const categoryId = randomUUID();
const menuItemId = randomUUID();
const taxRuleId = randomUUID();

let tenant: IsolatedTenant;

// ---- Database helpers -----------------------------------------------------------

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

/** The merge refused an unmatched void: a CONFLICT CoreError with the unmatched-void message. */
function expectVoidUnmatched(refusal: unknown): void {
  expect(refusal, "an unmatched void must be refused").toBeInstanceOf(
    CoreError,
  );
  const error = refusal as CoreError;
  expect(error.code, `${error.code}: ${error.message}`).toBe("CONFLICT");
  expect(error.message).toContain(
    "Struk ditandai void tetapi cloud tidak punya void yang cocok.",
  );
}

const nodes = new Map<string, Promise<AuthenticatedEdgeNode>>();
function edgeNodeFor(outletId: string): Promise<AuthenticatedEdgeNode> {
  let node = nodes.get(outletId);
  if (!node) {
    node = (async () => {
      const registered = await registerEdgeNode(scopeOf([outletId]), actor, {
        outletId,
        role: "primary",
        label: "Utama Struk Void",
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
      `V${outletId.slice(0, 8)}`.toUpperCase(),
      OUTLET_NAME,
      OUTLET_ADDRESS,
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );
  return outletId;
}

function provision(outletId: string, deviceId: string, prefix: string) {
  const context = scopeOf();
  return withTenant(db, context, (tx) =>
    provisionReceiptSequence(
      tx as Parameters<typeof provisionReceiptSequence>[0],
      context,
      { outletId, deviceId, prefix },
    ),
  );
}

type ReceiptRow = {
  number: string;
  sequence_number: number;
  status: string;
  void_reason: string | null;
  voided_by: string | null;
  voided_at: Date | null;
};

const receiptRows = (outletId: string) =>
  rows<ReceiptRow>(
    `SELECT number, sequence_number, status, void_reason, voided_by, voided_at
       FROM pos_receipts WHERE tenant_id = $1 AND outlet_id = $2
      ORDER BY sequence_number`,
    [tenant.tenantId, outletId],
  );

type SequenceRow = {
  prefix: string;
  last_number: number;
  edge_node_id: string | null;
  edge_reported_at: Date | null;
};

const sequenceRows = (outletId: string) =>
  rows<SequenceRow>(
    `SELECT prefix, last_number, edge_node_id, edge_reported_at FROM receipt_sequences
      WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix`,
    [tenant.tenantId, outletId],
  );

const voidCount = (outletId: string) =>
  rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM pos_order_voids WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenant.tenantId, outletId],
  ).then((r) => r[0]!.n);

const conflictCount = (outletId: string) =>
  rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM edge_sync_conflicts WHERE tenant_id = $1 AND outlet_id = $2`,
    [tenant.tenantId, outletId],
  ).then((r) => r[0]!.n);

async function dbNow(): Promise<Date> {
  const result = await rows<{ t: Date }>("SELECT now() AS t");
  return result[0]!.t;
}

// ---- Events ----------------------------------------------------------------------

let clock = Date.parse("2026-11-13T08:00:00.000Z");
let numberSeq = 0;

function envelope(
  name: string,
  outletId: string,
  aggregateType: string,
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
    aggregateType,
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

/** The `order.paid` payload shape used by edge-order-ingest.test.ts (total 77000). */
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
  return envelope("order.paid", outletId, "order", orderId, 1, {
    orderId,
    outletId,
    businessDate: BUSINESS_DATE,
    channel: "pos",
    serviceType: "takeaway",
    orderNumber: `OFV-${String(++numberSeq).padStart(5, "0")}-${randomBytes(2).toString("hex")}`,
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
        code: "PBJT-1096",
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
  return envelope("order.voided", outletId, "order", orderId, 2, {
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

const aggregateSequences = new Map<string, number>();

/** `voidedOrdinals`: receipts the device voided offline (it claims its own reason). */
function runEvent(
  outletId: string,
  deviceId: string,
  orders: string[],
  voidedOrdinals: number[] = [],
): EventEnvelope {
  clock += 1_000;
  const at = new Date(clock).toISOString();
  const receipts = orders.map((orderId, index) => {
    const ordinal = index + 1;
    const voided = voidedOrdinals.includes(ordinal);
    return {
      receipt: {
        id: randomUUID(),
        tenantId: tenant.tenantId,
        outletId,
        orderId,
        deviceId,
        number: formatReceiptNumber("OFF1", ordinal),
        sequenceNumber: ordinal,
        status: voided ? "voided" : "issued",
        issuedAt: at,
        voidedAt: voided ? at : null,
        voidReason: voided ? "wrong_order" : null,
        voidedBy: voided ? randomUUID() : null,
        reprintCount: 0,
      },
      outletSnapshot: SNAPSHOT,
    };
  });
  const sequence = (aggregateSequences.get(deviceId) ?? 0) + 1;
  aggregateSequences.set(deviceId, sequence);
  return eventEnvelopeSchema.parse({
    id: createUlid(clock),
    tenantId: tenant.tenantId,
    outletId,
    name: RECEIPT_RUN_REPORTED_EVENT,
    version: 1,
    aggregateType: RECEIPT_RUN_AGGREGATE,
    aggregateId: deviceId,
    sequence,
    occurredAt: at,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${RECEIPT_RUN_REPORTED_EVENT}:${deviceId}:${sequence}`,
    payloadSchemaRef: `${RECEIPT_RUN_REPORTED_EVENT}.v1`,
    payload: {
      sequence: {
        tenantId: tenant.tenantId,
        outletId,
        deviceId,
        prefix: "OFF1",
        lastNumber: orders.length,
      },
      receipts,
    },
  });
}

/** Orders and voids arrive through the real link receive path. */
async function deliver(node: AuthenticatedEdgeNode, events: EventEnvelope[]) {
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

/** The run goes through the registry dispatcher in a tenant transaction. */
function applyRun(event: EventEnvelope, node: AuthenticatedEdgeNode) {
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
 * The real way a provisioned sequence gets its edge binding: the edge's pull
 * claims it (lastNumber 0, unbound) for its node and instance, before any run
 * is pushed. Only a bound run gets `edge_reported_at` stamped by the merge.
 */
async function bindToEdge(outletId: string, node: AuthenticatedEdgeNode) {
  const context = scopeOf();
  await withTenant(db, context, (tx) =>
    claimDeviceReceiptSequencesForEdge(
      tx as Parameters<typeof claimDeviceReceiptSequencesForEdge>[0],
      context,
      {
        outletId,
        edgeNodeId: node.scope.edgeNodeId,
        edgeInstanceId: randomUUID(),
        report: new Map(),
      },
    ),
  );
  const [row] = await sequenceRows(outletId);
  expect(row?.edge_node_id, "the claim must bind the sequence").toBe(
    node.scope.edgeNodeId,
  );
}

/**
 * A fresh outlet whose device sold `count` orders offline (the cloud ingested
 * every `order.paid`); the cloud provisioned the device prefix OFF1.
 */
async function offlineScenario(
  count: number,
  options: { bind?: boolean } = {},
) {
  const outletId = await freshOutlet();
  // A real, active `pos` device row: the edge claim only binds sequences that
  // join to an active pos/kds/waiter_phone device.
  const { device } = await enrollDevice(scopeOf([outletId]), actor, {
    outletId,
    type: "pos",
    label: `Kasir Offline ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  const deviceId = device.id;
  await provision(outletId, deviceId, "OFF1");
  const node = await edgeNodeFor(outletId);
  if (options.bind) await bindToEdge(outletId, node);
  const orders = Array.from({ length: count }, () => createUlid(++clock));
  await deliver(
    node,
    orders.map((orderId) => paidEvent(outletId, deviceId, orderId)),
  );
  return { outletId, deviceId, node, orders };
}

async function gapsOf(outletId: string) {
  const context = scopeOf();
  return withTenant(db, context, (tx) =>
    receiptGapsForOutlet(
      tx as Parameters<typeof receiptGapsForOutlet>[0],
      context,
      outletId,
    ),
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  tenant = await createIsolatedTenant(`r1096-${randomUUID().slice(0, 6)}`);
  // Edge nodes need the plan/deployment the seeded tenant has.
  await owner.query(
    `UPDATE tenants t SET plan = s.plan, deployment_mode = s.deployment_mode, feature_flags = s.feature_flags
       FROM tenants s WHERE s.id = $2 AND t.id = $1`,
    [tenant.tenantId, seededTenantId],
  );
  await owner.query(
    `INSERT INTO "user" (id, name, email) VALUES ($1, 'Kasir Offline Void', $2)`,
    [cashierId, `${cashierId}@example.test`],
  );
  await asOwnerTenant(async (pg) => {
    await pg.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Struk Offline Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-1096', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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

// ---- (a) offline sale then offline void -----------------------------------------------

describe("legend-ain0 offline sale then offline void merges without deadlock (a)", () => {
  it("legend-ain0 the void is ingested first, then the run with its voided receipt merges: numbers 1..3 gapless, void fields from the cloud void", async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(3);
    const [, voidedOrder] = orders;

    // The edge sends the void of sale 2 (receipt OFF1-000002) before the run.
    await deliver(node, [
      voidedEvent(outletId, voidedOrder!, formatReceiptNumber("OFF1", 2)),
    ]);
    expect(await voidCount(outletId)).toBe(1);

    const run = runEvent(outletId, deviceId, orders, [2]);
    await applyRun(run, node);

    const stored = await receiptRows(outletId);
    expect(stored.map((row) => [row.number, row.status])).toEqual([
      ["OFF1-000001", "issued"],
      ["OFF1-000002", "voided"],
      ["OFF1-000003", "issued"],
    ]);
    // The void keeps its number and carries the CLOUD void, not the device claim.
    expect(stored[1]).toMatchObject({
      void_reason: "customer_cancelled",
      voided_by: cashierId,
    });
    expect(stored[1]!.voided_at?.toISOString()).toBe(VOIDED_AT);
    expect(stored[0]!.void_reason).toBeNull();
    expect(stored[2]!.void_reason).toBeNull();

    expect(await sequenceRows(outletId)).toEqual([
      expect.objectContaining({ prefix: "OFF1", last_number: 3 }),
    ]);
    // The day close would not refuse with RECEIPT_SEQUENCE_GAP.
    for (const gap of await gapsOf(outletId)) expect(gap.missing).toEqual([]);
    expect(await conflictCount(outletId)).toBe(0);
    // Still exactly one void row: the merge did not add another.
    expect(await voidCount(outletId)).toBe(1);
  });

  it("legend-ain0 cloud side: a run applied before its void is refused and writes nothing; once the void is ingested the same run merges (the edge reporter avoids the early send, see edge-receipt-run-applier.test.ts)", async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(2);
    const [, voidedOrder] = orders;

    const early = runEvent(outletId, deviceId, orders, [2]);
    const refusal = await applyRun(early, node).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(refusal, "an unmatched void must be refused").toBeInstanceOf(
      CoreError,
    );
    expectVoidUnmatched(refusal);
    // The refusal is all or nothing: no receipt, the sequence did not move.
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toEqual([
      expect.objectContaining({
        prefix: "OFF1",
        last_number: 0,
      }),
    ]);

    // The void arrives; the run is applied again as a NEW event (a test
    // driver step: the real edge reporter would only send it after the ack).
    await deliver(node, [
      voidedEvent(outletId, voidedOrder!, formatReceiptNumber("OFF1", 2)),
    ]);
    await applyRun(runEvent(outletId, deviceId, orders, [2]), node);

    expect(
      (await receiptRows(outletId)).map((row) => [row.number, row.status]),
    ).toEqual([
      ["OFF1-000001", "issued"],
      ["OFF1-000002", "voided"],
    ]);
    expect(await sequenceRows(outletId)).toEqual([
      expect.objectContaining({ prefix: "OFF1", last_number: 2 }),
    ]);
    for (const gap of await gapsOf(outletId)) expect(gap.missing).toEqual([]);
  });

  it("legend-ain0 a sale voided offline whose run reports it issued then voided in two runs also lands voided with its number kept", async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(2);
    const [, voidedOrder] = orders;

    // Run 1: both sales still issued.
    await applyRun(runEvent(outletId, deviceId, orders), node);
    expect(
      (await receiptRows(outletId)).map((row) => [row.number, row.status]),
    ).toEqual([
      ["OFF1-000001", "issued"],
      ["OFF1-000002", "issued"],
    ]);

    // Then sale 2 is voided: void event first, then the run reporting it voided.
    await deliver(node, [
      voidedEvent(outletId, voidedOrder!, formatReceiptNumber("OFF1", 2)),
    ]);
    await applyRun(runEvent(outletId, deviceId, orders, [2]), node);

    const stored = await receiptRows(outletId);
    expect(stored.map((row) => [row.number, row.status])).toEqual([
      ["OFF1-000001", "issued"],
      ["OFF1-000002", "voided"],
    ]);
    expect(stored[1]).toMatchObject({
      void_reason: "customer_cancelled",
      voided_by: cashierId,
    });
    for (const gap of await gapsOf(outletId)) expect(gap.missing).toEqual([]);
  });
});

// ---- legend-gdjpu: a void ACKed before its ingest succeeded -----------------------

describe("legend-gdjpu a run whose void ingest failed transiently stays queued until the void is redriven", () => {
  /** Holds the tenant loyalty entity lock on another connection. */
  async function holdLoyaltyLock() {
    const client = await owner.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`loyalty-entity:${tenant.tenantId}`],
    );
    return async () => {
      await client.query("ROLLBACK");
      client.release();
    };
  }

  async function ledgerReason(orderId: string): Promise<string | null> {
    const [row] = await rows<{ reason: string | null }>(
      `SELECT reason FROM edge_order_ingests
        WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    return row?.reason ?? null;
  }

  const sweepContext = () =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "job",
      }),
      { kind: "tenant" },
    );

  it("legend-gdjpu the link refuses to acknowledge the run while its void is transiently refused; the sweep heals the void and the SAME queued run then merges, no manual replacement event", async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(2);
    const [, voidedOrder] = orders;

    // The void reaches the cloud while the loyalty lock is busy: the ingest
    // savepoint times out (55P03), the refusal is noted, and the link still
    // acknowledges the event (R1: ingest never throws after parking).
    const release = await holdLoyaltyLock();
    try {
      await deliver(node, [
        voidedEvent(outletId, voidedOrder!, formatReceiptNumber("OFF1", 2)),
      ]);
    } finally {
      await release();
    }
    expect(await voidCount(outletId)).toBe(0);
    expect(await ledgerReason(voidedOrder!)).toBe(
      "void_refused:db_error:55P03",
    );

    // The edge reporter saw order.voided acknowledged and sent the run. The
    // cloud must not acknowledge it (no conflict, no cursor move): the edge
    // keeps it queued and resends the same event.
    const run = runEvent(outletId, deviceId, orders, [2]);
    const before = await conflictCount(outletId);
    await expect(deliver(node, [run])).rejects.toThrow();
    expect(await conflictCount(outletId)).toBe(before);
    expect(await receiptRows(outletId)).toHaveLength(0);

    // The redrive sweep ingests the parked void.
    await redriveEdgeOrderRefusalsForTenant(sweepContext(), {
      log: { error: () => undefined },
      lockTimeoutMs: 300,
    });
    expect(await voidCount(outletId)).toBe(1);
    expect(await ledgerReason(voidedOrder!)).toBeNull();

    // The sender's retry of the SAME event now merges every receipt.
    await deliver(node, [run]);
    expect(
      (await receiptRows(outletId)).map((row) => [row.number, row.status]),
    ).toEqual([
      ["OFF1-000001", "issued"],
      ["OFF1-000002", "voided"],
    ]);
    expect(await sequenceRows(outletId)).toEqual([
      expect.objectContaining({ prefix: "OFF1", last_number: 2 }),
    ]);
    for (const gap of await gapsOf(outletId)) expect(gap.missing).toEqual([]);
    expect(await voidCount(outletId)).toBe(1);
    expect(await conflictCount(outletId)).toBe(before);
  });

  async function supervisorAlerts(userId: string): Promise<number> {
    const [row] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications
        WHERE tenant_id = $1 AND user_id = $2 AND category = 'edge_sync_conflict'`,
      [tenant.tenantId, userId],
    );
    return row!.n;
  }

  async function orderCount(orderId: string): Promise<number> {
    const [row] = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    return row!.n;
  }

  async function sweep() {
    await redriveEdgeOrderRefusalsForTenant(sweepContext(), {
      log: { error: () => undefined },
      lockTimeoutMs: 300,
    });
  }

  it("legend-gdjpu order.paid with the same gap: a run of a transiently refused sale stays queued, the sweep ingests the sale, the SAME run then merges", async () => {
    const release = await holdLoyaltyLock();
    let scenario: Awaited<ReturnType<typeof offlineScenario>>;
    try {
      scenario = await offlineScenario(1);
    } finally {
      await release();
    }
    const { outletId, deviceId, node, orders } = scenario;
    expect(await ledgerReason(orders[0]!)).toBe("db_error:55P03");

    const run = runEvent(outletId, deviceId, orders);
    const before = await conflictCount(outletId);
    await expect(deliver(node, [run])).rejects.toThrow();
    expect(await conflictCount(outletId)).toBe(before);
    expect(await receiptRows(outletId)).toHaveLength(0);

    await sweep();
    expect(await ledgerReason(orders[0]!)).toBeNull();

    await deliver(node, [run]);
    expect(
      (await receiptRows(outletId)).map((row) => [row.number, row.status]),
    ).toEqual([["OFF1-000001", "issued"]]);
    expect(await conflictCount(outletId)).toBe(before);
  });

  it(`legend-gdjpu a transient refusal older than the hold (${RECEIPT_RUN_INGEST_HOLD_MS / 60_000} min) no longer holds the run: it is refused as a conflict and the link moves on`, async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(2);
    const [, voidedOrder] = orders;
    const release = await holdLoyaltyLock();
    try {
      await deliver(node, [
        voidedEvent(outletId, voidedOrder!, formatReceiptNumber("OFF1", 2)),
      ]);
    } finally {
      await release();
    }
    expect(await ledgerReason(voidedOrder!)).toBe(
      "void_refused:db_error:55P03",
    );
    // The parked void is older than the hold (cloud clock).
    await asOwnerTenant((client) =>
      client.query(
        `UPDATE edge_deferred_events
            SET received_at = now() - make_interval(secs => $2::double precision)
          WHERE tenant_id = $1 AND outlet_id = $3 AND event_name = 'order.voided'`,
        [tenant.tenantId, RECEIPT_RUN_INGEST_HOLD_MS / 1000 + 60, outletId],
      ),
    );

    // A supervisor of this outlet receives the conflict alert.
    const supervisor = randomUUID();
    const roleId = randomUUID();
    await owner.query(
      'INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)',
      [supervisor, "Supervisor Gdjpu", `gdjpu-${supervisor}@example.test`],
    );
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Supervisor Gdjpu', true, 'supervisor', '[]', false, '["outlet"]')`,
      [roleId, tenant.tenantId],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'outlet', $4, now() - interval '1 minute', $2)`,
      [tenant.tenantId, supervisor, roleId, outletId],
    );
    const before = await conflictCount(outletId);
    const alertsBefore = await supervisorAlerts(supervisor);
    await deliver(node, [runEvent(outletId, deviceId, orders, [2])]);
    expect(await conflictCount(outletId)).toBe(before + 1);
    expect(await receiptRows(outletId)).toHaveLength(0);
    // The conflict says why, and the outlet's managers are told.
    const [expired] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM edge_sync_conflicts
        WHERE tenant_id = $1 AND outlet_id = $2 AND detail LIKE $3`,
      [tenant.tenantId, outletId, `${INGEST_HOLD_EXPIRED_PREFIX}%`],
    );
    expect(expired!.n).toBe(1);
    expect(await supervisorAlerts(supervisor)).toBeGreaterThan(alertsBefore);
  });

  it("legend-gdjpu another order.paid ahead of the held run in the same batch is rolled back with it and lands exactly once on the retry", async () => {
    const release = await holdLoyaltyLock();
    let scenario: Awaited<ReturnType<typeof offlineScenario>>;
    try {
      scenario = await offlineScenario(1);
    } finally {
      await release();
    }
    const { outletId, deviceId, node, orders } = scenario;
    expect(await ledgerReason(orders[0]!)).toBe("db_error:55P03");

    const other = createUlid(++clock);
    const batch = [
      paidEvent(outletId, deviceId, other),
      runEvent(outletId, deviceId, orders),
    ];
    await expect(deliver(node, batch)).rejects.toThrow();
    expect(await orderCount(other)).toBe(0);

    await sweep();
    await deliver(node, batch);
    expect(await orderCount(other)).toBe(1);
    expect(await ledgerReason(other)).toBeNull();
    expect(
      (await receiptRows(outletId)).map((row) => [row.number, row.status]),
    ).toEqual([["OFF1-000001", "issued"]]);
  });
});

// ---- (b) replay adds nothing ----------------------------------------------------------

describe("legend-ain0 replay of the run adds nothing (b)", () => {
  async function snapshotOf(outletId: string) {
    return {
      receipts: await receiptRows(outletId),
      sequences: (await sequenceRows(outletId)).map((row) => ({
        prefix: row.prefix,
        last_number: row.last_number,
      })),
      voids: await voidCount(outletId),
      conflicts: await conflictCount(outletId),
    };
  }

  it("legend-ain0 the same event delivered twice, and the same run under a new event id, change nothing and do not throw", async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(3);
    const [, voidedOrder] = orders;
    await deliver(node, [
      voidedEvent(outletId, voidedOrder!, formatReceiptNumber("OFF1", 2)),
    ]);
    const run = runEvent(outletId, deviceId, orders, [2]);
    await applyRun(run, node);
    const merged = await snapshotOf(outletId);
    expect(merged.receipts).toHaveLength(3);

    await applyRun(run, node);
    expect(await snapshotOf(outletId)).toEqual(merged);

    await applyRun(runEvent(outletId, deviceId, orders, [2]), node);
    expect(await snapshotOf(outletId)).toEqual(merged);
  });

  it("legend-ain0 a replay of a run whose voided receipt was already merged is not refused as RECEIPT_VOID_UNMATCHED", async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(2);
    const [, voidedOrder] = orders;
    await deliver(node, [
      voidedEvent(outletId, voidedOrder!, formatReceiptNumber("OFF1", 2)),
    ]);
    const run = runEvent(outletId, deviceId, orders, [2]);
    await applyRun(run, node);
    // Nothing throws: the merge is idempotent for an already voided receipt too.
    await applyRun(run, node);
    expect(
      (await receiptRows(outletId)).map((row) => [row.number, row.status]),
    ).toEqual([
      ["OFF1-000001", "issued"],
      ["OFF1-000002", "voided"],
    ]);
  });
});

// ---- (c) edge_reported_at is stamped --------------------------------------------------
// Architect decision: the merge stamps `edge_reported_at` (cloud/app clock) only
// when the run is bound to an edge (`edge_node_id` set) and lastNumber rises.
// A binding comes from the edge's claim, so these tests bind first (bindToEdge).

describe("legend-ol6v edge_reported_at is stamped when the run merges (c)", () => {
  it("legend-ol6v a run bound to its edge is stamped by the merge with the cloud clock, not the event time", async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(2, {
      bind: true,
    });

    const before = await dbNow();
    const run = runEvent(outletId, deviceId, orders);
    await applyRun(run, node);
    const after = await dbNow();

    const stamped = (await sequenceRows(outletId))[0]!.edge_reported_at;
    expect(
      stamped,
      "edge_reported_at must be stamped by the merge",
    ).not.toBeNull();
    expect(stamped!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
    expect(stamped!.getTime()).toBeLessThanOrEqual(after.getTime() + 5_000);
    // Never the edge's own clock (the event says 2026-11-13).
    expect(stamped!.toISOString()).not.toBe(run.occurredAt);
  });

  it("legend-ol6v a replay never moves edge_reported_at backwards or back to NULL", async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(2, {
      bind: true,
    });
    const run = runEvent(outletId, deviceId, orders);
    await applyRun(run, node);
    const first = (await sequenceRows(outletId))[0]!.edge_reported_at;
    expect(first).not.toBeNull();

    await applyRun(run, node);
    await applyRun(runEvent(outletId, deviceId, orders), node);
    const later = (await sequenceRows(outletId))[0]!.edge_reported_at;
    expect(later).not.toBeNull();
    expect(later!.getTime()).toBeGreaterThanOrEqual(first!.getTime());
  });

  it("legend-ol6v a refused run (unmatched void) does not stamp edge_reported_at", async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(2, {
      bind: true,
    });
    const refusal = await applyRun(
      runEvent(outletId, deviceId, orders, [2]),
      node,
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expectVoidUnmatched(refusal);
    expect((await sequenceRows(outletId))[0]!.edge_reported_at).toBeNull();
  });

  it("legend-ol6v a run that is only provisioned (never claimed by an edge, edge_node_id NULL) merges without any stamp", async () => {
    const { outletId, deviceId, node, orders } = await offlineScenario(2);
    expect((await sequenceRows(outletId))[0]!.edge_node_id).toBeNull();
    await applyRun(runEvent(outletId, deviceId, orders), node);
    const [row] = await sequenceRows(outletId);
    expect(row!.last_number).toBe(2);
    expect(row!.edge_reported_at).toBeNull();
  });
});
