// Metric layer error codes. Declared next to the schemas, like every domain
// contract; the API error handler maps them with metricErrorHttpStatus.

import { z } from "../core/index.ts";

export const metricErrorCodeSchema = z.enum([
  /** No active definition for the requested metric code. */
  "METRIC_NOT_FOUND",
  /** The definition exists but is draft or deprecated. */
  "METRIC_DEFINITION_INACTIVE",
  /** groupBy / filters use a dimension the definition does not declare. */
  "METRIC_DIMENSION_NOT_SUPPORTED",
  /** Official figures requested for a period that is not closed (SH-02). */
  "PERIOD_NOT_CLOSED",
]);
export type MetricErrorCode = z.infer<typeof metricErrorCodeSchema>;

export const metricErrorHttpStatus = {
  METRIC_NOT_FOUND: 404,
  METRIC_DEFINITION_INACTIVE: 409,
  METRIC_DIMENSION_NOT_SUPPORTED: 400,
  PERIOD_NOT_CLOSED: 409,
} as const satisfies Record<MetricErrorCode, number>;

export const METRIC_ERROR_CODES = metricErrorCodeSchema.options;
