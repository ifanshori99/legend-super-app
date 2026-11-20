// Single metric path guard (WS-11 foundation, bead legend-5wzoc; DECISIONS
// 2026-11-10 point 2). Registry metrics reach a value only through the engine
// (`metrics-query.service.ts`) and the registry in `services/metric-sources/`.
// Outside the accounting domain no file may read journal lines, and no file
// but the engine and `metric-sources/gl.ts` may read `GL_METRIC_SOURCES`.
//
// The three AI helpers below still compute registry metrics from operational
// tables (net_sales from orders, ...). Each family card moves its helper onto
// the engine and removes its line here; INT requires this list to be empty.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

const AI_HELPER_EXCEPTIONS: readonly string[] = [
  "services/ai-metrics/finance.ts",
  "services/ai-metrics/labor.ts",
  "services/ai-metrics/sales.ts",
];

/** Files that read or write journal lines as accounting, not as a metric. */
const ACCOUNTING_DOMAIN = [
  /^db\/schema\//,
  /^services\/accounting-[^/]+\.ts$/,
  /^services\/payroll-gl-consumer\.ts$/,
  // Payroll payout GL (legend-wnkep.5) reads the settle journal it posted to
  // return money to the same bank account: ledger bookkeeping, not a metric.
  /^services\/payroll-payout-gl\.service\.ts$/,
  // Payout setup (legend-hkh57, legend-ijhe3) reads the settle journal to
  // validate the frozen source bank account: ledger bookkeeping, not a metric.
  /^services\/payroll-payout-setup\.ts$/,
  // Payout reconciliation checks posted journal lines for accounting
  // consistency, not registry metrics.
  /^services\/payroll-payout-recon\.service\.ts$/,
  // Payout holds (legend-1184) prove the settle journal debited the frozen
  // payable account before a release: ledger bookkeeping, not a metric.
  /^services\/payroll-payout-gl-holds\.service\.ts$/,
  // Profit share (legend-2ljb) is accounting: it derives distributable net
  // profit straight from the posted journal, which is the ledger of record.
  /^services\/profit-share-net-profit\.ts$/,
];

const ENGINE = "services/metrics-query.service.ts";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (path.endsWith(".ts") && !/\.test\.ts$/.test(path)) {
      out.push(path);
    }
  }
  return out;
}

const files = sourceFiles(SRC)
  .map((path) => relative(SRC, path).split(sep).join("/"))
  .filter((path) => !path.startsWith("test/"));
const text = new Map(files.map((f) => [f, readFileSync(join(SRC, f), "utf8")]));

function filesMatching(pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(text.get(file) ?? ""));
}

describe("metric single path", () => {
  it("lists exactly the three AI helper exceptions, all still present", () => {
    expect([...AI_HELPER_EXCEPTIONS].sort()).toEqual([
      "services/ai-metrics/finance.ts",
      "services/ai-metrics/labor.ts",
      "services/ai-metrics/sales.ts",
    ]);
    for (const file of AI_HELPER_EXCEPTIONS) {
      expect(files, file).toContain(file);
    }
  });

  it("no file outside the engine, accounting and the exceptions reads journal lines", () => {
    const allowed = (file: string) =>
      file === ENGINE ||
      AI_HELPER_EXCEPTIONS.includes(file) ||
      ACCOUNTING_DOMAIN.some((pattern) => pattern.test(file));
    const offenders = filesMatching(/journal_lines|journalLines/).filter(
      (file) => !allowed(file),
    );
    expect(offenders).toEqual([]);
  });

  it("no AI helper outside the three exceptions computes metrics beside the engine", () => {
    const helpers = files.filter(
      (file) =>
        file.startsWith("services/ai-metrics/") &&
        file !== "services/ai-metrics/scope.ts",
    );
    expect(
      helpers.filter((file) => !AI_HELPER_EXCEPTIONS.includes(file)),
    ).toEqual([]);
  });

  it("only the engine, the ledger source module, its table and the route's money check read GL_METRIC_SOURCES", () => {
    const allowed = new Set([
      ENGINE,
      // Money check of the viewer filter only; it reads no figure.
      "routes/metrics.routes.ts",
      "services/metric-sources/gl.ts",
      "services/metrics-gl-sources.ts",
    ]);
    const offenders = filesMatching(/GL_METRIC_SOURCES/).filter(
      (file) => !allowed.has(file),
    );
    expect(offenders).toEqual([]);
  });
});
