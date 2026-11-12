// Daily-operations endpoint contracts (bead legend-ptd8). The web app's typed
// client and mock mode, and later the API route validation, read these objects
// (docs/frontend.md, "Typed endpoints and mock mode"). Paths live under
// /api/operations so they cannot collide with another domain.
//
// Tenant comes from the domain or token, never the body (TEN-02). Outlet ids
// in a query or write ARE client input: the server checks them against the
// caller's outlet scope (TEN-03). Lists use cursor pagination (D-CORE-5);
// writes that create documents carry an idempotency key.
//
// Server-derived fields the client never sends: `dueAt` (from the template
// schedule + shift date in the outlet time zone), `inRange` (from the equipment
// threshold), `completedAt` / `completedBy`, `reportedAt`, `recordedBy`,
// `submittedAt`, `acknowledgedBy` / `acknowledgedAt`.

import {
  businessDateSchema,
  clientInputSchema,
  cursorPageQuerySchema,
  cursorPageSchema,
  dataResponseSchema,
  decimal4Schema,
  idempotencyKeySchema,
  isoDateTimeSchema,
  outletIdSchema,
  userIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineEndpoint } from "../api/index.ts";
import { roleIdSchema } from "../access/ids.ts";
import { fixedAssetIdSchema } from "../accounting/ids.ts";
import { shiftTemplateIdSchema } from "../hris/ids.ts";
import {
  inventoryItemIdSchema,
  stockBatchIdSchema,
  supplierIdSchema,
} from "../inventory/index.ts";
import {
  checklistEvidenceKindSchema,
  checklistItemResultStatusSchema,
  checklistRunSchema,
  checklistRunStatusSchema,
  checklistScheduleSchema,
  checklistTemplateSchema,
  checklistTemplateTypeSchema,
  equipmentCategorySchema,
  equipmentIdSchema,
  equipmentSchema,
  equipmentStatusSchema,
  maintenanceScheduleIdSchema,
  maintenanceScheduleSchema,
  maintenanceTicketIdSchema,
  maintenanceTicketSchema,
  maintenanceTicketStatusSchema,
  maintenanceUrgencySchema,
  nonnegativeIdrSchema,
  opsChecklistItemIdSchema,
  opsChecklistRunIdSchema,
  opsChecklistTemplateIdSchema,
  prepLabelIdSchema,
  prepLabelSchema,
  prepListSchema,
  prepListStatusSchema,
  prepListIdSchema,
  positiveDecimal4Schema,
  shiftHandoverIdSchema,
  shiftHandoverNotesSchema,
  shiftHandoverSchema,
  shiftHandoverStatusSchema,
  temperatureLogSchema,
  temperatureThresholdSchema,
} from "./schemas.ts";
import {
  checklistRunActionSchema,
  equipmentActionSchema,
  maintenanceTicketActionSchema,
  prepListActionSchema,
} from "./machines.ts";

// ---- List queries ---------------------------------------------------------

export const checklistTemplateListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  type: checklistTemplateTypeSchema.optional(),
});

export const checklistRunListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  status: checklistRunStatusSchema.optional(),
  shiftDate: businessDateSchema.optional(),
  assignedTo: userIdSchema.optional(),
});

export const temperatureLogListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  equipmentId: equipmentIdSchema.optional(),
  /** Recorded on or after this instant. */
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});

export const prepLabelListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  inventoryItemId: inventoryItemIdSchema.optional(),
  /** Labels whose use-by is before this instant (expiry alerts, OPS-03). */
  expiringBefore: isoDateTimeSchema.optional(),
});

export const prepListListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  prepDate: businessDateSchema.optional(),
  status: prepListStatusSchema.optional(),
});

export const equipmentListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  category: equipmentCategorySchema.optional(),
  status: equipmentStatusSchema.optional(),
});

export const maintenanceScheduleListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  equipmentId: equipmentIdSchema.optional(),
  /** Next service due on or before this instant (reminders). */
  dueBefore: isoDateTimeSchema.optional(),
});

export const maintenanceTicketListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  equipmentId: equipmentIdSchema.optional(),
  status: maintenanceTicketStatusSchema.optional(),
  urgency: maintenanceUrgencySchema.optional(),
});

export const shiftHandoverListQuerySchema = cursorPageQuerySchema.extend({
  outletId: outletIdSchema,
  status: shiftHandoverStatusSchema.optional(),
});

// ---- Client inputs --------------------------------------------------------

/** Evidence kinds a template item can require. */
export const checklistItemInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(300),
  instruction: z.string().trim().min(1).max(1000).nullable().optional(),
  requiredEvidence: z.array(checklistEvidenceKindSchema).max(3).optional(),
});

/** Updating a template replaces its item list; an existing item keeps its id,
 * a new one gets one from the server. */
export const checklistItemUpdateInputSchema = checklistItemInputSchema.extend({
  id: opsChecklistItemIdSchema.optional(),
});

export const createChecklistTemplateInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  name: z.string().trim().min(1).max(150),
  type: checklistTemplateTypeSchema,
  items: z.array(checklistItemInputSchema).min(1).max(100),
  schedule: checklistScheduleSchema,
  roleId: roleIdSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const updateChecklistTemplateInputSchema = clientInputSchema({
  name: z.string().trim().min(1).max(150).optional(),
  items: z.array(checklistItemUpdateInputSchema).min(1).max(100).optional(),
  schedule: checklistScheduleSchema.optional(),
  roleId: roleIdSchema.nullable().optional(),
  /** Optimistic concurrency (CORE PRECONDITION_FAILED on a stale value). */
  expectedUpdatedAt: isoDateTimeSchema,
  idempotencyKey: idempotencyKeySchema,
});

/** A run is generated from a template for one business date; the server
 * derives `dueAt` and keeps `assignedTo` inside the outlet scope. */
export const createChecklistRunInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  templateId: opsChecklistTemplateIdSchema,
  shiftDate: businessDateSchema,
  shiftTemplateId: shiftTemplateIdSchema.nullable().optional(),
  assignedTo: userIdSchema,
  idempotencyKey: idempotencyKeySchema,
});

/** Evidence for one item. The server sets `completedAt` / `completedBy` and
 * rejects a done/failed answer that misses its required evidence. */
export const recordChecklistItemResultInputSchema = clientInputSchema({
  status: checklistItemResultStatusSchema,
  numberValue: decimal4Schema.nullable().optional(),
  note: z.string().trim().min(1).max(500).nullable().optional(),
  photoMediaIds: z.array(uuidSchema).max(10).optional(),
  signatureMediaId: uuidSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
  /** Queued attempts retain their captured actor across a later sign-in change. */
  expectedActorUserId: userIdSchema.optional(),
});

export const transitionChecklistRunInputSchema = clientInputSchema({
  action: checklistRunActionSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const createTemperatureLogInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  equipmentId: equipmentIdSchema,
  readingCelsius: decimal4Schema,
  /** OPS-02: required when the reading is outside the equipment threshold. */
  correctiveAction: z.string().trim().min(1).max(1000).nullable().optional(),
  recordedAt: isoDateTimeSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const createPrepLabelInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  batchId: stockBatchIdSchema,
  producedAt: isoDateTimeSchema,
  useBy: isoDateTimeSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const printPrepLabelInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
});

export const createPrepListInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  prepDate: businessDateSchema,
  lines: z
    .array(
      z.strictObject({
        inventoryItemId: inventoryItemIdSchema,
        plannedQuantity: positiveDecimal4Schema,
      }),
    )
    .min(1),
  /** AI-07 forecast job the quantities came from (WS-12). */
  generatedFromForecastId: uuidSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const transitionPrepListInputSchema = clientInputSchema({
  action: prepListActionSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const createEquipmentInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  name: z.string().trim().min(1).max(150),
  category: equipmentCategorySchema,
  assetId: fixedAssetIdSchema.nullable().optional(),
  linkedMenuItemIds: z.array(uuidSchema).max(100).optional(),
  temperatureThreshold: temperatureThresholdSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const updateEquipmentInputSchema = clientInputSchema({
  name: z.string().trim().min(1).max(150).optional(),
  category: equipmentCategorySchema.optional(),
  assetId: fixedAssetIdSchema.nullable().optional(),
  linkedMenuItemIds: z.array(uuidSchema).max(100).optional(),
  temperatureThreshold: temperatureThresholdSchema.nullable().optional(),
  /** Optimistic concurrency (CORE PRECONDITION_FAILED on a stale value). */
  expectedUpdatedAt: isoDateTimeSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const transitionEquipmentInputSchema = clientInputSchema({
  action: equipmentActionSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const createMaintenanceScheduleInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  equipmentId: equipmentIdSchema,
  intervalDays: z.number().int().positive().max(3650),
  nextDueAt: isoDateTimeSchema,
  vendorId: supplierIdSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

/** WS-14: a finished service moves the due date one interval forward. */
export const completeMaintenanceScheduleInputSchema = clientInputSchema({
  /** When the service was done; the next due date counts from the later of
   * this and the server clock. */
  completedAt: isoDateTimeSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});

/** PRD §3 F45: a breakdown ticket needs at least one photo, an urgency, and
 * may name the service vendor and cost. */
export const createMaintenanceTicketInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  equipmentId: equipmentIdSchema,
  urgency: maintenanceUrgencySchema,
  description: z.string().trim().min(1).max(1000),
  mediaIds: z.array(uuidSchema).min(1).max(10),
  vendorId: supplierIdSchema.nullable().optional(),
  costIdr: nonnegativeIdrSchema.nullable().optional(),
  /** OPS-04: marking the equipment broken disables its mapped menu items. */
  marksEquipmentBroken: z.boolean().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const transitionMaintenanceTicketInputSchema = clientInputSchema({
  action: maintenanceTicketActionSchema,
  /** Resolving records the service vendor and cost when they are known. */
  vendorId: supplierIdSchema.nullable().optional(),
  costIdr: nonnegativeIdrSchema.nullable().optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const createShiftHandoverInputSchema = clientInputSchema({
  outletId: outletIdSchema,
  fromShiftTemplateId: shiftTemplateIdSchema,
  toShiftTemplateId: shiftTemplateIdSchema,
  notes: shiftHandoverNotesSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const acknowledgeShiftHandoverInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
});

export const closeShiftHandoverInputSchema = clientInputSchema({
  idempotencyKey: idempotencyKeySchema,
});

// ---- Read endpoints -------------------------------------------------------

export const listChecklistTemplates = defineEndpoint({
  method: "GET",
  path: "/api/operations/checklist-templates",
  query: checklistTemplateListQuerySchema,
  response: cursorPageSchema(checklistTemplateSchema),
});

export const getChecklistTemplate = defineEndpoint({
  method: "GET",
  path: "/api/operations/checklist-templates/:templateId",
  params: z.strictObject({ templateId: opsChecklistTemplateIdSchema }),
  response: dataResponseSchema(checklistTemplateSchema),
});

export const listChecklistRuns = defineEndpoint({
  method: "GET",
  path: "/api/operations/checklist-runs",
  query: checklistRunListQuerySchema,
  response: cursorPageSchema(checklistRunSchema),
});

export const getChecklistRun = defineEndpoint({
  method: "GET",
  path: "/api/operations/checklist-runs/:runId",
  params: z.strictObject({ runId: opsChecklistRunIdSchema }),
  response: dataResponseSchema(checklistRunSchema),
});

export const listTemperatureLogs = defineEndpoint({
  method: "GET",
  path: "/api/operations/temperature-logs",
  query: temperatureLogListQuerySchema,
  response: cursorPageSchema(temperatureLogSchema),
});

export const listPrepLabels = defineEndpoint({
  method: "GET",
  path: "/api/operations/prep-labels",
  query: prepLabelListQuerySchema,
  response: cursorPageSchema(prepLabelSchema),
});

export const listPrepLists = defineEndpoint({
  method: "GET",
  path: "/api/operations/prep-lists",
  query: prepListListQuerySchema,
  response: cursorPageSchema(prepListSchema),
});

export const getPrepList = defineEndpoint({
  method: "GET",
  path: "/api/operations/prep-lists/:prepListId",
  params: z.strictObject({ prepListId: prepListIdSchema }),
  response: dataResponseSchema(prepListSchema),
});

export const listEquipment = defineEndpoint({
  method: "GET",
  path: "/api/operations/equipment",
  query: equipmentListQuerySchema,
  response: cursorPageSchema(equipmentSchema),
});

export const getEquipment = defineEndpoint({
  method: "GET",
  path: "/api/operations/equipment/:equipmentId",
  params: z.strictObject({ equipmentId: equipmentIdSchema }),
  response: dataResponseSchema(equipmentSchema),
});

export const listMaintenanceSchedules = defineEndpoint({
  method: "GET",
  path: "/api/operations/maintenance-schedules",
  query: maintenanceScheduleListQuerySchema,
  response: cursorPageSchema(maintenanceScheduleSchema),
});

export const listMaintenanceTickets = defineEndpoint({
  method: "GET",
  path: "/api/operations/maintenance-tickets",
  query: maintenanceTicketListQuerySchema,
  response: cursorPageSchema(maintenanceTicketSchema),
});

export const getMaintenanceTicket = defineEndpoint({
  method: "GET",
  path: "/api/operations/maintenance-tickets/:ticketId",
  params: z.strictObject({ ticketId: maintenanceTicketIdSchema }),
  response: dataResponseSchema(maintenanceTicketSchema),
});

export const listShiftHandovers = defineEndpoint({
  method: "GET",
  path: "/api/operations/shift-handovers",
  query: shiftHandoverListQuerySchema,
  response: cursorPageSchema(shiftHandoverSchema),
});

export const getShiftHandover = defineEndpoint({
  method: "GET",
  path: "/api/operations/shift-handovers/:handoverId",
  params: z.strictObject({ handoverId: shiftHandoverIdSchema }),
  response: dataResponseSchema(shiftHandoverSchema),
});

// ---- Write endpoints ------------------------------------------------------

export const createChecklistTemplate = defineEndpoint({
  method: "POST",
  path: "/api/operations/checklist-templates",
  body: createChecklistTemplateInputSchema,
  response: dataResponseSchema(checklistTemplateSchema),
});

export const updateChecklistTemplate = defineEndpoint({
  method: "PATCH",
  path: "/api/operations/checklist-templates/:templateId",
  params: z.strictObject({ templateId: opsChecklistTemplateIdSchema }),
  body: updateChecklistTemplateInputSchema,
  response: dataResponseSchema(checklistTemplateSchema),
});

export const createChecklistRun = defineEndpoint({
  method: "POST",
  path: "/api/operations/checklist-runs",
  body: createChecklistRunInputSchema,
  response: dataResponseSchema(checklistRunSchema),
});

export const recordChecklistItemResult = defineEndpoint({
  method: "POST",
  path: "/api/operations/checklist-runs/:runId/items/:itemId/result",
  params: z.strictObject({
    runId: opsChecklistRunIdSchema,
    itemId: opsChecklistItemIdSchema,
  }),
  body: recordChecklistItemResultInputSchema,
  response: dataResponseSchema(checklistRunSchema),
});

export const postChecklistRunTransition = defineEndpoint({
  method: "POST",
  path: "/api/operations/checklist-runs/:runId/transition",
  params: z.strictObject({ runId: opsChecklistRunIdSchema }),
  body: transitionChecklistRunInputSchema,
  response: dataResponseSchema(checklistRunSchema),
});

export const createTemperatureLog = defineEndpoint({
  method: "POST",
  path: "/api/operations/temperature-logs",
  body: createTemperatureLogInputSchema,
  response: dataResponseSchema(temperatureLogSchema),
});

export const createPrepLabel = defineEndpoint({
  method: "POST",
  path: "/api/operations/prep-labels",
  body: createPrepLabelInputSchema,
  response: dataResponseSchema(prepLabelSchema),
});

export const printPrepLabel = defineEndpoint({
  method: "POST",
  path: "/api/operations/prep-labels/:labelId/print",
  params: z.strictObject({ labelId: prepLabelIdSchema }),
  body: printPrepLabelInputSchema,
  response: dataResponseSchema(prepLabelSchema),
});

export const createPrepList = defineEndpoint({
  method: "POST",
  path: "/api/operations/prep-lists",
  body: createPrepListInputSchema,
  response: dataResponseSchema(prepListSchema),
});

export const postPrepListTransition = defineEndpoint({
  method: "POST",
  path: "/api/operations/prep-lists/:prepListId/transition",
  params: z.strictObject({ prepListId: prepListIdSchema }),
  body: transitionPrepListInputSchema,
  response: dataResponseSchema(prepListSchema),
});

export const createEquipment = defineEndpoint({
  method: "POST",
  path: "/api/operations/equipment",
  body: createEquipmentInputSchema,
  response: dataResponseSchema(equipmentSchema),
});

export const updateEquipment = defineEndpoint({
  method: "PATCH",
  path: "/api/operations/equipment/:equipmentId",
  params: z.strictObject({ equipmentId: equipmentIdSchema }),
  body: updateEquipmentInputSchema,
  response: dataResponseSchema(equipmentSchema),
});

export const postEquipmentTransition = defineEndpoint({
  method: "POST",
  path: "/api/operations/equipment/:equipmentId/transition",
  params: z.strictObject({ equipmentId: equipmentIdSchema }),
  body: transitionEquipmentInputSchema,
  response: dataResponseSchema(equipmentSchema),
});

export const createMaintenanceSchedule = defineEndpoint({
  method: "POST",
  path: "/api/operations/maintenance-schedules",
  body: createMaintenanceScheduleInputSchema,
  response: dataResponseSchema(maintenanceScheduleSchema),
});

export const completeMaintenanceSchedule = defineEndpoint({
  method: "POST",
  path: "/api/operations/maintenance-schedules/:scheduleId/complete",
  params: z.strictObject({ scheduleId: maintenanceScheduleIdSchema }),
  body: completeMaintenanceScheduleInputSchema,
  response: dataResponseSchema(maintenanceScheduleSchema),
});

export const createMaintenanceTicket = defineEndpoint({
  method: "POST",
  path: "/api/operations/maintenance-tickets",
  body: createMaintenanceTicketInputSchema,
  response: dataResponseSchema(maintenanceTicketSchema),
});

export const postMaintenanceTicketTransition = defineEndpoint({
  method: "POST",
  path: "/api/operations/maintenance-tickets/:ticketId/transition",
  params: z.strictObject({ ticketId: maintenanceTicketIdSchema }),
  body: transitionMaintenanceTicketInputSchema,
  response: dataResponseSchema(maintenanceTicketSchema),
});

export const createShiftHandover = defineEndpoint({
  method: "POST",
  path: "/api/operations/shift-handovers",
  body: createShiftHandoverInputSchema,
  response: dataResponseSchema(shiftHandoverSchema),
});

export const postShiftHandoverAcknowledgement = defineEndpoint({
  method: "POST",
  path: "/api/operations/shift-handovers/:handoverId/acknowledge",
  params: z.strictObject({ handoverId: shiftHandoverIdSchema }),
  body: acknowledgeShiftHandoverInputSchema,
  response: dataResponseSchema(shiftHandoverSchema),
});

export const postShiftHandoverClose = defineEndpoint({
  method: "POST",
  path: "/api/operations/shift-handovers/:handoverId/close",
  params: z.strictObject({ handoverId: shiftHandoverIdSchema }),
  body: closeShiftHandoverInputSchema,
  response: dataResponseSchema(shiftHandoverSchema),
});

export const operationsEndpoints = [
  listChecklistTemplates,
  getChecklistTemplate,
  listChecklistRuns,
  getChecklistRun,
  listTemperatureLogs,
  listPrepLabels,
  listPrepLists,
  getPrepList,
  listEquipment,
  getEquipment,
  listMaintenanceSchedules,
  listMaintenanceTickets,
  getMaintenanceTicket,
  listShiftHandovers,
  getShiftHandover,
  createChecklistTemplate,
  updateChecklistTemplate,
  createChecklistRun,
  recordChecklistItemResult,
  postChecklistRunTransition,
  createTemperatureLog,
  createPrepLabel,
  printPrepLabel,
  createPrepList,
  postPrepListTransition,
  createEquipment,
  updateEquipment,
  postEquipmentTransition,
  createMaintenanceSchedule,
  completeMaintenanceSchedule,
  createMaintenanceTicket,
  postMaintenanceTicketTransition,
  createShiftHandover,
  postShiftHandoverAcknowledgement,
  postShiftHandoverClose,
] as const;
