// SO-889 (finding 2, tingkat K uang): a failed code whose money is still parked
// (`payment_unallocated_funds.resolved_at IS NULL`) must freeze BOTH ways of
// asking the guest for money again: re-splitting the bill and paying the whole
// order. Any code of the order counts, whole-order or part, even a part that
// was voided since.
//
// A. Whole-order VA of 33k paid 10k: code `failed`, 10k parked, link paidIdr 0.
//    The guest splits the bill and pays a part: the guest would pay the bill
//    twice while the 10k is not yet returned. Split creation -> 409
//    FUNDS_UNRESOLVED, no new code.
// B. A part code failed with parked money. Re-splitting (which voids that part)
//    or paying the whole order must both answer 409 FUNDS_UNRESOLVED, also when
//    the part is already voided, and no code is created.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so889-split-funds.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import { holdGatewayAmountMismatch } from "../services/payment.service.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  ScriptedGateway,
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 120_000 });

const PARKED_IDR = 10_000;

let fx: HoldFixture;
let gw: ScriptedGateway;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so889");
  gw = new ScriptedGateway("doit");
  enableVaBank(gw);
  setPaymentGateway(gw);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Part = { id: string; amountIdr: number };

/** m1 Duitku mismatch: intent `failed` and the paid amount parked. */
async function mismatch(intentId: string) {
  const { rows } = await owner.query<{ provider_ref: string }>(
    "SELECT provider_ref FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  const result = await holdGatewayAmountMismatch(
    fx.context,
    intentId,
    {
      providerRef: `${rows[0]!.provider_ref}-paid-${randomUUID().slice(0, 8)}`,
      paidAmountIdr: PARKED_IDR,
      source: "webhook",
    },
    new Date(),
  );
  expect(result.intentStatus).toBe("failed");
}

async function intentCount(orderUuid: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment_intents i
       JOIN orders o ON o.tenant_id = i.tenant_id AND o.payment_link_id = i.payment_link_id
      WHERE i.tenant_id=$1 AND o.id=$2`,
    [fx.tenant.tenantId, orderUuid],
  );
  return rows[0]!.n;
}

const splitBody = () => ({
  method: "equal",
  parts: 2,
  idempotencyKey: randomUUID(),
});

async function splitInto(guest: Guest): Promise<Part[]> {
  const split = await fx.guestPost(guest, "/splits", splitBody());
  expect(split.status, JSON.stringify(split.body)).toBe(201);
  return split.body.data.splits as Part[];
}

function payPart(guest: Guest, part: Part) {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "split", billSplitId: part.id },
    method: "va",
    bankCode: "bmri",
    payerSecret: secretFor(part.id),
    idempotencyKey: randomUUID(),
  });
}

function payWhole(guest: Guest, orderId: string) {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method: "va",
    bankCode: "bmri",
    idempotencyKey: randomUUID(),
  });
}

function expectFundsUnresolved(
  response: Awaited<ReturnType<HoldFixture["guestPost"]>>,
) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error.code).toBe("FUNDS_UNRESOLVED");
}

describe("SO-889 a failed code with parked money freezes split and whole-order payment", () => {
  it("A: whole-order VA failed with a parked fund -> splitting the bill is refused, no new code", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const paid = await fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method: "va",
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    await mismatch(paid.body.data.id as string);
    const orderUuid = ulidToUuid(order.id);
    const before = await intentCount(orderUuid);
    expect(before).toBe(1);

    expectFundsUnresolved(await fx.guestPost(guest, "/splits", splitBody()));

    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bill_splits WHERE tenant_id=$1 AND order_id=$2`,
      [fx.tenant.tenantId, orderUuid],
    );
    expect(rows[0]!.n).toBe(0);
    expect(await intentCount(orderUuid)).toBe(before);
  });

  it("B: a failed part code with a parked fund -> re-split and whole-order payment are refused, no new code", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const parts = await splitInto(guest);
    const paid = await payPart(guest, parts[0]!);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    await mismatch(paid.body.data.id as string);
    const orderUuid = ulidToUuid(order.id);
    const before = await intentCount(orderUuid);

    expectFundsUnresolved(await fx.guestPost(guest, "/splits", splitBody()));
    expectFundsUnresolved(await payWhole(guest, order.id));

    const { rows } = await owner.query<{ status: string }>(
      `SELECT status FROM bill_splits WHERE tenant_id=$1 AND order_id=$2`,
      [fx.tenant.tenantId, orderUuid],
    );
    expect(rows.filter((r) => r.status === "voided")).toHaveLength(0);
    expect(await intentCount(orderUuid)).toBe(before);
  });

  it("B: the failed part is already voided -> paying the whole order is still refused, no new code", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const parts = await splitInto(guest);
    const paid = await payPart(guest, parts[0]!);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    await mismatch(paid.body.data.id as string);
    const orderUuid = ulidToUuid(order.id);
    await owner.query(
      `UPDATE bill_splits SET status='voided', voided_at=now() WHERE tenant_id=$1 AND order_id=$2`,
      [fx.tenant.tenantId, orderUuid],
    );
    const before = await intentCount(orderUuid);

    expectFundsUnresolved(await payWhole(guest, order.id));
    expect(await intentCount(orderUuid)).toBe(before);
  });
});
