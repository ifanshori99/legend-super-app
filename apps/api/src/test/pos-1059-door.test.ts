// POS 936 second-opinion round 2, area A (door and ticket), brief 1059.
// Written from the second-opinion report 1058 (R2-02..R2-06), the brief
// (legend-0xt77, legend-g7l20) and the observable contract used by
// pos-936-so-ticket.test.ts, not from the service code.
//
// Contract reused (see pos-936-so-ticket.test.ts for the full text):
//   POST /api/facility/tickets/door-check { facilityId, qrToken | ticketId+pin }
//   200 opens a paid ticket (status in_use, first_opened_at set once);
//   403 DOOR_CREDENTIAL_INVALID for every credential failure (uniform);
//   429 DOOR_PIN_LOCKED after 5 wrong PINs for one ticket.
//
// ASSUMPTIONS (each is also in the report):
//   - R2-02: the pre-0672 state is simulated by deleting the key history rows
//     of the ticket (the minted_key column of the credential still holds key
//     A). A replay of A after a newer mint must be 409 TICKET_CREDENTIAL_SHOWN
//     and leave version and digests alone. This holds when the old key is
//     archived before it is overwritten (or when a replay without history is
//     refused). A backfill that runs ONLY inside the migration cannot satisfy
//     it, because the test cannot re-run a migration.
//   - R2-03: the credential window ends 2 seconds after the setup. The test
//     holds the ticket row lock (a transaction that rolls back, no change) past
//     that moment. If the request is slow and never reaches the lock, it is
//     refused by the window anyway; the test cannot fail for timing.
//   - R2-04 / 0xt77: churn is 10,100 unknown ticket ids (above the 10,000 key
//     map of the old counter), once from the same tenant and once from
//     another tenant. Locked ticket T must stay 429. The lock must survive a
//     fresh app instance (module state reset), i.e. it lives in the database.
//   - R2-05: the acting-staff token is issued on a shared-mode device of
//     outlet A for a staff member whose role covers the whole tenant. A ticket
//     of outlet B stays unopened: unknown or wrong credentials answer the
//     uniform 403, a matching QR/PIN answers ACTING_STAFF_OUTLET_MISMATCH
//     (1128, CTO 19 Nov: after the credential matched, no ticket data).
//   - R2-06: the sale is stalled at the insert of the ticket row (a temporary
//     trigger waits on an advisory lock the test holds), the device is switched
//     to training in the meantime. Either outcome is accepted: the sale is
//     refused 409 TICKET_TRAINING_REFUSED with no leftovers, or it completes
//     as a normal (not training) order. Never a training order with a ticket.
//   - g7l20: a training device is refused with the same uniform 403 as any
//     other credential failure (same code and message), for QR and PIN.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { posTicketSaleSchema } from "@starter/shared/pos/ticket";
import { ACTING_STAFF_HEADER } from "@starter/shared/pos/acting-staff";
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
import { registerTestDevice } from "./device-seed.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  fixtures,
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
const TICKET_TOTAL_IDR = 77_000;
const POINT_VALUE_IDR = 70;
const CHURN_SIZE = 10_100;

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };
let otherTenant: IsolatedTenant;
let otherHeaders: { Host: string };

type Staff = { client: ReturnType<typeof agent>; userId: string };
let cashier: Staff;
let cashierB: Staff;
let raceCashier: Staff;
let doorStaff: Staff;
let otherDoorStaff: Staff;
let sharedSession: Staff;
let doorRoleId: string;
let deviceId: string;
let trainingDeviceId: string;
let actingDeviceId: string;
let deviceBId: string;
let raceDeviceId: string;
let outletB: string;
const devices = new Map<string, { tenantId: string; outletId: string }>();

type Site = {
  outletId: string;
  deviceId: string;
  facilityId: string;
  areaId: string;
  productId: string;
  cashier: Staff;
};
let siteA: Site;
let siteB: Site;

const ids = {
  category: randomUUID(),
  ticketItem: randomUUID(),
  facility: randomUUID(),
  area: randomUUID(),
  product: randomUUID(),
  facilityOB: randomUUID(),
  areaOB: randomUUID(),
  productOB: randomUUID(),
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

async function staffOn(
  clientApp: Express,
  forTenant: IsolatedTenant,
  roleId: string,
  label: string,
): Promise<Staff> {
  const client = agent(clientApp);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [forTenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

const staff = (forTenant: IsolatedTenant, roleId: string, label: string) =>
  staffOn(app, forTenant, roleId, label);

async function role(
  forTenant: IsolatedTenant,
  name: string,
  permissions: string[],
): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [id, forTenant.tenantId, name, JSON.stringify(permissions)],
  );
  return id;
}

const sessionContext = () =>
  establishTenantContext({
    tenantId: tenantIdSchema.parse(tenant.tenantId),
    brandId: null,
    source: "session",
  });

async function registerDevice(
  id: string,
  outletId: string,
  label: string,
): Promise<void> {
  devices.set(id, { tenantId: tenant.tenantId, outletId });
  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId,
    deviceId: id,
    label,
  });
}

async function openShift(who: Staff, forDevice: string, outletId: string) {
  await openPosShift(
    establishScopedTenantContext(sessionContext(), { kind: "tenant" }),
    { userId: userIdSchema.parse(who.userId), deviceId: forDevice },
    outletIdSchema.parse(outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
}

beforeAll(async () => {
  app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  setPosEdcTenderPort(async (_tx, _context, input) => ({
    reference: input.reference ?? "EDC-TEST",
    approvedBy: null,
  }));
  tenant = await createIsolatedTenant(`d59-${short()}`);
  headers = { Host: tenant.hostname };
  otherTenant = await createIsolatedTenant(`d59o-${short()}`);
  otherHeaders = { Host: otherTenant.hostname };
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["pos", "qr_order", "loyalty"],
      integrationProviders: [],
    }),
  ]);
  setDeviceOutletResolver(async ({ tenantId, deviceId: id }) =>
    devices.get(id)?.tenantId === tenantId
      ? (devices.get(id)?.outletId ?? null)
      : null,
  );

  // Outlet B: a second outlet of the same tenant, brand and legal entity.
  outletB = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet B Pintu', 'Jl. Uji 2', 'Asia/Jakarta', $6, 'active')`,
    [
      outletB,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `B${short()}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );

  deviceId = randomUUID();
  trainingDeviceId = randomUUID();
  actingDeviceId = randomUUID();
  deviceBId = randomUUID();
  raceDeviceId = randomUUID();
  await registerDevice(deviceId, tenant.outletId, "Kasir A");
  await registerDevice(trainingDeviceId, tenant.outletId, "Kasir Latihan");
  await registerDevice(actingDeviceId, tenant.outletId, "Perangkat Bersama");
  await registerDevice(deviceBId, outletB, "Kasir B");
  await registerDevice(raceDeviceId, tenant.outletId, "Kasir Balapan");
  await owner.query(
    "UPDATE devices SET training_mode = true WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, trainingDeviceId],
  );
  await owner.query(
    "UPDATE devices SET shared_mode = true WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, actingDeviceId],
  );

  const cashierRole = await role(tenant, "Kasir Tiket", [
    "order.view",
    "pos.sale.create",
    "pos.payment.accept",
    "pos.void.request",
    "pos.refund.request",
    "shift.cash.operate",
  ]);
  doorRoleId = await role(tenant, "Petugas Pintu", [
    "order.view",
    "facility.booth.operate",
    "facility.access.assist",
  ]);
  cashier = await staff(tenant, cashierRole, "Kasir Tiket");
  cashierB = await staff(tenant, cashierRole, "Kasir Tiket B");
  raceCashier = await staff(tenant, cashierRole, "Kasir Balapan");
  doorStaff = await staff(tenant, doorRoleId, "Petugas Pintu");
  sharedSession = await staff(tenant, doorRoleId, "Sesi Perangkat Bersama");
  const otherDoorRole = await role(otherTenant, "Petugas Pintu Lain", [
    "order.view",
    "facility.booth.operate",
    "facility.access.assist",
  ]);
  otherDoorStaff = await staff(otherTenant, otherDoorRole, "Petugas Lain");
  await setStaffPin(
    sessionContext(),
    doorStaff.userId,
    { outletId: tenant.outletId, userId: doorStaff.userId },
    { pin: PIN },
  );
  await openShift(cashier, deviceId, tenant.outletId);
  await openShift(cashierB, deviceBId, outletB);
  await openShift(raceCashier, raceDeviceId, tenant.outletId);

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
    for (const outletId of [tenant.outletId, outletB]) {
      const priceList = randomUUID();
      await db.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
        [priceList, tenant.tenantId, outletId],
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
    }
    await db.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, doorStaff.userId],
    );
    await db.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-TKT', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, doorStaff.userId],
    );
    for (const [facilityId, areaId, productId, outletId, name] of [
      [ids.facility, ids.area, ids.product, tenant.outletId, "Shower A"],
      [ids.facilityOB, ids.areaOB, ids.productOB, outletB, "Shower B"],
    ] as const) {
      await db.query(
        `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                                 arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
         VALUES ($1, $2, $3, $4, 'shower', 20, 10, 10, $5, $6, $7)`,
        [
          facilityId,
          tenant.tenantId,
          outletId,
          name,
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
        [areaId, tenant.tenantId, outletId, facilityId],
      );
      await db.query(
        `INSERT INTO facility_products
           (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, menu_item_id)
         VALUES ($1, $2, $3, $4, 'Tiket Shower 1x', 'single', $5, 1, true, $6)`,
        [
          productId,
          tenant.tenantId,
          outletId,
          facilityId,
          TICKET_LIST_IDR,
          ids.ticketItem,
        ],
      );
    }
  });
  await seedProgram(tenant.tenantId, { pointValueIdr: POINT_VALUE_IDR });
  ids.customer = (await seedMember(tenant.tenantId)).id;

  siteA = {
    outletId: tenant.outletId,
    deviceId,
    facilityId: ids.facility,
    areaId: ids.area,
    productId: ids.product,
    cashier,
  };
  siteB = {
    outletId: outletB,
    deviceId: deviceBId,
    facilityId: ids.facilityOB,
    areaId: ids.areaOB,
    productId: ids.productOB,
    cashier: cashierB,
  };
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

function deviceToken(forDevice: string) {
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
  forDevice: string,
  host: { Host: string } = headers,
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
async function newUnit(site: Site): Promise<string> {
  const unitId = randomUUID();
  const areaId = site.areaId;
  await asOwnerTenant(tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, 'available', 0)`,
      [
        unitId,
        tenant.tenantId,
        site.outletId,
        site.facilityId,
        areaId,
        `T-${short()}`.toUpperCase(),
      ],
    ),
  );
  return unitId;
}

function saleBody(site: Site, unitId: string) {
  return {
    facilityId: site.facilityId,
    areaId: site.areaId,
    unitId,
    productId: site.productId,
    customerProfileId: ids.customer,
    timing: { kind: "slot", startsAt: slotStart() },
    idempotencyKey: randomUUID(),
  };
}

function sell(site: Site, unitId: string, forDevice: string = site.deviceId) {
  return authed(
    site.cashier.client.post("/api/facility/tickets/pos"),
    forDevice,
  ).send(saleBody(site, unitId));
}

type OrderView = { id: string; status: string; items: { id: string }[] };
type Bought = { unitId: string; ticketId: string; orderId: string };

async function buy(site: Site): Promise<Bought> {
  const unitId = await newUnit(site);
  const response = await sell(site, unitId);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const sale = posTicketSaleSchema.parse(response.body.data);
  const order = response.body.data.order as OrderView;
  return { unitId, ticketId: sale.ticket.id, orderId: order.id };
}

function posApi(site: Site) {
  const base = `/api/outlets/${encodeURIComponent(site.outletId)}/pos/orders`;
  const post = (path: string, body: Record<string, unknown>) =>
    authed(site.cashier.client.post(`${base}${path}`), site.deviceId).send({
      idempotencyKey: randomUUID(),
      ...body,
    });
  return {
    get: (orderId: string) =>
      authed(site.cashier.client.get(`${base}/${orderId}`), site.deviceId),
    submit: (orderId: string, expectedStatus: string) =>
      post(`/${orderId}/submit`, { expectedStatus }),
    cash: (orderId: string, expectedStatus: string, receivedIdr: number) =>
      post(`/${orderId}/tenders`, {
        method: "cash",
        receivedIdr,
        expectedStatus,
      }),
    complete: (orderId: string, expectedStatus: string) =>
      post(`/${orderId}/complete`, { expectedStatus }),
  };
}

async function readOrder(site: Site, orderId: string): Promise<OrderView> {
  const read = await posApi(site).get(orderId);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data as OrderView;
}

/** Sells, pays in cash and completes: the ticket becomes `issued`. */
async function paidTicket(site: Site = siteA): Promise<Bought> {
  const bought = await buy(site);
  let order = await readOrder(site, bought.orderId);
  if (order.status === "draft") {
    const submitted = await posApi(site).submit(bought.orderId, order.status);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    order = await readOrder(site, bought.orderId);
  }
  const paid = await posApi(site).cash(
    bought.orderId,
    order.status,
    TICKET_TOTAL_IDR,
  );
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const status = (await readOrder(site, bought.orderId)).status;
  const done = await posApi(site).complete(bought.orderId, status);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return bought;
}

type Credential = { qrToken: string; pin: string };

function credentialCall(
  site: Site,
  bought: Bought,
  key: string = randomUUID(),
) {
  return authed(
    site.cashier.client.post(
      `/api/pos/orders/${bought.orderId}/tickets/${encodeURIComponent(bought.ticketId)}/credential`,
    ),
    site.deviceId,
  ).send({ idempotencyKey: key });
}

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

/** Mints a credential and opens its window around now. */
async function mintOk(
  bought: Bought,
  site: Site = siteA,
  key: string = randomUUID(),
  window: [string, string] | null = ["-1 hour", "2 hours"],
): Promise<Credential> {
  const response = await credentialCall(site, bought, key);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  if (window) await setCredentialWindow(bought.ticketId, window[0], window[1]);
  return response.body.data.credential as Credential;
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

type TicketRow = { status: string; first_opened_at: string | null };

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

async function expectUnopened(ticketId: string) {
  const state = await ticketState(ticketId);
  expect(state.status).toBe("issued");
  expect(state.first_opened_at).toBeNull();
}

function doorCheck(
  body: Record<string, unknown>,
  who: Staff = doorStaff,
  host: { Host: string } = headers,
  facilityId: string = ids.facility,
) {
  return who.client
    .post("/api/facility/tickets/door-check")
    .set(host)
    .set(originHeader)
    .send({ facilityId, ...body });
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

function expectOutletMismatch(response: {
  status: number;
  body: { error?: { code?: string }; code?: string };
}) {
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(errorCode(response.body)).toBe("ACTING_STAFF_OUTLET_MISMATCH");
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

const wrongPinFor = (credential: Credential, index: number) => {
  const pin = String(100_000 + index * 111_111).slice(0, 6);
  return pin === credential.pin ? "999999" : pin;
};

// ---- R2-02: keys minted before the history table existed -----------------------------

describe("R2-02 replay of a key minted before the key history existed", () => {
  /** A is minted, its history row is lost (the pre-0672 upgrade), then B is minted. */
  async function legacyKeyScenario() {
    const bought = await paidTicket();
    const keyA = randomUUID();
    const a = await mintOk(bought, siteA, keyA);
    await asOwnerTenant(tenant.tenantId, (db) =>
      db.query(
        `DELETE FROM access_ticket_credential_keys
          WHERE tenant_id = $1 AND access_ticket_id = $2`,
        [tenant.tenantId, ulidToUuid(bought.ticketId)],
      ),
    );
    const b = await mintOk(bought, siteA, randomUUID());
    expect(b.qrToken).not.toBe(a.qrToken);
    return { bought, keyA, a, b };
  }

  it("R2-02-a replaying the legacy key A after a new mint B is 409 TICKET_CREDENTIAL_SHOWN and B's version and digests never change", async () => {
    const { bought, keyA, a, b } = await legacyKeyScenario();
    const before = await credentialRow(bought.ticketId);

    const replay = await credentialCall(siteA, bought, keyA);
    expect(replay.status, JSON.stringify(replay.body)).toBe(409);
    expect(errorCode(replay.body)).toBe("TICKET_CREDENTIAL_SHOWN");
    expect(JSON.stringify(replay.body)).not.toContain(a.qrToken);
    expect(JSON.stringify(replay.body)).not.toContain(b.qrToken);

    const after = await credentialRow(bought.ticketId);
    expect(after!.version).toBe(before!.version);
    expect(after!.qr_digest).toBe(before!.qr_digest);
    expect(after!.pin_digest).toBe(before!.pin_digest);
    expect(after!.revoked_at).toBeNull();

    // B still opens the door, A does not.
    expectDoorRefused(await doorCheck(byQr(a)));
    expectDoorOpened(await doorCheck(byQr(b)), bought.ticketId);
  });

  it("R2-02-b concurrent replays of the legacy key A all fail and never rotate B", async () => {
    const { bought, keyA, b } = await legacyKeyScenario();
    const before = await credentialRow(bought.ticketId);

    const replies = await Promise.all(
      Array.from({ length: 6 }, () => credentialCall(siteA, bought, keyA)),
    );
    for (const reply of replies) {
      expect(reply.status, JSON.stringify(reply.body)).toBe(409);
      expect(errorCode(reply.body)).toBe("TICKET_CREDENTIAL_SHOWN");
    }
    const after = await credentialRow(bought.ticketId);
    expect(after!.version).toBe(before!.version);
    expect(after!.qr_digest).toBe(before!.qr_digest);
    expect(after!.pin_digest).toBe(before!.pin_digest);
    expectDoorOpened(await doorCheck(byQr(b)), bought.ticketId);
  });

  it("R2-02-c a brand-new key still rotates after the legacy replay was refused", async () => {
    const { bought, keyA } = await legacyKeyScenario();
    const before = await credentialRow(bought.ticketId);
    await credentialCall(siteA, bought, keyA);

    const c = await mintOk(bought, siteA, randomUUID());
    const after = await credentialRow(bought.ticketId);
    expect(after!.version).toBeGreaterThan(before!.version);
    expect(after!.qr_digest).not.toBe(before!.qr_digest);
    expectDoorOpened(await doorCheck(byQr(c)), bought.ticketId);
  });
});

// ---- R2-03: the door reads the database clock after the ticket lock ------------------

describe("R2-03 door check uses the database clock after the ticket lock", () => {
  /**
   * Holds the row lock of the ticket in a transaction that rolls back without
   * changing anything, fires the check, keeps the lock until the credential
   * window has ended, then releases it.
   */
  async function checkAcrossWindowEnd(
    bought: Bought,
    body: Record<string, unknown>,
  ) {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [tenant.tenantId],
      );
      await client.query(
        "SELECT id FROM access_tickets WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
        [tenant.tenantId, ulidToUuid(bought.ticketId)],
      );
      const { rows } = await client.query<{ ended: string }>(
        `SELECT valid_until::text AS ended FROM access_ticket_credentials
          WHERE tenant_id = $1 AND access_ticket_id = $2`,
        [tenant.tenantId, ulidToUuid(bought.ticketId)],
      );
      const validUntil = rows[0]!.ended;
      const pending = Promise.resolve(doorCheck(body));
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const { rows: clock } = await client.query<{ over: boolean }>(
          "SELECT clock_timestamp() > $1::timestamptz + interval '300 milliseconds' AS over",
          [validUntil],
        );
        if (clock[0]!.over) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await client.query("ROLLBACK");
      return await pending;
    } finally {
      client.release();
    }
  }

  it("R2-03-a a QR check that waited for the ticket lock past valid_until is 403 and the ticket stays unopened", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought, siteA, randomUUID(), [
      "-1 hour",
      "2 seconds",
    ]);
    const response = await checkAcrossWindowEnd(bought, byQr(credential));
    expectDoorRefused(response);
    await expectUnopened(bought.ticketId);
  });

  it("R2-03-b a PIN check that waited for the ticket lock past valid_until is 403 and the ticket stays unopened", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought, siteA, randomUUID(), [
      "-1 hour",
      "2 seconds",
    ]);
    const response = await checkAcrossWindowEnd(
      bought,
      byPin(bought, credential),
    );
    expectDoorRefused(response);
    await expectUnopened(bought.ticketId);
  });
});

// ---- R2-04 / 0xt77: PIN guess limit in the database ----------------------------------

async function churnUnknownTickets(
  total: number,
  who: Staff,
  host: { Host: string },
) {
  let next = 0;
  const worker = async () => {
    while (next < total) {
      next += 1;
      const pin = String(100_000 + Math.floor(Math.random() * 899_999));
      await doorCheck({ ticketId: createUlid(), pin }, who, host);
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
}

async function lockTicket(bought: Bought, credential: Credential) {
  for (let index = 0; index < 5; index += 1)
    expectDoorRefused(
      await doorCheck({
        ticketId: bought.ticketId,
        pin: wrongPinFor(credential, index),
      }),
    );
  const locked = await doorCheck(byPin(bought, credential));
  expect(locked.status, JSON.stringify(locked.body)).toBe(429);
  expect(errorCode(locked.body)).toBe("DOOR_PIN_LOCKED");
}

describe("R2-04 / legend-0xt77 the PIN guess limit cannot be reset", () => {
  it("R2-04-a churn of 10,100 unknown ticket ids from the same tenant does not unlock a locked ticket", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    await lockTicket(bought, credential);

    await churnUnknownTickets(CHURN_SIZE, doorStaff, headers);

    const after = await doorCheck(byPin(bought, credential));
    expect(after.status, JSON.stringify(after.body)).toBe(429);
    expect(errorCode(after.body)).toBe("DOOR_PIN_LOCKED");
    await expectUnopened(bought.ticketId);
  }, 600_000);

  it("R2-04-b churn of 10,100 unknown ticket ids from another tenant does not unlock a locked ticket", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    await lockTicket(bought, credential);

    await churnUnknownTickets(CHURN_SIZE, otherDoorStaff, otherHeaders);

    const after = await doorCheck(byPin(bought, credential));
    expect(after.status, JSON.stringify(after.body)).toBe(429);
    expect(errorCode(after.body)).toBe("DOOR_PIN_LOCKED");
    await expectUnopened(bought.ticketId);
  }, 600_000);

  it("R2-04-c only failed lookups count: right-PIN re-entries between wrong PINs do not add to the 5 guesses", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    for (let index = 0; index < 4; index += 1)
      expectDoorRefused(
        await doorCheck({
          ticketId: bought.ticketId,
          pin: wrongPinFor(credential, index),
        }),
      );
    for (let index = 0; index < 3; index += 1)
      expectDoorOpened(
        await doorCheck(byPin(bought, credential)),
        bought.ticketId,
      );
    // This is only the 5th wrong PIN: still a plain refusal, not a lock.
    expectDoorRefused(
      await doorCheck({
        ticketId: bought.ticketId,
        pin: wrongPinFor(credential, 4),
      }),
    );
    const locked = await doorCheck(byPin(bought, credential));
    expect(locked.status, JSON.stringify(locked.body)).toBe(429);
    expect(errorCode(locked.body)).toBe("DOOR_PIN_LOCKED");
  });

  it("R2-04-d wrong PINs for unknown ticket ids do not lock a real ticket (each lock is per ticket)", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    for (let index = 0; index < 8; index += 1)
      expectDoorRefused(
        await doorCheck({ ticketId: createUlid(), pin: credential.pin }),
      );
    expectDoorOpened(
      await doorCheck(byPin(bought, credential)),
      bought.ticketId,
    );
  });

  it("R2-04-e the lock is shared between instances: a fresh app instance (module state reset) still answers 429 for a locked ticket", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);
    await lockTicket(bought, credential);

    vi.resetModules();
    const fresh = await import("../app.ts");
    const secondApp = fresh.createApp();
    const secondStaff = await staffOn(
      secondApp,
      tenant,
      doorRoleId,
      "Petugas Instans Dua",
    );
    const response = await doorCheck(byPin(bought, credential), secondStaff);
    expect(response.status, JSON.stringify(response.body)).toBe(429);
    expect(errorCode(response.body)).toBe("DOOR_PIN_LOCKED");
    await expectUnopened(bought.ticketId);
  }, 120_000);
});

// ---- R2-05: acting-staff token limits the door to its outlet -------------------------

describe("R2-05 door check respects the outlet of the acting-staff token", () => {
  async function actingToken(): Promise<string> {
    const response = await authed(
      sharedSession.client.post("/api/staff-pins/pos-session"),
      actingDeviceId,
    ).send({ userId: doorStaff.userId, pin: PIN });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.token as string;
  }

  function actingDoorCheck(
    token: string,
    body: Record<string, unknown>,
    facilityId: string,
  ) {
    return authed(
      sharedSession.client.post("/api/facility/tickets/door-check"),
      actingDeviceId,
    )
      .set(ACTING_STAFF_HEADER, token)
      .send({ facilityId, ...body });
  }

  it("R2-05-a with a token and device of outlet A, the right QR and PIN of a ticket of outlet B answer 403 ACTING_STAFF_OUTLET_MISMATCH (1128) with no ticket data, and the ticket stays unopened; a ticket of outlet A opens", async () => {
    const token = await actingToken();
    const ticketA = await paidTicket(siteA);
    const credentialA = await mintOk(ticketA, siteA);
    const ticketB = await paidTicket(siteB);
    const credentialB = await mintOk(ticketB, siteB);

    const byQrB = await actingDoorCheck(
      token,
      byQr(credentialB),
      ids.facilityOB,
    );
    const byPinB = await actingDoorCheck(
      token,
      byPin(ticketB, credentialB),
      ids.facilityOB,
    );
    for (const response of [byQrB, byPinB]) {
      expectOutletMismatch(response);
      // The 403 carries no data of the ticket of the other outlet.
      expect(response.body.data).toBeUndefined();
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain(ticketB.ticketId);
      expect(raw).not.toContain(credentialB.qrToken);
      expect(raw).not.toContain(credentialB.pin);
    }
    await expectUnopened(ticketB.ticketId);

    // Control: the same staff, token and device open the ticket of outlet A.
    expectDoorOpened(
      await actingDoorCheck(token, byQr(credentialA), ids.facility),
      ticketA.ticketId,
    );
  });

  it("R2-05-b the mismatch answer comes only AFTER the credential matched: an unknown QR, a wrong PIN or an unknown ticket of the other outlet stay the uniform DOOR_CREDENTIAL_INVALID (no oracle)", async () => {
    const token = await actingToken();
    const ticketB = await paidTicket(siteB);
    const credentialB = await mintOk(ticketB, siteB);

    const unknown = await actingDoorCheck(
      token,
      { qrToken: `guess-${short()}` },
      ids.facility,
    );
    const wrongPinOtherOutlet = await actingDoorCheck(
      token,
      { ticketId: ticketB.ticketId, pin: wrongPinFor(credentialB, 1) },
      ids.facilityOB,
    );
    expectDoorRefused(unknown);
    expectDoorRefused(wrongPinOtherOutlet);
    expect(wrongPinOtherOutlet.body.error.message).toBe(
      unknown.body.error.message,
    );
    // The ticket of the other outlet was never opened and never named.
    expect(JSON.stringify(wrongPinOtherOutlet.body)).not.toContain(
      ticketB.ticketId,
    );
    await expectUnopened(ticketB.ticketId);
  });

  it("R2-05-c without a token the tenant-wide staff still opens the ticket of outlet B (the cut applies only to the outlet token)", async () => {
    const ticketB = await paidTicket(siteB);
    const credentialB = await mintOk(ticketB, siteB);
    expectDoorOpened(
      await doorCheck(byQr(credentialB), doorStaff, headers, ids.facilityOB),
      ticketB.ticketId,
    );
  });
});

// ---- R2-06: a device switched to training while the sale waits ----------------------

describe("R2-06 training switch during a ticket sale", () => {
  const stallKey = 905_900_000 + Math.floor(Math.random() * 1000);

  async function ordersCount(): Promise<number> {
    const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM orders WHERE tenant_id = $1",
        [tenant.tenantId],
      ),
    );
    return Number(rows[0]?.n);
  }

  async function ticketsOnUnit(unitId: string): Promise<number> {
    const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
      db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM access_tickets WHERE tenant_id = $1 AND unit_id = $2",
        [tenant.tenantId, unitId],
      ),
    );
    return Number(rows[0]?.n);
  }

  async function trainingOrderIsTicketed(orderId: string): Promise<boolean> {
    const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
      db.query<{ is_training: boolean; lines: string }>(
        `SELECT p.is_training,
                (SELECT count(*)::text FROM facility_ticket_pos_lines l
                  WHERE l.tenant_id = p.tenant_id AND l.order_id = p.order_id) AS lines
           FROM pos_orders p WHERE p.tenant_id = $1 AND p.order_id = $2`,
        [tenant.tenantId, ulidToUuid(orderId)],
      ),
    );
    return rows[0]?.is_training === true && Number(rows[0].lines) > 0;
  }

  it("R2-06-a the device switches to training while the sale waits: the sale is refused with no leftovers, or it stays a normal order; never a training order with a real ticket", async () => {
    const unitId = await newUnit({ ...siteA, deviceId: raceDeviceId });
    const raceSite: Site = {
      ...siteA,
      deviceId: raceDeviceId,
      cashier: raceCashier,
    };
    const ordersBefore = await ordersCount();

    // The stall: the insert of a ticket row for this unit waits on an advisory
    // lock held by the test (a temporary trigger; dropped in the finally).
    const blocker = await owner.connect();
    const name = `d59_stall_${stallKey}`;
    try {
      const { rows } = await blocker.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const blockerPid = rows[0]!.pid;
      await blocker.query("SELECT pg_advisory_lock($1)", [stallKey]);
      await owner.query(`
        CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN PERFORM pg_advisory_xact_lock(${stallKey}); RETURN NEW; END $f$`);
      await owner.query(`
        CREATE TRIGGER ${name} BEFORE INSERT ON access_tickets
        FOR EACH ROW WHEN (NEW.unit_id = '${unitId}'::uuid) EXECUTE FUNCTION ${name}()`);

      const sale = Promise.resolve(sell(raceSite, unitId));
      // Wait (bounded) until the sale is parked on the stall.
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const { rows: waiters } = await owner.query(
          `SELECT pid FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND $1::int = ANY(pg_blocking_pids(pid)) LIMIT 1`,
          [blockerPid],
        );
        if (waiters[0]) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      // The admin switches the device to training meanwhile. The switch may
      // wait for the sale (that is a valid fix), so it is not awaited here.
      let switched = false;
      const flip = owner
        .query(
          "UPDATE devices SET training_mode = true WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, raceDeviceId],
        )
        .then(() => {
          switched = true;
        });
      for (let attempt = 0; attempt < 40 && !switched; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 25));

      await blocker.query("SELECT pg_advisory_unlock_all()");
      const [response] = await Promise.all([sale, flip]);

      if (response.status === 409) {
        expect(errorCode(response.body)).toBe("TICKET_TRAINING_REFUSED");
        expect(await ticketsOnUnit(unitId)).toBe(0);
        expect(await ordersCount()).toBe(ordersBefore);
      } else {
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const orderId = (response.body.data.order as OrderView).id;
        expect(await trainingOrderIsTicketed(orderId)).toBe(false);
      }
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()").catch(() => {});
      await owner
        .query(`DROP TRIGGER IF EXISTS ${name} ON access_tickets`)
        .catch(() => {});
      await owner.query(`DROP FUNCTION IF EXISTS ${name}()`).catch(() => {});
      blocker.release();
    }
  });
});

// ---- legend-g7l20: a training device cannot open the door ----------------------------

describe("legend-g7l20 door check from a training-mode device", () => {
  const fromDevice = (
    forDevice: string,
    body: Record<string, unknown>,
    who: Staff = doorStaff,
  ) =>
    authed(who.client.post("/api/facility/tickets/door-check"), forDevice).send(
      { facilityId: ids.facility, ...body },
    );

  it("g7l20-a a valid QR from a training device is refused (uniform 403, same message as any other refusal) and the ticket stays unopened", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);

    const refused = await fromDevice(trainingDeviceId, byQr(credential));
    expectDoorRefused(refused);
    const baseline = await fromDevice(deviceId, {
      qrToken: `guess-${short()}`,
    });
    expectDoorRefused(baseline);
    expect(refused.body.error.message).toBe(baseline.body.error.message);
    await expectUnopened(bought.ticketId);

    // Control: the same credential opens the door from a normal device.
    expectDoorOpened(
      await fromDevice(deviceId, byQr(credential)),
      bought.ticketId,
    );
  });

  it("g7l20-b a valid PIN from a training device is refused, does not count as a wrong guess, and the ticket stays unopened", async () => {
    const bought = await paidTicket();
    const credential = await mintOk(bought);

    for (let attempt = 0; attempt < 6; attempt += 1)
      expectDoorRefused(
        await fromDevice(trainingDeviceId, byPin(bought, credential)),
      );
    await expectUnopened(bought.ticketId);

    // The training refusals never locked the PIN of the real ticket.
    expectDoorOpened(
      await fromDevice(deviceId, byPin(bought, credential)),
      bought.ticketId,
    );
  });
});
