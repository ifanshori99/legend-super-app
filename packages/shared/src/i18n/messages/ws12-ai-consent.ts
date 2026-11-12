// WS-12 Tanya AI & MCP UI text, part "consent" (brief docs/briefs/sub-539-u3-ai-mcp.md).
// Own file so the parallel WS-12 UI beads never edit the same lines in id.ts.
// Namespace: `aiConsent`.

export const aiConsentMessages = {
  title: "Persetujuan akses MCP",
  back: "Kembali ke aplikasi",
  accountLead: "Masuk sebagai",
  eyebrow: "Permintaan koneksi",
  heading: "Izinkan akses ke Legend?",
  intro: "Periksa klien dan akses yang diminta sebelum melanjutkan.",
  approvedBadge: "Disetujui admin tenant",
  clientKind: "Klien MCP",
  returnsTo: "Akan kembali ke {host}",
  scopesHeading: "Akses yang diminta",
  scopesHint: "Hanya dalam batas izin dan cakupan akun Anda.",
  draftNoticeLead: "Persetujuan tetap diperlukan.",
  draftNotice:
    "Klien tidak dapat menerbitkan pesanan atau mengubah data langsung.",
  account: "Akun",
  revocable: "Akses dapat dicabut oleh admin.",
  deny: "Tolak",
  approve: "Setujui akses",
  foot: "Setujui hanya jika Anda mengenali klien ini. Aktivitas klien dicatat dalam log audit.",
  loading: "Memuat permintaan koneksi",
  connecting: "Menyambungkan…",
  connectingHint: "Mengalihkan Anda ke aplikasi. Jangan tutup halaman ini.",
  denying: "Kembali ke aplikasi…",
  denyingHint: "Akses ditolak. Anda akan dialihkan ke aplikasi.",
  missingTitle: "Permintaan koneksi tidak lengkap",
  missingHint:
    "Tautan ini tidak memuat klien atau alamat tujuan. Mulai lagi dari aplikasi yang ingin tersambung ke Legend.",
  previewErrorTitle: "Permintaan koneksi tidak dapat dilanjutkan",
  previewErrorHint:
    "Tidak ada akses yang diberikan. Periksa pengaturan di aplikasi klien atau hubungi admin, lalu coba lagi.",
  signedOutTitle: "Masuk dulu untuk melanjutkan",
  signedOutHint:
    "Anda perlu masuk ke Legend sebelum menyetujui akses. Setelah masuk, Anda kembali ke halaman ini.",
  signIn: "Masuk untuk melanjutkan",
  authorizeFailed:
    "Akses belum dapat disetujui. Tidak ada yang berubah; coba lagi.",
  badRedirect:
    "Alamat tujuan aplikasi tidak valid, jadi Anda tidak dialihkan. Tutup halaman ini dan mulai lagi dari aplikasi klien.",
} as const;
