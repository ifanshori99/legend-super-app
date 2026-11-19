// legend-1075 R7-1 / I6 (P1, tier K "jangan sampai rugi"): the hold of a matched
// conflict must be committed in the transaction that checks the conflict, before
// the intent lock is released. Written from docs/briefs/1072-refund-ronde6-q45.md
// ("Ronde 7", R7-1), docs/briefs/1072-invarian.md (I6, "Test"), the second
// opinion report ronde 7 finding 1 and the 1072-harness, NOT from the
// implementation.
//
// Scenario (SO finding 1): payment T Rp100.000 (a payment code, no sales
// document); our refund R Rp30.000 completed with provider ref X; our refund R2
// Rp70.000 approved and waiting for finance (flag off, nothing registered). A
// signed `refund.succeeded` X/T of Rp80.000 matches R by id but reports a bigger
// amount, so the updater refuses to settle R with it (409) and the intent must be
// HELD (Rp80.000). If settle-manually of R2 can run between the refusal and the
// hold commit, the guest gets Rp80.000 + Rp70.000 + Rp30.000 = Rp180.000 for
// Rp100.000.
//
// Rules pinned:
//   - while the hold of the webhook is not committed, R2's settle does NOT
//     complete: it waits for the lock, or is refused;
//   - after both finished: one open hold of Rp80.000 for X, R2 not completed, the
//     completed money is only R's Rp30.000, and the next refund / settle is
//     refused;
//   - replays of the same report keep ONE hold;
//   - reverse order (R2 first, parked while it holds its locks; the webhook
//     arrives meanwhile) ends with the hold open too and nothing more can go out.
//
// BARRIERS (two PostgreSQL connections; no sleep decides pass or fail, polling
// only waits for a state, bounded):
//   Order 1: `vi.mock` wraps `fileOwnRefundSurplusHoldInTx` of
//   payment-provider-partial-refund: the wrapper awaits a test barrier BEFORE the
//   original runs. Where the fix files the hold (inside the locked updater
//   transaction) the settle on the second connection must wait on a Lock; where
//   the hold is filed in a new transaction after the rollback (the 74172df44
//   shape) the settle runs in the gap and completes: red.
//   (r1-04 uses a second barrier mode, see the DP credit paragraph below.)
//   Reverse order: a BEFORE UPDATE trigger on payment_refunds (this suite's tenant
//   only, inert while the gate is not held) parks R2's settle at its first update
//   of the refund row, with its locks held.
//
// DP credit apply (r1-04 of the invariant spec, legend-r7oi3): built in this
// file's own tenant. The DP fixture (reservation, closed session with Rp80.000
// customer credit, target bill, receipt journal) is written with plain SQL into the
// harness tenant, so the matched `refund.succeeded` webhook door and
// `applyReservationCustomerCredit` meet on the SAME intent. Barriers:
//   - r1-04 (order 1, the real guarantee): the webhook is parked AFTER it took the
//     exclusive `deposit-intent:` lock of its hold (vi.mock wraps
//     `lockDepositIntentsExclusive` of reservation-deposit-credit; it parks only
//     for that intent, inside the hold, and only while this test arms it). The
//     apply takes the shared `deposit-intent:` lock, so it must WAIT behind the
//     webhook and, once the hold is committed, be refused
//     CUSTOMER_CREDIT_NOT_AVAILABLE. Remove the shared lock of the apply and it
//     spends while the hold is pending: red.
//   - r1-04c (order 1, early barrier): the webhook is parked BEFORE the hold runs
//     (it holds row locks only, not the exclusive intent lock yet). The apply may
//     legitimately commit first (a whole Rp40.000 spend, as in r1-04b) or be
//     refused; the hold of Rp80.000 must still be filed afterwards.
//   - r1-04b (order 2): BEFORE triggers on reservation_deposit_remainders (UPDATE)
//     and reservation_customer_credit_uses (INSERT) park the apply after it took
//     its locks (the webhook comes in).
//
// Dropped: a "park at the hold INSERT with a trigger" variant. Its hold
// transaction holds the intent lock at the INSERT, so it cannot be red at the base.
//
// Assumptions (the brief does not fix them):
//   - "R2 refused" = HTTP 409 or 422; "waits" = a backend that was not waiting
//     before R2 started now waits on a lock (pg_locks not granted).
//   - A refusal of R2 before the hold exists (some other guard) is accepted; a 200
//     before the hold is committed is the bug.
//   - Reverse order: R2 may win (200) because it held its locks first; then the
//     hold of Rp80.000 must still be filed and nothing more may go out.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1075-r1-hold-atomic-race.test.ts" heavy pnpm test
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { idr } from "@starter/shared/core";
import {
  establishScopedTenantContext,
  establishTenantContext,
} from "@starter/shared/core/server";
import { env } from "../config/env";
import { resetPaymentRefundGateways } from "../services/payment-refund-gateway";
import { applyReservationCustomerCredit } from "../services/reservation-deposit-remainder.ts";
import { setTableSessionSettlementLookup } from "../services/table-session.service.ts";
import { agent, signUp } from "./helpers";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

// The barrier state lives in a hoisted object so the mock factories can reach it.
// `beforeHold`: park before `fileOwnRefundSurplusHoldInTx` runs (the webhook holds
// only row locks). `afterLock`: park right after the exclusive `deposit-intent:`
// lock of that hold was taken (`lockDepositIntentsExclusive` of
// reservation-deposit-credit, called inside the hold), the hold not yet written.
const barrier = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    /** The intent whose hold is being filed in this async context. */
    inHold: new AsyncLocalStorage<string>(),
    active: null as null | {
      mode: "beforeHold" | "afterLock";
      intentId: string;
      fired: boolean;
      reached: () => void;
      open: Promise<void>;
    },
  };
});

vi.mock("../services/payment-provider-partial-refund", async (original) => {
  const actual =
    await original<
      typeof import("../services/payment-provider-partial-refund")
    >();
  return {
    ...actual,
    fileOwnRefundSurplusHoldInTx: async (
      ...args: Parameters<typeof actual.fileOwnRefundSurplusHoldInTx>
    ) => {
      const parked = barrier.active;
      if (
        parked?.mode === "beforeHold" &&
        !parked.fired &&
        args[2].intentId === parked.intentId
      ) {
        parked.fired = true;
        parked.reached();
        await parked.open;
      }
      return await barrier.inHold.run(args[2].intentId, () =>
        actual.fileOwnRefundSurplusHoldInTx(...args),
      );
    },
  };
});

vi.mock("../services/reservation-deposit-credit", async (original) => {
  const actual =
    await original<typeof import("../services/reservation-deposit-credit")>();
  return {
    ...actual,
    lockDepositIntentsExclusive: async (
      ...args: Parameters<typeof actual.lockDepositIntentsExclusive>
    ) => {
      await actual.lockDepositIntentsExclusive(...args);
      const parked = barrier.active;
      if (
        parked?.mode === "afterLock" &&
        !parked.fired &&
        barrier.inHold.getStore() === parked.intentId &&
        args[2] === parked.intentId
      ) {
        parked.fired = true;
        parked.reached();
        await parked.open;
      }
    },
  };
});

const h = createRefundHarness("1075r1");

const R_IDR = 30_000;
const REPORTED_IDR = 80_000;
const R2_IDR = 70_000;
const EXTRA_IDR = 1_000;

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;

type Answer = { status: number; body: unknown };

/** Release 1 world: flag off, no refund port, R2 approved and waiting for finance. */
async function prepareR2(code: Code): Promise<string> {
  flags.DOIT_REFUNDS_ENABLED = false;
  resetPaymentRefundGateways(); // the production state: no refund port
  const filed = await h.manualRefund(code.id, R2_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const id = filed.body.data.id as string;
  const approved = await h.approveRefund(id);
  expect([200, 503], JSON.stringify(approved.body)).toContain(approved.status);
  expect((await h.refundRow(id)).status, "premise: R2 waits for finance").toBe(
    "approved",
  );
  // The flag was off only to queue R2. The signed report that follows is the
  // active matched path (switch on); with it off the webhook would only file
  // the 1101 conflict hold and never reach the hold under test.
  flags.DOIT_REFUNDS_ENABLED = true;
  return id;
}
const settle = async (id: string, amountIdr: number): Promise<Answer> =>
  await h.settleManually(id, amountIdr);

// Matched suites exercise the active provider-refund path: the baseline is
// DOIT refunds on (off by default); each test restores it, afterAll restores the original.
beforeAll(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterEach(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
  barrier.active = null;
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

// --- fixtures -------------------------------------------------------------------

/** T Rp100.000 paid, R Rp30.000 completed with ref X (through the fake provider). */
async function world() {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  // The refund API refuses a DP that is applied to a bill (REFUND_DEPOSIT_IN_USE),
  // so R is written as the end state of a refund of ours that completed with
  // ref X (the 1072-a2 way). No refund fact of the provider exists yet.
  const own = {
    refundId: randomUUID(),
    x: `rf_${randomBytes(6).toString("hex")}`,
  };
  await h.owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, completed_at, provider_ref, payout_attempts)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana 1075-r1', 'completed',
             'requester', 'approver', now(), now(), $6, 1)`,
    [own.refundId, h.tenantId, h.outletId, code.id, R_IDR, own.x],
  );
  return { code, ...own, callsBefore: h.fake.calls.length };
}
type World = Awaited<ReturnType<typeof world>>;

const report = (w: World) =>
  h.refundSucceededEvent(w.code.providerRef, w.x, REPORTED_IDR);

/** The webhook, the poller and the worker, as one driven unit. */
const webhookDriver = (w: World) => async () => {
  const answered = await h.deliver(report(w));
  await h.pollLater().catch(() => null);
  await h.runWorker();
  return answered;
};

// --- barriers -------------------------------------------------------------------

const gatePool = new Pool({
  connectionString: process.env.STARTER_TEST_DATABASE_URL,
  max: 4,
});
const suffix = randomBytes(4).toString("hex");
const K2 = Number.parseInt(randomBytes(3).toString("hex"), 16);
const K1_REFUND_UPDATE = 1_075_102;
const K1_CREDIT_APPLY = 1_075_104;
const triggers: { name: string; table: string }[] = [];

async function installGateTrigger(
  table: string,
  k1: number,
  event: "UPDATE" | "INSERT" = "UPDATE",
) {
  const name = `t1075r1_${suffix}_${k1}_${table.slice(0, 24)}`;
  // The tenant id is a UUID generated by the harness: safe to inline.
  await gatePool.query(
    `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.tenant_id::text = TG_ARGV[0] THEN
         PERFORM pg_advisory_xact_lock(${k1}, ${K2});
       END IF;
       RETURN NEW;
     END $$`,
  );
  await gatePool.query(
    `CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${name}('${h.tenantId}')`,
  );
  triggers.push({ name, table });
}

beforeAll(async () => {
  await installGateTrigger("payment_refunds", K1_REFUND_UPDATE);
  // The credit apply moves money in these two tables, after it took its locks.
  await installGateTrigger(
    "reservation_deposit_remainders",
    K1_CREDIT_APPLY,
    "UPDATE",
  );
  await installGateTrigger(
    "reservation_customer_credit_uses",
    K1_CREDIT_APPLY,
    "INSERT",
  );
});

afterAll(async () => {
  try {
    for (const { name, table } of triggers) {
      await gatePool.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await gatePool.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  } finally {
    await gatePool.end();
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `cond` holds; true when it did, false when the bound ran out. */
async function pollFor(
  cond: () => Promise<boolean> | boolean,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) return false;
    await sleep(40);
  }
  return true;
}

function track<T>(p: Promise<T>) {
  const state = { done: false };
  const result = p.then(
    (v) => {
      state.done = true;
      return v;
    },
    (e) => {
      state.done = true;
      throw e;
    },
  );
  result.catch(() => undefined);
  return { state, result };
}

type Gate = { blocked: () => Promise<boolean>; close: () => Promise<void> };

/** Holds the advisory lock (k1, K2): a trigger on that key parks until `close`. */
async function openGate(k1: number): Promise<Gate> {
  const client = await gatePool.connect();
  let closed = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::int, $2::int)", [k1, K2]);
  } catch (e) {
    client.release();
    throw e;
  }
  return {
    async blocked() {
      const { rows } = await gatePool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`,
        [k1, K2],
      );
      return rows[0]!.n > 0;
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [
          k1,
          K2,
        ]);
      } finally {
        client.release();
      }
    },
  };
}

/** Backends of this database that wait on a lock right now (pg_stat_activity: wait_event_type = 'Lock'). */
async function waitingPids(): Promise<number[]> {
  const { rows } = await gatePool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()`,
  );
  return rows.map((r) => r.pid);
}

// --- observations ---------------------------------------------------------------

const completedIdr = (w: World) =>
  h.count(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS n FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status = 'completed'`,
    [h.tenantId, w.code.id],
  );

async function expectReportHeld(w: World, label: string) {
  const open = (await h.openOf(w.code.id)).filter(
    (row) => row.provider_refund_id === w.x,
  );
  expect(
    open,
    `${label}: one open hold for X (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
  ).toHaveLength(1);
  expect(open[0]!.amount_idr, `${label}: worth the provider's report`).toBe(
    REPORTED_IDR,
  );
}

/** A new refund of Rp1.000 is refused, whichever way finance records it. */
async function expectNothingMoreOut(w: World, label: string) {
  const filed = await h.manualRefund(w.code.id, EXTRA_IDR);
  if (filed.status === 201) {
    const extraId = filed.body.data.id as string;
    await h.approveRefund(extraId); // flag off: stays approved, waits for finance
    const answered = await settle(extraId, EXTRA_IDR);
    expect(
      refusedStatuses,
      `${label}: recording ${EXTRA_IDR} more: ${JSON.stringify(answered.body)}`,
    ).toContain(answered.status);
  } else {
    expect(
      [409, 422],
      `${label}: requesting ${EXTRA_IDR} more: ${JSON.stringify(filed.body)}`,
    ).toContain(filed.status);
  }
  expect(
    h.fake.calls,
    `${label}: the provider was not asked for more`,
  ).toHaveLength(w.callsBefore);
}

// Settle of a refund the hold (or the cap) no longer allows answers 409; a 422
// would be the validation of the body, which proves nothing about the hold.
const refusedStatuses = [409];

// --- order 1: the webhook parks before its hold, settle of R2 comes in -----------

describe("R7-1 order 1: matched conflict parked before its hold is filed, settle of R2 comes in", () => {
  it("1075-r1-01 settle-manually R2 (flag off) while the webhook is parked before its hold: R2 waits for the lock or is refused, never completes; then one open hold of Rp80.000, completed money only R's Rp30.000, replays keep one hold", async () => {
    const label = "r1-01";
    const w = await world();
    const r2 = await prepareR2(w.code);

    let reached!: () => void;
    const reachedPromise = new Promise<void>((accept) => {
      reached = accept;
    });
    let open!: () => void;
    const openPromise = new Promise<void>((accept) => {
      open = accept;
    });
    barrier.active = {
      mode: "beforeHold",
      intentId: w.code.id,
      fired: false,
      reached,
      open: openPromise,
    };

    const driver = track(webhookDriver(w)());
    let racing: ReturnType<typeof track<Answer>> | null = null;
    try {
      const outcome = await Promise.race([
        reachedPromise.then(() => "parked" as const),
        driver.result.then(
          () => "finished" as const,
          () => "finished" as const,
        ),
      ]);
      expect(
        outcome,
        "premise: the webhook files the hold of a matched bigger report through fileOwnRefundSurplusHoldInTx",
      ).toBe("parked");

      const baseline = new Set(await waitingPids());
      racing = track(settle(r2, R2_IDR));
      await pollFor(
        async () =>
          racing!.state.done ||
          (await waitingPids()).some((pid) => !baseline.has(pid)),
        5_000,
      );
      if (racing.state.done) {
        const early = await racing.result;
        expect(
          refusedStatuses,
          `${label}: settle of R2 ran to the end (${early.status}) while the hold of Rp${REPORTED_IDR} was not committed: ${JSON.stringify(early.body)}`,
        ).toContain(early.status);
      }
    } finally {
      open();
    }
    const [answered, raced] = await Promise.all([
      driver.result,
      racing!.result,
    ]);

    expect(
      answered.status,
      `${label}: signed report not rejected`,
    ).toBeLessThan(500);
    expect(
      refusedStatuses,
      `${label}: settle of R2 is refused once the hold is committed: ${JSON.stringify(raced.body)}`,
    ).toContain(raced.status);
    await expectReportHeld(w, label);
    const row = await h.refundRow(r2);
    expect(row.status, `${label}: R2 was not completed`).not.toBe("completed");
    expect(
      await completedIdr(w),
      `${label}: the only completed money is R`,
    ).toBe(R_IDR);
    expect(h.fake.calls, `${label}: no payout beyond R`).toHaveLength(
      w.callsBefore,
    );
    expect(await h.refundRow(w.refundId)).toMatchObject({
      status: "completed",
      amount_idr: String(R_IDR),
      provider_ref: w.x,
    });

    // Replay of the same evidence: still one hold, R2 still refused.
    await h.replayAll(() => report(w), 2);
    await expectReportHeld(w, `${label} after replays`);
    const again = await settle(r2, R2_IDR);
    expect(
      refusedStatuses,
      `${label}: R2 again after replays: ${JSON.stringify(again.body)}`,
    ).toContain(again.status);
    expect((await h.refundRow(r2)).status).not.toBe("completed");
    expect(await completedIdr(w)).toBe(R_IDR);
    await expectNothingMoreOut(w, label);
  }, 90_000);
});

// --- order 2: settle of R2 parks first holding its locks, the webhook arrives ---

describe("R7-1 order 2: R2 holds its locks first, the matched conflict arrives meanwhile", () => {
  it("1075-r1-02 settle-manually R2 (flag off) parked after it took its locks: the webhook waits for it or finishes; afterwards one open hold of Rp80.000, nothing more can go out, replays keep one hold", async () => {
    const label = "r1-02";
    const w = await world();
    const r2 = await prepareR2(w.code);

    const gate = await openGate(K1_REFUND_UPDATE);
    let racing: ReturnType<typeof track<Answer>> | null = null;
    let driver: ReturnType<typeof track<Answer>> | null = null;
    try {
      racing = track(settle(r2, R2_IDR));
      await pollFor(
        async () => (await gate.blocked()) || racing!.state.done,
        15_000,
      );
      if (!(await gate.blocked())) {
        const early = racing.state.done ? await racing.result : null;
        throw new Error(
          `premise: settle of R2 parked at its first update of the refund row, but it ${early ? `finished with ${early.status} ${JSON.stringify(early.body)}` : "never parked"}`,
        );
      }

      const baseline = new Set(await waitingPids());
      driver = track(webhookDriver(w)());
      await pollFor(
        async () =>
          driver!.state.done ||
          (await waitingPids()).some((pid) => !baseline.has(pid)),
        5_000,
      );
    } finally {
      await gate.close();
    }
    const [raced, answered] = await Promise.all([
      racing!.result,
      driver!.result,
    ]);

    expect(
      answered.status,
      `${label}: signed report not rejected`,
    ).toBeLessThan(500);
    expect(
      [200, ...refusedStatuses],
      `${label}: R2 won its locks first or was refused: ${JSON.stringify(raced.body)}`,
    ).toContain(raced.status);
    await expectReportHeld(w, `${label} (R2 status ${raced.status})`);
    expect(await h.refundRow(w.refundId)).toMatchObject({
      status: "completed",
      amount_idr: String(R_IDR),
      provider_ref: w.x,
    });
    expect(
      await completedIdr(w),
      `${label}: completed money is R, plus R2 only if it won`,
    ).toBeLessThanOrEqual(R_IDR + R2_IDR);

    await h.replayAll(() => report(w), 2);
    await expectReportHeld(w, `${label} after replays`);
    await expectNothingMoreOut(w, label);
  }, 90_000);
});

// --- control: no race ----------------------------------------------------------

describe("R7-1 control: sequential, no race", () => {
  it("1075-r1-03 the signed report is fully processed first (no barrier): one open hold of Rp80.000, settle-manually of R2 is refused, R stays Rp30.000", async () => {
    const w = await world();
    const r2 = await prepareR2(w.code);

    const answered = await webhookDriver(w)();
    expect(answered.status, "signed report not rejected").toBeLessThan(500);
    await expectReportHeld(w, "r1-03");

    const settled = await settle(r2, R2_IDR);
    expect(
      refusedStatuses,
      `settle after the hold: ${JSON.stringify(settled.body)}`,
    ).toContain(settled.status);
    expect((await h.refundRow(r2)).status).not.toBe("completed");
    expect(await completedIdr(w)).toBe(R_IDR);
  }, 90_000);

  it("1075-r1-00 fixture control: with no report at all, settle-manually of R2 completes (the racer works in this world)", async () => {
    const w = await world();
    const r2 = await prepareR2(w.code);
    const settled = await settle(r2, R2_IDR);
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect((await h.refundRow(r2)).status).toBe("completed");
    expect(await completedIdr(w)).toBe(R_IDR + R2_IDR);
  }, 90_000);
});

// --- r1-04: DP credit apply vs the matched conflict -----------------------------
//
// Assumptions (the brief does not fix them):
//   - World: DP intent T Rp100.000 (a payment code of this tenant attached to a
//     seated reservation), the source session consumed Rp20.000 and closed, so
//     Rp80.000 transferable customer credit; our refund R Rp30.000 FAILED on our
//     side but carries ref X (see dpWorld); target bill Rp40.000 of the same customer. Net credit before the
//     hold: 100.000 - 20.000 = 80.000 >= 40.000 (R failed counts for nothing) (control r1-04-00).
//   - The signed report X/T of Rp80.000 (bigger than R) files the hold of
//     Rp80.000 through `fileOwnRefundSurplusHoldInTx`; after it the net is
//     negative: nothing of the pool is spendable.
//   - Order 1 (webhook parked before its hold): the apply must NOT spend; it waits
//     for the lock or is refused CUSTOMER_CREDIT_NOT_AVAILABLE. A spend before the
//     hold is committed is the bug.
//   - Order 2 (apply parked after its locks): the apply may win (a whole
//     Rp40.000 spend, as 1072-a2 accepts) or be refused with the credit untouched;
//     never a partial spend. The hold of Rp80.000 must exist in the end either way.

// R: the refund of ours that failed on our side (see dpWorld).
const DP_R_IDR = 30_000;
const CREDIT_CONSUMED = 20_000;
const CREDIT_POOL = BILL_IDR - CREDIT_CONSUMED;
const CREDIT_SPEND = 40_000;
const dpScope = () =>
  establishScopedTenantContext(
    establishTenantContext({
      tenantId: h.tenantId,
      brandId: null,
      source: "session",
    }),
    { kind: "tenant" },
  );
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const dp = {
  zoneIds: [] as string[],
  tableIds: [] as string[],
  sessionIds: [] as string[],
  orderIds: [] as string[],
  reservationIds: [] as string[],
  profileIds: [] as string[],
  receiptEntries: [] as string[],
  receiptAccounts: [randomUUID(), randomUUID()],
  settlements: new Map<string, { total: number; paid: number }>(),
  legalEntityId: "",
  periodId: "",
  userId: "",
};

beforeAll(async () => {
  const entity = await h.owner.query<{ legal_entity_id: string }>(
    "SELECT legal_entity_id FROM outlets WHERE id = $1",
    [h.outletId],
  );
  dp.legalEntityId = entity.rows[0]!.legal_entity_id;
  for (const [i, type, group] of [
    [0, "asset", "current_asset"],
    [1, "liability", "current_liability"],
  ] as const)
    await h.owner.query(
      `INSERT INTO chart_of_accounts(id,tenant_id,legal_entity_id,code,name,type,report_group)
       VALUES($1,$2,$3,$4,'1075-r1 DP receipt',$5,$6)`,
      [
        dp.receiptAccounts[i],
        h.tenantId,
        dp.legalEntityId,
        `993.${i + 1}`,
        type,
        group,
      ],
    );
  const period = new Date().toISOString().slice(0, 7);
  await h.owner.query(
    `INSERT INTO fiscal_periods(tenant_id,legal_entity_id,period) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
    [h.tenantId, dp.legalEntityId, period],
  );
  dp.periodId = (
    await h.owner.query<{ id: string }>(
      "SELECT id FROM fiscal_periods WHERE tenant_id=$1 AND legal_entity_id=$2 AND period=$3",
      [h.tenantId, dp.legalEntityId, period],
    )
  ).rows[0]!.id;
  setTableSessionSettlementLookup(async ({ sessionId }) => {
    const found = dp.settlements.get(sessionId);
    return found
      ? { billTotalIdr: idr(found.total), paidIdr: idr(found.paid) }
      : null;
  });
  const client = agent(h.app);
  await signUp(client, "1075-r1-04 cashier");
  const session = await client.get("/api/auth/get-session");
  dp.userId = session.body.user.id as string;
  // The apply is permission-checked: the user is an owner of this tenant.
  await h.owner.query(
    `INSERT INTO role_assignments (tenant_id, user_id, role_id, scope_type, scope_id, valid_from, assigned_by)
     SELECT $1, $2, id, 'tenant', NULL, now() - interval '1 hour', $2
       FROM roles WHERE tenant_id = $1 AND template_key = 'owner'`,
    [h.tenantId, dp.userId],
  );
});

// Registered after the harness hooks: runs before the harness removes the intents.
afterAll(async () => {
  setTableSessionSettlementLookup(null);
  const client = await h.owner.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const t = [h.tenantId];
    await client.query(
      "DELETE FROM journal_lines WHERE tenant_id = $1 AND entry_id = ANY($2::uuid[])",
      [h.tenantId, dp.receiptEntries],
    );
    await client.query(
      "DELETE FROM journal_entries WHERE id = ANY($1::uuid[])",
      [dp.receiptEntries],
    );
    await client.query(
      "DELETE FROM chart_of_accounts WHERE id = ANY($1::uuid[])",
      [dp.receiptAccounts],
    );
    for (const table of [
      "reservation_credit_recon_flags",
      "reservation_customer_credit_uses",
      "reservation_deposit_remainders",
      "reservation_deposit_allocations",
    ])
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, t);
    await client.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [
      dp.orderIds,
    ]);
    await client.query(
      "DELETE FROM table_sessions WHERE id = ANY($1::uuid[])",
      [dp.sessionIds],
    );
    await client.query("DELETE FROM tables WHERE id = ANY($1::uuid[])", [
      dp.tableIds,
    ]);
    await client.query("DELETE FROM floor_zones WHERE id = ANY($1::uuid[])", [
      dp.zoneIds,
    ]);
    await client.query("DELETE FROM reservations WHERE id = ANY($1::uuid[])", [
      dp.reservationIds,
    ]);
    await client.query(
      "DELETE FROM role_assignments WHERE tenant_id = $1 AND user_id = $2",
      [h.tenantId, dp.userId],
    );
    await client.query(
      "DELETE FROM customer_profiles WHERE id = ANY($1::uuid[])",
      [dp.profileIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

async function dpSession(status: "open" | "closed") {
  const zoneId = randomUUID();
  const tableId = randomUUID();
  const sessionId = randomUUID();
  dp.zoneIds.push(zoneId);
  dp.tableIds.push(tableId);
  dp.sessionIds.push(sessionId);
  await h.owner.query(
    `INSERT INTO floor_zones (id, tenant_id, outlet_id, name, payment_mode, hours)
     VALUES ($1,$2,$3,$4,'pay_first','[]')`,
    [zoneId, h.tenantId, h.outletId, `DP ${zoneId.slice(0, 8)}`],
  );
  await h.owner.query(
    `INSERT INTO tables (id,tenant_id,outlet_id,zone_id,code,capacity,type,layout)
     VALUES ($1,$2,$3,$4,$5,2,'regular','{}')`,
    [
      tableId,
      h.tenantId,
      h.outletId,
      zoneId,
      `D${tableId.slice(0, 8).toUpperCase()}`,
    ],
  );
  await h.owner.query(
    `INSERT INTO table_sessions
       (id,tenant_id,outlet_id,table_id,pax,payment_mode,status,session_token_hash,session_token_sealed)
     VALUES ($1,$2,$3,$4,2,'pay_first','open',$5,'test')`,
    [sessionId, h.tenantId, h.outletId, tableId, sha(sessionId)],
  );
  if (status === "closed")
    await h.owner.query(
      `UPDATE table_sessions SET status = 'closed', closed_at = now(), closed_reason = 'paid_and_cleaned' WHERE id = $1`,
      [sessionId],
    );
  return { sessionId, zoneId };
}

async function dpOrder(
  sessionId: string,
  total: number,
  deposit: number,
  profileId: string,
) {
  const id = randomUUID();
  dp.orderIds.push(id);
  await h.owner.query(
    `INSERT INTO orders
       (id, tenant_id, outlet_id, number, channel, service_type, payment_mode,
        subtotal_idr, discount_idr, service_charge_idr, tax_idr, rounding_idr,
        total_idr, deposit_applied_idr, status, business_date, placed_at,
        table_session_id, customer_profile_id)
     VALUES ($1, $2, $3, $4, 'pos', 'dine_in', 'pay_first', $5, 0, 0, 0, 0,
             $5, $6, 'sent', '2026-11-12', now(), $7, $8)`,
    [
      id,
      h.tenantId,
      h.outletId,
      `R1-${id.slice(0, 8)}`,
      total,
      deposit,
      sessionId,
      profileId,
    ],
  );
}

/**
 * The DP world: `code` (paid Rp100.000 of this tenant) becomes the deposit of a
 * seated reservation whose session consumed Rp20.000 and closed (Rp80.000 credit).
 */
async function dpWorld() {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);

  const profileId = randomUUID();
  dp.profileIds.push(profileId);
  await h.owner.query(
    `INSERT INTO customer_profiles (id, tenant_id, name, membership_status, whatsapp_verified_at)
     VALUES ($1, $2, '1075-r1-04 Customer', 'active', now())`,
    [profileId, h.tenantId],
  );
  const source = await dpSession("open");
  const reservationId = randomUUID();
  dp.reservationIds.push(reservationId);
  await h.owner.query(
    `INSERT INTO reservations
       (id, tenant_id, outlet_id, customer_profile_id, guest_name, reserved_for,
        duration_minutes, pax, zone_id, deposit_idr, policy_snapshot, status,
        source, seated_at, table_session_id)
     VALUES ($1, $2, $3, $4, '1075-r1 Payer', now(), 90, 2, $5, $6, $7,
             'seated', 'staff', now(), $8)`,
    [
      reservationId,
      h.tenantId,
      h.outletId,
      profileId,
      source.zoneId,
      BILL_IDR,
      JSON.stringify({
        version: "t1075r1",
        depositRequirement: "required",
        depositAmountIdr: BILL_IDR,
        paymentWindowMinutes: 60,
        freeCancellationHours: 24,
        lateCancellationRefundBp: 0,
        noShowRefundBp: 0,
        minimumSpendIdr: 0,
        capturedAt: new Date().toISOString(),
      }),
      source.sessionId,
    ],
  );
  await h.owner.query(
    "UPDATE payment_intents SET reservation_id = $2 WHERE id = $1",
    [code.id, reservationId],
  );
  await h.owner.query(
    `UPDATE reservations SET deposit_payment_id = $2, deposit_payment_link_id = $3 WHERE id = $1`,
    [reservationId, code.id, code.linkId],
  );
  await h.owner.query(
    "UPDATE table_sessions SET reservation_id = $2 WHERE id = $1",
    [source.sessionId, reservationId],
  );
  await h.owner.query(
    `INSERT INTO reservation_deposit_allocations
       (tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id, amount_idr)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      h.tenantId,
      h.outletId,
      reservationId,
      source.sessionId,
      code.id,
      BILL_IDR,
    ],
  );
  await dpOrder(source.sessionId, CREDIT_CONSUMED, CREDIT_CONSUMED, profileId);
  await h.owner.query(
    `INSERT INTO reservation_deposit_remainders
       (id, tenant_id, outlet_id, reservation_id, table_session_id, payment_intent_id,
        customer_profile_id, amount_idr, remaining_idr, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, 'customer_credit')`,
    [
      randomUUID(),
      h.tenantId,
      h.outletId,
      reservationId,
      source.sessionId,
      code.id,
      profileId,
      CREDIT_POOL,
    ],
  );
  await h.owner.query(
    `UPDATE table_sessions SET status = 'closed', closed_at = now(), closed_reason = 'paid_and_cleaned' WHERE id = $1`,
    [source.sessionId],
  );
  // The receipt journal of the original DP (as 1072-a2 seeds it).
  const journalId = randomUUID();
  const journal = await h.owner.connect();
  try {
    await journal.query("BEGIN");
    dp.receiptEntries.push(journalId);
    await journal.query(
      `INSERT INTO journal_entries(id,tenant_id,legal_entity_id,outlet_id,entry_date,fiscal_period_id,source_type,source_id,description,idempotency_key,request_fingerprint)
     VALUES($1,$2,$3,$4,$5,$6,'customer_deposit',$7,'Penerimaan DP 1075-r1',$8,$9)`,
      [
        journalId,
        h.tenantId,
        dp.legalEntityId,
        h.outletId,
        new Date().toISOString().slice(0, 10),
        dp.periodId,
        code.id,
        `aj:receipt:${code.id}`,
        "0".repeat(64),
      ],
    );
    await journal.query(
      `INSERT INTO journal_lines(tenant_id,entry_id,account_id,line_no,debit_idr,credit_idr,outlet_id)
     VALUES($1,$2,$3,1,$5,0,$6),($1,$2,$4,2,0,$5,$6)`,
      [
        h.tenantId,
        journalId,
        dp.receiptAccounts[0],
        dp.receiptAccounts[1],
        BILL_IDR,
        h.outletId,
      ],
    );
    await journal.query("COMMIT");
  } catch (error) {
    await journal.query("ROLLBACK");
    throw error;
  } finally {
    journal.release();
  }

  // The second visit of the same customer with an open bill.
  const target = await dpSession("open");
  await dpOrder(target.sessionId, CREDIT_SPEND, 0, profileId);
  dp.settlements.set(target.sessionId, { total: CREDIT_SPEND, paid: 0 });

  // The refund API refuses a DP that is applied to a bill (REFUND_DEPOSIT_IN_USE),
  // so R is written as the end state of a refund of ours that completed with
  // ref X (the 1072-a2 way). No refund fact of the provider exists yet.
  // R is a refund of ours that FAILED on our side (provider_declined) but carries
  // ref X. Any other own refund of the DP (pending, approved, completed, with or
  // without an echo fact) makes the pool unspendable before any lock is taken
  // (probed), so a failed R is the only shape where the pool is spendable and
  // the signed `refund.succeeded` X/T still matches our refund by id.
  const own = {
    refundId: randomUUID(),
    x: `rf_${randomBytes(6).toString("hex")}`,
  };
  await h.owner.query(
    `INSERT INTO payment_refunds
       (id, tenant_id, outlet_id, payment_intent_id, amount_idr, reason, status,
        requested_by, approved_by, decided_at, provider_ref, payout_attempts, failure_reason)
     VALUES ($1, $2, $3, $4, $5, 'Pengembalian dana 1075-r1', 'failed',
             'requester', 'approver', now(), $6, 1, 'provider_declined')`,
    [own.refundId, h.tenantId, h.outletId, code.id, DP_R_IDR, own.x],
  );
  return {
    code,
    ...own,
    callsBefore: h.fake.calls.length,
    reservationId,
    profileId,
    target: target.sessionId,
  };
}
type DpWorld = Awaited<ReturnType<typeof dpWorld>>;

type Attempt =
  { outcome: "spent" } | { outcome: "refused"; code: string | undefined };

/** One apply of the pool credit, settled (never throws). */
const attemptApply = (w: DpWorld, sessionId: string, amount: number) =>
  applyReservationCustomerCredit(
    dpScope(),
    dp.userId,
    h.outletId,
    {
      customerProfileId: w.profileId,
      tableSessionId: sessionId,
      amountIdr: idr(amount),
    },
    randomUUID(),
  ).then(
    (): Attempt => ({ outcome: "spent" }),
    (error: { code?: string }): Attempt => ({
      outcome: "refused",
      code: error?.code,
    }),
  );

const dpReport = (w: DpWorld) =>
  h.refundSucceededEvent(w.code.providerRef, w.x, REPORTED_IDR);
const dpWebhook = (w: DpWorld) => async () => {
  const answered = await h.deliver(dpReport(w));
  await h.pollLater().catch(() => null);
  await h.runWorker();
  return answered;
};

async function remainingIdr(w: DpWorld): Promise<number> {
  return await h.count(
    `SELECT COALESCE(SUM(remaining_idr), 0)::text AS n FROM reservation_deposit_remainders
      WHERE tenant_id = $1 AND reservation_id = $2`,
    [h.tenantId, w.reservationId],
  );
}
async function usedIdr(w: DpWorld): Promise<number> {
  return await h.count(
    `SELECT COALESCE(SUM(u.amount_idr), 0)::text AS n
       FROM reservation_customer_credit_uses u
       JOIN reservation_deposit_remainders r ON r.id = u.remainder_id
      WHERE u.tenant_id = $1 AND r.reservation_id = $2`,
    [h.tenantId, w.reservationId],
  );
}
const completedOf = (w: DpWorld) =>
  h.count(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS n FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status = 'completed'`,
    [h.tenantId, w.code.id],
  );

/** After both parties finished: no partial spend, one open hold, nothing more spendable. */
async function expectDpEndState(
  w: DpWorld,
  label: string,
  mayHaveSpent: boolean,
) {
  const used = await usedIdr(w);
  const remaining = await remainingIdr(w);
  expect(
    mayHaveSpent ? [0, CREDIT_SPEND] : [0],
    `${label}: the pool was spent whole or not at all (used ${used})`,
  ).toContain(used);
  expect(remaining, `${label}: spent + remaining = the pool`).toBe(
    CREDIT_POOL - used,
  );
  await expectReportHeld(w as unknown as World, label);
  expect(
    await completedOf(w),
    `${label}: no money of ours was completed (R failed)`,
  ).toBe(0);
  expect(h.fake.calls, `${label}: no payout`).toHaveLength(w.callsBefore);
  const probe = await dpSession("open");
  await dpOrder(probe.sessionId, 1_000, 0, w.profileId);
  dp.settlements.set(probe.sessionId, { total: 1_000, paid: 0 });
  const more = await attemptApply(w, probe.sessionId, 1_000);
  expect(
    more,
    `${label}: with the hold open nothing more of the pool is spendable`,
  ).toEqual({ outcome: "refused", code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
}

describe("R7-1 r1-04: DP credit apply vs the matched conflict, both barrier orders", () => {
  it("1075-r1-04-00 fixture control: with no report at all the apply spends Rp40.000 of the pool", async () => {
    const w = await dpWorld();
    expect(await remainingIdr(w), "premise: Rp80.000 credit").toBe(CREDIT_POOL);
    const spent = await attemptApply(w, w.target, CREDIT_SPEND);
    expect(spent, "the racer works in this world").toEqual({
      outcome: "spent",
    });
    expect(await usedIdr(w)).toBe(CREDIT_SPEND);
    expect(await remainingIdr(w)).toBe(CREDIT_POOL - CREDIT_SPEND);
  }, 90_000);

  it("1075-r1-04 order 1: the webhook is parked after it took the exclusive intent lock of its hold, the apply comes in: it waits for the lock and is refused, never spends; then one open hold of Rp80.000, the pool untouched, replays keep one hold", async () => {
    const label = "r1-04";
    const w = await dpWorld();

    let reached!: () => void;
    const reachedPromise = new Promise<void>((accept) => {
      reached = accept;
    });
    let open!: () => void;
    const openPromise = new Promise<void>((accept) => {
      open = accept;
    });
    barrier.active = {
      mode: "afterLock",
      intentId: w.code.id,
      fired: false,
      reached,
      open: openPromise,
    };

    const driver = track(dpWebhook(w)());
    let racing: ReturnType<typeof track<Attempt>> | null = null;
    try {
      const outcome = await Promise.race([
        reachedPromise.then(() => "parked" as const),
        driver.result.then(
          () => "finished" as const,
          () => "finished" as const,
        ),
      ]);
      expect(
        outcome,
        "premise: the webhook takes the exclusive intent lock inside the hold of a matched bigger report of the DP",
      ).toBe("parked");

      const baseline = new Set(await waitingPids());
      racing = track(attemptApply(w, w.target, CREDIT_SPEND));
      await pollFor(
        async () =>
          racing!.state.done ||
          (await waitingPids()).some((pid) => !baseline.has(pid)),
        5_000,
      );
      if (racing.state.done) {
        const early = await racing.result;
        expect(
          early,
          `${label}: the apply ran to the end while the webhook held the exclusive intent lock and its hold of Rp${REPORTED_IDR} was not committed`,
        ).toEqual({
          outcome: "refused",
          code: "CUSTOMER_CREDIT_NOT_AVAILABLE",
        });
      }
    } finally {
      open();
    }
    const [answered, raced] = await Promise.all([
      driver.result,
      racing!.result,
    ]);

    expect(
      answered.status,
      `${label}: signed report not rejected`,
    ).toBeLessThan(500);
    expect(
      raced,
      `${label}: once the hold is committed the apply is refused`,
    ).toEqual({ outcome: "refused", code: "CUSTOMER_CREDIT_NOT_AVAILABLE" });
    expect(await usedIdr(w), `${label}: nothing of the pool was used`).toBe(0);
    await expectDpEndState(w, label, false);

    await h.replayAll(() => dpReport(w), 2);
    await expectDpEndState(w, `${label} after replays`, false);
  }, 90_000);

  it("1075-r1-04c order 1, early barrier: the webhook is parked before its hold runs (row locks only), the apply comes in: it spends Rp40.000 whole or is refused; then one open hold of Rp80.000, nothing more is spendable, replays keep one hold", async () => {
    const label = "r1-04c";
    const w = await dpWorld();

    let reached!: () => void;
    const reachedPromise = new Promise<void>((accept) => {
      reached = accept;
    });
    let open!: () => void;
    const openPromise = new Promise<void>((accept) => {
      open = accept;
    });
    barrier.active = {
      mode: "beforeHold",
      intentId: w.code.id,
      fired: false,
      reached,
      open: openPromise,
    };

    const driver = track(dpWebhook(w)());
    let racing: ReturnType<typeof track<Attempt>> | null = null;
    try {
      const outcome = await Promise.race([
        reachedPromise.then(() => "parked" as const),
        driver.result.then(
          () => "finished" as const,
          () => "finished" as const,
        ),
      ]);
      expect(
        outcome,
        "premise: the webhook files the hold of a matched bigger report of the DP through fileOwnRefundSurplusHoldInTx",
      ).toBe("parked");

      const baseline = new Set(await waitingPids());
      racing = track(attemptApply(w, w.target, CREDIT_SPEND));
      await pollFor(
        async () =>
          racing!.state.done ||
          (await waitingPids()).some((pid) => !baseline.has(pid)),
        5_000,
      );
    } finally {
      open();
    }
    const [answered, raced] = await Promise.all([
      driver.result,
      racing!.result,
    ]);

    expect(
      answered.status,
      `${label}: signed report not rejected`,
    ).toBeLessThan(500);
    if (raced.outcome === "refused")
      expect(raced.code, `${label}: a refused apply says why`).toBe(
        "CUSTOMER_CREDIT_NOT_AVAILABLE",
      );
    await expectDpEndState(w, `${label} (apply ${raced.outcome})`, true);

    await h.replayAll(() => dpReport(w), 2);
    await expectDpEndState(w, `${label} after replays`, true);
  }, 90_000);

  it("1075-r1-04b order 2: the apply is parked after its locks, the webhook comes in: the webhook waits or finishes; the apply spends Rp40.000 whole or is refused; then one open hold of Rp80.000 and nothing more is spendable", async () => {
    const label = "r1-04b";
    const w = await dpWorld();

    const gate = await openGate(K1_CREDIT_APPLY);
    let racing: ReturnType<typeof track<Attempt>> | null = null;
    let driver: ReturnType<
      typeof track<Awaited<ReturnType<ReturnType<typeof dpWebhook>>>>
    > | null = null;
    try {
      racing = track(attemptApply(w, w.target, CREDIT_SPEND));
      await pollFor(
        async () => (await gate.blocked()) || racing!.state.done,
        15_000,
      );
      if (!(await gate.blocked())) {
        const early = racing.state.done ? await racing.result : null;
        throw new Error(
          `premise: the apply parked at its first write of the credit rows, but it ${early ? `finished with ${JSON.stringify(early)}` : "never parked"}`,
        );
      }

      const baseline = new Set(await waitingPids());
      driver = track(dpWebhook(w)());
      await pollFor(
        async () =>
          driver!.state.done ||
          (await waitingPids()).some((pid) => !baseline.has(pid)),
        5_000,
      );
    } finally {
      await gate.close();
    }
    const [raced, answered] = await Promise.all([
      racing!.result,
      driver!.result,
    ]);

    expect(
      answered.status,
      `${label}: signed report not rejected`,
    ).toBeLessThan(500);
    if (raced.outcome === "refused")
      expect(raced.code, `${label}: a refused apply says why`).toBe(
        "CUSTOMER_CREDIT_NOT_AVAILABLE",
      );
    await expectDpEndState(w, `${label} (apply ${raced.outcome})`, true);

    await h.replayAll(() => dpReport(w), 2);
    await expectDpEndState(w, `${label} after replays`, true);
  }, 90_000);
});
