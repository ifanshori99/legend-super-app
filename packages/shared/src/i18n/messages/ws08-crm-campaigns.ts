// CRM campaigns and automations (bead legend-hbad; PRD v1.7 §3.21 "Kampanye",
// "Otomasi", LOY-04, AI-12) in their own catalog file so the parallel WS-08
// beads never edit the same lines. Spread in id.ts as
// `crmCampaigns: crmCampaignsMessages`; the screens read every key as
// "crmCampaigns.<path>".
//
// LOY-04: customers without active marketing consent never receive a
// promotional campaign. AI-12: the "Dibantu AI" draft is generated from a
// local template and is labelled as a draft — never as live model output.

export const crmCampaignsMessages = {
  title: "Kampanye",
  subtitle:
    "Kampanye ke segmen pelanggan lewat web push, email, atau WhatsApp template, dengan jadwal, uji A/B sederhana, dan pengukuran hasil.",
  tabs: {
    campaigns: "Kampanye",
    automations: "Otomasi",
  },
  channels: {
    web_push: "Web push",
    email: "Email",
    whatsapp_template: "WhatsApp template",
  },
  channelHints: {
    web_push: "Notifikasi browser ke pelanggan yang mengizinkan notifikasi.",
    email: "Email ke alamat yang tersimpan di profil pelanggan.",
    whatsapp_template:
      "WhatsApp hanya mengirim template yang sudah disetujui penyedia.",
  },
  status: {
    draft: "Draf",
    scheduled: "Terjadwal",
    running: "Berjalan",
    completed: "Selesai",
    cancelled: "Dibatalkan",
  },
  actions: {
    schedule: "Jadwalkan",
    start: "Mulai sekarang",
    complete: "Selesaikan",
    cancel: "Batalkan",
  },
  list: {
    title: "Daftar kampanye",
    description:
      "Status, kanal, jadwal, dan hasil tiap kampanye. Hasil dihitung dari pengiriman yang sudah tercatat.",
    searchLabel: "Cari kampanye",
    filterLabel: "Filter status kampanye",
    filterAll: "Semua status",
    add: "Buat kampanye",
    columns: {
      name: "Kampanye",
      status: "Status",
      channel: "Kanal",
      schedule: "Jadwal",
      ab: "Uji A/B",
      recipients: "Penerima",
      sent: "Terkirim",
      redeemed: "Redeem",
      revenue: "Pendapatan",
      actions: "Aksi",
    },
    notScheduled: "Belum dijadwalkan",
    noAb: "Tanpa A/B",
    abSplit: "B {percent}",
    open: "Lihat detail",
    emptyTitle: "Belum ada kampanye",
    emptyHint:
      "Buat kampanye pertama untuk segmen pelanggan yang sudah ada. Pelanggan tanpa persetujuan pemasaran otomatis dilewati.",
    emptyFilteredTitle: "Tidak ada kampanye dengan status ini",
    emptyFilteredHint:
      "Ubah filter status atau kembali ke semua kampanye untuk melihat yang lain.",
  },
  create: {
    title: "Buat kampanye",
    description:
      "Isi nama, pilih segmen dan kanal, lalu tentukan jadwal. Kampanye tanpa jadwal disimpan sebagai draf.",
    nameLabel: "Nama kampanye",
    nameHint: "Nama ini yang tampil di daftar dan laporan.",
    segmentLabel: "Segmen audiens",
    segmentPlaceholder: "Pilih segmen",
    segmentHint: "Audiens mengikuti definisi segmen yang tersimpan.",
    segmentLoading: "Memuat segmen…",
    segmentLoadFailed:
      "Segmen gagal dimuat. Coba lagi sebelum memilih audiens.",
    segmentEmpty: "Belum ada segmen. Buat segmen di layar CRM terlebih dahulu.",
    segmentOption: "{name} · {count} pelanggan",
    channelLabel: "Kanal",
    titleLabel: "Judul pesan",
    bodyLabel: "Isi pesan",
    bodyHint:
      "Tulis satu pesan yang jelas; hindari singkatan yang tidak perlu.",
    templateRefLabel: "Nama template WhatsApp",
    templateRefHint:
      "Nama template yang sudah disetujui penyedia WhatsApp, misalnya legend_weekend_25.",
    scheduledAtLabel: "Jadwal kirim",
    scheduledAtHint:
      "Kosongkan untuk menyimpan sebagai draf. Waktu mengikuti zona waktu outlet.",
    abToggle: "Uji A/B sederhana",
    abHint:
      "Varian B menerima sebagian audiens. Kedua varian harus terisi agar perbandingan bermakna.",
    variantBTitle: "Judul varian B",
    variantBBody: "Isi varian B",
    variantBTemplateRef: "Nama template WhatsApp varian B",
    splitLabel: "Porsi varian B (%)",
    splitHint:
      "Lebih dari 0 dan kurang dari 100. Sisa audiens menerima varian A.",
    splitValue: "Varian B {percent} · Varian A {rest}",
    submit: "Simpan kampanye",
    createdToast: "Kampanye {name} dibuat.",
    saveFailed: "Kampanye gagal disimpan. Periksa isian lalu coba lagi.",
    validation: {
      name: "Isi nama kampanye.",
      nameTooLong: "Nama kampanye maksimal 150 karakter.",
      segment: "Pilih segmen audiens.",
      title: "Isi judul pesan.",
      titleTooLong: "Judul pesan maksimal 150 karakter.",
      body: "Isi pesan tidak boleh kosong.",
      bodyTooLong: "Isi pesan maksimal 2000 karakter.",
      templateRef: "Isi nama template WhatsApp yang disetujui.",
      templateRefTooLong: "Nama template maksimal 100 karakter.",
      schedule: "Isi waktu kirim yang valid.",
      variantBTitle: "Isi judul varian B.",
      variantBBody: "Isi pesan varian B.",
      variantBTemplateRef: "Isi nama template WhatsApp varian B.",
      split: "Porsi varian B harus lebih dari 0% dan kurang dari 100%.",
    },
  },
  audience: {
    // The preview counts segment matches; consent is applied at send time
    // (LOY-04), so this is an upper bound, never the final recipient count.
    label: "Pelanggan cocok di segmen",
    value: "{count} pelanggan",
    liveHint:
      "Dihitung ulang dari definisi segmen saat ini, sebelum penyaringan persetujuan pemasaran. Penerima akhir bisa lebih sedikit.",
    storedHint: "Ukuran segmen tersimpan: {count} pelanggan.",
    loading: "Menghitung audiens…",
    failed: "Perkiraan audiens gagal dihitung. Segmen tetap bisa dipakai.",
  },
  consent: {
    title: "Persetujuan pemasaran",
    rule: "Pelanggan tanpa persetujuan pemasaran aktif tidak pernah menerima kampanye promosi.",
    skipped:
      "{count} penerima dilewati karena tidak ada persetujuan pemasaran aktif atau keanggotaan tidak aktif.",
    skippedNone:
      "Semua penerima punya persetujuan pemasaran aktif saat pemeriksaan.",
    reasonsTitle: "Alasan penerima dilewati:",
    reasonNoConsent: "tidak ada persetujuan pemasaran aktif",
    reasonInactive: "keanggotaan tidak aktif",
    channelNote:
      "Penyaringan berlaku untuk semua kanal, termasuk WhatsApp template.",
  },
  detail: {
    back: "Kembali ke daftar kampanye",
    contentTitle: "Isi pesan",
    variantA: "Varian A",
    variantB: "Varian B",
    split: "Porsi varian B: {percent}",
    templateRef: "Template WhatsApp",
    noTemplateRef: "Tidak memakai template",
    abNone: "Kampanye ini tidak memakai uji A/B.",
    audienceTitle: "Audiens",
    segment: "Segmen",
    segmentSize: "{count} pelanggan di segmen",
    segmentMissing: "Segmen tidak ditemukan di daftar segmen.",
    scheduledAt: "Jadwal kirim",
    createdAt: "Dibuat",
    startedAt: "Mulai",
    completedAt: "Selesai",
    cancelledAt: "Dibatalkan",
    resultsTitle: "Hasil kampanye",
    statsLabel: "Ringkasan angka kampanye",
    resultsNote:
      "Angka mengikuti pengiriman yang sudah tercatat. Kampanye yang belum berjalan belum punya hasil.",
    resultsPending: "Memuat hasil kampanye…",
    stats: {
      recipients: "Penerima",
      sent: "Terkirim",
      delivered: "Tersampaikan",
      failed: "Gagal",
      skippedNoConsent: "Dilewati (tanpa persetujuan)",
      opened: "Dibuka",
      redeemed: "Redeem",
      revenue: "Pendapatan",
      cost: "Biaya kanal",
    },
    noActions: "Tidak ada aksi tersedia untuk status ini.",
    notFoundTitle: "Kampanye tidak ditemukan",
    notFoundHint:
      "Kampanye mungkin sudah dihapus atau tautannya salah. Kembali ke daftar untuk memilih kampanye lain.",
  },
  sends: {
    title: "Status pengiriman",
    description:
      "Ringkasan status tiap pengiriman, termasuk penerima yang dilewati karena persetujuan.",
    columns: {
      status: "Status",
      count: "Jumlah",
      explanation: "Keterangan",
    },
    status: {
      queued: "Dalam antrean",
      sent: "Terkirim, belum dikonfirmasi",
      delivered: "Tersampaikan",
      failed: "Gagal",
      skipped_no_consent: "Dilewati (tanpa persetujuan)",
    },
    explanation: {
      queued: "Menunggu jadwal kirim atau antrean penyedia.",
      sent: "Diterima penyedia kanal, belum tentu sampai ke penerima.",
      delivered: "Sampai ke perangkat atau kotak masuk penerima.",
      failed:
        "Penyedia menolak pengiriman; alasan dicatat per penerima (misalnya nomor tidak aktif).",
      skipped_no_consent:
        "Tidak dikirim: pelanggan tanpa persetujuan pemasaran aktif atau keanggotaan tidak aktif.",
    },
    caption:
      "Dihitung dari ringkasan hasil kampanye. Total terkirim di atas = terkirim belum dikonfirmasi + tersampaikan + gagal.",
  },
  actionDialogs: {
    scheduleTitle: "Jadwalkan kampanye",
    scheduleHint:
      "Waktu kirim mengikuti zona waktu outlet. Kampanye berjalan pada waktu ini setelah dijadwalkan.",
    scheduleSubmit: "Simpan jadwal",
    scheduledToast: "Kampanye {name} dijadwalkan.",
    startedToast: "Kampanye {name} mulai berjalan.",
    completedToast: "Kampanye {name} selesai.",
    cancelledToast: "Kampanye {name} dibatalkan.",
    cancelTitle: "Batalkan kampanye?",
    cancelHint:
      "Kampanye yang dibatalkan tidak dapat dijalankan lagi. Pesan yang sudah terkirim tidak ditarik.",
    cancelConfirm: "Ya, batalkan",
    actionFailed: "Aksi gagal. Periksa koneksi lalu coba lagi.",
  },
  automations: {
    subtitle:
      "Pemicu otomatis untuk member baru, ulang tahun, pelanggan tidak aktif, dan poin yang segera kedaluwarsa.",
    previewTitle: "Pratinjau lokal",
    previewNotice:
      "Kontrak API otomasi kampanye belum ada. Kartu ini memakai data contoh lokal dan sakelar hanya tersimpan di peramban ini, tidak dikirim ke API.",
    consentNote:
      "Aturan yang sama berlaku: pelanggan tanpa persetujuan pemasaran aktif tidak menerima pesan otomasi promosi.",
    enabled: "Aktif",
    disabled: "Nonaktif",
    toggleLabel: "Aktifkan otomasi {name}",
    audienceLabel: "Perkiraan audiens",
    audienceValue: "{count} pelanggan",
    lastRunLabel: "Terakhir berjalan",
    lastRunNever: "Belum pernah",
    channelLabel: "Kanal",
    triggers: {
      welcome: "Selamat datang member baru",
      birthday: "Ulang tahun",
      win_back: "Win-back pelanggan tidak aktif",
      points_expiry_reminder: "Pengingat poin kedaluwarsa",
    },
    rules: {
      welcome:
        "Dikirim setelah member baru aktif dan memberi persetujuan pemasaran.",
      birthday:
        "Dikirim pada bulan ulang tahun member sesuai tanggal lahir di profil.",
      win_back:
        "Dikirim ke pelanggan yang tidak datang dalam 30 hari terakhir.",
      points_expiry_reminder:
        "Dikirim sebelum poin kedaluwarsa agar poin tidak hangus tanpa pemberitahuan.",
    },
  },
  ai: {
    button: "Dibantu AI",
    badge: "Draf",
    hint: "Draf ini dibuat dari templat lokal sesuai kanal dan nama segmen, bukan keluaran model langsung. Periksa dan sunting sebelum dijadwalkan.",
    web_pushTitle: "Ada penawaran untukmu",
    web_pushBody:
      "Halo! Kami menyiapkan penawaran untuk {segment}. Buka aplikasi Legend untuk melihat detail dan syaratnya.",
    emailTitle: "Penawaran khusus untuk {segment}",
    emailBody:
      "Halo,\n\nKami menyiapkan penawaran untuk {segment}. Tunjukkan pesan ini di kasir sebelum masa berlaku berakhir.\n\nSalam,\nTim Legend",
    whatsappTitle: "Penawaran untuk {segment}",
    whatsappBody:
      "Halo! Ada penawaran untuk {segment}. Tunjukkan pesan ini di kasir sebelum masa berlaku berakhir.",
  },
  errors: {
    offline: "Internet terputus. Sambungkan perangkat lalu coba lagi.",
    offlineHint:
      "Tanpa koneksi, daftar dan hasil kampanye tidak dapat dimuat. Sambungkan perangkat lalu coba lagi.",
  },
} as const;
