// POS cashier texts for the "Bayar di kasir" code lookup (bead legend-mjmm, S1). Filled by its screen
// bead; id.ts imports it as `posKasirCode`.
export const posKasirCodeMessages = {
  title: "Terima kode pelanggan",
  subtitle: "Cocokkan kode, meja, dan total sebelum menerima pembayaran.",
  back: "Kembali ke pesanan",
  input: {
    label: "Kode “Bayar di kasir”",
    prefix: "LG–",
    hint: "Sama seperti kode di ponsel pelanggan.",
    required: "Masukkan nomor kode pelanggan.",
    notFound: "Kode tidak ditemukan. Periksa kembali.",
  },
  keypad: {
    label: "Tombol angka kode",
    clear: "Hapus",
    backspace: "Hapus satu digit",
  },
  search: "Cari pesanan",
  searchAgain: "Cari ulang pesanan",
  idle: {
    title: "Masukkan kode pelanggan",
    description:
      "Ketik nomor kode dari layar “Bayar di kasir” pelanggan, lalu cari.",
  },
  loading: "Mencari pesanan…",
  found: {
    pill: "Pesanan ditemukan",
    source: "QR pelanggan",
    quantity: "Jumlah {qty}",
    itemNote: "Termasuk pajak dan service",
    total: "Total pembayaran",
    noPayment: "Belum ada pembayaran diterima",
    unpaidTitle: "Belum dibayar · Belum masuk dapur",
    unpaidBody: "Pesanan diteruskan ke dapur setelah pembayaran dikonfirmasi.",
    continue: "Lanjut ke pembayaran {amount} →",
    continueNote: "Membuka pembayaran belum menandai pesanan lunas.",
  },
  paid: {
    pill: "Sudah lunas",
    title: "Pesanan ini sudah dibayar",
    body: "Tidak ada pembayaran yang perlu diterima. Minta pelanggan menunjukkan struk bila perlu.",
  },
  cancelled: {
    pill: "Dibatalkan",
    title: "Pesanan ini sudah dibatalkan",
    body: "Pembayaran tidak dapat diterima. Minta pelanggan membuat pesanan baru.",
  },
  invalid: {
    title: "Pesanan belum ditemukan",
    description:
      "Cocokkan kode dengan layar “Bayar di kasir” pelanggan, lalu cari ulang.",
    noteTitle: "Belum ada pembayaran diproses",
    noteBody: "Pembayaran baru dapat dimulai setelah pesanan ditemukan.",
  },
  error: {
    pendingTitle: "Fitur ini belum tersambung ke server",
    pendingBody:
      "Pencarian kode belum bisa dipakai di outlet ini. Hubungi admin, atau buka pesanan dari daftar meja.",
    genericTitle: "Pencarian gagal",
    genericBody:
      "Pesanan belum bisa dicari. Periksa koneksi terminal, lalu cari ulang.",
    inline: "Pencarian gagal. Cari ulang.",
    pendingInline: "Fitur ini belum tersambung ke server.",
  },
};
