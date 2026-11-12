// 539-U4 (legend-ydf2 / legend-8r77t). Own file so parallel screens never edit the same catalog lines.
// Shared labels of the HRIS request screens: kind, status, dates, work-time
// rule warnings and common errors.
export const hrisRequestsCommonMessages = {
  kind: {
    swap: "Tukar shift",
    cover: "Ganti shift",
    leave: "Cuti / izin",
    overtime: "Lembur",
  },
  status: {
    pending: "Menunggu",
    approved: "Disetujui",
    rejected: "Ditolak",
    cancelled: "Dibatalkan",
    expired: "Kedaluwarsa",
  },
  period: {
    range: "{from} sampai {to}",
    overtime: "{date}, {minutes} menit",
    unknown: "Tanggal belum diketahui",
  },
  unknownEmployee: "Karyawan tidak dikenal",
  issue: {
    shift_too_long: "Shift terlalu panjang",
    daily_limit_exceeded: "Melewati batas jam kerja per hari",
    weekly_limit_exceeded: "Melewati batas jam kerja per minggu",
    insufficient_rest: "Waktu istirahat antar shift kurang",
    overlapping_shift: "Shift saling tumpang tindih",
    too_many_consecutive_days: "Terlalu banyak hari kerja berturut-turut",
  },
  error: {
    load: "Pengajuan belum bisa dimuat. Coba lagi.",
    offline: "Tidak ada koneksi. Pengajuan belum terkirim, coba lagi saat tersambung.",
    conflict: "Pengajuan ini sudah berubah. Muat ulang lalu coba lagi.",
    forbidden: "Anda tidak punya akses ke pengajuan ini.",
    notFound: "Pengajuan tidak ditemukan.",
    overrideReasonRequired:
      "Alasan wajib diisi untuk menyetujui pengajuan yang melanggar aturan jam kerja.",
    generic: "Terjadi kesalahan. Coba lagi.",
  },
} as const;
