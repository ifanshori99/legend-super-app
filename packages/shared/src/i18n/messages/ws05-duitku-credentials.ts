// Duitku credentials form (back office > Pembayaran > Gateway), bead legend-vntqt,
// sub-302 D15-D16. Register as `paymentAdmin.duitku`. Credentials are
// write-only: no text here ever shows a stored value.
export const paymentDuitkuMessages = {
  title: "Kredensial Duitku",
  intro:
    "Hubungkan akun Duitku untuk brand ini atau satu outlet. Kunci tersimpan aman dan tidak pernah ditampilkan lagi.",
  scope: "Berlaku untuk",
  scopeBrand: "Brand (semua outlet)",
  scopeOutlet: "Satu outlet",
  outlet: "Outlet",
  loadErrorTitle: "Kredensial Duitku belum bisa dimuat",
  loadErrorHint: "Periksa koneksi, lalu coba lagi.",
  noOutlets:
    "Belum ada outlet. Pilih cakupan brand untuk menyimpan kredensial.",
  outletsLoading: "Memuat daftar outlet...",
  outletsError:
    "Daftar outlet belum bisa dimuat. Cakupan satu outlet belum bisa dipilih.",
  outletsRetry: "Muat ulang outlet",
  loading: "Memuat kredensial Duitku...",
  providerName: "Duitku",
  activation: {
    newHint:
      "Kredensial yang baru disimpan berstatus draft. Aktifkan di Pengaturan integrasi supaya Duitku bisa dipilih di routing pembayaran.",
    pendingHint:
      "Integrasi ini belum aktif (draft atau nonaktif). Aktifkan di Pengaturan integrasi supaya Duitku bisa dipilih di routing pembayaran.",
    link: "Buka Pengaturan integrasi",
    action: "Aktifkan",
    running: "Mengaktifkan...",
    done: "Duitku sudah aktif dan bisa dipilih di routing pembayaran.",
    activeLabel: "Aktif",
    readyHint:
      "Tes koneksi berhasil. Aktifkan supaya Duitku bisa dipilih di routing pembayaran.",
    needTest:
      "Jalankan tes koneksi dulu. Aktivasi baru bisa setelah tes berhasil.",
    testFailed:
      "Tes koneksi terakhir gagal. Perbaiki kredensial, lalu tes lagi sampai berhasil.",
  },
  inherited:
    "Outlet ini memakai kredensial brand. Simpan kredensial di sini untuk menggantinya khusus outlet ini.",
  status: {
    label: "Status",
    notConfigured: "Belum diatur",
    saved: "Tersimpan, belum diuji",
    testedOk: "Tersimpan, tes terakhir berhasil",
    testedError: "Tersimpan, tes terakhir gagal",
    lastTested: "Terakhir diuji {time}",
    lastError: "Kode kesalahan terakhir: {code}",
  },
  fields: {
    environment: "Lingkungan",
    environmentSandbox: "Sandbox (uji coba)",
    environmentProduction: "Production (transaksi nyata)",
    notificationEmail: "Email notifikasi",
    notificationEmailHint:
      "Duitku mengirim pemberitahuan transaksi ke email ini.",
    vaName: "Nama virtual account",
    vaNameHint: "Opsional, maksimal 20 karakter.",
    merchantCode: "Kode merchant",
    apiKey: "API key",
  },
  credentials: {
    title: "Kredensial",
    newHint: "Isi kode merchant dan API key dari dashboard Duitku.",
    storedHint:
      "Kredensial sudah tersimpan dan tidak bisa dilihat lagi. Isi keduanya hanya bila ingin menggantinya.",
    storedSr: "tersimpan",
    replaceLabel: "Ganti {field}",
  },
  save: "Simpan kredensial",
  saveClearedNotice:
    "Kode merchant dan API key sudah dikosongkan demi keamanan. Isi ulang keduanya, lalu simpan lagi.",
  saved: "Kredensial Duitku tersimpan",
  test: {
    action: "Tes koneksi",
    needSave: "Simpan kredensial dulu sebelum tes koneksi.",
    running: "Menguji koneksi...",
    ok: "Koneksi berhasil",
    failed: "Koneksi gagal",
    errorCode: "Kode: {code}",
    methodsTitle: "Metode pembayaran dari Duitku",
    methodsEmpty: "Duitku tidak mengembalikan metode pembayaran.",
    methodEnabled: "Aktif",
    methodDisabled: "Nonaktif",
    channelCount: "{count} kanal",
    checkedAt: "Diuji {time}",
    cause: {
      authFailed: "Duitku menolak kode merchant atau API key.",
      rejected: "Duitku menolak permintaan tes.",
      unreachable: "Duitku tidak bisa dihubungi.",
      unknown: "Penyebab kegagalan belum dikenali.",
    },
    advice: {
      authFailed:
        "Periksa kode merchant, API key, dan lingkungan (sandbox atau production). Ganti kredensial bila perlu, lalu tes lagi.",
      rejected:
        "Periksa pengaturan akun Duitku dan email notifikasi, lalu tes lagi.",
      unreachable: "Periksa jaringan, tunggu beberapa menit, lalu tes lagi.",
      unknown:
        "Tes lagi. Bila terus gagal, hubungi dukungan dan sebutkan kode di atas.",
    },
  },
  errors: {
    required: "Wajib diisi.",
    email: "Format email belum benar.",
    vaNameLong: "Maksimal 20 karakter.",
    credentialsIncomplete:
      "Isi kode merchant dan API key sekaligus untuk menggantinya.",
    generic: "Permintaan belum bisa diproses. Coba lagi.",
    invalid: "Isian belum sesuai. Periksa kolom yang ditandai.",
    forbidden: "Akun ini tidak punya izin mengelola integrasi.",
    notFound: "Kredensial tidak ditemukan. Muat ulang halaman.",
    notSupported: "Tes koneksi belum tersedia untuk gateway ini.",
    offline: "Tidak ada koneksi. Periksa jaringan, lalu coba lagi.",
    invalidTransition:
      "Status integrasi sudah berubah dan tidak bisa diaktifkan dari sini. Muat ulang halaman.",
    providerUnavailable:
      "Duitku belum disediakan untuk akun ini. Hubungi admin platform.",
  },
} as const;
