// legend-n1fzg (brief 659): a receipt of a permanently refused edge order must
// not hold the receipt run. The cloud never ingests such an order
// (edge_order_ingests state='refused', reason `legacy_payload` / `order_exists`),
// so before this fix every chunk containing its receipt was refused and every
// later chunk hit the same hole. Target (brief + docs/design/edge-order-ingest.md
// known limitation 2): the applier SKIPS that receipt, the other receipts of the
// run still merge, the skip is recorded once per (tenant, order) as a conflict
// finance can see (number, order, reason), a redelivery adds nothing, and no
// revenue is created for the skipped order.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/edge-receipt-run-skip-refused.test.ts" heavy pnpm test
//
// Assumptions (brief does not fix them):
//  - The skip is recorded in `edge_receipt_skips`, one row per (tenant, outlet,
//    order, receipt number, reason) (review of n1fzg: a conflict detail holds
//    500 chars, so a list of skips there overflowed and refused the run). The
//    run event itself gets ONE summary conflict (skip count, no list).
//  - "Once per (tenant, order)" holds across a same-event redelivery AND a
//    re-sent run under a new event id (the reporter's retry after a lost ack).
//  - A refusal that is not permanent (e.g. `db_error:40001`) is NOT skipped:
//    the receipt never merges and no skip conflict is recorded.
//  - The skipped number stays recorded, not erased: no pos_receipts row exists
//    for the skipped order, and the sequence still advances past its number.

import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
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
import { edgeEventApplier, type EdgeApplyMeta } from "../edge/ports.ts";
import { registerReceiptRunEdgeApplier } from "../edge/receipt-run-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
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
  const created = await asEdgeProcess(() =>
    cashier.client
      .post(`/api/outlets/${encodeURIComponent(outletId)}/pos/orders`)
      .set(headers)
      .set(originHeader)
      .send({
        idempotencyKey: randomUUID(),
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
      }),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

/**
 * 1269 E3: the cloud refuses a sale on an outlet an active edge serves
 * (POS_WRITE_ON_EDGE), so a draft sale to number is created as the edge would.
 */
async function asEdgeProcess<T>(run: () => Promise<T>): Promise<T> {
  const previous = getEdgeRuntimeState();
  setEdgeRuntimeStateForTests({ ...previous, edgeMode: true });
  try {
    return await run();
  } finally {
    setEdgeRuntimeStateForTests(previous);
  }
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

/** The cloud's record that it refused this edge order (no cloud order for it). */
async function markRefused(
  outletId: string,
  orderUlid: string,
  reason: string,
  state = "refused",
) {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO edge_order_ingests (tenant_id, order_id, outlet_id, paid_event_id, state, reason)
       VALUES ($1, $2::uuid, $3, $4::uuid, $5, $6)`,
      [
        tenant.tenantId,
        ulidToUuid(orderUlid),
        outletId,
        ulidToUuid(createUlid()),
        state,
        reason,
      ],
    );
  });
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

/** Cloud orders and their summed totals of the outlet: nothing may be created. */
async function orderFootprint(outletId: string) {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenant.tenantId, outletId],
    );
    return (result.rows[0] as { n: number }).n;
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

/** Skips recorded for this order (edge_receipt_skips). */
async function skipConflicts(
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

/** The summary conflicts of skipped receipts (one per recording event). */
async function skipSummaries(outletId: string): Promise<string[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT detail FROM edge_sync_conflicts
       WHERE tenant_id = $1 AND outlet_id = $2 AND reason = 'receipt_skipped_refused_order'`,
      [tenant.tenantId, outletId],
    );
    return result.rows.map(
      (row: { detail: string | null }) => row.detail ?? "",
    );
  });
}

async function anyConflicts(outletId: string): Promise<number> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS n FROM edge_sync_conflicts WHERE tenant_id = $1 AND outlet_id = $2`,
      [tenant.tenantId, outletId],
    );
    return (result.rows[0] as { n: number }).n;
  });
}

// ---- Event construction -------------------------------------------------------

let clock = Date.parse("2026-11-14T08:00:00.000Z");
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
  return { link, before: from };
}

/**
 * A device with `realCount` merge-ready orders and a provisioned prefix. The
 * refused order is a different, never-ingested ULID (`legacy_payload`).
 */
async function scenario(realCount: number) {
  const outletId = await freshOutlet();
  const device = randomUUID();
  const orders = await deviceOrders(outletId, device, realCount);
  await provision(outletId, device, "OFF1");
  const node = await edgeNodeFor(outletId);
  return { outletId, device, orders, node };
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  setPosReceiptPort(createPosReceiptPort());
  tenant = await createIsolatedTenant(`rskp-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `UPDATE tenants t SET plan = s.plan, deployment_mode = s.deployment_mode, feature_flags = s.feature_flags
       FROM tenants s WHERE s.id = $2 AND t.id = $1`,
    [tenant.tenantId, seededTenantId],
  );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Skip Refused Kasir', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify(["order.view", "pos.sale.create"]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Skip Refused Kasir");
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
       VALUES ($1, $2, $3, 'Skip Refused Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-RSKP', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
});

beforeEach(() => {
  resetEdgeApplierRegistryForTests();
  registerReceiptRunEdgeApplier();
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

// ---- Tests --------------------------------------------------------------------

describe("legend-n1fzg receipt run skips receipts of permanently refused orders", () => {
  it("legend-n1fzg a legacy_payload refused order in the middle is skipped, the other receipts merge, and the next chunk is not held", async () => {
    const { outletId, orders, node, device } = await scenario(3);
    const [o1, o3, o4] = orders;
    const refused = createUlid();
    await markRefused(outletId, refused, "legacy_payload");
    const ordersBefore = await orderFootprint(outletId);

    // Receipt #2 belongs to the refused order.
    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 3,
        receipts: [
          [o1!, 1],
          [refused, 2],
          [o3!, 3],
        ],
      }),
      node,
    );

    const merged = await receiptRows(outletId);
    expect(merged.map((row) => row.order_id).sort()).toEqual(
      [ulidToUuid(o1!), ulidToUuid(o3!)].sort(),
    );
    expect(merged.map((row) => row.order_id)).not.toContain(
      ulidToUuid(refused),
    );
    expect(await lastNumber(outletId)).toBe(3);

    // The next chunk of the device is no longer held by the hole.
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

    // No revenue for the skipped order: no cloud order, no new orders at all.
    expect(await cloudOrderExists(refused)).toBe(false);
    expect(await orderFootprint(outletId)).toBe(ordersBefore);
  });

  it("legend-n1fzg the skip is recorded once with number, order and reason; redelivery and a re-sent run add no second record", async () => {
    const { outletId, orders, node, device } = await scenario(2);
    const [o1, o3] = orders;
    const refused = createUlid();
    await markRefused(outletId, refused, "legacy_payload");
    const run = {
      outletId,
      deviceId: device,
      prefix: "OFF1",
      lastNumber: 3,
      receipts: [
        [o1!, 1],
        [refused, 2],
        [o3!, 3],
      ] as [string, number][],
    };

    const first = runEvent(run);
    await applyEvent(first, node);

    const recorded = await skipConflicts(outletId, refused);
    expect(recorded, "one finance-visible record for the order").toHaveLength(
      1,
    );
    expect(recorded[0]!.receipt_number).toBe("OFF1-000002");
    expect(recorded[0]!.reason).toBe("legacy_payload");

    // Same event delivered again: no new record, no throw.
    await applyEvent(first, node);
    expect(await skipConflicts(outletId, refused)).toHaveLength(1);

    // The reporter retries the run under a new event id (ack lost): still one.
    await applyEvent(runEvent(run), node);
    expect(await skipConflicts(outletId, refused)).toHaveLength(1);

    // Through the link too (the real delivery path), replayed.
    await deliver(node, [first, runEvent(run)]);
    expect(await skipConflicts(outletId, refused)).toHaveLength(1);

    // Receipts stay merged exactly once.
    expect(await receiptRows(outletId)).toHaveLength(2);
    expect(await lastNumber(outletId)).toBe(3);
    // One summary conflict only: the redelivery and the re-sent run add none.
    expect(await skipSummaries(outletId)).toHaveLength(1);
  });

  it("legend-n1fzg review: 12 skips in one chunk are accepted, the next run still merges, and a repeated event adds no skip row or conflict", async () => {
    const { outletId, orders, node, device } = await scenario(2);
    const [o1, o14] = orders;
    const refusedOrders = Array.from({ length: 12 }, () => createUlid());
    for (const refused of refusedOrders)
      await markRefused(outletId, refused, "legacy_payload");
    const receipts: [string, number][] = [
      [o1!, 1],
      ...refusedOrders.map((refused, i): [string, number] => [refused, i + 2]),
    ];
    const first = runEvent({
      outletId,
      deviceId: device,
      prefix: "OFF1",
      lastNumber: 13,
      receipts,
    });
    await applyEvent(first, node);

    expect(await skipRowCount(outletId)).toBe(12);
    expect((await receiptRows(outletId)).map((row) => row.order_id)).toEqual([
      ulidToUuid(o1!),
    ]);
    expect(await lastNumber(outletId)).toBe(13);
    const summaries = await skipSummaries(outletId);
    expect(summaries, "one compact conflict per event").toHaveLength(1);
    expect(summaries[0]).toContain("12");
    expect(summaries[0]!.length).toBeLessThan(200);

    // A later run is still merged: the stored skips are the memory.
    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 14,
        receipts: [[o14!, 14]],
      }),
      node,
    );
    expect(await receiptRows(outletId)).toHaveLength(2);
    expect(await lastNumber(outletId)).toBe(14);

    // Repeating the event, and the same run under a new event id: no growth.
    await applyEvent(first, node);
    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 13,
        receipts,
      }),
      node,
    );
    expect(await skipRowCount(outletId)).toBe(12);
    expect(await skipSummaries(outletId)).toHaveLength(1);
  });

  it("legend-n1fzg an order_exists refusal (order lives in the cloud by another path) is skipped too, and no receipt or revenue is added for it", async () => {
    const { outletId, orders, node, device } = await scenario(2);
    const [o1, o3] = orders;
    // A cloud order (e.g. QR) that the edge also paid: the ingest refused it.
    const cloudOrder = await draftOrder(outletId);
    await markRefused(outletId, cloudOrder, "order_exists");
    const ordersBefore = await orderFootprint(outletId);

    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 3,
        receipts: [
          [o1!, 1],
          [cloudOrder, 2],
          [o3!, 3],
        ],
      }),
      node,
    );

    const merged = (await receiptRows(outletId)).map((row) => row.order_id);
    expect(merged.sort()).toEqual([ulidToUuid(o1!), ulidToUuid(o3!)].sort());
    expect(merged).not.toContain(ulidToUuid(cloudOrder));
    expect(await skipConflicts(outletId, cloudOrder)).toHaveLength(1);
    expect(await orderFootprint(outletId)).toBe(ordersBefore);
  });

  it("legend-n1fzg a run whose only receipt is for a refused order is accepted, merges nothing and still records the skip", async () => {
    const { outletId, node, device } = await scenario(0);
    const refused = createUlid();
    await markRefused(outletId, refused, "legacy_payload");

    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 1,
        receipts: [[refused, 1]],
      }),
      node,
    );

    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await skipConflicts(outletId, refused)).toHaveLength(1);
    expect(await cloudOrderExists(refused)).toBe(false);
  });

  it("legend-n1fzg through the link the run is applied (not an applier_refused), the node is acknowledged, and the later chunk merges", async () => {
    const { outletId, orders, node, device } = await scenario(3);
    const [o1, o3, o4] = orders;
    const refused = createUlid();
    await markRefused(outletId, refused, "legacy_payload");

    const first = runEvent({
      outletId,
      deviceId: device,
      prefix: "OFF1",
      lastNumber: 3,
      receipts: [
        [o1!, 1],
        [refused, 2],
        [o3!, 3],
      ],
    });
    const { link, before } = await deliver(node, [first]);
    expect(await link.lastReceivedInbound()).toBeGreaterThan(before);
    const refusedRows = await asOwnerTenant(tenant.tenantId, async (client) => {
      const result = await client.query(
        `SELECT count(*)::int AS n FROM edge_sync_conflicts
         WHERE tenant_id = $1 AND event_id = $2::uuid AND reason = 'applier_refused'`,
        [tenant.tenantId, ulidToUuid(first.id)],
      );
      return (result.rows[0] as { n: number }).n;
    });
    expect(refusedRows, "the run must not be refused as a whole").toBe(0);
    expect(await receiptRows(outletId)).toHaveLength(2);

    await deliver(node, [
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 4,
        receipts: [[o4!, 4]],
      }),
    ]);
    expect(await receiptRows(outletId)).toHaveLength(3);
    expect(await lastNumber(outletId)).toBe(4);
  });

  it("legend-n1fzg an ingested order and a non-permanent refusal are never skipped", async () => {
    const { outletId, orders, node, device } = await scenario(2);
    const [o1, o2] = orders;
    // o1: ingested normally (state 'ingested'): merges like before.
    await markRefused(outletId, o1!, "", "ingested");
    // A refusal that is not permanent (transient db error) must NOT be skipped.
    const transient = createUlid();
    await markRefused(outletId, transient, "db_error:40001");
    const conflictsBefore = await anyConflicts(outletId);

    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 1,
        receipts: [[o1!, 1]],
      }),
      node,
    );
    expect((await receiptRows(outletId)).map((row) => row.order_id)).toEqual([
      ulidToUuid(o1!),
    ]);
    expect(await anyConflicts(outletId)).toBe(conflictsBefore);

    // The transient one is not silently written off: no receipt, no skip record.
    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 3,
        receipts: [
          [transient, 2],
          [o2!, 3],
        ],
      }),
      node,
    ).catch(() => undefined);
    expect(
      (await receiptRows(outletId)).map((row) => row.order_id),
    ).not.toContain(ulidToUuid(transient));
    expect(await skipConflicts(outletId, transient)).toHaveLength(0);
  });

  it("legend-n1fzg the skip never leaks across tenants: another tenant's refused order of the same id does not skip this tenant's receipt", async () => {
    const { outletId, orders, node, device } = await scenario(1);
    const [o1] = orders;
    // The same order id is refused, but only in ANOTHER tenant's ledger.
    const other = await createIsolatedTenant(
      `rskq-${randomUUID().slice(0, 6)}`,
    );
    const otherOutlet = randomUUID();
    await owner.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Asia/Jakarta', $8, 'active')`,
      [
        otherOutlet,
        other.tenantId,
        other.brandId,
        other.legalEntityId,
        `R${otherOutlet.slice(0, 8)}`.toUpperCase(),
        OUTLET_NAME,
        OUTLET_ADDRESS,
        JSON.stringify(fixtures.outlets[0].openingHours),
      ],
    );
    await asOwnerTenant(other.tenantId, async (client) => {
      await client.query(
        `INSERT INTO edge_order_ingests (tenant_id, order_id, outlet_id, paid_event_id, state, reason)
         VALUES ($1, $2::uuid, $3, $4::uuid, 'refused', 'legacy_payload')`,
        [
          other.tenantId,
          ulidToUuid(o1!),
          otherOutlet,
          ulidToUuid(createUlid()),
        ],
      );
    });

    await applyEvent(
      runEvent({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        lastNumber: 1,
        receipts: [[o1!, 1]],
      }),
      node,
    );
    expect((await receiptRows(outletId)).map((row) => row.order_id)).toEqual([
      ulidToUuid(o1!),
    ]);
    expect(await skipConflicts(outletId, o1!)).toHaveLength(0);
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      other.tenantId,
      randomUUID(),
    ]);
    // uuidToUlid kept for symmetry with other receipt tests' id helpers.
    expect(uuidToUlid(ulidToUuid(o1!))).toBe(o1);
  });
});
