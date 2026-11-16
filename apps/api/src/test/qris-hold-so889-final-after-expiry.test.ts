// legend SO-889 (architect review of D-03, docs/design/qris-dp-intent.md): a
// provider answer "expired" / "failed" (Duitku raw `02`) proves a code dead only
// once the code lapsed on its own: `now >= expires_at + 60 s`. Before that a
// failed attempt may be retried on the same code, so the guest can still pay.
//
// Money scenario: Duitku `02` at minute 5 of 30 -> the DP close passes or a VA
// replacement code opens while the old code is still payable -> the guest pays
// twice, or money lands on a closed bill.
//
// Four paths used to mark `provider_final_at` (or accept the answer) early:
//  (a) strict DP close `confirmDepositLinkUnpaidAtProvider`
//  (b) the poll of a `pending` code answered `expired` before its expiry
//  (c) the poll of a locally `expired` code (`markGatewayReconciled`)
//  (d) the verified webhook outcome (`applyGatewayFailure`)
// Money reported PAID is not time gated (see the last test).
//
// Assumptions:
// - Refusal is HTTP 409; the DP close throws 409 PAYMENT_PROVIDER_UNCONFIRMED.
// - "Before" = 30 s before `expires_at`; "after" = `expires_at` + 61 s.
// - Duitku proves death with raw `02`; DOIT with mapped `expired` / `failed`.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so889-final-after-expiry.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import { confirmDepositLinkUnpaidAtProvider } from "../services/payment-provider-proof.ts";
import {
  applyGatewayFailure,
  pollPendingGatewayIntents,
} from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  holdFixture,
  resetHoldPorts,
  type HoldFixture,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 120_000 });
const MARGIN_MS = 60_000;

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

async function intentRow(fx: HoldFixture, intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_final_at: Date | null;
    expires_at: Date;
    payment_link_id: string;
  }>(
    `SELECT status, provider_final_at, expires_at, payment_link_id::text AS payment_link_id
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

describe.each([
  {
    provider: "doit",
    dead: { status: "expired" } satisfies ProviderAnswer,
    failed: { status: "failed" } satisfies ProviderAnswer,
  },
  {
    provider: "duitku",
    dead: { rawStatus: "02" } satisfies ProviderAnswer,
    failed: { rawStatus: "02" } satisfies ProviderAnswer,
  },
])("so-889 $provider answer final only after expires_at + margin", (cfg) => {
  let fx: HoldFixture;
  beforeAll(async () => {
    fx = await holdFixture(`qris-hold-so889-final-${cfg.provider}`, {
      provider: cfg.provider,
    });
    enableVaBank(fx.gateway);
    setPaymentGateway(fx.gateway);
  });
  afterAll(async () => {
    resetHoldPorts();
  });

  async function openVa() {
    const guest: Guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const res = await fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId: order.id },
      method: "va",
      bankCode: "bmri",
      idempotencyKey: randomUUID(),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const intentId = res.body.data.id as string;
    const row = await intentRow(fx, intentId);
    return {
      guest,
      order,
      intentId,
      linkId: row.payment_link_id,
      before: new Date(row.expires_at.getTime() - 30_000),
      after: new Date(row.expires_at.getTime() + MARGIN_MS + 1_000),
    };
  }

  function replace(guest: Guest, orderId: string, method: "qris" | "va") {
    return fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId },
      method,
      ...(method === "va" ? { bankCode: "bmri" } : {}),
      idempotencyKey: randomUUID(),
    });
  }

  function poll(now: Date) {
    return pollPendingGatewayIntents(fx.context, now, 200);
  }

  async function expectDpCloseRefused(linkId: string, now: Date) {
    await expect(
      confirmDepositLinkUnpaidAtProvider(fx.context, linkId, now),
    ).rejects.toMatchObject({
      status: 409,
      code: "PAYMENT_PROVIDER_UNCONFIRMED",
    });
  }

  it("poll (b)(c) + DP close (a): early answer keeps provider_final_at NULL, close and replacement refused; after the margin all allowed", async () => {
    const a = await openVa();
    fx.gateway.script(a.intentId, cfg.dead);

    // (b) a pending code answered expired/02 before its expiry.
    await poll(a.before);
    let row = await intentRow(fx, a.intentId);
    expect(row.status).toBe("expired");
    expect(row.provider_final_at, "(b) early answer is not final").toBeNull();
    // (c) the poll of the now locally expired code keeps asking, no proof.
    const reads = fx.gateway.readsOf(a.intentId).length;
    await poll(a.before);
    expect(fx.gateway.readsOf(a.intentId).length).toBeGreaterThan(reads);
    row = await intentRow(fx, a.intentId);
    expect(row.provider_final_at, "(c) early answer is not final").toBeNull();

    // (a) DP close and a replacement code are refused.
    await expectDpCloseRefused(a.linkId, a.before);
    expect((await replace(a.guest, a.order.id, "va")).status).toBe(409);
    expect((await replace(a.guest, a.order.id, "qris")).status).toBe(409);

    // Inside the margin it is still no proof.
    const inMargin = new Date(row.expires_at.getTime() + 10_000);
    await poll(inMargin);
    expect((await intentRow(fx, a.intentId)).provider_final_at).toBeNull();
    await expectDpCloseRefused(
      a.linkId,
      new Date(row.expires_at.getTime() + MARGIN_MS - 1_000),
    );

    // After expires_at + margin the same answer is final.
    await poll(a.after);
    row = await intentRow(fx, a.intentId);
    expect(row.provider_final_at, "final after the margin").not.toBeNull();
    await expect(
      confirmDepositLinkUnpaidAtProvider(fx.context, a.linkId, a.after),
    ).resolves.toMatchObject({ verdict: "unpaid" });
    const next = await replace(a.guest, a.order.id, "qris");
    expect(next.status, JSON.stringify(next.body)).toBe(201);
  });

  it("webhook (d) on a locally expired code: early failure keeps provider_final_at NULL; after the margin it is final", async () => {
    const a = await openVa();
    fx.gateway.script(a.intentId, cfg.dead);
    await poll(a.before);
    expect((await intentRow(fx, a.intentId)).status).toBe("expired");

    // Duitku's webhook carries the raw code it read; DOIT only the outcome.
    const raw = cfg.provider === "duitku" ? "02" : undefined;
    await applyGatewayFailure(fx.context, a.intentId, "failed", a.before, raw);
    await applyGatewayFailure(fx.context, a.intentId, "expired", a.before, raw);
    expect(
      (await intentRow(fx, a.intentId)).provider_final_at,
      "(d) early webhook is not final",
    ).toBeNull();
    expect((await replace(a.guest, a.order.id, "va")).status).toBe(409);
    await expectDpCloseRefused(a.linkId, a.before);

    await applyGatewayFailure(fx.context, a.intentId, "failed", a.after, raw);
    expect(
      (await intentRow(fx, a.intentId)).provider_final_at,
      "final after the margin",
    ).not.toBeNull();
    expect((await replace(a.guest, a.order.id, "va")).status).toBe(201);
  });

  it("webhook (d) on a pending code answered failed early: not final, DP close refused; after the margin the close is allowed", async () => {
    const a = await openVa();
    const raw = cfg.provider === "duitku" ? "02" : undefined;
    await applyGatewayFailure(fx.context, a.intentId, "failed", a.before, raw);
    const row = await intentRow(fx, a.intentId);
    expect(row.status).toBe("failed");
    expect(row.provider_final_at, "early failed is not final").toBeNull();

    fx.gateway.script(a.intentId, cfg.failed);
    await expectDpCloseRefused(a.linkId, a.before);
    await expect(
      confirmDepositLinkUnpaidAtProvider(fx.context, a.linkId, a.after),
    ).resolves.toMatchObject({ verdict: "unpaid" });
  });

  it("paid is never time gated: a paid answer before expiry settles the bill once", async () => {
    const a = await openVa();
    fx.gateway.script(a.intentId, cfg.dead);
    await poll(a.before);
    expect((await intentRow(fx, a.intentId)).provider_final_at).toBeNull();

    fx.gateway.script(
      a.intentId,
      cfg.provider === "duitku" ? { rawStatus: "00" } : { status: "paid" },
    );
    await poll(a.before);
    expect((await intentRow(fx, a.intentId)).status).toBe("paid");
    const { rows: funds } = await owner.query(
      "SELECT 1 FROM payment_unallocated_funds WHERE tenant_id=$1 AND payment_intent_id=$2",
      [fx.tenant.tenantId, a.intentId],
    );
    expect(funds).toEqual([]);
  });
});
