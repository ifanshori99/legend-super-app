// Guest manage-reservation page text (bead legend-g12il).
// Request screens: detail, reschedule form, and the request status.
export const reservationGuestRequestMessages = {
  schedule: "{day}, {time} {zone}",
  guests: "{count} tamu",
  rows: {
    date: "Tanggal",
    time: "Jam",
    guests: "Jumlah tamu",
  },
  detail: {
    pillConfirmed: "Reservasi terkonfirmasi",
    pillPendingDeposit: "Menunggu pembayaran DP",
    title: "Kelola reservasi Anda",
    lead: "Periksa jadwal kunjungan atau ajukan perubahan ke outlet.",
    leadLate: "Periksa jadwal kunjungan Anda.",
    noteTitle: "Perlu mengubah rencana?",
    noteBody:
      "Permintaan jadwal baru perlu disetujui outlet. Jadwal saat ini tetap berlaku sampai permintaan disetujui.",
    pendingNoteTitle: "Permintaan jadwal baru sedang diperiksa outlet",
    pendingNoteBody:
      "Jadwal saat ini tetap berlaku sampai permintaan disetujui. Anda tidak perlu mengirim permintaan yang sama lagi.",
    policyTitle: "Ketentuan DP Anda",
    policyFree: "DP kembali penuh jika pembatalan dilakukan paling lambat",
    policyLate:
      "Setelah batas tersebut, ada potongan DP sesuai ketentuan saat Anda memesan. Rincian nominal ditampilkan sebelum pembatalan.",
    policyPassed:
      "Batas pembatalan dengan DP kembali penuh sudah lewat. Pembatalan sekarang dikenai potongan DP sesuai ketentuan saat Anda memesan. Rincian nominal ditampilkan sebelum Anda mengonfirmasi.",
    reschedule: "Ajukan jadwal baru",
    viewRequest: "Kembali ke status permintaan",
    cancel: "Batalkan reservasi",
  },
  reschedule: {
    pill: "Permintaan jadwal baru",
    title: "Kapan ingin datang?",
    lead: "Pilih tanggal dan jam yang Anda inginkan untuk {count} tamu.",
    panelTitle: "Jadwal yang diinginkan",
    dateLabel: "Tanggal baru",
    dateHint: "Pilih waktu setelah sekarang, maksimal 180 hari ke depan.",
    timeLegend: "Jam baru · {zone}",
    timeHint:
      "Pilihan jam ini belum menjamin meja tersedia. Outlet akan memeriksa permintaan Anda.",
    timeDatePrompt: "Pilih tanggal dulu untuk melihat pilihan jam.",
    timeLoading: "Memuat pilihan jam…",
    timeFallbackHint:
      "Pilih jam kunjungan. Outlet akan memeriksa ketersediaan meja sebelum menyetujui.",
    noteLabel: "Catatan untuk outlet",
    noteHint: "Maksimal 300 karakter.",
    infoTitle: "Menunggu persetujuan outlet",
    infoBody:
      "Jadwal awal dan DP tetap berlaku selama permintaan diperiksa. Jadwal baru berlaku setelah disetujui outlet.",
    submit: "Kirim permintaan",
    back: "Kembali ke detail",
  },
  validation: {
    pill: "Permintaan belum dikirim",
    title: "Periksa jadwal baru",
    lead: "Ganti tanggal atau jam sebelum mengirim permintaan.",
    leadPast:
      "Tanggal yang dipilih sudah lewat. Ganti tanggal sebelum mengirim permintaan.",
    titlePast: "Periksa tanggal baru",
    keep: "Reservasi awal Anda tetap berlaku: {schedule}, untuk {count} tamu.",
    missing_date: "Pilih tanggal baru.",
    missing_time: "Pilih jam baru.",
    past: "Tanggal ini sudah lewat. Pilih tanggal dan jam setelah waktu sekarang.",
    too_far: "Tanggal terlalu jauh. Pilih tanggal maksimal 180 hari ke depan.",
  },
  submitting: {
    pill: "Sedang mengirim",
    title: "Mengirim jadwal baru",
    lead: "Tunggu sebentar. Jangan kirim ulang agar permintaan tidak terkirim dua kali.",
    panelTitle: "Jadwal yang diajukan",
    status: "Permintaan sedang dikirim ke outlet.",
    keepTitle: "Jadwal awal tetap berlaku",
    keepBody: "{schedule}. DP Anda tidak berubah.",
    button: "Mengirim permintaan…",
  },
  submitError: {
    title: "Permintaan belum terkirim",
    invalid:
      "Tautan ini sudah tidak berlaku. Minta tautan baru ke outlet lewat pesan konfirmasi Anda.",
    rate_limited:
      "Terlalu banyak percobaan. Tunggu beberapa saat, lalu kirim lagi.",
    network:
      "Koneksi terputus. Periksa jaringan Anda, lalu kirim lagi. Permintaan tidak akan terkirim dua kali.",
    pending_exists:
      "Anda sudah punya permintaan jadwal yang sedang diperiksa. Buka kembali tautan ini untuk melihat statusnya.",
    invalid_input:
      "Jadwal ini tidak dapat diajukan. Pilih tanggal dan jam lain.",
    transition:
      "Reservasi ini tidak bisa diubah lagi. Buka kembali tautan ini untuk melihat status terbaru.",
    unknown: "Terjadi kendala. Coba kirim lagi sebentar lagi.",
  },
  status: {
    viewDetail: "Lihat detail reservasi",
    viewLatest: "Lihat detail terbaru",
    pending: {
      pill: "Menunggu persetujuan",
      title: "Permintaan sudah terkirim",
      lead: "Outlet akan memeriksa jadwal baru Anda. Jadwal reservasi belum berubah.",
      panelTitle: "Jadwal yang Anda minta",
      keepTitle: "Jadwal awal tetap berlaku",
      keepBody:
        "Jika belum ada persetujuan, reservasi Anda tetap pada {schedule}. DP yang sudah dibayar tidak berubah.",
      hint: "Buka kembali tautan ini untuk memeriksa status. Anda tidak perlu mengirim permintaan yang sama lagi.",
    },
    approved: {
      pill: "Disetujui outlet",
      title: "Jadwal baru sudah dikonfirmasi",
      lead: "Reservasi Anda pindah ke {schedule}.",
      depositTitle: "DP tetap tercatat",
      depositBody:
        "DP {amount} yang sudah Anda bayar tetap untuk reservasi ini. Tidak ada pembayaran DP baru dari perubahan jadwal ini.",
    },
    rejected: {
      pill: "Ditolak outlet",
      title: "Jadwal baru tidak disetujui",
      lead: "Permintaan untuk {schedule} tidak disetujui. Reservasi awal Anda tetap aktif.",
      noteTitle: "Jadwal dan DP tidak berubah",
      noteBody:
        "Anda masih bisa datang sesuai jadwal awal. Untuk membahas pilihan lain, balas pesan konfirmasi reservasi Anda.",
    },
  },
} as const;
