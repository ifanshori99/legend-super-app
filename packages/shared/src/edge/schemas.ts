import {
  z,
  cursorSchema,
  PAGE_LIMIT_MAX,
  uuidSchema,
  ulidSchema,
  tenantIdSchema,
  outletIdSchema,
  isoDateTimeSchema,
  CoreError,
} from "../core/index.ts";
import {
  eventEnvelopeSchema,
  syncDirectionSchema,
  syncCheckpointSchema,
  eventCatalogEntrySchema,
} from "../events/index.ts";
import { receiptPrefixSchema } from "../pos/receipts.ts";

const scope = { tenantId: tenantIdSchema, outletId: outletIdSchema };
const text = z.string().min(1).max(255);
export const deviceTypeSchema = z.enum([
  "pos",
  "kds",
  "waiter_phone",
  "printer",
  "display",
  "smart_lock",
  "panic_button",
  "edc",
]);
export const deviceStatusSchema = z.enum(["active", "revoked"]);
const deviceFields = {
  ...scope,
  id: uuidSchema,
  type: deviceTypeSchema,
  stationId: uuidSchema.nullable(),
  label: text,
  version: text,
  capabilities: z.array(text),
  lastSeenAt: isoDateTimeSchema.nullable(),
  revokedAt: isoDateTimeSchema.nullable(),
  status: deviceStatusSchema,
  trainingMode: z.boolean(),
};
const revocationAgrees = (d: {
  status: z.infer<typeof deviceStatusSchema>;
  revokedAt: string | null;
}) => (d.status === "revoked") === (d.revokedAt !== null);
const revocationAgreesIssue = {
  message: "Revocation status and timestamp must agree",
};
export const deviceSchema = z
  .strictObject(deviceFields)
  .refine(revocationAgrees, revocationAgreesIssue);

/** F5 Registri Perangkat: devices send a heartbeat every 30 seconds. */
export const DEVICE_HEARTBEAT_INTERVAL_SECONDS = 30;
/** No heartbeat for this long = offline (EDG-05; 4 missed beats). */
export const DEVICE_OFFLINE_AFTER_SECONDS = 120;

/**
 * Offline = active and silent for more than DEVICE_OFFLINE_AFTER_SECONDS. A
 * revoked device is never "offline" (it is out of service); an active device
 * that never reported is offline.
 */
export function isDeviceOffline(
  device: {
    status: z.infer<typeof deviceStatusSchema>;
    lastSeenAt: string | null;
  },
  now: Date,
): boolean {
  if (device.status === "revoked") return false;
  if (device.lastSeenAt === null) return true;
  return (
    now.getTime() - new Date(device.lastSeenAt).getTime() >
    DEVICE_OFFLINE_AFTER_SECONDS * 1000
  );
}

/** Device heartbeat body; the device id comes from the verified token only. */
export const deviceHeartbeatBodySchema = z.strictObject({
  version: text,
  capabilities: z.array(text),
  occurredAt: isoDateTimeSchema,
});
export type DeviceHeartbeatBody = z.infer<typeof deviceHeartbeatBodySchema>;

/** Registry row as the cloud replicates it to an edge node (cloud wins). */
export const deviceSyncRecordSchema = z
  .strictObject({
    ...deviceFields,
    updatedAt: isoDateTimeSchema,
    /** Token floor: the edge refuses tokens issued before it (reissue rotates). */
    tokenIssuedAt: isoDateTimeSchema.nullable(),
  })
  .refine(revocationAgrees, revocationAgreesIssue);
export type DeviceSyncRecord = z.infer<typeof deviceSyncRecordSchema>;

/**
 * A device's receipt run as the cloud hands it to the edge (legend-3yqy). The
 * edge inserts a missing row starting at `lastNumber` (so a rebuilt edge never
 * reissues a number) and never touches an existing row: its own counter is
 * ahead of the cloud's.
 */
export const deviceReceiptSequenceSyncSchema = z.strictObject({
  id: uuidSchema,
  outletId: outletIdSchema,
  deviceId: uuidSchema,
  prefix: receiptPrefixSchema,
  lastNumber: z.number().int().min(0).max(999_999_999),
});
export type DeviceReceiptSequenceSync = z.infer<
  typeof deviceReceiptSequenceSyncSchema
>;

export const deviceSyncPageSchema = z.strictObject({
  data: z.array(deviceSyncRecordSchema),
  /**
   * legend-3yqy: every device receipt sequence of the outlet, sent in full on
   * each page (a handful per outlet; no cursor). Optional: older clouds omit it.
   */
  receiptSequences: z.array(deviceReceiptSequenceSyncSchema).optional(),
  meta: z.strictObject({
    limit: z.number().int().min(1).max(PAGE_LIMIT_MAX),
    /** Non-null while more rows follow: request again with `since` = this. */
    nextCursor: cursorSchema.nullable(),
    /** Store after applying the page; null = nothing replicated yet. */
    watermark: cursorSchema.nullable(),
  }),
});
export type DeviceSyncPage = z.infer<typeof deviceSyncPageSchema>;
export const edgeNodeSchema = z.strictObject({
  ...scope,
  id: uuidSchema,
  role: z.enum(["primary", "standby"]),
  version: text,
  lastHeartbeatAt: isoDateTimeSchema.nullable(),
  lastSyncCursor: z.string().min(1).max(1024).nullable(),
});
export const heartbeatSchema = z.strictObject({
  ...scope,
  deviceId: uuidSchema,
  version: text,
  capabilities: z.array(text),
  occurredAt: isoDateTimeSchema,
});
export const revocationListSchema = z
  .strictObject({
    ...scope,
    updatedAt: isoDateTimeSchema,
    devices: z.array(
      z.strictObject({ deviceId: uuidSchema, revokedAt: isoDateTimeSchema }),
    ),
  })
  .refine(
    (list) =>
      new Set(list.devices.map((d) => d.deviceId)).size === list.devices.length,
    { message: "Duplicate revoked device" },
  );
export function canDeviceTransact(
  status: z.infer<typeof deviceStatusSchema>,
): boolean {
  return status === "active";
}
export function transitionDevice(
  status: z.infer<typeof deviceStatusSchema>,
  action: "revoke",
): z.infer<typeof deviceStatusSchema> {
  if (status === "active" && action === "revoke") return "revoked";
  throw new CoreError("CONFLICT", "Transisi perangkat tidak valid.");
}

/** EDG-02: checkpoint advances only after durable idempotent application; consumers order by aggregate sequence. */
export const syncBatchSchema = z
  .strictObject({
    ...scope,
    id: ulidSchema,
    peerId: uuidSchema,
    direction: syncDirectionSchema,
    fromCursor: z.string().min(1).max(1024).nullable(),
    toCursor: z.string().min(1).max(1024),
    events: z.array(eventEnvelopeSchema).min(1),
  })
  .superRefine((batch, ctx) => {
    const ids = new Set<string>();
    for (const event of batch.events) {
      if (
        event.tenantId !== batch.tenantId ||
        event.outletId !== batch.outletId ||
        ids.has(event.id)
      )
        ctx.addIssue({
          code: "custom",
          message: "Events must be unique and belong to the batch scope",
        });
      ids.add(event.id);
    }
  });
export const syncAckSchema = z.strictObject({
  ...scope,
  batchId: ulidSchema,
  peerId: uuidSchema,
  direction: syncDirectionSchema,
  cursor: z.string().min(1).max(1024),
  lastEventId: ulidSchema,
  acknowledgedAt: isoDateTimeSchema,
});
export { syncCheckpointSchema };
export type SyncBatch = z.infer<typeof syncBatchSchema>;
export type SyncAck = z.infer<typeof syncAckSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type EdgeNode = z.infer<typeof edgeNodeSchema>;
export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type RevocationList = z.infer<typeof revocationListSchema>;
export function conflictResolution(
  kind: "master_data" | "transaction_event",
): "cloud_wins" | "append_only" {
  return kind === "master_data" ? "cloud_wins" : "append_only";
}

export const printJobStatusSchema = z.enum([
  "queued",
  "printing",
  "printed",
  "failed",
]);
export const printJobSchema = z.strictObject({
  ...scope,
  id: ulidSchema,
  printerId: uuidSchema,
  kind: z.enum(["receipt", "station_ticket", "shift_report"]),
  format: z.literal("esc_pos"),
  content: z.string().min(1),
  status: printJobStatusSchema,
  createdAt: isoDateTimeSchema,
  reprintOf: ulidSchema.nullable(),
});
type PrintStatus = z.infer<typeof printJobStatusSchema>;
type PrintAction = "start" | "succeed" | "fail" | "retry";
const printTransitions: Partial<
  Record<PrintStatus, Partial<Record<PrintAction, PrintStatus>>>
> = {
  queued: { start: "printing" },
  printing: { succeed: "printed", fail: "failed" },
  failed: { retry: "queued" },
};
export function transitionPrintJob(
  status: PrintStatus,
  action: PrintAction,
): PrintStatus {
  const next = printTransitions[status]?.[action];
  if (!next) throw new CoreError("CONFLICT", "Transisi cetak tidak valid.");
  return next;
}
export type PrintJob = z.infer<typeof printJobSchema>;

export const agentRpcRequestSchema = z.strictObject({
  ...scope,
  id: ulidSchema,
  deviceId: uuidSchema,
  operation: z.enum([
    "edc.transact",
    "edc.cancel",
    "edc.status",
    "wifi.authorize",
    "wifi.revoke",
    "lock.issue",
    "panic.trigger",
  ]),
  idempotencyKey: text,
  requestedAt: isoDateTimeSchema,
  payload: z.record(z.string(), z.unknown()),
});
export const agentRpcResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...scope,
    requestId: ulidSchema,
    status: z.literal("success"),
    result: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    ...scope,
    requestId: ulidSchema,
    status: z.literal("error"),
    error: z.strictObject({ code: text, message: text }),
  }),
]);
export type AgentRpcRequest = z.infer<typeof agentRpcRequestSchema>;
export type AgentRpcResponse = z.infer<typeof agentRpcResponseSchema>;
/** Proposed entries for coordinator registration in the shared catalog. */
export const edgeEventCatalogEntries = [
  "device.registered",
  "device.revoked",
  "print_job.created",
  "sync.batch_applied",
].map((name) =>
  eventCatalogEntrySchema.parse({
    name,
    aggregateType: name.split(".")[0],
    version: 1,
    payloadSchemaRef: `${name}.v1`,
    workstream: "WS-02",
  }),
);
