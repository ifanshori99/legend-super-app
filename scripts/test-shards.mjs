// The full test suite without hosted CI (founder 25 Nov: no GitHub Actions bill):
//   node scripts/test-shards.mjs [--chunks 8] [--lanes 2] [--heavy]
// Splits every test file into chunks and runs each one as a targeted `pnpm test`
// with its own disposable database, `lanes` at a time. A chunk that passed for
// the same commit is skipped on the next run, so a killed run continues where
// it stopped. Logs and results: .test-shards/<sha>/ (git-ignored). Exits 1 when
// any chunk failed.
import { execFileSync, spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, posix, resolve } from "node:path";
import { root } from "./lib.mjs";

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? fallback : Number(process.argv[at + 1]);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`--${name} needs a whole number of 1 or more.`);
  return value;
};
const chunkCount = flag("chunks", 8);
const lanes = flag("lanes", 2);
const heavy = process.argv.includes("--heavy");

const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (git("status", "--porcelain", "--untracked-files=no"))
  throw new Error("Commit first: results are stored per commit.");
const sha = git("rev-parse", "--short", "HEAD");

const walk = (dir, prefix) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? entry.name === "node_modules"
        ? []
        : walk(posix.join(dir, entry.name), posix.join(prefix, entry.name))
      : /\.test\.[cm]?[jt]sx?$/.test(entry.name)
        ? [posix.join(prefix, entry.name)]
        : [],
  );
const api = walk("apps/api/src", "src").sort();
const web = walk("apps/web/test", "apps/web/test").sort();
const rootTests = readdirSync(resolve(root, "tests"))
  .filter((file) => file.endsWith(".test.mjs"))
  .map((file) => `tests/${file}`)
  .sort();

// Round-robin keeps slow families (payroll-*, accounting-*) spread evenly.
const chunks = [{ name: "root-web", files: [...rootTests, ...web] }];
for (let n = 0; n < chunkCount; n += 1)
  chunks.push({
    name: `api-${n + 1}`,
    files: api.filter((_, index) => index % chunkCount === n),
  });

const out = join(root, ".test-shards", sha);
mkdirSync(out, { recursive: true });

// A result counts only for the same file list: another --chunks value reruns.
const done = ({ name, files }) => {
  const path = join(out, `${name}.json`);
  if (!existsSync(path)) return false;
  const saved = JSON.parse(readFileSync(path, "utf8"));
  return saved.exit === 0 && saved.files.join() === files.join();
};

function runChunk({ name, files }) {
  const started = Date.now();
  const [command, args] = heavy
    ? ["heavy", ["pnpm", "test"]]
    : ["pnpm", ["test"]];
  const log = createWriteStream(join(out, `${name}.log`));
  return new Promise((accept) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, LEGEND_TEST_FILES: files.join(" ") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("error", (error) => {
      log.write(`${error.message}\n`);
    });
    child.once("close", (code) => {
      log.end();
      const exit = code ?? 1;
      const minutes = ((Date.now() - started) / 60_000).toFixed(1);
      writeFileSync(
        join(out, `${name}.json`),
        JSON.stringify({ exit, minutes, files }),
      );
      console.log(
        `${name}: ${exit === 0 ? "passed" : `FAILED (${exit})`} in ${minutes} min`,
      );
      accept(exit);
    });
  });
}

const queue = chunks.filter((chunk) => chunk.files.length && !done(chunk));
console.log(
  `${sha}: ${queue.length} of ${chunks.length} chunks to run, ${lanes} at a time.`,
);
let failed = 0;
await Promise.all(
  Array.from({ length: lanes }, async () => {
    for (let chunk = queue.shift(); chunk; chunk = queue.shift())
      if ((await runChunk(chunk)) !== 0) failed += 1;
  }),
);
console.log(failed ? `${failed} chunks failed.` : "All chunks passed.");
process.exitCode = failed ? 1 : 0;
