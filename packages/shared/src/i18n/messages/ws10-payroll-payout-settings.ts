// WS-10 payout config per PT, Pengaturan PT tab (legend-wnkep.6).
// Own file so parallel beads never edit the same catalog lines.
export const payrollPayoutSettingsMessages = {
  title: "Pengaturan pencairan PT",
  loading: "Memuat pengaturan pencairan",
  error: {
    title: "Pengaturan pencairan belum bisa dimuat",
    hint: "Periksa koneksi, lalu coba lagi. Pengaturan yang tersimpan tidak berubah.",
  },
  empty: {
    title: "Belum ada pengaturan pencairan",
    hint: "Pilih metode dan rekening sumber aktif untuk badan usaha ini sebelum menyiapkan pembayaran.",
    create: "Buat pengaturan",
    noAccess:
      "Anda belum memiliki izin mengatur pencairan. Minta pemilik atau finance untuk menyiapkannya.",
  },
  readOnlyHint:
    "Anda dapat melihat pengaturan ini, tetapi mengubahnya membutuhkan izin atur pencairan.",
  badge: {
    manual: "Transfer manual",
    duitku: "Duitku",
    off: "Nonaktif",
  },
  method: {
    label: "Metode pembayaran",
    manual: "Transfer manual",
    duitku: "Duitku (belum aktif)",
    hint: "Persetujuan dua orang berlaku untuk semua metode.",
    chooseManual:
      "Duitku belum bisa dipakai. Pilih transfer manual untuk menyimpan.",
  },
  source: {
    label: "Rekening sumber manual",
    hint: "Dipakai untuk transfer manual, termasuk cadangan saat Duitku tidak tersedia.",
    placeholder: "Pilih rekening aktif",
    active: "Aktif",
    inactive: "Tidak aktif",
    required: "Pilih rekening sumber yang aktif.",
    inactiveError: "Pencairan ditolak. Pilih rekening aktif milik PT ini.",
    none: "PT ini belum punya rekening bank aktif. Tambahkan atau aktifkan rekening di Kas & bank, lalu kembali ke sini.",
    loading: "Memuat daftar rekening PT ini.",
    loadError:
      "Daftar rekening belum bisa dimuat, jadi rekening sumber belum bisa diperiksa. Coba lagi sebelum menyimpan.",
    retry: "Muat ulang daftar rekening",
  },
  banner: {
    title: "Rekening sumber tidak aktif, pencairan ditolak",
    body: "{account} tidak dapat digunakan. Pilih rekening aktif pada pengaturan PT, lalu ajukan ulang untuk persetujuan.",
    bodyUnknown:
      "Rekening sumber yang tersimpan tidak dapat digunakan. Pilih rekening aktif pada pengaturan PT, lalu ajukan ulang untuk persetujuan.",
  },
  limits: {
    perTransfer: "Batas per transfer (Rp)",
    perTransferHint: "Di atas batas, alihkan ke transfer manual.",
    perTransferInvalid:
      "Isi angka rupiah lebih dari 0 dan paling banyak Rp100.000.000.",
    daily: "Batas harian tambahan (Rp)",
    dailyHint:
      "Duitku berhenti sebelum melewati batas. Kosongkan bila tidak ada batas harian.",
    dailyInvalid: "Isi angka rupiah lebih dari 0, atau kosongkan.",
    fee: "Biaya per transfer (Rp)",
    feeHint: "Biaya ditanggung PT dan tidak dipotong dari gaji karyawan.",
    feeInvalid: "Isi angka rupiah 0 atau lebih.",
  },
  enabled: {
    label: "Pencairan aktif untuk PT ini",
    hintOn: "Run yang sudah dikunci bisa diajukan untuk pencairan.",
    hintOff:
      "Selama nonaktif, pengajuan pencairan untuk PT ini ditolak oleh server.",
    hintDuitku: "Duitku belum bisa diaktifkan. Pakai transfer manual.",
  },
  duitku: {
    title: "Duitku disbursement",
    status: "Belum aktif",
    body: "Kredensial khusus pencairan dipisah dari penerimaan pembayaran dan diatur setelah Duitku diaktifkan. Sampai saat itu, semua pencairan memakai transfer manual.",
    credentialsNote: "Kredensial Duitku diisi saat akun Duitku siap dipakai.",
  },
  save: {
    action: "Simpan pengaturan",
    saving: "Menyimpan",
    mfaHint: "Perubahan memerlukan verifikasi MFA.",
    pristine: "Belum ada perubahan untuk disimpan.",
    accountsPending: "Menunggu daftar rekening sebelum bisa menyimpan.",
    accountsFailed:
      "Daftar rekening belum termuat, jadi belum bisa menyimpan. Muat ulang daftarnya dulu.",
    success: "Pengaturan pencairan tersimpan.",
  },
  stepUp: {
    title: "Verifikasi faktor kedua",
    hint: "Menyimpan pengaturan pencairan butuh verifikasi ulang. Masukkan kode dari aplikasi autentikator; pengaturan Anda dikirim otomatis.",
    code: "Kode autentikator",
    codeInvalid: "Kode terdiri dari 6 angka.",
    codeRejected: "Kode tidak cocok. Periksa kode terbaru lalu coba lagi.",
    verify: "Verifikasi dan simpan",
    noFactor:
      "Aplikasi autentikator belum terdaftar. Daftarkan di halaman keamanan akun.",
    loading: "Memeriksa faktor autentikator",
  },
  failure: {
    title: "Pengaturan belum tersimpan",
    serverSays: "Pesan server: {message}",
  },
  rules: {
    eyebrow: "Aturan pembayaran",
    title: "Gaji karyawan tetap utuh",
    fee: "Biaya per transfer",
    borne: "Ditanggung",
    borneEntity: "PT ini",
    note: "Biaya Duitku masuk beban bank PT. Biaya transfer manual aktual mengikuti bank.",
  },
  activate: {
    title: "Aktifkan Duitku saat siap",
    body: "Akun pencairan, deposit, dan uji sandbox harus siap sebelum pembayaran otomatis diaktifkan untuk PT ini.",
    now: "Saat ini: transfer manual tersedia. Format berkas bank ditunda setelah rilis.",
  },
} as const;
