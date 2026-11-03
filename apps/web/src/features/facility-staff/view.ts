// Pure view helpers for the staff facility screens: status → pill/look,
// grouping, counts, timing and the incident sort. Keeping them here lets the
// components stay small and the same rule apply on every screen (DESIGN.md §4
// "Operations — status hierarchy", FAC-06).
import * as React from "react";
import type { MessageKey } from "@starter/shared/i18n";
import {
  CLEANING_CHECKLIST_KEYS,
  isUnitBookable,
  type CleaningChecklistItem,
  type CleaningTask,
  type FacilityArea,
  type FacilityIncident,
  type FacilityIncidentType,
  type FacilityUnitBoardRow,
  type FacilityUnitStatus,
} from "@starter/shared/facility";
import { formatClock } from "../facility/flow.ts";
import type { StatusKind } from "@/components/ui/badge";

export type StaffScreenKey = "board" | "cleaning" | "incidents" | "emergency";

// The design system has no plain-neutral status pill (see ws10-payroll-run);
// `info` is the quietest tone, so maintenance reads as information, not action.
export type { StatusKind };

type UnitStatusMeta = {
  readonly labelKey: MessageKey;
  readonly tone: StatusKind;
};

export const UNIT_STATUS_META: Record<FacilityUnitStatus, UnitStatusMeta> = {
  available: {
    labelKey: "facilityStaff.board.status.available",
    tone: "success",
  },
  in_use: {
    labelKey: "facilityStaff.board.status.inUse",
    tone: "info",
  },
  needs_cleaning: {
    labelKey: "facilityStaff.board.status.needsCleaning",
    tone: "warning",
  },
  cleaning: {
    labelKey: "facilityStaff.board.status.cleaning",
    tone: "info",
  },
  maintenance: {
    labelKey: "facilityStaff.board.status.maintenance",
    tone: "info",
  },
};

/** The tile surface follows the state (DESIGN.md §4: Q25/Q27, cleaning=dashed). */
export type UnitTileLook = {
  readonly surface: string;
  readonly muted: boolean;
};

export const UNIT_TILE_LOOK: Record<FacilityUnitStatus, UnitTileLook> = {
  available: {
    surface: "border-(length:--border-w) border-border bg-card",
    muted: false,
  },
  in_use: {
    surface: "bg-surface-3",
    muted: false,
  },
  needs_cleaning: {
    // Urgent: 2px border plus a 6px start rule in the status colour (Q25).
    surface: "border-2 border-warning border-s-[6px] bg-card",
    muted: false,
  },
  cleaning: {
    surface: "border-(length:--border-w) border-dashed border-input bg-card",
    muted: false,
  },
  maintenance: {
    surface: "border-(length:--border-w) border-border bg-surface-2",
    muted: true,
  },
};

export type AreaGroup = {
  readonly area: FacilityArea;
  readonly rows: FacilityUnitBoardRow[];
};

export function groupRowsByArea(
  rows: readonly FacilityUnitBoardRow[],
  areas: readonly FacilityArea[],
): AreaGroup[] {
  return [...areas]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((area) => ({
      area,
      rows: rows
        .filter((row) => row.unit.areaId === area.id)
        .sort((a, b) => a.unit.sortOrder - b.unit.sortOrder),
    }))
    .filter((group) => group.rows.length > 0);
}

export type BoardCounts = {
  readonly available: number;
  readonly inUse: number;
  readonly cleaning: number;
  readonly maintenance: number;
  /** The urgent count on the "Perlu tindakan" strip (Q25). */
  readonly urgent: number;
};

export function boardCounts(
  rows: readonly FacilityUnitBoardRow[],
): BoardCounts {
  const byStatus = (status: FacilityUnitStatus) =>
    rows.filter((row) => row.unit.status === status).length;
  // FAC-06 owns the rule: only a clean, available unit can be booked.
  const available = rows.filter((row) =>
    isUnitBookable(row.unit.status),
  ).length;
  return {
    available,
    inUse: byStatus("in_use"),
    cleaning: byStatus("cleaning"),
    maintenance: byStatus("maintenance"),
    urgent: byStatus("needs_cleaning"),
  };
}

/**
 * The due cleaning tasks on the board: one open task per dirty unit. A unit
 * flagged for maintenance keeps its open task but cannot be cleaned until it is
 * released (the unit machine refuses start/complete), so it is not "due".
 */
export function dueCleaningTasks(
  rows: readonly FacilityUnitBoardRow[],
): { row: FacilityUnitBoardRow; task: CleaningTask }[] {
  return rows.flatMap((row) =>
    row.cleaningTask &&
    row.cleaningTask.completedAt === null &&
    (row.unit.status === "needs_cleaning" || row.unit.status === "cleaning")
      ? [{ row, task: row.cleaningTask }]
      : [],
  );
}

export function areaName(
  areas: readonly FacilityArea[],
  areaId: string,
): string {
  return areas.find((area) => area.id === areaId)?.name ?? "";
}

export function clock(instant: string, timeZone: string): string {
  return formatClock(instant, timeZone);
}

/**
 * Minutes left in the running session, counted from the board's server clock
 * (the device clock is not trusted, same rule as the guest ticket timer).
 */
export function remainingMinutes(
  scheduledEndsAt: string,
  serverTime: string,
): number {
  const left = Date.parse(scheduledEndsAt) - Date.parse(serverTime);
  return Math.max(0, Math.ceil(left / 60_000));
}

/** FAC-06 + PRD §3 F22: after the session and its cleaning buffer. */
export function nextAvailableAt(
  scheduledEndsAt: string,
  cleaningMinutes: number,
): string {
  return new Date(
    Date.parse(scheduledEndsAt) + cleaningMinutes * 60_000,
  ).toISOString();
}

export const CHECKLIST_LABEL_KEYS: Record<
  CleaningChecklistItem["key"],
  MessageKey
> = {
  floor: "facilityStaff.cleaning.checklist.floor",
  drain: "facilityStaff.cleaning.checklist.drain",
  supplies: "facilityStaff.cleaning.checklist.supplies",
  trash: "facilityStaff.cleaning.checklist.trash",
};

export const CHECKLIST_KEYS = CLEANING_CHECKLIST_KEYS;
export type CleaningChecklistKey = (typeof CLEANING_CHECKLIST_KEYS)[number];

export const INCIDENT_TYPE_KEYS: Record<FacilityIncidentType, MessageKey> = {
  panic: "facilityStaff.incident.type.panic",
  assist: "facilityStaff.incident.type.assist",
  damage: "facilityStaff.incident.type.damage",
};

export const INCIDENT_TYPE_TONE: Record<
  FacilityIncidentType,
  "danger" | "warning" | "info"
> = {
  panic: "danger",
  assist: "info",
  damage: "warning",
};

/** Open incidents first (FAC-08), then newest first. */
export function sortIncidentLog(
  incidents: readonly FacilityIncident[],
): FacilityIncident[] {
  return [...incidents].sort((a, b) => {
    const openA = a.respondedAt === null;
    const openB = b.respondedAt === null;
    if (openA !== openB) return openA ? -1 : 1;
    return Date.parse(b.triggeredAt) - Date.parse(a.triggeredAt);
  });
}

/**
 * PRD v1.7 §4 Alur V: the emergency screen carries the booth panic button and
 * the ticket-screen help button. A damage report is a maintenance matter and
 * stays in the incident log, so it never raises the alarm state.
 */
export function isEmergencySignal(incident: FacilityIncident): boolean {
  return incident.type === "panic" || incident.type === "assist";
}

/** Oldest unanswered signal first: it waited longest. */
export function sortActiveAlerts(
  incidents: readonly FacilityIncident[],
): FacilityIncident[] {
  return incidents
    .filter((incident) => incident.respondedAt === null)
    .sort((a, b) => Date.parse(a.triggeredAt) - Date.parse(b.triggeredAt));
}

/** FAC-08: seconds between the signal and staff acknowledgement. */
export function responseSeconds(incident: FacilityIncident): number | null {
  if (incident.respondedAt === null) return null;
  return Math.max(
    0,
    Math.round(
      (Date.parse(incident.respondedAt) - Date.parse(incident.triggeredAt)) /
        1_000,
    ),
  );
}

/**
 * Elapsed seconds of a signal, ticking once per second. The first render (and
 * the server render) uses the response's own `serverTime`, so hydration cannot
 * drift; the tick resets whenever a new server clock arrives.
 */
export function useElapsedSeconds(
  triggeredAt: string,
  serverTime: string,
): number {
  const base = Math.max(
    0,
    Math.floor((Date.parse(serverTime) - Date.parse(triggeredAt)) / 1_000),
  );
  const [tick, setTick] = React.useState({ anchor: serverTime, seconds: 0 });
  React.useEffect(() => {
    const id = window.setInterval(() => {
      setTick((previous) =>
        previous.anchor === serverTime
          ? { anchor: serverTime, seconds: previous.seconds + 1 }
          : { anchor: serverTime, seconds: 1 },
      );
    }, 1_000);
    return () => window.clearInterval(id);
  }, [serverTime]);
  return base + (tick.anchor === serverTime ? tick.seconds : 0);
}
