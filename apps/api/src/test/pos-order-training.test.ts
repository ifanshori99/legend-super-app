// WS-02 training stamp on POS orders (bead legend-2lp.8, brief 90 section E;
// PRD v1.7 §3 F5 "Mode Latihan"). Written from the brief, independent of the
// implementation: failing imports are expected until the sections merge.
//
// Assumed contracts (see the report):
//   pos_orders.is_training boolean NOT NULL DEFAULT false, stamped at creation
//     from devices.training_mode of `caller.deviceId`, never changed afterwards.
//   services/pos-order.service.ts createPosOrder(ctx, { userId, deviceId,
//     expectedVersion: null }, outletId, input) -> detail with `.id` (ULID).
//     The HTTP route passes deviceId null, so device cases use the service.
//   services/device-training.ts reportablePosOrders() -> drizzle SQL predicate.
//
// Fresh isolated tenant; receipt numbering is a port, a double is installed.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  createPosOrder as createPosOrderContract,
  type PosReceipt,
} from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { posOrders } from "../db/schema/pos-order.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  enrollDevice,
  setDeviceTrainingMode,
} from "../services/device.service.ts";
import { createDeviceOutletResolver } from "../services/device-outlet-resolver.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import { reportablePosOrders } from "../services/device-training.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { createPosOrder } from "../services/pos-order.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
};
const actor = randomUUID();
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };

const tenantContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const outletContext = (): ScopedTenantContext =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );

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

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let next = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      next += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? randomUUID(),
        number: `TRN-${String(next).padStart(6, "0")}`,
        sequenceNumber: next,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx, _context, orderId) {
      return byOrder.get(orderId) ?? null;
    },
    async voidForOrder() {
      return null;
    },
  };
}

async function newDevice(trainingMode: boolean): Promise<string> {
  const { device } = await enrollDevice(outletContext(), actor, {
    outletId: tenant.outletId,
    type: "pos",
    label: `Kasir ${randomUUID().slice(0, 6)}`,
    stationId: null,
    idempotencyKey: randomUUID(),
  });
  if (trainingMode)
    await setDeviceTrainingMode(outletContext(), actor, {
      deviceId: device.id,
      trainingMode: true,
    });
  return device.id;
}

/** Creates a POS order through the service, as a cashier on `deviceId`. */
async function createOrder(deviceId: string | null): Promise<string> {
  const input = createPosOrderContract.body.parse({
    idempotencyKey: randomUUID(),
    channel: "pos",
    serviceType: "takeaway",
    items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
  });
  const order = await createPosOrder(
    tenantContext(),
    {
      userId: userIdSchema.parse(cashier.userId),
      deviceId,
      expectedVersion: null,
    },
    outletIdSchema.parse(tenant.outletId),
    input,
  );
  return order.id;
}

async function isTraining(orderId: string): Promise<boolean> {
  const { rows } = await asOwnerTenant((client) =>
    client.query<{ is_training: boolean }>(
      "SELECT is_training FROM pos_orders WHERE tenant_id = $1 AND order_id = $2::uuid",
      [tenant.tenantId, ulidToUuid(orderId)],
    ),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.is_training;
}

const canon = (id: string) =>
  id.includes("-") ? id.toLowerCase() : ulidToUuid(id);
async function reportableIds(): Promise<string[]> {
  const rows = await withTenant(db, tenantContext(), (tx) =>
    tx
      .select({ orderId: posOrders.orderId })
      .from(posOrders)
      .where(
        and(
          eq(posOrders.tenantId, tenantIdSchema.parse(tenant.tenantId)),
          reportablePosOrders(),
        ),
      ),
  );
  return rows.map((row) => canon(String(row.orderId)));
}

/** The device token header a registered terminal sends (pos-shift). */
const deviceToken = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

const posHttp = (
  path: string,
  body: Record<string, unknown>,
  deviceId?: string,
) => {
  const request = cashier.client
    .post(
      `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders${path}`,
    )
    .set(headers)
    .set(originHeader);
  if (deviceId) request.set(DEVICE_TOKEN_HEADER, deviceToken(deviceId));
  return request.send({ idempotencyKey: randomUUID(), ...body });
};

/** The cashier opens a shift on `deviceId`: cash needs that drawer (pos-shift). */
async function openShiftOn(deviceId: string) {
  const opened = await cashier.client
    .post(`/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/shifts`)
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(deviceId))
    .send({ openingFloatIdr: 100_000, idempotencyKey: randomUUID() });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setAuditWriter(coreAuditWriter);
  setPosReceiptPort(memoryReceiptPort());
  // Production resolver: a cash drawer opens only on a device row (pos-shift).
  setDeviceOutletResolver(createDeviceOutletResolver());
  tenant = await createIsolatedTenant(`trn-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'POS Kasir Uji', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
        "shift.cash.operate",
      ]),
    ],
  );
  const client = agent(app);
  await signUp(client, "Kasir Latihan");
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, userId, ids.cashierRole],
  );
  cashier = { client, userId };
  await asOwnerTenant(async (c) => {
    await c.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Latihan Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await c.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await c.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await c.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi],
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
       VALUES ($1, $2, NULL, 'PBJT-TRN', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, userId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  setAuditWriter(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-2lp.8 training stamp on pos_orders", () => {
  it("an order made on a training device is stamped is_training = true", async () => {
    const orderId = await createOrder(await newDevice(true));
    expect(await isTraining(orderId)).toBe(true);
  });

  it("an order made on a normal device is stamped false", async () => {
    const orderId = await createOrder(await newDevice(false));
    expect(await isTraining(orderId)).toBe(false);
  });

  it("an order without a device is stamped false", async () => {
    expect(await isTraining(await createOrder(null))).toBe(false);
  });

  it("toggling the device's training mode later does not change existing orders", async () => {
    const trainingDevice = await newDevice(true);
    const normalDevice = await newDevice(false);
    const trained = await createOrder(trainingDevice);
    const normal = await createOrder(normalDevice);
    await setDeviceTrainingMode(outletContext(), actor, {
      deviceId: trainingDevice,
      trainingMode: false,
    });
    await setDeviceTrainingMode(outletContext(), actor, {
      deviceId: normalDevice,
      trainingMode: true,
    });
    expect(await isTraining(trained)).toBe(true);
    expect(await isTraining(normal)).toBe(false);
    // New orders follow the current mode.
    expect(await isTraining(await createOrder(trainingDevice))).toBe(false);
    expect(await isTraining(await createOrder(normalDevice))).toBe(true);
  });

  it("submitting, paying and completing an order never flips the stamp", async () => {
    const trainingId = await createOrder(await newDevice(true));
    const tillDevice = await newDevice(false);
    const normalId = await createOrder(tillDevice);
    // Since pos-shift a cash tender goes into the open drawer of the device
    // it is taken on; both orders are paid at the normal terminal's till.
    await openShiftOn(tillDevice);
    for (const orderId of [trainingId, normalId]) {
      const read = await cashier.client
        .get(
          `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders/${orderId}`,
        )
        .set(headers)
        .set(originHeader);
      expect(read.status).toBe(200);
      let status = read.body.data.status as string;
      if (status === "draft") {
        const submitted = await posHttp(
          `/${orderId}/submit`,
          { expectedStatus: status },
          tillDevice,
        );
        expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
        status = submitted.body.data.status;
      }
      const paid = await posHttp(
        `/${orderId}/tenders`,
        {
          method: "cash",
          receivedIdr: read.body.data.totalIdr + 5_000,
          expectedStatus: status,
        },
        tillDevice,
      );
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      const done = await posHttp(
        `/${orderId}/complete`,
        { expectedStatus: paid.body.data.order.status },
        tillDevice,
      );
      expect(done.status, JSON.stringify(done.body)).toBe(200);
    }
    expect(await isTraining(trainingId)).toBe(true);
    expect(await isTraining(normalId)).toBe(false);
  });
});

describe("legend-2lp.8 reportablePosOrders", () => {
  it("excludes training orders and keeps normal and device-less ones", async () => {
    const training = await createOrder(await newDevice(true));
    const normal = await createOrder(await newDevice(false));
    const noDevice = await createOrder(null);
    const reportable = await reportableIds();
    expect(reportable).toContain(canon(normal));
    expect(reportable).toContain(canon(noDevice));
    expect(reportable).not.toContain(canon(training));
  });

  it("an order stays out of reports after its device leaves training mode", async () => {
    const device = await newDevice(true);
    const training = await createOrder(device);
    await setDeviceTrainingMode(outletContext(), actor, {
      deviceId: device,
      trainingMode: false,
    });
    expect(await reportableIds()).not.toContain(canon(training));
  });
});
