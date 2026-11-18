// POS cashier texts: member points redemption panel (brief 936, bead legend-5w6).
// id.ts imports it as `posKasirPoints`.
export const posKasirPointsMessages = {
  title: "Tukar poin",
  loading: "Memuat poin member",
  memberLabel: "Member",
  balanceLabel: "Saldo poin",
  balanceValue: "{points} poin",
  pointsLabel: "Jumlah poin",
  pointsHint:
    "Isi antara {min} dan {max} poin. Nilai rupiah dihitung oleh server.",
  maxButton: "Maks",
  outOfRange: "Jumlah poin harus antara {min} dan {max}.",
  quoteButton: "Hitung nilai",
  quoting: "Menghitung...",
  quoteResult: "{points} poin bernilai {amount}",
  quoteHint: "Nilai dari server. Dipotong dari sisa tagihan saat poin ditukar.",
  quoteError: "Nilai poin belum bisa dihitung",
  redeemButton: "Tukar poin",
  redeeming: "Menukar...",
  errorRecovery:
    "Periksa koneksi lalu coba lagi. Bila tetap gagal, pilih metode bayar lain.",
  redeemError: "Poin belum bisa ditukar",
  cancel: "Batal",
  noMemberTitle: "Pesanan ini belum punya member",
  noMemberBody: "Pilih member di pesanan dulu, lalu tukar poinnya di sini.",
  loadError: "Poin member belum bisa dimuat",
  loadErrorHint: "Periksa koneksi, lalu coba lagi.",
  retry: "Coba lagi",
  contractPending: "Tukar poin belum tersambung",
  contractPendingHint:
    "Layanan poin di kasir belum tersedia di server. Pilih metode bayar lain.",
};
