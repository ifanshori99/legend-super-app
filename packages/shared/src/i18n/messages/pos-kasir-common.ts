// POS cashier texts shared by every screen (bead legend-mjmm; PRD v1.7 §3 F8
// "Shift & Tutup Hari", §3 F11 "POS Kasir"): menu labels and the common bits
// of the shared components. One catalog file per screen group so the parallel
// screen beads never edit the same lines; id.ts imports it as `posKasirCommon`.
export const posKasirCommonMessages = {
  nav: {
    code: "Kode bayar",
    shift: "Shift kasir",
    dayClose: "Tutup hari",
  },
  bill: {
    unpaid: "Belum lunas",
    paid: "Lunas",
    summary: "Pesanan {orderNo} · {items} item · {guests} tamu",
    subtotal: "Subtotal",
    service: "Service",
    tax: "Pajak",
    total: "Total tagihan",
    depositUsed: "DP reservasi terpakai",
    depositPaid: "DP lunas · {reference}",
    depositUnpaid: "DP belum lunas · {reference}",
    confirmed: "{label} terkonfirmasi",
    remaining: "Sisa yang harus dibayar",
    remainingPaid: "Sisa bayar",
  },
  keypad: {
    backspace: "Hapus angka terakhir",
    quickAmounts: "Nominal cepat",
  },
  denomination: {
    other: "Pecahan lain & koin",
    otherHint: "Isi nominal gabungan",
  },
  pinDialog: {
    reasonLabel: "Alasan",
    reasonRequired: "Alasan wajib diisi.",
    reasonTooShort: "Alasan minimal {min} karakter.",
    pinLabel: "PIN supervisor",
    cancel: "Batal",
    checking: "Memeriksa PIN…",
  },
  // P2 (legend-wasr7.3): the printer of this tablet. Status is "dikirim ke
  // printer": the page never learns whether paper came out.
  printer: {
    label: "Printer tablet",
    open: "Ubah printer",
    title: "Printer tablet ini",
    description:
      "Hanya berlaku di tablet ini. Struk, tiket dapur, dan laporan shift dikirim ke printer ini.",
    methodLabel: "Cara cetak",
    paperLabel: "Lebar kertas",
    method: {
      rawbt: "RawBT",
      browser: "Browser",
      none: "Tanpa printer",
    },
    methodHint: {
      rawbt:
        "Untuk tablet Android dengan aplikasi RawBT. Printer Bluetooth, USB atau LAN dipasangkan di RawBT.",
      browser:
        "Membuka dialog cetak browser. Cocok untuk laptop, atau selama RawBT belum terpasang.",
      none: "Struk tidak dikirim ke printer. Simpan PDF struk untuk pelanggan.",
    },
    paper: {
      w32: "58 mm",
      w48: "80 mm",
    },
    summary: "{method} · {paper}",
    sentNote:
      "Struk dikirim ke printer. Bila kertas tidak keluar, periksa printer lalu cetak ulang.",
    save: "Simpan printer",
    cancel: "Batal",
    saved: "Printer disimpan: {summary}",
    sentTitle: "Struk {receiptNo} dikirim ke printer",
    print: "Cetak struk",
    reprint: "Cetak ulang",
    next: "Transaksi baru",
    notSent: {
      none: {
        title: "Struk {receiptNo} belum dikirim ke printer",
        body: "Tablet ini diatur tanpa printer. Ubah printer lalu cetak ulang, atau simpan PDF struk untuk pelanggan.",
      },
      failed: {
        title: "Struk {receiptNo} gagal dikirim ke printer",
        body: "RawBT atau dialog cetak tidak terbuka. Pastikan aplikasi RawBT terpasang atau pilih Browser, lalu cetak ulang.",
      },
    },
    // P3 (legend-wasr7.4): a kitchen ticket or a shift report from this tablet.
    cloud: {
      ticket: "Cetak tiket",
      ticketAgain: "Cetak ulang tiket",
      shift: "Cetak laporan shift",
      shiftAgain: "Cetak ulang laporan shift",
      sent: "Dikirim ke printer. Bila kertas tidak keluar, periksa printer lalu cetak ulang.",
      sentAgain: "Dikirim ulang ke printer. Kertasnya bertanda CETAK ULANG.",
      none: "Tablet ini diatur tanpa printer. Ubah printer lalu cetak.",
      failed:
        "RawBT atau dialog cetak tidak terbuka. Pastikan aplikasi RawBT terpasang atau pilih Browser, lalu cetak ulang.",
      loadFailed: "Cetakan belum bisa disiapkan. Coba lagi.",
    },
    testPrint: "Cetak tes",
    testSent: "Halaman tes dikirim ke printer. Periksa kertasnya.",
    testFailed:
      "Halaman tes gagal dikirim. Pastikan aplikasi RawBT terpasang atau pilih Browser.",
  },
};
