import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Include untracked files so a misplaced test is caught before it is committed.
// Git ignores generated directories, dependencies, and other worktrees.
test("every test file is collected by a runner", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .filter((file) => existsSync(resolve(root, file)))
    .filter((file) => /\.test\.(mjs|ts|tsx)$/.test(file));

  const orphaned = files.filter(
    (file) =>
      !/^tests\/[^/]+\.test\.mjs$/.test(file) &&
      !/^apps\/api\/src\/.+\.test\.ts$/.test(file) &&
      !/^scripts\/ci\/[^/]+\.test\.mjs$/.test(file) &&
      // scripts/test.mjs runs these with the web vitest config.
      !/^apps\/web\/test\/.+\.test\.ts$/.test(file) &&
      !(
        /^e2e\/.+\.test\.(mjs|ts|tsx)$/.test(file) &&
        !/node:test/.test(readFileSync(resolve(root, file), "utf8"))
      ),
  );
  assert.deepEqual(
    orphaned,
    [],
    `Test di luar jangkauan runner:\n${orphaned.join("\n")}\nPindahkan ke tests/*.test.mjs, apps/api/src/**/*.test.ts, scripts/ci/*.test.mjs, apps/web/test/**/*.test.ts, atau e2e/**/*.test.{mjs,ts,tsx} untuk Playwright sesuai runner.`,
  );
});
