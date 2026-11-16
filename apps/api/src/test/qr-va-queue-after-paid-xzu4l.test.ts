// legend-xzu4l (908): the release reconciliation queues keep watching a code
// after the first "paid" was recorded, for BOTH kinds:
//   - VA: queue 906 (payment_va_releases, worker payment-va-release-recon.job)
//   - QR: queue Q93 (pos_qris_release_reconciliations, worker
//     pos-qris-release-recon.job)
//
// Rules under test (docs/briefs/908-queue-after-paid.md, written from the
// brief, not from the implementation):
// - "paid" is NOT a closing answer. The row stays open (last_provider_status
//   "paid") until: a final provider answer (expired/failed at/after
//   expires_at + 60 s), 72 h after the row opened AND the answer before was
//   "paid" too, or the hard cap (row created + 7 days). The row opens after the
//   code lapsed (>= 30 min), so the code's expiry alone closes nothing.
//   When it closes after money was recorded, resolution is "paid_recorded".
//   Only a real final provider answer marks the VA intent provider_final_at.
// - Every further provider transaction on the same code, reported through the
//   new optional `extraPayments` of GatewayPaymentStatus, is parked as
//   unallocated funds exactly once per provider transaction (identity =
//   provider ref). It never settles the order. An amount <= 0 parks nothing.
// - Poll + webhook of the same provider ref are ONE fund.
// - Open parked funds block every new tender (409 FUNDS_UNRESOLVED).
//
// Assumptions:
// - The queue is polled with the injected `now` (force:true ignores
//   next_check_at). Intent expires_at is moved explicitly after the release
//   (UPDATE) so "before" and "after expires_at + 60 s" are exact; the 7 day cap
//   counts from the queue row's real creation time (the test starts the clock
//   at real "now").
// - A final provider answer (expired) after money was recorded closes the row;
//   the brief says resolution "paid_recorded" when money was recorded, the old
//   code said "provider_expired": either is accepted, the row must be resolved.
// - The Duitku shape "another reference paid" = primary status "pending" plus
//   extraPayments (brief point 1).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qr-va-queue-after-paid-xzu4l.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import type { GatewayPaymentStatus } from "../services/payment-gateway.ts";
import {
  confirmPayment,
  holdGatewayAmountMismatch,
} from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  issueQris,
  payNotice,
  requestQris,
  resetHoldPorts,
  tryImport,
  unallocatedFunds,
  type HoldFixture,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import {
  evidenceRows,
  outboxCountOf,
  reconRows,
  releaseKit,
  runRecon,
} from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

const RELEASE_AFTER_MIN = 30;
const REASON = "Bank tidak menjawab status VA lebih dari sehari";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EXTRA_IDR = 12_345;

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;

type Extra = NonNullable<GatewayPaymentStatus["extraPayments"]>[number];
/** Extra provider transactions reported with the status of a code (by the
 * code's own provider ref), layered over the scripted gateway. */
const extrasByRef = new Map<string, Extra[]>();

beforeAll(async () => {
  fx = await holdFixture("qr-va-queue-after-paid-xzu4l");
  enableVaBank(fx.gateway);
  const port = fx.gateway as unknown as {
    getStatus(input: {
      providerRef: string;
      intentId?: string;
    }): Promise<GatewayPaymentStatus>;
  };
  const original = port.getStatus.bind(fx.gateway);
  port.getStatus = async (input) => {
    const base = await original(input);
    const extras = extrasByRef.get(input.providerRef);
    return extras ? { ...base, extraPayments: extras } : base;
  };
  setPaymentGateway(fx.gateway);
  kit = releaseKit(fx);
});
afterAll(async () => {
  extrasByRef.clear();
  resetHoldPorts();
  await owner.end();
});

// ---------------------------------------------------------------- shared bits

type Subject = {
  intentId: string;
  providerRef: string;
  amount: number;
  orderId: string;
  /** VA only: payment link of the order (paid_idr = what settled the bill). */
  linkId?: string;
  /** VA only: the guest that owns the order. */
  guest?: Awaited<ReturnType<HoldFixture["newGuest"]>>;
  /** Real "now" at the moment the code was released. */
  t0: Date;
};

type RowView = {
  status: string;
  attempts: number;
  lastProviderStatus: string | null;
  resolution: string | null;
};

type Kind = {
  label: "VA" | "QR";
  /** A released code, provider still pending, expires_at 10 min after t0. */
  open(): Promise<Subject>;
  recon(now: Date): Promise<unknown>;
  row(s: Subject): Promise<RowView>;
  /** Money applied to the order (0 = the order is still unpaid). */
  settled(s: Subject): Promise<number>;
  /** A verified webhook "paid" for the code's own provider ref (errors such as
   * BILL_CLOSED are swallowed: the caller asserts the effect). */
  webhookPrimary(s: Subject, now?: Date): Promise<void>;
  /** The replacement code of the same order is paid (settles the bill once). */
  payReplacement(s: Subject): Promise<void>;
  /** A new tender on the order is refused with 409 FUNDS_UNRESOLVED. */
  expectNewTenderBlocked(s: Subject): Promise<void>;
};

async function setExpiry(intentId: string, expiresAt: Date) {
  await owner.query(
    "UPDATE payment_intents SET expires_at = $3 WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId, expiresAt],
  );
}

async function intentExpiry(intentId: string): Promise<Date> {
  const { rows } = await owner.query<{ expires_at: Date }>(
    "SELECT expires_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.expires_at;
}

const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** The code lapsed on its own. A VA whose expiry is still ahead is returned as
 * the live code by a repeated request (qr-order-payment), so tests that ask
 * for a replacement tender lapse it first. */
const lapse = (s: Subject) => setExpiry(s.intentId, after(s.t0, -1 * MIN));

function extra(amountIdr: number = EXTRA_IDR, ref = `EXTRA-${randomUUID()}`) {
  return { providerRef: ref, amountIdr } satisfies Extra;
}

function answer(s: Subject, provider: ProviderAnswer, extras?: Extra[]) {
  fx.gateway.script(s.intentId, provider);
  if (extras) extrasByRef.set(s.providerRef, extras);
  else extrasByRef.delete(s.providerRef);
}

async function funds(s: Subject) {
  return (await unallocatedFunds(fx, s.intentId))
    .map((f) => f.amountIdr)
    .sort((a, b) => a - b);
}

/** Every provider transaction parked once: one fund, one evidence row and one
 * `payment.funds_unallocated` event per amount, none resolved by itself. */
async function expectParked(s: Subject, amounts: number[]) {
  const expected = [...amounts].sort((a, b) => a - b);
  expect(await funds(s)).toEqual(expected);
  expect(await evidenceRows(fx, s.intentId)).toHaveLength(expected.length);
  expect(await outboxCountOf(fx, "payment.funds_unallocated", s.intentId)).toBe(
    expected.length,
  );
}

/** The intent was marked final by the provider (`provider_final_at`). */
async function providerFinal(s: Subject): Promise<boolean> {
  const { rows } = await owner.query<{ final_at: Date | null }>(
    "SELECT provider_final_at AS final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, s.intentId],
  );
  return rows[0]!.final_at !== null;
}

const reads = (s: Subject) => fx.gateway.readsOf(s.intentId).length;

// ------------------------------------------------------------------ VA kind

type VaGuest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

function vaReplace(guest: VaGuest, orderId: string, method: "qris" | "va") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey: randomUUID(),
  });
}

async function vaWebhook(
  intentId: string,
  amountIdr: number,
  providerRef: string,
  now: Date = new Date(),
) {
  try {
    await confirmPayment(
      fx.context,
      intentId,
      {
        source: "verified_webhook",
        method: "va",
        amountIdr,
        providerRef,
        at: now.toISOString(),
      },
      { type: "system" },
      now,
    );
  } catch {
    /* BILL_CLOSED on a released code: parked, asserted by the caller */
  }
}

async function runVaRecon(now: Date) {
  const job = await tryImport<{
    runPaymentVaReleaseReconJob?: (
      context: ScopedTenantContext,
      now?: Date,
      options?: { force?: boolean },
    ) => Promise<unknown>;
  }>("../worker/payment-va-release-recon.job.ts", "VA release recon job");
  if (typeof job.runPaymentVaReleaseReconJob !== "function")
    throw new Error(
      "worker/payment-va-release-recon.job.ts must export runPaymentVaReleaseReconJob(context, now, { force })",
    );
  return job.runPaymentVaReleaseReconJob(fx.context, now, { force: true });
}

const vaKind: Kind = {
  label: "VA",
  async open() {
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const created = await vaReplace(guest, order.id, "va");
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const intentId = created.body.data.id as string;
    const { rows } = await owner.query<{
      amount: number;
      provider_ref: string;
      payment_link_id: string;
    }>(
      `SELECT amount_idr::int AS amount, provider_ref,
              payment_link_id::text AS payment_link_id
         FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId],
    );
    // Release it (supervisor override, provider pending), as legend-5wn1e.
    fx.gateway.script(intentId, { rawStatus: "01" });
    await owner.query(
      `UPDATE payment_intents
          SET expires_at = now() - $3::int * interval '1 minute'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId, RELEASE_AFTER_MIN + 1],
    );
    const approval = await kit.managerApproval(order.id, rows[0]!.amount);
    const released = await fx.post(`${fx.base}/${order.id}/va/release`, {
      paymentIntentId: intentId,
      ...approval,
      idempotencyKey: randomUUID(),
      reason: REASON,
    });
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    const t0 = new Date();
    await setExpiry(intentId, after(t0, 10 * MIN));
    return {
      intentId,
      providerRef: rows[0]!.provider_ref,
      amount: rows[0]!.amount,
      orderId: order.id,
      linkId: rows[0]!.payment_link_id,
      guest,
      t0,
    };
  },
  recon: runVaRecon,
  async row(s) {
    const { rows } = await owner.query<{
      status: string;
      attempts: number;
      last_provider_status: string | null;
      resolution: string | null;
    }>(
      `SELECT status, attempts, last_provider_status, resolution
         FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2
        ORDER BY created_at, id`,
      [fx.tenant.tenantId, s.intentId],
    );
    expect(rows, "exactly one release row").toHaveLength(1);
    const r = rows[0]!;
    return {
      status: r.status,
      attempts: r.attempts,
      lastProviderStatus: r.last_provider_status,
      resolution: r.resolution,
    };
  },
  async settled(s) {
    const { rows } = await owner.query<{ paid: number }>(
      "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, s.linkId],
    );
    return rows[0]!.paid;
  },
  async webhookPrimary(s, now) {
    await vaWebhook(s.intentId, s.amount, s.providerRef, now);
  },
  async payReplacement(s) {
    const next = await vaReplace(s.guest!, s.orderId, "va");
    expect(next.status, JSON.stringify(next.body)).toBe(201);
    const nextId = next.body.data.id as string;
    const { rows } = await owner.query<{
      amount: number;
      provider_ref: string;
    }>(
      "SELECT amount_idr::int AS amount, provider_ref FROM payment_intents WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, nextId],
    );
    await vaWebhook(nextId, rows[0]!.amount, rows[0]!.provider_ref);
    expect(await vaKind.settled(s), "replacement settled the bill").toBe(
      s.amount,
    );
  },
  async expectNewTenderBlocked(s) {
    for (const method of ["va", "qris"] as const) {
      const res = await vaReplace(s.guest!, s.orderId, method);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe("FUNDS_UNRESOLVED");
    }
  },
};

// ------------------------------------------------------------------ QR kind

const qrKind: Kind = {
  label: "QR",
  async open() {
    const { orderId, qr } = await kit.forceRelease({ rawStatus: "01" });
    const t0 = new Date();
    await setExpiry(qr.intentId, after(t0, 10 * MIN));
    return {
      intentId: qr.intentId,
      providerRef: qr.providerRef!,
      amount: qr.amountIdr,
      orderId,
      t0,
    };
  },
  recon: (now) => runRecon(fx, now),
  async row(s) {
    const rows = await reconRows(fx, s.intentId);
    expect(rows, "exactly one reconciliation row").toHaveLength(1);
    const r = rows[0]!;
    return {
      status: r.status,
      attempts: r.attempts,
      lastProviderStatus: r.last_provider_status,
      resolution: r.resolution,
    };
  },
  settled: (s) => capturedIdr(fx, s.orderId),
  async webhookPrimary(s, now) {
    await payNotice(fx, s.intentId, s.amount, now, s.providerRef).catch(
      () => null,
    );
  },
  async payReplacement(s) {
    const second = await issueQris(fx, s.orderId);
    await payNotice(fx, second.intentId, second.amountIdr);
    expect(await capturedIdr(fx, s.orderId), "replacement settled").toBe(
      s.amount,
    );
  },
  async expectNewTenderBlocked(s) {
    const res = await requestQris(fx, s.orderId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("FUNDS_UNRESOLVED");
  },
};

// -------------------------------------------------------------------- tests

describe.each([vaKind, qrKind])(
  "legend-xzu4l $label queue keeps watching after paid",
  (kind) => {
    const name = (text: string) => `legend-xzu4l ${kind.label} ${text}`;

    it(
      name("first paid is recorded once; the row stays open and keeps asking"),
      async () => {
        const s = await kind.open();
        answer(s, { status: "paid" });

        await kind.recon(after(s.t0, 1 * MIN));
        await expectParked(s, [s.amount]);
        expect(await kind.row(s)).toMatchObject({
          status: "open",
          lastProviderStatus: "paid",
          resolution: null,
        });
        expect(await kind.settled(s), "released code never settles").toBe(0);

        // Still before expires_at + 60 s: asked again, nothing new recorded.
        const before = reads(s);
        await kind.recon(after(s.t0, 2 * MIN));
        expect(reads(s)).toBe(before + 1);
        await expectParked(s, [s.amount]);
        expect((await kind.row(s)).status).toBe("open");
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name(
        "a second provider transaction (extraPayments) is parked exactly once across repeated polls; the order is not settled",
      ),
      async () => {
        const s = await kind.open();
        const second = extra();
        answer(s, { status: "paid" }, [second]);

        await kind.recon(after(s.t0, 1 * MIN));
        await expectParked(s, [s.amount, EXTRA_IDR]);
        for (const minute of [2, 3, 4]) {
          await kind.recon(after(s.t0, minute * MIN));
          await expectParked(s, [s.amount, EXTRA_IDR]);
        }
        expect(await kind.row(s)).toMatchObject({
          status: "open",
          lastProviderStatus: "paid",
        });
        expect(await kind.settled(s), "never settled by extra funds").toBe(0);

        // A third transaction appears later: parked once, the others untouched.
        const third = extra(7_000);
        answer(s, { status: "paid" }, [second, third]);
        await kind.recon(after(s.t0, 5 * MIN));
        await kind.recon(after(s.t0, 6 * MIN));
        await expectParked(s, [s.amount, EXTRA_IDR, 7_000]);
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name(
        "primary still pending but another provider reference paid: the extra is parked, the row stays open",
      ),
      async () => {
        const s = await kind.open();
        answer(s, { rawStatus: "01" }, [extra()]);

        await kind.recon(after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 2 * MIN));
        await expectParked(s, [EXTRA_IDR]);
        expect(await kind.row(s)).toMatchObject({
          status: "open",
          lastProviderStatus: "pending",
          resolution: null,
        });
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name(
        "poll and webhook of the same provider reference are one fund, in either order",
      ),
      async () => {
        const s = await kind.open();
        const second = extra();

        // Primary: webhook first (BILL_CLOSED, parked), then poll, then replay.
        await kind.webhookPrimary(s, after(s.t0, 30_000));
        await expectParked(s, [s.amount]);
        answer(s, { status: "paid" }, [second]);
        await kind.recon(after(s.t0, 1 * MIN));
        await kind.webhookPrimary(s, after(s.t0, 90_000));
        await kind.recon(after(s.t0, 2 * MIN));
        // The extra was parked by the poll; its own webhook is the replay.
        await holdGatewayAmountMismatch(
          fx.context,
          s.intentId,
          {
            providerRef: second.providerRef,
            paidAmountIdr: second.amountIdr,
            source: "webhook",
          },
          after(s.t0, 3 * MIN),
        );
        await kind.recon(after(s.t0, 4 * MIN));
        await expectParked(s, [s.amount, EXTRA_IDR]);

        // Extra: its webhook first, then the poll reports the same reference.
        const late = extra(9_000);
        await holdGatewayAmountMismatch(
          fx.context,
          s.intentId,
          {
            providerRef: late.providerRef,
            paidAmountIdr: late.amountIdr,
            source: "webhook",
          },
          after(s.t0, 5 * MIN),
        );
        answer(s, { status: "paid" }, [second, late]);
        await kind.recon(after(s.t0, 6 * MIN));
        await kind.recon(after(s.t0, 7 * MIN));
        await expectParked(s, [s.amount, EXTRA_IDR, 9_000]);
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name(
        "the order is never settled twice: a replacement settles it once, every old-code payment is only parked",
      ),
      async () => {
        const s = await kind.open();
        await lapse(s);
        await kind.payReplacement(s);

        answer(s, { status: "paid" }, [extra()]);
        await kind.recon(after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 2 * MIN));
        await expectParked(s, [s.amount, EXTRA_IDR]);
        expect(await kind.settled(s), "settled exactly once").toBe(s.amount);
      },
    );

    it(
      name(
        "an extra payment parks open funds that block a new tender (409 FUNDS_UNRESOLVED)",
      ),
      async () => {
        const s = await kind.open();
        answer(s, { rawStatus: "01" }, [extra()]);
        await kind.recon(after(s.t0, 1 * MIN));
        await expectParked(s, [EXTRA_IDR]);
        await lapse(s);
        await kind.expectNewTenderBlocked(s);
        // The refusal created nothing.
        await expectParked(s, [EXTRA_IDR]);
      },
    );

    it(
      name("an extra payment with amount 0 or less parks nothing"),
      async () => {
        const s = await kind.open();
        const zero = extra(0);
        const negative = extra(-500);

        // Primary pending: nothing at all is recorded.
        answer(s, { rawStatus: "01" }, [zero, negative]);
        await kind.recon(after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 2 * MIN));
        expect(await unallocatedFunds(fx, s.intentId)).toEqual([]);
        expect(await evidenceRows(fx, s.intentId)).toEqual([]);
        expect(
          await outboxCountOf(fx, "payment.funds_unallocated", s.intentId),
        ).toBe(0);
        expect((await kind.row(s)).status).toBe("open");

        // Primary paid: only the primary is parked, the empty extras add nothing.
        answer(s, { status: "paid" }, [zero, negative]);
        await kind.recon(after(s.t0, 3 * MIN));
        await expectParked(s, [s.amount]);
      },
    );

    it(
      name(
        "a row opened after the code lapsed: paid does not close it; 72 h after the row opened and a second paid answer resolves paid_recorded; not asked again",
      ),
      async () => {
        const s = await kind.open();
        // As in production: the row is created >= 30 min after the code lapsed.
        await setExpiry(s.intentId, after(s.t0, -31 * MIN));
        answer(s, { status: "paid" }, [extra()]);

        await kind.recon(after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 2 * MIN));
        await kind.recon(after(s.t0, 71 * HOUR));
        expect((await kind.row(s)).status).toBe("open");

        // 72 h but the answer before was not "paid": one more ask is needed.
        answer(s, { rawStatus: "01" }, [extra()]);
        await kind.recon(after(s.t0, 72 * HOUR + 10 * MIN));
        expect(await kind.row(s)).toMatchObject({
          status: "open",
          lastProviderStatus: "pending",
        });
        answer(s, { status: "paid" }, [extra()]);
        await kind.recon(after(s.t0, 73 * HOUR));
        expect((await kind.row(s)).status).toBe("open");

        const beforeClose = reads(s);
        await kind.recon(after(s.t0, 74 * HOUR));
        expect(reads(s)).toBe(beforeClose + 1);
        const closed = await kind.row(s);
        expect(closed.status).toBe("resolved");
        expect(closed.resolution).toBe("paid_recorded");
        expect(await providerFinal(s), "time based close is not final").toBe(
          false,
        );

        // A resolved row is not asked again and records nothing new.
        const parked = (await funds(s)).length;
        answer(s, { status: "paid" }, [extra(8_000)]);
        await kind.recon(after(s.t0, 75 * HOUR));
        await kind.recon(after(s.t0, 76 * HOUR));
        expect(reads(s)).toBe(beforeClose + 1);
        expect(await funds(s)).toHaveLength(parked);
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name("a final provider answer after the paid one closes the row"),
      async () => {
        const s = await kind.open();
        answer(s, { status: "paid" });
        await kind.recon(after(s.t0, 1 * MIN));
        expect((await kind.row(s)).status).toBe("open");

        // Before expires_at + 60 s a final-looking answer proves nothing (D-03):
        // the guest may still pay the code, so the row stays open.
        answer(s, { rawStatus: "02" });
        await kind.recon(after(s.t0, 2 * MIN));
        expect((await kind.row(s)).status).toBe("open");

        // The final answer asked after the code lapsed closes the row; money
        // was recorded, so the resolution stays paid_recorded.
        const expiresAt = await intentExpiry(s.intentId);
        await kind.recon(new Date(expiresAt.getTime() + 2 * MIN));
        const closed = await kind.row(s);
        expect(closed.status).toBe("resolved");
        expect(closed.resolution).toBe("paid_recorded");
        // Only the VA queue records `provider_final_at` (the QR queue has no
        // such column write).
        if (kind.label === "VA")
          expect(await providerFinal(s), "a real final answer is final").toBe(
            true,
          );
        await expectParked(s, [s.amount]);

        const before = reads(s);
        await kind.recon(new Date(expiresAt.getTime() + 3 * MIN));
        expect(reads(s)).toBe(before);
      },
    );

    it(
      name(
        "the hard cap (row created + 7 days) closes a row without a provider final answer; extra funds are not primary money",
      ),
      async () => {
        const s = await kind.open();
        await setExpiry(s.intentId, after(s.t0, 30 * DAY));
        // Only another provider reference paid; the code itself stays pending.
        answer(s, { rawStatus: "01" }, [extra()]);

        await kind.recon(after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 6 * DAY));
        expect((await kind.row(s)).status).toBe("open");
        await expectParked(s, [EXTRA_IDR]);

        await kind.recon(after(s.t0, 7 * DAY + 60 * MIN));
        const closed = await kind.row(s);
        expect(closed.status).toBe("resolved");
        // The parked extra is not money of this code.
        expect(closed.resolution).toBe("provider_expired");
        expect(await providerFinal(s), "hard cap is not a final answer").toBe(
          false,
        );
        await expectParked(s, [EXTRA_IDR]);

        const before = reads(s);
        await kind.recon(after(s.t0, 8 * DAY));
        expect(reads(s)).toBe(before);
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name(
        "the hard cap closes a recorded paid row as paid_recorded even when the answer before was not paid",
      ),
      async () => {
        const s = await kind.open();
        await setExpiry(s.intentId, after(s.t0, 30 * DAY));
        answer(s, { status: "paid" }, [extra()]);
        await kind.recon(after(s.t0, 1 * MIN));
        answer(s, { rawStatus: "01" });
        await kind.recon(after(s.t0, 6 * DAY));
        expect((await kind.row(s)).status).toBe("open");

        await kind.recon(after(s.t0, 7 * DAY + 60 * MIN));
        const closed = await kind.row(s);
        expect(closed.status).toBe("resolved");
        expect(closed.resolution).toBe("paid_recorded");
        expect(await providerFinal(s)).toBe(false);
        await expectParked(s, [s.amount, EXTRA_IDR]);
      },
    );
  },
);
