// QR order journey texts, part: menu (scan, join, browse, item sheet).
// Bead legend-2m4 · PRD v1.7 §3 F10 "Scan & Sesi Meja", "Menu & Keranjang",
// "Rekomendasi (AI-01)". Placeholders use {name}.
export const qrMenuMessages = {
  tableContext: "Meja {table} · {guests} tamu",
  tableOnly: "Meja {table}",
  nav: {
    label: "Navigasi meja",
    menu: "Menu",
    cart: "Keranjang",
    orders: "Pesanan",
    bill: "Tagihan",
  },
  head: {
    title: "Menu {outlet}",
    notFoundTitle: "QR meja tidak dikenali",
  },
  search: {
    label: "Cari menu",
    placeholder: "Cari nama atau deskripsi menu",
    clear: "Hapus pencarian",
  },
  category: {
    navLabel: "Kategori menu",
    all: "Semua",
  },
  filter: {
    label: "Filter label",
    clear: "Hapus filter",
    results: "{count} menu ditemukan",
    pressedHint: "dipilih",
  },
  labels: {
    baru: "Baru",
    terlaris: "Terlaris",
    pedas: "Pedas",
    vegetarian: "Vegetarian",
  },
  pricing: {
    note: "Harga belum termasuk service charge {service}% dan pajak {tax}%. Total lengkap tampil di checkout.",
    noteNoTax:
      "Harga belum termasuk service charge {service}%. Total lengkap tampil di checkout.",
    minimumSpend: "Minimum belanja zona ini {amount}.",
  },
  mode: {
    payFirst: "Bayar di muka",
    payFirstHint: "Pesanan masuk dapur setelah pembayaran berhasil.",
    openBill: "Open bill",
    openBillHint: "Pesanan langsung masuk dapur, bayar di akhir.",
  },
  closedNow: {
    title: "Zona ini sedang di luar jam layanan",
    hint: "Anda masih bisa melihat menu. Pemesanan dibuka lagi sesuai jam operasional.",
  },
  section: {
    count: "{count} menu",
  },
  card: {
    add: "Tambah",
    addAria: "Tambah {name} ke keranjang",
    choose: "Pilih",
    chooseAria: "Pilih opsi untuk {name}",
    soldOut: "Habis",
    soldOutAria: "{name}, sedang habis",
    from: "Mulai",
    viewAria: "Lihat detail {name}",
    comboBadge: "Paket",
    allergens: "Alergen: {list}",
  },
  states: {
    emptyTitle: "Menu belum tersedia",
    emptyHint:
      "Pengelola belum menayangkan menu untuk meja ini. Panggil waiter untuk dibantu.",
    noResultsTitle: "Tidak ada menu yang cocok",
    noResultsHint: "Coba kata kunci lain atau hapus filter.",
    errorTitle: "Menu belum bisa dimuat",
    errorHint: "Periksa koneksi internet Anda, lalu coba lagi.",
    offlineTitle: "Tidak ada koneksi",
    offlineHint:
      "Menu butuh internet. Sambungkan kembali jaringan Anda, lalu muat ulang.",
    notFoundTitle: "QR meja tidak dikenali",
    notFoundHint:
      "Kode ini mungkin sudah diganti atau rusak. Scan ulang QR di meja Anda, atau minta bantuan waiter.",
    retry: "Muat ulang",
    loading: "Memuat menu…",
  },
  join: {
    title: "Selamat datang di {brand}",
    subtitle: "Meja {table} · {zone}",
    paxLabel: "Berapa tamu di meja ini?",
    paxHint:
      "Untuk membuka sesi meja. Tamu lain di meja yang sama tinggal scan QR yang sama.",
    paxDecrease: "Kurangi jumlah tamu",
    paxIncrease: "Tambah jumlah tamu",
    paxValue: "{count} tamu",
    start: "Mulai pesan",
    later: "Lihat menu dulu",
    error: "Belum bisa membuka sesi meja. Periksa koneksi, lalu coba lagi.",
    closedHint:
      "Zona ini sedang di luar jam layanan. Anda bisa melihat menu, tetapi belum bisa memesan.",
  },
  session: {
    pendingTitle: "Menunggu konfirmasi waiter",
    pendingHint:
      "Waiter akan mengonfirmasi meja ini sebelum pesanan pertama masuk dapur. Anda tetap bisa memilih menu.",
    endedTitle: "Sesi meja sudah berakhir",
    endedHint:
      "Tagihan meja ini sudah selesai atau sesinya ditutup. Buka sesi baru untuk memesan lagi.",
    startOver: "Buka sesi baru",
    joinedOpened: "Sesi meja dibuka untuk {count} tamu.",
    joinedExisting: "Anda bergabung ke sesi meja yang sedang berjalan.",
  },
  suggestions: {
    title: "Disarankan untuk Anda",
    hint: "Dari menu yang bisa dipesan sekarang.",
    pairing: "Pasangan menu",
    upgrade: "Upgrade",
    add: "Tambah",
  },
  sheet: {
    description: "Detail menu, pilihan, dan jumlah",
    allergens: "Alergen: {list}",
    variantTitle: "Pilih varian",
    required: "Wajib",
    optional: "Opsional",
    chooseOne: "Pilih 1",
    chooseRange: "Pilih {min}–{max}",
    chooseUpTo: "Pilih sampai {max}",
    modifierSoldOut: "Habis",
    noteLabel: "Catatan untuk dapur",
    notePlaceholder: "Contoh: tanpa es, saus dipisah",
    noteHint: "Maksimal {max} karakter.",
    quantity: "Jumlah",
    decrease: "Kurangi jumlah",
    increase: "Tambah jumlah",
    submit: "Tambah ke keranjang",
    soldOutNotice: "Menu ini sedang habis dan belum bisa dipesan.",
    soldOutAction: "Habis",
    priceExcludes: "Belum termasuk pajak dan service charge",
    orderingClosed: "Di luar jam layanan",
    needSession: "Isi jumlah tamu untuk mulai memesan",
    error: {
      variantRequired: "Pilih salah satu varian dulu.",
      modifierMin: "Pilih minimal {min} untuk {group}.",
      modifierMax: "Pilih maksimal {max} untuk {group}.",
      modifierSoldOut: "{name} sedang habis. Pilih opsi lain.",
      noteTooLong: "Catatan terlalu panjang. Persingkat hingga {max} karakter.",
      itemSoldOut: "{name} baru saja habis. Pilih menu lain.",
      conflict:
        "Keranjang baru diubah tamu lain dan sudah diperbarui. Coba tambah sekali lagi.",
      generic: "Belum bisa menambah menu. Periksa koneksi, lalu coba lagi.",
      closed: "Sesi meja sudah berakhir. Buka sesi baru untuk memesan.",
    },
  },
  toast: {
    added: "{name} masuk keranjang",
    addedHint: "Ada di keranjang meja, terlihat oleh semua tamu.",
  },
} as const;
