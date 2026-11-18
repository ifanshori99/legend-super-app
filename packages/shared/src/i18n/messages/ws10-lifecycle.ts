// WS-10 onboarding/offboarding checklists, exit clearance, final settlement and
// work certificate (bead legend-u3x3; PRD v1.7 §3 F24 / D26, §4 Alur M). Own file so
// parallel WS-10 beads never edit the same catalog lines.
export const lifecycleMessages = {
  title: "Siklus Karyawan",
  nav: {
    onboarding: "Onboarding",
    offboarding: "Offboarding",
  },
  common: {
    employee: "Karyawan",
    nip: "NIP",
    nipValue: "NIP {nip}",
    position: "Jabatan",
    orgUnit: "Unit organisasi",
    outlet: "Outlet",
    joinDate: "Tanggal masuk",
    exitDate: "Tanggal keluar",
    status: "Status",
    noValue: "—",
    defaultTemplate: "Template umum",
    noTemplate: "Belum ada template",
    taskProgress: "{done}/{total} tugas",
    blockedCount: "{count} terblokir",
    openDetail: "Buka detail",
  },
  employeeStatus: {
    onboarding: "Onboarding",
    active: "Aktif",
    suspended: "Ditangguhkan",
    resigned: "Resign",
    terminated: "Diberhentikan",
  },
  taskStatus: {
    open: "Terbuka",
    done: "Selesai",
    blocked: "Terblokir",
    waived: "Dilewati",
  },
  category: {
    documents: "Dokumen",
    uniform: "Seragam",
    account: "Akun",
    training: "Pelatihan",
    asset: "Aset",
    access_revocation: "Pencabutan akses",
    final_settlement: "Hak akhir",
    work_certificate: "Surat keterangan",
    other: "Lainnya",
  },
  actions: {
    complete: "Selesaikan",
    block: "Blokir",
    unblock: "Buka blokir",
    waive: "Lewati",
    completeNamed: "Selesaikan tugas {title}",
    blockNamed: "Blokir tugas {title}",
    unblockNamed: "Buka blokir tugas {title}",
    waiveNamed: "Lewati tugas {title}",
  },
  checklist: {
    description:
      "Tugas dikelompokkan per kategori. Status hanya berubah lewat alur tugas yang sama dengan API.",
    due: "Tenggat {date}",
    noDue: "Tanpa tenggat",
    doneAt: "Selesai {date}",
    saved: "Status tugas diperbarui.",
    saveFailed: "Status tugas tidak dapat disimpan. Coba lagi.",
    localPreview:
      "Pratinjau lokal: aksi tugas belum punya endpoint, jadi perubahan hanya tersimpan di mode mock.",
    empty: "Belum ada tugas di checklist ini",
    emptyHint:
      "Checklist dibuat dari template jabatan saat proses onboarding atau offboarding dimulai.",
    errorTitle: "Checklist tidak dapat dimuat",
    errorHint: "Periksa koneksi lalu muat ulang daftar tugas.",
  },
  metrics: {
    checklistLabel: "Ringkasan checklist",
    total: "Total tugas",
    done: "Selesai",
    open: "Terbuka",
    blocked: "Terblokir",
    percentContext: "{percent}% selesai",
  },
  header: {
    subtitle: "{position} · NIP {nip}",
  },
  onboarding: {
    list: {
      title: "Karyawan dalam onboarding",
      description:
        "Karyawan berstatus onboarding, ditambah karyawan aktif yang masih punya tugas onboarding terbuka.",
      search: "Cari karyawan onboarding",
      columns: {
        employee: "Karyawan",
        position: "Jabatan",
        template: "Template checklist",
        start: "Mulai",
        progress: "Progres",
        open: "Detail",
      },
      metricsLabel: "Ringkasan onboarding",
      metrics: {
        employees: "Sedang onboarding",
        open: "Tugas terbuka",
        blocked: "Tugas terblokir",
        complete: "Checklist selesai",
      },
      metricsContext: "Dihitung dari tugas checklist onboarding",
      empty: "Belum ada karyawan dalam onboarding",
      emptyHint:
        "Karyawan berstatus onboarding, atau karyawan aktif dengan tugas onboarding terbuka, muncul di sini.",
    },
    detail: {
      back: "Kembali ke daftar onboarding",
      checklistTitle: "Checklist onboarding",
    },
  },
  offboarding: {
    list: {
      title: "Karyawan dalam offboarding",
      description:
        "Karyawan resign atau diberhentikan, ditambah siapa pun yang sudah punya tugas offboarding.",
      search: "Cari karyawan offboarding",
      columns: {
        employee: "Karyawan",
        position: "Jabatan",
        exit: "Tanggal keluar",
        clearance: "Clearance",
        status: "Status clearance",
        open: "Detail",
      },
      metricsLabel: "Ringkasan offboarding",
      metrics: {
        employees: "Karyawan keluar",
        done: "Tugas selesai",
        open: "Tugas terbuka",
        blocked: "Tugas terblokir",
      },
      metricsContext: "Dihitung dari tugas exit clearance",
      clearance: {
        done: "Clearance selesai",
        running: "Clearance berjalan",
        none: "Belum ada tugas",
      },
      empty: "Belum ada karyawan yang keluar",
      emptyHint:
        "Karyawan berstatus resign atau diberhentikan, atau yang sudah punya tugas offboarding, muncul di sini.",
    },
    detail: {
      back: "Kembali ke daftar offboarding",
      checklistTitle: "Checklist exit clearance",
    },
  },
  settlement: {
    title: "Ringkasan penyelesaian akhir",
    description:
      "Estimasi hak akhir dari data payroll karyawan ini. Baris tidak dijumlahkan.",
    estimate: "Estimasi",
    thr: "THR pro rata",
    thrSource: "Masa kerja {months} bulan penuh s.d. {date}",
    thrMissing: {
      noExitDate: "Tanggal keluar belum ditetapkan",
      noWage: "Belum ada komponen upah THR tercatat",
      noTable: "Tabel THR yang berlaku belum diterbitkan",
    },
    loan: "Kasbon belum lunas",
    loanSource: "{count} kasbon aktif, dipotong dari hak akhir",
    loanNone: "Tidak ada kasbon aktif",
    loanUnavailable: "Ringkasan dari server belum tersedia",
    pendingDeduction: "Potongan kasbon payroll tertunda",
    pendingDeductionSource:
      "{count} cicilan sudah dicadangkan payroll run, sudah dikurangkan dari kasbon di atas",
    pendingDeductionNone: "Tidak ada cicilan yang menunggu payroll run",
    reimbursement: "Reimbursement disetujui, belum dibayar",
    reimbursementSource:
      "{count} klaim disetujui · {pending} menunggu keputusan",
    reimbursementNone:
      "Tidak ada klaim disetujui · {pending} menunggu keputusan",
    restricted:
      "Nominal hak akhir adalah data gaji dan hanya tampil untuk pemegang izin lihat payroll.",
    errorTitle: "Data payroll gagal dimuat",
    errorHint: "Periksa koneksi lalu coba lagi.",
    estimateNote:
      "Angka final mengikuti payroll run yang sudah dikunci. Pesangon dan sisa cuti belum punya kontrak perhitungan, jadi belum tampil di sini.",
  },
  clearance: {
    cleared: "Exit clearance selesai. Surat keterangan kerja bisa dibuka.",
    blocked:
      "Exit clearance belum selesai: {count} tugas masih terbuka atau terblokir.",
    noTasks: "Belum ada tugas exit clearance untuk karyawan ini.",
    certificateTaskLocked:
      "Selesaikan semua tugas exit clearance lain sebelum surat keterangan diterbitkan.",
  },
  certificate: {
    title: "Surat keterangan kerja",
    description:
      "Pratinjau lokal surat keterangan; nomor dan isinya belum diterbitkan API.",
    open: "Lihat surat",
    print: "Cetak",
    preview: "Pratinjau lokal",
    printHint:
      "Dialog cetak peramban juga bisa menyimpan surat sebagai PDF untuk arsip.",
    previewNote:
      "Pratinjau lokal: belum ada endpoint surat keterangan kerja, jadi surat ini tidak dapat diterbitkan atau diunduh.",
    heading: "SURAT KETERANGAN KERJA",
    numberPending: "Nomor diterbitkan saat surat disahkan",
    locked: {
      notLeaving:
        "Surat hanya untuk karyawan yang sudah resign atau diberhentikan dengan tanggal keluar.",
      clearanceOpen:
        "Surat terkunci sampai semua tugas exit clearance selesai.",
    },
    body: "Yang bertanda tangan di bawah ini menerangkan bahwa {name} dengan NIP {nip} benar bekerja di perusahaan ini dengan rincian sebagai berikut.",
    closing: "Surat ini dibuat untuk dipergunakan sebagaimana mestinya.",
    fields: {
      name: "Nama",
      nip: "NIP",
      position: "Jabatan",
      outlet: "Outlet",
      joinDate: "Mulai bekerja",
      endDate: "Akhir bekerja",
      manager: "Atasan langsung",
      company: "Perusahaan",
    },
    noManager: "Belum ada atasan tercatat",
    signatory: "Atasan langsung",
    signatureSpace: "Tanda tangan dan nama terang",
  },
  error: {
    employeeNotFound: "Karyawan tidak ditemukan.",
    employeeNotFoundHint:
      "Karyawan ini mungkin sudah dihapus atau Anda tidak punya akses ke datanya.",
  },
} as const;
