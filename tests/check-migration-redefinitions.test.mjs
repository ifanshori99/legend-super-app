import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/check-migration-redefinitions.mjs");

const OLD = `-- old
CREATE OR REPLACE FUNCTION app.pay_total(p_a uuid, p_b int)
RETURNS int LANGUAGE plpgsql AS $$
BEGIN
  -- a comment
  PERFORM 1;
  RETURN 1;
END;
$$;
--> statement-breakpoint
CREATE POLICY "tenant iso" ON app.pays USING (tenant = 1);
`;

const ADDER = `CREATE OR REPLACE FUNCTION app.pay_total(p_a uuid, p_b int)
RETURNS int LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1;
  PERFORM extra_guard();
  RETURN 1;
END;
$$;
`;

const STALE = `CREATE OR REPLACE FUNCTION app.pay_total(p_a uuid, p_b int)
RETURNS int LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1;
  RETURN 1;
END;
$$;
`;

const GOOD = `CREATE OR REPLACE FUNCTION app.pay_total(p_a uuid, p_b int)
RETURNS int LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1;
  PERFORM extra_guard();
  PERFORM more_guard();
  RETURN 1;
END;
$$;
`;

const ANNOTATED = `-- redefine-drops: extra_guard moved into the trigger
${STALE}`;

function fixture(newSql) {
  const dir = mkdtempSync(join(tmpdir(), "redef-"));
  mkdirSync(join(dir, "meta"));
  const tags = ["0001_old", "0002_adder", "0003_new"];
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({ entries: tags.map((tag, idx) => ({ idx, tag })) }),
  );
  writeFileSync(join(dir, "0001_old.sql"), OLD);
  writeFileSync(join(dir, "0002_adder.sql"), ADDER);
  writeFileSync(join(dir, "0003_new.sql"), newSql);
  return dir;
}

function run(dir, files = "0003_new.sql") {
  return spawnSync(process.execPath, [script, "--dir", dir, "--files", files], {
    encoding: "utf8",
  });
}

test("stale rewrite that drops the adder's line is LOST", () => {
  const dir = fixture(STALE);
  try {
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /LOST 0003_new\.sql:1 function app\.pay_total\/2/);
    assert.match(r.stderr, /from 0002_adder\.sql:5: PERFORM extra_guard\(\);/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("correct rewrite is clean", () => {
  const dir = fixture(GOOD);
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redefine-drops annotation passes", () => {
  const dir = fixture(ANNOTATED);
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dropped policy line is reported; comments and blanks are ignored", () => {
  const dir = fixture(
    `CREATE POLICY "tenant iso" ON app.pays USING (tenant = 2);\n`,
  );
  try {
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /policy tenant iso on app\.pays/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git mode: only added migrations are checked", () => {
  const dir = fixture(STALE);
  try {
    const g = (...a) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        cwd: dir,
        encoding: "utf8",
      });
    // base commit holds journal + first two migrations; 0003 is the new file
    g("init", "-q", "-b", "base");
    g("add", "meta", "0001_old.sql", "0002_adder.sql");
    g("commit", "-q", "-m", "base");
    g("checkout", "-q", "-b", "work");
    g("add", "0003_new.sql");
    g("commit", "-q", "-m", "new");
    const r = spawnSync(
      process.execPath,
      [script, "--dir", dir, "--base", "base"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /LOST 0003_new\.sql/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown base ref exits 2", () => {
  const dir = fixture(GOOD);
  try {
    const r = spawnSync(
      process.execPath,
      [script, "--dir", dir, "--base", "nope"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function pair(oldSql, newSql) {
  const dir = mkdtempSync(join(tmpdir(), "redef-"));
  mkdirSync(join(dir, "meta"));
  writeFileSync(
    join(dir, "meta", "_journal.json"),
    JSON.stringify({
      entries: [
        { idx: 0, tag: "0001_old" },
        { idx: 1, tag: "0002_new" },
      ],
    }),
  );
  writeFileSync(join(dir, "0001_old.sql"), oldSql);
  writeFileSync(join(dir, "0002_new.sql"), newSql);
  return dir;
}

function check(oldSql, newSql) {
  const dir = pair(oldSql, newSql);
  try {
    return run(dir, "0002_new.sql");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fn = (name, body) =>
  `CREATE OR REPLACE FUNCTION ${name}(a int)\nRETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n${body}END;\n$$;\n`;

test("a line present twice in the old definition and once in the new is LOST", () => {
  const r = check(
    fn("app.f", "  PERFORM g();\n  PERFORM g();\n"),
    fn("app.f", "  PERFORM g();\n"),
  );
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /PERFORM g\(\);/);
});

test("CREATE OR REPLACE TRIGGER and PROCEDURE are tracked", () => {
  const trig = (cond) =>
    `CREATE OR REPLACE TRIGGER trg_pay\nBEFORE UPDATE ON app.pays\nFOR EACH ROW\n${cond}EXECUTE FUNCTION app.f();\n`;
  const t = check(trig("WHEN (old.a = 1)\n"), trig(""));
  assert.equal(t.status, 1, t.stderr);
  assert.match(t.stderr, /trigger trg_pay on app\.pays/);
  const proc = (body) =>
    `CREATE PROCEDURE app.p(a int) LANGUAGE plpgsql AS $$\nBEGIN\n${body}END;\n$$;\n`;
  const p = check(proc("  CALL x();\n"), proc(""));
  assert.equal(p.status, 1, p.stderr);
  assert.match(p.stderr, /procedure app\.p\/1/);
});

test("public. prefix and quotes do not change object identity; app.x is not x", () => {
  const stale = check(
    fn("public.f", "  PERFORM g();\n"),
    fn('"f"', "  PERFORM h();\n"),
  );
  assert.equal(stale.status, 1, stale.stderr);
  const policy = (table, using) =>
    `CREATE POLICY p ON ${table} USING (${using});\n`;
  const pol = check(
    policy("public.pays", "a = 1"),
    policy('"public"."pays"', "a = 2"),
  );
  assert.equal(pol.status, 1, pol.stderr);
  const other = check(
    fn("app.f", "  PERFORM g();\n"),
    fn("f", "  PERFORM h();\n"),
  );
  assert.equal(other.status, 0, other.stderr);
});

test("plain CREATE to CREATE OR REPLACE with the same body is not LOST", () => {
  const body = "  PERFORM g();\n";
  const r = check(
    fn("app.f", body).replace("OR REPLACE ", ""),
    fn("app.f", body).replace("CREATE OR REPLACE", "create or replace"),
  );
  assert.equal(r.status, 0, r.stderr);
});

test("git mode: a renamed (renumbered) migration is checked", () => {
  const dir = pair(fn("app.f", "  PERFORM g();\n"), "");
  try {
    rmSync(join(dir, "0002_new.sql"));
    const g = (...a) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        cwd: dir,
        encoding: "utf8",
      });
    g("init", "-q", "-b", "base");
    writeFileSync(
      join(dir, "0003_tmp.sql"),
      fn("app.f", "  PERFORM g();\n  PERFORM k();\n"),
    );
    g("add", "0001_old.sql", "0003_tmp.sql");
    g("commit", "-q", "-m", "base");
    g("checkout", "-q", "-b", "work");
    g("mv", "0003_tmp.sql", "0002_re.sql");
    writeFileSync(join(dir, "0002_re.sql"), fn("app.f", "  PERFORM h();\n"));
    writeFileSync(
      join(dir, "meta", "_journal.json"),
      JSON.stringify({
        entries: ["0001_old", "0002_re"].map((tag, idx) => ({ idx, tag })),
      }),
    );
    g("add", "-A", ".");
    g("commit", "-q", "-m", "renumber");
    const r = spawnSync(
      process.execPath,
      [script, "--dir", dir, "--base", "base"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /LOST 0002_re\.sql/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
