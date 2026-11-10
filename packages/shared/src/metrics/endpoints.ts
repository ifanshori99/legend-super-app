// HTTP contract of the metric query runtime (PRD v1.7 §5 "Lapisan metrik
// baku", DASH-01/02, SH-02; bead legend-cdta). One endpoint answers dashboards,
// reports, the report builder, Tanya AI and MCP, so every surface reads the
// same numbers for the same period and outlet filter (DASH-02).
//
// GET carries the request as a flat query string: the web client stringifies
// each key (`String(value)`, so arrays arrive comma-separated) and qs-style
// clients send `period[startDate]=` or repeated keys. `normalizeMetricQuery`
// accepts all three and yields the strict `metricQueryRequestSchema` shape.
// The tenant never travels in the query (TEN-02); `outletIds` is a request the
// server intersects with the caller's scope (TEN-03).
//
// Browser- and Node-safe: relative `.ts` imports only.

import { businessDateSchema, outletIdSchema, z } from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  metricBucketSchema,
  metricCodeSchema,
  metricDimensionKeySchema,
  metricQueryRequestSchema,
  metricQueryResponseSchema,
  type MetricQueryRequest,
} from "./schemas.ts";

/**
 * `groupBy=outlet` value of the series holding ledger lines without an outlet
 * (payroll, depreciation, entity-level adjustments). Only a tenant-wide query
 * gets it, so the outlet series plus this one add up to the total (DASH-02).
 */
export const METRIC_ENTITY_LEVEL_OUTLET = "entity_level";
/** Display label of the entity-level series. */
export const METRIC_ENTITY_LEVEL_LABEL = "Tingkat badan usaha";

const csvList = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess((value) => {
    const parts = (Array.isArray(value) ? value : [value])
      .filter((part) => part !== undefined && part !== null)
      .flatMap((part) => String(part).split(","))
      .map((part) => part.trim())
      .filter((part) => part !== "");
    return parts.length === 0 ? undefined : parts;
  }, z.array(item).min(1).max(max));

const queryBoolean = z.preprocess((value) => {
  const single = Array.isArray(value) ? value.at(-1) : value;
  if (single === undefined || single === "") return undefined;
  if (single === true || single === "true" || single === "1") return true;
  if (single === false || single === "false" || single === "0") return false;
  return single;
}, z.boolean().default(false));

/**
 * Flat query of `GET /api/metrics/query`. Same fields and limits as
 * `metricQueryRequestSchema`; dimension `filters` are not part of the GET wire
 * (the service still accepts them from in-process callers such as MCP).
 */
export const metricQueryParamsSchema = z
  .strictObject({
    metricCodes: csvList(metricCodeSchema, 30),
    startDate: businessDateSchema,
    endDate: businessDateSchema,
    bucket: metricBucketSchema.default("total"),
    outletIds: csvList(outletIdSchema, 50).optional(),
    groupBy: metricDimensionKeySchema.optional(),
    comparePrevious: queryBoolean,
    requireFinal: queryBoolean,
  })
  .refine((query) => query.startDate <= query.endDate, {
    message: "startDate must not be after endDate",
    path: ["endDate"],
  });
export type MetricQueryParams = z.input<typeof metricQueryParamsSchema>;

/** Keys a qs-style client may send for the period (`period[startDate]`). */
const PERIOD_KEY = /^period(?:\[|\.)(startDate|endDate)\]?$/;
/** `metricCodes[]` / `metricCodes[0]` → `metricCodes`. */
const ARRAY_KEY = /^([A-Za-z]+)\[\d*\]$/;

/**
 * Folds the accepted wire spellings into the flat params shape: `period[x]`
 * and `period.x` become `x`, indexed array keys collapse to one list, and the
 * report drill-down key `outletId` (METRIC_REPORT_QUERY_KEYS) aliases
 * `outletIds`. Unknown keys are kept so the strict schema still rejects them.
 */
export function normalizeMetricQuery(
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const append = (key: string, value: unknown) => {
    const values = Array.isArray(value) ? value : [value];
    const current = out[key];
    out[key] =
      current === undefined
        ? values.length === 1
          ? values[0]
          : values
        : [...(Array.isArray(current) ? current : [current]), ...values];
  };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "period" && value !== null && typeof value === "object") {
      for (const [inner, innerValue] of Object.entries(value))
        append(inner, innerValue);
      continue;
    }
    const period = PERIOD_KEY.exec(key);
    if (period) {
      append(period[1]!, value);
      continue;
    }
    const array = ARRAY_KEY.exec(key);
    const name = array ? array[1]! : key;
    append(name === "outletId" ? "outletIds" : name, value);
  }
  return out;
}

/** Wire query → the one request shape every caller of the runtime uses. */
export function parseMetricQueryParams(
  raw: Readonly<Record<string, unknown>>,
): MetricQueryRequest {
  const params = metricQueryParamsSchema.parse(normalizeMetricQuery(raw));
  return metricQueryRequestSchema.parse({
    metricCodes: params.metricCodes,
    period: { startDate: params.startDate, endDate: params.endDate },
    bucket: params.bucket,
    ...(params.outletIds ? { outletIds: params.outletIds } : {}),
    ...(params.groupBy ? { groupBy: params.groupBy } : {}),
    comparePrevious: params.comparePrevious,
    requireFinal: params.requireFinal,
  });
}

/**
 * Values of the requested metrics for a period and outlet filter. Money
 * metrics come from the general ledger (posted journal lines); every point
 * carries `finality` (SH-02). Errors: METRIC_NOT_FOUND 404,
 * METRIC_DEFINITION_INACTIVE 409, METRIC_DIMENSION_NOT_SUPPORTED 400,
 * PERIOD_NOT_CLOSED 409 (`requireFinal`), OUTLET_OUT_OF_SCOPE 403.
 */
export const queryMetricsEndpoint = defineEndpoint({
  method: "GET",
  path: "/api/metrics/query",
  query: metricQueryParamsSchema,
  response: metricQueryResponseSchema,
});
