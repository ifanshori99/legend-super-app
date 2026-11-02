// Pure helpers of the kitchen config & analytics screens (bead legend-uq2).
// Loaded by Node tests with type stripping, so no runtime imports and no
// aliases: the contract types are erased at runtime.
import type {
  CapacityRule,
  CapacityRuleInput,
  CapacitySchedule,
} from "@starter/shared/kitchen";

/** PRD §3 F12 "Order Pacing": the windows the config screen offers. */
export const CAPACITY_WINDOWS = [15, 30, 45, 60] as const;

/** Days as `capacityScheduleSchema.daysOfWeek` numbers; 0 = Sunday. */
export const DAY_NUMBERS = [1, 2, 3, 4, 5, 6, 0] as const;

/** The channels of `channelSchema`, in the fixture's default priority. */
export const CAPACITY_CHANNELS = [
  "dine_in",
  "takeaway",
  "gofood",
  "grabfood",
  "shopeefood",
  "reservation",
] as const;

export type CapacityChannel = CapacityRuleInput["channelPriority"][number];

/** UI shape of one capacity rule: numbers stay text while the user types. */
export type ScheduleDraft = {
  daysOfWeek: number[];
  start: string;
  end: string;
};

export type RuleDraft = {
  windowMinutes: number;
  capacityPoints: string;
  nearPercent: string;
  schedules: ScheduleDraft[];
  channelPriority: CapacityChannel[];
};

/** What is wrong with a draft; the component maps it to catalog text. */
export type DraftProblem =
  "capacity" | "near" | "schedules" | "days" | "time" | "channels";

export function defaultRuleDraft(): RuleDraft {
  return {
    windowMinutes: 15,
    capacityPoints: "20",
    nearPercent: "90",
    schedules: [{ daysOfWeek: [...DAY_NUMBERS], start: "08:00", end: "22:00" }],
    channelPriority: [...CAPACITY_CHANNELS],
  };
}

/** Basis points → the percent a person types (9000 → "90"). */
export function basisPointsToPercent(bp: number): string {
  return String(bp / 100);
}

export function rulesToDrafts(rules: readonly CapacityRule[]): RuleDraft[] {
  return rules.map((rule) => ({
    windowMinutes: rule.windowMinutes,
    capacityPoints: String(rule.capacityPoints),
    nearPercent: basisPointsToPercent(rule.nearCapacityBp),
    schedules: rule.schedule.map((entry) => ({
      daysOfWeek: [...entry.daysOfWeek],
      start: entry.start,
      end: entry.end,
    })),
    channelPriority: [...rule.channelPriority],
  }));
}

function parsePositiveInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** First problem in the draft, in the order the fields appear on screen. */
export function draftProblem(draft: RuleDraft): DraftProblem | null {
  const capacity = parsePositiveInteger(draft.capacityPoints);
  if (capacity === null || capacity <= 0 || capacity > 10_000)
    return "capacity";
  const near = parsePositiveInteger(draft.nearPercent);
  if (near === null || near <= 0 || near > 100) return "near";
  if (draft.schedules.length === 0 || draft.schedules.length > 8)
    return "schedules";
  for (const schedule of draft.schedules) {
    if (schedule.daysOfWeek.length === 0) return "days";
    if (schedule.start === "" || schedule.end === "") return "time";
    // Same-day windows only: a window that ends before it starts is a typo,
    // not an overnight service span (PRD §3 F12 schedules meals by hour).
    if (!/^\d{2}:\d{2}$/.test(schedule.start)) return "time";
    if (!/^\d{2}:\d{2}$/.test(schedule.end)) return "time";
    if (schedule.start >= schedule.end) return "time";
  }
  if (draft.channelPriority.length === 0) return "channels";
  if (new Set(draft.channelPriority).size !== draft.channelPriority.length)
    return "channels";
  return null;
}

/** The request body the contract accepts, or null while the draft is invalid. */
export function draftToRuleInput(draft: RuleDraft): CapacityRuleInput | null {
  if (draftProblem(draft) !== null) return null;
  const schedule: CapacitySchedule[] = draft.schedules.map((entry) => ({
    daysOfWeek: [...entry.daysOfWeek].sort(),
    start: entry.start,
    end: entry.end,
  }));
  return {
    windowMinutes: draft.windowMinutes,
    capacityPoints: Number.parseInt(draft.capacityPoints, 10),
    nearCapacityBp: Number.parseInt(draft.nearPercent, 10) * 100,
    schedule,
    channelPriority: [...draft.channelPriority],
  };
}

export function draftsToRuleInputs(
  drafts: readonly RuleDraft[],
): CapacityRuleInput[] | null {
  const rules: CapacityRuleInput[] = [];
  for (const draft of drafts) {
    const rule = draftToRuleInput(draft);
    if (rule === null) return null;
    rules.push(rule);
  }
  return rules.length > 0 && rules.length <= 24 ? rules : null;
}

/** Move one priority entry up or down without mutating the list. */
export function moveChannel(
  channels: readonly CapacityChannel[],
  channel: CapacityChannel,
  direction: -1 | 1,
): CapacityChannel[] {
  const next = [...channels];
  const index = next.indexOf(channel);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** 660 → { minutes: 11, seconds: 0 }; the component formats the catalog text. */
export function durationParts(seconds: number): {
  minutes: number;
  seconds: number;
} {
  return { minutes: Math.floor(seconds / 60), seconds: seconds % 60 };
}

/**
 * A fixture-safe short reference for ids the contract only carries as ids
 * (order, item, staff): the last four characters, shown with the full id in
 * the title attribute. Readable names need a projection the contract does not
 * have yet (follow-up bead).
 */
export function shortRef(id: string, length = 4): string {
  const compact = id.replaceAll("-", "");
  return compact.slice(-length).toUpperCase();
}

/** Whether a business-date period contains one date (inclusive, ISO dates). */
export function periodIncludesDate(
  startDate: string,
  endDate: string,
  date: string,
): boolean {
  return startDate <= date && date <= endDate;
}

/**
 * Last seven outlet business days including today. "Today" is the outlet's
 * calendar day, not UTC's: 01:00 WIB on 2 Nov is still 1 Nov in UTC, and the
 * report must still default to 2 Nov (business dates are the outlet's).
 */
export function recentBusinessPeriod(
  now: Date,
  timeZone: string,
  days = 7,
): { startDate: string; endDate: string } {
  const endDate = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  const [year, month, day] = endDate.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, day - (days - 1)));
  return { startDate: start.toISOString().slice(0, 10), endDate };
}
