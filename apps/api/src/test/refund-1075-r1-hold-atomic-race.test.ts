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
//   Reverse order: a BEFORE UPDATE trigger on payment_refunds (this suite's tenant
//   only, inert while the gate is not held) parks R2's settle at its first update
//   of the refund row, with its locks held.
//
// DP credit apply (r1-03 of the invariant spec) is not in this file: it needs
// reservation, session and remainder fixtures of the seeded tenant, while the
// matched webhook door needs this harness' tenant. The recorder door against the
// credit apply has both barrier orders in 1072-a2 (a2-07) and 1063-b.
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
import { randomBytes } from "node:crypto";
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
import { env } from "../config/env";
import { resetPaymentRefundGateways } from "../services/payment-refund-gateway";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

// The barrier state lives in a hoisted object so the mock factory can reach it.
const barrier = vi.hoisted(() => ({
  active: null as null | {
    intentId: string;
    fired: boolean;
    reached: () => void;
    open: Promise<void>;
  },
}));

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
      if (parked && !parked.fired && args[2].intentId === parked.intentId) {
        parked.fired = true;
        parked.reached();
        await parked.open;
      }
      return actual.fileOwnRefundSurplusHoldInTx(...args);
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
  const own = await h.ownCompletedRefund(code, R_IDR);
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
const triggers: { name: string; table: string }[] = [];

async function installGateTrigger(table: string, k1: number) {
  const name = `t1075r1_${suffix}_${k1}`;
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
    `CREATE TRIGGER ${name} BEFORE UPDATE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${name}('${h.tenantId}')`,
  );
  triggers.push({ name, table });
}

beforeAll(async () => {
  await installGateTrigger("payment_refunds", K1_REFUND_UPDATE);
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

  it.todo(
    "1075-r1-04 DP credit apply vs the matched conflict (not built: needs reservation, session and remainder fixtures in the DOIT-integration tenant; see header)",
  );
});
