// WS-10 payout step receipt (legend-7gghu): the notification the worker sends
// to the person whose login attested a payout step. No amount, name or account
// number: the batch total is sealed and the text must not leak it.
export const payrollPayoutReceiptMessages = {
  title: "Langkah pencairan gaji atas nama Anda",
  body: "Anda {verb} {kind} untuk batch gaji periode {period} ({count} item) pada {time} WIB. Bukan Anda? Segera hubungi pemilik usaha dan ganti kata sandi.",
  verb: {
    propose: "mengusulkan",
    approve: "menyetujui",
    record: "mencatat",
    confirm: "mengonfirmasi",
    withdraw: "membatalkan",
  },
  kind: {
    correction: "koreksi gaji",
    overpaid: "pencatatan kelebihan bayar",
    return: "pengembalian dana",
    return_withdraw: "penarikan klaim return",
    posting_source: "pengisian sumber jurnal",
    closure: "penutupan bukti",
    resolve: "penyelesaian transfer",
    bank_confirm: "konfirmasi bank",
    batch_approve: "persetujuan utama batch",
  },
  // "Not me" screen (legend-l2zru): reached from the receipt notification.
  disown: {
    title: "Langkah pencairan gaji atas nama Anda",
    summary:
      "Anda {verb} {kind} untuk batch gaji periode {period} ({count} item) pada {time} WIB.",
    question: "Apakah langkah ini memang Anda lakukan?",
    yes: "Ya, ini saya",
    no: "Bukan saya",
    warning:
      "Bila bukan Anda, pencairan ini dibekukan sampai pemilik usaha atau finance memeriksanya. Tidak ada gaji yang dibayar selama beku.",
    reasonLabel: "Catatan (boleh dikosongkan)",
    reasonHint: "Maksimal 500 karakter. Jangan tulis kata sandi.",
    confirm: "Bekukan pencairan",
    confirming: "Membekukan…",
    cancel: "Kembali",
    passwordLabel: "Kata sandi akun Anda",
    done: "Pencairan dibekukan. Pemilik usaha dan finance sudah diberi tahu. Segera ganti kata sandi Anda.",
    alreadyDone:
      "Anda sudah menyatakan langkah ini bukan Anda. Pencairan dibekukan sampai diperiksa.",
    notFound: "Langkah ini tidak ditemukan atau bukan atas nama Anda.",
    loadError: "Langkah ini belum bisa dimuat. Periksa koneksi lalu coba lagi.",
    error: {
      generic: "Pembekuan gagal. Coba lagi atau hubungi pemilik usaha.",
      refused:
        "Pembekuan ditolak. Akun Anda tidak aktif atau sesi Anda sudah berakhir. Hubungi pemilik usaha.",
    },
  },
  // Notification sent when a batch gets frozen or released. No amount.
  frozen: {
    title: "Pencairan gaji dibekukan",
    body: "Pencairan gaji periode {period} dibekukan karena ada yang menyatakan langkah atas namanya bukan dilakukan olehnya. Periksa di halaman Pencairan gaji.",
  },
  unfrozen: {
    title: "Pembekuan pencairan gaji dibuka",
    body: "Pembekuan pencairan gaji periode {period} dibuka pada {time} WIB. Alasan pembukaan tercatat.",
  },
} as const;
