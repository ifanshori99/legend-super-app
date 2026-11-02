// Pure helpers of the loyalty back office (bead legend-m8ow; PRD v1.7 §3.20
// "Loyalty & Membership", §6.G). No React and no DOM at import time, and only
// relative or bare package imports, so tests/legend-m8ow.test.mjs loads this
// file with Node type stripping.
//
// The screen shows exactly what the contract stores: the program's earn ratio,
// expiry window and point value, the tier ladder with its benefits, the reward
// catalog (stock + validity) and the mission rules. Formatting and validation
// live here so the forms stay thin and the rules are testable.

import type { EndpointInput } from "@starter/shared/api";
import {
  DEFAULT_BUSINESS_DAY_CLOCK,
  businessDateOf,
  businessDayRange,
  idrSchema,
  type BusinessDayClock,
} from "@starter/shared/core";
import type { MessageKey, TranslateVars } from "@starter/shared/i18n";
import type {
  LoyaltyProgram,
  LoyaltyTier,
  Mission,
  MissionPeriod,
  MissionReward,
  MissionRule,
  MissionType,
  Reward,
  RewardType,
} from "@starter/shared/crm";
import {
  createLoyaltyTier,
  createMission,
  createReward,
  updateLoyaltyProgram,
} from "@starter/shared/crm";

type CreateTierBody = EndpointInput<typeof createLoyaltyTier>["body"];
type CreateRewardBody = EndpointInput<typeof createReward>["body"];
type CreateMissionBody = EndpointInput<typeof createMission>["body"];
type UpdateProgramBody = EndpointInput<typeof updateLoyaltyProgram>["body"];

/** 10.000 basis points = 1× (see pointsMultiplierBpSchema). */
export const MULTIPLIER_BP_BASE = 10_000;

/** Field → catalog key of the message that says how to fix it. */
export type ValidationErrors<Field extends string> = Partial<
  Record<Field, MessageKey>
>;

/** 15.000 → "1,5×"; 10.000 → "1×". */
export function formatMultiplier(multiplierBp: number): string {
  const value = new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 2,
  }).format(multiplierBp / MULTIPLIER_BP_BASE);
  return `${value}×`;
}

/** "1,5" or "1.5" → 15.000; null when it is not a 1×–10× multiplier. */
export function parseMultiplier(input: string): number | null {
  const normalized = input.trim().replace(",", ".");
  if (normalized === "") return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const bp = Math.round(value * MULTIPLIER_BP_BASE);
  if (bp < MULTIPLIER_BP_BASE || bp > 10 * MULTIPLIER_BP_BASE) return null;
  return bp;
}

/**
 * Outlet business day of an instant, as `<input type="date">` wants it
 * (docs/plan/AGENT_PLAYBOOK.md: business dates in the outlet time zone, owner
 * Q39: the day starts at the outlet business-day cutoff, default 04:00).
 */
export function dateInputValue(
  iso: string,
  clock: BusinessDayClock = DEFAULT_BUSINESS_DAY_CLOCK,
): string {
  return businessDateOf(iso, clock);
}

/**
 * `<input type="date">` value → instant. A validity range names whole outlet
 * business days (owner Q39), so the start is that day's cutoff and the end one
 * second before the next cutoff ("2026-11-01" start in WIB at 04:00 =
 * 2026-10-31T21:00:00Z); the field round-trips through dateInputValue without
 * shifting a day.
 */
export function isoFromDateInput(
  value: string,
  edge: "start" | "end",
  clock: BusinessDayClock = DEFAULT_BUSINESS_DAY_CLOCK,
): string {
  const range = businessDayRange(value, clock);
  return edge === "start"
    ? range.start.toISOString()
    : new Date(range.end.getTime() - 1000).toISOString();
}

/** True when the URL asks mock mode for a non-normal scenario (?mock=empty). */
export function isMockScenarioRequest(searchStr: string): boolean {
  const scenario = new URLSearchParams(searchStr).get("mock");
  return scenario !== null && scenario !== "normal";
}

/** A whole number from a text input; null when empty or not an integer. */
export function parseWholeNumber(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** A business date passes through; an instant becomes its outlet day. */
function calendarDay(value: string): string {
  return value.length > 10
    ? businessDateOf(value, DEFAULT_BUSINESS_DAY_CLOCK)
    : value;
}

const DAY_FORMAT = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * "2026-10-01" or an ISO instant → "1 Okt 2026". An instant is read as its
 * outlet business day, so server and browser renders agree on the day.
 */
export function formatDateLabel(value: string): string {
  const [year, month, day] = calendarDay(value).split("-").map(Number);
  return DAY_FORMAT.format(Date.UTC(year, month - 1, day));
}

/** "2026-10-01" or an ISO instant → "01/10/2026" for compact table cells. */
export function formatDateShort(value: string): string {
  const [year, month, day] = calendarDay(value).split("-");
  return `${day}/${month}/${year}`;
}

// ---- Catalog keys ---------------------------------------------------------

export const WEEKDAY_KEYS: readonly MessageKey[] = [
  "loyalty.missions.days.min",
  "loyalty.missions.days.sen",
  "loyalty.missions.days.sel",
  "loyalty.missions.days.rab",
  "loyalty.missions.days.kam",
  "loyalty.missions.days.jum",
  "loyalty.missions.days.sab",
];

export function rewardTypeKey(type: RewardType): MessageKey {
  return `loyalty.rewards.types.${type}`;
}

export function missionTypeKey(type: MissionType): MessageKey {
  return `loyalty.missions.types.${type}`;
}

export function rewardKindKey(kind: MissionReward["kind"]): MessageKey {
  return `loyalty.missions.rewardKinds.${kind}`;
}

export function missionPeriodKey(kind: MissionPeriod["kind"]): MessageKey {
  return `loyalty.missions.periods.${kind}`;
}

/** One-line rule summary for the list; the component translates it. */
export function missionRuleSummary(
  rule: MissionRule,
  dayLabel: (weekday: number) => string,
): { key: MessageKey; vars?: TranslateVars } {
  switch (rule.kind) {
    case "visit_count":
      return {
        key: "loyalty.missions.summary.visits",
        vars: { count: rule.targetVisits },
      };
    case "try_new_item":
      return rule.menuItemIds.length === 0
        ? {
            key: "loyalty.missions.summary.tryNewItemsAny",
            vars: { count: rule.targetItems },
          }
        : {
            key: "loyalty.missions.summary.tryNewItems",
            vars: {
              count: rule.targetItems,
              items: rule.menuItemIds.length,
            },
          };
    case "weekday_visit":
      return {
        key: "loyalty.missions.summary.weekdayVisits",
        vars: {
          count: rule.targetVisits,
          days: rule.weekdays
            .slice()
            .sort((a, b) => a - b)
            .map(dayLabel)
            .join(", "),
        },
      };
    case "stamp_card":
      return {
        key: "loyalty.missions.summary.stamps",
        vars: { count: rule.stampsRequired },
      };
  }
}

/** One-line reward summary; the caller supplies the rupiah formatter. */
export function missionRewardSummary(
  reward: MissionReward,
  formatIdr: (value: number) => string,
): { key: MessageKey; vars?: TranslateVars } {
  return reward.kind === "points"
    ? { key: "loyalty.missions.summary.points", vars: { count: reward.points } }
    : {
        key: "loyalty.missions.summary.voucher",
        vars: { value: formatIdr(reward.valueIdr) },
      };
}

/** Period label: monthly/weekly, or the exact date range. */
export function missionPeriodSummary(
  period: MissionPeriod,
  formatDate: (value: string) => string,
): { key: MessageKey; vars?: TranslateVars } {
  if (period.kind !== "date_range")
    return { key: missionPeriodKey(period.kind) };
  return {
    key: "loyalty.missions.summary.dateRange",
    vars: { start: formatDate(period.start), end: formatDate(period.end) },
  };
}

// ---- Program form ---------------------------------------------------------

export type ProgramForm = {
  name: string;
  earnSpend: string;
  earnPoints: string;
  expiry: string;
  rolling: string;
  pointValue: string;
};

export type ProgramField = keyof ProgramForm;

export function programFormFrom(program: LoyaltyProgram): ProgramForm {
  return {
    name: program.name,
    earnSpend: String(program.earnRate.spendIdr),
    earnPoints: String(program.earnRate.points),
    expiry: String(program.expiryMonths),
    rolling: String(program.rollingMonths),
    pointValue: String(program.pointValueIdr),
  };
}

function isPositiveInt(value: number | null, max: number): boolean {
  return value !== null && value >= 1 && value <= max;
}

export function validateProgramForm(
  form: ProgramForm,
): ValidationErrors<ProgramField> {
  const errors: ValidationErrors<ProgramField> = {};
  if (form.name.trim() === "") errors.name = "loyalty.program.errors.name";
  if (!isPositiveInt(parseWholeNumber(form.earnSpend), Number.MAX_SAFE_INTEGER))
    errors.earnSpend = "loyalty.program.errors.earnSpend";
  if (
    !isPositiveInt(parseWholeNumber(form.earnPoints), Number.MAX_SAFE_INTEGER)
  )
    errors.earnPoints = "loyalty.program.errors.earnPoints";
  if (!isPositiveInt(parseWholeNumber(form.expiry), 60))
    errors.expiry = "loyalty.program.errors.expiry";
  if (!isPositiveInt(parseWholeNumber(form.rolling), 60))
    errors.rolling = "loyalty.program.errors.rolling";
  if (
    !isPositiveInt(parseWholeNumber(form.pointValue), Number.MAX_SAFE_INTEGER)
  )
    errors.pointValue = "loyalty.program.errors.pointValue";
  return errors;
}

/** Request body once the form has no errors (TEN-02: no id/tenant fields). */
export function programBody(form: ProgramForm): UpdateProgramBody {
  return {
    name: form.name.trim(),
    earnRate: {
      spendIdr: Number(form.earnSpend),
      points: Number(form.earnPoints),
    },
    expiryMonths: Number(form.expiry),
    rollingMonths: Number(form.rolling),
    pointValueIdr: Number(form.pointValue),
  };
}

/** Program plus tiers, the shape of getLoyaltyProgram. */
export type ProgramPayload = {
  program: LoyaltyProgram;
  tiers: LoyaltyTier[];
};

// ---- Tier form ------------------------------------------------------------

export type TierForm = {
  name: string;
  rank: string;
  spend: string;
  visits: string;
  multiplier: string;
  birthdayPoints: string;
  reservationPriority: boolean;
  exclusivePromotions: boolean;
  facilityQuota: string;
  isActive: boolean;
};

export type TierField = keyof TierForm;

/** Defaults for a new tier: the lowest rung of the ladder. */
export function emptyTierForm(): TierForm {
  return {
    name: "",
    rank: "1",
    spend: "0",
    visits: "0",
    multiplier: "1",
    birthdayPoints: "0",
    reservationPriority: false,
    exclusivePromotions: false,
    facilityQuota: "0",
    isActive: true,
  };
}

export function tierFormFrom(tier: LoyaltyTier): TierForm {
  return {
    name: tier.name,
    rank: String(tier.rank),
    spend: String(tier.thresholdSpendIdr),
    visits: String(tier.thresholdVisits),
    multiplier: String(tier.benefits.pointsMultiplierBp / MULTIPLIER_BP_BASE)
      .replace(".", ",")
      .replace(/,0$/, ""),
    birthdayPoints: String(tier.benefits.birthdayRewardPoints),
    reservationPriority: tier.benefits.reservationPriority,
    exclusivePromotions: tier.benefits.exclusivePromotions,
    facilityQuota: String(tier.benefits.facilityFreeAccessQuota),
    isActive: tier.isActive,
  };
}

export function validateTierForm(form: TierForm): ValidationErrors<TierField> {
  const errors: ValidationErrors<TierField> = {};
  if (form.name.trim() === "") errors.name = "loyalty.tiers.errors.name";
  if (!isPositiveInt(parseWholeNumber(form.rank), Number.MAX_SAFE_INTEGER))
    errors.rank = "loyalty.tiers.errors.rank";
  const spend = parseWholeNumber(form.spend);
  if (spend === null || spend < 0) errors.spend = "loyalty.tiers.errors.spend";
  const visits = parseWholeNumber(form.visits);
  if (visits === null || visits < 0)
    errors.visits = "loyalty.tiers.errors.visits";
  if (parseMultiplier(form.multiplier) === null)
    errors.multiplier = "loyalty.tiers.errors.multiplier";
  const birthday = parseWholeNumber(form.birthdayPoints);
  if (birthday === null || birthday < 0)
    errors.birthdayPoints = "loyalty.tiers.errors.birthdayPoints";
  const quota = parseWholeNumber(form.facilityQuota);
  if (quota === null || quota < 0)
    errors.facilityQuota = "loyalty.tiers.errors.facilityQuota";
  return errors;
}

export function tierBody(form: TierForm): CreateTierBody {
  return {
    name: form.name.trim(),
    rank: Number(form.rank),
    thresholdSpendIdr: Number(form.spend),
    thresholdVisits: Number(form.visits),
    benefits: {
      pointsMultiplierBp:
        parseMultiplier(form.multiplier) ?? MULTIPLIER_BP_BASE,
      birthdayRewardPoints: Number(form.birthdayPoints),
      reservationPriority: form.reservationPriority,
      exclusivePromotions: form.exclusivePromotions,
      facilityFreeAccessQuota: Number(form.facilityQuota),
    },
    isActive: form.isActive,
  };
}

// ---- Reward form ----------------------------------------------------------

export type RewardForm = {
  name: string;
  description: string;
  type: RewardType;
  pointsCost: string;
  stock: string;
  validFrom: string;
  validUntil: string;
  menuItemId: string;
  voucherValue: string;
  sortOrder: string;
  isActive: boolean;
};

export type RewardField = keyof RewardForm;

export function rewardFormFrom(reward: Reward): RewardForm {
  return {
    name: reward.name,
    description: reward.description,
    type: reward.type,
    pointsCost: String(reward.pointsCost),
    stock: reward.stock === null ? "" : String(reward.stock),
    validFrom: dateInputValue(reward.validFrom),
    validUntil:
      reward.validUntil === null ? "" : dateInputValue(reward.validUntil),
    menuItemId: reward.menuItemId ?? "",
    voucherValue:
      reward.voucherValueIdr === null ? "" : String(reward.voucherValueIdr),
    sortOrder: String(reward.sortOrder),
    isActive: reward.isActive,
  };
}

export function emptyRewardForm(now: Date = new Date()): RewardForm {
  return {
    name: "",
    description: "",
    type: "free_item",
    pointsCost: "100",
    stock: "",
    validFrom: dateInputValue(now.toISOString()),
    validUntil: "",
    menuItemId: "",
    voucherValue: "",
    sortOrder: "0",
    isActive: true,
  };
}

export function validateRewardForm(
  form: RewardForm,
): ValidationErrors<RewardField> {
  const errors: ValidationErrors<RewardField> = {};
  if (form.name.trim() === "") errors.name = "loyalty.rewards.errors.name";
  if (
    !isPositiveInt(parseWholeNumber(form.pointsCost), Number.MAX_SAFE_INTEGER)
  )
    errors.pointsCost = "loyalty.rewards.errors.pointsCost";
  if (form.stock.trim() !== "") {
    const stock = parseWholeNumber(form.stock);
    if (stock === null || stock < 0)
      errors.stock = "loyalty.rewards.errors.stock";
  }
  if (form.validFrom.trim() === "")
    errors.validFrom = "loyalty.rewards.errors.validFrom";
  if (
    form.validUntil.trim() !== "" &&
    form.validFrom.trim() !== "" &&
    form.validUntil < form.validFrom
  )
    errors.validUntil = "loyalty.rewards.errors.validUntil";
  if (form.type === "voucher") {
    const value = parseWholeNumber(form.voucherValue);
    if (value === null || value < 1)
      errors.voucherValue = "loyalty.rewards.errors.voucherValue";
  } else if (form.menuItemId.trim() === "") {
    errors.menuItemId = "loyalty.rewards.errors.menuItem";
  }
  if (parseWholeNumber(form.sortOrder) === null)
    errors.sortOrder = "loyalty.rewards.errors.sortOrder";
  return errors;
}

export function rewardBody(form: RewardForm): CreateRewardBody {
  const isVoucher = form.type === "voucher";
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    type: form.type,
    pointsCost: Number(form.pointsCost),
    stock: form.stock.trim() === "" ? null : Number(form.stock),
    validFrom: isoFromDateInput(form.validFrom, "start"),
    validUntil:
      form.validUntil.trim() === ""
        ? null
        : isoFromDateInput(form.validUntil, "end"),
    menuItemId: isVoucher ? null : form.menuItemId,
    voucherValueIdr: isVoucher ? Number(form.voucherValue) : null,
    isActive: form.isActive,
    sortOrder: Number(form.sortOrder),
  };
}

// ---- Mission form ---------------------------------------------------------

export type MissionForm = {
  name: string;
  description: string;
  type: MissionType;
  targetVisits: string;
  targetItems: string;
  stamps: string;
  weekdays: number[];
  menuItemIds: string[];
  rewardKind: MissionReward["kind"];
  points: string;
  voucherValue: string;
  voucherValidDays: string;
  period: MissionPeriod["kind"];
  periodStart: string;
  periodEnd: string;
  isActive: boolean;
};

export type MissionField = keyof MissionForm;

export function emptyMissionForm(): MissionForm {
  return {
    name: "",
    description: "",
    type: "visit_count",
    targetVisits: "3",
    targetItems: "2",
    stamps: "10",
    weekdays: [1, 2, 3, 4, 5],
    menuItemIds: [],
    rewardKind: "points",
    points: "100",
    voucherValue: "20000",
    voucherValidDays: "30",
    period: "monthly",
    periodStart: "",
    periodEnd: "",
    isActive: true,
  };
}

export function missionFormFrom(mission: Mission): MissionForm {
  const form = emptyMissionForm();
  form.name = mission.name;
  form.description = mission.description;
  form.type = mission.type;
  form.rewardKind = mission.reward.kind;
  form.points =
    mission.reward.kind === "points" ? String(mission.reward.points) : "100";
  form.voucherValue =
    mission.reward.kind === "voucher"
      ? String(mission.reward.valueIdr)
      : "20000";
  form.voucherValidDays =
    mission.reward.kind === "voucher" ? String(mission.reward.validDays) : "30";
  form.period = mission.period.kind;
  form.isActive = mission.isActive;
  if (mission.period.kind === "date_range") {
    form.periodStart = mission.period.start;
    form.periodEnd = mission.period.end;
  }
  if (mission.rule.kind === "visit_count")
    form.targetVisits = String(mission.rule.targetVisits);
  if (mission.rule.kind === "try_new_item") {
    form.targetItems = String(mission.rule.targetItems);
    form.menuItemIds = [...mission.rule.menuItemIds];
  }
  if (mission.rule.kind === "weekday_visit") {
    form.weekdays = [...mission.rule.weekdays];
    form.targetVisits = String(mission.rule.targetVisits);
  }
  if (mission.rule.kind === "stamp_card")
    form.stamps = String(mission.rule.stampsRequired);
  return form;
}

export function validateMissionForm(
  form: MissionForm,
): ValidationErrors<MissionField> {
  const errors: ValidationErrors<MissionField> = {};
  if (form.name.trim() === "") errors.name = "loyalty.missions.errors.name";
  const targetField: MissionField =
    form.type === "stamp_card"
      ? "stamps"
      : form.type === "try_new_item"
        ? "targetItems"
        : "targetVisits";
  if (
    !isPositiveInt(parseWholeNumber(form[targetField]), Number.MAX_SAFE_INTEGER)
  )
    errors[targetField] = "loyalty.missions.errors.target";
  if (form.type === "weekday_visit" && form.weekdays.length === 0)
    errors.weekdays = "loyalty.missions.errors.weekdays";
  if (form.rewardKind === "points") {
    if (!isPositiveInt(parseWholeNumber(form.points), Number.MAX_SAFE_INTEGER))
      errors.points = "loyalty.missions.errors.points";
  } else {
    const value = parseWholeNumber(form.voucherValue);
    if (value === null || value < 1)
      errors.voucherValue = "loyalty.missions.errors.voucherValue";
    const days = parseWholeNumber(form.voucherValidDays);
    if (days === null || days < 1 || days > 365)
      errors.voucherValidDays = "loyalty.missions.errors.validDays";
  }
  if (form.period === "date_range") {
    if (form.periodStart.trim() === "")
      errors.periodStart = "loyalty.missions.errors.periodStart";
    if (form.periodEnd.trim() === "")
      errors.periodEnd = "loyalty.missions.errors.periodEnd";
    if (
      form.periodStart !== "" &&
      form.periodEnd !== "" &&
      form.periodEnd < form.periodStart
    )
      errors.periodEnd = "loyalty.missions.errors.periodEnd";
  }
  return errors;
}

/** Rule built from the type, so rule.kind always matches the mission type. */
export function missionRuleFrom(form: MissionForm): MissionRule {
  switch (form.type) {
    case "visit_count":
      return { kind: "visit_count", targetVisits: Number(form.targetVisits) };
    case "try_new_item":
      return {
        kind: "try_new_item",
        targetItems: Number(form.targetItems),
        menuItemIds: form.menuItemIds,
      };
    case "weekday_visit":
      return {
        kind: "weekday_visit",
        weekdays: [...form.weekdays].sort((a, b) => a - b),
        targetVisits: Number(form.targetVisits),
      };
    case "stamp_card":
      return { kind: "stamp_card", stampsRequired: Number(form.stamps) };
  }
}

export function missionRewardFrom(form: MissionForm): MissionReward {
  return form.rewardKind === "points"
    ? { kind: "points", points: Number(form.points) }
    : {
        kind: "voucher",
        valueIdr: idrSchema.parse(Number(form.voucherValue)),
        validDays: Number(form.voucherValidDays),
      };
}

export function missionPeriodFrom(form: MissionForm): MissionPeriod {
  if (form.period === "date_range")
    return {
      kind: "date_range",
      start: form.periodStart,
      end: form.periodEnd,
    };
  return { kind: form.period };
}

export function missionBody(form: MissionForm): CreateMissionBody {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    type: form.type,
    rule: missionRuleFrom(form),
    reward: missionRewardFrom(form),
    period: missionPeriodFrom(form),
    isActive: form.isActive,
    startsAt: null,
    endsAt: null,
  };
}

/** True when the draft still has an error for that field. */
export function hasErrors<Field extends string>(
  errors: ValidationErrors<Field>,
): boolean {
  return Object.keys(errors).length > 0;
}
