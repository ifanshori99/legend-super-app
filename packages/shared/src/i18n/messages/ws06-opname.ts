// Stok opname and waste/susut screens (bead legend-fzx) · PRD v1.7 §3 F16
// "Stok Opname" and "Waste & Spoilage", §4 Alur J. Its own catalog file so the
// parallel WS-06 FE beads never edit the same lines; the namespace keys
// (`opname`, `waste`) are unique to this bead.
export const opnameMessages = {
  title: "Stok opname",
  subtitle:
    "Hitung stok fisik penuh atau per siklus, catat selisihnya dalam rupiah, lalu setujui penyesuaian sebelum dibukukan.",
  type: {
    full: "Hitung penuh",
    cycle: "Hitung siklus",
  },
  typeHint: {
    full: "Semua item di lokasi ini ikut dihitung.",
    cycle: "Hanya item yang Anda pilih yang dihitung.",
  },
  status: {
    draft: "Draf",
    counting: "Sedang dihitung",
    pending_approval: "Menunggu persetujuan",
    approved: "Disetujui",
    posted: "Sudah dibukukan",
    cancelled: "Dibatalkan",
  },
  list: {
    title: "Sesi stok opname",
    description:
      "Sesi berjalan dan riwayat opname per lokasi. Hitung buta menyembunyikan angka sistem dari penghitung.",
    newCount: "Mulai opname",
    searchPlaceholder: "Cari lokasi atau catatan…",
    filterLabel: "Filter status opname",
    filters: {
      all: "Semua",
      active: "Berjalan",
      pending: "Menunggu",
      done: "Selesai",
    },
    progress: "{counted} dari {total} baris dihitung",
    blind: "Hitung buta",
    open: "Buka sesi",
    varianceLabel: "Selisih",
    noVariance: "Tanpa selisih",
    empty: "Belum ada sesi opname",
    emptyHint:
      "Mulai hitung penuh untuk seluruh lokasi atau hitung siklus untuk beberapa item saja.",
    noResults: "Tidak ada sesi pada filter ini",
    noResultsHint: "Ubah kata kunci atau tampilkan semua status.",
    loadMore: "Muat lebih banyak",
    unknownLocation: "Lokasi tidak dikenal",
  },
  create: {
    title: "Mulai stok opname",
    description:
      "Pilih lokasi dan jenis hitungan. Sesi dimulai sebagai draf; angka sistem dibekukan saat hitungan dimulai.",
    location: "Lokasi penyimpanan",
    locationPlaceholder: "Pilih lokasi",
    type: "Jenis hitungan",
    blind: "Hitung buta",
    blindHint: "Penghitung tidak melihat jumlah sistem selama menghitung.",
    businessDate: "Tanggal bisnis",
    businessDateHint: "Mengikuti zona waktu outlet.",
    items: "Item yang dihitung",
    itemsHint: "Pilih minimal satu item untuk hitung siklus.",
    fullCount: "{count} item aktif akan dihitung.",
    itemSearch: "Cari nama item…",
    selectAll: "Pilih semua",
    clearAll: "Kosongkan",
    selectedCount: "{count} item dipilih",
    note: "Catatan sesi",
    noteHint: "Misalnya: opname bulanan chiller atau permintaan audit.",
    submit: "Buat sesi",
    successTitle: "Sesi opname dibuat",
    successBody: "Mulai hitung untuk mengisi jumlah fisik.",
    noLocations:
      "Belum ada lokasi stok. Lengkapi lokasi gudang terlebih dahulu.",
    noItems: "Belum ada item aktif untuk dihitung.",
    errorLocation: "Pilih lokasi penyimpanan.",
    errorItems: "Pilih minimal satu item untuk hitung siklus.",
    errorDate: "Isi tanggal bisnis.",
    errorSubmit: "Sesi belum bisa dibuat. Periksa isian lalu coba lagi.",
  },
  detail: {
    back: "Kembali ke daftar opname",
    notFoundTitle: "Sesi opname tidak ditemukan",
    notFoundHint: "Sesi mungkin sudah dihapus atau tautannya salah.",
    meta: {
      location: "Lokasi",
      businessDate: "Tanggal bisnis",
      counter: "Penghitung",
      approver: "Penyetuju",
      notApproved: "Belum disetujui",
      countedAt: "Selesai dihitung",
      approvedAt: "Disetujui pada",
    },
    blindNotice: "Sesi hitung buta",
    blindNoticeHint:
      "Angka sistem dan nilai selisih hanya terlihat oleh penyetuju setelah hitungan dikirim.",
    progressTitle: "Progres hitung",
    progress: "{counted} dari {total} baris",
    linesTitle: "Baris hitungan",
    linesDescription:
      "Masukkan jumlah fisik dalam satuan dasar item. Hitungan tersimpan saat Anda pindah baris.",
    searchPlaceholder: "Cari item…",
    noResults: "Tidak ada item yang cocok",
    noResultsHint: "Hapus kata kunci untuk melihat semua baris.",
    line: {
      item: "Item",
      system: "Sistem",
      counted: "Fisik",
      difference: "Selisih",
      value: "Nilai selisih",
      notCounted: "Belum dihitung",
      unit: "Satuan {unit}",
      countLabel: "Jumlah fisik {name}",
      saved: "Tersimpan",
      saveError: "Baris belum tersimpan. Periksa angka lalu coba lagi.",
      zero: "Tidak ada selisih",
    },
    notice: {
      counting:
        "Masukkan jumlah fisik setiap baris. Setelah semua terisi, kirim untuk disetujui.",
      pending:
        "Hitungan menunggu persetujuan orang lain sebelum penyesuaian dibukukan.",
      approved:
        "Sudah disetujui. Bukukan penyesuaian untuk menulis koreksi ke kartu stok.",
      posted: "Penyesuaian sudah dibukukan ke kartu stok.",
      cancelled: "Sesi ini dibatalkan. Tidak ada penyesuaian yang dibukukan.",
      draft: "Mulai hitungan agar penghitung dapat mengisi jumlah fisik.",
    },
    summary: {
      title: "Ringkasan selisih",
      description:
        "Nilai selisih dihitung dari kuantitas × biaya rata-rata bergerak.",
      total: "Total nilai selisih",
      lines: "{count} baris berselisih",
      noVariance: "Tidak ada selisih pada sesi ini",
      note: "Catatan penghitung",
      noNote: "Tanpa catatan",
    },
    actions: {
      start: "Mulai hitung",
      startHint: "Membuka pengisian jumlah fisik untuk semua baris.",
      submit: "Kirim untuk persetujuan",
      submitHint: "Hitungan dikunci sampai penyetuju memberi keputusan.",
      submitBlocked: "Isi jumlah fisik semua baris dulu sebelum mengirim.",
      approve: "Setujui hitungan",
      approveHint: "Penyetuju harus orang lain dari penghitung.",
      reject: "Kembalikan untuk dihitung ulang",
      rejectHint: "Penghitung dapat memperbaiki baris lalu mengirim lagi.",
      post: "Bukukan penyesuaian",
      postHint:
        "Menulis baris penyesuaian ke kartu stok; tidak dapat dibatalkan.",
      cancel: "Batalkan sesi",
      cancelHint: "Sesi batal tidak membukukan penyesuaian apa pun.",
      saving: "Menyimpan…",
      loading: "Memproses…",
      selfApproval:
        "Penghitung tidak dapat menyetujui hitungannya sendiri. Minta outlet manager meninjau sesi ini.",
      waitingApproval:
        "Menunggu persetujuan outlet manager sebelum penyesuaian dibukukan.",
    },
    dialogs: {
      start: {
        title: "Mulai hitung sekarang?",
        description:
          "Angka sistem dibekukan sebagai pembanding. Hitungan buta tetap menyembunyikannya dari penghitung.",
        confirm: "Mulai hitung",
      },
      approve: {
        title: "Setujui hitungan ini?",
        description:
          "Persetujuan menandai selisih sebagai disetujui. Penyesuaian baru dibukukan pada langkah berikutnya.",
        confirm: "Setujui",
      },
      reject: {
        title: "Kembalikan hitungan?",
        description:
          "Sesi kembali ke status dihitung agar penghitung memperbaiki barisnya.",
        confirm: "Kembalikan",
      },
      post: {
        title: "Bukukan penyesuaian stok?",
        description:
          "Kartu stok menerima baris penyesuaian untuk setiap selisih. Tindakan ini tidak dapat dibatalkan.",
        confirm: "Bukukan",
      },
      cancel: {
        title: "Batalkan sesi opname?",
        description:
          "Sesi tidak dapat dipakai lagi. Tidak ada penyesuaian yang dibukukan.",
        confirm: "Batalkan sesi",
      },
    },
    toasts: {
      started: "Hitungan dimulai",
      submitted: "Hitungan dikirim untuk persetujuan",
      approved: "Hitungan disetujui",
      rejected: "Hitungan dikembalikan ke penghitung",
      posted: "Penyesuaian stok dibukukan",
      cancelled: "Sesi opname dibatalkan",
    },
  },
} as const;

export const wasteMessages = {
  title: "Waste & susut",
  subtitle:
    "Catat bahan atau menu yang terbuang dengan alasan baku dan foto bukti opsional; nilai kerugian dihitung dari biaya rata-rata.",
  record: "Catat waste",
  target: {
    inventory_item: "Bahan",
    menu_item: "Menu",
  },
  unit: {
    portion: "porsi",
  },
  reasons: {
    expired: "Kedaluwarsa",
    spoiled: "Rusak atau basi",
    dropped: "Jatuh atau tumpah",
    prep_error: "Salah penyiapan",
    overproduction: "Produksi berlebih",
    quality_reject: "Ditolak kualitas",
    other: "Lainnya",
  },
  summary: {
    lossLabel: "Nilai kerugian",
    lossContext: "Dari {count} catatan pada filter ini",
    source: "Lihat catatan",
  },
  filters: {
    reason: "Alasan",
    allReasons: "Semua alasan",
  },
  list: {
    title: "Catatan waste",
    description:
      "Kerugian bahan dan menu yang sudah tercatat. Setiap catatan memotong stok dan masuk ke laporan food cost.",
    searchPlaceholder: "Cari item, alasan, atau catatan…",
    empty: "Belum ada catatan waste",
    emptyHint:
      "Catat bahan kedaluwarsa, rusak, atau hidangan yang tidak terjual agar kerugiannya terlihat.",
    noResults: "Tidak ada catatan pada filter ini",
    noResultsHint: "Ubah kata kunci atau alasan.",
    photo: "Foto",
    note: "Catatan",
    unknownTarget: "Item tidak ditemukan",
    quantity: "{quantity} {unit}",
    countedBy: "Dicatat oleh {name}",
  },
  form: {
    title: "Catat waste",
    description:
      "Nilai kerugian dihitung server dari kuantitas × biaya rata-rata bergerak, bukan dari harga jual.",
    targetType: "Jenis target",
    item: "Bahan",
    itemPlaceholder: "Pilih bahan",
    menu: "Menu",
    menuPlaceholder: "Pilih menu",
    noItems: "Belum ada item bahan aktif.",
    noMenu: "Belum ada menu aktif.",
    quantity: "Kuantitas",
    quantityHint: "Dalam satuan dasar item, lebih dari nol.",
    unit: "Satuan",
    location: "Lokasi",
    locationPlaceholder: "Pilih lokasi",
    locationHint: "Lokasi stok yang berkurang.",
    reason: "Alasan baku",
    reasonPlaceholder: "Pilih alasan",
    note: "Catatan",
    noteHint:
      "Jelaskan singkat penyebabnya, misalnya susu pecah saat shift pagi.",
    photo: "Foto bukti",
    photoHint:
      "Opsional. Pilih foto kamera atau galeri. Foto diperkecil sebelum diunggah dan membantu audit waste.",
    photoChoose: "Pilih foto",
    photoChange: "Ganti foto",
    photoRemove: "Hapus foto",
    photoAlt: "Pratinjau foto bukti",
    photoTooLarge:
      "Foto masih lebih dari 5 MB setelah diperkecil. Pilih foto lain.",
    photoInvalid:
      "Foto tidak bisa dibaca. Pilih foto lain dari kamera atau galeri.",
    photoUploading: "Foto sedang diunggah. Tunggu sebelum menyimpan.",
    photoUploaded: "Foto terunggah.",
    photoCancelUpload: "Batalkan unggah",
    photoUploadUnavailable:
      "Foto belum terunggah. Penyimpanan atau pemeriksa berkas sedang tidak tersedia. Coba lagi.",
    photoUploadOffline:
      "Foto belum terunggah. Periksa koneksi internet lalu coba lagi.",
    photoUploadFailed: "Foto belum terunggah. Coba lagi atau pilih foto lain.",
    photoReadFailed: "Foto belum bisa ditampilkan. Coba muat lagi.",
    submit: "Simpan catatan",
    cancel: "Batal",
    errorTarget: "Pilih bahan atau menu yang terbuang.",
    errorQuantity: "Isi kuantitas lebih dari nol.",
    errorReason: "Pilih alasan waste.",
    errorLocation: "Pilih lokasi stok.",
    errorSubmit: "Catatan belum tersimpan. Periksa isian lalu coba lagi.",
    successTitle: "Catatan waste tersimpan",
    successBody: "Stok terpotong dan nilai kerugian masuk ke laporan.",
  },
} as const;
