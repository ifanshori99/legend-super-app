# Member tukar poin di kasir — mockup 1152

Untuk review desain oleh founder melalui CTO. Buka [index.html](index.html) secara lokal. Semua data dan QR adalah ilustrasi; prototipe tidak mengakses API dan tidak melakukan transaksi. Ruang kerja: `ux/customer-order-benchmark`. Tidak ada commit, push, atau perubahan kode aplikasi.

## Rekomendasi dan keputusan desain

**A: tagihan muncul sesudah QR identitas member dipindai.** Member memeriksa outlet, nomor tagihan, dan sisa bayar; memilih poin; kemudian menunjukkan QR penukaran khusus tagihan serta jumlah tersebut. Dibanding mengetik kode, alur ini mengurangi input dan risiko salah ketik. Konsekuensinya, diperlukan API untuk melihat tagihan yang ditautkan ke member. Ini rekomendasi untuk disetujui, belum keputusan founder.

**B: kode tagihan pendek dari kasir.** Ditampilkan pada layar perbandingan dan contoh input/konfirmasi terpisah. Ini alternatif usulan, belum kemampuan aplikasi. Membutuhkan lookup aman, pembatasan percobaan, masa berlaku, dan konfirmasi sebelum penukaran. Contoh kode dikunci agar tidak memberi kesan pencarian sungguhan.

Tiga keputusan utama:

1. Outlet, nomor tagihan, dan sisa bayar mendahului pemilihan poin supaya persetujuan merujuk tagihan yang benar. Basis: brief dan kontrak POS; keyakinan tinggi terhadap kebutuhan, sedang terhadap pola penemuan order.
2. QR identitas dan QR penukaran berada di layar berbeda. QR penukaran memuat jumlah, konteks tagihan, masa berlaku 120 detik, dan keterangan sekali pakai. Basis: brief/kontrak; membuat QR belum mendebit poin.
3. Mempertahankan bahasa visual member yang ada: Plus Jakarta Sans, ivory/rust Cafe Legend, kaca hanya di navigasi. Desktop dua kolom; mobile satu kolom dengan konteks mendahului aksi. Basis visual: satu keluarga mockup member; bukti visual tipis, bukan penelitian pengguna. Base petrol di DESIGN.md tidak diganti; ini kesinambungan tema customer Cafe Legend sesuai brief.

## Layar dan keadaan

Setiap keadaan tersedia melalui `index.html?state=<nama>` dan diekspor sebagai `<nama>-390.png` serta `<nama>-1280.png`.

| Nama                | Tujuan/kondisi utama                                                 |
| ------------------- | -------------------------------------------------------------------- |
| `tagihan-aktif`     | Memeriksa tagihan yang sudah ditautkan kasir                         |
| `pilih-poin`        | Memilih 1–1.240 poin; rincian dan QR mengikuti input                 |
| `qr-aktif`          | Menunjukkan QR penukaran 120 detik, sekali pakai                     |
| `tanpa-tagihan`     | Mengarahkan member menunjukkan QR identitas                          |
| `qr-member`         | Identitas untuk penautan, tanpa otorisasi penukaran                  |
| `poin-kurang`       | Menjelaskan input 1.500 melebihi saldo 1.240                         |
| `qr-kedaluwarsa`    | Menyembunyikan QR lama dan meminta pemeriksaan status                |
| `offline`           | Menutup penukaran; saldo terakhir ditandai belum diperbarui          |
| `gagal`             | Hasil permintaan belum pasti; periksa status sebelum mengulang       |
| `loading`           | Menunggu data/status; tautan hasil adalah simulasi yang diberi label |
| `sudah-dipakai`     | Server mengonfirmasi potongan, QR tidak dapat dipakai ulang          |
| `poin-setelah`      | Mempertahankan saldo 740 dan sisa tagihan Rp135.000                  |
| `perbandingan-alur` | Membandingkan A dengan B dalam satu layar                            |
| `kode-tagihan`      | Contoh input kode pendek alternatif B                                |
| `kode-hasil`        | Konfirmasi outlet dan tagihan sebelum memilih poin                   |

## Data contoh dan batas uang

Sari Wulandari, Cafe Legend Kemang, tagihan #LG-0248/meja 08. Total Rp185.000; pembayaran sebelumnya Rp0; sisa tagihan Rp185.000. Saldo 1.240 poin, nilai contoh program Rp100/poin. Pilihan awal 500 poin memberi potongan Rp50.000, menyisakan Rp135.000 dan 740 poin. Identitas outlet/member/tagihan adalah data ilustratif; nilai program bukan aturan universal.

Kontrak yang dibaca dari `origin/milestone/m1`: `apps/api/src/services/pos-points.service.ts`, route/validator QR member, dan fixture member. Checkout utama tidak memiliki berkas layanan tersebut. Minimum saat ini 1 poin. Maksimum = `min(saldo, floor(sisaTagihan / nilaiPoin))`; gunakan sisa sesudah DP/pembayaran lain, bukan total kotor. Program berlaku per PT. Batas/kelayakan harus dihitung kembali server.

Offline/edge tidak mengizinkan pembayaran poin. Expiry lokal tidak membuktikan QR belum dikonsumsi sebelum kedaluwarsa; status harus diperiksa sebelum membuat otorisasi baru. Mint QR belum mendebit poin. Status berhasil hanya konfirmasi penukaran poin; Rp135.000 masih dibayar di kasir. QR contoh adalah SVG ilustratif, tanpa token transaksi.

## Kebutuhan API — usulan untuk implementasi

Yang ada pada kontrak m1: `POST /api/member/qr-token`, body `{orderId, points}` bersama-sama untuk penukaran atau body kosong untuk identitas; respons `{data: {token, expiresAt}}`. Saat ini mint belum memvalidasi order, sedangkan POS memeriksa ketika menukar. Jangan menganggap mint berhasil sebagai bukti kelayakan atau pembayaran.

Belum ditemukan pada pemeriksaan tersebut:

- Endpoint member untuk tagihan terbuka atas namanya. Contoh nama usulan: `GET /api/member/active-orders`; belum kontrak final. Respons minimum: order ID, outlet, nomor/meja, total, sudah dibayar, sisa bayar, versi status dan kelayakan. Server membatasi ke session member serta PT program. Bila beberapa tagihan cocok, minta pilih dengan outlet/nomor yang jelas; jangan memilih otomatis tanpa konfirmasi.
- Quote terverifikasi: saldo terkini, nilai per poin, minimum, maksimum, sisa tagihan, batas program, alasan penolakan, dan versi/kedaluwarsa quote. Validasi kepemilikan dan status order pada mint serta konsumsi; jumlah tidak boleh melebihi saldo/sisa yang masih sah.
- Status konsumsi QR/penukaran dan sisa order setelahnya. Bedakan menunggu, terpakai, kedaluwarsa, tidak berlaku, dan tidak diketahui. Keberhasilan memerlukan bukti server. Poll/subscription merupakan pilihan implementasi, belum ditentukan mockup.
- Aturan token lama saat jumlah/tagihan berubah, status tidak pasti, atau permintaan QR diulang. Konsumsi harus atomik, sekali pakai, dan idempoten. Jangan membuka dua otorisasi paralel yang dapat mendebit berlebih; periksa/revoke sesuai kontrak yang akan ditetapkan.
- Untuk B: kode scoped outlet/tenant dan member, TTL, batas percobaan, serta konfirmasi outlet/total tanpa membocorkan tagihan milik orang lain. Bentuk kode dan endpoint belum disetujui.

## Render dan verifikasi

Jalankan dari root repo melalui browser lane:

```sh
heavy --browser node design/mockups/member-tukar-poin/render.mjs
```

Renderer menyimpan `render-report.json` serta PNG seluruh keadaan. `capture=1` membekukan waktu pada 02:00; saat membuka QR tanpa parameter tersebut, waktu berjalan dan berpindah ke keadaan kedaluwarsa. Interaksi pilihan poin adalah simulasi lokal; tidak ada server/order hidup.

Hasil akhir: **30 PNG, 7 pemeriksaan layout, dan 6 interaksi lulus**, tanpa error browser/aset atau overflow. Render penuh lebar 390/1280 pada 19 Nov 2026 09:29 WIB; verifikasi interaksi terakhir 09:31 WIB. Pemeriksaan 320 px mencakup tagihan aktif, pilih poin, QR aktif dan perbandingan; simulasi zoom CSS 200% mencakup tiga keadaan terakhir. Ini pemeriksaan layout terarah, bukan uji seluruh aplikasi atau zoom browser/assistive technology lengkap.

Interaksi yang dibuktikan: QR identitas → pilih poin → QR penukaran; perubahan 600/500 serta penolakan 1.500 poin; alternatif kode → konfirmasi; pilihan 740 menyisakan 500 poin pada QR/hasil/navigasi; expiry hanya ke pemeriksaan status; timer 02:00 → 01:59 → kedaluwarsa dengan QR hilang. Regresi klik rincian tidak menavigasi ulang dan header hanya menavigasi sekali juga lulus.

Perintah terakhir: `heavy --browser node design/mockups/member-tukar-poin/render.mjs --interactions-only`. Mode ini mempertahankan 30 hasil PNG dan 7 layout dari render penuh, mengulang enam interaksi setelah perbaikan handler klik, serta menyimpan waktu dan cakupan pada `render-report.json`. Perubahan terakhir hanya membatasi handler ke tombol; tidak mengubah tampilan. Sintaks semua JS/MJS dan format seluruh sumber diperiksa. Perintah `pnpm exec prettier` pada checkout ini tidak menemukan entrypoint modul; pemeriksaan berhasil lewat runtime lokal terpasang `node node_modules/.pnpm/prettier@3.9.6/node_modules/prettier/bin/prettier.cjs --check 'design/mockups/member-tukar-poin/*.{html,css,js,mjs,md}'`, tanpa pemasangan dependensi.

| Gate mockup   | Hasil dan batas bukti                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product       | PASS untuk isi brief; belum validasi dengan pengguna                                                                                                                |
| UX            | PASS untuk alur simulasi, pemeriksaan tagihan dan pemulihan keadaan                                                                                                 |
| UI            | PASS untuk hierarki task UI dan pemeriksaan gambar mobile/desktop                                                                                                   |
| Design system | PASS untuk kesinambungan mockup member; satu accent rust, satu keluarga netral hangat, kaca satu area navigasi, tanpa gradien/emoji dekoratif                       |
| Accessibility | NOT VERIFIED sepenuhnya; kontras teks solid terukur minimal 5,68:1, label/fokus native tersedia; axe, screen reader dan keyboard manual menyeluruh belum dijalankan |
| Responsive    | PASS dalam 390/1280 seluruh keadaan, 320 dan simulasi 200% terarah                                                                                                  |
| Edge cases    | PASS untuk keadaan yang ada di tabel layar dan simulasi enam interaksi                                                                                              |
| Code quality  | PASS terbatas mockup: sintaks, format, browser dan regresi interaksi                                                                                                |
| Visual QA     | PASS: Playwright Chromium 1.63 melalui heavy; seluruh 15 keadaan pada 390/1280 dirender dan keadaan utama diperiksa visual                                          |
| Anti-slop     | PASS terbatas mockup; identitas visual mengikuti referensi member yang diminta                                                                                      |
| Final         | NOT VERIFIED sebagai UI produksi; deliverable mockup siap review                                                                                                    |

Belum diuji dengan pengguna, API hidup, atau transaksi nyata. Build/test aplikasi, Lighthouse, axe, serta gerbang produksi tidak dijalankan karena perubahan hanya artefak desain. Tidak ada klaim integrasi API, pembayaran, atau kesiapan produksi. Dikerjakan dengan empat subagent berbeda, puncak tiga berjalan paralel.

## Sumber

- Brief: `docs/briefs/1152-mockup-member-tukar-poin.md`.
- Referensi visual: `design/mockups/qr-vnvg-member.html`, `qr-vnvg-poin-mobile.png`, `final-a-mobile.css`, `design/REFERENCES.md` dan `~/.agents/team/ui-standard.md`.
- Font/foto berasal dari aset lokal yang sudah ada di `design/mockups/assets/`; tidak ada pengunduhan media atau layanan berbayar.

## Keputusan yang dibawa CTO

Setujui alur A sebagai arah utama atau pilih alternatif B pada [perbandingan](index.html?state=perbandingan-alur). Endpoint yang diusulkan memerlukan kontrak dan pengujian server sebelum UI ini dapat dipakai untuk transaksi.
