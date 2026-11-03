// Outlet settings copy (bead legend-1mi5, follow-up legend-5kop). One file so
// the screen's copy does not collide with the broader settings hub strings.
export const orgOutletMessages = {
  title: "Outlet",
  subtitle:
    "Nama, alamat, dan jam tutup buku yang dipakai menghitung hari bisnis outlet.",
  listTitle: "Daftar outlet",
  fields: {
    name: "Nama outlet",
    address: "Alamat",
    timeZone: "Zona waktu",
    cutoff: "Jam tutup buku",
  },
  timeZoneHint:
    "Zona waktu mengikuti pengaturan outlet dan belum bisa diubah dari layar ini.",
  cutoffHint:
    "Penjualan sebelum jam ini dihitung ke hari bisnis sebelumnya. Isi antara 00:00 dan 11:59; nilai di luar rentang itu ditolak.",
  previewTitle: "Tanggal bisnis saat ini",
  previewHint:
    "Dihitung dari jam tutup buku di atas pada zona waktu outlet, bukan jam perangkat.",
  saved: "Pengaturan outlet tersimpan.",
  saveFailed: "Perubahan belum tersimpan. Periksa koneksi, lalu coba lagi.",
  offline: "Sedang offline. Sambungkan internet untuk menyimpan perubahan.",
};
