# Dua arah visual — QR order pelanggan Legend

Studi arah, 8 November 2026. Cabang `ux/customer-order-benchmark`. **10 gambar utama + 1 layar kode kasir tambahan**. Mobile selebar 390 px: menu dan detail A setinggi 960 px untuk mempertahankan foto 1:1 / 3:2 serta teks 16 px; layar mobile lain 844 px. Desktop 1440 × 900. PNG pada skala 1× agar lebar ekspor sesuai brief. Semua data adalah contoh, bukan transaksi nyata. Belum ada arah yang dipilih founder; tidak ada perubahan aplikasi.

## Arah A — Katalog foto

Menu menjadi katalog foto dua kolom di mobile, dengan kategori berbentuk pill, nama dan harga tepat di bawah gambar, lalu kontrol jumlah. Susunan ini mendahulukan pengenalan makanan secara visual dan memberi ruang untuk menelusuri menu sambil duduk di meja. Detail memakai foto lebar, kelompok opsi berbingkai, dan error lokal; hasil pembayaran terpusat dengan ringkasan di permukaan netral. Desktop memperluas katalog menjadi empat kolom foto persegi di samping keranjang tetap. A mempertahankan karakter foto yang paling dekat dengan mode **Hangat & Visual**, sambil memangkas lapisan header dan semua ajakan sebelum pembayaran.

## Arah B — Menu & nota meja

Menu menjadi daftar dengan nama, deskripsi, harga, dan kontrol di kiri, serta foto persegi di kanan. Pelanggan dapat membandingkan isi minuman dan makanan sambil melihat item yang sudah dipesan tanpa membuka detail. Kategori memakai garis bawah; detail menempatkan thumbnail dan ringkasan berdampingan sehingga opsi muncul lebih awal. Checkout dan bukti bayar memakai aliran nota dengan pemisah garis putus, bukan kartu bulat berlapis; hasil pembayaran rata kiri. Desktop menggunakan indeks kategori, daftar menu, dan nota keranjang dalam tiga wilayah. B mengutamakan pembacaan dan kustomisasi, dengan biaya berupa jumlah menu yang terlihat lebih sedikit daripada grid A.

**B adalah usulan penyimpangan pola untuk diputuskan founder, bukan klaim patuh penuh terhadap DESIGN.md.** DESIGN.md §4 mengunci grid foto pelanggan dan hero detail; daftar thumbnail dan ringkasan thumbnail B sengaja diusulkan sebagai alternatif pada tahap arah visual ini. Jika B dipilih, CTO perlu mencatat persetujuan pola tersebut dan memperbarui DESIGN.md sebelum implementasi. A memakai foto kartu 1:1 dan foto detail 3:2.

Kedua arah berbeda pada model katalog, urutan informasi detail, navigasi kategori, komposisi desktop, serta bentuk ringkasan pembayaran. Palet, keluarga font, harga, dan aturan transaksi sengaja sama agar founder membandingkan struktur, bukan pergantian merek.

## Daftar gambar dan kondisi

Nomor celah mengacu pada [REPORT.md](../benchmark/REPORT.md), bagian “Celah Legend”.

| Layar | Tujuan dan kondisi penting | Arah A | Arah B | Celah yang ditutup |
|---|---|---|---|---|
| Menu mobile | Menelusuri menu setelah jumlah tamu dikonfirmasi; 1 espresso sudah masuk keranjang. Harga dan bar subtotal terlihat; kartu berubah menjadi stepper. | [arah-a-menu-mobile.png](arah-a-menu-mobile.png) | [arah-b-menu-mobile.png](arah-b-menu-mobile.png) | #1, #4, #5, #7; juga #12–14 |
| Detail mobile | Mengatur minuman; suhu Dingin dipilih, gula wajib belum dipilih setelah percobaan tambah. Error berada di grup gula. Tambahan dan catatan opsional tetap terlihat. | [arah-a-detail-mobile.png](arah-a-detail-mobile.png) | [arah-b-detail-mobile.png](arah-b-detail-mobile.png) | #6; mempertahankan validasi wajib, juga #12 |
| Keranjang / checkout mobile | Meninjau item, kuantitas, estimasi, semua biaya, dan metode bayar pada satu halaman. QRIS terpilih; e-wallet dan kasir tersedia. | [arah-a-checkout-mobile.png](arah-a-checkout-mobile.png) | [arah-b-checkout-mobile.png](arah-b-checkout-mobile.png) | #2, #3, #8, #9; juga #10 dan #12 |
| Pembayaran berhasil mobile | Konfirmasi pembayaran QRIS, total, kode pesanan, estimasi, status pesanan dan struk. Ajakan klaim poin baru muncul setelah pembayaran. | [arah-a-pembayaran-berhasil-mobile.png](arah-a-pembayaran-berhasil-mobile.png) | [arah-b-pembayaran-berhasil-mobile.png](arah-b-pembayaran-berhasil-mobile.png) | #8, #9; juga #12 |
| Menu desktop | Menelusuri menu pada lebar 1440 dengan keranjang tetap di kanan; tidak membentangkan kolom mobile. | [arah-a-menu-desktop.png](arah-a-menu-desktop.png) | [arah-b-menu-desktop.png](arah-b-menu-desktop.png) | #1, #4, #5, #7; juga #12–14 |
| Kode kasir, tambahan | Menunggu uang diterima kasir. Kode LG–0044, total, dan instruksi jelas; pesanan belum masuk dapur. | — | [arah-b-kode-kasir-mobile.png](arah-b-kode-kasir-mobile.png) | #10, sesuai persetujuan founder Q3 |

## Keputusan desain

1. **Satu akses keranjang yang terlihat.** Total pada bar menu adalah **subtotal menu**, diberi label eksplisit karena harga belum termasuk pajak dan service. Bar menjadi CTA tunggal di menu mobile; desktop menampilkan subtotal dan CTA di nota kanan. Kartu berisi item menampilkan jumlah. Alternatif tab keranjang saja ditolak berdasarkan screenshot Legend `06-after-add-mobile.jpg` dan ESB `06-menu-with-cart-bar-mobile.jpg` (bukti kuat: dua layar yang dijalani).
2. **Checkout adalah satu halaman keputusan.** Keranjang, harga, pilihan pembayaran dan satu tombol akhir berada pada layar yang sama; tidak ada dialog metode setelah tombol Bayar. Footer menampilkan total dan CTA metode terpilih, tanpa tab bar. Promo dan split bill tetap sekunder; tawaran member hanya setelah sukses. Dasar: perbandingan checkout ESB dan Legend dalam REPORT (bukti kuat untuk perbedaan struktur, belum diuji pada pelanggan Legend).
3. **Opsi wajib dan status pembayaran tidak disamarkan.** Radio untuk pilihan tunggal, pesan error langsung pada kelompok gula, footer detail menempel di bawah, dan harga tombol mengikuti pilihan. QRIS adalah bawaan; **Bayar di kasir tetap tersedia dan sudah disetujui founder Q3**. Saat kasir dipilih, CTA berubah menjadi “Buat kode bayar di kasir”; halaman kode menjelaskan bahwa dapur menunggu kasir menerima uang. Tidak ada label “opsional / dapat dihapus” pada metode kasir.

## Pemetaan seluruh prioritas 1–9

| Celah | Keputusan pada mockup / kontrak desain |
|---|---|
| #1 Keranjang tersembunyi | Bar “1 item · Subtotal / Rp 23.000 / Lihat keranjang”; stepper + tanda jumlah di item; nota kanan pada desktop. Jumlah/subtotal harus mengikuti keranjang bersama. |
| #2 Total di bawah lipatan | Total Rp 26.600 dan CTA berada pada footer ringkas. Semua baris biaya dan semua metode muat dalam 390 × 844. |
| #3 Dialog metode terlambat | QRIS, E-wallet, Bayar di kasir tampil inline. Metode harus dipilih sebelum tindakan pembayaran / pembuatan kode; waktu pembuatan objek order tetap keputusan architect. |
| #4 Pencarian sempit | Label “Cari di semua menu”. Mengetik harus melepas kategori aktif ke Semua; menghapus pencarian mengembalikan katalog. Ini kontrak interaksi mockup, belum implementasi filter. |
| #5 Header berat | Identitas cafe + meja, satu pencarian, satu baris kategori; filter label lewat satu tombol. Kartu A mulai pada y≈270; daftar B mulai pada y≈330, keduanya sebelum posisi awal Legend ≈390. Tidak ada carousel rekomendasi di atas menu. |
| #6 Footer detail | Stepper dan “Tambah · Rp 23.000” menempel pada safe area bawah. Opsi berada pada wilayah konten di atas footer; pada konten panjang, wilayah ini yang bergulir dengan padding bawah. |
| #7 Tamu memblokir menu | Tidak ada sheet sambutan. Jumlah tamu diisi inline lewat kontrol konteks meja. Gambar menunjukkan kondisi **setelah 2 tamu dipilih**, bukan default otomatis. Saat scan pertama, chip berbunyi “Jumlah tamu · Pilih”; membuka kontrol jumlah di tempat. Input wajib sebelum penambahan pertama membuka sesi, sesuai PRD; browsing tetap tersedia. |
| #8 Tab bar berlebihan | Checkout dan hasil pembayaran hanya memiliki kembali / aksi kontekstual, tanpa tab bar. Halaman berhasil menggantikan tahap pembayaran dan tidak mengirim ulang transaksi saat kembali. |
| #9 Bacaan sebelum bayar | Rincian biaya rata dengan pemisah sederhana, tanpa kartu dalam kartu. Klaim poin berada setelah pembayaran, bukan checkout. |

## Harga dan aturan contoh

- Semua item katalog contoh memakai format `Rp 23.000`, termasuk espresso yang konsisten pada menu, detail, keranjang dan struk. Ekstra espresso opsional `+ Rp 5.000` belum dipilih; bila dipilih, harga tombol menjadi `Rp 28.000`.
- Rincian contoh mengikuti hasil benchmark Legend: Rp 23.000 + service 5% Rp 1.150 + PBJT 10% Rp 2.415 + pembulatan Rp 35 = **Rp 26.600**. Dasar pajak pada contoh termasuk service; angka ini **bukan penetapan kebijakan pajak baru**. Implementasi harus menggunakan quote server (ORD-03), termasuk bila konfigurasi outlet berbeda.
- Estimasi 10–16 menit adalah data contoh dari screenshot benchmark, bukan SLA. Kode QR-0044 / LG–0044 hanya ilustrasi; format final dan masa berlaku kode mengikuti kontrak backend. Tidak ada QR pembayaran nyata atau transaksi yang dibuat.
- Mode contoh bayar di muka: pembayaran terkonfirmasi dahulu, baru diteruskan ke dapur. Khusus metode kasir: founder sudah menyetujui pelanggan menunjukkan kode, kasir menerima uang, kemudian pesanan masuk dapur.
- Sesi bersama: “Ditambahkan Anda” dipertahankan. Item milik tamu lain, harga berubah, stok habis, dan konflik versi perlu mengikuti sumber server pada implementasi.

## Arah visual dan aset

- Mengikuti palet dan tipografi `DESIGN.md`: Plus Jakarta Sans, body utama 16 px, judul 26 px mobile / 40 px desktop, teks bantu 12–14 px, angka tabular, tinta `#1c1b19`, abu hangat, satu area CTA petrol `#0f5e68`. Pilihan kategori netral. Foto menu tanpa bingkai kartu. Tidak ada kaca, gradien, toggle tema atau dekorasi merek baru.
- Foto **generated / ilustratif**, bukan foto menu outlet: [assets/menu-illustrative.png](assets/menu-illustrative.png). Dibuat melalui built-in image generation; teks dan kontrol dirender deterministik dari [source.html](source.html), sehingga tidak bergantung pada teks acak dari gambar generatif. PNG adalah artefak review; HTML adalah sumber desain statis, bukan kode aplikasi.
- Prompt aset: “Premium natural Indonesian cafe menu photography, exact 2 × 2 contact sheet: iced espresso, cappuccino with latte art, toasted chicken sandwich with lettuce and tomato, butter croissant; warm daylight and cream ceramic plates; centered subjects with breathing room; no typography, logo, or watermark.” Prompt dinormalisasi; permintaan lengkap menyebut objek, pencahayaan, komposisi dan batas yang sama.
- Font berasal dari paket Plus Jakarta Sans yang sudah ada di repo; lisensi OFL disalin ke [assets/FONT-LICENSE.txt](assets/FONT-LICENSE.txt). Tidak ada font jaringan saat render.
- Provenance: **Observed** — REPORT, REFERENCES, PRD §10, DESIGN.md; screenshot ESB cart bar, Legend detail / checkout. **Inferred** — pilihan struktur A/B dan susunan desktop. **Generated** — foto ilustratif. Rujukan Starbucks, GoFood/GrabFood dan McDonald's dari REFERENCES tidak diperlakukan sebagai alur yang sudah diuji.

## Interaksi lanjutan untuk implementasi

- Pencarian: lintas seluruh menu, reset kategori ke Semua, tanpa hasil palsu dari filter kategori. Filter label dibuka dari tombol Filter dan harus memperlihatkan status filter aktif.
- Item: saat Tambah ditekan tanpa gula, pertahankan suhu dan catatan, tampilkan error, fokuskan kelompok gula. Setelah semua wajib valid, tambah ke keranjang bersama, update stepper dan bar; cegah tambah berulang saat request berlangsung.
- Checkout: perubahan item atau metode menghitung ulang quote; input tidak hilang saat gagal. QRIS → “Bayar Rp 26.600 dengan QRIS”; e-wallet → “Pilih e-wallet dan bayar”; kasir → “Buat kode bayar di kasir”. QRIS / e-wallet gagal menawarkan coba lagi, metode lain, atau kasir dengan keranjang dipertahankan.
- Pembayaran: status memverifikasi pembayaran tampil selama request; sukses hanya dari status server terkonfirmasi. Menunggu QRIS, kedaluwarsa dan offline mengikuti kontrak pembayaran saat implementasi. Tidak ada simulasi transaksi pada sumber mockup ini.
- Keranjang kosong: teks “Keranjang meja masih kosong” + “Pilih menu”. Loading: skeleton mengikuti ukuran foto, item dan bar harga. Stok habis: label Habis dan tombol tidak dapat tambah, dengan alasan; stok habis saat checkout menampilkan perubahan sebelum quote baru dikonfirmasi. Sesi habis: “Sesi meja berakhir” + instruksi scan QR meja lagi. Keadaan ini dideskripsikan untuk handoff, belum diekspor sebagai layar tambahan pada tahap arah visual.
- Jeda gerak yang disarankan 150–250 ms hanya untuk feedback jumlah, error, serta masuk / keluar overlay; hormati reduced motion. PNG tidak membuktikan gerak, keyboard, fokus, live region atau sinkronisasi sesi.

## Pemeriksaan dan batas

Render ulang: `heavy node design/mockups/capture.mjs` dari root repo. Script menggunakan Chromium dari Playwright yang sudah terpasang, tanpa dev server, database, atau koneksi pembayaran. [verification.json](verification.json) menyimpan ukuran, error runtime dan deteksi teks keluar viewport / tertutup footer untuk semua 11 ekspor.

Gate RYUX disesuaikan tahap arah visual:

| Area | Hasil | Bukti / batas |
|---|---|---|
| Product | PASS pada scope mockup · bukti kuat untuk celah terdokumentasi | PRD, brief, REPORT; Q3 kasir disetujui. Belum diuji pengguna. |
| UX | PASS pada rancangan 1–9 | Mapping di atas; kontrak interaksi tertulis, bukan fungsi aplikasi. |
| UI | PASS pada kanvas | Dua konsep struktural; sistem font / palet / harga sama. |
| Design system | PASS A / B usulan penyimpangan menunggu keputusan | Satu keluarga font, satu keluarga abu hangat, satu hue aksi; radius 12 / 18 / pill, satu set ikon outline. A mempertahankan rasio foto; pola daftar dan detail thumbnail B memerlukan persetujuan founder. |
| Accessibility | NOT VERIFIED untuk aplikasi | Keterbacaan visual dan 6 pasangan teks/latar dihitung (6,24–14,96:1), termasuk CTA 7,44:1; keyboard, focus, screen reader dan zoom aplikasi belum diuji. |
| Responsive | PASS untuk ekspor 390 dan 1440 | Dua komposisi menu per arah. Lebar 320, zoom 200%, dan viewport lain belum diuji. |
| Edge cases | PASS pada scope arah | Error wajib dan pembayaran sukses diekspor, menunggu kasir ekstra; keadaan lain dideskripsikan, belum semuanya divisualkan. |
| Code quality | N/A | Tidak ada perubahan kode aplikasi. Sumber hanya untuk ekspor gambar statis. |
| Visual QA | PASS | 11 PNG dibuka satu per satu, teks tidak terpotong / tertutup; audit geometri Chromium pada lebar 390 (tinggi 844 / 960) dan 1440 (tinggi 900). |
| Anti-slop | PASS | Tanpa klaim rating / promosi / urgensi rekaan; data serta provenance ilustratif disebut jelas. |
| Final | NOT VERIFIED sebagai produk | Gambar siap untuk memilih arah; belum implementasi atau validasi pengguna. |

## Asumsi untuk review founder melalui CTO

1. Pilih A atau B sebagai arah lanjut; keduanya belum disetujui. Memilih B juga memerlukan persetujuan eksplisit atas pola daftar menu dan detail thumbnail yang berbeda dari DESIGN.md §4. Rekomendasi designer **A** bila prioritasnya pengalaman Hangat & Visual berbasis foto; pilih B bila deskripsi dan pilihan menu lebih penting daripada jumlah foto per layar. Ini penilaian desain, bukan hasil uji konversi.
2. Konfirmasi cara mengisi jumlah tamu inline pada konteks meja sebelum penambahan pertama. Kewajiban isi jumlah tamu tetap mengikuti PRD; yang diusulkan berubah hanya penempatan kontrol, tanpa sheet sambutan.
3. Format kode kasir, masa berlaku, quote biaya, dan waktu pembuatan order harus ditentukan tim teknis dari konfigurasi / kontrak. Persetujuan “Bayar di kasir” **tidak perlu ditanyakan lagi**.
