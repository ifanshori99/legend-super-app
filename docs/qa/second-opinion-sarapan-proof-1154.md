# Second opinion sarapan: bukti penyedia — brief 1154

Tanggal: 19 November 2026. Rentang setelah `git fetch origin`: `013a207099335f2393354d3a3dde29c4def9fb80..86ed0ec32d4677c455e6a0fd93e8c411b1b8a008` (`origin/ws/1130-p2-pajak-sarapan-rekap`). Semua nomor baris mengacu ke head tersebut, bukan checkout aktif.

Hasil: **Tidak ditemukan temuan konkret P0–P3 dalam lingkup brief.**

## Dasar penilaian

- **Pembayaran valid:** `facility-breakfast-consumers.ts:349,386,422` menghitung alasan penolakan terlebih dahulu. Pembayaran yang dapat diterima langsung ditandai `paid`; permintaan bukti penyedia hanya muncul ketika `refuse !== null`. Secara statis ini menangani masalah pembayaran valid yang menunggu penyedia pada SO 1146.
- **Rollback sebelum meminta bukti:** `facility-breakfast-consumers.ts:187–200,390` melempar sebelum pembatalan dan refund pada jalur penolakan. `worker-main.ts:300` membungkus seluruh `consumeOutbox`, sedangkan `order-payment-consumers.ts:215–226` membungkus transaksi sendiri untuk pemanggilan tanpa `tx`. Dengan demikian, helper menunggu transaksi pertama gagal sebelum bertanya kepada penyedia dan mengulang satu kali.
- **Lock outbox dan offset:** `core-outbox.ts:371–421` mengambil kedua lock dalam `withTenant`; konsumsi dan offset baru dicatat sesudah `input.deliver` berhasil. `db/tenant.ts:24–50` menggunakan transaksi database. Exception bukti keluar dari transaksi ini, sehingga tidak ada transaksi konsumsi yang menunggu jawaban penyedia sambil memegang kedua lock. Percobaan ulang memeriksa ulang generation, status dead letter, otorisasi, konsumsi sebelumnya, dan sequence.
- **Consumer lain tidak mendapat efek ganda dari retry ini:** `worker-main.ts:351,361,384,389,417,447` menempatkan consumer sarapan sebelum jurnal, poin, pengurangan resep, dan pengiriman deployment. Exception bukti menghentikan percobaan pertama sebelum consumer sesudahnya dijalankan. Consumer pembayaran reservasi yang mendahului memakai transaksi sendiri, tetapi mencari khusus link atau intent DP reservasi (`reservation-consumers.ts:55–75,182–183`); pembayaran sarapan yang ditinjau tidak cocok dan diabaikan. Cabang notifikasi tidak menjalankan consumer sarapan.
- **Keputusan dihitung ulang:** percobaan kedua masuk lagi ke `lockBreakfastOrder` (`facility-breakfast-consumers.ts:219`), membaca link dan intent, lalu menghitung payer, kondisi tiket, dan refund yang sudah dicadangkan sebelum menolak (`:342–390`). Bukti penyedia tidak langsung memaksa pembatalan menggunakan hasil keputusan lama. Penerbitan intent juga memeriksa ulang sisa tagihan di bawah lock (`payment.service.ts:1319–1327`), sehingga tagihan yang sudah penuh menolak kode baru pada jalur yang ditinjau.
- **Tenant dan outlet:** `order-payment-consumers.ts:210` dan `facility-breakfast-consumers.ts:212` menolak event tenant lain. `core-outbox.ts:383–390` memeriksa tenant, scope outlet, serta otorisasi lagi di setiap percobaan; `withTenant` memasang konteks RLS transaksi (`db/tenant.ts:41–48`). Tidak ditemukan jalur lintas tenant atau pelebaran scope dalam perubahan ini.

## Test yang dibaca

`apps/api/src/test/facility-breakfast-consumer-proof-lock-1146.test.ts` memuat lima skenario `BRK-PROOFLOCK-01` sampai `05`: pembayaran valid tanpa panggilan penyedia; probe lock dari koneksi lain selama jawaban ditahan; kode lain belum dibayar; kode lain sudah dibayar dan replay tidak meminta refund berlebih; serta jawaban tidak jelas yang tidak membatalkan, tidak merefund, dan tidak menandai event consumed sebelum dicoba lagi dengan jawaban jelas. Ini penilaian atas isi test, bukan klaim test lulus.

Tidak ada usul test untuk temuan baru karena tidak ditemukan skenario gagal konkret. Perilaku dead letter sekitar 155 detik dan pemulihan replay manual pada jalur penolakan dikecualikan sesuai penerimaan CTO dalam brief.

## Verifikasi dan batas

- `git fetch origin` berhasil; head remote cocok dengan `86ed0ec32` yang ditunjuk brief.
- `git diff --check 013a20709..86ed0ec32` lulus.
- `pnpm exec prettier --check docs/qa/second-opinion-sarapan-proof-1154.md` tidak dapat berjalan: modul lokal `node_modules/prettier/bin/prettier.cjs` tidak ditemukan. Dependensi tidak diubah dalam review ini.
- Pemeriksaan statis mencakup diff produksi, test regresi baru, dan jalur pemanggil yang diperlukan untuk memeriksa transaksi, urutan consumer, serta scope.
- Test runtime, build, dan koneksi penyedia tidak dijalankan. Checkout aktif tetap `ux/customer-order-benchmark`; tidak dibuat worktree dan tidak dilakukan checkout untuk menjalankan kode head review.
- Tiga subagent baca-saja berjalan paralel; agent induk memeriksa ulang rujukan dan kesimpulan terhadap source pada head review.
- Hanya laporan ini ditulis. Tidak ada perubahan kode, commit, push, atau merge.
