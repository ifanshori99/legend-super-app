// Customer and staff sign-in texts (PRD v1.7 §3 F3 "Autentikasi & Identitas",
// §4 Alur C "Alur Pelanggan Login dengan WhatsApp", §5 "/masuk", "/masuk/email",
// "/masuk/google"; AUTH-01/03/07). Bead legend-baa.
//
// The copy states the contract, not a promise: the guest sends the code (the
// system sends no WhatsApp message, AUTH-03), the code is bound to this browser
// and expires in five minutes (AUTH-01), a wrong number opens no account data
// (PRD "Pesan Gagal Login"), and points need a verified number (AUTH-07).
export const loginMessages = {
  eyebrow: "Masuk",
  heading: "Masuk ke {brand}",
  subtitle:
    "Tanpa kata sandi. Kamu mengirim kode sekali pakai dari WhatsApp-mu, lalu halaman ini masuk sendiri.",
  backToOptions: "Kembali ke pilihan masuk",
  or: "atau",
  toMember: "Ke halaman member",
  toDashboard: "Ke dashboard",
  mfaRequiredTitle: "Faktor kedua diperlukan",
  mfaRequiredHint:
    "Akun ini wajib verifikasi dua langkah. Dashboard akan meminta kode dari aplikasi autentikator atau passkey.",
  phishing: {
    title: "Kode ini rahasia",
    body: "Jangan pernah mengirim kode masuk ke orang lain, termasuk yang mengaku staf {brand}. Kode hanya berlaku untuk browser ini dan sekali pakai.",
    mismatch:
      "Pesan dari nomor yang tidak cocok dengan kode ini ditolak, tanpa membuka data akun apa pun.",
  },
  whatsapp: {
    action: "Masuk dengan WhatsApp",
    actionHint:
      "Paling cepat: WhatsApp terbuka dengan pesan yang sudah terisi.",
    heading: "Lewat WhatsApp",
    hint: "Kamu yang mengirim pesan ke Legend. Tidak ada pesan yang dikirim ke WhatsApp-mu.",
    stepTitle: "Cara masuk",
    step1: "Tekan Buka WhatsApp. Pesan berisi kode ini sudah terisi.",
    step2: "Kirim pesan itu ke nomor Legend tanpa mengubah kodenya.",
    step3: "Halaman ini masuk sendiri setelah pesanmu diterima.",
    codeLabel: "Kode masuk",
    expiresIn: "Berlaku {time} lagi, sekali pakai.",
    openWhatsApp: "Buka WhatsApp",
    qrLabel: "QR untuk membuka WhatsApp dengan pesan berisi kode {code}",
    qrHint:
      "Di komputer? Pindai QR ini dengan ponsel untuk membuka WhatsApp dengan pesan yang sudah terisi. Browser ini tetap yang masuk.",
    waiting: "Menunggu pesan WhatsApp-mu…",
    sent: "Saya sudah mengirim",
    cancel: "Batal",
    noReply:
      "Legend tidak mengirim pesan WhatsApp apa pun. Konfirmasi selalu muncul di halaman ini.",
    successTitle: "Berhasil masuk",
    successHint: "Sesi ini aktif di browser ini. Lanjut untuk memakai akunmu.",
    expiredTitle: "Kode sudah kedaluwarsa",
    expiredHint:
      "Kode masuk hanya berlaku 5 menit. Minta kode baru untuk melanjutkan.",
    restart: "Minta kode baru",
    confirmHeading: "Konfirmasi nomor WhatsApp",
    confirmPrompt: "Pesan diterima dari {sender}. Masuk sebagai nomor ini?",
    confirmPromptNoSender:
      "Pesan diterima dari nomor WhatsApp-mu. Masuk sebagai nomor ini?",
    confirmYes: "Ya, masuk",
    confirmNo: "Bukan saya",
    confirmHint:
      "Bukan nomormu? Tekan Bukan saya. Kodenya dibatalkan dan tidak ada yang masuk ke akunmu.",
    declinedTitle: "Masuk dibatalkan",
    declinedHint:
      "Minta kode baru, lalu kirim pesannya dari nomor WhatsApp-mu sendiri.",
    signedIn: "Berhasil masuk. Membuka halamanmu…",
    cancelledTitle: "Kode dibatalkan",
    cancelledHint:
      "Tidak ada sesi yang dibuat. Kamu bisa mulai lagi kapan saja.",
    mismatchTitle: "Kode ini bukan untuk browser ini",
    mismatchHint:
      "Kode masuk terikat ke browser yang memintanya. Minta kode baru dari browser ini.",
    usedTitle: "Kode sudah dipakai",
    usedHint: "Setiap kode hanya bisa dipakai sekali. Minta kode baru.",
    rateLimitedTitle: "Terlalu banyak percobaan",
    rateLimitedHint:
      "Tunggu 15 menit, lalu minta kode baru. Batas ini menjaga akunmu.",
    mockHint:
      "Mode mock: login selesai sendiri beberapa detik setelah kode muncul.",
  },
  email: {
    action: "Masuk dengan tautan email",
    actionHint: "Tautan sekali pakai dikirim ke kotak masukmu.",
    heading: "Masuk dengan tautan email",
    subtitle:
      "Masukkan emailmu. Kami kirim tautan masuk sekali pakai yang berlaku 15 menit.",
    addressLabel: "Email",
    addressPlaceholder: "nama@contoh.id",
    addressHint: "Pakai email yang kamu pakai saat mendaftar.",
    submit: "Kirim tautan masuk",
    sentTitle: "Periksa emailmu",
    sentBody:
      "Jika {email} terdaftar, tautan masuk sudah dikirim ke alamat itu. Tautan hanya bisa dipakai sekali dan berlaku 15 menit.",
    checkSpam: "Belum menemukannya? Periksa folder spam atau promosi.",
    resend: "Kirim ulang atau pakai email lain",
    privacy:
      "Jawaban halaman ini sama untuk semua alamat, terdaftar atau tidak, agar tidak membocorkan akun.",
  },
  verify: {
    heading: "Masuk dengan tautan dari email",
    subtitle:
      "Tekan tombol di bawah untuk memakai tautan ini. Tautan hanya bisa dipakai sekali.",
    submit: "Masuk sekarang",
    submitting: "Memeriksa tautan…",
    note: "Membuka halaman ini belum memakai tautan; tekan tombol di atas untuk memakainya.",
    missingTitle: "Tautan tidak lengkap",
    missingHint:
      "Buka lagi tautan dari emailmu, atau minta tautan baru dari halaman masuk.",
    requestNew: "Minta tautan baru",
    expiredTitle: "Tautan sudah tidak berlaku",
    expiredHint:
      "Tautan hanya bisa dipakai sekali dan berlaku 15 menit. Minta tautan baru untuk melanjutkan.",
  },
  // legend-fy5y: "/undangan", the page the first-admin invitation email opens.
  invitation: {
    heading: "Undangan admin",
    checking: "Memeriksa undangan…",
    doneTitle: "Email terverifikasi",
    doneHint:
      "Email kamu sudah terverifikasi. Kamu bisa masuk setelah tenant ini punya alamat web aktif.",
    deadTitle: "Tautan kedaluwarsa atau sudah terpakai",
    deadHint:
      "Tautan undangan hanya berlaku sebentar dan sekali pakai. Minta tim platform untuk mengirim ulang undangan.",
  },
  google: {
    action: "Lanjut dengan Google",
    actionHint: "Pakai akun Google dengan email yang kamu pakai di Legend.",
    heading: "Masuk dengan Google",
    subtitle:
      "Kami hanya membaca nama dan alamat email dari akun Google-mu. Tidak ada akses ke Gmail, kontak, atau file.",
    submit: "Lanjut dengan Google",
    opening: "Membuka Google…",
    privacy:
      "Google membuka halaman amannya sendiri. Setelah selesai, kamu kembali ke Legend dalam keadaan masuk.",
    pointsTitle: "Poin belum aktif",
    pointsNote:
      "Akun Google belum punya nomor WhatsApp terverifikasi. Hubungkan nomor dulu sebelum mengumpulkan atau menukar poin.",
    errorTitle: "Google tidak dapat dibuka",
    errorHint: "Periksa koneksi internetmu, lalu coba lagi.",
  },
  link: {
    eyebrow: "Penautan WhatsApp",
    heading: "Hubungkan nomor WhatsApp",
    subtitle:
      "Nomor WhatsApp terverifikasi adalah kunci profil pelangganmu: poin, riwayat pesanan, dan tiket fasilitas menempel padanya.",
    whyTitle: "Tanpa nomor terverifikasi",
    whyBody:
      "Poin tidak bisa dikumpulkan atau ditukar sebelum nomor WhatsApp terhubung. Tiket fasilitas juga butuh nomor yang bisa dihubungi.",
    bonusNote:
      "Bonus poin untuk penautan diatur outlet dan muncul di rincian program saat aktif.",
    action: "Hubungkan WhatsApp",
    panelHeading: "Kirim kode dari WhatsApp-mu",
    signedOutTitle: "Masuk dulu",
    signedOutHint:
      "Hubungkan WhatsApp dari akun yang sudah masuk, supaya nomornya menempel ke akun itu.",
    signedOutAction: "Ke halaman masuk",
    verifiedTitle: "Nomor WhatsApp sudah terhubung",
    verifiedHint: "Poin dan tiket fasilitas sudah menempel ke akun ini.",
    verifiedAction: "Ke halaman member",
    verifying: "Memeriksa akun…",
    errorTitle: "Status akun tidak dapat dimuat",
    successTitle: "Nomor WhatsApp terhubung",
    successHint: "Poin dan tiket fasilitas sekarang tersimpan di akun ini.",
    continue: "Ke halaman member",
    alreadyLinkedTitle: "Nomor ini sudah terhubung ke akun lain",
    alreadyLinkedHint:
      "Masuk ke akun pemilik nomor untuk menggabungkan riwayat. Penautan tidak membuat akun kedua.",
  },
  // legend-1255: password reset by email ("/lupa-sandi" is not used: the two
  // pages are /forgot-password and /reset-password, the link in the mail).
  resetPassword: {
    link: "Lupa kata sandi?",
    forgotHeading: "Lupa kata sandi",
    forgotSubtitle:
      "Masukkan email akunmu. Kami kirim tautan untuk memilih kata sandi baru.",
    emailLabel: "Email",
    emailPlaceholder: "nama@contoh.id",
    submit: "Kirim tautan atur ulang",
    sentTitle: "Periksa emailmu",
    sentBody:
      "Jika {email} terdaftar, tautan atur ulang kata sandi sudah dikirim ke alamat itu. Tautan hanya bisa dipakai sekali dan berlaku 1 jam.",
    checkSpam: "Belum menemukannya? Periksa folder spam atau promosi.",
    privacy:
      "Jawaban halaman ini sama untuk semua alamat, terdaftar atau tidak, agar tidak membocorkan akun.",
    unavailableTitle: "Atur ulang lewat email belum tersedia",
    unavailableHint:
      "Pengiriman email belum diaktifkan di sini. Hubungi pengelola untuk mengatur ulang kata sandimu, atau masuk dengan cara lain.",
    backToSignIn: "Kembali ke halaman masuk",
    newHeading: "Pilih kata sandi baru",
    newSubtitle: "Kata sandi lamamu berhenti berlaku setelah ini disimpan.",
    passwordLabel: "Kata sandi baru",
    passwordHint: "Minimal 8 karakter.",
    save: "Simpan kata sandi",
    doneTitle: "Kata sandi sudah diganti",
    doneHint: "Masuk dengan kata sandi barumu.",
    signIn: "Masuk",
    invalidTitle: "Tautan sudah tidak berlaku",
    invalidHint:
      "Tautan hanya bisa dipakai sekali dan berlaku 1 jam. Minta tautan baru untuk melanjutkan.",
    requestNew: "Minta tautan baru",
    passwordTooShort: "Kata sandi minimal 8 karakter.",
    passwordTooLong: "Kata sandi maksimal 128 karakter.",
  },
  errors: {
    generic: "Masuk belum bisa diproses. Coba lagi sebentar lagi.",
    offline:
      "Tidak ada koneksi internet. Sambungkan perangkatmu, lalu coba lagi.",
    invalidEmail: "Masukkan alamat email yang benar, misalnya nama@contoh.id.",
    tooMany:
      "Terlalu banyak percobaan dalam 15 menit. Tunggu sebentar, lalu coba lagi.",
  },
} as const;
