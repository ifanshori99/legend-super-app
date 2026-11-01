// Domain events of the dashboard & report layer (WS-11). `report.generated`
// is registered in the WS-00 event catalog (`events/catalog.ts`, WS-11 line);
// payloads are the `payload` of the event envelope (payloadSchemaRef
// `report.generated.v1`), never a replacement for it.
//
// A run that fails is audited, not published: the event means a report result
// or export file exists. `containsPersonalData` stays on the payload so an
// export of personal data is traceable in the event stream (DASH-04) even
// though the audit log carries the full actor trail.

import { businessDateSchema, outletIdSchema, z } from "../core/index.ts";
import { defineDomainEvent } from "../events/index.ts";
import { metricFinalitySchema, reportCodeSchema } from "../metrics/index.ts";
import { reportExportIdSchema, savedReportIdSchema } from "./ids.ts";

export const REPORT_RUN_TRIGGERS = ["manual", "scheduled", "export"] as const;
export const reportRunTriggerSchema = z.enum(REPORT_RUN_TRIGGERS);
export type ReportRunTrigger = z.infer<typeof reportRunTriggerSchema>;

export const REPORT_RUN_FORMATS = ["screen", "csv", "xlsx", "pdf"] as const;
export const reportRunFormatSchema = z.enum(REPORT_RUN_FORMATS);
export type ReportRunFormat = z.infer<typeof reportRunFormatSchema>;

export const reportGeneratedPayloadSchema = z
  .strictObject({
    reportCode: reportCodeSchema,
    trigger: reportRunTriggerSchema,
    format: reportRunFormatSchema,
    period: z.strictObject({
      startDate: businessDateSchema,
      endDate: businessDateSchema,
    }),
    /** Outlets the run covered, after the TEN-03 scope check. */
    outletIds: z.array(outletIdSchema).min(1).max(50),
    rowCount: z
      .number()
      .int()
      .min(0)
      .refine(Number.isSafeInteger, "Expected a safe integer"),
    /** True when the output identifies people; exports then needed approval. */
    containsPersonalData: z.boolean(),
    /** Finality of the reported values (SH-02). */
    finality: metricFinalitySchema,
    savedReportId: savedReportIdSchema.nullable(),
    exportId: reportExportIdSchema.nullable(),
    durationMs: z
      .number()
      .int()
      .min(0)
      .refine(Number.isSafeInteger, "Expected a safe integer"),
  })
  .superRefine((payload, ctx) => {
    if (payload.period.startDate > payload.period.endDate)
      ctx.addIssue({
        code: "custom",
        message: "startDate must not be after endDate",
        path: ["period", "endDate"],
      });
    // A screen run is always a manual view; scheduled runs deliver a file.
    if ((payload.trigger === "manual") !== (payload.format === "screen"))
      ctx.addIssue({
        code: "custom",
        message:
          "Only manual runs render to screen; scheduled runs send a file",
        path: ["format"],
      });
    if ((payload.trigger === "export") !== (payload.exportId !== null))
      ctx.addIssue({
        code: "custom",
        message: "exportId is set exactly when the trigger is an export",
        path: ["exportId"],
      });
    if (payload.trigger === "scheduled" && payload.savedReportId === null)
      ctx.addIssue({
        code: "custom",
        message: "A scheduled run belongs to a saved report",
        path: ["savedReportId"],
      });
    // DASH-04: schedules never deliver personal data (reportScheduleGate).
    if (payload.trigger === "scheduled" && payload.containsPersonalData)
      ctx.addIssue({
        code: "custom",
        message: "A scheduled delivery cannot contain personal data (DASH-04)",
        path: ["containsPersonalData"],
      });
  });
export type ReportGeneratedPayload = z.infer<
  typeof reportGeneratedPayloadSchema
>;

/** WS-11 events this contract registers, keyed by catalog name. */
export const DASHBOARD_EVENT_PAYLOAD_SCHEMAS = {
  "report.generated": reportGeneratedPayloadSchema,
} as const;

/** Catalog-bound definition: envelope schema validating name, ref and payload. */
export const reportGeneratedEvent = defineDomainEvent({
  name: "report.generated",
  payload: reportGeneratedPayloadSchema,
});

export const DASHBOARD_EVENTS = {
  "report.generated": reportGeneratedEvent,
} as const;
export type DashboardEventName = keyof typeof DASHBOARD_EVENTS;
