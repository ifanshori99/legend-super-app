import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MATRIX_PATH,
  PRD_PATH,
  buildReport,
  findCriteriaReferences,
  flattenCriteria,
  isTestFile,
  parseCriteria,
  renderMatrix,
  scanTests,
} from "./traceability.mjs";

const script = fileURLToPath(new URL("./traceability.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const PRD = `# PRD fixture

Intro text that is not a criteria table.

*Kriteria penerimaan multi-tenant:*
| ID | Kriteria wajib |
|----|----------------|
| AAA-01 | Reads and exports stay inside the tenant |
| AAA-02 | RLS rejects a missing tenant context |

**38. Tanya AI**
| Kode | Fitur AI | Pengguna |
|------|----------|----------|
| AI-01 | Menu advice | Guest |

*Kriteria penerimaan Operasional Harian:*
| ID | Kriteria wajib |
|----|----------------|
| BBB-01 | Escalation reaches the supervisor in 15 minutes |
`;

/** Parsed fixture in the shape the CLI hands to buildReport(). */
function fixturePrd() {
  const parsed = parseCriteria(PRD);
  return {
    ...parsed,
    prd: {
      file: "PRD.md",
      criteria: parsed.count,
      sections: parsed.sections.length,
    },
  };
}

test("parses only the criteria tables and keeps PRD line numbers", () => {
  const { sections, count } = parseCriteria(PRD);
  assert.equal(count, 3);
  assert.deepEqual(
    sections.map((section) => section.name),
    ["multi-tenant", "Operasional Harian"],
  );
  assert.deepEqual(
    sections.map((section) => section.criteria.map((item) => item.id)),
    [["AAA-01", "AAA-02"], ["BBB-01"]],
  );
  const lines = PRD.split("\n");
  for (const criterion of flattenCriteria({ sections }))
    assert.equal(lines[criterion.line - 1].includes(criterion.id), true);
  // The AI feature catalog in the same chapter is not an acceptance criterion.
  assert.equal(
    flattenCriteria({ sections }).some((item) => item.id === "AI-01"),
    false,
  );
});

test("keeps escaped pipes inside criterion text", () => {
  const source = `*Kriteria penerimaan contoh:*
| ID | Kriteria wajib |
|----|----------------|
| TEST-01 | Penjualan \\| ekspor dibatasi |
`;
  assert.equal(
    parseCriteria(source).sections[0].criteria[0].text,
    "Penjualan | ekspor dibatasi",
  );
});

test("rejects a criteria section without a table and duplicate IDs", () => {
  assert.throws(
    () => parseCriteria("*Kriteria penerimaan contoh:*\n\nNo table here."),
    /has no ID table/,
  );
  assert.throws(
    () =>
      parseCriteria(`*Kriteria penerimaan contoh:*
| ID | Kriteria wajib |
|----|----------------|
| AAA-01 | First |
| AAA-01 | Second |
`),
    /Duplicate criteria ID AAA-01/,
  );
  assert.throws(() => parseCriteria("# Not a PRD"), /No acceptance-criteria/);
});

test("finds criteria IDs in test names but not lookalike tokens", () => {
  const ids = new Set(["AAA-01", "AAA-02", "BBB-01"]);
  const source = [
    'describe("AAA-01 cross-tenant access", () => {',
    '  test("rejects a foreign read", () => {});',
    "});",
    'test("AAA-02 rejects a missing tenant context", () => {});',
    '  expect(value).toBe("X-AAA-01");',
    '  expect(value).toBe("AAA-010");',
    '  const encoding = "UTF-16";',
    '  const typo = "AAA-99";',
  ].join("\n");
  const references = findCriteriaReferences(source, ids);
  assert.deepEqual(
    references.map((reference) => [
      reference.id,
      reference.line,
      reference.known,
    ]),
    [
      ["AAA-01", 1, true],
      ["AAA-02", 4, true],
      ["AAA-99", 8, false],
    ],
  );
  assert.equal(
    references[0].evidence,
    'describe("AAA-01 cross-tenant access", () => {',
  );
});

test("recognises test and spec files only", () => {
  for (const file of ["a.test.ts", "a.test.tsx", "a.spec.mjs", "a.test.js"])
    assert.equal(isTestFile(file), true, file);
  for (const file of ["a.ts", "atest.ts", "a.spec.md"])
    assert.equal(isTestFile(file), false, file);
});

test("scans test files and skips dependencies, builds and worktrees", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legend-traceability-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, body] of [
    ["a.test.ts", 'test("AAA-01 keeps data inside one tenant", () => {});'],
    ["b.spec.mjs", 'test("BBB-01 alerts the supervisor", () => {});'],
    ["notes.ts", "export const value = 1;"],
    ["node_modules/pkg/a.test.ts", 'test("AAA-02 dependency", () => {});'],
    [".worktrees/other/a.test.ts", 'test("AAA-02 worktree", () => {});'],
    ["dist/a.test.ts", 'test("AAA-02 build", () => {});'],
  ]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  }
  const scan = await scanTests(root, new Set(["AAA-01", "AAA-02", "BBB-01"]));
  assert.equal(scan.files, 2);
  assert.deepEqual(
    scan.references.map((reference) => reference.file),
    ["a.test.ts", "b.spec.mjs"],
  );
});

test("builds covered, missing and unknown counts per area", () => {
  const scan = {
    files: 2,
    references: [
      {
        id: "AAA-01",
        known: true,
        file: "a.test.ts",
        line: 3,
        evidence: 'test("AAA-01", () => {})',
      },
      {
        id: "AAA-99",
        known: false,
        file: "b.spec.mjs",
        line: 7,
        evidence: 'test("AAA-99", () => {})',
      },
    ],
  };
  const report = buildReport(fixturePrd(), scan);
  assert.equal(report.total, 3);
  assert.equal(report.covered, 1);
  assert.equal(report.missing, 2);
  assert.equal(report.coverage, 33.3);
  assert.deepEqual(report.sections, [
    { name: "multi-tenant", total: 2, covered: 1, manual: 0, missing: 1 },
    { name: "Operasional Harian", total: 1, covered: 0, manual: 0, missing: 1 },
  ]);
  assert.deepEqual(
    report.unknown.map((reference) => reference.id),
    ["AAA-99"],
  );
});

test("renders a deterministic matrix with covered, missing and unknown rows", () => {
  const report = buildReport(fixturePrd(), {
    files: 1,
    references: [
      {
        id: "AAA-01",
        known: true,
        file: "a.test.ts",
        line: 3,
        evidence: 'test("AAA-01 blocks a foreign read", () => {})',
      },
      {
        id: "AAA-99",
        known: false,
        file: "a.test.ts",
        line: 4,
        evidence: 'test("AAA-99 typo", () => {})',
      },
    ],
  });
  const matrix = renderMatrix(report);
  assert.match(
    matrix,
    /\*\*Coverage: 1\/3 criteria \(33\.3%\), 2 missing — 1 test files scanned\.\*\*/,
  );
  assert.match(matrix, /\| AAA-01 \| .* \| `a\.test\.ts:3`/);
  assert.match(matrix, /## Missing criteria \(2\)/);
  assert.match(matrix, /PRD\.md:\d+/);
  assert.match(matrix, /## Unknown criteria IDs referenced by tests/);
  assert.match(matrix, /\| AAA-99 \| `a\.test\.ts:4` \|/);
  assert.equal(renderMatrix(report), matrix);
});

test("the repository PRD yields the 125 criteria and the committed matrix lists each", async () => {
  const parsed = parseCriteria(
    await readFile(path.join(repoRoot, PRD_PATH), "utf8"),
  );
  const criteria = flattenCriteria(parsed);
  assert.equal(parsed.count, 125);
  assert.equal(criteria.length, 125);
  assert.equal(new Set(criteria.map((item) => item.id)).size, 125);
  assert.equal(parsed.sections.length, 15);
  for (const criterion of criteria)
    assert.ok(criterion.text.length > 0, criterion.id);

  const matrix = await readFile(path.join(repoRoot, MATRIX_PATH), "utf8");
  const listed = new Set(
    [...matrix.matchAll(/^\| ([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{2}) \|/gm)].map(
      (match) => match[1],
    ),
  );
  assert.deepEqual([...listed].sort(), criteria.map((item) => item.id).sort());
  assert.match(matrix, /\| \*\*Total\*\* \| \*\*125\*\* \|/);
  assert.match(matrix, new RegExp(`\`${PRD_PATH}\``));
});

async function tempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legend-traceability-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, PRD_PATH), PRD);
  return root;
}

function run(args, cwd) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("CLI is non-blocking by default and fails only under --strict", async (t) => {
  const root = await tempRoot(t);
  await writeFile(
    path.join(root, "sample.test.ts"),
    'test("AAA-01 blocks a foreign read", () => {});',
  );
  const report = run([], root);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /1\/3 covered/);
  assert.match(report.stdout, /Non-blocking run/);
  const matrix = await readFile(path.join(root, MATRIX_PATH), "utf8");
  assert.match(matrix, /\| AAA-01 \|/);

  const strict = run(["--strict"], root);
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /Strict traceability failed: 2 criteria/);

  await writeFile(
    path.join(root, "sample.test.ts"),
    [
      'test("AAA-01 blocks a foreign read", () => {});',
      'test("AAA-02 rejects a missing context", () => {});',
      'test("BBB-01 alerts the supervisor", () => {});',
    ].join("\n"),
  );
  const passing = run(["--strict"], root);
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /Strict traceability passed/);

  await writeFile(
    path.join(root, "other.spec.ts"),
    'test("AAA-99 typo stays visible", () => {});',
  );
  const typo = run(["--strict"], root);
  assert.equal(typo.status, 1);
  assert.match(typo.stdout, /Unknown criteria IDs referenced by tests: AAA-99/);
});

test("CLI honours --prd and reports a missing PRD with a clear error", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legend-traceability-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = run([], root);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not find docs\/PRD\.md/);

  await writeFile(
    path.join(root, "alternate.md"),
    `*Kriteria penerimaan contoh:*
| ID | Kriteria wajib |
|----|----------------|
| CCC-01 | Only one criterion |
`,
  );
  const alternate = run(["--prd", "alternate.md"], root);
  assert.equal(alternate.status, 0, alternate.stderr);
  assert.match(alternate.stdout, /0\/1 covered/);
});

const manualId = ["EDG", "04"].join("-");
const automaticId = ["EDG", "03"].join("-");
const unknownId = ["EDG", "99"].join("-");

test("strict allows the physical failover release gate without counting it as automated coverage", async (t) => {
  const root = await tempRoot(t);
  await writeFile(
    path.join(root, PRD_PATH),
    `*Kriteria penerimaan edge node:*
| ID | Kriteria wajib |
|----|----------------|
| ${manualId} | Physical standby failover |
| ${automaticId} | Automatic edge check |
`,
  );
  await writeFile(
    path.join(root, "sample.test.ts"),
    `test("${automaticId} automatic check", () => {});`,
  );
  const result = run(["--strict"], root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\/2 covered/);
  assert.match(result.stdout, /1 manual/);
  const matrix = await readFile(path.join(root, MATRIX_PATH), "utf8");
  assert.match(matrix, /## Manual release gates \(1\)/);
  assert.match(matrix, /uji fisik di outlet, gerbang rilis/);
  assert.match(matrix, /## Missing criteria \(0\)/);
  const covered = matrix.split("## Covered criteria")[1].split("##")[0];
  assert.equal(covered.includes(manualId), false);

  await writeFile(path.join(root, "sample.test.ts"), "");
  const missing = run(["--strict"], root);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Strict traceability failed: 1 criteria/);

  await writeFile(
    path.join(root, "sample.test.ts"),
    `test("${automaticId} automatic check", () => {});
test("${unknownId} typo", () => {});`,
  );
  const unknown = run(["--strict"], root);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /1 unknown references/);
});

test("manual criteria remain visible in report counts and do not suppress automated evidence", () => {
  const parsed = parseCriteria(`*Kriteria penerimaan edge node:*
| ID | Kriteria wajib |
|----|----------------|
| ${manualId} | Physical failover |
| ${automaticId} | Automatic edge check |
`);
  parsed.prd = { file: "PRD.md", criteria: 2, sections: 1 };
  const report = buildReport(parsed, { files: 0, references: [] });
  assert.equal(report.covered, 0);
  assert.equal(report.manual, 1);
  assert.equal(report.missing, 1);
  assert.equal(report.coverage, 0);
  assert.equal(report.sections[0].manual, 1);
  assert.equal(report.sections[0].missing, 1);
  const automated = buildReport(parsed, {
    files: 1,
    references: [{ id: manualId, known: true, file: "a.test.ts", line: 1 }],
  });
  assert.equal(automated.covered, 1);
  assert.equal(automated.manual, 0);
  assert.equal(automated.missing, 1);
});
