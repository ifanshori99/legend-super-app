// Pengaturan AI tenant UI text, part "page" (bead legend-nnufz). Namespace:
// `aiSettings`. Page frame, platform lock banner, page states (loading,
// offline, session expired) and the service order card.
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
  platformLock: {
    title: "AI dimatikan oleh platform",
    body: "AI untuk sementara tidak dapat digunakan. Semua pengaturan dikunci sampai platform mengaktifkannya kembali.",
    hint: "Pengaturan tersimpan tetap dapat dilihat di bawah.",
  },
  states: {
    loadingStatus:
      "Memuat pengaturan AI… Pengaturan akan tampil setelah selesai.",
    cardChatgpt: "Login ChatGPT",
    cardCustom: "Model kustom",
    cardBudget: "Anggaran AI bulanan",
    offlineTitle: "Koneksi terputus",
    offlineBody:
      "Pengaturan AI belum dapat dimuat. Periksa koneksi internet, lalu coba lagi.",
    offlineHint:
      "Tidak ada perubahan yang dikirim. Hubungkan kembali sebelum mengubah pengaturan.",
    retry: "Coba lagi",
    sessionTitle: "Sesi Anda sudah habis",
    sessionBody:
      "Masuk kembali untuk melihat dan mengubah pengaturan AI tenant.",
    sessionHint:
      "Pengaturan tersimpan tidak berubah. Data akun dan kunci tidak ditampilkan sebelum Anda masuk.",
    signInAgain: "Masuk kembali",
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
    primaryLocked: "Utama · Dikunci platform",
    primaryUnavailable: "Utama · Status belum bisa dimuat",
    fallback: "Model kustom",
    fallbackReady: "Cadangan otomatis · Siap",
    fallbackNotReady: "Cadangan otomatis · Belum siap",
    fallbackUnavailable: "Cadangan otomatis · Status belum bisa dimuat",
    noteReady: "Cadangan dipakai otomatis bila layanan utama bermasalah.",
    noteNotReady:
      "Siapkan model kustom agar AI memiliki cadangan saat ChatGPT bermasalah.",
  },
} as const;
