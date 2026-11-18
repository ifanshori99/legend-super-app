// POS 936 part C: a declined EDC payment (legend-hpgyw). Fail-first tests.
//
// Rules (brief 1039, founder: never lose money):
// - A declined EDC attempt changes nothing on the bill: no tender, same total,
//   same remaining, and the order can be paid again (another method, or a new
//   EDC attempt).
// - The order detail (GET /api/outlets/:outletId/pos/orders/:orderId) carries
//   `edcAttempts` (coordinator decision): newest first, at most 5, each
//   { id, status, amountIdr, terminalId, terminalLabel, declineReason,
//     responseCode, createdAt, completedAt }. `declineReason` is the ledger
//   message of a declined sale (null otherwise); `responseCode` the bank code.
//
// Assumptions: (1) `id` of an attempt is the EDC ledger transaction id and
// `status` is the ledger status verbatim ("declined", "approved", ...).
// (2) `terminalLabel` is a string or null; only its presence is asserted.
// (3) Only attempts of THIS order (ledger reference = order number) in THIS
// tenant and outlet are listed. (4) A tender that cites a declined sale is
// refused with 409 (existing EDC-02 behavior), also on replay.
// The refusal and "pay again" tests guard existing behavior; the `edcAttempts`
// tests are the missing behavior and fail until it exists.

import { randomUUID } from "node:crypto";
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
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { registerTestDevice } from "./device-seed.ts";
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
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  device: randomUUID(),
  terminal: randomUUID(),
  otherOutlet: randomUUID(),
  otherOutletTerminal: randomUUID(),
  otherTenantTerminal: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let otherTenant: IsolatedTenant;
let headers: { Host: string };
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;

// ---- Receipt numbering double (the production port is wired elsewhere) ---------

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
        number: `POS9-${String(sequenceNumber).padStart(6, "0")}`,
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

function pos(who: Member = cashier) {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
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
    create: () =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
      }),
    get: (orderId: string) =>
      who.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
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
  };
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`edd-${randomUUID().slice(0, 6)}`);
  otherTenant = await createIsolatedTenant(`edo-${randomUUID().slice(0, 6)}`);
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
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, 'EDC Ditolak Kasir', false, NULL, $3, false, '["tenant"]')`,
    [
      ids.cashierRole,
      tenant.tenantId,
      JSON.stringify([
        "order.view",
        "pos.sale.create",
        "pos.payment.accept",
        "shift.cash.operate",
      ]),
    ],
  );
  cashier = await member(ids.cashierRole, "POS Kasir EDC Ditolak");
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
    // PBJT 10% on F&B, menu prices exclude tax: 2 x Rp25.000 is billed Rp55.000.
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
    await client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-DECL', 'MID-DECL', 'Test EDC', 'lan',
               '10.0.0.9', ARRAY['card','qris'], 'active')`,
      [ids.terminal, tenant.tenantId, tenant.outletId],
    );
    // A second outlet of the same tenant, with its own terminal.
    await client.query(
      `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
       VALUES ($1, $2, $3, $4, 'OUT-EDD2', 'Outlet Dua', 'Jl. Uji 2', 'Asia/Jakarta', $5, 'active')`,
      [
        ids.otherOutlet,
        tenant.tenantId,
        tenant.brandId,
        tenant.legalEntityId,
        JSON.stringify(fixtures.outlets[0].openingHours),
      ],
    );
    await client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-DEC2', 'MID-DEC2', 'Test EDC', 'lan',
               '10.0.0.10', ARRAY['card','qris'], 'active')`,
      [ids.otherOutletTerminal, tenant.tenantId, ids.otherOutlet],
    );
  });
  await asOwnerTenant(otherTenant.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-DEC3', 'MID-DEC3', 'Test EDC', 'lan',
               '10.0.0.11', ARRAY['card','qris'], 'active')`,
      [ids.otherTenantTerminal, otherTenant.tenantId, otherTenant.outletId],
    ),
  );
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  for (const t of [tenant, otherTenant])
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      t.tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

// ---- Helpers --------------------------------------------------------------------

async function newOrder(): Promise<{
  orderId: string;
  number: string;
  totalIdr: number;
  status: string;
}> {
  const created = await pos().create();
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
  };
}

type LedgerInput = {
  reference: string;
  amountIdr: number;
  status?: string;
  message?: string | null;
  responseCode?: string | null;
  createdAt?: Date;
  tenantId?: string;
  outletId?: string;
  terminalId?: string;
};

/** One EDC ledger sale; declined by default (the bank said no). */
async function ledgerSale(input: LedgerInput): Promise<string> {
  const id = randomUUID();
  const status = input.status ?? "declined";
  const final = ["approved", "declined", "cancelled", "failed"].includes(
    status,
  );
  const approved = status === "approved";
  const createdAt = input.createdAt ?? new Date();
  await asOwnerTenant(input.tenantId ?? tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, response_code, message, created_at, updated_at, completed_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', 'ecr', $9,
               $10, $11, $12, $13, $14, $14, $15)`,
      [
        id,
        input.tenantId ?? tenant.tenantId,
        input.outletId ?? tenant.outletId,
        input.terminalId ?? ids.terminal,
        input.reference,
        randomUUID(),
        input.amountIdr,
        status,
        randomUUID().slice(0, 12),
        approved ? "APP123" : null,
        approved ? "RRN" + randomUUID().replace(/-/g, "").slice(0, 9) : null,
        input.responseCode === undefined ? null : input.responseCode,
        input.message === undefined ? null : input.message,
        createdAt,
        final ? createdAt : null,
      ],
    ),
  );
  return id;
}

type Attempt = {
  id: string;
  status: string;
  amountIdr: number;
  terminalId: string;
  terminalLabel: string | null;
  declineReason: string | null;
  responseCode: string | null;
  bank: string | null;
  method: string | null;
  mode: string | null;
  createdAt: string;
  completedAt: string | null;
};

async function attemptsOf(orderId: string): Promise<Attempt[]> {
  const res = await pos().get(orderId);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const attempts = res.body.data.edcAttempts as Attempt[] | undefined;
  expect(attempts, "order detail must carry edcAttempts").toBeDefined();
  return attempts as Attempt[];
}

async function tenderRows(orderId: string): Promise<number> {
  const { rows } = await owner.query(
    `SELECT 1 FROM pos_order_tenders WHERE order_id = $1`,
    [ulidToUuid(orderId)],
  );
  return rows.length;
}

const payEdc = (
  orderId: string,
  expectedStatus: string,
  body: Record<string, unknown>,
) => pos().tender(orderId, { method: "edc_card", expectedStatus, ...body });

// ---- Tests ----------------------------------------------------------------------

describe("POS-936-C EDC declined: the bill does not change", () => {
  it("POS-936-C-1 a declined attempt records no tender and leaves total and tenders as they were", async () => {
    const order = await newOrder();
    const edcTransactionId = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Saldo tidak cukup",
      responseCode: "51",
    });
    const refused = await payEdc(order.orderId, order.status, {
      edcTransactionId,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const after = await pos().get(order.orderId);
    expect(after.status).toBe(200);
    expect(after.body.data).toMatchObject({
      status: order.status,
      totalIdr: order.totalIdr,
      tenders: [],
    });
    expect(await tenderRows(order.orderId)).toBe(0);
  });

  it("POS-936-C-2 with part of the bill already paid, the remaining stays exactly the same after a decline", async () => {
    const order = await newOrder();
    const partial = 20_000;
    const first = await pos().cash(order.orderId, order.status, partial);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const remaining = order.totalIdr - partial;
    expect(first.body.data.remainingIdr).toBe(remaining);
    // The order status (not a payment state) is what expectedStatus guards.
    const status = order.status;
    const edcTransactionId = await ledgerSale({
      reference: order.number,
      amountIdr: remaining,
      message: "Kartu ditolak",
      responseCode: "05",
    });
    const refused = await payEdc(order.orderId, status, { edcTransactionId });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const after = await pos().get(order.orderId);
    expect(after.body.data.totalIdr).toBe(order.totalIdr);
    expect(after.body.data.tenders).toHaveLength(1);
    expect(await tenderRows(order.orderId)).toBe(1);
    // The rest is still collectable, exactly the remaining and no more.
    const rest = await pos().cash(order.orderId, status, remaining);
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.data.remainingIdr).toBe(0);
    expect(await tenderRows(order.orderId)).toBe(2);
  });

  it("POS-936-C-3 after a decline the order can be paid with another method", async () => {
    const order = await newOrder();
    const edcTransactionId = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Saldo tidak cukup",
      responseCode: "51",
    });
    expect(
      (await payEdc(order.orderId, order.status, { edcTransactionId })).status,
    ).toBe(409);
    const cash = await pos().cash(order.orderId, order.status, order.totalIdr);
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect(cash.body.data.remainingIdr).toBe(0);
    expect(await tenderRows(order.orderId)).toBe(1);
  });

  it("POS-936-C-4 after a decline a new approved EDC attempt settles the order once, for the bill amount", async () => {
    const order = await newOrder();
    const declinedId = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Saldo tidak cukup",
      responseCode: "51",
    });
    expect(
      (
        await payEdc(order.orderId, order.status, {
          edcTransactionId: declinedId,
        })
      ).status,
    ).toBe(409);
    const approvedId = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "approved",
      responseCode: "00",
    });
    const paid = await payEdc(order.orderId, order.status, {
      edcTransactionId: approvedId,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data.remainingIdr).toBe(0);
    const { rows } = await owner.query<{
      edc_transaction_id: string;
      amount_idr: string;
    }>(
      `SELECT edc_transaction_id, amount_idr::text AS amount_idr
       FROM pos_order_tenders WHERE order_id = $1`,
      [ulidToUuid(order.orderId)],
    );
    expect(rows).toEqual([
      { edc_transaction_id: approvedId, amount_idr: String(order.totalIdr) },
    ]);
  });

  it("POS-936-C-5 replaying a declined result (same key, twice) never creates a tender", async () => {
    const order = await newOrder();
    const edcTransactionId = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Saldo tidak cukup",
      responseCode: "51",
    });
    const input = { edcTransactionId, idempotencyKey: randomUUID() };
    for (let i = 0; i < 2; i += 1) {
      const res = await payEdc(order.orderId, order.status, input);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
    }
    // A concurrent burst of the same declined result is refused too.
    const burst = await Promise.all(
      [1, 2, 3].map(() =>
        payEdc(order.orderId, order.status, {
          edcTransactionId,
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    for (const res of burst) expect(res.status).toBe(409);
    expect(await tenderRows(order.orderId)).toBe(0);
    const { rows } = await owner.query(
      `SELECT 1 FROM pos_order_tenders WHERE edc_transaction_id = $1`,
      [edcTransactionId],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("POS-936-C EDC declined: the order detail shows the attempt", () => {
  it("POS-936-C-6 edcAttempts holds the declined attempt with status, declineReason and responseCode", async () => {
    const order = await newOrder();
    const edcTransactionId = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Saldo tidak cukup",
      responseCode: "51",
    });
    const attempts = await attemptsOf(order.orderId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: edcTransactionId,
      status: "declined",
      amountIdr: order.totalIdr,
      terminalId: ids.terminal,
      declineReason: "Saldo tidak cukup",
      responseCode: "51",
      bank: "bca",
      method: "card",
      mode: "ecr",
    });
    expect(attempts[0]).toHaveProperty("terminalLabel");
    expect(typeof attempts[0]?.createdAt).toBe("string");
    expect(typeof attempts[0]?.completedAt).toBe("string");
  });

  it("POS-936-C-7 a declined attempt is visible while the bill itself is unchanged", async () => {
    const order = await newOrder();
    await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Saldo tidak cukup",
      responseCode: "51",
    });
    const res = await pos().get(order.orderId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: order.status,
      totalIdr: order.totalIdr,
      tenders: [],
    });
    expect(res.body.data.edcAttempts).toHaveLength(1);
  });

  it("POS-936-C-8 declineReason is only set for a declined attempt; other statuses carry their own status", async () => {
    const order = await newOrder();
    const cancelled = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "cancelled",
      message: "Dibatalkan di terminal",
      responseCode: null,
      createdAt: new Date(Date.now() - 3_000),
    });
    const approved = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "approved",
      message: "Disetujui",
      responseCode: "00",
      createdAt: new Date(Date.now() - 2_000),
    });
    const attempts = await attemptsOf(order.orderId);
    const byId = new Map(attempts.map((a) => [a.id, a]));
    expect(byId.get(cancelled)).toMatchObject({
      status: "cancelled",
      declineReason: null,
    });
    expect(byId.get(approved)).toMatchObject({
      status: "approved",
      declineReason: null,
      responseCode: "00",
    });
  });

  it("POS-936-C-9 a decline without bank text still reads as declined, with null reason and code", async () => {
    const order = await newOrder();
    await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: null,
      responseCode: null,
    });
    const attempts = await attemptsOf(order.orderId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: "declined",
      declineReason: null,
      responseCode: null,
    });
  });

  it("POS-936-C-10 an order with no EDC attempt has an empty edcAttempts list", async () => {
    const order = await newOrder();
    expect(await attemptsOf(order.orderId)).toEqual([]);
  });

  it("POS-936-C-11 edcAttempts is newest first and keeps at most 5", async () => {
    const order = await newOrder();
    const base = Date.now() - 60_000;
    const created: string[] = [];
    for (let i = 0; i < 6; i += 1)
      created.push(
        await ledgerSale({
          reference: order.number,
          amountIdr: order.totalIdr,
          message: `Ditolak ${i}`,
          responseCode: "05",
          createdAt: new Date(base + i * 1_000),
        }),
      );
    const attempts = await attemptsOf(order.orderId);
    expect(attempts.map((a) => a.id)).toEqual(
      [...created].reverse().slice(0, 5),
    );
    expect(attempts[0]?.declineReason).toBe("Ditolak 5");
  });
});

describe("POS-936-C EDC declined: other tenant and outlet", () => {
  it("POS-936-C-12 declined attempts of another outlet or another tenant never show on this order", async () => {
    const order = await newOrder();
    // Same reference (the order number), but another outlet / another tenant.
    await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Outlet lain",
      responseCode: "51",
      outletId: ids.otherOutlet,
      terminalId: ids.otherOutletTerminal,
    });
    await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Tenant lain",
      responseCode: "51",
      tenantId: otherTenant.tenantId,
      outletId: otherTenant.outletId,
      terminalId: ids.otherTenantTerminal,
    });
    const own = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Saldo tidak cukup",
      responseCode: "51",
    });
    const attempts = await attemptsOf(order.orderId);
    expect(attempts.map((a) => a.id)).toEqual([own]);
  });

  it("POS-936-C-13 a declined sale of another outlet cannot be used to pay this order, and changes nothing", async () => {
    const order = await newOrder();
    const edcTransactionId = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Outlet lain",
      responseCode: "51",
      outletId: ids.otherOutlet,
      terminalId: ids.otherOutletTerminal,
    });
    const refused = await payEdc(order.orderId, order.status, {
      edcTransactionId,
    });
    expect([404, 409, 422]).toContain(refused.status);
    expect(await tenderRows(order.orderId)).toBe(0);
    const after = await pos().get(order.orderId);
    expect(after.body.data).toMatchObject({
      totalIdr: order.totalIdr,
      tenders: [],
    });
  });

  it("POS-936-C-14 the order and its declined attempt cannot be read through another tenant's host", async () => {
    const order = await newOrder();
    await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Saldo tidak cukup",
      responseCode: "51",
    });
    const res = await cashier.client
      .get(
        `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders/${order.orderId}`,
      )
      .set({ Host: otherTenant.hostname })
      .set(originHeader);
    expect([401, 403, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toContain("Saldo tidak cukup");
  });

  it("POS-936-C-15 a declined sale of another tenant cannot be used to pay this order", async () => {
    const order = await newOrder();
    const edcTransactionId = await ledgerSale({
      reference: order.number,
      amountIdr: order.totalIdr,
      message: "Tenant lain",
      responseCode: "51",
      tenantId: otherTenant.tenantId,
      outletId: otherTenant.outletId,
      terminalId: ids.otherTenantTerminal,
    });
    const refused = await payEdc(order.orderId, order.status, {
      edcTransactionId,
    });
    expect([404, 409, 422]).toContain(refused.status);
    expect(await tenderRows(order.orderId)).toBe(0);
  });
});
