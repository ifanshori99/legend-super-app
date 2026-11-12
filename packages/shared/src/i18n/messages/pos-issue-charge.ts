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
    pendingTitle: "Fitur ini belum tersambung ke server",
    pendingHint:
      "Rincian tagihan selisih belum tersedia di lingkungan ini. Hubungi admin outlet.",
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
  },
  collect: {
    title: "Penagihan selisih",
    hint: "Penagihan ini dicatat sebagai pembayaran tunai, terpisah dari pesanan awal.",
    difference: "Selisih",
    receive: "Terima tunai {amount}",
    receiveHint: "Pastikan uang sudah diterima sebelum mencatat penagihan.",
    action: "Tagih selisih · Tunai {amount}",
    pending: "Memproses…",
    recording: "Mencatat penagihan…",
    recordingHint: "Jangan ulangi tindakan sampai status diperbarui.",
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
    action: "Kembali ke pesanan",
  },
  closed: {
    title: "Tagihan selisih sudah ditutup",
    hint: "Tagihan ini tidak lagi menunggu pembayaran. Tidak ada uang yang perlu diterima.",
  },
} as const;
