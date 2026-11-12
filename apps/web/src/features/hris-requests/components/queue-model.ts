// Pure logic of the supervisor queue screens (bead legend-ydf2, 539-U4 row E):
// filtering, which decision needs a reason, who may decide which kind, and the
// message key of a failed decision. Kept free of React so node:test covers it.
import type { MessageKey } from "@starter/shared/i18n";
import type { RequestQueueItem } from "../queue.ts";

export const QUEUE_KINDS = ["swap", "cover", "leave", "overtime"] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

export function isQueueKind(value: string): value is QueueKind {
  return (QUEUE_KINDS as readonly string[]).includes(value);
}

export const KIND_LABEL_KEYS: Record<QueueKind, MessageKey> = {
  swap: "hrisRequestsQueue.kind.swap",
  cover: "hrisRequestsQueue.kind.cover",
  leave: "hrisRequestsQueue.kind.leave",
  overtime: "hrisRequestsQueue.kind.overtime",
};

const STATUS_LABEL_KEYS: Record<string, MessageKey> = {
  pending: "hrisRequestsQueue.status.pending",
  approved: "hrisRequestsQueue.status.approved",
  rejected: "hrisRequestsQueue.status.rejected",
  cancelled: "hrisRequestsQueue.status.cancelled",
  expired: "hrisRequestsQueue.status.expired",
};

/** Label key of a request status; an unknown status reads as pending review. */
export function statusLabelKey(status: string): MessageKey {
  return STATUS_LABEL_KEYS[status] ?? "hrisRequestsQueue.status.pending";
}

/** Tone of the status pill: waiting is a warning, a decision is final. */
export function statusTone(status: string): "warning" | "success" | "danger" {
  if (status === "approved") return "success";
  if (status === "rejected" || status === "expired" || status === "cancelled")
    return "danger";
  return "warning";
}

/** Case-insensitive search on the employee name; a blank term keeps all. */
export function filterQueue<T extends Pick<RequestQueueItem, "employeeName">>(
  items: readonly T[],
  term: string,
): readonly T[] {
  const needle = term.trim().toLowerCase();
  if (needle === "") return items;
  return items.filter((item) =>
    (item.employeeName ?? "").toLowerCase().includes(needle),
  );
}

/** HR-05: a swap or cover that breaks the working-hour rules needs an override. */
export function needsOverride(
  item: Pick<RequestQueueItem, "kind" | "complianceIssues">,
): boolean {
  return (
    (item.kind === "swap" || item.kind === "cover") &&
    (item.complianceIssues?.length ?? 0) > 0
  );
}

export type DecisionPlan =
  | { ok: true; reason: string | undefined }
  | { ok: false; error: "overrideRequired" };

/**
 * Validates a decision before it is sent. The API stores no rejection reason for
 * any kind, so a rejection asks none; an approval needs a reason only as the
 * override reason of a rule-breaking swap. The reason is trimmed, so blank text
 * never counts.
 */
export function planDecision(
  item: Pick<RequestQueueItem, "kind" | "complianceIssues">,
  decision: "approve" | "reject",
  reasonInput: string,
): DecisionPlan {
  const reason = reasonInput.trim();
  if (decision === "reject") return { ok: true, reason: undefined };
  if (needsOverride(item))
    return reason === ""
      ? { ok: false, error: "overrideRequired" }
      : { ok: true, reason };
  return { ok: true, reason: undefined };
}

/** Permission that lets a supervisor decide each kind (API re-checks it). */
export const DECIDE_PERMISSIONS = {
  swap: "hr.schedule.manage",
  cover: "hr.schedule.manage",
  leave: "hr.leave.approve",
  overtime: "hr.overtime.approve",
} as const satisfies Record<QueueKind, string>;

export const QUEUE_ANY_PERMISSION = [
  "hr.schedule.manage",
  "hr.leave.approve",
  "hr.overtime.approve",
] as const;

export function canDecideKind(
  kind: QueueKind,
  permissions: readonly string[],
): boolean {
  return permissions.includes(DECIDE_PERMISSIONS[kind]);
}

/** Reason text the employee wrote (leave and overtime carry one; a swap not). */
export function requestReason(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const reason = (raw as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() !== "" ? reason : null;
}

/** Message key of the compliance issue code; unknown codes get no line. */
export function complianceIssueKey(code: string): MessageKey | null {
  switch (code) {
    case "shift_too_long":
    case "daily_limit_exceeded":
    case "weekly_limit_exceeded":
    case "insufficient_rest":
    case "overlapping_shift":
    case "too_many_consecutive_days":
      return `hrisRequestsQueue.compliance.${code}`;
    default:
      return null;
  }
}

/** True for a request that never reached the server (no connection). */
export function isNetworkFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 0 || code === "NETWORK_ERROR";
}

/** Message key of a failed decision; a network failure has its own panel. */
export function queueErrorKey(error: unknown): MessageKey {
  if (typeof error === "object" && error !== null) {
    const { status } = error as { status?: unknown };
    if (status === 403) return "hrisRequestsQueue.errors.forbidden";
    if (status === 404) return "hrisRequestsQueue.errors.notFound";
    if (status === 409) return "hrisRequestsQueue.errors.conflict";
  }
  return "hrisRequestsQueue.errors.unknown";
}

/** "18 Nov 2026, 09.30" in the business time zone, stable on server and client. */
export function formatSubmittedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
