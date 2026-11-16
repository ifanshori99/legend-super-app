// legend-912 round 2 (CTO decisions, docs/briefs/912-3p1.md): two rules for the
// release reconciliation queues, VA (payment_va_releases, worker
// payment-va-release-recon.job) and QR (pos_qris_release_reconciliations,
// worker pos-qris-release-recon.job). Written from the CTO message and the 912
// brief, not from the implementation.
//
// Rule 1 (money recorded is proof, Duitku only)
// - Provider "duitku": a paid answer with a positive amount, with EVERY extra
//   provider transaction also parked, is final proof: the row closes as
//   resolved / "paid_recorded" and a VA intent gets provider_final_at. A closed
//   row is not asked again. The parked money stays parked: the order is never
//   settled and a new tender is still refused 409 FUNDS_UNRESOLVED.
// - Not final for Duitku: paid with amount 0, an extra with amount <= 0, a
//   pending answer, a provider read error. The row stays open.
// - Provider "doit": paid recorded does NOT close the row. It stays open and is
//   still asked (about every 24 h), provider_final_at stays null.
// - Finance exceptions list (GET /api/accounting/finance-exceptions, kind
//   release_recon_unproven): an open row older than 72 h WITH money recorded
//   (the DOIT paid-recorded row) is NOT listed and NOT counted. An open row older
//   than 72 h with NO money recorded (pending, error, paid 0) is listed, for
//   either provider and either queue. A row that later records money leaves the
//   list; a row closed by Duitku proof is not listed.
//
// Rule 2 (QR force release Q93, kit.forceRelease, two people)
// - The release still works when the provider errors or times out. Money that
//   shows up afterwards is parked exactly once by the queue, never settles the
//   order and blocks a new QRIS (409 FUNDS_UNRESOLVED). Duitku closes the row
//   (paid_recorded) after that; DOIT keeps it open.
// - Coverage check (asked by the CTO): qris-hold-so885-d-recon-money.test.ts
//   D-01 already covers the DOIT + "5xx" path (release, later paid, parked once,
//   alert, replays add nothing). It does not cover "timeout", Duitku, or the
//   block on a new tender, so those are added here. The VA kind is not part of
//   this rule: since P1-1 a VA release with an unreadable provider is refused.
//
// Assumptions (the CTO message is silent, so they can be contested):
// - "Provider duitku/doit" is the provider of the payment intent, which in the
//   scripted gateway is the port's `provider`. One fixture is used for the whole
//   file; `useProvider()` switches `gateway.provider` before a code is created
//   (the intent keeps it). Two fixtures cannot share one device resolver.
// - Duitku paid is scripted as `{ rawStatus: "00" }`, DOIT paid as
//   `{ status: "paid" }` (what old tests use). Closed = `{ rawStatus: "02" }`.
// - Whether the row closes in the pass that records the money or in the next one
//   is not specified: two passes (at +1 min, +2 min) run before asserting.
// - Rows are opened after the code lapsed (expires_at = t0 - 31 min), as in
//   production, so a paid or closed answer is asked after expires_at + 60 s.
// - "Money recorded" = the money is parked as unallocated funds for the intent.
//   The list reads that; the test makes it by running the queue, never by
//   inserting funds.
// - When an extra fails to park (amount 0) the primary payment is still recorded
//   (the brief: "pencatatan uang tetap dicoba"), but only `not contain 0` is
//   asserted for the middle state.
// - The list is read by the fixture staff user, whose role gets
//   accounting.journal.view here (the "finance" template is not in the fixture
//   tenant). Rows are matched by queue row id (uuid or ULID) or intent id.
// - Age is made by backdating created_at of the queue row (direct UPDATE).
// - Old tests that clash: none known. Every old queue test uses the default
//   provider "doit" (holdFixture default), where paid stays open. Clash only if
//   the implementation keys the Duitku rule on `rawStatus` instead of the
//   intent's provider: then qr-va-912-p1-2-no-timer-close.test.ts and
//   qr-va-queue-after-paid-xzu4l.test.ts (doit codes scripted with rawStatus,
//   e.g. "00" in qr-va-912-p1-1) would break. The comments in
//   qr-va-912-p1-2 ("paid is still not proof the code is closed") and
//   qris-hold-so885-d-recon-money.test.ts ("paid does not close the row") stay
//   true for DOIT only; edit them to say "DOIT".
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qr-va-912-r2-close-rules.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { uuidToUlid, type ScopedTenantContext } from "@starter/shared/core";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import type { GatewayPaymentStatus } from "../services/payment-gateway.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  refundsOfIntent,
  requestQris,
  resetHoldPorts,
  tenderStatuses,
  tryImport,
  unallocatedFunds,
  type HoldFixture,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import {
  BILL_IDR,
  FUNDS_ALERT_TITLE,
  evidenceRows,
  hoursAfter,
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
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EXTRA_IDR = 12_345;
const LIST_PATH = "/api/accounting/finance-exceptions";
const KIND = "release_recon_unproven";
// The list ignores the window for this kind; any valid window works.
const WINDOW = { from: "2026-03-01", to: "2026-03-31" };

type Provider = "duitku" | "doit";

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;

type Extra = NonNullable<GatewayPaymentStatus["extraPayments"]>[number];
/** Extra provider transactions reported with the status of a code (by the
 * code's own provider ref), layered over the scripted gateway. */
const extrasByRef = new Map<string, Extra[]>();

beforeAll(async () => {
  fx = await holdFixture("qr-va-912-r2-close-rules");
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
  // The list is read by the fixture staff user (see assumptions).
  await owner.query(
    "UPDATE roles SET permissions = permissions || $2::jsonb WHERE id = $1",
    [fx.tenant.roleId, JSON.stringify(["accounting.journal.view"])],
  );
});
afterAll(async () => {
  extrasByRef.clear();
  resetHoldPorts();
  await owner.end();
});

// ---------------------------------------------------------------- shared bits

function useProvider(provider: Provider) {
  Object.assign(fx.gateway, { provider });
}

const PAID = {
  duitku: (amountIdr?: number): ProviderAnswer => ({
    rawStatus: "00",
    ...(amountIdr === undefined ? {} : { amountIdr }),
  }),
  doit: (amountIdr?: number): ProviderAnswer => ({
    status: "paid",
    ...(amountIdr === undefined ? {} : { amountIdr }),
  }),
} satisfies Record<Provider, (amountIdr?: number) => ProviderAnswer>;
const PENDING: ProviderAnswer = { rawStatus: "01" };

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
  id: string;
  status: string;
  resolution: string | null;
  nextCheckAt: Date;
};

type Kind = {
  label: "VA" | "QR";
  /** A released code of that provider, answer pending, lapsed 31 min ago. */
  open(provider: Provider): Promise<Subject>;
  recon(now: Date, force?: boolean): Promise<unknown>;
  row(s: Subject): Promise<RowView>;
  /** Make the queue row `hours` old. */
  backdate(s: Subject, hours: number): Promise<void>;
  /** Money applied to the order (0 = the order is still unpaid). */
  settled(s: Subject): Promise<number>;
  /** A new tender on the order is refused with 409 FUNDS_UNRESOLVED. */
  expectNewTenderBlocked(s: Subject): Promise<void>;
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

async function providerFinal(s: Subject): Promise<boolean> {
  const { rows } = await owner.query<{ final_at: Date | null }>(
    "SELECT provider_final_at AS final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, s.intentId],
  );
  return rows[0]!.final_at !== null;
}

const reads = (s: Subject) => fx.gateway.readsOf(s.intentId).length;

/** Two passes: the brief does not say whether the row closes in the pass that
 * records the money or in the next one. */
async function twoPasses(kind: Kind, s: Subject, from = 1 * MIN) {
  await kind.recon(after(s.t0, from));
  await kind.recon(after(s.t0, from + 1 * MIN));
}

async function expectStillOpen(kind: Kind, s: Subject, why: string) {
  const row = await kind.row(s);
  expect(row.status, `${why}: row must stay open`).toBe("open");
  expect(row.resolution, `${why}: no resolution`).toBeNull();
  expect(await providerFinal(s), `${why}: provider_final_at stays null`).toBe(
    false,
  );
}

/** Closed by recorded money (Duitku): paid_recorded, final, never settles the
 * order, parked once, still blocks a new tender, never asked again. */
async function expectClosedPaidRecorded(
  kind: Kind,
  s: Subject,
  parked: number[],
) {
  const row = await kind.row(s);
  expect(row.status).toBe("resolved");
  expect(row.resolution).toBe("paid_recorded");
  // Only the VA queue records `provider_final_at` on the intent.
  if (kind.label === "VA")
    expect(await providerFinal(s), "VA provider_final_at is set").toBe(true);
  await expectParked(s, parked);
  expect(await kind.settled(s), "a released code never settles").toBe(0);
  await kind.expectNewTenderBlocked(s);

  const before = reads(s);
  await kind.recon(after(s.t0, 1 * HOUR));
  await kind.recon(after(s.t0, 5 * DAY));
  expect(reads(s), "a closed row is not asked again").toBe(before);
  await expectParked(s, parked);
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
  async open(provider) {
    useProvider(provider);
    const guest = await fx.newGuest();
    const order = await fx.qrOrder(guest);
    const created = await vaReplace(guest, order.id, "va");
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const intentId = created.body.data.id as string;
    const { rows } = await owner.query<{
      amount: number;
      provider_ref: string;
      provider: string;
      payment_link_id: string;
    }>(
      `SELECT amount_idr::int AS amount, provider_ref, provider,
              payment_link_id::text AS payment_link_id
         FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, intentId],
    );
    expect(rows[0]!.provider, "the intent carries the provider").toBe(provider);
    // Release it (supervisor override, provider pending), as legend-5wn1e.
    fx.gateway.script(intentId, PENDING);
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
      id: string;
      status: string;
      resolution: string | null;
      next_check_at: Date;
    }>(
      `SELECT id::text AS id, status, resolution, next_check_at
         FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2
        ORDER BY created_at, id`,
      [fx.tenant.tenantId, s.intentId],
    );
    expect(rows, "exactly one release row").toHaveLength(1);
    const r = rows[0]!;
    return {
      id: r.id,
      status: r.status,
      resolution: r.resolution,
      nextCheckAt: r.next_check_at,
    };
  },
  async backdate(s, hours) {
    await owner.query(
      `UPDATE payment_va_releases
          SET created_at = now() - $3::numeric * interval '1 hour'
        WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, s.intentId, hours],
    );
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
  async open(provider) {
    useProvider(provider);
    const { orderId, qr } = await kit.forceRelease(PENDING);
    expect(qr.provider, "the intent carries the provider").toBe(provider);
    // Lapsed 31 min ago already (the kit backdates it); keep it explicit.
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
      id: r.id,
      status: r.status,
      resolution: r.resolution,
      nextCheckAt: r.next_check_at,
    };
  },
  async backdate(s, hours) {
    await owner.query(
      `UPDATE pos_qris_release_reconciliations
          SET created_at = now() - $3::numeric * interval '1 hour'
        WHERE tenant_id=$1 AND payment_intent_id=$2`,
      [fx.tenant.tenantId, s.intentId, hours],
    );
  },
  settled: (s) => capturedIdr(fx, s.orderId),
  async expectNewTenderBlocked(s) {
    const res = await requestQris(fx, s.orderId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("FUNDS_UNRESOLVED");
  },
};

const KINDS = [vaKind, qrKind];

async function openLapsed(kind: Kind, provider: Provider) {
  const s = await kind.open(provider);
  await setExpiry(s.intentId, after(s.t0, -31 * MIN));
  return s;
}

// ------------------------------------------- rule 1: money recorded is proof

describe.each(KINDS)(
  "legend-912 r2 $label Duitku: paid recorded is final proof",
  (kind) => {
    const name = (text: string) => `legend-912-r2 ${kind.label} duitku ${text}`;

    it(
      name(
        "paid with a positive amount is parked once and closes the row as paid_recorded; never asked again",
      ),
      async () => {
        const s = await openLapsed(kind, "duitku");
        answer(s, PAID.duitku());
        await twoPasses(kind, s);
        await expectClosedPaidRecorded(kind, s, [s.amount]);
      },
    );

    it(
      name(
        "paid plus a positive extra transaction: both parked once, then the row closes",
      ),
      async () => {
        const s = await openLapsed(kind, "duitku");
        answer(s, PAID.duitku(), [extra()]);
        await twoPasses(kind, s);
        await expectClosedPaidRecorded(kind, s, [s.amount, EXTRA_IDR]);
      },
    );

    it(
      name(
        "first paid answer only on day 8 (webhook lost): parked once and the row closes without any timer",
      ),
      async () => {
        const s = await openLapsed(kind, "duitku");
        answer(s, PENDING);
        await kind.recon(after(s.t0, 1 * MIN));
        await kind.recon(after(s.t0, 6 * DAY));
        await expectStillOpen(kind, s, "pending until day 6");
        expect(await funds(s)).toEqual([]);

        answer(s, PAID.duitku());
        await kind.recon(after(s.t0, 8 * DAY));
        await kind.recon(after(s.t0, 8 * DAY + 1 * MIN));
        await expectClosedPaidRecorded(kind, s, [s.amount]);
      },
    );

    it(
      name(
        "paid with amount 0 is not recorded and not final: row stays open; the later proper paid answer is recorded once and closes it",
      ),
      async () => {
        const s = await openLapsed(kind, "duitku");
        answer(s, PAID.duitku(0));
        await twoPasses(kind, s);
        await expectStillOpen(kind, s, "paid 0");
        expect(await funds(s)).toEqual([]);
        expect(await evidenceRows(fx, s.intentId)).toEqual([]);

        answer(s, PAID.duitku());
        await twoPasses(kind, s, 10 * MIN);
        await expectClosedPaidRecorded(kind, s, [s.amount]);
      },
    );

    it(
      name(
        "an extra transaction with amount 0 is not parked, so paid is not final yet; once the extra is positive it is parked once and the row closes",
      ),
      async () => {
        const s = await openLapsed(kind, "duitku");
        const ref = `EXTRA-${randomUUID()}`;
        answer(s, PAID.duitku(), [extra(0, ref)]);
        await twoPasses(kind, s);
        await expectStillOpen(kind, s, "extra not parked");
        expect(await funds(s), "an amount 0 is never recorded").not.toContain(
          0,
        );

        answer(s, PAID.duitku(), [extra(EXTRA_IDR, ref)]);
        await twoPasses(kind, s, 10 * MIN);
        await expectClosedPaidRecorded(kind, s, [s.amount, EXTRA_IDR]);
      },
    );

    it(
      name(
        "control: a pending answer and a provider read error close nothing and record nothing",
      ),
      async () => {
        const s = await openLapsed(kind, "duitku");
        answer(s, PENDING);
        await twoPasses(kind, s);
        await expectStillOpen(kind, s, "pending");

        answer(s, { error: "timeout" });
        await twoPasses(kind, s, 10 * MIN);
        await expectStillOpen(kind, s, "provider error");
        expect(await funds(s)).toEqual([]);
      },
    );
  },
);

describe.each(KINDS)(
  "legend-912 r2 $label DOIT: paid recorded does not close the row",
  (kind) => {
    it(`legend-912-r2 ${kind.label} doit paid recorded stays open, not final, still asked, never settles the order`, async () => {
      const s = await openLapsed(kind, "doit");
      answer(s, PAID.doit());
      await twoPasses(kind, s);
      await expectParked(s, [s.amount]);
      await expectStillOpen(kind, s, "doit paid recorded");
      expect(await kind.settled(s)).toBe(0);

      // Asked again later (about every 24 h), not stopped, nothing doubled.
      const before = reads(s);
      await kind.recon(after(s.t0, 5 * DAY));
      expect(reads(s), "still asked").toBe(before + 1);
      await expectStillOpen(kind, s, "day 5");
      await expectParked(s, [s.amount]);
      await kind.expectNewTenderBlocked(s);
    });
  },
);

// ---------------------------------- rule 1: finance exception list (72 h+)

type Listed = { kind: string; refId: string };

async function financeList() {
  const res = await fx.staff.client
    .get(LIST_PATH)
    .set(fx.headers)
    .query({ ...WINDOW, kind: KIND, outletId: fx.tenant.outletId });
  expect(
    res.status,
    `finance exceptions list: ${JSON.stringify(res.body)}`,
  ).toBe(200);
  const payload = (res.body.data ?? res.body) as {
    summary: { kind: string; count: number }[];
    items: Listed[];
  };
  return {
    items: payload.items.filter((item) => item.kind === KIND),
    count: payload.summary.find((entry) => entry.kind === KIND)?.count ?? 0,
  };
}

/** The item naming this queue row (row id as uuid or ULID, or the intent id). */
async function listedItem(kind: Kind, s: Subject, items: object[]) {
  const id = (await kind.row(s)).id;
  const needles = [id, uuidToUlid(id), s.intentId];
  return items.find((item) => {
    const text = JSON.stringify(item);
    return needles.some((needle) => text.includes(needle));
  });
}

describe("legend-912 r2 finance exceptions list: money recorded is not unproven", () => {
  it("legend-912-r2 list: old open rows without money are listed, a DOIT row with money recorded is not listed or counted, a Duitku-closed row is not listed", async () => {
    const subjects: Record<
      string,
      { kind: Kind; s: Subject; listed: boolean }
    > = {};
    for (const kind of KINDS) {
      const make = async (
        key: string,
        provider: Provider,
        reply: ProviderAnswer,
        listed: boolean,
        hours = 80,
      ) => {
        const s = await openLapsed(kind, provider);
        answer(s, reply);
        await twoPasses(kind, s);
        await kind.backdate(s, hours);
        subjects[`${kind.label} ${key}`] = { kind, s, listed };
      };
      // Listed: open > 72 h, no money recorded.
      await make("doit pending", "doit", PENDING, true);
      await make("doit paid 0", "doit", PAID.doit(0), true);
      await make("duitku pending", "duitku", PENDING, true);
      await make("duitku error", "duitku", { error: "5xx" }, true);
      // Not listed: open > 72 h but the money is recorded (DOIT keeps it open).
      await make("doit paid recorded", "doit", PAID.doit(), false);
      // Not listed: closed by Duitku proof (resolved), however old.
      await make("duitku paid recorded", "duitku", PAID.duitku(), false);
      // Not listed: open but younger than 72 h (control, no money).
      await make("doit pending young", "doit", PENDING, false, 10);
    }

    // Sanity of the setup: the rows are what the test says they are.
    for (const kind of KINDS) {
      const doitPaid = subjects[`${kind.label} doit paid recorded`]!;
      expect((await kind.row(doitPaid.s)).status).toBe("open");
      await expectParked(doitPaid.s, [doitPaid.s.amount]);
      const duitkuPaid = subjects[`${kind.label} duitku paid recorded`]!;
      expect((await kind.row(duitkuPaid.s)).status).toBe("resolved");
      const doitZero = subjects[`${kind.label} doit paid 0`]!;
      expect(await funds(doitZero.s)).toEqual([]);
    }

    const { items, count } = await financeList();
    for (const [key, { kind, s, listed }] of Object.entries(subjects)) {
      const item = await listedItem(kind, s, items);
      if (listed) expect(item, `${key} must be listed`).toBeDefined();
      else expect(item, `${key} must not be listed`).toBeUndefined();
    }
    const expectedListed = Object.values(subjects).filter(
      (entry) => entry.listed,
    ).length;
    expect(expectedListed).toBe(8);
    expect(items, "one item per listed row").toHaveLength(expectedListed);
    expect(count, "the summary counts only the unproven rows").toBe(
      expectedListed,
    );
  });

  for (const kind of KINDS) {
    it(`legend-912-r2 list: ${kind.label} DOIT row leaves the list once its money is recorded`, async () => {
      const s = await openLapsed(kind, "doit");
      answer(s, PENDING);
      await kind.recon(after(s.t0, 1 * MIN));
      await kind.backdate(s, 80);
      const before = await financeList();
      expect(
        await listedItem(kind, s, before.items),
        "listed while no money is recorded",
      ).toBeDefined();

      // The money is found now (injected now = real now, row is 80 h old).
      answer(s, PAID.doit());
      await kind.recon(new Date());
      await expectParked(s, [s.amount]);
      const afterPaid = await financeList();
      expect(
        await listedItem(kind, s, afterPaid.items),
        "not listed once money is recorded",
      ).toBeUndefined();
      expect(afterPaid.count).toBe(before.count - 1);
      // Still open: DOIT paid is not final.
      expect((await kind.row(s)).status).toBe("open");
    });
  }
});

// ---------------------- rule 2: QR force release with provider error / timeout

describe.each([
  { provider: "duitku", error: "5xx" },
  { provider: "duitku", error: "timeout" },
  { provider: "doit", error: "5xx" },
  { provider: "doit", error: "timeout" },
] as const)(
  "legend-912 r2 QR force release (Q93) while the provider errors: $provider / $error",
  ({ provider, error }) => {
    it(`legend-912-r2 QR ${provider} ${error}: release still works; money that comes later is parked once, never settles the order, blocks a new QRIS`, async () => {
      useProvider(provider);
      // kit.forceRelease asserts the release (two people: cashier + manager
      // override) answered 200 and the hold closed as force_released.
      const { orderId, qr, releasedAt } = await kit.forceRelease({ error });
      expect((await tenderStatuses(fx, orderId)).map((t) => t.status)).toEqual([
        "voided",
      ]);
      expect((await reconRows(fx, qr.intentId))[0]?.status).toBe("open");

      // Provider still down: nothing is invented, the row stays open.
      await runRecon(fx, hoursAfter(releasedAt, 1));
      expect((await reconRows(fx, qr.intentId))[0]?.status).toBe("open");
      expect(await evidenceRows(fx, qr.intentId)).toEqual([]);
      expect(await unallocatedFunds(fx, qr.intentId)).toEqual([]);

      // The provider recovers and reports the guest's payment.
      const alertsBefore = await notificationCount(fx, FUNDS_ALERT_TITLE);
      fx.gateway.script(qr.intentId, PAID[provider]());
      await runRecon(fx, hoursAfter(releasedAt, 2));
      await runRecon(fx, hoursAfter(releasedAt, 3));
      const parked = await unallocatedFunds(fx, qr.intentId);
      expect(parked.map((f) => f.amountIdr)).toEqual([BILL_IDR]);
      expect(await evidenceRows(fx, qr.intentId)).toHaveLength(1);
      expect(
        await outboxCountOf(fx, "payment.funds_unallocated", qr.intentId),
      ).toBe(1);
      expect(
        await notificationCount(fx, FUNDS_ALERT_TITLE),
        "staff are told money is waiting",
      ).toBeGreaterThan(alertsBefore);

      // The bill is not paid by it, nothing is refunded behind staff's back.
      expect(await capturedIdr(fx, orderId)).toBe(0);
      expect(await refundsOfIntent(fx, qr.intentId)).toEqual([]);
      const blocked = await requestQris(fx, orderId);
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
      expect(JSON.stringify(blocked.body)).toContain("FUNDS_UNRESOLVED");
      expect((await tenderStatuses(fx, orderId)).map((t) => t.status)).toEqual([
        "voided",
      ]);

      // Rule 1 for the row: Duitku closes it, DOIT keeps it open.
      const [row] = await reconRows(fx, qr.intentId);
      if (provider === "duitku") {
        expect(row?.status).toBe("resolved");
        expect(row?.resolution).toBe("paid_recorded");
      } else {
        expect(row?.status).toBe("open");
      }

      // Replays add nothing.
      await runRecon(fx, hoursAfter(releasedAt, 4));
      expect(await unallocatedFunds(fx, qr.intentId)).toHaveLength(1);
      expect(await evidenceRows(fx, qr.intentId)).toHaveLength(1);
    });
  },
);
