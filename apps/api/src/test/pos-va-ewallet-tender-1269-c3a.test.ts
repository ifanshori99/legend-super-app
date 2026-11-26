// 1269 C3a (legend-osqou.5): the cloud cashier takes VA and e-wallet through
// Duitku. A code opens the same hold as the cashier QRIS: one live code per
// bill, every other tender refused until the provider is proven final (Duitku
// raw `02` after the code lapsed), paid, or a manager released it. Money that
// arrives on a dead or released code is parked or refunded, never captured.
// Cloud only (founder no. 31): an edge process never offers or issues them.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  tenantIdSchema,
  ulidToUuid,
  userIdSchema,
  type OutletId,
} from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { setStaffPin } from "../services/device-pin.service.ts";
import {
  setPaymentGateway,
  type GatewayIntentRequest,
} from "../services/payment-gateway.ts";
import { getPosPaymentOptions } from "../services/pos-payment-options.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  HOLD_CLOSE_MARGIN_S,
  HOLD_RELEASE_AFTER_MIN,
  ScriptedGateway,
  assertInvariants,
  capturedIdr,
  getQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  postRelease,
  readHold,
  refundsOfIntent,
  resetHoldPorts,
  runHoldCheck,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { captainPaymentFixture } from "./pos-captain-payment-test-helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

const BILL_IDR = 33_000;
const SUPERVISOR_PIN = "582914";
const METHODS = ["qris", "va", "bank_transfer", "ewallet", "card"] as const;
const CHANNELS = {
  va: [{ code: "BC", name: "BCA Virtual Account" }],
  ewallet: [{ code: "OV", name: "OVO" }],
} as const;

/** Duitku-like port: lists methods and channels, issues VA / e-wallet codes. */
class OnlineGateway extends ScriptedGateway {
  listed = new Set<string>(["qris", "va", "ewallet"]);
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
          paymentUrl: "https://sandbox.duitku.com/topup/v2/pay?ref=C3A",
        },
      };
    return base;
  }
  async methods() {
    return METHODS.map((method) => ({
      method,
      enabled: this.listed.has(method),
      channels:
        this.listed.has(method) && (method === "va" || method === "ewallet")
          ? [...CHANNELS[method]]
          : [],
    }));
  }
  override async channels(_context?: unknown, method?: string) {
    return method === "va" || method === "ewallet"
      ? this.listed.has(method)
        ? [...CHANNELS[method]]
        : []
      : [];
  }
}

type Fx = HoldFixture & { gateway: OnlineGateway };
let fx: Fx;

async function fixture(label: string, provider: string): Promise<Fx> {
  const base = await captainPaymentFixture(label);
  const gateway = new OnlineGateway(provider);
  setPaymentGateway(gateway);
  return { ...base, gateway };
}

beforeAll(async () => {
  fx = await fixture("c3a-va", "duitku");
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

const errorCode = (body: { error?: { code?: string }; code?: string }) =>
  body?.error?.code ?? body?.code;

async function orderStatus(orderId: string) {
  const read = await fx.get(`${fx.base}/${orderId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body.data.status as string;
}

function postTender(
  orderId: string,
  status: string,
  body: Record<string, unknown>,
) {
  return fx.post(`${fx.base}/${orderId}/tenders`, {
    expectedStatus: status,
    idempotencyKey: randomUUID(),
    ...body,
  });
}

async function issue(orderId: string, method: "va" | "ewallet") {
  const requestsBefore = fx.gateway.requests.length;
  const startedAt = Date.now();
  const res = await postTender(orderId, await orderStatus(orderId), {
    method,
    channelCode: CHANNELS[method][0].code,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(fx.gateway.requests.length).toBe(requestsBefore + 1);
  const tender = res.body.data.tender as {
    id: string;
    method: string;
    provider: string;
    status: string;
    amountIdr: number;
    paymentIntentId: string;
  };
  const { rows } = await owner.query<{
    expires_at: Date;
    provider_ref: string;
    method: string;
    channel_code: string | null;
  }>(
    `SELECT expires_at, provider_ref, method, channel_code FROM payment_intents
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, tender.paymentIntentId],
  );
  return {
    tender,
    intentId: tender.paymentIntentId,
    expiresAt: rows[0]!.expires_at,
    providerRef: rows[0]!.provider_ref,
    intent: rows[0]!,
    startedAt,
  };
}

function expectLocked(res: { status: number; body: unknown }) {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
}

async function backdateExpiry(intentId: string, minutesAgo: number) {
  await owner.query(
    `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 minute'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId, minutesAgo],
  );
}

async function checkAt(now: Date) {
  try {
    await runHoldCheck(fx, now);
  } catch (error) {
    if (!/scripted/.test(String(error))) throw error;
  }
}

/** A notice the money rules park (wrong amount, dead code) may answer 409. */
async function payParked(...args: Parameters<typeof payNotice>) {
  try {
    return await payNotice(...args);
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
    await signUp(client, "Manajer VA Kasir");
    const session = await client.get("/api/auth/get-session");
    const userId = session.body.user.id as string;
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Manajer VA Uji', false, NULL, $3, false, '["tenant"]')`,
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
      reason: "Penyedia VA tidak merespons",
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

describe("1269 C3a cashier VA and e-wallet (Duitku, cloud)", () => {
  it("VA: one Duitku code for the remaining bill, a hold, the VA number for the cashier, captured once on a double callback", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const va = await issue(order.id, "va");
    expect(va.tender).toMatchObject({
      method: "va",
      provider: "duitku",
      status: "authorized",
      amountIdr: BILL_IDR,
    });
    expect(fx.gateway.requests.at(-1)).toMatchObject({
      method: "va",
      channelCode: "BC",
      amountIdr: BILL_IDR,
    });
    expect(va.intent).toMatchObject({ method: "va", channel_code: "BC" });
    // A cashier code lives 10 minutes (never the 24 hour guest VA).
    const lifetime = va.expiresAt.getTime() - va.startedAt;
    expect(lifetime).toBeGreaterThan(9 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    expect(await readHold(fx, order.id)).toMatchObject({
      state: "open",
      tenderId: va.tender.id,
      paymentIntentId: va.intentId,
      amountIdr: BILL_IDR,
    });
    const status = await getQris(fx, order.id);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.data.qrPayload).toBeNull();
    expect(status.body.data.instructions).toEqual({
      method: "va",
      channelCode: "BC",
      channelName: "BCA Virtual Account",
      virtualAccountNumber: "8808123456789012",
    });

    const providerRef = `DK-${randomUUID()}`;
    await payNotice(fx, va.intentId, BILL_IDR, new Date(), providerRef);
    await payParked(fx, va.intentId, BILL_IDR, new Date(), providerRef);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "captured",
    ]);
    expect((await readHold(fx, order.id))?.state).toBe("paid");
    expect(await refundsOfIntent(fx, va.intentId)).toEqual([]);
    expect(await unallocatedFunds(fx, va.intentId)).toEqual([]);
    await assertInvariants(fx, order.id);
  });

  it("e-wallet: the Duitku payment page is the cashier's instruction; the paid callback captures it", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const wallet = await issue(order.id, "ewallet");
    expect(wallet.tender).toMatchObject({
      method: "ewallet",
      provider: "duitku",
      status: "authorized",
    });
    const status = await getQris(fx, order.id);
    expect(status.body.data.instructions).toEqual({
      method: "ewallet",
      channelCode: "OV",
      channelName: "OVO",
      paymentUrl: "https://sandbox.duitku.com/topup/v2/pay?ref=C3A",
    });
    await payNotice(fx, wallet.intentId, BILL_IDR);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    await assertInvariants(fx, order.id);
  });

  it("while the code is live every method is locked: cash, QRIS, a second VA, an e-wallet and EDC all 409", async () => {
    const order = await newSubmittedOrder(fx, 0);
    await issue(order.id, "va");
    const status = await orderStatus(order.id);
    const before = fx.gateway.requests.length;
    expectLocked(
      await postTender(order.id, status, {
        method: "cash",
        receivedIdr: 50_000,
      }),
    );
    expectLocked(await postTender(order.id, status, { method: "qris" }));
    expectLocked(
      await postTender(order.id, status, { method: "va", channelCode: "BC" }),
    );
    expectLocked(
      await postTender(order.id, status, {
        method: "ewallet",
        channelCode: "OV",
      }),
    );
    expect(fx.gateway.requests.length).toBe(before);
    expect(await capturedIdr(fx, order.id)).toBe(0);
  });

  it("the lock holds until Duitku answers 02 after the code lapsed: pending, unknown, a mapped status without 02, and an early 02 never unlock", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const va = await issue(order.id, "va");
    expect((await postCancel(fx, order.id)).status).toBe(202);
    const after = (seconds: number) =>
      new Date(va.expiresAt.getTime() + seconds * 1000);

    fx.gateway.script(va.intentId, { rawStatus: "02" });
    await checkAt(after(-60));
    expect((await readHold(fx, order.id))?.state).toBe("cancelling");
    for (const answer of [
      { rawStatus: "01" as const },
      { error: "timeout" as const },
      { status: "expired" as const },
      { otherReference: true as const },
    ]) {
      fx.gateway.script(va.intentId, answer);
      await checkAt(after(HOLD_CLOSE_MARGIN_S + 1));
      expect(
        (await readHold(fx, order.id))?.state,
        JSON.stringify(answer),
      ).toBe("cancelling");
    }
    expectLocked(
      await postTender(order.id, await orderStatus(order.id), {
        method: "cash",
        receivedIdr: 50_000,
      }),
    );

    fx.gateway.script(va.intentId, { rawStatus: "02" });
    await checkAt(after(HOLD_CLOSE_MARGIN_S + 1));
    const closed = await readHold(fx, order.id);
    expect(closed?.state).toBe("closed");
    expect(closed?.closeReason).toBe("provider_expired");
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "voided",
    ]);

    const cash = await postTender(order.id, await orderStatus(order.id), {
      method: "cash",
      receivedIdr: 50_000,
    });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    // A late callback on the dead code is never a second capture.
    await payParked(fx, va.intentId, BILL_IDR);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    const owed =
      (await unallocatedFunds(fx, va.intentId)).length +
      (await refundsOfIntent(fx, va.intentId)).length;
    expect(owed).toBe(1);
    await assertInvariants(fx, order.id);
  });

  it("a callback with another amount is parked, never captured, and the bill stays locked", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const va = await issue(order.id, "va");
    await payParked(fx, va.intentId, BILL_IDR - 1_000);
    expect(await capturedIdr(fx, order.id)).toBe(0);
    const parked = await unallocatedFunds(fx, va.intentId);
    expect(parked.map((row) => row.amountIdr)).toEqual([BILL_IDR - 1_000]);
    expectLocked(
      await postTender(order.id, await orderStatus(order.id), {
        method: "cash",
        receivedIdr: 50_000,
      }),
    );
    await assertInvariants(fx, order.id);
  });

  it("switching method after a manager release, then the old VA is paid: the money is parked, the bill is paid once", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const va = await issue(order.id, "va");
    expect((await postCancel(fx, order.id)).status).toBe(202);
    await backdateExpiry(va.intentId, HOLD_RELEASE_AFTER_MIN + 1);
    const released = await postRelease(
      fx,
      order.id,
      await managerApproval(order.id, BILL_IDR),
    );
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    const cash = await postTender(order.id, await orderStatus(order.id), {
      method: "cash",
      receivedIdr: 50_000,
    });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);

    await payParked(fx, va.intentId, BILL_IDR, new Date(), va.providerRef);
    expect(await capturedIdr(fx, order.id)).toBe(BILL_IDR);
    const parked = await unallocatedFunds(fx, va.intentId);
    expect(parked.map((row) => row.amountIdr)).toEqual([BILL_IDR]);
    expect(await refundsOfIntent(fx, va.intentId)).toEqual([]);
    await assertInvariants(fx, order.id);
  });

  it("refuses before any provider call: no channel, a channel on cash, an unlisted channel, a locked method, online card", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const status = await orderStatus(order.id);
    const before = fx.gateway.requests.length;
    const noChannel = await postTender(order.id, status, { method: "va" });
    expect(noChannel.status, JSON.stringify(noChannel.body)).toBe(400);
    const cashChannel = await postTender(order.id, status, {
      method: "cash",
      receivedIdr: 50_000,
      channelCode: "BC",
    });
    expect(cashChannel.status, JSON.stringify(cashChannel.body)).toBe(400);
    const unknown = await postTender(order.id, status, {
      method: "va",
      channelCode: "M2",
    });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(422);
    fx.gateway.listed.delete("ewallet");
    try {
      const locked = await postTender(order.id, status, {
        method: "ewallet",
        channelCode: "OV",
      });
      expect(locked.status, JSON.stringify(locked.body)).toBe(422);
    } finally {
      fx.gateway.listed.add("ewallet");
    }
    const card = await postTender(order.id, status, { method: "card" });
    expect(card.status, JSON.stringify(card.body)).toBe(422);
    expect(errorCode(card.body)).toBe("VALIDATION_ERROR");
    expect(fx.gateway.requests.length).toBe(before);
    expect(await tenderStatuses(fx, order.id)).toEqual([]);
  });

  it("payment options list VA and e-wallet with their channels only on cloud with Duitku; online card stays locked", async () => {
    const outletId = fx.tenant.outletId as OutletId;
    const options = await getPosPaymentOptions(fx.context, outletId, {
      deviceId: null,
    });
    const by = (method: string) =>
      options.methods.find((row) => row.method === method);
    expect(by("va")).toMatchObject({
      enabled: true,
      unavailableReason: null,
      channels: [{ code: "BC", name: "BCA Virtual Account" }],
    });
    expect(by("ewallet")).toMatchObject({
      enabled: true,
      channels: [{ code: "OV", name: "OVO" }],
    });
    expect(by("card")).toMatchObject({
      enabled: false,
      unavailableReason: "not_supported",
    });

    fx.gateway.listed.delete("va");
    try {
      const locked = await getPosPaymentOptions(fx.context, outletId, {
        deviceId: null,
      });
      expect(locked.methods.find((row) => row.method === "va")).toMatchObject(
        { enabled: false, unavailableReason: "routing_disabled" },
      );
    } finally {
      fx.gateway.listed.add("va");
    }

    const previous = process.env.EDGE_MODE;
    process.env.EDGE_MODE = "true";
    try {
      const edge = await getPosPaymentOptions(fx.context, outletId, {
        deviceId: null,
      });
      for (const method of ["va", "ewallet"])
        expect(edge.methods.find((row) => row.method === method)).toMatchObject(
          { enabled: false, unavailableReason: "needs_cloud" },
        );
    } finally {
      if (previous === undefined) delete process.env.EDGE_MODE;
      else process.env.EDGE_MODE = previous;
    }
  });
});

describe("1269 C3a another provider", () => {
  it("a VA routed to a provider other than Duitku is refused before any code is made", async () => {
    const doit = await fixture("c3a-va-doit", "doit");
    const order = await newSubmittedOrder(doit, 0);
    const read = await doit.get(`${doit.base}/${order.id}`);
    const res = await doit.post(`${doit.base}/${order.id}/tenders`, {
      expectedStatus: read.body.data.status,
      method: "va",
      channelCode: "BC",
      idempotencyKey: randomUUID(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(doit.gateway.requests).toEqual([]);
    const { rows } = await owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM pos_order_tenders WHERE tenant_id=$1 AND order_id=$2",
      [doit.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(rows[0]!.n).toBe(0);
    // Leave the Duitku port installed for any later test of this file.
    setPaymentGateway(fx.gateway);
  });
});
