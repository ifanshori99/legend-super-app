// O4 offline cashier texts (bead legend-wasr7.8, mockup
// design/mockups/pos/offline): the banner and queue count, the offline pay
// and saved dialogs, the queue sheet and the shift close refusal. Read only
// from the _ops cashier and shift screens (`ops` chunk). id.ts imports it as
// `posKasirOffline`.
export const posKasirOfflineMessages = {
  banner: {
    offlineTitle: "Offline · {count} penjualan belum terkirim",
    offlineTitleNone: "Offline · penjualan disimpan di tablet",
    offlineBody:
      "Tetap bisa jualan: tunai dan EDC manual. Penjualan disimpan di tablet dan terkirim otomatis saat tablet tersambung lagi.",
    noKitTitle: "Offline · penjualan offline tidak tersedia",
    noKitBody:
      "Tablet ini tidak punya bekal offline yang berlaku (bekal berlaku 24 jam). Sambungkan tablet ke internet untuk jualan lagi; bekal baru diambil otomatis.",
    sendingTitle: "{count} penjualan offline sedang dikirim",
    sendingBody:
      "Tablet sudah tersambung. Penjualan offline terkirim otomatis.",
    stoppedTitle: "Pengiriman penjualan offline berhenti",
    stoppedBody:
      "{count} penjualan disisihkan, perlu dicek. Penjualan sesudahnya menunggu sampai laporan konflik diterima.",
    openQueue: "Lihat antrean",
    promo: "Promo tidak berlaku saat offline · harga daftar",
  },
  cart: {
    subtitle: "Penjualan offline",
    pay: "Bayar {amount}",
    payPlain: "Bayar",
    blocked: {
      noPermission:
        "Akun ini tidak bisa menerima pembayaran. Minta kasir yang bertugas.",
      uncertain_order: "Pesanan tadi belum pasti, cek sesudah online.",
      sending: "Pesanan sedang dikirim. Tunggu jawabannya.",
      cloud_order:
        "Pesanan ini sudah ada di cloud. Lanjutkan sesudah tablet online.",
      channel: "Saat offline hanya dine-in dan takeaway.",
      empty: "Pilih menu untuk mulai.",
      noKit:
        "Bekal offline tidak tersedia. Sambungkan tablet ke internet untuk jualan.",
    },
  },
  otherCustomer: {
    action: "Ini pelanggan lain",
    title: "Pelanggan lain?",
    body: "Menu ini sama dengan pesanan tadi yang belum pasti. Tandai hanya bila ini pelanggan lain, bukan pesanan yang sama. Penjualan tetap disimpan dan dicek Finance.",
    reason: "Alasan",
    reasonHint:
      "Tulis singkat, minimal {min} huruf. Contoh: meja 4, pelanggan lain.",
    short: "Tulis alasannya, minimal 4 huruf.",
    cancel: "Kembali",
    confirm: "Tandai pelanggan lain",
    marked: "Ditandai pelanggan lain: {reason}",
    clear: "Batalkan tanda",
  },
  pay: {
    title: "Bayar · offline",
    summary: "Total {amount} · harga daftar, tanpa promo",
    methods: "Metode bayar",
    cash: "Tunai",
    cashHint: "Masuk laci shift ini",
    edc: "EDC manual",
    edcHint: "Nomor slip wajib",
    onlineOnly: "Hanya saat online: QRIS, VA/e-wallet, poin, voucher, DP.",
    received: "Uang diterima",
    exact: "Uang pas",
    change: "Kembalian",
    short: "Uang diterima kurang dari total.",
    reference: "Nomor slip EDC",
    referenceHint: "Salin nomor referensi yang tercetak di slip EDC.",
    referenceRequired: "Isi nomor slip EDC.",
    subtotal: "Subtotal · {count} item",
    service: "Biaya layanan",
    tax: "Pajak",
    rounding: "Pembulatan",
    total: "Total",
    cancel: "Kembali",
    save: "Simpan penjualan",
    priceError:
      "Keranjang ini tidak bisa dihitung dari bekal offline (menu atau pilihan tidak ada di bekal). Ubah keranjang, atau tunggu sampai online.",
    errors: {
      KIT_MISSING:
        "Tablet ini belum punya bekal offline. Sambungkan tablet ke internet.",
      KIT_EXPIRED:
        "Bekal offline sudah lewat 24 jam. Sambungkan tablet ke internet.",
      KIT_SHIFT_CLOSED:
        "Shift bekal ini sudah ditutup. Buka shift baru sesudah online.",
      TENDER_TOTAL_MISMATCH: "Jumlah bayar tidak sama dengan total.",
      CASH_RECEIVED_SHORT: "Uang diterima kurang dari total.",
      generic:
        "Penjualan belum tersimpan. Coba lagi; bila tetap gagal, catat di kertas dan lapor supervisor.",
    },
  },
  saved: {
    title: "Penjualan disimpan di tablet",
    number: "Nomor struk offline",
    change: "Kembalian",
    cloud: "Pengiriman ke cloud",
    cloudWaiting: "Menunggu sambungan",
    receipt: "Struk",
    receiptLater: "Cetak ulang sesudah online",
    queue: "Antrean tablet",
    queueCount: "{count} penjualan belum terkirim",
    next: "Pesanan baru",
  },
  queue: {
    title: "Penjualan offline di tablet ini",
    description:
      "Terkirim otomatis saat tablet tersambung. Penjualan ini tidak bisa dihapus dari tablet.",
    waiting: "Menunggu terkirim",
    parked: "Disisihkan, perlu dicek",
    cash: "Tunai di antrean",
    cashHint: "Sudah di laci, belum tercatat di cloud",
    loading: "Memuat antrean…",
    loadError: "Antrean di tablet tidak terbaca. Muat ulang layar kasir.",
    emptyTitle: "Antrean kosong",
    emptyBody: "Semua penjualan offline sudah terkirim.",
    listLabel: "Antrean penjualan offline",
    statusWaiting: "Menunggu terkirim",
    statusParked: "Disisihkan · laporan dikirim",
    parkedTitle: "Laporan konflik belum diterima cloud",
    parkedBody:
      "Nomor ini sudah tercatat dari perangkat lain. Tablet mengirim laporan berisi nominal dan item; setelah diterima, penjualan ini dicek supervisor dan Finance dan tidak lagi menahan tutup shift.",
    tenderCash: "Tunai",
    tenderEdc: "EDC · slip {reference}",
    syncNow: "Coba kirim sekarang",
    syncFailed: "Belum terkirim. Dicoba lagi otomatis tiap 30 detik.",
    offlineNote: "Tablet offline. Pengiriman dicoba lagi saat tersambung.",
    foot: "Tutup shift dan keluar ditahan sampai antrean kosong.",
    close: "Tutup",
  },
  close: {
    title: "Shift belum bisa ditutup",
    body: "{count} penjualan offline belum terkirim. Tunainya sudah ada di laci, jadi harus tercatat di cloud dulu sebelum laci dihitung.",
    parked: "{count} di antaranya disisihkan, perlu dicek.",
    cash: "Tunai offline belum terkirim: {amount}",
    openQueue: "Lihat antrean",
    forceClose: "Tutup paksa oleh supervisor",
    forceCloseNoPermission:
      "Akun ini tidak bisa tutup paksa. Hanya supervisor yang boleh; minta supervisor membuka layar persetujuan shift ini.",
    unverifiedTitle: "Shift ini memakai bekal offline",
    unverifiedBody:
      "Tutup shift dari tablet kasir pemegang bekal, atau minta supervisor menutup paksa. Finance mendapat pemberitahuan.",
    forceHint:
      "Tablet rusak atau tidak bisa tersambung? Minta supervisor tutup paksa dari layar persetujuan shift. Finance mendapat pemberitahuan, dan penjualan yang datang belakangan tetap dicatat.",
  },
  closeNeedsInternet: {
    title: "Tutup shift butuh internet",
    body: "Hitung kas dicatat di cloud, jadi layar ini menunggu tablet tersambung lagi. Penjualan offline tetap aman di tablet dan jalan terus.",
    pending: "{count} penjualan offline menunggu dikirim lebih dulu.",
    back: "Kembali ke kasir",
  },
  // 1273 second opinion P2-1: a sale the cloud refuses for good.
  stuck: {
    status: "Ditolak cloud",
    reason: {
      kit_unknown: "Bekal offline penjualan ini tidak dikenal cloud",
      sequence_gap: "Nomor struk sebelumnya belum sampai di cloud",
      device_refused: "Perangkat ini ditolak cloud",
    },
    body: "Penjualan ini tidak akan terkirim sendiri. Laporkan ke kantor dengan PIN supervisor: cloud menyimpannya untuk dicek Finance, lalu tablet menghapusnya dari antrean.",
    report: "Laporkan ke kantor",
    dialogTitle: "Laporkan penjualan ke kantor",
    dialogSummary:
      "Struk {receipt} ({amount}) disimpan di cloud tanpa pesanan dan dicek Finance. Tablet baru menghapusnya setelah cloud menerima.",
    networkError:
      "Laporan belum terkirim. Penjualan tetap di tablet; coba lagi saat tersambung.",
  },
  dayClose: {
    openShiftsLabel: "Shift yang masih buka",
    openShift: "Shift {shiftNo} · buka {time}",
  },
};
