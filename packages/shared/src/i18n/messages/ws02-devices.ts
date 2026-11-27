// Device registry text (PRD v1.7 §3 F5 "Registri Perangkat", "Mode Latihan";
// bead legend-q2c; acceptance EDG-03 UI): per-outlet device table, detail
// drawer, revoke confirmation and the per-device training mode switch. Own
// file so parallel WS-02 beads never edit the same lines in id.ts.
// Namespace: `deviceRegistry`.

export const deviceRegistryMessages = {
  nav: "Perangkat",
  title: "Registri perangkat",
  subtitle:
    "Daftar perangkat per outlet: jenis, detak terakhir, versi aplikasi, dan status. Cabut perangkat yang hilang atau tidak dipakai lagi.",
  sampleData: "Contoh data",
  tableTitle: "Perangkat terdaftar",
  tableHint: "Detak diperbarui otomatis tiap 15 detik.",

  summary: {
    label: "Ringkasan perangkat",
    total: "Terdaftar",
    online: "Aktif",
    attention: "Perlu perhatian",
    revoked: "Dicabut",
    attentionContext: "Detak terlambat atau terputus",
  },

  filters: {
    search: "Cari nama perangkat…",
    outlet: "Outlet",
    allOutlets: "Semua outlet",
    type: "Jenis",
    allTypes: "Semua jenis",
    status: "Status",
    allStatuses: "Semua status",
    outletHint:
      "Daftar dibaca dari edge node outlet ini; outlet lain tampil setelah node-nya terhubung.",
    outletFallback: "Outlet {code}",
    truncated:
      "Menampilkan {count} perangkat pertama. Persempit dengan filter untuk melihat sisanya.",
  },

  columns: {
    type: "Jenis",
    name: "Nama",
    outlet: "Outlet",
    heartbeat: "Detak terakhir",
    version: "Versi",
    status: "Status",
    training: "Latihan",
    actions: "Aksi",
  },

  type: {
    pos: "Kasir (POS)",
    kds: "KDS",
    waiter_phone: "Ponsel waiter",
    printer: "Printer",
    display: "Layar pickup",
    smart_lock: "Kunci pintar",
    panic_button: "Tombol panik",
    edc: "Mesin EDC",
  },

  heartbeat: {
    online: "Aktif",
    stale: "Terlambat",
    offline: "Terputus",
    never: "Belum pernah terhubung",
    revoked: "Dicabut",
    ageSeconds: "{count} dtk lalu",
    ageMinutes: "{count} mnt lalu",
    ageHours: "{count} jam lalu",
    ageDays: "{count} hari lalu",
    justNow: "Baru saja",
    noValue: "Belum ada detak",
    staleHint:
      "Detak lebih dari 15 detik lalu. Periksa jaringan outlet jika berlanjut.",
    offlineHint:
      "Tidak ada detak lebih dari 30 detik (EDG-05). Periksa daya dan jaringan perangkat.",
    neverHint: "Perangkat terdaftar tetapi belum pernah mengirim detak.",
    revokedHint: "Perangkat dicabut dan tidak bisa bertransaksi.",
  },

  status: {
    active: "Terdaftar",
    revoked: "Dicabut",
  },

  printAlerts: {
    printer_offline: {
      title: "Printer tidak terhubung",
      body: "Printer tidak terhubung. Periksa printer dan antrean cetak.",
    },
    job_failed: {
      title: "Cetak gagal",
      body: "Tugas cetak gagal atau macet. Periksa printer dan hasil cetak sebelum mencoba lagi.",
    },
    kds_down: {
      title: "Layar KDS tidak terhubung",
      body: "Layar KDS tidak terhubung. Periksa daya, jaringan, dan antrean cetak cadangan stasiun.",
    },
  },

  receiptPrintErrors: {
    agentUnavailable:
      "Agen cetak outlet belum siap. Coba lagi setelah perangkat terhubung.",
    wrongOutlet: "Struk hanya dapat dicetak pada edge node outlet asal.",
  },

  receiptPrintLabels: {
    voided: "DIBATALKAN",
    rounding: "Pembulatan",
    guestFee: "Biaya layanan pembayaran",
    paidTotal: "Total dibayar",
  },

  training: {
    on: "Latihan",
    off: "Normal",
    label: "Mode latihan untuk {name}",
    title: "Mode latihan",
    explainTitle: "Apa yang berubah di mode latihan",
    explainBody:
      "Perangkat dalam mode latihan memakai data sandbox: transaksinya tidak masuk laporan, stok, atau pembukuan. Setiap layar di perangkat itu menampilkan watermark LATIHAN agar tidak tertukar dengan penjualan nyata.",
    watermarkPoint: "Watermark LATIHAN tampil di semua layar perangkat.",
    reportsPoint: "Transaksi latihan tidak masuk laporan.",
    auditPoint: "Setiap perubahan tercatat di audit log.",
    saved: "Mode latihan disimpan.",
    saveFailed: "Mode latihan gagal disimpan. Coba lagi.",
    needsPermission:
      "Hanya peran dengan izin kelola perangkat yang dapat mengubah.",
    revokedLocked: "Perangkat yang dicabut tidak bisa diubah.",
    enableTitle: "Aktifkan mode latihan?",
    enableBody:
      "Penjualan di {name} tidak akan masuk laporan sampai mode ini dimatikan. Watermark LATIHAN tampil di perangkat itu.",
    enableConfirm: "Aktifkan",
    disableTitle: "Matikan mode latihan?",
    disableBody:
      "{name} kembali mencatat penjualan nyata dan watermark LATIHAN hilang.",
    disableConfirm: "Matikan",
  },

  detail: {
    title: "Detail perangkat",
    description: "Informasi perangkat dari registri outlet.",
    open: "Buka detail {name}",
    close: "Tutup detail",
    id: "ID perangkat",
    station: "Stasiun",
    noStation: "Tanpa stasiun",
    capabilities: "Kemampuan",
    noCapabilities: "Belum ada kemampuan dilaporkan",
    lastSeen: "Detak terakhir",
    revokedAt: "Dicabut pada",
    version: "Versi aplikasi",
    outlet: "Outlet",
    copyId: "Salin ID",
    idCopied: "ID perangkat disalin.",
  },

  revoke: {
    action: "Cabut perangkat",
    actionFor: "Cabut {name}",
    title: "Cabut perangkat ini?",
    description:
      "Perangkat yang dicabut langsung berhenti bertransaksi dan tidak bisa dipakai lagi. Untuk memakainya kembali, daftarkan sebagai perangkat baru.",
    warning:
      "Tindakan ini tidak bisa dibatalkan dari layar ini dan tercatat di audit log.",
    confirmLabel: "Ketik nama perangkat untuk melanjutkan",
    confirmHint: "Ketik persis: {name}",
    confirmMismatch: "Nama yang diketik belum sama dengan nama perangkat.",
    reasonLabel: "Alasan pencabutan",
    reasonHint: "Contoh: perangkat hilang, diganti unit baru.",
    reasonError: "Tulis alasan, minimal 3 karakter.",
    submit: "Cabut perangkat",
    done: "Perangkat dicabut.",
    needsPermission: "Anda tidak punya izin mencabut perangkat.",
    alreadyRevoked: "Perangkat ini sudah dicabut.",
  },

  empty: {
    title: "Belum ada perangkat terdaftar",
    hint: "Perangkat muncul di sini setelah didaftarkan ke edge node outlet. Daftarkan POS, KDS, atau printer pertama dari aplikasi perangkat.",
  },
  noEdge: {
    title: "Edge node tidak terjangkau",
    hint: "Registri dibaca dari edge node outlet. Pastikan Anda berada di jaringan outlet, lalu coba lagi.",
  },
  offline: {
    title: "Perangkat Anda sedang offline",
    hint: "Data di bawah bisa sudah tidak terbaru. Pencabutan dan mode latihan butuh koneksi.",
  },
  enroll: {
    action: "Daftarkan perangkat",
    title: "Daftarkan perangkat baru",
    description:
      "Perangkat baru mendapat token yang dipakai untuk masuk dari aplikasi perangkat.",
    outletLabel: "Outlet",
    outletPlaceholder: "Pilih outlet",
    outletError: "Pilih outlet untuk perangkat ini.",
    typeLabel: "Jenis perangkat",
    nameLabel: "Nama perangkat",
    nameHint: "Contoh: Kasir 1, Printer Dapur.",
    nameError: "Tulis nama perangkat, maksimal 255 karakter.",
    submit: "Daftarkan perangkat",
    noOutlets: "Belum ada outlet yang bisa dipilih.",
    done: "Perangkat terdaftar.",
  },
  token: {
    enrolledTitle: "Perangkat terdaftar",
    reissuedTitle: "Token baru diterbitkan",
    description: "Salin token ini ke aplikasi perangkat {name}.",
    warning: "Token hanya ditampilkan sekali",
    warningBody:
      "Setelah dialog ditutup, token tidak bisa dilihat lagi. Simpan sekarang di aplikasi perangkat.",
    reissueNote: "Token lama perangkat ini berhenti berlaku.",
    tokenLabel: "Token perangkat",
    copy: "Salin token",
    copied: "Token disalin",
    copyFailed: "Gagal menyalin. Pilih token lalu salin manual.",
    useHere: "Pakai di perangkat ini",
    usedHere: "Dipakai di perangkat ini",
    usedHereHint:
      "Token tersimpan di browser ini. Alarm panik dan notifikasi outlet memakai perangkat ini.",
    useHereFailed:
      "Token tidak bisa disimpan di browser ini. Salin token lalu simpan manual.",
    close: "Selesai, token sudah disimpan",
    reissueAction: "Terbitkan ulang token",
    reissueTitle: "Terbitkan ulang token?",
    reissueBody:
      "Token lama {name} langsung berhenti berlaku. Perangkat harus memakai token baru.",
    reissueConfirm: "Terbitkan token baru",
  },
  // Freshness of the edge's copy of this registry (legend-2lgu).
  staleNotice: {
    softTitle: "Data perangkat belum diperbarui sejak {time}",
    softNever: "Data perangkat belum pernah diperbarui dari cloud",
    softHint:
      "Edge memakai data perangkat terakhir yang tersimpan. Sambungkan edge ke cloud agar daftar perangkat terbaru terbaca.",
    hardTitle:
      "Edge menolak perangkat baru: data perangkat terlalu lama ({hours} jam)",
    hardHint:
      "Perangkat yang sedang aktif tetap berjalan. Sambungkan edge ke cloud, lalu coba lagi untuk perangkat baru.",
    rowLabel: "Data perangkat",
    rowFresh: "Terbaru",
    rowStale: "Belum diperbarui",
    rowHard: "Perangkat baru ditolak",
    rowPulled: "Terakhir diperbarui {time}",
    rowNever: "Belum pernah diperbarui dari cloud",
  },
  errors: {
    generic: "Tindakan gagal. Coba lagi.",
    forbidden: "Anda tidak punya izin untuk tindakan ini.",
    notFound: "Perangkat tidak ditemukan. Muat ulang daftar.",
    conflict: "Status perangkat sudah berubah. Muat ulang daftar.",
    offline: "Tidak ada koneksi. Periksa jaringan lalu coba lagi.",
  },
} as const;
