// legend-nsvu0 / brief 982, fix C (architect finding 3 and 7).
//
// (3) A charge refund that is journalled while still pending and then ends
// `failed` leaves its reversal behind; the refile (a new refund of the same
// amount) reverses the revenue a second time. The reversal now books only
// once the refund row is `completed`: pending/approved waits, `failed` books
// nothing.
// (7) recoveryChargeRefundSplit: the per-component shares of several partial
// refunds add up to the charge exactly, none negative.

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
import { recoveryChargeRefundSplit } from "../services/order-recovery-refund-amount.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  PRICES,
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import { owner, staffWithRole, type Staff } from "./floor-test-helpers.ts";

let w: World;

beforeAll(async () => {
  w = await createWorld();
  // A real owner of ANOTHER tenant (the seeded one).
  await staffWithRole(w.app, {
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

describe("legend-nsvu0 fix C: failed charge refund leaves no reversal", () => {
  it("a refund journalled while pending then failed, refiled: revenue is reversed once, not twice", async () => {
    const accounts = await enableAccounting();
    const c = await paidCharge();
    await deliverAllOutboxToJournal();
    const base = await entryIds();

    expectOk(await refund(c.chargeId, refundBody(PAID)));
    await deliverAllOutboxToJournal();

    // The provider declines the first refund.
    await owner.query(
      `UPDATE payment_refunds
       SET status = 'failed', failure_reason = 'provider_declined'
       WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
      [w.tenant.tenantId, c.intentId],
    );
    expectOk(await refund(c.chargeId, refundBody(PAID)));
    await owner.query(
      `UPDATE payment_refunds
       SET status = 'completed', completed_at = now()
       WHERE tenant_id = $1 AND payment_intent_id = $2 AND status <> 'failed'`,
      [w.tenant.tenantId, c.intentId],
    );
    await deliverAllOutboxToJournal();
    await deliverAllOutboxToJournal();

    const fresh = [...(await entryIds())].filter((id) => !base.has(id));
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
  });
});

type Parts = {
  grossSalesIdr: number;
  serviceChargeIdr: number;
  pbjtIdr: number;
};

const sumParts = (parts: Parts[]): Parts => ({
  grossSalesIdr: parts.reduce((a, p) => a + p.grossSalesIdr, 0),
  serviceChargeIdr: parts.reduce((a, p) => a + p.serviceChargeIdr, 0),
  pbjtIdr: parts.reduce((a, p) => a + p.pbjtIdr, 0),
});

describe("legend-nsvu0 fix C: recoveryChargeRefundSplit across several refunds", () => {
  it("three refunds of 1 on a 1+1+1 charge give back exactly gross 1, service 1, PBJT 1", () => {
    const charge = {
      grossSalesIdr: 1,
      serviceChargeIdr: 1,
      pbjtIdr: 1,
      amountIdr: 3,
    };
    const parts = [0, 1, 2].map((prior) =>
      recoveryChargeRefundSplit({ charge, priorIdr: prior, refundIdr: 1 }),
    );
    expect(sumParts(parts)).toEqual({
      grossSalesIdr: 1,
      serviceChargeIdr: 1,
      pbjtIdr: 1,
    });
  });

  it("random partial refund sequences: no negative share, each refund adds up, the total equals the charge", () => {
    let seed = 982;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      const gross = 1 + rand(20_000);
      const service = rand(Math.floor(gross / 5) + 1);
      const pbjt = rand(Math.floor(gross / 5) + 1);
      const total = gross + service + pbjt;
      const charge = {
        grossSalesIdr: gross,
        serviceChargeIdr: service,
        pbjtIdr: pbjt,
        amountIdr: total,
      };
      const cuts = new Set<number>([total]);
      for (let k = rand(12); k > 0; k--) cuts.add(1 + rand(total));
      let prior = 0;
      const parts: Parts[] = [];
      for (const cut of [...cuts].sort((a, b) => a - b)) {
        const part = recoveryChargeRefundSplit({
          charge,
          priorIdr: prior,
          refundIdr: cut - prior,
        });
        expect(
          Math.min(part.grossSalesIdr, part.serviceChargeIdr, part.pbjtIdr),
        ).toBeGreaterThanOrEqual(0);
        expect(part.grossSalesIdr + part.serviceChargeIdr + part.pbjtIdr).toBe(
          cut - prior,
        );
        parts.push(part);
        prior = cut;
      }
      expect(sumParts(parts), JSON.stringify(charge)).toEqual({
        grossSalesIdr: gross,
        serviceChargeIdr: service,
        pbjtIdr: pbjt,
      });
    }
  });
});
