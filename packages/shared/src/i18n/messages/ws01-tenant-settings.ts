// Tenant settings text (PRD v1.7 §3 F4 "Integrasi per Tenant", "Whitelabel",
// "Teks & Kamus Istilah", "Konfigurasi sebagai Data"; bead legend-5k0):
// integrations with write-only credentials, the Tenant Theme editor with its
// WCAG 2.2 AA gate, the term dictionary and config export/import. Kept in its
// own file so parallel WS-01 beads never edit the same lines in id.ts.
// Namespace: `tenantSettings`.

export const tenantSettingsMessages = {
  title: "Pengaturan tenant",
  tabs: {
    integrations: "Integrasi",
    theme: "Tema",
    terms: "Istilah",
    config: "Konfigurasi",
  },

  state: {
    errorTitle: "Pengaturan belum bisa dimuat",
    errorHint: "Periksa koneksi lalu coba lagi. Perubahan Anda belum hilang.",
    offlineTitle: "Perangkat sedang offline",
    offlineHint:
      "Sambungkan perangkat ke internet, lalu coba lagi. Tidak ada perubahan yang tersimpan saat offline.",
  },

  errors: {
    generic: "Terjadi kesalahan. Coba lagi sebentar lagi.",
    offline: "Tidak ada koneksi. Sambungkan internet lalu coba lagi.",
    forbidden: "Akun Anda tidak berhak mengubah pengaturan ini.",
    notFound: "Data tidak ditemukan. Muat ulang halaman lalu coba lagi.",
    conflict: "Data sudah berubah di tempat lain. Muat ulang lalu coba lagi.",
    whatsappNumberTaken:
      "Nomor WhatsApp ini sudah dipakai tenant lain. Gunakan nomor lain.",
    invalid: "Isian belum benar. Periksa kolom yang ditandai.",
    themeContrast:
      "Kontras tema di bawah WCAG 2.2 AA, jadi tema tidak dapat disimpan. Ubah warna lalu coba lagi.",
    providerNotAvailable:
      "Penyedia ini belum dibuka untuk tenant Anda. Hubungi Super Admin.",
    bundleInvalid:
      "Berkas konfigurasi tidak valid. Ekspor ulang dari tenant asal lalu coba lagi.",
    invalidTransition: "Perubahan status ini tidak diizinkan saat ini.",
  },

  integrations: {
    title: "Integrasi",
    description:
      "Pembayaran, WhatsApp, email pengirim, dan akun ojol milik tenant ini. Setiap outlet bisa memakai pengaturan sendiri.",
    secretNotice:
      "Kredensial disimpan terenkripsi dan tidak pernah ditampilkan lagi. Untuk mengubahnya, isi kolom ganti.",
    scopeLabel: "Cakupan",
    scopeTenant: "Semua outlet (tenant)",
    scopeOutlet: "Outlet",
    dialogScope: "Berlaku untuk: {scope}",
    emptyHint:
      "Belum ada integrasi yang diatur. Pilih Atur pada kartu di bawah untuk memulai.",
    groups: {
      payment: "Pembayaran",
      messaging: "Pesan & email",
      ojol: "Ojol",
    },
    providers: {
      doit: {
        name: "DOIT",
        description: "Penyedia pembayaran QRIS dan e-wallet.",
      },
      whatsapp: {
        name: "WhatsApp",
        description: "Nomor penerima dan pengirim notifikasi WhatsApp.",
      },
      email: {
        name: "Email pengirim",
        description: "Alamat pengirim struk dan pemberitahuan.",
      },
      gofood: { name: "GoFood" },
      grabfood: { name: "GrabFood" },
      shopeefood: { name: "ShopeeFood" },
      ojol: {
        description: "Akun toko untuk menerima pesanan dari aplikasi ojol.",
      },
    },
    fields: {
      environment: "Lingkungan",
      environmentSandbox: "Uji coba (sandbox)",
      environmentProduction: "Produksi",
      merchantName: "Nama merchant",
      vendor: "Penyedia WhatsApp",
      vendorKirimdev: "KirimDev",
      receivingNumber: "Nomor WhatsApp penerima",
      receivingNumberHint:
        "Format 62812…; angka 0 di depan otomatis menjadi 62.",
      senderAddress: "Alamat pengirim",
      senderAddressHint: "Alamat email yang tampil sebagai pengirim.",
      senderName: "Nama pengirim",
      storeId: "ID toko",
      storeIdHint: "ID toko seperti tercatat di aplikasi mitra.",
      accountLabel: "Label akun",
    },
    credentials: {
      apiKey: "Kunci API",
      webhookSecret: "Rahasia webhook",
      clientId: "Client ID",
      clientSecret: "Client secret",
    },
    credentialsTitle: "Kredensial",
    credentialsStoredHint:
      "Kredensial tersimpan dan disembunyikan. Kosongkan kolom di bawah untuk tetap memakainya, atau isi semua kolom untuk menggantinya.",
    credentialsNewHint:
      "Isi kredensial dari penyedia. Setelah disimpan, nilainya tidak akan tampil lagi.",
    storedFields: "Kredensial tersimpan",
    storedSr: "tersimpan, tidak ditampilkan",
    replaceLabel: "Ganti {field}",
    noCredentials: "Belum ada kredensial.",
    notConfigured: "Belum diatur untuk cakupan ini.",
    inherited: "Memakai pengaturan tenant. Atur di sini untuk outlet ini saja.",
    lastError: "Pemeriksaan terakhir gagal ({code}).",
    lastChecked: "Diperiksa {time}",
    status: {
      not_configured: "Belum diatur",
      draft: "Draf",
      active: "Aktif",
      disabled: "Nonaktif",
      error: "Bermasalah",
    },
    setup: "Atur",
    edit: "Ubah",
    activate: "Aktifkan",
    disable: "Nonaktifkan",
    saved: "{name} disimpan.",
    activated: "{name} diaktifkan.",
    disabled: "{name} dinonaktifkan.",
    errors: {
      required: "Wajib diisi.",
      whatsapp:
        "Nomor WhatsApp harus diawali 62 dan terdiri dari 10 sampai 15 angka.",
      email: "Alamat email belum benar.",
      credentialsIncomplete:
        "Isi semua kolom kredensial saat mengganti, atau kosongkan semuanya.",
    },
  },

  theme: {
    title: "Tema tenant",
    description:
      "Logo, warna pendukung, font, dan gaya sudut. Tema yang kontrasnya di bawah WCAG 2.2 AA tidak dapat disimpan.",
    modeLabel: "Mode tampilan",
    modeLight: "Terang",
    modeDark: "Gelap",
    noBrand: "Belum ada brand. Buat brand lebih dulu sebelum mengatur tema.",
    logoTitle: "Logo",
    logoChoose: "Pilih logo",
    logoChange: "Ganti logo",
    logoRemove: "Hapus logo",
    logoAlt: "Logo brand",
    logoHint: "PNG, JPG, atau WebP, maksimal 600 KB.",
    logoSet: "Logo sudah terpasang.",
    logoWrongType: "Pilih berkas PNG, JPG, atau WebP.",
    logoTooLarge:
      "Berkas lebih dari 600 KB. Perkecil gambarnya lalu coba lagi.",
    colorsTitle: "Warna",
    colorsHint:
      "Kosongkan kolom untuk memakai warna Base Theme. Netral dan status tetap dari Base Theme agar maknanya sama.",
    pickColor: "Pilih warna untuk {token}",
    resetColor: "Kembalikan {token} ke Base Theme",
    hexError: "Pakai format #rrggbb, misalnya #0f5e68.",
    baseValue: "Base",
    tokens: {
      background: "Latar halaman",
      foreground: "Teks utama",
      card: "Kartu",
      "surface-2": "Permukaan 2",
      "surface-3": "Permukaan 3",
      muted: "Latar redup",
      "muted-foreground": "Teks redup",
      secondary: "Tombol sekunder",
      accent: "Sorotan baris",
      border: "Garis tepi",
      input: "Tepi kolom isian",
      ring: "Cincin fokus",
      primary: "Warna utama",
      "primary-foreground": "Teks di warna utama",
      brand: "Warna brand",
      "brand-foreground": "Teks di warna brand",
      "brand-subtle": "Latar brand lembut",
      success: "Sukses",
      "success-foreground": "Teks di sukses",
      "success-subtle": "Latar sukses",
      warning: "Peringatan",
      "warning-foreground": "Teks di peringatan",
      "warning-subtle": "Latar peringatan",
      danger: "Bahaya",
      "danger-foreground": "Teks di bahaya",
      "danger-subtle": "Latar bahaya",
      info: "Info",
      "info-foreground": "Teks di info",
      "info-subtle": "Latar info",
      "primary-hover": "Warna utama saat disentuh",
      "primary-tint": "Tint warna utama",
      "primary-tint-strong": "Tint warna utama pekat",
      "chart-neutral": "Grafik netral",
      shell: "Bingkai kartu",
    },
    shapeTitle: "Font dan sudut",
    fontLabel: "Font",
    fonts: {
      "plus-jakarta-sans": "Plus Jakarta Sans",
      inter: "Inter",
    },
    cornersLabel: "Gaya sudut",
    corners: { tegas: "Tegas", lembut: "Lembut", bulat: "Bulat" },
    previewLabel: "Pratinjau tema",
    previewHeading: "Pratinjau tampilan",
    previewBody:
      "Begini tampilan tombol, kolom isian, dan label di aplikasi tenant Anda.",
    previewPrimary: "Pesan sekarang",
    previewSecondary: "Lihat menu",
    previewMuted: "Simpan",
    previewField: "Nama pemesan",
    previewFieldValue: "Sinta Dewi",
    previewBadge: "Menu baru",
    previewLink: "Lihat promo",
    contrastTitle: "Pemeriksaan kontras WCAG 2.2 AA",
    contrastPass: "Lolos di mode terang dan gelap. Tema boleh disimpan.",
    contrastFail:
      "{count} pasangan warna gagal (terang {light}, gelap {dark}). Tema belum boleh disimpan.",
    contrastInvalid:
      "{count} nilai warna tidak valid. Perbaiki sebelum diperiksa.",
    pairsCaption: "Rasio kontras pasangan warna utama",
    pairsUse: "Pasangan",
    pairs: {
      primaryButton: "Teks di tombol utama",
      link: "Tautan di latar halaman",
      brandFill: "Teks di warna brand",
      brandTint: "Teks di latar brand lembut",
    },
    pass: "lolos",
    fail: "min. {min}:1",
    failureDetails: "Lihat {count} pasangan yang gagal",
    failureLine: "{mode}: {fg} pada {bg} {ratio}:1, minimal {min}:1",
    saveBlocked:
      "Perbaiki kontras yang gagal sebelum menyimpan. Tema yang gagal tidak dapat diaktifkan.",
    save: "Simpan & aktifkan",
    discard: "Batalkan perubahan",
    useBase: "Pakai Base Theme",
    readOnly:
      "Anda hanya dapat melihat tema. Hubungi admin tenant untuk mengubah.",
    saved: "Tema disimpan dan diaktifkan.",
    savedHint: "Tampilan tenant memakai tema baru pada pemuatan berikutnya.",
    historyTitle: "Riwayat versi",
    historyHint: "Muat versi lama ke editor, lalu simpan sebagai versi baru.",
    historyEmpty: "Belum ada versi tema tersimpan.",
    version: "Versi {version}",
    status: { draft: "Draf", active: "Aktif", archived: "Diarsipkan" },
    contrastFailedBadge: "Kontras gagal",
    loadVersion: "Muat ke editor",
  },

  terms: {
    title: "Kamus istilah",
    description:
      "Ganti istilah yang dilihat staf dan tamu, misalnya nama zona atau stasiun. Hanya Super Admin yang dapat mengubahnya. Kosongkan kolom untuk kembali ke istilah bawaan.",
    localeLabel: "Bahasa",
    localeId: "Indonesia",
    localeEn: "Inggris",
    enNote:
      "Istilah Inggris disiapkan lebih dulu; tampilan Inggris menyusul bersama katalog Inggris.",
    noneChanged: "Semua istilah memakai nilai bawaan platform.",
    changedCount: "{count} istilah diubah untuk bahasa ini.",
    customized: "Diubah",
    groups: {
      table: "Meja",
      space: "Zona & ruang",
      facility: "Fasilitas",
      station: "Stasiun produksi",
      loyalty_tier: "Tier loyalty",
    },
    groupHints: {
      table: "Sebutan untuk meja tamu.",
      space: "Sebutan untuk zona dan ruang kerja.",
      facility: "Nama fasilitas yang bisa dipesan.",
      station: "Nama stasiun yang tampil di layar dapur.",
      loyalty_tier: "Nama tingkat keanggotaan.",
    },
    issues: {
      empty: "Istilah tidak boleh kosong.",
      tooLong: "Istilah terlalu panjang (maksimal 500 karakter).",
    },
    saveCount: "Simpan {count} perubahan",
    discard: "Batalkan",
    saved: "{count} perubahan istilah disimpan.",
  },

  config: {
    title: "Ekspor & impor konfigurasi",
    description:
      "Salin konfigurasi tenant ke tenant baru sebagai satu berkas. Berkas hanya berisi pengaturan: tanpa data transaksi, tanpa kredensial, dan tanpa ID tenant asal.",
    exportTitle: "Ekspor",
    exportHint: "Pilih bagian yang ingin disertakan lalu unduh berkasnya.",
    sectionsLegend: "Bagian konfigurasi",
    exportExcludes:
      "Tidak ikut diekspor: transaksi, pelanggan, karyawan, dan kredensial integrasi.",
    exportAction: "Ekspor konfigurasi",
    exported: "Konfigurasi diekspor ({count} bagian).",
    exportUnsafe:
      "Ekspor dibatalkan: berkas memuat kredensial atau ID tenant. Hubungi tim dukungan.",
    importTitle: "Impor",
    importHint:
      "Pilih berkas hasil ekspor. Anda melihat perbedaannya dulu; tidak ada yang berubah sebelum Anda menerapkan.",
    chooseFile: "Pilih berkas .json",
    clear: "Bersihkan",
    idleHint: "Belum ada berkas. Pilih berkas ekspor untuk melihat pratinjau.",
    previewTitle: "Pratinjau perubahan",
    previewSummary:
      "{file}: {sections} bagian, {changed} di antaranya berbeda dari konfigurasi saat ini.",
    diffStatus: {
      added: "Baru",
      changed: "Berubah",
      unchanged: "Sama",
    },
    diffCounts: "+{added} ~{changed} −{removed}",
    showDetails: "Lihat {count} baris",
    moreLines: "Dan {count} baris lainnya.",
    lineKind: { added: "ditambah", changed: "diubah", removed: "dihapus" },
    removeWarning:
      "Bagian yang diterapkan menggantikan isi lama seluruhnya: {count} baris yang tidak ada di berkas akan dihapus.",
    noChanges:
      "Berkas ini sama dengan konfigurasi saat ini. Tidak ada yang perlu diterapkan.",
    applyRestricted:
      "Hanya Super Admin yang dapat menerapkan impor. Anda tetap dapat melihat pratinjau.",
    applyAction: "Terapkan konfigurasi",
    confirmTitle: "Terapkan konfigurasi?",
    confirmBody:
      "{count} bagian akan diterapkan sekaligus. Jika ada yang gagal, tidak ada yang berubah.",
    applied: "Konfigurasi diterapkan ({count} bagian).",
    doneBanner: "{count} bagian konfigurasi sudah diterapkan.",
    invalid: {
      size: "{file} terlalu besar (maksimal 5 MB).",
      empty: "{file} kosong.",
      json: "{file} bukan berkas JSON yang valid.",
      schema: "{file} bukan berkas konfigurasi yang dikenali.",
      identifiers:
        "{file} masih memuat pengenal tenant asal atau data yang tidak boleh ikut.",
    },
    invalidHint: {
      size: "Pilih berkas hasil ekspor yang lebih kecil.",
      empty: "Pilih berkas hasil ekspor konfigurasi.",
      json: "Ekspor ulang dari tenant asal, jangan ubah isinya dengan tangan.",
      schema:
        "Gunakan berkas yang dihasilkan tombol Ekspor, dengan versi format yang sama.",
      identifiers:
        "Hapus ID, kredensial, dan kontak tenant asal dari berkas, atau ekspor ulang.",
    },
    sections: {
      modules: "Modul & batas paket",
      text_overrides: "Istilah tenant",
      theme: "Tema",
      roles: "Peran & izin",
      approval_policies: "Matriks approval",
      chart_of_accounts: "Bagan akun",
      tax_rules: "Pajak",
      service_charge_rules: "Service charge",
      zones: "Zona & meja",
      checklists: "Checklist",
      loyalty_policy: "Kebijakan loyalty",
      facilities: "Fasilitas",
      wifi_policies: "Kebijakan Wi-Fi",
      payroll_settings: "Pengaturan penggajian",
    },
  },
} as const;
