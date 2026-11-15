// legend-kf104 (SO-879 second opinion, card A): a guest's WHOLE-order QR follows
// the same rule as a split QR: one collectible code per bill; a replacement code
// is issued only after the old code is proven dead at the provider.
//
// Written from docs/briefs/so-879-qris-hold-fix.md (CTO decision) and the last
// finding of docs/qa/second-opinion-qris-hold.md: a pay-first guest opens QR A,
// switches to a VA, then asks QR B with another key; A is only superseded
// locally, so A and B can both be paid, and the customer pays more than the bill
// until a refund completes.
//
// Assumptions:
// - Refusal of a replacement code is HTTP 409 (QRIS_HOLD_ACTIVE, as the second
//   split QR in QH-19). Only the 409 is asserted; the body is quoted in the
//   failure message.
// - Asking again for the SAME method with a new key may return the existing
//   code A (idempotent per method, as today) or 409; it must never create a new
//   provider code.
// - "Proven dead" = the provider answers `expired`, the QR is past its life +
//   the 60 s margin, and the hold check job ran. The hold of a guest order-wide
//   code is closed by that job without any cashier action.
// - The VA bank `bmri` is offered by the test gateway.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tenantIdSchema, ulidToUuid, userIdSchema } from "@starter/shared/core";
import { establishTenantContext } from "@starter/shared/core/server";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { db } from "../db/index.ts";
import { withTenant } from "../db/tenant.ts";
import { deliverOrderPaymentEvent } from "../services/order-payment-consumers.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { setStaffPin } from "../services/device-pin.service.ts";
import { confirmPayment } from "../services/payment.service.ts";
import { createPosOverride } from "../services/staff-override.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, signUp } from "./helpers.ts";
import {
  ScriptedGateway,
  holdFixture,
  postRelease,
  readHolds,
  refundsOfIntent,
  resetHoldPorts,
  runHoldCheck,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";

vi.setConfig({ testTimeout: 120_000 });
const BILL_IDR = 33_000;

let fx: HoldFixture;
let gw: ScriptedGateway;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so879-kf104");
  gw = new ScriptedGateway("doit");
  const create = gw.createIntent.bind(gw);
  gw.createIntent = async (input) => {
    const base = await create(input);
    return input.method === "va"
      ? {
          ...base,
          instructions: {
            method: "va" as const,
            channelCode: input.channelCode ?? "bmri",
            channelName: "Mandiri",
            virtualAccountNumber: "8808123456789012",
          },
        }
      : base;
  };
  (
    gw as unknown as {
      channels: (c: unknown, method: string) => Promise<unknown[]>;
    }
  ).channels = async (_context, method) =>
    method === "va" ? [{ code: "bmri", name: "Mandiri" }] : [];
  setPaymentGateway(gw);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

async function guestOrder() {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  expect(order.totalIdr).toBe(BILL_IDR);
  return { guest, order };
}

function payWhole(
  guest: Guest,
  orderId: string,
  method: "qris" | "va",
  idempotencyKey: string = randomUUID(),
) {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey,
  });
}

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{ status: string; amount: number }>(
    `SELECT status, amount_idr::int AS amount FROM payment_intents
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

async function orderStatus(orderId: string) {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM orders WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, ulidToUuid(orderId)],
  );
  return rows[0]!.status;
}

/** The provider payment of `intentId` as a verified webhook, delivered (twice)
 * to the QR order consumer as the worker does. */
async function payAndDeliver(
  intentId: string,
  method: "qris" | "va",
  amountIdr: number,
) {
  await confirmPayment(
    fx.context,
    intentId,
    {
      source: "verified_webhook",
      method,
      amountIdr,
      providerRef: `WEBHOOK-${randomBytes(6).toString("hex")}`,
      at: new Date().toISOString(),
    },
    { type: "system" },
    new Date(),
  );
  const { rows } = await owner.query<{ event: unknown }>(
    `SELECT event FROM domain_event_outbox WHERE tenant_id=$1
       AND event->>'name'='payment.paid' AND event->'payload'->>'intentId'=$2
      ORDER BY created_at, id`,
    [fx.tenant.tenantId, intentId],
  );
  for (const row of rows) {
    const event = eventEnvelopeSchema.parse(row.event);
    for (let i = 0; i < 2; i += 1)
      await withTenant(db, fx.context, (tx) =>
        deliverOrderPaymentEvent(fx.context, event, tx, new Date()),
      );
  }
}

describe("legend-kf104 one collectible code per guest bill", () => {
  it("legend-kf104 QR A -> VA -> QR B (other keys): no replacement code reaches the provider while A is not proven dead; A alone settles the bill, paid once", async () => {
    const { guest, order } = await guestOrder();
    const requestsBefore = gw.requests.length;

    const a = await payWhole(guest, order.id, "qris");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const aId = a.body.data.id as string;
    expect(gw.requests.length).toBe(requestsBefore + 1);

    // The provider still says A is alive: nothing proves it dead.
    gw.script(aId, { rawStatus: "01" });
    const va = await payWhole(guest, order.id, "va");
    expect(
      va.status,
      `a VA must not replace a live QR: ${JSON.stringify(va.body)}`,
    ).toBe(409);
    expect(gw.requests.length, "the VA code must not be created").toBe(
      requestsBefore + 1,
    );

    const b = await payWhole(guest, order.id, "qris");
    if (b.status === 201)
      expect(
        b.body.data.id,
        "asking QR again may only return the existing code A",
      ).toBe(aId);
    else expect(b.status, JSON.stringify(b.body)).toBe(409);
    expect(gw.requests.length, "no second QR code at the provider").toBe(
      requestsBefore + 1,
    );
    expect(
      (await intentRow(aId)).status,
      "A is not superseded while it may be paid",
    ).toBe("pending");

    // The guest pays A; the bill is settled by that single payment.
    await payAndDeliver(aId, "qris", BILL_IDR);
    expect(await orderStatus(order.id)).not.toBe("awaiting_payment");
    expect(await unallocatedFunds(fx, aId)).toEqual([]);
    expect(await refundsOfIntent(fx, aId)).toEqual([]);
    expect((await intentRow(aId)).amount).toBe(BILL_IDR);
  });

  it("legend-kf104 A proven dead (provider expired, past life + margin, hold check ran) -> the replacement VA is issued for the bill amount and settles it once", async () => {
    const { guest, order } = await guestOrder();
    const a = await payWhole(guest, order.id, "qris");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const aId = a.body.data.id as string;
    const requestsBefore = gw.requests.length;

    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - interval '15 minutes'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, aId],
    );
    gw.script(aId, { status: "expired" });
    await runHoldCheck(fx, new Date());

    const va = await payWhole(guest, order.id, "va");
    expect(
      va.status,
      `replacement allowed after A is proven dead: ${JSON.stringify(va.body)}`,
    ).toBe(201);
    const vaId = va.body.data.id as string;
    expect(vaId).not.toBe(aId);
    expect(gw.requests.length).toBe(requestsBefore + 1);
    expect(gw.requests.at(-1)).toMatchObject({
      method: "va",
      amountIdr: BILL_IDR,
    });

    await payAndDeliver(vaId, "va", BILL_IDR);
    expect(await orderStatus(order.id)).not.toBe("awaiting_payment");
    expect(await unallocatedFunds(fx, vaId)).toEqual([]);
    expect(await refundsOfIntent(fx, vaId)).toEqual([]);
    // A never paid: nothing to give back for it either.
    expect(await unallocatedFunds(fx, aId)).toEqual([]);
    expect(await refundsOfIntent(fx, aId)).toEqual([]);
  });

  it("legend-kf104 provider cannot answer about A (timeout): the replacement is still refused, nothing is issued", async () => {
    const { guest, order } = await guestOrder();
    const a = await payWhole(guest, order.id, "qris");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const aId = a.body.data.id as string;
    const requestsBefore = gw.requests.length;

    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - interval '15 minutes'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, aId],
    );
    gw.script(aId, { error: "timeout" });
    await runHoldCheck(fx, new Date());

    const va = await payWhole(guest, order.id, "va");
    expect(
      va.status,
      `fail closed: no proof A is dead -> ${JSON.stringify(va.body)}`,
    ).toBe(409);
    expect(gw.requests.length).toBe(requestsBefore);
  });

  it("legend-w0ows a card sale of the bill is open -> a guest whole-order QR is refused and nothing reaches the provider", async () => {
    const { guest, order } = await guestOrder();
    const { rows } = await owner.query<{ number: string }>(
      "SELECT number FROM orders WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, ulidToUuid(order.id)],
    );
    const terminalId = randomUUID();
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '*', true)",
        [fx.tenant.tenantId],
      );
      await client.query(
        `INSERT INTO payment_edc_terminals
           (id, tenant_id, outlet_id, bank_code, terminal_id, merchant_id, model,
            connection, ip_address, supported_methods, status)
         VALUES ($1, $2, $3, 'bca', $4, 'MID-KF104', 'Test EDC', 'lan',
                '10.0.0.8', ARRAY['card','qris'], 'active')`,
        [
          terminalId,
          fx.tenant.tenantId,
          fx.tenant.outletId,
          `TID-${terminalId.slice(0, 8)}`,
        ],
      );
      await client.query(
        `INSERT INTO edc_transactions
           (id, tenant_id, outlet_id, terminal_id, bank, reference, idempotency_key,
            request_fingerprint, amount_idr, method, status, type, mode, trace,
            needs_reconciliation)
         VALUES ($1, $2, $3, $4, 'bca', $5, $6, 'fp', $7, 'card', 'pending', 'sale',
                 'ecr', $8, false)`,
        [
          randomUUID(),
          fx.tenant.tenantId,
          fx.tenant.outletId,
          terminalId,
          rows[0]!.number,
          randomUUID(),
          BILL_IDR,
          randomUUID().slice(0, 12),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const requestsBefore = gw.requests.length;

    const qr = await payWhole(guest, order.id, "qris");
    expect(qr.status, `the card sale wins: ${JSON.stringify(qr.body)}`).toBe(
      409,
    );
    expect(gw.requests.length, "no QR code at the provider").toBe(
      requestsBefore,
    );
    const { rows: holds } = await owner.query(
      "SELECT 1 FROM pos_qris_holds WHERE tenant_id=$1 AND order_id=$2",
      [fx.tenant.tenantId, ulidToUuid(order.id)],
    );
    expect(holds).toEqual([]);
  });

  it("legend-kf104 manager release of a guest whole-order hold (no tender, no POS row) is refused 409, the hold stays open; the provider-proof job then closes it", async () => {
    const { guest, order } = await guestOrder();
    const a = await payWhole(guest, order.id, "qris");
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const aId = a.body.data.id as string;
    gw.script(aId, { rawStatus: "01" });
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - interval '31 minutes'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, aId],
    );

    // Approved manager PIN override (action "void" on the order).
    const client = agent(fx.app);
    await signUp(client, "Manajer Rilis Tamu");
    const session = await client.get("/api/auth/get-session");
    const approver = session.body.user.id as string;
    const roleId = randomUUID();
    await owner.query(
      `INSERT INTO roles (id, tenant_id, name, is_template, template_key, permissions, mfa_required, allowed_scope_types)
       VALUES ($1, $2, 'Manajer Tamu Uji', true, 'supervisor', $3, false, '["tenant"]')`,
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
      [fx.tenant.tenantId, approver, roleId],
    );
    const tenantContext = establishTenantContext({
      tenantId: tenantIdSchema.parse(fx.tenant.tenantId),
      brandId: null,
      source: "session",
    });
    await setStaffPin(
      tenantContext,
      approver,
      { outletId: fx.tenant.outletId, userId: approver },
      { pin: "582914" },
    );
    const { override } = await createPosOverride(
      tenantContext,
      fx.staff.userId,
      {
        outletId: fx.tenant.outletId,
        action: "void",
        valueIdr: BILL_IDR,
        reason: "Penyedia QRIS tidak merespons",
        objectType: "order",
        objectId: order.id,
        approval: {
          method: "supervisor_pin",
          approverUserId: userIdSchema.parse(approver),
          pin: "582914",
        },
      } as Parameters<typeof createPosOverride>[2],
      { idempotencyKey: randomUUID() },
    );
    expect(override.status).toBe("approved");

    const refused = await postRelease(fx, order.id, {
      approvedBy: approver,
      overrideId: override.id,
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("QRIS_HOLD_ACTIVE");
    expect((await readHolds(fx, order.id)).map((h) => h.state)).toEqual([
      "open",
    ]);
    expect((await intentRow(aId)).status).toBe("pending");
    expect(await unallocatedFunds(fx, aId)).toEqual([]);
    expect(await refundsOfIntent(fx, aId)).toEqual([]);

    // Only the provider-proof job closes it, once the provider says expired.
    gw.script(aId, { status: "expired" });
    await runHoldCheck(fx, new Date());
    expect(
      (await readHolds(fx, order.id)).map((h) => [h.state, h.closeReason]),
    ).toEqual([["closed", "provider_expired"]]);
  });
});
