// Guest manage-reservation page text (bead legend-g12il).
// Part C2: late, cancel, cancelled, and recovery screens
// (design/mockups/reservation-guest, states-decision.js and states-recovery.js).
export const reservationGuestCancelMessages = {
  late: {
    pill: "Batas ubah jadwal terlewati",
    title: "Jadwal sudah tidak bisa diubah",
    lead: "Batas pengembalian DP penuh sudah lewat. Perubahan jadwal tidak dapat disetujui setelah batas ini.",
    noteTitle: "Batasnya {day}",
    noteBody:
      "Pukul {time}, sesuai ketentuan saat Anda memesan. Reservasi awal Anda masih aktif.",
    noteTitleNoDeadline: "Batas waktu sudah lewat",
    noteBodyNoDeadline:
      "Sesuai ketentuan saat Anda memesan. Reservasi awal Anda masih aktif.",
    cancelHeading: "Jika Anda memilih batal sekarang",
    cancelBody:
      "Sebagian DP dipotong sebagai penalti pembatalan sesuai ketentuan saat Anda memesan.",
    cancelHint:
      "Jumlah pengembalian diperiksa kembali sebelum pembatalan dikonfirmasi. Uang belum dikembalikan dari halaman ini.",
    keep: "Tetap pada jadwal awal",
    review: "Tinjau pembatalan",
  },
  cancel: {
    pillFree: "Konfirmasi diperlukan",
    pillLate: "Batas pengembalian penuh sudah lewat",
    title: "Batalkan reservasi?",
    leadFree: "Periksa rincian DP sebelum membatalkan kunjungan Anda.",
    leadLate: "Sebagian DP akan dipotong sesuai kebijakan saat Anda memesan.",
    breakdownTitle: "Rincian DP",
    noteFreeTitle: "DP dapat dikembalikan penuh",
    noteFreeBody:
      "Batas pengembalian penuh: {day} pukul {time}. Ketentuan ini mengikuti kebijakan saat Anda memesan.",
    noteFreeBodyNoDeadline:
      "Ketentuan ini mengikuti kebijakan saat Anda memesan.",
    noteLateTitle: "Periksa potongan sebelum melanjutkan",
    noteLateBody:
      "Batas pengembalian penuh adalah {day} pukul {time}. Jika dibatalkan sekarang, {forfeit} dari DP Anda tidak dikembalikan.",
    noteLateBodyNoDeadline:
      "Jika dibatalkan sekarang, {forfeit} dari DP Anda tidak dikembalikan.",
    noteNothingPaidTitle: "Tidak ada DP yang dibayar",
    noteNothingPaidBody:
      "Pembatalan tidak mengubah apa pun pada pembayaran Anda.",
    notAllowedTitle: "Reservasi ini tidak bisa dibatalkan",
    notAllowedBody:
      "Reservasi sudah tidak bisa dibatalkan dari halaman ini. Balas pesan konfirmasi reservasi untuk meminta bantuan.",
    reasonLabel: "Alasan pembatalan",
    reasonPlaceholder: "Tuliskan alasan Anda",
    reasonHint: "Maksimal {max} karakter.",
    irreversible:
      "Setelah dibatalkan, reservasi ini tidak dapat digunakan. Pengembalian DP diproses terpisah dan belum tentu langsung masuk.",
    confirmFree: "Ya, batalkan reservasi",
    confirmLate: "Batalkan dengan potongan {forfeit}",
    submitting: "Membatalkan reservasi…",
    keep: "Tetap gunakan reservasi",
    back: "Kembali",
    errorTitle: "Pembatalan belum berhasil",
    errorNetwork:
      "Koneksi terputus. Periksa internet Anda, lalu coba lagi. Isi yang sama tidak akan dibatalkan dua kali.",
    errorRateLimited:
      "Permintaan dibatasi sementara. Tunggu sebentar, lalu coba lagi.",
    errorTransition:
      "Reservasi ini sudah tidak bisa dibatalkan. Muat ulang halaman untuk melihat status terbaru.",
    errorUnknown:
      "Terjadi kendala. Muat ulang status sebelum mencoba lagi agar tidak mengirim dua kali.",
  },
  cancelled: {
    pill: "Reservasi dibatalkan",
    title: "Reservasi Anda dibatalkan",
    lead: "Kunjungan {day} pukul {time} untuk {party} tamu sudah dibatalkan.",
    breakdownTitle: "Rincian DP",
    refundPendingTitle: "Pengembalian DP belum selesai",
    refundOnlyBody:
      "Nominal yang dikembalikan adalah {refund}. Status pembatalan tidak berarti uang sudah masuk. Periksa kembali status pengembalian melalui halaman ini.",
    refundAndForfeitBody:
      "{refund} dikembalikan dan {forfeit} dipotong sesuai kebijakan saat pemesanan. Status pembatalan tidak berarti uang sudah masuk.",
    forfeitOnlyTitle: "DP tidak dikembalikan",
    forfeitOnlyBody:
      "{forfeit} dipotong sesuai kebijakan saat pemesanan, sehingga tidak ada pengembalian.",
    help: "Jika memerlukan bantuan, balas pesan konfirmasi reservasi yang Anda terima.",
    checkRefund: "Periksa status pengembalian",
    refundChecked: "Status diperbarui pukul {time}",
    refundUnchanged: "Belum ada perubahan",
    refundCheckError:
      "Status pengembalian belum bisa diperiksa. Coba lagi sebentar lagi.",
  },
  closed: {
    seatedPill: "Sedang berlangsung",
    seatedTitle: "Reservasi sedang berjalan",
    seatedLead:
      "Kunjungan ini sudah dimulai, jadi tidak bisa diubah atau dibatalkan dari halaman ini.",
    completedPill: "Selesai",
    completedTitle: "Kunjungan selesai",
    completedLead:
      "Terima kasih sudah berkunjung. Reservasi ini tidak bisa diubah lagi.",
    noShowPill: "Tidak hadir",
    noShowTitle: "Reservasi sudah ditutup",
    noShowLead:
      "Reservasi ini ditandai tidak hadir dan tidak bisa diubah lagi.",
    otherPill: "Reservasi ditutup",
    otherTitle: "Reservasi sudah ditutup",
    otherLead: "Reservasi ini tidak bisa diubah lagi dari halaman ini.",
    help: "Jika memerlukan bantuan, balas pesan konfirmasi reservasi yang Anda terima.",
  },
  invalid: {
    pill: "Tautan tidak berlaku",
    title: "Reservasi belum bisa dibuka",
    lead: "Tautan ini mungkin sudah kedaluwarsa atau tidak lagi berlaku.",
    howHeading: "Cara membuka reservasi Anda",
    step1: "Buka kembali pesan konfirmasi atau pengingat reservasi.",
    step2: "Gunakan tautan kelola reservasi terbaru dari pesan tersebut.",
    step3: "Jika masih gagal, balas pesan konfirmasi untuk meminta bantuan.",
    privacy:
      "Detail reservasi tidak ditampilkan melalui tautan yang tidak berlaku.",
  },
  loading: {
    title: "Memuat reservasi Anda",
    lead: "Sedang memeriksa rincian dan status terbaru.",
  },
  error: {
    pill: "Belum bisa terhubung",
    title: "Status belum bisa dimuat",
    lead: "Periksa koneksi internet Anda, lalu coba lagi.",
    noteTitle: "Periksa status sebelum mengirim ulang",
    noteBody:
      "Jika tadi Anda meminta jadwal baru atau membatalkan reservasi, muat ulang statusnya dahulu agar tidak mengirim permintaan dua kali.",
    retry: "Muat ulang status",
    help: "Jika masih gagal, balas pesan konfirmasi reservasi untuk meminta bantuan.",
  },
  rateLimit: {
    pill: "Coba lagi sebentar",
    title: "Terlalu banyak percobaan",
    lead: "Permintaan dibatasi sementara. Tunggu sebentar sebelum memeriksa kembali.",
    noteTitle: "Tidak perlu mengirim berulang kali",
    noteBody:
      "Setelah jeda selesai, periksa status terbaru sebelum mencoba tindakan yang sama lagi.",
    retry: "Periksa status kembali",
    help: "Jika Anda memerlukan bantuan, balas pesan konfirmasi reservasi.",
  },
} as const;
