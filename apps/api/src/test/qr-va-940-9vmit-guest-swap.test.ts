// legend-9vmit (brief 940 / 9vmit, founder Q15): a guest who changes the payment
// method or bank on a bill (whole order or one split part) while a VA or bank
// transfer code is still live does NOT wait for the old code to expire and does
// NOT need staff approval. The old code is "voided" through the release queue
// (a payment_va_releases row of kind 'guest_method_change'), the old intent is
// marked expired locally, the provider is asked to cancel it (best effort), and
// a new code is issued. Exactly one code stays payable.
//
// Written from the brief and the public contract, not from the code. The new
// function `voidLiveCodesForMethodChange` is never named: every case goes
// through HTTP (guest table-session payments and the public token link). The
// only internals touched are SQL reads of payment_intents, bill_splits and the
// new release row.
//
// Assumptions:
// - Guest table-session API only offers `qris` and `va` (shared validator), so
//   bank_transfer is reached through the public token link
//   (POST /api/payments/links/:token/intents), which the brief says also sets
//   `guestMethodChange` for customer calls. The fake provider lists a
//   bank_transfer channel ("bca") and a second VA bank ("bnia") so a swap has a
//   target.
// - The provider answers "pending" (not paid) to every status read, with the
//   same providerRef, so the pre-void read is "not_paid" and fresh.
// - Release row: column names kind, status ('open'), reason, approved_by,
//   override_id (brief). released_by is not asserted (the brief leaves it
//   open for guest swaps).
// - Old intent after the swap: local status 'expired' (brief). provider_final_at
//   is not asserted.
// - "Only one live code" is checked as: exactly one intent on the bill (or
//   part) is still `pending` after the swap, and it is the new one.
// - Old QRIS code (hold) keeps today's behaviour. For a whole-order guest QRIS
//   the refusal code may be QRIS_HOLD_ACTIVE or ORDER_CODE_ACTIVE (a guest QR
//   has a hold row, the ws03 comment says so); for a split part it is exactly
//   SPLIT_CODE_ACTIVE (ORD-06-PAY-10, ek1wt).
// - Same method + same bank on the guest session path returns the pending
//   intent (replay) with a new idempotency key (ws03 test). The link path with
//   a new key and the same choice is NOT asserted (not defined by the brief).
// - Provider cancel is awaited or fire-and-forget: the tests wait for it
//   (vi.waitFor), never depend on timing.
// - Cashier-created links and QRIS holds opened by the cashier are not part of
//   this file.
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-940-9vmit-guest-swap.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { idr, type ScopedTenantContext } from "@starter/shared/core";
import type { PaymentInstructions } from "@starter/shared/payment";
import { agent } from "./helpers.ts";
import { endPools } from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  bindLinkToOrder,
  expectRefusal,
  intentCount,
  intentRow,
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

const BANK_NAMES: Record<string, string> = {
  bmri: "Mandiri",
  bnia: "CIMB Niaga",
  bca: "BCA",
};

/** Provider double: VA (two banks), bank transfer (one bank), QRIS. */
class SwapGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  readonly created: { providerRef: string; request: GatewayIntentRequest }[] =
    [];
  readonly cancels: GatewayCancelRequest[] = [];
  /** When set, cancel rejects with it. */
  cancelError: Error | null = null;
  private sequence = 0;
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
    this.sequence += 1;
    const n = String(this.sequence).padStart(8, "0");
    const providerRef = `S9V-${randomUUID()}`;
    this.created.push({ providerRef, request: input });
    const code = input.channelCode ?? "bmri";
    let instructions: PaymentInstructions;
    if (input.method === "va")
      instructions = {
        method: "va",
        channelCode: code,
        channelName: BANK_NAMES[code] ?? code,
        virtualAccountNumber: `8808${n}`,
      };
    else if (input.method === "bank_transfer")
      instructions = {
        method: "bank_transfer",
        channelCode: code,
        channelName: BANK_NAMES[code] ?? code,
        accountNumber: `7700${n}`,
        accountHolder: "PT Legend Test",
        uniqueCode: "123",
        transferTotalIdr: idr(input.amountIdr + 123),
      };
    else
      instructions = {
        method: "qris",
        qrPayload: `00020101021226S9V${n}`,
        issuer: null,
      };
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
    if (method === "va")
      return [
        { code: "bmri", name: "Mandiri" },
        { code: "bnia", name: "CIMB Niaga" },
      ];
    if (method === "bank_transfer") return [{ code: "bca", name: "BCA" }];
    return [];
  }
  reset() {
    this.created.length = 0;
    this.cancels.length = 0;
    this.cancelError = null;
  }
}

let fx: HoldFixture;
const gw = new SwapGateway();
beforeAll(async () => {
  fx = await holdFixture("qr-va-940-9vmit-swap");
  setPaymentGateway(gw);
}, 180_000);
afterAll(async () => {
  setPaymentGateway(null);
  resetHoldPorts();
  await endPools();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Method = "qris" | "va";

// ------------------------------------------------------------------ SQL reads

async function linkIdOf(intentId: string): Promise<string> {
  const { rows } = await owner.query<{ payment_link_id: string }>(
    "SELECT payment_link_id::text AS payment_link_id FROM payment_intents WHERE tenant_id = $1 AND id = $2",
    [fx.tenant.tenantId, intentId],
  );
  expect(rows, "setup: the intent exists").toHaveLength(1);
  return rows[0]!.payment_link_id;
}

/** Ids of intents still `pending` on a link (and part, when given). */
async function pendingOn(linkId: string, billSplitId: string | null = null) {
  const { rows } = await owner.query<{ id: string }>(
    `SELECT id::text AS id FROM payment_intents
      WHERE tenant_id = $1 AND payment_link_id = $2
        AND bill_split_id IS NOT DISTINCT FROM $3::uuid
        AND status = 'pending'
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, linkId, billSplitId],
  );
  return rows.map((row) => row.id);
}

async function releaseRows(intentId: string) {
  const { rows } = await owner.query<{
    kind: string;
    status: string;
    reason: string | null;
    approved_by: string | null;
    override_id: string | null;
  }>(
    `SELECT kind, status, reason, approved_by, override_id
       FROM payment_va_releases
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows;
}

async function releaseCount(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment_va_releases
      WHERE tenant_id = $1 AND payment_intent_id = $2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.n;
}

async function splitIntentId(billSplitId: string) {
  const { rows } = await owner.query<{ payment_intent_id: string | null }>(
    "SELECT payment_intent_id::text AS payment_intent_id FROM bill_splits WHERE tenant_id = $1 AND id = $2",
    [fx.tenant.tenantId, billSplitId],
  );
  return rows[0]!.payment_intent_id;
}

/** The old code is voided by the guest, not by staff: no approval, no override. */
async function expectGuestVoidRow(intentId: string) {
  const rows = await releaseRows(intentId);
  expect(rows, "one release row for the voided code").toHaveLength(1);
  const row = rows[0]!;
  expect(row.kind).toBe("guest_method_change");
  expect(row.status, "queue keeps asking the provider").toBe("open");
  expect(row.approved_by, "no staff approval").toBeNull();
  expect(row.override_id, "no supervisor override").toBeNull();
  expect(typeof row.reason).toBe("string");
  expect((row.reason ?? "").trim().length).toBeGreaterThan(0);
}

/** The provider is asked to cancel the voided code (best effort, awaited by us). */
async function expectCancelled(intentId: string) {
  const ref = (await intentRow(fx.tenant.tenantId, intentId)).provider_ref as
    string | null;
  expect(ref, "setup: the old code has a provider ref").not.toBeNull();
  await vi.waitFor(
    () =>
      expect(
        gw.cancels.map((cancel) => cancel.providerRef),
        "the voided code is cancelled at the provider",
      ).toContain(ref),
    { timeout: 10_000, interval: 50 },
  );
}

// -------------------------------------------------------------------- fixtures

/** Guest with a pay-first order, paid as a whole. */
async function wholeOrder() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  return { guest, order };
}

const payOrder = (
  guest: Guest,
  orderId: string,
  method: Method,
  bankCode?: string,
  idempotencyKey: string = randomUUID(),
) =>
  fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(bankCode === undefined ? {} : { bankCode }),
    idempotencyKey,
  });

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
  guest: Guest,
  partId: string,
  method: Method,
  bankCode?: string,
  idempotencyKey: string = randomUUID(),
) =>
  fx.guestPost(guest, "/payments", {
    target: { kind: "split", billSplitId: partId },
    method,
    payerSecret: secretFor(partId),
    ...(bankCode === undefined ? {} : { bankCode }),
    idempotencyKey,
  });

/** A bill with a public token (the /bayar/:token page). */
async function tokenBill() {
  const order = await newSubmittedOrder(fx, 0);
  const { token, linkId } = await bindLinkToOrder(fx, order);
  return { order, token, linkId };
}

const postLink = (
  token: string,
  method: "qris" | "va" | "bank_transfer",
  channelCode: string | null,
  idempotencyKey: string = randomUUID(),
) =>
  agent(fx.app)
    .post(`/api/payments/links/${token}/intents`)
    .send({ method, channelCode, idempotencyKey });

// ------------------------------------------------- whole order, guest session

describe("legend-9vmit whole order (guest table session): the guest changes bank or method", () => {
  it("legend-9vmit VA Mandiri -> VA CIMB: 201 with a new code, the old code is voided (release row guest_method_change, intent expired, provider cancel), one live code", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const first = await payOrder(guest, order.id, "va", "bmri");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const oldId = first.body.data.id as string;
    const linkId = await linkIdOf(oldId);
    const oldNumber = first.body.data.vaNumber as string;
    expect(await pendingOn(linkId)).toEqual([oldId]);

    const swapped = await payOrder(guest, order.id, "va", "bnia");

    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    expect(newId).not.toBe(oldId);
    expect(swapped.body.data).toMatchObject({
      target: { kind: "order", orderId: order.id },
      method: "va",
      status: "pending",
      amountIdr: order.totalIdr,
      bankCode: "bnia",
      bankName: "CIMB Niaga",
    });
    expect(swapped.body.data.vaNumber).toMatch(/^\d{8,20}$/);
    expect(swapped.body.data.vaNumber).not.toBe(oldNumber);

    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("expired");
    await expectGuestVoidRow(oldId);
    expect(await releaseCount(newId), "the new code is not released").toBe(0);
    expect(await pendingOn(linkId), "exactly one live code").toEqual([newId]);
    expect(gw.created, "one code per request").toHaveLength(2);
    await expectCancelled(oldId);
  });

  it("legend-9vmit VA -> QRIS: 201 with a QR, the VA is voided, one live code", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const first = await payOrder(guest, order.id, "va", "bmri");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const oldId = first.body.data.id as string;
    const linkId = await linkIdOf(oldId);

    const swapped = await payOrder(guest, order.id, "qris");

    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    expect(swapped.body.data).toMatchObject({
      method: "qris",
      status: "pending",
      amountIdr: order.totalIdr,
      vaNumber: null,
      bankCode: null,
    });
    expect(typeof swapped.body.data.qrisPayload).toBe("string");
    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("expired");
    await expectGuestVoidRow(oldId);
    expect(await pendingOn(linkId)).toEqual([newId]);
    await expectCancelled(oldId);
  });

  it("legend-9vmit after a swap, asking again for the new choice returns the new code (no third code) at the order total", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const first = await payOrder(guest, order.id, "va", "bmri");
    const oldId = first.body.data.id as string;
    const swapped = await payOrder(guest, order.id, "va", "bnia");
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);

    const old = await fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method: "va",
      bankCode: "bnia",
      idempotencyKey: randomUUID(),
    });
    // Asking again for the current choice returns the new code, not a third.
    expect(old.status, JSON.stringify(old.body)).toBeLessThan(300);
    expect(old.body.data.id).toBe(swapped.body.data.id);
    expect(old.body.data.id).not.toBe(oldId);
    expect(old.body.data.amountIdr).toBe(order.totalIdr);
    expect(gw.created, "no third code").toHaveLength(2);
  });

  it("legend-9vmit the provider cancel fails: the swap still succeeds (best effort) and the old code stays voided", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const first = await payOrder(guest, order.id, "va", "bmri");
    const oldId = first.body.data.id as string;
    const linkId = await linkIdOf(oldId);
    gw.cancelError = new Error("provider cancel unavailable");

    const swapped = await payOrder(guest, order.id, "va", "bnia");

    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    expect(JSON.stringify(swapped.body)).not.toContain(
      "provider cancel unavailable",
    );
    await expectGuestVoidRow(oldId);
    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("expired");
    expect(await pendingOn(linkId)).toEqual([swapped.body.data.id]);
    await vi.waitFor(
      () => expect(gw.cancels.length, "a cancel was attempted").toBe(1),
      { timeout: 10_000, interval: 50 },
    );
  });

  it("legend-9vmit control: the same method and bank again (new key) returns the pending code: no release row, no new provider code, no cancel", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const first = await payOrder(guest, order.id, "va", "bmri");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const id = first.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);

    const again = await payOrder(guest, order.id, "va", "bmri");

    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    expect(again.body.data.id).toBe(id);
    expect(again.body.data.vaNumber).toBe(first.body.data.vaNumber);
    expect(await releaseCount(id)).toBe(0);
    expect(gw.created, "no second code").toHaveLength(1);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gw.cancels, "nothing cancelled").toEqual([]);
    expect((await intentRow(fx.tenant.tenantId, id)).status).toBe("pending");
  });

  it("legend-9vmit control: an old QRIS code is NOT voided by a guest swap: QRIS -> VA is still refused 409, the QR stays pending, no release row, no provider call", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const qris = await payOrder(guest, order.id, "qris");
    expect(qris.status, JSON.stringify(qris.body)).toBe(201);
    const qrId = qris.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);
    const created = gw.created.length;

    const refused = await payOrder(guest, order.id, "va", "bmri");

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const code = (refused.body as { error?: { code?: string } }).error?.code;
    expect(["QRIS_HOLD_ACTIVE", "ORDER_CODE_ACTIVE"]).toContain(code);
    expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
      intents,
    );
    expect(gw.created.length, "no code asked from the provider").toBe(created);
    expect((await intentRow(fx.tenant.tenantId, qrId)).status).toBe("pending");
    expect(await releaseCount(qrId)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gw.cancels, "the QR is not cancelled").toEqual([]);
  });
});

// ------------------------------------------------------------ split part (guest)

describe("legend-9vmit split part (guest table session): the payer changes bank or method for one part", () => {
  it("legend-9vmit part VA Mandiri -> VA CIMB: 201, only this part's old code is voided, the part points to the new code, the other part is untouched", async () => {
    gw.reset();
    const { guest, parts } = await splitBill();
    const [p0, p1] = parts as [(typeof parts)[0], (typeof parts)[0]];
    const a = await payPart(guest, p0.id, "va", "bmri");
    const b = await payPart(guest, p1.id, "va", "bmri");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const oldId = a.body.data.id as string;
    const otherId = b.body.data.id as string;
    const linkId = await linkIdOf(oldId);

    const swapped = await payPart(guest, p0.id, "va", "bnia");

    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    expect(newId).not.toBe(oldId);
    expect(swapped.body.data).toMatchObject({
      target: { kind: "split", billSplitId: p0.id },
      method: "va",
      status: "pending",
      amountIdr: p0.amountIdr,
      bankCode: "bnia",
    });
    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("expired");
    await expectGuestVoidRow(oldId);
    expect(await pendingOn(linkId, p0.id), "one live code on the part").toEqual(
      [newId],
    );
    expect(await splitIntentId(p0.id)).toBe(newId);
    // The other part keeps its own live code, never released.
    expect((await intentRow(fx.tenant.tenantId, otherId)).status).toBe(
      "pending",
    );
    expect(await releaseCount(otherId)).toBe(0);
    expect(await splitIntentId(p1.id)).toBe(otherId);
    await expectCancelled(oldId);
  });

  it("legend-9vmit part VA -> QRIS: 201 with a QR for the part, the VA is voided", async () => {
    gw.reset();
    const { guest, parts } = await splitBill();
    const p0 = parts[0]!;
    const first = await payPart(guest, p0.id, "va", "bmri");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const oldId = first.body.data.id as string;
    const linkId = await linkIdOf(oldId);

    const swapped = await payPart(guest, p0.id, "qris");

    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    expect(swapped.body.data).toMatchObject({
      method: "qris",
      status: "pending",
      amountIdr: p0.amountIdr,
      vaNumber: null,
    });
    await expectGuestVoidRow(oldId);
    expect(await pendingOn(linkId, p0.id)).toEqual([swapped.body.data.id]);
    expect(await splitIntentId(p0.id)).toBe(swapped.body.data.id);
  });

  it("legend-9vmit control: the same VA and bank again for the part returns the pending code: no release row, no new provider code", async () => {
    gw.reset();
    const { guest, parts } = await splitBill();
    const p0 = parts[0]!;
    const first = await payPart(guest, p0.id, "va", "bmri");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const id = first.body.data.id as string;

    const again = await payPart(guest, p0.id, "va", "bmri");

    expect(again.status, JSON.stringify(again.body)).toBeLessThan(300);
    expect(again.body.data.id).toBe(id);
    expect(await releaseCount(id)).toBe(0);
    expect(gw.created, "no second code").toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gw.cancels).toEqual([]);
  });

  it("legend-9vmit control: an old QRIS code of a part is NOT voided: QRIS -> VA is still 409 SPLIT_CODE_ACTIVE, the QR stays pending, no release row", async () => {
    gw.reset();
    const { guest, parts } = await splitBill();
    const p0 = parts[0]!;
    const qris = await payPart(guest, p0.id, "qris");
    expect(qris.status, JSON.stringify(qris.body)).toBe(201);
    const qrId = qris.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);
    const created = gw.created.length;

    const refused = await payPart(guest, p0.id, "va", "bmri");

    expectRefusal(refused, "SPLIT_CODE_ACTIVE");
    expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
      intents,
    );
    expect(gw.created.length).toBe(created);
    expect((await intentRow(fx.tenant.tenantId, qrId)).status).toBe("pending");
    expect(await releaseCount(qrId)).toBe(0);
    expect(await splitIntentId(p0.id)).toBe(qrId);
  });
});

// ------------------------------------------- whole order, public token link

describe("legend-9vmit whole order (public token link): bank transfer and VA swaps", () => {
  it("legend-9vmit VA -> bank transfer: 201 with bank transfer instructions, the VA is voided (guest_method_change), one live code", async () => {
    gw.reset();
    const b = await tokenBill();
    const va = await postLink(b.token, "va", "bmri");
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    const oldId = va.body.data.id as string;
    expect(await pendingOn(b.linkId)).toEqual([oldId]);

    const swapped = await postLink(b.token, "bank_transfer", "bca");

    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    expect(newId).not.toBe(oldId);
    expect(swapped.body.data.method).toBe("bank_transfer");
    expect(swapped.body.data.status).toBe("pending");
    expect(swapped.body.data.amountIdr).toBe(b.order.totalIdr);
    expect(swapped.body.data.instructions).toMatchObject({
      method: "bank_transfer",
      channelCode: "bca",
    });
    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("expired");
    await expectGuestVoidRow(oldId);
    expect(await releaseCount(newId)).toBe(0);
    expect(await pendingOn(b.linkId)).toEqual([newId]);
    await expectCancelled(oldId);
  });

  it("legend-9vmit bank transfer -> VA: 201 with VA instructions, the transfer code is voided (guest_method_change), one live code", async () => {
    gw.reset();
    const b = await tokenBill();
    const transfer = await postLink(b.token, "bank_transfer", "bca");
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(201);
    const oldId = transfer.body.data.id as string;

    const swapped = await postLink(b.token, "va", "bnia");

    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const newId = swapped.body.data.id as string;
    expect(swapped.body.data.method).toBe("va");
    expect(swapped.body.data.instructions).toMatchObject({
      method: "va",
      channelCode: "bnia",
    });
    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("expired");
    await expectGuestVoidRow(oldId);
    expect(await pendingOn(b.linkId)).toEqual([newId]);
    await expectCancelled(oldId);
  });

  it("legend-9vmit VA -> other VA bank through the token: 201, old VA voided", async () => {
    gw.reset();
    const b = await tokenBill();
    const first = await postLink(b.token, "va", "bmri");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const oldId = first.body.data.id as string;

    const swapped = await postLink(b.token, "va", "bnia");

    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    expect(swapped.body.data.instructions).toMatchObject({
      method: "va",
      channelCode: "bnia",
    });
    await expectGuestVoidRow(oldId);
    expect(await pendingOn(b.linkId)).toEqual([swapped.body.data.id]);
  });

  it("legend-9vmit three changes in a row (VA -> bank transfer -> VA): each old code gets exactly one release row, the last one is the only live code, the amount never changes", async () => {
    gw.reset();
    const b = await tokenBill();
    const one = await postLink(b.token, "va", "bmri");
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    const two = await postLink(b.token, "bank_transfer", "bca");
    expect(two.status, JSON.stringify(two.body)).toBe(201);
    const three = await postLink(b.token, "va", "bnia");
    expect(three.status, JSON.stringify(three.body)).toBe(201);

    const ids = [one, two, three].map((r) => r.body.data.id as string);
    expect(new Set(ids).size, "three different codes").toBe(3);
    await expectGuestVoidRow(ids[0]!);
    await expectGuestVoidRow(ids[1]!);
    expect(await releaseCount(ids[2]!)).toBe(0);
    expect(await pendingOn(b.linkId)).toEqual([ids[2]]);
    for (const response of [one, two, three])
      expect(response.body.data.amountIdr).toBe(b.order.totalIdr);
  });

  it("legend-9vmit control: an old QRIS code on the token link is not voided: VA after a live QRIS is still refused 409 and the QR stays pending", async () => {
    gw.reset();
    const b = await tokenBill();
    const qris = await postLink(b.token, "qris", null);
    expect(qris.status, JSON.stringify(qris.body)).toBe(201);
    const qrId = qris.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);
    const created = gw.created.length;

    const refused = await postLink(b.token, "va", "bmri");

    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    const code = (refused.body as { error?: { code?: string } }).error?.code;
    expect(["QRIS_HOLD_ACTIVE", "ORDER_CODE_ACTIVE"]).toContain(code);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    expect(gw.created.length).toBe(created);
    expect((await intentRow(fx.tenant.tenantId, qrId)).status).toBe("pending");
    expect(await releaseCount(qrId)).toBe(0);
  });
});

// ------------------------------------------- same choice with a new key (link)

describe("legend-9vmit token link: the same method and bank again with a NEW key is not a swap", () => {
  // Assumption: on the token link the same choice with a new key keeps today's
  // answer, 409 ORDER_CODE_ACTIVE (brief: "perilaku lama"). Nothing is voided:
  // the live code stays live, no release row, no new intent, no provider call.
  it("legend-9vmit link VA bank X live, same VA bank X with a new key: 409, no release row, old code still pending, no new intent, no provider request; a different bank still swaps", async () => {
    gw.reset();
    const b = await tokenBill();
    const first = await postLink(b.token, "va", "bmri");
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const oldId = first.body.data.id as string;
    const intents = await intentCount(fx.tenant.tenantId);
    const created = gw.created.length;

    const again = await postLink(b.token, "va", "bmri", randomUUID());

    expectRefusal(again, "ORDER_CODE_ACTIVE");
    expect(await releaseCount(oldId), "nothing voided").toBe(0);
    expect((await intentRow(fx.tenant.tenantId, oldId)).status).toBe("pending");
    expect(
      await pendingOn(b.linkId),
      "the old code is still the live one",
    ).toEqual([oldId]);
    expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
      intents,
    );
    expect(gw.created.length, "no request to the provider").toBe(created);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gw.cancels, "nothing cancelled").toEqual([]);

    // Control: another bank on the same bill is a real swap.
    const swapped = await postLink(b.token, "va", "bnia");
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    await expectGuestVoidRow(oldId);
    expect(await pendingOn(b.linkId)).toEqual([swapped.body.data.id]);
  });
});

// ------------------------------------------- replay of a key stored for an old code

describe("legend-9vmit replaying a stored key must not void a newer live code", () => {
  // Assumption: "guest A" and "guest B" are two clients of the same table
  // session (the guest session API gives one session per order). K2 is sent by
  // B with the same choice as A's live code, so B gets A's code (I1) and K2's
  // stored answer points to I1. The status of the replay answer is not pinned
  // (stored answer or 409 are both fine); only that it is never a 5xx and that
  // it never voids the newer live code.
  it("legend-9vmit K2 answered with code I1, A swaps to another bank (I3, I1 voided), B replays K2: I3 is NOT voided, no new release row, I3 still pending, no new intent", async () => {
    gw.reset();
    const { guest, order } = await wholeOrder();
    const first = await payOrder(guest, order.id, "va", "bmri"); // A: K1 -> I1
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const i1 = first.body.data.id as string;
    const linkId = await linkIdOf(i1);

    const k2 = randomUUID();
    const sameChoice = await payOrder(guest, order.id, "va", "bmri", k2); // B: K2
    expect(sameChoice.status, JSON.stringify(sameChoice.body)).toBeLessThan(
      300,
    );
    expect(sameChoice.body.data.id, "B gets A's live code").toBe(i1);

    const swapped = await payOrder(guest, order.id, "va", "bnia"); // A: I3
    expect(swapped.status, JSON.stringify(swapped.body)).toBe(201);
    const i3 = swapped.body.data.id as string;
    expect(i3).not.toBe(i1);
    await expectGuestVoidRow(i1);
    expect(await pendingOn(linkId)).toEqual([i3]);
    const intents = await intentCount(fx.tenant.tenantId);
    const created = gw.created.length;
    await expectCancelled(i1);
    const i3Ref = (await intentRow(fx.tenant.tenantId, i3)).provider_ref as
      string | null;

    const replay = await payOrder(guest, order.id, "va", "bmri", k2); // B: K2 again

    expect(replay.status, JSON.stringify(replay.body)).toBeLessThan(500);
    expect(await releaseCount(i3), "the live code is not voided").toBe(0);
    expect((await intentRow(fx.tenant.tenantId, i3)).status).toBe("pending");
    expect(await pendingOn(linkId), "I3 stays the only live code").toEqual([
      i3,
    ]);
    expect(
      await releaseRows(i1),
      "I1 keeps its single release row",
    ).toHaveLength(1);
    expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
      intents,
    );
    expect(gw.created.length, "no new code at the provider").toBe(created);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      gw.cancels.map((cancel) => cancel.providerRef),
      "I3 is never cancelled",
    ).not.toContain(i3Ref);
  });
});
