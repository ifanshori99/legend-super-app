// WS-10 payslip PIN change screen (bead legend-ilzrj, slice S4; mockup
// design/mockups/payslip-pin/ubah-pin). Extra keys only; the shared PIN copy
// lives in ws10-payslip-pin.ts. Keys: payslipPin.change.* (merged next to payslipPin.* in id.ts)
export const payslipPinChangeMessages = {
  change: {
    currentWrong: "PIN saat ini salah.",
    currentWrongLeft: "PIN saat ini salah. Sisa {count} percobaan.",
    currentRequired: "Masukkan PIN saat ini (6 angka).",
    sameAsCurrent: "PIN baru harus berbeda dari PIN saat ini.",
    statusErrorTitle: "Status PIN tidak dapat dimuat",
    statusErrorHint: "Periksa koneksi Anda, lalu coba lagi.",
    notSetTitle: "PIN belum dibuat",
    notSetHint: "Buat PIN lebih dulu saat membuka slip gaji.",
    networkError: "Koneksi terputus. Periksa jaringan Anda, lalu coba lagi.",
    unknownError: "PIN belum dapat diubah. Coba lagi.",
    notFoundError: "Data PIN tidak ditemukan. Muat ulang halaman ini.",
    rateLimitedError: "Terlalu banyak percobaan. Coba lagi beberapa saat lagi.",
    unavailableError: "Layanan sedang tidak tersedia. Coba lagi nanti.",
    successTitle: "PIN berhasil diubah",
    successDescription: "Gunakan PIN baru untuk membuka slip gaji berikutnya.",
  },
} as const;
