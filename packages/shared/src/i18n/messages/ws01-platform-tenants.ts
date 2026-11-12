// Panel Platform tenant screens (PRD v1.7 §3 F1 "Layar Platform", §3 F4 Super
// Admin, §4 Alur R; bead legend-tno). Namespace `platformTenants`. Kept in its
// own file so parallel WS-01 beads never edit the same lines in id.ts.

export const platformTenantsMessages = {
  nav: { tenants: "Tenant" },

  status: {
    active: "Aktif",
    suspended: "Nonaktif",
    archived: "Diarsipkan",
  },
  mode: {
    dedicated: "Terdedikasi",
    shared: "Berbagi",
  },
  outletStatus: {
    preopening: "Persiapan buka",
    active: "Aktif",
    closed: "Tutup",
  },
  modules: {
    pos: "Kasir (POS)",
    qr_order: "Pesan via QR",
    kds: "Layar dapur (KDS)",
    inventory: "Inventori",
    accounting: "Akuntansi",
    loyalty: "Loyalti",
    crm: "CRM",
    reservation: "Reservasi",
    delivery_channel: "Kanal ojek online",
    hris: "HRIS",
    payroll: "Penggajian",
    shareholder_dashboard: "Dasbor pemegang saham",
    ai_assistant: "Tanya AI",
    mcp: "MCP",
  },

  usage: {
    quota: {
      outlets: "Outlet",
      active_employees: "Karyawan aktif",
      devices: "Perangkat",
      ai_requests: "Permintaan AI bulan ini",
    },
    cap: {
      whatsapp: "Biaya WhatsApp",
      ai: "Biaya AI",
      email: "Biaya email",
    },
  },

  list: {
    title: "Daftar tenant",
    description: "Semua tenant di platform, terbaru lebih dulu.",
    subtitle: "Kelola tenant, paket, dan status dari satu tempat.",
    create: "Tenant baru",
    searchLabel: "Cari nama atau slug tenant",
    statusFilter: "Filter status",
    statusAll: "Semua status",
    colName: "Tenant",
    colPlan: "Paket",
    colStatus: "Status",
    colMode: "Penyebaran",
    open: "Buka tenant",
    emptyTitle: "Belum ada tenant",
    emptyHint: "Buat tenant pertama, lengkap dengan brand, outlet, dan admin.",
    pager: "Halaman daftar tenant",
    pageNumber: "Halaman {page}",
  },

  detail: {
    title: "Detail tenant",
    back: "Kembali ke daftar tenant",
    notFound: "Tenant tidak ditemukan",
    notFoundHint: "Tautannya mungkin salah atau tenant sudah dihapus.",
    supportAccess: "Akses dukungan",
    activate: "Aktifkan",
    deactivate: "Nonaktifkan",
    suspendedNote:
      "Tenant ini nonaktif: pengguna, domain, dan tugas latarnya ditolak sampai diaktifkan lagi.",
    archivedNote:
      "Tenant ini diarsipkan. Datanya disimpan dan tidak dapat dibuka kembali.",
    identity: "Identitas",
    status: "Status",
    slug: "Slug",
    mode: "Penyebaran",
    created: "Dibuat",
    package: "Paket",
    firstAdmin: "Admin pertama",
    firstAdminHidden:
      "Tampil di sini hanya saat tenant dibuat pada sesi ini. Selanjutnya kelola di Akses & peran milik tenant.",
    usageQuota: "Pemakaian kuota",
    usagePercent: "{percent}% terpakai, {month}",
    costCaps: "Plafon biaya bulanan",
    costCapsHint: "Peringatan di 80%, berhenti otomatis di 100% ({month}).",
    capState: {
      ok: "Aman",
      warning: "Mendekati plafon",
      stopped: "Berhenti",
    },
    modules: "Modul",
    modulesHint: "Modul yang aktif untuk tenant ini sesuai paketnya.",
    changePackage: "Ubah paket",
    moduleOn: "aktif",
    moduleOff: "tidak aktif",
    brandsOutlets: "Brand & outlet",
    brandsEmpty: "Belum ada brand atau outlet",
    brandsEmptyHint:
      "Tenant admin dapat menambahkannya di pengaturan organisasi.",
    bookedBy: "Dibukukan oleh {name}",
    legalEntities: "Badan hukum",
    legalHint: "NPWP hanya tampil empat digit terakhir.",
    legalEmpty: "Belum ada badan hukum",
    npwp: "NPWP",
    npwpMissing: "NPWP belum diisi",
    pkp: "PKP",
    nonPkp: "Non-PKP",
  },

  statusDialog: {
    titleDeactivate: "Nonaktifkan {name}?",
    titleActivate: "Aktifkan {name}?",
    bodyDeactivate:
      "Pengguna tenant tidak dapat masuk dan tugas latarnya berhenti. Data tetap aman dan tenant dapat diaktifkan lagi.",
    bodyActivate:
      "Pengguna tenant dapat masuk lagi dan tugas latarnya berjalan.",
    reason: "Alasan",
    reasonHint: "Dicatat di audit log. Minimal 10 karakter.",
    reasonError: "Tulis alasan minimal 10 karakter.",
    confirmDeactivate: "Ya, nonaktifkan",
    confirmActivate: "Ya, aktifkan",
    doneDeactivate: "Tenant dinonaktifkan.",
    doneActivate: "Tenant diaktifkan.",
    invalidTransition:
      "Status ini tidak dapat diubah dari kondisi sekarang. Muat ulang halaman.",
    offline: "Tidak ada koneksi. Periksa jaringan lalu coba lagi.",
    failed: "Status belum berubah. Coba lagi sebentar lagi.",
  },

  // Restore an archived tenant or a closed outlet within 30 days (legend-nb4iy).
  restore: {
    previousStatus: "Status sebelumnya",
    windowLimit: "Batas pemulihan",
    windowHint: "Maksimal 30 hari sejak perubahan status.",
    review: "Tinjau pemulihan",
    reason: "Alasan pemulihan",
    reasonPlaceholder: "Jelaskan alasan pemulihan",
    reasonHint: "Alasan wajib 10–500 karakter dan dicatat dalam log audit.",
    reasonError: "Isi alasan 10–500 karakter sebelum melanjutkan.",
    backToList: "Kembali ke daftar",
    back: "Kembali",
    loadingHint: "Mohon tunggu sebentar.",
    errorBanner: "Daftar belum dapat dimuat. Periksa koneksi dan coba lagi.",
    errorTitle: "Data belum tersedia",
    errorBody:
      "Status terbaru belum dapat diperiksa. Pemulihan belum dapat dilakukan.",
    expiredTitle: "Batas pemulihan terlewati.",
    expiredBanner:
      "Status ini final dan tidak dapat dipulihkan setelah 30 hari.",
    expiredBody:
      "Status juga dianggap final bila waktu perubahan tidak tersedia untuk membuktikan batas 30 hari. Hubungi tim platform untuk meninjau langkah berikutnya.",
    blockedTitle: "Pemulihan belum dapat dilakukan.",
    blockedNote:
      "Tinjau masalah yang dilaporkan, lalu coba lagi setelah masalah diselesaikan.",
    notAvailableTitle: "Pemulihan tidak tersedia.",
    notAvailableNote:
      "Data terbaru sudah dimuat ulang. Periksa status terkini sebelum mencoba lagi.",
    parentArchivedTitle: "Pulihkan tenant dulu.",
    parentArchivedNote:
      "Outlet dapat dipulihkan setelah tenant induk kembali aktif, selama masih dalam batas 30 hari.",
    offline: "Tidak ada koneksi. Periksa jaringan lalu coba lagi.",
    failed: "Pemulihan belum berhasil. Coba lagi sebentar lagi.",
    tenant: {
      kind: "Tenant",
      pill: "Diarsipkan",
      changedOn: "Diarsipkan pada",
      note: "Pemulihan mengembalikan tenant ke status sebelumnya. Pemeriksaan keamanan dilakukan sebelum pemulihan.",
      confirmTitle: "Pulihkan tenant?",
      confirmLead: "Periksa rincian sebelum mengembalikan status.",
      confirmNote:
        "Status kembali menjadi {status}. Pemulihan hanya dapat dilanjutkan bila pemeriksaan keamanan berhasil.",
      confirm: "Pulihkan tenant",
      loading: "Memuat tenant…",
      emptyTitle: "Tidak ada tenant terarsip",
      emptyBody: "Tenant yang diarsipkan akan muncul di sini untuk ditinjau.",
      blockedBody:
        "Pemeriksaan keamanan belum berhasil. Status tenant tidak berubah.",
      notAvailableBody:
        "Tenant ini sudah dipulihkan atau tidak lagi dapat dipulihkan. Status tenant tidak berubah oleh permintaan ini.",
      success: "Tenant berhasil dipulihkan.",
      successBody:
        "Status kembali ke {status} dan tindakan tercatat dalam log audit.",
    },
    outlet: {
      kind: "Outlet",
      pill: "Ditutup",
      changedOn: "Ditutup pada",
      note: "Pemulihan mengembalikan outlet ke status sebelumnya. Pemeriksaan keamanan dilakukan sebelum pemulihan.",
      confirmTitle: "Pulihkan outlet?",
      confirmLead: "Periksa rincian sebelum mengembalikan status.",
      confirmNote:
        "Status kembali menjadi {status}. Pemulihan hanya dapat dilanjutkan bila pemeriksaan keamanan berhasil.",
      confirm: "Pulihkan outlet",
      loading: "Memuat outlet…",
      emptyTitle: "Tidak ada outlet tertutup",
      emptyBody: "Outlet yang ditutup akan muncul di sini untuk ditinjau.",
      blockedBody:
        "Pemeriksaan keamanan belum berhasil. Status outlet tidak berubah.",
      notAvailableBody:
        "Outlet ini sudah dipulihkan atau tidak lagi dapat dipulihkan. Status outlet tidak berubah oleh permintaan ini.",
      parentArchivedBody:
        "Tenant induk masih diarsipkan, jadi outlet ini belum dapat dipulihkan.",
      success: "Outlet berhasil dipulihkan.",
      successBody:
        "Status kembali ke {status} dan tindakan tercatat dalam log audit.",
    },
  },

  wizard: {
    title: "Tenant baru",
    backToList: "Kembali ke daftar tenant",
    stepperLabel: "Langkah pembuatan tenant",
    stepDone: "selesai",
    stepCurrent: "langkah ini",
    steps: {
      tenant: "Tenant",
      brand: "Brand",
      outlet: "Outlet",
      legal: "Badan hukum",
      admin: "Admin pertama",
      review: "Tinjau",
    },
    hint: {
      tenant: "Perusahaan yang memakai platform, lengkap dengan paketnya.",
      brand: "Nama brand yang dilihat pelanggan, misalnya sebuah kafe.",
      outlet: "Lokasi fisik pertama. Outlet lain dapat ditambah tenant admin.",
      legal: "Badan hukum yang membukukan pendapatan outlet.",
      admin: "Orang yang mengelola tenant ini pertama kali.",
      review: "Periksa semua isian. Setelah dibuat, tenant langsung aktif.",
    },
    tenantName: "Nama tenant",
    slug: "Slug tenant",
    slugHint:
      "Huruf kecil, angka, dan tanda hubung, diawali dan diakhiri huruf atau angka.",
    plan: "Paket",
    planPlaceholder: "Pilih paket",
    startingQuota: "Kuota awal",
    startingQuotaValue:
      "{outlets} outlet · {employees} karyawan aktif · {devices} perangkat",
    mode: "Penyebaran",
    brandName: "Nama brand",
    brandSlug: "Slug brand",
    brandSlugHint:
      "Huruf kecil, angka, dan tanda hubung. Dipakai sebagai subdomain bawaan brand.",
    outletName: "Nama outlet",
    outletCode: "Kode outlet",
    outletCodeHint:
      "Huruf besar, angka, dan tanda hubung, maksimal 20 karakter.",
    outletAddress: "Alamat outlet",
    outletEntityNote:
      "Pendapatan outlet ini dibukukan ke badan hukum yang diisi pada langkah berikutnya.",
    legalName: "Nama badan hukum",
    npwp: "NPWP",
    npwpHint: "15 atau 16 digit. Titik dan tanda hubung boleh dipakai.",
    pkp: "Pengusaha Kena Pajak (PKP)",
    legalAddress: "Alamat badan hukum",
    adminName: "Nama admin",
    whatsapp: "Nomor WhatsApp",
    whatsappHint: "Contoh 0812 3456 7890. Undangan masuk dikirim ke nomor ini.",
    email: "Email",
    edit: "Ubah",
    continue: "Lanjut",
    submit: "Buat tenant",
    retry: "Coba lagi",
    created: "Tenant {name} dibuat.",
    failed: "Tenant belum dibuat. Periksa isian lalu coba lagi.",
    failedOffline: "Tidak ada koneksi. Periksa jaringan lalu coba lagi.",
    failedPartial:
      "Tenant {name} sudah dibuat, tetapi brand atau outlet belum lengkap. Coba lagi untuk melanjutkan.",
  },

  errors: {
    tenantName: "Isi nama tenant, maksimal 150 karakter.",
    slug: "Slug hanya huruf kecil, angka, dan tanda hubung.",
    slugTaken: "Slug ini sudah dipakai tenant lain. Pilih slug yang berbeda.",
    slugReserved: "Slug ini dipakai sistem. Pilih slug yang berbeda.",
    plan: "Pilih paket yang masih aktif.",
    brandName: "Isi nama brand, maksimal 150 karakter.",
    brandSlug: "Slug brand hanya huruf kecil, angka, dan tanda hubung.",
    outletCode: "Kode outlet: huruf besar, angka, dan tanda hubung.",
    outletName: "Isi nama outlet, maksimal 150 karakter.",
    outletAddress: "Isi alamat outlet, maksimal 500 karakter.",
    legalName: "Isi nama badan hukum, maksimal 150 karakter.",
    npwp: "NPWP harus 15 atau 16 digit. PKP wajib mengisi NPWP.",
    legalAddress: "Alamat maksimal 500 karakter.",
    adminName: "Isi nama admin, maksimal 150 karakter.",
    whatsapp: "Nomor WhatsApp tidak valid. Contoh 0812 3456 7890.",
    email: "Format email tidak valid.",
  },
} as const;
