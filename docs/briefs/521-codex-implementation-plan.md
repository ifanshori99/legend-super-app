# Rencana perbaikan katalog edge 521 / 526

Tujuan: menutup enam temuan Codex 520 dan menjalankan keputusan founder Q62 tanpa memberikan diskon berlebih atau menghilangkan alarm saat offline.

Arsitektur: satu clock tepercaya dipakai untuk umur katalog, autentikasi override, waktu sukses sinkron, dan checkpoint. Ketidakpastian elapsed time setelah boot dipisahkan dari regresi jam: kasir boleh menjual dengan peringatan, promo/voucher tetap mati, dan alarm owner diantrikan secara lokal. Provider override menggunakan generasi agar pembacaan lama tidak menimpa perubahan baru.

Urutan pembuktian dan pemilik file:

1. Subagent clock: `trusted-clock.ts` dan test; reproduksi +48 jam, override 4 jam, rollback, lalu 4 jam monotonic; buktikan sinyal waktu boot tak terbukti, termasuk state terlambat.
2. Subagent gate: `catalog-gate.ts`, runtime/boot/POS test; reproduksi reload menimpa grant/close baru dan penutupan override saat jam masih mundur; uji boot Q62 dan nilai pesanan harga normal tanpa diskon berlebih.
3. Subagent route: `edge.routes.ts` dan test override route; reproduksi MFA yang terlihat baru di wall time tetapi kedaluwarsa di trusted time, kebalikannya, serta sesi kedaluwarsa.
4. Subagent freshness: `catalog-freshness.ts`, `master-sync.ts` dan test; reproduksi timestamp sukses/checkpoint mundur; ketidakpastian boot harus memberi warning/alarm, tidak memakai blokir 24 jam, sampai masing-masing stream sinkron kembali.
5. Subagent promo: `promo-gate-runtime.ts` dan test terpisah; checkpoint yang tampak baru tidak membuka promo/voucher bila elapsed time tak terbukti.
6. Subagent alarm: helper antre lokal dan wiring `runtime.ts`; alarm tetap ada melintasi restart dan katalog pulih sebelum reconnect, tanpa perubahan schema.

Semua subagent menulis test dahulu dan menunggu hasil merah yang dijalankan induk sebelum memperbaiki production. Hanya induk memegang token heavy. Test terarah dari root: `LEGEND_TEST_FILES="..." heavy pnpm test`. Tidak menjalankan suite penuh. Setelah integrasi, jalankan seluruh test relevan, `heavy pnpm --filter @starter/api typecheck`, eslint/prettier file berubah, dan `heavy pnpm db:generate` yang harus kosong. Commit hasil beserta PROGRESS lalu push biasa ke `ws/edge-catalog-fresh`.

Fokus integrasi: late load DB tidak boleh menghapus ketidakpastian; live sync membersihkan per-stream tanpa membuat alarm hilang sebelum terkirim; sale yang usianya terbukti >24 jam tetap diblokir Q57; clock regressed tetap membutuhkan override; grant baru tak boleh ditimpa async read lama. Review architect Claude dikelola CTO sesudah 00:45 sesuai brief 526; batas kerja ini 00:40 WIB 12 November.
