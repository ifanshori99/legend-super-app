// QR order "final arah A + liquid glass" texts, part: mobile cart bar and the
// desktop table nota (bead legend-2re1; design/mockups/README.md). One file
// per screen group so the parallel screen builds never edit the same lines.
export const qrGlassCartMessages = {
  bar: {
    label: "Keranjang meja",
    subtotal: "Subtotal · {count} item",
    open: "Lihat keranjang",
    companionPrompt: "Tambah pendamping {category}?",
    companionAction: "Lihat pilihan",
    ordersPrompt: "Pesanan meja",
    ordersHint: "Lihat status pesanan Anda",
  },
  nota: {
    title: "Keranjang meja",
    subtitle: "Meja {table} · Dilihat semua tamu",
    loading: "Memuat keranjang meja…",
    errorTitle: "Keranjang belum bisa dimuat",
    errorHint: "Periksa koneksi internet Anda, lalu muat ulang halaman.",
    emptyTitle: "Keranjang meja masih kosong",
    emptyHint: "Pilih menu di sebelah kiri. Semua tamu di meja ini melihatnya.",
    noSessionTitle: "Isi jumlah tamu untuk mulai pesan",
    noSessionAction: "Isi jumlah tamu",
    companionEyebrow: "Pendamping {category} · Opsional",
    subtotal: "Subtotal",
    itemCount: "{count} item",
    taxNote: "Belum termasuk pajak dan service.",
    open: "Lihat keranjang",
    openCart: "Atur di keranjang",
    openCartAria: "Atur {name} di keranjang",
    payFirstNote:
      "Bayar di muka. Pesanan masuk dapur setelah pembayaran diterima.",
    openBillNote: "{mode}. {hint}",
    soldOut: "Habis",
  },
} as const;
