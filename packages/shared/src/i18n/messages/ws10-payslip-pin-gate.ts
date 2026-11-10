// Payslip PIN gate on the slip detail screen (bead legend-ilzrj, slice S2):
// copy the base file ws10-payslip-pin.ts does not carry. Keys: payslipPin.gate.*
export const payslipPinGateMessages = {
  gate: {
    loadingStatus: "Memeriksa status PIN…",
    statusErrorTitle: "Status PIN tidak dapat dimuat",
    statusErrorHint: "Periksa koneksi Anda, lalu coba lagi.",
    statusErrorSide: "Nominal gaji tidak ditampilkan sebelum PIN diperiksa.",
    wrongPinNoCount: "Periksa PIN dan coba lagi.",
  },
} as const;
