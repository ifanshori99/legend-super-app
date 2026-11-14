// Pengaturan AI tenant UI text (bead legend-nnufz). Namespace: `aiSettingsCustom`.
// Own file so the parallel panels never edit the same lines. Copy follows the
// approved mockup design/mockups/ai/ai-settings.html; `**text**` marks bold.
// Part "custom": the Model kustom card and the Anggaran AI bulanan card.
// `testError.*` mirrors aiProviderTestErrorMessages of branch
// ws/ai-login-autodetect (keyed by error code); keep both in step when it merges.

export const aiSettingsCustomMessages = {
  custom: {
    eyebrow: "Cadangan otomatis",
    step: "2",
    title: "Model kustom",
    description:
      "Layanan yang mendukung OpenAI-compatible API. Digunakan otomatis saat ChatGPT bermasalah.",
    badgeTested: "Sudah diuji",
    badgeFailed: "Uji gagal",
    badgeNotSet: "Belum diatur",
    loading: "Memuat model kustom",
    errorTitle: "Model kustom belum bisa dimuat",
    errorHint:
      "Muat ulang bagian ini. Jika tetap gagal, coba lagi beberapa menit lagi.",

    urlLabel: "Base URL · Alamat layanan",
    urlHint: "Salin alamat API dari penyedia model Anda.",
    urlPlaceholder: "https://model.example.com/v1",
    urlError: "Masukkan alamat layanan yang diawali https://.",

    keyLabel: "API key · Kunci akses",
    keyHint: "Kunci tidak pernah ditampilkan ulang setelah disimpan.",
    keyPlaceholderNew: "Masukkan API key",
    keyPlaceholderSaved: "Isi untuk mengganti kunci",
    keySaved: "Kunci tersimpan",
    keySavedHint: "· 4 karakter akhir",
    keyRequired: "Masukkan kunci akses dari penyedia model.",
    keyChanged: "Alamat layanan berubah. Masukkan lagi kunci akses Anda.",
    keyInvalid: "Kunci akses minimal 16 karakter dan tanpa spasi.",

    modelLabel: "Nama model",
    modelPlaceholder: "Nama model dari penyedia",
    modelRequired: "Isi nama model sesuai penyedia.",
    modelInvalid:
      "Nama model hanya boleh berisi huruf, angka, dan tanda . : / @ + - _ tanpa spasi.",

    // Button text follows the mockup; the button still saves first, testNote says so.
    test: "Uji koneksi",
    retest: "Uji ulang koneksi",
    testNote: "Pengaturan disimpan lebih dulu, lalu koneksi diuji.",
    refreshError:
      "Data terbaru belum bisa dimuat. Yang tampil mungkin belum yang terbaru.",
    testing: "Menguji koneksi…",
    testOk: "Uji koneksi berhasil.",
    testFailed: "Uji koneksi gagal. {reason}",
    testFailedNoReason:
      "Uji koneksi gagal. Periksa pengaturan, lalu coba lagi.",
    testUnreachable:
      "Pengaturan tersimpan, tetapi uji koneksi belum selesai. Periksa internet Anda, lalu coba lagi.",
  },

  testError: {
    URL_BLOCKED: "Alamat provider tidak diizinkan.",
    REDIRECT_REFUSED:
      "Provider mengalihkan ke alamat lain. Pengalihan ditolak.",
    TIMEOUT: "Provider tidak menjawab tepat waktu.",
    AUTH_FAILED: "Kunci API ditolak oleh provider.",
    NOT_FOUND: "Alamat atau model tidak ditemukan di provider.",
    REQUEST_REJECTED: "Provider menolak permintaan uji.",
    RATE_LIMITED: "Provider membatasi permintaan. Coba lagi sebentar lagi.",
    PROVIDER_ERROR: "Provider sedang bermasalah.",
    NETWORK_ERROR: "Tidak bisa terhubung ke provider.",
    BAD_RESPONSE: "Jawaban provider tidak sesuai format yang diharapkan.",
    KEY_UNREADABLE: "Kunci tersimpan tidak bisa dibuka. Masukkan kunci lagi.",
  },

  caps: {
    title: "Kemampuan model terdeteksi",
    description:
      "Nilai mengikuti informasi model yang tersedia, lalu dapat diperbaiki admin.",
    edited: "Sebagian nilai sudah diubah admin.",
    context: "Jendela konteks",
    output: "Batas jawaban",
    tools: "Tools · Panggil alat",
    reasoning: "Reasoning · Penalaran",
    tokenUnit: "token",
    supported: "Didukung",
    unsupported: "Tidak didukung",
    note: "Token adalah potongan teks yang dibaca atau ditulis AI. Tingkat berpikir dipilih otomatis oleh sistem.",
    editSummary: "Ubah kemampuan model",
    editHint:
      "Untuk admin yang memiliki informasi berbeda dari penyedia model.",
    editContext: "Konteks (token)",
    editOutput: "Jawaban maks. (token)",
    editTools: "Panggilan alat",
    editReasoning: "Penalaran",
    rangeError:
      "Isi konteks {contextMin} sampai {contextMax} token dan jawaban {outputMin} sampai {outputMax} token. Batas jawaban tidak boleh melebihi konteks.",
    save: "Simpan kemampuan",
    saved: "Kemampuan disimpan.",
    reset: "Kembalikan ke deteksi",
    resetDone: "Nilai dikembalikan ke hasil deteksi.",
  },

  budget: {
    title: "Anggaran AI bulanan",
    description: "Batas untuk seluruh tenant.",
    loading: "Memuat anggaran AI",
    errorTitle: "Anggaran AI belum bisa dimuat",
    errorHint:
      "Muat ulang bagian ini. Jika tetap gagal, coba lagi beberapa menit lagi.",
    usageLabel: "Perkiraan pemakaian bulan ini",
    refreshError:
      "Data terbaru belum bisa dimuat. Yang tampil mungkin belum yang terbaru.",
    usageUnknown: "Pemakaian belum bisa dimuat.",
    meterLabel: "Pemakaian anggaran",
    meterWarn: "Pemakaian mendekati batas anggaran.",
    meterStop: "AI berhenti: anggaran bulan ini sudah habis.",
    percentOf: "{percent}% dari {cap}",
    off: "AI belum aktif · Anggaran Rp 0",
    limitLabel: "Batas per bulan",
    currency: "Rp",
    limitHint: "Isi 0 untuk mematikan AI.",
    limitError:
      "Isi angka rupiah 0 atau lebih, tanpa desimal. Titik pemisah ribuan boleh dipakai.",
    save: "Simpan anggaran",
    saved: "Anggaran disimpan.",
    savedOff: "Anggaran disimpan. AI dimatikan.",
    confirmOffTitle: "Matikan AI?",
    confirmOffBody: "AI akan dimatikan untuk seluruh tenant.",
    confirmOffHint: "Isi anggaran lagi kapan saja untuk menyalakannya.",
    confirmOffCancel: "Batal",
    confirmOffConfirm: "Matikan AI",
    note: "Peringatan saat pemakaian mencapai {warn}%. AI berhenti saat anggaran habis ({stop}%).",
  },
} as const;
