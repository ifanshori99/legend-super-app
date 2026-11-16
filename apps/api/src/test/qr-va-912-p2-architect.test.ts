// legend-912 P2 (architect review of 912 P1, QRIS/VA): three money rules about
// an EXTRA provider transaction B (Duitku shape: another reference of the same
// bill reported as paid next to the code's own answer A).
//
// Written from the brief (docs/briefs/912-3p1.md, P1-1 / P1-3 / p5xrv) and the
// architect's three findings, not from the implementation:
// (a) VA staff release: the code is locally `expired` (or still `pending`) but
//     NOT final, the provider answers A = 02 (expired) and B is paid. The
//     release is REFUSED (409): no release row, no audit row, the code stays
//     non-final and a replacement tender stays blocked, the bill is not paid.
//     (The provider answer is "not clean": money exists that the code's own
//     "expired" hides.)
// (b) The expired-code poll path (`syncExpiredIntentPayment`, reached through the
//     worker sweep `pollPendingGatewayIntents`) parks B exactly once per
//     provider + providerRef, never settles the order. Control: no extras parks
//     nothing.
// (c) A RELEASED code (it has a row in the release reconciliation queue) whose
//     provider answer is still pending, plus an extra B that is paid with amount
//     0 (not recordable) or whose parking fails, raises the staff warning
//     `extra_funds_not_parked` when the queue runs, VA and QR. Nothing is
//     recorded for B meanwhile; once parking works it is parked exactly once.
//     Control: pending without extras raises no warning.
//
// Assumptions (stated in the report):
// - A refusal in (a) is HTTP 409; the exact error code is not asserted (the
//   brief does not name one for this case).
// - In (a) the "override unused" check of p1-1 is NOT repeated: whether B gets
//   parked by the refused attempt (which would then block with FUNDS_UNRESOLVED)
//   is not specified.
// - (b) builds the "closed before it lapsed" expired intent as in
//   payment-duitku-webhook (status expired, expires_at 5 min ago, updated_at
//   1 min before expires_at, provider_final_at null). Each poll run is 2 h after
//   the last, so grace and backoff never hide the code. Both VA and QR are used.
// - (c) opens the queue row like qr-va-912-p1-3: the code is released with the
//   supervisor override while the provider is still pending, then the queue
//   (VA: runPaymentVaReleaseReconJob, QR: runPosQrisReleaseReconJob) runs with
//   an injected `now` (minutes after the release) and `force: true`. The
//   ordinary poll does not warn about extras: only released codes do.
// - The staff warning is observed as NEW in-app notifications titled "VA/QRIS
//   dibayar, uang belum tercatat" during one queue run (see
//   `subjectNotifications`: they carry no subject id, so the run delta is used).
//   Absence is asserted only for the control (pending, no extras).
// - "Parking fails" is simulated with a DB trigger that rejects inserts into
//   payment_unallocated_funds for one intent, dropped after the first poll. Only
//   funds and `payment.funds_unallocated` events are asserted for that case (not
//   the evidence row), since the spec does not say whether evidence is kept.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qr-va-912-p2-architect.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import type { GatewayPaymentStatus } from "../services/payment-gateway.ts";
import { pollPendingGatewayIntents } from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import {
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  resetHoldPorts,
  tryImport,
  unallocatedFunds,
  type HoldFixture,
  type ManagerApproval,
  type ProviderAnswer,
} from "./pos-qris-hold-test-helpers.ts";
import {
  evidenceRows,
  outboxCountOf,
  releaseKit,
  runRecon,
} from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EXTRA_IDR = 12_345;
const RELEASE_AFTER_MIN = 30;
const REASON = "Bank tidak menjawab status VA lebih dari sehari";
const AUDIT_ACTION = "payment_va_code.force_released";
const TRIGGER = "test_912_p2_fail_parking";

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;

type Extra = NonNullable<GatewayPaymentStatus["extraPayments"]>[number];
/** Extra provider transactions reported with the status of a code (by the
 * code's own provider ref), layered over the scripted gateway. */
const extrasByRef = new Map<string, Extra[]>();

beforeAll(async () => {
  fx = await holdFixture("qr-va-912-p2-architect");
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
  await owner.query(`
    CREATE OR REPLACE FUNCTION ${TRIGGER}() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.payment_intent_id::text = TG_ARGV[0] THEN
        RAISE EXCEPTION 'parking unavailable (912 P2 test)';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql`);
});
afterAll(async () => {
  await owner.query(
    `DROP TRIGGER IF EXISTS ${TRIGGER} ON payment_unallocated_funds`,
  );
  await owner.query(`DROP FUNCTION IF EXISTS ${TRIGGER}()`);
  extrasByRef.clear();
  resetHoldPorts();
  await owner.end();
});

// ---------------------------------------------------------------- shared bits

type Guest = Awaited<ReturnType<HoldFixture["newGuest"]>>;

type Subject = {
  intentId: string;
  providerRef: string;
  amount: number;
  orderId: string;
  /** VA only. */
  linkId?: string;
  guest?: Guest;
};

type Kind = {
  label: "VA" | "QR";
  /** A live pending code (provider pending, expires_at 30 days ahead). */
  open(): Promise<Subject>;
};

function extra(amountIdr: number = EXTRA_IDR, ref = `EXTRA-${randomUUID()}`) {
  return { providerRef: ref, amountIdr } satisfies Extra;
}

function answer(s: Subject, provider: ProviderAnswer, extras?: Extra[]) {
  fx.gateway.script(s.intentId, provider);
  if (extras) extrasByRef.set(s.providerRef, extras);
  else extrasByRef.delete(s.providerRef);
}

async function intentRow(intentId: string) {
  const { rows } = await owner.query<{
    status: string;
    provider_final_at: Date | null;
  }>(
    "SELECT status, provider_final_at FROM payment_intents WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!;
}

async function setExpiry(intentId: string, expiresAt: Date) {
  await owner.query(
    "UPDATE payment_intents SET expires_at = $3 WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId, expiresAt],
  );
}

async function funds(intentId: string) {
  return (await unallocatedFunds(fx, intentId))
    .map((f) => f.amountIdr)
    .sort((a, b) => a - b);
}

/** Every provider transaction parked once: one fund, one evidence row and one
 * `payment.funds_unallocated` event per amount. */
async function expectParked(s: Subject, amounts: number[]) {
  const expected = [...amounts].sort((a, b) => a - b);
  expect(await funds(s.intentId)).toEqual(expected);
  expect(await evidenceRows(fx, s.intentId)).toHaveLength(expected.length);
  expect(await outboxCountOf(fx, "payment.funds_unallocated", s.intentId)).toBe(
    expected.length,
  );
}

async function expectNothingParked(s: Subject) {
  expect(await unallocatedFunds(fx, s.intentId)).toEqual([]);
  expect(await outboxCountOf(fx, "payment.funds_unallocated", s.intentId)).toBe(
    0,
  );
}

/** Money applied to the order by the code itself (0 = still unpaid). */
async function settled(kind: Kind, s: Subject): Promise<number> {
  if (kind.label === "VA") {
    const { rows } = await owner.query<{ paid: number }>(
      "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id=$1 AND id=$2",
      [fx.tenant.tenantId, s.linkId],
    );
    return rows[0]!.paid;
  }
  return (await intentRow(s.intentId)).status === "paid" ? s.amount : 0;
}

/**
 * Staff warnings "paid at the provider, money not recorded" (VA or QRIS), as the
 * user sees them: in-app notifications for the outlet's supervisors titled
 * "VA dibayar, uang belum tercatat" / "QRIS dibayar, uang belum tercatat".
 * Assumption (the spec names the reason code `extra_funds_not_parked`, not the
 * row shape): the notification carries no subject id (no link, id-free body),
 * so a warning is attributed to a subject by the DELTA across one queue run
 * made right after setting up that subject's own answer; the warning fires only
 * when a row first reaches the state, so other subjects' rows cannot add to it.
 */
const WARNING_TITLES = [
  "VA dibayar, uang belum tercatat",
  "QRIS dibayar, uang belum tercatat",
];
async function subjectNotifications(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM notifications n
      WHERE n.tenant_id = $1 AND n.title = ANY($2::text[])`,
    [fx.tenant.tenantId, WARNING_TITLES],
  );
  return rows[0]!.n;
}

// Each poll run is later than the last: past the poll's grace for a fresh code
// and past the backoff between two asks about the same code.
let pollClock = Date.now();
function poll() {
  pollClock += 2 * HOUR;
  return pollPendingGatewayIntents(fx.context, new Date(pollClock), 200);
}

async function openVaCode(): Promise<Subject> {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const created = await fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId: order.id },
    method: "va",
    bankCode: "bmri",
    idempotencyKey: randomUUID(),
  });
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
  return {
    intentId,
    providerRef: rows[0]!.provider_ref,
    amount: rows[0]!.amount,
    orderId: order.id,
    linkId: rows[0]!.payment_link_id,
    guest,
  };
}

const vaKind: Kind = {
  label: "VA",
  async open() {
    const s = await openVaCode();
    await setExpiry(s.intentId, new Date(Date.now() + 30 * DAY));
    fx.gateway.script(s.intentId, { rawStatus: "01" });
    return s;
  },
};

const qrKind: Kind = {
  label: "QR",
  async open() {
    const order = await newSubmittedOrder(fx);
    const qr = await issueQris(fx, order.id);
    await setExpiry(qr.intentId, new Date(Date.now() + 30 * DAY));
    fx.gateway.script(qr.intentId, { rawStatus: "01" });
    return {
      intentId: qr.intentId,
      providerRef: qr.providerRef!,
      amount: qr.amountIdr,
      orderId: order.id,
    };
  },
};

// ------------------------------------------------- (a) VA release, extra B paid

function replaceCode(guest: Guest, orderId: string, method: "qris" | "va") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey: randomUUID(),
  });
}

/** A VA code eligible for staff release (30+ min past expires_at), locally in
 * `localStatus`, not final, answered `A = 02` with the given extras. */
async function eligibleCode(
  localStatus: "expired" | "pending",
  extras: Extra[],
) {
  const s = await openVaCode();
  answer(s, { rawStatus: "02" }, extras);
  await owner.query(
    `UPDATE payment_intents
        SET status = $4,
            expires_at = now() - $3::int * interval '1 minute'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, s.intentId, RELEASE_AFTER_MIN + 1, localStatus],
  );
  return s;
}

function postVaRelease(s: Subject, approval: ManagerApproval) {
  return fx.post(`${fx.base}/${s.orderId}/va/release`, {
    paymentIntentId: s.intentId,
    ...approval,
    idempotencyKey: randomUUID(),
    reason: REASON,
  });
}

async function releaseRowCount(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2",
    [fx.tenant.tenantId, intentId],
  );
  return rows[0]!.n;
}

async function auditCount(intentId: string) {
  const { rows } = await owner.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_logs
      WHERE tenant_id=$1 AND event->>'action'=$2 AND event::text LIKE $3`,
    [fx.tenant.tenantId, AUDIT_ACTION, `%${intentId}%`],
  );
  return rows[0]!.n;
}

describe("legend-912-p2 (a) VA release refuses a code whose expired answer hides a paid extra transaction", () => {
  it.each<{ label: string; local: "expired" | "pending"; b: number }>([
    { label: "local expired, B paid positive", local: "expired", b: EXTRA_IDR },
    { label: "local expired, B paid with amount 0", local: "expired", b: 0 },
    { label: "local pending, B paid positive", local: "pending", b: EXTRA_IDR },
  ])(
    "legend-912-p2 (a) $label (A = 02, not final): 409, no release, no audit, code not final, replacement blocked, bill unpaid",
    async ({ local, b }) => {
      const s = await eligibleCode(local, [extra(b)]);
      const approval = await kit.managerApproval(s.orderId, s.amount);

      const res = await postVaRelease(s, approval);
      expect(res.status, JSON.stringify(res.body)).toBe(409);

      expect(await releaseRowCount(s.intentId), "no release row").toBe(0);
      expect(await auditCount(s.intentId), "no release audit").toBe(0);
      expect(
        (await intentRow(s.intentId)).provider_final_at,
        "the refused code is not final",
      ).toBeNull();
      expect(await settled(vaKind, s), "B never settles the bill").toBe(0);
      for (const method of ["va", "qris"] as const) {
        const replacement = await replaceCode(s.guest!, s.orderId, method);
        expect(
          replacement.status,
          `a ${method} replacement stays blocked: ${JSON.stringify(replacement.body)}`,
        ).toBe(409);
      }
      // A repeat is refused the same way, with nothing released.
      const again = await postVaRelease(
        s,
        await kit.managerApproval(s.orderId, s.amount),
      );
      expect(again.status, JSON.stringify(again.body)).toBe(409);
      expect(await releaseRowCount(s.intentId)).toBe(0);
      expect(await auditCount(s.intentId)).toBe(0);
    },
  );
});

// ------------------------------- (b) expired path parks B exactly once (poll)

/** Closed before it lapsed, as the adapter leaves an expired Duitku/DOIT code:
 * the poll reconsiders it. Not final. */
async function expireLocally(s: Subject) {
  const expiresAt = new Date(Date.now() - 5 * MIN);
  await owner.query(
    `UPDATE payment_intents
        SET status = 'expired', expires_at = $3, updated_at = $4,
            provider_final_at = NULL
      WHERE tenant_id=$1 AND id=$2`,
    [
      fx.tenant.tenantId,
      s.intentId,
      expiresAt,
      new Date(expiresAt.getTime() - MIN),
    ],
  );
}

describe.each([vaKind, qrKind])(
  "legend-912-p2 (b) $label expired-code poll parks an extra transaction once",
  (kind) => {
    const name = (text: string) => `legend-912-p2 (b) ${kind.label} ${text}`;

    it(
      name(
        "expired code (A = 02) + extra B paid: B parked exactly once across repeated polls, the order is not settled",
      ),
      async () => {
        const s = await kind.open();
        await expireLocally(s);
        answer(s, { rawStatus: "02" }, [extra()]);

        await poll();
        await expectParked(s, [EXTRA_IDR]);
        for (let i = 0; i < 3; i += 1) {
          await poll();
          await expectParked(s, [EXTRA_IDR]);
        }
        for (const fund of await unallocatedFunds(fx, s.intentId))
          expect(fund.resolution, "parked funds stay open").toBeNull();
        expect(await settled(kind, s), "extra funds never settle").toBe(0);
        expect((await intentRow(s.intentId)).status).not.toBe("paid");
      },
    );

    it(
      name("a later second extra is parked once, the earlier one untouched"),
      async () => {
        const s = await kind.open();
        await expireLocally(s);
        const first = extra();
        answer(s, { rawStatus: "02" }, [first]);
        await poll();
        await expectParked(s, [EXTRA_IDR]);

        // Asked again after the code is final or not: the first stays one.
        answer(s, { rawStatus: "02" }, [first, extra(7_000)]);
        await poll();
        await poll();
        await poll();
        expect(await funds(s.intentId)).toEqual([7_000, EXTRA_IDR]);
        expect(
          await outboxCountOf(fx, "payment.funds_unallocated", s.intentId),
        ).toBe(2);
        expect(await settled(kind, s)).toBe(0);
      },
    );

    it(name("control: expired code without extras parks nothing"), async () => {
      const s = await kind.open();
      await expireLocally(s);
      answer(s, { rawStatus: "02" });
      await poll();
      await poll();
      await expectNothingParked(s);
      expect(await evidenceRows(fx, s.intentId)).toEqual([]);
      expect(await settled(kind, s)).toBe(0);
    });
  },
);

// ----------------- (c) released code, pending + extra not recorded: staff warning

type ReleasedSubject = Subject & {
  /** Real "now" at the moment the code was released. */
  t0: Date;
};

type ReleasedKind = {
  label: "VA" | "QR";
  /** A released code (queue row open), provider still pending. */
  open(): Promise<ReleasedSubject>;
  /** Run the release reconciliation queue once at `now` (force). */
  recon(now: Date): Promise<unknown>;
  /** Money applied to the order by the code itself (0 = still unpaid). */
  settled(s: ReleasedSubject): Promise<number>;
};

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

const releasedVaKind: ReleasedKind = {
  label: "VA",
  async open() {
    const s = await openVaCode();
    // Release it (supervisor override, provider pending), as legend-5wn1e.
    fx.gateway.script(s.intentId, { rawStatus: "01" });
    await owner.query(
      `UPDATE payment_intents
          SET expires_at = now() - $3::int * interval '1 minute'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, s.intentId, RELEASE_AFTER_MIN + 1],
    );
    const approval = await kit.managerApproval(s.orderId, s.amount);
    const released = await postVaRelease(s, approval);
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    return { ...s, t0: new Date() };
  },
  recon: runVaRecon,
  settled: (s) => settled(vaKind, s),
};

const releasedQrKind: ReleasedKind = {
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
  settled: (s) => capturedIdr(fx, s.orderId),
};

const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

/** Run the queue once; how many new notification rows about THIS subject staff
 * got from it. */
async function reconAndCountWarnings(
  kind: ReleasedKind,
  s: Subject,
  now: Date,
) {
  const before = await subjectNotifications();
  await kind.recon(now);
  return { any: (await subjectNotifications()) - before };
}

describe.each([releasedVaKind, releasedQrKind])(
  "legend-912-p2 (c) $label released code, pending answer plus an extra that cannot be recorded warns staff",
  (kind) => {
    const name = (text: string) => `legend-912-p2 (c) ${kind.label} ${text}`;
    /** Each queue run is a minute later than the last, after the release. */
    function clock(s: ReleasedSubject) {
      let n = 0;
      return () => after(s.t0, ++n * MIN);
    }

    it(
      name(
        "pending + extra B paid with amount 0: nothing recorded, staff warned (extra_funds_not_parked), order unpaid; the real amount later is parked once",
      ),
      async () => {
        const s = await kind.open();
        const next = clock(s);
        const b = extra(0);
        answer(s, { rawStatus: "01" }, [b]);

        const warned = await reconAndCountWarnings(kind, s, next());
        expect(
          warned.any,
          "staff warning (extra_funds_not_parked)",
        ).toBeGreaterThan(0);
        await expectNothingParked(s);
        expect(await evidenceRows(fx, s.intentId)).toEqual([]);
        expect(await kind.settled(s)).toBe(0);

        answer(s, { rawStatus: "01" }, [extra(EXTRA_IDR, b.providerRef)]);
        await kind.recon(next());
        await kind.recon(next());
        await expectParked(s, [EXTRA_IDR]);
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name(
        "pending + extra B paid positive but parking fails: nothing parked, staff warned (extra_funds_not_parked); once parking works B is parked exactly once",
      ),
      async () => {
        const s = await kind.open();
        const next = clock(s);
        const b = extra();
        answer(s, { rawStatus: "01" }, [b]);

        await owner.query(
          `CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON payment_unallocated_funds
             FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}('${s.intentId}')`,
        );
        let warned: { any: number };
        try {
          warned = await reconAndCountWarnings(kind, s, next());
          expect(await unallocatedFunds(fx, s.intentId)).toEqual([]);
          expect(
            await outboxCountOf(fx, "payment.funds_unallocated", s.intentId),
          ).toBe(0);
        } finally {
          await owner.query(
            `DROP TRIGGER IF EXISTS ${TRIGGER} ON payment_unallocated_funds`,
          );
        }
        expect(
          warned.any,
          "staff warning (extra_funds_not_parked)",
        ).toBeGreaterThan(0);
        expect(await kind.settled(s)).toBe(0);

        // Parking works again: the same B is parked once, however often asked.
        await kind.recon(next());
        await kind.recon(next());
        await kind.recon(next());
        expect(await funds(s.intentId)).toEqual([EXTRA_IDR]);
        expect(
          await outboxCountOf(fx, "payment.funds_unallocated", s.intentId),
        ).toBe(1);
        expect(await kind.settled(s)).toBe(0);
        expect((await intentRow(s.intentId)).status).not.toBe("paid");
      },
    );

    it(
      name(
        "control: pending without extras raises no warning and parks nothing",
      ),
      async () => {
        const s = await kind.open();
        const next = clock(s);
        answer(s, { rawStatus: "01" });
        expect((await reconAndCountWarnings(kind, s, next())).any).toBe(0);
        expect((await reconAndCountWarnings(kind, s, next())).any).toBe(0);
        await expectNothingParked(s);
        expect(await kind.settled(s)).toBe(0);
      },
    );
  },
);
