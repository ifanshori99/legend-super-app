// Daily operations contracts (bead legend-ptd8, PRD v1.7 §3 F45 "Operasional
// Harian", §6 L). Covers checklist templates and runs (photo/number/signature
// evidence), food-safety temperature logs with thresholds, prep labels, the
// daily prep list, the equipment registry with service schedules and breakdown
// tickets, and shift handovers.
//
// Conventions follow docs/plan/contracts.md: tenant/outlet scope, money as
// BIGINT rupiah (`…Idr`, whole safe integer), NUMERIC(14,4) readings and
// quantities (`Decimal4`, decimal string), UUID ids (§6), and state only
// through the typed machines in `machines.ts`. Client requests never carry
// tenant/outlet trust: `tenantId` is rejected by clientInputSchema (TEN-02);
// `outletId` is client input that the server checks against the caller's
// outlet scope (TEN-03).

import {
  businessDateSchema,
  decimal4Schema,
  idrSchema,
  isoDateTimeSchema,
  outletIdSchema,
  parseDecimal4,
  tenantIdSchema,
  timeOfDaySchema,
  userIdSchema,
  uuidIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import type { Decimal4 } from "../core/index.ts";
import { roleIdSchema, stationIdSchema } from "../access/ids.ts";
import { fixedAssetIdSchema } from "../accounting/ids.ts";
import { shiftTemplateIdSchema } from "../hris/ids.ts";
import {
  inventoryItemIdSchema,
  productionOrderIdSchema,
  stockBatchIdSchema,
} from "../inventory/index.ts";
import { floorZoneIdSchema } from "../qr-order/schemas.ts";

// ---- Ids ------------------------------------------------------------------

/** PRD §6 L tables are UUID-keyed. The `ops` prefix keeps the brand distinct
 * from the HRIS onboarding checklist (also named `checklist_templates` in §6 H),
 * which is a different aggregate with its own lifecycle. */
export const opsChecklistTemplateIdSchema =
  uuidIdSchema<"OpsChecklistTemplateId">();
export const opsChecklistItemIdSchema = uuidIdSchema<"OpsChecklistItemId">();
export const opsChecklistRunIdSchema = uuidIdSchema<"OpsChecklistRunId">();
export const temperatureLogIdSchema = uuidIdSchema<"TemperatureLogId">();
export const prepLabelIdSchema = uuidIdSchema<"PrepLabelId">();
export const prepListIdSchema = uuidIdSchema<"PrepListId">();
export const prepListItemIdSchema = uuidIdSchema<"PrepListItemId">();
export const equipmentIdSchema = uuidIdSchema<"EquipmentId">();
export const maintenanceScheduleIdSchema =
  uuidIdSchema<"MaintenanceScheduleId">();
export const maintenanceTicketIdSchema = uuidIdSchema<"MaintenanceTicketId">();
/** §6 `maintenance_tickets.vendor_id`; the vendor registry itself is a later
 * contract (there is no vendor table in §6 L). */
export const maintenanceVendorIdSchema = uuidIdSchema<"MaintenanceVendorId">();
export const shiftHandoverIdSchema = uuidIdSchema<"ShiftHandoverId">();

export type OpsChecklistTemplateId = z.infer<
  typeof opsChecklistTemplateIdSchema
>;
export type OpsChecklistItemId = z.infer<typeof opsChecklistItemIdSchema>;
export type OpsChecklistRunId = z.infer<typeof opsChecklistRunIdSchema>;
export type TemperatureLogId = z.infer<typeof temperatureLogIdSchema>;
export type PrepLabelId = z.infer<typeof prepLabelIdSchema>;
export type PrepListId = z.infer<typeof prepListIdSchema>;
export type EquipmentId = z.infer<typeof equipmentIdSchema>;
export type MaintenanceScheduleId = z.infer<typeof maintenanceScheduleIdSchema>;
export type MaintenanceTicketId = z.infer<typeof maintenanceTicketIdSchema>;
export type ShiftHandoverId = z.infer<typeof shiftHandoverIdSchema>;

// ---- Shared field refinements --------------------------------------------

const label = z.string().trim().min(1).max(300);
const description = z.string().trim().min(1).max(1000);
const shortNote = z.string().trim().min(1).max(500);

export const positiveDecimal4Schema = decimal4Schema.refine(
  (value) => parseDecimal4(value) > 0n,
  "Quantity must be greater than zero",
);
export const nonnegativeIdrSchema = idrSchema.refine(
  (value) => value >= 0,
  "Amount must not be negative",
);

// ---- Checklist templates (PRD §6 L `checklist_templates`) ----------------

/** §6 L: `opening` / `closing` / `cleaning` / `shift`. */
export const checklistTemplateTypeSchema = z.enum([
  "opening",
  "closing",
  "cleaning",
  "shift",
]);
export type ChecklistTemplateType = z.infer<typeof checklistTemplateTypeSchema>;

/** Evidence a checklist item requires before it can be marked done (PRD §3
 * F45: "dapat mewajibkan foto, angka, atau tanda tangan digital"). An empty
 * list means a simple done/not-done check. */
export const checklistEvidenceKindSchema = z.enum([
  "photo",
  "number",
  "signature",
]);
export type ChecklistEvidenceKind = z.infer<typeof checklistEvidenceKindSchema>;

export const checklistItemSchema = z
  .strictObject({
    id: opsChecklistItemIdSchema,
    label,
    instruction: description.nullable(),
    requiredEvidence: z.array(checklistEvidenceKindSchema).max(3),
  })
  .superRefine((item, ctx) => {
    if (new Set(item.requiredEvidence).size !== item.requiredEvidence.length)
      ctx.addIssue({
        code: "custom",
        path: ["requiredEvidence"],
        message: "Evidence kinds must be unique",
      });
  });
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

/** When and where a template runs: per shift, station and zone (PRD §3 F45).
 * `dueTime` is outlet-local (`HH:mm`); the server combines it with the run's
 * business date and outlet time zone to derive `dueAt`. */
export const checklistScheduleSchema = z.strictObject({
  shiftTemplateId: shiftTemplateIdSchema.nullable(),
  stationId: stationIdSchema.nullable(),
  zoneId: floorZoneIdSchema.nullable(),
  dueTime: timeOfDaySchema,
});
export type ChecklistSchedule = z.infer<typeof checklistScheduleSchema>;

export const checklistTemplateSchema = z
  .strictObject({
    id: opsChecklistTemplateIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    name: z.string().trim().min(1).max(150),
    type: checklistTemplateTypeSchema,
    items: z.array(checklistItemSchema).min(1).max(100),
    schedule: checklistScheduleSchema,
    /** The role the run is assigned to; a run names the employee. */
    roleId: roleIdSchema.nullable(),
    updatedAt: isoDateTimeSchema,
  })
  .superRefine((template, ctx) => {
    if (
      new Set(template.items.map((item) => item.id)).size !==
      template.items.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "Checklist item ids must be unique",
      });
  });
export type ChecklistTemplate = z.infer<typeof checklistTemplateSchema>;

// ---- Checklist runs (PRD §6 L `checklist_runs`) --------------------------

/** §6 L statuses. Transitions live in `machines.ts`. */
export const checklistRunStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "missed",
  "failed",
]);
export type ChecklistRunStatus = z.infer<typeof checklistRunStatusSchema>;

export const checklistItemResultStatusSchema = z.enum([
  "pending",
  "done",
  "failed",
]);
export type ChecklistItemResultStatus = z.infer<
  typeof checklistItemResultStatusSchema
>;

/** One answer in `checklist_runs.results` (JSONB). `completedAt` and
 * `completedBy` are server-set; the client sends the evidence only. */
export const checklistItemResultSchema = z
  .strictObject({
    itemId: opsChecklistItemIdSchema,
    status: checklistItemResultStatusSchema,
    /** Required by items whose `requiredEvidence` includes `number`. */
    numberValue: decimal4Schema.nullable(),
    note: shortNote.nullable(),
    /** Required by items whose `requiredEvidence` includes `photo`. */
    photoMediaIds: z.array(uuidSchema).max(10),
    /** Required by items whose `requiredEvidence` includes `signature`. */
    signatureMediaId: uuidSchema.nullable(),
    completedAt: isoDateTimeSchema.nullable(),
    completedBy: userIdSchema.nullable(),
  })
  .superRefine((result, ctx) => {
    if (new Set(result.photoMediaIds).size !== result.photoMediaIds.length)
      ctx.addIssue({
        code: "custom",
        path: ["photoMediaIds"],
        message: "Photo media ids must be unique",
      });
    const finished = result.status === "done" || result.status === "failed";
    if (finished !== (result.completedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A finished result carries its completion time",
      });
    if (finished !== (result.completedBy !== null))
      ctx.addIssue({
        code: "custom",
        path: ["completedBy"],
        message: "A finished result carries its author",
      });
  });
export type ChecklistItemResult = z.infer<typeof checklistItemResultSchema>;

export const checklistRunSchema = z
  .strictObject({
    id: opsChecklistRunIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    templateId: opsChecklistTemplateIdSchema,
    /** Business date in the outlet time zone (D-CORE-6). */
    shiftDate: businessDateSchema,
    shiftTemplateId: shiftTemplateIdSchema.nullable(),
    assignedTo: userIdSchema,
    dueAt: isoDateTimeSchema,
    completedAt: isoDateTimeSchema.nullable(),
    status: checklistRunStatusSchema,
    results: z.array(checklistItemResultSchema),
  })
  .superRefine((run, ctx) => {
    if (
      new Set(run.results.map((result) => result.itemId)).size !==
      run.results.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["results"],
        message: "One result per checklist item",
      });
    const finished = run.status === "completed" || run.status === "failed";
    if (finished !== (run.completedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "A completed or failed run carries its completion time",
      });
  });
export type ChecklistRun = z.infer<typeof checklistRunSchema>;

// ---- Temperature logs (PRD §6 L `temperature_logs`) ----------------------

/** Per-equipment threshold ("ambang suhu", PRD §3 F45 / A24). Inclusive:
 * a reading equal to a bound is in range. */
export const temperatureThresholdSchema = z
  .strictObject({
    minCelsius: decimal4Schema,
    maxCelsius: decimal4Schema,
  })
  .refine(
    (threshold) => {
      return (
        parseDecimal4(threshold.minCelsius) <
        parseDecimal4(threshold.maxCelsius)
      );
    },
    {
      path: ["maxCelsius"],
      message: "maxCelsius must be greater than minCelsius",
    },
  );
export type TemperatureThreshold = z.infer<typeof temperatureThresholdSchema>;

/** PRD §6 L `temperature_logs`. `inRange` is derived by the server from the
 * equipment threshold at record time and stored, so history keeps the verdict
 * even if the threshold changes later. */
export const temperatureLogSchema = z
  .strictObject({
    id: temperatureLogIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    equipmentId: equipmentIdSchema,
    readingCelsius: decimal4Schema,
    recordedAt: isoDateTimeSchema,
    recordedBy: userIdSchema,
    inRange: z.boolean(),
    /** OPS-02: mandatory exactly when `inRange` is false. */
    correctiveAction: description.nullable(),
  })
  .superRefine((log, ctx) => {
    if (!log.inRange && log.correctiveAction === null)
      ctx.addIssue({
        code: "custom",
        path: ["correctiveAction"],
        message: "Out-of-range readings need a corrective action (OPS-02)",
      });
    if (log.inRange && log.correctiveAction !== null)
      ctx.addIssue({
        code: "custom",
        path: ["correctiveAction"],
        message: "An in-range reading has no corrective action",
      });
  });
export type TemperatureLog = z.infer<typeof temperatureLogSchema>;

// ---- Prep labels and prep lists (PRD §6 L) -------------------------------

/** PRD §3 F45: name, production date/time, use-by and the person in charge,
 * linked to the inventory batch. */
export const prepLabelSchema = z
  .strictObject({
    id: prepLabelIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    inventoryItemId: inventoryItemIdSchema,
    batchId: stockBatchIdSchema,
    producedAt: isoDateTimeSchema,
    useBy: isoDateTimeSchema,
    producedBy: userIdSchema,
    printedAt: isoDateTimeSchema.nullable(),
  })
  .refine(
    (prepLabel) =>
      Date.parse(prepLabel.useBy) > Date.parse(prepLabel.producedAt),
    {
      path: ["useBy"],
      message: "useBy must be after producedAt (OPS-03)",
    },
  );
export type PrepLabel = z.infer<typeof prepLabelSchema>;

export const prepListStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
]);
export type PrepListStatus = z.infer<typeof prepListStatusSchema>;

/** One semi-finished item to prepare; once produced it points at the
 * production batch that recorded the result (PRD §3 F45). */
export const prepListLineSchema = z.strictObject({
  id: prepListItemIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  plannedQuantity: positiveDecimal4Schema,
  productionOrderId: productionOrderIdSchema.nullable(),
});
export type PrepListLine = z.infer<typeof prepListLineSchema>;

/** PRD §6 L `prep_lists`: lines computed from the AI-07 sales forecast,
 * recipes and stock. `generatedFromForecastId` points at that forecast job;
 * the forecast contract itself belongs to WS-12. */
export const prepListSchema = z
  .strictObject({
    id: prepListIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    prepDate: businessDateSchema,
    lines: z.array(prepListLineSchema).min(1),
    status: prepListStatusSchema,
    generatedFromForecastId: uuidSchema.nullable(),
    generatedAt: isoDateTimeSchema,
  })
  .superRefine((prepList, ctx) => {
    if (
      new Set(prepList.lines.map((line) => line.inventoryItemId)).size !==
      prepList.lines.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: "One line per inventory item",
      });
  });
export type PrepList = z.infer<typeof prepListSchema>;

// ---- Equipment and maintenance (PRD §6 L) --------------------------------

/** PRD §3 F45 names espresso machine, grinder, blender, oven, water filter,
 * air conditioner and the shower water heater; chiller/freezer log
 * temperatures. */
export const equipmentCategorySchema = z.enum([
  "espresso_machine",
  "grinder",
  "blender",
  "oven",
  "water_filter",
  "air_conditioner",
  "water_heater",
  "chiller",
  "freezer",
  "other",
]);
export type EquipmentCategory = z.infer<typeof equipmentCategorySchema>;

/** OPS-04: `broken` disables the linked menu items. Transitions are typed. */
export const equipmentStatusSchema = z.enum([
  "operational",
  "under_maintenance",
  "broken",
  "retired",
]);
export type EquipmentStatus = z.infer<typeof equipmentStatusSchema>;

export const equipmentSchema = z.strictObject({
  id: equipmentIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  name: z.string().trim().min(1).max(150),
  category: equipmentCategorySchema,
  /** §6 `asset_id`: the fixed-asset ledger row when the equipment is capitalized. */
  assetId: fixedAssetIdSchema.nullable(),
  /** OPS-04 mapping: a broken machine marks these menu items sold out. */
  linkedMenuItemIds: z.array(uuidSchema).max(100),
  status: equipmentStatusSchema,
  /** Chiller/freezer threshold; null for equipment without a temperature. */
  temperatureThreshold: temperatureThresholdSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type Equipment = z.infer<typeof equipmentSchema>;

export const maintenanceScheduleSchema = z.strictObject({
  id: maintenanceScheduleIdSchema,
  tenantId: tenantIdSchema,
  outletId: outletIdSchema,
  equipmentId: equipmentIdSchema,
  intervalDays: z.number().int().positive().max(3650),
  nextDueAt: isoDateTimeSchema,
  vendorId: maintenanceVendorIdSchema.nullable(),
  updatedAt: isoDateTimeSchema,
});
export type MaintenanceSchedule = z.infer<typeof maintenanceScheduleSchema>;

/** PRD §6 L `maintenance_tickets.urgency`. */
export const maintenanceUrgencySchema = z.enum([
  "low",
  "medium",
  "high",
  "critical",
]);
export type MaintenanceUrgency = z.infer<typeof maintenanceUrgencySchema>;

export const maintenanceTicketStatusSchema = z.enum([
  "reported",
  "in_progress",
  "resolved",
  "cancelled",
]);
export type MaintenanceTicketStatus = z.infer<
  typeof maintenanceTicketStatusSchema
>;

/** PRD §3 F45: breakdown ticket with photo, urgency, service vendor and cost,
 * connected to the asset. `marksEquipmentBroken` is the OPS-04 switch: when
 * true the equipment becomes `broken` and its mapped menu items are disabled. */
export const maintenanceTicketSchema = z
  .strictObject({
    id: maintenanceTicketIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    equipmentId: equipmentIdSchema,
    reportedBy: userIdSchema,
    urgency: maintenanceUrgencySchema,
    description,
    mediaIds: z.array(uuidSchema).min(1).max(10),
    vendorId: maintenanceVendorIdSchema.nullable(),
    costIdr: nonnegativeIdrSchema.nullable(),
    status: maintenanceTicketStatusSchema,
    marksEquipmentBroken: z.boolean(),
    reportedAt: isoDateTimeSchema,
    resolvedAt: isoDateTimeSchema.nullable(),
  })
  .superRefine((ticket, ctx) => {
    const resolved = ticket.status === "resolved";
    if (resolved !== (ticket.resolvedAt !== null))
      ctx.addIssue({
        code: "custom",
        path: ["resolvedAt"],
        message: "A resolved ticket carries its resolution time",
      });
  });
export type MaintenanceTicket = z.infer<typeof maintenanceTicketSchema>;

// ---- Shift handovers (PRD §6 L `shift_handovers`) ------------------------

/** The five structured sections PRD §3 F45 names: kas, stok kritis, keluhan
 * terbuka, peralatan bermasalah, catatan khusus. At least one is filled. */
export const shiftHandoverNotesSchema = z
  .strictObject({
    cash: description.nullable(),
    criticalStock: description.nullable(),
    openComplaints: description.nullable(),
    equipmentIssues: description.nullable(),
    specialNotes: description.nullable(),
  })
  .refine((notes) => Object.values(notes).some((section) => section !== null), {
    message: "A handover needs at least one filled section",
  });
export type ShiftHandoverNotes = z.infer<typeof shiftHandoverNotesSchema>;

export const shiftHandoverStatusSchema = z.enum(["submitted", "acknowledged"]);
export type ShiftHandoverStatus = z.infer<typeof shiftHandoverStatusSchema>;

/** OPS-05: the next shift must read and confirm the handover before it can
 * close. `fromShiftTemplateId` / `toShiftTemplateId` are §6 L `from_shift` /
 * `to_shift`, resolved to HRIS shift templates. */
export const shiftHandoverSchema = z
  .strictObject({
    id: shiftHandoverIdSchema,
    tenantId: tenantIdSchema,
    outletId: outletIdSchema,
    fromShiftTemplateId: shiftTemplateIdSchema,
    toShiftTemplateId: shiftTemplateIdSchema,
    notes: shiftHandoverNotesSchema,
    submittedBy: userIdSchema,
    submittedAt: isoDateTimeSchema,
    acknowledgedBy: userIdSchema.nullable(),
    acknowledgedAt: isoDateTimeSchema.nullable(),
    status: shiftHandoverStatusSchema,
  })
  .superRefine((handover, ctx) => {
    const acknowledged = handover.status === "acknowledged";
    if (
      acknowledged !==
      (handover.acknowledgedBy !== null && handover.acknowledgedAt !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["acknowledgedBy"],
        message: "An acknowledged handover carries its confirmer and time",
      });
    if (
      handover.acknowledgedBy !== null &&
      handover.acknowledgedBy === handover.submittedBy
    )
      ctx.addIssue({
        code: "custom",
        path: ["acknowledgedBy"],
        message: "The receiving shift confirms, not the submitting shift",
      });
  });
export type ShiftHandover = z.infer<typeof shiftHandoverSchema>;

// ---- Small helpers --------------------------------------------------------

/** Inclusive range check; a reading equal to a bound is in range. */
export function isTemperatureInRange(
  readingCelsius: Decimal4,
  threshold: TemperatureThreshold,
): boolean {
  const reading = parseDecimal4(readingCelsius);
  return (
    reading >= parseDecimal4(threshold.minCelsius) &&
    reading <= parseDecimal4(threshold.maxCelsius)
  );
}
