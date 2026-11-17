// legend-kt3t1 round 3: a code the guest voided by changing payment method is
// not a failed payment attempt.
//
// Rule (qr-order-consumers header, founder Q15 / 9vmit): an unpaid QR order is
// voided with `payment_attempts_exhausted` only after MAX_QR_PAYMENT_ATTEMPTS
// (3) codes failed on their own; "a code superseded by the guest's own switch
// of bank or method is not an attempt". A guest who flips between VA,
// e-wallet and card a few times must still be able to pay once the last code
// lapses: the order stays awaiting payment (retry_allowed), it is not voided.
//
// Expected fail-first reason (test 1): the attempt count only skips
// payment.expired events whose reason is "superseded"; a code voided by a
// method change carries reason "method_changed" and is counted. Three method
// changes (four codes) plus the last code's expiry therefore reach the cap
// and the order is voided "payment_attempts_exhausted" instead of
// "retry_allowed". Test 2 passes before and after the fix: it guards that
// codes that really expired on their own still exhaust the attempts.
//
// Assumptions
// - The last code lapses by its provider-side expiry (expires_at moved into
//   the past, then the gateway poll answers expired, reason "gateway") and the payment.expired event is
//   delivered after LATE_PAYMENT_GRACE_MS, as in ws03-guest-va.test.ts and
//   order-payment-consumers.test.ts. The last code is a VA, so the QRIS hold
//   does not apply.
// - A method-change void writes payment.expired with reason "method_changed"
//   (asserted as a setup check, as ws03-guest-va.test.ts does).
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-969-kt3t1-method-change-attempts.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import {
  eventEnvelopeSchema,
  type EventEnvelope,
} from "@starter/shared/events";
import type { PaymentInstructions } from "@starter/shared/payment";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { LATE_PAYMENT_GRACE_MS } from "../services/qr-order-consumers.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GatewayPaymentMethod,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { pollPendingGatewayIntents } from "../services/payment.service.ts";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** Duitku-like double: QRIS, VA, e-wallet and card are all on. */
class DuitkuLikeGateway implements PaymentGatewayPort {
  readonly provider = "duitku";
  private sequence = 0;
  private readonly offered = [
    { method: "qris" as const, enabled: true, channels: [] },
    {
      method: "va" as const,
      enabled: true,
      channels: [
        { code: "BC", name: "BCA Virtual Account" },
        { code: "I1", name: "BNI Virtual Account" },
      ],
    },
    { method: "bank_transfer" as const, enabled: false, channels: [] },
    {
      method: "ewallet" as const,
      enabled: true,
      channels: [
        { code: "OV", name: "OVO" },
        { code: "DA", name: "DANA" },
      ],
    },
    {
      method: "card" as const,
      enabled: true,
      channels: [{ code: "VC", name: "Credit Card" }],
    },
  ];
  async health() {
    return { status: "available" as const };
  }
  async methods() {
    return this.offered;
  }
  async channels(_context: unknown, method?: GatewayPaymentMethod) {
    return (
      this.offered.find((entry) => entry.method === method)?.channels ?? []
    );
  }
  async createIntent(input: GatewayIntentRequest) {
    this.sequence += 1;
    const n = String(this.sequence).padStart(8, "0");
    const providerRef = `KT3A-${randomUUID()}`;
    const channels =
      this.offered.find((entry) => entry.method === input.method)?.channels ??
      [];
    const channel = channels.find((c) => c.code === input.channelCode);
    let instructions: unknown;
    if (input.method === "va")
      instructions = {
        method: "va",
        channelCode: input.channelCode ?? "BC",
        channelName: channel?.name ?? "BCA Virtual Account",
        virtualAccountNumber: `8809${n}`,
      };
    else if (input.method === "ewallet" || input.method === "card")
      instructions = {
        method: input.method,
        channelCode: input.channelCode ?? "VC",
        channelName: channel?.name ?? "Credit Card",
        paymentUrl: `https://pay.example.test/${providerRef}`,
      };
    else
      instructions = {
        method: "qris",
        qrPayload: `00020101021226KT3A${n}`,
        issuer: null,
      };
    return {
      providerRef,
      instructions: instructions as PaymentInstructions,
      expiresAt: input.expiresAt,
    };
  }
  /** providerRefs the provider now reports as expired. */
  readonly expired = new Set<string>();
  async getStatus(input: { providerRef: string }) {
    return {
      status: (this.expired.has(input.providerRef) ? "expired" : "pending") as
        "expired" | "pending",
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
}

let fx: HoldFixture;
const gw = new DuitkuLikeGateway();

beforeAll(async () => {
  fx = await holdFixture("qr-va-969-kt3t1-attempts");
  // E-wallet and card have no default route (fail closed): switch them on.
  for (const method of ["ewallet", "card"]) {
    await owner.query(
      `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
       VALUES ($1, NULL, $2, 'duitku', NULL, true, 'system:test')
       ON CONFLICT DO NOTHING`,
      [fx.tenant.tenantId, method],
    );
  }
  setPaymentGateway(gw); // after the fixture: it installs its own gateway
}, 180_000);
afterAll(async () => {
  setPaymentGateway(null);
  resetHoldPorts();
  await endPools();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

// ------------------------------------------------------------------- helpers

const payOrder = (
  guest: Guest,
  orderId: string,
  method: "va" | "ewallet" | "card",
  channel?: string,
) =>
  fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(channel === undefined ? {} : { bankCode: channel }),
    idempotencyKey: randomUUID(),
  });

async function open(
  guest: Guest,
  orderId: string,
  method: "va" | "ewallet" | "card",
  channel?: string,
): Promise<string> {
  const res = await payOrder(guest, orderId, method, channel);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function outbox(
  name: string,
  intentId: string,
): Promise<EventEnvelope[]> {
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox
      WHERE tenant_id = $1 AND event->>'name' = $2 AND event->'payload'->>'intentId' = $3
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, name, intentId],
  );
  return rows.map((row) => eventEnvelopeSchema.parse(row.event));
}

async function orderRow(orderId: string) {
  const { rows } = await owner.query<{
    status: string;
    void_reason: string | null;
  }>(
    "SELECT status, void_reason FROM orders WHERE tenant_id = $1 AND id = $2::uuid",
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!;
}

/**
 * The code lapses by its own expiry (5 minutes ago, past the grace). Returns its
 * payment.expired event and the moment after the late-payment grace.
 */
async function lapse(intentId: string) {
  // Every code of the bill is past its expiry and past the late-payment grace:
  // the order's window closes at the LATEST expiry of all its codes (a code
  // voided by a method change keeps its old, far expiry), so all must lapse.
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - interval '5 minutes'
      WHERE tenant_id = $1
        AND payment_link_id = (
          SELECT payment_link_id FROM payment_intents
           WHERE tenant_id = $1 AND id = $2)`,
    [fx.tenant.tenantId, intentId],
  );
  // A code the gateway issued is never expired locally (legend-3wpf): the
  // polling fallback asks the provider, which answers expired.
  const { rows } = await owner.query<{ provider_ref: string }>(
    "SELECT provider_ref FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [fx.tenant.tenantId, intentId],
  );
  gw.expired.add(rows[0]!.provider_ref);
  await pollPendingGatewayIntents(
    fx.context as ScopedTenantContext,
    new Date(Date.now() + 2 * 60 * 60_000),
  );
  const [expired] = await outbox("payment.expired", intentId);
  expect(expired, "the lapsed code wrote payment.expired").toBeDefined();
  // Past its own expiry the provider's expired answer is a timeout.
  expect(expired!.payload.reason, "a local timeout, not a method change").toBe(
    "timeout",
  );
  // A lapsed code the provider received is live until the provider answers
  // final (payment-live-code.ts): the provider says it is over.
  await owner.query(
    `UPDATE payment_intents SET provider_final_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [fx.tenant.tenantId, intentId],
  );
  // After the order's grace window (it also counts from the order placement).
  const afterGrace = new Date(Date.now() + LATE_PAYMENT_GRACE_MS + 60_000);
  return { expired: expired!, afterGrace };
}

function deliver(event: EventEnvelope, at: Date) {
  const context = fx.context as ScopedTenantContext;
  return withTenant(db, context, (tx) =>
    deliverOrderPaymentEvent(context, event, tx, at),
  );
}

// --------------------------------------------------------------------- tests

describe("legend-kt3t1 a method change is not a failed payment attempt", () => {
  it("legend-kt3t1 three method changes (VA -> e-wallet -> card -> VA), then the last code lapses and the grace passes: the order stays payable (retry_allowed), it is not voided payment_attempts_exhausted", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const one = await open(guest, order.id, "va", "BC");
    const two = await open(guest, order.id, "ewallet", "OV");
    const three = await open(guest, order.id, "card");
    const four = await open(guest, order.id, "va", "I1");
    // Setup check: each earlier code was voided by the method change.
    for (const voided of [one, two, three])
      expect(
        (await outbox("payment.expired", voided)).map((e) => e.payload.reason),
        "voided by the guest's method change",
      ).toEqual(["method_changed"]);

    const { expired, afterGrace } = await lapse(four);
    const dispatch = await deliver(expired, afterGrace);

    // Fails before the fix: the three method-changed codes are counted as
    // attempts, so with the lapsed fourth the cap of 3 is hit and the order is
    // voided with payment_attempts_exhausted.
    expect(dispatch).toEqual({ route: "qr", outcome: "retry_allowed" });
    const row = await orderRow(order.id);
    expect(row.status).toBe("awaiting_payment");
    expect(row.void_reason).toBeNull();
  });

  it("legend-kt3t1 two method changes then the last code lapses: still payable, the guest can open a new code", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    await open(guest, order.id, "va", "BC");
    await open(guest, order.id, "ewallet", "DA");
    const last = await open(guest, order.id, "card");

    const { expired, afterGrace } = await lapse(last);
    const dispatch = await deliver(expired, afterGrace);

    // Fails before the fix: 2 method-changed codes + the lapsed one = 3.
    expect(dispatch).toEqual({ route: "qr", outcome: "retry_allowed" });
    expect((await orderRow(order.id)).status).toBe("awaiting_payment");
    const again = await payOrder(guest, order.id, "va", "BC");
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  });

  it("legend-kt3t1 three codes that lapsed on their own (no method change) still exhaust the attempts: the order is voided payment_attempts_exhausted", async () => {
    // Guards against over-fixing: real failed attempts keep counting. Passes
    // before and after the fix.
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    let last: { expired: EventEnvelope; afterGrace: Date } | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = await open(guest, order.id, "va", "BC");
      last = await lapse(code);
    }

    const dispatch = await deliver(last!.expired, last!.afterGrace);

    expect(dispatch).toEqual({ route: "qr", outcome: "voided" });
    const row = await orderRow(order.id);
    expect(row.status).toBe("voided");
    expect(row.void_reason).toBe("payment_attempts_exhausted");
  });
});
