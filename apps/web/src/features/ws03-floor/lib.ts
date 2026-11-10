// Pure helpers for the WS-03 floor board: zone grouping, filters, seat
// duration labels and which staff actions a table row allows. No React and no
// `@/` imports, so a Node test can load this file directly.
//
// Business rules live in the contract (@starter/shared/qr-order): the board
// status (tableBoardStatus), the ORD-10 guard and the operation guards. This
// module only shapes what the screen shows.
import type { MessageKey, Translate } from "@starter/shared/i18n";
import {
  TABLE_BOARD_STATUSES,
  isOperableSession,
  tableBoardStatus,
  tableSeatMinutes,
  type TableBoardStatus,
  type TableLiveStatus,
  type TableSessionSummary,
  type FloorZone,
} from "@starter/shared/qr-order";

export type ZoneFilter = { zoneId: string | null; query: string };

export function zoneById(
  zones: readonly FloorZone[],
  zoneId: string,
): FloorZone | undefined {
  return zones.find((zone) => zone.id === zoneId);
}

export function zoneLabel(zone: FloorZone | undefined, fallback: string) {
  return zone?.name ?? fallback;
}

/** Board rows of one zone, or every row when `zoneId` is null. */
export function rowsOfZone(
  rows: readonly TableLiveStatus[],
  zoneId: string | null,
): TableLiveStatus[] {
  return zoneId === null
    ? [...rows]
    : rows.filter((row) => row.table.zoneId === zoneId);
}

export function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase("id-ID");
}

/** Filter by zone and table code; sorting stays the floor plan's order. */
export function filterBoard(
  rows: readonly TableLiveStatus[],
  filter: ZoneFilter,
): TableLiveStatus[] {
  const needle = normalizeQuery(filter.query);
  return rowsOfZone(rows, filter.zoneId).filter(
    (row) => needle === "" || normalizeQuery(row.table.code).includes(needle),
  );
}

/** Counts per zone for the tabs; a closed zone still shows its table count. */
export function zoneCounts(
  rows: readonly TableLiveStatus[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows)
    counts.set(row.table.zoneId, (counts.get(row.table.zoneId) ?? 0) + 1);
  return counts;
}

export function boardCounts(
  rows: readonly TableLiveStatus[],
): Record<TableBoardStatus, number> {
  const counts = Object.fromEntries(
    TABLE_BOARD_STATUSES.map((status) => [status, 0]),
  ) as Record<TableBoardStatus, number>;
  for (const row of rows) counts[tableBoardStatus(row)] += 1;
  return counts;
}

/**
 * A waiter call is the floor signal that needs action now (DESIGN v2 Q25).
 * "Late" has no contract signal on the board yet, so only the call marks a
 * table urgent; adding a seat-time threshold would invent a business rule.
 */
export function isTableUrgent(row: TableLiveStatus): boolean {
  return row.openServiceRequestCount > 0;
}

/** Tables with an open waiter call, for the board's "Perlu tindakan" strip. */
export function urgentTableCount(rows: readonly TableLiveStatus[]): number {
  return rows.filter(isTableUrgent).length;
}

export type TableTileLook = {
  /** Surface the tile sits on (DESIGN.md v2 "Operations — status hierarchy"). */
  surface: "card" | "surface-2" | "surface-3";
  /** Solid pill + 2px border + 6px start rule (Q25). */
  urgent: boolean;
  /** Tint pill on `surface-3`, e.g. a requested bill (calm attention). */
  calm: boolean;
  /** Cleaning tiles use a dashed border. */
  dashed: boolean;
  /** Inactive tiles are muted. */
  muted: boolean;
};

/**
 * Tile treatment for one board row. Empty = card + border; occupied =
 * `surface-3`, no border; cleaning = dashed; inactive = `surface-2`, muted;
 * bill requested = calm attention on `surface-3`; urgent wins over all
 * (DESIGN v2, owner Q25/Q27).
 */
export function tableTileLook(row: TableLiveStatus): TableTileLook {
  const status = tableBoardStatus(row);
  const occupied =
    status === "seated" ||
    status === "awaiting_order" ||
    status === "awaiting_bill" ||
    status === "awaiting_confirmation";
  return {
    surface:
      status === "inactive" ? "surface-2" : occupied ? "surface-3" : "card",
    urgent: isTableUrgent(row),
    calm: status === "awaiting_bill",
    dashed: status === "needs_cleaning",
    muted: status === "inactive",
  };
}

/** "1 j 5 mnt" / "12 mnt"; a table without a session has no duration. */
export function seatDurationLabel(
  minutes: number | null,
  t: Translate,
): string | null {
  if (minutes === null) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0
    ? t("floor.durationHours", { hours, minutes: rest })
    : t("floor.durationShort", { minutes: rest });
}

export function seatDurationOf(
  row: TableLiveStatus,
  now: Date | string,
  t: Translate,
): string | null {
  return seatDurationLabel(tableSeatMinutes(row, now), t);
}

export function boardStatusLabel(
  status: TableBoardStatus,
  t: Translate,
): string {
  return t(`floor.status.${status}`);
}

export function paymentModeLabel(
  mode: TableSessionSummary["paymentMode"],
  t: Translate,
): string {
  return t(`floor.paymentMode.${mode}`);
}

/**
 * Tables a session may move to: empty, same payment mode (the session keeps
 * the mode snapshot from PRD "Mode Bayar"), never the current table.
 */
export function moveTargets(
  rows: readonly TableLiveStatus[],
  zones: readonly FloorZone[],
  current: TableLiveStatus,
): TableLiveStatus[] {
  const session = current.session;
  if (!session) return [];
  return rows.filter((row) => {
    if (row.table.id === current.table.id) return false;
    if (row.table.status !== "available" || row.session) return false;
    const zone = zoneById(zones, row.table.zoneId);
    return zone?.paymentMode === session.paymentMode;
  });
}

export type SessionRow = {
  row: TableLiveStatus;
  session: TableSessionSummary;
};

/** Other running sessions in the outlet (merge source, item target). */
export function otherSessionRows(
  rows: readonly TableLiveStatus[],
  sessionId: string,
): SessionRow[] {
  return rows.flatMap((row) =>
    row.session &&
    row.session.id !== sessionId &&
    isOperableSession(row.session)
      ? [{ row, session: row.session }]
      : [],
  );
}

export type RowActions = {
  confirmSession: boolean;
  closeSession: boolean;
  markClean: boolean;
  reserve: boolean;
  releaseReservation: boolean;
  deactivate: boolean;
  activate: boolean;
  moveSession: boolean;
  mergeTables: boolean;
  moveItems: boolean;
  splitBill: boolean;
  convertOpenBill: boolean;
};

/** Which buttons the action sheet offers for one row (guards stay server-side). */
export function rowActions(row: TableLiveStatus): RowActions {
  const status = tableBoardStatus(row);
  const session = row.session;
  const running = session !== null && isOperableSession(session);
  return {
    confirmSession: session?.status === "pending_confirmation",
    closeSession: session !== null && session.status !== "pending_confirmation",
    markClean: status === "needs_cleaning",
    reserve: status === "available",
    releaseReservation: status === "reserved",
    deactivate: status === "available" || status === "reserved",
    activate: status === "inactive",
    moveSession: running,
    mergeTables: running,
    moveItems: running && session !== null && session.billTotalIdr > 0,
    splitBill: running && session !== null && session.billTotalIdr > 0,
    convertOpenBill: running && session?.paymentMode === "pay_first",
  };
}

/**
 * Catalog key for a failed action. Domain codes from the contract win; the
 * network and unknown failures fall back to a generic, retry-oriented text.
 */
export function floorActionErrorKey(error: unknown): MessageKey {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  switch (code) {
    case "TABLE_BILL_OUTSTANDING":
      return "floor.error.billOutstanding";
    case "TABLE_SESSION_ACTIVE":
      return "floor.error.sessionActive";
    case "TABLE_STATUS_CONFLICT":
      return "floor.error.conflict";
    // A paid share locks merge, item moves and re-split (decision C2).
    case "TABLE_SESSION_PAID":
    case "SPLIT_LOCKED":
      return "floor.error.sessionPaid";
    case "NETWORK_ERROR":
      return "floor.error.generic";
    case "CONFLICT":
      return "floor.error.conflict";
    default:
      return "floor.error.generic";
  }
}

export { tableBoardStatus, tableSeatMinutes };
