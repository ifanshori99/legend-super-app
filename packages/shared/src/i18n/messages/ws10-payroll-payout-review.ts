// WS-10 payout Persetujuan and Status karyawan tabs (legend-wnkep.7).
// Own file so parallel beads never edit the same catalog lines.
export const payrollPayoutReviewMessages = {
  common: {
    refresh: "Segarkan",
    unknownEmployee: "Karyawan tidak dikenal",
    noAccount: "Rekening belum tercatat",
    noSnapshot: "Rekening belum tercatat di batch",
    noReason: "Dikecualikan oleh sistem",
    loadingLabel: "Memuat data pencairan",
    close: "Tutup",
    you: "Anda",
    someoneElse: "Orang lain",
  },
  channel: {
    duitku: "Duitku",
    manual_bank: "Transfer manual",
    cash: "Tunai",
  },
  approval: {
    empty: {
      title: "Belum ada pengajuan untuk diperiksa",
      description:
        "Pilih periode gaji di tab Siap bayar dan ajukan pencairan. Pengajuan yang menunggu persetujuan muncul di sini.",
      action: "Lihat periode siap bayar",
    },
    error: {
      title: "Pengajuan tidak bisa dimuat",
      description:
        "Data pencairan belum bisa diambil. Coba lagi sebentar lagi; tidak ada uang yang bergerak.",
    },
    eyebrow: "Pengajuan pencairan · {channel}",
    title: "Periksa sebelum menyetujui",
    subtitle: "{count} karyawan menerima gaji",
    step: {
      creator: "01 · Pembuat pengajuan",
      approver: "02 · Penyetuju berbeda",
      requested: "Sudah diajukan",
      approved: "Sudah disetujui",
      waiting: "Menunggu verifikasi",
      approvedAt: "Disetujui {time}",
      requestedAt: "Diajukan {time}",
      approverHint: "Harus orang selain pembuat",
      progress: "{done} dari 2 orang",
    },
    table: {
      employee: "Karyawan",
      account: "Rekening tujuan",
      amount: "Gaji diterima",
      accountInline: "Rekening",
      amountInline: "Gaji",
    },
    excluded: {
      title: "Tidak ikut dibayar ({count})",
      hint: "Karyawan ini dikecualikan dan tidak dihitung pada total dana.",
    },
    note: {
      checkName: "Periksa nama penerima di internet banking.",
      checkNameHint:
        "Jalur manual tidak memeriksa nama pemilik rekening otomatis. Gunakan rekening yang telah dikunci bersama periode gaji.",
      afterTransfer:
        "Setelah transfer, hasil dan bukti per karyawan harus dikonfirmasi oleh orang selain pembuat.",
    },
    summary: {
      title: "Rincian pencairan",
      netLabel: "Gaji diterima {count} karyawan",
      method: "Metode pembayaran",
      source: "Rekening sumber",
      sourceMissing: "Belum dipilih",
      sourceFrozenNote: "Dikunci saat disetujui.",
      sourceWillFreezeNote:
        "Akan dibekukan saat disetujui. Rekening ini yang dikirim bersama persetujuan Anda.",
      fee: "Biaya PT (perkiraan)",
      total: "Total dana disiapkan",
      feeNote:
        "Biaya {fee} per transfer ditanggung PT. Gaji karyawan diterima utuh. Biaya manual aktual mengikuti bank dan dicatat terpisah.",
      feeNoteGeneric:
        "Biaya ditanggung PT. Gaji karyawan diterima utuh. Biaya manual aktual mengikuti bank dan dicatat terpisah.",
    },
    check:
      "Saya telah memeriksa penerima, nominal, rekening sumber, dan biaya PT.",
    approve: "Verifikasi & setujui",
    approveHint:
      "Persetujuan oleh orang selain pembuat, dengan verifikasi MFA. Berlaku 24 jam.",
    approved: {
      title: "Pencairan sudah disetujui",
      description:
        "Lanjutkan di tab Status karyawan untuk mengunduh berkas bank dan mencatat hasil transfer.",
      expires: "Persetujuan berlaku sampai {time}.",
    },
    blocked: {
      noSnapshot:
        "{count} karyawan transfer bank belum punya rekening tercatat di batch ini, jadi pengajuan ini tidak bisa disetujui. Batalkan pengajuan ini, lalu ajukan ulang dari tab Siap bayar. Pembatalan perlu izin mengajukan pencairan.",
      sourceChecking: "Memeriksa rekening sumber terbaru…",
      sourceUnknown:
        "Rekening sumber belum bisa dipastikan. Segarkan halaman, atau pilih rekening aktif di Pengaturan PT lalu ajukan ulang.",
      selfApproval:
        "Anda yang mengajukan pencairan ini. Penyetuju harus orang lain.",
      noPermission: "Akun Anda tidak punya izin menyetujui pencairan.",
      sourceInactive:
        "Rekening sumber tidak aktif. Pilih rekening aktif di Pengaturan PT, lalu ajukan ulang.",
      notPending: "Pengajuan ini tidak sedang menunggu persetujuan.",
      noHash:
        "Ringkasan pengajuan belum siap. Segarkan halaman lalu coba lagi.",
      needCheck: "Centang pemeriksaan di atas untuk melanjutkan.",
    },
    notPending: {
      draft: "Pengajuan ini belum dikirim untuk persetujuan.",
      cancelled: "Pengajuan ini dibatalkan. Tidak ada uang yang dikirim.",
      other: "Pengajuan ini sudah diproses.",
    },
    cancel: {
      action: "Batalkan pengajuan",
      title: "Batalkan pengajuan pencairan",
      description:
        "Tidak ada uang yang dikirim. Setelah dibatalkan, ajukan ulang dari tab Siap bayar.",
      reason: "Alasan pembatalan",
      reasonHint: "Contoh: rekening karyawan belum tercatat di batch ini.",
      reasonRequired: "Alasan wajib diisi.",
      submit: "Batalkan pengajuan",
      back: "Kembali",
      success: "Pengajuan dibatalkan. Tidak ada uang yang dikirim.",
    },
    sourceBanner: {
      title: "Rekening sumber tidak aktif — pencairan ditolak",
      description:
        "{account} tidak dapat digunakan. Pilih rekening aktif pada pengaturan PT, lalu ajukan ulang untuk persetujuan.",
    },
    success: "Pencairan disetujui. Lanjutkan di tab Status karyawan.",
    sourceChanged:
      "Rekening sumber berubah saat Anda memeriksa. Tidak ada yang disetujui. Periksa rekening yang baru, lalu centang dan setujui lagi.",
    contentChanged:
      "Isi batch berubah saat Anda memeriksa. Tidak ada yang disetujui. Periksa batch yang baru, lalu centang dan setujui lagi.",
  },
  verify: {
    title: "Verifikasi identitas",
    mfaHint:
      "Pencairan uang meminta kode dari aplikasi autentikator Anda sebelum diteruskan.",
    passwordHint: "Masukkan kata sandi akun Anda untuk mengonfirmasi.",
    orPassword: "Atau, bila tidak memakai kode, masukkan kata sandi akun Anda.",
    either: "Isi kode MFA terbaru atau kata sandi akun.",
    code: "Kode 6 digit",
    password: "Kata sandi akun",
    codeInvalid: "Kode harus 6 digit angka.",
    noFactor:
      "Akun ini belum punya autentikator. Aktifkan MFA di menu Keamanan lalu ulangi.",
    loadingFactor: "Memeriksa autentikator…",
    submit: "Verifikasi dan lanjutkan",
    codeRejected: "Kode tidak cocok atau sudah kedaluwarsa. Coba kode terbaru.",
    cancel: "Batal",
  },
  status: {
    empty: {
      title: "Belum ada pencairan untuk ditampilkan",
      description:
        "Siapkan pencairan dari periode gaji yang sudah dikunci. Status karyawan akan muncul setelah pengajuan dibuat.",
      action: "Lihat periode siap bayar",
    },
    error: {
      title: "Status pencairan tidak bisa dimuat",
      description:
        "Data pencairan belum bisa diambil. Tidak ada uang yang bergerak. Coba lagi sebentar lagi.",
    },
    eyebrow: "Pencairan · {channel}",
    title: "Hasil per karyawan",
    updated: "Terakhir diperbarui {time}",
    unknownBanner: {
      title: "Hasil transfer belum pasti",
      description:
        "Jangan bayar ulang atau tandai gagal. Periksa status dan bukti bank terlebih dahulu. Penyelesaian manual memerlukan dua orang berbeda.",
    },
    overpaidBanner: {
      title: "Ada pembayaran lebih",
      description:
        "{count} karyawan menerima lebih dari gaji yang seharusnya. Jangan bayar ulang. Finance perlu meminta dana kembali dan mencatat penyelesaiannya.",
    },
    summaryLabel: "Ringkasan status pencairan",
    tile: {
      waiting: "Menunggu",
      unknown: "Belum pasti",
      succeeded: "Berhasil",
      failed: "Gagal",
      manual: "Dibayar manual",
      returned: "Dikembalikan",
      overpaid: "Terbayar lebih",
      unit: "karyawan",
    },
    results: {
      title: "Hasil pencairan",
      summary: "{paid} telah diterima · {rest} belum selesai",
    },
    table: {
      employee: "Karyawan",
      amount: "Gaji diterima",
      status: "Status",
      action: "Tindak lanjut",
    },
    row: {
      waiting: "Belum dibayar",
      waitingExport: "Menunggu berkas bank diunduh",
      waitingTransfer: "Berkas sudah diunduh, menunggu hasil transfer",
      unknown: "Hasil bank belum diketahui · Jangan kirim ulang",
      succeeded: "Diterima {time}",
      manualPaid: "Bukti diverifikasi",
      failed: "Pembayaran gagal. Belum ada uang diterima karyawan.",
      notSent: "Tidak terkirim. Belum ada uang diterima karyawan.",
      returned: "Dana dikembalikan",
      overpaid: "Terbayar lebih. Hubungi finance untuk penyelesaian.",
      cancelled: "Dibatalkan",
      ref: "Ref {ref}",
    },
    action: {
      record: "Catat hasil manual",
      cash: "Konfirmasi tunai diterima",
      check: "Periksa status",
      detail: "Lihat rincian",
      evidence: "Lihat bukti",
      review: "Tinjau kegagalan",
      withdraw: "Batalkan usulan",
      blockedWithdrawCreator:
        "Pembuat pengajuan tidak boleh membatalkan usulan.",
      blockedWithdrawAccess: "Akun Anda tidak punya izin membatalkan usulan.",
      blockedCreator: "Pembuat pengajuan tidak boleh mengonfirmasi hasil.",
      blockedAccess: "Akun Anda tidak punya izin mengonfirmasi hasil.",
    },
    footnote:
      "Karyawan yang berhasil atau dibayar manual tidak boleh dibayar ulang. Pengajuan baru hanya untuk kegagalan yang sudah dipastikan.",
    excluded: {
      title: "Dikecualikan dari pencairan ({count})",
      hint: "Tidak ada uang dikirim ke karyawan ini pada pengajuan ini.",
    },
    export: {
      title: "Berkas bank untuk transfer manual",
      description:
        "Berkas hanya bisa diunduh satu kali. Simpan di tempat aman, lalu transfer lewat internet banking.",
      button: "Unduh berkas bank",
      done: "Berkas bank diunduh. Unduhan kedua ditolak.",
    },
    success: {
      confirmed: "Hasil transfer dicatat.",
      cash: "Penerimaan tunai dicatat.",
    },
  },
  result: {
    title: "Catat hasil transfer",
    description:
      "Untuk {name} · {amount}. Hanya orang selain pembuat pengajuan yang boleh mencatat.",
    outcome: "Hasil transfer",
    succeeded: "Berhasil dibayar",
    failed: "Gagal",
    not_sent: "Tidak terkirim",
    bankRef: "Nomor referensi bank",
    bankRefHint: "Salin dari bukti transfer internet banking.",
    bankRefRequired: "Nomor referensi bank wajib diisi.",
    submit: "Simpan hasil",
    cancel: "Batal",
    cashTitle: "Konfirmasi tunai diterima",
    cashDescription:
      "{name} · {amount}. Catat bahwa karyawan sudah menerima uang tunai.",
    cashSubmit: "Konfirmasi diterima",
    evidenceFile: "Berkas bukti dari bank",
    evidenceFileHint:
      "Foto atau screenshot bukti (JPG atau PNG, maks 5 MB). PDF belum tersedia. Item ini tetap tercatat diekspor sampai dua orang berbeda menandai hasil yang sama.",
    evidenceFileHintPdf:
      "Foto, screenshot, atau PDF bukti (JPG, PNG, atau PDF, maks 5 MB). Item ini tetap tercatat diekspor sampai dua orang berbeda menandai hasil yang sama.",
    evidenceFileRequired: "Pilih berkas bukti dulu.",
    pickFile: "Pilih foto",
    changeFile: "Ganti foto",
    noFile: "Belum ada foto dipilih",
    note: "Catatan",
    noteHint: "Tulis apa yang terjadi, misalnya pesan penolakan dari bank.",
    noteRequired: "Catatan wajib diisi.",
    resolveWarning:
      "Jangan bayar ulang sebelum dua orang berbeda menandai hasil ini. Setelah itu slip gaji bisa dicairkan lagi.",
    proposed:
      "Usulan tercatat. Orang lain perlu menandai hasil yang sama dengan buktinya sendiri.",
    resolved: "Hasil tercatat. Slip gaji ini bisa dicairkan ulang.",
    uploading: "Mengunggah bukti…",
    returnFileHint:
      "Foto atau screenshot bukti dana masuk kembali dari bank (JPG atau PNG, maks 5 MB). PDF belum tersedia. Item tetap tercatat dibayar sampai dua orang berbeda mencatat dana kembali.",
    returnFileHintPdf:
      "Foto, screenshot, atau PDF bukti dana masuk kembali dari bank (JPG, PNG, atau PDF, maks 5 MB). Item tetap tercatat dibayar sampai dua orang berbeda mencatat dana kembali.",
    returnWarning:
      "Dana kembali membalik catatan pembayaran gaji ini. Jangan bayar ulang sebelum dua orang mencatatnya.",
    returnTitle: "Catat dana kembali",
    returnDescription:
      "Untuk {name} · {amount}. Pakai ini bila transfer yang sudah berhasil dikembalikan bank. Perlu dua orang berbeda.",
    returnAction: "Catat dana kembali",
    returnBankRef: "Nomor referensi transaksi bank",
    returnBankRefHint:
      "Salin dari mutasi atau bukti dana kembali di internet banking. Orang kedua mengisi nomor yang sama dari bukti banknya sendiri.",
    returnBankRefRequired: "Nomor referensi transaksi bank wajib diisi.",
    returnBankRefShort: "Nomor referensi minimal 4 karakter.",
    returnSubmit: "Simpan dana kembali",
    returnProposed:
      "Usulan tercatat. Orang kedua perlu mengonfirmasi dengan bukti yang sama.",
    returnDone: "Dana kembali tercatat.",
    withdrawTitle: "Batalkan usulan",
    withdrawDescription:
      "Untuk {name} · {amount}. Usulan orang pertama dibatalkan supaya bisa dibuat ulang dengan bukti baru.",
    withdrawWarning:
      "Membatalkan tidak membayar apa pun dan tidak mengubah status pembayaran. Bukti ini tidak bisa dipakai lagi; usulan baru perlu bukti baru.",
    withdrawGroup:
      "Usulan ini mencakup {count} item. Semuanya dibatalkan bersama.",
    withdrawSubmit: "Batalkan usulan",
    withdrawDone: "Usulan dibatalkan. Tidak ada pembayaran yang berubah.",
    proposal: {
      title: "Usulan orang pertama",
      outcome: "Hasil",
      outcomeFailed: "Gagal",
      outcomeNotSent: "Tidak terkirim",
      outcomeReturn: "Dana kembali",
      outcomeCorrection: "Koreksi: transfer ternyata berhasil",
      outcomeOverpaid: "Terbayar dua kali",
      by: "Diusulkan oleh",
      you: "Anda",
      other: "Orang lain",
      at: "Waktu",
      note: "Catatan",
      viewEvidence: "Lihat bukti",
      opening: "Membuka bukti…",
      openFailed: "Bukti belum bisa dibuka. Coba lagi.",
      badge: "Menunggu orang kedua",
      locked:
        "Hasil dan bukti mengikuti usulan orang pertama dan tidak bisa diubah. Tulis catatan Anda sendiri.",
      waiting:
        "Anda yang mengusulkan ini. Menunggu orang kedua untuk menyimpan hasil yang sama.",
    },
  },
  error: {
    sourceMismatch:
      "Rekening sumber berubah sejak layar dibuka. Tidak ada yang disetujui. Periksa rekening sumber yang baru, lalu setujui lagi.",
    evidenceInvalid:
      "Berkas bukti tidak dikenali untuk pencairan ini. Tidak ada hasil yang dicatat.",
    evidencePhotoOnly: "Unggah foto atau screenshot bukti.",
    evidenceFileOnly: "Unggah foto, screenshot, atau PDF bukti.",
    evidenceTooLarge: "Berkas lebih dari 5 MB. Kecilkan foto lalu coba lagi.",
    evidenceRejected:
      "Berkas bukti ditolak pemeriksaan keamanan. Pakai foto atau screenshot lain.",
    evidenceUnavailable:
      "Unggah bukti belum tersedia di server. Tidak ada hasil yang dicatat. Hubungi tim teknis.",
    resolveSamePerson:
      "Penandaan kedua harus dilakukan orang lain, bukan orang yang mengusulkan pertama.",
    resolveOutcomeMismatch:
      "Hasil ini berbeda dari usulan pertama. Periksa lagi bukti bank.",
    resolveEvidenceMismatch:
      "Bukti berbeda dari usulan orang pertama. Muat ulang lalu periksa usulan; tidak ada hasil yang dicatat.",
    returnEvidenceMismatch:
      "Bukti berbeda dari usulan orang pertama. Muat ulang lalu periksa usulan; tidak ada dana yang dicatat kembali.",
    returnSamePerson:
      "Konfirmasi kedua harus dilakukan orang lain, bukan orang yang mencatat pertama.",
    returnBankRefRequired:
      "Nomor referensi transaksi bank wajib diisi (4-64 karakter). Tidak ada dana yang dicatat kembali.",
    returnBankRefMismatch:
      "Nomor referensi bank berbeda dari catatan orang pertama. Periksa bukti bank; tidak ada dana yang dicatat kembali.",
    returnBankRefReused:
      "Nomor referensi bank ini sudah dipakai untuk pengembalian lain. Isi nomor referensi transaksi dana kembali yang sesuai dengan item ini.",
    reconClearReasonInvalid:
      "Alasan penutupan flag wajib diisi (10 sampai 500 karakter).",
    reconClearSelfApproval:
      "Pengusul penutupan flag tidak boleh menyetujuinya sendiri.",
    reconClearState: "Penutupan flag ini sudah disetujui.",
    proposalNotWithdrawable:
      "Usulan ini sudah berubah (disimpan, dibatalkan, atau hanya sebagian item). Muat ulang lalu periksa. Tidak ada yang dibatalkan.",
    proofSpentByWithdrawn:
      "Bukti ini pernah dipakai usulan yang dibatalkan dan tidak bisa dipakai lagi. Unggah bukti baru.",
    requesterCannotWithdraw:
      "Pembuat pengajuan tidak boleh membatalkan usulan ini.",
  },
  detail: {
    title: "Rincian pembayaran",
    employee: "Karyawan",
    account: "Rekening",
    amount: "Gaji diterima",
    fee: "Biaya PT (tidak dipotong dari gaji)",
    status: "Status",
    attempt: "Percobaan ke-{n}",
    ref: "Referensi bank",
    providerRef: "Referensi penyedia",
    settledAt: "Waktu selesai",
    none: "Belum ada",
    failedNote:
      "Belum ada uang diterima karyawan. Pengajuan baru hanya dibuat setelah kegagalan dipastikan di bank.",
  },
} as const;
