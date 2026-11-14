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
// Producer (second half of the file): the edge reporter
// (services/edge-receipt-run-reporter.ts) turns the receipts an edge database
// numbered into `receipt_run.reported` outbox events, and the cloud merges
// them exactly once.
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
import { readFileSync } from "node:fs";
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
import {
  posDeferredAggregates,
  registerPosDeferredEdgeApplier,
} from "../edge/deferred-event-applier.ts";
import { registerReceiptRunEdgeApplier } from "../edge/receipt-run-applier.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { reportEdgeReceiptRuns } from "../services/edge-receipt-run-reporter.ts";
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

// ---- Producer: edge reporter ---------------------------------------------------

const EDGE_INSTANCE = randomUUID();

/**
 * Where an order event is in the edge pipeline (domain_event_outbox ->
 * edge_outbound_queue -> cloud ack). Only `acked` means the cloud applied it.
 */
type Delivery = "acked" | "queued" | "outbox" | "none";

type OrderEventName = "order.paid" | "order.voided";

async function putOrderEvent(
  run: { outletId: string; node: AuthenticatedEdgeNode },
  orderId: string,
  name: OrderEventName,
  delivery: Delivery,
): Promise<void> {
  if (delivery === "none") return;
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const eventId = ulidToUuid(createUlid());
    const aggregateId = ulidToUuid(orderId);
    const aggregateSequence = name === "order.paid" ? 1 : 2;
    // The table's check ties the stored event to its row columns.
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
       VALUES ($1, $2, $3, $4, 'order', $5, $6, $7::jsonb, 'cloud-sync', $8::varchar,
               CASE WHEN $8::text = 'delivered' THEN now() END)`,
      [
        tenant.tenantId,
        randomUUID(),
        run.outletId,
        eventId,
        aggregateId,
        aggregateSequence,
        stored,
        delivery === "outbox" ? "pending" : "delivered",
      ],
    );
    if (delivery === "outbox") return;
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

/** The cloud acknowledges a queued order event (link ack). */
async function ackOrderEvent(
  orderId: string,
  name: OrderEventName,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE edge_outbound_queue SET status = 'acked', acked_at = now()
        WHERE tenant_id = $1 AND event_id IN (
          SELECT event_id FROM domain_event_outbox
           WHERE tenant_id = $1 AND aggregate_id = $2::uuid AND event ->> 'name' = $3)`,
      [tenant.tenantId, ulidToUuid(orderId), name],
    );
    await client.query(
      `UPDATE domain_event_outbox SET status = 'delivered', delivered_at = now()
        WHERE tenant_id = $1 AND aggregate_id = $2::uuid AND event ->> 'name' = $3`,
      [tenant.tenantId, ulidToUuid(orderId), name],
    );
  });
}

/**
 * legend-btx4d: the queued order event was oversized and moved to the
 * dead-letter store: its queue row is gone, the cloud never held it.
 */
async function deadLetterOrderEvent(
  orderId: string,
  name: OrderEventName,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const moved = await client.query(
      `DELETE FROM edge_outbound_queue WHERE tenant_id = $1 AND status = 'pending' AND event_id IN (
         SELECT event_id FROM domain_event_outbox
          WHERE tenant_id = $1 AND aggregate_id = $2::uuid AND event ->> 'name' = $3)
       RETURNING outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, event`,
      [tenant.tenantId, ulidToUuid(orderId), name],
    );
    expect(moved.rows).toHaveLength(1);
    const row = moved.rows[0];
    await client.query(
      `INSERT INTO edge_link_dead_letters (tenant_id, outlet_id, edge_node_id, direction, event_id, link_seq, aggregate_type, aggregate_id, aggregate_sequence, bytes, reason, event)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 5000000, 'frame_too_large', $10::jsonb)`,
      [
        tenant.tenantId,
        row.outlet_id,
        row.edge_node_id,
        row.direction,
        row.event_id,
        row.link_seq,
        row.aggregate_type,
        row.aggregate_id,
        row.aggregate_sequence,
        JSON.stringify(row.event),
      ],
    );
  });
}

/**
 * An edge database's device run: bound to the node and instance the reporter
 * is given, `orders` already numbered locally from 1 under `prefix`. Written
 * with owner SQL (triggers off, the way a restored edge state looks).
 */
async function bindEdgeRun(
  run: { outletId: string; device: string; node: AuthenticatedEdgeNode },
  prefix: string,
  orders: string[],
  options: { bound?: boolean; delivery?: Delivery[] } = {},
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    const existing = await client.query(
      "SELECT id FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3 AND prefix = $4",
      [tenant.tenantId, run.outletId, run.device, prefix],
    );
    let sequenceId: string;
    if (existing.rows.length > 0) {
      sequenceId = existing.rows[0].id;
      await client.query(
        `UPDATE receipt_sequences SET last_number = $2, edge_node_id = $3, edge_instance_id = $4 WHERE id = $1`,
        options.bound === false
          ? [sequenceId, orders.length, null, null]
          : [
              sequenceId,
              orders.length,
              run.node.scope.edgeNodeId,
              EDGE_INSTANCE,
            ],
      );
    } else {
      const created = await client.query(
        `INSERT INTO receipt_sequences (tenant_id, outlet_id, device_id, prefix, last_number, edge_node_id, edge_instance_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          tenant.tenantId,
          run.outletId,
          run.device,
          prefix,
          orders.length,
          options.bound === false ? null : run.node.scope.edgeNodeId,
          options.bound === false ? null : EDGE_INSTANCE,
        ],
      );
      sequenceId = created.rows[0].id;
    }
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
          formatReceiptNumber(prefix, index + 1),
          index + 1,
          JSON.stringify(SNAPSHOT),
        ],
      );
  });
  for (const [index, orderId] of orders.entries())
    await putOrderEvent(
      run,
      orderId,
      "order.paid",
      options.delivery?.[index] ?? "acked",
    );
}

/** A fresh outlet whose device run OFF1 has `count` numbered receipts. */
async function edgeRun(
  count: number,
  options: { bound?: boolean; delivery?: Delivery[] } = {},
) {
  const run = await scenario(count);
  await bindEdgeRun(run, "OFF1", run.orders, options);
  return run;
}

type EdgeRun = Awaited<ReturnType<typeof edgeRun>>;

function report(
  run: EdgeRun,
  instanceId = EDGE_INSTANCE,
  limits?: Parameters<typeof reportEdgeReceiptRuns>[2],
) {
  return reportEdgeReceiptRuns(
    scopeOf(tenant.tenantId, [run.outletId]),
    {
      outletId: run.outletId,
      edgeNodeId: run.node.scope.edgeNodeId,
      edgeInstanceId: instanceId,
    },
    limits,
  );
}

async function reportedEvents(deviceId: string): Promise<EventEnvelope[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT event FROM domain_event_outbox
        WHERE tenant_id = $1 AND destination = 'cloud-sync' AND aggregate_type = $2 AND aggregate_id = $3::uuid
        ORDER BY sequence`,
      [tenant.tenantId, RECEIPT_RUN_AGGREGATE, deviceId],
    );
    return result.rows.map((row: { event: unknown }) =>
      eventEnvelopeSchema.parse(row.event),
    );
  });
}

type RunPayload = {
  sequence: { prefix: string; lastNumber: number };
  receipts: { receipt: { sequenceNumber: number; status: string } }[];
};

/** `[prefix, lastNumber, [ordinal:status...]]` per event, for compact asserts. */
function shapesOf(events: EventEnvelope[]) {
  return events.map((event) => {
    const payload = event.payload as RunPayload;
    return [
      payload.sequence.prefix,
      payload.sequence.lastNumber,
      payload.receipts.map(
        (entry) =>
          `${entry.receipt.sequenceNumber}${entry.receipt.status === "voided" ? "v" : ""}`,
      ),
    ];
  });
}

async function addEdgeReceipt(
  run: EdgeRun,
  ordinal: number,
  delivery: Delivery = "acked",
): Promise<string> {
  const [orderId] = await deviceOrders(run.outletId, run.device, 1);
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE receipt_sequences SET last_number = $4
        WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3 AND prefix = 'OFF1'`,
      [tenant.tenantId, run.outletId, run.device, ordinal],
    );
    const seq = await client.query(
      "SELECT id FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3 AND prefix = 'OFF1'",
      [tenant.tenantId, run.outletId, run.device],
    );
    await client.query(
      `INSERT INTO pos_receipts
         (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, 'issued', now(), $8::jsonb)`,
      [
        tenant.tenantId,
        run.outletId,
        ulidToUuid(orderId!),
        seq.rows[0].id,
        run.device,
        formatReceiptNumber("OFF1", ordinal),
        ordinal,
        JSON.stringify(SNAPSHOT),
      ],
    );
  });
  await putOrderEvent(run, orderId!, "order.paid", delivery);
  return orderId!;
}

async function voidEdgeReceipt(
  run: EdgeRun,
  ordinal: number,
  delivery: Delivery = "acked",
  prefix = "OFF1",
): Promise<void> {
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
        formatReceiptNumber(prefix, ordinal),
      ],
    );
    return uuidToUlid(result.rows[0].order_id as string);
  });
  await putOrderEvent(run, orderId, "order.voided", delivery);
}

/** What the cloud would look like before the report arrives: no receipt rows. */
async function resetToCloudState(run: EdgeRun): Promise<void> {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM pos_receipts WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.tenantId, run.outletId],
    );
    await client.query(
      `UPDATE receipt_sequences SET last_number = 0, edge_node_id = NULL, edge_instance_id = NULL
        WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3`,
      [tenant.tenantId, run.outletId, run.device],
    );
  });
}

describe("legend-zy43 edge receipt run producer", () => {
  it("legend-zy43 reports the local run as one valid receipt_run.reported outbox event", async () => {
    const run = await edgeRun(3);
    expect(await report(run)).toEqual({ reported: 1 });
    const events = await reportedEvents(run.device);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event!.name).toBe(RECEIPT_RUN_REPORTED_EVENT);
    expect(event!.aggregateId.toLowerCase()).toBe(run.device);
    expect(event!.sequence).toBe(1);
    expect(event!.outletId).toBe(run.outletId);
    expect(shapesOf(events)).toEqual([["OFF1", 3, ["1", "2", "3"]]]);
  });

  it("legend-zy43 sends only what is new: the next chunk after a new receipt, one event per void", async () => {
    const run = await edgeRun(2);
    expect(await report(run)).toEqual({ reported: 1 });
    expect(await report(run)).toEqual({ reported: 0 });

    await addEdgeReceipt(run, 3);
    expect(await report(run)).toEqual({ reported: 1 });
    expect(await report(run)).toEqual({ reported: 0 });

    await voidEdgeReceipt(run, 2);
    expect(await report(run)).toEqual({ reported: 1 });
    expect(await report(run)).toEqual({ reported: 0 });
    const events = await reportedEvents(run.device);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(3);
    expect(shapesOf(events)).toEqual([
      ["OFF1", 2, ["1", "2"]],
      ["OFF1", 3, ["3"]],
      ["OFF1", 3, ["2v"]],
    ]);
  });

  it("legend-zy43 a backlog goes out in bounded ascending chunks, a few per pass, and merges exactly once", async () => {
    const run = await edgeRun(5);
    const limits = { chunk: 2, maxChunks: 2 };
    expect(await report(run, EDGE_INSTANCE, limits)).toEqual({ reported: 2 });
    expect(await report(run, EDGE_INSTANCE, limits)).toEqual({ reported: 1 });
    expect(await report(run, EDGE_INSTANCE, limits)).toEqual({ reported: 0 });
    const events = await reportedEvents(run.device);
    expect(shapesOf(events)).toEqual([
      ["OFF1", 2, ["1", "2"]],
      ["OFF1", 4, ["3", "4"]],
      ["OFF1", 5, ["5"]],
    ]);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);

    await resetToCloudState(run);
    for (const event of events) await applyEvent(event, run.node);
    const merged = await receiptRows(run.outletId);
    expect(merged.map((row) => row.number)).toEqual([
      "OFF1-000001",
      "OFF1-000002",
      "OFF1-000003",
      "OFF1-000004",
      "OFF1-000005",
    ]);
    expect(
      (await sequenceRows(run.outletId)).find((s) => s.prefix === "OFF1")
        ?.last_number,
    ).toBe(5);
    // Redelivery of every chunk: nothing changes.
    for (const event of events) await applyEvent(event, run.node);
    expect(await receiptRows(run.outletId)).toEqual(merged);
  });

  it("legend-zy43 a chunk event stays far below the link frame cap", async () => {
    const run = await edgeRun(3);
    await report(run);
    const [event] = await reportedEvents(run.device);
    // 100 receipts per chunk at this size is about 55 KB, nowhere near 4 MB.
    const perReceipt = Buffer.byteLength(JSON.stringify(event)) / 3;
    expect(perReceipt * 100).toBeLessThan(1024 * 1024);
  });

  it("legend-zy43 reports nothing for an empty run, a run bound elsewhere, or the cloud-owned sequence", async () => {
    const empty = await scenario(0);
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE receipt_sequences SET edge_node_id = $4, edge_instance_id = $5
          WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3`,
        [
          tenant.tenantId,
          empty.outletId,
          empty.device,
          empty.node.scope.edgeNodeId,
          EDGE_INSTANCE,
        ],
      );
    });
    expect(await report(empty)).toEqual({ reported: 0 });
    expect(await reportedEvents(empty.device)).toHaveLength(0);

    const unbound = await edgeRun(2, { bound: false });
    expect(await report(unbound)).toEqual({ reported: 0 });
    // Same node, another database instance: not this edge's run.
    const bound = await edgeRun(2);
    expect(await report(bound, randomUUID())).toEqual({ reported: 0 });
    expect(await reportedEvents(bound.device)).toHaveLength(0);

    // The cloud-owned run (device id = outlet id) is never reported.
    const cloudOwned = await scenario(1);
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      const seq = await client.query(
        `INSERT INTO receipt_sequences (tenant_id, outlet_id, device_id, prefix, last_number, edge_node_id, edge_instance_id)
         VALUES ($1, $2, $2, 'C', 1, $3, $4) RETURNING id`,
        [
          tenant.tenantId,
          cloudOwned.outletId,
          cloudOwned.node.scope.edgeNodeId,
          EDGE_INSTANCE,
        ],
      );
      await client.query(
        `INSERT INTO pos_receipts
           (tenant_id, outlet_id, order_id, sequence_id, device_id, number, sequence_number, status, issued_at, outlet_snapshot)
         VALUES ($1, $2, $3::uuid, $4, $2, 'C-000001', 1, 'issued', now(), $5::jsonb)`,
        [
          tenant.tenantId,
          cloudOwned.outletId,
          ulidToUuid(cloudOwned.orders[0]!),
          seq.rows[0].id,
          JSON.stringify(SNAPSHOT),
        ],
      );
    });
    expect(await report(cloudOwned)).toEqual({ reported: 0 });
    expect(await reportedEvents(cloudOwned.outletId)).toHaveLength(0);
  });

  it("legend-zy43 an edge report merges into the cloud exactly once, replay and re-report safe", async () => {
    const run = await edgeRun(3);
    await report(run);
    const [event] = await reportedEvents(run.device);
    await resetToCloudState(run);
    expect(await receiptRows(run.outletId)).toHaveLength(0);

    await applyEvent(event!, run.node);
    const first = await receiptRows(run.outletId);
    expect(first.map((row) => row.number)).toEqual([
      "OFF1-000001",
      "OFF1-000002",
      "OFF1-000003",
    ]);
    const idsOf = () =>
      asOwnerTenant(tenant.tenantId, async (pg) => {
        const result = await pg.query(
          "SELECT id FROM pos_receipts WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY number",
          [tenant.tenantId, run.outletId],
        );
        return result.rows.map((row: { id: string }) => row.id);
      });
    const idsAfterFirst = await idsOf();
    expect(
      (await sequenceRows(run.outletId)).find((s) => s.prefix === "OFF1")
        ?.last_number,
    ).toBe(3);

    // Redelivery of the same event: nothing new, same rows.
    await applyEvent(event!, run.node);
    expect(await receiptRows(run.outletId)).toEqual(first);
    // Reporting again produces no second event, so nothing more to merge.
    expect(await report(run)).toEqual({ reported: 0 });
    expect(await reportedEvents(run.device)).toHaveLength(1);
    expect(await idsOf()).toEqual(idsAfterFirst);
  });

  // legend-zy43 review round 2, F1: state is per PREFIX, not per device.
  it("legend-zy43 a new run of the same device (new prefix) is reported from its own start, keys never collide with the old prefix", async () => {
    const run = await edgeRun(3);
    expect(await report(run)).toEqual({ reported: 1 });
    // The first run is retired; the device now numbers under OFF2 (also a
    // restore of the edge database under a new instance would look like this).
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE receipt_sequences SET retired_at = now(), retired_reason = 'edge_replaced'
          WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $3 AND prefix = 'OFF1'`,
        [tenant.tenantId, run.outletId, run.device],
      );
    });
    const second = await deviceOrders(run.outletId, run.device, 2);
    await bindEdgeRun(run, "OFF2", second);
    expect(await report(run)).toEqual({ reported: 1 });
    await voidEdgeReceipt(run, 2, "acked", "OFF2");
    expect(await report(run)).toEqual({ reported: 1 });
    const events = await reportedEvents(run.device);
    expect(shapesOf(events)).toEqual([
      ["OFF1", 3, ["1", "2", "3"]],
      ["OFF2", 2, ["1", "2"]],
      ["OFF2", 2, ["2v"]],
    ]);
    expect(new Set(events.map((e) => e.idempotencyKey)).size).toBe(3);
    // Nothing is resent for either prefix.
    expect(await report(run)).toEqual({ reported: 0 });
  });

  // legend-zy43 review round 2, F2: outbox order is not link order; a receipt
  // goes out only after the cloud ACKed the order event it depends on.
  it("legend-zy43 a chunk ends before the first receipt whose order.paid is not yet acked, and resumes after the ack", async () => {
    const run = await edgeRun(4, {
      delivery: ["acked", "queued", "acked", "none"],
    });
    expect(await report(run)).toEqual({ reported: 1 });
    expect(shapesOf(await reportedEvents(run.device))).toEqual([
      ["OFF1", 1, ["1"]],
    ]);
    // Nothing more while receipt 2's order.paid is only queued.
    expect(await report(run)).toEqual({ reported: 0 });
    await ackOrderEvent(run.orders[1]!, "order.paid");
    expect(await report(run)).toEqual({ reported: 1 });
    expect(shapesOf(await reportedEvents(run.device)).at(-1)).toEqual([
      "OFF1",
      3,
      ["2", "3"],
    ]);
    // Receipt 4's order has no order.paid event at all: never reported.
    expect(await report(run)).toEqual({ reported: 0 });
    // Appended but not yet relayed into the link queue: still not delivered.
    await putOrderEvent(run, run.orders[3]!, "order.paid", "outbox");
    expect(await report(run)).toEqual({ reported: 0 });
    // Relayed and acknowledged by the cloud: now it goes out.
    await ackOrderEvent(run.orders[3]!, "order.paid");
    expect(await report(run)).toEqual({ reported: 1 });
  });

  it("legend-zy43 chunks held back and released merge into the cloud exactly once, no gap", async () => {
    const run = await edgeRun(3, { delivery: ["acked", "queued", "acked"] });
    await report(run);
    await ackOrderEvent(run.orders[1]!, "order.paid");
    await report(run);
    const events = await reportedEvents(run.device);
    expect(shapesOf(events)).toEqual([
      ["OFF1", 1, ["1"]],
      ["OFF1", 3, ["2", "3"]],
    ]);
    await resetToCloudState(run);
    for (const event of events) await applyEvent(event, run.node);
    expect((await receiptRows(run.outletId)).map((r) => r.number)).toEqual([
      "OFF1-000001",
      "OFF1-000002",
      "OFF1-000003",
    ]);
  });

  it("legend-zy43 no void event until order.voided is acked; a voided receipt is not chunked before that either", async () => {
    const run = await edgeRun(2);
    await report(run);
    await voidEdgeReceipt(run, 1, "queued");
    expect(await report(run)).toEqual({ reported: 0 });
    await ackOrderEvent(
      (await asOwnerTenant(tenant.tenantId, async (client) => {
        const r = await client.query(
          "SELECT order_id FROM pos_receipts WHERE tenant_id = $1 AND number = 'OFF1-000001' AND outlet_id = $2",
          [tenant.tenantId, run.outletId],
        );
        return uuidToUlid(r.rows[0].order_id as string);
      })) as string,
      "order.voided",
    );
    expect(await report(run)).toEqual({ reported: 1 });
    expect(shapesOf(await reportedEvents(run.device)).at(-1)).toEqual([
      "OFF1",
      2,
      ["1v"],
    ]);

    // A not yet reported receipt that is already voided waits for its void.
    await addEdgeReceipt(run, 3);
    await voidEdgeReceipt(run, 3, "queued");
    expect(await report(run)).toEqual({ reported: 0 });
  });

  // legend-btx4d review: a dead-lettered order.paid has no queue row, which
  // never got. legend-n2d3g: once its dead-letter notice is settled (no pending
  // notice row), the cloud skips that order's receipt, so the run moves on
  // instead of waiting forever (pending-notice cases:
  // edge-receipt-run-deadletter-861.test.ts).
  it("legend-btx4d legend-n2d3g a receipt whose order.paid was dead-lettered with a settled notice goes out in the chunk so the cloud can skip it", async () => {
    const run = await edgeRun(3, { delivery: ["acked", "queued", "acked"] });
    await deadLetterOrderEvent(run.orders[1]!, "order.paid");
    expect(await report(run)).toEqual({ reported: 1 });
    expect(shapesOf(await reportedEvents(run.device))).toEqual([
      ["OFF1", 3, ["1", "2", "3"]],
    ]);
    expect(await report(run)).toEqual({ reported: 0 });
  });

  it("legend-btx4d no void event is reported while order.voided is dead-lettered", async () => {
    const run = await edgeRun(2);
    await report(run);
    await voidEdgeReceipt(run, 1, "queued");
    const orderId = await asOwnerTenant(tenant.tenantId, async (client) => {
      const r = await client.query(
        "SELECT order_id FROM pos_receipts WHERE tenant_id = $1 AND number = 'OFF1-000001' AND outlet_id = $2",
        [tenant.tenantId, run.outletId],
      );
      return uuidToUlid(r.rows[0].order_id as string);
    });
    await deadLetterOrderEvent(orderId, "order.voided");
    // legend-n2d3g: nothing is sent, and the stuck void is counted.
    expect(await report(run)).toEqual({ reported: 0, held: 1 });
  });

  it("legend-zy43 one failing device does not stop the other devices of the pass", async () => {
    const bad = await edgeRun(1);
    // A second device in the same outlet, healthy.
    const device2 = randomUUID();
    const orders2 = await deviceOrders(bad.outletId, device2, 2);
    await provision(bad.outletId, device2, "OFF2");
    const good = { outletId: bad.outletId, device: device2, node: bad.node };
    await bindEdgeRun(good, "OFF2", orders2);
    // OFF1's receipt holds a void reason the contract does not know: the
    // event cannot be built for it.
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE pos_receipts SET status = 'voided', voided_at = now(), void_reason = 'bogus', voided_by = $3
          WHERE tenant_id = $1 AND outlet_id = $2 AND device_id = $4`,
        [tenant.tenantId, bad.outletId, cashier.userId, bad.device],
      );
    });
    await putOrderEvent(bad, bad.orders[0]!, "order.voided", "acked");
    const result = await report(bad);
    expect(result.reported).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(shapesOf(await reportedEvents(device2))).toEqual([
      ["OFF2", 2, ["1", "2"]],
    ]);
    expect(await reportedEvents(bad.device)).toHaveLength(0);
  });
});

describe("legend-zy43 receipt run cloud wiring", () => {
  it("legend-zy43 receipt_run is not a deferred POS aggregate (no duplicate handler)", () => {
    expect(posDeferredAggregates()).not.toContain(RECEIPT_RUN_AGGREGATE);
  });

  it("legend-zy43 cloud boot registrations never collide, in either order", () => {
    resetEdgeApplierRegistryForTests();
    expect(() => {
      registerPosDeferredEdgeApplier();
      registerReceiptRunEdgeApplier();
    }).not.toThrow();
    resetEdgeApplierRegistryForTests();
    expect(() => {
      registerReceiptRunEdgeApplier();
      registerPosDeferredEdgeApplier();
    }).not.toThrow();
  });

  it("legend-zy43 registerEdgeLink wires the receipt run applier and the edge runtime starts the reporter", () => {
    const source = readFileSync(
      new URL("../edge/runtime.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/registerReceiptRunEdgeApplier\(\);/);
    expect(source).toMatch(/startEdgeReceiptRunReporter\(/);
    expect(source).not.toContain("intentionally NOT wired");
  });
});
