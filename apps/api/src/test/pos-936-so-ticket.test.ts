// POS 936 second-opinion fixes, group T (ticket and door), bead legend-hpgyw.
//
// Written from docs/briefs/1048-so-fixes.md (CTO decisions 3, 5, 6), the shared
// contract (packages/shared/src/pos/ticket.ts, facility endpoints) and the
// existing behaviour proved in pos-936-ticket.test.ts, not from the service code.
//
// ASSUMED DOOR-CHECK CONTRACT (the route is not built yet; the implementer
// must match this exactly or change this test together with it):
//
//   POST /api/facility/tickets/door-check
//   Guards: session + trusted origin + a tenant/outlet permission of the door
//     staff. The test caller holds `facility.booth.operate` and
//     `facility.access.assist` (and `order.view`); it holds no POS sale rights.
//   Body (strict, exactly one of the two shapes):
//     { qrToken: string }                    the QR token minted for the ticket
//     { ticketId: <ulid>, pin: "<6 digits>" } the PIN minted for the ticket
//   200 -> { data: { ticket: { id, status: "in_use", ... } } }
//     First success moves a paid (`issued`) ticket to `in_use` and sets
//     `first_opened_at` once. A repeat check of the same valid credential
//     answers 200 again (guest re-enters) and never changes first_opened_at.
//   403 { error: { code: "DOOR_CREDENTIAL_INVALID" } } for EVERY credential
//     failure, with one uniform code so a caller cannot tell which part was
//     wrong: unknown token, wrong PIN, rotated (not newest) pair, revoked
//     pair (refund or void), outside valid_from/valid_until, a ticket that is
//     not paid or in use, a ticket of another tenant.
//   400 or 422 for a malformed body (PIN that is not 6 digits, both or neither
//     of the two shapes).
//   A refused check never changes the ticket.
//
// Other assumptions:
//   - A ticket sale on a device with `devices.training_mode = true` replies
//     409 TICKET_TRAINING_REFUSED before anything is held. The sale does not
//     need an open shift on that device to reach the refusal.
//   - A replayed credential key (any key ever minted for the ticket, not only
//     the last) replies 409 TICKET_CREDENTIAL_SHOWN and leaves the newest
//     pair, its version and its digests untouched.
//   - The paid ticket status is `issued` (as in pos-936-ticket.test.ts).

//     credit). It cannot prove a posting exists when postings are async.
//   - another outlet's cashier reaches a facility or order only as 403 or 404;
//     another tenant only as 404.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import type { Test } from "supertest";
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
import { posTicketSaleSchema } from "@starter/shared/pos/ticket";
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
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
  owner as memberOwner,
  seedMember,
  seedProgram,
} from "./member-loyalty-helpers.ts";

const PIN = "582914";
const TICKET_LIST_IDR = 70_000;
const MISMATCH_PRODUCT_IDR = 65_000;
const TICKET_TOTAL_IDR = 77_000;
const POINT_VALUE_IDR = 70;

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let otherTenant: IsolatedTenant;
let otherHeaders: { Host: string };

type Staff = { client: ReturnType<typeof agent>; userId: string };
let cashier: Staff;
let supervisor: Staff;
let doorStaff: Staff;
let otherDoorStaff: Staff;
let trainingDeviceId: string;
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

  // A second device of the same outlet, switched to training mode.
  trainingDeviceId = randomUUID();
  devices.set(trainingDeviceId, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
  });

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
  const doorRole = await role(tenant, "Petugas Pintu", [
    "order.view",
    "facility.booth.operate",
    "facility.access.assist",
  ]);
  cashier = await staff(tenant, cashierRole, { type: "tenant" }, "Kasir Tiket");
  supervisor = await staff(
    tenant,
    supervisorRole,
    { type: "tenant" },
    "Supervisor Tiket",
  );
  doorStaff = await staff(
    tenant,
    doorRole,
    { type: "tenant" },
    "Petugas Pintu",
  );
  const otherDoorRole = await role(otherTenant, "Petugas Pintu Lain", [
    "order.view",
    "facility.booth.operate",
    "facility.access.assist",
  ]);
  otherDoorStaff = await staff(
    otherTenant,
    otherDoorRole,
    { type: "tenant" },
    "Petugas Pintu Lain",
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
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId: trainingDeviceId,
    label: "Kasir Latihan",
  });
  await owner.query(
    "UPDATE devices SET training_mode = true WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, trainingDeviceId],
  );
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

function deviceToken(forDevice: string = deviceId) {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: forDevice,
  });
}

const authed = (
  request: Test,
  host: { Host: string } = headers,
  forDevice: string = deviceId,
) =>
  request
    .set(host)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(forDevice));

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

// ---- Group T helpers ---------------------------------------------------------------

type TicketRow = {
  status: string;
  first_opened_at: string | null;
};

async function ticketState(ticketId: string): Promise<TicketRow> {
  const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
    db.query<TicketRow>(
      `SELECT status, first_opened_at FROM access_tickets
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, ulidToUuid(ticketId)],
    ),
  );
  return rows[0]!;
}

async function orderCount(): Promise<number> {
  const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
    db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM orders WHERE tenant_id = $1",
      [tenant.tenantId],
    ),
  );
  return Number(rows[0]?.n);
}

async function sameUnitTicketCount(unitId: string): Promise<number> {
  const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
    db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM access_tickets WHERE tenant_id = $1 AND unit_id = $2",
      [tenant.tenantId, unitId],
    ),
  );
  return Number(rows[0]?.n);
}

async function paidTicket(): Promise<Bought> {
  const bought = await buy();
  await payCash(bought.orderId);
  const done = await complete(bought.orderId);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return bought;
}

type Credential = { qrToken: string; pin: string };

async function mint(bought: Bought, key: string = randomUUID()) {
  const response = await credentialCall(bought.orderId, bought.ticketId, key);
  return {
    response,
    credential: (response.body?.data?.credential ?? null) as Credential | null,
  };
}

/**
 * Moves the credential window of the ticket. A mint stores the window of the
 * sale slot (tomorrow), and every rotation rewrites the same row, so a test
 * that wants the door to be open calls this after EACH mint it keeps.
 */
async function setCredentialWindow(
  ticketId: string,
  from: string,
  until: string,
) {
  await asOwnerTenant(tenant.tenantId, (db) =>
    db.query(
      `UPDATE access_ticket_credentials
          SET valid_from = now() + $3::interval,
              valid_until = now() + $4::interval
        WHERE tenant_id = $1::uuid AND access_ticket_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(ticketId), from, until],
    ),
  );
}

/**
 * Mints a credential and, by default, opens its window around now so the
 * door check fails only for the reason the test is about.
 */
async function mintOk(
  bought: Bought,
  key: string = randomUUID(),
  windowOpen = true,
): Promise<Credential> {
  const { response, credential } = await mint(bought, key);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  if (windowOpen)
    await setCredentialWindow(bought.ticketId, "-1 hour", "2 hours");
  return credential!;
}

function doorCheck(
  body: Record<string, unknown>,
  who: Staff = doorStaff,
  host: { Host: string } = headers,
) {
  return who.client
    .post("/api/facility/tickets/door-check")
    .set(host)
    .set(originHeader)
    .send(body);
}

const byQr = (credential: Credential) => ({ qrToken: credential.qrToken });
const byPin = (bought: Bought, credential: Credential) => ({
  ticketId: bought.ticketId,
  pin: credential.pin,
});

function expectDoorRefused(response: {
  status: number;
  body: { error?: { code?: string }; code?: string };
}) {
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(errorCode(response.body)).toBe("DOOR_CREDENTIAL_INVALID");
}

function expectDoorOpened(
  response: {
    status: number;
    body: { data?: { ticket?: { id?: string; status?: string } } };
  },
  ticketId: string,
) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.data?.ticket?.id).toBe(ticketId);
  expect(response.body.data?.ticket?.status).toBe("in_use");
}

// ---- Training device -----------------------------------------------------------------

describe("SO-T training device", () => {
  it("SO-T-01 a ticket sale on a training device is refused (409 TICKET_TRAINING_REFUSED) with no hold, order or ticket, and the slot stays sellable", async () => {
    const unitId = await newUnit();
    const ordersBefore = await orderCount();

    const refused = await authed(
      cashier.client.post("/api/facility/tickets/pos"),
      headers,
      trainingDeviceId,
    ).send(saleBody(unitId));
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(errorCode(refused.body)).toBe("TICKET_TRAINING_REFUSED");

    expect(await sameUnitTicketCount(unitId)).toBe(0);
    expect(await orderCount()).toBe(ordersBefore);
    // No hold was left: the very same slot sells at a real device.
    const real = await sell(saleBody(unitId));
    expect(real.status, JSON.stringify(real.body)).toBe(200);
    expect(await sameUnitTicketCount(unitId)).toBe(1);
  });

  it("SO-T-02 the same sale on a normal device still works (the refusal is only for training)", async () => {
    const bought = await buy();
    expect((await ticketState(bought.ticketId)).status).not.toBe("cancelled");
  });
});

// ---- Credential key replay -----------------------------------------------------------

describe("SO-T credential key replay", () => {
  it("SO-T-10 key A, then B, then A again: the replay is 409 TICKET_CREDENTIAL_SHOWN and B's version and digests never change", async () => {
    const bought = await paidTicket();
    const keyA = randomUUID();
    const keyB = randomUUID();
    const a = await mintOk(bought, keyA);
    const b = await mintOk(bought, keyB);
    expect(b.qrToken).not.toBe(a.qrToken);
    const before = await credentialRow(bought.ticketId);
    expect(before!.revoked_at).toBeNull();

    const replay = await credentialCall(bought.orderId, bought.ticketId, keyA);
    expect(replay.status, JSON.stringify(replay.body)).toBe(409);
    expect(errorCode(replay.body)).toBe("TICKET_CREDENTIAL_SHOWN");
    expect(JSON.stringify(replay.body)).not.toContain(a.qrToken);
    expect(JSON.stringify(replay.body)).not.toContain(b.qrToken);

    const after = await credentialRow(bought.ticketId);
    expect(after!.version).toBe(before!.version);
    expect(after!.qr_digest).toBe(before!.qr_digest);
    expect(after!.pin_digest).toBe(before!.pin_digest);
    expect(after!.revoked_at).toBeNull();

    // Replaying B (the newest key) is refused too.
    const replayB = await credentialCall(bought.orderId, bought.ticketId, keyB);
    expect(replayB.status, JSON.stringify(replayB.body)).toBe(409);
    expect(errorCode(replayB.body)).toBe("TICKET_CREDENTIAL_SHOWN");
  });

  it("SO-T-11 concurrent late replays of an old key all fail and never rotate B", async () => {
    const bought = await paidTicket();
    const keyA = randomUUID();
    const a = await mintOk(bought, keyA);
    const b = await mintOk(bought);
    const before = await credentialRow(bought.ticketId);

    const replies = await Promise.all(
      Array.from({ length: 6 }, () =>
        credentialCall(bought.orderId, bought.ticketId, keyA),
      ),
    );
    for (const reply of replies) {
      expect(reply.status, JSON.stringify(reply.body)).toBe(409);
      expect(errorCode(reply.body)).toBe("TICKET_CREDENTIAL_SHOWN");
    }
    const after = await credentialRow(bought.ticketId);
    expect(after!.version).toBe(before!.version);
    expect(after!.qr_digest).toBe(before!.qr_digest);
    expect(after!.pin_digest).toBe(before!.pin_digest);

    // B still opens the door, A does not.
    expectDoorRefused(await doorCheck(byQr(a)));
    expectDoorOpened(await doorCheck(byQr(b)), bought.ticketId);
  });

  it("SO-T-12 a fresh key still rotates after replays were refused", async () => {
    const bought = await paidTicket();
    const keyA = randomUUID();
    await mintOk(bought, keyA);
    await mintOk(bought);
    const before = await credentialRow(bought.ticketId);
    await credentialCall(bought.orderId, bought.ticketId, keyA);

    const c = await mintOk(bought);
    const after = await credentialRow(bought.ticketId);
    expect(after!.version).toBeGreaterThan(before!.version);
    expect(after!.qr_digest).not.toBe(before!.qr_digest);
    expectDoorOpened(await doorCheck(byQr(c)), bought.ticketId);
  });
});

// ---- Door check ------------------------------------------------------------------------

describe("SO-T door check", () => {
  it("SO-T-20 a QR check moves the paid ticket to in_use and sets first_opened_at once", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    expect((await ticketState(bought.ticketId)).status).toBe("issued");

    expectDoorOpened(await doorCheck(byQr(credential)), bought.ticketId);
    const first = await ticketState(bought.ticketId);
    expect(first.status).toBe("in_use");
    expect(first.first_opened_at).not.toBeNull();

    // The guest scans again: still in use, first_opened_at is not rewritten.
    expectDoorOpened(await doorCheck(byQr(credential)), bought.ticketId);
    const second = await ticketState(bought.ticketId);
    expect(second.status).toBe("in_use");
    expect(new Date(second.first_opened_at!).getTime()).toBe(
      new Date(first.first_opened_at!).getTime(),
    );
  });

  it("SO-T-21 a PIN check (ticket id + PIN) moves the paid ticket to in_use", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    expectDoorOpened(
      await doorCheck(byPin(bought, credential)),
      bought.ticketId,
    );
    const state = await ticketState(bought.ticketId);
    expect(state.status).toBe("in_use");
    expect(state.first_opened_at).not.toBeNull();
  });

  it("SO-T-22 concurrent QR and PIN checks open the ticket exactly once", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    const replies = await Promise.all([
      doorCheck(byQr(credential)),
      doorCheck(byPin(bought, credential)),
      doorCheck(byQr(credential)),
      doorCheck(byPin(bought, credential)),
    ]);
    for (const reply of replies) expectDoorOpened(reply, bought.ticketId);
    const state = await ticketState(bought.ticketId);
    expect(state.status).toBe("in_use");
    expect(state.first_opened_at).not.toBeNull();
  });

  it("SO-T-23 after a rotation the old QR and the old PIN fail and the new pair works", async () => {
    const bought = await paidTicket();
    const oldPair = await mintOk(bought);
    const newPair = await mintOk(bought);
    expect(newPair.qrToken).not.toBe(oldPair.qrToken);

    expectDoorRefused(await doorCheck(byQr(oldPair)));
    expectDoorRefused(await doorCheck(byPin(bought, oldPair)));
    expect((await ticketState(bought.ticketId)).status).toBe("issued");

    expectDoorOpened(await doorCheck(byQr(newPair)), bought.ticketId);
  });

  it("SO-T-24 after a correction void both the QR and the PIN fail and the ticket stays refunded", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    const voided = await correctionVoid(bought.orderId);
    expect(voided.status, JSON.stringify(voided.body)).toBeLessThan(300);

    expectDoorRefused(await doorCheck(byQr(credential)));
    expectDoorRefused(await doorCheck(byPin(bought, credential)));
    expect((await ticketState(bought.ticketId)).status).toBe("refunded");
  });

  it("SO-T-25 after a full refund both the QR and the PIN fail and the ticket stays refunded", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    const refunded = await refund(
      bought.orderId,
      bought.itemId,
      TICKET_TOTAL_IDR,
    );
    expect(refunded.status, JSON.stringify(refunded.body)).toBeLessThan(300);

    expectDoorRefused(await doorCheck(byQr(credential)));
    expectDoorRefused(await doorCheck(byPin(bought, credential)));
    expect((await ticketState(bought.ticketId)).status).toBe("refunded");
  });

  it("SO-T-26 an unpaid ticket has nothing to check: no credential can be minted and a guessed PIN opens nothing", async () => {
    const bought = await buy();
    const { response } = await mint(bought);
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(errorCode(response.body)).toBe("TICKET_NOT_PAID");

    expectDoorRefused(
      await doorCheck({ ticketId: bought.ticketId, pin: "123456" }),
    );
    expectDoorRefused(await doorCheck({ qrToken: `guess-${short()}` }));
    const state = await ticketState(bought.ticketId);
    expect(state.status).not.toBe("in_use");
    expect(state.first_opened_at).toBeNull();
  });

  it("SO-T-27 a wrong PIN is refused and a PIN that is not 6 digits is rejected, the ticket stays unopened", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    const wrong = credential.pin === "000000" ? "000001" : "000000";

    expectDoorRefused(
      await doorCheck({ ticketId: bought.ticketId, pin: wrong }),
    );
    for (const pin of ["12", "1234567", "abcdef", ""]) {
      const malformed = await doorCheck({ ticketId: bought.ticketId, pin });
      expect([400, 422], JSON.stringify(malformed.body)).toContain(
        malformed.status,
      );
    }
    // The PIN of another ticket never opens this one.
    const other = await paidTicket();
    const otherCredential = await mintOk(other);
    expectDoorRefused(
      await doorCheck({ ticketId: bought.ticketId, pin: otherCredential.pin }),
    );
    expect((await ticketState(bought.ticketId)).status).toBe("issued");
    expect((await ticketState(other.ticketId)).status).toBe("issued");
  });

  it("SO-T-28 a body with both shapes, neither shape or extra fields is rejected", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    for (const body of [
      {},
      {
        qrToken: credential.qrToken,
        ticketId: bought.ticketId,
        pin: credential.pin,
      },
      { ...byQr(credential), extra: true },
      { ticketId: bought.ticketId },
    ]) {
      const response = await doorCheck(body);
      expect([400, 422], JSON.stringify(response.body)).toContain(
        response.status,
      );
    }
    expect((await ticketState(bought.ticketId)).status).toBe("issued");
  });

  it("SO-T-29 the door does not accept before valid_from: the minted window (the sale slot, tomorrow) is still in the future", async () => {
    const bought = await paidTicket();
    // Default window as minted: not opened by the test.
    const credential = await mintOk(bought, randomUUID(), false);
    const row = await credentialRow(bought.ticketId);
    expect(row!.revoked_at).toBeNull();
    expectDoorRefused(await doorCheck(byQr(credential)));
    expectDoorRefused(await doorCheck(byPin(bought, credential)));
    const state = await ticketState(bought.ticketId);
    expect(state.status).toBe("issued");
    expect(state.first_opened_at).toBeNull();
  });

  it("SO-T-31 the door does not accept after valid_until", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought, randomUUID(), false);
    await setCredentialWindow(bought.ticketId, "-2 hours", "-1 hour");
    expectDoorRefused(await doorCheck(byQr(credential)));
    expectDoorRefused(await doorCheck(byPin(bought, credential)));
    expect((await ticketState(bought.ticketId)).status).toBe("issued");
  });

  it("SO-T-30 another tenant cannot check this tenant's ticket; an anonymous caller gets 401", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);

    expectDoorRefused(
      await doorCheck(byQr(credential), otherDoorStaff, otherHeaders),
    );
    expectDoorRefused(
      await doorCheck(byPin(bought, credential), otherDoorStaff, otherHeaders),
    );
    expect((await ticketState(bought.ticketId)).status).toBe("issued");

    const anonymous = await agent(app)
      .post("/api/facility/tickets/door-check")
      .set(headers)
      .set(originHeader)
      .send(byQr(credential));
    expect(anonymous.status).toBe(401);
    expect((await ticketState(bought.ticketId)).status).toBe("issued");
  });
});
