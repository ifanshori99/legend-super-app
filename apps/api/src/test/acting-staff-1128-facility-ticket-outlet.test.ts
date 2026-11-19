// Brief 1128 (bead legend-wpele): facility POS ticket routes must check the
// OUTLET of the target against the outlet of a cashier PIN token
// (X-Acting-Staff), like the order-recovery routes of brief 1120.
//
// Written from docs/briefs/1128-door-check-outlet-token.md, the 1120 test
// (acting-staff-1120-order-recovery-outlet.test.ts) and the shared contract
// (packages/shared/src/facility/endpoints.ts, packages/shared/src/pos/ticket.ts),
// not from the route or service code.
//
// Routes covered:
//  - POST /api/facility/tickets/door-check      (main target of the brief)
//  - POST /api/facility/tickets/pos             (sell a ticket at the cashier)
//  - POST /api/pos/orders/:orderId/tickets/:ticketId/credential
//  - GET  /api/pos/orders/:orderId/tickets      (see assumption 6)
//
// Contract (brief 1128 + 1120 shared context):
//  - A cashier staffed at outlets A and B, signed in with a PIN on outlet B's
//    tablet (token outlet = B), acting on a ticket of outlet A: 403
//    ACTING_STAFF_OUTLET_MISMATCH. The outlet of the ticket is looked up on the
//    server, never taken from the body. The refused call changes nothing.
//  - Same outlet (token A, ticket A): not refused with that code. For door-check
//    the ticket opens (200, `in_use`).
//  - A personal login (no token) is unchanged: never answered with that code,
//    even for a ticket of the other outlet the user is staffed at.
//  - A ticket that cannot be found, with a token: refused 403 (fail closed).
//
// Assumptions (spec silent):
//  1. To get "token of outlet B, ticket of outlet A" without moving rows between
//     outlets (composite FKs forbid it), the SAME paid ticket of outlet A is
//     hit from two tablets: tablet A (token outlet A) and tablet B (token
//     outlet B). Both are registered devices WITHOUT shared_mode, so no earlier
//     rule (SHARED_DEVICE_SCREEN_CLOSED) can answer before the outlet check.
//  2. The cashier and the tablet login both hold every permission the routes
//     need at outlets A and B, so a refusal is never about permissions.
//  3. The door-check body is valid (right facility of the ticket, a credential
//     window opened around now, the real QR token or PIN), so the ONLY reason to
//     refuse is the outlet of the token. The refused ticket stays `issued`
//     with `first_opened_at` null.
//  4. Door-check keeps its uniform-refusal contract (no oracle): the outlet
//     is compared only AFTER the credential matched (coordinator design, so a
//     guess cannot probe outlets). An UNKNOWN ticket or QR token, with or
//     without a token, stays exactly 403 DOOR_CREDENTIAL_INVALID. A VALID
//     credential of another outlet's ticket with a token gets 403
//     ACTING_STAFF_OUTLET_MISMATCH and the ticket stays unused. A WRONG PIN
//     still counts toward the 5-try lock (429 DOOR_PIN_LOCKED); a MATCHING PIN
//     refused for the outlet KEEPS its attempt slot, so 5 such attempts lock
//     the PIN path (the 6th answers 429 DOOR_PIN_LOCKED).
//  5. For sell, credential and list the same-outlet control asserts only "not
//     OUTLET_MISMATCH" (money and shift rules may legitimately refuse); an
//     unknown order with a token is rejected (any 4xx, never 2xx; those routes
//     already compare the outlet today, the exact code is not in the contract).
//  6. The list (GET) route is read-only. The brief says "route facility-pos-ticket
//     lain yang memakai token kasir"; if the CTO decides reads are exempt, drop
//     the "list" describe block only.
//  7. A sale with a token for outlet B on a unit of outlet A is refused by the
//     facility/unit outlet (looked up server-side), before a hold or bill exists.

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
  uuidToUlid,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { PosReceipt } from "@starter/shared/pos";
import { posTicketSaleSchema } from "@starter/shared/pos/ticket";
import { ACTING_STAFF_ERROR_CODES } from "@starter/shared/pos/acting-staff";
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
  owner,
  type IsolatedTenant,
} from "./floor-test-helpers.ts";
import {
  owner as memberOwner,
  seedMember,
  seedProgram,
} from "./member-loyalty-helpers.ts";

const ACTING_HEADER = "X-Acting-Staff";
const PIN = "582914";
const TICKET_LIST_IDR = 70_000;
const TICKET_TOTAL_IDR = 77_000;
const MISMATCH = ACTING_STAFF_ERROR_CODES.OUTLET_MISMATCH;

let app: Express;
let tenant: IsolatedTenant;
let headers: { Host: string };

type Staff = { client: ReturnType<typeof agent>; userId: string };
/** Tenant-scoped cashier that sells, pays and mints credentials (fixtures only). */
let cashier: Staff;
/** Staffed at BOTH outlets: personal login and PIN-token owner. */
let cashierAB: Staff;
/** Login of the shared tablets, staffed at both outlets. */
let tabletLogin: Staff;
let outletB: string;
let deviceId: string;
/** Registered POS devices WITHOUT shared_mode: tablet A (outlet A), tablet B. */
let tabletA: string;
let tabletB: string;
const devices = new Map<string, { tenantId: string; outletId: string }>();

const ids = {
  category: randomUUID(),
  ticketItem: randomUUID(),
  facility: randomUUID(),
  area: randomUUID(),
  product: randomUUID(),
  customer: "",
};

const short = () => randomUUID().slice(0, 6);
type Body = { error?: { code?: string }; code?: string; data?: unknown };
type Response = { status: number; body: Body };
const errorCode = (body: Body) => body?.error?.code ?? body?.code;

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
    async voidForOrder() {
      return null;
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
  roleId: string,
  scopes: ({ type: "tenant" } | { type: "outlet"; outletId: string })[],
  label: string,
): Promise<Staff> {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  for (const scope of scopes)
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute', $2)`,
      [
        tenant.tenantId,
        userId,
        roleId,
        scope.type,
        scope.type === "outlet" ? scope.outletId : null,
      ],
    );
  return { client, userId };
}

async function role(name: string, permissions: string[]): Promise<string> {
  const id = randomUUID();
  await owner.query(
    `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
     VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
    [id, tenant.tenantId, name, JSON.stringify(permissions)],
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
  tenant = await createIsolatedTenant(`t28-${short()}`);
  headers = { Host: tenant.hostname };
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["pos", "qr_order", "loyalty"],
      integrationProviders: [],
    }),
  ]);
  deviceId = randomUUID();
  tabletA = randomUUID();
  tabletB = randomUUID();
  outletB = randomUUID();
  for (const id of [deviceId, tabletA])
    devices.set(id, { tenantId: tenant.tenantId, outletId: tenant.outletId });
  devices.set(tabletB, { tenantId: tenant.tenantId, outletId: outletB });
  setDeviceOutletResolver(async ({ tenantId, deviceId: id }) =>
    devices.get(id)?.tenantId === tenantId
      ? (devices.get(id)?.outletId ?? null)
      : null,
  );

  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     SELECT $2, tenant_id, brand_id, legal_entity_id, $3, 'Outlet Tiket B', address, timezone, opening_hours, status
       FROM outlets WHERE id = $1`,
    [tenant.outletId, outletB, `TKB-${short()}`.toUpperCase()],
  );

  const fixtureRole = await role("Kasir Tiket 1128", [
    "order.view",
    "pos.sale.create",
    "pos.payment.accept",
    "shift.cash.operate",
  ]);
  // Every permission the facility ticket routes need, at both outlets.
  const twoOutletRole = await role("Kasir Dua Outlet 1128", [
    "order.view",
    "pos.sale.create",
    "pos.payment.accept",
    "shift.cash.operate",
    "facility.booth.operate",
    "facility.access.assist",
  ]);
  cashier = await staff(fixtureRole, [{ type: "tenant" }], "Kasir Fixture");
  const both = [
    { type: "outlet", outletId: tenant.outletId },
    { type: "outlet", outletId: outletB },
  ] as const;
  cashierAB = await staff(twoOutletRole, [...both], "Kasir Dua Outlet");
  tabletLogin = await staff(twoOutletRole, [...both], "Login Tablet Tiket");

  await registerTestDevice(owner, {
    tenantId: tenant.tenantId,
    outletId: tenant.outletId,
    deviceId,
  });
  for (const [id, outletId, label] of [
    [tabletA, tenant.outletId, "Tablet A 1128"],
    [tabletB, outletB, "Tablet B 1128"],
  ] as const)
    await owner.query(
      `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at, shared_mode)
       VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute', false)`,
      [id, tenant.tenantId, outletId, label],
    );
  for (const outletId of [tenant.outletId, outletB])
    await setStaffPin(
      sessionContext(),
      cashierAB.userId,
      { outletId, userId: cashierAB.userId },
      { pin: PIN },
    );
  await openPosShift(
    establishScopedTenantContext(sessionContext(), { kind: "tenant" }),
    { userId: userIdSchema.parse(cashier.userId), deviceId },
    outletIdSchema.parse(tenant.outletId),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );
  // The two-outlet cashier works the till of tablet A (sell control).
  await openPosShift(
    establishScopedTenantContext(sessionContext(), { kind: "tenant" }),
    { userId: userIdSchema.parse(cashierAB.userId), deviceId: tabletA },
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
      [randomUUID(), tenant.tenantId, cashier.userId],
    );
    await db.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-TKT', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, cashier.userId],
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
    await db.query(
      `INSERT INTO facility_products
         (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, menu_item_id)
       VALUES ($1, $2, $3, $4, 'Tiket Shower 1x', 'single', $5, 1, true, $6)`,
      [
        ids.product,
        tenant.tenantId,
        tenant.outletId,
        ids.facility,
        TICKET_LIST_IDR,
        ids.ticketItem,
      ],
    );
  });
  await seedProgram(tenant.tenantId, { pointValueIdr: 70 });
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

function deviceToken(forDevice: string) {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId: forDevice,
  });
}

/** Fixture calls: tenant host, origin, the fixture cashier's device. */
const authed = (request: Test) =>
  request
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(deviceId));

/** The two-outlet cashier signs in with the PIN on tablet `forDevice`. */
async function cashierToken(forDevice: string): Promise<string> {
  const response = await tabletLogin.client
    .post("/api/staff-pins/pos-session")
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(forDevice))
    .send({ userId: cashierAB.userId, pin: PIN });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.token as string;
}

/** A call from a tablet with a cashier token (outlet of the tablet). */
const withToken = (request: Test, forDevice: string, token: string) =>
  request
    .set(headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(forDevice))
    .set(ACTING_HEADER, token);

/** A personal login: no device token, no acting header. */
const personal = (request: Test) => request.set(headers).set(originHeader);

function slotStart(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 3),
  ).toISOString();
}

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

const saleBody = (unitId: string) => ({
  facilityId: ids.facility,
  areaId: ids.area,
  unitId,
  productId: ids.product,
  customerProfileId: ids.customer,
  timing: { kind: "slot", startsAt: slotStart() },
  idempotencyKey: randomUUID(),
});

type OrderView = { id: string; status: string; items: { id: string }[] };
type Bought = { unitId: string; ticketId: string; orderId: string };

/** Fixture sale by the fixture cashier (personal login, device A). */
async function buy(): Promise<Bought> {
  const unitId = await newUnit();
  const response = await authed(
    cashier.client.post("/api/facility/tickets/pos"),
  ).send(saleBody(unitId));
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const sale = posTicketSaleSchema.parse(response.body.data);
  const order = response.body.data.order as OrderView;
  return { unitId, ticketId: sale.ticket.id, orderId: order.id };
}

function posApi() {
  const base = `/api/outlets/${encodeURIComponent(tenant.outletId)}/pos/orders`;
  const post = (path: string, body: Record<string, unknown>) =>
    authed(cashier.client.post(`${base}${path}`)).send({
      idempotencyKey: randomUUID(),
      ...body,
    });
  return {
    get: (orderId: string) => authed(cashier.client.get(`${base}/${orderId}`)),
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

async function orderStatus(orderId: string): Promise<string> {
  const read = await posApi().get(orderId);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return (read.body.data as OrderView).status;
}

/** Pays the bill in cash and completes it: the ticket becomes `issued`. */
async function payAndComplete(orderId: string) {
  if ((await orderStatus(orderId)) === "draft") {
    const submitted = await posApi().submit(orderId, "draft");
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  }
  const paid = await posApi().cash(
    orderId,
    await orderStatus(orderId),
    TICKET_TOTAL_IDR,
  );
  expect(paid.status, JSON.stringify(paid.body)).toBe(201);
  const done = await posApi().complete(orderId, await orderStatus(orderId));
  expect(done.status, JSON.stringify(done.body)).toBe(200);
}

type Credential = { qrToken: string; pin: string };
type PaidTicket = Bought & Credential;

/** A paid ticket of outlet A with a credential whose window is open now. */
async function paidTicket(): Promise<PaidTicket> {
  const bought = await buy();
  await payAndComplete(bought.orderId);
  const minted = await authed(
    cashier.client.post(
      `/api/pos/orders/${bought.orderId}/tickets/${encodeURIComponent(bought.ticketId)}/credential`,
    ),
  ).send({ idempotencyKey: randomUUID() });
  expect(minted.status, JSON.stringify(minted.body)).toBeLessThan(300);
  const credential = (minted.body.data as { credential: Credential })
    .credential;
  await asOwnerTenant(tenant.tenantId, (db) =>
    db.query(
      `UPDATE access_ticket_credentials
          SET valid_from = now() - interval '1 hour',
              valid_until = now() + interval '2 hours'
        WHERE tenant_id = $1::uuid AND access_ticket_id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(bought.ticketId)],
    ),
  );
  return { ...bought, qrToken: credential.qrToken, pin: credential.pin };
}

async function ticketState(ticketId: string) {
  const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
    db.query<{ status: string; first_opened_at: string | null }>(
      `SELECT status, first_opened_at FROM access_tickets
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, ulidToUuid(ticketId)],
    ),
  );
  return rows[0]!;
}

async function credentialVersion(ticketId: string): Promise<number | null> {
  const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
    db.query<{ version: number }>(
      `SELECT version FROM access_ticket_credentials
        WHERE tenant_id = $1 AND access_ticket_id = $2`,
      [tenant.tenantId, ulidToUuid(ticketId)],
    ),
  );
  return rows[0]?.version ?? null;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await asOwnerTenant(tenant.tenantId, (db) =>
    db.query<{ n: string }>(sql, params),
  );
  return Number(rows[0]?.n);
}

/** Audit rows of the isolated tenant: files run alone, so a delta around one call is that call's. */
const auditRowCount = () =>
  count("SELECT count(*)::text AS n FROM audit_logs WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
const ordersCount = () =>
  count("SELECT count(*)::text AS n FROM orders WHERE tenant_id = $1", [
    tenant.tenantId,
  ]);
const ticketsOnUnit = (unitId: string) =>
  count(
    "SELECT count(*)::text AS n FROM access_tickets WHERE tenant_id = $1 AND unit_id = $2",
    [tenant.tenantId, unitId],
  );

function expectMismatch(response: Response) {
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(errorCode(response.body), JSON.stringify(response.body)).toBe(
    MISMATCH,
  );
}

/** Unknown target with a token: any 4xx, never a success (exact code not in the contract). */
function expectRejected(response: Response) {
  expect(response.status, JSON.stringify(response.body)).toBeGreaterThanOrEqual(
    400,
  );
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(500);
}

function expectNotMismatch(response: Response) {
  expect(errorCode(response.body), JSON.stringify(response.body)).not.toBe(
    MISMATCH,
  );
}

// ---- door-check -------------------------------------------------------------------

type DoorShape = {
  name: string;
  body: (t: PaidTicket) => Record<string, unknown>;
};

const SHAPES: DoorShape[] = [
  {
    name: "QR token",
    body: (t) => ({ facilityId: ids.facility, qrToken: t.qrToken }),
  },
  {
    name: "ticket id and PIN",
    body: (t) => ({
      facilityId: ids.facility,
      ticketId: t.ticketId,
      pin: t.pin,
    }),
  },
];

const DOOR = "/api/facility/tickets/door-check";

describe("1128 door-check checks the outlet of a cashier token", () => {
  for (const shape of SHAPES) {
    describe(shape.name, () => {
      it("1128-door-check token of outlet B, ticket of outlet A: 403 ACTING_STAFF_OUTLET_MISMATCH, ticket stays unopened", async () => {
        const t = await paidTicket();
        const token = await cashierToken(tabletB);
        const response = (await withToken(
          tabletLogin.client.post(DOOR),
          tabletB,
          token,
        ).send(shape.body(t))) as unknown as Response;
        expectMismatch(response);
        const state = await ticketState(t.ticketId);
        expect(state.status).toBe("issued");
        expect(state.first_opened_at).toBeNull();
      });

      it("1128-door-check token of outlet A, ticket of outlet A: opens the ticket (200, in_use)", async () => {
        const t = await paidTicket();
        const token = await cashierToken(tabletA);
        const response = (await withToken(
          tabletLogin.client.post(DOOR),
          tabletA,
          token,
        ).send(shape.body(t))) as unknown as Response;
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const data = response.body.data as {
          ticket: { id: string; status: string };
        };
        expect(data.ticket.id).toBe(t.ticketId);
        expect(data.ticket.status).toBe("in_use");
        expect((await ticketState(t.ticketId)).status).toBe("in_use");
      });

      it("1128-door-check personal login (no token) of a user staffed at both outlets: unchanged, opens the ticket", async () => {
        const t = await paidTicket();
        const response = (await personal(cashierAB.client.post(DOOR)).send(
          shape.body(t),
        )) as unknown as Response;
        expectNotMismatch(response);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect((await ticketState(t.ticketId)).status).toBe("in_use");
      });
    });
  }

  it("1128-door-check after a refused mismatch the right outlet can still open the same ticket", async () => {
    const t = await paidTicket();
    const tokenB = await cashierToken(tabletB);
    expectMismatch(
      (await withToken(tabletLogin.client.post(DOOR), tabletB, tokenB).send(
        SHAPES[0]!.body(t),
      )) as unknown as Response,
    );
    const tokenA = await cashierToken(tabletA);
    const opened = await withToken(
      tabletLogin.client.post(DOOR),
      tabletA,
      tokenA,
    ).send(SHAPES[0]!.body(t));
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  });

  it("1128-door-check a ticket opened with the outlet A token, then the same credential with the outlet B token: 403 ACTING_STAFF_OUTLET_MISMATCH, ticket stays in_use, no new audit row", async () => {
    const t = await paidTicket();
    const tokenA = await cashierToken(tabletA);
    const opened = await withToken(
      tabletLogin.client.post(DOOR),
      tabletA,
      tokenA,
    ).send(SHAPES[0]!.body(t));
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const before = await ticketState(t.ticketId);
    expect(before.status).toBe("in_use");

    // The PIN sign-in of tablet B writes its own audit row: count after it, so
    // the delta is only the door-check call.
    const tokenB = await cashierToken(tabletB);
    const auditBefore = await auditRowCount();
    expectMismatch(
      (await withToken(tabletLogin.client.post(DOOR), tabletB, tokenB).send(
        SHAPES[0]!.body(t),
      )) as unknown as Response,
    );

    const after = await ticketState(t.ticketId);
    expect(after.status).toBe("in_use");
    expect(new Date(after.first_opened_at!).getTime()).toBe(
      new Date(before.first_opened_at!).getTime(),
    );
    expect(await auditRowCount()).toBe(auditBefore);
  });

  it("1128-door-check token with an unknown ticket id (PIN shape): uniform 403 DOOR_CREDENTIAL_INVALID", async () => {
    const token = await cashierToken(tabletB);
    const response = (await withToken(
      tabletLogin.client.post(DOOR),
      tabletB,
      token,
    ).send({
      facilityId: ids.facility,
      ticketId: uuidToUlid(randomUUID()),
      pin: "123456",
    })) as unknown as Response;
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(errorCode(response.body)).toBe("DOOR_CREDENTIAL_INVALID");
  });

  it("1128-door-check token with an unknown QR token: uniform 403 DOOR_CREDENTIAL_INVALID", async () => {
    const token = await cashierToken(tabletB);
    const response = (await withToken(
      tabletLogin.client.post(DOOR),
      tabletB,
      token,
    ).send({
      facilityId: ids.facility,
      qrToken: `unknown-${randomUUID()}`,
    })) as unknown as Response;
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(errorCode(response.body)).toBe("DOOR_CREDENTIAL_INVALID");
  });

  it("1128-door-check a WRONG PIN with a token still counts toward the lock: 5 wrong PINs, then 429 DOOR_PIN_LOCKED even for the right PIN", async () => {
    const t = await paidTicket();
    const token = await cashierToken(tabletA);
    const wrong = t.pin === "000000" ? "111111" : "000000";
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = (await withToken(
        tabletLogin.client.post(DOOR),
        tabletA,
        token,
      ).send({
        facilityId: ids.facility,
        ticketId: t.ticketId,
        pin: wrong,
      })) as unknown as Response;
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(errorCode(refused.body)).toBe("DOOR_CREDENTIAL_INVALID");
    }
    const locked = (await withToken(
      tabletLogin.client.post(DOOR),
      tabletA,
      token,
    ).send(SHAPES[1]!.body(t))) as unknown as Response;
    expect(locked.status, JSON.stringify(locked.body)).toBe(429);
    expect(errorCode(locked.body)).toBe("DOOR_PIN_LOCKED");
    expect((await ticketState(t.ticketId)).status).toBe("issued");
  });

  it("1128-door-check a MATCHING PIN refused for the outlet keeps its attempt slot: after 5 mismatches the 6th answers 429 DOOR_PIN_LOCKED, ticket unused", async () => {
    const t = await paidTicket();
    const token = await cashierToken(tabletB);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expectMismatch(
        (await withToken(tabletLogin.client.post(DOOR), tabletB, token).send(
          SHAPES[1]!.body(t),
        )) as unknown as Response,
      );
    }
    const locked = (await withToken(
      tabletLogin.client.post(DOOR),
      tabletB,
      token,
    ).send(SHAPES[1]!.body(t))) as unknown as Response;
    expect(locked.status, JSON.stringify(locked.body)).toBe(429);
    expect(errorCode(locked.body)).toBe("DOOR_PIN_LOCKED");
    const state = await ticketState(t.ticketId);
    expect(state.status).toBe("issued");
    expect(state.first_opened_at).toBeNull();
  });

  it("1128-door-check personal login with an unknown ticket: unchanged, uniform 403 DOOR_CREDENTIAL_INVALID", async () => {
    const response = (await personal(cashierAB.client.post(DOOR)).send({
      facilityId: ids.facility,
      ticketId: uuidToUlid(randomUUID()),
      pin: "123456",
    })) as unknown as Response;
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(errorCode(response.body)).toBe("DOOR_CREDENTIAL_INVALID");
  });
});

// ---- the other facility POS ticket routes ------------------------------------------

describe("1128 sell a ticket checks the outlet of a cashier token", () => {
  it("1128-sell token of outlet B, unit of outlet A: 403 ACTING_STAFF_OUTLET_MISMATCH, no hold, no bill", async () => {
    const unitId = await newUnit();
    const ordersBefore = await ordersCount();
    const token = await cashierToken(tabletB);
    const response = (await withToken(
      tabletLogin.client.post("/api/facility/tickets/pos"),
      tabletB,
      token,
    ).send(saleBody(unitId))) as unknown as Response;
    expectMismatch(response);
    expect(await ticketsOnUnit(unitId)).toBe(0);
    expect(await ordersCount()).toBe(ordersBefore);
  });

  it("1128-sell token of outlet A, unit of outlet A: not refused with OUTLET_MISMATCH", async () => {
    const unitId = await newUnit();
    const token = await cashierToken(tabletA);
    const response = (await withToken(
      tabletLogin.client.post("/api/facility/tickets/pos"),
      tabletA,
      token,
    ).send(saleBody(unitId))) as unknown as Response;
    expectNotMismatch(response);
  });

  it("1128-sell personal login (no token), unit of outlet A: never OUTLET_MISMATCH", async () => {
    const unitId = await newUnit();
    const response = (await personal(
      cashierAB.client.post("/api/facility/tickets/pos"),
    ).send(saleBody(unitId))) as unknown as Response;
    expectNotMismatch(response);
  });
});

describe("1128 mint a ticket credential checks the outlet of a cashier token", () => {
  const credentialPath = (t: { orderId: string; ticketId: string }) =>
    `/api/pos/orders/${t.orderId}/tickets/${encodeURIComponent(t.ticketId)}/credential`;

  it("1128-credential token of outlet B, ticket of outlet A: 403 ACTING_STAFF_OUTLET_MISMATCH, credential not rotated", async () => {
    const t = await paidTicket();
    const versionBefore = await credentialVersion(t.ticketId);
    expect(versionBefore).not.toBeNull();
    const token = await cashierToken(tabletB);
    const response = (await withToken(
      tabletLogin.client.post(credentialPath(t)),
      tabletB,
      token,
    ).send({ idempotencyKey: randomUUID() })) as unknown as Response;
    expectMismatch(response);
    expect(await credentialVersion(t.ticketId)).toBe(versionBefore);
  });

  it("1128-credential token of outlet A, ticket of outlet A: not refused with OUTLET_MISMATCH", async () => {
    const t = await paidTicket();
    const token = await cashierToken(tabletA);
    const response = (await withToken(
      tabletLogin.client.post(credentialPath(t)),
      tabletA,
      token,
    ).send({ idempotencyKey: randomUUID() })) as unknown as Response;
    expectNotMismatch(response);
  });

  it("1128-credential personal login (no token): never OUTLET_MISMATCH", async () => {
    const t = await paidTicket();
    const response = (await personal(
      cashierAB.client.post(credentialPath(t)),
    ).send({ idempotencyKey: randomUUID() })) as unknown as Response;
    expectNotMismatch(response);
  });

  it("1128-credential token with an unknown order and ticket: rejected (4xx), nothing minted", async () => {
    const token = await cashierToken(tabletB);
    const response = (await withToken(
      tabletLogin.client.post(
        credentialPath({
          orderId: uuidToUlid(randomUUID()),
          ticketId: uuidToUlid(randomUUID()),
        }),
      ),
      tabletB,
      token,
    ).send({ idempotencyKey: randomUUID() })) as unknown as Response;
    expectRejected(response);
  });
});

describe("1128 list the tickets of a bill checks the outlet of a cashier token (assumption 6)", () => {
  const listPath = (orderId: string) => `/api/pos/orders/${orderId}/tickets`;

  it("1128-list token of outlet B, bill of outlet A: 403 ACTING_STAFF_OUTLET_MISMATCH", async () => {
    const t = await paidTicket();
    const token = await cashierToken(tabletB);
    const response = (await withToken(
      tabletLogin.client.get(listPath(t.orderId)),
      tabletB,
      token,
    )) as unknown as Response;
    expectMismatch(response);
  });

  it("1128-list token of outlet A, bill of outlet A: lists the ticket", async () => {
    const t = await paidTicket();
    const token = await cashierToken(tabletA);
    const response = (await withToken(
      tabletLogin.client.get(listPath(t.orderId)),
      tabletA,
      token,
    )) as unknown as Response;
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const tickets = (
      response.body.data as { tickets: { ticket: { id: string } }[] }
    ).tickets;
    expect(tickets.map((row) => row.ticket.id)).toContain(t.ticketId);
  });

  it("1128-list personal login (no token), bill of outlet A: unchanged, lists the ticket", async () => {
    const t = await paidTicket();
    const response = (await personal(
      cashierAB.client.get(listPath(t.orderId)),
    )) as unknown as Response;
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("1128-list token with an unknown bill: rejected (4xx)", async () => {
    const token = await cashierToken(tabletB);
    const response = (await withToken(
      tabletLogin.client.get(listPath(uuidToUlid(randomUUID()))),
      tabletB,
      token,
    )) as unknown as Response;
    expectRejected(response);
  });
});
