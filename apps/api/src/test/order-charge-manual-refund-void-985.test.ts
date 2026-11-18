// legend-mrwtp + legend-v5z4h (brief 985, money, "Jangan sampai rugi"): voiding a
// POS order whose swap charge was paid in cash, together with MANUAL refunds of
// that charge (request/approve endpoints of order-charge-manual-refund-985).
//
// Invariant: manual refund (requested or completed) + the cash returned by the
// void NEVER add up to more than the charge value, also when they race.
//
// Fixture = order-charge-void-982-s61sg (real POS cash sale, real void route,
// the paid cash charge is seeded with its cash_in on the open shift). Accounting
// is not needed here; journals are covered in order-charge-manual-refund-985.
//
// ASSUMPTIONS (design card of brief 985; adjust here if the engineer differs):
//  - Request: POST /api/order-issue-charges/:chargeId/manual-refund
//    { amountIdr, reason, method: "cash" }; approve: POST
//    /api/order-issue-charge-manual-refunds/:id/approve { shiftId };
//    reject: .../reject { reason }. Ids are read from the table
//    `order_issue_charge_manual_refunds`.
//  - Cash return of the void is the cash_out `void-charge:<chargeId>`; a manual
//    cash refund is the cash_out `manual-charge-refund:<id>`.
//  - Void with a `requested` manual refund hanging: 409, nothing changes.
//  - Void after the charge was fully refunded by hand: 2xx, no new cash_out,
//    the charge is `voided` (card v5z4h).
//  - "Money came back" is measured on the drawer against a control void of an
//    identical sale WITHOUT a charge (as s61sg), so it does not depend on how
//    the void books the sale part.

import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
import type { PosReceipt } from "@starter/shared/pos";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { posShifts } from "../db/schema/pos-shift.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { liveExpectedCashIdr } from "../services/pos-shift-support.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { setEdgeCredentialVerifier } from "../services/staff-pin-sync.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";

const PIN = "582914";
const KOPI_IDR = 25_000;
const REASON = "Tamu minta uang selisih swap dikembalikan";

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
  supervisorRole: randomUUID(),
  requesterRole: randomUUID(),
  approverRole: randomUUID(),
  device: randomUUID(),
};

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let shiftId = "";
type Member = { client: ReturnType<typeof agent>; userId: string };
let cashier: Member;
let supervisor: Member;
let requester: Member;
let approver: Member;

// ---- Receipt numbering double (as s61sg) ---------------------------------------

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

function pos(who: Member = cashier, outletId = tenant.outletId) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
  const send = (path: string, body: Record<string, unknown>) =>
    who.client
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
    complete: (orderId: string, expectedStatus: string) =>
      send(`/${orderId}/complete`, { expectedStatus }),
    correctionVoid: (orderId: string, body: Record<string, unknown>) =>
      send(`/${orderId}/corrections/void`, body),
  };
}

async function pinApproval(input: {
  action: "void" | "refund";
  orderId: string;
  valueIdr: number;
}): Promise<{ approvedBy: string; overrideId: string }> {
  const { override } = await createPosOverride(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    }),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action: input.action,
      valueIdr: input.valueIdr,
      reason: "Pelanggan salah pesan",
      objectType: "order",
      objectId: input.orderId,
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

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  tenant = await createIsolatedTenant(`mv985-${randomUUID().slice(0, 6)}`);
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
      ids.supervisorRole,
      "POS Supervisor Uji",
      ["order.view", "pos.void.approve", "pos.refund.approve"],
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
  cashier = await member(ids.cashierRole, "POS Kasir");
  supervisor = await member(ids.supervisorRole, "POS Supervisor");
  requester = await member(ids.requesterRole, "Peminta Refund");
  approver = await member(ids.approverRole, "Penyetuju Refund");
  await openPosShift(
    contextOf(tenant.tenantId, "session"),
    { userId: userIdSchema.parse(cashier.userId), deviceId: ids.device },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  const { rows: openShifts } = await owner.query<{ id: string }>(
    "SELECT id FROM pos_shifts WHERE tenant_id = $1 AND status = 'open'",
    [tenant.tenantId],
  );
  shiftId = openShifts[0]!.id;
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
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-POS', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
  });
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

// ---- Sale + charge builders (as s61sg) --------------------------------------------

type Sale = { orderId: string; totalIdr: number };

async function completedCashSale(): Promise<Sale> {
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
  return { orderId, totalIdr };
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
      `V9-${linkId.slice(0, 8)}`,
      totalIdr,
    ],
  );
  return linkId;
}

/** The cash_in movement of the open shift that collected the charge. */
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
      `v9-cash-${id}`,
      randomBytes(32).toString("hex"),
    ],
  );
  return id;
}

/** A paid cash charge with its own seeded swap issue (cross foreign keys skipped). */
async function seedPaidCashCharge(
  orderId: string,
  cashMovementId: string,
  linkId: string,
): Promise<string> {
  const chargeId = randomUUID();
  const issueId = randomUUID();
  // The manual-refund request (not the void) resolves the charge through its
  // swap issue (the refund event is keyed by the issue), so the issue must be a
  // real row: a charge with a dangling order_issue_id is "not found" (404).
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
          `mv985-issue-${randomUUID()}`,
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

async function saleWithCashCharge() {
  const sale = await completedCashSale();
  const cashMovementId = await seedCashIn();
  const linkId = await seedLink(CHARGE.amountIdr);
  const chargeId = await seedPaidCashCharge(
    sale.orderId,
    cashMovementId,
    linkId,
  );
  return { ...sale, chargeId, cashMovementId };
}

// ---- Observers -----------------------------------------------------------------

async function drawerCash(): Promise<number> {
  return withTenant(db, contextOf(tenant.tenantId, "session"), async (tx) => {
    const [shift] = await tx
      .select()
      .from(posShifts)
      .where(eq(posShifts.id, shiftId));
    return liveExpectedCashIdr(tx, shift!);
  });
}

async function chargeStatus(chargeId: string): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM order_issue_charges WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, chargeId],
  );
  return rows[0]!.status;
}

async function voidRowCount(orderId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_voids
     WHERE tenant_id = $1 AND order_id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return Number(rows[0]?.count);
}

async function approvalUses(overrideId: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pos_order_approval_uses
     WHERE override_id = $1::uuid`,
    [ulidToUuid(overrideId)],
  );
  return Number(rows[0]?.count);
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

/** Every rupiah the till gave back for this charge: void part + completed manual refunds. */
async function returnedOf(chargeId: string): Promise<number> {
  let total = 0;
  for (const amount of await movementAmounts(`void-charge:${chargeId}`))
    total += amount;
  for (const row of await manualRows(chargeId))
    if (row.status === "completed")
      for (const amount of await movementAmounts(
        `manual-charge-refund:${row.id}`,
      ))
        total += amount;
  return total;
}

async function voidOrder(sale: Sale) {
  const approval = await pinApproval({
    action: "void",
    orderId: sale.orderId,
    valueIdr: sale.totalIdr,
  });
  const response = await pos().correctionVoid(sale.orderId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan salah pesan",
    ...approval,
  });
  return { response, approval };
}

/** What a void of a plain cash sale does to the drawer: the control. */
async function controlVoidDelta(): Promise<number> {
  const before = await drawerCash();
  const sale = await completedCashSale();
  const { response } = await voidOrder(sale);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return (await drawerCash()) - before;
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

function approveRefund(id: string) {
  return approver.client
    .post(
      `/api/order-issue-charge-manual-refunds/${encodeURIComponent(id)}/approve`,
    )
    .set(headers)
    .set(originHeader)
    .send({ shiftId });
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

const isOk = (res: { status: number }) => res.status >= 200 && res.status < 300;
function expectOk(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** Requests and (optionally) approves a manual cash refund; returns the row id. */
async function manualRefund(
  chargeId: string,
  amountIdr: number,
  { approve }: { approve: boolean },
): Promise<string> {
  const before = new Set((await manualRows(chargeId)).map((row) => row.id));
  expectOk(await requestRefund(chargeId, amountIdr));
  const fresh = (await manualRows(chargeId)).filter(
    (row) => !before.has(row.id),
  );
  expect(fresh).toHaveLength(1);
  if (approve) expectOk(await approveRefund(fresh[0]!.id));
  return fresh[0]!.id;
}

// ============================================================================

describe("legend-mrwtp void of an order whose cash charge was refunded by hand", () => {
  it("MRV-1 partly refunded by hand (3.000): the void returns only the rest, the charge is returned exactly once in total, drawer like a charge-less void", async () => {
    const control = await controlVoidDelta();
    const before = await drawerCash();
    const sale = await saleWithCashCharge();
    const refundId = await manualRefund(sale.chargeId, 3_000, {
      approve: true,
    });
    expect(await movementAmounts(`manual-charge-refund:${refundId}`)).toEqual([
      3_000,
    ]);

    const { response, approval } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(await voidRowCount(sale.orderId)).toBe(1);
    expect(await approvalUses(approval.overrideId)).toBe(1);

    expect(await movementAmounts(`void-charge:${sale.chargeId}`)).toEqual([
      CHARGE.amountIdr - 3_000,
    ]);
    expect(await returnedOf(sale.chargeId)).toBe(CHARGE.amountIdr);
    expect(await chargeStatus(sale.chargeId)).not.toBe("paid");
    expect((await drawerCash()) - before).toBe(control);
  });

  it("MRV-2 fully refunded by hand: the void adds no cash_out for the charge, the charge is voided, the drawer is exactly like a charge-less void", async () => {
    const control = await controlVoidDelta();
    const before = await drawerCash();
    const sale = await saleWithCashCharge();
    await manualRefund(sale.chargeId, CHARGE.amountIdr, { approve: true });

    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);

    expect(await movementAmounts(`void-charge:${sale.chargeId}`)).toEqual([]);
    expect(await returnedOf(sale.chargeId)).toBe(CHARGE.amountIdr);
    expect(await chargeStatus(sale.chargeId)).toBe("voided");
    expect((await drawerCash()) - before).toBe(control);
  });

  it("MRV-3 a manual refund still waiting for approval blocks the void: 409, order stays completed, no void row, approval unused, drawer and charge untouched; after reject the void goes through", async () => {
    const control = await controlVoidDelta();
    const before = await drawerCash();
    const sale = await saleWithCashCharge();
    const refundId = await manualRefund(sale.chargeId, 5_000, {
      approve: false,
    });
    const drawer = await drawerCash();

    const blocked = await voidOrder(sale);
    expect(blocked.response.status, JSON.stringify(blocked.response.body)).toBe(
      409,
    );
    expect(await voidRowCount(sale.orderId)).toBe(0);
    expect(await approvalUses(blocked.approval.overrideId)).toBe(0);
    expect((await pos().get(sale.orderId)).body.data.status).toBe("completed");
    expect(await chargeStatus(sale.chargeId)).toBe("paid");
    expect((await manualRows(sale.chargeId))[0]!.status).toBe("requested");
    expect(await drawerCash()).toBe(drawer);

    expectOk(await rejectRefund(refundId));
    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    expect(await movementAmounts(`void-charge:${sale.chargeId}`)).toEqual([
      CHARGE.amountIdr,
    ]);
    expect(await returnedOf(sale.chargeId)).toBe(CHARGE.amountIdr);
    expect((await drawerCash()) - before).toBe(control);
  });

  it("MRV-4 after the void the charge is no longer paid: a manual refund request is 409 and nothing more is paid out", async () => {
    const sale = await saleWithCashCharge();
    const { response } = await voidOrder(sale);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    const drawer = await drawerCash();
    const returned = await returnedOf(sale.chargeId);
    expect(returned).toBe(CHARGE.amountIdr);

    const res = await requestRefund(sale.chargeId, 1_000);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await manualRows(sale.chargeId)).toHaveLength(0);
    expect(await returnedOf(sale.chargeId)).toBe(CHARGE.amountIdr);
    expect(await drawerCash()).toBe(drawer);
  });

  it("MRV-5 a full manual refund approved (cash_out paid), a second void-time return is impossible: re-voiding or requesting more never returns the charge twice", async () => {
    const sale = await saleWithCashCharge();
    await manualRefund(sale.chargeId, CHARGE.amountIdr, { approve: true });
    const more = await requestRefund(sale.chargeId, 1);
    expect([409, 422]).toContain(more.status);

    const first = await voidOrder(sale);
    expect(
      first.response.status,
      JSON.stringify(first.response.body),
    ).toBeLessThan(300);
    const again = await voidOrder(sale);
    expect(again.response.status).toBeGreaterThanOrEqual(400);

    expect(await returnedOf(sale.chargeId)).toBe(CHARGE.amountIdr);
    expect(await voidRowCount(sale.orderId)).toBe(1);
  });
});

describe("legend-mrwtp void and manual refund racing for the same charge", () => {
  it("MRV-6 void at the same time as a full manual request: the till never gives back more than the charge, and the drawer never drops below a charge-less void", async () => {
    const control = await controlVoidDelta();
    const before = await drawerCash();
    const sale = await saleWithCashCharge();

    const [voided, requested] = await Promise.all([
      voidOrder(sale),
      requestRefund(sale.chargeId, CHARGE.amountIdr),
    ]);
    // Whatever was left waiting is approved now; it must not pay twice.
    for (const row of await manualRows(sale.chargeId))
      if (row.status === "requested") await approveRefund(row.id);

    expect(voided.response.status).toBeLessThan(500);
    expect(requested.status).toBeLessThan(500);
    expect(await returnedOf(sale.chargeId)).toBeLessThanOrEqual(
      CHARGE.amountIdr,
    );
    // Over-returning would put the drawer below the charge-less control.
    expect((await drawerCash()) - before).toBeGreaterThanOrEqual(control);
    // At least one of the two succeeded (nothing is lost, the guest is repaid once).
    expect(isOk(voided.response) || isOk(requested)).toBe(true);
    if (isOk(voided.response)) expect(await voidRowCount(sale.orderId)).toBe(1);
  });

  it("MRV-7 void at the same time as a partial manual approval: charge total returned is exactly the charge or less, never more", async () => {
    const control = await controlVoidDelta();
    const before = await drawerCash();
    const sale = await saleWithCashCharge();
    const refundId = await manualRefund(sale.chargeId, 6_000, {
      approve: false,
    });

    const [voided, approved] = await Promise.all([
      voidOrder(sale),
      approveRefund(refundId),
    ]);

    expect(voided.response.status).toBeLessThan(500);
    expect(approved.status).toBeLessThan(500);
    const returned = await returnedOf(sale.chargeId);
    expect(returned).toBeLessThanOrEqual(CHARGE.amountIdr);
    expect((await drawerCash()) - before).toBeGreaterThanOrEqual(control);
    // The void may only have succeeded after the manual refund settled, or
    // been refused while it was waiting: never both paying the same rupiah.
    if (isOk(voided.response) && isOk(approved))
      expect(returned).toBe(CHARGE.amountIdr);
  });

  it("MRV-8 isolation: a manual refund and void of one sale never touch another sale's paid charge or drawer share", async () => {
    const mine = await saleWithCashCharge();
    const other = await saleWithCashCharge();
    await manualRefund(mine.chargeId, 4_000, { approve: true });
    const otherDrawer = await drawerCash();

    const { response } = await voidOrder(mine);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);

    expect(await chargeStatus(other.chargeId)).toBe("paid");
    expect(await manualRows(other.chargeId)).toHaveLength(0);
    expect(await movementAmounts(`void-charge:${other.chargeId}`)).toEqual([]);
    expect((await pos().get(other.orderId)).body.data.status).toBe("completed");
    // The drawer lost only my sale + the rest of my charge.
    expect(otherDrawer - (await drawerCash())).toBe(
      mine.totalIdr + (CHARGE.amountIdr - 4_000),
    );
  });
});
