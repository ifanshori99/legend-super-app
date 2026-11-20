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
