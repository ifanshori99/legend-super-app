// Pure threshold logic for scripts/ci/lighthouse.mjs, kept free of I/O so
// `node --test` can cover it without Chrome or a database.

/** Median of a non-empty list of numbers (mean of the two middle values when even). */
export function median(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (numbers.length === 0) return NaN;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Reduces Lighthouse results (one per run) to the numbers the budget uses:
 * `categories[id]` is the 0..1 score, `metrics[id]` the numericValue.
 * A category or audit missing from a run is ignored for that run.
 */
export function summarizeRuns(lhrs) {
  const categoryIds = new Set();
  const metricIds = new Set();
  for (const lhr of lhrs) {
    for (const id of Object.keys(lhr.categories ?? {})) categoryIds.add(id);
    for (const id of Object.keys(lhr.audits ?? {})) metricIds.add(id);
  }
  const categories = {};
  for (const id of categoryIds)
    categories[id] = median(lhrs.map((lhr) => lhr.categories?.[id]?.score));
  const metrics = {};
  for (const id of metricIds)
    metrics[id] = median(lhrs.map((lhr) => lhr.audits?.[id]?.numericValue));
  return { categories, metrics };
}

/** Page category floors: the shared ones with the page's overrides; `null` drops a category. */
export function categoryFloors(shared, overrides = {}) {
  const floors = { ...shared };
  for (const [id, value] of Object.entries(overrides)) {
    if (value === null) delete floors[id];
    else floors[id] = value;
  }
  return floors;
}

/**
 * Compares a summary against the budget. A threshold whose value is missing
 * (NaN/undefined) fails: a page that cannot be measured must not pass.
 * Returns one row per check so the runner can print a table.
 */
export function evaluate(summary, { categories, metrics }) {
  const rows = [];
  for (const [id, floor] of Object.entries(categories)) {
    const actual = summary.categories[id];
    rows.push({
      kind: "category",
      id,
      actual,
      limit: floor,
      pass: Number.isFinite(actual) && actual >= floor,
    });
  }
  for (const [id, ceiling] of Object.entries(metrics)) {
    const actual = summary.metrics[id];
    rows.push({
      kind: "metric",
      id,
      actual,
      limit: ceiling,
      pass: Number.isFinite(actual) && actual <= ceiling,
    });
  }
  return { pass: rows.every((row) => row.pass), rows };
}

/** One printable line: `PASS category performance 92 (min 80)`. */
export function formatRow(row) {
  const isCategory = row.kind === "category";
  const scale = (value) => (isCategory ? Math.round(value * 100) : value);
  const actual = Number.isFinite(row.actual)
    ? String(
        isCategory ? scale(row.actual) : Math.round(row.actual * 1000) / 1000,
      )
    : "n/a";
  const limit = String(scale(row.limit));
  return `${row.pass ? "PASS" : "FAIL"} ${row.kind} ${row.id} ${actual} (${isCategory ? "min" : "max"} ${limit})`;
}

/** Replaces `{token}` in a page path. Throws when a path needs a token and none is given. */
export function resolvePath(path, token) {
  if (!path.includes("{token}")) return path;
  if (!token) throw new Error(`Path ${path} needs a table QR token.`);
  return path.replace("{token}", encodeURIComponent(token));
}

/**
 * Human-readable plan printed by `--dry-run`: what would be started, measured
 * and enforced. Pure, so the output is covered by a test.
 */
export function describePlan({
  pages,
  runs,
  categories,
  metrics,
  ports,
  tenantHostname,
  database,
}) {
  const origin = `http://${tenantHostname}:${ports.web}`;
  const lines = [
    "Lighthouse plan (dry run: nothing is started)",
    `1. Database: ${database}`,
    `2. Seed Cafe Legend menu and one table QR (apps/api/src/test/lighthouse-seed.ts)`,
    `3. Start API  node apps/api/dist/server.js            -> http://localhost:${ports.api}`,
    `4. Start web  node apps/web/.output/server/index.mjs  -> http://localhost:${ports.web}`,
    `5. Start Chromium; ${tenantHostname} is mapped to 127.0.0.1 so the tenant resolves by Host`,
    `6. Lighthouse mobile preset, median of ${runs} runs per page:`,
  ];
  for (const page of pages) {
    const floors = categoryFloors(categories, page.categories);
    lines.push(`   - ${page.name}: ${origin}${page.path}`);
    lines.push(
      `     categories (min) ${Object.entries(floors)
        .map(([id, value]) => `${id} ${Math.round(value * 100)}`)
        .join(", ")}`,
    );
  }
  lines.push(
    `   metrics (max) ${Object.entries(metrics)
      .map(([id, value]) => `${id} ${value}`)
      .join(", ")}`,
    "7. Exit 1 when any median is outside its threshold, or a page cannot be measured",
  );
  return lines.join("\n");
}
