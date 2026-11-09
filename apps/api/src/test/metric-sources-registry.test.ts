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

describe("metric source registry", () => {
  it("loads: gl module first, then the 10 families in order", () => {
    expect(METRIC_SOURCE_MODULES.map((module) => module.family)).toEqual([
      "gl",
      ...METRIC_SOURCE_FAMILIES,
    ]);
    expect(() => assertRegistry()).not.toThrow();
  });

  it("resolves the 12 ledger metrics to kind gl", () => {
    expect(GL_CODES).toHaveLength(12);
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
});
