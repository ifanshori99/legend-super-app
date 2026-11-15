// POS standalone EDC tender (bead legend-m4fv; EDC-04). The agent is down and
// the cashier keyed the sale on the terminal by hand. A supervisor PIN
// override (`edc_standalone`, worth exactly the remaining bill) plus the bank
// reference settle the tender; the API writes the `edc_transactions` row
// (mode standalone, approved, flagged for reconciliation) and the tender links
// to it. One override pays one bill, once.

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
    tender: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/tenders`, body),
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
        "shift.cash.operate",
      ],
    ],
    [
      ids.supervisorRole,
      "EDC Supervisor Uji",
      ["order.view", "pos.edc_standalone.approve", "pos.void.approve"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "POS Kasir");
  supervisor = await member(ids.supervisorRole, "EDC Supervisor");
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

// ---- Fixtures: order, terminal, override ------------------------------------

let terminalId: string;

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

/** The supervisor's own tile + PIN, like production. */
async function standaloneOverride(input: {
  objectId: string;
  valueIdr: number;
  action?: "edc_standalone" | "void";
}): Promise<string> {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action: input.action ?? "edc_standalone",
      valueIdr: input.valueIdr,
      reason: "Agen EDC mati, kunci manual",
      objectType: input.action === "void" ? "order" : "pos_order",
      objectId: input.objectId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisor.userId),
        pin: PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return override.id;
}

/** A ledger row for the bill, as the agent (or an earlier standalone) left it. */
async function ledgerRow(input: {
  reference: string;
  amountIdr: number;
  status: string;
  mode?: string;
  needsReconciliation?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const final = ["approved", "declined", "cancelled", "failed"].includes(
    input.status,
  );
  await asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          needs_reconciliation, completed_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', $9, $10,
               $11, $12)`,
      [
        id,
        tenant.tenantId,
        tenant.outletId,
        terminalId,
        input.reference,
        randomUUID(),
        input.amountIdr,
        input.status,
        input.mode ?? "ecr",
        randomUUID().slice(0, 12),
        input.needsReconciliation ?? false,
        final ? new Date() : null,
      ],
    ),
  );
  return id;
}

function payStandalone(
  order: Awaited<ReturnType<typeof newOrder>>,
  standalone: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  method = "edc_card",
) {
  return pos().tender(order.orderId, {
    method,
    expectedStatus: order.status,
    standalone,
    ...extra,
  });
}

async function noTender(orderId: string): Promise<void> {
  const { rows } = await owner.query(
    `SELECT 1 FROM pos_order_tenders WHERE order_id = $1`,
    [ulidToUuid(orderId)],
  );
  expect(rows).toHaveLength(0);
}

async function standaloneRows(reference: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    mode: string;
    type: string;
    needs_reconciliation: boolean;
    rrn: string | null;
    approval_code: string | null;
    amount_idr: string;
    terminal_id: string;
    trace: string;
  }>(
    `SELECT id, status, mode, type, needs_reconciliation, rrn, approval_code,
            amount_idr, terminal_id, trace
     FROM edc_transactions WHERE tenant_id = $1 AND reference = $2
       AND mode = 'standalone'`,
    [tenant.tenantId, reference],
  );
  return rows;
}

describe("POS standalone EDC tender (legend-m4fv, EDC-04)", () => {
  beforeAll(async () => {
    terminalId = randomUUID();
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO payment_edc_terminals
           (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
            connection, ip_address, supported_methods, status)
         VALUES ($1, $2, $3, 'bca', 'TID-SA', 'MID-SA', 'Test EDC', 'lan',
                 '10.0.0.8', ARRAY['card','qris'], 'active')`,
        [terminalId, tenant.tenantId, tenant.outletId],
      ),
    );
  });

  it("EDC-04 a supervisor-approved standalone payment writes a flagged ledger row and settles the tender", async () => {
    const order = await newOrder();
    const overrideId = await standaloneOverride({
      objectId: order.orderId,
      valueIdr: order.totalIdr,
    });
    const paid = await payStandalone(order, {
      terminalId,
      bankRef: "123456789012",
      approvalCode: "A1B2C3",
      overrideId,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data.remainingIdr).toBe(0);
    const rows = await standaloneRows(order.number);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "approved",
      mode: "standalone",
      type: "sale",
      needs_reconciliation: true,
      rrn: "123456789012",
      approval_code: "A1B2C3",
      amount_idr: String(order.totalIdr),
      terminal_id: terminalId,
    });
    expect(rows[0]?.trace).toMatch(/^[A-Za-z0-9]{6,32}$/);
    const tenders = await owner.query<{
      edc_transaction_id: string;
      approved_by: string;
      reference: string;
      provider: string;
      status: string;
    }>(
      `SELECT edc_transaction_id, approved_by, reference, provider, status
       FROM pos_order_tenders WHERE order_id = $1`,
      [ulidToUuid(order.orderId)],
    );
    expect(tenders.rows).toEqual([
      {
        edc_transaction_id: rows[0]?.id,
        approved_by: supervisor.userId,
        reference: "123456789012",
        provider: "edc",
        status: "captured",
      },
    ]);
    const uses = await owner.query<{ purpose: string }>(
      `SELECT purpose FROM pos_order_approval_uses WHERE override_id = $1::uuid`,
      [ulidToUuid(overrideId)],
    );
    expect(uses.rows).toEqual([{ purpose: "edc_standalone" }]);
  });

  it("EDC-04 an override pays one bill once: replay on another bill and a second use are refused", async () => {
    const first = await newOrder();
    const second = await newOrder();
    const overrideId = await standaloneOverride({
      objectId: first.orderId,
      valueIdr: first.totalIdr,
    });
    const standalone = { terminalId, bankRef: "998877665544", overrideId };
    const other = await payStandalone(second, standalone);
    expect(other.status, JSON.stringify(other.body)).toBe(403);
    await noTender(second.orderId);
    expect(await standaloneRows(second.number)).toHaveLength(0);
    const paid = await payStandalone(first, standalone);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const again = await payStandalone(first, standalone);
    expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(await standaloneRows(first.number)).toHaveLength(1);
    const bill = await pos().get(first.orderId);
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.data.totalIdr).toBe(first.totalIdr);
    expect(bill.body.data.tenders).toHaveLength(1);
    const tenders = await owner.query<{ count: number; amount_idr: string }>(
      `SELECT count(*)::int AS count, sum(amount_idr)::text AS amount_idr
       FROM pos_order_tenders WHERE order_id = $1 AND status = 'captured'`,
      [ulidToUuid(first.orderId)],
    );
    expect(tenders.rows).toEqual([
      { count: 1, amount_idr: String(first.totalIdr) },
    ]);
  });

  it("EDC-04 a missing or wrong supervisor PIN cannot authorize a standalone payment", async () => {
    const order = await newOrder();
    for (const pin of [undefined, "000000"]) {
      const result = await cashier.client
        .post("/api/pos-overrides")
        .set(headers)
        .set(originHeader)
        .send({
          outletId: tenant.outletId,
          action: "edc_standalone",
          valueIdr: order.totalIdr,
          reason: "Agen EDC mati, kunci manual",
          objectType: "pos_order",
          objectId: order.orderId,
          approval: {
            method: "supervisor_pin",
            approverUserId: supervisor.userId,
            ...(pin === undefined ? {} : { pin }),
          },
        });
      expect(result.status, JSON.stringify(result.body)).toBe(
        pin === undefined ? 422 : 401,
      );
      if (pin !== undefined) expect(result.body.error.code).toBe("PIN_INVALID");
      expect(result.body.data?.override).toBeUndefined();
      await noTender(order.orderId);
      expect(await standaloneRows(order.number)).toHaveLength(0);
      const bill = await pos().get(order.orderId);
      expect(bill.status, JSON.stringify(bill.body)).toBe(200);
      expect(bill.body.data.totalIdr).toBe(order.totalIdr);
      expect(bill.body.data.status).toBe(order.status);
      expect(bill.body.data.tenders).toEqual([]);
    }
  });

  it("EDC-04 a missing override or bank reference never records a standalone payment", async () => {
    const order = await newOrder();
    const overrideId = await standaloneOverride({
      objectId: order.orderId,
      valueIdr: order.totalIdr,
    });
    for (const standalone of [
      { terminalId, bankRef: "112233445566" },
      { terminalId, overrideId },
      { terminalId, bankRef: "", overrideId },
    ]) {
      const refused = await payStandalone(order, standalone);
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      await noTender(order.orderId);
      expect(await standaloneRows(order.number)).toHaveLength(0);
      const bill = await pos().get(order.orderId);
      expect(bill.status, JSON.stringify(bill.body)).toBe(200);
      expect(bill.body.data.totalIdr).toBe(order.totalIdr);
      expect(bill.body.data.status).toBe(order.status);
      expect(bill.body.data.tenders).toEqual([]);
    }
    // Invalid input cannot spend the valid approval; it still pays exactly once.
    const paid = await payStandalone(order, {
      terminalId,
      bankRef: "112233445566",
      overrideId,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const bill = await pos().get(order.orderId);
    expect(bill.status, JSON.stringify(bill.body)).toBe(200);
    expect(bill.body.data.totalIdr).toBe(order.totalIdr);
    expect(paid.body.data.remainingIdr).toBe(0);
    expect(await standaloneRows(order.number)).toHaveLength(1);
  });

  it("the override must name this bill, this action and exactly the remaining amount", async () => {
    const order = await newOrder();
    const refused = async (overrideId: string) => {
      const res = await payStandalone(order, {
        terminalId,
        bankRef: "112233445566",
        overrideId,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      await noTender(order.orderId);
      expect(await standaloneRows(order.number)).toHaveLength(0);
    };
    await refused(
      await standaloneOverride({
        objectId: order.orderId,
        valueIdr: order.totalIdr + 1_000,
      }),
    );
    await refused(
      await standaloneOverride({
        objectId: order.orderId,
        valueIdr: order.totalIdr - 1_000,
      }),
    );
    await refused(
      await standaloneOverride({
        objectId: order.orderId,
        valueIdr: order.totalIdr,
        action: "void",
      }),
    );
    await refused(
      await standaloneOverride({
        objectId: (await newOrder()).orderId,
        valueIdr: order.totalIdr,
      }),
    );
    await refused(createUlid());
  });

  it("a bank reference that looks like a card number, or a body mixing both paths, is a 422", async () => {
    const order = await newOrder();
    const overrideId = await standaloneOverride({
      objectId: order.orderId,
      valueIdr: order.totalIdr,
    });
    for (const bankRef of [
      "4111111111111111",
      "4111 1111 1111 1111",
      "123456789012345",
      "A4111111111111111",
      "4111111111111111X",
      "41111111-11111111A",
    ]) {
      const res = await payStandalone(order, {
        terminalId,
        bankRef,
        overrideId,
      });
      expect(res.status, bankRef).toBe(422);
    }
    const mixed = await payStandalone(
      order,
      { terminalId, bankRef: "123456789012", overrideId },
      { edcTransactionId: randomUUID() },
    );
    expect(mixed.status, JSON.stringify(mixed.body)).toBe(422);
    await noTender(order.orderId);
    expect(await standaloneRows(order.number)).toHaveLength(0);
  });

  it("is refused while a card-terminal row for the bill is pending, unknown or flagged", async () => {
    for (const row of [
      { status: "pending" },
      { status: "unknown" },
      { status: "approved", needsReconciliation: true, mode: "standalone" },
    ]) {
      const order = await newOrder();
      await ledgerRow({
        reference: order.number,
        amountIdr: order.totalIdr,
        ...row,
      });
      const overrideId = await standaloneOverride({
        objectId: order.orderId,
        valueIdr: order.totalIdr,
      });
      const res = await payStandalone(order, {
        terminalId,
        bankRef: "556677889900",
        overrideId,
      });
      expect(res.status, JSON.stringify([row, res.body])).toBe(409);
      await noTender(order.orderId);
      // The override stays unspent: the refusal rolled the use back.
      const uses = await owner.query(
        `SELECT 1 FROM pos_order_approval_uses WHERE override_id = $1::uuid`,
        [ulidToUuid(overrideId)],
      );
      expect(uses.rows).toHaveLength(0);
    }
  });

  it("is refused for a terminal that is not this outlet's", async () => {
    const order = await newOrder();
    const overrideId = await standaloneOverride({
      objectId: order.orderId,
      valueIdr: order.totalIdr,
    });
    const res = await payStandalone(order, {
      terminalId: randomUUID(),
      bankRef: "556677889900",
      overrideId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    await noTender(order.orderId);
  });

  it("the ecr path refuses a ledger row flagged for reconciliation", async () => {
    const order = await newOrder();
    const edcTransactionId = await ledgerRow({
      reference: order.number,
      amountIdr: order.totalIdr,
      status: "approved",
      needsReconciliation: true,
    });
    const res = await pos().tender(order.orderId, {
      method: "edc_card",
      expectedStatus: order.status,
      edcTransactionId,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    await noTender(order.orderId);
  });

  it("one EDC row backs at most one live tender (partial unique index)", async () => {
    const { rows } = await owner.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'pos_order_tenders' AND indexdef ILIKE '%edc_transaction_id%'
         AND indexdef ILIKE '%UNIQUE%'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.indexdef).toMatch(/captured|authorized|voided/);
  });
});
