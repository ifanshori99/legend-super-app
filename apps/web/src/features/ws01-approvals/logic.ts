// Pure logic of the approval inbox (PRD v1.7 §3 F7 "Kotak Approval", F36, F38
// "Draf Aksi"; AUTH-06 distinct actor; MCP-04). No React and no `@/` alias, so
// the unit tests load this file with plain Node ESM. Authorization stays in
// the API; these helpers only shape what the screens show and decide which
// controls to disable so a user sees the reason before the API refuses.
import {
  APPROVAL_ACTION_TYPES,
  type ApprovalActionType,
  type ApprovalSource,
} from "@starter/shared/access";
import type {
  ApprovalInboxQuery,
  ApprovalRequest,
  ApprovalRequestStatus,
} from "@starter/shared/identity";
import { formatNumber, formatRupiah } from "@starter/shared/i18n";
import type { MessageKey } from "@starter/shared/i18n";

// ------------------------------------------------------------------ modules

/** The module an approval belongs to; the inbox filter groups action types. */
export const APPROVAL_MODULES = [
  "pos",
  "finance",
  "inventory",
  "menu",
  "people",
  "owner",
  "automation",
] as const;
export type ApprovalModule = (typeof APPROVAL_MODULES)[number];

/** Exhaustive on purpose: a new action type must pick a module to compile. */
export const ACTION_MODULE: Readonly<
  Record<ApprovalActionType, ApprovalModule>
> = {
  void: "pos",
  discount: "pos",
  refund: "pos",
  cash_drawer_open: "pos",
  price_correction: "pos",
  cash_shift_close: "pos",
  apology_voucher: "pos",
  expense: "finance",
  supplier_payment: "finance",
  unallocated_funds: "finance",
  manual_journal: "finance",
  period_reopen: "finance",
  purchase_order: "inventory",
  purchase_request: "inventory",
  stock_adjustment: "inventory",
  price_change: "menu",
  payroll: "people",
  payroll_cancel: "people",
  attendance_correction: "people",
  shift_swap: "people",
  leave: "people",
  overtime: "people",
  employee_loan: "people",
  reimbursement: "people",
  dividend_distribution: "owner",
  shareholder_version: "owner",
  personal_data_export: "owner",
  ai_action: "automation",
  mcp_action: "automation",
};

export const ALL_ACTION_TYPES: readonly ApprovalActionType[] =
  APPROVAL_ACTION_TYPES;

export function moduleOf(actionType: ApprovalActionType): ApprovalModule {
  return ACTION_MODULE[actionType];
}

export function actionLabelKey(actionType: ApprovalActionType): MessageKey {
  return `approvals.action.${actionType}` as MessageKey;
}

export function moduleLabelKey(module: ApprovalModule): MessageKey {
  return `approvals.module.${module}` as MessageKey;
}

export const SOURCES: readonly ApprovalSource[] = ["user", "ai", "mcp"];

export const STATUSES: readonly ApprovalRequestStatus[] = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
];

export function statusLabelKey(status: ApprovalRequestStatus): MessageKey {
  return `approvals.status.${status}` as MessageKey;
}

export function sourceLabelKey(source: ApprovalSource): MessageKey {
  return `approvals.source.${source}` as MessageKey;
}

// ----------------------------------------------------------------- deadline

/** A pending request this close to its deadline is flagged urgent. */
export const URGENT_WITHIN_MS = 15 * 60_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type DeadlineState =
  /** Pending and the deadline passed: the action stays blocked (fail closed). */
  | "overdue"
  | "urgent"
  | "open"
  /** Not pending any more; the deadline no longer counts down. */
  | "closed";

export type DeadlineUnit = "minute" | "hour" | "day";

export type DeadlineInfo = {
  state: DeadlineState;
  unit: DeadlineUnit;
  amount: number;
  /** Signed: positive = time left, negative = time past. */
  remainingMs: number;
};

export function splitDuration(ms: number): {
  unit: DeadlineUnit;
  amount: number;
} {
  const abs = Math.abs(ms);
  if (abs < HOUR)
    return { unit: "minute", amount: Math.max(1, Math.ceil(abs / MINUTE)) };
  if (abs < DAY) return { unit: "hour", amount: Math.floor(abs / HOUR) };
  return { unit: "day", amount: Math.floor(abs / DAY) };
}

export function deadlineInfo(
  request: Pick<ApprovalRequest, "status" | "deadlineAt">,
  now: number,
): DeadlineInfo {
  const remainingMs = Date.parse(request.deadlineAt) - now;
  const { unit, amount } = splitDuration(remainingMs);
  let state: DeadlineState = "open";
  if (request.status !== "pending") state = "closed";
  else if (remainingMs <= 0) state = "overdue";
  else if (remainingMs <= URGENT_WITHIN_MS) state = "urgent";
  return { state, unit, amount, remainingMs };
}

/** Catalog key for the countdown line: "Sisa {amount} mnt" / "Terlambat …". */
export function deadlineLabelKey(info: DeadlineInfo): MessageKey {
  const side = info.state === "overdue" ? "late" : "left";
  return `approvals.deadline.${side}.${info.unit}` as MessageKey;
}

// ------------------------------------------------------------------ filters

export const DEADLINE_FILTERS = [
  "all",
  "overdue",
  "within1h",
  "within24h",
] as const;
export type DeadlineFilter = (typeof DEADLINE_FILTERS)[number];

export type InboxFilters = {
  status: ApprovalRequestStatus | "all";
  source: ApprovalSource | "all";
  module: ApprovalModule | "all";
  deadline: DeadlineFilter;
};

export const DEFAULT_FILTERS: InboxFilters = Object.freeze({
  status: "pending",
  source: "all",
  module: "all",
  deadline: "all",
});

export const INBOX_PAGE_SIZE = 50;

/** Status and source narrow on the server; module and deadline narrow here. */
export function toServerQuery(
  filters: InboxFilters,
  limit: number = INBOX_PAGE_SIZE,
): Omit<ApprovalInboxQuery, "cursor"> {
  return {
    limit,
    ...(filters.status === "all" ? {} : { status: filters.status }),
    ...(filters.source === "all" ? {} : { source: filters.source }),
  };
}

export function matchesDeadline(
  request: Pick<ApprovalRequest, "status" | "deadlineAt">,
  filter: DeadlineFilter,
  now: number,
): boolean {
  if (filter === "all") return true;
  if (request.status !== "pending") return false;
  const remaining = Date.parse(request.deadlineAt) - now;
  if (filter === "overdue") return remaining <= 0;
  if (filter === "within1h") return remaining > 0 && remaining <= HOUR;
  return remaining > 0 && remaining <= DAY;
}

export function applyClientFilters(
  rows: readonly ApprovalRequest[],
  filters: InboxFilters,
  now: number,
): ApprovalRequest[] {
  return rows.filter(
    (row) =>
      (filters.module === "all" ||
        moduleOf(row.actionType) === filters.module) &&
      matchesDeadline(row, filters.deadline, now),
  );
}

/** Pending first, most urgent deadline first; decided rows newest first. */
export function sortInbox(rows: readonly ApprovalRequest[]): ApprovalRequest[] {
  return [...rows].sort((a, b) => {
    const aPending = a.status === "pending";
    const bPending = b.status === "pending";
    if (aPending !== bPending) return aPending ? -1 : 1;
    if (aPending) return Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt);
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

export function filtersAreDefault(filters: InboxFilters): boolean {
  return (
    filters.status === DEFAULT_FILTERS.status &&
    filters.source === DEFAULT_FILTERS.source &&
    filters.module === DEFAULT_FILTERS.module &&
    filters.deadline === DEFAULT_FILTERS.deadline
  );
}

// ---------------------------------------------------------------- decisions

export type DecisionBlock =
  /** Already decided, expired or cancelled. */
  | "notPending"
  /** Pending but past its deadline: stays blocked (fail closed). */
  | "expired"
  | "permission"
  /** The signed-in user is not known yet, so the distinct-actor rule cannot be checked. */
  | "identity"
  /** AUTH-06: the requester never decides their own request. */
  | "own"
  /** The role needs MFA and no factor is enrolled yet (MFA_ENROLLMENT_REQUIRED). */
  | "enrollment";

export function isOwnRequest(
  request: Pick<ApprovalRequest, "requestedBy">,
  currentUserId: string | null | undefined,
): boolean {
  return (
    !!currentUserId &&
    request.requestedBy.toLowerCase() === currentUserId.toLowerCase()
  );
}

/** Why the approve/reject controls are disabled, or null when they are live. */
export function decisionBlock(input: {
  request: Pick<ApprovalRequest, "status" | "deadlineAt" | "requestedBy">;
  currentUserId: string | null | undefined;
  canDecide: boolean;
  mfaEnrollmentRequired?: boolean;
  now: number;
}): DecisionBlock | null {
  const { request, currentUserId, canDecide, now } = input;
  if (request.status !== "pending") return "notPending";
  if (Date.parse(request.deadlineAt) <= now) return "expired";
  if (!canDecide) return "permission";
  if (!currentUserId) return "identity";
  if (isOwnRequest(request, currentUserId)) return "own";
  if (input.mfaEnrollmentRequired) return "enrollment";
  return null;
}

export function decisionBlockKey(block: DecisionBlock): MessageKey {
  return `approvals.blocked.${block}` as MessageKey;
}

/** The session owes a second factor before it may decide (AUTH-05). */
export function needsStepUp(auth: {
  mfaRequired: boolean;
  session: { mfaVerifiedAt: string | null };
}): boolean {
  return auth.mfaRequired && auth.session.mfaVerifiedAt === null;
}

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** Mirrors approvalDecisionInputSchema: a trimmed reason of 3..500 chars. */
export function reasonProblem(reason: string): "short" | "long" | null {
  const length = reason.trim().length;
  if (length < REASON_MIN) return "short";
  if (length > REASON_MAX) return "long";
  return null;
}

/** Catalog key for an API error code (contracts: identity + access errors). */
export function errorMessageKey(code: string | undefined): MessageKey {
  switch (code) {
    case "APPROVAL_REQUEST_NOT_PENDING":
      return "approvals.errors.notPending";
    case "APPROVAL_REQUEST_EXPIRED":
      return "approvals.errors.expired";
    case "APPROVER_IS_REQUESTER":
      return "approvals.errors.approverIsRequester";
    case "APPROVER_ALREADY_DECIDED":
      return "approvals.errors.alreadyDecided";
    case "APPROVER_ROLE_MISMATCH":
      return "approvals.errors.roleMismatch";
    case "MFA_REQUIRED":
      return "approvals.errors.mfaRequired";
    case "MFA_ENROLLMENT_REQUIRED":
      return "approvals.errors.mfaEnrollment";
    case "FORBIDDEN":
    case "PERMISSION_DENIED":
      return "approvals.errors.forbidden";
    case "NOT_FOUND":
      return "approvals.errors.notFound";
    case "NETWORK_ERROR":
      return "approvals.errors.offline";
    default:
      return "approvals.errors.generic";
  }
}

/** Codes after which the screen should reload the request (it changed). */
export function errorMeansStale(code: string | undefined): boolean {
  return (
    code === "APPROVAL_REQUEST_NOT_PENDING" ||
    code === "APPROVAL_REQUEST_EXPIRED"
  );
}

// -------------------------------------------------------------------- diff

export type DiffRow = {
  /** Payload key, or the shared stem of a from/to pair (`fromIdr` + `toIdr` → `Idr`). */
  key: string;
  label: string;
  before: string | null;
  after: string;
  kind: "change" | "fact";
};

type Json = ApprovalRequest["payload"][string];

/** "differenceQty" → "Difference qty"; used when the catalog has no label. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function formatPayloadValue(
  key: string,
  value: Json | undefined,
  words: { yes: string; no: string; none: string },
): string {
  if (value === null || value === undefined) return words.none;
  if (typeof value === "boolean") return value ? words.yes : words.no;
  if (typeof value === "number") {
    return /idr$/i.test(key) ? formatRupiah(value) : formatNumber(value);
  }
  if (typeof value === "string") return value === "" ? words.none : value;
  return JSON.stringify(value);
}

/**
 * Turns the action payload into rows. A `fromX` + `toX` pair is a proposed
 * change (before → after, e.g. an AI price change); every other field is a
 * plain fact the approver should see. `labelOf` maps a key to catalog text.
 */
export function diffRows(
  payload: ApprovalRequest["payload"],
  labelOf: (key: string) => string,
  words: { yes: string; no: string; none: string },
): DiffRow[] {
  const rows: DiffRow[] = [];
  const paired = new Set<string>();
  for (const key of Object.keys(payload)) {
    const match = /^from([A-Z].*)$/.exec(key);
    const stem = match?.[1];
    if (!stem || !(`to${stem}` in payload)) continue;
    paired.add(key);
    paired.add(`to${stem}`);
    const name = stem.charAt(0).toLowerCase() + stem.slice(1);
    rows.push({
      key: stem,
      label: labelOf(name),
      before: formatPayloadValue(key, payload[key], words),
      after: formatPayloadValue(`to${stem}`, payload[`to${stem}`], words),
      kind: "change",
    });
  }
  for (const [key, value] of Object.entries(payload)) {
    if (paired.has(key)) continue;
    rows.push({
      key,
      label: labelOf(key),
      before: null,
      after: formatPayloadValue(key, value, words),
      kind: "fact",
    });
  }
  // Proposed changes first: they are what the approver is deciding on.
  return rows.sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "change" ? -1 : 1,
  );
}

/** First proposed change, for the one-line preview on a card. */
export function previewRow(rows: readonly DiffRow[]): DiffRow | undefined {
  return rows.find((row) => row.kind === "change") ?? rows[0];
}

// ------------------------------------------------------------------- badge

export type BadgeCount = { count: number; capped: boolean };

/** Unread-style count for the shell badge; `capped` = more pages exist. */
export function badgeCount(
  rows: readonly Pick<ApprovalRequest, "status">[],
  hasMore: boolean,
): BadgeCount {
  return {
    count: rows.filter((row) => row.status === "pending").length,
    capped: hasMore,
  };
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
