// QR order "final arah A + liquid glass" texts, part: menu (bead legend-2re1;
// design/mockups/README.md, founder Q3–Q6). One file per screen group so the
// parallel screen builds never edit the same lines.
export const qrGlassMenuMessages = {
  title: "Menu untuk meja Anda",
  subtitle: "Pesan langsung dari meja.",
  table: "Meja {table}",
  tableGuests: "Meja {table} · {count} tamu",
  sitAt: "Anda duduk di",
  pricingNote: "Harga belum termasuk pajak dan service.",
  pricingNoteMixed: "Pajak dan service dihitung saat checkout.",
  pricingNoteInclusive: "Harga sudah termasuk pajak dan service.",
  search: {
    open: "Buka pencarian menu",
    close: "Tutup pencarian menu",
    allMenu: "Cari seluruh menu",
  },
  filter: {
    open: "Filter menu",
    openActive: "Filter menu, {count} dipilih",
    title: "Filter menu",
    close: "Tutup filter menu",
  },
  guest: {
    label: "Jumlah tamu",
    choose: "Pilih",
    chooseAria: "Pilih jumlah tamu",
    hint: "Isi sebelum menambah menu pertama.",
    save: "Simpan",
    close: "Tutup jumlah tamu",
    chip: "{count} tamu",
  },
  card: {
    inCart: "{count} di keranjang",
    stepDecrease: "Kurangi {name}",
    stepIncrease: "Tambah satu {name}",
    soldOutLabel: "Habis hari ini",
    soldOutHint: "Belum bisa dipesan.",
    availableFrom: "Tersedia mulai {time}",
  },
  stale: {
    message: "Menu belum diperbarui. Keranjang tetap tersimpan.",
    retry: "Coba lagi",
  },
  shared: {
    note: "Keranjang dibagikan dengan tamu semeja.",
  },
} as const;
