// "Catat refund manual" texts (back office > Pembayaran > Refund), card 1259 /
// legend-xd2q. Register as `paymentAdmin.manualSettle`.
export const paymentManualSettleMessages = {
  open: "Catat refund manual",
  title: "Catat refund manual",
  stepRecord: "Langkah 1 dari 2: isi bukti pembayaran",
  stepConfirm: "Langkah 2 dari 2: periksa lalu konfirmasi",
  warnTitle: "Catat hanya bila uang sudah dikirim ke pembeli",
  warnBody:
    "Pencatatan ini menutup refund sebagai dibayar di luar penyedia dan tidak bisa dibatalkan. Tanpa bukti transfer, jangan dicatat. Bila ragu penyedia sudah membayar, cek dashboard Duitku lebih dulu agar pembeli tidak dibayar dua kali.",
  mfaHint:
    "Pencatatan ini meminta verifikasi dua langkah (MFA). Bila ditolak, masuk ulang dengan verifikasi dua langkah, lalu coba lagi.",
  amountLabel: "Jumlah refund",
  paidAt: "Tanggal dan jam transfer",
  channel: "Cara pembayaran",
  channelPlaceholder: "Pilih cara pembayaran",
  channels: {
    bank_transfer: "Transfer bank",
    cash: "Tunai",
    ewallet: "Dompet digital",
    provider_dashboard: "Dashboard penyedia",
    other: "Lainnya",
  },
  externalReference: "Referensi transfer",
  externalReferenceHint:
    "Nomor bukti transfer atau kuitansi, 3 sampai 100 karakter. Bukan nomor rekening pembeli.",
  amountPaid: "Jumlah yang dibayar (Rp)",
  amountPaidHint: "Harus sama persis dengan jumlah refund.",
  note: "Catatan",
  notePlaceholder: "Contoh: transfer manual atas persetujuan manajer.",
  review: "Periksa",
  back: "Kembali",
  confirmTitle: "Periksa sebelum mencatat",
  confirmBody:
    "Pastikan semua isian sama dengan bukti transfer. Setelah dicatat, refund selesai dan tidak dikirim lagi oleh penyedia.",
  confirmSubmit: "Ya, catat refund manual",
  done: "Refund {reference} dicatat sebagai dibayar manual.",
  failed: "Pencatatan belum berhasil. Status refund tidak berubah.",
  error: {
    paidAt:
      "Isi tanggal dan jam transfer: tidak sebelum refund diajukan dan tidak di masa depan.",
    channel: "Pilih cara pembayaran.",
    externalReference: "Isi referensi transfer, 3 sampai 100 karakter.",
    amount: "Isi jumlah yang dibayar dalam rupiah.",
    amountMismatch:
      "Jumlah harus sama persis dengan jumlah refund. Bila beda, jangan dicatat.",
    note: "Tulis catatan, 3 sampai 500 karakter.",
  },
  refusal: {
    notSettleable:
      "Hanya refund yang sudah disetujui dan belum selesai yang bisa dicatat manual. Muat ulang daftar refund.",
    atProvider:
      "Refund ini sudah dipegang penyedia. Jangan transfer; biarkan pengecekan otomatis menyelesaikannya.",
    payoutInFlight:
      "Ada percobaan kirim yang masih berjalan. Tunggu beberapa menit, lalu coba lagi.",
    amountMismatch:
      "Jumlah tidak sama dengan jumlah refund. Periksa bukti transfer; jangan dicatat bila beda.",
    providerPaid:
      "Penyedia sudah mengembalikan dana ini. Jangan transfer lagi; refund akan selesai sendiri.",
    providerPending:
      "Penyedia masih memproses refund ini. Tunggu hasilnya; pencatatan manual belum boleh.",
    providerUnknown:
      "Status di penyedia belum bisa dipastikan. Hubungi Duitku untuk memastikan, lalu coba lagi.",
    lookupStale:
      "Data refund berubah saat penyedia ditanya. Ulangi pencatatan.",
    capExceeded: "Refund melebihi sisa yang boleh direfund. Jangan dibayar.",
    providerRefunded:
      "Penyedia sudah mengembalikan dana ke pembeli. Jangan transfer dan jangan dicatat; tutup lewat jalur release.",
    sameActor:
      "Pemohon refund tidak boleh mencatatnya sendiri. Minta rekan lain yang berwenang.",
    mfaRequired:
      "Verifikasi dua langkah (MFA) diperlukan. Masuk ulang dengan verifikasi dua langkah, lalu coba lagi.",
    paidAtWindow:
      "Tanggal transfer harus di antara waktu refund diajukan dan sekarang.",
  },
} as const;
