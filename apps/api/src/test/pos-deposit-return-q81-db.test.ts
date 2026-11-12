// Founder Q81: returned goods refund the DP payer through the original method.
// Tender payout and DP refund liabilities together must never exceed paid money.
import { createHash, randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { kindTotals } from "../services/ai-anomaly.service.ts";
import { REFUNDS_JOIN } from "../services/metric-sources/sales.ts";
import { refundPosOrder } from "../services/pos-order-corrections.ts";
import { reverseJournal } from "../services/accounting-journal.service.ts";
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
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { registerTestDevice } from "./device-seed.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import { orderPromoPort } from "../services/order-promo.ts";
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
    send,
    create: (quantity = 1) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [
          { menuItemId: ids.itemA, quantity, modifierIds: [] },
          { menuItemId: ids.itemB, quantity, modifierIds: [] },
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
    quantity?: number;
    /**
     * Pay with these captured QRIS tenders (oldest first, each with its own
     * payment_intent_id) instead of cash. They must add up to the order total.
     */
    qrisTenders?: number[];
  } = {},
): Promise<PromoSale & { paidIdr: number }> {
  const { promotionId, code } = await seedPromotion(opts);
  const created = await pos().create(opts.quantity);
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
            randomUUID(),
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

async function pinApproval(
  orderId: string,
  valueIdr: number,
  action: "refund" | "discount" | "void" = "refund",
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

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  setPosOrderPromoPort(orderPromoPort);
  tenant = await createIsolatedTenant(`dp-return-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  await owner.query("UPDATE tenants SET feature_flags=$2::jsonb WHERE id=$1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["qr_order", "accounting"],
      integrationProviders: [],
    }),
  ]);
  for (const [role, code, name, type, group] of [
    ["gateway_clearing", "1201", "Kliring", "asset", "current_asset"],
    [
      "customer_deposit",
      "2107",
      "DP Pelanggan",
      "liability",
      "current_liability",
    ],
  ]) {
    const accountId = randomUUID();
    await owner.query(
      `INSERT INTO chart_of_accounts (id,tenant_id,legal_entity_id,code,name,type,report_group)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        accountId,
        tenant.tenantId,
        tenant.legalEntityId,
        code,
        name,
        type,
        group,
      ],
    );
    await owner.query(
      `INSERT INTO account_mappings (tenant_id,legal_entity_id,role,account_id)
      VALUES ($1,$2,$3,$4)`,
      [tenant.tenantId, tenant.legalEntityId, role, accountId],
    );
  }
  await owner.query(
    `INSERT INTO fiscal_periods (tenant_id,legal_entity_id,period)
    VALUES ($1,$2,$3)`,
    [
      tenant.tenantId,
      tenant.legalEntityId,
      new Date().toISOString().slice(0, 7),
    ],
  );

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

/** A paid DP with its payer's original QRIS intent, linked to the sold bill. */
async function depositSale(
  depositIdr = 50_000,
  totalIdr = 80_000,
  quantity = 1,
  originalMethod: "qris" | "bank_transfer" = "qris",
) {
  if (totalIdr !== 80_000)
    await asOwnerTenant((client) =>
      client.query(
        "UPDATE price_list_items SET price_idr=$3 WHERE tenant_id=$1 AND price_list_id=$2",
        [tenant.tenantId, ids.priceList, (totalIdr + 20_000) / (2 * quantity)],
      ),
    );
  const sale = await promoSale({ expectedTotalIdr: totalIdr, quantity });
  if (totalIdr !== 80_000)
    await asOwnerTenant((client) =>
      client.query(
        "UPDATE price_list_items SET price_idr=50000 WHERE tenant_id=$1 AND price_list_id=$2",
        [tenant.tenantId, ids.priceList],
      ),
    );
  const reservationId = randomUUID();
  const sessionId = randomUUID();
  const intentId = randomUUID();
  const linkId = randomUUID();
  const zoneId = randomUUID();
  const tableId = randomUUID();
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO floor_zones
      (id, tenant_id, outlet_id, name, payment_mode, hours)
      VALUES ($1,$2,$3,$4,'pay_first','[]')`,
      [zoneId, tenant.tenantId, tenant.outletId, `DP ${zoneId.slice(0, 8)}`],
    );
    await client.query(
      `INSERT INTO tables
      (id,tenant_id,outlet_id,zone_id,code,capacity,type,layout)
      VALUES ($1,$2,$3,$4,$5,2,'regular','{}')`,
      [
        tableId,
        tenant.tenantId,
        tenant.outletId,
        zoneId,
        `D${tableId.slice(0, 8).toUpperCase()}`,
      ],
    );
    await client.query(
      `INSERT INTO table_sessions
      (id,tenant_id,outlet_id,table_id,pax,payment_mode,status,session_token_hash,session_token_sealed,reservation_id)
      VALUES ($1,$2,$3,$4,2,'pay_first','open',$5,'test',$6)`,
      [
        sessionId,
        tenant.tenantId,
        tenant.outletId,
        tableId,
        sha(sessionId),
        reservationId,
      ],
    );
    await client.query(
      `INSERT INTO payment_links
      (id,tenant_id,outlet_id,token_hash,reference,subtotal_idr,total_idr,paid_idr,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$6,$7)`,
      [
        linkId,
        tenant.tenantId,
        tenant.outletId,
        sha(linkId),
        `DP-${linkId.slice(0, 8)}`,
        depositIdr,
        cashier.userId,
      ],
    );
    await client.query(
      `INSERT INTO payment_intents
      (id,tenant_id,outlet_id,payment_link_id,reservation_id,method,provider,amount_idr,idempotency_key,status,instructions,expires_at,paid_at)
      VALUES ($1,$2,$3,$4,$5,$8,'doit',$6,$7,'paid',$9::jsonb,now()+interval '1 day',now())`,
      [
        intentId,
        tenant.tenantId,
        tenant.outletId,
        linkId,
        reservationId,
        depositIdr,
        randomUUID(),
        originalMethod,
        JSON.stringify(
          originalMethod === "qris"
            ? { method: "qris", qrPayload: "test", issuer: null }
            : {
                method: "bank_transfer",
                channelCode: "BCA",
                channelName: "BCA",
                accountNumber: "1234567890",
                accountHolder: "DP asli",
                uniqueCode: "123",
                transferTotalIdr: depositIdr,
              },
        ),
      ],
    );
    await client.query(
      `INSERT INTO payment_evidence
      (tenant_id,outlet_id,payment_intent_id,provider,provider_ref,method,source,amount_idr,received_at)
      VALUES ($1,$2,$3,'doit',$4,$6,'verified_webhook',$5,now())`,
      [
        tenant.tenantId,
        tenant.outletId,
        intentId,
        `DP-EV-${intentId}`,
        depositIdr,
        originalMethod,
      ],
    );
    await client.query(
      `INSERT INTO reservations
      (id,tenant_id,outlet_id,guest_name,reserved_for,duration_minutes,pax,zone_id,deposit_idr,deposit_payment_id,policy_snapshot,status,source,seated_at,table_session_id)
      VALUES ($1,$2,$3,'Pembayar DP',now(),90,2,$4,$5,$6,'{}','seated','staff',now(),$7)`,
      [
        reservationId,
        tenant.tenantId,
        tenant.outletId,
        zoneId,
        depositIdr,
        intentId,
        sessionId,
      ],
    );
    await client.query(
      `INSERT INTO reservation_deposit_allocations
      (tenant_id,outlet_id,reservation_id,table_session_id,payment_intent_id,amount_idr)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        tenant.tenantId,
        tenant.outletId,
        reservationId,
        sessionId,
        intentId,
        depositIdr,
      ],
    );
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `UPDATE orders SET deposit_applied_idr=$3, table_session_id=$4
      WHERE tenant_id=$1 AND id=$2`,
      [
        tenant.tenantId,
        ulidToUuid(sale.orderId as never),
        depositIdr,
        sessionId,
      ],
    );
    await client.query(
      `UPDATE pos_order_tenders SET amount_idr=$3, received_idr=$3
      WHERE tenant_id=$1 AND order_id=$2`,
      [
        tenant.tenantId,
        ulidToUuid(sale.orderId as never),
        sale.paidIdr - depositIdr,
      ],
    );
  });
  const paidAt = new Date().toISOString();
  const receiptEvent = eventEnvelopeSchema.parse({
    id: createUlid(),
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    name: "payment.paid",
    version: 1,
    aggregateType: "payment",
    aggregateId: intentId,
    sequence: 1,
    occurredAt: paidAt,
    actor: { type: "system" },
    idempotencyKey: randomUUID(),
    payloadSchemaRef: "payment.paid.v1",
    payload: {
      intentId,
      method: originalMethod,
      provider: "doit",
      receivedIdr: depositIdr,
      paidAt,
      late: false,
    },
  });
  const receipt = await withTenant(db, tenantScope(), (tx) =>
    deliverAutoJournalEvent(tenantScope(), receiptEvent, tx, new Date()),
  );
  expect(receipt.status, JSON.stringify(receipt)).toBe("posted");
  return {
    ...sale,
    intentId,
    sessionId,
    reservationId,
    depositIdr,
    receiptJournalId: receipt.status === "posted" ? receipt.journalEntryId : "",
  };
}

async function dpRefunds(intentId: string) {
  return (
    await asOwnerTenant((client) =>
      client.query<{
        id: string;
        payment_intent_id: string;
        amount_idr: string;
        status: string;
      }>(
        `SELECT id,payment_intent_id,amount_idr::text,status FROM payment_refunds
      WHERE tenant_id=$1 AND payment_intent_id=$2 AND status <> 'failed' ORDER BY created_at,id`,
        [tenant.tenantId, intentId],
      ),
    )
  ).rows;
}

async function returnItem(sale: PromoSale, itemId: string, amountIdr = 40_000) {
  return pos().refund(
    sale.orderId,
    await refundBody(sale.orderId, {
      amountIdr,
      items: [{ itemId, quantity: 1 }],
    }),
  );
}

describe("legend-77r0 Q81 DP returns preserve the original payer and never overpay", () => {
  it("Q81-01: refund 40k from bill80k DP50k reserves25k to original QRIS intent and pays15k tender", async () => {
    const sale = await depositSale();
    const response = await returnItem(sale, sale.itemA);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.amountIdr).toBe(15_000);
    expect(response.body.data.lines).toMatchObject([
      { method: "cash", amountIdr: 15_000 },
    ]);
    expect(await dpRefunds(sale.intentId)).toMatchObject([
      {
        payment_intent_id: sale.intentId,
        amount_idr: "25000",
        status: "pending",
      },
    ]);
    expect((await application(sale.orderId)).refundedPaid).toBe(40_000);
    const events = await asOwnerTenant((client) =>
      client.query<{ payload: Record<string, unknown> }>(
        `SELECT event->'payload' AS payload FROM domain_event_outbox
        WHERE tenant_id=$1 AND event->>'name'='order.refunded'
          AND event->'payload'->>'orderId'=$2`,
        [tenant.tenantId, sale.orderId],
      ),
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload).toMatchObject({
      amountIdr: 40_000,
      refundCashIdr: 15_000,
      refundGatewayIdr: 25_000,
      lines: [{ method: "cash", amountIdr: 15_000 }],
      depositLines: [{ method: "qris", amountIdr: 25_000 }],
    });
  });

  it("Q81-02: retry of one idempotency key never creates a second DP refund or tender payout", async () => {
    const sale = await depositSale();
    const body = await refundBody(sale.orderId, {
      amountIdr: 40_000,
      items: [{ itemId: sale.itemA, quantity: 1 }],
      idempotencyKey: randomUUID(),
    });
    const first = await pos().refund(sale.orderId, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await pos().refund(sale.orderId, body);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await dpRefunds(sale.intentId)).toHaveLength(1);
    expect(await refundRows(sale.orderId)).toEqual([
      { amount: 15_000, items: [{ itemId: sale.itemA, quantity: 1 }] },
    ]);
  });

  it("Q81-03: repeated returns exhaust exactly DP50k+tender30k and cannot refund an item twice", async () => {
    const sale = await depositSale();
    for (const item of [sale.itemA, sale.itemB]) {
      const response = await returnItem(sale, item);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.data.amountIdr).toBe(15_000);
    }
    const dp = await dpRefunds(sale.intentId);
    expect(dp.reduce((sum, row) => sum + Number(row.amount_idr), 0)).toBe(
      50_000,
    );
    expect(
      (await refundRows(sale.orderId)).reduce(
        (sum, row) => sum + row.amount,
        0,
      ),
    ).toBe(30_000);
    const again = await returnItem(sale, sale.itemA);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await dpRefunds(sale.intentId)).toHaveLength(2);
  });

  it("Q81-04: two cashiers racing the same returned item reserve and pay only once", async () => {
    const sale = await depositSale();
    const bodies = await Promise.all([
      refundBody(sale.orderId, {
        amountIdr: 40_000,
        items: [{ itemId: sale.itemA, quantity: 1 }],
      }),
      refundBody(sale.orderId, {
        amountIdr: 40_000,
        items: [{ itemId: sale.itemA, quantity: 1 }],
      }),
    ]);
    const responses = await Promise.all(
      bodies.map((body) => pos().refund(sale.orderId, body)),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await dpRefunds(sale.intentId)).toMatchObject([
      { amount_idr: "25000" },
    ]);
    expect(await refundRows(sale.orderId)).toHaveLength(1);
  });

  it("Q81-05: DP share rounds down cumulatively, and all returns remain at or below real DP paid", async () => {
    const sale = await depositSale(50_001);
    const first = await returnItem(sale, sale.itemA);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.amountIdr).toBe(15_000);
    expect(await dpRefunds(sale.intentId)).toMatchObject([
      { amount_idr: "25000" },
    ]);
    const second = await returnItem(sale, sale.itemB);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.amountIdr).toBe(14_999);
    expect(
      (await dpRefunds(sale.intentId)).reduce(
        (sum, row) => sum + Number(row.amount_idr),
        0,
      ),
    ).toBe(50_001);
  });

  it("Q81-06: missing payer evidence refuses the whole correction before tender cash leaves", async () => {
    const sale = await depositSale();
    await asOwnerTenant((client) =>
      client.query(
        "DELETE FROM payment_evidence WHERE tenant_id=$1 AND payment_intent_id=$2",
        [tenant.tenantId, sale.intentId],
      ),
    );
    const response = await returnItem(sale, sale.itemA);
    expect(
      response.status,
      JSON.stringify(response.body),
    ).toBeGreaterThanOrEqual(400);
    expect(await refundRows(sale.orderId)).toHaveLength(0);
    expect(await dpRefunds(sale.intentId)).toHaveLength(0);
    expect((await application(sale.orderId)).refundedPaid).toBe(0);
  });

  it("Q81-07: a return followed by void cannot refund DP twice", async () => {
    const sale = await depositSale();
    const first = await returnItem(sale, sale.itemA);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const response = await pos().send(`/${sale.orderId}/corrections/void`, {
      reason: "wrong_order",
      reasonNote: "Pesanan sudah diretur",
      ...(await pinApproval(sale.orderId, 80_000, "void")),
    });
    expect(
      response.status,
      JSON.stringify(response.body),
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await dpRefunds(sale.intentId)).reduce(
        (sum, row) => sum + Number(row.amount_idr),
        0,
      ),
    ).toBe(25_000);
    expect(
      (await refundRows(sale.orderId)).reduce(
        (sum, row) => sum + row.amount,
        0,
      ),
    ).toBe(15_000);
  });
});

describe("legend-77r0 Q63 authority includes DP alongside tender refunds", () => {
  it("Q81-08: supervisor ceiling200k includes prior DP125k+tender75k; a third100k return is refused", async () => {
    const sale = await depositSale(250_000, 400_000, 2);
    const first = await returnItem(sale, sale.itemA, 100_000);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.amountIdr).toBe(37_500);
    const second = await returnItem(sale, sale.itemB, 100_000);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.amountIdr).toBe(37_500);
    const third = await returnItem(sale, sale.itemA, 100_000);
    expect(third.status, JSON.stringify(third.body)).toBe(403);
    expect(third.body.error.code).toBe("REFUND_APPROVAL_LIMIT_EXCEEDED");
    expect(
      (await refundRows(sale.orderId)).reduce(
        (sum, row) => sum + row.amount,
        0,
      ),
    ).toBe(75_000);
    expect(
      (await dpRefunds(sale.intentId)).reduce(
        (sum, row) => sum + Number(row.amount_idr),
        0,
      ),
    ).toBe(125_000);
  });
});

describe("legend-77r0 Q81 paid amount cap across refund paths", () => {
  it("Q81-09: an earlier pending original-payer refund reserves DP and prevents another correction from overpaying it", async () => {
    const sale = await depositSale();
    await asOwnerTenant((client) =>
      client.query(
        `INSERT INTO payment_refunds
      (tenant_id,outlet_id,payment_intent_id,amount_idr,reason,status,requested_by)
      VALUES($1,$2,$3,30000,'Refund sebelumnya','pending',$4)`,
        [tenant.tenantId, tenant.outletId, sale.intentId, cashier.userId],
      ),
    );
    const response = await returnItem(sale, sale.itemA);
    expect(
      response.status,
      JSON.stringify(response.body),
    ).toBeGreaterThanOrEqual(400);
    expect(await refundRows(sale.orderId)).toHaveLength(0);
    expect(
      (await dpRefunds(sale.intentId)).reduce(
        (sum, row) => sum + Number(row.amount_idr),
        0,
      ),
    ).toBe(30_000);
    expect((await application(sale.orderId)).refundedPaid).toBe(0);
  });
});

describe("legend-77r0 Q81 source provenance and economic refund totals", () => {
  it("Q81-SOURCE-01: an ambiguous second DP payer refuses the whole return without paying tender or either payer", async () => {
    const sale = await depositSale();
    const other = await depositSale();
    await asOwnerTenant(async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(
        "UPDATE reservation_deposit_allocations SET table_session_id=$1 WHERE payment_intent_id=$2",
        [sale.sessionId, other.intentId],
      );
    });
    const r = await returnItem(sale, sale.itemA);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(await refundRows(sale.orderId)).toHaveLength(0);
    expect(await dpRefunds(sale.intentId)).toHaveLength(0);
    expect(await dpRefunds(other.intentId)).toHaveLength(0);
  });
  it("Q81-SOURCE-02: a reversed original DP receipt cannot fund any part of a goods return", async () => {
    const sale = await depositSale();
    await reverseJournal(
      tenantScope(),
      sale.receiptJournalId,
      {
        entryDate: new Date().toISOString().slice(0, 10),
        reason: "Koreksi penerimaan DP",
        idempotencyKey: randomUUID(),
      },
      userIdSchema.parse(supervisor.userId),
    );
    const r = await returnItem(sale, sale.itemA);
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(await refundRows(sale.orderId)).toHaveLength(0);
    expect(await dpRefunds(sale.intentId)).toHaveLength(0);
  });
  it("Q81-ECON-01: economic sales and anomaly totals include DP25k plus tender15k exactly once", async () => {
    const sale = await depositSale();
    const before = await withTenant(db, tenantScope(), (tx) =>
      kindTotals(
        tx,
        tenantScope(),
        tenant.outletId,
        new Date(0),
        new Date("2100-01-01"),
      ),
    );
    const r = await returnItem(sale, sale.itemA);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const after = await withTenant(db, tenantScope(), (tx) =>
      kindTotals(
        tx,
        tenantScope(),
        tenant.outletId,
        new Date(0),
        new Date("2100-01-01"),
      ),
    );
    expect.soft(after.refund - before.refund).toBe(40000);
    const rows = await withTenant(db, tenantScope(), (tx) =>
      tx.execute(
        sql`SELECT coalesce(r.amount,0)::text AS amount FROM orders o ${REFUNDS_JOIN} WHERE o.tenant_id=${tenant.tenantId}::uuid AND o.id=${ulidToUuid(sale.orderId as never)}::uuid`,
      ),
    );
    expect(Number(rows.rows[0]?.amount)).toBe(40000);
  });
});

describe("legend-77r0 Q81 source DP fact time", () => {
  it("Q81-CLOCK-01: native return, release ledger and event share a fact later than original payer's committed facts", async () => {
    const sale = await depositSale();
    const future = new Date(Date.now() + 60000);
    const later = await promoSale();
    await asOwnerTenant(async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(
        "UPDATE orders SET table_session_id=$1 WHERE tenant_id=$2 AND id=$3",
        [sale.sessionId, tenant.tenantId, ulidToUuid(later.orderId as never)],
      );
      await c.query(
        "UPDATE pos_orders SET completed_at=$1 WHERE tenant_id=$2 AND order_id=$3",
        [future, tenant.tenantId, ulidToUuid(later.orderId as never)],
      );
    });
    const body = await refundBody(sale.orderId, {
      amountIdr: 40000,
      items: [{ itemId: sale.itemA, quantity: 1 }],
      idempotencyKey: randomUUID(),
    });
    await refundPosOrder(
      tenantScope(),
      {
        userId: userIdSchema.parse(cashier.userId),
        deviceId: ids.device,
        expectedVersion: null,
      },
      outletIdSchema.parse(tenant.outletId),
      sale.orderId,
      body as Parameters<typeof refundPosOrder>[4],
      new Date(),
    );
    const { rows } = await asOwnerTenant((c) =>
      c.query(
        `SELECT n.refunded_at> $3::timestamptz AS native_after, p.released_at=n.refunded_at AS same_ledger, (e.event->'payload'->>'refundedAt')::timestamptz=n.refunded_at AS same_event
    FROM pos_order_refunds n JOIN pos_deposit_refunds p ON p.tenant_id=n.tenant_id AND p.pos_refund_id=n.id
    JOIN domain_event_outbox e ON e.tenant_id=n.tenant_id AND e.event->>'name'='order.refunded' AND e.event->'payload'->>'refundId'=n.id::text
    WHERE n.tenant_id=$1 AND n.order_id=$2`,
        [tenant.tenantId, ulidToUuid(sale.orderId as never), future],
      ),
    );
    expect(rows).toEqual([
      { native_after: true, same_ledger: true, same_event: true },
    ]);
  });
});

describe("legend-77r0 Q81 original payment method", () => {
  it("Q81-METHOD-01: original bank transfer DP remains on its payer intent and event method", async () => {
    const sale = await depositSale(50000, 80000, 1, "bank_transfer");
    const r = await returnItem(sale, sale.itemA);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await dpRefunds(sale.intentId)).toMatchObject([
      {
        payment_intent_id: sale.intentId,
        amount_idr: "25000",
        status: "pending",
      },
    ]);
    const e = await asOwnerTenant((c) =>
      c.query(
        "SELECT event->'payload'->'depositLines' AS lines FROM domain_event_outbox WHERE tenant_id=$1 AND event->>'name'='order.refunded' AND event->'payload'->>'orderId'=$2",
        [tenant.tenantId, sale.orderId],
      ),
    );
    expect(e.rows[0]?.lines).toEqual([
      { method: "bank_transfer", amountIdr: 25000 },
    ]);
  });
});
