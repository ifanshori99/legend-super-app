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
  cursorPageMetaSchema,
  cursorPageSchema,
  dataResponseSchema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  outletIdSchema,
  tenantIdSchema,
  uuidSchema,
} from "../core/index.ts";
import { deviceTokenSchema } from "../platform/device-token.ts";
import { defineEndpoint } from "../api/endpoint.ts";
import {
  deviceHeartbeatBodySchema,
  deviceSchema,
  deviceStatusSchema,
  deviceTypeSchema,
  edgeNodeSchema,
  printJobSchema,
  printJobStatusSchema,
  printerStatusViewSchema,
} from "./schemas.ts";

const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };

/** Edge → cloud link as the edge node reports it (PRD §4 Alur F step 1). */
export const cloudLinkSchema = z.enum(["connected", "disconnected"]);
export type CloudLink = z.infer<typeof cloudLinkSchema>;

/**
 * Freshness of the critical catalog streams on this edge (legend-10nex).
 * Founder Q57: a critical stream without a successful sync for over 24 hours
 * holds sales (`salesGate.blocked`) until an owner allows them for a limited
 * time. The cashier warning stays whatever the gate says.
 */
export const catalogFreshnessSchema = z.strictObject({
  /** A critical stream failed since its last success. */
  stale: z.boolean(),
  /** A stale stream fails with a reachable cloud (owner notified). */
  ownerAlarm: z.boolean(),
  /** Cashier text, e.g. "katalog belum diperbarui sejak 08:15"; null when fresh. */
  cashierWarning: z.string().nullable(),
  /** Same as `salesGate.blocked`. */
  salesBlocked: z.boolean(),
  /** Optional: an edge image older than the 24 h sales gate does not send it. */
  salesGate: z
    .strictObject({
      /** Sales are held now (24 h rule hit and no active owner override). */
      blocked: z.boolean(),
      /** The 24 h rule hit, even when an owner override allows selling. */
      stale24h: z.boolean(),
      reason: z
        .enum([
          "CATALOG_STALE_24H",
          "CLOCK_REGRESSED",
          "GATE_UNAVAILABLE",
          "TAX_NOT_SYNCED",
        ])
        .nullable(),
      /** Oldest last success (or tracking start) among the offending streams. */
      staleSince: isoDateTimeSchema.nullable(),
      staleStreams: z.array(z.string()),
      /** Active owner override, if any (who and why stay in the audit log). */
      override: z
        .strictObject({
          grantedAt: isoDateTimeSchema,
          untilAt: isoDateTimeSchema,
        })
        .nullable(),
      /**
       * Promos and vouchers are off on this edge (their data is over 24 hours
       * old or was never synced): sales go at the normal price. The owner
       * override does not change this.
       */
      promoDisabled: z.boolean().optional(),
    })
    .optional(),
  streams: z.record(
    z.string(),
    z.strictObject({
      lastSuccessAt: isoDateTimeSchema.nullable(),
      /** Since the last success; null when it never succeeded. */
      ageMs: z.number().int().nonnegative().nullable(),
      /** Why the latest attempt failed (error code); null when fine. */
      failureReason: z.string().nullable(),
    }),
  ),
});
export type CatalogFreshness = z.infer<typeof catalogFreshnessSchema>;

/**
 * What staff devices need to show offline status (Alur F step 1): the cloud
 * link, the edge node heartbeat, the outbox backlog (PRD §5 Sinkronisasi) and
 * this device's training mode (PRD §3 F5 Mode Latihan). `deviceRegistry` is
 * the edge's replica of the cloud device registry (legend-2lp.7): when it is
 * stale, a device revoked on the cloud may still be accepted here.
 */
export const edgeStatusSchema = z.strictObject({
  ...scope,
  cloudLink: cloudLinkSchema,
  edgeNode: edgeNodeSchema.nullable(),
  pendingEventCount: z.number().int().nonnegative(),
  lastSyncedAt: isoDateTimeSchema.nullable(),
  deviceRegistry: z
    .strictObject({
      /** Last successful pull of the device registry from the cloud. */
      lastPulledAt: isoDateTimeSchema.nullable(),
      stale: z.boolean(),
      /**
       * legend-2lgu: the replica is past its hard limit, so the edge refuses
       * NEW device sessions (running ones continue). Optional: an older edge
       * image does not send it.
       */
      hardStale: z.boolean().optional(),
      /** The hard limit in seconds (EDGE_DEVICE_REGISTRY_MAX_STALE_SECONDS). */
      maxStaleSeconds: z.number().int().positive().optional(),
      /** Receipt sequences the last successful pull refused (legend-zsdd). */
      receiptSequencesRefused: z.number().int().nonnegative().optional(),
      /** Last successful pull that refused at least one; null if never. */
      receiptSequencesRefusedAt: isoDateTimeSchema.nullable().optional(),
      /** legend-yd0h8: the cloud flagged a restored or cloned edge database. */
      receiptRunAlert: z.boolean().optional(),
      /** Last successful pull with the alert; null if never. */
      receiptRunAlertAt: isoDateTimeSchema.nullable().optional(),
      /** legend-sduiq: local runs the last pull retired (cloud no longer lists them). */
      receiptSequencesRetired: z.number().int().nonnegative().optional(),
      /** Last successful pull that retired at least one; null if never. */
      receiptSequencesRetiredAt: isoDateTimeSchema.nullable().optional(),
    })
    // Optional: an edge image older than legend-2lp.7 does not send it; the
    // edge API always does.
    .optional(),
  // Optional for the same reason as `deviceRegistry` (legend-10nex).
  catalogFreshness: catalogFreshnessSchema.optional(),
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

/** Thermal printers of the outlet with their heartbeat status (F5, EDG-05). */
export const listEdgePrinters = defineEndpoint({
  method: "GET",
  path: "/api/edge/printers",
  response: dataResponseSchema(z.array(printerStatusViewSchema)),
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
export const edgeDeviceListQuerySchema = deviceListQuerySchema.extend({
  outletId: outletIdSchema.optional(),
});

export const listEdgeDevices = defineEndpoint({
  method: "GET",
  path: "/api/edge/devices",
  query: edgeDeviceListQuerySchema,
  response: z.object({
    data: z.array(deviceSchema),
    meta: cursorPageMetaSchema.extend({ serverTime: isoDateTimeSchema }),
  }),
});

export const deviceParams = z.strictObject({ deviceId: uuidSchema });

// Cloud device registry (bead legend-165; PRD §3 F5 Registri Perangkat). Back
// office only: `device.registry.manage` (list, enroll, token, training mode)
// and `device.registry.revoke` (revoke) on the device's outlet. The tenant
// always comes from the session, never from the body (TEN-02).

export const outletDeviceListQuerySchema = deviceListQuerySchema.extend({
  outletId: outletIdSchema,
});
export type OutletDeviceListQuery = z.infer<typeof outletDeviceListQuerySchema>;

export const listOutletDevices = defineEndpoint({
  method: "GET",
  path: "/api/devices",
  query: outletDeviceListQuerySchema,
  response: cursorPageSchema(deviceSchema),
});

/**
 * The signed `dv1` device token is shown once, at enrollment or reissue; it is
 * never stored or logged (the registry keeps only `token_issued_at`).
 */
export const deviceWithTokenSchema = z.strictObject({
  device: deviceSchema,
  token: deviceTokenSchema,
});
export type DeviceWithToken = z.infer<typeof deviceWithTokenSchema>;

export const enrollDevice = defineEndpoint({
  method: "POST",
  path: "/api/devices",
  body: clientInputSchema({
    outletId: outletIdSchema,
    type: deviceTypeSchema,
    label: z.string().trim().min(1).max(255),
    stationId: uuidSchema.nullable().optional(),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(deviceWithTokenSchema),
});

/** Reissue: a new token; tokens issued before it stop working. Revoked = conflict. */
export const issueDeviceToken = defineEndpoint({
  method: "POST",
  path: "/api/devices/:deviceId/token",
  params: deviceParams,
  body: clientInputSchema({ idempotencyKey: idempotencyKeySchema }),
  response: dataResponseSchema(deviceWithTokenSchema),
});

/** Terminal (EDG-03): a revoked device never becomes active again. */
export const revokeDevice = defineEndpoint({
  method: "POST",
  path: "/api/devices/:deviceId/revoke",
  params: deviceParams,
  body: clientInputSchema({
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: idempotencyKeySchema,
  }),
  response: dataResponseSchema(deviceSchema),
});

/** Shared name used by the edge device registry panel. */
export const revokeEdgeDevice = revokeDevice;

/**
 * Training mode is per device and sandboxed from reports (F5 Mode Latihan).
 *
 * Security (review legend-cyu.12): a device in training mode keeps its sales
 * out of reports, so the toggle is fraud-sensitive. The API requires
 * `device.registry.manage` (the screen gates on the same code), checks the
 * device belongs to the caller's tenant and outlet, and writes an audit event
 * for every change. A cashier session can never switch its own device.
 */
export const setOutletDeviceTrainingMode = defineEndpoint({
  method: "PATCH",
  path: "/api/devices/:deviceId/training-mode",
  params: deviceParams,
  body: clientInputSchema({ trainingMode: z.boolean() }),
  response: dataResponseSchema(deviceSchema),
});

/**
 * Shared-device mode on/off (legend-f586w). A flagged device needs an
 * acting-staff token on POS, floor and KDS requests. Same guards as training
 * mode: `device.registry.manage`, tenant and outlet scope, audit event.
 */
export const setOutletDeviceSharedMode = defineEndpoint({
  method: "PATCH",
  path: "/api/devices/:deviceId/shared-mode",
  params: deviceParams,
  body: clientInputSchema({ sharedMode: z.boolean() }),
  response: dataResponseSchema(deviceSchema),
});

export const deviceHeartbeatResultSchema = z.strictObject({
  deviceId: uuidSchema,
  serverTime: isoDateTimeSchema,
});
export type DeviceHeartbeatResult = z.infer<typeof deviceHeartbeatResultSchema>;

/** Device -> cloud heartbeat; the device id comes from the verified token. */
export const deviceHeartbeat = defineEndpoint({
  method: "POST",
  path: "/api/devices/heartbeat",
  body: deviceHeartbeatBodySchema,
  response: dataResponseSchema(deviceHeartbeatResultSchema),
});

/** Same heartbeat, served by the outlet's edge node. */
export const edgeDeviceHeartbeat = defineEndpoint({
  method: "POST",
  path: "/api/edge/devices/heartbeat",
  body: deviceHeartbeatBodySchema,
  response: dataResponseSchema(deviceHeartbeatResultSchema),
});
