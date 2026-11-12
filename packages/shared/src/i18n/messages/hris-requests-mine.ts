// 539-U4 (legend-ydf2 / legend-8r77t). Own file so parallel screens never edit the same catalog lines.
// Employee "Pengajuan saya" list and the holiday calendar (mockups kosong-mobile, ditolak-mobile).
export const hrisRequestsMineMessages = {
  list: {
    title: "Pengajuan saya",
    subtitle: "Pantau pengajuan dan keputusan supervisor.",
    back: "Kembali ke Beranda",
    create: "Buat pengajuan",
    holidayLink: "Lihat kalender libur",
    loading: "Memuat pengajuan",
    listLabel: "Daftar pengajuan saya",
    empty: {
      title: "Belum ada pengajuan",
      description:
        "Pengajuan cuti, tukar shift, dan lembur Anda akan muncul di sini.",
    },
    error: {
      title: "Pengajuan belum bisa dimuat",
      description: "Periksa koneksi Anda, lalu coba lagi.",
      offlineDescription:
        "Anda sedang offline. Sambungkan internet, lalu coba lagi.",
      retry: "Coba lagi",
    },
    rejected: {
      title: "Pengajuan ditolak",
      body: "Supervisor menolak {count} pengajuan. Tanya supervisor Anda untuk alasannya.",
    },
  },
  kind: {
    swap: "Tukar shift",
    cover: "Ganti shift",
    leave: "Cuti/izin",
    overtime: "Lembur",
  },
  status: {
    pending: "Menunggu",
    approved: "Disetujui",
    rejected: "Ditolak",
    cancelled: "Dibatalkan",
    expired: "Kedaluwarsa",
  },
  card: {
    submitted: "Diajukan {date}",
    decided: "Diputuskan {date}",
    days: "{days} hari",
    minutes: "{minutes} menit",
    swapWaiting: "Menunggu rekan dan supervisor",
    rejectedHint: "Tanya supervisor Anda untuk alasannya.",
  },
  peerResponse: {
    title: "Permintaan dari rekan",
    descriptionPrefix: "Rekan meminta Anda menerima ",
    descriptionSuffix: "shift sebelum diteruskan ke atasan.",
    contextMissing:
      "Rincian peminta dan jadwal belum tersedia. Respons ditahan sampai rincian dapat ditampilkan.",
    rejectionReasonLabel: "Alasan penolakan",
    error: "Respons gagal dikirim. Coba lagi.",
    accept: "Terima",
  },
  holiday: {
    title: "Kalender libur",
    subtitle: "Hari libur nasional, cuti bersama, dan libur perusahaan.",
    back: "Kembali ke Pengajuan saya",
    loading: "Memuat kalender libur",
    previousYear: "Tahun sebelumnya",
    nextYear: "Tahun berikutnya",
    year: "Tahun {year}",
    count: "{count} hari libur",
    monthLabel: "Libur bulan {month}",
    empty: {
      title: "Belum ada hari libur",
      description: "Kalender libur tahun {year} belum diisi.",
    },
    error: {
      title: "Kalender libur belum bisa dimuat",
      description: "Periksa koneksi Anda, lalu coba lagi.",
      offlineDescription:
        "Anda sedang offline. Sambungkan internet, lalu coba lagi.",
      retry: "Coba lagi",
    },
    type: {
      national: "Libur nasional",
      collective: "Cuti bersama",
      company: "Libur perusahaan",
    },
    scope: {
      all: "Semua cabang",
      outlet: "Cabang tertentu",
    },
  },
} as const;
