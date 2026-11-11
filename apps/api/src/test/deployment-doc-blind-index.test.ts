// legend-488 items 6 and 11, documentation check: docs/deployment.md must
// describe the manual v2 switch (default is 1) and say that the build after
// the rollback reads both idempotency fingerprint versions.
//
// Assumptions: the "Versi blind index" section of docs/deployment.md is the
// place; wording is checked loosely (key terms, not exact sentences).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const doc = readFileSync(
  new URL("../../../../docs/deployment.md", import.meta.url),
  "utf8",
);
const start = doc.indexOf("### Versi blind index");
const section = doc.slice(
  start,
  doc.indexOf("\n### ", start + 5) + 1 || undefined,
);
const paragraphs = section.split(/\n\s*\n/);

describe("docs/deployment.md blind-index section (legend-488 #6, #11)", () => {
  it("has the section", () => {
    expect(start).toBeGreaterThan(-1);
  });

  it("states the default is version 1, not 2", () => {
    expect(section).not.toMatch(/BLIND_INDEX_ACTIVE_VERSION[^.]*default 2\b/);
    expect(section).toMatch(/BLIND_INDEX_ACTIVE_VERSION[^.]*default 1\b/);
  });

  it("tells the operator to switch BLIND_INDEX_ACTIVE_VERSION=2 by hand after all pods run the new build", () => {
    const step = paragraphs.find(
      (paragraph) =>
        paragraph.includes("BLIND_INDEX_ACTIVE_VERSION=2") &&
        /semua pod|seluruh pod|all pods/i.test(paragraph),
    );
    expect(step).toBeDefined();
  });

  it("orders the rollout: set =2 comes before queueing the rebuild job for version 2", () => {
    const setAt = section.search(/BLIND_INDEX_ACTIVE_VERSION=2/);
    const jobAt = section.search(/\{"targetVersion": 2\}/);
    expect(setAt).toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(jobAt);
  });

  it("the rollback paragraphs mention that the build reads both fingerprint versions", () => {
    const rollback = paragraphs.filter((paragraph) =>
      /^Rollback/.test(paragraph.trim()),
    );
    expect(rollback.length).toBeGreaterThanOrEqual(2);
    // Both the config rollback and the code rollback paragraph.
    for (const paragraph of rollback) expect(paragraph).toMatch(/kedua versi/);
    for (const paragraph of rollback)
      expect(paragraph).toMatch(/fingerprint idempotency/);
  });
});
