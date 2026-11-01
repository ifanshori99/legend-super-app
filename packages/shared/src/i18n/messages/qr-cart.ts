// QR order journey texts, part: shared cart, checkout and payment step.
// Bead legend-8sh · PRD v1.7 §3 F10 "Menu & Keranjang", "Mode Bayar",
// "Estimasi Waktu Saji", "Login Opsional"; §3 F13 QRIS dinamis.
export const qrCartMessages = {
  cart: {
    title: "Keranjang meja",
    sharedHint: "Dilihat semua tamu di meja ini dan diperbarui otomatis.",
    itemCount: "{count} item",
    loading: "Memuat keranjang…",
    emptyTitle: "Keranjang masih kosong",
    emptyHint:
      "Pilih menu dari daftar. Tamu lain di meja ini juga bisa menambah ke keranjang yang sama.",
    toMenu: "Lihat menu",
    noSessionTitle: "Mulai sesi meja dulu",
    noSessionHint:
      "Isi jumlah tamu agar keranjang meja ini bisa dipakai bersama.",
    noSessionAction: "Mulai pesan",
    errorTitle: "Keranjang belum bisa dimuat",
    errorHint: "Periksa koneksi internet Anda, lalu coba lagi.",
    addedBy: {
      you: "Ditambahkan Anda",
      other: "Ditambahkan tamu lain",
    },
    note: "Catatan: {note}",
    lineTotal: "Total baris",
    decrease: "Kurangi jumlah {name}",
    increase: "Tambah jumlah {name}",
    remove: "Hapus",
    removeAria: "Hapus {name} dari keranjang",
    removed: "{name} dihapus dari keranjang",
    soldOut: "Habis",
    soldOutLine:
      "Menu ini baru saja habis dan akan dikeluarkan saat checkout. Hapus sekarang atau pilih menu lain.",
    subtotal: "Subtotal menu",
    subtotalHint: "Belum termasuk pajak dan service charge.",
    checkout: "Lanjut ke checkout",
    conflict:
      "Keranjang baru diubah tamu lain dan sudah diperbarui. Periksa lagi sebelum lanjut.",
    updateError: "Belum bisa mengubah keranjang. Coba lagi.",
    sessionEnded: "Sesi meja sudah berakhir. Buka sesi baru untuk memesan.",
    suggestionsTitle: "Tambah lagi?",
  },
  checkout: {
    title: "Checkout",
    backToCart: "Kembali ke keranjang",
    itemsTitle: "Pesanan Anda",
    modeTitle: "Cara bayar",
    modePayFirst: "Bayar di muka",
    modePayFirstHint: "Pesanan masuk dapur setelah pembayaran berhasil.",
    modeOpenBill: "Open bill",
    modeOpenBillHint:
      "Pesanan langsung masuk dapur dan dibayar di akhir. Tagihan bisa dibagi per orang.",
    awaitingTitle: "Menunggu konfirmasi waiter",
    awaitingHint:
      "Waiter belum mengonfirmasi meja ini. Pesanan bisa dikirim setelah meja dikonfirmasi, biasanya hanya beberapa menit.",
    estimateTitle: "Estimasi siap",
    estimate: "{min}–{max} menit",
    estimateNone: "Estimasi waktu akan tampil setelah dapur menghitung antrean.",
    estimateHint: "Dihitung dari antrean dapur saat ini.",
    breakdown: {
      title: "Rincian bayar",
      subtotal: "Subtotal menu",
      discount: "Diskon",
      service: "Service charge ({rate}%)",
      tax: "{name} ({rate}%)",
      rounding: "Pembulatan",
      total: "Total",
      excludedNote:
        "Harga menu belum termasuk pajak dan service charge. Keduanya sudah dihitung di total ini.",
      loading: "Menghitung total…",
    },
    code: {
      label: "Kode promo atau voucher",
      placeholder: "Contoh: LEG-7K2M-4QX9",
      hint: "Total dihitung ulang oleh sistem setelah kode dipakai.",
      apply: "Pakai kode",
      remove: "Lepas kode",
      applied: "Kode {code} dipakai",
      invalid:
        "Kode tidak valid atau sudah tidak berlaku. Periksa penulisannya atau coba kode lain.",
      toggle: "Punya kode promo atau voucher?",
    },
    removedTitle: "Ada menu yang habis",
    removedBody:
      "{names} baru saja habis dan dikeluarkan dari pesanan ini. Total di bawah sudah diperbarui.",
    priceChangedTitle: "Harga ada yang berubah",
    priceChangedBody: "{name}: dari {from} menjadi {to}.",
    minimumSpend:
      "Minimum belanja zona ini {required}. Tambah menu senilai {shortfall} lagi untuk memesan.",
    loginTitle: "Dapatkan poin untuk pesanan ini",
    loginHint:
      "Masuk atau daftar agar poin, favorit, dan pesan ulang tersimpan. Anda tetap bisa memesan sebagai tamu.",
    signIn: "Masuk",
    payFirstSubmit: "Bayar {total}",
    openBillSubmit: "Kirim pesanan ke dapur",
    placing: "Memproses pesanan…",
    sentToast: "Pesanan terkirim ke dapur",
    empty: "Keranjang kosong. Tambahkan menu dulu untuk checkout.",
    error: {
      generic: "Pesanan belum terkirim. Periksa koneksi, lalu coba lagi.",
      conflict:
        "Keranjang berubah sebelum pesanan dikirim. Periksa ringkasan di atas, lalu kirim lagi.",
      notConfirmed:
        "Waiter belum mengonfirmasi meja ini. Tunggu sebentar, lalu kirim lagi.",
      minimumSpend:
        "Pesanan belum mencapai minimum belanja zona ini. Tambah menu lalu coba lagi.",
      closed: "Sesi meja sudah berakhir. Buka sesi baru untuk memesan.",
      cartEmpty: "Semua menu di keranjang habis. Pilih menu lain.",
    },
  },
  pay: {
    title: "Pembayaran",
    amount: "Total bayar",
    qrisTitle: "Scan QRIS untuk membayar",
    qrisHint:
      "Buka aplikasi bank atau e-wallet, pilih Scan, lalu arahkan ke kode ini.",
    qrisAlt: "Kode QRIS untuk pembayaran {amount}",
    ewalletTitle: "Lanjutkan di e-wallet",
    ewalletHint: "Anda akan diarahkan ke aplikasi e-wallet untuk menyetujui.",
    ewalletOpen: "Buka e-wallet",
    expires: "Berlaku sampai {time}",
    waiting: "Menunggu pembayaran Anda…",
    waitingHint:
      "Halaman ini terbarui otomatis. Jangan tutup sampai pembayaran berhasil.",
    paidTitle: "Pembayaran berhasil",
    paidHint: "Pesanan Anda diteruskan ke dapur.",
    paidHintShare: "Bagian Anda sudah lunas. Terima kasih.",
    toOrders: "Lihat status pesanan",
    toBill: "Kembali ke tagihan",
    expiredTitle: "Kode pembayaran kedaluwarsa",
    expiredHint:
      "Belum ada pembayaran yang masuk. Buat kode baru untuk melanjutkan.",
    failedTitle: "Pembayaran gagal",
    failedHint:
      "Tidak ada uang yang terpotong dari pembayaran ini. Buat kode baru lalu coba lagi.",
    retry: "Buat kode baru",
    methodQris: "QRIS",
    methodEwallet: "E-wallet",
    loadingTitle: "Menyiapkan pembayaran…",
    errorTitle: "Pembayaran belum bisa dimuat",
    errorHint: "Periksa koneksi internet Anda, lalu coba lagi.",
    notFoundTitle: "Pembayaran tidak ditemukan",
    notFoundHint: "Kembali ke pesanan Anda untuk memulai pembayaran lagi.",
  },
} as const;
