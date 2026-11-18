// Tax recap & Coretax exports (bead legend-5fdy; PRD v1.7 §3 F19 "Pajak").
// Own file so the parallel WS-07 beads never edit the same catalog lines.
export const accountingTaxMessages = {
  title: "Rekap Pajak",
  subtitle:
    "Rekap PBJT, PPh 21, PPh 23, dan PPN masukan per periode, siap difinalkan dan diekspor untuk pelaporan.",
  period: {
    label: "Periode buku",
    previous: "Periode sebelumnya",
    next: "Periode berikutnya",
    hint: "Rekap mengikuti bulan buku badan usaha. Pilih bulan lain untuk melihat atau membuat rekapnya.",
  },
  types: {
    label: "Jenis pajak",
    pbjt: "PBJT",
    pph21: "PPh 21",
    pph23: "PPh 23",
    ppn: "PPN masukan",
    hints: {
      pbjt: "PBJT adalah pajak restoran daerah yang dipungut per outlet.",
      pph21: "PPh 21 berasal dari payroll karyawan pada periode ini.",
      pph23: "PPh 23 berasal dari jasa supplier yang dipotong saat pembayaran.",
      ppn: "PPN masukan hanya berlaku bila badan usaha berstatus PKP.",
    },
  },
  status: {
    draft: "Draf",
    final: "Final",
    exported: "Terekspor",
    none: "Belum dibuat",
  },
  summary: {
    label: "Ringkasan pajak periode ini",
    totalTax: "Total pajak terutang",
    finalCount: "Laporan final",
    openCount: "Belum final",
    typeCount: "{count} jenis pajak",
  },
  report: {
    title: "{type} · {period}",
    generated: "Dibuat {time}",
    linesTitle: "Rincian {type}",
    linesDescription:
      "Basis (DPP), tarif efektif, dan jumlah pajak per subjek. Angka diambil dari rekap yang tersimpan.",
    emptyTitle: "Belum ada rekap {type}",
    emptyHint: "Buat rekap periode ini dari transaksi yang sudah dibukukan.",
    noLinesTitle: "Rekap belum berisi baris",
    noLinesHint:
      "Belum ada transaksi yang masuk ke jenis pajak ini pada periode tersebut.",
    totalTax: "Total pajak",
    columns: {
      subject: "Subjek",
      taxId: "NPWP",
      base: "Basis (DPP)",
      rate: "Tarif efektif",
      amount: "Jumlah pajak",
      references: "Referensi",
    },
    subjectTypes: {
      outlet: "Outlet",
      employee: "Karyawan",
      supplier: "Supplier",
    },
    taxIdMissing: "Tidak ada",
    referenceCount: "{count} referensi",
    warningsLabel: "Peringatan",
  },
  history: {
    title: "Riwayat status",
    draft: "Draf dibuat",
    final: "Difinalkan",
    exported: "Diekspor",
    notRecorded: "Belum tercatat",
  },
  ppnGate: {
    title: "PPN masukan belum berlaku",
    description:
      "Badan usaha ini belum berstatus PKP, jadi PPN masukan tidak dapat direkap. Ubah status PKP badan usaha terlebih dahulu.",
    currentStatus: "Status PKP badan usaha: {status}",
    pkpNo: "Belum PKP",
    pkpYes: "PKP",
  },
  actions: {
    generate: "Buat rekap",
    finalize: "Finalkan",
    export: "Ekspor Coretax",
    exportAgain: "Ekspor ulang",
    manageOnly:
      "Membuat, memfinalkan, dan mengekspor rekap memerlukan izin kelola laporan pajak.",
  },
  generateDialog: {
    title: "Buat rekap {type}",
    description:
      "Rekap dibuat sebagai draf dari transaksi yang sudah dibukukan pada periode {period}.",
    typeLabel: "Jenis pajak",
    periodLabel: "Periode",
    entityLabel: "Badan usaha",
    note: "Angka rekap dihitung di server dari transaksi yang dibukukan. Draf dapat difinalkan setelah periode buku ditutup.",
    confirm: "Buat draf rekap",
  },
  finalizeDialog: {
    title: "Finalkan rekap {type}?",
    description:
      "Setelah final, angka rekap periode {period} terkunci dan tidak dapat dihitung ulang. Ekspor Coretax tersedia setelah rekap final.",
    confirm: "Finalkan rekap",
  },
  exportDialog: {
    title: "Berkas Coretax siap",
    description:
      "Ekspor {type} periode {period} selesai. Unduh berkas Coretax untuk diunggah ke DJP.",
    fileName: "Nama berkas",
    format: "Format",
    formatCoretaxXml: "Coretax XML",
    fileKey: "Kunci penyimpanan",
    rowCount: "Jumlah baris",
    rowCountValue: "{count} baris",
    expiresAt: "Tautan unduh berlaku sampai",
    downloadNote:
      "Berkas Coretax XML dibuat oleh server dari rekap final. CSV hanya salinan baris rekap untuk pemeriksaan, bukan berkas pelaporan.",
    downloadXml: "Unduh berkas Coretax",
    confirm: "Unduh CSV",
  },
  toasts: {
    generated: "Rekap pajak dibuat sebagai draf.",
    finalized: "Rekap pajak difinalkan. Angka terkunci.",
    exported: "Berkas ekspor Coretax disiapkan.",
    downloaded: "Rekap diunduh sebagai CSV.",
  },
  errors: {
    generic: "Rekap pajak tidak dapat diproses. Coba lagi.",
    invalidTransition:
      "Status rekap berubah. Muat ulang daftar lalu coba lagi.",
    periodNotClosed:
      "Periode buku ini belum ditutup, jadi rekap belum dapat difinalkan.",
    notApplicable: "Jenis pajak ini tidak berlaku untuk badan usaha ini.",
    superseded:
      "Laporan pajak ini sudah digantikan revisi yang lebih baru. Buka laporan yang berlaku untuk mengekspor.",
    stale:
      "Periode buku berubah sejak draf dibuat. Buat ulang draf laporan pajak.",
    correctionReasonRequired:
      "Isi alasan pembetulan untuk membuat revisi laporan pajak.",
    sourceUnavailable:
      "Sumber data untuk jenis pajak ini belum tersedia. Hubungi pengelola sebelum membuat rekap.",
    amountMismatch:
      "Jumlah laporan tidak sama dengan total pajak per baris. Periksa sumber data lalu buat ulang draf.",
    notFound:
      "Laporan pajak tidak ditemukan. Muat ulang daftar laporan lalu coba lagi.",
    noChange:
      "Tidak ada perubahan dari laporan pajak yang berlaku. Revisi baru tidak diperlukan.",
  },
  csv: {
    subjectType: "Tipe subjek",
    subjectName: "Subjek",
    taxId: "NPWP",
    base: "Basis (DPP)",
    tax: "Pajak",
    references: "Referensi",
    total: "Total pajak",
  },
};
