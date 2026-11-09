// Partial refund of a promo POS order (beads legend-q1e0, legend-9be7; brief
// 115 + sub-115, Tier K money). Founder rules (9 Nov 2026):
//   1. Promo still earned after the refund: refund = item price minus its
//      pro-rata share of the discount (subtotal 100k = 2 x 50k, discount 20k,
//      paid 80k, refund one 50k item -> 40k).
//   2. Promo condition no longer met (min spend 100k): promo withdrawn, kept
//      items at normal price, refund = paid - normal price of kept items
//      (same bill -> 30k).
//   3. Refund never reverses stock (only void does).
//
// Real Express app, Better Auth, RBAC, the REAL promo engine port and the REAL
// partial-refund port on PostgreSQL with RLS, in a fresh isolated tenant.
//
// Assumptions (spec ambiguity, see the brief):
// - This tenant has no tax or service-charge rule, so the bill equals the goods
//   (net of promo) and the payout equals the goods-level refund of the founder
//   examples; the `refunded_paid_idr` on the application row then equals the
//   payout.
// - A request that asks for more than is due is paid at the due amount
//   (`payout = min(amountIdr, due)`), not refused.
// - A failing promo-refund port surfaces as any 4xx/5xx; only "refused and
//   nothing written" is asserted, not the exact code.
// - Receipt numbering (legend-93a) is an in-memory double, as in
//   pos-order.test.ts.

import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
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
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import type { PromoPartialRefundPort } from "../services/crm-promo-refund.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { orderPromoPort } from "../services/order-promo.ts";
import { orderPromoPartialRefundPort } from "../services/order-promo-refund.ts";
import {
  setPosOrderPromoPort,
  setPosPromoRefundPort,
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const ITEM_IDR = 50_000;

const ids = {
  category: randomUUID(),
  itemA: randomUUID(),
  itemB: randomUUID(),
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
        deviceId: input.deviceId ?? ids.device,
        number: `POS1-${String(next).padStart(6, "0")}`,
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

// ---- Fixtures ---------------------------------------------------------------------

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

function tenantScope() {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

function pos() {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    cashier.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
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
    create: () =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [
          { menuItemId: ids.itemA, quantity: 1, modifierIds: [] },
          { menuItemId: ids.itemB, quantity: 1, modifierIds: [] },
        ],
      }),
    get: (orderId: string) =>
      cashier.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    promo: (orderId: string, promoCode: string) =>
      send(`/${orderId}/discounts`, {
        source: "promo",
        kind: "amount",
        promoCode,
        reason: "promo_engine",
      }),
    manual: (
      orderId: string,
      approval: { approvedBy: string; overrideId: string },
    ) =>
      send(`/${orderId}/discounts`, {
        source: "manual",
        kind: "percent",
        percentBp: 1_000,
        reason: "manager_goodwill",
        reasonNote: "Pelanggan tetap",
        ...approval,
      }),
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
    refund: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/refund`, body),
  };
}

const sha = (code: string) =>
  createHash("sha256").update(code, "utf8").digest("hex");
const newCode = () =>
  `T${randomUUID().replaceAll("-", "").slice(0, 11).toUpperCase()}`;

/** A code-gated promotion: Rp20.000 off a bill holding item A or B. */
async function seedPromotion(opts: { minSpendIdr?: number } = {}) {
  const id = randomUUID();
  const code = newCode();
  const conditions: unknown[] = [
    {
      kind: "item_quantity",
      menuItemIds: [ids.itemA, ids.itemB],
      minQuantity: 1,
    },
    ...(opts.minSpendIdr === undefined
      ? []
      : [{ kind: "min_spend", amountIdr: opts.minSpendIdr }]),
  ];
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO promotions
         (id, tenant_id, name, description, status, code_hash, voucher_required, starts_at, ends_at,
          conditions, benefit, stack_group, stackable, priority, quota_total, quota_per_customer,
          budget_idr)
       VALUES ($1, $2, $3, '', 'active', $4, true, now() - interval '1 hour', NULL, $5, $6, $7,
               true, 0, NULL, NULL, 1000000)`,
      [
        id,
        tenant.tenantId,
        `Refund promo ${id.slice(0, 8)}`,
        sha(code),
        JSON.stringify(conditions),
        JSON.stringify({ kind: "nominal_off", amountIdr: 20_000 }),
        `g${id.slice(0, 8)}`,
      ],
    ),
  );
  return { promotionId: id, code };
}

type PromoSale = {
  orderId: string;
  itemA: string;
  itemB: string;
  promotionId: string;
};

/**
 * Subtotal 100k (A 50k + B 50k), promo -20k, paid 80k in cash, completed.
 * `manual` first stacks a manual 10% discount (Rp10.000) under the promo, so
 * the guest pays Rp70.000. `expectedTotalIdr` overrides the 80k check for a
 * taxed bill; the guest always pays the order total.
 */
async function promoSale(
  opts: {
    minSpendIdr?: number;
    manual?: boolean;
    expectedTotalIdr?: number;
  } = {},
): Promise<PromoSale & { paidIdr: number }> {
  const { promotionId, code } = await seedPromotion(opts);
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  const items = created.body.data.items as { id: string; menuItemId: string }[];
  const itemA = items.find((item) => item.menuItemId === ids.itemA)?.id;
  const itemB = items.find((item) => item.menuItemId === ids.itemB)?.id;
  expect(itemA && itemB).toBeTruthy();

  if (opts.manual) {
    const manual = await pos().manual(
      orderId,
      await pinApproval(orderId, 10_000, "discount"),
    );
    expect(manual.status, JSON.stringify(manual.body)).toBeLessThan(300);
  }
  const discounted = await pos().promo(orderId, code);
  expect(discounted.status, JSON.stringify(discounted.body)).toBeLessThan(300);
  const fresh = (await pos().get(orderId)).body.data;
  const paidIdr = fresh.totalIdr as number;
  expect(paidIdr).toBe(
    opts.expectedTotalIdr ?? (opts.manual ? 70_000 : 80_000),
  );
  let status = fresh.status as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const paid = await pos().cash(orderId, status, paidIdr);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const completed = await pos().complete(
    orderId,
    paid.body.data.order.status as string,
  );
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return {
    orderId,
    itemA: itemA as string,
    itemB: itemB as string,
    promotionId,
    paidIdr,
  };
}

async function pinApproval(
  orderId: string,
  valueIdr: number,
  action: "refund" | "discount" = "refund",
) {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action,
      valueIdr,
      reason: "Pelanggan salah pesan",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: supervisor.userId, overrideId: override.id };
}

type RefundBody = {
  amountIdr: number;
  items?: { itemId: string; quantity: number }[];
  idempotencyKey?: string;
};

async function refundBody(orderId: string, input: RefundBody) {
  return {
    reason: "quality_complaint",
    reasonNote: "Satu porsi dikembalikan",
    ...input,
    ...(await pinApproval(orderId, input.amountIdr)),
  };
}

// ---- DB readers (owner connection with the tenant local set) -------------------------

async function application(orderId: string) {
  const { rows } = await asOwnerTenant((client) =>
    client.query(
      `SELECT total_discount_idr, paid_idr, refunded_paid_idr, refunded_subtotal_idr, status
         FROM promotion_order_applications WHERE tenant_id = $1 AND order_id = $2`,
      [tenant.tenantId, ulidToUuid(orderId as never)],
    ),
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  return {
    totalDiscount: Number(row?.total_discount_idr),
    paid: Number(row?.paid_idr),
    refundedPaid: Number(row?.refunded_paid_idr),
    refundedSubtotal: Number(row?.refunded_subtotal_idr),
    status: row?.status as string,
  };
}

async function refundRows(orderId: string) {
  const { rows } = await asOwnerTenant((client) =>
    client.query(
      `SELECT amount_idr, items FROM pos_order_refunds
        WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at`,
      [tenant.tenantId, ulidToUuid(orderId as never)],
    ),
  );
  return rows.map((row) => ({
    amount: Number(row.amount_idr),
    items: row.items as { itemId: string; quantity: number }[],
  }));
}

async function spentOf(promotionId: string) {
  const { rows } = await asOwnerTenant((client) =>
    client.query(
      "SELECT spent_idr FROM promotions WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, promotionId],
    ),
  );
  return Number(rows[0]?.spent_idr);
}

/** Stock the sale reserved: refunds must leave it as it is. */
async function dailyStock() {
  const { rows } = await asOwnerTenant((client) =>
    client.query(
      `SELECT menu_item_id, quantity FROM menu_item_daily_usage
        WHERE tenant_id = $1 AND menu_item_id = ANY($2::uuid[])
        ORDER BY menu_item_id`,
      [tenant.tenantId, [ids.itemA, ids.itemB]],
    ),
  );
  return rows.map((row) => `${row.menu_item_id}:${row.quantity}`);
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  setPosOrderPromoPort(orderPromoPort);
  tenant = await createIsolatedTenant(`pfp-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "POS Kasir Refund Promo",
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
      "POS Supervisor Refund Promo",
      [
        "order.view",
        "pos.void.approve",
        "pos.refund.approve",
        "pos.discount.approve",
      ],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "POS Kasir RP");
  supervisor = await member(ids.supervisorRole, "POS Supervisor RP");
  await openPosShift(
    tenantScope(),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(500_000), idempotencyKey: randomUUID() },
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
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Refund Promo Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ids.itemA, "Menu A"],
      [ids.itemB, "Menu B"],
    ] as const)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, tenant.tenantId, tenant.brandId, ids.category, name, randomUUID()],
      );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    // Tax settings and a rule per item are mandatory; the rule is 0% and there
    // is no service charge, so the bill equals the goods.
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
       VALUES ($1, $2, NULL, 'PBJT-0', 'PBJT 0%', 'pbjt', 0, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    for (const id of [ids.itemA, ids.itemB])
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, id, ITEM_IDR],
      );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setPosOrderPromoPort(null);
  setPosPromoRefundPort(null);
  setDeviceOutletResolver(null);
  // Final orders are immutable; give the tenant a valid creator so the
  // platform tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("legend-q1e0 partial refund of a promo order (founder examples)", () => {
  it("promo still earned: refunding one Rp50.000 item of a Rp100.000 bill with Rp20.000 off pays Rp40.000 and records it", async () => {
    const sale = await promoSale();
    const stockBefore = await dailyStock();
    expect(await spentOf(sale.promotionId)).toBe(20_000);

    const body = await refundBody(sale.orderId, {
      amountIdr: 40_000,
      items: [{ itemId: sale.itemA, quantity: 1 }],
    });
    const refunded = await pos().refund(sale.orderId, body);
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
    expect(refunded.body.data).toMatchObject({
      orderId: sale.orderId,
      amountIdr: 40_000,
      items: [{ itemId: sale.itemA, quantity: 1 }],
    });

    // refunded_paid_idr is the payout; the kept item B carries Rp10.000 of the
    // Rp20.000 discount (pro rata by price), so Rp10.000 goes back to the budget.
    expect(await application(sale.orderId)).toMatchObject({
      paid: 80_000,
      refundedPaid: 40_000,
      totalDiscount: 10_000,
      status: expect.not.stringMatching(/released/),
    });
    expect(await spentOf(sale.promotionId)).toBe(10_000);
    expect(await refundRows(sale.orderId)).toEqual([
      { amount: 40_000, items: [{ itemId: sale.itemA, quantity: 1 }] },
    ]);
    // The sale stays completed and stock is not given back (only void does).
    expect((await pos().get(sale.orderId)).body.data.status).toBe("completed");
    expect(await dailyStock()).toEqual(stockBefore);
  });

  it("promo withdrawn (min spend Rp100.000 no longer met): refund = paid - normal price of the kept item = Rp30.000", async () => {
    const sale = await promoSale({ minSpendIdr: 100_000 });
    const stockBefore = await dailyStock();

    const refunded = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 30_000,
        items: [{ itemId: sale.itemA, quantity: 1 }],
      }),
    );
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
    expect(refunded.body.data).toMatchObject({ amountIdr: 30_000 });

    expect(await application(sale.orderId)).toMatchObject({
      paid: 80_000,
      refundedPaid: 30_000,
      totalDiscount: 0,
    });
    // The whole promotion is given back to the budget.
    expect(await spentOf(sale.promotionId)).toBe(0);
    expect(await refundRows(sale.orderId)).toHaveLength(1);
    expect(await dailyStock()).toEqual(stockBefore);
  });

  it("asking for more than is due pays only the due amount (Rp45.000 asked, Rp40.000 paid and recorded)", async () => {
    const sale = await promoSale();
    const refunded = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 45_000,
        items: [{ itemId: sale.itemA, quantity: 1 }],
      }),
    );
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
    expect(refunded.body.data.amountIdr).toBe(40_000);
    expect((await application(sale.orderId)).refundedPaid).toBe(40_000);
    expect(await refundRows(sale.orderId)).toMatchObject([{ amount: 40_000 }]);
  });
});

describe("legend-9be7 refund idempotency, last item and refusals", () => {
  it("resending the same idempotencyKey replays the answer and never pays or records twice", async () => {
    const sale = await promoSale();
    const body = await refundBody(sale.orderId, {
      amountIdr: 40_000,
      items: [{ itemId: sale.itemA, quantity: 1 }],
      idempotencyKey: randomUUID(),
    });
    const first = await pos().refund(sale.orderId, body);
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const second = await pos().refund(sale.orderId, body);
    expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.amountIdr).toBe(40_000);

    expect(await refundRows(sale.orderId)).toHaveLength(1);
    expect(await application(sale.orderId)).toMatchObject({
      refundedPaid: 40_000,
      totalDiscount: 10_000,
    });
    expect(await spentOf(sale.promotionId)).toBe(10_000);
  });

  it("refunding the last remaining item returns what is left of the payment, withdraws the promo and the refunds total exactly what was paid", async () => {
    const sale = await promoSale();
    const stockBefore = await dailyStock();
    const first = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 40_000,
        items: [{ itemId: sale.itemA, quantity: 1 }],
      }),
    );
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);

    const last = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 40_000,
        items: [{ itemId: sale.itemB, quantity: 1 }],
      }),
    );
    expect(last.status, JSON.stringify(last.body)).toBeLessThan(300);
    expect(last.body.data.amountIdr).toBe(40_000);

    expect(await application(sale.orderId)).toMatchObject({
      paid: 80_000,
      refundedPaid: 80_000,
      totalDiscount: 0,
    });
    expect(await spentOf(sale.promotionId)).toBe(0);
    expect((await refundRows(sale.orderId)).map((row) => row.amount)).toEqual([
      40_000, 40_000,
    ]);
    expect(await dailyStock()).toEqual(stockBefore);

    // Nothing is left to refund: a further refund of anything is refused.
    const again = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 1_000,
        items: [{ itemId: sale.itemB, quantity: 1 }],
      }),
    );
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await refundRows(sale.orderId)).toHaveLength(2);
    expect((await application(sale.orderId)).refundedPaid).toBe(80_000);
  });

  it("a promo order refunded by amount only (no items) is refused with 422 and nothing is written", async () => {
    const sale = await promoSale();
    const refused = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, { amountIdr: 40_000 }),
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(await refundRows(sale.orderId)).toHaveLength(0);
    expect(await application(sale.orderId)).toMatchObject({
      refundedPaid: 0,
      totalDiscount: 20_000,
    });
    expect(await spentOf(sale.promotionId)).toBe(20_000);
  });

  it("a promo port that cannot run refuses the refund: no refund row, no payout recorded, promo budget untouched", async () => {
    const sale = await promoSale();
    const stockBefore = await dailyStock();
    const failing: PromoPartialRefundPort = {
      recomputeAfterPartialRefund: async () => {
        throw new Error("promo port down");
      },
      recordPartialRefundPayout: async () => {
        throw new Error("promo port down");
      },
    };
    setPosPromoRefundPort(failing);
    try {
      const refused = await pos().refund(
        sale.orderId,
        await refundBody(sale.orderId, {
          amountIdr: 40_000,
          items: [{ itemId: sale.itemA, quantity: 1 }],
        }),
      );
      expect(
        refused.status,
        JSON.stringify(refused.body),
      ).toBeGreaterThanOrEqual(400);
    } finally {
      setPosPromoRefundPort(null);
    }
    expect(await refundRows(sale.orderId)).toHaveLength(0);
    expect(await application(sale.orderId)).toMatchObject({
      refundedPaid: 0,
      totalDiscount: 20_000,
      refundedSubtotal: 0,
    });
    expect(await spentOf(sale.promotionId)).toBe(20_000);
    expect(await dailyStock()).toEqual(stockBefore);

    // With the real port restored, the same refund goes through.
    setPosPromoRefundPort(orderPromoPartialRefundPort);
    try {
      const ok = await pos().refund(
        sale.orderId,
        await refundBody(sale.orderId, {
          amountIdr: 40_000,
          items: [{ itemId: sale.itemA, quantity: 1 }],
        }),
      );
      expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
    } finally {
      setPosPromoRefundPort(null);
    }
    expect((await application(sale.orderId)).refundedPaid).toBe(40_000);
  });
});

describe("legend-q1e0 refund of a promo order that also carries a manual discount or tax", () => {
  it("manual 10% (Rp10.000) stacked with the Rp20.000 promo, paid Rp70.000: promo kept -> refund of one Rp50.000 item pays Rp35.000", async () => {
    const sale = await promoSale({ manual: true });
    const refunded = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 35_000,
        items: [{ itemId: sale.itemA, quantity: 1 }],
      }),
    );
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
    // 50k - 10k promo share - 5k manual share.
    expect(refunded.body.data.amountIdr).toBe(35_000);
    expect(await refundRows(sale.orderId)).toMatchObject([{ amount: 35_000 }]);
    expect(await spentOf(sale.promotionId)).toBe(10_000);
  });

  it("manual 10% stacked with a min-spend Rp100.000 promo, paid Rp70.000: promo withdrawn -> refund pays Rp25.000", async () => {
    const sale = await promoSale({ manual: true, minSpendIdr: 100_000 });
    const refunded = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        // Asking for more still pays only what is due.
        amountIdr: 35_000,
        items: [{ itemId: sale.itemA, quantity: 1 }],
      }),
    );
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
    // Paid 70k - kept B at normal price 50k + its 5k manual share = 25k.
    expect(refunded.body.data.amountIdr).toBe(25_000);
    expect(await refundRows(sale.orderId)).toMatchObject([{ amount: 25_000 }]);
    expect(await spentOf(sale.promotionId)).toBe(0);
  });

  it("taxed and service-charged sale: payout = paid total minus the kept share (keptGoods x total / net, floor)", async () => {
    // Swap the 0% rule for PBJT 10% (service in the base) and add a 5% service
    // charge for this one test; always restore.
    await asOwnerTenant(async (client) => {
      await client.query(
        "UPDATE tax_rules SET is_active = false WHERE tenant_id = $1 AND code = 'PBJT-0'",
        [tenant.tenantId],
      );
      await client.query(
        `INSERT INTO tax_rules
           (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
            price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
            published_at, published_by)
         VALUES ($1, $2, NULL, 'PBJT-10', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
                 '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
                 false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
        [randomUUID(), tenant.tenantId, supervisor.userId],
      );
      await client.query(
        `INSERT INTO service_charge_rules
           (id, tenant_id, outlet_id, code, name, rate_bp, zone_id, order_types, item_classes, is_active,
            version, effective_from, status, published_at, published_by)
         VALUES ($1, $2, NULL, 'SC-5', 'Service 5%', 500, NULL, '[]',
                 '["food_beverage"]', true, 1, '2026-01-01', 'published', now(), $3)`,
        [randomUUID(), tenant.tenantId, supervisor.userId],
      );
    });
    try {
      // net 80k + service 4k = 84k; PBJT 10% of 84k = 8.4k; total 92.4k.
      const sale = await promoSale({ expectedTotalIdr: 92_400 });
      const keptGoods = 40_000; // item B after its Rp10.000 promo share
      const net = 80_000;
      const expected =
        sale.paidIdr - Math.floor((keptGoods * sale.paidIdr) / net);
      expect(expected).toBe(46_200);
      const refunded = await pos().refund(
        sale.orderId,
        await refundBody(sale.orderId, {
          amountIdr: expected + 1_000,
          items: [{ itemId: sale.itemA, quantity: 1 }],
        }),
      );
      expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
      expect(refunded.body.data.amountIdr).toBe(expected);
      expect(await refundRows(sale.orderId)).toMatchObject([
        { amount: expected },
      ]);
      // The application records the goods part of the payout, never more.
      const app = await application(sale.orderId);
      expect(app.refundedPaid).toBeGreaterThan(0);
      expect(app.refundedPaid).toBeLessThanOrEqual(expected);
    } finally {
      await asOwnerTenant(async (client) => {
        await client.query(
          "UPDATE tax_rules SET is_active = false WHERE tenant_id = $1 AND code = 'PBJT-10'",
          [tenant.tenantId],
        );
        await client.query(
          "UPDATE service_charge_rules SET is_active = false WHERE tenant_id = $1",
          [tenant.tenantId],
        );
        await client.query(
          "UPDATE tax_rules SET is_active = true WHERE tenant_id = $1 AND code = 'PBJT-0'",
          [tenant.tenantId],
        );
      });
    }
  });
});
