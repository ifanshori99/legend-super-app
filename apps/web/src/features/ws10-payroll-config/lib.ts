// Pure helpers for the payroll configuration screens (bead legend-r1bu; PRD
// v1.7 §3 F30, PAYR-02). Versioning, immutability, proration and rounding are
// contract rules in @starter/shared/hris/payroll — this file only shapes what
// the screens show: business dates, cycle summaries, effective periods,
// statutory parameter rows and the overlap check.
//
// No React and no `@/` alias, so a unit test can load this file with plain
// Node ESM.

import type { BusinessDate, RoundingMode } from "@starter/shared/core";
import type { MessageKey } from "@starter/shared/i18n";
import { ptkpStatusSchema } from "@starter/shared/hris";
import type {
  EmployeeGroup,
  JkkRiskClass,
  OvertimeDayType,
  PayrollCycle,
  PayrollPolicy,
  PtkpStatus,
  RateBracket,
  StatutoryTableDraftInput,
  StatutoryTableType,
  StatutoryTableVersion,
  StatutoryTableVersionOf,
  StatutoryVersionStatus,
  ThrSchedule,
} from "@starter/shared/hris/payroll";
import {
  JKK_RISK_CLASSES,
  OVERTIME_DAY_TYPES,
  TER_CATEGORIES,
} from "@starter/shared/hris/payroll";

/** WIB business dates (the outlet/legal-entity time zone, D-CORE-6). */
export const PAYROLL_TIME_ZONE = "Asia/Jakarta";

/** PTKP statuses in contract order, for the statutory editors. */
export const PTKP_STATUS_LIST: readonly PtkpStatus[] = ptkpStatusSchema.options;

/** "2026-11-03" for the tenant's business date (never the device clock). */
export function businessDateToday(
  now: Date = new Date(),
  timeZone: string = PAYROLL_TIME_ZONE,
): BusinessDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
  }).format(now) as BusinessDate;
}

/** "2027-03-10" → "10 Mar 2027" (locale-stable, id-ID). */
export function formatBusinessDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** An API instant → "3 Nov 2026, 09.00" in the tenant zone (SSR-safe). */
export function formatDateTime(instant: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: PAYROLL_TIME_ZONE,
  }).format(new Date(instant));
}

function toUtc(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Calendar-day arithmetic on a business date (effective periods). */
export function addDays(date: string, days: number): BusinessDate {
  return new Date(toUtc(date) + days * 86_400_000)
    .toISOString()
    .slice(0, 10) as BusinessDate;
}

/** 1000 bp → "10%", 550 → "5,5%" (id-ID decimal comma, max 2 places). */
export function formatBasisPoints(basisPoints: number): string {
  return `${new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: 2,
  }).format(basisPoints / 100)}%`;
}

/**
 * Percent input → basis points, or null when the text is not a rate.
 * Accepts "10", "10,5" and "10.5" (max two decimals, 0–100%).
 */
export function parseRatePercent(input: string): number | null {
  const text = input.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const percent = Number(text);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.round(percent * 100);
}

/** "1.500.000" / "1500000" → 1500000, or null when not whole rupiah. */
export function parseRupiahInput(input: string): number | null {
  const text = input.replace(/[\s.]/g, "").replace(",", ".");
  if (!/^\d{1,15}$/.test(text)) return null;
  const amount = Number(text);
  return Number.isSafeInteger(amount) ? amount : null;
}

/** 1500000 → "1.500.000" for an input that masks digits as grouped rupiah. */
export function formatRupiahInput(amount: number | null): string {
  if (amount === null) return "";
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 }).format(
    amount,
  );
}

/** 550 bp → "5,5" for a percent input (empty for a null). */
export function formatRateInput(basisPoints: number | null): string {
  if (basisPoints === null) return "";
  return String(basisPoints / 100).replace(".", ",");
}

/** Whole rupiah digit mask: keeps digits, drops grouping and separators. */
export function maskRupiahTyping(input: string): string {
  const digits = input.replace(/\D/g, "").slice(0, 15);
  return digits === "" ? "" : formatRupiahInput(Number(digits));
}

/** "2" / "2,5" → canonical Decimal4 "2.0000" / "2.5000", or null. */
export function parseMultiplierInput(input: string): string | null {
  const text = input.trim().replace(",", ".");
  if (!/^\d{1,10}(\.\d{1,4})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return `${whole}.${fraction.padEnd(4, "0")}`;
}

/** Decimal4 "2.5000" → "2,5" for a multiplier input. */
export function formatMultiplierInput(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed === "" ? whole : `${whole},${trimmed}`;
}

// ---- Policies -------------------------------------------------------------

export const CYCLE_LABEL_KEYS: Record<PayrollCycle["frequency"], MessageKey> = {
  monthly: "payrollConfig.policies.cycle.monthly",
  biweekly: "payrollConfig.policies.cycle.biweekly",
  daily: "payrollConfig.policies.cycle.daily",
};

export const PAY_DATE_ADJUSTMENT_KEYS = {
  previous_working_day:
    "payrollConfig.policies.adjustment.previous_working_day",
  next_working_day: "payrollConfig.policies.adjustment.next_working_day",
  none: "payrollConfig.policies.adjustment.none",
} as const satisfies Record<string, MessageKey>;

export const JKK_RISK_KEYS: Record<JkkRiskClass, MessageKey> = {
  very_low: "payrollConfig.policies.jkk.very_low",
  low: "payrollConfig.policies.jkk.low",
  medium: "payrollConfig.policies.jkk.medium",
  high: "payrollConfig.policies.jkk.high",
  very_high: "payrollConfig.policies.jkk.very_high",
};

/** "Potong tgl 25, bayar tgl 28 bulan yang sama" without device locale. */
export function cycleSummary(
  cycle: PayrollCycle,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  switch (cycle.frequency) {
    case "monthly": {
      const month =
        cycle.payMonthOffset === 1
          ? t("payrollConfig.policies.schedule.nextMonth")
          : t("payrollConfig.policies.schedule.sameMonth");
      const payDay =
        cycle.payDay === null
          ? t("payrollConfig.policies.schedule.lastDay")
          : String(cycle.payDay);
      if (cycle.cutoffDay === null)
        return t("payrollConfig.policies.schedule.monthlyNoCutoff", {
          pay: payDay,
          month,
        });
      return t("payrollConfig.policies.schedule.monthlyWithCutoff", {
        cutoff: cycle.cutoffDay,
        pay: payDay,
        month,
      });
    }
    case "biweekly":
      return t("payrollConfig.policies.schedule.biweekly", {
        anchor: formatBusinessDate(cycle.anchorDate),
        days: cycle.payDaysAfterPeriodEnd,
      });
    case "daily":
      return t("payrollConfig.policies.schedule.daily", {
        days: cycle.payDaysAfterPeriodEnd,
      });
  }
}

export function employeeGroupSummary(group: EmployeeGroup): string {
  return `${group.name} · ${group.code}`;
}

/** Client-side search over a policy's name, group and cycle. */
export function filterPolicies(
  policies: readonly PayrollPolicy[],
  search: string,
  cycle: PayrollCycle["frequency"] | "all",
): PayrollPolicy[] {
  const needle = search.trim().toLocaleLowerCase("id-ID");
  return policies.filter((policy) => {
    if (cycle !== "all" && policy.cycle.frequency !== cycle) return false;
    if (needle === "") return true;
    return `${policy.name} ${policy.employeeGroup.name} ${policy.employeeGroup.code}`
      .toLocaleLowerCase("id-ID")
      .includes(needle);
  });
}

// ---- Statutory tables -----------------------------------------------------

export const STATUTORY_TYPE_KEYS: Record<StatutoryTableType, MessageKey> = {
  bpjs_kes: "payrollConfig.statutoryTypes.bpjs_kes",
  jht: "payrollConfig.statutoryTypes.jht",
  jkk: "payrollConfig.statutoryTypes.jkk",
  jkm: "payrollConfig.statutoryTypes.jkm",
  jp: "payrollConfig.statutoryTypes.jp",
  ptkp: "payrollConfig.statutoryTypes.ptkp",
  pph21_ter: "payrollConfig.statutoryTypes.pph21_ter",
  pph21_annual: "payrollConfig.statutoryTypes.pph21_annual",
  overtime: "payrollConfig.statutoryTypes.overtime",
  thr: "payrollConfig.statutoryTypes.thr",
};

export const STATUTORY_STATUS_KEYS: Record<
  StatutoryVersionStatus,
  MessageKey
> = {
  draft: "payrollConfig.statutoryStatus.draft",
  published: "payrollConfig.statutoryStatus.published",
  archived: "payrollConfig.statutoryStatus.archived",
};

export const ROUNDING_KEYS: Record<RoundingMode, MessageKey> = {
  half_up: "payrollConfig.rounding.half_up",
  half_even: "payrollConfig.rounding.half_even",
  down: "payrollConfig.rounding.down",
  floor: "payrollConfig.rounding.floor",
  ceil: "payrollConfig.rounding.ceil",
};

/** Versions of one type, newest first (effective date, then version). */
export function sortStatutoryVersions<T extends StatutoryTableVersion>(
  versions: readonly T[],
): T[] {
  return [...versions].sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      b.effectiveFrom.localeCompare(a.effectiveFrom) ||
      b.version - a.version,
  );
}

/** Version chains of one table type, newest first. */
export function versionsOfType(
  versions: readonly StatutoryTableVersion[],
  type: StatutoryTableType,
): StatutoryTableVersion[] {
  return versions
    .filter((version) => version.type === type)
    .sort(
      (a, b) =>
        b.effectiveFrom.localeCompare(a.effectiveFrom) || b.version - a.version,
    );
}

/** The previous row in the same chain, for the "compare versions" diff. */
export function previousVersion(
  version: StatutoryTableVersion,
  versions: readonly StatutoryTableVersion[],
): StatutoryTableVersion | undefined {
  const chain = versionsOfType(versions, version.type);
  const index = chain.findIndex((row) => row.id === version.id);
  return index >= 0 ? chain[index + 1] : undefined;
}

/** The published version in force on a date (latest effectiveFrom ≤ date). */
export function effectiveVersion<T extends StatutoryTableVersion>(
  versions: readonly T[],
  type: StatutoryTableType,
  onDate: string,
): T | undefined {
  let best: T | undefined;
  for (const version of versions) {
    if (version.type !== type) continue;
    if (version.status !== "published") continue;
    if (version.effectiveFrom > onDate) continue;
    if (
      !best ||
      version.effectiveFrom > best.effectiveFrom ||
      (version.effectiveFrom === best.effectiveFrom &&
        version.version > best.version)
    )
      best = version as T;
  }
  return best;
}

/** The published version of one type in force on a date, typed to its table. */
export function publishedVersionOf<T extends StatutoryTableType>(
  versions: readonly StatutoryTableVersion[],
  type: T,
  onDate: string,
): StatutoryTableVersionOf<T> | undefined {
  return effectiveVersion(versions, type, onDate) as
    | StatutoryTableVersionOf<T>
    | undefined;
}

/**
 * End of a version's period: the day before the next version's effective date
 * in the same chain; null when no later version exists.
 */export function effectiveUntil(
  version: StatutoryTableVersion,
  versions: readonly StatutoryTableVersion[],
): BusinessDate | null {
  const chain = versionsOfType(versions, version.type);
  const later = chain
    .filter((row) => row.effectiveFrom > version.effectiveFrom)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  return later ? addDays(later.effectiveFrom, -1) : null;
}

export type StatutoryConflict = {
  type: StatutoryTableType;
  effectiveFrom: BusinessDate;
  count: number;
};

/**
 * Published versions of one type that share an effective date. The contract's
 * resolver refuses such a table (`PAYROLL_STATUTORY_TABLE_AMBIGUOUS`), so the
 * banner surfaces it before payroll does (PAYR-02).
 */
export function statutoryConflicts(
  versions: readonly StatutoryTableVersion[],
): StatutoryConflict[] {
  const seen = new Map<string, StatutoryConflict>();
  for (const version of versions) {
    if (version.status !== "published") continue;
    const key = `${version.type}:${version.effectiveFrom}`;
    const found = seen.get(key);
    if (found) found.count += 1;
    else
      seen.set(key, {
        type: version.type,
        effectiveFrom: version.effectiveFrom,
        count: 1,
      });
  }
  return [...seen.values()]
    .filter((conflict) => conflict.count > 1)
    .sort(
      (a, b) =>
        a.type.localeCompare(b.type) ||
        a.effectiveFrom.localeCompare(b.effectiveFrom),
    );
}

/**
 * Default effective date for a new statutory version: never before today, and
 * after the latest version of the same table so the chain stays unambiguous
 * (PAYR-02, mirrors the tax engine's R21 suggestion).
 */
export function suggestStatutoryEffectiveFrom(
  versions: readonly StatutoryTableVersion[],
  type: StatutoryTableType,
  today: string,
): BusinessDate {
  const chain = versionsOfType(versions, type);
  const latest = chain.reduce<string | undefined>(
    (best, row) => (best === undefined || row.effectiveFrom > best ? row.effectiveFrom : best),
    undefined,
  );
  if (latest !== undefined && latest >= today) return addDays(latest, 1);
  return today as BusinessDate;
}

// ---- Parameter rows (detail, editor seeds, version diff) -----------------

export type ParameterValueKind = "amount" | "rate" | "decimal" | "count" | "text";

export type ParameterRow = {
  key: string;
  labelKey: MessageKey;
  labelVars?: Record<string, string | number>;
  /** Catalog keys for label vars that name an enum, e.g. dayType. */
  varKeys?: Record<string, MessageKey>;
  kind: ParameterValueKind;
  /** Raw parameter value; null renders as the row's nullKey. */
  value: string | number | null;
  /** What an empty value means for this row ("tanpa batas atas"). */
  nullKey?: MessageKey;
  /** Catalog key for the value itself when kind is text. */
  enumKey?: MessageKey;
};

/**
 * Flattens a statutory parameter object into labelled rows for the read-only
 * detail table and the version diff. Every row carries a catalog key so no
 * label is written in a component.
 */
export function parameterRows(
  draft: StatutoryTableDraftInput,
): ParameterRow[] {
  const rows: ParameterRow[] = [];
  const add = (
    labelKey: MessageKey,
    kind: ParameterValueKind,
    value: string | number | null,
    options: {
      labelVars?: Record<string, string | number>;
      varKeys?: Record<string, MessageKey>;
      enumKey?: MessageKey;
      nullKey?: MessageKey;
    } = {},
  ) => {
    const key = `${labelKey}|${JSON.stringify(options.labelVars ?? {})}`;
    rows.push({ key, labelKey, kind, value, ...options });
  };
  const rounding = (mode: RoundingMode) =>
    add("payrollConfig.statutory.parameterLabels.rounding", "text", mode, {
      enumKey: ROUNDING_KEYS[mode],
    });

  switch (draft.type) {
    case "bpjs_kes":
    case "jht":
    case "jkm":
    case "jp": {
      const p = draft.parameters;
      add(
        "payrollConfig.statutory.parameterLabels.employerRate",
        "rate",
        p.employerRateBp,
      );
      add(
        "payrollConfig.statutory.parameterLabels.employeeRate",
        "rate",
        p.employeeRateBp,
      );
      add(
        "payrollConfig.statutory.parameterLabels.wageCap",
        "amount",
        p.wageCapIdr,
        { nullKey: "payrollConfig.statutory.parameterLabels.noCap" },
      );
      add(
        "payrollConfig.statutory.parameterLabels.wageFloor",
        "amount",
        p.wageFloorIdr,
        { nullKey: "payrollConfig.statutory.parameterLabels.noFloor" },
      );
      rounding(p.roundingMode);
      break;
    }
    case "jkk": {
      const p = draft.parameters;
      for (const riskClass of JKK_RISK_CLASSES)
        add(
          "payrollConfig.statutory.parameterLabels.jkkRate",
          "rate",
          p.employerRateBpByRiskClass[riskClass],
          {
            labelVars: { riskClass },
            varKeys: { riskClass: JKK_RISK_KEYS[riskClass] },
          },
        );
      add(
        "payrollConfig.statutory.parameterLabels.employeeRate",
        "rate",
        p.employeeRateBp,
      );
      add(
        "payrollConfig.statutory.parameterLabels.wageCap",
        "amount",
        p.wageCapIdr,
        { nullKey: "payrollConfig.statutory.parameterLabels.noCap" },
      );
      add(
        "payrollConfig.statutory.parameterLabels.wageFloor",
        "amount",
        p.wageFloorIdr,
        { nullKey: "payrollConfig.statutory.parameterLabels.noFloor" },
      );
      rounding(p.roundingMode);
      break;
    }
    case "ptkp": {
      const p = draft.parameters;
      for (const status of PTKP_STATUS_LIST)
        add(
          "payrollConfig.statutory.parameterLabels.ptkp",
          "amount",
          p.annualAmountIdrByStatus[status],
          { labelVars: { status } },
        );
      break;
    }
    case "pph21_ter": {
      const p = draft.parameters;
      for (const status of PTKP_STATUS_LIST)
        add(
          "payrollConfig.statutory.parameterLabels.terCategory",
          "text",
          p.categoryByPtkpStatus[status],
          { labelVars: { status } },
        );
      for (const category of TER_CATEGORIES)
        pushBrackets(rows, draft.type, category, p.bracketsByCategory[category]);
      rounding(p.roundingMode);
      break;
    }
    case "pph21_annual": {
      const p = draft.parameters;
      pushBrackets(rows, draft.type, null, p.brackets);
      add(
        "payrollConfig.statutory.parameterLabels.occupationalRate",
        "rate",
        p.occupationalCostRateBp,
      );
      add(
        "payrollConfig.statutory.parameterLabels.occupationalCap",
        "amount",
        p.occupationalCostAnnualCapIdr,
      );
      add(
        "payrollConfig.statutory.parameterLabels.taxableRoundDown",
        "amount",
        p.taxableIncomeRoundDownToIdr,
      );
      add(
        "payrollConfig.statutory.parameterLabels.noTaxIdSurcharge",
        "rate",
        p.noTaxIdSurchargeBp,
        { nullKey: "payrollConfig.statutory.parameterLabels.unset" },
      );
      rounding(p.roundingMode);
      break;
    }
    case "overtime": {
      const p = draft.parameters;
      add(
        "payrollConfig.statutory.parameterLabels.divisor",
        "count",
        p.monthlyHoursDivisor,
      );
      for (const dayType of OVERTIME_DAY_TYPES) {
        const dayTypeKey = dayTypeNameKey(dayType);
        p.tiersByDayType[dayType].forEach((tier, index) => {
          const position = index + 1;
          const vars = { dayType, index: position };
          const varKeys = { dayType: dayTypeKey };
          add(
            "payrollConfig.statutory.parameterLabels.tierFrom",
            "count",
            tier.fromHour,
            { labelVars: vars, varKeys },
          );
          add(
            "payrollConfig.statutory.parameterLabels.tierTo",
            "count",
            tier.toHour,
            { labelVars: vars, varKeys },
          );
          add(
            "payrollConfig.statutory.parameterLabels.multiplier",
            "decimal",
            tier.multiplier,
            { labelVars: vars, varKeys },
          );
        });
      }
      rounding(p.roundingMode);
      break;
    }
    case "thr": {
      const p = draft.parameters;
      add(
        "payrollConfig.statutory.parameterLabels.minTenure",
        "count",
        p.minTenureMonths,
      );
      add(
        "payrollConfig.statutory.parameterLabels.fullTenure",
        "count",
        p.fullTenureMonths,
      );
      rounding(p.roundingMode);
      break;
    }
  }
  return rows;
}

function dayTypeNameKey(dayType: OvertimeDayType): MessageKey {
  return `payrollConfig.statutory.form.dayType.${dayType}` as MessageKey;
}

function pushBrackets(
  rows: ParameterRow[],
  type: "pph21_ter" | "pph21_annual",
  category: string | null,
  brackets: readonly RateBracket[],
): void {
  brackets.forEach((bracket, index) => {
    const position = index + 1;
    const labelKey: MessageKey =
      type === "pph21_ter"
        ? "payrollConfig.statutory.parameterLabels.terBracketUpTo"
        : "payrollConfig.statutory.parameterLabels.annualBracketUpTo";
    const rateKey: MessageKey =
      type === "pph21_ter"
        ? "payrollConfig.statutory.parameterLabels.terBracketRate"
        : "payrollConfig.statutory.parameterLabels.annualBracketRate";
    const vars = category === null ? { index: position } : { category, index: position };
    rows.push({
      key: `${labelKey}|${JSON.stringify(vars)}`,
      labelKey,
      labelVars: vars,
      kind: "amount",
      value: bracket.upToIdr,
      nullKey: "payrollConfig.statutory.parameterLabels.openEnded",
    });
    rows.push({
      key: `${rateKey}|${JSON.stringify(vars)}`,
      labelKey: rateKey,
      labelVars: vars,
      kind: "rate",
      value: bracket.rateBp,
    });
  });
}

export type ParameterDiff = {
  key: string;
  labelKey: MessageKey;
  labelVars?: Record<string, string | number>;
  varKeys?: Record<string, MessageKey>;
  kind: ParameterValueKind;
  enumKey?: MessageKey;
  nullKey?: MessageKey;
  from: ParameterRow["value"];
  to: ParameterRow["value"];
  changed: boolean;
};

/** Union of both versions' rows, keyed, with the changed ones flagged. */
export function diffParameterRows(
  from: StatutoryTableDraftInput,
  to: StatutoryTableDraftInput,
): ParameterDiff[] {
  const before = new Map(parameterRows(from).map((row) => [row.key, row]));
  const after = new Map(parameterRows(to).map((row) => [row.key, row]));
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  return keys.map((key) => {
    const left = before.get(key);
    const right = after.get(key);
    const template = right ?? left;
    if (!template) throw new TypeError(`Unknown parameter row ${key}`);
    return {
      key,
      labelKey: template.labelKey,
      labelVars: template.labelVars,
      varKeys: template.varKeys,
      kind: template.kind,
      enumKey: template.enumKey,
      nullKey: template.nullKey,
      from: left?.value ?? null,
      to: right?.value ?? null,
      changed: (left?.value ?? null) !== (right?.value ?? null),
    };
  });
}

/** The draft input a version carries, for the detail table and diff. */
export function draftOfVersion(
  version: StatutoryTableVersion,
): StatutoryTableDraftInput {
  return {
    type: version.type,
    parameters: version.parameters,
  } as StatutoryTableDraftInput;
}

// ---- THR ------------------------------------------------------------------

export const THR_STATUS_KEYS = {
  scheduled: "payrollConfig.thrStatus.scheduled",
  paid: "payrollConfig.thrStatus.paid",
  cancelled: "payrollConfig.thrStatus.cancelled",
} as const satisfies Record<string, MessageKey>;

/** The schedule's year, from its holiday date (the THR it belongs to). */
export function thrYear(schedule: ThrSchedule): string {
  return schedule.holidayDate.slice(0, 4);
}

export function filterThrSchedules(
  schedules: readonly ThrSchedule[],
  search: string,
): ThrSchedule[] {
  const needle = search.trim().toLocaleLowerCase("id-ID");
  if (needle === "") return [...schedules];
  return schedules.filter((schedule) =>
    `${schedule.name} ${schedule.holidayName} ${schedule.payDate}`
      .toLocaleLowerCase("id-ID")
      .includes(needle),
  );
}
