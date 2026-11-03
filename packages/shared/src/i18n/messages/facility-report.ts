// Facility & WFC reports (WS-09, bead legend-zx8k; PRD v1.7 §3 F25 "Laporan"
// and "Pengukuran WFC"). Own file so parallel beads never edit the same
// catalog lines.
export const facilityReportMessages = {
  nav: {
    title: "Laporan fasilitas",
  },
  hub: {
    title: "Laporan fasilitas & WFC",
    intro:
      "Enam laporan standar fasilitas dan WFC: pendapatan shower, RevPASH dan okupansi zona, utilisasi bilik, langganan, Wi-Fi tamu, serta konversi shower ke F&B. Setiap laporan memakai angka yang sama dengan dashboard pemilik yang menautkannya.",
    sampleNote:
      "Angka di layar demo berasal dari data contoh Cafe Legend, bukan data tenant sungguhan.",
    metrics: "Ukuran",
    dimensions: "Pecahan",
    periods: "Periode",
    open: "Buka laporan",
    empty: {
      title: "Katalog laporan fasilitas belum tersedia",
      hint: "Laporan fasilitas belum termuat di katalog aplikasi ini. Muat ulang halaman; bila tetap kosong, hubungi admin.",
    },
    missing:
      "Sebagian laporan fasilitas tidak ditemukan di katalog. Daftar di bawah hanya menampilkan laporan yang tersedia.",
    reading: {
      title: "Cara membaca",
      revpashTitle: "RevPASH dan okupansi zona",
      revpashBody:
        "RevPASH adalah pendapatan per kursi tersedia per jam: omzet zona dibagi (kursi tersedia × jam buka). Bandingkan zona pada jam yang sama, bukan pada jam berbeda. Okupansi tinggi dengan RevPASH rendah berarti kursi terisi lama tetapi belanjanya kecil, sedangkan RevPASH tinggi dengan okupansi sedang berarti perputaran dan belanja tamu sehat.",
      utilizationTitle: "Utilisasi bilik",
      utilizationBody:
        "Utilisasi bilik membandingkan menit bilik terpakai dengan menit bilik tersedia pada jam buka, dirata-ratakan untuk periode terpilih. Baca per bilik untuk melihat bilik yang jarang terpakai (misalnya karena pembersihan atau perawatan) dan bandingkan dengan rata-rata. Sesi dihitung dari tiket yang terpakai, bukan tiket yang terjual.",
      quotaTitle: "Langganan, kuota Wi-Fi, dan konversi",
      quotaBody:
        "Langganan aktif dibaca sebagai jumlah terakhir pada periode, bukan penjumlahan harian. Kuota Wi-Fi menunjukkan GB yang terpakai tamu. Konversi ke F&B adalah sesi shower yang disertai pesanan F&B dibagi seluruh sesi shower, jadi konversi tinggi berarti tamu fasilitas juga membelanjakan di kafe.",
    },
  },
} as const;
