// 1267 F1: the web catalog's "Segera hadir" comes from one shared list. It must
// equal what the server registry answers, code by code, so a source that lands
// (or a gap that opens) fails here instead of misleading the catalog.

import { describe, expect, it } from "vitest";
import {
  METRIC_CODES_WITHOUT_SOURCE,
  reportCatalog,
  reportHasSource,
  reportMetricDefinitions,
} from "@starter/shared/dashboard";
import { metricSourceOf } from "../services/metric-sources";

describe("metric source availability (1267 F1)", () => {
  it("the shared list equals the codes the registry has no source for", () => {
    const unbuilt = reportMetricDefinitions
      .map((definition) => definition.code)
      .filter((code) => metricSourceOf(code).kind === "unavailable")
      .sort();
    expect([...METRIC_CODES_WITHOUT_SOURCE].sort()).toEqual(unbuilt);
  });

  it("gateway_settlement is unbuilt: the payments-tax claim wins, the ledger does not read it", () => {
    expect(metricSourceOf("gateway_settlement").kind).toBe("unavailable");
    expect(METRIC_CODES_WITHOUT_SOURCE).toContain("gateway_settlement");
  });

  it("a report is coming soon only when none of its metrics has a source", () => {
    for (const report of reportCatalog) {
      const anyBuilt = report.metrics.some(
        (code) => metricSourceOf(code).kind !== "unavailable",
      );
      expect(reportHasSource(report), report.code).toBe(anyBuilt);
    }
  });
});
