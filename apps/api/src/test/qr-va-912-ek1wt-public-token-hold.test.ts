// legend-ek1wt (SO 913 P1): every path that issues a QR code for an order goes
// through the QRIS hold guard. While the order has a QRIS hold that is open and
// whose code can still be paid, these paths must answer 409 QRIS_HOLD_ACTIVE:
//   - POST /api/payments/links/:token/intents   (token of an order's link)
//   - POST /api/payments/links/:token/intents/:intentId/refresh
//   - the order recovery charge payment (guest pays an issue charge)
// A refused call makes no provider call (no createIntent, no cancel), writes no
// new intent, and leaves the old code and the hold as they were. Control: the
// same calls with no hold still issue a code.
//
// Written from docs/briefs/912-3p1.md section legend-ek1wt (CTO decision) and the
// public payment contract (packages/shared/src/payment), not from the code.
//
// Setups:
//   A. POS bill. The hold is real (cashier QRIS tender through the hold fixture).
//      The order's public link is made with createPaymentLink and tied to the
//      order the way a pay-first order is (orders.payment_link_id).
//   B. Breakfast order. Real token from the pay endpoint. The hold is seeded.
//   C. Order recovery charge on a paid order. The hold is seeded.
//   D. Guest bill split paid by virtual account: another part's QRIS hold (it
//      belongs to its own part) does not block it; a POS hold on the whole order
//      (no bill split) does (409 QRIS_HOLD_ACTIVE). Ref: bill-split-pay.test.ts.
//   E. Round 2 (architect): a hold appears between the first check and the
//      write (recovery charge); a part asks VA while its own QR is expired but
//      still open; a whole-order link while a part holds a QR; a paid or closed
//      hold does not block.
//
// Assumptions:
// - Refusal is HTTP 409 and the body carries the code QRIS_HOLD_ACTIVE.
// - A seeded hold (B, C) is a row of pos_qris_holds in state 'open' with a
//   pending, unexpired QRIS intent, the same shape the backfill writes
//   (tender_id NULL). A hold for an order does not depend on how the order was
//   created.
// - Refresh mints a new code only when the previous intent already expired. The
//   refresh test seeds an `expired` intent on the order's link (no provider_ref).
//   Success of a refresh is any 2xx (the contract says "may mint").
// - E: a hold the provider has not settled is 'open' even after its intent's
//   expires_at passed (the hold check job closes it, not the clock). A whole
//   order link for an order that already has bill-split parts is refused with
//   the same 409 QRIS_HOLD_ACTIVE while a part holds a QR (the hold covers the
//   order, a part's hold blocks the whole-order code). A paid or closed hold
//   is seeded on its own link with a paid or expired intent.
// - Several files in one run share the pg pools, so pools are closed once, in the
//   top-level afterAll.
//
// Run: LEGEND_TEST_FILES="src/test/qr-va-912-ek1wt-public-token-hold.test.ts" heavy pnpm test
import { randomBytes, randomUUID } from "node:crypto";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  type OutletId,
  type ScopedTenantContext,
} from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import type { PaymentInstructions } from "@starter/shared/payment";
import { createApp } from "../app.ts";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverIssueChargeEvent } from "../services/order-recovery-charge.ts";
import { deliverSwapKitchenEvent } from "../services/order-recovery-swap-kitchen.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type PaymentGatewayPort,
} from "../services/payment-gateway.ts";
import { createPaymentLink } from "../services/payment.service.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import {
  asOwnerTenant,
  createBreakfastWorld,
  endPools,
  newMember,
  openIntent,
  payLink,
  placeOrder as placeBreakfastOrder,
  seedTicket,
  type BreakfastWorld,
} from "./facility-breakfast-helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, originHeader } from "./helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";
import {
  PRICES,
  createWorld,
  type Guest,
  type World,
} from "./order-recovery-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  readHold,
  resetHoldPorts,
  tenderStatuses,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

// ------------------------------------------------------------------ helpers

const tenantsToClose: string[] = [];

/** Gateway double that records every provider call (create and cancel). */
class CountingGateway implements PaymentGatewayPort {
  readonly provider = "doit";
  readonly requests: GatewayIntentRequest[] = [];
  readonly cancels: string[] = [];
  /** Runs inside createIntent, before it answers (E: a hold appears mid-call). */
  onCreate: (() => Promise<void>) | null = null;
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
    await this.onCreate?.();
    const instructions: PaymentInstructions = {
      method: "qris",
      qrPayload: "00020101021226EK1WTQR",
      issuer: null,
    };
    return {
      providerRef: `EK1WT-${randomUUID()}`,
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
  async channels() {
    return [];
  }
}

const qrisBody = () => ({
  method: "qris",
  channelCode: null,
  idempotencyKey: randomUUID(),
});

type Pg = Parameters<Parameters<typeof asOwnerTenant>[1]>[0];

/**
 * A pending, unexpired QRIS intent and an open hold for the order, as the
 * backfill writes them. The intent sits on `linkId` (a new link when omitted).
 */
async function seedHeldCode(
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
        `EK1-${linkId.slice(0, 8)}`,
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
      `ek1wt-${intentId}`,
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

async function intentRow(tenantId: string, intentId: string) {
  const { rows } = await owner.query(
    `SELECT status, provider_final_at, expires_at, provider_ref
       FROM payment_intents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, intentId],
  );
  return rows[0]!;
}

async function intentCount(tenantId: string) {
  const { rows } = await owner.query<{ n: string }>(
    "SELECT count(*) AS n FROM payment_intents WHERE tenant_id = $1",
    [tenantId],
  );
  return Number(rows[0]!.n);
}

async function holdStates(tenantId: string, orderUuid: string) {
  const { rows } = await owner.query<{ state: string }>(
    "SELECT state FROM pos_qris_holds WHERE tenant_id = $1 AND order_id = $2 ORDER BY state",
    [tenantId, orderUuid],
  );
  return rows.map((row) => row.state);
}

function expectHoldRefusal(response: { status: number; body: unknown }) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(JSON.stringify(response.body)).toContain("QRIS_HOLD_ACTIVE");
}

// ------------------------------------------------------- A. POS bill, real hold

describe("legend-ek1wt A: token of a POS bill with an open QRIS hold", () => {
  let fx: HoldFixture;
  let cancels: string[];
  beforeAll(async () => {
    fx = await holdFixture("qr-va-912-ek1wt-a");
    cancels = [];
    const port: PaymentGatewayPort = fx.gateway;
    port.cancel = async (_context, intent) => {
      cancels.push(intent.intentId);
    };
    setPaymentGateway(fx.gateway);
  }, 180_000);
  afterAll(() => {
    resetHoldPorts();
  });

  /** A submitted bill with a public link tied to it (token of the order). */
  async function bill(options: { held: boolean }) {
    const order = await newSubmittedOrder(fx, 0);
    const qr = options.held ? await issueQris(fx, order.id) : null;
    const opened = await createPaymentLink(
      fx.context,
      {
        outletId: fx.tenant.outletId as OutletId,
        reference: `EK1-${randomUUID().slice(0, 8)}`,
        tableLabel: "A03",
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
    return { order, qr, token: opened.token, linkId: opened.linkId };
  }

  /** An expired code on the link: what a guest refreshes. */
  async function expiredCodeOn(linkId: string, amountIdr: number) {
    const id = randomUUID();
    await owner.query(
      `INSERT INTO payment_intents
         (id, tenant_id, outlet_id, payment_link_id, method, provider,
          amount_idr, idempotency_key, status, instructions, expires_at)
       VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, 'expired', $7::jsonb,
               now() - interval '20 minutes')`,
      [
        id,
        fx.tenant.tenantId,
        fx.tenant.outletId,
        linkId,
        amountIdr,
        `ek1wt-${id}`,
        JSON.stringify({
          method: "qris",
          qrPayload: "00020101021226OLDQR",
          issuer: null,
        }),
      ],
    );
    return id;
  }

  it("legend-ek1wt POST links/:token/intents is refused 409 QRIS_HOLD_ACTIVE: no provider call, no new intent, old code not superseded, still payable", async () => {
    const { order, qr, token } = await bill({ held: true });
    const created = fx.gateway.requests.length;
    const intents = await intentCount(fx.tenant.tenantId);
    const before = await intentRow(fx.tenant.tenantId, qr!.intentId);
    expect(before.status).toBe("pending");

    for (const attempt of [1, 2]) {
      const refused = await agent(fx.app)
        .post(`/api/payments/links/${token}/intents`)
        .send(qrisBody());
      expectHoldRefusal(refused);
      expect(
        fx.gateway.requests.length,
        `attempt ${attempt}: no code asked from the provider`,
      ).toBe(created);
    }
    expect(cancels, "no cancel sent for the old code").toEqual([]);
    expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
      intents,
    );
    expect(
      await intentRow(fx.tenant.tenantId, qr!.intentId),
      "the old code is not superseded",
    ).toEqual(before);
    expect((await readHold(fx, order.id))?.state).not.toBe("closed");
    expect(
      (await tenderStatuses(fx, order.id)).map((t) => t.status),
    ).not.toContain("voided");

    // The old code is still collectible: the guest pays it and it captures once.
    await payNotice(
      fx,
      qr!.intentId,
      order.totalIdr,
      new Date(),
      qr!.providerRef!,
    );
    expect(await capturedIdr(fx, order.id)).toBe(order.totalIdr);
  });

  it("legend-ek1wt POST links/:token/intents/:intentId/refresh is refused 409 QRIS_HOLD_ACTIVE: no provider call, no new intent", async () => {
    const { order, qr, token, linkId } = await bill({ held: true });
    const expiredId = await expiredCodeOn(linkId, order.totalIdr);
    const created = fx.gateway.requests.length;
    const intents = await intentCount(fx.tenant.tenantId);
    const old = await intentRow(fx.tenant.tenantId, qr!.intentId);

    const refused = await agent(fx.app).post(
      `/api/payments/links/${token}/intents/${expiredId}/refresh`,
    );
    expectHoldRefusal(refused);
    expect(fx.gateway.requests.length).toBe(created);
    expect(cancels).toEqual([]);
    expect(await intentCount(fx.tenant.tenantId)).toBe(intents);
    expect(await intentRow(fx.tenant.tenantId, qr!.intentId)).toEqual(old);
  });

  it("legend-ek1wt control: no hold on the bill, the token still issues a code", async () => {
    const { token } = await bill({ held: false });
    const created = fx.gateway.requests.length;
    const issued = await agent(fx.app)
      .post(`/api/payments/links/${token}/intents`)
      .send(qrisBody());
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    expect(fx.gateway.requests.length).toBe(created + 1);
  });

  it("legend-ek1wt control: no hold on the bill, refresh of an expired code still mints a new one", async () => {
    const { order, token, linkId } = await bill({ held: false });
    const expiredId = await expiredCodeOn(linkId, order.totalIdr);
    const created = fx.gateway.requests.length;
    const refreshed = await agent(fx.app).post(
      `/api/payments/links/${token}/intents/${expiredId}/refresh`,
    );
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBeLessThan(300);
    expect(refreshed.body.data.id).not.toBe(expiredId);
    expect(fx.gateway.requests.length).toBe(created + 1);
  });
});

// ----------------------------------------------------- B. breakfast order token

describe("legend-ek1wt B: breakfast order token with an open QRIS hold", () => {
  let app: Express;
  let world: BreakfastWorld;
  let gateway: CountingGateway;
  beforeAll(async () => {
    app = createApp();
    world = await createBreakfastWorld(app);
    tenantsToClose.push(world.tenant.tenantId);
    gateway = new CountingGateway();
    setPaymentGateway(gateway);
  }, 180_000);
  afterAll(() => {
    setPaymentGateway(null);
  });

  async function breakfastBill(options: { held: boolean }) {
    const member = await newMember(world);
    const ticketId = await seedTicket(world, member);
    const order = await placeBreakfastOrder(world, member, ticketId);
    const token = await payLink(world, member, ticketId, order.id);
    const orderUuid = ulidToUuid(order.id);
    const { rows } = await owner.query<{ payment_link_id: string | null }>(
      "SELECT payment_link_id FROM orders WHERE tenant_id = $1 AND id = $2",
      [world.tenant.tenantId, orderUuid],
    );
    const linkId = rows[0]?.payment_link_id;
    expect(linkId, "the pay endpoint opened the order's link").toBeTruthy();
    const held = options.held
      ? await asOwnerTenant(world.tenant.tenantId, (client) =>
          seedHeldCode(client, {
            tenantId: world.tenant.tenantId,
            outletId: world.tenant.outletId,
            orderUuid,
            amountIdr: order.totalIdr,
            linkId: linkId!,
          }),
        )
      : null;
    return { order, orderUuid, token, held };
  }

  it("legend-ek1wt breakfast token: POST links/:token/intents is refused 409 QRIS_HOLD_ACTIVE: no provider call, no new intent, old code not superseded", async () => {
    const { orderUuid, token, held } = await breakfastBill({ held: true });
    const tenantId = world.tenant.tenantId;
    const created = gateway.requests.length;
    const cancelled = gateway.cancels.length;
    const intents = await intentCount(tenantId);
    const before = await intentRow(tenantId, held!.intentId);
    expect(before.status).toBe("pending");

    const refused = await agent(app)
      .post(`/api/payments/links/${token}/intents`)
      .set(world.headers)
      .send(qrisBody());
    expectHoldRefusal(refused);

    expect(gateway.requests.length).toBe(created);
    expect(gateway.cancels.length).toBe(cancelled);
    expect(await intentCount(tenantId)).toBe(intents);
    expect(await intentRow(tenantId, held!.intentId)).toEqual(before);
    expect(await holdStates(tenantId, orderUuid)).toEqual(["open"]);
  });

  it("legend-ek1wt control: breakfast order with no hold still gets a code from its token", async () => {
    const { token } = await breakfastBill({ held: false });
    const created = gateway.requests.length;
    await openIntent(world, token);
    expect(gateway.requests.length).toBe(created + 1);
  });
});

// ------------------------------------------------ C. order recovery charge pay

describe("legend-ek1wt C: order recovery charge payment with an open QRIS hold on the order", () => {
  let w: World;
  let gateway: CountingGateway;
  const DIFFERENCE = PRICES.kopi - PRICES.roti;
  beforeAll(async () => {
    w = await createWorld();
    tenantsToClose.push(w.tenant.tenantId);
    gateway = new CountingGateway();
  }, 180_000);

  const context = (): ScopedTenantContext =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(w.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );

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
    const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!
      .event;
    const ctx = context();
    await withTenant(db, ctx, async (tx) => {
      await deliverSwapKitchenEvent(ctx, event, tx);
      await deliverIssueChargeEvent(ctx, event, tx);
    });
    const { rows } = await owner.query<{ id: string; order_id: string }>(
      `SELECT id, order_id FROM order_issue_charges
        WHERE tenant_id = $1 AND order_issue_id = $2`,
      [w.tenant.tenantId, issueId],
    );
    expect(rows).toHaveLength(1);
    return { guest: order.guest, charge: rows[0]!, issueId };
  }

  function payCharge(guest: Guest, chargeId: string) {
    const client = agent(w.app);
    return client
      .post(
        `/api/table-sessions/${guest.sessionId}/issue-charges/${chargeId}/payments`,
      )
      .set("Host", w.tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader)
      .send({ method: "qris", idempotencyKey: randomUUID() });
  }

  it("legend-ek1wt recovery charge: paying the charge is refused 409 QRIS_HOLD_ACTIVE: no provider call, no new intent, charge has no intent", async () => {
    const { guest, charge, issueId } = await openCharge();
    const tenantId = w.tenant.tenantId;
    const held = await asOwnerTenant(tenantId, (client) =>
      seedHeldCode(client, {
        tenantId,
        outletId: w.tenant.outletId,
        orderUuid: charge.order_id,
        amountIdr: 33_000,
      }),
    );
    setPaymentGateway(gateway);
    const intents = await intentCount(tenantId);
    const before = await intentRow(tenantId, held.intentId);
    // A paid order may already carry a settled hold row of its own: compare the
    // holds before and after, and the seeded hold by its intent.
    const holdsBefore = await holdStates(tenantId, charge.order_id);

    const refused = await payCharge(guest, charge.id);
    expectHoldRefusal(refused);

    expect(gateway.requests, "no code asked from the provider").toEqual([]);
    expect(gateway.cancels).toEqual([]);
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
    expect(await intentRow(tenantId, held.intentId)).toEqual(before);
    const { rows } = await owner.query<{ payment_intent_id: string | null }>(
      `SELECT payment_intent_id FROM order_issue_charges
        WHERE tenant_id = $1 AND order_issue_id = $2`,
      [tenantId, issueId],
    );
    expect(rows[0]!.payment_intent_id).toBeNull();
    expect(
      await holdStates(tenantId, charge.order_id),
      "no hold row added, none changed",
    ).toEqual(holdsBefore);
    const seeded = await owner.query<{ state: string }>(
      "SELECT state FROM pos_qris_holds WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantId, held.intentId],
    );
    expect(seeded.rows.map((r) => r.state)).toEqual(["open"]);
  });

  it("legend-ek1wt control: a charge on an order with no hold still gets its code", async () => {
    const { guest, charge } = await openCharge();
    setPaymentGateway(gateway);
    const created = gateway.requests.length;
    const paid = await payCharge(guest, charge.id);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    expect(gateway.requests.length).toBe(created + 1);
  });
});

// ------------------------------------------------ D. split bill part paid by VA

/** A guest order cut into two equal parts. */
async function splitBillOf(fx: HoldFixture) {
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

const payPartOf = (
  fx: HoldFixture,
  guest: Awaited<ReturnType<typeof splitBillOf>>["guest"],
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

describe("legend-ek1wt D: guest split part paid by virtual account", () => {
  let fx: HoldFixture;
  beforeAll(async () => {
    fx = await holdFixture("qr-va-912-ek1wt-d");
    enableVaBank(fx.gateway);
    setPaymentGateway(fx.gateway);
  }, 180_000);
  afterAll(() => {
    resetHoldPorts();
  });

  const splitBill = () => splitBillOf(fx);
  const payPart = (
    guest: Awaited<ReturnType<typeof splitBillOf>>["guest"],
    partId: string,
    method: "qris" | "va",
  ) => payPartOf(fx, guest, partId, method);

  it("legend-ek1wt split part VA is issued 201 while another part of the bill holds a QRIS (a part's hold is its own)", async () => {
    const { guest, parts } = await splitBill();
    const qris = await payPart(guest, parts[0]!.id, "qris");
    expect(qris.status, JSON.stringify(qris.body)).toBe(201);

    const va = await payPart(guest, parts[1]!.id, "va");
    expect(va.status, JSON.stringify(va.body)).toBe(201);
    expect(va.body.data).toMatchObject({
      method: "va",
      status: "pending",
      amountIdr: parts[1]!.amountIdr,
      target: { kind: "split", billSplitId: parts[1]!.id },
    });
    expect(
      (await intentRow(fx.tenant.tenantId, qris.body.data.id)).status,
    ).toBe("pending");
  });

  it("legend-ek1wt split part VA is refused 409 QRIS_HOLD_ACTIVE while a POS hold (no bill split) is open on the order: no new intent", async () => {
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
    const created = fx.gateway.requests.length;

    const refused = await payPart(guest, parts[1]!.id, "va");
    expectHoldRefusal(refused);
    expect(await intentCount(tenantId), "no new intent").toBe(intents);
    expect(fx.gateway.requests.length, "no code asked from the provider").toBe(
      created,
    );
  });
});

// ------------------------------------------------------------- E. round 2

/** A hold row in a final state (paid or closed), on a link of its own. */
async function seedFinalHold(
  client: Pg,
  input: {
    tenantId: string;
    outletId: string;
    orderUuid: string;
    amountIdr: number;
    state: "paid" | "closed";
  },
) {
  const linkId = randomUUID();
  const intentId = randomUUID();
  await client.query(
    `INSERT INTO payment_links
       (id, tenant_id, outlet_id, token_hash, reference, subtotal_idr, total_idr, paid_idr, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 0, 'seed')`,
    [
      linkId,
      input.tenantId,
      input.outletId,
      randomBytes(32).toString("hex"),
      `EK1-${linkId.slice(0, 8)}`,
      input.amountIdr,
    ],
  );
  await client.query(
    `INSERT INTO payment_intents
       (id, tenant_id, outlet_id, payment_link_id, method, provider, provider_ref,
        amount_idr, idempotency_key, status, instructions, expires_at, paid_at)
     VALUES ($1, $2, $3, $4, 'qris', 'doit', $5, $6, $7, $8, $9::jsonb,
             now() - interval '10 minutes', $10)`,
    [
      intentId,
      input.tenantId,
      input.outletId,
      linkId,
      `FINAL-${intentId}`,
      input.amountIdr,
      `ek1wt-${intentId}`,
      input.state === "paid" ? "paid" : "expired",
      JSON.stringify({
        method: "qris",
        qrPayload: "00020101021226FINALQR",
        issuer: null,
      }),
      input.state === "paid" ? new Date() : null,
    ],
  );
  await client.query(
    `INSERT INTO pos_qris_holds
       (tenant_id, id, outlet_id, order_id, tender_id, payment_intent_id,
        amount_idr, backfilled, state, opened_at, opened_by, next_check_at,
        closed_at, close_reason)
     VALUES ($1, gen_random_uuid(), $2, $3, NULL, $4, $5, true, $6, now() - interval '20 minutes',
             NULL, NULL, now(), $7)`,
    [
      input.tenantId,
      input.outletId,
      input.orderUuid,
      intentId,
      input.amountIdr,
      input.state,
      input.state === "paid" ? "provider_paid" : "provider_expired",
    ],
  );
  return { intentId, linkId };
}

describe("legend-ek1wt E1: recovery charge, a hold appears after the first check passed", () => {
  let w: World;
  let gateway: CountingGateway;
  const DIFFERENCE = PRICES.kopi - PRICES.roti;
  beforeAll(async () => {
    w = await createWorld();
    tenantsToClose.push(w.tenant.tenantId);
    gateway = new CountingGateway();
  }, 180_000);
  afterAll(() => {
    gateway.onCreate = null;
    setPaymentGateway(null);
  });

  const context = (): ScopedTenantContext =>
    establishScopedTenantContext(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(w.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      { kind: "tenant" },
    );

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
    const event = (await w.outboxRows("order_issue.resolved", issueId))[0]!
      .event;
    const ctx = context();
    await withTenant(db, ctx, async (tx) => {
      await deliverSwapKitchenEvent(ctx, event, tx);
      await deliverIssueChargeEvent(ctx, event, tx);
    });
    const { rows } = await owner.query<{ id: string; order_id: string }>(
      `SELECT id, order_id FROM order_issue_charges
        WHERE tenant_id = $1 AND order_issue_id = $2`,
      [w.tenant.tenantId, issueId],
    );
    expect(rows).toHaveLength(1);
    return { guest: order.guest, charge: rows[0]!, issueId };
  }

  it("legend-ek1wt recovery charge: a hold opened during the provider call refuses the payment 409 QRIS_HOLD_ACTIVE and stores no intent for the charge", async () => {
    const { guest, charge, issueId } = await openCharge();
    const tenantId = w.tenant.tenantId;
    let seeded: { intentId: string; linkId: string } | null = null;
    gateway.onCreate = async () => {
      // The first check already passed: the order has no hold when we get here.
      // lock_timeout: a lock held by the service would otherwise hang the test.
      // The service holds the order row for the whole call, so a hold insert
      // would wait on its foreign key to the order: skip FK triggers for this
      // seed only (the test owner is a superuser) and cap any other lock wait.
      seeded = await asOwnerTenant(tenantId, async (client) => {
        await client.query("SET LOCAL lock_timeout = '5s'");
        await client.query("SET LOCAL session_replication_role = 'replica'");
        return seedHeldCode(client, {
          tenantId,
          outletId: w.tenant.outletId,
          orderUuid: charge.order_id,
          amountIdr: 33_000,
        });
      });
    };
    setPaymentGateway(gateway);
    const intents = await intentCount(tenantId);
    const created = gateway.requests.length;

    const refused = await agent(w.app)
      .post(
        `/api/table-sessions/${guest.sessionId}/issue-charges/${charge.id}/payments`,
      )
      .set("Host", w.tenant.hostname)
      .set("Authorization", `Bearer ${guest.token}`)
      .set(originHeader)
      .send({ method: "qris", idempotencyKey: randomUUID() });
    gateway.onCreate = null;

    expect(
      seeded,
      "the hold was opened during the provider call (setup)",
    ).not.toBeNull();
    expect(gateway.requests.length, "setup: the first check passed").toBe(
      created + 1,
    );
    expectHoldRefusal(refused);
    expect(
      await intentCount(tenantId),
      "only the seeded intent exists, nothing stored for the charge",
    ).toBe(intents + 1);
    const { rows } = await owner.query<{
      payment_intent_id: string | null;
      payment_link_id: string | null;
    }>(
      `SELECT payment_intent_id, payment_link_id FROM order_issue_charges
        WHERE tenant_id = $1 AND order_issue_id = $2`,
      [tenantId, issueId],
    );
    expect(rows[0]!.payment_intent_id).toBeNull();
    if (rows[0]!.payment_link_id) {
      const onLink = await owner.query<{ n: string }>(
        "SELECT count(*) AS n FROM payment_intents WHERE tenant_id = $1 AND payment_link_id = $2",
        [tenantId, rows[0]!.payment_link_id],
      );
      expect(Number(onLink.rows[0]!.n), "no intent on the charge's link").toBe(
        0,
      );
    }
    expect(
      (await intentRow(tenantId, seeded!.intentId)).status,
      "the held code is not superseded",
    ).toBe("pending");
    const hold = await owner.query<{ state: string }>(
      "SELECT state FROM pos_qris_holds WHERE tenant_id = $1 AND payment_intent_id = $2",
      [tenantId, seeded!.intentId],
    );
    expect(hold.rows.map((r) => r.state)).toEqual(["open"]);
  });
});

describe("legend-ek1wt E2: guest split bill, holds of a part and of the whole order", () => {
  let fx: HoldFixture;
  beforeAll(async () => {
    fx = await holdFixture("qr-va-912-ek1wt-e");
    enableVaBank(fx.gateway);
    setPaymentGateway(fx.gateway);
  }, 180_000);
  afterAll(() => {
    resetHoldPorts();
  });

  it("legend-ek1wt split part asks VA while its own QR is expired but its hold is still open: 409, no new intent", async () => {
    const { guest, parts } = await splitBillOf(fx);
    const part = parts[0]!;
    const qris = await payPartOf(fx, guest, part.id, "qris");
    expect(qris.status, JSON.stringify(qris.body)).toBe(201);
    const intentId = qris.body.data.id as string;
    // The code's time ran out and it is marked expired; the provider has not
    // said it is dead, so the hold stays open (a still-valid code would be
    // refused earlier with SPLIT_CODE_ACTIVE, not by the hold guard).
    await owner.query(
      "UPDATE payment_intents SET status = 'expired', expires_at = now() - interval '2 minutes' WHERE tenant_id = $1 AND id = $2",
      [fx.tenant.tenantId, intentId],
    );
    const hold = await owner.query<{ state: string }>(
      "SELECT state FROM pos_qris_holds WHERE tenant_id = $1 AND payment_intent_id = $2",
      [fx.tenant.tenantId, intentId],
    );
    expect(
      hold.rows.map((r) => r.state),
      "setup: the part's QR has an open hold",
    ).toEqual(["open"]);
    const intents = await intentCount(fx.tenant.tenantId);
    const created = fx.gateway.requests.length;

    const refused = await payPartOf(fx, guest, part.id, "va");
    // Assumption: the part's own pending QR is refused 409 either by the split
    // rule (SPLIT_CODE_ACTIVE: "the part's code is still valid") or by the hold
    // guard (QRIS_HOLD_ACTIVE); the brief asks for 409, not for one code.
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toMatch(
      /SPLIT_CODE_ACTIVE|QRIS_HOLD_ACTIVE/,
    );
    expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
      intents,
    );
    expect(fx.gateway.requests.length, "no code asked from the provider").toBe(
      created,
    );
    expect(
      (await intentRow(fx.tenant.tenantId, intentId)).status,
      "the old code is left as it was",
    ).toBe("expired");
  });

  it("legend-ek1wt whole-order link (no bill split) is refused 409 QRIS_HOLD_ACTIVE while a part of the bill holds a QR", async () => {
    const { guest, order, parts } = await splitBillOf(fx);
    const qris = await payPartOf(fx, guest, parts[0]!.id, "qris");
    expect(qris.status, JSON.stringify(qris.body)).toBe(201);
    const opened = await createPaymentLink(
      fx.context,
      {
        outletId: fx.tenant.outletId as OutletId,
        reference: `EK1-${randomUUID().slice(0, 8)}`,
        tableLabel: "A04",
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
    const intents = await intentCount(fx.tenant.tenantId);
    const created = fx.gateway.requests.length;

    const refused = await agent(fx.app)
      .post(`/api/payments/links/${opened.token}/intents`)
      .send(qrisBody());
    expectHoldRefusal(refused);
    expect(await intentCount(fx.tenant.tenantId), "no new intent").toBe(
      intents,
    );
    expect(fx.gateway.requests.length, "no code asked from the provider").toBe(
      created,
    );
  });
});

describe("legend-ek1wt E3: a paid or closed hold does not block a new code", () => {
  let app: Express;
  let world: BreakfastWorld;
  let gateway: CountingGateway;
  beforeAll(async () => {
    app = createApp();
    world = await createBreakfastWorld(app);
    tenantsToClose.push(world.tenant.tenantId);
    gateway = new CountingGateway();
    setPaymentGateway(gateway);
  }, 180_000);
  afterAll(() => {
    setPaymentGateway(null);
  });

  for (const state of ["paid", "closed"] as const) {
    it(`legend-ek1wt breakfast token: a ${state} hold on the order does not block, the code is issued 201`, async () => {
      const member = await newMember(world);
      const ticketId = await seedTicket(world, member);
      const order = await placeBreakfastOrder(world, member, ticketId);
      const token = await payLink(world, member, ticketId, order.id);
      const orderUuid = ulidToUuid(order.id);
      await asOwnerTenant(world.tenant.tenantId, (client) =>
        seedFinalHold(client, {
          tenantId: world.tenant.tenantId,
          outletId: world.tenant.outletId,
          orderUuid,
          amountIdr: order.totalIdr,
          state,
        }),
      );
      const created = gateway.requests.length;

      const issued = await agent(app)
        .post(`/api/payments/links/${token}/intents`)
        .set(world.headers)
        .send(qrisBody());
      expect(issued.status, JSON.stringify(issued.body)).toBe(201);
      expect(gateway.requests.length).toBe(created + 1);
    });
  }
});

// One cleanup for the whole file: the pools are shared by the three setups.
afterAll(async () => {
  setPaymentGateway(null);
  setTableSessionSettlementLookup(null);
  // Audit rows are append-only, so these tenants stay; give them a valid creator.
  for (const id of tenantsToClose)
    await owner.query("UPDATE tenants SET created_by = $2 WHERE id = $1", [
      id,
      randomUUID(),
    ]);
  await endPools();
});
