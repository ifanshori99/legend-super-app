// legend-ms3 split bill (D5 of docs/briefs/sub-split-bill-design.md): the guest
// splits the session's single awaiting_payment order into equal / by-item /
// by-person parts that sum exactly to the order total (tax + service +
// rounding included).
//
// Real Express app and PostgreSQL with RLS in one isolated tenant (setup as
// qr-order-double-pay-payer.test.ts); one fresh table session per case.
//
// Assumptions (the brief fixes the contract, not every number):
// - The cart totals are whatever pricing yields (kopi 25.000 + roti 18.000 with
//   5% service + 10% PBJT, about 51.665). The tests compute the expected
//   rounding from the order total instead of hard-coding it, and assert the
//   total is not divisible by 3 so the remainder rule is really exercised.
// - Remainder rule (D3, core largest remainder, equal method): the leftover
//   rupiah go one each to the LOWEST share indexes first.
// - by_item weights are line totals, so a by-item part is only asserted to be
//   within 1 rupiah of its proportional share and to sum exactly to the total.
// - A zero part is provoked with a 1-rupiah order split into 50 equal parts;
//   the checkout of a 1-rupiah item is assumed valid.
// - Error codes asserted only where the brief names them: NOTHING_TO_SPLIT,
//   VALIDATION_ERROR (deposit), SPLIT_LOCKED. Other 422s assert status only.
// - An open-bill session has no awaiting_payment order, so it takes the same
//   NOTHING_TO_SPLIT path as an empty session; only the empty session is run.
// - POST /splits replay with the same idempotency key answers 2xx with the
//   same split ids (no new set).

import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import {
  outletIdSchema,
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
  seededHostname,
  seededTenantId,
  staffOfIsolatedTenant,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

let app: Express;
let tenant: IsolatedTenant;
let staff: Staff;
let headers: { Host: string };
const createdTenantIds: string[] = [];

const ids = {
  category: randomUUID(),
  kopi: randomUUID(),
  roti: randomUUID(),
  sedotan: randomUUID(),
  priceList: randomUUID(),
  taxRule: randomUUID(),
  taxSettings: randomUUID(),
};
const ALL_DAY = [
  { daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" },
];

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
      qrPayload: "00020101021226FAKEQRSPLIT",
      issuer: null,
    };
    return {
      providerRef: `QSP-${randomBytes(6).toString("hex")}-${this.created}`,
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

function contextOf(
  tenantId: string,
  scope: { kind: "tenant" } | { kind: "outlets"; outletIds: string[] } = {
    kind: "tenant",
  },
): ScopedTenantContext {
  return establishScopedTenantContext(
    establishTenantContext({
      tenantId: tenantIdSchema.parse(tenantId),
      brandId: null,
      source: "session",
    }),
    scope.kind === "tenant"
      ? { kind: "tenant" }
      : {
          kind: "outlets",
          outletIds: scope.outletIds.map((id) => outletIdSchema.parse(id)),
        },
  );
}

// ---- QR ordering --------------------------------------------------------------

type Guest = {
  token: string;
  sessionId: string;
  qrToken: string;
  participantIds: string[];
};

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
    qrToken: qr.token,
    participantIds: response.body.data.session.participants.map(
      (p: { id: string }) => p.id,
    ),
  };
}

/** A second device scans the same table QR and becomes a participant. */
async function joinSecondGuest(guest: Guest): Promise<string> {
  const joined = await scan(app, {
    token: guest.qrToken,
    hostname: tenant.hostname,
  });
  expect(joined.status).toBe(201);
  const all: string[] = joined.body.data.session.participants.map(
    (p: { id: string }) => p.id,
  );
  expect(all).toHaveLength(2);
  const added = all.find((id) => !guest.participantIds.includes(id))!;
  guest.participantIds.push(added);
  return added;
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
    bill: () => auth(client.get(`${base}/bill`)),
    split: (body: Record<string, unknown>) =>
      auth(client.post(`${base}/splits`)).send(body),
    paySplit: (billSplitId: string) =>
      auth(client.post(`${base}/payments`)).send({
        target: { kind: "split", billSplitId },
        method: "qris",
        idempotencyKey: randomUUID(),
      }),
  };
}

type PlacedItem = { id: string; name: string; lineTotalIdr: number };

/** Orders one of each menu item and checks out: one awaiting_payment order. */
async function placeOrder(guest: Guest, menuItemIds: string[]) {
  let version = 0;
  for (const menuItemId of menuItemIds) {
    const added = await as(guest).add(menuItemId, version);
    expect(added.status).toBe(201);
    version = added.body.data.cart.version;
  }
  const placed = await as(guest).checkout(version);
  expect(placed.status).toBe(201);
  expect(placed.body.data.order.status).toBe("awaiting_payment");
  return {
    orderId: placed.body.data.order.id as string,
    totalIdr: placed.body.data.order.totalIdr as number,
    items: placed.body.data.order.items as PlacedItem[],
  };
}

const equalBody = (parts: number, key = randomUUID()) => ({
  method: "equal",
  parts,
  idempotencyKey: key,
});

type SplitDto = {
  id: string;
  shareIndex: number;
  amountIdr: number;
  status: string;
  method: string;
  itemIds: string[];
  participantId: string | null;
};

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Largest-remainder shares of an equal split: lowest indexes get the extra rupiah. */
function expectedEqual(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const remainder = total - base * parts;
  return Array.from(
    { length: parts },
    (_, i) => base + (i < remainder ? 1 : 0),
  );
}

/** The 4xx/2xx check that keeps the failing assertion readable. */
function ok(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
}

async function dbSplits(orderId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    split_set_id: string;
    share_index: number;
    amount_idr: string;
    voided_at: Date | null;
  }>(
    `SELECT id, status, split_set_id, share_index, amount_idr::text AS amount_idr, voided_at
       FROM bill_splits WHERE tenant_id = $1 AND order_id = $2::uuid
      ORDER BY created_at, share_index`,
    [tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows;
}

/** A verified webhook settlement, then the paid event reaches the QR consumer. */
async function settleAndDeliver(intentId: string, amountIdr: number) {
  const context = contextOf(tenant.tenantId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid' AND event->'payload'->>'intentId' = $2
     ORDER BY created_at, id`,
    [tenant.tenantId, intentId],
  );
  expect(rows).toHaveLength(1);
  const event: EventEnvelope = eventEnvelopeSchema.parse(rows[0]!.event);
  await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, new Date()),
  );
}

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  app = createApp();
  setPaymentGateway(gateway);
  setTableSessionSettlementLookup(qrOrderSettlementLookup);
  setAuditWriter(coreAuditWriter);

  tenant = await createIsolatedTenant(`bsp-${randomUUID().slice(0, 6)}`);
  createdTenantIds.push(tenant.tenantId);
  staff = await staffOfIsolatedTenant(app, tenant);
  headers = { Host: tenant.hostname };
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, tenant_id, brand_id, name, sort_order)
       VALUES ($1, $2, $3, 'Split Bill Uji', 0)`,
      [ids.category, tenant.tenantId, tenant.brandId],
    );
    for (const [id, name] of [
      [ids.kopi, "Kopi Susu"],
      [ids.roti, "Roti Bakar"],
      [ids.sedotan, "Sedotan"],
    ] as const) {
      await client.query(
        `INSERT INTO menu_items (id, tenant_id, brand_id, category_id, name, is_active, media_id)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [id, tenant.tenantId, tenant.brandId, ids.category, name, randomUUID()],
      );
    }
  });
  await asOwnerTenant(tenant.tenantId, async (client) => {
    await client.query(
      `INSERT INTO price_lists (id, tenant_id, outlet_id, channel, effective_from)
       VALUES ($1, $2, $3, 'dine_in', '2026-01-01')`,
      [ids.priceList, tenant.tenantId, tenant.outletId],
    );
    for (const [id, price] of [
      [ids.kopi, 25000],
      [ids.roti, 18000],
      [ids.sedotan, 1],
    ] as const)
      await client.query(
        `INSERT INTO price_list_items (id, tenant_id, price_list_id, item_id, price_idr)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), tenant.tenantId, ids.priceList, id, price],
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
       VALUES ($1, $2, NULL, 'PBJT-SPL', 'PBJT 10%', 'pbjt', 1000, NULL, '[]',
               '{"itemClasses":["food_beverage"],"categoryIds":[],"itemIds":[]}',
               false, true, true, 1, '2026-01-01', 'published', now(), $3)`,
      [ids.taxRule, tenant.tenantId, staff.userId],
    );
  });
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

describe("split bill: parts sum exactly to the order total (legend-ms3)", () => {
  it("SPLIT-EQUAL equal split of a total not divisible by the part count: exact sum, remainder to the lowest indexes", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest, [ids.kopi, ids.roti]);
    // Brief example is 3 of 100 001; the cart total is whatever pricing yields,
    // so take the first part count (3, 4, 5, 7) that does not divide it.
    const count = [3, 4, 5, 7].find((n) => totalIdr % n !== 0)!;
    expect(count, "fixture: total divides by 3, 4, 5 and 7").toBeDefined();

    const response = await as(guest).split(equalBody(count));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const splits: SplitDto[] = [...response.body.data.splits].sort(
      (a, b) => a.shareIndex - b.shareIndex,
    );
    expect(splits).toHaveLength(count);
    expect(splits.map((s) => s.shareIndex)).toEqual(
      Array.from({ length: count }, (_, i) => i),
    );
    expect(splits.every((s) => s.status === "pending")).toBe(true);
    expect(splits.every((s) => s.method === "equal")).toBe(true);
    expect(sum(splits.map((s) => s.amountIdr))).toBe(totalIdr);
    expect(splits.map((s) => s.amountIdr)).toEqual(
      expectedEqual(totalIdr, count),
    );

    // The same parts show on the bill, tied to the order.
    const bill = await as(guest).bill();
    expect(bill.status).toBe(200);
    const onBill: SplitDto[] = bill.body.data.splits;
    expect(onBill.map((s) => s.id).sort()).toEqual(
      splits.map((s) => s.id).sort(),
    );
    expect(sum(onBill.map((s) => s.amountIdr))).toBe(
      bill.body.data.totals.totalIdr,
    );

    const rows = await dbSplits(orderId);
    expect(rows).toHaveLength(count);
    expect(sum(rows.map((r) => Number(r.amount_idr)))).toBe(totalIdr);
    expect(new Set(rows.map((r) => r.split_set_id)).size).toBe(1);
  });

  it("SPLIT-EQUAL one part equals the whole order total", async () => {
    const guest = await seatAtNewTable();
    const { totalIdr } = await placeOrder(guest, [ids.kopi]);
    const response = await as(guest).split(equalBody(1));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.data.splits).toHaveLength(1);
    expect(response.body.data.splits[0].amountIdr).toBe(totalIdr);
  });

  it("SPLIT-BY-ITEM parts follow the lines and sum exactly to the total", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr, items } = await placeOrder(guest, [
      ids.kopi,
      ids.roti,
    ]);
    const kopi = items.find((i) => i.name === "Kopi Susu")!;
    const roti = items.find((i) => i.name === "Roti Bakar")!;

    const response = await as(guest).split({
      method: "by_item",
      assignments: [
        { orderItemIds: [kopi.id], label: "Kopi" },
        { orderItemIds: [roti.id], label: "Roti" },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const splits: SplitDto[] = [...response.body.data.splits].sort(
      (a, b) => a.shareIndex - b.shareIndex,
    );
    expect(splits).toHaveLength(2);
    expect(splits.map((s) => s.method)).toEqual(["by_item", "by_item"]);
    expect(splits[0]!.itemIds).toEqual([kopi.id]);
    expect(splits[1]!.itemIds).toEqual([roti.id]);
    expect(sum(splits.map((s) => s.amountIdr))).toBe(totalIdr);
    // Weighted by line total, tax and service shares included (+-1 rupiah rounding).
    const subtotal = kopi.lineTotalIdr + roti.lineTotalIdr;
    expect(
      Math.abs(
        splits[0]!.amountIdr - (totalIdr * kopi.lineTotalIdr) / subtotal,
      ),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        splits[1]!.amountIdr - (totalIdr * roti.lineTotalIdr) / subtotal,
      ),
    ).toBeLessThanOrEqual(1);
    expect((await dbSplits(orderId)).length).toBe(2);
  });

  it("SPLIT-BY-PERSON one part per participant, summing exactly to the total", async () => {
    const guest = await seatAtNewTable();
    await joinSecondGuest(guest);
    const { totalIdr } = await placeOrder(guest, [ids.kopi, ids.roti]);

    const response = await as(guest).split({
      method: "by_person",
      participantIds: guest.participantIds,
      idempotencyKey: randomUUID(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const splits: SplitDto[] = response.body.data.splits;
    expect(splits).toHaveLength(2);
    expect(splits.map((s) => s.participantId).sort()).toEqual(
      [...guest.participantIds].sort(),
    );
    expect(splits.every((s) => s.method === "by_person")).toBe(true);
    expect(sum(splits.map((s) => s.amountIdr))).toBe(totalIdr);
  });
});

describe("split bill: refusals (legend-ms3)", () => {
  it("SPLIT-BY-ITEM-MISSING an item left out of the assignments is refused with 422", async () => {
    const guest = await seatAtNewTable();
    const { orderId, items } = await placeOrder(guest, [ids.kopi, ids.roti]);
    const response = await as(guest).split({
      method: "by_item",
      assignments: [{ orderItemIds: [items[0]!.id] }],
      idempotencyKey: randomUUID(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await dbSplits(orderId)).toHaveLength(0);
  });

  it("SPLIT-BY-ITEM-DUPLICATE an item assigned to two parts is refused with 422", async () => {
    const guest = await seatAtNewTable();
    const { orderId, items } = await placeOrder(guest, [ids.kopi, ids.roti]);
    const response = await as(guest).split({
      method: "by_item",
      assignments: [
        { orderItemIds: items.map((i) => i.id) },
        { orderItemIds: [items[0]!.id] },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await dbSplits(orderId)).toHaveLength(0);
  });

  it("SPLIT-ZERO-PART a part that rounds to zero is refused with 422 and nothing is stored", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest, [ids.sedotan]);
    expect(totalIdr).toBeLessThan(50);
    const response = await as(guest).split(equalBody(50));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(await dbSplits(orderId)).toHaveLength(0);
  });

  it("SPLIT-DEPOSIT an order with a deposit applied cannot be split (422 VALIDATION_ERROR)", async () => {
    const guest = await seatAtNewTable();
    const { orderId } = await placeOrder(guest, [ids.kopi]);
    await asOwnerTenant(tenant.tenantId, (client) =>
      client.query(
        "UPDATE orders SET deposit_applied_idr = 1000 WHERE tenant_id = $1 AND id = $2::uuid",
        [tenant.tenantId, ulidToUuid(orderId)],
      ),
    );
    const response = await as(guest).split(equalBody(2));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(await dbSplits(orderId)).toHaveLength(0);
  });

  it("SPLIT-NOTHING a session without an awaiting order has nothing to split (422 NOTHING_TO_SPLIT)", async () => {
    const guest = await seatAtNewTable();
    const response = await as(guest).split(equalBody(2));
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe("NOTHING_TO_SPLIT");
  });
});

describe("split bill: replay, re-split and lock (legend-ms3)", () => {
  it("SPLIT-IDEMPOTENT the same request twice returns the same parts and stores one set", async () => {
    const guest = await seatAtNewTable();
    const { orderId } = await placeOrder(guest, [ids.kopi, ids.roti]);
    const body = equalBody(3, `split-${randomUUID()}`);
    const first = await as(guest).split(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const replay = await as(guest).split(body);
    ok(replay);
    const idsOf = (r: { body: { data: { splits: SplitDto[] } } }) =>
      r.body.data.splits.map((s) => s.id).sort();
    expect(idsOf(replay)).toEqual(idsOf(first));
    const rows = await dbSplits(orderId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("SPLIT-RESPLIT a new split voids the old unpaid set and replaces it", async () => {
    const guest = await seatAtNewTable();
    const { orderId, totalIdr } = await placeOrder(guest, [ids.kopi, ids.roti]);
    const first = await as(guest).split(equalBody(2));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await as(guest).split(equalBody(3));
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const live: SplitDto[] = second.body.data.splits;
    expect(live).toHaveLength(3);
    expect(sum(live.map((s) => s.amountIdr))).toBe(totalIdr);
    const oldIds = first.body.data.splits.map((s: SplitDto) => s.id);
    expect(live.some((s) => oldIds.includes(s.id))).toBe(false);

    const rows = await dbSplits(orderId);
    expect(rows).toHaveLength(5);
    const voided = rows.filter((r) => r.status === "voided");
    expect(voided.map((r) => r.id).sort()).toEqual([...oldIds].sort());
    expect(voided.every((r) => r.voided_at !== null)).toBe(true);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(3);

    // Only the live set shows on the bill.
    const bill = await as(guest).bill();
    expect(bill.body.data.splits).toHaveLength(3);
  });

  it("SPLIT-LOCKED-PAID once a part is paid the bill cannot be re-split (409 SPLIT_LOCKED)", async () => {
    const guest = await seatAtNewTable();
    const { orderId } = await placeOrder(guest, [ids.kopi, ids.roti]);
    const created = await as(guest).split(equalBody(2));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const part: SplitDto = created.body.data.splits[0];
    const pay = await as(guest).paySplit(part.id);
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    await settleAndDeliver(pay.body.data.id, part.amountIdr);

    const again = await as(guest).split(equalBody(3));
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("SPLIT_LOCKED");
    const rows = await dbSplits(orderId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === part.id)!.status).toBe("paid");
    expect(rows.filter((r) => r.status === "voided")).toHaveLength(0);
  });

  it("SPLIT-LOCKED-OPEN-CODE while a payment code of a part is open the bill cannot be re-split (409 SPLIT_LOCKED)", async () => {
    const guest = await seatAtNewTable();
    const { orderId } = await placeOrder(guest, [ids.kopi, ids.roti]);
    const created = await as(guest).split(equalBody(2));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const pay = await as(guest).paySplit(created.body.data.splits[0].id);
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    expect(pay.body.data.status).toBe("pending");

    const again = await as(guest).split(equalBody(3));
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("SPLIT_LOCKED");
    expect(
      (await dbSplits(orderId)).filter((r) => r.status === "voided"),
    ).toHaveLength(0);
  });

  // Fix round 2, R1. Assumption: a superseded code (status expired, provider_ref
  // set, expires_at still in the future inside the late-payment grace) may still
  // be accepted by the gateway, so it locks the split like an open code does.
  // The state is produced via owner SQL (as the brief says).
  it("SPLIT-LOCKED-SUPERSEDED-CODE a superseded code the gateway may still accept locks the bill (409 SPLIT_LOCKED)", async () => {
    const guest = await seatAtNewTable();
    const { orderId } = await placeOrder(guest, [ids.kopi, ids.roti]);
    const created = await as(guest).split(equalBody(2));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const part: SplitDto = created.body.data.splits[0];
    const pay = await as(guest).paySplit(part.id);
    expect(pay.status, JSON.stringify(pay.body)).toBe(201);
    const intentId: string = pay.body.data.id;
    // The only open code becomes `expired` (provider_ref kept, still in the future).
    const flipped = await owner.query(
      `UPDATE payment_intents
          SET status = 'expired', expires_at = now() + interval '1 hour'
        WHERE tenant_id = $1 AND id = $2 AND provider_ref IS NOT NULL`,
      [tenant.tenantId, intentId],
    );
    expect(flipped.rowCount).toBe(1);

    const again = await as(guest).split(equalBody(3));
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.error.code).toBe("SPLIT_LOCKED");
    const rows = await dbSplits(orderId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "voided")).toHaveLength(0);
  });
});

describe("split bill: tenant and outlet isolation (legend-ms3)", () => {
  it("SPLIT-RLS parts are invisible to another tenant and to another outlet's scope", async () => {
    const guest = await seatAtNewTable();
    const { orderId } = await placeOrder(guest, [ids.kopi, ids.roti]);
    expect((await as(guest).split(equalBody(3))).status).toBe(201);
    const orderUuid = ulidToUuid(orderId);

    const countAs = (context: ScopedTenantContext) =>
      withTenant(db, context, async (tx) => {
        const result = await tx.execute(
          sql`SELECT count(*)::int AS n FROM bill_splits WHERE order_id = ${orderUuid}::uuid`,
        );
        return Number((result.rows[0] as { n: number }).n);
      });

    // Positive controls: the owning tenant, and the owning outlet's scope.
    expect(await countAs(contextOf(tenant.tenantId))).toBe(3);
    expect(
      await countAs(
        contextOf(tenant.tenantId, {
          kind: "outlets",
          outletIds: [tenant.outletId],
        }),
      ),
    ).toBe(3);
    // Another tenant sees nothing.
    expect(await countAs(contextOf(seededTenantId))).toBe(0);
    // Same tenant, a scope that does not reach this outlet, sees nothing.
    expect(
      await countAs(
        contextOf(tenant.tenantId, {
          kind: "outlets",
          outletIds: [randomUUID()],
        }),
      ),
    ).toBe(0);
  });

  it("SPLIT-TENANT-GUEST a guest credential of one tenant cannot split in another tenant's session", async () => {
    const guest = await seatAtNewTable();
    await placeOrder(guest, [ids.kopi]);
    const foreign = await agent(app)
      .post(`/api/table-sessions/${guest.sessionId}/splits`)
      .set("Host", seededHostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader)
      .send(equalBody(2));
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.status).toBeLessThan(500);
    expect(foreign.status).not.toBe(422);
  });
});
