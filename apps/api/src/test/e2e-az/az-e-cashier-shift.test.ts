// Alur E + W (PRD §4 E "Kasir Membuka dan Menutup Shift", §4 W "Membayar di
// Kasir dengan EDC"; criteria POS-01..07, EDC-01..07), written as stories:
// actor -> action -> result, over the real Express app, Better Auth, RBAC and
// PostgreSQL with RLS, in a fresh isolated tenant (own price list and tax).
//
// Active now (already in milestone/m1): the sale, cash change, discount over
// the threshold, void, refund, linked corrections (POS-01/02/04).
// Written but skipped until the branch merges (PENDING-BRANCH):
//   ws/pos-shift       shift, blind count, variance, approval   (POS-03)
//   ws/edc-framework   EDC payment, decline, retry, 2 banks     (EDC-01..07)
//   ws/refund-approval gateway refund needs a second person     (POS-02/PAY-04)
//   ws/pos-receipt     receipt number, receipt content          (POS-06/07)
//
// Assumptions (PRD silent):
//  - The discount threshold is set in this file to 10% (the PRD says "ambang"
//    without a number); 5% passes without a supervisor, 20% needs one.
//  - A supervisor approves with their own PIN; the approver is never the
//    requester (PRD "Penyetuju selalu berbeda dari pemohon").
//  - The cashier's terminal is identified by the device token; once a shift
//    exists, cash goes into the drawer of the shift open on that device.
//  - Refused requests answer an HTTP status >= 400 (not 5xx); exact codes
//    follow the contract only where the PRD names the rule.
//  - Pending scenarios load not-yet-merged modules with dynamic imports so this
//    file still loads in m1; replace them with static imports when merging.
//  - Card online through the gateway is P1 (PRD line 223): PENDING-DECISION.
//  - No settlement/reconciliation endpoint exists on any branch (EDC-06):
//    PENDING-CARD legend-cs7 (EDC settlement).

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, userIdSchema, ulidToUuid } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../../app.ts";
import { signDeviceToken } from "../../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../../services/device-pin.service.ts";
import { setPosReceiptPort } from "../../services/pos-order-ports.ts";
import { createPosReceiptPort } from "../../services/pos-receipt.service.ts";
import { createPosOverride } from "../../services/staff-override.service.ts";
import { registerTestDevice } from "../device-seed.ts";
import { ensureBill } from "../edc-agent-bill-helper.ts";
import { agent, originHeader, signUp } from "../helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "../floor-test-helpers.ts";

const PIN = "582914";
const CASHIER_PIN = "719364";
const KOPI_IDR = 25_000;
const FLOAT_IDR = 100_000;
// 2 x Kopi Susu Rp25.000 = Rp50.000 + PBJT 10% = Rp55.000.
const SALE_IDR = 55_000;
// Not-yet-merged modules are loaded by dynamic import and have no types in m1.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const dynamicImport = (path: string): Promise<Loose> =>
  import(/* @vite-ignore */ path);

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  cashierRole: randomUUID(),
  supervisorRole: randomUUID(),
  viewerRole: randomUUID(),
  financeRole: randomUUID(),
};

type Member = {
  client: ReturnType<typeof agent>;
  userId: string;
  deviceId: string;
};
let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let cashier: Member; // terminal A, used by the m1 sale stories
let shiftCashier: Member; // terminal B, owns the shift story
let supervisor: Member;
let viewer: Member;
let finance: Member;
const devices = new Map<string, string>();

// ---- Fixtures ----------------------------------------------------------------------

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
  const deviceId = randomUUID();
  devices.set(`${tenant.tenantId}:${deviceId}`, tenant.outletId);
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId,
  });
  return { client, userId, deviceId };
}

function deviceToken(who: Member): string {
  return signDeviceToken({
    version: 1,
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: who.deviceId,
    issuedAt: Math.floor(Date.now() / 1000) - 5,
  });
}

function ctx() {
  return establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });
}

const base = () => `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos`;

function post(who: Member, path: string, body: Record<string, unknown>) {
  return who.client
    .post(`${base()}${path}`)
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(who))
    .send({ idempotencyKey: randomUUID(), ...body });
}
function get(who: Member, path: string) {
  return who.client
    .get(`${base()}${path}`)
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(who));
}

/** Cashier types the order into the POS (PRD E step 2: takeaway at the till). */
async function newOrder(who: Member = cashier, quantity = 2) {
  const created = await post(who, "/orders", {
    channel: "pos",
    serviceType: "takeaway",
    items: [{ menuItemId: ids.kopi, quantity, modifierIds: [] }],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  let status = created.body.data.status as string;
  const orderId = created.body.data.id as string;
  if (status === "draft") {
    const submitted = await post(who, `/orders/${orderId}/submit`, {
      expectedStatus: status,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    status = submitted.body.data.status as string;
  }
  return {
    orderId,
    status,
    number: created.body.data.number as string,
    totalIdr: created.body.data.totalIdr as number,
  };
}

/** Pays the order in cash and completes it. */
async function cashSale(who: Member = cashier, handedIdr = SALE_IDR + 45_000) {
  const order = await newOrder(who);
  const paid = await post(who, `/orders/${order.orderId}/tenders`, {
    method: "cash",
    receivedIdr: handedIdr,
    expectedStatus: order.status,
  });
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const done = await post(who, `/orders/${order.orderId}/complete`, {
    expectedStatus: paid.body.data.order.status,
  });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return { ...order, tender: paid.body.data.tender };
}

/** The supervisor's own tile + PIN on the terminal. */
async function pinApproval(input: {
  action: string;
  objectType?: string;
  objectId: string;
  valueIdr: number;
  requester?: Member;
  approver?: Member;
  pin?: string;
  reason?: string;
}): Promise<{ approvedBy: string; overrideId: string }> {
  const approver = input.approver ?? supervisor;
  const { override } = await createPosOverride(
    ctx(),
    (input.requester ?? cashier).userId,
    {
      outletId: tenant.outletId,
      action: input.action,
      valueIdr: input.valueIdr,
      reason: input.reason ?? "Pelanggan salah pesan",
      objectType: input.objectType ?? "order",
      objectId: input.objectId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(approver.userId),
        pin: input.pin ?? PIN,
      },
    } as unknown as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: approver.userId, overrideId: override.id };
}

const errorCode = (res: {
  body?: { error?: { code?: string }; code?: string };
}): string => String(res.body?.error?.code ?? res.body?.code ?? "");

beforeAll(async () => {
  app = createApp();
  // Voids need a receipt number; the numbering branch is ws/pos-receipt, so a
  // gapless in-memory allocator stands in for it (same as pos-order.test.ts).
  const seq = new Map<string, Loose>();
  let next = 0;
  setPosReceiptPort({
    async issueForSale(_tx: Loose, context: Loose, input: Loose) {
      const found = seq.get(input.orderId);
      if (found) return found;
      next += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? randomUUID(),
        number: `POS1-${String(next).padStart(6, "0")}`,
        sequenceNumber: next,
        status: "issued",
        issuedAt: input.at.toISOString(),
        voidedAt: null,
        voidReason: null,
        voidedBy: null,
        reprintCount: 0,
      };
      seq.set(input.orderId, receipt);
      return receipt;
    },
    async findForOrder(_tx: Loose, _c: Loose, orderId: string) {
      return seq.get(orderId) ?? null;
    },
    async voidForOrder(_tx: Loose, _c: Loose, input: Loose) {
      const found = seq.get(input.orderId);
      if (!found) return null;
      const voided = {
        ...found,
        status: "voided",
        voidedAt: input.at.toISOString(),
        voidReason: input.reason,
        voidedBy: input.voidedBy,
      };
      seq.set(input.orderId, voided);
      return voided;
    },
  } as never);

  tenant = await createIsolatedTenant(`az-e-${randomUUID().slice(0, 6)}`);
  // POS-07: a receipt is only issued for an outlet with a printed address.
  await owner.query("UPDATE outlets SET address = $2 WHERE id = $1", [
    tenant.outletId,
    "Jl. Braga 12, Bandung",
  ]);
  headers = { Host: tenant.hostname };
  setDeviceOutletResolver(
    async ({ tenantId, deviceId }) =>
      devices.get(`${tenantId}:${deviceId}`) ?? null,
  );
  const roles: [string, string, string[]][] = [
    [
      ids.cashierRole,
      "AZ Kasir",
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
      "AZ Supervisor",
      [
        "order.view",
        "pos.void.approve",
        "pos.refund.approve",
        "pos.discount.approve",
        // EDC-04: standalone EDC payment is approved by a supervisor PIN.
        "pos.edc_standalone.approve",
        "shift.cash.approve_close",
        "shift.cash.view_all",
        // PAY-04 (brief 65): a gateway refund is decided by someone holding both
        // supervisor authority and payment.reconcile, never the requester.
        "payment.reconcile",
        // The approval inbox decides the gateway refund step (platform-approval).
        "approval.inbox.view",
        "approval.request.decide",
      ],
    ],
    [ids.viewerRole, "AZ Tanpa POS", ["floor.table.view"]],
    // Finance requests gateway refunds (POST /payments/admin/refunds needs
    // payment.reconcile); the cashier path is the POS correction refund above.
    [ids.financeRole, "AZ Keuangan", ["payment.reconcile"]],
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
  cashier = await member(ids.cashierRole, "AZ Kasir A");
  shiftCashier = await member(ids.cashierRole, "AZ Kasir B");
  supervisor = await member(ids.supervisorRole, "AZ Supervisor");
  viewer = await member(ids.viewerRole, "AZ Tamu");
  finance = await member(ids.financeRole, "AZ Keuangan");
  await setStaffPin(
    ctx(),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  // Cashiers hold a PIN too, so a self-approval is refused for being a
  // self-approval (AUTH-06), not for a missing PIN.
  for (const who of [cashier, shiftCashier])
    await setStaffPin(
      ctx(),
      who.userId,
      { outletId: tenant.outletId, userId: who.userId },
      { pin: CASHIER_PIN },
    );
  await asOwnerTenant(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'AZ Kasir', 0)`,
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
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-AZ', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    // Discount threshold 10% (assumption above).
    await client.query(
      `INSERT INTO pos_approval_policies (tenant_id, outlet_id, discount_threshold_bp)
       VALUES ($1, NULL, 1000)`,
      [tenant.tenantId],
    );
  });
  // Once ws/pos-shift is merged, cash needs an open shift on the terminal. The
  // m1 sale stories open one for terminal A when the endpoint exists; in m1
  // the route is absent (the app's own "Route not found." 404) and the sale
  // needs no shift. Any other answer, including another 404, fails here.
  const opened = await post(cashier, "/shifts", { openingFloatIdr: FLOAT_IDR });
  const routeAbsent =
    opened.status === 404 &&
    errorCode(opened) === "NOT_FOUND" &&
    opened.body?.error?.message === "Route not found.";
  if (!routeAbsent)
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
});

afterAll(async () => {
  setPosReceiptPort(null);
  setDeviceOutletResolver(null);
  // Final orders and audit rows are append-only, so the isolated tenant stays
  // in the disposable database; give it a valid creator for tenant listings.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
});

// ---- Alur E, part in m1: the sale -----------------------------------------------------

describe("Alur E kasir melayani pesanan (m1)", () => {
  it("POS-01 kasir menjual takeaway, tamu bayar tunai lebih, kembalian dihitung dan pesanan selesai", async () => {
    const order = await newOrder();
    expect(order.totalIdr).toBe(SALE_IDR);
    const paid = await post(cashier, `/orders/${order.orderId}/tenders`, {
      method: "cash",
      receivedIdr: 100_000,
      expectedStatus: order.status,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(paid.body.data.tender).toMatchObject({
      method: "cash",
      amountIdr: SALE_IDR,
      receivedIdr: 100_000,
      changeIdr: 45_000,
    });
    expect(paid.body.data.remainingIdr).toBe(0);
    const done = await post(cashier, `/orders/${order.orderId}/complete`, {
      expectedStatus: paid.body.data.order.status,
    });
    expect(done.body.data.status).toBe("completed");
  });

  it("POS-01 uang tunai kurang: sisa tagihan tampil, pesanan belum lunas sampai dilunasi", async () => {
    const order = await newOrder();
    const part = await post(cashier, `/orders/${order.orderId}/tenders`, {
      method: "cash",
      receivedIdr: 20_000,
      expectedStatus: order.status,
    });
    expect(part.status, JSON.stringify(part.body)).toBe(201);
    expect(part.body.data.remainingIdr).toBe(SALE_IDR - 20_000);
    expect(part.body.data.tender.changeIdr).toBe(0);
    const early = await post(cashier, `/orders/${order.orderId}/complete`, {
      expectedStatus: part.body.data.order.status,
    });
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(early.status).toBeLessThan(500);
    const rest = await post(cashier, `/orders/${order.orderId}/tenders`, {
      method: "cash",
      receivedIdr: SALE_IDR - 20_000,
      expectedStatus: part.body.data.order.status,
    });
    expect(rest.status, JSON.stringify(rest.body)).toBe(201);
    expect(rest.body.data.remainingIdr).toBe(0);
  });

  it("POS-01 menu yang tidak dikenal ditolak dan tidak ada pesanan tersimpan", async () => {
    const before = await owner.query(
      "SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    const refused = await post(cashier, "/orders", {
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: randomUUID(), quantity: 1, modifierIds: [] }],
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    const after = await owner.query(
      "SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1",
      [tenant.tenantId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("POS-02 diskon kecil jalan tanpa supervisor; di atas ambang butuh PIN supervisor dan alasan tertulis", async () => {
    const order = await newOrder();
    const manual = (percentBp: number, extra: Record<string, unknown> = {}) =>
      post(cashier, `/orders/${order.orderId}/discounts`, {
        source: "manual",
        kind: "percent",
        percentBp,
        reason: "manager_goodwill",
        reasonNote: "Pelanggan tetap",
        ...extra,
      });

    const small = await manual(500);
    expect(small.status, JSON.stringify(small.body)).toBe(201);
    const afterSmall = small.body.data.totalIdr as number;
    expect(afterSmall).toBeLessThan(SALE_IDR);

    // 20% is above the 10% threshold: refused without a supervisor.
    const refused = await manual(2000);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(errorCode(refused)).toMatch(/APPROVAL/);
    expect(
      (await get(cashier, `/orders/${order.orderId}`)).body.data.totalIdr,
    ).toBe(afterSmall);

    // The written reason is mandatory for a manual discount.
    const noReason = await manual(500, { reasonNote: null });
    expect(noReason.status).toBeGreaterThanOrEqual(400);
    expect(noReason.status).toBeLessThan(500);
    expect(errorCode(noReason)).toBe("VALIDATION_ERROR");

    // The cashier cannot approve their own discount.
    await expect(
      pinApproval({
        action: "discount",
        objectId: order.orderId,
        valueIdr: 10_000,
        approver: cashier,
        pin: CASHIER_PIN,
      }),
    ).rejects.toMatchObject({ code: "APPROVER_IS_REQUESTER" });
    expect(
      (await get(cashier, `/orders/${order.orderId}`)).body.data.totalIdr,
    ).toBe(afterSmall);

    const approval = await pinApproval({
      action: "discount",
      objectId: order.orderId,
      valueIdr: 10_000,
    });
    const approved = await manual(2000, approval);
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.data.totalIdr).toBeLessThan(afterSmall);
    const stored = approved.body.data.discounts.find(
      (d: { approvedBy: string | null }) => d.approvedBy === supervisor.userId,
    );
    expect(stored).toMatchObject({
      reason: "manager_goodwill",
      reasonNote: "Pelanggan tetap",
    });
  });

  it("POS-02 void pesanan butuh PIN supervisor beserta alasan; tanpa itu pesanan tetap berjalan", async () => {
    const order = await newOrder();
    const body = {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal pesan",
      expectedStatus: order.status,
    };
    const unapproved = await post(cashier, `/orders/${order.orderId}/void`, {
      ...body,
      approvedBy: supervisor.userId,
      overrideId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
    });
    expect(unapproved.status).toBeGreaterThanOrEqual(400);
    expect(unapproved.status).toBeLessThan(500);
    expect(
      (await get(cashier, `/orders/${order.orderId}`)).body.data.status,
    ).toBe(order.status);

    const noReason = await post(cashier, `/orders/${order.orderId}/void`, {
      ...body,
      reasonNote: "",
      ...(await pinApproval({
        action: "void",
        objectId: order.orderId,
        valueIdr: order.totalIdr,
      })),
    });
    expect(noReason.status).toBeGreaterThanOrEqual(400);
    expect(noReason.status).toBeLessThan(500);
    expect(errorCode(noReason)).toBe("VALIDATION_ERROR");

    const approval = await pinApproval({
      action: "void",
      objectId: order.orderId,
      valueIdr: order.totalIdr,
    });
    const voided = await post(cashier, `/orders/${order.orderId}/void`, {
      ...body,
      ...approval,
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({
      status: "voided",
      voidApprovedBy: supervisor.userId,
    });
  });

  it("POS-02 POS-04 penjualan final dikoreksi lewat void tertaut yang menyimpan nomor struk, bukan dihapus", async () => {
    const sale = await cashSale();
    const body = { reason: "customer_cancelled", reasonNote: "Salah pesan" };
    // Without a valid approval nothing happens.
    const unapproved = await post(
      cashier,
      `/orders/${sale.orderId}/corrections/void`,
      {
        ...body,
        approvedBy: supervisor.userId,
        overrideId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      },
    );
    expect(unapproved.status).toBeGreaterThanOrEqual(400);
    expect(unapproved.status).toBeLessThan(500);

    const approval = await pinApproval({
      action: "void",
      objectId: sale.orderId,
      valueIdr: sale.totalIdr,
    });
    const linked = await post(
      cashier,
      `/orders/${sale.orderId}/corrections/void`,
      { ...body, ...approval },
    );
    expect(linked.status, JSON.stringify(linked.body)).toBeLessThan(300);
    expect(linked.body.data).toMatchObject({
      orderId: sale.orderId,
      amountIdr: sale.totalIdr,
      approvedBy: supervisor.userId,
    });
    expect(linked.body.data.receiptNumber).toEqual(expect.any(String));
    // The sale stays on record with its lines; the same approval is single use.
    const after = await get(cashier, `/orders/${sale.orderId}`);
    expect(after.body.data.status).toBe("completed");
    expect(after.body.data.items.length).toBeGreaterThan(0);
    const again = await post(
      cashier,
      `/orders/${sale.orderId}/corrections/void`,
      { ...body, ...approval },
    );
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it("POS-02 POS-04 refund sebagian butuh persetujuan, tidak boleh melebihi yang dibayar, dan penjualan tetap tercatat", async () => {
    const sale = await cashSale();
    const body = { reason: "quality_complaint", reasonNote: "Minuman tumpah" };

    const unapproved = await post(
      cashier,
      `/orders/${sale.orderId}/corrections/refund`,
      {
        ...body,
        amountIdr: KOPI_IDR,
        approvedBy: supervisor.userId,
        overrideId: "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      },
    );
    expect(unapproved.status).toBeGreaterThanOrEqual(400);
    expect(unapproved.status).toBeLessThan(500);

    const tooMuch = await post(
      cashier,
      `/orders/${sale.orderId}/corrections/refund`,
      {
        ...body,
        amountIdr: sale.totalIdr + 1,
        ...(await pinApproval({
          action: "refund",
          objectId: sale.orderId,
          valueIdr: sale.totalIdr + 1,
        })),
      },
    );
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect(tooMuch.status).toBeLessThan(500);

    const refunded = await post(
      cashier,
      `/orders/${sale.orderId}/corrections/refund`,
      {
        ...body,
        amountIdr: KOPI_IDR,
        ...(await pinApproval({
          action: "refund",
          objectId: sale.orderId,
          valueIdr: KOPI_IDR,
        })),
      },
    );
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
    expect(refunded.body.data).toMatchObject({
      orderId: sale.orderId,
      amountIdr: KOPI_IDR,
      reason: "quality_complaint",
      approvedBy: supervisor.userId,
    });
    expect(
      (await get(cashier, `/orders/${sale.orderId}`)).body.data.status,
    ).toBe("completed");
  });

  it("POS-04 penjualan selesai tidak bisa di-void lewat jalur biasa dan tidak bisa dihapus lewat API", async () => {
    const sale = await cashSale();
    const voided = await post(cashier, `/orders/${sale.orderId}/void`, {
      reason: "customer_cancelled",
      reasonNote: "Pelanggan batal",
      expectedStatus: "completed",
      ...(await pinApproval({
        action: "void",
        objectId: sale.orderId,
        valueIdr: sale.totalIdr,
      })),
    });
    expect(voided.status).toBeGreaterThanOrEqual(400);
    const del = await cashier.client
      .delete(`${base()}/orders/${sale.orderId}`)
      .set(headers)
      .set(originHeader);
    expect([404, 405]).toContain(del.status);
    expect(
      (await get(cashier, `/orders/${sale.orderId}`)).body.data.status,
    ).toBe("completed");
    // Even the database owner cannot edit a final sale (POS-04).
    await expect(
      asOwnerTenant((client) =>
        client.query(
          "UPDATE orders SET total_idr = 1 WHERE tenant_id = $1 AND id = $2::uuid",
          [tenant.tenantId, ulidToUuid(sale.orderId)],
        ),
      ),
    ).rejects.toThrow(/POS-04/);
  });

  it("POS-02 pengguna tanpa izin POS ditolak (403) dan tamu tanpa login mendapat 401", async () => {
    const denied = await post(viewer, "/orders", {
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: ids.kopi, quantity: 1, modifierIds: [] }],
    });
    expect(denied.status).toBe(403);
    const anonymous = await agent(app)
      .get(`${base()}/orders`)
      .set(headers)
      .set(originHeader);
    expect(anonymous.status).toBe(401);
  });
});

// ---- Alur E, shift (ws/pos-shift) -------------------------------------------------------

describe("Alur E buka dan tutup shift kasir", () => {
  const countsFor = (total: number) => {
    let rest = total;
    const lines: { denominationIdr: number; quantity: number }[] = [];
    for (const denominationIdr of [
      100_000, 50_000, 20_000, 10_000, 5_000, 1_000,
    ]) {
      const quantity = Math.floor(rest / denominationIdr);
      if (quantity > 0) lines.push({ denominationIdr, quantity });
      rest -= quantity * denominationIdr;
    }
    return lines;
  };
  const shiftCall = (
    who: Member,
    path: string,
    body: Record<string, unknown>,
  ) => post(who, `/shifts${path}`, body);

  it("POS-03 kasir buka shift dengan modal awal, jual tunai, kas masuk/keluar, hitung buta, selisih disetujui supervisor", async () => {
    // 1. open with float; a second open on the same terminal is refused.
    const opened = await shiftCall(shiftCashier, "", {
      openingFloatIdr: FLOAT_IDR,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const shiftId = opened.body.data.id as string;
    expect(opened.body.data).toMatchObject({
      status: "open",
      openingFloatIdr: FLOAT_IDR,
    });
    const twice = await shiftCall(shiftCashier, "", {
      openingFloatIdr: FLOAT_IDR,
    });
    expect(twice.status).toBeGreaterThanOrEqual(400);

    // 2. cash sale Rp55.000, then a partial cash refund Rp25.000 (supervisor PIN).
    const sale = await cashSale(shiftCashier);
    const refund = await post(
      shiftCashier,
      `/orders/${sale.orderId}/corrections/refund`,
      {
        reason: "quality_complaint",
        reasonNote: "Minuman tumpah",
        amountIdr: KOPI_IDR,
        ...(await pinApproval({
          action: "refund",
          objectId: sale.orderId,
          valueIdr: KOPI_IDR,
          requester: shiftCashier,
        })),
      },
    );
    expect(refund.status, JSON.stringify(refund.body)).toBeLessThan(300);

    // 3. cash in with a reason; a movement without a reason is refused.
    const cashIn = await shiftCall(shiftCashier, `/${shiftId}/cash-movements`, {
      type: "cash_in",
      amountIdr: 20_000,
      reasonNote: "Tambah uang kembalian",
    });
    expect(cashIn.status, JSON.stringify(cashIn.body)).toBe(201);
    const noReason = await shiftCall(
      shiftCashier,
      `/${shiftId}/cash-movements`,
      {
        type: "cash_out",
        amountIdr: 5_000,
        reasonNote: "",
      },
    );
    expect(noReason.status).toBeGreaterThanOrEqual(400);

    // 4. blind count: the cashier never sees the system figure.
    const blindReport = await get(shiftCashier, `/shifts/${shiftId}`);
    expect(blindReport.body.data.shift.expectedIdr).toBeNull();
    const leak = await shiftCall(shiftCashier, `/${shiftId}/counts`, {
      counts: countsFor(145_000),
      expectedIdr: 150_000,
    });
    expect(leak.status).toBeGreaterThanOrEqual(400);

    // Expected = 100.000 + 55.000 - 25.000 + 20.000 = 150.000; counted 145.000.
    const counted = await shiftCall(shiftCashier, `/${shiftId}/counts`, {
      counts: countsFor(145_000),
    });
    expect(counted.status, JSON.stringify(counted.body)).toBe(201);
    expect(counted.body.data.countedIdr).toBe(145_000);
    expect(counted.body.data).not.toHaveProperty("expectedIdr");
    expect(counted.body.data).not.toHaveProperty("varianceIdr");
    expect(counted.body.data.noteRequired).toBe(true);
    const countId = counted.body.data.id as string;

    // 5. closing without a valid supervisor approval is refused.
    const bad = await shiftCall(shiftCashier, `/${shiftId}/close`, {
      countId,
      varianceNote: "Uang kembalian terselip",
      approvedBy: supervisor.userId,
      approvalRequestId: randomUUID(),
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    await expect(
      pinApproval({
        action: "cash_shift_close",
        objectType: "pos_shift_count",
        objectId: countId,
        valueIdr: 5_000,
        requester: shiftCashier,
        approver: shiftCashier,
        pin: CASHIER_PIN,
      }),
    ).rejects.toMatchObject({ code: "APPROVER_IS_REQUESTER" });

    // 6. supervisor (not the cashier) approves with PIN; the shift closes.
    const approval = await pinApproval({
      action: "cash_shift_close",
      objectType: "pos_shift_count",
      objectId: countId,
      valueIdr: 5_000,
      requester: shiftCashier,
      reason: "Hitung kas akhir shift",
    });
    const closed = await shiftCall(shiftCashier, `/${shiftId}/close`, {
      countId,
      varianceNote: "Uang kembalian terselip",
      approvedBy: approval.approvedBy,
      approvalRequestId: approval.overrideId,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    // legend-4wrfd: the cashier's close answer is blind; the supervisor reads the figures.
    expect(closed.body.data).toMatchObject({
      status: "closed",
      expectedIdr: null,
      countedIdr: 145_000,
      varianceIdr: null,
      approvedBy: supervisor.userId,
    });

    // 7. after approval the difference cannot be hidden or changed.
    const recount = await shiftCall(shiftCashier, `/${shiftId}/counts`, {
      counts: countsFor(150_000),
    });
    expect(recount.status).toBeGreaterThanOrEqual(400);
    const closeAgain = await shiftCall(shiftCashier, `/${shiftId}/close`, {
      countId,
      varianceNote: "Diubah",
      approvedBy: approval.approvedBy,
      approvalRequestId: approval.overrideId,
    });
    expect(closeAgain.status).toBeGreaterThanOrEqual(400);
    const report = await get(supervisor, `/shifts/${shiftId}`);
    expect(report.body.data.shift).toMatchObject({
      status: "closed",
      expectedIdr: 150_000,
      countedIdr: 145_000,
      varianceIdr: -5_000,
    });
    expect(report.body.data.movements).toHaveLength(1);
  });

  it("POS-03 kas pas: shift tutup tanpa selisih", async () => {
    const cashierC = await member(ids.cashierRole, "AZ Kasir C");
    const opened = await shiftCall(cashierC, "", {
      openingFloatIdr: FLOAT_IDR,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const shiftId = opened.body.data.id as string;
    const counted = await shiftCall(cashierC, `/${shiftId}/counts`, {
      counts: countsFor(FLOAT_IDR),
    });
    expect(counted.body.data.noteRequired).toBe(false);
    const approval = await pinApproval({
      action: "cash_shift_close",
      objectType: "pos_shift_count",
      objectId: counted.body.data.id,
      valueIdr: 0,
      requester: cashierC,
      reason: "Hitung kas akhir shift",
    });
    const closed = await shiftCall(cashierC, `/${shiftId}/close`, {
      countId: counted.body.data.id,
      approvedBy: approval.approvedBy,
      approvalRequestId: approval.overrideId,
    });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.data.varianceIdr).toBeNull();
    const report = await get(supervisor, `/shifts/${shiftId}`);
    expect(report.body.data.shift).toMatchObject({
      status: "closed",
      expectedIdr: FLOAT_IDR,
      varianceIdr: 0,
    });
  });

  it("POS-03 kasir tanpa izin shift ditolak membuka shift", async () => {
    const denied = await shiftCall(viewer, "", { openingFloatIdr: FLOAT_IDR });
    expect(denied.status).toBe(403);
  });
});

// ---- Alur W, EDC (ws/edc-framework) -----------------------------------------------------

describe("Alur W bayar di kasir dengan EDC", () => {
  async function edcFixture() {
    const { createEdcAgent } = await dynamicImport("../../edge/edc/agent.ts");
    const { EdcProviderRegistry } = await dynamicImport(
      "../../edge/edc/registry.ts",
    );
    const { EcrSimulator } = await dynamicImport("../../edge/edc/simulator.ts");
    const { db } = await dynamicImport("../../db/index.ts");
    const { establishScopedTenantContext } = await dynamicImport(
      "@starter/shared/core/server",
    );
    const registry = new EdcProviderRegistry();
    const sims: Record<string, Loose> = {};
    const terminals: Record<string, string> = {};
    for (const bank of ["bca", "mandiri"]) {
      sims[bank] = new EcrSimulator(bank);
      registry.register(sims[bank]);
      const id = randomUUID();
      terminals[bank] = id;
      await asOwnerTenant((client) =>
        client.query(
          `INSERT INTO payment_edc_terminals
             (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
              connection, ip_address, supported_methods, status)
           VALUES ($1, $2, $3, $4, $5, 'MID-AZ', 'Test EDC', 'lan', '10.0.0.5', $6, 'active')`,
          [
            id,
            tenant.tenantId,
            tenant.outletId,
            bank,
            `TID-${id.slice(0, 8)}`,
            ["card", "qris"],
          ],
        ),
      );
    }
    const scoped = establishScopedTenantContext(ctx(), {
      kind: "outlets",
      outletIds: [tenant.outletId],
    });
    const edc = createEdcAgent({
      db,
      registry,
      saleTimeoutMs: 50,
      inquiryTimeoutMs: 50,
      cancelTimeoutMs: 50,
    });
    await edc.start(scoped);
    const charge = (
      bank: string,
      reference: string,
      amountIdr: number,
      method = "card",
    ) =>
      edc.requestPayment(scoped, cashier.userId, {
        tenantId: tenant.tenantId,
        outletId: tenant.outletId,
        terminalId: terminals[bank],
        reference,
        idempotencyKey: randomUUID(),
        amountIdr,
        method,
      });
    return { edc, scoped, sims, terminals, charge };
  }

  // writeAhead only starts a sale for a real, payable bill of exactly the
  // amount still owed (EDC_AMOUNT_MISMATCH otherwise).
  const billFor = (reference: string, amountIdr: number) =>
    ensureBill(owner, {
      tenantId: tenant.tenantId,
      outletId: tenant.outletId,
      reference,
      amountIdr,
    });

  // legend-dahk: the EDC tender port is wired in apps/api/src/app.ts.
  it("EDC-01 EDC-02 kartu disetujui: nominal sama dengan tagihan, tercatat lunas dengan approval code", async () => {
    const f = await edcFixture();
    try {
      const order = await newOrder();
      const tx = await f.charge("bca", order.number, order.totalIdr);
      expect(tx.status).toBe("approved");
      expect(tx.amountIdr).toBe(order.totalIdr);
      expect(tx.approvalCode).toBeTruthy();
      const paid = await post(cashier, `/orders/${order.orderId}/tenders`, {
        method: "edc_card",
        edcTransactionId: tx.id,
        reference: tx.approvalCode,
        expectedStatus: order.status,
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.data.tender).toMatchObject({
        method: "edc_card",
        amountIdr: order.totalIdr,
        status: "captured",
        // The tender keeps the bank's RRN (pos-edc-tender.ts); the approval
        // code stays on the EDC transaction.
        reference: tx.rrn,
      });
      expect(paid.body.data.remainingIdr).toBe(0);
    } finally {
      await f.edc.stop(f.scoped);
    }
  });

  // legend-dahk: an unwired port (503) must not satisfy the refusal check.
  it("EDC-02 kartu ditolak tidak pernah tercatat lunas; kasir lanjut dengan tunai", async () => {
    const f = await edcFixture();
    try {
      const order = await newOrder();
      f.sims.bca.next(f.terminals.bca, "decline");
      const tx = await f.charge("bca", order.number, order.totalIdr);
      expect(tx.status).toBe("declined");
      const attempt = await post(cashier, `/orders/${order.orderId}/tenders`, {
        method: "edc_card",
        edcTransactionId: tx.id,
        reference: "DECLINED",
        expectedStatus: order.status,
      });
      // Refused because the bank declined, not for any other reason.
      expect(attempt.status, JSON.stringify(attempt.body)).toBe(409);
      expect(attempt.body.error.message).toContain("belum disetujui bank");
      const unpaid = await get(cashier, `/orders/${order.orderId}`);
      expect(unpaid.body.data.status).not.toBe("completed");
      const cash = await post(cashier, `/orders/${order.orderId}/tenders`, {
        method: "cash",
        receivedIdr: order.totalIdr,
        expectedStatus: order.status,
      });
      expect(cash.status, JSON.stringify(cash.body)).toBe(201);
      expect(cash.body.data.remainingIdr).toBe(0);
    } finally {
      await f.edc.stop(f.scoped);
    }
  });

  it("EDC-03 koneksi putus setelah kartu tergesek: ulangi bayar tidak menagih dua kali", async () => {
    const f = await edcFixture();
    try {
      const order = await newOrder();
      const reference = order.number;
      f.sims.bca.next(f.terminals.bca, "timeout_after_charge");
      const first = await f.charge("bca", reference, order.totalIdr);
      expect(first.status).toBe("unknown");
      await expect(
        f.charge("bca", reference, order.totalIdr),
      ).rejects.toMatchObject({
        reason: "EDC_ALREADY_APPROVED",
      });
      expect(f.sims.bca.chargedCount(f.terminals.bca)).toBe(1);
    } finally {
      await f.edc.stop(f.scoped);
    }
  });

  // legend-m4fv: `edc_standalone` override (pos.edc_standalone.approve).
  // X1 (838260a54, legend-wasr7.10): manual EDC is the normal path; the slip
  // reference is required, the supervisor PIN is optional, and every entry is
  // flagged for the H+1 reconciliation.
  it("EDC-04 mode standalone tanpa nomor referensi ditolak; tanpa PIN supervisor dicatat untuk rekonsiliasi", async () => {
    // The fixture only supplies registered terminals; the agent is not used.
    const f = await edcFixture();
    try {
      const terminalId = f.terminals.bca;
      const order = await newOrder();
      const url = `/orders/${order.orderId}/tenders`;
      const bankRef = `MANUAL-${randomUUID().slice(0, 8)}`;
      const noRef = await post(cashier, url, {
        method: "edc_card",
        expectedStatus: order.status,
        standalone: { terminalId },
      });
      expect(noRef.status, JSON.stringify(noRef.body)).toBe(422);
      expect(
        (await get(cashier, `/orders/${order.orderId}`)).body.data.status,
      ).not.toBe("completed");

      // Reference without a PIN: booked at the remaining bill with no
      // approver, flagged for reconciliation.
      const noApprover = await post(cashier, url, {
        method: "edc_card",
        expectedStatus: order.status,
        standalone: { terminalId, bankRef },
      });
      expect(noApprover.status, JSON.stringify(noApprover.body)).toBe(201);
      expect(noApprover.body.data.tender).toMatchObject({
        method: "edc_card",
        amountIdr: order.totalIdr,
        status: "captured",
        approvedBy: null,
      });
      expect(noApprover.body.data.remainingIdr).toBe(0);
      const manual = await owner.query(
        `SELECT mode, rrn, needs_reconciliation FROM edc_transactions
         WHERE tenant_id = $1 AND reference = $2`,
        [tenant.tenantId, order.number],
      );
      expect(manual.rows).toEqual([
        { mode: "standalone", rrn: bankRef, needs_reconciliation: true },
      ]);

      // Supervisor PIN + reference on another bill: booked with the
      // supervisor as approver, flagged for reconciliation too.
      const second = await newOrder();
      const secondRef = `MANUAL-${randomUUID().slice(0, 8)}`;
      const approval = await pinApproval({
        action: "edc_standalone",
        objectType: "pos_order",
        objectId: second.orderId,
        valueIdr: second.totalIdr,
      });
      const paid = await post(cashier, `/orders/${second.orderId}/tenders`, {
        method: "edc_card",
        expectedStatus: second.status,
        standalone: {
          terminalId,
          bankRef: secondRef,
          overrideId: approval.overrideId,
        },
      });
      expect(paid.status, JSON.stringify(paid.body)).toBe(201);
      expect(paid.body.data.tender).toMatchObject({
        method: "edc_card",
        amountIdr: second.totalIdr,
        status: "captured",
        approvedBy: supervisor.userId,
      });
      expect(paid.body.data.remainingIdr).toBe(0);
      const flagged = await owner.query(
        `SELECT mode, rrn, needs_reconciliation FROM edc_transactions
         WHERE tenant_id = $1 AND reference = $2`,
        [tenant.tenantId, second.number],
      );
      expect(flagged.rows).toEqual([
        { mode: "standalone", rrn: secondRef, needs_reconciliation: true },
      ]);
    } finally {
      await f.edc.stop(f.scoped);
    }
  });

  it("EDC-07 dua bank aktif bersamaan di satu outlet menerima transaksi masing-masing", async () => {
    const f = await edcFixture();
    try {
      const refA = `BILL-${randomUUID().slice(0, 8)}`;
      const refB = `BILL-${randomUUID().slice(0, 8)}`;
      await billFor(refA, 40_000);
      await billFor(refB, 15_000);
      const a = await f.charge("bca", refA, 40_000);
      const b = await f.charge("mandiri", refB, 15_000, "qris");
      expect(a).toMatchObject({ status: "approved", bank: "bca" });
      expect(b).toMatchObject({ status: "approved", bank: "mandiri" });
    } finally {
      await f.edc.stop(f.scoped);
    }
  });

  it("EDC transaksi disetujui menulis event ke outbox edge dalam transaksi yang sama, belum terkirim", async () => {
    const f = await edcFixture();
    try {
      const reference = `BILL-${randomUUID().slice(0, 8)}`;
      await billFor(reference, 30_000);
      const tx = await f.charge("bca", reference, 30_000);
      const { rows } = await owner.query(
        `SELECT event->>'name' AS name, status FROM domain_event_outbox
         WHERE tenant_id = $1 AND event->'payload'->>'transactionId' = $2`,
        [tenant.tenantId, tx.id],
      );
      expect(rows.map((r) => r.name)).toContain("edc_transaction.approved");
      // Nothing relays it in this test: the record waits on the edge node.
      expect(rows.every((r) => r.status !== "delivered")).toBe(true);
    } finally {
      await f.edc.stop(f.scoped);
    }
  });

  // PENDING-DECISION edc-offline-sync: ws/edc-framework only writes the
  // outbox row; it has no way to cut the cafe internet and relay after it
  // returns. EDC-05 (offline, then synced) needs that harness, so the ID is
  // not claimed by the test above.
  it.skip("[PENDING-DECISION edc-offline-sync] EDC-05 internet cafe diputus: pembayaran EDC tercatat di edge node dan tersinkron setelah koneksi pulih", () => {});
});

describe("Alur W EDC-06 settlement", () => {
  // PENDING-CARD legend-cs7 (settlement engine): no branch delivers the end-of-day batch
  // trigger or the per-bank settlement report reconciled against POS (PRD W
  // step 6, EDC-06). Expected: closing the day triggers a batch per bank and
  // every difference becomes a reconciliation case.
  it.skip("[PENDING-CARD legend-cs7] EDC-06 laporan settlement setiap bank cocok dengan transaksi POS, selisih menjadi kasus rekonsiliasi", () => {});
  // PENDING-DECISION card-online: online card through the gateway is P1.
  it.skip("[PENDING-DECISION card-online] kartu online lewat gateway (P1)", () => {});
});

// ---- Refund through the gateway (ws/refund-approval) --------------------------------------

describe("Alur E refund pembayaran gateway butuh orang kedua", () => {
  it("POS-02 PAY-04 refund QRIS: pemohon tidak bisa menyetujui sendiri, orang kedua menyetujui, dana keluar sekali", async () => {
    const { FakeRefundGateway } = await dynamicImport(
      "../refund-fake-gateway.ts",
    );
    const { setPaymentRefundGateway } = await dynamicImport(
      "../../services/payment-refund-gateway.ts",
    );
    const fake = new FakeRefundGateway();
    setPaymentRefundGateway(fake);
    try {
      // Matriks Approval (brief 65): this isolated tenant has no refund row yet;
      // one level, decided by the supervisor role, never the requester.
      await owner.query(
        `INSERT INTO approval_policies (tenant_id, action_type, threshold_idr, approver_role_id, levels)
         VALUES ($1, 'refund', NULL, $2, 1)`,
        [tenant.tenantId, ids.supervisorRole],
      );
      // A QRIS bill already paid (settled) in the isolated tenant.
      const linkId = randomUUID();
      const intentId = randomUUID();
      await asOwnerTenant(async (client) => {
        await client.query(
          `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
           VALUES ($1, $2, $3, $4, $5, 55000, 55000, 55000, $6)`,
          [
            linkId,
            tenant.tenantId,
            tenant.outletId,
            randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
            `AZE-${linkId.slice(0, 8)}`,
            supervisor.userId,
          ],
        );
        await client.query(
          `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at)
           VALUES ($1, $2, $3, $4, 'qris', 'doit', 55000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now())`,
          [
            intentId,
            tenant.tenantId,
            tenant.outletId,
            linkId,
            `aze-${intentId}`,
          ],
        );
        await client.query(
          `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
           VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 55000, now())`,
          [tenant.tenantId, tenant.outletId, intentId, `evidence-${intentId}`],
        );
      });
      const ADMIN = "/api/payments/admin";
      const requested = await finance.client
        .post(`${ADMIN}/refunds`)
        .set(headers)
        .set(originHeader)
        .send({
          idempotencyKey: randomUUID(),
          paymentIntentId: intentId,
          amountIdr: 25_000,
          reason: "Pelanggan mengembalikan pesanan",
        });
      expect(requested.status, JSON.stringify(requested.body)).toBe(201);
      expect(requested.body.data.status).toBe("pending");
      expect(fake.calls).toHaveLength(0);
      const refundId = requested.body.data.id as string;
      const selfApprove = await finance.client
        .post(`${ADMIN}/refunds/${refundId}/approve`)
        .set(headers)
        .set(originHeader)
        .send({ idempotencyKey: randomUUID() });
      expect(selfApprove.status).toBe(403);
      expect(selfApprove.body.error.code).toBe("APPROVER_IS_REQUESTER");
      expect(fake.calls).toHaveLength(0);
      const approved = await supervisor.client
        .post(`${ADMIN}/refunds/${refundId}/approve`)
        .set(headers)
        .set(originHeader)
        .send({ idempotencyKey: randomUUID() });
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(approved.body.data).toMatchObject({
        status: "completed",
        amountIdr: 25_000,
      });
      expect(fake.calls).toHaveLength(1);
    } finally {
      setPaymentRefundGateway(null);
    }
  });
});

// ---- Receipt (ws/pos-receipt) ----------------------------------------------------------------

describe("Alur E struk setelah penjualan", () => {
  it("POS-06 POS-07 nomor struk berurutan tanpa celah, struk void tetap bernomor, struk memuat outlet, item, pajak, metode bayar", async () => {
    setPosReceiptPort(createPosReceiptPort()); // real numbering from ws/pos-receipt
    const first = await cashSale();
    const second = await cashSale();
    const issue = (orderId: string) =>
      post(cashier, `/orders/${orderId}/receipts`, { deliveries: ["print"] });
    const r1 = await issue(first.orderId);
    const r2 = await issue(second.orderId);
    // The number is allocated with the order; this call issues or reprints
    // its deliveries and answers 200 (pos-receipt.routes.ts).
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.data.receipt.sequenceNumber).toBe(
      r1.body.data.receipt.sequenceNumber + 1,
    );

    // POS-07: outlet name and address, lines, tax, payment method.
    const doc = r1.body.data.document;
    expect(doc.outletName.length).toBeGreaterThan(0);
    expect(doc.outletAddress.length).toBeGreaterThanOrEqual(10);
    expect(doc.items.length).toBeGreaterThan(0);
    expect(doc.taxLines.length).toBeGreaterThan(0);
    expect(doc.tenders.map((t: { method: string }) => t.method)).toContain(
      "cash",
    );

    // POS-06: a voided sale keeps its receipt number.
    const approval = await pinApproval({
      action: "void",
      objectId: first.orderId,
      valueIdr: first.totalIdr,
    });
    const voided = await post(
      cashier,
      `/orders/${first.orderId}/corrections/void`,
      {
        reason: "customer_cancelled",
        reasonNote: "Salah pesan",
        ...approval,
      },
    );
    expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);
    expect(voided.body.data.receiptNumber).toBe(r1.body.data.receipt.number);
    const byNumber = await get(
      cashier,
      `/receipts/by-number/${encodeURIComponent(r1.body.data.receipt.number)}`,
    );
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.data.receipt.status).toBe("voided");
  });
});
