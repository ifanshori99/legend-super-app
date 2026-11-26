// O3 offline POS texts (bead legend-wasr7.7): the /pos-offline shell the
// service worker shows when a /pos page cannot load, and the sign-out refusal
// while offline sales are still on the tablet. Core chunk: read from a route
// outside every area and from the shared sign-out button. id.ts imports it as
// `posOffline`.
export const posOfflineMessages = {
  shell: {
    title: "Kasir offline",
    description:
      "Tablet ini belum tersambung ke internet. Penjualan yang tersimpan di tablet terkirim setelah tablet tersambung lagi dan layar kasir dibuka kembali.",
    pending: "{count} penjualan offline belum terkirim.",
    none: "Tidak ada penjualan offline yang menunggu.",
    retry: "Buka kasir lagi",
  },
  signOutBlocked:
    "{count} penjualan offline belum terkirim. Sambungkan tablet ke internet dan tunggu sampai terkirim sebelum keluar.",
};
