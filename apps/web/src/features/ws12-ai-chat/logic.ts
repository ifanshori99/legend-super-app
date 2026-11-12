// Pure logic for Tanya AI chat (legend-mlnu). No React, router or `@/` alias, so
// tests load this file with plain Node type stripping.
import type {
  AiFeatureCode,
  AiMessage,
  AiMessageSource,
  AiUsageSummary,
} from "@starter/shared/ai";
import { ApiError } from "../../lib/api/errors.ts";

/** The chat asks as "Tanya data" (PRD §3 Fitur 38 AI-01). */
export const CHAT_FEATURE: AiFeatureCode = "AI-01";

export type AskErrorKind =
  "denied" | "unavailable" | "quota" | "budget" | "pii" | "error";

/**
 * Maps a failed ask to the banner the chat shows (docs/contracts/ws12-ai-fe.md
 * "Error codes on ask"). A refusal we do not know (any other 403) is "denied";
 * a down provider or network failure is "unavailable".
 */
export function classifyAskError(err: unknown): AskErrorKind {
  if (!(err instanceof ApiError)) return "unavailable";
  switch (err.code) {
    case "AI_TOOL_FORBIDDEN":
      return "denied";
    case "AI_FEATURE_DISABLED":
    case "AI_TOOL_DISABLED":
    case "AI_PROVIDER_UNAVAILABLE":
    case "AI_PROVIDER_NOT_CONFIGURED":
      return "unavailable";
    case "AI_QUOTA_EXCEEDED":
      return "quota";
    case "AI_BUDGET_EXCEEDED":
      return "budget";
    case "AI_PII_BLOCKED":
      return "pii";
    default:
      break;
  }
  if (err.status === 403) return "denied";
  if (err.status === 503) return "unavailable";
  return "error";
}

/** The browser could not reach the server (apiFetch throws status 0). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "NETWORK_ERROR";
}

// ---- Areas -----------------------------------------------------------------

export type ChatArea =
  "owner" | "shareholder" | "kelola" | "karyawan" | "kitchen";

const AREA_BASE: Record<ChatArea, string> = {
  owner: "/owner",
  shareholder: "/shareholder",
  kelola: "/kelola",
  karyawan: "/karyawan",
  kitchen: "/kds",
};

/** Where "Buka laporan" goes: the area's own reports, else its home. */
const AREA_REPORTS: Record<ChatArea, string> = {
  owner: "/owner",
  shareholder: "/shareholder",
  kelola: "/reports",
  karyawan: "/karyawan",
  kitchen: "/kds",
};

export const chatPath = (area: ChatArea): string =>
  `${AREA_BASE[area]}/tanya-ai`;
export const guidePath = (area: ChatArea): string =>
  `${AREA_BASE[area]}/tanya-ai/panduan`;
export const reportPath = (area: ChatArea): string => AREA_REPORTS[area];

// ---- Answer text -----------------------------------------------------------

export type TextRun = { text: string; bold: boolean };

/** Blank-line separated paragraphs; each is a list of plain/bold runs (`**x**`). */
export function parseAnswerBlocks(content: string): TextRun[][] {
  return content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) =>
      block
        .split("**")
        // An odd segment is bold; an unclosed `**` (a half-revealed answer)
        // stays bold until the end.
        .map((text, index) => ({ text, bold: index % 2 === 1 }))
        .filter((run) => run.text.length > 0),
    );
}

const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
] as const;

function parts(date: string): { y: number; m: number; d: number } {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return { y, m, d };
}

const monthName = (m: number): string => MONTHS[m - 1] ?? "";

/** "10 November 2026", "25–31 Oktober 2026", or both ends when they differ. */
export function formatPeriod(period: { from: string; to: string }): string {
  const a = parts(period.from);
  const b = parts(period.to);
  if (a.y === b.y && a.m === b.m && a.d === b.d)
    return `${a.d} ${monthName(a.m)} ${a.y}`;
  if (a.y === b.y && a.m === b.m)
    return `${a.d}–${b.d} ${monthName(a.m)} ${a.y}`;
  if (a.y === b.y)
    return `${a.d} ${monthName(a.m)} – ${b.d} ${monthName(b.m)} ${a.y}`;
  return `${a.d} ${monthName(a.m)} ${a.y} – ${b.d} ${monthName(b.m)} ${b.y}`;
}

export function sourcePeriodText(source: AiMessageSource): string | null {
  return source.period ? formatPeriod(source.period) : null;
}

/** Catalog key (under `aiChat.answer.sourceKind`) for the report a source opens. */
export function sourceKindKey(source: AiMessageSource): "sales" | "report" {
  return source.link.startsWith("/reports/sales") ? "sales" : "report";
}

/** Only what a person wrote or the AI answered; tool rows are plumbing. */
export function visibleMessages(messages: readonly AiMessage[]): AiMessage[] {
  return messages.filter((m) => m.role === "user" || m.role === "assistant");
}

// ---- Progressive reveal ----------------------------------------------------

/**
 * Next number of characters to show while an answer "types in": about 50 steps
 * for any length, never ending between the two stars of a bold marker or in
 * the middle of a surrogate pair.
 */
export function nextRevealLength(text: string, current: number): number {
  if (current >= text.length) return text.length;
  let next = Math.min(
    text.length,
    current + Math.max(3, Math.ceil(text.length / 50)),
  );
  if (next < text.length && text[next - 1] === "*" && text[next] === "*")
    next += 1;
  const last = text.charCodeAt(next - 1);
  if (next < text.length && last >= 0xd800 && last <= 0xdbff) next += 1;
  return next;
}

// ---- Usage and quota -------------------------------------------------------

export type ChatBlock = "unavailable" | "quota" | "budget" | "featureOff";

export function featureQuota(
  usage: AiUsageSummary | undefined,
  feature: AiFeatureCode = CHAT_FEATURE,
): { limit: number; used: number; left: number; isEnabled: boolean } | null {
  const entry = usage?.features.find((f) => f.feature === feature);
  if (!entry) return null;
  return {
    limit: entry.dailyLimit,
    used: entry.usedToday,
    left: Math.max(0, entry.dailyLimit - entry.usedToday),
    isEnabled: entry.isEnabled,
  };
}

/**
 * Why the chat cannot answer before anyone asks, from `GET /api/ai/usage`:
 * admin switch off or provider down (AIG-01, AIG-05), budget stopped (AIG-04),
 * the feature turned off, or today's quota used up (AIG-02).
 */
export function chatBlock(
  usage: AiUsageSummary | undefined,
  feature: AiFeatureCode = CHAT_FEATURE,
): ChatBlock | null {
  if (!usage) return null;
  if (!usage.aiEnabled || usage.providerAvailable === false)
    return "unavailable";
  if (usage.budget?.state === "stopped") return "budget";
  const quota = featureQuota(usage, feature);
  if (quota && !quota.isEnabled) return "featureOff";
  if (quota && quota.left === 0) return "quota";
  return null;
}
