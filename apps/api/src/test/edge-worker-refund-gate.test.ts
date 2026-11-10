import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// legend-jm5c: worker-main.ts has top-level side effects, so it is read as
// source (same approach as pos-receipt-email-worker.test.ts).
const source = readFileSync(
  new URL("../worker-main.ts", import.meta.url),
  "utf8",
);

describe("legend-jm5c the refund sweep is cloud only", () => {
  it("derives the flag from the edge runtime config and fails closed", () => {
    expect(source).toMatch(
      /const sweepsRefunds = edgeRuntime\.ok && !edgeRuntime\.config\.edgeMode;/,
    );
  });

  it("only schedules the payout and escalation sweep when the flag is on", () => {
    expect(source).toMatch(
      /if \(sweepsRefunds\) \{\s*scheduleRefundPayoutRound\(\);\s*\}/,
    );
    expect(source).toMatch(
      /if \(sweepsRefunds\) \{\s*try \{\s*await retryPendingRefunds\(/,
    );
    // Definition plus the one gated start call: no other start site.
    expect(source.match(/scheduleRefundPayoutRound\(\)/g)).toHaveLength(2);
  });

  it("legend-iu91r files the ORD-09 recovery refund on the cloud only", () => {
    expect(source).toMatch(
      /if \(sweepsRefunds\)\s*await deliverOrderRecoveryRefundEvent\(context, event, tx\);/,
    );
    // The one gated call is the only call site.
    expect(
      source.match(/await deliverOrderRecoveryRefundEvent\(/g),
    ).toHaveLength(1);
  });
});
