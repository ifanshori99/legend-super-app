// WS-12 Tanya AI & MCP UI text, part "action" (brief docs/briefs/sub-539-u3-ai-mcp.md).
// Own file so the parallel WS-12 UI beads never edit the same lines in id.ts.
// Namespace: `aiAction`.

export const aiActionMessages = {
  pageTitle: "Detail permintaan aksi",
  backToChat: "Kembali ke Tanya AI",
  aiLabel: "Dibantu AI",
  reviewHint: "Tinjau rincian yang disiapkan AI sebelum keputusan diberikan.",
  status: {
    pending: "Menunggu persetujuan",
    approved: "Disetujui",
    executed: "Sudah dijalankan",
    rejected: "Ditolak",
    failed: "Gagal dijalankan",
    expired: "Kedaluwarsa",
  },
  facts: {
    outlet: "Outlet",
    allOutlets: "Semua outlet",
    type: "Jenis permintaan",
    requester: "Diajukan oleh",
    expiresAt: "Berlaku sampai",
  },
  summary: {
    title: "Ringkasan usulan",
    empty: "Tidak ada rincian yang bisa ditampilkan untuk permintaan ini.",
    before: "Sebelum",
    after: "Sesudah",
  },
  notice: {
    pending: {
      title: "Belum ada perubahan",
      body: "AI hanya menyiapkan draf. Permintaan harus disetujui orang yang berwenang sebelum diproses.",
    },
    approved: {
      title: "Sudah disetujui, menunggu dijalankan",
      body: "Perubahan belum berlaku. Sistem menjalankannya setelah persetujuan ini diproses.",
    },
    executed: {
      title: "Perubahan sudah dijalankan",
      body: "Permintaan ini sudah disetujui dan dijalankan.",
      result: "Acuan hasil: {ref}",
    },
    rejected: {
      title: "Permintaan ditolak",
      body: "Tidak ada perubahan yang dijalankan. Ajukan permintaan baru lewat Tanya AI bila masih diperlukan.",
    },
    failed: {
      title: "Perubahan gagal dijalankan",
      body: "Tidak ada perubahan yang tersimpan. Alasan: {reason}",
    },
    expired: {
      title: "Permintaan kedaluwarsa",
      body: "Tidak ada perubahan yang dijalankan. Ajukan permintaan baru lewat Tanya AI bila masih diperlukan.",
    },
  },
  flow: {
    title: "Alur persetujuan",
    intro: "Permintaan sudah masuk ke kotak persetujuan.",
    currentStatus: "Status saat ini",
    differentApprover: "Penyetuju harus orang yang berbeda dari pemohon.",
    openInbox: "Buka kotak persetujuan",
    state: {
      pending: "Menunggu peninjauan",
      approved: "Disetujui",
      executed: "Disetujui dan dijalankan",
      rejected: "Ditolak oleh penyetuju",
      failed: "Disetujui, tetapi gagal dijalankan",
      expired: "Kedaluwarsa tanpa keputusan",
    },
  },
  info: {
    title: "Informasi permintaan",
    source: "Sumber",
    sourceAi: "Tanya AI",
    sourceMcp: "Aplikasi AI lewat MCP",
    createdAt: "Waktu dibuat",
    executedAt: "Waktu dijalankan",
  },
  states: {
    notFoundTitle: "Permintaan tidak ditemukan",
    notFoundHint:
      "Permintaan ini tidak ada atau tidak bisa Anda lihat. Kembali ke Tanya AI untuk melihat permintaan Anda yang lain.",
    errorTitle: "Detail permintaan belum bisa dimuat",
    errorHint:
      "Periksa koneksi internet, lalu tekan Coba lagi. Permintaan Anda tetap aman.",
    offlineHint:
      "Anda sedang offline. Sambungkan internet, lalu tekan Coba lagi.",
  },
  inbox: {
    title: "Dibantu AI",
    heading: "Usulan dari {source}",
    onBehalfOf: "Atas nama {name}. {tool}.",
    note: "AI hanya menyiapkan draf. Keputusan tetap ada pada penyetuju.",
    viewDetail: "Lihat detail permintaan AI",
    moreLines: "dan {count} rincian lain di halaman detail",
  },
} as const;
