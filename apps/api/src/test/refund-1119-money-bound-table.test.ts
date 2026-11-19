// (brief 1119, SO refund ronde 12 = docs/qa/second-opinion-refund-ronde12-1117.md, both P1;
// "Bukti": test tabel/properti, tier K "jangan sampai rugi"): table test written from that
// report, docs/briefs/1119-fix-refund-ronde12.md (CTO decisions) and docs/briefs/1072-invarian.md,
// not from the implementation.
//
// Property: for every combination of (hold amount, fact amount, which door opened the hold,
// switch on/off) and whatever finance and the closers do with the hold, the money that can
// leave the till stays within what was paid. Out = what the provider reported or booked
// (max(hold, fact): the report may be real) + every manual refund that was let through.
// Out <= Rp100.000.
//
// Table (each row is one test):
//   door "mismatch": T2 has fact X/T2 of `fact`; a signed success keyed R of T1 names X/T2
//     with `hold` and opens a REFERENCE_MISMATCH hold; finance then tries
//     `counted_against_intent` (200 only when fact >= hold, else 409; both answers are accepted
//     here, the single-case answer is pinned in the p1-1 file).
//   door "liveown": our refund R is in flight, a report X/T of `hold` is held live-own, R is
//     declined (its failure hold closed `not_this_intent`), then the recorder gets a NEW report
//     X/T of `fact` (the automatic closer runs) before the worker retries the larger event.
// Then two manual refunds are tried: Rp100.000 - fact (the amount the limit allows if the hold
// is wrongly gone) and one Rp above the strict allowance (Rp100.000 - max(hold, fact) + 1).
// Each is "let through" when it completes or is settled by hand (switch off: settle by hand).
//
// Assumptions (the brief does not fix them):
//   - "total keluar (fact + refund manual + hold terbuka)" is read as the worst case where the
//     provider report is real: the open hold does not add on top of the fact it names, so the
//     bigger of the two counts. That is the SO arithmetic (Rp80.000 + Rp70.000 = Rp150.000).
//     A stricter reading (sum of fact and hold) would refuse more, never less.
//   - The probes are the dangerous amounts only; no row demands that a smaller refund is
//     accepted. The covering rows (fact >= hold) are green controls at head.
//   - In the "mismatch" door the finance answer is not pinned here (p1-1 does it), so this table
//     fails only when money can leave above the paid amount.
//   - Both switch states are used: on (provider refunds active, approve completes the manual
//     refund) and off (release 1: approve waits for finance, settle by hand is the door).
//
// Run just this file:
//   LEGEND_TEST_FILES="src/test/refund-1119-money-bound-table.test.ts" heavy pnpm test

import { describe, expect, it } from "vitest";
import { BILL_IDR, createRefundHarness } from "./refund-1072-harness";
import {
  countMismatch,
  expectWorstCaseWithinPaid,
  flags,
  installSwitchHooks,
  liveOwnWorld,
  mismatchWorld,
  recorderReport,
  tryManualOut,
  type Probe,
} from "./refund-1119-support";

const h = createRefundHarness("1119tbl");
installSwitchHooks(h, true);

type Row = {
  door: "mismatch" | "liveown";
  switchOn: boolean;
  hold: number;
  fact: number;
};

const amounts: Array<[number, number]> = [
  [80_000, 30_000], // SO: the report is larger than the fact
  [80_000, 80_000], // control: the fact covers the hold
  [50_000, 30_000], // another short pair
];
const rows: Row[] = [];
for (const door of ["mismatch", "liveown"] as const)
  for (const switchOn of [false, true])
    for (const [hold, fact] of amounts)
      rows.push({ door, switchOn, hold, fact });

async function probeBoth(intentId: string, hold: number, fact: number) {
  const probes: Probe[] = [];
  const first = BILL_IDR - fact;
  const second = BILL_IDR - Math.max(hold, fact) + 1;
  probes.push(await tryManualOut(h, intentId, first));
  if (second > 0 && second !== first)
    probes.push(await tryManualOut(h, intentId, second));
  return probes;
}

describe("money bound table: fact + manual refunds + open hold never exceed what was paid", () => {
  it.each(rows)(
    "1119-bound $door switch=$switchOn hold=$hold fact=$fact: worst case out <= Rp100.000",
    async ({ door, switchOn, hold, fact }) => {
      let intentId: string;
      if (door === "mismatch") {
        const w = await mismatchWorld(h, { hold, fact, switchOn });
        intentId = w.t2.id;
        const counted = await countMismatch(h, w);
        expect(
          [200, 409],
          `finance's counted answers 200 or 409: ${JSON.stringify(counted.body)}`,
        ).toContain(counted.status);
      } else {
        const w = await liveOwnWorld(h, { hold });
        intentId = w.code.id;
        flags.DOIT_REFUNDS_ENABLED = switchOn;
        const answered = await h.deliver(recorderReport(h, w.code, w.x, fact));
        expect(
          answered.status,
          `webhook never answers 5xx: ${JSON.stringify(answered.body)}`,
        ).toBeLessThan(500);
      }
      const probes = await probeBoth(intentId, hold, fact);
      expectWorstCaseWithinPaid(
        hold,
        fact,
        probes,
        `${door}/switch ${switchOn ? "on" : "off"}/hold ${hold}/fact ${fact}`,
      );
    },
  );
});
