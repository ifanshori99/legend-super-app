// Financial statements and period close (bead legend-rx0h; PRD v1.7 §3 F19
// "Laporan Keuangan", "Tutup Periode"; ACC-02, ACC-03). Own file so the
// parallel WS-07 beads never edit the same catalog lines.
export const accountingReportMessages = {
  title: "Laporan Keuangan",
  subtitle:
    "Neraca, laba rugi, arus kas, dan perubahan ekuitas per badan usaha, dengan penelusuran sampai transaksi sumber dan tutup periode.",
  screen: {
    statementType: "Jenis laporan",
    asOf: "Per posisi tanggal",
    from: "Dari tanggal",
    to: "Sampai tanggal",
    outlet: "Outlet",
    outletAll: "Semua outlet",
    outletHint:
      "Laba rugi per outlet memakai baris jurnal yang ditandai outlet tersebut (ACC-03).",
  },
  basis: {
    official: "Resmi",
    estimate: "Estimasi",
    label: "Status angka",
    officialTitle: "Angka resmi dari periode tertutup",
    officialNote:
      "Seluruh angka berasal dari periode yang sudah ditutup ({periods}) dan sama dengan snapshot saat tutup buku. Angka tidak berubah kecuali periode dibuka ulang dengan persetujuan.",
    estimateTitle: "Angka sementara (estimasi)",
    estimateNote:
      "Periode {open} masih terbuka, jadi angka dapat berubah sampai periode ditutup.",
    estimateMixedNote:
      "Rentang ini mencakup periode terbuka ({open}) sehingga seluruh laporan berlabel estimasi. Periode yang sudah ditutup di rentang ini: {closed}.",
    estimateUnknownNote:
      "Status periode untuk rentang ini belum diketahui, jadi angka diperlakukan sebagai estimasi.",
    multiEntityNote:
      "Laporan multi-entitas resmi hanya bila periode setiap badan usaha sudah ditutup.",
  },
  type: {
    balanceSheet: "Neraca",
    profitAndLoss: "Laba rugi",
    cashFlow: "Arus kas",
    equityChanges: "Perubahan ekuitas",
    multiEntity: "Multi-entitas",
  },
  statement: {
    balanceSheetSubtitle:
      "Aset, liabilitas, dan ekuitas pada tanggal tertentu, dari jurnal yang sudah dibukukan.",
    profitAndLossSubtitle:
      "Pendapatan, harga pokok, dan beban pada rentang tanggal, dengan laba kotor sampai laba bersih.",
    cashFlowSubtitle:
      "Arus kas langsung per aktivitas operasi, investasi, dan pendanaan.",
    equityChangesSubtitle:
      "Perubahan setiap komponen ekuitas: saldo awal, laba periode, distribusi, dan saldo akhir.",
    multiEntitySubtitle:
      "Laba rugi setiap badan usaha berdampingan; kolom gabungan hanya memuat laba bersih konsolidasi dari API.",
    accountColumn: "Akun",
    componentColumn: "Komponen",
    amountColumn: "Jumlah",
    subtotal: "Subtotal {group}",
    drillDown: "Telusuri {code} {name}",
    drillDownName: "Telusuri {name}",
    emptyTitle: "Belum ada baris laporan",
    emptyHint:
      "Tidak ada jurnal yang dibukukan pada rentang tanggal ini. Pilih periode lain atau atur ulang tanggal.",
    resetRange: "Atur ulang periode",
  },
  pl: {
    grossProfit: "Laba kotor",
    operatingProfit: "Laba operasi",
    netProfit: "Laba bersih",
  },
  bs: {
    currentEarnings: "Laba periode berjalan",
    totalAssets: "Total aset",
    totalLiabilities: "Total liabilitas",
    totalEquity: "Total ekuitas",
    equationNote:
      "Neraca seimbang bila total aset sama dengan total liabilitas ditambah ekuitas; API menolak laporan yang tidak seimbang.",
    balanced: "Seimbang",
    balancedHint: "Total aset sama dengan total liabilitas ditambah ekuitas.",
    unbalanced: "Tidak seimbang",
    unbalancedHint:
      "Total aset berbeda dari total liabilitas ditambah ekuitas. Jangan pakai laporan ini; hubungi tim keuangan.",
  },
  cf: {
    activity: {
      operating: "Aktivitas operasi",
      investing: "Aktivitas investasi",
      financing: "Aktivitas pendanaan",
    },
    openingCash: "Kas awal periode",
    netChange: "Perubahan kas bersih",
    closingCash: "Kas akhir periode",
    emptyActivity: "Tidak ada arus kas pada aktivitas ini.",
    emptyTitle: "Belum ada arus kas",
    emptyHint:
      "Tidak ada mutasi kas pada rentang tanggal ini. Pilih periode lain atau atur ulang tanggal.",
  },
  equity: {
    columns: {
      opening: "Saldo awal",
      profit: "Laba periode",
      distributions: "Distribusi",
      other: "Pergerakan lain",
      closing: "Saldo akhir",
    },
    emptyTitle: "Belum ada perubahan ekuitas",
    emptyHint:
      "Tidak ada mutasi ekuitas pada rentang tanggal ini. Pilih periode lain atau atur ulang tanggal.",
  },
  multi: {
    combinedColumn: "Gabungan",
    combinedNetProfit: "Laba bersih gabungan",
    entityFallback: "Badan usaha",
    note: "Setiap kolom berasal dari laba rugi badan usaha tersebut. Angka gabungan per baris belum disediakan API; hanya laba bersih gabungan yang ditampilkan.",
    emptyTitle: "Belum ada laba rugi badan usaha",
    emptyHint:
      "Tidak ada jurnal pada rentang tanggal ini. Pilih periode lain atau atur ulang tanggal.",
  },
  drillDown: {
    title: "Penelusuran baris",
    total: "Total baris",
    traceHint:
      "Baris di bawah adalah jurnal yang membentuk angka ini. Buka jurnal untuk melihat dokumen sumbernya (ACC-03).",
    range: "Periode {from} – {to}",
    rangeTo: "Semua jurnal sampai {to}",
    columns: {
      date: "Tanggal",
      journal: "Nomor jurnal",
      description: "Keterangan",
      source: "Sumber",
      debit: "Debit",
      credit: "Kredit",
    },
    openJournal: "Buka jurnal",
    loadMore: "Muat baris berikutnya",
    count: "{count} baris dimuat",
    emptyTitle: "Tidak ada jurnal untuk akun ini",
    emptyHint:
      "Akun ini tidak memiliki baris jurnal pada rentang tanggal dan outlet yang dipilih.",
    errorTitle: "Baris jurnal tidak dapat dimuat",
  },
  periods: {
    title: "Tutup periode",
    subtitle:
      "Tutup bulan dengan snapshot saldo; pembukaan ulang memerlukan alasan dan persetujuan orang lain (ACC-02).",
    summaryLabel: "Ringkasan periode",
    statOpen: "Periode terbuka",
    statClosed: "Periode tertutup",
    statNext: "Berikutnya ditutup",
    statOpenContext: "Posting masih diterima",
    statClosedContext: "Posting ditolak sampai dibuka ulang",
    statNextContext: "Periode terlama yang sudah berakhir",
    statNextNone: "Tidak ada",
    statNextNoneHint: "Belum ada periode terbuka yang sudah berakhir.",
    tableTitle: "Periode fiskal",
    tableSubtitle:
      "Tutup berurutan dari periode paling awal. Jurnal tetap final setelah periode ditutup.",
    columns: {
      period: "Periode",
      status: "Status",
      closed: "Ditutup",
      version: "Versi",
      actions: "Aksi",
    },
    statusOpen: "Terbuka",
    statusClosed: "Tertutup",
    openHint: "Belum ditutup",
    reopenedHint: "Dibuka ulang {time}",
    reopenedReason: "Alasan buka ulang: {reason}",
    closedBy: "oleh {user}",
    close: "Tutup periode",
    snapshot: "Lihat snapshot",
    requestReopen: "Ajukan buka ulang",
    requestUnavailable:
      "Hanya periode tertutup terakhir yang dapat dibuka ulang.",
    emptyTitle: "Belum ada periode fiskal",
    emptyHint:
      "Periode fiskal terbentuk saat jurnal pertama suatu bulan dibukukan.",
    closeDialog: {
      title: "Tutup periode {period}",
      description:
        "Periksa daftar periksa sebelum menutup. Setelah ditutup, posting ke periode ini ditolak sampai ada pembukaan ulang yang disetujui (ACC-02).",
      checklist: "Daftar periksa",
      checkPeriodEnded: "Periode sudah berakhir",
      checkPreviousClosed: "Periode sebelumnya sudah ditutup",
      checkNoDraft: "Tidak ada jurnal draf",
      checkNoPending: "Tidak ada jurnal menunggu persetujuan",
      checkBalanced: "Neraca saldo seimbang",
      checkSnapshot: "Snapshot saldo",
      detailOk: "Lolos",
      detailFailed: "Belum lolos",
      draftBlocked: "{count} jurnal draf di periode ini",
      draftHint: "Selesaikan atau batalkan jurnal draf di menu Jurnal manual.",
      pendingBlocked: "{count} jurnal menunggu persetujuan di periode ini",
      pendingHint:
        "Setujui atau tolak jurnal di menu Jurnal manual sebelum menutup.",
      notEndedHint: "Tutup hanya dapat dilakukan setelah bulan berakhir.",
      previousOpenHint: "Tutup periode sebelumnya terlebih dahulu.",
      unbalancedHint:
        "Total debit dan kredit harus sama. Periksa jurnal yang belum seimbang.",
      totals: "Neraca saldo per {date}",
      totalDebit: "Total debit",
      totalCredit: "Total kredit",
      snapshotPending: "Snapshot saldo akan diambil saat periode ditutup.",
      blockersTitle: "Perbaiki dulu sebelum menutup",
      readyTitle: "Siap ditutup",
      readyHint:
        "Semua pemeriksaan lolos. Menutup periode mengunci jurnal dan mengambil snapshot saldo.",
      submit: "Tutup periode",
      confirmTitle: "Tutup periode {period}?",
      confirmBody:
        "Setelah ditutup, posting ke periode ini ditolak sampai ada pembukaan ulang yang disetujui (ACC-02).",
      confirmSubmit: "Ya, tutup periode",
      closed: "Periode {period} ditutup.",
      failed: "Periode tidak dapat ditutup.",
      errorTitle: "Daftar periksa tidak dapat dimuat",
    },
    snapshotDialog: {
      title: "Snapshot periode {period}",
      description:
        "Saldo yang dibekukan saat periode ditutup. Snapshot tidak berubah selama periode tertutup.",
      version: "Versi snapshot",
      periodStatus: "Status periode saat ini",
      periodVersion: "Versi periode saat ini",
      historyTitle: "Snapshot ini riwayat",
      historyHint:
        "Periode sudah dibuka ulang setelah snapshot ini diambil, jadi saldonya bisa berbeda dari kondisi sekarang. Tutup ulang periode untuk snapshot baru.",
      takenAt: "Diambil",
      takenBy: "Diambil oleh",
      totalDebit: "Total debit",
      totalCredit: "Total kredit",
      netProfit: "Laba bersih periode",
      balances: "Saldo per akun",
      columns: {
        account: "Akun",
        debit: "Debit",
        credit: "Kredit",
      },
      missingTitle: "Snapshot belum tersedia",
      missingHint: "Snapshot dibuat saat periode ditutup.",
      errorTitle: "Snapshot tidak dapat dimuat",
      summaryLabel: "Ringkasan snapshot",
    },
    reopen: {
      requestTitle: "Ajukan buka ulang {period}",
      requestHint:
        "Pembukaan ulang memungkinkan posting kembali ke periode ini. Permintaan harus disetujui orang lain (AUTH-06).",
      reason: "Alasan buka ulang",
      reasonHint:
        "Jelaskan dokumen atau koreksi yang tertinggal. Minimal {count} karakter.",
      reasonRequired: "Alasan wajib diisi.",
      reasonTooShort: "Alasan minimal {count} karakter.",
      requestSubmit: "Kirim permintaan",
      requested: "Permintaan buka ulang dikirim.",
      requestFailed: "Permintaan buka ulang gagal dikirim.",
      requestsTitle: "Permintaan buka ulang",
      requestsSubtitle:
        "Penyetuju harus orang yang berbeda dari pemohon (AUTH-06) dan dari penutup periode; API menolak persetujuan oleh keduanya.",
      requestsEmptyTitle: "Belum ada permintaan buka ulang",
      requestsEmptyHint:
        "Ajukan buka ulang untuk periode tertutup terakhir bila ada koreksi yang tertinggal.",
      columns: {
        period: "Periode",
        reason: "Alasan",
        status: "Status",
        requested: "Diajukan",
        decided: "Diputuskan",
        actions: "Aksi",
      },
      status: {
        pending: "Menunggu persetujuan",
        approved: "Disetujui",
        rejected: "Ditolak",
        cancelled: "Dibatalkan",
      },
      approve: "Setujui",
      reject: "Tolak",
      approveTitle: "Setujui buka ulang {period}?",
      approveBody:
        "Periode dibuka kembali dan posting ke periode ini diterima lagi. Penyetuju tercatat dan harus berbeda dari pemohon (AUTH-06).",
      approveSubmit: "Ya, buka ulang",
      approved: "Periode {period} dibuka ulang.",
      rejectTitle: "Tolak buka ulang {period}",
      rejectReason: "Alasan penolakan",
      rejectReasonHint: "Alasan ini terlihat oleh pemohon.",
      rejectSubmit: "Tolak permintaan",
      rejected: "Permintaan buka ulang ditolak.",
      failed: "Permintaan tidak dapat diproses.",
      approverIsRequester:
        "Anda yang mengajukan permintaan ini, jadi tidak dapat menyetujuinya sendiri. Minta penyetuju lain (AUTH-06).",
      approverIsCloser:
        "Anda yang menutup periode ini, jadi tidak dapat menyetujui pembukaan ulangnya. Minta penyetuju lain.",
      outOfOrder: "Buka ulang periode setelahnya terlebih dahulu.",
      alreadyOpen: "Periode ini sudah terbuka.",
      alreadyDecided: "Permintaan ini sudah diputuskan. Muat ulang daftar.",
      empty: "—",
      decisionNote: "Catatan keputusan: {note}",
    },
  },
};
