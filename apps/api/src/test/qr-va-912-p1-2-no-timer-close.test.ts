// legend-912 P1-2 (second opinion 906-908, docs/briefs/912-3p1.md): the release
// reconciliation queues must NOT close a row because of a timer, for BOTH kinds:
//   - VA: queue 906 (payment_va_releases, worker payment-va-release-recon.job)
//   - QR: queue Q93 (pos_qris_release_reconciliations, worker
//     pos-qris-release-recon.job)
//
// Rules under test (written from the brief, not from the implementation):
// - A row closes ONLY with proof from the provider that the code is closed (a
//   final answer expired/failed asked at/after expires_at + 60 s). Neither the
//   72 h mark (paid twice) nor the 7 day mark closes a row on its own.
// - After 72 h (paid) and after 7 days (pending) the queue asks LESS often
//   (about every 24 h) but keeps asking; it never stops by age.
// - Money that shows up late (a first payment on day 8 with the webhook lost,
//   or a new provider transaction after 72 h) is still recorded: parked as
//   unallocated funds exactly once per provider transaction, never settling the
//   order, and it blocks every new tender (409 FUNDS_UNRESOLVED).
//
// Assumptions:
// - The old 908 constants are gone; the tests only use real elapsed time from
//   the row's creation (t0 = real now at release; the injected `now` moves the
//   clock). Rows are opened after the code lapsed (expires_at = t0 - 31 min),
//   as in production.
// - "Reduced frequency" is asserted loosely: after such a check next_check_at
//   is in the future and at most 48 h away (the brief says "e.g. every 24 h"),
//   a non-forced run shortly after does not ask the provider again, and a
//   non-forced run at next_check_at does.
// - The brief also puts such rows on the finance exception list. That list
//   (GET /api/accounting/finance-exceptions) has no kind for it in the shared
//   validators yet, and the kind name is not specified, so it is NOT asserted
//   here (engineer/CTO decision; add a test once the kind is named).
// - A final answer that closes a row with no money recorded gives resolution
//   "provider_expired"; with money recorded "paid_recorded".
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qr-va-912-p1-2-no-timer-close.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import type { GatewayPaymentStatus } from "../services/payment-gateway.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
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
/** "About every 24 h": anything slower than two days would be a stop in effect. */
const MAX_SLOW_INTERVAL = 48 * HOUR;

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;

type Extra = NonNullable<GatewayPaymentStatus["extraPayments"]>[number];
/** Extra provider transactions reported with the status of a code (by the
 * code's own provider ref), layered over the scripted gateway. */
const extrasByRef = new Map<string, Extra[]>();

beforeAll(async () => {
  fx = await holdFixture("qr-va-912-p1-2-no-timer-close");
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
  nextCheckAt: Date;
};

type Kind = {
  label: "VA" | "QR";
  /** A released code, provider still pending, expires_at 10 min after t0. */
  open(): Promise<Subject>;
  recon(now: Date, force?: boolean): Promise<unknown>;
  row(s: Subject): Promise<RowView>;
  /** Money applied to the order (0 = the order is still unpaid). */
  settled(s: Subject): Promise<number>;
  /** A new tender on the order is refused with 409 FUNDS_UNRESOLVED. */
  expectNewTenderBlocked(s: Subject): Promise<void>;
};

async function setExpiry(intentId: string, expiresAt: Date) {
  await owner.query(
    "UPDATE payment_intents SET expires_at = $3 WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId, expiresAt],
  );
}

const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

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

/** Still open, no resolution: nothing closed it (no proof from the provider). */
async function expectStillOpen(kind: Kind, s: Subject, why: string) {
  const row = await kind.row(s);
  expect(row.status, `${why}: row must stay open`).toBe("open");
  expect(row.resolution, `${why}: no resolution`).toBeNull();
  expect(await providerFinal(s), `${why}: not a final answer`).toBe(false);
}

/** After a check at `checkedAt` the queue is slowed down, not stopped: the next
 * check is due later than now but within two days, and a non-forced run only
 * asks the provider again once it is due. */
async function expectSlowedNotStopped(kind: Kind, s: Subject, checkedAt: Date) {
  const next = (await kind.row(s)).nextCheckAt.getTime();
  expect(next, "next check is in the future").toBeGreaterThan(
    checkedAt.getTime(),
  );
  expect(next, "next check is at most two days away").toBeLessThanOrEqual(
    checkedAt.getTime() + MAX_SLOW_INTERVAL,
  );

  const before = reads(s);
  await kind.recon(after(checkedAt, MIN), false);
  expect(reads(s), "not asked again before it is due").toBe(before);

  await kind.recon(new Date(next), false);
  expect(reads(s), "asked again once it is due").toBe(before + 1);
}

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

async function runVaRecon(now: Date, force = true) {
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
  return job.runPaymentVaReleaseReconJob(fx.context, now, { force });
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
    return {
      intentId,
      providerRef: rows[0]!.provider_ref,
      amount: rows[0]!.amount,
      orderId: order.id,
      linkId: rows[0]!.payment_link_id,
      guest,
      t0: new Date(),
    };
  },
  recon: runVaRecon,
  async row(s) {
    const { rows } = await owner.query<{
      status: string;
      attempts: number;
      last_provider_status: string | null;
      resolution: string | null;
      next_check_at: Date;
    }>(
      `SELECT status, attempts, last_provider_status, resolution, next_check_at
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
      nextCheckAt: r.next_check_at,
    };
  },
  async settled(s) {
    const { rows } = await owner.query<{ paid: number }>(
      "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, s.linkId],
    );
    return rows[0]!.paid;
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
    return {
      intentId: qr.intentId,
      providerRef: qr.providerRef!,
      amount: qr.amountIdr,
      orderId,
      t0: new Date(),
    };
  },
  recon: (now, force = true) => runRecon(fx, now, { force }),
  async row(s) {
    const rows = await reconRows(fx, s.intentId);
    expect(rows, "exactly one reconciliation row").toHaveLength(1);
    const r = rows[0]!;
    return {
      status: r.status,
      attempts: r.attempts,
      lastProviderStatus: r.last_provider_status,
      resolution: r.resolution,
      nextCheckAt: r.next_check_at,
    };
  },
  settled: (s) => capturedIdr(fx, s.orderId),
  async expectNewTenderBlocked(s) {
    const res = await requestQris(fx, s.orderId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("FUNDS_UNRESOLVED");
  },
};

/** The row was created >= 30 min after the code lapsed (production shape), so
 * the code's own expiry alone closes nothing. */
async function openLapsed(kind: Kind) {
  const s = await kind.open();
  await setExpiry(s.intentId, after(s.t0, -31 * MIN));
  return s;
}

// -------------------------------------------------------------------- tests

describe.each([vaKind, qrKind])(
  "legend-912 P1-2 $label queue never closes a row by timer",
  (kind) => {
    const name = (text: string) => `legend-912-p1-2 ${kind.label} ${text}`;

    it(
      name(
        "day 7 with the provider still pending: row stays open, asks less often; a first payment on day 8 (webhook lost) is parked once and never settles the order",
      ),
      async () => {
        const s = await openLapsed(kind);
        answer(s, { rawStatus: "01" });

        await kind.recon(after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 6 * DAY));
        await expectStillOpen(kind, s, "day 6");

        const day7 = after(s.t0, 7 * DAY + 1 * HOUR);
        const before = reads(s);
        await kind.recon(day7);
        expect(reads(s), "asked once more on day 7").toBe(before + 1);
        await expectStillOpen(kind, s, "day 7");
        expect(await funds(s)).toEqual([]);
        await expectSlowedNotStopped(kind, s, day7);
        await expectStillOpen(kind, s, "after the slowed checks");

        // Day 8: the first payment ever, no webhook. Still recorded.
        answer(s, { status: "paid" });
        await kind.recon(after(s.t0, 8 * DAY));
        await expectParked(s, [s.amount]);
        expect(await kind.settled(s), "released code never settles").toBe(0);

        // Replays park nothing new.
        await kind.recon(after(s.t0, 8 * DAY + 1 * HOUR));
        await kind.recon(after(s.t0, 9 * DAY));
        await expectParked(s, [s.amount]);
        expect(await kind.settled(s)).toBe(0);
        expect(
          (await kind.row(s)).status,
          "paid is still not proof the code is closed",
        ).toBe("open");

        // The parked money blocks every new tender.
        await kind.expectNewTenderBlocked(s);
        await expectParked(s, [s.amount]);
      },
    );

    it(
      name(
        "day 7 with the provider pending: another provider reference paid on day 8 is parked once, never settles the order",
      ),
      async () => {
        const s = await openLapsed(kind);
        answer(s, { rawStatus: "01" });
        await kind.recon(after(s.t0, 7 * DAY + 1 * HOUR));
        await expectStillOpen(kind, s, "day 7");

        answer(s, { rawStatus: "01" }, [extra()]);
        await kind.recon(after(s.t0, 8 * DAY));
        await kind.recon(after(s.t0, 8 * DAY + 2 * HOUR));
        await expectParked(s, [EXTRA_IDR]);
        expect(await kind.settled(s)).toBe(0);
        await expectStillOpen(kind, s, "after the extra");
      },
    );

    it(
      name(
        "72 h with paid answered twice: row stays open, keeps asking; a provider transaction first seen after the mark is parked once",
      ),
      async () => {
        const s = await openLapsed(kind);
        const second = extra();
        answer(s, { status: "paid" }, [second]);

        await kind.recon(after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 71 * HOUR));
        // Two paid answers, the second one after 72 h: the old rule closed here.
        await kind.recon(after(s.t0, 73 * HOUR));
        const checkedAt = after(s.t0, 74 * HOUR);
        const before = reads(s);
        await kind.recon(checkedAt);
        expect(reads(s), "still asked after the 72 h mark").toBe(before + 1);
        await expectStillOpen(kind, s, "after 72 h");
        expect(await kind.row(s)).toMatchObject({ lastProviderStatus: "paid" });
        await expectParked(s, [s.amount, EXTRA_IDR]);
        await expectSlowedNotStopped(kind, s, checkedAt);

        // A new transaction appears on day 4: recorded once, replays add none.
        const late = extra(8_000);
        answer(s, { status: "paid" }, [second, late]);
        await kind.recon(after(s.t0, 4 * DAY));
        await kind.recon(after(s.t0, 5 * DAY));
        await expectParked(s, [s.amount, EXTRA_IDR, 8_000]);
        expect(await kind.settled(s)).toBe(0);
        await expectStillOpen(kind, s, "after the late transaction");
      },
    );

    it(
      name(
        "day 7 after money was recorded and the answer went back to pending: row stays open, a later transaction is still parked once",
      ),
      async () => {
        const s = await openLapsed(kind);
        answer(s, { status: "paid" });
        await kind.recon(after(s.t0, 1 * MIN));
        await expectParked(s, [s.amount]);

        answer(s, { rawStatus: "01" });
        await kind.recon(after(s.t0, 6 * DAY));
        await kind.recon(after(s.t0, 7 * DAY + 1 * HOUR));
        await expectStillOpen(kind, s, "day 7");
        await expectParked(s, [s.amount]);

        answer(s, { rawStatus: "01" }, [extra()]);
        await kind.recon(after(s.t0, 9 * DAY));
        await kind.recon(after(s.t0, 10 * DAY));
        await expectParked(s, [s.amount, EXTRA_IDR]);
        expect(await kind.settled(s)).toBe(0);
        await expectStillOpen(kind, s, "after the late extra");
      },
    );

    it(
      name(
        "only a final provider answer closes a row that was kept open past day 7: provider_expired with no money, not asked again",
      ),
      async () => {
        const s = await openLapsed(kind);
        answer(s, { rawStatus: "01" });
        await kind.recon(after(s.t0, 7 * DAY + 1 * HOUR));
        await kind.recon(after(s.t0, 8 * DAY));
        await expectStillOpen(kind, s, "day 8");

        // The code is closed at the provider (asked long after expires_at).
        answer(s, { rawStatus: "02" });
        await kind.recon(after(s.t0, 9 * DAY));
        const closed = await kind.row(s);
        expect(closed.status).toBe("resolved");
        expect(closed.resolution).toBe("provider_expired");
        // Only the VA queue records `provider_final_at`.
        if (kind.label === "VA")
          expect(await providerFinal(s), "a real final answer is final").toBe(
            true,
          );
        expect(await funds(s)).toEqual([]);

        const before = reads(s);
        await kind.recon(after(s.t0, 10 * DAY));
        await kind.recon(after(s.t0, 11 * DAY));
        expect(reads(s), "a closed row is not asked again").toBe(before);
      },
    );

    it(
      name(
        "only a final provider answer closes a row with money recorded after 72 h: paid_recorded",
      ),
      async () => {
        const s = await openLapsed(kind);
        answer(s, { status: "paid" });
        await kind.recon(after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 73 * HOUR));
        await kind.recon(after(s.t0, 75 * HOUR));
        await expectStillOpen(kind, s, "after 72 h");

        answer(s, { rawStatus: "02" });
        await kind.recon(after(s.t0, 5 * DAY));
        const closed = await kind.row(s);
        expect(closed.status).toBe("resolved");
        expect(closed.resolution).toBe("paid_recorded");
        if (kind.label === "VA")
          expect(await providerFinal(s), "a real final answer is final").toBe(
            true,
          );
        await expectParked(s, [s.amount]);
        expect(await kind.settled(s)).toBe(0);

        const before = reads(s);
        await kind.recon(after(s.t0, 6 * DAY));
        expect(reads(s)).toBe(before);
      },
    );

    it(
      name(
        "a provider read error past day 7 is not proof either: row stays open",
      ),
      async () => {
        const s = await openLapsed(kind);
        answer(s, { error: "timeout" });
        await kind.recon(after(s.t0, 7 * DAY + 1 * HOUR));
        await kind.recon(after(s.t0, 8 * DAY));
        await expectStillOpen(kind, s, "day 8 with errors");
        expect(await funds(s)).toEqual([]);
      },
    );
  },
);
