// Edge & connectivity endpoint contracts (bead legend-diq), consumed by the
// web app's typed client and mock mode; the API validates with the same
// objects (docs/frontend.md, "Typed endpoints and mock mode").
//
// PRD v1.7 §3 F5 (Print Agent, Registri Perangkat, Mode Latihan), §4 Alur F
// (operasional saat internet putus) and EDG-05 (printer/KDS failure detected
// within 30 seconds). Paths are outlet-less on purpose: every request is
// served by the edge node bound to one outlet, which resolves tenant and
// outlet from the verified device credential — never from the client (TEN-02).

import {
  z,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  deviceSchema,
  deviceStatusSchema,
  deviceTypeSchema,
  edgeNodeSchema,
  printJobSchema,
  printJobStatusSchema,
} from "./schemas.ts";

const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };

/** Edge → cloud link as the edge node reports it (PRD §4 Alur F step 1). */
export const cloudLinkSchema = z.enum(["connected", "disconnected"]);
export type CloudLink = z.infer<typeof cloudLinkSchema>;

/**
 * What staff devices need to show offline status (Alur F step 1): the cloud
 * link, the edge node heartbeat, the outbox backlog (PRD §5 Sinkronisasi) and
 * this device's training mode (PRD §3 F5 Mode Latihan).
 */
export const edgeStatusSchema = z.strictObject({
  ...scope,
  cloudLink: cloudLinkSchema,
  edgeNode: edgeNodeSchema.nullable(),
  pendingEventCount: z.number().int().nonnegative(),
  lastSyncedAt: isoDateTimeSchema.nullable(),
  thisDevice: deviceSchema.nullable(),
});
export type EdgeStatus = z.infer<typeof edgeStatusSchema>;

export const getEdgeStatus = defineEndpoint({
  method: "GET",
  path: "/api/edge/status",
  response: dataResponseSchema(edgeStatusSchema),
});

export const printJobListQuerySchema = cursorPageQuerySchema.extend({
  status: printJobStatusSchema.optional(),
});
export type PrintJobListQuery = z.infer<typeof printJobListQuerySchema>;

/** Print Agent queue: receipts, station tickets and shift reports (F5). */
export const listPrintJobs = defineEndpoint({
  method: "GET",
  path: "/api/edge/print-jobs",
  query: printJobListQuerySchema,
  response: cursorPageSchema(printJobSchema),
});

export const printJobParams = z.strictObject({
  printJobId: printJobSchema.shape.id,
});

/** "Cetak ulang": a new job that references the original (F5 Print Agent). */
export const reprintPrintJob = defineEndpoint({
  method: "POST",
  path: "/api/edge/print-jobs/:printJobId/reprint",
  params: printJobParams,
  body: clientInputSchema({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(printJobSchema),
});

/**
 * Retry a failed job: `failed → queued` through `transitionPrintJob`; any
 * other current status is a conflict. The printer is the one in the job.
 */
export const retryPrintJob = defineEndpoint({
  method: "POST",
  path: "/api/edge/print-jobs/:printJobId/retry",
  params: printJobParams,
  body: clientInputSchema({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(printJobSchema),
});

export const deviceListQuerySchema = cursorPageQuerySchema.extend({
  type: deviceTypeSchema.optional(),
  status: deviceStatusSchema.optional(),
});
export type DeviceListQuery = z.infer<typeof deviceListQuerySchema>;

/**
 * Device registry of the outlet served by this edge node (F5 Registri
 * Perangkat). The connectivity kit reads heartbeats to alert supervisors when
 * a printer or KDS stops reporting (EDG-05).
 */
export const listEdgeDevices = defineEndpoint({
  method: "GET",
  path: "/api/edge/devices",
  query: deviceListQuerySchema,
  response: cursorPageSchema(deviceSchema),
});

export const deviceParams = z.strictObject({ deviceId: uuidSchema });

/** Training mode is per device and sandboxed from reports (F5 Mode Latihan). */
export const setDeviceTrainingMode = defineEndpoint({
  method: "PATCH",
  path: "/api/edge/devices/:deviceId/training-mode",
  params: deviceParams,
  body: clientInputSchema({ trainingMode: z.boolean() }),
  response: dataResponseSchema(deviceSchema),
});
