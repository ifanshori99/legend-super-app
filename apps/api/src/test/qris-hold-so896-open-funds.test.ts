// SO-896 (legend-5h8ob, architect P2, tingkat K uang): an OPEN unallocated fund
// (`payment_unallocated_funds.resolved_at IS NULL`) of any code of the order or of
// a part blocks new money requests, whatever the intent status is (expired,
// failed, superseded, ...), except `paid`. The old guard looked only at `failed`
// intents, so money parked on an `expired` code slipped through: the guest could
// split the bill or pay the whole order again while the first payment was not
// yet returned, and so paid twice.
//
// 1. A QRIS code is closed provider-expired (final). A late paid webhook is then
//    parked as a fund; the intent stays `expired`. Splitting and paying the whole
//    order -> 409 FUNDS_UNRESOLVED until the fund is resolved, then both pass.
// 2. A part VA code expires; the poll finds the guest paid only 10k and parks it
//    on the `expired` code. Paying the part again, re-splitting and paying the
//    whole order -> 409 FUNDS_UNRESOLVED until resolved, then allowed.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so896-open-funds.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ulidToUuid } from "@starter/shared/core";
import {
  pollPendingGatewayIntents,
  recordUnsettledGatewayFunds,
} from "../services/payment.service.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { owner } from "./floor-test-helpers.ts";
import { secretFor } from "./payer-secret-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  runHoldCheck,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 120_000 });

const MARGIN_MS = 60_000;
const UNDERPAID_IDR = 10_000;

let fx: HoldFixture;
beforeAll(async () => {
  fx = await holdFixture("qris-hold-so896");
  enableVaBank(fx.gateway);
  setPaymentGateway(fx.gateway);
});
afterAll(async () => {
  resetHoldPorts();
  await owner.end();
});

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;
type Part = { id: string; amountIdr: number };

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{
    id: string;
    outlet_id: string;
    amount_idr: string;
    method: string;
    provider: string;
    provider_ref: string;
    status: string;
    expires_at: Date;
  }>(
    `SELECT id::text AS id, outlet_id::text AS outlet_id, amount_idr::text AS amount_idr,
            method, provider, provider_ref, status, expires_at
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

async function intentCount(orderUuid: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM payment_intents i
      WHERE i.tenant_id=$1 AND (
        i.payment_link_id IN (SELECT payment_link_id FROM orders WHERE tenant_id=$1 AND id=$2)
        OR i.bill_split_id IN (SELECT id FROM bill_splits WHERE tenant_id=$1 AND order_id=$2))`,
    [fx.tenant.tenantId, orderUuid],
  );
  return rows[0]!.n;
}

async function activeHoldStates(orderUuid: string) {
  const { rows } = await owner.query<{ state: string }>(
    `SELECT state FROM pos_qris_holds
      WHERE tenant_id=$1 AND order_id=$2 AND state IN ('open','cancelling')`,
    [fx.tenant.tenantId, orderUuid],
  );
  return rows.map((r) => r.state);
}

const afterMargin = (expiresAt: Date) =>
  new Date(expiresAt.getTime() + MARGIN_MS + 1_000);

const splitBody = () => ({
  method: "equal",
  parts: 2,
  idempotencyKey: randomUUID(),
});

function payWhole(guest: Guest, orderId: string, method: "qris" | "va") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey: randomUUID(),
  });
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

function expectFundsUnresolved(
  response: Awaited<ReturnType<HoldFixture["guestPost"]>>,
) {
  expect(response.status, JSON.stringify(response.body)).toBe(409);
  expect(response.body.error.code).toBe("FUNDS_UNRESOLVED");
}

async function resolveFunds(intentId: string) {
  await owner.query(
    `UPDATE payment_unallocated_funds
        SET resolution='refund', resolved_by='test', resolved_at=now()
      WHERE tenant_id=$1 AND payment_intent_id=$2 AND resolved_at IS NULL`,
    [fx.tenant.tenantId, intentId],
  );
}

describe("SO-896 an open fund on any intent status blocks new money requests", () => {
  it("1: QRIS closed provider-expired, late paid webhook parked on the expired code -> split and whole-order payment refused until resolved", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const orderUuid = ulidToUuid(order.id);
    const issued = await payWhole(guest, order.id, "qris");
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const intentId = issued.body.data.id as string;
    const row = await intentRow(intentId);

    fx.gateway.script(intentId, { status: "expired" });
    const closeAt = afterMargin(row.expires_at);
    await pollPendingGatewayIntents(fx.context, closeAt, 200);
    await runHoldCheck(fx, closeAt);
    expect((await intentRow(intentId)).status).toBe("expired");
    // The provider answered final expired, so the hold is closed.
    expect(await activeHoldStates(orderUuid)).toEqual([]);

    // The late paid webhook is parked; the intent stays expired.
    await recordUnsettledGatewayFunds(
      fx.context,
      {
        id: row.id,
        outletId: row.outlet_id,
        amountIdr: row.amount_idr,
        method: row.method,
        provider: row.provider,
        status: row.status,
      } as never,
      {
        provider: row.provider,
        providerRef: `${row.provider_ref}-late-${randomUUID().slice(0, 8)}`,
        source: "verified_webhook",
        paidAmountIdr: Number(row.amount_idr),
        receivedAt: new Date(),
      },
      new Date(),
    );
    expect((await intentRow(intentId)).status).toBe("expired");
    expect(await unallocatedFunds(fx, intentId)).toHaveLength(1);
    const before = await intentCount(orderUuid);

    expectFundsUnresolved(await fx.guestPost(guest, "/splits", splitBody()));
    expectFundsUnresolved(await payWhole(guest, order.id, "va"));
    expectFundsUnresolved(await payWhole(guest, order.id, "qris"));
    expect(await intentCount(orderUuid)).toBe(before);

    await resolveFunds(intentId);
    const split = await fx.guestPost(guest, "/splits", splitBody());
    expect(split.status, JSON.stringify(split.body)).toBe(201);
  });

  it("2: underpaid money parked by the poll on an expired part code -> part, re-split and whole-order payment refused until resolved", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const orderUuid = ulidToUuid(order.id);
    const split = await fx.guestPost(guest, "/splits", splitBody());
    expect(split.status, JSON.stringify(split.body)).toBe(201);
    const parts = split.body.data.splits as Part[];
    const paid = await payPart(guest, parts[0]!);
    expect(paid.status, JSON.stringify(paid.body)).toBe(201);
    const intentId = paid.body.data.id as string;
    const row = await intentRow(intentId);

    fx.gateway.script(intentId, { status: "paid", amountIdr: UNDERPAID_IDR });
    await pollPendingGatewayIntents(
      fx.context,
      afterMargin(row.expires_at),
      200,
    );
    expect((await intentRow(intentId)).status).toBe("expired");
    const funds = await unallocatedFunds(fx, intentId);
    expect(funds.map((f) => f.amountIdr)).toEqual([UNDERPAID_IDR]);
    const before = await intentCount(orderUuid);

    expectFundsUnresolved(await payPart(guest, parts[0]!));
    expectFundsUnresolved(await fx.guestPost(guest, "/splits", splitBody()));
    expectFundsUnresolved(await payWhole(guest, order.id, "va"));
    expect(await intentCount(orderUuid)).toBe(before);

    await resolveFunds(intentId);
    const again = await payWhole(guest, order.id, "va");
    expect(again.status, JSON.stringify(again.body)).not.toBe(409);
  });
});
