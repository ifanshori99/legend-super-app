// WFC minimum spend reminder sweep wiring (bead legend-e24cz; PRD §3 F39).
// The rules are covered in wfc-min-spend-reminder.test.ts; this file checks
// that worker-main.ts runs the job in the per-tenant relay tick, fail closed
// like the other sweeps, and that the job is throttled and isolates outlets.
//
// Run just this file (from the repo root):
//   LEGEND_TEST_FILES="src/test/wfc-min-spend-worker.test.ts" pnpm test

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WFC_MIN_SPEND_JOB_INTERVAL_MS } from "../worker/wfc-min-spend.job.ts";

describe("WFC minimum spend sweep", () => {
  const source = readFileSync(
    new URL("../worker-main.ts", import.meta.url),
    "utf8",
  );
  const job = readFileSync(
    new URL("../worker/wfc-min-spend.job.ts", import.meta.url),
    "utf8",
  );

  it("worker-main.ts imports the job", () => {
    expect(source).toMatch(
      /import \{ runWfcMinSpendJob \} from "\.\/worker\/wfc-min-spend\.job\.ts"/,
    );
  });

  it("worker-main.ts runs it per tenant inside the relay tick, fail closed", () => {
    expect(source).toMatch(
      /try \{\s*await runWfcMinSpendJob\(context\);\s*\} catch \{\s*console\.error\("WFC minimum spend sweep failed"\);\s*\}/,
    );
  });

  it("throttles per tenant and keeps one failing outlet from stopping the rest", () => {
    expect(WFC_MIN_SPEND_JOB_INTERVAL_MS).toBe(5 * 60_000);
    expect(job).toMatch(/lastRunByTenant/);
    expect(job).toMatch(
      /try \{[\s\S]*evaluateMinSpend[\s\S]*\} catch \{\s*result\.failedOutlets \+= 1;/,
    );
  });
});
