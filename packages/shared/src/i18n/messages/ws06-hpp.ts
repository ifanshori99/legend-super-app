// WS-06 HPP and food cost reports (bead legend-5pe; PRD v1.7 §3 F17 "HPP Menu,
// Food Cost, Menu Engineering, Kelengkapan Resep"). Own file so parallel
// inventory beads never edit the same catalog lines; screens read
// `inventoryHpp.*`.
export const inventoryHppMessages = {
  title: "HPP & food cost",
  subtitle:
    "HPP teoretis per menu, aktual vs teoretis, matriks menu engineering, dan kelengkapan resep.",
  tabsLabel: "Laporan HPP",
  tabs: {
    menu: "HPP per menu",
    actual: "Aktual vs teoretis",
    engineering: "Menu engineering",
    coverage: "Kelengkapan resep",
  },
  controls: {
    outlet: "Outlet",
    fromDate: "Dari tanggal",
    toDate: "Sampai tanggal",
    periodHint:
      "Periode berlaku untuk aktual vs teoretis dan menu engineering; HPP per menu adalah snapshot terakhir.",
  },
  offlineNotice:
    "Kamu sedang offline. Angka di layar adalah data terakhir yang berhasil dimuat.",
  loading: "Memuat laporan HPP…",
  stats: {
    label: "Ringkasan food cost periode ini",
    variance: "Selisih aktual vs teoretis",
    varianceIdr: "Nilai selisih",
    waste: "Nilai waste",
    coverage: "Kelengkapan resep",
    completeCount: "{complete}/{total}",
    emptyTitle: "Belum ada data food cost",
    emptyHint:
      "Periode ini belum punya perbandingan aktual dan teoretis. Pilih periode lain atau kembali ke 30 hari terakhir.",
    resetPeriod: "Pakai 30 hari terakhir",
  },
  menuCost: {
    title: "HPP per menu",
    description:
      "HPP teoretis per porsi dari resep lengkap. Menu tanpa resep ditandai dan tidak diberi angka.",
    searchLabel: "Cari menu",
    emptyTitle: "Belum ada data HPP menu",
    emptyHint: "Belum ada biaya menu yang dapat dihitung untuk outlet ini.",
    columns: {
      menu: "Menu",
      price: "Harga jual",
      cost: "HPP teoretis",
      margin: "Margin kotor",
      status: "Status",
      computedAt: "Dihitung",
    },
    status: {
      complete: "Resep lengkap",
      incomplete: "Resep belum lengkap",
    },
    variant: "Varian {id}",
    modifier: "Modifier {id}",
  },
  foodCost: {
    title: "Aktual vs teoretis",
    description:
      "Selisih periode dijelaskan oleh waste, penyesuaian, dan pemakaian di luar resep.",
    emptyTitle: "Belum ada perbandingan pada periode ini",
    emptyHint:
      "Pilih periode lain untuk melihat food cost aktual dan teoretis.",
    chartTitle: "Teoretis vs aktual",
    chartHint:
      "Batang aktual disorot; batang teoretis menjadi pembanding. Tabel di bawah memuat angka yang sama.",
    chartAria:
      "Grafik batang food cost periode {period}: teoretis {theoretical}, aktual {actual}",
    legend: {
      theoretical: "Teoretis",
      actual: "Aktual",
    },
    columns: {
      period: "Periode",
      theoretical: "Teoretis",
      actual: "Aktual",
      variance: "Selisih",
      waste: "Waste",
      adjustment: "Penyesuaian",
      offRecipe: "Di luar resep",
    },
    footer: "Selisih = waste + penyesuaian + pemakaian di luar resep.",
  },
  engineering: {
    title: "Menu engineering",
    description:
      "Klasifikasi popularitas dan margin dari laporan. Pilih satu sel matriks untuk menyaring tabel.",
    emptyTitle: "Belum ada data menu engineering",
    emptyHint: "Periode ini belum punya penjualan menu untuk diklasifikasi.",
    filterEmptyTitle: "Tidak ada menu pada klasifikasi ini",
    filterEmptyHint: "Pilih sel lain atau tampilkan semua menu.",
    matrixTitle: "Matriks menu engineering",
    matrixHint: "Pilih sel untuk menyaring daftar menu di bawah.",
    matrixCount: "{count} menu",
    clearFilter: "Tampilkan semua",
    filteredBy: "Klasifikasi: {classification}",
    columns: {
      menu: "Menu",
      units: "Porsi terjual",
      margin: "Margin kotor",
      classification: "Klasifikasi",
    },
    classes: {
      star: "Star",
      plowhorse: "Plowhorse",
      puzzle: "Puzzle",
      dog: "Dog",
    },
    classHints: {
      star: "Populer, margin tinggi",
      plowhorse: "Populer, margin rendah",
      puzzle: "Kurang populer, margin tinggi",
      dog: "Kurang populer, margin rendah",
    },
    axis: {
      marginHigh: "Margin tinggi",
      marginLow: "Margin rendah",
      popular: "Populer",
      unpopular: "Kurang populer",
    },
  },
  coverage: {
    title: "Kelengkapan resep",
    description: "Menu tanpa resep atau dengan resep belum lengkap.",
    emptyTitle: "Belum ada data kelengkapan resep",
    emptyHint: "Belum ada menu untuk diperiksa pada outlet ini.",
    allCompleteTitle: "Semua menu sudah punya resep lengkap",
    allCompleteHint: "Tidak ada menu yang perlu dilengkapi pada cakupan ini.",
    columns: {
      menu: "Menu",
      cost: "HPP teoretis",
      updated: "Diperbarui",
    },
    groups: {
      complete: "Lengkap",
      incomplete: "Belum lengkap",
      no_recipe: "Tanpa resep",
    },
    summary: "{status} · {count}",
    count: "{count} menu",
    variant: "Varian {id}",
    modifier: "Modifier {id}",
  },
  errors: {
    load: "Laporan HPP tidak dapat dimuat",
    loadHint:
      "Periksa koneksi lalu coba lagi. Layar ini tidak menghitung ulang angka sendiri.",
    offline: "Kamu sedang offline. Sambungkan perangkat lalu coba lagi.",
  },
};
