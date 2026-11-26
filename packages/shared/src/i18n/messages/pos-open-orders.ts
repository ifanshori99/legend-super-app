// POS open orders list: orders not finished yet and parked carts (brief 1268
// W5, mockup design/mockups/pos/1268-pesanan-terbuka approved by the founder 25
// Nov; the first tab is named "Belum selesai"). id.ts imports it as
// `posOpenOrders`.
export const posOpenOrdersMessages = {
  nav: "Pesanan terbuka",
  title: "Pesanan terbuka",
  subtitle: "Pesanan yang belum selesai di outlet ini",
  newOrder: "Pesanan baru",
  tabs: {
    label: "Jenis pesanan",
    open: "Belum selesai",
    parked: "Ditahan",
  },
  open: {
    heldTitle: "{count} pesanan punya item ditahan",
    heldHint:
      "Item ini belum dikirim ke dapur. Buka pesanannya untuk mengirim.",
    rowTitle: "{place} · #{number}",
    items: "{count} item",
    openedAt: "Dibuka {time}",
    minutesAgo: "{count} menit lalu",
    hoursAgo: "{count} jam lalu",
    held: "{count} item ditahan",
    total: "Total",
    remaining: "Sisa {amount}",
    open: "Buka",
    openLabel: "Buka pesanan {number}",
    emptyTitle: "Tidak ada pesanan belum selesai",
    emptyHint: "Pesanan yang dibuat dan belum dibayar akan muncul di sini.",
    emptyAction: "Buat pesanan",
    errorTitle: "Daftar pesanan belum bisa dimuat",
    errorHint: "Periksa koneksi, lalu coba lagi. Pesanan tetap tersimpan.",
    loading: "Memuat pesanan…",
  },
  status: {
    draft: "Belum dikirim",
    awaiting_payment: "Menunggu pembayaran",
    sent: "Pesanan terbuka",
  },
  parked: {
    noticeTitle: "Pesanan ditahan belum masuk tagihan",
    noticeHint: "Lanjutkan untuk memeriksa stok dan harga terbaru.",
    meta: "{count} item · {service} · Ditahan {time}",
    resume: "Lanjutkan",
    resumeLabel: "Lanjutkan pesanan {label}",
    emptyTitle: "Tidak ada pesanan ditahan",
    emptyHint: "Pesanan yang ditahan di kasir akan muncul di sini.",
    errorTitle: "Pesanan ditahan belum bisa dimuat",
  },
  service: {
    dine_in: "Dine-in",
    takeaway: "Takeaway",
    delivery: "Delivery",
  },
} as const;
