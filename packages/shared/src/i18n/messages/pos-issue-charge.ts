// POS cashier texts for collecting a dearer-swap difference (bead legend-shabi).
// id.ts imports it as `posIssueCharge`.
export const posIssueChargeMessages = {
  screen: {
    title: "Tagih selisih",
    subtitle: "Periksa penggantian menu sebelum melanjutkan pembayaran.",
    back: "Kembali ke pesanan",
    backTables: "Kembali ke daftar meja",
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
    unsure: "Belum pasti",
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
    action: "Catat tunai diterima {amount}",
    pending: "Memproses…",
    recording: "Mencatat penagihan…",
    recordingHint: "Jangan ulangi tindakan sampai status diperbarui.",
  },
  method: {
    legend: "Metode pembayaran",
    cash: "Tunai",
    qris: "QRIS",
    edc_card: "EDC kartu",
    lockedTitle: "Selesaikan pembayaran {method} yang tadi dulu",
    lockedHint:
      "Sistem belum tahu hasil pembayaran {method} yang tadi. Mengulangnya aman: tidak akan tercatat dua kali.",
    lockedOthers: "Metode lain terbuka sesudah pembayaran itu selesai.",
    lockedResolveHint:
      "Bila pembayaran itu tidak diulang, minta supervisor menyelesaikannya.",
  },
  precheck: {
    title: "Tagihan belum bisa dibaca",
    hint: "Tidak ada yang dikirim. Periksa koneksi, lalu coba lagi. Metode yang terkunci tetap terkunci.",
  },
  waiting: {
    pill: "Menunggu",
    locked: "Metode lain terkunci sampai sistem memastikan hasilnya.",
    stale:
      "Status terbaru belum bisa diambil. Jangan terima pembayaran lain, periksa koneksi.",
    staleTitle: "Status belum bisa diperbarui",
  },
  qris: {
    start: "Buat QRIS {amount}",
    startHint:
      "Kode QRIS memakai nominal tagihan. Pelanggan memindai kode di layar ini.",
    renew: "Buat QRIS baru {amount}",
    waitingTitle: "Menunggu pembayaran pelanggan",
    codeLabel: "Kode QRIS tagihan selisih",
    validFor: "Berlaku {time} lagi",
    timeUpTitle: "Waktu kode habis",
    timeUp:
      "Kode tidak ditampilkan lagi. Sistem sedang memastikan kode belum dibayar.",
    otherTitle: "Pelanggan sedang membayar lewat aplikasi",
    expiredTitle: "Kode QRIS kedaluwarsa",
    expired: "Sistem memastikan kode lama belum dibayar. Buat kode baru.",
    failedTitle: "Pembayaran QRIS gagal",
    failed:
      "Sistem memastikan tidak ada uang masuk. Buat kode baru atau pilih metode lain.",
    confirmingTitle: "QRIS sudah dibayar",
    confirming:
      "Menunggu tagihan ditandai lunas. Jangan terima pembayaran lain.",
  },
  edc: {
    approvedPill: "Disetujui bank",
    legend: "Transaksi EDC tagihan ini",
    emptyTitle: "Belum ada transaksi EDC yang disetujui",
    empty:
      "Hanya transaksi EDC untuk tagihan ini yang bisa dipakai. Muat ulang setelah mesin selesai.",
    reload: "Muat ulang transaksi",
    terminal: "Terminal EDC",
    record: "Catat EDC {amount}",
    waitingTitle: "Hasil EDC belum pasti",
    waiting:
      "Jangan gesek atau tagih ulang. Status diperiksa otomatis; cek juga di mesin.",
    pick: "Transaksi yang disetujui bank dipilih otomatis. Nominal tidak diketik di sini.",
    pickMany:
      "Pilih transaksi yang disetujui bank. Nominal tidak diketik di sini.",
    notUsable: {
      amount: "Nominal tidak sama dengan tagihan",
      review: "Perlu dicek bagian keuangan",
      status: "Tidak bisa dipakai untuk tagihan ini",
    },
    terminalLegend: "Mesin EDC",
    terminalsLoading: "Memuat mesin EDC…",
    terminalsEmptyTitle: "Belum ada mesin EDC kartu",
    terminalsEmpty:
      "Outlet ini belum punya mesin EDC yang menerima kartu. Pilih metode lain.",
    terminalsErrorTitle: "Daftar mesin EDC belum bisa dimuat",
    terminalsError: "Periksa koneksi, lalu coba lagi.",
    terminalLockedHint: "Percobaan sebelumnya memakai mesin ini.",
    startHint:
      "Nominal tagihan dikirim ke mesin. Pelanggan menempel atau memasukkan kartu di mesin.",
    start: "Kirim {amount} ke mesin EDC",
    sendingTitle: "Mengirim ke mesin EDC…",
    sendingHint: "Tunggu mesin menampilkan nominal. Jangan kirim ulang.",
    pendingPill: "Menunggu pelanggan",
    pendingTitle: "Kartu sedang diproses di mesin",
    pending: "Tunggu sampai mesin selesai. Status diperiksa otomatis.",
    checkMachineTitle: "Cek di mesin",
    checkMachine:
      "Lihat layar dan slip mesin EDC. Bila mesin sudah selesai tetapi di sini tetap belum pasti, minta supervisor menyelesaikannya.",
    otherDevice:
      "Transaksi ini dimulai dari perangkat lain. Selesaikan dari perangkat itu, atau minta bagian keuangan memeriksanya.",
    notReady:
      "Mesin EDC tidak terhubung ke kasir ini, jadi kartu belum bisa dimulai dari sini. Periksa status dulu; bila tidak ada transaksi, minta supervisor menutup pembayaran tadi, lalu terima dengan QRIS atau tunai. Bila kartu sudah terdebit di mesin, supervisor mencatat slipnya lewat penyelesaian.",
    status: {
      approved: "Disetujui",
      pending: "Diproses mesin",
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
    steps:
      "Panggil supervisor ke kasir ini dan tunjukkan layar ini. Supervisor atau bagian keuangan memeriksanya di Rekonsiliasi EDC.",
  },
  resolve: {
    action: "Minta supervisor",
    title: "Selesaikan pembayaran yang tadi",
    summaryCash:
      "Hasil pembayaran tunai {amount} yang tadi belum pasti. Bila sudah tercatat, tagihan lunas. Bila belum, pembayaran itu ditutup dan tidak bisa tercatat lagi.",
    summaryEdc:
      "Hasil transaksi EDC {amount} belum pasti. Tagihan hanya lunas bila bank menyetujui atau slip membuktikannya.",
    pendingClose: "Tutup sambil menunggu",
    statementLabel: "Hasil di mesin EDC",
    statementHint: "Cek layar dan slip mesin sebelum memilih.",
    statementPlaceholder: "Pilih hasil di mesin",
    statementFailed: "Kartu tidak terdebet",
    statementPaid: "Kartu terdebet, ada slip",
    slipRrn: "RRN di slip",
    slipApproval: "Kode approval di slip",
    slipAmount: "Nominal di slip",
    slipAmountHint:
      "Ketik persis seperti tercetak. Sistem mencocokkannya dengan tagihan.",
    statementRequired: "Pilih hasil di mesin EDC dulu.",
    slipRequired: "Isi RRN, kode approval, dan nominal dari slip EDC.",
    rrnInvalid: "Isi RRN dari slip: huruf dan angka saja, maksimal 24.",
    approvalInvalid:
      "Isi kode approval dari slip: huruf dan angka saja, maksimal 12.",
    amountInvalid: "Isi nominal yang tercetak di slip.",
    approverRequired: "Pilih supervisor yang menyetujui.",
    approversNone:
      "Belum ada supervisor lain yang bisa menyetujui di outlet ini.",
    timeout:
      "Sistem belum menjawab. Status dibaca ulang; buka dialog ini lagi bila masih perlu.",
    recordedTitle: "Pembayaran tadi sudah tercatat",
    closedTitle: "Pembayaran tadi ditutup",
    closed:
      "Tidak ada uang yang tercatat dari pembayaran itu, dan tidak akan tercatat lagi. Pilih metode untuk menagih.",
  },
  unknown: {
    title: "Status penagihan belum dapat dipastikan",
    hint: "Periksa status terbaru sebelum mencoba lagi agar pembayaran tidak tercatat dua kali.",
    check: "Periksa status",
    checking: "Memeriksa status…",
    checkedAt:
      "Sudah diperiksa pukul {time}. Belum ada kabar dari mesin atau bank.",
    checkFailed: "Status belum bisa dibaca. Periksa koneksi, lalu coba lagi.",
    heldTitle: "Pembayaran lain masih menunggu hasil",
    held: "Selesaikan pembayaran yang tadi dulu sebelum memakai metode lain.",
    changedTitle: "Tagihan berubah",
    changed:
      "Tagihan berubah sejak layar dibuka. Periksa lagi sebelum menagih.",
    notRecordedTitle: "Penagihan belum tercatat",
    notRecorded:
      "Status sudah diperiksa dan tidak ada uang yang tercatat. Anda bisa mencoba lagi dengan aman.",
  },
  failed: {
    title: "Penagihan belum berhasil",
    hint: "Tidak ada uang yang tercatat.",
  },
  error: {
    generic:
      "Permintaan belum bisa diproses. Periksa status, lalu coba lagi. Bila terulang, panggil supervisor.",
    pinInvalid: "PIN supervisor salah. Coba lagi.",
    pinLocked:
      "PIN supervisor terkunci sementara. Minta supervisor lain atau coba lagi nanti.",
    throttled: "Terlalu banyak percobaan. Tunggu sebentar, lalu coba lagi.",
    conflict:
      "Tagihan sedang diproses atau sudah berubah. Periksa status, lalu coba lagi.",
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
