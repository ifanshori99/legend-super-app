// legend-mrwtp (brief 985, money, "Jangan sampai rugi"): approving a manual CASH
// refund of a paid order charge must NEVER make the expected cash of the chosen
// shift negative, EVEN IF the shared guard `cashOutExceedsDrawer`
// (services/pos-cash-guard.ts) is relaxed by branch 974 to allow a negative
// drawer. The approve path carries its own floor (`amountIdr > expected` -> 409).
//
// The shared guard is replaced here by a version that never refuses (simulating
// 974): only the own floor of the manual refund can still stop the payout.
//
// Fixtures follow order-charge-review-985 (R2-M1): real POS cash sale, paid
// charge seeded with its cash_in, a small drawer (float 5.000) opened by hand.
//
// ASSUMPTIONS (brief silent; repeated in the report):
//  - Endpoints as in order-charge-review-985: request POST
//    /api/order-issue-charges/:chargeId/manual-refund {amountIdr, reason, method},
//    approve POST /api/order-issue-charge-manual-refunds/:id/approve {shiftId},
//    reject .../reject {reason}. Success is any 2xx, refusal is 409.
//  - Every test uses its own fresh drawer (own cashier, own device), so
//    results do not depend on test order.
//  - Concurrent approves: the two requests are made first (their total 10.000
//    is below the charge of 24.200), then both approved at the same time on a
//    drawer that holds 5.000: exactly one is 2xx, the other 409.

import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setDeviceOutletResolver } from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { liveExpectedCashIdr } from "../services/pos-shift-support.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

// Simulates branch 974: the shared drawer guard allows a negative drawer.
vi.mock("../services/pos-cash-guard.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../services/pos-cash-guard.ts")>();
  return {
    ...original,
    cashOutExceedsDrawer: async () => false,
  };
});

const KOPI_IDR = 25_000;
const REASON = "Tamu minta uang selisih swap dikembalikan";
const DRAWER_FLOAT = 5_000;

const CHARGE = {
  differenceIdr: 20_000,
  grossSalesIdr: 20_000,
  serviceChargeIdr: 2_000,
  pbjtIdr: 2_200,
  amountIdr: 24_200,
} as const;

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  requesterRole: randomUUID(),
  approverRole: randomUUID(),
  approveOnlyRole: randomUUID(),
  device: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let shiftId = "";
let businessDate = "";
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let requester: Member; // order.recovery.handle only
let approver: Member; // order.recovery.handle + pos.refund.approve
let approveOnly: Member; // pos.refund.approve only

// ---- Receipt numbering double (as order-charge-review-985) ---------------------

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

// ---- Fixtures ----------------------------------------------------------------

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: PoolClient) => Promise<T>,
  { replica = false }: { replica?: boolean } = {},
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    if (replica)
      await client.query("SET LOCAL session_replication_role = replica");
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

function contextOf(
  tenantId: string,
  source: "session" | "domain" = "domain",
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source,
    }),
    { kind: "tenant" },
  );
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

const deviceToken = () =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: ids.device,
  });

function pos() {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    cashier.client
      .post(`${base}${path}`)
      .set(headers)
      .set(originHeader)
      .set(DEVICE_TOKEN_HEADER, deviceToken())
      .send({ idempotencyKey: randomUUID(), ...body });
  return {
    create: (body: Record<string, unknown> = {}) =>
      send("", {
        channel: "pos",
        serviceType: "takeaway",
        items: [{ menuItemId: ids.kopi, quantity: 2, modifierIds: [] }],
        ...body,
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
  };
}

async function insertShift(input: {
  cashierId: string;
  deviceId: string;
  floatIdr: number;
}): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO pos_shifts
       (id, tenant_id, outlet_id, device_id, cashier_id, business_date, status,
        opened_at, opening_float_idr, open_key, open_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now() - interval '1 hour', $7, $8, $9)`,
    [
      id,
      tenant.tenantId,
      tenant.outletId,
      input.deviceId,
      input.cashierId,
      businessDate,
      input.floatIdr,
      randomUUID(),
      "a".repeat(64),
    ],
  );
  return id;
}

/** A fresh open shift of the main outlet (own cashier, own device) with a float. */
async function newDrawer(floatIdr: number, label: string): Promise<string> {
  const owner_ = await member(ids.cashierRole, label);
  const deviceId = randomUUID();
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId,
  });
  return insertShift({ cashierId: owner_.userId, deviceId, floatIdr });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`df985-${randomUUID().slice(0, 6)}`);
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
      "POS Kasir Uji",
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
      ids.requesterRole,
      "Peminta Refund Uji",
      ["order.view", "order.recovery.handle"],
    ],
    [
      ids.approverRole,
      "Penyetuju Refund Uji",
      ["order.view", "order.recovery.handle", "pos.refund.approve"],
    ],
    [
      ids.approveOnlyRole,
      "Penyetuju Saja Uji",
      ["order.view", "pos.refund.approve"],
    ],
  ];
  for (const [id, name, permissions] of roles)
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
  cashier = await member(ids.cashierRole, "POS Kasir");
  requester = await member(ids.requesterRole, "Peminta Refund");
  approver = await member(ids.approverRole, "Penyetuju Refund");
  approveOnly = await member(ids.approveOnlyRole, "Penyetuju Saja");
  await openPosShift(
    contextOf(tenant.tenantId, "session"),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const { rows: openShifts } = await owner.query<{
    id: string;
    business_date: string;
  }>(
    "SELECT id, business_date::text AS business_date FROM pos_shifts WHERE tenant_id = $1 AND status = 'open'",
    [tenant.tenantId],
  );
  shiftId = openShifts[0]!.id;
  businessDate = openShifts[0]!.business_date;
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
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["qr_order", "accounting"],
      integrationProviders: [],
    }),
  ]);
}, 120_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  setEdgeCredentialVerifier(null);
  setAuditWriter(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

// ---- Sale + charge builders ------------------------------------------------------

async function completedCashSale(): Promise<string> {
  const created = await pos().create();
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const orderId = created.body.data.id as string;
  let status = created.body.data.status as string;
  if (status === "draft") {
    const submitted = await pos().submit(orderId, status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  const totalIdr = created.body.data.totalIdr as number;
  const paid = await pos().cash(orderId, status, totalIdr);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const completed = await pos().complete(
    orderId,
    paid.body.data.order.status as string,
  );
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return orderId;
}

async function seedLink(totalIdr: number): Promise<string> {
  const linkId = randomUUID();
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'seed')`,
    [
      linkId,
      tenant.tenantId,
      tenant.outletId,
      randomBytes(32).toString("hex"),
      `DF-${linkId.slice(0, 8)}`,
      totalIdr,
    ],
  );
  return linkId;
}

/** The cash_in movement of the main shift that collected the charge. */
async function seedCashIn(): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO cash_movements
       (id, tenant_id, outlet_id, shift_id, type, amount_idr, reason_note, recorded_by,
        recorded_at, idempotency_key, request_fingerprint)
     VALUES ($1, $2, $3, $4, 'cash_in', $5, 'Selisih swap pesanan', $6, now(), $7, $8)`,
    [
      id,
      tenant.tenantId,
      tenant.outletId,
      shiftId,
      CHARGE.amountIdr,
      cashier.userId,
      `df-cash-${id}`,
      randomBytes(32).toString("hex"),
    ],
  );
  return id;
}

/** A paid cash charge with its own REAL swap issue (the request resolves it). */
async function seedPaidCashCharge(orderId: string): Promise<string> {
  const cashMovementId = await seedCashIn();
  const linkId = await seedLink(CHARGE.amountIdr);
  const chargeId = randomUUID();
  const issueId = randomUUID();
  await asOwnerTenant(
    tenant.tenantId,
    async (client) => {
      const { rows: items } = await client.query<{ id: string }>(
        `SELECT id FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid LIMIT 1`,
        [tenant.tenantId, ulidToUuid(orderId)],
      );
      await client.query(
        `INSERT INTO order_issues (id, tenant_id, outlet_id, order_id, order_item_id, type, reason,
           reason_note, reported_by, resolution, replacement_item_id, replacement_order_item_id,
           replacement_unit_price_idr, cost_idr, idempotency_key, status, resolved_at)
         VALUES ($1, $2, $3, $4::uuid, $5, 'unfulfillable', 'out_of_stock', 'Bahan habis, diganti menu lain',
           $6, 'swap', $7, $8, 45000, 0, $9, 'resolved', now())`,
        [
          issueId,
          tenant.tenantId,
          tenant.outletId,
          ulidToUuid(orderId),
          items[0]!.id,
          cashier.userId,
          ids.kopi,
          randomUUID(),
          `df985-issue-${randomUUID()}`,
        ],
      );
    },
    { replica: true },
  );
  await asOwnerTenant(
    tenant.tenantId,
    (client) =>
      client.query(
        `INSERT INTO order_issue_charges
           (id, tenant_id, outlet_id, order_issue_id, order_id, route, status, difference_idr,
            gross_sales_idr, service_charge_idr, pbjt_idr, amount_idr, payment_link_id,
            payment_link_token_sealed, payment_intent_id, paid_at, cash_movement_id, paid_by)
         VALUES ($1, $2, $3, $4, $5, 'qr_link', 'paid', $6, $7, $8, $9, $10, $11, 'sealed', NULL, now(), $12, $13)`,
        [
          chargeId,
          tenant.tenantId,
          tenant.outletId,
          issueId,
          ulidToUuid(orderId),
          CHARGE.differenceIdr,
          CHARGE.grossSalesIdr,
          CHARGE.serviceChargeIdr,
          CHARGE.pbjtIdr,
          CHARGE.amountIdr,
          linkId,
          cashMovementId,
          cashier.userId,
        ],
      ),
    { replica: true },
  );
  return chargeId;
}

async function saleWithCashCharge(): Promise<string> {
  return seedPaidCashCharge(await completedCashSale());
}

// ---- Observers ----------------------------------------------------------------

async function expectedCashOf(shift: string): Promise<number> {
  return withTenant(db, contextOf(tenant.tenantId, "session"), async (tx) => {
    const [row] = await tx
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shift));
    return liveExpectedCashIdr(tx, row!);
  });
}

async function movementAmounts(key: string): Promise<number[]> {
  const { rows } = await owner.query<{ amount_idr: number; type: string }>(
    `SELECT amount_idr::int AS amount_idr, type FROM cash_movements
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenant.tenantId, key],
  );
  for (const row of rows) expect(row.type).toBe("cash_out");
  return rows.map((row) => row.amount_idr);
}

async function movementCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM cash_movements WHERE tenant_id = $1",
    [tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

type ManualRow = { id: string; status: string; amount_idr: number };

async function manualRows(chargeId: string): Promise<ManualRow[]> {
  const { rows } = await owner.query<ManualRow>(
    `SELECT id, status, amount_idr::int AS amount_idr
     FROM order_issue_charge_manual_refunds
     WHERE tenant_id = $1 AND charge_id = $2 ORDER BY requested_at, id`,
    [tenant.tenantId, chargeId],
  );
  return rows;
}

async function statusOf(chargeId: string, id: string): Promise<string> {
  return (await manualRows(chargeId)).find((r) => r.id === id)!.status;
}

// ---- Manual refund endpoints -------------------------------------------------------

function requestRefund(chargeId: string, amountIdr: number) {
  return requester.client
    .post(
      `/api/order-issue-charges/${encodeURIComponent(chargeId)}/manual-refund`,
    )
    .set(headers)
    .set(originHeader)
    .send({ amountIdr, reason: REASON, method: "cash" });
}

function approveRefund(id: string, shift: string, who: Member = approver) {
  return who.client
    .post(
      `/api/order-issue-charge-manual-refunds/${encodeURIComponent(id)}/approve`,
    )
    .set(headers)
    .set(originHeader)
    .send({ shiftId: shift });
}

function rejectRefund(id: string) {
  return approver.client
    .post(
      `/api/order-issue-charge-manual-refunds/${encodeURIComponent(id)}/reject`,
    )
    .set(headers)
    .set(originHeader)
    .send({ reason: "Tamu batal minta uang kembali" });
}

function expectOk(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** Requests a manual cash refund and returns its row id (request must succeed). */
async function requested(chargeId: string, amountIdr: number): Promise<string> {
  const before = new Set((await manualRows(chargeId)).map((row) => row.id));
  expectOk(await requestRefund(chargeId, amountIdr));
  const fresh = (await manualRows(chargeId)).filter(
    (row) => !before.has(row.id),
  );
  expect(fresh).toHaveLength(1);
  return fresh[0]!.id;
}

// ============================================================================

describe("approving a manual cash refund never drives the expected cash of the shift below 0, even when the shared drawer guard allows a negative drawer", () => {
  it("R2-M1 small drawer (5.000): amount = expected passes and leaves expected 0; expected + 1 is 409 with no cash_out, the refund still requested, cash unchanged", async () => {
    const chargeId = await saleWithCashCharge();
    const drawer = await newDrawer(DRAWER_FLOAT, "Kasir Laci Lantai A");
    expect(await expectedCashOf(drawer)).toBe(DRAWER_FLOAT);

    // expected + 1: refused by the own floor of the approve path.
    const tooMuch = await requested(chargeId, DRAWER_FLOAT + 1);
    const movements = await movementCount();
    const mainDrawer = await expectedCashOf(shiftId);
    const refused = await approveRefund(tooMuch, drawer);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(await statusOf(chargeId, tooMuch)).toBe("requested");
    expect(await movementAmounts(`manual-charge-refund:${tooMuch}`)).toEqual(
      [],
    );
    expect(await movementCount()).toBe(movements);
    expect(await expectedCashOf(drawer)).toBe(DRAWER_FLOAT);
    expect(await expectedCashOf(shiftId)).toBe(mainDrawer);

    // Release the over-sized request, then pay exactly what the drawer holds.
    expectOk(await rejectRefund(tooMuch));
    const exact = await requested(chargeId, DRAWER_FLOAT);
    expectOk(await approveRefund(exact, drawer));
    expect(await statusOf(chargeId, exact)).toBe("completed");
    expect(await movementAmounts(`manual-charge-refund:${exact}`)).toEqual([
      DRAWER_FLOAT,
    ]);
    expect(await expectedCashOf(drawer)).toBe(0);

    // The drawer is empty: one more rupiah is refused, expected stays 0.
    const one = await requested(chargeId, 1);
    const empty = await approveRefund(one, drawer);
    expect(empty.status, JSON.stringify(empty.body)).toBe(409);
    expect(await statusOf(chargeId, one)).toBe("requested");
    expect(await movementAmounts(`manual-charge-refund:${one}`)).toEqual([]);
    expect(await expectedCashOf(drawer)).toBe(0);
  });

  it("R2-M1 two approvals at the same time on a drawer that holds only one of them: exactly one passes, the other is 409, expected ends at 0 and never below", async () => {
    const chargeId = await saleWithCashCharge();
    const drawer = await newDrawer(DRAWER_FLOAT, "Kasir Laci Lantai B");

    // Two requests of 5.000 each (10.000 in total is below the charge of 24.200).
    const first = await requested(chargeId, DRAWER_FLOAT);
    const second = await requested(chargeId, DRAWER_FLOAT);

    const [a, b] = await Promise.all([
      approveRefund(first, drawer, approver),
      approveRefund(second, drawer, approveOnly),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(
      statuses[0]!,
      JSON.stringify([a.body, b.body]),
    ).toBeGreaterThanOrEqual(200);
    expect(statuses[0]!, JSON.stringify([a.body, b.body])).toBeLessThan(300);
    expect(statuses[1]!, JSON.stringify([a.body, b.body])).toBe(409);

    const rows = await manualRows(chargeId);
    expect(rows.map((r) => r.status).sort()).toEqual([
      "completed",
      "requested",
    ]);
    const paid = [
      ...(await movementAmounts(`manual-charge-refund:${first}`)),
      ...(await movementAmounts(`manual-charge-refund:${second}`)),
    ];
    expect(paid).toEqual([DRAWER_FLOAT]);
    expect(await expectedCashOf(drawer)).toBe(0);
  });
});
