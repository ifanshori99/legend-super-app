// legend-nsvu0 (brief 982): refund of a PAID swap-difference charge
// (`order_issue_charges`, status `paid`). Written before the behavior exists,
// so the file starts red.
//
// Money in the standard order (helpers): charge amount 8.085 (7.000 + service
// 350 + PBJT 735), paid by the guest through the charge's own QRIS code.
//
// Assumptions where the brief and docs are silent (the interface is mine):
// - Route: POST /api/order-issue-charges/:chargeId/refund, body
//   `{ amountIdr, reason }`, same guard as waive/expire (supervisor holding
//   `order.recovery.handle`). Success is any 2xx. No separate approval request.
// - "Refunded so far" is read from `payment_refunds` of the charge's own
//   payment intent, every status except `failed` (a reserved/pending refund
//   already counts, as `refundableBalance` does).
// - Over-limit, open, waived: 409 for a charge that is not paid; 409 or 422
//   for an amount above what is still refundable. Cross-tenant: 404 (RLS);
//   other outlet of the same tenant: 403 or 404.
// - Reversal journal: accounting is switched on for the test tenant with a
//   minimal chart; the outbox events of the tenant are delivered to
//   `deliverAutoJournalEvent` by hand (as the worker does). The reversal of the
//   charge revenue takes `refund amount` out of sales_revenue + service_charge
//   + tax_payable_pbjt, whatever the idempotency key is named. Past the refund
//   request this block is unverified until the feature exists.

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  staffWithRole,
  type Staff,
} from "./floor-test-helpers.ts";

let w: World;
let foreignOwner: Staff;

beforeAll(async () => {
  w = await createWorld();
  // A real owner of ANOTHER tenant (the seeded one).
  foreignOwner = await staffWithRole(w.app, {
    template: "owner",
    label: "Pemilik Tenant Lain",
  });
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

const DIFFERENCE = PRICES.kopi - PRICES.roti;
const PAID = 8_085;
const REASON = "Tamu komplain, swap dibatalkan";

// ---- helpers ---------------------------------------------------------------

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

/** A paid order whose roti was swapped for kopi, with its charge opened. */
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

/** The guest pays the charge online and the payment event reaches the charge. */
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
  expect((await chargeRow(opened.chargeId)).status).toBe("paid");
  return { ...opened, intentId };
}

async function chargeRow(chargeId: string) {
  const { rows } = await owner.query<{
    status: string;
    amount_idr: number;
    payment_intent_id: string | null;
  }>(
    `SELECT status, amount_idr::int AS amount_idr, payment_intent_id
     FROM order_issue_charges WHERE tenant_id = $1 AND id = $2`,
    [w.tenant.tenantId, chargeId],
  );
  return rows[0]!;
}

/** Every refund of the intent that is not failed (reserved money counts). */
async function refundedTotal(intentId: string): Promise<number> {
  const { rows } = await owner.query<{ total: number }>(
    `SELECT coalesce(sum(amount_idr), 0)::int AS total FROM payment_refunds
     WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
    [w.tenant.tenantId, intentId],
  );
  return rows[0]!.total;
}

async function allRefundRows(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM payment_refunds WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return Number(rows[0]!.n);
}

function refund(
  chargeId: string,
  body: Record<string, unknown>,
  who: Staff = w.supervisor,
  host: string = w.tenant.hostname,
) {
  return who.client
    .post(`/api/order-issue-charges/${chargeId}/refund`)
    .set("Host", host)
    .set(originHeader)
    .send(body);
}

const refundBody = (amountIdr: number) => ({ amountIdr, reason: REASON });

function expectOk(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(200);
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

// ---- main flow and ceiling ---------------------------------------------------

describe("legend-nsvu0 refund of a paid issue charge", () => {
  it("refunds part of a paid charge: a refund of that amount on the charge's own intent, order intent untouched", async () => {
    const c = await paidCharge();
    const orderIntent = (
      await owner.query<{ payment_intent_id: string }>(
        "SELECT payment_intent_id FROM orders WHERE tenant_id = $1 AND id = $2",
        [w.tenant.tenantId, ulidToUuid(c.order.id)],
      )
    ).rows[0]!.payment_intent_id;

    const res = await refund(c.chargeId, refundBody(3_000));

    expectOk(res);
    expect(await refundedTotal(c.intentId)).toBe(3_000);
    expect(await refundedTotal(orderIntent)).toBe(0);
  });

  it("repeat refunds add up and the total never passes the paid charge: 5.000 + 3.085 ok, then even 1 more is refused", async () => {
    const c = await paidCharge();

    expectOk(await refund(c.chargeId, refundBody(5_000)));
    expect(await refundedTotal(c.intentId)).toBe(5_000);

    // 5.000 + 3.086 = 8.086 > 8.085: refused, nothing added.
    const over = await refund(c.chargeId, refundBody(PAID - 5_000 + 1));
    expect([409, 422], JSON.stringify(over.body)).toContain(over.status);
    expect(await refundedTotal(c.intentId)).toBe(5_000);

    expectOk(await refund(c.chargeId, refundBody(PAID - 5_000)));
    expect(await refundedTotal(c.intentId)).toBe(PAID);

    const again = await refund(c.chargeId, refundBody(1));
    expect([409, 422], JSON.stringify(again.body)).toContain(again.status);
    expect(await refundedTotal(c.intentId)).toBe(PAID);
  });

  it("one request above the paid value is refused outright, nothing is created", async () => {
    const c = await paidCharge();
    const before = await allRefundRows();

    // Positive control on the same charge first, so a missing route cannot pass.
    expectOk(await refund(c.chargeId, refundBody(1_000)));
    const res = await refund(c.chargeId, refundBody(PAID + 1));

    expect([409, 422], JSON.stringify(res.body)).toContain(res.status);
    expect(await refundedTotal(c.intentId)).toBe(1_000);
    expect(await allRefundRows()).toBe(before + 1);
  });

  it("concurrent refunds cannot overshoot: five of 3.000 on 8.085 paid, exactly two win, total 6.000", async () => {
    const c = await paidCharge();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => refund(c.chargeId, refundBody(3_000))),
    );

    const ok = results.filter((r) => r.status >= 200 && r.status < 300);
    const refused = results.filter((r) => r.status === 409 || r.status === 422);
    expect(ok).toHaveLength(2);
    expect(refused).toHaveLength(3);
    expect(await refundedTotal(c.intentId)).toBe(6_000);
    expect(await refundedTotal(c.intentId)).toBeLessThanOrEqual(PAID);
  });

  it("concurrent full refunds: only one pays out, total equals the paid charge", async () => {
    const c = await paidCharge();

    const results = await Promise.all(
      Array.from({ length: 3 }, () => refund(c.chargeId, refundBody(PAID))),
    );

    expect(
      results.filter((r) => r.status >= 200 && r.status < 300),
    ).toHaveLength(1);
    expect(await refundedTotal(c.intentId)).toBe(PAID);
  });

  it("an open or a waived charge owes nothing back: 409, no refund row", async () => {
    const open = await openCharge();
    const waived = await openCharge();
    await owner.query(
      `UPDATE order_issue_charges
       SET status = 'waived', closed_at = now(), closed_by = $3,
           close_reason = 'Tamu komplain lama menunggu'
       WHERE tenant_id = $1 AND id = $2`,
      [w.tenant.tenantId, waived.chargeId, w.supervisor.userId],
    );
    const before = await allRefundRows();

    const a = await refund(open.chargeId, refundBody(1_000));
    const b = await refund(waived.chargeId, refundBody(1_000));

    expect(a.status, JSON.stringify(a.body)).toBe(409);
    expect(b.status, JSON.stringify(b.body)).toBe(409);
    expect(await allRefundRows()).toBe(before);
  });

  it("a staff member without order.recovery.handle cannot refund: 403, nothing created", async () => {
    const c = await paidCharge();
    // Positive control: the supervisor can.
    expectOk(await refund(c.chargeId, refundBody(1_000)));

    const res = await refund(c.chargeId, refundBody(1_000), w.floorStaff);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await refundedTotal(c.intentId)).toBe(1_000);
  });
});

// ---- isolation ---------------------------------------------------------------

describe("legend-nsvu0 other tenant and other outlet are untouched", () => {
  it("a staff member of another tenant gets 404 and nothing changes (own tenant control works)", async () => {
    const c = await paidCharge();
    const before = await allRefundRows();

    const foreign = await refund(
      c.chargeId,
      refundBody(2_000),
      foreignOwner,
      seededHostname,
    );

    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    expect(await refundedTotal(c.intentId)).toBe(0);
    expect(await allRefundRows()).toBe(before);
    expect((await chargeRow(c.chargeId)).status).toBe("paid");

    // The rightful tenant still refunds the full value afterwards.
    expectOk(await refund(c.chargeId, refundBody(PAID)));
    expect(await refundedTotal(c.intentId)).toBe(PAID);
  });

  it("a supervisor limited to another outlet cannot refund this outlet's charge (403/404), nothing changes", async () => {
    const c = await paidCharge();
    const before = await allRefundRows();

    const res = await refund(
      c.chargeId,
      refundBody(2_000),
      w.otherOutletSupervisor,
    );

    expect([403, 404], JSON.stringify(res.body)).toContain(res.status);
    expect(await refundedTotal(c.intentId)).toBe(0);
    expect(await allRefundRows()).toBe(before);

    // Control: the supervisor of the charge's own outlet can.
    expectOk(await refund(c.chargeId, refundBody(2_000), w.outletSupervisor));
    expect(await refundedTotal(c.intentId)).toBe(2_000);
  });

  it("refunding a charge never touches the refundable balance of another charge", async () => {
    const a = await paidCharge();
    const b = await paidCharge();

    expectOk(await refund(a.chargeId, refundBody(PAID)));

    expect(await refundedTotal(a.intentId)).toBe(PAID);
    expect(await refundedTotal(b.intentId)).toBe(0);
    expect((await chargeRow(b.chargeId)).status).toBe("paid");
  });
});

// ---- reversal journal --------------------------------------------------------

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
  const accounts = {} as Record<Role, string>;
  for (const [role, code, name, type, group] of CHART) {
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO chart_of_accounts (tenant_id, legal_entity_id, code, name, type, report_group)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [w.tenant.tenantId, w.tenant.legalEntityId, code, name, type, group],
    );
    accounts[role] = rows[0]!.id;
    await owner.query(
      `INSERT INTO account_mappings (tenant_id, legal_entity_id, role, account_id)
       VALUES ($1, $2, $3, $4)`,
      [w.tenant.tenantId, w.tenant.legalEntityId, role, accounts[role]],
    );
  }
  for (const period of ["2026-10", "2026-11", "2026-12"])
    await owner.query(
      `INSERT INTO fiscal_periods (tenant_id, legal_entity_id, period)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, legal_entity_id, period) DO NOTHING`,
      [w.tenant.tenantId, w.tenant.legalEntityId, period],
    );
  return accounts;
}

/** The worker, by hand: every outbox event of the tenant, in order. */
async function deliverAllOutboxToJournal() {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id = $1
     ORDER BY created_at, id`,
    [w.tenant.tenantId],
  );
  const context = contextOf(w.tenant.tenantId);
  for (const row of rows) {
    const event: EventEnvelope = eventEnvelopeSchema.parse(row.event);
    await withTenant(db, context, (tx) =>
      deliverAutoJournalEvent(context, event, tx),
    );
  }
}

async function entryIds(): Promise<Set<string>> {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM journal_entries WHERE tenant_id = $1",
    [w.tenant.tenantId],
  );
  return new Set(rows.map((r) => r.id));
}

describe("legend-nsvu0 reversal journal", () => {
  it("a refund of the paid charge posts a balanced reversal that takes the refund out of revenue/service/PBJT; replaying posts nothing more", async () => {
    const accounts = await enableAccounting();
    const c = await paidCharge();
    await deliverAllOutboxToJournal();
    const before = await entryIds();

    expectOk(await refund(c.chargeId, refundBody(PAID)));
    // Fix C: the reversal books only once the refund is final (completed).
    await owner.query(
      `UPDATE payment_refunds SET status = 'completed', completed_at = now()
       WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
      [w.tenant.tenantId, c.intentId],
    );
    await deliverAllOutboxToJournal();
    const after = await entryIds();
    const fresh = [...after].filter((id) => !before.has(id));

    expect(
      fresh.length,
      "new journal entries after the refund",
    ).toBeGreaterThan(0);
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

    const sales = [
      accounts.sales_revenue,
      accounts.service_charge,
      accounts.tax_payable_pbjt,
    ];
    const { rows: net } = await owner.query<{ debit_net: string | null }>(
      `SELECT sum(debit_idr - credit_idr)::text AS debit_net
       FROM journal_lines
       WHERE tenant_id = $1 AND entry_id = ANY($2::uuid[]) AND account_id = ANY($3::uuid[])`,
      [w.tenant.tenantId, fresh, sales],
    );
    expect(Number(net[0]!.debit_net ?? 0)).toBe(PAID);

    // Replay of every event: no new entry.
    await deliverAllOutboxToJournal();
    expect((await entryIds()).size).toBe(after.size);

    // Nothing parked as SALE_MISSING for this charge.
    const { rows: parked } = await owner.query(
      `SELECT 1 FROM auto_journal_parked
       WHERE tenant_id = $1 AND error_code = 'SALE_MISSING'
         AND idempotency_key LIKE $2`,
      [w.tenant.tenantId, `%${c.chargeId}%`],
    );
    expect(parked).toHaveLength(0);
  });
});
