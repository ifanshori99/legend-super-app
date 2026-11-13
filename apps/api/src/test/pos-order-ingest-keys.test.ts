// legend-771dl producer: the cloud-native POS sale (completePosOrder) fills the
// optional ingest keys of `order.paid` (lines, subtotalIdr, orderNumber, ...) so an
// edge node's event can later become a cloud order; but ONLY when the non-void
// lines add up to the subtotal. When they do not, the keys are left out: the event
// stays valid (the old shape) and the cloud sale still completes. Written from the
// brief, through the real routes (same harness as pos-order.test.ts).
//
// Assumption: "key ingest" means `lines`, `subtotalIdr` and `orderNumber` (named in
// the brief); the test does not pin the other optional keys in the mismatch case.
// The mismatch is a kitchen swap to a dearer replacement line (the order's money
// stays frozen, so Σ non-void lines != subtotal), set up with plain SQL rows.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createUlid,
  idr,
  outletIdSchema,
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { orderPaidPayloadSchema, type PosReceipt } from "@starter/shared/pos";
import { createApp } from "../app.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { signDeviceToken } from "../lib/device-token.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { seedMember } from "./member-loyalty-helpers";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  device: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;

// ---- Receipt numbering double (legend-93a port) ---------------------------------

/** Gapless per outlet, idempotent per order: like the allocator it stands for. */
function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  const next = new Map<string, number>();
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      const sequenceNumber = (next.get(input.outletId) ?? 0) + 1;
      next.set(input.outletId, sequenceNumber);
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? ids.device,
        number: `POS1-${String(sequenceNumber).padStart(6, "0")}`,
        sequenceNumber,
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
    async voidForOrder(_tx, _context, input) {
      const found = byOrder.get(input.orderId);
      if (!found) return null;
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      } as unknown as PosReceipt;
      byOrder.set(input.orderId, voided);
      return voided;
    },
  };
}

// ---- Fixtures

/** Owner-side writes set the tenant local, because RLS is FORCED. */
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

function pos(who: Member = cashier, outletId = tenant.outletId) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      // The till: cash goes into the drawer of the shift open on this device.
      .set(
        DEVICE_TOKEN_HEADER,
        signDeviceToken({
          version: 1,
          issuedAt: Math.floor(Date.now() / 1000),
          tenantId: tenant.tenantId,
          brandId: null,
          deviceId: ids.device,
        }),
      )
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    base,
    create: (body: Record<string, unknown> = {}) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
        ...body,
      }),
    get: (orderId: string) =>
      who.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    list: () => who.client.get(base).set(headers).set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    complete: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/complete`, { expectedStatus }),
    voidOrder: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/void`, body),
    correctionVoid: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/void`, body),
    refund: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/refund`, body),
  };
}

type Created = {
  orderId: string;
  status: string;
  totalIdr: number;
  number: string;
};

/** create -> submit (when drafted) -> cash tender; the sale is not yet completed. */
async function payableOrder(): Promise<Created> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  const paid = await pos().cash(orderId, status, totalIdr + 5_000);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  status = paid.body.data.order.status as string;
  const { rows } = await owner.query<{ number: string }>(
    "SELECT number FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return { orderId, status, totalIdr, number: rows[0]!.number };
}

/** Voids the order's line and adds a dearer swap replacement line + its resolved issue. */
async function swapLine(orderId: string) {
  await asOwnerTenant(tenant.tenantId, async (client) => {
    const dbOrder = ulidToUuid(orderId);
    const original = await client.query<{
      id: string;
      outlet_id: string;
      business_date: string;
    }>(
      `SELECT i.id, i.outlet_id, o.business_date::text AS business_date
         FROM order_items i JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
        WHERE i.tenant_id = $1 AND i.order_id = $2::uuid`,
      [tenant.tenantId, dbOrder],
    );
    const line = original.rows[0]!;
    const replacementId = ulidToUuid(createUlid());
    await client.query(
      `UPDATE order_items SET status = 'voided' WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, line.id],
    );
    await client.query(
      `INSERT INTO order_items (id, tenant_id, outlet_id, order_id, menu_item_id, name, quantity,
         unit_price_idr, modifiers_total_idr, line_total_idr, modifiers, fire_status, status,
         reserved_business_date)
       VALUES ($1, $2, $3, $4::uuid, $5, 'Kopi Susu Besar', 2, 30000, 0, 60000, '[]', 'fired',
         'queued', $6::date)`,
      [
        replacementId,
        tenant.tenantId,
        line.outlet_id,
        dbOrder,
        ids.kopi,
        line.business_date,
      ],
    );
    await client.query(
      `INSERT INTO pos_order_items (item_id, tenant_id, outlet_id, order_id)
       VALUES ($1, $2, $3, $4::uuid)`,
      [replacementId, tenant.tenantId, line.outlet_id, dbOrder],
    );
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, resolution, replacement_item_id, replacement_order_item_id,
         replacement_unit_price_idr, cost_idr, idempotency_key, status, resolved_at)
       VALUES ($1, $2, $3, $4::uuid, $5, 'unfulfillable', 'out_of_stock', 'Bahan habis, diganti menu lain',
         $6, 'swap', $7, $8, 30000, 0, $9, 'resolved', now())`,
      [
        randomUUID(),
        tenant.tenantId,
        line.outlet_id,
        dbOrder,
        line.id,
        cashier.userId,
        ids.kopi,
        replacementId,
        randomUUID(),
      ],
    );
  });
}

async function paidPayloadOf(
  orderId: string,
): Promise<Record<string, unknown>> {
  const { rows } = await owner.query<{ payload: Record<string, unknown> }>(
    `SELECT event->'payload' AS payload FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'order.paid'
        AND event->'payload'->>'orderId' = $2`,
    [tenant.tenantId, orderId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.payload;
}

async function orderStatus(orderId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]?.status;
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`pos-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "POS Kasir Uji",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "pos.refund.request",
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "POS Supervisor Uji",
      ["order.view", "pos.void.approve", "pos.refund.approve"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, ($5::text IS NOT NULL), $5, $4, false, '["tenant"]')`,
      [
        id,
        tenant.tenantId,
        name,
        JSON.stringify(permissions),
        id === ids.supervisorRole ? "supervisor" : null,
      ],
    );
  // The till's signed token is only current while the device registry knows it.
  const deviceClient = await owner.connect();
  try {
    await deviceClient.query("BEGIN");
    await deviceClient.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenant.tenantId],
    );
    await deviceClient.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
       VALUES ($1, $2, $3, 'pos', 'Kasir Uji', now() - interval '1 minute')`,
      [ids.device, tenant.tenantId, tenant.outletId],
    );
    await deviceClient.query("COMMIT");
  } catch (error) {
    await deviceClient.query("ROLLBACK");
    throw error;
  } finally {
    deviceClient.release();
  }
  cashier = await member(ids.cashierRole, "POS Kasir");
  supervisor = await member(ids.supervisorRole, "POS Supervisor");
  // Finding 2: cash tenders, refunds and voids of cash-paid orders need the
  // acting cashier's open shift (409 SHIFT_NOT_OPEN otherwise). The cashier is
  // the actor of every sale, refund and void here, so one shift opened on the
  // registered device covers them all.
  await openPosShift(
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    ),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  await setStaffPin(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'POS Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    // PBJT 10% on F&B, menu prices exclude tax, no service charge rule: a
    // Rp50.000 sale is billed Rp55.000.
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  setEdgeCredentialVerifier(null);
  // Final orders are immutable and audit rows append-only, so the isolated
  // tenant stays in the disposable database; give it a valid creator.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-771dl the cloud order.paid carries the ingest keys when the lines add up", () => {
  it("a normal cloud sale closes and its order.paid has lines, subtotal, number and tender details", async () => {
    const order = await payableOrder();
    const completed = await pos().complete(order.orderId, order.status);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.data.status).toBe("completed");

    const payload = await paidPayloadOf(order.orderId);
    expect(orderPaidPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      orderNumber: order.number,
      subtotalIdr: 50_000,
      pricesIncludeTax: false,
      isTraining: false,
      totalIdr: 55_000,
    });
    expect(payload.lines).toEqual([
      expect.objectContaining({
        menuItemId: ids.kopi,
        name: "Kopi Susu",
        quantity: 2,
        unitPriceIdr: 25_000,
        lineTotalIdr: 50_000,
      }),
    ]);
    expect(payload.tenders).toEqual([
      expect.objectContaining({
        method: "cash",
        amountIdr: 55_000,
        receivedIdr: 60_000,
      }),
    ]);
  });
});

describe("legend-771dl the ingest keys are left out when the lines do not add up", () => {
  it("a sale whose non-void lines differ from the subtotal still completes, with a valid event that has no ingest keys", async () => {
    const order = await payableOrder();
    // A kitchen swap keeps the order money frozen (subtotal 50000) while the
    // live line is the dearer replacement (2 x 30000 = 60000): the only way the
    // non-void lines differ from the subtotal in a valid cloud order.
    await swapLine(order.orderId);

    const completed = await pos().complete(order.orderId, order.status);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.data.status).toBe("completed");
    expect(await orderStatus(order.orderId)).toBe("completed");

    const payload = await paidPayloadOf(order.orderId);
    expect(orderPaidPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({ orderId: order.orderId, totalIdr: 55_000 });
    expect(payload).not.toHaveProperty("lines");
    expect(payload).not.toHaveProperty("subtotalIdr");
    expect(payload).not.toHaveProperty("orderNumber");
  });

  it("the ordinary path still closes the next sale afterwards (no leftover state)", async () => {
    const order = await payableOrder();
    const completed = await pos().complete(order.orderId, order.status);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(await paidPayloadOf(order.orderId)).toHaveProperty("lines");
  });
});

describe("legend-cqehx the cloud order.paid says who attached the customer", () => {
  /** An open order with a member attached by the given staff user (or by nobody). */
  async function orderWithCustomer(attachedBy: string | null) {
    const order = await payableOrder();
    const profile = await seedMember(tenant.tenantId);
    await owner.query(
      `UPDATE orders SET customer_profile_id = $3::uuid, customer_attached_by = $4
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(order.orderId), profile.id, attachedBy],
    );
    return { order, profileId: profile.id };
  }

  it("a customer attached by a staff user: the payload carries that user id", async () => {
    const { order, profileId } = await orderWithCustomer(supervisor.userId);
    const completed = await pos().complete(order.orderId, order.status);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    const payload = await paidPayloadOf(order.orderId);
    expect(orderPaidPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      customerProfileId: profileId,
      customerAttachedBy: supervisor.userId,
    });
  });

  it("a customer nobody attached (they did it themselves): the key is present and null", async () => {
    const { order, profileId } = await orderWithCustomer(null);
    const completed = await pos().complete(order.orderId, order.status);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    const payload = await paidPayloadOf(order.orderId);
    expect(orderPaidPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({ customerProfileId: profileId });
    expect(payload).toHaveProperty("customerAttachedBy", null);
  });

  it("a sale without a customer: the key is absent", async () => {
    const order = await payableOrder();
    const completed = await pos().complete(order.orderId, order.status);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);

    const payload = await paidPayloadOf(order.orderId);
    expect(payload).toHaveProperty("customerProfileId", null);
    expect(payload).not.toHaveProperty("customerAttachedBy");
  });
});
