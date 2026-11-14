// QR order awaiting payment vs an open EDC sale (bead legend-kiibf; EDC-01
// "Jangan sampai rugi"). The EDC agent never checks the order status, so an
// ECR sale CAN exist for a QR order that is still awaiting payment (the ledger
// reference is the order number). Voiding that order while the card sale is
// not final would drop the bill while the customer's card may be charged.
//
// Contract (brief Design C): voiding an awaiting_payment QR order is refused
// with EDC_REQUEST_OPEN (HTTP 409 class) while an EDC sale of the order is
// pending, unknown, flagged for reconciliation, or approved but not booked.
// The order stays awaiting_payment. After a FINAL declined (unflagged) result,
// the void succeeds. A request of another order never blocks.
//
// Assumptions (spec silent, repeated in the report):
// - Staff path is `voidUnpaidQrOrder(context, orderId, { reason, actorUserId })`
//   (as qr-order-void-partial-refund.test.ts); the refusal is a PosError whose
//   `code` is EDC_REQUEST_OPEN.
// - The EDC ledger row is seeded directly, with reference = orders.number and
//   the outlet of the order.
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { createApp } from "../app.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  qrOrderSettlementLookup,
  voidUnpaidQrOrder,
} from "../services/qr-order.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };
let terminalId: string;
const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
};
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

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

function contextOf(): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

type Guest = { token: string; sessionId: string };

async function seatAtNewTable(): Promise<Guest> {
  const zone = await createZone(
    staff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  const qr = await issueQr(staff.client, table.id, headers);
  const response = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(response.status).toBe(201);
  return {
    token: response.body.data.sessionToken,
    sessionId: response.body.data.session.id,
  };
}

function as(guest: Guest) {
  const client = agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  const base = `/api/table-sessions/${guest.sessionId}`;
  return {
    add: (menuItemId: string, expectedCartVersion: number) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        menuItemId,
        quantity: 1,
        expectedCartVersion,
      }),
    checkout: (expectedCartVersion: number) =>
      auth(client.post(`${base}/orders`)).send({
        expectedCartVersion,
        idempotencyKey: randomUUID(),
      }),
  };
}

type QrBill = { orderId: string; number: string; outletId: string };

/** A QR order that has been placed and is awaiting payment. */
async function awaitingPaymentOrder(): Promise<QrBill> {
  const guest = await seatAtNewTable();
  const added = await as(guest).add(ids.kopi, 0);
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.data.order.id as string;
  const { rows } = await owner.query<{
    number: string;
    outlet_id: string;
    status: string;
  }>(
    `SELECT number, outlet_id, status FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  expect(rows[0]?.status).toBe("awaiting_payment");
  return { orderId, number: rows[0]!.number, outletId: rows[0]!.outlet_id };
}

async function orderStatus(orderId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    `SELECT status FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.status;
}

type Sale = {
  status: "pending" | "unknown" | "approved" | "declined";
  dispatched?: boolean;
  needsReconciliation?: boolean;
};

async function edcSale(bill: QrBill, sale: Sale): Promise<string> {
  const id = randomUUID();
  const final = sale.status === "approved" || sale.status === "declined";
  await asOwnerTenant((client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, completed_at, dispatched_at, needs_reconciliation)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', 30000, 'card', $7::varchar, 'sale', 'ecr', $8,
               $9, $10, $11, $12, $13)`,
      [
        id,
        tenant.tenantId,
        bill.outletId,
        terminalId,
        bill.number,
        randomUUID(),
        sale.status,
        randomUUID().slice(0, 12),
        sale.status === "approved" ? "APP123" : null,
        sale.status === "approved"
          ? "RRN" + randomUUID().replace(/-/g, "").slice(0, 9)
          : null,
        final ? new Date() : null,
        sale.dispatched === false ? null : new Date(),
        sale.needsReconciliation ?? false,
      ],
    ),
  );
  return id;
}

const VOID_INPUT = { reason: "Staf membatalkan pesanan" };

async function voidAsStaff(bill: QrBill) {
  return voidUnpaidQrOrder(contextOf(), bill.orderId, {
    ...VOID_INPUT,
    actorUserId: staff.userId,
  });
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the void to be refused, but it succeeded");
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);
  tenant = await createIsolatedTenant(`qvedc-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  terminalId = randomUUID();
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'QR Void EDC Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-QVE', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO payment_edc_terminals
         (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
          connection, ip_address, supported_methods, status)
       VALUES ($1, $2, $3, 'bca', 'TID-QVE', 'MID-QVE', 'Test EDC', 'lan',
               '10.0.0.8', ARRAY['card','qris'], 'active')`,
      [terminalId, tenant.tenantId, tenant.outletId],
    );
  });
});

afterAll(async () => {
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("Void of an awaiting-payment QR order with an EDC sale (legend-kiibf)", () => {
  it.each<{ label: string; sale: Sale }>([
    { label: "pending and sent", sale: { status: "pending" } },
    {
      label: "pending, send not yet confirmed",
      sale: { status: "pending", dispatched: false },
    },
    { label: "unknown", sale: { status: "unknown" } },
    {
      label: "declined but flagged for reconciliation",
      sale: { status: "declined", needsReconciliation: true },
    },
    { label: "approved but not booked", sale: { status: "approved" } },
  ])(
    "EDC-01 a void while the card sale is $label is refused EDC_REQUEST_OPEN and the order stays awaiting_payment",
    async ({ sale }) => {
      const bill = await awaitingPaymentOrder();
      await edcSale(bill, sale);

      const error = await refusal(() => voidAsStaff(bill));

      expect((error as { code?: string }).code).toBe("EDC_REQUEST_OPEN");
      expect(await orderStatus(bill.orderId)).toBe("awaiting_payment");
    },
  );

  it("EDC-01 once the sale is finally declined (not flagged) the void succeeds; a timeout alone never opens it", async () => {
    const bill = await awaitingPaymentOrder();
    const saleId = await edcSale(bill, { status: "unknown" });

    const first = await refusal(() => voidAsStaff(bill));
    expect((first as { code?: string }).code).toBe("EDC_REQUEST_OPEN");
    expect(await orderStatus(bill.orderId)).toBe("awaiting_payment");

    // Age the request far past any timeout: still locked until it is final.
    await asOwnerTenant((client) =>
      client.query(
        `UPDATE edc_transactions
            SET created_at = now() - interval '3 days',
                dispatched_at = now() - interval '3 days'
          WHERE id = $1`,
        [saleId],
      ),
    );
    const second = await refusal(() => voidAsStaff(bill));
    expect((second as { code?: string }).code).toBe("EDC_REQUEST_OPEN");
    expect(await orderStatus(bill.orderId)).toBe("awaiting_payment");

    // Final inquiry result: declined by the bank, nothing flagged.
    await asOwnerTenant((client) =>
      client.query(
        `UPDATE edc_transactions
            SET status = 'declined', completed_at = now(), needs_reconciliation = false
          WHERE id = $1`,
        [saleId],
      ),
    );
    await voidAsStaff(bill);
    expect(await orderStatus(bill.orderId)).toBe("voided");
  });

  it("control: an awaiting-payment order with no EDC sale, or only a final declined one, is voided", async () => {
    const clean = await awaitingPaymentOrder();
    await voidAsStaff(clean);
    expect(await orderStatus(clean.orderId)).toBe("voided");

    const declined = await awaitingPaymentOrder();
    await edcSale(declined, { status: "declined" });
    await voidAsStaff(declined);
    expect(await orderStatus(declined.orderId)).toBe("voided");
  });

  it("an open EDC sale of ANOTHER order does not block this void", async () => {
    const other = await awaitingPaymentOrder();
    const mine = await awaitingPaymentOrder();
    await edcSale(other, { status: "pending" });

    await voidAsStaff(mine);

    expect(await orderStatus(mine.orderId)).toBe("voided");
    expect(await orderStatus(other.orderId)).toBe("awaiting_payment");
  });
});
