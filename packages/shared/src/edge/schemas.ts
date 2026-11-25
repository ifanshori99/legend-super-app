import { hasUnsafeSnapshotFields } from "./snapshot-safety.ts";
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
  sharedMode: z.boolean(),
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

/** Barcode scanner state a KDS device reports (legend-40nvj). */
export const deviceScannerStatusSchema = z.enum(["connected", "disconnected"]);
export type DeviceScannerStatus = z.infer<typeof deviceScannerStatusSchema>;

/**
 * Device heartbeat body; the device id comes from the verified token only.
 * `scanner` is optional so older shells stay valid; `observedAt` is when the
 * shell last saw the scanner state change (the server clamps a time ahead of
 * its own clock to now). A heartbeat without `scanner` leaves the stored state alone.
 */
export const deviceHeartbeatBodySchema = z.strictObject({
  version: text,
  capabilities: z.array(text),
  occurredAt: isoDateTimeSchema,
  scanner: z
    .strictObject({
      status: deviceScannerStatusSchema,
      observedAt: isoDateTimeSchema,
    })
    .optional(),
});
export type DeviceHeartbeatBody = z.infer<typeof deviceHeartbeatBodySchema>;

/** Registry row as the cloud replicates it to an edge node (cloud wins). */
export const deviceSyncRecordSchema = z
  .strictObject({
    ...deviceFields,
    /** Absent = false: records from before shared mode still parse. */
    sharedMode: z.boolean().optional(),
    updatedAt: isoDateTimeSchema,
    /** Token floor: the edge refuses tokens issued before it (reissue rotates). */
    tokenIssuedAt: isoDateTimeSchema.nullable(),
    /**
     * E2 (brief 1269): SHA-256 (hex) of the device's current token; the edge
     * accepts a token only by it. Absent = not asked for, or an older cloud.
     */
    tokenHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .optional(),
  })
  .refine(revocationAgrees, revocationAgreesIssue);
export type DeviceSyncRecord = z.infer<typeof deviceSyncRecordSchema>;

/**
 * A device's receipt run as the cloud hands it to the edge (legend-3yqy,
 * legend-zsdd). A run's counter lives in exactly one database: the row names
 * it (`edgeNodeId` + `edgeInstanceId`, the edge database of that node). The
 * edge inserts a missing row only while the cloud's `lastNumber` is 0 (and at
 * 0), and never touches a kept row: its own counter is ahead of the cloud's.
 * A missing row with `lastNumber` > 0 is refused (S-K1). A rebuilt edge
 * (fresh database, new instance id) or a standby that takes over never
 * continues an old run: the cloud retires it and hands out a new prefix bound
 * to the new database, so a number is never issued twice (legend-zsdd). An
 * edge refuses a sequence whose binding is not its own.
 */
const deviceReceiptSequenceSyncObjectSchema = z.object({
  id: uuidSchema,
  outletId: outletIdSchema,
  deviceId: uuidSchema,
  prefix: receiptPrefixSchema,
  lastNumber: z.number().int().min(0).max(999_999_999),
  /** legend-zsdd: the edge node whose database holds this run's counter. */
  edgeNodeId: uuidSchema,
  /** legend-zsdd: that node's database (changes when the edge is rebuilt). */
  edgeInstanceId: uuidSchema,
});
export const deviceReceiptSequenceSyncSchema = z
  .unknown()
  .refine(
    (value) => !hasUnsafeSnapshotFields(value),
    "Forbidden field or snapshot exceeds inspection limits",
  )
  .pipe(deviceReceiptSequenceSyncObjectSchema);
export type DeviceReceiptSequenceSync = z.infer<
  typeof deviceReceiptSequenceSyncSchema
>;
/** legend-zsdd: which edge database (node + instance) a sequence is bound to. */
export type DeviceReceiptSequenceBinding = {
  edgeNodeId: string;
  edgeInstanceId: string;
};

/**
 * legend-jcby0: most write-offs one pull page carries. The list is the outlet's
 * full list on every page (append-only and rare; no cursor). Past this the
 * cloud sends the newest ones and logs a warning: older rows are already on the
 * edge and never removed, so the newest still arrive; a number not copied keeps
 * Tutup Hari refused (fails closed, never wrong).
 */
export const RECEIPT_WRITEOFF_SYNC_MAX = 1000;

/**
 * legend-jcby0: a receipt number write-off (legend-0hzqw) as the cloud hands it
 * to the edge. Write-offs are created only on the cloud; the edge copies them
 * so its own gap check (Tutup Hari) counts the number as written off. No tenant
 * field: the edge takes it from its own context. The edge inserts a row only
 * when it holds the named run with the same outlet and prefix and the run has
 * reached `sequenceNumber`, and no local receipt carries that number.
 *
 * Known fields are validated per row, and the edge parses the list as a whole:
 * one invalid row refuses the whole list. Unknown fields are discarded.
 */
const deviceReceiptWriteoffSyncObjectSchema = z.object({
  id: uuidSchema,
  outletId: outletIdSchema,
  sequenceId: uuidSchema,
  prefix: receiptPrefixSchema,
  sequenceNumber: z.number().int().min(1).max(999_999_999),
  reason: z.string().min(10).max(500),
  writtenOffBy: uuidSchema,
  createdAt: isoDateTimeSchema,
});
export const deviceReceiptWriteoffSyncSchema = z
  .unknown()
  .refine(
    (value) => !hasUnsafeSnapshotFields(value),
    "Forbidden field or snapshot exceeds inspection limits",
  )
  .pipe(deviceReceiptWriteoffSyncObjectSchema);
export type DeviceReceiptWriteoffSync = z.infer<
  typeof deviceReceiptWriteoffSyncSchema
>;

/**
 * legend-yd0h8: what an edge reports about its own database on a device-records
 * pull: the local counter of every current local device run, `prefix -> last
 * number`. The cloud compares it with a high-water per run to spot a restored
 * or cloned edge database.
 */
export type ReceiptRunReport = ReadonlyMap<string, number>;

/** `P1:150,P3:7` (sorted by prefix); an empty report is `""`. */
export function encodeReceiptRunReport(report: ReceiptRunReport): string {
  return [...report.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([prefix, lastNumber]) => `${prefix}:${lastNumber}`)
    .join(",");
}

const RECEIPT_RUN_REPORT_MAX_ENTRIES = 500;
const RECEIPT_RUN_ENTRY_NUMBER = /^\d{1,9}$/;

/**
 * legend-yd0h8: decodes the `receiptRuns` query param. `""` = the edge holds
 * no run; else `<prefix>:<0..999999999>` entries joined by `,` (max 500, no
 * duplicate prefix). Returns null when the value is malformed.
 */
export function decodeReceiptRunReport(
  value: string,
): Map<string, number> | null {
  const report = new Map<string, number>();
  if (value === "") return report;
  const entries = value.split(",");
  if (entries.length > RECEIPT_RUN_REPORT_MAX_ENTRIES) return null;
  for (const entry of entries) {
    const at = entry.lastIndexOf(":");
    const prefix = at < 0 ? "" : entry.slice(0, at);
    const number = at < 0 ? "" : entry.slice(at + 1);
    if (
      !receiptPrefixSchema.safeParse(prefix).success ||
      !RECEIPT_RUN_ENTRY_NUMBER.test(number) ||
      report.has(prefix)
    )
      return null;
    report.set(prefix, Number(number));
  }
  return report;
}

/**
 * legend-yd0h8: the `receiptRuns` query param, validated but kept as the
 * string (a query schema is parsed twice: route and service), decode it with
 * `decodeReceiptRunReport`.
 */
export const receiptRunReportQuerySchema = z
  .string()
  .max(12_000)
  .refine((value) => decodeReceiptRunReport(value) !== null, {
    message: "Bad receipt run report.",
  });

/**
 * legend-rh1hk: the `receiptRunsSeq` query param, the edge's outbox link cursor
 * (`sync_cursors(edge_to_cloud).next_out_seq`) read BEFORE its `receiptRuns`
 * counters in the same transaction. A decimal string, `0` or up to 15 digits
 * without a leading zero (inside the safe integer range); kept as the string
 * (a query schema is parsed twice), read it with `Number(...)`. Only valid
 * together with `receiptRuns`.
 */
export const receiptRunSeqQuerySchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,14})$/, "Bad receipt run report cursor.");

/**
 * legend-hfq3z: why a primary edge refused a pulled run bound to itself that a
 * new run (new id, new prefix) would fix: its prefix (`prefix_used`) or its id
 * (`id_used`) already exists on another row of this edge database.
 */
export const RECEIPT_RUN_REFUSAL_REASONS = ["prefix_used", "id_used"] as const;
export type ReceiptRunRefusalReason =
  (typeof RECEIPT_RUN_REFUSAL_REASONS)[number];
/**
 * legend-hfq3z: the runs an edge refused on its last pull, `run id -> reason`.
 * Sent on the next pull (`receiptRefused`) so the cloud retires each one and
 * hands the device a new run under a new prefix.
 */
export type ReceiptRunRefusalReport = ReadonlyMap<
  string,
  ReceiptRunRefusalReason
>;

export const RECEIPT_RUN_REFUSAL_MAX_ENTRIES = 50;

/**
 * `<id>:<reason>` entries sorted by id (lowercase), joined by `,`. At most
 * `RECEIPT_RUN_REFUSAL_MAX_ENTRIES` entries, the lowest ids: the rest go on a
 * later pull once these healed (the cloud refuses more than 50 with 400).
 */
export function encodeReceiptRunRefusals(
  report: ReceiptRunRefusalReport,
): string {
  return [...report.entries()]
    .map(([id, reason]) => [id.toLowerCase(), reason] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, RECEIPT_RUN_REFUSAL_MAX_ENTRIES)
    .map(([id, reason]) => `${id}:${reason}`)
    .join(",");
}

/**
 * legend-hfq3z: decodes the `receiptRefused` query param. `""` = nothing
 * refused; else `<uuid>:<reason>` entries joined by `,` (max 50, no duplicate
 * id; ids are lowercased). Returns null when the value is malformed.
 */
export function decodeReceiptRunRefusals(
  value: string,
): Map<string, ReceiptRunRefusalReason> | null {
  const report = new Map<string, ReceiptRunRefusalReason>();
  if (value === "") return report;
  const entries = value.split(",");
  if (entries.length > RECEIPT_RUN_REFUSAL_MAX_ENTRIES) return null;
  for (const entry of entries) {
    const at = entry.indexOf(":");
    if (at < 0) return null;
    const id = entry.slice(0, at).toLowerCase();
    const reason = entry.slice(at + 1);
    if (
      !uuidSchema.safeParse(id).success ||
      !(RECEIPT_RUN_REFUSAL_REASONS as readonly string[]).includes(reason) ||
      report.has(id)
    )
      return null;
    report.set(id, reason as ReceiptRunRefusalReason);
  }
  return report;
}

/**
 * legend-hfq3z: the `receiptRefused` query param, validated but kept as the
 * string; decode it with `decodeReceiptRunRefusals`.
 */
export const receiptRunRefusalQuerySchema = z
  .string()
  .max(4_000)
  .refine((value) => decodeReceiptRunRefusals(value) !== null, {
    message: "Bad receipt run refusal report.",
  });

const deviceSyncPageObjectSchema = z.object({
  data: z.array(deviceSyncRecordSchema),
  /**
   * legend-3yqy: every device receipt sequence of the outlet, sent in full on
   * each page (a handful per outlet; no cursor). Optional: older clouds omit
   * it, and the cloud adds it only for `?receiptSequences=1` (S-K1). The edge
   * parses it apart from the page, so a bad list never refuses the page.
   */
  receiptSequences: z.array(deviceReceiptSequenceSyncSchema).optional(),
  /**
   * legend-jcby0: the outlet's receipt number write-offs (listed oldest first;
   * past `RECEIPT_WRITEOFF_SYNC_MAX` the newest ones), sent on each page. The
   * edge applies the list once per pull. Left out when the cloud read failed.
   * Optional: the cloud adds it only for `?receiptWriteoffs=1`. The edge parses
   * it apart from the page, so a bad list never refuses the page.
   */
  receiptWriteoffs: z
    .array(deviceReceiptWriteoffSyncSchema)
    .max(RECEIPT_WRITEOFF_SYNC_MAX)
    .optional(),
  /**
   * legend-yd0h8: `true` when the cloud suspects a restored or cloned edge
   * database on this node (repeated regressions). Sent only to an edge that
   * sent `receiptRuns` (older edges parse pages strictly). The edge parses it
   * apart from the page, so it never refuses the page.
   */
  receiptRunAlert: z.literal(true).optional(),
  meta: z.object({
    limit: z.number().int().min(1).max(PAGE_LIMIT_MAX),
    /** Non-null while more rows follow: request again with `since` = this. */
    nextCursor: cursorSchema.nullable(),
    /** Store after applying the page; null = nothing replicated yet. */
    watermark: cursorSchema.nullable(),
  }),
});
/** Validate cloud output without silently dropping unintended fields. */
export const deviceSyncCloudPageSchema = deviceSyncPageObjectSchema
  .extend({
    data: z.array(deviceSyncRecordSchema.strict()),
    receiptSequences: z
      .array(deviceReceiptSequenceSyncObjectSchema.strict())
      .optional(),
    receiptWriteoffs: z
      .array(deviceReceiptWriteoffSyncObjectSchema.strict())
      .max(RECEIPT_WRITEOFF_SYNC_MAX)
      .optional(),
    meta: deviceSyncPageObjectSchema.shape.meta.strict(),
  })
  .strict();
export const deviceSyncPageSchema = z
  .unknown()
  .refine((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return !hasUnsafeSnapshotFields(value);
    const envelope = Object.fromEntries(
      Object.entries(value).filter(
        ([key]) =>
          !["data", "receiptSequences", "receiptWriteoffs"].includes(key),
      ),
    );
    return !hasUnsafeSnapshotFields(envelope);
  })
  .pipe(deviceSyncPageObjectSchema);
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
  // null when the caller may not see the bytes
  content: z.string().min(1).nullable(),
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

/** Printer + heartbeat status as the supervisor sees it (F5 Print Agent, EDG-05). */
export const printerStatusViewSchema = z.strictObject({
  ...scope,
  id: uuidSchema,
  label: text,
  role: z.enum(["receipt", "station"]),
  stationId: uuidSchema.nullable(),
  status: z.enum(["unknown", "online", "offline"]),
  lastSeenAt: isoDateTimeSchema.nullable(),
  offlineSince: isoDateTimeSchema.nullable(),
  fallbackPrinterId: uuidSchema.nullable(),
});
export type PrinterStatusView = z.infer<typeof printerStatusViewSchema>;

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
