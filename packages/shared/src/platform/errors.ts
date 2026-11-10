// Platform-domain error codes (docs/plan/contracts.md D-CORE-4: domain
// contracts declare their own UPPER_SNAKE codes next to their schemas). The
// API error handler maps PlatformError the same way it maps CoreError. A
// module switched off is the core FEATURE_DISABLED (TEN-05), so one code means
// one thing across UI, API, Tanya AI and MCP.

export const platformErrorHttpStatus = {
  /** The tenant is suspended or archived: its users, jobs and domains are refused. */
  TENANT_NOT_ACTIVE: 403,
  /** Super Admin opened tenant personal/financial data without an active support session (TEN-04). */
  SUPPORT_ACCESS_REQUIRED: 403,
  /** The support session is read-only; writes need a read_write session. */
  SUPPORT_ACCESS_READ_ONLY: 403,
  /** The Super Admin already holds an active session for this tenant. */
  SUPPORT_ACCESS_ALREADY_ACTIVE: 409,
  /** Merged Tenant Theme fails WCAG 2.2 AA in light or dark mode (TEN-10). */
  THEME_CONTRAST_FAILED: 422,
  /** Hostname is already verified by another tenant, or this tenant already added it (legend-t57t). */
  DOMAIN_TAKEN: 409,
  /** Hostname is the platform domain or under it; those names are reserved for platform subdomains (legend-t57t). */
  DOMAIN_RESERVED: 422,
  /** The DNS TXT ownership record was not found or does not carry this domain's token (legend-t57t). */
  DOMAIN_VERIFICATION_FAILED: 422,
  /** The WhatsApp receiving number or phone number ID is already active for another tenant (legend-mbd2, AUTH-02). */
  WHATSAPP_NUMBER_TAKEN: 409,
  /** Count quota (outlets, active employees, devices, AI requests) reached (PRD §3 F4 Kuota). */
  QUOTA_EXCEEDED: 409,
  /** Monthly WhatsApp/AI/email cost cap reached: the feature stops (PRD §2 Biaya operasional, R18). */
  COST_CAP_REACHED: 409,
  /** Module is not part of the tenant's package, so it cannot be switched on. */
  MODULE_NOT_IN_PACKAGE: 422,
  /** Super Admin has not made this integration provider available to the tenant. */
  INTEGRATION_PROVIDER_NOT_AVAILABLE: 422,
  /** Config bundle failed validation or still carries source-tenant identifiers (TEN-09). */
  CONFIG_BUNDLE_INVALID: 422,
  /** A valid bundle failed while being applied; the import was rolled back (TEN-09). */
  CONFIG_IMPORT_FAILED: 422,
  /** Status change not allowed from the current status. */
  INVALID_TRANSITION: 409,
  /** Restore asked for a tenant/outlet that is not archived/closed, or whose transition time was never recorded (legacy rows stay final). */
  RESTORE_NOT_AVAILABLE: 409,
  /** Restore asked more than 30 days after the tenant was archived or the outlet closed (Q40): the status is final. */
  RESTORE_WINDOW_EXPIRED: 409,
} as const satisfies Record<string, number>;

export type PlatformErrorCode = keyof typeof platformErrorHttpStatus;
export const PLATFORM_ERROR_CODES = Object.keys(
  platformErrorHttpStatus,
) as PlatformErrorCode[];

/** Safe Indonesian fallback messages; the UI maps `code` to catalog text. */
const defaultMessages: Record<PlatformErrorCode, string> = {
  TENANT_NOT_ACTIVE: "Tenant ini sedang tidak aktif.",
  SUPPORT_ACCESS_REQUIRED:
    "Data ini hanya dapat dibuka melalui sesi support access yang aktif.",
  SUPPORT_ACCESS_READ_ONLY: "Sesi support access ini hanya untuk membaca.",
  SUPPORT_ACCESS_ALREADY_ACTIVE:
    "Anda sudah memiliki sesi support access aktif untuk tenant ini.",
  THEME_CONTRAST_FAILED:
    "Tema belum memenuhi kontras minimum WCAG 2.2 AA sehingga tidak dapat diaktifkan.",
  DOMAIN_TAKEN: "Domain ini sudah dipakai.",
  DOMAIN_RESERVED:
    "Domain ini milik platform dan tidak dapat dipakai sebagai domain sendiri.",
  DOMAIN_VERIFICATION_FAILED:
    "Catatan DNS TXT untuk verifikasi domain belum ditemukan atau isinya tidak cocok.",
  WHATSAPP_NUMBER_TAKEN: "Nomor WhatsApp ini sudah dipakai tenant lain.",
  QUOTA_EXCEEDED: "Kuota paket sudah tercapai.",
  COST_CAP_REACHED: "Plafon biaya bulan ini sudah tercapai.",
  MODULE_NOT_IN_PACKAGE: "Modul ini tidak termasuk dalam paket tenant.",
  INTEGRATION_PROVIDER_NOT_AVAILABLE:
    "Penyedia integrasi ini belum tersedia untuk tenant.",
  CONFIG_BUNDLE_INVALID: "Berkas konfigurasi tidak valid.",
  CONFIG_IMPORT_FAILED:
    "Konfigurasi gagal diterapkan; tidak ada perubahan yang disimpan.",
  INVALID_TRANSITION: "Perubahan status ini tidak diizinkan.",
  RESTORE_NOT_AVAILABLE:
    "Status ini tidak dapat dipulihkan karena waktu arsip atau tutup tidak tercatat.",
  RESTORE_WINDOW_EXPIRED:
    "Batas 30 hari untuk memulihkan sudah lewat; status ini final.",
};

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly status: number;

  constructor(
    code: PlatformErrorCode,
    message: string = defaultMessages[code],
  ) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
    this.status = platformErrorHttpStatus[code];
  }
}
