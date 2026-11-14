// WS-10 payslip PIN reset by WhatsApp (bead ur82k): copy of the choose, HR
// help, dead-end and new-PIN screens under wa-reset/. Keys: payslipWaReset.*
export const payslipWaResetMessages = {
  common: {
    backToSlip: "Kembali ke slip gaji",
    hrHelpLink: "Lihat cara minta bantuan",
    hrHelpTitle: "Minta bantuan HR atau supervisor",
    retry: "Coba lagi",
  },
  parts: {
    backLink: "Slip gaji",
    privateTitle: "PIN tetap pribadi",
    privateBody:
      "- HR bisa mereset PIN, tetapi tidak bisa melihat atau menentukan PIN Anda.",
  },
  verified: {
    title: "Nomor berhasil diverifikasi",
    description: "Sekarang buat PIN slip gaji yang baru.",
    continue: "Buat PIN baru",
  },
  waiting: {
    title: "Kirim lewat WhatsApp",
    senderLead: "Gunakan nomor terdaftar:",
    messageLabel: "Pesan yang akan dikirim",
    soon: "Berlaku sebentar lagi",
    expiredStatus: "Kode sudah tidak berlaku",
    checking: "Memeriksa pesan Anda…",
    remaining: "Berlaku {time} lagi",
    expiredBody:
      "Pesan dengan kode ini tidak bisa dipakai lagi. Buat kode baru, lalu kirim lewat WhatsApp.",
    badLinkBody:
      "Tautan WhatsApp tidak dapat dibuka. Buat kode baru, lalu kirim lewat WhatsApp.",
    creatingCode: "Membuat kode…",
    newCode: "Buat kode baru",
    openWhatsApp: "Buka WhatsApp",
    prefilled:
      "Pesan sudah terisi. Tekan Kirim tanpa mengubahnya, lalu kembali ke halaman ini.",
    qrLabel: "Kode QR untuk membuka WhatsApp dengan pesan yang sudah terisi",
    qrHint: "Pindai dengan HP yang punya WhatsApp.",
    waiting: "Menunggu pesan Anda…",
    waitingHint: "Verifikasi muncul di sini, tanpa balasan WhatsApp.",
    notVerified: "Sudah kirim tapi belum terverifikasi?",
    otherDeviceTitle: "WhatsApp di perangkat lain?",
    otherDeviceBody: "Kirim pesan di atas ke nomor WhatsApp layanan",
    copyMessage: "Salin pesan",
    copyNumber: "Salin nomor tujuan",
    copiedMessage: "Pesan disalin. Tempel dan kirim lewat WhatsApp.",
    copiedNumber: "Nomor tujuan disalin.",
    copyFailed: "Tidak bisa menyalin. Salin teks di atas secara manual.",
  },
  choose: {
    title: "Lupa PIN?",
    description: "Pilih cara untuk membuat PIN baru.",
    errorTitle: "Permintaan belum berhasil",
    errorBody:
      "Periksa koneksi, lalu coba lagi lewat WhatsApp atau minta bantuan HR atau supervisor.",
    whatsApp: "Lewat WhatsApp",
    whatsAppHint: "Kirim pesan dari nomor yang terdaftar.",
    hrBody:
      "Tidak bisa pakai nomor terdaftar? Minta reset PIN ke HR atau supervisor di outlet.",
  },
  hrHelp: {
    description:
      "Hubungi HR atau supervisor di outlet dan minta reset PIN slip gaji.",
    side: "HR tidak bisa melihat atau menentukan PIN Anda.",
    step1Title: "Minta reset PIN",
    step1Body: "Sampaikan bahwa Anda lupa PIN slip gaji.",
    step2Title: "Buka slip gaji lagi",
    step2Body: "Setelah HR meresetnya, buat PIN baru sendiri.",
  },
  blocked: {
    retryLater: "Coba lagi nanti",
    retryIn: "Coba lagi dalam {time}",
    restrictionOver: "Pembatasan sudah selesai",
    creatingCode: "Membuat kode…",
    hrHelpUrgent: "Minta bantuan HR atau supervisor",
    expiredTitle: "Kode sudah kedaluwarsa",
    expiredDescription:
      "Pesan dengan kode ini tidak bisa dipakai lagi. Buat kode baru, lalu kirim lewat WhatsApp.",
    expiredNoticeTitle: "Kode tidak berlaku",
    newCode: "Buat kode baru",
    mismatchTitle: "Belum ada pesan yang cocok",
    mismatchDescription:
      "Kami belum menerima pesan dengan kode ini dari nomor terdaftar.",
    mismatchNoticeTitle: "Pastikan nomor yang dipakai",
    mismatchWithNumber: "Pastikan WhatsApp memakai nomor terdaftar {number}.",
    mismatchNoNumber: "Pastikan WhatsApp memakai nomor terdaftar.",
    waitMore: "Tunggu lagi",
    retryRegistered: "Coba dari nomor terdaftar",
    numberChangedTitle: "Nomor sudah berubah?",
    numberChangedBody:
      "Minta bantuan HR atau supervisor di outlet untuk memperbarui nomor atau mereset PIN.",
    rateLimitedTitle: "Terlalu banyak percobaan",
    rateLimitedDescription:
      "Pemulihan lewat WhatsApp dibatasi sementara. Tunggu sebelum mencoba lagi.",
    rateLimitedBody:
      "Sambil menunggu, Anda bisa minta reset PIN ke HR atau supervisor di outlet.",
    noWaTitle: "Nomor WhatsApp belum terdaftar",
    noWaDescription:
      "Pemulihan lewat WhatsApp belum bisa dipakai. Minta HR atau supervisor di outlet memperbarui nomor atau mereset PIN Anda.",
    outletHelpTitle: "Minta bantuan di outlet",
    // Founder's wording, used only where no WhatsApp is registered.
    noWaNotice:
      "Hubungi HR atau atasan di outlet untuk memperbarui nomor atau mereset PIN Anda.",
    tooNewTitle: "Nomor WhatsApp belum 3 hari",
    tooNewDescription:
      "Nomor WhatsApp harus tertaut minimal 3 hari sebelum bisa dipakai untuk memulihkan PIN.",
    needsUpdateTitle: "Nomor WhatsApp perlu diperbarui",
    needsUpdateDescription:
      "Nomor WhatsApp Anda sudah tercatat, tetapi perlu diperbarui sebelum bisa dipakai untuk memulihkan PIN.",
    needsUpdateNotice:
      "Minta HR atau supervisor di outlet untuk memperbarui nomor WhatsApp Anda, atau mereset PIN Anda.",
    unavailableNoticeTitle: "Pemulihan lewat WhatsApp belum bisa dipakai",
    tooNewNotice:
      "Hubungi HR atau supervisor di outlet untuk mereset PIN Anda, atau coba lagi setelah nomor tertaut 3 hari.",
    genericDescription:
      "Nomor WhatsApp Anda belum terdaftar, atau baru tertaut kurang dari 3 hari.",
    genericNotice:
      "Hubungi HR atau supervisor di outlet untuk memperbarui nomor atau mereset PIN Anda.",
    serviceTitle: "Pemulihan lewat WhatsApp belum tersedia",
    serviceDescription:
      "Layanan WhatsApp sedang tidak dapat dihubungi saat ini.",
    serviceNoticeTitle: "Coba lagi sebentar lagi",
    serviceNotice:
      "Hubungi HR atau supervisor di outlet untuk mereset PIN Anda, atau coba lagi nanti.",
  },
  newPin: {
    proofGoneTitle: "Verifikasi WhatsApp sudah tidak berlaku",
    proofGoneBody:
      "Waktu untuk membuat PIN sudah habis. Mulai lagi dari awal untuk mengirim kode baru.",
    genericTitle: "PIN belum dapat disimpan",
    genericBody: "Periksa koneksi Anda, lalu coba lagi.",
    restart: "Mulai lagi",
  },
} as const;
