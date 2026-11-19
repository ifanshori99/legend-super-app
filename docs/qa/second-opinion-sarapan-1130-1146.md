# Second opinion sarapan 1130 — brief 1146

Tanggal: 19 November 2026. Rentang setelah `git fetch origin`: `e2a63062e0630f8078291038198e49fe79e1aacc..013a207099335f2393354d3a3dde29c4def9fb80` (`origin/ws/1130-p2-pajak-sarapan-rekap`). Snapshot migrasi dikecualikan. Semua nomor baris mengacu ke head tersebut.

Hasil: **1 temuan P2**; tidak ditemukan skenario konkret P0, P1, atau P3 dalam lingkup brief.

## Temuan

- **P2 — `apps/api/src/services/facility-breakfast-consumers.ts:239`: Pembayaran valid masih menunggu penyedia di dalam transaksi konsumsi.** Skenario: kode A sudah melunasi seluruh tagihan, tiket masih berlaku, order masih `awaiting_payment`, dan kode B lama belum terkonfirmasi. Consumer selalu menunggu `confirmOtherCodesBeforeRefuse` sebelum menentukan apakah pembayaran perlu ditolak. Jika `getStatus(B)` lambat atau timeout, status A belum menjadi `paid` selama penantian, meskipun A seharusnya langsung diterima. Transaksi juga tetap memegang lock outbox dan offset. Saran: tentukan kebutuhan pembatalan terlebih dahulu; pembayaran valid langsung diterima, sedangkan jalur penolakan meminta bukti di luar transaksi konsumsi, kemudian mengunci dan memvalidasi ulang sebelum membatalkan. Usul test: gunakan deferred promise pada `getStatus(B)`; pembayaran A harus selesai menjadi `paid` dan consumed tanpa menunggu promise B. Untuk jalur penolakan, periksa dari koneksi lain bahwa lock outbox/offset tidak ditahan sepanjang penantian penyedia.

### Bukti dan celah test

- `worker-main.ts:297,354` memanggil consumer melalui transaksi `consumeOutbox`; `order-payment-consumers.ts:163` meneruskan `tx` yang sama.
- `core-outbox.ts:373,397` mengunci baris outbox dan offset sebelum `await input.deliver(...)` pada baris 407. Keduanya baru dilepas setelah callback transaksi selesai.
- `facility-breakfast-consumers.ts:239–244` selalu menunggu proof untuk order yang masih `awaiting_payment`. Helper pada baris 206 memanggil `confirmLinkUnpaidAtProvider` melalui koneksi terpisah; transaksi konsumsi yang memanggilnya tetap terbuka.
- `payment-provider-proof.ts:192` menunggu `gateway.getStatus`; baris 212 dapat melanjutkan ke `settleGatewayIntentNow`. Duitku menetapkan timeout permintaan 15 detik di `payment-duitku-wire.ts:34`.
- `facility-breakfast-fire-provider-1130.test.ts:389` (`BRK-FIREPROV-09`) hanya memeriksa keadaan setelah `await deliver(...)` selesai. Jawaban tidak jelas yang segera selesai tidak membuktikan bahwa pembayaran valid bebas dari penantian penyedia.

Temuan ini mengenai penantian pembayaran valid dan lock selama I/O, berbeda dari dead letter sekitar 155 detik pada jalur penolakan yang sudah diterima CTO. Tidak ditemukan bukti konkret refund ganda atau deadlock settlement dari skenario ini.

## Lingkup lain yang diperiksa

- Fire oleh staf dan sweep: exception membatalkan transaksi sebelum proof; percobaan berikutnya mengunci ulang data. Izin outlet pada jalur staf diperiksa kembali. Tidak ditemukan skenario konkret kode baru setelah proof pada jalur fire: penerbitan intent memeriksa ulang sisa tagihan di dalam lock (`payment.service.ts:1319`).
- Rekap: pemeriksaan scope/RBAC mendahului perhitungan; helper receipt gap membatasi tenant dan outlet. Batas hitungan hanya dari cloud diterima sesuai brief.
- Config codec: perubahan hanya menjelaskan batas validator template; belum ada pemanggil import codec di API pada head yang diperiksa. Tidak ditemukan kebocoran lintas tenant/outlet dalam perubahan yang ditunjuk.

## Verifikasi dan batas

- Pemeriksaan statis terhadap diff, jalur pemanggil, lock, dan test pada commit yang ditunjuk. Checkout aktif tetap `ux/customer-order-benchmark`; tidak digunakan sebagai head review.
- `git diff --check e2a63062e..013a20709 -- ':!**/meta/*snapshot.json'` lulus.
- `pnpm exec prettier --check docs/qa/second-opinion-sarapan-1130-1146.md` tidak dapat berjalan: modul lokal `node_modules/prettier/bin/prettier.cjs` tidak ditemukan. Dependensi tidak diubah dalam review ini.
- Test, build, dan koneksi penyedia tidak dijalankan. Skenario deferred promise di atas adalah usul test regresi, belum bukti runtime.
- Tiga subagent baca-saja, puncak tiga bersamaan; hasil dan rujukan temuan diperiksa ulang oleh agent induk.
- Hanya laporan ini ditulis. Tidak ada checkout, perubahan kode, commit, push, atau merge.
