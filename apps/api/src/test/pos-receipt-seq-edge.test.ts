// Receipt sequence bound to ONE edge database (bead legend-zsdd; related
// legend-3yqy interim, legend-ol6v edge->cloud merge NOT built).
//
// Invariant under test: a device sequence's counter lives in exactly one
// database. `edge_node_id` + `edge_instance_id` both NULL = the cloud holds
// it; both set = that edge database holds it; `retired_at` set = the run is
// closed and the device continues under a NEW prefix, so a number is never
// reissued. A rebuilt edge (same node id, new instance id) or a standby that
// takes over gets a new prefix instead of re-numbering from 0.
//
// Written against the Contract of docs/briefs/sub-receipt-seq-edge.md. Real
// PostgreSQL with RLS. As in pos-receipt-provisioning.test.ts (setup helpers
// copied, not edited) the "edge" database is the cloud database: each edge
// database is simulated with its own outlet, and a page the cloud made for
// outlet X is shipped to edge outlet Y by rewriting the sequence id and
// outlet (sequence ids and prefixes are unique per database).
//
// Assumptions:
//  - The next free prefix of a fresh outlet whose P1 was retired is P2
//    (Design: "next free P<n> over ALL rows of the outlet").
//  - Retiring a node for the cloud-after-edge case is an owner-SQL
//    `status = 'revoked'`; the cloud only looks at `edge_nodes` rows.
//  - A trigger/constraint refusal is asserted as a rejected query (the
//    message is backend detail), after a precondition read proves the new
//    columns exist, so a missing column cannot pass these cases.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  type ScopedTenantContext,
  type TenantId,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  decodeReceiptRunRefusals,
  deviceSyncPageSchema,
  encodeReceiptRunReport,
  encodeReceiptRunRefusals,
  type DeviceReceiptSequenceBinding,
  type DeviceReceiptSequenceSync,
  type DeviceSyncPage,
  type ReceiptRunRefusalReason,
  type ReceiptRunRefusalReport,
  type ReceiptRunReport,
} from "@starter/shared/edge";
import { type PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { enrollDevice } from "../services/device.service.ts";
import {
  applyDeviceReceiptSequences,
  deviceSyncQuerySchema,
  listDeviceRecordsSince,
  pullDeviceRegistry,
} from "../services/edge-device-sync.ts";
import { setPosReceiptPort } from "../services/pos-order-ports.ts";
import {
  allocateReceipt,
  claimDeviceReceiptSequencesForEdge,
  createPosReceiptPort,
  listDeviceReceiptSequences,
  RECEIPT_REFUSAL_ROTATIONS_MAX,
} from "../services/pos-receipt.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;

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
const actor = randomUUID();
const cloudState = getEdgeRuntimeState();

// ---- Fixtures (copied from pos-receipt-kfix.test.ts) ------------------------

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

function tenantContext(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

const scoped = (
  tenantId: string,
  source: "session" | "device",
  outletId: string,
): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source,
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(outletId)] },
  );
const cloudScope = (outletId: string, tenantId = tenant.tenantId) =>
  scoped(tenantId, "session", outletId);
const edgeScope = (outletId: string, tenantId = tenant.tenantId) =>
  scoped(tenantId, "device", outletId);

/** An outlet with its own price list: first receipt there is always #1. */
async function freshOutlet(): Promise<string> {
  const outletId = randomUUID();
  const priceListId = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Cafe Uji', 'Jl. Uji 1', 'Asia/Jakarta', $6, 'active')`,
    [
      outletId,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `Q${outletId.slice(0, 8)}`.toUpperCase(),
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

/**
 * A draft sale to number. Created as the edge would (1269 E3: the cloud
 * refuses a sale on an outlet an active edge serves, POS_WRITE_ON_EDGE); the
 * numbering under test is still allocated by the cloud or the edge as stated.
 */
async function draftOrder(outletId: string): Promise<string> {
  const created = await inEdgeMode(() =>
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

type ServiceTx = Parameters<typeof allocateReceipt>[0];

function inTx<T>(
  run: (tx: ServiceTx, context: ScopedTenantContext) => Promise<T>,
  context = tenantContext(tenant.tenantId),
): Promise<T> {
  return withTenant(db, context, (tx) => run(tx as ServiceTx, context));
}

function allocate(
  outletId: string,
  orderId: string,
  deviceId: string,
): Promise<PosReceipt> {
  return inTx((tx, context) =>
    allocateReceipt(tx, context, {
      orderId,
      outletId,
      deviceId,
      at: new Date(),
    }),
  );
}

/** Runs `run` with edge mode on and always restores the previous state. */
async function inEdgeMode<T>(run: () => Promise<T>): Promise<T> {
  const previous = getEdgeRuntimeState();
  setEdgeRuntimeStateForTests({ ...previous, edgeMode: true });
  try {
    return await run();
  } finally {
    setEdgeRuntimeStateForTests(previous);
  }
}

// ---- Device and sequence helpers --------------------------------------------

type SequenceRow = {
  id: string;
  prefix: string;
  last_number: number;
  device_id: string;
};

function sequenceRows(
  outletId: string,
  tenantId = tenant.tenantId,
): Promise<SequenceRow[]> {
  return asOwnerTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, prefix, last_number, device_id FROM receipt_sequences
       WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix`,
      [tenantId, outletId],
    );
    return result.rows as SequenceRow[];
  });
}

async function sequenceOf(
  outletId: string,
  deviceId: string,
): Promise<SequenceRow | undefined> {
  return (await sequenceRows(outletId)).find((r) => r.device_id === deviceId);
}

type DeviceType = Parameters<typeof enrollDevice>[2]["type"];

async function enroll(
  outletId: string,
  type: DeviceType = "pos",
  tenantId = tenant.tenantId,
) {
  const { device } = await enrollDevice(cloudScope(outletId, tenantId), actor, {
    outletId,
    type,
    label: `Perangkat ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  return device;
}

// ---- Setup ------------------------------------------------------------------

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  setPosReceiptPort(createPosReceiptPort());
  tenant = await createIsolatedTenant(`rpv-${randomUUID().slice(0, 6)}`);
  other = await createIsolatedTenant(`rpw-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Receipt Prov Kasir', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify(["order.view", "pos.sale.create"]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Receipt Prov Kasir");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  cashier = { client, userId };
  await asOwnerTenant(tenant.tenantId, async (c) => {
    await c.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Receipt Prov Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await c.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await c.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
    await c.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-RPV', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
});

afterEach(() => {
  setEdgeRuntimeStateForTests(cloudState);
  vi.restoreAllMocks();
});

afterAll(async () => {
  setEdgeRuntimeStateForTests(cloudState);
  setAuditWriter(null);
  setPosReceiptPort(null);
  // Final orders and receipts are append-only: the tenants stay in the
  // disposable database with a valid creator (as pos-receipt-kfix.test.ts does).
  for (const t of [tenant, other])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});
// ---- legend-zsdd helpers -----------------------------------------------------

type Binding = DeviceReceiptSequenceBinding;
type FullRow = SequenceRow & {
  edge_node_id: string | null;
  edge_instance_id: string | null;
  retired_at: Date | null;
  retired_reason: string | null;
};

/** Every row of the outlet (retired included) with the binding columns. */
function fullRows(outletId: string): Promise<FullRow[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, prefix, last_number, device_id, edge_node_id, edge_instance_id, retired_at, retired_reason
       FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix`,
      [tenant.tenantId, outletId],
    );
    return result.rows as FullRow[];
  });
}

const rowOf = (rows: FullRow[], prefix: string): FullRow => {
  const row = rows.find((r) => r.prefix === prefix);
  if (!row) throw new Error(`No sequence ${prefix} in ${JSON.stringify(rows)}`);
  return row;
};

/** A cloud edge_nodes row (instance_id stays NULL on cloud rows). */
async function insertNode(
  outletId: string,
  role: "primary" | "standby" = "primary",
  status: "active" | "revoked" = "active",
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, revoked_at)
       VALUES ($1, $2, $3, $4, $5, 'Server lokal', $6, $7)`,
      [
        id,
        tenant.tenantId,
        outletId,
        role,
        status,
        "a".repeat(64),
        status === "revoked" ? new Date() : null,
      ],
    ),
  );
  return id;
}

function revokeNode(nodeId: string): Promise<unknown> {
  return asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      "UPDATE edge_nodes SET status = 'revoked', revoked_at = now() WHERE id = $1",
      [nodeId],
    ),
  );
}

/**
 * The query an edge sends. Reproduction shim (legend-zsdd): before the
 * `edgeInstance` param exists the strict schema refuses it, so the same
 * page is requested without it and the case can still fail on its number or
 * prefix assertion. With the param in the schema this is a plain parse.
 */
function queryWith(instanceId: string | null) {
  const base = { limit: 100, receiptSequences: "1" };
  if (!instanceId) return deviceSyncQuerySchema.parse(base);
  return deviceSyncQuerySchema.parse({ ...base, edgeInstance: instanceId });
}

/** The device pull of node `nodeId` as a current edge sends it. */
function pullAs(
  outletId: string,
  nodeId: string,
  instanceId: string | null,
): Promise<DeviceSyncPage> {
  return listDeviceRecordsSince(
    {
      tenantId: tenant.tenantId as TenantId,
      outletId: outletIdSchema.parse(outletId),
      edgeNodeId: nodeId,
    },
    queryWith(instanceId),
    { now: new Date(Date.now() + 10 * 60_000), settleMs: 0 },
  );
}

/**
 * What an edge database applies: the cloud page with each sequence moved to
 * the edge's own outlet and given a new id (the cloud rows live in the same
 * database in this test).
 */
function shipTo(page: DeviceSyncPage, edgeOutletId: string): unknown {
  return {
    ...page,
    // Device records belong to the cloud outlet; only sequences are shipped.
    data: [],
    receiptSequences: (page.receiptSequences ?? []).map((s) => ({
      ...s,
      id: randomUUID(),
      outletId: edgeOutletId,
    })),
  };
}

/**
 * This edge database's own `edge_nodes` row (id = node id, `instance_id` =
 * its instance), as `ensureLocalEdgeNode` writes it. Upsert: the instance of
 * an existing row is overwritten, which is the restore procedure of
 * legend-zsdd (reset `edge_nodes.instance_id` on a restored database).
 * Assumption: in this single-database simulation a cloud row of the same node
 * id (case 1) doubles as the edge's local row; an edge allocation honours the
 * binding only when `edge_nodes.id` and `instance_id` match the sequence row.
 */
async function localEdgeNode(
  edgeOutletId: string,
  own: Binding,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, instance_id)
       VALUES ($1, $2, $3, 'primary', 'active', 'Server lokal', $4, $5)
       ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id`,
      [
        own.edgeNodeId,
        tenant.tenantId,
        edgeOutletId,
        "b".repeat(64),
        own.edgeInstanceId,
      ],
    ),
  );
}

/** The edge database of `own` applies one page. */
async function edgeApply(edgeOutletId: string, pulled: unknown, own: Binding) {
  await localEdgeNode(edgeOutletId, own);
  return inEdgeMode(() =>
    pullDeviceRegistry({
      context: edgeScope(edgeOutletId),
      role: "primary",
      binding: own,
      fetchPage: async () => pulled,
    }),
  );
}

async function edgeSell(outletId: string, deviceId: string): Promise<string> {
  const orderId = await draftOrder(outletId);
  const receipt = await inEdgeMode(() => allocate(outletId, orderId, deviceId));
  return receipt.number;
}

/** A sequence as the cloud sends it to an edge. */
function seq(
  outletId: string,
  deviceId: string,
  prefix: string,
  binding: Binding,
  lastNumber = 0,
): DeviceReceiptSequenceSync {
  return {
    id: randomUUID(),
    outletId: outletIdSchema.parse(outletId),
    deviceId,
    prefix,
    lastNumber,
    ...binding,
  };
}

function pageOf(sequences: DeviceReceiptSequenceSync[]): DeviceSyncPage {
  return deviceSyncPageSchema.parse({
    data: [],
    receiptSequences: sequences,
    meta: { limit: 100, nextCursor: null, watermark: null },
  });
}

/** An outlet with a primary node N that has claimed P1 of one device as (N, I). */
async function claimedOutlet(instanceId = randomUUID()) {
  const outletId = await freshOutlet();
  const device = await enroll(outletId, "pos");
  const nodeId = await insertNode(outletId);
  const claimed = await pullAs(outletId, nodeId, instanceId);
  return { outletId, device, nodeId, instanceId, claimed };
}

// ---- Cases ---------------------------------------------------------------------

describe("zsdd-1 a rebuilt edge (same node id, new database) never reissues printed numbers", () => {
  it("POS-06 EDG-02 same node, new instance: the device continues under a new prefix, P1 is retired, the rebuilt edge numbers P2-000001", async () => {
    const outletId = await freshOutlet();
    const device = await enroll(outletId, "pos");
    const nodeId = await insertNode(outletId);
    const [i1, i2] = [randomUUID(), randomUUID()];

    // First edge database claims P1 and prints three numbers.
    const first = await pullAs(outletId, nodeId, i1);
    expect(first.receiptSequences?.map((s) => s.prefix)).toEqual(["P1"]);
    const edgeA = await freshOutlet();
    await edgeApply(edgeA, shipTo(first, edgeA), {
      edgeNodeId: nodeId,
      edgeInstanceId: i1,
    });
    expect(await edgeSell(edgeA, device.id)).toBe("P1-000001");
    expect(await edgeSell(edgeA, device.id)).toBe("P1-000002");
    expect(await edgeSell(edgeA, device.id)).toBe("P1-000003");
    // The edge's numbers never reach the cloud (legend-ol6v): still 0.
    expect(await sequenceOf(outletId, device.id)).toMatchObject({
      prefix: "P1",
      last_number: 0,
    });

    // Rebuilt edge: same node id and credential, fresh database, new instance.
    const second = await pullAs(outletId, nodeId, i2);
    const [fresh] = second.receiptSequences ?? [];
    expect(second.receiptSequences).toHaveLength(1);
    expect(fresh).toMatchObject({ deviceId: device.id, lastNumber: 0 });
    expect(fresh?.prefix).not.toBe("P1");
    expect(fresh?.prefix).toBe("P2");

    const edgeB = await freshOutlet();
    await edgeApply(edgeB, shipTo(second, edgeB), {
      edgeNodeId: nodeId,
      edgeInstanceId: i2,
    });
    const number = await edgeSell(edgeB, device.id);
    expect(number).toBe("P2-000001");
    expect(number).not.toBe("P1-000001");

    // Cloud registry: P1 retired and still bound to the old instance, the
    // new run bound to the new one.
    const rows = await fullRows(outletId);
    expect(rowOf(rows, "P1")).toMatchObject({
      edge_node_id: nodeId,
      edge_instance_id: i1,
      last_number: 0,
    });
    expect(rowOf(rows, "P1").retired_at).not.toBeNull();
    expect(rowOf(rows, "P2")).toMatchObject({
      edge_node_id: nodeId,
      edge_instance_id: i2,
      retired_at: null,
    });
    expect(first.receiptSequences?.[0]).toMatchObject({
      edgeNodeId: nodeId,
      edgeInstanceId: i1,
    });
    expect(fresh).toMatchObject({ edgeNodeId: nodeId, edgeInstanceId: i2 });
  });

  it("POS-06 the same instance pulling again keeps its sequence: no rotation", async () => {
    const { outletId, nodeId, instanceId, claimed } = await claimedOutlet();
    const again = await pullAs(outletId, nodeId, instanceId);
    expect(again.receiptSequences?.map((s) => s.id)).toEqual(
      claimed.receiptSequences?.map((s) => s.id),
    );
    const rows = await fullRows(outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1"]);
    expect(rowOf(rows, "P1")).toMatchObject({
      edge_node_id: nodeId,
      edge_instance_id: instanceId,
      retired_at: null,
    });
  });
});

describe("zsdd-2 a standby takes over, an active standby claims nothing", () => {
  it("POS-06 EDG-02 primary N1 revoked, N2 becomes primary with instance I3: new prefix bound to (N2, I3), P1 stays N1's retired run", async () => {
    const { outletId, device, nodeId: n1 } = await claimedOutlet();
    await revokeNode(n1);
    const n2 = await insertNode(outletId);
    const i3 = randomUUID();

    const taken = await pullAs(outletId, n2, i3);
    expect(taken.receiptSequences).toHaveLength(1);
    expect(taken.receiptSequences?.[0]).toMatchObject({
      deviceId: device.id,
      prefix: "P2",
      lastNumber: 0,
      edgeNodeId: n2,
      edgeInstanceId: i3,
    });
    const rows = await fullRows(outletId);
    expect(rowOf(rows, "P1").edge_node_id).toBe(n1);
    expect(rowOf(rows, "P1").retired_at).not.toBeNull();
    expect(rowOf(rows, "P2")).toMatchObject({
      edge_node_id: n2,
      edge_instance_id: i3,
      retired_at: null,
    });
  });

  it("POS-06 an active standby that sends an instance gets [] and P1 stays bound to N1", async () => {
    const { outletId, nodeId: n1, instanceId: i1 } = await claimedOutlet();
    const standby = await insertNode(outletId, "standby");
    const result = await pullAs(outletId, standby, randomUUID());
    expect(result.receiptSequences).toEqual([]);
    const rows = await fullRows(outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1"]);
    expect(rowOf(rows, "P1")).toMatchObject({
      edge_node_id: n1,
      edge_instance_id: i1,
      retired_at: null,
    });
  });

  it("POS-06 a primary that sends no instance (old edge) gets [] and claims nothing", async () => {
    const outletId = await freshOutlet();
    await enroll(outletId, "pos");
    const nodeId = await insertNode(outletId);
    const result = await pullAs(outletId, nodeId, null);
    expect(result.receiptSequences).toEqual([]);
    const [row] = await fullRows(outletId);
    expect(row).toMatchObject({
      prefix: "P1",
      edge_node_id: null,
      edge_instance_id: null,
      retired_at: null,
    });
  });
});

describe("zsdd-3 two edges never hold one sequence", () => {
  it("EDG-02 the list for another binding never contains the (N1, I1) row", async () => {
    const {
      outletId,
      device,
      nodeId: n1,
      instanceId: i1,
    } = await claimedOutlet();
    const elsewhere: Binding = {
      edgeNodeId: randomUUID(),
      edgeInstanceId: randomUUID(),
    };
    const foreign = await inTx((tx, context) =>
      listDeviceReceiptSequences(tx, context, outletId, elsewhere),
    );
    expect(foreign).toEqual([]);
    const owned = await inTx((tx, context) =>
      listDeviceReceiptSequences(tx, context, outletId, {
        edgeNodeId: n1,
        edgeInstanceId: i1,
      }),
    );
    expect(owned.map((s) => s.deviceId)).toEqual([device.id]);
    // Same node, another instance: also nothing.
    const sameNode = await inTx((tx, context) =>
      listDeviceReceiptSequences(tx, context, outletId, {
        edgeNodeId: n1,
        edgeInstanceId: randomUUID(),
      }),
    );
    expect(sameNode).toEqual([]);
  });

  it("POS-06 the database trigger refuses rebinding a bound row, unbinding it, un-retiring or re-dating a retired one", async () => {
    const outletId = await freshOutlet();
    await enroll(outletId, "pos");
    const nodeId = await insertNode(outletId);
    await pullAs(outletId, nodeId, randomUUID());
    await pullAs(outletId, nodeId, randomUUID());
    const rows = await fullRows(outletId);
    // Precondition (also proves the columns exist): P1 retired, P2 current.
    const retired = rowOf(rows, "P1");
    const current = rowOf(rows, "P2");
    expect(retired.retired_at).not.toBeNull();
    expect(current.retired_at).toBeNull();

    const update = (sql: string, params: unknown[]) =>
      asOwnerTenant(tenant.tenantId, (c) => c.query(sql, params));
    await expect(
      update(
        "UPDATE receipt_sequences SET edge_node_id = $2, edge_instance_id = $3 WHERE id = $1",
        [current.id, randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/POS-06: .*already bound/);
    await expect(
      update(
        "UPDATE receipt_sequences SET edge_node_id = NULL, edge_instance_id = NULL WHERE id = $1",
        [current.id],
      ),
    ).rejects.toThrow(/POS-06: .*already bound/);
    await expect(
      update("UPDATE receipt_sequences SET retired_at = NULL WHERE id = $1", [
        retired.id,
      ]),
    ).rejects.toThrow(/POS-06: .*is retired and cannot change/);
    await expect(
      update(
        "UPDATE receipt_sequences SET retired_at = now() + interval '1 day' WHERE id = $1",
        [retired.id],
      ),
    ).rejects.toThrow(/POS-06: .*is retired and cannot change/);
    await expect(
      update(
        "UPDATE receipt_sequences SET edge_node_id = $2, edge_instance_id = $3 WHERE id = $1",
        [retired.id, randomUUID(), randomUUID()],
      ),
    ).rejects.toThrow(/POS-06: .*(already bound|is retired|cannot be bound)/);
    // Nothing moved.
    expect(await fullRows(outletId)).toEqual(rows);
  });

  it("POS-06 a half binding (node without instance) is refused by the check constraint", async () => {
    const outletId = await freshOutlet();
    await enroll(outletId, "pos");
    // Precondition: the new columns exist.
    expect((await fullRows(outletId))[0]?.edge_node_id).toBeNull();
    await expect(
      asOwnerTenant(tenant.tenantId, (c) =>
        c.query(
          `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number, edge_node_id)
           VALUES ($1, $2, $3, $4, 'P7', 0, $5)`,
          [randomUUID(), tenant.tenantId, outletId, randomUUID(), randomUUID()],
        ),
      ),
    ).rejects.toThrow(/receipt_sequences_edge_binding_check/);
  });

  it("POS-06 a device has one current row: a second current row is refused, a retired one is allowed", async () => {
    const outletId = await freshOutlet();
    const device = await enroll(outletId, "pos");
    expect((await fullRows(outletId))[0]?.retired_at).toBeNull();
    const insert = (prefix: string, retiredAt: Date | null) =>
      asOwnerTenant(tenant.tenantId, (c) =>
        c.query(
          `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number, retired_at)
           VALUES ($1, $2, $3, $4, $5, 0, $6)`,
          [
            randomUUID(),
            tenant.tenantId,
            outletId,
            device.id,
            prefix,
            retiredAt,
          ],
        ),
      );
    await expect(insert("P8", null)).rejects.toThrow(
      /receipt_sequences_device_current_key/,
    );
    await insert("P9", new Date());
    expect((await fullRows(outletId)).map((r) => r.prefix)).toEqual([
      "P1",
      "P9",
    ]);
  });

  it("EDG-02 the edge refuses a pulled sequence whose binding is not its own, and applies the one that is", async () => {
    const outletId = await freshOutlet();
    const own: Binding = {
      edgeNodeId: randomUUID(),
      edgeInstanceId: randomUUID(),
    };
    const otherNode = seq(outletId, randomUUID(), "P1", {
      edgeNodeId: randomUUID(),
      edgeInstanceId: own.edgeInstanceId,
    });
    const otherInstance = seq(outletId, randomUUID(), "P2", {
      edgeNodeId: own.edgeNodeId,
      edgeInstanceId: randomUUID(),
    });
    const mine = seq(outletId, randomUUID(), "P3", own);
    const result = await edgeApply(
      outletId,
      pageOf([otherNode, otherInstance, mine]),
      own,
    );
    expect(result.receiptSequencesRefused).toBe(2);
    const rows = await fullRows(outletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P3"]);
    expect(await edgeSell(outletId, mine.deviceId)).toBe("P3-000001");
  });

  it("EDG-02 a standby edge still applies no sequence, even one bound to its own binding", async () => {
    const outletId = await freshOutlet();
    const own: Binding = {
      edgeNodeId: randomUUID(),
      edgeInstanceId: randomUUID(),
    };
    await inEdgeMode(() =>
      pullDeviceRegistry({
        context: edgeScope(outletId),
        role: "standby",
        binding: own,
        fetchPage: async () => pageOf([seq(outletId, randomUUID(), "P1", own)]),
      }),
    );
    expect(await fullRows(outletId)).toEqual([]);
  });
});

describe("zsdd-4 the cloud sells after the edge is gone", () => {
  it("POS-06 a sequence bound to an edge: while the edge is active the cloud refuses; once none is active the cloud sells under a new unbound prefix, never P1-000001", async () => {
    const { outletId, device, nodeId } = await claimedOutlet();
    const orderId = await draftOrder(outletId);

    await expect(allocate(outletId, orderId, device.id)).rejects.toMatchObject({
      code: "RECEIPT_DEVICE_ON_EDGE",
    });

    await revokeNode(nodeId);
    const receipt = await allocate(outletId, orderId, device.id);
    expect(receipt.number).not.toBe("P1-000001");
    expect(receipt.number).toBe("P2-000001");

    const rows = await fullRows(outletId);
    expect(rowOf(rows, "P1").retired_at).not.toBeNull();
    expect(rowOf(rows, "P1").edge_node_id).toBe(nodeId);
    expect(rowOf(rows, "P2")).toMatchObject({
      device_id: device.id,
      last_number: 1,
      edge_node_id: null,
      edge_instance_id: null,
      retired_at: null,
    });
  });
});

describe("zsdd-5 a sequence the cloud already advanced is never handed to an edge", () => {
  it("POS-06 unbound with cloud lastNumber 1, claimed by an edge: rotated to a new prefix at 0, P1 retired unbound", async () => {
    const outletId = await freshOutlet();
    const device = await enroll(outletId, "pos");
    const orderId = await draftOrder(outletId);
    // No edge yet: the cloud sells P1-000001.
    expect((await allocate(outletId, orderId, device.id)).number).toBe(
      "P1-000001",
    );

    const nodeId = await insertNode(outletId);
    const instanceId = randomUUID();
    const claimed = await pullAs(outletId, nodeId, instanceId);
    expect(claimed.receiptSequences).toHaveLength(1);
    expect(claimed.receiptSequences?.[0]).toMatchObject({
      deviceId: device.id,
      prefix: "P2",
      lastNumber: 0,
      edgeNodeId: nodeId,
      edgeInstanceId: instanceId,
    });
    const rows = await fullRows(outletId);
    expect(rowOf(rows, "P1")).toMatchObject({
      last_number: 1,
      edge_node_id: null,
      edge_instance_id: null,
    });
    expect(rowOf(rows, "P1").retired_at).not.toBeNull();
    expect(rowOf(rows, "P2")).toMatchObject({
      edge_node_id: nodeId,
      edge_instance_id: instanceId,
      retired_at: null,
    });
  });
});

describe("zsdd-6 the edge replaces its current sequence of a device", () => {
  it("EDG-02 POS-06 local current P1, pulled P2 for the same device bound to own: P1 retired locally, P2 inserted, next number P2-000001", async () => {
    const edgeOutlet = await freshOutlet();
    const own: Binding = {
      edgeNodeId: randomUUID(),
      edgeInstanceId: randomUUID(),
    };
    const deviceId = randomUUID();

    const first = await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceId, "P1", own)]),
      own,
    );
    expect(first.receiptSequencesRefused).toBe(0);
    expect(await edgeSell(edgeOutlet, deviceId)).toBe("P1-000001");

    const second = await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceId, "P2", own)]),
      own,
    );
    expect(second.receiptSequencesReplaced).toBe(1);
    expect(second.receiptSequencesRefused).toBe(0);

    const rows = await fullRows(edgeOutlet);
    expect(rowOf(rows, "P1").retired_at).not.toBeNull();
    expect(rowOf(rows, "P1").last_number).toBe(1);
    expect(rowOf(rows, "P2")).toMatchObject({
      last_number: 0,
      retired_at: null,
      edge_node_id: own.edgeNodeId,
      edge_instance_id: own.edgeInstanceId,
    });
    expect(await edgeSell(edgeOutlet, deviceId)).toBe("P2-000001");
  });
});

describe("zsdd-R1 the edge allocation honours the binding (review of 2283ae9c)", () => {
  it("EDG-02 POS-06 restored database: the row bound to the old instance stops numbering until a pull rotates it, then P2-000001", async () => {
    const edgeOutlet = await freshOutlet();
    const nodeId = randomUUID();
    const [iOld, iNew] = [randomUUID(), randomUUID()];
    const deviceId = randomUUID();
    const oldOwn: Binding = { edgeNodeId: nodeId, edgeInstanceId: iOld };
    const newOwn: Binding = { edgeNodeId: nodeId, edgeInstanceId: iNew };

    // Before the restore: this database is instance iOld and numbers P1.
    await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceId, "P1", oldOwn)]),
      oldOwn,
    );
    expect(await edgeSell(edgeOutlet, deviceId)).toBe("P1-000001");

    // Restore procedure: owner SQL resets the instance of the local node row.
    await localEdgeNode(edgeOutlet, newOwn);

    // The P1 run is bound to iOld, so it must not number any more.
    const orderId = await draftOrder(edgeOutlet);
    await expect(
      inEdgeMode(() => allocate(edgeOutlet, orderId, deviceId)),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_NOT_PROVISIONED" });
    expect(
      (await fullRows(edgeOutlet)).find((r) => r.prefix === "P1")?.last_number,
    ).toBe(1);

    // A pull bound to (N, iNew) delivers the rotated sequence: P2 at 0.
    const pulled = await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceId, "P2", newOwn)]),
      newOwn,
    );
    expect(pulled.receiptSequencesReplaced).toBe(1);
    expect(pulled.receiptSequencesRefused).toBe(0);
    const receipt = await inEdgeMode(() =>
      allocate(edgeOutlet, orderId, deviceId),
    );
    expect(receipt.number).toBe("P2-000001");

    const rows = await fullRows(edgeOutlet);
    expect(rowOf(rows, "P1").retired_at).not.toBeNull();
    expect(rowOf(rows, "P1").last_number).toBe(1);
    expect(rowOf(rows, "P2")).toMatchObject({
      last_number: 1,
      retired_at: null,
      edge_node_id: nodeId,
      edge_instance_id: iNew,
    });
  });

  it("EDG-02 POS-06 a replacement the cloud already advanced (lastNumber > 0) is refused; the local run the cloud no longer lists is retired and stops numbering (legend-sduiq)", async () => {
    const edgeOutlet = await freshOutlet();
    const own: Binding = {
      edgeNodeId: randomUUID(),
      edgeInstanceId: randomUUID(),
    };
    const deviceId = randomUUID();
    await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceId, "P1", own)]),
      own,
    );
    expect(await edgeSell(edgeOutlet, deviceId)).toBe("P1-000001");

    const result = await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceId, "P2", own, 3)]),
      own,
    );
    expect(result.receiptSequencesRefused).toBe(1);
    expect(result.receiptSequencesReplaced).toBe(0);
    expect(result.receiptSequencesRetired).toBe(1);

    const rows = await fullRows(edgeOutlet);
    expect(rows.map((r) => r.prefix)).toEqual(["P1"]);
    expect(rowOf(rows, "P1")).toMatchObject({
      last_number: 1,
      retired_reason: "edge_replaced",
    });
    expect(rowOf(rows, "P1").retired_at).not.toBeNull();
    // The cloud retired P1: no number of it is issued again here.
    const orderId = await draftOrder(edgeOutlet);
    await expect(
      inEdgeMode(() => allocate(edgeOutlet, orderId, deviceId)),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_NOT_PROVISIONED" });
  });
});

describe("sduiq the edge retires a local run the cloud no longer lists (legend-sduiq)", () => {
  const ownBinding = (): Binding => ({
    edgeNodeId: randomUUID(),
    edgeInstanceId: randomUUID(),
  });

  it("POS-06 EDG-02 the pulled replacement clashes with a local prefix: it is refused, the device's old run is retired, the other device keeps numbering", async () => {
    const edgeOutlet = await freshOutlet();
    const own = ownBinding();
    const [deviceA, deviceB] = [randomUUID(), randomUUID()];
    const b2 = seq(edgeOutlet, deviceB, "P2", own);
    await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceA, "P1", own), b2]),
      own,
    );
    expect(await edgeSell(edgeOutlet, deviceA)).toBe("P1-000001");

    // The cloud rotated A's P1 to a prefix this database already holds.
    const result = await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceA, "P2", own), b2]),
      own,
    );
    expect(result).toMatchObject({
      receiptSequencesRefused: 1,
      receiptSequencesReplaced: 0,
      receiptSequencesRetired: 1,
    });
    const rows = await fullRows(edgeOutlet);
    expect(rowOf(rows, "P1")).toMatchObject({
      retired_reason: "edge_replaced",
      last_number: 1,
    });
    expect(rowOf(rows, "P2").retired_at).toBeNull();
    const orderId = await draftOrder(edgeOutlet);
    await expect(
      inEdgeMode(() => allocate(edgeOutlet, orderId, deviceA)),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_NOT_PROVISIONED" });
    expect(await edgeSell(edgeOutlet, deviceB)).toBe("P2-000001");
  });

  it("POS-06 a device missing from a non-empty list loses its local run; listed runs are kept and keep counting", async () => {
    const edgeOutlet = await freshOutlet();
    const own = ownBinding();
    const [deviceA, deviceB] = [randomUUID(), randomUUID()];
    const b2 = seq(edgeOutlet, deviceB, "P2", own);
    await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceA, "P1", own), b2]),
      own,
    );
    expect(await edgeSell(edgeOutlet, deviceB)).toBe("P2-000001");

    const result = await edgeApply(edgeOutlet, pageOf([b2]), own);
    expect(result).toMatchObject({
      receiptSequencesRefused: 0,
      receiptSequencesRetired: 1,
    });
    const rows = await fullRows(edgeOutlet);
    expect(rowOf(rows, "P1").retired_reason).toBe("edge_replaced");
    expect(rowOf(rows, "P2").retired_at).toBeNull();
    expect(await edgeSell(edgeOutlet, deviceB)).toBe("P2-000002");
  });

  it("POS-06 EDG-02 the same full list again retires nothing (normal pulls are untouched)", async () => {
    const edgeOutlet = await freshOutlet();
    const own = ownBinding();
    const deviceId = randomUUID();
    const page = pageOf([seq(edgeOutlet, deviceId, "P1", own)]);
    await edgeApply(edgeOutlet, page, own);
    expect(await edgeSell(edgeOutlet, deviceId)).toBe("P1-000001");
    const again = await edgeApply(edgeOutlet, page, own);
    expect(again).toMatchObject({
      receiptSequencesRefused: 0,
      receiptSequencesReplaced: 0,
      receiptSequencesRetired: 0,
    });
    expect(await edgeSell(edgeOutlet, deviceId)).toBe("P1-000002");
  });

  it("EDG-02 an empty list retires nothing (the cloud may not have recognised this database as the primary)", async () => {
    const edgeOutlet = await freshOutlet();
    const own = ownBinding();
    const deviceId = randomUUID();
    await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceId, "P1", own)]),
      own,
    );
    const result = await edgeApply(edgeOutlet, pageOf([]), own);
    expect(result.receiptSequencesRetired).toBe(0);
    expect(await edgeSell(edgeOutlet, deviceId)).toBe("P1-000001");
  });

  it("EDG-02 a refused list (sequence of another outlet) retires nothing", async () => {
    const edgeOutlet = await freshOutlet();
    const otherOutlet = await freshOutlet();
    const own = ownBinding();
    const deviceId = randomUUID();
    await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceId, "P1", own)]),
      own,
    );
    const result = await edgeApply(
      edgeOutlet,
      pageOf([seq(otherOutlet, randomUUID(), "P2", own)]),
      own,
    );
    expect(result.receiptSequencesRefused).toBe(1);
    expect(result.receiptSequencesRetired).toBe(0);
    expect(await edgeSell(edgeOutlet, deviceId)).toBe("P1-000001");
  });

  it("EDG-02 a standby applies nothing and retires nothing", async () => {
    const edgeOutlet = await freshOutlet();
    const own = ownBinding();
    const deviceId = randomUUID();
    await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceId, "P1", own)]),
      own,
    );
    const result = await inEdgeMode(() =>
      pullDeviceRegistry({
        context: edgeScope(edgeOutlet),
        role: "standby",
        binding: own,
        fetchPage: async () =>
          pageOf([seq(edgeOutlet, randomUUID(), "P2", own)]),
      }),
    );
    expect(result.receiptSequencesRetired).toBe(0);
    expect(rowOf(await fullRows(edgeOutlet), "P1").retired_at).toBeNull();
  });

  it("POS-06 a local run bound to an old instance (restore procedure) is left as it is; it already cannot number", async () => {
    const edgeOutlet = await freshOutlet();
    const nodeId = randomUUID();
    const oldOwn: Binding = {
      edgeNodeId: nodeId,
      edgeInstanceId: randomUUID(),
    };
    const newOwn: Binding = {
      edgeNodeId: nodeId,
      edgeInstanceId: randomUUID(),
    };
    const [deviceA, deviceB] = [randomUUID(), randomUUID()];
    await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceA, "P1", oldOwn)]),
      oldOwn,
    );
    const result = await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceB, "P2", newOwn)]),
      newOwn,
    );
    expect(result.receiptSequencesRetired).toBe(0);
    expect(rowOf(await fullRows(edgeOutlet), "P1")).toMatchObject({
      retired_at: null,
      edge_instance_id: oldOwn.edgeInstanceId,
    });
  });

  it("EDG-02 a non-empty list with no entry bound to this database retires nothing (node id mismatch)", async () => {
    const edgeOutlet = await freshOutlet();
    const own = ownBinding();
    const deviceId = randomUUID();
    await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceId, "P1", own)]),
      own,
    );
    const result = await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, randomUUID(), "P2", ownBinding())]),
      own,
    );
    expect(result).toMatchObject({
      receiptSequencesRefused: 1,
      receiptSequencesRetired: 0,
    });
    expect(await edgeSell(edgeOutlet, deviceId)).toBe("P1-000001");
  });

  it("EDG-02 the cloud sends the FULL bound list on every page of a multi-page pull (the edge's retire relies on it)", async () => {
    const outletId = await freshOutlet();
    await enroll(outletId, "pos");
    await enroll(outletId, "pos");
    await enroll(outletId, "pos");
    const nodeId = await insertNode(outletId);
    const instanceId = randomUUID();
    const node = {
      tenantId: tenant.tenantId as TenantId,
      outletId: outletIdSchema.parse(outletId),
      edgeNodeId: nodeId,
    };
    const pages: DeviceSyncPage[] = [];
    let since: string | undefined;
    for (;;) {
      const page = await listDeviceRecordsSince(
        node,
        deviceSyncQuerySchema.parse({
          limit: 1,
          receiptSequences: "1",
          edgeInstance: instanceId,
          ...(since === undefined ? {} : { since }),
        }),
        { now: new Date(Date.now() + 10 * 60_000), settleMs: 0 },
      );
      pages.push(page);
      if (page.meta.nextCursor === null) break;
      since = page.meta.nextCursor;
    }
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const bound = (await fullRows(outletId))
      .filter(
        (r) =>
          r.retired_at === null &&
          r.edge_node_id === nodeId &&
          r.edge_instance_id === instanceId,
      )
      .map((r) => r.id)
      .sort();
    expect(bound).toHaveLength(3);
    for (const page of pages)
      expect((page.receiptSequences ?? []).map((s) => s.id).sort()).toEqual(
        bound,
      );
  });

  it("POS-06 an unbound local run (3yqy era) missing from the list is retired too", async () => {
    const edgeOutlet = await freshOutlet();
    const own = ownBinding();
    const [deviceA, deviceB] = [randomUUID(), randomUUID()];
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO receipt_sequences (id, tenant_id, outlet_id, device_id, prefix, last_number)
         VALUES ($1, $2, $3, $4, 'P1', 4)`,
        [randomUUID(), tenant.tenantId, edgeOutlet, deviceA],
      ),
    );
    const result = await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, deviceB, "P2", own)]),
      own,
    );
    expect(result).toMatchObject({
      receiptSequencesRefused: 0,
      receiptSequencesRetired: 1,
    });
    expect(rowOf(await fullRows(edgeOutlet), "P1")).toMatchObject({
      retired_reason: "edge_replaced",
      edge_node_id: null,
      last_number: 4,
    });
  });
});

// ---- legend-hfq3z: a refused run is reported and replaced by the cloud -------
//
// Assumptions (the brief is the contract; no backend code was used to derive them):
//  - Edge and cloud share one test database, so a page is shipped as in the
//    sduiq block, except that the id of a run the edge is meant to REFUSE is
//    kept: the id then clashes with the cloud row itself (`id_used`), and with
//    a local prefix of the edge (`prefix_used`) when the edge holds that
//    prefix. A refused run is never inserted on the edge, so keeping its id
//    cannot collide; every other run gets a stable edge-side id.
//  - Pulls here send no `receiptRuns` (an old-style report-less pull, except
//    the empty report sent with refusals, see below): the edge
//    and cloud use the same prefixes for different devices in this simulation,
//    and a forwarded report would only add yd0h8 noise. The brief allows
//    `receiptRefused` with `receiptSequences=1` alone.
//  - Only `receiptRunRefusals` (pullDeviceRegistry result), `refusals`
//    (applyDeviceReceiptSequences result), the `receiptRefused` query param and
//    the claim result `refusedRotated` / `refusedThrottled` are read; row state
//    is read from the table.
//  - The cloud rotates a run for the throttle with `claim_rotated` retirements
//    of the SAME node and the SAME instance, counted per device within
//    RECEIPT_REGRESSION_WINDOW_HOURS (fix round 1, A2).
//  - Fix round 1 (A1): the cloud heals only when the request also carries
//    `receiptRuns`. A real edge always sends it with refusals, so the helpers
//    below send an EMPTY report (`new Map()`: the edge holds no run) whenever
//    refusals are given and no report is. `report: null` sends none.
//  - A new prefix is the smallest free `P<n>` above every `P<n>` of the report
//    and above the refused run's own number when its reason is `prefix_used`
//    (A5); with nothing above, it is the smallest free prefix of the outlet.

describe("hfq3z a clash-refused replacement run is reported and healed by the cloud (legend-hfq3z)", () => {
  let hfqClock = 0;
  /** Strictly increasing cloud arrival times (the report token of a pull). */
  function hfqNow(): Date {
    hfqClock = Math.max(Date.now() + 10 * 60_000, hfqClock + 1);
    return new Date(hfqClock);
  }

  /** The cloud answering one pull of node N, instance I (no `receiptRuns`). */
  function cloudPull(
    cloudOutletId: string,
    own: Binding,
    options: {
      /** `null` = send no `receiptRuns`; default: empty when refusals given. */
      report?: ReceiptRunReport | null;
      refusals?: ReceiptRunRefusalReport;
      since?: string | null;
    } = {},
  ): Promise<DeviceSyncPage> {
    const report =
      options.report === undefined
        ? options.refusals
          ? new Map<string, number>()
          : undefined
        : (options.report ?? undefined);
    const query = deviceSyncQuerySchema.parse({
      limit: 100,
      receiptSequences: "1",
      edgeInstance: own.edgeInstanceId,
      ...(options.since ? { since: options.since } : {}),
      ...(report ? { receiptRuns: encodeReceiptRunReport(report) } : {}),
      ...(options.refusals
        ? { receiptRefused: encodeReceiptRunRefusals(options.refusals) }
        : {}),
    });
    return listDeviceRecordsSince(
      {
        tenantId: tenant.tenantId as TenantId,
        outletId: outletIdSchema.parse(cloudOutletId),
        edgeNodeId: own.edgeNodeId,
      },
      query,
      { now: hfqNow(), settleMs: 0 },
    );
  }

  const refusal = (
    id: string,
    reason: ReceiptRunRefusalReason = "prefix_used",
  ): ReceiptRunRefusalReport => new Map([[id, reason]]);

  /** The claim run directly (its counts are not part of the page). */
  function hfqClaim(
    outletId: string,
    own: Binding,
    refusals?: ReceiptRunRefusalReport,
    /** `null` = no report; default: empty when refusals given. */
    report?: ReceiptRunReport | null,
  ) {
    const sent =
      report === undefined
        ? refusals
          ? new Map<string, number>()
          : undefined
        : (report ?? undefined);
    return inTx((tx, context) =>
      claimDeviceReceiptSequencesForEdge(tx, context, {
        outletId,
        ...own,
        ...(refusals ? { refusals } : {}),
        ...(sent ? { report: sent } : {}),
      }),
    );
  }

  /** A cloud outlet with device D and primary node N; an empty edge outlet. */
  async function scenario() {
    const cloudOutletId = await freshOutlet();
    const edgeOutletId = await freshOutlet();
    const device = await enroll(cloudOutletId, "pos");
    const nodeId = await insertNode(cloudOutletId);
    const own: Binding = { edgeNodeId: nodeId, edgeInstanceId: randomUUID() };
    /** cloud run id -> id used on the edge database (stable across pulls). */
    const edgeIds = new Map<string, string>();
    /** Cloud run ids that keep their id on the edge (the refused ones). */
    const keepIds = new Set<string>();
    const ship = (page: DeviceSyncPage) => ({
      ...page,
      data: [],
      receiptSequences: (page.receiptSequences ?? []).map((s) => {
        if (!keepIds.has(s.id) && !edgeIds.has(s.id))
          edgeIds.set(s.id, randomUUID());
        return {
          ...s,
          id: keepIds.has(s.id) ? s.id : edgeIds.get(s.id)!,
          outletId: edgeOutletId,
        };
      }),
    });

    /** One edge pull through pullDeviceRegistry; `refusals` = previous pull's. */
    async function pull(refusals?: ReceiptRunRefusalReport) {
      await localEdgeNode(edgeOutletId, own);
      const calls: Array<ReceiptRunRefusalReport | undefined> = [];
      const pages: DeviceSyncPage[] = [];
      const result = await inEdgeMode(() =>
        pullDeviceRegistry({
          context: edgeScope(edgeOutletId),
          role: "primary",
          binding: own,
          ...(refusals ? { refusals } : {}),
          fetchPage: async (
            since: string | null,
            _receiptRuns?: ReceiptRunReport,
            sent?: ReceiptRunRefusalReport,
          ) => {
            calls.push(sent);
            // The cloud answers in cloud mode, whatever the edge's mode.
            const edgeState = getEdgeRuntimeState();
            setEdgeRuntimeStateForTests(cloudState);
            try {
              const page = await cloudPull(cloudOutletId, own, {
                since,
                ...(sent ? { refusals: sent } : {}),
              });
              pages.push(page);
              return ship(page);
            } finally {
              setEdgeRuntimeStateForTests(edgeState);
            }
          },
        }),
      );
      return { result, calls, pages };
    }

    /** yd0h8: the cloud rotates D's run (restored database): P1 -> P2. */
    async function rotateOnCloud() {
      await cloudPull(cloudOutletId, own, { report: new Map() });
      await cloudPull(cloudOutletId, own, {
        report: new Map([["P1", 3]]),
      });
      await cloudPull(cloudOutletId, own, {
        report: new Map([["P1", 1]]),
      });
      const rows = await fullRows(cloudOutletId);
      const replacement = rowOf(rows, "P2");
      // Precondition: the replacement is a fresh current run for D.
      expect(replacement).toMatchObject({
        device_id: device.id,
        last_number: 0,
        retired_at: null,
        edge_node_id: own.edgeNodeId,
        edge_instance_id: own.edgeInstanceId,
      });
      expect(rowOf(rows, "P1").retired_reason).toBe("edge_regressed");
      return replacement;
    }

    return {
      cloudOutletId,
      edgeOutletId,
      device,
      own,
      keepIds,
      pull,
      rotateOnCloud,
      ship,
    };
  }

  type Scenario = Awaited<ReturnType<typeof scenario>>;

  const currentOf = (rows: FullRow[], deviceId: string) =>
    rows.filter((r) => r.device_id === deviceId && r.retired_at === null);

  /**
   * Edge holds P1 of D (sold once), the cloud rotated D to P2, and the edge
   * pulled it: the replacement is refused for `reason`.
   */
  async function refusedScenario(reason: ReceiptRunRefusalReason) {
    const s = await scenario();
    if (reason === "prefix_used") {
      // The edge already holds prefix P2 (a local run of another device).
      await edgeApply(
        s.edgeOutletId,
        pageOf([seq(s.edgeOutletId, randomUUID(), "P2", s.own)]),
        s.own,
      );
    }
    await s.pull();
    expect(await edgeSell(s.edgeOutletId, s.device.id)).toBe("P1-000001");
    const replacement = await s.rotateOnCloud();
    s.keepIds.add(replacement.id);
    const refused = await s.pull();
    return { ...s, replacement, refused };
  }

  async function expectCannotSell(s: Scenario) {
    const orderId = await draftOrder(s.edgeOutletId);
    await expect(
      inEdgeMode(() => allocate(s.edgeOutletId, orderId, s.device.id)),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_NOT_PROVISIONED" });
  }

  it("POS-06 EDG-02 prefix clash: the device cannot sell; the next pull carries the refusal, the cloud retires the run (claim_rotated) and lists a new prefix, the edge accepts it and numbers P3-000001", async () => {
    const s = await refusedScenario("prefix_used");

    // Repro: replacement refused, old local run retired, device cannot sell.
    expect(s.refused.result.receiptSequencesRefused).toBe(1);
    expect(s.refused.result.receiptSequencesRetired).toBe(1);
    expect(s.refused.result.receiptRunRefusals).toEqual(
      new Map([[s.replacement.id, "prefix_used"]]),
    );
    // The first pull had nothing to report.
    expect(s.refused.calls[0]?.size ?? 0).toBe(0);
    await expectCannotSell(s);

    // Next pull carries the refusal and heals within the same response.
    const healed = await s.pull(s.refused.result.receiptRunRefusals);
    expect(healed.calls[0]).toEqual(
      new Map([[s.replacement.id, "prefix_used"]]),
    );
    expect(healed.pages[0]?.receiptSequences).toHaveLength(1);
    expect(healed.pages[0]?.receiptSequences?.[0]).toMatchObject({
      deviceId: s.device.id,
      prefix: "P3",
      lastNumber: 0,
      edgeNodeId: s.own.edgeNodeId,
      edgeInstanceId: s.own.edgeInstanceId,
    });
    expect(healed.result.receiptSequencesRefused).toBe(0);
    expect(healed.result.receiptRunRefusals.size).toBe(0);

    const cloudRows = await fullRows(s.cloudOutletId);
    expect(rowOf(cloudRows, "P2").retired_reason).toBe("claim_rotated");
    expect(rowOf(cloudRows, "P2").retired_at).not.toBeNull();
    expect(rowOf(cloudRows, "P3")).toMatchObject({
      device_id: s.device.id,
      last_number: 0,
      retired_at: null,
      edge_node_id: s.own.edgeNodeId,
      edge_instance_id: s.own.edgeInstanceId,
    });
    expect(currentOf(cloudRows, s.device.id)).toHaveLength(1);

    // A sale on the edge is numbered under the new prefix, starting at 1.
    expect(await edgeSell(s.edgeOutletId, s.device.id)).toBe("P3-000001");
    expect(await edgeSell(s.edgeOutletId, s.device.id)).toBe("P3-000002");
    // The old run's printed number is never issued again.
    const edgeRows = await fullRows(s.edgeOutletId);
    expect(rowOf(edgeRows, "P1")).toMatchObject({ last_number: 1 });
    expect(rowOf(edgeRows, "P1").retired_at).not.toBeNull();
  });

  it("POS-06 EDG-02 id clash: the edge reports id_used, the cloud rotates the run and the edge numbers P3-000001", async () => {
    const s = await refusedScenario("id_used");

    expect(s.refused.result.receiptSequencesRefused).toBe(1);
    expect(s.refused.result.receiptRunRefusals).toEqual(
      new Map([[s.replacement.id, "id_used"]]),
    );
    await expectCannotSell(s);

    const healed = await s.pull(s.refused.result.receiptRunRefusals);
    expect(healed.calls[0]).toEqual(new Map([[s.replacement.id, "id_used"]]));
    expect(healed.result.receiptSequencesRefused).toBe(0);
    expect(healed.result.receiptRunRefusals.size).toBe(0);
    const cloudRows = await fullRows(s.cloudOutletId);
    expect(rowOf(cloudRows, "P2").retired_reason).toBe("claim_rotated");
    expect(rowOf(cloudRows, "P3").retired_at).toBeNull();
    expect(await edgeSell(s.edgeOutletId, s.device.id)).toBe("P3-000001");
  });

  it("POS-06 applyDeviceReceiptSequences reports only clash refusals: prefix_used and id_used count in refused and are listed by run id, other refusals are not", async () => {
    const edgeOutlet = await freshOutlet();
    const own = { edgeNodeId: randomUUID(), edgeInstanceId: randomUUID() };
    const [a, b, c, d] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    await edgeApply(
      edgeOutlet,
      pageOf([seq(edgeOutlet, a, "P1", own), seq(edgeOutlet, b, "P2", own)]),
      own,
    );
    const prefixClash = seq(edgeOutlet, a, "P2", own);
    // Same id as a row that exists in this (shared) database, free prefix.
    const existing = rowOf(await fullRows(edgeOutlet), "P1");
    const idClash = { ...seq(edgeOutlet, c, "P7", own), id: existing.id };
    const advanced = seq(edgeOutlet, d, "P8", own, 3);
    const otherBinding = seq(edgeOutlet, randomUUID(), "P9", {
      edgeNodeId: randomUUID(),
      edgeInstanceId: randomUUID(),
    });
    await localEdgeNode(edgeOutlet, own);
    const result = await inEdgeMode(() =>
      applyDeviceReceiptSequences(
        edgeScope(edgeOutlet),
        [prefixClash, idClash, advanced, otherBinding],
        own,
      ),
    );
    expect(result.refused).toBe(4);
    expect(result.refusals).toEqual(
      new Map<string, ReceiptRunRefusalReason>([
        [prefixClash.id, "prefix_used"],
        [idClash.id, "id_used"],
      ]),
    );
  });

  it("POS-06 the same refusals sent again (before and after the heal) change nothing: one current run per device, one extra retired run, no prefix reused", async () => {
    const s = await refusedScenario("prefix_used");
    const refusals = s.refused.result.receiptRunRefusals;
    await s.pull(refusals);
    const afterFirst = await fullRows(s.cloudOutletId);

    // Duplicate: the edge repeats the report (lost response, retry) ...
    await cloudPull(s.cloudOutletId, s.own, { refusals });
    await cloudPull(s.cloudOutletId, s.own, { refusals });
    // ... and a full edge pull that still carries it.
    await s.pull(refusals);

    const rows = await fullRows(s.cloudOutletId);
    expect(rows.map((r) => [r.prefix, r.retired_reason])).toEqual(
      afterFirst.map((r) => [r.prefix, r.retired_reason]),
    );
    expect(rows.map((r) => r.prefix)).toEqual(["P1", "P2", "P3"]);
    expect(new Set(rows.map((r) => r.prefix)).size).toBe(rows.length);
    expect(currentOf(rows, s.device.id)).toHaveLength(1);
    expect(
      rows.filter((r) => r.retired_reason === "claim_rotated"),
    ).toHaveLength(1);
    expect(await edgeSell(s.edgeOutletId, s.device.id)).toBe("P3-000001");
  });

  it("POS-06 the same refusals sent twice before the edge heals rotate exactly once", async () => {
    const s = await refusedScenario("id_used");
    const refusals = s.refused.result.receiptRunRefusals;
    const first = await cloudPull(s.cloudOutletId, s.own, { refusals });
    const second = await cloudPull(s.cloudOutletId, s.own, { refusals });
    expect(first.receiptSequences?.map((x) => x.prefix)).toEqual(["P3"]);
    expect(second.receiptSequences?.map((x) => x.prefix)).toEqual(["P3"]);
    const rows = await fullRows(s.cloudOutletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1", "P2", "P3"]);
    expect(currentOf(rows, s.device.id)).toHaveLength(1);
  });

  it("EDG-02 an old edge (no receiptRefused) is not healed: the cloud keeps the refused run, the device stays unable to sell", async () => {
    const s = await refusedScenario("prefix_used");
    // Old-style pulls only (no refusals sent); the control comes last.
    const again = await s.pull();
    const third = await s.pull();
    for (const p of [again, third]) {
      expect(p.calls[0]).toBeUndefined();
      expect(p.pages[0]?.receiptSequences?.map((x) => x.prefix)).toEqual([
        "P2",
      ]);
      expect(p.result.receiptSequencesRefused).toBe(1);
    }
    const rows = await fullRows(s.cloudOutletId);
    expect(rows.map((r) => r.prefix)).toEqual(["P1", "P2"]);
    expect(rowOf(rows, "P2").retired_at).toBeNull();
    expect(rows.some((r) => r.retired_reason === "claim_rotated")).toBe(false);
    await expectCannotSell(s);

    // Control: the same state IS healed once the refusal is reported.
    await s.pull(again.result.receiptRunRefusals);
    expect(rowOf(await fullRows(s.cloudOutletId), "P2").retired_reason).toBe(
      "claim_rotated",
    );
  });

  it("POS-06 EDG-02 refusals WITHOUT receiptRuns do not rotate: the cloud cannot tell an unreported numbered run (A1)", async () => {
    const s = await scenario();
    await cloudPull(s.cloudOutletId, s.own);
    const before = await fullRows(s.cloudOutletId);
    const run = rowOf(before, "P1");

    const direct = await hfqClaim(
      s.cloudOutletId,
      s.own,
      refusal(run.id),
      null,
    );
    expect(direct.refusedRotated).toBe(0);
    expect(direct.refusedThrottled).toBe(0);
    const page = await cloudPull(s.cloudOutletId, s.own, {
      refusals: refusal(run.id, "id_used"),
      report: null,
    });
    expect(page.receiptSequences?.map((x) => x.id)).toEqual([run.id]);
    expect(await fullRows(s.cloudOutletId)).toEqual(before);

    // Control: the same refusal WITH a report (the edge holds no run) heals.
    const healed = await cloudPull(s.cloudOutletId, s.own, {
      refusals: refusal(run.id),
      report: new Map(),
    });
    expect(healed.receiptSequences?.map((x) => x.prefix)).toEqual(["P2"]);
    expect(rowOf(await fullRows(s.cloudOutletId), "P1").retired_reason).toBe(
      "claim_rotated",
    );
  });

  describe("the new prefix is above everything the edge holds (A5)", () => {
    it("POS-06 the edge reports P7:3 for another device: the replacement of P1 is P8, not P2", async () => {
      const s = await scenario();
      await cloudPull(s.cloudOutletId, s.own);
      const run = rowOf(await fullRows(s.cloudOutletId), "P1");
      const result = await hfqClaim(
        s.cloudOutletId,
        s.own,
        refusal(run.id, "id_used"),
        new Map([["P7", 3]]),
      );
      expect(result.refusedRotated).toBe(1);
      const rows = await fullRows(s.cloudOutletId);
      expect(rowOf(rows, "P1").retired_reason).toBe("claim_rotated");
      expect(rows.map((r) => r.prefix)).toEqual(["P1", "P8"]);
      expect(rowOf(rows, "P8")).toMatchObject({
        device_id: s.device.id,
        last_number: 0,
        retired_at: null,
        edge_node_id: s.own.edgeNodeId,
        edge_instance_id: s.own.edgeInstanceId,
      });
    });

    it("POS-06 prefix_used: the replacement is above the refused run's own number (cloud run P5 -> P6)", async () => {
      const s = await scenario();
      await cloudPull(s.cloudOutletId, s.own);
      const run = rowOf(await fullRows(s.cloudOutletId), "P1");
      await asOwnerTenant(tenant.tenantId, (c) =>
        c.query("UPDATE receipt_sequences SET prefix = 'P5' WHERE id = $1", [
          run.id,
        ]),
      );
      await hfqClaim(s.cloudOutletId, s.own, refusal(run.id, "prefix_used"));
      const rows = await fullRows(s.cloudOutletId);
      expect(rowOf(rows, "P5").retired_reason).toBe("claim_rotated");
      expect(currentOf(rows, s.device.id).map((r) => r.prefix)).toEqual(["P6"]);
    });

    it("POS-06 a floor that would make the prefix longer than 12 characters falls back to the smallest free prefix", async () => {
      const s = await scenario();
      await cloudPull(s.cloudOutletId, s.own);
      const run = rowOf(await fullRows(s.cloudOutletId), "P1");
      await hfqClaim(
        s.cloudOutletId,
        s.own,
        refusal(run.id, "id_used"),
        new Map([["P99999999999", 1]]),
      );
      const rows = await fullRows(s.cloudOutletId);
      expect(rowOf(rows, "P1").retired_reason).toBe("claim_rotated");
      expect(currentOf(rows, s.device.id).map((r) => r.prefix)).toEqual(["P2"]);
    });

    it("POS-06 through the pull: report P7:3 and the id refusal give the edge P8, which it numbers P8-000001", async () => {
      const s = await refusedScenario("id_used");
      const page = await cloudPull(s.cloudOutletId, s.own, {
        refusals: s.refused.result.receiptRunRefusals,
        report: new Map([["P7", 3]]),
      });
      expect(page.receiptSequences?.map((x) => x.prefix)).toEqual(["P8"]);
    });
  });

  describe("a heal retirement is part of the clone alarm (A4)", () => {
    it("EDG-02 after the cloud healed P1 away (id_used), a request of the same binding reporting P1:3 raises receiptRunAlert", async () => {
      // Fix round 3 (F1): only an id_used heal stays in the clone check; a
      // prefix_used heal does not (see the F1 test below).
      const s = await scenario();
      await cloudPull(s.cloudOutletId, s.own);
      const run = rowOf(await fullRows(s.cloudOutletId), "P1");
      const healed = await cloudPull(s.cloudOutletId, s.own, {
        refusals: refusal(run.id, "id_used"),
      });
      expect(healed.receiptSequences?.map((x) => x.prefix)).toEqual(["P2"]);
      expect(healed.receiptRunAlert).not.toBe(true);
      expect(rowOf(await fullRows(s.cloudOutletId), "P1").retired_reason).toBe(
        "claim_rotated",
      );

      // A quiet request (the edge holds no number of the healed run): no alarm.
      const quiet = await cloudPull(s.cloudOutletId, s.own, {
        report: new Map(),
      });
      expect(quiet.receiptRunAlert).not.toBe(true);

      // A clone numbered P1 unreported; its later report is newer and higher.
      const clone = await cloudPull(s.cloudOutletId, s.own, {
        report: new Map([["P1", 3]]),
      });
      expect(clone.receiptRunAlert).toBe(true);
    });
  });

  describe("reports the cloud ignores", () => {
    /** One cloud run of device D claimed by (N, I). */
    async function claimed() {
      const s = await scenario();
      await cloudPull(s.cloudOutletId, s.own);
      const rows = await fullRows(s.cloudOutletId);
      const run = rowOf(rows, "P1");
      expect(run).toMatchObject({
        retired_at: null,
        edge_node_id: s.own.edgeNodeId,
        last_number: 0,
      });
      return { ...s, run, before: rows };
    }
    const sameRows = async (s: { cloudOutletId: string; before: FullRow[] }) =>
      expect(await fullRows(s.cloudOutletId)).toEqual(s.before);

    it("POS-06 a run the cloud already advanced (lastNumber > 0) is not rotated", async () => {
      const s = await claimed();
      await asOwnerTenant(tenant.tenantId, (c) =>
        c.query("UPDATE receipt_sequences SET last_number = 2 WHERE id = $1", [
          s.run.id,
        ]),
      );
      const before = await fullRows(s.cloudOutletId);
      // A report consistent with the cloud counter, so nothing else rotates.
      const result = await hfqClaim(
        s.cloudOutletId,
        s.own,
        refusal(s.run.id),
        new Map([["P1", 2]]),
      );
      expect(result.refusedRotated).toBe(0);
      expect(await fullRows(s.cloudOutletId)).toEqual(before);
    });

    it("POS-06 a run with an edge high-water (edge_reported_number > 0) is not rotated", async () => {
      const s = await claimed();
      await asOwnerTenant(tenant.tenantId, (c) =>
        c.query(
          "UPDATE receipt_sequences SET edge_reported_number = 4 WHERE id = $1",
          [s.run.id],
        ),
      );
      const before = await fullRows(s.cloudOutletId);
      // A report consistent with the high-water, so nothing else rotates.
      const result = await hfqClaim(
        s.cloudOutletId,
        s.own,
        refusal(s.run.id, "id_used"),
        new Map([["P1", 4]]),
      );
      expect(result.refusedRotated).toBe(0);
      expect(await fullRows(s.cloudOutletId)).toEqual(before);
    });

    it("POS-06 a run the edge reports as having numbers in the same request (receiptRuns > 0) is not rotated (id_used: on prefix_used that number is another row's)", async () => {
      const s = await claimed();
      await cloudPull(s.cloudOutletId, s.own, {
        report: new Map([["P1", 2]]),
        refusals: refusal(s.run.id, "id_used"),
      });
      const rows = await fullRows(s.cloudOutletId);
      expect(rows.map((r) => r.prefix)).toEqual(["P1"]);
      expect(rowOf(rows, "P1").retired_at).toBeNull();
      const reported = await asOwnerTenant(tenant.tenantId, (c) =>
        c.query<{ edge_reported_number: number }>(
          "SELECT edge_reported_number FROM receipt_sequences WHERE id = $1",
          [s.run.id],
        ),
      );
      expect(reported.rows[0]?.edge_reported_number).toBe(2);
    });

    it("POS-06 an unknown run id is ignored", async () => {
      const s = await claimed();
      const result = await hfqClaim(
        s.cloudOutletId,
        s.own,
        refusal(randomUUID()),
      );
      expect(result.refusedRotated).toBe(0);
      expect(result.refusedThrottled).toBe(0);
      await sameRows(s);
      const page = await cloudPull(s.cloudOutletId, s.own, {
        refusals: refusal(randomUUID(), "id_used"),
      });
      expect(page.receiptSequences?.map((x) => x.id)).toEqual([s.run.id]);
      await sameRows(s);
    });

    it("POS-06 a run bound to another node is not rotated by a standby's report", async () => {
      const s = await claimed();
      const standby = await insertNode(s.cloudOutletId, "standby");
      const standbyBinding: Binding = {
        edgeNodeId: standby,
        edgeInstanceId: randomUUID(),
      };
      const page = await cloudPull(s.cloudOutletId, standbyBinding, {
        refusals: refusal(s.run.id),
      });
      expect(page.receiptSequences ?? []).toEqual([]);
      await sameRows(s);
    });

    it("POS-06 a retired run is ignored (its replacement is not rotated either)", async () => {
      const s = await claimed();
      const stale = new Map<string, ReceiptRunRefusalReason>([
        [s.run.id, "prefix_used"],
      ]);
      await cloudPull(s.cloudOutletId, s.own, { refusals: stale });
      const afterRotation = await fullRows(s.cloudOutletId);
      expect(rowOf(afterRotation, "P1").retired_reason).toBe("claim_rotated");
      await cloudPull(s.cloudOutletId, s.own, { refusals: stale });
      expect(await fullRows(s.cloudOutletId)).toEqual(afterRotation);
    });

    it("POS-06 tenant isolation: the id of another tenant's run is ignored and that run is untouched", async () => {
      const s = await claimed();
      const foreignDevice = await enroll(other.outletId, "pos", other.tenantId);
      // Bind the other tenant's run to the SAME node/instance ids as ours.
      await asOwnerTenant(other.tenantId, (c) =>
        c.query(
          `UPDATE receipt_sequences SET edge_node_id = $3, edge_instance_id = $4
           WHERE tenant_id = $1 AND device_id = $2 AND retired_at IS NULL`,
          [
            other.tenantId,
            foreignDevice.id,
            s.own.edgeNodeId,
            s.own.edgeInstanceId,
          ],
        ),
      );
      const foreignRows = () =>
        asOwnerTenant(other.tenantId, async (c) => {
          const r = await c.query(
            `SELECT id, prefix, last_number, device_id, edge_node_id, edge_instance_id, retired_at, retired_reason
             FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix`,
            [other.tenantId, other.outletId],
          );
          return r.rows;
        });
      const before = await foreignRows();
      const foreign = before.find((r) => r.device_id === foreignDevice.id);
      expect(foreign).toMatchObject({
        retired_at: null,
        edge_node_id: s.own.edgeNodeId,
      });
      await cloudPull(s.cloudOutletId, s.own, {
        refusals: refusal(foreign.id as string),
      });
      expect(await foreignRows()).toEqual(before);
      await sameRows(s);
    });
  });

  it("POS-06 throttle: after RECEIPT_REFUSAL_ROTATIONS_MAX (10) claim_rotated retirements of the device on this node and instance in the window, a refused run is counted as throttled, kept, and raises the alert", async () => {
    expect(RECEIPT_REFUSAL_ROTATIONS_MAX).toBe(10);
    const s = await scenario();
    await cloudPull(s.cloudOutletId, s.own);
    for (let i = 1; i <= RECEIPT_REFUSAL_ROTATIONS_MAX; i += 1) {
      const current = currentOf(await fullRows(s.cloudOutletId), s.device.id);
      expect(current).toHaveLength(1);
      const result = await hfqClaim(
        s.cloudOutletId,
        s.own,
        refusal(current[0]!.id),
      );
      expect(result.refusedRotated).toBe(1);
      expect(result.refusedThrottled).toBe(0);
    }
    const before = await fullRows(s.cloudOutletId);
    expect(
      before.filter((r) => r.retired_reason === "claim_rotated"),
    ).toHaveLength(RECEIPT_REFUSAL_ROTATIONS_MAX);

    const stuck = currentOf(before, s.device.id)[0]!;
    const result = await hfqClaim(s.cloudOutletId, s.own, refusal(stuck.id));
    expect(result.refusedRotated).toBe(0);
    expect(result.refusedThrottled).toBe(1);
    // A device left without a run: the edge must show the alert (A6).
    expect(result.alert).toBe(true);
    // No further rotation: the same run stays current, no new row.
    const after = await fullRows(s.cloudOutletId);
    expect(after).toEqual(before);
    expect(currentOf(after, s.device.id)[0]!.id).toBe(stuck.id);

    // Through the pull API too: the run is still listed, unchanged.
    const page = await cloudPull(s.cloudOutletId, s.own, {
      refusals: refusal(stuck.id, "id_used"),
    });
    expect(page.receiptSequences?.map((x) => x.id)).toEqual([stuck.id]);
    expect(page.receiptRunAlert).toBe(true);
    expect(await fullRows(s.cloudOutletId)).toEqual(before);
  });

  it("POS-06 the throttle counts only this instance: claim_rotated runs of another instance of the same node do not count", async () => {
    const s = await scenario();
    const previous: Binding = {
      edgeNodeId: s.own.edgeNodeId,
      edgeInstanceId: randomUUID(),
    };
    await hfqClaim(s.cloudOutletId, previous);
    // The previous instance used up its rotations.
    for (let i = 1; i <= RECEIPT_REFUSAL_ROTATIONS_MAX; i += 1) {
      const [run] = currentOf(await fullRows(s.cloudOutletId), s.device.id);
      const healed = await hfqClaim(
        s.cloudOutletId,
        previous,
        refusal(run!.id),
      );
      expect(healed.refusedRotated).toBe(1);
    }
    // The rebuilt edge (same node, new instance) takes the run over: a normal
    // claim rotation of the previous instance's row.
    await hfqClaim(s.cloudOutletId, s.own);
    const rows = await fullRows(s.cloudOutletId);
    expect(
      rows.filter((r) => r.retired_reason === "claim_rotated").length,
    ).toBeGreaterThan(RECEIPT_REFUSAL_ROTATIONS_MAX);
    const mine = currentOf(rows, s.device.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ edge_instance_id: s.own.edgeInstanceId });

    const result = await hfqClaim(s.cloudOutletId, s.own, refusal(mine[0]!.id));
    expect(result.refusedThrottled).toBe(0);
    expect(result.refusedRotated).toBe(1);
    const after = await fullRows(s.cloudOutletId);
    expect(rowOf(after, mine[0]!.prefix).retired_reason).toBe("claim_rotated");
    expect(currentOf(after, s.device.id)).toHaveLength(1);
  });

  it("POS-06 the throttle is per device: another device of the node is still rotated", async () => {
    const s = await scenario();
    const second = await enroll(s.cloudOutletId, "pos");
    await cloudPull(s.cloudOutletId, s.own);
    for (let i = 1; i <= RECEIPT_REFUSAL_ROTATIONS_MAX; i += 1) {
      const [run] = currentOf(await fullRows(s.cloudOutletId), s.device.id);
      await hfqClaim(s.cloudOutletId, s.own, refusal(run!.id));
    }
    const rows = await fullRows(s.cloudOutletId);
    const other2 = currentOf(rows, second.id)[0]!;
    const result = await hfqClaim(
      s.cloudOutletId,
      s.own,
      new Map<string, ReceiptRunRefusalReason>([
        [currentOf(rows, s.device.id)[0]!.id, "prefix_used"],
        [other2.id, "prefix_used"],
      ]),
    );
    expect(result.refusedThrottled).toBe(1);
    expect(result.refusedRotated).toBe(1);
    const after = await fullRows(s.cloudOutletId);
    expect(rowOf(after, other2.prefix).retired_reason).toBe("claim_rotated");
  });

  // ---- fix round 2: the heal marker and the prefix_used report number --------
  //
  // Assumptions (derived from fix2 brief only): a heal row is exactly
  // `retired_reason = 'claim_rotated' AND retired_at = edge_reported_at`
  // (R1); on a `prefix_used` refusal the report number of the refused run's
  // prefix belongs to ANOTHER local row and is ignored (R2). `edge_reported_*`
  // are not in `fullRows`, so they are read directly here.

  type ReportCols = {
    prefix: string;
    retired_reason: string | null;
    retired_at: Date | null;
    edge_reported_number: number;
    edge_reported_at: Date | null;
  };
  function reportCols(outletId: string): Promise<ReportCols[]> {
    return asOwnerTenant(tenant.tenantId, async (client) => {
      const result = await client.query(
        `SELECT prefix, retired_reason, retired_at, edge_reported_number, edge_reported_at
         FROM receipt_sequences WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix`,
        [tenant.tenantId, outletId],
      );
      return result.rows as ReportCols[];
    });
  }
  const colsOf = (rows: ReportCols[], prefix: string): ReportCols => {
    const row = rows.find((r) => r.prefix === prefix);
    if (!row)
      throw new Error(`No sequence ${prefix} in ${JSON.stringify(rows)}`);
    return row;
  };

  it("EDG-02 POS-06 failover: a normal rotation by another instance does not count for the first instance's heal throttle, and its later higher report is no clone alarm (R1)", async () => {
    const s = await scenario();
    const second: Binding = {
      edgeNodeId: s.own.edgeNodeId,
      edgeInstanceId: randomUUID(),
    };
    // I1 claims the device's run and reports numbers on it.
    await cloudPull(s.cloudOutletId, s.own);
    await cloudPull(s.cloudOutletId, s.own, {
      report: new Map([["P1", 5]]),
    });
    // The standby-turned-primary I2 of the same node takes over: a normal
    // claim rotation. The retired P1 keeps its binding to I1.
    await cloudPull(s.cloudOutletId, second);
    const afterFailover = await fullRows(s.cloudOutletId);
    expect(rowOf(afterFailover, "P1")).toMatchObject({
      retired_reason: "claim_rotated",
      edge_instance_id: s.own.edgeInstanceId,
    });
    expect(rowOf(afterFailover, "P2")).toMatchObject({
      retired_at: null,
      edge_instance_id: second.edgeInstanceId,
    });

    // I1 comes back and reports a higher number for its old run: no alarm.
    const back = await cloudPull(s.cloudOutletId, s.own, {
      report: new Map([["P1", 7]]),
    });
    expect(back.receiptRunAlert).not.toBe(true);

    // I1's heal throttle is untouched by I2's rotation: it can still heal
    // RECEIPT_REFUSAL_ROTATIONS_MAX times.
    for (let i = 1; i <= RECEIPT_REFUSAL_ROTATIONS_MAX; i += 1) {
      const current = currentOf(await fullRows(s.cloudOutletId), s.device.id);
      expect(current).toHaveLength(1);
      expect(current[0]).toMatchObject({
        edge_instance_id: s.own.edgeInstanceId,
      });
      const result = await hfqClaim(
        s.cloudOutletId,
        s.own,
        refusal(current[0]!.id),
      );
      expect(result.refusedThrottled).toBe(0);
      expect(result.refusedRotated).toBe(1);
    }
  });

  it("POS-06 a heal row has retired_at = edge_reported_at; a normal rotation or an edge_regressed row does not", async () => {
    const s = await refusedScenario("id_used");
    await s.pull(s.refused.result.receiptRunRefusals);
    // A normal claim rotation by another instance of the same node.
    const second: Binding = {
      edgeNodeId: s.own.edgeNodeId,
      edgeInstanceId: randomUUID(),
    };
    await cloudPull(s.cloudOutletId, second);

    const cols = await reportCols(s.cloudOutletId);
    const healed = colsOf(cols, "P2");
    expect(healed.retired_reason).toBe("claim_rotated");
    expect(healed.retired_at).not.toBeNull();
    expect(healed.edge_reported_at).not.toBeNull();
    expect(healed.retired_at?.getTime()).toBe(
      healed.edge_reported_at?.getTime(),
    );

    const regressed = colsOf(cols, "P1");
    expect(regressed.retired_reason).toBe("edge_regressed");
    expect(regressed.retired_at?.getTime()).not.toBe(
      regressed.edge_reported_at?.getTime(),
    );

    // P3 (the heal's replacement) was retired by the failover rotation.
    const rotated = colsOf(cols, "P3");
    expect(rotated.retired_reason).toBe("claim_rotated");
    expect(rotated.retired_at?.getTime()).not.toBe(
      rotated.edge_reported_at?.getTime(),
    );
  });

  it("POS-06 prefix_used with a report number for the refused prefix (another local run, P3:4): the heal still runs above the floor and the healed row's edge_reported_number stays 0", async () => {
    const s = await scenario();
    await cloudPull(s.cloudOutletId, s.own);
    const run = rowOf(await fullRows(s.cloudOutletId), "P1");
    await asOwnerTenant(tenant.tenantId, (c) =>
      c.query("UPDATE receipt_sequences SET prefix = 'P3' WHERE id = $1", [
        run.id,
      ]),
    );

    const result = await hfqClaim(
      s.cloudOutletId,
      s.own,
      refusal(run.id, "prefix_used"),
      new Map([["P3", 4]]),
    );
    expect(result.refusedRotated).toBe(1);
    expect(result.refusedThrottled).toBe(0);

    const rows = await fullRows(s.cloudOutletId);
    expect(rowOf(rows, "P3").retired_reason).toBe("claim_rotated");
    // New prefix above the refused run's own number and the report's P3.
    const current = currentOf(rows, s.device.id);
    expect(current).toHaveLength(1);
    expect(Number(current[0]!.prefix.slice(1))).toBeGreaterThan(3);
    expect(current[0]).toMatchObject({
      last_number: 0,
      edge_instance_id: s.own.edgeInstanceId,
    });

    const cols = await reportCols(s.cloudOutletId);
    expect(colsOf(cols, "P3").edge_reported_number).toBe(0);
    expect(colsOf(cols, current[0]!.prefix).edge_reported_number).toBe(0);
  });

  it("POS-06 prefix_used throttled: the foreign report number is not taken as the run's high-water and the run is not rotated as edge_regressed", async () => {
    const s = await scenario();
    await cloudPull(s.cloudOutletId, s.own);
    for (let i = 1; i <= RECEIPT_REFUSAL_ROTATIONS_MAX; i += 1) {
      const [run] = currentOf(await fullRows(s.cloudOutletId), s.device.id);
      const healed = await hfqClaim(s.cloudOutletId, s.own, refusal(run!.id));
      expect(healed.refusedRotated).toBe(1);
    }
    const stuck = currentOf(await fullRows(s.cloudOutletId), s.device.id)[0]!;
    const beforeRows = await fullRows(s.cloudOutletId);
    const beforeCols = await reportCols(s.cloudOutletId);
    expect(colsOf(beforeCols, stuck.prefix).edge_reported_number).toBe(0);

    // The report number for the stuck prefix is another local run's number.
    const foreign = new Map([[stuck.prefix, 4]]);
    const result = await hfqClaim(
      s.cloudOutletId,
      s.own,
      refusal(stuck.id, "prefix_used"),
      foreign,
    );
    expect(result.refusedRotated).toBe(0);
    expect(result.refusedThrottled).toBe(1);
    expect(await fullRows(s.cloudOutletId)).toEqual(beforeRows);
    expect(
      colsOf(await reportCols(s.cloudOutletId), stuck.prefix),
    ).toMatchObject({
      edge_reported_number: 0,
      retired_at: null,
      retired_reason: null,
    });

    // Through the pull API, then a plain report-only request: still no
    // high-water, so a later lower report cannot look like a regression.
    const page = await cloudPull(s.cloudOutletId, s.own, {
      refusals: refusal(stuck.id, "prefix_used"),
      report: foreign,
    });
    expect(page.receiptSequences?.map((x) => x.id)).toEqual([stuck.id]);
    await cloudPull(s.cloudOutletId, s.own, {
      report: new Map([[stuck.prefix, 1]]),
    });
    const rows = await fullRows(s.cloudOutletId);
    expect(rows.some((r) => r.retired_reason === "edge_regressed")).toBe(false);
    expect(currentOf(rows, s.device.id)[0]!.id).toBe(stuck.id);
  });

  // ---- fix round 3: prefix_used heal retires 1 ms after the report ----------
  //
  // Assumptions (derived from fix3 brief only): an id_used heal has
  // `retired_at = edge_reported_at`; a prefix_used heal has `retired_at =
  // edge_reported_at + 1 ms`. The clone check counts only the first kind; the
  // heal throttle counts both. For a prefix_used refusal the edge keeps
  // reporting the refused prefix for its OTHER local run, so that report is
  // never a clone.

  it("POS-06 F1 a prefix_used heal is no clone alarm: the edge keeps reporting the prefix of its other local run (P3:4, then P3:6) and no later pull raises receiptRunAlert", async () => {
    const s = await scenario();
    await cloudPull(s.cloudOutletId, s.own);
    const run = rowOf(await fullRows(s.cloudOutletId), "P1");
    await asOwnerTenant(tenant.tenantId, (c) =>
      c.query("UPDATE receipt_sequences SET prefix = 'P3' WHERE id = $1", [
        run.id,
      ]),
    );
    const result = await hfqClaim(
      s.cloudOutletId,
      s.own,
      refusal(run.id, "prefix_used"),
      new Map([["P3", 4]]),
    );
    expect(result.refusedRotated).toBe(1);
    expect(result.alert).not.toBe(true);
    const healedRows = await fullRows(s.cloudOutletId);
    expect(rowOf(healedRows, "P3").retired_reason).toBe("claim_rotated");
    const replacement = currentOf(healedRows, s.device.id);
    expect(replacement).toHaveLength(1);

    // Follow-up pulls (newer report token), same report, no refusals.
    const again = await cloudPull(s.cloudOutletId, s.own, {
      report: new Map([["P3", 4]]),
    });
    expect(again.receiptRunAlert).not.toBe(true);
    // The other local run keeps selling: a higher number is no alarm either.
    const higher = await cloudPull(s.cloudOutletId, s.own, {
      report: new Map([["P3", 6]]),
    });
    expect(higher.receiptRunAlert).not.toBe(true);

    // The device keeps its one healed run; nothing was rotated or regressed.
    const rows = await fullRows(s.cloudOutletId);
    expect(rows.some((r) => r.retired_reason === "edge_regressed")).toBe(false);
    const current = currentOf(rows, s.device.id);
    expect(current.map((r) => r.id)).toEqual([replacement[0]!.id]);
  });

  it("POS-06 F1 heal marker columns: an id_used heal has retired_at = edge_reported_at, a prefix_used heal has retired_at - edge_reported_at = 1 ms", async () => {
    const byId = await scenario();
    await cloudPull(byId.cloudOutletId, byId.own);
    const idRun = rowOf(await fullRows(byId.cloudOutletId), "P1");
    const idHeal = await hfqClaim(
      byId.cloudOutletId,
      byId.own,
      refusal(idRun.id, "id_used"),
    );
    expect(idHeal.refusedRotated).toBe(1);
    const idCols = colsOf(await reportCols(byId.cloudOutletId), "P1");
    expect(idCols.retired_reason).toBe("claim_rotated");
    expect(idCols.retired_at).not.toBeNull();
    expect(idCols.edge_reported_at).not.toBeNull();
    expect(
      idCols.retired_at!.getTime() - idCols.edge_reported_at!.getTime(),
    ).toBe(0);

    const byPrefix = await scenario();
    await cloudPull(byPrefix.cloudOutletId, byPrefix.own);
    const prefixRun = rowOf(await fullRows(byPrefix.cloudOutletId), "P1");
    const prefixHeal = await hfqClaim(
      byPrefix.cloudOutletId,
      byPrefix.own,
      refusal(prefixRun.id, "prefix_used"),
    );
    expect(prefixHeal.refusedRotated).toBe(1);
    const prefixCols = colsOf(await reportCols(byPrefix.cloudOutletId), "P1");
    expect(prefixCols.retired_reason).toBe("claim_rotated");
    expect(prefixCols.retired_at).not.toBeNull();
    expect(prefixCols.edge_reported_at).not.toBeNull();
    expect(
      prefixCols.retired_at!.getTime() - prefixCols.edge_reported_at!.getTime(),
    ).toBe(1);
  });

  it("POS-06 F2 a prefix_used refused run whose edge_reported_number is already raised (> 0, lastNumber 0) is still healed: a new prefix above the floor and the device sells after apply", async () => {
    const s = await refusedScenario("prefix_used");
    // The edge's other local run P2 was reported on the normal path before
    // (the old yd0h8 path): the cloud row P2 (the refused run) was raised.
    await cloudPull(s.cloudOutletId, s.own, { report: new Map([["P2", 3]]) });
    const before = colsOf(await reportCols(s.cloudOutletId), "P2");
    expect(before.edge_reported_number).toBeGreaterThan(0);
    expect(rowOf(await fullRows(s.cloudOutletId), "P2")).toMatchObject({
      last_number: 0,
      retired_at: null,
    });
    await expectCannotSell(s);

    // The refusal arrives with the edge's (unchanged) report of P2.
    const healed = await cloudPull(s.cloudOutletId, s.own, {
      refusals: refusal(s.replacement.id, "prefix_used"),
      report: new Map([["P2", 3]]),
    });
    expect(healed.receiptSequences).toHaveLength(1);
    expect(healed.receiptSequences?.[0]).toMatchObject({
      deviceId: s.device.id,
      prefix: "P3",
      lastNumber: 0,
      edgeNodeId: s.own.edgeNodeId,
      edgeInstanceId: s.own.edgeInstanceId,
    });
    expect(healed.receiptRunAlert).not.toBe(true);
    const rows = await fullRows(s.cloudOutletId);
    expect(rowOf(rows, "P2").retired_reason).toBe("claim_rotated");
    expect(currentOf(rows, s.device.id).map((r) => r.prefix)).toEqual(["P3"]);

    // Apply on the edge: the device sells under the new prefix.
    await edgeApply(s.edgeOutletId, s.ship(healed), s.own);
    expect(await edgeSell(s.edgeOutletId, s.device.id)).toBe("P3-000001");
  });

  it("POS-06 F1 throttle: RECEIPT_REFUSAL_ROTATIONS_MAX (10) prefix_used heals in the window still count, the next refusal is throttled, kept, and raises the alert", async () => {
    const s = await scenario();
    await cloudPull(s.cloudOutletId, s.own);
    for (let i = 1; i <= RECEIPT_REFUSAL_ROTATIONS_MAX; i += 1) {
      const [run] = currentOf(await fullRows(s.cloudOutletId), s.device.id);
      const healed = await hfqClaim(
        s.cloudOutletId,
        s.own,
        refusal(run!.id, "prefix_used"),
      );
      expect(healed.refusedRotated).toBe(1);
      expect(healed.refusedThrottled).toBe(0);
    }
    const before = await fullRows(s.cloudOutletId);
    expect(
      before.filter((r) => r.retired_reason === "claim_rotated"),
    ).toHaveLength(RECEIPT_REFUSAL_ROTATIONS_MAX);
    const stuck = currentOf(before, s.device.id)[0]!;

    const result = await hfqClaim(
      s.cloudOutletId,
      s.own,
      refusal(stuck.id, "prefix_used"),
    );
    expect(result.refusedRotated).toBe(0);
    expect(result.refusedThrottled).toBe(1);
    expect(result.alert).toBe(true);
    expect(await fullRows(s.cloudOutletId)).toEqual(before);

    const page = await cloudPull(s.cloudOutletId, s.own, {
      refusals: refusal(stuck.id, "prefix_used"),
    });
    expect(page.receiptSequences?.map((x) => x.id)).toEqual([stuck.id]);
    expect(page.receiptRunAlert).toBe(true);
  });

  it("POS-06 F1 throttle: prefix_used (1 ms marker) and id_used (0 ms marker) heals are counted together", async () => {
    const s = await scenario();
    await cloudPull(s.cloudOutletId, s.own);
    for (let i = 1; i <= RECEIPT_REFUSAL_ROTATIONS_MAX; i += 1) {
      const [run] = currentOf(await fullRows(s.cloudOutletId), s.device.id);
      const healed = await hfqClaim(
        s.cloudOutletId,
        s.own,
        refusal(run!.id, i % 2 === 0 ? "prefix_used" : "id_used"),
      );
      expect(healed.refusedRotated).toBe(1);
    }
    const before = await fullRows(s.cloudOutletId);
    const stuck = currentOf(before, s.device.id)[0]!;
    const result = await hfqClaim(
      s.cloudOutletId,
      s.own,
      refusal(stuck.id, "prefix_used"),
    );
    expect(result.refusedRotated).toBe(0);
    expect(result.refusedThrottled).toBe(1);
    expect(await fullRows(s.cloudOutletId)).toEqual(before);
  });

  describe("the receiptRefused query parameter is parsed strictly", () => {
    const parse = (receiptRefused: string) =>
      deviceSyncQuerySchema.safeParse({
        limit: 100,
        receiptSequences: "1",
        receiptRefused,
      });
    const entry = (reason = "prefix_used") => `${randomUUID()}:${reason}`;
    const many = (n: number) =>
      Array.from({ length: n }, () => entry()).join(",");

    it("EDG-02 accepts the empty report and valid entries, keeps the string, and round-trips with the codec", () => {
      expect(parse("").success).toBe(true);
      const a = randomUUID();
      const b = randomUUID();
      const value = `${a}:prefix_used,${b}:id_used`;
      const ok = deviceSyncQuerySchema.parse({
        limit: 100,
        receiptSequences: "1",
        receiptRefused: value,
      });
      expect(ok.receiptRefused).toBe(value);
      // A second parse (route, then service) accepts the first one's output.
      expect(deviceSyncQuerySchema.parse(ok)).toEqual(ok);
      expect(decodeReceiptRunRefusals(value)).toEqual(
        new Map<string, ReceiptRunRefusalReason>([
          [a, "prefix_used"],
          [b, "id_used"],
        ]),
      );
      expect(
        decodeReceiptRunRefusals(
          encodeReceiptRunRefusals(refusal(a, "id_used")),
        ),
      ).toEqual(refusal(a, "id_used"));
      expect(parse(many(50)).success).toBe(true);
      // Ids are case-insensitive.
      expect(parse(`${a.toUpperCase()}:id_used`).success).toBe(true);
    });

    it("EDG-02 refuses a bad uuid, a bad reason, a missing reason, a duplicate id and more than 50 entries", () => {
      const id = randomUUID();
      expect(parse("not-a-uuid:prefix_used").success).toBe(false);
      expect(parse(`${id}:other_reason`).success).toBe(false);
      expect(parse(`${id}:`).success).toBe(false);
      expect(parse(id).success).toBe(false);
      expect(parse(`${id}:prefix_used,${id}:id_used`).success).toBe(false);
      expect(
        parse(`${id}:prefix_used,${id.toUpperCase()}:prefix_used`).success,
      ).toBe(false);
      expect(parse(`${id}:prefix_used,`).success).toBe(false);
      expect(parse(many(51)).success).toBe(false);
    });
  });
});
