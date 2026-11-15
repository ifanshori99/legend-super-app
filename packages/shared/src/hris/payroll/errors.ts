// Payroll-domain error codes (docs/plan/contracts.md D-CORE-4: domain
// contracts declare their own UPPER_SNAKE codes). The API error handler maps
// PayrollError the way it maps CoreError. Every code fails closed: a payslip is
// never computed with a guessed or zero rate.

export const payrollErrorHttpStatus = {
  /** No published statutory table of that type covers the date (R20). */
  PAYROLL_STATUTORY_TABLE_NOT_FOUND: 422,
  /** Two published versions of one table start on the same date. */
  PAYROLL_STATUTORY_TABLE_AMBIGUOUS: 409,
  /** A published statutory version is immutable; publish a new version. */
  PAYROLL_STATUTORY_TABLE_IMMUTABLE: 409,
  /** A new version may not start before today (mirrors tax R21). */
  PAYROLL_STATUTORY_TABLE_BACKDATED: 422,
  /** PTKP status or income missing from a TER/PTKP table. */
  PAYROLL_TER_BRACKET_NOT_FOUND: 422,
  /** PTKP status refused by the tenant PPh 21 policy (K/I under `reject`). */
  PAYROLL_PPH21_STATUS_UNSUPPORTED: 422,
  /** A PPh 21 policy version already starts on that date, or is backdated. */
  PAYROLL_PPH21_POLICY_CONFLICT: 409,
  /** Status transition not allowed by the payroll run state machine. */
  PAYROLL_RUN_INVALID_TRANSITION: 409,
  /** Lock requested without both approvals (PAYR-01). */
  PAYROLL_RUN_NOT_APPROVED: 409,
  /** The second approver is the HR approver, or a reversal approver is the
   * requester (PRD §3 Matriks Approval: approver differs from requester). */
  PAYROLL_APPROVER_NOT_DISTINCT: 403,
  /** The run is locked/paid/reversed: inputs and results are frozen (PAYR-02). */
  PAYROLL_RUN_FROZEN: 409,
  /** The run's config snapshot names a table version that is not available. */
  PAYROLL_SNAPSHOT_MISMATCH: 409,
  /** Bank file rows/total differ from the run's bank-transfer net (PAYR-04). */
  PAYROLL_BANK_FILE_MISMATCH: 409,
  /** Kasbon request above the policy limit (PRD §3 D.31). */
  PAYROLL_LOAN_LIMIT_EXCEEDED: 422,
  /** Reimbursement above the category/position limit (PRD §3 D.31). */
  PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED: 422,
  /** Invalid kasbon/reimbursement/service-charge-pool transition. */
  PAYROLL_INVALID_TRANSITION: 409,
  /** Wrong or locked payslip PIN (PRD §3 D.30 Slip Gaji: PIN-protected). */
  PAYSLIP_PIN_INVALID: 403,
  PAYSLIP_PIN_LOCKED: 423,
  /** The employee has not set a payslip PIN yet; set one before opening. */
  PAYSLIP_PIN_NOT_SET: 409,
  /** No verified WhatsApp number linked long enough; only HR can reset. */
  PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE: 409,
  /** The WhatsApp proof is missing, used, expired or not this session's. */
  PAYSLIP_PIN_RESET_PROOF_INVALID: 403,
} as const satisfies Record<string, number>;

export type PayrollErrorCode = keyof typeof payrollErrorHttpStatus;
export const PAYROLL_ERROR_CODES = Object.keys(
  payrollErrorHttpStatus,
) as PayrollErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<PayrollErrorCode, string> = {
  PAYROLL_STATUTORY_TABLE_NOT_FOUND:
    "Tabel tarif yang berlaku untuk tanggal ini belum diterbitkan.",
  PAYROLL_STATUTORY_TABLE_AMBIGUOUS:
    "Lebih dari satu versi tabel tarif berlaku pada tanggal yang sama.",
  PAYROLL_STATUTORY_TABLE_IMMUTABLE:
    "Tabel tarif yang sudah terbit tidak dapat diubah; buat versi baru.",
  PAYROLL_STATUTORY_TABLE_BACKDATED:
    "Tanggal efektif tidak boleh sebelum hari ini.",
  PAYROLL_TER_BRACKET_NOT_FOUND:
    "Kategori atau lapisan TER untuk karyawan ini tidak ditemukan.",
  PAYROLL_PPH21_STATUS_UNSUPPORTED:
    "Status PTKP ini tidak dipakai untuk pemotongan PPh 21 menurut kebijakan pajak perusahaan.",
  PAYROLL_PPH21_POLICY_CONFLICT:
    "Sudah ada versi kebijakan PPh 21 pada tanggal itu, atau tanggalnya sudah lewat.",
  PAYROLL_RUN_INVALID_TRANSITION: "Perubahan status payroll tidak diizinkan.",
  PAYROLL_RUN_NOT_APPROVED:
    "Payroll harus disetujui HR dan Finance/Owner sebelum dikunci.",
  PAYROLL_APPROVER_NOT_DISTINCT:
    "Penyetuju harus berbeda dari penyetuju sebelumnya atau pemohon.",
  PAYROLL_RUN_FROZEN:
    "Payroll yang sudah dikunci tidak dapat dihitung ulang atau diubah.",
  PAYROLL_SNAPSHOT_MISMATCH:
    "Versi tarif yang dipakai payroll ini tidak tersedia.",
  PAYROLL_BANK_FILE_MISMATCH:
    "Total file transfer tidak sama dengan gaji bersih.",
  PAYROLL_LOAN_LIMIT_EXCEEDED: "Jumlah kasbon melebihi batas maksimal.",
  PAYROLL_REIMBURSEMENT_LIMIT_EXCEEDED:
    "Jumlah reimbursement melebihi batas kategori.",
  PAYROLL_INVALID_TRANSITION: "Perubahan status pengajuan tidak diizinkan.",
  PAYSLIP_PIN_INVALID: "PIN slip gaji salah.",
  PAYSLIP_PIN_LOCKED:
    "PIN slip gaji terkunci sementara karena terlalu banyak percobaan.",
  PAYSLIP_PIN_NOT_SET: "PIN slip gaji belum dibuat. Buat PIN terlebih dahulu.",
  PAYSLIP_PIN_RESET_WHATSAPP_UNAVAILABLE:
    "Reset lewat WhatsApp belum tersedia untuk akun ini. Hubungi HR untuk reset PIN.",
  PAYSLIP_PIN_RESET_PROOF_INVALID:
    "Verifikasi WhatsApp tidak berlaku. Mulai ulang reset PIN.",
};

export class PayrollError extends Error {
  readonly code: PayrollErrorCode;
  readonly status: number;
  /** PAYSLIP_PIN_INVALID only: attempts left before the PIN locks. */
  readonly remainingAttempts?: number;
  /** PAYSLIP_PIN_LOCKED only: ISO datetime the lock ends. */
  readonly lockedUntil?: string;
  /** Machine-readable context sent as `{ field, message }` error details. */
  readonly details?: readonly { field: string; message: string }[];

  constructor(
    code: PayrollErrorCode,
    message: string = defaultMessages[code],
    extra: {
      remainingAttempts?: number;
      lockedUntil?: string;
      details?: readonly { field: string; message: string }[];
    } = {},
  ) {
    super(message);
    this.name = "PayrollError";
    this.code = code;
    this.status = payrollErrorHttpStatus[code];
    if (extra.remainingAttempts !== undefined)
      this.remainingAttempts = extra.remainingAttempts;
    if (extra.lockedUntil !== undefined) this.lockedUntil = extra.lockedUntil;
    if (extra.details !== undefined) this.details = extra.details;
  }
}
