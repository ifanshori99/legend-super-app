// Shared helpers for the facility admin screens (bead legend-er32). No UI text
// lives here: every label is a catalog key resolved by the component that
// renders it (docs/frontend.md).
import type { MessageKey, Translate } from "@starter/shared/i18n";
import type { MenuItemAdmin } from "@starter/shared/menu";
import type { z } from "zod";
import type {
  CancellationResolution,
  EntitlementRuleType,
  FacilityDayHours,
  FacilityProductType,
  FacilityType,
  FacilityUnit,
  FacilityUnitStatus,
  SubscriptionInterval,
} from "@starter/shared/facility";

/** One config read per facility; the tenant only has a handful. */
export const LIST_PAGE_LIMIT = 50;

/**
 * `?mock=empty|slow|error|offline` must reach the browser instead of being
 * frozen into the SSR HTML (docs/frontend.md "See loading, empty and error
 * states"). `normal` is the default and may be prefetched.
 */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}

export const facilityTypeLabel: Record<FacilityType, MessageKey> = {
  shower: "facilityAdmin.facilityType.shower",
  locker: "facilityAdmin.facilityType.locker",
  meeting_room: "facilityAdmin.facilityType.meeting_room",
  coworking: "facilityAdmin.facilityType.coworking",
};

export const productTypeLabel: Record<FacilityProductType, MessageKey> = {
  single: "facilityAdmin.productType.single",
  package_component: "facilityAdmin.productType.package_component",
  subscription_plan: "facilityAdmin.productType.subscription_plan",
};

export const ruleTypeLabel: Record<EntitlementRuleType, MessageKey> = {
  min_spend: "facilityAdmin.ruleType.min_spend",
  tier_benefit: "facilityAdmin.ruleType.tier_benefit",
  package: "facilityAdmin.ruleType.package",
};

export const resolutionLabel: Record<CancellationResolution, MessageKey> = {
  entitlement_restored: "facilityAdmin.resolution.entitlement_restored",
  refund_full: "facilityAdmin.resolution.refund_full",
  refund_partial: "facilityAdmin.resolution.refund_partial",
  no_refund: "facilityAdmin.resolution.no_refund",
};

export const unitStatusLabel: Record<FacilityUnitStatus, MessageKey> = {
  available: "facilityAdmin.unitStatus.available",
  in_use: "facilityAdmin.unitStatus.in_use",
  needs_cleaning: "facilityAdmin.unitStatus.needs_cleaning",
  cleaning: "facilityAdmin.unitStatus.cleaning",
  maintenance: "facilityAdmin.unitStatus.maintenance",
};

export const subscriptionIntervalLabel: Record<
  SubscriptionInterval,
  MessageKey
> = {
  month: "facilityAdmin.subscriptions.interval.month",
  year: "facilityAdmin.subscriptions.interval.year",
};

/** UI accents per unit status: available is the healthy one. */
export const unitStatusTone: Record<
  FacilityUnitStatus,
  "success" | "info" | "warning" | "neutral" | "danger"
> = {
  available: "success",
  in_use: "info",
  needs_cleaning: "warning",
  cleaning: "warning",
  maintenance: "danger",
};

/** 0 = Sunday, matching `facilityDayHoursSchema.daysOfWeek`. */
export const dayShortKeys: readonly MessageKey[] = [
  "facilityAdmin.days.short.sun",
  "facilityAdmin.days.short.mon",
  "facilityAdmin.days.short.tue",
  "facilityAdmin.days.short.wed",
  "facilityAdmin.days.short.thu",
  "facilityAdmin.days.short.fri",
  "facilityAdmin.days.short.sat",
];

export const dayLongKeys: readonly MessageKey[] = [
  "facilityAdmin.days.long.sun",
  "facilityAdmin.days.long.mon",
  "facilityAdmin.days.long.tue",
  "facilityAdmin.days.long.wed",
  "facilityAdmin.days.long.thu",
  "facilityAdmin.days.long.fri",
  "facilityAdmin.days.long.sat",
];

/** "06:00" → "06.00" (Indonesian clock style, PRD copy uses titik). */
export function formatClock(value: string): string {
  return value.replace(":", ".");
}

/** Minutes since midnight for a "HH:mm" value; null when malformed. */
export function clockMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * One line per opening-hours group, e.g. "Setiap hari · 06.00–10.00"
 * (PRD §3 F25 Konfigurasi Legend: hours are configured per day).
 */
export function summarizeOperatingHours(
  hours: readonly FacilityDayHours[],
  t: Translate,
): string[] {
  return hours.map((group) => {
    const open = formatClock(group.opensAt);
    const close = formatClock(group.closesAt);
    if (group.daysOfWeek.length === 7)
      return t("facilityAdmin.hours.everyDay", { open, close });
    const days = [...group.daysOfWeek]
      .sort((a, b) => a - b)
      .map((day) => t(dayShortKeys[day]))
      .join(", ");
    return t("facilityAdmin.hours.group", { days, open, close });
  });
}

/** Editable per-day rows; the contract stores groups of equal days. */
export type DayRow = {
  enabled: boolean;
  opensAt: string;
  closesAt: string;
};

export function hoursToRows(hours: readonly FacilityDayHours[]): DayRow[] {
  const fallback = hours[0] ?? { opensAt: "06:00", closesAt: "10:00" };
  return Array.from({ length: 7 }, (_, day) => {
    const group = hours.find((item) => item.daysOfWeek.includes(day));
    return group
      ? { enabled: true, opensAt: group.opensAt, closesAt: group.closesAt }
      : {
          enabled: false,
          opensAt: fallback.opensAt,
          closesAt: fallback.closesAt,
        };
  });
}

/** Groups consecutive enabled days that share the same hours (contract shape). */
export function rowsToHours(rows: readonly DayRow[]): FacilityDayHours[] {
  const groups: FacilityDayHours[] = [];
  let current: {
    daysOfWeek: number[];
    opensAt: string;
    closesAt: string;
  } | null = null;
  rows.forEach((row, day) => {
    if (!row.enabled) {
      current = null;
      return;
    }
    if (
      current &&
      current.opensAt === row.opensAt &&
      current.closesAt === row.closesAt
    ) {
      current.daysOfWeek.push(day);
      return;
    }
    current = {
      daysOfWeek: [day],
      opensAt: row.opensAt,
      closesAt: row.closesAt,
    };
    groups.push(current);
  });
  return groups;
}

/** Whole non-negative integer from an input value; null when not one. */
export function parseInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** First message per dotted field path, for FormField error props. */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_form";
    out[key] ??= issue.message;
  }
  return out;
}

/**
 * Form-side validation of a contract write body (bead legend-6jms). The
 * optimistic-lock stamp and the create key are added by hooks.ts, never by a
 * form, yet the contract schemas require them. The form therefore validates
 * with a placeholder in their place and returns the body without it, so every
 * other contract rule (ranges, refinements, "at least one field") still
 * applies and the contract itself is untouched.
 */
type FormDraft<T> = T extends unknown
  ? Omit<T, "expectedUpdatedAt" | "idempotencyKey">
  : never;
type FormParseResult<S extends z.ZodType> =
  | { success: true; data: FormDraft<z.output<S>> }
  | { success: false; error: z.ZodError };

const DRAFT_STAMP = "1970-01-01T00:00:00.000Z";
const DRAFT_KEY = "form-draft-placeholder-key";

function parseFormDraft<S extends z.ZodType>(
  schema: S,
  draft: object,
  placeholder:
    { expectedUpdatedAt: string | null } | { idempotencyKey: string },
): FormParseResult<S> {
  const result = schema.safeParse({ ...draft, ...placeholder });
  if (!result.success) return { success: false, error: result.error };
  const {
    expectedUpdatedAt: _stamp,
    idempotencyKey: _key,
    ...rest
  } = result.data as Record<string, unknown>;
  return { success: true, data: rest as FormDraft<z.output<S>> };
}

/** PATCH body: the row's stamp is required (hooks fill the real one). */
export function parseUpdateDraft<S extends z.ZodType>(
  schema: S,
  draft: object,
) {
  return parseFormDraft(schema, draft, { expectedUpdatedAt: DRAFT_STAMP });
}

/** PUT upsert body: the stamp is nullable (null = the row is new). */
export function parsePutDraft<S extends z.ZodType>(schema: S, draft: object) {
  return parseFormDraft(schema, draft, { expectedUpdatedAt: null });
}

/** POST create body: one idempotency key per attempt (hooks mint it). */
export function parseCreateDraft<S extends z.ZodType>(
  schema: S,
  draft: object,
) {
  return parseFormDraft(schema, draft, { idempotencyKey: DRAFT_KEY });
}

export type UnitSummary = {
  total: number;
  active: number;
  maintenance: number;
  available: number;
};

/** Active = every status except maintenance (the contract has no facility status). */
export function summarizeUnits(units: readonly FacilityUnit[]): UnitSummary {
  return {
    total: units.length,
    active: units.filter((unit) => unit.status !== "maintenance").length,
    maintenance: units.filter((unit) => unit.status === "maintenance").length,
    available: units.filter((unit) => unit.status === "available").length,
  };
}

export function facilityStatusKey(summary: UnitSummary): MessageKey {
  if (summary.total === 0) return "facilityAdmin.list.statusNoUnits";
  return summary.active > 0
    ? "facilityAdmin.list.statusActive"
    : "facilityAdmin.list.statusInactive";
}

/** Last four characters of an id, e.g. uuid(9401) → "9401". */
export function shortId(id: string): string {
  return id.slice(-4);
}

/** Resolved menu-package name, with a readable fallback for a stale id. */
export function menuItemLabel(
  items: readonly MenuItemAdmin[],
  menuItemId: string,
  t: Translate,
): string {
  const item = items.find((row) => row.id === menuItemId);
  return (
    item?.name ??
    t("facilityAdmin.products.menuFallback", { id: shortId(menuItemId) })
  );
}

/** Entitlement validity kinds, in the order the editor offers them. */
export const validityKindKeys = [
  "operating_day",
  "duration_hours",
  "billing_period",
] as const;
export type ValidityKind = (typeof validityKindKeys)[number];

export function validityLabel(kind: ValidityKind): MessageKey {
  switch (kind) {
    case "operating_day":
      return "facilityAdmin.entitlements.validityOperatingDay";
    case "duration_hours":
      return "facilityAdmin.entitlements.validityDurationHours";
    case "billing_period":
      return "facilityAdmin.entitlements.validityBillingPeriod";
  }
}
