import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// legend-rs2xy (brief 855): the worker jobs that post tenant-wide accounting
// events (fixed-asset depreciation, recurring journals incl. their approval)
// must run on the cloud worker only. An edge worker cannot produce
// tenant-wide cloud-sync events (appendOutbox refuses them, guard legend-7h5s),
// so the fix is to not run these jobs on the edge at all.
//
// worker-main.ts has top-level side effects, so it is read as source (same
// approach as edge-worker-refund-gate.test.ts). Comments are stripped first so
// a comment that mentions a call cannot satisfy or break the checks.
//
// Assumption: "inside the gate" means the call sits in a block whose header is
// exactly `if (sweepsCloudOwnedData)`, at any nesting depth (one shared block
// for both jobs is fine). The test asserts structure, not formatting.

const raw = readFileSync(new URL("../worker-main.ts", import.meta.url), "utf8");

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

const source = stripComments(raw);

/** Headers (text between the previous `;`/`{`/`}` and the `{`) of every block enclosing `index`. */
function enclosingHeaders(text: string, index: number): string[] {
  const headers: string[] = [];
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        let j = i - 1;
        while (j >= 0 && !";{}".includes(text[j] as string)) j--;
        headers.push(text.slice(j + 1, i).trim());
      } else depth--;
    }
  }
  return headers;
}

function callSites(call: string): number[] {
  const sites: number[] = [];
  const re = new RegExp(`await ${call}\\(`, "g");
  for (let m = re.exec(source); m; m = re.exec(source)) sites.push(m.index);
  return sites;
}

const GATE = /^if\s*\(\s*sweepsCloudOwnedData\s*\)$/;

describe("legend-rs2xy tenant-wide accounting jobs are cloud only", () => {
  it("keeps the cloud-only flag fail closed (edge runtime config)", () => {
    expect(source).toMatch(
      /const sweepsCloudOwnedData = edgeRuntime\.ok && !edgeRuntime\.config\.edgeMode;/,
    );
  });

  it.each([
    ["runDueDepreciation", "fixed-asset depreciation"],
    ["runDueRecurringJournals", "recurring journals"],
  ])("runs %s (%s) only inside `if (sweepsCloudOwnedData)`", (call) => {
    const sites = callSites(call);
    // Exactly one call site: no ungated second path to the same job.
    expect(sites).toHaveLength(1);
    const headers = enclosingHeaders(source, sites[0] as number);
    expect(headers.some((h) => GATE.test(h))).toBe(true);
  });
});
