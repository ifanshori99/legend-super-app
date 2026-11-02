// Screenshot evidence must not dirty tracked files (bead legend-nt8q).
//
// The mock e2e suite used to rewrite tracked files under
// docs/design/screenshots/** on every run (for example
// legend-baa/masuk-hubungkan-390-light.png), so every worktree and main went
// dirty after `pnpm test:e2e:mock`. Specs capture through e2e/screenshots.ts
// now: it writes to test-results/screenshots/ by default and only touches
// docs/design/screenshots/ when LEGEND_CAPTURE_SCREENSHOTS=1.
//
// This suite fails when any e2e file writes a docs/ path without the helper, so
// the tracked evidence can only change on purpose.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const e2eRoot = resolve(root, "e2e");
const helperName = "screenshots.ts";
const screenshots = await import("../e2e/screenshots.ts");

/** Every e2e source file except the helper that owns the docs path. */
const sources = readdirSync(e2eRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
  .map((entry) => join(entry.parentPath, entry.name))
  .filter((file) => basename(file) !== helperName)
  .sort();

/** Text between the `(` at `open` and its matching `)`, strings respected. */
function argumentsOf(source, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return source.slice(open + 1);
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** Offences in one e2e source, as "<line>: <what>" strings. */
function violations(source) {
  const found = [];
  // A screenshot call that names docs/ directly.
  for (const match of source.matchAll(/\.screenshot\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    if (argumentsOf(source, open).includes("docs/"))
      found.push(
        `${lineOf(source, match.index)}: screenshot call writes a docs/ path directly`,
      );
  }
  // A docs/ path smuggled through a constant or a joined string.
  for (const match of source.matchAll(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g)) {
    if (match[0].includes("docs/"))
      found.push(`${lineOf(source, match.index)}: docs/ string literal`);
  }
  return found;
}

test("legend-nt8q the guard catches direct and smuggled docs writes", () => {
  assert.deepEqual(violations("const clean = 1;"), []);
  assert.deepEqual(
    violations(
      'await page.screenshot({ path: "docs/design/screenshots/x/y.png" });',
    ),
    [
      "1: screenshot call writes a docs/ path directly",
      "1: docs/ string literal",
    ],
  );
  assert.deepEqual(
    violations('const root = "docs";\nawait page.screenshot({ path: root });'),
    [],
    "a bare docs constant is not a path; only docs/ literals are flagged",
  );
  assert.deepEqual(
    violations(
      'const root = "docs/design/screenshots";\nawait page.screenshot({ path: join(root, "x.png") });',
    ),
    ["1: docs/ string literal"],
  );
});

test("legend-nt8q tracked screenshots are opt-in", () => {
  assert.equal(
    screenshots.captureScreenshotsEnabled({}),
    false,
    "off by default",
  );
  assert.equal(
    screenshots.captureScreenshotsEnabled({ LEGEND_CAPTURE_SCREENSHOTS: "1" }),
    true,
  );
  assert.equal(
    screenshots.captureScreenshotsEnabled({
      LEGEND_CAPTURE_SCREENSHOTS: "true",
    }),
    false,
    "only 1 opts in",
  );
  assert.equal(
    screenshots.screenshotPath("legend-x/state-390-light.png", {}),
    join(
      screenshots.TEST_RESULTS_SCREENSHOT_ROOT,
      "legend-x/state-390-light.png",
    ),
  );
  assert.equal(
    screenshots.screenshotPath("legend-x/state-390-light.png", {
      LEGEND_CAPTURE_SCREENSHOTS: "1",
    }),
    join(screenshots.DOCS_SCREENSHOT_ROOT, "legend-x/state-390-light.png"),
  );
});

test("legend-nt8q no e2e file writes a docs/ path around the helper", () => {
  assert.ok(sources.length > 0, "e2e sources found");
  for (const file of sources) {
    const name = relative(root, file);
    const found = violations(readFileSync(file, "utf8"));
    assert.deepEqual(
      found,
      [],
      `${name} writes tracked screenshot evidence outside e2e/screenshots.ts:\n` +
        `${found.join("\n")}\n` +
        "Pass the path below docs/design/screenshots/ to captureScreenshot() instead",
    );
  }
});
