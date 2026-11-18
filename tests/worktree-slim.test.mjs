// Runs scripts/worktree-slim.mjs against a throwaway repo whose path contains
// spaces. The script must work from inside a worktree and from a standalone
// copy outside any git repo (like ~/.claude/scripts), using the cwd's repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sourceScript = join(here, "..", "scripts", "worktree-slim.mjs");

let tmpRoot;
let mainDir;
let worktreeDir;
let standaloneScript;

function cleanEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  return env;
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
  });
}

function git(cwd, ...args) {
  const result = run(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
  );
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function writeFixture(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function runScript(script, args, cwd) {
  return run(process.execPath, [script, ...args], cwd);
}

before(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "legend super app test-")));
  mainDir = join(tmpRoot, "main repo");
  worktreeDir = join(tmpRoot, "wt dir");
  mkdirSync(mainDir);

  git(mainDir, "init", "-b", "main");
  const meta = join(mainDir, "apps", "api", "drizzle", "meta");
  for (let i = 0; i <= 8; i += 1) {
    writeFixture(
      join(meta, `${String(i).padStart(4, "0")}_snapshot.json`),
      "{}\n",
    );
  }
  writeFixture(join(meta, "_journal.json"), "{}\n");
  writeFixture(
    join(mainDir, "apps", "api", "src", "test", "a.test.ts"),
    "// fixture\n",
  );
  writeFixture(join(mainDir, "design", "x.png"), "png\n");
  git(mainDir, "add", "-A");
  git(mainDir, "commit", "-m", "fixture");
  git(mainDir, "worktree", "add", worktreeDir, "-b", "wt");

  const standaloneDir = join(tmpRoot, "standalone scripts");
  mkdirSync(standaloneDir);
  standaloneScript = join(standaloneDir, "worktree-slim.mjs");
  copyFileSync(sourceScript, standaloneScript);
});

after(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("worktree-slim", () => {
  it("runs --dry-run from a copy inside the worktree", () => {
    const inside = join(worktreeDir, "scripts", "worktree-slim.mjs");
    mkdirSync(dirname(inside), { recursive: true });
    copyFileSync(sourceScript, inside);

    const result = runScript(inside, ["--dry-run"], worktreeDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\]/);
  });

  it("runs --dry-run from a standalone copy outside any repo", () => {
    const result = runScript(standaloneScript, ["--dry-run"], worktreeDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[dry-run\]/);
  });

  it("runs --status from a standalone copy outside any repo", () => {
    const result = runScript(standaloneScript, ["--status"], worktreeDir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Mode:/);
  });

  it("refuses the main checkout from a standalone copy", () => {
    const result = runScript(standaloneScript, ["--dry-run"], mainDir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checkout utama/);
  });
});
