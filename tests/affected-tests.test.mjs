import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  affectedTests,
  changedFiles,
  sqlObjectNames,
} from "../scripts/affected-tests.mjs";

const root = mkdtempSync(join(tmpdir(), "affected-tests-"));
after(() => rmSync(root, { recursive: true, force: true }));
const put = (path, body = "") => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
};

put("apps/api/src/services/refund.service.ts", "export const a = 1;");
put("apps/api/src/lib/money.ts", "export const m = 1;");
put(
  "apps/api/src/test/refund.test.ts",
  'import { a } from "../services/refund.service";',
);
put("apps/api/src/test/money.test.ts", 'import { m } from "../lib/money.js";');
put("apps/api/src/test/unrelated.test.ts", 'import x from "../lib/other";');
put("apps/api/src/test/metric-single-path.test.ts", "");
put("apps/api/src/test/device-registry.test.ts", "");
put(
  "apps/api/src/test/ledger.test.ts",
  "select * from payout_hold_release_grant;",
);
put("apps/api/src/test/edited.test.ts", "");
put(
  "apps/api/drizzle/0600_x.sql",
  "-- comment fn_ignored_thing\nCREATE OR REPLACE FUNCTION public.payout_hold_release(a int) RETURNS int AS $$ SELECT 1 $$;\nALTER TABLE payout_hold_release_grant ADD COLUMN x int;",
);
put("scripts/tool.mjs", "");
put("tests/tool.test.mjs", 'import "../scripts/tool.mjs";');
put("tests/edited-root.test.mjs", "");

test("changed tests, importers and always-set are listed in api format", () => {
  const { files } = affectedTests({
    root,
    changed: [
      "apps/api/src/test/edited.test.ts",
      "tests/edited-root.test.mjs",
      "apps/api/src/services/refund.service.ts",
      "apps/api/src/lib/money.ts",
      "apps/api/src/test/gone.test.ts",
    ],
  });
  assert.deepEqual(files.slice(0, 2), [
    "src/test/edited.test.ts",
    "tests/edited-root.test.mjs",
  ]);
  assert.ok(files.includes("src/test/refund.test.ts"));
  assert.ok(files.includes("src/test/money.test.ts"));
  assert.ok(files.includes("src/test/metric-single-path.test.ts"));
  assert.ok(files.includes("src/test/device-registry.test.ts"));
  assert.ok(!files.includes("src/test/unrelated.test.ts"));
  assert.ok(!files.includes("src/test/gone.test.ts"));
});

test("migration object names pull in tests that mention them", () => {
  assert.deepEqual(sqlObjectNames(readSql()).sort(), [
    "payout_hold_release",
    "payout_hold_release_grant",
  ]);
  const { files } = affectedTests({
    root,
    changed: ["apps/api/drizzle/0600_x.sql"],
  });
  assert.ok(files.includes("src/test/ledger.test.ts"));
  assert.ok(files.includes("src/test/metric-single-path.test.ts"));
  assert.ok(!files.includes("src/test/refund.test.ts"));
});

test("root tests naming a changed script are included", () => {
  const { files } = affectedTests({ root, changed: ["scripts/tool.mjs"] });
  assert.ok(files.includes("tests/tool.test.mjs"));
});

test("--max cuts from the end and reports the total", () => {
  const { files, total } = affectedTests({
    root,
    changed: ["apps/api/src/test/edited.test.ts", "apps/api/src/lib/money.ts"],
    max: 2,
  });
  assert.equal(files.length, 2);
  assert.equal(files[0], "src/test/edited.test.ts");
  assert.ok(total > 2);
});

test("no changes still returns the always-set only", () => {
  const { files } = affectedTests({ root, changed: [] });
  assert.deepEqual(files.sort(), [
    "src/test/device-registry.test.ts",
    "src/test/metric-single-path.test.ts",
  ]);
});

put("apps/api/src/lib/deep-leaf.ts", "export const leaf = 1;");
put(
  "apps/api/src/services/deep-mid.service.ts",
  'import { leaf } from "../lib/deep-leaf";',
);
put(
  "apps/api/src/test/deep.test.ts",
  'import { x } from "../services/deep-mid.service";',
);
put(
  "apps/api/src/test/removed.test.ts",
  'import { r } from "../lib/removed-thing.js";',
);
put(
  "packages/shared/package.json",
  JSON.stringify({
    exports: {
      "./platform": "./src/platform/index.ts",
      "./permissions": "./src/permissions.ts",
    },
  }),
);
put("packages/shared/src/platform/index.ts", "");
put("packages/shared/src/platform/config.ts", "");
put("packages/shared/src/permissions.ts", "");
put(
  "apps/api/src/test/shared-platform.test.ts",
  'import { c } from "@starter/shared/platform";',
);
put(
  "apps/api/src/test/shared-permissions.test.ts",
  'import { p } from "@starter/shared/permissions";',
);
put("apps/web/src/lib/thing.ts", "export const t = 1;");
put("apps/web/test/thing.test.ts", 'import { t } from "@/lib/thing";');
put("apps/web/test/edited-web.test.ts", "");

test("imports are followed transitively up to three hops", () => {
  const { files } = affectedTests({
    root,
    changed: ["apps/api/src/lib/deep-leaf.ts"],
  });
  assert.ok(files.includes("src/test/deep.test.ts"));
  assert.ok(!files.includes("src/test/refund.test.ts"));
});

test("a deleted source file still selects the tests that import it", () => {
  const { files } = affectedTests({
    root,
    changed: ["apps/api/src/lib/removed-thing.ts"],
  });
  assert.ok(files.includes("src/test/removed.test.ts"));
});

test("a changed shared source selects tests importing its subpath only", () => {
  const { files } = affectedTests({
    root,
    changed: ["packages/shared/src/platform/config.ts"],
  });
  assert.ok(files.includes("src/test/shared-platform.test.ts"));
  assert.ok(!files.includes("src/test/shared-permissions.test.ts"));
  const exact = affectedTests({
    root,
    changed: ["packages/shared/src/permissions.ts"],
  }).files;
  assert.ok(exact.includes("src/test/shared-permissions.test.ts"));
  assert.ok(!exact.includes("src/test/shared-platform.test.ts"));
});

test("web tests are walked: changed tests and importers of changed web sources", () => {
  const { files } = affectedTests({
    root,
    changed: ["apps/web/test/edited-web.test.ts", "apps/web/src/lib/thing.ts"],
  });
  assert.equal(files[0], "apps/web/test/edited-web.test.ts");
  assert.ok(files.includes("apps/web/test/thing.test.ts"));
});

test("changedFiles diffs against the merge base and keeps deleted and renamed-away paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "affected-git-"));
  try {
    const g = (...a) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        cwd: dir,
        encoding: "utf8",
      });
    const write = (path, body) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    };
    write(
      "a.ts",
      "export const a = 1; // some content to match renames\n".repeat(5),
    );
    write("gone.ts", "export const gone = 1;\n".repeat(5));
    write("base-only.ts", "x");
    g("init", "-q", "-b", "base");
    g("add", "-A");
    g("commit", "-q", "-m", "base");
    g("checkout", "-q", "-b", "work");
    g("mv", "a.ts", "b.ts");
    g("rm", "-q", "gone.ts");
    g("commit", "-q", "-m", "work");
    // base moves on after the branch point: not part of this branch's diff
    g("checkout", "-q", "base");
    write("base-only.ts", "changed on base");
    g("commit", "-qam", "base moves");
    g("checkout", "-q", "work");
    write("loose.ts", "untracked");
    const files = changedFiles(dir, "base");
    for (const expected of ["a.ts", "b.ts", "gone.ts", "loose.ts"])
      assert.ok(files.includes(expected), expected);
    assert.ok(!files.includes("base-only.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readSql() {
  return `-- comment fn_ignored_thing
CREATE OR REPLACE FUNCTION public.payout_hold_release(a int) RETURNS int AS $$ SELECT 1 $$;
ALTER TABLE payout_hold_release_grant ADD COLUMN x int;`;
}
