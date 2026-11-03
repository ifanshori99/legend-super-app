// Pure helpers for the equipment registry and shift handover: catalog key maps,
// the contract state machines (never a second copy of a rule), date/money
// formatting and the UI reminder horizon. No React here.
import type { MessageKey } from "@starter/shared/i18n";
import {
  menuItemsDisabledByEquipment,
  transitionEquipment,
  transitionMaintenanceTicket,
  type Equipment,
  type EquipmentAction,
  type EquipmentCategory,
  type EquipmentStatus,
  type MaintenanceSchedule,
  type MaintenanceTicket,
  type MaintenanceTicketAction,
  type MaintenanceTicketStatus,
  type MaintenanceUrgency,
  type ShiftHandoverStatus,
} from "@starter/shared/operations";

export const EQUIPMENT_CATEGORY_KEYS: Record<EquipmentCategory, MessageKey> = {
  espresso_machine: "opsEquipment.equipment.category.espresso_machine",
  grinder: "opsEquipment.equipment.category.grinder",
  blender: "opsEquipment.equipment.category.blender",
  oven: "opsEquipment.equipment.category.oven",
  water_filter: "opsEquipment.equipment.category.water_filter",
  air_conditioner: "opsEquipment.equipment.category.air_conditioner",
  water_heater: "opsEquipment.equipment.category.water_heater",
  chiller: "opsEquipment.equipment.category.chiller",
  freezer: "opsEquipment.equipment.category.freezer",
  other: "opsEquipment.equipment.category.other",
};

export const EQUIPMENT_STATUS_KEYS: Record<EquipmentStatus, MessageKey> = {
  operational: "opsEquipment.equipment.status.operational",
  under_maintenance: "opsEquipment.equipment.status.under_maintenance",
  broken: "opsEquipment.equipment.status.broken",
  retired: "opsEquipment.equipment.status.retired",
};

export const EQUIPMENT_ACTION_KEYS: Record<EquipmentAction, MessageKey> = {
  report_breakdown: "opsEquipment.equipment.equipmentActions.report_breakdown",
  start_maintenance:
    "opsEquipment.equipment.equipmentActions.start_maintenance",
  complete_maintenance:
    "opsEquipment.equipment.equipmentActions.complete_maintenance",
  retire: "opsEquipment.equipment.equipmentActions.retire",
};

export const TICKET_STATUS_KEYS: Record<MaintenanceTicketStatus, MessageKey> = {
  reported: "opsEquipment.equipment.ticketStatus.reported",
  in_progress: "opsEquipment.equipment.ticketStatus.in_progress",
  resolved: "opsEquipment.equipment.ticketStatus.resolved",
  cancelled: "opsEquipment.equipment.ticketStatus.cancelled",
};

export const URGENCY_KEYS: Record<MaintenanceUrgency, MessageKey> = {
  low: "opsEquipment.equipment.urgency.low",
  medium: "opsEquipment.equipment.urgency.medium",
  high: "opsEquipment.equipment.urgency.high",
  critical: "opsEquipment.equipment.urgency.critical",
};

export const TICKET_ACTION_KEYS: Record<MaintenanceTicketAction, MessageKey> = {
  start: "opsEquipment.equipment.ticketActions.start",
  resolve: "opsEquipment.equipment.ticketActions.resolve",
  cancel: "opsEquipment.equipment.ticketActions.cancel",
};

export const HANDOVER_STATUS_KEYS: Record<ShiftHandoverStatus, MessageKey> = {
  submitted: "opsEquipment.handover.status.submitted",
  acknowledged: "opsEquipment.handover.status.acknowledged",
};

/** The five structured handover sections, in PRD §3 F41 order. */
export const HANDOVER_NOTE_KEYS = [
  "cash",
  "criticalStock",
  "openComplaints",
  "equipmentIssues",
  "specialNotes",
] as const;
export type HandoverNoteKey = (typeof HANDOVER_NOTE_KEYS)[number];

export const HANDOVER_NOTE_LABEL_KEYS: Record<HandoverNoteKey, MessageKey> = {
  cash: "opsEquipment.handover.sections.cash",
  criticalStock: "opsEquipment.handover.sections.criticalStock",
  openComplaints: "opsEquipment.handover.sections.openComplaints",
  equipmentIssues: "opsEquipment.handover.sections.equipmentIssues",
  specialNotes: "opsEquipment.handover.sections.specialNotes",
};

export const EQUIPMENT_CATEGORIES = Object.keys(
  EQUIPMENT_CATEGORY_KEYS,
) as EquipmentCategory[];

/** UI reminder horizon for the "Perlu tindakan" strip and stats. The contract
 * exposes `dueBefore` as a horizon, so the screen names its own 30-day window
 * (a display choice, not a business rule). */
export const SERVICE_DUE_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** True when the contract machine accepts `action` for the current status. */
export function canRunEquipmentAction(
  status: EquipmentStatus,
  action: EquipmentAction,
): boolean {
  try {
    transitionEquipment(status, action);
    return true;
  } catch {
    return false;
  }
}

/** True when the contract machine accepts `action` for the current status. */
export function canRunTicketAction(
  status: MaintenanceTicketStatus,
  action: MaintenanceTicketAction,
): boolean {
  try {
    transitionMaintenanceTicket(status, action);
    return true;
  } catch {
    return false;
  }
}

export type ServiceTiming = "overdue" | "due_soon" | "scheduled";

/** Days until `dueAt` (negative when overdue), rounded up at the day boundary. */
export function daysUntil(dueAt: string, now: Date): number {
  return Math.ceil((Date.parse(dueAt) - now.getTime()) / DAY_MS);
}

export function serviceTiming(
  schedule: Pick<MaintenanceSchedule, "nextDueAt">,
  now: Date,
): ServiceTiming {
  const days = daysUntil(schedule.nextDueAt, now);
  if (days < 0) return "overdue";
  if (days <= SERVICE_DUE_WINDOW_DAYS) return "due_soon";
  return "scheduled";
}

/** Schedules inside the reminder horizon (the HTTP query's `dueBefore`). */
export function dueSchedules(
  schedules: readonly MaintenanceSchedule[],
  now: Date,
): MaintenanceSchedule[] {
  return schedules
    .filter((schedule) => serviceTiming(schedule, now) !== "scheduled")
    .sort(
      (left, right) => Date.parse(left.nextDueAt) - Date.parse(right.nextDueAt),
    );
}

export function nextSchedule(
  schedules: readonly MaintenanceSchedule[],
  equipmentId: string,
): MaintenanceSchedule | null {
  return (
    schedules
      .filter((schedule) => schedule.equipmentId === equipmentId)
      .sort(
        (left, right) =>
          Date.parse(left.nextDueAt) - Date.parse(right.nextDueAt),
      )[0] ?? null
  );
}

/** The last resolved service for an equipment row ("servis terakhir"). */
export function lastResolvedTicket(
  tickets: readonly MaintenanceTicket[],
  equipmentId: string,
): MaintenanceTicket | null {
  return (
    tickets
      .filter(
        (ticket) =>
          ticket.equipmentId === equipmentId &&
          ticket.status === "resolved" &&
          ticket.resolvedAt !== null,
      )
      .sort(
        (left, right) =>
          Date.parse(right.resolvedAt ?? "") -
          Date.parse(left.resolvedAt ?? ""),
      )[0] ?? null
  );
}

/** Resolved-ticket cost inside the current calendar month at the outlet. */
export function monthlyServiceCostIdr(
  tickets: readonly MaintenanceTicket[],
  now: Date,
  timeZone: string,
): number {
  const month = monthKey(now, timeZone);
  return tickets.reduce((total, ticket) => {
    if (ticket.status !== "resolved" || ticket.resolvedAt === null)
      return total;
    if (monthKey(new Date(ticket.resolvedAt), timeZone) !== month) return total;
    return total + (ticket.costIdr ?? 0);
  }, 0);
}

function monthKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}`;
}

export function formatDate(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

export function formatDateTime(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("id-ID", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "2026-12-01T09:00" from a datetime-local field → ISO instant. */
export function datetimeLocalToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** ISO instant → the `YYYY-MM-DDTHH:mm` a datetime-local field expects, in the
 * outlet time zone. */
export function isoToDatetimeLocal(
  iso: string | null,
  timeZone: string,
): string {
  if (!iso) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Decimal4 "1.0000" → "1" for compact display. */
export function formatDecimalValue(value: string): string {
  return String(Number(value));
}

/** A Decimal4 string (at most 4 fraction digits) from a number input. */
export function toDecimal4(value: string): string | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number.toFixed(4);
}

/** Whole rupiah from a number input; null for empty/invalid. */
export function toWholeRupiah(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isSafeInteger(number)) return null;
  if (number < 0) return null;
  return number;
}

/** Menu ids disabled by the OPS-04 mapping, per the contract machine. */
export function disabledMenuIds(equipment: readonly Equipment[]): Set<string> {
  const disabled = new Set<string>();
  for (const row of equipment)
    for (const menuId of menuItemsDisabledByEquipment(row))
      disabled.add(menuId);
  return disabled;
}
