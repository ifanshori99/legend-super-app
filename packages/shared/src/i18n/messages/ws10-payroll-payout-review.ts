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
    reconFlagChanged:
      "Data yang ditandai berubah sejak penutupan flag diusulkan. Ajukan usulan penutupan baru.",
    reconProofUnreadable:
      "Bukti payout tidak bisa dibaca. Tunggu bacaan sukses berikutnya, jangan ajukan usulan baru.",

    reconNotFound:
      "Flag atau usulan penutupan tidak ditemukan. Muat ulang daftar lalu periksa lagi.",
    reconHoldTakenOver:
      "Flag yang menahan slip ini sudah ditulis, jadi hold tidak perlu dilepas. Muat ulang lalu periksa flag dan clearance-nya. Slip tetap tertahan.",
    reconHoldEvidenceNotClean:
      "Bukti rekonsiliasi belum bersih sejak hold dibuat, jadi hold tetap menahan slip. Tunggu pemeriksaan berikutnya bersih, lalu coba lagi.",
    returnWithdrawReasonInvalid:
      "Alasan penarikan klaim wajib diisi (10 sampai 500 karakter).",
    returnWithdrawSelfApproval:
      "Pengusul penarikan klaim tidak boleh menyetujuinya sendiri.",
    returnWithdrawState: "Penarikan klaim ini sudah disetujui.",
    returnWithdrawRefused:
      "Klaim pengembalian ini tidak dapat ditarik (sudah dikonfirmasi, berubah, atau sudah ditarik). Muat ulang lalu periksa. Tidak ada yang dibatalkan.",
    returnWithdrawNotFound:
      "Klaim atau usulan penarikan tidak ditemukan. Muat ulang daftar lalu periksa lagi.",
    proposalNotWithdrawable:
      "Usulan ini sudah berubah (disimpan, dibatalkan, atau hanya sebagian item). Muat ulang lalu periksa. Tidak ada yang dibatalkan.",
    proofSpentByWithdrawn:
      "Bukti ini pernah dipakai usulan yang dibatalkan dan tidak bisa dipakai lagi. Unggah bukti baru.",
    requesterCannotWithdraw:
      "Pembuat pengajuan tidak boleh membatalkan usulan ini.",
  },
  returnWithdraw: {
    title: "Klaim dana kembali",
    description:
      "Klaim dana kembali yang belum dikonfirmasi bisa ditarik oleh dua orang. Menarik klaim tidak membayar apa pun dan tidak mengubah status pembayaran.",
    loading: "Memuat klaim dana kembali",
    empty: {
      title: "Belum ada klaim dana kembali",
      description: "Klaim muncul di sini setelah dana kembali dicatat.",
    },
    error: {
      title: "Klaim dana kembali belum bisa dimuat",
      description: "Coba muat ulang. Tidak ada yang berubah.",
    },
    refresh: "Muat ulang",
    status: {
      open: "Terbuka",
      proposed: "Penarikan diusulkan",
      consumed: "Sudah dikonfirmasi",
      withdrawn: "Ditarik",
    },
    claim: {
      items: "{count} item",
      bankRef: "Referensi bank {ref}",
      noBankRef: "Tanpa referensi bank",
      createdAt: "Dicatat {time}",
    },
    proposal: {
      by: "Diusulkan oleh",
      you: "Anda",
      other: "Orang lain",
      reason: "Alasan",
      at: "Waktu",
    },
    action: {
      propose: "Tarik klaim",
      approve: "Setujui penarikan",
    },
    blocked: {
      creator:
        "Pembuat pengajuan pembayaran tidak boleh menarik atau menyetujui penarikan klaim ini.",
      self: "Anda yang mengusulkan penarikan ini. Orang lain yang menyetujuinya.",
      consumed:
        "Klaim ini sudah dikonfirmasi dan tidak bisa ditarik. Jurnal tidak pernah diubah.",
    },
    propose: {
      title: "Tarik klaim dana kembali",
      description:
        "Klaim {count} item{ref}. Orang lain perlu menyetujui penarikan ini.",
      warning:
        "Menarik klaim tidak membayar apa pun dan tidak mengubah status pembayaran. Bukti klaim ini tidak bisa dipakai lagi; klaim baru perlu bukti baru.",
      reasonLabel: "Alasan penarikan",
      reasonHint: "10 sampai 500 karakter.",
      reasonShort: "Alasan minimal 10 karakter.",
      cancel: "Batal",
      submit: "Usulkan penarikan",
      submitting: "Mengusulkan…",
      done: "Penarikan diusulkan. Menunggu persetujuan orang lain.",
    },
    approve: {
      title: "Setujui penarikan klaim",
      description:
        "Klaim {count} item{ref}. Alasan dari pengusul ada di bawah.",
      warning:
        "Setelah disetujui, klaim ditarik dan item kembali ke status sebelum klaim. Tidak ada pembayaran yang berubah.",
      cancel: "Batal",
      submit: "Setujui penarikan",
      submitting: "Menyetujui…",
      done: "Penarikan klaim disetujui. Tidak ada pembayaran yang berubah.",
    },
    conflict:
      "Klaim ini sudah berubah. Data dimuat ulang. Periksa lagi, lalu ajukan usulan baru bila masih perlu.",
  },
  recon: {
    nav: "Flag rekonsiliasi payout",
    subtitle:
      "Tinjau selisih dan bukti yang belum sesuai. Clearance memerlukan dua orang yang berbeda.",
    loading: "Memuat flag rekonsiliasi",
    loadingHint: "Mengambil flag dan status clearance terbaru.",
    unknown: "—",
    required: "wajib",
    scope: {
      batch: "Batch payout",
      option: "Batch {id} · {count} flag · ditandai {date}",
      meta: "{items} item · {channel}",
      metaUnavailable: "Rincian batch tidak tersedia untuk akun ini.",
      flags: "Flag dalam batch",
      held: "Slip tertahan",
      heldValue: "Nilai slip tertahan",
      placeholderEmpty: "Belum ada batch berflag",
      placeholderLoading: "Memuat batch…",
      placeholderError: "Batch belum dapat dimuat",
      incomplete:
        "Tanda + berarti angka belum lengkap: daftar flag terpotong di 200, jadi slip tertahan bisa lebih banyak.",
    },
    list: {
      title: "Flag dalam batch",
      hint: "Setiap flag ditinjau terpisah.",
      count: "{count} flag",
      limit:
        "Daftar berisi 200 flag terbaru. Flag yang lebih lama mungkin belum tercakup di layar ini.",
    },
    status: {
      open: "Terbuka",
      proposed: "Diusulkan",
      approved: "Disetujui",
      reopened: "Terbuka ulang",
    },
    flag: {
      id: "Flag {id}",
      ref: "Item {item} · Slip {slip}",
      noName: "Nama tidak tersedia",
      loadingName: "Memuat…",
      noDetail: "Rincian nominal batch tidak tersedia",
      fee: "Biaya PT {fee}, di luar gaji",
      held: "Slip tertahan · Belum boleh diterbitkan",
      released: "Flag ini tidak lagi menahan slip",
      reopened: "Terbuka ulang · Clearance lama tidak berlaku.",
      reopenedHint: "Slip tetap tertahan sampai clearance baru disetujui.",
      proposedBy: "Diusulkan {name} · {time}",
      approvedBy: "Diusulkan {proposer} · Disetujui {approver} · {time}",
      flaggedAt: "Ditandai {time}",
      review: "Tinjau flag",
      viewProposal: "Lihat usulan",
      viewApproval: "Lihat persetujuan",
    },
    who: {
      you: "Anda",
      unknown: "Identitas belum tersedia ({id})",
    },
    selection: {
      slipValue: "Nilai slip terkait · Slip {slip}",
    },
    propose: {
      title: "Usulkan clearance",
      copy: "Gunakan setelah memastikan flag tidak lagi menunjukkan masalah yang belum selesai.",
      reopenedTitle: "Clearance lama tidak berlaku",
      reopenedBody:
        "Data rekonsiliasi berubah setelah clearance disetujui. Slip kembali ditahan oleh flag ini dan perlu pemeriksaan ulang.",
      reasonLabel: "Alasan clearance",
      reasonPlaceholder: "Jelaskan hasil pemeriksaan dan bukti pendukung.",
      reasonHint: "Wajib 10–500 karakter. Jelaskan mengapa flag dapat ditutup.",
      counter: "{count}/500 karakter",
      reasonError: "Tulis alasan minimal 10 karakter.",
      passwordLabel: "Konfirmasi kata sandi akun",
      passwordError: "Isi konfirmasi kata sandi untuk melanjutkan.",
      submit: "Usulkan clearance",
      note: "Usulan belum menutup flag. Orang lain yang berwenang harus meninjau dan menyetujuinya. Sistem juga memeriksa verifikasi identitas terbaru.",
      invalidTitle: "Usulan belum dapat dikirim",
      invalidBody:
        "Lengkapi alasan dan konfirmasi kata sandi pada kolom yang ditandai.",
      failedTitle: "Usulan belum dapat dikirim",
      sent: "Usulan berhasil dikirim · Menunggu persetujuan orang lain",
      sentBody:
        "Flag tetap menahan slip sampai orang lain menyetujui usulan ini.",
    },
    approve: {
      title: "Setujui clearance",
      copy: "Tinjau alasan dan bukti sebelum memberikan persetujuan kedua.",
      proposedBy: "Diusulkan oleh",
      reasonCaption: "Alasan usulan",
      reopenedTitle: "Terbuka ulang · Clearance lama tidak berlaku",
      reopenedBody:
        "Usulan baru sedang diperiksa. Slip tetap tertahan sampai disetujui orang lain.",
      submit: "Setujui clearance",
      note: "Clearance hanya menutup flag ini. Tidak mengirim uang, tidak mengubah nominal, dan tidak mengabaikan flag lain.",
      back: "Kembali ke pemeriksaan",
      failedTitle: "Persetujuan belum dapat dikirim",
    },
    self: {
      title: "Anda adalah pengusul",
      body: "Anda mengusulkan clearance ini. Persetujuan harus dilakukan oleh orang lain.",
      noteTitle: "Usulan Anda menunggu orang lain",
      noteBody: "Anda mengusulkan pada {time}.",
      explain:
        "Pengusul tidak dapat menyetujui usulannya sendiri. Minta orang lain yang berwenang untuk meninjau.",
      detail: "Lihat rincian usulan",
    },
    history: {
      title: "Riwayat persetujuan",
      proposer: "Pengusul: {name}",
      approver: "Disetujui: {name}",
      note: "Flag ini telah ditutup. Persetujuan clearance tidak melakukan pembayaran.",
      scope:
        "Clearance hanya menghapus penahanan oleh flag ini. Flag lain atau syarat payout lain masih dapat menahan slip.",
      back: "Kembali ke pemeriksaan",
    },
    done: {
      title: "Clearance selesai",
      by: "Disetujui oleh {approver} setelah diusulkan oleh {proposer}.",
      closedTitle: "Flag ini sudah ditutup",
      closedBody:
        "Periksa flag lain yang masih terbuka sebelum melanjutkan penerbitan slip.",
      note: "Persetujuan ini tidak mengirim uang dan tidak mengubah nominal pembayaran.",
      banner: "Clearance disetujui oleh orang kedua",
      bannerBody:
        "{proposer} mengusulkan; {approver} menyetujui pada {time}. Flag {id} ditutup. Pembayaran tidak dijalankan oleh tindakan ini.",
    },
    changed: {
      title: "Data berubah setelah usulan dibuat",
      body: "Usulan ini tidak dapat disetujui. Periksa data terbaru, lalu buat usulan clearance baru. Slip tetap tertahan.",
      action: "Buat usulan baru",
      staleTitle: "Status clearance sudah berubah",
      staleBody:
        "Data sudah dimuat ulang. Periksa status terbaru sebelum melanjutkan.",
      staleAction: "Periksa data terbaru",
    },
    empty: {
      title: "Tidak ada flag rekonsiliasi",
      description:
        "Belum ada flag yang perlu ditinjau. Status pembayaran dan penerbitan slip tetap mengikuti pemeriksaan batch.",
      action: "Muat ulang",
    },
    noAccess: {
      title: "Layar ini memerlukan izin persetujuan pencairan",
      description:
        "Akun Anda belum memiliki izin untuk meninjau atau menyetujui clearance flag rekonsiliasi.",
    },
    error: {
      title: "Flag rekonsiliasi belum dapat dimuat",
      description:
        "Periksa koneksi, lalu coba lagi. Status flag belum dapat dipastikan; jangan lanjutkan penerbitan slip berdasarkan layar ini.",
      noData: "Data belum tersedia",
      noDataBody: "Daftar flag dan usulan clearance belum berhasil diambil.",
      retry: "Coba lagi",
    },
  },
  reconHold: {
    title: "Hold slip",
    subtitle:
      "Hold dibuat saat pemeriksaan malam tidak dapat menulis flag. Slip tetap tertahan sampai flag berikutnya mengambil alih, atau dua orang berbeda melepasnya setelah bukti bersih.",
    loading: "Memuat hold slip",
    count: "{count} hold",
    status: {
      held: "Ditahan",
      proposed: "Diusulkan lepas",
      released: "Dilepas",
      takenOver: "Sudah diambil alih flag",
    },
    card: {
      id: "Hold {id}",
      ref: "Item {item} · Slip {slip} · Batch {batch}",
      heldAt: "Ditahan sejak {time}",
      cause: "Penyebab",
      causeUnknown: "Penyebab tidak tercatat",
      causeEvidenceMissing: "Berkas bukti tidak ditemukan",
      causeEvidenceMismatch: "Isi berkas bukti tidak sama dengan catatan",
      causeEvidenceLocked: "Berkas bukti tidak bisa dibaca tepat waktu",
      causeOther: "Selisih lain pada rekonsiliasi",
      held: "Slip tertahan · Belum boleh diterbitkan",
      notClean:
        "Bukti rekonsiliasi belum bersih sejak hold dibuat. Hold tetap menahan slip sampai pemeriksaan berikutnya bersih.",
      takenOver:
        "Flag yang menahan slip ini sudah ditulis. Keputusan ada pada flag dan clearance-nya di daftar flag.",
      released:
        "Dilepas · {proposer} mengusulkan, {approver} menyetujui pada {time}.",
      releasedScope:
        "Pelepasan hanya mengangkat hold ini. Flag atau syarat payout lain masih dapat menahan slip.",
    },
    propose: {
      open: "Usulkan pelepasan",
      title: "Usulkan pelepasan hold",
      reasonLabel: "Alasan pelepasan",
      reasonPlaceholder: "Jelaskan bukti bersih yang Anda periksa.",
      reasonHint: "Wajib 10–500 karakter. Jelaskan mengapa hold dapat dilepas.",
      counter: "{count}/500 karakter",
      reasonError: "Tulis alasan minimal 10 karakter.",
      passwordLabel: "Konfirmasi sandi untuk pelepasan hold",
      passwordError: "Isi konfirmasi sandi untuk melanjutkan.",
      submit: "Usulkan pelepasan",
      cancel: "Batal",
      note: "Usulan belum melepas hold. Orang lain yang berwenang harus meninjau dan menyetujuinya. Slip tetap tertahan.",
      invalidTitle: "Usulan belum dapat dikirim",
      invalidBody:
        "Lengkapi alasan dan konfirmasi kata sandi pada kolom yang ditandai.",
      failedTitle: "Usulan belum dapat dikirim",
      sent: "Usulan pelepasan terkirim · Menunggu persetujuan orang lain",
      sentBody: "Hold tetap menahan slip sampai orang lain menyetujuinya.",
    },
    approve: {
      title: "Setujui pelepasan",
      proposedBy: "Diusulkan oleh",
      reasonCaption: "Alasan usulan",
      submit: "Setujui pelepasan",
      note: "Pelepasan hanya mengangkat hold ini. Tidak mengirim uang dan tidak mengubah nominal pembayaran.",
      failedTitle: "Persetujuan belum dapat dikirim",
      done: "Hold dilepas oleh orang kedua",
      doneBody:
        "Pelepasan disetujui. Pembayaran tidak dijalankan oleh tindakan ini.",
    },
    self: {
      title: "Anda adalah pengusul",
      body: "Anda mengusulkan pelepasan ini. Persetujuan harus dilakukan oleh orang lain.",
    },
    stale: {
      title: "Status hold sudah berubah",
      body: "Data sudah dimuat ulang. Periksa status terbaru; slip tetap tertahan sampai hold terbukti lepas.",
      action: "Tutup pesan",
    },
    empty: {
      title: "Tidak ada hold slip",
      description:
        "Belum ada slip yang ditahan karena flag yang gagal ditulis.",
    },
    error: {
      title: "Hold slip belum dapat dimuat",
      description:
        "Periksa koneksi, lalu coba lagi. Status hold belum dapat dipastikan; jangan lanjutkan penerbitan slip berdasarkan layar ini.",
      retry: "Muat ulang hold",
    },
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
