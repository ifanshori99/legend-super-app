// POS cashier texts for supervisor shift approval (bead legend-mjmm, S3; PRD v1.7
// §3 F8 "Shift & Tutup Hari"). Copy follows design/mockups/pos/supervisor.html;
// id.ts imports it as `posKasirSupervisor`.
export const posKasirSupervisorMessages = {
  title: "Persetujuan tutup shift",
  subtitle: "Shift {shiftNo} · {cashier} · {terminal} · {date}",
  access: "Akses supervisor",
  back: "Kembali",
  result: {
    title: "Hasil hitung kas",
    locked: "Terkunci",
    countedLine: "Kas dihitung: {amount}",
    short: "Kas kurang",
    over: "Kas lebih",
    even: "Kas sesuai",
    systemOnlyHint:
      "Angka sistem hanya tersedia untuk supervisor setelah kasir mengirim hitungan.",
  },
  breakdown: {
    openingFloat: "Modal awal",
    cashSales: "Penerimaan tunai",
    cashRefunds: "Refund tunai",
    cashIn: "Kas masuk",
    cashOut: "Kas keluar",
    cashDrop: "Setoran kas",
    expected: "Kas sistem",
  },
  review: {
    title: "Tinjau & setujui",
    varianceLabel: "Penjelasan selisih",
    noteLabel: "Catatan persetujuan",
    required: "Wajib",
    reasonRequired: "Penjelasan wajib diisi, minimal 4 karakter.",
    supervisorLabel: "Supervisor",
    pinLabel: "PIN supervisor",
    pinInvalid: "PIN terdiri dari 6 angka.",
    lockTitle: "Persetujuan mengunci hasil",
    lockBody:
      "Hitungan, selisih, alasan, dan supervisor tercatat. Hasil tidak dapat diubah setelah disetujui.",
    afterClose:
      "Setelah ditutup, laporan shift dapat dicetak dan disinkronkan ke akuntansi.",
    submit: "Setujui & tutup shift",
    submitting: "Memproses…",
    failedTitle: "Persetujuan belum berhasil",
    failedHint: "Periksa isian, lalu coba lagi.",
    countStale:
      "Ada transaksi tunai setelah kasir menghitung kas, jadi hitungan ini sudah tidak akurat. Minta kasir menghitung ulang dulu. Setelah itu, muat hitungan terbaru.",
    countSuperseded:
      "Kasir sudah mengirim hitungan yang lebih baru. Muat hitungan terbaru, periksa angkanya, lalu setujui lagi.",
    alreadyClosed:
      "Shift ini sudah ditutup. Muat ulang untuk melihat hasil yang tersimpan.",
    countMissingTitle: "Hitungan kas belum ada",
    countMissing: "Kasir belum mengirim hitungan kas",
    countMissingHint:
      "Persetujuan baru bisa dilakukan setelah kasir mengirim hitungan. Muat ulang setelah kasir selesai menghitung.",
    reload: "Muat hitungan terbaru",
    reloadPlain: "Muat ulang",
    reloading: "Memuat…",
    reloadedNew:
      "Hitungan terbaru sudah dimuat. Periksa angkanya sebelum menyetujui.",
    reloadedSame: "Belum ada hitungan yang lebih baru dari kasir.",
  },
  closed: {
    pill: "Shift ditutup",
    title: "Shift sudah ditutup",
    body: "Hasil hitung kas terkunci dan tidak dapat diubah. Disetujui oleh {approver}.",
    noteLabel: "Penjelasan selisih",
    noNote: "Tidak ada selisih.",
  },
  state: {
    loadingLabel: "Memuat hasil hitung kas",
    notReadyTitle: "Kasir belum mengirim hitungan",
    notReadyHint:
      "Persetujuan baru bisa dilakukan setelah kasir menghitung kas dan mengirimkannya. Coba lagi nanti.",
    notFoundTitle: "Shift tidak ditemukan",
    notFoundHint:
      "Tautan ini tidak cocok dengan shift mana pun. Kembali dan buka shift dari daftar.",
    pendingTitle: "Fitur ini belum tersambung ke server",
    pendingHint:
      "Persetujuan tutup shift belum tersedia di server ini. Hubungi tim teknis.",
    errorTitle: "Hasil hitung kas tidak bisa dimuat",
    errorHint: "Periksa koneksi, lalu coba lagi.",
    supervisorsErrorTitle: "Daftar supervisor tidak bisa dimuat",
    supervisorsErrorHint: "Periksa koneksi, lalu coba lagi.",
    noSupervisorTitle: "Belum ada supervisor yang bisa menyetujui",
    noSupervisorHint:
      "Minta manajer outlet menambahkan akses supervisor, lalu muat ulang halaman ini.",
  },
};
