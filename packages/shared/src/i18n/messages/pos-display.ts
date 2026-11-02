// Customer display texts (POS second screen), bead legend-azt · PRD v1.7
// §3 F11 "POS Kasir & Captain Order" (Customer Display: items, total, QRIS)
// and §3 F13 "QRIS Dinamis" (the code is refreshed when it expires).
export const posDisplayMessages = {
  title: "Layar pelanggan",
  intro: "Tampilan untuk pelanggan di kasir: item, total, dan QRIS.",
  refresh: "Muat ulang",
  loading: "Memuat layar pelanggan…",
  errorTitle: "Layar pelanggan tidak dapat dimuat",
  errorHint: "Periksa koneksi ke terminal POS, lalu coba lagi.",
  offlineTitle: "Layar pelanggan sedang offline",
  offlineHint:
    "Sambungkan kembali perangkat ke jaringan kasir; layar menyambung sendiri.",
  staleNotice: "Koneksi terputus. Menampilkan data terakhir.",
  idle: {
    welcome: "Selamat datang",
    hint: "Silakan tunggu sebentar. Pesanan Anda akan tampil di layar ini.",
    waiting: "Menunggu transaksi",
    paired: "Layar terpasang",
  },
  order: "Pesanan {number}",
  updatedAt: "Diperbarui {time}",
  state: {
    ordering: "Pesanan dicatat",
    awaitingPayment: "Menunggu pembayaran",
    paid: "Lunas",
  },
  linesLabel: "Daftar item pesanan",
  quantityTimes: "{count}×",
  itemCount: "{count} item",
  note: "Catatan: {note}",
  emptyLines: "Belum ada item di pesanan ini.",
  totals: {
    label: "Rincian tagihan",
    subtotal: "Subtotal",
    discount: "Diskon",
    service: "Service charge",
    tax: "Pajak",
    rounding: "Pembulatan",
    total: "Total",
  },
  qris: {
    title: "Pindai untuk membayar",
    hint: "Buka aplikasi bank atau e-wallet, lalu pindai kode ini.",
    expires: "Berlaku {time}",
    expired: "Kode kedaluwarsa, menyegarkan…",
    alt: "Kode QRIS pembayaran {amount}",
  },
  orderingHint:
    "Kasir masih mencatat pesanan. Total diperbarui saat item ditambahkan.",
  paid: {
    title: "Pembayaran berhasil",
    hint: "Terima kasih. Silakan tunggu pesanan Anda.",
    tenders: "Metode pembayaran",
    change: "Kembalian",
    changeHint: "Kembalian diserahkan kasir.",
  },
  tender: {
    cash: "Tunai",
    qris: "QRIS",
    va: "Virtual account",
    ewallet: "E-wallet",
    card: "Kartu",
    edcCard: "Kartu (EDC)",
    edcQris: "QRIS (EDC)",
    points: "Poin",
  },
};
