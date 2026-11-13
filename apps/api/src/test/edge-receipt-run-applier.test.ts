// Edge -> cloud receipt-run applier (bead legend-zy43, brief 647 card B).
// An offline edge device's numbered receipt run reaches the cloud as ONE
// edge_to_cloud `receipt_run.reported` event (aggregateType `receipt_run`,
// aggregateId = device id, payload { sequence: {tenantId, outletId, deviceId,
// prefix, lastNumber}, receipts: [{ receipt, outletSnapshot }] }, at most 1000
// receipts); the registered handler validates it and merges the run through
// the receipt service (POS-06: gapless numbers per outlet and device, a void
// keeps its number, offline runs merge without regression).
//
// Real Express app (only to create orders through the public API), Better
// Auth, RLS and PostgreSQL (disposable server from `pnpm test`). The applier
// is reached through the registry dispatcher, exactly as the link does, with a
// real registered edge node per outlet.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/edge-receipt-run-applier.test.ts" heavy pnpm test
//
// Assumptions (spec/brief ambiguous):
//  - Every merge refusal (gap, not provisioned, validation, scope mismatch) is
//    REFUSED, never retried: the apply throws a CoreError (4xx) and writes
//    nothing; through the link that becomes an `applier_refused` conflict and
//    the node is not stalled. The device then resends the full run as a new
//    event. A merge refusal is a CONFLICT or VALIDATION_ERROR CoreError (which
//    of the two depends on the service's HTTP status; asserted as either); a
//    payload that does not parse is exactly VALIDATION_ERROR.
//  - A re-sent run (same or new event id) is a no-op: the merge is idempotent.
//  - Nothing a payload says widens the scope: another tenant, outlet, device
//    or aggregate id than the event's is refused.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CoreError,
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
  RECEIPT_RUN_EVENT_MAX_RECEIPTS,
  RECEIPT_RUN_REPORTED_EVENT,
} from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { resetEdgeApplierRegistryForTests } from "../edge/applier-registry.ts";
import { createDbLinkStore } from "../edge/db-link-store.ts";
import {
  EdgeApplierUnavailableError,
  edgeEventApplier,
  type EdgeApplyMeta,
} from "../edge/ports.ts";
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
  receiptGapsForOutlet,
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
let other: IsolatedTenant;
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

/** One registered edge node per outlet (the applier checks the node's outlet). */
const nodes = new Map<string, Promise<AuthenticatedEdgeNode>>();
function edgeNodeFor(
  tenantId: string,
  outletId: string,
): Promise<AuthenticatedEdgeNode> {
  let node = nodes.get(outletId);
  if (!node) {
    node = (async () => {
      const registered = await registerEdgeNode(
        scopeOf(tenantId, [outletId]),
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

/** An outlet with its own price list: first receipt there is always #1. */
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

/** A draft order through the public API (the receipt FK needs a real order). */
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

/**
 * Merge-ready orders: owned by `deviceId` and completed, no receipt yet. Built
 * from drafts with owner SQL (a final order is immutable).
 */
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

/** The cloud gives the device its prefix first; a merge needs that row. */
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

type ReceiptRow = {
  number: string;
  sequence_number: number;
  device_id: string;
  status: string;
};

async function receiptRows(
  outletId: string,
  tenantId = tenant.tenantId,
): Promise<ReceiptRow[]> {
  return asOwnerTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT number, sequence_number, device_id, status FROM pos_receipts
       WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY number`,
      [tenantId, outletId],
    );
    return result.rows as ReceiptRow[];
  });
}

type SequenceRow = { prefix: string; last_number: number; device_id: string };

async function sequenceRows(
  outletId: string,
  tenantId = tenant.tenantId,
): Promise<SequenceRow[]> {
  return asOwnerTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT prefix, last_number, device_id FROM receipt_sequences
       WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix, device_id`,
      [tenantId, outletId],
    );
    return result.rows as SequenceRow[];
  });
}

async function conflictReasons(eventId: string): Promise<string[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      "SELECT reason FROM edge_sync_conflicts WHERE tenant_id = $1 AND event_id = $2::uuid",
      [tenant.tenantId, ulidToUuid(eventId)],
    );
    return result.rows.map((row: { reason: string }) => row.reason);
  });
}

/** A fresh outlet with its edge node, a device that owns `count` orders. */
async function scenario(
  count: number,
  options: { provisioned?: boolean } = {},
) {
  const outletId = await freshOutlet();
  const device = randomUUID();
  const orders = await deviceOrders(outletId, device, count);
  if (options.provisioned !== false) await provision(outletId, device, "OFF1");
  const node = await edgeNodeFor(tenant.tenantId, outletId);
  return {
    outletId,
    device,
    orders,
    node,
    base: { outletId, deviceId: device, prefix: "OFF1" },
  };
}

// ---- Event construction -------------------------------------------------------

type RunInput = {
  /** Tenant of the event, the sequence head and the receipts. */
  tenantId?: string;
  /** Outlet of the sequence head and the receipts. */
  outletId: string;
  /** Envelope outlet; defaults to `outletId`. */
  envelopeOutletId?: string;
  deviceId: string;
  prefix: string;
  lastNumber: number;
  /** [orderId, ordinal] per receipt. */
  receipts: [string, number][];
  /** Replaces one `{ receipt, outletSnapshot }` entry of the payload. */
  entryOverride?: (entry: Record<string, unknown>) => Record<string, unknown>;
  lastNumberRaw?: unknown;
  aggregateId?: string;
  payloadOverride?: (payload: Record<string, unknown>) => unknown;
};

let clock = Date.parse("2026-11-13T08:00:00.000Z");
const aggregateSequences = new Map<string, number>();

function runEvent(input: RunInput): EventEnvelope {
  clock += 1_000;
  const tenantId = input.tenantId ?? tenant.tenantId;
  const at = new Date(clock).toISOString();
  const entries = input.receipts.map(([orderId, ordinal]) => {
    const entry: Record<string, unknown> = {
      receipt: {
        id: randomUUID(),
        tenantId,
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
    };
    return input.entryOverride ? input.entryOverride(entry) : entry;
  });
  const payload: Record<string, unknown> = {
    sequence: {
      tenantId,
      outletId: input.outletId,
      deviceId: input.deviceId,
      prefix: input.prefix,
      lastNumber:
        input.lastNumberRaw === undefined
          ? input.lastNumber
          : input.lastNumberRaw,
    },
    receipts: entries,
  };
  const sequence = (aggregateSequences.get(input.deviceId) ?? 0) + 1;
  aggregateSequences.set(input.deviceId, sequence);
  return eventEnvelopeSchema.parse({
    id: createUlid(clock),
    tenantId,
    outletId: input.envelopeOutletId ?? input.outletId,
    name: RECEIPT_RUN_REPORTED_EVENT,
    version: 1,
    aggregateType: RECEIPT_RUN_AGGREGATE,
    aggregateId: input.aggregateId ?? input.deviceId,
    sequence,
    occurredAt: at,
    actor: { type: "system" },
    deviceId: null,
    idempotencyKey: `${RECEIPT_RUN_REPORTED_EVENT}:${input.deviceId}:${sequence}`,
    payloadSchemaRef: `${RECEIPT_RUN_REPORTED_EVENT}.v1`,
    payload: input.payloadOverride ? input.payloadOverride(payload) : payload,
  });
}

/** The link's path: the registry dispatcher inside a tenant transaction. */
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

/** The refusal is a 4xx CoreError (never an unknown error that would stall the node). */
async function expectRefused(
  attempt: Promise<unknown>,
  codes?: string[],
): Promise<void> {
  const error = await attempt.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "the event must be refused").toBeInstanceOf(CoreError);
  if (codes) expect(codes).toContain((error as CoreError).code);
}

const MERGE_REFUSAL = ["CONFLICT", "VALIDATION_ERROR"];

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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  setPosReceiptPort(createPosReceiptPort());
  tenant = await createIsolatedTenant(`rrun-${randomUUID().slice(0, 6)}`);
  other = await createIsolatedTenant(`rrub-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  // Edge nodes need the plan/deployment the seeded tenant has.
  for (const t of [tenant, other])
    await owner.query(
      `UPDATE tenants t SET plan = s.plan, deployment_mode = s.deployment_mode, feature_flags = s.feature_flags
         FROM tenants s WHERE s.id = $2 AND t.id = $1`,
      [t.tenantId, seededTenantId],
    );
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Receipt Run Kasir', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify(["order.view", "pos.sale.create"]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Receipt Run Kasir");
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
       VALUES ($1, $2, $3, 'Receipt Run Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-RRUN', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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
  // Receipts and final orders are append-only: the isolated tenants stay in the
  // disposable database; give them a valid creator so the tenant list parses.
  for (const t of [tenant, other])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- Main flow ----------------------------------------------------------------

describe("legend-zy43 edge -> cloud receipt run: main flow", () => {
  it("legend-zy43 a provisioned device run merges into numbered receipts on the cloud and moves the sequence", async () => {
    const { outletId, device, orders, node, base } = await scenario(3);
    const [o1, o2, o3] = orders;

    await applyEvent(
      runEvent({
        ...base,
        lastNumber: 3,
        receipts: [
          [o1!, 1],
          [o2!, 2],
          [o3!, 3],
        ],
      }),
      node,
    );

    expect((await receiptRows(outletId)).map((row) => row.number)).toEqual([
      "OFF1-000001",
      "OFF1-000002",
      "OFF1-000003",
    ]);
    expect(await sequenceRows(outletId)).toMatchObject([
      { prefix: "OFF1", device_id: device, last_number: 3 },
    ]);
    const context = scopeOf(tenant.tenantId);
    const gaps = await withTenant(db, context, (tx) =>
      receiptGapsForOutlet(
        tx as Parameters<typeof receiptGapsForOutlet>[0],
        context,
        outletId,
      ),
    );
    for (const gap of gaps) expect(gap.missing).toEqual([]);
  });

  it("legend-zy43 a later run of the same device moves the sequence forward", async () => {
    const { outletId, orders, node, base } = await scenario(3);
    const [o1, o2, o3] = orders;
    await applyEvent(
      runEvent({
        ...base,
        lastNumber: 2,
        receipts: [
          [o1!, 1],
          [o2!, 2],
        ],
      }),
      node,
    );
    await applyEvent(
      runEvent({ ...base, lastNumber: 3, receipts: [[o3!, 3]] }),
      node,
    );
    expect(await receiptRows(outletId)).toHaveLength(3);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 3 }]);
  });

  it("legend-zy43 two devices of one outlet keep independent sequences", async () => {
    const outletId = await freshOutlet();
    const deviceX = randomUUID();
    const deviceY = randomUUID();
    const [x1] = await deviceOrders(outletId, deviceX, 1);
    const [y1, y2] = await deviceOrders(outletId, deviceY, 2);
    await provision(outletId, deviceX, "OFX");
    await provision(outletId, deviceY, "OFY");
    const node = await edgeNodeFor(tenant.tenantId, outletId);

    await applyEvent(
      runEvent({
        outletId,
        deviceId: deviceX,
        prefix: "OFX",
        lastNumber: 1,
        receipts: [[x1!, 1]],
      }),
      node,
    );
    await applyEvent(
      runEvent({
        outletId,
        deviceId: deviceY,
        prefix: "OFY",
        lastNumber: 2,
        receipts: [
          [y1!, 1],
          [y2!, 2],
        ],
      }),
      node,
    );
    const sequences = await sequenceRows(outletId);
    expect(sequences.find((s) => s.device_id === deviceX)?.last_number).toBe(1);
    expect(sequences.find((s) => s.device_id === deviceY)?.last_number).toBe(2);
    expect((await receiptRows(outletId)).map((row) => row.number)).toEqual([
      "OFX-000001",
      "OFY-000001",
      "OFY-000002",
    ]);
  });
});

// ---- Replay idempotency --------------------------------------------------------

describe("legend-zy43 edge -> cloud receipt run: replay idempotency", () => {
  it("legend-zy43 delivering the same event twice writes nothing the second time and does not throw", async () => {
    const { outletId, orders, node, base } = await scenario(2);
    const [o1, o2] = orders;
    const event = runEvent({
      ...base,
      lastNumber: 2,
      receipts: [
        [o1!, 1],
        [o2!, 2],
      ],
    });

    await applyEvent(event, node);
    const receiptsBefore = await receiptRows(outletId);
    const sequenceBefore = await sequenceRows(outletId);
    await applyEvent(event, node);
    await applyEvent(event, node);

    expect(await receiptRows(outletId)).toEqual(receiptsBefore);
    expect(await sequenceRows(outletId)).toEqual(sequenceBefore);
    expect(receiptsBefore).toHaveLength(2);
  });

  it("legend-zy43 a stale replay of an earlier run after a later one is a no-op and the sequence stays put", async () => {
    const { outletId, orders, node, base } = await scenario(4);
    const [o1, o2, o3, o4] = orders;
    const first = runEvent({
      ...base,
      lastNumber: 2,
      receipts: [
        [o1!, 1],
        [o2!, 2],
      ],
    });
    const second = runEvent({
      ...base,
      lastNumber: 4,
      receipts: [
        [o3!, 3],
        [o4!, 4],
      ],
    });
    await applyEvent(first, node);
    await applyEvent(second, node);
    const before = await receiptRows(outletId);

    await applyEvent(first, node);

    expect(await receiptRows(outletId)).toEqual(before);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 4 }]);
  });

  it("legend-zy43 a re-sent run with a different event id (retry after an ack was lost) is also a no-op", async () => {
    const { outletId, orders, node, base } = await scenario(2);
    const [o1, o2] = orders;
    const run = {
      ...base,
      lastNumber: 2,
      receipts: [
        [o1!, 1],
        [o2!, 2],
      ] as [string, number][],
    };
    await applyEvent(runEvent(run), node);
    const before = await receiptRows(outletId);
    await applyEvent(runEvent(run), node);
    expect(await receiptRows(outletId)).toEqual(before);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 2 }]);
  });
});

// ---- Gap: refused, never retried -------------------------------------------------

describe("legend-zy43 edge -> cloud receipt run: sequence gap", () => {
  it("legend-zy43 a run that skips ahead is refused as a 4xx conflict and writes nothing; the device then resends the full run", async () => {
    const { outletId, orders, node, base } = await scenario(3);
    const [o1, o2, o3] = orders;
    // Only #3 arrives (lastNumber 3): numbers 1 and 2 are missing.
    await expectRefused(
      applyEvent(
        runEvent({ ...base, lastNumber: 3, receipts: [[o3!, 3]] }),
        node,
      ),
      MERGE_REFUSAL,
    );
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);

    // The refusal is final for that event; the full run is a new event.
    await applyEvent(
      runEvent({
        ...base,
        lastNumber: 3,
        receipts: [
          [o1!, 1],
          [o2!, 2],
          [o3!, 3],
        ],
      }),
      node,
    );
    expect((await receiptRows(outletId)).map((row) => row.number)).toEqual([
      "OFF1-000001",
      "OFF1-000002",
      "OFF1-000003",
    ]);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 3 }]);
  });

  it("legend-zy43 a last number beyond the receipts sent is refused and the cloud sequence stays put", async () => {
    const { outletId, orders, node, base } = await scenario(3);
    const [o1, o2, o3] = orders;
    await applyEvent(
      runEvent({
        ...base,
        lastNumber: 2,
        receipts: [
          [o1!, 1],
          [o2!, 2],
        ],
      }),
      node,
    );

    await expectRefused(
      applyEvent(
        runEvent({ ...base, lastNumber: 5, receipts: [[o3!, 3]] }),
        node,
      ),
      MERGE_REFUSAL,
    );
    expect(await receiptRows(outletId)).toHaveLength(2);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 2 }]);
  });

  it("legend-zy43 through the link a gap becomes a reviewable applier_refused conflict, the node is not stalled, and the full run then applies", async () => {
    const { outletId, orders, node, base } = await scenario(3);
    const [o1, o2, o3] = orders;
    const gap = runEvent({ ...base, lastNumber: 3, receipts: [[o3!, 3]] });

    const { link, before } = await deliver(node, [gap]);
    expect(await conflictReasons(gap.id)).toEqual(["applier_refused"]);
    // The batch was acknowledged (not retried forever).
    expect(await link.lastReceivedInbound()).toBeGreaterThan(before);
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);

    await deliver(node, [
      runEvent({
        ...base,
        lastNumber: 3,
        receipts: [
          [o1!, 1],
          [o2!, 2],
          [o3!, 3],
        ],
      }),
    ]);
    expect(await receiptRows(outletId)).toHaveLength(3);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 3 }]);
  });
});

// ---- Not provisioned -----------------------------------------------------------

describe("legend-zy43 edge -> cloud receipt run: device not provisioned", () => {
  it("legend-zy43 a run from a device the cloud never gave a prefix is refused as a 4xx conflict and writes nothing; once provisioned a resent run applies", async () => {
    const { outletId, device, orders, node, base } = await scenario(1, {
      provisioned: false,
    });
    const [o1] = orders;
    const run = {
      ...base,
      lastNumber: 1,
      receipts: [[o1!, 1]] as [string, number][],
    };

    await expectRefused(applyEvent(runEvent(run), node), MERGE_REFUSAL);
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toHaveLength(0);

    await provision(outletId, device, "OFF1");
    await applyEvent(runEvent(run), node);
    expect(await receiptRows(outletId)).toHaveLength(1);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 1 }]);
  });

  it("legend-zy43 through the link a not-provisioned run is recorded as an applier_refused conflict", async () => {
    const { outletId, orders, node, base } = await scenario(1, {
      provisioned: false,
    });
    const event = runEvent({
      ...base,
      lastNumber: 1,
      receipts: [[orders[0]!, 1]],
    });
    const { link, before } = await deliver(node, [event]);
    expect(await conflictReasons(event.id)).toEqual(["applier_refused"]);
    expect(await link.lastReceivedInbound()).toBeGreaterThan(before);
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toHaveLength(0);
  });
});

// ---- Invalid payload -----------------------------------------------------------

describe("legend-zy43 edge -> cloud receipt run: invalid payload", () => {
  it("legend-zy43 a lastNumber outside 0..999999999 or not an integer is refused with VALIDATION_ERROR before any write", async () => {
    const { outletId, orders, node, base } = await scenario(1);
    for (const lastNumberRaw of [-1, 1.5, 1_000_000_000, 1e12, "1", null])
      await expectRefused(
        applyEvent(
          runEvent({
            ...base,
            lastNumber: 1,
            lastNumberRaw,
            receipts: [[orders[0]!, 1]],
          }),
          node,
        ),
        ["VALIDATION_ERROR"],
      );
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);
  });

  it("legend-zy43 a receipt without outletSnapshot, or with a malformed one, is refused with VALIDATION_ERROR before any write", async () => {
    const { outletId, orders, node, base } = await scenario(2);
    const [o1, o2] = orders;

    const missing = runEvent({
      ...base,
      lastNumber: 1,
      receipts: [[o1!, 1]],
      entryOverride: (entry) => {
        const rest = { ...entry };
        delete rest.outletSnapshot;
        return rest;
      },
    });
    const malformed = runEvent({
      ...base,
      lastNumber: 1,
      receipts: [[o1!, 1]],
      entryOverride: (entry) => ({
        ...entry,
        outletSnapshot: { outletName: "", outletAddress: 7 },
      }),
    });
    // The second receipt of a run lacks it: the whole run is refused, nothing
    // of the first receipt is kept.
    const secondMissing = runEvent({
      ...base,
      lastNumber: 2,
      receipts: [
        [o1!, 1],
        [o2!, 2],
      ],
      entryOverride: (entry) => {
        const receipt = entry.receipt as { sequenceNumber: number };
        if (receipt.sequenceNumber !== 2) return entry;
        const rest = { ...entry };
        delete rest.outletSnapshot;
        return rest;
      },
    });
    for (const event of [missing, malformed, secondMissing])
      await expectRefused(applyEvent(event, node), ["VALIDATION_ERROR"]);
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);
  });

  it("legend-zy43 a payload that is not a receipt run at all is refused with VALIDATION_ERROR", async () => {
    const { outletId, node, base } = await scenario(0);
    const garbage = runEvent({
      ...base,
      lastNumber: 0,
      receipts: [],
      payloadOverride: () => ({ hello: "world" }),
    });
    await expectRefused(applyEvent(garbage, node), ["VALIDATION_ERROR"]);
    expect(await receiptRows(outletId)).toHaveLength(0);
  });

  it("legend-zy43 a run of more than the maximum receipts per event is refused with VALIDATION_ERROR", async () => {
    const { outletId, node, base } = await scenario(0);
    const count = RECEIPT_RUN_EVENT_MAX_RECEIPTS + 1;
    const receipts = Array.from(
      { length: count },
      (_, index): [string, number] => [uuidToUlid(randomUUID()), index + 1],
    );
    await expectRefused(
      applyEvent(runEvent({ ...base, lastNumber: count, receipts }), node),
      ["VALIDATION_ERROR"],
    );
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);
  });
});

// ---- Cross-tenant and scope isolation ------------------------------------------

describe("legend-zy43 edge -> cloud receipt run: tenant and scope isolation", () => {
  it("legend-zy43 an event of another tenant applied in this tenant's context is refused and writes nothing", async () => {
    const { outletId, orders, node, base } = await scenario(1);
    const foreign = runEvent({
      ...base,
      tenantId: other.tenantId,
      lastNumber: 1,
      receipts: [[orders[0]!, 1]],
    });

    await expectRefused(applyEvent(foreign, node));
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);
  });

  it("legend-zy43 an event of this tenant applied in another tenant's context is refused and writes nothing", async () => {
    const { outletId, orders, base } = await scenario(1);
    const mine = runEvent({
      ...base,
      lastNumber: 1,
      receipts: [[orders[0]!, 1]],
    });
    const otherNode = await edgeNodeFor(other.tenantId, other.outletId);

    await expectRefused(applyEvent(mine, otherNode));
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);
  });

  it("legend-zy43 a tenant cannot reach another tenant's outlet, device sequence or orders by naming their ids in its own run", async () => {
    const { outletId, device, orders } = await scenario(1);
    const otherNode = await edgeNodeFor(other.tenantId, other.outletId);
    // Tenant B's own correctly-scoped event and node, but it names tenant A's
    // outlet, device and order.
    const crossing = runEvent({
      tenantId: other.tenantId,
      outletId,
      deviceId: device,
      prefix: "OFF1",
      lastNumber: 1,
      receipts: [[orders[0]!, 1]],
    });

    await expectRefused(applyEvent(crossing, otherNode));
    for (const [t, o] of [
      [tenant.tenantId, outletId],
      [other.tenantId, outletId],
      [other.tenantId, other.outletId],
    ] as const)
      expect(await receiptRows(o, t)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);
    expect(await sequenceRows(other.outletId, other.tenantId)).toHaveLength(0);
  });

  it("legend-zy43 an envelope whose outlet differs from the run's outlet is refused and writes nothing", async () => {
    const { outletId, orders, base } = await scenario(1);
    const elsewhere = await freshOutlet();
    const elsewhereNode = await edgeNodeFor(tenant.tenantId, elsewhere);

    // The envelope outlet is the node's own, but the run names another outlet.
    await expectRefused(
      applyEvent(
        runEvent({
          ...base,
          envelopeOutletId: elsewhere,
          lastNumber: 1,
          receipts: [[orders[0]!, 1]],
        }),
        elsewhereNode,
      ),
    );
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await receiptRows(elsewhere)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);
  });

  it("legend-zy43 an event of an outlet other than the edge node's own is refused", async () => {
    const { outletId, orders, base } = await scenario(1);
    const elsewhere = await freshOutlet();
    const elsewhereNode = await edgeNodeFor(tenant.tenantId, elsewhere);
    await expectRefused(
      applyEvent(
        runEvent({ ...base, lastNumber: 1, receipts: [[orders[0]!, 1]] }),
        elsewhereNode,
      ),
    );
    expect(await receiptRows(outletId)).toHaveLength(0);
  });

  it("legend-zy43 a run whose receipts or aggregate id name another device than the sequence is refused and writes nothing", async () => {
    const { outletId, orders, node, base } = await scenario(1);
    const stranger = randomUUID();
    const run = {
      ...base,
      lastNumber: 1,
      receipts: [[orders[0]!, 1]] as [string, number][],
    };

    await expectRefused(
      applyEvent(runEvent({ ...run, aggregateId: stranger }), node),
    );
    await expectRefused(
      applyEvent(
        runEvent({
          ...run,
          entryOverride: (entry) => ({
            ...entry,
            receipt: {
              ...(entry.receipt as Record<string, unknown>),
              deviceId: stranger,
            },
          }),
        }),
        node,
      ),
    );
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toMatchObject([{ last_number: 0 }]);
  });
});

// ---- Registration --------------------------------------------------------------

describe("legend-zy43 edge -> cloud receipt run: registration", () => {
  it("legend-zy43 registering twice keeps one dispatcher; other event types stay refused", async () => {
    registerReceiptRunEdgeApplier();
    const dispatcher = edgeEventApplier("edge_to_cloud");
    registerReceiptRunEdgeApplier();
    expect(edgeEventApplier("edge_to_cloud")).toBe(dispatcher);

    clock += 1_000;
    const unknown = eventEnvelopeSchema.parse({
      id: createUlid(clock),
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      name: "order.item_added",
      version: 1,
      aggregateType: "order",
      aggregateId: randomUUID(),
      sequence: 1,
      occurredAt: new Date(clock).toISOString(),
      actor: { type: "system" },
      deviceId: null,
      idempotencyKey: `rrun-unknown-${clock}`,
      payloadSchemaRef: "order.item_added.v1",
      payload: {},
    });
    const node = await edgeNodeFor(tenant.tenantId, tenant.outletId);
    await expect(applyEvent(unknown, node)).rejects.toBeInstanceOf(
      EdgeApplierUnavailableError,
    );
  });

  it("legend-zy43 the receipt run is not applied in the cloud -> edge direction", async () => {
    const node = await edgeNodeFor(tenant.tenantId, tenant.outletId);
    const event = runEvent({
      outletId: tenant.outletId,
      deviceId: randomUUID(),
      prefix: "OFF1",
      lastNumber: 0,
      receipts: [],
    });
    await expect(
      withTenant(db, node.context, (tx) =>
        edgeEventApplier("cloud_to_edge").apply(tx, event, {
          edgeNodeId: node.scope.edgeNodeId,
          direction: "cloud_to_edge",
          kind: "transaction_event",
          context: node.context,
        }),
      ),
    ).rejects.toBeInstanceOf(EdgeApplierUnavailableError);
  });
});
