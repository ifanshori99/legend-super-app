// POS cashier texts for QRIS, virtual account, e-wallet and online card (bead legend-mjmm, P2). Filled by its screen
// bead; id.ts imports it as `posKasirGateway`.
export const posKasirGatewayMessages = {
  common: {
    paymentNo: "Pembayaran {no}",
    validFor: "Berlaku {time} lagi",
    checkStatus: "Cek status pembayaran",
    checking: "Memeriksa status…",
    viewDisplay: "Lihat customer display",
    otherMethod: "Pilih metode lain",
    retry: "Coba lagi",
    loading: "Memuat pembayaran…",
    loadError: "Pembayaran tidak bisa dimuat",
    loadErrorHint: "Periksa koneksi, lalu muat ulang.",
    contractPending: "Fitur ini belum tersambung ke server",
    contractPendingHint:
      "Metode ini belum bisa dipakai. Pilih metode pembayaran lain.",
    actionError: "Aksi belum berhasil",
    statusCheckError: "Status belum bisa diperiksa",
    startError: "Pembayaran belum bisa dimulai",
    statusWaiting: "Menunggu",
    statusExpired: "Kedaluwarsa",
    statusFailed: "Gagal",
    waitingNoticeTitle: "Menunggu konfirmasi pembayaran",
    waitingNoticeBody:
      "Tagihan belum lunas. Status berubah otomatis setelah pembayaran terkonfirmasi.",
    unpaidTitle: "Tagihan belum lunas",
  },
  /** 1272 K4: guest service fee of a VA / e-wallet channel ("Biaya layanan"). */
  fee: {
    line: "Biaya layanan {fee}",
    total: "Total dibayar tamu {total}",
    label: "Biaya layanan",
    totalLabel: "Total dibayar tamu",
    noRefund: "Biaya layanan tidak dikembalikan bila pesanan dibatalkan.",
  },
  grid: {
    loadError: "Metode pembayaran tidak bisa dimuat",
    loadErrorHint: "Periksa koneksi, lalu coba lagi.",
    hint: {
      qris: "QR di customer display",
      va: "Virtual Account",
      ewallet: "Dompet digital",
      card: "Pembayaran online",
      cash: "Hitung uang dan kembalian",
      edc: "Kartu atau QRIS di mesin, dicatat manual",
    },
    locked: {
      not_supported: "Belum bisa dipakai di kasir",
      device_required: "Perlu perangkat kasir terdaftar",
      routing_disabled: "Tidak aktif di outlet ini",
      gateway_down: "Penyedia pembayaran sedang gangguan",
      needs_cloud: "Perlu koneksi internet outlet",
      no_terminal: "Belum ada mesin EDC aktif",
    },
  },
  receipt: {
    skipPrint: "Lewati cetak, transaksi baru",
    notPrintedTitle: "Struk {receiptNo} tidak tercetak",
    notPrintedBody:
      "Server tidak punya printer untuk struk ini. Simpan PDF untuk pelanggan. Percobaan cetak berikutnya ditandai CETAK ULANG.",
    pdf: "Simpan PDF struk",
    pdfError: "PDF struk belum bisa dibuka",
  },
  qris: {
    panelTitle: "QRIS · Customer display",
    startHeading: "Tampilkan QRIS di layar pelanggan",
    startBody:
      "Kode QR dibuat untuk nominal ini dan hanya tampil di customer display.",
    start: "Buat QRIS",
    starting: "Membuat QRIS…",
    readyHeading: "QRIS siap dipindai",
    readyBodyOutlet: "QRIS {outlet} sudah tampil di layar pelanggan.",
    readyBody: "QRIS sudah tampil di layar pelanggan.",
    readyAction: "Minta pelanggan memindai dan menyelesaikan pembayaran.",
    expiredHeading: "QRIS kedaluwarsa",
    expiredBody: "Pelanggan belum menyelesaikan pembayaran.",
    expiredWarn: "Jangan gunakan kode QR sebelumnya.",
    expiredNoticeBody:
      "Buat QRIS baru setelah status pembayaran lama diperiksa, atau pilih metode lain.",
    renew: "Buat QRIS baru",
    renewing: "Memeriksa status dan membuat QRIS…",
    hiddenHeading: "Menunggu hasil QRIS",
    hiddenBody:
      "QR tidak bisa ditampilkan untuk tagihan ini. Tunggu kepastian dari penyedia pembayaran.",
    lapsedBody:
      "Waktu QRIS sudah habis. Tunggu kepastian dari penyedia pembayaran sebelum memakai cara lain.",
    cancel: "Batalkan QRIS",
    cancelError: "QRIS belum bisa dibatalkan",
    cancellingHeading: "Membatalkan QRIS",
    cancellingBody:
      "QR sudah disembunyikan. Tagihan tetap terkunci sampai penyedia memastikan QR tidak dibayar.",
    cancellingStatus: "Menunggu kepastian",
  },
  va: {
    panelTitle: "Virtual Account",
    pickHeading: "Pilih bank Virtual Account",
    pickBody: "Pelanggan membayar lewat transfer ke nomor VA bank ini.",
    bankGroup: "Bank Virtual Account",
    noBanks: "Belum ada bank VA aktif",
    noBanksHint: "Pilih metode pembayaran lain.",
    start: "Buat nomor VA",
    starting: "Membuat nomor VA…",
    statusWaiting: "Menunggu transfer",
    readyHeading: "Nomor VA sudah tersedia",
    readyBody:
      "{bank} · Tunjukkan nomor ini ke pelanggan untuk transfer dari aplikasi bank atau ATM.",
    numberLabel: "Nomor Virtual Account",
    deadline: "Batas pembayaran",
    noticeTitle: "Belum lunas",
    noticeBody:
      "Jangan konfirmasi dari bukti transfer. Tunggu status terverifikasi.",
    expiredHeading: "Nomor VA kedaluwarsa",
    expiredBody:
      "Batas pembayaran sudah lewat. Periksa status sebelum pindah metode.",
    expiredNoticeBody:
      "Bila pelanggan sudah transfer, cek status dulu agar pembayaran tidak ganda.",
  },
  ewallet: {
    panelTitle: "E-wallet",
    pickHeading: "Pilih e-wallet pelanggan",
    pickBody: "Permintaan pembayaran dikirim ke aplikasi e-wallet pelanggan.",
    walletGroup: "E-wallet",
    noWallets: "Belum ada e-wallet aktif",
    noWalletsHint: "Pilih metode pembayaran lain.",
    start: "Kirim permintaan",
    starting: "Mengirim permintaan…",
    panelTitleNamed: "E-wallet · {wallet}",
    readyHeading: "Menunggu pembayaran {wallet}",
    readyBody:
      "Minta pelanggan memindai halaman bayar dengan ponsel, lalu menyetujui pembayaran di aplikasi {wallet}.",
    pageLabel: "Halaman bayar {wallet}",
    pageHint:
      "QR ini membuka halaman bayar untuk nominal tagihan. Hanya berlaku untuk tagihan ini.",
    openPage: "Buka halaman bayar",
    openPageLabel: "Buka halaman bayar {wallet} di tab baru",
    pageUnsafe:
      "Halaman bayar dari penyedia tidak aman untuk dibuka. Minta pelanggan memakai cara bayar lain, atau batalkan kode ini.",
    expiredHeading: "Permintaan e-wallet kedaluwarsa",
    expiredBody: "Pelanggan belum menyetujui pembayaran.",
    expiredNoticeBody:
      "Cek status dulu. Bila belum terbayar, pilih metode lain.",
  },
  // 1269 C3b: a VA or e-wallet code is held like a QRIS (one live code a bill).
  code: {
    cancel: "Batalkan kode",
    cancelError: "Kode belum bisa dibatalkan",
    cancellingStatus: "Menunggu kepastian",
    cancellingHeading: "Membatalkan kode pembayaran",
    cancellingBody:
      "Kode sudah disembunyikan. Tagihan tetap terkunci sampai penyedia memastikan kode ini tidak dibayar.",
    lapsedHeading: "Menunggu kepastian penyedia",
    lapsedBody:
      "Waktu kode sudah habis. Tagihan tetap terkunci sampai penyedia memastikan kode ini tidak dibayar.",
    hiddenBody:
      "Kode tidak bisa ditampilkan untuk tagihan ini. Tunggu kepastian dari penyedia pembayaran.",
    oneCodeTitle: "Satu kode untuk tagihan ini",
    oneCodeBody:
      "Selama kode ini berlaku, tunai, QRIS, dan kode lain tidak bisa dipakai. Batalkan kode dulu bila pelanggan ganti cara bayar.",
    releaseAfter:
      "Bila penyedia tidak menjawab, manajer bisa merilis kode mulai pukul {time}.",
    release: "Rilis kode",
    releaseTitle: "Rilis kode pembayaran",
    releaseSummary:
      "Penyedia belum memastikan kode {amount} ini tidak dibayar. Setelah dirilis, tagihan terbuka untuk cara bayar lain. Uang yang masih masuk ke kode ini disimpan sebagai dana belum teralokasi, tidak dipakai untuk tagihan.",
    releaseError: "Kode belum bisa dirilis",
  },
  card: {
    panelTitle: "Kartu kredit/debit (online)",
    startHeading: "Pembayaran kartu online",
    startBody:
      "Pelanggan memasukkan data kartu di layar pelanggan. Kasir tidak melihat nomor kartu.",
    starting: "Memulai pembayaran…",
    readyHeading: "Menunggu pembayaran kartu",
    readyBody:
      "Halaman pembayaran kartu sudah tampil di layar pelanggan. Minta pelanggan menyelesaikannya.",
    expiredHeading: "Pembayaran kartu kedaluwarsa",
    expiredBody: "Pelanggan belum menyelesaikan pembayaran.",
    expiredNoticeBody:
      "Cek status dulu. Bila belum terbayar, pilih metode lain.",
  },
  failed: {
    heading: "Pembayaran gagal",
    body: "Penyedia pembayaran mengonfirmasi pembayaran gagal. Tagihan belum lunas dan pesanan tetap tersimpan.",
    noticeTitle: "{method} ini belum menerima pembayaran",
    noticeBodyDeposit:
      "DP {amount} tetap terpakai. Lanjutkan dengan metode lain atau buat pembayaran baru.",
    noticeBody: "Lanjutkan dengan metode lain atau buat pembayaran baru.",
    retry: "Coba {method} lagi",
    retrying: "Membuat pembayaran baru…",
    otherMethod: "Pilih metode lain",
  },
  tenderVoided: {
    title: "QRIS dibatalkan, dana dikembalikan ke pelanggan",
    edc_request_open:
      "Masih ada transaksi kartu EDC yang belum selesai di tagihan ini, jadi QRIS dikembalikan ke pelanggan. Selesaikan atau batalkan transaksi EDC dulu, lalu minta pelanggan membayar ulang.",
    bill_below_tender:
      "Tagihan sudah berubah dan lebih kecil dari QRIS yang dibayar, jadi QRIS dikembalikan ke pelanggan. Minta pelanggan membayar ulang sesuai tagihan.",
    business_day_closed:
      "Hari bisnis sudah ditutup, jadi QRIS yang masuk dikembalikan ke pelanggan. Minta pelanggan membayar ulang.",
    refund_reserved:
      "Tagihan ini sedang diproses untuk refund, jadi QRIS yang masuk dikembalikan ke pelanggan. Minta pelanggan membayar ulang.",
    unknown:
      "QRIS yang masuk tidak bisa dipakai untuk tagihan ini dan dikembalikan ke pelanggan. Minta pelanggan membayar ulang.",
  },
  method: {
    qris: "QRIS",
    va: "Virtual Account",
    ewallet: "E-wallet",
    card: "Kartu kredit/debit",
    edc: "EDC",
    cash: "Tunai",
  },
};
