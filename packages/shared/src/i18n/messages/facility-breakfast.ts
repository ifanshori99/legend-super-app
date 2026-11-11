// Breakfast order from the access ticket (WS-09, PRD v1.7 §3 F22 "Sarapan Siap
// Saat Keluar Shower", alur Z, FAC-10; mockup pos-extra-ijv8-sarapan). Own file
// so parallel beads never edit the same catalog lines.
export const facilityBreakfastMessages = {
  title: "Pilih sarapan",
  hint: "Bayar dulu, lalu pesanan dikirim ke dapur sesuai waktu persiapan, menjelang akhir sesi.",
  loading: "Memuat menu sarapan…",
  emptyTitle: "Belum ada menu sarapan tersedia",
  emptyHint: "Silakan kembali lagi nanti untuk melihat pilihan sarapan.",
  errorTitle: "Menu sarapan belum dapat dimuat",
  errorHint: "Periksa koneksi, lalu coba lagi.",
  quantityLabel: "Jumlah {name}",
  decrease: "Kurangi {name}",
  increase: "Tambah {name}",
  itemsError: "Pilih minimal satu menu sarapan.",
  deliveryTitle: "Tempat menerima pesanan",
  deliveryToTable: "Antar ke meja",
  deliveryPickup: "Ambil di pickup",
  tableLabel: "Nomor meja",
  tablePlaceholder: "Pilih meja",
  tableError: "Pilih nomor meja untuk pengantaran.",
  summaryTitle: "Ringkasan sarapan",
  summaryPlace: "Tempat",
  summaryPickup: "Pickup",
  summaryFireAt: "Dikirim ke dapur",
  subtotal: "Subtotal sarapan",
  subtotalNote:
    "Subtotal menu. Server menghitung ulang harga saat pesanan dibuat.",
  noItems: "Belum ada menu dipilih.",
  tableFallback: "Meja pilihan",
  reload: "Muat ulang menu",
  submit: "Pesan sarapan",
  payFirstNote:
    "Pesanan dibuat dulu, lalu dibayar. Pesanan yang belum lunas tidak dikirim ke dapur. Setelah lunas, pesanan dikirim otomatis beberapa menit sebelum sesi berakhir sesuai waktu persiapan menu. Jika sesi diperpanjang atau terlambat, waktu kirim menyesuaikan.",
  awaitingTitle: "Pesanan sarapan menunggu pembayaran",
  awaitingBody:
    "Selesaikan pembayaran agar pesanan bisa dikirim ke dapur. Pesanan yang belum lunas tidak dikirim.",
  total: "Total bayar",
  pay: "Bayar sarapan",
  cancelledNote:
    "Pesanan sarapan sebelumnya dibatalkan. Kamu bisa memesan lagi.",
  successTitle: "Pesanan sarapan sudah lunas",
  successBody:
    "Pembayaran diterima. Pesanan akan dikirim otomatis ke dapur pukul {time}. Waktunya menyesuaikan jika sesi berubah.",
  firedTitle: "Pesanan sarapan sudah dikirim ke dapur",
  firedBody: "Dapur sedang menyiapkan pesananmu.",
  orderedLine: "{quantity} × {name}",
} as const;
