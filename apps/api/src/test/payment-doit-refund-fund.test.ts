// A quarantined fund refund is only looked up (never sent), and the lookup must
// name the FUND's evidence payment, never the intent's own payment
// (legend-0ogy, review finding 5). Scenario: refund RF for a duplicate payment X
// is quarantined while the intent's payment Y was fully refunded; polling RF
// must not read Y and complete RF from it.
//
// Service level on PostgreSQL; the refund port is a recording stub so the
// `paymentProviderRef` handed to `getRefundStatus` can be asserted.
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cafeLegendAccessFixtures } from "@starter/shared/access";
import { cafeLegendPlatformFixtures } from "@starter/shared/platform";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  setPaymentRefundGateway,
  type GatewayRefundLookup,
  type GatewayRefundRequest,
  type GatewayRefundResult,
  type PaymentRefundPort,
} from "../services/payment-refund-gateway";
import { runRefundPayout } from "../services/payment-refund.service";

const tenantId = cafeLegendPlatformFixtures.tenant.id;
const outletA = cafeLegendAccessFixtures.outletIds.bandung;
const PAYOUT_QUARANTINED = "PAYOUT_QUARANTINED";
const owner = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 2,
});
const context: ScopedTenantContext = establishScopedTenantContext(
  establishTenantContext({ tenantId, brandId: null, source: "job" }),
  { kind: "tenant" },
);

type StatusInput = Parameters<PaymentRefundPort["getRefundStatus"]>[0];

class RecordingPort implements PaymentRefundPort {
  readonly provider = "doit";
  readonly sent: GatewayRefundRequest[] = [];
  readonly lookups: StatusInput[] = [];
  /** What the provider "knows": a paid-out refund answers succeeded. */
  answer: GatewayRefundLookup = { status: "not_found" };

  async refund(input: GatewayRefundRequest): Promise<GatewayRefundResult> {
    this.sent.push(input);
    throw new Error("a quarantined refund must never be sent");
  }

  async getRefundStatus(input: StatusInput): Promise<GatewayRefundLookup> {
    this.lookups.push(input);
    return this.answer;
  }
}

let port: RecordingPort;
const linkIds: string[] = [];
const intentIds: string[] = [];
const refundIds: string[] = [];

beforeEach(() => {
  port = new RecordingPort();
  setPaymentRefundGateway(port);
});
afterEach(() => setPaymentRefundGateway(null));

afterAll(async () => {
  await owner.query(
    "DELETE FROM payment_refunds WHERE payment_intent_id = ANY($1::uuid[])",
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
  await owner.query("DELETE FROM payment_intents WHERE id = ANY($1::uuid[])", [
    intentIds,
  ]);
  await owner.query("DELETE FROM payment_links WHERE id = ANY($1::uuid[])", [
    linkIds,
  ]);
  await owner.end();
});

/**
 * A paid intent whose own payment is `pay-Y` (the one a full refund moved to
 * `refunded` at DOIT) and one evidence row `pay-X`. Returns a quarantined,
 * already-attempted fund refund; the fund points at X when `mapped`.
 */
async function seedQuarantinedFundRefund(mapped: boolean) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  linkIds.push(linkId);
  intentIds.push(intentId);
  await owner.query(
    `INSERT INTO payment_links (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, 100000, 100000, 100000, 'system:test')`,
    [
      linkId,
      tenantId,
      outletA,
      randomBytes(32).toString("hex"),
      `RFF-${linkId.slice(0, 8)}`,
    ],
  );
  await owner.query(
    `INSERT INTO payment_intents (id, tenant_id, outlet_id, payment_link_id, method, provider, amount_idr, idempotency_key, status, paid_at, instructions, expires_at, provider_ref)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', 100000, $5, 'paid', now(), '{"method":"qris","qrPayload":"test","issuer":null}', now(), $6)`,
    [
      intentId,
      tenantId,
      outletA,
      linkId,
      `rff-${intentId}`,
      `pay-Y-${intentId}`,
    ],
  );
  const evidenceRef = `pay-X-${intentId}`;
  const evidence = await owner.query<{ id: string }>(
    `INSERT INTO payment_evidence (tenant_id, outlet_id, payment_intent_id, provider, provider_ref, method, source, amount_idr, received_at)
     VALUES ($1, $2, $3, 'doit', $4, 'qris', 'verified_webhook', 20000, now())
     RETURNING id`,
    [tenantId, outletA, intentId, evidenceRef],
  );
  const fundId = randomUUID();
  await owner.query(
    `INSERT INTO payment_unallocated_funds (id, tenant_id, outlet_id, payment_intent_id, evidence_id, amount_idr, reason)
     VALUES ($1, $2, $3, $4, $5, 20000, 'overpayment')`,
    [fundId, tenantId, outletA, intentId, mapped ? evidence.rows[0]!.id : null],
  );
  const refundId = randomUUID();
  refundIds.push(refundId);
  await owner.query(
    `INSERT INTO payment_refunds (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
                                  requested_by, approved_by, decided_at, payout_attempts, last_payout_error,
                                  updated_at, unallocated_fund_id)
     VALUES ($1, $2, $3, $4, 20000, 'Kembalikan kelebihan bayar', 'approved', 'system:test', 'system:approver',
             now(), 1, $5, now() - interval '2 hours', $6)`,
    [refundId, tenantId, outletA, intentId, PAYOUT_QUARANTINED, fundId],
  );
  return { intentId, refundId, evidenceRef, intentRef: `pay-Y-${intentId}` };
}

async function statusOf(refundId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM payment_refunds WHERE tenant_id = $1 AND id = $2",
    [tenantId, refundId],
  );
  return rows[0]!.status;
}

describe("DOIT refund: quarantined fund refund lookup (finding 5)", () => {
  it("looks up the fund's evidence payment (X), not the intent's payment (Y), and never sends", async () => {
    const seeded = await seedQuarantinedFundRefund(true);

    await runRefundPayout(context, seeded.refundId);

    expect(port.sent).toHaveLength(0);
    expect(port.lookups).toHaveLength(1);
    expect(port.lookups[0]!.paymentProviderRef).toBe(seeded.evidenceRef);
    expect(port.lookups[0]!.paymentProviderRef).not.toBe(seeded.intentRef);
    expect(await statusOf(seeded.refundId)).toBe("approved");
  });

  it("passes null when the fund has no evidence mapping, never the intent's own payment ref", async () => {
    const seeded = await seedQuarantinedFundRefund(false);

    await runRefundPayout(context, seeded.refundId);

    expect(port.sent).toHaveLength(0);
    expect(port.lookups).toHaveLength(1);
    expect(port.lookups[0]!.paymentProviderRef).toBeNull();
    expect(port.lookups[0]!.paymentProviderRef).not.toBe(seeded.intentRef);
    // Reading must not map the fund as a side effect.
    const { rows } = await owner.query<{ evidence_id: string | null }>(
      `SELECT f.evidence_id FROM payment_unallocated_funds f
       JOIN payment_refunds r ON r.unallocated_fund_id = f.id
       WHERE r.tenant_id = $1 AND r.id = $2`,
      [tenantId, seeded.refundId],
    );
    expect(rows[0]!.evidence_id).toBeNull();
  });

  it("the lookup carries the intent's id, amount and outlet for credential resolution", async () => {
    const seeded = await seedQuarantinedFundRefund(true);

    await runRefundPayout(context, seeded.refundId);

    expect(port.lookups[0]).toMatchObject({
      paymentIntentId: seeded.intentId,
      amountIdr: 20_000,
      outletId: outletA,
      integrationId: null,
      idempotencyKey: `refund:${seeded.refundId}`,
    });
  });
});
