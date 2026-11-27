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
      "Pakai template Legend: kolom reference, amount_idr, fee_idr. Format .csv, hingga 90.000 karakter.",
    fileChosen: "{name} · {count} baris data",
    template: "Unduh template",
    submit: "Impor dan cocokkan",
    submitting: "Mencocokkan…",
    another: "Impor laporan lain",
  },
  checks: {
    empty: "Berkas kosong. Pilih laporan yang berisi transaksi.",
    tooLarge:
      "Berkas terlalu besar (maksimal 90.000 karakter). Pecah per tanggal, lalu impor satu per satu.",
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
    message: "Berkas belum bisa diimpor: {detail}",
    conflict:
      "Nomor laporan ini sudah pernah diimpor dengan isi berbeda. Periksa nomor laporan atau berkasnya.",
    forbidden:
      "Akun ini tidak punya izin rekonsiliasi di outlet tersebut. Minta pemilik memberi izin, lalu coba lagi.",
    notFound:
      "Outlet tidak ditemukan atau di luar akses akun ini. Pilih outlet lain.",
    offline: "Tidak ada koneksi. Sambungkan internet, lalu impor lagi.",
    generic: "Impor gagal. Berkas tidak diimpor; coba lagi sebentar lagi.",
  },
  verify: {
    title: "Verifikasi MFA untuk mengimpor",
    mfaHint:
      "Impor settlement membuka dan menutup kasus selisih uang, jadi perlu kode dari aplikasi autentikator.",
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
