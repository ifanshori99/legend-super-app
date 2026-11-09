import { describe, expect, it } from "vitest";
import { METRIC_SOURCE_MODULES } from "../services/metric-sources";
import {
  GL_METRIC_SOURCES,
  NON_GL_MONEY_METRICS,
} from "../services/metrics-gl-sources";

describe("NON_GL_MONEY_METRICS", () => {
  it("does not list menu_gross_margin: it is a menu metric, not a ledger gap", () => {
    expect(NON_GL_MONEY_METRICS).not.toContain("menu_gross_margin");
    expect(GL_METRIC_SOURCES).not.toHaveProperty("menu_gross_margin");
  });

  it("does not list money metrics a registered daily reader serves", () => {
    const dailyServed = new Set(
      METRIC_SOURCE_MODULES.flatMap((module) =>
        module.sources.flatMap((source) =>
          source.kind === "daily" ? [source.code] : [],
        ),
      ),
    );
    for (const code of [
      "stock_value",
      "purchase_total",
      "supplier_due",
      "delivery_sales",
    ]) {
      expect(dailyServed.has(code), `${code} has a daily reader`).toBe(true);
      expect(NON_GL_MONEY_METRICS, code).not.toContain(code);
      expect(GL_METRIC_SOURCES, code).not.toHaveProperty(code);
    }
  });
});
