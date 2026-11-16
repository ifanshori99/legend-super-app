// legend SO-896 (second opinion akhir area QRIS hold + architect review): a
// `failed` code the provider never declared final is still collectible.
//
// Cards ad95t + xg6qk:
//  (a) the poll and the hold check also read a `failed` code (provider ref, no
//      `provider_final_at`, hold not closed). A paid answer for it is recorded
//      (or parked) exactly once, also when the webhook was lost.
//  (b) local time never kills a code: a `failed` code stays live past
//      `expires_at` + 60 s while the provider says pending, errors, or answers
//      about another reference. Only the provider's final answer (or
//      reconciliation) frees it. A code whose parked money was already
//      resolved is live too; open money is a different guard
//      (`FUNDS_UNRESOLVED`). The verified webhook marks a `failed` + final code.
//  (c) a final answer must be about THIS intent's reference.
//  (d) a poll run releases the lease of every row it claimed.
//
// Assumptions:
// - A bill of the cashier fixture is Rp 33.000; the mismatch pays Rp 10.000.
// - A refused replacement is HTTP 409.
// - "past the margin" = `expires_at` moved to 61 s in the past.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qris-hold-so896-poll-failed.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eventEnvelopeSchema } from "@starter/shared/events";
import { handlePosPaymentPaid } from "../services/pos-order-payment.ts";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import {
  applyGatewayFailure,
  holdGatewayAmountMismatch,
  pollPendingGatewayIntents,
  settleGatewayIntentNow,
} from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  assertInvariants,
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  readHold,
  resetHoldPorts,
  runHoldCheck,
  tenderStatuses,
  unallocatedFunds,
  type HoldFixture,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });
const MARGIN_MS = 60_000;

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

describe.each([
  {
    provider: "doit",
    raw: undefined as string | undefined,
    dead: { status: "expired" } satisfies ProviderAnswer,
  },
  {
    provider: "duitku",
    raw: "02" as string | undefined,
    dead: { rawStatus: "02" } satisfies ProviderAnswer,
  },
])("so-896 $provider failed code stays live until final", (cfg) => {
  let fx: HoldFixture;
  beforeAll(async () => {
    fx = await holdFixture(`qris-hold-so896-${cfg.provider}`, {
      provider: cfg.provider,
    });
    enableVaBank(fx.gateway);
    setPaymentGateway(fx.gateway);
  });
  afterAll(async () => {
    resetHoldPorts();
  });

  async function intentRow(intentId: string) {
    const { rows } = await owner.query<{
      status: string;
      provider_final_at: Date | null;
      gateway_poll_lease_until: Date | null;
    }>(
      `SELECT status, provider_final_at, gateway_poll_lease_until
         FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId],
    );
    return rows[0]!;
  }

  async function pastMargin(intentId: string) {
    await owner.query(
      `UPDATE payment_intents SET expires_at = now() - $3::int * interval '1 millisecond'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId, MARGIN_MS + 1_000],
    );
  }

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
    return { guest, order, intentId: res.body.data.id as string };
  }

  function replace(guest: Guest, orderId: string, method: "qris" | "va") {
    return fx.guestPost(guest, "/payments", {
      target: { kind: "order", orderId },
      method,
      ...(method === "va" ? { bankCode: "bmri" } : {}),
      idempotencyKey: randomUUID(),
    });
  }

  // Each run is later than the last: past the poll's grace for a fresh code
  // and past the backoff between two asks about a lapsed code.
  let pollClock = Date.now();
  function poll() {
    pollClock += 2 * 60 * 60_000;
    return pollPendingGatewayIntents(fx.context, new Date(pollClock), 200);
  }

  async function expectBothReplacementsRefused(a: {
    guest: Guest;
    order: { id: string };
  }) {
    expect((await replace(a.guest, a.order.id, "va")).status).toBe(409);
    expect((await replace(a.guest, a.order.id, "qris")).status).toBe(409);
  }

  it("failed before expiry, then past the margin with the provider pending / down / answering another reference: still live, replacement refused; a final answer frees it", async () => {
    const a = await openVa();
    await applyGatewayFailure(
      fx.context,
      a.intentId,
      "failed",
      new Date(),
      cfg.raw,
    );
    let row = await intentRow(a.intentId);
    expect(row.status).toBe("failed");
    expect(row.provider_final_at, "an early failed is not final").toBeNull();

    await pastMargin(a.intentId);
    const answers: ProviderAnswer[] = [
      { rawStatus: "01" },
      { error: "timeout" },
      { otherReference: true },
    ];
    for (const answer of answers) {
      fx.gateway.script(a.intentId, answer);
      const reads = fx.gateway.readsOf(a.intentId).length;
      await poll();
      expect(
        fx.gateway.readsOf(a.intentId).length,
        `the poll asks the provider about the failed code (${JSON.stringify(answer)})`,
      ).toBeGreaterThan(reads);
      row = await intentRow(a.intentId);
      expect(row.status).toBe("failed");
      expect(
        row.provider_final_at,
        `local time / a foreign reference is no proof (${JSON.stringify(answer)})`,
      ).toBeNull();
      await expectBothReplacementsRefused(a);
    }

    fx.gateway.script(a.intentId, cfg.dead);
    await poll();
    expect((await intentRow(a.intentId)).provider_final_at).not.toBeNull();
    const next = await replace(a.guest, a.order.id, "qris");
    expect(next.status, JSON.stringify(next.body)).toBe(201);
  });

  it("a verified failed webhook after the margin marks a failed code final", async () => {
    const a = await openVa();
    await applyGatewayFailure(
      fx.context,
      a.intentId,
      "failed",
      new Date(),
      cfg.raw,
    );
    expect((await intentRow(a.intentId)).provider_final_at).toBeNull();
    await pastMargin(a.intentId);
    expect((await replace(a.guest, a.order.id, "va")).status).toBe(409);

    await applyGatewayFailure(
      fx.context,
      a.intentId,
      "failed",
      new Date(),
      cfg.raw,
    );
    expect(
      (await intentRow(a.intentId)).provider_final_at,
      "failed + final answer",
    ).not.toBeNull();
    expect((await replace(a.guest, a.order.id, "va")).status).toBe(201);
  });

  it("a mismatch whose parked money was already resolved does not block, but the code stays live until final", async () => {
    const a = await openVa();
    const { rows: refs } = await owner.query<{ provider_ref: string }>(
      "SELECT provider_ref FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, a.intentId],
    );
    const held = await holdGatewayAmountMismatch(
      fx.context,
      a.intentId,
      {
        providerRef: `${refs[0]!.provider_ref}-paid-${randomUUID().slice(0, 8)}`,
        paidAmountIdr: 10_000,
        source: "webhook",
      },
      new Date(),
    );
    expect(held.intentStatus).toBe("failed");
    // Open money: the guest must not be asked again.
    const open = await replace(a.guest, a.order.id, "va");
    expect(open.status, JSON.stringify(open.body)).toBe(409);
    expect(open.body.error.code).toBe("FUNDS_UNRESOLVED");

    // The money went back (resolved), but the provider never declared the code
    // dead: it can still be paid, so no replacement code yet.
    await owner.query(
      `UPDATE payment_unallocated_funds
          SET resolution='refund', resolved_by=$3, resolved_at=now()
        WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, a.intentId, fx.staff.userId],
    );
    await pastMargin(a.intentId);
    fx.gateway.script(a.intentId, { rawStatus: "01" });
    await poll();
    expect((await intentRow(a.intentId)).provider_final_at).toBeNull();
    await expectBothReplacementsRefused(a);

    fx.gateway.script(a.intentId, cfg.dead);
    await poll();
    expect((await intentRow(a.intentId)).provider_final_at).not.toBeNull();
    expect((await replace(a.guest, a.order.id, "va")).status).toBe(201);
  });

  it("(c) an answer about another reference never marks a code final: locally expired, pending past expiry", async () => {
    // A locally expired (superseded) code, polled past the margin.
    const expired = await openVa();
    fx.gateway.script(expired.intentId, cfg.dead);
    await owner.query(
      `UPDATE payment_intents SET status='expired', updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, expired.intentId],
    );
    await pastMargin(expired.intentId);
    fx.gateway.script(expired.intentId, { otherReference: true });
    await poll();
    expect(
      (await intentRow(expired.intentId)).provider_final_at,
      "expired code, foreign reference",
    ).toBeNull();
    expect((await replace(expired.guest, expired.order.id, "va")).status).toBe(
      409,
    );

    // A pending code past its expiry.
    const pending = await openVa();
    await pastMargin(pending.intentId);
    fx.gateway.script(pending.intentId, { otherReference: true });
    await poll();
    const row = await intentRow(pending.intentId);
    expect(row.provider_final_at, "pending code, foreign reference").toBeNull();
    expect((await replace(pending.guest, pending.order.id, "va")).status).toBe(
      409,
    );
  });

  it("(d) a poll run frees the lease of every row it claimed, also the ones its error budget skipped", async () => {
    const opened = [] as string[];
    for (let i = 0; i < 5; i += 1) {
      const a = await openVa();
      await applyGatewayFailure(
        fx.context,
        a.intentId,
        "failed",
        new Date(),
        cfg.raw,
      );
      fx.gateway.script(a.intentId, { error: "5xx" });
      opened.push(a.intentId);
    }
    await poll();
    for (const id of opened)
      expect(
        (await intentRow(id)).gateway_poll_lease_until,
        "lease released",
      ).toBeNull();
  });
});

describe("so-896 failed then paid with the webhook lost (POS QRIS hold)", () => {
  let fx: HoldFixture;
  beforeAll(async () => {
    fx = await holdFixture("qris-hold-so896-paid");
  });
  afterAll(async () => {
    resetHoldPorts();
    await owner.end();
  });

  async function deliverPaidEvents(intentId: string) {
    const { rows } = await owner.query<{ event: unknown }>(
      `SELECT event FROM domain_event_outbox WHERE tenant_id=$1
         AND event->>'name'='payment.paid' AND event->'payload'->>'intentId'=$2
        ORDER BY created_at, id`,
      [fx.tenant.tenantId, intentId],
    );
    for (const row of rows) {
      const event = eventEnvelopeSchema.parse(row.event);
      await handlePosPaymentPaid(fx.context, event);
      await handlePosPaymentPaid(fx.context, event);
    }
  }

  async function evidenceCount(intentId: string) {
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_evidence
        WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, intentId],
    );
    return rows[0]!.n;
  }

  it("a failed attempt, then the guest pays the same QR: poll and hold check, repeated, record one payment and finish the hold", async () => {
    const order = await newSubmittedOrder(fx, 0);
    const qr = await issueQris(fx, order.id);
    // A `failed` answer before the code lapsed: not final, the hold stays.
    await applyGatewayFailure(fx.context, qr.intentId, "failed", new Date());
    const { rows } = await owner.query<{
      status: string;
      provider_final_at: Date | null;
    }>(
      "SELECT status, provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, qr.intentId],
    );
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.provider_final_at).toBeNull();
    expect((await readHold(fx, order.id))?.state).toBe("open");

    // The guest retries and pays; the webhook is lost.
    fx.gateway.script(qr.intentId, { rawStatus: "00", amountIdr: 33_000 });
    await pollPendingGatewayIntents(fx.context, new Date(), 50);
    await runHoldCheck(fx);
    await settleGatewayIntentNow(fx.context, qr.intentId);
    await pollPendingGatewayIntents(fx.context, new Date(), 50);
    await runHoldCheck(fx);
    await deliverPaidEvents(qr.intentId);

    const after = await owner.query<{ status: string }>(
      "SELECT status FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, qr.intentId],
    );
    expect(after.rows[0]!.status).toBe("paid");
    expect(await evidenceCount(qr.intentId), "one evidence row").toBe(1);
    expect(await capturedIdr(fx, order.id)).toBe(33_000);
    expect((await tenderStatuses(fx, order.id)).map((t) => t.status)).toEqual([
      "captured",
    ]);
    expect(await unallocatedFunds(fx, qr.intentId)).toEqual([]);
    expect((await readHold(fx, order.id))?.state).toBe("paid");
    await assertInvariants(fx, order.id);
  });
});
