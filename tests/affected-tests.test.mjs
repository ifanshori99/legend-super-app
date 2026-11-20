import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { affectedTests, sqlObjectNames } from "../scripts/affected-tests.mjs";

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

function readSql() {
  return `-- comment fn_ignored_thing
CREATE OR REPLACE FUNCTION public.payout_hold_release(a int) RETURNS int AS $$ SELECT 1 $$;
ALTER TABLE payout_hold_release_grant ADD COLUMN x int;`;
}
