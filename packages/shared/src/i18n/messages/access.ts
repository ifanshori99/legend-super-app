// RBAC admin text (PRD v1.7 §3 F7 "RBAC, Organisasi & Matriks Approval",
// beacon legend-g6d): role templates, the custom role builder, scoped and
// time-bound role assignments with a re-authentication step, and the approval
// matrix editor. Kept in its own file so parallel WS-01 beads never edit the
// same lines in id.ts.
//
// The permission labels mirror the catalog codes nested one level per dot
// segment (`access.perm.pos.void.approve` ↔ `pos.void.approve`), because the
// translator resolves a key by walking nested objects, not by flat-key lookup.
// Both `access.perm.<code>` (screens shipped with legend-g6d) and
// `access.permission.<code>` (the contract name used by legend-svza) resolve to
// the same tree. A contract test asserts every catalog code has a label.

const accessBaseMessages = {
  title: "Akses & peran",
  subtitle:
    "Atur peran, penugasan, dan matriks approval. Setiap perubahan berlaku seketika dan tercatat di audit log.",

  tabs: {
    roles: "Peran",
    assignments: "Penugasan",
    matrix: "Matriks",
  },

  roles: {
    title: "Peran",
    description: "Peran template bawaan dan peran khusus milik tenant ini.",
    create: "Buat peran khusus",
    searchPlaceholder: "Cari peran…",
    filterAll: "Semua peran",
    filterTemplate: "Template",
    filterCustom: "Khusus",
    columnName: "Peran",
    columnType: "Jenis",
    columnScope: "Cakupan",
    columnPermissions: "Izin",
    columnMfa: "MFA",
    columnHolders: "Pemegang",
    kindTemplate: "Template",
    kindCustom: "Khusus",
    mfaRequired: "Wajib MFA",
    mfaOptional: "Tanpa MFA",
    open: "Buka peran",
    permissionCount: "{count} izin",
    holderCount: "{count} pengguna",
    emptyTitle: "Belum ada peran",
    emptyHint: "Peran template dibuat otomatis saat tenant disiapkan.",
    readOnlyTemplate:
      "Peran template tidak dapat diubah; buat peran khusus untuk menyesuaikan izin.",
  },

  // One-line purpose per role template. The name stays data in
  // ROLE_TEMPLATES.defaultName (tenants may rename it), so only the hint lives
  // in the catalog.
  templateHint: {
    super_admin:
      "Mengelola platform lintas tenant; data tenant hanya lewat support access.",
    owner: "Akses penuh ke seluruh tenant sesuai cakupan, tanpa alat platform.",
    shareholder: "Hanya melihat agregat dan data miliknya, tanpa data pribadi.",
    tenant_admin:
      "Mengatur organisasi, akses, dan pengaturan tenant tanpa kewenangan keuangan otomatis.",
    general_manager:
      "Menjalankan operasional dan approval lintas outlet, tanpa mengubah payroll.",
    outlet_manager:
      "Mengelola satu outlet: operasional, approval, dan laporan outlet.",
    supervisor:
      "Mengawasi shift di outlet dengan override PIN, tanpa laporan keuangan.",
    cashier: "Melayani transaksi POS pada shift yang ditugaskan.",
    waiter:
      "Melayani pesanan dan meja, tanpa akses pembayaran kecuali diizinkan.",
    barista_cook: "Memproses tiket dapur di stasiun yang ditugaskan.",
    facility_attendant: "Mengoperasikan bilik fasilitas dan checklist harian.",
    kitchen_lead:
      "Memimpin dapur: resep, stok, dan persiapan, tanpa akses pembayaran.",
    purchasing: "Mengelola supplier dan purchase order, tanpa akses payroll.",
    warehouse: "Mengelola stok masuk, transfer, dan opname di outlet.",
    finance: "Mengelola akuntansi, rekonsiliasi, dan laporan keuangan.",
    hr: "Mengelola data karyawan, absensi, dan payroll.",
    marketing:
      "Mengelola loyalitas, CRM, promo, dan konten; ekspor massal lewat approval.",
    employee: "Layanan mandiri: profil, absen, jadwal, dan slip gaji sendiri.",
  },

  role: {
    back: "Kembali ke daftar peran",
    templateNote:
      "Template bawaan: izinnya ditetapkan kontrak. Buat peran khusus bila perlu menyesuaikan.",
    customNote: "Peran khusus: izin, cakupan, dan MFA dapat diubah kapan saja.",
    accessLimit: "Batas akses menurut PRD",
    identity: "Identitas peran",
    name: "Nama peran",
    nameHint: "Dipakai di seluruh panel dan audit log.",
    scopeTitle: "Cakupan yang diizinkan",
    scopeHint:
      "Menentukan jenis cakupan yang bisa dipilih saat peran diberikan kepada pengguna.",
    mfaTitle: "Wajib MFA",
    mfaForced:
      "Wajib karena izin yang dipilih menyentuh keuangan, payroll, atau data pribadi (AUTH-05).",
    mfaHint: "Faktor kedua selalu diminta saat peran ini membuka back office.",
    permissionsTitle: "Katalog izin",
    permissionsHint:
      "Pilih hanya yang dibutuhkan. Izin platform tidak tersedia untuk peran tenant.",
    permissionsReadOnlyHint: "Izin yang diberikan template ini.",
    permissionsLimitedHint:
      "Anda hanya dapat menambahkan izin yang Anda miliki sendiri. Izin lain tidak dapat dipilih.",
    permissionsChecking: "Memeriksa izin Anda…",
    permissionsCheckError:
      "Izin Anda tidak dapat diperiksa, jadi izin baru belum bisa dipilih.",
    blockedNotHeld: "Anda tidak memiliki izin ini.",
    blockedOwnerOnly: "Khusus template Owner.",
    blockedPlatform: "Izin platform, bukan untuk peran tenant.",
    reauthHint:
      "Menambahkan izin yang tidak Anda pegang sendiri memerlukan verifikasi ulang. Masukkan kode 6 digit dari aplikasi autentikator. Verifikasi ini berlaku {minutes} menit.",
    reauthDone: "Verifikasi berhasil. Simpan peran lagi.",
    reauthNoFactorHint:
      "Aktifkan TOTP di pengaturan keamanan dulu sebelum menambahkan izin.",
    selfElevation:
      "Anda hanya dapat menambahkan izin yang Anda miliki sendiri. Hapus izin yang tidak Anda miliki lalu simpan lagi.",
    mfaDropSelf:
      "Anda tidak dapat mematikan syarat MFA pada peran yang Anda pegang sendiri. Minta pengelola lain yang tidak memegang peran ini untuk mengubahnya.",
    mfaHeldSelf:
      "Tidak dapat dimatikan: Anda memegang peran ini sendiri. Minta pengelola lain yang tidak memegang peran ini untuk mengubahnya.",
    searchPermissions: "Cari izin…",
    selectedCount: "{count} izin dipilih",
    selectModule: "Pilih semua di {module}",
    clearModule: "Kosongkan {module}",
    save: "Simpan peran",
    create: "Buat peran",
    saved: "Peran disimpan.",
    created: "Peran khusus dibuat.",
    noPermissions: "Pilih minimal satu izin.",
    noName: "Nama peran wajib diisi.",
    noScope: "Pilih minimal satu jenis cakupan.",
    notFound: "Peran tidak ditemukan.",
    noMatches: "Tidak ada izin yang cocok dengan pencarian.",
    templateReadOnly: "Peran template tidak dapat diubah.",
    createTitle: "Peran khusus baru",
    createSubtitle:
      "Mulai dari katalog izin. Peran hanya berlaku di tenant ini dan dapat diubah kapan saja.",
  },

  assignments: {
    title: "Penugasan peran",
    description:
      "Peran yang diberikan kepada pengguna, beserta cakupan dan masa berlakunya.",
    grant: "Beri peran",
    search: "Cari pengguna…",
    filterRole: "Semua peran",
    filterStatus: "Semua status",
    filterScope: "Semua cakupan",
    statusActive: "Aktif",
    statusScheduled: "Terjadwal",
    statusExpired: "Kedaluwarsa",
    statusEnded: "Diakhiri",
    columnUser: "Pengguna",
    columnRole: "Peran",
    columnScope: "Cakupan",
    columnValidity: "Masa berlaku",
    columnStatus: "Status",
    columnActions: "Aksi",
    emptyTitle: "Belum ada penugasan",
    emptyHint: "Beri peran ke pengguna untuk mulai mengatur akses.",
    noEnd: "Tanpa batas",
    end: "Akhiri",
    endTitle: "Akhiri penugasan?",
    endDescription:
      "Akses dari peran ini berakhir sekarang. Tindakan tercatat di audit log.",
    endBlockedOwnerOnly:
      "Hanya Owner aktif yang dapat mengakhiri penugasan Owner lain.",
    endBlockedLastOwner:
      "Ini Owner aktif terakhir. Tenant harus memiliki minimal satu Owner aktif tanpa batas waktu; beri peran Owner ke orang lain dulu.",
    endLocked: "Terkunci",
    endGuardLoading: "Memeriksa daftar Owner…",
    endGuardError:
      "Daftar Owner tidak dapat dimuat, jadi penugasan Owner belum bisa diakhiri.",
    endReason: "Alasan",
    endReasonHint: "Minimal 3 karakter, misalnya “Pindah outlet”.",
    endReasonError: "Tulis alasan minimal 3 karakter.",
    ended: "Penugasan diakhiri.",
    unknownUser: "Pengguna {id}",
    assignedBy: "Diberikan oleh",
    directoryMissing: "Direktori pengguna belum tersedia",
    directoryMissingHint:
      "Endpoint direktori pengguna WS-01 belum ada, jadi nama pengguna tidak dapat dimuat. Hubungkan API saat integrasi (legend-91i).",
    scopeTenant: "Seluruh tenant",
    scopeBrand: "Brand",
    scopeOutlet: "Outlet",
    scopeStation: "Stasiun",
    scopeUnknown: "{type} tidak dikenal",
  },

  grant: {
    title: "Beri peran",
    description:
      "Pilih pengguna dan peran, tentukan cakupan serta masa berlaku, lalu verifikasi ulang.",
    stepSubject: "Pengguna & peran",
    stepScope: "Cakupan & masa berlaku",
    stepReauth: "Verifikasi ulang",
    user: "Pengguna",
    userPlaceholder: "Pilih pengguna…",
    searchUser: "Cari nama pengguna…",
    noPeople: "Tidak ada pengguna yang cocok.",
    usersUnavailable: "Pilih pengguna tidak tersedia",
    usersUnavailableHint:
      "Direktori pengguna WS-01 belum ada. Pemberian peran tetap dibuka di API, tetapi layar ini menunggu endpoint direktori (follow-up bead).",
    role: "Peran",
    rolePlaceholder: "Pilih peran…",
    roleScopeNote: "Cakupan yang tersedia mengikuti peran yang dipilih.",
    scope: "Cakupan",
    scopeTarget: "Objek cakupan",
    scopeValue: "Pilih {type}",
    scopeNone: "Belum ada {type}",
    validFrom: "Berlaku mulai",
    validUntil: "Berlaku sampai",
    noEnd: "Tanpa batas waktu",
    validityHint:
      "Kosongkan “berlaku mulai” agar berlaku sekarang. Kosongkan “berlaku sampai” untuk penugasan permanen.",
    reauthTitle: "Verifikasi ulang",
    reauthHint:
      "Pemberian peran memerlukan faktor kedua. Masukkan kode 6 digit dari aplikasi autentikator. Verifikasi ini berlaku {minutes} menit.",
    reauthCode: "Kode autentikator",
    reauthCodeError: "Masukkan kode 6 digit.",
    reauthSend: "Verifikasi kode",
    reauthDone: "Verifikasi berhasil. Lanjutkan untuk memberi peran.",
    reauthNoFactor: "Belum ada faktor kedua yang aktif",
    reauthNoFactorHint:
      "Aktifkan TOTP di pengaturan keamanan dulu sebelum memberi peran.",
    reauthUnavailable:
      "Verifikasi faktor kedua belum dapat dimuat. Coba lagi sebentar lagi.",
    next: "Lanjut",
    back: "Kembali",
    submit: "Beri peran",
    granted: "Peran diberikan.",
    self: "Anda tidak dapat memberi peran kepada diri sendiri.",
    pickUser: "Pilih pengguna dan peran dulu.",
    pickScope: "Pilih cakupan dan objeknya.",
    invalidValidity: "“Berlaku sampai” harus setelah “berlaku mulai”.",
    reauthRequired: "Selesaikan verifikasi ulang dulu.",
  },

  matrix: {
    title: "Matriks approval",
    description:
      "Siapa menyetujui apa dan pada ambang berapa. Penyetuju selalu berbeda dari pemohon (AUTH-06).",
    distinctActor: "Penyetuju selalu berbeda dari pemohon (AUTH-06).",
    action: "Tindakan",
    threshold: "Ambang",
    anyAmount: "Semua nominal",
    approver: "Penyetuju",
    level: "Tingkat {level}",
    addLevel: "Tambah tingkat",
    removeLevel: "Hapus tingkat terakhir",
    addTier: "Tambah ambang",
    removeTier: "Hapus ambang",
    configure: "Atur",
    save: "Simpan matriks",
    saved: "Matriks approval disimpan.",
    coverage: "{covered} dari {total} tindakan memiliki kebijakan.",
    uncoveredTitle: "Tindakan tanpa kebijakan",
    uncoveredHint:
      "Tanpa kebijakan, tindakan diblokir (fail closed). Tambahkan minimal satu ambang.",
    noPolicies: "Belum ada kebijakan di matriks ini.",
    noPolicyShort: "Belum diatur",
    policyCount: "{count} ambang",
    approverPlaceholder: "Pilih peran penyetuju…",
    issueMissingLevel: "Tingkat approval harus berurutan mulai 1.",
    issueNoApprover: "Setiap tingkat butuh satu peran penyetuju.",
    issueThreshold: "Ambang harus 0 atau lebih.",
    issueEmpty: "Matriks butuh minimal satu kebijakan.",
    levelMax: "Maksimal {max} tingkat.",
    thresholdHint: "Kosongkan untuk semua nominal.",
    groupTitle: "Kebijakan aktif",
    addPolicy: "Tambah tindakan",
    addPolicyTitle: "Pilih tindakan",
    allCovered: "Semua tindakan sudah memiliki kebijakan.",
    notConfiguredNote:
      "Tindakan tanpa kebijakan tidak dapat disetujui siapa pun sampai ambangnya diatur.",
  },

  action: {
    void: "Void transaksi",
    discount: "Diskon",
    refund: "Refund",
    expense: "Pengeluaran",
    purchase_order: "Purchase order",
    stock_adjustment: "Penyesuaian stok",
    price_change: "Perubahan harga",
    payroll: "Payroll",
    dividend_distribution: "Distribusi dividen",
    ai_action: "Aksi yang diusulkan AI",
    mcp_action: "Aksi agen MCP",
    cash_drawer_open: "Buka laci tanpa transaksi",
    price_correction: "Koreksi harga di POS",
    cash_shift_close: "Tutup shift kasir",
    edc_standalone: "Pembayaran EDC standalone",
    apology_voucher: "Voucher permintaan maaf",
    unallocated_funds: "Dana belum teralokasi",
    reconciliation_case: "Penutupan kasus rekonsiliasi",
    purchase_request: "Purchase request",
    supplier_payment: "Pembayaran supplier",
    manual_journal: "Jurnal manual",
    period_reopen: "Buka kembali periode",
    payroll_cancel: "Pembatalan payroll",
    shareholder_version: "Versi daftar pemegang saham",
    personal_data_export: "Ekspor data pribadi",
    attendance_correction: "Koreksi absensi",
    shift_swap: "Tukar shift",
    leave: "Cuti & izin",
    overtime: "Lembur",
    employee_loan: "Kasbon",
    reimbursement: "Reimbursement",
  },

  module: {
    platform: "Panel platform",
    org: "Organisasi & pengaturan",
    device: "Perangkat",
    access: "Akses & peran",
    audit: "Audit",
    approval: "Approval",
    menu: "Menu",
    floor: "Denah & meja",
    order: "Pesanan",
    service_request: "Panggilan pelayanan",
    pos: "POS & kasir",
    shift: "Shift kasir",
    wifi: "Wi-Fi",
    kds: "Dapur",
    payment: "Pembayaran",
    inventory: "Inventori",
    recipe: "Resep",
    purchasing: "Purchasing",
    accounting: "Akuntansi",
    profit_share: "Bagi hasil",
    loyalty: "Loyalitas",
    crm: "CRM",
    promo: "Promo",
    campaign: "Kampanye",
    review: "Ulasan",
    reservation: "Reservasi",
    delivery: "Delivery",
    website: "Website",
    facility: "Fasilitas",
    wfc: "WFC",
    hr: "SDM",
    payroll: "Payroll",
    self: "Karyawan (mandiri)",
    dashboard: "Dasbor",
    report: "Laporan",
    export: "Ekspor data",
    ai: "Tanya AI",
    mcp: "MCP",
    ops: "Operasional harian",
  },

  perm: {
    platform: {
      tenant: { manage: "Kelola tenant platform" },
      package: { manage: "Kelola paket langganan" },
      integration: { manage: "Kelola integrasi platform" },
      health: { view: "Lihat kesehatan platform" },
      audit: { view: "Lihat audit lintas tenant" },
      support_access: { request: "Minta akses dukungan ke tenant" },
      config_template: { manage: "Kelola template konfigurasi tenant" },
      event_gap: { manage: "Periksa dan lewati celah urutan event" },
    },
    org: {
      structure: { manage: "Kelola struktur organisasi" },
      settings: { manage: "Ubah pengaturan tenant" },
      integration: { manage: "Kelola integrasi" },
      theme: { manage: "Ubah tema & tampilan" },
      config: {
        export: "Ekspor konfigurasi tenant",
        import: "Impor konfigurasi tenant",
      },
      tax_config: { manage: "Kelola konfigurasi pajak" },
      notification_policy: {
        manage: "Kelola kebijakan & template notifikasi",
      },

      support_access: { approve: "Setujui akses dukungan baca-tulis" },
    },
    device: {
      registry: {
        manage: "Kelola perangkat outlet",
        revoke: "Cabut perangkat outlet",
      },
    },
    access: {
      role: {
        view: "Lihat peran & izin",
        manage: "Buat & ubah peran khusus",
        assign: "Berikan peran ke pengguna",
      },
      approval_policy: { manage: "Kelola matriks approval" },
    },
    audit: { log: { view: "Lihat audit log" } },
    approval: {
      inbox: { view: "Lihat kotak approval" },
      request: { decide: "Putuskan permintaan approval" },
    },
    menu: {
      item: { view: "Lihat menu", manage: "Kelola item menu" },
      price: { view: "Lihat harga jual", manage: "Ubah harga jual" },
      availability: { toggle: "Tandai menu habis atau tersedia" },
    },
    floor: {
      table: {
        view: "Lihat denah & meja",
        manage: "Edit denah & meja",
        operate: "Operasikan meja (gabung, pindah, tutup)",
      },
      session: { open_bill: "Setujui perubahan sesi jadi open bill" },
      open_bill_policy: { manage: "Atur kebijakan open bill outlet" },
    },
    order: {
      view: "Lihat pesanan",
      create: "Buat pesanan",
      recovery: { handle: "Tangani pemulihan pesanan" },
      apology_voucher: { issue: "Terbitkan voucher permintaan maaf" },
    },
    service_request: {
      zone: { manage: "Atur penerima panggilan per zona" },
    },
    pos: {
      sale: { create: "Buat penjualan di POS" },
      payment: { accept: "Terima pembayaran" },
      discount: { apply: "Terapkan diskon", approve: "Setujui diskon" },
      void: { request: "Ajukan void", approve: "Setujui void" },
      refund: { request: "Ajukan refund", approve: "Setujui refund" },
      cash_drawer: { approve: "Setujui buka laci kas" },
      price_correction: { approve: "Setujui koreksi harga" },
      edc_standalone: { approve: "Setujui pembayaran EDC standalone" },
      day: { close: "Tutup hari usaha" },
      receipt: { writeoff: "Hapus buku nomor struk yang hilang" },
    },
    shift: {
      cash: {
        operate: "Buka & tutup shift kasir",
        approve_close: "Setujui tutup shift kasir",
        view_all: "Lihat semua shift kasir",
      },
    },
    wifi: { voucher: { issue: "Terbitkan voucher Wi-Fi" } },
    kds: {
      ticket: { process: "Proses tiket dapur" },
      expo: { operate: "Operasikan expo" },
      station: { manage: "Kelola stasiun dapur" },
      remake_comp: { record: "Catat remake & kompensasi" },
    },
    payment: {
      transaction: { view: "Lihat transaksi pembayaran" },
      reconcile: "Rekonsiliasi pembayaran",
      edc: { manage: "Kelola mesin EDC" },
      recurring: { manage: "Kelola tagihan berulang" },
    },
    inventory: {
      stock: {
        view: "Lihat stok",
        receive: "Terima stok masuk",
        transfer: "Transfer stok antar outlet",
      },
      item: { manage: "Kelola master data bahan dan satuan" },
      opname: { count: "Hitung stok opname" },
      waste: { record: "Catat waste" },
      production: { record: "Catat produksi batch" },
      adjustment: { approve: "Setujui penyesuaian stok" },
      cost: { view: "Lihat biaya stok" },
    },
    recipe: { manage: "Kelola resep", cost: { view: "Lihat biaya resep" } },
    purchasing: {
      supplier: { manage: "Kelola supplier" },
      request: { create: "Ajukan purchase request" },
      order: {
        create: "Buat purchase order",
        approve: "Setujui purchase order",
      },
      invoice: { match: "Cocokkan invoice supplier" },
      return: { create: "Buat retur pembelian" },
      petty: { record: "Catat pembelian kas kecil" },
      petty_policy: { manage: "Atur kebijakan pembelian kas kecil" },
    },
    accounting: {
      journal: { view: "Lihat jurnal", post: "Posting jurnal" },
      reconcile: "Rekonsiliasi akuntansi",
      period: { close: "Tutup periode" },
      period_reopen: { approve: "Setujui buka kembali periode" },
      supplier_payment: { process: "Proses pembayaran supplier" },
      tax_report: { manage: "Kelola laporan pajak" },
      asset: { manage: "Kelola aset tetap" },
      budget: { manage: "Kelola anggaran" },
      expense: {
        request: "Ajukan pengeluaran",
        approve: "Setujui pengeluaran",
      },
      cash_deposit: { record: "Catat setoran kas" },
      cash_bank: {
        record: "Catat kas masuk, kas keluar, dan transfer bank",
        approve: "Setujui atau tolak kas keluar di atas batas",
        limit: { manage: "Atur batas persetujuan kas keluar" },
      },
      petty_cash: { manage: "Kelola dana kas kecil outlet" },
    },
    profit_share: {
      own: { view: "Lihat bagi hasil milik sendiri" },
      registry: { manage: "Kelola daftar pemegang saham" },
      share_allocation: { change: "Ubah porsi saham pemegang saham" },
      distribution: { approve: "Setujui distribusi bagi hasil" },
    },
    loyalty: { program: { manage: "Kelola program loyalitas" } },
    crm: {
      customer: {
        view: "Lihat profil pelanggan",
        pii: { read: "Lihat data pribadi pelanggan" },
        identity: { unlink: "Putuskan tautan WhatsApp pelanggan" },
      },
      loyalty: {
        manage: "Kelola program loyalitas CRM",
        review: "Tinjau penyesuaian poin",
        fulfil: "Penuhi penukaran reward",
      },
      feedback: { manage: "Kelola umpan balik pelanggan" },
      consent: { record: "Catat persetujuan pelanggan" },
      segment: { manage: "Kelola segmen pelanggan" },
    },
    promo: { manage: "Kelola promo" },
    campaign: { manage: "Kelola kampanye" },
    review: { respond: "Balas ulasan" },
    reservation: { view: "Lihat reservasi", manage: "Kelola reservasi" },
    delivery: {
      channel: { manage: "Kelola kanal delivery" },
      order: { handle: "Tangani pesanan delivery" },
    },
    website: { content: { manage: "Kelola konten website" } },
    facility: {
      booth: { operate: "Operasikan bilik fasilitas" },
      access: { assist: "Bantu akses fasilitas" },
      emergency: {
        respond: "Menanggapi alarm darurat",
        resolve: "Menutup insiden alarm darurat",
      },
      config: { manage: "Kelola konfigurasi fasilitas" },
    },
    wfc: { policy: { manage: "Kelola kebijakan WFC" } },
    hr: {
      employee: { view: "Lihat data karyawan", manage: "Kelola data karyawan" },
      attendance: { manage: "Kelola absensi" },
      attendance_correction: { approve: "Setujui koreksi absensi" },
      schedule: { manage: "Kelola jadwal shift" },
      shift_swap: { approve: "Setujui tukar shift" },
      leave: { approve: "Setujui cuti & izin" },
      overtime: { approve: "Setujui lembur" },
      reimbursement: { approve: "Setujui reimbursement" },
      loan: { approve: "Setujui kasbon" },
      sop: { manage: "Kelola SOP" },
      announcement: { manage: "Kelola pengumuman internal" },
      training: { manage: "Kelola pelatihan" },
      kpi: { manage: "Kelola KPI" },
    },
    payroll: {
      view: "Lihat payroll",
      run: "Jalankan payroll",
      approve: "Setujui payroll",
      lock: "Kunci payroll",
      cancel: { approve: "Setujui pembatalan payroll" },
      payout: { configure: "Atur pembayaran gaji per PT" },
      disburse: {
        request: "Ajukan pembayaran gaji",
        approve: "Setujui pembayaran gaji",
      },
    },
    self: {
      profile: { view: "Lihat profil sendiri" },
      attendance: { clock: "Absen mandiri" },
      schedule: { view: "Lihat jadwal sendiri" },
      leave: { request: "Ajukan cuti atau izin" },
      payslip: { view: "Lihat slip gaji sendiri" },
      reimbursement: { request: "Ajukan reimbursement" },
      loan: { request: "Ajukan kasbon" },
      shift_swap: { request: "Ajukan tukar shift" },
      sop: { read: "Baca SOP" },
    },
    dashboard: {
      owner: { view: "Buka dasbor owner" },
      shareholder: { view: "Buka dasbor pemegang saham" },
      management: { view: "Buka dasbor manajemen" },
    },
    report: {
      operational: { view: "Lihat laporan operasional" },
      sales: { view: "Lihat laporan penjualan" },
      financial: { view: "Lihat laporan keuangan" },
      aggregate: { view: "Lihat laporan agregat" },
    },
    export: {
      data: { run: "Ekspor data" },
      personal_data: { request: "Minta ekspor data pribadi" },
    },
    ai: {
      ask: "Tanya AI",
      action: { propose: "Usulkan aksi AI" },
      governance: { manage: "Kelola tata kelola AI" },
    },
    mcp: { client: { manage: "Kelola klien MCP" } },
    ops: {
      checklist: {
        complete: "Selesaikan checklist",
        manage: "Kelola template checklist",
      },
      food_safety: { log: "Catat keamanan pangan" },
      prep: { manage: "Kelola persiapan" },
      equipment: { maintain: "Perawatan peralatan" },
      handover: { record: "Catat serah terima shift" },
      outbox: { replay: "Putar ulang event outbox" },
    },
  },

  errors: {
    reauthRequired:
      "Verifikasi ulang diperlukan. Masukkan kode faktor kedua lalu coba lagi.",
    selfElevation: "Anda tidak dapat menaikkan hak Anda sendiri.",
    roleNotAssignable: "Peran ini tidak dapat diberikan.",
    roleScopeNotAllowed: "Cakupan ini tidak diizinkan untuk peran tersebut.",
    permissionNotInCatalog: "Ada izin yang tidak dikenal di katalog.",
    approverIsRequester: "Penyetuju tidak boleh sama dengan pemohon.",
    forbid: "Anda tidak punya izin untuk tindakan ini.",
    notFound: "Data tidak ditemukan. Muat ulang halaman.",
    conflict:
      "Perubahan bentrok dengan data terbaru. Muat ulang lalu coba lagi.",
    invalid: "Periksa kembali isian yang ditandai.",
    offline: "Tidak ada koneksi. Periksa jaringan lalu coba lagi.",
    generic: "Terjadi kesalahan. Coba lagi.",
  },

  // One message per ACCESS_ERROR_CODES entry, keyed by the code the API sends.
  error: {
    PERMISSION_DENIED: "Anda tidak punya izin untuk tindakan ini.",
    MFA_REQUIRED: "Halaman ini memerlukan verifikasi faktor kedua.",
    REAUTH_REQUIRED:
      "Verifikasi ulang diperlukan. Masukkan kode faktor kedua lalu coba lagi.",
    SELF_ELEVATION_FORBIDDEN:
      "Anda tidak dapat memberi peran kepada diri sendiri.",
    ROLE_SCOPE_NOT_ALLOWED: "Cakupan ini tidak diizinkan untuk peran tersebut.",
    ROLE_NOT_ASSIGNABLE: "Peran ini tidak dapat diberikan di tingkat tenant.",
    PERMISSION_NOT_IN_CATALOG:
      "Izin tidak dikenal atau tidak boleh dipakai di peran tenant.",
    PERMISSION_OWNER_ONLY:
      "Izin ini hanya milik peran Owner dan tidak dapat dimasukkan ke peran kustom.",
    APPROVER_IS_REQUESTER: "Penyetuju tidak boleh sama dengan pemohon.",
    APPROVER_ALREADY_DECIDED:
      "Anda sudah memberi keputusan pada permintaan ini.",
    APPROVER_ROLE_MISMATCH:
      "Peran Anda tidak berwenang menyetujui tingkat ini.",
    APPROVAL_LEVEL_OUT_OF_ORDER: "Tingkat approval ini belum dapat diputuskan.",
    APPROVAL_POLICY_MISSING:
      "Matriks approval untuk tindakan ini belum diatur.",
  },
} as const;

// `access.permission.<code>` is the contract name (legend-svza); the existing
// `access.perm.*` keys stay for the RBAC screens already reading them.
export const accessMessages = {
  ...accessBaseMessages,
  permission: accessBaseMessages.perm,
} as const;
