// Approval inbox text (PRD v1.7 §3 F7 / F36 Kotak Approval, F38 Draf Aksi;
// MCP-04 UI; bead legend-mxl). Namespace `approvals`. Own file so parallel
// beads never edit the same lines in id.ts.

export const approvalsMessages = {
  nav: "Kotak Approval",
  title: "Kotak Approval",
  subtitle:
    "Permintaan dari semua modul, termasuk draf aksi AI dan agen MCP, menunggu keputusan Anda.",
  requesterUnknown: "Pengguna {id}",
  requestedBy: "Diminta oleh {name}",
  draftFor: "Draf atas nama {name}",
  level: "Tingkat {level} dari {total}",
  review: "Tinjau",
  reviewAria: "Tinjau permintaan {action}",
  loadMore: "Muat lebih banyak",
  backToInbox: "Kembali ke Kotak Approval",

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
    ai_action: "Aksi AI",
    mcp_action: "Aksi agen MCP",
    cash_drawer_open: "Buka laci kas",
    price_correction: "Koreksi harga",
    cash_shift_close: "Tutup shift kasir",
    edc_standalone: "Pembayaran EDC standalone",
    apology_voucher: "Voucher permintaan maaf",
    unallocated_funds: "Dana belum teralokasi",
    reconciliation_case: "Penutupan kasus rekonsiliasi",
    purchase_request: "Permintaan pembelian",
    supplier_payment: "Pembayaran supplier",
    cash_out: "Kas keluar",
    manual_journal: "Jurnal manual",
    period_reopen: "Buka kembali periode",
    payroll_cancel: "Pembatalan payroll",
    shareholder_version: "Versi daftar pemegang saham",
    personal_data_export: "Ekspor data pribadi",
    attendance_correction: "Koreksi absensi",
    shift_swap: "Tukar shift",
    leave: "Cuti",
    overtime: "Lembur",
    employee_loan: "Kasbon",
    reimbursement: "Reimbursement",
  },

  module: {
    pos: "Kasir",
    finance: "Keuangan",
    inventory: "Stok & pengadaan",
    menu: "Menu",
    people: "Karyawan",
    owner: "Pemilik",
    automation: "AI & MCP",
  },

  source: { user: "Pengguna", ai: "AI", mcp: "MCP" },
  sourceBadge: { user: "Pengguna", ai: "Draf AI", mcp: "Draf MCP" },

  agentDraft: {
    title: {
      ai: "Draf yang diusulkan Tanya AI",
      mcp: "Draf yang diusulkan agen MCP",
    },
    body: "Diajukan atas nama {name}. Belum ada yang diterapkan: aksi baru dijalankan setelah Anda setujui, dan tidak dijalankan bila ditolak atau kedaluwarsa.",
  },

  status: {
    pending: "Menunggu",
    approved: "Disetujui",
    rejected: "Ditolak",
    expired: "Kedaluwarsa",
    cancelled: "Dibatalkan",
  },

  deadline: {
    closed: "Selesai",
    left: {
      minute: "Sisa {amount} menit",
      hour: "Sisa {amount} jam",
      day: "Sisa {amount} hari",
    },
    late: {
      minute: "Terlambat {amount} menit",
      hour: "Terlambat {amount} jam",
      day: "Terlambat {amount} hari",
    },
  },

  filter: {
    status: "Status",
    allStatuses: "Semua status",
    module: "Modul",
    allModules: "Semua modul",
    deadline: "Batas waktu",
    source: "Sumber",
    allSources: "Semua sumber",
    reset: "Atur ulang filter",
    deadlineOption: {
      all: "Semua batas waktu",
      overdue: "Sudah lewat",
      within1h: "Dalam 1 jam",
      within24h: "Dalam 24 jam",
    },
  },

  col: {
    request: "Permintaan",
    source: "Sumber",
    value: "Nilai",
    level: "Tingkat",
    deadline: "Batas waktu",
    status: "Status",
    actions: "Aksi",
  },

  empty: {
    title: "Tidak ada permintaan menunggu",
    hint: "Permintaan baru dari kasir, AI, dan agen MCP muncul di sini. Ubah filter status untuk melihat riwayat.",
  },
  noMatch: {
    title: "Tidak ada permintaan yang cocok",
    hint: "Longgarkan filter modul, sumber, atau batas waktu.",
  },
  offline: {
    title: "Anda sedang offline",
    hint: "Kotak Approval butuh koneksi agar keputusan tidak ganda. Periksa koneksi, lalu coba lagi.",
  },
  error: {
    title: "Kotak Approval tidak bisa dimuat",
    hint: "Muat ulang daftar. Jika tetap gagal, hubungi admin tenant.",
  },

  drawer: {
    description:
      "Periksa nilai dan perubahan yang diusulkan sebelum memutuskan.",
  },

  detail: {
    title: "Detail permintaan",
    module: "Modul",
    requester: "Pemohon",
    onBehalfOf: "Atas nama",
    value: "Nilai",
    level: "Tingkat",
    deadline: "Batas waktu",
    requestReason: "Alasan pemohon",
    decided: "Keputusan",
    decidedBy: "Oleh {name}, {when}",
  },

  diff: {
    title: "Perubahan yang diusulkan",
    empty: "Permintaan ini tidak membawa data tambahan.",
    before: "Sebelum",
    after: "Sesudah",
    becomes: "menjadi",
  },

  shift: {
    difference: "Selisih kas",
    requesterHint: "Supervisor akan meninjau hitungan Anda.",
    viewStatus: "Lihat status",
  },

  field: {
    shiftCode: "Kode shift",
    terminal: "Terminal",
    orderNumber: "Nomor pesanan",
    refundMethod: "Metode refund",
    discountIdr: "Nilai diskon",
    itemName: "Nama item",
    idr: "Nilai",
    tool: "Alat",
    client: "Klien",
    supplier: "Supplier",
    invoiceNumber: "Nomor faktur",
    stockItemName: "Nama bahan",
    differenceQty: "Selisih jumlah",
    reason: "Alasan",
  },

  value: { yes: "Ya", no: "Tidak", none: "—" },

  decision: {
    title: "Keputusan",
    reason: "Alasan keputusan",
    reasonHint:
      "Wajib untuk setuju maupun tolak, 3 sampai 500 karakter. Tercatat di audit log.",
    reasonShort: "Tulis alasan minimal 3 karakter.",
    reasonLong: "Alasan maksimal 500 karakter.",
    approve: "Setujui",
    reject: "Tolak",
  },

  selfApproval: {
    note: "Anda satu-satunya Owner, jadi Anda bisa menyetujui sendiri, tetapi tidak bisa menolaknya. Tercatat di riwayat.",
  },

  blocked: {
    notPending: "Permintaan ini sudah diputuskan.",
    expired: "Batas waktu sudah lewat.",
    expiredHint: "Aksinya tetap diblokir. Pemohon perlu mengajukan ulang.",
    permission: "Peran Anda tidak boleh memutuskan permintaan.",
    identity: "Memeriksa identitas Anda…",
    own: "Anda pemohon permintaan ini.",
    ownHint:
      "Penyetuju harus orang lain (aturan penyetuju berbeda). Minta rekan atau atasan yang berwenang.",
    enrollment: "Peran Anda wajib faktor kedua, tetapi belum terdaftar.",
    enrollmentAction: "Daftarkan faktor kedua",
  },

  stepUp: {
    title: "Verifikasi faktor kedua",
    hint: "Memutuskan approval butuh verifikasi ulang. Masukkan kode dari aplikasi autentikator; keputusan Anda dikirim otomatis.",
    code: "Kode autentikator",
    codeInvalid: "Kode terdiri dari 6 angka.",
    verify: "Verifikasi dan kirim",
    noFactor:
      "Aplikasi autentikator belum terdaftar. Daftarkan di halaman keamanan akun.",
  },

  toast: {
    approved: "Permintaan disetujui.",
    rejected: "Permintaan ditolak.",
  },

  errors: {
    notPending: "Permintaan ini sudah diputuskan oleh orang lain.",
    expired:
      "Batas waktu persetujuan sudah lewat. Ajukan ulang bila masih perlu.",
    approverIsRequester: "Penyetuju tidak boleh sama dengan pemohon.",
    pending:
      "Persetujuan ini masih menunggu keputusan di Kotak Approval. Muat ulang, lalu coba lagi.",
    alreadyDecided: "Anda sudah memberi keputusan pada tingkat sebelumnya.",
    roleMismatch: "Peran Anda tidak berwenang menyetujui tingkat ini.",
    mfaRequired: "Verifikasi faktor kedua diperlukan.",
    mfaEnrollment: "Daftarkan faktor kedua dulu di halaman keamanan akun.",
    forbidden: "Anda tidak punya izin untuk tindakan ini.",
    notFound: "Permintaan tidak ditemukan. Mungkin sudah dihapus.",
    offline: "Tidak ada koneksi. Periksa jaringan, lalu coba lagi.",
    idempotencyReused:
      "Keputusan ini sudah dikirim dengan isi berbeda. Muat ulang permintaan, lalu putuskan lagi.",
    generic: "Keputusan belum terkirim. Coba lagi sebentar lagi.",
  },

  badge: {
    none: "Kotak Approval, tidak ada yang menunggu",
    waiting: "Kotak Approval, {count} menunggu",
  },
} as const;
