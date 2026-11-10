// POS floor board: a supervisor turns a running pay-first table session into
// an open bill with PIN + reason (bead legend-8cm4; founder Q31/Q32, 9 Nov).
// id.ts imports it as `openBillConvert`.
export const openBillConvertMessages = {
  action: "Jadikan open bill",
  title: "Jadikan open bill · Meja {code}",
  summary:
    "Tamu bayar belakangan, dan pesanan berikutnya masuk ke tagihan terbuka meja ini.",
  limits: {
    title: "Batas outlet",
    max: "Batas tagihan",
    outstanding: "Sisa tagihan",
    idle: "Pengingat tidak aktif",
    idleValue: "{minutes} menit",
  },
  unpaidStays:
    "Pesanan yang sedang menunggu bayar tetap harus dibayar dulu. Pesanan berikutnya masuk tagihan terbuka.",
  who: "Penyetuju memasukkan PIN sendiri. Alasan dan nama penyetuju tercatat di jejak audit.",
  approver: {
    label: "Supervisor penyetuju",
    placeholder: "Pilih supervisor",
    loadError:
      "Daftar supervisor belum bisa dimuat. Periksa koneksi lalu coba lagi.",
    empty:
      "Belum ada supervisor dengan PIN di outlet ini. Minta manajer mengatur PIN supervisor.",
  },
  over: {
    title: "Sisa tagihan sudah mencapai batas",
    body: "Sisa tagihan {outstanding} sudah mencapai batas open bill outlet {limit}. Minta tamu membayar sebagian dulu, atau minta manajer menaikkan batas di Kelola › Pengaturan › Open bill.",
  },
  error: {
    limit:
      "Sisa tagihan sudah mencapai batas open bill outlet. Minta tamu membayar sebagian dulu, atau minta manajer menaikkan batas.",
    pin: "PIN salah. Coba lagi, atau pilih supervisor lain.",
    locked:
      "PIN supervisor ini terkunci karena terlalu banyak salah. Pilih supervisor lain atau coba lagi nanti.",
    approverDenied:
      "Supervisor ini tidak punya izin menyetujui open bill di outlet ini. Pilih supervisor lain.",
    notEligible:
      "Meja ini sudah open bill atau sesinya sudah selesai. Muat ulang papan meja.",
    generic: "Belum bisa menyimpan. Periksa koneksi lalu coba lagi.",
  },
  policyError:
    "Batas open bill outlet belum bisa dimuat. Periksa koneksi lalu coba lagi.",
  retry: "Coba lagi",
  close: "Tutup",
  success: "Meja {code} sekarang open bill",
} as const;
