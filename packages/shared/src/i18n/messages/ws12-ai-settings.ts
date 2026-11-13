// Pengaturan AI tenant UI text, part "page" (bead legend-nnufz). Namespace:
// `aiSettings`. Page frame, platform banner and the service order card.
// Copy follows the approved mockup design/mockups/ai/ai-settings.html.

export const aiSettingsMessages = {
  nav: "Pengaturan AI",
  title: "Pengaturan AI",
  heading: "Pengaturan AI",
  intro:
    "Hubungkan layanan AI untuk tenant Anda, siapkan cadangan, dan atur batas pemakaian.",
  groupLabel: "Pengaturan AI tenant",
  noAccessTitle: "Pengaturan AI tidak bisa dibuka",
  noAccessHint:
    "Akun ini belum punya izin untuk mengatur AI. Minta admin tenant menambahkannya.",
  platformOff: {
    title: "AI dimatikan oleh platform",
    body: "AI untuk sementara tidak dapat digunakan. Semua pengaturan dikunci sampai platform mengaktifkannya kembali.",
    hint: "Pengaturan tersimpan tetap dapat dilihat di bawah.",
  },
  error: {
    title: "Bagian ini belum bisa dimuat",
    hint: "Muat ulang bagian ini. Jika tetap gagal, coba lagi beberapa menit lagi.",
    offlineTitle: "Tidak ada koneksi",
    offlineHint: "Periksa internet Anda, lalu coba lagi.",
  },
  order: {
    title: "Urutan layanan",
    primary: "ChatGPT",
    primaryConnected: "Utama · Terhubung",
    primaryNotConnected: "Utama · Belum terhubung",
    fallback: "Model kustom",
    fallbackReady: "Cadangan otomatis · Siap",
    fallbackNotReady: "Cadangan otomatis · Belum siap",
    noteReady: "Cadangan dipakai otomatis bila layanan utama bermasalah.",
    noteNotReady:
      "Siapkan model kustom agar AI memiliki cadangan saat ChatGPT bermasalah.",
  },
} as const;
