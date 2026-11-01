// Typed state machines and timing rules for daily operations (PRD v1.7 §6 L
// status columns; docs/plan/contracts.md: "money and state transitions only
// through the contract state machines"). Pure functions: the API, the edge and
// the FE run the same rules, and a test can name the acceptance criterion.
//
// OPS-01 checklist misses/failures alert the supervisor within 15 minutes of
// the deadline; OPS-02 an out-of-range temperature cannot be saved without a
// corrective action; OPS-03 prep labels carry a use-by linked to a batch;
// OPS-04 a ticket that marks equipment broken disables its mapped menu items;
// OPS-05 a handover cannot close before the receiving shift confirms it.

import {
  decimal4Schema,
  isoDateTimeSchema,
  toIsoDateTime,
  z,
} from "../core/index.ts";
import type { IsoDateTime, UserId } from "../core/index.ts";
import { OperationsError } from "./errors.ts";
import {
  isTemperatureInRange,
  shiftHandoverSchema,
  temperatureThresholdSchema,
} from "./schemas.ts";
import type {
  ChecklistItem,
  ChecklistItemResult,
  ChecklistRun,
  ChecklistRunStatus,
  Equipment,
  EquipmentStatus,
  MaintenanceTicketStatus,
  PrepLabel,
  PrepListStatus,
  ShiftHandover,
  TemperatureThreshold,
} from "./schemas.ts";

const MINUTE = 60_000;

// ---- Checklist runs (OPS-01) ---------------------------------------------

export const checklistRunActionSchema = z.enum([
  "start",
  "complete",
  "fail",
  "miss",
]);
export type ChecklistRunAction = z.infer<typeof checklistRunActionSchema>;

const checklistRunTransitions: Record<
  ChecklistRunStatus,
  Partial<Record<ChecklistRunAction, ChecklistRunStatus>>
> = {
  pending: { start: "in_progress", miss: "missed" },
  in_progress: {
    complete: "completed",
    fail: "failed",
    miss: "missed",
  },
  completed: {},
  missed: {},
  failed: {},
};

/** Throws CHECKLIST_TRANSITION_INVALID for an action the status forbids. */
export function transitionChecklistRun(
  status: ChecklistRunStatus,
  action: ChecklistRunAction,
): ChecklistRunStatus {
  const next = checklistRunTransitions[status][action];
  if (!next)
    throw new OperationsError(
      "CHECKLIST_TRANSITION_INVALID",
      `Checklist berstatus ${status} tidak dapat menjalani ${action}.`,
    );
  return next;
}

/** Evidence a finished item still needs; empty means the answer is complete. */
export function checklistItemResultIssues(
  item: ChecklistItem,
  result: ChecklistItemResult,
): string[] {
  if (result.status === "pending") return [];
  const issues: string[] = [];
  if (item.requiredEvidence.includes("number") && result.numberValue === null)
    issues.push("NUMBER_REQUIRED");
  if (
    item.requiredEvidence.includes("photo") &&
    result.photoMediaIds.length === 0
  )
    issues.push("PHOTO_REQUIRED");
  if (
    item.requiredEvidence.includes("signature") &&
    result.signatureMediaId === null
  )
    issues.push("SIGNATURE_REQUIRED");
  return issues;
}

export function assertChecklistItemResult(
  item: ChecklistItem,
  result: ChecklistItemResult,
): void {
  if (checklistItemResultIssues(item, result).length > 0)
    throw new OperationsError("CHECKLIST_ITEM_INCOMPLETE");
}

/**
 * The outcome of a run whose items are all finished: any failed item fails the
 * run (OPS-01 alerts on both missed and failed). Throws until every template
 * item has a finished result, so a run cannot be completed half-way.
 */
export function checklistCompletionStatus(
  items: readonly ChecklistItem[],
  results: readonly ChecklistItemResult[],
): Extract<ChecklistRunStatus, "completed" | "failed"> {
  const byItem = new Map(results.map((result) => [result.itemId, result]));
  for (const item of items) {
    const result = byItem.get(item.id);
    if (!result || result.status === "pending")
      throw new OperationsError("CHECKLIST_ITEM_INCOMPLETE");
    assertChecklistItemResult(item, result);
  }
  return results.some((result) => result.status === "failed")
    ? "failed"
    : "completed";
}

/** OPS-01: the supervisor alert is due no later than 15 minutes after `dueAt`. */
export const CHECKLIST_ALERT_GRACE_MINUTES = 15;

export function checklistAlertDeadline(dueAt: IsoDateTime): IsoDateTime {
  return toIsoDateTime(
    new Date(Date.parse(dueAt) + CHECKLIST_ALERT_GRACE_MINUTES * MINUTE),
  );
}

/** True once the run's deadline has passed while it is still unfinished. */
export function isChecklistRunOverdue(
  run: Pick<ChecklistRun, "dueAt" | "status">,
  now: Date | string,
): boolean {
  if (run.status !== "pending" && run.status !== "in_progress") return false;
  const time = typeof now === "string" ? Date.parse(now) : now.getTime();
  return time >= Date.parse(run.dueAt);
}

/** OPS-01: an alert raised after the 15-minute grace breaks the SLA. */
export function isChecklistAlertOnTime(
  run: Pick<ChecklistRun, "dueAt">,
  alertedAt: Date | string,
): boolean {
  const time =
    typeof alertedAt === "string" ? Date.parse(alertedAt) : alertedAt.getTime();
  return time <= Date.parse(checklistAlertDeadline(run.dueAt));
}

// ---- Temperature logs (OPS-02) -------------------------------------------

export type TemperatureLogGateInput = {
  readingCelsius: string;
  threshold: TemperatureThreshold;
  correctiveAction: string | null;
};

/** Reasons an out-of-range reading may not be saved (empty = allowed). */
export function temperatureLogIssues(input: TemperatureLogGateInput): string[] {
  const threshold = temperatureThresholdSchema.safeParse(input.threshold);
  if (!threshold.success) return ["THRESHOLD_INVALID"];
  const reading = decimal4Schema.safeParse(input.readingCelsius);
  if (!reading.success) return ["READING_INVALID"];
  const hasCorrectiveAction =
    typeof input.correctiveAction === "string" &&
    input.correctiveAction.trim().length > 0;
  if (isTemperatureInRange(reading.data, threshold.data) || hasCorrectiveAction)
    return [];
  return ["CORRECTIVE_ACTION_REQUIRED"];
}

export function assertTemperatureLogAllowed(
  input: TemperatureLogGateInput,
): void {
  const issues = temperatureLogIssues(input);
  if (
    issues.includes("THRESHOLD_INVALID") ||
    issues.includes("READING_INVALID")
  )
    throw new OperationsError("TEMPERATURE_READING_INVALID");
  if (issues.includes("CORRECTIVE_ACTION_REQUIRED"))
    throw new OperationsError("TEMPERATURE_CORRECTIVE_ACTION_REQUIRED");
}

// ---- Prep labels (OPS-03) ------------------------------------------------

/** OPS-03: a label past its use-by appears in the expiry alerts. */
export function isPrepLabelExpired(
  prepLabel: Pick<PrepLabel, "useBy">,
  now: Date | string,
): boolean {
  const time = typeof now === "string" ? Date.parse(now) : now.getTime();
  return time >= Date.parse(prepLabel.useBy);
}

export function expiredPrepLabels(
  prepLabels: readonly PrepLabel[],
  now: Date | string,
): PrepLabel[] {
  return prepLabels.filter((prepLabel) => isPrepLabelExpired(prepLabel, now));
}

// ---- Prep lists ----------------------------------------------------------

export const prepListActionSchema = z.enum(["start", "complete"]);
export type PrepListAction = z.infer<typeof prepListActionSchema>;

const prepListTransitions: Record<
  PrepListStatus,
  Partial<Record<PrepListAction, PrepListStatus>>
> = {
  pending: { start: "in_progress" },
  in_progress: { complete: "completed" },
  completed: {},
};

export function transitionPrepList(
  status: PrepListStatus,
  action: PrepListAction,
): PrepListStatus {
  const next = prepListTransitions[status][action];
  if (!next)
    throw new OperationsError(
      "PREP_LIST_TRANSITION_INVALID",
      `Daftar prep berstatus ${status} tidak dapat menjalani ${action}.`,
    );
  return next;
}

/** PRD §3 F45: a breakdown ticket carries at least one photo. The input schema
 * already enforces this; the service calls the gate before writing. */
export function assertMaintenanceTicketHasPhoto(
  mediaIds: readonly string[],
): void {
  if (mediaIds.length === 0)
    throw new OperationsError("MAINTENANCE_PHOTO_REQUIRED");
}

// ---- Equipment (OPS-04) --------------------------------------------------

export const equipmentActionSchema = z.enum([
  "report_breakdown",
  "start_maintenance",
  "complete_maintenance",
  "retire",
]);
export type EquipmentAction = z.infer<typeof equipmentActionSchema>;

const equipmentTransitions: Record<
  EquipmentStatus,
  Partial<Record<EquipmentAction, EquipmentStatus>>
> = {
  operational: {
    report_breakdown: "broken",
    start_maintenance: "under_maintenance",
    retire: "retired",
  },
  broken: {
    start_maintenance: "under_maintenance",
    retire: "retired",
  },
  under_maintenance: {
    complete_maintenance: "operational",
    retire: "retired",
  },
  retired: {},
};

export function transitionEquipment(
  status: EquipmentStatus,
  action: EquipmentAction,
): EquipmentStatus {
  const next = equipmentTransitions[status][action];
  if (!next)
    throw new OperationsError(
      "EQUIPMENT_TRANSITION_INVALID",
      `Peralatan berstatus ${status} tidak dapat menjalani ${action}.`,
    );
  return next;
}

/** OPS-04: only a broken machine disables its mapped menu items. */
export function menuItemsDisabledByEquipment(
  equipment: Pick<Equipment, "status" | "linkedMenuItemIds">,
): readonly string[] {
  return equipment.status === "broken" ? equipment.linkedMenuItemIds : [];
}

// ---- Maintenance tickets -------------------------------------------------

export const maintenanceTicketActionSchema = z.enum([
  "start",
  "resolve",
  "cancel",
]);
export type MaintenanceTicketAction = z.infer<
  typeof maintenanceTicketActionSchema
>;

const maintenanceTicketTransitions: Record<
  MaintenanceTicketStatus,
  Partial<Record<MaintenanceTicketAction, MaintenanceTicketStatus>>
> = {
  reported: { start: "in_progress", cancel: "cancelled" },
  in_progress: { resolve: "resolved", cancel: "cancelled" },
  resolved: {},
  cancelled: {},
};

export function transitionMaintenanceTicket(
  status: MaintenanceTicketStatus,
  action: MaintenanceTicketAction,
): MaintenanceTicketStatus {
  const next = maintenanceTicketTransitions[status][action];
  if (!next)
    throw new OperationsError(
      "MAINTENANCE_TRANSITION_INVALID",
      `Tiket perawatan berstatus ${status} tidak dapat menjalani ${action}.`,
    );
  return next;
}

// ---- Shift handovers (OPS-05) --------------------------------------------

/** OPS-05: a handover is closable only after the receiving shift confirmed it. */
export function shiftHandoverCanClose(handover: ShiftHandover): boolean {
  return handover.status === "acknowledged";
}

export function assertShiftHandoverClosable(handover: ShiftHandover): void {
  if (!shiftHandoverCanClose(handover))
    throw new OperationsError("HANDOVER_ACKNOWLEDGEMENT_REQUIRED");
}

/**
 * OPS-05: the next shift confirms (`acknowledgedBy`). The submitting shift
 * cannot acknowledge its own handover, so the confirm gate cannot be bypassed.
 */
export function acknowledgeShiftHandover(
  handover: ShiftHandover,
  confirmation: { acknowledgedBy: UserId; acknowledgedAt: IsoDateTime },
): ShiftHandover {
  if (handover.status === "acknowledged")
    throw new OperationsError("HANDOVER_ALREADY_ACKNOWLEDGED");
  if (confirmation.acknowledgedBy === handover.submittedBy)
    throw new OperationsError("HANDOVER_SELF_ACKNOWLEDGEMENT");
  return shiftHandoverSchema.parse({
    ...handover,
    status: "acknowledged",
    acknowledgedBy: confirmation.acknowledgedBy,
    acknowledgedAt: isoDateTimeSchema.parse(confirmation.acknowledgedAt),
  });
}
