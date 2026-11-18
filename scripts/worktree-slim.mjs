// Makes a git worktree slim with a non-cone `git sparse-checkout`, so it skips
// old drizzle snapshots and png/jpg screenshots (~180 MB instead of ~1.15 GB).
//
//   node scripts/worktree-slim.mjs             enable slim (safe to re-run after a rebase)
//   node scripts/worktree-slim.mjs --full      disable sparse-checkout (needed to create migrations)
//   node scripts/worktree-slim.mjs --status    show slim/full and folder sizes
//   node scripts/worktree-slim.mjs --dry-run   print the pattern list, change nothing
//
// Kept snapshots: the newest 5, 0000, every NNNN_snapshot named in
// apps/api/src/test/** plus its predecessor. _journal.json and *.sql are never
// excluded. The main checkout is refused: sparse config is per worktree
// (extensions.worktreeConfig), and the main folder must stay full.
//
// Uses only node: built-ins so it runs before an install.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Git must act on the repo found below, never on one named by GIT_* env vars
// (for example when the script runs from a git hook).
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function gitToplevel(dir) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dir,
    encoding: "utf8",
    env: cleanEnv,
  });
  return result.status === 0
    ? realpathSync(result.stdout.replace(/\r?\n$/, ""))
    : null;
}

// Repo root: the checkout this file belongs to (scripts/worktree-slim.mjs).
// A copy outside a checkout (for example ~/.claude/scripts) uses the
// toplevel of the current directory instead.
const scriptPath = realpathSync(fileURLToPath(import.meta.url));
const ownTop = gitToplevel(dirname(scriptPath));
const root =
  ownTop && scriptPath === join(ownTop, "scripts", "worktree-slim.mjs")
    ? ownTop
    : gitToplevel(process.cwd());
if (!root) {
  console.error(
    "Bukan di dalam repo git. Jalankan dari root worktree: node <skrip> [opsi]",
  );
  process.exit(1);
}

const metaDir = "apps/api/drizzle/meta";
const testDir = "apps/api/src/test";
// Only images are left out: the .md specs and .html mockups in these folders
// are still referenced by path from DESIGN.md and docs.
const imageDirs = ["docs/design", "docs/screenshots", "design"];
const imageExts = ["png", "jpg", "jpeg"];
const imagePatterns = imageDirs.flatMap((dir) =>
  imageExts.map((ext) => `!/${dir}/**/*.${ext}`),
);
const args = new Set(process.argv.slice(2));
const known = new Set(["--full", "--status", "--dry-run"]);

function git(gitArgs, options = {}) {
  return spawnSync("git", gitArgs, {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv,
    ...options,
  });
}

function gitOut(gitArgs) {
  const result = git(gitArgs);
  if (result.status !== 0) {
    console.error(`git ${gitArgs.join(" ")} gagal: ${result.stderr.trim()}`);
    process.exit(1);
  }
  // trimEnd only: porcelain lines start with a meaningful space (" M path").
  return result.stdout.trimEnd();
}

function sizeKb(path) {
  const result = spawnSync("du", ["-sk", path], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 ? Number.parseInt(result.stdout, 10) : 0;
}

function formatKb(kb) {
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}

function sizeSummary() {
  return [metaDir, "docs/design", "design"]
    .map((path) => `${path}: ${formatKb(sizeKb(path))}`)
    .join("\n");
}

function isSlim() {
  const result = git(["config", "--get", "core.sparseCheckout"]);
  return result.stdout.trim() === "true";
}

function numbersReferencedByTests() {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const text = readFileSync(full, "utf8");
        for (const match of text.matchAll(/(\d{4})_snapshot/g))
          found.add(Number.parseInt(match[1], 10));
      }
    }
  };
  walk(resolve(root, testDir));
  return found;
}

function buildPatterns() {
  const tracked = gitOut(["ls-files", metaDir])
    .split("\n")
    .map((file) => file.match(/\/(\d{4})_snapshot\.json$/)?.[1])
    .filter(Boolean);
  const numbers = [...new Set(tracked)].sort();
  const keep = new Set(["0000", ...numbers.slice(-5)]);
  for (const n of numbersReferencedByTests()) {
    const num = String(n).padStart(4, "0");
    keep.add(num);
    // Tests pick the nearest lower snapshot that exists (numbers have gaps).
    const lower = numbers.filter((m) => m < num).pop();
    if (lower) keep.add(lower);
  }
  const excluded = numbers.filter((n) => !keep.has(n));
  const patterns = [
    "/*",
    ...excluded.map((n) => `!/${metaDir}/${n}_snapshot.json`),
    ...imagePatterns,
  ];
  return { patterns, excluded, kept: numbers.length - excluded.length };
}

function isExcludedPath(path, excluded) {
  return (
    (imageDirs.some((dir) => path.startsWith(`${dir}/`)) &&
      imageExts.some((ext) => path.toLowerCase().endsWith(`.${ext}`))) ||
    excluded.some((n) => path === `${metaDir}/${n}_snapshot.json`)
  );
}

function dirtyExcludedPaths(excluded) {
  const lines = gitOut(["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean);
  return lines
    .map((line) => line.slice(3).replace(/^"|"$/g, ""))
    .map((path) => path.split(" -> ").pop())
    .filter((path) => isExcludedPath(path, excluded));
}

for (const arg of args) {
  if (!known.has(arg)) {
    console.error(`Opsi tidak dikenal: ${arg}`);
    console.error("Pakai: [--full | --status | --dry-run]");
    process.exit(1);
  }
}

const gitDir = resolve(root, gitOut(["rev-parse", "--git-dir"]));
const commonDir = resolve(root, gitOut(["rev-parse", "--git-common-dir"]));
if (gitDir === commonDir) {
  console.error(
    "Ini checkout utama, bukan worktree. Slim hanya untuk worktree; dibatalkan.",
  );
  process.exit(1);
}

if (args.has("--status")) {
  console.log(`Mode: ${isSlim() ? "slim" : "full"}`);
  console.log(sizeSummary());
  process.exit(0);
}

if (args.has("--full")) {
  if (args.has("--dry-run")) {
    console.log("[dry-run] git sparse-checkout disable");
    process.exit(0);
  }
  const result = git(["sparse-checkout", "disable"], { stdio: "inherit" });
  if (result.status !== 0) process.exit(1);
  console.log("Mode full aktif. Semua berkas sudah kembali.");
  console.log(sizeSummary());
  process.exit(0);
}

const { patterns, excluded, kept } = buildPatterns();

if (args.has("--dry-run")) {
  console.log(patterns.join("\n"));
  console.log(
    `\n[dry-run] ${excluded.length} snapshot dikecualikan, ${kept} dipertahankan. Tidak ada yang diubah.`,
  );
  process.exit(0);
}

const dirty = dirtyExcludedPaths(excluded);
if (dirty.length > 0) {
  console.error(
    "Ada perubahan yang belum di-commit di path yang akan dikecualikan:",
  );
  for (const path of dirty) console.error(`  ${path}`);
  console.error("Commit atau buang dulu, lalu jalankan ulang.");
  process.exit(1);
}

const init = git(["sparse-checkout", "init", "--no-cone"], {
  stdio: "inherit",
});
if (init.status !== 0) process.exit(1);
const set = git(["sparse-checkout", "set", "--no-cone", "--stdin"], {
  input: `${patterns.join("\n")}\n`,
  stdio: ["pipe", "inherit", "inherit"],
});
if (set.status !== 0) process.exit(1);
if (git(["sparse-checkout", "reapply"], { stdio: "inherit" }).status !== 0)
  process.exit(1);

console.log(
  `Mode slim aktif: ${excluded.length} snapshot dikecualikan, ${kept} dipertahankan.`,
);
console.log(sizeSummary());
console.log("Pakai --full bila thread ini membuat migrasi (pnpm db:generate).");
