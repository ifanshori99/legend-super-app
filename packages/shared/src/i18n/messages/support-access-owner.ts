// 539-U4 (legend-ydf2 / legend-8r77t). Own file so parallel screens never edit the same catalog lines.
// Owner screen for read_write support access requests (/kelola/akses-dukungan/permintaan).
export const supportAccessOwnerMessages = {
  title: "Permintaan akses dukungan",
  description: "Tinjau akses sementara ke data organisasi Anda.",
  loading: "Memuat permintaan akses dukungan",
  status: {
    pending: "Menunggu",
    approved: "Disetujui",
    rejected: "Ditolak",
    expired: "Kedaluwarsa",
  },
  pending: {
    sectionTitle: "Menunggu keputusan",
    cardTitle: "Permintaan akses dukungan",
    received: "Diterima {time}",
    requestedBy: "Diminta oleh",
    requesterFallback: "Tim dukungan",
    requester: "Tim dukungan · {id}",
    reason: "Alasan",
    scope: "Cakupan akses",
    scopeValue: "Baca dan ubah data organisasi",
    scopeNote: "Akses ini memungkinkan perubahan, bukan hanya melihat data.",
    duration: "Durasi akses",
    durationValue: "{minutes} menit (diminta)",
    deadline: "Batas keputusan",
    deadlineNote: "Permintaan kedaluwarsa setelah 24 jam.",
    consent:
      "Persetujuan hanya untuk permintaan ini. Aktivitas dicatat dan akses dapat dicabut sebelum waktunya berakhir.",
    approve: "Setujui akses",
    approving: "Menyetujui...",
    confirmTitle: "Setujui akses baca dan ubah?",
    confirmBody:
      "Tim dukungan dapat mengubah data organisasi Anda selama {minutes} menit setelah Anda menyetujui. Aktivitas dicatat di log audit dan Anda dapat mencabut akses kapan saja.",
    confirmAction: "Ya, setujui akses",
    cancel: "Batal",
    reject: "Tolak",
    rejectConfirmTitle: "Tolak akses?",
    rejectConfirmBody:
      "Tim dukungan tidak akan memperoleh akses dari permintaan ini. Keputusan tercatat di log audit dan tidak dapat dibatalkan.",
    rejectConfirmAction: "Ya, tolak akses",
    rejecting: "Menolak...",
    ownerOnly:
      "Hanya owner yang dapat memutuskan, setelah verifikasi dua langkah dan tanpa sesi penyamaran.",
  },
  guide: {
    title: "Sebelum memutuskan",
    body: "Pastikan Anda mengenali peminta dan alasan aksesnya. Tim dukungan dapat mengubah data selama akses aktif.",
    auditLabel: "Akses tercatat",
    auditValue: "Aktivitas tersedia di log audit.",
    controlLabel: "Anda memegang kendali",
    controlValue: "Cabut akses kapan saja.",
  },
  active: {
    title: "Akses aktif",
    approvedAt: "Disetujui {time}",
    holder: "Pemegang akses",
    scope: "Cakupan",
    endsAt: "Berakhir",
    remaining: "Sisa waktu",
    revoke: "Cabut akses",
    revokeNote: "Pencabutan menghentikan akses sebelum waktu berakhir.",
  },
  revoke: {
    title: "Cabut akses dukungan?",
    body: "Akses tim dukungan untuk membaca dan mengubah data organisasi akan segera berakhir.",
    cancel: "Batal",
    confirm: "Ya, cabut akses",
    confirming: "Mencabut...",
  },
  notice: {
    approvedTitle: "Akses disetujui.",
    approvedBody: "Tim dukungan dapat bekerja selama waktu yang ditentukan.",
    rejectedTitle: "Permintaan ditolak.",
    rejectedBody: "Tim dukungan tidak memperoleh akses dari permintaan ini.",
    revokedTitle: "Akses dicabut.",
    revokedBody: "Tim dukungan tidak lagi dapat mengakses data organisasi.",
  },
  history: {
    title: "Riwayat permintaan",
    meta: "{id} · {time}",
    rejectedNote: "Keputusan tercatat di log audit.",
    expiredTitle: "Permintaan kedaluwarsa.",
    expiredNote:
      "Batas 24 jam telah lewat; akses tidak diberikan. Tim dukungan perlu mengirim permintaan baru jika akses masih diperlukan.",
    approvedNote: "Akses sudah berakhir.",
  },
  empty: {
    title: "Tidak ada permintaan menunggu",
    hint: "Jika tim dukungan meminta akses untuk mengubah data, permintaannya akan muncul di sini.",
  },
  offline: {
    title: "Tidak ada koneksi.",
    body: "Hubungkan kembali untuk memuat status terbaru dan mengambil keputusan. Akses tidak dapat disetujui atau ditolak saat offline.",
    loadFailedTitle: "Permintaan belum dapat dimuat",
    loadFailedHint: "Periksa koneksi, lalu coba lagi.",
  },
  blocked: {
    impersonating:
      "Anda sedang dalam sesi penyamaran. Keputusan hanya dapat diambil oleh owner dari sesinya sendiri.",
    mfaRequired:
      "Verifikasi dua langkah belum aktif di sesi ini. Selesaikan verifikasi dua langkah, lalu muat ulang halaman ini untuk memutuskan.",
    notOwner:
      "Hanya owner organisasi yang dapat menyetujui atau menolak permintaan akses dukungan.",
    offline: "Tombol keputusan nonaktif sampai koneksi kembali.",
  },
  errors: {
    generic: "Keputusan belum tersimpan. Coba lagi sebentar lagi.",
    offline: "Tidak ada koneksi. Periksa internet Anda, lalu coba lagi.",
    impersonating:
      "Sesi penyamaran tidak boleh memutuskan permintaan ini. Keluar dari sesi penyamaran, lalu masuk sebagai owner.",
    mfa: "Verifikasi dua langkah diperlukan. Selesaikan verifikasi, lalu coba lagi.",
    forbidden: "Hanya owner organisasi yang dapat memutuskan permintaan ini.",
    revokeUnavailable:
      "Pencabutan belum dapat dilakukan dari akun Owner. Hubungi tim dukungan Legend agar akses diakhiri, lalu coba lagi nanti.",
    conflict:
      "Permintaan ini sudah diputuskan atau kedaluwarsa. Memuat ulang daftar.",
  },
} as const;
