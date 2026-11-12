// Pure logic of the platform restore screen (bead legend-nb4iy; Q40, restore
// an archived tenant or a closed outlet within 30 days). No React, no `@/`
// aliases and no TypeScript-only runtime syntax, so the unit test loads it
// directly with native Node type stripping.
//
// The server decides `restorable` against its own clock; this file only turns
// the window read model and API errors into the states the mockup shows.

export const RESTORE_REASON_MIN = 10;
export const RESTORE_REASON_MAX = 500;
export const RESTORE_WINDOW_DAYS = 30;

export type RestoreKind = "tenant" | "outlet";

/** The parts of the tenant / outlet restore-window DTO the screen reads. */
export type RestoreWindowLike = {
  status: string;
  archivedAt?: string | null;
  closedAt?: string | null;
  restoreTo: string | null;
  restorableUntil: string | null;
  restorable: boolean;
};

/** The status a record must hold before it can be restored. */
const RESTORABLE_FROM: Record<RestoreKind, string> = {
  tenant: "archived",
  outlet: "closed",
};

export type RestoreView =
  /** Not archived / closed: nothing to restore (mockup "empty"). */
  | { kind: "none" }
  /** Inside the 30 days: review, then confirm (mockup "normal"). */
  | {
      kind: "restorable";
      restoreTo: string;
      changedAt: string | null;
      restorableUntil: string | null;
    }
  /** Outlet inside its window, but the parent tenant is archived: restore the tenant first. */
  | {
      kind: "parent_archived";
      changedAt: string | null;
      restorableUntil: string | null;
    }
  /** Past 30 days, or the change time was never recorded: final ("expired"). */
  | {
      kind: "expired";
      changedAt: string | null;
      restorableUntil: string | null;
    };

/**
 * `restorable` is the server's answer and the only way to open the confirm
 * step. A window that says restorable but names no target status is treated as
 * final: restoring to an unknown status would be a guess.
 *
 * The server also answers `restorable: false` for a closed outlet whose parent
 * tenant is archived. That is not "expired": the window may still be open, so
 * an outlet whose `parentStatus` is archived reads as `parent_archived` unless
 * its own deadline has really passed (`now`, default the current time).
 */
export function restoreView(
  kind: RestoreKind,
  window: RestoreWindowLike,
  parentStatus?: string | null,
  now: Date = new Date(),
): RestoreView {
  if (window.status !== RESTORABLE_FROM[kind]) return { kind: "none" };
  const changedAt =
    (kind === "tenant" ? window.archivedAt : window.closedAt) ?? null;
  if (window.restorable && window.restoreTo)
    return {
      kind: "restorable",
      restoreTo: window.restoreTo,
      changedAt,
      restorableUntil: window.restorableUntil,
    };
  if (kind === "outlet" && parentStatus === "archived" && window.restoreTo) {
    const until = window.restorableUntil
      ? new Date(window.restorableUntil)
      : null;
    if (
      until &&
      !Number.isNaN(until.getTime()) &&
      until.getTime() >= now.getTime()
    )
      return {
        kind: "parent_archived",
        changedAt,
        restorableUntil: window.restorableUntil,
      };
  }
  return {
    kind: "expired",
    changedAt,
    restorableUntil: window.restorableUntil,
  };
}

export type ReasonProblem = "required" | "too_long";

/** Reason rule of the contract (`reasonSchema`): trimmed, 10 to 500 characters. */
export function validateRestoreReason(
  reason: string,
): { ok: true; value: string } | { ok: false; problem: ReasonProblem } {
  const value = reason.trim();
  if (value.length < RESTORE_REASON_MIN)
    return { ok: false, problem: "required" };
  if (value.length > RESTORE_REASON_MAX)
    return { ok: false, problem: "too_long" };
  return { ok: true, value };
}

export type RestoreFailure =
  /** 409 RESTORE_WINDOW_EXPIRED: the window closed while the form was open. */
  | "expired"
  /** 409 RESTORE_NOT_AVAILABLE: already restored or no longer available. */
  | "not_available"
  /** 409 INVALID_TRANSITION on an outlet: the parent tenant is still archived. */
  | "parent_archived"
  /** 401 / 403: the security check failed. */
  | "blocked"
  | "network"
  | "unknown";

/** Duck-typed on `status` and `code`, so tests pass plain objects. */
export function classifyRestoreError(
  error: unknown,
  kind: RestoreKind = "tenant",
): RestoreFailure {
  const e = (error ?? {}) as { status?: unknown; code?: unknown };
  if (e.code === "RESTORE_WINDOW_EXPIRED") return "expired";
  if (e.code === "INVALID_TRANSITION")
    return kind === "outlet" ? "parent_archived" : "not_available";
  if (e.code === "RESTORE_NOT_AVAILABLE") return "not_available";
  if (e.status === 401 || e.status === 403) return "blocked";
  if (e.code === "NETWORK_ERROR") return "network";
  return "unknown";
}

const dateFormat = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeZone: "Asia/Jakarta",
});

/** "1 Nov 2026" in Jakarta time; "-" when the time is missing or invalid. */
export function formatRestoreDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "-" : dateFormat.format(date);
}
