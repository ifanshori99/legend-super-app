// Layar input faktur supplier (bead legend-0xnm; PRD v1.7 §3.18, §4 Alur I
// step 4). Own file so parallel purchasing beads never edit the same catalog
// lines; the screen reads `inventoryInvoiceEntry.*`. PPN dan PPh 23 diketik
// persis seperti di faktur pajak supplier; layar tidak menghitung total.
export const inventoryInvoiceEntryMessages = {
  title: "Catat faktur supplier",
  subtitle:
    "Salin isi faktur supplier apa adanya. Total, selisih, dan jumlah yang harus dibayar dihitung server setelah faktur disimpan.",
  newInvoice: "Catat faktur",
  back: "Kembali ke daftar faktur",
  noOrders: "Belum ada PO yang bisa difakturkan",
  noOrdersHint:
    "Faktur dicatat terhadap PO yang barangnya sudah diterima. Catat penerimaan dulu.",
  goToReceiving: "Ke penerimaan barang",
  header: {
    order: "Purchase order",
    supplier: "Supplier",
    number: "Nomor faktur",
    invoiceDate: "Tanggal faktur",
    dueDate: "Jatuh tempo",
    dueHint:
      "Terisi dari termin pembayaran supplier; ubah bila faktur berbeda.",
  },
  lines: {
    title: "Isi faktur",
    count: "{count} baris",
    reference: "Acuan dari PO dan penerimaan",
    ordered: "Dipesan",
    accepted: "Diterima baik",
    poPrice: "Harga PO",
    poPriceValue: "Rp {value}",
    include: "Masukkan ke faktur",
    exclude: "Baris ini tidak ada di faktur",
    description: "Uraian",
    quantity: "Jumlah ditagih",
    unitPrice: "Harga satuan faktur (Rp)",
    unitPriceHint: "Tulis angka seperti di faktur, mis. 12500 atau 12500,50.",
    serviceTitle: "Jasa",
    addService: "Tambah baris jasa",
    removeService: "Hapus baris jasa",
    serviceHint:
      "Baris jasa (mis. ongkos kirim, instalasi) tidak punya penerimaan barang; server membandingkannya sebagai jumlah.",
  },
  tax: {
    title: "Pajak sesuai faktur pajak supplier",
    hint: "Ketik angka persis seperti yang tercetak. Aplikasi tidak menghitung pajak.",
    ppn: "PPN masukan (Rp)",
    ppnHint: "Server menolak PPN di atas 12% dari nilai barang dan jasa.",
    pph23: "PPh 23 (Rp)",
    pph23Hint: "Isi hanya bila faktur memuat baris jasa; kosong berarti 0.",
  },
  summary: {
    title: "Yang akan disimpan",
    lines: "{count} baris dipilih",
    note: "Total dan jumlah yang harus dibayar muncul di pratinjau setelah faktur disimpan.",
  },
  submit: "Simpan faktur",
  created: "Faktur tersimpan.",
  next: {
    title: "Faktur tersimpan sebagai menunggu match",
    description:
      "Faktur belum dibayar. Catat hasil match di daftar faktur sebelum meminta pembayaran.",
    toList: "Lihat daftar faktur",
    another: "Catat faktur lain",
  },
  errors: {
    required: "Wajib diisi.",
    numberRequired: "Nomor faktur wajib diisi.",
    invalidQuantity: "Isi qty angka lebih dari 0, maksimal 4 desimal.",
    invalidPrice: "Isi harga angka 0 atau lebih, maksimal 4 desimal.",
    invalidAmount: "Isi angka rupiah bulat, tanpa desimal.",
    dueBeforeInvoice: "Jatuh tempo tidak boleh sebelum tanggal faktur.",
    noLines: "Pilih minimal satu baris untuk faktur.",
    invalid: "Isian belum valid. Periksa kolom yang ditandai.",
    summary: "Faktur belum bisa disimpan. Periksa kolom yang ditandai.",
    serverRejected:
      "Server menolak faktur ini. Periksa nilai pajak: PPN maksimal 12% dari nilai barang dan jasa, dan PPh 23 hanya untuk baris jasa.",
  },
} as const;
