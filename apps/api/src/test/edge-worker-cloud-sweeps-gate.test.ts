import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// legend-647: worker-main.ts has top-level side effects, so it is read as
// source (same approach as edge-worker-refund-gate.test.ts).
const source = readFileSync(
  new URL("../worker-main.ts", import.meta.url),
  "utf8",
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const cloudOwnedSweeps = [
  "expireDueApprovalRequests",
  "runScheduledLeaveJobs",
  "runScheduledExitClearance",
  "expireDueSupportAccessGrants",
  "redriveEdgeOrderRefusalsForTenant",
] as const;

// legend-rs2xy (855) added two more gated blocks (fixed-asset depreciation and
// recurring journals); edge-worker-cloud-only-gate-855.test.ts pins those two.
const accountingGates = 2;

describe("legend-647 cloud-owned data sweeps never run on the edge", () => {
  it("derives the flag from the edge runtime config and fails closed", () => {
    expect(source).toMatch(
      /const sweepsCloudOwnedData = edgeRuntime\.ok && !edgeRuntime\.config\.edgeMode;/,
    );
  });

  for (const sweep of cloudOwnedSweeps) {
    it(`calls ${sweep} exactly once, only inside the gate`, () => {
      // Exactly one call site in the whole file.
      expect(
        source.match(new RegExp(`${escapeRegExp(sweep)}\\(`, "g")),
      ).toHaveLength(1);
      // That one call is the first statement inside its own
      // `if (sweepsCloudOwnedData) { try {` block.
      expect(source).toMatch(
        new RegExp(
          `if \\(sweepsCloudOwnedData\\) \\{\\s*try \\{\\s*await ${escapeRegExp(sweep)}\\(`,
        ),
      );
    });
  }

  it("has one gate per cloud-owned sweep and no stray gate", () => {
    expect(
      source.match(/if \(sweepsCloudOwnedData\) \{\s*try \{/g),
    ).toHaveLength(cloudOwnedSweeps.length + accountingGates);
  });

  it("does not gate releaseExpiredSlotHolds (facility is served on the edge)", () => {
    expect(source.match(/releaseExpiredSlotHolds\(/g)).not.toBeNull();
    // The gate must not open directly around the slot-hold release.
    expect(source).not.toMatch(
      /if \(sweepsCloudOwnedData\) \{\s*try \{\s*(?:await )?[^;]*releaseExpiredSlotHolds\(/,
    );
    // And no gate on any flag wraps the call directly.
    expect(source).not.toMatch(
      /if \(!?sweeps\w+\) \{\s*try \{\s*(?:await )?(?:[\w.]+ = )?(?:await )?releaseExpiredSlotHolds\(/,
    );
  });
});
