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
  /** Stock sources of the period wait in inventory_gl_blocked (card 1260); no close until they post. */
  PERIOD_INVENTORY_GL_BLOCKED: 422,
  PERIOD_ALREADY_OPEN: 409,
  /** The action needs a closed period (e.g. finalising a tax report). */
  PERIOD_NOT_CLOSED: 409,
  /** Reopening a closed period needs a written reason (§3.19 Tutup Periode). */
  REOPEN_REASON_REQUIRED: 422,
  /**
   * Separation of duties on a reopen (ACC-02, coordinator decision
   * 2026-11-03): the person who closed the period may not approve reopening
   * it. "Approver is the requester" stays APPROVER_IS_REQUESTER (AUTH-06).
   */
  APPROVER_IS_CLOSER: 403,
  /** Debit and credit totals differ, or fewer than two lines (ACC-01). */
  JOURNAL_UNBALANCED: 422,
  /** A line has both or neither side, or a negative amount. */
  JOURNAL_LINE_INVALID: 422,
  /** Posted journals are final: never edited or deleted, only reversed (ACC-01). */
  JOURNAL_IMMUTABLE: 409,
  JOURNAL_ALREADY_REVERSED: 409,
  /**
   * One automatic entry debits and credits the same account (net zero: a
   * mapping collapsed two roles, e.g. employee_receivable onto petty_cash).
   */
  JOURNAL_SAME_ACCOUNT_DEBIT_CREDIT: 422,
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
  /** The report was replaced by a later revision; only the current one can be exported. */
  TAX_REPORT_SUPERSEDED: 409,
  /** The fiscal period changed after the draft was generated; regenerate the draft. */
  TAX_REPORT_STALE: 409,
  /** A correction (revision >= 1) needs a written reason. */
  TAX_REPORT_CORRECTION_REASON_REQUIRED: 400,
  /** The data source for this tax type is not wired yet (payroll / payables). */
  TAX_REPORT_SOURCE_UNAVAILABLE: 422,
  /** The stored amount differs from the sum of the report lines. */
  TAX_REPORT_AMOUNT_MISMATCH: 422,
  TAX_REPORT_NOT_FOUND: 404,
  /** The draft equals the current report (same period version, amount and lines). */
  TAX_REPORT_NO_CHANGE: 409,
  ASSET_ALREADY_DISPOSED: 409,
  /** A share version must sum to exactly 10,000 bp before it can be submitted or approved (SH-03). */
  SHARE_ALLOCATION_NOT_EXACT_100: 422,
  /** One shareholder appears twice in a version (the shares would double-count). */
  SHARE_ALLOCATION_DUPLICATE: 422,
  /** A new version's effective date must advance past the approved version it replaces. */
  SHARE_VERSION_EFFECTIVE_DATE_ORDER: 422,
  /** The share version is not approved, so it cannot be used for a distribution (SH-03). */
  SHARE_VERSION_NOT_APPROVED: 422,
  /** No approved share version is in force on the requested date. */
  SHARE_VERSION_NOT_EFFECTIVE: 422,
  /** The closed period's profit is zero or negative: nothing to distribute (PRD §3.37). */
  NOTHING_TO_DISTRIBUTE: 422,
  /** An outlet profit entity cannot pay while the period has expense not allocated to any outlet (bead 1210). */
  UNALLOCATED_ENTITY_EXPENSE: 422,
  /** An approved or paid distribution is frozen; corrections are adjustment runs with a reversing journal (SH-04). */
  DISTRIBUTION_IMMUTABLE: 409,
  /** A regular distribution already exists for this profit entity and closed period. */
  DISTRIBUTION_ALREADY_EXISTS: 409,
  /** The distribution line already has a payment recorded. */
  DISTRIBUTION_LINE_ALREADY_PAID: 409,
  /** An adjustment must target an approved or paid run and carry a reason (SH-04). */
  ADJUSTMENT_TARGET_INVALID: 422,
  /** Every shareholder's paid gross is already given back: nothing left for a claw-back to absorb (founder rule Q83). */
  ADJUSTMENT_EXCEEDS_PAID: 422,
  /** A petty cash movement or purchase would take the outlet's fund below zero (legend-4961). */
  PETTY_CASH_INSUFFICIENT: 422,
  /** The outlet has no petty cash fund, so a petty purchase is refused (founder Q8, 13 Nov 2026). */
  PETTY_CASH_FUND_REQUIRED: 422,
  /** A petty cash return is above the GL balance of petty cash (1102) of the entity: the books hold less than the fund (legend-a4z2f). */
  PETTY_CASH_GL_INSUFFICIENT: 422,
  /** Cash in/out counter account is a cash or bank account: use a transfer instead (legend-4961). */
  CASH_BANK_COUNTER_ACCOUNT_INVALID: 422,
  /** The creator of a cash out cannot approve or reject it (founder Q7, 13 Nov 2026). */
  CASH_OUT_SELF_APPROVAL: 403,
  /** The cash entry is not waiting for approval (already rejected). */
  CASH_ENTRY_NOT_PENDING: 409,
  /** The approval chain of a pending cash entry is still open: the direct endpoint cannot post before every level approved (legend-3bkvl). */
  CASH_OUT_CHAIN_OPEN: 409,
  /** A pending cash entry has no approval chain: nothing proves the matrix was met, so nothing posts (legend-3bkvl, legend-lhyt0). */
  CASH_OUT_CHAIN_MISSING: 409,
  /** No such cash/bank entry for this tenant. */
  CASH_ENTRY_NOT_FOUND: 404,
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
  PERIOD_INVENTORY_GL_BLOCKED:
    "Masih ada sumber persediaan yang belum terjurnal. Selesaikan dulu, lalu tutup periode.",
  PERIOD_ALREADY_OPEN: "Periode ini masih terbuka.",
  PERIOD_NOT_CLOSED: "Periode ini belum ditutup.",
  REOPEN_REASON_REQUIRED: "Alasan pembukaan ulang wajib diisi.",
  APPROVER_IS_CLOSER:
    "Penutup periode tidak boleh menyetujui pembukaan ulangnya sendiri.",
  JOURNAL_UNBALANCED: "Total debit dan kredit harus sama.",
  JOURNAL_LINE_INVALID:
    "Setiap baris diisi debit atau kredit, salah satu saja.",
  JOURNAL_IMMUTABLE:
    "Jurnal final tidak dapat diubah atau dihapus. Gunakan jurnal pembalik.",
  JOURNAL_ALREADY_REVERSED: "Jurnal ini sudah dibalik.",
  JOURNAL_SAME_ACCOUNT_DEBIT_CREDIT:
    "Jurnal otomatis mendebit dan mengkredit akun yang sama. Periksa pemetaan akun.",
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
  TAX_REPORT_SUPERSEDED:
    "Laporan pajak ini sudah digantikan revisi yang lebih baru.",
  TAX_REPORT_STALE:
    "Periode berubah sejak draf dibuat. Buat ulang draf laporan pajak.",
  TAX_REPORT_CORRECTION_REASON_REQUIRED:
    "Alasan pembetulan wajib diisi untuk revisi laporan pajak.",
  TAX_REPORT_SOURCE_UNAVAILABLE:
    "Sumber data untuk jenis pajak ini belum tersedia.",
  TAX_REPORT_AMOUNT_MISMATCH:
    "Jumlah laporan tidak sama dengan total pajak per baris.",
  TAX_REPORT_NOT_FOUND: "Laporan pajak tidak ditemukan.",
  TAX_REPORT_NO_CHANGE:
    "Tidak ada perubahan dari laporan pajak yang berlaku. Tidak perlu dibuat revisi.",
  ASSET_ALREADY_DISPOSED: "Aset sudah dilepas.",
  SHARE_ALLOCATION_NOT_EXACT_100:
    "Total porsi pemegang saham harus tepat 10.000 bp (100%).",
  SHARE_ALLOCATION_DUPLICATE:
    "Pemegang saham yang sama tercantum lebih dari sekali.",
  SHARE_VERSION_EFFECTIVE_DATE_ORDER:
    "Tanggal berlaku versi baru harus setelah versi yang disetujui sebelumnya.",
  SHARE_VERSION_NOT_APPROVED:
    "Versi porsi belum disetujui sehingga belum dapat dipakai.",
  SHARE_VERSION_NOT_EFFECTIVE:
    "Belum ada versi porsi yang berlaku pada tanggal tersebut.",
  NOTHING_TO_DISTRIBUTE:
    "Tidak ada laba yang dapat dibagikan pada periode ini.",
  UNALLOCATED_ENTITY_EXPENSE:
    "Gaji dan beban pusat periode ini belum dialokasikan ke outlet, jadi bagi hasil outlet belum bisa diproses.",
  DISTRIBUTION_IMMUTABLE:
    "Distribusi yang sudah disetujui tidak dapat diubah. Buat distribusi penyesuaian.",
  DISTRIBUTION_ALREADY_EXISTS:
    "Distribusi untuk periode ini sudah pernah dibuat.",
  DISTRIBUTION_LINE_ALREADY_PAID:
    "Pembayaran untuk pemegang saham ini sudah dicatat.",
  ADJUSTMENT_TARGET_INVALID:
    "Penyesuaian hanya untuk distribusi yang sudah disetujui dan wajib beralasan.",
  ADJUSTMENT_EXCEEDS_PAID:
    "Pengembalian melebihi jumlah yang sudah dibayarkan kepada pemegang saham.",
  PETTY_CASH_INSUFFICIENT: "Saldo kas kecil outlet tidak cukup.",
  PETTY_CASH_FUND_REQUIRED:
    "Outlet ini belum punya dana kas kecil. Buat dana dulu di layar Kas kecil.",
  PETTY_CASH_GL_INSUFFICIENT:
    "Saldo kas kecil di pembukuan lebih kecil dari jumlah ini. Periksa rekonsiliasi kas kecil.",
  CASH_BANK_COUNTER_ACCOUNT_INVALID:
    "Akun lawan tidak boleh akun kas atau bank. Gunakan transfer antar-rekening.",
  CASH_OUT_SELF_APPROVAL:
    "Pembuat kas keluar tidak boleh menyetujui atau menolaknya sendiri.",
  CASH_ENTRY_NOT_PENDING:
    "Entri ini sudah diputuskan dan tidak bisa diubah lagi.",
  CASH_OUT_CHAIN_OPEN:
    "Persetujuan bertingkat belum selesai. Selesaikan semua tingkat di kotak persetujuan.",
  CASH_OUT_CHAIN_MISSING:
    "Kas keluar ini tidak punya alur persetujuan, jadi tidak bisa disetujui langsung.",
  CASH_ENTRY_NOT_FOUND: "Transaksi kas dan bank tidak ditemukan.",
};

export class AccountingError extends Error {
  readonly code: AccountingErrorCode;
  readonly status: number;
  /** Optional machine-readable context (e.g. `supersededById` on TAX_REPORT_SUPERSEDED). */
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: AccountingErrorCode,
    message: string = defaultMessages[code],
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AccountingError";
    this.code = code;
    this.status = accountingErrorHttpStatus[code];
    if (details !== undefined) this.details = details;
  }
}
