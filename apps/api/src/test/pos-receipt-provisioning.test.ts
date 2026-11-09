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

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
    allocateReceipt(tx, context, { orderId, outletId, deviceId, at: new Date() }),
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

const nodeOf = (outletId: string, tenantId = tenant.tenantId) => ({
  tenantId: tenantId as TenantId,
  outletId: outletIdSchema.parse(outletId),
  edgeNodeId: randomUUID(),
});

function cloudPage(
  outletId: string,
  tenantId = tenant.tenantId,
): Promise<DeviceSyncPage> {
  return listDeviceRecordsSince(
    nodeOf(outletId, tenantId),
    { limit: 100 },
    { now: new Date(Date.now() + 10 * 60_000), settleMs: 0 },
  );
}

/** The edge pulls one page the cloud would have sent. */
function edgePull(outletId: string, page: unknown) {
  return pullDeviceRegistry({
    context: edgeScope(outletId),
    fetchPage: async () => page,
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
    const page = await cloudPage(outletId);
    expect(page.receiptSequences).toEqual([
      {
        id: row!.id,
        outletId,
        deviceId: device.id,
        prefix: "P1",
        lastNumber: 0,
      },
    ]);
  });

  it("POS-06 a device enrolled before this change is backfilled by the pull, even when its row is older than the cursor", async () => {
    const outletId = await freshOutlet();
    const legacy = await legacyDevice(outletId);
    expect(await sequenceOf(outletId, legacy)).toBeUndefined();
    const first = await cloudPage(outletId);
    // Pull again from the watermark: the device row is not in `data`, the
    // sequence still is.
    const again = await listDeviceRecordsSince(
      nodeOf(outletId),
      { limit: 100, since: first.meta.watermark ?? undefined },
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
    await cloudPage(outletId);
    // Only the sequence made while `live` was active.
    expect(await sequenceRows(outletId)).toEqual([
      expect.objectContaining({ device_id: live.id, prefix: "P1" }),
    ]);
  });

  it("TEN-01 TEN-03 a node of tenant B never sees tenant A's sequences and cannot pull A's outlet", async () => {
    const outletId = await freshOutlet();
    const device = await enroll(outletId, "pos");
    await enroll(other.outletId, "pos", other.tenantId);
    const mine = await cloudPage(outletId);
    const theirs = await cloudPage(other.outletId, other.tenantId);
    expect(mine.receiptSequences?.map((s) => s.deviceId)).toEqual([device.id]);
    expect(theirs.receiptSequences?.length).toBe(1);
    expect(
      theirs.receiptSequences?.some(
        (s) => s.deviceId === device.id || s.outletId === outletId,
      ),
    ).toBe(false);
    await expect(cloudPage(outletId, other.tenantId)).rejects.toThrow();
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

  it("POS-06 a rebuilt edge starts at the cloud's lastNumber, so it never reissues a number", async () => {
    const outletId = await freshOutlet();
    const sequence = unseen(outletId, "P8", 5);
    const orderId = await draftOrder(outletId);
    await inEdgeMode(() => edgePull(outletId, pageWith([sequence])));
    expect((await sequenceOf(outletId, sequence.deviceId))?.last_number).toBe(5);
    const receipt = await inEdgeMode(() =>
      allocate(outletId, orderId, sequence.deviceId),
    );
    expect(receipt.number).toBe("P8-000006");
  });

  it("POS-06 a re-pull never resets the edge counter (existing row untouched)", async () => {
    const outletId = await freshOutlet();
    const sequence = unseen(outletId, "P3");
    const [a, b] = [await draftOrder(outletId), await draftOrder(outletId)];
    await inEdgeMode(() => edgePull(outletId, pageWith([sequence])));
    await inEdgeMode(() => allocate(outletId, a, sequence.deviceId));
    await inEdgeMode(() => allocate(outletId, b, sequence.deviceId));
    await inEdgeMode(() => edgePull(outletId, pageWith([sequence])));
    expect((await sequenceOf(outletId, sequence.deviceId))?.last_number).toBe(2);
  });

  it("POS-06 a prefix mismatch skips only that sequence, the rest of the pull applies, and the log names no device", async () => {
    const outletId = await freshOutlet();
    const kept = unseen(outletId, "P4");
    await inEdgeMode(() => edgePull(outletId, pageWith([kept])));
    const errors = vi.spyOn(logger, "error");

    // Same device, another prefix (two numbering namespaces), next to a new
    // sequence and a device revocation record in the same page.
    const clash = { ...kept, prefix: "P9" };
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

    const result = await inEdgeMode(() =>
      edgePull(outletId, pageWith([clash, fresh], [revocation])),
    );
    expect(result).toMatchObject({ receiptSequencesRefused: 1 });
    expect(await sequenceOf(outletId, kept.deviceId)).toMatchObject({
      id: kept.id,
      prefix: "P4",
    });
    expect((await sequenceOf(outletId, fresh.deviceId))?.prefix).toBe("P5");
    const [revoked] = await asOwnerTenant(tenant.tenantId, async (c) =>
      (await c.query("SELECT status FROM devices WHERE id = $1", [device.id]))
        .rows,
    );
    expect(revoked).toMatchObject({ status: "revoked" });

    expect(errors).toHaveBeenCalled();
    const logged = JSON.stringify(errors.mock.calls);
    for (const secret of [kept.deviceId, kept.id, "P9", tenant.tenantId])
      expect(logged).not.toContain(secret);
  });

  it("TEN-01 a sequence of another outlet or tenant refuses the whole page and writes nothing", async () => {
    const outletId = await freshOutlet();
    const elsewhere = await freshOutlet();
    const good = unseen(outletId, "P2");
    await expect(
      inEdgeMode(() =>
        edgePull(outletId, pageWith([good, unseen(elsewhere, "P1")])),
      ),
    ).rejects.toThrow();
    await expect(
      inEdgeMode(() =>
        edgePull(outletId, pageWith([good, unseen(other.outletId, "P1")])),
      ),
    ).rejects.toThrow();
    expect(await sequenceRows(outletId)).toEqual([]);
    expect(await sequenceRows(elsewhere)).toEqual([]);
  });
});
