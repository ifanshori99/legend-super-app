// POS 936 part D (legend-hpgyw): facility tickets sold at the cashier.
//
// Written from the shared contract (packages/shared/src/pos/ticket.ts,
// facility staffSellTicketSchema, accessTicketSchema, accessTicketCredentialSchema,
// POS endpoints) and the founder rules in docs/briefs/1039-sub-shared.md
// ("Kontrak D" / "Test D"), not from the service code.
//
// A ticket is an ordinary line on a POS bill. Selling holds the slot and
// creates the bill; the ticket is ISSUED only when the bill is paid
// (completePosOrder); a void or refund of the bill cancels or refunds it.
//
// Money rules proved here (founder: nobody is paid more, the outlet never loses):
//   - the line price is the POS price list price; the client sends no price
//     and cannot send one (strict body); a facility product whose own price
//     differs from the POS list price is refused (422 TICKET_PRICE_MISMATCH)
//     so the guest never pays a price the product does not state;
//   - the total is computed by the server (subtotal + PBJT 10%);
//   - nothing is issued before the bill is fully paid and completed (cash,
//     QRIS, EDC, points and split tenders alike);
//   - issuing happens once (replayed and concurrent complete = one ticket);
//   - a void before payment releases the slot; a refund / correction void
//     after payment refunds the ticket, revokes its credential and releases
//     the slot; a used ticket cannot be refunded; a refund above what was
//     paid is refused; the ledger stays balanced;
//   - the door credential exists only after payment, is returned once, never
//     stored as plaintext, and a rotation kills the previous pair.
//
// Assumptions where the contract is silent:
//   - brief says permission `pos.order.view`; the catalog name is `order.view`,
//     so the cashier role gets `order.view`.
//   - a sale replies 200 (brief: "Respons 200"); the credential call replies 2xx.
//   - a created POS order may already be submitted; the helpers read the
//     current status before every call and submit only a `draft`.
//   - `lineTotalIdr` is the line price (qty 1 x list price, before tax):
//     Rp70.000 for a Rp77.000 bill (PBJT 10% as in the other pos-936 tests;
//     a menu item without an item class is taxed like Kopi Susu there).
//   - a full refund names the ticket line (`items`) and the whole bill total.
//   - the ledger check is tenant-wide: every journal entry balances (debit =
//     credit). It cannot prove a posting exists when postings are async.
//   - another outlet's cashier reaches a facility or order only as 403 or 404;
//     another tenant only as 404.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import type { Test } from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import {
  listPosOrderTickets,
  posTicketPrintSchema,
  posTicketSaleSchema,
} from "@starter/shared/pos/ticket";
import { accessTicketCredentialSchema } from "@starter/shared/facility";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { env } from "../config/env.ts";
import {
  getEdgeRuntimeState,
  setEdgeRuntimeStateForTests,
} from "../edge/runtime.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import {
  setDeviceOutletResolver,
  setStaffPin,
} from "../services/device-pin.service.ts";
import {
  setPosEdcTenderPort,
  setPosReceiptPort,
  type PosReceiptPort,
} from "../services/pos-order-ports.ts";
import { sellPosTicket } from "../services/facility-pos-ticket-sale.ts";
import { openPosShift } from "../services/pos-shift.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  asTenant as memberAsTenant,
  owner as memberOwner,
  seedMember,
  seedProgram,
  type Profile,
} from "./member-loyalty-helpers.ts";
import { grantPoints } from "./member-rewards-helpers.ts";
import { memberQrFor } from "./member-qr-redeem-helper.ts";

const PIN = "582914";
const TICKET_LIST_IDR = 70_000;
const MISMATCH_PRODUCT_IDR = 65_000;
/** PBJT 10% on Rp70.000. */
const TICKET_TAX_IDR = 7_000;
const TICKET_TOTAL_IDR = 77_000;
const POINT_VALUE_IDR = 70;
/** 77.000 / 70 = exactly 1.100 points. */
const POINTS_FOR_FULL_BILL = 1_100;

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let otherTenant: IsolatedTenant;
let otherHeaders: { Host: string };

type Staff = { client: ReturnType<typeof agent>; userId: string };
let cashier: Staff;
let supervisor: Staff;
let noSalePermission: Staff;
let outletBCashier: Staff;
let otherTenantCashier: Staff;
let outletB: string;
let deviceId: string;
const devices = new Map<string, { tenantId: string; outletId: string }>();

const ids = {
  category: randomUUID(),
  ticketItem: randomUUID(),
  facility: randomUUID(),
  area: randomUUID(),
  product: randomUUID(),
  mismatchProduct: randomUUID(),
  noMenuProduct: randomUUID(),
  inactiveProduct: randomUUID(),
  addon: randomUUID(),
  customer: "",
};

const short = () => randomUUID().slice(0, 6);
const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body?.error?.code ?? body?.code;

// ---- Doubles --------------------------------------------------------------------

function memoryReceiptPort(): PosReceiptPort {
  const byOrder = new Map<string, PosReceipt>();
  let sequence = 0;
  return {
    async issueForSale(_tx, context, input) {
      const existing = byOrder.get(input.orderId);
      if (existing) return existing;
      sequence += 1;
      const receipt = {
        id: randomUUID(),
        tenantId: context.tenant.tenantId,
        outletId: input.outletId,
        orderId: input.orderId,
        deviceId: input.deviceId ?? randomUUID(),
        number: `POST-${String(sequence).padStart(6, "0")}`,
        sequenceNumber: sequence,
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

// ---- Fixtures -------------------------------------------------------------------

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

async function staff(
  forTenant: IsolatedTenant,
  roleId: string,
  scope: { type: "tenant" } | { type: "outlet"; outletId: string },
  label: string,
): Promise<Staff> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
    [
      forTenant.tenantId,
      userId,
      roleId,
      scope.type,
      scope.type === "outlet" ? scope.outletId : null,
    ],
  );
  return { client, userId };
}

async function role(
  forTenant: IsolatedTenant,
  name: string,
  permissions: string[],
  templateKey: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, ($5::text IS NOT NULL), $5, $4, false, '["tenant","outlet"]')`,
    [id, forTenant.tenantId, name, JSON.stringify(permissions), templateKey],
  );
  return id;
}

const sessionContext = () =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  setPosEdcTenderPort(async (_tx, _context, input) => ({
    reference: input.reference ?? "EDC-TEST",
    approvedBy: null,
  }));
  tenant = await createIsolatedTenant(`tkt-${short()}`);
  headers = { Host: tenant.hostname };
  otherTenant = await createIsolatedTenant(`tkto-${short()}`);
  otherHeaders = { Host: otherTenant.hostname };
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["pos", "qr_order", "loyalty"],
      integrationProviders: [],
    }),
  ]);
  deviceId = randomUUID();
  devices.set(deviceId, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
  });
  setDeviceOutletResolver(async ({ tenantId, deviceId: id }) =>
    devices.get(id)?.tenantId === tenantId
      ? (devices.get(id)?.outletId ?? null)
      : null,
  );

  outletB = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $2, tenant_id, brand_id, legal_entity_id, $3, 'Outlet Tiket B', address, timezone, opening_hours, status
       FROM outlets WHERE id = $1`,
    [tenant.outletId, outletB, `TKB-${short()}`.toUpperCase()],
  );

  const cashierRole = await role(tenant, "Kasir Tiket", [
    "order.view",
    "pos.sale.create",
    "pos.payment.accept",
    "pos.void.request",
    "pos.refund.request",
    "shift.cash.operate",
  ]);
  const supervisorRole = await role(
    tenant,
    "Supervisor Tiket",
    ["order.view", "pos.void.approve", "pos.refund.approve"],
    "supervisor",
  );
  const viewOnlyRole = await role(tenant, "Hanya Lihat Tiket", ["order.view"]);
  cashier = await staff(tenant, cashierRole, { type: "tenant" }, "Kasir Tiket");
  supervisor = await staff(
    tenant,
    supervisorRole,
    { type: "tenant" },
    "Supervisor Tiket",
  );
  noSalePermission = await staff(
    tenant,
    viewOnlyRole,
    { type: "tenant" },
    "Lihat Saja",
  );
  outletBCashier = await staff(
    tenant,
    cashierRole,
    { type: "outlet", outletId: outletB },
    "Kasir Outlet B",
  );
  const otherRole = await role(otherTenant, "Kasir Tenant Lain", [
    "order.view",
    "pos.sale.create",
  ]);
  otherTenantCashier = await staff(
    otherTenant,
    otherRole,
    { type: "tenant" },
    "Kasir Tenant Lain",
  );
  await setStaffPin(
    sessionContext(),
    supervisor.userId,
    { outletId: tenant.outletId, userId: supervisor.userId },
    { pin: PIN },
  );
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId,
  });
  await openPosShift(
    establishScopedTenantContext(sessionContext(), { kind: "tenant" }),
    { userId: userIdSchema.parse(cashier.userId), deviceId },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );

  await asOwnerTenant(tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Tiket Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await db.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Tiket Shower', true, $5)`,
      [
        ids.ticketItem,
        tenant.tenantId,
        tenant.brandId,
        ids.category,
        randomUUID(),
      ],
    );
    const priceList = randomUUID();
    await db.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
      [priceList, tenant.tenantId, tenant.outletId],
    );
    await db.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        tenant.tenantId,
        priceList,
        ids.ticketItem,
        TICKET_LIST_IDR,
      ],
    );
    await db.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await db.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-TKT', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, supervisor.userId],
    );
    await db.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Shower Tiket', 'shower', 20, 10, 10, $4, $5, $6)`,
      [
        ids.facility,
        tenant.tenantId,
        tenant.outletId,
        JSON.stringify([
          {
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            opensAt: "00:00",
            closesAt: "23:59",
          },
        ]),
        JSON.stringify({
          graceMinutes: 5,
          blockMinutes: 15,
          feePerBlockIdr: 5000,
        }),
        JSON.stringify({
          freeCancelMinutesBefore: 30,
          lateCancelResolution: "no_refund",
          lateCancelFeeIdr: 0,
          noShowResolution: "no_refund",
        }),
      ],
    );
    await db.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area Tiket', 0)`,
      [ids.area, tenant.tenantId, tenant.outletId, ids.facility],
    );
    for (const [id, name, price, menuItem, active] of [
      [ids.product, "Tiket Shower 1x", TICKET_LIST_IDR, ids.ticketItem, true],
      [
        ids.mismatchProduct,
        "Tiket Harga Beda",
        MISMATCH_PRODUCT_IDR,
        ids.ticketItem,
        true,
      ],
      [ids.noMenuProduct, "Tiket Tanpa Menu", TICKET_LIST_IDR, null, true],
      [
        ids.inactiveProduct,
        "Tiket Nonaktif",
        TICKET_LIST_IDR,
        ids.ticketItem,
        false,
      ],
    ] as const)
      await db.query(
        `INSERT INTO facility_products
           (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, menu_item_id)
         VALUES ($1, $2, $3, $4, $5, 'single', $6, 1, $7, $8)`,
        [
          id,
          tenant.tenantId,
          tenant.outletId,
          ids.facility,
          name,
          price,
          active,
          menuItem,
        ],
      );
    await db.query(
      `INSERT INTO facility_addons (id, tenant_id, outlet_id, facility_id, name, price_idr, is_enabled)
       VALUES ($1, $2, $3, $4, 'Handuk', 5000, true)`,
      [ids.addon, tenant.tenantId, tenant.outletId, ids.facility],
    );
  });
  await seedProgram(tenant.tenantId, { pointValueIdr: POINT_VALUE_IDR });
  ids.customer = (await seedMember(tenant.tenantId)).id;
}, 180_000);

afterAll(async () => {
  setPosReceiptPort(null);
  setPosEdcTenderPort(null);
  setDeviceOutletResolver(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await memberOwner.end();
  await owner.end();
});

// ---- HTTP helpers ---------------------------------------------------------------

function deviceToken() {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });
}

const authed = (request: Test, host: { Host: string } = headers) =>
  request.set(host).set(originHeader).set(DEVICE_TOKEN_HEADER, deviceToken());

/** Tomorrow 03:00 UTC (10:00 Jakarta): inside the all-day hours, never past. */
function slotStart(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 3),
  ).toISOString();
}

/** A fresh unit, so scenarios never share a slot. */
async function newUnit(): Promise<string> {
  const unitId = randomUUID();
  await asOwnerTenant(tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, 'available', 0)`,
      [
        unitId,
        tenant.tenantId,
        tenant.outletId,
        ids.facility,
        ids.area,
        `T-${short()}`.toUpperCase(),
      ],
    ),
  );
  return unitId;
}

type SaleBody = Record<string, unknown>;

function saleBody(unitId: string, overrides: SaleBody = {}): SaleBody {
  return {
    facilityId: ids.facility,
    areaId: ids.area,
    unitId,
    productId: ids.product,
    customerProfileId: ids.customer,
    timing: { kind: "slot", startsAt: slotStart() },
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}

function sell(
  body: SaleBody,
  who: Staff = cashier,
  host: { Host: string } = headers,
) {
  return authed(who.client.post("/api/facility/tickets/pos"), host).send(body);
}

type OrderView = {
  id: string;
  status: string;
  channel: string;
  subtotalIdr: number;
  discountIdr: number;
  serviceChargeIdr: number;
  taxIdr: number;
  roundingIdr: number;
  totalIdr: number;
  items: { id: string; menuItemId: string; quantity: number }[];
  tenders: { amountIdr: number; method: string; status: string }[];
};

type TicketView = { id: string; status: string; unitId: string };

type Bought = {
  unitId: string;
  ticketId: string;
  orderId: string;
  itemId: string;
  order: OrderView;
  ticket: TicketView;
};

/** Sells a ticket on a fresh unit and checks the happy-path reply. */
async function buy(
  overrides: SaleBody = {},
  unitId?: string,
  who: Staff = cashier,
): Promise<Bought> {
  const unit = unitId ?? (await newUnit());
  const response = await sell(saleBody(unit, overrides), who);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const sale = posTicketSaleSchema.parse(response.body.data);
  const order = response.body.data.order as OrderView;
  return {
    unitId: unit,
    ticketId: sale.ticket.id,
    orderId: order.id,
    itemId: order.items[0]!.id,
    order,
    ticket: response.body.data.ticket as TicketView,
  };
}

function posApi(outletId = tenant.outletId, who: Staff = cashier) {
  const base = `/api/outlets/${encodeURIComponent(outletId)}/pos/orders`;
  const post = (path: string, body: Record<string, unknown>) =>
    authed(who.client.post(`${base}${path}`)).send({
      idempotencyKey: randomUUID(),
      ...body,
    });
  return {
    get: (orderId: string) => authed(who.client.get(`${base}/${orderId}`)),
    submit: (orderId: string, expectedStatus: string) =>
      post(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      post(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    edc: (orderId: string, expectedStatus: string) =>
      post(`/${orderId}/tenders`, {
        method: "edc_card",
        reference: `EDC-${short()}`,
        expectedStatus,
      }),
    complete: (
      orderId: string,
      expectedStatus: string,
      idempotencyKey: string = randomUUID(),
    ) => post(`/${orderId}/complete`, { expectedStatus, idempotencyKey }),
    void: (orderId: string, body: Record<string, unknown>) =>
      post(`/${orderId}/void`, body),
    correctionVoid: (orderId: string, body: Record<string, unknown>) =>
      post(`/${orderId}/corrections/void`, body),
    refund: (orderId: string, body: Record<string, unknown>) =>
      post(`/${orderId}/corrections/refund`, body),
  };
}

async function readOrder(orderId: string): Promise<OrderView> {
  const read = await posApi().get(orderId);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data as OrderView;
}

/** The order ready to take a tender: the status is read fresh every call. */
async function readyOrder(orderId: string): Promise<string> {
  let order = await readOrder(orderId);
  if (order.status === "draft") {
    const submitted = await posApi().submit(orderId, order.status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    order = await readOrder(orderId);
  }
  return order.status;
}

async function complete(orderId: string, key?: string) {
  const status = (await readOrder(orderId)).status;
  return posApi().complete(orderId, status, key);
}

async function payCash(orderId: string, amount = TICKET_TOTAL_IDR) {
  const status = await readyOrder(orderId);
  const paid = await posApi().cash(orderId, status, amount);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
}

async function payEdc(orderId: string) {
  const status = await readyOrder(orderId);
  const paid = await posApi().edc(orderId, status);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
}

async function paySplit(orderId: string) {
  await payCash(orderId, 30_000);
  const status = (await readOrder(orderId)).status;
  const paid = await posApi().edc(orderId, status);
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
}

/** A QRIS tender for the whole bill, as the gateway leaves it. */
async function seedQrisTender(
  orderId: string,
  status: "authorized" | "captured",
) {
  await asOwnerTenant(tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO pos_order_tenders
         (tenant_id, outlet_id, order_id, method, provider, payment_link_id,
          payment_link_token_sealed, payment_intent_id, amount_idr, status, requested_at, resolved_at)
       VALUES ($1, $2, $3, 'qris', 'doit', $4, 'sealed', $5, $6, $7, now(), $8::timestamptz)`,
      [
        tenant.tenantId,
        tenant.outletId,
        ulidToUuid(orderId),
        randomUUID(),
        randomUUID(),
        TICKET_TOTAL_IDR,
        status,
        status === "captured" ? new Date().toISOString() : null,
      ],
    ),
  );
}

async function payPoints(orderId: string) {
  await readyOrder(orderId);
  const member: Profile = await seedMember(tenant.tenantId);
  await grantPoints(tenant.tenantId, member.id, POINTS_FOR_FULL_BILL + 100);
  await memberAsTenant(tenant.tenantId, (db) =>
    db.query(
      `UPDATE orders
          SET customer_profile_id = $3, customer_attached_via = 'member_qr',
              customer_attached_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, ulidToUuid(orderId), member.id],
    ),
  );
  const memberToken = await memberQrFor(
    tenant.tenantId,
    orderId,
    POINTS_FOR_FULL_BILL,
  );
  const redeemed = await cashier.client
    .post(`/api/pos/orders/${orderId}/points/redeem`)
    .set(headers)
    .set(originHeader)
    .send({
      points: POINTS_FOR_FULL_BILL,
      idempotencyKey: randomUUID(),
      ...(memberToken ? { memberToken } : {}),
    });
  expect(redeemed.status, JSON.stringify(redeemed.body)).toBeLessThan(300);
}

/** A supervisor PIN override for a void or refund, as the POS does it. */
async function approval(
  action: "void" | "refund",
  orderId: string,
  valueIdr: number,
) {
  const { override } = await createPosOverride(
    sessionContext(),
    cashier.userId,
    {
      outletId: tenant.outletId,
      action,
      valueIdr,
      reason: "Persetujuan uji tiket",
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

async function voidUnpaid(orderId: string) {
  const status = (await readOrder(orderId)).status;
  return posApi().void(orderId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan batal beli tiket",
    expectedStatus: status,
    ...(await approval("void", orderId, TICKET_TOTAL_IDR)),
  });
}

async function correctionVoid(orderId: string) {
  return posApi().correctionVoid(orderId, {
    reason: "customer_cancelled",
    reasonNote: "Pelanggan batal tiket",
    ...(await approval("void", orderId, TICKET_TOTAL_IDR)),
  });
}

async function refund(orderId: string, itemId: string, amountIdr: number) {
  return posApi().refund(orderId, {
    reason: "quality_complaint",
    reasonNote: "Bilik tidak bisa dipakai",
    amountIdr,
    items: [{ itemId, quantity: 1 }],
    ...(await approval("refund", orderId, amountIdr)),
  });
}

type PosTicketRow = {
  ticket: TicketView;
  orderItemId: string;
  lineStatus: string;
  lineTotalIdr: number;
  display: {
    productName: string;
    facilityName: string;
    areaName: string;
    unitCode: string | null;
    customerName: string;
  };
};

async function ticketsOf(orderId: string, who: Staff = cashier) {
  return authed(who.client.get(`/api/pos/orders/${orderId}/tickets`));
}

async function ticketRows(orderId: string): Promise<PosTicketRow[]> {
  const response = await ticketsOf(orderId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return listPosOrderTickets.response.parse(response.body).data
    .tickets as unknown as PosTicketRow[];
}

async function onlyTicket(orderId: string): Promise<PosTicketRow> {
  const rows = await ticketRows(orderId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function credentialCall(
  orderId: string,
  ticketId: string,
  key: string = randomUUID(),
  who: Staff = cashier,
  host: { Host: string } = headers,
) {
  return authed(
    who.client.post(
      `/api/pos/orders/${orderId}/tickets/${encodeURIComponent(ticketId)}/credential`,
    ),
    host,
  ).send({ idempotencyKey: key });
}

async function ticketRowCount(unitId: string): Promise<number> {
  const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
    db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM access_tickets WHERE tenant_id = $1 AND unit_id = $2",
      [tenant.tenantId, unitId],
    ),
  );
  return Number(rows[0]?.n);
}

async function setTicketStatus(ticketId: string, status: string) {
  await asOwnerTenant(tenant.tenantId, (db) =>
    db.query(
      `UPDATE access_tickets
          SET status = $3, first_opened_at = $4::timestamptz, ended_at = $5::timestamptz
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenant.tenantId,
        ulidToUuid(ticketId),
        status,
        // The ticket contract: an in_use or completed ticket records when it
        // was first opened, and a completed one when the session ended.
        status === "in_use" || status === "completed"
          ? new Date().toISOString()
          : null,
        status === "completed" ? new Date().toISOString() : null,
      ],
    ),
  );
}

async function credentialRow(ticketId: string) {
  const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
    db.query<{
      qr_digest: string;
      pin_digest: string;
      version: number;
      revoked_at: string | null;
    }>(
      `SELECT qr_digest, pin_digest, version, revoked_at
         FROM access_ticket_credentials WHERE tenant_id = $1 AND access_ticket_id = $2`,
      [tenant.tenantId, ulidToUuid(ticketId)],
    ),
  );
  return rows[0] ?? null;
}

/** Every journal entry of the tenant balances (debit = credit). */
async function expectLedgerBalanced() {
  const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
    db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (
         SELECT entry_id FROM journal_lines WHERE tenant_id = $1
          GROUP BY entry_id HAVING sum(debit_idr) <> sum(credit_idr)) unbalanced`,
      [tenant.tenantId],
    ),
  );
  expect(Number(rows[0]?.n)).toBe(0);
}

/** A sale of the same slot succeeds again: the first hold is gone. */
async function expectSlotFree(unitId: string) {
  const again = await sell(saleBody(unitId));
  expect(again.status, JSON.stringify(again.body)).toBe(200);
}

// ---- The sale ---------------------------------------------------------------------

describe("POS-936-TKT sell a facility ticket at the cashier", () => {
  it("POS-936-TKT-01 the sale holds the slot and returns a bill with one ticket line at the POS price, no credential, server-computed total", async () => {
    const unitId = await newUnit();
    const response = await sell(saleBody(unitId));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const sale = posTicketSaleSchema.parse(response.body.data);
    expect(sale.ticket.status).toBe("pending_payment");
    expect(sale.ticket.unitId).toBe(unitId);
    expect(sale.ticket.productId).toBe(ids.product);

    const order = response.body.data.order as OrderView;
    expect(order.channel).toBe("pos");
    expect(order.status).not.toBe("paid");
    expect(order.status).not.toBe("completed");
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({
      menuItemId: ids.ticketItem,
      quantity: 1,
    });
    expect(order.subtotalIdr).toBe(TICKET_LIST_IDR);
    expect(order.taxIdr).toBe(TICKET_TAX_IDR);
    expect(order.totalIdr).toBe(TICKET_TOTAL_IDR);
    expect(order.totalIdr).toBe(
      order.subtotalIdr -
        order.discountIdr +
        order.serviceChargeIdr +
        order.taxIdr +
        order.roundingIdr,
    );
    expect(order.tenders).toHaveLength(0);
    // The credential never comes with the sale.
    expect(JSON.stringify(response.body)).not.toMatch(/qrToken|"pin"/);
    expect(await ticketRowCount(unitId)).toBe(1);
  });

  it("POS-936-TKT-02 the client cannot send a price: an extra price field is refused and nothing is held", async () => {
    const unitId = await newUnit();
    const response = await sell(saleBody(unitId, { priceIdr: 1 }));
    expect([400, 422], JSON.stringify(response.body)).toContain(
      response.status,
    );
    expect(await ticketRowCount(unitId)).toBe(0);
  });

  it("POS-936-TKT-03 a product whose price differs from the POS list price is refused (422 TICKET_PRICE_MISMATCH) and holds nothing", async () => {
    const unitId = await newUnit();
    const response = await sell(
      saleBody(unitId, { productId: ids.mismatchProduct }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(errorCode(response.body)).toBe("TICKET_PRICE_MISMATCH");
    expect(await ticketRowCount(unitId)).toBe(0);
    await expectSlotFree(unitId);
  });

  it("POS-936-TKT-04 a product without a POS menu item is refused (422 TICKET_PRODUCT_NOT_SELLABLE_AT_POS)", async () => {
    const unitId = await newUnit();
    const response = await sell(
      saleBody(unitId, { productId: ids.noMenuProduct }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(errorCode(response.body)).toBe("TICKET_PRODUCT_NOT_SELLABLE_AT_POS");
    expect(await ticketRowCount(unitId)).toBe(0);
  });

  it("POS-936-TKT-05 an inactive product is refused (422) and holds nothing", async () => {
    const unitId = await newUnit();
    const response = await sell(
      saleBody(unitId, { productId: ids.inactiveProduct }),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await ticketRowCount(unitId)).toBe(0);
  });

  it("POS-936-TKT-06 an offline sale or add-ons are refused (422): the POS sale is online and add-ons have no bill price yet", async () => {
    const unitId = await newUnit();
    const offline = await sell(saleBody(unitId, { issuedOffline: true }));
    expect(offline.status, JSON.stringify(offline.body)).toBe(422);
    const addon = await sell(saleBody(unitId, { addonIds: [ids.addon] }));
    expect(addon.status, JSON.stringify(addon.body)).toBe(422);
    expect(await ticketRowCount(unitId)).toBe(0);
  });

  it("POS-936-TKT-07 the same idempotency key replays the same bill and ticket, also when sent twice at once", async () => {
    const unitId = await newUnit();
    const body = saleBody(unitId);
    const first = await sell(body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const replay = await sell(body);
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.data.order.id).toBe(first.body.data.order.id);
    expect(replay.body.data.ticket.id).toBe(first.body.data.ticket.id);

    const raceUnit = await newUnit();
    const raceBody = saleBody(raceUnit);
    const [one, two] = await Promise.all([sell(raceBody), sell(raceBody)]);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(two.status, JSON.stringify(two.body)).toBe(200);
    expect(two.body.data.order.id).toBe(one.body.data.order.id);
    expect(two.body.data.ticket.id).toBe(one.body.data.ticket.id);
    // One hold, one bill.
    expect(await ticketRowCount(unitId)).toBe(1);
    expect(await ticketRowCount(raceUnit)).toBe(1);
  });

  it("POS-936-TKT-08 the same key with a different sale is refused (409 IDEMPOTENCY_KEY_REUSED)", async () => {
    const key = randomUUID();
    const first = await sell(
      saleBody(await newUnit(), { idempotencyKey: key }),
    );
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const other = await sell(
      saleBody(await newUnit(), { idempotencyKey: key }),
    );
    expect(other.status, JSON.stringify(other.body)).toBe(409);
    expect(errorCode(other.body)).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("POS-936-TKT-09 two sales for the same unit and slot at once: one wins, the other is 409 SLOT_UNAVAILABLE", async () => {
    const unitId = await newUnit();
    const [one, two] = await Promise.all([
      sell(saleBody(unitId)),
      sell(saleBody(unitId)),
    ]);
    const statuses = [one.status, two.status].sort();
    expect(statuses, JSON.stringify([one.body, two.body])).toEqual([200, 409]);
    const loser = one.status === 409 ? one : two;
    expect(errorCode(loser.body)).toBe("SLOT_UNAVAILABLE");
    expect(await ticketRowCount(unitId)).toBe(1);
  });

  it("POS-936-TKT-10 an unknown facility, area, product or customer is 404, and so is another tenant's customer", async () => {
    const unitId = await newUnit();
    const foreignCustomer = (await seedMember(otherTenant.tenantId)).id;
    for (const overrides of [
      { facilityId: randomUUID() },
      { areaId: randomUUID() },
      { productId: randomUUID() },
      { customerProfileId: randomUUID() },
      { customerProfileId: foreignCustomer },
    ]) {
      const response = await sell(saleBody(unitId, overrides));
      expect(
        response.status,
        `${JSON.stringify(overrides)} ${JSON.stringify(response.body)}`,
      ).toBe(404);
    }
    expect(await ticketRowCount(unitId)).toBe(0);
  });

  it("POS-936-TKT-11 another tenant, another outlet, no session or no sale permission cannot sell this facility's ticket", async () => {
    const unitId = await newUnit();
    const otherTenantSale = await sell(
      saleBody(unitId),
      otherTenantCashier,
      otherHeaders,
    );
    // The other tenant's Host is refused with 403 TENANT_MISMATCH (a valid
    // rejection); a 404 would be as good. Nothing may be created either way.
    expect([403, 404], JSON.stringify(otherTenantSale.body)).toContain(
      otherTenantSale.status,
    );
    const otherOutlet = await sell(saleBody(unitId), outletBCashier);
    expect([403, 404], JSON.stringify(otherOutlet.body)).toContain(
      otherOutlet.status,
    );
    const noPermission = await sell(saleBody(unitId), noSalePermission);
    expect(noPermission.status, JSON.stringify(noPermission.body)).toBe(403);
    const anonymous = await agent(app)
      .post("/api/facility/tickets/pos")
      .set(headers)
      .set(originHeader)
      .send(saleBody(unitId));
    expect(anonymous.status).toBe(401);
    expect(await ticketRowCount(unitId)).toBe(0);
  });
});

// ---- Issue only when paid ---------------------------------------------------------

describe("POS-936-TKT the ticket is issued only when the bill is paid", () => {
  const methods: [string, (orderId: string) => Promise<void>][] = [
    ["cash", (orderId) => payCash(orderId)],
    ["edc", (orderId) => payEdc(orderId)],
    [
      "qris",
      async (orderId) => {
        await readyOrder(orderId);
        await seedQrisTender(orderId, "captured");
      },
    ],
    ["points", (orderId) => payPoints(orderId)],
    ["split cash + edc", (orderId) => paySplit(orderId)],
  ];

  for (const [index, [label, pay]] of methods.entries())
    it(`POS-936-TKT-2${index} paying by ${label}: pending before the bill is completed, issued exactly once after`, async () => {
      const bought = await buy();
      const before = await onlyTicket(bought.orderId);
      expect(before.ticket.status).toBe("pending_payment");
      expect(before.lineStatus).toBe("pending");
      expect(before.orderItemId).toBe(bought.itemId);
      expect(before.lineTotalIdr).toBe(TICKET_LIST_IDR);

      await pay(bought.orderId);
      // Tendered in full but not completed: still nothing usable.
      expect((await onlyTicket(bought.orderId)).ticket.status).toBe(
        "pending_payment",
      );
      expect(
        (await credentialCall(bought.orderId, bought.ticketId)).status,
      ).toBe(409);

      const done = await complete(bought.orderId);
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      const after = await onlyTicket(bought.orderId);
      expect(after.ticket.status).toBe("issued");
      expect(after.lineStatus).toBe("issued");
      expect(after.ticket.id).toBe(bought.ticketId);
      expect(await ticketRowCount(bought.unitId)).toBe(1);
    });

  it("POS-936-TKT-25 a QRIS tender still waiting for the guest does not pay: the bill cannot complete and the ticket stays pending", async () => {
    const bought = await buy();
    await readyOrder(bought.orderId);
    await seedQrisTender(bought.orderId, "authorized");
    const done = await complete(bought.orderId);
    expect(done.status, JSON.stringify(done.body)).toBeGreaterThanOrEqual(400);
    expect(done.status).toBeLessThan(500);
    const after = await onlyTicket(bought.orderId);
    expect(after.ticket.status).toBe("pending_payment");
    expect(after.lineStatus).toBe("pending");
    expect((await credentialCall(bought.orderId, bought.ticketId)).status).toBe(
      409,
    );
  });

  it("POS-936-TKT-26 a short payment does not complete the bill and issues nothing", async () => {
    const bought = await buy();
    await payCash(bought.orderId, 30_000);
    const done = await complete(bought.orderId);
    expect(done.status, JSON.stringify(done.body)).toBeGreaterThanOrEqual(400);
    expect(done.status).toBeLessThan(500);
    expect((await onlyTicket(bought.orderId)).ticket.status).toBe(
      "pending_payment",
    );
  });

  it("POS-936-TKT-27 completing twice and at the same moment (same key) issues one ticket and never errors on the server", async () => {
    const bought = await buy();
    await payCash(bought.orderId);
    const status = (await readOrder(bought.orderId)).status;
    const key = randomUUID();
    const racers = await Promise.all([
      posApi().complete(bought.orderId, status, key),
      posApi().complete(bought.orderId, status, key),
    ]);
    for (const racer of racers)
      expect(racer.status, JSON.stringify(racer.body)).toBeLessThan(500);
    expect(
      racers.some((racer) => racer.status === 200),
      JSON.stringify(racers.map((racer) => racer.body)),
    ).toBe(true);

    const replay = await posApi().complete(
      bought.orderId,
      (await readOrder(bought.orderId)).status,
      key,
    );
    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(500);

    const rows = await ticketRows(bought.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ticket.status).toBe("issued");
    expect(await ticketRowCount(bought.unitId)).toBe(1);
  });
});

// ---- Void before payment ------------------------------------------------------------

describe("POS-936-TKT voiding the bill before it is paid", () => {
  it("POS-936-TKT-30 releases the hold: the ticket is cancelled, no credential can be made, and the same slot sells again", async () => {
    const bought = await buy();
    const voided = await voidUnpaid(bought.orderId);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const row = await onlyTicket(bought.orderId);
    expect(row.ticket.status).toBe("cancelled");
    expect(row.lineStatus).toBe("cancelled");
    expect((await credentialCall(bought.orderId, bought.ticketId)).status).toBe(
      409,
    );
    expect(
      errorCode((await credentialCall(bought.orderId, bought.ticketId)).body),
    ).toBe("TICKET_TRANSITION_INVALID");
    await expectSlotFree(bought.unitId);
  });
});

// ---- Refund after payment -----------------------------------------------------------

async function paidTicket(): Promise<Bought> {
  const bought = await buy();
  await payCash(bought.orderId);
  const done = await complete(bought.orderId);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect((await onlyTicket(bought.orderId)).ticket.status).toBe("issued");
  return bought;
}

describe("POS-936-TKT refunding or voiding a paid ticket", () => {
  it("POS-936-TKT-40 a correction void refunds the ticket, revokes its credential, releases the slot and keeps the ledger balanced", async () => {
    const bought = await paidTicket();
    const minted = await credentialCall(bought.orderId, bought.ticketId);
    expect(minted.status, JSON.stringify(minted.body)).toBeLessThan(300);
    expect(
      (await credentialRow(bought.ticketId))?.revoked_at ?? null,
    ).toBeNull();

    const voided = await correctionVoid(bought.orderId);
    expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);
    const row = await onlyTicket(bought.orderId);
    expect(row.ticket.status).toBe("refunded");
    expect(row.lineStatus).toBe("refunded");
    expect((await credentialRow(bought.ticketId))?.revoked_at).not.toBeNull();
    expect(
      errorCode((await credentialCall(bought.orderId, bought.ticketId)).body),
    ).toBe("TICKET_TRANSITION_INVALID");
    await expectSlotFree(bought.unitId);
    await expectLedgerBalanced();
  });

  it("POS-936-TKT-41 a full refund of the ticket line refunds the ticket; refunding above what was paid, or twice, is refused", async () => {
    const bought = await paidTicket();
    const tooMuch = await refund(
      bought.orderId,
      bought.itemId,
      TICKET_TOTAL_IDR + 1,
    );
    expect(tooMuch.status, JSON.stringify(tooMuch.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect((await onlyTicket(bought.orderId)).ticket.status).toBe("issued");

    const refunded = await refund(
      bought.orderId,
      bought.itemId,
      TICKET_TOTAL_IDR,
    );
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);
    const row = await onlyTicket(bought.orderId);
    expect(row.ticket.status).toBe("refunded");
    expect(row.lineStatus).toBe("refunded");

    const again = await refund(bought.orderId, bought.itemId, 1_000);
    expect(again.status, JSON.stringify(again.body)).toBeGreaterThanOrEqual(
      400,
    );
    expect(again.status).toBeLessThan(500);
    await expectSlotFree(bought.unitId);
    await expectLedgerBalanced();
  });

  it("POS-936-TKT-42 a ticket that was already used cannot be refunded or voided (409 TICKET_ALREADY_USED) and the sale stays as it was", async () => {
    for (const used of ["in_use", "completed", "no_show"]) {
      const bought = await paidTicket();
      await setTicketStatus(bought.ticketId, used);
      const statusBefore = (await readOrder(bought.orderId)).status;

      const refused = await refund(
        bought.orderId,
        bought.itemId,
        TICKET_TOTAL_IDR,
      );
      expect(refused.status, `${used} ${JSON.stringify(refused.body)}`).toBe(
        409,
      );
      expect(errorCode(refused.body)).toBe("TICKET_ALREADY_USED");
      const voidRefused = await correctionVoid(bought.orderId);
      expect(
        voidRefused.status,
        `${used} ${JSON.stringify(voidRefused.body)}`,
      ).toBe(409);
      expect(errorCode(voidRefused.body)).toBe("TICKET_ALREADY_USED");

      expect((await readOrder(bought.orderId)).status).toBe(statusBefore);
      expect((await onlyTicket(bought.orderId)).ticket.status).toBe(used);
    }
  });
});

// ---- Hold lapsed and edge mode ---------------------------------------------------------

describe("POS-936-TKT a lapsed hold and the edge", () => {
  // Assumption: "lapsed" = the 30-minute hold ran out and someone else took
  // the slot (a new sale releases lapsed holds of the facility itself).
  it("POS-936-TKT-28 starting a tender on a bill whose hold lapsed and whose slot was taken is refused (409 TICKET_HOLD_LAPSED) and changes nothing", async () => {
    const lapsed = await buy();
    await readyOrder(lapsed.orderId);
    await asOwnerTenant(tenant.tenantId, (db) =>
      db.query(
        `UPDATE access_tickets SET hold_expires_at = now() - interval '1 minute'
          WHERE tenant_id = $1 AND id = $2 AND status = 'pending_payment'`,
        [tenant.tenantId, ulidToUuid(lapsed.ticketId)],
      ),
    );
    const taker = await sell(saleBody(lapsed.unitId));
    expect(taker.status, JSON.stringify(taker.body)).toBe(200);

    const before = await readOrder(lapsed.orderId);
    const tender = await posApi().cash(
      lapsed.orderId,
      before.status,
      TICKET_TOTAL_IDR,
    );
    expect(tender.status, JSON.stringify(tender.body)).toBe(409);
    expect(errorCode(tender.body)).toBe("TICKET_HOLD_LAPSED");

    const after = await readOrder(lapsed.orderId);
    expect(after.status).toBe(before.status);
    expect(after.tenders).toHaveLength(0);
    expect(after.totalIdr).toBe(before.totalIdr);
    expect((await onlyTicket(lapsed.orderId)).ticket.status).not.toBe("issued");
    // The guest who took the slot keeps it.
    expect((await onlyTicket(taker.body.data.order.id)).ticket.status).toBe(
      "pending_payment",
    );
  });

  // The HTTP path cannot reach the service in edge mode (the device
  // verification middleware answers 401 first), so the service is called
  // directly with the cashier as caller.
  it("POS-936-TKT-12 selling a ticket in edge mode is refused (409 TICKET_NEEDS_CLOUD) and holds nothing", async () => {
    const unitId = await newUnit();
    const previous = getEdgeRuntimeState();
    setEdgeRuntimeStateForTests({ ...previous, edgeMode: true });
    try {
      await expect(
        sellPosTicket(
          establishScopedTenantContext(sessionContext(), { kind: "tenant" }),
          {
            userId: userIdSchema.parse(cashier.userId),
            deviceId,
            expectedVersion: null,
          },
          saleBody(unitId) as Parameters<typeof sellPosTicket>[2],
        ),
      ).rejects.toMatchObject({ status: 409, code: "TICKET_NEEDS_CLOUD" });
    } finally {
      setEdgeRuntimeStateForTests(previous);
    }
    expect(await ticketRowCount(unitId)).toBe(0);
    // Back in the cloud the same slot sells.
    await expectSlotFree(unitId);
  });
});

// ---- Door credential ------------------------------------------------------------------

describe("POS-936-TKT the door credential", () => {
  it("POS-936-TKT-50 a ticket that is not paid has no credential (409 TICKET_NOT_PAID)", async () => {
    const bought = await buy();
    const response = await credentialCall(bought.orderId, bought.ticketId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(errorCode(response.body)).toBe("TICKET_NOT_PAID");
    expect(await credentialRow(bought.ticketId)).toBeNull();
  });

  it("POS-936-TKT-51 a paid ticket gets its QR and 6-digit PIN once; the server keeps no plaintext; the listing never shows them", async () => {
    const bought = await paidTicket();
    const response = await credentialCall(bought.orderId, bought.ticketId);
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    const credential = accessTicketCredentialSchema.parse(
      response.body.data.credential,
    );
    posTicketPrintSchema.parse(response.body.data.print);
    expect(credential.ticketId).toBe(bought.ticketId);
    expect(credential.unitId).toBe(bought.unitId);
    expect(credential.areaId).toBe(ids.area);
    expect(credential.facilityId).toBe(ids.facility);

    const stored = await credentialRow(bought.ticketId);
    expect(stored).not.toBeNull();
    expect(stored!.qr_digest).not.toBe(credential.qrToken);
    expect(stored!.pin_digest).not.toBe(credential.pin);
    expect(stored!.qr_digest).not.toContain(credential.qrToken);

    const listing = await ticketsOf(bought.orderId);
    expect(JSON.stringify(listing.body)).not.toContain(credential.qrToken);
    const reread = await readOrder(bought.orderId);
    expect(JSON.stringify(reread)).not.toContain(credential.qrToken);
  });

  it("POS-936-TKT-52 repeating the same key cannot show the credential again (409 TICKET_CREDENTIAL_SHOWN); a new key rotates it", async () => {
    const bought = await paidTicket();
    const key = randomUUID();
    const first = await credentialCall(bought.orderId, bought.ticketId, key);
    expect(first.status, JSON.stringify(first.body)).toBeLessThan(300);
    const firstQr = first.body.data.credential.qrToken as string;
    const before = await credentialRow(bought.ticketId);

    const replay = await credentialCall(bought.orderId, bought.ticketId, key);
    expect(replay.status, JSON.stringify(replay.body)).toBe(409);
    expect(errorCode(replay.body)).toBe("TICKET_CREDENTIAL_SHOWN");
    expect(JSON.stringify(replay.body)).not.toContain(firstQr);

    const rotated = await credentialCall(bought.orderId, bought.ticketId);
    expect(rotated.status, JSON.stringify(rotated.body)).toBeLessThan(300);
    const secondQr = rotated.body.data.credential.qrToken as string;
    expect(secondQr).not.toBe(firstQr);
    const after = await credentialRow(bought.ticketId);
    expect(after!.version).toBeGreaterThan(before!.version);
    expect(after!.qr_digest).not.toBe(before!.qr_digest);
    // The old pair stopped working: only the new digests are live.
    expect(after!.revoked_at).toBeNull();
  });

  it("POS-936-TKT-53 a cancelled ticket has no credential (409 TICKET_TRANSITION_INVALID)", async () => {
    const bought = await buy();
    const voided = await voidUnpaid(bought.orderId);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const response = await credentialCall(bought.orderId, bought.ticketId);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(errorCode(response.body)).toBe("TICKET_TRANSITION_INVALID");
  });
});

// ---- Listing, empty state and isolation -------------------------------------------------

describe("POS-936-TKT tickets of a bill: listing and isolation", () => {
  it("POS-936-TKT-60 an ordinary bill without a ticket lists none", async () => {
    // A plain POS order made through the public API (the ticket's menu item
    // is the only item in this catalogue); it has no facility ticket.
    const created = await authed(
      cashier.client.post(
        `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`,
      ),
    ).send({
      idempotencyKey: randomUUID(),
      channel: "pos",
      serviceType: "takeaway",
      items: [{ menuItemId: ids.ticketItem, quantity: 1, modifierIds: [] }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const response = await ticketsOf(created.body.data.id as string);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data.tickets).toEqual([]);
  });

  it("POS-936-TKT-60b the listing carries the display names read from the ticket's own rows", async () => {
    const bought = await buy();
    const row = await onlyTicket(bought.orderId);
    const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
      db.query<{ code: string; name: string }>(
        `SELECT u.code, c.name
           FROM facility_units u, customer_profiles c
          WHERE u.tenant_id = $1 AND u.id = $2 AND c.tenant_id = $1 AND c.id = $3`,
        [tenant.tenantId, bought.unitId, ids.customer],
      ),
    );
    expect(rows).toHaveLength(1);
    expect(row.display).toEqual({
      productName: "Tiket Shower 1x",
      facilityName: "Shower Tiket",
      areaName: "Area Tiket",
      unitCode: rows[0]!.code,
      customerName: rows[0]!.name,
    });
    expect(row.display.customerName).not.toBe("");
    // Read-only: price and status are the sale's, untouched by the lookup.
    expect(row.lineTotalIdr).toBe(TICKET_LIST_IDR);
    expect(row.lineStatus).toBe("pending");
  });

  it("POS-936-TKT-61 the listing needs a real bill and a session: unknown bill 404, no session 401", async () => {
    const unknown = await ticketsOf("01JNQ7ZT3C5R8B9K2M4V6X0Y1Z");
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(404);
    const bought = await buy();
    const anonymous = await agent(app)
      .get(`/api/pos/orders/${bought.orderId}/tickets`)
      .set(headers);
    expect(anonymous.status).toBe(401);
  });

  it("POS-936-TKT-62 another tenant is refused (403 or 404) for the listing and the credential; another outlet's cashier is refused", async () => {
    const bought = await paidTicket();
    const otherTenantList = await authed(
      otherTenantCashier.client.get(
        `/api/pos/orders/${bought.orderId}/tickets`,
      ),
      otherHeaders,
    );
    expect([403, 404], JSON.stringify(otherTenantList.body)).toContain(
      otherTenantList.status,
    );
    const otherTenantCredential = await credentialCall(
      bought.orderId,
      bought.ticketId,
      randomUUID(),
      otherTenantCashier,
      otherHeaders,
    );
    expect([403, 404], JSON.stringify(otherTenantCredential.body)).toContain(
      otherTenantCredential.status,
    );

    const otherOutletList = await ticketsOf(bought.orderId, outletBCashier);
    expect([403, 404], JSON.stringify(otherOutletList.body)).toContain(
      otherOutletList.status,
    );
    const otherOutletCredential = await credentialCall(
      bought.orderId,
      bought.ticketId,
      randomUUID(),
      outletBCashier,
    );
    expect([403, 404], JSON.stringify(otherOutletCredential.body)).toContain(
      otherOutletCredential.status,
    );
    expect(await credentialRow(bought.ticketId)).toBeNull();
  });

  it("POS-936-TKT-63 a ticket of another bill cannot be reached through this bill (404)", async () => {
    const first = await paidTicket();
    const second = await paidTicket();
    const response = await credentialCall(first.orderId, second.ticketId);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await credentialRow(second.ticketId)).toBeNull();
  });
});

describe("1269 F0 facility tickets off: nothing is sold, no money is taken, old bills can still be voided", () => {
  const flag = env as unknown as { FACILITY_TICKETS_ENABLED?: boolean };
  const was = flag.FACILITY_TICKETS_ENABLED;
  afterEach(() => {
    flag.FACILITY_TICKETS_ENABLED = was;
  });

  it("F0-01 selling is refused (403 FACILITY_TICKETS_DISABLED) and holds nothing", async () => {
    const unit = await newUnit();
    flag.FACILITY_TICKETS_ENABLED = false;
    const response = await sell(saleBody(unit));
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(errorCode(response.body)).toBe("FACILITY_TICKETS_DISABLED");
    expect(await ticketRowCount(unit)).toBe(0);
  });

  it("F0-02 a bill sold earlier takes no tender and no credential, and the cashier can still void it", async () => {
    const bought = await buy();
    flag.FACILITY_TICKETS_ENABLED = false;

    const status = await readyOrder(bought.orderId);
    const tender = await posApi().cash(
      bought.orderId,
      status,
      TICKET_TOTAL_IDR,
    );
    expect(tender.status, JSON.stringify(tender.body)).toBe(403);
    expect(errorCode(tender.body)).toBe("FACILITY_TICKETS_DISABLED");
    expect((await readOrder(bought.orderId)).tenders).toHaveLength(0);

    const credential = await credentialCall(bought.orderId, bought.ticketId);
    expect(credential.status).toBe(403);
    expect(errorCode(credential.body)).toBe("FACILITY_TICKETS_DISABLED");

    const voided = await voidUnpaid(bought.orderId);
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await onlyTicket(bought.orderId)).ticket.status).toBe("cancelled");
    await expectSlotFree(bought.unitId);
  });
});
