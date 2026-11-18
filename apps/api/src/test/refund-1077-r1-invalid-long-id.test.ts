// (brief 1084 "Keputusan CTO", SO ronde 8 finding 1 = refund 1077 R1, P1, tier K
// "jangan sampai rugi"): red-first tests, written from
// docs/qa/second-opinion-refund-ronde8-1077.md (finding 1), docs/briefs/1072-invarian.md
// (I1/I8) and the pattern of refund-1075-r3-matched-unproven-success.test.ts and
// refund-1075-r1-hold-atomic-race.test.ts, not from the implementation.
//
// Rule under test (CTO decision): a signed `refund.succeeded` whose amount is
// unreadable (not canonical, missing) must ALWAYS leave one open hold of the whole
// payment, whatever the length of the refund id the parser accepts (up to 100
// ASCII characters). Today the hold id of such a report gets an `invalid:` prefix
// (8 characters) and the hold table column is 100 wide: a 93..100 character id makes
// the hold INSERT fail, the webhook answers 500 and NO hold survives.
//
// Scenario: T Rp100.000; R Rp30.000 completed (provider ref X); R2 Rp70.000 approved
// and waiting for finance (provider refunds off, the production state). Signed
// refund.succeeded for T carries an unreadable amount.
//   Family A: keyed `refund:<R>` with a refund id Y of its own (n chars).
//   Family B: the SO scenario: R carries a ref X of n chars and the report names X
//             (no key).
//   n = 92 (control: fits with the prefix, must pass today), 93 and 100 (overflow).
//
// Rules pinned:
//   - the webhook never answers 5xx;
//   - exactly one open hold of the whole payment (Rp100.000) exists, replays (new
//     event id, same evidence; poller; worker) keep it ONE row;
//   - settle-manually of R2 is refused (409), R2 stays approved;
//   - no fabricated provider fact or `payment.provider_refunded` journal event, R is
//     untouched, completed money is only R's Rp30.000, the provider is not asked;
//   - two different 100-char ids that share a 92-char prefix stay DISTINCT holds
//     (no truncation that merges different evidence), each worth Rp100.000.
//
// Assumptions (the brief does not fix them):
//   - "the hold" = open refund_recon_holds row of the intent; the stored id form
//     (hash, truncated, wider column) is not pinned, only the count and the amount.
//   - The refusal of R2 is HTTP 409 (a 422 would be body validation, proves nothing).
//   - DP credit of the same payment is not built here (needs reservation and session
//     fixtures of the seeded tenant, see header of refund-1075-r1-hold-atomic-race);
//     R2's settle plus the whole-payment hold stand for "nothing more may go out".
//   - R's provider_ref is overwritten directly in the database to build family B
//     with a 100-char X; the fake provider only makes short refs.
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1077-r1-invalid-long-id.test.ts" heavy pnpm test

import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { env } from "../config/env";
import { resetPaymentRefundGateways } from "../services/payment-refund-gateway";
import {
  BILL_IDR,
  createRefundHarness,
  type Code,
} from "./refund-1072-harness";

const h = createRefundHarness("1077r1");

const R_IDR = 30_000;
const R2_IDR = 70_000;

const flags = env as unknown as { DOIT_REFUNDS_ENABLED: boolean };
const flagBefore = flags.DOIT_REFUNDS_ENABLED;
// Matched suites exercise the active provider-refund path: the baseline is
// DOIT refunds on (off by default); each test restores it, afterAll restores the original.
beforeAll(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterEach(() => {
  flags.DOIT_REFUNDS_ENABLED = true;
});
afterAll(() => {
  flags.DOIT_REFUNDS_ENABLED = flagBefore;
});

/** An ASCII refund id of exactly `n` characters. */
const idOf = (n: number, tail = "") =>
  `rf_${randomBytes(n).toString("hex")}`.slice(0, n - tail.length) + tail;

type World = {
  code: Code;
  refundId: string;
  x: string;
  r2: string;
  callsBefore: number;
};

/** T paid, R Rp30.000 completed (ref X, `xLength` chars when given), R2 Rp70.000 waiting for finance. */
async function world(xLength: number | null = null): Promise<World> {
  const code = await h.newCode(BILL_IDR);
  expect((await h.paid(code, BILL_IDR)).status).toBe(200);
  const own = await h.ownCompletedRefund(code, R_IDR);
  let x = own.x;
  if (xLength !== null) {
    x = idOf(xLength);
    await h.owner.query(
      "UPDATE payment_refunds SET provider_ref = $3 WHERE tenant_id = $1 AND id = $2",
      [h.tenantId, own.refundId, x],
    );
  }
  const callsBefore = h.fake.calls.length;

  // Release 1 state: provider refunds off, no refund port; R2 waits for finance.
  flags.DOIT_REFUNDS_ENABLED = false;
  resetPaymentRefundGateways();
  const filed = await h.manualRefund(code.id, R2_IDR);
  expect(filed.status, JSON.stringify(filed.body)).toBe(201);
  const r2 = filed.body.data.id as string;
  const approved = await h.approveRefund(r2);
  expect([200, 503], JSON.stringify(approved.body)).toContain(approved.status);
  expect((await h.refundRow(r2)).status, "premise: R2 waits for finance").toBe(
    "approved",
  );
  return { code, refundId: own.refundId, x, r2, callsBefore };
}

const withAmount = (amount: unknown) =>
  amount === undefined ? {} : { amount };

/** Family A: sandbox refund object keyed refund:<R>, refund id Y of its own. */
const keyed = (w: World, y: string, amount: unknown) => () => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: {
    object: "refund",
    id: y,
    idempotency_key: `refund:${w.refundId}`,
    payment_id: w.code.providerRef,
    status: "succeeded",
    ...withAmount(amount),
  },
});

/** Family B: flat refund.succeeded naming X on T. */
const flat = (w: World, amount: unknown) => () => ({
  id: `evt_${randomBytes(8).toString("hex")}`,
  type: "refund.succeeded",
  created_at: new Date().toISOString(),
  data: {
    refund_id: w.x,
    payment_id: w.code.providerRef,
    ...withAmount(amount),
  },
});

const completedIdr = (w: World) =>
  h.count(
    `SELECT COALESCE(SUM(amount_idr), 0)::text AS n FROM payment_refunds
      WHERE tenant_id = $1 AND payment_intent_id = $2 AND status = 'completed'`,
    [h.tenantId, w.code.id],
  );

/** The report is held: no 5xx, `holds` open holds of the whole bill, replay-stable, R2 cannot be settled. */
async function expectHeld(
  w: World,
  deliveries: Array<() => object>,
  label: string,
) {
  const factsBefore = await h.providerRows(w.code.id);
  const eventsBefore = await h.refundEventsOfIntent(w.code.id);

  // The provider switch is off in this world (R2 waits for finance): since
  // 1103 each signed success keeps exactly one conflict hold per event id.
  const events = deliveries.map((makeEvent) => makeEvent());
  for (const event of events) {
    const answered = await h.deliver(event);
    expect(
      answered.status,
      `${label}: the webhook never answers 5xx: ${JSON.stringify(answered.body)}`,
    ).toBeLessThan(500);
    await h.pollLater().catch(() => null);
    await h.runWorker();
  }

  const open = await h.openOf(w.code.id);
  const holds = JSON.stringify(await h.allHolds(w.code.id));
  expect(
    open,
    `${label}: ${deliveries.length} open hold(s) persist (holds: ${holds})`,
  ).toHaveLength(deliveries.length);
  for (const row of open) {
    expect(
      row.amount_idr,
      `${label}: an unreadable amount holds the whole payment (holds: ${holds})`,
    ).toBe(BILL_IDR);
  }
  const holdsAfterFirst = (await h.allHolds(w.code.id)).length;

  // Replays: the same events (same event ids), poller, worker.
  for (const event of events) {
    for (let round = 0; round < 2; round += 1) {
      const answered = await h.deliver(event);
      expect(
        answered.status,
        `${label}: replay never answers 5xx: ${JSON.stringify(answered.body)}`,
      ).toBeLessThan(500);
      await h.pollLater().catch(() => null);
      await h.runWorker();
    }
  }
  expect(
    (await h.allHolds(w.code.id)).length,
    `${label}: replays add no hold`,
  ).toBe(holdsAfterFirst);
  expect(await h.openOf(w.code.id), `${label}: still held`).toHaveLength(
    deliveries.length,
  );

  // The same evidence under new event ids is new events: one more hold of the
  // whole bill per event, never a fact, never fewer holds.
  for (const makeEvent of deliveries) {
    const answered = await h.deliver(makeEvent());
    expect(
      answered.status,
      `${label}: new event never answers 5xx: ${JSON.stringify(answered.body)}`,
    ).toBeLessThan(500);
    await h.pollLater().catch(() => null);
    await h.runWorker();
  }
  const openAfterNew = await h.openOf(w.code.id);
  expect(
    openAfterNew,
    `${label}: one more open hold per new event (holds: ${JSON.stringify(await h.allHolds(w.code.id))})`,
  ).toHaveLength(deliveries.length * 2);
  for (const row of openAfterNew) {
    expect(row.amount_idr, `${label}: every hold keeps the whole payment`).toBe(
      BILL_IDR,
    );
  }

  // Nothing more can go out.
  const settled = await h.settleManually(w.r2, R2_IDR);
  expect(
    settled.status,
    `${label}: settle of R2 is refused while the report is held: ${JSON.stringify(settled.body)}`,
  ).toBe(409);
  expect((await h.refundRow(w.r2)).status, `${label}: R2 not settled`).toBe(
    "approved",
  );
  expect(await completedIdr(w), `${label}: completed money is only R`).toBe(
    R_IDR,
  );
  expect(
    await h.refundRow(w.refundId),
    `${label}: R is untouched`,
  ).toMatchObject({
    status: "completed",
    amount_idr: String(R_IDR),
    provider_ref: w.x,
  });
  expect(await h.providerRows(w.code.id), `${label}: no fact booked`).toEqual(
    factsBefore,
  );
  expect(
    await h.refundEventsOfIntent(w.code.id),
    `${label}: no fabricated journal event`,
  ).toBe(eventsBefore);
  expect(h.fake.calls, `${label}: the provider was not asked`).toHaveLength(
    w.callsBefore,
  );
}

const LENGTHS = [92, 93, 100] as const;
const AMOUNTS: Array<[string, unknown]> = [
  ["non-canonical '80000.0'", "80000.0"],
  ["missing", undefined],
];

describe("R1 (P1) an unreadable-amount report with a long refund id is always held", () => {
  describe("family A: keyed refund:<R>, refund id Y of n characters", () => {
    for (const n of LENGTHS) {
      it.each(AMOUNTS)(
        `1077-r1-A${n} id of ${n} chars, amount %s: no 5xx, one open hold of Rp100.000, replay-stable, settle of R2 refused`,
        async (_label, amount) => {
          const w = await world();
          await expectHeld(w, [keyed(w, idOf(n), amount)], `r1-A${n}`);
        },
      );
    }
  });

  describe("family B (SO scenario): R carries ref X of n characters, the report names X", () => {
    for (const n of LENGTHS) {
      it.each(AMOUNTS)(
        `1077-r1-B${n} X of ${n} chars, amount %s: no 5xx, one open hold of Rp100.000, replay-stable, settle of R2 refused`,
        async (_label, amount) => {
          const w = await world(n);
          await expectHeld(w, [flat(w, amount)], `r1-B${n}`);
        },
      );
    }
  });

  it("1077-r1-C two different 100-char refund ids that share a 92-char prefix stay two distinct holds (no truncation that merges evidence), each Rp100.000, replay-stable", async () => {
    const w = await world();
    const prefix = idOf(92);
    const first = `${prefix}AAAAAAAA`;
    const second = `${prefix}BBBBBBBB`;
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(100);
    await expectHeld(
      w,
      [keyed(w, first, undefined), keyed(w, second, undefined)],
      "r1-C",
    );
  });
});
