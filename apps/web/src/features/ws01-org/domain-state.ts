// Pure logic of the custom-domain verification screen (bead legend-az8z5;
// mockup design/mockups/platform/domain-verification.html): hostname input
// rules, the API error mapping, the notice copy and the view derived from a
// domain row. No React, no framework imports and no TypeScript-only runtime
// syntax, so the unit tests load it directly with native Node type stripping.
//
// The error mapping is duck-typed on `status` and `code` (an `ApiError` has
// both), so tests can pass plain objects. The copy is the mockup's, verbatim.

export type DomainErrorKind =
  | "verification_failed"
  | "reserved"
  | "taken"
  | "network"
  | "unknown";

export type DomainNotice = { title: string; message: string };

export const DOMAIN_COPY = {
  verificationFailedTitle: "Verifikasi belum berhasil.",
  verificationFailedMessage:
    "Record TXT belum ditemukan. Periksa nama dan nilai di pengelola DNS, lalu coba lagi.",
  unusableTitle: "Domain tidak dapat digunakan.",
  reservedMessage:
    "Domain ini dicadangkan dan tidak dapat digunakan. Pilih domain lain.",
  takenMessage: "Domain ini sudah digunakan. Pilih domain lain.",
  networkTitle: "Tidak ada koneksi.",
  networkMessage: "Periksa koneksi internet Anda, lalu coba lagi.",
  unknownTitle: "Terjadi kesalahan.",
  unknownMessage: "Permintaan belum berhasil. Coba lagi sebentar lagi.",
  hostnameRequired: "Masukkan nama domain.",
  hostnameInvalid:
    "Nama domain tidak valid. Gunakan format seperti pesan.contoh.id.",
  noBrand: "Belum ada brand. Tambahkan brand lebih dulu untuk menghubungkan domain.",
  noRecord:
    "Petunjuk verifikasi belum tersedia. Muat ulang halaman, lalu coba lagi.",
  copied: "Tersalin.",
  copyFailed: "Tidak dapat menyalin. Pilih dan salin teks secara manual.",
} as const;

/** Maps a failed request to what the screen says. Status is the fallback. */
export function classifyDomainError(error: unknown): DomainErrorKind {
  const e = (error ?? {}) as { status?: unknown; code?: unknown };
  if (e.code === "DOMAIN_VERIFICATION_FAILED") return "verification_failed";
  if (e.code === "DOMAIN_RESERVED") return "reserved";
  if (e.code === "DOMAIN_TAKEN") return "taken";
  if (e.status === 0 || e.code === "NETWORK_ERROR") return "network";
  if (error instanceof TypeError) return "network";
  return "unknown";
}

export function domainNotice(kind: DomainErrorKind): DomainNotice {
  switch (kind) {
    case "verification_failed":
      return {
        title: DOMAIN_COPY.verificationFailedTitle,
        message: DOMAIN_COPY.verificationFailedMessage,
      };
    case "reserved":
      return {
        title: DOMAIN_COPY.unusableTitle,
        message: DOMAIN_COPY.reservedMessage,
      };
    case "taken":
      return {
        title: DOMAIN_COPY.unusableTitle,
        message: DOMAIN_COPY.takenMessage,
      };
    case "network":
      return {
        title: DOMAIN_COPY.networkTitle,
        message: DOMAIN_COPY.networkMessage,
      };
    default:
      return {
        title: DOMAIN_COPY.unknownTitle,
        message: DOMAIN_COPY.unknownMessage,
      };
  }
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_TLDS = ["localhost", "local", "internal", "localdomain"];

/**
 * Same rules as `normalizeHostname` (packages/shared platform/domains.ts):
 * lowercase, no port, no trailing dot, public DNS name only. Null when the
 * input is not one. The API stays the authority; this only saves a round trip.
 */
export function normalizeDomainInput(input: string): string | null {
  let host = input.trim().toLowerCase();
  if (host.startsWith("[")) return null;
  host = host.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  const tld = labels[labels.length - 1];
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(tld)) return null;
  if (RESERVED_TLDS.includes(tld)) return null;
  return host;
}

export type HostnameCheck =
  | { ok: true; hostname: string }
  | { ok: false; message: string };

export function validateHostname(input: string): HostnameCheck {
  if (input.trim().length === 0)
    return { ok: false, message: DOMAIN_COPY.hostnameRequired };
  const hostname = normalizeDomainInput(input);
  if (hostname === null)
    return { ok: false, message: DOMAIN_COPY.hostnameInvalid };
  return { ok: true, hostname };
}

export type DomainRow = {
  kind: string;
  verifiedAt: string | null;
  verification: { type: string; name: string; value: string } | null;
};

/** "pending": publish the record and check; "verified": ownership confirmed. */
export type DomainView = "pending" | "verified";

export function domainView(domain: DomainRow): DomainView {
  return domain.verifiedAt !== null ? "verified" : "pending";
}

/** Only custom domains are verified here; the platform subdomain is not. */
export function customDomains<T extends { kind: string }>(
  domains: readonly T[],
): T[] {
  return domains.filter((domain) => domain.kind === "custom");
}

export type DomainScreen = "empty" | "list";

export function domainScreen(domains: readonly { kind: string }[]): DomainScreen {
  return customDomains(domains).length === 0 ? "empty" : "list";
}
