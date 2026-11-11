// legend-488 item 6 (Codex finding env.ts:118): the default blind-index version
// must be 1. A rolling deploy otherwise lets new pods write v2 digests that old
// pods cannot read. v2 is switched on by hand (docs/deployment.md, see
// deployment-doc-blind-index.test.ts) once every pod runs the new build.
//
// Assumptions: the active version is exported as BLIND_INDEX_ACTIVE_VERSION
// from lib/blind-index.ts (existing tests import it) and read from the
// BLIND_INDEX_ACTIVE_VERSION env var, accepting "1" or "2" only. Each case
// runs in a fresh process because the value is read when the module loads.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../lib/blind-index.ts", import.meta.url).href;

function activeVersion(value: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BLIND_INDEX_ACTIVE_VERSION;
  if (value !== undefined) env.BLIND_INDEX_ACTIVE_VERSION = value;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(moduleUrl)}).then((m) => console.log("ACTIVE=" + m.BLIND_INDEX_ACTIVE_VERSION))`,
    ],
    {
      cwd: new URL("../..", import.meta.url),
      env,
      encoding: "utf8",
    },
  );
  const match = /ACTIVE=(\S+)/.exec(result.stdout);
  return { status: result.status, active: match?.[1], stderr: result.stderr };
}

describe("BLIND_INDEX_ACTIVE_VERSION default (legend-488 #6)", () => {
  it("defaults to 1 when the variable is not set", () => {
    const result = activeVersion(undefined);
    expect(result.status, result.stderr).toBe(0);
    expect(result.active).toBe("1");
  });

  it("v2 is only active when set explicitly", () => {
    const result = activeVersion("2");
    expect(result.status, result.stderr).toBe(0);
    expect(result.active).toBe("2");
  });

  it("an explicit 1 stays 1", () => {
    const result = activeVersion("1");
    expect(result.status, result.stderr).toBe(0);
    expect(result.active).toBe("1");
  });

  it("refuses a version other than 1 or 2", () => {
    const result = activeVersion("3");
    expect(result.active).toBeUndefined();
  });
});
