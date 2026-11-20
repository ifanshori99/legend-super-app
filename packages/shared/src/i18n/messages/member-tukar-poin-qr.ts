// Member "Tukar poin di kasir" (legend-0ne0z, slice D): the QR step and the
// three outcomes around it (expired, failed, consumed). Spread into
// `member.tukarPoin` by id.ts, so keys read `member.tukarPoin.qr.*`.
export const memberTukarPoinQrMessages = {
  qr: {
    // Active QR
    activeEyebrow: "QR penukaran · Sekali pakai",
    activeTitle: "Tunjukkan QR ke kasir",
    activeIntro: "Kasir memindai QR ini untuk memakai {points} poin.",
    qrLabel: "QR penukaran {points} poin untuk tagihan {bill}",
    timerLabel: "Berlaku selama",
    timerSr: "Sisa waktu QR {time}",
    onceHint:
      "QR berlaku 120 detik dan hanya dapat dipakai satu kali untuk tagihan ini.",
    endingSoon: "QR hampir kedaluwarsa. Tunjukkan ke kasir sekarang.",
    shareWarning:
      "Jangan bagikan QR atau tangkapan layarnya kepada orang lain.",
    changePoints: "Ubah jumlah poin",
    // Context (left column on desktop, disclosure on mobile)
    confirmEyebrow: "Konfirmasi penukaran",
    confirmTitle: "{points} poin · {value}",
    confirmSub: "Khusus tagihan yang sedang dibuka ini.",
    remainingNow: "Sisa tagihan saat ini",
    remainingAfter: "Sisa bayar setelah dipakai",
    balanceAfter: "Perkiraan sisa poin",
    pointsValue: "{points} poin",
    notDeducted: "Poin belum dipotong. Tunggu konfirmasi penukaran dari kasir.",
    detailsToggle: "Rincian tagihan dan poin",
    outletArea: "{outlet} · {area}",
    billRef: "Tagihan #{number}",
    billRefTable: "Tagihan #{number} · Meja {table}",
    // Expired
    expiredEyebrow: "Masa berlaku berakhir · 00:00",
    expiredTitle: "QR sudah kedaluwarsa",
    expiredBody:
      "QR {points} poin untuk tagihan ini tidak dapat dipakai lagi. Status penukaran belum dikonfirmasi.",
    expiredNote:
      "Masa berlaku QR tidak memastikan hasil penukaran. Periksa status, tagihan, dan saldo sebelum membuat QR baru.",
    chosenPoints: "Poin dipilih",
    discountValue: "Nilai potongan",
    checkStatus: "Periksa status",
    // Failed
    failedEyebrow: "Status belum dapat dipastikan",
    failedTitle: "QR belum dapat ditampilkan",
    failedBody:
      "Permintaan belum mendapat jawaban. Periksa status penukaran sebelum mencoba lagi.",
    failedNote:
      "QR disembunyikan sampai hasil dari server diterima. Jika kasir sudah memindai, minta kasir menunggu pemeriksaan status.",
    requestedPoints: "Jumlah diminta",
    failedRecheck: "Tagihan dan saldo akan diperiksa ulang.",
    checkRedeemStatus: "Periksa status penukaran",
    // Consumed
    consumedContextEyebrow: "Poin saya",
    consumedTitle: "{points} poin sudah digunakan",
    consumedTitleNeutral: "Poin sudah digunakan",
    consumedSub: "Penukaran dikonfirmasi oleh server untuk tagihan {outlet}.",
    balanceLeft: "Sisa poin tersedia",
    balanceMath: "{before} − {points} poin",
    consumedEyebrow: "Berhasil · QR sekali pakai",
    consumedPanelTitle: "Potongan masuk ke tagihan",
    remainingBefore: "Sisa tagihan sebelum poin",
    discountLine: "Potongan {points} poin",
    remainingBill: "Sisa tagihan",
    consumedNext:
      "Lanjutkan pembayaran {amount} di kasir. Status ini mengonfirmasi penukaran poin, bukan pelunasan tagihan.",
    consumedNote:
      "QR ini tidak dapat dipakai lagi. Saldo sudah berkurang tepat {points} poin.",
    consumedNoteNeutral:
      "QR ini tidak dapat dipakai lagi. Saldo poin sudah diperbarui.",
    backToPoints: "Kembali ke poin saya",
  },
} as const;
