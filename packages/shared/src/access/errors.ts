// Access-domain error codes (docs/plan/contracts.md D-CORE-4: domain contracts
// declare their own UPPER_SNAKE codes next to their schemas). The API error
// handler maps AccessError the same way it maps CoreError.

export const accessErrorHttpStatus = {
  /** No active role assignment grants this permission for the target (deny by default). */
  PERMISSION_DENIED: 403,
  /** A role that requires MFA opened back office or dashboard without a second factor (AUTH-05). */
  MFA_REQUIRED: 403,
  /** Role grants and other sensitive actions need a recent re-authentication (PRD §3.7 Pemberian Role, §2 Keamanan). */
  REAUTH_REQUIRED: 401,
  /** A user tried to grant a role to themself (PRD §3.7 Pemberian Role). */
  SELF_ELEVATION_FORBIDDEN: 403,
  /** The role cannot be assigned at this scope type (e.g. Barista / Cook outside a station). */
  ROLE_SCOPE_NOT_ALLOWED: 422,
  /** Platform roles (Super Admin) are never tenant role assignments. */
  ROLE_NOT_ASSIGNABLE: 422,
  /** Unknown permission code, or a platform permission in a tenant custom role. */
  PERMISSION_NOT_IN_CATALOG: 422,
  /** An Owner-template-only permission (e.g. receipt write-off) in a custom role (legend-7vsby). */
  PERMISSION_OWNER_ONLY: 422,
  /** Approver is the requester (AUTH-06, PRD §3.7 Matriks Approval). */
  APPROVER_IS_REQUESTER: 403,
  /** The same person tried to approve two levels of one request. */
  APPROVER_ALREADY_DECIDED: 403,
  /** Approver holds none of the roles the matrix names for this level. */
  APPROVER_ROLE_MISMATCH: 403,
  /** Decision for a level other than the next open one. */
  APPROVAL_LEVEL_OUT_OF_ORDER: 409,
  /** No approval policy configured for an action: nobody can approve, so it stays blocked (fail closed). */
  APPROVAL_POLICY_MISSING: 409,
  /** A supplier_payment matrix without a base tier (level 1, threshold null or 0): one person could pay alone (Q27). */
  SUPPLIER_PAYMENT_BASE_TIER_REQUIRED: 422,
} as const satisfies Record<string, number>;

export type AccessErrorCode = keyof typeof accessErrorHttpStatus;
export const ACCESS_ERROR_CODES = Object.keys(
  accessErrorHttpStatus,
) as AccessErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<AccessErrorCode, string> = {
  PERMISSION_DENIED: "Anda tidak memiliki izin untuk tindakan ini.",
  MFA_REQUIRED: "Verifikasi faktor kedua diperlukan untuk membuka halaman ini.",
  REAUTH_REQUIRED: "Silakan autentikasi ulang untuk melanjutkan.",
  SELF_ELEVATION_FORBIDDEN:
    "Anda tidak dapat memberikan role kepada diri sendiri.",
  ROLE_SCOPE_NOT_ALLOWED:
    "Role ini tidak dapat diberikan pada cakupan tersebut.",
  ROLE_NOT_ASSIGNABLE: "Role ini tidak dapat diberikan di tingkat tenant.",
  PERMISSION_NOT_IN_CATALOG:
    "Izin tidak dikenal atau tidak boleh dipakai di role tenant.",
  PERMISSION_OWNER_ONLY:
    "Izin ini hanya milik role Owner dan tidak dapat dimasukkan ke role kustom.",
  APPROVER_IS_REQUESTER: "Penyetuju tidak boleh sama dengan pemohon.",
  APPROVER_ALREADY_DECIDED: "Anda sudah memberi keputusan pada permintaan ini.",
  APPROVER_ROLE_MISMATCH: "Role Anda tidak berwenang menyetujui tingkat ini.",
  APPROVAL_LEVEL_OUT_OF_ORDER: "Tingkat approval ini belum dapat diputuskan.",
  APPROVAL_POLICY_MISSING: "Matriks approval untuk tindakan ini belum diatur.",
  SUPPLIER_PAYMENT_BASE_TIER_REQUIRED:
    "Pembayaran supplier wajib punya tingkat dasar: tingkat 1 untuk semua nominal (batas 0). Tambahkan tingkat 1 dengan batas 0, supaya satu orang tidak bisa membayar supplier sendirian.",
};

export class AccessError extends Error {
  readonly code: AccessErrorCode;
  readonly status: number;

  constructor(code: AccessErrorCode, message: string = defaultMessages[code]) {
    super(message);
    this.name = "AccessError";
    this.code = code;
    this.status = accessErrorHttpStatus[code];
  }
}
