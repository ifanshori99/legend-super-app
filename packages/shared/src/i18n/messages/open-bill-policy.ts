// Management: per-outlet open-bill policy (bill value limit, idle reminder,
// bill-request target) at /kelola/pengaturan/open-bill (bead legend-2zb5).
// id.ts imports it as `openBillPolicy`.
export const openBillPolicyMessages = {
  title: "Kebijakan open bill",
  subtitle: "Atur batas meja yang boleh bayar belakangan di outlet ini.",
  defaultBadge: "Memakai nilai default",
  explain:
    "Supervisor yang bertugas bisa menjadikan meja open bill dengan PIN, selama sisa tagihan meja masih di bawah batas ini.",
  max: {
    label: "Batas nilai tagihan",
    hint: "Sisa tagihan per meja yang belum dibayar. Pesanan baru ditolak setelah batas ini, dan meja yang sisa tagihannya sudah di atas batas tidak bisa dijadikan open bill. {min} sampai {max}.",
    error: "Isi angka bulat antara {min} dan {max}.",
  },
  idle: {
    label: "Pengingat meja tidak aktif",
    unit: "menit",
    hint: "Waiter zona diberi tahu bila meja open bill tanpa aktivitas selama ini. {min} sampai {max} menit.",
    error: "Isi angka bulat antara {min} dan {max} menit.",
  },
  slo: {
    label: "Target respons minta tagihan",
    unit: "detik",
    hint: "Permintaan tagihan dianggap terlambat setelah waktu ini. {min} sampai {max} detik.",
    error: "Isi angka bulat antara {min} dan {max} detik.",
  },
  who: "Hanya manajer outlet ke atas yang bisa mengubah. Setiap perubahan tercatat di jejak audit.",
  save: "Simpan kebijakan",
  reset: "Kembalikan ke default",
  saved: "Kebijakan open bill disimpan",
  loadError:
    "Kebijakan open bill belum bisa dimuat. Periksa koneksi lalu coba lagi.",
  saveError: "Kebijakan belum tersimpan. Periksa koneksi lalu coba lagi.",
  retry: "Coba lagi",
  hub: {
    name: "Open bill",
    hint: "Batas tagihan dan pengingat meja bayar belakangan.",
  },
} as const;
