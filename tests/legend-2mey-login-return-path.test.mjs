// WS-01 (bead legend-2mey, found while reviewing legend-qhh5): the
// /masuk/email, /masuk/google and /masuk/tautan routes must validate `lanjut`
// with the hardened `safeReturnPath`, not the bare shared regex, and the
// post-login "continue" navigation must keep the query of `/wifi?zone=...`.
//
// Assumption: the route files and components import React/TanStack and cannot be
// loaded by plain Node, so those two parts are source-level checks (like other
// root suites). The `safeReturnPath` vectors are real unit tests.
// Lives in tests/ (not apps/web/tests/) because scripts/test.mjs only runs
// tests/*.test.mjs.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { safeReturnPath } from "../apps/web/src/features/ws01-login/flow.ts";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ROUTES = [
  "apps/web/src/routes/_public/masuk.email.tsx",
  "apps/web/src/routes/_public/masuk.google.tsx",
  "apps/web/src/routes/_public/masuk.tautan.tsx",
];
const COMPONENTS = [
  "apps/web/src/features/ws01-login/components/signed-in.tsx",
  "apps/web/src/features/ws01-login/components/verify-link.tsx",
];
// Strip comments so a mention in prose cannot satisfy or break a check.
const code = (path) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("legend-2mey: safeReturnPath refuses what the bare schema lets through", () => {
  test("legend-2mey: open-redirect and API vectors resolve to undefined", () => {
    for (const value of ["//evil.com", "/%2f%2fevil", "/api/x"])
      assert.equal(safeReturnPath(value), undefined, value);
    assert.equal(safeReturnPath("/wifi?zone=abc"), "/wifi?zone=abc");
  });
});

describe("legend-2mey: /masuk/email|google|tautan validate lanjut with safeReturnPath", () => {
  for (const path of ROUTES) {
    test(`legend-2mey: ${path.split("/").pop()} uses safeReturnPath, not returnPathSchema`, () => {
      const src = code(path);
      assert.doesNotMatch(
        src,
        /returnPathSchema/,
        "bare shared regex still used",
      );
      assert.match(
        src,
        /lanjut:[^\n]*safeReturnPath|safeReturnPath[\s\S]*lanjut/,
        "lanjut is not validated by safeReturnPath",
      );
      assert.match(
        src,
        /from "@\/features\/ws01-login\/flow"/,
        "safeReturnPath must come from ws01-login/flow",
      );
    });
  }
});

describe("legend-2mey: continue-after-login keeps the query of /wifi?zone=abc", () => {
  test("legend-2mey: signed-in.tsx does not hand a path-with-query to <Link to>", () => {
    const src = code(COMPONENTS[0]);
    assert.doesNotMatch(
      src,
      /to=\{\s*href\b/,
      "<Link to={href ...}> reads ?zone=abc as part of the path",
    );
    assert.match(
      src,
      /href=\{\s*href\s*\}|navigate\(\{[^}]*\bhref\b/,
      "expected href-based navigation",
    );
  });

  test("legend-2mey: verify-link.tsx navigates with href, not to: returnTo", () => {
    const src = code(COMPONENTS[1]);
    assert.doesNotMatch(
      src,
      /to:\s*returnTo\b/,
      "navigate({ to: returnTo }) drops the query",
    );
    assert.match(
      src,
      /navigate\(\{\s*href:\s*returnTo\b/,
      "expected navigate({ href: returnTo, ... })",
    );
  });
});
