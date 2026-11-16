// Finance exceptions list (legend-4oclu).
// Own file so parallel beads never edit the same catalog lines.
export const financeExceptionsMessages = {
  tab: "Pengecualian finance",
  title: "Pengecualian finance",
  subtitle:
    "Periksa transaksi edge dan biaya pencairan gaji yang belum tercatat lengkap.",
  readOnly: "Hanya baca",
  kinds: {
    edge_tax_unsnapshotted: "Pajak edge belum tersnapshot",
    edge_void_unsupported: "Void edge tidak didukung",
    edge_receipt_skipped: "Struk edge dilewati",
    edge_link_dead_letter: "Link edge dead-letter",
    payout_fee_not_posted: "Biaya payout belum dijurnal",
    receipt_pending_stale: "Jurnal penjualan menunggu struk lebih dari 1 hari",
    payout_proof_stuck: "Bukti payout tertahan pemeriksaan",
    payout_recon_flag: "Selisih rekonsiliasi payout",
    release_recon_unproven:
      "Kode QRIS/VA yang dilepas belum terbukti mati lebih dari 3 hari",
    payout_batch_disputed: "Pencairan dibekukan (bukan saya)",
  },
  kindHelp: {
    edge_tax_unsnapshotted:
      "Order dari edge punya pajak, tetapi snapshot pajaknya belum tercatat. Laporan pajak bisa kurang.",
    edge_void_unsupported:
      "Pembatalan dari edge belum bisa dijurnal otomatis. Jurnal pembalik perlu diperiksa manual.",
    edge_receipt_skipped:
      "Struk dari edge dilewati saat sinkronisasi, jadi order ini belum lengkap di pusat.",
    edge_link_dead_letter:
      "Tautan kejadian edge gagal diproses berulang kali dan berhenti di antrean gagal.",
    payout_fee_not_posted:
      "Biaya transfer pencairan gaji belum masuk jurnal. Berlaku untuk seluruh PT.",
    receipt_pending_stale:
      "Jurnal otomatis tertahan karena pembayaran gateway belum dijurnal lebih dari 1 hari. Tidak mengikuti rentang tanggal; cek status pengiriman pembayaran di bawah.",
    payout_proof_stuck:
      "Bukti bank pencairan gaji belum bisa diperiksa: berkasnya tidak terbaca atau sama dengan bukti lain. Pengembalian dengan bukti baru tetap ditahan. Berlaku untuk seluruh PT dan tidak mengikuti rentang tanggal.",
    payout_recon_flag:
      "Pemeriksaan malam menemukan langkah koreksi, pembayaran ganda, pengembalian, atau akun sumber pencairan gaji yang tidak cocok dengan catatan dua orang, bukti, atau jurnalnya. Slip terkait ditahan dari pencairan ulang. Berlaku untuk seluruh PT dan tidak mengikuti rentang tanggal.",
    release_recon_unproven:
      "Kode QRIS atau VA yang dilepas manual masih belum dijawab final oleh penyedia setelah lebih dari 3 hari. Antrean terus bertanya tiap hari dan tidak menutup baris tanpa bukti, jadi uang masih bisa masuk ke kode ini. Tidak mengikuti rentang tanggal.",
    payout_batch_disputed:
      "Seseorang menyatakan langkah pencairan gaji atas namanya bukan dilakukan olehnya, jadi pencairan itu dibekukan. Selama beku, tidak ada langkah baru yang bisa dilakukan. Bila pencairan sudah dikirim ke bank, periksa mutasi bank. Berlaku untuk seluruh PT dan tampil sampai pembekuan dibuka.",
  },
  refTypes: {
    order: "Order edge",
    auto_journal: "Jurnal otomatis",
    receipt_skip: "Struk dilewati",
    link_event: "Kejadian tautan",
    payout_posting: "Jurnal pencairan gaji",
    payout_proof: "Bukti pencairan gaji",
    payout_recon: "Rekonsiliasi pencairan gaji",
    qris_release_recon: "Antrean cek QRIS dilepas",
    va_release_recon: "Antrean cek VA dilepas",
    payout_batch_dispute: "Sengketa pencairan gaji",
  },
  refTypeUnknown: "Sumber lain",
  details: {
    tax_missing: "Pajak tidak ada pada data edge.",
    tax_mismatch: "Pajak pada data edge tidak cocok dengan total order.",
    batchPrefix: "Batch pencairan",
    disputedBatchStatusAt: "Status pencairan saat dibekukan: {status}",
    proofUnreadable: "Berkas bukti tidak terbaca di penyimpanan.",
    proofHashConflict: "Isi berkas sama dengan bukti lain yang sudah dipakai.",
    proofLegacyDuplicate:
      "Bukti lama ini sudah dipakai operasi lain; langkah berikutnya ditolak.",
    proofSharedKey:
      "Bukti ini dipakai lebih dari satu operasi; semua langkah dengan berkas ini ditolak sampai finance menutupnya.",
    proofBindFailed:
      "Bukti lama ini belum bisa dikaitkan ke operasinya; dicoba lagi otomatis dan gerbang bukti tetap menahan.",
    receiptOrder: "Order",
    receiptIntent: "Tagihan pembayaran",
    receiptOutbox: "Status pembayaran lunas",
    receiptNone: "Tidak ada",
    outbox: {
      pending: "Menunggu diproses",
      dead_lettered: "Gagal diproses berulang (antrean gagal)",
      delivered: "Sudah terkirim, jurnal belum terbit",
      missing: "Tidak ditemukan",
    },
  },
  filters: {
    label: "Filter pengecualian",
    kind: "Jenis pengecualian",
    kindAll: "Semua jenis",
    outlet: "Outlet",
    outletAll: "Semua outlet",
    outletLoading: "Memuat outlet",
    from: "Dari tanggal",
    to: "Sampai tanggal",
    hint: "Tanggal bisnis · Maksimal {days} hari",
    apply: "Terapkan filter",
    reset: "Atur ulang",
    errors: {
      required: "Isi tanggal awal dan akhir.",
      order: "Tanggal akhir tidak boleh sebelum tanggal awal.",
      span: "Rentang tanggal paling lama {days} hari.",
    },
  },
  payoutNote:
    "Biaya payout berlaku untuk seluruh PT dan tampil saat filter outlet menggunakan “Semua outlet”.",
  summary: {
    title: "Ringkasan per jenis",
    hint: "Jumlah kejadian dan nilai yang tersedia. Nilai antarjenis bukan total kewajiban atau kerugian.",
    selectHint: "Pilih satu jenis untuk menyaring daftar.",
    countUnit: "kejadian",
    noEvents: "Tidak ada kejadian",
    unavailable: "Tidak tersedia",
    partial: "dari nilai yang tersedia",
    notForOutlet: "Tidak dihitung untuk filter outlet",
    payoutScope: "Hanya tampil untuk akses seluruh PT",
    errorTitle: "Ringkasan belum dapat dimuat",
  },
  list: {
    title: "Daftar pengecualian",
    hint: "Terbaru lebih dulu · Tanggal bisnis mengikuti outlet",
    count: "{count} kejadian",
    columns: {
      time: "Waktu",
      kind: "Jenis & referensi",
      outlet: "Outlet",
      amount: "Nilai rupiah",
    },
    wholeEntity: "Seluruh PT",
    unknownOutlet: "Outlet tidak dikenal",
    amountUnavailable: "Tidak tersedia",
    allShown:
      "Semua hasil pada filter ini ditampilkan. Maksimal 500 kejadian terbaru per pencarian; ringkasan tetap menghitung seluruh hasil.",
    truncated:
      "Menampilkan 500 kejadian terbaru dari {total}. Persempit tanggal, jenis, atau outlet untuk melihat sisanya. Ringkasan menghitung seluruh hasil.",
    refSource: "Sumber",
    refId: "Nomor referensi",
    refDetail: "Keterangan",
    refOpen: "Lihat rincian {ref}",
    wib: "WIB",
  },
  states: {
    loadingTitle: "Memuat pengecualian finance",
    loadingHint: "Mohon tunggu sebentar.",
    emptyTitle: "Tidak ada pengecualian pada filter ini",
    emptyHint:
      "Tidak ada kejadian pada rentang dan filter yang dipilih. Hasil ini hanya berlaku untuk filter yang aktif.",
    errorTitle: "Pengecualian finance belum dapat dimuat",
    errorHint:
      "Ringkasan dan daftar tidak ditampilkan sebagai nol. Periksa koneksi lalu coba lagi.",
    retry: "Coba lagi",
    invalidTitle: "Filter belum valid",
    invalidHint:
      "Perbaiki tanggal pada filter, lalu terapkan agar data dimuat.",
  },
} as const;
