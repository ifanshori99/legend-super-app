// 1272 fee second opinion re-review P3-a: the VA that pays a swap difference
// carries the guest fee like any other guest VA, so it is issued only at the
// total the guest saw. A VA without that total is refused (409 FEE_CHANGED),
// nothing is issued; QRIS carries no fee and still works; the seen total is
// accepted. Written first: before the fix the VA was issued unpriced.
//
// Run: LEGEND_TEST_FILES="src/test/order-recovery-charge-fee-1272.test.ts" heavy pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantIdSchema, type ScopedTenantContext } from "@starter/shared/core";
import type { PaymentInstructions } from "@starter/shared/payment";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GuestFeeSchedule,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { grossUpGuestFee, guestFeeFor } from "../services/payment-guest-fee.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  PRICES,
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import { owner } from "./floor-test-helpers.ts";

const AMOUNT = 8_085;
const RATE = { bps: 0, flatIdr: 4_000 };
const FEE = grossUpGuestFee(AMOUNT, RATE);
const DIFFERENCE = PRICES.kopi - PRICES.roti;

/** Duitku-like double: VA and QRIS, the VA with a flat guest fee. */
class FeeGateway implements PaymentGatewayPort {
  readonly provider = "duitku";
  readonly created: GatewayIntentRequest[] = [];
  async health() {
    return { status: "available" as const };
  }
  async methods() {
    return [
      { method: "qris" as const, enabled: true, channels: [] },
      {
        method: "va" as const,
        enabled: true,
        channels: [{ code: "BC", name: "BCA Virtual Account" }],
      },
    ];
  }
  async channels(_context: unknown, method?: string) {
    return method === "va" ? [{ code: "BC", name: "BCA Virtual Account" }] : [];
  }
  async guestFeeSchedule(): Promise<GuestFeeSchedule> {
    return (method, channelCode, baseIdr) =>
      guestFeeFor({
        method,
        channelCode,
        baseIdr,
        rates: new Map([["BC", RATE]]),
        feeMethods: ["va"],
      });
  }
  async createIntent(input: GatewayIntentRequest) {
    this.created.push(input);
    const instructions: PaymentInstructions =
      input.method === "va"
        ? {
            method: "va",
            channelCode: "BC",
            channelName: "BCA Virtual Account",
            virtualAccountNumber: `8808${String(this.created.length).padStart(8, "0")}`,
          }
        : { method: "qris", qrPayload: "00020101021226K1R", issuer: null };
    return {
      providerRef: `K1R-${randomBytes(6).toString("hex")}`,
      instructions,
      expiresAt: input.expiresAt,
      feeQuoteIdr: input.guestFeeIdr ?? 0,
    };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
}

let w: World;
const gw = new FeeGateway();

beforeAll(async () => {
  w = await createWorld();
  setPaymentGateway(gw);
  await owner.query(
    `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
     VALUES ($1, NULL, 'va', 'duitku', NULL, true, 'system:test')
     ON CONFLICT DO NOTHING`,
    [w.tenant.tenantId],
  );
}, 120_000);

afterAll(async () => {
  await w.teardown();
});

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
  const events = await w.outboxRows("order_issue.resolved", issueId);
  const event = events[0]!.event;
  const context = contextOf(w.tenant.tenantId);
  await withTenant(db, context, async (tx) => {
    await deliverSwapKitchenEvent(context, event, tx);
    await deliverIssueChargeEvent(context, event, tx);
  });
  const { rows } = await owner.query<{ id: string }>(
    "SELECT id FROM order_issue_charges WHERE tenant_id = $1 AND order_issue_id = $2",
    [w.tenant.tenantId, issueId],
  );
  return { guest: order.guest as Guest, chargeId: rows[0]!.id };
}

function pay(guest: Guest, chargeId: string, body: Record<string, unknown>) {
  return agent(w.app)
    .post(
      `/api/table-sessions/${guest.sessionId}/issue-charges/${chargeId}/payments`,
    )
    .set("Host", w.tenant.hostname)
    .set("Authorization", `Bearer ${guest.token}`)
    .set(originHeader)
    .send({ idempotencyKey: randomUUID(), ...body });
}

describe("1272 re-review P3-a: the VA of a swap difference is price-locked", () => {
  it("a VA without the seen total is 409 FEE_CHANGED and nothing is issued; QRIS and the seen total work", async () => {
    const { guest, chargeId } = await openCharge();
    const before = gw.created.length;
    const missing = await pay(guest, chargeId, {
      method: "va",
      bankCode: "BC",
    });
    expect(missing.status, JSON.stringify(missing.body)).toBe(409);
    expect(missing.body.error.code).toBe("FEE_CHANGED");
    const stale = await pay(guest, chargeId, {
      method: "va",
      bankCode: "BC",
      expectedChargedIdr: AMOUNT,
    });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(stale.body.error.code).toBe("FEE_CHANGED");
    expect(gw.created).toHaveLength(before);

    const seen = await pay(guest, chargeId, {
      method: "va",
      bankCode: "BC",
      expectedChargedIdr: AMOUNT + FEE,
    });
    expect(seen.status, JSON.stringify(seen.body)).toBe(201);
    expect(gw.created.at(-1)).toMatchObject({ guestFeeIdr: FEE });

    const second = await openCharge();
    const qris = await pay(second.guest, second.chargeId, { method: "qris" });
    expect(qris.status, JSON.stringify(qris.body)).toBe(201);
  });
});
