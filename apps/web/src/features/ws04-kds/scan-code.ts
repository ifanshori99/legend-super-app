// KDS scanner codes (bead legend-uqfu). A keyboard-wedge scanner types
// `<AKSI> <TIKET>` and presses Enter, e.g. `SELESAI 8S9T0V`. Pure logic: no
// React and no `@/` alias, so tests/kds-scan-code.test.mjs loads it with plain
// Node ESM. The status rules come from the shared kitchen contract; nothing
// here invents a transition.
import { canTransitionKitchenTicket } from "@starter/shared/kitchen";
import type { KitchenTicketStatus } from "@starter/shared/kitchen";

export type ScanAction = "start" | "bump" | "priority" | "recall";

/** The action words printed on the scan sheet. */
export const SCAN_ACTIONS: Readonly<Record<string, ScanAction>> = {
  MULAI: "start",
  SELESAI: "bump",
  PRIORITAS: "priority",
  PANGGIL: "recall",
};

/** The code a ticket header shows: its per-day ticket number, `K-007`. */
export function ticketScanCode(ticketNo: number): string {
  return `K-${String(ticketNo).padStart(3, "0")}`;
}

export type ParsedScan =
  | { ok: true; action: ScanAction; code: string }
  | { ok: false; reason: "empty" | "format" | "unknown-action" };

/** Trim and uppercase, then split into exactly an action word and a ticket code. */
export function parseScanCode(raw: string): ParsedScan {
  const text = raw.trim().toUpperCase();
  if (text === "") return { ok: false, reason: "empty" };
  const parts = text.split(/\s+/);
  if (parts.length !== 2) return { ok: false, reason: "format" };
  const [word = "", rawCode = ""] = parts;
  const action = Object.hasOwn(SCAN_ACTIONS, word)
    ? SCAN_ACTIONS[word]
    : undefined;
  if (action === undefined) return { ok: false, reason: "unknown-action" };
  const code = rawCode.replace(/^#/, "");
  if (code === "") return { ok: false, reason: "format" };
  return { ok: true, action, code };
}

export type ScanTicket = {
  id: string;
  ticketNo: number;
  status: KitchenTicketStatus;
};

export type ScanResolution<T extends ScanTicket> =
  | { ok: true; action: ScanAction; ticket: T }
  | {
      ok: false;
      reason: "empty" | "format" | "unknown-action" | "unknown-ticket";
    }
  /** The ticket exists but its status does not allow the action. */
  | { ok: false; reason: "invalid-status"; ticket: T };

/** Whether `action` may be applied to a ticket in `status` (priority: any live ticket). */
export function canScanAction(
  status: KitchenTicketStatus,
  action: ScanAction,
): boolean {
  if (action === "priority") return status !== "cancelled";
  return canTransitionKitchenTicket(status, action);
}

/**
 * Match a scan to one ticket of the current station board. A code that fits
 * no ticket or more than one is refused, as is an action the ticket's status does not allow.
 */
export function resolveScan<T extends ScanTicket>(
  raw: string,
  tickets: readonly T[],
): ScanResolution<T> {
  const parsed = parseScanCode(raw);
  if (!parsed.ok) return parsed;
  const matches = tickets.filter(
    (ticket) => ticketScanCode(ticket.ticketNo) === parsed.code,
  );
  const ticket = matches.length === 1 ? matches[0] : undefined;
  if (ticket === undefined) return { ok: false, reason: "unknown-ticket" };
  if (!canScanAction(ticket.status, parsed.action))
    return { ok: false, reason: "invalid-status", ticket };
  return { ok: true, action: parsed.action, ticket };
}

/** A ticket still on the board's queue (not done, not cancelled). */
export function isOpenTicket(ticket: Pick<ScanTicket, "status">): boolean {
  return ticket.status !== "done" && ticket.status !== "cancelled";
}

const SCAN_ACTION_LIST = Object.values(SCAN_ACTIONS);

/** Whether any scan action can apply to at least one of these tickets. */
export function hasScannableTicket(
  tickets: readonly Pick<ScanTicket, "status">[],
): boolean {
  return tickets.some((ticket) =>
    SCAN_ACTION_LIST.some((action) => canScanAction(ticket.status, action)),
  );
}

/** The first ticket a SELESAI scan can finish, to build a live example. */
export function exampleScanTicket<T extends ScanTicket>(
  tickets: readonly T[],
): T | undefined {
  return tickets.find((ticket) => canScanAction(ticket.status, "bump"));
}
