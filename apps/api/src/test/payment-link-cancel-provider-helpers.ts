// Shared fixtures for the legend-ukbq3 tests (payment link cancel follows the
// provider). Not a test file.
//
// Rules under test (founder Q93, "jangan sampai rugi", docs/briefs/
// ukbq3-payment-link-cancel.md):
//  - before a link is closed locally the provider is asked first;
//  - the provider already holds the money: do NOT close locally, apply the
//    payment to the bill OR park it ONCE in unallocated funds;
//  - the provider is unreachable or the answer is unsure: hold (fail-closed),
//    close nothing, refund nothing;
//  - nobody is paid more than was received, no double refund, idempotent.
//
// Written from the brief and the public payment contract, never from the
// cancel implementation. The tests never call the shared cancel helper by
// name: they drive the real call sites (reservation cancel, breakfast cancel,
// charge waive / forced session close / POS collect), so the helper may be
// named and placed freely.
import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { ScriptedGateway } from "./pos-qris-hold-test-helpers.ts";

export { ScriptedGateway };

/** Install a scripted provider (provider name "doit", like the other suites). */
export function installScriptedGateway(): ScriptedGateway {
  const gateway = new ScriptedGateway("doit");
  setPaymentGateway(gateway);
  return gateway;
}

/** What the provider can answer when the cancel asks about an intent. */
export const PROVIDER_UNSURE = [
  { error: "timeout" },
  { error: "5xx" },
  { otherReference: true },
] as const;

export type IntentInfo = {
  status: string;
  providerRef: string | null;
  expiresAt: Date;
};

export async function intentInfo(
  tenantId: string,
  intentId: string,
): Promise<IntentInfo> {
  const { rows } = await owner.query<{
    status: string;
    provider_ref: string | null;
    expires_at: Date;
  }>(
    `SELECT status, provider_ref, expires_at FROM payment_intents
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, intentId],
  );
  expect(rows, `intent ${intentId} exists`).toHaveLength(1);
  return {
    status: rows[0]!.status,
    providerRef: rows[0]!.provider_ref,
    expiresAt: rows[0]!.expires_at,
  };
}

/** The QR is long past its life (more than the 60 s clock-skew margin). */
export async function backdateIntentExpiry(
  tenantId: string,
  intentId: string,
  minutesAgo = 15,
) {
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - ($3::int * interval '1 minute')
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, intentId, minutesAgo],
  );
}

/** A local close is what the cancel must NOT do while the provider holds money
 * or is unsure: the pending intent turned `expired`, `failed` or `cancelled`. */
export const LOCALLY_CLOSED = ["expired", "failed", "cancelled"] as const;

export async function expectIntentOpen(
  tenantId: string,
  intentId: string,
  label: string,
) {
  const info = await intentInfo(tenantId, intentId);
  expect(
    LOCALLY_CLOSED as readonly string[],
    `${label}: intent was closed locally (status ${info.status})`,
  ).not.toContain(info.status);
  return info;
}

export type IntentMoney = {
  /** Non-failed refund requests of the intent (directly or via a parked fund). */
  refundsIdr: number;
  refundCount: number;
  /** Sum and count of `payment_unallocated_funds` rows of the intent. */
  parkedIdr: number;
  fundCount: number;
};

export async function moneyOfIntent(
  tenantId: string,
  intentId: string,
): Promise<IntentMoney> {
  const refunds = await owner.query<{ n: number; sum: number }>(
    `SELECT count(DISTINCT r.id)::int AS n,
            coalesce(sum(r.amount_idr),0)::int AS sum
       FROM (SELECT DISTINCT r.id, r.amount_idr
               FROM payment_refunds r
               LEFT JOIN payment_unallocated_funds f ON f.id = r.unallocated_fund_id
              WHERE r.tenant_id = $1 AND r.status <> 'failed'
                AND (r.payment_intent_id = $2 OR f.payment_intent_id = $2)) r`,
    [tenantId, intentId],
  );
  const funds = await owner.query<{ n: number; sum: number }>(
    `SELECT count(*)::int AS n, coalesce(sum(amount_idr),0)::int AS sum
       FROM payment_unallocated_funds
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [tenantId, intentId],
  );
  return {
    refundsIdr: refunds.rows[0]!.sum,
    refundCount: refunds.rows[0]!.n,
    parkedIdr: funds.rows[0]!.sum,
    fundCount: funds.rows[0]!.n,
  };
}

/**
 * The money the provider received is accounted for exactly once: either applied
 * to the bill (then nothing parked or refunded) or returned/parked in full
 * once. Nothing is refunded or parked above what was received (I6 style).
 */
export function expectMoneyOnce(
  label: string,
  money: IntentMoney,
  receivedIdr: number,
  applied: boolean,
) {
  expect(
    money.fundCount,
    `${label}: money parked more than once`,
  ).toBeLessThanOrEqual(1);
  expect(
    money.refundCount,
    `${label}: more than one refund`,
  ).toBeLessThanOrEqual(1);
  expect(
    money.refundsIdr,
    `${label}: refunded above received`,
  ).toBeLessThanOrEqual(receivedIdr);
  expect(
    money.parkedIdr,
    `${label}: parked above received`,
  ).toBeLessThanOrEqual(receivedIdr);
  if (applied) {
    expect(money.refundsIdr, `${label}: applied AND refunded`).toBe(0);
    expect(money.parkedIdr, `${label}: applied AND parked`).toBe(0);
  } else {
    expect(
      Math.max(money.parkedIdr, money.refundsIdr),
      `${label}: received money neither applied nor returned in full`,
    ).toBe(receivedIdr);
  }
}

/** Nothing moved: no refund, no parked fund. */
export function expectNoMoneyMoved(label: string, money: IntentMoney) {
  expect(money.refundCount, `${label}: refund requested`).toBe(0);
  expect(money.fundCount, `${label}: money parked`).toBe(0);
}

/**
 * The provider's own report of the payment as a verified webhook: same
 * provider reference the status read answers with, so it is the SAME payment
 * seen twice (a duplicate), never a second payment.
 */
export async function providerWebhook(
  context: ScopedTenantContext,
  tenantId: string,
  intentId: string,
  amountIdr: number,
) {
  const info = await intentInfo(tenantId, intentId);
  await confirmPayment(context, intentId, {
    source: "verified_webhook",
    method: "qris",
    amountIdr,
    providerRef:
      info.providerRef ?? `WEBHOOK-${randomBytes(6).toString("hex")}`,
    at: new Date().toISOString(),
  });
}

/** Every `payment.paid` event of the intent (the cancel itself may have
 * appended one when it applied the provider's payment). */
export async function paidEventsOf(
  tenantId: string,
  intentId: string,
): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = 'payment.paid'
        AND event->'payload'->>'intentId' = $2
      ORDER BY created_at, id`,
    [tenantId, intentId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

/** Run `call`; return its error instead of throwing (a held cancel may be a
 * 409/503 rejection or a 2xx answer: the tests assert state, not the code). */
export async function settleCall<T>(call: Promise<T>) {
  try {
    return { ok: true as const, value: await call };
  } catch (error) {
    return { ok: false as const, error: error as { status?: number } };
  }
}

/** The hold of the design: HTTP 409 `PAYMENT_PROVIDER_UNCONFIRMED`. */
export const UNCONFIRMED_CODE = "PAYMENT_PROVIDER_UNCONFIRMED";

/** A service call that rejected with the hold (status 409 + its code). */
export function expectUnconfirmedError(
  result: Awaited<ReturnType<typeof settleCall>>,
  label: string,
) {
  expect(result.ok, `${label}: cancel was not held`).toBe(false);
  if (result.ok) return;
  expect(
    result.error,
    `${label}: expected 409 ${UNCONFIRMED_CODE}`,
  ).toMatchObject({ status: 409, code: UNCONFIRMED_CODE });
}

/** An HTTP answer that is the hold (supertest response). */
export function expectUnconfirmedResponse(
  response: { status: number; body: { error?: { code?: string } } },
  label: string,
) {
  expect(response.status, `${label}: ${JSON.stringify(response.body)}`).toBe(
    409,
  );
  expect(response.body.error?.code, `${label}: error code`).toBe(
    UNCONFIRMED_CODE,
  );
}

/** The intent's payment link is still live (not closed locally). */
export async function expectLinkActive(
  tenantId: string,
  intentId: string,
  label: string,
) {
  const { rows } = await owner.query<{ active: boolean }>(
    `SELECT (l.expires_at IS NULL OR l.expires_at > $3) AS active
       FROM payment_intents i
       JOIN payment_links l ON l.tenant_id = i.tenant_id AND l.id = i.payment_link_id
      WHERE i.tenant_id = $1 AND i.id = $2`,
    [tenantId, intentId, new Date()],
  );
  expect(rows, `${label}: link of intent`).toHaveLength(1);
  expect(rows[0]!.active, `${label}: link was closed locally`).toBe(true);
}

/**
 * The intent's payment link was closed locally (expiry moved to now or
 * earlier). Not asserted on the intent: a gateway code already past its
 * expiry deliberately stays `pending` so the poller can still settle a late
 * payment (payment.service.ts, cancelPaymentLinkInTx). Judged on the app
 * clock, as the cancel stamps `expires_at` and the link page and createIntent
 * read it (`link.expiresAt <= now`); the DB clock can trail the app clock by
 * tens of ms, so `now()` saw a link closed a moment ago as live (1230).
 */
export async function expectLinkClosed(
  tenantId: string,
  intentId: string,
  label: string,
) {
  const { rows } = await owner.query<{ active: boolean }>(
    `SELECT (l.expires_at IS NULL OR l.expires_at > $3) AS active
       FROM payment_intents i
       JOIN payment_links l ON l.tenant_id = i.tenant_id AND l.id = i.payment_link_id
      WHERE i.tenant_id = $1 AND i.id = $2`,
    [tenantId, intentId, new Date()],
  );
  expect(rows, `${label}: link of intent`).toHaveLength(1);
  expect(rows[0]!.active, `${label}: link is still live`).toBe(false);
}
