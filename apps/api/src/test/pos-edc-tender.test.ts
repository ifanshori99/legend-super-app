// POS EDC tender wiring (bead legend-dahk; EDC-01..EDC-03). Before this bead
// `setPosEdcTenderPort` was only called by tests, so a tender with method
// edc_card answered 503 "Pembayaran EDC belum tersedia" in the running app.
// The app built by `createApp()` (the composition root) now settles an EDC
// tender against an approved ecr sale of the EDC ledger that belongs to the
// order, and refuses everything else. No test here installs an EDC port.

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
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const KOPI_IDR = 25_000;

const PIN = "582914";

const ids = {
  supervisorRole: randomUUID(),
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
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

// ---- Fixtures ---------------------------------------------------------------------

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
  // The till: cash goes into the drawer of the shift open on this device.
  const deviceToken = () =>
    signDeviceToken({
      version: 1,
      issuedAt: Math.floor(Date.now() / 1000),
      tenantId: tenant.tenantId,
      brandId: null,
      deviceId: ids.device,
    });
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
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
    tender: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/tenders`, body),
    discount: (orderId: string) =>
      send(`/${orderId}/discounts`, {
        source: "manual",
        kind: "percent",
        percentBp: 100,
        reason: "manager_goodwill",
        reasonNote: "Diskon kecil pelanggan tetap",
      }),
    // Total-changing paths other than the 1% manual discount above.
    promo: (orderId: string, promoCode: string) =>
      send(`/${orderId}/discounts`, {
        source: "promo",
        kind: "amount",
        promoCode,
        reason: "promo_engine",
      }),
    voucher: (orderId: string, voucherCode: string) =>
      send(`/${orderId}/discounts`, {
        source: "voucher",
        kind: "amount",
        voucherCode,
        reason: "promo_engine",
      }),
    voidItem: (
      orderId: string,
      itemId: string,
      body: Record<string, unknown>,
    ) => send(`/${orderId}/items/${itemId}/void`, body),
    removeDiscount: (orderId: string, discountId: string) =>
      who.client
        .delete(`${base}/${orderId}/discounts/${discountId}`)
        .set(headers)
        .set(originHeader)
        .set(DEVICE_TOKEN_HEADER, deviceToken())
        .send({ idempotencyKey: randomUUID() }),
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

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`edc-${randomUUID().slice(0, 6)}`);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(async ({ tenantId, deviceId }) =>
    tenantId === tenant.tenantId && deviceId === ids.device
      ? tenant.outletId
      : null,
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: ids.device,
  });
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "EDC Kasir Uji",
      [
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "pos.discount.apply",
        "pos.void.request",
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "EDC Supervisor Uji",
      ["order.view", "pos.void.approve", "pos.discount.approve"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "POS Kasir");
  supervisor = await member(ids.supervisorRole, "POS Supervisor");
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
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    // Keep the 1% lock probe below the approval threshold; otherwise a
    // supervisor approval failure would hide whether the ECR bill is locked.
    await client.query(
      `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
       VALUES ($1, NULL, 1000)`,
      [tenant.tenantId],
    );
  });
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- EDC ledger fixtures -------------------------------------------------------

let terminalId: string;

async function newOrder(body: Record<string, unknown> = {}): Promise<{
  orderId: string;
  number: string;
  totalIdr: number;
  status: string;
  itemIds: string[];
}> {
  const created = await pos().create(body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  let status = created.body.data.status as string;
  const orderId = created.body.data.id as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  return {
    orderId,
    number: created.body.data.number as string,
    totalIdr: created.body.data.totalIdr as number,
    status,
    itemIds: (created.body.data.items as { id: string }[]).map(
      (item) => item.id,
    ),
  };
}

async function ledgerSale(input: {
  reference: string;
  amountIdr: number;
  status?: string;
  method?: string;
  mode?: string;
  outletId?: string;
  rrn?: string | null;
  approvalCode?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const status = input.status ?? "approved";
  const final = ["approved", "declined", "cancelled", "failed"].includes(
    status,
  );
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, completed_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, $8, $9, 'sale', $10, $11,
               $14, $12, $13)`,
      [
        id,
        tenant.tenantId,
        input.outletId ?? tenant.outletId,
        terminalId,
        input.reference,
        randomUUID(),
        input.amountIdr,
        input.method ?? "card",
        status,
        input.mode ?? "ecr",
        randomUUID().slice(0, 12),
        input.rrn === undefined
          ? "RRN" + randomUUID().replace(/-/g, "").slice(0, 9)
          : input.rrn,
        final ? new Date() : null,
        input.approvalCode === undefined ? "APP123" : input.approvalCode,
      ],
    ),
  );
  return id;
}

function payEdc(
  orderId: string,
  expectedStatus: string,
  body: Record<string, unknown>,
) {
  return pos().tender(orderId, {
    method: "edc_card",
    expectedStatus,
    ...body,
  });
}

describe("POS EDC tender wiring (legend-dahk)", () => {
  beforeAll(async () => {
    terminalId = randomUUID();
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO payment_edc_terminals
           (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
            connection, ip_address, supported_methods, status)
         VALUES ($1, $2, $3, 'bca', 'TID-DAHK', 'MID-DAHK', 'Test EDC', 'lan',
                 '10.0.0.9', ARRAY['card','qris'], 'active')`,
        [terminalId, tenant.tenantId, tenant.outletId],
      ),
    );
  });

  it("EDC-01 an approved ledger sale of this order settles the tender (no longer 503)", async () => {
    const order = await newOrder();
    const edcTransactionId = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
    });
    const input = { edcTransactionId, idempotencyKey: randomUUID() };
    const paid = await payEdc(order.orderId, order.status, input);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data.remainingIdr).toBe(0);
    const replay = await payEdc(order.orderId, order.status, input);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data.remainingIdr).toBe(0);
    const { rows } = await owner.query<{
      status: string;
      provider: string;
      amount_idr: string;
    }>(
      `SELECT status, provider, amount_idr::text AS amount_idr
       FROM pos_order_tenders WHERE edc_transaction_id = $1`,
      [edcTransactionId],
    );
    expect(rows).toEqual([
      {
        status: "captured",
        provider: "edc",
        amount_idr: String(order.totalIdr),
      },
    ]);
    const after = await pos().get(order.orderId);
    expect(after.status).toBe(200);
    expect(after.body.data.totalIdr).toBe(order.totalIdr);
  });

  it("a card-number-like rrn or approval code is never copied to the tender reference", async () => {
    const cases = [
      { rrn: "A4111111111111111", approvalCode: "APP123", want: "APP123" },
      { rrn: "4111111111111111X", approvalCode: null },
    ];
    for (const c of cases) {
      const order = await newOrder();
      const edcTransactionId = await ledgerSale({
        reference: order.number,
        amountIdr: order.totalIdr,
        rrn: c.rrn,
        approvalCode: c.approvalCode,
      });
      const paid = await payEdc(order.orderId, order.status, {
        edcTransactionId,
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      const { rows } = await owner.query<{ reference: string | null }>(
        `SELECT reference FROM pos_order_tenders WHERE edc_transaction_id = $1`,
        [edcTransactionId],
      );
      expect(rows[0]?.reference, c.rrn).toBe(c.want ?? order.number);
    }
  });

  it.each(["declined", "cancelled", "failed", "unknown", "pending"])(
    "EDC-02 a %s EDC sale leaves the bill unchanged and records no settled tender",
    async (status) => {
      const order = await newOrder();
      const edcTransactionId = await ledgerSale({
        reference: order.number,
        amountIdr: order.totalIdr,
        status,
      });
      const refused = await payEdc(order.orderId, order.status, {
        edcTransactionId,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      const after = await pos().get(order.orderId);
      expect(after.status, JSON.stringify(after.body)).toBe(200);
      expect(after.body.data).toMatchObject({
        status: order.status,
        totalIdr: order.totalIdr,
        tenders: [],
      });
      const { rows } = await owner.query(
        `SELECT 1 FROM pos_order_tenders WHERE order_id = $1`,
        [ulidToUuid(order.orderId)],
      );
      expect(rows).toHaveLength(0);
    },
  );

  it.each([-1_000, 1_000])(
    "EDC-01 an EDC approval differing from the bill by %i rupiah cannot settle or change it",
    async (difference) => {
      const order = await newOrder();
      const edcTransactionId = await ledgerSale({
        reference: order.number,
        amountIdr: order.totalIdr + difference,
      });
      const refused = await payEdc(order.orderId, order.status, {
        edcTransactionId,
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      const after = await pos().get(order.orderId);
      expect(after.status).toBe(200);
      expect(after.body.data).toMatchObject({
        totalIdr: order.totalIdr,
        tenders: [],
      });
    },
  );

  it("the same cashier can apply the lock-probe discount when no ECR request exists", async () => {
    const order = await newOrder();
    expect(order.totalIdr).toBe(55_000);
    const discounted = await pos().discount(order.orderId);
    expect(discounted.status, JSON.stringify(discounted.body)).toBe(201);
    const after = await pos().get(order.orderId);
    expect(after.status).toBe(200);
    expect(after.body.data.totalIdr).toBe(54_450);
    expect(after.body.data.discounts).toHaveLength(1);
    expect(after.body.data.discounts[0].amountIdr).toBe(500);
    expect(after.body.data.tenders).toEqual([]);
  });

  for (const status of ["pending", "unknown"]) {
    // The control above shows the same discount is accepted with no ECR
    // request; once a pending/unknown request has been sent, the bill is locked.
    it(`EDC-01 a ${status} ECR request already sent locks the POS bill against discounts`, async () => {
      const order = await newOrder();
      const edcTransactionId = await ledgerSale({
        reference: order.number,
        amountIdr: order.totalIdr,
        status,
      });
      await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `UPDATE edc_transactions SET dispatched_at = now() WHERE id = $1`,
          [edcTransactionId],
        ),
      );

      const discounted = await pos().discount(order.orderId);
      const after = await pos().get(order.orderId);
      expect(after.status).toBe(200);
      expect(after.body.data).toMatchObject({
        totalIdr: order.totalIdr,
        discounts: [],
        tenders: [],
      });
      const { rows } = await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `SELECT amount_idr::text AS amount_idr, status
           FROM edc_transactions WHERE id = $1`,
          [edcTransactionId],
        ),
      );
      expect(rows).toEqual([{ amount_idr: String(order.totalIdr), status }]);
      expect(discounted.status, JSON.stringify(discounted.body)).toBe(409);
    });
  }

  it("EDC-02 a missing, unapproved, standalone or mismatched ledger sale is refused", async () => {
    // One order per approved row: the ledger allows one approved sale per
    // reference, and every case must leave its order unpaid.
    const refused = async (
      expected: number,
      make?: (order: Awaited<ReturnType<typeof newOrder>>) => Promise<string>,
    ) => {
      const order = await newOrder();
      const edcTransactionId = make ? await make(order) : undefined;
      const res = await payEdc(order.orderId, order.status, {
        ...(edcTransactionId ? { edcTransactionId } : {}),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(expected);
      const { rows } = await owner.query(
        `SELECT 1 FROM pos_order_tenders WHERE order_id = $1`,
        [ulidToUuid(order.orderId)],
      );
      expect(rows).toHaveLength(0);
    };
    await refused(400);
    await refused(404, async () => randomUUID());
    await refused(409, (o) =>
      ledgerSale({
        reference: o.number,
        amountIdr: o.totalIdr,
        status: "pending",
      }),
    );
    await refused(409, (o) =>
      ledgerSale({
        reference: o.number,
        amountIdr: o.totalIdr,
        mode: "standalone",
      }),
    );
    await refused(409, (o) =>
      ledgerSale({ reference: o.number, amountIdr: o.totalIdr - 1_000 }),
    );
    await refused(409, (o) =>
      ledgerSale({
        reference: o.number,
        amountIdr: o.totalIdr,
        method: "qris",
      }),
    );
  });

  it("EDC-03 an approval cannot be moved to another order", async () => {
    const first = await newOrder();
    const second = await newOrder();
    const edcTransactionId = await ledgerSale({
      reference: first.number,
      amountIdr: first.totalIdr,
    });
    const moved = await payEdc(second.orderId, second.status, {
      edcTransactionId,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(409);
    const paid = await payEdc(first.orderId, first.status, {
      edcTransactionId,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  });
});

// ---- EDC-01: the bill is locked while an ECR request is not final ------------------
//
// PRD EDC-01: the amount the EDC processes always equals the POS bill and the
// cashier cannot change it after the request was sent. Decision (CTO): while an
// ECR sale of the order is dispatched/pending/unknown, EVERY path that changes
// the total is refused with 409 and a clear EDC code; the bill opens again once
// the request is final (declined/cancelled/failed, as an inquiry leaves it).
//
// Assumptions: (1) "dispatched" is a pending/unknown ledger row with
// dispatched_at set; a pending row without dispatched_at is also treated as
// locked ("when in doubt, refuse"). (2) The POS API has no add/edit-item, split
// or per-order service-charge route; the real total-changing paths are item
// void, manual/promo/voucher discount and discount removal, which are covered.
// (3) The error code is not fixed by the contract, so the test asserts 409 and
// that the code or message names the EDC request.

type Order = Awaited<ReturnType<typeof newOrder>>;
type Res = Awaited<ReturnType<ReturnType<typeof pos>["discount"]>>;
type Attempt = () => Promise<Res>;

const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const newCode = () =>
  `T${randomUUID().replaceAll("-", "").slice(0, 11).toUpperCase()}`;

/** A supervisor PIN approval for one action on one object (fresh each call). */
async function pinApproval(
  action: "void" | "discount",
  objectType: "order" | "order_item",
  objectId: string,
): Promise<{ approvedBy: string; overrideId: string }> {
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
      valueIdr: 1_000_000,
      reason: "Pelanggan salah pesan",
      objectType,
      objectId,
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

async function seedPromoCode(): Promise<string> {
  const code = newCode();
  const id = randomUUID();
  await asOwnerTenant(tenant.tenantId, (client) =>
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
        `EDC lock promo ${id.slice(0, 8)}`,
        sha256(code),
        JSON.stringify([
          { kind: "item_quantity", menuItemIds: [ids.kopi], minQuantity: 1 },
        ]),
        JSON.stringify({ kind: "nominal_off", amountIdr: 5_000 }),
        `g${id.slice(0, 8)}`,
      ],
    ),
  );
  return code;
}

async function seedVoucherCode(): Promise<string> {
  const code = `V${randomUUID().replaceAll("-", "").slice(0, 11).toUpperCase()}`;
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO vouchers (id, tenant_id, promotion_id, customer_profile_id, code_hash, source,
                             value_idr, valid_from, valid_until)
       VALUES ($1, $2, NULL, NULL, $3, 'manual', 5000, now() - interval '1 hour', NULL)`,
      [randomUUID(), tenant.tenantId, sha256(code)],
    ),
  );
  return code;
}

/** Every route that changes an unpaid POS bill's total. */
const totalChangingPaths: {
  name: string;
  /** Prepares the order (may already change its total) and returns the attempt. */
  prepare: (order: Order) => Promise<Attempt>;
}[] = [
  {
    name: "manual discount",
    prepare: async (order) => () => pos().discount(order.orderId),
  },
  {
    name: "promo discount",
    prepare: async (order) => {
      const code = await seedPromoCode();
      return () => pos().promo(order.orderId, code);
    },
  },
  {
    name: "voucher discount",
    prepare: async (order) => {
      const code = await seedVoucherCode();
      return () => pos().voucher(order.orderId, code);
    },
  },
  {
    name: "item void",
    prepare: async (order) => async () => {
      const itemId = order.itemIds[0] as string;
      return pos().voidItem(order.orderId, itemId, {
        reason: "wrong_order",
        reasonNote: "Salah pesan item",
        ...(await pinApproval("void", "order_item", itemId)),
      });
    },
  },
  {
    name: "discount removal",
    prepare: async (order) => {
      const applied = await pos().discount(order.orderId);
      expect(applied.status, JSON.stringify(applied.body)).toBe(201);
      const discountId = applied.body.data.discounts[0].id as string;
      return () => pos().removeDiscount(order.orderId, discountId);
    },
  },
];

/** A fresh two-line bill (so an item void leaves a bill), submitted if needed. */
function twoLineOrder() {
  return newOrder({
    items: [
      { menuItemId: ids.kopi, quantity: 1, modifierIds: [] },
      { menuItemId: ids.kopi, quantity: 1, modifierIds: [] },
    ],
  });
}

/** The ECR request for the order's CURRENT bill, in the given state. */
async function ecrRequest(
  order: Order,
  state: {
    status: string;
    dispatched: boolean;
    dispatchedMinutesAgo?: number;
  },
): Promise<{ edcTransactionId: string; amountIdr: number }> {
  const current = await pos().get(order.orderId);
  expect(current.status).toBe(200);
  const amountIdr = current.body.data.totalIdr as number;
  const edcTransactionId = await ledgerSale({
    reference: order.number,
    amountIdr,
    status: state.status,
  });
  if (state.dispatched)
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE edc_transactions
            SET dispatched_at = now() - make_interval(mins => $2::int)
          WHERE id = $1`,
        [edcTransactionId, state.dispatchedMinutesAgo ?? 0],
      ),
    );
  return { edcTransactionId, amountIdr };
}

/** What a final inquiry answer does to the ledger row. */
async function inquiryFinalises(edcTransactionId: string, status: string) {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `UPDATE edc_transactions SET status = $2, completed_at = now() WHERE id = $1`,
      [edcTransactionId, status],
    ),
  );
}

async function billOf(orderId: string) {
  const res = await pos().get(orderId);
  expect(res.status).toBe(200);
  const data = res.body.data;
  return {
    totalIdr: data.totalIdr as number,
    items: data.items,
    discounts: data.discounts,
    tenders: data.tenders,
  };
}

function expectLockRefusal(res: Res) {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(
    `${res.body.error?.code ?? ""} ${res.body.error?.message ?? ""}`,
    JSON.stringify(res.body),
  ).toMatch(/edc/i);
}

describe("EDC-01 the POS bill is locked while an ECR request is not final", () => {
  const OPEN_STATES = [
    { label: "pending and sent", status: "pending", dispatched: true },
    { label: "unknown and sent", status: "unknown", dispatched: true },
    {
      label: "pending, send not yet confirmed",
      status: "pending",
      dispatched: false,
    },
  ];

  describe.each(totalChangingPaths)("$name", (path) => {
    it("control: without an ECR request the change is accepted and moves the total", async () => {
      const order = await twoLineOrder();
      const attempt = await path.prepare(order);
      const before = await billOf(order.orderId);
      const res = await attempt();
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      const after = await billOf(order.orderId);
      expect(after.totalIdr).not.toBe(before.totalIdr);
    });

    it.each(OPEN_STATES)(
      "is refused (409, EDC code) while the request is $label; bill and EDC amount stay equal",
      async (state) => {
        const order = await twoLineOrder();
        const attempt = await path.prepare(order);
        const request = await ecrRequest(order, state);
        const before = await billOf(order.orderId);
        expect(before.totalIdr).toBe(request.amountIdr);

        expectLockRefusal(await attempt());

        // A second try is refused the same way: nothing was half applied.
        expectLockRefusal(await attempt());
        const after = await billOf(order.orderId);
        expect(after).toEqual(before);
        const { rows } = await owner.query<{
          amount_idr: string;
          status: string;
        }>(
          `SELECT amount_idr::text AS amount_idr, status
             FROM edc_transactions WHERE id = $1`,
          [request.edcTransactionId],
        );
        expect(rows).toEqual([
          { amount_idr: String(after.totalIdr), status: state.status },
        ]);
      },
    );

    it.each(["declined", "cancelled", "failed"])(
      "opens again once an inquiry leaves the request %s",
      async (finalStatus) => {
        const order = await twoLineOrder();
        const attempt = await path.prepare(order);
        const request = await ecrRequest(order, {
          status: "unknown",
          dispatched: true,
        });
        const before = await billOf(order.orderId);
        expectLockRefusal(await attempt());

        await inquiryFinalises(request.edcTransactionId, finalStatus);

        const res = await attempt();
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        const after = await billOf(order.orderId);
        expect(after.totalIdr).not.toBe(before.totalIdr);
        // The finished (non-approved) request records no payment.
        expect(after.tenders).toEqual([]);
      },
    );

    it.each(["pending", "unknown"])(
      "a %s request sent two hours ago and never inquired stays locked (timeout does not unlock)",
      async (status) => {
        const order = await twoLineOrder();
        const attempt = await path.prepare(order);
        await ecrRequest(order, {
          status,
          dispatched: true,
          dispatchedMinutesAgo: 120,
        });
        const before = await billOf(order.orderId);
        expectLockRefusal(await attempt());
        expect(await billOf(order.orderId)).toEqual(before);
      },
    );
  });

  it("the lock is per bill: another order's change is still accepted", async () => {
    const locked = await twoLineOrder();
    await ecrRequest(locked, { status: "unknown", dispatched: true });
    const other = await twoLineOrder();
    const res = await pos().discount(other.orderId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expectLockRefusal(await pos().discount(locked.orderId));
  });

  it("an approved EDC sale of the unchanged bill still settles it (the lock never blocks payment)", async () => {
    const order = await twoLineOrder();
    const request = await ecrRequest(order, {
      status: "unknown",
      dispatched: true,
    });
    await inquiryFinalises(request.edcTransactionId, "approved");
    const paid = await payEdc(order.orderId, order.status, {
      edcTransactionId: request.edcTransactionId,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data.remainingIdr).toBe(0);
    expect((await billOf(order.orderId)).totalIdr).toBe(request.amountIdr);
  });
});

// ---- EDC-01 addendum 1: the lock covers unbooked approvals and flagged finals ------
//
// Architect review (money, "jangan sampai rugi"). Assumptions: (1) the error
// code is EDC_REQUEST_OPEN (packages/shared/src/pos/errors.ts, HTTP 409).
// (2) A sale request of the order keeps the bill locked when it is pending or
// unknown, OR needs_reconciliation = true (a late approval stored as a final
// declined/cancelled/failed row), OR it is approved but not yet booked as a live
// (not voided/failed) tender of the order. An approved request that is already
// a tender is paid and locks nothing. (3) Cash/QRIS/standalone tenders are
// refused under the same lock, except an ECR tender that carries the
// edcTransactionId of the request itself (that path settles the request).
// (4) Live tender = status not voided/failed.

function expectEdcOpen(res: Res) {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(res.body.error?.code, JSON.stringify(res.body)).toBe(
    "EDC_REQUEST_OPEN",
  );
}

async function setReconciliation(edcTransactionId: string, value: boolean) {
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `UPDATE edc_transactions SET needs_reconciliation = $2 WHERE id = $1`,
      [edcTransactionId, value],
    ),
  );
}

/** Sum and count of the live tenders (not voided/failed) of one order. */
async function liveTenders(orderId: string) {
  const { rows } = await owner.query<{ sum: string; count: string }>(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS sum, COUNT(*)::text AS count
       FROM pos_order_tenders
      WHERE order_id = $1 AND status NOT IN ('voided', 'failed')`,
    [ulidToUuid(orderId)],
  );
  return { sumIdr: Number(rows[0]?.sum), count: Number(rows[0]?.count) };
}

async function edcAmount(edcTransactionId: string) {
  const { rows } = await owner.query<{ amount_idr: string }>(
    `SELECT amount_idr::text AS amount_idr FROM edc_transactions WHERE id = $1`,
    [edcTransactionId],
  );
  return Number(rows[0]?.amount_idr);
}

describe("EDC-01 an approved ECR sale not yet booked as a tender locks the bill", () => {
  describe.each(totalChangingPaths)("$name", (path) => {
    it("is refused 409 EDC_REQUEST_OPEN; paying through payEdc then completes the order with no lock in the way", async () => {
      const order = await twoLineOrder();
      const attempt = await path.prepare(order);
      const request = await ecrRequest(order, {
        status: "approved",
        dispatched: false,
      });
      const before = await billOf(order.orderId);
      expect(before.totalIdr).toBe(request.amountIdr);

      expectEdcOpen(await attempt());
      expectEdcOpen(await attempt());
      expect(await billOf(order.orderId)).toEqual(before);
      expect((await liveTenders(order.orderId)).count).toBe(0);

      // Booking the approval settles exactly the bill, once.
      const paid = await payEdc(order.orderId, order.status, {
        edcTransactionId: request.edcTransactionId,
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.data.remainingIdr).toBe(0);
      expect(await liveTenders(order.orderId)).toEqual({
        sumIdr: request.amountIdr,
        count: 1,
      });
      expect(await edcAmount(request.edcTransactionId)).toBe(before.totalIdr);

      const completed = await pos().complete(
        order.orderId,
        paid.body.data.order.status,
      );
      expect(completed.status, JSON.stringify(completed.body)).toBe(200);
      expect(completed.body.data.status).toBe("completed");
      expect(completed.body.data.totalIdr).toBe(before.totalIdr);
    });
  });
});

describe("EDC-01 a final declined/cancelled/failed row flagged needs_reconciliation keeps the bill locked", () => {
  describe.each(totalChangingPaths)("$name", (path) => {
    it.each(["declined", "cancelled", "failed"])(
      "%s with the flag is refused 409 EDC_REQUEST_OPEN; without the flag (or once reconciled) it is accepted",
      async (finalStatus) => {
        const order = await twoLineOrder();
        const attempt = await path.prepare(order);
        const request = await ecrRequest(order, {
          status: finalStatus,
          dispatched: true,
        });
        await setReconciliation(request.edcTransactionId, true);
        const before = await billOf(order.orderId);
        expect(before.totalIdr).toBe(request.amountIdr);

        expectEdcOpen(await attempt());
        expectEdcOpen(await attempt());
        expect(await billOf(order.orderId)).toEqual(before);
        expect((await liveTenders(order.orderId)).count).toBe(0);
        // The ledger row is untouched by the refusal.
        expect(await edcAmount(request.edcTransactionId)).toBe(before.totalIdr);

        // Reconciled (flag cleared): the final non-approved row no longer locks.
        await setReconciliation(request.edcTransactionId, false);
        const res = await attempt();
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        const after = await billOf(order.orderId);
        expect(after.totalIdr).not.toBe(before.totalIdr);
        expect(after.tenders).toEqual([]);
      },
    );

    it.each(["declined", "cancelled", "failed"])(
      "%s without the flag never locked it",
      async (finalStatus) => {
        const order = await twoLineOrder();
        const attempt = await path.prepare(order);
        const request = await ecrRequest(order, {
          status: finalStatus,
          dispatched: true,
        });
        const before = await billOf(order.orderId);
        const res = await attempt();
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        expect((await billOf(order.orderId)).totalIdr).not.toBe(
          before.totalIdr,
        );
        expect(request.amountIdr).toBe(before.totalIdr);
      },
    );
  });
});

describe("EDC-01 cash and QRIS tenders are refused while an ECR request is open", () => {
  const OPEN_REQUESTS = [
    {
      label: "pending and sent",
      status: "pending",
      dispatched: true,
      flag: false,
    },
    {
      label: "unknown and sent",
      status: "unknown",
      dispatched: true,
      flag: false,
    },
    {
      label: "pending, send not yet confirmed",
      status: "pending",
      dispatched: false,
      flag: false,
    },
    {
      label: "approved but not yet booked as a tender",
      status: "approved",
      dispatched: false,
      flag: false,
    },
    {
      label: "declined with needs_reconciliation",
      status: "declined",
      dispatched: true,
      flag: true,
    },
    {
      label: "cancelled with needs_reconciliation",
      status: "cancelled",
      dispatched: true,
      flag: true,
    },
    {
      label: "failed with needs_reconciliation",
      status: "failed",
      dispatched: true,
      flag: true,
    },
  ];
  const METHODS: {
    name: string;
    send: (order: Order) => Promise<Res>;
  }[] = [
    {
      name: "cash",
      send: (order) =>
        pos().cash(order.orderId, order.status, order.totalIdr + 5_000),
    },
    {
      name: "qris",
      send: (order) =>
        pos().tender(order.orderId, {
          method: "qris",
          expectedStatus: order.status,
        }),
    },
  ];

  describe.each(METHODS)("$name tender", (method) => {
    it.each(OPEN_REQUESTS)(
      "is refused 409 EDC_REQUEST_OPEN while the request is $label; nothing stored, bill unpaid, EDC amount equals the bill",
      async (state) => {
        const order = await newOrder();
        const request = await ecrRequest(order, state);
        if (state.flag) await setReconciliation(request.edcTransactionId, true);
        const before = await billOf(order.orderId);

        expectEdcOpen(await method.send(order));
        expectEdcOpen(await method.send(order));

        expect(await liveTenders(order.orderId)).toEqual({
          sumIdr: 0,
          count: 0,
        });
        const { rows } = await owner.query(
          `SELECT 1 FROM pos_order_tenders WHERE order_id = $1`,
          [ulidToUuid(order.orderId)],
        );
        expect(rows).toHaveLength(0);
        const after = await pos().get(order.orderId);
        expect(after.status).toBe(200);
        expect(after.body.data.status).toBe(order.status);
        expect(await billOf(order.orderId)).toEqual(before);
        expect(await edcAmount(request.edcTransactionId)).toBe(before.totalIdr);
      },
    );

    it("control: with no ECR request, or only an unflagged declined one, it is accepted and applies at most the bill", async () => {
      const clean = await newOrder();
      const accepted = await method.send(clean);
      // QRIS needs a payment gateway the test app may not provide; the cash
      // control proves the guard does not fire without an ECR request.
      if (method.name === "cash") {
        expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
        expect(await liveTenders(clean.orderId)).toEqual({
          sumIdr: clean.totalIdr,
          count: 1,
        });
      } else {
        expect(accepted.body.error?.code).not.toBe("EDC_REQUEST_OPEN");
      }

      const stale = await newOrder();
      await ecrRequest(stale, { status: "declined", dispatched: true });
      const afterDeclined = await method.send(stale);
      expect(afterDeclined.body.error?.code).not.toBe("EDC_REQUEST_OPEN");
      if (method.name === "cash") {
        expect(afterDeclined.status, JSON.stringify(afterDeclined.body)).toBe(
          201,
        );
        expect((await liveTenders(stale.orderId)).sumIdr).toBe(stale.totalIdr);
      }
    });
  });

  it("an approved-not-booked request: cash is refused, the EDC tender with its edcTransactionId is accepted, and the customer pays the bill exactly once", async () => {
    const order = await newOrder();
    const request = await ecrRequest(order, {
      status: "approved",
      dispatched: false,
    });
    expect(request.amountIdr).toBe(order.totalIdr);

    expectEdcOpen(
      await pos().cash(order.orderId, order.status, order.totalIdr + 5_000),
    );
    expect((await liveTenders(order.orderId)).count).toBe(0);

    const paid = await payEdc(order.orderId, order.status, {
      edcTransactionId: request.edcTransactionId,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data.remainingIdr).toBe(0);
    expect(await liveTenders(order.orderId)).toEqual({
      sumIdr: order.totalIdr,
      count: 1,
    });
    expect(await edcAmount(request.edcTransactionId)).toBe(order.totalIdr);

    // Already paid by EDC: a late cash tender must not charge the customer again.
    const again = await pos().cash(
      order.orderId,
      paid.body.data.order.status,
      order.totalIdr + 5_000,
    );
    expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect((await liveTenders(order.orderId)).sumIdr).toBe(order.totalIdr);
  });

  it("once the approval is booked as a tender the order is paid and no EDC lock remains (completion works)", async () => {
    const order = await newOrder();
    const request = await ecrRequest(order, {
      status: "approved",
      dispatched: true,
    });
    const paid = await payEdc(order.orderId, order.status, {
      edcTransactionId: request.edcTransactionId,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const completed = await pos().complete(
      order.orderId,
      paid.body.data.order.status,
    );
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.data.status).toBe("completed");
  });

  it("the lock is per order: another order still takes cash while this one has an open request", async () => {
    const locked = await newOrder();
    await ecrRequest(locked, { status: "pending", dispatched: true });
    const other = await newOrder();
    const res = await pos().cash(
      other.orderId,
      other.status,
      other.totalIdr + 5_000,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expectEdcOpen(
      await pos().cash(locked.orderId, locked.status, locked.totalIdr + 5_000),
    );
  });
});
