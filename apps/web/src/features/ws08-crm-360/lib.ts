// Pure helpers of the CRM back office (bead legend-i026; PRD v1.7 §3.21
// "Customer 360", "Segmentasi", "Ulasan & Keluhan"; LOY-04, AI-11). No React
// and no DOM at import time, and only bare package or relative `.ts` imports,
// so Node can load this file for contract tests.
//
// Formatting, the segment rule draft <-> contract conversion and the AI-11
// summary live here so the screens stay thin and the rules are testable.

import { DEFAULT_TIME_ZONE, idr, outletIdSchema } from "@starter/shared/core";
import {
  formatNumber,
  formatRupiah,
  type TranslateVars,
} from "@starter/shared/i18n";
import type {
  Feedback,
  FeedbackAction,
  FeedbackKind,
  FeedbackStatus,
  MembershipStatus,
  PointEntryType,
  PointSourceType,
  SegmentDefinition,
  SegmentRule,
} from "@starter/shared/crm";

const DAY_MS = 86_400_000;
const SHORT_REF_LENGTH = 8;

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: DEFAULT_TIME_ZONE,
});
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: DEFAULT_TIME_ZONE,
});
const MONTH_FORMAT = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  timeZone: "UTC",
});
const DAY_MONTH_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** True when the URL asks mock mode for a non-normal scenario (?mock=empty). */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}

/** "2026-10-30T12:40:00.000Z" → "30 Okt 2026". */
export function formatDate(iso: string): string {
  return DATE_FORMAT.format(new Date(iso));
}

/** "2026-10-30T12:40:00.000Z" → "30 Okt 2026, 19.40" (Asia/Jakarta). */
export function formatDateTime(iso: string): string {
  return DATE_TIME_FORMAT.format(new Date(iso));
}

/** 11 → "November"; used for the birthday-month rule. */
export function monthLabel(month: number): string {
  return MONTH_FORMAT.format(new Date(Date.UTC(2026, month - 1, 1)));
}

/** "03-14" (birth month/day without a year) → "14 Mar". */
export function formatBirthMonthDay(value: string): string {
  const [month, day] = value.split("-").map(Number);
  return DAY_MONTH_FORMAT.format(new Date(Date.UTC(2026, month - 1, day)));
}

/** First characters of an id, for a cell that names another row. */
export function shortRef(id: string, size: number = SHORT_REF_LENGTH): string {
  return id.length <= size ? id : `${id.slice(0, size)}…`;
}

/** Basis points → whole percent (10.000 bp = 100%). */
export function percentFromBp(bp: number): number {
  return Math.round(bp / 100);
}

/** Signed ledger change: 240 → "+240", -200 → "−200", 0 → "0". */
export function signedPoints(points: number): string {
  if (points === 0) return formatNumber(0);
  const sign = points > 0 ? "+" : "−";
  return `${sign}${formatNumber(Math.abs(points))}`;
}

// ---- Catalog key helpers --------------------------------------------------

export function membershipStatusKey(status: MembershipStatus): string {
  return `crm360.membership.${status}`;
}

export function feedbackKindKey(kind: FeedbackKind): string {
  return `crm360.feedback.kinds.${kind}`;
}

export function feedbackStatusKey(status: FeedbackStatus): string {
  return `crm360.feedback.statuses.${status}`;
}

export function feedbackActionKey(action: FeedbackAction): string {
  return `crm360.feedback.action.${action}`;
}

export function pointTypeKey(type: PointEntryType): string {
  return `crm360.detail.points.types.${type}`;
}

export function pointSourceKey(source: PointSourceType): string {
  return `crm360.detail.points.sources.${source}`;
}

// ---- Feedback queue and the AI-11 summary ---------------------------------

/**
 * Actions the queue offers per status. The contract also allows `close` on a
 * resolved row; the screen leaves resolved rows alone (the brief lists
 * start_review / resolve / dismiss), so no action is shown there.
 */
export const FEEDBACK_ACTIONS: Record<
  FeedbackStatus,
  readonly FeedbackAction[]
> = {
  open: ["start_review", "dismiss"],
  in_review: ["resolve", "dismiss"],
  resolved: [],
  closed: [],
};

export type OutletComplaintCount = {
  outletId: string;
  count: number;
};

/**
 * AI-11 "Ringkasan Ulasan" (PRD §3.21) over the rows the screen has loaded:
 * descriptive counts only, so the panel never invents model output. A theme
 * summary needs the AI service, which the CRM contract does not expose yet.
 */
export type FeedbackSummary = {
  total: number;
  ratings: number;
  complaints: number;
  /** Mean of the loaded rating rows, or null when none is loaded. */
  averageRating: number | null;
  byStatus: Record<FeedbackStatus, number>;
  /** Complaints still open or in review, most first. */
  openComplaintsByOutlet: OutletComplaintCount[];
  /** Rows within seven days before the newest loaded row. */
  recentCount: number;
  newestAt: string | null;
};

export function summarizeFeedback(rows: readonly Feedback[]): FeedbackSummary {
  const byStatus: Record<FeedbackStatus, number> = {
    open: 0,
    in_review: 0,
    resolved: 0,
    closed: 0,
  };
  const complaintsByOutlet = new Map<string, number>();
  let ratings = 0;
  let ratingTotal = 0;
  let complaints = 0;
  let newestAt: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    byStatus[row.status] += 1;
    if (row.kind === "rating") {
      ratings += 1;
      ratingTotal += row.rating ?? 0;
    } else {
      complaints += 1;
      if (row.status === "open" || row.status === "in_review")
        complaintsByOutlet.set(
          row.outletId,
          (complaintsByOutlet.get(row.outletId) ?? 0) + 1,
        );
    }
    const created = Date.parse(row.createdAt);
    if (created > newestMs) {
      newestMs = created;
      newestAt = row.createdAt;
    }
  }

  // The "last seven days" window is anchored on the newest loaded row, not the
  // device clock, so the number matches the visible data at any run time.
  const windowStart = newestMs - 7 * DAY_MS;
  const recentCount =
    newestAt === null
      ? 0
      : rows.filter((row) => Date.parse(row.createdAt) >= windowStart).length;

  return {
    total: rows.length,
    ratings,
    complaints,
    averageRating: ratings === 0 ? null : ratingTotal / ratings,
    byStatus,
    openComplaintsByOutlet: [...complaintsByOutlet.entries()]
      .map(([outletId, count]) => ({ outletId, count }))
      .sort((left, right) =>
        left.count === right.count
          ? left.outletId.localeCompare(right.outletId)
          : right.count - left.count,
      ),
    recentCount,
    newestAt,
  };
}

// ---- Segment builder ------------------------------------------------------

export const SEGMENT_RULE_KINDS = [
  "rfm_recency",
  "rfm_frequency",
  "rfm_monetary",
  "tier",
  "favorite_item",
  "outlet",
  "inactive_days",
  "marketing_opt_in",
  "birthday_month",
] as const;
export type SegmentRuleKind = (typeof SEGMENT_RULE_KINDS)[number];

/** Editable form of one segment rule; numbers stay text until submit. */
export type RuleDraft = {
  /** Stable React key and validation key; never sent to the API. */
  key: string;
  kind: SegmentRuleKind;
  /** Positive integer for the numeric kinds (days, visits, rupiah). */
  amount: string;
  /** marketing_opt_in value. */
  optIn: "true" | "false";
  /** birthday_month, 1–12. */
  month: string;
  /** tier / favorite_item / outlet ids. */
  selectedIds: string[];
};

const DEFAULT_AMOUNT: Partial<Record<SegmentRuleKind, string>> = {
  rfm_recency: "30",
  rfm_frequency: "3",
  rfm_monetary: "100000",
  inactive_days: "30",
};

let ruleKeySequence = 0;

/** Unique draft key; not rendered, so SSR and hydration may differ freely. */
export function nextRuleKey(): string {
  ruleKeySequence += 1;
  return `rule-${ruleKeySequence}`;
}

export function createRuleDraft(kind: SegmentRuleKind): RuleDraft {
  return {
    key: nextRuleKey(),
    kind,
    amount: DEFAULT_AMOUNT[kind] ?? "",
    optIn: "true",
    month: "1",
    selectedIds: [],
  };
}

/** The PRD's win-back example (not visited for 30 days) as the first rule. */
export function initialRuleDrafts(): RuleDraft[] {
  return [createRuleDraft("inactive_days")];
}

/** Switch a draft's kind, resets its fields, keeps its React key. */
export function changeRuleKind(
  draft: RuleDraft,
  kind: SegmentRuleKind,
): RuleDraft {
  return { ...createRuleDraft(kind), key: draft.key };
}

export const DEFAULT_SEGMENT_MATCH: SegmentDefinition["match"] = "all";

function positiveInt(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/** Validation message key of one rule, or null when the rule is complete. */
export function ruleErrorKey(draft: RuleDraft): string | null {
  switch (draft.kind) {
    case "rfm_recency":
    case "rfm_frequency":
    case "rfm_monetary":
    case "inactive_days":
      return positiveInt(draft.amount) === null
        ? "crm360.segments.errors.amount"
        : null;
    case "tier":
    case "favorite_item":
    case "outlet":
      return draft.selectedIds.length === 0
        ? "crm360.segments.errors.selection"
        : null;
    case "marketing_opt_in":
      return null;
    case "birthday_month": {
      const month = Number(draft.month);
      return Number.isInteger(month) && month >= 1 && month <= 12
        ? null
        : "crm360.segments.errors.month";
    }
  }
}

/** Draft → contract rule, or null when a field is missing or invalid. */
export function ruleFromDraft(draft: RuleDraft): SegmentRule | null {
  if (ruleErrorKey(draft) !== null) return null;
  switch (draft.kind) {
    case "rfm_recency":
      return {
        kind: "rfm_recency",
        maxDaysSinceLastVisit: positiveInt(draft.amount) ?? 0,
      };
    case "rfm_frequency":
      return {
        kind: "rfm_frequency",
        minVisits: positiveInt(draft.amount) ?? 0,
      };
    case "rfm_monetary":
      return {
        kind: "rfm_monetary",
        minSpendIdr: idr(positiveInt(draft.amount) ?? 0),
      };
    case "tier":
      return { kind: "tier", tierIds: [...draft.selectedIds] };
    case "favorite_item":
      return { kind: "favorite_item", menuItemIds: [...draft.selectedIds] };
    case "outlet":
      return {
        kind: "outlet",
        outletIds: draft.selectedIds.map((id) => outletIdSchema.parse(id)),
      };
    case "inactive_days":
      return { kind: "inactive_days", days: positiveInt(draft.amount) ?? 0 };
    case "marketing_opt_in":
      return { kind: "marketing_opt_in", value: draft.optIn === "true" };
    case "birthday_month":
      return { kind: "birthday_month", month: Number(draft.month) };
  }
}

/** Definition for previewSegment/createSegment, or null while incomplete. */
export function definitionFromDrafts(
  match: SegmentDefinition["match"],
  drafts: readonly RuleDraft[],
): SegmentDefinition | null {
  if (drafts.length === 0) return null;
  const rules: SegmentRule[] = [];
  for (const draft of drafts) {
    const rule = ruleFromDraft(draft);
    if (rule === null) return null;
    rules.push(rule);
  }
  return { match, rules };
}

export type SegmentBuilderErrors = {
  name?: string;
  rules?: string;
  ruleErrors: Record<string, string>;
};

/** Field-level errors before createSegment; no errors means a valid body. */
export function validateSegmentBuilder(
  name: string,
  drafts: readonly RuleDraft[],
): SegmentBuilderErrors {
  const errors: SegmentBuilderErrors = { ruleErrors: {} };
  if (name.trim() === "") errors.name = "crm360.segments.errors.name";
  if (drafts.length === 0) errors.rules = "crm360.segments.errors.rules";
  for (const draft of drafts) {
    const key = ruleErrorKey(draft);
    if (key !== null) errors.ruleErrors[draft.key] = key;
  }
  return errors;
}

export function hasSegmentErrors(errors: SegmentBuilderErrors): boolean {
  return (
    errors.name !== undefined ||
    errors.rules !== undefined ||
    Object.keys(errors.ruleErrors).length > 0
  );
}

export type RuleLookups = {
  tierName?: (id: string) => string | undefined;
  menuItemName?: (id: string) => string | undefined;
  outletName?: (id: string) => string | undefined;
};

function joinNames(
  ids: readonly string[],
  lookup: ((id: string) => string | undefined) | undefined,
): string {
  return ids
    .map((id) => lookup?.(id) ?? shortRef(id, SHORT_REF_LENGTH))
    .join(", ");
}

/** One-line rule summary; the component translates {key} with {vars}. */
export function ruleSummary(
  rule: SegmentRule,
  lookups: RuleLookups = {},
): { key: string; vars?: TranslateVars } {
  switch (rule.kind) {
    case "rfm_recency":
      return {
        key: "crm360.segments.summary.rfmRecency",
        vars: { days: rule.maxDaysSinceLastVisit },
      };
    case "rfm_frequency":
      return {
        key: "crm360.segments.summary.rfmFrequency",
        vars: { visits: rule.minVisits },
      };
    case "rfm_monetary":
      return {
        key: "crm360.segments.summary.rfmMonetary",
        vars: { amount: formatRupiah(rule.minSpendIdr) },
      };
    case "tier":
      return {
        key: "crm360.segments.summary.tier",
        vars: { names: joinNames(rule.tierIds, lookups.tierName) },
      };
    case "favorite_item":
      return {
        key: "crm360.segments.summary.favoriteItem",
        vars: { names: joinNames(rule.menuItemIds, lookups.menuItemName) },
      };
    case "outlet":
      return {
        key: "crm360.segments.summary.outlet",
        vars: { names: joinNames(rule.outletIds, lookups.outletName) },
      };
    case "inactive_days":
      return {
        key: "crm360.segments.summary.inactiveDays",
        vars: { days: rule.days },
      };
    case "marketing_opt_in":
      return {
        key: rule.value
          ? "crm360.segments.summary.marketingOptInYes"
          : "crm360.segments.summary.marketingOptInNo",
      };
    case "birthday_month":
      return {
        key: "crm360.segments.summary.birthdayMonth",
        vars: { month: monthLabel(rule.month) },
      };
  }
}
