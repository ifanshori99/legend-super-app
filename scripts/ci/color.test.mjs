import { test } from "node:test";
import assert from "node:assert/strict";
import { findRawColors } from "./color.mjs";

test("reports raw CSS colors and palette utilities in UI source", () => {
  const issues = findRawColors(
    "apps/web/src/example.tsx",
    `
    <div className="bg-red-500 text-white hover:border-blue-600" style={{ color: '#abc' }} />
    const css = 'background: rgb(1, 2, 3)';
  `,
  );
  assert.equal(issues.length, 5);
});

test("accepts semantic tokens and palette declarations in the token stylesheet", () => {
  assert.deepEqual(
    findRawColors(
      "apps/web/src/example.tsx",
      '<div className="bg-primary text-foreground" style={{ color: "var(--primary)" }} />',
    ),
    [],
  );
  assert.deepEqual(
    findRawColors(
      "apps/web/src/styles/globals.css",
      ":root {\n  --primary: #bb371e;\n}",
    ),
    [],
  );
});

test("does not exempt raw colors in ordinary stylesheet rules", () => {
  assert.equal(
    findRawColors("apps/web/src/styles/globals.css", ".item { color: #fff; }")
      .length,
    1,
  );
});

test("limits existing legacy exceptions to their exact occurrences", () => {
  const css = "    background: #bb371e22;";
  assert.equal(
    findRawColors("apps/web/src/styles/globals.css", `${css}\n${css}`).length,
    1,
  );
  assert.equal(findRawColors("apps/web/src/other.css", css).length, 1);
});
