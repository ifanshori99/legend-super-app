// Member "Tukar poin di kasir" (legend-0ne0z, slice E): the page frame and the
// states it owns itself (loading, offline, read error). Spread into
// `member.tukarPoin` by id.ts, so keys read `member.tukarPoin.page.*`.
export const memberTukarPoinPageMessages = {
  page: {
    back: "Kembali ke poin",
    title: "Tukar poin di kasir",
    subtitle: "Gunakan poin untuk tagihan Anda yang sedang dibuka.",
    // Link on the points page.
    linkFromPoints: "Tukar poin di kasir",
    identity: "{name} · Poin saya",
    identityFallback: "Poin saya",
    balanceLabel: "Poin tersedia",
    pointsValue: "{points} poin",
    // Loading
    loadingContextTitle: "Memeriksa tagihan & poin",
    loadingContextSub: "Menunggu data terbaru dari server.",
    balancePending: "— poin",
    balancePendingSr: "Sedang dimuat",
    loadingEyebrow: "Memuat",
    loadingTitle: "Tunggu sebentar",
    loadingBody:
      "Tagihan, saldo poin, dan hasil penukaran diperiksa sebelum QR ditampilkan.",
    loadingNote:
      "Jangan pindai ulang atau mengulangi penukaran selama pemeriksaan berlangsung.",
    // Offline
    offlineContextTitle: "Koneksi terputus",
    offlineContextSub:
      "Saldo dan tagihan perlu diperiksa langsung sebelum poin dapat digunakan.",
    offlineBalanceLabel: "Saldo terakhir · Belum diperbarui",
    offlineBalanceNote: "Angka ini bukan konfirmasi saldo saat ini.",
    offlineEyebrow: "Offline",
    offlineTitle: "Tukar poin sementara tidak tersedia",
    offlineBody:
      "Sambungkan kembali internet, lalu periksa status tagihan. QR tidak ditampilkan saat offline.",
    offlineNote:
      "Jika kasir baru memindai QR, periksa hasilnya setelah terhubung. Jangan mengulang penukaran sebelum statusnya jelas.",
    offlineAction: "Periksa koneksi & status",
    offlineChecking: "Memeriksa...",
    // Read error
    errorContextTitle: "Tagihan belum bisa dimuat",
    errorContextSub: "Data tagihan atau saldo poin belum diterima dari server.",
    errorEyebrow: "Gagal memuat",
    errorTitle: "Coba periksa lagi",
    errorBody:
      "Periksa koneksi Anda, lalu coba lagi. QR tidak ditampilkan sampai tagihan dan saldo terbaca.",
    errorNote: "Poin belum digunakan.",
    errorAction: "Coba lagi",
    // Several open bills: back to the list after one was chosen.
    chooseOtherBill: "Pilih tagihan lain",
    // A QR minted earlier can still be scanned: no second one until it ends.
    outstandingBlocked:
      "QR sebelumnya masih berlaku sampai {time}. Tunggu sampai berakhir sebelum membuat QR baru.",
    outstandingChecking:
      "QR sebelumnya sedang diperiksa. Tunggu sebentar sebelum membuat QR baru.",
    // Status check that did not complete
    checkFailed:
      "Status belum bisa diperiksa. Periksa koneksi, lalu coba lagi. Jangan membuat QR baru sebelum statusnya jelas.",
  },
};
