// Tax-domain error codes (docs/plan/contracts.md D-CORE-4: domain contracts
// declare their own UPPER_SNAKE codes). The API error handler maps TaxError the
// same way it maps CoreError. Every code fails closed: a bill is never priced
// with a guessed or zero tax.

export const taxErrorHttpStatus = {
  /** No published tax rule matches a line (date, outlet, channel, item). Exempt
   * items need an explicit 0 bp rule, so a missing rule is a config error. */
  TAX_RULE_NOT_FOUND: 422,
  /** Two rules match a line with the same specificity: config must be fixed. */
  TAX_RULE_AMBIGUOUS: 409,
  /** A published rule version is immutable; publish a new version instead. */
  TAX_RULE_IMMUTABLE: 409,
  /** A new version may not start before today (PRD R21: past transactions are
   * corrected with an adjustment journal, never by rewriting the rule). */
  TAX_RULE_BACKDATED: 422,
  /** No published calculation settings for the outlet on that date. */
  TAX_SETTINGS_NOT_FOUND: 422,
  /** Package components do not allocate the package price exactly. */
  TAX_PACKAGE_ALLOCATION_INVALID: 422,
  /** Invalid status transition for a rule version. */
  TAX_INVALID_TRANSITION: 409,
} as const satisfies Record<string, number>;

export type TaxErrorCode = keyof typeof taxErrorHttpStatus;
export const TAX_ERROR_CODES = Object.keys(
  taxErrorHttpStatus,
) as TaxErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<TaxErrorCode, string> = {
  TAX_RULE_NOT_FOUND: "Aturan pajak untuk item ini belum diatur.",
  TAX_RULE_AMBIGUOUS: "Lebih dari satu aturan pajak berlaku untuk item ini.",
  TAX_RULE_IMMUTABLE:
    "Aturan pajak yang sudah terbit tidak dapat diubah; buat versi baru.",
  TAX_RULE_BACKDATED: "Tanggal efektif tidak boleh sebelum hari ini.",
  TAX_SETTINGS_NOT_FOUND: "Opsi perhitungan pajak outlet belum diatur.",
  TAX_PACKAGE_ALLOCATION_INVALID: "Alokasi harga paket tidak valid.",
  TAX_INVALID_TRANSITION: "Perubahan status aturan pajak tidak diizinkan.",
};

export class TaxError extends Error {
  readonly code: TaxErrorCode;
  readonly status: number;

  constructor(code: TaxErrorCode, message: string = defaultMessages[code]) {
    super(message);
    this.name = "TaxError";
    this.code = code;
    this.status = taxErrorHttpStatus[code];
  }
}
