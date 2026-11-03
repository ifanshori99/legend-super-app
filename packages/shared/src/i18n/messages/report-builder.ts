// Report builder texts (PRD v1.7 §3 F36 "Report Builder"; bead legend-x9r2).
// Metric names and descriptions come from the metric registry, not from here.
// The error texts are keyed by the contract's report error codes
// (dashboard/errors.ts), so the UI never prints the API's own message.
export const reportBuilderMessages = {
  title: "Report Builder",
  description:
    "Susun laporan sendiri dari metrik baku: pilih metrik, pecah per dimensi, saring, lalu tentukan periode. Angkanya sama dengan dashboard dan laporan standar.",
  personalNotice:
    "Laporan ini memecah atau menyaring per orang, jadi berisi data pribadi.",
  dropped:
    "Pemecah atau filter {names} dilepas karena tidak tersedia untuk semua metrik yang dipilih.",
  offline: {
    title: "Tidak ada koneksi",
    hint: "Pratinjau, penyimpanan, dan jadwal membutuhkan internet. Sambungkan kembali lalu coba lagi.",
  },
  stepLabel: "Langkah {step}:",
  steps: {
    metric: {
      title: "Metrik",
      hint: "Pilih angka yang ingin dihitung. Hanya metrik yang boleh Anda lihat yang tampil.",
    },
    dimension: {
      title: "Pecah per",
      hint: "Satu baris untuk setiap kombinasi. Hanya dimensi yang dimiliki semua metrik terpilih yang bisa dipakai.",
    },
    filter: {
      title: "Filter",
      hint: "Batasi data ke nilai tertentu dan pilih outlet.",
    },
    period: {
      title: "Periode",
      hint: "Rentang tanggal bisnis outlet.",
    },
  },
  metric: {
    searchLabel: "Cari metrik",
    searchPlaceholder: "Cari nama metrik",
    selectedCount: "{count} dari {max} metrik dipilih",
    limitReached:
      "Maksimal {max} metrik. Lepas satu metrik untuk memilih yang lain.",
    noMatch: "Tidak ada metrik yang cocok dengan pencarian.",
    noneAvailableTitle: "Belum ada metrik yang bisa dipakai",
    noneAvailableHint:
      "Role Anda belum memiliki izin laporan untuk metrik mana pun. Minta pemilik akun menambahkan izin.",
    units: {
      idr: "Rupiah",
      count: "Jumlah",
      percent: "Persen",
      decimal: "Angka",
      seconds: "Durasi",
    },
  },
  dimension: {
    pickMetricFirst: "Pilih minimal satu metrik terlebih dahulu.",
    notShared: "Tidak dimiliki semua metrik yang dipilih",
    limitReached: "Maksimal {max} pemecah.",
    personal: "Data pribadi",
  },
  dimensions: {
    outlet: "Outlet",
    hour: "Jam",
    day_of_week: "Hari",
    channel: "Kanal",
    payment_method: "Metode bayar",
    menu_item: "Menu",
    menu_category: "Kategori menu",
    zone: "Zona",
    employee: "Karyawan",
    station: "Stasiun",
    customer_tier: "Tier pelanggan",
    supplier: "Pemasok",
    facility: "Fasilitas",
    promo: "Promo",
  },
  weekdays: {
    "1": "Senin",
    "2": "Selasa",
    "3": "Rabu",
    "4": "Kamis",
    "5": "Jumat",
    "6": "Sabtu",
    "7": "Minggu",
  },
  values: {
    channel: {
      qr: "QR meja",
      pos: "Kasir",
      captain: "Captain order",
      gofood: "GoFood",
      grabfood: "GrabFood",
      shopeefood: "ShopeeFood",
      reservation: "Reservasi",
    },
    payment_method: {
      cash: "Tunai",
      qris: "QRIS",
      card: "Kartu",
      transfer: "Transfer",
    },
  },
  duration: {
    seconds: "{seconds} dtk",
    minutes: "{minutes} mnt",
    minutesSeconds: "{minutes} mnt {seconds} dtk",
  },
  filter: {
    none: "Belum ada filter. Data mencakup semua nilai.",
    add: "Tambah filter",
    remove: "Hapus filter {name}",
    keyLabel: "Dimensi",
    valuesLabel: "Nilai",
    valuesHint: "Pisahkan dengan koma, maksimal 20 nilai.",
    valuesPlaceholder: "Contoh: qr, pos",
  },
  outlet: {
    title: "Outlet",
    all: "Semua outlet yang bisa Anda akses",
    loadFailed:
      "Daftar outlet gagal dimuat. Data tetap mencakup semua outlet Anda.",
  },
  period: {
    presetLabel: "Rentang",
    startDate: "Dari tanggal",
    endDate: "Sampai tanggal",
    presets: {
      today: "Hari ini",
      yesterday: "Kemarin",
      last_7_days: "7 hari terakhir",
      last_30_days: "30 hari terakhir",
      this_month: "Bulan ini",
      last_month: "Bulan lalu",
      custom: "Rentang sendiri",
    },
  },
  sort: {
    label: "Urutkan menurut",
    none: "Tanpa urutan",
    directionLabel: "Arah",
    desc: "Terbesar dulu",
    asc: "Terkecil dulu",
  },
  issues: {
    title: "Yang perlu diperbaiki",
    draft: {
      noMetric: "Pilih minimal satu metrik.",
      filterValues:
        "Isi nilai untuk setiap filter atau hapus filter yang kosong.",
      periodRange: "Tanggal mulai tidak boleh setelah tanggal akhir.",
    },
  },
  errors: {
    generic: "Terjadi kendala. Coba lagi sebentar lagi.",
    offline: "Tidak ada koneksi. Sambungkan kembali lalu coba lagi.",
    REPORT_NOT_FOUND: "Laporan tidak ditemukan di katalog.",
    REPORT_NOT_PERMITTED:
      "Role Anda tidak punya izin untuk laporan atau outlet ini. Minta pemilik akun menambahkan izin.",
    REPORT_FILTER_NOT_SUPPORTED:
      "Pemecah atau filter ini tidak tersedia untuk metrik yang dipilih. Lepas dimensi tersebut atau ganti metriknya.",
    REPORT_QUERY_INVALID:
      "Susunan laporan tidak valid, misalnya ada pemecah atau filter yang berulang. Periksa kembali pilihan Anda.",
    SAVED_REPORT_NOT_FOUND:
      "Laporan tersimpan tidak ditemukan. Muat ulang daftar lalu coba lagi.",
    REPORT_SCHEDULE_INVALID:
      "Jadwal tidak valid. Periksa frekuensi, hari, jam, dan penerima.",
    EXPORT_FORMAT_NOT_SUPPORTED: "Format ini belum tersedia untuk laporan ini.",
    EXPORT_PII_APPROVAL_REQUIRED:
      "Laporan dengan data pribadi hanya bisa dikirim setelah permintaan approval disetujui.",
    EXPORT_NOT_READY: "File belum selesai dibuat. Coba lagi sebentar lagi.",
    EXPORT_EXPIRED: "File sudah kedaluwarsa. Buat ulang.",
  },
  preview: {
    title: "Pratinjau",
    hint: "Hasil dihitung ulang setiap Anda mengubah pilihan.",
    loading: "Memuat pratinjau…",
    invalidTitle: "Pratinjau belum bisa ditampilkan",
    invalidHint:
      "Lengkapi pilihan di sebelah kiri agar angkanya bisa dihitung.",
    errorTitle: "Pratinjau gagal dimuat",
    emptyTitle: "Belum ada data",
    emptyHint:
      "Tidak ada data untuk pilihan ini. Coba perluas periode atau lepas filter.",
    estimate: "Estimasi",
    final: "Final",
    estimateHint:
      "Angka berjalan sampai periode dan buku ditutup; angka resmi diambil setelah penutupan.",
    generatedAt: "Dihitung {time}",
    rowCount: "{count} baris",
    announceReady: "Pratinjau diperbarui, {count} baris.",
    announceEmpty: "Pratinjau diperbarui, tidak ada data.",
    announceInvalid: "Pilihan belum lengkap untuk dihitung.",
    announceError: "Gagal memuat pratinjau.",
    announceOffline: "Pratinjau tertunda karena koneksi terputus.",
    chartMetric: "Metrik pada grafik",
    chartLabel: "Grafik batang {metric}",
    chartTruncated:
      "Grafik menampilkan {count} baris pertama; tabel memuat semuanya.",
  },
  save: {
    title: "Simpan laporan",
    hint: "Laporan tersimpan hanya terlihat oleh Anda.",
    name: "Nama laporan",
    namePlaceholder: "Contoh: Omzet per jam",
    nameRequired: "Nama laporan wajib diisi (maksimal 120 karakter).",
    description: "Catatan",
    create: "Simpan laporan",
    update: "Simpan perubahan",
    saveCopy: "Simpan sebagai baru",
    created: "Laporan {name} tersimpan.",
    updated: "Perubahan {name} tersimpan.",
    invalidHint: "Lengkapi pilihan agar laporan bisa disimpan.",
    offlineHint: "Menyimpan butuh koneksi internet.",
    scheduledPersonal:
      "Laporan ini punya jadwal email aktif, jadi tidak bisa diubah menjadi laporan per orang (data pribadi). Jeda jadwalnya dulu, atau simpan sebagai laporan baru.",
  },
  saved: {
    title: "Laporan tersimpan",
    hint: "Buka kembali di builder atau jadwalkan pengiriman email.",
    emptyTitle: "Belum ada laporan tersimpan",
    emptyHint:
      "Susun laporan lalu simpan, supaya bisa dibuka lagi dan dijadwalkan.",
    errorTitle: "Laporan tersimpan gagal dimuat",
    metricCount: "{count} metrik",
    open: "Buka",
    openBadge: "Sedang dibuka",
    schedule: "Jadwalkan",
    archive: "Arsipkan",
    restore: "Aktifkan",
    archivedBadge: "Diarsipkan",
    archived: "Laporan {name} diarsipkan.",
    restored: "Laporan {name} diaktifkan lagi.",
    updateFailed: "Laporan gagal diperbarui",
    schedulesLabel: "Jadwal email {name}",
  },
  schedule: {
    title: "Jadwalkan pengiriman email",
    description: "Laporan {name} dikirim ke penerima sesuai jadwal ini.",
    frequency: "Frekuensi",
    frequencies: { daily: "Harian", weekly: "Mingguan", monthly: "Bulanan" },
    dayOfWeek: "Hari",
    dayOfMonth: "Tanggal",
    dayOfMonthHint: "Tanggal 1 sampai 28 agar berlaku di setiap bulan.",
    timeOfDay: "Jam kirim",
    timeHint: "Mengikuti zona waktu outlet.",
    format: "Format file",
    formats: { csv: "CSV", xlsx: "Excel (XLSX)", pdf: "PDF" },
    recipients: "Penerima",
    recipientsHint:
      "Alamat email pengguna Anda yang berhak melihat laporan ini. Pisahkan dengan koma atau baris baru, maksimal 20.",
    recipientsPlaceholder: "nama@perusahaan.id",
    submit: "Buat jadwal",
    created: "Jadwal pengiriman {name} dibuat.",
    personalTitle: "Butuh approval",
    personalHint:
      "Laporan ini berisi data pribadi (dipecah atau disaring per orang), jadi tidak bisa dikirim otomatis lewat email. Minta ekspor dengan permintaan approval, atau simpan versi tanpa dimensi karyawan.",
    summary: "{when} · {format} · {count} penerima",
    summaryDaily: "Setiap hari pukul {time}",
    summaryWeekly: "Setiap {day} pukul {time}",
    summaryMonthly: "Setiap tanggal {day} pukul {time}",
    nextRun: "Pengiriman berikutnya {time}",
    active: "Aktif",
    pausedLabel: "Dijeda",
    toggleLabel: "Aktifkan jadwal",
    resumeBlocked:
      "Tidak bisa diaktifkan: laporan ini sekarang berisi data pribadi dan butuh approval.",
    paused: "Jadwal dijeda.",
    resumed: "Jadwal diaktifkan lagi.",
    updateFailed: "Jadwal gagal diperbarui",
    loadFailed:
      "Jadwal gagal dimuat, jadi status pengiriman belum tampil. Muat ulang halaman.",
    errors: {
      form: "Periksa kembali isian jadwal.",
      recipients:
        "Isi minimal satu alamat email yang valid, tanpa duplikat, maksimal 20.",
      timeOfDay: "Isi jam dengan format JJ:MM.",
      dayOfMonth: "Pilih tanggal 1 sampai 28.",
    },
  },
} as const;
