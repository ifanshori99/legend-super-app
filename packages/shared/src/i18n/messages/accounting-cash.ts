// Cash & bank back office (bead legend-53q; PRD v1.7 §3 F19 "Kas & Bank,
// Rekonsiliasi Gateway"; ACC-04, ACC-05). Own file so the parallel WS-07
// beads never edit the same catalog lines.
//
// All keys are mounted under `accounting.cash` by messages/id.ts. Placeholders
// use {name}; amounts are rendered with <Money>, never interpolated here.
export const accountingCashMessages = {
  title: "Kas & Bank",
  subtitle:
    "Saldo rekening bank, impor mutasi rekening, pencocokan transaksi, setoran kas, dan kasus rekonsiliasi gateway.",

  // ---- Ringkasan (StatStrip) ------------------------------------------------
  strip: {
    label: "Ringkasan kas dan bank",
    undeposited: "Kas belum disetor",
    undepositedContext: "{count} hari kas melewati batas setoran",
    undepositedClear: "Semua kas outlet sudah disetor",
    unmatched: "Baris belum cocok",
    unmatchedContext: "Dari {count} baris mutasi di rekening ini",
    openDifference: "Selisih dalam kasus",
    openDifferenceContext: "{count} kasus belum selesai",
    openDifferenceClear: "Tidak ada selisih terbuka",
    autoMatch: "Kecocokan otomatis",
    autoMatchContext: "Target ≥ {target} (ACC-04)",
    autoMatchReached: "Target tercapai",
    autoMatchBelow: "Di bawah target",
    noAccount: "Pilih rekening bank untuk melihat ringkasan.",
  },

  // ---- Rekening bank --------------------------------------------------------
  accounts: {
    title: "Rekening bank",
    subtitle:
      "Rekening yang dipakai untuk mutasi, setoran kas, dan rekonsiliasi.",
    add: "Tambah rekening",
    select: "Pilih",
    selected: "Dipilih",
    emptyTitle: "Belum ada rekening bank",
    emptyHint:
      "Tambahkan rekening pertama supaya mutasi dan setoran bisa dicatat.",
    columns: {
      bank: "Bank",
      name: "Nama rekening",
      number: "Nomor rekening",
      gl: "Akun buku besar",
      status: "Status",
      action: "Pilihan",
    },
    active: "Aktif",
    inactive: "Nonaktif",
    form: {
      title: "Tambah rekening bank",
      description:
        "Nomor rekening disimpan terenkripsi; layar hanya menampilkan empat digit terakhir.",
      bank: "Nama bank",
      bankHint: "Contoh: BCA, Mandiri, BNI, BJB.",
      name: "Nama pemilik rekening",
      number: "Nomor rekening",
      numberHint:
        "Angka saja, 6–20 digit. Hanya empat digit terakhir yang ditampilkan.",
      gl: "Akun buku besar",
      glHint:
        "Akun kas atau bank di bagan akun yang menerima mutasi rekening ini.",
      submit: "Simpan rekening",
      saved: "Rekening bank tersimpan.",
      failed: "Rekening gagal disimpan. Periksa nomor rekening lalu coba lagi.",
      noGlAccounts:
        "Belum ada akun kas atau bank aktif di bagan akun. Tambahkan akunnya dulu.",
    },
    errorTaken: "Nomor rekening ini sudah terdaftar di badan usaha yang sama.",
  },

  // ---- Impor mutasi CSV -----------------------------------------------------
  import: {
    action: "Impor mutasi",
    title: "Impor mutasi rekening (CSV)",
    description:
      "Unggah atau tempel ekspor CSV bank, petakan kolomnya, lalu periksa baris sebelum diimpor.",
    steps: {
      source: "Sumber",
      mapping: "Kolom",
      preview: "Pratinjau",
    },
    source: {
      title: "Pilih rekening dan berkas",
      account: "Rekening tujuan",
      accountHint: "Rekening yang menerima mutasi ini.",
      file: "Berkas CSV",
      fileHint: "Maksimal 90 kB; pemisah koma, titik koma, atau tab.",
      fileSelected: "Berkas dipilih: {name}",
      paste: "Atau tempel isi CSV",
      pastePlaceholder: "Tanggal,Keterangan,Referensi,Debit,Kredit",
      tooLarge: "Berkas melebihi 90 kB. Pecah mutasi per bulan.",
      empty: "Isi CSV masih kosong.",
      unreadable:
        "Berkas tidak bisa dibaca. Coba unggah ulang atau tempel isinya.",
      noHeaderHint:
        "Baris pertama dianggap data karena tidak ada judul kolom yang dikenali.",
    },
    mapping: {
      title: "Petakan kolom CSV",
      description:
        "Kolom dihitung dari kiri mulai 0. Periksa sekali per bank; impor berikutnya bisa memakai pemetaan yang sama.",
      columnsDetected: "{count} kolom terbaca dari berkas.",
      delimiter: "Pemisah kolom",
      delimiterComma: "Koma (,)",
      delimiterSemicolon: "Titik koma (;)",
      delimiterTab: "Tab",
      hasHeader: "Baris pertama adalah judul kolom",
      dateColumn: "Kolom tanggal",
      dateFormat: "Format tanggal",
      descriptionColumn: "Kolom keterangan",
      amountKind: "Bentuk nominal",
      amountSigned: "Satu kolom nominal bertanda",
      amountDebitCredit: "Kolom debit dan kredit terpisah",
      amountColumn: "Kolom nominal",
      debitColumn: "Kolom debit (keluar)",
      creditColumn: "Kolom kredit (masuk)",
      decimalSeparator: "Pemisah desimal",
      referenceColumn: "Kolom referensi",
      noReference: "Tanpa referensi",
      columnOption: "Kolom {index}",
      columnOptionNamed: "Kolom {index} · {name}",
      invalid:
        "Pemetaan kolom belum lengkap atau menunjuk kolom di luar berkas.",
    },
    preview: {
      title: "Periksa baris mutasi",
      description:
        "Baris duplikat dilewati. Baris bermasalah harus diperbaiki di berkas lalu diunggah ulang.",
      ready: "{count} baris siap diimpor",
      duplicates: "{count} duplikat dilewati",
      errors: "{count} baris bermasalah",
      columns: {
        row: "Baris",
        date: "Tanggal",
        description: "Keterangan",
        amount: "Nominal",
        status: "Status",
      },
      statusReady: "Baru",
      statusDuplicate: "Duplikat",
      statusError: "Bermasalah",
      errorColumns: "Kolom baris kurang dari pemetaan.",
      errorDate: "Tanggal tidak terbaca dengan format yang dipilih.",
      errorAmount: "Nominal tidak terbaca atau bernilai nol.",
      errorDebitCredit: "Isi hanya salah satu dari debit atau kredit.",
      errorDescription: "Keterangan wajib diisi, maksimal 255 karakter.",
      errorReference: "Referensi maksimal 100 karakter.",
      errorDedupeKey:
        "Keterangan atau referensi terlalu panjang setelah dinormalisasi.",
      fixErrors: "Perbaiki {count} baris bermasalah sebelum mengimpor.",
      empty: "Tidak ada baris data yang bisa dibaca.",
    },
    submit: "Impor {count} baris",
    importing: "Mengimpor…",
    result:
      "Impor selesai: {count} baris, {duplicates} duplikat, {auto} cocok otomatis.",
    failed: "Impor gagal tersimpan. Periksa kembali berkas dan pemetaan kolom.",
    error: {
      valueTitle: "Berkas ditolak: ada nilai yang tidak bisa dibaca",
      conflict:
        "Sebagian mutasi di berkas ini sudah tercatat atau sudah dicocokkan. Muat ulang daftar mutasi lalu coba lagi.",
    },
    back: "Kembali",
    next: "Lanjut",
  },

  // ---- Ruang cocok ----------------------------------------------------------
  match: {
    title: "Ruang cocok mutasi",
    subtitle:
      "Cocokkan mutasi bank dengan jurnal, setoran kas, atau settlement gateway. Setiap selisih menjadi kasus dengan PIC.",
    account: "Rekening",
    from: "Dari tanggal",
    to: "Sampai tanggal",
    statusFilter: "Status cocok",
    allStatuses: "Semua status",
    loadMore: "Muat baris berikutnya",
    count: "{count} baris dimuat",
    emptyTitle: "Belum ada mutasi",
    emptyHint: "Impor mutasi CSV bank untuk mulai mencocokkan.",
    noAccountTitle: "Belum ada rekening bank",
    noAccountHint:
      "Tambahkan rekening bank dulu supaya mutasi bisa dicocokkan.",
    columns: {
      date: "Tanggal",
      description: "Keterangan",
      amount: "Nominal",
      status: "Status",
      suggestion: "Saran",
      actions: "Tindakan",
    },
    status: {
      unmatched: "Belum cocok",
      auto_matched: "Cocok otomatis",
      manually_matched: "Cocok manual",
      in_case: "Dalam kasus",
      excluded: "Dikecualikan",
    },
    suggestion: {
      auto: "Saran: {ref} · {date}",
      ambiguous: "{count} kandidat, pilih satu",
      none: "Tidak ada kandidat",
      choose: "Pilih kandidat",
      match: "Cocokkan",
      matching: "Mencocokkan…",
    },
    matchDone: "Pencocokan tersimpan.",
    actions: {
      unmatch: "Lepas",
      exclude: "Kecualikan",
      restore: "Batalkan pengecualian",
      case: "Buat kasus",
      matchedRefs: "Cocok dengan",
    },
    exclude: {
      title: "Kecualikan baris mutasi",
      description:
        "Baris yang dikecualikan tidak dihitung dalam kecocokan otomatis. Tuliskan alasannya.",
      label: "Alasan pengecualian",
      submit: "Kecualikan",
      done: "Baris mutasi dikecualikan.",
    },
    unmatch: {
      title: "Lepas pencocokan?",
      description: "Baris kembali belum cocok dan bisa dicocokkan ulang.",
      submit: "Lepas",
      done: "Pencocokan dilepas.",
    },
    restore: {
      title: "Batalkan pengecualian?",
      description: "Baris kembali belum cocok dan masuk hitungan kecocokan.",
      done: "Pengecualian dibatalkan.",
    },
    ref: {
      journal_entry: "Jurnal",
      cash_deposit: "Setoran kas",
      gateway_settlement: "Settlement gateway",
      edc_settlement: "Settlement EDC",
      supplier_payment: "Pembayaran supplier",
      bank_statement_line: "Baris mutasi",
    },
    error: {
      alreadyMatched:
        "Baris ini sudah cocok. Lepas dulu sebelum mencocokkan ulang.",
      amountMismatch: "Nominal dokumen tidak sama dengan nominal mutasi.",
      inCase: "Baris ini sedang dalam kasus. Selesaikan kasusnya dulu.",
      excluded:
        "Baris ini dikecualikan. Batalkan pengecualian sebelum mencocokkan.",
      notFound: "Dokumen yang dipilih tidak ditemukan.",
      invalid: "Pencocokan ini tidak diizinkan.",
      failed: "Pencocokan gagal disimpan. Coba lagi.",
    },
  },

  // ---- Kasus (dibuka dari baris mutasi atau settlement) ---------------------
  case: {
    open: "Buat kasus",
    title: "Buat kasus rekonsiliasi",
    description:
      "Setiap selisih harus punya PIC dan tenggat. Kasus ditutup dengan catatan penyelesaian.",
    line: "Baris mutasi",
    difference: "Selisih",
    pic: "PIC",
    picHint: "Penanggung jawab yang menyelesaikan selisih ini.",
    noPeople:
      "Daftar pengguna belum tersedia. Kasus tidak bisa dibuka tanpa PIC.",
    submit: "Buka kasus",
    done: "Kasus rekonsiliasi dibuka.",
    failed: "Kasus gagal dibuka. Coba lagi.",
  },

  // ---- Setoran kas ----------------------------------------------------------
  deposits: {
    title: "Setoran kas",
    subtitle:
      "Setoran kas harian outlet ke bank, dicocokkan dengan mutasi rekening.",
    add: "Catat setoran",
    loadMore: "Muat setoran berikutnya",
    count: "{count} setoran dimuat",
    emptyTitle: "Belum ada setoran",
    emptyHint:
      "Catat setoran kas outlet supaya bisa dicocokkan dengan mutasi bank.",
    columns: {
      date: "Tanggal setor",
      outlet: "Outlet",
      covers: "Periode kas",
      amount: "Nominal",
      bank: "Rekening",
      slip: "Bukti",
      status: "Status",
    },
    covers: "{from} – {to}",
    status: {
      recorded: "Tercatat",
      matched: "Cocok dengan mutasi",
      discrepancy: "Selisih",
    },
    form: {
      title: "Catat setoran kas",
      description:
        "Setoran dianggap cocok bila ada satu mutasi masuk dengan nominal yang sama dalam toleransi tanggal.",
      outlet: "Outlet",
      outletHint: "Outlet yang kasnya disetor.",
      bankAccount: "Rekening tujuan",
      amount: "Nominal setoran",
      amountHint: "Rupiah penuh, tanpa desimal.",
      coversFrom: "Kas mulai tanggal",
      coversTo: "Kas sampai tanggal",
      depositedAt: "Waktu setor",
      depositedAtHint: "Tanggal dan jam setoran di bank atau ATM.",
      slip: "Nomor bukti setor",
      slipHint: "Nomor slip teller atau ATM, bila ada.",
      submit: "Simpan setoran",
      saved: "Setoran kas tercatat.",
      invalidAmount: "Nominal harus lebih dari nol.",
      invalidRange: "Tanggal akhir tidak boleh sebelum tanggal mulai.",
      noOutlets: "Belum ada outlet yang bisa dipilih.",
      failed: "Setoran gagal disimpan. Coba lagi.",
    },
    alerts: {
      label: "Peringatan kas belum disetor",
      title: "Kas belum disetor melewati batas",
      description:
        "Setorkan kas berikut ke bank. Peringatan muncul setelah kas melewati batas hari yang ditetapkan.",
      emptyTitle: "Semua kas sudah disetor",
      emptyHint: "Tidak ada kas outlet yang melewati batas setoran.",
      days: "{count} hari",
      line: "{outlet} · kas {date} · {days} hari",
    },
  },

  // ---- Kas masuk, kas keluar, transfer (legend-4961) ------------------------
  entries: {
    title: "Kas masuk, kas keluar, dan transfer",
    subtitle:
      "Uang yang masuk dan keluar rekening bank di luar penjualan, serta pemindahan antar rekening. Setiap dokumen menghasilkan satu jurnal.",
    add: "Catat transaksi",
    period: "Periode {month}",
    noBankAccounts: "Tambah rekening bank dulu.",
    noBankAccountsLink: "Ke daftar rekening",
    transferNeedsTwo: "Butuh 2 rekening",
    lookupPending: "Memuat…",
    bankMissing: "Rekening tidak ditemukan",
    accountMissing: "Akun tidak ditemukan",
    addCashIn: "Catat kas masuk",
    addCashOut: "Catat kas keluar",
    addTransfer: "Pindah antar rekening",
    count: "{count} dokumen dimuat",
    emptyTitle: "Belum ada kas masuk, kas keluar, atau transfer",
    emptyHint:
      "Catat uang masuk atau keluar rekening bank, atau pindahkan dana antar rekening.",
    columns: {
      date: "Tanggal",
      kind: "Jenis",
      description: "Keterangan",
      account: "Rekening",
      counter: "Akun lawan",
      amount: "Nominal",
      reference: "Referensi",
      status: "Status",
      actions: "Tindakan",
      kindDate: "Jenis dan tanggal",
    },
    kind: {
      cash_in: "Kas masuk",
      cash_out: "Kas keluar",
      transfer: "Transfer",
      petty_topup: "Isi kas kecil",
    },
    status: {
      pending_approval: "Menunggu persetujuan",
      approved: "Disetujui",
      rejected: "Ditolak",
    },
    approval: {
      approve: "Setujui",
      inbox: "Ke kotak persetujuan",
      inboxLabel: "Ke kotak persetujuan: {description}",
      actionLabel: "{action} {description}",
      rejectTarget: "Yang ditolak: {description}",
      approved: "{kind} disetujui dan dijurnal.",
      reject: "Tolak",
      rejected: "{kind} ditolak. Tidak ada jurnal yang dibuat.",
      rejectTitle: "Tolak {kind}",
      rejectDescription:
        "{kind} yang ditolak tidak dijurnal dan tidak bisa disetujui lagi. Tulis alasannya.",
      reason: "Alasan penolakan",
      reasonRequired: "Isi alasan penolakan.",
      reasonTooLong: "Alasan paling banyak 500 karakter.",
      rejectSubmit: "Tolak {kind}",
      ownEntry: "Tidak bisa menyetujui {kind} buatan sendiri.",
      decisionReason: "Alasan: {reason}",
      failed: "Keputusan gagal disimpan. Coba lagi.",
    },
    limit: {
      title: "Batas persetujuan kas keluar",
      description:
        "Kas keluar di atas batas ini menunggu persetujuan orang lain sebelum dijurnal. Sama dengan batas atau di bawahnya langsung dijurnal.",
      current: "Batas saat ini",
      defaultNote: "Batas bawaan. Belum diatur untuk badan usaha ini.",
      edit: "Ubah batas",
      field: "Batas (Rp)",
      fieldHint: "Rupiah penuh, minimal Rp1.",
      invalid: "Batas harus bilangan bulat lebih dari nol.",
      tooLarge: "Batas paling besar Rp100.000.000.000.",
      save: "Simpan batas",
      saved: "Batas persetujuan disimpan.",
      failed: "Batas gagal disimpan. Coba lagi.",
      loadFailed: "Batas persetujuan belum bisa dimuat.",
    },
    transferArrow: "{from} ke {to}",
    transferFrom: "Dari {account}",
    transferTo: "Ke {account}",
    form: {
      titleCashIn: "Catat kas masuk",
      titleCashOut: "Catat kas keluar",
      titleTransfer: "Pindah antar rekening",
      descriptionCashIn:
        "Uang masuk ke rekening bank. Pilih akun lawan yang menjelaskan asal uangnya.",
      descriptionCashOut:
        "Uang keluar dari rekening bank. Pilih akun lawan yang menjelaskan tujuan uangnya.",
      descriptionTransfer:
        "Dana pindah dari satu rekening ke rekening lain di badan usaha yang sama.",
      bankAccount: "Rekening",
      fromAccount: "Dari rekening",
      toAccount: "Ke rekening",
      counterAccount: "Akun lawan",
      counterHint:
        "Akun kas dan bank tidak bisa dipilih di sini. Pakai transfer untuk memindahkan dana antar rekening.",
      noCounterAccounts: "Belum ada akun yang bisa dipilih.",
      counterPlaceholder: "Pilih akun lawan",
      counterRequired: "Pilih akun lawan. Tidak ada pilihan otomatis.",
      bankRequired: "Pilih rekening.",
      toAccountRequired: "Pilih rekening tujuan.",
      descriptionRequired: "Isi keterangan.",
      amount: "Nominal",
      amountHint: "Rupiah penuh, tanpa desimal.",
      date: "Tanggal",
      dateHint: "Tidak boleh di masa depan.",
      description: "Keterangan",
      reference: "Nomor referensi",
      referenceHint: "Nomor faktur atau bukti, bila ada.",
      outlet: "Outlet (opsional)",
      outletHint:
        "Tandai biaya ke satu outlet. Kosongkan untuk seluruh badan usaha.",
      noOutlet: "Seluruh badan usaha",
      submit: "Simpan",
      saved: "Dokumen kas dan bank tercatat.",
      invalidAmount: "Nominal harus lebih dari nol.",
      sameAccount: "Rekening asal dan tujuan harus berbeda.",
      futureDate: "Tanggal tidak boleh di masa depan.",
      approvalBanner:
        "Nominal di atas batas {limit}. Kas keluar ini menunggu persetujuan orang lain dan belum dijurnal.",
      savedPending:
        "Kas keluar tersimpan dan menunggu persetujuan. Belum ada jurnal.",
      needTwoAccounts: "Transfer butuh minimal dua rekening bank.",
      failed: "Dokumen gagal disimpan. Coba lagi.",
    },
  },

  // ---- Kas kecil (legend-4961) ----------------------------------------------
  petty: {
    title: "Kas kecil",
    subtitle:
      "Saldo kas kecil tiap outlet. Isi dari bank, kembalikan ke bank, dan pembelian sederhana mengurangi saldo. Saldo tidak bisa kurang dari nol.",
    topup: "Isi kas kecil",
    return: "Kembalikan ke bank",
    balance: "Saldo",
    emptyTitle: "Belum ada kas kecil",
    emptyHint:
      "Kas kecil outlet dibuat saat pengisian pertama dari rekening bank.",
    history: "Riwayat kas kecil {outlet}",
    historyEmpty: "Belum ada pergerakan kas kecil di periode ini.",
    columns: {
      date: "Tanggal",
      kind: "Jenis",
      description: "Keterangan",
      amount: "Nominal",
      balanceAfter: "Saldo sesudahnya",
      actions: "Aksi",
      journal: "Jurnal",
    },
    kind: {
      topup: "Isi",
      return: "Kembali ke bank",
      purchase: "Pembelian",
    },
    journal: {
      posted: "Terjurnal",
      parked: "Menunggu peta akun",
      external: "Dijurnal oleh pembelian",
    },
    parkedHint:
      "Peta akun kas kecil belum diatur. Saldo sudah bergerak; jurnal dikirim setelah peta akun dilengkapi.",
    period: "Periode {month}",
    noBankAccounts: "Tambah rekening bank dulu.",
    noBankAccountsLink: "Ke daftar rekening",
    returnNeedsBalance: "Saldo kosong",
    lookupPending: "Memuat…",
    outletMissing: "Outlet tidak ditemukan",
    retry: "Coba jurnal lagi",
    retried: "Jurnal kas kecil terkirim.",
    retryFailed: "Jurnal belum bisa dikirim. Periksa peta akun lalu coba lagi.",
    form: {
      titleTopup: "Isi kas kecil",
      titleReturn: "Kembalikan kas kecil ke bank",
      descriptionTopup: "Dana pindah dari rekening bank ke kas kecil outlet.",
      descriptionReturn:
        "Dana pindah dari kas kecil outlet ke rekening bank. Tidak boleh melebihi saldo.",
      outlet: "Outlet",
      outletHint: "Outlet pemilik kas kecil.",
      noOutlets: "Belum ada outlet yang bisa dipilih.",
      outletRequired: "Pilih outlet.",
      outletPlaceholder: "Pilih outlet",
      bankRequired: "Pilih rekening bank.",
      descriptionRequired: "Isi keterangan.",
      balanceError:
        "Saldo belum bisa dimuat, jadi batas pengembalian belum bisa dicek.",
      balanceRetry: "Muat saldo lagi",
      bankAccount: "Rekening bank",
      amount: "Nominal",
      amountHint: "Rupiah penuh, tanpa desimal.",
      currentBalance: "Saldo sekarang",
      description: "Keterangan",
      submit: "Simpan",
      saved: "Pergerakan kas kecil tercatat.",
      pendingApproval:
        "Isi kas kecil menunggu persetujuan. Saldo belum bertambah dan belum dijurnal.",
      invalidAmount: "Nominal harus lebih dari nol.",
      overBalance: "Nominal melebihi saldo kas kecil.",
      failed: "Pergerakan gagal disimpan. Coba lagi.",
    },
  },

  // ---- Rekonsiliasi gateway -------------------------------------------------
  recon: {
    title: "Rekonsiliasi gateway",
    subtitle:
      "Settlement gateway dibandingkan dengan mutasi bank, termasuk biaya MDR QRIS dan biaya layanan Virtual Account.",
    account: "Rekening bank",
    from: "Dari tanggal",
    to: "Sampai tanggal",
    loadMore: "Muat kasus berikutnya",
    count: "{count} kasus dimuat",
    summary: {
      label: "Ringkasan rekonsiliasi",
      autoMatch: "Kecocokan otomatis",
      target: "Target ≥ {target} (ACC-04)",
      reached: "Target tercapai",
      below: "Di bawah target",
      autoMatched: "Cocok otomatis",
      manuallyMatched: "Cocok manual",
      unmatched: "Belum cocok",
      inCase: "Dalam kasus",
      excluded: "Dikecualikan",
      total: "{count} baris di rekening ini",
      manualContext: "{count} cocok manual",
    },
    settlement: {
      title: "Settlement gateway",
      subtitle:
        "Bruto, biaya per akun, dan nominal yang diterima di bank untuk setiap settlement.",
      emptyTitle: "Belum ada settlement gateway",
      emptyHint:
        "Settlement muncul saat gateway mengirim laporan pada periode ini.",
      columns: {
        date: "Tanggal",
        description: "Settlement",
        gross: "Bruto",
        fee: "Biaya",
        net: "Diterima di bank",
        status: "Status",
      },
      feeLine: "Biaya · {account}",
      status: "Cocok dengan mutasi",
      unmatched: "Belum cocok dengan mutasi",
      variance: "Selisih",
      openCase: "Buat kasus",
      grossLabel: "Settlement bruto",
      netLabel: "Diterima di bank",
    },
    cases: {
      title: "Kasus rekonsiliasi",
      subtitle: "Setiap selisih dengan PIC, tenggat, dan catatan penyelesaian.",
      filterStatus: "Status kasus",
      allStatuses: "Semua status",
      emptyTitle: "Tidak ada kasus rekonsiliasi",
      emptyHint: "Selisih yang perlu diselesaikan akan muncul di sini.",
      columns: {
        opened: "Dibuka",
        type: "Jenis",
        difference: "Selisih",
        owner: "PIC",
        due: "Tenggat",
        status: "Status",
        action: "Tindakan",
      },
      open: "Buka kasus",
      unknownUser: "Pengguna {id}",
    },
    type: {
      bank_statement: "Mutasi bank",
      gateway_settlement: "Settlement gateway",
      edc_settlement: "Settlement EDC",
      cash_deposit: "Setoran kas",
    },
    status: {
      open: "Terbuka",
      in_progress: "Dikerjakan",
      resolved: "Selesai",
      written_off: "Dihapusbukukan",
    },
    drawer: {
      title: "Detail kasus",
      loading: "Memuat kasus…",
      error: "Kasus tidak dapat dimuat.",
      difference: "Selisih",
      pic: "PIC",
      due: "Tenggat",
      openedAt: "Dibuka",
      resolvedAt: "Diselesaikan",
      resolvedBy: "Diselesaikan oleh",
      note: "Catatan penyelesaian",
      refs: "Dokumen terkait",
      refCount: "{count} dokumen",
      start: "Mulai kerjakan",
      startDone: "Kasus mulai dikerjakan.",
      reassign: "Ganti PIC",
      reassignHint: "PIC baru menerima kasus ini tanpa mengubah status.",
      reassignSubmit: "Ganti PIC",
      reassignDone: "PIC kasus diganti.",
      resolve: "Selesaikan",
      resolveHint:
        "Tuliskan bagaimana selisih diselesaikan. Catatan tersimpan di kasus.",
      resolveLabel: "Catatan penyelesaian",
      resolveSubmit: "Selesaikan kasus",
      resolveDone: "Kasus diselesaikan.",
      writeOffUnavailable:
        "Penghapusan selisih memerlukan jurnal penyesuaian dari modul jurnal.",
      noPeople:
        "Daftar pengguna belum tersedia, jadi PIC tidak bisa diganti dari sini.",
      failed: "Tindakan kasus gagal disimpan. Coba lagi.",
      invalidTransition:
        "Status kasus berubah. Muat ulang kasus lalu coba lagi.",
    },
  },

  // ---- Labels shared by both screens ---------------------------------------
  // Kode galat dari API untuk uang masuk/keluar dan kas kecil.
  moneyError: {
    insufficient: "Saldo kas kecil tidak cukup. Kurangi nominalnya.",
    counterInvalid:
      "Akun lawan tidak boleh akun kas atau bank. Pakai transfer antar rekening.",
    keyReused:
      "Permintaan ini sudah dikirim dengan isi berbeda. Tutup dialog lalu isi ulang.",
    mappingMissing:
      "Peta akun belum lengkap. Hubungi admin akuntansi, lalu coba lagi.",
    periodClosed: "Periode buku untuk tanggal ini sudah ditutup.",
    selfApproval:
      "Tidak bisa menyetujui atau menolak kas keluar buatan sendiri.",
    notPending:
      "Kas keluar ini sudah diputuskan. Muat ulang daftar lalu cek statusnya.",
    entryNotFound: "Kas keluar tidak ditemukan. Muat ulang daftar.",
    chainOpen:
      "Persetujuan bertingkat belum selesai. Selesaikan semua tingkat di kotak persetujuan.",
    chainMissing:
      "Kas keluar ini tidak punya alur persetujuan, jadi tidak bisa disetujui langsung. Hubungi admin.",
  },

  common: {
    selectedAccount: "Rekening: {bank} {number}",
    noAccount: "Belum ada rekening bank",
    period: "{from} – {to}",
  },
};
