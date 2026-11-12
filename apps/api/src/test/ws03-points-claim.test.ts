// WS-03 (bead legend-n1mp): guest point claim.
//   GET  /api/table-sessions/:sessionId/points-claim[?claimToken=sc_...]
//   POST /api/table-sessions/:sessionId/points-claim  { idempotencyKey, claimToken? }
//
// Written from docs brief legend-n1mp ("Satuan klaim", "Ledger", "Rute"), not
// from the service. Real Express app and PostgreSQL with RLS in one isolated
// tenant. Orders are paid through the real payment + QR consumer path (as
// bill-split-claim.test.ts); members are real Better Auth accounts with a
// profile seeded in the isolated tenant.
//
// Assumptions (ambiguous in the brief):
// - Unit amount: a single-payer order claims `orders.total_idr`; a split part
//   claims `bill_splits.amount_idr`. Points are floor(paid / 1000) * 1 with the
//   program seeded below (earn 1 point per Rp1.000) and no tier multiplier.
// - `point_ledger.source_id` for an order unit is the order id; it may be
//   stored in ULID or UUID form, both are accepted.
// - Business "now" is real time. "After 24 hours" is simulated by moving the
//   unit's `claim_expires_at` into the past (no clock injection over HTTP).
// - A token that is not of the caller's session is answered 404 or 409 on
//   POST, and 404 or 200/unavailable (0 points) on GET. What matters is that
//   nothing leaks and nothing is posted.
// - A member without an eligible profile gets 403 or 409 on POST.
// - Voiding a paid order is simulated with a direct UPDATE (status voided).
//   If the order claim CHECK forbids that, the seed itself fails: that is
//   the one case that may not be seedable until the migration is final.
// - The daily cap is counted per business date; both orders in the cap case
//   are placed today, so they share a business date.

import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { sql } from "drizzle-orm";
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
  idr,
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
import { getPointClaim } from "@starter/shared/qr-order";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { updateLoyaltyProgram } from "../services/loyalty-program.service.ts";
import { claimSessionPoints } from "../services/table-claim.service.ts";
import * as loyaltyEntityGuard from "../services/loyalty-entity-guard.ts";
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
import { secretFor } from "./payer-secret-helpers.ts";
import {
  createIsolatedTenant,
  createTable,
  createZone,
  issueQr,
  owner,
  scan,
  seededHostname,
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
  seedProfile,
  seedProgram,
  type MemberUser,
} from "./member-loyalty-helpers.ts";

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
const HOUR = 3_600_000;
/** Program under test: 1 point per Rp1.000 of paid amount. */
const SPEND_PER_POINT = 1000;
const pointsOf = (paidIdr: number) => Math.floor(paidIdr / SPEND_PER_POINT);

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
      qrPayload: "00020101021226FAKEQRPOINTS",
      issuer: null,
    };
    return {
      providerRef: `QPC-${randomBytes(6).toString("hex")}-${this.created}`,
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

/** A guest request builder; `member` carries the logged-in cookie, if any. */
function as(guest: Guest, member?: MemberUser, host = tenant.hostname) {
  const client = member ? member.client : agent(app);
  const auth = (test: ReturnType<typeof client.get>) =>
    test
      .set("Host", host)
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
        payerSecret: secretFor(billSplitId),
        idempotencyKey: randomUUID(),
      }),
    splitClaim: (splitId: string, payerSecret: string) =>
      auth(client.post(`${base}/splits/${splitId}/claim`)).send({
        payerSecret,
      }),
    pointClaim: (claimToken?: string) =>
      auth(
        client.get(
          `${base}/points-claim${claimToken ? `?claimToken=${encodeURIComponent(claimToken)}` : ""}`,
        ),
      ),
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

/** Settles an open intent with a verified webhook and runs the QR consumer. */
async function settle(
  intentId: string,
  amountIdr: number,
): Promise<{ before: number; after: number }> {
  const before = Date.now();
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
  return { before, after: Date.now() };
}

/** Service charge, tax and discount stamped on an order before it is paid. */
type Skew = {
  serviceIdr: number;
  taxIdr: number;
  discountIdr: number;
  inclusive?: boolean;
};

/**
 * Rewrites the amounts of a placed (unpaid) order so it carries service
 * charge, tax and discount, keeping the identity its CHECK requires. Returns
 * the new total and the spend the PRD counts for points (D18: after
 * discount, before tax and service charge).
 */
async function skewOrder(orderId: string, skew: Skew) {
  const inclusive = skew.inclusive === true;
  const { rows } = await owner.query(
    `UPDATE orders
        SET service_charge_idr = $3, tax_idr = $4, discount_idr = $5,
            prices_include_tax = $6, rounding_idr = 0,
            total_idr = CASE WHEN $6 THEN subtotal_idr - $5
                             ELSE subtotal_idr - $5 + $3 + $4 END
      WHERE tenant_id = $1 AND id = $2::uuid
      RETURNING subtotal_idr::bigint AS subtotal, total_idr::bigint AS total`,
    [
      tenant.tenantId,
      ulidToUuid(orderId),
      skew.serviceIdr,
      skew.taxIdr,
      skew.discountIdr,
      inclusive,
    ],
  );
  const subtotal = Number(rows[0].subtotal);
  const gross = inclusive ? subtotal - skew.serviceIdr - skew.taxIdr : subtotal;
  return {
    totalIdr: Number(rows[0].total),
    eligibleIdr: gross - skew.discountIdr,
  };
}

/** Places one pay-first order of one kopi (not paid). */
async function placeOrder(guest: Guest, skew?: Skew) {
  const added = await as(guest).add(ids.kopi, 0);
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status, JSON.stringify(placed.body)).toBe(201);
  const orderId = placed.body.data.order.id as string;
  if (skew) {
    const skewed = await skewOrder(orderId, skew);
    return { orderId, ...skewed };
  }
  // The seeded outlet charges service and tax: points follow the spend
  // before them (PRD D18), not the total the guest pays.
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

/** One order paid in full by a single payer (no split). */
async function paidOrder(guest: Guest, skew?: Skew) {
  const order = await placeOrder(guest, skew);
  const pay = await as(guest).payOrder(order.orderId);
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  const window = await settle(pay.body.data.id as string, order.totalIdr);
  return { ...order, ...window, intentId: pay.body.data.id as string };
}

/** Pro-rata spend of one part of a split order (rounded down). */
const shareOf = (
  split: {
    eligibleIdr: number;
    totalIdr: number;
    parts: { amountIdr: number }[];
  },
  index: number,
) =>
  Math.floor(
    (split.eligibleIdr * split.parts[index]!.amountIdr) / split.totalIdr,
  );

type SplitDto = { id: string; shareIndex: number; amountIdr: number };

/** One order split in two equal parts, both paid; returns parts and tokens. */
async function paidSplitOrder(guest: Guest, skew?: Skew) {
  const order = await placeOrder(guest, skew);
  const created = await as(guest).split({
    method: "equal",
    parts: 2,
    idempotencyKey: randomUUID(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const parts: SplitDto[] = [...created.body.data.splits].sort(
    (a: SplitDto, b: SplitDto) => a.shareIndex - b.shareIndex,
  );
  expect(parts).toHaveLength(2);
  const tokens: string[] = [];
  for (const part of parts) {
    const pay = await as(guest).paySplit(part.id);
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    await settle(pay.body.data.id as string, part.amountIdr);
    const claim = await as(guest).splitClaim(part.id, secretFor(part.id));
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(claim.body.data.claimToken).toMatch(/^sc_/);
    tokens.push(claim.body.data.claimToken as string);
  }
  return { ...order, parts, tokens };
}

/** A logged-in member with an active, verified profile and loyalty consent. */
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

const sourceIdMatches = (sourceId: string | null, orderId: string) =>
  sourceId !== null && [orderId, ulidToUuid(orderId)].includes(sourceId);

async function defaultProgram(options: Parameters<typeof seedProgram>[1] = {}) {
  await seedProgram(tenant.tenantId, {
    isActive: true,
    earnSpendIdr: SPEND_PER_POINT,
    earnPoints: 1,
    expiryMonths: 12,
    dailyCap: 100_000,
    ...options,
  });
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);

  tenant = await createIsolatedTenant(`pc-${randomUUID().slice(0, 6)}`);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Klaim Poin Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-PC', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
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
  await defaultProgram();
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  // Audit rows are append-only, so the isolated tenant stays; give it a valid
  // creator so the platform tenant list still parses it.
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    tenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
  await loyaltyOwner.end();
});

describe("pending guest claim protects its loyalty entity (Q80)", () => {
  it("refuses moving or clearing A before claim and preserves the guest's claim exactly once", async () => {
    const entityB = randomUUID();
    const outletB = randomUUID();
    await asOwnerTenant(tenant.tenantId, async (client) => {
      // This test runs first in a fresh tenant: no unrelated loyalty history
      // may cause the expected denial instead of the pending guest claim.
      const history = await client.query(
        `SELECT (SELECT count(*) FROM point_ledger WHERE tenant_id = $1)::int AS ledger,
                (SELECT count(*) FROM point_earn_records WHERE tenant_id = $1)::int AS earn,
                (SELECT count(*) FROM mission_progress WHERE tenant_id = $1)::int AS mission,
                (SELECT count(*) FROM reward_redemptions WHERE tenant_id = $1)::int AS reward,
                (SELECT count(*) FROM vouchers WHERE tenant_id = $1 AND source = 'loyalty_reward')::int AS voucher`,
        [tenant.tenantId],
      );
      expect(history.rows[0]).toEqual({
        ledger: 0,
        earn: 0,
        mission: 0,
        reward: 0,
        voucher: 0,
      });
      await client.query(
        "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity B', false)",
        [entityB, tenant.tenantId],
      );
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, 'Entity B outlet', 'Jl. B', 'Asia/Jakarta', '{}', 'active')`,
        [
          outletB,
          tenant.tenantId,
          tenant.brandId,
          entityB,
          `QB-${outletB.slice(0, 6).toUpperCase()}`,
        ],
      );
      await client.query(
        "UPDATE loyalty_programs SET legal_entity_id = $2 WHERE tenant_id = $1",
        [tenant.tenantId, tenant.legalEntityId],
      );
    });
    try {
      const guest = await seat();
      const order = await paidOrder(guest);
      const member = await newMember();
      const original = await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "SELECT claim_token_hash, claim_redeemed_at FROM orders WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, ulidToUuid(order.orderId)],
        ),
      );
      expect(original.rows[0].claim_token_hash).toBeTruthy();
      expect(original.rows[0].claim_redeemed_at).toBeNull();
      const input = {
        name: "Poin Member",
        earnRate: { spendIdr: idr(SPEND_PER_POINT), points: 1 },
        expiryMonths: 12,
        rollingMonths: 12,
        pointValueIdr: idr(100),
        isActive: true,
      };
      for (const legalEntityId of [entityB, null])
        await expect(
          updateLoyaltyProgram(contextOf(tenant.tenantId), randomUUID(), {
            ...input,
            legalEntityId,
          }),
        ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_LOCKED" });
      expect((await as(guest, member).pointClaim()).body.data.status).toBe(
        "available",
      );
      expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(0);
      expect(await ledgerClaims(member.profileId)).toHaveLength(0);
      const first = await as(guest, member).claim();
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect((await as(guest, member).claim()).status).toBe(200);
      expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(
        pointsOf(order.eligibleIdr),
      );
      expect(await ledgerClaims(member.profileId)).toHaveLength(1);
    } finally {
      await asOwnerTenant(tenant.tenantId, async (client) => {
        await client.query(
          "UPDATE loyalty_programs SET legal_entity_id = NULL WHERE tenant_id = $1",
          [tenant.tenantId],
        );
        await client.query(
          "DELETE FROM outlets WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, outletB],
        );
        await client.query(
          "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, entityB],
        );
      });
    }
  });

  it.each(["whole", "split"] as const)(
    "rejects an entity update while the %s payment consumer holds the order, then commits payment and claim token",
    async (kind) => {
      const entityB = randomUUID();
      const outletB = randomUUID();
      await asOwnerTenant(tenant.tenantId, async (client) => {
        await client.query(
          "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity B', false)",
          [entityB, tenant.tenantId],
        );
        await client.query(
          `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
           VALUES ($1, $2, $3, $4, $5, 'Entity B outlet', 'Jl. B', 'Asia/Jakarta', '{}', 'active')`,
          [
            outletB,
            tenant.tenantId,
            tenant.brandId,
            entityB,
            `QB-${outletB.slice(0, 6).toUpperCase()}`,
          ],
        );
        await client.query(
          "UPDATE loyalty_programs SET legal_entity_id = $2 WHERE tenant_id = $1",
          [tenant.tenantId, tenant.legalEntityId],
        );
      });
      try {
        const guest = await seat();
        const order = await placeOrder(guest);
        let intentId: string;
        let amountIdr: number;
        let splitId: string | null = null;
        if (kind === "split") {
          const created = await as(guest).split({
            method: "equal",
            parts: 2,
            idempotencyKey: randomUUID(),
          });
          expect(created.status, JSON.stringify(created.body)).toBe(201);
          const part = created.body.data.splits[0] as SplitDto;
          splitId = part.id;
          const pay = await as(guest).paySplit(part.id);
          expect(pay.status, JSON.stringify(pay.body)).toBe(201);
          intentId = pay.body.data.id as string;
          amountIdr = part.amountIdr;
        } else {
          const pay = await as(guest).payOrder(order.orderId);
          expect(pay.status, JSON.stringify(pay.body)).toBe(201);
          intentId = pay.body.data.id as string;
          amountIdr = order.totalIdr;
        }
        const context = contextOf(tenant.tenantId);
        await confirmPayment(context, intentId, {
          source: "verified_webhook",
          method: "qris",
          amountIdr,
          providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
          at: new Date().toISOString(),
        });
        const event = await paidEvent(intentId);
        let release!: () => void;
        let ready!: () => void;
        const held = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const proceed = new Promise<void>((resolve) => {
          release = resolve;
        });
        const consuming = withTenant(db, context, async (tx) => {
          await tx.execute(
            sql`SELECT id FROM orders WHERE tenant_id = ${tenant.tenantId} AND id = ${ulidToUuid(order.orderId)} FOR UPDATE`,
          );
          ready();
          await proceed;
          await deliverOrderPaymentEvent(context, event, tx, new Date());
        });
        try {
          await Promise.race([
            held,
            consuming.then(() => {
              throw new Error("Consumer finished before the lock test");
            }),
          ]);
          await expect(
            updateLoyaltyProgram(context, randomUUID(), {
              name: "Poin Member",
              earnRate: { spendIdr: idr(SPEND_PER_POINT), points: 1 },
              expiryMonths: 12,
              rollingMonths: 12,
              pointValueIdr: idr(100),
              isActive: true,
              legalEntityId: entityB,
            }),
          ).rejects.toMatchObject({ status: 409, code: "LOYALTY_ENTITY_BUSY" });
        } finally {
          release();
        }
        await consuming;
        const payment = await asOwnerTenant(tenant.tenantId, (client) =>
          client.query(
            "SELECT status FROM payment_intents WHERE tenant_id = $1 AND id = $2",
            [tenant.tenantId, intentId],
          ),
        );
        expect(payment.rows[0].status).toBe("paid");
        if (splitId !== null) {
          const part = await asOwnerTenant(tenant.tenantId, (client) =>
            client.query(
              "SELECT status, claim_token_hash FROM bill_splits WHERE tenant_id = $1 AND id = $2",
              [tenant.tenantId, splitId],
            ),
          );
          expect(part.rows[0]).toMatchObject({ status: "paid" });
          expect(part.rows[0].claim_token_hash).toBeTruthy();
          const claim = await as(guest).splitClaim(splitId, secretFor(splitId));
          expect(claim.status, JSON.stringify(claim.body)).toBe(200);
          expect(claim.body.data.claimToken).toMatch(/^sc_/);
        } else {
          const row = await asOwnerTenant(tenant.tenantId, (client) =>
            client.query(
              "SELECT status, claim_token_hash FROM orders WHERE tenant_id = $1 AND id = $2",
              [tenant.tenantId, ulidToUuid(order.orderId)],
            ),
          );
          expect(row.rows[0]).toMatchObject({ status: "sent" });
          expect(row.rows[0].claim_token_hash).toBeTruthy();
          expect((await as(guest).pointClaim()).body.data.status).toBe(
            "available",
          );
        }
      } finally {
        await asOwnerTenant(tenant.tenantId, async (client) => {
          await client.query(
            "UPDATE loyalty_programs SET legal_entity_id = NULL WHERE tenant_id = $1",
            [tenant.tenantId],
          );
          await client.query(
            "DELETE FROM outlets WHERE tenant_id = $1 AND id = $2",
            [tenant.tenantId, outletB],
          );
          await client.query(
            "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
            [tenant.tenantId, entityB],
          );
        });
      }
    },
  );

  it("freezes an ambiguous guest claim's remaining time until the entity is resolved", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    const member = await newMember();
    const entityB = randomUUID();
    const outletB = randomUUID();
    const now = new Date();
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Ambiguous B', false)",
        [entityB, tenant.tenantId],
      );
      await client.query(
        `INSERT INTO outlets (id, tenant_id, brand_id, legal_entity_id, code, name, address, timezone, opening_hours, status)
         VALUES ($1, $2, $3, $4, $5, 'Ambiguous outlet', 'Jl. B', 'Asia/Jakarta', '{}', 'active')`,
        [
          outletB,
          tenant.tenantId,
          tenant.brandId,
          entityB,
          `QA-${outletB.slice(0, 6).toUpperCase()}`,
        ],
      );
      await client.query(
        "UPDATE loyalty_programs SET legal_entity_id = NULL WHERE tenant_id = $1",
        [tenant.tenantId],
      );
      await client.query(
        "UPDATE orders SET claim_expires_at = $3 WHERE tenant_id = $1 AND id = $2",
        [
          tenant.tenantId,
          ulidToUuid(order.orderId),
          new Date(now.getTime() + 60_000),
        ],
      );
    });
    try {
      const claim = (at: Date) =>
        claimSessionPoints(
          contextOf(tenant.tenantId),
          guest.token,
          guest.sessionId,
          { userId: member.userId },
          at,
        );
      await expect(claim(now)).rejects.toThrow();
      expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(0);
      expect(await ledgerClaims(member.profileId)).toHaveLength(0);
      const beforePause = await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "SELECT state, remaining_ms, paused_at FROM loyalty_claim_pauses WHERE tenant_id = $1 AND order_id = $2",
          [tenant.tenantId, ulidToUuid(order.orderId)],
        ),
      );
      expect(beforePause.rows[0].state).toBe("ambiguous");
      expect(Number(beforePause.rows[0].remaining_ms)).toBe(60_000);
      // A configuration change does not itself reconcile historic entity
      // ownership; the original right remains parked without a ticking TTL.
      await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE outlets SET legal_entity_id = $3 WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, outletB, tenant.legalEntityId],
        ),
      );
      const resolvedAt = new Date(now.getTime() + 120_000);
      await expect(claim(resolvedAt)).rejects.toThrow();
      const afterPause = await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "SELECT state, remaining_ms, paused_at FROM loyalty_claim_pauses WHERE tenant_id = $1 AND order_id = $2",
          [tenant.tenantId, ulidToUuid(order.orderId)],
        ),
      );
      expect(afterPause.rows).toEqual(beforePause.rows);
      expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(0);
      expect(await ledgerClaims(member.profileId)).toHaveLength(0);
    } finally {
      await asOwnerTenant(tenant.tenantId, async (client) => {
        await client.query(
          "DELETE FROM outlets WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, outletB],
        );
        await client.query(
          "DELETE FROM legal_entities WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, entityB],
        );
      });
    }
  });
});

describe("guest point claim: reading (legend-n1mp)", () => {
  it("answers 401 without a session credential, on GET and POST", async () => {
    const guest = await seat();
    const base = `/api/table-sessions/${guest.sessionId}/points-claim`;
    const get = await agent(app).get(base).set("Host", tenant.hostname);
    expect(get.status).toBe(401);
    const post = await agent(app)
      .post(base)
      .set("Host", tenant.hostname)
      .set(originHeader)
      .send({ idempotencyKey: randomUUID() });
    expect(post.status).toBe(401);
  });

  it("does not resolve a credential of another tenant's host", async () => {
    const guest = await seat();
    const res = await as(guest, undefined, seededHostname).pointClaim();
    expect(res.status).toBe(401);
  });

  it("is unavailable without a paid unit, and tells an anonymous guest to log in", async () => {
    const guest = await seat();
    const empty = await as(guest).pointClaim();
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(() => getPointClaim.response.parse(empty.body)).not.toThrow();
    expect(empty.body.data).toMatchObject({
      sessionId: guest.sessionId,
      status: "unavailable",
      paidIdr: 0,
      points: 0,
      claimableUntil: null,
      requiresLogin: true,
    });
    // An order that is placed but not paid is not a unit either.
    await placeOrder(guest);
    const unpaid = await as(guest).pointClaim();
    expect(unpaid.body.data.status).toBe("unavailable");
  });

  it("offers a paid single-payer order: amount, points and 24 hours to claim", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    const res = await as(guest).pointClaim();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(() => getPointClaim.response.parse(res.body)).not.toThrow();
    const claim = res.body.data;
    expect(claim.status).toBe("available");
    expect(claim.paidIdr).toBe(order.totalIdr);
    expect(claim.points).toBe(pointsOf(order.eligibleIdr));
    expect(claim.points).toBeGreaterThan(0);
    expect(claim.requiresLogin).toBe(true);
    const until = new Date(claim.claimableUntil).getTime();
    expect(until).toBeGreaterThanOrEqual(order.before + 24 * HOUR - 1000);
    expect(until).toBeLessThanOrEqual(order.after + 24 * HOUR + 1000);
  });

  it("a logged-in member no longer needs to log in", async () => {
    const guest = await seat();
    await paidOrder(guest);
    const member = await newMember();
    const res = await as(guest, member).pointClaim();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe("available");
    expect(res.body.data.requiresLogin).toBe(false);
  });

  it("is unavailable when the program is inactive or the amount earns zero points", async () => {
    const guest = await seat();
    await paidOrder(guest);
    await defaultProgram({ isActive: false });
    const inactive = await as(guest).pointClaim();
    expect(inactive.status).toBe(200);
    expect(inactive.body.data.status).toBe("unavailable");
    expect(inactive.body.data.claimableUntil).toBeNull();

    await defaultProgram({ earnSpendIdr: 100_000_000 });
    const zero = await as(guest).pointClaim();
    expect(zero.status).toBe(200);
    expect(zero.body.data.status).toBe("unavailable");

    const member = await newMember();
    const post = await as(guest, member).claim();
    expect(post.status).toBe(409);
    expect(await ledgerClaims(member.profileId)).toEqual([]);
  });

  it("is unavailable when the order already has a member attached", async () => {
    const guest = await seat();
    const order = await placeOrder(guest);
    // A member attached through the table session before payment: the earn
    // consumer will credit them, so a claim would double the points.
    const attached = await seedProfile(tenant.tenantId);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE orders SET customer_profile_id = $3, customer_attached_via = 'pwa_session',
                customer_attached_at = now()
          WHERE tenant_id = $1 AND id = $2::uuid`,
        [tenant.tenantId, ulidToUuid(order.orderId), attached.id],
      ),
    );
    const pay = await as(guest).payOrder(order.orderId);
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    await settle(pay.body.data.id as string, order.totalIdr);

    const res = await as(guest).pointClaim();
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("unavailable");
    const member = await newMember();
    const post = await as(guest, member).claim();
    expect(post.status).toBe(409);
    expect(post.body.error.code).toBe("CLAIM_NOT_AVAILABLE");
    expect(await ledgerClaims(member.profileId)).toEqual([]);
  });

  it("becomes unavailable when the order is voided", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    expect((await as(guest).pointClaim()).body.data.status).toBe("available");
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE orders SET status = 'voided', voided_at = now(), void_reason = 'uji'
          WHERE tenant_id = $1 AND id = $2::uuid`,
        [tenant.tenantId, ulidToUuid(order.orderId)],
      ),
    );
    const res = await as(guest).pointClaim();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe("unavailable");
    const member = await newMember();
    const post = await as(guest, member).claim();
    expect(post.status).toBe(409);
    expect(await ledgerClaims(member.profileId)).toEqual([]);
  });

  it("reads expired after 24 hours and refuses the claim", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE orders SET claim_expires_at = now() - interval '1 minute'
          WHERE tenant_id = $1 AND id = $2::uuid`,
        [tenant.tenantId, ulidToUuid(order.orderId)],
      ),
    );
    const res = await as(guest).pointClaim();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe("expired");
    expect(res.body.data.claimableUntil).toBeNull();
    const member = await newMember();
    const post = await as(guest, member).claim();
    expect(post.status).toBe(409);
    expect(post.body.error.code).toBe("CLAIM_NOT_AVAILABLE");
    expect(await ledgerClaims(member.profileId)).toEqual([]);
  });

  it("never shows another session's payment", async () => {
    const paidGuest = await seat();
    await paidOrder(paidGuest);
    const stranger = await seat();
    const res = await as(stranger).pointClaim();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      sessionId: stranger.sessionId,
      status: "unavailable",
      paidIdr: 0,
      points: 0,
    });
  });
});

describe("guest point claim: claiming (legend-n1mp)", () => {
  it("uses the program committed before acquiring the entity lock without over-crediting", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    const member = await newMember();
    let release!: () => void;
    let reached!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const atGuard = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const actualGuard = loyaltyEntityGuard.checkLoyaltyOutletEntity;
    const guard = vi
      .spyOn(loyaltyEntityGuard, "checkLoyaltyOutletEntity")
      .mockImplementationOnce(async (...args) => {
        reached();
        await released;
        return actualGuard(...args);
      });
    const claim = as(guest, member)
      .claim()
      .then((result) => result);
    try {
      await Promise.race([
        atGuard,
        claim.then(() => {
          throw new Error("Claim finished before guard");
        }),
      ]);
      await asOwnerTenant(tenant.tenantId, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`loyalty-entity:${tenant.tenantId}`],
        );
        await client.query(
          "UPDATE loyalty_programs SET earn_spend_idr = $2 WHERE tenant_id = $1",
          [tenant.tenantId, SPEND_PER_POINT * 2],
        );
      });
    } finally {
      release();
    }
    try {
      const result = await claim;
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const expected = Math.floor(order.eligibleIdr / (SPEND_PER_POINT * 2));
      expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(expected);
      const rows = await ledgerClaims(member.profileId);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.points)).toBe(expected);
      expect((await as(guest, member).claim()).status).toBe(200);
      expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(expected);
    } finally {
      guard.mockRestore();
    }
  });

  it("does not consume a table claim for another legal entity and retains it parked after a settings change", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    const member = await newMember();
    const entityA = randomUUID();
    await asOwnerTenant(tenant.tenantId, async (client) => {
      await client.query(
        "INSERT INTO legal_entities (id, tenant_id, name, is_pkp) VALUES ($1, $2, 'Entity A', false)",
        [entityA, tenant.tenantId],
      );
      await client.query(
        "UPDATE loyalty_programs SET legal_entity_id = $2 WHERE tenant_id = $1",
        [tenant.tenantId, entityA],
      );
    });
    try {
      // The paid order belongs to the original outlet/entity B, not A.
      const before = await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "SELECT status FROM orders WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, ulidToUuid(order.orderId)],
        ),
      );
      const wrong = await as(guest, member).claim();
      expect(wrong.status).toBeGreaterThanOrEqual(400);
      expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(0);
      expect(await ledgerClaims(member.profileId)).toHaveLength(0);
      const state = await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "SELECT status, claim_redeemed_at FROM orders WHERE tenant_id = $1 AND id = $2",
          [tenant.tenantId, ulidToUuid(order.orderId)],
        ),
      );
      expect(state.rows[0].status).toBe(before.rows[0].status);
      expect(state.rows[0].claim_redeemed_at).toBeNull();

      // A raw setting change is not a reconciliation of historical rights.
      await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE loyalty_programs SET legal_entity_id = $2 WHERE tenant_id = $1",
          [tenant.tenantId, tenant.legalEntityId],
        ),
      );
      expect((await as(guest, member).claim()).status).toBeGreaterThanOrEqual(
        400,
      );
      expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(0);
      expect(await ledgerClaims(member.profileId)).toHaveLength(0);
      const paused = await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "SELECT state, remaining_ms FROM loyalty_claim_pauses WHERE tenant_id = $1 AND order_id = $2",
          [tenant.tenantId, ulidToUuid(order.orderId)],
        ),
      );
      expect(paused.rows[0].state).toBe("ambiguous");
      expect(Number(paused.rows[0].remaining_ms)).toBeGreaterThan(0);
    } finally {
      await asOwnerTenant(tenant.tenantId, (client) =>
        client.query(
          "UPDATE loyalty_programs SET legal_entity_id = NULL WHERE tenant_id = $1",
          [tenant.tenantId],
        ),
      );
    }
  });

  it("POST without a login is 401 and posts nothing", async () => {
    const guest = await seat();
    await paidOrder(guest);
    const res = await as(guest).claim();
    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect((await as(guest).pointClaim()).body.data.status).toBe("available");
  });

  it("a member claims once: one earn/table_claim ledger row and the balance goes up", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    const member = await newMember();
    const expected = pointsOf(order.eligibleIdr);
    const before = await balanceOf(tenant.tenantId, member.profileId);

    const res = await as(guest, member).claim();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(() => getPointClaim.response.parse(res.body)).not.toThrow();
    expect(res.body.data).toMatchObject({
      sessionId: guest.sessionId,
      status: "claimed",
      paidIdr: order.totalIdr,
      points: expected,
      requiresLogin: false,
    });

    const rows = await ledgerClaims(member.profileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "earn", source_type: "table_claim" });
    expect(sourceIdMatches(rows[0]!.source_id, order.orderId)).toBe(true);
    expect(Number(rows[0]!.points)).toBe(expected);
    expect(rows[0]!.expires_at).not.toBeNull();
    expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(
      before + expected,
    );

    const after = await as(guest, member).pointClaim();
    expect(after.body.data.status).toBe("claimed");
    expect(after.body.data.points).toBe(expected);
  });

  it("repeating the claim as the same member is idempotent", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    const member = await newMember();
    const first = await as(guest, member).claim();
    expect(first.status).toBe(200);
    const again = await as(guest, member).claim();
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data.status).toBe("claimed");
    expect(again.body.data.points).toBe(pointsOf(order.eligibleIdr));
    expect(await ledgerClaims(member.profileId)).toHaveLength(1);
    expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(
      pointsOf(order.eligibleIdr),
    );
  });

  it("another member cannot claim a unit that is already claimed", async () => {
    const guest = await seat();
    await paidOrder(guest);
    const first = await newMember();
    const second = await newMember();
    expect((await as(guest, first).claim()).status).toBe(200);
    const res = await as(guest, second).claim();
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("CLAIM_NOT_AVAILABLE");
    expect(await ledgerClaims(second.profileId)).toEqual([]);
    expect(await balanceOf(tenant.tenantId, second.profileId)).toBe(0);
    expect(await ledgerClaims(first.profileId)).toHaveLength(1);
  });

  it("a logged-in user without an eligible member profile is refused", async () => {
    const guest = await seat();
    await paidOrder(guest);
    const noProfile = await newMemberUser(app);
    const noConsent = await newMemberUser(app);
    const noConsentProfile = await seedProfile(tenant.tenantId, {
      userId: noConsent.userId,
    });
    const unverified = await newMemberUser(app);
    const unverifiedProfile = await seedProfile(tenant.tenantId, {
      userId: unverified.userId,
      status: "pending_verification",
    });

    for (const user of [noProfile, noConsent, unverified]) {
      const res = await as(guest, user).claim();
      expect([403, 409], JSON.stringify(res.body)).toContain(res.status);
      expect(res.body.error.message).toBeTruthy();
    }
    expect(await ledgerClaims(noConsentProfile.id)).toEqual([]);
    expect(await ledgerClaims(unverifiedProfile.id)).toEqual([]);
    // The unit is still free for an eligible member.
    expect((await as(guest).pointClaim()).body.data.status).toBe("available");
  });

  it("clips the points to what is left of the daily cap and refuses when none is left", async () => {
    await defaultProgram({ dailyCap: 10 });
    const member = await newMember();

    const first = await seat();
    const orderOne = await paidOrder(first);
    expect(pointsOf(orderOne.eligibleIdr)).toBeGreaterThan(10);
    const one = await as(first, member).claim();
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.data.points).toBe(10);
    const rows = await ledgerClaims(member.profileId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.points)).toBe(10);

    // Same member, same business date, second order: the cap is used up.
    const second = await seat();
    await paidOrder(second);
    const two = await as(second, member).claim();
    expect(two.status, JSON.stringify(two.body)).toBe(409);
    expect(await ledgerClaims(member.profileId)).toHaveLength(1);
    expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(10);
    // A different member is not affected by this member's cap.
    const other = await newMember();
    const three = await as(second, other).claim();
    expect(three.status, JSON.stringify(three.body)).toBe(200);
    expect(three.body.data.points).toBe(10);
  });
});

describe("guest point claim: split parts (legend-n1mp)", () => {
  it("a split part is claimed only with its own token, one person per part", async () => {
    const guest = await seat();
    const split = await paidSplitOrder(guest);
    const [partA, partB] = split.parts as [SplitDto, SplitDto];
    const [tokenA, tokenB] = split.tokens as [string, string];

    // Without a token no split part is offered (one person, one part).
    const bare = await as(guest).pointClaim();
    expect(bare.status, JSON.stringify(bare.body)).toBe(200);
    expect(bare.body.data.status).toBe("unavailable");
    expect(bare.body.data.paidIdr).toBe(0);

    // With a token: exactly that part.
    const viewA = await as(guest).pointClaim(tokenA);
    expect(viewA.status, JSON.stringify(viewA.body)).toBe(200);
    expect(viewA.body.data.status).toBe("available");
    expect(viewA.body.data.paidIdr).toBe(partA.amountIdr);
    expect(viewA.body.data.points).toBe(pointsOf(shareOf(split, 0)));

    const memberA = await newMember();
    const memberB = await newMember();

    // POST without a token cannot take a split part.
    const noToken = await as(guest, memberA).claim();
    expect(noToken.status).toBe(409);
    expect(await ledgerClaims(memberA.profileId)).toEqual([]);

    const claimedA = await as(guest, memberA).claim(tokenA);
    expect(claimedA.status, JSON.stringify(claimedA.body)).toBe(200);
    expect(claimedA.body.data.status).toBe("claimed");
    expect(claimedA.body.data.paidIdr).toBe(partA.amountIdr);
    const rowsA = await ledgerClaims(memberA.profileId);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({
      type: "earn",
      source_type: "table_claim",
    });
    expect(rowsA[0]!.source_id).toBe(partA.id);
    expect(Number(rowsA[0]!.points)).toBe(pointsOf(shareOf(split, 0)));

    // Part B is untouched by A's redeem: still available to another member.
    const viewB = await as(guest).pointClaim(tokenB);
    expect(viewB.body.data.status).toBe("available");
    const stolen = await as(guest, memberB).claim(tokenA);
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe("CLAIM_NOT_AVAILABLE");
    const claimedB = await as(guest, memberB).claim(tokenB);
    expect(claimedB.status, JSON.stringify(claimedB.body)).toBe(200);
    const rowsB = await ledgerClaims(memberB.profileId);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.source_id).toBe(partB.id);
    // Member A never received part B.
    expect(await ledgerClaims(memberA.profileId)).toHaveLength(1);
  });

  it("a token of another session leaks nothing and posts nothing", async () => {
    const owning = await seat();
    const split = await paidSplitOrder(owning);
    const stranger = await seat();
    const member = await newMember();
    const token = split.tokens[0]!;

    const read = await as(stranger).pointClaim(token);
    expect([200, 404], JSON.stringify(read.body)).toContain(read.status);
    if (read.status === 200) {
      expect(read.body.data.status).toBe("unavailable");
      expect(read.body.data.points).toBe(0);
      expect(read.body.data.paidIdr).toBe(0);
    }
    const post = await as(stranger, member).claim(token);
    expect([404, 409], JSON.stringify(post.body)).toContain(post.status);
    expect(await ledgerClaims(member.profileId)).toEqual([]);
    // The rightful session can still claim it.
    const rightful = await as(owning, member).claim(token);
    expect(rightful.status, JSON.stringify(rightful.body)).toBe(200);
  });

  it("a malformed or unknown token is refused", async () => {
    const guest = await seat();
    const member = await newMember();
    const unknown = `sc_${randomBytes(32).toString("base64url")}`;
    const post = await as(guest, member).claim(unknown);
    expect([404, 409, 422], JSON.stringify(post.body)).toContain(post.status);
    expect(await ledgerClaims(member.profileId)).toEqual([]);
  });
});

describe("guest point claim: review hardening (legend-n1mp)", () => {
  const recordRefund = (intentId: string, amountIdr: number, status: string) =>
    asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO payment_refunds
           (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
         VALUES ($1, $2, $3, $4, 'uji', $5, $6)`,
        [
          tenant.tenantId,
          tenant.outletId,
          intentId,
          amountIdr,
          status,
          staff.userId,
        ],
      ),
    );

  it("a refunded order cannot be claimed: GET unavailable, POST 409", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    expect((await as(guest).pointClaim()).body.data.status).toBe("available");
    await recordRefund(order.intentId, order.totalIdr, "pending");
    const res = await as(guest).pointClaim();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe("unavailable");
    const member = await newMember();
    const post = await as(guest, member).claim();
    expect(post.status, JSON.stringify(post.body)).toBe(409);
    expect(await ledgerClaims(member.profileId)).toEqual([]);
  });

  it("a failed refund does not block the claim", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    await recordRefund(order.intentId, order.totalIdr, "failed");
    expect((await as(guest).pointClaim()).body.data.status).toBe("available");
  });

  it("a refund of a split part's order blocks its parts", async () => {
    const guest = await seat();
    const split = await paidSplitOrder(guest);
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM payment_intents WHERE tenant_id = $1 AND bill_split_id = $2`,
      [tenant.tenantId, split.parts[0]!.id],
    );
    expect(rows).toHaveLength(1);
    await recordRefund(rows[0]!.id, split.parts[0]!.amountIdr, "completed");
    const member = await newMember();
    const post = await as(guest, member).claim(split.tokens[1]!);
    expect(post.status, JSON.stringify(post.body)).toBe(409);
    expect(await ledgerClaims(member.profileId)).toEqual([]);
  });

  it("member B never sees member A's points after A claimed", async () => {
    const guest = await seat();
    await paidOrder(guest);
    const a = await newMember();
    const b = await newMember();
    expect((await as(guest, a).claim()).status).toBe(200);
    const view = await as(guest, b).pointClaim();
    expect(view.body.data.status).toBe("unavailable");
    expect(view.body.data.points).toBe(0);
    const post = await as(guest, b).claim();
    expect(post.status).toBe(409);
    expect(await balanceOf(tenant.tenantId, b.profileId)).toBe(0);
  });

  it("a concurrent double claim by two members: one 200, one 409, one ledger row", async () => {
    const guest = await seat();
    await paidOrder(guest);
    const a = await newMember();
    const b = await newMember();
    const [ra, rb] = await Promise.all([
      as(guest, a).claim(),
      as(guest, b).claim(),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const rows = [
      ...(await ledgerClaims(a.profileId)),
      ...(await ledgerClaims(b.profileId)),
    ];
    expect(rows).toHaveLength(1);
    const loser = ra.status === 409 ? a : b;
    expect(await balanceOf(tenant.tenantId, loser.profileId)).toBe(0);
  });

  it("a claim with a valid token still works after the table session closed", async () => {
    const guest = await seat();
    const split = await paidSplitOrder(guest);
    await owner.query(
      `UPDATE table_sessions
          SET status = 'closed', closed_at = now(), closed_reason = 'paid_and_cleaned'
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, guest.sessionId],
    );
    const member = await newMember();
    const view = await as(guest).pointClaim(split.tokens[0]!);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.data.status).toBe("available");
    const res = await as(guest, member).claim(split.tokens[0]!);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe("claimed");
    // Without a token the open-session rule stays.
    const bare = await as(guest, member).claim();
    expect(bare.status).toBe(401);
  });
});

describe("guest point claim: spend base and training (legend-n1mp)", () => {
  const skew: Skew = { serviceIdr: 4000, taxIdr: 4000, discountIdr: 2000 };

  it("counts points on spend after discount, before tax and service charge (PRD D18)", async () => {
    const guest = await seat();
    const order = await paidOrder(guest, skew);
    expect(order.totalIdr).toBeGreaterThan(order.eligibleIdr);
    const view = await as(guest).pointClaim();
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.body.data.status).toBe("available");
    // The amount paid stays what the guest paid; the points follow the spend.
    expect(view.body.data.paidIdr).toBe(order.totalIdr);
    expect(view.body.data.points).toBe(pointsOf(order.eligibleIdr));
    const member = await newMember();
    const res = await as(guest, member).claim();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = await ledgerClaims(member.profileId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.points)).toBe(pointsOf(order.eligibleIdr));
    expect(await balanceOf(tenant.tenantId, member.profileId)).toBe(
      pointsOf(order.eligibleIdr),
    );
  });

  it("strips the tax and service charge that tax-inclusive prices already hold", async () => {
    const guest = await seat();
    const order = await paidOrder(guest, {
      serviceIdr: 3000,
      taxIdr: 2000,
      discountIdr: 0,
      inclusive: true,
    });
    expect(order.eligibleIdr).toBe(order.totalIdr - 5000);
    const view = await as(guest).pointClaim();
    expect(view.body.data.points).toBe(pointsOf(order.eligibleIdr));
  });

  it("gives a split part its pro-rata share of the spend", async () => {
    const guest = await seat();
    const split = await paidSplitOrder(guest, skew);
    for (const [index, part] of split.parts.entries()) {
      const share = shareOf(split, index);
      const view = await as(guest).pointClaim(split.tokens[index]!);
      expect(view.status, JSON.stringify(view.body)).toBe(200);
      expect(view.body.data.paidIdr).toBe(part.amountIdr);
      expect(view.body.data.points).toBe(pointsOf(share));
    }
    const member = await newMember();
    const res = await as(guest, member).claim(split.tokens[0]!);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Number((await ledgerClaims(member.profileId))[0]!.points)).toBe(
      pointsOf(shareOf(split, 0)),
    );
  });

  // pos_orders only knows POS channels and must match the order's channel.
  const markTraining = async (orderId: string) => {
    await owner.query(
      "UPDATE orders SET channel = 'pos' WHERE tenant_id = $1 AND id = $2::uuid",
      [tenant.tenantId, ulidToUuid(orderId)],
    );
    await owner.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
       SELECT id, tenant_id, outlet_id, channel, true
         FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, ulidToUuid(orderId)],
    );
  };

  it("a training order cannot be claimed: GET unavailable, POST 409, no ledger row", async () => {
    const guest = await seat();
    const order = await paidOrder(guest);
    expect((await as(guest).pointClaim()).body.data.status).toBe("available");
    await markTraining(order.orderId);
    const res = await as(guest).pointClaim();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.status).toBe("unavailable");
    const member = await newMember();
    const post = await as(guest, member).claim();
    expect(post.status, JSON.stringify(post.body)).toBe(409);
    expect(await ledgerClaims(member.profileId)).toEqual([]);
  });

  it("the parts of a training order cannot be claimed either", async () => {
    const guest = await seat();
    const split = await paidSplitOrder(guest);
    await markTraining(split.orderId);
    const view = await as(guest).pointClaim(split.tokens[0]!);
    expect(view.body.data.status).toBe("unavailable");
    const member = await newMember();
    const post = await as(guest, member).claim(split.tokens[0]!);
    expect(post.status, JSON.stringify(post.body)).toBe(409);
    expect(await ledgerClaims(member.profileId)).toEqual([]);
  });
});
