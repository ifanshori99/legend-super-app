# Mockup QR order pelanggan Legend

Cabang `ux/customer-order-benchmark`, 8 November 2026. Artefak ini untuk review desain; semua menu, harga, kode dan status adalah contoh. Tidak ada perubahan aplikasi atau transaksi nyata. Arah aktif adalah **A + liquid glass** berdasarkan keputusan founder Q4 dan Q5. Studi A/B di bawah disimpan sebagai arsip proses, bukan pilihan yang masih menunggu keputusan.

## Final arah A + liquid glass

**Keputusan founder:** Q4 memilih Arah A, katalog foto. Q5 menyetujui jumlah tamu inline di chip/bar kecil di atas menu, wajib diisi sebelum item pertama ditambah; browsing tersedia tanpa jendela sambutan. Q3 tetap berlaku: Bayar di kasir tersedia, pelanggan menunjukkan kode, kasir menerima uang, lalu pesanan masuk dapur. Keputusan ini tidak perlu diminta ulang. Dasar: [brief lanjutan](../../docs/briefs/04-designer-arah-a-liquid-glass.md).

### Revisi warna (Q6)

Permintaan founder: “Coba riset warna termasuk warna button secara psikologis yang mendorong pembelian serta membuat orang memesan banyak”. Riset, metode, kekuatan bukti, token dan pasangan kontras ada di [COLOR-RESEARCH.md](../COLOR-RESEARCH.md). Revisi ini sudah diterapkan pada seluruh sepuluh ekspor final; palet masih **usulan untuk review**, bukan klaim menaikkan omzet.

Urutan kerja Q6: telaah bukti → putuskan peran warna/pasangan AA → revisi sumber mobile dan desktop → render seluruh PNG → audit teks/kaca dan inspeksi visual → review konteks segar → commit lokal. Scope tetap artefak desain; tidak mengubah aplikasi, DESIGN.md atau docs/.

| Peran | Palet sebelum Q6 | Palet usulan Q6 | Alasan dan rujukan |
|---|---|---|---|
| CTA utama | Petrol `#0f5e68` | Rust/jingga bata `#a83a17` + putih, **6,40:1** | Satu aksen aksi yang jelas di atas ivory, dibedakan dari status. **Keputusan desain**, bukan warna pemicu lapar; riset §Bukti/CTA. |
| Nama dan harga | Tinta `#1c1b19` | Coffee `#2b211b` | Hierarki harga stabil, ≥14,60:1 pada canvas/paper; tanpa harga merah atau diskon rekaan. Riset §Palet. |
| Canvas dan paper | `#f7f6f4` / `#fbfaf9` | Ivory `#faf6f0` / `#fffcf7` | Selaras dengan foto kafe dan area baca solid; alasan visual, belum bukti konversi. Riset §Implikasi. |
| Teks bantu | `#5f5b55`; kaca `#3d3a35` | `#67584e`; kaca `#4b3b30` | Minimum teks solid 6,33:1; teks bantu kaca ≥7,93:1. Riset §Kaca. |
| Kaca gelap | Petrol gelap `rgba(8,45,50,.78)` | Coffee `rgba(57,37,27,.90)` | Kontras putih ≥10,60:1 di atas ekstrem foto; tint lebih pekat menjaga bacaan. Riset §Kaca. |
| Kaca terang | `rgba(251,250,249,.72)` | `rgba(255,252,247,.88)` | Teks utama ≥11,68:1; kaca tetap terbatas di lapisan mengambang. Riset §Kaca. |
| Status / promo | Hijau/merah/amber terpisah | Sukses `#246443` pada `#e8f3eb`; error `#a51d2d` pada `#fff0f0`; menunggu/promo `#765000` pada `#fff0cc` | Pasangan ≥6,19:1; selalu ikon/teks. Token promo adalah aturan pemakaian, tidak ada promo baru yang dikarang. Riset §Aturan. |

**Upsell yang terlihat:** detail espresso dan checkout menampilkan satu croissant mentega “Opsional · + Rp 23.000”; nota desktop menampilkan item sama. Bar keranjang mobile menambahkan “Tambah pendamping kopi? · Lihat pilihan” dengan bobot lebih ringan dari akses keranjang. Saran tidak otomatis masuk pesanan: subtotal tetap Rp 23.000 dan total contoh Rp 26.600. Keranjang kosong, error/stok habis, dan pembayaran berlangsung/berhasil tidak diberi tawaran tambahan. Pairing kopi–croissant adalah inferensi desain dari menu contoh; bukan rekomendasi algoritmik atau hasil penjualan lokal.

Bukti paling relevan untuk saran adalah eksperimen lapangan prompt F&B Ebster (2.160 transaksi), bukan klaim hue tertentu. Pembatasan satu saran opsional mempertimbangkan temuan Norvell tentang efek sikap/kunjungan kembali. Bundling dan prompt “Tambah minuman?” dicatat sebagai usulan aturan kontekstual dalam riset, tidak menjadi paket atau diskon baru.

**Tambahan usulan DESIGN.md:** batasi penggantian warna pada tema QR pelanggan; dokumentasikan token action/ink/surface/glass/status beserta pasangan yang diizinkan, alpha minimum .88/.90, landasan solid CTA rust di nota gelap, kontrol katalog netral, dan satu saran pendamping sekunder. Pertahankan font, katalog foto, harga tabular, Q3 kasir, Q5 tamu inline, maksimum dua wilayah blur serta semua fallback. Mockup tidak memberikan izin mengganti warna seluruh POS/KDS/manajemen.

Audit Q6: `heavy node design/mockups/check-final-a-colors.mjs` menyimpan [pasangan teks aktual](verification-final-a-colors.json); 87 pasangan teks per layar (deduplikasi pada masing-masing layar) lolos ambang 4,5:1; minimum aktual 6,155:1, termasuk komposit ekstrem kaca. Menu 390×844, tamu 390×960 dan desktop 1440×900 dirender; seluruh 10 PNG dibuka sendiri. Detail mempertahankan hero 3:2; deskripsi dipadatkan. Teks konteks checkout dipisah dari foto dan label sampel desktop dipindah ke ruang kosong setelah inspeksi. Reviewer konteks segar membuka 10/10 PNG dan memeriksa diff, sumber riset, harga, token serta hasil audit; tidak menemukan blocker konkret. Reviewer tidak menjalankan ulang browser audit, yang dilakukan designer.

### Sepuluh gambar final dan kondisi

Semua ekspor berskala 1×. Mobile **390 × 844 px**, kecuali kontrol jumlah tamu terbuka **390 × 960 px** agar katalog tetap terlihat. Desktop **1440 × 900 px**. Menu sesudah scroll adalah komposisi statis yang menunjukkan posisi header/kategori menempel dan foto lewat di belakang kaca; PNG tidak membuktikan perilaku scroll aplikasi.

| Gambar | Tujuan dan kondisi yang ditampilkan |
|---|---|
| [final-a-menu-mobile.png](final-a-menu-mobile.png) | Menelusuri katalog sesudah sedikit scroll; header dan kategori dalam satu wilayah kaca, 2 tamu dikonfirmasi, 1 espresso di keranjang, bar kaca coffee menunjukkan subtotal Rp 23.000 dan tautan pendamping kopi. |
| [final-a-menu-awal-mobile.png](final-a-menu-awal-mobile.png) | Scan pertama; “Jumlah tamu · Pilih” belum diisi, katalog dapat dilihat, keranjang kosong tanpa bar subtotal. |
| [final-a-jumlah-tamu-mobile.png](final-a-jumlah-tamu-mobile.png) | Kontrol inline terbuka; jumlah 2 sedang dipilih dan belum disimpan, instruksi wajib sebelum tambah pertama, tanpa modal sambutan. Tinggi 960 px. |
| [final-a-detail-mobile.png](final-a-detail-mobile.png) | Detail espresso, foto hero 3:2, suhu Dingin dipilih; gula wajib belum dipilih setelah percobaan tambah. Error lokal, tambahan/catatan opsional, saran croissant belum dipilih, stepper dan CTA dalam footer kaca. |
| [final-a-checkout-mobile.png](final-a-checkout-mobile.png) | Keranjang dan bayar satu halaman dengan satu rekomendasi croissant opsional; rincian biaya solid, QRIS dipilih, E-wallet dan Bayar di kasir tersedia inline. Footer kaca menampilkan total Rp 26.600 dan satu CTA bayar. |
| [final-a-qris-menunggu-mobile.png](final-a-qris-menunggu-mobile.png) | Menunggu pembayaran, total Rp 26.600, QR contoh berlabel bukan untuk pembayaran, sisa waktu contoh 04:58, aksi simpan QR dan ganti metode. |
| [final-a-kode-kasir-mobile.png](final-a-kode-kasir-mobile.png) | Menunggu pembayaran kasir; kode contoh LG–0044, total dan langkah bayar, penjelasan pesanan belum masuk dapur, aksi periksa pembayaran. |
| [final-a-berhasil-mobile.png](final-a-berhasil-mobile.png) | Status contoh pembayaran QRIS berhasil; ringkasan, kode pesanan, estimasi, akses status/struk. Ajakan klaim poin baru tampil setelah pembayaran. |
| [final-a-stok-habis-mobile.png](final-a-stok-habis-mobile.png) | Kondisi gabungan: cappuccino “Habis hari ini” tanpa aksi tambah; pemberitahuan menu belum diperbarui dengan Coba lagi, sementara 1 item keranjang tetap terlihat. |
| [final-a-menu-desktop.png](final-a-menu-desktop.png) | Katalog dua kolom foto besar, indeks kategori kiri dan nota keranjang tetap kanan. Header kaca terang dan nota mengambang kaca gelap di atas foto; 2 tamu, 1 espresso, dan saran croissant opsional pada permukaan solid. |

### Aturan kaca yang dipakai

- Material web: `backdrop-filter: blur(18px) saturate(1.15)`, beserta prefiks WebKit. Tint terang `rgba(255,252,247,.88)`, tint gelap `rgba(57,37,27,.90)`. Tinta gelap di kaca terang, teks putih di kaca gelap; muted pada kaca terang dibuat lebih gelap (`#4b3b30`).
- Kaca hanya di elemen mengambang: header/kategori, navigasi detail/pembayaran, bar keranjang, footer aksi dan panel nota desktop. Maksimal **2 wilayah blur per layar**; header dan kategori dihitung satu wilayah. Foto katalog, form, pilihan, rincian harga dan isi nota tetap solid, tanpa kaca bertumpuk di belakang teks panjang.
- Border terang 1 px memberi tepi material: putih alpha .70 pada mobile / .65 desktop; kaca gelap memakai alpha .34 / .28. Bayangan dan highlight inset terbatas pada lapisan mengambang. Foto di bawah kaca memperlihatkan material; area baca tetap tenang.
- `prefers-reduced-transparency: reduce` serta `@supports not (backdrop-filter: blur(1px))` mengganti kaca menjadi solid: terang `#fffcf7`, gelap `#39251b`, blur dimatikan. `prefers-contrast: more` juga memakai permukaan solid, blur mati dan border 2 px yang tegas. Reduced motion mematikan transisi/animasi. Cabang solid dan kontras tinggi telah dirender pada menu mobile/desktop; batas pembuktiannya dicatat di bawah.
- Kontras tint dihitung terhadap hitam/putih ekstrem: terang + tinta utama 11,68–15,40:1; terang + sekunder 7,93–10,46:1; gelap + putih 10,60–15,25:1. Ini membuktikan pasangan teks/kaca pada sumber mockup, bukan seluruh aksesibilitas aplikasi. Implementasi perlu mempertahankan alpha, warna teks opaque dan pengujian atas konten nyata.

### Lima perubahan anti-slop yang konkret

1. Katalog foto 1:1 mendapat ruang sendiri tanpa bingkai kartu berlapis; jumlah dan harga mengikuti makanan, bukan komposisi dashboard generik.
2. Tombol outline “+ Tambah” diganti kontrol tambah bulat 44 px di sudut foto; item terpilih berubah menjadi stepper dan penanda jumlah sehingga perubahan keadaan terlihat.
3. Hierarki angka diperjelas: subtotal di bar 24 px, total QRIS 40 px, nominal bukti bayar 36 px; nama makanan dan teks baca tetap terbaca, angka tabular dipertahankan.
4. Canvas ivory hangat menggantikan putih polos; kedalaman muncul dari foto meja kafe, permukaan solid dan dua lapisan kaca fungsional, tanpa glow atau gradien dekoratif.
5. Desktop ditata khusus menjadi indeks, foto besar dan nota kanan; checkout menjadi aliran biaya/metode dengan satu aksi utama, sementara poin ditunda sampai berhasil. Tidak ditambahkan rating, promo, testimoni atau urgensi rekaan.

### Usulan perubahan DESIGN.md untuk implementasi

Founder sudah mengizinkan eksplorasi liquid glass dan foto latar melalui brief ini. **DESIGN.md belum diubah oleh mockup ini**; tim perlu mencatat perubahan berikut sebelum mengubah aplikasi, agar larangan kaca dan aturan canvas putih pada versi lama tidak dibawa sebagai aturan arah final.

| Aturan lama | Usulan arah final dan batas |
|---|---|
| Media pelanggan radius 12 px | Media katalog 16 px; thumbnail kecil tetap 8/12 px sesuai konteks. Foto menu 1:1 dan hero detail 3:2 dipertahankan; deskripsi espresso dipadatkan agar saran opsional tetap muat. |
| Shell radius 18 px, CTA pelanggan pill | Wilayah mengambang utama radius 24 px; navigasi ringkas 20/22 px sesuai komposisi. CTA primer mobile radius 14 px, menggantikan pill; sumber desktop saat ini memakai varian 12 px. Radius varian perlu dijadikan token, bukan aturan seragam untuk semua kontrol. |
| Halaman pelanggan putih | Canvas ivory hangat `#faf6f0`, isi/form/biaya tetap solid terang. |
| Tanpa glassmorphism dan foto latar dekoratif | Foto meja kafe ilustratif dibatasi sebagai underlay material pada header/panel mengambang; kaca mengikuti aturan hemat dan fallback di atas. Izin eksplorasi founder bukan klaim bahwa kontras/performa aplikasi sudah teruji. |
| Plus Jakarta Sans dan palet Legend | Font tetap satu keluarga Plus Jakarta Sans lokal. **Usulan Q6 khusus QR pelanggan:** petrol diganti rust `#a83a17`, tinta coffee `#2b211b`, paper ivory dan kaca coffee; token/pasangan AA di COLOR-RESEARCH. Perubahan belum berlaku pada sistem aplikasi. |

### Sumber, provenance dan asumsi

- Sumber final statis: [final-a-mobile.html](final-a-mobile.html), [final-a-mobile.css](final-a-mobile.css), [final-a-desktop.html](final-a-desktop.html). Teks/kontrol dirender dari HTML/CSS, bukan teks dari gambar generatif; ini bukan komponen aplikasi yang sudah tersambung backend.
- Foto menu memakai ulang [assets/menu-illustrative.png](assets/menu-illustrative.png), generated melalui built-in image generation pada studi A/B. Foto meja kafe [assets/cafe-table-final.png](assets/cafe-table-final.png) adalah aset generated/ilustratif untuk latar material, bukan foto outlet yang terverifikasi. Keduanya bukan representasi menu atau lokasi nyata. Prompt foto latar: “Wide editorial Indonesian cafe tabletop, iced black espresso on the left and butter croissant on an ivory plate on the right, broad warm oat-beige tabletop, soft daylight, realistic condensation and pastry texture; no people, typography, logos, watermark, gradients or illustrations.” Built-in image generation dipakai; tidak ada edit foto lewat script. Prompt foto menu dan lisensi font tetap tercatat pada arsip di bawah.
- [assets/qris-contoh.svg](assets/qris-contoh.svg) adalah pola contoh untuk review desain, berlabel “QR contoh · Tidak untuk pembayaran”; tidak memakai payload pembayaran merchant. Tidak ada transaksi dibuat. Timer **04:58** adalah keadaan statis, bukan janji masa berlaku QR atau countdown yang telah berjalan.
- Contoh biaya tetap Rp 23.000 + service Rp 1.150 + PBJT Rp 2.415 + pembulatan Rp 35 = Rp 26.600. Quote server (ORD-03), termasuk konfigurasi pajak/service/pembulatan outlet, menjadi sumber harga final. Estimasi 10–16 menit bukan SLA; angka, menu dan status adalah data contoh.
- Format LG–0044 / QR-0044, masa berlaku, waktu pembuatan order, sinkronisasi keranjang, stok dan konfirmasi bayar mengikuti kontrak backend. Aksi Simpan QR merupakan usulan UX untuk pembayaran dari ponsel yang sama; kemampuan ekspor gambar dan pergantian metode perlu ditambahkan/diverifikasi tim saat implementasi, bukan diasumsikan sudah tersedia. Status sukses hanya boleh berasal dari server terkonfirmasi; polling, simpan QR, ganti metode, submit tamu dan kontrol lainnya belum merupakan interaksi aplikasi yang diuji.
- Gambar `arah-a-*` dan `arah-b-*`, [source.html](source.html), [capture.mjs](capture.mjs) serta [verification.json](verification.json) tetap disimpan sebagai bukti perbandingan dan riwayat keputusan. Gambar itu tidak diganti namanya menjadi final. Klaim/gate pada arsip hanya berlaku untuk ekspor lama.

### Render dan batas verifikasi final

Render ulang dari root repo: `heavy node design/mockups/capture-final-a.mjs`. [capture-final-a.mjs](capture-final-a.mjs) membuka sumber lokal di Chromium Playwright, menunggu font, lalu mengekspor sepuluh PNG tanpa dev server, database atau koneksi pembayaran. Perintah ini menimpa PNG final dan [verification-final-a.json](verification-final-a.json), serta keluar gagal bila ada error runtime/request, teks terpotong/tertutup, aset/font hilang, overflow horizontal, lebih dari dua blur, atau tidak ada foto di bawah kaca. Pemeriksaan ini tetap dilengkapi inspeksi visual manual.

`verification-final-a.json` merekam ukuran viewport/dokumen, font termuat, error runtime/request, gambar hilang, teks keluar viewport atau beririsan panel mengambang, jumlah wilayah blur, tint/blur terhitung dan irisan geometri foto di bawah kaca. Catatan geometri ini membantu memeriksa ekspor; irisan foto tidak membuktikan kualitas efek kaca atau kontras piksel. Hasil capture terakhir: 10/10 ukuran sesuai, font termuat, tanpa error runtime/request, gambar hilang, teks terpotong sebagian, atau teks tertutup panel tanpa sengaja. Setiap layar memiliki 1–2 wilayah blur dan setidaknya satu foto di bawah kaca. Bagian katalog yang sepenuhnya di luar jendela scroll tidak dihitung sebagai teks terpotong. Semua 10 PNG dibuka satu per satu oleh designer dan reviewer konteks segar; tidak ada blocker konkret tersisa pada scope gambar.

Pemeriksaan material: `heavy node design/mockups/check-final-a-glass.mjs`; [verification-final-a-glass.json](verification-final-a-glass.json) menyimpan perhitungan kontras dan computed styles. Emulasi Chromium `prefers-reduced-transparency: reduce` serta `prefers-contrast: more` menghasilkan permukaan solid, blur mati, dan border 2 px pada mode kontras tinggi. Keduanya dijalankan pada menu mobile/desktop, lalu keempat PNG di [qa/](qa/) dibuka. Cabang CSS tanpa dukungan backdrop-filter juga dipaksa aktif dan computed style dicek; ini **bukan** pengujian browser lama sesungguhnya.

Gate Q6 mengikuti RYUX; bukti desain berasal dari brief, standar tim, benchmark yang sudah ada, render Chromium dan riset tertaut. Tidak ada observasi pelanggan Legend baru.

| Area | Hasil | Bukti dan batas |
|---|---|---|
| PRODUCT | PASS pada scope mockup | Permintaan Q6 dan keputusan Q3/Q5 terpenuhi; bukti lokal untuk uplift **None**, riset transfer **Thin**. |
| UX | PASS pada keadaan gambar | Saran opsional dan sekunder, harga jelas, tidak memblokir pembayaran. Belum diuji pengguna. |
| UI | PASS pada kanvas diminta | Point of view: task UI katalog foto, ivory/coffee dan aksen rust. |
| DESIGN SYSTEM | PASS pada sumber mockup | Token HEX + OKLCH setara; usulan perubahan sistem dicatat, DESIGN.md tidak diubah. |
| ACCESSIBILITY | NOT VERIFIED untuk aplikasi | Pasangan teks terlihat ≥6,15:1; pasangan status yang diusulkan ≥6,19:1 dan kontrol penting ≥3:1. Keyboard/screen reader/zoom bukan bukti dari PNG. |
| RESPONSIVE | NOT VERIFIED di luar kanvas | Render 390×844, 390×960 dan 1440×900 lulus; belum 320 px atau fluid layout. |
| EDGE CASES | PASS pada keadaan diminta | Tamu belum diisi, validasi gula, stok habis/jaringan, dua jalur tunggu bayar, sukses. |
| CODE QUALITY | N/A aplikasi | Sumber statis dan script render diaudit; tidak ada kode aplikasi berubah. |
| VISUAL QA | PASS | Chromium Playwright; sepuluh PNG dan empat fallback dibuka sendiri, geometri/error/font/aset diperiksa. |
| ANTI-SLOP | PASS pada scope revisi | Tidak ada bukti sosial/urgensi/diskon rekaan; satu saran, harga tetap jujur. |
| FINAL | NOT VERIFIED untuk produk keseluruhan | Artefak revisi selesai untuk review visual; belum validasi perilaku/pembelian pengguna. |

Hitungan konsistensi Q6: 1 hue aksi (rust), 3 hue status terpisah (amber/hijau/merah), 1 keluarga netral hangat, 1 keluarga font, 1 gaya ikon garis, 0 emoji di antarmuka, 0 gradien dekoratif; skala radius tetap 4/6/8/12/14/16/18/20/22/24 px dan lingkaran/pill untuk kontrol. Hanya satu hierarki angka dominan per layar; label rekomendasi menyatakan opsional dan harga tambahan. Kontrol katalog tetap netral agar aksen tidak tersebar ke semua item.

PNG dan sumber statis belum membuktikan interaksi aplikasi, transaksi, countdown, pemulihan jaringan, sinkronisasi sesi, uji pengguna, keyboard/fokus/screen reader, zoom 200%, lebar 320 px, semua tema atau performa perangkat. Tidak ada klaim seluruh aksesibilitas maupun responsivitas aplikasi telah diuji.

## Arsip studi A/B — sebelum keputusan Q4 dan Q5

Studi awal berisi **10 gambar utama + 1 layar kode kasir tambahan**. Mobile selebar 390 px: menu dan detail A setinggi 960 px; layar mobile lain 844 px. Desktop 1440 × 900, skala 1×. Deskripsi, gate dan rekomendasi berikut merekam keadaan studi awal; keputusan pending di tahap itu sudah digantikan Q4 dan Q5 di atas.

### Arah A — Katalog foto

Menu menjadi katalog foto dua kolom di mobile, dengan kategori berbentuk pill, nama dan harga tepat di bawah gambar, lalu kontrol jumlah. Susunan ini mendahulukan pengenalan makanan secara visual dan memberi ruang untuk menelusuri menu sambil duduk di meja. Detail memakai foto lebar, kelompok opsi berbingkai, dan error lokal; hasil pembayaran terpusat dengan ringkasan di permukaan netral. Desktop memperluas katalog menjadi empat kolom foto persegi di samping keranjang tetap. A mempertahankan karakter foto yang paling dekat dengan mode **Hangat & Visual**, sambil memangkas lapisan header dan semua ajakan sebelum pembayaran.

### Arah B — Menu & nota meja

Menu menjadi daftar dengan nama, deskripsi, harga, dan kontrol di kiri, serta foto persegi di kanan. Pelanggan dapat membandingkan isi minuman dan makanan sambil melihat item yang sudah dipesan tanpa membuka detail. Kategori memakai garis bawah; detail menempatkan thumbnail dan ringkasan berdampingan sehingga opsi muncul lebih awal. Checkout dan bukti bayar memakai aliran nota dengan pemisah garis putus, bukan kartu bulat berlapis; hasil pembayaran rata kiri. Desktop menggunakan indeks kategori, daftar menu, dan nota keranjang dalam tiga wilayah. B mengutamakan pembacaan dan kustomisasi, dengan biaya berupa jumlah menu yang terlihat lebih sedikit daripada grid A.

**B adalah usulan penyimpangan pola untuk diputuskan founder, bukan klaim patuh penuh terhadap DESIGN.md.** DESIGN.md §4 mengunci grid foto pelanggan dan hero detail; daftar thumbnail dan ringkasan thumbnail B sengaja diusulkan sebagai alternatif pada tahap arah visual ini. Jika B dipilih, CTO perlu mencatat persetujuan pola tersebut dan memperbarui DESIGN.md sebelum implementasi. A memakai foto kartu 1:1 dan foto detail 3:2.

Kedua arah berbeda pada model katalog, urutan informasi detail, navigasi kategori, komposisi desktop, serta bentuk ringkasan pembayaran. Palet, keluarga font, harga, dan aturan transaksi sengaja sama agar founder membandingkan struktur, bukan pergantian merek.

### Daftar gambar dan kondisi

Nomor celah mengacu pada [REPORT.md](../benchmark/REPORT.md), bagian “Celah Legend”.

| Layar | Tujuan dan kondisi penting | Arah A | Arah B | Celah yang ditutup |
|---|---|---|---|---|
| Menu mobile | Menelusuri menu setelah jumlah tamu dikonfirmasi; 1 espresso sudah masuk keranjang. Harga dan bar subtotal terlihat; kartu berubah menjadi stepper. | [arah-a-menu-mobile.png](arah-a-menu-mobile.png) | [arah-b-menu-mobile.png](arah-b-menu-mobile.png) | #1, #4, #5, #7; juga #12–14 |
| Detail mobile | Mengatur minuman; suhu Dingin dipilih, gula wajib belum dipilih setelah percobaan tambah. Error berada di grup gula. Tambahan dan catatan opsional tetap terlihat. | [arah-a-detail-mobile.png](arah-a-detail-mobile.png) | [arah-b-detail-mobile.png](arah-b-detail-mobile.png) | #6; mempertahankan validasi wajib, juga #12 |
| Keranjang / checkout mobile | Meninjau item, kuantitas, estimasi, semua biaya, dan metode bayar pada satu halaman. QRIS terpilih; e-wallet dan kasir tersedia. | [arah-a-checkout-mobile.png](arah-a-checkout-mobile.png) | [arah-b-checkout-mobile.png](arah-b-checkout-mobile.png) | #2, #3, #8, #9; juga #10 dan #12 |
| Pembayaran berhasil mobile | Konfirmasi pembayaran QRIS, total, kode pesanan, estimasi, status pesanan dan struk. Ajakan klaim poin baru muncul setelah pembayaran. | [arah-a-pembayaran-berhasil-mobile.png](arah-a-pembayaran-berhasil-mobile.png) | [arah-b-pembayaran-berhasil-mobile.png](arah-b-pembayaran-berhasil-mobile.png) | #8, #9; juga #12 |
| Menu desktop | Menelusuri menu pada lebar 1440 dengan keranjang tetap di kanan; tidak membentangkan kolom mobile. | [arah-a-menu-desktop.png](arah-a-menu-desktop.png) | [arah-b-menu-desktop.png](arah-b-menu-desktop.png) | #1, #4, #5, #7; juga #12–14 |
| Kode kasir, tambahan | Menunggu uang diterima kasir. Kode LG–0044, total, dan instruksi jelas; pesanan belum masuk dapur. | — | [arah-b-kode-kasir-mobile.png](arah-b-kode-kasir-mobile.png) | #10, sesuai persetujuan founder Q3 |

### Keputusan desain

1. **Satu akses keranjang yang terlihat.** Total pada bar menu adalah **subtotal menu**, diberi label eksplisit karena harga belum termasuk pajak dan service. Bar menjadi CTA tunggal di menu mobile; desktop menampilkan subtotal dan CTA di nota kanan. Kartu berisi item menampilkan jumlah. Alternatif tab keranjang saja ditolak berdasarkan screenshot Legend `06-after-add-mobile.jpg` dan ESB `06-menu-with-cart-bar-mobile.jpg` (bukti kuat: dua layar yang dijalani).
2. **Checkout adalah satu halaman keputusan.** Keranjang, harga, pilihan pembayaran dan satu tombol akhir berada pada layar yang sama; tidak ada dialog metode setelah tombol Bayar. Footer menampilkan total dan CTA metode terpilih, tanpa tab bar. Promo dan split bill tetap sekunder; tawaran member hanya setelah sukses. Dasar: perbandingan checkout ESB dan Legend dalam REPORT (bukti kuat untuk perbedaan struktur, belum diuji pada pelanggan Legend).
3. **Opsi wajib dan status pembayaran tidak disamarkan.** Radio untuk pilihan tunggal, pesan error langsung pada kelompok gula, footer detail menempel di bawah, dan harga tombol mengikuti pilihan. QRIS adalah bawaan; **Bayar di kasir tetap tersedia dan sudah disetujui founder Q3**. Saat kasir dipilih, CTA berubah menjadi “Buat kode bayar di kasir”; halaman kode menjelaskan bahwa dapur menunggu kasir menerima uang. Tidak ada label “opsional / dapat dihapus” pada metode kasir.

### Pemetaan seluruh prioritas 1–9

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

### Harga dan aturan contoh

- Semua item katalog contoh memakai format `Rp 23.000`, termasuk espresso yang konsisten pada menu, detail, keranjang dan struk. Ekstra espresso opsional `+ Rp 5.000` belum dipilih; bila dipilih, harga tombol menjadi `Rp 28.000`.
- Rincian contoh mengikuti hasil benchmark Legend: Rp 23.000 + service 5% Rp 1.150 + PBJT 10% Rp 2.415 + pembulatan Rp 35 = **Rp 26.600**. Dasar pajak pada contoh termasuk service; angka ini **bukan penetapan kebijakan pajak baru**. Implementasi harus menggunakan quote server (ORD-03), termasuk bila konfigurasi outlet berbeda.
- Estimasi 10–16 menit adalah data contoh dari screenshot benchmark, bukan SLA. Kode QR-0044 / LG–0044 hanya ilustrasi; format final dan masa berlaku kode mengikuti kontrak backend. Tidak ada QR pembayaran nyata atau transaksi yang dibuat.
- Mode contoh bayar di muka: pembayaran terkonfirmasi dahulu, baru diteruskan ke dapur. Khusus metode kasir: founder sudah menyetujui pelanggan menunjukkan kode, kasir menerima uang, kemudian pesanan masuk dapur.
- Sesi bersama: “Ditambahkan Anda” dipertahankan. Item milik tamu lain, harga berubah, stok habis, dan konflik versi perlu mengikuti sumber server pada implementasi.

### Arah visual dan aset

- Mengikuti palet dan tipografi `DESIGN.md`: Plus Jakarta Sans, body utama 16 px, judul 26 px mobile / 40 px desktop, teks bantu 12–14 px, angka tabular, tinta `#1c1b19`, abu hangat, satu area CTA petrol `#0f5e68`. Pilihan kategori netral. Foto menu tanpa bingkai kartu. Tidak ada kaca, gradien, toggle tema atau dekorasi merek baru.
- Foto **generated / ilustratif**, bukan foto menu outlet: [assets/menu-illustrative.png](assets/menu-illustrative.png). Dibuat melalui built-in image generation; teks dan kontrol dirender deterministik dari [source.html](source.html), sehingga tidak bergantung pada teks acak dari gambar generatif. PNG adalah artefak review; HTML adalah sumber desain statis, bukan kode aplikasi.
- Prompt aset: “Premium natural Indonesian cafe menu photography, exact 2 × 2 contact sheet: iced espresso, cappuccino with latte art, toasted chicken sandwich with lettuce and tomato, butter croissant; warm daylight and cream ceramic plates; centered subjects with breathing room; no typography, logo, or watermark.” Prompt dinormalisasi; permintaan lengkap menyebut objek, pencahayaan, komposisi dan batas yang sama.
- Font berasal dari paket Plus Jakarta Sans yang sudah ada di repo; lisensi OFL disalin ke [assets/FONT-LICENSE.txt](assets/FONT-LICENSE.txt). Tidak ada font jaringan saat render.
- Provenance: **Observed** — REPORT, REFERENCES, PRD §10, DESIGN.md; screenshot ESB cart bar, Legend detail / checkout. **Inferred** — pilihan struktur A/B dan susunan desktop. **Generated** — foto ilustratif. Rujukan Starbucks, GoFood/GrabFood dan McDonald's dari REFERENCES tidak diperlakukan sebagai alur yang sudah diuji.

### Interaksi lanjutan untuk implementasi

- Pencarian: lintas seluruh menu, reset kategori ke Semua, tanpa hasil palsu dari filter kategori. Filter label dibuka dari tombol Filter dan harus memperlihatkan status filter aktif.
- Item: saat Tambah ditekan tanpa gula, pertahankan suhu dan catatan, tampilkan error, fokuskan kelompok gula. Setelah semua wajib valid, tambah ke keranjang bersama, update stepper dan bar; cegah tambah berulang saat request berlangsung.
- Checkout: perubahan item atau metode menghitung ulang quote; input tidak hilang saat gagal. QRIS → “Bayar Rp 26.600 dengan QRIS”; e-wallet → “Pilih e-wallet dan bayar”; kasir → “Buat kode bayar di kasir”. QRIS / e-wallet gagal menawarkan coba lagi, metode lain, atau kasir dengan keranjang dipertahankan.
- Pembayaran: status memverifikasi pembayaran tampil selama request; sukses hanya dari status server terkonfirmasi. Menunggu QRIS, kedaluwarsa dan offline mengikuti kontrak pembayaran saat implementasi. Tidak ada simulasi transaksi pada sumber mockup ini.
- Keranjang kosong: teks “Keranjang meja masih kosong” + “Pilih menu”. Loading: skeleton mengikuti ukuran foto, item dan bar harga. Stok habis: label Habis dan tombol tidak dapat tambah, dengan alasan; stok habis saat checkout menampilkan perubahan sebelum quote baru dikonfirmasi. Sesi habis: “Sesi meja berakhir” + instruksi scan QR meja lagi. Keadaan ini dideskripsikan untuk handoff, belum diekspor sebagai layar tambahan pada tahap arah visual.
- Jeda gerak yang disarankan 150–250 ms hanya untuk feedback jumlah, error, serta masuk / keluar overlay; hormati reduced motion. PNG tidak membuktikan gerak, keyboard, fokus, live region atau sinkronisasi sesi.

### Pemeriksaan dan batas

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

### Catatan keputusan studi awal (historis)

1. Studi awal merekomendasikan A untuk katalog foto Hangat & Visual, dengan B sebagai alternatif baca/kustomisasi. Founder kemudian **memilih A pada Q4**; tidak ada pilihan A/B yang masih pending. Penilaian ini bukan hasil uji konversi.
2. Usulan jumlah tamu inline kemudian **disetujui pada Q5**: wajib sebelum item pertama, tanpa sheet sambutan.
3. Format kode kasir, masa berlaku, quote biaya dan waktu pembuatan order tetap urusan kontrak teknis. Persetujuan Bayar di kasir pada Q3 tetap berlaku.

## Backoffice finance — rekonsiliasi payout (1003)

- Layar: [Flag rekonsiliasi dan clearance dua orang](backoffice/payout-recon-clearance.html). Tujuan: memeriksa alasan flag per batch, mengusulkan clearance, lalu meminta orang lain menyetujui.
- Kondisi utama: normal, kosong, memuat, gagal, validasi, sukses; pengusul sendiri tidak bisa menyetujui, data berubah menuntut usulan baru, dan flag terbuka ulang membatalkan clearance lama.
- Arah mengikuti pola `account-role-mappings` yang diminta; [catatan desain dan kontrak](backoffice/payout-recon-clearance-notes.md) menjelaskan sumber, batas data, dan gerbang founder.
- Render: `heavy --browser node design/mockups/backoffice/payout-recon-clearance-render.mjs`, desktop 1280 dan mobile 390. Semua data adalah ilustrasi, tanpa panggilan API atau pembayaran.
