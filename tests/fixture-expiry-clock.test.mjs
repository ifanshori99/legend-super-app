import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { FIXTURE_CLOCK_NOW } from "../packages/shared/src/core/fixture-clock.ts";

const sharedRoot = fileURLToPath(
  new URL("../packages/shared/src/", import.meta.url),
);
const expiryFields = new Set([
  "expiresAt",
  "claimableUntil",
  "validUntil",
  "deadline",
]);
const fixtureClockMs = Date.parse(FIXTURE_CLOCK_NOW);

function fixtureFiles(directory, inFixtureDirectory = false) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const isFixture = inFixtureDirectory || entry.name.startsWith("fixtures");
    if (entry.isDirectory()) return fixtureFiles(path, isFixture);
    return isFixture && /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function futureExpiryLiterals(source, fileName = "fixtures.ts") {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations = [];
  function visit(node) {
    const name = ts.isPropertyAssignment(node)
      ? ts.isComputedPropertyName(node.name)
        ? node.name.expression
        : node.name
      : undefined;
    if (
      name &&
      (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) &&
      expiryFields.has(name.text)
    ) {
      function inspectValue(value) {
        if (
          ts.isStringLiteralLike(value) &&
          /^\d{4}-\d{2}-\d{2}T/.test(value.text) &&
          Date.parse(value.text) > fixtureClockMs
        ) {
          const { line } = file.getLineAndCharacterOfPosition(
            value.getStart(file),
          );
          violations.push(
            `${fileName}:${line + 1} ${name.text}: ${value.text}`,
          );
        }
        ts.forEachChild(value, inspectValue);
      }
      inspectValue(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return violations;
}

test("expiry guard handles quoted keys, multiline values and ISO literal syntax", () => {
  const future = "2099-01-01T00:00:00.000Z";
  const source = [
    `({expiresAt: "${future}"})`,
    `({'claimableUntil':\n '${future}'})`,
    `({"validUntil": \`${future}\`})`,
    `({deadline: new Date("${future}").toISOString()})`,
    `({["expiresAt"]: "${future}"})`,
    `({[\`validUntil\`]: "${future}"})`,
  ].join(";\n");
  assert.equal(futureExpiryLiterals(source).length, 6);
  assert.deepEqual(
    futureExpiryLiterals(
      `({expiresAt: "2020-01-01T00:00:00Z", validUntil: "2099-01-01", createdAt: "${future}", deadline: fixtureTimeAfter({days: 1})})`,
    ),
    [],
  );
});

test("the guard discovers fixtures-prefixed files and fixture directory descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "legend-fixture-clock-"));
  try {
    mkdirSync(join(root, "nested", "fixtures-data"), { recursive: true });
    writeFileSync(
      join(root, "fixtures-extra.ts"),
      '({expiresAt: "2099-01-01T00:00:00Z"})',
    );
    writeFileSync(
      join(root, "nested", "fixtures-data", "session.ts"),
      '({deadline: "2099-01-01T00:00:00Z"})',
    );
    writeFileSync(
      join(root, "nested", "other.ts"),
      '({validUntil: "2099-01-01T00:00:00Z"})',
    );
    const files = fixtureFiles(root);
    assert.equal(files.length, 2);
    assert.equal(
      files.flatMap((path) =>
        futureExpiryLiterals(readFileSync(path, "utf8"), path),
      ).length,
      2,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shared fixture expiry dates after the fixture clock are derived from that clock", () => {
  const files = fixtureFiles(sharedRoot);
  assert.ok(files.length > 20, "the guard discovers the shared fixture files");
  const violations = files.flatMap((path) =>
    futureExpiryLiterals(
      readFileSync(path, "utf8"),
      relative(sharedRoot, path),
    ),
  );
  assert.deepEqual(
    violations,
    [],
    "Use fixtureTimeAfter from core/fixture-clock.ts instead of a future ISO literal",
  );
});
