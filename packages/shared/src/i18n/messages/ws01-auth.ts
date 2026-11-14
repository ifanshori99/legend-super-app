// Staff web login second factor, security settings and device sessions
// (bead legend-9bh; PRD v1.7 §3 F6 "Staf — Login Web", "Sesi & Perangkat",
// AUTH-05). Kept in its own file so parallel WS-01 beads never edit the same
// catalog lines; the namespace is added to id.ts with one line.

export const ws01AuthMessages = {
  staffAuth: {
    nav: {
      security: "Keamanan akun",
    },
    title: "Keamanan akun",
    description:
      "Kelola verifikasi dua langkah dan perangkat yang masuk ke akun ini.",

    // AUTH-05: role wajib MFA tidak membuka back office/dashboard tanpa faktor kedua.
    status: {
      verifiedTitle: "Verifikasi dua langkah aktif",
      verifiedHint: "Sesi ini sudah melewati faktor kedua pada {time}.",
      requiredTitle: "Verifikasi dua langkah diperlukan",
      requiredHint:
        "Role Anda mewajibkan faktor kedua sebelum membuka back office atau dashboard.",
      verifyNow: "Verifikasi sekarang",
      optionalHint:
        "Role Anda tidak mewajibkan faktor kedua. Anda tetap dapat menambahkannya.",
      endedTitle: "Sesi sudah berakhir",
      endedHint:
        "Sesi ini berakhir karena tidak ada aktivitas. Masuk kembali untuk membuka pengaturan keamanan.",
    },

    mfa: {
      title: "Faktor kedua",
      description:
        "Gunakan aplikasi autentikator atau passkey. Role manajemen, finance, HR, owner, shareholder, dan Super Admin wajib memakainya.",
      totpLabel: "Aplikasi autentikator",
      passkeyLabel: "Passkey",
      addedAt: "Ditambahkan {date}",
      emptyTitle: "Belum ada faktor kedua",
      emptyHint:
        "Tambahkan aplikasi autentikator agar akun ini dapat membuka back office.",
      add: "Tambah faktor",
      chooseTitle: "Pilih faktor kedua",
      chooseDescription:
        "Aplikasi autentikator memberi kode 6 angka. Passkey memakai kunci perangkat ini.",
      addTotp: "Aplikasi autentikator",
      addTotpHint: "Paling umum; bekerja di semua ponsel.",
      addPasskey: "Passkey",
      passkeyUnavailable:
        "Passkey belum dapat didaftarkan dari web ini karena verifikasi kunci perangkat belum tersedia di API. Gunakan aplikasi autentikator.",
      remove: "Hapus",
      removeTitle: "Hapus faktor kedua?",
      removeDescription:
        "{name} tidak dapat dipakai untuk masuk lagi. Sesi lain tetap aktif.",
      removeLastBlocked:
        "Role Anda mewajibkan faktor kedua. Tambahkan faktor lain sebelum menghapus yang terakhir.",
      removed: "Faktor kedua dihapus.",
      removeFailed: "Faktor kedua belum bisa dihapus. Coba lagi.",
      backupTitle: "Kode cadangan",
      backupHint: "Simpan kode untuk masuk saat faktor kedua tidak tersedia.",
    },

    enroll: {
      title: "Daftarkan aplikasi autentikator",
      description:
        "Pindai kode QR di aplikasi autentikator, atau masukkan kunci setup di bawah, lalu masukkan 6 angka yang muncul.",
      qrLabel: "Kode QR untuk aplikasi autentikator",
      secretLabel: "Kunci setup",
      copySecret: "Salin kunci",
      copied: "Kunci setup disalin.",
      openUri: "Buka di aplikasi autentikator",
      secretHint:
        "Simpan kunci ini hanya sampai verifikasi selesai. Jangan bagikan ke siapa pun.",
      codeLabel: "Kode 6 angka",
      codeHint: "Masukkan kode terbaru dari aplikasi autentikator.",
      submit: "Verifikasi dan aktifkan",
      success: "Faktor kedua aktif.",
      errorGeneric: "Faktor kedua belum bisa didaftarkan. Coba lagi.",
      expires: "Kunci ini berlaku sampai {time}.",
    },

    verify: {
      title: "Verifikasi dua langkah",
      description:
        "Masukkan kode dari aplikasi autentikator untuk melanjutkan ke back office.",
      signedInAs: "Masuk sebagai {name}",
      identityHint: "Identitas terverifikasi: {value}",
      factorLabel: "Faktor kedua",
      codeLabel: "Kode 6 angka",
      codeHint: "6 angka dari aplikasi autentikator.",
      submit: "Verifikasi",
      success: "Verifikasi berhasil. Membuka dashboard…",
      invalidCode:
        "Kode salah atau sudah kedaluwarsa. Masukkan kode terbaru, lalu coba lagi.",
      rateLimited:
        "Terlalu banyak percobaan. Tunggu beberapa menit sebelum mencoba lagi.",
      notYou: "Bukan akun Anda?",
      backToSignIn: "Kembali ke halaman masuk",
      alreadyTitle: "Verifikasi sudah selesai",
      alreadyHint: "Sesi ini sudah melewati faktor kedua.",
      continue: "Lanjut ke dashboard",
      enrollTitle: "Daftarkan faktor kedua dulu",
      enrollHint:
        "Role Anda mewajibkan faktor kedua, tetapi belum ada faktor yang terdaftar.",
      noSessionTitle: "Sesi tidak ditemukan",
      noSessionHint: "Masuk kembali untuk melanjutkan verifikasi.",
      loadErrorTitle: "Status verifikasi tidak dapat dimuat",
      loadErrorHint: "Periksa koneksi, lalu coba lagi.",
      offlineTitle: "Tidak ada koneksi internet",
      offlineHint:
        "Verifikasi memerlukan koneksi. Sambungkan internet, lalu coba lagi.",
      passkeyHint:
        "Passkey belum dapat diverifikasi dari web ini. Gunakan kode dari aplikasi autentikator.",
      helpTitle: "Tidak bisa memakai aplikasi autentikator?",
      helpHint:
        "Minta Admin Tenant mengatur ulang faktor kedua Anda. Jangan berikan kode ini kepada siapa pun, termasuk yang mengaku dari Legend.",
    },

    // Kode cadangan MFA (bead legend-sw980): tampil sekali setelah enrol,
    // status + buat ulang di Keamanan akun, dan "pakai kode cadangan" di login.
    recovery: {
      title: "Kode cadangan",
      description: "Simpan kode untuk masuk saat faktor kedua tidak tersedia.",
      saveTitle: "Simpan kode cadangan Anda",
      saveDescription:
        "Verifikasi dua langkah sudah disiapkan. Gunakan kode ini jika Anda tidak dapat mengakses faktor kedua.",
      onceTitle: "Ditampilkan sekali.",
      onceBody:
        "Simpan kode ini di tempat yang aman sebelum meninggalkan halaman.",
      singleUse: "Setiap kode hanya dapat digunakan sekali.",
      codesLabel: "Daftar kode cadangan",
      copy: "Salin kode",
      copied: "Kode disalin. Simpan di tempat yang aman.",
      copyFailed: "Kode belum dapat disalin. Salin secara manual.",
      saved: "Saya sudah menyimpan kode",
      savedToast: "Kode cadangan disimpan.",
      savedTitle: "Kode cadangan disimpan",
      savedBody:
        "Kode tidak ditampilkan kembali. Simpan di tempat yang aman untuk digunakan saat diperlukan.",
      tipsTitle: "Cara menjaga kode",
      tipPrivateTitle: "Simpan secara pribadi",
      tipPrivateBody: "Jangan bagikan kode kepada orang lain.",
      tipUseTitle: "Gunakan saat diperlukan",
      tipUseBody:
        "Pilih “Pakai kode cadangan” pada layar verifikasi dua langkah.",
      loading: "Memuat kode cadangan…",
      generating: "Membuat kode cadangan…",
      skip: "Lewati, buat nanti di Keamanan",
      emptyTitle: "Kode cadangan belum tersedia",
      emptyHint:
        "Siapkan verifikasi dua langkah untuk mendapatkan kode cadangan.",
      emptyAction: "Siapkan verifikasi dua langkah",
      notGeneratedTitle: "Kode cadangan belum dibuat",
      notGeneratedHint:
        "Buat 10 kode sekali pakai untuk masuk saat faktor kedua tidak tersedia.",
      generate: "Buat kode cadangan",
      errorBanner: "Kode cadangan belum dapat dimuat.",
      errorTitle: "Ada masalah saat memuat",
      errorBannerHint: "Periksa koneksi dan coba lagi.",
      errorHint: "Kembali ke pengaturan keamanan atau coba lagi.",
      remaining: "{count} dari {total} kode cadangan tersisa",
      generatedAt: "Dibuat {time}",
      depletedHint:
        "Semua kode cadangan sudah terpakai. Buat ulang kode agar Anda tetap bisa masuk.",
      lowHint:
        "Kode cadangan hampir habis. Buat ulang untuk mendapatkan 10 kode baru.",
      regenerate: "Buat ulang kode",
      regenerateTitle: "Buat ulang kode cadangan?",
      regenerateDescription:
        "Kode lama langsung tidak berlaku. Kode baru ditampilkan sekali, jadi siapkan tempat menyimpannya.",
      regenerateConfirm: "Buat kode baru",
      mfaRequired:
        "Verifikasi dua langkah sesi ini dulu, lalu buat kode cadangan.",
      noFactor:
        "Siapkan verifikasi dua langkah dulu sebelum membuat kode cadangan.",
      sessionEnded: "Sesi berakhir. Masuk kembali, lalu coba lagi.",
      offline:
        "Tidak ada koneksi internet. Sambungkan internet, lalu coba lagi.",
      unknown:
        "Kode cadangan belum dapat dibuat. Coba lagi beberapa saat lagi.",
      closeLocked: "Simpan kode dulu, lalu tekan “Saya sudah menyimpan kode”.",
    },

    // "Pakai kode cadangan" di layar verifikasi dua langkah.
    recoveryLogin: {
      use: "Pakai kode cadangan",
      title: "Masukkan kode cadangan",
      description:
        "Gunakan salah satu kode yang disimpan saat menyiapkan verifikasi dua langkah.",
      label: "Kode cadangan",
      submit: "Verifikasi kode",
      back: "Kembali ke verifikasi dua langkah",
      incomplete: "Masukkan kode cadangan 10 karakter, contoh ABCDE-12345.",
      invalid:
        "Kode tidak valid atau sudah digunakan. Periksa kode atau gunakan kode lain.",
      rateLimited:
        "Terlalu banyak kode salah. Tunggu 15 menit, lalu coba lagi.",
      sessionEnded: "Sesi berakhir. Masuk kembali, lalu coba lagi.",
      offline:
        "Tidak ada koneksi internet. Sambungkan internet, lalu coba lagi.",
      unknown: "Kode belum dapat diverifikasi. Coba lagi beberapa saat lagi.",
      successTitle: "Verifikasi berhasil",
      successHint: "Kode cadangan diterima. Anda dapat melanjutkan masuk.",
      successLow:
        "Kode cadangan hampir habis. Buat ulang di Keamanan akun setelah masuk.",
      continue: "Lanjutkan",
    },

    sessions: {
      title: "Sesi & perangkat",
      description:
        "Sesi disimpan di server dan dapat dicabut per perangkat. Sesi manajemen berakhir setelah 30 menit tidak aktif; sesi pelanggan bertahan 90 hari.",
      kindManagement: "Manajemen",
      kindCustomer: "Pelanggan",
      current: "Sesi ini",
      revoke: "Cabut",
      revokeTitle: "Cabut sesi perangkat ini?",
      revokeDescription:
        "{device} langsung keluar dan harus masuk kembali. Pekerjaan yang belum dikirim bisa hilang.",
      revokeConfirm: "Cabut sesi",
      revoked: "Sesi {device} dicabut.",
      revokeFailed: "Sesi belum bisa dicabut. Coba lagi.",
      statusActive: "Aktif",
      statusEnding: "Segera berakhir",
      statusMfaPending: "Menunggu verifikasi",
      lastSeen: "Terakhir aktif {time}",
      endsAt: "Berakhir {time}",
      emptyTitle: "Belum ada sesi perangkat",
      emptyHint:
        "Sesi muncul di sini setelah akun ini masuk dari sebuah perangkat.",
    },

    // legend-gchkf: perangkat penerima alarm panik, termasuk yang sesinya sudah habis.
    pushDevices: {
      title: "Perangkat alarm",
      description:
        "Perangkat yang menerima alarm panik dari akun ini. Perangkat tetap menerima alarm walau sesi masuknya sudah habis, sampai Anda mencabutnya. Cabut perangkat yang hilang atau sudah tidak dipakai.",
      unnamed: "Perangkat tanpa nama",
      registeredAt: "Didaftarkan {time}",
      statusSessionActive: "Sedang masuk",
      statusSessionEnded: "Sudah keluar, masih menerima alarm",
      currentBadge: "Perangkat ini",
      revoke: "Cabut",
      revokeLabel: "Cabut {device} dari penerima alarm",
      revokeTitle: "Berhenti kirim alarm ke perangkat ini?",
      revokeDescription:
        "{device} tidak akan menerima alarm panik lagi. Untuk menerima alarm lagi, aktifkan notifikasi alarm di perangkat itu setelah masuk kembali.",
      revokeCurrentWarning:
        "Ini perangkat yang sedang kamu pakai. Alarm panik tidak akan masuk lagi di sini sampai notifikasi diaktifkan ulang.",
      revokeSessionNote:
        "Sesi masuk di perangkat itu juga ikut keluar, jadi perangkat itu perlu masuk lagi.",
      revokeConfirm: "Cabut perangkat",
      revoked: "{device} tidak akan menerima alarm lagi.",
      revokeFailed: "Perangkat belum bisa dicabut. Coba lagi.",
      revokeGone: "Perangkat ini sudah tidak terdaftar. Daftar diperbarui.",
      loadErrorTitle: "Daftar perangkat alarm tidak dapat dimuat",
      loadErrorHint: "Periksa koneksi, lalu coba lagi.",
      emptyTitle: "Belum ada perangkat penerima alarm",
      emptyHint:
        "Perangkat muncul di sini setelah notifikasi alarm diaktifkan di sebuah perangkat.",
    },

    idle: {
      title: "Sesi akan segera berakhir",
      description:
        "Sesi manajemen berakhir setelah 30 menit tanpa aktivitas. Lanjut bekerja untuk memperbarui sesi ini.",
      minutesLeft: "Sisa waktu sekitar {minutes} menit.",
      stay: "Lanjut bekerja",
      dismiss: "Tutup",
      extendFailed: "Sesi belum diperbarui. Periksa koneksi, lalu coba lagi.",
    },

    errors: {
      offlineTitle: "Tidak ada koneksi internet",
      offlineHint:
        "Data keamanan hanya dapat dimuat dengan koneksi internet. Sambungkan internet, lalu coba lagi.",
      loadTitle: "Data keamanan tidak dapat dimuat",
      loadHint: "Periksa koneksi, lalu coba lagi.",
    },
  },
} as const;
