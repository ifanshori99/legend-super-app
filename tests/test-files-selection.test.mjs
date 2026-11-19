import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { root } from "../scripts/lib.mjs";

// legend-lw7gv: LEGEND_TEST_FILES set but empty must fail loudly instead of
// silently running the full suite. A stub `docker` that always fails sits first
// on PATH, so no case here can start a real database or the full suite.
const stubDir = mkdtempSync(join(tmpdir(), "legend-test-files-"));
writeFileSync(join(stubDir, "docker"), "#!/bin/sh\nexit 1\n");
chmodSync(join(stubDir, "docker"), 0o755);
test.after(() => rmSync(stubDir, { recursive: true, force: true }));

function runTestScript(files) {
  const env = { ...process.env, PATH: `${stubDir}:${process.env.PATH}` };
  delete env.LEGEND_TEST_FILES;
  if (files !== undefined) env.LEGEND_TEST_FILES = files;
  return spawnSync(process.execPath, ["scripts/test.mjs", "unit"], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

for (const [label, value] of [
  ["empty", ""],
  ["spaces only", "   "],
  ["tabs and newlines", " \t\n "],
]) {
  test(`LEGEND_TEST_FILES ${label} exits non-zero with a clear message`, () => {
    const result = runTestScript(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LEGEND_TEST_FILES is set but empty/);
    assert.doesNotMatch(result.stdout, /Starting an isolated PostgreSQL/);
  });
}

test("LEGEND_TEST_FILES unset still starts the full suite", () => {
  const result = runTestScript(undefined);
  assert.doesNotMatch(result.stderr, /LEGEND_TEST_FILES is set but empty/);
  assert.match(result.stdout, /Starting an isolated PostgreSQL/);
});

test("LEGEND_TEST_FILES with files does not trip the empty check", () => {
  const result = runTestScript("tests/test-sweep.test.mjs");
  assert.doesNotMatch(result.stderr, /LEGEND_TEST_FILES is set but empty/);
  assert.match(result.stdout, /Starting an isolated PostgreSQL/);
});
