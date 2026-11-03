// WS-03 menu bulk import and printable menu (bead legend-b6r; PRD v1.7 §3 F8
// "Impor Massal, Menu Cetak Otomatis", §8 "Impor Massal" / "Menu Cetak
// Otomatis"). Own file so parallel menu beads never edit the same catalog
// lines; screens read `menuImport.*`.
export const menuImportMessages = {
  title: "Impor & cetak menu",
  subtitle:
    "Impor massal CSV/XLSX dengan pratinjau validasi per baris, dan menu cetak siap PDF.",
  import: {
    title: "Impor massal menu",
    description:
      "Unggah berkas CSV berisi kolom kategori, nama, deskripsi, tipe, harga, stasiun, course, label, dan alergen. Pratinjau memeriksa setiap baris sebelum ada data yang ditulis.",
    photoNote:
      "Baris yang valid disimpan sebagai draf. Template tidak memuat foto, sedangkan item wajib punya foto sebelum bisa diaktifkan (Q23), jadi item hasil impor tidak langsung tampil di menu tamu.",
    downloadTemplate: "Unduh template CSV",
    templateHint:
      "Template berisi satu baris contoh. Kolom label dan alergen dipisahkan titik koma (;).",
    uploadLabel: "Berkas impor menu",
    upload: "Pilih file CSV/XLSX",
    changeFile: "Ganti file",
    acceptHint:
      "Format yang diterima: CSV atau XLSX. File XLSX harus disimpan sebagai CSV lebih dulu.",
    selectedFile: "File terpilih: {name}",
    reading: "Membaca berkas…",
    fileErrorTitle: "Berkas belum bisa diproses",
    xlsxUnsupported:
      "File XLSX belum bisa dibaca langsung. Buka di Excel atau Google Sheets, pilih Simpan sebagai / Unduh sebagai CSV, lalu unggah file CSV tersebut.",
    unsupportedType:
      "Format berkas tidak dikenal. Pilih berkas .csv, atau simpan .xlsx sebagai CSV lebih dulu.",
    unreadable:
      "Berkas tidak bisa dibaca sebagai teks CSV. Simpan ulang sebagai CSV UTF-8 lalu coba lagi.",
    offline:
      "Anda sedang offline. Pratinjau tetap bisa dibaca, tetapi impor butuh koneksi.",
  },
  preview: {
    title: "Pratinjau validasi",
    description:
      "Setiap baris diperiksa terhadap template, kategori, stasiun, dan harga rupiah. Belum ada data yang ditulis sampai Anda menekan tombol impor.",
    summaryLabel: "Ringkasan pratinjau",
    total: "Total baris",
    valid: "Valid",
    invalid: "Tidak valid",
    counts: "{valid} valid, {invalid} tidak valid, dari {total} baris.",
    columns: {
      row: "Baris",
      status: "Status",
      item: "Item",
      category: "Kategori",
      type: "Tipe",
      price: "Harga",
      station: "Stasiun",
    },
    emptyValue: "—",
    commitTitle: "Simpan hasil impor",
    commitHint:
      "Hanya baris valid yang dibuat, dan semuanya sebagai draf. Harga setiap baris ditambahkan ke daftar harga dine-in outlet tanpa menghapus harga yang sudah ada.",
    commit: "Impor {count} baris",
    committing: "Mengimpor baris {current} dari {total}…",
    noValidRows:
      "Tidak ada baris valid untuk diimpor. Perbaiki kesalahan di atas, lalu unggah ulang berkas.",
    priceNote: "Harga masuk ke daftar harga {channel} yang berlaku {date}.",
    priceListMissing:
      "Daftar harga dine-in untuk outlet ini belum ada. Buat daftar harga lebih dulu agar harga impor ikut tersimpan.",
    goToPrices: "Buka halaman Harga",
    reset: "Batalkan berkas ini",
  },
  results: {
    title: "Hasil impor",
    summary:
      "{created} dari {total} baris dibuat sebagai draf, {failed} gagal.",
    columns: {
      row: "Baris",
      item: "Item",
      status: "Status",
      message: "Keterangan",
    },
    created: "Dibuat",
    failed: "Gagal",
    failedGeneric:
      "Baris gagal dibuat. Periksa kembali datanya lalu coba lagi.",
    priceFailed:
      "Item sudah dibuat sebagai draf, tetapi harga belum tersimpan: {message} Buka halaman Harga untuk mengisi harga.",
    priceFailedGeneric:
      "Harga belum tersimpan karena kesalahan jaringan atau server. Buka halaman Harga untuk mengisi harga item yang baru dibuat.",
    priceListMissing:
      "Item sudah dibuat sebagai draf, tetapi daftar harga dine-in tidak ditemukan. Buat daftar harga lalu isi harganya.",
    viewItems: "Lihat daftar item",
    importAnother: "Impor berkas lain",
  },
  print: {
    title: "Menu cetak",
    description:
      "Menu aktif per kategori dengan harga dine-in. Harga dan ketersediaan terbaru ikut saat Anda menekan Buat ulang.",
    sizeLabel: "Ukuran huruf",
    sizeNormal: "Normal",
    sizeLarge: "Besar",
    regenerate: "Buat ulang",
    generatedAt: "Dibuat {time}",
    generatedNever: "Belum dibuat ulang",
    action: "Cetak / Simpan PDF",
    actionHint:
      "Tombol ini membuka dialog cetak browser; pilih Simpan sebagai PDF di sana. Tidak ada PDF yang dibuat di server.",
    sheetTitle: "Menu",
    priceListContext: "Daftar harga {channel} · berlaku {date}",
    emptyTitle: "Belum ada item aktif",
    emptyHint:
      "Aktifkan item beserta fotonya di Daftar item, lalu tekan Buat ulang untuk menyiapkan menu cetak.",
    noPrice: "Harga belum diisi",
    loading: "Menyiapkan menu cetak…",
    offline:
      "Anda sedang offline. Menu yang sudah dimuat tetap bisa dicetak; Buat ulang butuh koneksi.",
  },
  fields: {
    category: "Kategori",
    name: "Nama",
    description: "Deskripsi",
    type: "Tipe",
    priceIdr: "Harga",
    station: "Stasiun",
    course: "Course",
    labels: "Label",
    allergens: "Alergen",
  },
  errors: {
    required: "{field} wajib diisi.",
    tooLong: "{field} maksimal {max} karakter.",
    invalidType: "Tipe harus single atau combo (Item tunggal atau Paket).",
    invalidPrice:
      "Harga harus bilangan bulat rupiah tanpa tanda baca, misalnya 25000.",
    priceTooLarge: "Harga melebihi batas aman rupiah.",
    tooManyLabels: "Label maksimal {max}.",
    tooManyAllergens: "Alergen maksimal {max}.",
    unknownCategory:
      'Kategori "{value}" tidak ditemukan. Gunakan nama kategori yang sudah terdaftar.',
    unknownStation:
      'Stasiun "{value}" tidak ditemukan. Gunakan nama stasiun yang sudah terdaftar.',
    missingColumns:
      "Kolom wajib tidak ditemukan: {columns}. Unduh template untuk memastikan nama kolom.",
    duplicateColumns:
      "Kolom muncul lebih dari sekali: {columns}. Sisakan satu kolom untuk setiap nama.",
    emptyFile:
      "Berkas tidak berisi baris data. Tambahkan minimal satu baris di bawah header.",
    unterminatedQuote:
      "Ada tanda kutip yang tidak ditutup. Periksa kembali sel yang memakai tanda kutip.",
  },
};
