// HR review of attendance logged on an approved leave day (bead legend-3jem1).
// Copy follows design/mockups/hr-leave-clockin-review/README.md. Own file so
// parallel WS-10 beads never edit the same catalog lines.
export const leaveClockinReviewMessages = {
  nav: {
    label: "Tinjauan absensi",
  },
  queue: {
    title: "Tinjauan absensi",
    description: "Tinjau absensi yang memerlukan keputusan HR.",
    searchLabel: "Cari nama karyawan",
    searchPlaceholder: "Cari nama karyawan…",
    sectionTitle: "Perlu ditinjau",
    tableLabel: "Antrean tinjauan absensi saat cuti",
    columnStatus: "Status",
    columnEmployee: "Nama karyawan",
    columnDate: "Tanggal",
    columnLeave: "Cuti",
    columnClockIn: "Jam masuk",
    columnClockOut: "Jam pulang",
    columnAction: "Aksi",
    review: "Tinjau",
    reviewFor: "Tinjau absensi {employee} tanggal {date}",
    clockOutMissing: "Belum absen keluar",
    clockInLabel: "Masuk",
    clockOutLabel: "Keluar",
  },
  status: {
    leaveClockIn: "Absen saat cuti",
    manualCorrection: "Koreksi absen manual",
    reReview: "Perlu ditinjau ulang",
    keptLeave: "Tetap cuti",
    cancelledLeave: "Cuti hari ini dibatalkan",
  },
  kind: {
    leaveClockIn: "Absen saat cuti",
    manualCorrection: "Koreksi absen manual",
  },
  reReview: {
    note: "Perlu ditinjau ulang: ada cuti baru disetujui",
  },
  empty: {
    title: "Tidak ada tinjauan absensi",
    description: "Absensi yang memerlukan tinjauan akan muncul di sini.",
  },
  loading: {
    label: "Memuat tinjauan absensi",
  },
  error: {
    title: "Tinjauan absensi tidak dapat dimuat",
    description:
      "Daftar tinjauan gagal dimuat. Periksa koneksi, lalu coba lagi.",
    detailTitle: "Detail tinjauan tidak dapat dimuat",
    detailDescription:
      "Detail absensi gagal dimuat. Periksa koneksi, lalu coba lagi.",
    retry: "Coba lagi",
  },
  offline: {
    title: "Anda sedang offline",
    description:
      "Sambungkan kembali koneksi untuk memuat atau memutuskan tinjauan.",
  },
  notFound: {
    title: "Tinjauan tidak ditemukan",
    description:
      "Absensi ini tidak ada atau sudah diputuskan. Kembali ke antrean untuk melihat tinjauan terbaru.",
  },
  detail: {
    title: "Tinjau absensi saat cuti",
    back: "Kembali ke antrean",
    summaryTitle: "Ringkasan",
    employee: "Nama karyawan",
    caseKind: "Jenis kasus",
    unknownEmployee: "Karyawan tidak dikenal",
    unknownValue: "Tidak tersedia",
    leaveType: "Jenis cuti",
    leavePeriod: "Periode cuti (disetujui)",
    leavePeriodRange: "{start} sampai {end}",
    attendanceDate: "Tanggal absensi",
    clockIn: "Jam masuk",
    clockOut: "Jam keluar",
    clockOutMissing: "Belum absen keluar",
    pending: "Saldo cuti dan gaji belum berubah sampai HR memutuskan.",
  },
  decision: {
    title: "Keputusan",
    prompt: "Pilih tindakan untuk absensi pada {date}.",
    keepLeave: "Tetap cuti",
    cancelLeave: "Batalkan cuti hari ini, hitung hadir",
    impact:
      "Tetap cuti mempertahankan saldo dan status cuti; membatalkan cuti mengembalikan saldo untuk hari ini dan menghitung hari ini sebagai hadir untuk dasar gaji.",
    multiDayNote:
      "Hanya cuti pada tanggal ini yang dibatalkan; hari cuti lain tetap berlaku.",
    payrollNote:
      "Gaji aktual mengikuti proses penggajian yang berlaku, bukan perubahan langsung saat absen.",
    manualCorrectionNote:
      "Pembatalan selalu satu hari penuh, bukan setengah hari.",
    noCancelRight:
      "Anda tidak memiliki hak untuk membatalkan cuti. Minta HR yang berwenang meninjau keputusan ini.",
    noKeepRight:
      "Anda tidak memiliki hak untuk mempertahankan cuti. Minta HR yang berwenang meninjau keputusan ini.",
  },
  confirmKeep: {
    title: "Tetap cuti untuk tanggal ini?",
    description:
      "Cuti dan saldo tetap. Absen pada {date} tidak dihitung sebagai hadir.",
    back: "Kembali",
    confirm: "Tetap cuti",
    confirming: "Menyimpan…",
  },
  confirmCancel: {
    title: "Batalkan cuti hari ini dan hitung hadir?",
    description:
      "Hanya cuti pada {date} yang dibatalkan. Saldo cuti untuk hari itu dikembalikan, dan hari itu menjadi dasar hadir.",
    back: "Kembali",
    confirm: "Batalkan cuti hari ini",
    confirming: "Menyimpan…",
  },
  confirmFailed: {
    title: "Keputusan belum tersimpan",
    fallback: "Keputusan gagal disimpan. Coba lagi.",
    offline: "Anda sedang offline. Sambungkan koneksi, lalu coba lagi.",
  },
  result: {
    banner: "Keputusan tersimpan",
    keptTitle: "Tetap cuti",
    keptDetail:
      "Cuti dan saldo pada {date} tetap. Absen pada hari itu tidak dihitung sebagai hadir.",
    cancelledTitle: "Cuti hari ini dibatalkan",
    cancelledDetail:
      "Cuti pada {date} dibatalkan dan saldo untuk hari itu dikembalikan. Hari itu menjadi dasar hadir; cuti di tanggal lain tetap berlaku.",
    decisionLabel: "Keputusan",
    employee: "Karyawan",
    date: "Tanggal",
    caseKind: "Jenis kasus",
    status: "Status",
    back: "Kembali ke antrean",
  },
  toast: {
    kept: "Keputusan tersimpan: tetap cuti.",
    cancelled: "Keputusan tersimpan: cuti hari ini dibatalkan.",
    failed: "Keputusan gagal disimpan.",
  },
  errors: {
    forbidden: "Anda tidak punya akses untuk memutuskan tinjauan ini.",
    notFound:
      "Absensi tidak ditemukan atau sudah diputuskan. Kembali ke antrean untuk melihat keadaan terbaru.",
    unknown: "Terjadi kesalahan. Coba lagi.",
    ATTENDANCE_LEAVE_DECISION_NOT_ALLOWED:
      "Keputusan cuti hanya untuk absensi masuk pada hari cuti disetujui yang belum diputuskan. Keadaan sudah berubah. Kembali ke antrean untuk melihat keadaan terbaru.",
    ATTENDANCE_LEAVE_NOT_APPROVED:
      "Tidak ada cuti disetujui pada hari itu. Keadaan sudah berubah. Kembali ke antrean untuk melihat keadaan terbaru.",
    ATTENDANCE_LEAVE_NOT_REACHABLE:
      "Cuti tidak dapat dibatalkan dari akses Anda saat ini. Pilih tetap cuti atau minta HR yang berwenang.",
    ATTENDANCE_LEAVE_DAYS_MISMATCH:
      "Jumlah hari cuti tidak cocok dengan rentangnya. Pilih tetap cuti dan laporkan ke tim teknis.",
    ATTENDANCE_LEAVE_STILL_APPROVED:
      "Masih ada cuti disetujui pada hari itu sehingga pembatalan belum selesai. Pilih tetap cuti.",
    ATTENDANCE_LEAVE_DECISION_REQUIRED:
      "Ada cuti disetujui pada hari itu. Pilih tetap cuti atau batalkan cuti hari ini.",
    ATTENDANCE_REVIEW_NOT_ALLOWED:
      "Koreksi manual sudah diputuskan lewat persetujuan dan hanya bisa ditinjau dengan keputusan cuti.",
    ATTENDANCE_CORRECTION_LEAVE_DAY:
      "Karyawan punya cuti disetujui pada tanggal ini. Batalkan cuti hari itu lebih dulu bila karyawan memang masuk kerja.",
  },
} as const;
