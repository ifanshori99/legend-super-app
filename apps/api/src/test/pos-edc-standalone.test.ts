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
import { createPosOverrideSchema } from "@starter/shared/access/override";
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
import { runEdcReconciliationOverdueJob } from "../worker/edc-reconciliation-overdue.job.ts";
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
  rrn?: string;
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
          needs_reconciliation, completed_at, rrn)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', $8, 'sale', $9, $10,
               $11, $12, $13)`,
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
        input.rrn ?? null,
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

  // 1268 W2 review 1: the till treats EDC_STANDALONE_APPROVAL_REQUIRED of a
  // repeat as proof that nothing was recorded under its key, so the key is
  // looked up before the approval is.
  it("EDC-04 a recorded key replays after its PIN window; an unrecorded one is refused", async () => {
    const expire = (overrideId: string) =>
      asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `UPDATE pos_overrides SET resolved_at = now() - interval '16 minutes',
                  created_at = now() - interval '16 minutes' WHERE id = $1`,
          [ulidToUuid(overrideId)],
        ),
      );
    const order = await newOrder();
    const overrideId = await standaloneOverride({
      objectId: order.orderId,
      valueIdr: order.totalIdr,
    });
    const standalone = { terminalId, bankRef: "445566778899", overrideId };
    const key = { idempotencyKey: randomUUID() };
    const paid = await payStandalone(order, standalone, key);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    await expire(overrideId);
    const replay = await payStandalone(order, standalone, key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.data.tender.id).toBe(paid.body.data.tender.id);
    expect(await standaloneRows(order.number)).toHaveLength(1);

    const second = await newOrder();
    const late = await standaloneOverride({
      objectId: second.orderId,
      valueIdr: second.totalIdr,
    });
    await expire(late);
    const refused = await payStandalone(second, {
      terminalId,
      bankRef: "445566778800",
      overrideId: late,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error.code).toBe("EDC_STANDALONE_APPROVAL_REQUIRED");
    await noTender(second.orderId);
    expect(await standaloneRows(second.number)).toHaveLength(0);
  });

  // 1268 W2: the supervisor of an unsettled request may not void a slip that
  // paid the bill: the books would stay paid and the money would be gone.
  it("EDC-04 a slip that paid the bill is closed as recorded, never as voided", async () => {
    const order = await newOrder();
    const overrideId = await standaloneOverride({
      objectId: order.orderId,
      valueIdr: order.totalIdr,
    });
    const bankRef = "44556677-88AB";
    const paid = await payStandalone(order, {
      terminalId,
      bankRef,
      overrideId,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const resolve = (key: string | null, over: Record<string, unknown>) =>
      cashier.client
        .post(`${pos().base}/${order.orderId}/payment-intents/resolve`)
        .set(headers)
        .set(originHeader)
        .send({
          key,
          reason: "Catatan rusak",
          approverUserId: supervisor.userId,
          pin: PIN,
          ...over,
        });
    const lostKey = `edc_standalone:${randomUUID()}`;
    for (const key of [null, lostKey])
      for (const typed of [bankRef, "44556677-88ab", "4455667788AB"]) {
        const voided = await resolve(key, {
          card: "voided",
          voidRef: "000123",
          bankRef: typed,
        });
        expect(voided.status, JSON.stringify(voided.body)).toBe(409);
      }
    const recorded = await resolve(null, { card: "recording", bankRef });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    expect(recorded.body.data.outcome).toBe("recorded");
    // Another slip charged for a paid bill is the one to void.
    const other = await resolve(lostKey, {
      card: "voided",
      voidRef: "000123",
      bankRef: "998877665511",
    });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(other.body.data.outcome).toBe("closed");
    expect(await standaloneRows(order.number)).toHaveLength(1);
  });

  // The order lock comes before the approval: a repeat that arrives while the
  // first send holds the bill waits for it and answers the recorded payment.
  it("EDC-04 a repeat sent together with the first answers the same payment", async () => {
    const order = await newOrder();
    const overrideId = await standaloneOverride({
      objectId: order.orderId,
      valueIdr: order.totalIdr,
    });
    const standalone = { terminalId, bankRef: "445566778811", overrideId };
    const key = { idempotencyKey: randomUUID() };
    const [a, b] = await Promise.all([
      payStandalone(order, standalone, key),
      payStandalone(order, standalone, key),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.data.tender.id).toBe(b.body.data.tender.id);
    expect(await standaloneRows(order.number)).toHaveLength(1);
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

  it("EDC-04 a missing bank reference never records a standalone payment", async () => {
    const order = await newOrder();
    const overrideId = await standaloneOverride({
      objectId: order.orderId,
      valueIdr: order.totalIdr,
    });
    for (const standalone of [
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

  // X1 (cloud-only release §3): manual EDC is the normal path. The slip
  // reference books it without a supervisor PIN; the ledger row stays flagged
  // for the H+1 reconciliation, so nothing counts as settled with the bank.
  it("X1 a manual EDC payment with the slip reference and no supervisor PIN books the remaining bill, flagged for reconciliation", async () => {
    const order = await newOrder();
    const paid = await payStandalone(order, {
      terminalId,
      bankRef: "X1RRN0000001",
      approvalCode: "AP0001",
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data.remainingIdr).toBe(0);
    const rows = await standaloneRows(order.number);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "approved",
      mode: "standalone",
      needs_reconciliation: true,
      rrn: "X1RRN0000001",
      approval_code: "AP0001",
      amount_idr: String(order.totalIdr),
    });
    const tenders = await owner.query<{
      edc_transaction_id: string;
      approved_by: string | null;
      captured_by: string;
      amount_idr: string;
      reference: string;
    }>(
      `SELECT edc_transaction_id, approved_by, captured_by, amount_idr::text, reference
       FROM pos_order_tenders WHERE order_id = $1`,
      [ulidToUuid(order.orderId)],
    );
    expect(tenders.rows).toEqual([
      {
        edc_transaction_id: rows[0]?.id,
        approved_by: null,
        captured_by: cashier.userId,
        amount_idr: String(order.totalIdr),
        reference: "X1RRN0000001",
      },
    ]);
  });

  it("X1 the amount comes from the server: a body naming an amount is a 422 and books nothing", async () => {
    const order = await newOrder();
    for (const extra of [
      { amountIdr: 1_000 },
      { standaloneAmountIdr: 1_000 },
    ]) {
      const res = await payStandalone(
        order,
        { terminalId, bankRef: "X1RRN0000002" },
        extra,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    }
    const nested = await payStandalone(order, {
      terminalId,
      bankRef: "X1RRN0000002",
      amountIdr: 1_000,
    });
    expect(nested.status, JSON.stringify(nested.body)).toBe(422);
    await noTender(order.orderId);
    expect(await standaloneRows(order.number)).toHaveLength(0);
  });

  it("X1 without a slip reference nothing is booked, PIN or not", async () => {
    const order = await newOrder();
    for (const standalone of [
      { terminalId },
      { terminalId, bankRef: "" },
      { terminalId, approvalCode: "AP0001" },
    ]) {
      const res = await payStandalone(order, standalone);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
    }
    await noTender(order.orderId);
    expect(await standaloneRows(order.number)).toHaveLength(0);
  });

  it("X1 one slip reference pays one bill once, however it is typed and whichever path wrote it", async () => {
    const first = await newOrder();
    const paid = await payStandalone(first, {
      terminalId,
      bankRef: "X1-RRN-000003",
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    for (const bankRef of ["X1-RRN-000003", "x1rrn000003", "X1RRN-000003"]) {
      const second = await newOrder();
      const res = await payStandalone(second, { terminalId, bankRef });
      expect(res.status, JSON.stringify([bankRef, res.body])).toBe(409);
      await noTender(second.orderId);
      expect(await standaloneRows(second.number)).toHaveLength(0);
    }
    // A terminal (ECR) sale already carrying the RRN blocks a manual entry.
    const ecrBill = await newOrder();
    await ledgerRow({
      reference: `OTHER-${ecrBill.number}`,
      amountIdr: ecrBill.totalIdr,
      status: "approved",
      rrn: "X1RRN000004",
    });
    const res = await payStandalone(ecrBill, {
      terminalId,
      bankRef: "X1RRN000004",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    await noTender(ecrBill.orderId);
    // Two bills sent together with one slip: exactly one is booked.
    const [a, b] = [await newOrder(), await newOrder()];
    const both = await Promise.all([
      payStandalone(a, { terminalId, bankRef: "X1RRN000005" }),
      payStandalone(b, { terminalId, bankRef: "X1RRN000005" }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const slips = await owner.query(
      `SELECT 1 FROM edc_transactions
       WHERE tenant_id = $1 AND upper(replace(rrn, '-', '')) = 'X1RRN000005'`,
      [tenant.tenantId],
    );
    expect(slips.rows).toHaveLength(1);
  });

  // X1: a manual slip still unmatched with the bank more than a day later
  // warns the shift that took it, once per shift.
  it("X1 a manual EDC slip unmatched for more than a day alerts its shift once", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    const order = await newOrder();
    const paid = await payStandalone(order, {
      terminalId,
      bankRef: "X1RRN0000099",
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const [tender] = (
      await owner.query<{ shift_id: string | null }>(
        `SELECT coalesce(t.shift_id, o.shift_id) AS shift_id
         FROM pos_order_tenders t
         LEFT JOIN pos_orders o
           ON o.tenant_id = t.tenant_id AND o.order_id = t.order_id
         WHERE t.order_id = $1`,
        [ulidToUuid(order.orderId)],
      )
    ).rows;
    expect(tender?.shift_id).toBeTruthy();
    const alerts = async () =>
      (
        await owner.query<{ payload: Record<string, string> }>(
          `SELECT payload FROM notification_outbox
           WHERE tenant_id = $1 AND event_type = 'pos_shift.edc_reconciliation_overdue'`,
          [tenant.tenantId],
        )
      ).rows;
    // Fresh: within the H+1 window, no warning yet.
    await runEdcReconciliationOverdueJob(context, new Date(), { force: true });
    expect(await alerts()).toHaveLength(0);
    const [row] = await standaloneRows(order.number);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE edc_transactions SET created_at = now() - interval '25 hours'
         WHERE id = $1`,
        [row?.id],
      ),
    );
    for (let run = 0; run < 2; run += 1)
      await runEdcReconciliationOverdueJob(context, new Date(), {
        force: true,
      });
    const sent = await alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toMatchObject({
      shiftId: tender?.shift_id,
      outletId: tenant.outletId,
      count: "1",
      totalIdr: String(order.totalIdr),
    });
  });

  // X1 review P2 2 + P3 3: the sweep groups in SQL and skips groups already
  // alerted, so a backlog of more than 500 old rows never hides a newer one;
  // the alert key carries the due day, so a later day of the same shift
  // alerts again.
  it("X1 over 500 overdue rows of an alerted day never hide the next due day of the shift", async () => {
    const context = establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );
    // A clean slate: earlier tests' flagged rows and alerts are not this one's.
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `UPDATE edc_transactions SET needs_reconciliation = false
         WHERE tenant_id = $1 AND needs_reconciliation`,
        [tenant.tenantId],
      );
      await client.query(
        `DELETE FROM notification_outbox
         WHERE tenant_id = $1 AND event_type = 'pos_shift.edc_reconciliation_overdue'`,
        [tenant.tenantId],
      );
    });
    const template = await newOrder();
    const paid = await payStandalone(template, {
      terminalId,
      bankRef: "X1RRN0000600",
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const tenderId = paid.body.data.tender.id as string;
    // 600 hand-keyed slips of the same shift, keyed three days ago.
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        `CREATE TEMP TABLE x1_clone ON COMMIT DROP AS
           SELECT t.* FROM pos_order_tenders t CROSS JOIN generate_series(1, 600)
           WHERE t.id = $1`,
        [tenderId],
      );
      await client.query(
        `UPDATE x1_clone SET id = gen_random_uuid(), edc_transaction_id = gen_random_uuid()`,
      );
      await client.query(
        `INSERT INTO edc_transactions
           (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
            request_fingerprint, amount_idr, method, status, type, mode, trace,
            needs_reconciliation, completed_at, created_at, updated_at)
         SELECT edc_transaction_id, tenant_id, outlet_id, $1, 'bca',
                'X1C-' || left(edc_transaction_id::text, 8) || right(edc_transaction_id::text, 8),
                'x1-clone:' || edc_transaction_id, 'fp', amount_idr, 'card', 'approved',
                'sale', 'standalone', upper(left(md5(edc_transaction_id::text), 12)), true,
                now() - interval '72 hours', now() - interval '72 hours',
                now() - interval '72 hours'
         FROM x1_clone`,
        [terminalId],
      );
      await client.query(
        `INSERT INTO pos_order_tenders SELECT * FROM x1_clone`,
      );
      // The template slip itself is the next day's: keyed 30 hours ago.
      await client.query(
        `UPDATE edc_transactions SET created_at = now() - interval '30 hours'
         WHERE id = (SELECT edc_transaction_id FROM pos_order_tenders WHERE id = $1)`,
        [tenderId],
      );
    });
    const alerts = async () =>
      (
        await owner.query<{ payload: Record<string, string> }>(
          `SELECT payload FROM notification_outbox
           WHERE tenant_id = $1 AND event_type = 'pos_shift.edc_reconciliation_overdue'
           ORDER BY payload->>'count' DESC`,
          [tenant.tenantId],
        )
      ).rows;
    for (let run = 0; run < 2; run += 1)
      await runEdcReconciliationOverdueJob(context, new Date(), {
        force: true,
      });
    const sent = await alerts();
    expect(sent.map((alert) => alert.payload.count).sort()).toEqual([
      "1",
      "600",
    ]);
    expect(new Set(sent.map((alert) => alert.payload.shiftId)).size).toBe(1);
    expect(new Set(sent.map((alert) => alert.payload.dueDate)).size).toBe(2);
  });

  it("the override must name this bill, this action and exactly the remaining amount", async () => {
    const order = await newOrder();
    const refused = async (overrideId: string) => {
      const res = await payStandalone(order, {
        terminalId,
        bankRef: "112233445577",
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

  // legend-9yw78.15: one slip is one charge on the machine. The same bank
  // reference (compared as the resolve flow does: no hyphens, upper case) never
  // pays a second bill, whoever recorded the first one.
  describe("one slip pays one bill (legend-9yw78.15)", () => {
    const slipOverride = async (order: Awaited<ReturnType<typeof newOrder>>) =>
      standaloneOverride({
        objectId: order.orderId,
        valueIdr: order.totalIdr,
      });
    const spent = async (overrideId: string) =>
      (
        await owner.query(
          `SELECT 1 FROM pos_order_approval_uses WHERE override_id = $1::uuid`,
          [ulidToUuid(overrideId)],
        )
      ).rows.length;

    it("refuses the same slip on a second bill, however it is typed", async () => {
      const first = await newOrder();
      const paid = await payStandalone(first, {
        terminalId,
        bankRef: "7788-99AB1234",
        overrideId: await slipOverride(first),
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      for (const typed of ["7788-99AB1234", "778899ab1234", "7788-99ab-1234"]) {
        const second = await newOrder();
        const overrideId = await slipOverride(second);
        const res = await payStandalone(second, {
          terminalId,
          bankRef: typed,
          overrideId,
        });
        expect(res.status, JSON.stringify([typed, res.body])).toBe(409);
        await noTender(second.orderId);
        expect(await standaloneRows(second.number)).toHaveLength(0);
        // The refusal rolled the approval back: it can pay with a real slip.
        expect(await spent(overrideId)).toBe(0);
        const other = await payStandalone(second, {
          terminalId,
          bankRef: `5566${randomUUID().replaceAll("-", "").slice(0, 8)}`,
          overrideId,
        });
        expect(other.status, JSON.stringify(other.body)).toBe(201);
      }
    });

    it("refuses a slip the card terminal already booked on another bill", async () => {
      const other = await newOrder();
      await ledgerRow({
        reference: other.number,
        amountIdr: other.totalIdr,
        status: "approved",
        rrn: "334455667788",
      });
      const order = await newOrder();
      const res = await payStandalone(order, {
        terminalId,
        bankRef: "334455667788",
        overrideId: await slipOverride(order),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      await noTender(order.orderId);
    });

    it("a declined or cancelled slip moved no money and does not block", async () => {
      for (const status of ["declined", "cancelled"]) {
        const other = await newOrder();
        const rrn = `9900${randomUUID().replaceAll("-", "").slice(0, 8)}`;
        await ledgerRow({
          reference: other.number,
          amountIdr: other.totalIdr,
          status,
          rrn,
        });
        const order = await newOrder();
        const res = await payStandalone(order, {
          terminalId,
          bankRef: rrn,
          overrideId: await slipOverride(order),
        });
        expect(res.status, JSON.stringify([status, res.body])).toBe(201);
      }
    });

    it("refuses a slip booked under another bank, on any terminal of the tenant", async () => {
      const mandiriId = randomUUID();
      await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          `INSERT INTO payment_edc_terminals
             (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
              connection, ip_address, supported_methods, status)
           VALUES ($1, $2, $3, 'mandiri', 'TID-MD', 'MID-MD', 'Test EDC', 'lan',
                   '10.0.0.9', ARRAY['card','qris'], 'active')`,
          [mandiriId, tenant.tenantId, tenant.outletId],
        ),
      );
      const first = await newOrder();
      const bankRef = "778811223344";
      const paid = await payStandalone(first, {
        terminalId,
        bankRef,
        overrideId: await slipOverride(first),
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      const second = await newOrder();
      const res = await payStandalone(second, {
        terminalId: mandiriId,
        bankRef,
        overrideId: await slipOverride(second),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      await noTender(second.orderId);
    });

    it("an override reason of a hand-keyed EDC payment never holds a card number", () => {
      const ask = (reason: string, action = "edc_standalone") =>
        createPosOverrideSchema.safeParse({
          outletId: tenant.outletId,
          action,
          valueIdr: 25_000,
          reason,
          objectType: "pos_order",
          objectId: createUlid(),
          approval: {
            method: "supervisor_pin",
            approverUserId: supervisor.userId,
            pin: PIN,
          },
        });
      for (const reason of [
        "EDC standalone, referensi bank 4111111111111111",
        "EDC standalone, referensi bank 4111 1111 1111 1111",
        "EDC standalone, referensi bank 4111-1111-1111-1111",
      ])
        expect(ask(reason).success, reason).toBe(false);
      expect(ask("EDC standalone, referensi bank 736214805192").success).toBe(
        true,
      );
      // Other actions are not touched by this rule.
      expect(ask("Struk 4111111111111111", "void").success).toBe(true);
    });

    it("two bills sent together with one slip: one is paid, one refused", async () => {
      const [a, b] = [await newOrder(), await newOrder()];
      const bankRef = "665544332211";
      const results = await Promise.all(
        [a, b].map(async (order) =>
          payStandalone(order, {
            terminalId,
            bankRef,
            overrideId: await slipOverride(order),
          }),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const { rows } = await owner.query(
        `SELECT 1 FROM edc_transactions WHERE tenant_id = $1 AND rrn = $2
           AND status = 'approved'`,
        [tenant.tenantId, bankRef],
      );
      expect(rows).toHaveLength(1);
    });
  });

  // 1273 (second opinion EDC P2): a used slip number must not lock the cafe
  // out of a real card charge. The cashier alone is refused; a supervisor can
  // let it through, and the row stays flagged and visibly marked.
  describe("a used slip number needs a supervisor (1273)", () => {
    const slipOverride = async (order: Awaited<ReturnType<typeof newOrder>>) =>
      standaloneOverride({
        objectId: order.orderId,
        valueIdr: order.totalIdr,
      });
    const spent = async (overrideId: string) =>
      (
        await owner.query(
          `SELECT 1 FROM pos_order_approval_uses WHERE override_id = $1::uuid`,
          [ulidToUuid(overrideId)],
        )
      ).rows.length;
    const slipRows = async (slip: string) =>
      (
        await owner.query<{
          reference: string;
          needs_reconciliation: boolean;
          idempotency_key: string;
          message: string | null;
        }>(
          `SELECT reference, needs_reconciliation, idempotency_key, message
           FROM edc_transactions
           WHERE tenant_id = $1 AND upper(replace(rrn, '-', '')) = $2
           ORDER BY created_at, id`,
          [tenant.tenantId, slip],
        )
      ).rows;

    it("refuses a used slip for the cashier, with or without a plain override", async () => {
      const first = await newOrder();
      const paid = await payStandalone(first, {
        terminalId,
        bankRef: "DUP1273A0001",
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      const second = await newOrder();
      const plain = await payStandalone(second, {
        terminalId,
        bankRef: "dup1273-a0001",
      });
      expect(plain.status, JSON.stringify(plain.body)).toBe(409);
      expect(plain.body.error.code).toBe("EDC_SLIP_REF_USED");
      // A supervisor approval alone is not the ask: the till must say so, and
      // the refusal leaves the approval unspent.
      const overrideId = await slipOverride(second);
      const withOverride = await payStandalone(second, {
        terminalId,
        bankRef: "DUP1273A0001",
        overrideId,
      });
      expect(withOverride.status, JSON.stringify(withOverride.body)).toBe(409);
      expect(withOverride.body.error.code).toBe("EDC_SLIP_REF_USED");
      // The ask without an approval is refused the same way.
      const askOnly = await payStandalone(second, {
        terminalId,
        bankRef: "DUP1273A0001",
        acknowledgeDuplicateSlip: true,
      });
      expect(askOnly.status, JSON.stringify(askOnly.body)).toBe(409);
      expect(askOnly.body.error.code).toBe("EDC_SLIP_REF_USED");
      expect(await spent(overrideId)).toBe(0);
      await noTender(second.orderId);
      expect(await slipRows("DUP1273A0001")).toHaveLength(1);
    });

    it("lets a used slip through with a supervisor: flagged, marked, audited", async () => {
      const first = await newOrder();
      expect(
        (await payStandalone(first, { terminalId, bankRef: "DUP1273B0002" }))
          .status,
      ).toBe(201);
      const second = await newOrder();
      const overrideId = await slipOverride(second);
      const paid = await payStandalone(second, {
        terminalId,
        bankRef: "DUP1273B0002",
        overrideId,
        acknowledgeDuplicateSlip: true,
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.data.remainingIdr).toBe(0);
      expect(await spent(overrideId)).toBe(1);
      const rows = await slipRows("DUP1273B0002");
      expect(rows.map((row) => row.needs_reconciliation)).toEqual([true, true]);
      expect(rows[0]?.idempotency_key).toBe("standalone:slip:DUP1273B0002");
      expect(rows[1]?.reference).toBe(second.number);
      expect(rows[1]?.idempotency_key).toBe(
        `standalone:slip:DUP1273B0002:dup:${overrideId}`,
      );
      expect(rows[1]?.message).toContain(first.number);
      const tender = await owner.query<{ approved_by: string; status: string }>(
        `SELECT approved_by, status FROM pos_order_tenders WHERE order_id = $1`,
        [ulidToUuid(second.orderId)],
      );
      expect(tender.rows).toEqual([
        { approved_by: supervisor.userId, status: "captured" },
      ]);
      const audit = await owner.query<{
        event: {
          actorId: string;
          maskedChanges: { after: Record<string, unknown> };
        };
      }>(
        `SELECT event FROM audit_logs
         WHERE tenant_id = $1
           AND event->>'action' = 'edc_transaction.duplicate_slip_approved'`,
        [tenant.tenantId],
      );
      const mine = audit.rows.filter(
        (row) => row.event.maskedChanges.after.orderNumber === second.number,
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]?.event.actorId).toBe(cashier.userId);
      expect(mine[0]?.event.maskedChanges.after).toMatchObject({
        approvedBy: supervisor.userId,
        overrideId,
        slipRef: "DUP1273B0002",
        firstOrderNumber: first.number,
      });
    });

    it("a wrong PIN, a missing, foreign or underqualified approval never lets it through", async () => {
      const first = await newOrder();
      expect(
        (await payStandalone(first, { terminalId, bankRef: "DUP1273C0003" }))
          .status,
      ).toBe(201);
      const second = await newOrder();
      // Wrong PIN: no approval is even created.
      const wrongPin = await cashier.client
        .post("/api/pos-overrides")
        .set(headers)
        .set(originHeader)
        .send({
          outletId: tenant.outletId,
          action: "edc_standalone",
          valueIdr: second.totalIdr,
          reason: "Slip ganda, supervisor menyetujui",
          objectType: "pos_order",
          objectId: second.orderId,
          approval: {
            method: "supervisor_pin",
            approverUserId: supervisor.userId,
            pin: "000000",
          },
        });
      expect(wrongPin.status, JSON.stringify(wrongPin.body)).toBe(401);
      // A colleague without the approve permission cannot approve.
      await expect(
        createPosOverride(
          establishTenantContext({
            tenantId: tenantIdSchema.parse(tenant.tenantId),
            brandId: null,
            source: "session",
          }),
          cashier.userId,
          {
            outletId: tenant.outletId,
            action: "edc_standalone",
            valueIdr: second.totalIdr,
            reason: "Slip ganda, supervisor menyetujui",
            objectType: "pos_order",
            objectId: second.orderId,
            approval: {
              method: "supervisor_pin",
              approverUserId: cashier.userId,
              pin: PIN,
            },
          } as Parameters<typeof createPosOverride>[2],
          { idempotencyKey: randomUUID() },
        ),
      ).rejects.toBeDefined();
      // An invented override id and one made for another bill are refused.
      const other = await newOrder();
      const foreign = await slipOverride(other);
      for (const overrideId of [createUlid(Date.now()), foreign]) {
        const res = await payStandalone(second, {
          terminalId,
          bankRef: "DUP1273C0003",
          overrideId,
          acknowledgeDuplicateSlip: true,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error.code).toBe("EDC_STANDALONE_APPROVAL_REQUIRED");
      }
      expect(await spent(foreign)).toBe(0);
      await noTender(second.orderId);
      expect(await slipRows("DUP1273C0003")).toHaveLength(1);
    });

    it("another tenant's slip number does not touch this tenant", async () => {
      const elsewhere = await createIsolatedTenant(
        `dup-${randomUUID().slice(0, 6)}`,
      );
      const otherTerminal = randomUUID();
      await asOwnerTenant(elsewhere.tenantId, async (client) => {
        await client.query(
          `INSERT INTO payment_edc_terminals
             (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
              connection, ip_address, supported_methods, status)
           VALUES ($1, $2, $3, 'bca', 'TID-DUPX', 'MID-DUPX', 'Test EDC', 'lan',
                   '10.0.0.9', ARRAY['card'], 'active')`,
          [otherTerminal, elsewhere.tenantId, elsewhere.outletId],
        );
        await client.query(
          `INSERT INTO edc_transactions
             (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
              request_fingerprint, amount_idr, method, status, type, mode, trace,
              needs_reconciliation, completed_at, rrn)
           VALUES ($1, $2, $3, $4, 'bca', 'OTHER-1', $5, 'fp', 10000, 'card',
                   'approved', 'sale', 'standalone', $6, true, now(), 'DUP1273D0004')`,
          [
            randomUUID(),
            elsewhere.tenantId,
            elsewhere.outletId,
            otherTerminal,
            "standalone:slip:DUP1273D0004",
            randomUUID().slice(0, 12),
          ],
        );
      });
      const order = await newOrder();
      const paid = await payStandalone(order, {
        terminalId,
        bankRef: "DUP1273D0004",
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      const mine = await slipRows("DUP1273D0004");
      expect(mine).toHaveLength(1);
      expect(mine[0]?.idempotency_key).toBe("standalone:slip:DUP1273D0004");
    });

    it("a retry of the approved repeat answers the same payment and books once", async () => {
      const first = await newOrder();
      expect(
        (await payStandalone(first, { terminalId, bankRef: "DUP1273E0005" }))
          .status,
      ).toBe(201);
      const second = await newOrder();
      const overrideId = await slipOverride(second);
      const standalone = {
        terminalId,
        bankRef: "DUP1273E0005",
        overrideId,
        acknowledgeDuplicateSlip: true,
      };
      const key = { idempotencyKey: randomUUID() };
      const paid = await payStandalone(second, standalone, key);
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      const again = await payStandalone(second, standalone, key);
      expect(again.status, JSON.stringify(again.body)).toBe(201);
      expect(again.body.data.tender.id).toBe(paid.body.data.tender.id);
      expect(await slipRows("DUP1273E0005")).toHaveLength(2);
      const tenders = await owner.query(
        `SELECT 1 FROM pos_order_tenders WHERE order_id = $1`,
        [ulidToUuid(second.orderId)],
      );
      expect(tenders.rows).toHaveLength(1);
    });
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
