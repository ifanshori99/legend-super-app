// POS cashier texts shared by every screen (bead legend-mjmm; PRD v1.7 §3 F8
// "Shift & Tutup Hari", §3 F11 "POS Kasir"): menu labels and the common bits
// of the shared components. One catalog file per screen group so the parallel
// screen beads never edit the same lines; id.ts imports it as `posKasirCommon`.
export const posKasirCommonMessages = {
  nav: {
    code: "Kode bayar",
    shift: "Shift kasir",
    dayClose: "Tutup hari",
  },
  bill: {
    unpaid: "Belum lunas",
    paid: "Lunas",
    summary: "Pesanan {orderNo} · {items} item · {guests} tamu",
    subtotal: "Subtotal",
    service: "Service",
    tax: "Pajak",
    total: "Total tagihan",
    depositUsed: "DP reservasi terpakai",
    depositPaid: "DP lunas · {reference}",
    depositUnpaid: "DP belum lunas · {reference}",
    confirmed: "{label} terkonfirmasi",
    remaining: "Sisa yang harus dibayar",
    remainingPaid: "Sisa bayar",
  },
  keypad: {
    backspace: "Hapus angka terakhir",
    quickAmounts: "Nominal cepat",
  },
  denomination: {
    other: "Pecahan lain & koin",
    otherHint: "Isi nominal gabungan",
  },
  pinDialog: {
    reasonLabel: "Alasan",
    reasonRequired: "Alasan wajib diisi.",
    reasonTooShort: "Alasan minimal {min} karakter.",
    pinLabel: "PIN supervisor",
    cancel: "Batal",
    checking: "Memeriksa PIN…",
  },
};
