// PB1 (PBJT) on breakfast ordered from the access ticket (bead oa0qk; founder
// Q59; brief docs/briefs/sub-oa0qk-endsat.md section E; money rule "jangan sampai
// rugi"). Real Express app, Better Auth, the WS-05 payment service, the auto
// journal consumer and PostgreSQL with RLS in one isolated tenant (plus a second
// one for the tax-inclusive outlet). Written from the brief and the shared
// contract, not from the implementation.
//
// Ids: BRK-TAX-01 an exclusive order adds PB1 and the guest pays exactly that
// total, BRK-TAX-02 firing records the tax snapshot and the sale journal carries
// the PB1, BRK-TAX-03 a tax-inclusive outlet is refused before any money moves,
// BRK-TAX-04 refunds never exceed what was paid, PB1 included.
//
// Assumptions (the brief does not give exact amounts):
// - World tax config: one published PBJT 10% rule on food and beverage with
//   service in the base (createBreakfastWorld). Expected PB1 = 10% of
//   (subtotal + service charge), half-up, as the QR/POS engine does (see
//   qr-tax-snapshot.test.ts). Whether breakfast carries the zone's 5% service
//   charge is not stated, so the tests accept 0 or 3.750 and check the PB1 and
//   the total against whatever was stored.
// - Tax snapshot rows are found by source_id = the order uuid (table
//   tax_snapshots), as in qr-tax-snapshot.test.ts.
// - The sale journal is read through deliverAutoJournalEvent on the real
//   order.paid event from the outbox, after the real payment.paid receipt. Roles
//   follow posting-rules.ts: tax_payable_pbjt credit = PB1, sales_revenue credit
//   = subtotal, service_charge credit = service, debits = total.
// - The tax-inclusive rejection code is QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED (422)
//   per the brief ("sama dengan POS dan QR"), with no payment link, intent or
//   order row created.

import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulidToUuid, uuidToUlid } from "@starter/shared/core";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { createApp } from "../app.ts";
import { deliverOrderRecoveryRefundEvent } from "../services/order-recovery-refund.ts";
import { agent, originHeader, signUp } from "./helpers.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import {
  MINUTE,
  asOwnerTenant,
  breakfastBody,
  createBreakfastWorld,
  dropBreakfastWorld,
  endPools,
  installGateway,
  kitchenTicketCount,
  linkedOf,
  memberApi,
  newMember,
  openIntent,
  owner,
  payLink,
  placeOrder,
  placePaidOrder,
  refundDetailsOf,
  refundedSum,
  removeGateway,
  runSweep,
  seedTicket,
  setFireAt,
  staffFire,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";

let app: Express;
let world: BreakfastWorld;
let entityId: string;
const accounts = {} as Record<string, string>;

const SUBTOTAL = 2 * 30_000 + 15_000;
const CHART: [string, string, string, string, string][] = [
  ["gateway_clearing", "1201", "Kliring Gateway", "asset", "current_asset"],
  ["customer_deposit", "2107", "Uang Muka", "liability", "current_liability"],
  ["tax_payable_pbjt", "2201", "Utang PBJT", "liability", "current_liability"],
  [
    "service_charge",
    "2301",
    "Service Charge",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["sales_discount", "4102", "Diskon", "revenue", "revenue"],
  ["rounding", "4103", "Pembulatan", "revenue", "revenue"],
  [
    "loyalty_liability",
    "2108",
    "Liabilitas Poin",
    "liability",
    "current_liability",
  ],
];

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  setAuditWriter(coreAuditWriter);
  app = createApp();
  installGateway();
  world = await createBreakfastWorld(app);
  // The journal needs the accounting module, a chart and open fiscal periods.
  await owner.query(
    "UPDATE tenants SET feature_flags = $2::jsonb WHERE id = $1",
    [
      world.tenant.tenantId,
      JSON.stringify({
        modules: ["pos", "qr_order", "kds", "loyalty", "accounting"],
        integrationProviders: [],
      }),
    ],
  );
  const entity = await owner.query<{ legal_entity_id: string }>(
    "SELECT legal_entity_id FROM outlets WHERE tenant_id = $1 AND id = $2",
    [world.tenant.tenantId, world.tenant.outletId],
  );
  entityId = entity.rows[0]!.legal_entity_id;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [world.tenant.tenantId, entityId, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [world.tenant.tenantId, entityId, role, accounts[role]],
    );
  }
  const now = Date.now();
  for (const shift of [-40, 0, 40]) {
    const day = new Date(now + shift * 24 * 60 * MINUTE);
    const period = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}`;
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [world.tenant.tenantId, entityId, period],
    );
  }
});

afterAll(async () => {
  setAuditWriter(null);
  removeGateway();
  await dropBreakfastWorld(world);
  if (inclusiveWorld) await dropBreakfastWorld(inclusiveWorld);
  await endPools();
});

async function newTicket(
  target: BreakfastWorld = world,
  options: { endsInMinutes?: number } = {},
) {
  const member = await newMember(target);
  const ticketId = await seedTicket(target, member, options);
  return { member, ticketId, api: memberApi(target, member) };
}

type StoredOrder = {
  subtotal: number;
  discount: number;
  service: number;
  tax: number;
  rounding: number;
  total: number;
  inclusive: boolean;
};

async function storedOrder(
  orderId: string,
  target: BreakfastWorld = world,
): Promise<StoredOrder> {
  return asOwnerTenant(target.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{
      subtotal_idr: string;
      discount_idr: string;
      service_charge_idr: string;
      tax_idr: string;
      rounding_idr: string;
      total_idr: string;
      prices_include_tax: boolean;
    }>(
      `SELECT subtotal_idr::text, discount_idr::text, service_charge_idr::text, tax_idr::text,
              rounding_idr::text, total_idr::text, prices_include_tax
         FROM orders WHERE tenant_id = $1 AND id = $2::uuid`,
      [target.tenant.tenantId, ulidToUuid(orderId)],
    );
    expect(rows, "orders row of the breakfast").toHaveLength(1);
    const row = rows[0]!;
    return {
      subtotal: Number(row.subtotal_idr),
      discount: Number(row.discount_idr),
      service: Number(row.service_charge_idr),
      tax: Number(row.tax_idr),
      rounding: Number(row.rounding_idr),
      total: Number(row.total_idr),
      inclusive: row.prices_include_tax,
    };
  });
}

/** PB1 10% of (subtotal + service), half-up, and the total that follows. */
function expectExclusivePb1(order: StoredOrder) {
  expect(order.inclusive).toBe(false);
  expect(order.subtotal).toBe(SUBTOTAL);
  expect([0, 3_750]).toContain(order.service);
  expect(order.tax).toBeGreaterThan(0);
  expect(order.tax).toBe(Math.round((order.subtotal + order.service) * 0.1));
  expect(order.total).toBe(
    order.subtotal -
      order.discount +
      order.service +
      order.tax +
      order.rounding,
  );
}

async function snapshotRows(orderId: string) {
  return asOwnerTenant(world.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{
      tax_rule_id: string;
      tax_idr: string;
    }>(
      `SELECT tax_rule_id::text, tax_idr::text FROM tax_snapshots
        WHERE tenant_id = $1 AND source_id = $2::uuid ORDER BY tax_rule_id`,
      [world.tenant.tenantId, ulidToUuid(orderId)],
    );
    return rows.map((row) => ({
      ruleId: row.tax_rule_id,
      tax: Number(row.tax_idr),
    }));
  });
}

async function outboxEvent(
  name: string,
  key: string,
  value: string,
): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>'${key}' = $3
      ORDER BY created_at, id`,
    [world.tenant.tenantId, name, value],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

function journal(event: EventEnvelope) {
  const context = world.context;
  return withTenant(db, context, (tx) =>
    deliverAutoJournalEvent(context, event, tx, new Date()),
  );
}

async function journalLines(entryId: string) {
  const { rows } = await owner.query<{
    account_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT account_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
       FROM journal_lines WHERE tenant_id = $1 AND entry_id = $2 GROUP BY account_id`,
    [world.tenant.tenantId, entryId],
  );
  const roleOf = new Map(
    Object.entries(accounts).map(([role, id]) => [id, role]),
  );
  const byRole: Record<string, { debit: number; credit: number }> = {};
  for (const row of rows)
    byRole[roleOf.get(row.account_id) ?? row.account_id] = {
      debit: Number(row.debit),
      credit: Number(row.credit),
    };
  return byRole;
}

// ---- BRK-TAX-01 ----------------------------------------------------------------

describe("BRK-TAX-01 an exclusive breakfast adds PB1 and the guest pays that total", () => {
  it("BRK-TAX-01 the order total is price + PB1 per the outlet config, and the payment asks exactly that", async () => {
    const { member, ticketId } = await newTicket();
    const order = await placeOrder(world, member, ticketId);

    const stored = await storedOrder(order.id);
    expectExclusivePb1(stored);
    expect(order.totalIdr).toBe(stored.total);
    expect(order.totalIdr).toBeGreaterThan(SUBTOTAL);
    expect((await linkedOf(world, order.id)).total).toBe(stored.total);

    const token = await payLink(world, member, ticketId, order.id);
    const intent = await openIntent(world, token);
    expect(intent.amountIdr).toBe(stored.total);
  });

  it("BRK-TAX-01 the client cannot set tax or total: unknown fields are refused and nothing is created", async () => {
    const { ticketId, api } = await newTicket();
    for (const extra of [
      { taxIdr: 0 },
      { totalIdr: 1_000 },
      { pricesIncludeTax: true },
    ]) {
      const response = await api.create(ticketId, breakfastBody(world, extra));
      expect(response.status, JSON.stringify(response.body)).toBe(422);
    }
    const count = await asOwnerTenant(world.tenant.tenantId, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM facility_linked_orders
          WHERE tenant_id = $1 AND access_ticket_id = $2::uuid`,
        [world.tenant.tenantId, ulidToUuid(ticketId)],
      );
      return rows[0]!.n;
    });
    expect(count).toBe(0);
  });
});

// ---- BRK-TAX-02 ----------------------------------------------------------------

describe("BRK-TAX-02 firing records the tax snapshot and the sale journal carries PB1", () => {
  it("BRK-TAX-02 staff fire writes the tax snapshot once and the order.paid sale posts PB1 and revenue", async () => {
    const { member, ticketId } = await newTicket();
    const { order, event: paymentPaid } = await placePaidOrder(
      world,
      member,
      ticketId,
    );
    const stored = await storedOrder(order.id);
    expectExclusivePb1(stored);

    expect((await staffFire(world, order.id)).status).toBe(200);
    expect((await staffFire(world, order.id)).status).toBe(200);

    const rows = await snapshotRows(order.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.ruleId)).size).toBe(rows.length);
    expect(rows.reduce((sum, row) => sum + row.tax, 0)).toBe(stored.tax);

    const sales = await outboxEvent("order.paid", "orderId", order.id);
    expect(sales).toHaveLength(1);
    expect(sales[0]!.payload).toMatchObject({
      channel: "facility",
      pbjtIdr: stored.tax,
      serviceChargeIdr: stored.service,
      totalIdr: stored.total,
    });

    // The receipt first (as the worker does), then the sale.
    expect(await journal(paymentPaid)).toMatchObject({ status: "posted" });
    const result = await journal(sales[0]!);
    expect(result.status, JSON.stringify(result)).toBe("posted");
    const lines = await journalLines(
      (result as { journalEntryId: string }).journalEntryId,
    );
    expect(lines.tax_payable_pbjt).toEqual({ debit: 0, credit: stored.tax });
    expect(lines.sales_revenue).toEqual({ debit: 0, credit: SUBTOTAL });
    if (stored.service > 0)
      expect(lines.service_charge).toEqual({
        debit: 0,
        credit: stored.service,
      });
    const debit = Object.values(lines).reduce(
      (sum, line) => sum + line.debit,
      0,
    );
    const credit = Object.values(lines).reduce(
      (sum, line) => sum + line.credit,
      0,
    );
    expect(debit).toBe(stored.total);
    expect(credit).toBe(stored.total);
  });

  it("BRK-TAX-02 the worker sweep also records the snapshot, once, and an unfired order has none", async () => {
    const unfired = await newTicket();
    const { order: held } = await placePaidOrder(
      world,
      unfired.member,
      unfired.ticketId,
    );
    expect(await snapshotRows(held.id)).toEqual([]);

    const { member, ticketId } = await newTicket();
    const { order } = await placePaidOrder(world, member, ticketId);
    await setFireAt(world, order.id, new Date(Date.now() - MINUTE));
    await runSweep(world);
    await runSweep(world);

    expect((await linkedOf(world, order.id)).status).toBe("fired");
    const stored = await storedOrder(order.id);
    const rows = await snapshotRows(order.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.reduce((sum, row) => sum + row.tax, 0)).toBe(stored.tax);
    expect(await snapshotRows(held.id)).toEqual([]);
  });
});

// ---- BRK-TAX-03 ----------------------------------------------------------------

let inclusiveWorld: BreakfastWorld | undefined;

describe("BRK-TAX-03 a tax-inclusive outlet cannot sell breakfast (fail closed)", () => {
  it("BRK-TAX-03 the order is refused with QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED; no order, link, intent or money is created", async () => {
    inclusiveWorld = await createBreakfastWorld(app);
    const target = inclusiveWorld;
    await asOwnerTenant(target.tenant.tenantId, (client) =>
      client.query(
        "UPDATE tax_rules SET price_includes_tax = true WHERE tenant_id = $1",
        [target.tenant.tenantId],
      ),
    );
    const { ticketId, api } = await newTicket(target);

    const refused = await api.create(ticketId, breakfastBody(target));
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body.error.code).toBe("QR_ORDER_INCLUSIVE_TAX_UNSUPPORTED");

    const counts = await asOwnerTenant(
      target.tenant.tenantId,
      async (client) => {
        const read = async (table: string) =>
          (
            await client.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
              [target.tenant.tenantId],
            )
          ).rows[0]!.n;
        return {
          linked: await read("facility_linked_orders"),
          orders: await read("orders"),
          links: await read("payment_links"),
          intents: await read("payment_intents"),
        };
      },
    );
    expect(counts).toEqual({ linked: 0, orders: 0, links: 0, intents: 0 });

    // Control: the same request works once the outlet is back to exclusive
    // prices, so the refusal came from the inclusive rule.
    await asOwnerTenant(target.tenant.tenantId, (client) =>
      client.query(
        "UPDATE tax_rules SET price_includes_tax = false WHERE tenant_id = $1",
        [target.tenant.tenantId],
      ),
    );
    const accepted = await api.create(ticketId, breakfastBody(target));
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  });
});

// ---- BRK-TAX-04 ----------------------------------------------------------------

describe("BRK-TAX-04 refunds never exceed what was paid, PB1 included", () => {
  it("BRK-TAX-04 cancelling a paid order refunds the whole payment including PB1, once, and not a rupiah more", async () => {
    const { member, ticketId, api } = await newTicket();
    const { order, intentId } = await placePaidOrder(world, member, ticketId);
    const stored = await storedOrder(order.id);
    expect(stored.tax).toBeGreaterThan(0);

    const first = await api.cancel(ticketId, order.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.refundIdr).toBe(stored.total);

    const refunds = await refundDetailsOf(world, intentId);
    expect(refunds).toHaveLength(1);
    expect(refundedSum(refunds)).toBe(stored.total);
    expect(refundedSum(refunds)).toBeGreaterThan(SUBTOTAL);

    const again = await api.cancel(ticketId, order.id);
    expect(again.status).toBe(200);
    expect(refundedSum(await refundDetailsOf(world, intentId))).toBe(
      stored.total,
    );
    const linked = await linkedOf(world, order.id);
    expect(linked.paid).toBe(stored.total);
    expect(linked.refunded).toBeLessThanOrEqual(linked.paid);
    expect(await kitchenTicketCount(world, order.id)).toBe(0);
    expect(await snapshotRows(order.id)).toEqual([]);
    expect(await outboxEvent("order.paid", "orderId", order.id)).toHaveLength(
      0,
    );
  });
});

// ---- BRK-TAX-05 partial refund of a fired breakfast (ORD-09 path) --------------

async function userWithRole(label: string, roleId: string) {
  const client = agent(app);
  await signUp(client, label);
  const session = await client.get("/api/auth/get-session");
  const userId = session.body.user.id as string;
  await owner.query(
    `INSERT INTO role_assignments
       (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
    [world.tenant.tenantId, userId, roleId],
  );
  return { client, userId };
}

type Supervisor = Awaited<ReturnType<typeof userWithRole>>;
let recoveryRole: string;

async function recoveryStaff(label: string) {
  if (!recoveryRole) {
    recoveryRole = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Supervisor Sarapan Uji', false, NULL, $3, false, '["tenant"]')`,
      [
        recoveryRole,
        world.tenant.tenantId,
        JSON.stringify([
          "order.view",
          "order.create",
          "order.recovery.handle",
          "kds.ticket.process",
          "floor.table.view",
        ]),
      ],
    );
  }
  return userWithRole(label, recoveryRole);
}

/** Reports one failed breakfast line and resolves it with an approved ORD-09 refund. */
async function refundLine(
  supervisor: Supervisor,
  approver: Supervisor,
  orderId: string,
  menuItemId: string,
  lineIdr: number,
  mayBeRefused = false,
) {
  const items = await asOwnerTenant(world.tenant.tenantId, async (client) => {
    const { rows } = await client.query<{ id: string; menu_item_id: string }>(
      `SELECT id::text, menu_item_id::text AS menu_item_id FROM order_items
        WHERE tenant_id = $1 AND order_id = $2::uuid`,
      [world.tenant.tenantId, ulidToUuid(orderId)],
    );
    return rows;
  });
  const item = items.find((row) => row.menu_item_id === menuItemId)!;
  const reported = await supervisor.client
    .post(`/api/order-items/${uuidToUlid(item.id)}/issues`)
    .set(world.headers)
    .set(originHeader)
    .send({
      type: "unfulfillable",
      reason: "out_of_stock",
      reasonNote: "Habis",
    });
  if (reported.status !== 201) return { reported, issueId: null };
  const issueId = reported.body.data.id as string;
  const approvalId = randomUUID();
  await asOwnerTenant(world.tenant.tenantId, (client) =>
    client.query(
      `INSERT INTO approval_requests
         (id, tenant_id, outlet_id, chain_id, source_module, action_type, object_type,
          object_id, payload, requested_by, source, level, required_levels,
          required_steps, amount_idr, status, request_reason, decided_by, decided_at,
          reason, deadline_at, created_at)
       VALUES ($1, $2, $3, $1, 'order_recovery', 'refund', 'order_issue', $4, '{}', $5, 'user', 1, 1,
               '[]', $7, 'approved', 'Pemulihan item gagal', $6, now(), 'Disetujui',
               now() + interval '1 day', now() - interval '1 minute')`,
      [
        approvalId,
        world.tenant.tenantId,
        world.tenant.outletId,
        issueId,
        supervisor.userId,
        approver.userId,
        lineIdr,
      ],
    ),
  );
  const resolved = await supervisor.client
    .post(`/api/order-issues/${issueId}/resolve`)
    .set(world.headers)
    .set(originHeader)
    .send({
      resolution: "manual_refund",
      approvalRequestId: approvalId,
      reason: "Menu habis",
    });
  if (mayBeRefused && resolved.status !== 200)
    return { reported, issueId: null };
  expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'order_issue.manual_refund_approved'
        AND event::text LIKE $2 ORDER BY created_at, id`,
    [world.tenant.tenantId, `%${issueId}%`],
  );
  expect(rows).toHaveLength(1);
  const event = eventEnvelopeSchema.parse(rows[0]!.event);
  const context = world.context;
  await withTenant(db, context, (tx) =>
    deliverOrderRecoveryRefundEvent(context, event, tx),
  );
  return { reported, issueId };
}

describe("BRK-TAX-05 a partial refund of a fired breakfast returns PB1 proportionally", () => {
  // Assumption: the kitchen reports a failed breakfast line and a supervisor
  // resolves it with an approved manual refund (ORD-09), exactly as for a QR
  // order; the refund of a line is the line plus its share of service charge
  // and PB1 (qr order-recovery-refund.test.ts), and the order.refunded journal
  // reverses the same shares. The refund can never pass what was paid.
  it("BRK-TAX-05 refunding the nasi line returns its price plus its share of PB1; the refund journal reverses that PB1 and the whole refund stays within the payment", async () => {
    const supervisor = await recoveryStaff("Supervisor Sarapan");
    const approver = await recoveryStaff("Penyetuju Sarapan");
    const { member, ticketId } = await newTicket();
    const {
      order,
      intentId,
      event: paymentPaid,
    } = await placePaidOrder(world, member, ticketId);
    expect((await staffFire(world, order.id)).status).toBe(200);
    const stored = await storedOrder(order.id);
    expectExclusivePb1(stored);
    const share = (amount: number, line: number) =>
      Math.round((amount * line) / stored.subtotal);
    const NASI = 2 * 30_000;
    const KOPI = 15_000;

    await refundLine(supervisor, approver, order.id, world.ids.nasi, NASI);
    const nasiRefund =
      NASI + share(stored.service, NASI) + share(stored.tax, NASI);
    let refunds = await refundDetailsOf(world, intentId);
    expect(refunds.map((refund) => refund.amount)).toEqual([nasiRefund]);
    expect(nasiRefund).toBeLessThan(stored.total);

    await refundLine(supervisor, approver, order.id, world.ids.kopi, KOPI);
    refunds = await refundDetailsOf(world, intentId);
    expect(refunds).toHaveLength(2);
    expect(refundedSum(refunds)).toBeLessThanOrEqual(stored.total);
    expect(refundedSum(refunds)).toBeGreaterThanOrEqual(stored.total - 1);

    // The sale and both refunds reach the books: PB1 is reversed in full, never more.
    const sales = await outboxEvent("order.paid", "orderId", order.id);
    expect(sales).toHaveLength(1);
    expect(await journal(paymentPaid)).toMatchObject({ status: "posted" });
    expect(await journal(sales[0]!)).toMatchObject({ status: "posted" });
    const reversals = await outboxEvent("order.refunded", "orderId", order.id);
    expect(reversals).toHaveLength(2);
    const pbjtReversed: number[] = [];
    for (const reversal of reversals) {
      const result = await journal(reversal);
      expect(result.status, JSON.stringify(result)).toBe("posted");
      const lines = await journalLines(
        (result as { journalEntryId: string }).journalEntryId,
      );
      pbjtReversed.push(lines.tax_payable_pbjt?.debit ?? 0);
    }
    expect(pbjtReversed[0]).toBe(share(stored.tax, NASI));
    expect(
      pbjtReversed.reduce((sum, value) => sum + value, 0),
    ).toBeLessThanOrEqual(stored.tax);
    expect(
      pbjtReversed.reduce((sum, value) => sum + value, 0),
    ).toBeGreaterThanOrEqual(stored.tax - 1);

    // A third complaint about a line that is already refunded must not pay again
    // (either the report or the resolution is refused).
    const third = await refundLine(
      supervisor,
      approver,
      order.id,
      world.ids.nasi,
      NASI,
      true,
    );
    expect(third.issueId).toBeNull();
    expect(refundedSum(await refundDetailsOf(world, intentId))).toBe(
      refundedSum(refunds),
    );
  });
});
