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
import { registerTestDevice } from "./device-seed.ts";
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
import { getEndOfDayRecap } from "../services/pos-day.service.ts";
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
    send,
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
    /**
     * Pay with these captured QRIS tenders (oldest first, each with its own
     * payment_intent_id) instead of cash. They must add up to the order total.
     */
    qrisTenders?: number[];
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
  if (opts.qrisTenders) {
    expect(opts.qrisTenders.reduce((sum, amount) => sum + amount, 0)).toBe(
      paidIdr,
    );
    await asOwnerTenant(async (client) => {
      for (const [index, amount] of opts.qrisTenders!.entries()) {
        const intentId = await seedPaidIntent(
          client,
          tenant.tenantId,
          tenant.outletId,
          amount,
        );
        await client.query(
          `INSERT INTO pos_order_tenders
             (tenant_id, outlet_id, order_id, method, provider, amount_idr,
              payment_intent_id, status, requested_at, resolved_at)
           VALUES ($1, $2, $3, 'qris', 'doit', $4, $5, 'captured',
                   now() - ($6::int * interval '1 minute'), now())`,
          [
            tenant.tenantId,
            tenant.outletId,
            ulidToUuid(orderId as never),
            amount,
            intentId,
            10 - index,
          ],
        );
      }
    });
    const completed = await pos().complete(orderId, status);
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  } else {
    const paid = await pos().cash(orderId, status, paidIdr);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const completed = await pos().complete(
      orderId,
      paid.body.data.order.status as string,
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  }
  return {
    orderId,
    itemA: itemA as string,
    itemB: itemB as string,
    promotionId,
    paidIdr,
  };
}

/**
 * A really paid gateway payment (link, paid intent, evidence) for a POS tender to name.
 * legend-1116: a tender naming an intent that does not exist (or is not paid) is not
 * proof of money received, so the fixture must pay for real.
 */
async function seedPaidIntent(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  tenantId: string,
  outletId: string,
  amountIdr: number,
): Promise<string> {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await client.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, '1116-fixture')`,
    [
      linkId,
      tenantId,
      outletId,
      randomUUID().replaceAll("-", "").padEnd(64, "0"),
      `F1116-${linkId.slice(0, 8)}`,
      amountIdr,
    ],
  );
  await client.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
        idempotency_key, status, instructions, expires_at, paid_at, provider_ref)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
             '{"method":"qris","qrPayload":"00020101021226FIX","issuer":null}',
             now() + interval '1 hour', now(), $7)`,
    [
      intentId,
      tenantId,
      outletId,
      linkId,
      amountIdr,
      `f1116-${intentId}`,
      `FIX-${intentId.slice(0, 12)}`,
    ],
  );
  await client.query(
    `INSERT INTO payment_evidence
       (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method,
        source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', $5, now())`,
    [tenantId, outletId, intentId, `FIXEV-${intentId.slice(0, 12)}`, amountIdr],
  );
  return intentId;
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
        WHERE tenant_id = $1 AND order_id = $2 ORDER BY refunded_at, id`,
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
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.device,
  });
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
       VALUES ($1, $2, $3, ($5::text IS NOT NULL), $5, $4, false, '["tenant"]')`,
      [
        id,
        tenant.tenantId,
        name,
        JSON.stringify(permissions),
        id === ids.supervisorRole ? "supervisor" : null,
      ],
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
    // Split: the refunded item (Rp50.000) is gross, Rp10.000 of its discount goes.
    expect(await refundedSplits(sale.orderId)).toMatchObject([
      { amountIdr: 40_000, grossSalesIdr: 50_000, discountIdr: 10_000 },
    ]);
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
    // legend-aef1: the refunded item is Rp50.000 gross and the whole Rp20.000
    // discount is reversed (not the order's 25% ratio: 37.5k / 7.5k).
    expect(await refundedSplits(sale.orderId)).toMatchObject([
      { amountIdr: 30_000, grossSalesIdr: 50_000, discountIdr: 20_000 },
    ]);
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

describe("legend-4fzhu refund rows are read in the product order (refunded_at, id), never created_at", () => {
  it("two refunds whose created_at is reversed by hand still read back in refunded_at order", async () => {
    const sale = await promoSale();
    for (const [itemId, amountIdr] of [
      [sale.itemA, 40_000],
      [sale.itemB, 40_000],
    ] as const) {
      const refund = await pos().refund(
        sale.orderId,
        await refundBody(sale.orderId, {
          amountIdr,
          items: [{ itemId, quantity: 1 }],
        }),
      );
      expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    }
    // refunded_at is the app clock and keeps the order of the calls; created_at
    // is then set backwards, as a skewed VM clock can do (Colima steps it back
    // ~120 ms). Only created_at changes, so the shared tenant's recap stays
    // balanced. The refunded item tells the two rows apart.
    await asOwnerTenant(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE pos_order_refunds
            SET created_at = '2026-01-01T00:00:00Z'::timestamptz
                             - (refunded_at - '2000-01-01T00:00:00Z'::timestamptz)
          WHERE tenant_id = $1 AND order_id = $2`,
        [tenant.tenantId, ulidToUuid(sale.orderId as never)],
      );
    });
    // Precondition: created_at alone now gives the opposite order.
    const { rows: byCreatedAt } = await asOwnerTenant((client) =>
      client.query(
        `SELECT items FROM pos_order_refunds
          WHERE tenant_id = $1 AND order_id = $2 ORDER BY created_at`,
        [tenant.tenantId, ulidToUuid(sale.orderId as never)],
      ),
    );
    expect(
      byCreatedAt.map((row) => (row.items as { itemId: string }[])[0]?.itemId),
    ).toEqual([sale.itemB, sale.itemA]);

    expect(
      (await refundRows(sale.orderId)).map((row) => row.items[0]?.itemId),
    ).toEqual([sale.itemA, sale.itemB]);
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

  it("legend-77r0 refuses a refund when the injected promo lookup fails", async () => {
    const sale = await promoSale();
    let lookupCalls = 0;
    setPosPromoRefundPort({
      ...orderPromoPartialRefundPort,
      livePromoApplicationOf: async () => {
        lookupCalls += 1;
        throw new Error("promo lookup unavailable");
      },
    });
    try {
      const response = await pos().refund(
        sale.orderId,
        await refundBody(sale.orderId, {
          amountIdr: 40_000,
          items: [{ itemId: sale.itemA, quantity: 1 }],
        }),
      );
      expect(lookupCalls).toBe(1);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await refundRows(sale.orderId)).toHaveLength(0);
      expect(await application(sale.orderId)).toMatchObject({
        refundedPaid: 0,
        totalDiscount: 20_000,
      });
      expect(await spentOf(sale.promotionId)).toBe(20_000);
    } finally {
      setPosPromoRefundPort(null);
    }
  });

  it("a promo port that cannot run refuses the refund: no refund row, no payout recorded, promo budget untouched", async () => {
    const sale = await promoSale();
    const stockBefore = await dailyStock();
    const failing: PromoPartialRefundPort = {
      livePromoApplicationOf:
        orderPromoPartialRefundPort.livePromoApplicationOf,
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

// ---- Q19 (founder 9 Nov 2026, bead legend-15by): returned free item pays Rp0 ------------
// The kept discount is also capped by what the promotion still gives when it is
// re-evaluated on the kept lines. Promo: "buy 2 coffee, get 1 croissant free"
// (free_items, one croissant per 2 coffee). Coffee 30k, croissant 25k, juice 30k.
//
// Assumptions (see docs/briefs/sub-115-refund-promo.md "Q19" and
// docs/briefs/sub-wkl3-rp0-return.md):
// - Returning a free item (payout Rp0) is NOT refused: it is accepted with 201
//   and recorded as a refund row of Rp0 with the returned items (record of the
//   goods returned). No gateway call, no stock reversal, no order.refunded
//   event, and the day recap does not count it as a refund. The CRM port still
//   runs, so the kept discount drops to 25k and the released 25k goes back to
//   the promo budget.
// - A request asking for more than is due is paid at the due amount.
// - The free croissants are named in the stored discount (50k = 2 x 25k).

const q19 = {
  coffee: randomUUID(),
  croissant: randomUUID(),
  juice: randomUUID(),
};
const COFFEE_IDR = 30_000;
const CROISSANT_IDR = 25_000;
const JUICE_IDR = 30_000;

async function seedQ19Menu() {
  await asOwnerTenant(async (client) => {
    for (const [id, name, price] of [
      [q19.coffee, "Kopi Q19", COFFEE_IDR],
      [q19.croissant, "Croissant Q19", CROISSANT_IDR],
      [q19.juice, "Jus Q19", JUICE_IDR],
    ] as const) {
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, tenant.tenantId, tenant.brandId, ids.category, name, randomUUID()],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, id, price],
      );
    }
  });
}

async function seedBogoPromotion() {
  const id = randomUUID();
  const code = newCode();
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
        `Beli 2 kopi gratis croissant ${id.slice(0, 8)}`,
        sha(code),
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [q19.coffee], minQuantity: 2 },
        ]),
        JSON.stringify({
          kind: "free_items",
          menuItemIds: [q19.croissant],
          quantityPerMultiple: 1,
        }),
        `g${id.slice(0, 8)}`,
      ],
    ),
  );
  return { promotionId: id, code };
}

/** Completed, cash-paid sale of `lines` with the BOGO promo applied. */
async function bogoSale(
  lines: { menuItemId: string; quantity: number }[],
  expected: { subtotalIdr: number; discountIdr: number },
) {
  const { promotionId, code } = await seedBogoPromotion();
  const created = await cashier.client
    .post(`/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`)
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
    .send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: lines.map((entry) => ({ ...entry, modifierIds: [] })),
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  const items = created.body.data.items as { id: string; menuItemId: string }[];
  const lineOf = (menuItemId: string) => {
    const found = items.find((item) => item.menuItemId === menuItemId)?.id;
    expect(found).toBeTruthy();
    return found as string;
  };

  const discounted = await pos().promo(orderId, code);
  expect(discounted.status, JSON.stringify(discounted.body)).toBeLessThan(300);
  const fresh = (await pos().get(orderId)).body.data;
  const paidIdr = fresh.totalIdr as number;
  expect(paidIdr).toBe(expected.subtotalIdr - expected.discountIdr);
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
  expect(await spentOf(promotionId)).toBe(expected.discountIdr);
  return { orderId, promotionId, paidIdr, lineOf };
}

/** Stock the Q19 items reserved: a refund must leave it as it is. */
async function q19Stock() {
  const { rows } = await asOwnerTenant((client) =>
    client.query(
      `SELECT menu_item_id, quantity FROM menu_item_daily_usage
        WHERE tenant_id = $1 AND menu_item_id = ANY($2::uuid[])
        ORDER BY menu_item_id`,
      [tenant.tenantId, [q19.coffee, q19.croissant, q19.juice]],
    ),
  );
  return rows.map((row) => `${row.menu_item_id}:${row.quantity}`);
}

async function orderEventTypes(orderId: string) {
  const { rows } = await owner.query<{ type: string }>(
    `SELECT type FROM order_events WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId as never)],
  );
  return rows.map((row) => row.type);
}

/** The revenue split of each order.refunded event of an order (legend-aef1). */
async function refundedSplits(orderId: string) {
  const { rows } = await owner.query<{
    amountIdr: number;
    grossSalesIdr: number;
    discountIdr: number;
    serviceChargeIdr: number;
    pbjtIdr: number;
  }>(
    `SELECT (event->'payload'->>'amountIdr')::int AS "amountIdr",
            (event->'payload'->>'grossSalesIdr')::int AS "grossSalesIdr",
            (event->'payload'->>'discountIdr')::int AS "discountIdr",
            (event->'payload'->>'serviceChargeIdr')::int AS "serviceChargeIdr",
            (event->'payload'->>'pbjtIdr')::int AS "pbjtIdr"
       FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'order.refunded'
        AND event->'payload'->>'orderId' = $2
      ORDER BY id`,
    [tenant.tenantId, orderId],
  );
  return rows;
}

async function outboxEventNames(orderId: string) {
  const { rows } = await owner.query<{ name: string }>(
    `SELECT event->>'name' AS name FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->'payload'->>'orderId' = $2`,
    [tenant.tenantId, orderId],
  );
  return rows.map((row) => row.name);
}

async function businessDateOf(orderId: string) {
  const { rows } = await owner.query<{ business_date: string }>(
    `SELECT business_date::text AS business_date FROM orders
      WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId as never)],
  );
  return rows[0]?.business_date as string;
}

/** End-of-day recap read as an outlet manager (pos.day.close). */
let recapReader: Member | null = null;
async function recapOf(businessDate: string) {
  if (!recapReader) {
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Manajer Recap Refund Promo', false, NULL, $3, false, '["tenant"]')`,
      [roleId, tenant.tenantId, JSON.stringify(["pos.day.close"])],
    );
    recapReader = await member(roleId, "Manajer RP");
  }
  return getEndOfDayRecap(
    tenantScope(),
    { userId: userIdSchema.parse(recapReader.userId) },
    outletIdSchema.parse(tenant.outletId),
    businessDate,
  );
}

describe("legend-15by Q19 kept discount is capped by what the promo still gives", () => {
  beforeAll(seedQ19Menu);

  it("BOGO: 4 coffee + 2 croissant (170k, 50k off, paid 120k), returning 1 free croissant is recorded as a Rp0 goods return", async () => {
    const sale = await bogoSale(
      [
        { menuItemId: q19.coffee, quantity: 4 },
        { menuItemId: q19.croissant, quantity: 2 },
      ],
      { subtotalIdr: 170_000, discountIdr: 50_000 },
    );
    const stockBefore = await q19Stock();
    const croissantLine = sale.lineOf(q19.croissant);

    const returned = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        // Even a request for the full croissant price pays nothing: the kept
        // lines still earn 25k, exactly what the returned croissant carried.
        amountIdr: CROISSANT_IDR,
        items: [{ itemId: croissantLine, quantity: 1 }],
      }),
    );
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);
    expect(returned.body.data.amountIdr).toBe(0);
    expect(returned.body.data.lines).toEqual([]);
    expect(returned.body.data.items).toEqual([
      { itemId: croissantLine, quantity: 1 },
    ]);

    // One Rp0 row naming the croissant; nothing paid out.
    expect(await refundRows(sale.orderId)).toEqual([
      { amount: 0, items: [{ itemId: croissantLine, quantity: 1 }] },
    ]);
    expect(await application(sale.orderId)).toMatchObject({
      paid: 120_000,
      refundedPaid: 0,
      totalDiscount: 25_000,
      refundedSubtotal: 25_000,
    });
    // The free croissant is no longer given: its 25k goes back to the budget.
    expect(await spentOf(sale.promotionId)).toBe(25_000);
    expect(await q19Stock()).toEqual(stockBefore);

    // Audit trail says it was a goods return only.
    const audit = await asOwnerTenant((client) =>
      client.query<{ event: unknown }>(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' = 'pos_order.refunded'`,
        [tenant.tenantId],
      ),
    );
    const forOrder = audit.rows.filter((row) =>
      JSON.stringify(row.event).includes(sale.orderId),
    );
    expect(forOrder).toHaveLength(1);
    expect(forOrder[0]?.event).toMatchObject({
      objectType: "pos_order_refund",
      maskedChanges: { after: { amountIdr: 0, goodsReturnOnly: true } },
    });

    // No money moved: no order.refunded event, in the order stream or the outbox.
    // (order.paid is asserted too so the queries are known to see this order.)
    expect(await orderEventTypes(sale.orderId)).toContain("order.paid");
    expect(await orderEventTypes(sale.orderId)).not.toContain("order.refunded");
    expect(await outboxEventNames(sale.orderId)).toContain("order.paid");
    expect(await outboxEventNames(sale.orderId)).not.toContain(
      "order.refunded",
    );
  });

  it("resending the same idempotency key returns the same Rp0 response and writes nothing more", async () => {
    const sale = await bogoSale(
      [
        { menuItemId: q19.coffee, quantity: 4 },
        { menuItemId: q19.croissant, quantity: 2 },
      ],
      { subtotalIdr: 170_000, discountIdr: 50_000 },
    );
    const body = await refundBody(sale.orderId, {
      amountIdr: CROISSANT_IDR,
      items: [{ itemId: sale.lineOf(q19.croissant), quantity: 1 }],
      idempotencyKey: randomUUID(),
    });

    const first = await pos().refund(sale.orderId, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const again = await pos().refund(sale.orderId, body);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.data).toEqual(first.body.data);

    expect(await refundRows(sale.orderId)).toHaveLength(1);
    expect(await application(sale.orderId)).toMatchObject({
      paid: 120_000,
      refundedPaid: 0,
      totalDiscount: 25_000,
      refundedSubtotal: 25_000,
    });
    expect(await spentOf(sale.promotionId)).toBe(25_000);
  });

  it("the end-of-day recap is the same before and after a Rp0 goods return", async () => {
    const sale = await bogoSale(
      [
        { menuItemId: q19.coffee, quantity: 4 },
        { menuItemId: q19.croissant, quantity: 2 },
      ],
      { subtotalIdr: 170_000, discountIdr: 50_000 },
    );
    const businessDate = await businessDateOf(sale.orderId);
    const before = await recapOf(businessDate);
    // Guard: the day holds the sale, so "unchanged" is not an empty-day pass.
    expect(before.totalSalesIdr).toBeGreaterThanOrEqual(sale.paidIdr);

    const returned = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: CROISSANT_IDR,
        items: [{ itemId: sale.lineOf(q19.croissant), quantity: 1 }],
      }),
    );
    expect(returned.status, JSON.stringify(returned.body)).toBe(201);

    const after = await recapOf(businessDate);
    // id and generatedAt differ on every read; everything else must match.
    const stable = (recap: typeof before) => ({
      ...recap,
      id: null,
      generatedAt: null,
    });
    expect(stable(after)).toEqual(stable(before));
  });

  it("path independence: after the Rp0 croissant return, returning 1 coffee pays Rp30.000, the same as returning 1 coffee + 1 croissant at once", async () => {
    const lines = [
      { menuItemId: q19.coffee, quantity: 4 },
      { menuItemId: q19.croissant, quantity: 2 },
    ];
    const bill = { subtotalIdr: 170_000, discountIdr: 50_000 };

    const stepwise = await bogoSale(lines, bill);
    const croissant = await pos().refund(
      stepwise.orderId,
      await refundBody(stepwise.orderId, {
        amountIdr: CROISSANT_IDR,
        items: [{ itemId: stepwise.lineOf(q19.croissant), quantity: 1 }],
      }),
    );
    expect(croissant.status, JSON.stringify(croissant.body)).toBe(201);
    expect(croissant.body.data.amountIdr).toBe(0);
    // Kept 3 coffee + 1 croissant = 115k, 25k off, 90k payable; paid 120k.
    const coffee = await pos().refund(
      stepwise.orderId,
      await refundBody(stepwise.orderId, {
        amountIdr: COFFEE_IDR,
        items: [{ itemId: stepwise.lineOf(q19.coffee), quantity: 1 }],
      }),
    );
    expect(coffee.status, JSON.stringify(coffee.body)).toBe(201);
    expect(coffee.body.data.amountIdr).toBe(30_000);
    expect(await application(stepwise.orderId)).toMatchObject({
      paid: 120_000,
      refundedPaid: 30_000,
      totalDiscount: 25_000,
    });
    expect(await spentOf(stepwise.promotionId)).toBe(25_000);

    const atOnce = await bogoSale(lines, bill);
    const both = await pos().refund(
      atOnce.orderId,
      await refundBody(atOnce.orderId, {
        amountIdr: COFFEE_IDR + CROISSANT_IDR,
        items: [
          { itemId: atOnce.lineOf(q19.coffee), quantity: 1 },
          { itemId: atOnce.lineOf(q19.croissant), quantity: 1 },
        ],
      }),
    );
    expect(both.status, JSON.stringify(both.body)).toBe(201);
    expect(both.body.data.amountIdr).toBe(30_000);
  });

  it("Mixed A: same bill, returning 1 coffee keeps 25k off (3 coffee + 2 croissant = 140k) and pays Rp5.000", async () => {
    const sale = await bogoSale(
      [
        { menuItemId: q19.coffee, quantity: 4 },
        { menuItemId: q19.croissant, quantity: 2 },
      ],
      { subtotalIdr: 170_000, discountIdr: 50_000 },
    );

    const refunded = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        // Asking for the coffee price still pays only what is due.
        amountIdr: COFFEE_IDR,
        items: [{ itemId: sale.lineOf(q19.coffee), quantity: 1 }],
      }),
    );
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
    // Paid 120k - (kept 140k - kept discount 25k) = 5k.
    expect(refunded.body.data.amountIdr).toBe(5_000);

    expect(await application(sale.orderId)).toMatchObject({
      paid: 120_000,
      refundedPaid: 5_000,
      totalDiscount: 25_000,
    });
    // The released croissant's 25k goes back to the promo budget.
    expect(await spentOf(sale.promotionId)).toBe(25_000);
    expect(await refundRows(sale.orderId)).toEqual([
      {
        amount: 5_000,
        items: [{ itemId: sale.lineOf(q19.coffee), quantity: 1 }],
      },
    ]);
  });

  it("Mixed B: 2 coffee + 1 croissant + 1 juice (115k, 25k off, paid 90k), returning the juice is bound by pro rata: kept 18.478 off, pays Rp23.478", async () => {
    const sale = await bogoSale(
      [
        { menuItemId: q19.coffee, quantity: 2 },
        { menuItemId: q19.croissant, quantity: 1 },
        { menuItemId: q19.juice, quantity: 1 },
      ],
      { subtotalIdr: 115_000, discountIdr: 25_000 },
    );

    const refunded = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: JUICE_IDR,
        items: [{ itemId: sale.lineOf(q19.juice), quantity: 1 }],
      }),
    );
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
    // Pro rata of 25k over kept 85k / standing 115k = 18.478 (the cap of 25k
    // does not bind); payout = 90k - (85k - 18.478k) = 23.478k.
    expect(refunded.body.data.amountIdr).toBe(23_478);

    expect(await application(sale.orderId)).toMatchObject({
      paid: 90_000,
      refundedPaid: 23_478,
      totalDiscount: 18_478,
    });
    expect(await spentOf(sale.promotionId)).toBe(18_478);
    expect(await refundRows(sale.orderId)).toMatchObject([{ amount: 23_478 }]);
  });
});

// ---- Q19b (founder review fix, brief sub-115 "Q19b"): path-independent, stack-ordered, ----
// ---- per-line kept discount -----------------------------------------------------------
// Rule per still-applied redemption row i (brief):
//   o_i = its ORIGINAL discount, share_i = o_i x kept / subtotal (original basis),
//   r_i = re-check of the kept lines in stack order (free items first, then the
//   bill-level promos / value vouchers on what is left),
//   k_i = min(share_i, o_i, r_i); kept discount = sum k_i; every redemption row and
//   its promotion's spent_idr drop by exactly their own cut (o_i - k_i).
//
// Case (a) here, through the POS. BOGO + 10% stacked and BOGO + value voucher
// cannot be built through the POS (one code per order, tenant stacking off), so they
// live in order-promo-db.test.ts against orderPromoPartialRefundPort.
//
// Assumptions:
// - Prices: coffee 30k, croissant 25k; BOGO = "buy 2 coffee, 1 croissant free".
// - A request for more than is due is paid at the due amount.

/** The still-applied redemption rows of an order, with the discount each one carries. */
async function appliedRedemptions(orderId: string) {
  const { rows } = await asOwnerTenant((client) =>
    client.query(
      `SELECT promotion_id, voucher_id, discount_idr FROM promotion_redemptions
        WHERE tenant_id = $1 AND order_id = $2 AND status = 'applied'`,
      [tenant.tenantId, ulidToUuid(orderId as never)],
    ),
  );
  return rows.map((row) => ({
    promotionId: row.promotion_id as string | null,
    voucherId: row.voucher_id as string | null,
    discount: Number(row.discount_idr),
  }));
}

/** Invariant: the applied redemption rows add up to the application's discount. */
async function expectRowsMatchApplication(orderId: string) {
  const rows = await appliedRedemptions(orderId);
  const sum = rows.reduce((total, row) => total + row.discount, 0);
  expect(sum).toBe((await application(orderId)).totalDiscount);
}

describe("legend-15by Q19b path-independent, stack-ordered, per-line kept discount", () => {
  // q19 menu items are seeded once by the Q19 describe above (same file, runs first).

  it("(a) BOGO 4 coffee + 2 croissant (170k, 50k off, paid 120k): returning coffee then coffee pays 5k + 30k = 35k, the same as returning both at once", async () => {
    const sale = await bogoSale(
      [
        { menuItemId: q19.coffee, quantity: 4 },
        { menuItemId: q19.croissant, quantity: 2 },
      ],
      { subtotalIdr: 170_000, discountIdr: 50_000 },
    );
    const coffeeLine = sale.lineOf(q19.coffee);

    // Step 1: kept 140k, BOGO still gives 25k -> pays 120k - (140k - 25k) = 5k.
    const first = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: COFFEE_IDR,
        items: [{ itemId: coffeeLine, quantity: 1 }],
      }),
    );
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    expect(first.body.data.amountIdr).toBe(5_000);
    await expectRowsMatchApplication(sale.orderId);

    // Step 2: kept 110k, BOGO still gives 25k -> cumulative 120k - (110k - 25k)
    // = 35k, so this step pays 30k (not the 24.643k of the old pro-rata-on-current rule).
    const second = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: COFFEE_IDR,
        items: [{ itemId: coffeeLine, quantity: 1 }],
      }),
    );
    expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
    expect(second.body.data.amountIdr).toBe(30_000);

    expect(
      (await refundRows(sale.orderId)).reduce(
        (sum, row) => sum + row.amount,
        0,
      ),
    ).toBe(35_000);
    expect(await application(sale.orderId)).toMatchObject({
      paid: 120_000,
      refundedPaid: 35_000,
      totalDiscount: 25_000,
    });
    expect(await spentOf(sale.promotionId)).toBe(25_000);
    expect(await appliedRedemptions(sale.orderId)).toMatchObject([
      { promotionId: sale.promotionId, discount: 25_000 },
    ]);
    await expectRowsMatchApplication(sale.orderId);
  });
});

// Q81 supersedes tender-only DP returns: missing original-payer provenance is refused.
describe("legend-77r0 Q81 synthetic deposit has no verified payer", () => {
  for (const tenderIdr of [80_000, 30_000])
    it(`refuses an unproven DP50k with tender${tenderIdr} before paying or recording any return`, async () => {
      const sale = await promoSale();
      await asOwnerTenant(async (client) => {
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query(
          "UPDATE orders SET deposit_applied_idr=50000 WHERE tenant_id=$1 AND id=$2",
          [tenant.tenantId, ulidToUuid(sale.orderId as never)],
        );
        await client.query(
          "UPDATE pos_order_tenders SET amount_idr=$3,received_idr=$3 WHERE tenant_id=$1 AND order_id=$2",
          [tenant.tenantId, ulidToUuid(sale.orderId as never), tenderIdr],
        );
      });
      const response = await pos().refund(
        sale.orderId,
        await refundBody(sale.orderId, {
          amountIdr: 40_000,
          items: [{ itemId: sale.itemA, quantity: 1 }],
        }),
      );
      expect(
        response.status,
        JSON.stringify(response.body),
      ).toBeGreaterThanOrEqual(400);
      expect(await refundRows(sale.orderId)).toHaveLength(0);
      expect((await application(sale.orderId)).refundedPaid).toBe(0);
    });
});

// ---- Brief sub-172 A (legend-a0i7) and B: Codex 127 #1 and #2 -------------------------
//
// A1 (Codex #1): refund of a promo order must not depend on how the return is
//   split. Promo "buy 2 coffee (Rp30.000), 1 cheapest pastry free". Order: 4
//   coffee + 2 pastry Rp20.000 + 1 pastry Rp40.000 = Rp200.000, promo Rp40.000,
//   paid Rp160.000. Returning 1 coffee + 2 cheap pastries at once refunds
//   Rp56.000 (kept discount 26k, payable 104k); returning 1 coffee, then the 2
//   cheap pastries, must refund Rp10.000 + Rp46.000 = Rp56.000 as well.
// B1 (Codex #2): on a promo order a refund that asks for less than is due is
//   refused 422 REFUND_AMOUNT_BELOW_DUE (nothing written), so the remainder is
//   never locked behind an exhausted item quantity.
//
// Assumptions (spec ambiguity):
// - "gratis 1 pastry termurah" is modelled as a free_items benefit over both
//   pastry menu items, one per multiple of 2 coffee; the engine gives the
//   cheapest ones (sale preconditions below assert the 40k discount).
// - The error code is read from `body.error.code ?? body.code`, like the
//   existing REFUND_NOTHING_DUE test; the message must name the due amount
//   (Rp40.000) in any thousand-separator format.
// - Each refund request asks for exactly what is due, so the test stays valid
//   once "asking for less than due" is refused (B1 fix).

const a1 = {
  coffee: randomUUID(),
  pastryCheap: randomUUID(),
  pastryDear: randomUUID(),
};

async function seedA1Menu() {
  await asOwnerTenant(async (client) => {
    for (const [id, name, price] of [
      [a1.coffee, "Kopi A1", 30_000],
      [a1.pastryCheap, "Pastry Murah A1", 20_000],
      [a1.pastryDear, "Pastry Mahal A1", 40_000],
    ] as const) {
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, tenant.tenantId, tenant.brandId, ids.category, name, randomUUID()],
      );
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, id, price],
      );
    }
  });
}

/** Buy 2 coffee, 1 cheapest pastry free (per multiple of 2). */
async function seedCheapestPastryPromotion() {
  const id = randomUUID();
  const code = newCode();
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
        `Beli 2 kopi gratis pastry termurah ${id.slice(0, 8)}`,
        sha(code),
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [a1.coffee], minQuantity: 2 },
        ]),
        JSON.stringify({
          kind: "free_items",
          menuItemIds: [a1.pastryCheap, a1.pastryDear],
          quantityPerMultiple: 1,
        }),
        `g${id.slice(0, 8)}`,
      ],
    ),
  );
  return { promotionId: id, code };
}

/** 4 coffee + 2 cheap pastry + 1 dear pastry, promo applied, paid in cash, completed. */
async function a1Sale() {
  const { promotionId, code } = await seedCheapestPastryPromotion();
  const created = await pos().send("", {
    channel: "pos",
    serviceType: "takeaway",
    items: [
      { menuItemId: a1.coffee, quantity: 4, modifierIds: [] },
      { menuItemId: a1.pastryCheap, quantity: 2, modifierIds: [] },
      { menuItemId: a1.pastryDear, quantity: 1, modifierIds: [] },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  const items = created.body.data.items as { id: string; menuItemId: string }[];
  const lineOf = (menuItemId: string) => {
    const found = items.find((item) => item.menuItemId === menuItemId)?.id;
    expect(found).toBeTruthy();
    return found as string;
  };
  const discounted = await pos().promo(orderId, code);
  expect(discounted.status, JSON.stringify(discounted.body)).toBeLessThan(300);
  const fresh = (await pos().get(orderId)).body.data;
  expect(fresh.totalIdr).toBe(160_000);
  let status = fresh.status as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const paid = await pos().cash(orderId, status, 160_000);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const completed = await pos().complete(
    orderId,
    paid.body.data.order.status as string,
  );
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  expect(await spentOf(promotionId)).toBe(40_000);
  return { orderId, promotionId, lineOf };
}

describe("sub-172 A legend-a0i7 refund is independent of how the return is split", () => {
  beforeAll(seedA1Menu);

  it("A1: 4 coffee + 2 cheap pastry + 1 dear pastry (200k, 40k off, paid 160k): coffee then 2 cheap pastries refunds Rp56.000 in total, same as at once, with the same promo discount and budget", async () => {
    // Path 1, all at once: kept 3 coffee + dear pastry = 130k, kept discount
    // min(share 26k, original 40k, recheck 40k) = 26k, payable 104k -> refund 56k.
    const once = await a1Sale();
    const atOnce = await pos().refund(
      once.orderId,
      await refundBody(once.orderId, {
        amountIdr: 56_000,
        items: [
          { itemId: once.lineOf(a1.coffee), quantity: 1 },
          { itemId: once.lineOf(a1.pastryCheap), quantity: 2 },
        ],
      }),
    );
    expect(atOnce.status, JSON.stringify(atOnce.body)).toBe(201);
    expect(atOnce.body.data.amountIdr).toBe(56_000);
    const onceApplication = await application(once.orderId);
    const onceSpent = await spentOf(once.promotionId);
    const onceRedemptions = await appliedRedemptions(once.orderId);
    expect(onceApplication).toMatchObject({
      paid: 160_000,
      refundedPaid: 56_000,
      totalDiscount: 26_000,
    });
    expect(onceSpent).toBe(26_000);

    // Path 2, stepwise. Step 1: kept 3 coffee + 3 pastry = 170k, recheck 20k
    // -> payable 150k, refund 10k.
    const step = await a1Sale();
    const first = await pos().refund(
      step.orderId,
      await refundBody(step.orderId, {
        amountIdr: 10_000,
        items: [{ itemId: step.lineOf(a1.coffee), quantity: 1 }],
      }),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.amountIdr).toBe(10_000);
    expect(await application(step.orderId)).toMatchObject({
      totalDiscount: 20_000,
    });
    expect(await spentOf(step.promotionId)).toBe(20_000);

    // Step 2: kept 3 coffee + dear pastry = 130k, recheck is 40k again, so the
    // kept discount must go back UP to 26k -> payable 104k, cumulative 56k,
    // this step refunds 46k (old code: capped at the lowered 20k -> only 40k).
    const second = await pos().refund(
      step.orderId,
      await refundBody(step.orderId, {
        amountIdr: 46_000,
        items: [{ itemId: step.lineOf(a1.pastryCheap), quantity: 2 }],
      }),
    );
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.amountIdr).toBe(46_000);

    const rows = await refundRows(step.orderId);
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(56_000);
    expect(await application(step.orderId)).toMatchObject({
      paid: 160_000,
      refundedPaid: onceApplication.refundedPaid,
      totalDiscount: onceApplication.totalDiscount,
    });
    expect(await spentOf(step.promotionId)).toBe(onceSpent);
    expect(
      (await appliedRedemptions(step.orderId)).map((row) => row.discount),
    ).toEqual(onceRedemptions.map((row) => row.discount));
    await expectRowsMatchApplication(step.orderId);
  });

  // A2 assumptions (spec ambiguity):
  // - "the line" is the applied promotion_redemptions row of the order.
  // - The audit row is read from audit_logs by event->>'action' =
  //   'promo_application.clamped' for this order; budgetShortIdr is searched
  //   anywhere in the event JSON (its exact nesting is not specified).
  it("A2: same staged return, but the budget is used up between step 1 and step 2 (budget = spent): step 2 still pays Rp46.000 (total Rp56.000), spent stays within budget, the line stays at 20.000, and promo_application.clamped records budgetShortIdr 6000", async () => {
    const sale = await a1Sale();
    const first = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 10_000,
        items: [{ itemId: sale.lineOf(a1.coffee), quantity: 1 }],
      }),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.amountIdr).toBe(10_000);
    const spentAfterFirst = await spentOf(sale.promotionId);
    expect(spentAfterFirst).toBe(20_000);

    // Another sale uses the freed room: budget = what is spent now.
    await asOwnerTenant((client) =>
      client.query(
        `UPDATE promotions SET budget_idr = spent_idr
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, sale.promotionId],
      ),
    );

    const second = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 46_000,
        items: [{ itemId: sale.lineOf(a1.pastryCheap), quantity: 2 }],
      }),
    );
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.amountIdr).toBe(46_000);
    expect(
      (await refundRows(sale.orderId)).reduce(
        (sum, row) => sum + row.amount,
        0,
      ),
    ).toBe(56_000);

    // Budget has no room: spent is unchanged and still within the budget.
    expect(await spentOf(sale.promotionId)).toBe(spentAfterFirst);
    const { rows: budgetRows } = await asOwnerTenant((client) =>
      client.query(
        "SELECT budget_idr, spent_idr FROM promotions WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, sale.promotionId],
      ),
    );
    expect(Number(budgetRows[0]?.spent_idr)).toBeLessThanOrEqual(
      Number(budgetRows[0]?.budget_idr),
    );

    // The line could not go back up to 26k: it stays at 20k.
    expect(
      (await appliedRedemptions(sale.orderId)).map((row) => row.discount),
    ).toEqual([20_000]);
    // Not asserted: application.total_discount_idr (26k observed) vs the rows
    // (20k); the brief only fixes the line and the budget.

    // Audit row: 26k wanted, 20k fits -> 6k short of budget.
    const audit = await asOwnerTenant((client) =>
      client.query<{ event: unknown }>(
        `SELECT event FROM audit_logs
          WHERE tenant_id = $1 AND event->>'action' = 'promo_application.clamped'`,
        [tenant.tenantId],
      ),
    );
    const forOrder = audit.rows.filter((row) =>
      JSON.stringify(row.event).includes(sale.orderId),
    );
    expect(forOrder.length).toBeGreaterThanOrEqual(1);
    expect(
      forOrder.some((row) =>
        /"budgetShortIdr":\s*6000\b/.test(JSON.stringify(row.event)),
      ),
      JSON.stringify(forOrder.map((row) => row.event)),
    ).toBe(true);
  });
});

describe("sub-172 B refund below what is due on a promo order", () => {
  it("B1: 2 x 50k, 20k off, paid 80k: refund A = 40k, then asking only 30k for B is 422 REFUND_AMOUNT_BELOW_DUE and writes nothing; asking 40k passes, total 80k", async () => {
    const sale = await promoSale();
    const firstRefund = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 40_000,
        items: [{ itemId: sale.itemA, quantity: 1 }],
      }),
    );
    expect(firstRefund.status, JSON.stringify(firstRefund.body)).toBe(201);
    expect(firstRefund.body.data.amountIdr).toBe(40_000);

    const applicationBefore = await application(sale.orderId);
    const spentBefore = await spentOf(sale.promotionId);
    const stockBefore = await dailyStock();

    // Less than the Rp40.000 due: refused before anything is written.
    const refused = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 30_000,
        items: [{ itemId: sale.itemB, quantity: 1 }],
      }),
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error?.code ?? refused.body.code).toBe(
      "REFUND_AMOUNT_BELOW_DUE",
    );
    expect(JSON.stringify(refused.body)).toMatch(/40[.,]?000/);
    expect(await refundRows(sale.orderId)).toHaveLength(1);
    expect(await application(sale.orderId)).toEqual(applicationBefore);
    expect(applicationBefore.refundedPaid).toBe(40_000);
    expect(await spentOf(sale.promotionId)).toBe(spentBefore);
    expect(await dailyStock()).toEqual(stockBefore);

    // Asking exactly what is due passes; the whole Rp80.000 is refunded.
    const accepted = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 40_000,
        items: [{ itemId: sale.itemB, quantity: 1 }],
      }),
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    expect(accepted.body.data.amountIdr).toBe(40_000);
    expect(
      (await refundRows(sale.orderId)).reduce(
        (sum, row) => sum + row.amount,
        0,
      ),
    ).toBe(80_000);
    expect((await application(sale.orderId)).refundedPaid).toBe(80_000);
  });
});

// ---- Brief 186 (ws/pos-refund-promo): BOGO card numbers and legend-s7rx ----------------
// legend-8v2yl (tender and intent id per refund line) is covered at the end.
//
// Assumptions (spec ambiguity):
// - s7rx A: a "locked" promo order is built with two real item refunds (Rp40.000
//   each), then, as the owner, the second row's amount_idr/lines and
//   promotion_order_applications.refunded_paid_idr are lowered so only Rp50.000
//   of the Rp80.000 paid went out (pre-a0i7 state). A refund with no items must
//   settle the rest: payout = paid - refunded - keptPayable = 80.000 - 50.000 - 0
//   = 30.000, capped at that (a larger request is paid at 30.000). The
//   settlement row carries no items; when nothing is owed it is 422
//   REFUND_NOTHING_DUE and writes nothing (never a Rp0 row without items).
// - s7rx B: deposit order (depositAppliedIdr 50.000, tenders 80.000, bill 90.000)
//   built as in the legend-wkl3 test. After item 1 drained the tenders, item 2
//   must not be 422; it is recorded as a Rp0 goods return (201, amountIdr 0).
//   The audit row of a refund where the order has a deposit and dueBill >
//   payout carries `maskedChanges.after.depositOwedIdr = max(0, dueBill - owedIdr)`
//   (read from audit_logs event->>'action' = 'pos_order.refunded', like the
//   legend-wkl3 test). The Rp0 row of a Rp50.000 deposit records 50.000 owed.
// - 8v2yl: refund lines are persisted as {method, amountIdr, reference, tenderId,
//   paymentIntentId} (camelCase keys, in pos_order_refunds.lines), split FIFO
//   over the captured tenders by requested_at. The order.refunded outbox event
//   keeps one {method, amountIdr} line per method and no tender ids.

describe("legend-186 legend-15by BOGO card numbers: croissant Rp0 then coffee Rp30.000", () => {
  beforeAll(async () => {
    // The Q19 menu may already be seeded by the imported suite.
    const { rows } = await asOwnerTenant((client) =>
      client.query("SELECT 1 FROM menu_items WHERE id = $1", [q19.coffee]),
    );
    if (rows.length === 0) await seedQ19Menu();
  });

  it("4 coffee + 2 croissant (170k, 50k off, paid 120k): croissant is a Rp0 row, then 1 coffee pays Rp30.000", async () => {
    const sale = await bogoSale(
      [
        { menuItemId: q19.coffee, quantity: 4 },
        { menuItemId: q19.croissant, quantity: 2 },
      ],
      { subtotalIdr: 170_000, discountIdr: 50_000 },
    );
    const croissantLine = sale.lineOf(q19.croissant);
    const coffeeLine = sale.lineOf(q19.coffee);

    const croissant = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: CROISSANT_IDR,
        items: [{ itemId: croissantLine, quantity: 1 }],
      }),
    );
    expect(croissant.status, JSON.stringify(croissant.body)).toBe(201);
    expect(croissant.body.data.amountIdr).toBe(0);
    expect(croissant.body.data.lines).toEqual([]);
    expect(croissant.body.data.items).toEqual([
      { itemId: croissantLine, quantity: 1 },
    ]);

    const coffee = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: COFFEE_IDR,
        items: [{ itemId: coffeeLine, quantity: 1 }],
      }),
    );
    expect(coffee.status, JSON.stringify(coffee.body)).toBe(201);
    expect(coffee.body.data.amountIdr).toBe(30_000);

    expect(await refundRows(sale.orderId)).toEqual([
      { amount: 0, items: [{ itemId: croissantLine, quantity: 1 }] },
      { amount: 30_000, items: [{ itemId: coffeeLine, quantity: 1 }] },
    ]);
    expect(await application(sale.orderId)).toMatchObject({
      paid: 120_000,
      refundedPaid: 30_000,
      totalDiscount: 25_000,
    });
    expect(await spentOf(sale.promotionId)).toBe(25_000);
  });
});

describe("legend-186 legend-s7rx A settlement refund without items on a locked promo order", () => {
  async function lockedSale() {
    const sale = await promoSale(); // 2 x 50k, 20k off, paid 80k cash
    for (const itemId of [sale.itemA, sale.itemB]) {
      const refund = await pos().refund(
        sale.orderId,
        await refundBody(sale.orderId, {
          amountIdr: 40_000,
          items: [{ itemId, quantity: 1 }],
        }),
      );
      expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    }
    // Pre-a0i7 state: the last row paid out only Rp10.000 instead of Rp40.000.
    await asOwnerTenant(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE pos_order_refunds
            SET amount_idr = 10000, lines = $3::jsonb
          WHERE id = (SELECT id FROM pos_order_refunds
                       WHERE tenant_id = $1 AND order_id = $2
                       ORDER BY refunded_at DESC, id DESC LIMIT 1)`,
        [
          tenant.tenantId,
          ulidToUuid(sale.orderId as never),
          JSON.stringify([
            { method: "cash", amountIdr: 10_000, reference: null },
          ]),
        ],
      );
      await client.query(
        `UPDATE promotion_order_applications SET refunded_paid_idr = 50000
          WHERE tenant_id = $1 AND order_id = $2`,
        [tenant.tenantId, ulidToUuid(sale.orderId as never)],
      );
    });
    expect((await refundRows(sale.orderId)).map((row) => row.amount)).toEqual([
      40_000, 10_000,
    ]);
    return sale;
  }

  it("earlier rows returned all items but paid only Rp50.000 of Rp80.000: a refund with no items settles the remaining Rp30.000", async () => {
    const sale = await lockedSale();

    const settled = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, { amountIdr: 30_000 }),
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(201);
    expect(settled.body.data.amountIdr).toBe(30_000);

    const rows = await refundRows(sale.orderId);
    expect(rows.map((row) => row.amount)).toEqual([40_000, 10_000, 30_000]);
    expect(rows[2]?.items).toEqual([]);
    expect((await application(sale.orderId)).refundedPaid).toBe(80_000);
  });

  it("asking for more than is owed pays only what is owed (Rp30.000)", async () => {
    const sale = await lockedSale();

    const settled = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, { amountIdr: 50_000 }),
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(201);
    expect(settled.body.data.amountIdr).toBe(30_000);
  });

  // Service change after architect review (legend-s7rx): a settlement on a
  // promo order that has NO earlier refund row is a plain validation error
  // (pick the items); REFUND_NOTHING_DUE stays for orders with earlier refunds.
  it("untouched promo order, no items: 422 VALIDATION_ERROR 'pilih item yang direfund' and nothing is written", async () => {
    const sale = await promoSale(); // paid 80k, nothing refunded, all items kept
    const refused = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, { amountIdr: 1_000 }),
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error?.code ?? refused.body.code).toBe(
      "VALIDATION_ERROR",
    );
    expect(JSON.stringify(refused.body)).toMatch(/pilih item yang direfund/);
    expect(await refundRows(sale.orderId)).toHaveLength(0);
    expect(await application(sale.orderId)).toMatchObject({
      refundedPaid: 0,
      totalDiscount: 20_000,
    });
    expect(await spentOf(sale.promotionId)).toBe(20_000);
  });

  it("settled once: a second settlement has nothing owed and is 422 REFUND_NOTHING_DUE", async () => {
    const sale = await lockedSale();
    const settled = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, { amountIdr: 30_000 }),
    );
    expect(settled.status, JSON.stringify(settled.body)).toBe(201);

    const again = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, { amountIdr: 1_000 }),
    );
    expect(again.status, JSON.stringify(again.body)).toBe(422);
    expect(again.body.error?.code ?? again.body.code).toBe(
      "REFUND_NOTHING_DUE",
    );
    expect(await refundRows(sale.orderId)).toHaveLength(3);
  });

  // Service change (legend-s7rx): a settlement whose promo re-check withdraws
  // the promo is 422 REFUND_SETTLEMENT_NEEDS_ADMIN on every attempt (it can
  // repeat, so no retry hint) and nothing is written.
  // Assumption: "the re-check withdraws" is built by refunding item A for real
  // (kept item B keeps the 20k promo), lowering that row to Rp10.000 (Rp30.000
  // still owed), clearing the application's rules_snapshot so the LIVE rule is
  // read, then raising the live promo's min spend (100k) above the kept
  // subtotal (50k).
  it("settlement whose promo re-check withdraws the promo: 422 REFUND_SETTLEMENT_NEEDS_ADMIN twice, nothing written, application unchanged", async () => {
    const sale = await promoSale(); // 2 x 50k, 20k off, paid 80k cash
    const first = await pos().refund(
      sale.orderId,
      await refundBody(sale.orderId, {
        amountIdr: 40_000,
        items: [{ itemId: sale.itemA, quantity: 1 }],
      }),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    await asOwnerTenant(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE pos_order_refunds SET amount_idr = 10000, lines = $3::jsonb
          WHERE tenant_id = $1 AND order_id = $2`,
        [
          tenant.tenantId,
          ulidToUuid(sale.orderId as never),
          JSON.stringify([
            { method: "cash", amountIdr: 10_000, reference: null },
          ]),
        ],
      );
      await client.query(
        `UPDATE promotion_order_applications
            SET refunded_paid_idr = 10000, rules_snapshot = NULL
          WHERE tenant_id = $1 AND order_id = $2`,
        [tenant.tenantId, ulidToUuid(sale.orderId as never)],
      );
      await client.query(
        `UPDATE promotions
            SET conditions = conditions || $3::jsonb
          WHERE tenant_id = $1 AND id = $2`,
        [
          tenant.tenantId,
          sale.promotionId,
          JSON.stringify([{ kind: "min_spend", amountIdr: 100_000 }]),
        ],
      );
    });

    const rowsBefore = await refundRows(sale.orderId);
    const applicationBefore = await application(sale.orderId);
    const spentBefore = await spentOf(sale.promotionId);
    expect(rowsBefore).toHaveLength(1);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await pos().refund(
        sale.orderId,
        await refundBody(sale.orderId, { amountIdr: 30_000 }),
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.error?.code ?? refused.body.code).toBe(
        "REFUND_SETTLEMENT_NEEDS_ADMIN",
      );
      expect(await refundRows(sale.orderId)).toEqual(rowsBefore);
      expect(await application(sale.orderId)).toEqual(applicationBefore);
      expect(await spentOf(sale.promotionId)).toBe(spentBefore);
    }
  });
});

/** 'pos_order.refunded' audit events of one order, keyed by the payout. */
describe("legend-186 legend-8v2yl refund lines carry the tender and payment intent they came from", () => {
  type Tender = { id: string; intent: string };

  async function tendersOf(orderId: string): Promise<Tender[]> {
    const { rows } = await owner.query<{ id: string; intent: string }>(
      `SELECT id, payment_intent_id AS intent FROM pos_order_tenders
        WHERE tenant_id = $1 AND order_id = $2::uuid
        ORDER BY requested_at, id`,
      [tenant.tenantId, ulidToUuid(orderId as never)],
    );
    return rows;
  }

  async function refundLines(orderId: string) {
    const { rows } = await owner.query<{ lines: unknown }>(
      `SELECT lines FROM pos_order_refunds
        WHERE tenant_id = $1 AND order_id = $2::uuid ORDER BY refunded_at, id`,
      [tenant.tenantId, ulidToUuid(orderId as never)],
    );
    return rows.map((row) => row.lines);
  }

  async function eventLines(orderId: string) {
    const { rows } = await owner.query<{ lines: unknown }>(
      `SELECT event->'payload'->'lines' AS lines FROM domain_event_outbox
        WHERE tenant_id = $1 AND event->>'name' = 'order.refunded'
          AND event->'payload'->>'orderId' = $2`,
      [tenant.tenantId, orderId],
    );
    return rows.map((row) => row.lines);
  }

  async function refundItem(orderId: string, itemId: string) {
    const refund = await pos().refund(
      orderId,
      await refundBody(orderId, {
        amountIdr: 40_000,
        items: [{ itemId, quantity: 1 }],
      }),
    );
    expect(refund.status, JSON.stringify(refund.body)).toBe(201);
    expect(refund.body.data.amountIdr).toBe(40_000);
  }

  it("two QRIS tenders (30k + 50k, different intents): refund 40k fills tender 1 then tender 2, the next 40k continues on tender 2", async () => {
    const sale = await promoSale({ qrisTenders: [30_000, 50_000] });
    const [t1, t2] = await tendersOf(sale.orderId);
    expect(t1?.intent).toBeTruthy();
    expect(t2?.intent).toBeTruthy();
    expect(t1?.intent).not.toBe(t2?.intent);

    await refundItem(sale.orderId, sale.itemA);
    await refundItem(sale.orderId, sale.itemB);

    expect(await refundLines(sale.orderId)).toEqual([
      [
        {
          method: "qris",
          amountIdr: 30_000,
          reference: null,
          tenderId: t1?.id,
          paymentIntentId: t1?.intent,
        },
        {
          method: "qris",
          amountIdr: 10_000,
          reference: null,
          tenderId: t2?.id,
          paymentIntentId: t2?.intent,
        },
      ],
      [
        {
          method: "qris",
          amountIdr: 40_000,
          reference: null,
          tenderId: t2?.id,
          paymentIntentId: t2?.intent,
        },
      ],
    ]);
  });

  it("a legacy refund line without tenderId is replayed FIFO: the next refund lands on the tender that is still open", async () => {
    const sale = await promoSale({ qrisTenders: [30_000, 50_000] });
    const [, t2] = await tendersOf(sale.orderId);
    await refundItem(sale.orderId, sale.itemA);
    // Rewrite item 1's row as a legacy row: one method line, no ids.
    // pos_order_refunds is append-only: replica role skips the trigger for this
    // test-setup transaction only (same as the s7rx A setup).
    await asOwnerTenant(async (client) => {
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        `UPDATE pos_order_refunds SET lines = $3::jsonb
          WHERE tenant_id = $1 AND order_id = $2`,
        [
          tenant.tenantId,
          ulidToUuid(sale.orderId as never),
          JSON.stringify([
            { method: "qris", amountIdr: 40_000, reference: null },
          ]),
        ],
      );
    });

    await refundItem(sale.orderId, sale.itemB);

    const rows = await refundLines(sale.orderId);
    expect(rows[0]).toEqual([
      { method: "qris", amountIdr: 40_000, reference: null },
    ]);
    // Legacy 40k = 30k (tender 1, now empty) + 10k (tender 2): 40k left on tender 2.
    expect(rows[1]).toEqual([
      {
        method: "qris",
        amountIdr: 40_000,
        reference: null,
        tenderId: t2?.id,
        paymentIntentId: t2?.intent,
      },
    ]);
  });

  it("the order.refunded event is unchanged: one line per method, no tender or intent ids", async () => {
    const sale = await promoSale({ qrisTenders: [30_000, 50_000] });
    await refundItem(sale.orderId, sale.itemA); // spans both tenders

    const lines = await eventLines(sale.orderId);
    expect(lines).toHaveLength(1);
    const [only] = lines as { method: string; amountIdr: number }[][];
    expect(only).toHaveLength(1);
    expect(only?.[0]).toMatchObject({ method: "qris", amountIdr: 40_000 });
    expect(Object.keys(only?.[0] ?? {})).not.toContain("tenderId");
    expect(Object.keys(only?.[0] ?? {})).not.toContain("paymentIntentId");
  });
});
