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
  deviceSyncPageSchema,
  type DeviceReceiptSequenceBinding,
  type DeviceReceiptSequenceSync,
  type DeviceSyncPage,
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
  deviceSyncQuerySchema,
  listDeviceRecordsSince,
  pullDeviceRegistry,
} from "../services/edge-device-sync.ts";
import { setPosReceiptPort } from "../services/pos-order-ports.ts";
import {
  allocateReceipt,
  createPosReceiptPort,
  listDeviceReceiptSequences,
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
