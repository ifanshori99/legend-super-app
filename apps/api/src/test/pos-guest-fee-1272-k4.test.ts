// 1272 K4 (legend-osqou.59, design docs/design/duitku-fee-passthrough.md §3,
// §4, §7): the cashier's Duitku VA / e-wallet carries the guest service fee
// ("Biaya layanan") through the shared createIntent. Money rules under test
// ("jangan sampai rugi"):
// - payment options priced for a named order: each channel shows its fee and
//   the total the guest pays; a channel without a rate is left out (never fee
//   0); cash, QRIS and EDC carry fee 0. Without an order: no fee fields.
// - the tender books the BILL (amount_idr), never the charged amount: the fee
//   is not change, not overpayment, not shift cash.
// - a code paid after its tender was released parks only the bill: the fee is
//   withheld, never parked or refunded.
// - the refund cap of the paid intent is the bill (the fee is never refunded).
// - the code status, the customer display and the receipt show the fee and
//   the total paid; a code without a fee shows exactly what it did before.
//
// Run: LEGEND_TEST_FILES="src/test/pos-guest-fee-1272-k4.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  type OutletId,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import type { PaymentChannel } from "@starter/shared/payment";
import { customerDisplayStateSchema } from "@starter/shared/pos";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { readStateForDisplay } from "../services/customer-display.service.ts";
import { refundableBalance } from "../services/payment-admin.service.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
  type GuestFeeSchedule,
} from "../services/payment-gateway.ts";
import {
  grossUpGuestFee,
  guestFeeFor,
  type GuestFeeRate,
} from "../services/payment-guest-fee.ts";
import { getPosPaymentOptions } from "../services/pos-payment-options.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { paymentIntents } from "../db/schema/index.ts";
import { and, eq } from "drizzle-orm";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  HOLD_RELEASE_AFTER_MIN,
  ScriptedGateway,
  assertInvariants,
  capturedIdr,
  getQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  postRelease,
  refundsOfIntent,
  resetHoldPorts,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { captainPaymentFixture } from "./pos-captain-payment-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const BILL_IDR = 33_000;
const SUPERVISOR_PIN = "582914";
const EDC_TERMINAL_ID = randomUUID();
const METHODS = ["qris", "va", "bank_transfer", "ewallet", "card"] as const;
const CHANNELS = {
  // I1 has no rate: never offered at fee 0.
  va: [
    { code: "BC", name: "BCA Virtual Account" },
    { code: "I1", name: "BNI Virtual Account" },
  ],
  ewallet: [{ code: "OV", name: "OVO" }],
} as const;
const RATES: ReadonlyMap<string, GuestFeeRate> = new Map([
  ["BC", { bps: 0, flatIdr: 4_000 }],
  ["OV", { bps: 150, flatIdr: 0 }],
]);
const VA_FEE = grossUpGuestFee(BILL_IDR, RATES.get("BC")!);
const OVO_FEE = grossUpGuestFee(BILL_IDR, RATES.get("OV")!);

/** Duitku-like port with the shared gross-up as its fee schedule. */
class FeeGateway extends ScriptedGateway {
  feeMethods: string[] = ["va", "ewallet"];
  override async createIntent(input: GatewayIntentRequest) {
    const base = await super.createIntent(input);
    if (input.method === "va")
      return {
        ...base,
        instructions: {
          method: "va" as const,
          channelCode: input.channelCode ?? "",
          channelName: "BCA Virtual Account",
          virtualAccountNumber: "8808123456789012",
        },
      };
    if (input.method === "ewallet")
      return {
        ...base,
        instructions: {
          method: "ewallet" as const,
          channelCode: input.channelCode ?? "",
          channelName: "OVO",
          paymentUrl: "https://sandbox.duitku.com/topup/v2/pay?ref=K4",
        },
      };
    return base;
  }
  async methods() {
    return METHODS.map((method) => ({
      method,
      enabled: method === "qris" || method === "va" || method === "ewallet",
      channels:
        method === "va" || method === "ewallet" ? [...CHANNELS[method]] : [],
    }));
  }
  override async channels(
    _context?: unknown,
    method?: string,
  ): Promise<PaymentChannel[]> {
    return method === "va" || method === "ewallet" ? [...CHANNELS[method]] : [];
  }
  async guestFeeSchedule(): Promise<GuestFeeSchedule> {
    const feeMethods = [...this.feeMethods];
    return (method, channelCode, baseIdr) =>
      guestFeeFor({ method, channelCode, baseIdr, rates: RATES, feeMethods });
  }
}

type Fx = HoldFixture & { gateway: FeeGateway };
let fx: Fx;

beforeAll(async () => {
  const base = await captainPaymentFixture("k4-fee");
  const gateway = new FeeGateway("duitku");
  setPaymentGateway(gateway);
  for (const method of ["va", "ewallet"])
    await owner.query(
      `INSERT INTO payment_routing_rules (tenant_id, outlet_id, method, provider, fallback_provider, enabled, updated_by)
       VALUES ($1, NULL, $2, 'duitku', NULL, true, 'system:test')`,
      [base.tenant.tenantId, method],
    );
  // POS-07: a receipt prints the outlet address.
  await owner.query("UPDATE outlets SET address = $2 WHERE id = $1", [
    base.tenant.outletId,
    "Jl. Braga No. 12, Bandung",
  ]);
  await owner.query(
    `INSERT INTO payment_edc_terminals
       (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
        connection, ip_address, supported_methods, status)
     VALUES ($1, $2, $3, 'bca', 'TID-K4FEE', 'MID-K4FEE', 'Test EDC', 'lan',
             '10.0.0.8', ARRAY['card','qris'], 'active')`,
    [EDC_TERMINAL_ID, base.tenant.tenantId, base.tenant.outletId],
  );
  fx = { ...base, gateway };
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

async function orderStatus(orderId: string) {
  const read = await fx.get(`${fx.base}/${orderId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data.status as string;
}

async function issue(orderId: string, method: "va" | "ewallet") {
  const res = await fx.post(`${fx.base}/${orderId}/tenders`, {
    expectedStatus: await orderStatus(orderId),
    idempotencyKey: randomUUID(),
    method,
    channelCode: CHANNELS[method][0].code,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const tender = res.body.data.tender as {
    id: string;
    amountIdr: number;
    paymentIntentId: string;
    status: string;
  };
  const { rows } = await owner.query<{
    amount_idr: string;
    guest_fee_idr: string;
    charged_idr: string;
    provider_ref: string;
  }>(
    `SELECT amount_idr::text, guest_fee_idr::text, charged_idr::text, provider_ref
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, tender.paymentIntentId],
  );
  const intent = rows[0]!;
  return {
    tender,
    intentId: tender.paymentIntentId,
    providerRef: intent.provider_ref,
    intent: {
      amountIdr: Number(intent.amount_idr),
      guestFeeIdr: Number(intent.guest_fee_idr),
      chargedIdr: Number(intent.charged_idr),
    },
  };
}

function payCode(
  intentId: string,
  amountIdr: number,
  method: "va" | "ewallet",
  providerRef = `DK-${randomUUID()}`,
) {
  return payNotice(fx, intentId, amountIdr, new Date(), providerRef, {
    method,
  });
}

async function payParked(...args: Parameters<typeof payCode>) {
  try {
    return await payCode(...args);
  } catch (error) {
    const e = error as { code?: unknown; status?: unknown };
    if (e?.code === "CONFLICT" && e?.status === 409) return null;
    throw error;
  }
}

let supervisorUserId: string | null = null;
async function managerApproval(orderId: string, valueIdr: number) {
  const tenantContext = establishTenantContext({
    tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
    brandId: null,
    source: "session",
  });
  if (!supervisorUserId) {
    await owner.query(
      "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
      [fx.tenant.roleId, JSON.stringify(["pos.void.request"])],
    );
    const client = agent(fx.app);
    await signUp(client, "Manajer Biaya Kasir");
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Manajer Biaya Uji', false, NULL, $3, false, '["tenant"]')`,
      [
        roleId,
        fx.tenant.tenantId,
        JSON.stringify(["order.view", "pos.void.approve"]),
      ],
    );
    await owner.query(
      `INSERT INTO role_assignments
         (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
       VALUES ($1, $2, $3, 'tenant', NULL, now() - interval '1 minute', $2)`,
      [fx.tenant.tenantId, userId, roleId],
    );
    await setStaffPin(
      tenantContext,
      userId,
      { outletId: fx.tenant.outletId, userId },
      { pin: SUPERVISOR_PIN },
    );
    supervisorUserId = userId;
  }
  const { override } = await createPosOverride(
    tenantContext,
    fx.staff.userId,
    {
      outletId: fx.tenant.outletId,
      action: "void",
      valueIdr,
      reason: "Tamu pindah ke tunai",
      objectType: "order",
      objectId: orderId,
      approval: {
        method: "supervisor_pin",
        approverUserId: userIdSchema.parse(supervisorUserId),
        pin: SUPERVISOR_PIN,
      },
    } as Parameters<typeof createPosOverride>[2],
    { idempotencyKey: randomUUID() },
  );
  expect(override.status).toBe("approved");
  return { approvedBy: supervisorUserId, overrideId: override.id as string };
}

/** Complete the paid order and issue its receipt; the document. */
async function receiptOf(orderId: string) {
  if ((await orderStatus(orderId)) === "awaiting_payment") {
    const read = await fx.get(`${fx.base}/${orderId}`);
    const items = read.body.data.items as { id: string }[];
    const fired = await fx.post(`${fx.base}/${orderId}/fire`, {
      expectedStatus: "awaiting_payment",
      itemIds: items.map((item) => item.id),
      idempotencyKey: randomUUID(),
    });
    expect(fired.status, JSON.stringify(fired.body)).toBe(200);
  }
  const done = await fx.post(`${fx.base}/${orderId}/complete`, {
    expectedStatus: await orderStatus(orderId),
    idempotencyKey: randomUUID(),
  });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  const issued = await fx.post(`${fx.base}/${orderId}/receipts`, {
    deliveries: ["print"],
    idempotencyKey: randomUUID(),
  });
  expect(issued.status, JSON.stringify(issued.body)).toBeLessThan(300);
  return issued.body.data.document as Record<string, unknown> & {
    totalIdr: number;
    tenders: unknown[];
  };
}

/** A customer display paired to a fresh terminal, showing `orderId`. */
async function displayShowing(orderId: string) {
  const terminalId = randomUUID();
  const displayId = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
      [fx.tenant.tenantId],
    );
    for (const [id, type] of [
      [terminalId, "pos"],
      [displayId, "display"],
    ] as const)
      await client.query(
        `INSERT INTO devices (id, tenant_id, outlet_id, type, label, token_issued_at)
         VALUES ($1, $2, $3, $4, 'K4 Uji', now() - interval '1 minute')`,
        [id, fx.tenant.tenantId, fx.tenant.outletId, type],
      );
    await client.query(
      `INSERT INTO customer_display_pairings (tenant_id, outlet_id, terminal_device_id, display_device_id, paired_by)
       VALUES ($1, $2, $3, $4, 'system:test')`,
      [fx.tenant.tenantId, fx.tenant.outletId, terminalId, displayId],
    );
    await client.query(
      `INSERT INTO customer_display_sessions (tenant_id, terminal_device_id, outlet_id, selected_order_id, version)
       VALUES ($1, $2, $3, $4, 1)`,
      [fx.tenant.tenantId, terminalId, fx.tenant.outletId, ulidToUuid(orderId)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return customerDisplayStateSchema.parse(
    await readStateForDisplay(
      establishTenantContext({
        tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
        brandId: null,
        source: "session",
      }),
      fx.tenant.outletId as OutletId,
      displayId,
    ),
  );
}

describe("1272 K4 cashier guest service fee", () => {
  it("options priced for an order: each channel shows its fee and total, an unrated channel is left out, cash and QRIS carry fee 0; no order, no fee fields", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const outletId = fx.tenant.outletId as OutletId;
    const priced = await getPosPaymentOptions(
      fx.context,
      outletId,
      { deviceId: null },
      order.id,
    );
    const by = (rows: typeof priced, method: string) =>
      rows.methods.find((row) => row.method === method);
    expect(by(priced, "va")).toMatchObject({
      enabled: true,
      channels: [
        {
          code: "BC",
          name: "BCA Virtual Account",
          guestFeeIdr: VA_FEE,
          totalIdr: BILL_IDR + VA_FEE,
        },
      ],
    });
    expect(by(priced, "ewallet")?.channels).toEqual([
      {
        code: "OV",
        name: "OVO",
        guestFeeIdr: OVO_FEE,
        totalIdr: BILL_IDR + OVO_FEE,
      },
    ]);
    expect(by(priced, "qris")).toMatchObject({
      enabled: true,
      guestFeeIdr: 0,
      totalIdr: BILL_IDR,
    });
    expect(VA_FEE).toBe(4_000);
    expect(OVO_FEE).toBeGreaterThan(0);

    const plain = await getPosPaymentOptions(fx.context, outletId, {
      deviceId: null,
    });
    expect(by(plain, "va")?.channels).toEqual([...CHANNELS.va]);
    for (const row of plain.methods) {
      expect(row).not.toHaveProperty("guestFeeIdr");
      expect(row).not.toHaveProperty("totalIdr");
    }

    // An order of another outlet (or unknown) is 404, never priced.
    await expect(
      getPosPaymentOptions(
        fx.context,
        outletId,
        { deviceId: null },
        "01JZZZZZZZZZZZZZZZZZZZZZZZ",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("VA with a fee: the tender, the hold and the captured amount are the bill; Duitku charges bill + fee; no change, no parked money, refundable = bill only", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const va = await issue(order.id, "va");
    expect(va.tender).toMatchObject({
      status: "authorized",
      amountIdr: BILL_IDR,
    });
    expect(va.intent).toEqual({
      amountIdr: BILL_IDR,
      guestFeeIdr: VA_FEE,
      chargedIdr: BILL_IDR + VA_FEE,
    });
    expect(fx.gateway.requests.at(-1)).toMatchObject({
      method: "va",
      amountIdr: BILL_IDR,
      guestFeeIdr: VA_FEE,
    });

    const status = await getQris(fx, order.id);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.data).toMatchObject({
      amountIdr: BILL_IDR,
      guestFeeIdr: VA_FEE,
      chargedIdr: BILL_IDR + VA_FEE,
    });
    const display = await displayShowing(order.id);
    expect(display.onlineCode).toMatchObject({
      amountIdr: BILL_IDR,
      guestFeeIdr: VA_FEE,
      chargedIdr: BILL_IDR + VA_FEE,
    });

    await payCode(va.intentId, BILL_IDR + VA_FEE, "va", va.providerRef);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    const tenders = await tenderStatuses(fx, order.id);
    expect(tenders.map((t) => t.status)).toEqual(["captured"]);
    const { rows } = await owner.query<{
      amount_idr: string;
      change_idr: string | null;
      received_idr: string | null;
    }>(
      `SELECT amount_idr::text, change_idr::text, received_idr::text
         FROM pos_order_tenders WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, va.tender.id],
    );
    expect(Number(rows[0]!.amount_idr)).toBe(BILL_IDR);
    expect(rows[0]!.change_idr).toBeNull();
    expect(await unallocatedFunds(fx, va.intentId)).toEqual([]);
    expect(await refundsOfIntent(fx, va.intentId)).toEqual([]);

    // §4: the fee is never refunded; the cap of the paid intent is the bill.
    const cap = await withTenant(db, fx.context, async (tx) => {
      const [intent] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, fx.context.tenant.tenantId),
            eq(paymentIntents.id, va.intentId),
          ),
        );
      return refundableBalance(tx, intent!);
    });
    // Duitku received bill + fee, but only the bill is ever refundable
    // (`paid` is capped at the intent's bill); the sale holds all of it.
    expect(Number(cap.paid)).toBe(BILL_IDR);
    expect(Number(cap.posSaleInUse)).toBe(BILL_IDR);
    expect(Number(cap.cap)).toBe(0);
    await assertInvariants(fx, order.id);

    // The receipt prints the fee after the order total; totals stay the order.
    const doc = await receiptOf(order.id);
    expect(doc.totalIdr).toBe(BILL_IDR);
    expect(doc.tenders).toEqual([
      expect.objectContaining({ method: "va", amountIdr: BILL_IDR }),
    ]);
    expect(doc.guestFeeIdr).toBe(VA_FEE);
    // The total paid is the server's figure: total + fee.
    expect(doc.paidTotalIdr).toBe(BILL_IDR + VA_FEE);
  });

  it("the old VA paid after a release parks only the bill: the fee is withheld, never parked or refunded", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const va = await issue(order.id, "va");
    expect((await postCancel(fx, order.id)).status).toBe(202);
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 minute'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, va.intentId, HOLD_RELEASE_AFTER_MIN + 1],
    );
    const released = await postRelease(
      fx,
      order.id,
      await managerApproval(order.id, BILL_IDR),
    );
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    const cash = await fx.post(`${fx.base}/${order.id}/tenders`, {
      expectedStatus: await orderStatus(order.id),
      idempotencyKey: randomUUID(),
      method: "cash",
      receivedIdr: 50_000,
    });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    // Cash change is of the bill only; the fee never touches the drawer.
    expect(cash.body.data.tender.changeIdr).toBe(50_000 - BILL_IDR);

    await payParked(va.intentId, BILL_IDR + VA_FEE, "va", va.providerRef);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    const parked = await unallocatedFunds(fx, va.intentId);
    expect(parked.map((row) => row.amountIdr)).toEqual([BILL_IDR]);
    expect(await refundsOfIntent(fx, va.intentId)).toEqual([]);
    await assertInvariants(fx, order.id);
  });

  it("a code without a fee: status, display and receipt exactly as before (no fee fields)", async () => {
    fx.gateway.feeMethods = [];
    try {
      const order = await newSubmittedOrder(fx, 0);
      const wallet = await issue(order.id, "ewallet");
      expect(wallet.intent).toEqual({
        amountIdr: BILL_IDR,
        guestFeeIdr: 0,
        chargedIdr: BILL_IDR,
      });
      const status = await getQris(fx, order.id);
      expect(status.body.data).not.toHaveProperty("guestFeeIdr");
      expect(status.body.data).not.toHaveProperty("chargedIdr");
      const display = await displayShowing(order.id);
      expect(display.onlineCode).toBeTruthy();
      expect(display.onlineCode).not.toHaveProperty("guestFeeIdr");
      await payCode(wallet.intentId, BILL_IDR, "ewallet", wallet.providerRef);
      expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
      const doc = await receiptOf(order.id);
      expect(doc).not.toHaveProperty("guestFeeIdr");
      expect(doc).not.toHaveProperty("paidTotalIdr");
    } finally {
      fx.gateway.feeMethods = ["va", "ewallet"];
    }
  });
  it("negative side: a fee code paid with the bill only, or any other amount, parks in full (AMOUNT_MISMATCH): no tender captured, nothing refunded by the POS", async () => {
    for (const paid of [
      BILL_IDR,
      BILL_IDR + VA_FEE - 1,
      BILL_IDR + VA_FEE + 1,
    ]) {
      const order = await newSubmittedOrder(fx, 0);
      const va = await issue(order.id, "va");
      expect(
        await payParked(va.intentId, paid, "va", va.providerRef),
      ).toBeNull();
      expect(await capturedIdr(fx, order.id)).toBe(0);
      expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual(
        ["authorized"],
      );
      const parked = await unallocatedFunds(fx, va.intentId);
      expect(parked.map((row) => row.amountIdr)).toEqual([paid]);
      expect(await refundsOfIntent(fx, va.intentId)).toEqual([]);
      await assertInvariants(fx, order.id);
    }
  });

  it("DP + a VA with a fee: the code prices the remaining bill; tender = remaining, fee on top; the receipt keeps DP and total apart from the fee", async () => {
    const DP = 10_000;
    const REMAINING = BILL_IDR - DP;
    const order = await newSubmittedOrder(fx, DP);
    const fee = grossUpGuestFee(REMAINING, RATES.get("BC")!);
    const options = await getPosPaymentOptions(
      fx.context,
      fx.tenant.outletId as OutletId,
      { deviceId: null },
      order.id,
    );
    expect(
      options.methods.find((row) => row.method === "va")?.channels?.[0],
    ).toMatchObject({
      code: "BC",
      guestFeeIdr: fee,
      totalIdr: REMAINING + fee,
    });
    const va = await issue(order.id, "va");
    expect(va.tender.amountIdr).toBe(REMAINING);
    expect(va.intent).toEqual({
      amountIdr: REMAINING,
      guestFeeIdr: fee,
      chargedIdr: REMAINING + fee,
    });
    await payCode(va.intentId, REMAINING + fee, "va", va.providerRef);
    expect(await capturedIdr(fx, order.id)).toBe(REMAINING);
    expect(await unallocatedFunds(fx, va.intentId)).toEqual([]);
    await assertInvariants(fx, order.id);
    const doc = await receiptOf(order.id);
    expect(doc).toMatchObject({
      totalIdr: BILL_IDR,
      depositAppliedIdr: DP,
      guestFeeIdr: fee,
      paidTotalIdr: BILL_IDR + fee,
    });
    expect(doc.tenders).toEqual([
      expect.objectContaining({ method: "va", amountIdr: REMAINING }),
    ]);
  });

  it("a fee VA paid late after a card sale closed its hold: the guest is refunded the bill only, the fee is never refunded; the card keeps the bill", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const va = await issue(order.id, "va");
    const read = await fx.get(`${fx.base}/${order.id}`);
    const number = read.body.data.number as string;
    const sale = randomUUID();
    await owner.query(
      `INSERT INTO edc_transactions
         (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
          request_fingerprint, amount_idr, method, status, type, mode, trace,
          approval_code, rrn, completed_at)
       VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', 'approved', 'sale', 'ecr',
               $8, 'APP123', $9, now())`,
      [
        sale,
        fx.tenant.tenantId,
        fx.tenant.outletId,
        EDC_TERMINAL_ID,
        number,
        randomUUID(),
        BILL_IDR,
        randomUUID().slice(0, 12),
        "RRN" + randomUUID().replace(/-/g, "").slice(0, 9),
      ],
    );
    const booked = await fx.post(`${fx.base}/${order.id}/tenders`, {
      method: "edc_card",
      expectedStatus: read.body.data.status as string,
      edcTransactionId: sale,
      idempotencyKey: randomUUID(),
    });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);

    await payParked(va.intentId, BILL_IDR + VA_FEE, "va", va.providerRef);
    // The bill stays paid once, by the card.
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    const refunded = (await refundsOfIntent(fx, va.intentId)).reduce(
      (sum, row) => sum + row.amountIdr,
      0,
    );
    // Refund = the bill (the refund cap of the intent); the fee stays.
    expect(refunded).toBe(BILL_IDR);
    expect(refunded).toBeLessThan(BILL_IDR + VA_FEE);
    // The fee is not refundable: of the BILL + fee Duitku received, the
    // refundable cap is the bill, and the refund took all of it.
    const balance = await withTenant(db, fx.context, async (tx) => {
      const [intent] = await tx
        .select()
        .from(paymentIntents)
        .where(
          and(
            eq(paymentIntents.tenantId, fx.context.tenant.tenantId),
            eq(paymentIntents.id, va.intentId),
          ),
        );
      return refundableBalance(tx, intent!);
    });
    expect(Number(balance.cap)).toBe(BILL_IDR);
    expect(Number(balance.reserved)).toBe(BILL_IDR);
    await assertInvariants(fx, order.id);
  });

  it("options and createIntent agree on the fee, flag on and flag off", async () => {
    const outletId = fx.tenant.outletId as OutletId;
    for (const feeMethods of [["va", "ewallet"], []]) {
      fx.gateway.feeMethods = feeMethods;
      try {
        const order = await newSubmittedOrder(fx, 0);
        const options = await getPosPaymentOptions(
          fx.context,
          outletId,
          { deviceId: null },
          order.id,
        );
        for (const method of ["va", "ewallet"] as const) {
          const channel = options.methods
            .find((row) => row.method === method)
            ?.channels?.find((row) => row.code === CHANNELS[method][0].code);
          expect(channel, `${method} ${feeMethods.length}`).toBeTruthy();
          const issued = await issue(order.id, method);
          expect(issued.intent.guestFeeIdr).toBe(channel!.guestFeeIdr);
          expect(issued.intent.chargedIdr).toBe(channel!.totalIdr);
          if (feeMethods.length === 0) {
            expect(channel).toMatchObject({
              guestFeeIdr: 0,
              totalIdr: BILL_IDR,
            });
          } else {
            expect(channel!.guestFeeIdr).toBeGreaterThan(0);
          }
          // Free the bill for the next method: the cashier releases the code.
          expect((await postCancel(fx, order.id)).status).toBe(202);
          await owner.query(
            `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 minute'
              WHERE tenant_id=$1 AND id=$2`,
            [fx.tenant.tenantId, issued.intentId, HOLD_RELEASE_AFTER_MIN + 1],
          );
          const released = await postRelease(
            fx,
            order.id,
            await managerApproval(order.id, BILL_IDR),
          );
          expect(released.status, JSON.stringify(released.body)).toBe(200);
        }
      } finally {
        fx.gateway.feeMethods = ["va", "ewallet"];
      }
    }
  });

  it("a fee code whose hold bill differs from the intent shows no instructions (P3-c)", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const va = await issue(order.id, "va");
    const shown = await getQris(fx, order.id);
    expect(shown.body.data.instructions).toBeTruthy();
    // The intent no longer matches the hold's bill: nothing is shown.
    await owner.query(
      `UPDATE payment_intents SET amount_idr = amount_idr - 1000
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, va.intentId],
    );
    const hidden = await getQris(fx, order.id);
    expect(hidden.status, JSON.stringify(hidden.body)).toBe(200);
    expect(hidden.body.data.instructions).toBeNull();
    expect(hidden.body.data).not.toHaveProperty("guestFeeIdr");
  });
});
