// Device receipt sequences provisioned by the cloud and pulled to the edge
// (bead legend-3yqy, part of legend-ain0 note 2; PRD v1.7 §3 F8 "Nomor Struk
// Berurutan ... termasuk saat offline", POS-06, EDG-02).
//
// Before this change nothing provisioned a device sequence outside tests and
// the device pull carried none, so an edge sale on any device failed with
// RECEIPT_SEQUENCE_NOT_PROVISIONED.
//
// Real PostgreSQL with RLS (disposable server from `pnpm test`), isolated
// tenants, the REAL receipt port. Setup helpers are copied from
// pos-receipt-kfix.test.ts (not edited). As in device-edge.test.ts, the "edge"
// database is the cloud database: an edge insert is proven with a sequence the
// database has not seen yet (sequence rows can never be deleted, POS-06).
//
// Decisions (lead + architect review):
//  - Devices that can create a POS order get a sequence at enroll: the PIN
//    terminals pos, kds, waiter_phone (an order takes the receipt of the
//    device that created it). printer and the other types get none.
//  - The device pull page carries `receiptSequences` (the whole outlet list)
//    after a backfill of active order-taking devices without one; revoked
//    devices get none.
//  - Edge: a missing row is inserted with the cloud's id, prefix and
//    lastNumber; an existing row is never touched; a prefix mismatch skips only
//    that sequence, the rest of the pull applies, and the error is logged
//    without device data.
//
// Review K fixes (S-K1, legend-3yqy):
//  - A missing row is inserted only when the cloud's lastNumber is 0 (at 0).
//    Cloud lastNumber > 0 and no edge row: refused (the edge holds none of
//    1..L, so the gap check would refuse Tutup Hari forever); the terminal is
//    re-enrolled for a fresh prefix.
//  - Cloud mode refuses a device-keyed sale while the outlet has an active
//    edge node (RECEIPT_DEVICE_ON_EDGE): that device numbers on the edge.
//  - A standby edge never applies pulled sequences.
//  - The cloud adds `receiptSequences` only for `?receiptSequences=1`. On the
//    edge any sequence error is counted and logged, never stops the device
//    records or later pages.
//
// legend-zsdd (a sequence lives in exactly ONE database; T2 update of this file):
//  - A pulled sequence carries edgeNodeId + edgeInstanceId. The cloud claims
//    and lists sequences only for an ACTIVE PRIMARY node that sent its
//    `edgeInstance`; any other puller gets []. The tests therefore register
//    an active primary node row (`activeEdge`) wherever the cloud lists.
//  - The edge applies with its own binding (`own`). A pulled prefix/id change
//    for a device with a local current run is now `replaced` (old run retired),
//    no longer `refused`; a sequence bound to another database is `refused`.

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
import { logger } from "../lib/logger.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { enrollDevice, revokeDevice } from "../services/device.service.ts";
import {
  deviceSyncQuerySchema,
  listDeviceRecordsSince,
  pullDeviceRegistry,
} from "../services/edge-device-sync.ts";
import { setPosReceiptPort } from "../services/pos-order-ports.ts";
import {
  allocateReceipt,
  createPosReceiptPort,
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
  edge_node_id: string | null;
  edge_instance_id: string | null;
  retired_at: Date | null;
};

function sequenceRows(
  outletId: string,
  tenantId = tenant.tenantId,
): Promise<SequenceRow[]> {
  return asOwnerTenant(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, prefix, last_number, device_id, edge_node_id, edge_instance_id, retired_at
       FROM receipt_sequences
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
  // The CURRENT (not retired) run of the device (legend-zsdd).
  return (await sequenceRows(outletId)).find(
    (r) => r.device_id === deviceId && r.retired_at === null,
  );
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

/** A registry row written the way it was before legend-3yqy: no sequence. */
async function legacyDevice(
  outletId: string,
  status: "active" | "revoked" = "active",
): Promise<string> {
  const deviceId = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, status, revoked_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir lama', now(), $4, $5)`,
      [
        deviceId,
        tenant.tenantId,
        outletId,
        status,
        status === "revoked" ? new Date() : null,
      ],
    ),
  );
  return deviceId;
}

const nodeOf = (
  outletId: string,
  tenantId = tenant.tenantId,
  edgeNodeId: string = randomUUID(),
) => ({
  tenantId: tenantId as TenantId,
  outletId: outletIdSchema.parse(outletId),
  edgeNodeId,
});

/** An edge database as the cloud sees it: node id + the instance it sends. */
type EdgeIdentity = DeviceReceiptSequenceBinding;

/**
 * A page as a current edge asks for it (`?receiptSequences=1`). With `edge`
 * the puller is that node and sends its instance (legend-zsdd); without it the
 * node is unknown to the registry and the cloud lists and claims nothing.
 */
function cloudPage(
  outletId: string,
  tenantId = tenant.tenantId,
  receiptSequences: "1" | null = "1",
  edge?: EdgeIdentity,
): Promise<DeviceSyncPage> {
  return listDeviceRecordsSince(
    nodeOf(outletId, tenantId, edge?.edgeNodeId),
    deviceSyncQuerySchema.parse({
      limit: 100,
      receiptSequences: receiptSequences ?? undefined,
      edgeInstance: edge?.edgeInstanceId,
    }),
    { now: new Date(Date.now() + 10 * 60_000), settleMs: 0 },
  );
}

/** The edge pulls one page the cloud would have sent. */
async function edgePull(
  outletId: string,
  page: unknown,
  role: "primary" | "standby" = "primary",
  binding: DeviceReceiptSequenceBinding = OWN,
) {
  await localEdgeNode(outletId, binding, role);
  return pullDeviceRegistry({
    context: edgeScope(outletId),
    role,
    binding,
    fetchPage: async () => page,
  });
}

/** The edge database applying the pulls below (legend-zsdd). */
const OWN: DeviceReceiptSequenceBinding = {
  edgeNodeId: randomUUID(),
  edgeInstanceId: randomUUID(),
};

/**
 * This edge database's own `edge_nodes` row (id = node id, `instance_id` = its
 * instance), as `ensureLocalEdgeNode` writes it (legend-zsdd). An edge
 * allocation honours a sequence binding only when this row matches it, so every
 * edge-side pull below registers it first. Copied from pos-receipt-seq-edge.test.ts.
 */
async function localEdgeNode(
  outletId: string,
  own: DeviceReceiptSequenceBinding,
  role: "primary" | "standby" = "primary",
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, instance_id)
       VALUES ($1, $2, $3, $4, 'active', 'Server lokal', $5, $6)
       ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id`,
      [
        own.edgeNodeId,
        tenant.tenantId,
        outletId,
        role,
        "b".repeat(64),
        own.edgeInstanceId,
      ],
    ),
  );
}

/** An edge node row of the outlet in the cloud registry (owner SQL). */
async function edgeNodeAt(
  outletId: string,
  status: "active" | "revoked" = "active",
  tenantId = tenant.tenantId,
  role: "primary" | "standby" = "primary",
): Promise<string> {
  const id = randomUUID();
  await asOwnerTenant(tenantId, (client) =>
    client.query(
      `INSERT INTO edge_nodes (id, tenant_id, outlet_id, role, status, label, credential_hash, revoked_at)
       VALUES ($1, $2, $3, $4, $5, 'Server lokal', $6, $7)`,
      [
        id,
        tenantId,
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

/** The active primary node of the outlet plus a fresh database instance. */
async function activeEdge(
  outletId: string,
  tenantId = tenant.tenantId,
): Promise<EdgeIdentity> {
  return {
    edgeNodeId: await edgeNodeAt(outletId, "active", tenantId),
    edgeInstanceId: randomUUID(),
  };
}

/** A cloud revocation record of `deviceId`, with the edge row not yet revoked. */
async function revocationOf(outletId: string, deviceId: string) {
  const cloud = await cloudPage(outletId);
  const record = cloud.data.find((d) => d.id === deviceId)!;
  const revokedAt = new Date().toISOString();
  // The "edge" database is the cloud one: drop the row so the record inserts.
  await asOwnerTenant(tenant.tenantId, (c) =>
    c.query("DELETE FROM devices WHERE id = $1", [deviceId]),
  );
  return {
    ...record,
    status: "revoked" as const,
    revokedAt,
    updatedAt: revokedAt,
  };
}

async function deviceStatus(deviceId: string): Promise<string | undefined> {
  const [row] = await asOwnerTenant(
    tenant.tenantId,
    async (c) =>
      (await c.query("SELECT status FROM devices WHERE id = $1", [deviceId]))
        .rows,
  );
  return (row as { status?: string } | undefined)?.status;
}

function receiptCount(outletId: string): Promise<number> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM pos_receipts WHERE tenant_id = $1 AND outlet_id = $2",
      [tenant.tenantId, outletId],
    );
    return result.rows[0].n as number;
  });
}

function pageWith(
  sequences: DeviceReceiptSequenceSync[],
  data: unknown[] = [],
): DeviceSyncPage {
  return deviceSyncPageSchema.parse({
    data,
    receiptSequences: sequences,
    meta: { limit: 100, nextCursor: null, watermark: null },
  });
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

// ---- Cloud provisioning ------------------------------------------------------

describe("POS-06 cloud provisions a device receipt sequence at enroll (legend-3yqy)", () => {
  it("POS-06 the first order-taking device of an outlet gets P1, the second P2, in the enroll transaction", async () => {
    const outletId = await freshOutlet();
    const first = await enroll(outletId, "pos");
    const second = await enroll(outletId, "pos");
    expect(await sequenceOf(outletId, first.id)).toMatchObject({
      prefix: "P1",
      last_number: 0,
    });
    expect(await sequenceOf(outletId, second.id)).toMatchObject({
      prefix: "P2",
      last_number: 0,
    });
  });

  it("POS-06 kds and waiter_phone can create an order, so they get a sequence too", async () => {
    const outletId = await freshOutlet();
    const kds = await enroll(outletId, "kds");
    const waiter = await enroll(outletId, "waiter_phone");
    expect((await sequenceOf(outletId, kds.id))?.prefix).toBe("P1");
    expect((await sequenceOf(outletId, waiter.id))?.prefix).toBe("P2");
  });

  it("POS-06 a device that cannot take an order (printer, display, edc) gets no sequence", async () => {
    const outletId = await freshOutlet();
    await enroll(outletId, "printer");
    await enroll(outletId, "display");
    await enroll(outletId, "edc");
    expect(await sequenceRows(outletId)).toEqual([]);
  });

  it("POS-06 an enroll replay keeps the one sequence the device already has", async () => {
    const outletId = await freshOutlet();
    const idempotencyKey = randomUUID();
    const input = {
      outletId,
      type: "pos" as const,
      label: "Kasir ulang",
      stationId: null,
      idempotencyKey,
    };
    const { device } = await enrollDevice(cloudScope(outletId), actor, input);
    await enrollDevice(cloudScope(outletId), actor, input);
    expect(await sequenceRows(outletId)).toEqual([
      expect.objectContaining({ device_id: device.id, prefix: "P1" }),
    ]);
  });
});

// ---- Pull ----------------------------------------------------------------------

describe("EDG-02 POS-06 the device pull carries the outlet's receipt sequences (legend-3yqy)", () => {
  it("EDG-02 the pull lists every device sequence of the outlet with id, prefix and lastNumber, never the cloud sequence C", async () => {
    const outletId = await freshOutlet();
    const device = await enroll(outletId, "pos");
    const [order] = [await draftOrder(outletId)];
    // A cloud sale without a device creates the outlet-owned sequence C.
    await inTx((tx, context) =>
      allocateReceipt(tx, context, {
        orderId: order!,
        outletId,
        deviceId: null,
        at: new Date(),
      }),
    );
    const row = await sequenceOf(outletId, device.id);
    const edge = await activeEdge(outletId);
    const page = await cloudPage(outletId, tenant.tenantId, "1", edge);
    // legend-zsdd: the listed sequence says which edge database holds it.
    expect(page.receiptSequences).toEqual([
      {
        id: row!.id,
        outletId,
        deviceId: device.id,
        prefix: "P1",
        lastNumber: 0,
        edgeNodeId: edge.edgeNodeId,
        edgeInstanceId: edge.edgeInstanceId,
      },
    ]);
  });

  it("POS-06 a device enrolled before this change is backfilled by the pull, even when its row is older than the cursor", async () => {
    const outletId = await freshOutlet();
    const legacy = await legacyDevice(outletId);
    expect(await sequenceOf(outletId, legacy)).toBeUndefined();
    const edge = await activeEdge(outletId);
    const first = await cloudPage(outletId, tenant.tenantId, "1", edge);
    // Pull again from the watermark: the device row is not in `data`, the
    // sequence still is.
    const again = await listDeviceRecordsSince(
      nodeOf(outletId, tenant.tenantId, edge.edgeNodeId),
      {
        limit: 100,
        since: first.meta.watermark ?? undefined,
        receiptSequences: "1",
        edgeInstance: edge.edgeInstanceId,
      },
      { now: new Date(Date.now() + 10 * 60_000), settleMs: 0 },
    );
    expect(again.data.map((d) => d.id)).not.toContain(legacy);
    const row = await sequenceOf(outletId, legacy);
    expect(row?.prefix).toBe("P1");
    expect(first.receiptSequences?.map((s) => s.deviceId)).toEqual([legacy]);
    expect(again.receiptSequences?.map((s) => s.deviceId)).toEqual([legacy]);
  });

  it("POS-06 a revoked device gets no new sequence, enrolled or legacy", async () => {
    const outletId = await freshOutlet();
    await legacyDevice(outletId, "revoked");
    const live = await enroll(outletId, "pos");
    await revokeDevice(cloudScope(outletId), actor, {
      deviceId: live.id,
      reason: "Hilang",
    });
    await cloudPage(outletId, tenant.tenantId, "1", await activeEdge(outletId));
    // Only the sequence made while `live` was active.
    expect(await sequenceRows(outletId)).toEqual([
      expect.objectContaining({ device_id: live.id, prefix: "P1" }),
    ]);
  });

  it("TEN-01 TEN-03 a node of tenant B never sees tenant A's sequences and cannot pull A's outlet", async () => {
    const outletId = await freshOutlet();
    const device = await enroll(outletId, "pos");
    await enroll(other.outletId, "pos", other.tenantId);
    const mine = await cloudPage(
      outletId,
      tenant.tenantId,
      "1",
      await activeEdge(outletId),
    );
    const theirs = await cloudPage(
      other.outletId,
      other.tenantId,
      "1",
      await activeEdge(other.outletId, other.tenantId),
    );
    expect(mine.receiptSequences?.map((s) => s.deviceId)).toEqual([device.id]);
    expect(theirs.receiptSequences?.length).toBe(1);
    expect(
      theirs.receiptSequences?.some(
        (s) => s.deviceId === device.id || s.outletId === outletId,
      ),
    ).toBe(false);
    await expect(cloudPage(outletId, other.tenantId)).rejects.toThrow();
  });

  it("legend-zsdd a standby node, or an active primary that sends no instance, gets no sequences and claims none", async () => {
    const outletId = await freshOutlet();
    const device = await enroll(outletId, "pos");
    const primary = await activeEdge(outletId);
    const standby: EdgeIdentity = {
      edgeNodeId: await edgeNodeAt(
        outletId,
        "active",
        tenant.tenantId,
        "standby",
      ),
      edgeInstanceId: randomUUID(),
    };
    const asStandby = await cloudPage(outletId, tenant.tenantId, "1", standby);
    const noInstance = await cloudPage(outletId, tenant.tenantId, "1", {
      ...primary,
      edgeInstanceId: undefined as never,
    });
    expect(asStandby.receiptSequences).toEqual([]);
    expect(noInstance.receiptSequences).toEqual([]);
    expect(await sequenceOf(outletId, device.id)).toMatchObject({
      prefix: "P1",
      edge_node_id: null,
      edge_instance_id: null,
    });
    // The active primary that sends its instance claims the unissued run.
    const claimed = await cloudPage(outletId, tenant.tenantId, "1", primary);
    expect(claimed.receiptSequences?.map((s) => s.deviceId)).toEqual([
      device.id,
    ]);
    expect(await sequenceOf(outletId, device.id)).toMatchObject({
      prefix: "P1",
      edge_node_id: primary.edgeNodeId,
      edge_instance_id: primary.edgeInstanceId,
    });
  });
});

// ---- Edge apply ---------------------------------------------------------------

describe("EDG-02 POS-06 the edge applies pulled receipt sequences (legend-3yqy)", () => {
  /** A sequence the database has not seen: what a fresh edge receives. */
  function unseen(
    outletId: string,
    prefix: string,
    lastNumber = 0,
  ): DeviceReceiptSequenceSync {
    return {
      id: randomUUID(),
      outletId: outletIdSchema.parse(outletId),
      deviceId: randomUUID(),
      prefix,
      lastNumber,
      // Bound to this edge database (legend-zsdd).
      ...OWN,
    };
  }

  it("POS-06 an edge with the pulled sequence sells on it offline (before: RECEIPT_SEQUENCE_NOT_PROVISIONED)", async () => {
    const outletId = await freshOutlet();
    const sequence = unseen(outletId, "P7");
    const orderId = await draftOrder(outletId);
    await inEdgeMode(() => edgePull(outletId, pageWith([sequence])));
    expect(await sequenceOf(outletId, sequence.deviceId)).toMatchObject({
      id: sequence.id,
      prefix: "P7",
      last_number: 0,
    });
    const receipt = await inEdgeMode(() =>
      allocate(outletId, orderId, sequence.deviceId),
    );
    expect(receipt).toMatchObject({
      number: "P7-000001",
      deviceId: sequence.deviceId,
    });
  });

  it("POS-06 S-K1 an edge with no row refuses a sequence the cloud already advanced (lastNumber 40): not inserted, counted", async () => {
    const outletId = await freshOutlet();
    const advanced = unseen(outletId, "P8", 40);
    const fresh = unseen(outletId, "P6", 0);
    const result = await inEdgeMode(() =>
      edgePull(outletId, pageWith([advanced, fresh])),
    );
    expect(result.receiptSequencesRefused).toBe(1);
    expect(await sequenceOf(outletId, advanced.deviceId)).toBeUndefined();
    expect(await sequenceOf(outletId, fresh.deviceId)).toMatchObject({
      prefix: "P6",
      last_number: 0,
    });
  });

  it("POS-06 a re-pull never resets the edge counter (existing row untouched)", async () => {
    const outletId = await freshOutlet();
    const sequence = unseen(outletId, "P3");
    const [a, b] = [await draftOrder(outletId), await draftOrder(outletId)];
    await inEdgeMode(() => edgePull(outletId, pageWith([sequence])));
    await inEdgeMode(() => allocate(outletId, a, sequence.deviceId));
    await inEdgeMode(() => allocate(outletId, b, sequence.deviceId));
    await inEdgeMode(() => edgePull(outletId, pageWith([sequence])));
    expect((await sequenceOf(outletId, sequence.deviceId))?.last_number).toBe(
      2,
    );
  });

  it("POS-06 a refused sequence skips only that sequence, the rest of the pull applies, and the log names no device", async () => {
    const outletId = await freshOutlet();
    const kept = unseen(outletId, "P4");
    await inEdgeMode(() => edgePull(outletId, pageWith([kept])));
    const errors = vi.spyOn(logger, "error");
    const warns = vi.spyOn(logger, "warn");

    // legend-zsdd changed this case: the same device with another prefix is no
    // longer refused, it REPLACES the local run (see the replaced test). The
    // refusal that remains here is a sequence bound to ANOTHER edge database.
    const clash = {
      ...unseen(outletId, "P9"),
      edgeInstanceId: randomUUID(),
    };
    const fresh = unseen(outletId, "P5");
    const device = await enroll(outletId, "printer");
    const cloud = await cloudPage(outletId);
    const record = cloud.data.find((d) => d.id === device.id)!;
    const revokedAt = new Date().toISOString();
    const revocation = {
      ...record,
      status: "revoked" as const,
      revokedAt,
      updatedAt: revokedAt,
    };
    await asOwnerTenant(tenant.tenantId, (c) =>
      c.query("DELETE FROM devices WHERE id = $1", [device.id]),
    );

    // legend-sduiq: the cloud sends the full list, so `kept` is in it too (a
    // local run missing from the list would be retired).
    const result = await inEdgeMode(() =>
      edgePull(outletId, pageWith([kept, clash, fresh], [revocation])),
    );
    expect(result).toMatchObject({
      receiptSequencesRefused: 1,
      receiptSequencesRetired: 0,
    });
    expect(await sequenceOf(outletId, kept.deviceId)).toMatchObject({
      id: kept.id,
      prefix: "P4",
    });
    expect((await sequenceOf(outletId, fresh.deviceId))?.prefix).toBe("P5");
    const [revoked] = await asOwnerTenant(
      tenant.tenantId,
      async (c) =>
        (await c.query("SELECT status FROM devices WHERE id = $1", [device.id]))
          .rows,
    );
    expect(revoked).toMatchObject({ status: "revoked" });

    expect(await sequenceOf(outletId, clash.deviceId)).toBeUndefined();

    expect(errors).toHaveBeenCalled();
    const logged = JSON.stringify([...errors.mock.calls, ...warns.mock.calls]);
    for (const secret of [
      kept.deviceId,
      kept.id,
      clash.deviceId,
      "P9",
      tenant.tenantId,
    ])
      expect(logged).not.toContain(secret);
  });

  it("POS-06 legend-zsdd a pulled run with a new id and prefix for the same device replaces the local run: the old one is retired and the next sale is P2-000001", async () => {
    const outletId = await freshOutlet();
    const old = unseen(outletId, "P1");
    const orderId = await draftOrder(outletId);
    await inEdgeMode(() => edgePull(outletId, pageWith([old])));
    const warns = vi.spyOn(logger, "warn");
    const next = { ...old, id: randomUUID(), prefix: "P2" };
    const result = await inEdgeMode(() => edgePull(outletId, pageWith([next])));
    expect(result).toMatchObject({
      receiptSequencesReplaced: 1,
      receiptSequencesRefused: 0,
    });
    const rows = await sequenceRows(outletId);
    expect(rows.find((r) => r.id === old.id)?.retired_at).not.toBeNull();
    expect(await sequenceOf(outletId, old.deviceId)).toMatchObject({
      id: next.id,
      prefix: "P2",
      last_number: 0,
      edge_node_id: OWN.edgeNodeId,
      edge_instance_id: OWN.edgeInstanceId,
    });
    const logged = JSON.stringify(warns.mock.calls);
    for (const secret of [old.deviceId, old.id, next.id, tenant.tenantId])
      expect(logged).not.toContain(secret);
    expect(
      (await inEdgeMode(() => allocate(outletId, orderId, old.deviceId)))
        .number,
    ).toBe("P2-000001");
  });

  it("TEN-01 S-K1 a sequence of another outlet or tenant writes no sequence, is counted, and the page's revocation still lands", async () => {
    const outletId = await freshOutlet();
    const elsewhere = await freshOutlet();
    const good = unseen(outletId, "P2");
    const device = await enroll(outletId, "printer");
    const revocation = await revocationOf(outletId, device.id);
    const errors = vi.spyOn(logger, "error");
    const first = await inEdgeMode(() =>
      edgePull(
        outletId,
        pageWith([good, unseen(elsewhere, "P1")], [revocation]),
      ),
    );
    const second = await inEdgeMode(() =>
      edgePull(outletId, pageWith([good, unseen(other.outletId, "P1")])),
    );
    expect(first.receiptSequencesRefused).toBe(2);
    expect(second.receiptSequencesRefused).toBe(2);
    expect(first.applied).toBe(1);
    expect(await deviceStatus(device.id)).toBe("revoked");
    expect(await sequenceRows(outletId)).toEqual([]);
    expect(await sequenceRows(elsewhere)).toEqual([]);
    const logged = JSON.stringify(errors.mock.calls);
    for (const secret of [good.deviceId, good.id, elsewhere, other.outletId])
      expect(logged).not.toContain(secret);
  });

  it("EDG-02 S-K1 a malformed sequence never stops the device records of its page or the later pages", async () => {
    const outletId = await freshOutlet();
    const a = await enroll(outletId, "printer");
    const b = await enroll(outletId, "printer");
    const pages = [
      {
        ...pageWith([], [await revocationOf(outletId, a.id)]),
        receiptSequences: [{ id: "not-a-uuid", prefix: 7 }],
        meta: { limit: 1, nextCursor: "c2", watermark: "c1" },
      },
      {
        ...pageWith([], [await revocationOf(outletId, b.id)]),
        receiptSequences: "nonsense",
        meta: { limit: 1, nextCursor: null, watermark: "c2" },
      },
    ];
    let call = 0;
    const result = await inEdgeMode(() =>
      pullDeviceRegistry({
        context: edgeScope(outletId),
        role: "primary",
        binding: OWN,
        fetchPage: async () => pages[call++],
      }),
    );
    expect(result).toMatchObject({ pages: 2, applied: 2 });
    expect(result.receiptSequencesRefused).toBe(2);
    expect(await deviceStatus(a.id)).toBe("revoked");
    expect(await deviceStatus(b.id)).toBe("revoked");
  });

  it("EDG-02 S-K1 a standby edge applies the device records but never the pulled sequences", async () => {
    const outletId = await freshOutlet();
    const sequence = unseen(outletId, "P3");
    const device = await enroll(outletId, "printer");
    const revocation = await revocationOf(outletId, device.id);
    const result = await inEdgeMode(() =>
      edgePull(outletId, pageWith([sequence], [revocation]), "standby"),
    );
    expect(result).toMatchObject({ applied: 1, receiptSequencesRefused: 0 });
    expect(await sequenceOf(outletId, sequence.deviceId)).toBeUndefined();
    expect(await deviceStatus(device.id)).toBe("revoked");
  });

  it("EDG-02 legend-zsdd a primary edge without its own binding applies the device records but never the pulled sequences", async () => {
    const outletId = await freshOutlet();
    const sequence = unseen(outletId, "P3");
    const result = await inEdgeMode(() =>
      // No `binding`: the default of edgePull would add OWN, so call directly.
      pullDeviceRegistry({
        context: edgeScope(outletId),
        role: "primary",
        fetchPage: async () => pageWith([sequence]),
      }),
    );
    expect(result).toMatchObject({ receiptSequencesRefused: 0 });
    expect(await sequenceOf(outletId, sequence.deviceId)).toBeUndefined();
  });
});

// ---- S-K1: the flag, and cloud sales of an edge outlet -----------------------

describe("EDG-02 S-K1 the cloud sends receipt sequences only when the edge asks", () => {
  it("EDG-02 a page without `receiptSequences=1` has no field and provisions nothing; with it, the list", async () => {
    const outletId = await freshOutlet();
    const legacy = await legacyDevice(outletId);
    const plain = await cloudPage(outletId, tenant.tenantId, null);
    expect("receiptSequences" in plain).toBe(false);
    expect(await sequenceOf(outletId, legacy)).toBeUndefined();
    const asked = await cloudPage(
      outletId,
      tenant.tenantId,
      "1",
      await activeEdge(outletId),
    );
    expect(asked.receiptSequences?.map((s) => s.deviceId)).toEqual([legacy]);
  });

  it("EDG-02 the flag is validated strictly", () => {
    for (const bad of ["0", "true", "yes", ""])
      expect(
        deviceSyncQuerySchema.safeParse({ receiptSequences: bad }).success,
      ).toBe(false);
    expect(
      deviceSyncQuerySchema.safeParse({ receiptSequences: "1" }).success,
    ).toBe(true);
  });
});

describe("POS-06 S-K1 cloud refuses a device sale of an outlet served by an edge", () => {
  it("POS-06 a device-keyed cloud sale with an active edge node: RECEIPT_DEVICE_ON_EDGE, nothing written", async () => {
    const outletId = await freshOutlet();
    const device = await enroll(outletId, "pos");
    await edgeNodeAt(outletId);
    const orderId = await draftOrder(outletId);
    await expect(allocate(outletId, orderId, device.id)).rejects.toMatchObject({
      code: "RECEIPT_DEVICE_ON_EDGE",
      status: 409,
    });
    expect(await receiptCount(outletId)).toBe(0);
    expect((await sequenceOf(outletId, device.id))?.last_number).toBe(0);
  });

  it("POS-06 a cloud sale without a device (sequence C) still takes C-000001 on an edge outlet", async () => {
    const outletId = await freshOutlet();
    await edgeNodeAt(outletId);
    const orderId = await draftOrder(outletId);
    const receipt = await inTx((tx, context) =>
      allocateReceipt(tx, context, {
        orderId,
        outletId,
        deviceId: null,
        at: new Date(),
      }),
    );
    expect(receipt.number).toBe("C-000001");
  });

  it("POS-06 an edge in its boot window (EDGE_MODE set, runtime not started) sells on its own sequence, not RECEIPT_DEVICE_ON_EDGE", async () => {
    const outletId = await freshOutlet();
    const device = await enroll(outletId, "pos");
    // The edge database holds its own active edge_nodes row.
    await edgeNodeAt(outletId);
    const orderId = await draftOrder(outletId);
    const previous = process.env.EDGE_MODE;
    process.env.EDGE_MODE = "true";
    try {
      expect((await allocate(outletId, orderId, device.id)).number).toBe(
        "P1-000001",
      );
    } finally {
      if (previous === undefined) delete process.env.EDGE_MODE;
      else process.env.EDGE_MODE = previous;
    }
  });

  it("POS-06 a revoked edge node does not block the cloud device sale", async () => {
    const outletId = await freshOutlet();
    const device = await enroll(outletId, "pos");
    await edgeNodeAt(outletId, "revoked");
    const orderId = await draftOrder(outletId);
    expect((await allocate(outletId, orderId, device.id)).number).toBe(
      "P1-000001",
    );
  });
});
