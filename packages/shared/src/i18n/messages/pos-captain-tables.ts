// Captain texts for the shell, the table picker and waiter calls (sub-539-u1, P1).
// id.ts imports it as `posCaptainTables`.
export const posCaptainTablesMessages = {
  shell: {
    brand: "Legend / Captain",
    back: "Kembali",
    online: "Lokal terhubung",
    offline: "Internet putus",
    connectivityLabel: "Status koneksi",
  },
  offline: {
    title: "Internet putus · Lokal terhubung",
    body: "Pesanan tetap dapat dikirim ke dapur lewat jaringan outlet.",
  },
  tables: {
    title: "Pilih meja",
    subtitle: "Catat pesanan untuk meja pelanggan.",
    searchLabel: "Cari meja",
    searchPlaceholder: "Cari nomor meja",
    filterLabel: "Filter meja",
    filter: {
      all: "Semua meja",
      occupied: "Terisi",
      empty: "Kosong",
    },
    status: {
      occupied: "Terisi · {count} tamu",
      empty: "Kosong",
    },
    seats: "{count} kursi",
    qrSession: "Sesi QR aktif",
    openCall: "Panggilan waiter",
    legend: "Meja terisi ditandai latar abu-abu dan teks status.",
    listLabel: "Daftar meja",
    callsButton: "Panggilan waiter",
    callsButtonNew: "Panggilan waiter · {count} baru",
    loading: "Memuat meja…",
    empty: {
      title: "Belum ada meja",
      description:
        "Meja untuk outlet ini belum diatur. Minta manajer menambahkannya di Denah & Meja.",
    },
    noMatch: {
      title: "Tidak ada meja yang cocok",
      description: "Ubah nomor meja atau filter, lalu coba lagi.",
      reset: "Hapus pencarian",
    },
    error: {
      title: "Daftar meja belum bisa dimuat",
      description: "Periksa koneksi outlet, lalu coba lagi.",
      retry: "Coba lagi",
      pendingTitle: "Fitur ini belum tersambung ke server",
      pendingDescription:
        "Daftar meja untuk captain belum tersedia di server. Hubungi tim teknis.",
    },
  },
  banner: {
    title: "Panggilan baru · {table}",
    description: "{reason} · {zone}",
    descriptionNoZone: "{reason}",
    more: "{count} panggilan baru lainnya",
    view: "Lihat",
  },
  calls: {
    title: "Panggilan waiter",
    subtitle: "Permintaan untuk zona Anda.",
    back: "Captain",
    table: "Meja {table}",
    meta: "{detail} · {time}",
    listLabel: "Daftar panggilan",
    status: {
      new: "Baru",
      acknowledged: "Diterima",
    },
    type: {
      call_waiter: "Panggil waiter",
      request_bill: "Minta tagihan",
      complaint: "Keluhan",
    },
    acknowledge: "Terima permintaan",
    resolve: "Selesaikan permintaan",
    acknowledgeFor: "Terima permintaan meja {table}",
    resolveFor: "Selesaikan permintaan meja {table}",
    hint: "Terima permintaan agar tim tahu Anda akan menindaklanjutinya.",
    resolved: "Permintaan meja {table} selesai.",
    loading: "Memuat panggilan…",
    empty: {
      title: "Tidak ada panggilan",
      description: "Permintaan dari meja akan muncul di sini.",
    },
    error: {
      title: "Panggilan belum bisa dimuat",
      description: "Periksa koneksi outlet, lalu coba lagi.",
      retry: "Coba lagi",
      pendingTitle: "Fitur ini belum tersambung ke server",
      pendingDescription:
        "Panggilan waiter belum tersedia di server. Hubungi tim teknis.",
    },
    actionError: {
      title: "Permintaan belum bisa diperbarui",
      description: "Periksa koneksi outlet, lalu ketuk tombolnya sekali lagi.",
      pendingTitle: "Fitur ini belum tersambung ke server",
      pendingDescription:
        "Perubahan status panggilan belum tersedia di server.",
    },
  },
};
