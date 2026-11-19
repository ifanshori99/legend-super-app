// Panel Platform operations text (PRD v1.7 §3 F4 "Feature Flag & Paket",
// "Kuota & Plafon", Super Admin; beacon legend-y6s): packages and module flags,
// quotas, cost caps and gateways, platform health and the cross-tenant audit
// list. Kept in its own file so parallel WS-01 beads never edit the same lines
// in id.ts. Namespace: `platformOps`.

export const platformOpsMessages = {
  tenantPicker: "Pilih tenant",
  noTenantsTitle: "Belum ada tenant",
  noTenantsHint:
    "Buat tenant lebih dulu di daftar tenant, lalu atur paketnya di sini.",
  reset: "Batalkan perubahan",
  readOnly:
    "Anda hanya dapat melihat. Mengubah pengaturan ini membutuhkan izin kelola paket.",

  confirm: {
    changes: "Perubahan",
    reason: "Alasan perubahan",
    reasonHint: "Tercatat di audit log. Minimal {min} karakter.",
    reasonError: "Tulis alasan perubahan, minimal {min} karakter.",
    apply: "Terapkan perubahan",
  },

  errors: {
    generic: "Perubahan belum tersimpan. Coba lagi sebentar lagi.",
    invalid: "Isian belum benar. Periksa kembali lalu simpan ulang.",
    forbidden:
      "Anda tidak punya izin untuk perubahan ini. Hubungi Super Admin lain.",
    notFound: "Data tidak ditemukan. Muat ulang halaman lalu coba lagi.",
    offline: "Tidak ada koneksi. Periksa jaringan Anda lalu coba lagi.",
    moduleNotInPackage:
      "Ada modul yang tidak termasuk paket terpilih. Matikan modul itu atau pilih paket lain.",
    tenantNotActive:
      "Tenant ini sedang tidak aktif, sehingga perubahan ditolak.",
  },

  paket: {
    pageTitle: "Paket & modul",
    listTitle: "Paket",
    listDescription:
      "Paket menentukan modul yang boleh dinyalakan dan batas awal tenant baru.",
    emptyTitle: "Belum ada paket",
    emptyHint:
      "Paket dibuat sebagai data oleh tim platform; belum ada yang terdaftar.",
    columnName: "Paket",
    columnStatus: "Status",
    columnModules: "Modul",
    statusActive: "Aktif",
    statusRetired: "Dihentikan",
    moduleCount: "{count} dari {total}",
  },

  flags: {
    title: "Modul per tenant",
    description:
      "Nyalakan atau matikan modul untuk satu tenant. Modul hanya bisa dinyalakan bila termasuk paketnya.",
    plan: "Paket tenant",
    ten05:
      "Modul yang dimatikan tidak dapat dibuka lewat tampilan, API, Tanya AI, maupun MCP.",
    outsideOff: "Tidak termasuk {plan}, tidak bisa dinyalakan.",
    outsideOn: "Tidak termasuk {plan}. Matikan untuk bisa menyimpan.",
    blocked: "Simpan ditahan: {modules} tidak termasuk paket terpilih.",
    review: "Tinjau & simpan",
    saved: "Paket dan modul tersimpan.",
    confirmTitle: "Ubah paket dan modul {tenant}?",
    confirmDescription:
      "Perubahan berlaku seketika untuk semua pengguna tenant ini dan tercatat di audit log.",
    summaryPlan: "Paket:",
    summaryOn: "Dinyalakan:",
    summaryOff: "Dimatikan:",
  },

  modules: {
    pos: "Kasir (POS)",
    qr_order: "Pesan lewat QR",
    kds: "Layar dapur (KDS)",
    inventory: "Inventori",
    accounting: "Akuntansi",
    loyalty: "Loyalti",
    crm: "CRM",
    reservation: "Reservasi",
    delivery_channel: "Ojek online (GoFood, GrabFood, ShopeeFood)",
    hris: "HRIS",
    payroll: "Penggajian",
    shareholder_dashboard: "Dasbor pemegang saham",
    ai_assistant: "Tanya AI",
    mcp: "MCP",
  },

  limits: {
    maxOutlets: "Outlet",
    maxActiveEmployees: "Karyawan aktif",
    maxDevices: "Perangkat",
    aiRequestsPerMonth: "Kuota AI per bulan",
    whatsappCostCapIdr: "Plafon WhatsApp per bulan (Rp)",
    aiCostCapIdr: "Plafon AI per bulan (Rp)",
    emailCostCapIdr: "Plafon email per bulan (Rp)",
  },

  state: {
    ok: "Aman",
    warning: "Mendekati batas",
    stopped: "Batas tercapai",
    off: "Nonaktif",
  },

  quota: {
    pageTitle: "Kuota & plafon",
    title: "Pemakaian kuota",
    description:
      "Pemakaian saat ini terhadap batas paket. Periode AI: {month}.",
    ratio: "{used} dari {limit}",
    zeroLimit: "Batas 0: fitur ini tidak tersedia untuk tenant ini.",
  },

  quotaNames: {
    outlets: "Outlet",
    active_employees: "Karyawan aktif",
    devices: "Perangkat",
    ai_requests: "Permintaan AI bulan ini",
  },

  capNames: {
    whatsapp: "WhatsApp",
    ai: "AI",
    email: "Email",
  },

  caps: {
    title: "Plafon biaya bulanan",
    description:
      "Peringatan di 80% plafon, fitur berhenti otomatis di 100%. Operasional outlet tidak bergantung pada fitur berplafon.",
    ratio: "{spent} dari {cap}",
    offNote: "Plafon Rp 0: fitur ini dimatikan.",
  },

  limitsForm: {
    title: "Ubah batas tenant",
    description:
      "Batas menolak penambahan baru saat tercapai; data yang sudah ada tidak dihapus.",
    employeesHint: "Standar Legend minimal {min} karyawan aktif.",
    idrHint: "Rupiah penuh per bulan. Isi 0 untuk mematikan fitur.",
    review: "Tinjau & simpan",
    useDefaults: "Pakai batas bawaan {plan}",
    saved: "Batas tenant tersimpan.",
    confirmTitle: "Ubah batas {tenant}?",
    confirmDescription:
      "Batas baru berlaku seketika dan tercatat di audit log.",
  },

  limitErrors: {
    required: "Wajib diisi.",
    invalid: "Isi dengan angka bulat, tanpa huruf atau tanda minus.",
    range: "Angka di luar rentang yang diizinkan.",
  },

  limitWarnings: {
    belowUsage:
      "Lebih rendah dari pemakaian saat ini. Data lama tetap ada, penambahan baru ditolak.",
    belowDefault: "Di bawah standar Legend ({min} karyawan aktif).",
  },

  gateways: {
    title: "Gateway & integrasi tersedia",
    description:
      "Hanya yang dinyalakan di sini yang dapat dihubungkan tenant di halaman Integrasi.",
    review: "Tinjau & simpan",
    saved: "Gateway tersedia tersimpan.",
    confirmTitle: "Ubah gateway tersedia untuk {tenant}?",
    confirmDescription:
      "Gateway yang dicabut tidak bisa dihubungkan lagi oleh tenant. Tercatat di audit log.",
    summaryOn: "Disediakan:",
    summaryOff: "Dicabut:",
  },

  providers: {
    doit: "DOIT",
    duitku: "Duitku",
    whatsapp: "WhatsApp (KirimDev)",
    gofood: "GoFood",
    grabfood: "GrabFood",
    shopeefood: "ShopeeFood",
    email: "Email",
    lock_vendor: "Kunci pintar",
    edc: "Mesin EDC bank",
    wifi_vendor: "Wi-Fi tamu",
    llm: "Model bahasa (LLM)",
  },

  categories: {
    payment_gateway: "Gateway pembayaran",
    messaging: "Pesan",
    delivery_channel: "Kanal antar (ojek online)",
    email: "Email",
    edc: "Mesin EDC",
    lock: "Kunci pintar",
    wifi: "Wi-Fi tamu",
    llm: "Model AI",
  },

  health: {
    pageTitle: "Kesehatan platform",
    tenantsTitle: "Ringkasan tenant",
    tileActive: "Tenant aktif",
    tileSuspended: "Ditangguhkan",
    tileArchived: "Diarsipkan",
    tileAttention: "Perlu perhatian",
    ofTotal: "dari {total} tenant",
    attentionContext: "Kuota atau plafon di 80% ke atas",
    openQuota: "Buka kuota & plafon",
    attentionTitle: "Perlu perhatian",
    attentionDescription:
      "Kuota dan plafon biaya yang mendekati atau sudah mencapai batas, dari data pemakaian tiap tenant.",
    attentionEmptyTitle: "Tidak ada yang mendekati batas",
    attentionEmptyHint: "Semua kuota dan plafon tenant masih di bawah 80%.",
    columnTenant: "Tenant",
    columnItem: "Kuota atau plafon",
    columnUsed: "Terpakai",
    columnState: "Status",
    infraTitle: "Infrastruktur",
    infraEmptyTitle: "Metrik infrastruktur belum tersedia",
    infraEmptyHint:
      "Kontrak platform belum memuat status API, antrean, dan basis data. Tile akan muncul di sini setelah kontrak kesehatan didefinisikan.",
  },

  audit: {
    pageTitle: "Audit lintas tenant",
    filterTitle: "Filter",
    clear: "Hapus filter",
    filterTenant: "Tenant",
    allTenants: "Semua tenant",
    filterActor: "Pelaku",
    allActors: "Semua pelaku",
    filterAction: "Aksi",
    actionPlaceholder: "mis. tenant.package_changed",
    filterFrom: "Dari tanggal",
    filterTo: "Sampai tanggal",
    rangeError: "Tanggal akhir harus sama atau setelah tanggal awal.",
    title: "Riwayat audit",
    description:
      "Catatan tidak bisa diubah, nilai sensitif disamarkan, disimpan 2 tahun. Waktu dalam WIB.",
    unavailableTitle: "Audit lintas tenant belum tersedia",
    unavailableHint:
      "Server belum menyediakan daftar audit lintas tenant. Catatan tetap tersimpan; buka audit tiap tenant dari panel tenant sampai fitur ini aktif.",
    emptyTitle: "Belum ada catatan audit",
    emptyHint: "Aksi Super Admin dan sistem akan tercatat di sini.",
    emptyFilteredTitle: "Tidak ada catatan yang cocok",
    emptyFilteredHint:
      "Ubah atau hapus filter untuk melihat lebih banyak catatan.",
    columnWhen: "Waktu",
    columnTenant: "Tenant",
    columnActor: "Pelaku",
    columnAction: "Aksi",
    detail: "Detail",
    expand: "Buka detail {action}",
    collapse: "Tutup detail {action}",
    loadMore: "Muat lebih banyak",
    sensitive: "Akses sensitif",
    actors: {
      user: "Pengguna",
      ai: "Tanya AI",
      mcp_client: "Klien MCP",
      system: "Sistem",
      device: "Perangkat",
    },
    object: "Objek",
    reason: "Alasan",
    outlet: "Outlet",
    ipHash: "Hash IP",
    notRecorded: "Tidak dicatat",
    eventId: "ID catatan",
    changes: "Perubahan (disamarkan)",
    noChanges: "Tidak ada perubahan tercatat.",
    field: "Kolom",
    before: "Sebelum",
    after: "Sesudah",
    value: "Nilai",
    none: "Tidak ada",
  },
} as const;
