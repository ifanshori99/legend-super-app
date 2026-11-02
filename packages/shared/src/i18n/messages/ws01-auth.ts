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
      backupHint:
        "Kode pemulihan sekali pakai belum tersedia di build ini; akan aktif bersama backend MFA.",
    },

    enroll: {
      title: "Daftarkan aplikasi autentikator",
      description:
        "Tambahkan akun di aplikasi autentikator dengan kunci di bawah, lalu masukkan 6 angka yang muncul.",
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
      invalidCode:
        "Kode tidak cocok. Periksa jam perangkat, lalu masukkan kode terbaru.",
      errorGeneric: "Faktor kedua belum bisa didaftarkan. Coba lagi.",
      expires: "Kunci ini berlaku sampai {time}.",
      back: "Batal",
    },

    verify: {
      title: "Verifikasi dua langkah",
      description:
        "Masukkan kode dari aplikasi autentikator untuk melanjutkan ke back office.",
      signedInAs: "Masuk sebagai {name}",
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
      signOut: "Keluar",
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
      passkeyLabel: "Passkey",
      passkeyHint:
        "Passkey belum dapat diverifikasi dari web ini. Gunakan kode dari aplikasi autentikator.",
      helpTitle: "Tidak bisa memakai aplikasi autentikator?",
      helpHint:
        "Minta Admin Tenant mengatur ulang faktor kedua Anda. Jangan berikan kode ini kepada siapa pun, termasuk yang mengaku dari Legend.",
    },

    sessions: {
      title: "Sesi & perangkat",
      description:
        "Sesi disimpan di server dan dapat dicabut per perangkat. Sesi manajemen berakhir setelah 30 menit tidak aktif; sesi pelanggan bertahan 90 hari.",
      columnDevice: "Perangkat",
      columnKind: "Jenis",
      columnLastSeen: "Terakhir aktif",
      columnStatus: "Status",
      columnActions: "Tindakan",
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
      endsAt: "Berakhir {time}",
      emptyTitle: "Belum ada sesi perangkat",
      emptyHint:
        "Sesi muncul di sini setelah akun ini masuk dari sebuah perangkat.",
      loadErrorTitle: "Daftar sesi tidak dapat dimuat",
      loadErrorHint: "Periksa koneksi, lalu coba lagi.",
    },

    idle: {
      title: "Sesi akan segera berakhir",
      description:
        "Sesi manajemen berakhir setelah 30 menit tanpa aktivitas. Lanjut bekerja untuk memperbarui sesi ini.",
      minutesLeft: "Sisa waktu sekitar {minutes} menit.",
      stay: "Lanjut bekerja",
      dismiss: "Tutup",
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
