// QR order journey texts, part: recovery (legend-tz1). Failed item recovery
// (PRD §3 F10, ORD-08) and the post-meal review. ORD-08: the guest is only
// offered "Ganti menu" or "Kredit ke voucher"; no text here may offer
// anything else.
export const qrRecoveryMessages = {
  prompt: {
    one: "Maaf, {item} belum bisa kami siapkan",
    many: "{count} item belum bisa kami siapkan",
    action: "Pilih solusi",
  },
  issue: {
    title: "Item belum bisa disiapkan",
    apology: "Mohon maaf atas hal ini. Pilih salah satu solusi di bawah.",
    itemLine: "{name} x {quantity}",
    reason: {
      unfulfillable: "Dapur tidak dapat menyiapkan item ini saat ini.",
      remake: "Item ini perlu dibuat ulang, jadi belum bisa kami sajikan.",
      comp: "Tim kami menangani item ini secara khusus.",
      complaint:
        "Kami menerima catatan tentang item ini dan sedang menindaklanjutinya.",
    },
    choices: {
      label: "Pilih solusi",
      swap: {
        title: "Ganti menu",
        hint: "Pilih menu lain. Selisih harga dibayar atau dikreditkan.",
        listLabel: "Menu pengganti",
        unavailable: "Belum ada menu pengganti yang tersedia untuk item ini.",
        diffPay: "Bayar selisih",
        diffCredit: "Dikreditkan",
        diffEven: "Tanpa selisih",
      },
      voucher: {
        title: "Kredit ke voucher",
        value: "Nilai voucher",
        hint: "Dipakai di pesanan berikutnya",
        unavailable: "Voucher belum tersedia untuk item ini.",
      },
      pickHint:
        "Pilih satu solusi. Untuk ganti menu, pilih juga menu penggantinya.",
      confirm: "Konfirmasi pilihan",
    },
    confirmDialog: {
      title: "Ganti dengan {name}?",
      body: "Selisih harga ini akan masuk ke tagihan Anda dan perlu dibayar:",
      action: "Ya, ganti menu",
    },
    saved: "Pilihan Anda sudah kami catat.",
    resolved: {
      swapTitle: "Diganti dengan {name}",
      payBill: "Bayar selisih di tagihan",
      cancelled:
        "Pemberitahuan ini sudah tidak berlaku. Tidak ada yang perlu Anda lakukan.",
      byStaff: "Sudah diselesaikan oleh tim kami",
    },
    errors: {
      conflict: "Pilihan sudah berubah. Muat ulang halaman ini.",
      reload: "Muat ulang",
      notAllowed: "Pilihan ini sudah tidak tersedia. Pilih solusi lain.",
      network: "Tidak ada koneksi. Periksa sinyal Anda lalu coba lagi.",
      generic: "Pilihan belum tersimpan. Coba lagi sebentar lagi.",
    },
    notFound: {
      title: "Pemberitahuan tidak ditemukan",
      hint: "Mungkin sudah selesai ditangani. Lihat daftar pesanan Anda.",
      action: "Lihat pesanan",
    },
    error: {
      title: "Pemberitahuan belum bisa dimuat",
      hint: "Periksa koneksi Anda lalu coba lagi.",
    },
    offline:
      "Anda sedang offline. Pilihan baru bisa dikirim setelah tersambung kembali.",
    notJoined: {
      title: "Gabung ke meja dulu",
      hint: "Gabung ke meja ini untuk melihat dan menanggapi pemberitahuan pesanan Anda.",
      action: "Gabung meja",
    },
  },
  voucher: {
    title: "Voucher permintaan maaf",
    code: "Kode voucher",
    copy: "Salin kode",
    copied: "Kode sudah disalin",
    copyFailed:
      "Kode belum bisa disalin. Tekan lama kode di atas, lalu pilih salin.",
    value: "Nilai voucher",
    expires: "Berlaku sampai",
    hint: "Berlaku untuk pesanan berikutnya di sini",
  },
  review: {
    title: "Bagaimana kunjungan Anda?",
    hint: "Masukan Anda membantu kami menjadi lebih baik.",
    notEligible: {
      title: "Ulasan dibuka setelah tagihan lunas",
      hint: "Selesaikan pembayaran dulu, lalu kembali ke sini.",
      action: "Lihat tagihan",
    },
    already: {
      title: "Ulasan Anda sudah kami terima",
      hint: "Terima kasih sudah meluangkan waktu.",
    },
    rating: {
      label: "Penilaian",
      star: "{value} dari 5 bintang",
      chosen: "Penilaian Anda: {value} dari 5",
      none: "Belum memilih penilaian",
      required: "Pilih penilaian 1 sampai 5 bintang sebelum mengirim.",
    },
    comment: {
      label: "Komentar",
      hint: "Ceritakan yang Anda suka atau yang bisa kami perbaiki.",
      placeholder: "Tulis di sini",
      counter: "{count} dari {max} karakter",
    },
    submit: "Kirim ulasan",
    thanks: {
      title: "Terima kasih atas ulasan Anda",
      high: "Senang Anda menikmati kunjungan ini.",
      low: "Terima kasih, masukan Anda kami baca",
      google: "Tulis ulasan di Google",
      googleHint: "Ulasan di Google membantu tamu lain menemukan kami.",
    },
    errors: {
      conflict: "Ulasan untuk kunjungan ini sudah ada. Muat ulang halaman ini.",
      reload: "Muat ulang",
      notEligible: "Ulasan belum bisa dikirim. Pastikan tagihan sudah lunas.",
      network: "Tidak ada koneksi. Periksa sinyal Anda lalu coba lagi.",
      generic: "Ulasan belum terkirim. Coba lagi sebentar lagi.",
    },
    error: {
      title: "Halaman ulasan belum bisa dimuat",
      hint: "Periksa koneksi Anda lalu coba lagi.",
    },
    offline:
      "Anda sedang offline. Ulasan bisa dikirim setelah tersambung kembali.",
    notJoined: {
      title: "Gabung ke meja dulu",
      hint: "Gabung ke meja ini untuk memberi ulasan.",
      action: "Gabung meja",
    },
  },
} as const;
