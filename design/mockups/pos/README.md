# Mockup POS — pembayaran lengkap dan shift kasir

Mockup untuk review founder, bukan implementasi aplikasi. Ukuran utama **1280 × 800**, tablet landscape, jarak baca sekitar 60 cm. Cabang `ux/customer-order-benchmark`. Seluruh identitas, nominal, waktu, bank dan nomor referensi di layar adalah **contoh data**, kecuali isi kode pelanggan yang mengikuti gambar acuan. Tidak ada nomor pembayaran aktif.

## Daftar layar

| PNG | Tujuan dan kondisi penting |
| --- | --- |
| [payment-methods.png](payment-methods.png) | Memilih QRIS, Virtual Account, E-wallet, Kartu kredit/debit online, Tunai atau EDC. DP lunas terpakai, sisa bayar selalu terlihat. |
| [payment-split.png](payment-split.png) | Pembayaran gabungan: DP Rp100.000 + QRIS terkonfirmasi Rp100.000 + sisa tunai Rp48.000. |
| [payment-cash.png](payment-cash.png) | Menerima uang Rp50.000 untuk alokasi Rp48.000; kembalian Rp2.000, belum lunas sebelum dikonfirmasi. |
| [payment-qris-active.png](payment-qris-active.png) | Menunggu QRIS di customer display, masa berlaku dan cek status. Tidak ada QR pembayaran palsu dalam mockup. |
| [payment-qris-expired.png](payment-qris-expired.png) | QR lama tidak aktif; memeriksa status lalu memperbarui QRIS otomatis. |
| [payment-failed.png](payment-failed.png) | Gagal terkonfirmasi, DP tetap terpakai; pulih dengan QRIS baru atau metode lain. |
| [payment-success.png](payment-success.png) | Pembayaran lengkap lunas: sisa Rp0, rincian alokasi, uang diterima dan kembalian, cetak struk/transaksi baru. |
| [payment-va.png](payment-va.png) | Nomor VA contoh dan batas waktu; menunggu konfirmasi penyedia, bukan bukti transfer. |
| [edc-select.png](edc-select.png) | Pilih metode kartu/QRIS dan terminal salah satu bank sebelum nominal dikirim. |
| [edc-success.png](edc-success.png) | Hasil ECR berhasil, lunas, referensi bank dan kartu tersamar, lanjut struk. |
| [edc-waiting.png](edc-waiting.png) | Nominal Rp148.000 terkunci, terminal terpilih, pelanggan menyelesaikan di mesin. |
| [edc-unknown.png](edc-unknown.png) | Koneksi terputus, hasil belum pasti. Wajib cek status sebelum ulang atau pindah metode. |
| [edc-standalone.png](edc-standalone.png) | Sesudah pembayaran manual berhasil: referensi bank wajib, PIN supervisor wajib, ditandai rekonsiliasi. |
| [cashier-code-found.png](cashier-code-found.png) | Terima kode LG–0044 dari QR pelanggan, cocokkan Meja A01 dan Rp26.600, lanjut bayar. |
| [cashier-code-invalid.png](cashier-code-invalid.png) | Kode tidak ditemukan, input dipertahankan, koreksi dan cari ulang. |
| [shift-open.png](shift-open.png) | Buka shift dengan modal awal fisik Rp500.000 dan terminal terdaftar. |
| [shift-active.png](shift-active.png) | Pilih kas masuk/keluar, nominal dan alasan wajib; riwayat pergerakan kas. |
| [shift-blind.png](shift-blind.png) | Hitung pecahan dan uang fisik Rp2.230.000 tanpa saldo sistem atau petunjuk selisih. |
| [supervisor-approval.png](supervisor-approval.png) | Akses supervisor sesudah hitungan dikirim: kas kurang Rp20.000, alasan + PIN, persetujuan mengunci hasil. |
| [supervisor-day-close.png](supervisor-day-close.png) | Rekap kanal/metode, settlement dua bank, stok opsional dan aksi tutup hari. |
| [supervisor-day-closed.png](supervisor-day-closed.png) | Rekap lokal tersimpan, hasil batch per bank, antrean akuntansi dan standalone belum cocok tetap jelas. |

## Arah dan tiga keputusan utama

1. **Panel tagihan tetap di kiri, satu pekerjaan utama di kanan.** Dibanding dialog berlapis atau halaman terpisah untuk setiap metode, panel tetap menjaga total, DP dan sisa bayar terbaca saat kasir berganti metode. Target 60 px, body 18 px, angka tabular. Satu CTA petrol; pilihan metode dan tab netral. Bukti: `DESIGN.md` density Kontras dan shell POS yang ada. Keyakinan tinggi untuk konsistensi, sedang untuk kecepatan karena belum uji kasir sungguhan.
2. **Status transaksi menentukan aksi, bukan dugaan kasir.** Gagal terkonfirmasi dapat diulang; EDC belum pasti wajib cek status dengan nominal terkunci dan transaksi yang sama. Standalone hanya setelah tidak ada permintaan sebelumnya atau hasil sebelumnya gagal/batal, lalu bukti pembayaran berhasil diverifikasi supervisor. DP adalah dana lunas yang dialokasikan, bukan charge baru. Bukti kuat: PRD PAY-02, PAY-04, EDC-01–04. Trade-off: pemulihan butuh langkah status dahulu.
3. **Pisahkan hitungan kasir, review supervisor dan penutupan hari.** Kasir hanya melihat hitungannya sendiri. Supervisor melihat angka sistem sesudah kirim dan mengunci hasil dengan alasan/PIN. Rekap tersimpan, batch settlement berhasil dan akuntansi tersinkron adalah status berbeda. Bukti kuat: PRD POS-03, POS-05, EDC-06, alur E. Trade-off: supervisor membuka layar khusus saat ada selisih.

Visual mengikuti arah yang sudah ditetapkan `DESIGN.md` v3, sehingga tidak membuka dua arah merek baru. Palet pelanggan QR tidak dibawa ke POS. Font lokal Plus Jakarta Sans memakai aset yang sudah ada di `../assets/`. PNG dirender dari HTML/CSS agar teks Indonesia dan nominal dapat diperiksa persis; bukan gambar UI hasil generasi bitmap. HTML adalah sumber mockup statis, tidak menyambung pembayaran, PIN, bank, atau database.

## Asumsi dan batas desain

- Enam metode dimunculkan sesuai brief. PRD rilis awal menyebut QRIS/VA melalui DOIT, e-wallet lewat QRIS, dan kartu fisik lewat EDC; e-wallet langsung/kartu online disebut P1. Mockup mengasumsikan konfigurasi penyedia telah mengaktifkan metode terpisah tersebut. Frontend perlu mengambil daftar aktif dari backend, bukan hardcode keenam metode.
- EDC memakai Bank A/EDC 01 sebagai contoh terminal. Tutup hari memakai BCA dan Mandiri sebagai contoh dua bank, bukan pengumuman bank yang sudah disetujui. PIN tersamar, kode persetujuan dan referensi adalah data contoh.
- DP yang dipakai telah lunas dan terhubung ke reservasi yang sesuai. Contoh tagihan Rp248.000 dikurangi DP Rp100.000 menjadi Rp148.000. QRIS Rp100.000 + tunai bersih Rp48.000 menyelesaikan sisa, uang diterima Rp50.000 menghasilkan kembalian Rp2.000. Tidak ada skenario DP lebih besar dari tagihan dalam gambar.
- Kode “Bayar di kasir” mengikuti `../final-a-kode-kasir-mobile.png`: LG–0044, Meja A01, Espresso dingin, Rp26.600. Pencarian kode diasumsikan tersedia per outlet; kontrak lookup khusus belum ditemukan. Tidak menciptakan aturan umur kode. Pesanan masih belum masuk dapur sampai pembayaran dikonfirmasi, sesuai keputusan founder Q3 yang sudah final.
- Kasir sudah masuk dengan PIN sebelum buka shift. Pecahan kecil dan koin digabung sebagai nominal; alternatif input total diusulkan untuk perangkat berbeda. Ini pilihan desain yang perlu diselaraskan dengan kontrak blind count.
- Yang menutup hari diasumsikan outlet manager dengan hak akses yang sesuai. Cutoff hari usaha mengikuti konfigurasi outlet, tidak diasumsikan pukul 00.00. Pemotongan stok default tidak dipilih di mockup.
- Layar kas masuk dan keluar memakai form yang sama; gambar menunjukkan tab kas keluar, tab kas masuk tetap tersedia. Riwayat hanya menampilkan pergerakan terbaru, bukan saldo sistem.
- Layar EDC menggambarkan kartu; pilihan kartu/QRIS serta dua terminal bank diatur sebelum pengiriman. QRIS EDC mengikuti status yang sama dengan kartu. Pilihan terminal tidak boleh diubah setelah kirim.
- Fokus PNG pada tablet landscape 1280×800 sesuai brief. Adaptasi ponsel, dark mode, receipt cetak, error PIN, DP lebih bayar, sesi habis dan offline lengkap belum digambar. Status gagal, menunggu, kedaluwarsa, kode tidak ditemukan, selisih dan antrean sinkron sudah diperlihatkan. Interaksi tombol adalah ilustrasi alur, bukan prototype fungsional.

## Pertanyaan untuk founder melalui CTO

1. **Sisa DP yang melebihi tagihan** — Apakah tetap menjadi kredit reservasi/pelanggan atau diproses refund dengan persetujuan? Gambar terkait: [Pembayaran](payment-methods.png). Tidak diasumsikan otomatis hangus atau menjadi kembalian tunai.
2. **Tutup hari** — Siapa penanggung jawab final dan cutoff hari usaha yang diinginkan outlet? Gambar terkait: [Tutup harian](supervisor-day-close.png). Usulan mockup: outlet manager, waktu mengikuti konfigurasi outlet.
3. **Hitung blind count** — Apakah wajib rincian semua pecahan/koin atau boleh input total fisik sebagai alternatif? Gambar terkait: [Blind count](shift-blind.png). Usulan mockup: rincian pecahan utama dengan nominal gabungan untuk pecahan kecil.

## Sumber yang dibaca

- `DESIGN.md` v3, `design/REFERENCES.md`, standar `~/.agents/team/ui-standard.md`.
- `apps/web/src/routes/_ops/pos.*.tsx` dan OperationsShell. Index POS saat ini berupa AreaIndexPage, belum memiliki alur pembayaran penuh; mockup memperluas shell dan density yang ada.
- `docs/PRD.md` §11 POS, §13 pembayaran/EDC, reservasi/DP dan alur E. Penomoran F11–F15 ringkasan berbeda dari nomor bab; kebutuhan dirujuk menurut judul dan kriteria POS/PAY/EDC.
- `packages/shared/src/pos/schemas.ts` untuk hitung shift, approval dan rekap harian. Bead yang terkait brief: legend-6c0, legend-m0k, legend-b0au, legend-94qt (status tidak diubah oleh designer).
- Panduan RYUX Design dan DesainPakeAI design-quality. Tidak menambah referensi tren atau mengganti arah merek yang sudah disetujui.

## Reproduksi dan pemeriksaan

Jalankan dari root repo:

```sh
heavy node design/mockups/pos/render.mjs
```

Renderer menggunakan Chromium Playwright yang terpasang di repo, tanpa dev server/API/database, memilih state dari DOM dan menulis PNG 1280×800. `verification.json` mencatat pemeriksaan geometri viewport dan rasio kontras teks yang benar-benar dirender. Pemeriksaan tersebut bukan audit aksesibilitas interaksi penuh. Batas field dan tombol memakai token Kontras, dan status mempunyai teks/simbol selain warna.

Seluruh 21 PNG final dibuka sendiri satu per satu oleh designer utama saat penggabungan. Subagent juga meninjau area masing-masing; review kedua memeriksa aritmetika DP/split/kas, anti penagihan ganda EDC, blind count, selisih dan settlement. Tidak ada teks acak atau pemotongan yang terlihat pada pemeriksaan final.

Hasil render final, 8 November 2026:

- **21/21 PNG**, masing-masing 1280×800; daftar README, berkas PNG dan manifest cocok.
- **808 pemeriksaan teks**, rasio kontras terendah **4,77:1**, tanpa kegagalan kontras teks atau elemen melewati viewport.
- Renderer selesai dengan exit code 0 melalui `heavy`; pemeriksaan mengharuskan satu layar aktif, konten terlihat, minimal 15 pemeriksaan teks per layar, serta tidak ada error JavaScript. Ini mencegah gambar kosong dianggap lulus.
- Semua temuan review diperbaiki: nominal/DP tetap konsisten pada pesan gagal; EDC standalone tidak boleh mengulang transaksi berhasil/belum pasti; settlement dipicu dari tutup hari dengan hasil per bank; benturan nama variabel mockup pembayaran diselesaikan sebelum ekspor final.
- Gambar statis tidak membuktikan interaksi keyboard, screen reader, integrasi bank, atau perilaku backend. Build dan tes aplikasi tidak dijalankan karena tidak ada kode aplikasi yang berubah.

## Keputusan founder (8 Nov 2026)
- Mockup POS kasir disetujui (Q10).
- Q7: DP reservasi yang melebihi tagihan menjadi saldo pelanggan untuk kunjungan berikutnya.
- Q8: Blind count tutup shift wajib per pecahan.
- Q9: Tutup hari usaha oleh manajer outlet; batas hari usaha pukul 04.00.

## Kasir utama dan captain — WS-04

Mockup statis berikut memakai data contoh dan melanjutkan arah visual POS yang disetujui. Kasir mencari dan menyusun pesanan; captain memilih meja, menambah item ke sesi yang berjalan, serta menangani panggilan. HTML tidak terhubung ke sistem pesanan.

| Sumber dan gambar | Tujuan dan kondisi |
| --- | --- |
| [Kasir utama](cashier-main.html) · [Tablet](cashier-main-desktop.png) · [Ponsel](cashier-main-mobile.png) | Katalog, kanal, keranjang, catatan dan penahanan item per course. Stok habis ditandai pada katalog. |
| [Keranjang kosong](cashier-main-empty-desktop.png) · [Modifier wajib](cashier-main-modifier-desktop.png) · [Modifier ponsel](cashier-main-modifier-mobile.png) | Memulai pesanan dan memperbaiki pilihan yang wajib diisi. |
| [Kasir offline](cashier-main-offline-desktop.png) · [Offline ponsel](cashier-main-offline-mobile.png) · [Takeaway](cashier-main-takeaway-desktop.png) · [Keranjang ponsel](cashier-main-cart-mobile.png) | Peringatan umur katalog, nomor panggilan, dan ringkasan untuk layar kecil. |
| [Captain](captain.html) · [Meja](captain-tables.png) · [Tambah item](captain-order.png) · [Tinjau](captain-review.png) | Memilih meja terisi, menambah pesanan dan mengirim ke dapur. |
| [Item ditahan](captain-held.png) · [Panggilan](captain-calls.png) · [Captain offline](captain-offline.png) | Melepas item ditahan, menerima panggilan waiter dan bekerja saat internet terputus. |

### Keputusan dan asumsi WS-04

1. **Katalog dan keranjang berdampingan di tablet; keranjang menjadi tampilan sendiri di ponsel.** Harga dan kanal tetap dekat dengan pesanan tanpa mempersempit katalog di layar kecil.
2. **Pilihan wajib dan stok habis dijelaskan di tempat.** Pesan modifier menunjukkan apa yang harus dipilih; menu habis tetap terlihat dengan status teks, sehingga kasir tidak perlu menebak.
3. **Koneksi dan pekerjaan dapur dibedakan.** Peringatan menyebut waktu katalog terakhir dan bahwa penjualan dapat berlanjut; item yang ditahan ditampilkan terpisah dari item yang dikirim.

Asumsi untuk review founder: nama menu, harga, nomor meja dan waktu hanya contoh; pengelompokan course dan nomor panggilan adalah contoh tampilan. Kondisi offline menggambarkan internet terputus saat edge outlet masih tersedia, bukan putusnya sambungan ke edge. Tata letak dan istilah perlu divalidasi pada alur kerja outlet sesungguhnya.

Render ulang WS-04 dari root repo dengan `heavy node design/mockups/pos/cashier-main-render.mjs` dan `heavy node design/mockups/pos/captain-render.mjs`. Renderer masing-masing memeriksa error JavaScript dan luapan; renderer kasir juga memeriksa pemuatan foto. Keduanya memakai paket Playwright lokal di `.pnpm` karena tautan paket root pada workspace ini rusak. Gambar diperiksa visual pada 1280 × 800 dan 390 × 844; target jumlah diperbesar ke 56 px sesudah audit. Mockup statis belum membuktikan interaksi, aksesibilitas menyeluruh, atau perilaku backend.
