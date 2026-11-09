// Metric source registry (WS-11 foundation, bead legend-5wzoc; design §2.1).
// Pure module test: no database. Pins that all catalog codes resolve, the 12
// ledger sources keep kind gl, and `assertRegistry` refuses a broken registry.

import { describe, expect, it } from "vitest";
import {
  reportMetricByCode,
  reportMetricDefinitions,
} from "@starter/shared/dashboard";
import { GL_METRIC_SOURCES } from "../services/metrics-gl-sources";
import {
  METRIC_SOURCE_FAMILIES,
  METRIC_SOURCE_MODULES,
  assertRegistry,
  dailyReaders,
  metricSourceOf,
  metricSplitOf,
  readerWritesTotal,
  type DailyMetricReader,
  type MetricSourceModule,
} from "../services/metric-sources";

const GL_CODES = Object.keys(GL_METRIC_SOURCES);

function readerFor(
  code: string,
  dimensions: DailyMetricReader["dimensions"] = [],
): DailyMetricReader {
  return {
    metricCodes: [code],
    dimensions,
    requiresDailyClose: false,
    compute: async () => [],
  };
}

function moduleOf(
  partial: Pick<MetricSourceModule, "sources" | "splits">,
  family: MetricSourceModule["family"] = "sales",
): MetricSourceModule {
  return { family, ...partial } as MetricSourceModule;
}

const glModule = METRIC_SOURCE_MODULES[0];
const glSource = (code: string) => metricSourceOf(code);

/** First ledger code whose definition has a non-outlet dimension. */
function splittableGlCode(): { code: string; dimension: string } {
  for (const code of GL_CODES) {
    const dimension = reportMetricByCode
      .get(code)
      ?.dimensions.find((key) => key !== "outlet");
    if (dimension) return { code, dimension };
  }
  throw new Error("no ledger metric has a non-outlet dimension");
}

/** First ledger code with two non-outlet dimensions. */
function twiceSplittableGlCode(): {
  code: string;
  first: string;
  second: string;
} {
  for (const code of GL_CODES) {
    const dimensions = (reportMetricByCode.get(code)?.dimensions ?? []).filter(
      (key) => key !== "outlet",
    );
    if (dimensions.length >= 2)
      return { code, first: dimensions[0]!, second: dimensions[1]! };
  }
  throw new Error("no ledger metric has two non-outlet dimensions");
}

describe("metric source registry", () => {
  it("loads: gl module first, then the 10 families in order", () => {
    expect(METRIC_SOURCE_MODULES.map((module) => module.family)).toEqual([
      "gl",
      ...METRIC_SOURCE_FAMILIES,
    ]);
    expect(() => assertRegistry()).not.toThrow();
  });

  it("resolves the 15 ledger metrics to kind gl", () => {
    expect(GL_CODES).toHaveLength(15);
    for (const code of GL_CODES) {
      const source = metricSourceOf(code);
      expect(source.kind).toBe("gl");
      expect(source.code).toBe(code);
    }
  });

  it("resolves every active catalog code", () => {
    const active = reportMetricDefinitions.filter(
      (definition) => definition.status === "active",
    );
    expect(active.length).toBeGreaterThanOrEqual(89);
    for (const definition of active) {
      const source = metricSourceOf(definition.code);
      expect(source.code).toBe(definition.code);
    }
  });

  it("answers source_not_built for every code no module claims", () => {
    const claimed = new Set(
      METRIC_SOURCE_MODULES.flatMap((module) =>
        module.sources.map((source) => source.code),
      ),
    );
    const unclaimed = reportMetricDefinitions.filter(
      (definition) => !claimed.has(definition.code),
    );
    expect(unclaimed.length).toBeGreaterThan(0);
    for (const definition of unclaimed) {
      expect(metricSourceOf(definition.code)).toEqual({
        kind: "unavailable",
        code: definition.code,
        reason: "source_not_built",
      });
    }
    expect(() => metricSourceOf("no_such_metric")).toThrow(/unknown metric/);
  });

  it("returns each daily reader once and a split only when a family claims it", () => {
    const { code, dimension } = splittableGlCode();
    const claimed = METRIC_SOURCE_MODULES.some((module) =>
      module.splits.some(
        (split) => split.code === code && split.dimension === dimension,
      ),
    );
    expect(metricSplitOf(code, dimension) !== null).toBe(claimed);
    const readers = dailyReaders();
    expect(new Set(readers.map((entry) => entry.reader)).size).toBe(
      readers.length,
    );
  });
});

describe("assertRegistry", () => {
  it("accepts the ledger module alone", () => {
    expect(() => assertRegistry([glModule])).not.toThrow();
  });

  it("refuses a code claimed twice", () => {
    const code = GL_CODES[0];
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [{ kind: "unavailable", code, reason: "source_not_built" }],
          splits: [],
        }),
      ]),
    ).toThrow(/claimed twice/);
  });

  it("refuses a code missing from the catalog", () => {
    expect(() =>
      assertRegistry([
        moduleOf({
          sources: [
            {
              kind: "unavailable",
              code: "no_such_metric",
              reason: "source_not_built",
            },
          ],
          splits: [],
        }),
      ]),
    ).toThrow(/not in the catalog/);
  });

  it("refuses a ledger source whose unit does not fit its kind", () => {
    const percentCode = reportMetricDefinitions.find(
      (definition) =>
        definition.unit === "percent" && !GL_CODES.includes(definition.code),
    )!.code;
    expect(() =>
      assertRegistry([
        moduleOf({
          sources: [
            {
              kind: "gl",
              code: percentCode,
              gl: GL_METRIC_SOURCES.net_sales,
            },
          ],
          splits: [],
        }),
      ]),
    ).toThrow(/needs idr/);
  });

  it("refuses a derived source with an unregistered input", () => {
    const percentCode = reportMetricDefinitions.find(
      (definition) =>
        definition.unit === "percent" && !GL_CODES.includes(definition.code),
    )!.code;
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [
            {
              kind: "derived",
              code: percentCode,
              numerator: "net_sales",
              denominator: "no_such_metric",
              scale: 100,
            },
          ],
          splits: [],
        }),
      ]),
    ).toThrow(/not registered/);
    expect(() =>
      assertRegistry([
        moduleOf({
          sources: [
            {
              kind: "derived",
              code: percentCode,
              numerator: "net_sales",
              denominator: "cogs",
              scale: 100,
            },
          ],
          splits: [],
        }),
      ]),
    ).toThrow(/not registered/);
  });

  it("accepts a derived source over registered inputs", () => {
    const percentCode = reportMetricDefinitions.find(
      (definition) =>
        definition.unit === "percent" && !GL_CODES.includes(definition.code),
    )!.code;
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [
            {
              kind: "derived",
              code: percentCode,
              numerator: "cogs",
              denominator: "net_sales",
              scale: 100,
            },
          ],
          splits: [],
        }),
      ]),
    ).not.toThrow();
  });

  it("accepts a split of a ledger metric", () => {
    const { code, dimension } = splittableGlCode();
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [],
          splits: [{ code, dimension, reader: readerFor(code, [dimension]) }],
        }),
      ]),
    ).not.toThrow();
  });

  it("refuses a split on a code that is not a ledger code", () => {
    const code = reportMetricDefinitions.find(
      (definition) =>
        !GL_CODES.includes(definition.code) &&
        definition.dimensions.some((key) => key !== "outlet"),
    )!;
    const dimension = code.dimensions.find((key) => key !== "outlet")!;
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [
            {
              kind: "unavailable",
              code: code.code,
              reason: "source_not_built",
            },
          ],
          splits: [
            {
              code: code.code,
              dimension,
              reader: readerFor(code.code, [dimension]),
            },
          ],
        }),
      ]),
    ).toThrow(/ledger \(gl\) code/);
  });

  it("refuses a split twice, or on a dimension the definition lacks", () => {
    const { code, dimension } = splittableGlCode();
    const split = { code, dimension, reader: readerFor(code, [dimension]) };
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({ sources: [], splits: [split, split] }),
      ]),
    ).toThrow(/claimed twice/);
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [],
          splits: [{ ...split, dimension: "no_such_dimension" }],
        }),
      ]),
    ).toThrow(/no dimension/);
  });

  it("refuses a reader that does not list the code it writes", () => {
    const { code, dimension } = splittableGlCode();
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [],
          splits: [
            { code, dimension, reader: readerFor("cogs_other", [dimension]) },
          ],
        }),
      ]),
    ).toThrow(/does not list its own code|unknown code/);
    expect(glSource(code).kind).toBe("gl");
  });

  it("refuses two readers that write the same code in the same dimension", () => {
    const { code, first, second } = twiceSplittableGlCode();
    const overlapping = readerFor(code, [first, second]);
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [],
          splits: [
            { code, dimension: first, reader: readerFor(code, [first]) },
            { code, dimension: second, reader: overlapping },
          ],
        }),
      ]),
    ).toThrow(
      new RegExp(
        `"${code}" is written by two readers.*split "${code}" / "${first}".*split "${code}" / "${second}"`,
      ),
    );
  });

  it("accepts two readers of one code that write different dimensions", () => {
    const { code, first, second } = twiceSplittableGlCode();
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [],
          splits: [
            { code, dimension: first, reader: readerFor(code, [first]) },
            {
              code,
              dimension: second,
              reader: { ...readerFor(code, [second]), writesTotal: false },
            },
          ],
        }),
      ]),
    ).not.toThrow();
  });

  it("refuses two readers that both write the total row of one code", () => {
    const { code, first, second } = twiceSplittableGlCode();
    const writesTotal = (dimension: string) => ({
      ...readerFor(code, [dimension] as never),
      writesTotal: true,
    });
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [],
          splits: [
            { code, dimension: first, reader: writesTotal(first) },
            { code, dimension: second, reader: writesTotal(second) },
          ],
        }),
      ]),
    ).toThrow(new RegExp(`"${code}" is written by two readers.*total`));
    // Only one of them owns the total: fine.
    expect(() =>
      assertRegistry([
        glModule,
        moduleOf({
          sources: [],
          splits: [
            { code, dimension: first, reader: writesTotal(first) },
            {
              code,
              dimension: second,
              reader: { ...readerFor(code, [second]), writesTotal: false },
            },
          ],
        }),
      ]),
    ).not.toThrow();
  });

  it("registers no two readers that write the same total in the real registry", () => {
    expect(() => assertRegistry()).not.toThrow();
    const owners = new Map<string, number>();
    for (const { reader } of dailyReaders()) {
      if (!readerWritesTotal(reader)) continue;
      for (const code of reader.metricCodes)
        owners.set(code, (owners.get(code) ?? 0) + 1);
    }
    for (const [code, count] of owners) expect(count, code).toBe(1);
  });

  describe("weightCode", () => {
    const average = "avg_dwell_minutes";
    const weight = "closed_session_count";
    const average2 = (
      reader: DailyMetricReader,
      weightCode: string,
      code = average,
    ) => ({ kind: "daily", code, reader, weightCode }) as const;
    const both = (extra: Partial<DailyMetricReader> = {}) => ({
      ...readerFor(average),
      metricCodes: [average, weight],
      ...extra,
    });
    const weightSource = (reader: DailyMetricReader) =>
      ({ kind: "daily", code: weight, reader }) as const;

    it("accepts a registered daily count written by the same reader", () => {
      const reader = both();
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({
            sources: [average2(reader, weight), weightSource(reader)],
            splits: [],
          }),
        ]),
      ).not.toThrow();
    });

    it("refuses an unregistered weight", () => {
      const reader = both();
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({ sources: [average2(reader, weight)], splits: [] }),
        ]),
      ).toThrow(/weight "closed_session_count" is not registered/);
    });

    it("refuses a weight that is not a daily source", () => {
      const reader = both();
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({
            sources: [
              average2(reader, weight),
              { kind: "unavailable", code: weight, reason: "source_not_built" },
            ],
            splits: [],
          }),
        ]),
      ).toThrow(/weight "closed_session_count" is not a daily source/);
    });

    it("refuses a weight whose unit is not count", () => {
      const reader = { ...both(), metricCodes: [average, "gross_sales"] };
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({
            sources: [
              average2(reader, "gross_sales"),
              { kind: "daily", code: "gross_sales", reader },
            ],
            splits: [],
          }),
        ]),
      ).toThrow(/weight "gross_sales" is not a count/);
    });

    it("refuses a weight written by another reader", () => {
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({
            sources: [
              average2(readerFor(average), weight),
              weightSource(readerFor(weight)),
            ],
            splits: [],
          }),
        ]),
      ).toThrow(/weight "closed_session_count" .*same reader/);
    });

    it("refuses a weight on a metric that is not an average", () => {
      const reader = { ...both(), metricCodes: ["gross_sales", weight] };
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({
            sources: [
              average2(reader, weight, "gross_sales"),
              weightSource(reader),
            ],
            splits: [],
          }),
        ]),
      ).toThrow(/"gross_sales" has a weight but is not an average/);
    });
  });

  describe("share sources", () => {
    const share = (dimension: string, of = "menu_sold_qty") =>
      ({
        kind: "share",
        code: "menu_popularity_pct",
        of,
        dimension,
      }) as const;
    const soldQty = (dimensions: DailyMetricReader["dimensions"]) =>
      ({
        kind: "daily",
        code: "menu_sold_qty",
        reader: readerFor("menu_sold_qty", dimensions),
      }) as const;

    it("accepts a share of a registered code split by its dimension", () => {
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({
            sources: [soldQty(["menu_item"]), share("menu_item")],
            splits: [],
          }),
        ]),
      ).not.toThrow();
    });

    it("refuses a share of an unregistered code", () => {
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({ sources: [share("menu_item")], splits: [] }),
        ]),
      ).toThrow(
        /share "menu_popularity_pct" .*"menu_sold_qty" is not registered/,
      );
    });

    it("refuses a share on a dimension its definition lacks", () => {
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({
            sources: [soldQty(["menu_item"]), share("payment_method")],
            splits: [],
          }),
        ]),
      ).toThrow(/share "menu_popularity_pct" .*"payment_method"/);
    });

    it("refuses a share whose metric is not a percent", () => {
      expect(reportMetricByCode.get("refund_amount")?.dimensions).toContain(
        "channel",
      );
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({
            sources: [
              {
                kind: "daily",
                code: "menu_sold_qty",
                reader: readerFor("menu_sold_qty", ["channel"]),
              },
              {
                kind: "share",
                code: "refund_amount",
                of: "menu_sold_qty",
                dimension: "channel",
              },
            ],
            splits: [],
          }),
        ]),
      ).toThrow(/share "refund_amount" .*percent/);
    });

    it("refuses a share whose code has no split by the dimension", () => {
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({
            sources: [soldQty([]), share("menu_item")],
            splits: [],
          }),
        ]),
      ).toThrow(/"menu_sold_qty" has no "menu_item" split/);
      expect(() =>
        assertRegistry([
          glModule,
          moduleOf({ sources: [share("menu_item", "net_sales")], splits: [] }),
        ]),
      ).toThrow(/share "menu_popularity_pct"/);
    });
  });
});
