// Renumbers the Drizzle migrations a branch brings into a merge and rebuilds
// their snapshots from the merged schema (merge train, batch48b).
//
//   node scripts/migration-renumber.mjs apply --from <rev> \
//        <oldTag>:<newNum>:<when> [<oldTag>:<newNum>:<when> ...]
//   node scripts/migration-renumber.mjs check [--from-idx <n>]
//
// `apply` (run in the merge worktree after `git merge --no-ff <branch>`, with
// the merge's code conflicts already resolved; the journal and snapshots may
// still be conflicted, they are rebuilt here):
//   1. the journal base is HEAD's journal, so a conflicted journal is ignored;
//   2. each migration's SQL and old snapshot are read from <rev> (the merged
//      branch, e.g. MERGE_HEAD), and the old-numbered files the merge brought
//      in are removed (a file HEAD itself holds at that path is kept);
//   3. the SQL is written under its new number; `drizzle-kit generate` then
//      builds the snapshot of the merged schema (the generated SQL and journal
//      entry are discarded). With several migrations in one merge the earlier
//      snapshots are the final one minus the later migrations' deltas, taken
//      from the branch's own old snapshots (same lineage, consecutive order);
//   4. journal entries (`idx` = new number, `when` as given) are appended and
//      every snapshot gets `prevId` of the one before it;
//   5. `drizzle-kit generate` must report no schema changes, else exit 1.
// It prints the places that still mention an old number so they can be edited.
//
// `check` verifies tag/file/idx agreement, `when` ascending and the
// snapshot prevId chain from `--from-idx` (default 217) to the end.
//
// Uses only node: built-ins and the repo's own `pnpm db:generate`.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const git = (args, opts = {}) =>
  spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts });
const root = git(["rev-parse", "--show-toplevel"]).stdout.trim();
const rel = "apps/api/drizzle";
const dir = join(root, rel);
const metaDir = join(dir, "meta");
const journalPath = join(metaDir, "_journal.json");

const fail = (msg) => {
  console.error(`migration-renumber: ${msg}`);
  process.exit(1);
};
const show = (rev, path) => {
  const r = git(["show", `${rev}:${path}`], { cwd: root });
  return r.status === 0 ? r.stdout : null;
};
const inRev = (rev, path) =>
  git(["cat-file", "-e", `${rev}:${path}`], { cwd: root }).status === 0;
const writeJournal = (journal) =>
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
const snapPath = (num) => join(metaDir, `${num}_snapshot.json`);
const generate = (name) =>
  spawnSync("pnpm", ["db:generate", ...(name ? ["--name", name] : [])], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });

// Undo, inside `target`, what `after` changed relative to `before`.
function revert(target, after, before) {
  for (const key of Object.keys(after)) {
    if (!(key in before)) delete target[key];
    else if (JSON.stringify(after[key]) !== JSON.stringify(before[key])) {
      const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
      if (plain(after[key]) && plain(before[key]) && plain(target[key]))
        revert(target[key], after[key], before[key]);
      else target[key] = before[key];
    }
  }
  for (const key of Object.keys(before))
    if (!(key in after)) target[key] = before[key];
}

function apply(argv) {
  const fromAt = argv.indexOf("--from");
  if (fromAt < 0 || !argv[fromAt + 1]) fail("apply needs --from <rev>");
  const rev = argv[fromAt + 1];
  const specs = argv
    .filter((_, i) => i !== fromAt && i !== fromAt + 1)
    .map((s) => {
      const [oldTag, newNum, when] = s.split(":");
      if (!oldTag || !/^\d{4}$/.test(newNum ?? "") || !/^\d+$/.test(when ?? ""))
        fail(`bad spec "${s}" (want <oldTag>:<newNum>:<when>)`);
      const oldNum = oldTag.split("_")[0];
      return {
        oldTag,
        oldNum,
        newNum,
        newTag: `${newNum}_${oldTag.slice(5)}`,
        when: Number(when),
      };
    });
  if (specs.length === 0) fail("no migrations given");

  const baseJournal = JSON.parse(show("HEAD", `${rel}/meta/_journal.json`));
  const branchJournal = JSON.parse(show(rev, `${rel}/meta/_journal.json`));
  const last = baseJournal.entries.at(-1);
  if (Number(specs[0].newNum) !== Number(last.tag.slice(0, 4)) + 1)
    fail(
      `${specs[0].newNum} does not follow HEAD's last migration ${last.tag}`,
    );
  specs.forEach((s, i) => {
    if (i > 0 && Number(s.newNum) !== Number(specs[i - 1].newNum) + 1)
      fail(`${s.newNum} is not consecutive`);
    const floor = i === 0 ? last.when : specs[i - 1].when;
    if (s.when <= floor)
      fail(`${s.newTag}: when ${s.when} must exceed ${floor}`);
  });

  // 1-2: read the branch's files, clear what the merge brought in.
  for (const s of specs) {
    s.sql = show(rev, `${rel}/${s.oldTag}.sql`);
    if (s.sql === null) fail(`${rev} has no ${s.oldTag}.sql`);
    const branchEntry = branchJournal.entries.find((e) => e.tag === s.oldTag);
    if (!branchEntry) fail(`${rev} has no journal entry for ${s.oldTag}`);
    const indexedNum = String(branchEntry.idx).padStart(4, "0");
    let oldSnapshotPath = `${rel}/meta/${indexedNum}_snapshot.json`;
    let snap = show(rev, oldSnapshotPath);
    // A SQL-only migration may keep an old tag number while its journal idx
    // advances. Never mistake HEAD's historical snapshot for that migration.
    if (
      snap === null &&
      indexedNum !== s.oldNum &&
      !inRev("HEAD", `${rel}/meta/${s.oldNum}_snapshot.json`)
    ) {
      oldSnapshotPath = `${rel}/meta/${s.oldNum}_snapshot.json`;
      snap = show(rev, oldSnapshotPath);
    }
    s.oldSnap = snap === null ? null : JSON.parse(snap);
    for (const path of [`${rel}/${s.oldTag}.sql`, oldSnapshotPath]) {
      if (inRev("HEAD", path)) {
        git(["checkout", "HEAD", "--", path], { cwd: root });
      } else {
        git(["rm", "-q", "-f", "--ignore-unmatch", "--", path], { cwd: root });
        rmSync(join(root, path), { force: true });
      }
    }
  }
  writeJournal(baseJournal);
  for (const s of specs) {
    rmSync(snapPath(s.newNum), { force: true });
    writeFileSync(join(dir, `${s.newTag}.sql`), s.sql);
  }

  // 3: snapshot of the merged schema from drizzle-kit.
  const before = new Set(readdirSync(dir));
  const gen = generate("gen_tmp");
  if (gen.status !== 0) fail(`db:generate failed\n${gen.stdout}${gen.stderr}`);
  const made = readdirSync(dir).filter(
    (f) => !before.has(f) && f.endsWith("_gen_tmp.sql"),
  );
  let merged;
  if (
    made.length === 0 &&
    `${gen.stdout}${gen.stderr}`.includes("No schema changes")
  ) {
    merged = JSON.parse(readFileSync(snapPath(last.tag.slice(0, 4)), "utf8"));
  } else {
    if (made.length !== 1)
      fail("db:generate wrote no migration (nothing to do?)");
    const genNum = made[0].slice(0, 4);
    merged = JSON.parse(readFileSync(snapPath(genNum), "utf8"));
    rmSync(join(dir, made[0]));
    rmSync(snapPath(genNum));
  }
  writeJournal(baseJournal);

  // 4: one snapshot per migration, chained.
  const snaps = new Array(specs.length);
  let cur = structuredClone(merged);
  for (let i = specs.length - 1; i >= 0; i--) {
    snaps[i] = structuredClone(cur);
    if (i > 0) {
      if (!specs[i].oldSnap || !specs[i - 1].oldSnap) {
        // The branch never generated snapshots for these migrations (its meta
        // stops at an earlier number): every snapshot is then the merged
        // schema. Harmless: drizzle only diffs against the latest snapshot.
        console.warn(
          `migration-renumber: no old snapshots for ${specs[i].oldTag}; using the merged schema for the earlier ones too`,
        );
        continue;
      }
      revert(cur, specs[i].oldSnap, specs[i - 1].oldSnap);
    }
  }
  let prevId = JSON.parse(
    readFileSync(snapPath(baseJournal.entries.at(-1).tag.slice(0, 4)), "utf8"),
  ).id;
  specs.forEach((s, i) => {
    snaps[i].id = s.oldSnap?.id ?? randomUUID();
    snaps[i].prevId = prevId;
    prevId = snaps[i].id;
    writeFileSync(snapPath(s.newNum), JSON.stringify(snaps[i], null, 2));
    baseJournal.entries.push({
      idx: Number(s.newNum),
      version: "7",
      when: s.when,
      tag: s.newTag,
      breakpoints: true,
    });
  });
  writeJournal(baseJournal);
  git(["add", "-A", rel], { cwd: root });

  // 5: the merged schema must now be fully covered.
  const verify = generate();
  const out = `${verify.stdout}${verify.stderr}`;
  if (verify.status !== 0 || !out.includes("No schema changes"))
    fail(`db:generate is not empty after renumbering\n${out.slice(-800)}`);
  git(["add", "-A", rel], { cwd: root });
  console.log(
    specs.map((s) => `${s.oldTag} -> ${s.newTag} (when ${s.when})`).join("\n"),
  );
  console.log("db:generate: no schema changes");
  for (const s of specs) {
    const refs = git(
      [
        "grep",
        "-n",
        "-w",
        s.oldNum,
        "--",
        "apps",
        "packages",
        "e2e",
        "tests",
        "scripts",
        "docs",
        ":!apps/api/drizzle/meta",
        ":!*.png",
        ":!*.ttf",
        ":!docs/PROGRESS.md",
        ":!docs/briefs",
      ],
      { cwd: root },
    ).stdout.trim();
    if (refs)
      console.log(`\nstill mention ${s.oldNum}:\n${refs.slice(0, 2500)}`);
  }
}

function check(argv) {
  const at = argv.indexOf("--from-idx");
  const fromIdx = at >= 0 ? Number(argv[at + 1]) : 217;
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const problems = [];
  let prev = null;
  for (const e of journal.entries.filter((x) => x.idx >= fromIdx)) {
    const num = e.tag.slice(0, 4);
    if (Number(num) !== e.idx) problems.push(`${e.tag}: idx ${e.idx}`);
    if (!existsSync(join(dir, `${e.tag}.sql`)))
      problems.push(`${e.tag}: sql missing`);
    if (!existsSync(snapPath(num))) {
      problems.push(`${e.tag}: snapshot missing`);
      continue;
    }
    const snap = JSON.parse(readFileSync(snapPath(num), "utf8"));
    if (prev) {
      if (e.when <= prev.when)
        problems.push(`${e.tag}: when ${e.when} <= ${prev.when}`);
      if (snap.prevId !== prev.id)
        problems.push(`${e.tag}: prevId does not match ${prev.tag}`);
    }
    prev = { tag: e.tag, when: e.when, id: snap.id };
  }
  const tags = new Set(journal.entries.map((e) => e.tag));
  for (const f of readdirSync(dir))
    if (f.endsWith(".sql") && !tags.has(f.slice(0, -4)))
      problems.push(`${f}: not in the journal`);
  if (problems.length) fail(problems.join("\n"));
  console.log(
    `journal ok from idx ${fromIdx} (${journal.entries.length} entries)`,
  );
}

const [command, ...rest] = process.argv.slice(2);
if (command === "apply") apply(rest);
else if (command === "check") check(rest);
else fail("usage: apply --from <rev> <oldTag>:<newNum>:<when> ... | check");
