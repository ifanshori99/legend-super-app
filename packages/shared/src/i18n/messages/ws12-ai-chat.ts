// WS-12 Tanya AI & MCP UI text, part "chat" (brief docs/briefs/sub-539-u3-ai-mcp.md).
// Own file so the parallel WS-12 UI beads never edit the same lines in id.ts.
// Namespace: `aiChat`. Copy follows the approved mockup design/mockups/ai/tanya-ai.html.

export const aiChatMessages = {
  nav: "Tanya AI",
  navGuide: "Panduan AI",
  title: "Tanya AI",
  subtitle: "Tanyakan hal tentang bisnis Anda.",
  deleteAll: "Hapus riwayat",
  history: {
    title: "Riwayat Anda",
    privacy: "Riwayat hanya terlihat oleh Anda.",
    newConversation: "Percakapan baru",
    openSheet: "Riwayat",
    untitled: "Percakapan baru",
    loading: "Memuat riwayat…",
    emptyTitle: "Belum ada percakapan",
    emptyHint: "Percakapan Anda akan muncul di sini setelah Anda bertanya.",
    errorTitle: "Riwayat tidak dapat dimuat",
    errorHint: "Periksa koneksi, lalu coba lagi.",
    listLabel: "Daftar percakapan",
  },
  chat: {
    personal: "Riwayat pribadi",
    loading: "Memuat percakapan…",
    waiting: "Menunggu jawaban…",
    emptyTitle: "Mulai percakapan",
    emptyHint:
      "Tulis pertanyaan di bawah, misalnya “Bagaimana penjualan kemarin?”.",
    errorTitle: "Percakapan tidak dapat dimuat",
    errorHint: "Periksa koneksi, lalu coba lagi.",
    notFoundTitle: "Percakapan tidak ditemukan",
    notFoundHint:
      "Percakapan ini mungkin sudah dihapus. Pilih percakapan lain atau mulai yang baru.",
  },
  answer: {
    label: "Tanya AI",
    badge: "Dibantu AI",
    note: "Periksa sumber sebelum mengambil keputusan.",
    sourceHeading: "Sumber · {kind}",
    sourceKind: {
      sales: "Laporan penjualan",
      report: "Laporan",
      document: "Dokumen",
    },
    sourceOpen: "buka sumber",
    sourceScope: "{brand} · Periode {period}",
    sourceScopeNoPeriod: "{brand}",
    stop: "Hentikan",
    stopped: "Jawaban dihentikan.",
    ready: "Jawaban sudah siap.",
    askAgain: "Tanya ulang",
    questionPrefix: "Pertanyaan Anda:",
    showAll: "Tampilkan lengkap",
    retry: "Coba lagi",
    draftTitle: "Diajukan, menunggu persetujuan",
    draftBody:
      "Belum ada yang berubah. Perubahan baru berjalan setelah disetujui.",
    draftOpen: "Lihat pengajuan",
  },
  composer: {
    label: "Pertanyaan Anda",
    placeholder: "Tulis pertanyaan tentang bisnis",
    send: "Kirim",
    note: "Jawaban mengikuti izin dan cakupan akses Anda.",
    remaining: "Sisa pertanyaan hari ini: {left} dari {limit}.",
  },
  banner: {
    denied: {
      title: "Data tidak dapat ditampilkan",
      body: "Anda tidak memiliki izin untuk melihat data ini. Hubungi pengelola akses jika Anda memerlukannya.",
    },
    unavailable: {
      title: "AI belum tersedia",
      body: "Jawaban tidak dapat dimuat saat ini. Coba lagi nanti atau buka laporan langsung.",
      openReport: "Buka laporan",
    },
    quota: {
      title: "Batas pertanyaan hari ini sudah habis",
      body: "Anda bisa bertanya lagi besok. Sementara itu, buka laporan langsung untuk melihat angka terbaru.",
    },
    budget: {
      title: "Anggaran AI bulan ini sudah habis",
      body: "Hubungi admin untuk menambah anggaran. Sementara itu, buka laporan langsung.",
    },
    pii: {
      title: "Pertanyaan memuat data pribadi",
      body: "Hapus nama, nomor telepon, atau data pribadi lain dari pertanyaan, lalu kirim lagi.",
    },
    featureOff: {
      title: "Fitur ini sedang dimatikan",
      body: "Admin mematikan Tanya AI untuk sementara. Buka laporan langsung untuk melihat angka Anda.",
    },
    error: {
      title: "Jawaban tidak dapat dimuat",
      body: "Terjadi gangguan saat menjawab. Coba lagi, atau buka laporan langsung.",
    },
    offline: {
      title: "Anda sedang offline",
      body: "Sambungkan internet, lalu coba lagi. Riwayat percakapan tidak berubah.",
    },
  },
  delete: {
    title: "Hapus riwayat percakapan?",
    body: "Semua percakapan Tanya AI milik Anda akan dihapus. Tindakan ini tidak dapat dibatalkan.",
    cancel: "Batal",
    confirm: "Hapus riwayat",
    deleting: "Menghapus…",
    done: "Riwayat percakapan dihapus.",
    errorTitle: "Riwayat belum terhapus",
    errorBody:
      "Sebagian percakapan gagal dihapus. Coba lagi; percakapan yang sudah terhapus tidak kembali.",
    offlineBody: "Sambungkan internet, lalu coba lagi.",
  },
} as const;
