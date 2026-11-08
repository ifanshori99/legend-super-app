# Benchmark alur order pelanggan: ESB, Richeese, Legend

Diperiksa: 2026-11-08. Viewport utama 390x844 (iPhone 13, DPR 2), satu putaran desktop 1440x900.
Dasar untuk desain ulang alur QR order pelanggan Legend (PRD §10 QR Order, F7, U3: median scan sampai pesanan terkirim ≤ 3 menit).

## Cara dan batas

| Produk | URL yang dijalani | Mode | Sampai mana | Catatan |
|---|---|---|---|---|
| ESB Order (Jabarano Coffee Lengkong) | `esborder.qs.esb.co.id/JJB/JBLGB/order?mode=dinein&tableNumber=Urban%209` | Dine-in, meja Urban 9 | Layar Pembayaran, metode dipilih, data uji terisi. Tombol **Bayar** tidak ditekan | Semua request POST ke endpoint order/payment ESB diblokir di browser selama langkah pembayaran (hanya `calculate-total` dibiarkan). Tidak ada pesanan terkirim ke dapur |
| Richeese Factory (RFOrder) | URL brief `web-order-richeese.stamps.id/en/` membalas **404**. Dijalani versi aktif `order.richeesefactory.com/order/` (produk Stamps yang sama, memuat aset dari `web-order-richeese.stamps.id`) dan katalog publik `richeese.stamps.id/menus/` | Dine In, Takeaway (Delivery nonaktif) | **Berhenti di gerbang login.** Semua mode order langsung dialihkan ke `/accounts/login/` (minta email). Sesuai aturan, tidak login dan tidak mendaftar | Alur menu, keranjang, dan pembayaran Richeese tidak bisa dibandingkan |
| Legend (lokal) | `http://localhost:3241/t/<token contoh>` dengan `VITE_API_MOCK=true` | Bayar di muka, meja A01, data contoh | Pilih cara bayar, lalu QRIS mock sampai "Pembayaran berhasil" | Data fixture, tanpa API dan database |

Data uji yang diketik: nama "Uji Coba", HP `081234567890`, email `uji.coba@example.com` (hanya di ESB). Tidak ada OTP yang terkirim.

## Jumlah tap sampai pembayaran

Hitungan dari layar pertama setelah scan sampai tombol bayar terakhir bisa ditekan. Ketik teks dihitung terpisah.

| Langkah | ESB | Legend |
|---|---|---|
| Layar pertama | Popup promo menutupi menu: **tap X** (1) | Sheet "Selamat datang", jumlah tamu default 2: **Mulai pesan** (1) |
| Pilih item | Tap kartu item, sheet detail layar penuh (2) | Tap kartu item, bottom sheet (2) |
| Opsi wajib | 1 grup (Dine in/Take away): centang (3) | 2 grup (varian, gula): 2 tap (3, 4) |
| Tambah | Tambah Pesanan · Rp42.727 (4) | Tambah ke keranjang (5) |
| Ke keranjang | Bar melayang "Total Rp42.727 · CHECK OUT (1)" (5) | Tab bawah "Keranjang" (6) |
| Ke checkout | Lanjut Pembayaran (6) | Lanjut ke checkout (7) |
| Data pelanggan | Nama wajib: tap + ketik (7) | Tidak diminta |
| Mulai bayar | (metode ada di layar yang sama) | Bayar Rp 26.600 (8), pesanan sudah dibuat di titik ini |
| Pilih metode | Tab Pembayaran Online / Bayar di Kasir, radio QRIS (8) | Dialog "Pilih cara bayar": QRIS (9) |
| Tombol terakhir | **Bayar** (9), tidak ditekan | **Lanjut bayar** (10), QR tampil |
| **Total** | **9 tap + 1 ketik** | **10 tap, tanpa ketik** |
| Disetarakan (1 grup opsi wajib) | 9 tap + 1 ketik | 9 tap |

Richeese: 1 tap (Dine In) lalu dinding login. Tidak bisa dihitung.

Kesimpulan: jumlah tap Legend sudah setara ESB. Masalah Legend bukan jumlah langkah, tapi **di mana langkahnya disembunyikan** (keranjang lewat tab, total di bawah lipatan, metode bayar di dialog terpisah) dan **kepadatan visual** di menu dan checkout.

## Tabel langkah per langkah

| Langkah | ESB | Richeese | Legend |
|---|---|---|---|
| Landing | Banner foto besar, kartu outlet (jam buka), kartu "Nomor Meja: Urban 9", ajakan poin. Popup promo besar menutupi layar saat scan pertama (`esb/01a-promo-popup-mobile.jpg`, `esb/01-landing-mobile.jpg`) | Carousel promo, 3 tombol mode besar (Dine In, Takeaway, Delivery) 84×84 px, Delivery pucat tanpa penjelasan (`richeese/01-landing-mobile.jpg`) | Bottom sheet "Selamat datang di Cafe Legend": jumlah tamu, info bayar di muka, "Mulai pesan" / "Lihat menu dulu" (`legend/01-landing-mobile.jpg`) |
| Pilih outlet/mode | Sudah dari QR (outlet + meja) | Pilih mode, lalu wajib login email (`richeese/02-login-gate-mobile.jpg`) | Sudah dari QR (meja A01, zona Indoor Reguler) |
| Menu | Grid 2 kolom, foto persegi, nama 2 baris, harga, tombol outline "Tambah" (tinggi 28 px). Header sticky: nama outlet + ikon cari + **satu dropdown kategori** yang ikut berganti saat scroll. Banyak item tampil harga "0" (`esb/02-menu-scroll-mobile.jpg`) | Hanya katalog publik tanpa harga, tab kategori teks, grid foto 2 kolom (`richeese/04-menu-catalog-mobile.jpg`, `04b`) | Judul "Menu" + badge + baris mode + catatan pajak + kotak cari + 2 baris chip (kategori, label), carousel "Disarankan", lalu grid 2 kolom foto dengan tombol + bulat 48 px. Sticky: kotak cari + chip (119 px) (`legend/02-menu-mobile.jpg`, `02b`) |
| Kategori | Sheet daftar kategori huruf kapital semua, yang aktif diberi centang (`esb/03-category-picker-mobile.jpg`) | Tab horizontal | Chip horizontal, menyaring daftar (`legend/03-category-dapur-mobile.jpg`) |
| Cari | Layar cari terpisah, kata yang cocok disorot oranye (`esb/02c-search-mobile.jpg`) | Tidak ada | Kotak cari di halaman. **Pencarian ikut terkunci ke kategori aktif**: "espresso" saat chip Dapur aktif menghasilkan "0 menu ditemukan" (`legend/02d-search-scoped-to-category-empty-mobile.jpg`) |
| Detail item + modifier | Sheet layar penuh: foto, nama, harga, deskripsi, grup opsi dengan **checkbox** untuk pilihan wajib maks 1, catatan, footer sticky "Jumlah" + "Tambah Pesanan · Rp42.727" (`esb/04-item-detail-mobile.jpg`) | Modal katalog dengan panah kiri/kanan dan "pesan sekarang" (menuju login) (`richeese/05-catalog-item-mobile.jpg`) | Bottom sheet: foto, deskripsi, harga, radio per grup dengan label "Wajib · Pilih 1", tambahan opsional dengan harga, "Habis" untuk opsi habis, catatan dapur, stepper + "Tambah ke keranjang" (`legend/04-item-detail-mobile.jpg`) |
| Validasi | Tekan "Tambah" tanpa opsi wajib: tidak ada pesan apa pun (`esb/05-item-validation-mobile.jpg`) | – | Pesan merah di bawah tiap grup, border merah (`legend/05-item-validation-mobile.jpg`) |
| Setelah tambah | Tombol kartu berubah jadi stepper − 1 +, muncul bar melayang oranye "Total Rp42.727 · CHECK OUT (1)" (`esb/06-menu-with-cart-bar-mobile.jpg`) | – | Toast "Espresso masuk keranjang", badge 1 di tab Keranjang. Tidak ada total di layar menu (`legend/06-after-add-mobile.jpg`) |
| Keranjang | Halaman "Pesanan": tipe pesanan, **Menu Terkait** (upsell geser dengan +) di atas, item dengan "Ubah" dan stepper, "Tambah catatan lainnya", Rincian Pembayaran (Biaya lainnya terlipat: PB1), footer "Total Pembayaran Rp47.000 · Lanjut Pembayaran" (`esb/07-cart-mobile.jpg`, `07c`) | – | "Keranjang meja" (dilihat semua tamu), item + "Ditambahkan Anda", stepper, Hapus, "Tambah lagi?" upsell, subtotal + "Lanjut ke checkout" (`legend/07-cart-mobile.jpg`) |
| Data pelanggan | Nama wajib, HP opsional ("untuk info promo"), email opsional (struk), nomor meja terkunci (`esb/08-payment-empty-mobile.jpg`) | Email untuk login | Tidak diminta (tamu). Ajakan "Masuk atau daftar" untuk poin di checkout |
| Ringkasan | Satu halaman Pembayaran: data pemesan, poin, outlet, metode, promo, total di footer (`esb/09-payment-filled-mobile.jpg`) | – | Checkout: cara bayar, estimasi siap 10–16 menit, ringkasan item, promo, rincian (service 5%, PBJT 10%, pembulatan), kartu poin. Footer sticky "Bayar Rp 26.600" + "Bagi tagihan" + teks + tab bar (~260 px). **Total tidak terlihat tanpa scroll** (`legend/08-checkout-mobile.jpg`, `08b`) |
| Pilihan pembayaran | Inline di halaman: segmen "Pembayaran Online" / "Bayar di Kasir"; online: QRIS, ShopeePay, GoPay, OVO (radio + logo), centang S&K. Kasir: ilustrasi + "tunjukkan QR ke kasir" (`esb/09b-payment-methods-mobile.jpg`, `10`) | – | Dialog setelah "Bayar": QRIS / E-wallet, "Lanjut bayar" / "Batal". Pesanan QR-…-0044 sudah terbuat di belakang dialog (`legend/09-payment-methods-mobile.jpg`) |
| Setelah bayar | Tidak dijalani | – | QRIS dengan nominal besar, batas waktu, status menunggu otomatis, lalu "Pembayaran berhasil" (`legend/10-qris-waiting-mobile.jpg`, `11`) |
| Kondisi khusus | Halaman error QR kedaluwarsa dengan "Try Again" / "Beranda" (`esb/x1-error-page-mobile.jpg`) | 404 di URL lama (`richeese/00-brief-url-404-mobile.jpg`) | Item habis: foto abu-abu + label "Habis" (`legend/x1-sold-out-mobile.jpg`) |
| Desktop | Kolom mobile di tengah layar (`esb/12-menu-desktop.jpg`, `11-payment-desktop.jpg`) | Layout desktop sungguhan dengan nav atas (`richeese/06-landing-desktop.jpg`) | Kolom tengah ±670 px, grid 2 kolom, tab bar di bawah kolom (`legend/12-menu-desktop.jpg`) |

## Gaya visual singkat

| | ESB | Richeese | Legend |
|---|---|---|---|
| Warna | Oranye tunggal sebagai aksen dan CTA, latar putih, banner foto dari merchant | Kuning dan merah merek, bentuk blob dekoratif | Teal gelap untuk CTA, abu hangat, putih |
| Tipografi | Sans netral, kategori huruf kapital semua, harga tebal | Sans bulat ramah, judul tebal | Plus Jakarta Sans/Inter, judul besar ("Menu", "Checkout" ±36 px), harga dengan "Rp" kecil terpisah |
| Kepadatan | Padat, 2 kolom, banyak item per layar | Longgar, foto besar | Sedang sampai longgar; header menu memakan ±390 px sebelum item pertama |
| Target sentuh | Kecil: "Tambah" 28 px, stepper 24–26 px, ikon cari 36 px | Besar: tombol mode 84 px | Baik: chip 44 px, tombol + 48 px, CTA 56 px |
| Aksesibilitas kasar | Nama tombol teknis ("search-button", "plus-icon", "sidenav-button"); tombol "Tambah Pesanan" dan "Lanjut Pembayaran" tidak bisa ditemukan lewat nama aksesibelnya; checkbox dipakai untuk pilihan tunggal | Tidak diuji lebih jauh dari landing | Skip link, label aria jelas ("Lihat detail Espresso", "Kurangi jumlah"), role radio dan dialog benar |
| Micro-interaction | Kartu berubah jadi stepper, bar keranjang muncul, sorot kata cari | Carousel | Toast konfirmasi, badge keranjang, status pembayaran langsung berubah |

## Yang bagus untuk ditiru

1. **Bar keranjang melayang dengan total** (ESB): jumlah item, total rupiah, dan CTA selalu terlihat di menu. Jalan ke checkout tidak pernah tersembunyi (`esb/06-menu-with-cart-bar-mobile.jpg`).
2. **Tombol + di kartu berubah jadi stepper** setelah item masuk (ESB): pelanggan langsung melihat item mana yang sudah dipesan.
3. **Satu halaman pembayaran** (ESB): metode bayar inline, total dan satu tombol akhir di footer. Tidak ada dialog tambahan.
4. **Dropdown kategori satu baris yang ikut scroll** (ESB): navigasi kategori panjang tanpa memakan dua baris chip.
5. **Upsell "Menu Terkait" di keranjang** dengan + cepat (ESB). Legend sudah punya "Tambah lagi?", pertahankan.
6. **Opsi "Bayar di Kasir"** sebagai jalan keluar bila e-wallet gagal (ESB). Lihat pertanyaan di bawah.
7. **Pemilihan mode besar dan jelas** (Richeese): bila nanti Legend punya takeaway atau pickup.
8. Dari Legend sendiri, **pertahankan**: validasi opsi wajib per grup, transparansi pajak sejak menu, estimasi siap, tanpa wajib isi nama, keranjang bersama dengan "Ditambahkan Anda", layar QRIS dengan batas waktu, target sentuh besar, label aksesibel.

## Yang buruk untuk dihindari

1. Popup promo yang menutupi menu saat scan pertama (ESB).
2. Harga "0" tampil di kartu menu (ESB, banyak item).
3. Checkbox untuk pilihan wajib tunggal, dan tidak ada pesan saat opsi wajib belum dipilih (ESB).
4. Target sentuh 24–28 px dan nama tombol teknis untuk pembaca layar (ESB).
5. Kategori huruf kapital semua yang panjang ("COFFEE - SIGNATURE WHITE SERIES") (ESB).
6. Pajak disembunyikan di "Biaya lainnya" yang terlipat (ESB). Legend lebih jujur, pertahankan.
7. Dinding login sebelum pelanggan bisa melihat menu dan harga (Richeese).
8. Tombol mode nonaktif tanpa penjelasan (Delivery, Richeese).
9. Katalog tanpa harga dengan tombol "pesan sekarang" yang berujung login (Richeese).

## Celah Legend, urut dari dampak terbesar

| # | Masalah | Bukti | Usulan |
|---|---|---|---|
| 1 | Di menu tidak ada total dan jalan ke checkout. Setelah tambah item hanya toast dan badge kecil di tab "Keranjang" | `legend/06-after-add-mobile.jpg` vs `esb/06-menu-with-cart-bar-mobile.jpg` | Bar keranjang melayang di atas tab bar: "1 item · Rp 23.000 · Lihat keranjang". Muncul begitu keranjang berisi, ikut update saat tamu lain menambah |
| 2 | Checkout: total tidak terlihat tanpa scroll. Footer sticky ±260 px (Bayar + Bagi tagihan + teks + tab bar) menutup "Rincian bayar" | `legend/08-checkout-mobile.jpg`, `08b` | Footer ringkas: "Total Rp 26.600" + satu CTA. "Bagi tagihan" jadi link sekunder di dalam halaman. Tab bar disembunyikan di checkout dan pembayaran |
| 3 | Metode bayar baru dipilih di dialog setelah tekan "Bayar", dan pesanan sudah terbuat saat itu | `legend/09-payment-methods-mobile.jpg` (QR-20261101-0044 di belakang dialog) | Pilihan metode inline di checkout (QRIS terpilih bawaan, ingat pilihan terakhir). CTA "Bayar Rp 26.600 dengan QRIS". Satu tap lebih sedikit. Apakah pesanan tetap dibuat saat "Bayar": keputusan tim teknis (architect) |
| 4 | Pencarian terkunci ke kategori aktif, menghasilkan "0 menu" palsu | `legend/02d-search-scoped-to-category-empty-mobile.jpg` | Mengetik di kotak cari selalu mencari ke semua menu (chip kategori kembali ke "Semua"), atau tampilkan "3 hasil di kategori lain" |
| 5 | Header menu berat: judul "Menu", badge, baris mode, catatan pajak, kotak cari, 2 baris chip. Item pertama baru muncul di ±390 px. Area sticky 119 px berisi 2 baris chip | `legend/02-menu-mobile.jpg`, `02b` | Header ringkas: nama cafe + chip meja, ikon cari. Satu baris chip kategori sticky. Filter label (Terlaris, Vegetarian, Baru, Pedas) pindah ke tombol "Filter" atau digabung di baris yang sama. Catatan pajak satu baris kecil |
| 6 | Sheet detail item: footer tidak menempel di bawah layar, isi opsi terlihat di bawah tombol "Tambah ke keranjang" | `legend/04-item-detail-mobile.jpg`, `05` | Footer menempel di bawah dengan safe area, isi scroll di atasnya. Harga di tombol ikut pilihan: "Tambah · Rp 23.000" |
| 7 | Sheet "Berapa tamu" menghalangi menu di scan pertama | `legend/01-landing-mobile.jpg` | PRD mewajibkan pemindai pertama mengisi jumlah tamu: tetap ada, tapi lebih ringan. Menu langsung tampil dengan chip "Meja A01 · 2 tamu · ubah", atau tanyakan jumlah tamu saat checkout pertama |
| 8 | Tab bar 4 item (Menu, Keranjang, Pesanan, Tagihan) tetap tampil di checkout dan pembayaran, memakan 64 px dan mengundang keluar dari alur | `legend/08-checkout-mobile.jpg`, `10-qris-waiting-mobile.jpg` | Sembunyikan tab bar di checkout dan layar bayar; tampilkan tombol kembali saja |
| 9 | Kartu poin "Dapatkan poin" dan kartu dalam kartu "Rincian bayar" di checkout menambah bacaan tepat sebelum bayar | `legend/08b-checkout-bottom-mobile.jpg` | Rincian bayar rata tanpa kartu ganda. Ajakan daftar member dipindah ke layar "Pembayaran berhasil" |
| 10 | Tidak ada jalan keluar bila pelanggan tidak bisa bayar online (hanya QRIS dan e-wallet) | `legend/09-payment-methods-mobile.jpg` vs `esb/10-payment-cashier-option-mobile.jpg` | Opsi "Bayar di kasir" (tunjukkan kode ke kasir). Butuh keputusan founder, lihat pertanyaan |
| 11 | Carousel "Disarankan untuk Anda" tanpa jarak kiri, kartu pertama menempel tepi layar | `legend/02-menu-mobile.jpg` | Gutter 16 px dengan `scroll-padding-inline` |
| 12 | Format harga tidak konsisten: "Rp 20.000", "Rp20.000", "Rp" kecil terpisah di atas angka besar | `legend/04-item-detail-mobile.jpg`, `07-cart-mobile.jpg`, `08-checkout-mobile.jpg` | Satu komponen harga dengan satu format (`Rp 23.000`), `tabular-nums`, ukuran dari token |
| 13 | Tombol "+" di kartu dan "Lihat detail" membuka sheet yang sama; tidak ada perubahan kartu setelah item masuk | `legend/06-after-add-mobile.jpg` | Kartu yang sudah ada di keranjang menampilkan jumlah (stepper atau badge "1×") seperti ESB |
| 14 | Toggle tema di header pelanggan memakai slot kanan atas yang paling mudah ditemukan | `legend/02-menu-mobile.jpg` | Ikuti tema sistem untuk pelanggan; slot kanan atas untuk cari atau panggil waiter. Bila DESIGN.md mewajibkan toggle, pindahkan ke menu |

## Pertanyaan untuk founder

1. Apakah pelanggan boleh memilih "Bayar di kasir" di meja dengan mode bayar di muka (pesanan baru masuk dapur setelah kasir menerima uang)? Menentukan ada tidaknya opsi ke-3 di layar pembayaran (celah #10).

## Usulan arah desain untuk designer

1. **Menu sebagai satu layar kerja**: header ringkas, satu baris kategori sticky, kartu dengan stepper, bar keranjang melayang dengan total. Pelanggan tidak perlu tab bar untuk memesan.
2. **Checkout satu layar sampai bayar**: ringkasan, rincian, dan metode bayar inline; footer hanya total + satu tombol "Bayar Rp X dengan QRIS"; bagi tagihan dan ajakan member jadi aksi sekunder.
3. **Hangat tapi tenang** (PRD "Mode Hangat & Visual", referensi Starbucks): foto besar tetap jadi pusat, tapi kurangi teks bantu, kartu dalam kartu, dan baris chip; satu gaya harga; target sentuh 44 px tetap.
