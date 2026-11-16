// legend-912 P1-3 (second opinion QRIS/VA 906-908): a MIXED provider answer must
// never be treated as final before every extra paid transaction is recorded.
// Both kinds: VA (payment_va_releases, payment-va-release-recon.job) and
// QR (pos_qris_release_reconciliations, pos-qris-release-recon.job).
//
// Rules under test (docs/briefs/912-3p1.md "P1-3", written from the brief and
// the SO proposal, not from the implementation):
// - The code's own answer is expired (raw 02) AND another provider transaction B
//   is reported paid with amount 0 (or less): B is NOT recorded (no fund, no
//   evidence, no `payment.funds_unallocated` event), the queue row stays OPEN,
//   the VA intent `provider_final_at` stays null, and staff get a warning
//   ("extra_funds_not_parked").
// - When a later check reports B with a positive amount: B is parked exactly once
//   as unallocated funds, the order is never settled, a replay adds no fund and
//   no event, and only then the row closes (final answer, VA provider_final_at
//   set).
// - Control: expired with NO extras closes the row as before.
//
// Assumptions:
// - The queue row is opened after the code lapsed (>= 30 min), as in production,
//   so the code's own "expired" is final once now >= expires_at + 60 s (test
//   moves expires_at to t0 - 31 min and polls at t0 + 1 min).
// - The staff warning is observed as a NEW notification row for the tenant during
//   the recon run (the spec names the reason code `extra_funds_not_parked`, not
//   the title). For QR the existing "QRIS dibayar, uang belum tercatat" title is
//   also asserted.
// - The queue is polled with the injected `now` and `force: true`.
// - A row closed after B was parked has resolution "provider_expired" (B is not
//   money of this code, same as the 908 hard-cap rule); the row must be resolved.
// - Whether the row closes in the same pass that parks B or in the next pass is
//   not specified: the test runs one more pass before asserting "resolved".
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qr-va-912-p1-3-extras-final.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import type { GatewayPaymentStatus } from "../services/payment-gateway.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  resetHoldPorts,
  tryImport,
  unallocatedFunds,
  type HoldFixture,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import {
  UNRECORDED_ALERT_TITLE,
  evidenceRows,
  notificationCount,
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
const EXTRA_IDR = 12_345;

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;

type Extra = NonNullable<GatewayPaymentStatus["extraPayments"]>[number];
/** Extra provider transactions reported with the status of a code (by the
 * code's own provider ref), layered over the scripted gateway. */
const extrasByRef = new Map<string, Extra[]>();

beforeAll(async () => {
  fx = await holdFixture("qr-va-912-p1-3-extras-final");
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
  /** Real "now" at the moment the code was released. */
  t0: Date;
};

type RowView = {
  status: string;
  lastProviderStatus: string | null;
  resolution: string | null;
};

type Kind = {
  label: "VA" | "QR";
  /** A released code, provider still pending. */
  open(): Promise<Subject>;
  recon(now: Date): Promise<unknown>;
  row(s: Subject): Promise<RowView>;
  /** Money applied to the order (0 = the order is still unpaid). */
  settled(s: Subject): Promise<number>;
};

const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

async function setExpiry(intentId: string, expiresAt: Date) {
  await owner.query(
    "UPDATE payment_intents SET expires_at = $3 WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId, expiresAt],
  );
}

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
 * `payment.funds_unallocated` event per amount. */
async function expectParked(s: Subject, amounts: number[]) {
  const expected = [...amounts].sort((a, b) => a - b);
  expect(await funds(s)).toEqual(expected);
  expect(await evidenceRows(fx, s.intentId)).toHaveLength(expected.length);
  expect(await outboxCountOf(fx, "payment.funds_unallocated", s.intentId)).toBe(
    expected.length,
  );
}

async function expectNothingRecorded(s: Subject) {
  expect(await unallocatedFunds(fx, s.intentId)).toEqual([]);
  expect(await evidenceRows(fx, s.intentId)).toEqual([]);
  expect(await outboxCountOf(fx, "payment.funds_unallocated", s.intentId)).toBe(
    0,
  );
}

/** The VA intent was marked final by the provider (`provider_final_at`). */
async function providerFinal(s: Subject): Promise<boolean> {
  const { rows } = await owner.query<{ final_at: Date | null }>(
    "SELECT provider_final_at AS final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, s.intentId],
  );
  return rows[0]!.final_at !== null;
}

async function allNotifications(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1",
    [fx.tenant.tenantId],
  );
  return rows[0]!.n;
}

/** Run the queue once and report whether staff got a new warning. */
async function reconAndCountWarnings(kind: Kind, now: Date) {
  const before = await allNotifications();
  const beforeQr = await notificationCount(fx, UNRECORDED_ALERT_TITLE);
  await kind.recon(now);
  return {
    any: (await allNotifications()) - before,
    qrTitle: (await notificationCount(fx, UNRECORDED_ALERT_TITLE)) - beforeQr,
  };
}

const reads = (s: Subject) => fx.gateway.readsOf(s.intentId).length;

/** The row was opened >= 30 min after the code lapsed, so the code's own
 * "expired" is final from expires_at + 60 s on. */
const lapsed = (s: Subject) => setExpiry(s.intentId, after(s.t0, -31 * MIN));

// ------------------------------------------------------------------ VA kind

type VaGuest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

function vaRequest(guest: VaGuest, orderId: string) {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method: "va",
    bankCode: "bmri",
    idempotencyKey: randomUUID(),
  });
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
    const created = await vaRequest(guest, order.id);
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
    return {
      intentId,
      providerRef: rows[0]!.provider_ref,
      amount: rows[0]!.amount,
      orderId: order.id,
      linkId: rows[0]!.payment_link_id,
      t0: new Date(),
    };
  },
  recon: runVaRecon,
  async row(s) {
    const { rows } = await owner.query<{
      status: string;
      last_provider_status: string | null;
      resolution: string | null;
    }>(
      `SELECT status, last_provider_status, resolution
         FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2
        ORDER BY created_at, id`,
      [fx.tenant.tenantId, s.intentId],
    );
    expect(rows, "exactly one release row").toHaveLength(1);
    const r = rows[0]!;
    return {
      status: r.status,
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
};

// ------------------------------------------------------------------ QR kind

const qrKind: Kind = {
  label: "QR",
  async open() {
    const { orderId, qr } = await kit.forceRelease({ rawStatus: "01" });
    return {
      intentId: qr.intentId,
      providerRef: qr.providerRef!,
      amount: qr.amountIdr,
      orderId,
      t0: new Date(),
    };
  },
  recon: (now) => runRecon(fx, now),
  async row(s) {
    const rows = await reconRows(fx, s.intentId);
    expect(rows, "exactly one reconciliation row").toHaveLength(1);
    const r = rows[0]!;
    return {
      status: r.status,
      lastProviderStatus: r.last_provider_status,
      resolution: r.resolution,
    };
  },
  settled: (s) => capturedIdr(fx, s.orderId),
};

// -------------------------------------------------------------------- tests

describe.each([vaKind, qrKind])(
  "legend-912-p1-3 $label expired answer plus extra paid transaction is not final",
  (kind) => {
    const name = (text: string) => `legend-912-p1-3 ${kind.label} ${text}`;

    it(
      name(
        "expired + extra B paid with amount 0 or less: B not recorded, row stays open, provider_final_at stays null, staff warned; positive B later is parked once and then the row closes",
      ),
      async () => {
        const s = await kind.open();
        await lapsed(s);
        const b = extra(0);
        const negative = extra(-500);
        answer(s, { rawStatus: "02" }, [b, negative]);

        const warned = await reconAndCountWarnings(kind, after(s.t0, 1 * MIN));
        await expectNothingRecorded(s);
        expect((await kind.row(s)).status, "row must stay open").toBe("open");
        if (kind.label === "VA")
          expect(await providerFinal(s), "not final: B is unrecorded").toBe(
            false,
          );
        expect(
          warned.any,
          "staff warning (extra_funds_not_parked)",
        ).toBeGreaterThan(0);
        if (kind.label === "QR") expect(warned.qrTitle).toBeGreaterThan(0);
        expect(await kind.settled(s)).toBe(0);

        // Asked again (still open), still nothing recorded, still not final.
        const before = reads(s);
        await kind.recon(after(s.t0, 2 * MIN));
        expect(reads(s), "row keeps asking the provider").toBe(before + 1);
        await expectNothingRecorded(s);
        expect((await kind.row(s)).status).toBe("open");
        if (kind.label === "VA") expect(await providerFinal(s)).toBe(false);

        // The provider now reports B with its real amount: parked exactly once.
        answer(s, { rawStatus: "02" }, [
          extra(EXTRA_IDR, b.providerRef),
          negative,
        ]);
        await kind.recon(after(s.t0, 3 * MIN));
        await kind.recon(after(s.t0, 4 * MIN));
        await expectParked(s, [EXTRA_IDR]);
        expect(await kind.settled(s), "extra never settles the order").toBe(0);
        const closed = await kind.row(s);
        // The negative extra is not positive money: it needs no recording, so
        // the row closes once the positive B is parked.
        expect(closed.status).toBe("resolved");
        expect(closed.resolution).toBe("provider_expired");
        if (kind.label === "VA")
          expect(await providerFinal(s), "now a real final answer").toBe(true);

        // Replay: no new fund, evidence or event, the order stays unpaid.
        answer(s, { rawStatus: "02" }, [extra(EXTRA_IDR, b.providerRef)]);
        await kind.recon(after(s.t0, 5 * MIN));
        await kind.recon(after(s.t0, 6 * MIN));
        await expectParked(s, [EXTRA_IDR]);
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name(
        "expired + one positive extra and one extra with amount 0: the positive one is parked once, the row stays open until the zero one is recorded",
      ),
      async () => {
        const s = await kind.open();
        await lapsed(s);
        const good = extra(EXTRA_IDR);
        const zero = extra(0);
        answer(s, { rawStatus: "02" }, [good, zero]);

        const warned = await reconAndCountWarnings(kind, after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 2 * MIN));
        await expectParked(s, [EXTRA_IDR]);
        expect((await kind.row(s)).status).toBe("open");
        if (kind.label === "VA") expect(await providerFinal(s)).toBe(false);
        expect(warned.any).toBeGreaterThan(0);
        expect(await kind.settled(s)).toBe(0);

        // The zero one gets its real amount: both parked once, then it closes.
        answer(s, { rawStatus: "02" }, [good, extra(7_000, zero.providerRef)]);
        await kind.recon(after(s.t0, 3 * MIN));
        await kind.recon(after(s.t0, 4 * MIN));
        await expectParked(s, [7_000, EXTRA_IDR]);
        expect((await kind.row(s)).status).toBe("resolved");
        if (kind.label === "VA") expect(await providerFinal(s)).toBe(true);
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name(
        "expired + extra B paid with a positive amount: parked exactly once, order not settled, replay adds nothing",
      ),
      async () => {
        const s = await kind.open();
        await lapsed(s);
        const b = extra();
        answer(s, { rawStatus: "02" }, [b]);

        await kind.recon(after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 2 * MIN));
        await kind.recon(after(s.t0, 3 * MIN));
        await expectParked(s, [EXTRA_IDR]);
        expect(await kind.settled(s), "never settled by extra funds").toBe(0);
        const closed = await kind.row(s);
        expect(closed.status).toBe("resolved");
        expect(closed.resolution).toBe("provider_expired");
        if (kind.label === "VA") expect(await providerFinal(s)).toBe(true);

        // A closed row is not asked again and records nothing new.
        const before = reads(s);
        await kind.recon(after(s.t0, 4 * MIN));
        expect(reads(s)).toBe(before);
        await expectParked(s, [EXTRA_IDR]);
      },
    );

    it(
      name(
        "control: expired without extras closes the row as before (VA provider_final_at set, nothing recorded, no warning)",
      ),
      async () => {
        const s = await kind.open();
        await lapsed(s);
        answer(s, { rawStatus: "02" });

        const warned = await reconAndCountWarnings(kind, after(s.t0, 1 * MIN));
        const closed = await kind.row(s);
        expect(closed.status).toBe("resolved");
        expect(closed.resolution).toBe("provider_expired");
        if (kind.label === "VA")
          expect(await providerFinal(s), "real final answer is final").toBe(
            true,
          );
        await expectNothingRecorded(s);
        expect(await kind.settled(s)).toBe(0);
        expect(warned.qrTitle, "nothing unrecorded to warn about").toBe(0);

        const before = reads(s);
        await kind.recon(after(s.t0, 2 * MIN));
        expect(reads(s), "a resolved row is not asked again").toBe(before);
      },
    );
  },
);
