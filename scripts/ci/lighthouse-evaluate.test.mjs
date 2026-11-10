import assert from "node:assert/strict";
import test from "node:test";
import * as config from "./lighthouse.config.mjs";
import {
  categoryFloors,
  describePlan,
  evaluate,
  formatRow,
  median,
  resolvePath,
  summarizeRuns,
} from "./lighthouse-evaluate.mjs";

const lhr = (performance, lcp) => ({
  categories: { performance: { score: performance } },
  audits: {
    "largest-contentful-paint": { numericValue: lcp },
    "cumulative-layout-shift": { numericValue: 0.01 },
  },
});

test("median picks the middle run and averages an even count", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
  assert.equal(median([1, Number.NaN, 5, undefined]), 3);
});

test("summarizeRuns takes the median of scores and metrics, so one bad run is ignored", () => {
  const summary = summarizeRuns([
    lhr(0.9, 2000),
    lhr(0.4, 9000),
    lhr(0.92, 2200),
  ]);
  assert.equal(summary.categories.performance, 0.9);
  assert.equal(summary.metrics["largest-contentful-paint"], 2200);
});

test("evaluate passes exactly at the threshold", () => {
  const verdict = evaluate(
    {
      categories: { performance: 0.8 },
      metrics: { "largest-contentful-paint": 3500 },
    },
    {
      categories: { performance: 0.8 },
      metrics: { "largest-contentful-paint": 3500 },
    },
  );
  assert.equal(verdict.pass, true);
});

test("evaluate fails a low score and a slow metric, naming both", () => {
  const verdict = evaluate(
    {
      categories: { accessibility: 0.89 },
      metrics: { "total-blocking-time": 401 },
    },
    {
      categories: { accessibility: 0.9 },
      metrics: { "total-blocking-time": 400 },
    },
  );
  assert.equal(verdict.pass, false);
  assert.deepEqual(
    verdict.rows.filter((row) => !row.pass).map((row) => row.id),
    ["accessibility", "total-blocking-time"],
  );
});

test("evaluate fails a threshold whose value was not measured", () => {
  const verdict = evaluate(
    { categories: {}, metrics: { "largest-contentful-paint": Number.NaN } },
    {
      categories: { seo: 0.9 },
      metrics: { "largest-contentful-paint": 3500 },
    },
  );
  assert.equal(verdict.pass, false);
  assert.equal(
    verdict.rows.every((row) => !row.pass),
    true,
  );
});

test("categoryFloors overrides a floor and null removes the category", () => {
  const floors = categoryFloors(
    { performance: 0.8, seo: 0.9 },
    { seo: null, performance: 0.7 },
  );
  assert.deepEqual(floors, { performance: 0.7 });
});

test("formatRow prints category scores as 0-100 and metrics unchanged", () => {
  assert.equal(
    formatRow({
      kind: "category",
      id: "seo",
      actual: 0.915,
      limit: 0.9,
      pass: true,
    }),
    "PASS category seo 92 (min 90)",
  );
  assert.equal(
    formatRow({
      kind: "metric",
      id: "cumulative-layout-shift",
      actual: 0.2,
      limit: 0.1,
      pass: false,
    }),
    "FAIL metric cumulative-layout-shift 0.2 (max 0.1)",
  );
  assert.match(
    formatRow({
      kind: "metric",
      id: "x",
      actual: Number.NaN,
      limit: 1,
      pass: false,
    }),
    /n\/a/,
  );
});

test("resolvePath substitutes and encodes the QR token, and requires one", () => {
  assert.equal(resolvePath("/menu"), "/menu");
  assert.equal(resolvePath("/t/{token}", "v1.a_b-c.d"), "/t/v1.a_b-c.d");
  assert.equal(resolvePath("/t/{token}", "a/b"), "/t/a%2Fb");
  assert.throws(() => resolvePath("/t/{token}"), /needs a table QR token/);
});

test("the shipped budget is well formed", () => {
  assert.equal(
    config.runs % 2,
    1,
    "an odd run count keeps the median a real run",
  );
  for (const value of Object.values(config.categories))
    assert.ok(value > 0 && value <= 1);
  for (const value of Object.values(config.metrics)) assert.ok(value > 0);
  assert.deepEqual(
    config.pages.map((page) => page.path),
    ["/menu", "/t/{token}"],
  );
});

test("describePlan lists both pages, the run count and every threshold", () => {
  const plan = describePlan({
    pages: config.pages,
    runs: 3,
    categories: config.categories,
    metrics: config.metrics,
    ports: config.ports,
    tenantHostname: config.tenantHostname,
    database: "reuse",
  });
  assert.match(plan, /median of 3 runs/);
  assert.match(plan, /\/menu/);
  assert.match(plan, /\/t\/\{token\}/);
  assert.match(plan, /largest-contentful-paint 3500/);
  assert.match(
    plan,
    /table-menu[\s\S]*categories \(min\) performance 80, accessibility 90, best-practices 90\n/,
  );
});
