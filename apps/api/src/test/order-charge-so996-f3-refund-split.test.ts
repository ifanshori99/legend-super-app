// legend-0zfr1 (brief 1010, finding F3, P2): the gross/service/PBJT split of a
// charge refund must count only refunds that really went through. A refund
// that was reserved and later FAILED must not move the split of later refunds.
// Written before the fix, so it starts red.
//
// Money in the standard order (helpers): charge 8.085 = gross 7.000 + service
// 350 + PBJT 735, paid online through the charge's own QRIS code.
//
// Pattern: order-charge-refund-982-nsvu0.test.ts / order-charge-fix-982-c.test.ts.
//
// Assumptions (the brief does not fix an interface beyond the 982 route):
// - Route: POST /api/order-issue-charges/:chargeId/refund `{ amountIdr, reason }`
//   by the supervisor; any 2xx is success; over the refundable balance is 409/422.
// - "Refund failed" / "refund completed" are simulated the way the 982 tests do:
//   UPDATE payment_refunds (the provider callback is not part of this card).
// - Journal check is by ACCOUNT: after every refund is final and the outbox is
//   delivered by hand (as the worker does), the net debit of sales_revenue,
//   service_charge and tax_payable_pbjt over the NEW entries must equal the
//   charge components exactly (7.000 / 350 / 735), never more, whatever the
//   delivery order or replay. Every new entry is balanced.
// - Which part of the code fixes it (request time or journal time) is not
//   asserted; only the resulting books.
// - Serialisation per charge: concurrent requests must still book exactly the
//   charge value, no overlap, no gap.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverAutoJournalEvent } from "../services/accounting-auto-journal-consumer.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  PRICES,
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import {
  owner,
  seededHostname,
  seededTenantId,
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";

let w: World;
let foreignOwner: Staff;
let accounts: Record<Role, string>;

beforeAll(async () => {
  w = await createWorld();
  foreignOwner = await staffWithRole(w.app, {
    template: "owner",
    label: "Pemilik Tenant Lain F3",
  });
  accounts = await enableAccounting();
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const DIFFERENCE = PRICES.kopi - PRICES.roti;
const PAID = 8_085;
const GROSS = 7_000;
const SERVICE = 350;
const PBJT = 735;
const REASON = "Tamu komplain, swap dibatalkan";

// ---- helpers (same shape as the 982 tests) ----------------------------------

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

async function openCharge() {
  const order = await w.paidOrder();
  const issueId = (await w.report(order.roti.id)).body.data.id as string;
  const approvalId = await w.insertApproval({
    actionType: "price_correction",
    objectType: "order_issue",
    objectId: issueId,
    amountIdr: DIFFERENCE,
    status: "approved",
    requestedBy: w.floorStaff.userId,
  });
  const resolved = await w.staffPost(
    w.supervisor,
    `/api/order-issues/${issueId}/resolve`,
    {
      resolution: "swap",
      replacementItemId: w.ids.kopi,
      approvalRequestId: approvalId,
    },
  );
  expect(resolved.status).toBe(200);
  const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM order_issue_charges
     WHERE tenant_id = $1 AND order_issue_id = $2`,
    [w.tenant.tenantId, issueId],
  );
  expect(rows).toHaveLength(1);
  return { ...order, issueId, chargeId: rows[0]!.id };
}

function guestPay(guest: Guest, chargeId: string) {
  return agent(w.app)
    .post(
      `/api/table-sessions/${guest.sessionId}/issue-charges/${chargeId}/payments`,
    )
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader)
    .send({ method: "qris", idempotencyKey: randomUUID() });
}

async function paidCharge() {
  const opened = await openCharge();
  const created = await guestPay(opened.guest, opened.chargeId);
  expect(created.status).toBe(201);
  const intentId = created.body.data.id as string;
  const context = contextOf(w.tenant.tenantId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr: PAID,
    providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
     WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
       AND event->'payload'->>'intentId' = $2`,
    [w.tenant.tenantId, intentId],
  );
  const paidEvent = eventEnvelopeSchema.parse(rows[0]!.event);
  const routed = await withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, paidEvent, tx),
  );
  expect(routed).toEqual({ route: "issue_charge", outcome: "paid" });
  return { ...opened, intentId };
}

function refund(
  chargeId: string,
  amountIdr: number,
  who: Staff = w.supervisor,
  host: string = w.tenant.hostname,
) {
  return who.client
    .post(`/api/order-issue-charges/${chargeId}/refund`)
    .set("Host", host)
    .set(originHeader)
    .send({ amountIdr, reason: REASON });
}

function expectOk(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

/** The refund row of this amount that is not failed yet (amounts are unique per scenario). */
async function refundRowId(
  intentId: string,
  amountIdr: number,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND amount_idr = $3
       AND status <> 'failed'
     ORDER BY created_at LIMIT 1`,
    [w.tenant.tenantId, intentId, amountIdr],
  );
  expect(rows, `a live refund of ${amountIdr}`).toHaveLength(1);
  return rows[0]!.id;
}

async function failRefund(id: string) {
  await owner.query(
    `UPDATE payment_refunds
     SET status = 'failed', failure_reason = 'provider_declined'
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, id],
  );
}

async function completeRefund(id: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'completed', completed_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, id],
  );
}

async function completeAllLive(intentId: string) {
  await owner.query(
    `UPDATE payment_refunds SET status = 'completed', completed_at = now()
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [w.tenant.tenantId, intentId],
  );
}

async function liveRefundTotal(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ total: number }>(
    `SELECT coalesce(sum(amount_idr), 0)::int AS total FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [w.tenant.tenantId, intentId],
  );
  return rows[0]!.total;
}

// ---- accounting --------------------------------------------------------------

type Role =
  | "cash_on_hand"
  | "gateway_clearing"
  | "tax_payable_pbjt"
  | "customer_deposit"
  | "sales_revenue"
  | "service_charge";

const CHART: [Role, string, string, string, string][] = [
  ["cash_on_hand", "1101", "Kas Outlet", "asset", "current_asset"],
  [
    "gateway_clearing",
    "1201",
    "Kliring Payment Gateway",
    "asset",
    "current_asset",
  ],
  ["tax_payable_pbjt", "2104", "Utang PBJT", "liability", "current_liability"],
  [
    "customer_deposit",
    "2107",
    "Uang Muka Pelanggan",
    "liability",
    "current_liability",
  ],
  ["sales_revenue", "4101", "Penjualan", "revenue", "revenue"],
  ["service_charge", "4103", "Service Charge", "revenue", "revenue"],
];

async function enableAccounting(): Promise<Record<Role, string>> {
  await owner.query("UPDATE tenants SET feature_flags = $2 WHERE id = $1", [
    w.tenant.tenantId,
    JSON.stringify({ modules: ["accounting"], integrationProviders: [] }),
  ]);
  const out = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [w.tenant.tenantId, w.tenant.legalEntityId, code, name, type, group],
    );
    out[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [w.tenant.tenantId, w.tenant.legalEntityId, role, out[role]],
    );
  }
  for (const period of ["2026-10", "2026-11", "2026-12"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [w.tenant.tenantId, w.tenant.legalEntityId, period],
    );
  return out;
}

type OutboxRow = { id: string; name: string; event: EventEnvelope };

async function outboxRows(): Promise<OutboxRow[]> {
  const { rows } = await owner.query<{
    id: string;
    name: string;
    event: unknown;
  }>(
    `SELECT id, event->>'name' AS name, event FROM domain_event_outbox
     WHERE tenant_id = $1 ORDER BY created_at, id`,
    [w.tenant.tenantId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    event: eventEnvelopeSchema.parse(r.event),
  }));
}

async function deliver(rows: OutboxRow[]) {
  const context = contextOf(w.tenant.tenantId);
  for (const row of rows)
    await withTenant(db, context, (tx) =>
      deliverAutoJournalEvent(context, row.event, tx),
    );
}

async function entryIds(): Promise<Set<string>> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return new Set(rows.map((r) => r.id));
}

/** Pay the charge and book its sale side, so only refund entries are "fresh" later. */
async function paidChargeBooked() {
  const c = await paidCharge();
  await deliver(await outboxRows());
  return { ...c, baselineEntries: await entryIds() };
}

/** Net DEBIT per sales account over entries created after the baseline; every fresh entry balanced. */
async function reversalNet(baseline: Set<string>) {
  const fresh = [...(await entryIds())].filter((id) => !baseline.has(id));
  const { rows: balance } = await owner.query<{
    entry_id: string;
    debit: string;
    credit: string;
  }>(
    `SELECT entry_id, sum(debit_idr)::text AS debit, sum(credit_idr)::text AS credit
     FROM journal_lines WHERE tenant_id = $1 AND entry_id = ANY($2::uuid[])
     GROUP BY entry_id`,
    [w.tenant.tenantId, fresh],
  );
  for (const row of balance) expect(row.debit).toBe(row.credit);

  const net = async (accountId: string) => {
    const { rows } = await owner.query<{ n: string | null }>(
      `SELECT sum(debit_idr - credit_idr)::text AS n FROM journal_lines
       WHERE tenant_id = $1 AND entry_id = ANY($2::uuid[]) AND account_id = $3`,
      [w.tenant.tenantId, fresh, accountId],
    );
    return Number(rows[0]!.n ?? 0);
  };
  return {
    fresh: fresh.length,
    gross: await net(accounts.sales_revenue),
    service: await net(accounts.service_charge),
    pbjt: await net(accounts.tax_payable_pbjt),
  };
}

const FULL_REVERSAL = { gross: GROSS, service: SERVICE, pbjt: PBJT };

function expectFullReversal(got: {
  gross: number;
  service: number;
  pbjt: number;
}) {
  expect({ gross: got.gross, service: got.service, pbjt: got.pbjt }).toEqual(
    FULL_REVERSAL,
  );
}

/** New charge_refunded events of this charge after `seen`, in outbox order. */
async function newChargeRefundEvents(chargeId: string, seen: Set<string>) {
  return (await outboxRows()).filter(
    (r) =>
      !seen.has(r.id) &&
      r.name === "order_issue.charge_refunded" &&
      JSON.stringify(r.event).includes(chargeId),
  );
}

// ---- scenario F3: A fails, B and C go through --------------------------------

type CompletionOrder = "fail-A-first" | "complete-B-first";
type Delivery = "forward" | "reverse" | "early-then-replay";

const CASES: [CompletionOrder, Delivery][] = [
  ["fail-A-first", "forward"],
  ["fail-A-first", "reverse"],
  ["fail-A-first", "early-then-replay"],
  ["complete-B-first", "forward"],
  ["complete-B-first", "reverse"],
  ["complete-B-first", "early-then-replay"],
];

describe("legend-0zfr1 refund fails, a new refund follows: the books reverse the charge exactly", () => {
  it.each(CASES)(
    "A 2.000 + B 3.000 reserved, A fails, B completes, C 5.085 refunds the rest (%s, delivery %s): reversal is gross 7.000 / service 350 / PBJT 735, no more",
    async (completion, delivery) => {
      const c = await paidChargeBooked();
      const seen = new Set((await outboxRows()).map((r) => r.id));

      // A and B are both requested while A is still reserved, so B's share is
      // computed behind A's reservation.
      expectOk(await refund(c.chargeId, 2_000));
      expectOk(await refund(c.chargeId, 3_000));
      const a = await refundRowId(c.intentId, 2_000);
      const b = await refundRowId(c.intentId, 3_000);

      if (delivery === "early-then-replay") {
        // Everything is journalled while still pending: nothing may be booked yet.
        await deliver(await newChargeRefundEvents(c.chargeId, seen));
      }

      if (completion === "fail-A-first") {
        await failRefund(a);
        await completeRefund(b);
      } else {
        await completeRefund(b);
        await failRefund(a);
      }

      // The failed reservation is released: exactly 8.085 - 3.000 left.
      expect(await liveRefundTotal(c.intentId)).toBe(3_000);
      const tooMuch = await refund(c.chargeId, PAID - 3_000 + 1);
      expect([409, 422], JSON.stringify(tooMuch.body)).toContain(
        tooMuch.status,
      );
      expectOk(await refund(c.chargeId, PAID - 3_000));
      const cRow = await refundRowId(c.intentId, PAID - 3_000);
      await completeRefund(cRow);
      expect(await liveRefundTotal(c.intentId)).toBe(PAID);

      let events = await newChargeRefundEvents(c.chargeId, seen);
      // Other events of the refunds (payment.refunded ...) go first, as the worker would.
      const rest = (await outboxRows()).filter(
        (r) => !seen.has(r.id) && !events.some((e) => e.id === r.id),
      );
      await deliver(rest);
      if (delivery === "reverse") events = [...events].reverse();
      await deliver(events);
      if (delivery === "early-then-replay") await deliver(events);

      const net = await reversalNet(c.baselineEntries);
      expect(net.fresh, "reversal entries exist").toBeGreaterThan(0);
      expectFullReversal(net);
    },
  );

  it("three refunds stay reserved, one fails, the rest refunds in two more: components never pass the charge (PBJT 735, service 350, gross 7.000)", async () => {
    const c = await paidChargeBooked();
    const seen = new Set((await outboxRows()).map((r) => r.id));

    expectOk(await refund(c.chargeId, 3_000)); // A, will fail
    expectOk(await refund(c.chargeId, 2_000)); // B
    expectOk(await refund(c.chargeId, 1_500)); // C
    await failRefund(await refundRowId(c.intentId, 3_000));
    await completeRefund(await refundRowId(c.intentId, 2_000));
    await completeRefund(await refundRowId(c.intentId, 1_500));

    // 8.085 - 3.500 = 4.585 left, taken in two refunds.
    expectOk(await refund(c.chargeId, 4_000)); // D
    expectOk(await refund(c.chargeId, 585)); // E
    await completeAllLive(c.intentId);
    expect(await liveRefundTotal(c.intentId)).toBe(PAID);

    await deliver((await outboxRows()).filter((r) => !seen.has(r.id)));
    expectFullReversal(await reversalNet(c.baselineEntries));
  });

  it("a partly refunded charge reverses only that part, and the later rest completes it: after fail + retry the books never exceed what was refunded", async () => {
    const c = await paidChargeBooked();
    const seen = new Set((await outboxRows()).map((r) => r.id));

    expectOk(await refund(c.chargeId, 2_000)); // A fails
    expectOk(await refund(c.chargeId, 3_000)); // B completes
    await failRefund(await refundRowId(c.intentId, 2_000));
    await completeRefund(await refundRowId(c.intentId, 3_000));
    await deliver((await outboxRows()).filter((r) => !seen.has(r.id)));

    // Money out so far is 3.000: the books reverse 3.000 of the sales side, no more.
    const partial = await reversalNet(c.baselineEntries);
    expect(partial.gross + partial.service + partial.pbjt).toBe(3_000);
    expect(partial.gross).toBeLessThanOrEqual(GROSS);
    expect(partial.service).toBeLessThanOrEqual(SERVICE);
    expect(partial.pbjt).toBeLessThanOrEqual(PBJT);
  });
});

// ---- concurrency -------------------------------------------------------------

describe("legend-0zfr1 concurrent refund requests of one charge", () => {
  it("four requests of 2.000 plus one of 85 at once all fit: split is serialised, the reversal is exactly the charge", async () => {
    const c = await paidChargeBooked();
    const seen = new Set((await outboxRows()).map((r) => r.id));

    const results = await Promise.all([
      refund(c.chargeId, 2_000),
      refund(c.chargeId, 2_000),
      refund(c.chargeId, 2_000),
      refund(c.chargeId, 2_000),
      refund(c.chargeId, 85),
    ]);
    for (const r of results) expectOk(r);
    expect(await liveRefundTotal(c.intentId)).toBe(PAID);

    await completeAllLive(c.intentId);
    await deliver((await outboxRows()).filter((r) => !seen.has(r.id)));
    expectFullReversal(await reversalNet(c.baselineEntries));
  });

  it("three of 2.500 at once, one fails, then two more at once take the rest: books reverse the charge exactly", async () => {
    const c = await paidChargeBooked();
    const seen = new Set((await outboxRows()).map((r) => r.id));

    const first = await Promise.all([
      refund(c.chargeId, 2_500),
      refund(c.chargeId, 2_500),
      refund(c.chargeId, 2_500),
    ]);
    for (const r of first) expectOk(r);

    // One of the three is declined.
    const { rows } = await owner.query<{ id: string }>(
      `SELECT id FROM payment_refunds
       WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'
       ORDER BY created_at, id LIMIT 1`,
      [w.tenant.tenantId, c.intentId],
    );
    await failRefund(rows[0]!.id);
    expect(await liveRefundTotal(c.intentId)).toBe(5_000);

    // 8.085 - 5.000 = 3.085 left: 2.085 + 1.000 together.
    const second = await Promise.all([
      refund(c.chargeId, 2_085),
      refund(c.chargeId, 1_000),
    ]);
    for (const r of second) expectOk(r);
    expect(await liveRefundTotal(c.intentId)).toBe(PAID);

    await completeAllLive(c.intentId);
    await deliver((await outboxRows()).filter((r) => !seen.has(r.id)));
    expectFullReversal(await reversalNet(c.baselineEntries));
  });

  it("two full refunds at once: one wins, the books reverse the charge once", async () => {
    const c = await paidChargeBooked();
    const seen = new Set((await outboxRows()).map((r) => r.id));

    const results = await Promise.all([
      refund(c.chargeId, PAID),
      refund(c.chargeId, PAID),
    ]);
    expect(
      results.filter((r) => r.status >= 200 && r.status < 300),
    ).toHaveLength(1);

    await completeAllLive(c.intentId);
    await deliver((await outboxRows()).filter((r) => !seen.has(r.id)));
    expectFullReversal(await reversalNet(c.baselineEntries));
  });
});

// ---- other tenant ------------------------------------------------------------

describe("legend-0zfr1 other tenant is untouched", () => {
  it("another tenant's owner cannot refund (404, nothing booked there); the rightful refund after a failed one still books exactly", async () => {
    const c = await paidChargeBooked();
    const seen = new Set((await outboxRows()).map((r) => r.id));

    const foreign = await refund(
      c.chargeId,
      2_000,
      foreignOwner,
      seededHostname,
    );
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expect(await liveRefundTotal(c.intentId)).toBe(0);

    // Nothing about this charge or intent exists in the other tenant.
    const { rows: foreignRefunds } = await owner.query(
      `SELECT 1 FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2`,
      [seededTenantId, c.intentId],
    );
    expect(foreignRefunds).toHaveLength(0);
    const { rows: foreignEvents } = await owner.query(
      `SELECT 1 FROM domain_event_outbox
       WHERE tenant_id = $1 AND event::text LIKE $2`,
      [seededTenantId, `%${c.chargeId}%`],
    );
    expect(foreignEvents).toHaveLength(0);

    // Own tenant: the fail-then-retry scenario still ends exact.
    expectOk(await refund(c.chargeId, 2_000));
    expectOk(await refund(c.chargeId, 3_000));
    await failRefund(await refundRowId(c.intentId, 2_000));
    await completeRefund(await refundRowId(c.intentId, 3_000));
    expectOk(await refund(c.chargeId, PAID - 3_000));
    await completeAllLive(c.intentId);
    await deliver((await outboxRows()).filter((r) => !seen.has(r.id)));
    expectFullReversal(await reversalNet(c.baselineEntries));

    // Still nothing in the other tenant's journal for this charge.
    const { rows: foreignAfter } = await owner.query(
      `SELECT 1 FROM domain_event_outbox
       WHERE tenant_id = $1 AND event::text LIKE $2`,
      [seededTenantId, `%${c.chargeId}%`],
    );
    expect(foreignAfter).toHaveLength(0);
  });

  it("a failed refund on one charge does not shift the split of another charge of the same tenant", async () => {
    const a = await paidChargeBooked();
    const b = await paidChargeBooked();
    const seen = new Set((await outboxRows()).map((r) => r.id));

    expectOk(await refund(a.chargeId, 2_000));
    expectOk(await refund(a.chargeId, 3_000));
    await failRefund(await refundRowId(a.intentId, 2_000));
    await completeRefund(await refundRowId(a.intentId, 3_000));

    // Charge B is refunded in full once; A's failed reservation must not leak into it.
    expectOk(await refund(b.chargeId, PAID));
    await completeAllLive(b.intentId);
    await deliver(
      (await outboxRows()).filter(
        (r) =>
          !seen.has(r.id) &&
          !(
            r.name === "order_issue.charge_refunded" &&
            JSON.stringify(r.event).includes(a.chargeId)
          ),
      ),
    );
    expectFullReversal(await reversalNet(b.baselineEntries));
  });
});

// ---- refund of an unallocated fund on the same intent -------------------------

/** A live refund of money that belongs to no bill (PAY-04), on the charge's intent. */
async function seedFundRefund(intentId: string, amountIdr: number) {
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, 'overpayment')`,
    [fundId, w.tenant.tenantId, w.tenant.outletId, intentId, amountIdr],
  );
  await owner.query(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, unallocated_fund_id, amount_idr, reason, status, requested_by, completed_at)
     VALUES ($1, $2, $3, $4, $5, 'Kembalikan kelebihan bayar', 'completed', 'system:test', now())`,
    [w.tenant.tenantId, w.tenant.outletId, intentId, fundId, amountIdr],
  );
}

describe("legend-0zfr1 refund of an unallocated fund does not eat the charge's refundable balance", () => {
  it("a 1.000 fund refund on the intent, then the whole charge 8.085 refunds without 409 and the books reverse the charge exactly", async () => {
    const c = await paidChargeBooked();
    const seen = new Set((await outboxRows()).map((r) => r.id));

    await seedFundRefund(c.intentId, 1_000);

    expectOk(await refund(c.chargeId, PAID));
    await completeAllLive(c.intentId);
    await deliver((await outboxRows()).filter((r) => !seen.has(r.id)));
    expectFullReversal(await reversalNet(c.baselineEntries));

    // Charge side: one charge refund of the whole charge, beside the fund refund.
    const { rows } = await owner.query<{ charge: number }>(
      `SELECT coalesce(sum(amount_idr), 0)::int AS charge FROM payment_refunds
       WHERE tenant_id = $1 AND payment_intent_id = $2
         AND status <> 'failed' AND unallocated_fund_id IS NULL`,
      [w.tenant.tenantId, c.intentId],
    );
    expect(rows[0]!.charge).toBe(PAID);
  });

  it("a fund refund on the intent does not block the rest of a partly refunded charge, and the over-charge limit still holds (409/422)", async () => {
    const c = await paidChargeBooked();
    const seen = new Set((await outboxRows()).map((r) => r.id));

    await seedFundRefund(c.intentId, 1_000);
    expectOk(await refund(c.chargeId, 3_000));
    expectOk(await refund(c.chargeId, PAID - 3_000));

    const over = await refund(c.chargeId, 1);
    expect([409, 422], JSON.stringify(over.body)).toContain(over.status);

    await completeAllLive(c.intentId);
    await deliver((await outboxRows()).filter((r) => !seen.has(r.id)));
    expectFullReversal(await reversalNet(c.baselineEntries));
  });
});
