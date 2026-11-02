// Public brand website text (PRD v1.7 §3.24 "Website Publik per Brand").
// One file so the website bead never edits the shared catalog body: the
// `website` group is spread into messages/id.ts.
//
// Copy rules: the page speaks for the brand, never for the platform (TEN-08),
// and never states a rule the data does not carry (no invented policies,
// minimum spends or "best in town" claims). The price note is the owner
// decision of 1 Nov 2026: menu prices exclude tax and service charge.
export const websiteMessages = {
  nav: {
    home: "Beranda",
    menu: "Menu",
    reservation: "Reservasi",
    member: "Member",
    mainNav: "Navigasi situs",
    footerNav: "Jelajahi",
  },
  common: {
    viewMenu: "Lihat menu",
    reserve: "Reservasi meja",
    openMaps: "Buka peta",
    chatWhatsApp: "Chat WhatsApp",
    hours: "Jam buka",
    location: "Lokasi",
    contact: "Kontak",
    priceNote: "Harga belum termasuk pajak dan service charge.",
    soldOut: "Habis",
    everyDay: "Setiap hari",
    photoUnavailable: "Foto belum tersedia",
    whatsAppGreeting: "Halo {brand}, saya ingin bertanya.",
    newTab: "buka di tab baru",
  },
  day: {
    sun: "Minggu",
    mon: "Senin",
    tue: "Selasa",
    wed: "Rabu",
    thu: "Kamis",
    fri: "Jumat",
    sat: "Sabtu",
  },
  home: {
    highlightsTitle: "Tentang {brand}",
    featuredTitle: "Menu unggulan",
    featuredHint: "Beberapa menu yang bisa kamu coba hari ini.",
    featuredEmptyTitle: "Menu unggulan belum dipilih",
    featuredEmptyHint:
      "Menu lengkap tetap bisa dilihat; unggulan tampil di sini setelah diatur.",
    featuredEmptyAction: "Lihat menu lengkap",
    promosTitle: "Promo berjalan",
    promosEmptyTitle: "Belum ada promo",
    promosEmptyHint: "Promo terbaru diumumkan di sini dan lewat WhatsApp.",
    promoValidUntil: "Berlaku sampai {date}",
    galleryTitle: "Suasana cafe",
    visitTitle: "Kunjungi {brand}",
    visitHint:
      "Datang langsung, atau hubungi kami untuk reservasi meja dan acara.",
    memberTitle: "Member {brand}",
    memberBody:
      "Kumpulkan poin setiap transaksi, tukar reward, dan simpan voucher dalam satu akun.",
    memberSignIn: "Masuk",
    memberRegister: "Daftar member",
    hoursTitle: "Jam buka",
    addressTitle: "Alamat",
    contactTitle: "Hubungi kami",
    hoursToday: "Hari ini: {hours}",
  },
  menu: {
    title: "Menu",
    lead: "Menu lengkap {brand}.",
    searchLabel: "Cari menu",
    searchPlaceholder: "Cari nama menu atau bahan",
    searchClear: "Hapus pencarian",
    noResultsTitle: "Menu tidak ditemukan",
    noResultsHint:
      "Coba kata kunci lain, atau tampilkan semua menu untuk melihat seluruh daftar.",
    noResultsAction: "Tampilkan semua menu",
    emptyTitle: "Menu belum tersedia",
    emptyHint:
      "Menu online tampil di sini setelah dapur menerbitkan menu hari ini.",
    sectionEmpty: "Belum ada item di bagian ini.",
    allergens: "Mengandung: {list}",
    updatedAt: "Diperbarui {date}",
    sectionsNav: "Bagian menu",
    jsonLdName: "Menu {brand}",
  },
  reservation: {
    title: "Reservasi meja",
    lead: "Pilih tanggal, jam, dan jumlah tamu, lalu kirim permintaan lewat WhatsApp. Tim kami membalas untuk konfirmasi.",
    formTitle: "Permintaan reservasi",
    formHint:
      "Tombol di bawah membuka WhatsApp dengan pesan yang sudah terisi dari data ini.",
    name: "Nama pemesan",
    namePlaceholder: "Nama lengkap",
    date: "Tanggal",
    time: "Jam",
    pax: "Jumlah tamu",
    paxPlaceholder: "Pilih jumlah tamu",
    notes: "Catatan",
    notesPlaceholder:
      "Contoh: meja dekat jendela, ulang tahun, atau kebutuhan khusus.",
    submit: "Kirim lewat WhatsApp",
    submitHint:
      "Permintaan belum menjadi reservasi sampai tim kami mengonfirmasi.",
    errorName: "Isi nama pemesan minimal 2 karakter.",
    errorDate: "Pilih tanggal hari ini atau setelahnya.",
    errorTime: "Pilih jam kedatangan.",
    errorPax: "Pilih jumlah tamu antara 1 dan 20.",
    errorNotes: "Catatan maksimal 300 karakter.",
    hoursTitle: "Sebelum datang",
    hoursBody:
      "Kami buka {hours}. Kalau rencanamu berubah, beri tahu kami lewat WhatsApp.",
    memberTitle: "Member {brand}",
    memberBody:
      "Sudah punya akun member? Masuk untuk melihat poin, voucher, dan riwayat kunjungan.",
    memberSignIn: "Masuk",
    memberRegister: "Daftar member",
    whatsappTitle: "Reservasi lewat WhatsApp",
    whatsappBody:
      "Untuk permintaan khusus, acara, atau grup besar, hubungi kami langsung.",
    closedTitle: "Reservasi online belum dibuka",
    closedHint:
      "Sementara ini reservasi diatur lewat WhatsApp. Hubungi kami untuk ketersediaan meja.",
    whatsappIntro: "Halo {brand}, saya ingin reservasi meja.",
    whatsappDetails:
      "Nama: {name}\nTanggal: {date}\nJam: {time}\nJumlah tamu: {pax}",
    whatsappNotes: "Catatan: {notes}",
  },
  seo: {
    menuTitle: "Menu {brand}",
    menuDescription:
      "Menu lengkap {brand}: kopi, hidangan Nusantara, dan pastry. Harga belum termasuk pajak dan service charge.",
    reservationTitle: "Reservasi {brand}",
    reservationDescription:
      "Ajukan reservasi meja di {brand} lewat WhatsApp: pilih tanggal, jam, dan jumlah tamu.",
  },
  state: {
    offlineTitle: "Kamu sedang offline",
    offlineHint:
      "Halaman ini butuh koneksi internet. Sambungkan kembali, lalu coba lagi.",
    errorTitle: "Halaman belum bisa dimuat",
    errorHint:
      "Coba lagi sebentar lagi. Kalau tetap gagal, hubungi kami lewat WhatsApp.",
  },
  footer: {
    rights: "© {year} {brand}",
  },
  // Alt text for the demo photos mock mode overlays on the shared fixtures
  // (DESIGN.md Q24: Unsplash samples only in demo data).
  demo: {
    heroAlt: "Contoh foto: meja kayu dengan kopi di Cafe Legend",
    galleryInteriorAlt:
      "Contoh foto: meja dan kursi di ruang utama Cafe Legend",
    galleryCoffeeAlt: "Contoh foto: kopi susu aren dingin di meja",
  },
};
