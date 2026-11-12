// Custom-domain verification copy. Default wording follows the existing UI.
export const orgDomainMessages = {
  settings: "Pengaturan",
  title: "Domain kustom",
  subtitle: "Hubungkan domain milik Anda dengan memverifikasi kepemilikannya.",
  loadingTitle: "Memuat domain",
  loadingDescription: "Mengambil status dan petunjuk verifikasi…",
  emptyTitle: "Belum ada domain kustom",
  emptyDescription: "Tambahkan domain untuk memulai verifikasi kepemilikan.",
  actions: {
    add: "Tambah domain",
    continue: "Lanjutkan",
    cancel: "Batal",
    check: "Cek verifikasi",
    checking: "Memeriksa…",
    copy: "Salin",
    copyHost: "Salin nama/host",
    copyValue: "Salin nilai",
  },
  form: {
    title: "Tambah domain kustom",
    description: "Masukkan domain yang ingin dihubungkan.",
    brand: "Brand",
    hostname: "Nama domain",
    placeholder: "pesan.contoh.id",
    required: "Masukkan nama domain.",
    invalid: "Nama domain tidak valid. Gunakan format seperti pesan.contoh.id.",
    noBrand:
      "Belum ada brand. Tambahkan brand lebih dulu untuk menghubungkan domain.",
  },
  verification: {
    title: "Verifikasi kepemilikan",
    found: "Record TXT ditemukan",
    instruction: "Tambahkan record TXT berikut pada pengelola DNS domain Anda.",
    noRecord:
      "Petunjuk verifikasi belum tersedia. Muat ulang halaman, lalu coba lagi.",
    type: "Jenis",
    host: "Nama / host",
    value: "Nilai",
    propagation:
      "Perubahan DNS mungkin memerlukan waktu sebelum dapat ditemukan.",
    verified: "Terverifikasi",
    pending: "Menunggu verifikasi",
    successTitle: "Domain terverifikasi.",
    successMessage: "Kepemilikan domain berhasil dikonfirmasi.",
  },
  help: {
    title: "Cara memverifikasi",
    openDns: "Buka pengaturan DNS pada penyedia domain Anda.",
    addRecord: "Tambahkan record TXT dengan nama dan nilai yang ditampilkan.",
    saveAndCheck: "Simpan perubahan, lalu kembali ke sini dan pilih {action}.",
    retry:
      "Jika record belum ditemukan, periksa kembali nama dan nilainya lalu coba lagi.",
  },
  notices: {
    verificationFailedTitle: "Verifikasi belum berhasil.",
    verificationFailedMessage:
      "Record TXT belum ditemukan. Periksa nama dan nilai di pengelola DNS, lalu coba lagi.",
    unusableTitle: "Domain tidak dapat digunakan.",
    reservedMessage:
      "Domain ini dicadangkan dan tidak dapat digunakan. Pilih domain lain.",
    takenMessage: "Domain ini sudah digunakan. Pilih domain lain.",
    networkTitle: "Tidak ada koneksi.",
    networkMessage: "Periksa koneksi internet Anda, lalu coba lagi.",
    unknownTitle: "Terjadi kesalahan.",
    unknownMessage: "Permintaan belum berhasil. Coba lagi sebentar lagi.",
    copied: "Tersalin.",
    copyFailed: "Tidak dapat menyalin. Pilih dan salin teks secara manual.",
  },
};
