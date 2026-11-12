// Display helpers for the AI & MCP admin page. No React and no `@/` alias.
import { DEFAULT_TIME_ZONE } from "@starter/shared/core";

function dayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: DEFAULT_TIME_ZONE,
  }).format(date);
}

/**
 * "Terakhir hari ini, 09.20": which day bucket a moment falls in (outlet time
 * zone) and the text to print. The page wraps it in catalog text.
 */
export function lastUsedParts(
  iso: string,
  now: Date,
): { day: "today" | "yesterday" | "other"; time: string; date: string } {
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime()))
    return { day: "other", time: iso, date: iso };
  const time = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: DEFAULT_TIME_ZONE,
  }).format(moment);
  const date = new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: DEFAULT_TIME_ZONE,
  }).format(moment);
  const yesterday = new Date(now.getTime() - 24 * 3_600_000);
  const key = dayKey(moment);
  if (key === dayKey(now)) return { day: "today", time, date };
  if (key === dayKey(yesterday)) return { day: "yesterday", time, date };
  return { day: "other", time, date };
}

/** First letter up, the rest untouched ("penjualan, SOP" -> "Penjualan, SOP"). */
export function capitalizeFirst(text: string): string {
  return text === "" ? text : text.charAt(0).toUpperCase() + text.slice(1);
}
