// Bead legend-ec6fa: a table claim racing a refund.
//
// `claimSessionPoints` marks a unit redeemed (the UPDATE checks "not refunded"
// at that moment) and posts the earn ledger row, all in one transaction. A
// refund that commits after the UPDATE but before the claim commits used to
// slip through: the earn consumer's `reverseTableClaims` could not see the
// uncommitted claim row, so the member kept points of a refunded order.
//
// The fix is an advisory lock per order, shared for the claim and exclusive
// for the reversal, taken before the profile lock on both sides. These tests
// hold the claim transaction open at its very end (a gate before the commit,
// after its last re-check), commit the refund and deliver its event
// meanwhile, and expect the member to end with no points. They also pin that
// no 40P01 deadlock shows up.
//
// Same real-app setup as ws03-points-claim.test.ts (orders paid through the
// real payment + QR consumer path, real member accounts).

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
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
  deliver,
  hex64,
  ledgerOf,
  newMemberUser,
  orderRefundedEvent,
  owner as loyaltyOwner,
  seedMember,
  seedProgram,
  type MemberUser,
} from "./member-loyalty-helpers.ts";

// A gate at the very end of a claim: `buildClaim` parses its answer with
// `pointClaimSchema` after the claim's last read and right before the
// transaction commits. The claim stops there until the test releases it, so a
// refund committed meanwhile is past every re-check the claim makes.
const gate = vi.hoisted(() => ({
  armed: false,
  reached: null as null | (() => void),
  release: null as null | Promise<void>,
}));

vi.mock("@starter/shared/qr-order", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@starter/shared/qr-order")>();
  const schema = actual.pointClaimSchema;
  return {
    ...actual,
    pointClaimSchema: new Proxy(schema, {
      get(target, prop) {
        if (prop === "parse")
          return (value: unknown) => {
            if (!gate.armed) return target.parse(value);
            gate.armed = false;
            gate.reached?.();
            return gate.release!.then(() => target.parse(value));
          };
        const member = Reflect.get(target, prop);
        return typeof member === "function" ? member.bind(target) : member;
      },
    }),
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
const SPEND_PER_POINT = 1000;

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
      qrPayload: "00020101021226FAKEQRRACE",
      issuer: null,
    };
    return {
      providerRef: `QRC-${randomBytes(6).toString("hex")}-${this.created}`,
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

function as(guest: Guest, member?: MemberUser) {
  const client = member ? member.client : agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader);
  const base = `/api/table-sessions/${guest.sessionId}`;
  return {
    add: (menuItemId: string, expectedCartVersion: number) =>
      auth(client.post(`${base}/cart/lines`)).send({
        idempotencyKey: randomUUID(),
        modifierIds: [],
        menuItemId,
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
    split: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/splits`)).send(body),
    paySplit: (billSplitId: string) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "split", billSplitId },
        method: "qris",
        idempotencyKey: randomUUID(),
      }),
    splitClaim: (splitId: string) =>
      auth(client.get(`${base}/splits/${splitId}/claim`)),
    claim: (claimToken?: string) =>
      auth(client.post(`${base}/points-claim`)).send({
        idempotencyKey: randomUUID(),
        ...(claimToken ? { claimToken } : {}),
      }),
  };
}

async function paidEvent(intentId: string): Promise<EventEnvelope> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid' AND event->'payload'->>'intentId' = $2
     ORDER BY created_at, id`,
    [tenant.tenantId, intentId],
  );
  expect(rows).toHaveLength(1);
  return eventEnvelopeSchema.parse(rows[0]!.event);
}

async function settle(intentId: string, amountIdr: number): Promise<void> {
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const event = await paidEvent(intentId);
  const context = contextOf(tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, new Date()),
  );
}

async function placeOrder(guest: Guest) {
  const added = await as(guest).add(ids.kopi, 0);
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.data.order.id as string;
  const { rows } = await owner.query(
    `SELECT total_idr::bigint AS total,
            (CASE WHEN prices_include_tax THEN subtotal_idr - service_charge_idr - tax_idr
                  ELSE subtotal_idr END - discount_idr)::bigint AS eligible
       FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return {
    orderId,
    totalIdr: Number(rows[0].total),
    eligibleIdr: Number(rows[0].eligible),
  };
}

/** One order paid in full by a single payer (whole-bill claim). */
async function paidOrder(guest: Guest) {
  const order = await placeOrder(guest);
  const pay = await as(guest).payOrder(order.orderId);
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  const intentId = pay.body.data.id as string;
  await settle(intentId, order.totalIdr);
  return { ...order, intentId, token: undefined as string | undefined };
}

/** One order split in two parts, both paid; the first part's token is returned. */
async function paidSplitOrder(guest: Guest) {
  const order = await placeOrder(guest);
  const created = await as(guest).split({
    method: "equal",
    parts: 2,
    idempotencyKey: randomUUID(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const parts: { id: string; shareIndex: number; amountIdr: number }[] = [
    ...created.body.data.splits,
  ].sort((a, b) => a.shareIndex - b.shareIndex);
  expect(parts).toHaveLength(2);
  let token: string | undefined;
  let firstIntentId = "";
  for (const part of parts) {
    const pay = await as(guest).paySplit(part.id);
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const intentId = pay.body.data.id as string;
    await settle(intentId, part.amountIdr);
    const claim = await as(guest).splitClaim(part.id);
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    if (part === parts[0]) {
      token = claim.body.data.claimToken as string;
      firstIntentId = intentId;
    }
  }
  return { ...order, intentId: firstIntentId, token };
}

async function newMember(): Promise<MemberUser & { profileId: string }> {
  const user = await newMemberUser(app);
  const profile = await seedMember(tenant.tenantId, {
    userId: user.userId,
    name: user.name,
  });
  return { ...user, profileId: profile.id };
}

const ledgerClaims = async (profileId: string) =>
  (await ledgerOf(tenant.tenantId, profileId)).filter(
    (row) => row.source_type === "table_claim",
  );

/** The refund row the claim UPDATE looks at (a pending refund counts). */
const recordRefund = (intentId: string, amountIdr: number) =>
  asOwnerTenant(tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO payment_refunds
         (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
       VALUES ($1, $2, $3, $4, 'uji', 'pending', $5)`,
      [tenant.tenantId, tenant.outletId, intentId, amountIdr, staff.userId],
    ),
  );

/** The earn consumer's view of the refund (what the outbox delivers). */
function refundEvent(orderId: string, eligibleIdr: number) {
  const world = {
    tenantId: tenant.tenantId,
    context: contextOf(tenant.tenantId),
  };
  return {
    world,
    event: orderRefundedEvent(world, {
      orderUlid: orderId,
      outletId: tenant.outletId,
      grossSalesIdr: eligibleIdr,
    }),
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);

  tenant = await createIsolatedTenant(`cr-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Klaim Balapan Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-CR', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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
});

beforeEach(async () => {
  gate.armed = false;
  await seedProgram(tenant.tenantId, {
    isActive: true,
    earnSpendIdr: SPEND_PER_POINT,
    earnPoints: 1,
    expiryMonths: 12,
    dailyCap: 100_000,
  });
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
  await loyaltyOwner.end();
});

type Paid = Awaited<ReturnType<typeof paidOrder>>;

/**
 * Holds a claim after it redeemed the unit, commits a refund and delivers its
 * event meanwhile, then lets the claim finish. Returns both outcomes and any
 * error the delivery raised.
 */
async function raceRefundAgainstClaim(
  guest: Guest,
  member: MemberUser,
  order: Paid,
) {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    gate.reached = resolve;
  });
  gate.release = new Promise<void>((resolve) => {
    release = resolve;
  });
  gate.armed = true;
  const claimed = as(guest, member)
    .claim(order.token)
    .then((response) => response);
  await reached;

  await recordRefund(order.intentId, order.totalIdr);
  const { world, event } = refundEvent(order.orderId, order.eligibleIdr);
  const delivery = deliver(world, event).then(
    () => null,
    (error: unknown) => error,
  );
  // With the lock the delivery waits for the claim; without it, it has
  // already run (and found no claim to reverse).
  await sleep(400);
  release();
  const [claim, deliveryError] = await Promise.all([claimed, delivery]);
  return { claim, deliveryError };
}

describe("a claim racing a refund (legend-ec6fa)", () => {
  it.each([
    ["a whole-bill claim", paidOrder],
    ["a split-part claim", paidSplitOrder],
  ] as const)(
    "%s still open when the refund committed ends with no points",
    async (_label, pay) => {
      const guest = await seat();
      const order = await pay(guest);
      const member = await newMember();

      const { claim, deliveryError } = await raceRefundAgainstClaim(
        guest,
        member,
        order,
      );
      expect(deliveryError).toBeNull();
      // The claim either lost (409) or won and was reversed after it
      // committed; never a deadlock, and never points left over.
      expect([200, 409], JSON.stringify(claim.body)).toContain(claim.status);
      expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(0);
      const rows = await ledgerClaims(member.profileId);
      const earned = rows.reduce((sum, row) => sum + Number(row.points), 0);
      const reversed = (await ledgerOf(tenant.tenantId, member.profileId))
        .filter((row) => row.type === "reverse")
        .reduce((sum, row) => sum + Number(row.points), 0);
      expect(earned + reversed).toBe(0);
    },
  );

  it.each([
    ["a whole-bill claim", paidOrder],
    ["a split-part claim", paidSplitOrder],
  ] as const)(
    "%s after the refund committed is refused and posts nothing",
    async (_label, pay) => {
      const guest = await seat();
      const order = await pay(guest);
      const member = await newMember();

      await recordRefund(order.intentId, order.totalIdr);
      const { world, event } = refundEvent(order.orderId, order.eligibleIdr);
      await deliver(world, event);

      const post = await as(guest, member).claim(order.token);
      expect(post.status, JSON.stringify(post.body)).toBe(409);
      expect(await ledgerClaims(member.profileId)).toEqual([]);
      expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(0);
    },
  );
});
