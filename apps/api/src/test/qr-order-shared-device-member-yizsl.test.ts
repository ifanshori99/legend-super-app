// legend-yizsl (tier K: access + personal data): a QR order placed, read or
// claimed on a cashier tablet must never attach the tablet owner's member
// profile or points. Written from the brief, not from the implementation.
//
// Rule under test (QR routes that read the optional cookie session):
//  - POST /api/table-sessions/:id/orders        (placement: auto-attach member)
//  - GET  /api/table-sessions/:id/points-claim  (read: `requiresLogin`)
//  - POST /api/table-sessions/:id/points-claim  (claim: needs a member session)
//  A cookie session marked as shared-device (session.shared_device_ids not
//  empty), or any request carrying the X-Device-Token of an active flagged
//  shared device, is ANONYMOUS for member purposes. Marks never lapse (1027):
//  unflagging the device later changes nothing. A personal session keeps the
//  old behavior (member attached); an impersonated session stays anonymous.
//
// Assumptions (spec silent):
//  - "Order has no member attached" = orders.customer_profile_id IS NULL after
//    placement. A personal session with an active profile + loyalty consent
//    gets it set to the profile id (the old behavior, case d).
//  - Anonymous read of the points claim answers requiresLogin=true; anonymous
//    claim POST answers 401 UNAUTHORIZED and posts no ledger row (same as a
//    guest without cookie, see ws03-points-claim.test.ts).
//  - "Revoked/unflagged device" is simulated by clearing devices.shared_mode.
//  - The impersonation mark is set with UPDATE session.impersonated_by, as other
//    tests do (platform-tenant-owner-api.test.ts).

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import {
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
import { DEVICE_TOKEN_HEADER } from "@starter/shared/platform";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { signDeviceToken } from "../lib/device-token.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { qrOrderSettlementLookup } from "../services/qr-order.service.ts";
import { markSessionSharedDevice } from "../services/shared-device.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";
import {
  balanceOf,
  hex64,
  ledgerOf,
  newMemberUser,
  owner as loyaltyOwner,
  seedMember,
  seedProgram,
  type MemberUser,
} from "./member-loyalty-helpers.ts";

// Partial mock: everything real, except anySharedDeviceActive can be forced to
// reject for the fail-closed case (restored to the real call by default).
const sharedDeviceStub = vi.hoisted(() => ({ reject: false, calls: 0 }));
vi.mock("../services/shared-device.service.ts", async (importActual) => {
  const actual =
    await importActual<typeof import("../services/shared-device.service.ts")>();
  return {
    ...actual,
    anySharedDeviceActive: (
      ...args: Parameters<typeof actual.anySharedDeviceActive>
    ) => {
      if (sharedDeviceStub.reject) {
        sharedDeviceStub.calls += 1;
        return Promise.reject(new Error("shared-device lookup unavailable"));
      }
      return actual.anySharedDeviceActive(...args);
    },
  };
});

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];
const deviceIds: string[] = [];

class FakeGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  created = 0;
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created += 1;
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226FAKEQRYIZSL",
      issuer: null,
    };
    return {
      providerRef: `YZL-${randomBytes(6).toString("hex")}-${this.created}`,
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
const gateway = new FakeGateway();

async function asOwnerTenant<T>(
  tenantId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
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

function contextOf(tenantId: string): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
}

type Guest = { token: string; sessionId: string };
type Member = MemberUser & { profileId: string; sessionId: string };

async function seat(): Promise<Guest> {
  const zone = await createZone(
    staff.client,
    { paymentMode: "pay_first", serviceChargeBp: 500, hours: ALL_DAY },
    headers,
  );
  const table = await createTable(staff.client, { zoneId: zone.id }, headers);
  const qr = await issueQr(staff.client, table.id, headers);
  const response = await scan(app, {
    token: qr.token,
    hostname: tenant.hostname,
  });
  expect(response.status).toBe(201);
  return {
    token: response.body.data.sessionToken,
    sessionId: response.body.data.session.id,
  };
}

/** Guest request builder; `cookieOf` carries a logged-in cookie, `extra` headers. */
function as(
  guest: Guest,
  cookieOf?: MemberUser,
  extra: Record<string, string> = {},
) {
  const client = cookieOf ? cookieOf.client : agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader)
      .set(extra);
  const base = `/api/table-sessions/${guest.sessionId}`;
  return {
    view: () => auth(client.get(base)),
    add: (expectedCartVersion: number) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        menuItemId: ids.kopi,
        quantity: 1,
        expectedCartVersion,
      }),
    checkout: (expectedCartVersion: number) =>
      auth(client.post(`${base}/orders`)).send({
        expectedCartVersion,
        idempotencyKey: randomUUID(),
      }),
    payOrder: (orderId: string) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "order", orderId },
        method: "qris",
        idempotencyKey: randomUUID(),
      }),
    pointClaim: () => auth(client.get(`${base}/points-claim`)),
    claim: () =>
      auth(client.post(`${base}/points-claim`)).send({
        idempotencyKey: randomUUID(),
      }),
  };
}

/** Places one pay-first order (not paid); `cookieOf`/`extra` ride on the checkout. */
async function placeOrder(
  guest: Guest,
  cookieOf?: MemberUser,
  extra: Record<string, string> = {},
) {
  const view = await as(guest).view();
  expect(view.status, JSON.stringify(view.body)).toBe(200);
  const added = await as(guest).add(view.body.data.cart.version);
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  const placed = await as(guest, cookieOf, extra).checkout(
    added.body.data.cart.version,
  );
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.data.order.id as string;
  const { rows } = await owner.query(
    `SELECT total_idr::bigint AS total FROM orders
      WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return { orderId, totalIdr: Number(rows[0].total) };
}

async function customerOf(orderId: string) {
  const { rows } = await owner.query<{
    customer_profile_id: string | null;
    customer_attached_via: string | null;
  }>(
    `SELECT customer_profile_id::text, customer_attached_via FROM orders
      WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function paidEvent(intentId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
        AND event->'payload'->>'intentId' = $2
      ORDER BY created_at, id`,
    [tenant.tenantId, intentId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

/** Pays an order in full through the real payment + QR consumer path. */
async function paidOrder(guest: Guest) {
  const order = await placeOrder(guest);
  const pay = await as(guest).payOrder(order.orderId);
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  const intentId = pay.body.data.id as string;
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: order.totalIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const event = await paidEvent(intentId);
  const context = contextOf(tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, new Date()),
  );
  return order;
}

/** A real login with an active member profile + loyalty consent in the tenant. */
async function newMember(): Promise<Member> {
  const user = await newMemberUser(app);
  const profile = await seedMember(tenant.tenantId, {
    userId: user.userId,
    name: user.name,
  });
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM "session" WHERE user_id = $1`,
    [user.userId],
  );
  expect(rows).toHaveLength(1);
  return { ...user, profileId: profile.id, sessionId: rows[0]!.id };
}

async function newDevice(flagged: boolean): Promise<string> {
  const id = randomUUID();
  deviceIds.push(id);
  await owner.query(
    `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
     VALUES ($1, $2, $3, 'pos', $4, now() - interval '1 minute')`,
    [id, tenant.tenantId, tenant.outletId, `Kasir yizsl ${id.slice(0, 6)}`],
  );
  if (flagged)
    await owner.query("UPDATE devices SET shared_mode = true WHERE id = $1", [
      id,
    ]);
  return id;
}

const unflag = (id: string) =>
  owner.query("UPDATE devices SET shared_mode = false WHERE id = $1", [id]);

const tokenOf = (deviceId: string) =>
  signDeviceToken({
    version: 1,
    issuedAt: Math.floor(Date.now() / 1000),
    tenantId: tenant.tenantId,
    brandId: null,
    deviceId,
  });

/** A member login whose session is stamped with an active flagged device. */
async function tabletOwner(): Promise<Member & { deviceId: string }> {
  const deviceId = await newDevice(true);
  const member = await newMember();
  expect(await markSessionSharedDevice(member.sessionId, deviceId)).toBe(true);
  return { ...member, deviceId };
}

const ledgerClaims = async (profileId: string) =>
  (await ledgerOf(tenant.tenantId, profileId)).filter(
    (row) => row.source_type === "table_claim",
  );

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);

  tenant = await createIsolatedTenant(`yz-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Perangkat Bersama Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    await client.query(
      `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
       VALUES ($1, $2, $3, $4, 'Kopi Susu', true, $5)`,
      [ids.kopi, tenant.tenantId, tenant.brandId, ids.category, randomUUID()],
    );
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    await client.query(
      `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
       VALUES ($1, $2, $3, $4, 25000)`,
      [randomUUID(), tenant.tenantId, ids.priceList, ids.kopi],
    );
    await client.query(
      `INSERT INTO tax_settings
         (id, tenant_id, outlet_id, calculation_order, prices_include_tax, service_rounding_mode,
          tax_rounding_mode, inclusive_base_rounding_mode, bill_rounding, package_allocation,
          version, effective_from, status, published_at, published_by)
       VALUES ($1, $2, NULL, 'discount_service_tax', false, 'half_up', 'half_up', 'half_up', NULL,
               'fixed_bp', 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxSettings, tenant.tenantId, staff.userId],
    );
    await client.query(
      `INSERT INTO tax_rules
         (id, tenant_id, outlet_id, code, name, tax_type, rate_bp, region_code, channels, applies_to,
          price_includes_tax, include_service_in_base, is_active, version, effective_from, status,
          published_at, published_by)
       VALUES ($1, $2, NULL, 'PBJT-YZ', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
    for (const purpose of ["loyalty", "marketing", "ai"])
      await client.query(
        `INSERT INTO consent_policy_versions (tenant_id, purpose, version, text_hash, published_at)
         VALUES ($1, $2, '2026-01', $3, '2026-01-01T00:00:00+07:00')
         ON CONFLICT (tenant_id, purpose, version) DO NOTHING`,
        [tenant.tenantId, purpose, hex64()],
      );
  });
  await seedProgram(tenant.tenantId, {
    isActive: true,
    earnSpendIdr: 1000,
    earnPoints: 1,
    expiryMonths: 12,
    dailyCap: 100_000,
  });
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  if (deviceIds.length)
    await owner.query(
      "UPDATE devices SET shared_mode = false WHERE id = ANY($1::uuid[])",
      [deviceIds],
    );
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
  await loyaltyOwner.end();
});

describe("QR order on a shared-device session is anonymous (legend-yizsl)", () => {
  it("(d) control: a personal session attaches its member profile to the placed order", async () => {
    const member = await newMember();
    const order = await placeOrder(await seat(), member);
    const attached = await customerOf(order.orderId);
    expect(attached.customer_profile_id).toBe(member.profileId);
    expect(attached.customer_attached_via).toBe("pwa_session");
  });

  it("(a) a marked tablet session places a QR order with NO member attached", async () => {
    const tablet = await tabletOwner();
    const order = await placeOrder(await seat(), tablet);
    const attached = await customerOf(order.orderId);
    expect(attached.customer_profile_id).toBeNull();
    expect(attached.customer_attached_via).toBeNull();
  });

  it("(a) the marked tablet session reads the points claim as an anonymous guest", async () => {
    const tablet = await tabletOwner();
    const guest = await seat();
    await paidOrder(guest);
    const read = await as(guest, tablet).pointClaim();
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.status).toBe("available");
    expect(read.body.data.requiresLogin).toBe(true);
  });

  it("(a) the marked tablet session cannot claim points: 401 and no ledger row", async () => {
    const tablet = await tabletOwner();
    const guest = await seat();
    await paidOrder(guest);
    const before = await balanceOf(tenant.tenantId, tablet.profileId);
    const res = await as(guest, tablet).claim();
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(await ledgerClaims(tablet.profileId)).toEqual([]);
    expect(await balanceOf(tenant.tenantId, tablet.profileId)).toBe(before);
    // The unit is still free for a real customer afterwards.
    expect((await as(guest).pointClaim()).body.data.status).toBe("available");
  });

  it("(b) a mark outlives the device being unflagged: still anonymous on place, read and claim", async () => {
    const tablet = await tabletOwner();
    await unflag(tablet.deviceId);

    const order = await placeOrder(await seat(), tablet);
    expect((await customerOf(order.orderId)).customer_profile_id).toBeNull();

    const guest = await seat();
    await paidOrder(guest);
    const read = await as(guest, tablet).pointClaim();
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.requiresLogin).toBe(true);
    const res = await as(guest, tablet).claim();
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(await ledgerClaims(tablet.profileId)).toEqual([]);
  });

  it("(c) an unmarked cookie plus the token of an active flagged device is anonymous on place, read and claim", async () => {
    const deviceId = await newDevice(true);
    const member = await newMember();
    const token = { [DEVICE_TOKEN_HEADER]: tokenOf(deviceId) };

    const order = await placeOrder(await seat(), member, token);
    expect((await customerOf(order.orderId)).customer_profile_id).toBeNull();

    const guest = await seat();
    await paidOrder(guest);
    const read = await as(guest, member, token).pointClaim();
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.requiresLogin).toBe(true);
    const res = await as(guest, member, token).claim();
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(await ledgerClaims(member.profileId)).toEqual([]);
  });

  it("(c) a token of a device that is NOT flagged, or a badly signed token, leaves a personal session a member", async () => {
    const plainDevice = await newDevice(false);
    const member = await newMember();

    const withPlain = await placeOrder(await seat(), member, {
      [DEVICE_TOKEN_HEADER]: tokenOf(plainDevice),
    });
    expect((await customerOf(withPlain.orderId)).customer_profile_id).toBe(
      member.profileId,
    );

    const withGarbage = await placeOrder(await seat(), member, {
      [DEVICE_TOKEN_HEADER]: "not-a-valid-token",
    });
    expect((await customerOf(withGarbage.orderId)).customer_profile_id).toBe(
      member.profileId,
    );
  });

  it("(f) fail closed: when the shared-device lookup rejects, the order is anonymous and the request does not 500", async () => {
    // legend-vzvok: the early stamp runs first and would mark a flagged device
    // without the stubbed lookup. An unflagged device leaves the stamp empty, so
    // the request reaches the stubbed isSharedDeviceRequest lookup (the path
    // this test pins) and must fail closed there.
    const deviceId = await newDevice(false);
    const member = await newMember();
    const token = { [DEVICE_TOKEN_HEADER]: tokenOf(deviceId) };
    sharedDeviceStub.reject = true;
    sharedDeviceStub.calls = 0;
    try {
      // placeOrder asserts the checkout answered 201 (so no 500).
      const order = await placeOrder(await seat(), member, token);
      expect(sharedDeviceStub.calls).toBeGreaterThan(0);
      expect((await customerOf(order.orderId)).customer_profile_id).toBeNull();
    } finally {
      sharedDeviceStub.reject = false;
    }
  });

  it("(d) a personal session still reads requiresLogin=false and claims points", async () => {
    const member = await newMember();
    const guest = await seat();
    await paidOrder(guest);
    const read = await as(guest, member).pointClaim();
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.data.requiresLogin).toBe(false);
    const res = await as(guest, member).claim();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe("claimed");
    expect(await ledgerClaims(member.profileId)).toHaveLength(1);
  });

  it("(e) an impersonated session stays anonymous", async () => {
    const member = await newMember();
    await owner.query(
      'UPDATE "session" SET impersonated_by = $2 WHERE id = $1',
      [member.sessionId, staff.userId],
    );
    const order = await placeOrder(await seat(), member);
    expect((await customerOf(order.orderId)).customer_profile_id).toBeNull();
  });
});
