// Domain events of the metric layer. PRD §6/§5 and the WS-11 row of the event
// catalog: `metrics.aggregated` records the daily aggregation run that writes
// metrics_daily. Payloads are the `payload` of the WS-00 event envelope
// (payloadSchemaRef `metrics.aggregated.v1`), never a replacement for it.

import { businessDateSchema, outletIdSchema, z } from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";
import { metricCodeSchema, metricFinalitySchema } from "./schemas.ts";

/**
 * One daily aggregation run for an outlet. `finality` is what the run wrote:
 * `estimate` while the business date is still open, `final` after the day (or
 * the covering accounting period for closed_period_only metrics) closes.
 */
export const metricsAggregatedPayloadSchema = z
  .strictObject({
    outletId: outletIdSchema,
    metricDate: businessDateSchema,
    metricCodes: z.array(metricCodeSchema).min(1).max(200),
    pointsWritten: z
      .number()
      .int()
      .min(0)
      .refine(Number.isSafeInteger, "Expected a safe integer"),
    finality: metricFinalitySchema,
    durationMs: z
      .number()
      .int()
      .min(0)
      .refine(Number.isSafeInteger, "Expected a safe integer"),
    status: z.enum(["succeeded", "failed"]),
    /** Set exactly when status is failed. */
    errorCode: z.string().min(1).max(120).nullable(),
  })
  .superRefine((payload, ctx) => {
    if ((payload.status === "failed") !== (payload.errorCode !== null))
      ctx.addIssue({
        code: "custom",
        message: "errorCode is set exactly when the run failed",
        path: ["errorCode"],
      });
  });
export type MetricsAggregatedPayload = z.infer<
  typeof metricsAggregatedPayloadSchema
>;

/** WS-11 events this contract registers, keyed by catalog name. */
export const METRICS_EVENT_PAYLOAD_SCHEMAS = {
  "metrics.aggregated": metricsAggregatedPayloadSchema,
} as const;

/** Catalog-bound definition: envelope schema validating name, ref and payload. */
export const metricsAggregatedEvent = defineDomainEvent({
  name: "metrics.aggregated",
  payload: metricsAggregatedPayloadSchema,
});
