// Shared fixtures for the breakfast-pay tests (bead oa0qk: facility-breakfast-pay,
// facility-breakfast-concurrency). Not a test file: vitest only picks up
// `*.test.ts`.
//
// Written from the sub-brief contract (docs/briefs/sub-oa0qk-breakfast-pay.md)
// and the shared contract names, never from the implementation. One isolated
// tenant per test file: a kitchen station, two menu items, one facility, a floor
// table, one floor/facility staff account. Each case gets its own member,
// unit and access ticket so the "one live breakfast order per ticket" rule and
// the unit overlap rules never couple two cases.
//
// Assumptions (the adapters below are the only places to adjust):
// - ticketId in the URL and `order.id` in bodies are ULIDs (`ulidInUuid`
//   columns); `menuItemId` / `tableId` are the menu item / floor table UUIDs.
// - Every response is `{ data }` (defineEndpoint + dataResponseSchema) and an
//   error is `{ error: { code } }`.
// - The pay endpoint gives the link token `pl_...`; the guest page then opens
//   an intent through the existing public `POST /api/payments/links/:token/intents`.
// - The worker sweep is `fireDueBreakfastOrders(context, now)` (same shape as
//   `sweepUnpaidQrOrders`), found lazily in the breakfast consumers/service/money modules.
// - The payment event is consumed through the existing single entry point
//   `deliverOrderPaymentEvent(context, event, tx, now)` (routes by channel).

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { Express } from "express";
import { expect } from "vitest";
import {
  createUlid,
  tenantIdSchema,
  ulidToUuid,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  owner as floorOwner,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";
import {
  hex64,
  owner as memberOwner,
  seedConsent,
  seedProfile,
  short,
} from "./member-loyalty-helpers.ts";

const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
export const MINUTE = 60_000;

/** QRIS gateway double: the guest pays by QRIS. */
export class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEQRBREAKFAST",
      issuer: null,
    };
    return {
      providerRef: `BRK-${randomBytes(6).toString("hex")}-${this.created}`,
      instructions,
      expiresAt: input.expiresAt,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels() {
    return [];
  }
}

export const installGateway = () => setPaymentGateway(new FakeGateway());
export const removeGateway = () => setPaymentGateway(null);

export type BreakfastWorld = {
  app: Express;
  tenant: IsolatedTenant;
  headers: { Host: string };
  context: ScopedTenantContext;
  /** Floor owner who also holds `facility.booth.operate`. */
  staff: Staff;
  ids: {
    station: string;
    nasi: string;
    kopi: string;
    facility: string;
    area: string;
    tableId: string;
  };
  /** Menu prices before any tax/service the server may add. */
  prices: { nasi: number; kopi: number };
};

export function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

/** Owner connection with the tenant settings FORCE RLS requires. */
export async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await floorOwner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [tenantId],
    );
    const result = await run(client as unknown as Client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createBreakfastWorld(
  app: Express,
): Promise<BreakfastWorld> {
  const tenant = await createIsolatedTenant(`brk${randomUUID().slice(0, 6)}`);
  await floorOwner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      tenant.tenantId,
      JSON.stringify({
        modules: ["pos", "qr_order", "kds", "loyalty"],
        integrationProviders: [],
      }),
    ],
  );
  // The seeded floor role gains the facility staff permission (set before the
  // account is created so no cached grant is stale).
  await floorOwner.query(
    "UPDATE roles SET permissions = $2::jsonb WHERE id = $1",
    [
      tenant.roleId,
      JSON.stringify([
        "floor.table.view",
        "floor.table.operate",
        "floor.table.manage",
        "facility.booth.operate",
        "facility.config.manage",
      ]),
    ],
  );
  const staff = await staffOfIsolatedTenant(app, tenant);
  const headers = { Host: tenant.hostname };
  const ids = {
    station: randomUUID(),
    nasi: randomUUID(),
    kopi: randomUUID(),
    facility: randomUUID(),
    area: randomUUID(),
    tableId: "",
  };
  const prices = { nasi: 30_000, kopi: 15_000 };
  const category = randomUUID();
  const priceList = randomUUID();
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO stations (id, tenant_id, outlet_id, name, type) VALUES ($1, $2, $3, 'Dapur Sarapan', 'hot_kitchen')`,
      [ids.station, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Sarapan Uji', 0)`,
      [category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ids.nasi, "Nasi Goreng"],
      [ids.kopi, "Kopi Hitam"],
    ] as const)
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, is_breakfast, media_id, station_id, station_type)
         VALUES ($1, $2, $3, $4, $5, true, true, $6, $7, 'hot_kitchen')`,
        [
          id,
          tenant.tenantId,
          tenant.brandId,
          category,
          name,
          randomUUID(),
          ids.station,
        ],
      );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [priceList, tenant.tenantId, tenant.outletId],
    );
    for (const [item, price] of [
      [ids.nasi, prices.nasi],
      [ids.kopi, prices.kopi],
    ] as const)
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, priceList, item, price],
      );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-BRK', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [randomUUID(), tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO facilities (id, tenant_id, outlet_id, name, type, session_minutes, cleaning_minutes,
                               arrival_grace_minutes, operating_hours, overtime_policy, cancellation_policy)
       VALUES ($1, $2, $3, 'Shower Sarapan', 'shower', 20, 10, 10, $4, $5, $6)`,
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
    await client.query(
      `INSERT INTO facility_areas (id, tenant_id, outlet_id, facility_id, name, sort_order)
       VALUES ($1, $2, $3, $4, 'Area Sarapan', 0)`,
      [ids.area, tenant.tenantId, tenant.outletId, ids.facility],
    );
  });
  const zone = await createZone(
    staff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  ids.tableId = (await createTable(staff.client, { zoneId: zone.id }, headers))
    .id as string;
  return {
    app,
    tenant,
    headers,
    context: contextOf(tenant.tenantId),
    staff,
    ids,
    prices,
  };
}

export async function dropBreakfastWorld(world: BreakfastWorld) {
  // Audit rows are append-only, so the isolated tenant stays in the disposable
  // database; give it a valid creator so the platform tenant list parses it.
  await floorOwner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    world.tenant.tenantId,
    randomUUID(),
  ]);
}

export async function endPools() {
  await floorOwner.end();
  await memberOwner.end();
}

// ---- members and tickets -----------------------------------------------------

export type Member = {
  client: ReturnType<typeof agent>;
  userId: string;
  profileId: string;
};

/** A real Better Auth account with an active, WhatsApp-verified profile in the tenant. */
export async function newMember(world: BreakfastWorld): Promise<Member> {
  const client = agent(world.app);
  const name = `Tamu ${short()}`;
  await signUp(client, name);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  const whatsappHash = hex64();
  await memberOwner.query(
    `INSERT INTO user_identities (user_id, type, value_hash, verified_at)
     VALUES ($1, 'whatsapp', $2, now())`,
    [userId, whatsappHash],
  );
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO consent_policy_versions (tenant_id, purpose, version, text_hash, published_at)
       VALUES ($1, 'loyalty', '2026-01', $2, '2026-01-01T00:00:00+07:00')
       ON CONFLICT (tenant_id, purpose, version) DO NOTHING`,
      [world.tenant.tenantId, hex64()],
    ),
  );
  const profile = await seedProfile(world.tenant.tenantId, {
    userId,
    name,
    status: "active",
    whatsappHash,
    verified: true,
  });
  await seedConsent(world.tenant.tenantId, profile.id);
  return { client, userId, profileId: profile.id };
}

/**
 * An `in_use` access ticket of the member on a fresh unit: it started 10
 * minutes ago and ends `endsInMinutes` from now (default 60), so with the
 * default 15-minute offset the order fires 45 minutes from now.
 */
export async function seedTicket(
  world: BreakfastWorld,
  member: Member,
  options: { endsInMinutes?: number; status?: string } = {},
): Promise<string> {
  const ticketUlid = createUlid();
  const unitId = randomUUID();
  const now = Date.now();
  const endsAt = now + (options.endsInMinutes ?? 60) * MINUTE;
  await asOwnerTenant(world.tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO facility_units (id, tenant_id, outlet_id, facility_id, area_id, code, status, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, 'available', 0)`,
      [
        unitId,
        world.tenant.tenantId,
        world.tenant.outletId,
        world.ids.facility,
        world.ids.area,
        `U-${short()}`.toUpperCase(),
      ],
    );
    await client.query(
      `INSERT INTO access_tickets (id, tenant_id, outlet_id, facility_id, area_id, unit_id, customer_profile_id,
                                   product_id, source, starts_at, ends_at, cleaning_ends_at, grace_minutes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'purchase', $9, $10, $11, 10, $12)`,
      [
        ulidToUuid(ticketUlid),
        world.tenant.tenantId,
        world.tenant.outletId,
        world.ids.facility,
        world.ids.area,
        unitId,
        member.profileId,
        randomUUID(),
        new Date(now - 10 * MINUTE).toISOString(),
        new Date(endsAt).toISOString(),
        new Date(endsAt + 10 * MINUTE).toISOString(),
        options.status ?? "in_use",
      ],
    );
  });
  return ticketUlid;
}

// ---- HTTP calls --------------------------------------------------------------

export type BreakfastOrderView = {
  id: string;
  ticketId: string;
  status: "awaiting_payment" | "paid" | "fired" | "cancelled";
  totalIdr: number;
  subtotalIdr: number;
  paidAt: string | null;
  firedAt: string | null;
  fireAt: string;
  lines: { menuItemId: string; name: string; quantity: number }[];
};

const ticketBase = (ticketId: string) => `/api/facility/tickets/${ticketId}`;

export function memberApi(world: BreakfastWorld, member: Member) {
  const authed = (test: ReturnType<typeof member.client.get>) =>
    test.set(world.headers).set(originHeader);
  return {
    menu: (ticketId: string) =>
      authed(member.client.get(`${ticketBase(ticketId)}/breakfast-menu`)),
    create: (ticketId: string, body: Record<string, unknown>) =>
      authed(
        member.client.post(`${ticketBase(ticketId)}/breakfast-orders`),
      ).send(body),
    pay: (ticketId: string, orderId: string, key = randomUUID()) =>
      authed(
        member.client.post(
          `${ticketBase(ticketId)}/breakfast-orders/${orderId}/pay`,
        ),
      ).send({ idempotencyKey: key }),
    cancel: (ticketId: string, orderId: string, key = randomUUID()) =>
      authed(
        member.client.post(
          `${ticketBase(ticketId)}/breakfast-orders/${orderId}/cancel`,
        ),
      ).send({ idempotencyKey: key }),
    fire: (orderId: string) =>
      authed(
        member.client.post(`/api/facility/breakfast-orders/${orderId}/fire`),
      ).send({ idempotencyKey: randomUUID() }),
  };
}

/** Staff "Kirim sekarang". */
export function staffFire(world: BreakfastWorld, orderId: string) {
  return world.staff.client
    .post(`/api/facility/breakfast-orders/${orderId}/fire`)
    .set(world.headers)
    .set(originHeader)
    .send({ idempotencyKey: randomUUID() });
}

export const breakfastBody = (
  world: BreakfastWorld,
  overrides: Record<string, unknown> = {},
) => ({
  lines: [
    { menuItemId: world.ids.nasi, quantity: 2 },
    { menuItemId: world.ids.kopi, quantity: 1 },
  ],
  delivery: { mode: "table", tableId: world.ids.tableId },
  idempotencyKey: randomUUID(),
  ...overrides,
});

/** Creates an `awaiting_payment` breakfast order for the ticket. */
export async function placeOrder(
  world: BreakfastWorld,
  member: Member,
  ticketId: string,
): Promise<BreakfastOrderView> {
  const created = await memberApi(world, member).create(
    ticketId,
    breakfastBody(world),
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const order = created.body.data as BreakfastOrderView;
  expect(order.status).toBe("awaiting_payment");
  expect(order.totalIdr).toBeGreaterThan(0);
  return order;
}

/** Pay endpoint -> link token. */
export async function payLink(
  world: BreakfastWorld,
  member: Member,
  ticketId: string,
  orderId: string,
): Promise<string> {
  const response = await memberApi(world, member).pay(ticketId, orderId);
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  const token = response.body.data.paymentToken as string | null;
  expect(token).toMatch(/^pl_/);
  return token!;
}

/**
 * The guest opens a QRIS intent on the link. It does not replace an earlier
 * pending code: while one can still be paid a new one is refused 409
 * ORDER_CODE_ACTIVE. Use `openSecondIntent` when a test needs a second code.
 */
export async function openIntent(
  world: BreakfastWorld,
  token: string,
): Promise<{ id: string; amountIdr: number }> {
  const response = await agent(world.app)
    .post(`/api/payments/links/${token}/intents`)
    .set(world.headers)
    .send({
      method: "qris",
      channelCode: null,
      idempotencyKey: `brk-${randomUUID()}`,
    });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return {
    id: response.body.data.id as string,
    amountIdr: response.body.data.amountIdr as number,
  };
}

/**
 * The guest opens a second code on the link after the earlier one became final
 * at the provider (a new code on a still-payable one is refused 409
 * ORDER_CODE_ACTIVE). Every pending, not-final code of the world's tenant is
 * made final first (status expired, provider_final_at now); a later webhook
 * settlement of the earlier code is still a valid late payment.
 */
export async function openSecondIntent(
  world: BreakfastWorld,
  token: string,
): Promise<{ id: string; amountIdr: number }> {
  await floorOwner.query(
    `UPDATE payment_intents
        SET status = 'expired', provider_final_at = now(),
            expires_at = LEAST(expires_at, now() - interval '1 minute')
      WHERE tenant_id = $1 AND status = 'pending' AND provider_final_at IS NULL`,
    [world.tenant.tenantId],
  );
  return openIntent(world, token);
}

/** A verified webhook settlement (the only trusted source). */
export async function settle(
  world: BreakfastWorld,
  intentId: string,
  amountIdr: number,
) {
  await confirmPayment(world.context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
}

export async function paidEvent(
  world: BreakfastWorld,
  intentId: string,
): Promise<EventEnvelope> {
  const { rows } = await floorOwner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.paid' AND event->'payload'->>'intentId' = $2
      ORDER BY created_at, id`,
    [world.tenant.tenantId, intentId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** As the worker does: inside the tenant (consumption) transaction. */
export function deliver(world: BreakfastWorld, event: EventEnvelope) {
  return withTenant(db, world.context, (tx) =>
    deliverOrderPaymentEvent(world.context, event, tx, new Date()),
  );
}

/** Opens an intent on the link, settles it and returns its `payment.paid` event. */
export async function payIntent(
  world: BreakfastWorld,
  token: string,
  amountIdr?: number,
) {
  const intent = await openIntent(world, token);
  await settle(world, intent.id, amountIdr ?? intent.amountIdr);
  return { intentId: intent.id, event: await paidEvent(world, intent.id) };
}

/** The whole happy path: order -> pay link -> intent -> settled -> consumer. */
export async function placePaidOrder(
  world: BreakfastWorld,
  member: Member,
  ticketId: string,
) {
  const order = await placeOrder(world, member, ticketId);
  const token = await payLink(world, member, ticketId, order.id);
  const { intentId, event } = await payIntent(world, token);
  await deliver(world, event);
  return { order, token, intentId, event };
}

type Sweep = (context: ScopedTenantContext, now: Date) => Promise<unknown>;

/**
 * Worker sweep for breakfast orders that reached their fire time. Assumed name
 * and shape: `fireDueBreakfastOrders(context, now)` (as `sweepUnpaidQrOrders`),
 * exported by the consumers module like its QR twin, or by the service / money
 * module. Resolved lazily so the other tests do not depend on where it lives.
 */
export async function runSweep(
  world: BreakfastWorld,
  at: Date = new Date(),
): Promise<void> {
  const candidates = [
    () => import("../services/facility-breakfast-consumers.ts"),
    () => import("../services/facility-breakfast.service.ts"),
    () => import("../services/facility-breakfast-money.ts"),
  ] as const;
  for (const load of candidates) {
    const module = (await load().catch(() => ({}))) as Record<string, unknown>;
    const sweep = module.fireDueBreakfastOrders as Sweep | undefined;
    if (typeof sweep === "function") {
      await sweep(world.context, at);
      return;
    }
  }
  throw new Error(
    "fireDueBreakfastOrders is not exported by any breakfast service module",
  );
}

// ---- database reads (owner, tenant GUCs set) ---------------------------------

export type LinkedRow = {
  status: string;
  total: number;
  paid: number;
  refunded: number;
  paidIntentId: string | null;
  paidAt: Date | null;
  firedAt: Date | null;
  cancelledAt: Date | null;
  fireAt: Date;
};

export async function linkedOf(
  world: BreakfastWorld,
  orderId: string,
): Promise<LinkedRow> {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{
      status: string;
      total_idr: string;
      paid_idr: string;
      refunded_idr: string;
      paid_intent_id: string | null;
      paid_at: Date | null;
      fired_at: Date | null;
      cancelled_at: Date | null;
      fire_at: Date;
    }>(
      `SELECT status, total_idr::text, paid_idr::text, refunded_idr::text, paid_intent_id, paid_at,
              fired_at, cancelled_at, fire_at
         FROM facility_linked_orders WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [world.tenant.tenantId, ulidToUuid(orderId)],
    );
    const row = rows[0];
    if (!row) throw new Error(`No facility_linked_orders row for ${orderId}`);
    return {
      status: row.status,
      total: Number(row.total_idr),
      paid: Number(row.paid_idr),
      refunded: Number(row.refunded_idr),
      paidIntentId: row.paid_intent_id,
      paidAt: row.paid_at,
      firedAt: row.fired_at,
      cancelledAt: row.cancelled_at,
      fireAt: row.fire_at,
    };
  });
}

export async function setFireAt(
  world: BreakfastWorld,
  orderId: string,
  fireAt: Date,
) {
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `UPDATE facility_linked_orders SET fire_at = $3 WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [world.tenant.tenantId, ulidToUuid(orderId), fireAt.toISOString()],
    ),
  );
}

export async function kitchenTicketCount(
  world: BreakfastWorld,
  orderId: string,
): Promise<number> {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM kitchen_tickets WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [world.tenant.tenantId, ulidToUuid(orderId)],
    );
    return rows[0]!.n;
  });
}

export async function orderItemFireStatuses(
  world: BreakfastWorld,
  orderId: string,
): Promise<string[]> {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{ fire_status: string }>(
      `SELECT fire_status FROM order_items WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [world.tenant.tenantId, ulidToUuid(orderId)],
    );
    return rows.map((row) => row.fire_status);
  });
}

export type RefundRow = { id: string; status: string; amount: number };

/**
 * Every refund request that returns money of the intent: directly (a cancel
 * refund) or through a `payment_unallocated_funds` row (a double or late payment).
 */
export async function refundsOf(
  world: BreakfastWorld,
  intentId: string,
): Promise<RefundRow[]> {
  const { rows } = await floorOwner.query<{
    id: string;
    status: string;
    amount: string;
  }>(
    `SELECT DISTINCT r.id, r.status, r.amount_idr::text AS amount
       FROM payment_refunds r
       LEFT JOIN payment_unallocated_funds f ON f.id = r.unallocated_fund_id
      WHERE r.tenant_id = $1 AND (r.payment_intent_id = $2 OR f.payment_intent_id = $2)`,
    [world.tenant.tenantId, intentId],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    amount: Number(row.amount),
  }));
}

export type RefundDetail = RefundRow & { requestedBy: string; reason: string };

/** Same refunds as `refundsOf`, with who asked (`requested_by`) and the reason text. */
export async function refundDetailsOf(
  world: BreakfastWorld,
  intentId: string,
): Promise<RefundDetail[]> {
  const { rows } = await floorOwner.query<{
    id: string;
    status: string;
    amount: string;
    requested_by: string;
    reason: string;
  }>(
    `SELECT DISTINCT r.id, r.status, r.amount_idr::text AS amount, r.requested_by, r.reason
       FROM payment_refunds r
       LEFT JOIN payment_unallocated_funds f ON f.id = r.unallocated_fund_id
      WHERE r.tenant_id = $1 AND (r.payment_intent_id = $2 OR f.payment_intent_id = $2)`,
    [world.tenant.tenantId, intentId],
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    amount: Number(row.amount),
    requestedBy: row.requested_by,
    reason: row.reason,
  }));
}

export const refundedSum = (rows: RefundRow[]) =>
  rows.reduce((sum, row) => sum + row.amount, 0);

/** Waits (best effort, never throws) until `count` backends wait on a row lock. */
export async function waitForLockWaiters(count: number, excludePid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await floorOwner.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE pid <> $1 AND wait_event_type = 'Lock'`,
      [excludePid],
    );
    if (result.rows[0]!.waiting >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export { floorOwner as owner };
