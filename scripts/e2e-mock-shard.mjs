// Run one shard of the mock-mode Playwright suite (bead legend-x5be).
//
//   pnpm test:e2e:mock:shard 1/4
//   LEGEND_MOCK_PORT=3239 pnpm test:e2e:mock:shard 1/4
//
// `pnpm test:e2e:mock` stays single-worker on purpose: a 16 GB machine shared
// by several agents cannot run two Playwright workers at once. This wrapper is
// the opt-in way to split a long run; each shard still uses one worker, so
// `1/4` + `2/4` in parallel is two workers, not eight.
//
// Playwright partitions the test list itself (`--shard=<index>/<total>`), so a
// shard runs whole spec files' worth of tests and every shard's globalSetup
// still warms the dev server. Shards on one machine need distinct
// LEGEND_MOCK_PORT values; without one they would race for port 3225.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { root } from "./lib.mjs";

const USAGE =
  "Usage: pnpm test:e2e:mock:shard <index>/<total> [playwright args]";
const [shard, ...extraArgs] = process.argv.slice(2);
const match = /^(\d+)\/(\d+)$/.exec(shard ?? "");
if (!match) {
  console.error(`A shard looks like 1/4, not "${shard ?? ""}".\n${USAGE}`);
  process.exit(2);
}
const index = Number(match[1]);
const total = Number(match[2]);
if (index < 1 || total < 1 || index > total) {
  console.error(
    `Shard ${shard} is out of range: the index must be between 1 and ${total}.\n${USAGE}`,
  );
  process.exit(2);
}

const cli = resolve(root, "node_modules/@playwright/test/cli.js");
const result = spawnSync(
  process.execPath,
  [
    cli,
    "test",
    "--config=playwright.mock.config.ts",
    `--shard=${index}/${total}`,
    ...extraArgs,
  ],
  { cwd: root, env: process.env, stdio: "inherit" },
);
if (result.error) {
  console.error(`Could not start Playwright: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
