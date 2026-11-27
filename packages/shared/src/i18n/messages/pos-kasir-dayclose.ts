// POS cashier texts for day close by the outlet manager (bead legend-mjmm, S4). Filled by its screen
// bead; id.ts imports it as `posKasirDayclose`.
export const posKasirDaycloseMessages = {
  title: "Tutup harian",
  subtitle: "Hari usaha {date} · {outlet} · batas hari usaha {cutoff}",
  subtitleNoOutlet: "Hari usaha {date} · batas hari usaha {cutoff}",
  access: "Akses outlet manager",
  back: "Kembali ke kasir",
  loading: "Memuat rekap hari usaha",
  empty: {
    title: "Belum ada penjualan hari ini",
    description:
      "Rekap muncul setelah ada transaksi pada hari usaha ini. Kembali ke kasir untuk mulai berjualan.",
  },
  error: {
    title: "Rekap hari usaha tidak bisa dimuat",
    description: "Periksa koneksi outlet, lalu coba lagi.",
    pending: "Fitur ini belum tersambung ke server.",
    pendingHint:
      "Tutup harian akan tersedia setelah server siap. Tidak ada data yang diubah.",
    retry: "Coba lagi",
  },
  channels: {
    title: "Rekap per kanal",
    totalLabel: "Total penjualan",
    totalHint: "Termasuk pajak & service",
    refund: "Refund",
    void: "Void",
    shiftsClosedTitle: "Semua shift ditutup",
    shiftsClosed: "{shifts} shift · {terminals} terminal",
    variance: "Selisih kas {amount} disetujui.",
    noVariance: "Tidak ada selisih kas.",
    blindNote:
      "Angka laci shift Anda disembunyikan. Manajer outlet yang meninjau.",
    shiftsOpenTitle: "Masih ada shift yang belum ditutup",
    shiftsOpen:
      "{open} dari {total} shift belum ditutup. Tutup semua shift sebelum tutup hari.",
  },
  net: {
    title: "Pembayaran bersih",
    subtitle: "Penerimaan dikurangi refund",
    total: "Total bersih",
    separate: "EDC dan kartu online dicatat terpisah.",
  },
  check: {
    title: "Periksa sebelum tutup",
    settlementTitle: "Settlement EDC",
    settlementTerminal: "{terminal} · {bank}",
    settlementReceipt: "Struk",
    settlementBankLabel: "Bank",
    settlementDifference: "Selisih",
    settlementWaiting: "Menunggu file bank",
    settlementWaitingHint:
      "File settlement bank belum masuk untuk terminal ini. Angka bank dan selisih muncul setelah file diunggah.",
    settlementStateSettled: "Cocok dengan bank",
    settlementStatePartial: "Sebagian belum cocok",
    settlementStateMismatch: "Ada selisih dengan bank",
    settlementStateNoMatch: "Tidak ada yang cocok",
    settlementNoMatchHint:
      "File bank sudah masuk, tetapi tidak ada transaksi terminal ini yang cocok. Periksa terminal dan nominal di file, lalu unggah ulang bila perlu.",
    settlementMismatchLines:
      "{count} baris bank menyebut transaksi ini dengan nominal atau terminal berbeda.",
    settlementNone: "Tidak ada transaksi EDC untuk disettle.",
    settlementPending: "Settlement per bank belum tersedia dari server.",
    unmatched:
      "{count} transaksi EDC masih perlu dicek setelah file bank masuk. Periksa di rekonsiliasi EDC.",
    noUnmatched:
      "Tidak ada transaksi EDC yang masih perlu dicek setelah file bank.",
    unsyncedTitle: "Struk belum sinkron",
    unsyncedReceipts:
      "{count} nomor struk sudah terbit tetapi belum diterima server. Pastikan kasir yang bersangkutan online agar struknya terkirim sebelum hari ditutup.",
    stockHeading: "Pemotongan stok",
    stockLabel: "Terapkan stok akhir hari",
    stockHint: "Opsional, sesuai pengaturan outlet.",
    stockUnavailable: "Pemotongan stok tidak aktif untuk outlet ini.",
    saveNote: "Rekap hari usaha akan disimpan dan dikirim ke akuntansi.",
    submit: "Settlement & tutup hari",
    submitting: "Menutup hari…",
    failTitle: "Hari usaha belum tertutup",
    failHint: "Rekap tidak berubah. Periksa kendala di atas, lalu coba lagi.",
    alreadyClosed: "Hari usaha ini sudah ditutup.",
  },
  closed: {
    title: "Hari usaha ditutup",
    subtitle: "{date} · {outlet}",
    subtitleNoOutlet: "{date}",
    saved: "Rekap tersimpan",
    successTitle: "Tutup harian berhasil",
    success:
      "Rekap {terminals} terminal dan {shifts} shift telah disimpan. Selisih kas {amount} beserta persetujuan tetap tercatat.",
    successBlind:
      "Rekap {terminals} terminal dan {shifts} shift telah disimpan.",
    successNoVariance:
      "Rekap {terminals} terminal dan {shifts} shift telah disimpan. Tidak ada selisih kas.",
    totalLabel: "Total penjualan",
    refund: "Refund",
    stock: "Pemotongan stok",
    stockApplied: "Diterapkan",
    stockNotApplied: "Tidak diterapkan",
    closedBy: "Ditutup {name} pukul {time}",
    accountingTitle: "Sinkronisasi akuntansi",
    accountingQueued: "Antrean",
    accountingSynced: "Tersinkron",
    accountingFailed: "Gagal",
    accountingQueuedBody:
      "Rekap tersimpan di outlet. Menunggu konfirmasi pencatatan dari akuntansi.",
    accountingQueuedHint: "Status akan diperbarui saat pencatatan selesai.",
    accountingSyncedBody: "Rekap sudah tercatat di akuntansi.",
    accountingSyncedHint: "Tidak ada tindakan lagi untuk rekap ini.",
    accountingFailedBody:
      "Rekap tersimpan di outlet, tetapi belum tercatat di akuntansi.",
    accountingFailedHint:
      "Sistem mengulang pengiriman. Hubungi admin bila status tidak berubah.",
    settlementTitle: "Settlement EDC",
    batchSuccess: "{bank}: batch berhasil",
    batchFailed: "{bank}: batch gagal",
    batchNone: "Tidak ada batch settlement.",
    reconcile:
      "{count} transaksi standalone tetap perlu rekonsiliasi. Batch berhasil belum berarti dana sudah cocok.",
    reconcileNone: "Batch berhasil belum berarti dana sudah cocok.",
    batchFailedNote:
      "Ada batch yang gagal. Settlement ulang dilakukan lewat rekonsiliasi.",
    print: "Cetak rekap harian",
  },
};
