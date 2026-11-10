// QR order "final arah A + liquid glass" texts, part: item (bead legend-2re1;
// design/mockups/README.md, founder Q3–Q6). One file per screen group so the
// parallel screen builds never edit the same lines.
export const qrGlassItemMessages = {
  title: "Pilihan menu",
  note: {
    label: "Catatan dapur",
    placeholder: "Contoh: es sedikit",
  },
  submit: "Tambah · {amount}",
  soldOut: {
    title: "Menu ini sedang habis",
    hint: "Belum bisa ditambahkan ke pesanan. Pilih menu lain dari daftar.",
    hintUntil: "Bisa dipesan lagi pada jam itu.",
  },
  error: {
    chooseBefore: "Pilih {group} sebelum menambahkan.",
    variantBefore: "Pilih varian sebelum menambahkan.",
  },
} as const;
