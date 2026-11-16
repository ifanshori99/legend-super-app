// POS cashier texts: voucher panel (redeem/scan code, server-priced discount) (brief 936, bead legend-5w6).
// id.ts imports it as `posKasirVoucher`.
export const posKasirVoucherMessages = {
  title: "Voucher",
  codeLabel: "Kode voucher",
  codePlaceholder: "Ketik atau scan kode",
  scanHint:
    "Arahkan scanner ke kode voucher pelanggan. Kode terbaca otomatis, tekan Enter bila perlu.",
  check: "Cek",
  checking: "Mengecek...",
  apply: "Pakai voucher",
  applying: "Memakai...",
  cancel: "Batal",
  valid: {
    title: "Voucher berlaku",
    discount: "Potongan {amount}",
    estimateHint:
      "Perkiraan, dihitung ulang server saat voucher dipakai. Total akhir mengikuti angka server.",
  },
  invalid: {
    title: "Voucher tidak bisa dipakai",
    reason: {
      not_found: "Kode tidak ditemukan. Periksa kode lalu cek lagi.",
      not_started: "Voucher belum berlaku.",
      expired: "Voucher sudah kedaluwarsa.",
      already_redeemed: "Voucher ini sudah dipakai.",
      cancelled: "Voucher ini sudah dibatalkan.",
      customer_mismatch: "Voucher ini milik pelanggan lain.",
      min_spend_not_met: "Belanja belum mencapai minimum voucher.",
      channel_not_allowed: "Voucher tidak berlaku di kasir.",
      quota_exhausted: "Kuota voucher sudah habis.",
      not_applicable: "Voucher tidak berlaku untuk pesanan ini.",
    },
  },
  checkError: "Voucher belum bisa dicek",
  checkErrorHint:
    "Periksa koneksi, lalu tekan Cek lagi. Bila tetap gagal, panggil supervisor.",
  applyError: "Voucher belum bisa dipakai",
  applyErrorHint:
    "Tagihan tidak berubah. Tekan Pakai voucher lagi, atau cek ulang kodenya.",
  contractPending: "Voucher belum tersambung ke server",
  contractPendingHint:
    "Voucher belum bisa dipakai di kasir. Lanjutkan dengan metode pembayaran lain.",
};
