// Guest manage-reservation page text (bead legend-g12il): shell, shared
// summary and DP breakdown. Request screens live in `reservationGuestRequest`,
// cancel and recovery screens in `reservationGuestCancel`.
export const reservationGuestMessages = {
  pageTitle: "Kelola reservasi",
  mockNote: "Contoh data · Mockup",
  shell: {
    section: "Kelola reservasi",
    footerKeep:
      "Simpan tautan ini untuk memeriksa reservasi Anda. Jangan bagikan kepada orang lain.",
    footerHelp: "Butuh bantuan? Balas pesan konfirmasi reservasi.",
  },
  summary: {
    label: "Rincian reservasi",
    time: "{time} {zone} · Waktu outlet",
    guests: "Jumlah tamu",
    guestsValue: "{count} orang",
    deposit: "DP sudah dibayar",
  },
  deposit: {
    title: "Rincian DP",
    paid: "DP sudah dibayar",
    forfeited: "Potongan DP",
    refund: "DP dikembalikan",
  },
} as const;
