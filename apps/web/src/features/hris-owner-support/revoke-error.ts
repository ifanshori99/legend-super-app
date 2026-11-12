/** A revoke failure refers to the current session or grant, not an unavailable feature. */
export function revokeErrorMessage(error: unknown): string {
  const { status, code } = (error ?? {}) as { status?: number; code?: string };
  if (code === "NETWORK_ERROR")
    return "Tidak ada koneksi. Periksa internet Anda, lalu coba lagi.";
  if (code === "IMPERSONATION_NOT_ALLOWED")
    return "Keluar dari sesi penyamaran, lalu masuk sebagai owner untuk mencabut akses.";
  if (
    code === "MFA_REQUIRED" ||
    code === "MFA_INVALID" ||
    code === "REAUTH_REQUIRED"
  )
    return "Verifikasi dua langkah diperlukan. Selesaikan verifikasi, lalu coba lagi.";
  if (status === 401)
    return "Sesi Anda berakhir. Masuk kembali, lalu coba lagi.";
  if (status === 403 || code === "FORBIDDEN")
    return "Akun ini tidak memiliki izin mencabut akses dukungan.";
  if (status === 404 || code === "NOT_FOUND")
    return "Akses tidak ditemukan. Muat ulang halaman untuk melihat status terbaru.";
  if (status === 409)
    return "Status akses telah berubah. Muat ulang halaman dan coba lagi.";
  return "Akses belum dapat dicabut. Coba lagi sebentar lagi.";
}
