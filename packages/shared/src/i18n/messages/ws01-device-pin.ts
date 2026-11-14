// Device PIN pad, switch-user flow and the supervisor override modal (bead
// legend-6ew; PRD v1.7 §3 F6 "Staf — PIN Perangkat", §3.6 "Override
// Supervisor", §4 Alur E, AUTH-06). Own file so parallel WS-01 beads never edit
// the same lines in id.ts. Namespace: `devicePin`.

export const devicePinMessages = {
  pageTitle: "Ganti pengguna",
  title: "Ganti pengguna",
  subtitle:
    "Pilih nama Anda lalu masukkan PIN pribadi 6 angka. Perangkat ini tetap masuk; hanya petugas yang berganti.",
  activeNow: "Aktif sekarang: {name}",
  activeNone: "Belum ada petugas aktif di perangkat ini.",

  emergency: {
    title: "Terima alarm darurat",
    subtitle:
      "Pilih nama Anda lalu masukkan PIN pribadi 6 angka untuk menerima alarm selama bertugas di outlet ini.",
    success: "Penerima alarm aktif untuk {name}",
    deviceRequired:
      "Perangkat belum dikenali. Minta manajer menyiapkan perangkat outlet, lalu coba lagi.",
    notOnDuty:
      "Anda belum tercatat bertugas di outlet ini. Mulai giliran kerja atau catat kehadiran, lalu coba lagi.",
    notAllowed:
      "Anda belum dapat menerima alarm di outlet ini. Minta manajer memeriksa akses Anda.",
  },

  pad: {
    label: "PIN 6 angka",
    hint: "Ketik dengan keyboard atau ketuk tombol angka.",
    digit: "Angka {digit}",
    backspace: "Hapus angka terakhir",
    clear: "Kosongkan",
    dots: "{filled} dari {total} angka terisi",
    verifying: "Memeriksa PIN…",
    attemptsLeft: "Sisa {remaining} percobaan sebelum PIN terkunci.",
    forUser: "PIN untuk {name}",
  },

  error: {
    invalid: "PIN salah. Periksa angkanya lalu coba lagi.",
    pickStaff:
      "Pilih dulu nama staf atau supervisor yang memasukkan PIN, lalu ulangi.",
    approver: "Supervisor yang memasukkan PIN",
    mismatch:
      "PIN ini bukan milik {name}. Pilih nama yang benar atau coba lagi.",
    network:
      "Tidak dapat menghubungi server. Periksa koneksi perangkat, lalu coba lagi.",
    generic: "PIN belum dapat diperiksa. Coba lagi sebentar lagi.",
    offlineHint:
      "Saat offline, ganti pengguna menunggu koneksi edge node outlet kembali.",
  },

  lockout: {
    title: "PIN terkunci",
    body: "Terlalu banyak PIN salah. Coba lagi dalam {time}.",
    countdown: "Sisa waktu kunci",
    supervisor:
      "Butuh cepat? Minta supervisor membuka kunci lewat override supervisor.",
    released: "Kunci sudah terbuka. Anda bisa memasukkan PIN lagi.",
  },

  switch: {
    pickTitle: "Siapa yang bertugas?",
    pickHint: "Petugas yang pernah masuk di perangkat ini.",
    pickLabel: "Pilih petugas",
    otherUser: "Petugas lain",
    otherUserHint: "Masukkan PIN pribadi tanpa memilih nama.",
    emptyTitle: "Belum ada petugas di perangkat ini",
    emptyHint:
      "Masukkan PIN pribadi Anda. Nama akan tersimpan setelah berhasil.",
    back: "Pilih nama lain",
    success: "Berpindah ke {name}",
    continuePos: "Lanjut ke kasir",
    continueKds: "Lanjut ke dapur",
    stationNote: "Perangkat ini milik outlet; PIN hanya berlaku di sini.",
  },

  demo: {
    title: "Uji override supervisor",
    description:
      "Contoh pemanggilan modal override yang dipakai kasir untuk void, diskon, dan refund.",
    action: "Ajukan override",
    resultTitle: "Override disetujui",
    resultBody: "{approver} menyetujui lewat {method}. Nilai: ",
    objectNote: "Pesanan contoh",
  },

  override: {
    title: "Override supervisor",
    approverLabel: "Supervisor yang memasukkan PIN",
    description:
      "Tindakan ini butuh persetujuan supervisor. Alasan, nilai, dan penyetuju dicatat di audit log.",
    actionLabel: "Tindakan",
    action: {
      void: "Void pesanan",
      discount: "Diskon di atas batas",
      refund: "Refund",
      cash_drawer_open: "Buka laci tanpa transaksi",
      price_correction: "Koreksi harga",
      cash_shift_close: "Tutup shift kasir",
      edc_standalone: "Pembayaran EDC standalone",
    },
    valueLabel: "Nilai terdampak",
    valueHint: "Rupiah penuh. Isi 0 bila tidak ada nilai.",
    reasonCodeLabel: "Kode alasan",
    reasonCodePlaceholder: "Pilih kode alasan",
    reasonCode: {
      wrong_item: "Salah input item",
      customer_cancel: "Pelanggan membatalkan",
      out_of_stock: "Stok habis",
      quality_complaint: "Komplain kualitas",
      price_mismatch: "Harga tidak sesuai",
      other: "Lainnya",
    },
    reasonLabel: "Catatan alasan",
    reasonHint: "Jelaskan singkat, minimal 3 karakter.",
    reasonPlaceholder: "Contoh: pelanggan membatalkan sebelum dapur mulai",
    methodLabel: "Cara persetujuan",
    method: {
      pin: "PIN supervisor",
      phone: "Persetujuan dari ponsel",
    },
    pinTitle: "PIN penyetuju",
    pinHint:
      "Supervisor memasukkan PIN pribadinya di perangkat ini. Penyetuju tidak boleh sama dengan peminta.",
    phoneHint:
      "Permintaan dikirim ke ponsel supervisor. Perangkat ini menunggu keputusan.",
    submitPin: "Setujui dengan PIN",
    submitPhone: "Kirim ke ponsel supervisor",
    cancel: "Batal",
    close: "Tutup",
    retry: "Coba lagi",
    sameApprover: "Penyetuju tidak boleh sama dengan peminta (AUTH-06).",
    noRequester:
      "Peminta belum diketahui. Masuk dulu dengan PIN Anda, lalu ajukan override.",
    outletUnknown:
      "Outlet untuk sesi PIN Anda belum diketahui. Masuk lagi dengan PIN Anda, lalu ajukan override.",
    relogin: "Masuk dengan PIN lagi",
    pinSuccess: "Disetujui oleh {name}.",
    sending: "Mengirim permintaan…",
    sendError: "Permintaan belum terkirim. Periksa koneksi lalu coba lagi.",
    fieldsLocked:
      "Permintaan sebelumnya mungkin sudah terkirim, jadi isian dikunci. Kirim ulang untuk melanjutkan, atau tutup untuk menarik permintaan dulu.",
    closeHeld:
      "Layar belum bisa ditutup: permintaan mungkin sudah terkirim. Saat koneksi kembali, permintaan dibatalkan dan layar ditutup. Coba tutup lagi setelah tersambung.",
    field: {
      valueRequired: "Isi nilai dengan angka rupiah, 0 atau lebih.",
      reasonCodeRequired: "Pilih kode alasan.",
      reasonRequired: "Tulis alasan, minimal 3 karakter.",
    },
  },

  pending: {
    title: "Menunggu persetujuan",
    body: "Minta supervisor membuka notifikasi di ponselnya lalu menyetujui atau menolak.",
    deadline: "Batas waktu: {time}",
    remaining: "Sisa {time}",
    cancel: "Berhenti menunggu",
    cancelError: "Permintaan belum bisa dibatalkan. Coba lagi sebentar.",
    settling:
      "Sudah disetujui, menunggu penyelesaian persetujuan berjenjang. Permintaan tidak bisa dibatalkan lagi; layar ini lanjut otomatis.",
    pollError: "Status belum bisa dibaca. Perangkat mencoba lagi otomatis.",
    live: "Menunggu keputusan supervisor",
  },

  outcome: {
    approved: {
      title: "Disetujui",
      body: "Supervisor menyetujui. Tindakan boleh dilanjutkan.",
    },
    rejected: {
      title: "Ditolak",
      body: "Supervisor menolak. Tindakan tidak dijalankan.",
      reasonPrefix: "Alasan supervisor: {reason}",
    },
    expired: {
      title: "Waktu habis",
      body: "Batas waktu persetujuan lewat dan tindakan tetap tertahan. Ajukan ulang bila masih perlu.",
    },
    cancelled: {
      title: "Permintaan dibatalkan",
      body: "Permintaan ini dibatalkan dan tidak dapat disetujui lagi.",
    },
    retry: "Ajukan ulang",
  },
} as const;
