// Identity-domain error codes (docs/plan/contracts.md D-CORE-4: a domain
// declares its own UPPER_SNAKE codes next to its schemas). The API error
// handler maps IdentityError the same way it maps CoreError and AccessError.
//
// Codes the RBAC contract already owns stay there and are not repeated here:
// MFA_REQUIRED, APPROVER_IS_REQUESTER, APPROVER_ALREADY_DECIDED,
// APPROVER_ROLE_MISMATCH, APPROVAL_LEVEL_OUT_OF_ORDER,
// APPROVAL_POLICY_MISSING (access/errors.ts). Rate limiting uses the core
// RATE_LIMITED code (AUTH-04).

export const identityErrorHttpStatus = {
  /** The challenge was already completed, cancelled or expired (one use only, AUTH-01). */
  CHALLENGE_NOT_PENDING: 409,
  /** The code or link outlived its window (AUTH-01: 5 minutes for WhatsApp). */
  CHALLENGE_EXPIRED: 410,
  /** The browser that completes is not the browser that asked (AUTH-01 binding). */
  CHALLENGE_BROWSER_MISMATCH: 403,
  /** The identity value already belongs to another account; link or merge instead. */
  IDENTITY_ALREADY_LINKED: 409,
  /** No verified WhatsApp number yet (AUTH-07: points need one). */
  WHATSAPP_VERIFICATION_REQUIRED: 403,
  /** Wrong 6-digit staff pin. */
  PIN_INVALID: 401,
  /** Too many wrong pins; a supervisor override or the lock window releases it. */
  PIN_LOCKED: 423,
  /** The attendance PIN proof is unknown, expired, superseded, used on upload, or from another device (bead legend-u7g9w). */
  PIN_PROOF_INVALID: 401,
  /** The attendance PIN proof was already consumed by a clock request. */
  PIN_PROOF_USED: 409,
  /** Too many wrong pins from this device across staff; `Retry-After` says when. */
  PIN_DEVICE_THROTTLED: 429,
  /** The chosen pin is trivial (all one digit, or a straight run). */
  WEAK_STAFF_PIN: 422,
  /** An MFA-guarded role has no second factor enrolled yet; enrollment comes first. */
  MFA_ENROLLMENT_REQUIRED: 403,
  /** The approval request already has a decision, expired or was cancelled. */
  APPROVAL_REQUEST_NOT_PENDING: 409,
  /** The approval deadline passed; the action stays blocked (fail closed). */
  APPROVAL_REQUEST_EXPIRED: 410,
  /** The user status change is not allowed (e.g. restoring a deleted account). */
  USER_STATUS_TRANSITION: 409,
  // legend-k2l (ws08 M2/M3): member sign-in methods and identity merge.
  /** Production has no email provider key yet, so no magic link can be sent. */
  EMAIL_NOT_CONFIGURED: 503,
  /** The other account is not WhatsApp-only; support must merge by hand. */
  IDENTITY_MERGE_NEEDS_SUPPORT: 409,
  /** A cross-device magic-link session cannot link WhatsApp or merge. */
  IDENTITY_LINK_REAUTH_REQUIRED: 403,
  /** This account already has another verified WhatsApp number. */
  WHATSAPP_ALREADY_ON_ACCOUNT: 409,
} as const satisfies Record<string, number>;

export type IdentityErrorCode = keyof typeof identityErrorHttpStatus;
export const IDENTITY_ERROR_CODES = Object.keys(
  identityErrorHttpStatus,
) as IdentityErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<IdentityErrorCode, string> = {
  CHALLENGE_NOT_PENDING: "Kode masuk ini sudah dipakai atau dibatalkan.",
  CHALLENGE_EXPIRED: "Kode masuk sudah kedaluwarsa. Silakan minta kode baru.",
  CHALLENGE_BROWSER_MISMATCH:
    "Kode ini dibuat di perangkat lain. Minta kode baru dari perangkat ini.",
  IDENTITY_ALREADY_LINKED:
    "Nomor atau email ini sudah terhubung ke akun lain. Masuk ke akun tersebut untuk menggabungkan.",
  WHATSAPP_VERIFICATION_REQUIRED:
    "Verifikasi nomor WhatsApp diperlukan sebelum mengumpulkan atau menukar poin.",
  PIN_INVALID: "PIN salah.",
  PIN_LOCKED: "PIN terkunci. Minta supervisor membuka atau coba lagi nanti.",
  PIN_PROOF_INVALID: "Bukti PIN tidak berlaku. Masukkan PIN lagi.",
  PIN_PROOF_USED: "Bukti PIN ini sudah dipakai. Masukkan PIN lagi.",
  PIN_DEVICE_THROTTLED:
    "Terlalu banyak PIN salah dari perangkat ini. Coba lagi nanti.",
  WEAK_STAFF_PIN: "PIN terlalu mudah ditebak. Pilih 6 angka lain.",
  MFA_ENROLLMENT_REQUIRED:
    "Role Anda mewajibkan faktor kedua. Daftarkan aplikasi autentikator atau passkey.",
  APPROVAL_REQUEST_NOT_PENDING: "Permintaan ini sudah diputuskan.",
  APPROVAL_REQUEST_EXPIRED:
    "Batas waktu persetujuan sudah lewat. Ajukan ulang bila masih diperlukan.",
  USER_STATUS_TRANSITION: "Perubahan status akun ini tidak diizinkan.",
  // legend-k2l
  EMAIL_NOT_CONFIGURED:
    "Masuk lewat email belum tersedia. Silakan masuk lewat WhatsApp.",
  IDENTITY_MERGE_NEEDS_SUPPORT:
    "Nomor ini sudah terhubung ke akun lain yang perlu diperiksa tim dukungan. Hubungi dukungan untuk menggabungkan akun.",
  IDENTITY_LINK_REAUTH_REQUIRED:
    "Link masuk dibuka di perangkat lain. Minta link baru dari perangkat ini sebelum menautkan WhatsApp.",
  WHATSAPP_ALREADY_ON_ACCOUNT:
    "Akun ini sudah terhubung ke nomor WhatsApp lain.",
};

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly status: number;

  constructor(
    code: IdentityErrorCode,
    message: string = defaultMessages[code],
  ) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
    this.status = identityErrorHttpStatus[code];
  }
}
