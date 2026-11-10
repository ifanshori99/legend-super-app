// Prepares a git worktree so it builds and tests against its own packages.
//
//   node scripts/worktree-setup.mjs   (or `pnpm worktree:setup` once installed)
//
// 1. Removes node_modules symlinks that point at another checkout.
// 2. Runs `pnpm install --offline --frozen-lockfile` (falls back to
//    --prefer-offline when the local pnpm store is missing a package).
// 3. Copies .claude/settings.local.json from the main checkout when present.
// 4. Runs scripts/check-workspace-links.mjs to prove the links are local.
//
// Uses only node: built-ins so it runs before an install.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const shell = process.platform === "win32";
const pnpm = shell ? "pnpm.cmd" : "pnpm";

function run(command, args) {
  return spawnSync(command, args, { cwd: root, stdio: "inherit", shell })
    .status;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

// 1. Symlinked node_modules share the main checkout's virtual store.
for (const path of [
  "node_modules",
  "apps/web/node_modules",
  "apps/api/node_modules",
  "packages/shared/node_modules",
]) {
  const full = resolve(root, path);
  if (lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) {
    console.log(`Removing symlink ${path} -> ${readlinkSync(full)}`);
    unlinkSync(full);
  }
}

// 2. Install from the local pnpm store; no network unless it must.
if (run(pnpm, ["install", "--offline", "--frozen-lockfile"]) !== 0) {
  console.log("Offline install failed; retrying with --prefer-offline.");
  if (run(pnpm, ["install", "--prefer-offline", "--frozen-lockfile"]) !== 0)
    process.exit(1);
}

// 3. Local Claude settings are gitignored, so a new worktree lacks them.
const commonDir = git([
  "rev-parse",
  "--path-format=absolute",
  "--git-common-dir",
]);
const mainCheckout = commonDir ? dirname(commonDir) : "";
const settings = ".claude/settings.local.json";
if (mainCheckout && realpathSync(mainCheckout) !== root) {
  const source = resolve(mainCheckout, settings);
  const target = resolve(root, settings);
  if (existsSync(source) && !existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    console.log(`Copied ${settings} from the main checkout.`);
  }
}

// 4. Prove every workspace link stays inside this checkout.
process.exit(
  run(process.execPath, [resolve(root, "scripts/check-workspace-links.mjs")]) ??
    1,
);
