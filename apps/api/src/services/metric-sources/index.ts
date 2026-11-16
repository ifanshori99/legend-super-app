// Metric source registry (WS-11 foundation, bead legend-5wzoc; contract
// docs/briefs/sub-ws11-foundation-design.md §2.1). Exactly one source per
// registry metric code and at most one split per (ledger metric, dimension).
// A code no family claims resolves to `unavailable` / `source_not_built`, so
// every catalog code always resolves. The registry refuses to load when it is
// inconsistent (`assertRegistry`).

import { reportMetricByCode } from "@starter/shared/dashboard";
import { facilitySources } from "./facility";
import { financeSources } from "./finance";
import { glSources } from "./gl";
import { hrSources } from "./hr";
import { inventoryPurchasingSources } from "./inventory-purchasing";
import { loyaltyCrmSources } from "./loyalty-crm";
import { menuCogsSources } from "./menu-cogs";
import { paymentsTaxSources } from "./payments-tax";
import { reservationDeliverySources } from "./reservation-delivery";
import { salesSources } from "./sales";
import { trafficOperationsSources } from "./traffic-operations";
import {
  readerWritesTotal,
  type DailyMetricReader,
  type MetricSource,
  type MetricSourceFamily,
  type MetricSourceModule,
  type MetricSplitSource,
} from "./types";

export type {
  CurrentMetricReader,
  DailyComputeInput,
  DailyMetricReader,
  DailyMetricValue,
  MetricSource,
  MetricSourceFamily,
  MetricSourceFamilyModule,
  MetricSourceGlModule,
  MetricSourceModule,
  MetricSplitSource,
  Tx,
} from "./types";
export { METRIC_SOURCE_FAMILIES, readerWritesTotal } from "./types";

export const METRIC_SOURCE_MODULES: readonly MetricSourceModule[] = [
  glSources,
  salesSources,
  trafficOperationsSources,
  menuCogsSources,
  paymentsTaxSources,
  inventoryPurchasingSources,
  financeSources,
  loyaltyCrmSources,
  reservationDeliverySources,
  hrSources,
  facilitySources,
];

function splitKey(code: string, dimension: string): string {
  return `${code}\u0000${dimension}`;
}

function checkReader(
  reader: DailyMetricReader,
  owner: string,
  mustWrite: string,
): void {
  if (!reader.metricCodes.includes(mustWrite)) {
    throw new Error(
      `Metric registry: ${owner} reader does not list its own code "${mustWrite}"`,
    );
  }
  for (const code of reader.metricCodes) {
    if (!reportMetricByCode.has(code)) {
      throw new Error(
        `Metric registry: ${owner} reader lists unknown code "${code}"`,
      );
    }
  }
}

/** Row keys a reader writes: its dimensions plus the total when it owns it. */
function writtenDimensions(reader: DailyMetricReader): readonly string[] {
  return [
    ...(readerWritesTotal(reader) ? ["(total)"] : []),
    ...reader.dimensions,
  ];
}

/**
 * Throws when two different readers write the same code in the same dimension
 * (the daily job would then overwrite or delete each other's rows). Readers
 * of one code with disjoint dimensions are fine.
 */
function checkWriterOverlap(
  writers: readonly { label: string; reader: DailyMetricReader }[],
): void {
  const byCode = new Map<
    string,
    { label: string; reader: DailyMetricReader }[]
  >();
  for (const writer of writers)
    for (const code of writer.reader.metricCodes) {
      const list = byCode.get(code) ?? [];
      if (!list.some((entry) => entry.reader === writer.reader))
        list.push(writer);
      byCode.set(code, list);
    }
  for (const [code, list] of byCode)
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const first = list[i]!;
        const second = list[j]!;
        const taken = new Set(writtenDimensions(first.reader));
        if (writtenDimensions(second.reader).some((key) => taken.has(key)))
          throw new Error(
            `Metric registry: code "${code}" is written by two readers, ${first.label} and ${second.label} (same dimension or both write the total row)`,
          );
      }
}

/**
 * Throws when the modules break a registry rule: a code claimed twice, a code
 * missing from the catalog, a unit that does not fit the source kind, a
 * derived source with an unregistered input, a split on a code that is not
 * `gl` (or on a dimension the definition lacks), a reader that does not
 * list the code it writes, two readers that write the same code in the
 * same dimension (or both its total row, `writesTotal`), a `weightCode` that
 * is not a registered daily count of the same reader on an average metric,
 * or a share that is not a percent, whose input is unregistered or not
 * split by its dimension.
 */
export function assertRegistry(
  modules: readonly MetricSourceModule[] = METRIC_SOURCE_MODULES,
): void {
  const sources = new Map<string, MetricSource>();
  const writers: { label: string; reader: DailyMetricReader }[] = [];
  for (const module of modules) {
    for (const source of module.sources) {
      if (sources.has(source.code)) {
        throw new Error(
          `Metric registry: code "${source.code}" is claimed twice`,
        );
      }
      sources.set(source.code, source);
    }
  }

  for (const source of sources.values()) {
    const definition = reportMetricByCode.get(source.code);
    if (!definition) {
      throw new Error(
        `Metric registry: code "${source.code}" is not in the catalog`,
      );
    }
    if (source.kind === "gl") {
      const expected = source.gl.kind === "ratio" ? "percent" : "idr";
      if (definition.unit !== expected) {
        throw new Error(
          `Metric registry: ledger code "${source.code}" is ${definition.unit}, its source needs ${expected}`,
        );
      }
      if (source.gl.kind === "ratio" && source.gl.splitFrom) {
        for (const input of [
          source.gl.splitFrom.numerator,
          source.gl.splitFrom.denominator,
        ])
          if (!reportMetricByCode.has(input))
            throw new Error(
              `Metric registry: ledger percent "${source.code}" splits from unknown code "${input}"`,
            );
      }
    } else if (source.kind === "current") {
      if (definition.aggregation !== "latest")
        throw new Error(
          `Metric registry: current code "${source.code}" must aggregate as latest`,
        );
      for (const dimension of source.reader.dimensions)
        if (!definition.dimensions.includes(dimension))
          throw new Error(
            `Metric registry: "${source.code}" current reader has dimension "${dimension}" the definition lacks`,
          );
    } else if (source.kind === "daily") {
      checkReader(source.reader, `"${source.code}"`, source.code);
      writers.push({ label: `"${source.code}"`, reader: source.reader });
      for (const dimension of source.reader.dimensions) {
        if (!definition.dimensions.includes(dimension)) {
          throw new Error(
            `Metric registry: "${source.code}" reader writes dimension "${dimension}" the definition lacks`,
          );
        }
      }
    } else if (source.kind === "derived") {
      for (const input of [source.numerator, source.denominator]) {
        if (!sources.has(input)) {
          throw new Error(
            `Metric registry: derived "${source.code}" input "${input}" is not registered`,
          );
        }
      }
      if (source.scale === 100 && definition.unit !== "percent") {
        throw new Error(
          `Metric registry: derived "${source.code}" scales by 100 but is ${definition.unit}`,
        );
      }
    }
  }

  for (const source of sources.values())
    if (source.kind === "daily" && source.weightCode !== undefined)
      checkWeight(source, sources);

  const splits = new Set<string>();
  for (const module of modules) {
    for (const split of module.splits) {
      const owner = sources.get(split.code);
      if (owner?.kind !== "gl") {
        throw new Error(
          `Metric registry: split of "${split.code}" needs a ledger (gl) code`,
        );
      }
      const definition = reportMetricByCode.get(split.code);
      if (!definition?.dimensions.includes(split.dimension)) {
        throw new Error(
          `Metric registry: "${split.code}" has no dimension "${split.dimension}"`,
        );
      }
      const key = splitKey(split.code, split.dimension);
      if (splits.has(key)) {
        throw new Error(
          `Metric registry: split "${split.code}" / "${split.dimension}" is claimed twice`,
        );
      }
      splits.add(key);
      checkReader(split.reader, `split "${split.code}"`, split.code);
      writers.push({
        label: `split "${split.code}" / "${split.dimension}"`,
        reader: split.reader,
      });
      if (!split.reader.dimensions.includes(split.dimension)) {
        throw new Error(
          `Metric registry: split "${split.code}" reader does not write "${split.dimension}"`,
        );
      }
    }
  }
  checkWriterOverlap(writers);

  for (const source of sources.values())
    if (source.kind === "share") checkShare(source, sources, splits);
}

/**
 * `weightCode` of an average: a registered `daily` count code written by the
 * same reader, on a metric that aggregates as `average`.
 */
function checkWeight(
  source: Extract<MetricSource, { kind: "daily" }>,
  sources: ReadonlyMap<string, MetricSource>,
): void {
  const weightCode = source.weightCode!;
  const label = `Metric registry: "${source.code}" weight "${weightCode}"`;
  if (reportMetricByCode.get(source.code)?.aggregation !== "average")
    throw new Error(
      `Metric registry: "${source.code}" has a weight but is not an average`,
    );
  const weight = sources.get(weightCode);
  if (!weight) throw new Error(`${label} is not registered`);
  if (weight.kind !== "daily")
    throw new Error(`${label} is not a daily source`);
  if (reportMetricByCode.get(weightCode)?.unit !== "count")
    throw new Error(`${label} is not a count`);
  if (weight.reader !== source.reader)
    throw new Error(`${label} is not written by the same reader`);
}

/**
 * A share is a percent and needs a registered `of` that splits by
 * `dimension`, on a dimension the share's own definition declares (else every query of it would answer
 * `dimension_not_supported`).
 */
function checkShare(
  source: Extract<MetricSource, { kind: "share" }>,
  sources: ReadonlyMap<string, MetricSource>,
  splits: ReadonlySet<string>,
): void {
  const label = `Metric registry: share "${source.code}"`;
  if (reportMetricByCode.get(source.code)?.unit !== "percent")
    throw new Error(`${label} is not a percent`);
  if (
    !reportMetricByCode.get(source.code)?.dimensions.includes(source.dimension)
  )
    throw new Error(
      `${label} is on "${source.dimension}" its definition lacks`,
    );
  const of = sources.get(source.of);
  if (!of) throw new Error(`${label} of "${source.of}" is not registered`);
  const splitsBy =
    of.kind === "daily"
      ? (of.reader.dimensions as readonly string[]).includes(source.dimension)
      : of.kind === "gl" && splits.has(splitKey(source.of, source.dimension));
  if (!splitsBy)
    throw new Error(
      `${label}: "${source.of}" has no "${source.dimension}" split`,
    );
}

assertRegistry();

const sourceByCode: ReadonlyMap<string, MetricSource> = new Map(
  METRIC_SOURCE_MODULES.flatMap((module) =>
    module.sources.map((source): [string, MetricSource] => [
      source.code,
      source,
    ]),
  ),
);

const splitByKey: ReadonlyMap<string, MetricSplitSource> = new Map(
  METRIC_SOURCE_MODULES.flatMap((module) =>
    module.splits.map((split): [string, MetricSplitSource] => [
      splitKey(split.code, split.dimension),
      split,
    ]),
  ),
);

/** The source of a catalog code; an unclaimed code is `source_not_built`. */
export function metricSourceOf(code: string): MetricSource {
  const source = sourceByCode.get(code);
  if (source) return source;
  if (!reportMetricByCode.has(code)) {
    throw new Error(`Metric registry: unknown metric code "${code}"`);
  }
  return { kind: "unavailable", code, reason: "source_not_built" };
}

export function metricSplitOf(
  code: string,
  dimension: MetricSplitSource["dimension"],
): MetricSplitSource | null {
  return splitByKey.get(splitKey(code, dimension)) ?? null;
}

/** Every distinct reader the daily job runs (daily sources and splits). */
export function dailyReaders(): readonly {
  family: MetricSourceFamily | "gl";
  reader: DailyMetricReader;
}[] {
  const seen = new Set<DailyMetricReader>();
  const readers: {
    family: MetricSourceFamily | "gl";
    reader: DailyMetricReader;
  }[] = [];
  for (const module of METRIC_SOURCE_MODULES) {
    const candidates = [
      ...module.sources.flatMap((source) =>
        source.kind === "daily" ? [source.reader] : [],
      ),
      ...module.splits.map((split) => split.reader),
    ];
    for (const reader of candidates) {
      if (seen.has(reader)) continue;
      seen.add(reader);
      readers.push({ family: module.family, reader });
    }
  }
  return readers;
}
