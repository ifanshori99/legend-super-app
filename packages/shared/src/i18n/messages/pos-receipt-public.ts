// Public e-receipt page texts (bead legend-1uk9 · PRD v1.7 §3 F11 "Struk &
// Kuitansi", POS-07). Opened from the link or QR on a receipt, no sign-in.
// Namespace: `posReceiptPublic` (the agent registers it in id.ts).
export const posReceiptPublicMessages = {
  pageTitle: "Struk elektronik",
  mockNote: "Contoh data · Mockup",
  title: {
    receipt: "Struk elektronik",
    kuitansi: "Kuitansi",
  },
  meta: "{number} · {when}",
  status: {
    issued: "Lunas",
    voided: "Dibatalkan",
  },
  reprint: "Cetak ulang",
  outlet: "Outlet",
  orderLabel: "Rincian pesanan",
  lineCount: "{count} × {name}",
  unitPrice: "{price} / item",
  note: "Catatan: {note}",
  extras: "Tambahan {amount}",
  subtotal: "Subtotal",
  discount: "Diskon",
  service: "Biaya layanan",
  tax: "Pajak",
  rounding: "Pembulatan",
  total: "Total",
  payment: "Pembayaran",
  deposit: "Uang muka (DP)",
  paid: "Jumlah dibayar",
  /** 1272 K4: guest service fee of an online code, not part of the order. */
  guestFee: "Biaya layanan pembayaran",
  tender: {
    cash: "Tunai",
    qris: "QRIS",
    va: "Virtual account",
    ewallet: "E-wallet",
    card: "Kartu",
    edc_card: "Kartu (EDC)",
    edc_qris: "QRIS (EDC)",
    points: "Poin",
  },
  downloadReceipt: "Unduh struk PDF",
  downloadKuitansi: "Unduh kuitansi PDF",
  thanks: "Terima kasih telah berkunjung.",
  loading: "Memuat struk elektronik…",
  loadingLabel: "Memuat struk",
  error: {
    title: "Struk belum dapat dimuat",
    hint: "Periksa koneksi internet Anda, lalu coba lagi.",
    retry: "Coba lagi",
  },
  invalid: {
    title: "Tautan struk tidak tersedia",
    hint: "Tautan tidak valid atau sudah tidak berlaku. Hubungi outlet untuk meminta struk kembali.",
  },
} as const;
