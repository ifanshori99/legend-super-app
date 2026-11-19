# Second opinion refund ronde 16 — 1153

Tanggal: 19 November 2026. Hasil pemeriksaan statis: **1 temuan P2**; tidak ditemukan P0/P1 baru pada delta yang diperiksa. Dua temuan P2 ronde 15 tertutup pada pembacaan kode dan test, dengan batas verifikasi di bawah.

## Ruang pemeriksaan

- Sesudah `git fetch origin` berhasil, delta: `origin/ws/1139-refund-ronde14-fix..origin/ws/1144-refund-hold-echo`, mengecualikan `':!**/meta/*snapshot.json'`.
- Base: `2c6dc862e01d498b60af573337b473918442e4bd`; head: `41b89605d058001dcc5e40c513b39c563c0fc4d7`. Seluruh nomor baris sumber mengacu pada head ini, bukan checkout utama.
- Sembilan berkas, 1.212 penambahan dan 13 penghapusan; tidak ada migrasi baru. Konteks di luar delta dibaca hanya untuk membuktikan alur yang berubah.
- Tiga subagent read-only dimulai paralel: penutupan hold/identitas pembayaran, ruang refund/uang keluar, serta isolasi/retry/gerbang. Parent memeriksa silang temuan di bawah.
- Sesuai brief, tidak dilaporkan ulang: penutupan echo kecil ketika R masih `approved` yang sedang diperbaiki, payload tersimpan sebelum 1144 tanpa marker, dan penanda `auto_closed` yang bergantung pada teks catatan.

## Temuan

### P2-1 — Retry saat saklar mati mengirim dua alert untuk satu laporan refund

`apps/api/src/services/payment-webhook.service.ts:2946` — Pengumuman hold menit 0 ditambahkan setelah jalur saklar mati sudah mengirim alert sendiri; kedua jalur memakai identitas dedup berbeda, sehingga finance menerima dua notifikasi untuk laporan refund yang sama. Gabungkan pengumuman hold menit 0 dan jalur saklar mati menjadi satu alert dengan identitas stabil, sambil mempertahankan hold dan pembatasan uang.

**Skenario:** T dibayar Rp100.000 dan refund Legend R Rp60.000 sudah dikirim dengan id penyedia X. Webhook sukses X Rp50.000 tiba sebelum X tersimpan pada R: menit 0 membuat hold H1 bernama X tanpa alert. Sesudah X tersimpan dan saklar DOIT mati, worker memproses ulang event yang sama setelah jendela retry. Ini skenario yang sudah dibentuk oleh `refund-1144-a-echo-smaller-hold.test.ts:119` dan kasus `:212`; echo Rp70.000 pada `:217` mengikuti jalur yang sama.

1. `payment-webhook.service.ts:2934` memanggil `holdSwitchedOffRefundSuccess` dengan varian bawaan `switched_off`, tanpa `providerRefundId`. Hold H1 bernama X memakai kunci turunan refund, sehingga insert hold berbasis `row.id` pada `:1353` membuat hold H2 yang berbeda. Jalur `:1382` mengirim `alertProviderRefundSwitchedOff` melalui `:1367`.
2. Tambahan baru pada `:2946` memanggil `announceFirstPassHoldOfIntent` dengan X. Helper menemukan H1 yang masih terbuka dan memanggil `alertProviderRefundUnmatched` pada `:1752`.
3. `payment-provider-refunded-alert.ts:348` memasukkan `eventName` ke hash identitas alert. Dua event adalah `payment.provider_refund_switched_off` (`:501`) dan `payment.provider_refund_unmatched` (`:528`), dengan dedup key yang juga berbeda. Keduanya memakai penerima outlet/owner yang sama melalui `:362`. Dedup tidak menyatukan keduanya: penerima mendapat judul “Refund penyedia ditahan, refund otomatis belum aktif” dan “Refund penyedia tidak cocok dengan refund Legend”. Retry berikutnya mempertahankan dua identitas itu, bukan satu.

**Dampak:** Melanggar aturan brief satu alert beridentitas stabil untuk hold yang tetap terbuka saat saklar mati. Finance melihat satu laporan sebagai dua peringatan, termasuk pesan unmatched ketika event sudah cocok R. Ini bukan temuan uang keluar berlebih: hold penuh jalur saklar mati tetap membatasi pembayaran. Pembuatan H2 sudah ada di base; delta yang dilaporkan adalah pengiriman alert unmatched tambahan setelah alert saklar mati.

**Usul test:** Perluas `1144-a-04/05`: ambil delta seluruh alert refund terkait intent/penerima, mencakup `switched_off` dan `unmatched`, lalu pastikan totalnya satu dan source event/id-nya tetap sama setelah worker retry serta replay. Helper `unmatchedAlerts` pada `refund-1144-a-echo-smaller-hold.test.ts:66` hanya memfilter judul unmatched; assertion `:164` tidak melihat alert saklar mati sehingga dapat lulus meskipun ada dua notifikasi. Pertahankan assertion hold terbuka dan penolakan refund manual; tidak boleh menghilangkan hold penuh untuk mengurangi jumlah alert.

## Status temuan ronde 15 dan invariant uang

- P2-1 ronde 15 tertutup secara statis: `payment-doit-refund-webhook.ts:191` menandai id yang invalid/bertentangan atau payment object tak terbaca; `:266` menyimpan `payment_id_unusable`, pembacaan ulang `:196` memulihkannya, dan `payment-webhook.service.ts:1510` menolak fallback reference. Test `refund-1144-c-payment-id-conflict.test.ts` mencakup konflik, payment id tak terbaca, serta retry payload tersimpan.
- P2-2 ronde 15 tertutup secara statis: `rilis1-legend-26ro5.sql:98` membedakan hold CONFLICT yang otomatis ditutup dari hold legacy saat fact kemudian diikat hold lain. Test `preflight-rilis1-26ro5.test.ts:390` memuat H1 otomatis dan H2 anonim yang sah terikat fact yang sama; kontrol berikutnya tetap memeriksa cakupan nominal dan hold legacy yang berbagi fact.
- Pada delta ini tidak ditemukan jalur baru yang membayar melebihi pembayaran dari gabungan dashboard, manual, dan echo. Penolakan update selain echo kecil tetap mempertahankan hold; perbedaan payment ref dan saklar mati tidak menutupnya. Kesimpulan ini adalah pembacaan alur, bukan pembuktian uang lewat eksekusi test.
- Pencocokan tenant dan integrasi serta guard payment/refund id tidak ditemukan membuka jalur pembayaran lintas tenant pada delta. Mismatch provider refund id ditolak updater sebelum pemeriksaan nominal (`payment-refund.service.ts:4131`), sehingga cabang echo kecil tidak memakai penolakan nominal untuk refund id lain.
- Kasus penutupan sebelum status final sukses yang sedang diperbaiki tidak dinilai selesai oleh laporan ini. Verifikasi perbaikannya tetap perlu dilakukan terpisah.

## Verifikasi dan batas

- Dijalankan: fetch origin, pencocokan kedua SHA, pembacaan diff/sumber/test pada head yang dipatok, dan pemeriksaan silang tiga subagent. Tidak checkout, membuat worktree, atau menjalankan layanan.
- Pemeriksaan format memakai binary Prettier 3.9.6 yang terpasang: `node node_modules/.pnpm/prettier@3.9.6/node_modules/prettier/bin/prettier.cjs --check docs/qa/second-opinion-refund-ronde16-1153.md`. Wrapper `pnpm exec prettier` gagal menemukan `node_modules/prettier/bin/prettier.cjs`; dependensi dan symlink tidak diubah.
- Tidak dijalankan: test database, reproduksi API notifikasi ganda, reproduksi konkurensi, suite regresi, typecheck, atau build. Tidak menyatakan test lulus maupun invariant uang terbukti ulang secara runtime.
- Hanya laporan ini ditulis; tidak mengubah kode, dokumen lain, status Beads, commit, push, atau merge.
- Tidak ada subagent atau job latar milik pemeriksaan ini yang masih berjalan.
