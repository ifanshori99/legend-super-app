// WS-06 recipe and production screens (bead legend-w0v; PRD v1.7 §3 F17
// "Resep Bertingkat, Produksi Batch", §6.E). Its own file so parallel
// inventory beads never edit the same catalog lines; screens read
// `inventoryRecipe.*`.
export const inventoryRecipeMessages = {
  title: "Resep & produksi",
  subtitle:
    "BOM bertingkat dengan konversi satuan, hasil per batch, dan instruksi produksi setengah jadi.",

  // Shared wording for both screens.
  errors: {
    load: "Resep gagal dimuat",
    loadHint: "Periksa koneksi lalu coba lagi.",
    offline: "Anda sedang offline. Sambungkan perangkat lalu coba lagi.",
    saveFailed:
      "Perubahan gagal disimpan. Periksa kembali isian lalu coba lagi.",
    cycle:
      "Resep komponen sudah memakai resep ini, jadi akan membentuk lingkaran. Pilih komponen lain.",
  },
  menuOutput: "Menu",
  unknownItem: "Item tidak ditemukan",
  unknownRecipe: "Resep tidak ditemukan",

  // ---- Recipe list (/kelola/inventori/resep) -----------------------------

  list: {
    title: "Daftar resep",
    description:
      "Resep menu dan bahan setengah jadi beserta HPP teoretis per satuan hasil.",
    newRecipe: "Resep baru",
    empty: "Belum ada resep",
    emptyHint:
      "Buat resep pertama agar bahan dan HPP menu bisa dihitung otomatis.",
    filterLabel: "Saring status resep",
    filters: {
      all: "Semua status",
      active: "Aktif",
      inactive: "Nonaktif",
    },
    columns: {
      name: "Resep",
      output: "Keluaran",
      yield: "Hasil",
      version: "Versi",
      status: "Status",
      cost: "HPP / satuan",
      updated: "Diperbarui",
    },
    versionValue: "v{version}",
    active: "Aktif",
    inactive: "Nonaktif",
    costUnavailable: "Tanpa izin biaya",
    updatedBy: "oleh {user}",
    openRecipe: "Buka resep {name}",
  },

  // ---- Create dialog -----------------------------------------------------

  create: {
    title: "Resep baru",
    description:
      "Isi identitas resep dan bahan pertama. Baris BOM lainnya ditambahkan di editor.",
    name: "Nama resep",
    nameHint: "Contoh: Sirup Gula Aren atau Kopi Susu Aren.",
    output: "Item keluaran",
    outputHint:
      "Pilih bahan setengah jadi bila resep ini diproduksi sebagai batch; kosongkan untuk resep menu.",
    outputMenu: "Tanpa item keluaran (menu)",
    yieldQuantity: "Hasil per batch",
    yieldQuantityHint: "Jumlah yang dihasilkan satu kali masak.",
    yieldUnit: "Satuan hasil",
    firstLineTitle: "Bahan pertama",
    firstLineHint:
      "Kontrak resep membutuhkan minimal satu komponen. Sisanya bisa ditambah di editor.",
    component: "Komponen",
    componentPlaceholder: "Pilih bahan",
    quantity: "Jumlah net",
    unit: "Satuan",
    submit: "Buat dan buka editor",
    successTitle: "Resep dibuat",
    successBody: "Lengkapi baris BOM lalu simpan sebagai versi baru.",
    errorName: "Nama resep wajib diisi.",
    errorYieldQuantity: "Hasil harus lebih dari nol.",
    errorYieldUnit: "Pilih satuan hasil.",
    errorComponent: "Pilih bahan pertama.",
    errorQuantity: "Jumlah harus lebih dari nol.",
    errorUnit: "Pilih satuan bahan.",
    errorSubmit: "Resep gagal dibuat. Periksa isian lalu coba lagi.",
    noSemiFinished: "Belum ada bahan setengah jadi.",
    noItems: "Belum ada item bahan. Tambahkan item di tab Item.",
  },

  // ---- Recipe editor (/kelola/inventori/resep/$recipeId) -----------------

  editor: {
    subtitle:
      "Ubah komponen, jumlah net, satuan, dan susut. Menyimpan membuat versi baru; versi lama tetap tersimpan.",
    notFound: "Resep tidak ditemukan",
    notFoundHint: "Resep mungkin sudah dihapus atau tautannya kedaluwarsa.",
    readOnly:
      "Anda dapat melihat resep ini, tetapi tidak punya izin mengubahnya.",
    header: {
      output: "Keluaran",
      yield: "Hasil per batch",
      costPerUnit: "HPP teoretis per {unit}",
      grossNote:
        "Susut dihitung sebagai kehilangan hasil: bruto = net ÷ (1 − susut).",
    },
    lines: {
      title: "Komponen BOM",
      description:
        "Satu baris per bahan atau resep setengah jadi. Satuan resep dikonversi ke satuan dasar komponen.",
      empty: "Belum ada komponen",
      emptyHint: "Tambahkan bahan pertama pada baris di bawah.",
      netQuantity: "Net",
      unit: "Satuan",
      waste: "Susut (%)",
      gross: "Bruto",
      cost: "Biaya",
      remove: "Hapus baris {name}",
      conversionHint: "= {quantity} {unit} pada satuan dasar",
      conversionMissing: "Konversi satuan belum tersedia",
      costUnavailable: "Biaya belum tersedia",
      invalidQuantity: "Jumlah harus lebih dari nol.",
      invalidWaste: "Susut harus 0 sampai di bawah 100%.",
      invalidComponent: "Pilih komponen.",
      invalidUnit: "Pilih satuan.",
      selfRecipe: "Resep tidak boleh memakai dirinya sendiri.",
      typeLabel: "Jenis komponen",
      types: {
        item: "Bahan",
        recipe: "Resep",
      },
      componentLabel: "Komponen",
      itemPlaceholder: "Pilih bahan",
      recipePlaceholder: "Pilih resep",
    },
    add: {
      title: "Tambah bahan",
      description:
        "Pilih bahan atau resep, isi jumlah net, lalu tambahkan baris ke BOM.",
      submit: "Tambah baris",
      success:
        "Baris ditambahkan ke BOM. Simpan versi baru untuk menerapkannya.",
    },
    total: {
      title: "Total HPP",
      batch: "Total batch",
      perUnit: "Per {unit}",
      incomplete:
        "Total belum bisa dihitung: lengkapi komponen, satuan, dan biaya bahan.",
      draftHint: "Dihitung dari baris yang sedang diedit, belum tersimpan.",
    },
    changeNote: "Catatan perubahan",
    changeNoteHint: "Opsional, misalnya alasan penyesuaian takaran.",
    save: "Simpan sebagai versi baru",
    saved: "Versi baru tersimpan",
    savedBody: "Resep sekarang memakai versi {version}.",
    back: "Kembali ke daftar resep",
    addLineFirst: "Tambahkan minimal satu komponen sebelum menyimpan.",
  },

  // ---- Production batch (/kelola/inventori/produksi) ---------------------

  production: {
    title: "Produksi batch",
    description:
      "Perintah produksi bahan setengah jadi: rencana batch, status, dan hasil aktual.",
    newOrder: "Produksi baru",
    empty: "Belum ada perintah produksi",
    emptyHint:
      "Buat perintah produksi untuk merekam pemakaian bahan dan hasil batch.",
    filterLabel: "Saring status produksi",
    filters: {
      all: "Semua status",
      draft: "Draf",
      in_progress: "Berjalan",
      completed: "Selesai",
      cancelled: "Dibatalkan",
    },
    columns: {
      recipe: "Resep",
      quantity: "Jumlah batch",
      outlet: "Outlet",
      status: "Status",
      created: "Dibuat",
      completed: "Selesai",
      actions: "Aksi",
    },
    status: {
      draft: "Draf",
      in_progress: "Berjalan",
      completed: "Selesai",
      cancelled: "Dibatalkan",
    },
    actions: {
      start: "Mulai",
      complete: "Selesaikan",
      cancel: "Batalkan",
      startLabel: "Mulai produksi {name}",
      completeLabel: "Selesaikan produksi {name}",
      cancelLabel: "Batalkan produksi {name}",
    },
    create: {
      title: "Produksi baru",
      description:
        "Pilih resep bahan setengah jadi dan jumlah batch yang akan diproduksi.",
      recipe: "Resep",
      recipePlaceholder: "Pilih resep produksi",
      recipeHint: "Hanya resep dengan item keluaran setengah jadi.",
      quantity: "Jumlah batch",
      quantityHint: "Dalam satuan hasil resep.",
      submit: "Buat perintah",
      successTitle: "Perintah produksi dibuat",
      successBody: "Status draf. Mulai produksi saat bahan siap.",
      errorRecipe: "Pilih resep produksi.",
      errorQuantity: "Jumlah batch harus lebih dari nol.",
      errorSubmit:
        "Perintah produksi gagal dibuat. Periksa isian lalu coba lagi.",
      emptyRecipes:
        "Belum ada resep setengah jadi. Buat resep dengan item keluaran terlebih dahulu.",
    },
    transition: {
      startTitle: "Mulai produksi?",
      startBody:
        "Status berubah menjadi berjalan. Bahan dipakai sesuai resep saat batch diselesaikan.",
      startSubmit: "Mulai produksi",
      completeTitle: "Selesaikan produksi",
      completeBody:
        "Masukkan hasil aktual batch. Selisih dari rencana tercatat pada laporan produksi.",
      actualQuantity: "Hasil aktual",
      actualQuantityHint: "Dalam satuan hasil resep.",
      actualError: "Hasil aktual harus lebih dari nol.",
      completeSubmit: "Selesaikan",
      cancelTitle: "Batalkan produksi?",
      cancelBody:
        "Perintah yang dibatalkan tidak dapat dilanjutkan. Buat perintah baru bila batch tetap dijalankan.",
      cancelSubmit: "Batalkan produksi",
      keep: "Tidak, kembali",
      failed: "Aksi produksi gagal. Muat ulang lalu coba lagi.",
      started: "Produksi dimulai",
      completed: "Produksi selesai",
      cancelled: "Produksi dibatalkan",
    },
  },
};
