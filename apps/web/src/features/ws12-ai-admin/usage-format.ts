// Pure display helpers for the AI & MCP usage page: month list, catalog keys,
// badge tones and number shaping. No React and no `@/` alias, so the root tests
// can import this file with plain Node ESM. Rules live in the contract
// (@starter/shared/ai); this only shapes what is shown.
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";
import {
  AI_TOOL_CATALOG,
  MCP_REVOCATION_MAX_SECONDS,
  type AiBlockedReason,
  type AiChannel,
  type AiFeatureCode,
  type AiToolCallOutcome,
  type AiToolCode,
} from "@starter/shared/ai";

export type UsageTone = "neutral" | "success" | "warning" | "danger" | "info";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonth(value: unknown): value is string {
  return typeof value === "string" && MONTH_PATTERN.test(value);
}

/** "YYYY-MM" of a moment in the outlet time zone (PRD §6). */
export function monthOf(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: DEFAULT_TIME_ZONE,
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

/** The picker list: the current month first, then `count - 1` earlier months. */
export function monthOptions(now: Date, count = 12): string[] {
  const current = monthOf(now);
  const year = Number(current.slice(0, 4));
  const month = Number(current.slice(5, 7));
  return Array.from({ length: count }, (_, index) => {
    const total = year * 12 + (month - 1) - index;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    return `${y}-${String(m).padStart(2, "0")}`;
  });
}

const monthFormat = new Intl.DateTimeFormat("id-ID", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** "2026-11" → "November 2026". */
export function monthLabel(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  return monthFormat.format(new Date(Date.UTC(year, index, 1)));
}

const momentFormat = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: DEFAULT_TIME_ZONE,
});

export function formatMoment(iso: string): string {
  return momentFormat.format(new Date(iso));
}

const FEATURE_KEYS: Record<AiFeatureCode, MessageKey> = {
  "AI-01": "aiAdminUsage.feature.names.ai01",
  "AI-02": "aiAdminUsage.feature.names.ai02",
  "AI-03": "aiAdminUsage.feature.names.ai03",
  "AI-04": "aiAdminUsage.feature.names.ai04",
  "AI-05": "aiAdminUsage.feature.names.ai05",
  "AI-06": "aiAdminUsage.feature.names.ai06",
  "AI-07": "aiAdminUsage.feature.names.ai07",
  "AI-08": "aiAdminUsage.feature.names.ai08",
  "AI-09": "aiAdminUsage.feature.names.ai09",
  "AI-10": "aiAdminUsage.feature.names.ai10",
  "AI-11": "aiAdminUsage.feature.names.ai11",
  "AI-12": "aiAdminUsage.feature.names.ai12",
  "AI-13": "aiAdminUsage.feature.names.ai13",
  "AI-14": "aiAdminUsage.feature.names.ai14",
};

export function featureLabelKey(feature: AiFeatureCode): MessageKey {
  return FEATURE_KEYS[feature];
}

const BLOCKED_KEYS: Record<AiBlockedReason, MessageKey> = {
  quota_exceeded: "aiAdminUsage.blockedReasons.reasons.quota_exceeded",
  budget_exceeded: "aiAdminUsage.blockedReasons.reasons.budget_exceeded",
  feature_disabled: "aiAdminUsage.blockedReasons.reasons.feature_disabled",
  tool_disabled: "aiAdminUsage.blockedReasons.reasons.tool_disabled",
  pii_blocked: "aiAdminUsage.blockedReasons.reasons.pii_blocked",
  permission_denied: "aiAdminUsage.blockedReasons.reasons.permission_denied",
};

export function blockedReasonKey(reason: AiBlockedReason): MessageKey {
  return BLOCKED_KEYS[reason];
}

const OUTCOME_KEYS: Record<AiToolCallOutcome, MessageKey> = {
  ok: "aiAdminUsage.calls.outcomes.ok",
  denied: "aiAdminUsage.calls.outcomes.denied",
  error: "aiAdminUsage.calls.outcomes.error",
  rate_limited: "aiAdminUsage.calls.outcomes.rate_limited",
  disabled: "aiAdminUsage.calls.outcomes.disabled",
};

export function outcomeKey(outcome: AiToolCallOutcome): MessageKey {
  return OUTCOME_KEYS[outcome];
}

const OUTCOME_TONES: Record<AiToolCallOutcome, UsageTone> = {
  ok: "success",
  denied: "warning",
  error: "danger",
  rate_limited: "warning",
  disabled: "neutral",
};

export function outcomeTone(outcome: AiToolCallOutcome): UsageTone {
  return OUTCOME_TONES[outcome];
}

export function channelKey(channel: AiChannel): MessageKey {
  return channel === "mcp"
    ? "aiAdminUsage.calls.channels.mcp"
    : "aiAdminUsage.calls.channels.app";
}

export type TokenStateName = "active" | "expired" | "revoked";

const TOKEN_STATE_KEYS: Record<TokenStateName, MessageKey> = {
  active: "aiAdminUsage.tokens.states.active",
  expired: "aiAdminUsage.tokens.states.expired",
  revoked: "aiAdminUsage.tokens.states.revoked",
};

export function tokenStateKey(state: TokenStateName): MessageKey {
  return TOKEN_STATE_KEYS[state];
}

const TOKEN_STATE_TONES: Record<TokenStateName, UsageTone> = {
  active: "success",
  expired: "neutral",
  revoked: "danger",
};

export function tokenStateTone(state: TokenStateName): UsageTone {
  return TOKEN_STATE_TONES[state];
}

/** Indonesian title of a catalog tool; falls back to the code. */
export function toolTitle(code: AiToolCode): string {
  return AI_TOOL_CATALOG.find((tool) => tool.code === code)?.titleId ?? code;
}

/** Minutes until a revoked token stops working (MCP-02): 60 s → 1. */
export const REVOCATION_MINUTES = Math.max(
  1,
  Math.ceil(MCP_REVOCATION_MAX_SECONDS / 60),
);

/** Redacted params as "key: value" pairs for display (scalars only). */
export function paramPairs(
  params: Record<string, string | number | boolean | null>,
): { key: string; value: string }[] {
  return Object.entries(params).map(([key, value]) => ({
    key,
    value: value === null ? "–" : String(value),
  }));
}

/** First chars of a scope such as "mcp:sales:read" for a compact list. */
export function scopeLabel(scope: string): string {
  return scope.replace(/^mcp:/, "");
}
