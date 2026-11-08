// POS receipts, review K regression tests (branch ws/pos-receipt; bead legend-93a).
// Findings: F1 cloud-owned sequence vs device sequences (and edge fail-closed),
// F2 void-from-merge must match a cloud void, F3 merge only for completed or
// voided orders of the same device.
//
// Real Express app, Better Auth, RBAC and PostgreSQL with RLS (disposable server
// from `pnpm test`) in a fresh isolated tenant, like pos-receipt.test.ts (whose
// helpers are copied here, that file is not edited). The REAL receipt port is
// installed. Each scenario uses its own outlet.
//
// Run just this file (from apps/api):
//   pnpm exec vitest run src/test/pos-receipt-kfix.test.ts
//
// Assumptions (the brief "Shared decisions" is the source):
//  - Cloud-owned sequence (sale without a device, key deviceId = outletId) uses
//    the fixed prefix "C": first number "C-000001". Device sequences use
//    P1, P2, ... and may never be "C".
//  - Refusals of prefix "C" / deviceId = outletId (provision and merge) and of
//    merge orders that are not completed/voided orders of the same device use
//    RECEIPT_PREFIX_MISMATCH; a bad device void field is VALIDATION_ERROR.
//  - A cloud void leaves the order `completed` with a pos_order_voids row (POS-04
//    linked correction). The row is seeded with owner SQL.
//  - A void merged from a device takes voidedAt/voidReason/voidedBy from that
//    row: reason = row.reason, voidedBy = row.requested_by (the caller of the
//    online void, as voidReceiptForOrder gets `caller.userId`), voidedAt =
//    row.voided_at. Never what the device sent.
//  - Orders for merge fixtures start as HTTP draft orders; owner SQL sets
//    pos_orders.device_id and then orders.status = 'completed' (a final order is
//    immutable, so this is done before it is final).
//  - Edge mode is flipped with setEdgeRuntimeStateForTests and always restored.
//  - Route level: a request carrying a valid signed device token and an unmapped
//    Host (tenant source "device") has a verified device id. A cash sale without
//    the token is refused (SHIFT_NOT_OPEN, pos-shift); the cloud sequence C is
//    reached through service calls with deviceId null.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { formatReceiptNumber, type PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setPosReceiptPort } from "../services/pos-order-ports.ts";
import {
  allocateReceipt,
  createPosReceiptPort,
  mergeDeviceReceiptRun,
  provisionReceiptSequence,
} from "../services/pos-receipt.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;
const OUTLET_NAME = "Cafe Legend Senopati";
const OUTLET_ADDRESS = "Jl. Kopi Legenda No. 12, Jakarta Selatan";

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  cashierRole: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let approver: Member;

// ---- Fixtures (copied from pos-receipt.test.ts) ----------------------------------

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

async function rows<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return asOwnerTenant(tenant.tenantId, async (client) => {
    const result = await client.query(text, params);
    return result.rows as T[];
  });
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

async function member(roleId: string, label: string): Promise<Member> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, roleId],
  );
  return { client, userId };
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

/** Cookie-authenticated POS client; a device token switches to tenant source "device". */
function api(outletId: string, deviceToken?: string) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos`;
  const hostHeaders = deviceToken
    ? { Host: "localhost", [DEVICE_TOKEN_HEADER]: deviceToken }
    : headers;
  return {
    post: (path: string, body: Record<string, unknown> = {}) =>
      cashier.client
        .post(`${base}${path}`)
        .set(hostHeaders)
        .set(originHeader)
        .send({ idempotencyKey: randomUUID(), ...body }),
  };
}

/**
 * A token for a device in the registry (legend-165): a token is only accepted
 * while the tenant has an active device row with `token_issued_at` at or
 * before the token's `issuedAt`.
 */
async function deviceTokenFor(
  deviceId: string,
  outletId: string,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir uji', $4)`,
      [deviceId, tenant.tenantId, outletId, new Date(issuedAt * 1000)],
    );
  });
  return signDeviceToken({
    version: 1,
    tenantId: tenant.tenantId,
    brandId: tenant.brandId,
    deviceId,
    issuedAt,
  });
}

/** The cashier opens a shift on the device: cash needs that drawer (pos-shift). */
async function openShiftOn(outletId: string, deviceToken: string) {
  const opened = await api(outletId, deviceToken).post("/shifts", {
    openingFloatIdr: 100_000,
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
}

async function draftOrder(
  outletId: string,
  deviceToken?: string,
): Promise<{ orderId: string; status: string; totalIdr: number }> {
  const created = await api(outletId, deviceToken).post("/orders", {
    channel: "pos",
    serviceType: "takeaway",
    items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return {
    orderId: created.body.data.id as string,
    status: created.body.data.status as string,
    totalIdr: created.body.data.totalIdr as number,
  };
}

async function drafts(outletId: string, count: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1)
    out.push((await draftOrder(outletId)).orderId);
  return out;
}

/** A sale finished over HTTP; the real port allocates the receipt on complete. */
async function completedSale(
  outletId: string,
  deviceToken?: string,
): Promise<string> {
  const draft = await draftOrder(outletId, deviceToken);
  let status = draft.status;
  if (status === "draft") {
    const submitted = await api(outletId, deviceToken).post(
      `/orders/${draft.orderId}/submit`,
      { expectedStatus: status },
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const paid = await api(outletId, deviceToken).post(
    `/orders/${draft.orderId}/tenders`,
    {
      method: "cash",
      receivedIdr: draft.totalIdr + 5_000,
      expectedStatus: status,
    },
  );
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const completed = await api(outletId, deviceToken).post(
    `/orders/${draft.orderId}/complete`,
    { expectedStatus: paid.body.data.order.status as string },
  );
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  expect(completed.body.data.status).toBe("completed");
  return draft.orderId;
}

/**
 * A merge-ready order: owned by `deviceId` and completed, with no receipt yet.
 * Built from a draft (still editable) with owner SQL.
 */
async function deviceOrder(
  outletId: string,
  deviceId: string | null,
  status: "draft" | "completed" = "completed",
): Promise<string> {
  const { orderId } = await draftOrder(outletId);
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `UPDATE pos_orders SET device_id = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId), deviceId],
    );
    if (status === "completed")
      await client.query(
        `UPDATE orders SET status = 'completed' WHERE tenant_id = $1 AND id = $2::uuid`,
        [tenant.tenantId, ulidToUuid(orderId)],
      );
  });
  return orderId;
}

const VOID_REASON = "customer_cancelled";
const VOID_AT = new Date(Date.now() - 3_600_000);

/** The cloud side of a void: the linked correction row (order stays completed). */
async function cloudVoid(
  outletId: string,
  orderId: string,
  receiptNumber: string,
): Promise<void> {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO pos_order_voids
         (tenant_id, outlet_id, order_id, receipt_number, amount_idr, reason, reason_note,
          requested_by, approved_by, override_id, voided_at)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, 'Pelanggan batal', $7, $8, $9, $10)`,
      [
        tenant.tenantId,
        outletId,
        ulidToUuid(orderId),
        receiptNumber,
        KOPI_IDR,
        VOID_REASON,
        cashier.userId,
        approver.userId,
        randomUUID(),
        VOID_AT,
      ],
    ),
  );
}

// ---- Service access ---------------------------------------------------------------

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
  deviceId: string | null,
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

function provision(outletId: string, deviceId: string, prefix: string) {
  return inTx((tx, c) =>
    provisionReceiptSequence(tx, c, { outletId, deviceId, prefix }),
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

type ReceiptRow = {
  id: string;
  number: string;
  sequence_number: number;
  device_id: string;
  order_id: string;
  status: string;
  void_reason: string | null;
  voided_by: string | null;
  voided_at: Date | null;
};

function receiptRows(outletId: string): Promise<ReceiptRow[]> {
  return rows<ReceiptRow>(
    `SELECT id, number, sequence_number, device_id, order_id, status, void_reason, voided_by, voided_at
     FROM pos_receipts WHERE tenant_id = $1 AND outlet_id = $2
     ORDER BY number, sequence_number`,
    [tenant.tenantId, outletId],
  );
}

type SequenceRow = {
  prefix: string;
  last_number: number;
  device_id: string;
};

function sequenceRows(outletId: string): Promise<SequenceRow[]> {
  return rows<SequenceRow>(
    `SELECT prefix, last_number, device_id FROM receipt_sequences
     WHERE tenant_id = $1 AND outlet_id = $2 ORDER BY prefix`,
    [tenant.tenantId, outletId],
  );
}

/** A refused merge leaves only the cloud-provisioned row, never advanced. */
async function expectProvisionedOnly(
  outletId: string,
  prefix: string,
): Promise<void> {
  expect(await sequenceRows(outletId)).toEqual([
    expect.objectContaining({ prefix, last_number: 0 }),
  ]);
}

/** What an offline device sends. Void fields default to what a device might claim. */
function offlineReceipt(input: {
  outletId: string;
  deviceId: string;
  orderId: string;
  prefix: string;
  ordinal: number;
  voided?: boolean;
  voidReason?: string;
  voidedBy?: string;
  voidedAt?: string;
}): PosReceipt {
  const at = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId: tenant.tenantId,
    outletId: input.outletId,
    orderId: input.orderId,
    deviceId: input.deviceId,
    number: formatReceiptNumber(input.prefix, input.ordinal),
    sequenceNumber: input.ordinal,
    status: input.voided ? "voided" : "issued",
    issuedAt: at,
    voidedAt: input.voided ? (input.voidedAt ?? at) : null,
    voidReason: input.voided ? (input.voidReason ?? "wrong_order") : null,
    voidedBy: input.voided ? (input.voidedBy ?? randomUUID()) : null,
    reprintCount: 0,
  } as unknown as PosReceipt;
}

function mergeRun(
  outletId: string,
  deviceId: string,
  prefix: string,
  lastNumber: number,
  receipts: PosReceipt[],
) {
  return inTx((tx, context) =>
    mergeDeviceReceiptRun(tx, context, {
      sequence: { outletId, deviceId, prefix, lastNumber },
      receipts,
    }),
  );
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(createPosReceiptPort());
  tenant = await createIsolatedTenant(`rkf-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  // Production resolver: a shift opens only on a device row in `devices` (pos-shift).
  setDeviceOutletResolver(createDeviceOutletResolver());
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'Receipt K Kasir', false, NULL, $3, false, '["tenant","outlet"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "shift.cash.operate",
      ]),
    ],
  );
  cashier = await member(ids.cashierRole, "Receipt K Kasir");
  approver = await member(ids.cashierRole, "Receipt K Supervisor");
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Receipt K Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-RKF', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
  });
});

afterAll(async () => {
  setDeviceOutletResolver(null);
  setPosReceiptPort(null);
  // Final orders and receipts are append-only: the tenant stays in the
  // disposable database; give it a valid creator (as pos-receipt.test.ts does).
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- F1: cloud sequence and device sequences do not collide -------------------------

describe("POS-06 K F1 cloud sequence C and device sequences P1.. (legend-93a)", () => {
  it("POS-06 a cloud sale without a device is C-000001 and the device sequence P1 merges without a prefix clash", async () => {
    const outletId = await freshOutlet();
    const [cloudOrder] = await drafts(outletId, 1);
    const cloud = await allocate(outletId, cloudOrder!, null);
    expect(cloud.number).toBe("C-000001");
    expect(cloud.deviceId).toBe(outletId);

    const device = randomUUID();
    const provisioned = await provision(outletId, device, "P1");
    expect(provisioned).toMatchObject({
      prefix: "P1",
      lastNumber: 0,
      deviceId: device,
    });

    const o1 = await deviceOrder(outletId, device);
    const o2 = await deviceOrder(outletId, device);
    const base = { outletId, deviceId: device, prefix: "P1" };
    const merged = await mergeRun(outletId, device, "P1", 2, [
      offlineReceipt({ ...base, orderId: o1, ordinal: 1 }),
      offlineReceipt({ ...base, orderId: o2, ordinal: 2 }),
    ]);
    expect(merged.inserted).toBe(2);

    const numbers = (await receiptRows(outletId)).map((row) => row.number);
    expect(numbers).toEqual(["C-000001", "P1-000001", "P1-000002"]);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(await sequenceRows(outletId)).toEqual([
      expect.objectContaining({ prefix: "C", device_id: outletId }),
      expect.objectContaining({
        prefix: "P1",
        device_id: device,
        last_number: 2,
      }),
    ]);
  });

  it("POS-06 a device sale in the cloud takes P1 even after the cloud sale holds C", async () => {
    const outletId = await freshOutlet();
    const [cloudOrder, deviceSale] = await drafts(outletId, 2);
    await allocate(outletId, cloudOrder!, null);
    const device = randomUUID();
    const receipt = await allocate(outletId, deviceSale!, device);
    expect(receipt).toMatchObject({ number: "P1-000001", deviceId: device });
  });

  it("POS-06 a cash sale over HTTP without a device token is refused (SHIFT_NOT_OPEN) and takes no receipt number", async () => {
    // pos-shift (m1): cash goes into the drawer of a verified device's open
    // shift, so a cash sale over HTTP always carries a device. The cloud
    // sequence C stays for sales without a device (covered above).
    const outletId = await freshOutlet();
    const draft = await draftOrder(outletId);
    let status = draft.status;
    if (status === "draft") {
      const submitted = await api(outletId).post(
        `/orders/${draft.orderId}/submit`,
        { expectedStatus: status },
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      status = submitted.body.data.status as string;
    }
    const paid = await api(outletId).post(`/orders/${draft.orderId}/tenders`, {
      method: "cash",
      receivedIdr: draft.totalIdr + 5_000,
      expectedStatus: status,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBeGreaterThanOrEqual(400);
    expect(paid.body.error.code).toBe("SHIFT_NOT_OPEN");
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toHaveLength(0);
  });

  it("POS-06 a sale finished over HTTP with a valid device token stores that device on the order and receipt", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    const token = await deviceTokenFor(device, outletId);
    await openShiftOn(outletId, token);
    const orderId = await completedSale(outletId, token);
    const stored = await receiptRows(outletId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      order_id: ulidToUuid(orderId),
      device_id: device,
      number: "P1-000001",
    });
    const [order] = await rows<{ device_id: string | null }>(
      `SELECT device_id FROM pos_orders WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(order?.device_id).toBe(device);
  });

  it("POS-06 a device sequence may never use the cloud prefix C, and the outlet id is never a device", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await expect(provision(outletId, device, "C")).rejects.toMatchObject({
      code: "RECEIPT_PREFIX_MISMATCH",
    });
    await expect(provision(outletId, outletId, "P1")).rejects.toMatchObject({
      code: "RECEIPT_PREFIX_MISMATCH",
    });
    await expect(provision(outletId, outletId, "C")).rejects.toMatchObject({
      code: "RECEIPT_PREFIX_MISMATCH",
    });
    expect(await sequenceRows(outletId)).toHaveLength(0);

    const [o1] = [await deviceOrder(outletId, device)];
    await expect(
      mergeRun(outletId, device, "C", 1, [
        offlineReceipt({
          outletId,
          deviceId: device,
          prefix: "C",
          orderId: o1,
          ordinal: 1,
        }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_PREFIX_MISMATCH" });
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toHaveLength(0);
  });

  it("POS-06 on an edge, a sale without a verified device is refused with RECEIPT_DEVICE_REQUIRED and nothing is written", async () => {
    const outletId = await freshOutlet();
    const [orderId] = await drafts(outletId, 1);
    await expect(
      inEdgeMode(() => allocate(outletId, orderId!, null)),
    ).rejects.toMatchObject({ code: "RECEIPT_DEVICE_REQUIRED" });
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toHaveLength(0);
  });

  it("POS-06 on an edge, a device the cloud never provisioned is refused with RECEIPT_SEQUENCE_NOT_PROVISIONED and nothing is written", async () => {
    const outletId = await freshOutlet();
    const [orderId] = await drafts(outletId, 1);
    await expect(
      inEdgeMode(() => allocate(outletId, orderId!, randomUUID())),
    ).rejects.toMatchObject({ code: "RECEIPT_SEQUENCE_NOT_PROVISIONED" });
    expect(await receiptRows(outletId)).toHaveLength(0);
    expect(await sequenceRows(outletId)).toHaveLength(0);
  });

  it("POS-06 on an edge, a provisioned device sells on its provisioned prefix", async () => {
    const outletId = await freshOutlet();
    const [first, second] = await drafts(outletId, 2);
    const device = randomUUID();
    await provision(outletId, device, "KSR9");
    const one = await inEdgeMode(() => allocate(outletId, first!, device));
    const two = await inEdgeMode(() => allocate(outletId, second!, device));
    expect(one).toMatchObject({ number: "KSR9-000001", deviceId: device });
    expect(two.number).toBe("KSR9-000002");
    // The edge never invented a second sequence for the device.
    expect(await sequenceRows(outletId)).toEqual([
      expect.objectContaining({ prefix: "KSR9", last_number: 2 }),
    ]);
  });
});

// ---- F2: a void arriving by merge needs the cloud's own void -------------------------

describe("POS-06 K F2 void from a device merge needs a matching cloud void (legend-93a)", () => {
  it("POS-06 a merged receipt voided without a cloud void is refused with RECEIPT_VOID_UNMATCHED and nothing is written", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await provision(outletId, device, "OFF1");
    const o1 = await deviceOrder(outletId, device);
    const o2 = await deviceOrder(outletId, device);
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    // One good receipt next to the unmatched void: the whole batch is refused.
    await expect(
      mergeRun(outletId, device, "OFF1", 2, [
        offlineReceipt({ ...base, orderId: o1, ordinal: 1 }),
        offlineReceipt({ ...base, orderId: o2, ordinal: 2, voided: true }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_VOID_UNMATCHED" });
    expect(await receiptRows(outletId)).toHaveLength(0);
    await expectProvisionedOnly(outletId, "OFF1");
  });

  it("POS-06 an already merged issued receipt cannot be voided by a replay without a cloud void", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await provision(outletId, device, "OFF1");
    const o1 = await deviceOrder(outletId, device);
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    await mergeRun(outletId, device, "OFF1", 1, [
      offlineReceipt({ ...base, orderId: o1, ordinal: 1 }),
    ]);
    await expect(
      mergeRun(outletId, device, "OFF1", 1, [
        offlineReceipt({ ...base, orderId: o1, ordinal: 1, voided: true }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_VOID_UNMATCHED" });
    const stored = await receiptRows(outletId);
    expect(stored.map((row) => [row.number, row.status])).toEqual([
      ["OFF1-000001", "issued"],
    ]);
    expect(stored[0]?.void_reason).toBeNull();
  });

  it("POS-06 an invalid void field from the device is VALIDATION_ERROR and nothing is written", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await provision(outletId, device, "OFF1");
    const o1 = await deviceOrder(outletId, device);
    // A real cloud void exists, so only the bad device field can refuse it.
    await cloudVoid(outletId, o1, "OFF1-000001");
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    const bad: Partial<Parameters<typeof offlineReceipt>[0]>[] = [
      { voidReason: "not_a_reason" },
      { voidedBy: "not-a-user-id" },
      { voidedAt: "yesterday-ish" },
    ];
    for (const patch of bad) {
      await expect(
        mergeRun(outletId, device, "OFF1", 1, [
          offlineReceipt({
            ...base,
            orderId: o1,
            ordinal: 1,
            voided: true,
            ...patch,
          }),
        ]),
        JSON.stringify(patch),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(await receiptRows(outletId)).toHaveLength(0);
    await expectProvisionedOnly(outletId, "OFF1");
  });

  it("POS-06 an invalid void reason is VALIDATION_ERROR even when the cloud has no void either", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await provision(outletId, device, "OFF1");
    const o1 = await deviceOrder(outletId, device);
    await expect(
      mergeRun(outletId, device, "OFF1", 1, [
        offlineReceipt({
          outletId,
          deviceId: device,
          prefix: "OFF1",
          orderId: o1,
          ordinal: 1,
          voided: true,
          voidReason: "not_a_reason",
        }),
      ]),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await receiptRows(outletId)).toHaveLength(0);
  });

  it("POS-06 a voided receipt with a matching cloud void is stored voided with the reason, user and time of the cloud void, not the device's", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await provision(outletId, device, "OFF1");
    const o1 = await deviceOrder(outletId, device);
    await cloudVoid(outletId, o1, "OFF1-000001");
    const deviceClaimedUser = randomUUID();
    const merged = await mergeRun(outletId, device, "OFF1", 1, [
      offlineReceipt({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        orderId: o1,
        ordinal: 1,
        voided: true,
        voidReason: "wrong_order",
        voidedBy: deviceClaimedUser,
        voidedAt: new Date().toISOString(),
      }),
    ]);
    expect(merged.inserted).toBe(1);
    const [stored] = await receiptRows(outletId);
    expect(stored).toMatchObject({
      number: "OFF1-000001",
      status: "voided",
      void_reason: VOID_REASON,
      voided_by: cashier.userId,
    });
    expect(stored?.voided_by).not.toBe(deviceClaimedUser);
    expect(stored?.voided_at?.getTime()).toBe(VOID_AT.getTime());
  });

  it("POS-06 an issued receipt merged earlier is voided by a later replay once the cloud void exists, with the cloud void's values", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await provision(outletId, device, "OFF1");
    const o1 = await deviceOrder(outletId, device);
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    await mergeRun(outletId, device, "OFF1", 1, [
      offlineReceipt({ ...base, orderId: o1, ordinal: 1 }),
    ]);
    await cloudVoid(outletId, o1, "OFF1-000001");
    await mergeRun(outletId, device, "OFF1", 1, [
      offlineReceipt({
        ...base,
        orderId: o1,
        ordinal: 1,
        voided: true,
        voidReason: "wrong_order",
      }),
    ]);
    const stored = await receiptRows(outletId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      number: "OFF1-000001",
      status: "voided",
      void_reason: VOID_REASON,
      voided_by: cashier.userId,
    });
    expect(stored[0]?.voided_at?.getTime()).toBe(VOID_AT.getTime());
  });
});

// ---- F3: merge only for final orders of the same device ------------------------------

describe("POS-06 K F3 merge only for completed or voided orders of the same device (legend-93a)", () => {
  it("POS-06 a completed order of the same device merges", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await provision(outletId, device, "OFF1");
    const o1 = await deviceOrder(outletId, device);
    const merged = await mergeRun(outletId, device, "OFF1", 1, [
      offlineReceipt({
        outletId,
        deviceId: device,
        prefix: "OFF1",
        orderId: o1,
        ordinal: 1,
      }),
    ]);
    expect(merged.inserted).toBe(1);
    expect((await receiptRows(outletId)).map((row) => row.number)).toEqual([
      "OFF1-000001",
    ]);
  });

  it("POS-06 a receipt for an order of another device is refused with RECEIPT_PREFIX_MISMATCH and nothing is written", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await provision(outletId, device, "OFF1");
    const otherDevice = randomUUID();
    const mine = await deviceOrder(outletId, device);
    const theirs = await deviceOrder(outletId, otherDevice);
    const base = { outletId, deviceId: device, prefix: "OFF1" };
    await expect(
      mergeRun(outletId, device, "OFF1", 2, [
        offlineReceipt({ ...base, orderId: mine, ordinal: 1 }),
        offlineReceipt({ ...base, orderId: theirs, ordinal: 2 }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_PREFIX_MISMATCH" });
    expect(await receiptRows(outletId)).toHaveLength(0);
    await expectProvisionedOnly(outletId, "OFF1");
  });

  it("POS-06 a receipt for an order that has no device (a cloud sale) is refused with RECEIPT_PREFIX_MISMATCH", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await provision(outletId, device, "OFF1");
    const cloudOrder = await deviceOrder(outletId, null);
    await expect(
      mergeRun(outletId, device, "OFF1", 1, [
        offlineReceipt({
          outletId,
          deviceId: device,
          prefix: "OFF1",
          orderId: cloudOrder,
          ordinal: 1,
        }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_PREFIX_MISMATCH" });
    expect(await receiptRows(outletId)).toHaveLength(0);
  });

  it("POS-06 a receipt for an order that is still open is refused with RECEIPT_PREFIX_MISMATCH and nothing is written", async () => {
    const outletId = await freshOutlet();
    const device = randomUUID();
    await provision(outletId, device, "OFF1");
    const open = await deviceOrder(outletId, device, "draft");
    await expect(
      mergeRun(outletId, device, "OFF1", 1, [
        offlineReceipt({
          outletId,
          deviceId: device,
          prefix: "OFF1",
          orderId: open,
          ordinal: 1,
        }),
      ]),
    ).rejects.toMatchObject({ code: "RECEIPT_PREFIX_MISMATCH" });
    expect(await receiptRows(outletId)).toHaveLength(0);
    await expectProvisionedOnly(outletId, "OFF1");
  });
});
