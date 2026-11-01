// Accounting error codes (docs/plan/contracts.md D-CORE-4: domain contracts
// declare their own UPPER_SNAKE codes next to their schemas). The API error
// handler maps AccountingError the same way it maps CoreError. "Approver is
// the requester" is the access contract's APPROVER_IS_REQUESTER (AUTH-06), so
// one code means one thing across modules.

export const accountingErrorHttpStatus = {
  /** Posting into a closed fiscal period (ACC-02). */
  PERIOD_CLOSED: 409,
  /** The period changed (closed or reopened) after the poster read it; re-read and retry. */
  PERIOD_CHANGED: 409,
  /** Entry date is not inside the fiscal period it names. */
  PERIOD_MISMATCH: 422,
  /** A month can be closed only after it has ended. */
  PERIOD_NOT_ENDED: 422,
  /** An earlier period of the same legal entity is still open. */
  PERIOD_CLOSE_OUT_OF_ORDER: 409,
  /** A later period of the same legal entity is closed; reopen that one first. */
  PERIOD_REOPEN_OUT_OF_ORDER: 409,
  PERIOD_ALREADY_CLOSED: 409,
  PERIOD_ALREADY_OPEN: 409,
  /** The action needs a closed period (e.g. finalising a tax report). */
  PERIOD_NOT_CLOSED: 409,
  /** Reopening a closed period needs a written reason (§3.19 Tutup Periode). */
  REOPEN_REASON_REQUIRED: 422,
  /** Debit and credit totals differ, or fewer than two lines (ACC-01). */
  JOURNAL_UNBALANCED: 422,
  /** A line has both or neither side, or a negative amount. */
  JOURNAL_LINE_INVALID: 422,
  /** Posted journals are final: never edited or deleted, only reversed (ACC-01). */
  JOURNAL_IMMUTABLE: 409,
  JOURNAL_ALREADY_REVERSED: 409,
  /** A reversal entry cannot itself be reversed; post a new entry instead. */
  JOURNAL_NOT_REVERSIBLE: 409,
  /** Status change not allowed from the current status. */
  INVALID_TRANSITION: 409,
  ACCOUNT_INACTIVE: 422,
  /** Header accounts (with children) carry no postings. */
  ACCOUNT_NOT_POSTABLE: 422,
  /** Account belongs to another legal entity than the entry. */
  ACCOUNT_ENTITY_MISMATCH: 422,
  ACCOUNT_CODE_TAKEN: 409,
  /** No posting rule for this event/variant: nothing is booked silently (fail closed). */
  POSTING_RULE_MISSING: 422,
  /** A posting role has no account mapped for the legal entity (fail closed). */
  ACCOUNT_MAPPING_MISSING: 422,
  /** The source sent an amount the rule does not book, or omitted one it needs. */
  POSTING_AMOUNTS_MISMATCH: 422,
  STATEMENT_LINE_ALREADY_MATCHED: 409,
  /** Matched documents do not add up to the statement line amount. */
  MATCH_AMOUNT_MISMATCH: 422,
  /** Bank CSV value cannot be read without guessing (e.g. fractional rupiah). */
  STATEMENT_VALUE_INVALID: 422,
  /** Tax type does not apply to this legal entity (PPN needs PKP status). */
  TAX_REPORT_NOT_APPLICABLE: 422,
  ASSET_ALREADY_DISPOSED: 409,
} as const satisfies Record<string, number>;

export type AccountingErrorCode = keyof typeof accountingErrorHttpStatus;
export const ACCOUNTING_ERROR_CODES = Object.keys(
  accountingErrorHttpStatus,
) as AccountingErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<AccountingErrorCode, string> = {
  PERIOD_CLOSED: "Periode buku sudah ditutup.",
  PERIOD_CHANGED: "Status periode berubah. Muat ulang lalu coba lagi.",
  PERIOD_MISMATCH: "Tanggal jurnal tidak berada di periode tersebut.",
  PERIOD_NOT_ENDED: "Hanya periode yang sudah berakhir yang dapat ditutup.",
  PERIOD_CLOSE_OUT_OF_ORDER: "Tutup periode sebelumnya terlebih dahulu.",
  PERIOD_REOPEN_OUT_OF_ORDER: "Buka ulang periode setelahnya terlebih dahulu.",
  PERIOD_ALREADY_CLOSED: "Periode ini sudah ditutup.",
  PERIOD_ALREADY_OPEN: "Periode ini masih terbuka.",
  PERIOD_NOT_CLOSED: "Periode ini belum ditutup.",
  REOPEN_REASON_REQUIRED: "Alasan pembukaan ulang wajib diisi.",
  JOURNAL_UNBALANCED: "Total debit dan kredit harus sama.",
  JOURNAL_LINE_INVALID:
    "Setiap baris diisi debit atau kredit, salah satu saja.",
  JOURNAL_IMMUTABLE:
    "Jurnal final tidak dapat diubah atau dihapus. Gunakan jurnal pembalik.",
  JOURNAL_ALREADY_REVERSED: "Jurnal ini sudah dibalik.",
  JOURNAL_NOT_REVERSIBLE: "Jurnal pembalik tidak dapat dibalik lagi.",
  INVALID_TRANSITION: "Perubahan status ini tidak diizinkan.",
  ACCOUNT_INACTIVE: "Akun tidak aktif.",
  ACCOUNT_NOT_POSTABLE: "Akun induk tidak dapat dipakai untuk jurnal.",
  ACCOUNT_ENTITY_MISMATCH: "Akun bukan milik badan usaha ini.",
  ACCOUNT_CODE_TAKEN: "Kode akun sudah dipakai.",
  POSTING_RULE_MISSING: "Aturan jurnal otomatis untuk transaksi ini belum ada.",
  ACCOUNT_MAPPING_MISSING: "Pemetaan akun untuk jurnal otomatis belum diatur.",
  POSTING_AMOUNTS_MISMATCH: "Nilai transaksi tidak sesuai aturan jurnal.",
  STATEMENT_LINE_ALREADY_MATCHED: "Mutasi ini sudah dicocokkan.",
  MATCH_AMOUNT_MISMATCH: "Jumlah dokumen tidak sama dengan nilai mutasi.",
  STATEMENT_VALUE_INVALID: "Nilai pada file mutasi tidak dapat dibaca.",
  TAX_REPORT_NOT_APPLICABLE: "Jenis pajak ini tidak berlaku untuk badan usaha.",
  ASSET_ALREADY_DISPOSED: "Aset sudah dilepas.",
};

export class AccountingError extends Error {
  readonly code: AccountingErrorCode;
  readonly status: number;

  constructor(
    code: AccountingErrorCode,
    message: string = defaultMessages[code],
  ) {
    super(message);
    this.name = "AccountingError";
    this.code = code;
    this.status = accountingErrorHttpStatus[code];
  }
}
