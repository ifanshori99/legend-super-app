import { describe, expect, it } from "vitest";
import {
  GL_METRIC_SOURCES,
  NON_GL_MONEY_METRICS,
} from "../services/metrics-gl-sources";

describe("NON_GL_MONEY_METRICS", () => {
  it("does not list menu_gross_margin: it is a menu metric, not a ledger gap", () => {
    expect(NON_GL_MONEY_METRICS).not.toContain("menu_gross_margin");
    expect(GL_METRIC_SOURCES).not.toHaveProperty("menu_gross_margin");
  });
});
