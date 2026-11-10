// WS-10 payslip PIN "Lupa PIN?" screen (bead legend-ilzrj, slice S3): copy the
// base file ws10-payslip-pin.ts does not have. Keys: payslipPinForgot.*
export const payslipPinForgotMessages = {
  pageTitle: "Lupa PIN slip gaji",
  requestErrorTitle: "Kode belum dapat dikirim",
  requestError: "Periksa koneksi Anda, lalu coba lagi.",
  unavailableNotice:
    "Fitur ini sedang disiapkan. Hubungi HR atau atasan di outlet untuk mereset PIN Anda.",
  codeHint: "Masukkan 6 angka dari pesan WhatsApp.",
  codeIncomplete: "Kode harus 6 angka.",
  newPinHint: "Ini menjadi PIN slip gaji Anda yang baru.",
  codeInvalid: "Kode salah atau sudah kedaluwarsa.",
  resend: "Kirim ulang kode",
  newCode: "Kirim kode baru",
  verifyErrorTitle: "Kode belum dapat diperiksa",
  verifyError: "Periksa koneksi Anda, lalu coba lagi.",
  lockedTitle: "Terlalu banyak percobaan",
  lockedBody:
    "Kode sudah tidak berlaku karena terlalu banyak salah. Minta kode baru.",
  notSetTitle: "PIN belum dibuat",
  notSetBody: "Buat PIN baru saat membuka slip gaji.",
  doneSide: "PIN baru sudah aktif. HR tidak mengetahui PIN Anda.",
} as const;
