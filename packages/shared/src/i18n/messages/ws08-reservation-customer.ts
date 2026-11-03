// Customer booking flow text (bead legend-xm4y; PRD v1.7 §3.22 "Reservasi &
// Event", §4 Alur H, RSV-02/RSV-03). Own file so this bead never edits the
// shared catalog body: messages/id.ts spreads the `reservationBooking`
// namespace.
//
// Copy rules: the page speaks for the brand, never for the platform (TEN-08),
// and it never states a policy number of its own. Every DP amount, refund
// window, minimum spend and payment window rendered next to these sentences
// comes from the reservation's frozen policy snapshot (RSV-03).
export const reservationBookingMessages = {
  title: "Reservasi meja",
  lead: "Pilih tanggal, jumlah tamu, dan zona, lalu pilih jam yang masih tersedia. Reservasi dikonfirmasi setelah DP dibayar.",
  mode: {
    label: "Jenis kunjungan",
    booking: "Reservasi meja",
    waitlist: "Daftar tunggu",
  },
  step: {
    slot: "Tanggal & jam",
  },
  slot: {
    date: "Tanggal",
    pax: "Jumlah tamu",
    paxHint: "Maksimal {max} tamu per reservasi.",
    zone: "Zona",
    zoneAll: "Semua zona",
    duration: "Durasi",
    durationValue: "{minutes} menit",
    title: "Jam tersedia",
    hint: "Hanya jam yang masih punya meja kosong untuk {pax} tamu.",
    seats: "{seats} kursi",
    loading: "Memeriksa ketersediaan meja…",
    pickPrompt: "Pilih tanggal dan jumlah tamu untuk melihat jam tersedia.",
    emptyTitle: "Belum ada meja kosong",
    emptyHint: "Coba tanggal atau jumlah tamu lain, atau gabung daftar tunggu.",
    emptyAction: "Gabung daftar tunggu",
    errorTitle: "Ketersediaan belum bisa dimuat",
    errorHint: "Periksa koneksi lalu coba lagi.",
  },
  guest: {
    title: "Data tamu",
    hint: "Nomor WhatsApp dipakai untuk pengingat dan konfirmasi reservasi.",
    name: "Nama tamu",
    namePlaceholder: "Nama lengkap",
    phone: "Nomor WhatsApp",
    phonePlaceholder: "081234567890",
    phoneHint: "Nomor Indonesia, misalnya 0812… atau 62812…",
    note: "Catatan",
    notePlaceholder: "Contoh: meja dekat jendela atau kursi bayi.",
    noteHint: "Maksimal {max} karakter.",
    errorName: "Isi nama tamu 1–150 karakter.",
    errorPhone: "Masukkan nomor WhatsApp Indonesia yang valid.",
    errorNote: "Catatan maksimal {max} karakter.",
    errorSlot: "Pilih jam kedatangan dulu.",
  },
  package: {
    label: "Paket pre-order",
    none: "Tanpa paket",
    option: "{name} · {price}/tamu",
    hint: "{price} per tamu, dipesan minimal {hours} jam sebelum kedatangan.",
    estimate: "Perkiraan {total} untuk {pax} tamu.",
    empty: "Belum ada paket yang cocok untuk {pax} tamu pada jam ini.",
    error:
      "Paket pre-order belum bisa dimuat. Reservasi tetap bisa dilanjutkan tanpa paket.",
  },
  submit: {
    summary: "Ringkasan",
    when: "{date}, {time}",
    pax: "{pax} tamu",
    action: "Lanjutkan reservasi",
    pending: "Mengirim reservasi…",
    errorTitle: "Reservasi belum terkirim",
    errorHint:
      "Coba kirim lagi. Percobaan ulang tidak membuat reservasi kedua.",
    slotTakenTitle: "Jam ini baru saja terisi",
    slotTakenHint:
      "Daftar jam sudah diperbarui. Pilih jam lain, lalu kirim lagi.",
    packageGoneTitle: "Paket ini tidak lagi tersedia",
    packageGoneHint:
      "Pilih paket lain atau lanjutkan tanpa paket, lalu kirim lagi.",
    rateLimitedTitle: "Terlalu banyak percobaan",
    rateLimitedHint: "Tunggu sebentar, lalu kirim lagi.",
    newBooking: "Buat reservasi lain",
  },
  confirmation: {
    title: "Reservasi diterima",
    titleConfirmed: "Reservasi terkonfirmasi",
    pendingStatus: "Menunggu DP",
    confirmedStatus: "Terkonfirmasi",
    pendingLead:
      "Reservasi aktif setelah DP dibayar. DP diperhitungkan ke tagihan saat Anda datang.",
    confirmedLead:
      "Reservasi tercatat. DP diperhitungkan ke tagihan saat Anda datang.",
    guest: "Atas nama {name}",
    when: "{date}, {time} · {pax} tamu",
    zone: "Zona: {zone}",
    note: "Catatan: {note}",
    depositTitle: "DP {amount}",
    depositExpires: "Bayar sebelum {time}.",
    depositAction: "Bayar DP",
    depositHint: "Tautan pembayaran dibuka di halaman pembayaran yang aman.",
    depositWindow:
      "Batas waktu pembayaran DP {minutes} menit setelah reservasi dibuat.",
    statusSnapshot:
      "Status ini sesuai saat reservasi dibuat. Setelah DP dibayar, reservasi terkonfirmasi otomatis.",
    expiredStatus: "Batas DP lewat",
    expiredTitle: "Batas waktu pembayaran DP sudah lewat",
    expiredHint:
      "Tautan DP ini tidak bisa dipakai lagi. Buat reservasi lain bila Anda masih ingin datang.",
  },
  policy: {
    title: "Kebijakan reservasi Anda",
    hint: "Kebijakan ini dibekukan saat reservasi dibuat, jadi pembatalan mengikuti versi ini.",
    version: "Versi {version}, dibekukan {time}.",
    deposit: "DP {amount}",
    noDeposit: "Tanpa DP",
    freeCancel:
      "Batal minimal {hours} jam sebelum kedatangan: DP kembali penuh.",
    lateCancel: "Batal di dalam {hours} jam: DP kembali {percent}.",
    noShow: "Tidak datang: DP kembali {percent}.",
    minimumSpend: "Minimum belanja {amount}.",
  },
  seo: {
    title: "Reservasi {brand}",
    description:
      "Pilih tanggal, jam, jumlah tamu, dan zona reservasi {brand}, lalu bayar DP melalui tautan pembayaran.",
  },
  waitlist: {
    title: "Daftar tunggu",
    lead: "Walk-in tanpa reservasi bisa masuk daftar tunggu. Staf akan memanggil nama Anda saat meja siap.",
    name: "Nama tamu",
    phone: "Nomor WhatsApp",
    pax: "Jumlah tamu",
    zone: "Zona pilihan",
    submit: "Gabung daftar tunggu",
    pending: "Mengirim…",
    resultTitle: "Anda masuk daftar tunggu",
    estimate: "Perkiraan tunggu {minutes} menit.",
    call: "Staf akan memanggil nama Anda saat meja siap. Tidak ada notifikasi otomatis ke ponsel.",
    errorTitle: "Pendaftaran belum terkirim",
    errorHint: "Coba kirim lagi. Percobaan ulang tidak membuat dua entri.",
    duplicateTitle: "Anda sudah ada di daftar tunggu",
    duplicateHint:
      "Nomor ini sudah terdaftar hari ini. Staf akan memanggil nama Anda; tanyakan staf bila perlu mengubah jumlah tamu.",
    toBooking: "Buat reservasi meja",
  },
};
