// Daily-operations domain events (bead legend-ptd8). Registered in the WS-00
// event catalog (packages/shared/src/events/catalog.ts, WS-14 line) and emitted
// through the transactional outbox contract (`eventEnvelopeSchema`; ULID event
// ids, payload schema ref `<name>.v1`).
//
// - checklist.missed: a run passed its deadline unfinished; the supervisor
//   alert must follow within 15 minutes (OPS-01).
// - checklist.failed: a run finished with at least one failed item; OPS-01
//   alerts the supervisor on failures as well as misses.
// - temperature.out_of_range: an out-of-range reading was saved with its
//   mandatory corrective action (OPS-02).
// - equipment.broken: a maintenance ticket marked equipment broken; consumers
//   disable the mapped menu items (OPS-04).
// - checklist.completed / checklist.reminded / equipment_service.reminded /
//   prep_list.created: daily-ops notifications (legend-lvx2); consumers get
//   the ids and times they need without another read.

import {
  businessDateSchema,
  decimal4Schema,
  isoDateTimeSchema,
  userIdSchema,
  uuidSchema,
  z,
} from "../core/index.ts";
import { defineDomainEvent, eventEnvelopeSchema } from "../events/index.ts";
import type { EventCatalogEntry, EventEnvelope } from "../events/index.ts";
import {
  inventoryItemIdSchema,
  stockBatchIdSchema,
} from "../inventory/schemas.ts";
import { supplierIdSchema } from "../inventory/purchasing/schemas.ts";
import {
  equipmentIdSchema,
  maintenanceTicketIdSchema,
  maintenanceUrgencySchema,
  opsChecklistItemIdSchema,
  opsChecklistRunIdSchema,
  opsChecklistTemplateIdSchema,
  maintenanceScheduleIdSchema,
  prepLabelIdSchema,
  prepListIdSchema,
  temperatureLogIdSchema,
} from "./schemas.ts";

export const operationsEventNames = [
  "checklist.missed",
  "checklist.failed",
  "temperature.out_of_range",
  "equipment.broken",
  "prep_label.expired",
  "checklist.completed",
  "checklist.reminded",
  "equipment_service.reminded",
  "prep_list.created",
] as const;
export type OperationsEventName = (typeof operationsEventNames)[number];

/** OPS-01: enough for the supervisor alert without another read. */
export const checklistMissedEventPayloadSchema = z.strictObject({
  runId: opsChecklistRunIdSchema,
  templateId: opsChecklistTemplateIdSchema,
  shiftDate: businessDateSchema,
  assignedTo: userIdSchema,
  dueAt: isoDateTimeSchema,
  detectedAt: isoDateTimeSchema,
});
export type ChecklistMissedEventPayload = z.infer<
  typeof checklistMissedEventPayloadSchema
>;

/** OPS-01: a failed run alerts the supervisor too; names the failed items. */
export const checklistFailedEventPayloadSchema = z.strictObject({
  runId: opsChecklistRunIdSchema,
  templateId: opsChecklistTemplateIdSchema,
  shiftDate: businessDateSchema,
  assignedTo: userIdSchema,
  dueAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema,
  failedItemIds: z.array(opsChecklistItemIdSchema).min(1).max(100),
});
export type ChecklistFailedEventPayload = z.infer<
  typeof checklistFailedEventPayloadSchema
>;

/** OPS-02: emitted only after the corrective action is recorded, so the
 * payload always carries it. */
export const temperatureOutOfRangeEventPayloadSchema = z.strictObject({
  temperatureLogId: temperatureLogIdSchema,
  equipmentId: equipmentIdSchema,
  readingCelsius: decimal4Schema,
  minCelsius: decimal4Schema,
  maxCelsius: decimal4Schema,
  recordedAt: isoDateTimeSchema,
  correctiveAction: z.string().trim().min(1).max(1000),
});
export type TemperatureOutOfRangeEventPayload = z.infer<
  typeof temperatureOutOfRangeEventPayloadSchema
>;

/** OPS-04: carries the mapping so the sold-out consumer needs no extra read. */
export const equipmentBrokenEventPayloadSchema = z.strictObject({
  equipmentId: equipmentIdSchema,
  ticketId: maintenanceTicketIdSchema,
  urgency: maintenanceUrgencySchema,
  linkedMenuItemIds: z.array(uuidSchema).max(100),
  reportedAt: isoDateTimeSchema,
});
export type EquipmentBrokenEventPayload = z.infer<
  typeof equipmentBrokenEventPayloadSchema
>;

/** OPS-03: a prep label crossed its use-by while unprinted or still stored.
 * The expiry-alert sweep emits it once per label. */
export const prepLabelExpiredEventPayloadSchema = z.strictObject({
  prepLabelId: prepLabelIdSchema,
  inventoryItemId: inventoryItemIdSchema,
  batchId: stockBatchIdSchema,
  useBy: isoDateTimeSchema,
  detectedAt: isoDateTimeSchema,
});
export type PrepLabelExpiredEventPayload = z.infer<
  typeof prepLabelExpiredEventPayloadSchema
>;

/** A run was finished without a failed item. A run with at least one failed
 * item already emits `checklist.failed` instead, so this never fires for it. */
export const checklistCompletedEventPayloadSchema = z.strictObject({
  runId: opsChecklistRunIdSchema,
  templateId: opsChecklistTemplateIdSchema,
  shiftDate: businessDateSchema,
  assignedTo: userIdSchema,
  dueAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema,
});
export type ChecklistCompletedEventPayload = z.infer<
  typeof checklistCompletedEventPayloadSchema
>;

/** A run is still open shortly before its deadline; reminds the assignee. */
export const checklistRemindedEventPayloadSchema = z.strictObject({
  runId: opsChecklistRunIdSchema,
  templateId: opsChecklistTemplateIdSchema,
  shiftDate: businessDateSchema,
  assignedTo: userIdSchema,
  dueAt: isoDateTimeSchema,
  remindedAt: isoDateTimeSchema,
});
export type ChecklistRemindedEventPayload = z.infer<
  typeof checklistRemindedEventPayloadSchema
>;

/** OPS-04: a maintenance schedule is coming due; `vendorId` is the purchasing
 * supplier to call, null when none is set. */
export const equipmentServiceRemindedEventPayloadSchema = z.strictObject({
  scheduleId: maintenanceScheduleIdSchema,
  equipmentId: equipmentIdSchema,
  nextDueAt: isoDateTimeSchema,
  vendorId: supplierIdSchema.nullable(),
  remindedAt: isoDateTimeSchema,
});
export type EquipmentServiceRemindedEventPayload = z.infer<
  typeof equipmentServiceRemindedEventPayloadSchema
>;

/** A prep list was generated for a day; `lineCount` saves the notifier a read. */
export const prepListCreatedEventPayloadSchema = z.strictObject({
  prepListId: prepListIdSchema,
  prepDate: businessDateSchema,
  lineCount: z.number().int().min(1),
  generatedFromForecastId: uuidSchema.nullable(),
  generatedAt: isoDateTimeSchema,
});
export type PrepListCreatedEventPayload = z.infer<
  typeof prepListCreatedEventPayloadSchema
>;

/** Payload schema per event name, for the outbox writer and consumers. */
export const operationsEventPayloadSchemas = {
  "checklist.missed": checklistMissedEventPayloadSchema,
  "checklist.failed": checklistFailedEventPayloadSchema,
  "temperature.out_of_range": temperatureOutOfRangeEventPayloadSchema,
  "equipment.broken": equipmentBrokenEventPayloadSchema,
  "prep_label.expired": prepLabelExpiredEventPayloadSchema,
  "checklist.completed": checklistCompletedEventPayloadSchema,
  "checklist.reminded": checklistRemindedEventPayloadSchema,
  "equipment_service.reminded": equipmentServiceRemindedEventPayloadSchema,
  "prep_list.created": prepListCreatedEventPayloadSchema,
} as const;

/**
 * Catalog-bound definitions (contracts.md "One catalog, typed payloads"):
 * defineDomainEvent throws at module load for an uncatalogued name, and each
 * `envelopeSchema` validates name, version, schema ref and payload together.
 */
export const operationsEvents = Object.fromEntries(
  operationsEventNames.map((name) => [
    name,
    defineDomainEvent({
      name,
      payload: operationsEventPayloadSchemas[name] as z.ZodType<
        Record<string, unknown>
      >,
    }),
  ]),
) as Record<OperationsEventName, ReturnType<typeof defineDomainEvent>>;

export const operationsEventCatalogEntries: readonly EventCatalogEntry[] =
  operationsEventNames.map((name) => operationsEvents[name].entry);

/** Envelope whose name and payload belong to this domain. */
export const operationsEventSchema = eventEnvelopeSchema
  .refine(
    (event) => (operationsEventNames as readonly string[]).includes(event.name),
    { path: ["name"], message: "Not a daily-operations event" },
  )
  .refine(
    (event) =>
      operationsEvents[
        event.name as OperationsEventName
      ]?.envelopeSchema.safeParse(event).success === true,
    {
      path: ["payload"],
      message: "Event does not match its catalogued schema",
    },
  );
export type OperationsEvent = EventEnvelope;
