// WS-10 shift templates and weekly roster calendar (bead legend-299s; PRD v1.7
// §3 Kelompok D 28 "Penjadwalan Shift", F26, HR-05, AI-13). Own file so
// parallel WS-10 beads never edit the same catalog lines.
export const rosterMessages = {
  title: "Roster & Shift",
  subtitle:
    "Susun jadwal mingguan per stasiun dan jabatan, periksa kepatuhan jam kerja, lalu terbitkan roster.",
  gap: {
    assignment:
      "Kontrak belum punya endpoint simpan shift. Shift baru disimpan sebagai draf lokal di perangkat ini sampai endpoint tersebut tersedia.",
    template:
      "Kontrak belum punya endpoint buat atau ubah template shift. Layar template hanya menampilkan data kontrak.",
  },
  tabs: {
    roster: "Roster",
    templates: "Template Shift",
  },
  week: {
    heading: "Roster {range}",
    previous: "Minggu sebelumnya",
    next: "Minggu berikutnya",
    thisWeek: "Minggu ini",
    statusLabel: "Status minggu",
    published: "Terbit",
    draft: "Draf",
    empty: "Belum ada jadwal",
    publishedAt: "Diterbitkan {date}",
  },
  filters: {
    label: "Filter roster",
    position: "Jabatan",
    station: "Stasiun",
    allPositions: "Semua jabatan",
    allStations: "Semua stasiun",
  },
  stats: {
    label: "Ringkasan roster minggu ini",
    shifts: "Shift",
    employees: "Karyawan terjadwal",
    hours: "Jam kerja",
    warnings: "Peringatan",
    period: "Minggu {range}",
    draftContext: "{count} draf belum terbit",
    publishedContext: "Roster sudah terbit",
    emptyContext: "Belum ada shift",
  },
  grid: {
    title: "Kalender roster",
    description:
      "Tarik template shift ke sel, atau pakai tombol tambah di sel untuk keyboard dan layar sentuh.",
    employee: "Karyawan",
    add: "Tambah shift",
    addFor: "Tambah shift untuk {employee} pada {date}",
    menuLabel: "Pilihan shift {employee}, {date}",
    addTemplate: "Tambah {template}",
    removeDraft: "Hapus draf {time}",
    dropHint: "Lepas template shift di sini",
    noEmployees: "Belum ada karyawan aktif di outlet ini",
    noEmployeesHint:
      "Tambahkan karyawan aktif atau pilih outlet lain untuk menyusun roster.",
    noResults: "Tidak ada karyawan yang cocok dengan filter",
    noResultsHint: "Ubah jabatan atau stasiun untuk melihat baris lain.",
    noPosition: "Tanpa jabatan",
    rowWarnings: "{count} peringatan",
    totalHours: "{hours} jam",
    holiday: "Libur",
    today: "Hari ini",
    emptyWeek:
      "Belum ada shift pada minggu ini. Tarik template atau tambah shift dari sel.",
  },
  chip: {
    published: "Terbit",
    draft: "Draf",
    swapped: "Ditukar",
    break: "Istirahat {minutes} mnt",
  },
  palette: {
    title: "Palet template shift",
    description: "Tarik ke kalender, atau pilih template dari menu sel.",
    crossing: "Lewat tengah malam",
    break: "Istirahat {minutes} mnt",
    inactive: "Nonaktif",
    dragHint: "Tarik {template} ke kalender",
    empty: "Belum ada template shift aktif untuk outlet ini.",
  },
  compliance: {
    label: "Kepatuhan jam kerja",
    count: "{count} peringatan",
    ok: "Semua shift dalam batas kebijakan",
    shift_too_long: "Shift terlalu panjang: {actual} mnt (batas {limit})",
    daily_limit_exceeded: "Melebihi batas harian: {actual} mnt (batas {limit})",
    weekly_limit_exceeded:
      "Melebihi batas mingguan: {actual} mnt (batas {limit})",
    insufficient_rest:
      "Istirahat antarshift kurang: {actual} mnt (minimal {limit})",
    overlapping_shift: "Shift bertumpuk {actual} mnt",
    too_many_consecutive_days:
      "Terlalu banyak hari kerja berurutan: {actual} hari (maks {limit})",
  },
  suggestions: {
    title: "Usulan AI-13",
    description:
      "Saran jumlah karyawan per hari dari selisih cakupan minggu ini. Ini hanya usulan; terima untuk menjadikannya draf.",
    badge: "Saran",
    empty: "Cakupan minggu ini sudah merata; belum ada usulan.",
    emptyHint:
      "Saran muncul saat satu hari terjadwal lebih sedikit dari hari tersibuk.",
    dateLine: "{date} kurang {count} shift",
    reason: "Hari tersibuk minggu ini memakai {target} karyawan.",
    assign: "Terima usulan",
    assignFor: "Terima usulan {employee} pada {date}",
    accepted: "Draf {employee} pada {date} ditambahkan.",
  },
  actions: {
    copyPrevious: "Salin minggu lalu",
    copied: "{count} shift disalin sebagai draf.",
    copyEmpty: "Minggu sebelumnya belum punya shift untuk disalin.",
    copyAlreadyDone:
      "Semua shift minggu lalu sudah ada di minggu ini; tidak ada yang disalin.",
    publish: "Terbitkan",
  },
  publish: {
    title: "Terbitkan roster minggu ini?",
    description:
      "Semua draf shift pada minggu {range} akan menjadi terbit dan terlihat oleh karyawan.",
    summary: "{shifts} shift · {employees} karyawan",
    warnings:
      "{count} peringatan kepatuhan ikut terbit. Periksa sebelum melanjutkan.",
    noWarnings: "Tidak ada peringatan kepatuhan.",
    confirm: "Terbitkan jadwal",
    success: "Roster minggu {range} diterbitkan.",
    error: "Roster gagal diterbitkan. Periksa koneksi lalu coba lagi.",
    empty: "Belum ada shift untuk diterbitkan.",
  },
  templates: {
    title: "Template shift",
    description:
      "Pagi, siang, malam, dan split shift yang dipakai roster outlet ini.",
    empty: "Belum ada template shift untuk outlet ini.",
    crossing: "Lewat tengah malam",
    break: "Istirahat {minutes} mnt",
    segments: "{count} segmen",
    active: "Aktif",
    inactive: "Nonaktif",
    allStations: "Semua stasiun",
    allPositions: "Semua posisi",
    unknownStation: "Stasiun tidak dikenal",
    station: "Stasiun {name}",
    position: "Jabatan {name}",
    readOnly:
      "Layar ini baca-saja: kontrak belum punya endpoint buat atau ubah template shift.",
    sample: "Data contoh",
  },
  errors: {
    load: "Roster tidak dapat dimuat",
    loadHint: "Periksa koneksi lalu coba lagi.",
    offline: "Anda sedang offline. Sambungkan kembali untuk memuat roster.",
  },
} as const;
