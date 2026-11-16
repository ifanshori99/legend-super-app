// WS-10 payroll disbursement shell, Siap bayar tab and shared labels (legend-wnkep.7).
// Own file so parallel beads never edit the same catalog lines.
export const payrollPayoutMessages = {
  nav: { title: "Pencairan gaji" },
  tabs: {
    label: "Bagian pencairan gaji",
    runs: "Siap bayar",
    approval: "Persetujuan",
    status: "Status karyawan",
    settings: "Pengaturan PT",
  },
  page: {
    subtitle: "Bayar gaji yang sudah dikunci, dengan pemeriksaan dua orang.",
    entity: "Badan usaha",
    entityHint: "Pengaturan dan pencairan berlaku per PT.",
    error: {
      title: "Pencairan gaji belum bisa dimuat",
      description:
        "Daftar badan usaha tidak terbaca. Periksa koneksi lalu coba lagi.",
    },
    noEntity: {
      title: "Belum ada badan usaha",
      description:
        "Pencairan gaji berlaku per PT. Tambahkan badan usaha di pengaturan organisasi dulu.",
    },
  },
  common: {
    loading: "Memuat pencairan gaji",
    unavailable: "Tidak tersedia",
    accountHidden: "Nomor rekening tidak ditampilkan di layar ini",
  },
  method: {
    manual: "Transfer manual",
    duitku: "Duitku",
  },
  batchStatus: {
    draft: "Draf",
    pendingApproval: "Menunggu persetujuan",
    approved: "Disetujui",
    sending: "Sedang dikirim",
    exported: "Menunggu konfirmasi bank",
    completed: "Selesai dibayar",
    partiallyFailed: "Sebagian gagal",
    halted: "Dihentikan",
    cancelled: "Dibatalkan",
  },
  itemStatus: {
    waiting: "Menunggu",
    waitingConfirm: "Menunggu konfirmasi",
    sending: "Sedang dikirim",
    succeeded: "Berhasil",
    paidManual: "Dibayar manual",
    failed: "Gagal",
    notSent: "Tidak terkirim",
    unknown: "Hasil belum pasti",
    blocked: "Tertahan",
    cancelled: "Dibatalkan",
    returned: "Dikembalikan",
    overpaid: "Terbayar lebih",
  },
  excluded: {
    inquiryFailed: "Pengecekan rekening gagal",
    nameMismatch: "Nama rekening tidak cocok",
    bankCodeMissing: "Kode bank belum diisi",
    bankFormatUnsupported: "Format bank belum didukung",
    overCap: "Melewati batas per transfer",
    unknown: "Tidak ikut dibayar",
  },
  runs: {
    loadMore: "Muat pencairan berikutnya",
    loadingMore: "Memuat pencairan…",
    loadMoreError: "Pencairan berikutnya gagal dimuat. Coba lagi.",
    title: {
      list: "Periode gaji siap bayar",
      regular: "Gaji {period}",
      offCycle: "Gaji tambahan {period}",
      thr: "THR {period}",
    },
    subtitle: "Periode gaji yang sudah dikunci dan belum selesai dibayar.",
    count: "{count} periode gaji",
    readyToPrepare: "Siap disiapkan",
    employeeCount: "{count} karyawan",
    askedBy: "Diajukan {name} · {at}",
    askedAt: "Diajukan {at}",
    lockedAt: "Dikunci {at}",
    netLabel: "Gaji bersih",
    prepare: "Siapkan",
    prepareAgain: "Siapkan lagi",
    remainingNote:
      "Sebagian karyawan belum terbayar. Siapkan lagi hanya untuk slip yang belum dibayar; angka di samping adalah perkiraan dari item yang gagal.",
    prepared: "Pencairan disiapkan. Ajukan untuk persetujuan.",
    submit: "Ajukan persetujuan",
    submitted: "Pencairan diajukan untuk persetujuan.",
    submittedExcluded:
      "{count} karyawan tidak ikut karena datanya belum lengkap.",
    review: "Tinjau persetujuan",
    seeStatus: "Lihat status",
    select: "Pilih",
    selectedState: "Terpilih",
    goSettings: "Buka pengaturan PT",
    needRequestPermission: "Anda tidak punya izin menyiapkan pencairan.",
    blocked: {
      noConfig: "Pengaturan pencairan PT belum disimpan.",
      disabled: "Pencairan PT ini belum diaktifkan.",
      sourceInactive: "Rekening sumber tidak aktif. Pilih rekening aktif dulu.",
    },
    duitkuOff: {
      title: "Duitku belum aktif untuk PT ini",
      body: "Gunakan transfer manual dengan persetujuan dua orang. Duitku dapat diaktifkan setelah akun, deposit, dan uji sandbox siap.",
      link: "Lihat pengaturan PT",
    },
    twoPeople: {
      title: "Pembuat dan penyetuju harus berbeda.",
      body: "Uang baru boleh keluar setelah pemeriksaan orang kedua. Periode gaji yang sudah lunas tidak masuk daftar ini.",
    },
    selected: "Periode terpilih · {period}",
    receivedBy: "Gaji diterima {count} karyawan",
    receivedByUnknown: "Gaji diterima karyawan lewat transfer bank",
    method: "Metode pembayaran",
    source: "Rekening sumber",
    sourceNone: "Belum dipilih",
    feeEstimate: "Biaya PT (perkiraan)",
    feeActual: "Biaya PT",
    funds: "Total dana disiapkan",
    feeNote:
      "Biaya Rp{fee} per transfer ditanggung PT. Gaji karyawan diterima utuh. Biaya manual aktual mengikuti bank dan dicatat terpisah.",
    empty: {
      title: "Belum ada periode gaji siap bayar",
      description:
        "Periode gaji muncul di sini setelah dikunci. Kunci periode gaji di halaman Penggajian, lalu kembali ke sini.",
    },
    error: {
      title: "Daftar periode gaji belum bisa dimuat",
      description:
        "Tidak ada pencairan yang berubah. Periksa koneksi lalu coba lagi.",
    },
  },
  freeze: {
    badge: "Dibekukan",
    banner: {
      title: "Pencairan ini dibekukan",
      body: "Ada yang menyatakan langkah atas namanya bukan dilakukan olehnya. Tidak ada langkah baru yang bisa dilakukan sampai pembekuan dibuka.",
      sentNote:
        "Pencairan ini sudah dikirim ke bank. Periksa mutasi bank sebelum membuka pembekuan.",
      disputes: "{count} pernyataan “bukan saya”",
      mine: "Pernyataan Anda",
      other: "Pernyataan orang lain",
      noReason: "Tanpa catatan",
    },
    unfreeze: {
      action: "Buka pembekuan",
      title: "Buka pembekuan pencairan",
      description:
        "Hanya pemilik usaha atau finance yang tidak terlibat di pencairan ini yang bisa membukanya. Pastikan penyebabnya sudah diperiksa.",
      reasonLabel: "Alasan pembukaan",
      reasonHint: "10 sampai 500 karakter. Alasan ini dicatat.",
      reasonShort: "Alasan minimal 10 karakter.",
      confirm: "Buka pembekuan",
      confirming: "Membuka…",
      cancel: "Batal",
      done: "Pembekuan dibuka.",
    },
  },
  error: {
    generic: "Permintaan gagal. Tidak ada uang yang bergerak. Coba lagi.",
    offline: "Tidak ada koneksi ke server. Periksa jaringan lalu coba lagi.",
    offlineTitle: "Tidak ada koneksi",
    forbidden: "Anda tidak punya izin untuk tindakan pencairan ini.",
    selfApproval:
      "Pembuat pengajuan tidak boleh menyetujui pencairannya sendiri.",
    confirmSelf:
      "Pembuat pengajuan tidak boleh mengonfirmasi transfernya sendiri.",
    sourceAccountInvalid:
      "Rekening sumber tidak aktif. Pilih rekening aktif milik PT ini.",
    sourceAccountMissing:
      "Rekening sumber belum dipilih. Atur di Pengaturan PT.",
    channelNotAvailable:
      "Duitku belum aktif untuk PT ini. Gunakan transfer manual.",
    configDisabled: "Pencairan PT ini belum diaktifkan di Pengaturan PT.",
    mfaRequired:
      "Verifikasi dua langkah diperlukan untuk tindakan ini. Verifikasi lalu coba lagi.",
    reauthRequired: "Masukkan kata sandi akun Anda untuk melanjutkan.",
    reauthPasswordInvalid: "Kata sandi salah. Periksa lalu coba lagi.",
    approvalExpired:
      "Persetujuan sudah kedaluwarsa. Ajukan ulang pencairannya.",
    hashMismatch:
      "Isi pencairan berubah sejak diajukan. Muat ulang dan periksa lagi.",
    batchState:
      "Status pencairan sudah berubah. Muat ulang halaman lalu periksa lagi.",
    exportAlreadyDownloaded:
      "Berkas transfer sudah diunduh dan tidak bisa diunduh lagi.",
    batchEmpty: "Tidak ada karyawan yang bisa dibayar di pencairan ini.",
    nothingToPay: "Tidak ada gaji yang perlu dibayar di periode gaji ini.",
    runNotPayable:
      "Periode gaji ini belum bisa dicairkan. Pastikan sudah dikunci.",
    runAlreadyPaid: "Periode gaji ini sudah lunas.",
    exportFileLost:
      "Berkas sudah dibuat server tetapi gagal tersimpan di perangkat ini, dan hanya bisa diunduh sekali. Hubungi admin.",
    batchAlreadyOpen:
      "Periode gaji ini sudah punya pencairan yang sedang berjalan.",
    batchFrozen:
      "Pencairan ini dibekukan karena ada pernyataan “bukan saya”. Tidak ada uang yang bergerak. Buka pembekuan dulu.",
    unfreezeRefused:
      "Anda tidak bisa membuka pembekuan ini. Pemilik usaha atau finance yang tidak terlibat di pencairan ini yang bisa membukanya.",
    unfreezeNothing: "Tidak ada pembekuan yang perlu dibuka.",
  },
} as const;
