// legend-19j3c (brief 1031, tier K / money): the refundable amount of a QR
// pay-first sale payment must be the NET money still held: what the guest paid
// minus what the provider already returned on its own (payment_provider_refunds,
// briefs 967/980) minus refunds we have in flight, and never above real money.
// Outlet must not lose, guest must not be paid more. Doubt = restrictive.
//
// Written from the brief and the 760/980 test fixtures, failing first.
//
// Assumptions (the brief does not fix them):
// - Raw fixtures as payment-refund-qr-split-guard.test.ts: one paid payment link,
//   paid intents with one evidence row each, a fired QR order pinned to P1.
// - "Split QR refund" = a refund on a payment of a link whose fired QR order is
//   pinned to another or the same intent. The spare money (paid - net due) is
//   what may leave. Example: link paid 150000, order total 100000, so 50000 is
//   spare; the provider already returned 20000, so 30000 may still be refunded.
// - A provider refund is a raw payment_provider_refunds row (967 columns).
// - An in-flight refund is a raw payment_refunds row 'pending'.
// - Refund request success is 200/201; refusal is any 4xx and stores no row
//   (the exact code is not pinned, REFUND_INTENT_IN_QR_SALE or an amount error).
// - Listing is the refundable endpoint; "not listed" counts as 0.
//
// Run: LEGEND_TEST_FILES="src/test/payment-refund-qr-net-provider-1031.test.ts" pnpm test
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { createApp } from "../app.ts";
import { setAuditWriter } from "../services/audit-writer.ts";
import { coreAuditWriter } from "../services/core-audit-writer.ts";
import { setPaymentRefundGateway } from "../services/payment-refund-gateway.ts";
import { originHeader, verifySessionMfa } from "./helpers.ts";
import {
  createIsolatedTenant,
  owner,
  seededOutletA,
  seededTenantId,
  staffOfIsolatedTenant,
  staffWithRole,
  type IsolatedTenant,
  type Staff,
} from "./floor-test-helpers.ts";

const ADMIN = "/api/payments/admin";
const app: Express = createApp();
const key = (prefix = "net") => `${prefix}-${randomUUID()}`;

let staff: Staff;
let otherTenant: IsolatedTenant;
let otherStaff: Staff;
const intentIds: string[] = [];
const linkIds: string[] = [];
const orderIds: string[] = [];

async function asOwner<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [seededTenantId],
    );
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** One paid link; each share is a paid intent with one evidence row of its amount. */
async function paidLink(
  shares: number[],
  linkTotalIdr = shares.reduce((a, b) => a + b, 0),
): Promise<{ intents: string[]; evidence: string[] }> {
  const linkId = randomUUID();
  const intents: string[] = [];
  const evidence: string[] = [];
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, 'qr-net-1031-test')`,
      [
        linkId,
        seededTenantId,
        seededOutletA,
        randomUUID().replaceAll("-", "").padEnd(64, "0"),
        `QN-${linkId.slice(0, 8)}`,
        linkTotalIdr,
      ],
    );
    for (const amount of shares) {
      const intentId = randomUUID();
      const evidenceId = randomUUID();
      await client.query(
        `INSERT INTO payment_intents
           (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr,
            idempotency_key, status, instructions, expires_at, paid_at)
         VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'paid',
                 '{"method":"qris","qrPayload":"00020101021226TEST","issuer":null}', now() + interval '1 hour', now())`,
        [
          intentId,
          seededTenantId,
          seededOutletA,
          linkId,
          amount,
          `qn-${intentId}`,
        ],
      );
      await client.query(
        `INSERT INTO payment_evidence (id, tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
         VALUES ($1, $2, $3, $4, 'doit', $5, 'qris', 'verified_webhook', $6, now())`,
        [
          evidenceId,
          seededTenantId,
          seededOutletA,
          intentId,
          `evidence-${intentId}`,
          amount,
        ],
      );
      intents.push(intentId);
      evidence.push(evidenceId);
    }
  });
  linkIds.push(linkId);
  intentIds.push(...intents);
  return { intents, evidence };
}

/** A fired QR pay-first order pinned to `intentId`. */
async function firedQrOrder(
  intentId: string,
  totalIdr: number,
): Promise<string> {
  const id = randomUUID();
  orderIds.push(id);
  await asOwner(async (client) => {
    await client.query(
      `INSERT INTO orders (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
         subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr, total_idr,
         deposit_applied_idr, status, business_date, placed_at, payment_intent_id, fired_at,
         payment_link_id, payment_link_token_sealed)
       VALUES ($1, $2, $3, $4, 'qr', 'dine_in', 'pay_first', $5, 0, 0, 0, 0, $5,
         0, 'sent', '2026-11-09', now(), $6, now(),
         (SELECT payment_link_id FROM payment_intents WHERE tenant_id = $2 AND id = $6),
         'sealed-test')`,
      [
        id,
        seededTenantId,
        seededOutletA,
        `QN-${randomUUID().slice(0, 8)}`,
        totalIdr,
        intentId,
      ],
    );
  });
  return id;
}

/** The provider refunded `amountIdr` of the intent on its own (brief 967). */
async function providerRefunded(intentId: string, amountIdr: number) {
  await asOwner((client) =>
    client.query(
      `INSERT INTO payment_provider_refunds
         (tenant_id, outlet_id, payment_intent_id, provider, provider_refund_id,
          provider_payment_ref, amount_idr, source)
       VALUES ($1, $2, $3, 'doit', $4, $5, $6, 'payment_webhook')`,
      [
        seededTenantId,
        seededOutletA,
        intentId,
        `rf_${randomUUID().slice(0, 12)}`,
        `pay_${intentId.slice(0, 12)}`,
        amountIdr,
      ],
    ),
  );
}

/** A refund of ours that is still in flight (not failed). */
async function inFlightRefund(
  intentId: string,
  amountIdr: number,
  status: "pending" | "approved" = "pending",
) {
  await owner.query(
    `INSERT INTO payment_refunds (tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status, requested_by)
     SELECT tenant_id, outlet_id, id, $3, 'Refund uji 1031', $4, 'qr-net-1031-test'
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [seededTenantId, intentId, amountIdr, status],
  );
}

const requestRefund = (
  who: Staff,
  intentId: string,
  amountIdr: number,
  host?: string,
) => {
  const call = who.client
    .post(`${ADMIN}/refunds`)
    .set(originHeader)
    .send({
      idempotencyKey: key("req"),
      paymentIntentId: intentId,
      amountIdr,
      reason: "Pengembalian uji QR net provider",
    });
  return host ? call.set("Host", host) : call;
};

async function refundableOf(
  who: Staff,
  outletId: string,
  intentId: string,
  host?: string,
): Promise<number> {
  const call = who.client.get(
    `${ADMIN}/refunds/refundable?outletId=${outletId}`,
  );
  const response = await (host ? call.set("Host", host) : call);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const row = response.body.data.payments.find(
    (p: { paymentIntentId: string }) => p.paymentIntentId === intentId,
  ) as { refundableAmountIdr: number } | undefined;
  return row?.refundableAmountIdr ?? 0;
}

async function refundRowsOf(tenantId: string, intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    amount: string;
  }>(
    `SELECT id, status, amount_idr::text AS amount
       FROM payment_refunds WHERE tenant_id = $1 AND payment_intent_id = $2
      ORDER BY created_at, id`,
    [tenantId, intentId],
  );
  return rows;
}

/** Sum of our non-failed refunds on the intent. */
async function liveRefundTotal(intentId: string): Promise<number> {
  return (await refundRowsOf(seededTenantId, intentId))
    .filter((r) => r.status !== "failed")
    .reduce((sum, r) => sum + Number(r.amount), 0);
}

const accepted = (status: number) => status === 200 || status === 201;
const refused = (status: number) => status >= 400 && status < 500;

beforeAll(async () => {
  if (!process.env.STARTER_TEST_RUN?.startsWith("starter-pg-test-"))
    throw new Error("Requires the disposable test database");
  staff = await staffWithRole(app, {
    template: "owner",
    label: "QR Net Provider 1031 Owner",
  });
  await verifySessionMfa(staff.email);
  otherTenant = await createIsolatedTenant(`qn-${randomUUID().slice(0, 6)}`);
  otherStaff = await staffOfIsolatedTenant(app, otherTenant);
  setAuditWriter(coreAuditWriter);
});

afterAll(async () => {
  setPaymentRefundGateway(null);
  setAuditWriter(null);
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_provider_refunds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_unallocated_funds WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await owner.query(
    "DELETE FROM payment_evidence WHERE payment_intent_id = ANY($1::uuid[])",
    [intentIds],
  );
  await asOwner(async (client) => {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      orderIds,
    ]);
  });
  await asOwner(async (client) => {
    await client.query(
      "DELETE FROM payment_intents WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, intentIds],
    );
    await client.query(
      "DELETE FROM payment_links WHERE tenant_id = $1 AND id = ANY($2)",
      [seededTenantId, linkIds],
    );
  });
  await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
    otherTenant.tenantId,
    randomUUID(),
  ]);
  await owner.end();
});

describe("PAY-04 (1031) QR sale hold is net of the provider refund", () => {
  it("PAY-04 1031-a overpaid QR sale (paid 150000, order 100000) after a 20000 provider refund: 30000 refundable, 30000 accepted, 30001 refused", async () => {
    const { intents } = await paidLink([150_000]);
    const p1 = intents[0]!;
    await firedQrOrder(p1, 100_000);
    await providerRefunded(p1, 20_000);

    expect(await refundableOf(staff, seededOutletA, p1)).toBe(30_000);

    // Listing contract: paid = refunded + refundable, and never above the
    // 150000 the guest brought in.
    const list = await staff.client.get(
      `${ADMIN}/refunds/refundable?outletId=${seededOutletA}`,
    );
    const row = list.body.data.payments.find(
      (p: { paymentIntentId: string }) => p.paymentIntentId === p1,
    ) as {
      paidAmountIdr: number;
      refundedAmountIdr: number;
      refundableAmountIdr: number;
    };
    expect(row.paidAmountIdr).toBeLessThanOrEqual(150_000);
    expect(row.refundedAmountIdr + row.refundableAmountIdr).toBe(
      row.paidAmountIdr,
    );

    const over = await requestRefund(staff, p1, 30_001);
    expect(refused(over.status), JSON.stringify(over.body)).toBe(true);
    expect(await refundRowsOf(seededTenantId, p1)).toHaveLength(0);

    const ok = await requestRefund(staff, p1, 30_000);
    expect(accepted(ok.status), JSON.stringify(ok.body)).toBe(true);
    expect(await liveRefundTotal(p1)).toBe(30_000);
  });

  it("PAY-04 1031-a2 split link: non-payer P2 (40000, 10000 returned by the provider) paid on top of an order already covered by P1 is refundable only for its net 30000", async () => {
    // Link total 100000 is covered by P1 alone; P2 is a double payment whose
    // unallocated 40000 is recorded, minus the provider's 10000 it holds 0
    // of the order and 30000 of real money is refundable.
    const { intents, evidence } = await paidLink([100_000, 40_000], 100_000);
    const [p1, p2] = intents as [string, string];
    await firedQrOrder(p1, 100_000);
    await owner.query(
      `INSERT INTO payment_unallocated_funds (tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
       VALUES ($1, $2, $3, $4, 40000, 'double_payment')`,
      [seededTenantId, seededOutletA, p2, evidence[1]],
    );
    await providerRefunded(p2, 10_000);

    // The payer P1 stays fully held.
    const p1Refund = await requestRefund(staff, p1, 1);
    expect(refused(p1Refund.status), JSON.stringify(p1Refund.body)).toBe(true);
    expect(await refundRowsOf(seededTenantId, p1)).toHaveLength(0);

    // Never above the real remaining money of P2 (40000 - 10000).
    const over = await requestRefund(staff, p2, 30_001);
    expect(refused(over.status), JSON.stringify(over.body)).toBe(true);
    expect(await refundRowsOf(seededTenantId, p2)).toHaveLength(0);
  });

  it("PAY-04 1031-a3 sole payer paid exactly the order (100000) and the provider returned 30000: the sale is short, nothing is refundable and every request is refused", async () => {
    const { intents } = await paidLink([100_000]);
    const p1 = intents[0]!;
    await firedQrOrder(p1, 100_000);
    await providerRefunded(p1, 30_000);

    expect(await refundableOf(staff, seededOutletA, p1)).toBe(0);
    const response = await requestRefund(staff, p1, 1);
    expect(refused(response.status), JSON.stringify(response.body)).toBe(true);
    expect(await refundRowsOf(seededTenantId, p1)).toHaveLength(0);
  });

  it("PAY-04 1031-a4 split 60000/40000, order 100000 pinned to P1, 10000 returned by the provider on P2: P2 and P1 stay held, lists 0, refunds refused", async () => {
    const { intents } = await paidLink([60_000, 40_000]);
    const [p1, p2] = intents as [string, string];
    await firedQrOrder(p1, 100_000);
    await providerRefunded(p2, 10_000);

    expect(await refundableOf(staff, seededOutletA, p2)).toBe(0);
    expect(await refundableOf(staff, seededOutletA, p1)).toBe(0);
    for (const intent of [p1, p2]) {
      const response = await requestRefund(staff, intent, 1);
      expect(refused(response.status), JSON.stringify(response.body)).toBe(
        true,
      );
      expect(await refundRowsOf(seededTenantId, intent)).toHaveLength(0);
    }
  });
});

describe("PAY-04 (1031) double and concurrent refunds never exceed what remains", () => {
  it("PAY-04 1031-b sequential: two refunds of 20000 on a 30000 net remainder: the first is accepted, the second refused", async () => {
    const { intents } = await paidLink([150_000]);
    const p1 = intents[0]!;
    await firedQrOrder(p1, 100_000);
    await providerRefunded(p1, 20_000);

    const first = await requestRefund(staff, p1, 20_000);
    expect(accepted(first.status), JSON.stringify(first.body)).toBe(true);
    const second = await requestRefund(staff, p1, 20_000);
    expect(refused(second.status), JSON.stringify(second.body)).toBe(true);
    expect(await liveRefundTotal(p1)).toBe(20_000);
  });

  it("PAY-04 1031-b2 concurrent: four parallel refunds of 20000 on a 30000 net remainder store at most 30000 in total", async () => {
    const { intents } = await paidLink([150_000]);
    const p1 = intents[0]!;
    await firedQrOrder(p1, 100_000);
    await providerRefunded(p1, 20_000);

    const responses = await Promise.all(
      [1, 2, 3, 4].map(() => requestRefund(staff, p1, 20_000)),
    );

    expect(responses.filter((r) => accepted(r.status))).toHaveLength(1);
    expect(await liveRefundTotal(p1)).toBeLessThanOrEqual(30_000);
    expect(await liveRefundTotal(p1)).toBe(20_000);
  });
});

describe("PAY-04 (1031) refunds in flight are counted", () => {
  it("PAY-04 1031-c pending refund of 10000 on a 30000 net remainder: 20000 is listed and accepted, 20001 refused", async () => {
    const { intents } = await paidLink([150_000]);
    const p1 = intents[0]!;
    await firedQrOrder(p1, 100_000);
    await providerRefunded(p1, 20_000);
    await inFlightRefund(p1, 10_000);

    expect(await refundableOf(staff, seededOutletA, p1)).toBe(20_000);

    const over = await requestRefund(staff, p1, 20_001);
    expect(refused(over.status), JSON.stringify(over.body)).toBe(true);
    expect(await refundRowsOf(seededTenantId, p1)).toHaveLength(1);

    const ok = await requestRefund(staff, p1, 20_000);
    expect(accepted(ok.status), JSON.stringify(ok.body)).toBe(true);
    expect(await liveRefundTotal(p1)).toBe(30_000);
  });

  it("PAY-04 1031-c2 approved refund of 30000 uses the whole net remainder: nothing is listed and any request is refused", async () => {
    const { intents } = await paidLink([150_000]);
    const p1 = intents[0]!;
    await firedQrOrder(p1, 100_000);
    await providerRefunded(p1, 20_000);
    await inFlightRefund(p1, 30_000, "approved");

    expect(await refundableOf(staff, seededOutletA, p1)).toBe(0);
    const response = await requestRefund(staff, p1, 1);
    expect(refused(response.status), JSON.stringify(response.body)).toBe(true);
    expect(await refundRowsOf(seededTenantId, p1)).toHaveLength(1);
  });
});

describe("PAY-04 (1031) tenant isolation", () => {
  it("PAY-04 1031-d another tenant cannot list or refund the intent, and its own refunds do not shrink this tenant's remainder", async () => {
    const { intents } = await paidLink([150_000]);
    const p1 = intents[0]!;
    await firedQrOrder(p1, 100_000);
    await providerRefunded(p1, 20_000);

    const foreign = await requestRefund(
      otherStaff,
      p1,
      1_000,
      otherTenant.hostname,
    );
    expect(refused(foreign.status), JSON.stringify(foreign.body)).toBe(true);
    expect(await refundRowsOf(seededTenantId, p1)).toHaveLength(0);
    // The foreign listing is either refused (403, the isolated staff has no
    // refund permission) or does not contain the intent.
    const foreignList = await otherStaff.client
      .get(`${ADMIN}/refunds/refundable?outletId=${otherTenant.outletId}`)
      .set("Host", otherTenant.hostname);
    if (foreignList.status === 200)
      expect(
        foreignList.body.data.payments.some(
          (p: { paymentIntentId: string }) => p.paymentIntentId === p1,
        ),
      ).toBe(false);
    else expect(refused(foreignList.status)).toBe(true);

    // The owner tenant's remainder is unchanged by the foreign attempt.
    expect(await refundableOf(staff, seededOutletA, p1)).toBe(30_000);
  });
});

describe("PAY-04 (1031) outlet never loses, guest never paid more", () => {
  it("PAY-04 1031-e refunds ours plus the provider's never exceed the money received, and the order stays covered", async () => {
    const paid = 150_000;
    const due = 100_000;
    const providerPart = 20_000;
    const { intents } = await paidLink([paid]);
    const p1 = intents[0]!;
    await firedQrOrder(p1, due);
    await providerRefunded(p1, providerPart);

    // The guest asks for everything back in several tries.
    for (const amount of [paid, 50_000, 30_000, 30_000, 1]) {
      await requestRefund(staff, p1, amount);
    }

    const returned = (await liveRefundTotal(p1)) + providerPart;
    expect(returned).toBeLessThanOrEqual(paid);
    // The outlet keeps at least the order total after every refund.
    expect(paid - returned).toBeGreaterThanOrEqual(due);
    expect(await refundableOf(staff, seededOutletA, p1)).toBe(0);
  });

  it("PAY-04 1031-e2 intent amount below evidence: refundable never exceeds the intent amount minus the provider refund and the order total", async () => {
    // Evidence 150000 but the intent is for 120000: only 120000 is the
    // intent's real money. Order 100000, provider 5000 => at most 15000.
    const { intents } = await paidLink([120_000]);
    const p1 = intents[0]!;
    await owner.query(
      "UPDATE payment_evidence SET amount_idr = 150000 WHERE tenant_id = $1 AND payment_intent_id = $2",
      [seededTenantId, p1],
    );
    await firedQrOrder(p1, 100_000);
    await providerRefunded(p1, 5_000);

    expect(await refundableOf(staff, seededOutletA, p1)).toBe(15_000);
    const over = await requestRefund(staff, p1, 15_001);
    expect(refused(over.status), JSON.stringify(over.body)).toBe(true);
    expect(await refundRowsOf(seededTenantId, p1)).toHaveLength(0);
  });
});
