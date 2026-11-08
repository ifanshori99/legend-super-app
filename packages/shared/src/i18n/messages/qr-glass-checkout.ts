// QR order "final arah A + liquid glass" texts, part: checkout (bead legend-2re1;
// design/mockups/README.md, founder Q3–Q6). One file per screen group so the
// parallel screen builds never edit the same lines.
export const qrGlassCheckoutMessages = {
  title: "Keranjang & bayar",
  back: "Kembali ke menu",
  tableShared: "Meja {table} · Keranjang bersama",
  // The contract cannot change a line's options yet (cart line patch takes
  // quantity and note only), so this adds the item again with other choices.
  editOptions: "Tambah pilihan lain",
  editOptionsAria: "{name} dengan pilihan berbeda",
  addMenu: "Tambah menu",
  codeToggle: "Kode promo / voucher",
  breakdownTitle: "Rincian bayar",
  service: "Service {rate}%",
  tax: "{name} {rate}%",
  awaitingOrderTitle: "Pesanan {number} menunggu pembayaran",
  awaitingOrderHint:
    "Pesanan belum masuk dapur. Pilih cara bayar untuk melanjutkan.",
  method: {
    title: "Metode bayar",
    qris: "QRIS",
    qrisHint: "Scan dari bank / e-wallet",
    ewallet: "E-wallet",
    ewalletHint: "Pilih aplikasi saat melanjutkan",
    va: "Virtual Account",
    vaHint: "Transfer dari m-banking / ATM",
    card: "Kartu kredit/debit",
    cardHint: "Visa, Mastercard, JCB",
    unavailableHint: "Belum tersedia untuk pesanan meja",
    cashier: "Bayar di kasir",
    cashierHint: "Tunjukkan kode ke kasir",
    kitchenNote: "Pesanan masuk dapur setelah pembayaran diterima.",
  },
  total: "Total pembayaran",
  codeNotCharged:
    "Potongan kode belum ikut dalam pembayaran ini. Yang dibayar: {total}.",
  blockedMinimum: "Tambah {shortfall} lagi untuk mencapai minimum pesanan.",
  cta: {
    qris: "Bayar {total} dengan QRIS",
    va: "Buat nomor Virtual Account",
    card: "Bayar {total} dengan kartu",
    ewallet: "Pilih e-wallet dan bayar",
    cashier: "Buat kode bayar di kasir",
  },
} as const;
