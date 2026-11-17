// legend-940 card C (legend-24ogm), brief docs 940 (scratchpad brief-940.md).
// Fail-first tests for three rules, written from the brief and the existing
// 912 tests (qr-va-912-p1-2, qr-va-912-p2-architect, qr-va-912-p5xrv,
// va-staff-release-5wn1e), not from the implementation.
//
// 1. The ordinary poll (worker `pollPendingGatewayIntents` and the guest's own
//    `GET /payments/:id`) that parks an extra provider transaction must warn
//    staff (`notifyOutletSupervisors`, event `payment_intent.extra_funds_parked`)
//    exactly once per parked row, the same as the release recon does. A repeated
//    poll that reads the same answer sends nothing more; a failing notification
//    never undoes the parking.
// 2. The release reconciliation queues (QR Q93 and VA 906) must slow down (about
//    every 24 h) after the watch window (7 days, as in qr-va-912-p1-2) for the
//    "open" states paid-without-amount, settlement failed and extra funds not
//    parked, and must NEVER close them by timer.
// 3. VA staff release: a provider answer that is older than a short limit when
//    the order lock is taken is refused with 409 VA_RELEASE_PROVIDER_UNREAD
//    (nothing released, approval not spent, caller may retry). A payment that
//    lands in that gap is never lost nor paid twice.
//
// Assumptions (also in the report):
// - Staff notifications carry no stable title in the brief. They are counted as
//   the DELTA of all `notifications` rows of the tenant across one poll (the
//   rows are per supervisor, so N = delta of the first parked extra is
//   calibrated, then each further parked row must add exactly N and a replay 0).
//   The event name is not visible in the notifications row, so it is not
//   asserted.
// - "After MAX_WATCH_MS" is read as day 7 + 1 h from the release (the constant
//   is not named in the brief; qr-va-912-p1-2 uses the same moment).
// - "Slowed" is asserted as in p1-2: next_check_at in the future and at most
//   48 h away, a non-forced run a minute later does not read the provider, a
//   non-forced run at next_check_at does.
// - Open states are produced like this: paid-without-amount = answer paid with
//   amount null; settlement failed = primary paid but a DB trigger rejects
//   writing the parked funds; extra funds not parked = an extra with amount 0,
//   or an extra with a positive amount while that trigger rejects parking.
//   Whatever the internal reason code is, the observable rule is identical.
// - The "short limit" of rule 3 is "e.g. 30 s" in the brief: a 90 s gap must be
//   refused, a 5 s gap must still release. Time is moved by skewing `Date` in
//   the test process only while the request runs (no real waiting).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/qr-va-940-24ogm-park-slow.test.ts" heavy pnpm test
import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ScopedTenantContext } from "@starter/shared/core";
import { setPaymentGateway } from "../services/payment-gateway.ts";
import type { GatewayPaymentStatus } from "../services/payment-gateway.ts";
import {
  pollPendingGatewayIntents,
  recordUnsettledGatewayFunds,
} from "../services/payment.service.ts";
import { owner } from "./floor-test-helpers.ts";
import { agent, originHeader } from "./helpers.ts";
import {
  capturedIdr,
  holdFixture,
  issueQris,
  newSubmittedOrder,
  requestQris,
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
  reconRows,
  releaseKit,
  runRecon,
} from "./qris-hold-so885-d-helpers.ts";
import { enableVaBank } from "./qris-hold-so879-va-gateway.ts";

vi.setConfig({ testTimeout: 180_000 });

const RELEASE_AFTER_MIN = 30;
const REASON = "Bank tidak menjawab status VA lebih dari sehari";
const AUDIT_ACTION = "payment_va_code.force_released";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EXTRA_IDR = 12_345;
/** "About every 24 h": anything slower than two days would be a stop in effect. */
const MAX_SLOW_INTERVAL = 48 * HOUR;
const TRIGGER = "test_940_24ogm_fail_parking";
const NOTIFY_TRIGGER = "test_940_24ogm_fail_notify";

let fx: HoldFixture;
let kit: ReturnType<typeof releaseKit>;

type Extra = NonNullable<GatewayPaymentStatus["extraPayments"]>[number];
/** Extra provider transactions reported with the status of a code. */
const extrasByRef = new Map<string, Extra[]>();
/** Provider refs whose paid answer carries amount null (the port allows it). */
const paidWithoutAmount = new Set<string>();
/** Run once right after the provider answered a read of this provider ref
 * (a payment or a time gap that happens after the read, before the lock). */
const afterRead = new Map<string, () => void>();

beforeAll(async () => {
  fx = await holdFixture("qr-va-940-24ogm");
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
    let answer: GatewayPaymentStatus = extras
      ? { ...base, extraPayments: extras }
      : base;
    if (answer.status === "paid" && paidWithoutAmount.has(input.providerRef))
      answer = { ...answer, amountIdr: null };
    const hook = afterRead.get(input.providerRef);
    if (hook) {
      afterRead.delete(input.providerRef);
      hook();
    }
    return answer;
  };
  setPaymentGateway(fx.gateway);
  kit = releaseKit(fx);
  // Staff to warn: without a supervisor the notification has no recipient.
  await kit.supervisor();
  await owner.query(`
    CREATE OR REPLACE FUNCTION ${TRIGGER}() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.payment_intent_id::text = TG_ARGV[0] THEN
        RAISE EXCEPTION 'parking unavailable (940 24ogm test)';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql`);
  await owner.query(`
    CREATE OR REPLACE FUNCTION ${NOTIFY_TRIGGER}() RETURNS trigger AS $fn$
    BEGIN
      IF NEW.tenant_id::text = TG_ARGV[0] THEN
        RAISE EXCEPTION 'notifications unavailable (940 24ogm test)';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql`);
});
afterEach(() => {
  extrasByRef.clear();
  paidWithoutAmount.clear();
  afterRead.clear();
});
afterAll(async () => {
  await owner.query(
    `DROP TRIGGER IF EXISTS ${TRIGGER} ON payment_unallocated_funds`,
  );
  await owner.query(
    `DROP TRIGGER IF EXISTS ${NOTIFY_TRIGGER} ON notifications`,
  );
  await owner.query(`DROP FUNCTION IF EXISTS ${TRIGGER}()`);
  await owner.query(`DROP FUNCTION IF EXISTS ${NOTIFY_TRIGGER}()`);
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
  /** Real "now" at the moment the code was opened or released. */
  t0: Date;
};

const after = (base: Date, ms: number) => new Date(base.getTime() + ms);

function extra(amountIdr: number = EXTRA_IDR, ref = `EXTRA-${randomUUID()}`) {
  return { providerRef: ref, amountIdr } satisfies Extra;
}

function answer(s: Subject, provider: ProviderAnswer, extras?: Extra[]) {
  fx.gateway.script(s.intentId, provider);
  if (extras) extrasByRef.set(s.providerRef, extras);
  else extrasByRef.delete(s.providerRef);
}

async function setExpiry(intentId: string, expiresAt: Date) {
  await owner.query(
    "UPDATE payment_intents SET expires_at = $3 WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, intentId, expiresAt],
  );
}

async function intentRow(s: Subject) {
  const { rows } = await owner.query<{
    id: string;
    outlet_id: string;
    amount_idr: number;
    method: string;
    provider: string;
    status: string;
    provider_final_at: Date | null;
  }>(
    `SELECT id, outlet_id, amount_idr::int AS amount_idr, method, provider, status,
            provider_final_at
       FROM payment_intents WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, s.intentId],
  );
  return rows[0]!;
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

async function expectNothingParked(s: Subject) {
  expect(await unallocatedFunds(fx, s.intentId)).toEqual([]);
  expect(await evidenceRows(fx, s.intentId)).toEqual([]);
  expect(await outboxCountOf(fx, "payment.funds_unallocated", s.intentId)).toBe(
    0,
  );
}

async function notificationTotal(): Promise<number> {
  const { rows } = await owner.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM notifications WHERE tenant_id=$1",
    [fx.tenant.tenantId],
  );
  return rows[0]!.n;
}

/** Run `action`; how many notification rows it added for the tenant. */
async function notificationsDuring(action: () => Promise<unknown>) {
  const before = await notificationTotal();
  await action();
  return (await notificationTotal()) - before;
}

// Each poll run is later than the last: past the poll's grace for a fresh code
// and past the backoff between two asks about the same code.
let pollClock = Date.now();
function poll() {
  pollClock += 2 * HOUR;
  return pollPendingGatewayIntents(fx.context, new Date(pollClock), 200);
}

async function failParkingOf(intentId: string) {
  await owner.query(
    `CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON payment_unallocated_funds
       FOR EACH ROW EXECUTE FUNCTION ${TRIGGER}('${intentId}')`,
  );
}
async function restoreParking() {
  await owner.query(
    `DROP TRIGGER IF EXISTS ${TRIGGER} ON payment_unallocated_funds`,
  );
}

// ------------------------------------------------------------------ openers

function vaOrderCode(guest: Guest, orderId: string, method: "qris" | "va") {
  return fx.guestPost(guest, "/payments", {
    target: { kind: "order", orderId },
    method,
    ...(method === "va" ? { bankCode: "bmri" } : {}),
    idempotencyKey: randomUUID(),
  });
}

async function openVaCode(): Promise<Subject> {
  const guest = await fx.newGuest();
  const order = await fx.qrOrder(guest);
  const created = await vaOrderCode(guest, order.id, "va");
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
    t0: new Date(),
  };
}

async function paidIdr(s: Subject) {
  const { rows } = await owner.query<{ paid: number }>(
    "SELECT paid_idr::int AS paid FROM payment_links WHERE tenant_id=$1 AND id=$2",
    [fx.tenant.tenantId, s.linkId],
  );
  return rows[0]!.paid;
}

// ===================================================================== PART 1
// The ordinary poll warns staff once per parked extra.

type LiveKind = {
  label: "VA" | "QR";
  /** A live pending code (provider pending, expires_at 30 days ahead). */
  open(): Promise<Subject>;
  /** Money applied to the order by the code itself (0 = still unpaid). */
  settled(s: Subject): Promise<number>;
};

const liveVa: LiveKind = {
  label: "VA",
  async open() {
    const s = await openVaCode();
    await setExpiry(s.intentId, new Date(Date.now() + 30 * DAY));
    fx.gateway.script(s.intentId, { rawStatus: "01" });
    return s;
  },
  settled: paidIdr,
};

const liveQr: LiveKind = {
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
      t0: new Date(),
    };
  },
  async settled(s) {
    return (await intentRow(s)).status === "paid" ? s.amount : 0;
  },
};

describe.each([liveVa, liveQr])(
  "legend-24ogm $label ordinary poll warns staff once per parked extra",
  (kind) => {
    const name = (text: string) => `legend-24ogm ${kind.label} ${text}`;

    it(
      name(
        "pending + another reference paid: the first poll parks it and warns staff; replays warn nobody and park nothing more",
      ),
      async () => {
        const s = await kind.open();
        answer(s, { rawStatus: "01" }, [extra()]);

        const first = await notificationsDuring(poll);
        await expectParked(s, [EXTRA_IDR]);
        expect(
          first,
          "staff are told once when the extra is parked",
        ).toBeGreaterThan(0);

        for (let i = 0; i < 3; i += 1) {
          const again = await notificationsDuring(poll);
          expect(again, `replay ${i + 1} sends nothing`).toBe(0);
          await expectParked(s, [EXTRA_IDR]);
        }
        expect(await kind.settled(s), "extra funds never settle").toBe(0);
      },
    );

    it(
      name(
        "each parked extra warns once: a later extra adds exactly one more round, the earlier one nothing",
      ),
      async () => {
        const s = await kind.open();
        const first = extra();
        const second = extra(7_000);
        answer(s, { rawStatus: "01" }, [first]);
        const perRow = await notificationsDuring(poll);
        expect(perRow).toBeGreaterThan(0);
        expect(await notificationsDuring(poll)).toBe(0);

        answer(s, { rawStatus: "01" }, [first, second]);
        expect(
          await notificationsDuring(poll),
          "one round for the new row",
        ).toBe(perRow);
        expect(await notificationsDuring(poll)).toBe(0);
        await expectParked(s, [EXTRA_IDR, 7_000]);
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name("two extras in one answer warn once each (two rounds)"),
      async () => {
        const calibration = await kind.open();
        answer(calibration, { rawStatus: "01" }, [extra()]);
        const perRow = await notificationsDuring(poll);
        expect(perRow).toBeGreaterThan(0);

        const s = await kind.open();
        answer(s, { rawStatus: "01" }, [extra(), extra(21_000)]);
        expect(await notificationsDuring(poll)).toBe(2 * perRow);
        expect(await notificationsDuring(poll)).toBe(0);
        await expectParked(s, [EXTRA_IDR, 21_000]);
      },
    );

    it(
      name(
        "an extra already parked by its webhook is not announced again by the poll",
      ),
      async () => {
        const s = await kind.open();
        const e = extra();
        const row = await intentRow(s);
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
            providerRef: e.providerRef,
            source: "verified_webhook",
            paidAmountIdr: e.amountIdr,
            receivedAt: new Date(),
          },
          new Date(),
        );
        answer(s, { rawStatus: "01" }, [e]);
        expect(
          await notificationsDuring(poll),
          "the poll only announces rows it inserted",
        ).toBe(0);
        await expectParked(s, [EXTRA_IDR]);
      },
    );

    it(
      name(
        "a failing notification never undoes the parking: parked once, order unpaid, the poll does not throw",
      ),
      async () => {
        const s = await kind.open();
        answer(s, { rawStatus: "01" }, [extra()]);
        await owner.query(
          `CREATE TRIGGER ${NOTIFY_TRIGGER} BEFORE INSERT ON notifications
             FOR EACH ROW EXECUTE FUNCTION ${NOTIFY_TRIGGER}('${fx.tenant.tenantId}')`,
        );
        try {
          await poll();
          await poll();
        } finally {
          await owner.query(
            `DROP TRIGGER IF EXISTS ${NOTIFY_TRIGGER} ON notifications`,
          );
        }
        await expectParked(s, [EXTRA_IDR]);
        expect(await kind.settled(s)).toBe(0);
      },
    );

    it(
      name("an extra of 0 or less parks nothing and warns nobody"),
      async () => {
        const s = await kind.open();
        answer(s, { rawStatus: "01" }, [extra(0), extra(-500)]);
        expect(await notificationsDuring(poll)).toBe(0);
        expect(await notificationsDuring(poll)).toBe(0);
        await expectNothingParked(s);
      },
    );

    it(
      name("control: a pending code without extras warns nobody"),
      async () => {
        const s = await kind.open();
        answer(s, { rawStatus: "01" });
        expect(await notificationsDuring(poll)).toBe(0);
        expect(await notificationsDuring(poll)).toBe(0);
        await expectNothingParked(s);
      },
    );
  },
);

describe("legend-24ogm VA guest status read warns staff once per parked extra", () => {
  function guestRead(s: Subject) {
    return agent(fx.app)
      .get(`/api/table-sessions/${s.guest!.sessionId}/payments/${s.intentId}`)
      .set(fx.headers)
      .set(originHeader)
      .set("Authorization", `Bearer ${s.guest!.token}`);
  }

  it("legend-24ogm VA repeated guest reads and a worker poll warn exactly once for one extra", async () => {
    const s = await liveVa.open();
    answer(s, { rawStatus: "01" }, [extra()]);

    const first = await notificationsDuring(async () => {
      const res = await guestRead(s);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(
      first,
      "the guest read that parks the extra warns staff",
    ).toBeGreaterThan(0);
    await expectParked(s, [EXTRA_IDR]);

    const replays = await notificationsDuring(async () => {
      for (let i = 0; i < 2; i += 1) {
        const res = await guestRead(s);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      await poll();
      await poll();
    });
    expect(replays).toBe(0);
    await expectParked(s, [EXTRA_IDR]);
    expect(await paidIdr(s), "extra funds never settle").toBe(0);
  });
});

// ===================================================================== PART 2
// Release recon slows down, never closes, for the open money states.

type ReconKind = {
  label: "VA" | "QR";
  /** A released code, provider still pending, expires_at 31 min before t0. */
  open(): Promise<Subject>;
  recon(now: Date, force?: boolean): Promise<unknown>;
  row(s: Subject): Promise<{
    status: string;
    resolution: string | null;
    nextCheckAt: Date;
  }>;
  settled(s: Subject): Promise<number>;
  /** A new tender on the order is refused with 409 FUNDS_UNRESOLVED. */
  expectNewTenderBlocked(s: Subject): Promise<void>;
};

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

async function releaseVaCode(s: Subject, approval: ManagerApproval) {
  return fx.post(`${fx.base}/${s.orderId}/va/release`, {
    paymentIntentId: s.intentId,
    ...approval,
    idempotencyKey: randomUUID(),
    reason: REASON,
  });
}

const reconVa: ReconKind = {
  label: "VA",
  async open() {
    const s = await openVaCode();
    fx.gateway.script(s.intentId, { rawStatus: "01" });
    await owner.query(
      `UPDATE payment_intents
          SET expires_at = now() - $3::int * interval '1 minute'
        WHERE tenant_id=$1 AND id=$2`,
      [fx.tenant.tenantId, s.intentId, RELEASE_AFTER_MIN + 1],
    );
    const approval = await kit.managerApproval(s.orderId, s.amount);
    const released = await releaseVaCode(s, approval);
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    return { ...s, t0: new Date() };
  },
  recon: runVaRecon,
  async row(s) {
    const { rows } = await owner.query<{
      status: string;
      resolution: string | null;
      next_check_at: Date;
    }>(
      `SELECT status, resolution, next_check_at
         FROM payment_va_releases WHERE tenant_id=$1 AND payment_intent_id=$2
        ORDER BY created_at, id`,
      [fx.tenant.tenantId, s.intentId],
    );
    expect(rows, "exactly one release row").toHaveLength(1);
    return {
      status: rows[0]!.status,
      resolution: rows[0]!.resolution,
      nextCheckAt: rows[0]!.next_check_at,
    };
  },
  settled: paidIdr,
  async expectNewTenderBlocked(s) {
    for (const method of ["va", "qris"] as const) {
      const res = await vaOrderCode(s.guest!, s.orderId, method);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe("FUNDS_UNRESOLVED");
    }
  },
};

const reconQr: ReconKind = {
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
    return {
      status: rows[0]!.status,
      resolution: rows[0]!.resolution,
      nextCheckAt: rows[0]!.next_check_at,
    };
  },
  settled: (s) => capturedIdr(fx, s.orderId),
  async expectNewTenderBlocked(s) {
    const res = await requestQris(fx, s.orderId);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(JSON.stringify(res.body)).toContain("FUNDS_UNRESOLVED");
  },
};

const reads = (s: Subject) => fx.gateway.readsOf(s.intentId).length;

async function expectStillOpen(kind: ReconKind, s: Subject, why: string) {
  const row = await kind.row(s);
  expect(row.status, `${why}: row must stay open`).toBe("open");
  expect(row.resolution, `${why}: no resolution`).toBeNull();
  expect(
    (await intentRow(s)).provider_final_at,
    `${why}: not a final answer`,
  ).toBeNull();
}

/** After a check at `checkedAt` the queue is slowed down, not stopped. */
async function expectSlowedNotStopped(
  kind: ReconKind,
  s: Subject,
  checkedAt: Date,
) {
  const next = (await kind.row(s)).nextCheckAt.getTime();
  expect(next, "next check is in the future").toBeGreaterThan(
    checkedAt.getTime(),
  );
  expect(next, "next check is at most two days away").toBeLessThanOrEqual(
    checkedAt.getTime() + MAX_SLOW_INTERVAL,
  );
  // Slowed means clearly later than a quick retry: more than a few hours away.
  expect(
    next - checkedAt.getTime(),
    "slowed: not a quick retry any more",
  ).toBeGreaterThanOrEqual(12 * HOUR);

  const before = reads(s);
  await kind.recon(after(checkedAt, MIN), false);
  expect(reads(s), "not asked again before it is due").toBe(before);

  await kind.recon(new Date(next), false);
  expect(reads(s), "asked again once it is due").toBe(before + 1);
}

type OpenState = {
  label: string;
  /** Put the code in the open money state (provider answer, DB faults). */
  arm(s: Subject): Promise<void>;
  /** Clear the fault: the money can be recorded now. */
  heal(s: Subject): Promise<void>;
  /** Amounts that are parked once the fault is cleared. */
  parkedAfterHeal(s: Subject): number[];
};

const openStates: OpenState[] = [
  {
    label: "paid without amount",
    async arm(s) {
      answer(s, { status: "paid" });
      paidWithoutAmount.add(s.providerRef);
    },
    async heal(s) {
      paidWithoutAmount.delete(s.providerRef);
    },
    parkedAfterHeal: (s) => [s.amount],
  },
  {
    label: "paid but the money cannot be recorded (settlement failed)",
    async arm(s) {
      answer(s, { status: "paid" });
      await failParkingOf(s.intentId);
    },
    heal: restoreParking,
    parkedAfterHeal: (s) => [s.amount],
  },
  {
    label: "extra paid with amount 0 (extra funds not parked)",
    async arm(s) {
      answer(s, { rawStatus: "01" }, [extra(0, `EXTRA-ZERO-${s.intentId}`)]);
    },
    async heal(s) {
      answer(s, { rawStatus: "01" }, [
        extra(EXTRA_IDR, `EXTRA-ZERO-${s.intentId}`),
      ]);
    },
    parkedAfterHeal: () => [EXTRA_IDR],
  },
  {
    label: "extra paid positive but parking fails (extra funds not parked)",
    async arm(s) {
      answer(s, { rawStatus: "01" }, [
        extra(EXTRA_IDR, `EXTRA-FAIL-${s.intentId}`),
      ]);
      await failParkingOf(s.intentId);
    },
    heal: restoreParking,
    parkedAfterHeal: () => [EXTRA_IDR],
  },
];

describe.each([reconVa, reconQr])(
  "legend-24ogm $label release queue slows down open money states after the watch window and never closes them",
  (kind) => {
    for (const state of openStates) {
      it(`legend-24ogm ${kind.label} ${state.label}: day 7 slows to about 24 h, stays open on day 8 and 12, money recorded once when it can be`, async () => {
        const s = await kind.open();
        await owner.query(
          "UPDATE payment_intents SET expires_at = $3 WHERE tenant_id=$1 AND id=$2",
          [fx.tenant.tenantId, s.intentId, after(s.t0, -31 * MIN)],
        );
        try {
          await state.arm(s);

          await kind.recon(after(s.t0, 1 * MIN));
          await expectStillOpen(kind, s, "first check");
          expect(await kind.settled(s), "nothing settles the order").toBe(0);

          const day7 = after(s.t0, 7 * DAY + 1 * HOUR);
          const before = reads(s);
          await kind.recon(day7);
          expect(reads(s), "still asked on day 7").toBe(before + 1);
          await expectStillOpen(kind, s, "day 7");
          await expectSlowedNotStopped(kind, s, day7);
          await expectStillOpen(kind, s, "after the slowed checks");

          await kind.recon(after(s.t0, 8 * DAY));
          await kind.recon(after(s.t0, 12 * DAY));
          await expectStillOpen(kind, s, "day 12");
          expect(await kind.settled(s)).toBe(0);
        } finally {
          await state.heal(s);
        }

        // The fault clears: the money is recorded exactly once, never settles.
        await kind.recon(after(s.t0, 13 * DAY));
        await kind.recon(after(s.t0, 14 * DAY));
        await expectParkedBy(s, state.parkedAfterHeal(s));
        expect(await kind.settled(s)).toBe(0);
        await expectStillOpen(kind, s, "after the money was recorded");
        await kind.expectNewTenderBlocked(s);
      });
    }

    it(`legend-24ogm ${kind.label} control: DOIT paid and recorded is still asked about every 24 h on day 8 and stays open`, async () => {
      const s = await kind.open();
      await owner.query(
        "UPDATE payment_intents SET expires_at = $3 WHERE tenant_id=$1 AND id=$2",
        [fx.tenant.tenantId, s.intentId, after(s.t0, -31 * MIN)],
      );
      answer(s, { status: "paid" });
      await kind.recon(after(s.t0, 1 * MIN));
      await expectParkedBy(s, [s.amount]);

      const day8 = after(s.t0, 8 * DAY);
      await kind.recon(day8);
      await expectStillOpen(kind, s, "day 8 paid and recorded");
      await expectSlowedNotStopped(kind, s, day8);
      await expectParkedBy(s, [s.amount]);
      expect(await kind.settled(s)).toBe(0);
    });
  },
);

/** Parked exactly once per amount: fund, evidence and event counts match. */
async function expectParkedBy(s: Subject, amounts: number[]) {
  await expectParked(s, amounts);
}

// ===================================================================== PART 3
// VA release: a provider answer older than a short limit at lock time is refused.

/** Skew `Date` of this process by `ms` (no real waiting). Reset after use. */
const RealDate = Date;
let skewMs = 0;
class SkewedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + skewMs);
    else super(...(args as [number]));
  }
  static override now() {
    return RealDate.now() + skewMs;
  }
}
function installSkew() {
  globalThis.Date = SkewedDate as unknown as DateConstructor;
}
function removeSkew() {
  skewMs = 0;
  globalThis.Date = RealDate;
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

/** An eligible VA code (31 min past expiry), provider pending. */
async function eligibleVaCode() {
  const s = await openVaCode();
  fx.gateway.script(s.intentId, { rawStatus: "01" });
  await owner.query(
    `UPDATE payment_intents
        SET expires_at = now() - $3::int * interval '1 minute'
      WHERE tenant_id=$1 AND id=$2`,
    [fx.tenant.tenantId, s.intentId, RELEASE_AFTER_MIN + 1],
  );
  return s;
}

/** POST the release while, right after the provider answered, the clock moves
 * `gapMs` and `during` runs: the provider read is that old at lock time. */
async function releaseWithGap(
  s: Subject,
  approval: ManagerApproval,
  gapMs: number,
  during?: () => void,
) {
  afterRead.set(s.providerRef, () => {
    during?.();
    skewMs += gapMs;
  });
  installSkew();
  try {
    return await releaseVaCode(s, approval);
  } finally {
    removeSkew();
    afterRead.delete(s.providerRef);
  }
}

describe("legend-24ogm VA release refuses a provider answer that is older than a short limit when the lock is taken", () => {
  it("legend-24ogm VA a 90 s old answer: 409 VA_RELEASE_PROVIDER_UNREAD, nothing released or audited, approval not spent; a fresh retry releases", async () => {
    const s = await eligibleVaCode();
    const approval = await kit.managerApproval(s.orderId, s.amount);

    const res = await releaseWithGap(s, approval, 90_000);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe("VA_RELEASE_PROVIDER_UNREAD");
    expect(await releaseRowCount(s.intentId), "no release row").toBe(0);
    expect(await auditCount(s.intentId), "no release audit").toBe(0);
    expect((await intentRow(s)).provider_final_at).toBeNull();
    expect(await paidIdr(s)).toBe(0);
    // The code still blocks a second payment code on the order.
    for (const method of ["va", "qris"] as const) {
      const replacement = await vaOrderCode(s.guest!, s.orderId, method);
      expect(replacement.status, JSON.stringify(replacement.body)).toBe(409);
    }

    // The caller may retry with the same approval; a fresh answer releases.
    const retry = await releaseVaCode(s, approval);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(await releaseRowCount(s.intentId)).toBe(1);
    expect(await auditCount(s.intentId)).toBe(1);
  });

  it("legend-24ogm VA control: a 5 s old answer is still fresh enough, the release succeeds once", async () => {
    const s = await eligibleVaCode();
    const approval = await kit.managerApproval(s.orderId, s.amount);

    const res = await releaseWithGap(s, approval, 5_000);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await releaseRowCount(s.intentId)).toBe(1);
    expect(await auditCount(s.intentId)).toBe(1);
  });

  it("legend-24ogm VA a payment that lands in the gap: release refused, no release row, money accounted once (bill or unallocated funds, never both, never lost), no second code", async () => {
    const s = await eligibleVaCode();
    const approval = await kit.managerApproval(s.orderId, s.amount);

    // The provider said pending at read time; the customer pays right after.
    const res = await releaseWithGap(s, approval, 90_000, () =>
      fx.gateway.script(s.intentId, { status: "paid" }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await releaseRowCount(s.intentId), "no release row").toBe(0);
    expect(await auditCount(s.intentId), "no release audit").toBe(0);

    // The next attempt reads the payment: still refused, nothing released.
    const again = await releaseVaCode(
      s,
      await kit.managerApproval(s.orderId, s.amount),
    );
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(await releaseRowCount(s.intentId)).toBe(0);
    expect(await auditCount(s.intentId)).toBe(0);

    // The outlet is not out of pocket and nobody paid twice: the amount is
    // either applied to the bill or parked, exactly once.
    await poll();
    const parked = (await funds(s)).reduce((sum, n) => sum + n, 0);
    expect(
      (await paidIdr(s)) + parked,
      "the paid amount is recorded exactly once",
    ).toBe(s.amount);
    expect(
      await outboxCountOf(fx, "payment.funds_unallocated", s.intentId),
    ).toBe(parked > 0 ? 1 : 0);
    // No second collectible code: a paid bill answers with the same code
    // (replay of the paid intent), never a new one.
    for (const method of ["va", "qris"] as const) {
      const replacement = await vaOrderCode(s.guest!, s.orderId, method);
      if (replacement.status === 409) continue;
      expect(replacement.status, JSON.stringify(replacement.body)).toBe(201);
      expect(
        replacement.body.data.id ?? replacement.body.data.paymentIntentId,
        "the paid bill returns the same code, not a new one",
      ).toBe(s.intentId);
    }
  });
});
