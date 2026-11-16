// Availability of the report mocks follows the API (WS-11, brief 284 T4):
// delivery is served, by_menu and settlement follow their metrics, tax_payable
// by outlet is unsupported, unavailable metrics carry no number, and the
// inventory and purchasing reports show a number for every metric the API has.
// The list-vs-registry drift test is apps/api/src/test/ws11-mock-drift.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as dashboard from "../packages/shared/src/dashboard/index.ts";
import "../apps/web/src/features/ws11-management-home/mock.ts";
import "../apps/web/src/features/ws11-owner-dashboard/mock.ts";
import "../apps/web/src/features/ws11-reports/mock.ts";
import { dispatchMock } from "../apps/web/src/lib/mock/runtime.ts";

const DAY = { startDate: "2026-11-01", endDate: "2026-11-01" };

async function run(code, groupBy, period = DAY) {
  const response = await dispatchMock({
    method: "POST",
    path: "/api/reports/run",
    body: {
      reportCode: code,
      period,
      groupBy: groupBy ? [groupBy] : [],
      filters: [],
      bucket: "total",
      limit: 100,
    },
  });
  return dashboard.reportResultSchema.parse(response.data);
}

const entry = (result, code) =>
  result.availability.find((item) => item.metricCode === code);

describe("report mock availability · brief 284 T4", () => {
  test("historical loyalty reports label active members as a current estimate and keep the same snapshot", async () => {
    const current = await run("loyalty.members", null);
    const historic = await run("loyalty.members", null, {
      startDate: "2026-10-01",
      endDate: "2026-10-31",
    });
    const yesterday = await run("loyalty.members", null, {
      startDate: "2026-10-31",
      endDate: "2026-10-31",
    });
    const active = (result) =>
      result.rows[0].values.find(
        (cell) => cell.metricCode === "active_members",
      );
    assert.equal(historic.period.status, "closed");
    assert.match(
      historic.definitions.find(
        (definition) => definition.code === "active_members",
      ).name,
      /saat ini/,
    );
    assert.equal(entry(historic, "active_members").status, "available");
    assert.equal(active(historic).finality, "estimate");
    assert.deepEqual(active(historic).value, { unit: "count", value: 1_320 });
    assert.deepEqual(active(historic).value, active(current).value);
    assert.deepEqual(active(yesterday).value, active(current).value);
    // This mock supports total buckets only and exposes no comparison field.
    assert.equal(historic.bucket, "total");
    assert.equal("comparison" in active(historic), false);
  });

  test("every delivery report is served", async () => {
    for (const code of [
      "delivery.orders",
      "delivery.channel_sales",
      "delivery.by_menu",
      "delivery.settlement",
    ]) {
      const result = await run(code, null);
      assert.equal(result.reportCode, code);
    }
  });

  test("delivery.by_menu is available by menu item, settlement lacks the channel fee by channel", async () => {
    const byMenu = await run("delivery.by_menu", "menu_item");
    assert.deepEqual(
      byMenu.availability.map((item) => item.status),
      ["available", "available"],
    );
    const split = await run("delivery.settlement", "channel");
    assert.equal(entry(split, "delivery_sales").status, "available");
    assert.equal(entry(split, "payment_fee").status, "unavailable");
    assert.equal(entry(split, "payment_fee").reason, "dimension_not_supported");
    for (const row of split.rows) {
      assert.equal(row.values[1].value, null);
      assert.notEqual(row.values[0].value, null);
    }
    const total = await run("delivery.settlement", null);
    assert.equal(entry(total, "payment_fee").status, "available");
    assert.notEqual(total.rows[0].values[1].value, null);
  });

  test("tax_payable by outlet is unsupported, unsplit it is a number", async () => {
    const split = await run("tax.receivable", "outlet");
    assert.equal(entry(split, "tax_payable").reason, "dimension_not_supported");
    assert.equal(split.rows[0].values[0].value, null);
    const total = await run("tax.receivable", null);
    assert.equal(entry(total, "tax_payable").status, "available");
    assert.equal(total.rows[0].values[0].value.unit, "idr");
  });

  test("a metric the API answers unavailable carries no number", async () => {
    const result = await run("sales.per_pax", null);
    assert.equal(entry(result, "avg_spend_per_pax").reason, "source_not_built");
    const cell = result.rows[0].values.find(
      (item) => item.metricCode === "avg_spend_per_pax",
    );
    assert.equal(cell.value, null);
  });

  test("inventory and purchasing reports show a number for every metric the API has", async () => {
    let checked = 0;
    for (const report of dashboard.reportCatalog.filter((item) =>
      /^(inventory|purchasing)\./.test(item.code),
    )) {
      const result = await run(report.code, null);
      for (const cell of result.rows[0].values) {
        assert.equal(entry(result, cell.metricCode).status, "available");
        assert.notEqual(cell.value, null, `${report.code} ${cell.metricCode}`);
        checked += 1;
      }
    }
    assert.ok(checked >= 12, `checked ${checked}`);
  });
});
