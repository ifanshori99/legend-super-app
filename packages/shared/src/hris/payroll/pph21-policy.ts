// Tenant PPh 21 policy (bead legend-y4wp, PRD v1.7 §3 D.30 "PPh 21", R15,
// R20). Where the regulation leaves a choice to the employer, or where the
// team's reading still awaits the tax consultant, the choice is tenant data,
// versioned by effective date like the statutory tables (statutory.ts), never
// code. Founder decision 2026-11-08: ship as config, defaults follow the CTO
// recommendation, the consultant adjusts them later.
//
// Options and defaults:
// - occupationalCostCap: biaya jabatan cap for part of a year. Default
//   `pro_rata_months` = Rp500.000 x months worked (PMK 168/2023 Pasal 10(2)
//   "paling banyak Rp6.000.000 setahun atau Rp500.000 sebulan"); alternative
//   `full_annual` = the annual cap whatever the months.
// - noTaxIdSurcharge: Pasal 21(5a) UU PPh 20% higher rate without NPWP/NIK.
//   Default `ter_and_annual`; alternative `annual_only` (only the last-period
//   annual computation is surcharged).
// - combinedSpouseStatus: K/I/n (penghasilan istri digabung) is an SPT status,
//   not a withholding status; PP 58/2023 has no K/I TER category. Default
//   `normalize` = withhold as K/n in TER months AND in the annual computation
//   (PTKP K/n); alternative `reject` = refuse the computation.
// - mixedSchemeAllocation: how the period tax splits between the employee
//   (gross components) and the employer (gross-up allowance + net borne
//   amount). Default `proportional` = by taxable base; alternative
//   `gross_first` = the employee's gross components bear the tax they would
//   carry alone, the employer covers the rest. Lebih potong refunds always
//   return the employee's own historic withholding (proportional to the
//   year's payer history, or employee first under `gross_first`).
// - roundingMode: rounding of every PPh 21 amount. Default `half_up`
//   (PER-11/PJ/2025 Pasal 129, Coretax periods); a version effective earlier
//   may use `down`. PKP stays rounded down to thousands (Pasal 17(4) UU PPh)
//   and biaya jabatan down to whole rupiah, whatever this mode.

import {
  z,
  tenantIdSchema,
  userIdSchema,
  businessDateSchema,
  isoDateTimeSchema,
  roundingModeSchema,
  clientInputSchema,
  uuidIdSchema,
} from "../../core/index.ts";
import type { BusinessDate } from "../../core/index.ts";

export const pph21PolicyVersionIdSchema =
  uuidIdSchema<"Pph21PolicyVersionId">();
export type Pph21PolicyVersionId = z.infer<typeof pph21PolicyVersionIdSchema>;

export const OCCUPATIONAL_COST_CAP_RULES = [
  "pro_rata_months",
  "full_annual",
] as const;
export const NO_TAX_ID_SURCHARGE_RULES = [
  "ter_and_annual",
  "annual_only",
] as const;
export const COMBINED_SPOUSE_STATUS_RULES = ["normalize", "reject"] as const;
export const MIXED_SCHEME_ALLOCATIONS = [
  "proportional",
  "gross_first",
] as const;

export const pph21PolicyParametersSchema = z.strictObject({
  occupationalCostCap: z.enum(OCCUPATIONAL_COST_CAP_RULES),
  noTaxIdSurcharge: z.enum(NO_TAX_ID_SURCHARGE_RULES),
  combinedSpouseStatus: z.enum(COMBINED_SPOUSE_STATUS_RULES),
  mixedSchemeAllocation: z.enum(MIXED_SCHEME_ALLOCATIONS),
  roundingMode: roundingModeSchema,
});
export type Pph21PolicyParameters = z.infer<typeof pph21PolicyParametersSchema>;

/** Used when a tenant has no published policy version for the date. */
export const DEFAULT_PPH21_POLICY: Pph21PolicyParameters = Object.freeze({
  occupationalCostCap: "pro_rata_months",
  noTaxIdSurcharge: "ter_and_annual",
  combinedSpouseStatus: "normalize",
  mixedSchemeAllocation: "proportional",
  roundingMode: "half_up",
});

/** One row of `payroll_pph21_policies`: immutable once written. */
export const pph21PolicyVersionSchema = z.strictObject({
  id: pph21PolicyVersionIdSchema,
  tenantId: tenantIdSchema,
  /** 1, 2, 3 ... per tenant. */
  version: z.number().int().min(1),
  effectiveFrom: businessDateSchema,
  parameters: pph21PolicyParametersSchema,
  /** Why it changed (consultant advice, regulation); shown in the audit. */
  reason: z.string().trim().min(3).max(500),
  createdBy: userIdSchema,
  createdAt: isoDateTimeSchema,
});
export type Pph21PolicyVersion = z.infer<typeof pph21PolicyVersionSchema>;

export const createPph21PolicyVersionInputSchema = clientInputSchema({
  effectiveFrom: businessDateSchema,
  parameters: pph21PolicyParametersSchema,
  reason: z.string().trim().min(3).max(500),
});
export type CreatePph21PolicyVersionInput = z.infer<
  typeof createPph21PolicyVersionInputSchema
>;

/** Policy in force on a date, with the version it came from (`GET .../in-force`). */
export const pph21PolicyInForceSchema = z.strictObject({
  parameters: pph21PolicyParametersSchema,
  /** `default` = the tenant has no version effective on the date. */
  source: z.enum(["default", "version"]),
  version: z.number().int().min(1).nullable(),
  effectiveFrom: businessDateSchema.nullable(),
  /** Row id of the version; null for the default. A run pins this id. */
  versionId: pph21PolicyVersionIdSchema.nullable(),
});
export type Pph21PolicyInForce = z.infer<typeof pph21PolicyInForceSchema>;

/**
 * Policy in force on a date: the version with the latest effectiveFrom on or
 * before it, else the default. Two versions on one date cannot exist (unique
 * per tenant in the table); the later version number wins defensively.
 */
export function resolvePph21Policy(
  versions: readonly Pick<
    Pph21PolicyVersion,
    "version" | "effectiveFrom" | "parameters"
  >[],
  date: BusinessDate,
): Pph21PolicyParameters {
  let best: (typeof versions)[number] | undefined;
  for (const candidate of versions) {
    if (candidate.effectiveFrom > date) continue;
    if (
      !best ||
      candidate.effectiveFrom > best.effectiveFrom ||
      (candidate.effectiveFrom === best.effectiveFrom &&
        candidate.version > best.version)
    )
      best = candidate;
  }
  return best ? best.parameters : DEFAULT_PPH21_POLICY;
}
