// Pure rules of the audit log viewer (PRD v1.7 §3 F36): filter draft to query,
// time in the outlet time zone, the IP trace and the masked diff rows. No React,
// no `@/` alias, so tests load it in Node.
import {
  AUDIT_REDACTED,
  isSensitiveAuditKey,
  type AuditActorType,
} from "@starter/shared/audit";
import {
  auditActionFilterSchema,
  type AuditEventListQuery,
} from "./contract.ts";

/** Tenant default until the outlet context carries the zone (see format.ts of the management home). */
export const DEFAULT_TIME_ZONE = "Asia/Jakarta";
export const AUDIT_PAGE_SIZE = 25;

export const ACTOR_TYPES = [
  "user",
  "ai",
  "mcp_client",
  "system",
  "device",
] as const satisfies readonly AuditActorType[];

/** Object types the viewer offers as the "Modul" filter (catalog-labelled). */
export const MODULES = [
  "outlet",
  "role",
  "user",
  "menu_item",
  "price",
  "tax_rule",
  "payment_method",
  "stock_item",
  "journal",
  "order",
  "notification",
  "session",
  "report",
] as const;

export type AuditFilters = {
  actorType: AuditActorType | "";
  objectType: string;
  action: string;
  outletId: string;
  from: string;
  to: string;
};

export const EMPTY_FILTERS: AuditFilters = {
  actorType: "",
  objectType: "",
  action: "",
  outletId: "",
  from: "",
  to: "",
};

export type FilterIssue = "invalidAction" | "invalidRange";

/** Why a draft cannot be applied (the form shows the fix-it text). */
export function filterIssues(filters: AuditFilters): FilterIssue[] {
  const issues: FilterIssue[] = [];
  const action = filters.action.trim();
  if (action !== "" && !auditActionFilterSchema.safeParse(action).success)
    issues.push("invalidAction");
  if (filters.from !== "" && filters.to !== "" && filters.from > filters.to)
    issues.push("invalidRange");
  return issues;
}

export function activeFilterCount(filters: AuditFilters): number {
  return Object.values(filters).filter((value) => value.trim() !== "").length;
}

/** The wire query for one page; empty filters are left out. */
export function toQuery(
  filters: AuditFilters,
  cursor?: string,
): AuditEventListQuery {
  return {
    limit: AUDIT_PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
    ...(filters.actorType ? { actorType: filters.actorType } : {}),
    ...(filters.objectType ? { objectType: filters.objectType } : {}),
    ...(filters.action.trim() ? { action: filters.action.trim() } : {}),
    ...(filters.outletId ? { outletId: filters.outletId } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  } as AuditEventListQuery;
}

/** `2026-11-01T05:12:00.000Z` → `1 Nov 2026, 12.12` in the outlet zone. */
export function formatWhen(
  instant: string,
  timeZone: string | null = null,
): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const zone = timeZone ?? DEFAULT_TIME_ZONE;
  try {
    return new Intl.DateTimeFormat("id-ID", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    }).format(date);
  } catch {
    return formatWhen(instant, null);
  }
}

/** `2026-11-01T05:12:00.000Z` → `1 Nov 2026` for the retention date. */
export function formatDay(instant: string, timeZone: string | null = null) {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: timeZone ?? DEFAULT_TIME_ZONE,
  }).format(date);
}

/** audit_2y: rows are kept two years (contract `retentionClass`). */
export function retainedUntil(createdAt: string): string {
  const date = new Date(createdAt);
  date.setUTCFullYear(date.getUTCFullYear() + 2);
  return date.toISOString();
}

/**
 * The only IP text the viewer shows: a short prefix of the keyed hash (ip.ts
 * stores an HMAC, never the address), so two rows can be compared without the
 * address ever reaching the browser.
 */
export function ipTrace(ipHash: string | null): string | null {
  return ipHash === null ? null : ipHash.slice(0, 8);
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Defence in depth on top of the contract: the schema already rejects a row
 * with an unmasked sensitive field, but the screen redacts again so a faulty
 * mock or a future contract change can never print one.
 */
export function redactForDisplay(value: unknown, key?: string): Json {
  if (key !== undefined && isSensitiveAuditKey(key)) return AUDIT_REDACTED;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value))
    return value.map((entry) => redactForDisplay(entry, key));
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([field, entry]) => [
        field,
        redactForDisplay(entry, field),
      ]),
    );
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  return AUDIT_REDACTED;
}

export type DiffRow = {
  field: string;
  before: string | null;
  after: string | null;
  redacted: boolean;
};

function show(value: Json | undefined): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** One row per top-level field that appears before or after. */
export function diffRows(changes: {
  before: unknown;
  after: unknown;
}): DiffRow[] {
  const before = redactForDisplay(changes.before);
  const after = redactForDisplay(changes.after);
  const asRecord = (value: Json): Record<string, Json> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value
      : value === null
        ? {}
        : { value };
  const left = asRecord(before);
  const right = asRecord(after);
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  return fields.map((field) => {
    const b = show(left[field]);
    const a = show(right[field]);
    return {
      field,
      before: b,
      after: a,
      redacted: b === AUDIT_REDACTED || a === AUDIT_REDACTED,
    };
  });
}
