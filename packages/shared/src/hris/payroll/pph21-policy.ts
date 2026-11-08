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

// ---- Parameters hash --------------------------------------------------------
// A run pins a policy version by ref; the ref also carries a hash of the
// version's parameters so a lock or a frozen recomputation notices parameters
// that no longer match what was approved (rows are append-only, but the ref
// must not trust that). Pure TypeScript (no Node `crypto`) because the shared
// package also runs in the browser.

/** Canonical JSON: object keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined)
      throw new TypeError("canonicalJson: value is not JSON serialisable");
    return text;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of the UTF-8 text as 64 lowercase hex characters. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
  const h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}

/** Stable hash of a version's parameters (canonical JSON, key order free). */
export function pph21ParametersHash(parameters: Pph21PolicyParameters): string {
  return sha256Hex(canonicalJson(parameters));
}
