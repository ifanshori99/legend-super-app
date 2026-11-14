// Pengaturan AI tenant UI text (bead legend-nnufz). Namespace: `aiSettingsChatgpt`.
// Own file so the parallel panels never edit the same lines. Copy follows the
// approved mockup design/mockups/ai/ai-settings.html; `**text**` marks bold.

export const aiSettingsChatgptMessages = {
  eyebrow: "Layanan utama",
  step: "1",
  title: "Login ChatGPT",
  loading: "Memuat login ChatGPT…",

  badge: {
    disconnected: "Belum terhubung",
    pending: "Menunggu",
    connected: "Terhubung",
    retry: "Perlu diulang",
  },

  error: {
    title: "Login ChatGPT belum bisa dimuat",
    hint: "Muat ulang bagian ini. Jika tetap gagal, coba lagi beberapa menit lagi.",
    offlineTitle: "Tidak ada koneksi internet",
    offlineHint: "Sambungkan perangkat ke internet, lalu coba lagi.",
    refreshNote:
      "Status terbaru belum bisa dimuat. Yang tampil adalah data terakhir.",
  },

  intro:
    "Masuk memakai akun ChatGPT milik Anda. Tidak perlu memasukkan API key untuk jalur ini.",
  risk: {
    title: "Pahami risiko sebelum menghubungkan",
    body: "Pemakaian akun ChatGPT melalui koneksi ini berisiko membuat akun ChatGPT Anda diblokir.",
    consent: "Saya memahami dan menyetujui risiko akun ChatGPT saya diblokir.",
  },
  platformOff: {
    title: "Login ChatGPT dimatikan platform",
    body: "Login ChatGPT sedang dimatikan oleh platform. Model kustom tetap dipakai sebagai cadangan.",
  },
  connect: "Hubungkan ChatGPT",
  newCode: "Buat kode baru",
  ownerOnly:
    "Hanya pemilik tenant yang dapat menghubungkan atau mencabut akun ChatGPT. Admin tetap dapat mengatur model kustom dan anggaran.",

  failed: {
    title: "Koneksi ChatGPT belum berhasil",
    hint: "Login belum dapat diselesaikan. Periksa koneksi internet, lalu buat kode baru.",
  },
  expired: {
    title: "Kode sudah kedaluwarsa",
    hint: "Kode lama tidak dapat dipakai lagi. Buat kode baru untuk mengulangi login.",
  },

  pending: {
    codeLabel: "Kode perangkat",
    copy: "Salin kode",
    copied: "Kode disalin.",
    copyFailed: "Pilih kode di atas, lalu salin secara manual.",
    steps: {
      open: "Buka halaman login ChatGPT.",
      enter: "Masuk ke akun ChatGPT Anda, lalu masukkan kode di atas.",
      back: "Kembali ke sini. Status akan diperbarui setelah selesai.",
    },
    openLogin: "Buka halaman login",
    openLoginHint: "(dibuka di tab baru)",
    waiting: "Menunggu Anda menyelesaikan login…",
    waitingOwner: "Menunggu pemilik menyelesaikan login",
    pollError: "Status belum bisa diperiksa. Mencoba lagi sebentar lagi.",
    pollStopped:
      "Status belum bisa diperiksa setelah beberapa kali mencoba. Periksa koneksi, lalu periksa lagi.",
    pollDenied:
      "Anda tidak lagi punya izin memeriksa status ini. Muat ulang halaman atau masuk kembali.",
    checkAgain: "Periksa lagi",
    cancel: "Batalkan koneksi",
    cancelHint: "Kode sudah tidak berlaku? Batalkan, lalu buat kode baru.",
  },

  connected: {
    title: "Akun ChatGPT terhubung",
    hint: "Akun dihubungkan oleh pemilik tenant.",
    priority: "Dipakai lebih dahulu saat AI dijalankan.",
    revoke: "Cabut koneksi",
  },

  announce: {
    disconnected: "Koneksi ChatGPT dicabut.",
  },

  actionError: {
    generic: "Perubahan belum tersimpan. Coba lagi beberapa saat lagi.",
    offline:
      "Perubahan belum tersimpan karena tidak ada koneksi internet. Periksa koneksi, lalu coba lagi.",
  },

  revoke: {
    title: "Cabut koneksi ChatGPT?",
    body: "Tenant tidak lagi dapat memakai koneksi ini. Model kustom tetap menjadi cadangan jika sudah siap.",
    again: "Anda dapat menghubungkannya kembali lewat kode baru.",
    cancel: "Batal",
    confirm: "Cabut koneksi",
  },
} as const;
