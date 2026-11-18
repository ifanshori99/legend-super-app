// Run the mock-mode Playwright suite, optionally filtering its spec files.
//
//   pnpm run test:e2e:mock -- e2e/mock-mode.mock.spec.ts
//   pnpm test:e2e:mock e2e/mock-mode.mock.spec.ts --list
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { root } from "./lib.mjs";

const args = process.argv.slice(2);
// pnpm preserves this separator, but Playwright treats arguments after it as
// test arguments instead of file filters. Consume only the wrapper separator.
if (args[0] === "--") args.shift();

const cli = resolve(root, "node_modules/@playwright/test/cli.js");
const result = spawnSync(
  process.execPath,
  [cli, "test", "--config=playwright.mock.config.ts", ...args],
  { cwd: root, env: process.env, stdio: "inherit" },
);
if (result.error) {
  console.error(`Could not start Playwright: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
