// POS cashier texts for the order detail and kitchen notices (bead
// legend-0ixe). id.ts imports it as `posOrderDetail`.
export const posOrderDetailMessages = {
  screen: {
    back: "Daftar pesanan",
    title: "Pesanan #{number}",
    subtitle: "{service} · Dibuka {time}",
    loading: "Memuat pesanan…",
    emptyTitle: "Pesanan tidak ditemukan",
    emptyHint:
      "Pesanan ini tidak ada di outlet ini. Kembali ke daftar pesanan lalu coba lagi.",
    errorTitle: "Pesanan belum bisa dimuat",
    errorHint: "Periksa koneksi, lalu coba lagi. Pesanan tetap tersimpan.",
  },
  service: {
    dine_in: "Dine-in",
    takeaway: "Takeaway",
    delivery: "Delivery",
  },
  status: {
    draft: "Draf",
    sent: "Pesanan terbuka",
    awaiting_payment: "Menunggu pembayaran",
    completed: "Selesai",
    voided: "Dibatalkan",
  },
  panel: {
    title: "Rincian pesanan",
    count: "{count} item",
    noItems: "Pesanan ini belum punya item.",
    countHeld: "{count} item · {held} ditahan",
    countAllSent: "{count} item · Semua sudah dikirim",
  },
  notice: {
    title: "Item dibatalkan di dapur",
    item: "{time} · Dapur membatalkan {count} item.",
    ticket: "{time} · Dapur membatalkan satu tiket berisi {count} item.",
    reason: "Alasan: {reason}.",
    billUnchanged:
      "Pembatalan dapur belum mengubah tagihan. Periksa item dan ajukan void POS jika diperlukan.",
    emptyTitle: "Tidak ada pemberitahuan dapur",
    emptyHint: "Perubahan dari dapur akan muncul di rincian pesanan ini.",
    loadingTitle: "Memuat pemberitahuan dapur…",
    loadingHint: "Mohon tunggu, riwayat pesanan sedang diperiksa.",
    errorTitle: "Pemberitahuan dapur tidak dapat dimuat",
    errorHint: "Periksa koneksi dan coba lagi sebelum mengambil tindakan.",
  },
  item: {
    line: "{quantity} × {price}",
    sent: "Dikirim ke dapur",
    kitchenVoided: "Dibatalkan di dapur",
    voided: "Dibatalkan",
    held: "Ditahan",
  },
  fire: {
    action: "Kirim ke dapur",
    confirmTitle: "Kirim {count} item ke dapur?",
    confirmHint:
      "Pesanan #{number}. Setelah dikirim, item tidak bisa ditahan lagi.",
    confirm: "Kirim {count} item",
    back: "Kembali",
    sentTitle: "{count} item dikirim ke dapur",
    unclearTitle: "Belum pasti terkirim",
    unclearHint:
      "Jawaban server tidak diterima. Tekan Periksa lagi; permintaan yang sama diulang, jadi item tidak terkirim dua kali.",
    retry: "Periksa lagi",
    errorTitle: "Item belum terkirim",
    completeHint: "Pesanan baru bisa diselesaikan setelah semua item dikirim.",
  },
  pay: {
    action: "Lanjut ke pembayaran",
    finish: "Selesaikan dan cetak struk",
    unpaid: "Belum lunas",
    paid: "Lunas",
  },
  oldLink: {
    pill: "Tautan lama",
    title: "Sebagian dibayar lewat tautan lama",
    hint: "Daftar pesanan sudah menghitung pembayaran tautan ini: sisa tagihan {amount}. Periksa pembayaran tautan sebelum menagih lagi.",
  },
  summary: {
    title: "Ringkasan tagihan",
    subtotal: "Subtotal",
    discount: "Diskon",
    service: "Biaya layanan",
    tax: "Pajak",
    rounding: "Pembulatan",
    total: "Total",
    deposit: "DP reservasi",
    remaining: "Sisa tagihan",
    kitchenVoidKept:
      "Total masih termasuk item yang dibatalkan di dapur sampai void POS disetujui.",
    action: "Ajukan void item",
    refundAction: "Ajukan refund",
    approvalNote: "Void POS memerlukan alasan dan persetujuan supervisor.",
    checkFirst: "Periksa riwayat dapur sebelum mengajukan void.",
  },
} as const;
