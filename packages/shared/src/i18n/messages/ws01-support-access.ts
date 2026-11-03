// Support access text (PRD v1.7 §3 F4 "Support Access", TEN-04, bead
// legend-335): Super Admin request dialog and grant list, tenant-admin
// history and the countdown banner. Own file so parallel WS-01 beads never
// edit the same lines in id.ts. Namespace: `supportAccess`.

export const supportAccessMessages = {
  nav: "Akses dukungan",
  modeReadOnly: "Hanya baca",
  modeReadWrite: "Baca dan tulis",
  status: {
    active: "Aktif",
    ended: "Diakhiri",
    expired: "Berakhir",
  },
  errors: {
    generic: "Terjadi kesalahan. Coba lagi sebentar lagi.",
    offline: "Tidak ada koneksi. Periksa internet Anda, lalu coba lagi.",
    forbidden:
      "Anda tidak punya izin untuk tindakan ini. Hubungi Super Admin lain.",
    mfa: "Kode verifikasi salah atau kedaluwarsa. Buka aplikasi autentikator, lalu masukkan kode terbaru.",
    alreadyActive:
      "Anda sudah punya sesi aktif untuk tenant ini. Akhiri sesi itu dulu jika ingin memulai ulang.",
    notFound: "Sesi tidak ditemukan. Muat ulang daftar.",
  },

  platform: {
    title: "Akses dukungan",
    description:
      "Data pribadi dan keuangan tenant hanya dapat dibuka lewat sesi berjangka dengan alasan tertulis. Setiap sesi tercatat di audit log dan diberitahukan ke admin tenant.",
    request: "Minta akses",
    listTitle: "Sesi akses",
    listDescription: "Semua sesi yang pernah Anda buka, terbaru di atas.",
    search: "Cari tenant atau alasan…",
    filterStatus: "Semua status",
    columnTenant: "Tenant",
    columnReason: "Alasan",
    columnScope: "Cakupan",
    columnWindow: "Waktu",
    columnStatus: "Status",
    columnActions: "Tindakan",
    endNow: "Akhiri sekarang",
    endLabel: "Akhiri sesi untuk {tenant}",
    ended: "Sesi diakhiri.",
    endedAt: "Diakhiri {time}",
    expiresAt: "Berakhir {time}",
    remaining: "Sisa {time}",
    unknownTenant: "Tenant {id}",
    emptyTitle: "Belum ada sesi akses",
    emptyHint:
      "Tanpa sesi aktif, Super Admin tidak dapat membuka data pribadi atau keuangan tenant. Minta akses untuk mulai.",
    errorTitle: "Daftar sesi gagal dimuat",
    errorHint: "Periksa koneksi Anda, lalu coba lagi.",
    notifiedYes: "Admin tenant sudah diberi tahu",
    notifiedNo: "Pemberitahuan ke admin tenant belum terkirim",
    mfaAt: "MFA diverifikasi {time}",
  },

  request: {
    title: "Minta akses dukungan",
    description:
      "Sesi dibuka untuk satu tenant, berlaku sementara, dan tercatat di audit log.",
    tenant: "Tenant",
    tenantPlaceholder: "Pilih tenant",
    tenantRequired: "Pilih tenant yang akan dibuka.",
    tenantsEmpty: "Belum ada tenant yang dapat dipilih.",
    tenantsFailed: "Daftar tenant gagal dimuat. Tutup dialog lalu buka lagi.",
    reason: "Alasan",
    reasonHint:
      "Jelaskan apa yang diperiksa dan atas permintaan siapa. Admin tenant akan membaca alasan ini.",
    reasonCount: "{count}/{max} karakter",
    reasonMin: "Alasan minimal {min} karakter.",
    duration: "Durasi",
    durationOption: "{minutes} menit",
    durationDefault: "{minutes} menit (bawaan)",
    scope: "Cakupan akses",
    scopeValue: "Hanya baca",
    scopeHint:
      "Sesi ini hanya dapat melihat data. Tidak ada perubahan yang bisa dibuat atas nama tenant.",
    mfaTitle: "Verifikasi dua langkah",
    mfaHint:
      "Masukkan kode 6 digit dari aplikasi autentikator Anda. Kode diperiksa saat sesi dibuka.",
    mfaCode: "Kode autentikator",
    mfaInvalid: "Kode harus 6 digit angka.",
    submit: "Mulai sesi",
    cancel: "Batal",
    started: "Sesi akses dimulai.",
  },

  tenant: {
    title: "Akses dukungan",
    description:
      "Riwayat sesi saat tim Legend membuka data tenant Anda untuk membantu. Setiap sesi hanya baca, berjangka, dan tercatat di audit log.",
    notice: "Tim Legend sedang membuka data tenant Anda",
    noticeBody:
      "Sesi hanya baca dengan alasan: {reason} Sesi berakhir otomatis pada {time}.",
    noActive: "Tidak ada sesi aktif",
    noActiveBody:
      "Data pribadi dan keuangan tenant Anda tertutup bagi tim Legend sampai Anda diberi tahu ada sesi baru.",
    listTitle: "Riwayat sesi",
    listDescription: "Setiap sesi dukungan, terbaru di atas.",
    columnReason: "Alasan",
    columnScope: "Cakupan",
    columnWindow: "Waktu",
    columnStatus: "Status",
    columnNotified: "Pemberitahuan",
    notified: "Terkirim {time}",
    notNotified: "Belum terkirim",
    emptyTitle: "Belum ada sesi dukungan",
    emptyHint:
      "Saat tim Legend membuka data tenant Anda, sesinya muncul di sini beserta alasannya.",
    errorTitle: "Riwayat sesi gagal dimuat",
    errorHint: "Periksa koneksi Anda, lalu coba lagi.",
    duration: "{minutes} menit",
  },

  banner: {
    label: "Sesi akses dukungan",
    // The grant carries only the Super Admin's user id, not a name.
    who: "Tim Legend (Super Admin)",
    until: "Sampai {time}",
    tenant: "Tenant {name}",
    readOnly: "Hanya baca",
    readWrite: "Baca dan tulis",
    remaining: "Sisa waktu",
    remainingAria: "Sisa waktu sesi {time}",
    end: "Akhiri sesi",
    ending: "Mengakhiri…",
    reason: "Alasan: {reason}",
    expiringSoon: "Sesi segera berakhir",
  },
} as const;
