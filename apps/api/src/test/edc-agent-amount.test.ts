// EDC agent write-ahead amount check (bead legend-xcbs7; EDC-01 "Jangan sampai
// rugi": the customer is never charged an amount the bill cannot book).
//
// Contract (brief Design A): before the agent records a pending ECR request it
// compares the request amount with the CURRENT remaining balance of the bill
// whose number is the request `reference`. A stale POS screen (bill changed by
// a discount, a partial cash tender, ...) must be refused with the code
// EDC_AMOUNT_MISMATCH (HTTP 409 class) and NO ledger row may be written,
// because a charge that differs from the remaining balance can never be booked
// as a tender (money taken, bill unpaid).
//
// Assumptions (spec silent, repeated in the report):
// - The refusal is an EdcError (`reason`) or a PosError (`code`) carrying
//   EDC_AMOUNT_MISMATCH; the helper accepts either field.
// - A reference that matches no POS order of the outlet, or a bill that still
//   carries a legacy payment link, is refused with ORDER_NOT_PAYABLE (the card
//   tender path could never book it).
// - "Order not open for payment" (voided/completed) is not covered here: a void
//   needs a supervisor approval flow that is exercised in pos-edc-tender.test.ts.
// - A partial payment is made with a cash tender below the bill; the API applies
//   min(received, remaining) so the remainder is total - received.
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
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { EdcPaymentRequest } from "@starter/shared/edc";
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { createEdcAgent } from "../edge/edc/agent.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { EdcProviderRegistry } from "../edge/edc/registry.ts";
import { EcrSimulator } from "../edge/edc/simulator.ts";
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
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: { client: ReturnType<typeof agent>; userId: string };
let ctx: ScopedTenantContext;
let sim: EcrSimulator;
let edcAgent: ReturnType<typeof createEdcAgent>;

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
    async voidForOrder() {
      return null;
    },
  };
}

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

function pos() {
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
    cashier.client
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
      cashier.client.get(`${base}/${orderId}`).set(headers).set(originHeader),
    submit: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      send(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    discount: (orderId: string) =>
      send(`/${orderId}/discounts`, {
        source: "manual",
        kind: "percent",
        percentBp: 100,
        reason: "manager_goodwill",
        reasonNote: "Diskon kecil pelanggan tetap",
      }),
  };
}

type Bill = { orderId: string; number: string; status: string };

async function newBill(): Promise<Bill> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  let status = created.body.data.status as string;
  const orderId = created.body.data.id as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  return { orderId, number: created.body.data.number as string, status };
}

async function billOf(orderId: string) {
  const got = await pos().get(orderId);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  return {
    status: got.body.data.status as string,
    totalIdr: got.body.data.totalIdr as number,
  };
}

/** Remaining balance as the cashier's screen would show it. */
async function remainingOf(orderId: string): Promise<number> {
  const got = await pos().get(orderId);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  const tenders = (got.body.data.tenders ?? []) as {
    amountIdr: number;
    status?: string;
  }[];
  const paid = tenders
    .filter(
      (tender) => tender.status === undefined || tender.status === "captured",
    )
    .reduce((sum, tender) => sum + Number(tender.amountIdr), 0);
  return Number(got.body.data.totalIdr) - paid;
}

function request(reference: string, amountIdr: number): EdcPaymentRequest {
  return {
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    outletId: outletIdSchema.parse(tenant.outletId),
    terminalId: ids.terminal,
    reference,
    idempotencyKey: randomUUID(),
    amountIdr: idr(amountIdr),
    method: "card",
  } as EdcPaymentRequest;
}

const pay = (req: EdcPaymentRequest) =>
  edcAgent.requestPayment(ctx, cashier.userId, req);

async function ledgerRows(reference: string) {
  const { rows } = await owner.query<{
    status: string;
    amount_idr: string;
  }>(
    `SELECT status, amount_idr::text AS amount_idr
       FROM edc_transactions WHERE tenant_id = $1 AND reference = $2`,
    [tenant.tenantId, reference],
  );
  return rows;
}

/** Runs `run` and returns the thrown error (the test fails if nothing throws). */
async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error(
    "expected the EDC request to be refused, but it was accepted",
  );
}

function expectAmountMismatch(error: unknown) {
  const e = error as { code?: string; reason?: string };
  expect([e.code, e.reason], JSON.stringify(e)).toContain(
    "EDC_AMOUNT_MISMATCH",
  );
}

function expectOrderNotPayable(error: unknown) {
  const e = error as { code?: string; reason?: string };
  expect([e.code, e.reason], JSON.stringify(e)).toContain("ORDER_NOT_PAYABLE");
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`edca-${randomUUID().slice(0, 6)}`);
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
     VALUES ($1, $2, 'EDC Amount Kasir', false, NULL, $3, false, '["tenant"]')`,
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
  const client = agent(app);
  await signUp(client, "EDC Amount Kasir");
  const session = await client.get("/api/auth/get-session");
  cashier = { client, userId: session.body.user.id as string };
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [tenant.tenantId, cashier.userId, ids.cashierRole],
  );
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
  await asOwnerTenant(async (c) => {
    await c.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'EDC Amount Uji', 0)`,
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
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi, KOPI_IDR],
    );
    await c.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await c.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-EDCA', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await c.query(
      `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
       VALUES ($1, NULL, 1000)`,
      [tenant.tenantId],
    );
    await c.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-EDCA', 'MID-EDCA', 'Test EDC', 'lan',
               '10.0.0.7', ARRAY['card','qris'], 'active')`,
      [ids.terminal, tenant.tenantId, tenant.outletId],
    );
  });
  ctx = establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "outlets", outletIds: [outletIdSchema.parse(tenant.outletId)] },
  );
  const registry = new EdcProviderRegistry();
  sim = new EcrSimulator("bca");
  registry.register(sim);
  edcAgent = createEdcAgent({
    db,
    registry,
    saleTimeoutMs: 50,
    inquiryTimeoutMs: 50,
    cancelTimeoutMs: 50,
  });
  await edcAgent.start(ctx);
});

afterAll(async () => {
  await edcAgent?.stop(ctx).catch(() => undefined);
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("EDC agent write-ahead amount check (legend-xcbs7)", () => {
  it("EDC-01 a request for exactly the remaining balance is accepted and recorded once", async () => {
    const bill = await newBill();
    const total = (await billOf(bill.orderId)).totalIdr;

    const tx = await pay(request(bill.number, total));

    expect(tx.status).toBe("approved");
    expect(tx.amountIdr).toBe(total);
    const rows = await ledgerRows(bill.number);
    expect(rows).toEqual([{ status: "approved", amount_idr: String(total) }]);
  });

  it.each([
    { label: "lower than the bill", delta: -5_000 },
    { label: "higher than the bill", delta: 5_000 },
  ])(
    "EDC-01 a stale amount $label is refused with EDC_AMOUNT_MISMATCH and no ledger row is written",
    async ({ delta }) => {
      const bill = await newBill();
      const total = (await billOf(bill.orderId)).totalIdr;

      const error = await refusal(() =>
        pay(request(bill.number, total + delta)),
      );

      expectAmountMismatch(error);
      expect(await ledgerRows(bill.number)).toEqual([]);
      // The bill is untouched and still unpaid.
      expect(await remainingOf(bill.orderId)).toBe(total);
    },
  );

  it("EDC-01 a bill changed after the POS screen loaded (discount) refuses the old amount and accepts the new remaining", async () => {
    const bill = await newBill();
    const staleTotal = (await billOf(bill.orderId)).totalIdr;
    const discounted = await pos().discount(bill.orderId);
    expect(discounted.status, JSON.stringify(discounted.body)).toBe(201);
    const currentTotal = (await billOf(bill.orderId)).totalIdr;
    expect(currentTotal).toBeLessThan(staleTotal);

    const error = await refusal(() => pay(request(bill.number, staleTotal)));
    expectAmountMismatch(error);
    expect(await ledgerRows(bill.number)).toEqual([]);

    const tx = await pay(request(bill.number, currentTotal));
    expect(tx.status).toBe("approved");
    expect(await ledgerRows(bill.number)).toEqual([
      { status: "approved", amount_idr: String(currentTotal) },
    ]);
  });

  it("EDC-01 a partially paid bill refuses the full total and accepts exactly the remaining balance", async () => {
    const bill = await newBill();
    const total = (await billOf(bill.orderId)).totalIdr;
    const partial = 20_000;
    const cash = await pos().cash(bill.orderId, bill.status, partial);
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    const remaining = await remainingOf(bill.orderId);
    expect(remaining).toBe(total - partial);

    // The full bill would charge the customer for what the cash already paid.
    const error = await refusal(() => pay(request(bill.number, total)));
    expectAmountMismatch(error);
    expect(await ledgerRows(bill.number)).toEqual([]);

    const tx = await pay(request(bill.number, remaining));
    expect(tx.status).toBe("approved");
    expect(tx.amountIdr).toBe(remaining);
    expect(await ledgerRows(bill.number)).toEqual([
      { status: "approved", amount_idr: String(remaining) },
    ]);
  });

  it("EDC-01 a reference that is no bill of this outlet is refused with ORDER_NOT_PAYABLE and nothing is recorded", async () => {
    const reference = `NO-BILL-${randomUUID().slice(0, 8)}`;

    const error = await refusal(() => pay(request(reference, 55_000)));

    expectOrderNotPayable(error);
    expect(await ledgerRows(reference)).toEqual([]);
  });

  it("EDC-01 a bill with a legacy payment link is refused with ORDER_NOT_PAYABLE and nothing is recorded", async () => {
    const bill = await newBill();
    const total = (await billOf(bill.orderId)).totalIdr;
    const linkId = randomUUID();
    await asOwnerTenant(async (client) => {
      await client.query(
        `INSERT INTO payment_links
           (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $6, 0, 'edc-amount-test')`,
        [
          linkId,
          tenant.tenantId,
          tenant.outletId,
          randomUUID().replaceAll("-", "").padEnd(64, "0"),
          `EA-${linkId.slice(0, 8)}`,
          total,
        ],
      );
      await client.query(
        "UPDATE orders SET payment_link_id = $3, payment_link_token_sealed = 'edc-amount-test' WHERE tenant_id = $1 AND id = $2",
        [tenant.tenantId, ulidToUuid(bill.orderId), linkId],
      );
    });

    const error = await refusal(() => pay(request(bill.number, total)));

    expectOrderNotPayable(error);
    expect(await ledgerRows(bill.number)).toEqual([]);
  });
});
