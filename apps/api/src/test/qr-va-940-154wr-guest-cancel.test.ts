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
  seedLiveCode,
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
  payNotice,
  resetHoldPorts,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { pollPendingGatewayIntents } from "../services/payment.service.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** Provider double: records creates and cancels, can run code mid-create. */
class CancelWatchGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  readonly created: { providerRef: string; request: GatewayIntentRequest }[] =
    [];
  readonly cancels: GatewayCancelRequest[] = [];
  /** providerRef of every status read (the poll). */
  readonly statusReads: string[] = [];
  /** reference (intent id) the provider was given, per providerRef. */
  readonly references = new Map<string, string>();
  /** providerRefs the provider now reports as expired. */
  readonly expired = new Set<string>();
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
    this.references.set(providerRef, input.intentId);
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
  async getStatus(input: { providerRef: string; intentId?: string }) {
    this.statusReads.push(input.providerRef);
    // Like DOIT: an answer is about a code only when the reference matches.
    if (input.intentId !== this.references.get(input.providerRef))
      return {
        status: "pending" as const,
        providerRef: `OTHER-${input.providerRef}`,
        amountIdr: null,
      };
    if (this.expired.has(input.providerRef))
      return {
        status: "expired" as const,
        providerRef: input.providerRef,
        amountIdr: null,
      };
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
    this.statusReads.length = 0;
    this.references.clear();
    this.expired.clear();
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

/** Orphan rows (a refused code kept by the service) of a link, oldest first. */
async function orphansOf(tenantId: string, linkId: string) {
  const { rows } = await owner.query<{
    id: string;
    status: string;
    provider_ref: string | null;
    provider_final_at: Date | null;
    idempotency_key: string;
  }>(
    `SELECT id, status, provider_ref, provider_final_at, idempotency_key
       FROM payment_intents
      WHERE tenant_id = $1 AND payment_link_id = $2
        AND idempotency_key LIKE '%:orphan:%'
      ORDER BY created_at, id`,
    [tenantId, linkId],
  );
  return rows;
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
  it("legend-154wr whole-order token call: a hold opens during the provider call -> 409 QRIS_HOLD_ACTIVE, the new code is cancelled at the provider and kept as an orphan row, the held code is untouched", async () => {
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
    const refusedRef = gw.created[0]!.providerRef;
    // The code is stored as an orphan (failed, not final) even though the
    // cancel succeeds: a resolved cancel proves nothing (SO-889 P2-2). It is
    // never the answer to the guest.
    const orphans = await orphansOf(tenantId, b.linkId);
    expect(orphans, "one orphan row of the refused code").toHaveLength(1);
    expect(orphans[0]!.status).toBe("failed");
    expect(orphans[0]!.provider_ref).toBe(refusedRef);
    expect(orphans[0]!.provider_final_at).toBeNull();
    expect(await intentsOnLink(tenantId, b.linkId)).toEqual([orphans[0]!.id]);
    expect(
      await intentCount(tenantId),
      "the seeded held intent and the orphan were added",
    ).toBe(before + 2);

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

  it("legend-154wr split part VA: a hold opens during the provider call -> 409 QRIS_HOLD_ACTIVE in guest words, the new code is cancelled and kept as an orphan row", async () => {
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
      "the seeded held intent and the orphan were added",
    ).toBe(before + 2);
    const refusedRef = gw.created[0]!.providerRef;
    await vi.waitFor(
      () => expect(gw.cancels.map((c) => c.providerRef)).toEqual([refusedRef]),
      { timeout: 10_000, interval: 50 },
    );
  });

  it("legend-154wr the provider cancel fails: the guest still gets the original 409 QRIS_HOLD_ACTIVE (no 500) and the uncancelled code is kept as a dead row", async () => {
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
    // A refused code is kept as an orphan row whatever the cancel does, so a
    // late payment on it is found, never lost.
    const onLink = await orphansOf(tenantId, b.linkId);
    expect(onLink, "one orphan row for the uncancelled code").toHaveLength(1);
    expect(await intentCount(tenantId)).toBe(before + 2);
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

// Decision (coordinator, architect review): a code the provider made and the
// write refused is always kept as an orphan row (failed, provider_final_at NULL,
// random id, derived idempotency key) BEFORE the best-effort cancel. It uses the
// existing machinery of a failed code the provider may still honour: live until
// the provider is proven final, polled, and a paid answer settles an open bill
// once; a second payment (another code) falls on the closed-bill path and is
// parked. So nobody is paid twice and the outlet loses nothing.
describe("legend-154wr: a refused code is kept as an orphan row", () => {
  async function refusedWithFailedCancel() {
    gw.reset();
    const b = await bill();
    const tenantId = fx.tenant.tenantId;
    gw.cancelError = new Error("provider cancel unavailable");
    const seeded = openHoldWhenProviderIsCalled(b.orderUuid, b.order.totalIdr);
    const key = randomUUID();
    const refused = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(qrisBody(key));
    gw.onCreate = null;
    expect(seeded.intentId, "setup: hold opened mid-call").not.toBeNull();
    expectRefusal(refused, "QRIS_HOLD_ACTIVE");
    const orphans = await orphansOf(tenantId, b.linkId);
    expect(orphans, "one orphan row of the refused code").toHaveLength(1);
    return { b, key, seeded, orphanId: orphans[0]!.id, tenantId };
  }

  async function linkPaid(linkId: string) {
    const { rows } = await owner.query<{ paid: number }>(
      "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, linkId],
    );
    return rows[0]!.paid;
  }

  it("legend-154wr cancel fails -> the orphan is failed with provider_final_at NULL, the poll reads it, a retry with the same key gets the guard's 409 (never the orphan) and no second code is made", async () => {
    const { b, key, seeded, orphanId, tenantId } =
      await refusedWithFailedCancel();

    const orphan = await intentRow(tenantId, orphanId);
    expect(orphan.status).toBe("failed");
    expect(orphan.provider_final_at, "not final: still watched").toBeNull();
    expect(orphan.provider_ref).toBe(gw.created[0]!.providerRef);
    const [row] = await orphansOf(tenantId, b.linkId);
    expect(row!.idempotency_key).not.toBe(key);
    expect(row!.idempotency_key.length).toBeLessThanOrEqual(100);
    expect((await intentRow(tenantId, seeded.intentId!)).status).toBe(
      "pending",
    );

    // The poll reads the orphan like any failed code not yet final.
    gw.statusReads.length = 0;
    // `now` past the webhook grace, so the poll does not skip a new code.
    await pollPendingGatewayIntents(
      fx.context,
      new Date(Date.now() + 60 * 60_000),
    );
    expect(gw.statusReads).toContain(orphan.provider_ref);

    // Same key: no replay of the orphan; the original guard answers.
    const retry = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(qrisBody(key));
    expectRefusal(retry, "QRIS_HOLD_ACTIVE");
    expect(JSON.stringify(retry.body)).not.toContain(orphanId);
    expect(gw.created, "no second code at the provider").toHaveLength(1);
    expect(await orphansOf(tenantId, b.linkId)).toHaveLength(1);
  });

  it("legend-154wr a paid notice on the orphan while the bill is open settles it once; the other code paid after is parked, not paid twice", async () => {
    const { b, orphanId, tenantId } = await refusedWithFailedCancel();
    const total = b.order.totalIdr;

    await payNotice(fx, orphanId, total);
    expect((await intentRow(tenantId, orphanId)).status).toBe("paid");
    expect(await linkPaid(b.linkId), "bill paid exactly once").toBe(total);
    expect(await unallocatedFunds(fx, orphanId)).toEqual([]);

    // Another code of the same bill is paid too (a twin issued before): the
    // bill is already settled, so its money must not settle it a second time.
    const otherId = await asOwnerTenant(tenantId, (client) =>
      seedLiveCode(client, {
        tenantId,
        outletId: fx.tenant.outletId,
        linkId: b.linkId,
        amountIdr: total,
        method: "qris",
      }),
    );
    await payNotice(fx, otherId, total);
    expect(await linkPaid(b.linkId), "bill is not paid a second time").toBe(
      total,
    );
    const parked = await unallocatedFunds(fx, otherId);
    expect(parked, "the second payment is parked once").toHaveLength(1);
    expect(parked[0]!.amountIdr).toBe(total);
  });

  it("legend-154wr the orphan id is the reference the provider was given: the poll reads it with that reference, reaches the provider's final answer and the orphan stops blocking", async () => {
    const { b, orphanId, tenantId } = await refusedWithFailedCancel();
    const ref = gw.created[0]!.providerRef;
    // Webhooks and the poll find the intent by the reference sent to the
    // provider, so the orphan must carry exactly that id.
    expect(orphanId).toBe(gw.created[0]!.request.intentId);

    gw.expired.add(ref);
    await pollPendingGatewayIntents(
      fx.context,
      new Date(Date.now() + 2 * 60 * 60_000),
    );
    expect(gw.statusReads).toContain(ref);
    const orphan = await intentRow(tenantId, orphanId);
    expect(
      orphan.provider_final_at,
      "final once the provider says so",
    ).not.toBe(null);
    const { rows: stillLive } = await owner.query<{ id: string }>(
      `SELECT id FROM payment_intents
        WHERE tenant_id = $1 AND id = $2 AND provider_final_at IS NULL`,
      [tenantId, orphanId],
    );
    expect(stillLive).toEqual([]);
    expect(await linkPaid(b.linkId)).toBe(0);
  });

  it("legend-154wr a retry with the same key after the orphan is final reaches the write, hits the orphan's id and answers 409 CONFLICT (never 500)", async () => {
    const { b, key, seeded, orphanId, tenantId } =
      await refusedWithFailedCancel();
    // Clear every guard: the orphan is final, the held code is dead, the hold
    // is closed.
    await asOwnerTenant(tenantId, async (client) => {
      await client.query(
        `UPDATE payment_intents SET provider_final_at = now()
          WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
        [tenantId, [orphanId, seeded.intentId]],
      );
      await client.query(
        `UPDATE payment_intents SET status = 'expired'
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, seeded.intentId],
      );
      await client.query(
        `UPDATE pos_qris_holds SET state = 'closed', close_reason = 'provider_expired', closed_at = now()
          WHERE tenant_id = $1 AND order_id = $2`,
        [tenantId, b.orderUuid],
      );
    });
    gw.cancelError = null;
    const cancelsBefore = gw.cancels.length;
    const retry = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(qrisBody(key));
    expect(retry.status, JSON.stringify(retry.body)).toBe(409);
    expect(retry.body.error.code).toBe("CONFLICT");
    expect(
      gw.cancels.length,
      "the code of the winner row is not cancelled",
    ).toBe(cancelsBefore);
    expect(await orphansOf(tenantId, b.linkId)).toHaveLength(1);
  });

  it("legend-154wr IDEMPOTENCY_KEY_REUSED inside the write: nothing is kept and nothing is cancelled (the code belongs to the winner)", async () => {
    gw.reset();
    const b = await bill();
    const tenantId = fx.tenant.tenantId;
    const key = randomUUID();
    // Mid-call, another request commits an intent with the same key but another
    // method: the write finds it and refuses with IDEMPOTENCY_KEY_REUSED.
    gw.onCreate = async () => {
      await asOwnerTenant(tenantId, async (client) => {
        await client.query("SET LOCAL session_replication_role = 'replica'");
        const id = randomUUID();
        await client.query(
          `INSERT INTO payment_intents
             (id, tenant_id, outlet_id, payment_link_id, method, provider,
              provider_ref, amount_idr, idempotency_key, status, instructions,
              expires_at)
           VALUES ($1, $2, $3, $4, 'va', 'doit', $5, $6, $7, 'pending',
                   $8::jsonb, now() + interval '4 minutes')`,
          [
            id,
            tenantId,
            fx.tenant.outletId,
            b.linkId,
            `WINNER-${id}`,
            b.order.totalIdr,
            key,
            JSON.stringify({
              method: "va",
              channelCode: "bmri",
              channelName: "Mandiri",
              virtualAccountNumber: "8808123456789012",
            }),
          ],
        );
      });
    };

    const refused = await agent(fx.app)
      .post(`/api/payments/links/${b.token}/intents`)
      .send(qrisBody(key));
    gw.onCreate = null;

    expectRefusal(refused, "IDEMPOTENCY_KEY_REUSED");
    expect(gw.created, "setup: the provider made a code").toHaveLength(1);
    expect(await orphansOf(tenantId, b.linkId)).toEqual([]);
    expect(await intentsOnLink(tenantId, b.linkId)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gw.cancels, "nothing cancelled").toEqual([]);
  });
});
