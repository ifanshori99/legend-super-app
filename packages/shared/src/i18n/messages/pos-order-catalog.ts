// POS cashier menu catalog and modifier dialog (sub-539-u1, C1). id.ts imports it as `posOrderCatalog`.
export const posOrderCatalogMessages = {
  search: {
    label: "Cari menu",
    placeholder: "Cari nama menu atau pindai kode",
    resultCount: "{count} menu ditemukan",
  },
  categories: {
    label: "Kategori menu",
    all: "Semua menu",
    scrollHint: "Geser kategori →",
  },
  card: {
    soldOut: "Stok habis",
    add: "Tambah {name}, {price}",
  },
  loading: "Memuat menu…",
  offline: {
    title: "Offline · Katalog belum diperbarui sejak {time}",
    titleUnknown: "Offline · Katalog tersimpan sedang dipakai",
    body: "Penjualan tetap bisa dilanjutkan menggunakan katalog tersimpan.",
  },
  empty: {
    title: "Belum ada menu",
    description:
      "Menu yang tersedia di outlet ini akan muncul di sini. Hubungi manajer outlet bila menu belum ada.",
  },
  noResults: {
    title: "Menu tidak ditemukan",
    description: "Periksa ejaan, atau pilih kategori lain.",
    clear: "Tampilkan semua menu",
  },
  error: {
    title: "Menu belum bisa dimuat",
    description: "Periksa koneksi terminal, lalu coba lagi.",
    pendingTitle: "Fitur ini belum tersambung ke server",
    pendingBody:
      "Katalog kasir belum bisa dipakai di outlet ini. Hubungi admin.",
    refreshFailed:
      "Menu belum bisa diperbarui. Menu terakhir tetap ditampilkan.",
  },
  scan: {
    notFound: "Kode {code} tidak ditemukan.",
    soldOut: "{name} stok habis.",
  },
  modifier: {
    description: "Pilih opsi dan tambahkan catatan untuk dapur.",
    required: "Wajib pilih satu",
    requiredMin: "Wajib pilih minimal {min}",
    optional: "Opsional",
    optionalMax: "Pilih sampai {max}",
    maxReached: "Maksimal {max} pilihan",
    missing: "Pilih {group} sebelum menambahkan.",
    variantGroup: "Varian",
    noteLabel: "Catatan untuk dapur",
    noteOptional: "(opsional)",
    notePlaceholder: "Contoh: tanpa bawang",
    cancel: "Batal",
    confirm: "Tambah ke keranjang",
  },
} as const;
