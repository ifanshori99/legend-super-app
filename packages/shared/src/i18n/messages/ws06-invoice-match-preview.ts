// Pratinjau 3-way match setelah faktur supplier disimpan (bead legend-0xnm).
// Own file so the invoice entry beads never edit the same catalog lines;
// screens read `invoiceMatchPreview.*`. Every amount shown comes from the API.
export const invoiceMatchPreviewMessages = {
  title: "Pratinjau 3-way match",
  description:
    "Hasil perbandingan PO, penerimaan, dan faktur yang baru disimpan. Semua angka dihitung server.",
  loadError: "Pratinjau match belum bisa dimuat. Faktur Anda sudah tersimpan.",
  pendingHint:
    "Faktur tersimpan, tetapi server belum menghitung match. Buka daftar faktur untuk menjalankan match.",
  toleranceHint:
    "Toleransi harga {percent} dari konfigurasi tenant. Qty faktur tidak boleh melebihi penerimaan yang lolos QC.",
  matchedHint: "Faktur cocok dengan PO dan penerimaan.",
  discrepancyHint:
    "Ada selisih pada faktur ini. Periksa baris bertanda sebelum faktur dibayar.",
  totalsTitle: "Angka dari server",
  rowsTitle: "Selisih per baris",
  rowTitle: "Baris {index}",
  noOrderLine: "Tanpa baris PO",
  serviceLine: "Jasa",
  orderedLabel: "Dipesan",
  acceptedLabel: "Diterima baik",
  invoicedLabel: "Ditagih",
  orderedPrice: "Harga PO",
  invoicedPrice: "Harga faktur",
  varianceLabel: "Selisih harga",
  rowOk: "Cocok",
  empty: "—",
} as const;
