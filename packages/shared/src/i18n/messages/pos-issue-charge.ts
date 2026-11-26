// POS cashier texts for collecting a dearer-swap difference (bead legend-shabi).
// id.ts imports it as `posIssueCharge`.
export const posIssueChargeMessages = {
  screen: {
    title: "Tagih selisih",
    subtitle: "Periksa penggantian menu sebelum melanjutkan pembayaran.",
    back: "Kembali ke pesanan",
    loading: "Memuat tagihan selisih…",
    emptyTitle: "Tagihan selisih tidak ditemukan",
    emptyHint:
      "Tagihan ini tidak ada di outlet ini. Kembali ke pesanan lalu coba lagi.",
    errorTitle: "Tagihan selisih belum bisa dimuat",
    errorHint: "Periksa koneksi, lalu coba lagi. Pesanan tetap tersimpan.",
  },
  detail: {
    title: "Penggantian menu",
    order: "Pesanan {number}",
    orderTable: "Pesanan {number} · {table}",
    unavailable: "Menu tidak tersedia",
    replacement: "Menu pengganti",
    portion: "{name} · {count} porsi",
    due: "Selisih yang harus dibayar",
    surcharge: "Layanan dan pajak",
    hint: "Pelanggan memilih menu pengganti yang lebih mahal. Total pesanan awal tetap tercatat.",
  },
  status: {
    unpaid: "Belum lunas",
    paid: "Lunas",
    failed: "Belum berhasil",
    waived: "Dibebaskan",
    expired: "Kedaluwarsa",
    voided: "Dibatalkan",
  },
  collect: {
    title: "Penagihan selisih",
    hint: "Penagihan ini dicatat terpisah dari pesanan awal.",
    difference: "Selisih",
    receive: "Terima tunai {amount}",
    receiveHint: "Pastikan uang sudah diterima sebelum mencatat penagihan.",
    action: "Tagih selisih · Tunai {amount}",
    pending: "Memproses…",
    recording: "Mencatat penagihan…",
    recordingHint: "Jangan ulangi tindakan sampai status diperbarui.",
  },
  method: {
    legend: "Metode pembayaran",
    cash: "Tunai",
    qris: "QRIS",
    edc_card: "EDC kartu",
    lockedTitle: "Hanya {method} yang bisa diulang",
    lockedHint:
      "Percobaan {method} sebelumnya belum ada jawaban server. Mengulang memakai permintaan yang sama, jadi tidak tercatat dua kali. Metode lain terbuka sesudah percobaan itu selesai.",
    lockedResolveHint:
      "Bila percobaan itu tidak akan diulang, minta supervisor menyelesaikannya.",
  },
  precheck: {
    title: "Tagihan belum bisa dibaca",
    hint: "Tidak ada yang dikirim. Periksa koneksi, lalu coba lagi. Metode yang terkunci tetap terkunci.",
  },
  waiting: {
    pill: "Menunggu",
    locked:
      "Metode lain terkunci sampai server memastikan hasilnya. Jangan tagih ulang.",
    stale:
      "Status terbaru belum bisa diambil. Jangan terima pembayaran lain, periksa koneksi.",
    staleTitle: "Status belum bisa diperbarui",
  },
  qris: {
    start: "Buat QRIS {amount}",
    startHint:
      "Kode QRIS dibuat dari nominal server. Pelanggan memindai kode di layar ini.",
    renew: "Buat QRIS baru {amount}",
    waitingTitle: "Menunggu pembayaran pelanggan",
    codeLabel: "Kode QRIS tagihan selisih",
    validFor: "Berlaku {time} lagi",
    timeUpTitle: "Waktu kode habis",
    timeUp:
      "Kode tidak ditampilkan lagi. Server sedang memastikan kode belum dibayar.",
    otherTitle: "Pelanggan sedang membayar lewat aplikasi",
    expiredTitle: "Kode QRIS kedaluwarsa",
    expired: "Server memastikan kode lama belum dibayar. Buat kode baru.",
    failedTitle: "Pembayaran QRIS gagal",
    failed:
      "Server memastikan tidak ada uang masuk. Buat kode baru atau pilih metode lain.",
    confirmingTitle: "QRIS sudah dibayar",
    confirming:
      "Menunggu tagihan ditandai lunas. Jangan terima pembayaran lain.",
  },
  edc: {
    approvedPill: "Disetujui bank",
    legend: "Transaksi EDC dari server",
    pick: "Pilih transaksi yang disetujui bank. Nominal tidak diketik di sini.",
    emptyTitle: "Belum ada transaksi EDC yang disetujui",
    empty:
      "Hanya transaksi EDC untuk tagihan ini yang bisa dipakai. Muat ulang setelah mesin selesai.",
    reload: "Muat ulang transaksi",
    terminal: "Terminal EDC",
    record: "Catat EDC {amount}",
    waitingTitle: "Hasil EDC belum pasti",
    waiting: "Jangan gesek ulang. Status diperiksa otomatis.",
    terminalLegend: "Mesin EDC",
    terminalsLoading: "Memuat mesin EDC…",
    terminalsEmptyTitle: "Belum ada mesin EDC kartu",
    terminalsEmpty:
      "Outlet ini belum punya mesin EDC yang menerima kartu. Pilih metode lain.",
    terminalsErrorTitle: "Daftar mesin EDC belum bisa dimuat",
    terminalsError: "Periksa koneksi, lalu coba lagi.",
    terminalLockedHint: "Percobaan sebelumnya memakai mesin ini.",
    startHint:
      "Server mengirim nominal tagihan ke mesin. Pelanggan menempel atau memasukkan kartu di mesin.",
    start: "Kirim {amount} ke mesin EDC",
    sendingTitle: "Mengirim ke mesin EDC…",
    sendingHint: "Tunggu mesin menampilkan nominal. Jangan kirim ulang.",
    pendingTitle: "Menunggu pelanggan di mesin EDC",
    pending: "Mesin sedang memproses kartu. Status diperiksa otomatis.",
    checkMachineTitle: "Cek di mesin",
    checkMachine:
      "Lihat layar dan slip mesin EDC. Bila mesin sudah selesai tetapi status di sini tetap belum pasti, minta supervisor menyelesaikannya dengan hasil dari mesin.",
    otherDevice:
      "Transaksi ini dimulai dari perangkat lain. Selesaikan dari perangkat itu, atau minta bagian keuangan memeriksanya.",
    notReady:
      "Mesin EDC tidak terhubung ke kasir ini. Tidak ada transaksi yang dikirim. Pilih metode lain.",
    status: {
      approved: "Disetujui",
      pending: "Menunggu",
      unknown: "Belum pasti",
      declined: "Ditolak",
      cancelled: "Dibatalkan",
      failed: "Gagal",
    },
  },
  review: {
    pill: "Perlu supervisor",
    title: "Pembayaran perlu diperiksa supervisor",
    hint: "Data pembayaran tidak cocok dengan tagihan. Jangan terima uang lagi untuk tagihan ini.",
  },
  resolve: {
    action: "Minta supervisor menyelesaikan",
    title: "Selesaikan percobaan pembayaran",
    summaryCash:
      "Percobaan tunai {amount} belum ada jawaban server. Bila sudah tercatat, tagihan lunas. Bila belum, percobaan ditutup dan tidak bisa tercatat lagi.",
    summaryEdc:
      "Transaksi EDC {amount} belum ada jawaban pasti. Server memeriksa transaksinya; tagihan hanya lunas bila bank menyetujui atau slip membuktikannya.",
    statementLabel: "Hasil di mesin EDC",
    statementHint: "Cek layar dan slip mesin sebelum memilih.",
    statementPlaceholder: "Pilih hasil di mesin",
    statementFailed: "Kartu tidak terdebet",
    statementPaid: "Kartu terdebet, ada slip",
    slipRrn: "RRN di slip",
    slipApproval: "Kode approval di slip",
    slipAmount: "Nominal di slip",
    slipAmountHint:
      "Ketik persis seperti tercetak. Server mencocokkannya dengan tagihan.",
    statementRequired: "Pilih hasil di mesin EDC dulu.",
    slipRequired: "Isi RRN, kode approval, dan nominal dari slip EDC.",
    recordedTitle: "Percobaan sudah tercatat",
    closedTitle: "Percobaan ditutup",
    closed:
      "Tidak ada uang yang tercatat dari percobaan itu, dan tidak akan tercatat lagi. Pilih metode untuk menagih.",
  },
  unknown: {
    title: "Status penagihan belum dapat dipastikan",
    hint: "Periksa status terbaru sebelum mencoba lagi agar pembayaran tidak tercatat dua kali.",
    check: "Periksa status",
    checking: "Memeriksa status…",
    notRecordedTitle: "Penagihan belum tercatat",
    notRecorded:
      "Status sudah diperiksa dan tidak ada uang yang tercatat. Anda dapat mencoba lagi dengan aman.",
  },
  failed: {
    title: "Penagihan belum berhasil",
    hint: "Tidak ada uang yang tercatat. Periksa pesan di bawah, lalu coba lagi.",
  },
  success: {
    paidAmount: "Selisih dibayar",
    title: "Penagihan tercatat",
    hint: "Tunai {amount} tercatat di shift aktif. Selisih penggantian menu sudah lunas.",
    settledHint: "Selisih {amount} sudah lunas.",
    action: "Kembali ke pesanan",
  },
  closed: {
    title: "Tagihan selisih sudah ditutup",
    hint: "Tagihan ini tidak lagi menunggu pembayaran. Tidak ada uang yang perlu diterima.",
  },
} as const;
