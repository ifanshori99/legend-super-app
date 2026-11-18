// Shared fixtures for the POS 936 round 3 tests (brief 1065, findings R3-01 and
// R3-02 of second-opinion 1064). Built from the observable HTTP contract used
// by pos-1059-door.test.ts and pos-1059-arch.test.ts, not from service code.
//
// One tenant with two outlets (A = the isolated tenant's outlet, B = a second
// outlet of the same tenant). Devices:
//   normalA       normal device of outlet A
//   trainingB     device of outlet B in training mode (the R3-01 attacker)
//   normalB       normal device of outlet B
//   unknown       a validly signed token for a device the registry never saw
//   raceQr/racePin  normal devices of outlet A that R3-02 switches to training
// Staff:
//   cashier       role reaches outlet A ONLY (no acting-staff token is used)
//   doorStaff     door role over the whole tenant, with a PIN

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import type { PoolClient } from "pg";
import type { Test } from "supertest";
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

export { owner };

export const PIN = "582914";
export const TICKET_LIST_IDR = 70_000;
export const TICKET_TOTAL_IDR = 77_000;
const POINT_VALUE_IDR = 70;

export const short = () => randomUUID().slice(0, 6);
export const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body?.error?.code ?? body?.code;

export type Staff = { client: ReturnType<typeof agent>; userId: string };

export type World = {
  app: Express;
  tenant: IsolatedTenant;
  headers: { Host: string };
  outletA: string;
  outletB: string;
  cashier: Staff;
  doorStaff: Staff;
  facilityId: string;
  areaId: string;
  productId: string;
  kopiId: string;
  customerId: string;
  normalA: string;
  trainingB: string;
  normalB: string;
  unknown: string;
  raceQr: string;
  racePin: string;
};

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

export async function asOwnerTenant<T>(
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

export async function buildWorld(prefix: string): Promise<World> {
  const app = createApp();
  setPosReceiptPort(memoryReceiptPort());
  setPosEdcTenderPort(async (_tx, _context, input) => ({
    reference: input.reference ?? "EDC-TEST",
    approvedBy: null,
  }));
  const tenant = await createIsolatedTenant(`${prefix}-${short()}`);
  const headers = { Host: tenant.hostname };
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    tenant.tenantId,
    JSON.stringify({
      modules: ["pos", "qr_order", "loyalty"],
      integrationProviders: [],
    }),
  ]);
  const devices = new Map<string, { tenantId: string; outletId: string }>();
  setDeviceOutletResolver(async ({ tenantId, deviceId: id }) =>
    devices.get(id)?.tenantId === tenantId
      ? (devices.get(id)?.outletId ?? null)
      : null,
  );

  const outletA = tenant.outletId;
  const outletB = randomUUID();
  await owner.query(
    `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
     VALUES ($1, $2, $3, $4, $5, 'Outlet B Ronde 3', 'Jl. Uji 4', 'Asia/Jakarta', $6, 'active')`,
    [
      outletB,
      tenant.tenantId,
      tenant.brandId,
      tenant.legalEntityId,
      `B${short()}`.toUpperCase(),
      JSON.stringify(fixtures.outlets[0].openingHours),
    ],
  );

  const register = async (id: string, outletId: string, label: string) => {
    devices.set(id, { tenantId: tenant.tenantId, outletId });
    await registerTestDevice(owner, {
      tenantId: tenant.tenantId,
      outletId,
      deviceId: id,
      label,
    });
  };
  const normalA = randomUUID();
  const trainingB = randomUUID();
  const normalB = randomUUID();
  const unknown = randomUUID(); // never registered
  const raceQr = randomUUID();
  const racePin = randomUUID();
  await register(normalA, outletA, "Kasir A");
  await register(trainingB, outletB, "Latihan B");
  await register(normalB, outletB, "Kasir B");
  await register(raceQr, outletA, "Balapan QR");
  await register(racePin, outletA, "Balapan PIN");
  await owner.query(
    "UPDATE devices SET training_mode = true WHERE tenant_id = $1 AND id = $2",
    [tenant.tenantId, trainingB],
  );

  const role = async (name: string, permissions: string[]): Promise<string> => {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, $3, false, NULL, $4, false, '["tenant","outlet"]')`,
      [id, tenant.tenantId, name, JSON.stringify(permissions)],
    );
    return id;
  };
  const staff = async (
    roleId: string,
    label: string,
    scope: { type: "tenant" } | { type: "outlet"; outletId: string },
  ): Promise<Staff> => {
    const client = agent(app);
    await signUp(client, label);
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
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
  };

  const cashierRole = await role("Kasir Ronde 3", [
    "order.view",
    "pos.sale.create",
    "pos.payment.accept",
    "pos.void.request",
    "pos.refund.request",
    "shift.cash.operate",
  ]);
  const doorRole = await role("Petugas Pintu Ronde 3", [
    "order.view",
    "facility.booth.operate",
    "facility.access.assist",
  ]);
  const cashier = await staff(cashierRole, "Kasir Ronde 3", {
    type: "outlet",
    outletId: outletA,
  });
  const doorStaff = await staff(doorRole, "Pintu Ronde 3", { type: "tenant" });

  const sessionContext = () =>
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenant.tenantId),
      brandId: null,
      source: "session",
    });
  await setStaffPin(
    sessionContext(),
    doorStaff.userId,
    { outletId: outletA, userId: doorStaff.userId },
    { pin: PIN },
  );
  // The cashier holds an open shift on the outlet-A device. (A user cannot
  // hold a second shift; the outlet-B devices therefore have none.)
  await openPosShift(
    establishScopedTenantContext(sessionContext(), { kind: "tenant" }),
    { userId: userIdSchema.parse(cashier.userId), deviceId: normalA },
    outletIdSchema.parse(outletA),
    { openingFloatIdr: idr(100_000), idempotencyKey: randomUUID() },
  );

  const category = randomUUID();
  const ticketItem = randomUUID();
  const kopiId = randomUUID();
  const facilityId = randomUUID();
  const areaId = randomUUID();
  const productId = randomUUID();
  await asOwnerTenant(tenant.tenantId, async (db) => {
    await db.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Uji Ronde 3', 0)`,
      [category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ticketItem, "Tiket Shower"],
      [kopiId, "Kopi Uji"],
    ] as const) {
      await db.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, tenant.tenantId, tenant.brandId, category, name, randomUUID()],
      );
    }
    for (const outletId of [outletA, outletB]) {
      const priceList = randomUUID();
      await db.query(
        `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
         VALUES ($1, $2, $3, 'takeaway', '2026-01-01')`,
        [priceList, tenant.tenantId, outletId],
      );
      for (const [item, price] of [
        [ticketItem, TICKET_LIST_IDR],
        [kopiId, 25_000],
      ] as const) {
        await db.query(
          `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), tenant.tenantId, priceList, item, price],
        );
      }
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
       VALUES ($1, $2, NULL, 'PBJT-R3', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, doorStaff.userId],
    );
    await db.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Shower A', 'shower', 20, 10, 10, $4, $5, $6)`,
      [
        facilityId,
        tenant.tenantId,
        outletA,
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
      [areaId, tenant.tenantId, outletA, facilityId],
    );
    await db.query(
      `INSERT INTO facility_products
         (id, tenant_id, outlet_id, facility_id, name, type, price_idr, sessions, is_active, menu_item_id)
       VALUES ($1, $2, $3, $4, 'Tiket Shower 1x', 'single', $5, 1, true, $6)`,
      [
        productId,
        tenant.tenantId,
        outletA,
        facilityId,
        TICKET_LIST_IDR,
        ticketItem,
      ],
    );
  });
  await seedProgram(tenant.tenantId, { pointValueIdr: POINT_VALUE_IDR });
  const customerId = (await seedMember(tenant.tenantId)).id;

  return {
    app,
    tenant,
    headers,
    outletA,
    outletB,
    cashier,
    doorStaff,
    facilityId,
    areaId,
    productId,
    kopiId,
    customerId,
    normalA,
    trainingB,
    normalB,
    unknown,
    raceQr,
    racePin,
  };
}

export async function teardownWorld(world: World | undefined) {
  setPosReceiptPort(null);
  setPosEdcTenderPort(null);
  setDeviceOutletResolver(null);
  if (world) {
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      world.tenant.tenantId,
      randomUUID(),
    ]);
  }
  await memberOwner.end();
  await owner.end();
}

// ---- HTTP helpers ---------------------------------------------------------------

export function deviceToken(world: World, forDevice: string) {
  return signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: world.tenant.tenantId,
    brandId: null,
    deviceId: forDevice,
  });
}

export const authed = (world: World, request: Test, forDevice: string) =>
  request
    .set(world.headers)
    .set(originHeader)
    .set(DEVICE_TOKEN_HEADER, deviceToken(world, forDevice));

/** Tomorrow 03:00 UTC (10:00 Jakarta): inside the all-day hours, never past. */
export function slotStart(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 3),
  ).toISOString();
}

/** A fresh unit, so scenarios never share a slot. */
export async function newUnit(world: World): Promise<string> {
  const unitId = randomUUID();
  await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, 'available', 0)`,
      [
        unitId,
        world.tenant.tenantId,
        world.outletA,
        world.facilityId,
        world.areaId,
        `T-${short()}`.toUpperCase(),
      ],
    ),
  );
  return unitId;
}

export function saleBody(
  world: World,
  unitId: string,
  idempotencyKey: string = randomUUID(),
) {
  return {
    facilityId: world.facilityId,
    areaId: world.areaId,
    unitId,
    productId: world.productId,
    customerProfileId: world.customerId,
    timing: { kind: "slot", startsAt: slotStart() },
    idempotencyKey,
  };
}

export function sell(
  world: World,
  unitId: string,
  forDevice: string,
  idempotencyKey?: string,
) {
  return authed(
    world,
    world.cashier.client.post("/api/facility/tickets/pos"),
    forDevice,
  ).send(saleBody(world, unitId, idempotencyKey));
}

export function createPosOrder(
  world: World,
  forDevice: string,
  idempotencyKey: string = randomUUID(),
) {
  return authed(
    world,
    world.cashier.client.post(
      `/api/outlets/${encodeURIComponent(world.outletA)}/pos/orders`,
    ),
    forDevice,
  ).send({
    idempotencyKey,
    channel: "pos",
    serviceType: "takeaway",
    items: [{ menuItemId: world.kopiId, quantity: 1, modifierIds: [] }],
  });
}

type OrderView = { id: string; status: string; items: { id: string }[] };
export type Bought = { unitId: string; ticketId: string; orderId: string };

export async function buy(world: World): Promise<Bought> {
  const unitId = await newUnit(world);
  const response = await sell(world, unitId, world.normalA);
  if (response.status !== 200)
    throw new Error(`setup sale failed: ${JSON.stringify(response.body)}`);
  const sale = posTicketSaleSchema.parse(response.body.data);
  const order = response.body.data.order as OrderView;
  return { unitId, ticketId: sale.ticket.id, orderId: order.id };
}

function posApi(world: World) {
  const base = `/api/outlets/${encodeURIComponent(world.outletA)}/pos/orders`;
  const post = (path: string, body: Record<string, unknown>) =>
    authed(
      world,
      world.cashier.client.post(`${base}${path}`),
      world.normalA,
    ).send({ idempotencyKey: randomUUID(), ...body });
  return {
    get: (orderId: string) =>
      authed(
        world,
        world.cashier.client.get(`${base}/${orderId}`),
        world.normalA,
      ),
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

async function readOrder(world: World, orderId: string): Promise<OrderView> {
  const read = await posApi(world).get(orderId);
  if (read.status !== 200)
    throw new Error(`setup read failed: ${JSON.stringify(read.body)}`);
  return read.body.data as OrderView;
}

/** Sells, pays in cash and completes: the ticket becomes `issued`. */
export async function paidTicket(world: World): Promise<Bought> {
  const bought = await buy(world);
  let order = await readOrder(world, bought.orderId);
  if (order.status === "draft") {
    const submitted = await posApi(world).submit(bought.orderId, order.status);
    if (submitted.status !== 200)
      throw new Error(`setup submit failed: ${JSON.stringify(submitted.body)}`);
    order = await readOrder(world, bought.orderId);
  }
  const paid = await posApi(world).cash(
    bought.orderId,
    order.status,
    TICKET_TOTAL_IDR,
  );
  if (paid.status !== 201)
    throw new Error(`setup payment failed: ${JSON.stringify(paid.body)}`);
  const status = (await readOrder(world, bought.orderId)).status;
  const done = await posApi(world).complete(bought.orderId, status);
  if (done.status !== 200)
    throw new Error(`setup complete failed: ${JSON.stringify(done.body)}`);
  return bought;
}

export type Credential = { qrToken: string; pin: string };

/** Mints a credential and opens its window around now. */
export async function mintCredential(
  world: World,
  bought: Bought,
): Promise<Credential> {
  const response = await authed(
    world,
    world.cashier.client.post(
      `/api/pos/orders/${bought.orderId}/tickets/${encodeURIComponent(bought.ticketId)}/credential`,
    ),
    world.normalA,
  ).send({ idempotencyKey: randomUUID() });
  if (response.status >= 300)
    throw new Error(`setup mint failed: ${JSON.stringify(response.body)}`);
  await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query(
      `UPDATE access_ticket_credentials
          SET valid_from = now() - interval '1 hour',
              valid_until = now() + interval '2 hours'
        WHERE tenant_id = $1::uuid AND access_ticket_id = $2::uuid`,
      [world.tenant.tenantId, ulidToUuid(bought.ticketId)],
    ),
  );
  return response.body.data.credential as Credential;
}

export function doorCheck(
  world: World,
  forDevice: string,
  body: Record<string, unknown>,
) {
  return authed(
    world,
    world.doorStaff.client.post("/api/facility/tickets/door-check"),
    forDevice,
  ).send({ facilityId: world.facilityId, ...body });
}

type TicketRow = { status: string; first_opened_at: string | null };

export async function ticketState(
  world: World,
  ticketId: string,
): Promise<TicketRow> {
  const { rows } = await asOwnerTenant(world.tenant.tenantId, (db) =>
    db.query<TicketRow>(
      `SELECT status, first_opened_at FROM access_tickets
        WHERE tenant_id = $1 AND id = $2`,
      [world.tenant.tenantId, ulidToUuid(ticketId)],
    ),
  );
  return rows[0]!;
}
