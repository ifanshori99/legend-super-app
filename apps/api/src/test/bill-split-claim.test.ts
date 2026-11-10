// legend-ms3 split part claim token (D4/D5 of docs/briefs/sub-split-bill-design.md):
// a paid part issues a one-time claim token (`sc_` + base64url) that stays
// redeemable for 24 hours; the guest reads its state from
// GET /api/table-sessions/:sessionId/splits/:splitId/claim. The redeem has no
// public route yet (waits legend-111j), so it is driven through the service.
//
// Real Express app and PostgreSQL with RLS in one isolated tenant (setup as
// bill-split.test.ts). One order is split into 5 equal parts; parts 1-4 are
// paid through the real payment + QR consumer path, part 0 stays unpaid. Each
// case uses its own part, so cases do not depend on each other's redeems.
//
// Assumptions:
// - Redeem and getSplitClaim take an explicit `now`; "after 24h" is a `now`
//   25 hours (and 24h + 1 minute) after the real payment, not a sleep.
// - The claim window is 24h from `paid_at`: redeem at +23h works, at
//   +24h1m returns null and GET reads `expired`.
// - The raw token is never stored: the DB keeps sha256(token) as hex (64 chars,
//   as D4) and a sealed copy that is not the raw token.
// - After redeem the state is `claimed`; whether it still echoes the token is
//   not specified, so it is not asserted.
// - A guest of another table session asking for a part that is not in their
//   session gets 404 (D4 lockSplitPartTx "404 if not in session").

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
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
import {
  getSplitClaim,
  getSplitClaimByToken,
} from "../services/bill-split.service.ts";
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
import { seedProfile } from "./member-loyalty-helpers.ts";

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };
const createdTenantIds: string[] = [];

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
      qrPayload: "00020101021226FAKEQRCLAIM",
      issuer: null,
    };
    return {
      providerRef: `QSC-${randomBytes(6).toString("hex")}-${this.created}`,
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

async function seatAtNewTable(): Promise<Guest> {
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

function as(guest: Guest) {
  const client = agent(app);
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
    split: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/splits`)).send(body),
    paySplit: (billSplitId: string) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "split", billSplitId },
        method: "qris",
        idempotencyKey: randomUUID(),
      }),
    claim: (splitId: string, paymentId?: string) =>
      auth(
        client.get(
          `${base}/splits/${splitId}/claim${paymentId ? `?paymentId=${paymentId}` : ""}`,
        ),
      ),
  };
}

type SplitDto = { id: string; shareIndex: number; amountIdr: number };
type Claim = {
  billSplitId: string;
  status: "unavailable" | "available" | "claimed" | "expired";
  claimToken: string | null;
  claimableUntil: string | null;
};

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

async function deliver(event: EventEnvelope) {
  const context = contextOf(tenant.tenantId);
  await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, new Date()),
  );
}

/** Pays one part through a real code, a verified webhook and the QR consumer. */
async function payPart(guest: Guest, part: SplitDto): Promise<EventEnvelope> {
  const pay = await as(guest).paySplit(part.id);
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  const intentId = pay.body.data.id as string;
  await confirmPayment(contextOf(tenant.tenantId), intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: part.amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const event = await paidEvent(intentId);
  await deliver(event);
  return event;
}

/** The payment intent of a part: the guest's proof that the part is theirs. */
async function intentOf(splitId: string): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM payment_intents
      WHERE tenant_id = $1 AND bill_split_id = $2::uuid ORDER BY created_at LIMIT 1`,
    [tenant.tenantId, splitId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.id;
}

/** HTTP claim read with the part's own payment intent as proof. */
async function claimFor(guest: Guest, splitId: string) {
  return as(guest).claim(splitId, await intentOf(splitId));
}

async function readClaim(guest: Guest, splitId: string, now = new Date()) {
  return getSplitClaim(
    contextOf(tenant.tenantId),
    guest.token,
    guest.sessionId,
    splitId,
    await intentOf(splitId),
    now,
  ) as Promise<Claim>;
}

// The redeem itself is table-claim.service `redeemSplit` (POST points-claim,
// ws03-points-claim.test.ts); here the redeemed state is set by the owner.
async function markRedeemed(splitId: string) {
  await owner.query(
    "UPDATE bill_splits SET claim_redeemed_at = now() WHERE tenant_id = $1 AND id = $2::uuid",
    [tenant.tenantId, splitId],
  );
}

async function claimRow(splitId: string) {
  const { rows } = await owner.query<{
    status: string;
    paid_at: Date | null;
    claim_token_hash: string | null;
    claim_token_sealed: string | null;
    claim_expires_at: Date | null;
    claim_redeemed_at: Date | null;
  }>(
    `SELECT status, paid_at, claim_token_hash, claim_token_sealed, claim_expires_at, claim_redeemed_at
       FROM bill_splits WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenant.tenantId, splitId],
  );
  return rows[0]!;
}

let guest: Guest;
let orderParts: SplitDto[];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);

  tenant = await createIsolatedTenant(`bsc-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(tenant.tenantId);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Split Claim Uji', 0)`,
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
       VALUES ($1, $2, NULL, 'PBJT-CLM', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });

  // One order, 5 equal parts: part 0 stays unpaid, parts 1-4 are paid, so the
  // order itself is never fully paid and stays awaiting_payment.
  guest = await seatAtNewTable();
  const added = await as(guest).add(ids.kopi, 0);
  expect(added.status).toBe(201);
  const placed = await as(guest).checkout(added.body.data.cart.version);
  expect(placed.status).toBe(201);
  const created = await as(guest).split({
    method: "equal",
    parts: 5,
    idempotencyKey: randomUUID(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  orderParts = [...created.body.data.splits].sort(
    (a: SplitDto, b: SplitDto) => a.shareIndex - b.shareIndex,
  );
  expect(orderParts).toHaveLength(5);
  for (const part of orderParts.slice(1)) await payPart(guest, part);
});

afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  setAuditWriter(null);
  // Audit rows are append-only, so the isolated tenant stays; give it a valid
  // creator so the platform tenant list still parses it.
  for (const tenantId of createdTenantIds)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      tenantId,
      randomUUID(),
    ]);
  await owner.end();
});

describe("split part claim token (legend-ms3)", () => {
  it("SPLIT-CLAIM-UNAVAILABLE an unpaid part has no token", async () => {
    const part = orderParts[0]!;
    // The guest opened a code for the part but has not paid it yet.
    const pay = await as(guest).paySplit(part.id);
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const response = await as(guest).claim(part.id, pay.body.data.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual({
      billSplitId: part.id,
      status: "unavailable",
      claimToken: null,
      claimableUntil: null,
    });
    const row = await claimRow(part.id);
    expect(row.status).toBe("pending");
    expect(row.claim_token_hash).toBeNull();
  });

  it("SPLIT-CLAIM-ISSUED a paid part issues a token valid 24 hours, stored only as hash and sealed copy", async () => {
    const part = orderParts[1]!;
    const response = await claimFor(guest, part.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const claim: Claim = response.body.data;
    expect(claim.billSplitId).toBe(part.id);
    expect(claim.status).toBe("available");
    expect(claim.claimToken).toMatch(/^sc_[A-Za-z0-9_-]+$/);
    const until = new Date(claim.claimableUntil!).getTime();
    expect(until).toBeGreaterThan(Date.now() + 23 * HOUR);
    expect(until).toBeLessThanOrEqual(Date.now() + 24 * HOUR + 60_000);

    const row = await claimRow(part.id);
    expect(row.status).toBe("paid");
    expect(row.claim_token_hash).toBe(
      createHash("sha256").update(claim.claimToken!).digest("hex"),
    );
    expect(row.claim_token_sealed).not.toBeNull();
    expect(row.claim_token_sealed).not.toContain(claim.claimToken!);
    expect(row.claim_redeemed_at).toBeNull();
    expect(
      Math.abs(
        new Date(row.claim_expires_at!).getTime() -
          (new Date(row.paid_at!).getTime() + 24 * HOUR),
      ),
    ).toBeLessThanOrEqual(1000);

    // Reading again returns the same token (it is not re-issued).
    const again = await claimFor(guest, part.id);
    expect(again.body.data.claimToken).toBe(claim.claimToken);
  });

  it("SPLIT-CLAIM-REPLAY replaying the paid event does not change the issued token", async () => {
    const part = orderParts[1]!;
    const before = (await claimFor(guest, part.id)).body.data as Claim;
    const { rows } = await owner.query<{ id: string }>(
      `SELECT payment_intent_id AS id FROM bill_splits WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, part.id],
    );
    await deliver(await paidEvent(rows[0]!.id));
    const after = (await claimFor(guest, part.id)).body.data as Claim;
    expect(after.claimToken).toBe(before.claimToken);
    expect(after.claimableUntil).toBe(before.claimableUntil);
  });

  it("SPLIT-CLAIM-REDEEMED a redeemed part reads claimed and shows no token", async () => {
    const part = orderParts[2]!;
    const claim = (await claimFor(guest, part.id)).body.data as Claim;
    expect(claim.status).toBe("available");

    await markRedeemed(part.id);

    expect((await claimRow(part.id)).claim_redeemed_at).not.toBeNull();
    const after = await claimFor(guest, part.id);
    expect(after.status).toBe(200);
    expect(after.body.data.status).toBe("claimed");
    expect(after.body.data.claimToken).toBeNull();
  });

  it("SPLIT-CLAIM-EXPIRED after 24 hours the guest session read is closed", async () => {
    const part = orderParts[3]!;
    const claim = (await claimFor(guest, part.id)).body.data as Claim;
    expect(claim.status).toBe("available");
    const late = new Date(Date.now() + 24 * HOUR + 60_000);

    // The claim read is session-scoped: the guest credential expires with
    // the session at +24h, so the late read answers ORD-04 (the token on the
    // receipt is what redeems, legend-90na8).
    await expect(readClaim(guest, part.id, late)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
      message: expect.stringContaining("ORD-04"),
    });
    const row = await claimRow(part.id);
    expect(row.claim_redeemed_at).toBeNull();
    expect(new Date(row.claim_expires_at!).getTime()).toBe(
      new Date(row.paid_at!).getTime() + 24 * HOUR,
    );
  });

  it("SPLIT-CLAIM-SESSION a guest of another table session cannot read the part's claim (404)", async () => {
    const stranger = await seatAtNewTable();
    const response = await claimFor(stranger, orderParts[1]!.id);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.data?.claimToken).toBeUndefined();
  });

  // Codex 380 P1#2: the part ids are public to the whole table (`/bill`), so
  // the claim read needs the payment intent of that very part as proof.
  it("SPLIT-CLAIM-PROOF a guest cannot read another part's token with their own payment id (404)", async () => {
    const mine = orderParts[1]!;
    const theirs = orderParts[3]!;
    const response = await as(guest).claim(theirs.id, await intentOf(mine.id));
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.error?.message).toBe(
      "Bagian tagihan tidak ditemukan.",
    );
    expect(JSON.stringify(response.body)).not.toContain("sc_");

    const own = await as(guest).claim(theirs.id, await intentOf(theirs.id));
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data.claimToken).toMatch(/^sc_/);
  });

  it("SPLIT-CLAIM-PROOF an unknown part answers the same 404 message", async () => {
    const response = await as(guest).claim(
      randomUUID(),
      await intentOf(orderParts[1]!.id),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.error?.message).toBe(
      "Bagian tagihan tidak ditemukan.",
    );
  });

  it("SPLIT-CLAIM-PROOF a random payment id answers the same 404", async () => {
    const response = await as(guest).claim(orderParts[1]!.id, randomUUID());
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body.error?.message).toBe(
      "Bagian tagihan tidak ditemukan.",
    );
  });

  it("SPLIT-CLAIM-PROOF a read without the payment id is a validation error (422)", async () => {
    const response = await as(guest).claim(orderParts[1]!.id);
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(JSON.stringify(response.body)).not.toContain("sc_");
  });
});

// legend-ia54l: the claim token alone opens the claim code for 24 hours, also
// after the table session is closed.
// GET /api/table-sessions/split-claims/current, Authorization: Bearer <claimToken>.
//
// Assumptions:
// - "Close the table" = the same owner UPDATE other split tests use
//   (table_sessions voided + closed_at); "void the order" = owner UPDATE
//   orders.status = 'voided'.
// - The old session-scoped route refuses a closed session with a 4xx and no
//   token in the body (exact code not pinned by the spec).
// - NOT_FOUND over HTTP is status 404 and the body carries no token.
// - Each case uses its own part, so redeems/expiries do not leak between cases.
describe("claim by token after table close (legend-ia54l)", () => {
  const CURRENT = "/api/table-sessions/split-claims/current";
  let world: Guest;
  let parts: SplitDto[];
  let claims: Claim[]; // read with the session open, per paid part (index 0 = part 1)
  let voidWorld: Guest;
  let voidPart: SplitDto;
  let voidClaim: Claim;
  let otherTenant: IsolatedTenant;

  const byToken = (token: string, host = tenant.hostname) =>
    agent(app)
      .get(CURRENT)
      .set("Host", host)
      .set("Authorization", `Bearer ${token}`);

  async function splitWorld(count: number, paid: number) {
    const g = await seatAtNewTable();
    const added = await as(g).add(ids.kopi, 0);
    expect(added.status).toBe(201);
    const placed = await as(g).checkout(added.body.data.cart.version);
    expect(placed.status).toBe(201);
    const created = await as(g).split({
      method: "equal",
      parts: count,
      idempotencyKey: randomUUID(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const sorted: SplitDto[] = [...created.body.data.splits].sort(
      (a: SplitDto, b: SplitDto) => a.shareIndex - b.shareIndex,
    );
    for (const part of sorted.slice(0, paid)) await payPart(g, part);
    return { guest: g, parts: sorted };
  }

  async function closeTable(sessionId: string) {
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE table_sessions SET status = 'voided', closed_at = now(), closed_reason = 'voided'
          WHERE tenant_id = $1 AND id = $2`,
        [tenant.tenantId, sessionId],
      ),
    );
  }

  beforeAll(async () => {
    // 5 parts, 4 paid (order stays awaiting_payment); parts 0-3 are paid.
    const w = await splitWorld(5, 4);
    world = w.guest;
    parts = w.parts;
    claims = [];
    for (const part of parts.slice(0, 4)) {
      const claim = await readClaim(world, part.id);
      expect(claim.status).toBe("available");
      claims.push(claim);
    }
    const v = await splitWorld(3, 2);
    voidWorld = v.guest;
    voidPart = v.parts[0]!;
    voidClaim = await readClaim(voidWorld, voidPart.id);
    expect(voidClaim.status).toBe("available");

    otherTenant = await createIsolatedTenant(`bsx-${randomUUID().slice(0, 6)}`);
    createdTenantIds.push(otherTenant.tenantId);
  });

  it("CLAIM-AFTER-CLOSE the token opens the claim within 24h after the table is closed, the session route refuses", async () => {
    const part = parts[0]!;
    const before = claims[0]!;
    await closeTable(world.sessionId);

    const session = await claimFor(world, part.id);
    expect(session.status).toBeGreaterThanOrEqual(400);
    expect(session.body.data?.claimToken).toBeUndefined();

    const response = await byToken(before.claimToken!);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.data).toEqual({
      billSplitId: part.id,
      status: "available",
      claimToken: before.claimToken,
      claimableUntil: before.claimableUntil,
    });
  });

  it("CLAIM-EXPIRED-SERVICE more than 24h after payment the token read is NOT_FOUND", async () => {
    const part = parts[1]!;
    const claim = claims[1]!;
    const row = await claimRow(part.id);
    const paidAt = new Date(row.paid_at!).getTime();
    const context = contextOf(tenant.tenantId);

    const inside = await getSplitClaimByToken(
      context,
      claim.claimToken!,
      new Date(paidAt + 24 * HOUR - 1000),
    );
    expect(inside.claimToken).toBe(claim.claimToken);

    await expect(
      getSplitClaimByToken(
        context,
        claim.claimToken!,
        new Date(paidAt + 24 * HOUR + 1000),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("CLAIM-EXPIRED-HTTP a token whose window passed answers 404 with no token", async () => {
    const part = parts[2]!;
    const claim = claims[2]!;
    expect((await byToken(claim.claimToken!)).status).toBe(200);
    await owner.query(
      `UPDATE bill_splits SET claim_expires_at = now() - interval '1 second'
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenant.tenantId, part.id],
    );
    const response = await byToken(claim.claimToken!);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(claim.claimToken!);
  });

  it("CLAIM-REDEEMED after the token is redeemed the read is NOT_FOUND", async () => {
    const part = parts[3]!;
    const claim = claims[3]!;
    expect((await byToken(claim.claimToken!)).status).toBe(200);
    await markRedeemed(part.id);

    await expect(
      getSplitClaimByToken(contextOf(tenant.tenantId), claim.claimToken!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const response = await byToken(claim.claimToken!);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(claim.claimToken!);
  });

  it("CLAIM-VOIDED when the order is voided the read is NOT_FOUND", async () => {
    expect((await byToken(voidClaim.claimToken!)).status).toBe(200);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `UPDATE orders SET status = 'voided'
          WHERE tenant_id = $1 AND id = (SELECT order_id FROM bill_splits WHERE tenant_id = $1 AND id = $2::uuid)`,
        [tenant.tenantId, voidPart.id],
      ),
    );

    await expect(
      getSplitClaimByToken(contextOf(tenant.tenantId), voidClaim.claimToken!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const response = await byToken(voidClaim.claimToken!);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
  });

  // legend-udu47: a practice (latihan) or refunded part shows no code: the
  // POST claim answers 409 for it, so showing the code only led to a dead end.
  async function markTraining(orderId: string) {
    await owner.query(
      "UPDATE orders SET channel = 'pos' WHERE tenant_id = $1 AND id = $2",
      [tenant.tenantId, orderId],
    );
    await owner.query(
      `INSERT INTO pos_orders (order_id, tenant_id, outlet_id, channel, is_training)
       SELECT id, tenant_id, outlet_id, channel, true
         FROM orders WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, orderId],
    );
  }

  async function refundPart(splitId: string) {
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        `INSERT INTO payment_refunds
           (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
         SELECT $1, $2, i.id, 1000, 'uji', 'pending', $3
           FROM payment_intents i WHERE i.tenant_id = $1 AND i.bill_split_id = $4::uuid`,
        [tenant.tenantId, tenant.outletId, staff.userId, splitId],
      ),
    );
  }

  async function orderIdOf(splitId: string): Promise<string> {
    const { rows } = await owner.query<{ order_id: string }>(
      "SELECT order_id FROM bill_splits WHERE tenant_id = $1 AND id = $2::uuid",
      [tenant.tenantId, splitId],
    );
    return rows[0]!.order_id;
  }

  it("CLAIM-TRAINING a part of a practice order shows no code, by session and by token", async () => {
    const w = await splitWorld(2, 2);
    const part = w.parts[0]!;
    const claim = await readClaim(w.guest, part.id);
    expect(claim.status).toBe("available");
    await markTraining(await orderIdOf(part.id));

    const bySession = await readClaim(w.guest, part.id);
    expect(bySession).toEqual({
      billSplitId: part.id,
      status: "unavailable",
      claimToken: null,
      claimableUntil: null,
    });
    await expect(
      getSplitClaimByToken(contextOf(tenant.tenantId), claim.claimToken!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const response = await byToken(claim.claimToken!);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(claim.claimToken!);
  });

  it("CLAIM-MEMBER-ATTACHED a part of an order with a member attached shows no code, by session and by token", async () => {
    const w = await splitWorld(2, 2);
    const part = w.parts[0]!;
    const claim = await readClaim(w.guest, part.id);
    expect(claim.status).toBe("available");
    const attached = await seedProfile(tenant.tenantId);
    await owner.query(
      `UPDATE orders SET customer_profile_id = $3, customer_attached_via = 'pwa_session',
              customer_attached_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenant.tenantId, await orderIdOf(part.id), attached.id],
    );

    expect((await readClaim(w.guest, part.id)).status).toBe("unavailable");
    await expect(
      getSplitClaimByToken(contextOf(tenant.tenantId), claim.claimToken!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("CLAIM-REFUNDED a refunded part shows no code, by session and by token", async () => {
    const w = await splitWorld(2, 2);
    const part = w.parts[0]!;
    const claim = await readClaim(w.guest, part.id);
    expect(claim.status).toBe("available");
    await refundPart(part.id);

    const bySession = await readClaim(w.guest, part.id);
    expect(bySession).toEqual({
      billSplitId: part.id,
      status: "unavailable",
      claimToken: null,
      claimableUntil: null,
    });
    await expect(
      getSplitClaimByToken(contextOf(tenant.tenantId), claim.claimToken!),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const response = await byToken(claim.claimToken!);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(claim.claimToken!);
  });

  it("CLAIM-ISOLATION a token returns only its own part; unknown token and another tenant's host give 404", async () => {
    const a = claims[0]!;
    const b = claims[1]!;
    expect(a.claimToken).not.toBe(b.claimToken);

    const responseA = await byToken(a.claimToken!);
    expect(responseA.status, JSON.stringify(responseA.body)).toBe(200);
    expect(responseA.body.data.billSplitId).toBe(parts[0]!.id);
    expect(responseA.body.data.billSplitId).not.toBe(parts[1]!.id);
    expect(Object.keys(responseA.body.data).sort()).toEqual([
      "billSplitId",
      "claimToken",
      "claimableUntil",
      "status",
    ]);

    const responseB = await byToken(b.claimToken!);
    expect(responseB.status).toBe(200);
    expect(responseB.body.data.billSplitId).toBe(parts[1]!.id);
    expect(responseB.body.data.claimToken).toBe(b.claimToken);

    const random = await byToken(`sc_${randomBytes(32).toString("base64url")}`);
    expect(random.status, JSON.stringify(random.body)).toBe(404);

    const foreign = await byToken(a.claimToken!, otherTenant.hostname);
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(a.claimToken!);
  });
});
