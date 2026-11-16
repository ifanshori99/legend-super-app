// Shared fixtures for the round 3 tests of brief docs/briefs/912-3p1.md
// (legend-4n8rs active code rule, legend-154wr hold race). Not a test file:
// vitest only picks up `*.test.ts`. Same shapes as
// qr-va-912-ek1wt-public-token-hold.test.ts, which stays self-contained.
import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { ulidToUuid, type OutletId } from "@starter/shared/core";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createPaymentLink } from "../services/payment.service.ts";
import type {
  GatewayIntentRequest,
  PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { asOwnerTenant } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import type { HoldFixture } from "./pos-qris-hold-test-helpers.ts";

export type Pg = Parameters<Parameters<typeof asOwnerTenant>[1]>[0];

/** Gateway double that records every provider call (create and cancel). */
export class CountingGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  readonly requests: GatewayIntentRequest[] = [];
  readonly cancels: string[] = [];
  readonly cancel: NonNullable<PaymentGatewayPort["cancel"]> = async (
    _context,
    intent,
  ) => {
    this.cancels.push(intent.intentId);
  };
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    this.requests.push(input);
    const instructions: PaymentInstructions =
      input.method === "va"
        ? {
            method: "va",
            channelCode: input.channelCode ?? "bmri",
            channelName: "Mandiri",
            virtualAccountNumber: "8808123456789012",
          }
        : {
            method: "qris",
            qrPayload: "00020101021226R3P1QR",
            issuer: null,
          };
    return {
      providerRef: `R3P1-${randomUUID()}`,
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
  /** Bank "bmri" is the only VA channel. */
  async channels(_context: unknown, method?: string) {
    return method === "va" ? [{ code: "bmri", name: "Mandiri" }] : [];
  }
}

export const qrisBody = (idempotencyKey: string = randomUUID()) => ({
  method: "qris",
  channelCode: null,
  idempotencyKey,
});

export const vaBody = (idempotencyKey: string = randomUUID()) => ({
  method: "va",
  channelCode: "bmri",
  idempotencyKey,
});

export async function intentRow(tenantId: string, intentId: string) {
  const { rows } = await owner.query(
    `SELECT status, provider_final_at, expires_at, provider_ref
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, intentId],
  );
  return rows[0]!;
}

export async function intentCount(tenantId: string) {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM payment_intents WHERE tenant_id = $1",
    [tenantId],
  );
  return Number(rows[0]!.n);
}

export async function intentsOnLink(tenantId: string, linkId: string) {
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = $2 ORDER BY created_at, id",
    [tenantId, linkId],
  );
  return rows.map((row) => row.id);
}

export async function holdStates(tenantId: string, orderUuid: string) {
  const { rows } = await owner.query<{ state: string }>(
    "SELECT state FROM pos_qris_holds WHERE tenant_id = $1 AND order_id = $2 ORDER BY state",
    [tenantId, orderUuid],
  );
  return rows.map((row) => row.state);
}

export function expectHoldRefusal(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(JSON.stringify(response.body)).toContain("QRIS_HOLD_ACTIVE");
}

/** 409 with this exact error code (shape: body.error.code). */
export function expectRefusal(
  response: { status: number; body: unknown },
  code: "ORDER_CODE_ACTIVE" | "SPLIT_CODE_ACTIVE" | "QRIS_HOLD_ACTIVE",
) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  const error = (response.body as { error?: { code?: string } }).error;
  expect(error?.code, JSON.stringify(response.body)).toBe(code);
}

/** A bill link for a POS order, tied to it the way a pay-first order is. */
export async function bindLinkToOrder(
  fx: HoldFixture,
  order: { id: string; totalIdr: number },
  tableLabel = "A03",
) {
  const opened = await createPaymentLink(
    fx.context,
    {
      outletId: fx.tenant.outletId as OutletId,
      reference: `R3P1-${randomUUID().slice(0, 8)}`,
      tableLabel,
      pax: 2,
      subtotalIdr: order.totalIdr,
      discountIdr: 0,
      serviceChargeIdr: 0,
      taxIdr: 0,
      roundingIdr: 0,
      totalIdr: order.totalIdr,
      returnPath: "/t/v1.abc",
    },
    fx.staff.userId,
  );
  await asOwnerTenant(fx.tenant.tenantId, (client) =>
    client.query(
      `UPDATE orders SET payment_link_id = $3, payment_link_token_sealed = 'sealed-test'
        WHERE tenant_id = $1 AND id = $2`,
      [fx.tenant.tenantId, ulidToUuid(order.id), opened.linkId],
    ),
  );
  return { token: opened.token, linkId: opened.linkId };
}

/**
 * A code on `linkId` that a provider could still be paid on: pending, not
 * expired, provider_ref set. `method` va or qris. No hold row.
 */
export async function seedLiveCode(
  client: Pg,
  input: {
    tenantId: string;
    outletId: string;
    linkId: string;
    amountIdr: number;
    method?: "va" | "qris";
    billSplitId?: string | null;
  },
) {
  const intentId = randomUUID();
  const method = input.method ?? "va";
  await client.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, bill_split_id, method, provider,
        provider_ref, amount_idr, idempotency_key, status, instructions, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'doit', $7, $8, $9, 'pending', $10::jsonb,
             now() + interval '4 minutes')`,
    [
      intentId,
      input.tenantId,
      input.outletId,
      input.linkId,
      input.billSplitId ?? null,
      method,
      `LIVE-${intentId}`,
      input.amountIdr,
      `r3p1-${intentId}`,
      JSON.stringify(
        method === "qris"
          ? { method: "qris", qrPayload: "00020101021226LIVEQR", issuer: null }
          : {
              method: "va",
              channelCode: "bmri",
              channelName: "Mandiri",
              virtualAccountNumber: "8808123456789012",
            },
      ),
    ],
  );
  return intentId;
}

/**
 * A pending, unexpired QRIS intent and an open hold for the order, as the
 * backfill writes them (same as the ek1wt test). On `linkId`, or a new link.
 */
export async function seedHeldCode(
  client: Pg,
  input: {
    tenantId: string;
    outletId: string;
    orderUuid: string;
    amountIdr: number;
    linkId?: string;
  },
) {
  const linkId = input.linkId ?? randomUUID();
  const intentId = randomUUID();
  if (!input.linkId)
    await client.query(
      `INSERT INTO payment_links
         (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6, 0, 'seed')`,
      [
        linkId,
        input.tenantId,
        input.outletId,
        randomBytes(32).toString("hex"),
        `R3P1-${linkId.slice(0, 8)}`,
        input.amountIdr,
      ],
    );
  await client.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, provider_ref,
        amount_idr, idempotency_key, status, instructions, expires_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $7, 'pending', $8::jsonb,
             now() + interval '4 minutes')`,
    [
      intentId,
      input.tenantId,
      input.outletId,
      linkId,
      `SEED-${intentId}`,
      input.amountIdr,
      `r3p1-${intentId}`,
      JSON.stringify({
        method: "qris",
        qrPayload: "00020101021226SEEDQR",
        issuer: null,
      }),
    ],
  );
  await client.query(
    `INSERT INTO pos_qris_holds
       (tenant_id, id, outlet_id, order_id, tender_id, payment_intent_id,
        amount_idr, backfilled, state, opened_at, opened_by, next_check_at)
     VALUES ($1, gen_random_uuid(), $2, $3, NULL, $4, $5, true, 'open', now(), NULL, now())`,
    [
      input.tenantId,
      input.outletId,
      input.orderUuid,
      intentId,
      input.amountIdr,
    ],
  );
  return { intentId, linkId };
}
