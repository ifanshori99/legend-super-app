// legend SO-889 architect review, three P2 gaps (design `qris-dp-intent.md` D-03):
//  (1) P2-1 manager release of a POS QR while the guest's money for that QR sits
//      open in unallocated funds: the cashier could take cash again while the
//      parked money is still owed back -> 409 FUNDS_UNRESOLVED, nothing is
//      voided and the hold stays.
//  (2) P2-2 the best-effort gateway cancel of a superseded code resolving is not
//      proof the code is dead: `provider_final_at` is set only when the provider
//      then answers final (`providerAnswerFinal`).
//  (3) A `failed` code (Duitku `02` before `expires_at`) is a retryable attempt:
//      it stays live (no replacement VA) until the provider answers final
//      (SO-896: local time never kills it).
//
// Assumptions:
// - A bill of the cashier fixture is Rp 33.000; the mismatch pays Rp 30.000.
// - Refusals are HTTP 409.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so889-p2-release-cancel.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OutletId } from "@starter/shared/core";
import type { PaymentGatewayPort } from "../services/payment-gateway.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import {
  applyGatewayFailure,
  createPaymentLink,
  pollPendingGatewayIntents,
} from "../services/payment.service.ts";
import { agent } from "./helpers.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  HOLD_RELEASE_AFTER_MIN,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  payNotice,
  postCancel,
  postRelease,
  readHold,
  resetHoldPorts,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
} from "./pos-qris-hold-test-helpers.ts";
import { BILL_IDR, releaseKit } from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });
const MARGIN_MS = 60_000;

describe("so-889 P2-1 manager release with the guest's money parked open", () => {
  let fx: HoldFixture;
  let kit: ReturnType<typeof releaseKit>;
  beforeAll(async () => {
    fx = await holdFixture("qris-hold-so889-p2-release");
    kit = releaseKit(fx);
  });
  afterAll(async () => {
    resetHoldPorts();
  });

  async function backdate(intentId: string) {
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 minute'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId, HOLD_RELEASE_AFTER_MIN + 1],
    );
  }

  it("a release is refused 409 FUNDS_UNRESOLVED while a mismatched payment is parked open; the hold and tender stay", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    // The guest pays Rp 30.000 for a Rp 33.000 QR: parked, never applied.
    try {
      await payNotice(fx, qr.intentId, 30_000, new Date(), qr.providerRef!);
    } catch (error) {
      const e = error as { status?: unknown };
      if (e?.status !== 409) throw error;
    }
    const parked = await unallocatedFunds(fx, qr.intentId);
    expect(parked.map((p) => p.amountIdr)).toEqual([30_000]);
    expect(parked[0]!.resolution).toBeNull();

    await postCancel(fx, order.id);
    await backdate(qr.intentId);
    const approval = await kit.managerApproval(order.id, BILL_IDR);
    const refused = await postRelease(fx, order.id, approval);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(JSON.stringify(refused.body)).toContain("FUNDS_UNRESOLVED");

    const hold = await readHold(fx, order.id);
    expect(hold?.state, "the hold is not closed").not.toBe("closed");
    expect(
      (await tenderStatuses(fx, order.id)).map((t) => t.status),
      "the tender is not voided",
    ).not.toContain("voided");
  });

  it("control: a release with no parked money still works", async () => {
    await kit.forceRelease({ rawStatus: "01" });
  });
});

describe("so-889 P2-2 gateway cancel is not proof", () => {
  let fx: HoldFixture;
  let cancels: string[];
  beforeAll(async () => {
    fx = await holdFixture("qris-hold-so889-p2-cancel");
    enableVaBank(fx.gateway);
    cancels = [];
    const port: PaymentGatewayPort = fx.gateway;
    port.cancel = async (_context, intent) => {
      cancels.push(intent.intentId);
    };
    setPaymentGateway(fx.gateway);
  });
  afterAll(async () => {
    resetHoldPorts();
  });

  async function finalAt(intentId: string) {
    const { rows } = await owner.query<{
      status: string;
      provider_final_at: Date | null;
    }>(
      "SELECT status, provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, intentId],
    );
    return rows[0]!;
  }

  it.each([
    { name: "still pending", answer: { status: "pending" as const } },
    {
      name: "expired before the code lapsed",
      answer: { status: "expired" as const },
    },
  ])(
    "a cancel that resolves while the provider says $name leaves provider_final_at NULL",
    async ({ answer }) => {
      const opened = await createPaymentLink(
        fx.context,
        {
          outletId: fx.tenant.outletId as OutletId,
          reference: `P2-${randomUUID().slice(0, 8)}`,
          tableLabel: "A03",
          pax: 2,
          subtotalIdr: 50_000,
          discountIdr: 0,
          serviceChargeIdr: 0,
          taxIdr: 0,
          roundingIdr: 0,
          totalIdr: 50_000,
          returnPath: "/t/v1.abc",
        },
        fx.staff.userId,
      );
      const intents = `/api/payments/links/${opened.token}/intents`;
      const first = await agent(fx.app).post(intents).send({
        method: "qris",
        channelCode: null,
        idempotencyKey: randomUUID(),
      });
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const oldId = first.body.data.id as string;
      fx.gateway.script(oldId, answer);

      // A second code supersedes the first and asks the provider to cancel it.
      const second = await agent(fx.app).post(intents).send({
        method: "qris",
        channelCode: null,
        idempotencyKey: randomUUID(),
      });
      expect(second.status, JSON.stringify(second.body)).toBe(201);

      expect(cancels, "the gateway cancel ran for the old code").toContain(
        oldId,
      );
      const row = await finalAt(oldId);
      expect(row.status).toBe("expired");
      expect(
        row.provider_final_at,
        "a resolved cancel alone is not proof the code is dead",
      ).toBeNull();
    },
  );
});

describe("so-889 gap: a failed code stays live until expires_at + margin", () => {
  let fx: HoldFixture;
  beforeAll(async () => {
    fx = await holdFixture("qris-hold-so889-p2-failed", {
      provider: "duitku",
    });
    enableVaBank(fx.gateway);
    setPaymentGateway(fx.gateway);
  });
  afterAll(async () => {
    resetHoldPorts();
  });

  function va(guest: Awaited<ReturnType<HoldFixture["newGuest"]>>, id: string) {
    return fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: id },
      method: "va",
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });
  }

  it("Duitku 02 at minute 5 of 30 keeps the code live: replacement VA 409; after expires_at + 61 s it is allowed", async () => {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const first = await va(guest, order.id);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const intentId = first.body.data.id as string;
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() + interval '25 minutes'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId],
    );

    // Duitku answers 02 at minute 5: the intent fails, not final.
    await applyGatewayFailure(fx.context, intentId, "failed", new Date(), "02");
    const { rows } = await owner.query<{
      status: string;
      provider_final_at: Date | null;
    }>(
      "SELECT status, provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, intentId],
    );
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.provider_final_at).toBeNull();

    const early = await va(guest, order.id);
    expect(early.status, JSON.stringify(early.body)).toBe(409);

    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 millisecond'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId, MARGIN_MS + 1_000],
    );
    // SO-896: local time never kills the code. Past the margin it is still
    // live while the provider has not answered final (pending here).
    const later = await va(guest, order.id);
    expect(later.status, JSON.stringify(later.body)).toBe(409);

    // The provider's final answer (02, past the margin) frees it.
    fx.gateway.script(intentId, { rawStatus: "02" });
    await pollPendingGatewayIntents(
      fx.context,
      new Date(Date.now() + 2 * 60 * 60_000),
      200,
    );
    const freed = await va(guest, order.id);
    expect(freed.status, JSON.stringify(freed.body)).toBe(201);
  });
});
