// EDC settlement CSV upload screen (X2-UI, bead legend-wasr7.18). Mounted as
// `edcSettlementCsv` by messages/id.ts. Amounts are never typed here: the
// screen shows counts the server returns.
export const edcSettlementCsvMessages = {
  entryLink: "Unggah file settlement bank",
  breadcrumbLabel: "Jejak halaman",
  breadcrumbPayments: "Pembayaran",
  breadcrumbEdc: "EDC",
  breadcrumbCurrent: "Unggah settlement",
  eyebrow: "Pemeriksaan pembayaran",
  title: "Unggah file settlement EDC",
  subtitle:
    "Cocokkan laporan settlement bank dengan penjualan EDC per terminal. Angka dan status pembayaran tidak berubah.",
  accessBand:
    "Mengunggah memerlukan izin rekonsiliasi di outlet dan verifikasi MFA. Nomor kartu pada berkas tidak dibaca dan tidak disimpan.",
  form: {
    label: "Unggah berkas settlement",
    outlet: "Outlet",
    bank: "Bank",
    file: "Berkas CSV",
    fileHint:
      "Ekspor laporan settlement dari portal bank, format .csv, hingga 90.000 karakter.",
    fileChosen: "{name} · {count} baris data",
    submit: "Unggah dan cocokkan",
    submitting: "Mencocokkan…",
    another: "Unggah berkas lain",
  },
  bank: {
    bca: "BCA",
    mandiri: "Mandiri",
    bni: "BNI",
    bjb: "BJB",
  },
  noOutlets: {
    title: "Belum ada outlet",
    description: "Tambahkan outlet lebih dulu, lalu unggah berkas settlement.",
  },
  loadError: {
    title: "Daftar outlet tidak bisa dimuat",
    description: "Periksa koneksi, lalu coba lagi.",
  },
  checks: {
    empty: "Berkas kosong. Pilih laporan settlement yang berisi transaksi.",
    tooLarge:
      "Berkas terlalu besar (maksimal 90.000 karakter). Pecah per tanggal, lalu unggah satu per satu.",
    notCsv: "Hanya berkas .csv atau .txt dari bank yang dapat diunggah.",
    unreadable: "Berkas tidak bisa dibaca. Pilih ulang berkasnya.",
  },
  errors: {
    rowsTitle: "Berkas belum diimpor",
    rows: "Baris berikut tidak dapat dibaca (TID, RRN atau nominal tidak valid). Tidak ada baris yang diimpor; perbaiki berkas lalu unggah ulang.",
    row: "Baris {row}",
    reasonUnreadable: "TID, RRN atau nominal tidak terbaca",
    reasonOther: "Baris tidak dapat dibaca",
    moreRows:
      "Baris lain mungkin ikut bermasalah; periksa setelah memperbaiki.",
    messageTitle: "Berkas belum bisa diimpor",
    message: "{detail}",
    forbidden:
      "Akun ini tidak punya izin rekonsiliasi di outlet tersebut. Minta pemilik memberi izin, lalu coba lagi.",
    notFound:
      "Outlet tidak ditemukan atau di luar akses akun ini. Pilih outlet lain.",
    offline: "Tidak ada koneksi. Sambungkan internet, lalu unggah lagi.",
    generic: "Unggahan gagal. Berkas tidak diimpor; coba lagi sebentar lagi.",
  },
  verify: {
    title: "Verifikasi MFA untuk mengunggah",
    mfaHint:
      "Mengunggah menghapus tanda perlu dicek, jadi perlu kode dari aplikasi autentikator.",
  },
  result: {
    title: "Hasil pencocokan",
    file: "{name} · {bank} · {count} baris",
    summaryLabel: "Ringkasan hasil pencocokan",
    matched: "Cocok dengan penjualan",
    clearedOf: "{count} di antaranya: tanda perlu dicek dihapus",
    mismatch: "Beda nominal atau terminal",
    unmatched: "Tidak ada penjualan",
    duplicate: "Sudah pernah masuk",
    replayed:
      "Berkas ini sudah pernah diunggah. Tidak ada yang diubah, hasil di atas dari unggahan pertama.",
    mismatchHint:
      "Baris yang beda nominal atau terminal tidak menghapus tanda perlu dicek dan dilaporkan sebagai peringatan. Periksa di rekonsiliasi EDC.",
    unmatchedHint:
      "Baris tanpa penjualan di outlet ini dicatat saja. Pastikan outlet dan bank yang dipilih sesuai berkas.",
    toQueue: "Buka rekonsiliasi EDC",
  },
} as const;
