# SO 913 — interaksi QRIS hold, refund ulang sisa, dan ganti bank

Tanggal: 16 November 2026. Basis tetap: `40f6f3c95af4a10e40ab629f8113be6acd5045e9` (`origin/milestone/m1`, batch74). Pemeriksaan read-only terhadap kode aplikasi dan test; hanya laporan/progress yang diubah.

Kesimpulan: **1 P1 (`legend-ek1wt`); tidak ada temuan P0/P2/P3 baru yang terbukti. Gerbang rilis uang perlu menunggu perbaikan P1 ini.** Tidak ditemukan refund ganda/kurang atau deadlock baru pada interaksi refund ulang sisa yang diperiksa. Test yang ada lulus, tetapi belum mereproduksi P1.

## Temuan

- **P1 — `apps/api/src/services/payment.service.ts:833` — API token pembayaran umum masih menerbitkan kode kedua saat QRIS lama ditahan.** Skenario: order sarapan lama masih `awaiting_payment`, token pembayaran sudah dimiliki member, QRIS A masih dapat dibayar, lalu migrasi 0401 memasang hold `open`. Member memakai token yang sama pada `POST /api/payments/links/:token/intents` dengan kunci baru; kode B diterbitkan tanpa pemeriksaan hold atau finalitas A. A hanya kedaluwarsa lokal dan pembatalan penyedia bersifat best effort, sehingga A dan B dapat dibayar. Saran: terapkan aturan hold/kode aktif pada penerbitan umum sebelum memanggil penyedia, dengan serialisasi dan pemeriksaan ulang yang mencakup pemanggil token serta refresh. Usul test: token sarapan sah + hold hasil backfill + penyedia A tetap pending/tidak mendukung cancel; create dan refresh harus 409, panggilan create penyedia tetap satu, tanpa intent baru; pembayaran A setelah penolakan harus tercatat dan dialokasikan/refund tepat sekali, tanpa pembayaran berlebih.

Rantai bukti P1 pada basis tersebut:

1. `apps/api/src/routes/facility-breakfast.routes.ts:89` menyediakan jalur member `/tickets/:ticketId/breakfast-orders/:orderId/pay`. `facility-breakfast.service.ts:667` mengembalikan token link order yang sudah ada melalui `paymentToken` (`:672`); token baru juga dikembalikan (`:705`). Ini kredensial sah yang tersedia ke member, bukan asumsi token QR tamu bocor.
2. `apps/api/drizzle/0401_pos_qris_holds.sql:201` memasang hold QRIS whole-order melalui `orders.payment_link_id`, termasuk intent pending/expired yang mencapai penyedia. Tidak ada filter channel yang mengecualikan order sarapan (`:207–216`). Order sarapan tersebut memenuhi keadaan backfill ini.
3. `apps/api/src/routes/payment.routes.ts:69` langsung memanggil `createIntent` (`:73`), yang meneruskan ke `createIntentCore` (`payment.service.ts:758`). `readIntentPlan` (`:550–598`) memeriksa token, sisa tagihan, idempotensi, dan routing, tetapi tidak memeriksa hold/kode aktif.
4. `payment.service.ts:833` memanggil penyedia sebelum transaksi penyimpanan. Pemeriksaan setelah kunci link (`:876–911`) hanya memvalidasi ketersediaan link dan jumlah. `:912` melakukan supersede lokal, sedangkan cancel baru dijalankan setelah commit (`:958`); gateway tanpa `cancel` langsung dilewati (`:686`). Trigger freeze 0402 melindungi order/tender/hold, bukan penerbitan intent ini.
5. `payment.service.ts:1853` juga mengizinkan refresh setelah expiry lokal walaupun hasil sinkronisasi masih pending; `:1883` meneruskan ke penerbitan umum yang sama. Untuk kasus ini tidak diperlukan kegagalan cancel: `supersedePending` melewatkan intent ber-ref yang sudah melewati expiry (`:632–635`).

P1 ini adalah interaksi hold hasil migrasi dengan jalur token umum. Tidak diklaim bahwa token order QR tamu biasa diekspos, atau bahwa semua jalur VA gagal. Pencatatan uang terlambat dapat memulihkan pembayaran ganda, tetapi tidak memenuhi aturan mencegah kode kedua saat kode pertama masih dapat dibayar.

## Refund ulang sisa dan pembatalan order

- Pada kasus SO-885 E, uang masuk Rp33.000; R1 Rp10.000 approved lalu gagal; R2 Rp23.000 masih pending. Refile R3 menjadi **Rp10.000**, karena `qr-order-late-payment.ts:107–117` mengurangi seluruh reservasi aktif untuk refile. Approval tetap memakai cap di `payment-refund.service.ts:514–525`.
- R2 completed Rp23.000 + R3 pending/approved Rp10.000 tetap menahan order. `qr-order-consumers.ts:180–194,308–335` membutuhkan refund completed yang menutup uang masuk dan tidak ada refund terbuka sebelum pembatalan karena uang sudah dikembalikan.
- Sesudah R2 dan R3 completed dengan total Rp33.000, R1 failed menjadi riwayat tertutup: `payment-refund-failed-open.ts:40–49` menjumlahkan **semua** refund completed, bukan mensyaratkan satu refund sebesar tagihan. Tidak ditemukan kekurangan refund akibat pemecahan nominal ini.
- Tidak ditemukan siklus kunci baru yang konkret: `lockRefundGraph` mengambil scope persetujuan/POS order lalu intent/fund/refund (`payment-refund.service.ts:216–252`); refile hanya membaca `orders` tanpa `FOR UPDATE` (`:753–771`). Jalur consumer menahan order sebelum intents terurut (`qr-order-consumers.ts:272–297`). Penelusuran ini tidak menggantikan uji konkurensi baru.

## Dua penyesuaian test merge train

- **`e2b85ef5d`, `qris-hold-so885-e-failed-refund.test.ts:248–264`:** kasus (c) menaikkan R3 langsung menjadi seluruh uang masuk, menggagalkan R2, dan menandai intent refunded. Ini membentuk keadaan akhir sintetis, sehingga tidak membuktikan penyelesaian R2 Rp23.000 + R3 Rp10.000 melalui layanan sebenarnya. Agregasi produksi mendukung keduanya; perubahan fixture saja bukan bukti bug yang disembunyikan. Usul test tambahan: pertahankan nominal asli, approve/complete kedua refund melalui layanan dalam kedua urutan; sweep sebelum refund kedua selesai tetap `awaiting_payment`, sesudahnya `voided`, total payout Rp33.000, replay tidak menambah payout/refund.
- **`1f2956980`, `payment-gateway-poll-window.test.ts:394–398`:** test langsung menandai A expired dan `provider_final_at`, sehingga penggantian bank melalui guard baru sah. Test kemudian membuktikan pertahanan pembayaran lama/replay (`:408–451`), bukan perolehan bukti final lewat penyedia. Tidak ditemukan bug produksi baru yang terbukti dari penyesuaian ini. Test tersebut juga tidak melindungi API token umum pada P1.
- Pada jalur QR tamu yang dijaga, `qr-order-payment.ts:766–782` menolak hold/kode lama aktif. Intent expired/failed tanpa final tetap masuk poll tanpa batas umur (`payment.service.ts:2975–2979`); jawaban paid diproses melalui `syncExpiredIntentPayment` (`:2758–2807`). Pembayaran kode kedua setelah tagihan lunas meminta refund dana ganda (`qr-order-consumers.ts:687–702`).
- Usul regresi bank/poll: dapatkan final A melalui gateway palsu dan layanan sebenarnya; sebelum final, pergantian bank wajib 409 tanpa create baru. Uji pula A kedaluwarsa lokal tetapi penyedia masih pending, lalu paid tanpa webhook; poll dan consumer harus mencatat uang serta refund yang diperlukan tepat sekali.

## Verifikasi dan batas

Worktree dipersiapkan dengan `node scripts/worktree-setup.mjs`; link paket lokal tervalidasi. Satu subagent test-runner menjalankan:

```sh
LEGEND_TEST_FILES="src/test/qris-hold-so885-e-failed-refund.test.ts src/test/payment-gateway-poll-window.test.ts src/test/late-payment-refund-refile.test.ts src/test/system-refund-followup.test.ts" heavy pnpm test
```

Hasil: **exit 0; 4 berkas, 20 test lulus; 22,43 detik**. Log lokal: `/tmp/so913-focused-tests.log`. Ada peringatan deprecation `pg client.query()` tanpa kegagalan test. Database test sekali pakai dihentikan dan dihapus oleh runner.

P1 dibuktikan melalui rantai kode dan migrasi; **test reproduksi baru untuk P1 serta uji konkurensi baru belum dijalankan**. Tidak mengubah kode aplikasi/test, tidak menjalankan gate penuh/build/e2e, dan tidak mengulang review isi QRIS hold SO902/903 atau VA SO910/912. Tiga subagent bawaan Codex dipakai, puncak tiga bersamaan: refund, poll/bank, dan lock/bypass; satu di antaranya menjalankan seluruh test secara serial.
