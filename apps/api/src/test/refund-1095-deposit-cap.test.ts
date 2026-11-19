// legend-1095 card A (legend-5g9sn), deposit (DP) share: the cashier refund counts the apology
// voucher of a LINE even when the bill was paid by a deposit (DP) from a real reservation
// (QRIS deposit source: payment intent + evidence + reservation allocation, so the refund
// goes through the real deposit-refund path and writes pos_deposit_refunds rows).
// Voucher + cashier returns of a line never exceed what that line was worth.
//
// Fixture: copied from pos-deposit-return-q81-db.test.ts (`depositSale`), never from the
// implementation. Two identical lines A and B (quantity 2, no service or tax), so by
// symmetry line A is worth half of the bill. The core cases have NO promotion application, so
// they hit the non-promo voucher cap; one extra case adds a Rp20.000 promo (promo branch).
// A fully-DP bill has
// its tender row removed (the Q81 file always keeps a tender).
//
// Assumptions (also reported):
// - The apology voucher of line A is seeded directly (order issue on line A with resolution
//   'voucher', a `vouchers` row, an `apology_vouchers` row bound to the issue): the POS
//   tenant here has no kitchen-recovery staff. 60% of the line value (24.000 of 40.000).
// - The first single-unit refund must create a deposit refund (pos_deposit_refunds row),
//   so the case cannot pass vacuously. The second unit may be cut to nothing (refused).
// - Only line A is refunded, so everything returned belongs to line A.
//
// Run: LEGEND_TEST_FILES="src/test/refund-1095-deposit-cap.test.ts" heavy pnpm test
import { createHash, randomUUID } from "node:crypto";
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
    /** No promotion at all: the bill has no promotion application (non-promo refund branch). */
    noPromo?: boolean;
  } = {},
): Promise<PromoSale & { paidIdr: number }> {
  const { promotionId, code } = opts.noPromo
    ? { promotionId: "", code: "" }
    : await seedPromotion(opts);
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
  if (!opts.noPromo) {
    const discounted = await pos().promo(orderId, code);
    expect(discounted.status, JSON.stringify(discounted.body)).toBeLessThan(
      300,
    );
  }
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
  withPromo = true,
) {
  const unitPrice = (withPromo ? totalIdr + 20_000 : totalIdr) / (2 * quantity);
  if (totalIdr !== 80_000 || quantity !== 1 || !withPromo)
    await asOwnerTenant((client) =>
      client.query(
        "UPDATE price_list_items SET price_idr=$3 WHERE tenant_id=$1 AND price_list_id=$2",
        [tenant.tenantId, ids.priceList, unitPrice],
      ),
    );
  const sale = await promoSale({
    expectedTotalIdr: totalIdr,
    quantity,
    noPromo: !withPromo,
  });
  if (totalIdr !== 80_000 || quantity !== 1 || !withPromo)
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
    if (sale.paidIdr - depositIdr > 0)
      await client.query(
        `UPDATE pos_order_tenders SET amount_idr=$3, received_idr=$3
        WHERE tenant_id=$1 AND order_id=$2`,
        [
          tenant.tenantId,
          ulidToUuid(sale.orderId as never),
          sale.paidIdr - depositIdr,
        ],
      );
    else
      await client.query(
        "DELETE FROM pos_order_tenders WHERE tenant_id=$1 AND order_id=$2",
        [tenant.tenantId, ulidToUuid(sale.orderId as never)],
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

// ---- the 1095 cases -------------------------------------------------------------------

const BILL = 80_000;
/** Line A of two identical lines: half of the bill. */
const LINE_A = BILL / 2;
/** 60% of line A, as 60 of 100. */
const VOUCHER_ON_A = 24_000;

/** Apology voucher on line A, issued for the order (order issue + voucher + apology row). */
async function voucherOnLine(
  orderId: string,
  itemId: string,
  valueIdr: number,
) {
  const issueId = randomUUID();
  const voucherId = randomUUID();
  await asOwnerTenant(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO vouchers (id, tenant_id, promotion_id, customer_profile_id, code_hash, source,
                             value_idr, valid_from, valid_until)
       VALUES ($1, $2, NULL, NULL, $3, 'manual', $4, now() - interval '1 hour', NULL)`,
      [voucherId, tenant.tenantId, sha(voucherId), valueIdr],
    );
    await client.query(
      `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
         reason_note, reported_by, resolution, approved_by, cost_idr, status,
         idempotency_key, resolved_at, voucher_id)
       VALUES ($1, $2, $3, $4, $5, 'unfulfillable', 'out_of_stock',
         'Item habis, voucher maaf diberikan', $6, 'voucher', $6, 0, 'resolved',
         $7, now(), $8)`,
      [
        issueId,
        tenant.tenantId,
        tenant.outletId,
        ulidToUuid(orderId as never),
        ulidToUuid(itemId as never),
        cashier.userId,
        randomUUID(),
        voucherId,
      ],
    );
    await client.query(
      `INSERT INTO apology_vouchers (tenant_id, outlet_id, voucher_id, order_issue_id, reason,
                                     code_sealed, issued_by)
       VALUES ($1, $2, $3, $4, 'Maaf atas keterlambatan', 'sealed-test', $5)`,
      [tenant.tenantId, tenant.outletId, voucherId, issueId, cashier.userId],
    );
  });
}

async function depositRefundCount(orderId: string) {
  const { rows } = await asOwnerTenant((client) =>
    client.query(
      `SELECT count(*)::int AS n FROM pos_deposit_refunds d
         JOIN pos_order_refunds r ON r.tenant_id = d.tenant_id AND r.id = d.pos_refund_id
        WHERE r.tenant_id = $1 AND r.order_id = $2`,
      [tenant.tenantId, ulidToUuid(orderId as never)],
    ),
  );
  return rows[0]!.n as number;
}

/**
 * Everything the cashier refunds paid back to the guest: the tender payout
 * (pos_order_refunds.amount_idr) PLUS the deposit share returned to the DP payer
 * (pos_deposit_refunds.amount_idr). A fully-DP bill has a tender payout of 0.
 */
async function cashierRefundsOf(orderId: string) {
  const tender = (await refundRows(orderId)).reduce(
    (sum, row) => sum + row.amount,
    0,
  );
  const { rows } = await asOwnerTenant((client) =>
    client.query(
      `SELECT COALESCE(sum(d.amount_idr), 0)::bigint AS n FROM pos_deposit_refunds d
         JOIN pos_order_refunds r ON r.tenant_id = d.tenant_id AND r.id = d.pos_refund_id
        WHERE r.tenant_id = $1 AND r.order_id = $2`,
      [tenant.tenantId, ulidToUuid(orderId as never)],
    ),
  );
  return tender + Number(rows[0]!.n);
}

/** Refunds the two units of line A one at a time; the first must create a deposit refund. */
async function refundUnitsOfA(sale: Awaited<ReturnType<typeof depositSale>>) {
  const first = await pos().refund(
    sale.orderId,
    await refundBody(sale.orderId, {
      amountIdr: LINE_A / 2,
      items: [{ itemId: sale.itemA, quantity: 1 }],
    }),
  );
  expect(first.status, JSON.stringify(first.body)).toBe(201);
  expect(
    await depositRefundCount(sale.orderId),
    "the first refund really reached the deposit refund path",
  ).toBeGreaterThan(0);
  // The second unit may be cut or refused; only the money matters.
  await pos().refund(
    sale.orderId,
    await refundBody(sale.orderId, {
      amountIdr: LINE_A / 2,
      items: [{ itemId: sale.itemA, quantity: 1 }],
    }),
  );
}

/** The bill has no promotion application: the refund takes the non-promo (voucher cap) branch. */
async function expectNoPromoApplication(orderId: string) {
  expect(
    (await application(orderId)).status,
    "no promotion application on the bill",
  ).toBeUndefined();
}

describe("legend-5g9sn voucher + cashier returns of a line stay within the line value when a DP paid the bill (no promo)", () => {
  it("bill fully paid by DP, apology voucher 60% on line A, two single-unit refunds: voucher + refunds <= line A", async () => {
    const sale = await depositSale(BILL, BILL, 2, "qris", false);
    await expectNoPromoApplication(sale.orderId);
    await voucherOnLine(sale.orderId, sale.itemA, VOUCHER_ON_A);

    await refundUnitsOfA(sale);

    expect(
      VOUCHER_ON_A + (await cashierRefundsOf(sale.orderId)),
      "voucher + cashier returns of line A",
    ).toBeLessThanOrEqual(LINE_A);
  });

  it("DP 60% + cash 40%, apology voucher 60% on line A, units refunded one at a time: line A returns <= its value", async () => {
    const sale = await depositSale(BILL * 0.6, BILL, 2, "qris", false);
    await expectNoPromoApplication(sale.orderId);
    await voucherOnLine(sale.orderId, sale.itemA, VOUCHER_ON_A);

    // Extra, not a core test: the promo branch may refuse (REFUND_NOTHING_DUE) or pay;
    // either is safe. Only the money out is asserted.
    for (let unit = 0; unit < 2; unit++) {
      const res = await pos().refund(
        sale.orderId,
        await refundBody(sale.orderId, {
          amountIdr: LINE_A / 2,
          items: [{ itemId: sale.itemA, quantity: 1 }],
        }),
      );
      expect([201, 422], JSON.stringify(res.body)).toContain(res.status);
    }

    expect(
      VOUCHER_ON_A + (await cashierRefundsOf(sale.orderId)),
      "voucher + cashier returns of line A",
    ).toBeLessThanOrEqual(LINE_A);
  });
});

// Extra, NOT the core cases: the same bill WITH a Rp20.000 promo takes the promo refund
// branch (promoApplication set), which has its own due amount. Kept to see that branch too.
describe("legend-5g9sn extra: the same DP cases with a promo on the bill", () => {
  it("promo bill fully paid by DP with a voucher on line A: voucher + refunds <= line A", async () => {
    const sale = await depositSale(BILL, BILL, 2);
    await voucherOnLine(sale.orderId, sale.itemA, VOUCHER_ON_A);

    // Extra, not a core test: the promo branch may refuse (REFUND_NOTHING_DUE) or pay;
    // either is safe. Only the money out is asserted.
    for (let unit = 0; unit < 2; unit++) {
      const res = await pos().refund(
        sale.orderId,
        await refundBody(sale.orderId, {
          amountIdr: LINE_A / 2,
          items: [{ itemId: sale.itemA, quantity: 1 }],
        }),
      );
      expect([201, 422], JSON.stringify(res.body)).toContain(res.status);
    }

    expect(
      VOUCHER_ON_A + (await cashierRefundsOf(sale.orderId)),
      "voucher + cashier returns of line A",
    ).toBeLessThanOrEqual(LINE_A);
  });
});
