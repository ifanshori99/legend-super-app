import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  findMissingTestFiles,
  normalizeTestFile,
  normalizeTestFiles,
} from "../scripts/lib-test-files.mjs";

test("apps/api paths become package-relative and ./ is dropped", () => {
  assert.deepEqual(
    normalizeTestFiles([
      "apps/api/src/test/a.test.ts",
      "./src/test/b.test.ts",
      "./tests/c.test.mjs",
      "./apps/api/src/test/d.test.ts",
      "src/test/e.test.ts",
      "apps/web/test/f.test.ts",
    ]),
    [
      "src/test/a.test.ts",
      "src/test/b.test.ts",
      "tests/c.test.mjs",
      "src/test/d.test.ts",
      "src/test/e.test.ts",
      "apps/web/test/f.test.ts",
    ],
  );
  assert.equal(normalizeTestFile("--bail"), "--bail");
});

test("missing files are reported per kind of test", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-files-"));
  try {
    for (const file of [
      "apps/api/src/test/ok.test.ts",
      "tests/ok.test.mjs",
      "apps/web/test/ok.test.ts",
    ]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), "");
    }
    assert.deepEqual(
      findMissingTestFiles(
        [
          "src/test/ok.test.ts",
          "tests/ok.test.mjs",
          "apps/web/test/ok.test.ts",
        ],
        dir,
      ),
      [],
    );
    assert.deepEqual(
      findMissingTestFiles(
        ["src/test/nope.test.ts", "tests/nope.test.mjs", "src/test/ok.test.ts"],
        dir,
      ),
      ["src/test/nope.test.ts", "tests/nope.test.mjs"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("test.mjs exits 2 with the wrong paths before touching the database", () => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "..", "scripts", "test.mjs"), "unit"],
    {
      env: {
        ...process.env,
        LEGEND_TEST_FILES: "apps/api/src/test/does-not-exist.test.ts",
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /src\/test\/does-not-exist\.test\.ts/);
  assert.doesNotMatch(result.stdout, /Starting an isolated PostgreSQL/);
});

test("flag values and non-test tokens are not paths; missing test paths still are", () => {
  const dir = mkdtempSync(join(tmpdir(), "test-files-"));
  try {
    assert.deepEqual(
      findMissingTestFiles(["-t", "payout", "--bail", "extra-token"], dir),
      [],
    );
    assert.deepEqual(
      findMissingTestFiles(
        ["-t", "payout", "src/test/nope.test.ts", "-t", "x.test.ts"],
        dir,
      ),
      ["src/test/nope.test.ts", "x.test.ts"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
