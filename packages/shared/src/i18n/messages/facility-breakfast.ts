// Breakfast order from the access ticket (WS-09, PRD v1.7 §3 F22 "Sarapan Siap
// Saat Keluar Shower", alur Z, FAC-10; mockup pos-extra-ijv8-sarapan). Own file
// so parallel beads never edit the same catalog lines.
export const facilityBreakfastMessages = {
  title: "Pilih sarapan",
  hint: "Pesanan ditahan dan dikirim ke dapur sesuai waktu persiapan, menjelang akhir sesi.",
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
  holdNote:
    "Pesanan ditahan, lalu dikirim otomatis ke dapur beberapa menit sebelum sesi berakhir sesuai waktu persiapan menu. Jika sesi diperpanjang atau terlambat, waktu kirim menyesuaikan.",
  successTitle: "Pesanan sarapan ditahan",
  successBody:
    "Pesanan akan dikirim otomatis ke dapur pukul {time}. Waktunya menyesuaikan jika sesi berubah.",
  firedTitle: "Pesanan sarapan sudah dikirim ke dapur",
  firedBody: "Dapur sedang menyiapkan pesananmu.",
  orderedLine: "{quantity} × {name}",
} as const;
