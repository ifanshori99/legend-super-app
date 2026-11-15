import { access, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PRD v1.7 §3 defines "done" as every acceptance-criteria ID passing as an
// automated test in CI. This script makes that traceable:
//   pnpm traceability              write docs/plan/criteria-matrix.md
//   pnpm traceability --strict     also exit non-zero while an ID is uncovered
// It parses the criteria tables of docs/PRD.md, finds the IDs referenced by
// test files and reports covered versus missing criteria. Coverage is
// checked strictly in CI; explicit physical release gates remain manual.
export const PRD_PATH = "docs/PRD.md";
export const MATRIX_PATH = "docs/plan/criteria-matrix.md";
// These criteria require physical verification before release, not CI evidence.
export const MANUAL_CRITERIA = Object.freeze({
  "EDG-04": "uji fisik di outlet, gerbang rilis",
});
// Used by worktrees and older checkouts where the PRD sits next to the repo.
export const FALLBACK_PRD = "PRD_Legend_Super_App_v1.7.md";

const CRITERIA_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{2}$/;
const CRITERIA_HEADING = /^\*Kriteria penerimaan (.+):\*$/;
// Tokens shaped like a criteria ID; membership in the PRD decides whether the
// reference is real and a known prefix decides whether it is a typo.
const CANDIDATE_ID =
  /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{2})(?![0-9A-Za-z_-])/g;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".worktrees",
  ".turbo",
  ".output",
  ".nitro",
  ".tanstack",
  ".data",
  "node_modules",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
]);

export function isTestFile(filename) {
  return TEST_FILE.test(filename);
}

function splitRow(row) {
  const cells = [];
  let current = "";
  for (let index = 0; index < row.length; index++) {
    const character = row[index];
    if (character === "\\" && row[index + 1] === "|") {
      current += "|";
      index++;
    } else if (character === "|") {
      cells.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(current);
  // Drop the empty cells outside the leading and trailing pipe.
  return cells.slice(1, -1).map((cell) => cell.trim());
}

/** Parse the `*Kriteria penerimaan …*` tables, ignoring every other table. */
export function parseCriteria(source) {
  const lines = source.split(/\r?\n/);
  const sections = [];
  const seen = new Map();
  for (const [index, line] of lines.entries()) {
    const heading = line.match(CRITERIA_HEADING);
    if (!heading) continue;
    const name = heading[1].trim();
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].trim() === "") cursor++;
    if (!/^\|\s*ID\s*\|/.test(lines[cursor] ?? ""))
      throw new Error(
        `Criteria section "${name}" (line ${index + 1}) has no ID table.`,
      );
    cursor++;
    while (cursor < lines.length && /^\|\s*:?-+/.test(lines[cursor].trim()))
      cursor++;
    const criteria = [];
    while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
      const [id, text = ""] = splitRow(lines[cursor].trim());
      if (!CRITERIA_ID.test(id))
        throw new Error(
          `Unexpected criteria row at line ${cursor + 1}: ${lines[cursor].trim()}`,
        );
      const lineNumber = cursor + 1;
      if (seen.has(id))
        throw new Error(
          `Duplicate criteria ID ${id} (lines ${seen.get(id)} and ${lineNumber}).`,
        );
      seen.set(id, lineNumber);
      criteria.push({ id, text, line: lineNumber });
      cursor++;
    }
    if (!criteria.length)
      throw new Error(`Criteria section "${name}" has no rows.`);
    sections.push({ name, criteria });
  }
  if (!sections.length)
    throw new Error(
      "No acceptance-criteria sections found. Is this the PRD (v1.7 §3)?",
    );
  return { sections, count: seen.size };
}

export function flattenCriteria({ sections }) {
  return sections.flatMap((section) =>
    section.criteria.map((criterion) => ({
      ...criterion,
      section: section.name,
    })),
  );
}

export function knownPrefixes(ids) {
  return new Set([...ids].map((id) => id.replace(/-\d{2}$/, "")));
}

/**
 * Find criteria IDs in test source. `known` distinguishes real criteria from
 * lookalike tokens; callers decide what to do with each.
 */
export function findCriteriaReferences(source, knownIds) {
  const prefixes = knownPrefixes(knownIds);
  const references = [];
  for (const [index, line] of source.split("\n").entries()) {
    for (const match of line.matchAll(CANDIDATE_ID)) {
      const id = match[1];
      const known = knownIds.has(id);
      if (!known && !prefixes.has(id.replace(/-\d{2}$/, ""))) continue;
      references.push({
        id,
        known,
        line: index + 1,
        evidence: line.trim().replace(/\s+/g, " ").slice(0, 160),
      });
    }
  }
  return references;
}

async function collectTestFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory())
        return IGNORED_DIRECTORIES.has(entry.name)
          ? []
          : collectTestFiles(path.join(root, entry.name));
      return isTestFile(entry.name) ? [path.join(root, entry.name)] : [];
    }),
  );
  return nested.flat().sort();
}

export async function scanTests(root, knownIds) {
  const files = await collectTestFiles(root);
  const references = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(root, file).split(path.sep).join("/");
    for (const reference of findCriteriaReferences(source, knownIds))
      references.push({ ...reference, file: relative });
  }
  return { files: files.length, references };
}

export function buildReport(parsed, scan) {
  const testsById = new Map();
  for (const reference of scan.references) {
    if (!reference.known) continue;
    const tests = testsById.get(reference.id) ?? [];
    tests.push({
      file: reference.file,
      line: reference.line,
      evidence: reference.evidence,
    });
    testsById.set(reference.id, tests);
  }
  const criteria = flattenCriteria(parsed).map((criterion) => ({
    ...criterion,
    tests: testsById.get(criterion.id) ?? [],
    manualReason: MANUAL_CRITERIA[criterion.id] ?? null,
  }));
  const sections = parsed.sections.map((section) => {
    const covered = section.criteria.filter(
      (criterion) => (testsById.get(criterion.id) ?? []).length > 0,
    ).length;
    const manual = section.criteria.filter(
      (criterion) =>
        MANUAL_CRITERIA[criterion.id] &&
        !(testsById.get(criterion.id) ?? []).length,
    ).length;
    return {
      name: section.name,
      total: section.criteria.length,
      covered,
      manual,
      missing: section.criteria.length - covered - manual,
    };
  });
  const covered = criteria.filter((criterion) => criterion.tests.length).length;
  const manual = criteria.filter(
    (criterion) => !criterion.tests.length && criterion.manualReason,
  ).length;
  const total = criteria.length;
  const unknown = [];
  const seenUnknown = new Set();
  for (const reference of scan.references) {
    if (reference.known) continue;
    const key = `${reference.id}|${reference.file}`;
    if (seenUnknown.has(key)) continue;
    seenUnknown.add(key);
    unknown.push(reference);
  }
  return {
    prd: parsed.prd,
    total,
    covered,
    manual,
    missing: total - covered - manual,
    coverage: total ? Math.round((covered / total) * 1000) / 10 : 0,
    files: scan.files,
    criteria,
    sections,
    unknown,
  };
}

function cell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function code(text) {
  return `\`${String(text).replace(/`/g, "'")}\``;
}

function referencesCell(tests) {
  if (!tests.length) return "—";
  return tests
    .map(
      (test) => `${code(`${test.file}:${test.line}`)} ${code(test.evidence)}`,
    )
    .join("<br>");
}

export function renderMatrix(report) {
  const lines = [
    "# Acceptance-criteria traceability matrix",
    "",
    "Generated by `pnpm traceability` from `docs/PRD.md`; do not edit by hand.",
    "",
    `- PRD: \`${report.prd.file}\` (${report.prd.criteria} criteria in ${report.prd.sections} criteria tables).`,
    "- A criterion counts as covered when an automated test file (`*.test.*`, `*.spec.*`) references its ID, e.g. in a test name or `describe` block.",
    "",
    `**Coverage: ${report.covered}/${report.total} criteria (${report.coverage}%), ${report.missing} missing — ${report.files} test files scanned.**`,
    "",
    `> CI runs \`pnpm traceability --strict\`: every criterion needs an automated test reference or an explicit manual release gate. ${report.manual} manual release gates remain separate from automated coverage. Unknown references always fail strict mode.`,
    "",
    "| Area | Criteria | Covered | Manual | Missing | Coverage |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.sections.map((section) => {
      const percent = section.total
        ? Math.round((section.covered / section.total) * 1000) / 10
        : 0;
      return `| ${cell(section.name)} | ${section.total} | ${section.covered} | ${section.manual} | ${section.missing} | ${percent}% |`;
    }),
    `| **Total** | **${report.total}** | **${report.covered}** | **${report.manual}** | **${report.missing}** | **${report.coverage}%** |`,
    "",
    "## Covered criteria",
    "",
  ];
  const covered = report.criteria.filter((criterion) => criterion.tests.length);
  if (!covered.length) {
    lines.push("No criterion is referenced by an automated test yet.", "");
  } else {
    lines.push("| ID | Criterion | Test references |", "| --- | --- | --- |");
    for (const criterion of covered)
      lines.push(
        `| ${criterion.id} | ${cell(criterion.text)} | ${referencesCell(criterion.tests)} |`,
      );
    lines.push("");
  }
  const manual = report.criteria.filter(
    (criterion) => !criterion.tests.length && criterion.manualReason,
  );
  lines.push(`## Manual release gates (${report.manual})`, "");
  if (manual.length) {
    lines.push("| ID | Criterion | Reason |", "| --- | --- | --- |");
    for (const criterion of manual)
      lines.push(
        `| ${criterion.id} | ${cell(criterion.text)} | ${cell(criterion.manualReason)} |`,
      );
    lines.push("");
  } else {
    lines.push("No manual release gates without automated references.", "");
  }
  lines.push(`## Missing criteria (${report.missing})`, "");
  const missing = report.criteria.filter(
    (criterion) => !criterion.tests.length && !criterion.manualReason,
  );
  if (!missing.length) {
    lines.push(
      "Every criterion has an automated test reference or an explicit manual release gate.",
      "",
    );
  } else {
    lines.push("| ID | Criterion | PRD line |", "| --- | --- | --- |");
    for (const criterion of missing)
      lines.push(
        `| ${criterion.id} | ${cell(criterion.text)} | ${report.prd.file}:${criterion.line} |`,
      );
    lines.push("");
  }
  if (report.unknown.length) {
    lines.push("## Unknown criteria IDs referenced by tests", "");
    lines.push(
      "These look like criteria IDs but are not in the PRD; fix the typo.",
      "",
      "| ID | Reference |",
      "| --- | --- |",
    );
    for (const reference of report.unknown)
      lines.push(
        `| ${reference.id} | ${code(`${reference.file}:${reference.line}`)} |`,
      );
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(candidates) {
  for (const candidate of candidates)
    if (await exists(candidate)) return candidate;
  return undefined;
}

async function resolvePrd(root, explicit) {
  if (explicit) return path.resolve(root, explicit);
  if (process.env.PRD_PATH) return path.resolve(root, process.env.PRD_PATH);
  const candidates = [path.join(root, PRD_PATH)];
  for (let depth = 1; depth <= 4; depth++)
    candidates.push(path.join(root, ...Array(depth).fill(".."), FALLBACK_PRD));
  return firstExisting(candidates);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    switch (argv[index]) {
      case "--strict":
        options.strict = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--prd":
        options.prd = argv[++index];
        break;
      case "--root":
        options.root = argv[++index];
        break;
      case "--report":
        options.report = argv[++index];
        break;
      default:
        throw new Error(`Unknown argument: ${argv[index]} (see --help).`);
    }
  }
  return options;
}

const HELP = `Acceptance-criteria traceability (legend-itfk)

Usage: pnpm traceability [options]

  --prd <file>        PRD to parse (default: ${PRD_PATH}, else ${FALLBACK_PRD})
  --strict            Exit 1 for missing non-manual criteria or unknown references
  --root <dir>        Repository root (default: working directory)
  --report <file>     Matrix path (default: ${MATRIX_PATH})
  --help              Show this help`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return;
  }
  const root = path.resolve(options.root ?? process.cwd());
  const reportPath = path.resolve(root, options.report ?? MATRIX_PATH);
  const prdPath = await resolvePrd(root, options.prd);
  if (!prdPath)
    throw new Error(
      `Could not find ${PRD_PATH} or ${FALLBACK_PRD}. Pass the PRD with --prd <file>.`,
    );
  const parsed = parseCriteria(await readFile(prdPath, "utf8"));
  const relativePrd = path.relative(root, prdPath).split(path.sep).join("/");
  parsed.prd = {
    file: relativePrd,
    criteria: parsed.count,
    sections: parsed.sections.length,
  };

  const knownIds = new Set(flattenCriteria(parsed).map((item) => item.id));
  const scan = await scanTests(root, knownIds);
  const report = buildReport(parsed, scan);
  const relativeReport = path
    .relative(root, reportPath)
    .split(path.sep)
    .join("/");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderMatrix(report));

  console.log(
    `Acceptance criteria: ${report.covered}/${report.total} covered (${report.coverage}%), ${report.missing} missing, ${report.manual} manual (${report.files} test files scanned).`,
  );
  const missingByArea = report.sections
    .filter((section) => section.missing)
    .map((section) => `${section.name} ${section.covered}/${section.total}`);
  if (missingByArea.length)
    console.log(`Missing by area: ${missingByArea.join(", ")}.`);
  if (report.unknown.length)
    console.log(
      `Unknown criteria IDs referenced by tests: ${report.unknown.map((item) => `${item.id} (${item.file}:${item.line})`).join(", ")}.`,
    );
  console.log(`Report: ${relativeReport}`);
  if (!options.strict) {
    console.log(
      "Non-blocking run; pass --strict to enforce automated references and explicit manual release gates.",
    );
  } else if (report.missing || report.unknown.length) {
    console.error(
      `Strict traceability failed: ${report.missing} criteria without an automated test reference, ${report.unknown.length} unknown references.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      "Strict traceability passed: every criterion has a test reference or an explicit manual release gate.",
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
