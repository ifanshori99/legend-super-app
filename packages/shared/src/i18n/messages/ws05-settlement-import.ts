// Duitku settlement import screen and the settlement list of the
// reconciliation panel (C4b, bead legend-osqou.8). Mounted as
// `gatewaySettlement` by messages/id.ts. The screen types no amount: every
// rupiah it shows comes from the server's answer.
export const gatewaySettlementMessages = {
  entryLink: "Impor settlement Duitku",
  breadcrumbLabel: "Jejak halaman",
  breadcrumbPayments: "Pembayaran",
  breadcrumbReconciliation: "Rekonsiliasi",
  breadcrumbCurrent: "Impor settlement Duitku",
  eyebrow: "Pemeriksaan pembayaran",
  title: "Impor settlement Duitku",
  subtitle:
    "Cocokkan laporan settlement Duitku dengan pembayaran online di outlet. Setiap selisih menjadi kasus rekonsiliasi; tidak ada pembayaran, refund, atau jurnal yang dibuat.",
  accessBand:
    "Mengimpor memerlukan izin rekonsiliasi di outlet dan verifikasi MFA. Semua nominal dibaca dan dijumlahkan server dari berkas.",
  form: {
    label: "Impor laporan settlement",
    outlet: "Outlet",
    reference: "Nomor laporan settlement",
    referenceHint: "Nomor laporan dari dasbor Duitku, misalnya STL-20261101.",
    referenceRequired: "Isi nomor laporan settlement.",
    periodStart: "Periode mulai",
    periodEnd: "Periode selesai",
    periodRequired: "Isi tanggal periode.",
    periodOrder: "Periode selesai tidak boleh sebelum periode mulai.",
    periodTooLong: "Satu laporan paling lama 31 hari.",
    file: "Berkas CSV",
    fileHint:
      "Pakai template Legend: kolom reference, amount_idr, fee_idr. Berkas .csv atau .txt, hingga 90 kB.",
    fileChosen: "{name} · {count} baris data",
    template: "Unduh template",
    submit: "Impor dan cocokkan",
    submitting: "Mencocokkan…",
    needsFile: "Pilih berkas CSV dulu untuk mengimpor.",
    another: "Impor laporan lain",
  },
  checks: {
    empty: "Berkas kosong. Pilih laporan yang berisi transaksi.",
    tooLarge:
      "Berkas terlalu besar (maksimal 90 kB). Pecah per tanggal, lalu impor satu per satu.",
    notCsv: "Hanya berkas .csv atau .txt yang dapat diimpor.",
    unreadable: "Berkas tidak bisa dibaca. Pilih ulang berkasnya.",
  },
  noOutlets: {
    title: "Belum ada outlet",
    description:
      "Akun ini belum punya outlet. Minta pemilik memberi akses outlet, lalu impor laporan.",
  },
  errors: {
    rowsTitle: "Berkas belum diimpor",
    rows: "Baris berikut tidak dapat dibaca. Tidak ada baris yang diimpor; perbaiki berkas lalu impor ulang.",
    row: "Baris {row}",
    reason: {
      columns: "Jumlah kolom tidak sesuai template",
      reference: "Kolom reference kosong atau terlalu panjang",
      amount: "amount_idr harus angka rupiah utuh tanpa titik atau koma",
      fee: "fee_idr harus angka rupiah utuh, tidak melebihi amount_idr",
      duplicate: "reference sudah muncul di baris lain",
      other: "Baris tidak dapat dibaca",
    },
    moreRows:
      "Baris lain mungkin ikut bermasalah; periksa setelah memperbaiki.",
    invalid:
      "Berkas belum bisa diimpor: isinya tidak sesuai template Legend. Pastikan baris pertama berisi reference, amount_idr, fee_idr dan ada baris transaksi, lalu impor ulang.",
    conflict:
      "Nomor laporan ini sudah pernah diimpor dengan isi berbeda. Periksa nomor laporan atau berkasnya.",
    forbidden:
      "Akun ini tidak punya izin rekonsiliasi di outlet tersebut. Minta pemilik memberi izin, lalu coba lagi.",
    notFound:
      "Outlet tidak ditemukan atau di luar akses akun ini. Pilih outlet lain.",
    session: "Sesi habis. Masuk ulang, lalu impor lagi.",
    rateLimited: "Terlalu sering mencoba. Tunggu sebentar, lalu impor lagi.",
    rateLimitedSeconds:
      "Terlalu sering mencoba. Tunggu {seconds} detik, lalu impor lagi.",
    offline: "Tidak ada koneksi. Sambungkan internet, lalu impor lagi.",
    generic: "Impor gagal. Berkas tidak diimpor; coba lagi sebentar lagi.",
  },
  verify: {
    title: "Verifikasi MFA untuk mengimpor",
    mfaHint:
      "Impor settlement membuka dan menutup kasus selisih uang, jadi perlu kode dari aplikasi autentikator.",
    again:
      "Server masih meminta verifikasi. Masukkan kode terbaru dari aplikasi autentikator.",
  },
  result: {
    title: "Hasil pencocokan",
    report: "{reference} · {period} · {count} baris",
    summaryLabel: "Ringkasan hasil pencocokan",
    totalsLabel: "Total laporan dari server",
    gross: "Nominal kotor",
    fee: "Biaya MDR",
    net: "Diterima bersih",
    matched: "Cocok",
    mismatch: "Tidak cocok",
    unmatched: "Tidak ada pembayaran",
    cases: "Kasus dibuat",
    replayed:
      "Sudah ada: laporan ini pernah diimpor dengan isi yang sama. Tidak ada yang diubah, hasil di atas dari impor pertama.",
    casesHint:
      "Baris yang tidak cocok dan pembayaran yang tidak ada di laporan menjadi kasus. Selesaikan di rekonsiliasi.",
    toReconciliation: "Buka rekonsiliasi",
  },
  list: {
    title: "Settlement terakhir",
    outletHint:
      "Untuk daftar settlement dan impor. Kasus terbuka mencakup semua outlet.",
    outletHintScoped: "Untuk kasus terbuka, daftar settlement, dan impor.",
    outletScoped:
      "Menampilkan outlet terpilih. Akun ini memegang izin rekonsiliasi per outlet.",
    emptyTitle: "Belum ada settlement diimpor",
    emptyHint:
      "Laporan settlement yang diimpor untuk outlet ini tampil di sini.",
    lines: "{count} baris",
    counts:
      "{matched} cocok · {mismatch} tidak cocok · {unmatched} tanpa pembayaran",
    net: "Bersih",
    gross: "Kotor",
    fee: "MDR",
    provider: {
      duitku: "Duitku",
      doit: "DOIT",
      edc: "EDC {bank}",
    },
  },
} as const;
