// WS-12 Tanya AI & MCP UI text, part "admin" (brief docs/briefs/sub-539-u3-ai-mcp.md).
// Own file so the parallel WS-12 UI beads never edit the same lines in id.ts.
// Namespace: `aiAdmin`. Copy follows the approved mockup admin.html; `**text**`
// marks bold words (the page splits on it, no markup in the catalog).

export const aiAdminMessages = {
  title: "Admin MCP & AI",
  heading: "Pengaturan MCP & AI",
  subtitle:
    "Kelola akses klien, kuota, dan penghentian layanan untuk tenant ini.",
  auditLink: "Lihat log audit",
  usageLink: "Lihat pemakaian",
  noAccessTitle: "Tidak ada bagian yang bisa dibuka",
  noAccessHint:
    "Akun ini belum punya izin untuk pengaturan AI maupun klien MCP. Minta admin tenant menambahkannya.",

  error: {
    title: "Bagian ini belum bisa dimuat",
    hint: "Muat ulang bagian ini. Jika tetap gagal, coba lagi beberapa menit lagi.",
    offlineTitle: "Tidak ada koneksi",
    offlineHint: "Periksa internet Anda, lalu coba lagi.",
  },
  saveError: {
    generic:
      "Perubahan belum tersimpan. Coba lagi. Jika tetap gagal, muat ulang halaman.",
    offline:
      "Perubahan belum tersimpan karena tidak ada koneksi. Periksa internet Anda, lalu coba lagi.",
    forbidden:
      "Akun ini tidak boleh mengubah pengaturan ini. Hubungi admin tenant.",
  },

  controls: {
    title: "Kontrol layanan",
    description:
      "Matikan layanan untuk menghentikan permintaan baru pada cakupan yang dipilih.",
    statusOn: "Aktif",
    statusOff: "Dimatikan",
    master: {
      title: "Seluruh layanan AI & MCP",
      description: "Sakelar utama untuk tenant ini",
    },
    askAi: {
      title: "Tanya AI",
      description: "Fitur Tanya AI untuk pengguna yang memiliki izin",
    },
    tools: {
      title: "Tool MCP",
      description: "Aktifkan atau hentikan tool secara terpisah",
      manage: "Kelola tool",
    },
    switchOn: "Aktif",
    switchOff: "Mati",
    savedOn: "Layanan dinyalakan.",
    savedOff: "Layanan dimatikan.",
    confirmMaster: {
      title: "Matikan seluruh layanan AI & MCP?",
      body: "Semua permintaan baru ke Tanya AI dan ke klien MCP berhenti sekarang. Bagian lain di Legend tetap berjalan. Anda bisa menyalakannya lagi kapan saja.",
      confirm: "Matikan layanan",
    },
    confirmAskAi: {
      title: "Matikan Tanya AI?",
      body: "Pengguna tidak bisa lagi bertanya ke AI sampai Anda menyalakannya lagi. Riwayat percakapan tidak hilang.",
      confirm: "Matikan Tanya AI",
    },
    cancel: "Batal",
  },

  toolsSheet: {
    title: "Kelola tool",
    description:
      "Tool yang dimatikan berhenti menjawab permintaan baru dari Tanya AI dan klien MCP.",
    kindRead: "Baca",
    kindWrite: "Tulis, butuh persetujuan",
    enabled: "Aktif",
    disabled: "Dimatikan",
    savedOn: "Tool dinyalakan.",
    savedOff: "Tool dimatikan.",
    emptyTitle: "Belum ada tool",
    emptyHint: "Daftar tool muncul di sini setelah katalog tool tersedia.",
    errorTitle: "Daftar tool belum bisa dimuat",
    errorHint: "Coba lagi. Pengaturan lain tidak terpengaruh.",
    count: "{enabled} dari {total} tool aktif",
  },

  clients: {
    title: "Klien MCP",
    description: "Klien yang telah disetujui untuk tenant ini",
    manage: "Kelola klien",
    columnClient: "Klien",
    columnScopes: "Cakupan",
    columnStatus: "Status",
    columnActions: "Aksi",
    tokensCount: "{count} token pengguna",
    tokensNone: "Belum ada token pengguna",
    tokensUnknown: "Jumlah token belum bisa dimuat",
    lastUsedToday: "Terakhir hari ini, {time}",
    lastUsedYesterday: "Terakhir kemarin, {time}",
    lastUsedOn: "Terakhir {date}",
    neverUsed: "Belum pernah dipakai",
    statusApproved: "Aktif",
    statusPending: "Menunggu persetujuan",
    statusRevoked: "Dicabut",
    revokeAction: "Cabut semua token",
    revokeActionFor: "Cabut semua token {client}",
    approveAction: "Setujui klien",
    approveActionFor: "Setujui klien {client}",
    footnote: "Token diterbitkan per pengguna dan klien.",
    emptyTitle: "Belum ada klien MCP",
    emptyHint:
      "Klien muncul di sini setelah didaftarkan atau mendaftar sendiri dan menunggu persetujuan Anda.",
    errorTitle: "Daftar klien belum bisa dimuat",
    errorHint: "Coba lagi. Pengaturan lain tidak terpengaruh.",
    sheetTitle: "Semua klien MCP",
    sheetDescription:
      "Klien yang aktif, menunggu persetujuan, dan sudah dicabut.",
    revokedOn: "Dicabut {date}",
    scopeDraft: "{scope} (draf)",
    scopeMore: "+{count} lainnya",
  },

  scopeDomain: {
    sales: "penjualan",
    menu: "menu",
    inventory: "stok",
    food_cost: "food cost",
    labor: "tenaga kerja",
    finance: "keuangan",
    customers: "pelanggan",
    schedule: "jadwal",
    payslip: "slip gaji",
    profit_share: "bagi hasil",
    sop: "SOP",
    anomalies: "anomali",
    actions: "status aksi",
    facility: "fasilitas",
    purchasing: "pembelian",
    promotion: "promosi",
    pricing: "harga",
  },

  approve: {
    title: "Setujui klien {client}?",
    description:
      "Pilih akses yang diberikan. Anda boleh mempersempit akses yang diminta klien.",
    scopesLabel: "Akses yang diberikan",
    redirectLabel: "Alamat balik klien",
    scopesError: "Pilih minimal satu akses.",
    confirm: "Setujui klien",
    cancel: "Batal",
    saved: "Klien disetujui.",
    error:
      "Klien belum disetujui. Coba lagi. Jika tetap gagal, muat ulang halaman.",
  },

  revoke: {
    title: "Cabut semua token klien?",
    body: "Semua **{tokens} token pengguna** untuk klien **{client}** akan dicabut.",
    bodyNoTokens:
      "Klien **{client}** tidak punya token aktif saat ini. Klien ini tidak akan bisa menyambung lagi.",
    bodyUnknown:
      "Semua token pengguna untuk klien **{client}** akan dicabut. Jumlahnya belum bisa dimuat.",
    users:
      "**{users} pengguna** yang memakai klien ini harus menyetujui akses lagi untuk terhubung.",
    usersUnknown:
      "Jumlah pengguna belum bisa dimuat. Semua pengguna klien ini harus menyetujui akses lagi untuk terhubung.",
    allSessions:
      "Semua sesi aplikasi ini berakhir, bukan hanya satu pengguna. Riwayat audit tetap tersedia.",
    reasonLabel: "Alasan pencabutan",
    reasonHint: "Alasan ini tercatat di log audit.",
    reasonPlaceholder: "Contoh: klien tidak lagi dipakai",
    reasonError: "Tulis alasan pencabutan, minimal 3 karakter.",
    cancel: "Batal",
    confirm: "Cabut {tokens} token",
    confirmNoTokens: "Cabut klien",
    error:
      "Token belum berhasil dicabut. Coba lagi. Jika tetap gagal, muat ulang halaman.",
    errorOffline:
      "Token belum dicabut karena tidak ada koneksi. Periksa internet Anda, lalu coba lagi.",
    doneTitle: "Token klien dicabut",
    done: "Pencabutan **berlaku dalam {minutes} menit**. Setelah itu semua sesi **{client}** berakhir dan setiap pengguna harus menyetujui akses lagi.",
    close: "Selesai",
  },

  quota: {
    title: "Kuota & plafon",
    description: "Pemakaian tenant bulan ini",
    edit: "Ubah",
    capLabel: "Plafon bulanan",
    used: "{amount} terpakai",
    meterLabel: "Pemakaian plafon bulanan",
    warnTitle: "Mendekati plafon",
    warnBody:
      "Peringatan mulai {warn}%; permintaan berhenti saat mencapai {stop}%.",
    stoppedTitle: "Plafon tercapai",
    stoppedBody:
      "Permintaan AI baru dihentikan. Naikkan plafon lewat tombol Ubah, atau tunggu bulan depan.",
    noCapTitle: "Plafon belum diisi",
    noCapBody:
      "AI tidak berjalan sebelum plafon bulanan diisi. Isi lewat tombol Ubah.",
    usageUnknown: "Pemakaian bulan ini belum bisa dimuat. Coba lagi nanti.",
    dailyTitle: "Kuota harian per pengguna",
    dailyEmployee: "Karyawan",
    dailyManagement: "Manajemen & owner",
    dailyValue: "{count} permintaan",
    dailyRange: "{min}–{max} permintaan",
    errorTitle: "Kuota dan plafon belum bisa dimuat",
    errorHint: "Coba lagi. Pengaturan lain tidak terpengaruh.",
  },

  caps: {
    title: "Ubah plafon dan batas",
    description:
      "Plafon membatasi biaya AI per bulan. Menaikkan plafon menambah biaya AI yang bisa terpakai.",
    budget: "Plafon bulanan (Rp)",
    budgetHint: "Isi 0 untuk menghentikan AI sampai plafon diisi.",
    budgetError: "Isi plafon dengan angka bulat, 0 atau lebih.",
    warn: "Peringatan mulai di (%)",
    stop: "Permintaan berhenti di (%)",
    percentError: "Isi angka bulat dari 1 sampai 100.",
    orderError:
      "Persentase peringatan harus lebih kecil dari persentase berhenti.",
    rate: "Batas permintaan MCP per menit",
    rateError: "Isi angka bulat dari 1 sampai {max}.",
    rows: "Batas baris per jawaban",
    rowsError: "Isi angka bulat dari 1 sampai {max}.",
    save: "Simpan",
    cancel: "Batal",
    saved: "Plafon dan batas disimpan.",
    error:
      "Perubahan belum tersimpan. Periksa isian yang bertanda merah, lalu coba lagi.",
  },
} as const;
