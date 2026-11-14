// WS-10 payout Persetujuan and Status karyawan tabs (legend-wnkep.7).
// Own file so parallel beads never edit the same catalog lines.
export const payrollPayoutReviewMessages = {
  common: {
    refresh: "Segarkan",
    unknownEmployee: "Karyawan tidak dikenal",
    noAccount: "Rekening belum tercatat",
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
    sourceBanner: {
      title: "Rekening sumber tidak aktif — pencairan ditolak",
      description:
        "{account} tidak dapat digunakan. Pilih rekening aktif pada pengaturan PT, lalu ajukan ulang untuk persetujuan.",
    },
    success: "Pencairan disetujui. Lanjutkan di tab Status karyawan.",
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
    evidenceUnavailableTitle: "Gagal dan Tidak terkirim belum bisa dipilih",
    evidenceUnavailable:
      "Unggah bukti belum tersedia: menandai gagal atau tidak terkirim memerlukan berkas bukti dari bank. Jangan bayar ulang. Hubungi tim teknis untuk penyelesaian manual.",
    submit: "Simpan hasil",
    cancel: "Batal",
    cashTitle: "Konfirmasi tunai diterima",
    cashDescription:
      "{name} · {amount}. Catat bahwa karyawan sudah menerima uang tunai.",
    cashSubmit: "Konfirmasi diterima",
  },
  error: {
    evidenceInvalid:
      "Berkas bukti tidak dikenali untuk pencairan ini. Tidak ada hasil yang dicatat.",
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
