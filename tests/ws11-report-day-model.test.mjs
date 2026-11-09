// Shared report mock day model (WS-11, bead legend-c3uq; PRD v1.7 §3 F36;
// DASH-02, SH-01). The report viewer's runs and the report builder's previews
// both compute from `features/ws11-reports/mock-day-model.ts`. This test pins
// the model's exported values and asserts neither mock re-declares the model,
// so a future change moves the shared module instead of forking a number.
// tests/ws11-report-builder.test.mjs keeps the output parity check.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as model from "../apps/web/src/features/ws11-reports/mock-day-model.ts";
import {
  buildReportRuns,
  buildSalesRuns,
} from "../apps/web/src/features/ws11-reports/mock.ts";
import { buildPreviewResult } from "../apps/web/src/features/ws11-report-builder/mock-preview.ts";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

describe("shared report mock day model · legend-c3uq", () => {
  test("DASH-02: the open business day is the owner board's anchor", () => {
    assert.equal(model.BUSINESS_DATE, "2026-11-01");
    assert.deepEqual(model.BASE_DAY, {
      net: 7_420_000,
      gross: 7_920_000,
      discount: 380_000,
      refund: 120_000,
      tx: 96,
      pax: 148,
      qty: 214,
      voided: 95_000,
    });
    assert.deepEqual(
      model.periodAtoms({
        startDate: model.BUSINESS_DATE,
        endDate: model.BUSINESS_DATE,
      }),
      model.BASE_DAY,
    );
  });

  test("DASH-02: the Monday..Sunday factors reproduce every day atom", () => {
    assert.deepEqual(
      model.WEEKDAY_FACTOR,
      [0.78, 0.82, 0.85, 0.9, 1.15, 1.3, 1],
    );
    // 2026-10-05 is a Monday.
    const days = model.eachDay({
      startDate: "2026-10-05",
      endDate: "2026-10-11",
    });
    assert.equal(days.length, 7);
    days.forEach((day, index) => {
      assert.equal(model.weekdayIndex(day), index);
      const expected = Object.fromEntries(
        model.ATOM_KEYS.map((key) => [
          key,
          Math.round(model.BASE_DAY[key] * model.WEEKDAY_FACTOR[index]),
        ]),
      );
      assert.deepEqual(model.dayAtoms(day), expected);
    });
  });

  test("SH-01: the last full month scales to the books", () => {
    assert.deepEqual(model.LAST_MONTH, {
      start: "2026-10-01",
      end: "2026-10-31",
    });
    assert.equal(model.CLOSED_MONTH_NET_SALES, 412_800_000);
    assert.equal(
      model.periodAtoms({
        startDate: model.LAST_MONTH.start,
        endDate: model.LAST_MONTH.end,
      }).net,
      model.CLOSED_MONTH_NET_SALES,
    );
  });

  test("DASH-02: a largest-remainder split always adds up to the total", () => {
    const parts = model.distribute(7_420_000, [4_150_000, 1_980_000]);
    assert.equal(
      parts.reduce((a, b) => a + b, 0),
      7_420_000,
    );
    assert.deepEqual(model.distribute(0, [1, 2]), [0, 0]);
    assert.deepEqual(model.distribute(5, [0, 0]), [0, 0]);
  });

  test("DASH-02: viewer runs and builder previews both read the shared model", () => {
    const range = {
      startDate: model.BUSINESS_DATE,
      endDate: model.BUSINESS_DATE,
    };
    const run = buildSalesRuns().find(
      (item) =>
        item.reportCode === "sales.daily" &&
        item.groupBy.length === 0 &&
        item.period.startDate === range.startDate &&
        item.period.endDate === range.endDate,
    );
    assert.ok(run, "the viewer serves the open business day");
    const net = run.rows[0].values.find(
      (cell) => cell.metricCode === "net_sales",
    ).value.valueIdr;
    assert.equal(net, model.periodAtoms(range).net);

    const preview = buildPreviewResult({
      metricCodes: ["net_sales"],
      period: range,
      groupBy: [],
      filters: [],
      bucket: "total",
      limit: 100,
    });
    assert.equal(preview.rows[0].values[0].value.valueIdr, net);
  });

  test("legend-c3uq: neither mock re-declares the day model", () => {
    for (const path of [
      "../apps/web/src/features/ws11-reports/mock.ts",
      "../apps/web/src/features/ws11-report-builder/mock-preview.ts",
    ]) {
      const source = readFileSync(here(path), "utf8");
      assert.match(source, /mock-day-model\.ts/, `${path} imports the model`);
      assert.doesNotMatch(source, /const BASE_DAY\b/, path);
      assert.doesNotMatch(source, /const WEEKDAY_FACTOR\b/, path);
      assert.doesNotMatch(source, /CLOSED_MONTH_NET_SALES =/, path);
      assert.doesNotMatch(source, /412_800_000/, path);
    }
  });
  test("legend-iwsrp 6: the day model owns the day_of_week split, summing to the period", () => {
    const range = { startDate: "2026-10-01", endDate: "2026-10-31" };
    const spec = model.splitSpecFor("day_of_week", range);
    assert.ok(spec, "splitSpecFor serves day_of_week");
    assert.deepEqual(spec.values, ["1", "2", "3", "4", "5", "6", "7"]);
    const net = model.distribute(
      model.periodAtoms(range).net,
      spec.weights.net,
    );
    assert.equal(
      net.reduce((a, b) => a + b, 0),
      model.periodAtoms(range).net,
    );
  });

  test("legend-iwsrp 6: the builder previews sales_target and target_achievement_pct", () => {
    const range = {
      startDate: model.BUSINESS_DATE,
      endDate: model.BUSINESS_DATE,
    };
    const preview = buildPreviewResult({
      metricCodes: ["net_sales", "sales_target", "target_achievement_pct"],
      period: range,
      groupBy: [],
      filters: [],
      bucket: "total",
      limit: 100,
    });
    const [net, target, pct] = preview.rows[0].values.map((cell) => cell.value);
    assert.ok(target, "sales_target has a figure");
    assert.equal(target.valueIdr, Math.round(net.valueIdr * 1.05));
    assert.ok(pct, "target_achievement_pct has a figure");
  });

  test("legend-iwsrp 6: the viewer serves the target, weekday and category sales reports", () => {
    const codes = new Set(buildSalesRuns().map((run) => run.reportCode));
    for (const code of ["sales.target", "sales.by_day", "sales.by_category"])
      assert.ok(codes.has(code), `${code} is in the sales runs`);
  });
  test("legend-iwsrp 6: the served reports include traffic and operations", () => {
    const prefixes = new Set(
      buildReportRuns().map((run) => run.reportCode?.split(".")[0]),
    );
    assert.ok(prefixes.has("traffic"), "traffic runs");
    assert.ok(prefixes.has("operations"), "operations runs");
  });
});
