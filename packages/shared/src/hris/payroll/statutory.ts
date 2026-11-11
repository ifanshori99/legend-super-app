// Versioned statutory tables (PRD v1.7 §3 D.30 "BPJS", "PPh 21", "THR";
// §6 H `statutory_rates`; R20 "Seluruh tarif dikonfigurasi berversi dengan
// tanggal efektif ... diaktifkan dari panel tanpa redeploy"; PAYR-02).
//
// These tables are DATA, never code: this file contains no current rate,
// cap, PTKP amount or TER bracket. Real numbers are entered by Finance from
// the regulation in force (PP 58/2023 for TER, BPJS regulations, ...) and the
// fixtures only carry illustrative values. Every computation takes a table
// version and fails closed when none covers the date.
//
// Versioning mirrors the tax engine (bead legend-559, `tax/lifecycle.ts`):
//   draft -> published (immutable from then on; effectiveFrom >= today)
//   draft -> archived  (discarded draft)
// One row of `statutory_rates` = one version of one table type. The version in
// force on a date is the published version with the latest effectiveFrom on or
// before it. A payroll run pins the versions it used in its config snapshot,
// so a newer version never changes a locked run (PAYR-02, see run.ts).
//
// Rates are basis points (10,000 bp = 100%), like the tax rules: every rate in
// the BPJS and TER regulations is a whole number of bp. Multipliers (overtime)
// are Decimal4. Every amount that is paid or withheld is whole rupiah, rounded
// with the table's explicit RoundingMode (D-CORE-2).

import {
  z,
  tenantIdSchema,
  userIdSchema,
  idrSchema,
  basisPointsSchema,
  businessDateSchema,
  isoDateTimeSchema,
  roundingModeSchema,
  decimal4Schema,
  divideRounded,
  parseDecimal4,
  idr,
} from "../../core/index.ts";
import type {
  BasisPoints,
  BusinessDate,
  Decimal4,
  Idr,
  IsoDateTime,
  RoundingMode,
  UserId,
} from "../../core/index.ts";
import { ptkpStatusSchema } from "../organization.ts";
import type { PtkpStatus } from "../organization.ts";
import { PayrollError } from "./errors.ts";
import { statutoryTableVersionIdSchema } from "./ids.ts";

// ---- Table types and lifecycle --------------------------------------------

/**
 * PRD §6 H `statutory_rates.type` lists bpjs_kes / jht / jkk / jkm / jp /
 * pph21_ter / ptkp. Added (PRD silent, needed by §3 D.30 and PAYR-02):
 * `pph21_annual` (Pasal 17 brackets + biaya jabatan for the recalculation in
 * the last tax period), `overtime` ("rumus lembur" is versioned per PAYR-02)
 * and `thr` (tenure rule for THR by masa kerja).
 */
export const STATUTORY_TABLE_TYPES = [
  "bpjs_kes",
  "jht",
  "jkk",
  "jkm",
  "jp",
  "ptkp",
  "pph21_ter",
  "pph21_annual",
  "overtime",
  "thr",
] as const;
export const statutoryTableTypeSchema = z.enum(STATUTORY_TABLE_TYPES);
export type StatutoryTableType = z.infer<typeof statutoryTableTypeSchema>;

export const BPJS_TABLE_TYPES = [
  "bpjs_kes",
  "jht",
  "jkk",
  "jkm",
  "jp",
] as const satisfies readonly StatutoryTableType[];
export type BpjsTableType = (typeof BPJS_TABLE_TYPES)[number];

export const STATUTORY_VERSION_STATUSES = [
  "draft",
  "published",
  "archived",
] as const;
export const statutoryVersionStatusSchema = z.enum(STATUTORY_VERSION_STATUSES);
export type StatutoryVersionStatus = z.infer<
  typeof statutoryVersionStatusSchema
>;

// ---- Parameter schemas ------------------------------------------------------

const positiveIdr = idrSchema.refine((v) => v > 0, "Must be positive");
const nonNegativeIdr = idrSchema.refine((v) => v >= 0, "Must not be negative");

/** One BPJS programme: employer and employee share, wage cap and floor. */
const bpjsRateFields = {
  employeeRateBp: basisPointsSchema,
  /** Upper wage limit for the contribution base; null = no cap. */
  wageCapIdr: positiveIdr.nullable(),
  /** Lower limit (e.g. a regional minimum wage); null = none. */
  wageFloorIdr: positiveIdr.nullable(),
  roundingMode: roundingModeSchema,
};

function checkFloorBelowCap(
  value: { wageCapIdr: Idr | null; wageFloorIdr: Idr | null },
  ctx: z.RefinementCtx,
) {
  if (
    value.wageCapIdr !== null &&
    value.wageFloorIdr !== null &&
    value.wageFloorIdr > value.wageCapIdr
  )
    ctx.addIssue({
      code: "custom",
      path: ["wageFloorIdr"],
      message: "Wage floor cannot exceed the wage cap",
    });
}

export const bpjsParametersSchema = z
  .strictObject({ employerRateBp: basisPointsSchema, ...bpjsRateFields })
  .superRefine(checkFloorBelowCap);
export type BpjsParameters = z.infer<typeof bpjsParametersSchema>;

/** JKK employer rate depends on the work-risk group of the legal entity. */
export const JKK_RISK_CLASSES = [
  "very_low",
  "low",
  "medium",
  "high",
  "very_high",
] as const;
export const jkkRiskClassSchema = z.enum(JKK_RISK_CLASSES);
export type JkkRiskClass = z.infer<typeof jkkRiskClassSchema>;

export const jkkParametersSchema = z
  .strictObject({
    employerRateBpByRiskClass: z.strictObject(
      Object.fromEntries(
        JKK_RISK_CLASSES.map((riskClass) => [riskClass, basisPointsSchema]),
      ) as Record<JkkRiskClass, typeof basisPointsSchema>,
    ),
    ...bpjsRateFields,
  })
  .superRefine(checkFloorBelowCap);
export type JkkParameters = z.infer<typeof jkkParametersSchema>;

const byPtkpStatus = <T extends z.ZodType>(value: T) =>
  z.strictObject(
    Object.fromEntries(
      ptkpStatusSchema.options.map((status) => [status, value]),
    ) as Record<PtkpStatus, T>,
  );

/** Annual PTKP amount per status (every status must be present). */
export const ptkpParametersSchema = z.strictObject({
  annualAmountIdrByStatus: byPtkpStatus(positiveIdr),
});
export type PtkpParameters = z.infer<typeof ptkpParametersSchema>;

/** TER categories of PP 58/2023 (Tarif Efektif Rata-rata bulanan). */
export const TER_CATEGORIES = ["A", "B", "C"] as const;
export const terCategorySchema = z.enum(TER_CATEGORIES);
export type TerCategory = z.infer<typeof terCategorySchema>;

/**
 * One income bracket: applies when income <= upToIdr (inclusive upper bound,
 * as the regulation's "s.d." columns); null = the open-ended top bracket.
 */
export const rateBracketSchema = z.strictObject({
  upToIdr: positiveIdr.nullable(),
  rateBp: basisPointsSchema,
});
export type RateBracket = z.infer<typeof rateBracketSchema>;

/** Brackets ascending, strictly increasing bounds, exactly one open top. */
export const rateBracketsSchema = z
  .array(rateBracketSchema)
  .min(1)
  .max(100)
  .superRefine((brackets, ctx) => {
    brackets.forEach((bracket, index) => {
      const last = index === brackets.length - 1;
      if (last !== (bracket.upToIdr === null))
        ctx.addIssue({
          code: "custom",
          path: [index, "upToIdr"],
          message: "Only the last bracket is open-ended (upToIdr null)",
        });
      const previous = brackets[index - 1]?.upToIdr;
      if (
        index > 0 &&
        bracket.upToIdr !== null &&
        previous != null &&
        bracket.upToIdr <= previous
      )
        ctx.addIssue({
          code: "custom",
          path: [index, "upToIdr"],
          message: "Bracket bounds must strictly increase",
        });
    });
  });

export const terParametersSchema = z.strictObject({
  /** PTKP status -> TER category (part of the regulation, so data). */
  categoryByPtkpStatus: byPtkpStatus(terCategorySchema),
  /** Monthly gross income brackets per category. */
  bracketsByCategory: z.strictObject({
    A: rateBracketsSchema,
    B: rateBracketsSchema,
    C: rateBracketsSchema,
  }),
  roundingMode: roundingModeSchema,
});
export type TerParameters = z.infer<typeof terParametersSchema>;

/** Annual recalculation in the last tax period (PRD §3 D.30 PPh 21). */
export const pph21AnnualParametersSchema = z.strictObject({
  /** Pasal 17 progressive brackets on annual taxable income (PKP). */
  brackets: rateBracketsSchema,
  /**
   * Biaya jabatan: rate of annual gross with an annual cap. Always rounded
   * DOWN to whole rupiah (fixed, not `roundingMode`): `roundingMode` applies to
   * the tax amounts, and a rounded-down deduction never under-withholds.
   */
  occupationalCostRateBp: basisPointsSchema,
  occupationalCostAnnualCapIdr: nonNegativeIdr,
  /** PKP is rounded down to this multiple before the brackets (e.g. 1,000). */
  taxableIncomeRoundDownToIdr: positiveIdr,
  /** Extra percentage of tax for employees without a tax id; null = none. */
  noTaxIdSurchargeBp: basisPointsSchema.nullable(),
  roundingMode: roundingModeSchema,
});
export type Pph21AnnualParameters = z.infer<typeof pph21AnnualParametersSchema>;

/** Overtime day kinds; rest days and public holidays share the multipliers. */
export const OVERTIME_DAY_TYPES = [
  "workday",
  "rest_day_6_day_week",
  "rest_day_5_day_week",
] as const;
export const overtimeDayTypeSchema = z.enum(OVERTIME_DAY_TYPES);
export type OvertimeDayType = z.infer<typeof overtimeDayTypeSchema>;

/** Hours [fromHour, toHour) of one day's overtime pay at `multiplier`. */
export const overtimeTierSchema = z.strictObject({
  fromHour: z.number().int().min(0).max(24),
  toHour: z.number().int().min(1).max(24).nullable(),
  multiplier: decimal4Schema,
});
export type OvertimeTier = z.infer<typeof overtimeTierSchema>;

const overtimeTiersSchema = z
  .array(overtimeTierSchema)
  .min(1)
  .max(12)
  .superRefine((tiers, ctx) => {
    tiers.forEach((tier, index) => {
      const expectedFrom = index === 0 ? 0 : tiers[index - 1]?.toHour;
      if (tier.fromHour !== expectedFrom)
        ctx.addIssue({
          code: "custom",
          path: [index, "fromHour"],
          message: "Tiers start at hour 0 and are contiguous",
        });
      const last = index === tiers.length - 1;
      if (last !== (tier.toHour === null))
        ctx.addIssue({
          code: "custom",
          path: [index, "toHour"],
          message: "Only the last tier is open-ended (toHour null)",
        });
      if (tier.toHour !== null && tier.toHour <= tier.fromHour)
        ctx.addIssue({
          code: "custom",
          path: [index, "toHour"],
          message: "toHour must be after fromHour",
        });
      if (parseDecimal4(tier.multiplier) <= 0n)
        ctx.addIssue({
          code: "custom",
          path: [index, "multiplier"],
          message: "Multiplier must be positive",
        });
    });
  });

export const overtimeParametersSchema = z.strictObject({
  /** Hourly wage = monthly overtime base / divisor (e.g. 173). */
  monthlyHoursDivisor: z.number().int().min(1).max(400),
  tiersByDayType: z.strictObject({
    workday: overtimeTiersSchema,
    rest_day_6_day_week: overtimeTiersSchema,
    rest_day_5_day_week: overtimeTiersSchema,
  }),
  roundingMode: roundingModeSchema,
});
export type OvertimeParameters = z.infer<typeof overtimeParametersSchema>;

/** THR by tenure: none below min months, pro rata, full from full months. */
export const thrParametersSchema = z
  .strictObject({
    minTenureMonths: z.number().int().min(0).max(120),
    fullTenureMonths: z.number().int().min(1).max(120),
    roundingMode: roundingModeSchema,
  })
  .refine((v) => v.minTenureMonths <= v.fullTenureMonths, {
    path: ["minTenureMonths"],
    message: "Minimum tenure cannot exceed full tenure",
  });
export type ThrParameters = z.infer<typeof thrParametersSchema>;

// ---- Version rows -------------------------------------------------------

const versionMeta = {
  id: statutoryTableVersionIdSchema,
  tenantId: tenantIdSchema,
  version: z.number().int().positive().safe(),
  effectiveFrom: businessDateSchema,
  status: statutoryVersionStatusSchema,
  /** Regulation the numbers come from, e.g. "PP 58/2023 Lampiran". */
  legalBasis: z.string().trim().min(1).max(200),
  publishedAt: isoDateTimeSchema.nullable(),
  publishedBy: userIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
};

const versionOf = <T extends StatutoryTableType, P extends z.ZodType>(
  type: T,
  parameters: P,
) => z.strictObject({ ...versionMeta, type: z.literal(type), parameters });

export const statutoryTableVersionSchema = z
  .discriminatedUnion("type", [
    versionOf("bpjs_kes", bpjsParametersSchema),
    versionOf("jht", bpjsParametersSchema),
    versionOf("jkk", jkkParametersSchema),
    versionOf("jkm", bpjsParametersSchema),
    versionOf("jp", bpjsParametersSchema),
    versionOf("ptkp", ptkpParametersSchema),
    versionOf("pph21_ter", terParametersSchema),
    versionOf("pph21_annual", pph21AnnualParametersSchema),
    versionOf("overtime", overtimeParametersSchema),
    versionOf("thr", thrParametersSchema),
  ])
  .superRefine((value, ctx) => {
    const published = value.status === "published";
    if (
      (value.publishedAt !== null) !== published ||
      (value.publishedBy !== null) !== published
    )
      ctx.addIssue({
        code: "custom",
        path: ["publishedAt"],
        message:
          "publishedAt/publishedBy are set exactly when status is published",
      });
  });
export type StatutoryTableVersion = z.infer<typeof statutoryTableVersionSchema>;
export type StatutoryTableVersionOf<T extends StatutoryTableType> = Extract<
  StatutoryTableVersion,
  { type: T }
>;

/** Draft input: type + parameters; the server assigns id/version/status. */
export const statutoryTableDraftInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("bpjs_kes"),
    parameters: bpjsParametersSchema,
  }),
  z.strictObject({ type: z.literal("jht"), parameters: bpjsParametersSchema }),
  z.strictObject({ type: z.literal("jkk"), parameters: jkkParametersSchema }),
  z.strictObject({ type: z.literal("jkm"), parameters: bpjsParametersSchema }),
  z.strictObject({ type: z.literal("jp"), parameters: bpjsParametersSchema }),
  z.strictObject({ type: z.literal("ptkp"), parameters: ptkpParametersSchema }),
  z.strictObject({
    type: z.literal("pph21_ter"),
    parameters: terParametersSchema,
  }),
  z.strictObject({
    type: z.literal("pph21_annual"),
    parameters: pph21AnnualParametersSchema,
  }),
  z.strictObject({
    type: z.literal("overtime"),
    parameters: overtimeParametersSchema,
  }),
  z.strictObject({ type: z.literal("thr"), parameters: thrParametersSchema }),
]);
export type StatutoryTableDraftInput = z.infer<
  typeof statutoryTableDraftInputSchema
>;

// ---- Lifecycle ----------------------------------------------------------

const transitions: Record<
  StatutoryVersionStatus,
  readonly StatutoryVersionStatus[]
> = {
  draft: ["published", "archived"],
  published: [],
  archived: [],
};

export function canTransitionStatutoryVersion(
  from: StatutoryVersionStatus,
  to: StatutoryVersionStatus,
): boolean {
  return transitions[from].includes(to);
}

/** Only drafts can be edited (PAYR-02: published numbers never change). */
export function assertStatutoryVersionEditable(
  status: StatutoryVersionStatus,
): void {
  if (status !== "draft")
    throw new PayrollError("PAYROLL_STATUTORY_TABLE_IMMUTABLE");
}

type VersionLike = {
  status: StatutoryVersionStatus;
  effectiveFrom: BusinessDate;
  publishedAt: IsoDateTime | null;
  publishedBy: UserId | null;
};

/** The sibling shape publish needs to spot a same-date published version. */
type PublishedSiblingLike = {
  id: string;
  type: string;
  status: StatutoryVersionStatus;
  effectiveFrom: BusinessDate;
};

/**
 * Publishes a draft. `today` is the business date the server computed
 * (businessDateOf), never the client's clock. A backdated version is refused:
 * a regulation change that applies retroactively is settled by a correction
 * in an open payroll run, never by rewriting a locked one (PAYR-02).
 *
 * `existing` are the other versions of the tenant. A published sibling of the
 * same type with the same effectiveFrom makes the resolver ambiguous, so the
 * second one is refused with PAYROLL_STATUTORY_TABLE_AMBIGUOUS (PAYR-02).
 */
export function publishStatutoryVersion<
  T extends VersionLike & { id: string; type: string },
>(
  version: T,
  options: {
    today: BusinessDate;
    actorId: UserId;
    at: IsoDateTime;
    existing?: readonly PublishedSiblingLike[];
  },
): T {
  if (!canTransitionStatutoryVersion(version.status, "published"))
    throw new PayrollError(
      version.status === "published"
        ? "PAYROLL_STATUTORY_TABLE_IMMUTABLE"
        : "PAYROLL_INVALID_TRANSITION",
    );
  if (version.effectiveFrom < options.today)
    throw new PayrollError("PAYROLL_STATUTORY_TABLE_BACKDATED");
  if (
    options.existing?.some(
      (other) =>
        other.id !== version.id &&
        other.type === version.type &&
        other.status === "published" &&
        other.effectiveFrom === version.effectiveFrom,
    )
  )
    throw new PayrollError("PAYROLL_STATUTORY_TABLE_AMBIGUOUS");
  return {
    ...version,
    status: "published",
    publishedAt: options.at,
    publishedBy: options.actorId,
  };
}

export function archiveStatutoryVersion<T extends VersionLike>(version: T): T {
  if (!canTransitionStatutoryVersion(version.status, "archived"))
    throw new PayrollError(
      version.status === "published"
        ? "PAYROLL_STATUTORY_TABLE_IMMUTABLE"
        : "PAYROLL_INVALID_TRANSITION",
    );
  return { ...version, status: "archived" };
}

/**
 * The published version of `type` in force on `onDate`: latest effectiveFrom
 * on or before the date. Drafts and archived rows never apply. None ->
 * PAYROLL_STATUTORY_TABLE_NOT_FOUND (fail closed, never a zero rate).
 */
export function resolveStatutoryTable<T extends StatutoryTableType>(
  versions: readonly StatutoryTableVersion[],
  type: T,
  onDate: BusinessDate,
): StatutoryTableVersionOf<T> {
  const candidates = versions.filter(
    (version): version is StatutoryTableVersionOf<T> =>
      version.type === type &&
      version.status === "published" &&
      version.effectiveFrom <= onDate,
  );
  if (candidates.length === 0)
    throw new PayrollError("PAYROLL_STATUTORY_TABLE_NOT_FOUND");
  const latest = candidates.reduce((best, version) =>
    version.effectiveFrom > best.effectiveFrom ? version : best,
  );
  if (
    candidates.filter((v) => v.effectiveFrom === latest.effectiveFrom).length >
    1
  )
    throw new PayrollError("PAYROLL_STATUTORY_TABLE_AMBIGUOUS");
  return latest;
}

// ---- Computations (pure, whole rupiah) --------------------------------

/** amount x bp / 10,000 rounded to whole rupiah with an explicit mode. */
export function rupiahAtRate(
  amountIdr: Idr,
  rateBp: BasisPoints,
  mode: RoundingMode,
): Idr {
  return idr(
    Number(divideRounded(BigInt(amountIdr) * BigInt(rateBp), 10_000n, mode)),
  );
}

/** Uniform view of one BPJS programme after the JKK risk class is applied. */
export type BpjsRate = {
  type: BpjsTableType;
  employerRateBp: BasisPoints;
  employeeRateBp: BasisPoints;
  wageCapIdr: Idr | null;
  wageFloorIdr: Idr | null;
  roundingMode: RoundingMode;
};

export function bpjsRateOf(
  version: StatutoryTableVersionOf<BpjsTableType>,
  jkkRiskClass: JkkRiskClass | null,
): BpjsRate {
  if (version.type === "jkk") {
    if (jkkRiskClass === null)
      throw new PayrollError("PAYROLL_STATUTORY_TABLE_NOT_FOUND");
    const { employerRateBpByRiskClass, ...rest } = version.parameters;
    return {
      type: "jkk",
      ...rest,
      employerRateBp: employerRateBpByRiskClass[jkkRiskClass],
    };
  }
  return { type: version.type, ...version.parameters };
}

export type BpjsContribution = {
  type: BpjsTableType;
  /** Wage base after floor and cap. */
  baseIdr: Idr;
  /** True when the cap reduced the base. */
  capped: boolean;
  employerIdr: Idr;
  employeeIdr: Idr;
};

/**
 * BPJS contribution for one programme (PRD §3 D.30 BPJS "batas upah, porsi
 * perusahaan maupun karyawan"). The base is the BPJS-base wage clamped to
 * [floor, cap]; each share is rounded separately to whole rupiah.
 */
export function computeBpjsContribution(
  rate: BpjsRate,
  wageBaseIdr: Idr,
): BpjsContribution {
  if (wageBaseIdr < 0) throw new RangeError("Wage base cannot be negative");
  let base = wageBaseIdr;
  if (base === 0)
    return {
      type: rate.type,
      baseIdr: idr(0),
      capped: false,
      employerIdr: idr(0),
      employeeIdr: idr(0),
    };
  if (rate.wageFloorIdr !== null && base < rate.wageFloorIdr)
    base = rate.wageFloorIdr;
  const capped = rate.wageCapIdr !== null && base > rate.wageCapIdr;
  if (capped && rate.wageCapIdr !== null) base = rate.wageCapIdr;
  return {
    type: rate.type,
    baseIdr: base,
    capped,
    employerIdr: rupiahAtRate(base, rate.employerRateBp, rate.roundingMode),
    employeeIdr: rupiahAtRate(base, rate.employeeRateBp, rate.roundingMode),
  };
}

export function ptkpAnnualAmount(
  version: StatutoryTableVersionOf<"ptkp">,
  status: PtkpStatus,
): Idr {
  const amount = version.parameters.annualAmountIdrByStatus[status];
  if (amount === undefined)
    throw new PayrollError("PAYROLL_TER_BRACKET_NOT_FOUND");
  return amount;
}

function bracketIndexFor(brackets: readonly RateBracket[], amount: Idr) {
  const index = brackets.findIndex(
    (bracket) => bracket.upToIdr === null || amount <= bracket.upToIdr,
  );
  if (index < 0) throw new PayrollError("PAYROLL_TER_BRACKET_NOT_FOUND");
  return index;
}

export type TerLookup = {
  category: TerCategory;
  bracketIndex: number;
  rateBp: BasisPoints;
};

/** TER rate by PTKP status category and monthly gross bracket (PP 58/2023). */
export function lookupTerRate(
  version: StatutoryTableVersionOf<"pph21_ter">,
  status: PtkpStatus,
  monthlyGrossIdr: Idr,
): TerLookup {
  if (monthlyGrossIdr < 0) throw new RangeError("Gross cannot be negative");
  const category = version.parameters.categoryByPtkpStatus[status];
  if (category === undefined)
    throw new PayrollError("PAYROLL_TER_BRACKET_NOT_FOUND");
  const brackets = version.parameters.bracketsByCategory[category];
  const bracketIndex = bracketIndexFor(brackets, monthlyGrossIdr);
  const bracket = brackets[bracketIndex];
  if (!bracket) throw new PayrollError("PAYROLL_TER_BRACKET_NOT_FOUND");
  return { category, bracketIndex, rateBp: bracket.rateBp };
}

/** Monthly PPh 21 withholding with TER = gross x TER rate, whole rupiah. */
export function computeTerWithholding(
  version: StatutoryTableVersionOf<"pph21_ter">,
  status: PtkpStatus,
  monthlyGrossIdr: Idr,
): Idr {
  const { rateBp } = lookupTerRate(version, status, monthlyGrossIdr);
  return rupiahAtRate(monthlyGrossIdr, rateBp, version.parameters.roundingMode);
}

/**
 * Pasal 17 progressive tax on annual taxable income (PKP), for the last tax
 * period recalculation. Each slice is taxed at its bracket rate; the sum is
 * rounded once.
 */
export function computeProgressiveTax(
  brackets: readonly RateBracket[],
  taxableIncomeIdr: Idr,
  mode: RoundingMode,
): Idr {
  if (taxableIncomeIdr <= 0) return idr(0);
  let lower = 0n;
  let scaled = 0n;
  const income = BigInt(taxableIncomeIdr);
  for (const bracket of brackets) {
    const upper = bracket.upToIdr === null ? income : BigInt(bracket.upToIdr);
    const top = upper < income ? upper : income;
    if (top > lower) scaled += (top - lower) * BigInt(bracket.rateBp);
    if (bracket.upToIdr === null || upper >= income) break;
    lower = upper;
  }
  return idr(Number(divideRounded(scaled, 10_000n, mode)));
}

/**
 * Overtime pay for one day (PRD §3 D.29 Lembur "rumus yang dikonfigurasi"):
 * hourly wage = monthly base / divisor; each tier's hours are paid at its
 * multiplier. Computed in scaled integers, rounded once to whole rupiah.
 */
export function computeOvertimePay(
  params: OvertimeParameters,
  dayType: OvertimeDayType,
  hours: Decimal4,
  monthlyBaseIdr: Idr,
): Idr {
  const scaledHours = parseDecimal4(hours);
  if (scaledHours < 0n) throw new RangeError("Hours cannot be negative");
  if (monthlyBaseIdr < 0) throw new RangeError("Base cannot be negative");
  let weighted = 0n; // hours x multiplier, scaled by 10^8
  for (const tier of params.tiersByDayType[dayType]) {
    const from = BigInt(tier.fromHour) * 10_000n;
    const to =
      tier.toHour === null ? scaledHours : BigInt(tier.toHour) * 10_000n;
    const top = to < scaledHours ? to : scaledHours;
    if (top > from) weighted += (top - from) * parseDecimal4(tier.multiplier);
    if (scaledHours <= to) break;
  }
  return idr(
    Number(
      divideRounded(
        BigInt(monthlyBaseIdr) * weighted,
        BigInt(params.monthlyHoursDivisor) * 100_000_000n,
        params.roundingMode,
      ),
    ),
  );
}

/** Completed whole months between two business dates (masa kerja). */
export function completedMonthsBetween(
  from: BusinessDate,
  to: BusinessDate,
): number {
  if (to < from) return 0;
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  const months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  return Math.max(0, months);
}

export type ThrResult = { tenureMonths: number; amountIdr: Idr };

/**
 * THR keagamaan by masa kerja (PRD §3 D.30 THR): below `minTenureMonths`
 * nothing, from `fullTenureMonths` one month of THR wage, in between pro rata
 * months / fullTenureMonths. Tenure is counted up to `asOfDate` (the schedule's
 * reference date, e.g. the holiday).
 */
export function computeThr(
  params: ThrParameters,
  input: { joinDate: BusinessDate; asOfDate: BusinessDate; thrWageIdr: Idr },
): ThrResult {
  if (input.thrWageIdr < 0) throw new RangeError("Wage cannot be negative");
  const tenureMonths = completedMonthsBetween(input.joinDate, input.asOfDate);
  if (tenureMonths < params.minTenureMonths || tenureMonths === 0)
    return { tenureMonths, amountIdr: idr(0) };
  if (tenureMonths >= params.fullTenureMonths)
    return { tenureMonths, amountIdr: input.thrWageIdr };
  return {
    tenureMonths,
    amountIdr: idr(
      Number(
        divideRounded(
          BigInt(input.thrWageIdr) * BigInt(tenureMonths),
          BigInt(params.fullTenureMonths),
          params.roundingMode,
        ),
      ),
    ),
  };
}
