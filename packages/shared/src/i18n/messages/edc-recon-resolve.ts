// EDC reconciliation screen, resolve part (bead legend-khi8n). Own file so the
// parallel parts never edit the same catalog lines. Mounted under
// `edcRecon.resolve` by messages/id.ts. Amounts render with <Money>.
export const edcReconResolveMessages = {
  header: {
    age: "{minutes} menit",
    ageLabel: "Umur transaksi",
    context: "{outlet} · Kasir {cashier} · {time}",
    contextNoCashier: "{outlet} · {time}",
  },
  status: {
    unknown: "Unknown",
    approved: "Approved",
    declined: "Declined",
    pending: "Pending",
    cancelled: "Cancelled",
    failed: "Failed",
    waiting: "Menunggu terminal",
  },
  summary: {
    title: "Ringkasan & bukti",
    requestedAmount: "Nominal permintaan",
    remaining: "Sisa tagihan",
    bill: "Tagihan",
    terminal: "Terminal",
    none: "Tidak tercatat",
  },
  warning: {
    unknownTitle: "Hasil terminal belum diketahui",
    unknownBody:
      "Cocokkan struk atau hasil penelusuran bank. Jangan meminta pelanggan membayar ulang sebelum hasilnya jelas.",
    approvedTitle: "Terminal menyatakan approved",
    approvedBody:
      "Hasil tidak dapat diubah menjadi declined. Jika perlu membatalkan, lakukan void terminal melalui alur yang sesuai.",
    declinedTitle: "Terminal menyatakan declined",
    declinedBody:
      "Hasil tidak dapat diubah menjadi approved. Pastikan pelanggan tidak terpotong sebelum menutup pemeriksaan.",
    waitingTitle: "Respons terminal belum diterima",
    waitingBody:
      "Permintaan masih berlangsung. Jangan tetapkan hasil secara manual.",
  },
  receipt: {
    title: "Struk terminal",
    sample: "Dari data transaksi",
    amount: "Nominal permintaan",
    trace: "Trace",
    rrn: "RRN",
    approvalCode: "Kode persetujuan",
    card: "Kartu",
    result: "Status sistem",
    missing: "–",
    noteUnknown:
      "Status sistem masih unknown; cocokkan nominal dan trace sebelum menentukan hasil.",
    noteWaiting:
      "Struk belum tersedia selama terminal memproses. Bukti tidak dapat digunakan untuk melewati penguncian.",
  },
  trace: {
    summary: "Lihat jejak terminal",
    status: "Status",
    responseCode: "Kode respons",
    message: "Pesan terminal",
    inquiryCount: "Jumlah penelusuran",
    dispatchedAt: "Dikirim ke terminal",
    createdAt: "Dibuat",
    never: "Belum dikirim",
  },
  form: {
    title: "Tentukan hasil rekonsiliasi",
    intro:
      "Gunakan hasil yang dapat dibuktikan. Keputusan dan bukti akan dicatat.",
    outcomeLegend: "Hasil berdasarkan bukti",
    outcomeApproved: "Approved · Disetujui",
    outcomeDeclined: "Declined · Ditolak",
    outcomeLocked: "{outcome} tidak dapat ditetapkan untuk transaksi ini.",
    sourceLabel: "Sumber bukti",
    sourcePlaceholder: "Pilih sumber bukti",
    sourceInquiry: "Penelusuran terminal",
    sourceTerminalReceipt: "Struk terminal",
    sourceBankStatement: "Mutasi bank",
    amountLabel: "Nominal pada bukti (Rp)",
    amountHint: "Harus sama dengan nominal permintaan dan sisa tagihan.",
    approvalCodeLabel: "Kode persetujuan",
    rrnLabel: "RRN",
    noteLabel: "Catatan pemeriksaan",
    noteHint:
      "Wajib diisi, maksimal 500 karakter. Jangan masukkan nomor kartu.",
    noteCount: "{count} / 500",
    nextHint: "Konfirmasi dan verifikasi MFA pada langkah berikutnya.",
    review: "Tinjau penyelesaian",
    noteCounter: "Jumlah karakter catatan",
    statusChangedTitle: "Status transaksi berubah",
    statusChangedBody:
      "Hasil yang boleh dipilih sudah dihitung ulang. Isian Anda tetap tersimpan; periksa lagi sebelum melanjutkan.",
  },
  errors: {
    outcomeRequired: "Pilih hasil rekonsiliasi.",
    sourceRequired: "Pilih sumber bukti.",
    amountRequired: "Isi nominal yang tercetak pada bukti.",
    amountInvalid: "Nominal hanya boleh berisi angka.",
    amountMismatch:
      "Nominal tidak sama dengan nominal permintaan. Periksa kembali angka pada bukti.",
    outcomeUnavailable:
      "Hasil yang dipilih tidak lagi dapat ditetapkan. Pilih hasil lain.",
    approvalCodeInvalid: "Kode persetujuan 1–12 huruf atau angka.",
    rrnInvalid: "RRN 1–24 huruf atau angka, bukan nomor kartu.",
    noteRequired: "Catatan pemeriksaan wajib diisi.",
    noteTooLong: "Catatan maksimal 500 karakter.",
    noteCardNumber: "Catatan tidak boleh memuat nomor kartu.",
    summary: "Periksa isian yang ditandai sebelum melanjutkan.",
  },
  gate: {
    wireOpenTitle: "Terminal masih memproses transaksi ini",
    wireOpenBody:
      "Rekonsiliasi belum dapat diselesaikan. Tunggu hasil terminal, lalu muat ulang. Tagihan tetap terkunci.",
    tooEarlyTitle: "Bisa diperiksa pukul {time}",
    tooEarlyBody:
      "Terminal masih mungkin mengirim jawaban. Penyelesaian dikunci sampai 10 menit setelah permintaan dikirim.",
    notEligibleTitle: "Transaksi ini tidak menunggu rekonsiliasi",
    notEligibleBody:
      "Transaksi sudah diselesaikan atau bukan penjualan. Tidak ada yang perlu ditetapkan.",
    locked: "Penyelesaian terkunci",
  },
  dialog: {
    title: "Konfirmasi rekonsiliasi",
    description: "Pastikan transaksi dan bukti sudah sesuai.",
    summaryHeading: "Ringkasan penyelesaian",
    result: "Hasil",
    evidence: "Bukti",
    evidenceLine: "{source} · Trace {trace}",
    note: "Catatan",
    chargedAmount: "Nominal pada bukti",
    notice:
      "Keputusan rekonsiliasi tidak langsung melunasi tagihan. Pencatatan pembayaran mengikuti proses kasir.",
    confirmCheck:
      "Saya telah memeriksa bukti, nominal, dan transaksi yang akan diselesaikan.",
    back: "Kembali periksa",
    submitApproved: "Selesaikan approved",
    submitDeclined: "Selesaikan declined",
    submitting: "Menyimpan…",
    close: "Tutup",
    done: "Selesai",
    reload: "Muat ulang daftar",
    reloading: "Memuat ulang…",
  },
  verify: {
    title: "Verifikasi identitas",
    mfaHint:
      "Penyelesaian rekonsiliasi meminta kode dari aplikasi autentikator Anda sebelum disimpan.",
  },
  success: {
    title: "Rekonsiliasi diselesaikan",
    body: "Hasil terminal tercatat. Pencatatan pembayaran mengikuti proses kasir; tagihan belum otomatis lunas.",
  },
  error: {
    network:
      "Penyelesaian belum dapat dipastikan. Periksa status terbaru sebelum mengirim ulang.",
    conflict:
      "Transaksi tidak dapat diselesaikan sekarang: {message} Periksa status terbaru, lalu coba lagi.",
    amountMismatch:
      "Nominal tidak sama dengan permintaan atau tagihan sudah berubah. Periksa ulang bukti dan status tagihan.",
    forbidden:
      "Akun ini tidak memiliki izin rekonsiliasi di outlet transaksi ini.",
    generic:
      "Penyelesaian belum berhasil disimpan. Periksa isian, lalu coba lagi.",
  },
  outcomeWord: {
    approved: "Approved · Disetujui",
    declined: "Declined · Ditolak",
  },
} as const;
