// legend-154wr (brief 940, card A): two leftovers of the guest code guard.
//
//   1. A guest who asks for a code for a bill PART (split) while a QR hold
//      blocks it gets 409 QRIS_HOLD_ACTIVE in GUEST words, not the cashier
//      sentence ("... sebelum menerima pembayaran lain").
//   2. When the provider already made a code but the final check inside the
//      write refuses (a hold appeared in between), the code must not be left
//      alive at the provider: the service asks the provider to cancel it,
//      answers the original 409, and stores no intent. If the cancel itself
//      fails the guest still gets the original 409 (never a 500) and no
//      intent is stored.
//
// Written from the brief and the public payment contract, not from the code.
//
// Assumptions:
// - Error body shape: { error: { code, message } } (as the other 912 tests).
// - Guest wording: the message says the other QR "masih bisa dibayar" (the
//   wording already used for guests by the order-level guard) and does not use
//   the cashier sentence. The exact text is not pinned.
// - "Cancel at the provider" means PaymentGatewayPort.cancel is called once
//   with the providerRef the provider returned for the refused code. Whether the
//   cancel is awaited before the 409 answer is not assumed: the test waits for
//   it (vi.waitFor), so it never depends on timing.
// - A hold opened during the provider call is simulated by seeding it from
//   the gateway's createIntent (FK triggers skipped for the seed only, same as
//   the ek1wt test for recovery charges).
// - NOT asserted (rule not defined in the brief): what a later webhook or poll
//   does with money paid on a code whose cancel failed. Reported to the lead.
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-940-154wr-guest-cancel.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid, type ScopedTenantContext } from "@starter/shared/core";
import type { PaymentInstructions } from "@starter/shared/payment";
import { agent } from "./helpers.ts";
import { asOwnerTenant, endPools } from "./facility-breakfast-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  bindLinkToOrder,
  expectRefusal,
  holdStates,
  intentCount,
  intentRow,
  intentsOnLink,
  qrisBody,
  seedHeldCode,
  vaBody,
} from "./qr-va-912-3p1-helpers.ts";
import {
  setPaymentGateway,
  type GatewayCancelRequest,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import {
  holdFixture,
  newSubmittedOrder,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** Provider double: records creates and cancels, can run code mid-create. */
class CancelWatchGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  readonly created: { providerRef: string; request: GatewayIntentRequest }[] =
    [];
  readonly cancels: GatewayCancelRequest[] = [];
  /** Runs inside createIntent, before it answers (a hold appears mid-call). */
  onCreate: (() => Promise<void>) | null = null;
  /** When set, cancel rejects with it. */
  cancelError: Error | null = null;
  readonly cancel = async (
    _context: ScopedTenantContext,
    intent: GatewayCancelRequest,
  ) => {
    this.cancels.push(intent);
    if (this.cancelError) throw this.cancelError;
  };
  async health() {
    return { status: "available" as const };
  }
  async createIntent(input: GatewayIntentRequest) {
    await this.onCreate?.();
    const providerRef = `A940-${randomUUID()}`;
    this.created.push({ providerRef, request: input });
    const instructions: PaymentInstructions =
      input.method === "va"
        ? {
            method: "va",
            channelCode: input.channelCode ?? "bmri",
            channelName: "Mandiri",
            virtualAccountNumber: "8808123456789012",
          }
        : { method: "qris", qrPayload: "00020101021226A940QR", issuer: null };
    return { providerRef, instructions, expiresAt: input.expiresAt };
  }
  async getStatus(input: { providerRef: string }) {
    return {
      status: "pending" as const,
      providerRef: input.providerRef,
      amountIdr: null,
    };
  }
  async channels(_context: unknown, method?: string) {
    return method === "va" ? [{ code: "bmri", name: "Mandiri" }] : [];
  }
  reset() {
    this.created.length = 0;
    this.cancels.length = 0;
    this.onCreate = null;
    this.cancelError = null;
  }
}

let fx: HoldFixture;
const gw = new CancelWatchGateway();
beforeAll(async () => {
  fx = await holdFixture("qr-va-940-154wr");
  setPaymentGateway(gw);
}, 180_000);
afterAll(async () => {
  setPaymentGateway(null);
  resetHoldPorts();
  await endPools();
});

/** A bill with a whole-order link and a token. */
async function bill() {
  const order = await newSubmittedOrder(fx, 0);
  const { token, linkId } = await bindLinkToOrder(fx, order);
  return { order, orderUuid: ulidToUuid(order.id), token, linkId };
}

async function splitBill() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const split = await fx.guestPost(guest, "/splits", {
    method: "equal",
    parts: 2,
    idempotencyKey: randomUUID(),
  });
  expect(split.status, JSON.stringify(split.body)).toBe(201);
  const parts = split.body.data.splits as { id: string; amountIdr: number }[];
  return { guest, order, parts };
}

const payPart = (
  guest: Awaited<ReturnType<typeof splitBill>>["guest"],
  partId: string,
  method: "qris" | "va",
) =>
  fx.guestPost(guest, "/payments", {
    target: { kind: "split", billSplitId: partId },
    method,
    payerSecret: secretFor(partId),
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey: randomUUID(),
  });

/** Seeds an open QRIS hold on the order from inside the provider call. */
function openHoldWhenProviderIsCalled(orderUuid: string, amountIdr: number) {
  const seeded: { intentId: string | null } = { intentId: null };
  gw.onCreate = async () => {
    const tenantId = fx.tenant.tenantId;
    const held = await asOwnerTenant(tenantId, async (client) => {
      // The write that follows may hold the order row: cap any lock wait, and
      // skip FK triggers for this seed only (test owner is a superuser).
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      return seedHeldCode(client, {
        tenantId,
        outletId: fx.tenant.outletId,
        orderUuid,
        amountIdr,
      });
    });
    seeded.intentId = held.intentId;
  };
  return seeded;
}

function messageOf(response: { body: unknown }): string {
  const message = (response.body as { error?: { message?: unknown } }).error
    ?.message;
  expect(typeof message, JSON.stringify(response.body)).toBe("string");
  return message as string;
}

/** Guest words: not the cashier sentence, says the other QR can still be paid. */
function expectGuestWords(response: { body: unknown }) {
  const message = messageOf(response);
  expect(message).not.toMatch(/menerima pembayaran/i);
  expect(message).not.toMatch(/dikonfirmasi penyedia/i);
  expect(message).toMatch(/masih bisa dibayar/i);
}

describe("legend-154wr: a split part refused by a hold answers in guest words", () => {
  it("legend-154wr split part VA while a POS hold is open on the order: 409 QRIS_HOLD_ACTIVE in guest words, no new intent, no provider call", async () => {
    gw.reset();
    const { guest, order, parts } = await splitBill();
    const tenantId = fx.tenant.tenantId;
    await asOwnerTenant(tenantId, (client) =>
      seedHeldCode(client, {
        tenantId,
        outletId: fx.tenant.outletId,
        orderUuid: ulidToUuid(order.id),
        amountIdr: order.totalIdr,
      }),
    );
    const intents = await intentCount(tenantId);

    const refused = await payPart(guest, parts[1]!.id, "va");

    expectRefusal(refused, "QRIS_HOLD_ACTIVE");
    expectGuestWords(refused);
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
    expect(gw.created, "no code asked from the provider").toEqual([]);
  });

  it("legend-154wr split part VA while its own QR is final but its hold row is still open: 409 QRIS_HOLD_ACTIVE in guest words", async () => {
    gw.reset();
    const { guest, parts } = await splitBill();
    const tenantId = fx.tenant.tenantId;
    const part = parts[0]!;
    const qris = await payPart(guest, part.id, "qris");
    expect(qris.status, JSON.stringify(qris.body)).toBe(201);
    const intentId = qris.body.data.id as string;
    // Own code is dead at the provider, the hold row stays open until the hold
    // check job closes it (same assumption as the ek1wt test).
    await asOwnerTenant(tenantId, (client) =>
      client.query(
        `UPDATE payment_intents
            SET status = 'expired', provider_final_at = now(),
                expires_at = now() - interval '2 minutes'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, intentId],
      ),
    );
    const intents = await intentCount(tenantId);
    const created = gw.created.length;

    const refused = await payPart(guest, part.id, "va");

    expectRefusal(refused, "QRIS_HOLD_ACTIVE");
    expectGuestWords(refused);
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
    expect(gw.created.length, "no code asked from the provider").toBe(created);
  });
});

describe("legend-154wr: the final check refuses after the provider made a code", () => {
  it("legend-154wr whole-order token call: a hold opens during the provider call -> 409 QRIS_HOLD_ACTIVE, the new code is cancelled at the provider, no intent stored, the held code is untouched", async () => {
    gw.reset();
    const b = await bill();
    const tenantId = fx.tenant.tenantId;
    const seeded = openHoldWhenProviderIsCalled(b.orderUuid, b.order.totalIdr);
    const before = await intentCount(tenantId);

    const refused = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(qrisBody());
    gw.onCreate = null;

    expect(seeded.intentId, "setup: hold opened mid-call").not.toBeNull();
    expect(gw.created, "setup: the first check passed").toHaveLength(1);
    expectRefusal(refused, "QRIS_HOLD_ACTIVE");
    expect(await intentsOnLink(tenantId, b.linkId), "no intent stored").toEqual(
      [],
    );
    expect(
      await intentCount(tenantId),
      "only the seeded held intent was added",
    ).toBe(before + 1);

    const refusedRef = gw.created[0]!.providerRef;
    await vi.waitFor(
      () =>
        expect(
          gw.cancels.map((c) => c.providerRef),
          "the refused code is cancelled at the provider, exactly once",
        ).toEqual([refusedRef]),
      { timeout: 10_000, interval: 50 },
    );
    expect(gw.cancels[0]!.provider).toBe("doit");
    expect(gw.cancels[0]!.outletId).toBe(fx.tenant.outletId);

    // Nobody is charged twice: the held code stays the one live code.
    expect((await intentRow(tenantId, seeded.intentId!)).status).toBe(
      "pending",
    );
    expect(await holdStates(tenantId, b.orderUuid)).toEqual(["open"]);
  });

  it("legend-154wr split part VA: a hold opens during the provider call -> 409 QRIS_HOLD_ACTIVE in guest words, the new code is cancelled, no intent stored for the part", async () => {
    gw.reset();
    const { guest, order, parts } = await splitBill();
    const tenantId = fx.tenant.tenantId;
    const seeded = openHoldWhenProviderIsCalled(
      ulidToUuid(order.id),
      order.totalIdr,
    );
    const before = await intentCount(tenantId);

    const refused = await payPart(guest, parts[1]!.id, "va");
    gw.onCreate = null;

    expect(seeded.intentId, "setup: hold opened mid-call").not.toBeNull();
    expect(gw.created, "setup: the first check passed").toHaveLength(1);
    expectRefusal(refused, "QRIS_HOLD_ACTIVE");
    expectGuestWords(refused);
    expect(
      await intentCount(tenantId),
      "only the seeded held intent was added",
    ).toBe(before + 1);
    const refusedRef = gw.created[0]!.providerRef;
    await vi.waitFor(
      () =>
        expect(gw.cancels.map((c) => c.providerRef)).toEqual([refusedRef]),
      { timeout: 10_000, interval: 50 },
    );
  });

  it("legend-154wr the provider cancel fails: the guest still gets the original 409 QRIS_HOLD_ACTIVE (no 500) and no intent is stored", async () => {
    gw.reset();
    const b = await bill();
    const tenantId = fx.tenant.tenantId;
    gw.cancelError = new Error("provider cancel unavailable");
    const seeded = openHoldWhenProviderIsCalled(b.orderUuid, b.order.totalIdr);
    const before = await intentCount(tenantId);

    const refused = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(vaBody());
    gw.onCreate = null;

    expect(seeded.intentId, "setup: hold opened mid-call").not.toBeNull();
    expectRefusal(refused, "QRIS_HOLD_ACTIVE");
    expect(JSON.stringify(refused.body)).not.toContain(
      "provider cancel unavailable",
    );
    expect(await intentsOnLink(tenantId, b.linkId)).toEqual([]);
    expect(await intentCount(tenantId)).toBe(before + 1);
    await vi.waitFor(
      () => expect(gw.cancels.length, "a cancel was attempted").toBe(1),
      { timeout: 10_000, interval: 50 },
    );
    expect((await intentRow(tenantId, seeded.intentId!)).status).toBe(
      "pending",
    );
  });
});

describe("legend-154wr controls: a code that is stored is never cancelled", () => {
  it("legend-154wr a normal token call issues 201, stores the intent and cancels nothing", async () => {
    gw.reset();
    const b = await bill();

    const response = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(qrisBody());

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await intentsOnLink(fx.tenant.tenantId, b.linkId)).toEqual([
      response.body.data.id,
    ]);
    expect(gw.created).toHaveLength(1);
    // Short grace so a late cancel call would still show up.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gw.cancels, "nothing cancelled").toEqual([]);
  });

  it("legend-154wr the same idempotency key sent twice replays the first code: one provider code, one intent, no cancel", async () => {
    gw.reset();
    const b = await bill();
    const body = qrisBody(randomUUID());

    const first = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(body);
    const second = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(body);

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(gw.created, "one code at the provider").toHaveLength(1);
    expect(await intentsOnLink(fx.tenant.tenantId, b.linkId)).toEqual([
      first.body.data.id,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gw.cancels, "the live code is not cancelled").toEqual([]);
  });
});
