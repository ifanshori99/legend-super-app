// Guest e-wallet and card payment through Duitku's page, and the single return
// page `/bayar/kembali` (C2b, legend-osqou.4; design/mockups/c2b-tamu-bayar,
// approved by the founder 27 Nov). No fee line: a guest fee waits for the
// founder's legal decision (docs/design/duitku-fee-passthrough.md §0).
export const paymentRedirectMessages = {
  method: {
    ewallet: "E-wallet",
    ewalletLegend: "Aplikasi e-wallet",
    ewalletNote:
      "Anda dibawa ke halaman {wallet} untuk menyetujui pembayaran, lalu kembali ke sini.",
    card: "Kartu kredit atau debit",
    cardHint: "Visa atau Mastercard",
    ewalletHint: "Bayar lewat aplikasi e-wallet",
    pickWallet: "Pilih aplikasi e-wallet dulu.",
    cardNote:
      "Nomor kartu diisi di halaman pembayaran Duitku. {place} tidak melihat atau menyimpan data kartu Anda.",
    cardNoteNoPlace:
      "Nomor kartu diisi di halaman pembayaran Duitku. Outlet tidak melihat atau menyimpan data kartu Anda.",
    reset: "{method} sedang tidak tersedia, jadi metode bayar diganti ke QRIS.",
    ctaWallet: "Bayar {total} dengan {wallet}",
    ctaCard: "Bayar {total} dengan kartu",
  },
  cardName: "kartu",
  cardPage: "pembayaran kartu",
  opening: {
    title: "Bayar dengan {method}",
    heading: "Membuka halaman {method}…",
    readyHeading: "Lanjutkan di halaman {method}",
    totalLabel: "Total pembayaran",
    orderRow: "Pesanan",
    orderValue: "{number} · Meja {table}",
    billRow: "Tagihan",
    step1Wallet: "Setujui pembayaran di {wallet}",
    step1Card: "Isi data kartu di halaman pembayaran",
    step1Hint: "Pastikan nominalnya {total}.",
    step2: "Anda kembali ke halaman ini",
    step2Hint: "Otomatis setelah pembayaran selesai.",
    step3Order: "Pesanan masuk dapur",
    step3Link: "Tagihan tercatat lunas",
    step3Hint: "Setelah pembayaran kami terima.",
    partner: "Halaman berikutnya milik Duitku, mitra pembayaran {place}.",
    partnerNoPlace: "Halaman berikutnya milik Duitku, mitra pembayaran kami.",
    open: "Buka halaman {method}",
    cancelOrder: "Kembali ke pesanan",
    cancelLink: "Batal, pilih metode lain",
    failedPill: "Belum terbuka",
    failedTitle: "Halaman {method} belum bisa dibuka",
    failedLeadOrder:
      "Anda belum membayar apa pun. Pesanan masih tersimpan, coba lagi atau pilih metode lain.",
    failedLeadLink:
      "Anda belum membayar apa pun. Coba lagi atau pilih metode lain.",
    retry: "Coba buka lagi",
    otherMethod: "Pilih metode lain",
  },
  back: {
    headTitle: "Status pembayaran",
    title: "Status pembayaran",
    deskContext: "Meja {table} · Status pembayaran",
    rowMethod: "Metode",
    rowOrder: "Pesanan",
    rowPlace: "Tempat",
    rowReceived: "Diterima",
    placeTable: "{place} · Meja {table}",
    tableOnly: "Meja {table}",
    totalLabel: "Total pembayaran",
    paidLabel: "Total dibayar",
    unpaidLabel: "Belum dibayar",
    checkingPill: "Memeriksa",
    checkingTitle: "Memeriksa pembayaran…",
    checkingLead:
      "Sebentar, kami menanyakan statusnya langsung ke sistem pembayaran.",
    waitingPill: "Menunggu konfirmasi",
    waitingTitle: "Memastikan pembayaran Anda",
    waitingLeadWallet:
      "Konfirmasi dari {wallet} biasanya masuk dalam beberapa detik. Jangan bayar ulang.",
    waitingLeadCard:
      "Konfirmasi pembayaran kartu biasanya masuk dalam beberapa detik. Jangan bayar ulang.",
    autoCheck: "Diperiksa otomatis",
    lastChecked: "terakhir {seconds} detik lalu",
    lastCheckedNow: "baru saja diperiksa",
    slowPill: "Masih diproses",
    slowTitle: "Pembayaran masih diproses",
    slowLeadOrder:
      "Sudah lebih dari 1 menit. Bila Anda sudah membayar, pesanan diteruskan ke dapur begitu konfirmasi masuk. Halaman ini tetap memeriksa.",
    slowLeadLink:
      "Sudah lebih dari 1 menit. Bila Anda sudah membayar, tagihan tercatat lunas begitu konfirmasi masuk. Halaman ini tetap memeriksa.",
    noRepayTitle: "Jangan bayar ulang",
    noRepayOrder:
      "Supaya tidak terbayar dua kali. Bila ragu, tunjukkan kode {number} ke kasir.",
    noRepay: "Supaya tidak terbayar dua kali. Bila ragu, tanyakan ke kasir.",
    checkAgain: "Cek lagi",
    toOrders: "Lihat status pesanan",
    toBill: "Lihat tagihan",
    unreachablePill: "Belum terhubung",
    unreachableTitle: "Status belum bisa diperiksa",
    unreachableLeadOrder:
      "Sambungan terputus atau sistem sedang sibuk. Pembayaran Anda tidak hilang, dan kami belum tahu hasilnya.",
    unreachableLeadLink:
      "Sambungan terputus atau sistem sedang sibuk. Pembayaran Anda tidak hilang, dan kami belum tahu hasilnya.",
    ordersPill: "Dibuka di tab lain",
    ordersTitle: "Cek status pesanan Anda",
    ordersLead:
      "Halaman ini terbuka di tab atau browser lain, jadi status pembayarannya tidak bisa ditampilkan di sini. Pembayaran yang sudah masuk tetap tercatat.",
    refundedPill: "Dikembalikan",
    refundedTitle: "Pembayaran sudah dikembalikan",
    refundedLead:
      "Pembayaran ini sudah dikembalikan, seluruhnya atau sebagian. Tanyakan ke kasir untuk rinciannya.",
    refundedLabel: "Nominal pembayaran",
    paidPill: "Lunas",
    paidTitle: "Pembayaran berhasil",
    paidLeadOrder: "Terima kasih. Pesanan Anda diteruskan ke dapur.",
    paidLeadLink: "Terima kasih. Tagihan Anda sudah lunas.",
    paidNoteTitle: "Ikuti pesanan Anda",
    paidNote: "Perkembangannya ada di status pesanan.",
    failedPill: "Tidak selesai",
    failedTitle: "Pembayaran belum selesai",
    failedLeadOrder:
      "Pembayaran dengan {method} dibatalkan atau tidak disetujui. Pesanan belum dibayar dan belum masuk dapur.",
    failedLeadLink:
      "Pembayaran dengan {method} dibatalkan atau tidak disetujui. Tagihan belum dibayar.",
    cartKeptTitle: "Pesanan masih tersimpan",
    cartKept: "Anda bisa bayar lagi dengan metode lain.",
    chooseOther: "Pilih metode lain",
    retryWith: "Coba lagi dengan {method}",
    retrying: "Membuka…",
    retryFailed:
      "Pembayaran baru belum bisa dibuat. Pilih metode lain atau coba lagi.",
    expiredPill: "Waktu habis",
    expiredTitle: "Waktu pembayaran habis",
    expiredLeadOrder:
      "Pembayaran ini sudah tidak bisa dipakai dan belum ada uang yang kami terima. Pesanan masih tersimpan.",
    expiredLeadLink:
      "Pembayaran ini sudah tidak bisa dipakai dan belum ada uang yang kami terima.",
    newPayment: "Buat pembayaran baru",
    toCart: "Kembali ke pesanan",
    invalidPill: "Tidak dikenali",
    invalidTitle: "Tautan ini tidak dikenali",
    invalidLead:
      "Kami tidak menemukan pembayaran dari tautan ini. Tautan mungkin terpotong atau sudah lama.",
    invalidStep1: "Pindai lagi QR di meja",
    invalidStep1Hint: "Status pembayaran pesanan Anda ada di sana.",
    invalidStep2: "Jangan bayar ulang dulu",
    invalidStep2Hint: "Periksa status pesanan sebelum membayar lagi.",
    invalidStep3: "Masih ragu?",
    invalidStep3Hint: "Tanyakan ke kasir atau pelayan.",
    reopen: "Coba buka lagi",
  },
} as const;
